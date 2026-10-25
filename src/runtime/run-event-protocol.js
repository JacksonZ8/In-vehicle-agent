import { requireParticipant } from "./participant-registry.js";
import { normalizeEs7ComponentActionStateById } from "../vehicle/es7-action-catalog.js";

export const RUN_EVENT_PROTOCOL = Object.freeze({ id: "nio-run-event", version: "2.0.0" });
export const RUN_EVENT_STATUSES = Object.freeze([
  "queued", "processing", "awaiting_clarification", "completed", "cancelled",
  "safety_rejected", "unavailable", "failed", "uncertain",
]);
export const RUN_EVENT_PHASES = Object.freeze([
  "developer-scenario", "intake", "route-decision", "voice-bridge-eligibility",
  "goal-formation", "clarification", "task-planning", "plan-validation",
  "capability-execution", "execution-facts", "final-synthesis", "chat-response",
  "final-response", "task-snapshot", "external-query", "vehicle-safety",
  "vehicle-confirmation", "vehicle-execution", "knowledge-delegation",
  "knowledge-subplanning", "knowledge-plan-model", "knowledge-evidence",
  "knowledge-state-read", "knowledge-safety-assessment", "knowledge-answer-model",
  "knowledge-answer",
]);
export const TASK_PROGRESS_STAGES = Object.freeze([
  "accepted", "planning", "executing", "waiting", "finalizing",
]);

const STATUS_SET = new Set(RUN_EVENT_STATUSES);
const PHASE_SET = new Set(RUN_EVENT_PHASES);
const EXACT_EVENT_KEYS = new Set([
  "protocol", "eventId", "runId", "parentEventId", "sequence", "timestamp", "component",
  "componentType", "phase", "status", "summary", "refs", "model", "provider",
  "durationMs", "metadata",
]);
const CREATE_INPUT_KEYS = EXACT_EVENT_KEYS;
const METADATA_COMMON_KEYS = new Set([
  "reasonCode", "degraded", "simulated", "policyVersion", "interactionRef",
]);
const PHASE_METADATA_GROUPS = Object.freeze({
  "developer-scenario": new Set(["developerScenario"]),
  intake: new Set(),
  "route-decision": new Set(["routing", "modelTelemetry"]),
  "voice-bridge-eligibility": new Set(["voiceBridgeEligibility"]),
  "goal-formation": new Set(["task", "modelTelemetry"]),
  clarification: new Set(["task", "knowledge", "presentation"]),
  "task-planning": new Set(["task", "modelTelemetry"]),
  "plan-validation": new Set(["task"]),
  "capability-execution": new Set(["task", "vehicle", "external"]),
  "execution-facts": new Set(["task"]),
  "final-synthesis": new Set(["task", "knowledge", "modelTelemetry", "presentation"]),
  "chat-response": new Set(["modelTelemetry", "presentation"]),
  "final-response": new Set(["task", "knowledge", "vehicle", "external", "presentation"]),
  "task-snapshot": new Set(["task"]),
  "external-query": new Set(["external", "presentation"]),
  "vehicle-safety": new Set(["vehicle"]),
  "vehicle-confirmation": new Set(["vehicle"]),
  "vehicle-execution": new Set(["vehicle"]),
  "knowledge-delegation": new Set(["knowledge"]),
  "knowledge-subplanning": new Set(["knowledge"]),
  "knowledge-plan-model": new Set(["knowledge", "modelTelemetry"]),
  "knowledge-evidence": new Set(["knowledge"]),
  "knowledge-state-read": new Set(["knowledge"]),
  "knowledge-safety-assessment": new Set(["knowledge"]),
  "knowledge-answer-model": new Set(["knowledge", "modelTelemetry"]),
  "knowledge-answer": new Set(["knowledge", "presentation"]),
});
const KNOWLEDGE_PHASE_COMPONENTS = Object.freeze({
  "knowledge-delegation": new Set(["runtimeKernel", "orchestrator"]),
  "knowledge-subplanning": new Set(["orchestrator"]),
  "knowledge-plan-model": new Set(["orchestratorModel"]),
  "knowledge-evidence": new Set(["manualRetriever"]),
  "knowledge-state-read": new Set(["vehicleStateProvider"]),
  "knowledge-safety-assessment": new Set(["safety"]),
  "knowledge-answer-model": new Set(["cabinModel"]),
  "knowledge-answer": new Set(["cabinAssistant"]),
});
const SENSITIVE_KEYS = new Set([
  "prompt", "systemprompt", "rawoutput", "rawmodelresponse", "rawresponse",
  "chainofthought", "apikey", "accesskey", "secret", "secretkey", "privatekey",
  "authorization", "bearer", "credential", "credentials", "password", "token",
  "authtoken", "accesstoken", "refreshtoken", "responsetoken",
]);
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_NODES = 512;
export function createRunEvent(input = {}) {
  const errors = validateCreateInput(input);
  if (errors.length > 0) throw new TypeError(errors.join("; "));
  const participant = requireParticipant(input.component);
  const refs = normalizeRefs(input.refs);
  const metadata = cloneMetadata(input.metadata ?? {}, input.phase, input.runId);
  const event = {
    protocol: RUN_EVENT_PROTOCOL,
    eventId: requiredText(input.eventId),
    runId: requiredText(input.runId),
    parentEventId: input.parentEventId == null ? null : requiredText(input.parentEventId),
    sequence: input.sequence,
    timestamp: requiredText(input.timestamp),
    component: participant.id,
    componentType: participant.type,
    phase: requiredText(input.phase),
    status: requiredText(input.status),
    summary: requiredText(input.summary),
    refs,
    model: optionalText(input.model),
    provider: optionalText(input.provider),
    durationMs: input.durationMs ?? null,
    metadata,
  };
  const validationErrors = validateRunEvent(event);
  if (validationErrors.length > 0) throw new TypeError(validationErrors.join("; "));
  return Object.freeze(event);
}

export function validateRunEvent(event) {
  if (!isPlainRecord(event)) return ["event must be a plain object"];
  const errors = [];
  const keys = Object.keys(event);
  const unknown = keys.filter((key) => !EXACT_EVENT_KEYS.has(key));
  const missing = [...EXACT_EVENT_KEYS].filter((key) => !Object.hasOwn(event, key));
  if (unknown.length) errors.push(`unknown top-level event key: ${unknown.join(", ")}`);
  if (missing.length) errors.push(`missing top-level event key: ${missing.join(", ")}`);
  if (!isPlainRecord(event.protocol) || !hasExactKeys(event.protocol, ["id", "version"])) {
    errors.push("protocol must have the exact id/version shape");
  } else if (event.protocol.id !== RUN_EVENT_PROTOCOL.id
    || event.protocol.version !== RUN_EVENT_PROTOCOL.version) {
    errors.push("protocol must identify nio-run-event@2.0.0");
  }
  for (const field of ["eventId", "runId", "component", "phase", "status", "summary"]) {
    if (!requiredText(event[field])) errors.push(`${field} must be a non-empty string`);
  }
  if (event.parentEventId !== null && !requiredText(event.parentEventId)) {
    errors.push("parentEventId must be null or a non-empty string");
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    errors.push("sequence must be a safe integer >= 1");
  }
  if (!isIsoTimestamp(event.timestamp)) errors.push("timestamp must be an ISO timestamp");
  if (!STATUS_SET.has(event.status)) errors.push("status is not supported");
  if (!PHASE_SET.has(event.phase)) errors.push("phase is not supported");
  if (typeof event.summary === "string" && event.summary.length > 500) errors.push("summary exceeds 500 characters");
  let participant = null;
  try {
    participant = requireParticipant(event.component);
  } catch (error) {
    errors.push(error.message);
  }
  if (participant && event.componentType !== participant.type) {
    errors.push("componentType must match the component registry");
  }
  const knowledgeOwners = KNOWLEDGE_PHASE_COMPONENTS[event.phase];
  if (knowledgeOwners && !knowledgeOwners.has(event.component)) {
    errors.push(`${event.phase} requires component ${[...knowledgeOwners].join(" or ")}`);
  }
  try {
    normalizeRefs(event.refs);
  } catch (error) {
    errors.push(error.message);
  }
  if (event.model !== null && !requiredText(event.model)) errors.push("model must be a string or null");
  if (event.provider !== null && !requiredText(event.provider)) errors.push("provider must be a string or null");
  if (event.durationMs !== null && (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0)) {
    errors.push("durationMs must be a non-negative safe integer or null");
  }
  try {
    validateMetadata(event.metadata, event.phase, event.runId);
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

export function createInteractionRef({ sessionId, turnId } = {}) {
  if (!requiredText(sessionId) || !requiredText(turnId)) {
    throw new TypeError("interactionRef requires sessionId and turnId");
  }
  return Object.freeze({ sessionId: sessionId.trim(), turnId: turnId.trim() });
}

export function validateB3RunEventSequence(events) {
  if (!Array.isArray(events)) return ["B3 events must be an array"];
  const knowledgeEvents = events.filter((event) => KNOWLEDGE_PHASE_COMPONENTS[event?.phase]);
  if (knowledgeEvents.length === 0) return [];
  const errors = [];
  const byId = new Map(knowledgeEvents.map((event) => [event.eventId, event]));
  const delegationEvents = knowledgeEvents.filter((event) => event.phase === "knowledge-delegation");
  if (delegationEvents.length > 1) errors.push("B3 run may contain at most one knowledge-delegation event");
  const delegation = delegationEvents[0] || null;
  const delegationId = knowledgeDelegationId(delegation);
  if (delegation && !delegationId) errors.push("B3 delegation event requires delegationId");
  const subplanning = knowledgeEvents.find((event) => event.phase === "knowledge-subplanning") || null;
  const subplan = subplanning?.metadata?.knowledge?.subplan;

  for (const event of knowledgeEvents) {
    if (event.phase === "knowledge-delegation") continue;
    const currentDelegationId = knowledgeDelegationId(event);
    if (!currentDelegationId || currentDelegationId !== delegationId) {
      errors.push(`B3 event ${event.eventId} delegationId must match delegation`);
    }
    const parent = byId.get(event.parentEventId);
    if (!parent) {
      errors.push(`B3 event ${event.eventId} parentEventId must reference a B3 event`);
      continue;
    }
    if (parent.sequence >= event.sequence) errors.push(`B3 event ${event.eventId} parent must precede child`);
    if (knowledgeDelegationId(parent) !== currentDelegationId) {
      errors.push(`B3 event ${event.eventId} parent delegationId must match child`);
    }
    if (event.phase === "knowledge-subplanning" && parent.phase !== "knowledge-delegation") {
      errors.push("B3 subplanning parent must be knowledge-delegation");
    }
    if (event.phase === "knowledge-safety-assessment" && parent.phase !== "knowledge-state-read") {
      errors.push("B3 safety assessment parent must be knowledge-state-read");
    }
  }

  if (isPlainRecord(subplan) && Array.isArray(subplan.steps)) {
    for (const event of knowledgeEvents) {
      if (!isKnowledgeStepEvent(event)) continue;
      const knowledge = event.metadata?.knowledge;
      const step = subplan.steps.find((candidate) => candidate?.stepId === knowledge?.stepId);
      if (!step || step.capabilityId !== knowledge?.capabilityId) {
        errors.push(`B3 event ${event.eventId} must identify its subplan stepId and capabilityId`);
        continue;
      }
      if (!Array.isArray(knowledge.dependsOnEventIds)
        || !knowledge.dependsOnEventIds.every((id) => requiredText(id))) {
        errors.push(`B3 event ${event.eventId} dependsOnEventIds must be an array of event IDs`);
        continue;
      }
      const expected = (Array.isArray(step.dependsOn) ? step.dependsOn : []).flatMap((stepId) => (
        knowledgeEvents
          .filter((candidate) => candidate.metadata?.knowledge?.stepId === stepId
            && knowledgeDelegationId(candidate) === delegationId)
          .map((candidate) => candidate.eventId)
      ));
      if (!sameList(knowledge.dependsOnEventIds, expected)) {
        errors.push(`B3 event ${event.eventId} dependsOnEventIds must include every emitted direct dependency in subplan order`);
      }
      for (const dependencyId of knowledge.dependsOnEventIds) {
        const dependency = byId.get(dependencyId);
        if (!dependency) errors.push(`B3 event ${event.eventId} dependency ${dependencyId} must reference a B3 event`);
        else if (dependency.sequence >= event.sequence) errors.push(`B3 event ${event.eventId} dependency ${dependencyId} must precede child`);
        else if (knowledgeDelegationId(dependency) !== delegationId) errors.push(`B3 event ${event.eventId} dependency delegationId must match child`);
      }
      const expectedParent = expected.at(-1) || subplanning.eventId;
      if (event.parentEventId !== expectedParent) {
        errors.push(`B3 event ${event.eventId} parentEventId must equal the last dependency event or subplan event`);
      }
    }
  }
  return errors;
}

function validateCreateInput(input) {
  if (!isPlainRecord(input)) return ["event must be a plain object"];
  const errors = [];
  const unknown = Object.keys(input).filter((key) => !CREATE_INPUT_KEYS.has(key));
  if (unknown.length) errors.push(`unknown top-level event key: ${unknown.join(", ")}`);
  for (const field of ["eventId", "runId", "component", "phase", "status", "summary"]) {
    if (!requiredText(input[field])) errors.push(`${field} must be a non-empty string`);
  }
  if (input.parentEventId !== null && input.parentEventId !== undefined && !requiredText(input.parentEventId)) {
    errors.push("parentEventId must be null or a non-empty string");
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) errors.push("sequence must be a safe integer >= 1");
  if (!isIsoTimestamp(input.timestamp)) errors.push("timestamp must be an ISO timestamp");
  if (requiredText(input.phase) && !PHASE_SET.has(input.phase.trim())) errors.push("phase is not supported");
  if (requiredText(input.status) && !STATUS_SET.has(input.status.trim())) errors.push("status is not supported");
  if (typeof input.summary === "string" && input.summary.length > 500) errors.push("summary exceeds 500 characters");
  try {
    const participant = requireParticipant(input.component);
    if (Object.hasOwn(input, "componentType") && input.componentType !== participant.type) {
      errors.push("componentType must match the component registry");
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (Object.hasOwn(input, "protocol")
    && (!isPlainRecord(input.protocol)
      || !hasExactKeys(input.protocol, ["id", "version"])
      || input.protocol.id !== RUN_EVENT_PROTOCOL.id
      || input.protocol.version !== RUN_EVENT_PROTOCOL.version)) {
    errors.push("protocol must match nio-run-event@2.0.0");
  }
  if (input.model != null && !requiredText(input.model)) errors.push("model must be a string or null");
  if (input.provider != null && !requiredText(input.provider)) errors.push("provider must be a string or null");
  if (input.durationMs != null && (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0)) {
    errors.push("durationMs must be a non-negative safe integer or null");
  }
  try {
    normalizeRefs(input.refs ?? []);
  } catch (error) {
    errors.push(error.message);
  }
  try {
    validateMetadata(input.metadata ?? {}, input.phase, input.runId);
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

function validateMetadata(metadata, phase, runId) {
  if (!isPlainRecord(metadata)) throw new TypeError("metadata must be a plain object");
  const allowedGroups = PHASE_METADATA_GROUPS[phase] || new Set();
  for (const key of Object.keys(metadata)) {
    if (!METADATA_COMMON_KEYS.has(key) && !allowedGroups.has(key)) {
      throw new TypeError(`metadata key ${key} is not allowed for phase ${phase}`);
    }
  }
  validatePlainData(metadata);
  for (const group of allowedGroups) {
    if (Object.hasOwn(metadata, group)) {
      validateMetadataGroup(group, metadata[group], { phase, runId });
    }
  }
  if (Object.hasOwn(metadata, "reasonCode") && !requiredText(metadata.reasonCode)) throw new TypeError("metadata.reasonCode must be a non-empty string");
  for (const key of ["degraded", "simulated"]) {
    if (Object.hasOwn(metadata, key) && typeof metadata[key] !== "boolean") throw new TypeError(`metadata.${key} must be boolean`);
  }
  if (Object.hasOwn(metadata, "policyVersion") && !requiredText(metadata.policyVersion)) throw new TypeError("metadata.policyVersion must be a non-empty string");
  if (Object.hasOwn(metadata, "interactionRef")) validateExactInteractionRef(metadata.interactionRef);
  if (Object.hasOwn(metadata, "voiceBridgeEligibility")) validateVoiceBridgeEligibility(metadata.voiceBridgeEligibility, runId);
  if (metadata.knowledge?.evidenceRefs !== undefined) validateManualEvidenceRefs(metadata.knowledge.evidenceRefs);
  return metadata;
}

function validateMetadataGroup(group, value, context) {
  if (!isPlainRecord(value)) throw new TypeError(`metadata.${group} must be a plain object`);
  const validators = {
    routing: validateRoutingMetadata,
    modelTelemetry: validateModelTelemetry,
    task: validateTaskMetadata,
    knowledge: validateKnowledgeMetadata,
    vehicle: validateVehicleMetadata,
    external: validateExternalMetadata,
    presentation: validatePresentationMetadata,
    developerScenario: validateDeveloperScenarioMetadata,
    voiceBridgeEligibility: (item) => validateVoiceBridgeEligibility(item, context.runId),
  };
  const validator = validators[group];
  if (!validator) throw new TypeError(`unknown metadata group: ${group}`);
  validator(value, context);
}

function validateRoutingMetadata(value, { runId }) {
  assertShape(value, "metadata.routing", {
    required: ["routeId", "mode", "disposition", "semanticSource", "validation"],
    optional: ["semanticSummary"],
  });
  for (const key of ["routeId", "mode", "disposition", "semanticSource"]) {
    assertString(value[key], `metadata.routing.${key}`);
  }
  assertShape(value.validation, "metadata.routing.validation", {
    required: ["contract", "capability", "slot"],
  });
  for (const key of ["contract", "capability", "slot"]) {
    assertShape(value.validation[key], `metadata.routing.validation.${key}`, { required: ["ok"] });
    assertBoolean(value.validation[key].ok, `metadata.routing.validation.${key}.ok`);
  }
  if (!Object.hasOwn(value, "semanticSummary")) return;
  const summary = value.semanticSummary;
  assertShape(summary, "metadata.routing.semanticSummary", {
    required: [
      "contractVersion", "requestId", "domain", "conversationGoal", "domainConfidence",
      "vehicleFrames",
    ],
  });
  for (const key of ["contractVersion", "requestId", "domain"]) {
    assertRequiredString(summary[key], `metadata.routing.semanticSummary.${key}`);
  }
  if (summary.requestId !== runId) throw new TypeError("metadata.routing.semanticSummary.requestId must match runId");
  assertShape(summary.conversationGoal, "metadata.routing.semanticSummary.conversationGoal", {
    required: ["summary", "need"],
  });
  assertString(summary.conversationGoal.summary, "metadata.routing.semanticSummary.conversationGoal.summary");
  assertString(summary.conversationGoal.need, "metadata.routing.semanticSummary.conversationGoal.need");
  assertFiniteNumber(summary.domainConfidence, "metadata.routing.semanticSummary.domainConfidence");
  assertArray(summary.vehicleFrames, "metadata.routing.semanticSummary.vehicleFrames", (frame, index) => {
    const label = `metadata.routing.semanticSummary.vehicleFrames[${index}]`;
    assertShape(frame, label, {
      required: [
        "frameId", "capability", "intent", "speechAct", "knowledgeNeed", "actionNeed",
        "missingSlots", "clarificationQuestion", "confidence", "slotNames",
      ],
    });
    for (const key of ["frameId", "capability", "intent", "speechAct", "knowledgeNeed", "actionNeed"]) {
      assertString(frame[key], `${label}.${key}`);
    }
    assertStringArray(frame.missingSlots, `${label}.missingSlots`);
    if (frame.clarificationQuestion !== null) {
      assertString(frame.clarificationQuestion, `${label}.clarificationQuestion`);
    }
    assertFiniteNumber(frame.confidence, `${label}.confidence`);
    assertStringArray(frame.slotNames, `${label}.slotNames`);
  });
}

function validateModelTelemetry(value) {
  assertShape(value, "metadata.modelTelemetry", {
    optional: [
      "revision", "fallback", "fallbackReasonCode", "structuredRetryCount",
      "validationSubreason", "queueMs", "transportMs", "firstTokenMs", "generationMs",
      "parseMs", "inputTokenCount", "outputTokenCount", "primaryFailureReasonCode",
      "providerFailureReasonCode", "fallbackActive", "fallbackAttempted",
      "externalModelRequestCount", "ollamaDurations",
    ],
  });
  for (const key of [
    "revision", "fallbackReasonCode", "validationSubreason",
    "primaryFailureReasonCode", "providerFailureReasonCode",
  ]) {
    if (Object.hasOwn(value, key)) assertRequiredString(value[key], `metadata.modelTelemetry.${key}`);
  }
  if (Object.hasOwn(value, "fallback")) assertBoolean(value.fallback, "metadata.modelTelemetry.fallback");
  for (const key of ["fallbackActive", "fallbackAttempted"]) {
    if (Object.hasOwn(value, key)) assertBoolean(value[key], `metadata.modelTelemetry.${key}`);
  }
  for (const key of [
    "structuredRetryCount", "queueMs", "transportMs", "firstTokenMs", "generationMs",
    "parseMs", "inputTokenCount", "outputTokenCount", "externalModelRequestCount",
  ]) {
    if (Object.hasOwn(value, key)) assertNonNegativeInteger(value[key], `metadata.modelTelemetry.${key}`);
  }
  if (Object.hasOwn(value, "ollamaDurations")) {
    assertShape(value.ollamaDurations, "metadata.modelTelemetry.ollamaDurations", {
      optional: [
        "total_duration_ms", "load_duration_ms", "prompt_eval_duration_ms",
        "eval_duration_ms", "prompt_eval_count", "eval_count",
      ],
    });
    for (const [key, duration] of Object.entries(value.ollamaDurations)) {
      assertNonNegativeInteger(duration, `metadata.modelTelemetry.ollamaDurations.${key}`);
    }
  }
}

function validateTaskMetadata(value, { runId }) {
  assertShape(value, "metadata.task", { required: ["snapshot"] });
  const snapshot = value.snapshot;
  assertShape(snapshot, "metadata.task.snapshot", {
    required: [
      "taskId", "runId", "status", "currentStage", "completedStepIds", "activeStepIds",
      "pendingStepIds", "committedEffects", "latestFactsRef", "cancellationState", "updatedAt",
    ],
  });
  assertRequiredString(snapshot.taskId, "metadata.task.snapshot.taskId");
  assertRequiredString(snapshot.runId, "metadata.task.snapshot.runId");
  if (snapshot.runId !== runId) throw new TypeError("metadata.task.snapshot.runId must match runId");
  assertEnum(snapshot.status, ["queued", "running", "waiting", "completed", "failed", "cancelled"], "metadata.task.snapshot.status");
  assertEnum(snapshot.currentStage, TASK_PROGRESS_STAGES, "metadata.task.snapshot.currentStage");
  for (const key of ["completedStepIds", "activeStepIds", "pendingStepIds"]) {
    assertStringArray(snapshot[key], `metadata.task.snapshot.${key}`);
  }
  assertArray(snapshot.committedEffects, "metadata.task.snapshot.committedEffects", (effect, index) => {
    const label = `metadata.task.snapshot.committedEffects[${index}]`;
    assertShape(effect, label, {
      required: ["stepId", "capabilityId", "commandId", "tool", "executionState", "confirmedSnapshotId"],
    });
    for (const key of ["stepId", "capabilityId", "commandId", "tool", "confirmedSnapshotId"]) {
      assertRequiredString(effect[key], `${label}.${key}`);
    }
    assertEnum(effect.executionState, ["observed-succeeded"], `${label}.executionState`);
  });
  if (snapshot.latestFactsRef !== null) {
    assertRequiredString(snapshot.latestFactsRef, "metadata.task.snapshot.latestFactsRef");
  }
  assertEnum(snapshot.cancellationState, ["none", "requested", "cancelled"], "metadata.task.snapshot.cancellationState");
  assertIsoTimestamp(snapshot.updatedAt, "metadata.task.snapshot.updatedAt");
}

function validatePresentationMetadata(value) {
  assertShape(value, "metadata.presentation", {
    optional: ["responseSource", "taskStatus", "outcomeStatus", "resultStatus", "resultRef"],
  });
  for (const key of ["responseSource", "taskStatus", "outcomeStatus", "resultStatus", "resultRef"]) {
    if (Object.hasOwn(value, key)) assertRequiredString(value[key], `metadata.presentation.${key}`);
  }
}

function validateDeveloperScenarioMetadata(value) {
  assertShape(value, "metadata.developerScenario", {
    optional: ["scenarioId", "source", "simulatorMode", "capturedAtMode", "stagedAt", "capturedAt"],
  });
  for (const key of ["scenarioId", "source", "simulatorMode", "capturedAtMode", "stagedAt", "capturedAt"]) {
    if (Object.hasOwn(value, key)) assertRequiredString(value[key], `metadata.developerScenario.${key}`);
  }
}

function validateKnowledgeMetadata(value, { phase, runId }) {
  if (phase === "knowledge-delegation") {
    assertShape(value, "metadata.knowledge", { required: ["delegationId", "delegation"] });
    assertRequiredString(value.delegationId, "metadata.knowledge.delegationId");
    validateKnowledgeDelegation(value.delegation, { runId, delegationId: value.delegationId });
    return;
  }
  if (["knowledge-plan-model", "knowledge-answer-model"].includes(phase)) {
    assertShape(value, "metadata.knowledge", { required: ["delegationId"] });
    assertRequiredString(value.delegationId, "metadata.knowledge.delegationId");
    return;
  }
  if (phase === "knowledge-subplanning") {
    assertShape(value, "metadata.knowledge", {
      required: ["delegationId", "validation"],
      optional: ["subplanId", "subplan", "clarificationRequest"],
    });
    assertRequiredString(value.delegationId, "metadata.knowledge.delegationId");
    assertShape(value.validation, "metadata.knowledge.validation", { required: ["ok"] });
    assertBoolean(value.validation.ok, "metadata.knowledge.validation.ok");
    if (Object.hasOwn(value, "subplan")) {
      assertRequiredString(value.subplanId, "metadata.knowledge.subplanId");
      validateKnowledgeSubplan(value.subplan, {
        runId,
        delegationId: value.delegationId,
        subplanId: value.subplanId,
      });
    } else if (Object.hasOwn(value, "subplanId")) {
      throw new TypeError("metadata.knowledge.subplanId requires subplan");
    }
    if (Object.hasOwn(value, "clarificationRequest")) {
      validateKnowledgeClarification(value.clarificationRequest, { runId, delegationId: value.delegationId });
    }
    return;
  }
  if (["clarification", "final-synthesis"].includes(phase)) {
    assertShape(value, "metadata.knowledge", {
      required: ["delegationId", "outcomeStatus"],
      optional: ["clarificationRequest", "limitations"],
    });
    assertRequiredString(value.delegationId, "metadata.knowledge.delegationId");
    assertEnum(value.outcomeStatus, ["answered", "clarification", "not-applicable", "unavailable"], "metadata.knowledge.outcomeStatus");
    if (Object.hasOwn(value, "clarificationRequest")) {
      validateKnowledgeClarification(value.clarificationRequest, { runId, delegationId: value.delegationId });
    }
    if (Object.hasOwn(value, "limitations")) {
      assertStringArray(value.limitations, "metadata.knowledge.limitations");
    }
    return;
  }

  const commonRequired = [
    "delegationId", "subplanId", "stepId", "capabilityId", "dependsOnEventIds", "outcomeStatus",
  ];
  if (phase === "knowledge-evidence") {
    assertShape(value, "metadata.knowledge", {
      required: [...commonRequired, "retrievalStatus", "evidenceRefs"],
    });
  } else if (phase === "knowledge-state-read") {
    assertShape(value, "metadata.knowledge", {
      required: [...commonRequired, "vehicleStateRefs"],
    });
  } else if (phase === "knowledge-safety-assessment") {
    assertShape(value, "metadata.knowledge", {
      required: commonRequired,
      optional: ["safetyAssessment"],
    });
  } else if (phase === "knowledge-answer") {
    assertShape(value, "metadata.knowledge", {
      required: [...commonRequired, "evidenceRefs", "vehicleStateRefs"],
      optional: ["supportStatus", "safetyAssessment"],
    });
  } else {
    throw new TypeError(`metadata.knowledge is not supported for phase ${phase}`);
  }
  for (const key of ["delegationId", "subplanId", "stepId", "capabilityId", "outcomeStatus"]) {
    assertRequiredString(value[key], `metadata.knowledge.${key}`);
  }
  assertStringArray(value.dependsOnEventIds, "metadata.knowledge.dependsOnEventIds");
  if (Object.hasOwn(value, "retrievalStatus")) {
    assertEnum(value.retrievalStatus, ["hit", "miss", "unavailable"], "metadata.knowledge.retrievalStatus");
  }
  if (Object.hasOwn(value, "evidenceRefs")) validateManualEvidenceRefs(value.evidenceRefs);
  if (Object.hasOwn(value, "vehicleStateRefs")) validateVehicleStateRefs(value.vehicleStateRefs);
  if (Object.hasOwn(value, "supportStatus")) {
    assertEnum(value.supportStatus, ["supported", "partial", "unsupported"], "metadata.knowledge.supportStatus");
  }
  if (Object.hasOwn(value, "safetyAssessment")) {
    validateKnowledgeSafetyAssessment(value.safetyAssessment);
  }
}

function validateKnowledgeDelegation(value, { runId, delegationId }) {
  assertShape(value, "metadata.knowledge.delegation", {
    required: [
      "delegationId", "runId", "parentPlanId", "parentStepId", "knowledgeGoal", "vehicleScope",
      "allowedCapabilities", "allowVehicleStateRead", "requireSafetyEligibilityExplanation",
      "expectedAnswerContract", "dependsOn",
    ],
  });
  for (const key of [
    "delegationId", "runId", "parentPlanId", "parentStepId", "knowledgeGoal", "vehicleScope",
    "expectedAnswerContract",
  ]) {
    assertRequiredString(value[key], `metadata.knowledge.delegation.${key}`);
  }
  if (value.runId !== runId || value.delegationId !== delegationId) {
    throw new TypeError("metadata.knowledge.delegation identity must match event and delegationId");
  }
  assertStringArray(value.allowedCapabilities, "metadata.knowledge.delegation.allowedCapabilities", { nonEmpty: true });
  assertBoolean(value.allowVehicleStateRead, "metadata.knowledge.delegation.allowVehicleStateRead");
  assertBoolean(value.requireSafetyEligibilityExplanation, "metadata.knowledge.delegation.requireSafetyEligibilityExplanation");
  assertStringArray(value.dependsOn, "metadata.knowledge.delegation.dependsOn");
}

function validateKnowledgeSubplan(value, { runId, delegationId, subplanId }) {
  assertShape(value, "metadata.knowledge.subplan", {
    required: [
      "subplanId", "delegationId", "runId", "parentPlanId", "parentStepId",
      "selectedCapabilities", "steps", "planningSummary", "status",
    ],
  });
  for (const key of [
    "subplanId", "delegationId", "runId", "parentPlanId", "parentStepId", "planningSummary", "status",
  ]) {
    assertRequiredString(value[key], `metadata.knowledge.subplan.${key}`);
  }
  if (value.runId !== runId || value.delegationId !== delegationId || value.subplanId !== subplanId) {
    throw new TypeError("metadata.knowledge.subplan identity must match event metadata");
  }
  assertStringArray(value.selectedCapabilities, "metadata.knowledge.subplan.selectedCapabilities");
  assertArray(value.steps, "metadata.knowledge.subplan.steps", (step, index) => {
    const label = `metadata.knowledge.subplan.steps[${index}]`;
    assertShape(step, label, {
      required: ["stepId", "capabilityId", "dependsOn", "accessMode", "status"],
    });
    for (const key of ["stepId", "capabilityId", "accessMode", "status"]) {
      assertRequiredString(step[key], `${label}.${key}`);
    }
    assertStringArray(step.dependsOn, `${label}.dependsOn`);
  });
}

function validateKnowledgeClarification(value, { runId, delegationId }) {
  assertShape(value, "metadata.knowledge.clarificationRequest", {
    required: ["delegationId", "runId", "outcomeStatus", "questions", "reasonCode"],
  });
  for (const key of ["delegationId", "runId", "outcomeStatus", "reasonCode"]) {
    assertRequiredString(value[key], `metadata.knowledge.clarificationRequest.${key}`);
  }
  if (value.runId !== runId || value.delegationId !== delegationId || value.outcomeStatus !== "clarification") {
    throw new TypeError("metadata.knowledge.clarificationRequest identity or outcome is invalid");
  }
  assertStringArray(value.questions, "metadata.knowledge.clarificationRequest.questions", { nonEmpty: true });
}

function validateVehicleStateRefs(value) {
  assertArray(value, "metadata.knowledge.vehicleStateRefs", (ref, index) => {
    const label = `metadata.knowledge.vehicleStateRefs[${index}]`;
    assertShape(ref, label, { required: ["id", "source"] });
    assertRequiredString(ref.id, `${label}.id`);
    assertRequiredString(ref.source, `${label}.source`);
  });
}

function validateKnowledgeSafetyAssessment(value) {
  assertShape(value, "metadata.knowledge.safetyAssessment", {
    required: ["allowed", "action", "reasonCode", "snapshotId", "policyId"],
  });
  assertBoolean(value.allowed, "metadata.knowledge.safetyAssessment.allowed");
  for (const key of ["action", "reasonCode", "snapshotId", "policyId"]) {
    assertString(value[key], `metadata.knowledge.safetyAssessment.${key}`);
  }
}

function validateVehicleMetadata(value, { phase, runId }) {
  if (phase === "vehicle-safety") {
    assertShape(value, "metadata.vehicle", { optional: ["snapshot", "safetyDecision"] });
    if (!Object.hasOwn(value, "snapshot") && !Object.hasOwn(value, "safetyDecision")) {
      throw new TypeError("metadata.vehicle requires snapshot or safetyDecision for vehicle-safety");
    }
  } else if (phase === "vehicle-confirmation") {
    assertShape(value, "metadata.vehicle", { required: ["confirmation"] });
  } else if (phase === "vehicle-execution") {
    assertShape(value, "metadata.vehicle", {
      optional: [
        "toolCall", "toolResult", "commitmentState", "cancellation", "snapshot",
        "confirmedSnapshotId",
      ],
    });
    if (Object.keys(value).length === 0) throw new TypeError("metadata.vehicle execution facts are required");
  } else if (phase === "capability-execution") {
    assertShape(value, "metadata.vehicle", { required: ["snapshot", "stateFields"] });
  } else if (phase === "final-response") {
    assertShape(value, "metadata.vehicle", {
      optional: ["toolResult", "snapshot", "confirmedSnapshotId", "cancellation"],
    });
  } else {
    throw new TypeError(`metadata.vehicle is not supported for phase ${phase}`);
  }

  if (Object.hasOwn(value, "snapshot")) validateVehicleSnapshot(value.snapshot);
  if (Object.hasOwn(value, "safetyDecision")) validateVehicleSafetyDecision(value.safetyDecision, runId);
  if (Object.hasOwn(value, "confirmation")) validateVehicleConfirmation(value.confirmation);
  if (Object.hasOwn(value, "toolCall")) validateVehicleToolCall(value.toolCall, runId);
  if (Object.hasOwn(value, "toolResult")) validateVehicleToolResult(value.toolResult, runId);
  if (Object.hasOwn(value, "commitmentState")) {
    assertEnum(value.commitmentState, ["dispatching", "pre-dispatch", "provider-terminal"], "metadata.vehicle.commitmentState");
  }
  if (Object.hasOwn(value, "cancellation")) validateCancellation(value.cancellation);
  if (Object.hasOwn(value, "confirmedSnapshotId")) {
    assertRequiredString(value.confirmedSnapshotId, "metadata.vehicle.confirmedSnapshotId");
    if (value.snapshot?.id !== value.confirmedSnapshotId) {
      throw new TypeError("metadata.vehicle.confirmedSnapshotId must match snapshot.id");
    }
  }
  if (Object.hasOwn(value, "stateFields")) {
    assertStringArray(value.stateFields, "metadata.vehicle.stateFields", { nonEmpty: true });
  }
}

function validateVehicleSnapshot(value) {
  assertShape(value, "metadata.vehicle.snapshot", {
    required: ["id", "simulated"],
    optional: ["source", "capturedAt"],
  });
  assertRequiredString(value.id, "metadata.vehicle.snapshot.id");
  assertBoolean(value.simulated, "metadata.vehicle.snapshot.simulated");
  if (Object.hasOwn(value, "source")) assertRequiredString(value.source, "metadata.vehicle.snapshot.source");
  if (Object.hasOwn(value, "capturedAt")) assertIsoTimestamp(value.capturedAt, "metadata.vehicle.snapshot.capturedAt");
}

function validateVehicleSafetyDecision(value, runId) {
  assertShape(value, "metadata.vehicle.safetyDecision", {
    required: [
      "requestId", "allowed", "action", "reasonCode", "safeIntent", "snapshotId", "policyId", "version",
    ],
  });
  assertRequiredString(value.requestId, "metadata.vehicle.safetyDecision.requestId");
  if (value.requestId !== runId) throw new TypeError("metadata.vehicle.safetyDecision.requestId must match runId");
  assertBoolean(value.allowed, "metadata.vehicle.safetyDecision.allowed");
  assertEnum(value.action, ["allow", "clamp", "reject", "require_confirmation", "unavailable"], "metadata.vehicle.safetyDecision.action");
  for (const key of ["reasonCode", "safeIntent", "snapshotId", "policyId", "version"]) {
    assertString(value[key], `metadata.vehicle.safetyDecision.${key}`);
  }
}

function validateVehicleConfirmation(value) {
  if (hasExactKeys(value, ["challengeId", "valid"])) {
    assertString(value.challengeId, "metadata.vehicle.confirmation.challengeId");
    assertBoolean(value.valid, "metadata.vehicle.confirmation.valid");
    return;
  }
  assertShape(value, "metadata.vehicle.confirmation", {
    required: [
      "challengeId", "actionDigest", "policyId", "policyVersion", "assertions",
      "issuedAt", "expiresAt", "valid",
    ],
  });
  for (const key of ["challengeId", "actionDigest", "policyId", "policyVersion"]) {
    assertRequiredString(value[key], `metadata.vehicle.confirmation.${key}`);
  }
  assertArray(value.assertions, "metadata.vehicle.confirmation.assertions", (assertion, index) => {
    const label = `metadata.vehicle.confirmation.assertions[${index}]`;
    assertShape(assertion, label, { required: ["id"] });
    assertRequiredString(assertion.id, `${label}.id`);
  });
  assertIsoTimestamp(value.issuedAt, "metadata.vehicle.confirmation.issuedAt");
  assertIsoTimestamp(value.expiresAt, "metadata.vehicle.confirmation.expiresAt");
  assertBoolean(value.valid, "metadata.vehicle.confirmation.valid");
}

function validateVehicleToolCall(value, runId) {
  assertShape(value, "metadata.vehicle.toolCall", {
    required: ["requestId", "commandId", "tool", "args", "argProvenance", "requiresSafety"],
  });
  for (const key of ["requestId", "commandId", "tool"]) {
    assertRequiredString(value[key], `metadata.vehicle.toolCall.${key}`);
  }
  if (value.requestId !== runId) throw new TypeError("metadata.vehicle.toolCall.requestId must match runId");
  validateVehicleArguments(value.args, "metadata.vehicle.toolCall.args", { provenance: false });
  validateVehicleArguments(value.argProvenance, "metadata.vehicle.toolCall.argProvenance", { provenance: true });
  assertBoolean(value.requiresSafety, "metadata.vehicle.toolCall.requiresSafety");
}

function validateVehicleArguments(value, label, { provenance }) {
  assertShape(value, label, {
    optional: [
      "zone", "percent", "antiPinch", "seat", "angle", "temperature", "airflow",
      "passengerMode", "open", "actionId", "value", "seatZone", "seatMode", "level",
      "climatePower", "climateMode", "fanLevel", "windowTargets",
    ],
  });
  for (const [key, item] of Object.entries(value)) {
    if (provenance) {
      assertRequiredString(item, `${label}.${key}`);
    } else if (["percent", "angle", "temperature", "value", "level", "fanLevel"].includes(key)) {
      assertFiniteNumber(item, `${label}.${key}`);
    } else if (["antiPinch", "open", "climatePower"].includes(key)) {
      assertBoolean(item, `${label}.${key}`);
    } else if (key === "windowTargets") {
      assertArray(item, `${label}.windowTargets`, (target, index) => {
        const targetLabel = `${label}.windowTargets[${index}]`;
        assertShape(target, targetLabel, { required: ["zone", "percent"] });
        assertRequiredString(target.zone, `${targetLabel}.zone`);
        if (!["front_left", "front_right", "rear_left", "rear_right"].includes(target.zone)) {
          throw new TypeError(`${targetLabel}.zone is invalid`);
        }
        assertFiniteNumber(target.percent, `${targetLabel}.percent`);
        if (target.percent < 0 || target.percent > 100) throw new TypeError(`${targetLabel}.percent is out of range`);
      });
    } else {
      assertRequiredString(item, `${label}.${key}`);
    }
  }
}

function validateVehicleToolResult(value, runId) {
  assertShape(value, "metadata.vehicle.toolResult", {
    required: [
      "requestId", "commandId", "tool", "ok", "executionState", "requestedState",
      "executionTrace", "simulated",
    ],
    optional: [
      "visualScenario", "source", "timestamp", "confirmedSnapshotId", "executionError",
    ],
  });
  for (const key of ["requestId", "commandId", "tool", "executionState"]) {
    assertRequiredString(value[key], `metadata.vehicle.toolResult.${key}`);
  }
  if (value.requestId !== runId) throw new TypeError("metadata.vehicle.toolResult.requestId must match runId");
  assertBoolean(value.ok, "metadata.vehicle.toolResult.ok");
  validateRequestedVehicleState(value.requestedState);
  assertArray(value.executionTrace, "metadata.vehicle.toolResult.executionTrace", (entry, index) => {
    const label = `metadata.vehicle.toolResult.executionTrace[${index}]`;
    assertShape(entry, label, { required: ["state", "source", "at"] });
    assertRequiredString(entry.state, `${label}.state`);
    assertRequiredString(entry.source, `${label}.source`);
    assertIsoTimestamp(entry.at, `${label}.at`);
  });
  assertBoolean(value.simulated, "metadata.vehicle.toolResult.simulated");
  for (const key of ["visualScenario", "source", "confirmedSnapshotId"]) {
    if (Object.hasOwn(value, key)) assertRequiredString(value[key], `metadata.vehicle.toolResult.${key}`);
  }
  if (Object.hasOwn(value, "timestamp")) assertIsoTimestamp(value.timestamp, "metadata.vehicle.toolResult.timestamp");
  if (Object.hasOwn(value, "executionError")) validateExecutionError(value.executionError, "metadata.vehicle.toolResult.executionError");
}

function validateRequestedVehicleState(value) {
  assertShape(value, "metadata.vehicle.toolResult.requestedState", {
    optional: [
      "windowPositionPercentByZone", "vehicleLocked", "tailgateOpen", "driverBackrestAngle", "cabinTemperature",
      "airflow", "passengerMode", "componentActionStateById", "seatComfortByZone",
      "climatePower", "climateMode", "fanLevel",
    ],
  });
  if (Object.hasOwn(value, "windowPositionPercentByZone")) {
    const positions = value.windowPositionPercentByZone;
    assertShape(positions, "metadata.vehicle.toolResult.requestedState.windowPositionPercentByZone", {
      optional: ["front_left", "front_right", "rear_left", "rear_right"],
    });
    for (const [zone, position] of Object.entries(positions)) {
      assertFiniteNumber(position, `metadata.vehicle.toolResult.requestedState.windowPositionPercentByZone.${zone}`);
    }
  }
  if (Object.hasOwn(value, "tailgateOpen")) assertBoolean(value.tailgateOpen, "metadata.vehicle.toolResult.requestedState.tailgateOpen");
  if (Object.hasOwn(value, "vehicleLocked")) assertBoolean(value.vehicleLocked, "metadata.vehicle.toolResult.requestedState.vehicleLocked");
  for (const key of ["driverBackrestAngle", "cabinTemperature", "fanLevel"]) {
    if (Object.hasOwn(value, key)) assertFiniteNumber(value[key], `metadata.vehicle.toolResult.requestedState.${key}`);
  }
  for (const key of ["airflow", "passengerMode", "climateMode"]) {
    if (Object.hasOwn(value, key)) assertRequiredString(value[key], `metadata.vehicle.toolResult.requestedState.${key}`);
  }
  if (Object.hasOwn(value, "climatePower")) assertBoolean(value.climatePower, "metadata.vehicle.toolResult.requestedState.climatePower");
  if (Object.hasOwn(value, "seatComfortByZone")) {
    assertShape(value.seatComfortByZone, "metadata.vehicle.toolResult.requestedState.seatComfortByZone");
    for (const [zone, setting] of Object.entries(value.seatComfortByZone)) {
      const label = `metadata.vehicle.toolResult.requestedState.seatComfortByZone.${zone}`;
      if (!["driver", "passenger", "row2_left", "row2_right", "row3_left", "row3_right"].includes(zone)) {
        throw new TypeError(`${label} has an invalid seat zone`);
      }
      assertShape(setting, label, { required: ["mode", "level"] });
      if (!["off", "heat", "ventilation"].includes(setting.mode)) throw new TypeError(`${label}.mode is invalid`);
      if (!Number.isInteger(setting.level) || setting.level < 0 || setting.level > 3) throw new TypeError(`${label}.level is invalid`);
    }
  }
  if (Object.hasOwn(value, "componentActionStateById")
    && normalizeEs7ComponentActionStateById(value.componentActionStateById) === null) {
    throw new TypeError("metadata.vehicle.toolResult.requestedState.componentActionStateById must contain registered ES7 action values");
  }
}

function validateCancellation(value) {
  assertShape(value, "metadata.vehicle.cancellation", {
    required: ["requested", "physicalUndoClaimed"],
  });
  assertBoolean(value.requested, "metadata.vehicle.cancellation.requested");
  assertBoolean(value.physicalUndoClaimed, "metadata.vehicle.cancellation.physicalUndoClaimed");
}

function validateExternalMetadata(value, { runId }) {
  assertShape(value, "metadata.external", {
    required: ["toolCall"],
    optional: ["toolResult", "evidenceRefs", "responseSource"],
  });
  validateExternalToolCall(value.toolCall, runId);
  if (Object.hasOwn(value, "toolResult")) {
    validateExternalToolResult(value.toolResult, runId);
    for (const key of ["requestId", "commandId", "tool"]) {
      if (value.toolResult[key] !== value.toolCall[key]) {
        throw new TypeError(`metadata.external Tool identity mismatch: ${key}`);
      }
    }
  }
  if (Object.hasOwn(value, "evidenceRefs")) validateExternalEvidenceRefs(value.evidenceRefs);
  if (Object.hasOwn(value, "responseSource")) {
    assertRequiredString(value.responseSource, "metadata.external.responseSource");
  }
}

function validateExternalToolCall(value, runId) {
  assertShape(value, "metadata.external.toolCall", {
    required: ["requestId", "commandId", "tool", "args"],
  });
  for (const key of ["requestId", "commandId", "tool"]) {
    assertRequiredString(value[key], `metadata.external.toolCall.${key}`);
  }
  if (value.requestId !== runId) throw new TypeError("metadata.external.toolCall.requestId must match runId");
  assertShape(value.args, "metadata.external.toolCall.args", {
    required: ["topic", "externalDataType"],
  });
  assertRequiredString(value.args.topic, "metadata.external.toolCall.args.topic");
  assertRequiredString(value.args.externalDataType, "metadata.external.toolCall.args.externalDataType");
}

function validateExternalToolResult(value, runId) {
  assertShape(value, "metadata.external.toolResult", {
    required: ["requestId", "commandId", "tool", "ok", "executionState", "simulated", "source"],
    optional: ["timestamp", "executionError", "locationClarification"],
  });
  for (const key of ["requestId", "commandId", "tool", "executionState", "source"]) {
    assertRequiredString(value[key], `metadata.external.toolResult.${key}`);
  }
  if (value.requestId !== runId) throw new TypeError("metadata.external.toolResult.requestId must match runId");
  assertBoolean(value.ok, "metadata.external.toolResult.ok");
  assertBoolean(value.simulated, "metadata.external.toolResult.simulated");
  if (Object.hasOwn(value, "timestamp")) assertIsoTimestamp(value.timestamp, "metadata.external.toolResult.timestamp");
  if (Object.hasOwn(value, "executionError")) validateExecutionError(value.executionError, "metadata.external.toolResult.executionError");
  if (Object.hasOwn(value, "locationClarification")) validateLocationClarification(value.locationClarification);
}

function validateExecutionError(value, label) {
  assertShape(value, label, { required: ["code", "stage", "retryable"] });
  assertRequiredString(value.code, `${label}.code`);
  assertRequiredString(value.stage, `${label}.stage`);
  assertBoolean(value.retryable, `${label}.retryable`);
}

function validateLocationClarification(value) {
  assertShape(value, "metadata.external.toolResult.locationClarification", {
    required: ["policy", "code"],
    optional: ["reference", "candidates"],
  });
  assertRequiredString(value.policy, "metadata.external.toolResult.locationClarification.policy");
  assertRequiredString(value.code, "metadata.external.toolResult.locationClarification.code");
  if (Object.hasOwn(value, "reference")) {
    assertRequiredString(value.reference, "metadata.external.toolResult.locationClarification.reference");
  }
  if (Object.hasOwn(value, "candidates")) {
    assertArray(value.candidates, "metadata.external.toolResult.locationClarification.candidates", (candidate, index) => {
      const label = `metadata.external.toolResult.locationClarification.candidates[${index}]`;
      assertShape(candidate, label, { optional: ["city", "admin1", "country"] });
      if (Object.keys(candidate).length === 0) throw new TypeError(`${label} must identify a location`);
      for (const [key, item] of Object.entries(candidate)) assertRequiredString(item, `${label}.${key}`);
    });
  }
}

function validateExternalEvidenceRefs(value) {
  assertArray(value, "metadata.external.evidenceRefs", (ref, index) => {
    const label = `metadata.external.evidenceRefs[${index}]`;
    assertShape(ref, label, {
      required: ["id", "source", "type"],
      optional: ["title", "citation"],
    });
    for (const key of ["id", "source", "type"]) assertRequiredString(ref[key], `${label}.${key}`);
    for (const key of ["title", "citation"]) {
      if (Object.hasOwn(ref, key)) assertRequiredString(ref[key], `${label}.${key}`);
    }
  });
}

function assertShape(value, label, { required = [], optional = [] } = {}) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length) throw new TypeError(`${label} contains unexpected key: ${unknown.join(", ")}`);
  if (missing.length) throw new TypeError(`${label} is missing required key: ${missing.join(", ")}`);
}

function assertString(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
}

function assertRequiredString(value, label) {
  if (!requiredText(value)) throw new TypeError(`${label} must be a non-empty string`);
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
}

function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new TypeError(`${label} has an unsupported value`);
}

function assertStringArray(value, label, { nonEmpty = false } = {}) {
  assertArray(value, label, (item, index) => assertRequiredString(item, `${label}[${index}]`));
  if (nonEmpty && value.length === 0) throw new TypeError(`${label} must not be empty`);
}

function assertArray(value, label, validateItem) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  value.forEach(validateItem);
}

function assertIsoTimestamp(value, label) {
  if (!isIsoTimestamp(value)) throw new TypeError(`${label} must be an ISO timestamp`);
}

function cloneMetadata(metadata, phase, runId) {
  validateMetadata(metadata, phase, runId);
  return deepCloneAndFreeze(metadata);
}

function validatePlainData(root) {
  const seen = new WeakSet();
  let nodes = 0;
  const visit = (value, depth, key = "metadata") => {
    nodes += 1;
    if (nodes > MAX_METADATA_NODES) throw new TypeError("metadata exceeds node limit");
    if (depth > MAX_METADATA_DEPTH) throw new TypeError("metadata exceeds depth limit");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError(`metadata ${key} must be finite`);
      return;
    }
    if (typeof value !== "object") throw new TypeError(`metadata ${key} contains a non-plain value`);
    if (seen.has(value)) throw new TypeError("metadata contains a cycle");
    seen.add(value);
    if (!Array.isArray(value) && !isPlainRecord(value)) throw new TypeError(`metadata ${key} must be plain data`);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, key);
      return;
    }
    for (const [childKey, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.get || descriptor.set) throw new TypeError(`metadata ${childKey} must not use accessors`);
      if (SENSITIVE_KEYS.has(normalizeKey(childKey))) throw new TypeError(`sensitive metadata key is forbidden: ${childKey}`);
      visit(descriptor.value, depth + 1, childKey);
    }
  };
  visit(root, 0);
}

function validateExactInteractionRef(value) {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["sessionId", "turnId"])) {
    throw new TypeError("interactionRef requires sessionId and turnId");
  }
  createInteractionRef(value);
}

function validateVoiceBridgeEligibility(value, runId) {
  const fields = ["allowed", "noToolOrSafetyPath", "requestId", "reason", "policyId", "policyVersion"];
  if (!isPlainRecord(value) || !hasExactKeys(value, fields)) throw new TypeError("voiceBridgeEligibility has an invalid shape");
  if (typeof value.allowed !== "boolean" || typeof value.noToolOrSafetyPath !== "boolean") throw new TypeError("voiceBridgeEligibility booleans are required");
  for (const field of ["requestId", "reason", "policyId", "policyVersion"]) {
    if (!requiredText(value[field])) throw new TypeError(`voiceBridgeEligibility.${field} is required`);
  }
  if (value.requestId !== runId) throw new TypeError("voiceBridgeEligibility.requestId must match runId");
}

function validateManualEvidenceRefs(refs) {
  if (!Array.isArray(refs)) throw new TypeError("knowledge evidenceRefs must be an array");
  for (const ref of refs) {
    const fields = ["sourceId", "sourceVersion", "chunkId", "pageStart", "pageEnd", "excerpt", "score"];
    if (!isPlainRecord(ref) || !hasExactKeys(ref, fields)) throw new TypeError("knowledge evidenceRef has unknown or missing fields");
    for (const field of ["sourceId", "sourceVersion", "chunkId", "excerpt"]) {
      if (!requiredText(ref[field])) throw new TypeError(`knowledge evidenceRef.${field} is required`);
    }
    if (!Number.isInteger(ref.pageStart) || !Number.isInteger(ref.pageEnd)) throw new TypeError("knowledge evidenceRef pages must be integers");
    if (!isPlainRecord(ref.score) || !hasExactKeys(ref.score, ["retrieval", "rerank", "grounding"])) throw new TypeError("knowledge evidenceRef score is invalid");
    if (!Number.isFinite(ref.score.retrieval)
      || (ref.score.rerank !== null && !Number.isFinite(ref.score.rerank))
      || (ref.score.grounding !== null && !Number.isFinite(ref.score.grounding))) {
      throw new TypeError("knowledge evidenceRef scores must be finite or null");
    }
  }
}

function normalizeRefs(value) {
  if (!Array.isArray(value)) throw new TypeError("refs must be an array");
  const refs = [];
  const seen = new Set();
  for (const item of value) {
    const ref = requiredText(item);
    if (!ref || ref.length > 200) throw new TypeError("refs must contain non-empty strings no longer than 200 characters");
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  if (refs.length > 32) throw new TypeError("refs may contain at most 32 entries");
  return Object.freeze(refs);
}

function deepCloneAndFreeze(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const clone = [];
    seen.set(value, clone);
    for (const item of value) clone.push(deepCloneAndFreeze(item, seen));
    return Object.freeze(clone);
  }
  const clone = {};
  seen.set(value, clone);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    clone[key] = deepCloneAndFreeze(descriptor.value, seen);
  }
  return Object.freeze(clone);
}

function knowledgeDelegationId(event) {
  const knowledge = event?.metadata?.knowledge;
  return requiredText(knowledge?.delegationId) || requiredText(knowledge?.delegation?.delegationId);
}

function isKnowledgeStepEvent(event) {
  return ["knowledge-evidence", "knowledge-state-read", "knowledge-safety-assessment", "knowledge-answer"].includes(event?.phase);
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasExactKeys(value, fields) {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[-_.]/g, "");
}

function isIsoTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function requiredText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value) {
  return value == null ? null : requiredText(value);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
