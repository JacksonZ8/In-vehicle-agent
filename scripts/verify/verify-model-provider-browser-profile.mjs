import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadModelProviderProfile } from "../../src/app/model-provider-profile.js";
import { createServer } from "../../src/server/local-agent-server.mjs";
import { createModelProviderRegistry } from "../../src/server/model-providers/model-provider-registry.js";

const TASK_IDS = Object.freeze([
  "vehicle_slu",
  "orchestrator_plan",
  "cabin_response",
  "knowledge_answer",
  "rag_rerank",
  "asr_realtime",
  "tts_realtime",
]);

const validProfile = {
  schemaVersion: 3,
  runtimeContractVersion: "b3-b4-runtime@1.0.0",
  tasks: {
    vehicle_slu: {
      provider: "dashscope",
      model: "qwen3.5-flash-2026-02-23",
      mode: "non-thinking",
      schemaVersion: "nio-vehicle-slu-contract@2.0.0",
      fallbackConfigured: true,
      watchdogMs: null,
      primaryReadiness: { status: "ready" },
      readiness: { status: "ready" },
    },
    orchestrator_plan: {
      provider: "ollama",
      model: "qwen3:8b",
      mode: "non-thinking",
      schemaVersion: null,
      fallbackConfigured: false,
      watchdogMs: null,
      primaryReadiness: { status: "ready" },
      readiness: { status: "ready" },
    },
    cabin_response: {
      provider: "ollama",
      model: "qwen3:8b",
      mode: "non-thinking",
      schemaVersion: null,
      fallbackConfigured: false,
      watchdogMs: null,
      primaryReadiness: { status: "ready" },
      readiness: { status: "ready" },
    },
    knowledge_answer: {
      provider: "dashscope",
      model: "qwen3.8-flash",
      mode: "non-thinking",
      schemaVersion: "nio-knowledge-answer-contract@1.0.0",
      fallbackConfigured: true,
      watchdogMs: null,
      primaryReadiness: { status: "ready" },
      readiness: { status: "ready" },
    },
    rag_rerank: {
      provider: "ollama",
      model: "qwen3:8b",
      mode: "non-thinking",
      schemaVersion: null,
      fallbackConfigured: false,
      watchdogMs: null,
      primaryReadiness: { status: "ready" },
      readiness: { status: "ready" },
    },
    asr_realtime: {
      provider: null,
      model: null,
      mode: null,
      schemaVersion: null,
      fallbackConfigured: false,
      watchdogMs: null,
      primaryReadiness: { status: "ready" },
      readiness: { status: "ready" },
    },
    tts_realtime: {
      provider: null,
      model: null,
      mode: null,
      schemaVersion: null,
      fallbackConfigured: false,
      watchdogMs: null,
      primaryReadiness: { status: "ready" },
      readiness: { status: "ready" },
    },
  },
};

const blockedTask = Object.freeze({
  provider: null,
  model: null,
  mode: null,
  schemaVersion: null,
  fallbackConfigured: false,
  watchdogMs: null,
  primaryReadiness: Object.freeze({
    status: "blocked",
    reasonCode: "provider-profile-unavailable",
  }),
  readiness: Object.freeze({
    status: "blocked",
    reasonCode: "provider-profile-unavailable",
  }),
});
const allBlockedProfile = {
  schemaVersion: 3,
  runtimeContractVersion: "b3-b4-runtime@1.0.0",
  tasks: Object.fromEntries(TASK_IDS.map((task) => [task, blockedTask])),
};

function withUnknownAndSensitiveFields(profile) {
  const injected = structuredClone(profile);
  injected.apiKey = "fake-secret-for-test";
  injected.authorization = "Bearer fake-secret-for-test";
  injected.rawError = { message: "fake-secret-for-test" };
  injected.tasks.unregistered_task = {
    provider: "dashscope",
    model: "private-model",
    apiKey: "fake-secret-for-test",
  };
  for (const task of TASK_IDS) {
    Object.assign(injected.tasks[task], {
      apiKey: "fake-secret-for-test",
      baseUrl: "https://user:password@example.invalid/compatible-mode/v1",
      headers: { authorization: "Bearer fake-secret-for-test" },
      fallback: { provider: "ollama", model: "private-fallback-model" },
      rawOutput: "fake-secret-for-test",
    });
    injected.tasks[task].readiness.debugError = "fake-secret-for-test";
  }
  return injected;
}

function assertSafeV3Profile(actual, expected, message, { frozen = true } = {}) {
  assert.deepEqual(actual, expected, message);
  assert.deepEqual(Object.keys(actual).sort(), ["runtimeContractVersion", "schemaVersion", "tasks"]);
  assert.deepEqual(Object.keys(actual.tasks).sort(), [...TASK_IDS].sort());
  if (frozen) {
    assert.equal(Object.isFrozen(actual), true, `${message}: envelope must be frozen`);
    assert.equal(Object.isFrozen(actual.tasks), true, `${message}: tasks must be frozen`);
  }
  for (const task of TASK_IDS) {
    assert.deepEqual(Object.keys(actual.tasks[task]).sort(), [
      "fallbackConfigured",
      "mode",
      "model",
      "primaryReadiness",
      "provider",
      "readiness",
      "schemaVersion",
      "watchdogMs",
    ]);
    if (frozen) {
      assert.equal(Object.isFrozen(actual.tasks[task]), true, `${message}: ${task} must be frozen`);
      assert.equal(Object.isFrozen(actual.tasks[task].readiness), true,
        `${message}: ${task} readiness must be frozen`);
    }
  }
  const serialized = JSON.stringify(actual);
  for (const forbidden of [
    "fake-secret-for-test",
    "authorization",
    "user:password",
    "private-fallback-model",
    "rawOutput",
    "unregistered_task",
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false,
      `${message}: must omit ${forbidden}`);
  }
}

class FakeRequest extends EventEmitter {
  constructor() {
    super();
    this.method = "GET";
    this.url = "/api/model-provider-profile";
    this.aborted = false;
    this.destroyed = false;
  }
}

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  closed = false;
  headersSent = false;
  status = null;
  headers = null;
  body = null;

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }

  end(body = "") {
    this.body = body;
    this.writableEnded = true;
  }
}

async function requestProfile(modelProviderRegistry) {
  const server = createServer({ modelProviderRegistry });
  const request = new FakeRequest();
  const response = new FakeResponse();
  await server.listeners("request")[0](request, response);
  return response;
}

async function loadFixture(body, { status = 200, timeoutMs = 50 } = {}) {
  return loadModelProviderProfile({
    endpoint: "/api/model-provider-profile",
    fetchImpl: async (url, init) => {
      assert.equal(url, "/api/model-provider-profile");
      assert.equal(init.signal instanceof AbortSignal, true);
      assert.equal(init.cache, "no-store");
      return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
    timeoutMs,
  });
}

async function verifyLoaderProjection() {
  const loaded = await loadFixture(withUnknownAndSensitiveFields(validProfile));
  assertSafeV3Profile(loaded, validProfile,
    "loader must project only the fixed schema-v3 task allowlist");

  const partial = structuredClone(validProfile);
  delete partial.tasks.cabin_response;
  partial.tasks.vehicle_slu.apiKey = "fake-secret-for-test";
  const expectedPartial = structuredClone(validProfile);
  expectedPartial.tasks.cabin_response = blockedTask;
  const loadedPartial = await loadFixture(partial);
  assertSafeV3Profile(loadedPartial, expectedPartial,
    "one missing known task must fail closed without discarding valid siblings");

  const invalidKnownTask = structuredClone(validProfile);
  invalidKnownTask.tasks.rag_rerank.watchdogMs = 0;
  const expectedInvalidKnownTask = structuredClone(validProfile);
  expectedInvalidKnownTask.tasks.rag_rerank = blockedTask;
  assertSafeV3Profile(
    await loadFixture(invalidKnownTask),
    expectedInvalidKnownTask,
    "one invalid known task must fail closed without discarding valid siblings",
  );

  const unsafeBlockedReason = structuredClone(validProfile);
  unsafeBlockedReason.tasks.vehicle_slu.readiness = {
    status: "blocked",
    reasonCode: "Bearer fake-secret-for-test",
  };
  const expectedBlockedReason = structuredClone(validProfile);
  expectedBlockedReason.tasks.vehicle_slu.readiness = {
    status: "blocked",
    reasonCode: "provider-profile-unavailable",
  };
  assertSafeV3Profile(
    await loadFixture(unsafeBlockedReason),
    expectedBlockedReason,
    "blocked readiness must expose only a sanitized reasonCode",
  );

  for (const invalidEnvelope of [
    { ...validProfile, schemaVersion: 2 },
    { ...validProfile, runtimeContractVersion: "wrong-runtime" },
    { ...validProfile, tasks: null },
  ]) {
    assertSafeV3Profile(
      await loadFixture(invalidEnvelope),
      allBlockedProfile,
      "an invalid envelope must block all six known tasks",
    );
  }

  assertSafeV3Profile(
    await loadFixture("unavailable", { status: 503 }),
    allBlockedProfile,
    "a non-2xx response must block all six known tasks",
  );
  assertSafeV3Profile(
    await loadFixture("{not-json"),
    allBlockedProfile,
    "invalid JSON must block all six known tasks",
  );

  let timeoutSignal = null;
  const timedOut = await loadModelProviderProfile({
    endpoint: "/api/model-provider-profile",
    fetchImpl: async (_url, init) => {
      timeoutSignal = init.signal;
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(init.signal.reason);
        if (init.signal.aborted) rejectAbort();
        else init.signal.addEventListener("abort", rejectAbort, { once: true });
      });
    },
    timeoutMs: 10,
  });
  assertSafeV3Profile(timedOut, allBlockedProfile,
    "loader watchdog must block all known tasks");
  assert.equal(timeoutSignal?.aborted, true, "loader watchdog must preserve fetch cancellation");
}

async function verifyRegistryProjection() {
  const registry = createModelProviderRegistry({
    publicProfiles: withUnknownAndSensitiveFields(validProfile),
  });
  assertSafeV3Profile(registry.publicProfiles, validProfile,
    "registry storage must re-project an injected public profile");
}

async function verifyHttpBoundaryProjection() {
  let providerCalls = 0;
  const response = await requestProfile(Object.freeze({
    publicProfiles: withUnknownAndSensitiveFields(validProfile),
    providerFor() {
      providerCalls += 1;
      throw new Error("profile route must not reach a Provider");
    },
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(providerCalls, 0);
  assertSafeV3Profile(JSON.parse(response.body), validProfile,
    "HTTP response boundary must re-project an injected registry object", { frozen: false });
}

const selected = new Set(process.argv.slice(2));
const shouldRun = (name) => selected.size === 0 || selected.has(name);
if (shouldRun("loader")) await verifyLoaderProjection();
if (shouldRun("registry")) await verifyRegistryProjection();
if (shouldRun("http")) await verifyHttpBoundaryProjection();

console.log("verify-model-provider-browser-profile: PASS");
