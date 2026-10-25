#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(fs.readFileSync(path.join(labRoot, "schema/es7-components.json"), "utf8"));
const sourceMap = JSON.parse(fs.readFileSync(path.join(labRoot, "schema/es7-source-map.json"), "utf8"));

assert.equal(schema.contract, "nio-es7-components@1.2.0");
assert.equal(schema.coordinateSystem.unit, "meter");
assert.equal(schema.coordinateSystem.forwardAxis, "+X");
assert.equal(schema.coordinateSystem.leftAxis, "+Y");
assert.equal(schema.coordinateSystem.upAxis, "+Z");
assert.equal(sourceMap.status, "confirmed-by-user-and-blender-selection");

const components = new Map();
const nodeNames = new Set();
for (const component of schema.components) {
  assert.ok(component.id, "Every component needs an id");
  assert.ok(component.nodeName, `${component.id} needs a nodeName`);
  assert.ok(!components.has(component.id), `Duplicate component id: ${component.id}`);
  assert.ok(!nodeNames.has(component.nodeName), `Duplicate nodeName: ${component.nodeName}`);
  components.set(component.id, component);
  nodeNames.add(component.nodeName);
}

for (const component of schema.components) {
  if (component.parent !== null) {
    assert.ok(components.has(component.parent), `${component.id} has missing parent ${component.parent}`);
  }
}

const requiredSourceIds = [
  "front_left_door", "front_right_door", "rear_left_door", "rear_right_door",
  "front_left_window", "front_right_window", "rear_left_window", "rear_right_window",
  "front_left_handle", "front_right_handle", "rear_left_handle", "rear_right_handle",
  "hood", "tailgate", "wheel_front_left", "wheel_front_right", "wheel_rear_left",
  "wheel_rear_right", "front_lights", "rear_lights",
];
for (const id of requiredSourceIds) {
  assert.ok(sourceMap.components[id], `Source map is missing ${id}`);
}

const actionIds = new Set();
const clips = new Set();
const actions = new Map();
for (const action of schema.mechanicalActions) {
  assert.ok(!actionIds.has(action.id), `Duplicate action id: ${action.id}`);
  assert.ok(!clips.has(action.clip), `Duplicate action clip: ${action.clip}`);
  assert.ok(["rotate", "translate"].includes(action.type), `${action.id} has unsupported type`);
  assert.ok(["X", "Y", "Z"].includes(action.axis), `${action.id} has unsupported axis`);
  assert.equal(action.range.length, 2, `${action.id} range must have two values`);
  assert.ok(action.range.every(Number.isFinite), `${action.id} range must be numeric`);
  assert.ok(Number.isFinite(action.durationSeconds) && action.durationSeconds > 0,
    `${action.id} duration must be positive`);
  assert.ok(action.stage === undefined || ["B", "C"].includes(action.stage), `${action.id} has unsupported stage`);
  assert.ok(action.targets.length > 0, `${action.id} needs at least one target`);
  for (const target of action.targets) {
    assert.ok(components.has(target.componentId), `${action.id} targets missing ${target.componentId}`);
    assert.ok(target.direction === 1 || target.direction === -1,
      `${action.id}/${target.componentId} direction must be 1 or -1`);
  }
  actionIds.add(action.id);
  clips.add(action.clip);
  actions.set(action.id, action);
}

const stageBComponents = schema.components.filter((component) => component.requiredStageB);
const stageBActions = schema.mechanicalActions.filter((action) => action.stage === "B");
const stageCComponents = schema.components.filter((component) => component.requiredStageC);
const stageCActions = schema.mechanicalActions.filter((action) => action.stage === "C");
assert.equal(stageBComponents.length, 7, "Stage B must publish seven stable component nodes");
assert.equal(stageBActions.length, 5, "Stage B must publish five mechanical clips");
assert.equal(stageCComponents.length, 8, "Stage C must publish eight stable seat nodes");
assert.equal(stageCActions.length, 4, "Stage C must publish four seat-control clips");
for (const action of stageCActions) {
  assert.equal(action.control, "slider", `${action.id} must use slider control`);
  assert.ok(Number.isFinite(action.defaultValue), `${action.id} needs a numeric defaultValue`);
  assert.ok(action.defaultValue >= Math.min(...action.range) && action.defaultValue <= Math.max(...action.range),
    `${action.id} defaultValue must be inside its range`);
}

const mirrorLeft = actions.get("mirror_left_fold");
const mirrorRight = actions.get("mirror_right_fold");
assert.equal(Math.sign(mirrorLeft.range.find((value) => value !== 0)), 1,
  "Left mirror must fold rearward with positive Z rotation");
assert.equal(Math.sign(mirrorRight.range.find((value) => value !== 0)), -1,
  "Right mirror must fold rearward with negative Z rotation");
assert.equal(mirrorLeft.targets[0].direction, 1, "Left mirror direction metadata must be positive");
assert.equal(mirrorRight.targets[0].direction, -1, "Right mirror direction metadata must be negative");

const hood = actions.get("hood_open");
assert.equal(hood.axis, "Y", "Hood must rotate around its transverse hinge");
assert.equal(Math.sign(hood.range.find((value) => value !== 0)), -1,
  "Hood must open upward with negative Y rotation");
assert.equal(hood.targets[0].direction, -1, "Hood direction metadata must be negative");

const tailgate = actions.get("tailgate_open");
assert.equal(tailgate.axis, "Y", "Tailgate must rotate around its roof hinge");
assert.equal(Math.sign(tailgate.range.find((value) => value !== 0)), 1,
  "Tailgate must open outward/upward with positive Y rotation");
assert.equal(tailgate.targets[0].direction, 1, "Tailgate direction metadata must be positive");

const wipers = actions.get("wipers_sweep");
assert.equal(wipers.axis, "Z", "Wipers must rotate around their local spindle axes");
assert.equal(Math.sign(wipers.range.find((value) => value !== 0)), -1,
  "Wiper sweep must preserve the 1.08 rad negative reference range");
assert.deepEqual(
  Object.fromEntries(wipers.targets.map((target) => [target.componentId, target.direction])),
  { wiper_left: -1, wiper_right: -1 },
  "Original rigid wiper assemblies must both use negative target directions",
);

const suspension = actions.get("suspension_raise");
const suspensionTargets = new Set(suspension.targets.map((target) => target.componentId));
assert.ok(suspensionTargets.has("body_static"), "Suspension must raise the body");
for (const wheelId of [
  "wheel_front_left_steer", "wheel_front_right_steer",
  "wheel_front_left_spin", "wheel_front_right_spin", "wheel_rear_left_spin", "wheel_rear_right_spin",
]) {
  assert.ok(!suspensionTargets.has(wheelId), `Suspension must keep ${wheelId} grounded`);
}

const outwardDoorRotation = {
  front_left_door_open: -1,
  rear_left_door_open: -1,
  front_right_door_open: 1,
  rear_right_door_open: 1,
};
for (const [actionId, expectedSign] of Object.entries(outwardDoorRotation)) {
  const action = actions.get(actionId);
  assert.ok(action, `Missing door action: ${actionId}`);
  assert.equal(action.axis, "Z", `${actionId} must rotate around the vertical hinge`);
  const openDelta = action.range.find((value) => value !== 0);
  assert.equal(Math.sign(openDelta), expectedSign,
    `${actionId} rotates inward; left doors require negative Z and right doors positive Z`);
  assert.equal(action.targets[0].direction, expectedSign,
    `${actionId} direction metadata must match its outward rotation`);
}

const lightIds = new Set();
const materialSemantics = new Set();
for (const control of schema.lightControls) {
  assert.ok(!lightIds.has(control.id), `Duplicate light control: ${control.id}`);
  assert.ok(!materialSemantics.has(control.materialSemantic),
    `Duplicate light material semantic: ${control.materialSemantic}`);
  assert.ok(control.components.length > 0, `${control.id} needs light components`);
  for (const componentId of control.components) {
    assert.equal(components.get(componentId)?.kind, "light", `${control.id} targets non-light ${componentId}`);
  }
  assert.ok(Number.isFinite(control.offEmissive) && Number.isFinite(control.onEmissive));
  if ("flashHz" in control) assert.ok(control.flashHz > 0, `${control.id} flashHz must be positive`);
  lightIds.add(control.id);
  materialSemantics.add(control.materialSemantic);
}

const optionalIds = new Set();
for (const optional of schema.optionalStageB) {
  assert.ok(!components.has(optional.id), `${optional.id} must remain optional before Stage B`);
  assert.ok(!optionalIds.has(optional.id), `Duplicate optional Stage B id: ${optional.id}`);
  optionalIds.add(optional.id);
}

console.log("PASS ES7 component schema");
console.log(`- Stage A components: ${schema.components.filter((component) => component.requiredStageA).length}`);
console.log(`- mechanical actions: ${schema.mechanicalActions.length}`);
console.log(`- light controls: ${schema.lightControls.length}`);
console.log(`- Stage B components/actions: ${stageBComponents.length}/${stageBActions.length}`);
console.log(`- Stage C components/actions: ${stageCComponents.length}/${stageCActions.length}`);
