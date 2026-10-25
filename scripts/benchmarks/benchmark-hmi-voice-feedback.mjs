import { launchChromium } from "../lib/playwright-loader.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  installVoicePlaybackProbe,
  isVoicePlaybackProviderObservation,
  observeVoicePlayback,
  recordVoiceSubmission,
} from "../lib/hmi-voice-benchmark-probe.mjs";

const baseUrl = process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173";
const screenshotPath = process.env.NIO_HMI_VOICE_BENCHMARK_SCREENSHOT || "/tmp/nio-hmi-voice-feedback-baseline.png";
const resultPath = process.env.NIO_HMI_VOICE_BENCHMARK_RESULT || "/tmp/nio-hmi-voice-feedback-baseline.json";
const repeats = Math.max(1, Number.parseInt(process.env.NIO_HMI_VOICE_BENCHMARK_REPEATS || "1", 10));
const caseFilter = (process.env.NIO_HMI_VOICE_BENCHMARK_CASES || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const playbackScale = Number.parseFloat(process.env.NIO_HMI_VOICE_BENCHMARK_PLAYBACK_SCALE || "0.03");
const minPlaybackMs = Number.parseInt(process.env.NIO_HMI_VOICE_BENCHMARK_MIN_PLAYBACK_MS || "60", 10);
const maxPlaybackMs = Number.parseInt(process.env.NIO_HMI_VOICE_BENCHMARK_MAX_PLAYBACK_MS || "1200", 10);
const perCaseTimeoutMs = Number.parseInt(process.env.NIO_HMI_VOICE_BENCHMARK_CASE_TIMEOUT_MS || "120000", 10);
// The streaming path is deliberately an opt-in PoC. Set this before the HMI
// module is evaluated so VoiceOutputAdapter is constructed in streaming mode.
const streamingPocEnabled = process.env.NIO_HMI_VOICE_BENCHMARK_STREAMING_POC === "true";

const cases = [
  { label: "manual-short", family: "Manual", length: "short", input: "请查用户手册：尾门开启有哪些安全注意事项？", expected: { intent: "conversation.general", domain: "manual_knowledge" } },
  { label: "manual-long", family: "Manual", length: "long", input: "请查用户手册：请详细说明尾门开启前需要确认哪些安全事项、遇到后方空间不明确时应如何处理，并附上已检索到的真实页码依据。", expected: { intent: "conversation.general", domain: "manual_knowledge" } },
  { label: "weather-short", family: "Weather", length: "short", input: "今天杭州的天气适合穿什么衣服？", expected: { intent: "conversation.general", domain: "weather" } },
  { label: "weather-long", family: "Weather", length: "long", input: "今天和明天杭州哪个时间更适合傍晚去户外散步？请结合温度、降水概率和风的情况给一个简短建议。", expected: { intent: "conversation.general", domain: "weather" } },
  { label: "general-short", family: "General", length: "short", input: "你好，简单介绍一下你能帮我做什么。", expected: { intent: "conversation.general" } },
  { label: "general-long", family: "General", length: "long", input: "请用自然一点的语气说明你现在可以处理哪些车控、天气、用户手册和语音播报任务，也说明哪些实时数据目前还没有接入。", expected: { intent: "conversation.general" } },
  { label: "safety-short", family: "Safety", length: "short", input: "打开尾门。", expected: { intent: "body.tailgate.open", safetyAction: "require_confirmation" } },
  { label: "safety-long", family: "Safety", length: "long", input: "请帮我打开后备箱并把尾门升起来，动作执行后保持尾门打开。", expected: { intent: "body.tailgate.open", safetyAction: "require_confirmation" } },
];
const selectedCases = caseFilter.length ? cases.filter((item) => caseFilter.includes(item.label) || caseFilter.includes(item.family)) : cases;

const scalar = Symbol("safe-report-scalar");
const metricSchema = { count: scalar, p50: scalar, p95: scalar, min: scalar, max: scalar };
const rowSummarySchema = {
  runs: scalar,
  successfulRuns: scalar,
  submitToFirstAudioPlayMs: metricSchema,
  submitToFirstAudibleMs: metricSchema,
  submitToTtsRequestMs: metricSchema,
  firstTtsRequestToCompleteAudioReadyMs: metricSchema,
  ttsCompletedMs: metricSchema,
  maxChunkGapMs: metricSchema,
  chunkCount: metricSchema,
};
const responseHeadersSchema = {
  "x-nio-tts-proxy-total-ms": scalar,
  "x-nio-tts-upstream-first-response-ms": scalar,
  "x-nio-tts-upstream-complete-read-ms": scalar,
  "x-nio-tts-audio-bytes": scalar,
  "x-nio-tts-status": scalar,
  "x-nio-tts-streaming-mode": scalar,
  "x-nio-tts-profile-id": scalar,
  "x-nio-tts-profile-version": scalar,
  "x-nio-tts-synthesis-profile-id": scalar,
  "x-nio-tts-license-boundary": scalar,
};
const expectationValuesSchema = { intent: scalar, domain: scalar, safetyAction: scalar };
const ttsSummarySchema = {
  provider: scalar,
  status: scalar,
  displayTextChars: scalar,
  speechTextChars: scalar,
  speechTextPolicy: scalar,
  speechTextProvenance: scalar,
  chunkCount: scalar,
  firstPlayStartedMs: scalar,
  firstAudibleMs: scalar,
  completedMs: scalar,
  firstChunkRequestToHeadersMs: scalar,
  firstChunkRequestToCompleteAudioReadyMs: scalar,
  maxChunkGapMs: scalar,
  chunkGapsMs: [scalar],
  chunks: [{
    index: scalar,
    textChars: scalar,
    requestToResponseHeadersMs: scalar,
    requestToCompleteAudioReadyMs: scalar,
    playStartedMs: scalar,
    playEndedMs: scalar,
    playDurationMs: scalar,
    previousEndToPlayStartGapMs: scalar,
    audioBytes: scalar,
    httpStatus: scalar,
    responseHeaders: responseHeadersSchema,
  }],
  capabilities: {},
};
const resultRowSchema = {
  ok: scalar,
  label: scalar,
  family: scalar,
  length: scalar,
  iteration: scalar,
  resultMode: scalar,
  resultIntent: scalar,
  conversationDomain: scalar,
  safetyAction: scalar,
  caseExpectation: { expected: expectationValuesSchema, actual: expectationValuesSchema, ok: scalar, failures: [scalar] },
  runtimeStages: { semanticMs: scalar, manualRagMs: scalar, llmMs: scalar, runtimeTotalMs: scalar },
  runtimeToTtsStartMs: scalar,
  ttsResponseMs: scalar,
  submitToFirstAudioPlayMs: scalar,
  submitToFirstAudibleMs: scalar,
  firstTtsRequestToCompleteAudioReadyMs: scalar,
  ttsCompletedMs: scalar,
  maxChunkGapMs: scalar,
  chunkCount: scalar,
  ttsSummary: ttsSummarySchema,
  firstTtsRequest: { status: scalar, reason: scalar, telemetry: responseHeadersSchema },
};
const benchmarkContractSchema = {
  id: scalar,
  minFormalRepeats: scalar,
  requestedRepeats: scalar,
  selectedCaseCount: scalar,
  expectedRuns: scalar,
  observedRuns: scalar,
  successfulRuns: scalar,
  caseExpectationFailures: [{ label: scalar, iteration: scalar, failures: [scalar], actual: expectationValuesSchema }],
  matrixComplete: scalar,
  formalBaselineReady: scalar,
  evidenceLevel: scalar,
  policyCoverage: { speechTextPolicy: scalar, speechTextProvenance: scalar, totalRuns: scalar },
  profileHeaderCoverage: { profileId: scalar, synthesisProfileId: scalar, licenseBoundary: scalar, totalChunks: scalar },
  warnings: [scalar],
};
const hmiVoiceReportSchema = {
  ok: scalar,
  partial: scalar,
  current: { label: scalar, iteration: scalar, status: scalar },
  baseUrl: scalar,
  screenshotPath: scalar,
  resultPath: scalar,
  repeats: scalar,
  streamingPocEnabled: scalar,
  selectedCases: [{ label: scalar, family: scalar, length: scalar }],
  playbackMock: { note: scalar, playbackScale: scalar, minPlaybackMs: scalar, maxPlaybackMs: scalar },
  benchmarkContract: benchmarkContractSchema,
  summary: {
    all: rowSummarySchema,
    byCase: Object.fromEntries(cases.map((item) => [item.label, rowSummarySchema])),
    byFamily: Object.fromEntries(["Manual", "Weather", "General", "Safety"].map((family) => [family, rowSummarySchema])),
    byLength: { short: rowSummarySchema, long: rowSummarySchema },
  },
  results: [resultRowSchema],
  reason: scalar,
};

function projectShape(value, schema) {
  if (schema === scalar) {
    return value === null || ["string", "number", "boolean"].includes(typeof value) ? value : undefined;
  }
  if (Array.isArray(schema)) {
    return Array.isArray(value) ? value.map((item) => projectShape(item, schema[0])) : [];
  }
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(schema).map(([key, nestedSchema]) => [key, projectShape(source[key], nestedSchema)]));
}

export function projectHmiVoiceBenchmarkReport(input) {
  return projectShape(input, hmiVoiceReportSchema);
}


function maxFinite(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  return numeric.length ? Math.max(...numeric) : "unavailable";
}

function percentile(values, percentileValue) {
  const numeric = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!numeric.length) return "unavailable";
  const rank = Math.ceil((Math.max(0, Math.min(100, percentileValue)) / 100) * numeric.length);
  return numeric[Math.max(0, rank - 1)];
}

function summarizeMetric(rows, field) {
  const values = rows.map((row) => row[field]).filter((value) => Number.isFinite(value));
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    min: values.length ? Math.min(...values) : "unavailable",
    max: values.length ? Math.max(...values) : "unavailable",
  };
}

function summarizeRows(rows) {
  return {
    runs: rows.length,
    successfulRuns: rows.filter((row) => row.ok).length,
    submitToFirstAudioPlayMs: summarizeMetric(rows, "submitToFirstAudioPlayMs"),
    // In streaming-PoC mode this is the Web Audio scheduling point reported
    // by the adapter, rather than an HTTP first-byte surrogate.
    submitToFirstAudibleMs: summarizeMetric(rows, "submitToFirstAudibleMs"),
    submitToTtsRequestMs: summarizeMetric(rows, "runtimeToTtsStartMs"),
    firstTtsRequestToCompleteAudioReadyMs: summarizeMetric(rows, "firstTtsRequestToCompleteAudioReadyMs"),
    ttsCompletedMs: summarizeMetric(rows, "ttsCompletedMs"),
    maxChunkGapMs: summarizeMetric(rows, "maxChunkGapMs"),
    chunkCount: summarizeMetric(rows, "chunkCount"),
  };
}

function evaluateCaseExpectation(row) {
  const expected = row.expected || {};
  const failures = [];
  if (expected.intent && row.resultIntent !== expected.intent) failures.push(`intent:${row.resultIntent || "unavailable"}!=${expected.intent}`);
  if (expected.domain && row.conversationDomain !== expected.domain) failures.push(`domain:${row.conversationDomain || "unavailable"}!=${expected.domain}`);
  if (expected.safetyAction && row.safetyAction !== expected.safetyAction) failures.push(`safetyAction:${row.safetyAction || "unavailable"}!=${expected.safetyAction}`);
  return {
    expected,
    actual: {
      intent: row.resultIntent || "unavailable",
      domain: row.conversationDomain || "unavailable",
      safetyAction: row.safetyAction || "unavailable",
    },
    ok: failures.length === 0,
    failures,
  };
}

function countAvailable(values) {
  return values.filter((value) => value && value !== "unavailable").length;
}

function summarizeBenchmarkContract(results) {
  const chunks = results.flatMap((row) => row.ttsSummary?.chunks || []);
  const chunkHeaders = chunks.map((chunk) => chunk.responseHeaders || {});
  const selectedFamilies = [...new Set(selectedCases.map((item) => item.family))];
  const selectedLengths = [...new Set(selectedCases.map((item) => item.length))];
  const matrixComplete = ["Manual", "Weather", "General", "Safety"].every((family) => selectedFamilies.includes(family))
    && ["short", "long"].every((length) => selectedLengths.includes(length));
  const successfulRuns = results.filter((row) => row.ok).length;
  const expectationFailures = results.flatMap((row) => row.caseExpectation?.failures?.length
    ? [{ label: row.label, iteration: row.iteration, failures: row.caseExpectation.failures, actual: row.caseExpectation.actual }]
    : []);
  const expectedRuns = selectedCases.length * repeats;
  return {
    id: "nio-hmi-voice-feedback-benchmark-contract@1.0.0",
    minFormalRepeats: 3,
    requestedRepeats: repeats,
    selectedCaseCount: selectedCases.length,
    expectedRuns,
    observedRuns: results.length,
    successfulRuns,
    caseExpectationFailures: expectationFailures,
    matrixComplete,
    formalBaselineReady: repeats >= 3 && matrixComplete && results.length === expectedRuns && successfulRuns === expectedRuns && expectationFailures.length === 0,
    evidenceLevel: repeats >= 3 && matrixComplete ? "formal-candidate" : "exploratory",
    policyCoverage: {
      speechTextPolicy: countAvailable(results.map((row) => row.ttsSummary?.speechTextPolicy)),
      speechTextProvenance: countAvailable(results.map((row) => row.ttsSummary?.speechTextProvenance)),
      totalRuns: results.length,
    },
    profileHeaderCoverage: {
      profileId: countAvailable(chunkHeaders.map((headers) => headers["x-nio-tts-profile-id"])),
      synthesisProfileId: countAvailable(chunkHeaders.map((headers) => headers["x-nio-tts-synthesis-profile-id"])),
      licenseBoundary: countAvailable(chunkHeaders.map((headers) => headers["x-nio-tts-license-boundary"])),
      totalChunks: chunks.length,
    },
    warnings: [
      repeats < 3 ? "repeats_below_formal_baseline_minimum" : "",
      matrixComplete ? "" : "selected_cases_do_not_cover_full_family_length_matrix",
      results.length === expectedRuns ? "" : "missing_expected_runs",
      successfulRuns === results.length ? "" : "some_runs_did_not_complete_successfully",
      expectationFailures.length === 0 ? "" : "case_expectation_failures",
    ].filter(Boolean),
  };
}

function buildRuntimeStages(events = []) {
  const find = (agentId, status) => events.find((event) => event.agentId === agentId && (!status || event.status === status));
  const elapsed = (start, end) => Number.isFinite(start?.observedMs) && Number.isFinite(end?.observedMs)
    ? Math.max(0, end.observedMs - start.observedMs)
    : "unavailable";
  const runtimeStart = find("edgeRuntime");
  const semanticDone = find("edgeSlm", "done");
  const conversationStart = find("conversation", "thinking");
  const manualRagDone = find("toolRag");
  const llmStart = find("cloudPrompt");
  const llmDone = find("cloudLlm");
  const runtimeDone = find("response");
  return {
    semanticMs: elapsed(runtimeStart, semanticDone),
    manualRagMs: elapsed(conversationStart, manualRagDone),
    llmMs: elapsed(llmStart, llmDone),
    runtimeTotalMs: elapsed(runtimeStart, runtimeDone),
  };
}

function summarizeTts(tts) {
  const chunks = Array.isArray(tts?.chunks) ? tts.chunks : [];
  return {
    provider: tts?.provider || "unavailable",
    status: tts?.status || "unavailable",
    displayTextChars: Number.isFinite(tts?.displayTextChars) ? tts.displayTextChars : "unavailable",
    speechTextChars: Number.isFinite(tts?.speechTextChars) ? tts.speechTextChars : "unavailable",
    speechTextPolicy: tts?.speechTextPolicy || "unavailable",
    speechTextProvenance: tts?.speechTextProvenance || "unavailable",
    chunkCount: Number.isFinite(tts?.chunkCount) ? tts.chunkCount : chunks.length,
    firstPlayStartedMs: Number.isFinite(tts?.firstPlayStartedMs) ? tts.firstPlayStartedMs : "unavailable",
    firstAudibleMs: Number.isFinite(tts?.firstAudibleMs) ? tts.firstAudibleMs : "unavailable",
    completedMs: Number.isFinite(tts?.completedMs) ? tts.completedMs : "unavailable",
    firstChunkRequestToHeadersMs: Number.isFinite(chunks[0]?.requestToResponseHeadersMs) ? chunks[0].requestToResponseHeadersMs : "unavailable",
    firstChunkRequestToCompleteAudioReadyMs: Number.isFinite(chunks[0]?.requestToCompleteAudioReadyMs) ? chunks[0].requestToCompleteAudioReadyMs : "unavailable",
    maxChunkGapMs: Number.isFinite(tts?.maxChunkGapMs) ? tts.maxChunkGapMs : maxFinite(chunks.map((chunk) => chunk.previousEndToPlayStartGapMs)),
    chunkGapsMs: Array.isArray(tts?.chunkGapsMs) ? tts.chunkGapsMs : chunks.map((chunk) => chunk.previousEndToPlayStartGapMs).filter(Number.isFinite),
    chunks: chunks.map((chunk) => ({
      index: chunk.index,
      textChars: chunk.textChars,
      requestToResponseHeadersMs: chunk.requestToResponseHeadersMs,
      requestToCompleteAudioReadyMs: chunk.requestToCompleteAudioReadyMs,
      playStartedMs: chunk.playStartedMs,
      playEndedMs: chunk.playEndedMs,
      playDurationMs: chunk.playDurationMs,
      previousEndToPlayStartGapMs: chunk.previousEndToPlayStartGapMs,
      audioBytes: chunk.audioBytes,
      httpStatus: chunk.httpStatus,
      responseHeaders: chunk.responseHeaders,
    })),
    capabilities: tts?.capabilities || {},
  };
}

function buildSummary(results) {
  const byCase = Object.fromEntries(
    selectedCases.map((item) => [
      item.label,
      summarizeRows(results.filter((row) => row.label === item.label)),
    ]),
  );
  const byFamily = Object.fromEntries(
    [...new Set(selectedCases.map((item) => item.family))].map((family) => [
      family,
      summarizeRows(results.filter((row) => row.family === family)),
    ]),
  );
  const byLength = Object.fromEntries(
    [...new Set(selectedCases.map((item) => item.length))].map((length) => [
      length,
      summarizeRows(results.filter((row) => row.length === length)),
    ]),
  );
  return {
    all: summarizeRows(results),
    byCase,
    byFamily,
    byLength,
  };
}

async function writePartialResults(results, current = null) {
  const output = projectHmiVoiceBenchmarkReport({
    ok: false,
    partial: true,
    current,
    baseUrl,
    screenshotPath,
    resultPath,
    repeats,
    streamingPocEnabled,
    selectedCases: selectedCases.map(({ label, family, length }) => ({ label, family, length })),
    benchmarkContract: summarizeBenchmarkContract(results),
    summary: buildSummary(results),
    results,
  });
  await fs.writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
}

async function main() {
  const browser = await launchChromium();
  const page = await browser.newPage();

  try {
  await page.addInitScript((enabled) => {
    // Must run before app.js constructs VoiceOutputAdapter.
    window.NIO_TTS_STREAMING_POC = enabled;
  }, streamingPocEnabled);
  await page.addInitScript(({ playbackScale, minPlaybackMs, maxPlaybackMs }) => {
    function wavDurationSecondsFromBuffer(buffer) {
      const view = new DataView(buffer);
      const ascii = (offset, length) => Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join("");
      if (buffer.byteLength < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return null;
      let offset = 12;
      let byteRate = 0;
      let dataSize = 0;
      while (offset + 8 <= buffer.byteLength) {
        const id = ascii(offset, 4);
        const size = view.getUint32(offset + 4, true);
        const dataOffset = offset + 8;
        if (dataOffset + size > buffer.byteLength) return null;
        if (id === "fmt " && size >= 16) byteRate = view.getUint32(dataOffset + 8, true);
        if (id === "data") dataSize = size;
        offset = dataOffset + size + (size % 2);
      }
      return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
    }

    window.__voiceFeedbackBaseline = { requests: [], objectUrls: new Map() };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const url = String(args[0] instanceof Request ? args[0].url : args[0]);
      const record = url.includes("/api/tts") ? { startedAt: performance.now() } : null;
      if (record) window.__voiceFeedbackBaseline.requests.push(record);
      try {
        const response = await nativeFetch(...args);
        if (record) {
          record.completedAt = performance.now();
          record.status = response.status;
          record.telemetry = Object.fromEntries([
            "x-nio-tts-proxy-total-ms",
            "x-nio-tts-upstream-first-response-ms",
            "x-nio-tts-upstream-complete-read-ms",
            "x-nio-tts-audio-bytes",
            "x-nio-tts-status",
            "x-nio-tts-streaming-mode",
            "x-nio-tts-profile-id",
            "x-nio-tts-profile-version",
            "x-nio-tts-synthesis-profile-id",
            "x-nio-tts-license-boundary",
          ].map((name) => [name, response.headers.get(name) || "unavailable"]));
        }
        return response;
      } catch (error) {
        if (record) {
          record.completedAt = performance.now();
          record.error = error.message;
        }
        throw error;
      }
    };

    let objectUrlCounter = 0;
    const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const objectUrl = `blob:tts-benchmark-${++objectUrlCounter}`;
      const durationPromise = blob.arrayBuffer()
        .then((buffer) => wavDurationSecondsFromBuffer(buffer))
        .then((seconds) => {
          const scaled = Number.isFinite(seconds) ? seconds * 1000 * playbackScale : minPlaybackMs;
          return Math.max(minPlaybackMs, Math.min(maxPlaybackMs, Math.round(scaled)));
        })
        .catch(() => minPlaybackMs);
      window.__voiceFeedbackBaseline.objectUrls.set(objectUrl, durationPromise);
      try {
        nativeCreateObjectUrl(blob);
      } catch {
        // The mocked Audio class never consumes the browser object URL.
      }
      return objectUrl;
    };
    URL.revokeObjectURL = (objectUrl) => {
      window.__voiceFeedbackBaseline.objectUrls.delete(objectUrl);
      try {
        nativeRevokeObjectUrl(objectUrl);
      } catch {
        // Ignore synthetic blob URLs.
      }
    };

    window.Audio = class AudioMock extends EventTarget {
      constructor(objectUrl) {
        super();
        this.currentTime = 0;
        this.objectUrl = objectUrl;
      }
      async play() {
        this.onplay?.();
        this.dispatchEvent(new Event("playing"));
        const durationMs = await (window.__voiceFeedbackBaseline.objectUrls.get(this.objectUrl) || Promise.resolve(minPlaybackMs));
        window.setTimeout(() => {
          this.onended?.();
          this.dispatchEvent(new Event("ended"));
        }, durationMs);
      }
      pause() {}
    };
  }, { playbackScale, minPlaybackMs, maxPlaybackMs });
  await installVoicePlaybackProbe({ page });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.runCommand === "function", null, { timeout: 15_000 });

  const results = [];
  for (const item of selectedCases) {
    for (let iteration = 1; iteration <= repeats; iteration += 1) {
      const progressLabel = `${item.label} ${iteration}/${repeats}`;
      console.error(`[hmi-voice-benchmark] start ${progressLabel}`);
      await writePartialResults(results, { label: item.label, iteration, status: "running" });
      const result = await page.evaluate(async ({ input, label, family, length, iteration, expected, perCaseTimeoutMs }) => {
        const baseline = window.__voiceFeedbackBaseline;
        const requestIndex = baseline.requests.length;
        const submitAt = performance.now();
        const runResult = await window.runCommand(input);
        const deadline = performance.now() + perCaseTimeoutMs;
        while (performance.now() < deadline) {
          const run = (window.__runtimeDebug?.() || window.__vehicleDebug?.())?.latestRun;
          const tts = run?.ttsTelemetry;
          if (tts?.status === "completed" || tts?.status === "unavailable" || tts?.status === "failed" || tts?.status === "fallback") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const debug = window.__runtimeDebug?.() || window.__vehicleDebug?.();
        const run = debug?.latestRun || {};
        const latestResult = run.result || debug?.lastRuntimeResult || runResult || {};
        const runtimeEvents = runResult?.events || debug?.lastRuntimeResult?.events || [];
        const request = baseline.requests[requestIndex] || null;
        return {
          label,
          family,
          length,
          iteration,
          expected,
          requestId: run.requestId || latestResult.requestId || null,
          submitAt,
          request,
          runtimeEvents,
          ttsTelemetry: run.ttsTelemetry || null,
          resultMode: latestResult.mode || "unavailable",
          resultIntent: latestResult.parsedCommand?.intent || "unavailable",
          conversationDomain: latestResult.parsedCommand?.conversationGoal?.domain || "unavailable",
          safetyAction: latestResult.safetyDecision?.action || "unavailable",
        };
      }, { ...item, iteration, perCaseTimeoutMs });

      const ttsSummary = summarizeTts(result.ttsTelemetry);
      const caseExpectation = evaluateCaseExpectation(result);
      let voiceObservation = null;
      if (typeof result.requestId === "string" && result.requestId) {
        await recordVoiceSubmission({
          page,
          requestId: result.requestId,
          submittedAtPerf: result.submitAt,
        });
        voiceObservation = await observeVoicePlayback({
          page,
          requestId: result.requestId,
          timeoutMs: perCaseTimeoutMs,
        }).catch(() => null);
      }
      results.push({
        ok: isVoicePlaybackProviderObservation(voiceObservation) && caseExpectation.ok,
        label: result.label,
        family: result.family,
        length: result.length,
        iteration: result.iteration,
        resultMode: result.resultMode,
        resultIntent: result.resultIntent,
        conversationDomain: result.conversationDomain,
        safetyAction: result.safetyAction,
        caseExpectation,
        runtimeStages: buildRuntimeStages(result.runtimeEvents),
        runtimeToTtsStartMs: result.request ? Math.round(result.request.startedAt - result.submitAt) : "unavailable",
        ttsResponseMs: result.request?.completedAt ? Math.round(result.request.completedAt - result.request.startedAt) : "unavailable",
        submitToFirstAudioPlayMs: Number.isFinite(voiceObservation?.submissionToFirstAudioPlaybackMs)
          ? Math.round(voiceObservation.submissionToFirstAudioPlaybackMs)
          : "unavailable",
        submitToFirstAudibleMs: result.request && Number.isFinite(ttsSummary.firstAudibleMs)
          ? Math.round((result.request.startedAt - result.submitAt) + ttsSummary.firstAudibleMs)
          : "unavailable",
        firstTtsRequestToCompleteAudioReadyMs: ttsSummary.firstChunkRequestToCompleteAudioReadyMs,
        ttsCompletedMs: ttsSummary.completedMs,
        maxChunkGapMs: ttsSummary.maxChunkGapMs,
        chunkCount: ttsSummary.chunkCount,
        ttsSummary,
        firstTtsRequest: result.request ? {
          status: result.request.status,
          reason: result.request.error ? "tts-request-failed" : "tts-request-completed",
          telemetry: result.request.telemetry,
        } : null,
      });
      await writePartialResults(results, { label: item.label, iteration, status: "completed" });
      console.error(`[hmi-voice-benchmark] done ${progressLabel}`);
    }
  }

  await page.screenshot({ path: screenshotPath, fullPage: true });
  const output = projectHmiVoiceBenchmarkReport({
    ok: results.every((row) => row.ok),
    baseUrl,
    screenshotPath,
    resultPath,
    repeats,
    streamingPocEnabled,
    selectedCases: selectedCases.map(({ label, family, length }) => ({ label, family, length })),
    playbackMock: {
      note: streamingPocEnabled
        ? "Streaming PoC is enabled before app initialization. submitToFirstAudibleMs comes from VoiceOutputAdapter Web Audio scheduling telemetry; it is not an HTTP first-byte metric."
        : "Audio.play is mocked. The first-play metric is the browser moment complete buffered audio can begin playback; chunk completion/gap uses WAV-duration-scaled mock playback to drive onended.",
      playbackScale,
      minPlaybackMs,
      maxPlaybackMs,
    },
    benchmarkContract: summarizeBenchmarkContract(results),
    summary: buildSummary(results),
    results,
  });
  await fs.writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
  } catch {
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const output = projectHmiVoiceBenchmarkReport({ ok: false, baseUrl, screenshotPath, resultPath, reason: "benchmark-failed" });
  await fs.writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`).catch(() => {});
  console.error(JSON.stringify(output, null, 2));
  process.exitCode = 1;
  } finally {
  await browser.close();
  }
}

const isCliEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) {
  main().catch(() => {
    const output = projectHmiVoiceBenchmarkReport({ ok: false, baseUrl, screenshotPath, resultPath, reason: "benchmark-failed" });
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  });
}
