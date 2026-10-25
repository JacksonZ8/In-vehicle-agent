import assert from "node:assert/strict";
import { DEMO_SENSOR_MODES, DemoSensorSimulator } from "../../src/vehicle/demo-sensor-simulator.js";
import { DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";

function createManualScheduler() {
  const scheduled = [];
  return {
    scheduler(callback, latencyMs) {
      scheduled.push({ callback, latencyMs });
    },
    runNext() {
      const task = scheduled.shift();
      assert.ok(task, "a sensor result must be scheduled");
      task.callback();
    },
    get size() {
      return scheduled.length;
    },
  };
}

const components = [
  ["window", { windowPositionPercentByZone: { front_left: 30, rear_right: 0 } }],
  ["tailgate", { tailgateOpen: true }],
  ["seat", { driverBackrestAngle: 108 }],
  ["climate", { cabinTemperature: 24, airflow: "auto", passengerMode: "comfort" }],
];
const toolsByComponent = {
  window: "body.window.setPosition",
  tailgate: "body.tailgate.open",
  seat: "seat.driver.setBackrestAngle",
  climate: "cabin.climate.setPreset",
};

assert.deepEqual(DEMO_SENSOR_MODES, ["success", "no-update", "conflict", "timeout"]);
assert.equal(Object.isFrozen(DEMO_SENSOR_MODES), true, "mode list must be immutable");

{
  let readAt = "2026-07-26T00:00:00.000Z";
  const simulator = new DemoSensorSimulator({
    now: () => readAt,
    initialVehicleState: {
      batteryPercent: 72,
      speedKph: 0,
      gear: "P",
      rearClearance: null,
      windowAntiPinchAvailable: true,
      rainDetected: false,
    },
  });
  const first = simulator.readVehicleState();
  assert.equal(first.source, "demo-sensor-simulator");
  assert.equal(first.capturedAt, readAt);
  assert.equal(first.values.rearClearance, null, "unknown sensor state must remain explicit");
  readAt = "2026-07-26T00:00:06.000Z";
  const second = simulator.readVehicleState({ speedKph: 62, gear: "D" });
  assert.equal(second.capturedAt, readAt, "each sensor read must receive a fresh timestamp");
  assert.equal(second.values.speedKph, 62);
  assert.equal(second.values.gear, "D");
  assert.equal(simulator.readVehicleState().values.speedKph, 62, "demo sensor patch must persist at the sensor source");
  const componentState = simulator.readVehicleState({
    tailgateOpen: true,
    windowPositionPercentByZone: { front_left: 45 },
  });
  assert.equal(componentState.values.tailgateOpen, true, "developer sensor reading may express tailgate truth");
  assert.equal(
    componentState.values.windowPositionPercentByZone.front_left,
    45,
    "developer sensor reading may express window truth",
  );
  assert.throws(
    () => simulator.readVehicleState({ speedKph: -1 }),
    /invalid vehicle state patch/,
    "demo sensor must reject negative speed",
  );
}

for (const [component, requestedState] of components) {
  const manual = createManualScheduler();
  const simulator = new DemoSensorSimulator({
    now: () => "2026-07-26T00:00:01.000Z",
    scheduler: manual.scheduler,
    defaultLatencyMs: 12,
  });
  const before = structuredClone(requestedState);

  const pending = simulator.submit({
    commandId: `command-${component}`,
    component,
    requestedState,
  });
  assert.equal(manual.size, 1, `${component} success must use the injected scheduler`);
  manual.runNext();
  const observation = await pending;

  assert.deepEqual(observation.values, requestedState, `${component} success must report requested sensor values`);
  assert.equal(observation.commandId, `command-${component}`);
  assert.equal(observation.component, component);
  assert.equal(observation.source, "demo-sensor-simulator");
  assert.equal(observation.simulated, true);
  assert.equal(observation.capturedAt, "2026-07-26T00:00:01.000Z");
  assert.equal(Object.isFrozen(observation), true, `${component} observation must be immutable`);
  assert.equal(Object.isFrozen(observation.values), true, `${component} observation values must be immutable`);
  if (component === "window") assert.equal(Object.isFrozen(observation.values.windowPositionPercentByZone), true);
  assert.deepEqual(requestedState, before, `${component} requested state must not be modified`);
  const persistedReading = simulator.readVehicleState();
  for (const [field, expected] of Object.entries(observation.values)) {
    assert.deepEqual(
      persistedReading.values[field],
      expected,
      `${component} success must persist the simulated physical state across sensor reads`,
    );
  }
}

const stableManual = createManualScheduler();
const stableSimulator = new DemoSensorSimulator({
  now: () => "2026-07-26T00:00:02.000Z",
  scheduler: stableManual.scheduler,
});
const firstPending = stableSimulator.submit({
  commandId: "stable-command",
  component: "tailgate",
  requestedState: { tailgateOpen: true },
});
const secondPending = stableSimulator.submit({
  commandId: "stable-command",
  component: "tailgate",
  requestedState: { tailgateOpen: true },
});
stableManual.runNext();
stableManual.runNext();
const [firstObservation, secondObservation] = await Promise.all([firstPending, secondPending]);
assert.equal(firstObservation.observationId, "demo-observation:stable-command:tailgate:1:2026-07-26T00:00:02.000Z");
assert.notEqual(firstObservation.observationId, secondObservation.observationId, "one simulator must issue unique observation ids");

for (const [component, requestedState] of components) {
  const manual = createManualScheduler();
  const simulator = new DemoSensorSimulator({
    now: () => "2020-07-26T00:00:03.000Z",
    scheduler: manual.scheduler,
  });
  const pending = simulator.submit({
    commandId: `conflict-${component}`,
    component,
    requestedState,
    mode: "conflict",
  });
  manual.runNext();
  const observation = await pending;

  assert.equal(observation.component, component);
  assert.equal(observation.source, "demo-sensor-simulator");
  assert.equal(observation.simulated, true);
  assert.notDeepEqual(observation.values, requestedState, `${component} conflict must disagree with the request`);
  assert.equal(Object.isFrozen(observation), true, `${component} conflict must be immutable`);
  const persistedReading = simulator.readVehicleState();
  for (const [field, actual] of Object.entries(observation.values)) {
    assert.deepEqual(
      persistedReading.values[field],
      actual,
      `${component} conflict must persist the observed physical state instead of the requested target`,
    );
  }
  const accepted = new DevVehicleStateProvider().ingestObservation(observation, {
    execution: {
      commandId: observation.commandId,
      tool: toolsByComponent[component],
      executionState: "executing",
      executionTrace: [{ state: "submitted", source: "test", at: "2020-07-26T00:00:00.000Z" }],
    },
  });
  assert.equal(accepted.ok, true, `${component} conflict must pass the Provider observation schema`);
}

const noUpdateSimulator = new DemoSensorSimulator({ initialVehicleState: { driverBackrestAngle: 106 } });
const noUpdate = await noUpdateSimulator.submit({
  commandId: "no-update-command",
  component: "seat",
  requestedState: { driverBackrestAngle: 110 },
  mode: "no-update",
});
assert.deepEqual(noUpdate, { type: "no-update", commandId: "no-update-command", component: "seat" });
assert.equal(Object.isFrozen(noUpdate), true, "NoUpdate result must be immutable");
assert.equal("observationId" in noUpdate, false, "NoUpdate must not impersonate an observation");
assert.equal(
  noUpdateSimulator.readVehicleState().values.driverBackrestAngle,
  106,
  "NoUpdate must leave the simulated physical state unchanged",
);

const timeoutManual = createManualScheduler();
const timeoutSimulator = new DemoSensorSimulator({
  scheduler: timeoutManual.scheduler,
  defaultLatencyMs: 99,
  initialVehicleState: { driverBackrestAngle: 106 },
});
const timeoutPending = timeoutSimulator.submit({
  commandId: "timeout-command",
  component: "seat",
  requestedState: { driverBackrestAngle: 110 },
  mode: "timeout",
});
assert.equal(timeoutManual.size, 1, "timeout completion must be controlled by the injected scheduler");
timeoutManual.runNext();
const timeout = await timeoutPending;
assert.deepEqual(timeout, { type: "timeout", commandId: "timeout-command", component: "seat" });
assert.equal(Object.isFrozen(timeout), true, "timeout must resolve to an immutable coordinator-visible result");
assert.equal(
  timeoutSimulator.readVehicleState().values.driverBackrestAngle,
  106,
  "timeout must leave the simulated physical state unchanged",
);

const validWindowRequest = { windowPositionPercentByZone: { front_left: 50 } };
const futureManual = createManualScheduler();
let controlledClock = new Date(Date.now() + 60_000).toISOString();
const futureSimulator = new DemoSensorSimulator({ now: () => controlledClock, scheduler: futureManual.scheduler });
const futurePending = futureSimulator.submit({
  commandId: "future-observation",
  component: "window",
  requestedState: validWindowRequest,
});
futureManual.runNext();
await assert.rejects(futurePending, /capturedAt is in the future/, "future sensor time must reject instead of producing an observation");
controlledClock = "2020-07-26T00:00:04.000Z";
const afterFuturePending = futureSimulator.submit({
  commandId: "after-future-observation",
  component: "window",
  requestedState: validWindowRequest,
});
futureManual.runNext();
const afterFutureObservation = await afterFuturePending;
assert.equal(
  afterFutureObservation.observationId,
  "demo-observation:after-future-observation:window:2:2020-07-26T00:00:04.000Z",
  "a rejected future reading must retain the sequence consumed by its valid submission",
);

const invalidSubmissions = [
  ["blank command id", { commandId: " ", component: "window", requestedState: validWindowRequest }, /invalid commandId/],
  ["unknown component", { commandId: "invalid-component", component: "door", requestedState: validWindowRequest }, /invalid component/],
  ["unknown mode", { commandId: "invalid-mode", component: "window", requestedState: validWindowRequest, mode: "later" }, /invalid mode/],
  ["negative latency", { commandId: "negative-latency", component: "window", requestedState: validWindowRequest, latencyMs: -1 }, /invalid latencyMs/],
  ["infinite latency", { commandId: "infinite-latency", component: "window", requestedState: validWindowRequest, latencyMs: Infinity }, /invalid latencyMs/],
  ["non-object request", { commandId: "array-request", component: "window", requestedState: [] }, /invalid requestedState/],
  ["empty request", { commandId: "empty-request", component: "window", requestedState: {} }, /invalid requestedState/],
  ["unauthorized field", { commandId: "wrong-field", component: "window", requestedState: { tailgateOpen: true } }, /invalid requestedState/],
  ["empty window map", { commandId: "empty-window", component: "window", requestedState: { windowPositionPercentByZone: {} } }, /invalid requestedState/],
  ["empty window zone", { commandId: "empty-window-zone", component: "window", requestedState: { windowPositionPercentByZone: { "": 20 } } }, /invalid requestedState/],
  ["invalid window zone", { commandId: "bad-window-zone", component: "window", requestedState: { windowPositionPercentByZone: { nowhere: 20 } } }, /invalid requestedState/],
  ["window out of range", { commandId: "bad-window-percent", component: "window", requestedState: { windowPositionPercentByZone: { front_left: 101 } } }, /invalid requestedState/],
  ["non-boolean tailgate", { commandId: "bad-tailgate", component: "tailgate", requestedState: { tailgateOpen: "true" } }, /invalid requestedState/],
  ["non-finite seat", { commandId: "bad-seat", component: "seat", requestedState: { driverBackrestAngle: Infinity } }, /invalid requestedState/],
  ["empty climate", { commandId: "empty-climate", component: "climate", requestedState: {} }, /invalid requestedState/],
  ["non-finite climate temperature", { commandId: "bad-climate-temperature", component: "climate", requestedState: { cabinTemperature: Infinity } }, /invalid requestedState/],
  ["invalid climate enum", { commandId: "bad-climate", component: "climate", requestedState: { airflow: "turbo" } }, /invalid requestedState/],
  ["invalid passenger mode", { commandId: "bad-passenger-mode", component: "climate", requestedState: { passengerMode: "unknown" } }, /invalid requestedState/],
];

for (const [name, submission, error] of invalidSubmissions) {
  await assert.rejects(new DemoSensorSimulator().submit(submission), error, `${name} must fail closed`);
}

await assert.rejects(new DemoSensorSimulator({ defaultLatencyMs: -1 }).submit({
  commandId: "invalid-default-latency",
  component: "window",
  requestedState: validWindowRequest,
}), /invalid latencyMs/, "an invalid default latency must fail closed");

await assert.rejects(new DemoSensorSimulator().submit({
  commandId: "no-update-invalid",
  component: "window",
  requestedState: {},
  mode: "no-update",
}), /invalid requestedState/, "no-update must validate before returning a result");

const invalidTimeoutManual = createManualScheduler();
await assert.rejects(new DemoSensorSimulator({ scheduler: invalidTimeoutManual.scheduler }).submit({
  commandId: "timeout-invalid",
  component: "window",
  requestedState: {},
  mode: "timeout",
}), /invalid requestedState/, "timeout must validate before scheduling");
assert.equal(invalidTimeoutManual.size, 0, "invalid timeout must not schedule work");

await assert.rejects(new DemoSensorSimulator({
  scheduler() {
    throw new Error("scheduler failed");
  },
}).submit({
  commandId: "scheduler-throw",
  component: "window",
  requestedState: validWindowRequest,
}), /scheduler failed/, "a scheduler exception must reject submit");

const invalidNowManual = createManualScheduler();
const invalidNowPending = new DemoSensorSimulator({
  now: () => "not-a-timestamp",
  scheduler: invalidNowManual.scheduler,
}).submit({
  commandId: "invalid-now",
  component: "window",
  requestedState: validWindowRequest,
});
invalidNowManual.runNext();
await assert.rejects(invalidNowPending, /Invalid time value/, "a callback exception must reject submit");

for (const [name, requestedState, expectedValues] of [
  ["airflow only", { airflow: "auto" }, { airflow: "low" }],
  ["passenger mode only", { passengerMode: "comfort" }, { passengerMode: "child_comfort" }],
]) {
  const manual = createManualScheduler();
  const simulator = new DemoSensorSimulator({ now: () => "2020-07-26T00:00:03.000Z", scheduler: manual.scheduler });
  const pending = simulator.submit({
    commandId: `climate-conflict-${name}`,
    component: "climate",
    requestedState,
    mode: "conflict",
  });
  manual.runNext();
  const observation = await pending;
  assert.deepEqual(observation.values, expectedValues, `${name} conflict must choose a legal, different enum`);
  const accepted = new DevVehicleStateProvider().ingestObservation(observation, {
    execution: {
      commandId: observation.commandId,
      tool: toolsByComponent.climate,
      executionState: "executing",
      executionTrace: [{ state: "submitted", source: "test", at: "2020-07-26T00:00:00.000Z" }],
    },
  });
  assert.equal(accepted.ok, true, `${name} conflict must pass the Provider observation schema`);
}

console.log("✅ demo sensor simulator verified");
