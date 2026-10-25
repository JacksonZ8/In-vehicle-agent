import assert from "node:assert/strict";
import { createVehicleToolResult } from "../../src/runtime/agent-schemas.js";
import { DemoSensorSimulator } from "../../src/vehicle/demo-sensor-simulator.js";
import { VehicleExecutionCoordinator } from "../../src/vehicle/vehicle-execution-coordinator.js";
import { VehicleTools } from "../../src/vehicle/vehicle-tools.js";
import { DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";

const submittedAt = "2020-07-26T00:00:00.000Z";
const coordinatorAt = "2020-07-26T00:00:01.000Z";
const observedAt = "2020-07-26T00:00:02.000Z";
const immediateScheduler = (callback) => callback();

const componentCases = [
  {
    component: "window",
    tool: "body.window.setPosition",
    args: { zone: "front_left", percent: 37 },
    requestedState: { windowPositionPercentByZone: { front_left: 37 } },
  },
  {
    component: "tailgate",
    tool: "body.tailgate.open",
    args: { open: true },
    requestedState: { tailgateOpen: true },
  },
  {
    component: "seat",
    tool: "seat.driver.setBackrestAngle",
    args: { angle: 106 },
    requestedState: { driverBackrestAngle: 106 },
  },
  {
    component: "vehicle-component",
    tool: "vehicle.component.setState",
    args: { actionId: "hood_open", value: 1 },
    requestedState: { componentActionStateById: { hood_open: 1 } },
  },
  {
    component: "climate",
    tool: "cabin.climate.setPreset",
    args: { temperature: 24, airflow: "medium", passengerMode: "comfort" },
    requestedState: {
      cabinTemperature: 24,
      airflow: "medium",
      passengerMode: "comfort",
    },
  },
];

const modes = [
  {
    mode: "success",
    executionState: "observed-succeeded",
    traceStates: ["submitted", "accepted", "executing", "observed-succeeded"],
  },
  {
    mode: "no-update",
    executionState: "timeout",
    errorCode: "sensor-no-update",
    traceStates: ["submitted", "accepted", "executing", "timeout"],
  },
  {
    mode: "conflict",
    executionState: "failed",
    errorCode: "sensor-observation-conflict",
    traceStates: ["submitted", "accepted", "executing", "failed"],
  },
  {
    mode: "timeout",
    executionState: "timeout",
    errorCode: "sensor-timeout",
    traceStates: ["submitted", "accepted", "executing", "timeout"],
  },
];

function toolCall(caseDefinition, suffix) {
  return {
    requestId: `coordinator-${caseDefinition.component}-${suffix}`,
    commandId: `coordinator-${caseDefinition.component}-${suffix}:1:${caseDefinition.tool}`,
    tool: caseDefinition.tool,
    args: caseDefinition.args,
  };
}

function createFixture({
  vehicleTools = new VehicleTools({ now: () => Date.parse(submittedAt) }),
  sensorSimulator = new DemoSensorSimulator({
    now: () => observedAt,
    scheduler: immediateScheduler,
  }),
  vehicleStateProvider = new DevVehicleStateProvider({
    speedKph: 0,
    gear: "P",
  }),
  now = () => coordinatorAt,
  confirmationTimeoutMs = 60_000,
  timeoutScheduler,
} = {}) {
  const coordinatorConfig = {
    vehicleTools,
    sensorSimulator,
    vehicleStateProvider,
    now,
    confirmationTimeoutMs,
  };
  if (timeoutScheduler !== undefined) coordinatorConfig.timeoutScheduler = timeoutScheduler;
  return {
    vehicleStateProvider,
    coordinator: new VehicleExecutionCoordinator(coordinatorConfig),
  };
}

function assertNoPseudoState(toolResult) {
  for (const field of ["statePatch", "observedState", "statePatchSource", "vehicleStateSnapshot", "values"]) {
    assert.equal(field in toolResult, false, `${field} must not be copied into ToolResult`);
  }
}

const terminalExamples = new Map();
let matrixCount = 0;

for (const componentCase of componentCases) {
  for (const modeCase of modes) {
    const noUpdateDeadline = modeCase.mode === "no-update" ? createManualTimeoutScheduler() : null;
    const { coordinator, vehicleStateProvider } = createFixture({
      timeoutScheduler: noUpdateDeadline?.scheduler,
      confirmationTimeoutMs: noUpdateDeadline ? 25 : 60_000,
    });
    const beforeSnapshot = vehicleStateProvider.getSnapshot();
    const call = toolCall(componentCase, modeCase.mode);
    const pending = coordinator.execute(call, {
      sensorMode: modeCase.mode,
      latencyMs: 42,
    });
    if (noUpdateDeadline) {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      assert.equal(noUpdateDeadline.size, 1, `${componentCase.component}/no-update must retain the deadline`);
      assert.equal(noUpdateDeadline.runNext(), true);
    }
    const result = await pending;
    const { toolResult, vehicleStateSnapshot } = result;

    assert.equal(toolResult.requestId, call.requestId, `${componentCase.component}/${modeCase.mode} requestId`);
    assert.equal(toolResult.commandId, call.commandId, `${componentCase.component}/${modeCase.mode} commandId`);
    assert.equal(toolResult.tool, call.tool, `${componentCase.component}/${modeCase.mode} tool`);
    assert.equal(toolResult.executionState, modeCase.executionState, `${componentCase.component}/${modeCase.mode} terminal state`);
    assert.deepEqual(
      toolResult.executionTrace.map(({ state }) => state),
      modeCase.traceStates,
      `${componentCase.component}/${modeCase.mode} trace`,
    );
    assert.deepEqual(toolResult.requestedState, componentCase.requestedState);
    assert.equal(toolResult.simulated, true, "Coordinator must preserve begin simulated metadata");
    assert.equal(toolResult.source, "dev-adapter", "Coordinator must preserve begin source metadata");
    assert.equal(typeof toolResult.hmiSummary, "string", "Coordinator must preserve begin HMI metadata");
    assertNoPseudoState(toolResult);
    assert.strictEqual(vehicleStateSnapshot, vehicleStateProvider.getSnapshot(), "returned snapshot must be Provider current snapshot");

    if (modeCase.mode === "success") {
      assert.equal(toolResult.ok, true);
      assert.equal(toolResult.confirmedSnapshotId, vehicleStateSnapshot.id);
      assert.notEqual(vehicleStateSnapshot.id, beforeSnapshot.id);
      for (const [field, expected] of Object.entries(componentCase.requestedState)) {
        assert.deepEqual(vehicleStateSnapshot.values[field], expected);
      }
    } else {
      assert.equal(toolResult.ok, false);
      assert.equal("confirmedSnapshotId" in toolResult, false);
      assert.deepEqual(
        Object.keys(toolResult.executionError).sort(),
        ["code", "message", "retryable", "stage"],
        "terminal errors must be complete",
      );
      assert.equal(toolResult.executionError.code, modeCase.errorCode);
      assert.equal(typeof toolResult.executionError.stage, "string");
      assert.equal(typeof toolResult.executionError.retryable, "boolean");
      if (modeCase.mode === "conflict") {
        assert.notEqual(vehicleStateSnapshot.id, beforeSnapshot.id, "conflict is a real fact and must update Provider");
        assert.equal(vehicleStateSnapshot.source, "demo-sensor-simulator");
        assert.notDeepEqual(
          Object.fromEntries(Object.keys(componentCase.requestedState).map(
            (field) => [field, vehicleStateSnapshot.values[field]],
          )),
          componentCase.requestedState,
        );
      } else {
        assert.equal(vehicleStateSnapshot.id, beforeSnapshot.id, `${modeCase.mode} must preserve confirmed snapshot`);
      }
    }

    if (!terminalExamples.has(toolResult.executionState)) {
      terminalExamples.set(toolResult.executionState, {
        componentCase,
        toolResult,
        vehicleStateProvider,
      });
    }
    matrixCount += 1;
  }
}

const poisonSimulator = {
  submit() {
    throw new Error("terminal begin must not call Simulator");
  },
};
const poisonProvider = new DevVehicleStateProvider({ speedKph: 0, gear: "P" });
const poisonProviderBoundary = {
  getSnapshot: () => poisonProvider.getSnapshot(),
  ingestObservation() {
    throw new Error("terminal begin must not call Provider ingestion");
  },
};

const duplicateCase = componentCases[0];
const duplicateCall = toolCall(duplicateCase, "begin-duplicate");
const duplicateTools = new VehicleTools({ now: () => Date.parse(submittedAt) });
await duplicateTools.execute(duplicateCall);
const duplicateCoordinator = new VehicleExecutionCoordinator({
  vehicleTools: duplicateTools,
  sensorSimulator: poisonSimulator,
  vehicleStateProvider: poisonProviderBoundary,
  now: () => coordinatorAt,
  confirmationTimeoutMs: 99_999,
});
const duplicateResult = await duplicateCoordinator.execute(duplicateCall);
assert.equal(duplicateResult.toolResult.executionState, "duplicate-command");
assert.equal(duplicateResult.toolResult.executionError.code, "duplicate-command");
assert.deepEqual(duplicateResult.toolResult.executionTrace.map(({ state }) => state), ["submitted", "duplicate-command"]);
assert.strictEqual(duplicateResult.vehicleStateSnapshot, poisonProvider.getSnapshot());
terminalExamples.set("duplicate-command", {
  componentCase: duplicateCase,
  toolResult: duplicateResult.toolResult,
  vehicleStateProvider: poisonProvider,
});

const timeoutCase = componentCases[1];
const timeoutCall = toolCall(timeoutCase, "begin-timeout");
const beginTimeoutProvider = new DevVehicleStateProvider({ speedKph: 0, gear: "P" });
const beginTimeoutProviderBoundary = {
  getSnapshot: () => beginTimeoutProvider.getSnapshot(),
  ingestObservation: poisonProviderBoundary.ingestObservation,
};
const beginTimeoutCoordinator = new VehicleExecutionCoordinator({
  vehicleTools: new VehicleTools({
    now: () => Date.parse(submittedAt),
    timeoutCommandIds: [timeoutCall.commandId],
  }),
  sensorSimulator: poisonSimulator,
  vehicleStateProvider: beginTimeoutProviderBoundary,
  now: () => coordinatorAt,
});
const beginTimeoutResult = await beginTimeoutCoordinator.execute(timeoutCall);
assert.equal(beginTimeoutResult.toolResult.executionState, "timeout");
assert.equal(beginTimeoutResult.toolResult.executionError.code, "dev-adapter-timeout");
assert.deepEqual(beginTimeoutResult.toolResult.executionTrace.map(({ state }) => state), ["submitted", "timeout"]);
assert.strictEqual(beginTimeoutResult.vehicleStateSnapshot, beginTimeoutProvider.getSnapshot());

const failedCall = {
  requestId: "coordinator-begin-failed",
  commandId: "coordinator-begin-failed:1:unknown.tool",
  tool: "unknown.tool",
  args: {},
};
const beginFailedProvider = new DevVehicleStateProvider({ speedKph: 0, gear: "P" });
const beginFailedProviderBoundary = {
  getSnapshot: () => beginFailedProvider.getSnapshot(),
  ingestObservation: poisonProviderBoundary.ingestObservation,
};
const beginFailedCoordinator = new VehicleExecutionCoordinator({
  vehicleTools: new VehicleTools({ now: () => Date.parse(submittedAt) }),
  sensorSimulator: poisonSimulator,
  vehicleStateProvider: beginFailedProviderBoundary,
  now: () => coordinatorAt,
});
const beginFailedResult = await beginFailedCoordinator.execute(failedCall);
assert.equal(beginFailedResult.toolResult.executionState, "failed");
assert.equal(beginFailedResult.toolResult.executionError.code, "adapter-begin-failed");
assert.deepEqual(beginFailedResult.toolResult.executionTrace.map(({ state }) => state), ["submitted", "failed"]);
assert.strictEqual(beginFailedResult.vehicleStateSnapshot, beginFailedProvider.getSnapshot());

for (const [state, { componentCase, toolResult, vehicleStateProvider }] of terminalExamples) {
  const beforeLateObservation = vehicleStateProvider.getSnapshot();
  const lateObservation = {
    observationId: `late-observation-${state}`,
    commandId: toolResult.commandId,
    component: componentCase.component,
    source: "demo-sensor-simulator",
    simulated: true,
    capturedAt: observedAt,
    values: componentCase.requestedState,
  };
  const rejected = vehicleStateProvider.ingestObservation(lateObservation, { execution: toolResult });
  assert.deepEqual(rejected, { ok: false, reason: "execution is terminal" }, `${state} must reject late observation`);
  assert.strictEqual(vehicleStateProvider.getSnapshot(), beforeLateObservation);
}

const invalidObservationCase = componentCases[2];
const invalidObservationProvider = new DevVehicleStateProvider({ speedKph: 0, gear: "P" });
const invalidObservationFixture = createFixture({
  vehicleStateProvider: invalidObservationProvider,
  sensorSimulator: {
    async submit({ commandId, component, requestedState }) {
      return {
        observationId: "invalid-source-observation",
        commandId,
        component,
        source: "untrusted-sensor",
        simulated: true,
        capturedAt: observedAt,
        values: requestedState,
      };
    },
  },
});
const beforeInvalidObservation = invalidObservationProvider.getSnapshot();
const invalidObservationResult = await invalidObservationFixture.coordinator.execute(
  toolCall(invalidObservationCase, "provider-reject"),
);
assert.equal(invalidObservationResult.toolResult.executionState, "failed");
assert.equal(invalidObservationResult.toolResult.executionError.code, "sensor-observation-invalid");
assert.equal(invalidObservationResult.toolResult.executionError.retryable, false);
assert.strictEqual(invalidObservationResult.vehicleStateSnapshot, beforeInvalidObservation);

function acceptedBeginResult(toolCallValue, requestedState, component) {
  return createVehicleToolResult({
    requestId: toolCallValue.requestId,
    commandId: toolCallValue.commandId,
    tool: toolCallValue.tool,
    ok: true,
    executionState: "accepted",
    requestedState,
    executionTrace: [
      { state: "submitted", source: "test-adapter", at: submittedAt },
      { state: "accepted", source: "test-adapter", at: submittedAt, component },
    ],
    hmiSummary: "accepted",
    visualScenario: component === "window" ? "windowControl" : "cabin",
    source: "test-adapter",
    simulated: true,
    timestamp: submittedAt,
  });
}

for (const comparisonCase of [
  {
    name: "window map ignores key order",
    component: "window",
    tool: "body.window.setPosition",
    requestedState: {
      windowPositionPercentByZone: {
        front_left: 20,
      },
    },
    observedValues: {
      windowPositionPercentByZone: {
        front_left: 20,
      },
    },
    args: { zone: "front_left", percent: 20 },
  },
  {
    name: "partial climate ignores key order",
    component: "climate",
    tool: "cabin.climate.setPreset",
    requestedState: {
      passengerMode: "comfort",
      cabinTemperature: 23,
      airflow: "auto",
    },
    observedValues: {
      cabinTemperature: 23,
      passengerMode: "comfort",
      airflow: "auto",
    },
    args: { temperature: 23, passengerMode: "comfort", airflow: "auto" },
  },
  {
    name: "full climate ignores key order",
    component: "climate",
    tool: "cabin.climate.setPreset",
    requestedState: {
      cabinTemperature: 22,
      airflow: "rear_soft",
      passengerMode: "child_comfort",
    },
    observedValues: {
      passengerMode: "child_comfort",
      airflow: "rear_soft",
      cabinTemperature: 22,
    },
    args: { temperature: 22, airflow: "rear_soft", passengerMode: "child_comfort" },
  },
]) {
  const comparisonCall = {
    requestId: `comparison-${comparisonCase.component}-${comparisonCase.name}`,
    commandId: `comparison-${comparisonCase.component}-${comparisonCase.name}:1:${comparisonCase.tool}`,
    tool: comparisonCase.tool,
    args: comparisonCase.args,
  };
  const comparisonProvider = new DevVehicleStateProvider({ speedKph: 0, gear: "P" });
  const { coordinator } = createFixture({
    vehicleTools: {
      async execute(value) {
        return acceptedBeginResult(
          value,
          comparisonCase.requestedState,
          comparisonCase.component,
        );
      },
    },
    sensorSimulator: {
      async submit({ commandId, component }) {
        return {
          observationId: `comparison-observation-${comparisonCase.name}`,
          commandId,
          component,
          source: "demo-sensor-simulator",
          simulated: true,
          capturedAt: observedAt,
          values: comparisonCase.observedValues,
        };
      },
    },
    vehicleStateProvider: comparisonProvider,
  });
  const comparisonResult = await coordinator.execute(comparisonCall);
  assert.equal(comparisonResult.toolResult.executionState, "observed-succeeded", comparisonCase.name);
  assert.equal(comparisonResult.toolResult.confirmedSnapshotId, comparisonResult.vehicleStateSnapshot.id);
}

const validConstructorConfig = {
  vehicleTools: { execute: async () => undefined },
  sensorSimulator: { submit: async () => undefined },
  vehicleStateProvider: {
    ingestObservation: () => undefined,
    getSnapshot: () => undefined,
  },
  now: () => coordinatorAt,
  confirmationTimeoutMs: 1_000,
  timeoutScheduler: () => () => {},
};
assert.doesNotThrow(
  () => new VehicleExecutionCoordinator({
    vehicleTools: validConstructorConfig.vehicleTools,
    sensorSimulator: validConstructorConfig.sensorSimulator,
    vehicleStateProvider: validConstructorConfig.vehicleStateProvider,
  }),
  "constructor must provide safe clock, scheduler, and timeout defaults",
);
for (const [name, override] of [
  ["vehicleTools.execute", { vehicleTools: {} }],
  ["sensorSimulator.submit", { sensorSimulator: {} }],
  ["vehicleStateProvider.ingestObservation", {
    vehicleStateProvider: { getSnapshot: () => undefined },
  }],
  ["vehicleStateProvider.getSnapshot", {
    vehicleStateProvider: { ingestObservation: () => undefined },
  }],
  ["now", { now: null }],
  ["timeoutScheduler", { timeoutScheduler: null }],
  ["zero confirmationTimeoutMs", { confirmationTimeoutMs: 0 }],
  ["negative confirmationTimeoutMs", { confirmationTimeoutMs: -1 }],
  ["infinite confirmationTimeoutMs", { confirmationTimeoutMs: Infinity }],
]) {
  assert.throws(
    () => new VehicleExecutionCoordinator({ ...validConstructorConfig, ...override }),
    TypeError,
    `constructor must fail fast for invalid ${name}`,
  );
}

let customObservationSequence = 0;
async function executeCustomObservation({
  name,
  component = "climate",
  tool = "cabin.climate.setPreset",
  requestedState,
  observedValues,
  providerFixture = { speedKph: 0, gear: "P" },
  capturedAt = observedAt,
  confirmationTimeoutMs = 60_000,
}) {
  customObservationSequence += 1;
  const args = tool === "cabin.climate.setPreset"
    ? {
      temperature: requestedState.cabinTemperature,
      airflow: requestedState.airflow,
      passengerMode: requestedState.passengerMode,
    }
    : tool === "body.tailgate.open"
      ? { open: requestedState.tailgateOpen }
      : tool === "body.window.setPosition"
        ? {
          zone: Object.keys(requestedState.windowPositionPercentByZone)[0],
          percent: Object.values(requestedState.windowPositionPercentByZone)[0],
        }
        : {};
  const call = {
    requestId: `custom-observation-${name}`,
    commandId: `custom-observation-${name}:1:${tool}`,
    tool,
    args,
  };
  const provider = new DevVehicleStateProvider(providerFixture);
  const fixture = createFixture({
    vehicleTools: {
      async execute(value) {
        return acceptedBeginResult(value, requestedState, component);
      },
    },
    sensorSimulator: {
      async submit({ commandId, component: submittedComponent }) {
        return {
          observationId: `custom-observation-${customObservationSequence}`,
          commandId,
          component: submittedComponent,
          source: "demo-sensor-simulator",
          simulated: true,
          capturedAt,
          values: observedValues,
        };
      },
    },
    vehicleStateProvider: provider,
    confirmationTimeoutMs,
  });
  const beforeSnapshot = provider.getSnapshot();
  return {
    provider,
    beforeSnapshot,
    result: await fixture.coordinator.execute(call),
  };
}

const partialClimate = await executeCustomObservation({
  name: "partial-climate",
  requestedState: {
    cabinTemperature: 23,
    airflow: "rear_soft",
    passengerMode: "child_comfort",
  },
  observedValues: {
    cabinTemperature: 23,
  },
  providerFixture: {
    speedKph: 0,
    gear: "P",
    cabinTemperature: 23,
    airflow: "rear_soft",
    passengerMode: "child_comfort",
  },
});
assert.equal(partialClimate.result.toolResult.executionState, "failed");
assert.equal(partialClimate.result.toolResult.executionError.code, "sensor-observation-invalid");
assert.strictEqual(
  partialClimate.result.vehicleStateSnapshot,
  partialClimate.beforeSnapshot,
  "old Provider values must not fill fields missing from the current observation",
);

const nonExactWindowMap = await executeCustomObservation({
  name: "non-exact-window-map",
  component: "window",
  tool: "body.window.setPosition",
  requestedState: {
    windowPositionPercentByZone: {
      front_left: 20,
    },
  },
  observedValues: {
    windowPositionPercentByZone: {
      front_left: 20,
      rear_right: 80,
    },
  },
});
assert.equal(nonExactWindowMap.result.toolResult.executionState, "failed");
assert.equal(nonExactWindowMap.result.toolResult.executionError.code, "sensor-observation-conflict");
assert.notEqual(
  nonExactWindowMap.result.vehicleStateSnapshot.id,
  nonExactWindowMap.beforeSnapshot.id,
  "a legal conflicting window map remains a real Provider fact",
);

for (const timingCase of [
  {
    name: "before-executing",
    capturedAt: "2020-07-26T00:00:00.500Z",
    confirmationTimeoutMs: 60_000,
  },
  {
    name: "after-deadline",
    capturedAt: "2020-07-26T00:00:02.001Z",
    confirmationTimeoutMs: 1_000,
  },
  {
    name: "invalid-captured-at",
    capturedAt: "not-a-time",
    confirmationTimeoutMs: 60_000,
  },
]) {
  const timingResult = await executeCustomObservation({
    ...timingCase,
    requestedState: { tailgateOpen: true },
    observedValues: { tailgateOpen: true },
    component: "tailgate",
    tool: "body.tailgate.open",
  });
  assert.equal(timingResult.result.toolResult.executionState, "failed", timingCase.name);
  assert.equal(timingResult.result.toolResult.executionError.code, "sensor-observation-invalid", timingCase.name);
  assert.strictEqual(
    timingResult.result.vehicleStateSnapshot,
    timingResult.beforeSnapshot,
    `${timingCase.name} observation must be rejected before Provider ingestion`,
  );
}

for (const invalidMarker of [
  {
    name: "no-update command mismatch",
    build: ({ component }) => ({ type: "no-update", commandId: "wrong-command", component }),
  },
  {
    name: "timeout component mismatch",
    build: ({ commandId }) => ({ type: "timeout", commandId, component: "window" }),
  },
  {
    name: "timeout extra field",
    build: ({ commandId, component }) => ({
      type: "timeout",
      commandId,
      component,
      unexpected: true,
    }),
  },
  {
    name: "unknown marker type",
    build: ({ commandId, component }) => ({ type: "later", commandId, component }),
  },
]) {
  const markerCase = componentCases[2];
  const provider = new DevVehicleStateProvider({ speedKph: 0, gear: "P" });
  const beforeSnapshot = provider.getSnapshot();
  const { coordinator } = createFixture({
    sensorSimulator: {
      async submit(request) {
        return invalidMarker.build(request);
      },
    },
    vehicleStateProvider: provider,
  });
  const markerResult = await coordinator.execute(toolCall(markerCase, `invalid-marker-${invalidMarker.name}`));
  assert.equal(markerResult.toolResult.executionState, "failed", invalidMarker.name);
  assert.equal(markerResult.toolResult.executionError.code, "sensor-observation-invalid", invalidMarker.name);
  assert.strictEqual(markerResult.vehicleStateSnapshot, beforeSnapshot, invalidMarker.name);
}

function createManualTimeoutScheduler(returnMode = "function") {
  const entries = [];
  let cancelCount = 0;
  return {
    scheduler(callback, delayMs) {
      const entry = { callback, delayMs, active: true };
      entries.push(entry);
      const cancel = () => {
        if (!entry.active) return;
        entry.active = false;
        cancelCount += 1;
      };
      return returnMode === "handle" ? { cancel } : cancel;
    },
    runNext() {
      const entry = entries.find(({ active }) => active);
      if (!entry) return false;
      entry.active = false;
      entry.callback();
      return true;
    },
    get size() {
      return entries.length;
    },
    get delays() {
      return entries.map(({ delayMs }) => delayMs);
    },
    get cancelCount() {
      return cancelCount;
    },
  };
}

const deadlineScheduler = createManualTimeoutScheduler();
let resolveLateSensor;
let lateSensorRequest;
const lateSensorPromise = new Promise((resolve) => {
  resolveLateSensor = resolve;
});
const deadlineProvider = new DevVehicleStateProvider({ speedKph: 0, gear: "P" });
const beforeDeadline = deadlineProvider.getSnapshot();
const deadlineFixture = createFixture({
  sensorSimulator: {
    submit(request) {
      lateSensorRequest = request;
      return lateSensorPromise;
    },
  },
  vehicleStateProvider: deadlineProvider,
  confirmationTimeoutMs: 25,
  timeoutScheduler: deadlineScheduler.scheduler,
});
const deadlinePending = deadlineFixture.coordinator.execute(toolCall(componentCases[1], "deadline-race"));
for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
assert.equal(deadlineScheduler.size, 1, "Coordinator must schedule the configured confirmation deadline");
assert.deepEqual(deadlineScheduler.delays, [25]);
assert.equal(deadlineScheduler.runNext(), true);
const deadlineResult = await deadlinePending;
assert.equal(deadlineResult.toolResult.executionState, "timeout");
assert.equal(deadlineResult.toolResult.executionError.code, "sensor-timeout");
assert.strictEqual(deadlineResult.vehicleStateSnapshot, beforeDeadline);
resolveLateSensor({
  observationId: "late-after-deadline",
  commandId: lateSensorRequest.commandId,
  component: lateSensorRequest.component,
  source: "demo-sensor-simulator",
  simulated: true,
  capturedAt: observedAt,
  values: lateSensorRequest.requestedState,
});
for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
assert.strictEqual(
  deadlineProvider.getSnapshot(),
  beforeDeadline,
  "sensor resolution after deadline must never reach Provider",
);

for (const returnMode of ["function", "handle"]) {
  const cancellationScheduler = createManualTimeoutScheduler(returnMode);
  const cancellationFixture = createFixture({
    timeoutScheduler: cancellationScheduler.scheduler,
  });
  const cancellationResult = await cancellationFixture.coordinator.execute(
    toolCall(componentCases[0], `cancel-deadline-${returnMode}`),
  );
  assert.equal(cancellationResult.toolResult.executionState, "observed-succeeded");
  assert.equal(cancellationScheduler.cancelCount, 1, `${returnMode} timeout must be cancelled when sensor wins`);
  assert.equal(cancellationScheduler.runNext(), false, `${returnMode} cancelled timeout must not fire later`);
}

const defaultDeadlineScheduler = createManualTimeoutScheduler();
const defaultDeadlineProvider = new DevVehicleStateProvider({ speedKph: 0, gear: "P" });
const defaultDeadlineCoordinator = new VehicleExecutionCoordinator({
  vehicleTools: new VehicleTools({ now: () => Date.parse(submittedAt) }),
  sensorSimulator: new DemoSensorSimulator({
    now: () => observedAt,
    scheduler: immediateScheduler,
  }),
  vehicleStateProvider: defaultDeadlineProvider,
  now: () => coordinatorAt,
  timeoutScheduler: defaultDeadlineScheduler.scheduler,
});
const defaultDeadlineResult = await defaultDeadlineCoordinator.execute(
  toolCall(componentCases[0], "default-deadline"),
);
assert.equal(defaultDeadlineResult.toolResult.executionState, "observed-succeeded");
assert.deepEqual(defaultDeadlineScheduler.delays, [1_000], "default confirmation timeout must be bounded");
assert.equal(defaultDeadlineScheduler.cancelCount, 1);

const throwingProviderSnapshot = new DevVehicleStateProvider({ speedKph: 0, gear: "P" }).getSnapshot();
const throwingProviderFixture = createFixture({
  vehicleStateProvider: {
    ingestObservation() {
      throw new Error("Authorization: Bearer TOP_SECRET");
    },
    getSnapshot() {
      return throwingProviderSnapshot;
    },
  },
});
const throwingProviderResult = await throwingProviderFixture.coordinator.execute(
  toolCall(componentCases[3], "provider-throw"),
);
assert.equal(throwingProviderResult.toolResult.executionState, "failed");
assert.equal(throwingProviderResult.toolResult.executionError.code, "sensor-observation-invalid");
assert.equal(
  throwingProviderResult.toolResult.executionError.message,
  "Provider 无法摄入传感器观测。",
);
assert.doesNotMatch(JSON.stringify(throwingProviderResult), /TOP_SECRET/);
assert.strictEqual(throwingProviderResult.vehicleStateSnapshot, throwingProviderSnapshot);

const providerCurrentBaseline = Object.freeze({
  id: "provider-current-baseline",
  values: Object.freeze({ tailgateOpen: false }),
});
const providerMatchingSnapshot = Object.freeze({
  id: "provider-matching-snapshot",
  values: Object.freeze({ tailgateOpen: true }),
});

async function executeProviderBoundaryCase({
  name,
  ingestion,
  currentSnapshot = providerCurrentBaseline,
}) {
  const provider = {
    ingestObservation() {
      return typeof ingestion === "function" ? ingestion() : ingestion;
    },
    getSnapshot() {
      return currentSnapshot;
    },
  };
  const { coordinator } = createFixture({ vehicleStateProvider: provider });
  let result;
  await assert.doesNotReject(async () => {
    result = await coordinator.execute(toolCall(componentCases[1], `provider-shape-${name}`));
  }, `${name} must return a structured failure instead of throwing`);
  return result;
}

const unreadableOk = {};
Object.defineProperty(unreadableOk, "ok", {
  get() {
    throw new Error("ok getter exploded");
  },
});

for (const malformedProviderCase of [
  ["null ingestion", null],
  ["undefined ingestion", undefined],
  ["non-boolean ok", { ok: "true" }],
  ["ok false without reason", { ok: false }],
  ["ok true without snapshot", { ok: true }],
  ["snapshot without id", { ok: true, snapshot: { values: { tailgateOpen: true } } }],
  ["snapshot with blank id", { ok: true, snapshot: { id: " ", values: { tailgateOpen: true } } }],
  ["snapshot without values", { ok: true, snapshot: { id: "missing-values" } }],
  ["snapshot with array values", { ok: true, snapshot: { id: "array-values", values: [] } }],
  ["unreadable ok property", () => unreadableOk],
]) {
  const malformedResult = await executeProviderBoundaryCase({
    name: malformedProviderCase[0],
    ingestion: malformedProviderCase[1],
  });
  assert.equal(malformedResult.toolResult.executionState, "failed", malformedProviderCase[0]);
  assert.equal(
    malformedResult.toolResult.executionError.code,
    "sensor-observation-invalid",
    malformedProviderCase[0],
  );
  assert.equal(
    malformedResult.toolResult.executionError.message.includes("undefined"),
    false,
    `${malformedProviderCase[0]} must use a safe fallback message`,
  );
  assert.strictEqual(malformedResult.vehicleStateSnapshot, providerCurrentBaseline);
}

const providerConflictSnapshot = Object.freeze({
  id: "provider-conflict-snapshot",
  values: Object.freeze({ tailgateOpen: false }),
});
const providerConflictResult = await executeProviderBoundaryCase({
  name: "provider snapshot conflict",
  ingestion: { ok: true, snapshot: providerConflictSnapshot },
  currentSnapshot: providerConflictSnapshot,
});
assert.equal(providerConflictResult.toolResult.executionState, "failed");
assert.equal(providerConflictResult.toolResult.executionError.code, "sensor-observation-conflict");
assert.equal("confirmedSnapshotId" in providerConflictResult.toolResult, false);
assert.strictEqual(
  providerConflictResult.vehicleStateSnapshot,
  providerConflictSnapshot,
  "an ingested conflict must return the Provider current fact",
);

const providerDifferentCurrent = Object.freeze({
  id: "provider-different-current",
  values: Object.freeze({ tailgateOpen: true }),
});
const providerCurrentMismatchResult = await executeProviderBoundaryCase({
  name: "ingestion snapshot is not current",
  ingestion: { ok: true, snapshot: providerMatchingSnapshot },
  currentSnapshot: providerDifferentCurrent,
});
assert.equal(providerCurrentMismatchResult.toolResult.executionState, "failed");
assert.equal(providerCurrentMismatchResult.toolResult.executionError.code, "sensor-observation-invalid");
assert.equal("confirmedSnapshotId" in providerCurrentMismatchResult.toolResult, false);
assert.strictEqual(providerCurrentMismatchResult.vehicleStateSnapshot, providerDifferentCurrent);

const providerSameIdDifferentValues = Object.freeze({
  id: providerMatchingSnapshot.id,
  values: Object.freeze({ tailgateOpen: false }),
});
const providerIdentityCorruptionResult = await executeProviderBoundaryCase({
  name: "same snapshot id with different values",
  ingestion: { ok: true, snapshot: providerMatchingSnapshot },
  currentSnapshot: providerSameIdDifferentValues,
});
assert.equal(providerIdentityCorruptionResult.toolResult.executionState, "failed");
assert.equal(providerIdentityCorruptionResult.toolResult.executionError.code, "sensor-observation-invalid");
assert.equal("confirmedSnapshotId" in providerIdentityCorruptionResult.toolResult, false);
assert.strictEqual(
  providerIdentityCorruptionResult.vehicleStateSnapshot,
  providerSameIdDifferentValues,
  "same id with different values is Provider identity corruption",
);

function createThrowingSnapshotProvider(ingestObservation) {
  let getSnapshotCalls = 0;
  return {
    provider: {
      ingestObservation,
      getSnapshot() {
        getSnapshotCalls += 1;
        throw new Error("snapshot getter exploded");
      },
    },
    getSnapshotCalls: () => getSnapshotCalls,
  };
}

async function assertSnapshotGetterFailure({
  name,
  vehicleTools = new VehicleTools({ now: () => Date.parse(submittedAt) }),
  sensorMode = "success",
  ingestObservation,
  expectedState,
  expectedCode,
  call = toolCall(componentCases[1], `snapshot-getter-${name}`),
}) {
  const throwingSnapshot = createThrowingSnapshotProvider(ingestObservation);
  const { coordinator } = createFixture({
    vehicleTools,
    vehicleStateProvider: throwingSnapshot.provider,
    confirmationTimeoutMs: sensorMode === "no-update" ? 1 : 60_000,
  });
  let result;
  await assert.doesNotReject(async () => {
    result = await coordinator.execute(call, { sensorMode });
  }, `${name} snapshot getter failure must not escape`);
  assert.equal(result.toolResult.executionState, expectedState, name);
  assert.equal(result.toolResult.executionError.code, expectedCode, name);
  assert.equal(result.vehicleStateSnapshot, null, `${name} must expose unavailable snapshot as null`);
  assert.equal(throwingSnapshot.getSnapshotCalls(), 1, `${name} must read snapshot exactly once`);
  return result;
}

const duplicateGetterCall = toolCall(componentCases[0], "snapshot-getter-begin-duplicate");
const duplicateGetterTools = new VehicleTools({ now: () => Date.parse(submittedAt) });
await duplicateGetterTools.execute(duplicateGetterCall);
const terminalSnapshot = createThrowingSnapshotProvider(() => {
  throw new Error("begin terminal must not ingest");
});
const terminalSnapshotCoordinator = new VehicleExecutionCoordinator({
  vehicleTools: duplicateGetterTools,
  sensorSimulator: poisonSimulator,
  vehicleStateProvider: terminalSnapshot.provider,
  now: () => coordinatorAt,
  confirmationTimeoutMs: 1_000,
});
let terminalSnapshotResult;
await assert.doesNotReject(async () => {
  terminalSnapshotResult = await terminalSnapshotCoordinator.execute(duplicateGetterCall);
}, "begin terminal snapshot getter failure must not escape");
assert.equal(terminalSnapshotResult.toolResult.executionState, "duplicate-command");
assert.equal(terminalSnapshotResult.toolResult.executionError.code, "duplicate-command");
assert.equal(terminalSnapshotResult.vehicleStateSnapshot, null);
assert.equal(terminalSnapshot.getSnapshotCalls(), 1);

await assertSnapshotGetterFailure({
  name: "no-update terminal",
  sensorMode: "no-update",
  ingestObservation() {
    throw new Error("no-update must not ingest");
  },
  expectedState: "timeout",
  expectedCode: "sensor-no-update",
});
await assertSnapshotGetterFailure({
  name: "sensor timeout terminal",
  sensorMode: "timeout",
  ingestObservation() {
    throw new Error("timeout must not ingest");
  },
  expectedState: "timeout",
  expectedCode: "sensor-timeout",
});
await assertSnapshotGetterFailure({
  name: "ingestion throws",
  ingestObservation() {
    throw new Error("ingestion exploded");
  },
  expectedState: "failed",
  expectedCode: "sensor-observation-invalid",
});
await assertSnapshotGetterFailure({
  name: "malformed ingestion",
  ingestObservation() {
    return null;
  },
  expectedState: "failed",
  expectedCode: "sensor-observation-invalid",
});
await assertSnapshotGetterFailure({
  name: "success current read",
  ingestObservation() {
    return { ok: true, snapshot: providerMatchingSnapshot };
  },
  expectedState: "failed",
  expectedCode: "sensor-observation-invalid",
});

assert.equal(matrixCount, componentCases.length * modes.length);
console.log(`✅ vehicle execution coordinator verified (${matrixCount} component/mode cases + begin/late/invalid/deep comparisons)`);
