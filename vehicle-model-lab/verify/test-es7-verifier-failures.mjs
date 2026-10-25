#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifyRoot = path.join(labRoot, "verify");
const sourceGlb = path.join(labRoot, "dist/nio-es7-animated.glb");
const sourceManifest = path.join(labRoot, "dist/nio-es7-component-manifest.json");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nio-es7-verifier-test-"));

function readGlb(filePath) {
  const buffer = fs.readFileSync(filePath);
  const chunks = [];
  let offset = 12;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 8 + length;
  }
  const jsonChunk = chunks.find((chunk) => chunk.type === 0x4e4f534a);
  return { json: JSON.parse(jsonChunk.data.toString("utf8")), chunks };
}

function writeModifiedGlb(filePath, mutate) {
  const { json, chunks } = readGlb(sourceGlb);
  mutate(json);
  let jsonData = Buffer.from(JSON.stringify(json), "utf8");
  const padding = (4 - (jsonData.length % 4)) % 4;
  jsonData = Buffer.concat([jsonData, Buffer.alloc(padding, 0x20)]);
  const outputChunks = chunks.map((chunk) => chunk.type === 0x4e4f534a ? { ...chunk, data: jsonData } : chunk);
  const totalLength = 12 + outputChunks.reduce((total, chunk) => total + 8 + chunk.data.length, 0);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const buffers = [header];
  for (const chunk of outputChunks) {
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.writeUInt32LE(chunk.data.length, 0);
    chunkHeader.writeUInt32LE(chunk.type, 4);
    buffers.push(chunkHeader, chunk.data);
  }
  fs.writeFileSync(filePath, Buffer.concat(buffers));
}

function expectFailure(script, args, expectedText) {
  const result = spawnSync(process.execPath, [path.join(verifyRoot, script), ...args], { encoding: "utf8" });
  assert.notEqual(result.status, 0, `${script} unexpectedly passed a broken fixture`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ok(output.includes(expectedText), `${script} did not report ${JSON.stringify(expectedText)}\n${output}`);
}

try {
  const missingComponentGlb = path.join(tempRoot, "missing-component.glb");
  writeModifiedGlb(missingComponentGlb, (gltf) => {
    const node = gltf.nodes.find((item) => item.name === "hood_pivot");
    node.name = "hood_pivot_missing";
  });
  expectFailure("inspect-es7-glb-components.mjs", [missingComponentGlb], "Missing required component node: hood_pivot");

  const missingAnimationGlb = path.join(tempRoot, "missing-animation.glb");
  writeModifiedGlb(missingAnimationGlb, (gltf) => {
    gltf.animations = gltf.animations.filter((animation) => animation.name !== "hood_open");
  });
  expectFailure("inspect-es7-glb-animations.mjs", [missingAnimationGlb], "Missing mechanical animation clip: hood_open");

  const missingAttribution = path.join(tempRoot, "missing-attribution.json");
  const manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"));
  delete manifest.provenance.author;
  fs.writeFileSync(missingAttribution, JSON.stringify(manifest));
  expectFailure("verify-es7-attribution.mjs", [missingAttribution], "Manifest provenance differs for author");

  console.log("PASS ES7 verifier negative fixtures");
  console.log("- missing component produces a focused error");
  console.log("- missing animation produces a focused error");
  console.log("- missing attribution produces a focused error");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
