#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTtsStartupWarmupRequest,
  runGptSoVitsStartupWarmup,
} from "../../src/voice/gptsovits-runtime-warmup.mjs";
import * as serviceWarmup from "../services/warm-gptsovits-tts.mjs";

assert.equal(serviceWarmup.buildTtsStartupWarmupRequest, buildTtsStartupWarmupRequest);
assert.equal(serviceWarmup.runGptSoVitsStartupWarmup, runGptSoVitsStartupWarmup);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const restartSource = fs.readFileSync(path.join(root, "scripts", "services", "restart-local-services.sh"), "utf8");

const { profile, payload } = buildTtsStartupWarmupRequest();
assert.equal(profile.profileId, "sandrone-dev");
assert.equal(payload.streaming_mode, 3, "warmup must use explicit GPT-SoVITS mode 3");
assert.equal(payload.ref_audio_path, profile.refAudioPath);
assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(payload)), "_profile"), false, "profile metadata must not be serialized to upstream");

const calls = [];
const success = await runGptSoVitsStartupWarmup({
  now: (() => { let tick = 100; return () => (tick += 25); })(),
  fetchImpl: async (endpoint, options) => {
    calls.push({ endpoint, options });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  },
  endpoint: "http://mock-gptsovits.invalid/tts",
});
assert.equal(success.status, "succeeded");
assert.equal(success.streamingMode, 3);
assert.equal(calls.length, 1);
assert.equal(calls[0].endpoint, "http://mock-gptsovits.invalid/tts");
assert.equal(JSON.parse(calls[0].options.body).streaming_mode, 3);

const failed = await runGptSoVitsStartupWarmup({
  fetchImpl: async () => { throw new Error("mock upstream unavailable"); },
});
assert.equal(failed.status, "failed", "warmup failure must be reported instead of thrown");
assert.match(failed.reason, /mock upstream unavailable/);

assert.match(restartSource, /NIO_GPT_SOVITS_WARMUP_ON_START:-true/);
assert.match(restartSource, /run_gptsovits_startup_warmup/);
assert.match(
  restartSource,
  /if \[ "\$SERVICE_SELECTOR" = "all" \]; then\n\s+echo "\[gptsovits-api\] Startup warmup delegated to the Agent Server runtime coordinator\."\n\s+else\n\s+run_gptsovits_startup_warmup/s,
  "an all-services restart must not synthesize the same discarded warmup twice",
);
assert.match(restartSource, /if \[ "\$SERVICE_SELECTOR" = "tts" \] \|\| \[ "\$SERVICE_SELECTOR" = "all" \]/);
const dispatch = restartSource.slice(restartSource.indexOf("# HC-P0-07: conditionally start only selected service(s)"));
assert.match(dispatch, /if \[ "\$SERVICE_SELECTOR" = "tts" \] \|\| \[ "\$SERVICE_SELECTOR" = "all" \]; then\n  start_gptsovits_api\nfi\n\nif \[ "\$SERVICE_SELECTOR" = "agent" \] \|\| \[ "\$SERVICE_SELECTOR" = "all" \]; then\n  start_local_agent\nfi/);
assert.doesNotMatch(dispatch, /if \[ "\$SERVICE_SELECTOR" = "agent" \][\s\S]{0,200}run_gptsovits_startup_warmup/);
console.log("verify-gptsovits-startup-warmup: passed");
