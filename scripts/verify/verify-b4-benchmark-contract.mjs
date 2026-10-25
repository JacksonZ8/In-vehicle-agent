import assert from "node:assert/strict";
import {
  BENCHMARK_PROFILES,
  RUN_BENCHMARK_REPORT,
  RUN_BENCHMARK_SUITE,
  validateBenchmarkReport,
} from "../../src/benchmark/run-benchmark-contract.js";
import {
  B4_BENCHMARK_SCENARIOS,
  getBenchmarkScenario,
  validateBenchmarkScenario,
} from "../../src/benchmark/run-benchmark-scenarios.js";
import {
  expectedProfileSampleKeys,
  validateFinalBenchmarkSample,
} from "../../src/benchmark/run-benchmark-sample-contract.js";

const expectedScenarioIds = [
  "conversation-general",
  "weather-readonly",
  "vehicle-knowledge",
  "vehicle-control-safe",
  "vehicle-control-unsafe",
  "clarification",
];

assert.deepEqual(Object.keys(B4_BENCHMARK_SCENARIOS), expectedScenarioIds);
assert.equal(BENCHMARK_PROFILES["warm-baseline"].repeats, 3);
assert.deepEqual(BENCHMARK_PROFILES["stability-faults"].scenarioIds, [
  "conversation-general", "weather-readonly", "vehicle-knowledge", "vehicle-control-safe",
]);
assert.deepEqual(BENCHMARK_PROFILES["voice-browser"].scenarioIds, [
  "conversation-general", "weather-readonly", "vehicle-knowledge", "vehicle-control-safe",
]);
assert.deepEqual(
  expectedProfileSampleKeys("stability-faults", BENCHMARK_PROFILES["stability-faults"]),
  [
    "conversation-general:1",
    "conversation-general:2",
    "vehicle-knowledge:1",
    "weather-readonly:1",
    "vehicle-control-safe:1",
  ],
  "the stability profile must share the exact five-sample fault plan instead of deriving four repeats",
);
assert.equal(getBenchmarkScenario("vehicle-control-unsafe").expected.adapterExecutions, 0);
assert.equal(getBenchmarkScenario("weather-readonly").expected.adapterExecutions, 0);
assert.equal(getBenchmarkScenario("vehicle-knowledge").expected.adapterExecutions, 0);
assert.equal(getBenchmarkScenario("weather-readonly").expected.vehicleWrites, 0);
assert.equal(getBenchmarkScenario("clarification").expected.vehicleWrites, 0);
assert.deepEqual(getBenchmarkScenario("conversation-general").expected, {
  resultCategory: "answered", adapterExecutions: 0, vehicleToolCalls: 0, vehicleWrites: 0,
});
assert.deepEqual(getBenchmarkScenario("weather-readonly").expected, {
  resultCategory: "answered", adapterExecutions: 0, vehicleToolCalls: 0, vehicleWrites: 0,
});
assert.deepEqual(getBenchmarkScenario("vehicle-knowledge").expected, {
  resultCategory: "answered", adapterExecutions: 0, vehicleToolCalls: 0, vehicleWrites: 0,
});
assert.deepEqual(getBenchmarkScenario("vehicle-control-safe").expected, {
  resultCategory: "executed", dispatchAuthorized: true, adapterExecutions: 1,
  vehicleToolCalls: 1, vehicleWrites: 1, providerConfirmation: true,
  commandId: true, animation: true,
});
assert.equal(
  getBenchmarkScenario("vehicle-control-safe").demoScenarioId,
  "confirmation",
  "safe tailgate acceptance must exercise the confirmation challenge before execution",
);
assert.deepEqual(getBenchmarkScenario("vehicle-control-unsafe").expected, {
  resultCategory: "blocked", dispatchAuthorized: false, adapterExecutions: 0,
  vehicleToolCalls: 0, vehicleWrites: 0,
});
assert.deepEqual(getBenchmarkScenario("clarification").expected, {
  resultCategory: "clarification", adapterExecutions: 0, vehicleToolCalls: 0,
  vehicleWrites: 0, safetyWriteDecisions: 0,
});
assert.deepEqual(RUN_BENCHMARK_REPORT, {
  id: "nio-run-benchmark-report",
  version: "1.0.0",
});
assert.deepEqual(RUN_BENCHMARK_SUITE, {
  id: "nio-b4-benchmark-suite",
  version: "1.0.0",
});

for (const scenario of Object.values(B4_BENCHMARK_SCENARIOS)) {
  for (const field of [
    "goal", "demoScenarioId", "requiredServices", "expected", "timeoutMs", "simulated", "modelBudget",
  ]) {
    assert.ok(Object.hasOwn(scenario, field), `${scenario.id} must declare ${field}`);
  }
  assert.ok(Number.isInteger(scenario.modelBudget.maxCalls) && scenario.modelBudget.maxCalls >= 0);
  assert.ok(Array.isArray(scenario.modelBudget.allowedPhases));
  assert.deepEqual(validateBenchmarkScenario(scenario), []);
}

const incompleteBudgetScenario = {
  ...getBenchmarkScenario("conversation-general"),
  modelBudget: { ...getBenchmarkScenario("conversation-general").modelBudget, allowedPhases: [] },
};
assert.ok(
  validateBenchmarkScenario(incompleteBudgetScenario).includes("modelBudget.allowedPhases must be non-empty when maxCalls is positive"),
  "positive model call budgets without phase IDs must fail validation",
);
const uncappedBudgetScenario = {
  ...getBenchmarkScenario("conversation-general"),
  modelBudget: { ...getBenchmarkScenario("conversation-general").modelBudget, maxCalls: -1 },
};
assert.ok(
  validateBenchmarkScenario(uncappedBudgetScenario).includes("modelBudget.maxCalls must be a non-negative integer"),
  "scenarios with a negative call cap must fail validation",
);
const unsafeDispatchScenario = {
  ...getBenchmarkScenario("vehicle-control-unsafe"),
  expected: { ...getBenchmarkScenario("vehicle-control-unsafe").expected, dispatchAuthorized: true },
};
assert.ok(
  validateBenchmarkScenario(unsafeDispatchScenario).length > 0,
  "unsafe control must remain non-dispatchable",
);
const readonlyWriteScenario = {
  ...getBenchmarkScenario("weather-readonly"),
  expected: { ...getBenchmarkScenario("weather-readonly").expected, vehicleWrites: 1 },
};
assert.ok(
  validateBenchmarkScenario(readonlyWriteScenario).length > 0,
  "read-only scenarios must reject Vehicle ToolCall/write expectations",
);
for (const scenarioId of ["conversation-general", "weather-readonly", "vehicle-knowledge"]) {
  const readonlyAdapterScenario = {
    ...getBenchmarkScenario(scenarioId),
    expected: { ...getBenchmarkScenario(scenarioId).expected, adapterExecutions: 1 },
  };
  assert.ok(
    validateBenchmarkScenario(readonlyAdapterScenario).length > 0,
    `${scenarioId} must fail closed when its Vehicle Adapter expectation changes`,
  );
  const readonlyCategoryScenario = {
    ...getBenchmarkScenario(scenarioId),
    expected: { ...getBenchmarkScenario(scenarioId).expected, resultCategory: "blocked" },
  };
  assert.ok(
    validateBenchmarkScenario(readonlyCategoryScenario).length > 0,
    `${scenarioId} must fail closed when its successful result category changes`,
  );
}
const clarificationSafetyWriteScenario = {
  ...getBenchmarkScenario("clarification"),
  expected: { ...getBenchmarkScenario("clarification").expected, safetyWriteDecisions: 1 },
};
assert.ok(
  validateBenchmarkScenario(clarificationSafetyWriteScenario).length > 0,
  "clarification must remain non-executing",
);

const REPORT_PHASE_IDS = Object.freeze({
  "conversation-general": Object.freeze(["route-decision", "chat-response"]),
  "weather-readonly": Object.freeze(["route-decision"]),
  "vehicle-knowledge": Object.freeze(["route-decision", "knowledge-answer"]),
  "vehicle-control-safe": Object.freeze(["route-decision"]),
  "vehicle-control-unsafe": Object.freeze(["route-decision"]),
});

const STABILITY_FAULTS = Object.freeze({
  "conversation-general:1": Object.freeze({
    faultId: "goal-formation-timeout", stage: "goal-formation", target: "structured-model",
    code: "generation-timeout", retryable: true, simulated: true,
  }),
  "conversation-general:2": Object.freeze({
    faultId: "task-planning-timeout", stage: "task-planning", target: "structured-model",
    code: "generation-timeout", retryable: true, simulated: true,
  }),
  "vehicle-knowledge:1": Object.freeze({
    faultId: "vehicle-knowledge-rag-unavailable", stage: "vehicle-knowledge-rag", target: "manual-rag",
    code: "rag-unavailable", retryable: true, simulated: true,
  }),
  "weather-readonly:1": Object.freeze({
    faultId: "weather-timeout", stage: "weather-adapter", target: "weather-adapter",
    code: "weather-timeout", retryable: true, simulated: true,
  }),
  "vehicle-control-safe:1": Object.freeze({
    faultId: "vehicle-confirmation-timeout", stage: "sensor-confirmation", target: "demo-sensor-submission",
    code: "sensor-timeout", retryable: true, simulated: true,
  }),
});

function publicEvidence(runId, externalModelRequestCount, modelCallCount = externalModelRequestCount) {
  return {
    runId,
    resultVisibleRunId: runId,
    firstFeedbackObserved: true,
    resultVisible: true,
    observedModelRequestCount: modelCallCount,
    observedExternalModelRequestCount: externalModelRequestCount,
    instrumentation: {
      modelRequestCount: true,
      externalModelRequestCount: true,
      safetyCallCount: true,
      toolCallCount: true,
      adapterAcceptedCount: true,
      providerCallCount: true,
      providerAcceptedCount: true,
      providerStateChangeCount: true,
      complete: true,
    },
    visibleCardKinds: ["b2-plan"],
    interactionRunIds: [runId],
    counters: {
      safetyCallCount: 0,
      toolCallCount: 0,
      adapterAcceptedCount: 0,
      providerCallCount: 0,
      providerAcceptedCount: 0,
      providerStateChangeCount: 0,
    },
    events: [{
      eventId: `event:${runId}:1`,
      parentEventId: null,
      sequence: 1,
      component: "runtimeKernel",
      componentType: "deterministic-service",
      phase: "intake",
      status: "completed",
      refs: [],
      reasonCode: null,
      durationMs: null,
    }, {
      eventId: `event:${runId}:2`,
      parentEventId: `event:${runId}:1`,
      sequence: 2,
      component: "vehicleSluModel",
      componentType: "model-service",
      phase: "route-decision",
      status: "completed",
      refs: [],
      reasonCode: null,
      durationMs: 20,
    }, {
      eventId: `event:${runId}:3`,
      parentEventId: `event:${runId}:2`,
      sequence: 3,
      component: "cabinAssistant",
      componentType: "ai-agent",
      phase: "final-response",
      status: "completed",
      refs: [],
      reasonCode: null,
      durationMs: null,
    }],
    result: {
      safetyAllowed: null,
      toolCallPresent: false,
      toolResultPresent: false,
      executionState: null,
      toolCommandId: null,
      resultCommandId: null,
      snapshotId: null,
      confirmedSnapshotId: null,
      snapshotCapturedAt: null,
      executionTrace: [],
    },
    animationConfirmed: false,
    animationCommandId: null,
  };
}

function projectedMetrics(scenarioId, durationMs, modelRequests, outcome = "passed", category = "answered") {
  return {
    outcome,
    contractErrors: outcome === "passed" ? [] : ["fixture failure"],
    eventSequenceErrors: [],
    budgetErrors: [],
    durationMs,
    modelRequests,
    modelCallCount: modelRequests,
    submissionToFirstFeedbackMs: 20,
    submissionToResultVisibleMs: 80,
    phases: Object.fromEntries(REPORT_PHASE_IDS[scenarioId].map((phaseId, index) => [
      phaseId,
      { value: index === 1 ? 250 : 100 },
    ])),
    slowestPhase: REPORT_PHASE_IDS[scenarioId].length > 0
      ? { phaseId: REPORT_PHASE_IDS[scenarioId][0], durationMs: 100 }
      : null,
    animation: { value: null, reason: "animation-not-required" },
    voice: null,
    behavior: {
      resultCategory: category,
      dispatchAuthorized: false,
      adapterExecutions: 0,
      vehicleToolCalls: 0,
      vehicleWrites: 0,
      safetyWriteDecisions: 0,
      providerConfirmation: false,
      unsafeProviderExecution: false,
      executionFactsComplete: true,
    },
  };
}

function finalSample({ scenarioId, runId, startedAt, completedAt, modelRequests }) {
  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
  const projected = projectedMetrics(scenarioId, durationMs, modelRequests);
  return {
    sampleId: `${scenarioId}:1`,
    runId,
    scenarioId,
    repeat: 1,
    outcome: "passed",
    timestamps: { startedAt, completedAt },
    metrics: { durationMs, modelRequests, modelCallCount: modelRequests },
    result: { category: "answered" },
    eventRefs: [`run-event:${scenarioId}`],
    simulated: true,
    diagnostics: { code: "none", publicHmiEvidence: publicEvidence(runId, modelRequests) },
    projectedMetrics: projected,
  };
}

function stabilitySample(sampleId, index) {
  const [scenarioId, repeatText] = sampleId.split(":");
  const repeat = Number(repeatText);
  const runId = `fixture-stability-${scenarioId}-${repeat}`;
  const sample = finalSample({
    scenarioId,
    runId,
    startedAt: `2026-08-03T00:00:0${index}.000Z`,
    completedAt: `2026-08-03T00:00:0${index + 1}.000Z`,
    modelRequests: B4_BENCHMARK_SCENARIOS[scenarioId].modelBudget.maxCalls,
  });
  sample.sampleId = sampleId;
  sample.repeat = repeat;
  sample.eventRefs = [`run-event:${sampleId}`];
  sample.diagnostics.benchmarkFaultReceipt = { ...STABILITY_FAULTS[sampleId] };
  if (scenarioId === "vehicle-control-safe") {
    const commandId = "command:stability-safe";
    const snapshotId = "snapshot:stability-safe";
    sample.result.category = "executed";
    sample.projectedMetrics.behavior = {
      resultCategory: "executed",
      dispatchAuthorized: true,
      adapterExecutions: 1,
      vehicleToolCalls: 1,
      vehicleWrites: 1,
      safetyWriteDecisions: 1,
      providerConfirmation: true,
      unsafeProviderExecution: false,
      executionFactsComplete: true,
    };
    sample.projectedMetrics.animation = { value: true };
    sample.diagnostics.publicHmiEvidence.interactionRunIds = [
      "fixture-stability-vehicle-control-safe-challenge", runId,
    ];
    sample.diagnostics.publicHmiEvidence.counters = {
      safetyCallCount: 1,
      toolCallCount: 1,
      adapterAcceptedCount: 1,
      providerCallCount: 1,
      providerAcceptedCount: 1,
      providerStateChangeCount: 1,
    };
    sample.diagnostics.publicHmiEvidence.result = {
      safetyAllowed: true,
      toolCallPresent: true,
      toolResultPresent: true,
      executionState: "observed-succeeded",
      toolCommandId: commandId,
      resultCommandId: commandId,
      snapshotId,
      confirmedSnapshotId: snapshotId,
      snapshotCapturedAt: "2026-08-03T00:00:05.000Z",
      executionTrace: [{
        state: "observed-succeeded",
        at: "2026-08-03T00:00:05.000Z",
        source: "demo-sensor-provider",
      }],
    };
    sample.diagnostics.publicHmiEvidence.animationConfirmed = true;
    sample.diagnostics.publicHmiEvidence.animationCommandId = commandId;
  }
  return sample;
}

const validReport = {
  protocol: RUN_BENCHMARK_REPORT,
  suite: RUN_BENCHMARK_SUITE,
  reportId: "fixture-report-1",
  profile: "cold-diagnostic",
  generatedAt: "2026-08-03T00:00:00.000Z",
  environment: {
    commitSha: "fixture-sha",
    dirtyWorktree: false,
    platform: "darwin",
    arch: "arm64",
    osRelease: "24.0.0",
    cpuModel: "Apple M4",
    profile: "cold-diagnostic",
    providerIds: ["dashscope"],
    modelIds: ["qwen-plus-2025-12-01"],
    regionIds: ["cn-beijing"],
    timeoutConfig: { phaseTimeoutMs: 90_000, transportTimeoutMs: 90_000, scenarioTimeoutMs: 360_000 },
    serviceConfig: { requiredServiceIds: ["agent-server"], readinessTimeoutMs: 1_000 },
    serviceReadiness: [{ serviceId: "agent-server", status: "ready", checkedAt: "2026-08-03T00:00:00.000Z" }],
    coldStartProof: { status: "observed", verifiedAt: "2026-08-03T00:00:00.000Z", serviceIds: ["agent-server"] },
  },
  samples: [
    finalSample({
      scenarioId: "conversation-general",
      runId: "fixture-run-general",
      startedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:00:01.000Z",
      modelRequests: 1,
    }),
    finalSample({
      scenarioId: "vehicle-knowledge",
      runId: "fixture-run-knowledge",
      startedAt: "2026-08-03T00:00:01.000Z",
      completedAt: "2026-08-03T00:00:02.000Z",
      modelRequests: 1,
    }),
  ],
  summary: { sampleCount: 2, passedSamples: 2, failedSamples: 0 },
  behaviorGate: { outcome: "passed", scenarioIds: ["conversation-general", "vehicle-knowledge"] },
  outcome: "passed",
  metrics: {
    durationMs: { count: 2, min: 1_000, median: 1_000, max: 1_000, p95: null },
    modelRequests: { count: 2, min: 1, median: 1, max: 1, p95: null },
  },
  scenarios: [{
    scenarioId: "conversation-general",
    count: 1,
    durationMs: { count: 1, min: 1_000, median: 1_000, max: 1_000, p95: null },
    slowestPhase: { phaseId: "task-planning", durationMs: 250 },
    behaviorOutcome: "answered",
    degradedReasons: [],
  }, {
    scenarioId: "vehicle-knowledge",
    count: 1,
    durationMs: { count: 1, min: 1_000, median: 1_000, max: 1_000, p95: null },
    slowestPhase: { phaseId: "task-planning", durationMs: 250 },
    behaviorOutcome: "answered",
    degradedReasons: [],
  }],
  comparison: { status: "not-compared" },
};
assert.deepEqual(validateBenchmarkReport(validReport), []);

const validUnsafeControlSample = finalSample({
  scenarioId: "vehicle-control-unsafe",
  runId: "fixture-run-unsafe-control",
  startedAt: "2026-08-03T00:00:02.000Z",
  completedAt: "2026-08-03T00:00:03.000Z",
  modelRequests: 0,
});
validUnsafeControlSample.result.category = "blocked";
validUnsafeControlSample.metrics.modelCallCount = 1;
validUnsafeControlSample.projectedMetrics.modelCallCount = 1;
validUnsafeControlSample.projectedMetrics.phases["route-decision"] = { value: 20 };
validUnsafeControlSample.projectedMetrics.slowestPhase = { phaseId: "route-decision", durationMs: 20 };
validUnsafeControlSample.diagnostics.publicHmiEvidence.observedModelRequestCount = 1;
validUnsafeControlSample.projectedMetrics.behavior = {
  resultCategory: "blocked",
  dispatchAuthorized: false,
  adapterExecutions: 0,
  vehicleToolCalls: 0,
  vehicleWrites: 0,
  safetyWriteDecisions: 0,
  providerConfirmation: false,
  unsafeProviderExecution: false,
  executionFactsComplete: true,
};
validUnsafeControlSample.diagnostics.publicHmiEvidence.counters.safetyCallCount = 1;
validUnsafeControlSample.diagnostics.publicHmiEvidence.result.safetyAllowed = false;
validUnsafeControlSample.diagnostics.publicHmiEvidence.result.toolCallPresent = true;
validUnsafeControlSample.diagnostics.publicHmiEvidence.result.toolCommandId = "command:rejected-before-dispatch";
assert.deepEqual(
  validateFinalBenchmarkSample(validUnsafeControlSample, { profile: "functional-smoke" }),
  [],
  "a Runtime ToolCall rejected by Safety before dispatch must remain a valid unsafe-control sample",
);

const mismatchedRuntimeAndExternalCounts = structuredClone(validReport.samples[0]);
mismatchedRuntimeAndExternalCounts.metrics.modelCallCount = 0;
mismatchedRuntimeAndExternalCounts.projectedMetrics.modelCallCount = 0;
assert.ok(
  validateFinalBenchmarkSample(mismatchedRuntimeAndExternalCounts, { profile: "cold-diagnostic" })
    .some((error) => /model.*count|request.*count|external.*count|match/i.test(error)),
  "a passed sample must bind Runtime model calls to the independent model phase request count",
);

const positiveBudgetWithoutSlowestPhase = structuredClone(validReport.samples[0]);
positiveBudgetWithoutSlowestPhase.projectedMetrics.slowestPhase = null;
assert.ok(
  validateFinalBenchmarkSample(positiveBudgetWithoutSlowestPhase, { profile: "cold-diagnostic" })
    .some((error) => /slowest|phase|duration/i.test(error)),
  "an actual positive model call count must retain one verifiable slowest allowed phase",
);

const positiveBudgetWithoutPhaseDuration = structuredClone(validReport.samples[0]);
positiveBudgetWithoutPhaseDuration.projectedMetrics.phases["chat-response"] = {
  value: null,
  reason: "phase-duration-unavailable",
};
positiveBudgetWithoutPhaseDuration.projectedMetrics.slowestPhase = null;
assert.ok(
  validateFinalBenchmarkSample(positiveBudgetWithoutPhaseDuration, { profile: "cold-diagnostic" })
    .some((error) => /slowest|phase|duration/i.test(error)),
  "an actual positive model call count must retain an observed allowed phase duration",
);

const zeroActualCallsUnderPositiveCap = structuredClone(validReport.samples[0]);
zeroActualCallsUnderPositiveCap.outcome = "contract-failed";
zeroActualCallsUnderPositiveCap.metrics.modelRequests = 0;
zeroActualCallsUnderPositiveCap.metrics.modelCallCount = 0;
zeroActualCallsUnderPositiveCap.projectedMetrics.outcome = "contract-failed";
zeroActualCallsUnderPositiveCap.projectedMetrics.contractErrors = ["fixture contract failure"];
zeroActualCallsUnderPositiveCap.projectedMetrics.modelRequests = 0;
zeroActualCallsUnderPositiveCap.projectedMetrics.modelCallCount = 0;
zeroActualCallsUnderPositiveCap.projectedMetrics.phases["chat-response"] = {
  value: null,
  reason: "phase-not-observed",
};
zeroActualCallsUnderPositiveCap.projectedMetrics.slowestPhase = null;
zeroActualCallsUnderPositiveCap.diagnostics.code = "contract-failed";
zeroActualCallsUnderPositiveCap.diagnostics.publicHmiEvidence.observedModelRequestCount = 0;
zeroActualCallsUnderPositiveCap.diagnostics.publicHmiEvidence.observedExternalModelRequestCount = 0;
assert.deepEqual(
  validateFinalBenchmarkSample(zeroActualCallsUnderPositiveCap, { profile: "cold-diagnostic" }),
  [],
  "maxCalls is only a cap: an actual zero-call failed sample may retain unavailable phases and null slowestPhase",
);

const cachedProviderSample = structuredClone(validReport.samples[0]);
cachedProviderSample.metrics.modelRequests = 0;
cachedProviderSample.projectedMetrics.modelRequests = 0;
cachedProviderSample.diagnostics.publicHmiEvidence.observedExternalModelRequestCount = 0;
assert.deepEqual(
  validateFinalBenchmarkSample(cachedProviderSample, { profile: "cold-diagnostic" }),
  [],
  "a passing cached model phase may have fewer Provider requests than Runtime model calls",
);

function nonpassingExecutionFixture() {
  const sample = structuredClone(validReport.samples[0]);
  sample.outcome = "contract-failed";
  sample.projectedMetrics.outcome = "contract-failed";
  sample.projectedMetrics.contractErrors = ["execution instrumentation unavailable"];
  sample.diagnostics.code = "contract-failed";
  sample.diagnostics.publicHmiEvidence.instrumentation.complete = false;
  return sample;
}

const incompleteExecutionFactsSample = nonpassingExecutionFixture();
incompleteExecutionFactsSample.diagnostics.publicHmiEvidence.instrumentation.toolCallCount = false;
incompleteExecutionFactsSample.diagnostics.publicHmiEvidence.counters.toolCallCount = null;
incompleteExecutionFactsSample.projectedMetrics.behavior = {
  ...incompleteExecutionFactsSample.projectedMetrics.behavior,
  dispatchAuthorized: null,
  adapterExecutions: null,
  vehicleToolCalls: null,
  vehicleWrites: null,
  executionFactsComplete: false,
};
assert.deepEqual(
  validateFinalBenchmarkSample(incompleteExecutionFactsSample, { profile: "cold-diagnostic" }),
  [],
  "one unavailable execution counter must project every execution count and dispatch as unavailable",
);

const missingSafetyCounterSample = nonpassingExecutionFixture();
missingSafetyCounterSample.diagnostics.publicHmiEvidence.instrumentation.safetyCallCount = false;
missingSafetyCounterSample.diagnostics.publicHmiEvidence.counters.safetyCallCount = null;
assert.deepEqual(
  validateFinalBenchmarkSample(missingSafetyCounterSample, { profile: "cold-diagnostic" }),
  [],
  "the safety counter is not one of the five facts that define executionFactsComplete",
);

const forgedZeroModelRequestSummary = structuredClone(validReport);
forgedZeroModelRequestSummary.metrics.modelRequests = {
  count: 2, min: 0, median: 0, max: 0, p95: null,
};
assert.ok(
  validateBenchmarkReport(forgedZeroModelRequestSummary)
    .some((error) => /modelRequests|summar|sample/i.test(error)),
  "report validation must recompute modelRequests instead of accepting a shape-valid forged zero summary",
);

const nullExternalCountReport = structuredClone(validReport);
nullExternalCountReport.samples[0].outcome = "contract-failed";
nullExternalCountReport.samples[0].metrics.modelRequests = null;
nullExternalCountReport.samples[0].projectedMetrics.outcome = "contract-failed";
nullExternalCountReport.samples[0].projectedMetrics.contractErrors = ["external telemetry unavailable"];
nullExternalCountReport.samples[0].projectedMetrics.modelRequests = null;
nullExternalCountReport.samples[0].diagnostics.code = "contract-failed";
nullExternalCountReport.samples[0].diagnostics.publicHmiEvidence.observedExternalModelRequestCount = null;
nullExternalCountReport.samples[0].diagnostics.publicHmiEvidence.instrumentation.externalModelRequestCount = false;
nullExternalCountReport.samples[0].diagnostics.publicHmiEvidence.instrumentation.complete = false;
nullExternalCountReport.summary = { sampleCount: 2, passedSamples: 1, failedSamples: 1 };
nullExternalCountReport.behaviorGate = {
  outcome: "blocked", scenarioIds: ["conversation-general", "vehicle-knowledge"],
};
nullExternalCountReport.outcome = "contract-failed";
nullExternalCountReport.metrics.modelRequests = {
  count: 2, min: 0, median: 5, max: 10, p95: null,
};
assert.ok(
  validateBenchmarkReport(nullExternalCountReport)
    .some((error) => /modelRequests|summar|sample/i.test(error)),
  "null external-call observations must be omitted instead of entering the summary as zero",
);

const stabilitySampleIds = Object.keys(STABILITY_FAULTS);
const stabilitySamples = stabilitySampleIds.map(stabilitySample);
const stabilityReport = {
  ...structuredClone(validReport),
  reportId: "fixture-stability-report",
  profile: "stability-faults",
  environment: {
    ...structuredClone(validReport.environment),
    profile: "stability-faults",
    coldStartProof: { status: "not-applicable", verifiedAt: null, serviceIds: [] },
  },
  samples: stabilitySamples,
  summary: { sampleCount: 5, passedSamples: 5, failedSamples: 0 },
  behaviorGate: {
    outcome: "passed",
    scenarioIds: ["conversation-general", "weather-readonly", "vehicle-knowledge", "vehicle-control-safe"],
  },
  metrics: {
    durationMs: { count: 5, min: 1_000, median: 1_000, max: 1_000, p95: null },
    modelRequests: { count: 5, min: 1, median: 2, max: 2, p95: null },
  },
  scenarios: [
    ["conversation-general", 2, "answered"],
    ["weather-readonly", 1, "answered"],
    ["vehicle-knowledge", 1, "answered"],
    ["vehicle-control-safe", 1, "executed"],
  ].map(([scenarioId, count, behaviorOutcome]) => ({
    scenarioId,
    count,
    durationMs: { count, min: 1_000, median: 1_000, max: 1_000, p95: null },
    slowestPhase: { phaseId: "task-planning", durationMs: 250 },
    behaviorOutcome,
    degradedReasons: [],
  })),
};
assert.deepEqual(
  validateBenchmarkReport(stabilityReport),
  [],
  "the complete five-sample stability fault plan must validate",
);
const missingStabilityReceipt = structuredClone(stabilityReport);
delete missingStabilityReceipt.samples[0].diagnostics.benchmarkFaultReceipt;
assert.ok(
  validateBenchmarkReport(missingStabilityReceipt).some((error) => /receipt|fault/i.test(error)),
  "each stability sample must carry its planned fault receipt",
);
const swappedStabilityReceipt = structuredClone(stabilityReport);
swappedStabilityReceipt.samples[0].diagnostics.benchmarkFaultReceipt = {
  ...STABILITY_FAULTS["conversation-general:2"],
};
assert.ok(
  validateBenchmarkReport(swappedStabilityReceipt).some((error) => /receipt|fault|planned/i.test(error)),
  "a stability sample must reject another planned sample's receipt",
);
const extendedStabilityReceipt = structuredClone(stabilityReport);
extendedStabilityReceipt.samples[0].diagnostics.benchmarkFaultReceipt.note = "forbidden";
assert.ok(
  validateBenchmarkReport(extendedStabilityReceipt).some((error) => /allowed|exact|receipt|field|key/i.test(error)),
  "stability fault receipts must reject extra keys",
);
const unplannedStabilitySample = structuredClone(stabilityReport);
unplannedStabilitySample.samples[0].sampleId = "conversation-general:3";
unplannedStabilitySample.samples[0].repeat = 3;
assert.ok(
  validateBenchmarkReport(unplannedStabilitySample).some((error) => /planned fault|planned sample|sample set/i.test(error)),
  "stability samples outside the five-entry fault plan must be rejected at sample validation",
);

function assertReportMutationRejected(label, mutate) {
  const candidate = structuredClone(validReport);
  mutate(candidate);
  assert.ok(
    validateBenchmarkReport(candidate).some((error) => /allowed|canonical|exact|sample|field|key/i.test(error)),
    `report validator must reject ${label}`,
  );
}

for (const [label, mutate] of [
  ["a safe-named report payload", (report) => { report.note = "raw response"; }],
  ["a safe-named sample payload", (report) => { report.samples[0].note = "raw response"; }],
  ["a projected response payload", (report) => {
    report.samples[0].projectedMetrics.responseText = "raw response";
  }],
  ["a diagnostics payload", (report) => { report.samples[0].diagnostics.note = "raw response"; }],
  ["a public evidence payload", (report) => {
    report.samples[0].diagnostics.publicHmiEvidence.note = "raw response";
  }],
]) {
  assertReportMutationRejected(label, mutate);
}

function passingReportWithSamples(samples) {
  return {
    ...validReport,
    samples,
    summary: { sampleCount: samples.length, passedSamples: samples.length, failedSamples: 0 },
  };
}

assert.ok(
  validateBenchmarkReport(passingReportWithSamples([
    ...structuredClone(validReport.samples),
    structuredClone(validReport.samples[0]),
  ])).some((error) => /duplicate|exact|planned|sample/i.test(error)),
  "passing reports must reject a duplicate planned scenario/repeat",
);
const contractExtraRepeat = structuredClone(validReport.samples[0]);
contractExtraRepeat.sampleId = "conversation-general:2";
contractExtraRepeat.repeat = 2;
contractExtraRepeat.runId = "fixture-run-general-2";
contractExtraRepeat.diagnostics.publicHmiEvidence.runId = contractExtraRepeat.runId;
contractExtraRepeat.diagnostics.publicHmiEvidence.resultVisibleRunId = contractExtraRepeat.runId;
contractExtraRepeat.diagnostics.publicHmiEvidence.interactionRunIds = [contractExtraRepeat.runId];
assert.ok(
  validateBenchmarkReport(passingReportWithSamples([
    ...structuredClone(validReport.samples), contractExtraRepeat,
  ])).some((error) => /extra|exact|planned|sample/i.test(error)),
  "passing reports must reject an extra repeat",
);
const contractDuplicateSampleId = structuredClone(validReport);
contractDuplicateSampleId.samples[1].sampleId = contractDuplicateSampleId.samples[0].sampleId;
assert.ok(
  validateBenchmarkReport(contractDuplicateSampleId).some((error) => /sampleId|canonical|duplicate/i.test(error)),
  "reports must reject duplicate sample IDs",
);
const contractMismatchedSampleId = structuredClone(validReport);
contractMismatchedSampleId.samples[0].sampleId = "fixture-safe-id";
assert.ok(
  validateBenchmarkReport(contractMismatchedSampleId).some((error) => /sampleId|canonical/i.test(error)),
  "reports must reject a non-canonical sample ID",
);

for (const environment of [
  { ...validReport.environment, timeoutConfig: { ...validReport.environment.timeoutConfig, fullCommand: "forbidden" } },
  { ...validReport.environment, serviceConfig: { ...validReport.environment.serviceConfig, envDump: "forbidden" } },
  { ...validReport.environment, serviceReadiness: [{ ...validReport.environment.serviceReadiness[0], output: "forbidden" }] },
  { ...validReport.environment, coldStartProof: { ...validReport.environment.coldStartProof, auth: "forbidden" } },
]) {
  assert.ok(
    validateBenchmarkReport({ ...validReport, environment })
      .includes("environment nested metadata must contain only allowed fields"),
    "environment nested metadata must reject an unallowlisted field",
  );
}

assert.ok(
  validateBenchmarkReport({ ...validReport, serviceReadiness: validReport.environment.serviceReadiness })
    .includes("serviceReadiness must be stored only in environment"),
  "reports must not duplicate readiness evidence outside the environment summary",
);
assert.ok(
  validateBenchmarkReport({
    ...validReport,
    environment: {
      ...validReport.environment,
      serviceReadiness: [{ ...validReport.environment.serviceReadiness[0], status: "blocked" }],
    },
  }).includes("passing reports require every required service to be ready"),
  "passing reports must not accept a blocked required service",
);
assert.ok(
  validateBenchmarkReport({
    ...validReport,
    environment: {
      ...validReport.environment,
      serviceReadiness: [
        { serviceId: "agent-server", status: "blocked", checkedAt: "2026-08-03T00:00:00.000Z" },
        { serviceId: "agent-server", status: "ready", checkedAt: "2026-08-03T00:00:00.000Z" },
      ],
    },
  }).includes("passing reports require every required service to be ready"),
  "a duplicate blocked readiness observation must not be masked by a later ready observation",
);
assert.ok(
  validateBenchmarkReport({
    ...validReport,
    environment: {
      ...validReport.environment,
      coldStartProof: { status: "not-applicable", verifiedAt: null, serviceIds: [] },
    },
  }).includes("cold-diagnostic reports require cold-start evidence or an explicit unverified result"),
  "cold diagnostics must not claim cold-start proof is inapplicable",
);
assert.ok(
  validateBenchmarkReport({
    ...validReport,
    profile: "warm-baseline",
    environment: {
      ...validReport.environment,
      profile: "warm-baseline",
      coldStartProof: { status: "unverified", verifiedAt: null, serviceIds: ["agent-server"] },
    },
    behaviorGate: { outcome: "blocked", scenarioIds: ["conversation-general", "vehicle-knowledge"] },
    outcome: "blocked",
  }).includes("non-cold profiles must use a not-applicable cold-start proof"),
  "warm reports must not preserve cold-start states",
);
assert.ok(
  validateBenchmarkReport({ ...validReport, environment: { ...validReport.environment, cwd: "/private" } })
    .includes("environment must contain only allowed execution metadata"),
  "environment summaries must reject a working-directory field",
);

assert.ok(
  validateBenchmarkReport({}).includes("protocol must equal RUN_BENCHMARK_REPORT"),
  "reports without the versioned protocol must fail validation",
);
assert.ok(
  validateBenchmarkReport({ ...validReport, samples: [] }).includes("samples must contain at least one valid benchmark sample"),
  "reports without execution evidence must fail validation",
);
assert.ok(
  validateBenchmarkReport({ ...validReport, outcome: "completed" }).includes("outcome must be a supported report outcome"),
  "reports with an unknown outcome must fail validation",
);
assert.ok(
  validateBenchmarkReport({ ...validReport, samples: validReport.samples.slice(0, 1) })
    .includes("passed reports must contain a passed sample for every profile scenario repeat"),
  "passed reports must prove every configured scenario repeat",
);
assert.ok(
  validateBenchmarkReport({ ...validReport, behaviorGate: { outcome: "passed", scenarioIds: ["conversation-general"] } })
    .includes("passed behaviorGate must cover every profile scenario"),
  "a passed behavior gate must cover every configured scenario",
);
assert.ok(
  validateBenchmarkReport({ ...validReport, generatedAt: "August 3, 2026" }).includes("generatedAt must be an ISO-8601 timestamp"),
  "human-readable dates must not pass ISO timestamp validation",
);
assert.ok(
  validateBenchmarkReport({ ...validReport, environment: { ...validReport.environment, providerIds: [] } })
    .includes("environment must contain the required execution metadata"),
  "empty provider, model, and region identities must fail validation",
);
assert.ok(
  validateBenchmarkReport({ ...validReport, samples: [{ ...validReport.samples[0], metrics: {} }, validReport.samples[1]] })
    .includes("samples must contain valid benchmark samples"),
  "samples without derived metrics must fail validation",
);
assert.ok(
  validateBenchmarkReport({ ...validReport, diagnostics: { prompt: "sensitive" } }).includes("report must not contain sensitive fields"),
  "reports must reject sensitive fields",
);

const failedSampleReport = {
  ...validReport,
  samples: [{
    ...validReport.samples[0],
    outcome: "run-failed",
    result: { category: "blocked" },
    projectedMetrics: projectedMetrics("conversation-general", 1_000, 1, "run-failed", "blocked"),
  }, validReport.samples[1]],
  summary: { sampleCount: 2, passedSamples: 1, failedSamples: 1 },
  behaviorGate: { outcome: "harness-error", scenarioIds: ["conversation-general", "vehicle-knowledge"] },
  outcome: "harness-error",
};
assert.deepEqual(
  validateBenchmarkReport(failedSampleReport),
  [],
  "run-failed samples must preserve supported observed result categories",
);
const blockedSampleReport = {
  ...failedSampleReport,
  samples: failedSampleReport.samples.map((sample) => ({
    ...sample,
    outcome: "contract-failed",
    result: { category: "executed" },
    projectedMetrics: {
      ...sample.projectedMetrics,
      outcome: "contract-failed",
      contractErrors: ["fixture failure"],
      behavior: { ...sample.projectedMetrics.behavior, resultCategory: "executed" },
    },
  })),
  summary: { sampleCount: 2, passedSamples: 0, failedSamples: 2 },
  behaviorGate: { outcome: "blocked", scenarioIds: ["conversation-general", "vehicle-knowledge"] },
  outcome: "blocked",
};
assert.deepEqual(
  validateBenchmarkReport(blockedSampleReport),
  [],
  "contract-failed samples must preserve supported observed result categories",
);
assert.ok(
  validateBenchmarkReport({ ...failedSampleReport, behaviorGate: { ...failedSampleReport.behaviorGate, outcome: "passed" } })
    .includes("non-passing reports must not have a passed behaviorGate"),
  "non-passing suites must not claim a passed behavior gate",
);
const warningReport = {
  ...validReport,
  outcome: "passed-with-warning",
};
assert.deepEqual(
  validateBenchmarkReport(warningReport),
  [],
  "passed-with-warning reports must keep passed sample coverage and a passed behavior gate",
);
assert.ok(
  validateBenchmarkReport({
    ...warningReport,
    samples: [{
      ...warningReport.samples[0],
      outcome: "run-degraded",
      projectedMetrics: {
        ...warningReport.samples[0].projectedMetrics,
        outcome: "run-degraded",
        contractErrors: ["fixture failure"],
      },
    }, warningReport.samples[1]],
    summary: { sampleCount: 2, passedSamples: 1, failedSamples: 1 },
  }).includes("passed reports must contain a passed sample for every profile scenario repeat"),
  "passed-with-warning reports must not silently map a non-passed sample into coverage",
);

console.log(JSON.stringify({
  status: "PASS",
  verifier: "b4-benchmark-contract",
  scenarioCount: expectedScenarioIds.length,
}));
