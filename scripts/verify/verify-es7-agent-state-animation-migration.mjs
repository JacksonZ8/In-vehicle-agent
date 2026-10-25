#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import * as THREE from "../../vendor/three/three.module.js";
import { ES7AnimationRuntime } from "../../src/app/es7-animation-runtime.js";
import { SafetyGateway } from "../../src/safety/safety-gateway.js";
import { createVehicleStateSnapshot } from "../../src/safety/vehicle-state.js";
import {
  evaluateSemanticFastPath,
  parseCommandWithSemanticPolicy,
} from "../lib/semantic-policy.js";
import {
  ES7_ACTION_CATALOG,
  ES7_GENERIC_ACTION_IDS,
  requestedEs7ComponentActionState,
} from "../../src/vehicle/es7-action-catalog.js";
import { mapVehicleExecutionToHmi } from "../../src/vehicle/hmi-animation-adapter.js";
import { createLeanRuntimeVehicleControlHarness } from "../lib/lean-runtime-test-harness.mjs";

const manifestPath = new URL("../../assets/models/nio-es7/nio-es7-component-manifest.json", import.meta.url);
const glbPath = new URL("../../assets/models/nio-es7/nio-es7-animated.glb", import.meta.url);
const labGlbPath = new URL("../../vehicle-model-lab/dist/nio-es7-animated.glb", import.meta.url);
const labManifestPath = new URL("../../vehicle-model-lab/dist/nio-es7-component-manifest.json", import.meta.url);
const vehicleThreePath = new URL("../../src/app/vehicle-three.js", import.meta.url);
const appPath = new URL("../../src/app/app.js", import.meta.url);
const stylesPath = new URL("../../src/app/styles.css", import.meta.url);
const indexPath = new URL("../../index.html", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const actionIds = Object.keys(ES7_ACTION_CATALOG);
const vehicleThreeSource = fs.readFileSync(vehicleThreePath, "utf8");
const appSource = fs.readFileSync(appPath, "utf8");
const stylesSource = fs.readFileSync(stylesPath, "utf8");
const indexSource = fs.readFileSync(indexPath, "utf8");

for (const removedToken of [
  "setupStudioFloor",
  "cabin_highlight_volume",
  "tailgate_highlight_volume",
  "updateOriginalPartMaterials",
  "original_mesh_highlight",
  "material_pulse",
]) {
  assert.equal(vehicleThreeSource.includes(removedToken), false, `legacy vehicle effect remains: ${removedToken}`);
}
assert.equal(appSource.includes("originalHighlightMeshes"), false, "legacy highlight capability remains in the HMI");
assert.equal(stylesSource.includes(".vehicle-stage::before"), false, "legacy stage scanline remains");
assert.equal(stylesSource.includes("rgba(255, 255, 255, 0.025) 1px"), false, "legacy vertical stage grid remains");
assert.equal(stylesSource.includes("rgba(255, 255, 255, 0.02) 1px"), false, "legacy horizontal stage grid remains");
assert.equal(stylesSource.includes("radial-gradient(ellipse at 50% 59%, rgba(255, 255, 255"), false,
  "legacy white ground halo remains");
assert.match(vehicleThreeSource, /function setupVehicleDisplayStage\(\)/,
  "main ES7 view must provide the approved dark display stage");
assert.match(vehicleThreeSource, /stage\.name = "vehicle_display_stage"/);
assert.match(vehicleThreeSource, /stage\.userData\.variant = "dark-static-pedestal"/);
assert.match(vehicleThreeSource, /alignDisplayStageToVehicle\(model\)/,
  "display stage must align to the normalized ES7 bounds");
assert.doesNotMatch(vehicleThreeSource, /vehicle_display_stage[\s\S]{0,900}color:\s*0xffffff/,
  "restored display stage must not reintroduce the removed white floor");

for (const removedToken of [
  "componentCommands",
  "activeComponent",
  "explodeButton",
  "renderComponentButtons",
  "focusVehicleComponent",
]) {
  assert.equal(appSource.includes(removedToken), false, `manual HMI presentation control remains: ${removedToken}`);
}
for (const removedToken of [
  "battery_pack",
  "roof_sensor_module",
  "setExploded",
  "engineering_battery_sensor_split",
  "createControlRig",
  "energyPulse",
]) {
  assert.equal(vehicleThreeSource.includes(removedToken), false, `engineering vehicle proxy remains: ${removedToken}`);
}
for (const removedToken of [
  "vehicle-controls",
  "component-exploder",
  "explodeButton",
]) {
  assert.equal(indexSource.includes(removedToken), false, `manual vehicle control DOM remains: ${removedToken}`);
}
for (const removedToken of [
  ".vehicle-controls",
  ".component-exploder",
  "data-exploded",
]) {
  assert.equal(stylesSource.includes(removedToken), false, `manual vehicle control style remains: ${removedToken}`);
}

for (const retainedToken of [
  "scenario_safety_shield",
  "scenario_offline_edge_glow",
  "HemisphereLight",
  "DirectionalLight",
  "PointLight",
  "focusComponent",
]) {
  assert.equal(vehicleThreeSource.includes(retainedToken), true, `required vehicle behavior missing: ${retainedToken}`);
}
assert.match(vehicleThreeSource, /this\.state\.component = component;\s*focusComponent\(component\);/,
  "HMI scenario animation must retain internal automatic camera focus");

assert.equal(actionIds.length, 25);
assert.equal(ES7_GENERIC_ACTION_IDS.length, 19);
assert.deepEqual(Object.keys(manifest.animations).sort(), [...actionIds].sort());
assert.deepEqual(requestedEs7ComponentActionState("mirrors_fold_both", 1), {
  mirror_left_fold: 1,
  mirror_right_fold: 1,
});
assert.equal(requestedEs7ComponentActionState("tailgate_open", 1), null,
  "dedicated vehicle facts must not be writable through the generic component command");
assert.equal(requestedEs7ComponentActionState("front_wheels_steer", 31), null);

const glbHash = sha256(glbPath);
assert.equal(glbHash, "b05515162732d80f8c70c9c76834bbe8ca8a909ffb2d97a0e8f00b473851a4dd");
assert.equal(glbHash, sha256(labGlbPath));
const manifestHash = sha256(manifestPath);
assert.equal(manifestHash, "8c6c77d13a932c57ebbee4a28ad4e8a6b30b093abe3a4059cd67b6bb74bea7e2");
assert.equal(manifestHash, sha256(labManifestPath));

for (const [text, actionId, value] of [
  ["打开左前门", "front_left_door_open", 1],
  ["关闭右后门", "rear_right_door_open", 0],
  ["弹出主驾门把手", "front_left_handle_deploy", 1],
  ["打开前舱盖", "hood_open", 1],
  ["打开充电口", "charge_port_open", 1],
  ["折叠两个后视镜", "mirrors_fold_both", 1],
  ["启动雨刷", "wipers_sweep", 1],
  ["车身升高4厘米", "suspension_raise", 4],
  ["前轮向左转20度", "front_wheels_steer", -20],
  ["让车轮滚动", "wheels_roll", 1],
  ["主驾座椅向后移动6厘米", "driver_seat_fore_aft", -6],
  ["主驾座椅升高5厘米", "driver_seat_height", 5],
  ["主驾头枕升高3厘米", "driver_seat_headrest_height", 3],
]) {
  const parsed = parseCommandWithSemanticPolicy(text, { requestId: `parse:${actionId}` });
  assert.equal(parsed.intent, "vehicle.component.setState", text);
  assert.deepEqual(parsed.slots, { actionId, value }, text);
  assert.deepEqual(parsed.slotProvenance, { actionId: "explicit", value: "explicit" }, text);
  assert.equal(evaluateSemanticFastPath(parsed, text).decision, "vehicle-command", text);
}

for (const text of ["打开车门", "折叠后视镜"]) {
  const parsed = parseCommandWithSemanticPolicy(text, { requestId: `clarify:${text}` });
  assert.equal(parsed.intent, "conversation.general", text);
  assert.equal(parsed.slots.needsClarification, true, text);
}

const nowMs = Date.parse("2026-08-24T10:00:00.000Z");
const parkedSnapshot = createVehicleStateSnapshot({
  id: "snapshot:parked",
  source: "demo-sensor-simulator",
  simulated: true,
  capturedAt: new Date(nowMs).toISOString(),
  values: { speedKph: 0, gear: "P" },
});
const hoodCommand = parseCommandWithSemanticPolicy("打开前舱盖", { requestId: "safety:hood" });
const parkedDecision = new SafetyGateway({}, { now: () => nowMs }).evaluate(hoodCommand, {
  vehicleStateSnapshot: parkedSnapshot,
});
assert.equal(parkedDecision.action, "allow");

const movingSnapshot = createVehicleStateSnapshot({
  id: "snapshot:moving",
  source: "demo-sensor-simulator",
  simulated: true,
  capturedAt: new Date(nowMs).toISOString(),
  values: { speedKph: 10, gear: "D" },
});
assert.equal(new SafetyGateway({}, { now: () => nowMs }).evaluate(hoodCommand, {
  vehicleStateSnapshot: movingSnapshot,
}).action, "reject");
const outOfRange = parseCommandWithSemanticPolicy("前轮向左转40度", { requestId: "safety:steer-range" });
assert.equal(new SafetyGateway({}, { now: () => nowMs }).evaluate(outOfRange, {
  vehicleStateSnapshot: parkedSnapshot,
}).action, "reject");

const successHarness = createLeanRuntimeVehicleControlHarness();
const success = await successHarness.runtime.run("打开前舱盖", {
  requestId: "run:es7:hood",
  vehicleSensorMode: "success",
});
assert.equal(success.parsedCommand.intent, "vehicle.component.setState");
assert.equal(success.toolCall.tool, "vehicle.component.setState");
assert.deepEqual(success.toolCall.args, { actionId: "hood_open", value: 1 });
assert.equal(success.toolResult.executionState, "observed-succeeded");
assert.deepEqual(success.vehicleStateSnapshot.values.componentActionStateById, { hood_open: 1 });

const secondSuccess = await successHarness.runtime.run("折叠左后视镜", {
  requestId: "run:es7:mirror-after-hood",
  vehicleSensorMode: "success",
});
assert.equal(secondSuccess.toolResult.executionState, "observed-succeeded");
assert.deepEqual(secondSuccess.vehicleStateSnapshot.values.componentActionStateById, {
  hood_open: 1,
  mirror_left_fold: 1,
}, "confirmed component state must preserve earlier actions while accepting the new target");
const secondPresentation = mapVehicleExecutionToHmi({
  toolResult: secondSuccess.toolResult,
  vehicleStateSnapshot: secondSuccess.vehicleStateSnapshot,
  commitmentState: "provider-terminal",
  cancellation: { requested: false, physicalUndoClaimed: false },
});
assert.equal(secondPresentation.phase, "confirmed");
assert.deepEqual(secondPresentation.animationState.componentActionStateById, {
  mirror_left_fold: 1,
});

const successPresentation = mapVehicleExecutionToHmi({
  toolResult: success.toolResult,
  vehicleStateSnapshot: success.vehicleStateSnapshot,
  commitmentState: "provider-terminal",
  cancellation: { requested: false, physicalUndoClaimed: false },
});
assert.equal(successPresentation.phase, "confirmed");
assert.equal(successPresentation.noAnimation, false);
assert.deepEqual(successPresentation.animationState, {
  componentActionStateById: { hood_open: 1 },
});

const conflictHarness = createLeanRuntimeVehicleControlHarness();
const conflict = await conflictHarness.runtime.run("打开前舱盖", {
  requestId: "run:es7:hood-conflict",
  vehicleSensorMode: "conflict",
});
assert.equal(conflict.toolResult.executionState, "failed");
assert.equal(conflict.toolResult.executionError.code, "sensor-observation-conflict");
const conflictPresentation = mapVehicleExecutionToHmi({
  toolResult: conflict.toolResult,
  vehicleStateSnapshot: conflict.vehicleStateSnapshot,
  commitmentState: "provider-terminal",
  cancellation: { requested: false, physicalUndoClaimed: false },
});
assert.equal(conflictPresentation.phase, "observed-conflict");
assert.equal(conflictPresentation.noAnimation, true);

const clips = actionIds.map((name) => new THREE.AnimationClip(name, 1, []));
const animationRuntime = new ES7AnimationRuntime({
  model: new THREE.Group(),
  clips,
  manifest,
});
assert.equal(animationRuntime.getState().ready, true);
assert.equal(animationRuntime.getState().clipCount, 25);
assert.equal(animationRuntime.getState().progressByActionId.driver_seat_backrest_recline, 0.8);
assert.equal(animationRuntime.setConfirmedSnapshot({
  id: "confirmed:one",
  values: {
    windowPositionPercentByZone: { front_right: 50 },
    tailgateOpen: true,
    driverBackrestAngle: 110,
    componentActionStateById: {
      hood_open: 1,
      front_wheels_steer: -15,
      driver_seat_height: 4,
    },
  },
}, { immediate: true }), true);
const progress = animationRuntime.getState().progressByActionId;
assert.equal(progress.front_right_window_open, 0.5);
assert.equal(progress.tailgate_open, 1);
assert.equal(progress.driver_seat_backrest_recline, 0.64);
assert.equal(progress.hood_open, 1);
assert.equal(progress.front_wheels_steer, 0.25);
assert.equal(progress.driver_seat_height, 0.5);
assert.equal(animationRuntime.setConfirmedSnapshot({
  id: "confirmed:one",
  values: { componentActionStateById: { hood_open: 0 } },
}), false, "same confirmed snapshot must be idempotent");
animationRuntime.dispose();

console.log(JSON.stringify({
  ok: true,
  actionCount: actionIds.length,
  genericActionCount: ES7_GENERIC_ACTION_IDS.length,
  parserCases: 13,
  agentStateMachineSuccess: true,
  conflictNoAnimation: true,
  glbSha256: glbHash,
  manifestSha256: manifestHash,
}, null, 2));

function sha256(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}
