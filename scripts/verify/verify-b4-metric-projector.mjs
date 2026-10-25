import assert from "node:assert/strict";
import {
  projectRunMetrics,
  validateBenchmarkEventSequence,
} from "../../src/benchmark/run-metric-projector.js";
import { getBenchmarkScenario } from "../../src/benchmark/run-benchmark-scenarios.js";

function debugEvent(sequence, phase, overrides = {}) {
  const timestamp = new Date(Date.parse("2026-08-03T00:00:00.000Z") + sequence * 100).toISOString();
  return {
    eventId: `event:metric-fixture:${sequence}`,
    parentEventId: sequence === 1 ? null : `event:metric-fixture:${sequence - 1}`,
    sequence,
    timestamp,
    component: "cabinModel",
    componentLabel: "Cabin Model",
    componentType: "model-service",
    observedMs: sequence * 100,
    observedAt: timestamp,
    phase,
    status: "completed",
    summary: `${phase} completed`,
    refs: [],
    durationMs: null,
    model: "fixture-model",
    provider: "fixture-provider",
    degraded: false,
    simulated: true,
    reasonCode: null,
    ...overrides,
  };
}

function completedRunFixture(overrides = {}) {
  return {
    requestId: "metric-fixture",
    startedAtPerf: 100,
    endedAtPerf: 900,
    error: "",
    result: {
      mode: "edge-model",
      parsedCommand: { needsClarification: false },
      vehicleStateSnapshot: { id: "snapshot:metric-fixture" },
      safetyDecision: null,
      toolCall: null,
      toolResult: null,
      routeDecision: { routeId: "vehicle-knowledge", mode: "direct" },
      runtimeTelemetry: {
        modelCallCount: 1,
        modelCalls: [{ phase: "knowledge-answer", telemetry: { durationMs: 120 } }],
      },
    },
    events: [
      debugEvent(1, "goal-formation", { observedMs: 120, durationMs: 120 }),
      debugEvent(2, "task-planning", { observedMs: 300 }),
      debugEvent(3, "task-planning", { observedMs: 360 }),
      debugEvent(4, "final-synthesis", { observedMs: 700, durationMs: 80 }),
    ],
    ...overrides,
  };
}

function executionObservation(overrides = {}) {
  return {
    submittedAtPerf: 100,
    firstFeedbackAtPerf: 140,
    resultVisibleAtPerf: 900,
    resultVisibleRunId: "metric-fixture",
    modelRequestCount: 0,
    externalModelRequestCount: 1,
    safetyCallCount: 0,
    toolCallCount: 0,
    adapterAcceptedCount: 0,
    providerCallCount: 0,
    providerAcceptedCount: 0,
    providerStateChangeCount: 0,
    ...overrides,
  };
}

const scenario = getBenchmarkScenario("vehicle-knowledge");
const metrics = projectRunMetrics({
  scenario,
  runDebug: completedRunFixture(),
  browserObservation: executionObservation({
    animationConfirmedAtPerf: null,
    animationCommandId: null,
  }),
  voiceObservation: null,
});
assert.equal(metrics.outcome, "passed");
assert.equal(metrics.submissionToFirstFeedbackMs, 40);
assert.equal(metrics.submissionToResultVisibleMs, 800);
assert.equal(metrics.durationMs, 800);
assert.equal(metrics.modelRequests, 1);
assert.equal(metrics.modelCallCount, 1);
assert.deepEqual(metrics.phases["knowledge-answer"], { value: 120 });
assert.deepEqual(metrics.slowestPhase, { phaseId: "knowledge-answer", durationMs: 120 });

const singlePhaseMetrics = projectRunMetrics({
  scenario,
  runDebug: completedRunFixture({
    events: [debugEvent(1, "goal-formation", { observedMs: 120 })],
  }),
  browserObservation: null,
  voiceObservation: null,
});
assert.deepEqual(singlePhaseMetrics.phases["knowledge-answer"], {
  value: 120,
});

assert.ok(
  validateBenchmarkEventSequence([
    debugEvent(1, "goal-formation"),
    debugEvent(2, "task-planning", { eventId: "event:metric-fixture:1" }),
  ]).some((error) => error.includes("duplicate eventId")),
  "duplicate event IDs must fail the benchmark event contract",
);
assert.ok(
  validateBenchmarkEventSequence([
    debugEvent(2, "goal-formation"),
    debugEvent(1, "task-planning"),
  ]).some((error) => error.includes("strictly increasing")),
  "non-increasing event sequence must fail the benchmark event contract",
);
assert.ok(
  validateBenchmarkEventSequence([
    debugEvent(1, "goal-formation", { parentEventId: "event:metric-fixture:2" }),
    debugEvent(2, "task-planning"),
  ]).some((error) => error.includes("parent must precede child")),
  "a parent after its child must fail the benchmark event contract",
);
assert.ok(
  validateBenchmarkEventSequence([
    debugEvent(1, "goal-formation", { parentEventId: "event:metric-fixture:1" }),
  ]).some((error) => error.includes("parent must precede child")),
  "a parent must be an earlier event, not the child itself",
);

const unsafeMetrics = projectRunMetrics({
  scenario: getBenchmarkScenario("vehicle-control-unsafe"),
  runDebug: completedRunFixture({
    result: {
      mode: "edge-model",
      parsedCommand: { needsClarification: false },
      vehicleStateSnapshot: { id: "snapshot:unsafe" },
      safetyDecision: { allowed: false },
      toolCall: { tool: "body.tailgate.open", dispatchAuthorized: true },
      toolResult: null,
    },
  }),
  browserObservation: executionObservation({
    toolCallCount: 1,
    adapterAcceptedCount: 0,
  }),
  voiceObservation: null,
});
assert.equal(unsafeMetrics.outcome, "contract-failed");
assert.ok(
  unsafeMetrics.contractErrors.includes("dispatch authorization violates scenario contract"),
  "unsafe dispatch authorization must fail closed",
);

const safetyAllowWithoutExecutionFacts = projectRunMetrics({
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  runDebug: completedRunFixture({
    result: {
      mode: "edge-model",
      parsedCommand: { needsClarification: false },
      vehicleStateSnapshot: { id: "snapshot:safety-only" },
      safetyDecision: { allowed: true },
      toolCall: { tool: "body.tailgate.open", commandId: "command:safety-only" },
      toolResult: {
        tool: "body.tailgate.open",
        commandId: "command:safety-only",
        executionState: "observed-succeeded",
        confirmedSnapshotId: "snapshot:safety-only",
      },
    },
  }),
  browserObservation: executionObservation({
    animationConfirmedAtPerf: 500,
    animationCommandId: "command:safety-only",
  }),
  voiceObservation: null,
});
assert.equal(safetyAllowWithoutExecutionFacts.outcome, "contract-failed",
  "Safety allow must not manufacture Tool, Adapter, or Provider execution facts");
assert.equal(safetyAllowWithoutExecutionFacts.behavior.dispatchAuthorized, false);
assert.equal(safetyAllowWithoutExecutionFacts.behavior.adapterExecutions, 0);
assert.equal(safetyAllowWithoutExecutionFacts.behavior.vehicleWrites, 0);
assert.equal(safetyAllowWithoutExecutionFacts.behavior.providerConfirmation, false);

const safetyRejectWithExecutionFacts = projectRunMetrics({
  scenario: getBenchmarkScenario("vehicle-control-unsafe"),
  runDebug: completedRunFixture({
    result: {
      mode: "edge-model",
      parsedCommand: { needsClarification: false },
      vehicleStateSnapshot: { id: "snapshot:unsafe-counter" },
      safetyDecision: { allowed: false },
      toolCall: null,
      toolResult: null,
    },
  }),
  browserObservation: executionObservation({
    toolCallCount: 1,
    adapterAcceptedCount: 1,
    providerCallCount: 1,
    providerAcceptedCount: 1,
    providerStateChangeCount: 1,
  }),
  voiceObservation: null,
});
assert.equal(safetyRejectWithExecutionFacts.outcome, "contract-failed",
  "execution counters must remain visible when Safety rejects");
assert.equal(safetyRejectWithExecutionFacts.behavior.dispatchAuthorized, true);
assert.equal(safetyRejectWithExecutionFacts.behavior.adapterExecutions, 1);
assert.equal(safetyRejectWithExecutionFacts.behavior.vehicleWrites, 1);

const confirmationWithoutProviderWrite = projectRunMetrics({
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  runDebug: completedRunFixture({
    result: {
      mode: "edge-model",
      parsedCommand: { needsClarification: false },
      vehicleStateSnapshot: { id: "snapshot:confirmed-without-write" },
      safetyDecision: { allowed: true },
      toolCall: { tool: "body.tailgate.open", commandId: "command:confirmed-without-write" },
      toolResult: {
        tool: "body.tailgate.open",
        commandId: "command:confirmed-without-write",
        executionState: "observed-succeeded",
        confirmedSnapshotId: "snapshot:confirmed-without-write",
      },
    },
  }),
  browserObservation: executionObservation({
    toolCallCount: 1,
    adapterAcceptedCount: 1,
    providerCallCount: 1,
    providerAcceptedCount: 1,
    providerStateChangeCount: 0,
    animationConfirmedAtPerf: 500,
    animationCommandId: "command:confirmed-without-write",
  }),
  voiceObservation: null,
});
assert.equal(confirmationWithoutProviderWrite.behavior.providerConfirmation, true,
  "Provider acceptance plus matching terminal proof must confirm independently");
assert.equal(confirmationWithoutProviderWrite.behavior.vehicleWrites, 0,
  "Provider confirmation must not manufacture a state-change fact");
assert.equal(confirmationWithoutProviderWrite.outcome, "contract-failed");

const missingExecutionCounters = projectRunMetrics({
  scenario: getBenchmarkScenario("conversation-general"),
  runDebug: completedRunFixture(),
  browserObservation: {
    submittedAtPerf: 100,
    firstFeedbackAtPerf: 140,
    resultVisibleAtPerf: 900,
    resultVisibleRunId: "metric-fixture",
  },
  voiceObservation: null,
});
assert.equal(missingExecutionCounters.outcome, "contract-failed",
  "missing independent execution counters must fail closed");

const mismatchedVisibleRun = projectRunMetrics({
  scenario: getBenchmarkScenario("conversation-general"),
  runDebug: completedRunFixture(),
  browserObservation: executionObservation({ resultVisibleRunId: "metric-fixture:first-turn" }),
  voiceObservation: null,
});
assert.equal(mismatchedVisibleRun.outcome, "contract-failed",
  "a visible first-turn result must not satisfy final Run ownership");

const unsafeClimateExecutionMetrics = projectRunMetrics({
  scenario: getBenchmarkScenario("vehicle-control-unsafe"),
  runDebug: completedRunFixture({
    result: {
      mode: "edge-model",
      parsedCommand: { needsClarification: false },
      vehicleStateSnapshot: { id: "snapshot:unsafe-climate" },
      safetyDecision: { allowed: false },
      toolCall: { tool: "cabin.climate.setPreset", args: {} },
      toolResult: {
        tool: "cabin.climate.setPreset",
        commandId: "command:unsafe-climate",
        executionState: "observed-succeeded",
        confirmedSnapshotId: "snapshot:unsafe-climate",
      },
    },
  }),
  browserObservation: executionObservation({
    toolCallCount: 1,
    adapterAcceptedCount: 1,
    providerCallCount: 1,
    providerAcceptedCount: 1,
    providerStateChangeCount: 1,
  }),
  voiceObservation: null,
});
assert.equal(unsafeClimateExecutionMetrics.outcome, "contract-failed");
assert.equal(unsafeClimateExecutionMetrics.behavior.adapterExecutions, 1);
assert.ok(
  unsafeClimateExecutionMetrics.contractErrors.includes("provider execution without safety authorization violates scenario contract"),
  "canonical climate vehicle tools must not hide unauthorized Provider execution",
);

for (const untrustedTool of ["__proto__", "toString"]) {
  const untrustedToolMetrics = projectRunMetrics({
    scenario: getBenchmarkScenario("vehicle-control-unsafe"),
    runDebug: completedRunFixture({
      result: {
        mode: "edge-model",
        routeDecision: { routeId: "vehicle-control", mode: "direct" },
        parsedCommand: { needsClarification: false },
        vehicleStateSnapshot: { id: `snapshot:${untrustedTool}` },
        runtimeTelemetry: { modelCallCount: 0, modelCalls: [] },
        safetyDecision: { allowed: false },
        toolCall: { tool: untrustedTool, args: {} },
        toolResult: {
          tool: untrustedTool,
          commandId: `command:${untrustedTool}`,
          executionState: "observed-succeeded",
          confirmedSnapshotId: `snapshot:${untrustedTool}`,
        },
      },
    }),
    browserObservation: executionObservation({ externalModelRequestCount: 0 }),
    voiceObservation: null,
  });
  assert.equal(untrustedToolMetrics.outcome, "passed");
  assert.equal(untrustedToolMetrics.behavior.adapterExecutions, 0);
  assert.equal(untrustedToolMetrics.behavior.vehicleToolCalls, 0);
}

function weatherRunResult(toolResultOverrides = {}, toolCallOverrides = {}) {
  return {
    mode: "edge-model",
    routeDecision: { routeId: "task", mode: "direct-capability" },
    parsedCommand: { slots: { needsClarification: false } },
    runtimeTelemetry: { modelCallCount: 0, modelCalls: [] },
    vehicleStateSnapshot: null,
    safetyDecision: null,
    toolCall: {
      requestId: "metric-fixture",
      commandId: "command:weather",
      tool: "conversation.general",
      requiresSafety: false,
      ...toolCallOverrides,
    },
    toolResult: {
      requestId: "metric-fixture",
      commandId: "command:weather",
      tool: "conversation.general",
      ok: true,
      executionState: "accepted",
      ...toolResultOverrides,
    },
  };
}

const completedWeatherRead = projectRunMetrics({
  scenario: getBenchmarkScenario("weather-readonly"),
  runDebug: completedRunFixture({ result: weatherRunResult() }),
  browserObservation: executionObservation({ externalModelRequestCount: 0 }),
  voiceObservation: null,
});
assert.equal(completedWeatherRead.behavior.resultCategory, "answered");
assert.equal(completedWeatherRead.outcome, "passed",
  "a matching successful read-only external Tool result must be classified as answered");

for (const [label, toolResultOverrides] of [
  ["failed", { ok: false, executionState: "failed" }],
  ["mismatched", { commandId: "command:other" }],
]) {
  const incompleteWeatherRead = projectRunMetrics({
    scenario: getBenchmarkScenario("weather-readonly"),
    runDebug: completedRunFixture({ result: weatherRunResult(toolResultOverrides) }),
    browserObservation: executionObservation({ externalModelRequestCount: 0 }),
    voiceObservation: null,
  });
  assert.equal(incompleteWeatherRead.behavior.resultCategory, "blocked", label);
  assert.equal(incompleteWeatherRead.outcome, "contract-failed", label);
}

for (const disguisedTool of ["body.tailgate.open", "filesystem.delete"]) {
  const disguisedReadOnlyTool = projectRunMetrics({
    scenario: getBenchmarkScenario("weather-readonly"),
    runDebug: completedRunFixture({
      result: weatherRunResult(
        { tool: disguisedTool },
        { tool: disguisedTool, requiresSafety: false },
      ),
    }),
    browserObservation: executionObservation({ externalModelRequestCount: 0 }),
    voiceObservation: null,
  });
  assert.equal(disguisedReadOnlyTool.behavior.resultCategory, "blocked", disguisedTool);
  assert.equal(disguisedReadOnlyTool.outcome, "contract-failed",
    `${disguisedTool} cannot masquerade as a completed weather answer`);
}

const borrowedWeatherResult = projectRunMetrics({
  scenario: getBenchmarkScenario("weather-readonly"),
  runDebug: completedRunFixture({
    result: weatherRunResult(
      { requestId: "metric-fixture:other" },
      { requestId: "metric-fixture:other" },
    ),
  }),
  browserObservation: executionObservation({ externalModelRequestCount: 0 }),
  voiceObservation: null,
});
assert.equal(borrowedWeatherResult.behavior.resultCategory, "blocked");
assert.equal(borrowedWeatherResult.outcome, "contract-failed",
  "a matching Tool result from another Run cannot satisfy the weather scenario");

const safetyRejectedWeatherResult = projectRunMetrics({
  scenario: getBenchmarkScenario("weather-readonly"),
  runDebug: completedRunFixture({
    result: {
      ...weatherRunResult(),
      safetyDecision: { allowed: false },
    },
  }),
  browserObservation: executionObservation({ externalModelRequestCount: 0 }),
  voiceObservation: null,
});
assert.equal(safetyRejectedWeatherResult.behavior.resultCategory, "blocked");
assert.equal(safetyRejectedWeatherResult.outcome, "contract-failed",
  "a Safety rejection must override an otherwise matching read-only Tool result");

for (const scenarioId of ["weather-readonly", "clarification"]) {
  const readonlyMetrics = projectRunMetrics({
    scenario: getBenchmarkScenario(scenarioId),
    runDebug: completedRunFixture({
      result: {
        mode: "edge-model",
        parsedCommand: { slots: { needsClarification: scenarioId === "clarification" } },
        vehicleStateSnapshot: { id: `snapshot:${scenarioId}` },
        safetyDecision: { allowed: true },
        toolCall: { tool: "body.tailgate.open", dispatchAuthorized: true },
        toolResult: {
          tool: "body.tailgate.open",
          commandId: `command:${scenarioId}`,
          executionState: "observed-succeeded",
          confirmedSnapshotId: `snapshot:${scenarioId}`,
        },
      },
    }),
    browserObservation: executionObservation({
      toolCallCount: 1,
      adapterAcceptedCount: 1,
      providerCallCount: 1,
      providerAcceptedCount: 1,
      providerStateChangeCount: 1,
    }),
    voiceObservation: null,
  });
  assert.equal(readonlyMetrics.outcome, "contract-failed");
  if (scenarioId === "clarification") {
    assert.equal(
      readonlyMetrics.behavior.resultCategory,
      "clarification",
      "the benchmark projector must read clarification from the RuntimeResult slots contract",
    );
  }
  assert.ok(
    readonlyMetrics.contractErrors.includes("vehicle writes violate scenario contract"),
    `${scenarioId} must fail when a vehicle write is observed`,
  );
}

const clarificationRuntimeMetrics = projectRunMetrics({
  scenario: getBenchmarkScenario("clarification"),
  runDebug: completedRunFixture({
    events: [],
    result: {
      mode: "edge-model",
      routeDecision: { routeId: null, mode: null },
      parsedCommand: { slots: { needsClarification: true } },
      runtimeTelemetry: { modelCallCount: 0, modelCalls: [] },
      vehicleStateSnapshot: { id: "snapshot:clarification-runtime" },
      safetyDecision: null,
      toolCall: null,
      toolResult: null,
    },
  }),
  browserObservation: executionObservation({ externalModelRequestCount: 0 }),
  voiceObservation: null,
});
assert.equal(clarificationRuntimeMetrics.behavior.resultCategory, "clarification");
assert.equal(clarificationRuntimeMetrics.outcome, "passed",
  "a real RuntimeResult clarification shape with zero execution must satisfy the scenario contract");

const animationMismatchMetrics = projectRunMetrics({
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  runDebug: completedRunFixture({
    result: {
      mode: "edge-model",
      parsedCommand: { needsClarification: false },
      vehicleStateSnapshot: { id: "snapshot:safe" },
      safetyDecision: { allowed: true },
      toolCall: { tool: "body.tailgate.open" },
      toolResult: {
        tool: "body.tailgate.open",
        commandId: "command:safe",
        executionState: "observed-succeeded",
        confirmedSnapshotId: "snapshot:safe",
      },
    },
  }),
  browserObservation: {
    ...executionObservation({
      toolCallCount: 1,
      adapterAcceptedCount: 1,
      providerCallCount: 1,
      providerAcceptedCount: 1,
      providerStateChangeCount: 1,
    }),
    animationConfirmedAtPerf: 500,
    animationCommandId: "command:other",
  },
  voiceObservation: null,
});
assert.deepEqual(animationMismatchMetrics.animation, {
  value: false,
  reason: "animation-command-id-mismatch",
});
assert.equal(animationMismatchMetrics.outcome, "contract-failed");
assert.ok(
  animationMismatchMetrics.contractErrors.includes("animation confirmation violates scenario contract"),
  "provider-confirmed animations must match the executed command ID",
);

const animationMissingCommandIdMetrics = projectRunMetrics({
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  runDebug: completedRunFixture({
    result: {
      mode: "edge-model",
      parsedCommand: { needsClarification: false },
      vehicleStateSnapshot: { id: "snapshot:missing-command" },
      safetyDecision: { allowed: true },
      toolCall: { tool: "body.tailgate.open", args: {} },
      toolResult: {
        tool: "body.tailgate.open",
        executionState: "observed-succeeded",
        confirmedSnapshotId: "snapshot:missing-command",
      },
    },
  }),
  browserObservation: executionObservation({
    toolCallCount: 1,
    adapterAcceptedCount: 1,
    providerCallCount: 1,
    providerAcceptedCount: 1,
    providerStateChangeCount: 1,
    animationConfirmedAtPerf: 500,
  }),
  voiceObservation: null,
});
assert.deepEqual(animationMissingCommandIdMetrics.animation, {
  value: false,
  reason: "animation-command-id-unavailable",
});
assert.equal(animationMissingCommandIdMetrics.outcome, "contract-failed");

console.log(JSON.stringify({
  outcome: metrics.outcome,
  modelRequests: metrics.modelRequests,
  sequenceChecks: 4,
  behaviorChecks: 8,
}));
