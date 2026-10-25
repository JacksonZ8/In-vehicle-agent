import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { createDashScopeModelProvider } from "../../src/server/model-providers/dashscope-model-provider.js";
import {
  ModelProviderError,
  normalizeModelProviderResult,
} from "../../src/server/model-providers/model-provider-contract.js";
import { resolveModelProviderConnections } from "../../src/server/model-providers/model-provider-config.js";
import {
  createPublicModelTaskProfileSet,
  resolveModelTaskProfiles,
} from "../../src/server/model-providers/model-task-profile.js";
import { buildOllamaDurations } from "../../src/server/model-providers/ollama-generate-client.js";

const root = new URL("../../", import.meta.url);
const fakeSecret = "fake-secret-for-test";
const fakeUpstreamBody = "fake-upstream-body";
const rawPromptMarker = "private-raw-prompt-marker";
const rawOutputMarker = "private-raw-output-marker";

const browserPaths = Object.freeze([
  "src/app/app.js",
  "src/app/model-provider-profile.js",
  "src/runtime/cloud-llm-adapter.js",
]);
const browserSources = await Promise.all(browserPaths.map(async (path) => ({
  path,
  source: await readFile(new URL(path, root), "utf8"),
})));
for (const { path, source } of browserSources) {
  for (const serverOnlyToken of ["DASHSCOPE_API_KEY", "NIO_DASHSCOPE_BASE_URL"]) {
    assert.equal(
      source.toLowerCase().includes(serverOnlyToken.toLowerCase()),
      false,
      `${path} must not contain server-only ${serverOnlyToken}`,
    );
  }
  assert.doesNotMatch(
    source,
    /["']authorization["']\s*:|(?:^|[{,]\s*)authorization\s*:|\bauthorization\s*:\s*(?:`Bearer\b|["']Bearer\b)|\bBearer\s+[A-Za-z0-9_-]+/im,
    `${path} must not build an Authorization header or bearer credential`,
  );
}

const resolvedTaskProfiles = resolveModelTaskProfiles({
  NIO_LLM_PROVIDER: "ollama",
  NIO_LLM_MODEL: "qwen3:8b",
  NIO_VEHICLE_SLU_PROFILE: "cloud-dashscope",
  NIO_VEHICLE_SLU_PROVIDER: "dashscope",
  NIO_VEHICLE_SLU_MODEL: "qwen3.5-flash",
});
const resolvedConnections = resolveModelProviderConnections({
  DASHSCOPE_API_KEY: fakeSecret,
}, {
  ollamaClient: Object.freeze({ async generate() { return Object.freeze({ response: "ok" }); } }),
});
const taskProfiles = structuredClone(resolvedTaskProfiles);
const connections = {
  ollama: { ...resolvedConnections.ollama },
  dashscope: {
    ...resolvedConnections.dashscope,
    apiKey: resolvedConnections.dashscope.apiKey,
    authorization: `Bearer ${fakeSecret}`,
    rawError: { message: fakeSecret },
  },
};
taskProfiles.vehicle_slu.baseUrl = "https://user:password@example.invalid/compatible-mode/v1";
taskProfiles.vehicle_slu.rawOutput = rawOutputMarker;
taskProfiles.cabin_response.fallback.baseUrl = "http://127.0.0.1:11434";
const publicProfile = createPublicModelTaskProfileSet(taskProfiles, connections);
const publicProfileJson = JSON.stringify(publicProfile);
assert.equal(publicProfileJson.includes(fakeSecret), false);
assert.equal(publicProfileJson.includes("user:password"), false);
assert.equal(Object.hasOwn(publicProfile.tasks.cabin_response, "fallback"), false,
  "public task profiles must expose only fallbackConfigured, never fallback provider/model");
assert.equal(publicProfileJson.includes(rawOutputMarker), false);
assert.equal(publicProfile.schemaVersion, 3);
assert.deepEqual(publicProfile.tasks.vehicle_slu, {
  provider: "dashscope",
  model: "qwen3.5-flash",
  mode: "non-thinking",
  schemaVersion: "nio-vehicle-slu-contract@2.0.0",
  fallbackConfigured: false,
  watchdogMs: null,
  primaryReadiness: { status: "ready" },
  readiness: { status: "ready" },
});
assert.deepEqual(publicProfile.tasks.asr_realtime, {
  provider: null,
  model: null,
  mode: null,
  schemaVersion: null,
  fallbackConfigured: false,
  watchdogMs: null,
  primaryReadiness: { status: "ready" },
  readiness: { status: "ready" },
});
assert.deepEqual(Object.keys(publicProfile.tasks).sort(), [
  "asr_realtime",
  "cabin_response",
  "knowledge_answer",
  "orchestrator_plan",
  "rag_rerank",
  "tts_realtime",
  "vehicle_slu",
]);
for (const profile of Object.values(publicProfile.tasks)) {
  assert.deepEqual(Object.keys(profile).sort(), [
    "fallbackConfigured",
    "mode",
    "model",
    "primaryReadiness",
    "provider",
    "readiness",
    "schemaVersion",
    "watchdogMs",
  ]);
}

const failingProvider = createDashScopeModelProvider({
  apiKey: fakeSecret,
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-plus-2025-12-01",
  fetchImpl: async () => new Response(fakeUpstreamBody, { status: 500 }),
});
let sanitizedErrorJson = "";
try {
  await failingProvider.generate({
    prompt: "Return bounded test text",
    outputMode: "text",
    generationProfile: "default",
    watchdogMs: 100,
  });
  assert.fail("fake upstream failure must reject");
} catch (error) {
  sanitizedErrorJson = JSON.stringify(error);
  assert.equal(error.externalModelRequestCount, 1,
    "a failed DashScope upstream fetch must expose exactly one safe numeric call count");
}
assert.equal(sanitizedErrorJson.includes(fakeUpstreamBody), false);
assert.equal(sanitizedErrorJson.includes(fakeSecret), false);

const maliciousTelemetryInput = {
  total_duration: 20_000_000,
  load_duration: 3_000_000,
  prompt_eval_duration: 4_000_000,
  eval_duration: 5_000_000,
  prompt_eval_count: 11,
  eval_count: 7,
  apiKey: fakeSecret,
  authorization: `Bearer ${fakeSecret}`,
  rawPrompt: rawPromptMarker,
  rawOutput: rawOutputMarker,
  upstreamBody: fakeUpstreamBody,
  response: { raw: fakeUpstreamBody },
};
const providerTelemetryJson = JSON.stringify({
  normalized: normalizeModelProviderResult({
    text: "ok",
    provider: "ollama",
    model: "qwen2.5:7b",
    durationMs: 20,
    finishReason: "stop",
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    ...maliciousTelemetryInput,
  }),
  ollamaDurations: buildOllamaDurations(maliciousTelemetryInput),
});
for (const forbidden of [
  fakeSecret,
  fakeUpstreamBody,
  "apiKey",
  "authorization",
  "rawPrompt",
  "rawOutput",
  "upstreamBody",
]) {
  assert.equal(providerTelemetryJson.toLowerCase().includes(forbidden.toLowerCase()), false);
}

class FakeRequest extends EventEmitter {
  constructor({ method, url, body = null }) {
    super();
    this.method = method;
    this.url = url;
    this.body = body == null ? null : JSON.stringify(body);
    this.aborted = false;
    this.destroyed = false;
  }

  send() {
    if (this.body != null) this.emit("data", Buffer.from(this.body));
    this.emit("end");
  }
}

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  closed = false;
  headersSent = false;
  status = null;
  headers = {};
  rawBody = "";

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }

  end(body = "") {
    this.rawBody = String(body);
    this.writableEnded = true;
  }
}

async function requestServer(server, requestOptions) {
  const request = new FakeRequest(requestOptions);
  const response = new FakeResponse();
  const pending = server.listeners("request")[0](request, response);
  request.send();
  await pending;
  return response;
}

const previousProviderId = process.env.NIO_LLM_PROVIDER;
process.env.NIO_LLM_PROVIDER = "ollama";
const { createServer } = await import("../../src/server/local-agent-server.mjs");
if (previousProviderId === undefined) delete process.env.NIO_LLM_PROVIDER;
else process.env.NIO_LLM_PROVIDER = previousProviderId;

const safePublicProfile = publicProfile;
const maliciousProvider = Object.freeze({
  id: "dashscope",
  model: "qwen-plus-2025-12-01",
  async generate(request) {
    return {
      text: request?.task === "b3_turn_relation"
        ? JSON.stringify({
            relation: "follow-up",
            reasonCode: "bounded-safe-relation",
            requiresClarification: false,
          })
        : "bounded safe answer",
      provider: "dashscope",
      model: "qwen-plus-2025-12-01",
      durationMs: 5,
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedInputTokens: 0 },
      externalModelRequestCount: 1,
      providerTelemetry: {
        ...maliciousTelemetryInput,
        keepAlive: maliciousTelemetryInput,
        ollamaDurations: maliciousTelemetryInput,
      },
    };
  },
});
const taskProviders = Object.freeze({
  orchestrator_plan: maliciousProvider,
  cabin_response: maliciousProvider,
  knowledge_answer: maliciousProvider,
});
const requireTaskProvider = (task) => {
  const provider = taskProviders[task];
  assert.ok(provider, `secret-boundary registry is missing explicit task ${task}`);
  return provider;
};
const maliciousRegistry = Object.freeze({
  providerFor: requireTaskProvider,
  profileFor(task) {
    const provider = requireTaskProvider(task);
    return Object.freeze({
      task,
      provider: provider.id,
      model: provider.model,
      watchdogMs: null,
    });
  },
  generateForTask(task, request) {
    return requireTaskProvider(task).generate(request);
  },
  publicProfiles: safePublicProfile,
  connections: Object.freeze({
    dashscope: Object.freeze({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: fakeSecret,
      authorization: `Bearer ${fakeSecret}`,
      rawPrompt: rawPromptMarker,
      rawOutput: rawOutputMarker,
      upstreamBody: fakeUpstreamBody,
    }),
  }),
  response: { raw: fakeUpstreamBody },
});
const inProcessServer = createServer({ modelProviderRegistry: maliciousRegistry });
const profileResponse = await requestServer(inProcessServer, {
  method: "GET",
  url: "/api/model-provider-profile",
});
assert.equal(profileResponse.status, 200);
assert.deepEqual(JSON.parse(profileResponse.rawBody), safePublicProfile);

const telemetryResponse = await requestServer(inProcessServer, {
  method: "POST",
  url: "/api/local-llm",
  body: {
    task: "conversation_general",
    requestId: "secret-boundary-telemetry",
    rawText: "Give one bounded camping tip",
    parsedCommand: {
      intent: "conversation.general",
      rawText: "Give one bounded camping tip",
      slots: { topic: "general_qa" },
    },
  },
});
assert.equal(telemetryResponse.status, 200);
for (const forbidden of [
  fakeSecret,
  fakeUpstreamBody,
  rawPromptMarker,
  rawOutputMarker,
  '"apiKey"',
  '"authorization"',
  '"rawPrompt"',
  '"rawOutput"',
  '"upstreamBody"',
  '"response"',
]) {
  assert.equal(
    telemetryResponse.rawBody.includes(forbidden),
    false,
    `public telemetry response must omit ${forbidden}`,
  );
}

const structuredTelemetryResponse = await requestServer(inProcessServer, {
  method: "POST",
  url: "/api/local-llm",
  body: {
    task: "b3_turn_relation",
    requestId: "secret-boundary-structured-telemetry",
    currentGoalSummary: rawPromptMarker,
    rawText: rawOutputMarker,
  },
});
assert.equal(structuredTelemetryResponse.status, 200);
assert.equal(structuredTelemetryResponse.rawBody.includes(fakeSecret), false);
assert.equal(structuredTelemetryResponse.rawBody.includes(fakeUpstreamBody), false);
assert.equal(structuredTelemetryResponse.rawBody.includes(rawPromptMarker), false);
assert.equal(structuredTelemetryResponse.rawBody.includes(rawOutputMarker), false);
assert.equal(
  JSON.parse(structuredTelemetryResponse.rawBody).telemetry.externalModelRequestCount,
  1,
  "public structured telemetry may expose only the bounded numeric external-call count",
);

for (const providerFailureReasonCode of [
  "provider-safety-refusal",
  "generation-timeout",
  "provider-network-error",
]) {
  const secretProviderError = `${fakeUpstreamBody}-${providerFailureReasonCode}`;
  const failureProvider = Object.freeze({
    id: "dashscope",
    model: "qwen-plus-2025-12-01",
  });
  const failureRegistry = Object.freeze({
    providerFor(task) {
      assert.equal(task, "cabin_response");
      return failureProvider;
    },
    profileFor(task) {
      assert.equal(task, "cabin_response");
      return Object.freeze({
        task,
        provider: failureProvider.id,
        model: failureProvider.model,
        watchdogMs: null,
      });
    },
    async generateForTask(task) {
      assert.equal(task, "cabin_response");
      throw new ModelProviderError(secretProviderError, {
        code: providerFailureReasonCode,
        provider: rawOutputMarker,
        durationMs: 9,
        externalModelRequestCount: 1,
        details: {
          reasonCode: providerFailureReasonCode,
          errorType: secretProviderError,
          requestId: rawPromptMarker,
        },
      });
    },
    publicProfiles: safePublicProfile,
  });
  const failureResponse = await requestServer(
    createServer({ modelProviderRegistry: failureRegistry }),
    {
      method: "POST",
      url: "/api/local-llm",
      body: {
        task: "planning",
        requestId: `secret-boundary-${providerFailureReasonCode}`,
        rawText: "生成安全的最终摘要",
        parsedCommand: { intent: "unknown", slots: {} },
        toolResult: {},
      },
    },
  );
  const failureBody = JSON.parse(failureResponse.rawBody);
  assert.equal(failureResponse.status, 200);
  assert.equal(failureBody.telemetry.provider, "dashscope");
  assert.equal(failureBody.telemetry.model, "qwen-plus-2025-12-01");
  assert.equal(failureBody.telemetry.reason, providerFailureReasonCode);
  assert.equal(failureBody.telemetry.providerFailureReasonCode, providerFailureReasonCode);
  assert.equal(failureBody.telemetry.externalModelRequestCount, 1);
  assert.equal(failureResponse.rawBody.includes(secretProviderError), false);
  assert.equal(failureResponse.rawBody.includes(rawPromptMarker), false);
  assert.equal(failureResponse.rawBody.includes(rawOutputMarker), false);
}

const benchmarkDir = new URL("scripts/benchmarks/", root);
const benchmarkFiles = (await readdir(benchmarkDir))
  .filter((file) => file.endsWith(".mjs"))
  .sort();
const benchmarkSources = Object.fromEntries(await Promise.all(benchmarkFiles.map(async (file) => [
  file,
  await readFile(new URL(file, benchmarkDir), "utf8"),
])));

function assertSafeBenchmarkProcessEnv(file, source, allowedEnv) {
  assert.doesNotMatch(
    source,
    /process\.env\.[A-Za-z_$][\w$]*\s*(?:\+\+|--|\?\?=|&&=|\|\|=|[+\-*/%&|^]=|=(?!=|>))/,
    `${file} must not assign to a fixed process.env property`,
  );
  const withoutFixedReads = source.replace(/process\.env\.[A-Za-z_$][\w$]*/g, "");
  assert.equal(
    withoutFixedReads.includes("process.env"),
    false,
    `${file} may only read process.env.FIXED_NAME properties directly`,
  );
  const fixedNames = [...source.matchAll(/process\.env\.([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]);
  const uniqueNames = [...new Set(fixedNames)].sort();
  for (const name of uniqueNames) {
    assert.doesNotMatch(
      name,
      /(?:API_?KEY|AUTH(?:ORIZATION)?|TOKEN|SECRET|CREDENTIAL)/i,
      `${file} must not read a Provider key/auth/secret environment variable`,
    );
  }
  assert.deepEqual(
    uniqueNames,
    [...allowedEnv].sort(),
    `${file} process.env reads must exactly match allowedEnv`,
  );
}

for (const unsafeEnvFixture of [
  "console.log(process.env)",
  "const snapshot = process.env",
  "Object.entries(process.env)",
  "const copy = { ...process.env }",
  "const value = process.env[name]",
  "process.env.NIO_FIXED = 'changed'",
]) {
  assert.throws(
    () => assertSafeBenchmarkProcessEnv("temporary-unsafe-env-fixture.mjs", unsafeEnvFixture, []),
    /process\.env/,
  );
}
assert.throws(
  () => assertSafeBenchmarkProcessEnv(
    "temporary-sensitive-env-fixture.mjs",
    "const key = process.env.DASHSCOPE_API_KEY",
    ["DASHSCOPE_API_KEY"],
  ),
  /Provider key\/auth\/secret/,
);

const benchmarkSafetyContracts = Object.freeze({
  "benchmark-conversation-compact-output.mjs": Object.freeze({
    kind: "pure-projectors",
    allowedEnv: Object.freeze([
      "NIO_AGENT_ENDPOINT", "NIO_COMPACT_AB_REPEATS", "NIO_COMPACT_AB_TEXT",
    ]),
    allowedSampleFields: Object.freeze([
      "wallMs", "durationMs", "promptChars", "promptEvalMs", "evalMs", "evalCount",
      "mode", "outputBudget", "summaryChars", "summarySha256", "lineCount", "sentenceCount",
      "singleParagraph",
    ]),
    allowedReportFields: Object.freeze([
      "endpoint", "repeats", "inputChars", "inputSha256", "standard", "compact",
      "p50WallMsDelta", "p95WallMsDelta", "note",
    ]),
    forbiddenSource: Object.freeze([
      Object.freeze({ pattern: /\bsummary\s*:\s*body\.summary\b/, reason: "full model output" }),
      Object.freeze({ pattern: /\n\s{2}rawText,\s*\n/, reason: "raw input in final report" }),
    ]),
  }),
  "benchmark-hmi-voice-feedback.mjs": Object.freeze({
    kind: "pure-report-projector",
    projectorExport: "projectHmiVoiceBenchmarkReport",
    allowedEnv: Object.freeze([
      "NIO_AGENT_BASE_URL", "NIO_HMI_VOICE_BENCHMARK_SCREENSHOT",
      "NIO_HMI_VOICE_BENCHMARK_RESULT", "NIO_HMI_VOICE_BENCHMARK_REPEATS",
      "NIO_HMI_VOICE_BENCHMARK_CASES", "NIO_HMI_VOICE_BENCHMARK_PLAYBACK_SCALE",
      "NIO_HMI_VOICE_BENCHMARK_MIN_PLAYBACK_MS", "NIO_HMI_VOICE_BENCHMARK_MAX_PLAYBACK_MS",
      "NIO_HMI_VOICE_BENCHMARK_CASE_TIMEOUT_MS", "NIO_HMI_VOICE_BENCHMARK_STREAMING_POC",
    ]),
    allowedOutputFields: Object.freeze([
      "ok", "partial", "current", "baseUrl", "screenshotPath", "resultPath", "repeats",
      "streamingPocEnabled", "selectedCases", "playbackMock", "benchmarkContract", "summary",
      "results", "reason",
    ]),
    allowedResultFields: Object.freeze([
      "ok", "label", "family", "length", "iteration", "resultMode", "resultIntent",
      "conversationDomain", "safetyAction", "caseExpectation", "runtimeStages",
      "runtimeToTtsStartMs", "ttsResponseMs", "submitToFirstAudioPlayMs",
      "submitToFirstAudibleMs", "firstTtsRequestToCompleteAudioReadyMs", "ttsCompletedMs",
      "maxChunkGapMs", "chunkCount", "ttsSummary", "firstTtsRequest",
    ]),
    requiredSafeMarkers: Object.freeze([
      "selectedCases: selectedCases.map(({ label, family, length }) => ({ label, family, length }))",
      "benchmarkContract: summarizeBenchmarkContract(results)",
      "summary: buildSummary(results)",
    ]),
    forbiddenSource: Object.freeze([
      Object.freeze({ pattern: /\bresponsePreview\b/, reason: "model answer preview" }),
      Object.freeze({ pattern: /error\.stack\s*\|\|\s*error\.message/, reason: "raw error/path output" }),
      Object.freeze({ pattern: /firstTtsRequest:[^\n]*\berror\s*:/, reason: "raw request error output" }),
    ]),
  }),
  "benchmark-tts-baseline.mjs": Object.freeze({
    kind: "pure-projector",
    allowedEnv: Object.freeze(["NIO_AGENT_BASE_URL", "NIO_TTS_BENCHMARK_MODE"]),
    allowedOutputFields: Object.freeze([
      "label", "temperatureState", "status", "ok", "reason", "contentType", "wallTimeMs",
      "responseTelemetry", "audioBytes", "wavDurationSeconds", "rtf",
    ]),
    forbiddenSource: Object.freeze([
      Object.freeze({ pattern: /\bfailureBody\s*:/, reason: "failure response body" }),
      Object.freeze({ pattern: /bytes\.toString\(["']utf8["']/, reason: "decoded response body" }),
    ]),
  }),
  "compare-local-llm-models.mjs": Object.freeze({
    kind: "pure-report-projector",
    projectorExport: "projectCompareLocalLlmReport",
    allowedEnv: Object.freeze([
      "NIO_AGENT_BASE_URL", "NIO_OLLAMA_BASE_URL", "NIO_LLM_COMPARE_MODELS",
    ]),
    allowedOutputFields: Object.freeze([
      "ok", "reason", "checkedAt", "baseUrl", "ollamaUrl", "models", "ollamaOptions",
      "purpose", "cases",
    ]),
    allowedCaseFields: Object.freeze([
      "id", "task", "riskLevel", "routingCandidate", "notes", "baseline", "promptChars",
      "baselineSummaryLength", "candidateRuns", "baselineError",
    ]),
    allowedCandidateFields: Object.freeze([
      "model", "wallMs", "responseLength", "done", "ollamaDurations", "prompt_eval_count",
      "eval_count", "error", "status",
    ]),
    requiredSafeMarkers: Object.freeze([
      "responseLength: typeof body.response === \"string\" ? body.response.length : undefined",
      "promptChars: baselineResult.prompt.length",
      "baselineSummaryLength: typeof baselineResult.summary === \"string\" ? baselineResult.summary.length : undefined",
    ]),
    forbiddenSource: Object.freeze([
      Object.freeze({ pattern: /\brawBody\s*:/, reason: "raw response parse fallback" }),
      Object.freeze({ pattern: /\bresponseBody\s*:/, reason: "raw response object" }),
    ]),
  }),
  "evaluate-vehicle-slu-models.mjs": Object.freeze({
    kind: "local-vehicle-slu-safe-projector",
    allowedEnv: Object.freeze(["NIO_OLLAMA_BASE_URL"]),
    requiredSafeMarkers: Object.freeze([
      "const localBaseUrl = normalizeLocalOllamaBaseUrl(baseUrl);",
      "if (url.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\", \"[::1]\"].includes(url.hostname)) {",
      "runs.push(publicEvaluationRun(observation));",
      "const { semanticEnvelope, ...safeObservation } = observation;",
      "slots: projectPublicVehicleSluSlots(entry.intent, entry.slots),",
      "platform: sanitizePlatformSummary(platformSummary),",
    ]),
    forbiddenSource: Object.freeze([
      Object.freeze({
        pattern: /\b(?:rawPrompt|rawResponse|responseBody|responseObject|conversationGoal|conversationSummary)\s*:/i,
        reason: "raw prompt, response, or conversation summary",
      }),
      Object.freeze({
        pattern: /\b(?:credentials?|authorization|apiKey|token|secret)\s*:/i,
        reason: "request credentials or Provider secrets",
      }),
      Object.freeze({
        pattern: /\bheaders\s*:(?!\s*\{\s*["']content-type["']\s*:\s*["']application\/json["']\s*\})/i,
        reason: "request or response headers outside the fixed JSON content type",
      }),
      Object.freeze({
        pattern: /\b(?:runs|modelResults)\.push\s*\(\s*(?:observation|generated|response|prompt)\b/i,
        reason: "unprojected evaluation or Provider data",
      }),
      Object.freeze({
        pattern: /(?:https:\/\/|dashscope\.aliyuncs\.com|api\.openai\.com|api\.anthropic\.com)/i,
        reason: "cloud or non-local Provider URL",
      }),
      Object.freeze({
        pattern: /JSON\.stringify\s*\(\s*process\.env|\.\.\.\s*process\.env|\b(?:env|environment)\s*:\s*process\.env/i,
        reason: "full process environment",
      }),
    ]),
  }),
  "evaluate-vehicle-slu-ux.mjs": Object.freeze({
    kind: "local-vehicle-slu-ux-evaluator",
    allowedEnv: Object.freeze(["NIO_OLLAMA_BASE_URL"]),
    requiredSafeMarkers: Object.freeze([
      "const localBaseUrl = normalizeLocalOllamaBaseUrl(baseUrl);",
      "if (url.protocol !== \"http:\" || ![\"127.0.0.1\", \"localhost\", \"[::1]\"].includes(url.hostname)) {",
    ]),
    forbiddenSource: Object.freeze([
      Object.freeze({
        pattern: /\b(?:rawPrompt|rawResponse|responseBody|responseObject)\s*:/i,
        reason: "raw prompt or response",
      }),
      Object.freeze({
        pattern: /\b(?:credentials?|authorization|apiKey|token|secret)\s*:/i,
        reason: "request credentials or Provider secrets",
      }),
    ]),
  }),
  "measure-hmi-real-browser-scheduled-audio.mjs": Object.freeze({
    kind: "pure-report-projector",
    projectorExport: "projectScheduledAudioBenchmarkReport",
    allowedEnv: Object.freeze([
      "NIO_AGENT_BASE_URL", "NIO_HMI_REAL_BROWSER_AUDIO_RESULT",
      "NIO_HMI_REAL_BROWSER_AUDIO_TIMEOUT_MS", "NIO_HMI_REAL_BROWSER_AUDIO_INPUT",
      "NIO_HMI_REAL_BROWSER_AUDIO_WAIT_FOR_COMPLETION",
    ]),
    allowedOutputFields: Object.freeze([
      "ok", "measurement", "physicalAcousticMeasurement", "waitForCompletion", "inputChars",
      "submittedAtMs", "resultIntent", "ttsStatus", "completionWait", "scheduledFirstAudioMs",
      "adapterScheduledFirstAudioMs", "latestRunTelemetry", "reason",
    ]),
    requiredSafeMarkers: Object.freeze([
      "inputChars: input.length",
      "promptChars: Number.isFinite(llmTelemetry.promptChars)",
      "This whitelist intentionally omits user input/history, prompts, event",
    ]),
    forbiddenSource: Object.freeze([
      Object.freeze({ pattern: /error\.stack\s*\|\|\s*error\.message/, reason: "raw error/path output" }),
      Object.freeze({ pattern: /assistantResponse|conversationResult\?\.summary|cloudResult\?\.summary/, reason: "model answer output" }),
    ]),
  }),
  "profile-local-llm-latency.mjs": Object.freeze({
    kind: "pure-projector",
    allowedEnv: Object.freeze(["NIO_AGENT_BASE_URL", "NIO_LLM_PROFILE_REPEAT"]),
    allowedOutputFields: Object.freeze([
      "run", "task", "intent", "wallMs", "summaryLength", "provider", "degraded", "reason",
      "promptStyle", "planningSummaryMode", "externalDataProvider", "cacheHit", "cacheEligible",
      "cacheType", "cachedProvider", "promptChars", "durationMs", "prompt_eval_count", "eval_count",
      "model",
    ]),
    forbiddenSource: Object.freeze([
      Object.freeze({ pattern: /text\.slice\(0,\s*300\)/, reason: "response body excerpt" }),
      Object.freeze({ pattern: /\btext\s*:\s*item\.text\b/, reason: "raw input output" }),
    ]),
  }),
  "run-b4-baseline.mjs": Object.freeze({
    kind: "bounded-b4-runner",
    allowedEnv: Object.freeze(["NIO_AGENT_BASE_URL", "NIO_GPT_SOVITS_ENDPOINT"]),
    forbiddenSource: Object.freeze([
      Object.freeze({ pattern: /\b(?:apiKey|authorization|rawPrompt|rawOutput|upstreamBody)\s*:/i, reason: "secret or raw Provider field" }),
      Object.freeze({ pattern: /JSON\.stringify\s*\(\s*process\.env|\.\.\.\s*process\.env/i, reason: "full process environment" }),
    ]),
  }),
  "run-b4-single-scenario.mjs": Object.freeze({
    kind: "bounded-b4-single-scenario-runner",
    allowedEnv: Object.freeze(["NIO_AGENT_BASE_URL"]),
    forbiddenSource: Object.freeze([
      Object.freeze({ pattern: /\b(?:apiKey|authorization|rawPrompt|rawOutput|upstreamBody)\s*:/i, reason: "secret or raw Provider field" }),
      Object.freeze({ pattern: /JSON\.stringify\s*\(\s*process\.env|\.\.\.\s*process\.env/i, reason: "full process environment" }),
    ]),
  }),
  "run-vehicle-slu-frozen-ux.mjs": Object.freeze({
    kind: "local-vehicle-slu-frozen-ux-runner",
    allowedEnv: Object.freeze([]),
    requiredSafeMarkers: Object.freeze([
      "baseUrl: \"http://127.0.0.1:11434\"",
    ]),
    forbiddenSource: Object.freeze([
      Object.freeze({
        pattern: /\b(?:rawPrompt|rawResponse|responseBody|responseObject)\s*:/i,
        reason: "raw prompt or response",
      }),
      Object.freeze({ pattern: /JSON\.stringify\s*\(\s*process\.env|\.\.\.\s*process\.env/i, reason: "full process environment" }),
    ]),
  }),
});

function assertBenchmarkContractCoverage(files, contracts) {
  assert.deepEqual(
    Object.keys(contracts).sort(),
    [...files].sort(),
    "every benchmark must have an explicit safety contract before it can run",
  );
}

assert.throws(
  () => assertBenchmarkContractCoverage(
    [...benchmarkFiles, "temporary-unregistered-benchmark.mjs"],
    benchmarkSafetyContracts,
  ),
  /explicit safety contract/,
);
assertBenchmarkContractCoverage(benchmarkFiles, benchmarkSafetyContracts);

for (const [file, source] of Object.entries(benchmarkSources)) {
  const contract = benchmarkSafetyContracts[file];
  assertSafeBenchmarkProcessEnv(file, source, contract.allowedEnv);
  assert.doesNotMatch(
    source,
    /JSON\.stringify\s*\(\s*process\.env|\.\.\.\s*process\.env|\b(?:env|environment)\s*:\s*process\.env/i,
    `${file} must not dump the full process environment`,
  );
  assert.doesNotMatch(
    source,
    /\b(?:apiKey|authorization|rawPrompt|rawOutput|upstreamBody)\s*:/i,
    `${file} must not project secret or raw Provider fields`,
  );
  assert.doesNotMatch(
    source,
    /\b(?:rawResponse|responseObject|responseBody)\s*:\s*(?:error\.)?(?:body|response|data)\b/i,
    `${file} must not project a raw upstream response object`,
  );
  if (contract.projectorExport) {
    assert.match(
      source,
      new RegExp(`export function ${contract.projectorExport}\\b`),
      `${file} must export ${contract.projectorExport} before it can be imported safely`,
    );
  }
  for (const marker of contract.requiredSafeMarkers || []) {
    assert.equal(source.includes(marker), true, `${file} must retain safe projection marker: ${marker}`);
  }
  for (const field of contract.allowedOutputFields || []) {
    assert.match(source, new RegExp(`\\b${field}\\b`), `${file} must retain allowlisted output field ${field}`);
  }
  for (const { pattern, reason } of contract.forbiddenSource) {
    assert.doesNotMatch(source, pattern, `${file} must not persist ${reason}`);
  }
}
assert.doesNotMatch(
  benchmarkSources["profile-local-llm-latency.mjs"],
  /text\.slice\(0,\s*300\)|\btext\s*:\s*item\.text\b/,
  "local LLM profiler must not print a response excerpt or raw input",
);
assert.doesNotMatch(
  benchmarkSources["benchmark-tts-baseline.mjs"],
  /\bfailureBody\s*:|bytes\.toString\(["']utf8["']/,
  "TTS benchmark must not persist a failure response body",
);
assert.doesNotMatch(
  benchmarkSources["benchmark-conversation-compact-output.mjs"],
  /\bsummary\s*:\s*body\.summary\b/,
  "compact benchmark must not persist full model output",
);

const profileBenchmark = await import("../benchmarks/profile-local-llm-latency.mjs");
const ttsBenchmark = await import("../benchmarks/benchmark-tts-baseline.mjs");
const compactBenchmark = await import("../benchmarks/benchmark-conversation-compact-output.mjs");
const hmiVoiceBenchmark = await import("../benchmarks/benchmark-hmi-voice-feedback.mjs");
const scheduledAudioBenchmark = await import("../benchmarks/measure-hmi-real-browser-scheduled-audio.mjs");
const compareLocalLlmBenchmark = await import("../benchmarks/compare-local-llm-models.mjs");

const profileSummary = profileBenchmark.buildProfileRunSummary(
  {
    id: "malicious-profile-fixture",
    text: rawPromptMarker,
    body: { task: "conversation_general", parsedCommand: { intent: "conversation.general" } },
  },
  0,
  10,
  {
    summary: rawOutputMarker,
    model: "qwen2.5:7b",
    telemetry: {
      provider: "ollama",
      degraded: false,
      reason: "model-provider-success",
      ollamaDurations: { prompt_eval_count: 3, eval_count: 2 },
    },
  },
);
assert.equal(Object.hasOwn(profileSummary, "text"), false);
assert.equal(JSON.stringify(profileSummary).includes(rawPromptMarker), false);
assert.equal(JSON.stringify(profileSummary).includes(rawOutputMarker), false);
assert.deepEqual(
  Object.keys(profileSummary).sort(),
  [...benchmarkSafetyContracts["profile-local-llm-latency.mjs"].allowedOutputFields].sort(),
);

const ttsSummary = ttsBenchmark.buildTtsBenchmarkResult({
  item: { label: "failure" },
  temperatureState: "test",
  response: new Response(fakeUpstreamBody, {
    status: 502,
    headers: { "content-type": "application/json" },
  }),
  bytes: Buffer.from(fakeUpstreamBody),
  wallTimeMs: 12,
  wavDurationSeconds: null,
});
assert.deepEqual(
  Object.keys(ttsSummary).sort(),
  [...benchmarkSafetyContracts["benchmark-tts-baseline.mjs"].allowedOutputFields].sort(),
);
assert.equal(JSON.stringify(ttsSummary).includes(fakeUpstreamBody), false);

const compactSample = compactBenchmark.buildCompactBenchmarkSample({
  body: {
    summary: rawOutputMarker,
    telemetry: {
      degraded: false,
      durationMs: 7,
      promptChars: 11,
      conversationOutputMode: "compact",
      conversationOutputBudget: 24,
      ollamaDurations: { prompt_eval_duration_ms: 3, eval_duration_ms: 4, eval_count: 5 },
    },
  },
  wallMs: 9,
});
assert.equal(Object.hasOwn(compactSample, "summary"), false);
assert.equal(compactSample.summaryChars, rawOutputMarker.length);
assert.match(compactSample.summarySha256, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(compactSample).includes(rawOutputMarker), false);
assert.deepEqual(
  Object.keys(compactSample).sort(),
  [...benchmarkSafetyContracts["benchmark-conversation-compact-output.mjs"].allowedSampleFields].sort(),
);
const compactReport = compactBenchmark.buildCompactBenchmarkReport({
  endpoint: "http://127.0.0.1:4173",
  repeats: 3,
  rawText: rawPromptMarker,
  standard: { samples: [compactSample], p50WallMs: 9, p95WallMs: 9, p50DurationMs: 7, p95DurationMs: 7 },
  compact: { samples: [compactSample], p50WallMs: 9, p95WallMs: 9, p50DurationMs: 7, p95DurationMs: 7 },
});
assert.equal(Object.hasOwn(compactReport, "rawText"), false);
assert.equal(JSON.stringify(compactReport).includes(rawPromptMarker), false);
assert.match(compactReport.inputSha256, /^[a-f0-9]{64}$/);
assert.deepEqual(
  Object.keys(compactReport).sort(),
  [...benchmarkSafetyContracts["benchmark-conversation-compact-output.mjs"].allowedReportFields].sort(),
);

const maliciousReportFields = {
  apiKey: fakeSecret,
  authorization: `Bearer ${fakeSecret}`,
  rawPrompt: rawPromptMarker,
  rawOutput: rawOutputMarker,
  upstreamBody: fakeUpstreamBody,
  error: fakeUpstreamBody,
  stack: fakeUpstreamBody,
  body: fakeUpstreamBody,
  input: rawPromptMarker,
  modelAnswer: rawOutputMarker,
};
const assertNoMaliciousReportMarkers = (value) => {
  const json = JSON.stringify(value);
  for (const marker of [fakeSecret, fakeUpstreamBody, rawPromptMarker, rawOutputMarker]) {
    assert.equal(json.includes(marker), false);
  }
};

const hmiVoiceReport = hmiVoiceBenchmark.projectHmiVoiceBenchmarkReport({
  ok: true,
  partial: false,
  current: { label: "manual-short", iteration: 1, status: "completed", ...maliciousReportFields },
  baseUrl: "http://127.0.0.1:4173",
  screenshotPath: "/tmp/safe.png",
  resultPath: "/tmp/safe.json",
  repeats: 1,
  streamingPocEnabled: false,
  selectedCases: [{ label: "manual-short", family: "Manual", length: "short", ...maliciousReportFields }],
  playbackMock: { note: "safe", playbackScale: 1, minPlaybackMs: 1, maxPlaybackMs: 2, ...maliciousReportFields },
  benchmarkContract: { id: "safe", ...maliciousReportFields },
  summary: { all: { runs: 1, ...maliciousReportFields }, ...maliciousReportFields },
  results: [{
    ok: true,
    label: "manual-short",
    family: "Manual",
    length: "short",
    iteration: 1,
    resultMode: "conversation",
    resultIntent: "conversation.general",
    conversationDomain: "manual_knowledge",
    safetyAction: "unavailable",
    caseExpectation: { expected: { intent: "conversation.general", ...maliciousReportFields }, actual: {}, ok: true, failures: [], ...maliciousReportFields },
    runtimeStages: { semanticMs: 1, manualRagMs: 2, llmMs: 3, runtimeTotalMs: 4, ...maliciousReportFields },
    ttsSummary: { provider: "local", chunks: [{ index: 0, textChars: 8, responseHeaders: { "x-nio-tts-status": "ok", ...maliciousReportFields }, ...maliciousReportFields }], ...maliciousReportFields },
    firstTtsRequest: { status: 200, reason: "tts-request-completed", telemetry: {}, ...maliciousReportFields },
    ...maliciousReportFields,
  }],
  ...maliciousReportFields,
});
assert.deepEqual(Object.keys(hmiVoiceReport).sort(), [...benchmarkSafetyContracts["benchmark-hmi-voice-feedback.mjs"].allowedOutputFields].sort());
assert.deepEqual(Object.keys(hmiVoiceReport.results[0]).sort(), [...benchmarkSafetyContracts["benchmark-hmi-voice-feedback.mjs"].allowedResultFields].sort());
assert.deepEqual(Object.keys(hmiVoiceReport.results[0].caseExpectation).sort(), ["actual", "expected", "failures", "ok"]);
assert.deepEqual(Object.keys(hmiVoiceReport.results[0].ttsSummary).sort(), [
  "capabilities", "chunkCount", "chunkGapsMs", "chunks", "completedMs", "displayTextChars",
  "firstAudibleMs", "firstChunkRequestToCompleteAudioReadyMs", "firstChunkRequestToHeadersMs",
  "firstPlayStartedMs", "maxChunkGapMs", "provider", "speechTextChars", "speechTextPolicy",
  "speechTextProvenance", "status",
]);
assert.deepEqual(Object.keys(hmiVoiceReport.results[0].ttsSummary.chunks[0]).sort(), [
  "audioBytes", "httpStatus", "index", "playDurationMs", "playEndedMs", "playStartedMs",
  "previousEndToPlayStartGapMs", "requestToCompleteAudioReadyMs", "requestToResponseHeadersMs",
  "responseHeaders", "textChars",
]);
assertNoMaliciousReportMarkers(hmiVoiceReport);
for (const fixture of [
  { ok: false, partial: true, current: { label: "manual-short", ...maliciousReportFields }, ...maliciousReportFields },
  { ok: false, reason: "benchmark-failed", ...maliciousReportFields },
]) {
  const report = hmiVoiceBenchmark.projectHmiVoiceBenchmarkReport(fixture);
  assert.deepEqual(Object.keys(report).sort(), [...benchmarkSafetyContracts["benchmark-hmi-voice-feedback.mjs"].allowedOutputFields].sort());
  assertNoMaliciousReportMarkers(report);
}

const scheduledAudioReport = scheduledAudioBenchmark.projectScheduledAudioBenchmarkReport({
  ok: true,
  measurement: "scheduled",
  physicalAcousticMeasurement: false,
  waitForCompletion: false,
  inputChars: 8,
  submittedAtMs: 1,
  resultIntent: "conversation.general",
  ttsStatus: "completed",
  completionWait: { enabled: false, timedOut: false, latestRunCaptured: true, latestRunReplaced: false, ...maliciousReportFields },
  scheduledFirstAudioMs: 4,
  adapterScheduledFirstAudioMs: 3,
  latestRunTelemetry: {
    runtime: { status: "completed", events: [{ agent: "edge", status: "done", time: "safe", observedMs: 1, durationMs: 1, ...maliciousReportFields }], ...maliciousReportFields },
    semantic: { provider: "local", durationMs: 1, ...maliciousReportFields },
    llm: { provider: "ollama", model: "safe", promptChars: 10, ...maliciousReportFields },
    manual: { query: { chars: 2, ...maliciousReportFields }, evidence: { eligibility: { acceptedCount: 1, ...maliciousReportFields }, ...maliciousReportFields }, ...maliciousReportFields },
    tts: { request: {}, body: { firstBodyMs: 1, ...maliciousReportFields }, schedule: {}, chunks: [{ index: 0, chars: 8, ...maliciousReportFields }], ...maliciousReportFields },
    bridge: { policy: { id: "safe", version: "1", ...maliciousReportFields }, queueState: {}, ...maliciousReportFields },
    ...maliciousReportFields,
  },
  ...maliciousReportFields,
});
assert.deepEqual(Object.keys(scheduledAudioReport).sort(), [...benchmarkSafetyContracts["measure-hmi-real-browser-scheduled-audio.mjs"].allowedOutputFields].sort());
assert.deepEqual(Object.keys(scheduledAudioReport.latestRunTelemetry).sort(), ["bridge", "llm", "manual", "runtime", "semantic", "tts"]);
assert.deepEqual(Object.keys(scheduledAudioReport.latestRunTelemetry.runtime).sort(), ["durationMs", "endedAt", "events", "startedAt", "status"]);
assert.deepEqual(Object.keys(scheduledAudioReport.latestRunTelemetry.runtime.events[0]).sort(), ["agent", "durationMs", "observedMs", "status", "time"]);
assert.deepEqual(Object.keys(scheduledAudioReport.latestRunTelemetry.tts).sort(), ["body", "chunks", "completedMs", "provider", "request", "schedule", "startedAtMs", "status"]);
assert.deepEqual(Object.keys(scheduledAudioReport.latestRunTelemetry.tts.chunks[0]).sort(), [
  "chars", "completeAudioReadyMs", "firstBodyMs", "index", "playStartedMs",
  "previousEndToPlayStartGapMs", "requestStartMs", "responseHeadersMs", "scheduledMs",
  "streamScheduleGapsMs",
]);
assertNoMaliciousReportMarkers(scheduledAudioReport);
const scheduledAudioFailure = scheduledAudioBenchmark.projectScheduledAudioBenchmarkReport({ ok: false, reason: "benchmark-failed", ...maliciousReportFields });
assert.deepEqual(Object.keys(scheduledAudioFailure).sort(), [...benchmarkSafetyContracts["measure-hmi-real-browser-scheduled-audio.mjs"].allowedOutputFields].sort());
assertNoMaliciousReportMarkers(scheduledAudioFailure);

const compareReport = compareLocalLlmBenchmark.projectCompareLocalLlmReport({
  ok: true,
  reason: "completed",
  checkedAt: "safe",
  baseUrl: "http://127.0.0.1:4173",
  ollamaUrl: "http://127.0.0.1:11434",
  models: ["safe"],
  ollamaOptions: { temperature: 0, num_predict: 10, stream: false, ...maliciousReportFields },
  purpose: "safe",
  cases: [{
    id: "safe",
    task: "conversation_general",
    riskLevel: "low",
    routingCandidate: "review",
    notes: "safe",
    baseline: { provider: "ollama", model: "safe", ...maliciousReportFields },
    promptChars: 10,
    baselineSummaryLength: 5,
    candidateRuns: [{ model: "safe", wallMs: 1, responseLength: 5, done: true, ollamaDurations: {}, ...maliciousReportFields }],
    ...maliciousReportFields,
  }],
  ...maliciousReportFields,
});
assert.deepEqual(Object.keys(compareReport).sort(), [...benchmarkSafetyContracts["compare-local-llm-models.mjs"].allowedOutputFields].sort());
assert.deepEqual(Object.keys(compareReport.cases[0]).sort(), [...benchmarkSafetyContracts["compare-local-llm-models.mjs"].allowedCaseFields].sort());
assert.deepEqual(Object.keys(compareReport.cases[0].candidateRuns[0]).sort(), [...benchmarkSafetyContracts["compare-local-llm-models.mjs"].allowedCandidateFields].sort());
assert.deepEqual(Object.keys(compareReport.cases[0].baseline).sort(), [
  "cacheEligible", "cacheHit", "degraded", "durationMs", "model", "ollamaDurations",
  "planningSummaryMode", "promptChars", "promptStyle", "provider", "reason", "summaryLength", "wallMs",
]);
assert.deepEqual(Object.keys(compareReport.cases[0].candidateRuns[0].ollamaDurations).sort(), [
  "eval_count", "eval_duration_ms", "load_duration_ms", "prompt_eval_count",
  "prompt_eval_duration_ms", "total_duration_ms",
]);
assertNoMaliciousReportMarkers(compareReport);
const compareFailure = compareLocalLlmBenchmark.projectCompareLocalLlmReport({ ok: false, reason: "benchmark-failed", ...maliciousReportFields });
assert.deepEqual(Object.keys(compareFailure).sort(), [...benchmarkSafetyContracts["compare-local-llm-models.mjs"].allowedOutputFields].sort());
assertNoMaliciousReportMarkers(compareFailure);

const envExample = await readFile(new URL(".env.example", root), "utf8");
assert.equal(envExample.includes(fakeSecret), false);
assert.doesNotMatch(
  envExample,
  /^\s*DASHSCOPE_API_KEY\s*=/m,
  ".env.example must not assign a DashScope key, including a placeholder",
);

const projectLayoutSource = await readFile(new URL("scripts/verify/verify-project-layout.mjs", root), "utf8");
assert.match(projectLayoutSource, /["']\.env\.example["']/, "project layout must allow .env.example");

console.log(JSON.stringify({
  browserSourceFiles: browserPaths.length,
  benchmarkFiles: benchmarkFiles.length,
  inProcessProfileSafe: true,
  inProcessTelemetrySafe: true,
  publicProfileSafe: true,
  sanitizedErrors: true,
  telemetryProjectionSafe: true,
}));
console.log("verify-model-provider-secret-boundary: PASS");
