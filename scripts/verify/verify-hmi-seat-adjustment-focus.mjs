import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applyHmiPresentation,
  isSeatAdjustmentHmiPresentation,
} from "../../src/vehicle/hmi-animation-adapter.js";

const vehicleThree = fs.readFileSync(new URL("../../src/app/vehicle-three.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../src/app/app.js", import.meta.url), "utf8");

for (const nodeName of [
  "driver_seat_track_static",
  "passenger_seat_static",
  "rear_left_seat_static",
  "rear_right_seat_static",
]) {
  assert.match(vehicleThree, new RegExp(`"${nodeName}"`), `missing clear seat node ${nodeName}`);
}
assert.match(vehicleThree, /class SeatAdjustmentFocusController/);
assert.match(vehicleThree, /SEAT_FOCUS_EXIT_DELAY_MS = 1200/);
assert.match(vehicleThree, /SEAT_FOCUS_WATCHDOG_MS = 8000/);
assert.match(vehicleThree, /fogged\.opacity = 0\.12/);
assert.match(vehicleThree, /fogged\.depthWrite = false/);
assert.match(vehicleThree, /seat_focus_clear_rear_/);
assert.match(vehicleThree, /materialRestore = new Map\(\)/);
assert.match(vehicleThree, /fogMaterialCache = new Map\(\)/);
assert.match(vehicleThree, /cameraWasUserAdjusted/);
assert.match(vehicleThree, /beginSeatAdjustmentFocus\(options = \{\}\)/);
assert.match(vehicleThree, /endSeatAdjustmentFocus\(options = \{\}\)/);
assert.doesNotMatch(vehicleThree, /EffectComposer|BokehPass|CSS.*blur/i,
  "seat focus must not add a post-processing or CSS blur pipeline");

assert.match(app, /beginSeatAdjustmentFocus\?\.\(\{ reason: "developer-seat-input" \}\)/);
assert.match(app, /endSeatAdjustmentFocus\?\.\(\{ delayMs: 1200, reason \}\)/);
assert.match(app, /applyHmiPresentation\(pendingPresentation\)/,
  "pending vehicle presentation must reach the focus-only HMI path");

assert.equal(isSeatAdjustmentHmiPresentation({
  phase: "pending",
  visualScenario: "seatControl",
  component: "driverSeatBackrest",
}), true);
assert.equal(isSeatAdjustmentHmiPresentation({
  phase: "pending",
  visualScenario: "componentControl",
  component: "driver_seat_height",
}), true);
assert.equal(isSeatAdjustmentHmiPresentation({
  phase: "pending",
  visualScenario: "trunkControl",
  component: "tailgate",
}), false);

const calls = [];
const vehicleRig = {
  beginSeatAdjustmentFocus(options) {
    calls.push(["begin", options]);
  },
  endSeatAdjustmentFocus(options) {
    calls.push(["end", options]);
  },
  playScenarioAnimation(scenario, options) {
    calls.push(["play", { scenario, options }]);
  },
};

applyHmiPresentation({
  phase: "pending",
  visualScenario: "seatControl",
  component: "driverSeatBackrest",
  noAnimation: true,
}, vehicleRig);
assert.deepEqual(calls.shift(), ["begin", { reason: "pending-seat-execution" }]);

applyHmiPresentation({
  phase: "cancelled",
  visualScenario: "seatControl",
  component: "driverSeatBackrest",
  noAnimation: true,
}, vehicleRig);
assert.deepEqual(calls.shift(), ["end", { delayMs: 0, reason: "seat-cancelled" }]);

applyHmiPresentation({
  phase: "pending",
  visualScenario: "trunkControl",
  component: "tailgate",
  noAnimation: true,
}, vehicleRig);
assert.deepEqual(calls.shift(), ["end", { delayMs: 0, reason: "non-seat-presentation" }]);

applyHmiPresentation({
  phase: "confirmed",
  visualScenario: "seatControl",
  component: "driverSeatBackrest",
  animationState: { driverBackrestAngle: 110 },
  noAnimation: false,
}, vehicleRig);
assert.equal(calls.shift()?.[0], "play");
assert.equal(calls.length, 0);

console.log("HMI seat adjustment focus verification passed");
