import assert from "node:assert/strict";
import { SafetyGateway, VEHICLE_STATE_FRESHNESS_POLICY } from "../../src/safety/safety-gateway.js";
import { DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";
import {
  applyDemoScenario,
  createDemoScenarioAuditData,
  DEMO_SCENARIO_CATALOG,
  getDemoScenario,
  normalizeDemoScenarioInput,
  validateDemoScenarioPatch,
} from "../../src/vehicle/demo-scenario-catalog.js";
import {
  DemoSensorSimulator,
  validateDemoVehicleStatePatch,
} from "../../src/vehicle/demo-sensor-simulator.js";

const baseNowMs = Date.now() - 250;
const freshAt = new Date(baseNowMs).toISOString();
const staleAt = new Date(
  baseNowMs - VEHICLE_STATE_FRESHNESS_POLICY.maxAgeMs - 1_000,
).toISOString();

function command(intent, slots) {
  return {
    requestId: `scenario-${intent}`,
    rawText: "",
    intent,
    confidence: 1,
    slots,
    slotProvenance: Object.fromEntries(Object.keys(slots).map((key) => [key, "explicit"])),
    speechAct: "command",
    actionability: {
      actionable: true,
      reason: "explicit scenario verification command",
      source: "unit-fixture",
      intendedIntent: intent,
    },
    source: "unit-fixture",
  };
}

function safetyDecision(snapshot, parsedCommand) {
  return new SafetyGateway({}, { now: () => baseNowMs }).evaluate(
    parsedCommand,
    { vehicleStateSnapshot: snapshot },
  );
}

function applyWithClock(scenario, capturedAt = freshAt, initialVehicleState = {}) {
  const simulator = new DemoSensorSimulator({
    now: () => capturedAt,
    initialVehicleState,
  });
  const vehicleStateProvider = new DevVehicleStateProvider();
  const result = applyDemoScenario({ simulator, vehicleStateProvider, scenario });
  return { simulator, vehicleStateProvider, result };
}

function collectKeys(value, keys = []) {
  if (!value || typeof value !== "object") return keys;
  for (const [key, entry] of Object.entries(value)) {
    keys.push(key);
    collectKeys(entry, keys);
  }
  return keys;
}

const expectedValues = {
  safe: {
    speedKph: 0,
    gear: "P",
    rearClearance: true,
    windowAntiPinchAvailable: true,
    rainDetected: false,
    driverBackrestAngle: 106,
    cabinTemperature: 22,
  },
  unsafe: {
    speedKph: 35,
    gear: "D",
    rearClearance: false,
    windowAntiPinchAvailable: false,
    rainDetected: true,
    driverBackrestAngle: 112,
    cabinTemperature: 22,
  },
  unknown: {
    speedKph: null,
    gear: null,
    rearClearance: null,
    windowAntiPinchAvailable: null,
    rainDetected: null,
    driverBackrestAngle: null,
    cabinTemperature: null,
  },
  confirmation: {
    speedKph: 0,
    gear: "P",
    rearClearance: null,
    windowAntiPinchAvailable: true,
    rainDetected: false,
    driverBackrestAngle: 106,
    cabinTemperature: 22,
  },
};

for (const [id, values] of Object.entries(expectedValues)) {
  const scenario = getDemoScenario(id);
  assert.ok(scenario, `${id} scenario must be registered`);
  assert.equal(scenario.id, id);
  assert.deepEqual(scenario.values, values);
  assert.equal(validateDemoScenarioPatch(scenario.values), true);
  assert.equal(validateDemoVehicleStatePatch(scenario.values), true);
  assert.equal(Object.isFrozen(scenario), true);
  assert.equal(Object.isFrozen(scenario.values), true);
  assert.deepEqual(
    Object.keys(scenario.values).sort(),
    [...VEHICLE_STATE_FRESHNESS_POLICY.timeSensitiveFields].sort(),
    `${id} must publish every Safety time-sensitive field`,
  );
}

assert.deepEqual(getDemoScenario("stale").values, expectedValues.safe);
assert.equal(getDemoScenario("sensor-fault").simulatorMode, "sensor-fault");
assert.deepEqual(getDemoScenario("sensor-fault").values, expectedValues.safe);
assert.equal(getDemoScenario("missing"), null);
assert.equal(Object.isFrozen(DEMO_SCENARIO_CATALOG), true);
assert.equal(validateDemoScenarioPatch({ speedKph: null, gear: null }), true);
assert.equal(validateDemoScenarioPatch({ speedKph: "35" }), false);
assert.equal(validateDemoScenarioPatch({ speedKph: -1 }), false);
assert.equal(validateDemoScenarioPatch({ safetyDecision: "allow" }), false);
assert.equal(validateDemoScenarioPatch({ allow: true }), false);

const queuedScenarioDescriptor = {
  id: "console:safe",
  values: expectedValues.safe,
  simulatorMode: "success",
};
const normalizedQueuedScenario = normalizeDemoScenarioInput(queuedScenarioDescriptor);
assert.equal(normalizedQueuedScenario.id, "console:safe");
assert.deepEqual(normalizedQueuedScenario.values, expectedValues.safe);
assert.equal(normalizedQueuedScenario.simulatorMode, "success");
assert.equal(Object.isFrozen(normalizedQueuedScenario), true);
assert.equal(Object.isFrozen(normalizedQueuedScenario.values), true);
const auditPrivateSentinel = "raw-user-input-must-not-enter-audit";
const stagedAuditData = createDemoScenarioAuditData({
  scenario: normalizedQueuedScenario,
  stagedAt: freshAt,
  capturedAtMode: "now",
  rawText: auditPrivateSentinel,
  safetyDecision: { allowed: true },
});
assert.deepEqual(stagedAuditData, {
  scenarioId: "console:safe",
  source: "demo-sensor-simulator",
  simulatorMode: "success",
  capturedAtMode: "now",
  stagedAt: freshAt,
});
assert.equal(Object.isFrozen(stagedAuditData), true);
assert.doesNotMatch(JSON.stringify(stagedAuditData), new RegExp(auditPrivateSentinel));
const consumedAuditData = createDemoScenarioAuditData({
  scenario: normalizedQueuedScenario,
  stagedAt: freshAt,
  capturedAtMode: "explicit",
  capturedAt: staleAt,
});
assert.equal(consumedAuditData.capturedAt, staleAt);
assert.equal(consumedAuditData.simulatorMode, "success");
assert.throws(
  () => createDemoScenarioAuditData({
    scenario: normalizedQueuedScenario,
    stagedAt: freshAt,
    capturedAtMode: "unsafe",
  }),
  /invalid capturedAt mode/,
);
assert.equal(
  normalizeDemoScenarioInput({
    id: "console:fault",
    values: expectedValues.safe,
    simulatorMode: "sensor-fault",
  }).simulatorMode,
  "sensor-fault",
);
for (const invalidDescriptor of [
  { id: "", values: expectedValues.safe, simulatorMode: "success" },
  { id: "console:invalid-values", values: { safetyDecision: "allow" }, simulatorMode: "success" },
  { id: "console:invalid-mode", values: expectedValues.safe, simulatorMode: "timeout" },
  { id: "console:extra-key", values: expectedValues.safe, simulatorMode: "success", safetyDecision: "allow" },
]) {
  assert.equal(
    normalizeDemoScenarioInput(invalidDescriptor),
    null,
    "queued scenario descriptors must not bypass id, value, or read-mode validation",
  );
}

for (const [field, patch] of [
  ["batteryPercent", { batteryPercent: null }],
  ["windowPositionPercentByZone", { windowPositionPercentByZone: null }],
]) {
  assert.equal(
    validateDemoScenarioPatch(patch),
    false,
    `${field} must retain its pre-scenario null validation rule`,
  );
  assert.throws(
    () => new DemoSensorSimulator().readVehicleState(patch),
    /invalid vehicle state patch/,
    `${field} null must not enter simulator state`,
  );
}
for (const [field, patch] of [
  ["batteryPercent", { batteryPercent: 72 }],
]) {
  assert.throws(
    () => new DemoSensorSimulator().readVehicleState(patch, { mode: "sensor-fault" }),
    /invalid sensor-fault vehicle state patch/,
    `sensor-fault mode must not synthesize null for ${field}`,
  );
}
assert.deepEqual(
  collectKeys(DEMO_SCENARIO_CATALOG)
    .filter((key) => ["safetyDecision", "allow", "reject", "clamp"].includes(key)),
  [],
  "scenario catalog must not encode Safety outcomes",
);

{
  const simulator = new DemoSensorSimulator({ now: () => freshAt });
  const vehicleStateProvider = new DevVehicleStateProvider({ speedKph: 9, gear: "D" });
  const before = vehicleStateProvider.getSnapshot();
  const reading = simulator.readVehicleState(expectedValues.safe);

  assert.equal(reading.source, "demo-sensor-simulator");
  assert.deepEqual(reading.values, expectedValues.safe);
  assert.equal(
    vehicleStateProvider.getSnapshot().id,
    before.id,
    "simulator reads must not mutate the Provider snapshot",
  );
  assert.equal(vehicleStateProvider.getSnapshot().values.speedKph, 9);

  const ingestion = vehicleStateProvider.ingestDemoSensorState(reading);
  assert.equal(ingestion.ok, true);
  assert.equal(vehicleStateProvider.getSnapshot().id, ingestion.snapshot.id);
  assert.deepEqual(
    Object.fromEntries(Object.keys(expectedValues.safe).map((key) => [
      key,
      ingestion.snapshot.values[key],
    ])),
    expectedValues.safe,
    "only Provider ingestion may publish the scenario as the trusted snapshot",
  );
}

const tailgateCommand = command("body.tailgate.open", { open: true });
for (const [scenarioId, capturedAt, expectedAction] of [
  ["safe", freshAt, "allow"],
  ["unsafe", freshAt, "reject"],
  ["unknown", freshAt, "unavailable"],
  ["stale", staleAt, "unavailable"],
]) {
  const scenario = getDemoScenario(scenarioId);
  const { result, vehicleStateProvider } = applyWithClock(scenario, capturedAt);
  assert.equal(result.scenarioId, scenarioId);
  assert.equal(result.ingestion.ok, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.reading), true);
  assert.equal(result.reading.capturedAt, capturedAt);
  const decision = safetyDecision(vehicleStateProvider.getSnapshot(), tailgateCommand);
  assert.equal(
    decision.vehicleStateAudit.freshness.status,
    scenarioId === "stale" ? "stale" : "fresh",
    `${scenarioId}: aggregate Safety freshness`,
  );
  assert.equal(
    decision.action,
    expectedAction,
    `${scenarioId} tailgate result must be calculated by Safety from the Provider snapshot`,
  );
  if (scenarioId !== "safe") {
    assert.notEqual(decision.action, "allow", `${scenarioId} must not silently allow tailgate opening`);
  }
}

{
  const scenario = getDemoScenario("sensor-fault");
  const { result, vehicleStateProvider } = applyWithClock(
    scenario,
    freshAt,
    expectedValues.safe,
  );
  assert.equal(result.ingestion.ok, true);
  assert.deepEqual(
    Object.fromEntries(Object.keys(expectedValues.safe).map((key) => [
      key,
      vehicleStateProvider.getSnapshot().values[key],
    ])),
    expectedValues.unknown,
    "sensor-fault mode must publish unavailable readings rather than a Safety result",
  );
  assert.notEqual(
    safetyDecision(vehicleStateProvider.getSnapshot(), tailgateCommand).action,
    "allow",
  );
  const decision = safetyDecision(vehicleStateProvider.getSnapshot(), tailgateCommand);
  assert.equal(decision.vehicleStateAudit.freshness.status, "fresh");
  assert.equal(decision.vehicleStateAudit.freshness.invalidatedFields.length, 0);
}

const windowCommand = command("body.window.setPosition", {
  zone: "front_left",
  percent: 50,
});

{
  const { vehicleStateProvider } = applyWithClock(getDemoScenario("safe"));
  assert.equal(
    safetyDecision(vehicleStateProvider.getSnapshot(), windowCommand).action,
    "allow",
    "dry conditions with anti-pinch available must exercise the allow branch",
  );
}

{
  const rainyScenario = Object.freeze({
    id: "rainy",
    values: Object.freeze({
      windowAntiPinchAvailable: true,
      rainDetected: true,
    }),
  });
  const { vehicleStateProvider } = applyWithClock(rainyScenario);
  assert.equal(
    safetyDecision(vehicleStateProvider.getSnapshot(), windowCommand).action,
    "clamp",
    "rain must exercise Safety's non-allow branch without prewriting its outcome",
  );
}

{
  const antiPinchUnavailable = Object.freeze({
    id: "anti-pinch-unavailable",
    values: Object.freeze({
      windowAntiPinchAvailable: false,
      rainDetected: false,
    }),
  });
  const { vehicleStateProvider } = applyWithClock(antiPinchUnavailable);
  assert.equal(
    safetyDecision(vehicleStateProvider.getSnapshot(), windowCommand).action,
    "reject",
    "anti-pinch failure must exercise Safety's rejection branch",
  );
}

console.log("✅ demo scenario console verified");
