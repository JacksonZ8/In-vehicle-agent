import {
  isTrustedRequiredSlotProvenance,
  isTrustedSlotProvenance,
} from "../../runtime/agent-schemas.js";
import { sameVehicleStructuredFact } from "../../vehicle/vehicle-command-contract.js";
import { getVehicleWriteCapabilityById } from "../../vehicle/vehicle-write-capabilities.js";
import { createDirectExternalWeatherUseCase } from "./external-weather.js";
import {
  BackgroundTaskCoordinator,
  createTaskSnapshot,
} from "../background-task-coordinator.js";
import { presentProgress } from "../progress-presenter.js";

const ORCHESTRATED_OWNER_CAPABILITIES = new Set([
  "manual.retrieve",
  "memory.read",
  "external.query",
  "safety.evaluate",
  "confirmation.issue",
  "vehicle-state-provider.read",
]);

export function createComplexTaskUseCase(dependencies = {}) {
  const {
    externalDataAdapter,
    cabin,
    orchestrator,
    createExecutionLedger,
    capabilityOwners = {},
    vehicleControl,
    now = Date.now,
  } = dependencies;
  const directExternalWeather = createDirectExternalWeatherUseCase({ externalDataAdapter });
  validateCapabilityOwners(capabilityOwners);
  if (vehicleControl !== undefined && typeof vehicleControl?.execute !== "function") {
    throw new TypeError("vehicleControl.execute() is required when vehicleControl is provided");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  let backgroundTaskCoordinator = null;
  const getBackgroundTaskCoordinator = () => {
    if (backgroundTaskCoordinator) return backgroundTaskCoordinator;
    backgroundTaskCoordinator = new BackgroundTaskCoordinator({
      cabin,
      orchestrator,
      createExecutionLedger,
      executeCapability: (input) => executeOrchestratedCapability({
        ...input,
        capabilityOwners,
        vehicleControl,
      }),
      now,
    });
    return backgroundTaskCoordinator;
  };

  return Object.freeze({
    async execute(context = {}) {
      context.throwIfAborted();
      if (context.routeDecision?.mode === "orchestrated") {
        if (!hasOrchestrationDependencies({ cabin, orchestrator, createExecutionLedger })) {
          throw new TypeError(
            "complex-task direct execution requires direct-capability mode when background dependencies are absent",
          );
        }
        return executeOrchestratedTask({ context, getBackgroundTaskCoordinator, cabin, now });
      }
      if (context.routeDecision?.mode !== "direct-capability") {
        throw new TypeError("complex-task execution requires direct-capability or orchestrated mode");
      }
      return directExternalWeather.execute(context);
    },
  });
}

export function createManualRetrieveCapabilityOwner({
  manualRetriever,
  projectEvidenceRef,
} = {}) {
  if (typeof manualRetriever !== "function") throw new TypeError("manualRetriever must be a function");
  if (typeof projectEvidenceRef !== "function") throw new TypeError("projectEvidenceRef must be a function");
  return Object.freeze({
    async execute({ step, signal, deadlineAt }) {
      const chunks = await manualRetriever(step.input?.query || "", {
        vehicleModel: "ES8",
        signal,
        deadlineAt,
      });
      const evidence = Array.isArray(chunks) ? chunks : [];
      const metadata = isRecord(evidence.metadata) ? evidence.metadata : {};
      const status = ["hit", "miss", "unavailable"].includes(metadata.status)
        ? metadata.status
        : evidence.length ? "hit" : "miss";
      const reason = typeof metadata.reason === "string" ? metadata.reason : "";
      return Object.freeze({
        status,
        reason,
        summary: status === "hit"
          ? `手册检索命中 ${evidence.length} 条证据。`
          : status === "unavailable"
            ? "手册检索当前不可用。"
            : "手册检索未返回可用证据。",
        evidenceRefs: status === "hit" ? evidence.map(projectEvidenceRef) : [],
      });
    },
  });
}

function hasOrchestrationDependencies({ cabin, orchestrator, createExecutionLedger }) {
  return typeof cabin?.formGoal === "function"
    && typeof cabin?.synthesize === "function"
    && typeof orchestrator?.plan === "function"
    && typeof createExecutionLedger === "function";
}

async function executeOrchestratedTask({ context, getBackgroundTaskCoordinator, cabin, now }) {
  const taskId = context.runId;
  const emittedSnapshots = new Set();
  emitTaskProgress(context, createTaskSnapshot({
    taskId,
    runId: context.runId,
    status: "queued",
    currentStage: "accepted",
    completedStepIds: [],
    activeStepIds: [],
    pendingStepIds: [],
    committedEffects: [],
    latestFactsRef: null,
    cancellationState: "none",
    updatedAt: now(),
  }), emittedSnapshots);

  const coordinator = getBackgroundTaskCoordinator();
  const unsubscribe = coordinator.subscribe((snapshot) => {
    if (snapshot.runId === context.runId && snapshot.taskId === taskId) {
      emitTaskProgress(context, snapshot, emittedSnapshots);
    }
  });
  try {
    let result;
    let backgroundSettlement = null;
    try {
      backgroundSettlement = coordinator.run({
        taskId,
        runId: context.runId,
        rawText: context.rawText,
        parsedCommand: context.parsedCommand,
        semanticEnvelope: context.semanticEnvelope,
        semanticAuthority: context.semanticAuthority,
        executionDisabled: context.executionDisabled,
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        context,
      }).then(
        (value) => Object.freeze({ status: "fulfilled", value }),
        (reason) => Object.freeze({ status: "rejected", reason }),
      );
      const foregroundText = ["social", "explain"].includes(
        context.semanticEnvelope?.conversationGoal?.need,
      )
        ? await respondForeground({ context, cabin })
        : "";
      const settled = await backgroundSettlement;
      if (settled.status === "rejected") throw settled.reason;
      result = settled.value;
      if (foregroundText) {
        result = Object.freeze({
          ...result,
          assistantResponse: `${foregroundText} ${result.assistantResponse}`.trim(),
        });
      }
    } catch (error) {
      if (backgroundSettlement) await backgroundSettlement;
      emitTerminalTaskSnapshot(context, coordinator.getSnapshot(taskId));
      throw error;
    }
    const taskSnapshot = coordinator.getSnapshot(taskId);
    emitTerminalTaskSnapshot(context, taskSnapshot);
    return Object.freeze({ ...result, taskSnapshot });
  } finally {
    unsubscribe();
  }
}

async function respondForeground({ context, cabin }) {
  const deferred = new Set(context.semanticAuthority?.deferredFrameIds ?? []);
  const pendingFrameIds = (context.semanticAuthority?.allowedFrameIds ?? [])
    .filter((frameId) => !deferred.has(frameId));
  let result;
  try {
    result = await cabin.respondForeground({
      conversationGoal: context.semanticEnvelope.conversationGoal,
      pendingFrameIds,
      executionDisabled: context.executionDisabled === true,
      signal: context.signal,
    });
    context.throwIfAborted();
  } catch (error) {
    context.throwIfAborted();
    result = { text: "我先处理你的车内请求。", telemetry: { degraded: true, reason: "foreground-response-failed" } };
  }
  const text = typeof result?.text === "string" && result.text.trim()
    ? result.text.trim()
    : "我先处理你的车内请求。";
  context.emit({
    component: "cabinModel",
    phase: "chat-response",
    status: "completed",
    summary: "Cabin 前台沟通模型调用已完成。",
    model: result?.telemetry?.model,
    provider: result?.telemetry?.provider,
    durationMs: normalizeDuration(result?.telemetry?.durationMs),
    metadata: {
      degraded: result?.telemetry?.degraded === true,
      modelTelemetry: projectModelTelemetry(result?.telemetry),
    },
  });
  context.emit({
    component: "cabinAssistant",
    phase: "chat-response",
    status: "completed",
    summary: text,
    refs: pendingFrameIds,
    metadata: {
      degraded: result?.telemetry?.degraded === true,
      presentation: { responseSource: "foreground-cabin" },
    },
  });
  return text;
}

function emitTerminalTaskSnapshot(context, snapshot) {
  if (!snapshot || !["completed", "failed", "cancelled"].includes(snapshot.status)) {
    throw new TypeError("background task must settle with one terminal TaskSnapshot");
  }
  const presentation = {
    completed: { status: "completed", summary: "后台任务已完成。" },
    failed: { status: "failed", summary: "后台任务未完整完成，已保留执行事实。" },
    cancelled: { status: "cancelled", summary: "后台任务已取消，已保留已提交事实。" },
  }[snapshot.status];
  return context.emit({
    component: "responsePresentation",
    phase: "task-snapshot",
    status: presentation.status,
    summary: presentation.summary,
    refs: [snapshot.taskId, ...(snapshot.latestFactsRef ? [snapshot.latestFactsRef] : [])],
    metadata: {
      degraded: snapshot.status !== "completed",
      task: { snapshot },
    },
  });
}

function emitTaskProgress(context, snapshot, emittedSnapshots) {
  const copy = presentProgress(snapshot);
  if (!copy) return null;
  const fingerprint = [
    snapshot.status,
    snapshot.currentStage,
    snapshot.completedStepIds.join(","),
    snapshot.activeStepIds.join(","),
    snapshot.pendingStepIds.join(","),
    snapshot.latestFactsRef ?? "",
  ].join("|");
  if (emittedSnapshots.has(fingerprint)) return null;
  emittedSnapshots.add(fingerprint);
  return context.emit({
    component: "responsePresentation",
    phase: "task-snapshot",
    status: progressEventStatus(snapshot.status),
    summary: copy,
    refs: [snapshot.taskId, ...(snapshot.latestFactsRef ? [snapshot.latestFactsRef] : [])],
    metadata: { degraded: false, task: { snapshot } },
  });
}

function progressEventStatus(status) {
  if (status === "queued") return "queued";
  return "processing";
}

function projectModelTelemetry(source = {}) {
  const projected = {};
  if (typeof source?.degraded === "boolean") projected.fallback = source.degraded;
  if (Number.isInteger(source?.structuredRetryCount) && source.structuredRetryCount >= 0) {
    projected.structuredRetryCount = source.structuredRetryCount;
  }
  return Object.freeze(projected);
}

function normalizeDuration(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

async function executeOrchestratedCapability({
  step,
  goalEnvelope,
  taskPlan,
  signal,
  deadlineAt,
  context,
  capabilityOwners,
  vehicleControl,
}) {
  switch (step.capabilityId) {
    case "response.synthesize":
      return Object.freeze({});
    case "manual.retrieve":
    case "memory.read":
    case "external.query":
    case "safety.evaluate":
    case "confirmation.issue":
    case "vehicle-state-provider.read":
      return executeInjectedOwner(capabilityOwners, step.capabilityId, {
        step,
        goalEnvelope,
        taskPlan,
        signal,
        deadlineAt,
        context,
      });
    default:
      if (!getVehicleWriteCapabilityById(step.capabilityId)) {
        throw new TypeError(`unsupported orchestrated capability: ${step.capabilityId}`);
      }
      if (typeof vehicleControl?.execute !== "function") {
        throw new TypeError(`missing capability owner: ${step.capabilityId}`);
      }
      return vehicleControl.execute(vehicleControlContext({
        context,
        step,
        signal,
        deadlineAt,
      }));
  }
}

function executeInjectedOwner(owners, capabilityId, input) {
  const owner = owners[capabilityId];
  if (typeof owner?.execute !== "function") {
    throw new TypeError(`missing capability owner: ${capabilityId}`);
  }
  return owner.execute(input);
}

function vehicleControlContext({ context, step, signal, deadlineAt }) {
  return {
    runId: context.runId,
    rawText: context.rawText,
    routeDecision: context.routeDecision,
    parsedCommand: parsedVehicleCommand(context, step),
    interactionRef: context.interactionRef,
    signal,
    deadlineAt,
    confirmationResponse: context.confirmationResponse,
    vehicleSensorMode: context.vehicleSensorMode,
    vehicleSensorLatencyMs: context.vehicleSensorLatencyMs,
    emit: context.emit,
    throwIfAborted: context.throwIfAborted,
  };
}

function parsedVehicleCommand(context, step) {
  const capability = getVehicleWriteCapabilityById(step.capabilityId);
  if (!capability) throw new TypeError(`unsupported vehicle capability: ${step.capabilityId}`);
  const { intent } = capability;
  const authority = context.parsedCommand;
  if (!isRecord(authority)
    || authority.requestId !== context.runId
    || authority.intent !== intent
    || authority.speechAct !== "command"
    || authority.actionability?.actionable !== true) {
    throw new TypeError("vehicle plan must match one actionable normalized command authority");
  }
  const slots = capability.toSlots(step.input);
  const authorityProjection = isRecord(authority.slots) ? capability.pickSlots(authority.slots) : null;
  if (!sameVehicleStructuredFact(authorityProjection, slots)) {
    throw new TypeError("vehicle plan slots must exactly match the normalized command authority");
  }
  const slotProvenance = authority.slotProvenance;
  const contextTrusted = isTrustedSlotProvenance(slotProvenance);
  const provenanceTrusted = isRecord(slotProvenance)
    && Object.keys(slots).every((key) => isTrustedRequiredSlotProvenance(
      slotProvenance[key],
      { contextTrusted },
    ));
  if (!provenanceTrusted) {
    throw new TypeError("vehicle plan requires trusted required-slot provenance");
  }
  return Object.freeze({
    requestId: authority.requestId,
    intent: authority.intent,
    speechAct: authority.speechAct,
    actionability: authority.actionability,
    slots: authority.slots,
    slotProvenance,
  });
}

function validateCapabilityOwners(value) {
  if (!isRecord(value)) throw new TypeError("capabilityOwners must be an object");
  for (const [capabilityId, owner] of Object.entries(value)) {
    if (!ORCHESTRATED_OWNER_CAPABILITIES.has(capabilityId)) {
      throw new TypeError(`unsupported capability owner: ${capabilityId}`);
    }
    if (typeof owner?.execute !== "function") {
      throw new TypeError(`capability owner must provide execute(): ${capabilityId}`);
    }
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
