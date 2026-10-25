import {
  createGoalEnvelope,
  createTaskPlan,
} from "../agents/agent-contracts.js";
import { getCapability } from "../agents/capability-catalog.js";
import { createAbortError, isCancellationError } from "../runtime/abort-utils.js";
import { createVehicleSluGoalEnvelope } from "../semantic/vehicle-slu-orchestration.js";

const TASK_STATUSES = new Set([
  "queued", "running", "waiting", "completed", "failed", "cancelled",
]);
const TASK_STAGES = new Set([
  "accepted", "planning", "executing", "waiting", "finalizing",
]);
const CANCELLATION_STATES = new Set(["none", "requested", "cancelled"]);

export function createTaskSnapshot(input = {}) {
  const status = requireEnum(input.status, TASK_STATUSES, "status");
  const currentStage = requireEnum(input.currentStage, TASK_STAGES, "currentStage");
  const cancellationState = requireEnum(
    input.cancellationState ?? "none",
    CANCELLATION_STATES,
    "cancellationState",
  );
  const updatedAt = toIsoTimestamp(input.updatedAt);
  return deepFreeze({
    taskId: requireText(input.taskId, "taskId"),
    runId: requireText(input.runId, "runId"),
    status,
    currentStage,
    completedStepIds: uniqueStrings(input.completedStepIds, "completedStepIds"),
    activeStepIds: uniqueStrings(input.activeStepIds, "activeStepIds"),
    pendingStepIds: uniqueStrings(input.pendingStepIds, "pendingStepIds"),
    committedEffects: clonePlainArray(input.committedEffects, "committedEffects"),
    latestFactsRef: input.latestFactsRef == null
      ? null
      : requireText(input.latestFactsRef, "latestFactsRef"),
    cancellationState,
    updatedAt,
  });
}

export class BackgroundTaskCoordinator {
  constructor({ cabin, orchestrator, createExecutionLedger, executeCapability, now } = {}) {
    requireMethod(cabin, "formGoal", "cabin");
    requireMethod(cabin, "synthesize", "cabin");
    requireMethod(orchestrator, "plan", "orchestrator");
    if (typeof createExecutionLedger !== "function") {
      throw new TypeError("createExecutionLedger must be a function");
    }
    if (typeof executeCapability !== "function") {
      throw new TypeError("executeCapability must be a function");
    }
    if (now !== undefined && typeof now !== "function") throw new TypeError("now must be a function");
    this.cabin = cabin;
    this.orchestrator = orchestrator;
    this.createExecutionLedger = createExecutionLedger;
    this.executeCapability = executeCapability;
    this.now = now ?? Date.now;
    this.tasks = new Map();
    this.listeners = new Set();
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(taskId) {
    const id = requireText(taskId, "taskId");
    return this.tasks.get(id)?.snapshot ?? null;
  }

  cancel(taskId, reasonCode = "task-cancelled") {
    const id = requireText(taskId, "taskId");
    const record = this.tasks.get(id);
    if (!record || record.settled) return record?.snapshot ?? null;
    record.cancelRequested = true;
    record.cancelReason = requireText(reasonCode, "reasonCode");
    record.epoch += 1;
    publishRecord(this, record, {
      cancellationState: "requested",
    });
    return record.snapshot;
  }

  async run(input = {}) {
    const runId = requireText(input.runId, "runId");
    const taskId = requireText(input.taskId ?? runId, "taskId");
    if (this.tasks.has(taskId) && !this.tasks.get(taskId).settled) {
      throw new TypeError(`task is already active: ${taskId}`);
    }
    const record = {
      taskId,
      runId,
      input,
      ledger: null,
      taskPlan: null,
      goalEnvelope: null,
      committedEffects: [],
      cancelRequested: false,
      cancelReason: "",
      epoch: 0,
      settled: false,
      snapshot: null,
    };
    this.tasks.set(taskId, record);
    publishRecord(this, record, {
      status: "queued",
      currentStage: "accepted",
      cancellationState: "none",
    });

    const modelCalls = [];
    try {
      publishRecord(this, record, { status: "running", currentStage: "planning" });
      if (input.semanticEnvelope) {
        record.goalEnvelope = createVehicleSluGoalEnvelope(input.semanticEnvelope);
      } else {
        let goalResult;
        try {
          goalResult = await this.cabin.formGoal({
            runId,
            rawText: input.rawText,
            parsedCommand: input.parsedCommand,
            context: input.context,
            signal: input.signal,
            deadlineAt: input.deadlineAt,
          });
        } catch (error) {
          if (record.cancelRequested || input.signal?.aborted || isCancellationError(error)) {
            throw createAbortError(record.cancelReason || input.signal?.reason || error);
          }
          emitModelBoundary(record, {
            phase: "goal-formation",
            component: "cabinModel",
            status: "unavailable",
            reasonCode: "goal-model-unavailable",
            summary: "Cabin 目标形成模型当前不可用。",
          });
          throw error;
        }
        throwIfCancelled(record, input.signal);
        try {
          record.goalEnvelope = createGoalEnvelope(goalResult?.goalEnvelope);
        } catch (error) {
          emitModelBoundary(record, {
            phase: "goal-formation",
            component: "cabinModel",
            telemetry: goalResult?.telemetry,
            status: "failed",
            reasonCode: "goal-envelope-invalid",
            summary: "Cabin 目标形成模型返回未通过契约校验。",
          });
          throw error;
        }
        modelCalls.push(modelCall("goal-formation", goalResult?.telemetry));
        emitModelBoundary(record, {
          phase: "goal-formation",
          component: "cabinModel",
          telemetry: goalResult?.telemetry,
          summary: "Cabin 目标形成模型调用已完成。",
        });
        emitAgentBoundary(record, {
          phase: "goal-formation",
          component: "cabinAssistant",
          summary: "Cabin Assistant 已形成可规划目标。",
          refs: [record.goalEnvelope.goalId],
          degraded: goalResult?.telemetry?.degraded === true,
        });
      }

      let planResult;
      try {
        planResult = await this.orchestrator.plan({
          runId,
          goalEnvelope: record.goalEnvelope,
          semanticEnvelope: input.semanticEnvelope,
          semanticAuthority: input.semanticAuthority,
          signal: input.signal,
          deadlineAt: input.deadlineAt,
        });
      } catch (error) {
        if (record.cancelRequested || input.signal?.aborted || isCancellationError(error)) {
          throw createAbortError(record.cancelReason || input.signal?.reason || error);
        }
        emitModelBoundary(record, {
          phase: "task-planning",
          component: "orchestratorModel",
          status: "unavailable",
          reasonCode: "task-planning-model-unavailable",
          summary: "Orchestrator 规划模型当前不可用。",
        });
        throw error;
      }
      throwIfCancelled(record, input.signal);
      try {
        if (planResult?.validation?.ok !== true
          || !planResult?.taskPlan
          || planResult.validation.plan !== planResult.taskPlan) {
          throw new TypeError("Orchestrator returned an invalid TaskPlan");
        }
        record.taskPlan = createTaskPlan(planResult.taskPlan);
        if (record.taskPlan.runId !== runId || record.taskPlan.goalId !== record.goalEnvelope.goalId) {
          throw new TypeError("TaskPlan identifiers must match the GoalEnvelope");
        }
        if (record.taskPlan.writeActionCount > 1) {
          throw new TypeError("TaskPlan may contain at most one vehicle write");
        }
        for (const step of record.taskPlan.steps) {
          const capability = getCapability(step.capabilityId);
          if (!capability) throw new TypeError(`unsupported capability: ${step.capabilityId}`);
          if (step.accessMode !== capability.accessMode) {
            throw new TypeError(`capability accessMode mismatch: ${step.capabilityId}`);
          }
        }
      } catch (error) {
        emitModelBoundary(record, {
          phase: "task-planning",
          component: "orchestratorModel",
          telemetry: planResult?.telemetry,
          status: "failed",
          reasonCode: "task-plan-invalid",
          summary: "Orchestrator 规划模型返回未通过契约校验。",
        });
        throw error;
      }
      modelCalls.push(modelCall("task-planning", planResult?.telemetry));
      emitModelBoundary(record, {
        phase: "task-planning",
        component: "orchestratorModel",
        telemetry: planResult?.telemetry,
        summary: "Orchestrator 规划模型调用已完成。",
      });
      emitAgentBoundary(record, {
        phase: "task-planning",
        component: "orchestrator",
        summary: "Orchestrator 已生成并校验任务计划。",
        refs: [record.taskPlan.planId, record.taskPlan.goalId],
        degraded: planResult?.telemetry?.degraded === true,
      });
      record.ledger = this.createExecutionLedger(record.taskPlan);
      validateLedger(record.ledger);

      const remainingSteps = new Map(record.taskPlan.steps.map((step) => [step.stepId, step]));
      while (remainingSteps.size > 0) {
        throwIfCancelled(record, input.signal);
        const step = [...remainingSteps.values()].find(
          (candidate) => record.ledger.canExecute(candidate.stepId)?.allowed === true,
        );
        if (!step) {
          const safetyRejectedWrites = [...remainingSteps.values()].filter((candidate) => (
            candidate.accessMode === "write"
            && record.ledger.canExecute(candidate.stepId)?.reasonCode === "safety-rejected"
          ));
          if (safetyRejectedWrites.length > 0) {
            for (const rejectedWrite of safetyRejectedWrites) {
              record.ledger.blockSafetyRejected(rejectedWrite.stepId);
              remainingSteps.delete(rejectedWrite.stepId);
            }
            publishRecord(this, record, {
              status: "running",
              currentStage: "executing",
              activeStepIds: [],
            });
            continue;
          }
          const blocked = [...remainingSteps.values()].map((candidate) => {
            const reason = record.ledger.canExecute(candidate.stepId)?.reasonCode || "unknown";
            return `${candidate.stepId}:${reason}`;
          }).join(",");
          throw new Error(`no ledger-runnable task step: ${blocked}`);
        }
        publishRecord(this, record, {
          status: "running",
          currentStage: "executing",
          activeStepIds: [step.stepId],
        });
        record.ledger.start(step.stepId);
        publishRecord(this, record, {
          status: "waiting",
          currentStage: "waiting",
          activeStepIds: [step.stepId],
        });
        const epoch = record.epoch;
        let committedEffect = null;
        try {
          const value = await this.executeCapability({
            step,
            goalEnvelope: record.goalEnvelope,
            taskPlan: record.taskPlan,
            signal: input.signal,
            deadlineAt: input.deadlineAt,
            context: input.context,
          });
          const normalizedValue = normalizeCapabilityResult(step, value);
          committedEffect = projectCommittedEffect(step, normalizedValue);
          if (committedEffect) appendCommittedEffect(record, committedEffect);
          if (record.cancelRequested || input.signal?.aborted || epoch !== record.epoch) {
            if (committedEffect) {
              record.ledger.complete(step.stepId, normalizedValue);
              remainingSteps.delete(step.stepId);
              record.ledger.cancel(record.cancelReason || "task-cancelled");
              return await finishWithFacts(this, record, modelCalls, {
                status: "cancelled",
                failureReason: record.cancelReason || "task-cancelled",
                synthesize: false,
              });
            }
            throw createAbortError(record.cancelReason || input.signal?.reason || "task-cancelled");
          }
          record.ledger.complete(step.stepId, normalizedValue);
        } catch (error) {
          if (record.cancelRequested || input.signal?.aborted) throw error;
          failRunningLedgerStep(record.ledger, step.stepId, errorMessage(error));
          record.ledger.cancel(errorMessage(error));
          if (record.committedEffects.length > 0) {
            return await finishWithFacts(this, record, modelCalls, {
              status: "failed",
              failureReason: errorMessage(error),
              synthesize: true,
            });
          }
          throw error;
        }
        remainingSteps.delete(step.stepId);
        publishRecord(this, record, {
          status: "running",
          currentStage: "executing",
          activeStepIds: [],
        });
      }

      return await finishWithFacts(this, record, modelCalls, {
        status: "completed",
        failureReason: "",
        synthesize: true,
      });
    } catch (error) {
      if (record.cancelRequested || input.signal?.aborted || isCancellationError(error)) {
        if (record.ledger) record.ledger.cancel(record.cancelReason || "task-cancelled");
        publishRecord(this, record, {
          status: "cancelled",
          cancellationState: "cancelled",
          activeStepIds: [],
        });
        throw createAbortError(record.cancelReason || input.signal?.reason || error);
      }
      if (record.ledger) record.ledger.cancel(errorMessage(error));
      publishRecord(this, record, { status: "failed", activeStepIds: [] });
      throw error;
    } finally {
      record.settled = true;
    }
  }
}

function failRunningLedgerStep(ledger, stepId, reason) {
  const step = ledger.snapshot().steps.find((candidate) => candidate.stepId === stepId);
  if (step?.status === "running") ledger.fail(stepId, reason);
}

function publishRecord(coordinator, record, changes) {
  const ledgerSnapshot = record.ledger?.snapshot?.();
  const stepIds = Array.isArray(ledgerSnapshot?.steps)
    ? ledgerSnapshot.steps
    : [];
  const current = record.snapshot;
  record.snapshot = createTaskSnapshot({
    taskId: record.taskId,
    runId: record.runId,
    status: changes.status ?? current?.status ?? "queued",
    currentStage: changes.currentStage ?? current?.currentStage ?? "accepted",
    completedStepIds: changes.completedStepIds
      ?? stepIds.filter((step) => step.status === "completed").map((step) => step.stepId),
    activeStepIds: changes.activeStepIds
      ?? stepIds.filter((step) => step.status === "running").map((step) => step.stepId),
    pendingStepIds: changes.pendingStepIds
      ?? stepIds.filter((step) => step.status === "planned").map((step) => step.stepId),
    committedEffects: record.committedEffects,
    latestFactsRef: Object.hasOwn(changes, "latestFactsRef")
      ? changes.latestFactsRef
      : current?.latestFactsRef ?? null,
    cancellationState: changes.cancellationState
      ?? current?.cancellationState
      ?? "none",
    updatedAt: coordinator.now(),
  });
  for (const listener of coordinator.listeners) listener(record.snapshot);
  return record.snapshot;
}

function validateLedger(ledger) {
  const methods = [
    "canExecute", "start", "complete", "fail", "blockSafetyRejected",
    "cancel", "buildExecutionFacts", "snapshot",
  ];
  if (!ledger || methods.some((method) => typeof ledger[method] !== "function")) {
    throw new TypeError("execution ledger does not implement the required contract");
  }
}

async function finishWithFacts(coordinator, record, modelCalls, {
  status,
  failureReason,
  synthesize,
}) {
  const completionRequested = status === "completed";
  let executionFacts = record.ledger.buildExecutionFacts({
    completionStatus: completionRequested ? "completed" : "incomplete",
    failureReason,
    degraded: !completionRequested,
  });
  let terminalStatus = status;
  if (completionRequested && isExplicitSafetyReject(executionFacts.safetyDecision)) {
    terminalStatus = "failed";
  } else if (completionRequested && executionFacts.completionStatus !== "completed") {
    terminalStatus = "failed";
    executionFacts = record.ledger.buildExecutionFacts({
      completionStatus: "incomplete",
      failureReason: executionFacts.failureReason || "execution-incomplete",
      degraded: true,
    });
  }
  const completed = terminalStatus === "completed";
  publishRecord(coordinator, record, {
    status: "running",
    currentStage: "finalizing",
    activeStepIds: [],
    latestFactsRef: factsRef(executionFacts),
    ...(terminalStatus === "cancelled" ? { cancellationState: "requested" } : {}),
  });

  let assistantResponse = factsOnlyBoundary(terminalStatus, executionFacts, record.committedEffects);
  const finalizationEpoch = record.epoch;
  if (synthesize) {
    let synthesis;
    let synthesisReturned = false;
    try {
      synthesis = await coordinator.cabin.synthesize({
        goalEnvelope: record.goalEnvelope,
        taskPlan: record.taskPlan,
        executionFacts,
        executionDisabled: record.input.executionDisabled === true,
        deferredFrameIds: record.input.semanticAuthority?.deferredFrameIds ?? [],
        signal: completed ? record.input.signal : undefined,
        deadlineAt: record.input.deadlineAt,
      });
      synthesisReturned = true;
    } catch (error) {
      if (record.cancelRequested
        || record.input.signal?.aborted
        || finalizationEpoch !== record.epoch
        || isCancellationError(error)) {
        if (record.committedEffects.length > 0) {
          return finishCancelledAfterCommittedSynthesis(
            coordinator,
            record,
            modelCalls,
            {},
          );
        }
        throw createAbortError(record.cancelReason || record.input.signal?.reason || error);
      }
      const unavailableTelemetry = {
        degraded: true,
        reason: "synthesis-failed",
      };
      modelCalls.push(modelCall("final-synthesis", unavailableTelemetry));
      emitModelBoundary(record, {
        phase: "final-synthesis",
        component: "cabinModel",
        telemetry: unavailableTelemetry,
        status: "unavailable",
        reasonCode: "final-synthesis-model-unavailable",
        summary: "Cabin 最终综合模型当前不可用。",
      });
    }
    if (synthesisReturned) {
      try {
        throwIfFinalizationCancelled(record, finalizationEpoch);
      } catch (error) {
        if (record.committedEffects.length > 0) {
          return finishCancelledAfterCommittedSynthesis(
            coordinator,
            record,
            modelCalls,
            synthesis?.telemetry,
          );
        }
        throw error;
      }
      let synthesisText = "";
      try {
        if (!isPlainObject(synthesis)) throw new TypeError("synthesis must be a plain object");
        synthesisText = requireText(synthesis.text, "synthesis.text");
      } catch (_error) {
        modelCalls.push(modelCall("final-synthesis", synthesis?.telemetry));
        emitModelBoundary(record, {
          phase: "final-synthesis",
          component: "cabinModel",
          telemetry: synthesis?.telemetry,
          status: "failed",
          reasonCode: "final-synthesis-boundary-invalid",
          summary: "Cabin 最终综合模型返回未通过契约校验。",
        });
      }
      if (synthesisText) {
        modelCalls.push(modelCall("final-synthesis", synthesis?.telemetry));
        emitModelBoundary(record, {
          phase: "final-synthesis",
          component: "cabinModel",
          telemetry: synthesis?.telemetry,
          summary: "Cabin 最终综合模型调用已完成。",
        });
        if (completed) assistantResponse = synthesisText;
        emitAgentBoundary(record, {
          phase: "final-synthesis",
          component: "cabinAssistant",
          summary: "Cabin Assistant 已基于执行事实完成最终综合。",
          refs: [factsRef(executionFacts)],
          degraded: !completed || synthesis?.telemetry?.degraded === true,
        });
      }
    }
  }
  assistantResponse = preserveDeferredFrameTruth(
    assistantResponse,
    record.input.semanticAuthority?.deferredFrameIds,
  );
  if (terminalStatus !== "cancelled") throwIfFinalizationCancelled(record, finalizationEpoch);
  publishRecord(coordinator, record, {
    status: terminalStatus,
    currentStage: "finalizing",
    activeStepIds: [],
    latestFactsRef: factsRef(executionFacts),
    ...(terminalStatus === "cancelled" ? { cancellationState: "cancelled" } : {}),
  });
  return deepFreeze({
    taskId: record.taskId,
    runId: record.runId,
    assistantResponse,
    goalEnvelope: record.goalEnvelope,
    taskPlan: record.taskPlan,
    executionFacts,
    modelCalls,
    committedEffects: record.committedEffects,
    status: terminalStatus,
  });
}

function preserveDeferredFrameTruth(response, deferredFrameIds) {
  const ids = Array.isArray(deferredFrameIds) ? deferredFrameIds.filter(Boolean) : [];
  if (ids.length === 0) return response;
  return `${String(response || "").trim()} 本轮未执行请求：${ids.join("、")}。`.trim();
}

function finishCancelledAfterCommittedSynthesis(coordinator, record, modelCalls, telemetry) {
  const reason = record.cancelReason || "task-cancelled-after-commit";
  record.ledger.cancel(reason);
  const executionFacts = record.ledger.buildExecutionFacts({
    completionStatus: "incomplete",
    failureReason: "task-cancelled-after-commit",
    degraded: true,
  });
  modelCalls.push(modelCall("final-synthesis", {
    ...(isPlainObject(telemetry) ? telemetry : {}),
    degraded: true,
    reason: "synthesis-cancelled",
  }));
  markModelEventHandled(record, "final-synthesis");
  publishRecord(coordinator, record, {
    status: "cancelled",
    currentStage: "finalizing",
    activeStepIds: [],
    latestFactsRef: factsRef(executionFacts),
    cancellationState: "cancelled",
  });
  return deepFreeze({
    taskId: record.taskId,
    runId: record.runId,
    assistantResponse: factsOnlyBoundary("cancelled", executionFacts, record.committedEffects),
    goalEnvelope: record.goalEnvelope,
    taskPlan: record.taskPlan,
    executionFacts,
    modelCalls,
    committedEffects: record.committedEffects,
    status: "cancelled",
  });
}

function normalizeCapabilityResult(step, value) {
  if (!isPlainObject(value)) return {};
  if (step.accessMode !== "write"
    || value.confirmedVehicleState
    || !isPlainObject(value.vehicleStateSnapshot)) return value;
  return {
    ...value,
    confirmedVehicleState: value.vehicleStateSnapshot,
  };
}

function projectCommittedEffect(step, value) {
  if (step.accessMode !== "write" || !isPlainObject(value)) return null;
  const toolResult = value.toolResult;
  const confirmedState = value.confirmedVehicleState;
  const snapshotId = toolResult?.confirmedSnapshotId;
  if (!isPlainObject(toolResult)
    || toolResult.executionState !== "observed-succeeded"
    || toolResult.ok !== true
    || typeof snapshotId !== "string"
    || !snapshotId.trim()
    || confirmedState?.id !== snapshotId) return null;
  return deepFreeze({
    stepId: step.stepId,
    capabilityId: step.capabilityId,
    commandId: requireText(toolResult.commandId, "toolResult.commandId"),
    tool: requireText(toolResult.tool, "toolResult.tool"),
    executionState: "observed-succeeded",
    confirmedSnapshotId: snapshotId.trim(),
  });
}

function appendCommittedEffect(record, effect) {
  if (!record.committedEffects.some((item) => item.commandId === effect.commandId)) {
    record.committedEffects.push(effect);
  }
}

function factsOnlyBoundary(status, executionFacts, committedEffects) {
  if (status === "cancelled" && committedEffects.length > 0) {
    return "任务已取消；已提交且由传感器确认的车辆效果已保留。";
  }
  if (status === "failed" && committedEffects.length > 0) {
    return "任务未完整完成；已提交且由传感器确认的车辆效果已保留。";
  }
  if (isExplicitSafetyReject(executionFacts.safetyDecision)) {
    const reason = typeof executionFacts.safetyDecision.reason === "string"
      ? executionFacts.safetyDecision.reason.trim()
      : "";
    return reason ? `当前操作未通过安全校验：${reason}` : "当前操作未通过安全校验。";
  }
  if (executionFacts.failureReason === "execution-incomplete") {
    return "抱歉，车辆操作尚未获得最终确认，任务暂时无法完整完成。";
  }
  if (executionFacts.failureReason) return `抱歉，任务未完整完成：${executionFacts.failureReason}。`;
  return "执行事实已汇总，但最终回复暂时无法生成。";
}

function isExplicitSafetyReject(value) {
  return isPlainObject(value) && value.allowed === false && value.action === "reject";
}

function throwIfFinalizationCancelled(record, epoch) {
  if (record.cancelRequested || record.input.signal?.aborted || epoch !== record.epoch) {
    throw createAbortError(record.cancelReason || record.input.signal?.reason || "task-cancelled");
  }
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : "capability execution failed";
}

function modelCall(phase, telemetry) {
  return deepFreeze({ phase, telemetry: isPlainObject(telemetry) ? structuredClone(telemetry) : {} });
}

function emitModelBoundary(record, {
  phase,
  component,
  telemetry,
  status = "completed",
  reasonCode = "",
  summary,
}) {
  const context = record.input.context;
  if (typeof context?.emit !== "function") return null;
  const event = context.emit({
    component,
    phase,
    status,
    summary,
    model: typeof telemetry?.model === "string" ? telemetry.model : undefined,
    provider: typeof telemetry?.provider === "string" ? telemetry.provider : undefined,
    durationMs: normalizeDuration(telemetry?.durationMs),
    metadata: {
      ...(reasonCode ? { reasonCode } : {}),
      degraded: status !== "completed" || telemetry?.degraded === true,
      modelTelemetry: projectPublicModelTelemetry(telemetry),
    },
  });
  markModelEventHandled(record, phase);
  return event;
}

function emitAgentBoundary(record, { phase, component, summary, refs, degraded }) {
  const context = record.input.context;
  if (typeof context?.emit !== "function") return null;
  return context.emit({
    component,
    phase,
    status: "completed",
    summary,
    refs,
    metadata: { degraded: degraded === true },
  });
}

function markModelEventHandled(record, phase) {
  if (typeof record.input.context?.markModelEventHandled === "function") {
    record.input.context.markModelEventHandled(phase);
  }
}

function projectPublicModelTelemetry(source = {}) {
  const projected = {};
  for (const field of ["revision", "fallbackReasonCode", "validationSubreason"]) {
    if (typeof source?.[field] === "string" && source[field].trim()) {
      projected[field] = source[field].trim();
    }
  }
  if (typeof source?.promptVersion === "string" && source.promptVersion.trim()) {
    projected.revision = source.promptVersion.trim();
  }
  if (typeof source?.degraded === "boolean") projected.fallback = source.degraded;
  for (const field of [
    "structuredRetryCount", "queueMs", "transportMs", "firstTokenMs", "generationMs",
    "parseMs", "inputTokenCount", "outputTokenCount",
  ]) {
    if (Number.isFinite(source?.[field]) && source[field] >= 0) {
      projected[field] = Math.round(source[field]);
    }
  }
  return Object.freeze(projected);
}

function normalizeDuration(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function factsRef(facts) {
  return `execution-facts:${facts.runId}:${facts.planId}`;
}

function throwIfCancelled(record, signal) {
  if (record.cancelRequested || signal?.aborted) {
    throw createAbortError(record.cancelReason || signal?.reason || "task-cancelled");
  }
}

function requireMethod(value, method, name) {
  if (typeof value?.[method] !== "function") throw new TypeError(`${name}.${method}() is required`);
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function requireEnum(value, allowed, field) {
  const normalized = requireText(value, field);
  if (!allowed.has(normalized)) throw new TypeError(`unsupported TaskSnapshot ${field}`);
  return normalized;
}

function uniqueStrings(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const unique = [];
  for (const item of value) {
    const normalized = requireText(item, `${field} item`);
    if (!unique.includes(normalized)) unique.push(normalized);
  }
  return unique;
}

function clonePlainArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isPlainData)) {
    throw new TypeError(`${field} must contain only plain data`);
  }
  return structuredClone(value);
}

function isPlainData(value) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainData);
  return isPlainObject(value) && Object.values(value).every(isPlainData);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("updatedAt must be a valid timestamp");
  return date.toISOString();
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isPlainObject(value)) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
