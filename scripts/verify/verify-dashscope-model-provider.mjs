import assert from "node:assert/strict";
import {
  createDashScopeModelProvider,
} from "../../src/server/model-providers/dashscope-model-provider.js";

const API_KEY = "fake-secret-for-test";
const BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL = "qwen-plus-2025-12-01";
const SECRET_UPSTREAM_BODY = `upstream failed with ${API_KEY}`;

function createProvider(fetchImpl, now = (() => {
  let value = 100;
  return () => value += 25;
})(), scheduler) {
  return createDashScopeModelProvider({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    model: MODEL,
    fetchImpl,
    now,
    scheduler,
  });
}

function completeResponse(content = "{\"status\":\"ok\"}") {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function createPendingFetch() {
  let capturedSignal;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });

  return {
    started,
    fetchImpl: async (_url, init = {}) => {
      capturedSignal = init.signal;
      markStarted(capturedSignal);
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
        if (capturedSignal.aborted) rejectAbort();
        else capturedSignal.addEventListener("abort", rejectAbort, { once: true });
      });
    },
  };
}

function createDelayedJsonResponse() {
  let markJsonStarted;
  const jsonStarted = new Promise((resolve) => {
    markJsonStarted = resolve;
  });

  return {
    jsonStarted,
    response: {
      ok: true,
      status: 200,
      json: async () => {
        markJsonStarted();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          choices: [{ message: { content: "delayed response" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
        };
      },
    },
  };
}

async function assertSafeProviderError(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.provider, "dashscope");
    for (const value of [error.message, JSON.stringify(error), JSON.stringify(error.details)]) {
      assert.equal(value.includes(API_KEY), false, "provider errors must not expose upstream secrets");
    }
    return true;
  });
}

async function verifyJsonRequestShapeAndCleanup() {
  let captured;
  const controller = new AbortController();
  let removedListeners = 0;
  const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = (...args) => {
    removedListeners += 1;
    return removeEventListener(...args);
  };
  const provider = createProvider(async (url, init) => {
    captured = { url: String(url), init };
    return completeResponse();
  });

  const result = await provider.generate({
    requestId: "dashscope-json",
    task: "b2_goal_formation",
    prompt: "Return JSON for the GoalEnvelope contract.",
    outputMode: "json-object",
    jsonSchema: { type: "object" },
    generationProfile: "structured-agent",
    watchdogMs: 12_000,
    signal: controller.signal,
  });

  const body = JSON.parse(captured.init.body);
  assert.equal(captured.url, `${BASE_URL}/chat/completions`);
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(captured.init.signal instanceof AbortSignal, true, "fetch must receive an AbortSignal");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.enable_thinking, false);
  assert.equal(Object.hasOwn(body, "max_tokens"), false);
  assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
  assert.equal(JSON.stringify(body).includes(API_KEY), false);
  assert.equal(result.usage.totalTokens, 16);
  assert.equal(result.usage.inputTokens, 11);
  assert.equal(result.usage.outputTokens, 5);
  assert.equal(result.durationMs, 25);
  assert.equal(Object.isFrozen(provider), true, "provider identity must be immutable");
  assert.ok(removedListeners > 0, "abort listeners must be disposed after completion");
}

async function verifyTextProfilesUseOnlyAllowedTokenLimit() {
  for (const [generationProfile, maxCompletionTokens] of [
    ["compact-conversation", 24],
    ["weather-composer", 96],
  ]) {
    let request;
    const provider = createProvider(async (_url, init) => {
      request = JSON.parse(init.body);
      return completeResponse("text response");
    });

    await provider.generate({ prompt: "short response", generationProfile, watchdogMs: 12_000 });
    assert.equal(request.max_completion_tokens, maxCompletionTokens);
    assert.equal(Object.hasOwn(request, "max_tokens"), false);
    assert.equal(Object.hasOwn(request, "response_format"), false);
  }
}

async function verifyVehicleKnowledgeSynthesisUsesBoundedJsonOutput() {
  let request;
  const provider = createProvider(async (_url, init) => {
    request = JSON.parse(init.body);
    return completeResponse();
  });

  await provider.generate({
    task: "b3_vehicle_knowledge_synthesis",
    prompt: "Return a bounded KnowledgeAnswer JSON object.",
    outputMode: "json-object",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["outcomeStatus", "supportStatus", "answer", "limitations", "degraded"],
      properties: {
        outcomeStatus: { type: "string", const: "answered" },
        supportStatus: { type: "string", enum: ["supported", "partial", "unsupported"] },
        answer: { type: "string", minLength: 1 },
        limitations: { type: "array", items: { type: "string" } },
        degraded: { type: "boolean" },
      },
    },
    generationProfile: "structured-agent",
    watchdogMs: 12_000,
  });
  assert.deepEqual(request.response_format, { type: "json_object" });
  assert.equal(request.max_completion_tokens, 768);
  assert.equal(Object.hasOwn(request, "max_tokens"), false);
}

async function verifyQwen38KnowledgeSynthesisUsesStrictJsonSchema() {
  let request;
  const provider = createDashScopeModelProvider({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    model: "qwen3.8-flash",
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return completeResponse();
    },
  });
  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["outcomeStatus", "supportStatus", "answer", "limitations", "degraded"],
    properties: {
      outcomeStatus: { type: "string", const: "answered" },
      supportStatus: { type: "string", enum: ["supported", "partial", "unsupported"] },
      answer: { type: "string", minLength: 1 },
      limitations: { type: "array", items: { type: "string" } },
      degraded: { type: "boolean" },
    },
  };

  await provider.generate({
    task: "b3_vehicle_knowledge_synthesis",
    prompt: "Return a KnowledgeAnswerDraft.",
    outputMode: "json-object",
    jsonSchema,
    generationProfile: "structured-agent",
    watchdogMs: 12_000,
  });

  assert.deepEqual(request.response_format, {
    type: "json_schema",
    json_schema: {
      name: "knowledge_answer_draft",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["outcomeStatus", "supportStatus", "answer", "limitations", "degraded"],
        properties: {
          outcomeStatus: { type: "string", enum: ["answered"] },
          supportStatus: { type: "string", enum: ["supported", "partial", "unsupported"] },
          answer: { type: "string" },
          limitations: { type: "array", items: { type: "string" } },
          degraded: { type: "boolean" },
        },
      },
    },
  });
  assert.equal(Object.hasOwn(request, "max_completion_tokens"), false);
}

async function verifyStatusAndUpstreamFailuresAreSanitized() {
  for (const [status, code] of [
    [400, "provider-invalid-request"],
    [401, "provider-auth-failed"],
    [403, "provider-auth-failed"],
    [422, "provider-invalid-request"],
    [429, "provider-rate-limited"],
    [500, "provider-unavailable"],
  ]) {
    const provider = createProvider(async () => new Response(SECRET_UPSTREAM_BODY, { status }));
    await assertSafeProviderError(
      () => provider.generate({ prompt: "do not expose this prompt", watchdogMs: 12_000 }),
      code,
    );
  }

  const networkProvider = createProvider(async () => {
    throw new Error(SECRET_UPSTREAM_BODY);
  });
  await assertSafeProviderError(
    () => networkProvider.generate({ prompt: "do not expose this prompt", watchdogMs: 12_000 }),
    "provider-network-error",
  );
}

async function verifyInvalidResponseIsNormalizedAndSanitized() {
  for (const response of [
    new Response("not-json", { status: 200 }),
    new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 }),
    completeResponse("   "),
  ]) {
    const provider = createProvider(async () => response);
    await assertSafeProviderError(
      () => provider.generate({ prompt: "do not expose this prompt", watchdogMs: 12_000 }),
      "provider-response-invalid",
    );
  }
}

async function verifyExplicitSafetyRefusalIsSanitized() {
  const secretRefusalBody = JSON.stringify({
    error: {
      code: "content_filter",
      type: "safety_refusal",
      message: `do not expose ${API_KEY}`,
    },
  });
  const httpProvider = createProvider(async () => new Response(secretRefusalBody, {
    status: 400,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(
    httpProvider.generate({ prompt: "explicit HTTP refusal", watchdogMs: 12_000 }),
    (error) => {
      assert.equal(error?.code, "provider-safety-refusal");
      assert.equal(error?.details?.reasonCode, "provider-safety-refusal");
      assert.equal(JSON.stringify(error).includes(secretRefusalBody), false);
      assert.equal(JSON.stringify(error).includes(API_KEY), false);
      return true;
    },
  );

  const completionProvider = createProvider(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
    usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await assertSafeProviderError(
    () => completionProvider.generate({ prompt: "completion refusal", watchdogMs: 12_000 }),
    "provider-safety-refusal",
  );

  const ordinaryText = "I cannot infer policy from ordinary natural-language text.";
  const ordinaryProvider = createProvider(async () => completeResponse(ordinaryText));
  const ordinaryResult = await ordinaryProvider.generate({
    prompt: "ordinary text",
    watchdogMs: 12_000,
  });
  assert.equal(ordinaryResult.text, ordinaryText,
    "ordinary completion text must not be guessed as a safety refusal");

  const unknownCodeProvider = createProvider(async () => new Response(JSON.stringify({
    error: { code: "invalid_request", message: "safety words alone are not a signal" },
  }), { status: 400, headers: { "content-type": "application/json" } }));
  await assertSafeProviderError(
    () => unknownCodeProvider.generate({ prompt: "unknown error", watchdogMs: 12_000 }),
    "provider-invalid-request",
  );
}

async function verifyInternalTimeoutAbortsFetch() {
  const pendingFetch = createPendingFetch();
  const provider = createProvider(pendingFetch.fetchImpl);
  const pending = provider.generate({ prompt: "time out", watchdogMs: 10 });
  const upstreamSignal = await pendingFetch.started;

  await assertSafeProviderError(() => pending, "generation-timeout");
  assert.equal(upstreamSignal.aborted, true, "internal timeout must abort upstream fetch");
}

async function verifyExternalCancellationWinsAndAbortsFetch() {
  const pendingFetch = createPendingFetch();
  const provider = createProvider(pendingFetch.fetchImpl);
  const controller = new AbortController();
  const pending = provider.generate({
    prompt: "cancel me",
    watchdogMs: 100,
    signal: controller.signal,
  });
  const upstreamSignal = await pendingFetch.started;
  controller.abort(new DOMException("caller cancelled", "AbortError"));

  await assertSafeProviderError(() => pending, "cancelled");
  assert.equal(upstreamSignal.aborted, true, "external cancellation must abort upstream fetch");
}

async function verifySameTickCancellationPreventsFetchAttempt() {
  let fetchCalls = 0;
  const provider = createProvider(async () => {
    fetchCalls += 1;
    return completeResponse();
  });
  const controller = new AbortController();
  const pending = provider.generate({
    prompt: "cancel before fetch starts",
    watchdogMs: 100,
    signal: controller.signal,
  });
  controller.abort(new DOMException("caller cancelled", "AbortError"));

  await assert.rejects(pending, (error) => {
    assert.equal(error?.code, "cancelled");
    assert.equal(error?.externalModelRequestCount, 0,
      "same-tick cancellation before fetch must report zero external requests");
    return true;
  });
  assert.equal(fetchCalls, 0, "same-tick cancellation must prevent the queued fetch attempt");
}

async function verifyInternalTimeoutInterruptsResponseParsing() {
  const delayed = createDelayedJsonResponse();
  const provider = createProvider(async () => delayed.response);
  const pending = provider.generate({ prompt: "time out during response parsing", watchdogMs: 5 });
  await delayed.jsonStarted;

  await assertSafeProviderError(() => pending, "generation-timeout");
}

async function verifyExternalCancellationInterruptsResponseParsing() {
  const delayed = createDelayedJsonResponse();
  const provider = createProvider(async () => delayed.response);
  const controller = new AbortController();
  const pending = provider.generate({
    prompt: "cancel during response parsing",
    watchdogMs: 100,
    signal: controller.signal,
  });
  await delayed.jsonStarted;
  controller.abort(new DOMException("caller cancelled", "AbortError"));

  await assertSafeProviderError(() => pending, "cancelled");
}

async function verifyWatchdogIsOnlyCreatedForExplicitPositiveInteger() {
  const scheduled = [];
  const cleared = [];
  const scheduler = {
    setTimeout(callback, milliseconds) {
      const handle = { callback, milliseconds };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
  };
  const provider = createProvider(async () => completeResponse(), undefined, scheduler);

  await provider.generate({ prompt: "no watchdog", watchdogMs: null });
  assert.equal(scheduled.length, 0, "null watchdog must not create a timer");
  assert.equal(cleared.length, 0, "null watchdog must not clear a timer that never existed");

  await provider.generate({ prompt: "explicit watchdog", watchdogMs: 3210 });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].milliseconds, 3210);
  assert.deepEqual(cleared, [scheduled[0]], "explicit watchdog timer must be cleaned up");
}

await verifyJsonRequestShapeAndCleanup();
await verifyTextProfilesUseOnlyAllowedTokenLimit();
await verifyVehicleKnowledgeSynthesisUsesBoundedJsonOutput();
await verifyQwen38KnowledgeSynthesisUsesStrictJsonSchema();
await verifyStatusAndUpstreamFailuresAreSanitized();
await verifyInvalidResponseIsNormalizedAndSanitized();
await verifyExplicitSafetyRefusalIsSanitized();
await verifyInternalTimeoutAbortsFetch();
await verifyExternalCancellationWinsAndAbortsFetch();
await verifySameTickCancellationPreventsFetchAttempt();
await verifyInternalTimeoutInterruptsResponseParsing();
await verifyExternalCancellationInterruptsResponseParsing();
await verifyWatchdogIsOnlyCreatedForExplicitPositiveInteger();

console.log("verify-dashscope-model-provider: PASS");
