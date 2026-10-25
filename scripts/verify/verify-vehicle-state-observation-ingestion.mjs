import assert from "node:assert/strict";
import { DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";

const submittedAt = "2026-07-26T00:00:00.000Z";
const provider = new DevVehicleStateProvider({
  speedKph: 0,
  gear: "P",
  windowAntiPinchAvailable: true,
});

function execution(commandId, tool, requestedState = {}, executionState = "executing") {
  return {
    commandId,
    tool,
    requestedState,
    executionState,
    executionTrace: [{ state: "submitted", source: "test", at: submittedAt }],
  };
}

function observation({
  observationId = "observation-1",
  commandId = "command-1",
  component = "window",
  capturedAt = "2026-07-26T00:00:01.000Z",
  values = { windowPositionPercentByZone: { front_left: 30 } },
} = {}) {
  return {
    observationId,
    commandId,
    component,
    source: "demo-sensor-simulator",
    simulated: true,
    capturedAt,
    values,
  };
}

const windowExecution = execution("command-1", "body.window.setPosition", { windowPositionPercentByZone: { front_left: 30 } });
const commandMismatch = provider.ingestObservation(observation({ commandId: "other-command" }), { execution: windowExecution });
assert.deepEqual(commandMismatch, { ok: false, reason: "commandId mismatch" });
assert.equal(provider.getSnapshot().values.windowPositionPercentByZone, null, "rejected observations must not update provider state");

const componentMismatch = provider.ingestObservation(observation({ component: "seat" }), { execution: windowExecution });
assert.deepEqual(componentMismatch, { ok: false, reason: "component mismatch" });

const invalidTime = provider.ingestObservation(observation({ observationId: "invalid-time", capturedAt: "not-a-date" }), { execution: windowExecution });
assert.deepEqual(invalidTime, { ok: false, reason: "invalid capturedAt" });

const premature = provider.ingestObservation(observation({ observationId: "premature", capturedAt: "2026-07-25T23:59:59.000Z" }), { execution: windowExecution });
assert.deepEqual(premature, { ok: false, reason: "capturedAt predates submission" });

const unauthorizedField = provider.ingestObservation(observation({
  observationId: "unauthorized-field",
  values: { windowPositionPercentByZone: { front_left: 30 }, rearClearance: true },
}), { execution: windowExecution });
assert.deepEqual(unauthorizedField, { ok: false, reason: "observation contains unauthorized values" });

const terminalLate = provider.ingestObservation(observation({ observationId: "terminal-late" }), {
  execution: execution("command-1", "body.window.setPosition", {}, "failed"),
});
assert.deepEqual(terminalLate, { ok: false, reason: "execution is terminal" });

const damagedTrace = provider.ingestObservation(observation({ observationId: "damaged-trace" }), {
  execution: {
    commandId: "command-1",
    tool: "body.window.setPosition",
    executionState: "executing",
    executionTrace: { state: "submitted", at: submittedAt },
  },
});
assert.deepEqual(damagedTrace, { ok: false, reason: "invalid execution submission timestamp" });

const safetyTimesBeforeWindowObservation = provider.getSnapshot().capturedAtByField;
const windowTimeObservation = provider.ingestObservation(observation({
  observationId: "window-time-observation",
  commandId: "window-time-command",
  capturedAt: "2026-07-26T00:00:02.000Z",
}), {
  execution: execution("window-time-command", "body.window.setPosition", { windowPositionPercentByZone: { front_left: 30 } }),
});
assert.equal(windowTimeObservation.ok, true);
for (const field of ["speedKph", "gear", "rearClearance", "windowAntiPinchAvailable", "rainDetected"]) {
  assert.equal(
    windowTimeObservation.snapshot.capturedAtByField[field],
    safetyTimesBeforeWindowObservation[field],
    `window observation must not refresh ${field} timestamp`,
  );
}

const cases = [
  [
    "window",
    execution("window-command", "body.window.setPosition", { windowPositionPercentByZone: { front_left: 30 } }),
    observation({ observationId: "window-observation", commandId: "window-command", values: { windowPositionPercentByZone: { front_left: 30 } } }),
    { windowPositionPercentByZone: { front_left: 30 } },
  ],
  [
    "tailgate",
    execution("tailgate-command", "body.tailgate.open", { tailgateOpen: true }),
    observation({ observationId: "tailgate-observation", commandId: "tailgate-command", component: "tailgate", values: { tailgateOpen: true } }),
    { tailgateOpen: true },
  ],
  [
    "seat",
    execution("seat-command", "seat.driver.setBackrestAngle", { driverBackrestAngle: 108 }),
    observation({ observationId: "seat-observation", commandId: "seat-command", component: "seat", values: { driverBackrestAngle: 108 } }),
    { driverBackrestAngle: 108 },
  ],
  [
    "vehicle-component",
    execution("component-command", "vehicle.component.setState", { componentActionStateById: { hood_open: 1 } }),
    observation({
      observationId: "component-observation",
      commandId: "component-command",
      component: "vehicle-component",
      values: { componentActionStateById: { hood_open: 1 } },
    }),
    { componentActionStateById: { hood_open: 1 } },
  ],
  [
    "climate",
    execution("climate-command", "cabin.climate.setPreset", { cabinTemperature: 24, airflow: "auto", passengerMode: "comfort" }),
    observation({ observationId: "climate-observation", commandId: "climate-command", component: "climate", values: { cabinTemperature: 24, airflow: "auto", passengerMode: "comfort" } }),
    { cabinTemperature: 24, airflow: "auto", passengerMode: "comfort" },
  ],
];

for (const [name, componentExecution, componentObservation, expected] of cases) {
  const result = provider.ingestObservation(componentObservation, { execution: componentExecution });
  assert.equal(result.ok, true, `${name} observation must be accepted`);
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, result.snapshot.values[key]])), expected);
  assert.equal(Object.isFrozen(result.snapshot.values), true, `${name} snapshot values must be frozen`);
  assert.equal(provider.getSnapshot().id, result.snapshot.id, `${name} observation must become the confirmed snapshot`);
  assert.equal(provider.getSnapshot().source, result.snapshot.source, `${name} source must remain stable on read`);
  assert.equal(provider.getSnapshot().capturedAt, result.snapshot.capturedAt, `${name} timestamp must remain stable on read`);
}

const beforeDuplicate = provider.getSnapshot();
const duplicate = provider.ingestObservation(cases[0][2], { execution: cases[0][1] });
assert.deepEqual(duplicate, { ok: false, reason: "duplicate observationId" });
assert.deepEqual(provider.getSnapshot(), beforeDuplicate, "rejected observation must not update snapshot metadata or facts");

console.log("✅ vehicle state observation ingestion verified");
