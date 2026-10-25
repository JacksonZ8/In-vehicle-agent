import assert from "node:assert/strict";
import {
  B2_CAPABILITY_CATALOG,
  getCapability,
} from "../../src/agents/capability-catalog.js";
import {
  KNOWLEDGE_CAPABILITY_CATALOG,
  getKnowledgeCapability,
  getKnowledgeCapabilityCatalogProjection,
} from "../../src/agents/knowledge-capability-catalog.js";
import {
  createKnowledgeDelegation,
  createKnowledgeSubplan,
} from "../../src/application/contracts/vehicle-knowledge.js";
import {
  validateKnowledgeDelegationAgainstParent,
  validateKnowledgeSubplan,
} from "../../src/agents/knowledge-plan-validator.js";
import { createTaskPlan } from "../../src/agents/agent-contracts.js";
import {
  AI_AGENT_COMPONENT_IDS,
  PARTICIPANT_REGISTRY,
  PARTICIPANT_TYPES,
  getParticipant,
} from "../../src/runtime/participant-registry.js";

assert.deepEqual(AI_AGENT_COMPONENT_IDS, [
  "cabinAssistant",
  "orchestrator",
]);
assert.equal(
  Object.values(PARTICIPANT_REGISTRY)
    .filter(({ type }) => type === PARTICIPANT_TYPES.AI_AGENT).length,
  2,
);

assert.equal(getCapability("manual.retrieve")?.ownerParticipantId, "manualRetriever");

assert.deepEqual(
  KNOWLEDGE_CAPABILITY_CATALOG.map(({ id }) => id),
  [
    "knowledge.manual.retrieve",
    "knowledge.vehicle-state.read",
    "knowledge.safety.evaluate",
    "knowledge.answer.synthesize",
  ],
);
assert.equal(KNOWLEDGE_CAPABILITY_CATALOG.some(({ accessMode }) => accessMode === "write"), false);
assert.equal(
  KNOWLEDGE_CAPABILITY_CATALOG.some(({ ownerParticipantId }) => ownerParticipantId === "vehicleApi"),
  false,
);
assert.equal(
  B2_CAPABILITY_CATALOG.some(({ id }) => id.startsWith("knowledge.")),
  false,
  "specialist internals must not leak into the parent catalog",
);
assert.equal(getKnowledgeCapability("knowledge.vehicle-state.read")?.ownerParticipantId, "vehicleStateProvider");
assert.equal(getKnowledgeCapability("knowledge.safety.evaluate")?.ownerParticipantId, "safety");
assert.equal(getKnowledgeCapability("knowledge.answer.synthesize")?.ownerParticipantId, "cabinAssistant");
assert.equal(getKnowledgeCapability("knowledge.safety.evaluate")?.inputSchema.properties.action.const, "body.tailgate.open");

const projection = getKnowledgeCapabilityCatalogProjection();
assert.equal(Object.isFrozen(projection), true);
assert.equal(Object.isFrozen(projection[0]), true);
assert.equal(JSON.stringify(projection).includes("handler"), false);
assert.equal(JSON.stringify(projection).includes("timeoutMs"), false);

const parentPlan = createTaskPlan({
  planId: "plan:knowledge-run",
  goalId: "goal:knowledge-run",
  runId: "knowledge-run",
  steps: [{
    stepId: "manual-parent",
    capabilityId: "manual.retrieve",
    dependsOn: [],
    input: { query: "解释 ES8 尾门开启条件" },
    expectedOutput: "manual-evidence",
    accessMode: "read",
    status: "planned",
  }],
  selectedCapabilities: ["manual.retrieve"],
  planningSummary: "执行手册检索。",
  model: "qwen2.5:7b",
  provider: "ollama",
  status: "planned",
});

const delegation = createKnowledgeDelegation({
  delegationId: "delegation:knowledge-run",
  runId: "knowledge-run",
  parentPlanId: parentPlan.planId,
  parentStepId: "manual-parent",
  knowledgeGoal: "解释 ES8 尾门开启条件",
  vehicleScope: "nio-es8-user-manual-2026",
  allowedCapabilities: ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
  allowVehicleStateRead: false,
  requireSafetyEligibilityExplanation: false,
  expectedAnswerContract: "KnowledgeAnswer",
  dependsOn: [],
});

function subplan({ delegation: activeDelegation = delegation, steps }) {
  return createKnowledgeSubplan({
    subplanId: `knowledge-plan:${activeDelegation.delegationId}`,
    delegationId: activeDelegation.delegationId,
    runId: activeDelegation.runId,
    parentPlanId: activeDelegation.parentPlanId,
    parentStepId: activeDelegation.parentStepId,
    steps,
    selectedCapabilities: steps.map(({ capabilityId }) => capabilityId),
    planningSummary: "按照已授权能力生成知识回答。",
    model: "qwen2.5:7b",
    provider: "ollama",
    status: "planned",
  });
}

const staticPlan = subplan({
  steps: [
    {
      stepId: "manual",
      capabilityId: "knowledge.manual.retrieve",
      dependsOn: [],
      input: { query: "ES8 尾门开启条件" },
      expectedOutput: "manual-evidence",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "answer",
      capabilityId: "knowledge.answer.synthesize",
      dependsOn: ["manual"],
      input: { facts: { summary: "尾门开启条件", evidenceRefs: ["manual:tailgate"] } },
      expectedOutput: "knowledge-answer",
      accessMode: "read",
      status: "planned",
    },
  ],
});

const providerDelegation = createKnowledgeDelegation({
  ...delegation,
  delegationId: "delegation:provider-run",
  runId: "provider-run",
  parentPlanId: "plan:provider-run",
  allowedCapabilities: [
    "knowledge.manual.retrieve",
    "knowledge.vehicle-state.read",
    "knowledge.safety.evaluate",
    "knowledge.answer.synthesize",
  ],
  allowVehicleStateRead: true,
  requireSafetyEligibilityExplanation: true,
});
const providerSafetyPlan = subplan({
  delegation: providerDelegation,
  steps: [
    {
      stepId: "manual",
      capabilityId: "knowledge.manual.retrieve",
      dependsOn: [],
      input: { query: "ES8 尾门 开启 安全" },
      expectedOutput: "manual-evidence",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "vehicle-state",
      capabilityId: "knowledge.vehicle-state.read",
      dependsOn: ["manual"],
      input: { scope: "tailgate" },
      expectedOutput: "vehicle-state",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "safety",
      capabilityId: "knowledge.safety.evaluate",
      dependsOn: ["vehicle-state"],
      input: { action: "body.tailgate.open" },
      expectedOutput: "safety-eligibility",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "answer",
      capabilityId: "knowledge.answer.synthesize",
      dependsOn: ["manual", "safety"],
      input: { facts: { summary: "当前尾门状态", evidenceRefs: ["vehicle-state:tailgate"] } },
      expectedOutput: "knowledge-answer",
      accessMode: "read",
      status: "planned",
    },
  ],
});

const writePlan = structuredClone(staticPlan);
writePlan.steps[0].accessMode = "write";
const unknownCapability = structuredClone(staticPlan);
unknownCapability.steps[0].capabilityId = "knowledge.unknown";
unknownCapability.selectedCapabilities[0] = "knowledge.unknown";
const duplicateCapability = structuredClone(staticPlan);
duplicateCapability.steps[1] = {
  ...duplicateCapability.steps[0],
  stepId: "manual-again",
};
duplicateCapability.selectedCapabilities[1] = "knowledge.manual.retrieve";
const forwardDependency = structuredClone(staticPlan);
forwardDependency.steps[0].dependsOn = ["answer"];
forwardDependency.steps[1].dependsOn = [];
const cyclicDependency = structuredClone(staticPlan);
cyclicDependency.steps[0].dependsOn = ["answer"];
const crossRunDelegation = { ...delegation, runId: "other-run" };
const parentMutation = { ...delegation, knowledgeGoal: "篡改后的知识目标" };
const nonEs8Delegation = { ...delegation, vehicleScope: "nio-et5-user-manual-2026" };
const eligibilityWithoutManual = structuredClone(providerSafetyPlan);
eligibilityWithoutManual.steps.splice(0, 1);
eligibilityWithoutManual.steps[0].dependsOn = [];
eligibilityWithoutManual.selectedCapabilities.shift();
const eligibilityBrokenManualChain = structuredClone(providerSafetyPlan);
eligibilityBrokenManualChain.steps[1].dependsOn = [];
const repeatedManualEligibility = structuredClone(providerSafetyPlan);
repeatedManualEligibility.steps = Array.from(
  { length: 4 },
  () => structuredClone(providerSafetyPlan.steps[0]),
);
const reorderedEligibility = structuredClone(providerSafetyPlan);
[reorderedEligibility.steps[0], reorderedEligibility.steps[1]] = [
  reorderedEligibility.steps[1],
  reorderedEligibility.steps[0],
];
const legacyStateIdEligibility = structuredClone(providerSafetyPlan);
legacyStateIdEligibility.steps[1].stepId = "state";
legacyStateIdEligibility.steps[2].dependsOn = ["state"];
const rawGoalQueryEligibility = structuredClone(providerSafetyPlan);
rawGoalQueryEligibility.steps[0].input.query = providerDelegation.knowledgeGoal;
const wrongProviderScopeEligibility = structuredClone(providerSafetyPlan);
wrongProviderScopeEligibility.steps[1].input.scope = "nio-es8-user-manual-2026";
const safetyWithoutProvider = structuredClone(providerSafetyPlan);
safetyWithoutProvider.steps.splice(1, 1);
safetyWithoutProvider.steps[1].dependsOn = ["manual"];
safetyWithoutProvider.selectedCapabilities.splice(1, 1);
const answerWithoutRequiredSafety = structuredClone(providerSafetyPlan);
answerWithoutRequiredSafety.steps[3].dependsOn = ["manual", "vehicle-state"];
const answerWithoutEvidence = structuredClone(staticPlan);
answerWithoutEvidence.steps[1].dependsOn = [];
const unsupportedSafetyAction = structuredClone(providerSafetyPlan);
unsupportedSafetyAction.steps[2].input.action = "body.window.setPosition";
const arbitrarySafetyAction = structuredClone(providerSafetyPlan);
arbitrarySafetyAction.steps[2].input.action = "tailgate-open";

const validDelegation = validateKnowledgeDelegationAgainstParent(delegation, parentPlan);
assert.equal(validDelegation.ok, true);
assert.equal(validateKnowledgeSubplan(staticPlan, delegation).ok, true);
const providerSafetyResult = validateKnowledgeSubplan(providerSafetyPlan, providerDelegation);
assert.equal(providerSafetyResult.ok, true);
assert.equal(providerSafetyResult.status, "knowledge-plan-valid");
assert.equal(providerSafetyResult.plan, providerSafetyPlan);
assert.equal(Object.isFrozen(providerSafetyResult), true);
assert.equal(Object.isFrozen(providerSafetyResult.errors), true);
assert.match(
  validateKnowledgeSubplan(writePlan, delegation).errors.join(" "),
  /read-only|write capability/,
);
assert.match(validateKnowledgeSubplan(unknownCapability, delegation).errors.join(" "), /unknown capability/);
assert.match(validateKnowledgeSubplan(duplicateCapability, delegation).errors.join(" "), /duplicate capability/);
assert.match(validateKnowledgeSubplan(forwardDependency, delegation).errors.join(" "), /earlier step/);
assert.match(validateKnowledgeSubplan(cyclicDependency, delegation).errors.join(" "), /cyclic dependency/);
assert.match(
  validateKnowledgeDelegationAgainstParent(crossRunDelegation, parentPlan).errors.join(" "),
  /runId|association/,
);
assert.match(validateKnowledgeDelegationAgainstParent(parentMutation, parentPlan).errors.join(" "), /query.*knowledgeGoal/);
assert.match(
  validateKnowledgeDelegationAgainstParent(nonEs8Delegation, parentPlan).errors.join(" "),
  /vehicleScope|nio-es8-user-manual-2026/,
);
assert.match(
  validateKnowledgeSubplan(eligibilityWithoutManual, providerDelegation).errors.join(" "),
  /knowledge\.manual\.retrieve|manual/,
);
assert.match(
  validateKnowledgeSubplan(eligibilityBrokenManualChain, providerDelegation).errors.join(" "),
  /knowledge\.vehicle-state\.read requires knowledge\.manual\.retrieve/,
);
assert.match(
  validateKnowledgeSubplan(repeatedManualEligibility, providerDelegation).errors.join(" "),
  /eligibility step|duplicate capability/,
);
assert.match(
  validateKnowledgeSubplan(reorderedEligibility, providerDelegation).errors.join(" "),
  /eligibility step 0 requires knowledge\.manual\.retrieve/,
);
assert.match(
  validateKnowledgeSubplan(legacyStateIdEligibility, providerDelegation).errors.join(" "),
  /requires stepId vehicle-state/,
);
assert.match(
  validateKnowledgeSubplan(rawGoalQueryEligibility, providerDelegation).errors.join(" "),
  /manual.*canonical input/i,
);
assert.match(
  validateKnowledgeSubplan(wrongProviderScopeEligibility, providerDelegation).errors.join(" "),
  /vehicle-state.*canonical input/i,
);
assert.match(
  validateKnowledgeSubplan(safetyWithoutProvider, providerDelegation).errors.join(" "),
  /knowledge\.safety\.evaluate requires knowledge\.vehicle-state\.read/,
);
assert.match(
  validateKnowledgeSubplan(answerWithoutRequiredSafety, providerDelegation).errors.join(" "),
  /knowledge\.answer\.synthesize requires knowledge\.safety\.evaluate/,
);
assert.match(validateKnowledgeSubplan(answerWithoutEvidence, delegation).errors.join(" "), /evidence ancestor/);
assert.match(
  validateKnowledgeSubplan(unsupportedSafetyAction, providerDelegation).errors.join(" "),
  /input\.action.*body\.tailgate\.open/,
  "unsupported Safety actions must be rejected during planning",
);
assert.match(
  validateKnowledgeSubplan(arbitrarySafetyAction, providerDelegation).errors.join(" "),
  /input\.action.*body\.tailgate\.open/,
  "arbitrary Safety actions must be rejected during planning",
);

console.log("vehicle knowledge participant and catalog verification passed");
