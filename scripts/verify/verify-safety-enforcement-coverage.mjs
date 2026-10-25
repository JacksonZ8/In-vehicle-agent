import assert from "node:assert/strict";

import { normalizeSlots, VEHICLE_INTENTS } from "../../src/runtime/agent-schemas.js";
import { getSafetyEnforcementCoverage, SAFETY_ENFORCEMENT_PROFILES, SafetyGateway } from "../../src/safety/safety-gateway.js";
import { createVehicleStateSnapshot } from "../../src/safety/vehicle-state.js";

function command(intent, slots = {}, slotProvenance = {}) {
  return {
    requestId: `verify-safety-enforcement-${intent}`,
    rawText: intent,
    intent,
    confidence: 1,
    slots,
    slotProvenance,
    speechAct: "command",
    actionability: { actionable: true, reason: "unit fixture", source: "unit-fixture", intendedIntent: intent },
    source: "unit-fixture",
  };
}

const coverage = getSafetyEnforcementCoverage();
assert.deepEqual(
  coverage.filter((item) => !item.covered).map((item) => item.intent),
  [],
  "every declared vehicle intent must have a Safety enforcement profile",
);

assert.deepEqual(
  Object.keys(SAFETY_ENFORCEMENT_PROFILES).filter((intent) => !VEHICLE_INTENTS.includes(intent)),
  [],
  "Safety profiles must not drift beyond declared vehicle intents",
);

for (const item of coverage) {
  assert.match(item.profile.profileId, /@1\.0\.0$/);
  assert.equal(item.profile.version, "1.0.0", `${item.intent} must expose an explicit policy version`);
  assert.ok(item.profile.enforcement, `${item.intent} must declare an enforcement type`);
}

const gateway = new SafetyGateway({
  speedKph: 0,
  gear: "P",
  rearClearance: true,
  windowAntiPinchAvailable: true,
  rainDetected: false,
});
assert.equal(
  Object.hasOwn(gateway, "vehicleContext"),
  false,
  "SafetyGateway must not retain constructor vehicle facts",
);

const unknownVehicleIntent = gateway.evaluate(command("body.sunroof.open", { open: true }, { open: "explicit" }));
assert.equal(unknownVehicleIntent.allowed, false);
assert.equal(unknownVehicleIntent.action, "unavailable");
assert.equal(unknownVehicleIntent.reasonCode, "safety-policy-unavailable");
assert.match(unknownVehicleIntent.reason, /没有注册 Safety enforcement profile/);
assert.equal(unknownVehicleIntent.safeSlots.originalIntent, "body.sunroof.open");

const navigation = gateway.evaluate(command(
  "navigation.planRoute",
  { origin: "上海", destination: "西湖" },
  { origin: "explicit", destination: "explicit" },
));
assert.equal(navigation.allowed, true);
assert.match(navigation.reason, /只读外部数据 adapter/);

const energy = gateway.evaluate(command(
  "energy.findSwapStation",
  { destination: "西湖" },
  { destination: "explicit" },
));
assert.equal(energy.allowed, true);
assert.match(energy.reason, /只读外部数据 adapter/);

const climate = gateway.evaluate(command(
  "cabin.climate.setPreset",
  { temperature: 22, requestedTemperature: 22, temperatureOutOfRange: false },
  { temperature: "explicit", requestedTemperature: "explicit", temperatureOutOfRange: "context" },
));
assert.equal(climate.allowed, false);
assert.equal(climate.action, "unavailable");
assert.equal(climate.reasonCode, "safety-state-provider-unavailable");

const capturedAt = new Date().toISOString();
const snapshot = (values) => createVehicleStateSnapshot({
  source: "safety-enforcement-test",
  simulated: true,
  capturedAt,
  freshnessMs: 0,
  values,
  capturedAtByField: Object.fromEntries(Object.keys(values).map((key) => [key, capturedAt])),
});
const snapshotGateway = new SafetyGateway();
const windowSlots = { zone: "front_left", percent: 50 };
const windowProvenance = { zone: "explicit", percent: "explicit" };

const noSnapshotWithRootPoison = snapshotGateway.evaluate(command(
  "body.window.setPosition",
  windowSlots,
  windowProvenance,
), {
  windowAntiPinchAvailable: true,
  rainDetected: false,
});
assert.equal(noSnapshotWithRootPoison.action, "unavailable");
assert.equal(noSnapshotWithRootPoison.reasonCode, "safety-state-provider-unavailable");

const safeSnapshot = snapshot({ windowAntiPinchAvailable: true, rainDetected: false });
const safeDespiteConstructorPoison = new SafetyGateway({
  windowAntiPinchAvailable: false,
  rainDetected: true,
}).evaluate(command("body.window.setPosition", windowSlots, windowProvenance), {
  vehicleStateSnapshot: safeSnapshot,
});
assert.equal(safeDespiteConstructorPoison.action, "allow");

const unsafeSnapshot = snapshot({ windowAntiPinchAvailable: false, rainDetected: false });
const unsafeDespiteConstructorPoison = gateway.evaluate(command(
  "body.window.setPosition",
  windowSlots,
  windowProvenance,
), { vehicleStateSnapshot: unsafeSnapshot });
assert.equal(unsafeDespiteConstructorPoison.action, "reject");
assert.equal(unsafeDespiteConstructorPoison.reasonCode, "safety-known-unsafe");

const climateWithSnapshot = snapshotGateway.evaluate(command(
  "cabin.climate.setPreset",
  { temperature: 22, requestedTemperature: 22, temperatureOutOfRange: false },
  { temperature: "explicit", requestedTemperature: "explicit", temperatureOutOfRange: "context" },
), { vehicleStateSnapshot: safeSnapshot });
assert.equal(climateWithSnapshot.action, "allow");
assert.equal(climateWithSnapshot.reasonCode, "safety-allowed");

const unknownRain = snapshotGateway.evaluate(command(
  "body.window.setPosition",
  windowSlots,
  windowProvenance,
), {
  vehicleStateSnapshot: snapshot({ windowAntiPinchAvailable: true, rainDetected: null }),
});
assert.equal(unknownRain.allowed, false);
assert.equal(unknownRain.action, "unavailable");
assert.equal(unknownRain.reasonCode, "safety-state-field-unknown");
assert.match(unknownRain.reason, /雨量状态不可用/);
assert.equal(unknownRain.policyId, SAFETY_ENFORCEMENT_PROFILES["body.window.setPosition"].profileId);
assert.equal(unknownRain.policyVersion, "1.0.0");
assert.deepEqual(unknownRain.vehicleStateAudit.requiredFields, [
  "windowAntiPinchAvailable",
  "rainDetected",
]);
assert.deepEqual(
  unknownRain.vehicleStateAudit.factRefs.map(({ id, field, snapshotId }) => ({ id, field, snapshotId })),
  [
    {
      id: `${unknownRain.vehicleStateSnapshotId}#windowAntiPinchAvailable`,
      field: "windowAntiPinchAvailable",
      snapshotId: unknownRain.vehicleStateSnapshotId,
    },
    {
      id: `${unknownRain.vehicleStateSnapshotId}#rainDetected`,
      field: "rainDetected",
      snapshotId: unknownRain.vehicleStateSnapshotId,
    },
  ],
);

const seatSlots = normalizeSlots("seat.driver.setBackrestAngle", { seat: "driver", angle: 130 });
assert.equal(seatSlots.requestedAngle, 130);
assert.equal(seatSlots.angleOutOfRange, true);
const seatOutOfRange = snapshotGateway.evaluate(command(
  "seat.driver.setBackrestAngle",
  seatSlots,
  { seat: "explicit", angle: "explicit" },
), {
  vehicleStateSnapshot: snapshot({ speedKph: 0 }),
});
assert.equal(seatOutOfRange.allowed, true);
assert.equal(seatOutOfRange.action, "clamp");
assert.equal(seatOutOfRange.safeSlots.angle, 118);
assert.match(seatOutOfRange.reason, /130°/);

console.log("safety enforcement coverage verification passed");
