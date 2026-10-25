import assert from "node:assert/strict";
import {
  AI_AGENT_COMPONENT_IDS,
  PARTICIPANT_REGISTRY,
  PARTICIPANT_TYPES,
  getParticipant,
  requireParticipant,
} from "../../src/runtime/participant-registry.js";
import {
  createInteractionRef,
  createRunEvent,
  RUN_EVENT_PHASES,
  RUN_EVENT_PROTOCOL,
  RUN_EVENT_STATUSES,
  validateB3RunEventSequence,
  validateRunEvent,
} from "../../src/runtime/run-event-protocol.js";

const EXACT_KEYS = [
  "protocol", "eventId", "runId", "parentEventId", "sequence", "timestamp",
  "component", "componentType", "phase", "status", "summary", "refs", "model",
  "provider", "durationMs", "metadata",
];
const LEGACY_KEYS = [
  "requestId", "agentId", "message", "participantId", "participantType", "kind",
  "inputSummary", "outputSummary", "evidenceRefs", "data", "decision", "reasonCode",
  "policyVersion", "simulated", "degraded", "confidenceStrength", "privacyLevel",
  "debugPayloadRef",
];

assert.deepEqual(AI_AGENT_COMPONENT_IDS, ["cabinAssistant", "orchestrator"]);
assert.equal(PARTICIPANT_TYPES.AI_AGENT, "ai-agent");
assert.equal(PARTICIPANT_TYPES.MODEL_SERVICE, "model-service");
assert.equal(PARTICIPANT_TYPES.DETERMINISTIC_SERVICE, "deterministic-service");
assert.equal(PARTICIPANT_TYPES.TOOL_INTERFACE, "tool-interface");
assert.equal(PARTICIPANT_TYPES.PRESENTATION, "presentation");
assert.deepEqual(
  Object.values(PARTICIPANT_REGISTRY)
    .filter(({ type }) => type === PARTICIPANT_TYPES.AI_AGENT)
    .map(({ id }) => id),
  ["cabinAssistant", "orchestrator"],
);
for (const id of ["vehicleSluModel", "cabinModel", "orchestratorModel", "ragEmbeddingModel", "ragRerankModel"]) {
  assert.equal(requireParticipant(id).type, "model-service", id);
}
for (const id of [
  "runtimeKernel", "manualQueryPlanner", "manualRetriever", "conversationMemory", "safety",
  "vehicleStateProvider", "confirmation", "voiceBridgeEligibility", "wakeWordProvider",
  "interactionSession", "recoveryPolicy",
]) {
  assert.equal(requireParticipant(id).type, "deterministic-service", id);
}
assert.equal(requireParticipant("vehicleTool").type, "tool-interface");
assert.equal(requireParticipant("externalDataAdapter").type, "tool-interface");
assert.equal(requireParticipant("responsePresentation").type, "presentation");
for (const legacyId of [
  "edgeRuntime", "edgeSlm", "conversation", "cloudPrompt", "cloudLlm", "vehicleApi", "toolRag", "response",
]) assert.equal(getParticipant(legacyId), null, legacyId);
assert.throws(() => requireParticipant("unknown"), /unregistered component/i);

assert.deepEqual(RUN_EVENT_PROTOCOL, { id: "nio-run-event", version: "2.0.0" });
assert.deepEqual(RUN_EVENT_STATUSES, [
  "queued", "processing", "awaiting_clarification", "completed", "cancelled",
  "safety_rejected", "unavailable", "failed", "uncertain",
]);
assert.deepEqual(RUN_EVENT_PHASES, [
  "developer-scenario", "intake", "route-decision", "voice-bridge-eligibility",
  "goal-formation", "clarification", "task-planning", "plan-validation",
  "capability-execution", "execution-facts", "final-synthesis", "chat-response",
  "final-response", "task-snapshot", "external-query", "vehicle-safety",
  "vehicle-confirmation", "vehicle-execution", "knowledge-delegation",
  "knowledge-subplanning", "knowledge-plan-model", "knowledge-evidence",
  "knowledge-state-read", "knowledge-safety-assessment", "knowledge-answer-model",
  "knowledge-answer",
]);

const base = {
  eventId: "event:run-1:1",
  runId: "run-1",
  parentEventId: null,
  sequence: 1,
  timestamp: "2026-08-08T00:00:00.000Z",
  component: "safety",
  phase: "vehicle-safety",
  status: "completed",
  summary: "Safety 已完成车辆动作审计。",
  refs: ["snapshot:1", "policy:vehicle-safety@1"],
  model: null,
  provider: null,
  durationMs: 4,
  metadata: {
    reasonCode: "allowed",
    policyVersion: "vehicle-safety@1",
    simulated: true,
    vehicle: {
      snapshot: { id: "snapshot:1", source: "demo-sensor", simulated: true, capturedAt: "2026-08-08T00:00:00.000Z" },
      safetyDecision: {
        requestId: "run-1", allowed: true, action: "allow", reasonCode: "allowed",
        safeIntent: "body.window.setPosition", snapshotId: "snapshot:1",
        policyId: "vehicle-safety", version: "1",
      },
    },
  },
};
const event = createRunEvent(base);
assert.deepEqual(Object.keys(event), EXACT_KEYS);
assert.equal(event.componentType, "deterministic-service");
assert.deepEqual(validateRunEvent(event), []);
assert.ok(Object.isFrozen(event));
assert.ok(Object.isFrozen(event.protocol));
assert.ok(Object.isFrozen(event.refs));
assert.ok(Object.isFrozen(event.metadata));
assert.ok(Object.isFrozen(event.metadata.vehicle));
assert.ok(Object.isFrozen(event.metadata.vehicle.snapshot));
assert.deepEqual(event.refs, ["snapshot:1", "policy:vehicle-safety@1"]);
for (const key of LEGACY_KEYS) assert.equal(Object.hasOwn(event, key), false, key);
assert.match(
  validateRunEvent({
    ...event,
    protocol: { id: "nio-run-event", version: "2.0.0", extra: true },
  }).join("; "),
  /protocol.*exact|protocol.*unknown|protocol.*shape/i,
);

assert.throws(
  () => createRunEvent({ ...base, componentType: "ai-agent" }),
  /componentType.*registry|componentType.*match/i,
);
assert.throws(
  () => createRunEvent({ ...base, protocol: { id: "nio-run-event", version: "1.0.0" } }),
  /protocol.*2\.0\.0|protocol.*match/i,
);

const refs = ["ref:a", "ref:a", " ref:b "];
const copiedRefs = createRunEvent({ ...base, refs }).refs;
refs.push("ref:mutated");
assert.deepEqual(copiedRefs, ["ref:a", "ref:b"]);
for (const invalid of ["", " ", 7, {}, null]) {
  assert.throws(() => createRunEvent({ ...base, refs: [invalid] }), /refs/i);
}

for (const key of LEGACY_KEYS) {
  assert.throws(() => createRunEvent({ ...base, [key]: "legacy" }), /unknown|legacy|top-level/i, key);
}
assert.throws(() => createRunEvent({ ...base, extra: true }), /unknown.*top-level/i);
assert.throws(() => createRunEvent({ ...base, status: "done" }), /status/i);
assert.throws(() => createRunEvent({ ...base, phase: "safety" }), /phase/i);
assert.throws(() => createRunEvent({ ...base, component: "missing" }), /unregistered component/i);
assert.throws(() => createRunEvent({ ...base, sequence: 0 }), /sequence/i);
assert.throws(() => createRunEvent({ ...base, timestamp: "today" }), /timestamp/i);
assert.throws(() => createRunEvent({ ...base, durationMs: Number.POSITIVE_INFINITY }), /durationMs|finite/i);
assert.throws(() => createRunEvent({ ...base, metadata: { unknown: true } }), /metadata/i);
for (const [component, phase, group, value] of [
  ["runtimeKernel", "route-decision", "routing", { routeId: "chat", unexpected: true }],
  ["cabinModel", "chat-response", "modelTelemetry", { revision: "1", unexpected: true }],
  ["responsePresentation", "task-snapshot", "task", { snapshot: { unexpected: true } }],
  ["runtimeKernel", "knowledge-delegation", "knowledge", { delegationId: "d", unexpected: true }],
  ["vehicleTool", "vehicle-execution", "vehicle", { commitmentState: "dispatching", unexpected: true }],
  ["externalDataAdapter", "external-query", "external", { responseSource: "fixture", unexpected: true }],
  ["cabinAssistant", "final-response", "presentation", { outcomeStatus: "answered", unexpected: true }],
  ["vehicleStateProvider", "developer-scenario", "developerScenario", { scenarioId: "s", unexpected: true }],
]) {
  assert.throws(() => createRunEvent({
    ...base,
    component,
    phase,
    metadata: { [group]: value },
  }), /metadata.*unexpected|unknown.*metadata/i, group);
}
{
  const withResultStatus = createRunEvent({
    ...base,
    component: "cabinAssistant",
    phase: "final-response",
    metadata: {
      presentation: { outcomeStatus: "answered", resultStatus: "completed" },
    },
  });
  assert.equal(validateRunEvent(withResultStatus).length, 0,
    "final-response presentation must accept a normalized resultStatus");
}
assert.throws(() => createRunEvent({ ...base, metadata: { vehicle: new Map() } }), /plain|metadata/i);
assert.throws(() => createRunEvent({ ...base, metadata: { vehicle: { value: Number.NaN } } }), /finite|metadata/i);
const cyclic = {};
cyclic.self = cyclic;
assert.throws(() => createRunEvent({ ...base, metadata: { vehicle: cyclic } }), /cycle|cyclic/i);

for (const [label, vehicle] of [
  ["Safety facts reject wrong primitive types", {
    safetyDecision: { allowed: "yes", action: 99, requestId: [] },
  }],
  ["Safety facts reject legal keys at the wrong nesting position", {
    toolCall: { safetyDecision: { allowed: true } },
  }],
  ["Safety facts reject arrays in object positions", { safetyDecision: [] }],
]) {
  assert.throws(
    () => createRunEvent({ ...base, metadata: { vehicle } }),
    /metadata|vehicle|safetyDecision|type|shape/i,
    label,
  );
}
for (const [label, component, phase, metadata] of [
  ["modelTelemetry type", "cabinModel", "chat-response", {
    modelTelemetry: { revision: [] },
  }],
  ["task nested type", "responsePresentation", "task-snapshot", {
    task: { snapshot: { status: [] } },
  }],
  ["knowledge identity type", "runtimeKernel", "knowledge-delegation", {
    knowledge: { delegationId: [] },
  }],
  ["external legal key in wrong position", "externalDataAdapter", "external-query", {
    external: { toolCall: { ok: true } },
  }],
]) {
  assert.throws(
    () => createRunEvent({ ...base, component, phase, metadata }),
    /metadata|type|shape|required|unexpected/i,
    label,
  );
}

for (const key of [
  "prompt", "systemPrompt", "rawOutput", "rawModelResponse", "chainOfThought", "apiKey",
  "api_key", "accessKey", "secretKey", "authorization", "password", "credential",
  "credentials", "accessToken", "refreshToken", "responseToken",
]) {
  assert.throws(
    () => createRunEvent({ ...base, metadata: { vehicle: { nested: [{ [key]: "PRIVATE_SENTINEL" }] } } }),
    /sensitive|forbidden/i,
    key,
  );
}
assert.doesNotThrow(() => createRunEvent({
  ...base,
  component: "cabinModel",
  phase: "chat-response",
  model: "qwen-test",
  provider: "offline-fixture",
  metadata: {
    modelTelemetry: {
      revision: "promptVersion-safe-revision",
      inputTokenCount: 12,
      outputTokenCount: 4,
      structuredRetryCount: 0,
    },
  },
}));

assert.deepEqual(createInteractionRef({ sessionId: " session:1 ", turnId: " turn:1 " }), {
  sessionId: "session:1", turnId: "turn:1",
});
assert.throws(() => createInteractionRef({ sessionId: "session:1", turnId: "" }), /requires/i);

const manualEvidenceRef = {
  sourceId: "nio-es8-owner-manual",
  sourceVersion: "2026.07",
  chunkId: "chunk:tailgate",
  pageStart: 88,
  pageEnd: 89,
  excerpt: "打开尾门前请确认周围空间。",
  score: { retrieval: 0.92, rerank: 0.87, grounding: 0.95 },
};
const evidenceEvent = createRunEvent({
  ...base,
  component: "manualRetriever",
  phase: "knowledge-evidence",
  summary: "用户手册检索完成。",
  refs: ["chunk:tailgate"],
  metadata: {
    knowledge: {
      delegationId: "delegation:k:1",
      subplanId: "subplan:k:1",
      stepId: "manual",
      capabilityId: "knowledge.manual.retrieve",
      dependsOnEventIds: [],
      retrievalStatus: "hit",
      evidenceRefs: [manualEvidenceRef],
      outcomeStatus: "completed",
    },
  },
});
assert.deepEqual(evidenceEvent.metadata.knowledge.evidenceRefs, [manualEvidenceRef]);
assert.deepEqual(Object.keys(evidenceEvent.metadata.knowledge.evidenceRefs[0]), [
  "sourceId", "sourceVersion", "chunkId", "pageStart", "pageEnd", "excerpt", "score",
]);
assert.deepEqual(Object.keys(evidenceEvent.metadata.knowledge.evidenceRefs[0].score), [
  "retrieval", "rerank", "grounding",
]);
assert.ok(Object.isFrozen(evidenceEvent.metadata.knowledge.evidenceRefs[0].score));
assert.throws(() => createRunEvent({
  ...evidenceEvent,
  metadata: { knowledge: { ...evidenceEvent.metadata.knowledge, evidenceRefs: [{ ...manualEvidenceRef, extra: true }] } },
}), /evidence|unknown|unexpected/i);

const delegationId = "delegation:knowledge-run:1";
const subplan = {
  subplanId: "subplan:knowledge-run:1",
  delegationId,
  runId: "knowledge-run",
  parentPlanId: "parent-plan",
  parentStepId: "knowledge",
  selectedCapabilities: [
    "knowledge.manual.retrieve", "knowledge.vehicle-state.read",
    "knowledge.safety.evaluate", "knowledge.answer.synthesize",
  ],
  steps: [
    { stepId: "manual", capabilityId: "knowledge.manual.retrieve", dependsOn: [], accessMode: "read", status: "queued" },
    { stepId: "state", capabilityId: "knowledge.vehicle-state.read", dependsOn: ["manual"], accessMode: "read", status: "queued" },
    { stepId: "safety", capabilityId: "knowledge.safety.evaluate", dependsOn: ["state"], accessMode: "read", status: "queued" },
    { stepId: "answer", capabilityId: "knowledge.answer.synthesize", dependsOn: ["manual", "safety"], accessMode: "read", status: "queued" },
  ],
  planningSummary: "只读知识计划",
  status: "ready",
};
const knowledgeEvent = ({ sequence, component, phase, parentEventId = null, knowledge }) => createRunEvent({
  eventId: `event:knowledge-run:${sequence}`,
  runId: "knowledge-run",
  parentEventId,
  sequence,
  timestamp: `2026-08-08T00:00:0${sequence}.000Z`,
  component,
  phase,
  status: "completed",
  summary: phase,
  refs: [],
  metadata: { knowledge },
});
const delegation = knowledgeEvent({
  sequence: 1,
  component: "orchestrator",
  phase: "knowledge-delegation",
  knowledge: {
    delegationId,
    delegation: {
      delegationId,
      runId: "knowledge-run",
      parentPlanId: "parent-plan",
      parentStepId: "knowledge",
      knowledgeGoal: "验证车辆知识事件",
      vehicleScope: "nio-es8-user-manual-2026",
      allowedCapabilities: [...subplan.selectedCapabilities],
      allowVehicleStateRead: true,
      requireSafetyEligibilityExplanation: true,
      expectedAnswerContract: "knowledge-answer@1",
      dependsOn: [],
    },
  },
});
const subplanning = knowledgeEvent({
  sequence: 2,
  component: "orchestrator",
  phase: "knowledge-subplanning",
  parentEventId: delegation.eventId,
  knowledge: { delegationId, subplanId: subplan.subplanId, subplan, validation: { ok: true } },
});
const manual = knowledgeEvent({
  sequence: 3, component: "manualRetriever", phase: "knowledge-evidence",
  parentEventId: subplanning.eventId,
  knowledge: { delegationId, subplanId: subplan.subplanId, stepId: "manual", capabilityId: "knowledge.manual.retrieve", dependsOnEventIds: [], outcomeStatus: "completed", retrievalStatus: "miss", evidenceRefs: [] },
});
const state = knowledgeEvent({
  sequence: 4, component: "vehicleStateProvider", phase: "knowledge-state-read",
  parentEventId: manual.eventId,
  knowledge: { delegationId, subplanId: subplan.subplanId, stepId: "state", capabilityId: "knowledge.vehicle-state.read", dependsOnEventIds: [manual.eventId], outcomeStatus: "completed", vehicleStateRefs: [{ id: "snapshot:1", source: "sensor-provider" }] },
});
const safety = knowledgeEvent({
  sequence: 5, component: "safety", phase: "knowledge-safety-assessment",
  parentEventId: state.eventId,
  knowledge: { delegationId, subplanId: subplan.subplanId, stepId: "safety", capabilityId: "knowledge.safety.evaluate", dependsOnEventIds: [state.eventId], outcomeStatus: "completed", safetyAssessment: { allowed: true, action: "allow", reasonCode: "safe", snapshotId: "snapshot:1", policyId: "knowledge-safety" } },
});
const answer = knowledgeEvent({
  sequence: 6, component: "cabinAssistant", phase: "knowledge-answer",
  parentEventId: safety.eventId,
  knowledge: { delegationId, subplanId: subplan.subplanId, stepId: "answer", capabilityId: "knowledge.answer.synthesize", dependsOnEventIds: [manual.eventId, safety.eventId], outcomeStatus: "answered", supportStatus: "supported", evidenceRefs: [], vehicleStateRefs: [{ id: "snapshot:1", source: "sensor-provider" }] },
});
const validB3 = [delegation, subplanning, manual, state, safety, answer];
assert.deepEqual(validateB3RunEventSequence(validB3), []);
assert.match(validateB3RunEventSequence([...validB3, { ...delegation, eventId: "event:duplicate-delegation", sequence: 7 }]).join("; "), /at most one/i);
assert.match(validateB3RunEventSequence([...validB3.slice(0, 5), { ...answer, metadata: { knowledge: { ...answer.metadata.knowledge, dependsOnEventIds: [safety.eventId] } } }]).join("; "), /dependsOnEventIds/i);
assert.match(validateB3RunEventSequence([...validB3.slice(0, 4), { ...safety, parentEventId: subplanning.eventId }, answer]).join("; "), /safety.*state/i);
assert.throws(() => knowledgeEvent({
  sequence: 7, component: "manualRetriever", phase: "knowledge-answer",
  parentEventId: safety.eventId,
  knowledge: answer.metadata.knowledge,
}), /knowledge-answer.*cabinAssistant/i);

console.log("run event protocol v2 verification passed");
