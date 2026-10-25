import assert from "node:assert/strict";
import { createDashScopeModelProvider } from "../../src/server/model-providers/dashscope-model-provider.js";
import { ModelProviderError } from "../../src/server/model-providers/model-provider-contract.js";
import { resolveModelProviderConnections } from "../../src/server/model-providers/model-provider-config.js";
import { createModelProviderRegistry } from "../../src/server/model-providers/model-provider-registry.js";
import { runVehicleSluSemanticBoundary } from "../../src/server/local-agent-server.mjs";

const primaryProfile = Object.freeze({
  task: "vehicle_slu",
  provider: "dashscope",
  model: "qwen3.5-flash",
  fallback: Object.freeze({ provider: "ollama", model: "qwen3:8b" }),
  watchdogMs: null,
});

class RecordingScheduler {
  constructor() {
    this.scheduled = [];
    this.cleared = [];
  }

  setTimeout(callback, delayMs) {
    const token = { callback, delayMs };
    this.scheduled.push(token);
    return token;
  }

  clearTimeout(token) {
    this.cleared.push(token);
  }

  fire(index = 0) {
    const token = this.scheduled[index];
    assert.ok(token, `missing scheduled timer ${index}`);
    token.callback();
  }
}

function providerResult(provider, model, text = "ok") {
  return Object.freeze({
    text,
    provider,
    model,
    durationMs: provider === "dashscope" ? 7 : 11,
    finishReason: "stop",
    usage: Object.freeze({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      cachedInputTokens: 0,
      unavailableReason: null,
    }),
    externalModelRequestCount: 1,
  });
}

function createRegistry({ primaryGenerate, fallbackGenerate }) {
  return createModelProviderRegistry({
    taskProfiles: Object.freeze({ cabin_response: { ...primaryProfile, task: "cabin_response" } }),
    connections: Object.freeze({
      dashscope: Object.freeze({ readiness: Object.freeze({ status: "ready" }) }),
      ollama: Object.freeze({ readiness: Object.freeze({ status: "ready" }) }),
    }),
    providerFactories: Object.freeze({
      dashscope: ({ profile }) => Object.freeze({
        id: "dashscope",
        model: profile.model,
        generate: primaryGenerate,
      }),
      ollama: ({ profile }) => Object.freeze({
        id: "ollama",
        model: profile.model,
        generate: fallbackGenerate,
      }),
    }),
  });
}

function dashScopeCompletion(content, finishReason = "stop") {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function createProductionRegistry({
  dashScopeFetch,
  ollamaClient,
  profile = primaryProfile,
  dashScopeScheduler,
  dashScopeNow,
}) {
  return createModelProviderRegistry({
    taskProfiles: Object.freeze({ vehicle_slu: profile, cabin_response: { ...profile, task: "cabin_response" } }),
    connections: resolveModelProviderConnections({
      DASHSCOPE_API_KEY: "production-path-test-secret",
    }, { ollamaClient }),
    fetchImpl: dashScopeFetch,
    ...(dashScopeScheduler
      ? {
          providerFactories: Object.freeze({
            dashscope: ({ profile: taskProfile, connection }) => createDashScopeModelProvider({
              apiKey: connection.apiKey,
              baseUrl: connection.baseUrl,
              model: taskProfile.model,
              fetchImpl: dashScopeFetch,
              scheduler: dashScopeScheduler,
              now: dashScopeNow,
            }),
          }),
        }
      : {}),
  });
}

{
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const registry = createRegistry({
    primaryGenerate: async () => {
      primaryCalls += 1;
      return providerResult("dashscope", primaryProfile.model);
    },
    fallbackGenerate: async () => {
      fallbackCalls += 1;
      return providerResult("ollama", primaryProfile.fallback.model);
    },
  });

  const result = await registry.generateForTask("cabin_response", { prompt: "primary success" });
  assert.equal(result.fallbackActive, false);
  assert.equal(result.provider, "dashscope");
  assert.equal(result.model, primaryProfile.model);
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 0);
}

for (const code of [
  "provider-config-invalid",
  "provider-invalid-request",
  "provider-unavailable",
  "provider-network-error",
  "provider-response-invalid",
  "provider-schema-invalid-after-repair",
]) {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const registry = createRegistry({
    primaryGenerate: async () => {
      primaryCalls += 1;
      throw new ModelProviderError("primary failed", {
        code,
        provider: "dashscope",
        externalModelRequestCount: code === "provider-config-invalid" ? 0 : 1,
        details: { reasonCode: code },
      });
    },
    fallbackGenerate: async () => {
      fallbackCalls += 1;
      return providerResult("ollama", primaryProfile.fallback.model);
    },
  });

  const result = await registry.generateForTask("cabin_response", { prompt: code });
  assert.equal(result.fallbackActive, true, `${code} must activate the configured fallback`);
  assert.equal(result.primaryFailureReasonCode, code);
  assert.equal(result.provider, "ollama");
  assert.equal(result.model, primaryProfile.fallback.model);
  assert.equal(result.durationMs, 11, "fallback duration must remain the real provider duration");
  assert.equal(result.usage.totalTokens, 5, "fallback usage must remain the real provider usage");
  assert.equal(result.externalModelRequestCount, code === "provider-config-invalid" ? 1 : 2);
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1, `${code} may call the fallback provider only once`);
}

for (const reasonCode of [
  "clarification-required",
  "low-confidence-clarification",
  "rag-miss",
  "safety-rejected",
  "capability-unavailable",
  "provider-safety-refusal",
  "user-cancelled",
]) {
  let fallbackCalls = 0;
  const registry = createRegistry({
    primaryGenerate: async () => {
      throw new ModelProviderError("business outcome must not fall back", {
        code: "provider-unavailable",
        provider: "dashscope",
        externalModelRequestCount: 1,
        details: { reasonCode },
      });
    },
    fallbackGenerate: async () => {
      fallbackCalls += 1;
      return providerResult("ollama", primaryProfile.fallback.model);
    },
  });

  await assert.rejects(
    registry.generateForTask("cabin_response", { prompt: reasonCode }),
    (error) => error?.details?.reasonCode === reasonCode,
  );
  assert.equal(fallbackCalls, 0, `${reasonCode} must not call the fallback provider`);
}

for (const providerFailureReasonCode of [
  "provider-safety-refusal",
  "provider-response-invalid",
  "generation-timeout",
]) {
  const requestId = `vehicle-slu-non-fallback-${providerFailureReasonCode}`;
  const secretFailureText = `SECRET_${providerFailureReasonCode}`;
  const taskProvider = Object.freeze({
    id: "dashscope",
    model: primaryProfile.model,
  });
  const registry = Object.freeze({
    providerFor(task) {
      assert.equal(task, "vehicle_slu");
      return taskProvider;
    },
    profileFor(task) {
      assert.equal(task, "vehicle_slu");
      return primaryProfile;
    },
    async generateForTask(task) {
      assert.equal(task, "vehicle_slu");
      throw new ModelProviderError(secretFailureText, {
        code: providerFailureReasonCode,
        provider: "dashscope",
        durationMs: 17,
        externalModelRequestCount: 1,
        details: {
          reasonCode: providerFailureReasonCode,
          errorType: secretFailureText,
        },
      });
    },
  });

  const result = await runVehicleSluSemanticBoundary({
    text: "你好",
    requestId,
    registry,
    now: (() => {
      let value = 100;
      return () => value += 5;
    })(),
  });

  assert.equal(result.reasonCode, "semantic-model-unavailable");
  assert.equal(result.semanticEnvelope, null);
  assert.equal(result.executionDisabled, true);
  assert.equal(result.model, primaryProfile.model);
  assert.equal(result.telemetry.provider, "dashscope");
  assert.equal(result.telemetry.model, primaryProfile.model);
  assert.equal(result.telemetry.providerFailureReasonCode, providerFailureReasonCode);
  assert.equal(result.telemetry.externalModelRequestCount, 1);
  assert.equal(Object.hasOwn(result.telemetry, "fallbackAttempted"), false);
  assert.equal(JSON.stringify(result).includes(secretFailureText), false);
}

{
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const controller = new AbortController();
  controller.abort(new DOMException("user cancelled", "AbortError"));
  const registry = createRegistry({
    primaryGenerate: async () => {
      primaryCalls += 1;
      return providerResult("dashscope", primaryProfile.model);
    },
    fallbackGenerate: async () => {
      fallbackCalls += 1;
      return providerResult("ollama", primaryProfile.fallback.model);
    },
  });

  await assert.rejects(
    registry.generateForTask("cabin_response", { prompt: "cancelled", signal: controller.signal }),
    (error) => error?.code === "user-cancelled",
  );
  assert.equal(primaryCalls, 0, "an already-aborted request must not start the primary provider");
  assert.equal(fallbackCalls, 0, "an already-aborted request must not start fallback");
}

{
  let fallbackCalls = 0;
  const controller = new AbortController();
  const registry = createRegistry({
    primaryGenerate: async () => {
      controller.abort(new DOMException("user cancelled during primary", "AbortError"));
      throw new ModelProviderError("primary ended after cancellation", {
        code: "provider-network-error",
        provider: "dashscope",
        externalModelRequestCount: 1,
        details: { reasonCode: "provider-network-error" },
      });
    },
    fallbackGenerate: async () => {
      fallbackCalls += 1;
      return providerResult("ollama", primaryProfile.fallback.model);
    },
  });

  await assert.rejects(
    registry.generateForTask("cabin_response", {
      prompt: "cancelled during primary",
      signal: controller.signal,
    }),
    (error) => error?.code === "user-cancelled"
      && error?.externalModelRequestCount === 1,
  );
  assert.equal(fallbackCalls, 0, "cancellation after primary start must still prevent fallback");
}

{
  let fallbackCalls = 0;
  const controller = new AbortController();
  const registry = createRegistry({
    primaryGenerate: async () => {
      throw new ModelProviderError("primary unavailable", {
        code: "provider-network-error",
        provider: "dashscope",
        externalModelRequestCount: 1,
        details: { reasonCode: "provider-network-error" },
      });
    },
    fallbackGenerate: async () => {
      fallbackCalls += 1;
      controller.abort(new DOMException("cancel immediately after fallback", "AbortError"));
      return providerResult("ollama", primaryProfile.fallback.model);
    },
  });

  await assert.rejects(
    registry.generateForTask("cabin_response", {
      prompt: "cancel after fallback",
      signal: controller.signal,
    }),
    (error) => error?.code === "user-cancelled"
      && error?.externalModelRequestCount === 2,
  );
  assert.equal(fallbackCalls, 1);
}

{
  let fallbackCalls = 0;
  const registry = createProductionRegistry({
    dashScopeFetch: async () => dashScopeCompletion("", "content_filter"),
    ollamaClient: Object.freeze({
      async generate() {
        fallbackCalls += 1;
        return {
          text: "fallback must not run",
          durationMs: 1,
          finishReason: "stop",
          promptTokens: 1,
          outputTokens: 1,
          providerTelemetry: {},
        };
      },
    }),
  });

  await assert.rejects(
    registry.generateForTask("cabin_response", { prompt: "explicit safety refusal" }),
    (error) => {
      assert.equal(error?.code, "provider-safety-refusal");
      assert.equal(error?.details?.reasonCode, "provider-safety-refusal");
      assert.equal(Object.hasOwn(error, "missingSlots"), false);
      assert.equal(Object.hasOwn(error, "clarificationQuestion"), false);
      return true;
    },
  );
  assert.equal(fallbackCalls, 0, "production safety refusal must not call Ollama fallback");
}

{
  const requestId = "vehicle-slu-production-explicit-watchdog";
  const scheduler = new RecordingScheduler();
  let dashScopeCalls = 0;
  let fallbackCalls = 0;
  let releaseDashScope;
  let markDashScopeStarted;
  let lateJsonReads = 0;
  const dashScopeStarted = new Promise((resolve) => {
    markDashScopeStarted = resolve;
  });
  const registry = createProductionRegistry({
    profile: Object.freeze({ ...primaryProfile, watchdogMs: 25 }),
    dashScopeScheduler: scheduler,
    dashScopeNow: () => 10,
    dashScopeFetch: async () => {
      dashScopeCalls += 1;
      markDashScopeStarted();
      return new Promise((resolve) => {
        releaseDashScope = () => resolve({
          ok: true,
          status: 200,
          async json() {
            lateJsonReads += 1;
            return {
              choices: [{
                message: { content: JSON.stringify({
                  contractVersion: "nio-vehicle-slu-contract@2.0.0",
                  requestId,
                  domain: "non_vehicle",
                  conversationGoal: { summary: "迟到结果", need: "social" },
                  vehicleFrames: [],
                  domainConfidence: 0.99,
                }) },
                finish_reason: "stop",
              }],
            };
          },
        });
      });
    },
    ollamaClient: Object.freeze({
      async generate() {
        fallbackCalls += 1;
        return {
          text: "fallback must not run for generation-timeout",
          durationMs: 1,
          finishReason: "stop",
          promptTokens: 1,
          outputTokens: 1,
          providerTelemetry: {},
        };
      },
    }),
  });

  const pending = runVehicleSluSemanticBoundary({
    text: "你好",
    requestId,
    registry,
    now: () => 20,
  });
  await dashScopeStarted;
  assert.equal(scheduler.scheduled.length, 1,
    "the explicit task watchdog must schedule one Provider timer");
  assert.equal(scheduler.scheduled[0].delayMs, 25);
  scheduler.fire();
  const result = await pending;

  assert.equal(result.reasonCode, "semantic-model-unavailable");
  assert.equal(result.semanticEnvelope, null);
  assert.equal(result.executionDisabled, true);
  assert.equal(Object.hasOwn(result, "clarificationQuestion"), false,
    "a Provider watchdog must not be rewritten as missing parameters");
  assert.equal(result.telemetry.watchdogMs, 25);
  assert.equal(result.telemetry.degraded, true);
  assert.equal(dashScopeCalls, 1);
  assert.equal(fallbackCalls, 0,
    "generation-timeout is not in the fixed fallback allowlist");
  assert.equal(scheduler.cleared.length, 1);

  releaseDashScope();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lateJsonReads, 0,
    "a result arriving after the Provider watchdog must not be consumed");
}

{
  const requestId = "vehicle-slu-production-repair-fallback";
  const validFallbackEnvelope = {
    contractVersion: "nio-vehicle-slu-contract@2.0.0",
    requestId,
    domain: "non_vehicle",
    conversationGoal: { summary: "用户在打招呼", need: "social" },
    vehicleFrames: [],
    domainConfidence: 0.99,
  };
  const dashScopePrompts = [];
  let ollamaCalls = 0;
  const registry = createProductionRegistry({
    dashScopeFetch: async (_url, init) => {
      dashScopePrompts.push(JSON.parse(init.body).messages[0].content);
      return dashScopeCompletion("{\"wrong\":true}");
    },
    ollamaClient: Object.freeze({
      async generate() {
        ollamaCalls += 1;
        return {
          text: JSON.stringify(validFallbackEnvelope),
          durationMs: 13,
          finishReason: "stop",
          promptTokens: 9,
          outputTokens: 6,
          providerTelemetry: { keepAlive: "24h", ollamaDurations: {} },
        };
      },
    }),
  });

  const result = await runVehicleSluSemanticBoundary({
    text: "你好",
    requestId,
    registry,
    now: (() => {
      let value = 100;
      return () => value += 5;
    })(),
  });

  assert.equal(dashScopePrompts.length, 1, "SLU schema failure must not trigger repair");
  assert.equal(ollamaCalls, 0, "SLU schema failure must not trigger fallback");
  assert.equal(result.semanticEnvelope, null);
  assert.equal(result.executionDisabled, true);
  assert.equal(result.reasonCode, "semantic-contract-invalid");
  assert.equal(result.model, primaryProfile.model);
  assert.equal(result.telemetry.provider, "dashscope");
  assert.equal(result.telemetry.fallbackActive, false);
  assert.equal(Object.hasOwn(result.telemetry, "primaryFailureReasonCode"), false);
  assert.equal(result.telemetry.externalModelRequestCount, 1);
}

{
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const registry = createRegistry({
    primaryGenerate: async () => {
      primaryCalls += 1;
      return providerResult("dashscope", primaryProfile.model, "{\"wrong\":true}");
    },
    fallbackGenerate: async () => {
      fallbackCalls += 1;
      return providerResult("ollama", primaryProfile.fallback.model);
    },
  });

  await assert.rejects(
    registry.generateForTask("cabin_response", {
      prompt: "benchmark hard budget",
      externalModelRequestLimit: 1,
      structuredOutput: {
        validate: () => false,
        repairPrompt: ({ prompt }) => `${prompt}\nrepair`,
      },
    }),
    (error) => error?.code === "provider-request-budget-exhausted"
      && error?.externalModelRequestCount === 1,
    "a benchmark request limit must stop before schema repair or fallback consumes a second call",
  );
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 0);
}

{
  let fallbackCalls = 0;
  const registry = createRegistry({
    primaryGenerate: async () => {
      throw new ModelProviderError("primary blocked before transport", {
        code: "provider-config-invalid",
        provider: "dashscope",
        externalModelRequestCount: 0,
        details: { reasonCode: "provider-config-invalid" },
      });
    },
    fallbackGenerate: async () => {
      fallbackCalls += 1;
      return providerResult("ollama", primaryProfile.fallback.model);
    },
  });

  const result = await registry.generateForTask("cabin_response", {
    prompt: "zero-cost primary may use remaining budget",
    externalModelRequestLimit: 1,
  });
  assert.equal(result.externalModelRequestCount, 1);
  assert.equal(result.fallbackActive, true);
  assert.equal(fallbackCalls, 1,
    "a zero-request primary failure may still use the one remaining Provider request");
}

console.log("verify-model-provider-fallback: PASS");
