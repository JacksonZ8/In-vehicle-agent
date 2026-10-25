import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  callStructuredAgentGenerate,
  createServer,
} from "../../src/server/local-agent-server.mjs";
import { createRequestAbortScope } from "../../src/server/http/http-io.mjs";
import { fetchOpenMeteoWeather } from "../../src/server/weather/weather-service.mjs";
import { buildManualEvidenceSummary } from "../../src/manual/manual-rag-retriever.js";
import { buildManualVectorEvidenceSummary } from "../../src/manual/manual-rag-vector-retriever.js";
import { createDashScopeModelProvider } from "../../src/server/model-providers/dashscope-model-provider.js";
import { createOllamaGenerateClient } from "../../src/server/model-providers/ollama-generate-client.js";
import { createModelProviderRegistry } from "../../src/server/model-providers/model-provider-registry.js";

class FakeRequest extends EventEmitter {}

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
}

class FakeRouteRequest extends FakeRequest {
  constructor(pathname, body) {
    super();
    this.method = "POST";
    this.url = pathname;
    this.body = JSON.stringify(body);
    this.aborted = false;
    this.destroyed = false;
  }

  send() {
    this.emit("data", Buffer.from(this.body));
    this.emit("end");
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeRouteResponse extends FakeResponse {
  closed = false;
  headersSent = false;
  writeCount = 0;
  chunkWriteCount = 0;
  endCount = 0;

  constructor({ backpressure = false } = {}) {
    super();
    this.backpressure = backpressure;
    this.firstWrite = new Promise((resolve) => {
      this.markFirstWrite = resolve;
    });
  }

  writeHead(statusCode) {
    this.writeCount += 1;
    this.statusCode = statusCode;
    this.headersSent = true;
  }

  write() {
    this.writeCount += 1;
    this.chunkWriteCount += 1;
    this.markFirstWrite();
    return !this.backpressure;
  }

  end(body = "") {
    this.writeCount += 1;
    this.endCount += 1;
    this.rawBody = String(body);
    this.writableEnded = true;
  }

  closePrematurely() {
    this.destroyed = true;
    this.closed = true;
    this.emit("close");
  }
}

class ManualScheduler {
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

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createPendingFetch() {
  let capturedSignal;
  let markStarted;
  let markAborted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  const fetchImpl = async (_url, init = {}) => {
    capturedSignal = init.signal;
    markStarted(capturedSignal);
    return new Promise((_resolve, reject) => {
      const rejectAbort = () => {
        markAborted();
        reject(capturedSignal?.reason instanceof Error
          ? capturedSignal.reason
          : new DOMException("The operation was aborted", "AbortError"));
      };
      if (capturedSignal?.aborted) {
        rejectAbort();
        return;
      }
      capturedSignal?.addEventListener("abort", rejectAbort, { once: true });
    });
  };
  return {
    fetchImpl,
    started,
    aborted,
    get signal() {
      return capturedSignal;
    },
  };
}

function rejectAfter(milliseconds, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds));
}

function createStructuredTestRegistry(fetchImpl, watchdogMs = null) {
  const client = createOllamaGenerateClient({
    baseUrl: "http://127.0.0.1:11434",
    keepAlive: "24h",
    fetchImpl,
  });
  return createModelProviderRegistry({
    taskProfiles: Object.freeze({
      orchestrator_plan: Object.freeze({
        task: "orchestrator_plan",
        provider: "ollama",
        model: "qwen2.5:7b",
        watchdogMs,
      }),
    }),
    connections: Object.freeze({
      ollama: Object.freeze({
        client,
        readiness: Object.freeze({ status: "ready" }),
      }),
    }),
  });
}

function createTaskTestRegistry(task, provider, watchdogMs = null) {
  const requireProvider = (requestedTask) => {
    assert.equal(requestedTask, task, `test registry is missing explicit task ${requestedTask}`);
    return provider;
  };
  return Object.freeze({
    providerFor: requireProvider,
    profileFor(requestedTask) {
      requireProvider(requestedTask);
      return Object.freeze({
        task,
        provider: provider.id,
        model: provider.model,
        watchdogMs,
      });
    },
    generateForTask(requestedTask, request) {
      return requireProvider(requestedTask).generate(request);
    },
    publicProfiles: Object.freeze({}),
  });
}

async function verifyRequestAbortScope() {
  {
    const request = new FakeRequest();
    const response = new FakeResponse();
    const scope = createRequestAbortScope(request, response);
    request.emit("aborted");
    assert.equal(scope.signal.aborted, true, "request aborted must cancel its scope");
    assert.equal(request.listenerCount("aborted"), 0, "aborted listener must be removed after cancellation");
    assert.equal(response.listenerCount("close"), 0, "response close listener must be removed after cancellation");
    scope.dispose();
  }

  {
    const request = new FakeRequest();
    const response = new FakeResponse();
    const scope = createRequestAbortScope(request, response);
    response.emit("close");
    assert.equal(scope.signal.aborted, true, "premature response close must cancel its scope");
  }

  {
    const request = new FakeRequest();
    const response = new FakeResponse();
    response.writableEnded = true;
    const scope = createRequestAbortScope(request, response);
    response.emit("close");
    assert.equal(scope.signal.aborted, false, "normal response close must not cancel completed work");
    scope.dispose();
    assert.equal(request.listenerCount("aborted"), 0);
    assert.equal(response.listenerCount("close"), 0);
  }

  {
    const request = new FakeRequest();
    const response = new FakeResponse();
    const scope = createRequestAbortScope(request, response);
    scope.dispose();
    scope.dispose();
    request.emit("aborted");
    response.emit("close");
    assert.equal(scope.signal.aborted, false, "disposed scopes must ignore later lifecycle events");
    assert.equal(request.listenerCount("aborted"), 0);
    assert.equal(response.listenerCount("close"), 0);
  }
}

async function verifyStructuredFetchSignal() {
  const pendingFetch = createPendingFetch();
  const controller = new AbortController();
  const pending = callStructuredAgentGenerate({
    body: {
      task: "b3_turn_relation",
      currentGoalSummary: "车窗控制",
      rawText: "再开一点",
    },
    prompt: "bounded-test-prompt",
    signal: controller.signal,
    registry: createStructuredTestRegistry(pendingFetch.fetchImpl, 2_000),
  });
  const upstreamSignal = await pendingFetch.started;
  controller.abort(new DOMException("client disconnected", "AbortError"));
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(upstreamSignal.aborted, true, "structured LLM fetch must receive the caller signal");
}

async function verifyStructuredTimeoutStillWinsWithoutCallerAbort() {
  const pendingFetch = createPendingFetch();
  const pending = callStructuredAgentGenerate({
    body: {
      task: "b3_turn_relation",
      currentGoalSummary: "车窗控制",
      rawText: "再开一点",
    },
    prompt: "bounded-timeout-prompt",
    registry: createStructuredTestRegistry(pendingFetch.fetchImpl, 10),
  });
  const upstreamSignal = await pendingFetch.started;
  await assert.rejects(pending, (error) => error?.code === "generation-timeout");
  assert.equal(upstreamSignal.aborted, true, "structured LLM timeout must still abort upstream fetch");
}

async function verifyLateInitialProviderResolutionStopsBeforeProtocol() {
  let calls = 0;
  let textReads = 0;
  let releaseProvider;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const provider = Object.freeze({
    id: "ignores-abort",
    model: "late-model",
    async generate() {
      calls += 1;
      if (calls > 1) {
        return {
          text: "{\"relation\":\"follow-up\",\"reasonCode\":\"same-goal\",\"requiresClarification\":false}",
          provider: "ignores-abort",
          model: "late-model",
          durationMs: 1,
          finishReason: "stop",
          usage: null,
        };
      }
      markStarted();
      return new Promise((resolve) => {
        releaseProvider = () => resolve({
          get text() {
            textReads += 1;
            return "{\"wrong\":true}";
          },
          provider: "ignores-abort",
          model: "late-model",
          durationMs: 1,
          finishReason: "stop",
          usage: null,
        });
      });
    },
  });
  const server = createServer({
    modelProviderRegistry: createTaskTestRegistry("orchestrator_plan", provider),
  });
  const request = new FakeRouteRequest("/api/local-llm", {
    task: "b3_turn_relation",
    currentGoalSummary: "车窗控制",
    rawText: "再开一点",
  });
  const response = new FakeRouteResponse();
  const routePromise = server.listeners("request")[0](request, response);
  request.send();
  await started;
  response.closePrematurely();
  releaseProvider();
  await Promise.race([routePromise, rejectAfter(100, "late initial Provider resolve did not settle")]);
  assert.equal(calls, 1, "late initial output must not enter repair");
  assert.equal(textReads, 0, "late initial output must not be read or validated");
  assert.equal(response.writeCount, 0, "late initial output must not write a response");
}

async function verifyLateRepairProviderResolutionStopsBeforeValidation() {
  let calls = 0;
  let repairTextReads = 0;
  let releaseRepair;
  let markRepairStarted;
  const repairStarted = new Promise((resolve) => {
    markRepairStarted = resolve;
  });
  const provider = Object.freeze({
    id: "ignores-abort",
    model: "late-model",
    async generate() {
      calls += 1;
      if (calls === 1) {
        return {
          text: "{\"wrong\":true}",
          provider: "ignores-abort",
          model: "late-model",
          durationMs: 1,
          finishReason: "stop",
          usage: null,
        };
      }
      markRepairStarted();
      return new Promise((resolve) => {
        releaseRepair = () => resolve({
          get text() {
            repairTextReads += 1;
            return "{\"relation\":\"follow-up\",\"reasonCode\":\"same-goal\",\"requiresClarification\":false}";
          },
          provider: "ignores-abort",
          model: "late-model",
          durationMs: 1,
          finishReason: "stop",
          usage: null,
        });
      });
    },
  });
  const server = createServer({
    modelProviderRegistry: createTaskTestRegistry("orchestrator_plan", provider),
  });
  const request = new FakeRouteRequest("/api/local-llm", {
    task: "b3_turn_relation",
    currentGoalSummary: "车窗控制",
    rawText: "再开一点",
  });
  const response = new FakeRouteResponse();
  const routePromise = server.listeners("request")[0](request, response);
  request.send();
  await repairStarted;
  response.closePrematurely();
  releaseRepair();
  await Promise.race([routePromise, rejectAfter(100, "late repair Provider resolve did not settle")]);
  assert.equal(calls, 2);
  assert.equal(repairTextReads, 0, "late repair output must not be read or validated");
  assert.equal(response.writeCount, 0, "late repair output must not write a response");
}

async function verifyVehicleSluCancellationWinsWatchdogRace() {
  const scheduler = new ManualScheduler();
  let fallbackCalls = 0;
  let capturedRegistryError = null;
  let upstreamSignal;
  let releaseDashScope;
  let markDashScopeStarted;
  let lateJsonReads = 0;
  const dashScopeStarted = new Promise((resolve) => {
    markDashScopeStarted = resolve;
  });
  const taskProfile = Object.freeze({
    task: "vehicle_slu",
    provider: "dashscope",
    model: "qwen3.5-flash",
    fallback: Object.freeze({ provider: "ollama", model: "qwen3:8b" }),
    watchdogMs: 25,
  });
  const coreRegistry = createModelProviderRegistry({
    taskProfiles: Object.freeze({ vehicle_slu: taskProfile }),
    connections: Object.freeze({
      dashscope: Object.freeze({ readiness: Object.freeze({ status: "ready" }) }),
      ollama: Object.freeze({ readiness: Object.freeze({ status: "ready" }) }),
    }),
    providerFactories: Object.freeze({
      dashscope: ({ profile }) => createDashScopeModelProvider({
        apiKey: "race-test-secret",
        baseUrl: "https://example.invalid/compatible-mode/v1",
        model: profile.model,
        scheduler,
        now: () => 10,
        fetchImpl: async (_url, init) => {
          upstreamSignal = init.signal;
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
                      requestId: "watchdog-cancel-race",
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
      }),
      ollama: ({ profile }) => Object.freeze({
        id: "ollama",
        model: profile.model,
        async generate() {
          fallbackCalls += 1;
          throw new Error("fallback must not run after user cancellation");
        },
      }),
    }),
  });
  const recordingRegistry = Object.freeze({
    providerFor: coreRegistry.providerFor,
    profileFor: coreRegistry.profileFor,
    async generateForTask(task, request) {
      try {
        return await coreRegistry.generateForTask(task, request);
      } catch (error) {
        capturedRegistryError = error;
        throw error;
      }
    },
    publicProfiles: coreRegistry.publicProfiles,
  });
  const server = createServer({ modelProviderRegistry: recordingRegistry });
  const request = new FakeRouteRequest("/api/local-semantic", {
    text: "你好",
    requestId: "watchdog-cancel-race",
  });
  const response = new FakeRouteResponse();
  const routePromise = server.listeners("request")[0](request, response);
  request.send();
  await dashScopeStarted;
  assert.equal(scheduler.scheduled.length, 1);
  assert.equal(scheduler.scheduled[0].delayMs, 25);

  scheduler.fire();
  response.closePrematurely();
  await routePromise;

  assert.equal(upstreamSignal.aborted, true);
  assert.equal(capturedRegistryError?.code, "user-cancelled",
    "caller cancellation must win when it becomes observable with the watchdog");
  assert.equal(capturedRegistryError?.externalModelRequestCount, 1,
    "the single started DashScope request must remain honestly counted");
  assert.equal(fallbackCalls, 0, "the cancellation/watchdog race must not start fallback");
  assert.equal(scheduler.cleared.length, 1);
  assert.equal(response.writeCount, 0, "the cancelled route must not write a response");

  releaseDashScope();
  await nextTurn();
  await nextTurn();
  assert.equal(lateJsonReads, 0, "the late Provider response must not be consumed");
  assert.equal(response.writeCount, 0, "the late Provider response must have zero response side effect");
}

async function verifyWeatherFetchSignal() {
  const pendingFetch = createPendingFetch();
  const controller = new AbortController();
  const pending = fetchOpenMeteoWeather("上海明天天气怎么样", {
    fetchImpl: pendingFetch.fetchImpl,
    signal: controller.signal,
  });
  const upstreamSignal = await pendingFetch.started;
  controller.abort(new DOMException("client disconnected", "AbortError"));
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(upstreamSignal.aborted, true, "weather fetch must receive the caller signal");
}

async function verifyManualRagFetchSignal() {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "nio-manual-abort-"));
  try {
    const chunksPath = path.join(fixtureDir, "chunks.jsonl");
    const embeddingsPath = path.join(fixtureDir, "embeddings.jsonl");
    await writeFile(chunksPath, `${JSON.stringify({
      chunkId: "chunk-1",
      corpusId: "nio-es8-user-manual-2026",
      text: "主驾车窗控制说明",
      pageStart: 1,
      pageEnd: 1,
      category: "body",
      tags: ["车窗"],
    })}\n`);
    await writeFile(embeddingsPath, `${JSON.stringify({
      chunkId: "chunk-1",
      embeddingModel: "test-embedding",
      dimensions: 2,
      embedding: [1, 0],
    })}\n`);

    const pendingFetch = createPendingFetch();
    const controller = new AbortController();
    const pending = buildManualVectorEvidenceSummary("ES8 主驾车窗怎么控制", {
      corpusId: "nio-es8-user-manual-2026",
      vehicleModel: "ES8",
      chunksPath,
      embeddingsPath,
      embeddingModel: "test-embedding",
      fetchImpl: pendingFetch.fetchImpl,
      signal: controller.signal,
    });
    const upstreamSignal = await pendingFetch.started;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    await assert.rejects(pending, (error) => error?.name === "AbortError");
    assert.equal(upstreamSignal.aborted, true, "Manual RAG embedding fetch must receive the caller signal");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function verifyManualRagReportsKeywordFallbackFailure() {
  let keywordReadCount = 0;
  const vectorError = new Error("forced vector embedding failure");
  vectorError.telemetry = {
    retrievalMode: "vector-bge-m3",
    embeddingStatus: "unavailable",
    reason: "embedding-unavailable",
  };
  const server = createServer({
    manualRagOptions: {
      buildVectorEvidenceSummary: async () => { throw vectorError; },
      readFileImpl: async () => {
        keywordReadCount += 1;
        throw new Error("forced keyword retrieval failure");
      },
      runIdFactory: () => "route-unavailable",
    },
  });
  const request = new FakeRouteRequest("/api/manual-rag", {
    query: "ES8 主驾车窗怎么控制",
    vehicleModel: "ES8",
    corpusId: "nio-es8-user-manual-2026",
    topK: 1,
  });
  const response = new FakeRouteResponse();
  const routePromise = server.listeners("request")[0](request, response);
  request.send();
  await routePromise;
  const body = JSON.parse(response.rawBody);
  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "unavailable");
  assert.equal(body.reason, "embedding-unavailable");
  assert.deepEqual(body.evidence, []);
  assert.equal(keywordReadCount, 1, "keyword fallback must run once after vector retrieval fails");
  assert.equal(body.telemetry.retrievalMode, "unavailable");
  assert.equal(body.telemetry.primaryRetrievalReason, "embedding-unavailable");
  assert.equal(body.telemetry.keywordFallbackStatus, "unavailable");
  assert.equal(body.telemetry.keywordFallbackReason, "keyword-retrieval-unavailable");
}

async function verifyKeywordManualRagPreservesAbortError() {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "nio-keyword-abort-error-"));
  let markReadStarted;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  try {
    const controller = new AbortController();
    const pending = buildManualEvidenceSummary("ES8 主驾车窗怎么控制", {
      corpusId: "nio-es8-user-manual-2026",
      vehicleModel: "ES8",
      chunksPath: path.join(fixtureDir, "unique-chunks.jsonl"),
      signal: controller.signal,
      readFileImpl: async (_filePath, options = {}) => {
        markReadStarted(options.signal);
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    });
    const readSignal = await readStarted;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    await assert.rejects(pending, (error) => error?.name === "AbortError");
    assert.equal(readSignal.aborted, true);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function postAndDisconnect(server, pathname, body, pendingFetch) {
  const request = new FakeRouteRequest(pathname, body);
  const response = new FakeRouteResponse();
  const routeHandler = server.listeners("request")[0];
  const routePromise = routeHandler(request, response);
  request.send();
  const upstreamSignal = await pendingFetch.started;
  response.closePrematurely();
  await pendingFetch.aborted;
  await nextTurn();
  await nextTurn();
  await routePromise;
  return { upstreamSignal, response };
}

async function verifyStreamingBackpressureCancellation() {
  const originalFetch = globalThis.fetch;
  const server = createServer();
  let upstreamSignal;
  globalThis.fetch = async (_url, init = {}) => {
    upstreamSignal = init.signal;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/wav" }),
      body: {
        getReader() {
          return {
            read: async () => ({ done: false, value: new Uint8Array([1, 2, 3, 4]) }),
          };
        },
      },
    };
  };

  try {
    const request = new FakeRouteRequest("/api/tts-streaming-poc", {
      text: "流式背压取消验证",
    });
    const response = new FakeRouteResponse({ backpressure: true });
    const routeHandler = server.listeners("request")[0];
    const routePromise = routeHandler(request, response);
    request.send();
    await Promise.race([
      response.firstWrite,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("streaming route did not forward its first upstream chunk")),
        100,
      )),
    ]);
    response.closePrematurely();
    await Promise.race([
      routePromise,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("streaming route did not finish after cancellation during backpressure")),
        100,
      )),
    ]);
    assert.equal(upstreamSignal.aborted, true, "backpressured streaming fetch must be aborted");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyStreamingFinalReadCloseRace() {
  const originalFetch = globalThis.fetch;
  const server = createServer();
  let upstreamSignal;
  let releaseFinalRead;
  let markFinalReadStarted;
  const finalReadStarted = new Promise((resolve) => {
    markFinalReadStarted = resolve;
  });
  const finalRead = new Promise((resolve) => {
    releaseFinalRead = resolve;
  });
  globalThis.fetch = async (_url, init = {}) => {
    upstreamSignal = init.signal;
    let readCount = 0;
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "audio/wav" }),
      body: {
        getReader() {
          return {
            async read() {
              readCount += 1;
              if (readCount === 1) {
                return { done: false, value: new Uint8Array([1, 2, 3, 4]) };
              }
              markFinalReadStarted();
              return finalRead;
            },
          };
        },
      },
    };
  };

  try {
    const request = new FakeRouteRequest("/api/tts-streaming-poc", {
      text: "流式最终读取取消验证",
    });
    const response = new FakeRouteResponse();
    const routePromise = server.listeners("request")[0](request, response);
    request.send();
    await Promise.race([
      finalReadStarted,
      rejectAfter(100, "streaming route did not enter delayed final read"),
    ]);
    assert.equal(response.chunkWriteCount, 1, "first streaming chunk must be forwarded before close");
    const writeCountBeforeClose = response.writeCount;
    response.closePrematurely();
    releaseFinalRead({ done: true });
    await Promise.race([
      routePromise,
      rejectAfter(100, "streaming route did not finish after delayed EOF cancellation"),
    ]);
    assert.equal(upstreamSignal.aborted, true, "final-read close must abort upstream signal");
    assert.equal(response.endCount, 0, "closed streaming response must not be ended after delayed EOF");
    assert.equal(response.writeCount, writeCountBeforeClose, "closed streaming response must receive no extra writes");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyReadBodyCancellationCleanup() {
  const server = createServer();
  const request = new FakeRouteRequest("/api/local-semantic", {
    text: "尚未发送完成的请求",
  });
  const response = new FakeRouteResponse();
  const routePromise = server.listeners("request")[0](request, response);
  assert.equal(request.listenerCount("data"), 1);
  assert.equal(request.listenerCount("end"), 1);
  assert.equal(request.listenerCount("error"), 1);
  assert.equal(request.listenerCount("aborted"), 1);
  request.aborted = true;
  request.emit("aborted");
  await Promise.race([
    routePromise,
    rejectAfter(100, "readBody did not stop when request aborted before end"),
  ]);
  assert.equal(request.listenerCount("data"), 0);
  assert.equal(request.listenerCount("end"), 0);
  assert.equal(request.listenerCount("error"), 0);
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.writeCount, 0);
}

async function verifyRealPostRoutesAndClosedResponseWrites() {
  const originalFetch = globalThis.fetch;
  try {
    const routeCases = [
      {
        pathname: "/api/local-semantic",
        body: { text: "给我讲个笑话", requestId: "verify-abort-semantic" },
        label: "semantic",
      },
      {
        pathname: "/api/local-llm",
        body: {
          task: "b3_turn_relation",
          currentGoalSummary: "车窗控制",
          rawText: "再开一点",
        },
        label: "structured LLM",
      },
      {
        pathname: "/api/weather",
        body: { query: "上海明天天气怎么样" },
        label: "weather",
      },
      {
        pathname: "/api/manual-rag",
        body: {
          query: "ES8 主驾车窗怎么控制",
          vehicleModel: "ES8",
          corpusId: "nio-es8-user-manual-2026",
          topK: 1,
        },
        label: "Manual RAG",
      },
      {
        pathname: "/api/tts",
        body: { text: "取消语音验证" },
        label: "TTS",
      },
      {
        pathname: "/api/tts-streaming-poc",
        body: { text: "取消流式语音验证" },
        label: "streaming TTS",
      },
    ];

    for (const item of routeCases) {
      const pendingFetch = createPendingFetch();
      globalThis.fetch = pendingFetch.fetchImpl;
      const server = item.label === "structured LLM"
        ? createServer({ modelProviderRegistry: createStructuredTestRegistry(pendingFetch.fetchImpl) })
        : createServer();
      const { upstreamSignal, response } = await postAndDisconnect(
        server,
        item.pathname,
        item.body,
        pendingFetch,
      );
      assert.equal(upstreamSignal.aborted, true, `${item.label} route must abort upstream fetch`);
      assert.equal(response.writeCount, 0, `${item.label} must not write after the response is destroyed`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await verifyRequestAbortScope();
await verifyStructuredFetchSignal();
await verifyStructuredTimeoutStillWinsWithoutCallerAbort();
await verifyLateInitialProviderResolutionStopsBeforeProtocol();
await verifyLateRepairProviderResolutionStopsBeforeValidation();
await verifyVehicleSluCancellationWinsWatchdogRace();
await verifyWeatherFetchSignal();
await verifyManualRagFetchSignal();
await verifyManualRagReportsKeywordFallbackFailure();
await verifyKeywordManualRagPreservesAbortError();
await verifyRealPostRoutesAndClosedResponseWrites();
await verifyStreamingBackpressureCancellation();
await verifyStreamingFinalReadCloseRace();
await verifyReadBodyCancellationCleanup();

console.log(JSON.stringify({
  requestAbortScope: true,
  structuredSignal: true,
  structuredTimeoutPreserved: true,
  lateInitialProviderResolutionStopped: true,
  lateRepairProviderResolutionStopped: true,
  vehicleSluCancellationWinsWatchdogRace: true,
  weatherSignal: true,
  manualRagSignal: true,
  manualRagKeywordFallbackFailureReported: true,
  keywordManualRagAbortError: true,
  semanticRouteSignal: true,
  ttsRouteSignal: true,
  streamingTtsRouteSignal: true,
  streamingBackpressureCancellation: true,
  streamingFinalReadCloseRace: true,
  readBodyCancellationCleanup: true,
  closedResponsesReceiveNoWrites: true,
}, null, 2));
