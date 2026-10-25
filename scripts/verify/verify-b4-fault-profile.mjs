import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BENCHMARK_FAULT_PROFILE,
  buildBenchmarkVehicleFaultReceipt,
  captureBenchmarkSensorSubmissionMarkers,
  observeBenchmarkCoordinatorSettlement,
  observeBenchmarkSensorSubmission,
  projectBenchmarkVehicleEvidence,
  resetBenchmarkRunEvidenceState,
  resolveBenchmarkFaultProfile,
  verifyBenchmarkFaultReceipt,
} from "../../src/benchmark/benchmark-fault-profile.js";
import { CloudLLMAdapter } from "../../src/runtime/cloud-llm-adapter.js";
import {
  buildBenchmarkModelError,
  resolveBenchmarkFaultRequest,
} from "../../src/server/local-agent-server.mjs";
import { getBenchmarkScenario } from "../../src/benchmark/run-benchmark-scenarios.js";
import {
  B4_FAULT_CASES,
  assertFaultCaseBoundary,
  assertResumeCompatible,
  buildRunPlan,
  createPartialCheckpoint,
  executeMeasuredSamples,
  projectFaultCaseObservation,
} from "../benchmarks/run-b4-baseline.mjs";

const FAULT_IDS = Object.freeze([
  "goal-formation-timeout",
  "task-planning-timeout",
  "vehicle-knowledge-rag-unavailable",
  "weather-timeout",
  "vehicle-confirmation-timeout",
]);

assert.deepEqual(Object.keys(BENCHMARK_FAULT_PROFILE), FAULT_IDS);
assert.throws(
  () => resolveBenchmarkFaultProfile("goal-formation-timeout", { enabled: false }),
  /benchmark faults are disabled/,
);
assert.throws(
  () => resolveBenchmarkFaultProfile("safety-allow", { enabled: true }),
  /unknown benchmark fault/,
);
assert.equal(
  resolveBenchmarkFaultProfile("weather-timeout", { enabled: true }).sideEffectClass,
  "readonly",
);

for (const id of FAULT_IDS) {
  const profile = resolveBenchmarkFaultProfile(id, { enabled: true });
  assert.equal(profile.id, id);
  assert.equal(Object.isFrozen(profile), true);
  assert.deepEqual(Object.keys(profile).sort(), [
    "code", "id", "retryable", "sideEffectClass", "stage", "target",
  ]);
}

const forbiddenFaultOutputKey = /^(?:allowed?|reject(?:ed)?|dispatchAuthorized|toolAuthorization|providerSnapshot|commandId|vehicleStatePatch)$/i;
function assertNoForbiddenFaultOutput(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.doesNotMatch(key, forbiddenFaultOutputKey, `fault output must not own ${key}`);
    assertNoForbiddenFaultOutput(nested);
  }
}
assertNoForbiddenFaultOutput(BENCHMARK_FAULT_PROFILE);

function receiptFor(id, overrides = {}) {
  const profile = resolveBenchmarkFaultProfile(id, { enabled: true });
  return {
    benchmarkFaultId: profile.id,
    stage: profile.stage,
    target: profile.target,
    code: profile.code,
    retryable: profile.retryable,
    simulated: true,
    ...overrides,
  };
}

assert.deepEqual(
  verifyBenchmarkFaultReceipt(
    receiptFor("goal-formation-timeout"),
    resolveBenchmarkFaultProfile("goal-formation-timeout", { enabled: true }),
  ),
  {
    faultId: "goal-formation-timeout",
    stage: "goal-formation",
    target: "structured-model",
    code: "generation-timeout",
    retryable: true,
    simulated: true,
  },
);
for (const [field, value] of [
  ["benchmarkFaultId", "task-planning-timeout"],
  ["stage", "wrong-stage"],
  ["target", "wrong-target"],
  ["code", "http-500"],
  ["retryable", false],
  ["simulated", false],
]) {
  assert.equal(verifyBenchmarkFaultReceipt(
    receiptFor("goal-formation-timeout", { [field]: value }),
    resolveBenchmarkFaultProfile("goal-formation-timeout", { enabled: true }),
  ), null, `receipt must reject mismatched ${field}`);
}
assert.equal(verifyBenchmarkFaultReceipt(
  { degraded: true, reason: "http-500" },
  resolveBenchmarkFaultProfile("goal-formation-timeout", { enabled: true }),
), null, "ordinary 500/degraded telemetry is not a fault receipt");

assert.equal(resolveBenchmarkFaultRequest({}, { enabled: false, boundary: "local-llm" }), null);
assert.throws(
  () => resolveBenchmarkFaultRequest(
    { task: "b2_goal_formation", benchmarkFaultId: "goal-formation-timeout" },
    { enabled: false, boundary: "local-llm" },
  ),
  /benchmark faults are disabled/,
  "normal server mode must reject, not ignore, a fault field",
);
assert.throws(
  () => resolveBenchmarkFaultRequest(
    { task: "b2_goal_formation", benchmarkFaultId: "safety-allow" },
    { enabled: true, boundary: "local-llm" },
  ),
  /unknown benchmark fault/,
);
assert.equal(resolveBenchmarkFaultRequest(
  { task: "b2_task_planning", benchmarkFaultId: "goal-formation-timeout" },
  { enabled: true, boundary: "local-llm" },
), null, "a fault must not spill into a different model stage");
assert.equal(resolveBenchmarkFaultRequest(
  { query: "ES8 尾门", benchmarkFaultId: "vehicle-knowledge-rag-unavailable" },
  { enabled: true, boundary: "manual-rag" },
).stage, "vehicle-knowledge-rag");
assert.equal(resolveBenchmarkFaultRequest({
  task: "conversation_general",
  rawText: "请解释多智能体协作",
  parsedCommand: { intent: "conversation.general", slots: { topic: "general_qa" } },
  benchmarkFaultId: "weather-timeout",
}, { enabled: true, boundary: "local-llm" }), null,
"weather fault must not affect an ordinary conversation_general request");

for (const id of ["goal-formation-timeout", "task-planning-timeout"]) {
  assert.deepEqual(buildBenchmarkModelError(resolveBenchmarkFaultProfile(id, { enabled: true })), {
    stage: id === "goal-formation-timeout" ? "goal-formation" : "task-planning",
    code: "generation-timeout",
    retryable: true,
    simulated: true,
  });
}

assert.throws(
  () => new CloudLLMAdapter({
    endpoint: "/api/local-llm",
    benchmarkFaultsEnabled: false,
    benchmarkFaultId: "goal-formation-timeout",
  }),
  /benchmark faults are disabled/,
  "normal adapter mode must reject, not ignore, a configured fault field",
);

const originalFetch = globalThis.fetch;
try {
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ output: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const enabledAdapter = new CloudLLMAdapter({
    endpoint: "/api/local-llm",
    benchmarkFaultsEnabled: true,
    benchmarkFaultId: "goal-formation-timeout",
  });
  await enabledAdapter.postLocalLlm({ task: "b2_goal_formation" }, 100);
  assert.equal(requests[0].benchmarkFaultId, "goal-formation-timeout");
  assert.equal(enabledAdapter.getBenchmarkFaultReceipt(), null,
    "an ordinary successful response must not create a fault receipt");
  await enabledAdapter.postLocalLlm({ task: "b2_task_planning" }, 100);
  assert.equal(Object.hasOwn(requests[1], "benchmarkFaultId"), false,
    "a model-stage fault must not be transported to a different task");

  for (const benchmarkFaultId of [
    "vehicle-knowledge-rag-unavailable",
    "vehicle-confirmation-timeout",
  ]) {
    const boundaryAdapter = new CloudLLMAdapter({
      endpoint: "/api/local-llm",
      benchmarkFaultsEnabled: true,
      benchmarkFaultId,
    });
    await boundaryAdapter.postLocalLlm({ task: "b3_vehicle_knowledge_planning" }, 100);
    assert.equal(Object.hasOwn(requests.at(-1), "benchmarkFaultId"), false,
      `${benchmarkFaultId} must not leak into local-llm transport`);
  }

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: {
      stage: "goal-formation",
      code: "generation-timeout",
      retryable: true,
      simulated: true,
    },
    telemetry: {
      benchmarkFaultId: "goal-formation-timeout",
      stage: "goal-formation",
      target: "structured-model",
      code: "generation-timeout",
      retryable: true,
      simulated: true,
    },
  }), { status: 504, headers: { "content-type": "application/json" } });
  await assert.rejects(
    enabledAdapter.postLocalLlm({ task: "b2_goal_formation" }, 100),
    (error) => {
      assert.equal(error.stage, "goal-formation");
      assert.equal(error.code, "generation-timeout");
      assert.equal(error.retryable, true);
      assert.equal(error.simulated, true);
      return true;
    },
  );
  assert.deepEqual(enabledAdapter.getBenchmarkFaultReceipt(), {
    faultId: "goal-formation-timeout",
    stage: "goal-formation",
    target: "structured-model",
    code: "generation-timeout",
    retryable: true,
    simulated: true,
  });

  globalThis.fetch = async () => new Response(JSON.stringify({ output: { ok: true } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await enabledAdapter.postLocalLlm({ task: "b2_response_synthesis" }, 100);
  assert.equal(enabledAdapter.getBenchmarkFaultReceipt()?.faultId, "goal-formation-timeout",
    "a later non-target model phase in the same run must not erase the verified receipt");
  enabledAdapter.resetBenchmarkFaultReceipt();
  assert.equal(enabledAdapter.getBenchmarkFaultReceipt(), null,
    "a new run boundary must explicitly clear the previous run receipt");

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: "http-500" },
    telemetry: { degraded: true, reason: "http-500" },
  }), { status: 500, headers: { "content-type": "application/json" } });
  await assert.rejects(enabledAdapter.postLocalLlm({ task: "b2_goal_formation" }, 100));
  assert.equal(enabledAdapter.getBenchmarkFaultReceipt(), null,
    "ordinary 500 must clear and not create a fault receipt");

  globalThis.fetch = async (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  await assert.rejects(enabledAdapter.postLocalLlm({ task: "b2_goal_formation" }, 5));
  assert.equal(enabledAdapter.getBenchmarkFaultReceipt(), null,
    "a client-side real timeout must not create a simulated fault receipt");

  let weatherRequest = null;
  globalThis.fetch = async (_url, init) => {
    weatherRequest = JSON.parse(init.body);
    return new Response(JSON.stringify({
      summary: "weather unavailable",
      telemetry: receiptFor("weather-timeout"),
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const weatherAdapter = new CloudLLMAdapter({
    endpoint: "/api/local-llm",
    benchmarkFaultsEnabled: true,
    benchmarkFaultId: "weather-timeout",
  });
  const weatherFailure = await weatherAdapter.executeBenchmarkWeatherFaultQuery({
    requestId: "run:weather",
    commandId: "command:weather",
    tool: "conversation.general",
    args: { topic: "weather_query", externalDataType: "weather", requiresExternalData: true },
  });
  assert.equal(weatherRequest.task, "conversation_general");
  assert.equal(weatherRequest.benchmarkFaultId, "weather-timeout");
  assert.equal(weatherRequest.parsedCommand.slots.topic, "weather_query");
  assert.equal(resolveBenchmarkFaultRequest(weatherRequest, {
    enabled: true,
    boundary: "local-llm",
  })?.id, "weather-timeout",
  "the actual B2 bridge payload must satisfy the exact server weather target predicate");
  assert.deepEqual(weatherFailure.executionError, {
    code: "weather-timeout",
    stage: "weather-adapter",
    retryable: true,
  });
  assert.equal(weatherFailure.ok, false);
  weatherRequest = null;
  assert.equal(await weatherAdapter.executeBenchmarkWeatherFaultQuery({
    tool: "conversation.general",
    args: { topic: "general_qa" },
  }), null, "the B2 bridge must reject a non-weather external query");
  assert.equal(weatherRequest, null);
} finally {
  globalThis.fetch = originalFetch;
}

assert.deepEqual(B4_FAULT_CASES.map((entry) => entry.faultId), FAULT_IDS);
assert.deepEqual(B4_FAULT_CASES.map((entry) => entry.scenarioId), [
  "conversation-general",
  "conversation-general",
  "vehicle-knowledge",
  "weather-readonly",
  "vehicle-control-safe",
]);
const faultPlan = buildRunPlan({ profile: "stability-faults" });
assert.equal(faultPlan.measuredSamples, 5);
assert.equal(faultPlan.maxExternalModelRequests, 8,
  "five fault samples must include Vehicle-SLU plus each downstream model call (2 + 2 + 2 + 1 + 1)");
assert.deepEqual(faultPlan.samples.map((sample) => sample.faultId), FAULT_IDS);
const repeatedFaultPlan = buildRunPlan({ profile: "stability-faults", repeats: 2 });
assert.equal(repeatedFaultPlan.measuredSamples, 10,
  "dry-run repeat override must preserve the complete five-case matrix per repeat");
assert.equal(repeatedFaultPlan.maxExternalModelRequests, 16,
  "two fault cycles must multiply the exact five-sample Lean maxCalls total by two");
assert.equal(new Set(repeatedFaultPlan.samples.map((sample) => sample.sampleKey)).size, 10);

function verifiedReceipt(id) {
  return verifyBenchmarkFaultReceipt(
    receiptFor(id),
    resolveBenchmarkFaultProfile(id, { enabled: true }),
  );
}

const modelObservation = {
  receipt: verifiedReceipt("goal-formation-timeout"),
  terminal: "degraded",
  recoveryAttempts: 1,
  planPresent: false,
  planProvenance: "none",
};
assert.doesNotThrow(() => assertFaultCaseBoundary(B4_FAULT_CASES[0], modelObservation));
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[0], {
  ...modelObservation,
  receipt: null,
}), /verified fault receipt/, "ordinary degraded/model timeout is not simulated-fault evidence");
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[0], {
  ...modelObservation,
  receipt: verifiedReceipt("task-planning-timeout"),
}), /verified fault receipt/, "a receipt for another case must fail");
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[0], {
  ...modelObservation,
  planPresent: true,
  planProvenance: "model",
}), /model plan/);

const ragObservation = {
  receipt: verifiedReceipt("vehicle-knowledge-rag-unavailable"),
  evidenceCount: 0,
  citationCount: 0,
};
assert.doesNotThrow(() => assertFaultCaseBoundary(B4_FAULT_CASES[2], ragObservation));
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[2], {
  ...ragObservation,
  receipt: null,
}), /verified fault receipt/, "an uncalled RAG target must fail");
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[2], {
  ...ragObservation,
  evidenceCount: 1,
}), /Manual evidence/);

const weatherObservation = {
  receipt: verifiedReceipt("weather-timeout"),
  toolCallCount: 0,
  adapterAcceptedCount: 0,
  providerCallCount: 0,
};
assert.doesNotThrow(() => assertFaultCaseBoundary(B4_FAULT_CASES[3], weatherObservation));
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[3], {
  ...weatherObservation,
  receipt: null,
}), /verified fault receipt/, "ordinary weather degradation must fail without the exact receipt");
for (const field of ["toolCallCount", "adapterAcceptedCount", "providerCallCount"]) {
  assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[3], {
    ...weatherObservation,
    [field]: 1,
  }), /zero vehicle side effect/, `weather must reject nonzero ${field}`);
}

const vehicleObservation = {
  receipt: verifiedReceipt("vehicle-confirmation-timeout"),
  submissionCount: 1,
  timeoutTerminal: true,
  automaticWriteRetries: 0,
  providerConfirmationCount: 0,
  confirmedStatePatchCount: 0,
  confirmedAnimationCount: 0,
};
assert.doesNotThrow(() => assertFaultCaseBoundary(B4_FAULT_CASES[4], vehicleObservation));
const vehicleFaultProfile = resolveBenchmarkFaultProfile("vehicle-confirmation-timeout", {
  enabled: true,
});
const timeoutTerminalResult = {
  toolResult: {
    commandId: "command:tailgate:1",
    tool: "body.tailgate.open",
    executionState: "timeout",
    executionError: {
      stage: "sensor-confirmation",
      code: "sensor-timeout",
      retryable: true,
    },
    simulated: true,
  },
};

function sensorEvidenceState() {
  return {
    manualRagReceipt: null,
    confirmedAnimationCount: 0,
    runtimeResult: null,
    runId: null,
    sensorSubmissionMarkers: [],
    terminalSensorSubmissionMarkers: [],
  };
}

async function receiptFromSettledSensorResult(result) {
  const evidenceState = sensorEvidenceState();
  await observeBenchmarkSensorSubmission(
    evidenceState,
    () => Promise.resolve(result),
  );
  return {
    evidenceState,
    receipt: buildBenchmarkVehicleFaultReceipt({
      profile: vehicleFaultProfile,
      result: timeoutTerminalResult,
      sensorSubmissionMarkers: evidenceState.sensorSubmissionMarkers,
    }),
  };
}

const actualTimeout = await receiptFromSettledSensorResult({
  type: "timeout",
  commandId: "command:tailgate:1",
  component: "tailgate",
});
assert.deepEqual(Object.keys(actualTimeout.evidenceState.sensorSubmissionMarkers[0]).sort(), [
  "called", "commandId", "component", "resultType", "settled",
]);
assert.deepEqual(actualTimeout.receipt, verifiedReceipt("vehicle-confirmation-timeout"),
  "a real fulfilled simulator timeout marker plus matching terminal must create the receipt");

for (const [label, settledResult] of [
  ["success observation", {
    observationId: "observation:1",
    commandId: "command:tailgate:1",
    component: "tailgate",
  }],
  ["no-update", {
    type: "no-update",
    commandId: "command:tailgate:1",
    component: "tailgate",
  }],
  ["command mismatch", {
    type: "timeout",
    commandId: "command:other",
    component: "tailgate",
  }],
  ["component mismatch", {
    type: "timeout",
    commandId: "command:tailgate:1",
    component: "seat",
  }],
]) {
  const observed = await receiptFromSettledSensorResult(settledResult);
  assert.equal(observed.receipt, null, `${label} must not create a vehicle fault receipt`);
}

const rejectedSensorState = sensorEvidenceState();
await assert.rejects(observeBenchmarkSensorSubmission(
  rejectedSensorState,
  () => Promise.reject(new Error("sensor rejected")),
));
assert.equal(buildBenchmarkVehicleFaultReceipt({
  profile: vehicleFaultProfile,
  result: timeoutTerminalResult,
  sensorSubmissionMarkers: rejectedSensorState.sensorSubmissionMarkers,
}), null, "a rejected simulator submission must not create a receipt");

const unsettledSensorState = sensorEvidenceState();
observeBenchmarkSensorSubmission(unsettledSensorState, () => new Promise(() => {}));
assert.equal(buildBenchmarkVehicleFaultReceipt({
  profile: vehicleFaultProfile,
  result: timeoutTerminalResult,
  sensorSubmissionMarkers: unsettledSensorState.sensorSubmissionMarkers,
}), null, "a coordinator deadline timeout with an unsettled simulator submission must not create a receipt");

const lateSensorState = sensorEvidenceState();
let resolveLateSensor;
const lateSensorSettlement = observeBenchmarkSensorSubmission(
  lateSensorState,
  () => new Promise((resolve) => { resolveLateSensor = resolve; }),
);
const markersAtCoordinatorTerminal = captureBenchmarkSensorSubmissionMarkers(lateSensorState);
resolveLateSensor({
  type: "timeout",
  commandId: "command:tailgate:1",
  component: "tailgate",
});
await lateSensorSettlement;
assert.equal(lateSensorState.sensorSubmissionMarkers[0].settled, true);
assert.equal(markersAtCoordinatorTerminal[0].settled, false);
assert.equal(buildBenchmarkVehicleFaultReceipt({
  profile: vehicleFaultProfile,
  result: timeoutTerminalResult,
  sensorSubmissionMarkers: markersAtCoordinatorTerminal,
}), null, "a simulator timeout that settles only after the coordinator terminal must not backfill a receipt");

const repeatedSensorState = sensorEvidenceState();
for (let attempt = 0; attempt < 2; attempt += 1) {
  await observeBenchmarkSensorSubmission(repeatedSensorState, () => Promise.resolve({
    type: "timeout",
    commandId: "command:tailgate:1",
    component: "tailgate",
  }));
}
assert.equal(buildBenchmarkVehicleFaultReceipt({
  profile: vehicleFaultProfile,
  result: timeoutTerminalResult,
  sensorSubmissionMarkers: captureBenchmarkSensorSubmissionMarkers(repeatedSensorState),
}), null, "more than one actual simulator submission must not create a receipt");

const coordinatorResult = Object.freeze({ status: "fulfilled" });
const fulfilledCoordinatorState = sensorEvidenceState();
await observeBenchmarkSensorSubmission(fulfilledCoordinatorState, () => Promise.resolve({
  type: "timeout",
  commandId: "command:tailgate:1",
  component: "tailgate",
}));
assert.strictEqual(await observeBenchmarkCoordinatorSettlement(
  fulfilledCoordinatorState,
  () => Promise.resolve(coordinatorResult),
), coordinatorResult, "coordinator observer must preserve fulfilled result identity");
assert.equal(fulfilledCoordinatorState.terminalSensorSubmissionMarkers.length, 1);

const rejectedCoordinatorState = sensorEvidenceState();
await observeBenchmarkSensorSubmission(rejectedCoordinatorState, () => Promise.resolve({
  type: "timeout",
  commandId: "command:tailgate:1",
  component: "tailgate",
}));
observeBenchmarkSensorSubmission(rejectedCoordinatorState, () => new Promise(() => {}));
const coordinatorRejection = new Error("coordinator rejected");
await assert.rejects(
  observeBenchmarkCoordinatorSettlement(
    rejectedCoordinatorState,
    () => Promise.reject(coordinatorRejection),
  ),
  (error) => error === coordinatorRejection,
  "coordinator observer must preserve rejection identity",
);
assert.equal(rejectedCoordinatorState.terminalSensorSubmissionMarkers.length, 2,
  "a rejected second coordinator execution must freeze both submission attempts");
assert.equal(buildBenchmarkVehicleFaultReceipt({
  profile: vehicleFaultProfile,
  result: timeoutTerminalResult,
  sensorSubmissionMarkers: rejectedCoordinatorState.terminalSensorSubmissionMarkers,
}), null, "a rejected second execution must not hide an automatic retry");

const synchronousCoordinatorState = sensorEvidenceState();
await observeBenchmarkSensorSubmission(synchronousCoordinatorState, () => Promise.resolve({
  type: "timeout",
  commandId: "command:tailgate:1",
  component: "tailgate",
}));
observeBenchmarkSensorSubmission(synchronousCoordinatorState, () => new Promise(() => {}));
const synchronousCoordinatorError = new Error("coordinator sync throw");
assert.throws(() => observeBenchmarkCoordinatorSettlement(
  synchronousCoordinatorState,
  () => { throw synchronousCoordinatorError; },
), (error) => error === synchronousCoordinatorError,
"coordinator observer must preserve synchronous error identity");
assert.equal(synchronousCoordinatorState.terminalSensorSubmissionMarkers.length, 2,
  "a synchronous coordinator failure must freeze every attempted submission");

const timeoutWithActualProviderMutation = projectBenchmarkVehicleEvidence({
  result: {
    toolResult: {
      executionState: "timeout",
      executionError: { stage: "sensor-confirmation", code: "sensor-timeout" },
    },
  },
  counts: {
    sensorSubmissionCount: 1,
    providerCallCount: 1,
    providerAcceptedCount: 1,
    providerStateChangeCount: 1,
  },
  confirmedAnimationCount: 0,
});
assert.equal(timeoutWithActualProviderMutation.providerConfirmationCount, 1);
assert.equal(timeoutWithActualProviderMutation.confirmedStatePatchCount, 1);
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[4], {
  receipt: verifiedReceipt("vehicle-confirmation-timeout"),
  ...timeoutWithActualProviderMutation,
}), /must not claim confirmation/,
"an exact timeout receipt must still fail when a real Provider acceptance/state mutation occurred");
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[4], {
  ...vehicleObservation,
  receipt: null,
}), /verified fault receipt/, "configured timeout without an actual terminal must fail");
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[4], {
  ...vehicleObservation,
  timeoutTerminal: false,
}), /timeout terminal/);
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[4], {
  ...vehicleObservation,
  submissionCount: 2,
  automaticWriteRetries: 1,
}), /exactly one submission/);
for (const field of [
  "providerConfirmationCount", "confirmedStatePatchCount", "confirmedAnimationCount",
]) {
  assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[4], {
    ...vehicleObservation,
    [field]: 1,
  }), /must not claim confirmation/, `vehicle timeout must reject nonzero ${field}`);
}

const projectedWithoutReceipt = projectFaultCaseObservation(B4_FAULT_CASES[0], {
  runDebug: { events: [{ phase: "task-planning", degraded: true }], result: {} },
  browserObservation: {},
  faultEvidence: null,
}, { outcome: "run-degraded" });
assert.throws(() => assertFaultCaseBoundary(B4_FAULT_CASES[0], projectedWithoutReceipt),
  /verified fault receipt/, "plan faultId and a generic degraded event cannot act as evidence");
const projectedVehicleReceipt = projectFaultCaseObservation(B4_FAULT_CASES[4], {
  runDebug: { events: [], result: {} },
  browserObservation: { animationConfirmedAtPerf: null },
  faultEvidence: {
    receipt: verifiedReceipt("vehicle-confirmation-timeout"),
    vehicle: {
      submissionCount: 1,
      timeoutTerminal: true,
      automaticWriteRetries: 0,
      providerConfirmationCount: 0,
      confirmedStatePatchCount: 0,
      confirmedAnimationCount: 0,
    },
  },
}, { outcome: "run-degraded" });
assert.doesNotThrow(() => assertFaultCaseBoundary(B4_FAULT_CASES[4], projectedVehicleReceipt));

const twoSamplePlan = Object.freeze({
  ...buildRunPlan({ profile: "cold-diagnostic" }),
  samples: Object.freeze(buildRunPlan({ profile: "cold-diagnostic" }).samples.slice(0, 2)),
});
const environment = Object.freeze({
  commitSha: "fixture",
  dirtyWorktree: true,
  platform: "darwin",
  arch: "arm64",
  osRelease: "fixture",
  cpuModel: "fixture",
  profile: "cold-diagnostic",
  providerIds: Object.freeze(["fixture-provider"]),
  modelIds: Object.freeze(["fixture-model"]),
  regionIds: Object.freeze(["unreported"]),
  timeoutConfig: Object.freeze({ phaseTimeoutMs: 1, transportTimeoutMs: 1, scenarioTimeoutMs: 1 }),
  serviceConfig: Object.freeze({ requiredServiceIds: Object.freeze(["agent-server"]), readinessTimeoutMs: 1 }),
  serviceReadiness: Object.freeze([{ serviceId: "agent-server", status: "ready", checkedAt: "2026-08-03T00:00:00.000Z" }]),
  coldStartProof: Object.freeze({ status: "unverified", verifiedAt: null, serviceIds: Object.freeze([]) }),
});

function completedSample(samplePlan, diagnostics) {
  const scenario = getBenchmarkScenario(samplePlan.scenarioId);
  const runId = `run:${samplePlan.sampleKey}`;
  return {
    sampleId: samplePlan.sampleKey,
    sampleKey: samplePlan.sampleKey,
    runId,
    scenarioId: samplePlan.scenarioId,
    repeat: samplePlan.repeat,
    timestamps: {
      startedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:00:00.001Z",
    },
    projectedMetrics: {
      outcome: "run-degraded",
      durationMs: 1,
      modelRequests: 0,
      modelCallCount: 0,
      submissionToFirstFeedbackMs: 0,
      submissionToResultVisibleMs: 1,
      phases: Object.fromEntries(scenario.modelBudget.allowedPhases.map((phaseId) => [phaseId, { value: 0 }])),
      slowestPhase: null,
      animation: { value: false, reason: "not-observed" },
      voice: null,
      behavior: {
        resultCategory: "answered",
        dispatchAuthorized: false,
        adapterExecutions: 0,
        vehicleToolCalls: 0,
        vehicleWrites: 0,
        safetyWriteDecisions: 0,
        providerConfirmation: false,
        unsafeProviderExecution: false,
        executionFactsComplete: true,
      },
      contractErrors: [],
      eventSequenceErrors: [],
      budgetErrors: [],
    },
    eventRefs: [`event:${samplePlan.sampleKey}`],
    simulated: true,
    diagnostics: {
      ...diagnostics,
      publicHmiEvidence: {
        runId,
        resultVisibleRunId: runId,
        firstFeedbackObserved: true,
        resultVisible: true,
        observedModelRequestCount: 0,
        observedExternalModelRequestCount: 0,
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
        visibleCardKinds: [],
        interactionRunIds: [runId],
        counters: {
          safetyCallCount: 0,
          toolCallCount: 0,
          adapterAcceptedCount: 0,
          providerCallCount: 0,
          providerAcceptedCount: 0,
          providerStateChangeCount: 0,
        },
        events: [],
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
      },
    },
  };
}

const faultEnvironment = Object.freeze({ ...environment, profile: "stability-faults" });
const firstFaultSample = faultPlan.samples[0];
const validFaultCheckpoint = createPartialCheckpoint({
  plan: faultPlan,
  environment: faultEnvironment,
  samples: [completedSample(firstFaultSample, {
    code: "run-degraded",
    benchmarkFaultReceipt: verifiedReceipt(firstFaultSample.faultId),
  })],
});
assert.doesNotThrow(() => assertResumeCompatible({
  checkpoint: validFaultCheckpoint,
  plan: faultPlan,
  environment: faultEnvironment,
}));
const ordinaryCatalogFaultInjection = createPartialCheckpoint({ plan: twoSamplePlan, environment });
ordinaryCatalogFaultInjection.catalog.faultIds = ["goal-formation-timeout"];
assert.throws(() => assertResumeCompatible({
  checkpoint: ordinaryCatalogFaultInjection,
  plan: twoSamplePlan,
  environment,
}), /catalog.*mismatch/, "an ordinary profile must reject arbitrary catalog fault IDs");
for (const [label, benchmarkFaultReceipt] of [
  ["missing", undefined],
  ["wrong", { ...verifiedReceipt(firstFaultSample.faultId), code: "http-500" }],
  ["swapped", verifiedReceipt(faultPlan.samples[1].faultId)],
]) {
  const diagnostics = { code: "run-degraded" };
  if (benchmarkFaultReceipt !== undefined) diagnostics.benchmarkFaultReceipt = benchmarkFaultReceipt;
  const checkpoint = createPartialCheckpoint({
    plan: faultPlan,
    environment: faultEnvironment,
    samples: [completedSample(firstFaultSample, diagnostics)],
  });
  assert.throws(() => assertResumeCompatible({ checkpoint, plan: faultPlan, environment: faultEnvironment }),
    /benchmark.?fault.?receipt/i, `resume must reject a ${label} fault receipt`);
}
for (const authorityField of [
  "dispatchAuthorized", "providerSnapshot", "commandId", "vehicleStatePatch", "extra",
]) {
  const checkpoint = createPartialCheckpoint({
    plan: faultPlan,
    environment: faultEnvironment,
    samples: [completedSample(firstFaultSample, {
      code: "run-degraded",
      benchmarkFaultReceipt: {
        ...verifiedReceipt(firstFaultSample.faultId),
        [authorityField]: authorityField === "dispatchAuthorized" ? true : {},
      },
    })],
  });
  assert.throws(() => assertResumeCompatible({ checkpoint, plan: faultPlan, environment: faultEnvironment }),
    /benchmark.?fault.?receipt/i,
    `resume must reject non-canonical receipt field ${authorityField}`);
}

const nonFaultSample = twoSamplePlan.samples[0];
const nonFaultCheckpoint = createPartialCheckpoint({
  plan: twoSamplePlan,
  environment,
  samples: [completedSample(nonFaultSample, {
    code: "run-degraded",
    benchmarkFaultReceipt: verifiedReceipt("goal-formation-timeout"),
  })],
});
assert.throws(() => assertResumeCompatible({ checkpoint: nonFaultCheckpoint, plan: twoSamplePlan, environment }),
  /fault|allowed/i, "a non-fault sample must reject benchmark fault metadata");
for (const [label, mutate] of [
  ["nested diagnostics", (sample) => {
    sample.diagnostics.extra = { benchmarkFaultReceipt: verifiedReceipt("goal-formation-timeout") };
  }],
  ["nested root", (sample) => {
    sample.extra = { benchmarkFaultId: "goal-formation-timeout" };
  }],
]) {
  const checkpoint = createPartialCheckpoint({
    plan: twoSamplePlan,
    environment,
    samples: [completedSample(nonFaultSample, { code: "run-degraded" })],
  });
  mutate(checkpoint.samples[0]);
  assert.throws(() => assertResumeCompatible({ checkpoint, plan: twoSamplePlan, environment }),
    /fault|allowed/i, `a non-fault sample must reject ${label} fault metadata`);
}
const duplicatedFaultReceipt = structuredClone(validFaultCheckpoint);
duplicatedFaultReceipt.samples[0].extra = {
  nested: { benchmarkFaultReceipt: verifiedReceipt(firstFaultSample.faultId) },
};
assert.throws(() => assertResumeCompatible({
  checkpoint: duplicatedFaultReceipt,
  plan: faultPlan,
  environment: faultEnvironment,
}), /fault|allowed/i, "a fault sample must reject a nested duplicate receipt");

const runEvidenceState = {
  manualRagReceipt: verifiedReceipt("vehicle-knowledge-rag-unavailable"),
  confirmedAnimationCount: 1,
  runtimeResult: { requestId: "old-run" },
  runId: "old-run",
  sensorSubmissionMarkers: [{
    called: true,
    settled: true,
    resultType: "timeout",
    commandId: "old-command",
    component: "tailgate",
  }],
  terminalSensorSubmissionMarkers: [{
    called: true,
    settled: true,
    resultType: "timeout",
    commandId: "old-command",
    component: "tailgate",
  }],
};
let modelReceiptResetCount = 0;
try {
  resetBenchmarkRunEvidenceState(runEvidenceState, () => {
    modelReceiptResetCount += 1;
  });
  throw new Error("scenario ingestion failed");
} catch (error) {
  assert.match(error.message, /scenario ingestion failed/);
}
assert.deepEqual(runEvidenceState, {
  manualRagReceipt: null,
  confirmedAnimationCount: 0,
  runtimeResult: null,
  runId: null,
  sensorSubmissionMarkers: [],
  terminalSensorSubmissionMarkers: [],
});
assert.equal(modelReceiptResetCount, 1,
  "a new interaction Run must reset the model receipt in the same unified boundary");
resetBenchmarkRunEvidenceState(runEvidenceState, () => {
  modelReceiptResetCount += 1;
});
await observeBenchmarkSensorSubmission(runEvidenceState, () => Promise.resolve({
  type: "timeout",
  commandId: "command:tailgate:2",
  component: "tailgate",
}));
const secondConfirmationResult = structuredClone(timeoutTerminalResult);
secondConfirmationResult.toolResult.commandId = "command:tailgate:2";
assert.deepEqual(buildBenchmarkVehicleFaultReceipt({
  profile: vehicleFaultProfile,
  result: secondConfirmationResult,
  sensorSubmissionMarkers: captureBenchmarkSensorSubmissionMarkers(runEvidenceState),
}), verifiedReceipt("vehicle-confirmation-timeout"),
"a second confirmation Run must independently acquire a new actual simulator receipt after reset");

const createdPages = [];
const closedPages = [];
const written = [];
let resolveLateSample;
let lateSampleResolutionObserved = false;
await assert.rejects(executeMeasuredSamples({
  plan: twoSamplePlan,
  checkpoint: createPartialCheckpoint({ plan: twoSamplePlan, environment }),
  createPage: async () => {
    const page = {
      id: `page-${createdPages.length + 1}`,
      async close() { closedPages.push(this.id); },
    };
    createdPages.push(page.id);
    return page;
  },
  runSample: async ({ page, sample }) => {
    if (sample === twoSamplePlan.samples[0]) {
      return new Promise((resolve) => { resolveLateSample = resolve; }).then((value) => {
        lateSampleResolutionObserved = true;
        return value;
      });
    }
    resolveLateSample({
      sampleId: twoSamplePlan.samples[0].sampleKey,
      sampleKey: twoSamplePlan.samples[0].sampleKey,
      scenarioId: twoSamplePlan.samples[0].scenarioId,
      repeat: twoSamplePlan.samples[0].repeat,
      pageId: "late-page-1",
    });
    await Promise.resolve();
    return completedSample(sample, { code: "run-degraded" });
  },
  writePartial: async (checkpoint) => { written.push(structuredClone(checkpoint)); },
  envelopeTimeoutMs: ({ sample }) => sample === twoSamplePlan.samples[0] ? 5 : 100,
}), (error) => {
  assert.equal(error.code, "benchmark-envelope-timeout");
  assert.deepEqual(error.timedOutSampleKeys, [twoSamplePlan.samples[0].sampleKey]);
  return true;
});
assert.deepEqual(createdPages, ["page-1", "page-2"], "next sample must use a new page");
assert.deepEqual(closedPages, createdPages, "timed-out and subsequent pages must both close");
assert.equal(lateSampleResolutionObserved, true, "the timed-out first sample must actually resolve late");
assert.equal(written.length, 1, "timed-out sample must not overwrite the retained partial checkpoint");
assert.equal(written[0].samples[0].sampleKey, twoSamplePlan.samples[1].sampleKey,
  "late sample data must not contaminate the next sample");
assert.equal(Object.hasOwn(written[0].samples[0], "pageId"), false,
  "test-only page metadata must not enter a canonical partial checkpoint");

const appSource = readFileSync(new URL("../../src/app/app.js", import.meta.url), "utf8");
assert.match(appSource, /NIO_DEV_BENCHMARK_FAULTS\s*===\s*true/);
assert.match(appSource, /typeof window\.NIO_BENCHMARK_FAULT_PROFILE\s*===\s*["']string["']/);
assert.match(appSource, /vehicleSensorMode\s*:\s*[\s\S]{0,160}?"timeout"/,
  "vehicle confirmation fault must select the existing timeout submission mode");
assert.match(appSource, /executeBenchmarkWeatherFaultQuery/,
  "the B2 weather external.query path must bridge to the exact benchmark weather target");
assert.match(appSource, /response\.clone\(\)\.json\(\)/,
  "Manual RAG receipt validation must inspect a clone and preserve the actual response");
assert.match(appSource, /benchmarkRunEvidenceState\.manualRagReceipt\s*=\s*verifyBenchmarkFaultReceipt/,
  "Manual RAG evidence must be an exact verified response receipt");
assert.match(appSource, /benchmarkFaultEvidence\s*:\s*buildBenchmarkFaultEvidence\(\)/,
  "dev-only runtime debug must expose the minimal fault evidence aggregate");
assert.match(appSource, /demoSensorSimulator\.submit\s*=\s*\(\.\.\.args\)\s*=>[\s\S]{0,240}?sensorSubmissionCount\s*\+=\s*1[\s\S]{0,240}?observeBenchmarkSensorSubmission/,
  "vehicle submission evidence must count the actual simulator target invocation");
assert.match(appSource, /projectBenchmarkVehicleEvidence\s*\(/,
  "vehicle aggregate must project actual Provider instrumentation rather than infer from the terminal");
assert.match(appSource, /observeBenchmarkSensorSubmission\s*\(/,
  "the app must observe the actual simulator Promise settlement");
assert.match(appSource, /return\s+observeBenchmarkCoordinatorSettlement\s*\(/,
  "the app must freeze sensor markers through the tested coordinator settlement observer");
assert.match(appSource, /buildBenchmarkVehicleFaultReceipt\s*\(/,
  "the app must use the same actual simulator provenance receipt verifier as the fixtures");
assert.match(appSource, /providerAcceptedCount/);
assert.match(appSource, /providerStateChangeCount/);
const interactionRunSource = appSource.slice(appSource.indexOf("async function executeInteractionTurn"));
const resetBoundaryIndex = interactionRunSource.indexOf("resetBenchmarkRunEvidenceState(");
assert.ok(resetBoundaryIndex >= 0
  && resetBoundaryIndex < interactionRunSource.indexOf("entry.started = true"),
"the unified evidence reset must be the first new-Run boundary before scenario/render work");
const moduleSource = readFileSync(new URL("../../src/benchmark/benchmark-fault-profile.js", import.meta.url), "utf8");
assert.doesNotMatch(moduleSource, /setTimeout|sleep\s*\(/, "fault definitions must not delay with arbitrary sleep");

console.log("verify-b4-fault-profile: PASS");
