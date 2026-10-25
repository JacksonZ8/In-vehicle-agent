import assert from "node:assert/strict";
import { SafetyGateway, VEHICLE_STATE_FRESHNESS_POLICY } from "../../src/safety/safety-gateway.js";
import { VEHICLE_STATE_KEYS, createVehicleStateSnapshot, DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";

const unknown = createVehicleStateSnapshot();
assert.equal(unknown.source, "unknown");
assert.deepEqual(unknown.values, {
  windowPositionPercentByZone: null,
  vehicleLocked: null,
  tailgateOpen: null,
  driverBackrestAngle: null,
  seatComfortByZone: null,
  componentActionStateById: null,
  cabinTemperature: null,
  climatePower: null,
  climateMode: null,
  fanLevel: null,
  airflow: null,
  passengerMode: null,
  batteryPercent: null,
  speedKph: null,
  gear: null,
  rearClearance: null,
  windowAntiPinchAvailable: null,
  rainDetected: null,
});
assert.deepEqual(VEHICLE_STATE_KEYS, Object.keys(unknown.values), "snapshot keys must be exported from the Provider contract");

const inputWindowPositions = { front_left: 45, rear_right: 0 };
const inputComponentActions = { hood_open: 1, driver_seat_height: 4 };
const normalized = createVehicleStateSnapshot({
  values: {
    windowPositionPercentByZone: inputWindowPositions,
    tailgateOpen: true,
    driverBackrestAngle: 106,
    componentActionStateById: inputComponentActions,
    cabinTemperature: 24,
    airflow: "auto",
    passengerMode: "comfort",
    batteryPercent: 72,
    speedKph: 0,
    gear: "P",
    rearClearance: false,
    windowAntiPinchAvailable: true,
    rainDetected: false,
  },
});
assert.deepEqual(normalized.values.windowPositionPercentByZone, { front_left: 45, rear_right: 0 });
assert.notEqual(normalized.values.windowPositionPercentByZone, inputWindowPositions, "window map must be copied");
assert.equal(Object.isFrozen(normalized.values.windowPositionPercentByZone), true, "window map must be frozen");
assert.equal(Object.isFrozen(normalized.values), true, "values must be frozen");
assert.equal(normalized.values.tailgateOpen, true);
assert.equal(normalized.values.driverBackrestAngle, 106);
assert.deepEqual(normalized.values.componentActionStateById, inputComponentActions);
assert.notEqual(normalized.values.componentActionStateById, inputComponentActions, "component action map must be copied");
assert.equal(Object.isFrozen(normalized.values.componentActionStateById), true, "component action map must be frozen");
assert.equal(normalized.values.cabinTemperature, 24);
assert.equal(normalized.values.airflow, "auto");
assert.equal(normalized.values.passengerMode, "comfort");

const fixtureCapturedAt = "2026-07-26T00:00:00.000Z";
const timestampedFixture = createVehicleStateSnapshot({
  capturedAt: fixtureCapturedAt,
  values: { speedKph: 0, gear: "P", rearClearance: true, windowPositionPercentByZone: { front_left: 30 } },
});
assert.equal(Object.isFrozen(timestampedFixture.capturedAtByField), true, "field timestamps must be frozen");
assert.deepEqual(Object.keys(timestampedFixture.capturedAtByField), VEHICLE_STATE_KEYS, "field timestamps must cover every state key");
assert.equal(timestampedFixture.capturedAtByField.speedKph, fixtureCapturedAt);
assert.equal(timestampedFixture.capturedAtByField.gear, fixtureCapturedAt);
assert.equal(timestampedFixture.capturedAtByField.rearClearance, fixtureCapturedAt);
assert.equal(timestampedFixture.capturedAtByField.windowPositionPercentByZone, fixtureCapturedAt, "window positions use one top-level field timestamp");
assert.equal(timestampedFixture.capturedAtByField.rainDetected, null, "null fixture fields must not gain timestamps");

const rejectedLooseNumbers = createVehicleStateSnapshot({
  values: {
    windowPositionPercentByZone: { front_left: "50", rear_right: 101 },
    driverBackrestAngle: null,
    componentActionStateById: { unknown_action: 1 },
    cabinTemperature: "",
    batteryPercent: true,
    speedKph: null,
    gear: "drive",
    airflow: "turbo",
    passengerMode: "unknown",
    tailgateOpen: "true",
    rearClearance: 1,
    windowAntiPinchAvailable: false,
    rainDetected: null,
  },
});
assert.equal(rejectedLooseNumbers.values.windowPositionPercentByZone, null, "invalid window percentages must not be partially trusted");
assert.equal(rejectedLooseNumbers.values.driverBackrestAngle, null, "null must not become a numeric backrest angle");
assert.equal(rejectedLooseNumbers.values.componentActionStateById, null, "unknown component actions must fail closed");
assert.equal(rejectedLooseNumbers.values.cabinTemperature, null, "empty string must not become a numeric cabin temperature");
assert.equal(rejectedLooseNumbers.values.batteryPercent, null, "boolean must not become a numeric battery percent");
assert.equal(rejectedLooseNumbers.values.speedKph, null, "null must not become zero speed");
assert.equal(rejectedLooseNumbers.values.gear, null, "unknown gear enum must be rejected");
assert.equal(rejectedLooseNumbers.values.airflow, null, "unknown airflow enum must be rejected");
assert.equal(rejectedLooseNumbers.values.passengerMode, null, "unknown passenger mode enum must be rejected");
assert.equal(rejectedLooseNumbers.values.tailgateOpen, null, "boolean fields only accept boolean or null");
assert.equal(rejectedLooseNumbers.values.rearClearance, null, "boolean fields only accept boolean or null");
assert.equal(rejectedLooseNumbers.values.windowAntiPinchAvailable, false);
assert.equal(rejectedLooseNumbers.values.rainDetected, null);

const provider = new DevVehicleStateProvider({ speedKph: 0, gear: "P", rearClearance: null, windowAntiPinchAvailable: true, rainDetected: false });
const base = provider.getSnapshot();
assert.equal(base.source, "dev-fixture");
assert.equal(base.simulated, true);
const baseRepeated = provider.getSnapshot();
assert.equal(baseRepeated.id, base.id, "consecutive reads must preserve confirmed snapshot id");
assert.equal(baseRepeated.capturedAt, base.capturedAt, "consecutive reads must preserve confirmed timestamp");
assert.equal(baseRepeated.source, base.source, "consecutive reads must preserve confirmed source");
assert.equal(baseRepeated.simulated, base.simulated, "consecutive reads must preserve confirmed simulation status");
assert.equal(baseRepeated.freshnessMs, base.freshnessMs, "consecutive reads must preserve confirmed freshness");
assert.deepEqual(baseRepeated.values, base.values, "consecutive reads must preserve confirmed facts");
const attemptedPatch = provider.getSnapshot({ speedKph: 62, gear: "D" });
assert.equal(attemptedPatch.values.speedKph, 0, "getSnapshot must not accept a state patch");
assert.equal(attemptedPatch.values.gear, "P", "getSnapshot must remain a read-only fact query");

const demoProvider = new DevVehicleStateProvider({ speedKph: 0, gear: "P", batteryPercent: 72 });
const demoCapturedAt = new Date(Date.now() - 1_000).toISOString();
const demoAccepted = demoProvider.ingestDemoSensorState({
  source: "demo-sensor-simulator",
  simulated: true,
  capturedAt: demoCapturedAt,
  values: { speedKph: 62, gear: "D", batteryPercent: 60 },
});
assert.equal(demoAccepted.ok, true, "valid demo sensor state must update the Provider");
assert.equal(demoAccepted.snapshot.values.speedKph, 62);
assert.equal(demoAccepted.snapshot.values.gear, "D");
assert.equal(demoProvider.getSnapshot().values.batteryPercent, 60);
assert.equal(demoProvider.getSnapshot().id, demoAccepted.snapshot.id, "Demo ingestion must become the confirmed snapshot");
assert.equal(demoProvider.getSnapshot().capturedAt, demoCapturedAt, "Demo ingestion timestamp must remain stable on read");
const beforeRejectedDemo = demoProvider.getSnapshot();
const invalidDemo = demoProvider.ingestDemoSensorState({
  source: "untrusted-demo-source",
  simulated: true,
  capturedAt: demoCapturedAt,
  values: { speedKph: 0 },
});
assert.deepEqual(invalidDemo, { ok: false, reason: "invalid demo sensor source" });
assert.deepEqual(demoProvider.getSnapshot(), beforeRejectedDemo, "rejected demo sensor state must not update snapshot metadata or facts");
const componentReading = demoProvider.ingestDemoSensorState({
  source: "demo-sensor-simulator",
  simulated: true,
  capturedAt: demoCapturedAt,
  values: { tailgateOpen: true },
});
assert.equal(componentReading.ok, true,
  "a complete Simulator reading may publish a persisted component state through Provider validation");
assert.equal(componentReading.snapshot.values.tailgateOpen, true);
for (const [label, reading, reason] of [
  ["simulated", {
    source: "demo-sensor-simulator", simulated: false, capturedAt: demoCapturedAt, values: { speedKph: 0 },
  }, "invalid demo sensor source"],
  ["timestamp", {
    source: "demo-sensor-simulator", simulated: true, capturedAt: "not-a-date", values: { speedKph: 0 },
  }, "invalid demo sensor capturedAt"],
  ["loose-number", {
    source: "demo-sensor-simulator", simulated: true, capturedAt: demoCapturedAt, values: { speedKph: "0" },
  }, "invalid demo sensor values"],
]) {
  const before = demoProvider.getSnapshot();
  assert.deepEqual(demoProvider.ingestDemoSensorState(reading), { ok: false, reason }, `${label} demo reading must fail closed`);
  assert.deepEqual(demoProvider.getSnapshot(), before, `${label} rejection must preserve snapshot metadata and facts`);
}

const partialProvider = new DevVehicleStateProvider({ speedKph: 0, gear: "P", rearClearance: true });
const partialBefore = partialProvider.getSnapshot();
const partialCapturedAt = new Date().toISOString();
const partialUpdate = partialProvider.ingestDemoSensorState({
  source: "demo-sensor-simulator",
  simulated: true,
  capturedAt: partialCapturedAt,
  values: { speedKph: 62 },
});
assert.equal(partialUpdate.ok, true);
assert.equal(partialUpdate.snapshot.capturedAtByField.speedKph, partialCapturedAt, "updated Safety field must receive the new timestamp");
assert.equal(partialUpdate.snapshot.capturedAtByField.gear, partialBefore.capturedAtByField.gear, "speed-only update must not refresh gear timestamp");
assert.equal(partialUpdate.snapshot.capturedAtByField.rearClearance, partialBefore.capturedAtByField.rearClearance, "speed-only update must not refresh rear-clearance timestamp");

const command = (intent, slots = {}) => ({
  requestId: "state-check", rawText: "", intent, confidence: 1, slots,
  slotProvenance: Object.fromEntries(Object.keys(slots).map((key) => [key, "explicit"])),
  speechAct: "command",
  actionability: { actionable: true, reason: "unit fixture", source: "unit-fixture", intendedIntent: intent },
  source: "unit-fixture",
});
const gateway = new SafetyGateway();
const unknownTailgate = gateway.evaluate(command("body.tailgate.open", { open: true }), { vehicleStateSnapshot: unknown });
assert.equal(unknownTailgate.allowed, false);
const unknownWindow = gateway.evaluate(command("body.window.setPosition", { zone: "front_left", percent: 50 }), { vehicleStateSnapshot: unknown });
assert.equal(unknownWindow.allowed, false);
const unobservedUnknownTailgate = gateway.evaluate(command("body.tailgate.open", { open: true }), { vehicleStateSnapshot: base });
assert.equal(unobservedUnknownTailgate.allowed, false, "unobserved null rear clearance must fail closed");
const observedUnknownBase = createVehicleStateSnapshot({
  ...base,
  capturedAtByField: { ...base.capturedAtByField, rearClearance: base.capturedAt },
});
const knownTailgate = gateway.evaluate(command("body.tailgate.open", { open: true }), { vehicleStateSnapshot: observedUnknownBase });
assert.equal(knownTailgate.action, "require_confirmation");
const knownWindow = gateway.evaluate(command("body.window.setPosition", { zone: "front_left", percent: 50 }), { vehicleStateSnapshot: base });
assert.equal(knownWindow.allowed, true);
const unknownSeat = gateway.evaluate(command("seat.driver.setBackrestAngle", { seat: "driver", angle: 110 }), { vehicleStateSnapshot: unknown });
assert.equal(unknownSeat.allowed, false, "missing speed uses fail-safe rejection");

const apparentlySafeValues = {
  speedKph: 0,
  gear: "P",
  rearClearance: true,
  windowAntiPinchAvailable: true,
  rainDetected: false,
  driverBackrestAngle: 106,
  cabinTemperature: 22,
};
const stale = createVehicleStateSnapshot({
  source: "unit-stale",
  capturedAt: new Date(Date.now() - VEHICLE_STATE_FRESHNESS_POLICY.maxAgeMs - 1_000).toISOString(),
  values: apparentlySafeValues,
});
const staleTailgate = gateway.evaluate(command("body.tailgate.open", { open: true }), { vehicleStateSnapshot: stale });
assert.equal(staleTailgate.allowed, false, "stale speed/gear/rear clearance must not be trusted");
assert.equal(staleTailgate.vehicleStateAudit.freshness.status, "stale");
assert.ok(staleTailgate.vehicleStateAudit.freshness.invalidatedFields.includes("speedKph"));
assert.match(staleTailgate.reason, /已过期/);

const fieldStaleAt = new Date(Date.now() - VEHICLE_STATE_FRESHNESS_POLICY.maxAgeMs - 1_000).toISOString();
const fieldFreshAt = new Date().toISOString();
const mixedFreshness = createVehicleStateSnapshot({
  source: "unit-field-freshness",
  capturedAt: fieldFreshAt,
  values: { speedKph: 0, gear: "P", rearClearance: true },
  capturedAtByField: { speedKph: fieldFreshAt, gear: fieldStaleAt, rearClearance: fieldStaleAt },
});
const mixedTailgate = gateway.evaluate(command("body.tailgate.open", { open: true }), { vehicleStateSnapshot: mixedFreshness });
assert.equal(mixedTailgate.allowed, false, "fresh speed must not make stale gear and rear clearance safe");
assert.ok(mixedTailgate.vehicleStateAudit.freshness.invalidatedFields.includes("gear"));
assert.ok(mixedTailgate.vehicleStateAudit.freshness.invalidatedFields.includes("rearClearance"));

const future = createVehicleStateSnapshot({
  source: "unit-future",
  capturedAt: new Date(Date.now() + VEHICLE_STATE_FRESHNESS_POLICY.futureToleranceMs + 5_000).toISOString(),
  freshnessMs: 0,
  values: apparentlySafeValues,
});
const futureWindow = gateway.evaluate(command("body.window.setPosition", { zone: "front_left", percent: 50 }), { vehicleStateSnapshot: future });
assert.equal(futureWindow.allowed, false, "future anti-pinch snapshot must not be trusted");
assert.equal(futureWindow.vehicleStateAudit.freshness.status, "future-timestamp");
assert.match(futureWindow.reason, /时间戳来自未来/);

const missingTimestamp = createVehicleStateSnapshot({
  source: "unit-missing-timestamp",
  values: apparentlySafeValues,
});
const missingTimestampSeat = gateway.evaluate(command("seat.driver.setBackrestAngle", { seat: "driver", angle: 110 }), { vehicleStateSnapshot: missingTimestamp });
assert.equal(missingTimestampSeat.allowed, false, "snapshot with safety values but no timestamp must fail safe");
assert.equal(missingTimestampSeat.vehicleStateAudit.freshness.status, "missing-timestamp");
assert.match(missingTimestampSeat.reason, /缺少有效 capturedAt/);

const invalidTimestamp = createVehicleStateSnapshot({
  source: "unit-invalid-timestamp",
  capturedAt: "not-a-date",
  values: apparentlySafeValues,
});
const invalidTimestampWindow = gateway.evaluate(command("body.window.setPosition", { zone: "front_left", percent: 50 }), { vehicleStateSnapshot: invalidTimestamp });
assert.equal(invalidTimestampWindow.allowed, false, "invalid timestamp must fail safe");
assert.equal(invalidTimestampWindow.vehicleStateAudit.freshness.status, "missing-timestamp");

console.log("vehicle state snapshot contract verification passed");
