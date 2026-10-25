import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeSlots, SAFETY_BASELINE } from "../../src/runtime/agent-schemas.js";
import { SafetyGateway } from "../../src/safety/safety-gateway.js";
import { createVehicleStateSnapshot } from "../../src/safety/vehicle-state.js";

const source = await readFile(new URL("../../src/runtime/agent-schemas.js", import.meta.url), "utf8");
const safetyGatewaySource = await readFile(new URL("../../src/safety/safety-gateway.js", import.meta.url), "utf8");
const climateBranch = source.match(/if \(intent === "cabin\.climate\.setPreset"\) \{[\s\S]*?\n  \}/)?.[0] || "";
const seatBranch = source.match(/if \(intent === "seat\.driver\.setBackrestAngle"\) \{[\s\S]*?\n  \}/)?.[0] || "";
const windowBranch = safetyGatewaySource.match(/if \(parsedCommand\.intent === "body\.window\.setPosition"[\s\S]*?\) \{[\s\S]*?\n    \}/)?.[0] || "";

assert.match(climateBranch, /SAFETY_BASELINE\.climate\.minTemperature/, "climate min temperature must come from SAFETY_BASELINE");
assert.match(climateBranch, /SAFETY_BASELINE\.climate\.maxTemperature/, "climate max temperature must come from SAFETY_BASELINE");
assert.doesNotMatch(climateBranch, /(?:<|,)\s*18\b|(?:>|,)\s*28\b/, "climate branch must not hard-code 18/28");
assert.match(seatBranch, /SAFETY_BASELINE\.seat\.minAngle/, "seat min angle must come from SAFETY_BASELINE");
assert.match(seatBranch, /SAFETY_BASELINE\.seat\.maxAngleStationary/, "seat max angle must come from SAFETY_BASELINE");
assert.match(windowBranch, /SAFETY_BASELINE\.window\.rainCloseMaxPercent/, "rain window clamp must come from SAFETY_BASELINE");
assert.doesNotMatch(windowBranch, /Math\.min\([^)]*,\s*30\)/, "window branch must not hard-code rainy max percent");

const cold = normalizeSlots("cabin.climate.setPreset", { temperature: 0 });
assert.equal(cold.requestedTemperature, 0);
assert.equal(cold.temperatureOutOfRange, true);
assert.equal(cold.temperature, SAFETY_BASELINE.climate.minTemperature);

const hot = normalizeSlots("cabin.climate.setPreset", { temperature: 40 });
assert.equal(hot.requestedTemperature, 40);
assert.equal(hot.temperatureOutOfRange, true);
assert.equal(hot.temperature, SAFETY_BASELINE.climate.maxTemperature);

const normal = normalizeSlots("cabin.climate.setPreset", { temperature: 22 });
assert.equal(normal.temperatureOutOfRange, false);
assert.equal(normal.temperature, 22);

// Check the real handler at the rain boundary for single and compound targets.
const capturedAt = "2026-10-03T00:00:00.000Z";
const rainMaximum = SAFETY_BASELINE.window.rainCloseMaxPercent;
let windowBehaviorChecks = 0;
for (const rainDetected of [false, true]) {
  const snapshot = createVehicleStateSnapshot({
    id: `rain-baseline:${rainDetected}`, source: "unit-fixture", simulated: true,
    capturedAt, freshnessMs: 0,
    values: { windowAntiPinchAvailable: true, rainDetected },
  });
  const gateway = new SafetyGateway({}, { now: () => Date.parse(capturedAt) });
  for (const percent of [rainMaximum - 1, rainMaximum, rainMaximum + 1, 100]) {
    for (const intent of ["body.window.setPosition", "cabin.comfort.applySettings"]) {
      const compound = intent === "cabin.comfort.applySettings";
      const slots = compound
        ? { windowTargets: [{ zone: "front_left", percent }, { zone: "rear_right", percent }] }
        : { zone: "front_left", percent };
      const command = {
        requestId: `rain:${rainDetected}:${intent}:${percent}`, intent, slots,
        slotProvenance: compound ? { windowTargets: "explicit" } : { zone: "explicit", percent: "explicit" },
        speechAct: "command", actionability: { actionable: true, source: "unit-fixture" },
      };
      const original = structuredClone(command);
      const result = gateway.evaluate(command, { vehicleStateSnapshot: snapshot });
      const expected = rainDetected ? Math.min(percent, rainMaximum) : percent;
      assert.equal(result.allowed, true);
      assert.equal(result.safeIntent, intent);
      assert.equal(result.action, expected === percent ? "allow" : "clamp");
      assert.equal(result.safeSlots.antiPinch, true);
      if (compound) assert.deepEqual(result.safeSlots.windowTargets,
        slots.windowTargets.map(target => ({ ...target, percent: expected })));
      else {
        assert.equal(result.safeSlots.zone, slots.zone);
        assert.equal(result.safeSlots.percent, expected);
      }
      assert.deepEqual(command, original, "Safety must not mutate the parsed command");
      windowBehaviorChecks++;
    }
  }
}
assert.equal(windowBehaviorChecks, 16);

// A compound cabin setting with valid window targets must still enforce its climate limits.
{
  const snapshot = createVehicleStateSnapshot({
    id: "compound-climate", source: "unit-fixture", simulated: true,
    capturedAt, freshnessMs: 0,
    values: { windowAntiPinchAvailable: true, rainDetected: false },
  });
  const gateway = new SafetyGateway({}, { now: () => Date.parse(capturedAt) });
  const windowTargets = [{ zone: "front_left", percent: 30 }];
  for (const [label, climateSlots] of [
    ["temperature", normalizeSlots("cabin.comfort.applySettings", { temperature: SAFETY_BASELINE.climate.maxTemperature + 5 })],
    ["fan", normalizeSlots("cabin.comfort.applySettings", { fanLevel: SAFETY_BASELINE.climate.maxFanLevel + 3 })],
    ["power", { climatePower: false, fanLevel: 3 }],
  ]) {
    const result = gateway.evaluate({
      requestId: `compound-climate:${label}`,
      intent: "cabin.comfort.applySettings",
      slots: { ...climateSlots, windowTargets },
      slotProvenance: Object.fromEntries([...Object.keys(climateSlots), "windowTargets"].map((key) => [key, "explicit"])),
      speechAct: "command",
      actionability: { actionable: true, source: "unit-fixture" },
    }, { vehicleStateSnapshot: snapshot });
    assert.equal(result.allowed, false, `${label}: window targets must not bypass cabin climate checks`);
    assert.equal(result.action, "reject", `${label}: invalid climate in a compound setting is rejected`);
  }
}

console.log(JSON.stringify({
  status: "ok",
  windowBehaviorChecks,
  baseline: SAFETY_BASELINE.version,
  climate: SAFETY_BASELINE.climate,
  seat: SAFETY_BASELINE.seat,
}, null, 2));
