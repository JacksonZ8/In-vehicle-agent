import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { LocalModelAdapter } from "../../src/semantic/local-model-adapter.js";
import { VEHICLE_SLU_CONTRACT, VEHICLE_SLU_PROMPT_VERSION } from "../../src/semantic/vehicle-slu-contract.js";
import { runVehicleSluSemanticBoundary } from "../../src/server/local-agent-server.mjs";
import { createOllamaGenerateClient } from "../../src/server/model-providers/ollama-generate-client.js";
import { resolveModelTaskProfiles } from "../../src/server/model-providers/model-task-profile.js";

const PRIMARY_PROVIDER = "dashscope";
const PRIMARY_MODEL = "qwen3.5-flash-2026-02-23";
const PUBLIC_VEHICLE_SLU_PROFILE = Object.freeze({
  provider: PRIMARY_PROVIDER,
  model: PRIMARY_MODEL,
  mode: "non-thinking",
  schemaVersion: VEHICLE_SLU_CONTRACT.ref,
  fallbackConfigured: true,
  watchdogMs: null,
  readiness: Object.freeze({ status: "ready" }),
});

class RecordingScheduler {
  constructor() {
    this.scheduled = [];
    this.cleared = [];
  }

  setTimeout(callback, delayMs) {
    const token = { callback, delayMs, fired: false };
    this.scheduled.push(token);
    return token;
  }

  clearTimeout(token) {
    this.cleared.push(token);
  }

  fire(index = 0) {
    const token = this.scheduled[index];
    assert.ok(token, `missing scheduled timer ${index}`);
    token.fired = true;
    token.callback();
  }
}

function pendingFetch(calls) {
  return async (_url, options = {}) => {
    calls.push(options);
    return new Promise((_resolve, reject) => {
      const rejectAbort = () => reject(options.signal.reason instanceof Error
        ? options.signal.reason
        : Object.assign(new Error("aborted"), {
          name: "AbortError",
          reason: options.signal.reason,
        }));
      if (options.signal.aborted) rejectAbort();
      else options.signal.addEventListener("abort", rejectAbort, { once: true });
    });
  };
}

function generalEnvelope(requestId) {
  return {
    contractVersion: VEHICLE_SLU_CONTRACT.ref,
    requestId,
    domain: "non_vehicle",
    conversationGoal: { summary: "回应普通对话", need: "social" },
    vehicleFrames: [],
    domainConfidence: 0.95,
  };
}

function vehicleSluProviderResult(requestId) {
  return {
    text: JSON.stringify(generalEnvelope(requestId)),
    provider: PRIMARY_PROVIDER,
    model: PRIMARY_MODEL,
    durationMs: 8,
    providerTelemetry: {},
  };
}

function createVehicleSluTaskRegistry({ watchdogMs = null, generateForVehicleSlu }) {
  const provider = Object.freeze({ id: PRIMARY_PROVIDER, model: PRIMARY_MODEL });
  const profile = Object.freeze({
    task: "vehicle_slu",
    provider: provider.id,
    model: provider.model,
    watchdogMs,
  });
  const requireVehicleSluTask = (task) => {
    assert.equal(task, "vehicle_slu", `test registry is missing explicit task ${task}`);
  };
  return Object.freeze({
    providerFor(task) {
      requireVehicleSluTask(task);
      return provider;
    },
    profileFor(task) {
      requireVehicleSluTask(task);
      return profile;
    },
    generateForTask(task, request) {
      requireVehicleSluTask(task);
      return generateForVehicleSlu(request);
    },
  });
}

function endpointResponse(requestId, watchdogMs, { durationMs = 8 } = {}) {
  const slowStage = durationMs > 3_000 ? "semantic-decision" : null;
  return {
    model: PRIMARY_MODEL,
    semanticEnvelope: generalEnvelope(requestId),
    telemetry: {
      provider: PRIMARY_PROVIDER,
      model: PRIMARY_MODEL,
      modelType: "vehicle-slu",
      contractVersion: VEHICLE_SLU_CONTRACT.ref,
      promptVersion: VEHICLE_SLU_PROMPT_VERSION,
      promptChars: 320,
      durationMs,
      semanticDecisionMs: durationMs,
      firstModelTokenMs: null,
      firstModelTokenStatus: "unobservable-non-streaming",
      slowStage,
      watchdogMs,
      ollamaDurations: {},
      degraded: false,
    },
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() { return structuredClone(body); },
  };
}

async function verifyLocalDefaultAndCallerAbort() {
  const scheduler = new RecordingScheduler();
  const calls = [];
  const adapter = new LocalModelAdapter({
    endpoint: "/api/local-semantic",
    providerProfile: PUBLIC_VEHICLE_SLU_PROFILE,
    fetchImpl: pendingFetch(calls),
    scheduler,
  });
  assert.equal(adapter.watchdogMs, null, "LocalModelAdapter must default to no watchdog");

  const caller = new AbortController();
  const pending = adapter.parse("讲个笑话", {
    requestId: "watchdog-local-default",
    signal: caller.signal,
  });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(scheduler.scheduled.length, 0, "a null watchdog must schedule no timer");

  const exactReason = { code: "user-cancelled" };
  caller.abort(exactReason);
  await assert.rejects(pending, (error) => {
    assert.equal(error?.name, "AbortError");
    assert.equal(error?.reason, exactReason, "caller abort reason must be preserved exactly");
    return true;
  });
  assert.equal(scheduler.cleared.length, 0, "no absent timer may be cleared");
}

async function verifyLocalExplicitWatchdog() {
  const scheduler = new RecordingScheduler();
  const calls = [];
  const adapter = new LocalModelAdapter({
    endpoint: "/api/local-semantic",
    providerProfile: PUBLIC_VEHICLE_SLU_PROFILE,
    fetchImpl: pendingFetch(calls),
    watchdogMs: 25,
    scheduler,
  });
  const pending = adapter.parse("讲个笑话", { requestId: "watchdog-local-explicit" });
  await Promise.resolve();
  assert.equal(scheduler.scheduled.length, 1, "an explicit watchdog must schedule once");
  assert.equal(scheduler.scheduled[0].delayMs, 25);
  scheduler.fire();
  const result = await pending;
  assert.equal(result.semanticEnvelope, null);
  assert.equal(result.executionDisabled, true);
  assert.equal(result.reasonCode, "semantic-endpoint-unavailable");
  assert.notEqual(result.reasonCode, "semantic-timeout");
  assert.equal(result.telemetry.watchdogMs, 25);
  assert.equal(scheduler.cleared.length, 1, "the explicit watchdog must be cleared once");
}

function verifyOptionalWatchdogNormalization() {
  for (const invalidWatchdogMs of [0.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const adapter = new LocalModelAdapter({ watchdogMs: invalidWatchdogMs });
    assert.equal(
      adapter.watchdogMs,
      null,
      `watchdog ${String(invalidWatchdogMs)} must normalize to null after flooring`,
    );
  }
  assert.equal(new LocalModelAdapter({ watchdogMs: 1.9 }).watchdogMs, 1);
}

async function verifyLocalTelemetryContract() {
  for (const watchdogMs of [null, 40]) {
    const scheduler = new RecordingScheduler();
    const requestId = `watchdog-local-telemetry-${watchdogMs ?? "none"}`;
    const adapter = new LocalModelAdapter({
      endpoint: "/api/local-semantic",
      providerProfile: PUBLIC_VEHICLE_SLU_PROFILE,
      watchdogMs,
      scheduler,
      fetchImpl: async () => jsonResponse(endpointResponse(requestId, watchdogMs)),
    });
    const result = await adapter.parse("你好", { requestId });
    assert.equal(result.executionDisabled, false);
    assert.equal(result.telemetry.watchdogMs, watchdogMs);
    assert.equal(result.telemetry.semanticDecisionMs, 8);
    assert.equal(result.telemetry.firstModelTokenMs, null);
    assert.equal(result.telemetry.firstModelTokenStatus, "unobservable-non-streaming");
    assert.equal(result.telemetry.slowStage, null);
    assert.equal(Object.hasOwn(result.telemetry, "timeoutMs"), false);
    assert.equal(scheduler.scheduled.length, watchdogMs === null ? 0 : 1);
    assert.equal(scheduler.cleared.length, watchdogMs === null ? 0 : 1);
  }
}

function ollamaResponse() {
  return new Response(JSON.stringify({
    response: "ok",
    done_reason: "stop",
    prompt_eval_count: 1,
    eval_count: 1,
  }), { status: 200 });
}

async function verifyOllamaOptionalWatchdog() {
  const defaultScheduler = new RecordingScheduler();
  const defaultClient = createOllamaGenerateClient({
    baseUrl: "http://127.0.0.1:11434",
    keepAlive: "24h",
    scheduler: defaultScheduler,
    fetchImpl: async () => ollamaResponse(),
  });
  const result = await defaultClient.generate({ model: "qwen2.5:3b", prompt: "ok" });
  assert.equal(result.text, "ok");
  assert.equal(defaultScheduler.scheduled.length, 0, "Ollama default must schedule no timer");
  assert.equal(defaultScheduler.cleared.length, 0);

  const explicitScheduler = new RecordingScheduler();
  const calls = [];
  const explicitClient = createOllamaGenerateClient({
    baseUrl: "http://127.0.0.1:11434",
    keepAlive: "24h",
    scheduler: explicitScheduler,
    fetchImpl: pendingFetch(calls),
  });
  const pending = explicitClient.generate({
    model: "qwen2.5:3b",
    prompt: "wait",
    timeoutMs: 25,
  });
  await Promise.resolve();
  assert.equal(explicitScheduler.scheduled.length, 1);
  explicitScheduler.fire();
  await assert.rejects(pending, (error) => error?.code === "generation-timeout");
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(explicitScheduler.cleared.length, 1);
}

async function runServerCase({ requestId, watchdogMs, generateForVehicleSlu }) {
  return runVehicleSluSemanticBoundary({
    text: "你好",
    requestId,
    registry: createVehicleSluTaskRegistry({ watchdogMs, generateForVehicleSlu }),
    now: () => 10,
  });
}

async function verifyServerWatchdogContract() {
  for (const [watchdogMs, expectedWatchdogMs] of [
    [undefined, null],
    [0.5, null],
    [0, null],
    [-1, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [1.9, 1],
    [35, 35],
  ]) {
    const calls = [];
    const requestId = `watchdog-server-${watchdogMs ?? "default"}`;
    const result = await runServerCase({
      requestId,
      watchdogMs,
      generateForVehicleSlu: async (request) => {
        calls.push(request);
        return vehicleSluProviderResult(requestId);
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(calls[0], "timeoutMs"), false,
      "Vehicle-SLU must leave watchdog enforcement to the task registry");
    assert.equal(Object.hasOwn(calls[0], "watchdogMs"), false);
    assert.equal(result.telemetry.watchdogMs, expectedWatchdogMs);
    assert.equal(Object.hasOwn(result.telemetry, "timeoutMs"), false);
  }

  const timeoutError = new Error("explicit semantic watchdog expired");
  timeoutError.code = "generation-timeout";
  const failed = await runServerCase({
    requestId: "watchdog-server-expired",
    watchdogMs: 35,
    generateForVehicleSlu: async () => { throw timeoutError; },
  });
  assert.equal(failed.reasonCode, "semantic-model-unavailable");
  assert.notEqual(failed.reasonCode, "semantic-timeout");
  assert.equal(failed.telemetry.watchdogMs, 35);
}

async function verifySlowSemanticObservation() {
  const requestId = "watchdog-server-slow-success";
  const expectedEnvelope = generalEnvelope(requestId);
  const ticks = [100, 3_201];
  let tick = 0;
  const serverResult = await runVehicleSluSemanticBoundary({
    text: "你好",
    requestId,
    now: () => ticks[Math.min(tick++, ticks.length - 1)],
    registry: createVehicleSluTaskRegistry({
      watchdogMs: null,
      generateForVehicleSlu: async () => vehicleSluProviderResult(requestId),
    }),
  });
  assert.deepEqual(serverResult.semanticEnvelope, expectedEnvelope,
    "a completed slow decision must return the original valid envelope");
  assert.equal(Object.hasOwn(serverResult, "executionDisabled"), false);
  assert.equal(serverResult.telemetry.durationMs, 3_101);
  assert.equal(serverResult.telemetry.semanticDecisionMs, 3_101);
  assert.equal(serverResult.telemetry.firstModelTokenMs, null);
  assert.equal(serverResult.telemetry.firstModelTokenStatus, "unobservable-non-streaming");
  assert.equal(serverResult.telemetry.slowStage, "semantic-decision");
  assert.equal(serverResult.telemetry.degraded, false);

  const adapter = new LocalModelAdapter({
    endpoint: "/api/local-semantic",
    providerProfile: PUBLIC_VEHICLE_SLU_PROFILE,
    watchdogMs: null,
    fetchImpl: async () => jsonResponse(serverResult),
  });
  const browserResult = await adapter.parse("你好", { requestId });
  assert.deepEqual(browserResult.semanticEnvelope, expectedEnvelope);
  assert.equal(browserResult.executionDisabled, false,
    "browser must not rewrite an observed slow success as degradation");
  assert.equal(browserResult.telemetry.semanticDecisionMs, 3_101);
  assert.equal(browserResult.telemetry.firstModelTokenMs, null);
  assert.equal(browserResult.telemetry.firstModelTokenStatus, "unobservable-non-streaming");
  assert.equal(browserResult.telemetry.slowStage, "semantic-decision");
  assert.equal(browserResult.telemetry.degraded, false);
}

async function verifyStaticMigration() {
  // The repository-wide scan intentionally leaves explicit test/benchmark bounds,
  // provider/health/weather/TTS watchdogs, and the five-second interaction window intact.
  const [indexHtml, adapterSource, serverSource, appSource] = await Promise.all([
    readFile(new URL("../../index.html", import.meta.url), "utf8"),
    readFile(new URL("../../src/semantic/local-model-adapter.js", import.meta.url), "utf8"),
    readFile(new URL("../../src/server/local-agent-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/app.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(indexHtml, /NIO_LOCAL_MODEL_TIMEOUT_MS/);
  assert.match(indexHtml, /NIO_LOCAL_MODEL_WATCHDOG_MS/);
  assert.match(indexHtml, /Math\.floor\(Number\(window\.NIO_LOCAL_MODEL_WATCHDOG_MS\)\)/,
    "browser bootstrap must floor the optional watchdog before positivity validation");
  assert.doesNotMatch(adapterSource, /NIO_LOCAL_MODEL_TIMEOUT_MS|this\.timeoutMs|telemetry\.timeoutMs/);
  assert.doesNotMatch(serverSource, /VEHICLE_SLU_TIMEOUT_MS/);
  assert.doesNotMatch(serverSource, /NIO_SEMANTIC_WATCHDOG_MS/,
    "server handlers must not retain the pre-registry Vehicle-SLU watchdog override");
  assert.equal(resolveModelTaskProfiles({
    NIO_VEHICLE_SLU_WATCHDOG_MS: "35",
  }).vehicle_slu.watchdogMs, 35,
  "the explicit Vehicle-SLU watchdog must come from its task profile");
  const manualRetriever = appSource.match(
    /async function retrieveManualChunksFromBrowser[\s\S]*?\n}\n\nfunction projectManualChunkEvidenceRef/,
  )?.[0] || "";
  assert.ok(manualRetriever, "Manual RAG browser retriever must remain inspectable");
  assert.doesNotMatch(manualRetriever, /deadlineAt|setTimeout|timeoutController|manual-rag-deadline/);
  const hmiProcessingWindow = appSource.match(
    /state\.running = true;[\s\S]*?renderAssistantText\("正在生成回复", requestId\);[\s\S]*?const result = await runtime\.run/,
  )?.[0] || "";
  assert.ok(hmiProcessingWindow,
    "HMI must remain in its processing presentation until Runtime resolves");
  assert.doesNotMatch(hmiProcessingWindow, /setTimeout|Promise\.race|AbortSignal\.timeout/,
    "HMI processing must not add a semantic latency abort timer");
}

await verifyLocalDefaultAndCallerAbort();
await verifyLocalExplicitWatchdog();
verifyOptionalWatchdogNormalization();
await verifyLocalTelemetryContract();
await verifyOllamaOptionalWatchdog();
await verifyServerWatchdogContract();
await verifySlowSemanticObservation();
await verifyStaticMigration();

console.log("verify-runtime-watchdog-policy: PASS");
