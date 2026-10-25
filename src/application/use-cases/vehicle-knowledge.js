import {
  createKnowledgeAnswer,
  createKnowledgeDelegation,
  createKnowledgeSubplan,
  createKnowledgeTerminalResult,
} from "../contracts/vehicle-knowledge.js";
import {
  executeKnowledgeSubplan,
  getManualRetrievalDuration,
} from "./vehicle-knowledge-execution.js";
import { resolveVehicleSluKnowledgeGoalAuthority } from "../../agents/goal-authority.js";
import { KNOWLEDGE_ELIGIBILITY_TOPOLOGY } from "../../agents/knowledge-plan-validator.js";
import { composeManualAnswer } from "../../manual/manual-answer-composer.js";
import { groundManualAnswer } from "../../manual/manual-claim-grounding.js";
import { buildManualSpeechText } from "../../manual/manual-speech-policy.js";

const ES8_SCOPE = "nio-es8-user-manual-2026";
const STATIC_CAPABILITIES = Object.freeze([
  "knowledge.manual.retrieve",
  "knowledge.answer.synthesize",
]);
const ELIGIBILITY_CAPABILITIES = Object.freeze(
  KNOWLEDGE_ELIGIBILITY_TOPOLOGY.map((step) => step.capabilityId),
);

export function createVehicleKnowledgeUseCase(dependencies = {}) {
  const {
    orchestratorController,
    cabinAssistantController,
    manualRetriever,
    refreshVehicleState,
    readVehicleStateSnapshot,
    safetyGateway,
    now,
    monotonicNow,
  } = dependencies;
  if (!orchestratorController || typeof orchestratorController.planKnowledgeTask !== "function") {
    throw new TypeError("orchestratorController must provide planKnowledgeTask()");
  }
  if (!cabinAssistantController
    || typeof cabinAssistantController.composeKnowledgeResponse !== "function"
    || typeof cabinAssistantController.presentKnowledgeBoundary !== "function") {
    throw new TypeError(
      "cabinAssistantController must provide composeKnowledgeResponse() and presentKnowledgeBoundary()",
    );
  }
  if (typeof manualRetriever !== "function") {
    throw new TypeError("manualRetriever must be a function");
  }
  if (now !== undefined && typeof now !== "function") throw new TypeError("now must be a function");
  if (monotonicNow !== undefined && typeof monotonicNow !== "function") {
    throw new TypeError("monotonicNow must be a function");
  }

  return Object.freeze({
    async execute(context) {
      context.throwIfAborted();
      const vehicleSluFrame = context.semanticEnvelope?.vehicleFrames?.find(
        (frame) => frame.capability === "knowledge",
      ) ?? null;
      if (vehicleSluFrame?.intent === "vehicle.state.query") {
        return executeVehicleStateQuery({
          context,
          frame: vehicleSluFrame,
          readVehicleStateSnapshot,
          cabinAssistantController,
        });
      }
      // The validated Vehicle-SLU knowledge frame is the only knowledge authority; no raw-text fallback.
      const requestedModel = vehicleSluFrame?.intent === "vehicle.knowledge.query"
        ? vehicleSluFrame.slots?.vehicleModel
        : null;
      if (requestedModel && requestedModel !== "ES8") {
        return presentCabinKnowledgeTerminal({
          context,
          cabinAssistantController,
          result: createBoundaryTerminalResult({
            runId: context.runId,
            outcomeStatus: "not-applicable",
            reasonCode: "vehicle-scope-not-applicable",
            limitations: ["首版仅接入 ES8 车型知识，未使用 ES8 手册回答其他车型问题。"],
            degraded: false,
          }),
        });
      }
      const structuredAuthority = resolveVehicleSluKnowledgeGoalAuthority(vehicleSluFrame);
      if (!structuredAuthority) {
        return presentCabinKnowledgeTerminal({
          context,
          cabinAssistantController,
          result: createBoundaryTerminalResult({
            runId: context.runId,
            outcomeStatus: "unavailable",
            reasonCode: "knowledge-authority-unavailable",
            limitations: ["当前请求缺少可验证的 ES8 车辆知识范围，无法给出结论。"],
            degraded: true,
          }),
        });
      }
      const rawText = structuredAuthority.objective;
      const requestedModels = requestedModel ? [requestedModel] : [];

      const delegationAuthority = Object.freeze({
        knowledgeGoal: structuredAuthority.objective,
        vehicleScope: ES8_SCOPE,
        allowVehicleStateRead: structuredAuthority.eligibilityAction === "body.tailgate.open",
        requireSafetyEligibilityExplanation: structuredAuthority.eligibilityAction === "body.tailgate.open",
        expectedAnswerContract: "KnowledgeAnswer",
      });
      const manualQueryPlan = createVehicleSluManualQueryPlan(vehicleSluFrame);
      const currentEligibility = structuredAuthority.eligibilityAction === "body.tailgate.open";
      const delegation = createDirectKnowledgeDelegation({
        runId: context.runId,
        authority: delegationAuthority,
        currentEligibility,
      });
      const orchestratedEntry = context.routeDecision?.routeId === "task"
        && context.routeDecision?.mode === "orchestrated";
      const delegationEvent = context.emit({
        component: orchestratedEntry ? "orchestrator" : "runtimeKernel",
        phase: "knowledge-delegation",
        status: "completed",
        summary: orchestratedEntry
          ? "Orchestrator 已创建只读车辆知识委派。"
          : "Runtime 已建立只读车辆知识入口。",
        refs: [delegation.delegationId],
        metadata: { knowledge: {
          delegationId: delegation.delegationId,
          delegation: projectKnowledgeDelegation(delegation),
        } },
      });
      // Independent knowledge questions arrive as separate frames; more than one needs a plan.
      const knowledgeFrameCount = context.semanticEnvelope.vehicleFrames
        .filter((frame) => frame.intent === "vehicle.knowledge.query").length;
      const complex = knowledgeFrameCount > 1;
      const modelCalls = [];
      let subplan;
      let planningEvent = null;

      if (complex) {
        const planned = await orchestratorController.planKnowledgeTask({
          delegation,
          complexity: "multi-target",
          signal: context.signal,
          deadlineAt: context.deadlineAt,
        });
        context.throwIfAborted();
        modelCalls.push(modelCall("knowledge-subplanning", planned.telemetry));
        context.emit({
          parentEventId: delegationEvent.eventId,
          component: "orchestratorModel",
          phase: "knowledge-plan-model",
          status: planned.subplan || planned.clarificationRequest ? "completed" : "failed",
          summary: "Orchestrator 车辆知识规划模型调用已完成。",
          refs: [delegation.delegationId],
          model: planned.telemetry?.model,
          provider: planned.telemetry?.provider,
          durationMs: integerDuration(planned.telemetry?.durationMs),
          metadata: {
            ...(planned.subplan || planned.clarificationRequest
              ? {}
              : { reasonCode: "knowledge-plan-invalid" }),
            degraded: planned.telemetry?.degraded === true,
            modelTelemetry: projectModelTelemetry(planned.telemetry),
            knowledge: { delegationId: delegation.delegationId },
          },
        });
        planningEvent = context.emit({
          parentEventId: delegationEvent.eventId,
          component: "orchestrator",
          phase: "knowledge-subplanning",
          status: planned.subplan
            ? "completed"
            : planned.clarificationRequest ? "awaiting_clarification" : "failed",
          summary: planned.subplan
            ? "车辆知识子计划已通过校验。"
            : planned.clarificationRequest
              ? "Orchestrator 已请求补充车辆知识目标。"
              : "车辆知识子计划不可用。",
          refs: [delegation.delegationId, ...(planned.subplan ? [planned.subplan.subplanId] : [])],
          metadata: {
            ...(planned.clarificationRequest?.reasonCode
              ? { reasonCode: planned.clarificationRequest.reasonCode }
              : !planned.subplan ? { reasonCode: "knowledge-plan-invalid" } : {}),
            degraded: planned.telemetry?.degraded === true
              || (!planned.subplan && !planned.clarificationRequest),
            knowledge: {
            delegationId: delegation.delegationId,
            ...(planned.subplan ? {
              subplanId: planned.subplan.subplanId,
              subplan: projectKnowledgeSubplan(planned.subplan),
            } : {}),
            ...(planned.clarificationRequest
              ? { clarificationRequest: projectKnowledgeClarification(planned.clarificationRequest) }
              : {}),
            validation: { ok: Boolean(planned.subplan || planned.clarificationRequest) },
            },
          },
        });
        if (planned.clarificationRequest) {
          return presentCabinKnowledgeTerminal({
            context,
            cabinAssistantController,
            result: planned.clarificationRequest,
            parentEventId: planningEvent.eventId,
            phase: "clarification",
            manualQueryPlan,
            modelCalls,
          });
        }
        if (!planned.subplan) {
          return presentCabinKnowledgeTerminal({
            context,
            cabinAssistantController,
            result: createKnowledgeTerminalResult({
              delegationId: delegation.delegationId,
              runId: delegation.runId,
              outcomeStatus: "unavailable",
              reasonCode: "knowledge-plan-invalid",
              limitations: ["车辆知识子计划未通过校验，无法基于可执行证据给出结论。"],
              degraded: true,
            }),
            parentEventId: planningEvent.eventId,
            manualQueryPlan,
            modelCalls,
          });
        }
        subplan = planned.subplan;
      } else {
        subplan = createDirectKnowledgeSubplan(delegation, manualQueryPlan);
      }

      const executionFacts = await executeKnowledgeSubplan({
        delegation,
        subplan,
        manualRetriever,
        manualRetrievalCandidate: context.manualRetrievalCandidate,
        refreshVehicleState,
        readVehicleStateSnapshot,
        safetyGateway,
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        now,
        monotonicNow,
      });
      context.throwIfAborted();
      const executionEvents = emitExecutionEvents({
        context,
        delegation,
        subplan,
        executionFacts,
        planningEvent,
        delegationEvent,
      });
      let result;
      let responseTelemetry = {};
      if (executionFacts.outcomeStatus !== "completed") {
        result = createExecutionTerminalKnowledgeResult(delegation, executionFacts);
      } else {
        const composed = await cabinAssistantController.composeKnowledgeResponse({
          delegation,
          subplan,
          executionFacts,
          signal: context.signal,
          deadlineAt: context.deadlineAt,
        });
        context.throwIfAborted();
        result = composed.result;
        responseTelemetry = composed.telemetry;
        modelCalls.push(modelCall("knowledge-answer", responseTelemetry));
      }
      const manualPostProcessing = delegation.requireSafetyEligibilityExplanation
        || result?.outcomeStatus !== "answered"
        ? null
        : postProcessStaticManualAnswer(result?.answer, executionFacts, rawText);
      const presentedResult = manualPostProcessing
        ? createKnowledgeAnswer({ ...result, answer: manualPostProcessing.assistantResponse })
        : result;
      const presentation = cabinAssistantController.presentKnowledgeBoundary({
        runId: delegation.runId,
        delegationId: delegation.delegationId,
        result: presentedResult,
      });
      const answerDependsOnEventIds = dependencyEventIds(subplan, "answer", executionEvents);
      const answerEventParent = answerDependsOnEventIds.at(-1)
        || planningEvent?.eventId
        || delegationEvent.eventId;
      if (responseTelemetry?.model || responseTelemetry?.provider) {
        context.emit({
          parentEventId: answerEventParent,
          component: "cabinModel",
          phase: "knowledge-answer-model",
          status: result?.outcomeStatus === "answered" ? "completed" : knowledgeTerminalStatus(result),
          summary: "Cabin 车辆知识回答模型调用已完成。",
          refs: [delegation.delegationId],
          model: responseTelemetry?.model,
          provider: responseTelemetry?.provider,
          durationMs: integerDuration(responseTelemetry?.durationMs),
          metadata: {
            ...(result?.reasonCode ? { reasonCode: result.reasonCode } : {}),
            degraded: responseTelemetry?.degraded === true,
            modelTelemetry: projectModelTelemetry(responseTelemetry),
            knowledge: { delegationId: delegation.delegationId },
          },
        });
      }
      context.emit({
        ...(answerEventParent ? { parentEventId: answerEventParent } : {}),
        component: "cabinAssistant",
        phase: "knowledge-answer",
        status: presentation.eventStatus,
        summary: result?.outcomeStatus === "answered"
          ? "已仅基于完成的读取事实生成车辆知识回答。"
          : result?.outcomeStatus === "clarification"
            ? "Cabin Assistant 已请求补充车辆知识目标。"
            : "读取事实不足，已返回车辆知识边界。",
        refs: knowledgeRefs(executionFacts),
        metadata: {
          ...(presentation.reasonCode ? { reasonCode: presentation.reasonCode } : {}),
          degraded: presentation.degraded === true || responseTelemetry?.degraded === true,
          knowledge: {
          delegationId: delegation.delegationId,
          subplanId: subplan.subplanId,
          stepId: "answer",
          capabilityId: "knowledge.answer.synthesize",
          dependsOnEventIds: answerDependsOnEventIds,
          outcomeStatus: result?.outcomeStatus,
          ...(typeof result?.supportStatus === "string"
            ? { supportStatus: result.supportStatus }
            : {}),
          evidenceRefs: projectManualEvidenceRefs(executionFacts.evidenceRefs),
          vehicleStateRefs: projectVehicleStateRefs(executionFacts.vehicleStateRefs),
          ...(executionFacts.safetyAssessmentRef
            ? { safetyAssessment: projectKnowledgeSafetyAssessment(executionFacts.safetyAssessmentRef) }
            : {}),
          },
        },
      });

      const evidence = createManualEvidence(
        manualQueryPlan,
        executionFacts,
        manualPostProcessing?.grounding,
      );
      return deepFreeze({
        assistantResponse: presentation.text,
        evidence: structuredClone(executionFacts.evidence || []),
        evidenceRefs: structuredClone(executionFacts.evidenceRefs || []),
        safetyDecision: executionFacts.safetyAssessmentRef ?? null,
        toolCall: null,
        toolResult: null,
        vehicleStateSnapshot: null,
        manualQueryPlan: structuredClone(manualQueryPlan),
        manualEvidence: evidence,
        modelCalls,
        degraded: result?.degraded === true
          || executionFacts.degraded === true
          || modelCalls.some((call) => call.telemetry?.degraded === true),
        reasonCode: result?.reasonCode || executionFacts.reasonCode || "",
        outcomeStatus: result?.outcomeStatus || "unavailable",
      });
    },
  });
}

function executeVehicleStateQuery({
  context,
  frame,
  readVehicleStateSnapshot,
  cabinAssistantController,
}) {
  if (typeof readVehicleStateSnapshot !== "function") {
    throw new TypeError("readVehicleStateSnapshot must be a function for vehicle.state.query");
  }
  const snapshot = readVehicleStateSnapshot();
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || !snapshot.values || typeof snapshot.values !== "object" || Array.isArray(snapshot.values)) {
    throw new TypeError("VehicleState Provider must return a snapshot");
  }
  const stateFields = frame.slots.stateFields;
  const values = Object.fromEntries(stateFields.map((field) => [field, snapshot.values[field]]));
  const projectedSnapshot = deepFreeze({
    id: snapshot.id,
    source: snapshot.source,
    simulated: snapshot.simulated === true,
    capturedAt: snapshot.capturedAt ?? null,
    values,
  });
  const presentation = cabinAssistantController.presentKnowledgeBoundary({
    runId: context.runId,
    stateFields: [...stateFields],
    vehicleStateSnapshot: projectedSnapshot,
  });
  const delegationId = `delegation:${context.runId}:vehicle-state`;
  const providerEvent = context.emit({
    component: "vehicleStateProvider",
    phase: "capability-execution",
    status: "completed",
    summary: "VehicleState Provider 已返回请求的车辆状态字段。",
    refs: [projectedSnapshot.id, frame.frameId],
    metadata: {
      vehicle: {
        snapshot: projectVehicleSnapshot(projectedSnapshot),
        stateFields: [...stateFields],
      },
    },
  });
  context.emit({
    parentEventId: providerEvent.eventId,
    component: "cabinAssistant",
    phase: "final-synthesis",
    status: presentation.eventStatus,
    summary: "Cabin Assistant 已基于 Provider 快照组织车辆状态回答。",
    refs: [projectedSnapshot.id],
    metadata: {
      reasonCode: presentation.reasonCode,
      degraded: presentation.degraded,
      presentation: {
        outcomeStatus: presentation.outcomeStatus,
        resultRef: projectedSnapshot.id,
      },
    },
  });
  return deepFreeze({
    assistantResponse: presentation.text,
    evidence: [],
    evidenceRefs: [],
    safetyDecision: null,
    toolCall: null,
    toolResult: null,
    vehicleStateSnapshot: projectedSnapshot,
    manualQueryPlan: null,
    manualEvidence: null,
    modelCalls: [],
    degraded: false,
    reasonCode: "vehicle-state-provider-read",
    outcomeStatus: "answered",
  });
}

function createVehicleSluManualQueryPlan(frame) {
  return deepFreeze({
    query: frame.slots.query.trim(),
    ...(frame.slots.vehicleModel ? { vehicleModel: frame.slots.vehicleModel } : {}),
    accessMode: "read",
    source: "vehicle-slu-frame",
  });
}

const knowledgeStep = (stepId, capabilityId, dependsOn, input, expectedOutput) => ({
  stepId,
  capabilityId,
  dependsOn,
  input,
  expectedOutput,
  accessMode: "read",
  status: "planned",
});

function createDirectKnowledgeDelegation({ runId, authority, currentEligibility }) {
  return createKnowledgeDelegation({
    delegationId: `delegation:${runId}:vehicle-knowledge`,
    runId,
    parentPlanId: `route:${runId}`,
    parentStepId: "vehicle-knowledge",
    knowledgeGoal: authority.knowledgeGoal,
    vehicleScope: ES8_SCOPE,
    allowedCapabilities: currentEligibility ? ELIGIBILITY_CAPABILITIES : STATIC_CAPABILITIES,
    allowVehicleStateRead: currentEligibility,
    requireSafetyEligibilityExplanation: currentEligibility,
    expectedAnswerContract: authority.expectedAnswerContract,
    dependsOn: [],
  });
}

function createDirectKnowledgeSubplan(delegation, manualQueryPlan) {
  const steps = delegation.requireSafetyEligibilityExplanation
    ? KNOWLEDGE_ELIGIBILITY_TOPOLOGY.map((topology) => knowledgeStep(
      topology.stepId,
      topology.capabilityId,
      [...topology.dependsOn],
      topology.input ? structuredClone(topology.input) : {
        facts: {
          summary: "仅基于手册、Provider 与 Safety 事实回答。",
          evidenceRefs: ["manual", "safety"],
        },
      },
      topology.capabilityId === "knowledge.answer.synthesize"
        ? "knowledge-answer"
        : "capability-result",
    ))
    : [
      knowledgeStep(
        "manual",
        "knowledge.manual.retrieve",
        [],
        { query: manualQueryPlan.query },
        "manual-evidence",
      ),
      knowledgeStep(
        "answer",
        "knowledge.answer.synthesize",
        ["manual"],
        { facts: { summary: "仅基于已检索证据回答。", evidenceRefs: ["manual"] } },
        "knowledge-answer",
      ),
    ];
  return createKnowledgeSubplan({
    subplanId: `subplan:${delegation.runId}:direct`,
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    parentPlanId: delegation.parentPlanId,
    parentStepId: delegation.parentStepId,
    steps,
    selectedCapabilities: steps.map((step) => step.capabilityId),
    planningSummary: "路由已决定；按确定性只读车辆知识拓扑执行。",
    model: "deterministic-direct",
    provider: "runtime-kernel",
    status: "planned",
  });
}

function emitExecutionEvents({
  context,
  delegation,
  subplan,
  executionFacts,
  planningEvent,
  delegationEvent,
}) {
  const eventsByStep = new Map();
  const definitions = new Map(subplan.steps.map((step) => [step.stepId, step]));
  const phaseByCapability = new Map([
    ["knowledge.manual.retrieve", ["manualRetriever", "knowledge-evidence"]],
    ["knowledge.vehicle-state.read", ["vehicleStateProvider", "knowledge-state-read"]],
    ["knowledge.safety.evaluate", ["safety", "knowledge-safety-assessment"]],
  ]);
  for (const stepResult of executionFacts.stepResults?.steps || []) {
    const eventContract = phaseByCapability.get(stepResult.capabilityId);
    if (!eventContract || stepResult.status === "planned") continue;
    const step = definitions.get(stepResult.stepId);
    const dependsOnEventIds = (step?.dependsOn || [])
      .map((stepId) => eventsByStep.get(stepId)?.eventId)
      .filter(Boolean);
    const parentEventId = dependsOnEventIds.at(-1)
      || planningEvent?.eventId
      || delegationEvent.eventId;
    const [component, phase] = eventContract;
    const status = knowledgeStepStatus(stepResult, phase, executionFacts);
    const retrievalDurationMs = phase === "knowledge-evidence"
      ? integerDuration(getManualRetrievalDuration(executionFacts))
      : undefined;
    const event = context.emit({
      ...(parentEventId ? { parentEventId } : {}),
      component,
      phase,
      status,
      summary: stepResult.status === "completed"
        ? `${stepResult.capabilityId} 只读步骤已完成。`
        : `${stepResult.capabilityId} 只读步骤不可用。`,
      ...(retrievalDurationMs !== undefined ? { durationMs: retrievalDurationMs } : {}),
      refs: knowledgeStepRefs(phase, executionFacts),
      metadata: {
        ...(stepResult.failureReason ? { reasonCode: stepResult.failureReason } : {}),
        degraded: stepResult.status !== "completed",
        knowledge: {
        delegationId: delegation.delegationId,
        subplanId: subplan.subplanId,
        stepId: stepResult.stepId,
        capabilityId: stepResult.capabilityId,
        dependsOnEventIds,
        outcomeStatus: stepResult.status,
        ...(phase === "knowledge-evidence" ? {
          retrievalStatus: stepResult.status === "completed"
            ? executionFacts.evidenceRefs.length ? "hit" : "miss"
            : "unavailable",
          evidenceRefs: projectManualEvidenceRefs(executionFacts.evidenceRefs),
        } : {}),
        ...(phase === "knowledge-state-read" ? {
          vehicleStateRefs: projectVehicleStateRefs(executionFacts.vehicleStateRefs),
        } : {}),
        ...(phase === "knowledge-safety-assessment" && executionFacts.safetyAssessmentRef ? {
          safetyAssessment: projectKnowledgeSafetyAssessment(executionFacts.safetyAssessmentRef),
        } : {}),
        },
      },
    });
    eventsByStep.set(stepResult.stepId, event);
  }
  return eventsByStep;
}

function dependencyEventIds(subplan, stepId, eventsByStep) {
  const step = subplan.steps.find((candidate) => candidate.stepId === stepId);
  return (step?.dependsOn || []).map((dependencyId) => eventsByStep.get(dependencyId)?.eventId)
    .filter(Boolean);
}

function projectKnowledgeDelegation(delegation) {
  return deepFreeze({
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    parentPlanId: delegation.parentPlanId,
    parentStepId: delegation.parentStepId,
    knowledgeGoal: delegation.knowledgeGoal,
    vehicleScope: delegation.vehicleScope,
    allowedCapabilities: [...delegation.allowedCapabilities],
    allowVehicleStateRead: delegation.allowVehicleStateRead,
    requireSafetyEligibilityExplanation: delegation.requireSafetyEligibilityExplanation,
    expectedAnswerContract: delegation.expectedAnswerContract,
    dependsOn: [...delegation.dependsOn],
  });
}

function projectKnowledgeSubplan(subplan) {
  return deepFreeze({
    subplanId: subplan.subplanId,
    delegationId: subplan.delegationId,
    runId: subplan.runId,
    parentPlanId: subplan.parentPlanId,
    parentStepId: subplan.parentStepId,
    selectedCapabilities: [...subplan.selectedCapabilities],
    steps: subplan.steps.map((step) => ({
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      dependsOn: [...step.dependsOn],
      accessMode: step.accessMode,
      status: step.status,
    })),
    planningSummary: subplan.planningSummary,
    status: subplan.status,
  });
}

function projectKnowledgeClarification(value = {}) {
  return deepFreeze({
    delegationId: String(value.delegationId || ""),
    runId: String(value.runId || ""),
    outcomeStatus: "clarification",
    questions: Array.isArray(value.questions) ? value.questions.map(String) : [],
    reasonCode: String(value.reasonCode || "knowledge-clarification"),
  });
}

function projectManualEvidenceRefs(refs = []) {
  if (!Array.isArray(refs)) throw new TypeError("knowledge evidenceRefs must be an array");
  return refs.map((ref) => {
    const fields = ["sourceId", "sourceVersion", "chunkId", "pageStart", "pageEnd", "excerpt", "score"];
    if (!ref || typeof ref !== "object" || Array.isArray(ref)
      || Object.keys(ref).length !== fields.length
      || fields.some((field) => !Object.hasOwn(ref, field))) {
      throw new TypeError("knowledge event requires strict Manual EvidenceRef fields");
    }
    return deepFreeze({
      sourceId: ref.sourceId,
      sourceVersion: ref.sourceVersion,
      chunkId: ref.chunkId,
      pageStart: ref.pageStart,
      pageEnd: ref.pageEnd,
      excerpt: ref.excerpt,
      score: {
        retrieval: ref.score?.retrieval,
        rerank: ref.score?.rerank ?? null,
        grounding: ref.score?.grounding ?? null,
      },
    });
  });
}

function projectVehicleStateRefs(refs = []) {
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((ref) => {
    const id = typeof ref?.snapshotId === "string" ? ref.snapshotId.trim() : "";
    return id ? [{ id, source: "vehicle-state-provider" }] : [];
  });
}

function projectKnowledgeSafetyAssessment(value = {}) {
  return deepFreeze({
    allowed: value.allowed === true,
    action: String(value.action || "unavailable"),
    reasonCode: String(value.reasonCode || (value.allowed ? "allowed" : "safety-rejected")),
    snapshotId: String(value.vehicleStateSnapshotId || value.vehicleStateAudit?.snapshotId || ""),
    policyId: String(value.policyId || ""),
  });
}

function projectVehicleSnapshot(snapshot = {}) {
  return deepFreeze({
    id: String(snapshot.id || ""),
    source: String(snapshot.source || "vehicle-state-provider"),
    simulated: snapshot.simulated === true,
    ...(typeof snapshot.capturedAt === "string" ? { capturedAt: snapshot.capturedAt } : {}),
  });
}

function knowledgeRefs(executionFacts) {
  return [...new Set([
    ...projectManualEvidenceRefs(executionFacts.evidenceRefs).map((ref) => ref.chunkId),
    ...projectVehicleStateRefs(executionFacts.vehicleStateRefs).map((ref) => ref.id),
    ...(executionFacts.safetyAssessmentRef?.policyId ? [executionFacts.safetyAssessmentRef.policyId] : []),
  ])];
}

function knowledgeStepRefs(phase, executionFacts) {
  if (phase === "knowledge-evidence") {
    return projectManualEvidenceRefs(executionFacts.evidenceRefs).map((ref) => ref.chunkId);
  }
  if (phase === "knowledge-state-read") {
    return projectVehicleStateRefs(executionFacts.vehicleStateRefs).map((ref) => ref.id);
  }
  if (phase === "knowledge-safety-assessment") {
    const assessment = executionFacts.safetyAssessmentRef;
    return [assessment?.vehicleStateSnapshotId, assessment?.policyId]
      .filter((value) => typeof value === "string" && value.trim());
  }
  return [];
}

function knowledgeStepStatus(stepResult, phase, executionFacts) {
  if (stepResult.status !== "completed") {
    return /unavailable|not-current|not-runnable/.test(stepResult.failureReason || "")
      ? "unavailable"
      : "failed";
  }
  if (phase === "knowledge-safety-assessment"
    && executionFacts.safetyAssessmentRef?.allowed === false) return "safety_rejected";
  return "completed";
}

function knowledgeTerminalStatus(result = {}) {
  if (result.outcomeStatus === "answered") return "completed";
  if (result.outcomeStatus === "clarification") return "awaiting_clarification";
  if (["unavailable", "not-applicable"].includes(result.outcomeStatus)) return "unavailable";
  return "failed";
}

function projectModelTelemetry(source = {}) {
  const projected = {};
  if (typeof source?.fallbackActive === "boolean") {
    projected.fallback = source.fallbackActive;
    projected.fallbackActive = source.fallbackActive;
  }
  if (typeof source?.fallbackAttempted === "boolean") {
    projected.fallbackAttempted = source.fallbackAttempted;
  }
  if (typeof source?.primaryFailureReasonCode === "string"
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(source.primaryFailureReasonCode)) {
    projected.primaryFailureReasonCode = source.primaryFailureReasonCode;
  }
  if (Number.isSafeInteger(source?.externalModelRequestCount)
    && source.externalModelRequestCount >= 0
    && source.externalModelRequestCount <= 2) {
    projected.externalModelRequestCount = source.externalModelRequestCount;
  }
  if (Number.isInteger(source?.structuredRetryCount) && source.structuredRetryCount >= 0) {
    projected.structuredRetryCount = source.structuredRetryCount;
  }
  return deepFreeze(projected);
}

function createManualEvidence(manualQueryPlan, executionFacts, grounding = null) {
  return deepFreeze({
    status: executionFacts.evidenceRefs?.length ? "hit" : "miss",
    query: manualQueryPlan.query,
    evidence: structuredClone(executionFacts.evidence || []),
    evidenceRefs: structuredClone(executionFacts.evidenceRefs || []),
    telemetry: Object.freeze({}),
    ...(grounding ? { grounding: structuredClone(grounding) } : {}),
  });
}

function postProcessStaticManualAnswer(candidateAnswer, executionFacts, question) {
  const evidence = completedManualGroundingEvidence(executionFacts);
  const grounded = groundManualAnswer(candidateAnswer, evidence, question);
  const grounding = evidence.length
    ? grounded.audit
    : { ...grounded.audit, status: "no-evidence" };
  const composed = composeManualAnswer({ ...grounding, answer: grounded.answer });
  return deepFreeze({
    assistantResponse: buildManualSpeechText(composed.text, grounding),
    grounding,
  });
}

function completedManualGroundingEvidence(executionFacts) {
  const completed = executionFacts.stepResults?.steps?.some(
    (step) => step.capabilityId === "knowledge.manual.retrieve" && step.status === "completed",
  );
  if (!completed || !Array.isArray(executionFacts.evidence)) return [];
  return executionFacts.evidence.map((item) => ({
    ...item,
    chunkId: item.id,
    sourceId: item.source,
    text: item.excerpt,
  }));
}

function terminalFragment({
  presentation,
  manualQueryPlan = null,
  modelCalls = [],
}) {
  return deepFreeze({
    assistantResponse: presentation.text,
    evidence: [],
    evidenceRefs: [],
    safetyDecision: null,
    toolCall: null,
    toolResult: null,
    vehicleStateSnapshot: null,
    manualQueryPlan,
    manualEvidence: null,
    modelCalls,
    degraded: presentation.degraded,
    reasonCode: presentation.reasonCode,
    outcomeStatus: presentation.outcomeStatus,
  });
}

function presentCabinKnowledgeTerminal({
  context,
  cabinAssistantController,
  result,
  parentEventId,
  phase = "final-synthesis",
  manualQueryPlan = null,
  modelCalls = [],
}) {
  const presentation = cabinAssistantController.presentKnowledgeBoundary({
    runId: context.runId,
    delegationId: result.delegationId,
    result,
  });
  context.emit({
    ...(parentEventId ? { parentEventId } : {}),
    component: "cabinAssistant",
    phase,
    status: presentation.eventStatus,
    summary: presentation.outcomeStatus === "clarification"
      ? "Cabin Assistant 已请求补充车辆知识目标。"
      : "Cabin Assistant 已生成受约束车辆知识边界。",
    refs: [result.delegationId],
    metadata: {
      ...(presentation.reasonCode ? { reasonCode: presentation.reasonCode } : {}),
      degraded: presentation.degraded,
      knowledge: {
      delegationId: result.delegationId,
      outcomeStatus: presentation.outcomeStatus,
      ...(presentation.outcomeStatus === "clarification"
        ? { clarificationRequest: projectKnowledgeClarification(presentation.result) }
        : {
          limitations: Array.isArray(presentation.result?.limitations)
            ? [...presentation.result.limitations]
            : [],
        }),
      },
    },
  });
  return terminalFragment({ presentation, manualQueryPlan, modelCalls });
}

function createBoundaryTerminalResult({
  runId,
  outcomeStatus,
  reasonCode,
  limitations,
  degraded,
}) {
  return createKnowledgeTerminalResult({
    delegationId: `delegation:${runId}:vehicle-knowledge`,
    runId,
    outcomeStatus,
    reasonCode,
    limitations,
    degraded,
  });
}

function createExecutionTerminalKnowledgeResult(delegation, executionFacts) {
  const outcomeStatus = executionFacts.outcomeStatus === "not-applicable"
    ? "not-applicable"
    : "unavailable";
  return createKnowledgeTerminalResult({
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    outcomeStatus,
    reasonCode: executionFacts.reasonCode || "knowledge-execution-unavailable",
    limitations: [delegation.requireSafetyEligibilityExplanation
      ? "车辆知识执行未完成，不能生成当前资格结论。"
      : "车辆知识执行未完成，无法基于可用证据给出结论。"],
    degraded: executionFacts.degraded === true || outcomeStatus === "unavailable",
  });
}

function modelCall(phase, telemetry) {
  return deepFreeze({ phase, telemetry: structuredClone(telemetry || {}) });
}

function integerDuration(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
