import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { resolveConversationRoute } from "../../src/runtime/agent-schemas.js";
import * as localAgentServer from "../../src/server/local-agent-server.mjs";

const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");

const vehicleKnowledgeBody = {
  task: "conversation_general",
  rawText: "解释一下蔚来 ES6 的空气质量相关能力边界",
  prompt: "解释一下蔚来 ES6 的空气质量相关能力边界",
  parsedCommand: {
    intent: "conversation.general",
    rawText: "解释一下蔚来 ES6 的空气质量相关能力边界",
    slots: {
      topic: "vehicle_knowledge",
    },
    conversationGoal: {
      domain: "vehicle_knowledge",
      interactionType: "question",
      goal: "解释一下蔚来 ES6 的空气质量相关能力边界",
      source: "verify-local-llm-cache",
    },
  },
};

const weatherBody = {
  task: "conversation_general",
  rawText: "今天杭州天气怎么样，适合开窗通风吗？",
  prompt: "今天杭州天气怎么样，适合开窗通风吗？",
  parsedCommand: {
    intent: "conversation.general",
    rawText: "今天杭州天气怎么样，适合开窗通风吗？",
    requiresExternalData: true,
    externalDataType: "weather",
    slots: {
      topic: "weather_query",
      city: "杭州",
      requiresExternalData: true,
      externalDataType: "weather",
    },
    conversationGoal: {
      domain: "weather",
      interactionType: "question",
      goal: "今天杭州天气怎么样，适合开窗通风吗？",
      source: "verify-local-llm-cache",
    },
  },
};

function assertFixtureRoute(label, body, expected) {
  const route = resolveConversationRoute(body.rawText, body.parsedCommand);
  assert.equal(route.domain, expected.domain, `${label}: route.domain`);
  assert.equal(route.interactionType, expected.interactionType, `${label}: route.interactionType`);
  assert.equal(route.requiresExternalData, expected.requiresExternalData, `${label}: route.requiresExternalData`);
  if (expected.externalDataType) assert.equal(route.externalDataType, expected.externalDataType, `${label}: route.externalDataType`);
  if (expected.isWeather !== undefined) assert.equal(route.isWeather, expected.isWeather, `${label}: route.isWeather`);
  if (expected.isVehicleKnowledge !== undefined) assert.equal(route.isVehicleKnowledge, expected.isVehicleKnowledge, `${label}: route.isVehicleKnowledge`);
}

async function fetchJson(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(60_000),
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });
  const wallMs = Math.round(performance.now() - startedAt);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawBody: text };
  }

  assert.ok(response.ok, `${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return { body, wallMs };
}

async function postLocalLlm(label, body) {
  const result = await fetchJson("/api/local-llm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: `verify-local-llm-cache-${label}-${Date.now()}`,
      ...body,
    }),
  });

  assert.equal(typeof result.body.summary, "string", `${label}: summary should be a string`);
  assert.ok(result.body.summary.trim().length > 0, `${label}: summary should not be empty`);
  assert.ok(result.body.telemetry && typeof result.body.telemetry === "object", `${label}: telemetry should exist`);
  return result;
}

function summarize(label, result) {
  const telemetry = result.body.telemetry || {};
  return {
    label,
    wallMs: result.wallMs,
    provider: telemetry.provider,
    cacheHit: telemetry.cacheHit,
    cacheEligible: telemetry.cacheEligible,
    cacheType: telemetry.cacheType,
    cachedProvider: telemetry.cachedProvider,
    externalDataProvider: telemetry.externalDataProvider,
  };
}

class FakeRequest extends EventEmitter {
  constructor(body) {
    super();
    this.method = "POST";
    this.url = "/api/local-llm";
    this.body = JSON.stringify(body);
    this.aborted = false;
    this.destroyed = false;
  }

  send() {
    this.emit("data", Buffer.from(this.body));
    this.emit("end");
  }
}

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  closed = false;
  headersSent = false;
  status = null;
  body = null;

  writeHead(status) {
    this.status = status;
    this.headersSent = true;
  }

  end(body = "") {
    this.body = body ? JSON.parse(body) : null;
    this.writableEnded = true;
  }
}

async function postToServer(server, body) {
  const request = new FakeRequest(body);
  const response = new FakeResponse();
  const pending = server.listeners("request")[0](request, response);
  request.send();
  await pending;
  return response;
}

async function verifyContractOnly() {
  assert.equal(typeof localAgentServer.buildLlmResponseCacheKey, "function");
  const prompt = "identical-provider-isolation-prompt";
  const ollamaKey = localAgentServer.buildLlmResponseCacheKey({
    provider: "ollama",
    model: "ollama-model",
    promptStyle: "verbose",
    conversationOutputMode: "standard",
    prompt,
  });
  const dashscopeKey = localAgentServer.buildLlmResponseCacheKey({
    provider: "dashscope",
    model: "dashscope-model",
    promptStyle: "verbose",
    conversationOutputMode: "standard",
    prompt,
  });
  assert.equal(ollamaKey, JSON.stringify({
    provider: "ollama",
    model: "ollama-model",
    promptStyle: "verbose",
    conversationOutputMode: "standard",
    prompt,
  }));
  assert.notEqual(ollamaKey, dashscopeKey);

  const calls = { ollama: [], dashscope: [] };
  const registry = (provider, model, text) => {
    const taskProvider = Object.freeze({
      id: provider,
      model,
      async generate(request) {
        calls[provider].push(request);
        return {
          text,
          provider,
          model,
          durationMs: 4,
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedInputTokens: 0 },
          externalModelRequestCount: provider === "dashscope" ? 1 : 0,
        };
      },
    });
    const requireProvider = (task) => {
      assert.equal(task, "cabin_response", `test registry is missing explicit task ${task}`);
      return taskProvider;
    };
    return Object.freeze({
      providerFor: requireProvider,
      profileFor(task) {
        requireProvider(task);
        return Object.freeze({ task, provider, model, watchdogMs: null });
      },
      generateForTask(task, request) {
        return requireProvider(task).generate(request);
      },
      publicProfiles: Object.freeze({ provider, model }),
    });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    response: "legacy-direct-ollama-response",
    done_reason: "stop",
    prompt_eval_count: 3,
    eval_count: 2,
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const ollamaRegistry = registry("ollama", "ollama-model", "ollama-response");
    const dashscopeRegistry = registry("dashscope", "dashscope-model", "dashscope-response");
    const first = await postToServer(localAgentServer.createServer({ modelProviderRegistry: ollamaRegistry }), vehicleKnowledgeBody);
    const isolated = await postToServer(localAgentServer.createServer({ modelProviderRegistry: dashscopeRegistry }), vehicleKnowledgeBody);
    const cached = await postToServer(localAgentServer.createServer({ modelProviderRegistry: dashscopeRegistry }), vehicleKnowledgeBody);

    assert.equal(first.status, 200);
    assert.equal(isolated.status, 200);
    assert.equal(cached.status, 200);
    assert.equal(calls.ollama.length, 1);
    assert.equal(calls.dashscope.length, 1, "Ollama cache entry must not satisfy DashScope");
    assert.equal(isolated.body.summary, "dashscope-response");
    assert.equal(cached.body.summary, "dashscope-response");
    assert.equal(cached.body.telemetry.cacheHit, true);
    assert.equal(cached.body.telemetry.provider, "dashscope");
    assert.equal(cached.body.telemetry.model, "dashscope-model");
    assert.equal(isolated.body.telemetry.externalModelRequestCount, 1);
    assert.equal(cached.body.telemetry.externalModelRequestCount, 0,
      "a cache hit must report zero new external model requests");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(JSON.stringify({ ok: true, mode: "contract-only", providerIsolation: true, cacheIdentityPreserved: true }, null, 2));
}

async function main() {
  assertFixtureRoute("vehicle-fixture", vehicleKnowledgeBody, {
    domain: "vehicle_knowledge",
    interactionType: "question",
    requiresExternalData: false,
    isVehicleKnowledge: true,
  });
  assertFixtureRoute("weather-fixture", weatherBody, {
    domain: "weather",
    interactionType: "question",
    requiresExternalData: true,
    externalDataType: "weather",
    isWeather: true,
  });

  const vehicleFirst = await postLocalLlm("vehicle-first", vehicleKnowledgeBody);
  const vehicleSecond = await postLocalLlm("vehicle-second", vehicleKnowledgeBody);
  const weatherFirst = await postLocalLlm("weather-first", weatherBody);
  const weatherSecond = await postLocalLlm("weather-second", weatherBody);

  assert.ok(
    vehicleSecond.body.telemetry.provider === "local-cache" || vehicleSecond.body.telemetry.cacheHit === true,
    "vehicle knowledge second request should hit local LLM response cache",
  );

  for (const [label, result] of [
    ["weather-first", weatherFirst],
    ["weather-second", weatherSecond],
  ]) {
    assert.notEqual(result.body.telemetry.provider, "local-cache", `${label}: weather should not use local-cache`);
    assert.notEqual(result.body.telemetry.cacheHit, true, `${label}: weather should not be cacheHit:true`);
  }

  console.log(JSON.stringify({
    baseUrl,
    checkedAt: new Date().toISOString(),
    results: [
      summarize("vehicle-first", vehicleFirst),
      summarize("vehicle-second", vehicleSecond),
      summarize("weather-first", weatherFirst),
      summarize("weather-second", weatherSecond),
    ],
  }, null, 2));
}

const selectedMain = process.argv.includes("--live") ? main : verifyContractOnly;
selectedMain().catch((error) => {
  console.error(`verify-local-llm-cache failed: ${error.message}`);
  process.exitCode = 1;
});
