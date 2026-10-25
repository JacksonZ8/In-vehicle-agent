import assert from "node:assert/strict";
import {
  createOllamaGenerateClient,
} from "../../src/server/model-providers/ollama-generate-client.js";
import {
  createOllamaModelProvider,
} from "../../src/server/model-providers/ollama-model-provider.js";

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
        const rejectAbort = () => reject(capturedSignal.reason instanceof Error
          ? capturedSignal.reason
          : new DOMException("The operation was aborted", "AbortError"));
        if (capturedSignal.aborted) rejectAbort();
        else capturedSignal.addEventListener("abort", rejectAbort, { once: true });
      });
    },
  };
}

async function verifyNormalizedStructuredGeneration() {
  const provider = createOllamaModelProvider({
    model: "qwen2.5:7b",
    client: createOllamaGenerateClient({
      baseUrl: "http://127.0.0.1:11434",
      keepAlive: "24h",
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body);
        assert.equal(request.format.type, "object");
        assert.equal(request.options.temperature, 0);
        return new Response(JSON.stringify({
          response: "{\"ok\":true}",
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 4,
          total_duration: 20_000_000,
        }), { status: 200 });
      },
    }),
  });

  const result = await provider.generate({
    requestId: "ollama-contract",
    task: "b2_goal_formation",
    prompt: "Return JSON",
    outputMode: "json-object",
    jsonSchema: { type: "object" },
    generationProfile: "structured-agent",
    timeoutMs: 100,
  });

  assert.equal(result.text, "{\"ok\":true}");
  assert.equal(result.provider, "ollama");
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 4);
  assert.equal(result.providerTelemetry.ollamaDurations.total_duration_ms, 20);
  assert.equal(result.providerTelemetry.keepAlive, "24h");
  assert.equal(result.externalModelRequestCount, 1,
    "a successful client invocation must count as one external model request");
  assert.equal(Object.isFrozen(provider), true, "provider identity must be immutable");
}

async function verifyExplicitThinkSerialization() {
  const requestBodies = [];
  const client = createOllamaGenerateClient({
    baseUrl: "http://127.0.0.1:11434",
    keepAlive: "24h",
    fetchImpl: async (_url, init) => {
      requestBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ response: "{}" }), { status: 200 });
    },
  });

  await client.generate({
    model: "qwen2.5:3b",
    prompt: "Return JSON",
    timeoutMs: 100,
    format: "json",
    options: { temperature: 0, num_predict: 128 },
    think: false,
  });
  await client.generate({
    model: "qwen2.5:3b",
    prompt: "Return JSON without explicit thinking control",
    timeoutMs: 100,
  });

  assert.equal(requestBodies[0].think, false,
    "an explicit think:false option must be serialized as a top-level Ollama request field");
  assert.equal(Object.hasOwn(requestBodies[1], "think"), false,
    "requests without an explicit think option must not serialize a think field");
}

async function verifyCallerCancellationAbortsUpstream() {
  const pendingFetch = createPendingFetch();
  const provider = createOllamaModelProvider({
    model: "qwen2.5:7b",
    client: createOllamaGenerateClient({
      baseUrl: "http://127.0.0.1:11434",
      keepAlive: "24h",
      fetchImpl: pendingFetch.fetchImpl,
    }),
  });
  const controller = new AbortController();
  const pending = provider.generate({
    prompt: "cancel me",
    timeoutMs: 100,
    signal: controller.signal,
  });
  const upstreamSignal = await pendingFetch.started;
  controller.abort(new DOMException("caller cancelled", "AbortError"));
  await assert.rejects(pending, (error) => error?.name === "AbortError"
    && error?.externalModelRequestCount === 1);
  assert.equal(upstreamSignal.aborted, true, "caller cancellation must abort upstream fetch");
}

async function verifyTimeoutAbortsUpstream() {
  const pendingFetch = createPendingFetch();
  const provider = createOllamaModelProvider({
    model: "qwen2.5:7b",
    client: createOllamaGenerateClient({
      baseUrl: "http://127.0.0.1:11434",
      keepAlive: "24h",
      fetchImpl: pendingFetch.fetchImpl,
    }),
  });
  const pending = provider.generate({ prompt: "time out", timeoutMs: 10 });
  const upstreamSignal = await pendingFetch.started;
  await assert.rejects(pending, (error) => error?.code === "generation-timeout"
    && error?.externalModelRequestCount === 1);
  assert.equal(upstreamSignal.aborted, true, "internal timeout must abort upstream fetch");
}

await verifyNormalizedStructuredGeneration();
await verifyExplicitThinkSerialization();
await verifyCallerCancellationAbortsUpstream();
await verifyTimeoutAbortsUpstream();

console.log("verify-ollama-model-provider: PASS");
