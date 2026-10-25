#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewerRoot = path.join(labRoot, "viewer");
const html = fs.readFileSync(path.join(viewerRoot, "index.html"), "utf8");
const main = fs.readFileSync(path.join(viewerRoot, "main.js"), "utf8");
const styles = fs.readFileSync(path.join(viewerRoot, "styles.css"), "utf8");
const schema = JSON.parse(fs.readFileSync(path.join(labRoot, "schema/es7-components.json"), "utf8"));

for (const target of [
  "../../vendor/three/three.module.js",
  "../../vendor/three/addons/controls/OrbitControls.js",
  "../../vendor/three/addons/loaders/GLTFLoader.js",
  "../dist/nio-es7-component-manifest.json",
  "../dist/nio-es7-animated.glb",
]) {
  assert.ok(main.includes(target), `Viewer source is missing ${target}`);
}
for (const id of [
  "vehicle-canvas", "mechanical-controls", "light-controls", "activity-status", "mechanical-count", "light-count",
  "seat-focus-toggle", "seat-controls", "seat-reset",
]) {
  assert.ok(html.includes(`id="${id}"`), `Viewer HTML is missing #${id}`);
}
assert.ok(main.includes("new THREE.AnimationMixer"), "Viewer does not create an AnimationMixer");
assert.ok(main.includes("emissiveIntensity"), "Viewer does not control semantic emissive intensity");
assert.ok(main.includes("definition.flashHz"), "Viewer does not implement indicator flashing");
assert.equal(schema.mechanicalActions.length, 25, "Stage C viewer expects 25 mechanical clips");
assert.equal(schema.lightControls.length, 5, "Viewer badge expects 5 light controls");
for (const id of ["charge_port_open", "mirror_left_fold", "mirror_right_fold", "wipers_sweep", "suspension_raise"]) {
  assert.ok(main.includes(`${id}:`), `Viewer is missing the Stage B label ${id}`);
}
for (const id of [
  "driver_seat_fore_aft", "driver_seat_height", "driver_seat_backrest_recline", "driver_seat_headrest_height",
]) {
  assert.ok(main.includes(`${id}:`), `Viewer is missing the seat label ${id}`);
  assert.ok(html.includes(`data-seat-clip="${id}"`), `Viewer is missing the seat slider ${id}`);
}
assert.ok(main.includes("Stage C 已载入"), "Viewer load status is not Stage C");
assert.ok(main.includes("seatMaterialRestore"), "Viewer does not restore original materials after seat focus");
assert.ok(main.includes("fogMaterialCache"), "Viewer does not cache fog materials");
assert.ok(main.includes("binding.action.time"), "Viewer does not scrub seat actions by time");
assert.ok(styles.includes(".control-grid button.is-active"), "Viewer has no active control state styling");
assert.ok(styles.includes(".seat-controls"), "Viewer has no seat slider styling");

console.log("PASS ES7 isolated viewer static contract");
console.log("- local Three.js/GLTFLoader/OrbitControls imports: 3");
console.log("- mechanical/light controls: 25/5");
console.log("- four seat sliders and reversible focus mode: present");
