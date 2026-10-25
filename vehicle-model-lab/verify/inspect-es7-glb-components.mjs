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
assert.equal(manifest.contract, "nio-es7-component-manifest@1.2.0");
assert.equal(manifest.assetVersion, "stage-c-seat-0.3.0");
assert.equal(manifest.schemaContract, schema.contract);

function readGlbJson(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert.equal(buffer.toString("utf8", 0, 4), "glTF", `${filePath} is not a binary GLB file`);
  assert.equal(buffer.readUInt32LE(4), 2, "GLB version must be 2");
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

function primitiveTriangles(gltf, primitive) {
  assert.equal(primitive.mode ?? 4, 4, "Only triangle primitives are supported by this audit");
  const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
  const count = gltf.accessors?.[accessorIndex]?.count;
  assert.ok(Number.isInteger(count), "Primitive index/POSITION accessor count is missing");
  return count / 3;
}

const gltf = readGlbJson(glbPath);
const nodes = gltf.nodes || [];
const nodeIndicesByName = new Map();
for (const [index, node] of nodes.entries()) {
  assert.ok(node.name, `GLB node ${index} has no stable name`);
  assert.ok(!nodeIndicesByName.has(node.name), `Duplicate GLB node name: ${node.name}`);
  nodeIndicesByName.set(node.name, index);
}
const parentByNode = new Map();
for (const [parentIndex, node] of nodes.entries()) {
  for (const childIndex of node.children || []) {
    assert.ok(!parentByNode.has(childIndex), `Node ${nodes[childIndex]?.name} has multiple parents`);
    parentByNode.set(childIndex, parentIndex);
  }
}

for (const component of schema.components) {
  const nodeIndex = nodeIndicesByName.get(component.nodeName);
  assert.notEqual(nodeIndex, undefined, `Missing required component node: ${component.nodeName}`);
  assert.equal(manifest.components?.[component.id]?.nodeName, component.nodeName,
    `Manifest node binding differs for ${component.id}`);
  assert.equal(manifest.components?.[component.id]?.parent, component.parent,
    `Manifest parent binding differs for ${component.id}`);
  assert.equal(manifest.components?.[component.id]?.requiredStageA, Boolean(component.requiredStageA),
    `Manifest Stage-A flag differs for ${component.id}`);
  assert.equal(manifest.components?.[component.id]?.requiredStageB, Boolean(component.requiredStageB),
    `Manifest Stage-B flag differs for ${component.id}`);
  assert.equal(manifest.components?.[component.id]?.requiredStageC, Boolean(component.requiredStageC),
    `Manifest Stage-C flag differs for ${component.id}`);
  if (component.parent) {
    const parent = schema.components.find((item) => item.id === component.parent);
    assert.ok(parent, `Schema parent missing for ${component.id}: ${component.parent}`);
    const parentIndex = nodeIndicesByName.get(parent.nodeName);
    assert.equal(parentByNode.get(nodeIndex), parentIndex,
      `${component.nodeName} must be a direct child of ${parent.nodeName}`);
  }
}

const materialNames = new Set((gltf.materials || []).map((material) => material.name));
for (const control of schema.lightControls) {
  assert.ok(materialNames.has(control.materialSemantic),
    `Missing semantic light material: ${control.materialSemantic}`);
  const manifestLight = manifest.lights?.[control.id];
  assert.ok(manifestLight, `Manifest light control missing: ${control.id}`);
  assert.equal(manifestLight.materialSemantic, control.materialSemantic,
    `Manifest material semantic differs for ${control.id}`);
  assert.equal(manifestLight.offEmissive, control.offEmissive,
    `Manifest off emission differs for ${control.id}`);
  assert.equal(manifestLight.onEmissive, control.onEmissive,
    `Manifest on emission differs for ${control.id}`);
  for (const componentId of control.components) {
    const component = schema.components.find((item) => item.id === componentId);
    assert.ok(nodeIndicesByName.has(component.nodeName),
      `Light control ${control.id} points to missing node ${component.nodeName}`);
  }
}

for (const forbidden of ["ES7_CC_BY_REFERENCE_ROOT", "ES7_STAGE_", "ES7_REVIEW_", "es7_preview_"]) {
  assert.ok(!nodes.some((node) => node.name === forbidden || node.name.startsWith(forbidden)),
    `Forbidden source/preview node was exported: ${forbidden}`);
}
assert.ok(!nodes.some((node) => node.name.includes("INCH")),
  "Unused 20/21/22-inch wheel variants must not be exported");

const vehicleRoot = nodes[nodeIndicesByName.get("vehicle_root")];
assert.deepEqual(vehicleRoot.translation || [0, 0, 0], [0, 0, 0], "vehicle_root translation must be identity");
assert.deepEqual(vehicleRoot.scale || [1, 1, 1], [1, 1, 1], "vehicle_root scale must be identity");
assert.deepEqual(vehicleRoot.rotation || [0, 0, 0, 1], [0, 0, 0, 1], "vehicle_root rotation must be identity");

const triangles = (gltf.meshes || []).reduce((total, mesh) =>
  total + (mesh.primitives || []).reduce((meshTotal, primitive) => meshTotal + primitiveTriangles(gltf, primitive), 0), 0);
assert.equal(triangles, manifest.statistics?.triangles, "Manifest triangle count differs from GLB");
assert.equal((gltf.materials || []).length, manifest.statistics?.materials, "Manifest material count differs from GLB");
assert.equal((gltf.images || []).length, manifest.statistics?.textures, "Manifest texture count differs from GLB");
assert.equal(fs.statSync(glbPath).size, manifest.statistics?.glbFileSizeBytes, "Manifest GLB byte size differs");
assert.ok(manifest.exportBounds?.sizeMeters?.[0] > 4.9, "Export length is implausible");
assert.ok(manifest.exportBounds?.sizeMeters?.[1] > 1.9, "Export width is implausible");
assert.ok(manifest.exportBounds?.sizeMeters?.[2] > 1.7, "Export height is implausible");

console.log(`PASS ${path.basename(glbPath)} component contract`);
console.log(`- stable component nodes: ${schema.components.length}`);
console.log(`- GLB nodes/meshes: ${nodes.length}/${(gltf.meshes || []).length}`);
console.log(`- triangles/materials/textures: ${triangles}/${(gltf.materials || []).length}/${(gltf.images || []).length}`);
console.log(`- semantic light materials/controls: ${schema.lightControls.length}/${schema.lightControls.length}`);
console.log(`- GLB bytes: ${fs.statSync(glbPath).size}`);
