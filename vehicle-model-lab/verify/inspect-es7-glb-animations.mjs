#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const glbPath = path.resolve(process.argv[2] || path.join(labRoot, "dist/nio-es7-animated.glb"));
const schemaPath = path.resolve(process.argv[3] || path.join(labRoot, "schema/es7-components.json"));
const manifestPath = path.resolve(process.argv[4] || path.join(labRoot, "dist/nio-es7-component-manifest.json"));
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function readGlbJson(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.equal(buffer.toString("utf8", 0, 4), "glTF", `${filePath} is not a binary GLB file`);
  let offset = 12;
  while (offset < buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (chunkType === 0x4e4f534a) return JSON.parse(buffer.toString("utf8", offset, offset + chunkLength));
    offset += chunkLength;
  }
  throw new Error("GLB JSON chunk was not found");
}

const gltf = readGlbJson(glbPath);
const nodes = gltf.nodes || [];
const animations = gltf.animations || [];
const animationByName = new Map(animations.map((animation) => [animation.name, animation]));
assert.equal(animationByName.size, animations.length, "GLB animation names must be unique");

const componentById = new Map(schema.components.map((component) => [component.id, component]));
for (const action of schema.mechanicalActions) {
  const animation = animationByName.get(action.clip);
  assert.ok(animation, `Missing mechanical animation clip: ${action.clip}`);
  assert.ok(animation.channels?.length, `Animation has no channels: ${action.clip}`);
  const expectedPath = action.type === "translate" ? "translation" : "rotation";
  const expectedTargets = new Set(action.targets.map((target) => componentById.get(target.componentId)?.nodeName));
  const actualTargets = new Set();
  for (const channel of animation.channels) {
    const targetName = nodes[channel.target?.node]?.name;
    assert.ok(expectedTargets.has(targetName), `${action.clip} drives undeclared node ${targetName}`);
    assert.equal(channel.target?.path, expectedPath, `${action.clip} must only drive ${expectedPath}`);
    actualTargets.add(targetName);
  }
  assert.deepEqual([...actualTargets].sort(), [...expectedTargets].sort(), `${action.clip} target set differs from schema`);
  const manifestAction = manifest.animations?.[action.clip];
  assert.ok(manifestAction, `Manifest animation missing: ${action.clip}`);
  assert.equal(manifestAction.type, action.type, `Manifest type differs for ${action.clip}`);
  assert.equal(manifestAction.axis, action.axis, `Manifest axis differs for ${action.clip}`);
  assert.deepEqual(manifestAction.range, action.range, `Manifest range differs for ${action.clip}`);
  assert.equal(manifestAction.durationSeconds, action.durationSeconds, `Manifest duration differs for ${action.clip}`);
  assert.deepEqual(manifestAction.targets.map((target) => target.nodeName).sort(), [...expectedTargets].sort(),
    `Manifest targets differ for ${action.clip}`);
}

assert.equal(animations.length, schema.mechanicalActions.length, "GLB contains undeclared animation clips");
assert.ok(!animationByName.has("stage_a_showcase"), "Review-only stage_a_showcase must not be exported");
assert.ok(!animationByName.has("stage_b_showcase"), "Review-only stage_b_showcase must not be exported");

console.log(`PASS ${path.basename(glbPath)} animation contract`);
console.log(`- mechanical clips: ${animations.length}`);
for (const animation of animations) {
  const targets = [...new Set(animation.channels.map((channel) => nodes[channel.target.node]?.name))];
  console.log(`- ${animation.name}: ${targets.join(", ")}`);
}
