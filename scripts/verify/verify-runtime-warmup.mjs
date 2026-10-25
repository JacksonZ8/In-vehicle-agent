#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createRuntimeWarmupCoordinator,
  handleRuntimeWarmupBody,
} from "../../src/server/runtime-warmup.mjs";

let manualCalls = 0;
let ttsCalls = 0;
let releaseManual;
let releaseTts;
const manualPending = new Promise((resolve) => { releaseManual = resolve; });
const ttsPending = new Promise((resolve) => { releaseTts = resolve; });
const coordinator = createRuntimeWarmupCoordinator({
  warmManualRag: async () => {
    manualCalls += 1;
    await manualPending;
    return { status: "ready", durationMs: 11, embeddingModel: "bge-m3", privatePath: "/private/manual" };
  },
  warmGptSoVits: async () => {
    ttsCalls += 1;
    await ttsPending;
    return {
      status: "succeeded",
      elapsedMs: 13,
      profileId: "sandrone-dev",
      endpoint: "http://private.invalid",
      audio: "raw",
    };
  },
  now: (() => { let value = 100; return () => (value += 5); })(),
});

const first = coordinator.warmup();
const shared = coordinator.warmup();
assert.equal(first, shared, "concurrent callers must share one in-flight Promise");
assert.equal(manualCalls, 1);
assert.equal(ttsCalls, 1);
releaseManual();
releaseTts();
const ready = await first;
assert.deepEqual(ready, {
  status: "ready",
  durationMs: 5,
  tasks: {
    manualRag: { status: "ready", durationMs: 11, model: "bge-m3" },
    gptSoVits: { status: "ready", durationMs: 13, profile: "sandrone-dev" },
  },
});
assert.equal(Object.isFrozen(ready), true);
assert.equal(Object.isFrozen(ready.tasks), true);
assert.equal(Object.isFrozen(ready.tasks.manualRag), true);
assert.doesNotMatch(JSON.stringify(ready), /private|prompt|embedding|audio|endpoint|header|stack|message/i);
assert.equal(await coordinator.warmup(), ready, "a fully ready coordinator must remain idempotent");
assert.equal(manualCalls, 1);
assert.equal(ttsCalls, 1);

let retryManualCalls = 0;
let retryTtsCalls = 0;
const retryCoordinator = createRuntimeWarmupCoordinator({
  warmManualRag: async () => {
    retryManualCalls += 1;
    return { status: "ready", durationMs: 2, embeddingModel: "bge-m3" };
  },
  warmGptSoVits: async () => {
    retryTtsCalls += 1;
    if (retryTtsCalls === 1) throw new Error("PRIVATE_TTS_FAILURE");
    return { status: "succeeded", elapsedMs: 3, profileId: "sandrone-dev" };
  },
  now: (() => { let value = 0; return () => (value += 1); })(),
});
const degraded = await retryCoordinator.warmup();
assert.deepEqual(degraded, {
  status: "degraded",
  durationMs: 1,
  tasks: {
    manualRag: { status: "ready", durationMs: 2, model: "bge-m3" },
    gptSoVits: { status: "degraded", durationMs: 0, reasonCode: "warmup-unavailable" },
  },
});
assert.doesNotMatch(JSON.stringify(degraded), /PRIVATE_TTS_FAILURE/);
const retried = await retryCoordinator.warmup();
assert.equal(retried.status, "ready");
assert.equal(retryManualCalls, 1, "a ready task must not be repeated while a degraded peer retries");
assert.equal(retryTtsCalls, 2);

let endpointCalls = 0;
const endpointCoordinator = {
  async warmup() {
    endpointCalls += 1;
    return Object.freeze({
      status: "ready",
      durationMs: 4,
      tasks: Object.freeze({
        manualRag: Object.freeze({
          status: "ready", durationMs: 2, model: "bge-m3", privatePath: "/private/manual",
        }),
        gptSoVits: Object.freeze({
          status: "ready", durationMs: 3, profile: "sandrone-dev", rawAudio: "PRIVATE_AUDIO",
        }),
      }),
    });
  },
};
const endpointReady = await handleRuntimeWarmupBody({}, endpointCoordinator);
assert.deepEqual(endpointReady, {
  statusCode: 200,
  body: {
    status: "ready",
    durationMs: 4,
    tasks: {
      manualRag: { status: "ready", durationMs: 2, model: "bge-m3" },
      gptSoVits: { status: "ready", durationMs: 3, profile: "sandrone-dev" },
    },
  },
});
assert.equal(endpointCalls, 1);
assert.doesNotMatch(JSON.stringify(endpointReady), /private|audio/i);
const rejected = await handleRuntimeWarmupBody({ query: "PRIVATE_USER_QUERY" }, endpointCoordinator);
assert.deepEqual(rejected, {
  statusCode: 400,
  body: { error: "runtime warmup accepts no request fields" },
});
assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_USER_QUERY/);
assert.equal(endpointCalls, 1, "invalid fields must be rejected before warmup starts");

const serverSource = readFileSync(new URL("../../src/server/local-agent-server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /POST"\s*&&\s*request\.url\s*===\s*"\/api\/runtime-warmup"/);
assert.match(serverSource, /handleRuntimeWarmupBody\(body, runtimeWarmupCoordinator\)/);
assert.match(serverSource, /defaultRuntimeWarmupCoordinator\.warmup\(\)/,
  "listener startup and the injected endpoint must use the same process-local coordinator");

console.log("verify-runtime-warmup: passed");
