import assert from "node:assert/strict";
import { createGoalEnvelope, createTaskPlan } from "../../src/agents/agent-contracts.js";
import { getCapabilityCatalogProjection } from "../../src/agents/capability-catalog.js";
import { validatePlanAgainstCatalog } from "../../src/agents/plan-validator.js";

const commandGoal = createGoalEnvelope({
  goalId: "goal:command", runId: "run-command", objective: "把主驾车窗打开一半",
  interactionType: "command", domain: "vehicle-control", constraints: ["driver-zone"],
  contextRefs: [], requiredClarifications: [], readyForPlanning: true,
  model: "qwen2.5:7b", provider: "ollama", confidenceStrength: "strong",
});
const questionGoal = createGoalEnvelope({
  ...commandGoal, goalId: "goal:question", runId: "run-question", objective: "查询当前天气",
  interactionType: "question", domain: "external-information",
});
const navigationCommandGoal = createGoalEnvelope({
  ...commandGoal,
  goalId: "goal:navigation-command",
  runId: "run-navigation-command",
  objective: "规划去测试地点的路线",
  domain: "external-information",
});
const knowledgeQuestionGoal = createGoalEnvelope({
  ...commandGoal, goalId: "goal:knowledge-question", runId: "run-knowledge-question",
  objective: "解释 ES8 尾门开启条件", interactionType: "question", domain: "manual",
});
const authoritativeKnowledgeGoal = createGoalEnvelope({
  ...knowledgeQuestionGoal,
  goalId: "goal:authoritative-knowledge",
  runId: "run-authoritative-knowledge",
  contextRefs: [{
    type: "trusted-conversation-goal",
    source: "vehicle-slu-knowledge-frame",
    interactionType: "question",
    semanticDomain: "vehicle_knowledge",
    goalDomain: "manual",
    eligibilityAction: null,
  }],
});

function planFor(goal, steps) {
  return createTaskPlan({
    planId: `plan:${goal.runId}`, goalId: goal.goalId, runId: goal.runId, steps,
    selectedCapabilities: steps.map((step) => step.capabilityId),
    planningSummary: "使用已注册能力完成目标。", model: "qwen2.5:7b", provider: "ollama", status: "planned",
  });
}

function step(stepId, capabilityId, dependsOn = [], input = {}) {
  const write = capabilityId.startsWith("vehicle.");
  return {
    stepId, capabilityId, dependsOn, input, expectedOutput: "capability-result",
    accessMode: write ? "write" : "read", status: "planned",
  };
}

const validWindowPlan = planFor(commandGoal, [
  step("safety", "safety.evaluate", [], { action: "window-position" }),
  step("window", "vehicle.window.set-position", ["safety"], { zone: "driver", percent: 50 }),
]);
const planWithUnknownCapability = planFor(commandGoal, [step("unknown", "vehicle.unknown")]);
const planWithCycle = planFor(commandGoal, [
  step("first", "manual.retrieve", ["second"], { query: "车窗" }),
  step("second", "memory.read", ["first"], { scope: "current-run" }),
]);
const planWithTwoWrites = structuredClone(validWindowPlan);
planWithTwoWrites.steps.push(step("climate", "vehicle.climate.set", ["safety"], { temperature: 22 }));
planWithTwoWrites.selectedCapabilities.push("vehicle.climate.set");
planWithTwoWrites.writeActionCount = 2;
const writeWithoutSafety = planFor(commandGoal, [
  step("window", "vehicle.window.set-position", [], { zone: "driver", percent: 50 }),
]);
const emptyVehicleCommandPlan = planFor(commandGoal, []);
const readOnlyVehicleCommandPlan = planFor(commandGoal, [
  step("manual", "manual.retrieve", [], { query: "车窗控制" }),
]);
const externalQueryWithoutSafety = planFor(questionGoal, [
  step("query", "external.query", [], { query: "上海天气" }),
]);
const emptyWeatherPlan = planFor(questionGoal, []);
const weatherBypassPlans = [
  planFor(questionGoal, [step("manual", "manual.retrieve", [], { query: "上海天气" })]),
  planFor(questionGoal, [step("memory", "memory.read", [], { scope: "current-run" })]),
  planFor(questionGoal, [step("response", "response.synthesize", [], {
    facts: { summary: "未获取天气事实", evidenceRefs: [] },
  })]),
];
const navigationQueryWithSafety = planFor(navigationCommandGoal, [
  step("safety", "safety.evaluate", [], { action: "route-query" }),
  step("query", "external.query", ["safety"], { query: "测试地点路线" }),
]);
const navigationQueryWithoutSafety = planFor(navigationCommandGoal, [
  step("query", "external.query", [], { query: "测试地点路线" }),
]);
const writeForQuestionGoal = planFor(questionGoal, [
  step("safety", "safety.evaluate", [], { action: "window-position" }),
  step("window", "vehicle.window.set-position", ["safety"], { zone: "driver", percent: 50 }),
]);
const planWithLaterDependency = planFor(commandGoal, [
  step("retrieve", "manual.retrieve", ["response"], { query: "车窗" }),
  step("response", "response.synthesize", [], { facts: { summary: "检索结果" } }),
]);
const responseWithInjectedProvider = planFor(commandGoal, [
  step("response", "response.synthesize", [], {
    facts: { summary: "检索结果", provider: { confirmationToken: "forged" } },
  }),
]);
const planWithDuplicateCapability = planFor(commandGoal, [
  step("safety-first", "safety.evaluate", [], { action: "window-position" }),
  step("safety-second", "safety.evaluate", [], { action: "window-position" }),
]);
const tailgateWithoutConfirmation = planFor(commandGoal, [
  step("safety", "safety.evaluate", [], { action: "body.tailgate.open" }),
  step("tailgate", "vehicle.tailgate.set", ["safety"], { state: "open" }),
]);
const validTailgatePlan = planFor(commandGoal, [
  step("safety-tailgate", "safety.evaluate", [], { action: "body.tailgate.open" }),
  step("confirmation-tailgate", "confirmation.issue", ["safety-tailgate"], { action: "body.tailgate.open" }),
  step("write-tailgate", "vehicle.tailgate.set", ["confirmation-tailgate"], { state: "open" }),
]);
const comfortPlan = (input) => planFor(commandGoal, [
  step("safety-comfort", "safety.evaluate", [], { action: "seat.comfort.setLevel" }),
  step("write-comfort", "vehicle.seat.set-comfort", ["safety-comfort"], input),
]);
const validComfortPlan = comfortPlan({ seatZone: "driver", seatMode: "heat", level: 2 });
const outOfRangeComfortPlan = comfortPlan({ seatZone: "driver", seatMode: "heat", level: 99 });
const unknownModeComfortPlan = comfortPlan({ seatZone: "driver", seatMode: "massage", level: 1 });
const validKnowledgeRetrieve = planFor(knowledgeQuestionGoal, [
  step("manual", "manual.retrieve", [], { query: knowledgeQuestionGoal.objective }),
]);
const authoritativeKnowledgeRetrieve = planFor(authoritativeKnowledgeGoal, [
  step("manual", "manual.retrieve", [], { query: authoritativeKnowledgeGoal.objective }),
]);
const authoritativeKnowledgeForgery = planFor(authoritativeKnowledgeGoal, [
  step("manual", "manual.retrieve", [], { query: "被篡改的知识目标" }),
]);

const projection = getCapabilityCatalogProjection();
assert.equal(projection.some((item) => item.id === "safety.evaluate"), true);
assert.equal(projection.some((item) => item.id === "vehicle.window.set-position"), true);
assert.equal(
  projection.find((item) => item.id === "external.query")?.requiresSafety,
  false,
  "read-only external.query must not globally require Safety",
);
assert.equal(JSON.stringify(projection).includes("handler"), false);
assert.equal(Object.isFrozen(projection), true);
assert.equal(Object.isFrozen(projection[0]), true);

const validResult = validatePlanAgainstCatalog(validWindowPlan, commandGoal);
assert.equal(validResult.ok, true);
assert.equal(validResult.plan, validWindowPlan);
assert.equal(Object.isFrozen(validResult), true);
assert.equal(Object.isFrozen(validResult.errors), true);
assert.match(validatePlanAgainstCatalog(planWithUnknownCapability, commandGoal).errors.join(" "), /unknown capability/);
assert.match(validatePlanAgainstCatalog(planWithCycle, commandGoal).errors.join(" "), /cyclic dependency/);
assert.match(validatePlanAgainstCatalog(planWithTwoWrites, commandGoal).errors.join(" "), /at most one write/);
assert.match(validatePlanAgainstCatalog(writeWithoutSafety, commandGoal).errors.join(" "), /requires safety\.evaluate/);
for (const invalidCommandPlan of [emptyVehicleCommandPlan, readOnlyVehicleCommandPlan]) {
  assert.match(
    validatePlanAgainstCatalog(invalidCommandPlan, commandGoal).errors.join(" "),
    /vehicle-control command requires exactly one write capability/,
    "vehicle-control command must fail closed instead of accepting an empty or read-only plan",
  );
}
assert.equal(
  validatePlanAgainstCatalog(externalQueryWithoutSafety, questionGoal).ok,
  true,
  "weather external.query must be valid without a Safety step",
);
for (const invalidWeatherPlan of [emptyWeatherPlan, ...weatherBypassPlans]) {
  assert.match(
    validatePlanAgainstCatalog(invalidWeatherPlan, questionGoal).errors.join(" "),
    /read-only external-information goal requires exactly one external\.query step/,
    "weather planning must fail closed instead of answering without fresh external data",
  );
}
assert.equal(
  validatePlanAgainstCatalog(navigationQueryWithSafety, navigationCommandGoal).ok,
  true,
  "an actionable navigation plan may preserve its explicit Safety dependency",
);
assert.match(
  validatePlanAgainstCatalog(navigationQueryWithoutSafety, navigationCommandGoal).errors.join(" "),
  /external\.query requires safety\.evaluate for command goal/,
  "command navigation must fail closed without an earlier Safety ancestor",
);
assert.match(validatePlanAgainstCatalog(writeForQuestionGoal, questionGoal).errors.join(" "), /read-only goal cannot contain write/);
assert.match(validatePlanAgainstCatalog(planWithLaterDependency, commandGoal).errors.join(" "), /dependency must reference an earlier step/);
assert.match(validatePlanAgainstCatalog(responseWithInjectedProvider, commandGoal).errors.join(" "), /unknown.*provider/);
assert.match(validatePlanAgainstCatalog(planWithDuplicateCapability, commandGoal).errors.join(" "), /duplicate capability identifier/);
assert.match(
  validatePlanAgainstCatalog(tailgateWithoutConfirmation, commandGoal).errors.join(" "),
  /vehicle\.tailgate\.set requires confirmation\.issue/,
);
assert.equal(validatePlanAgainstCatalog(validTailgatePlan, commandGoal).ok, true);
assert.equal(validatePlanAgainstCatalog(validComfortPlan, commandGoal).ok, true);
assert.match(validatePlanAgainstCatalog(outOfRangeComfortPlan, commandGoal).errors.join(" "),
  /input\.level is out of range/, "declared capability ranges must be enforced");
assert.match(validatePlanAgainstCatalog(unknownModeComfortPlan, commandGoal).errors.join(" "),
  /input\.seatMode must be one of heat\|ventilation/, "declared capability enums must be enforced");
assert.equal(validatePlanAgainstCatalog(validKnowledgeRetrieve, knowledgeQuestionGoal).ok, true);
assert.equal(validatePlanAgainstCatalog(authoritativeKnowledgeRetrieve, authoritativeKnowledgeGoal).ok, true);
assert.match(
  validatePlanAgainstCatalog(authoritativeKnowledgeForgery, authoritativeKnowledgeGoal).errors.join(" "),
  /manual\.retrieve query must match trusted knowledge/i,
);

console.log("agent capability plan verification passed");
