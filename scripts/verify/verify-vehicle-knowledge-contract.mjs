import assert from "node:assert/strict";
import {
  VEHICLE_KNOWLEDGE_CONTRACT,
  KNOWLEDGE_OUTCOME_STATUSES,
  KNOWLEDGE_SUPPORT_STATUSES,
  createKnowledgeAnswer,
  createKnowledgeClarificationRequest,
  createKnowledgeDelegation,
  createKnowledgeSubplan,
  createKnowledgeTerminalResult,
} from "../../src/application/contracts/vehicle-knowledge.js";

const delegation = createKnowledgeDelegation({
  delegationId: "delegation:run-1:knowledge",
  runId: "run-1",
  parentPlanId: "plan:run-1",
  parentStepId: "delegate-knowledge",
  knowledgeGoal: "解释 ES8 尾门开启条件",
  vehicleScope: "nio-es8-user-manual-2026",
  allowedCapabilities: ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
  allowVehicleStateRead: false,
  requireSafetyEligibilityExplanation: false,
  expectedAnswerContract: "KnowledgeAnswer",
  dependsOn: [],
});

assert.deepEqual(VEHICLE_KNOWLEDGE_CONTRACT, {
  id: "nio-vehicle-knowledge-contract@1.0.0",
  version: "1.0.0",
});
assert.deepEqual(KNOWLEDGE_OUTCOME_STATUSES, [
  "answered", "clarification", "not-applicable", "unavailable",
]);
assert.deepEqual(KNOWLEDGE_SUPPORT_STATUSES, ["supported", "partial", "unsupported"]);
assert.equal(Object.isFrozen(delegation), true);
assert.equal(Object.isFrozen(delegation.allowedCapabilities), true);
assert.throws(
  () => createKnowledgeDelegation({ ...delegation, injected: true }),
  /unknown delegation field: injected/,
);

const subplan = createKnowledgeSubplan({
  subplanId: "knowledge-plan:run-1",
  delegationId: delegation.delegationId,
  runId: delegation.runId,
  parentPlanId: delegation.parentPlanId,
  parentStepId: delegation.parentStepId,
  steps: [{
    stepId: "retrieve",
    capabilityId: "knowledge.manual.retrieve",
    dependsOn: [],
    input: { query: "ES8 尾门开启条件" },
    expectedOutput: "manual-evidence",
    accessMode: "read",
    status: "planned",
  }],
  selectedCapabilities: ["knowledge.manual.retrieve"],
  planningSummary: "检索 ES8 手册证据。",
  model: "qwen2.5:7b",
  provider: "ollama",
  status: "planned",
});
assert.equal(Object.isFrozen(subplan.steps[0].input), true);
assert.throws(
  () => createKnowledgeSubplan({
    ...subplan,
    steps: [{ ...subplan.steps[0], accessMode: "write" }],
  }),
  /knowledge subplan steps must be read-only/,
);

const answer = createKnowledgeAnswer({
  delegationId: delegation.delegationId,
  runId: delegation.runId,
  outcomeStatus: "answered",
  supportStatus: "supported",
  answer: "开启尾门前应确认开闭路径附近没有障碍物。",
  evidenceRefs: [{ id: "manual:tailgate", citation: "ES8 用户手册 p.62" }],
  vehicleStateRefs: [],
  safetyAssessmentRef: null,
  limitations: [],
  model: "qwen2.5:7b",
  provider: "ollama",
  durationMs: 120,
  degraded: false,
});
assert.equal(Object.isFrozen(answer.evidenceRefs[0]), true);
assert.throws(
  () => createKnowledgeAnswer({ ...answer, evidenceRefs: [], vehicleStateRefs: [] }),
  /supported answer requires evidence, vehicle state, or Safety assessment/,
);
assert.throws(
  () => createKnowledgeAnswer({ ...answer, toolCall: { tool: "body.tailgate.open" } }),
  /forbidden knowledge result field: toolCall/,
);

const clarification = createKnowledgeClarificationRequest({
  delegationId: delegation.delegationId,
  runId: delegation.runId,
  outcomeStatus: "clarification",
  questions: ["你想了解尾门的功能，还是当前无法开启的原因？"],
  reasonCode: "knowledge-goal-ambiguous",
  model: "qwen2.5:7b",
  provider: "ollama",
});
assert.equal(clarification.outcomeStatus, "clarification");
assert.throws(
  () => createKnowledgeClarificationRequest({ ...clarification, questions: [] }),
  /questions must not be empty/,
);

const notApplicable = createKnowledgeTerminalResult({
  delegationId: delegation.delegationId,
  runId: delegation.runId,
  outcomeStatus: "not-applicable",
  reasonCode: "vehicle-scope-not-applicable",
  limitations: ["首版仅接入 ES8 车型知识。"],
  degraded: false,
});
assert.equal(notApplicable.outcomeStatus, "not-applicable");
assert.equal(Object.hasOwn(notApplicable, "supportStatus"), false);
assert.throws(
  () => createKnowledgeTerminalResult({
    ...notApplicable,
    outcomeStatus: "answered",
  }),
  /answered outcome requires createKnowledgeAnswer/,
);

console.log("vehicle knowledge contract verification passed");
