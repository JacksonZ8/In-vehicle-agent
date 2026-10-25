import assert from "node:assert/strict";
import {
  B2_MAX_PLAN_STEPS,
  createClarificationRequest,
  createExecutionFacts,
  createGoalEnvelope,
  createTaskPlan,
  validateGoalEnvelope,
  validateTaskPlanShape,
} from "../../src/agents/agent-contracts.js";

const goal = createGoalEnvelope({
  goalId: "goal:run-1",
  runId: "run-1",
  objective: "把主驾车窗打开一半",
  interactionType: "command",
  domain: "vehicle-control",
  constraints: ["driver-zone", "position-50"],
  contextRefs: [],
  requiredClarifications: [],
  readyForPlanning: true,
  model: "qwen2.5:7b",
  provider: "ollama",
  confidenceStrength: "strong",
});
assert.deepEqual(validateGoalEnvelope(goal), []);
assert.equal(Object.isFrozen(goal), true);
assert.equal(Object.isFrozen(goal.constraints), true);
assert.equal(B2_MAX_PLAN_STEPS, 6);

assert.match(
  validateGoalEnvelope({ ...goal, capabilityId: "vehicle.window.set-position" }).join("; "),
  /unknown field: capabilityId/,
);

const plan = createTaskPlan({
  planId: "plan:run-1",
  goalId: goal.goalId,
  runId: goal.runId,
  steps: [{
    stepId: "step-1",
    capabilityId: "vehicle.window.set-position",
    dependsOn: [],
    input: { zone: "driver", percent: 50 },
    expectedOutput: "provider-confirmed-window-position",
    accessMode: "write",
    status: "planned",
  }],
  selectedCapabilities: ["vehicle.window.set-position"],
  planningSummary: "执行用户明确指定的单步车窗目标。",
  model: "qwen2.5:7b",
  provider: "ollama",
  status: "planned",
});
assert.deepEqual(validateTaskPlanShape(plan), []);
assert.equal(plan.writeActionCount, 1);
assert.equal(Object.isFrozen(plan.steps[0].input), true);

assert.throws(() => createTaskPlan({
  ...plan,
  steps: Array.from({ length: 7 }, (_, index) => ({
    ...plan.steps[0],
    stepId: `step-${index + 1}`,
    accessMode: "read",
  })),
}), /at most 6 steps/);

assert.throws(() => createTaskPlan({
  ...plan,
  steps: [{ ...plan.steps[0], extra: true }],
}), /unknown step field: extra/);

assert.throws(() => createTaskPlan({
  ...plan,
  steps: [plan.steps[0], { ...plan.steps[0], stepId: "step-2" }],
}), /at most one write step/);

const clarification = createClarificationRequest({
  runId: "run-1",
  goalId: goal.goalId,
  questions: ["您希望打开到多少？"],
  reasonCode: "missing-window-position",
  model: "qwen2.5:7b",
  provider: "ollama",
});
assert.equal(Object.isFrozen(clarification), true);
assert.equal(Object.isFrozen(clarification.questions), true);
assert.throws(() => createClarificationRequest({ ...clarification, domain: "vehicle-control" }), /unknown field: domain/);

const facts = createExecutionFacts({
  runId: "run-1",
  goalId: goal.goalId,
  planId: plan.planId,
  stepResults: [],
  evidenceRefs: [],
  safetyDecision: null,
  toolResult: null,
  confirmedVehicleState: null,
  degraded: false,
  failureReason: "",
  completionStatus: "completed",
});
assert.equal(Object.isFrozen(facts), true);
assert.equal(Object.isFrozen(facts.stepResults), true);

for (const field of ["requestedState", "adapterAcceptance", "rawPrompt", "rawModelResponse", "chainOfThought"]) {
  assert.throws(() => createExecutionFacts({ ...facts, [field]: {} }), new RegExp(`forbidden field: ${field}`));
}

const nestedFacts = createExecutionFacts({
  ...facts,
  stepResults: [{ result: { state: "completed" } }],
  safetyDecision: { outcome: { allowed: true } },
});
assert.equal(Object.isFrozen(nestedFacts.stepResults[0].result), true);
assert.equal(Object.isFrozen(nestedFacts.safetyDecision.outcome), true);
assert.throws(() => { nestedFacts.stepResults[0].result.state = "forged"; }, TypeError);

const customPrototype = Object.create({ inherited: true });
customPrototype.value = "forged";
for (const unsupportedValue of [new Map([["state", "forged"]]), new Date(), customPrototype]) {
  assert.throws(() => createGoalEnvelope({ ...goal, contextRefs: [unsupportedValue] }), /contextRefs.*plain data/);
  assert.throws(() => createTaskPlan({
    ...plan,
    steps: [{ ...plan.steps[0], input: { payload: unsupportedValue } }],
  }), /steps\[0\]\.input.*plain data/);
  assert.throws(() => createExecutionFacts({ ...facts, stepResults: [unsupportedValue] }), /stepResults.*plain data/);
  assert.throws(() => createExecutionFacts({ ...facts, evidenceRefs: [unsupportedValue] }), /evidenceRefs.*plain data/);
  assert.throws(() => createExecutionFacts({ ...facts, safetyDecision: unsupportedValue }), /safetyDecision must be an object or null/);
  assert.throws(() => createExecutionFacts({ ...facts, toolResult: unsupportedValue }), /toolResult must be an object or null/);
  assert.throws(() => createExecutionFacts({ ...facts, confirmedVehicleState: unsupportedValue }), /confirmedVehicleState must be an object or null/);
}

for (const field of ["safetyDecision", "toolResult", "confirmedVehicleState"]) {
  for (const primitive of ["forged", 1, true]) {
    assert.throws(() => createExecutionFacts({ ...facts, [field]: primitive }), new RegExp(`${field} must be an object or null`));
  }
}

console.log("agent contract verification passed");
