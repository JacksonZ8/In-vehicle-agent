#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGptSoVitsPayload,
  resolveTtsSynthesisProfile,
} from "../../src/voice/tts-profile-loader.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PREBAKED_BRIDGE_DIR = path.join(rootDir, "assets/tts/prebaked");
export const PREBAKED_BRIDGE_CATALOG = path.join(PREBAKED_BRIDGE_DIR, "sandrone-dev-zh-waiting-bridge.catalog.json");
export const PREBAKED_BRIDGE_CATALOG_VERSION = "nio-prebaked-waiting-bridge-catalog@1.0.0";
export const PREBAKED_BRIDGE_CATALOG_ITEMS = [
  ["short-processing", "正在为你处理", "short", 0, 40],
  ["short-organize", "我来整理一下", "short", 0, 40],
  ["short-preparing", "我在准备回答", "short", 0, 40],
  ["medium-wait", "稍等一下", "medium", 41, 100],
  ["medium-structure", "我来帮你梳理", "medium", 41, 100],
  ["medium-compose", "我在组织内容", "medium", 41, 100],
  ["long-think", "我来仔细想想", "long", 101, 180],
  ["long-key-points", "我在整理关键信息", "long", 101, 180],
  ["long-clear-answer", "我来给你一个清晰的回答", "long", 101, 180],
  ["very-long-complete", "我在准备更完整的说明", "very-long", 181, null],
  ["very-long-points", "我来把要点整理清楚", "very-long", 181, null],
  ["very-long-reply", "我正在组织一个更完整的答复", "very-long", 181, null],
].map(([assetId, text, tier, minAnswerChars, maxAnswerChars]) => ({ assetId, text, tier, minAnswerChars, maxAnswerChars }));

function readWavMetadata(bytes) {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Expected a non-empty RIFF/WAVE response from GPT-SoVITS");
  let offset = 12;
  let format;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > bytes.length) throw new Error(`Malformed WAV chunk: ${chunkId}`);
    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new Error("Malformed WAV fmt chunk");
      format = { audioFormat: bytes.readUInt16LE(chunkStart), channels: bytes.readUInt16LE(chunkStart + 2), sampleRateHz: bytes.readUInt32LE(chunkStart + 4), byteRate: bytes.readUInt32LE(chunkStart + 8), bitsPerSample: bytes.readUInt16LE(chunkStart + 14) };
    }
    if (chunkId === "data") dataBytes += chunkSize;
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (!format || !dataBytes || !format.byteRate) throw new Error("WAV must include non-empty fmt and data chunks");
  return { ...format, dataBytes, durationMs: Math.round((dataBytes / format.byteRate) * 1000) };
}

function assetPaths(item, outputDir) {
  const prefix = `sandrone-dev-zh-${item.assetId}`;
  return { outputPath: path.join(outputDir, `${prefix}.wav`), manifestPath: path.join(outputDir, `${prefix}.manifest.json`) };
}

export async function generatePrebakedBridgeAsset({ item, endpoint = process.env.NIO_GPT_SOVITS_ENDPOINT || "http://127.0.0.1:9880/tts", fetchImpl = fetch, outputDir = PREBAKED_BRIDGE_DIR } = {}) {
  if (!item?.assetId || !item.text) throw new Error("A catalog item with assetId and text is required");
  const profile = resolveTtsSynthesisProfile();
  if (profile.profileId !== "sandrone-dev" || profile.licenseBoundary !== "local-non-commercial-testing-only") throw new Error("Prebaked bridge requires the sandrone-dev local non-commercial testing profile");
  const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "audio/wav" }, body: JSON.stringify(buildGptSoVitsPayload(item.text, profile)), signal: AbortSignal.timeout(120_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`GPT-SoVITS returned HTTP ${response.status}: ${bytes.toString("utf8", 0, 300)}`);
  const { outputPath, manifestPath } = assetPaths(item, outputDir);
  const wav = readWavMetadata(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(`${outputPath}.tmp`, bytes);
  await fs.rename(`${outputPath}.tmp`, outputPath);
  const manifest = { assetKind: "prebaked-neutral-waiting-bridge", catalogVersion: PREBAKED_BRIDGE_CATALOG_VERSION, assetId: item.assetId, text: item.text, tier: item.tier, answerCharacterRange: { minInclusive: item.minAnswerChars, maxInclusive: item.maxAnswerChars }, language: profile.textLang, profileId: profile.profileId, synthesisProfileId: profile.synthesis.profileId, provider: profile.provider, licenseBoundary: profile.licenseBoundary, generationMethod: "local GPT-SoVITS /tts using the resolved sandrone-dev profile; generated offline before UI playback", provenance: "prebaked local development-test asset; not real-time progress and not derived from user, vehicle, or NIO production voice data", usageBoundary: "Development testing only. This file must not be presented as a production-authorized voice, a real NIO voice, or a user/vehicle recording.", fileName: path.basename(outputPath), bytes: bytes.length, sha256, wav };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function generatePrebakedBridgeCatalog(options = {}) {
  const assets = [];
  for (const item of PREBAKED_BRIDGE_CATALOG_ITEMS) assets.push(await generatePrebakedBridgeAsset({ ...options, item }));
  const catalog = { catalogVersion: PREBAKED_BRIDGE_CATALOG_VERSION, assetKind: "prebaked-neutral-waiting-bridge-catalog", profileId: assets[0]?.profileId, synthesisProfileId: assets[0]?.synthesisProfileId, licenseBoundary: "local-non-commercial-testing-only", provenance: "prebaked local development-test assets; not real-time progress and not NIO product-authorized voice", usageBoundary: "Development testing only. Not a production-authorized or real NIO voice.", items: assets.map(({ assetId, text, tier, answerCharacterRange, fileName, bytes, sha256, wav, profileId, synthesisProfileId, licenseBoundary, provenance }) => ({ assetId, text, tier, answerCharacterRange, fileName, bytes, sha256, durationMs: wav.durationMs, profileId, synthesisProfileId, licenseBoundary, provenance })) };
  const catalogPath = options.catalogPath || PREBAKED_BRIDGE_CATALOG;
  await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return catalog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generatePrebakedBridgeCatalog().then((catalog) => console.log(JSON.stringify({ catalog: path.basename(PREBAKED_BRIDGE_CATALOG), assets: catalog.items.length }, null, 2))).catch((error) => { console.error(`generate-prebaked-tts-bridge failed: ${error.message}`); process.exitCode = 1; });
}
