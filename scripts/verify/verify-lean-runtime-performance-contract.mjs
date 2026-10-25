import assert from "node:assert/strict";
import {
  B4_BENCHMARK_SCENARIOS,
  validateBenchmarkScenario,
} from "../../src/benchmark/run-benchmark-scenarios.js";
import * as metricProjector from "../../src/benchmark/run-metric-projector.js";

const { projectRunMetrics } = metricProjector;

const budget = (id) => B4_BENCHMARK_SCENARIOS[id].modelBudget;

assert.deepEqual(budget("conversation-general"), { maxCalls: 2, allowedPhases: ["route-decision", "chat-response"] });
assert.deepEqual(budget("weather-readonly"), { maxCalls: 1, allowedPhases: ["route-decision"] });
assert.deepEqual(budget("vehicle-knowledge"), { maxCalls: 2, allowedPhases: ["route-decision", "knowledge-answer"] });
assert.deepEqual(budget("vehicle-control-safe"), { maxCalls: 1, allowedPhases: ["route-decision"] });
assert.deepEqual(budget("vehicle-control-unsafe"), { maxCalls: 1, allowedPhases: ["route-decision"] });
assert.deepEqual(budget("clarification"), { maxCalls: 1, allowedPhases: ["route-decision"] });
assert.ok(validateBenchmarkScenario({
  ...B4_BENCHMARK_SCENARIOS["conversation-general"],
  modelBudget: { ...budget("conversation-general"), turns: 1 },
}).includes("modelBudget must contain only maxCalls and allowedPhases"));

function browserObservation(overrides = {}) {
  return {
    submittedAtPerf: 100,
    firstFeedbackAtPerf: 200,
    resultVisibleAtPerf: 1_000,
    resultVisibleRunId: "run:chat",
    externalModelRequestCount: 1,
    toolCallCount: 0,
    adapterAcceptedCount: 0,
    providerCallCount: 0,
    providerAcceptedCount: 0,
    providerStateChangeCount: 0,
    ...overrides,
  };
}

function chatRun() {
  return {
    requestId: "run:chat",
    startedAtPerf: 100,
    endedAtPerf: 1_000,
    events: [],
    result: {
      routeDecision: { routeId: "chat", mode: "direct" },
      parsedCommand: { slots: { needsClarification: false } },
      runtimeTelemetry: {
        modelCallCount: 1,
        modelCalls: [{ phase: "chat-response", telemetry: { durationMs: 700 } }],
      },
    },
  };
}

const projected = projectRunMetrics({
  scenario: B4_BENCHMARK_SCENARIOS["conversation-general"],
  runDebug: chatRun(),
  browserObservation: browserObservation(),
});
assert.equal(projected.outcome, "passed");
assert.equal(projected.modelCallCount, 1);
assert.deepEqual(projected.slowestPhase, { phaseId: "chat-response", durationMs: 700 });
assert.deepEqual(projected.budgetErrors, []);

const cachedProviderCount = projectRunMetrics({
  scenario: B4_BENCHMARK_SCENARIOS["conversation-general"],
  runDebug: chatRun(),
  browserObservation: browserObservation({ externalModelRequestCount: 0 }),
});
assert.equal(cachedProviderCount.outcome, "passed");
assert.deepEqual(cachedProviderCount.budgetErrors, [],
  "a cached model phase must not be confused with a new Provider request");

const slowFeedback = projectRunMetrics({
  scenario: B4_BENCHMARK_SCENARIOS["conversation-general"],
  runDebug: chatRun(),
  browserObservation: browserObservation({ firstFeedbackAtPerf: 401 }),
});
assert.ok(slowFeedback.budgetErrors.includes("first feedback exceeds 300ms"));

assert.equal(typeof metricProjector.evaluateBenchmarkLatencyContract, "function",
  "the latency gate must expose one fixed canonical-contract evaluator");

for (const fixture of [
  {
    label: "chat",
    contractId: "conversation-general",
    routeDecision: { routeId: "chat", mode: "direct" },
    maxResultMs: 7_000,
  },
  {
    label: "knowledge",
    contractId: "vehicle-knowledge",
    routeDecision: { routeId: "vehicle-knowledge", mode: "direct" },
    maxResultMs: 8_000,
  },
  {
    label: "single control",
    contractId: "vehicle-control-safe",
    routeDecision: { routeId: "vehicle-control", mode: "direct" },
    maxResultMs: 2_000,
  },
  {
    label: "complex collaboration",
    contractId: "complex-collaboration",
    routeDecision: { routeId: "task", mode: "orchestrated" },
    maxResultMs: 12_000,
  },
]) {
  assert.deepEqual(metricProjector.evaluateBenchmarkLatencyContract({
    contractId: fixture.contractId,
    actualRouteDecision: fixture.routeDecision,
    submissionToFirstFeedbackMs: 300,
    submissionToResultVisibleMs: fixture.maxResultMs,
  }), [], `${fixture.label} must pass at the exact approved boundary`);
  assert.ok(metricProjector.evaluateBenchmarkLatencyContract({
    contractId: fixture.contractId,
    actualRouteDecision: fixture.routeDecision,
    submissionToFirstFeedbackMs: 300,
    submissionToResultVisibleMs: fixture.maxResultMs + 1,
  }).some((error) => error.includes("result visibility")),
  `${fixture.label} must fail one millisecond over its approved boundary`);
}

assert.ok(metricProjector.evaluateBenchmarkLatencyContract({
  contractId: "conversation-general",
  actualRouteDecision: { routeId: "task", mode: "orchestrated" },
  submissionToFirstFeedbackMs: 100,
  submissionToResultVisibleMs: 4_000,
}).some((error) => error.includes("route")),
"a chat scenario must reject an actual route that tries to select a looser threshold");
assert.ok(metricProjector.evaluateBenchmarkLatencyContract({
  contractId: "vehicle-knowledge",
  actualRouteDecision: null,
  submissionToFirstFeedbackMs: 100,
  submissionToResultVisibleMs: 4_000,
}).some((error) => error.includes("route")),
"a missing actual route must fail closed");

console.log(JSON.stringify({
  status: "PASS",
  verifier: "lean-runtime-performance-contract",
}));
