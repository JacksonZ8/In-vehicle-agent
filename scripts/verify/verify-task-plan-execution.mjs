import assert from "node:assert/strict";
import { createTaskPlan } from "../../src/agents/agent-contracts.js";
import {
  createKnowledgeDelegation,
  createKnowledgeSubplan,
} from "../../src/application/contracts/vehicle-knowledge.js";
import {
  createKnowledgeSubplanExecution,
  createTaskPlanExecution,
} from "../../src/runtime/task-plan-execution.js";
import { buildResponseSynthesisPrompt } from "../../src/runtime/cloud-llm-adapter.js";

function step(stepId, capabilityId, dependsOn = [], accessMode = "read") {
  return {
    stepId,
    capabilityId,
    dependsOn,
    input: {},
    expectedOutput: "capability-result",
    accessMode,
    status: "planned",
  };
}

function plan(steps) {
  return createTaskPlan({
    planId: "plan:run-ledger",
    goalId: "goal:run-ledger",
    runId: "run-ledger",
    steps,
    selectedCapabilities: steps.map((item) => item.capabilityId),
    writeActionCount: steps.filter((item) => item.accessMode === "write").length,
    planningSummary: "验证任务执行顺序。",
    model: "qwen2.5:7b",
    provider: "ollama",
    status: "planned",
  });
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const item of Object.values(value)) assertDeepFrozen(item);
}

function assertNoForbiddenKeys(value) {
  const forbidden = new Set([
    "requestedState",
    "adapterAcceptance",
    "rawModelResponse",
    "rawPrompt",
    "chainOfThought",
    "token",
    "tokens",
    "arguments",
    "args",
    "toolCall",
    "output",
    "providerInternals",
    "providerMetadata",
  ]);
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `forbidden execution field leaked: ${key}`);
    assertNoForbiddenKeys(item);
  }
}

const taskPlan = plan([
  step("safety", "safety.evaluate"),
  step("window", "vehicle.window.set-position", ["safety"], "write"),
  step("response", "response.synthesize", ["window"]),
]);
const execution = createTaskPlanExecution(taskPlan);

const shallowPlan = Object.freeze(structuredClone(taskPlan));
const isolatedExecution = createTaskPlanExecution(shallowPlan);
shallowPlan.steps[1].dependsOn.length = 0;
shallowPlan.steps[1].accessMode = "read";
assert.equal(isolatedExecution.getWriteStep().stepId, "window");
assert.deepEqual(isolatedExecution.canExecute("window"), {
  allowed: false,
  reasonCode: "dependency-pending",
});

assertDeepFrozen(execution.findByCapability("safety.evaluate"));
assert.equal(execution.findByCapability("missing"), null);
assert.equal(execution.getWriteStep().stepId, "window");
assertDeepFrozen(execution.getWriteStep());
assert.deepEqual(execution.canExecute("missing"), {
  allowed: false,
  reasonCode: "unknown-step",
});
assert.deepEqual(execution.canExecute("window"), {
  allowed: false,
  reasonCode: "dependency-pending",
});
assertDeepFrozen(execution.canExecute("window"));
assert.throws(() => execution.start("missing"), /unknown-step/);
assert.throws(() => execution.start("window"), /dependency-pending/);

const safetyRunning = execution.start("safety");
assert.equal(safetyRunning.status, "running");
assertDeepFrozen(safetyRunning);
assert.throws(() => execution.start("safety"), /terminal|duplicate|running/);
execution.complete("safety", {
  safetyDecision: { allowed: false, action: "reject", reason: "unsafe" },
  rawModelResponse: "must-not-retain",
});
assert.deepEqual(execution.canExecute("window"), {
  allowed: false,
  reasonCode: "safety-rejected",
});
execution.blockSafetyRejected("window");
assert.deepEqual(execution.canExecute("response"), {
  allowed: true,
  reasonCode: "ready",
});
execution.start("response");
execution.complete("response", { summary: "Safety rejection response" });
const safetyRejectedFacts = execution.buildExecutionFacts({
  degraded: false,
  failureReason: "",
  completionStatus: "completed",
});
assert.equal(safetyRejectedFacts.completionStatus, "completed");
assert.equal(safetyRejectedFacts.degraded, false);
assert.equal(safetyRejectedFacts.failureReason, "");
assert.equal(safetyRejectedFacts.toolResult, null);
assert.equal(safetyRejectedFacts.confirmedVehicleState, null);
assert.deepEqual(
  safetyRejectedFacts.stepResults.map(({ capabilityId, status, failureReason }) => ({
    capabilityId,
    status,
    failureReason,
  })),
  [
    { capabilityId: "safety.evaluate", status: "completed", failureReason: undefined },
    { capabilityId: "vehicle.window.set-position", status: "blocked", failureReason: "safety-rejected" },
    { capabilityId: "response.synthesize", status: "completed", failureReason: undefined },
  ],
);
assert.throws(() => execution.complete("safety", {}), /terminal/);
assert.throws(() => execution.fail("safety", "late failure"), /terminal/);
assertNoForbiddenKeys(execution.snapshot());

const transitiveSafety = createTaskPlanExecution(plan([
  step("safety", "safety.evaluate"),
  step("confirmation", "confirmation.issue", ["safety"]),
  step("window", "vehicle.window.set-position", ["confirmation"], "write"),
]));
transitiveSafety.start("safety");
transitiveSafety.complete("safety", { safetyDecision: { allowed: false } });
transitiveSafety.start("confirmation");
transitiveSafety.complete("confirmation", { status: "issued" });
assert.deepEqual(transitiveSafety.canExecute("window"), {
  allowed: false,
  reasonCode: "dependency-failed",
});

for (const [label, safetyDecision] of [
  ["missing", null],
  ["unknown", { allowed: false }],
]) {
  const guarded = createTaskPlanExecution(taskPlan);
  guarded.start("safety");
  guarded.complete("safety", safetyDecision ? { safetyDecision } : {});
  assert.deepEqual(guarded.canExecute("window"), {
    allowed: false,
    reasonCode: "dependency-failed",
  }, `${label} Safety result must not become a normal reject terminal`);
  assert.throws(
    () => guarded.blockSafetyRejected("window"),
    /safety-rejected/,
    `${label} Safety result must fail closed`,
  );
}

const confirmationOwned = createTaskPlanExecution(taskPlan);
confirmationOwned.start("safety");
confirmationOwned.complete("safety", {
  safetyDecision: { allowed: false, action: "require_confirmation" },
});
assert.deepEqual(confirmationOwned.canExecute("window"), {
  allowed: true,
  reasonCode: "confirmation-owner-required",
});
assert.throws(
  () => confirmationOwned.blockSafetyRejected("window"),
  /safety-rejected/,
  "confirmation-required is not an explicit Safety reject terminal",
);

const successful = createTaskPlanExecution(taskPlan);
successful.start("safety");
successful.complete("safety", {
  safetyDecision: { allowed: true, action: "allow", evidenceRefs: [{ id: "sensor:a" }] },
  evidenceRefs: [{
    id: "sensor:a",
    source: "vehicle-state",
    citation: { secret: "must-not-retain" },
  }],
});
assert.deepEqual(successful.canExecute("window"), { allowed: true, reasonCode: "ready" });
successful.start("window");
successful.complete("window", {
  evidenceRefs: [{ id: "snapshot:42", source: "vehicle-state" }],
  toolResult: {
    ok: true,
    executionState: "observed-succeeded",
    confirmedSnapshotId: "snapshot:42",
    requestedState: { percent: 50 },
    adapterAcceptance: true,
    providerInternals: { cursor: "secret" },
    hmiSummary: { rawPrompt: "must-not-retain" },
    visualScenario: { headers: { authorization: "Bearer secret" } },
    source: "vehicle-coordinator",
  },
  confirmedVehicleState: {
    id: "snapshot:42",
    values: { windowPositionPercentByZone: { front_left: 50 } },
    providerInternals: { rawBus: "secret" },
  },
  arguments: { zone: "driver", percent: 50 },
  tokens: 117,
  toolCall: { args: { zone: "driver", percent: 50 } },
  output: { response: "must-not-retain" },
  providerMetadata: { traceId: "secret" },
  unknownEnvelope: {
    secret: "must-not-retain",
    headers: { authorization: "Bearer secret" },
    requestBody: { raw: true },
  },
});
successful.start("response");
successful.complete("response", { evidenceRefs: [{ id: "response:1" }] });

const snapshot = successful.snapshot();
assertDeepFrozen(snapshot);
assertNoForbiddenKeys(snapshot);
assert.equal(JSON.stringify(snapshot).includes("must-not-retain"), false);
assert.equal(JSON.stringify(snapshot).includes("Bearer secret"), false);
assert.equal(snapshot.steps[0].result.evidenceRefs[0].citation, undefined);
assert.equal(snapshot.steps[1].result.toolResult.hmiSummary, undefined);
assert.equal(snapshot.steps[1].result.toolResult.visualScenario, undefined);
assert.equal(snapshot.steps.find((item) => item.stepId === "window").result.toolResult.confirmedSnapshotId, "snapshot:42");
assert.deepEqual(snapshot.steps.find((item) => item.stepId === "window").result.evidenceRefs, [
  { id: "snapshot:42", source: "vehicle-state" },
]);
assert.throws(() => successful.start("window"), /terminal/);

const facts = successful.buildExecutionFacts({
  safetyDecision: { allowed: true, action: "allow" },
  toolResult: {
    ok: true,
    executionState: "observed-succeeded",
    confirmedSnapshotId: "snapshot:42",
    hmiSummary: "caller-forged-summary",
    visualScenario: "caller-forged-scenario",
    source: "caller-forged-source",
    requestedState: { percent: 50 },
    adapterAcceptance: true,
  },
  confirmedVehicleState: {
    id: "snapshot:42",
    values: { windowPositionPercentByZone: { front_left: 99 } },
  },
  evidenceRefs: [{ id: "snapshot:42" }],
  degraded: false,
  failureReason: "",
  completionStatus: "completed",
});
assertDeepFrozen(facts);
assertNoForbiddenKeys(facts);
assert.equal(facts.confirmedVehicleState.id, "snapshot:42");
assert.equal(facts.toolResult.confirmedSnapshotId, "snapshot:42");
assert.notEqual(facts.toolResult.hmiSummary, "caller-forged-summary");
assert.equal(facts.toolResult.source, "vehicle-coordinator");
assert.equal(facts.confirmedVehicleState.values.windowPositionPercentByZone.front_left, 50);
assert.equal(facts.completionStatus, "completed");
assert.deepEqual(facts.stepResults.map(({ stepId, status }) => ({ stepId, status })), [
  { stepId: "safety", status: "completed" },
  { stepId: "window", status: "completed" },
  { stepId: "response", status: "completed" },
]);

for (const [label, omitted] of [
  ["caller ToolResult absent", "toolResult"],
  ["caller confirmed state absent", "confirmedVehicleState"],
]) {
  const input = {
    safetyDecision: { allowed: true, action: "allow" },
    toolResult: {
      ok: true,
      executionState: "observed-succeeded",
      confirmedSnapshotId: "snapshot:42",
    },
    confirmedVehicleState: {
      id: "snapshot:42",
      values: { windowPositionPercentByZone: { front_left: 99 } },
    },
    evidenceRefs: [],
    degraded: false,
    failureReason: "",
    completionStatus: "completed",
  };
  delete input[omitted];
  const absentFacts = successful.buildExecutionFacts(input);
  assert.equal(absentFacts.confirmedVehicleState.id, "snapshot:42", label);
  assert.equal(absentFacts.completionStatus, "completed", label);
}

const callerLedgerMismatch = createTaskPlanExecution(taskPlan);
callerLedgerMismatch.start("safety");
callerLedgerMismatch.complete("safety", { safetyDecision: { allowed: true, action: "allow" } });
callerLedgerMismatch.start("window");
callerLedgerMismatch.complete("window", {
  toolResult: {
    executionState: "observed-succeeded",
    confirmedSnapshotId: "snapshot:ledger",
  },
  confirmedVehicleState: {
    id: "snapshot:ledger",
    values: { windowPositionPercentByZone: { front_left: 50 } },
  },
});
callerLedgerMismatch.start("response");
callerLedgerMismatch.complete("response", {});
const mismatchedLedgerFacts = callerLedgerMismatch.buildExecutionFacts({
  toolResult: {
    executionState: "observed-succeeded",
    confirmedSnapshotId: "snapshot:caller",
  },
  confirmedVehicleState: {
    id: "snapshot:caller",
    values: { windowPositionPercentByZone: { front_left: 99 } },
  },
  evidenceRefs: [],
  degraded: false,
  failureReason: "",
  completionStatus: "completed",
});
assert.equal(mismatchedLedgerFacts.confirmedVehicleState.id, "snapshot:ledger");
assert.equal(mismatchedLedgerFacts.confirmedVehicleState.values.windowPositionPercentByZone.front_left, 50);
assert.equal(mismatchedLedgerFacts.completionStatus, "completed");

for (const [label, toolResult, confirmedVehicleState] of [
  ["accepted", { executionState: "accepted", confirmedSnapshotId: "snapshot:42" }, { id: "snapshot:42" }],
  ["empty identity", { executionState: "observed-succeeded", confirmedSnapshotId: "" }, { id: "" }],
  ["mismatched identity", { executionState: "observed-succeeded", confirmedSnapshotId: "snapshot:42" }, { id: "snapshot:43" }],
]) {
  const conservativeExecution = createTaskPlanExecution(taskPlan);
  conservativeExecution.start("safety");
  conservativeExecution.complete("safety", { safetyDecision: { allowed: true, action: "allow" } });
  conservativeExecution.start("window");
  conservativeExecution.complete("window", { toolResult, confirmedVehicleState });
  conservativeExecution.start("response");
  conservativeExecution.complete("response", {});
  const conservativeFacts = conservativeExecution.buildExecutionFacts({
    evidenceRefs: [],
    degraded: false,
    failureReason: "",
    completionStatus: "completed",
  });
  assert.equal(conservativeFacts.confirmedVehicleState, null, `${label}: unconfirmed state must be omitted`);
  assert.notEqual(conservativeFacts.completionStatus, "completed", `${label}: completion must remain conservative`);
}

const failedDependency = createTaskPlanExecution(plan([
  step("manual", "manual.retrieve"),
  step("response", "response.synthesize", ["manual"]),
]));
failedDependency.start("manual");
failedDependency.fail("manual", "retrieval unavailable");
assert.deepEqual(failedDependency.canExecute("response"), {
  allowed: false,
  reasonCode: "dependency-failed",
});
assert.throws(() => failedDependency.fail("manual", "again"), /terminal/);
const partialFacts = failedDependency.buildExecutionFacts({
  evidenceRefs: [],
  degraded: true,
  failureReason: "retrieval unavailable",
  completionStatus: "completed",
});
assert.equal(partialFacts.completionStatus, "incomplete");

const unavailableManual = createTaskPlanExecution(plan([
  step("manual", "manual.retrieve"),
  step("response", "response.synthesize", ["manual"]),
]));
unavailableManual.start("manual");
unavailableManual.complete("manual", {
  status: "unavailable",
  reason: "embedding-unavailable",
  summary: "手册检索当前不可用。",
  telemetry: { rawError: "must-not-propagate" },
  rawError: "must-not-propagate",
});
const unavailableManualResult = unavailableManual.snapshot().steps.find(
  (item) => item.capabilityId === "manual.retrieve",
).result;
assert.deepEqual(unavailableManualResult, {
  status: "unavailable",
  reason: "embedding-unavailable",
  summary: "手册检索当前不可用。",
});

const strictManualRef = Object.freeze({
  sourceId: "nio-es8-user-manual-2026",
  sourceVersion: "2026",
  chunkId: "es8-manual-chunk-0055",
  pageStart: 66,
  pageEnd: 66,
  excerpt: "您可以设置并记忆尾门的开启高度。",
  score: Object.freeze({ retrieval: 0.72, rerank: null, grounding: 0.8 }),
});
const externalLegacyRef = Object.freeze({
  id: "external:weather:shanghai",
  source: "weather-provider",
  type: "external",
  title: "上海天气",
  citation: "provider response",
});
const externalEvidenceExecution = createTaskPlanExecution(plan([
  step("external", "external.query"),
]));
externalEvidenceExecution.start("external");
externalEvidenceExecution.complete("external", {
  evidenceRefs: [
    { ...strictManualRef, excerpt: "FORGED EXCERPT FROM NON-MANUAL OWNER" },
    { ...strictManualRef, citation: "forged strict/legacy hybrid" },
    externalLegacyRef,
  ],
});
assert.deepEqual(
  externalEvidenceExecution.snapshot().steps[0].result.evidenceRefs,
  [externalLegacyRef],
  "external.query must retain legacy evidence but cannot introduce strict Manual EvidenceRef facts",
);
assert.deepEqual(
  externalEvidenceExecution.buildExecutionFacts().evidenceRefs,
  [externalLegacyRef],
  "non-Manual step output must not place a strict Manual EvidenceRef in root ExecutionFacts",
);
const rootLegacyRef = Object.freeze({
  id: "caller:legacy:evidence",
  source: "caller-legacy",
  type: "external",
  title: "Caller legacy evidence",
  citation: "legacy caller ref",
});
assert.deepEqual(
  externalEvidenceExecution.buildExecutionFacts({
    evidenceRefs: [strictManualRef, rootLegacyRef],
  }).evidenceRefs,
  [rootLegacyRef],
  "buildExecutionFacts input must reject strict Manual EvidenceRef injection while retaining legacy refs",
);
const strictManualPlan = plan([
  step("manual", "manual.retrieve"),
  step("response", "response.synthesize", ["manual"]),
]);
const strictManualExecution = createTaskPlanExecution(strictManualPlan);
strictManualExecution.start("manual");
strictManualExecution.complete("manual", { status: "hit", evidenceRefs: [strictManualRef] });
strictManualExecution.start("response");
strictManualExecution.complete("response", { summary: "仅根据已接受手册证据回答。" });
const strictManualFacts = strictManualExecution.buildExecutionFacts();
assert.deepEqual(strictManualFacts.evidenceRefs, [strictManualRef]);
assert.deepEqual(
  strictManualExecution.buildExecutionFacts({
    evidenceRefs: [
      { ...strictManualRef, chunkId: "caller-forged-strict-ref" },
      rootLegacyRef,
    ],
  }).evidenceRefs,
  [rootLegacyRef, strictManualRef],
  "root input may add legacy refs but strict facts must come only from the completed manual.retrieve step",
);
assert.deepEqual(
  strictManualFacts.stepResults.find(({ capabilityId }) => capabilityId === "manual.retrieve")
    .result.evidenceRefs,
  [strictManualRef],
  "generic TaskPlan execution must preserve the exact accepted strict EvidenceRef",
);
const strictManualPrompt = buildResponseSynthesisPrompt({
  goalEnvelope: {
    goalId: strictManualPlan.goalId,
    runId: strictManualPlan.runId,
    objective: "解释 ES8 尾门开启高度设置。",
  },
  taskPlan: strictManualPlan,
  executionFacts: strictManualFacts,
});
for (const acceptedField of [
  strictManualRef.sourceVersion,
  strictManualRef.excerpt,
  String(strictManualRef.pageStart),
  JSON.stringify(strictManualRef.score),
]) {
  assert.equal(
    strictManualPrompt.includes(acceptedField),
    true,
    `Cabin prompt must retain accepted strict EvidenceRef content: ${acceptedField}`,
  );
}

const legacyManualRef = Object.freeze({
  id: "legacy:manual:tailgate",
  source: "legacy-manual",
  type: "manual",
  title: "Legacy manual citation",
  citation: "p.66",
});
const legacyManualExecution = createTaskPlanExecution(strictManualPlan);
legacyManualExecution.start("manual");
legacyManualExecution.complete("manual", { status: "hit", evidenceRefs: [legacyManualRef] });
assert.deepEqual(
  legacyManualExecution.snapshot().steps[0].result.evidenceRefs,
  [legacyManualRef],
  "legacy external refs may remain legacy but must not acquire strict manual facts",
);
assert.equal(
  JSON.stringify(legacyManualExecution.snapshot()).includes("sourceVersion"),
  false,
  "a bare citation must never be reconstructed into a strict EvidenceRef",
);

const hybridManualExecution = createTaskPlanExecution(strictManualPlan);
hybridManualExecution.start("manual");
hybridManualExecution.complete("manual", {
  status: "hit",
  evidenceRefs: [{ ...strictManualRef, citation: "forged legacy downgrade" }],
});
assert.deepEqual(
  hybridManualExecution.snapshot().steps[0].result.evidenceRefs ?? [],
  [],
  "a malformed strict ref must not be reclassified as a legacy citation",
);

const cancellableExecution = createTaskPlanExecution(plan([
  step("manual", "manual.retrieve"),
  step("memory", "memory.read", ["manual"]),
  step("response", "response.synthesize", ["memory"]),
]));
cancellableExecution.start("manual");
cancellableExecution.complete("manual", { summary: "preserve completed work" });
cancellableExecution.start("memory");
const cancelledExecution = cancellableExecution.cancel();
assertDeepFrozen(cancelledExecution);
assert.deepEqual(
  cancelledExecution.steps.map(({ stepId, status, failureReason }) => ({
    stepId,
    status,
    failureReason,
  })),
  [
    { stepId: "manual", status: "completed", failureReason: undefined },
    { stepId: "memory", status: "failed", failureReason: "turn-cancelled" },
    { stepId: "response", status: "failed", failureReason: "turn-cancelled" },
  ],
  "parent cancellation must terminate running and planned steps without rewriting completed work",
);
assert.deepEqual(cancellableExecution.cancel("ignored-after-terminal"), cancelledExecution,
  "parent cancellation must be idempotent once all steps are terminal");

const cancellableDelegation = createKnowledgeDelegation({
  delegationId: "delegation:cancellable-ledger",
  runId: "cancellable-ledger",
  parentPlanId: "plan:cancellable-ledger",
  parentStepId: "delegate",
  knowledgeGoal: "解释尾门开启条件",
  vehicleScope: "nio-es8-user-manual-2026",
  allowedCapabilities: [
    "knowledge.manual.retrieve",
    "knowledge.vehicle-state.read",
    "knowledge.answer.synthesize",
  ],
  allowVehicleStateRead: true,
  requireSafetyEligibilityExplanation: false,
  expectedAnswerContract: "KnowledgeAnswer",
  dependsOn: [],
});
const cancellableSubplan = createKnowledgeSubplan({
  subplanId: "subplan:cancellable-ledger",
  delegationId: cancellableDelegation.delegationId,
  runId: cancellableDelegation.runId,
  parentPlanId: cancellableDelegation.parentPlanId,
  parentStepId: cancellableDelegation.parentStepId,
  steps: [{
    stepId: "manual",
    capabilityId: "knowledge.manual.retrieve",
    dependsOn: [],
    input: { query: cancellableDelegation.knowledgeGoal },
    expectedOutput: "manual-evidence",
    accessMode: "read",
    status: "planned",
  }, {
    stepId: "vehicle-state",
    capabilityId: "knowledge.vehicle-state.read",
    dependsOn: ["manual"],
    input: { scope: "tailgate" },
    expectedOutput: "vehicle-state-evidence",
    accessMode: "read",
    status: "planned",
  }, {
    stepId: "answer",
    capabilityId: "knowledge.answer.synthesize",
    dependsOn: ["manual", "vehicle-state"],
    input: { facts: { summary: "根据证据回答。", evidenceRefs: [] } },
    expectedOutput: "knowledge-answer",
    accessMode: "read",
    status: "planned",
  }],
  selectedCapabilities: [
    "knowledge.manual.retrieve",
    "knowledge.vehicle-state.read",
    "knowledge.answer.synthesize",
  ],
  planningSummary: "检索手册和车辆状态后回答。",
  model: "fixture",
  provider: "fixture",
  status: "planned",
});
const cancellableKnowledgeExecution = createKnowledgeSubplanExecution(
  cancellableSubplan,
  cancellableDelegation,
);
cancellableKnowledgeExecution.start("manual");
cancellableKnowledgeExecution.complete("manual", { evidenceRefs: [{ id: "manual:tailgate" }] });
cancellableKnowledgeExecution.start("vehicle-state");
const cancelledKnowledgeExecution = cancellableKnowledgeExecution.cancel("caller-cancelled");
assertDeepFrozen(cancelledKnowledgeExecution);
assert.deepEqual(
  cancelledKnowledgeExecution.steps.map(({ stepId, status, failureReason }) => ({
    stepId,
    status,
    failureReason,
  })),
  [
    { stepId: "manual", status: "completed", failureReason: undefined },
    { stepId: "vehicle-state", status: "failed", failureReason: "caller-cancelled" },
    { stepId: "answer", status: "failed", failureReason: "caller-cancelled" },
  ],
  "child cancellation must terminate running and planned steps without rewriting completed work",
);
assert.deepEqual(
  cancellableKnowledgeExecution.cancel("ignored-after-terminal"),
  cancelledKnowledgeExecution,
  "child cancellation must be idempotent once all steps are terminal",
);

const bareSafety = createTaskPlanExecution(taskPlan);
bareSafety.start("safety");
bareSafety.complete("safety", { allowed: true });
assert.deepEqual(bareSafety.canExecute("window"), {
  allowed: false,
  reasonCode: "dependency-failed",
});
const contradictorySafety = createTaskPlanExecution(taskPlan);
contradictorySafety.start("safety");
contradictorySafety.complete("safety", {
  allowed: true,
  safetyDecision: { allowed: false, action: "reject" },
});
assert.deepEqual(contradictorySafety.canExecute("window"), {
  allowed: false,
  reasonCode: "safety-rejected",
});

assert.throws(() => createTaskPlanExecution({
  ...taskPlan,
  steps: [...taskPlan.steps, step("unvalidated", "memory.read")],
}), /validated TaskPlan/);
assert.throws(() => createTaskPlanExecution(plan([
  step("invented", "vehicle.invented.write", [], "write"),
])), /validated TaskPlan/);

console.log("task plan execution verification passed");
