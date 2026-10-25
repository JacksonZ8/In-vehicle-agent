import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PREBAKED_BRIDGE_CATALOG, PREBAKED_BRIDGE_CATALOG_ITEMS, PREBAKED_BRIDGE_CATALOG_VERSION, generatePrebakedBridgeCatalog } from "../assets/generate-prebaked-tts-bridge.mjs";

const catalog = JSON.parse(await fs.readFile(PREBAKED_BRIDGE_CATALOG, "utf8"));
assert.equal(catalog.catalogVersion, PREBAKED_BRIDGE_CATALOG_VERSION);
assert.equal(catalog.assetKind, "prebaked-neutral-waiting-bridge-catalog");
assert.equal(catalog.profileId, "sandrone-dev");
assert.equal(catalog.licenseBoundary, "local-non-commercial-testing-only");
assert.equal(catalog.items.length, 12);
assert.deepEqual(catalog.items.map(({ assetId, text, tier, answerCharacterRange }) => ({ assetId, text, tier, minAnswerChars: answerCharacterRange.minInclusive, maxAnswerChars: answerCharacterRange.maxInclusive })), PREBAKED_BRIDGE_CATALOG_ITEMS);
for (const item of catalog.items) {
  const bytes = await fs.readFile(path.join(path.dirname(PREBAKED_BRIDGE_CATALOG), item.fileName));
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(PREBAKED_BRIDGE_CATALOG), item.fileName.replace(/\.wav$/, ".manifest.json")), "utf8"));
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF"); assert.equal(bytes.toString("ascii", 8, 12), "WAVE"); assert.ok(bytes.length > 44);
  assert.equal(item.sha256, createHash("sha256").update(bytes).digest("hex")); assert.equal(manifest.sha256, item.sha256);
  assert.equal(manifest.assetId, item.assetId); assert.equal(manifest.text, item.text); assert.equal(manifest.wav.durationMs, item.durationMs); assert.equal(manifest.profileId, "sandrone-dev"); assert.equal(manifest.licenseBoundary, "local-non-commercial-testing-only"); assert.match(manifest.provenance, /not real-time progress/);
}
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nio-prebaked-tts-catalog-"));
try {
  const fixture = await fs.readFile(path.join(path.dirname(PREBAKED_BRIDGE_CATALOG), catalog.items[0].fileName));
  const repeated = await generatePrebakedBridgeCatalog({ outputDir: tempDir, catalogPath: path.join(tempDir, "catalog.json"), endpoint: "http://mock-gptsovits.invalid/tts", fetchImpl: async () => new Response(fixture, { status: 200, headers: { "content-type": "audio/wav" } }) });
  assert.equal(repeated.items.length, 12); assert.deepEqual(repeated.items.map(({ assetId, text, tier, answerCharacterRange }) => ({ assetId, text, tier, minAnswerChars: answerCharacterRange.minInclusive, maxAnswerChars: answerCharacterRange.maxInclusive })), PREBAKED_BRIDGE_CATALOG_ITEMS);
} finally { await fs.rm(tempDir, { recursive: true, force: true }); }
console.log(JSON.stringify({ catalog: path.basename(PREBAKED_BRIDGE_CATALOG), assets: catalog.items.length, durationMs: catalog.items.map(({ assetId, durationMs }) => ({ assetId, durationMs })), format: "RIFF/WAVE PCM", repeatableWithMock: true }, null, 2));
