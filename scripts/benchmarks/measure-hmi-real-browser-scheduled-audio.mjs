import { launchChromium } from "../lib/playwright-loader.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseUrl = process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173";
const resultPath = process.env.NIO_HMI_REAL_BROWSER_AUDIO_RESULT || "/tmp/nio-hmi-real-browser-scheduled-audio.json";
const timeoutMs = Number.parseInt(process.env.NIO_HMI_REAL_BROWSER_AUDIO_TIMEOUT_MS || "120000", 10);
const input = process.env.NIO_HMI_REAL_BROWSER_AUDIO_INPUT || "你好，简单介绍一下你能帮我做什么。";
// Default remains a fast first-scheduled-audio probe.  Completion timing is
// opt-in because it includes the full utterance playback duration.
const waitForCompletion = process.env.NIO_HMI_REAL_BROWSER_AUDIO_WAIT_FOR_COMPLETION === "true";

const scalar = Symbol("safe-report-scalar");
const eventSchema = { agent: scalar, status: scalar, time: scalar, observedMs: scalar, durationMs: scalar };
const ttsChunkSchema = {
  index: scalar,
  chars: scalar,
  requestStartMs: scalar,
  responseHeadersMs: scalar,
  firstBodyMs: scalar,
  completeAudioReadyMs: scalar,
  scheduledMs: scalar,
  playStartedMs: scalar,
  previousEndToPlayStartGapMs: scalar,
  streamScheduleGapsMs: [scalar],
};
const scheduledAudioReportSchema = {
  ok: scalar,
  measurement: scalar,
  physicalAcousticMeasurement: scalar,
  waitForCompletion: scalar,
  inputChars: scalar,
  submittedAtMs: scalar,
  resultIntent: scalar,
  ttsStatus: scalar,
  completionWait: { enabled: scalar, timedOut: scalar, latestRunCaptured: scalar, latestRunReplaced: scalar },
  scheduledFirstAudioMs: scalar,
  adapterScheduledFirstAudioMs: scalar,
  latestRunTelemetry: {
    runtime: { status: scalar, startedAt: scalar, endedAt: scalar, durationMs: scalar, events: [eventSchema] },
    semantic: { provider: scalar, durationMs: scalar },
    llm: {
      provider: scalar,
      model: scalar,
      durationMs: scalar,
      promptChars: scalar,
      promptEvalDurationMs: scalar,
      promptEvalCount: scalar,
      evalDurationMs: scalar,
      evalCount: scalar,
    },
    manual: {
      query: { chars: scalar, knowledgeNeed: scalar, actionNeed: scalar, adaptiveK: scalar },
      evidence: {
        status: scalar,
        count: scalar,
        durationMs: scalar,
        retrievalMode: scalar,
        eligibility: { acceptedCount: scalar, rejectedCount: scalar, missReason: scalar, applicable: scalar },
      },
    },
    tts: {
      provider: scalar,
      status: scalar,
      startedAtMs: scalar,
      completedMs: scalar,
      request: { startMs: scalar, responseHeadersMs: scalar, requestToResponseHeadersMs: scalar, diagnosticRequestId: scalar },
      body: { firstBodyMs: scalar, completeAudioReadyMs: scalar, requestToCompleteAudioReadyMs: scalar },
      schedule: {
        scheduledFirstAudioMs: scalar,
        firstPlayStartedMs: scalar,
        maxStreamScheduleGapMs: scalar,
        streamScheduleGapsMs: [scalar],
        playbackGapsMs: [scalar],
      },
      chunks: [ttsChunkSchema],
    },
    bridge: {
      allowed: scalar,
      reason: scalar,
      policy: { id: scalar, version: scalar },
      status: scalar,
      assetStatus: scalar,
      selectedAssetId: scalar,
      initialTier: scalar,
      selectionBasis: scalar,
      answerCharacters: scalar,
      estimatedSpeechMs: scalar,
      queueAssetIds: [scalar],
      playedAssetIds: [scalar],
      assetFailures: [scalar],
      browserFallbackUsed: scalar,
      startedMs: scalar,
      firstPlayStartedMs: scalar,
      completedMs: scalar,
      completionSource: scalar,
      watchdogTriggered: scalar,
      watchdogDurationMs: scalar,
      watchdogGraceMs: scalar,
      queueState: { cursor: scalar, remaining: scalar },
      cancelReason: scalar,
      cancelledMs: scalar,
      queueGapMs: scalar,
      maxAssets: scalar,
      elapsedWaitMs: scalar,
    },
  },
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

export function projectScheduledAudioBenchmarkReport(input) {
  return projectShape(input, scheduledAudioReportSchema);
}

async function main() {
  const browser = await launchChromium();
  const page = await browser.newPage();

  try {
  // Page initialization only: it selects the existing opt-in streaming PoC.
  // This harness intentionally does not intercept or replace network/audio APIs.
  await page.addInitScript(() => { window.NIO_TTS_STREAMING_POC = true; });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.runCommand === "function", null, { timeout: 15_000 });
  const result = await page.evaluate(async ({ input, timeoutMs, waitForCompletion }) => {
    const available = (value) => Number.isFinite(value) ? Math.round(value) : "unavailable";
    const telemetryDuration = (telemetry) => available(telemetry?.durationMs);
    const summarizeEvents = (events) => {
      let previousMs = 0;
      return (Array.isArray(events) ? events : []).map((event) => {
        const observedMs = available(event?.observedMs);
        const durationMs = Number.isFinite(event?.observedMs)
          ? Math.round(event.observedMs - previousMs)
          : "unavailable";
        if (Number.isFinite(event?.observedMs)) previousMs = event.observedMs;
        return {
          agent: String(event?.agentId || "unavailable"),
          status: String(event?.status || "unavailable"),
          time: String(event?.observedAt || "unavailable"),
          observedMs,
          durationMs,
        };
      });
    };
    const summarizeManualEvidence = (manualEvidence, manualQueryPlan) => {
      const telemetry = manualEvidence?.telemetry || {};
      return {
        query: {
          chars: Number.isFinite(manualEvidence?.queryChars) ? manualEvidence.queryChars : "unavailable",
          knowledgeNeed: manualQueryPlan?.knowledgeNeed || "unavailable",
          actionNeed: manualQueryPlan?.actionNeed || "unavailable",
          adaptiveK: Number.isFinite(manualQueryPlan?.adaptiveK) ? manualQueryPlan.adaptiveK : "unavailable",
        },
        evidence: {
          status: manualEvidence?.status || "not-requested",
          count: Array.isArray(manualEvidence?.evidence) ? manualEvidence.evidence.length : 0,
          durationMs: telemetryDuration(telemetry),
          retrievalMode: telemetry.retrievalMode || "unavailable",
          eligibility: {
            acceptedCount: Number.isFinite(telemetry.acceptedCount) ? telemetry.acceptedCount : "unavailable",
            rejectedCount: Number.isFinite(telemetry.rejectedCount) ? telemetry.rejectedCount : "unavailable",
            missReason: telemetry.missReason || "",
            applicable: telemetry.corpusApplicability?.applicable ?? "unavailable",
          },
        },
      };
    };
    const summarizeChunk = (chunk, index, tts) => {
      const streamScheduleGapsMs = (Array.isArray(chunk?.streamScheduleGapsMs) ? chunk.streamScheduleGapsMs : [])
        .filter(Number.isFinite)
        .map(Math.round);
      return {
        index: Number.isFinite(chunk?.index) ? chunk.index : index,
        // Character counts and timing only: no speech text or audio bytes.
        chars: Number.isFinite(chunk?.textChars) ? chunk.textChars : "unavailable",
        requestStartMs: available(chunk?.requestStartMs),
        responseHeadersMs: available(chunk?.responseHeadersMs),
        firstBodyMs: available(chunk?.streamChunkArrivalMs?.[0]),
        completeAudioReadyMs: available(chunk?.completeAudioReadyMs),
        // Streaming PoC exposes a precise source.start scheduling time only
        // for the first source. Later entries expose their actual gaps below.
        scheduledMs: index === 0 ? available(tts?.scheduledFirstAudioMs) : "unavailable",
        playStartedMs: index === 0 ? available(tts?.firstPlayStartedMs) : available(chunk?.playStartedMs),
        previousEndToPlayStartGapMs: available(chunk?.previousEndToPlayStartGapMs),
        streamScheduleGapsMs,
      };
    };
    const summarizeTts = (tts) => {
      const chunks = Array.isArray(tts?.chunks) ? tts.chunks : [];
      const timingChunks = chunks.map((chunk, index) => summarizeChunk(chunk, index, tts));
      const streamScheduleGapsMs = timingChunks.flatMap((chunk) => chunk.streamScheduleGapsMs);
      const playbackGapsMs = timingChunks
        .map((chunk) => chunk.previousEndToPlayStartGapMs)
        .filter(Number.isFinite);
      return {
        provider: tts?.provider || "unavailable",
        status: tts?.status || "unavailable",
        startedAtMs: available(tts?.startedAtMs),
        completedMs: available(tts?.completedMs),
        request: {
          startMs: available(chunks[0]?.requestStartMs),
          responseHeadersMs: available(chunks[0]?.responseHeadersMs),
          requestToResponseHeadersMs: available(chunks[0]?.requestToResponseHeadersMs),
          diagnosticRequestId: chunks[0]?.responseHeaders?.["x-nio-tts-diagnostic-request-id"] || "unavailable",
        },
        body: {
          firstBodyMs: available(chunks[0]?.streamChunkArrivalMs?.[0]),
          completeAudioReadyMs: available(chunks[0]?.completeAudioReadyMs),
          requestToCompleteAudioReadyMs: available(chunks[0]?.requestToCompleteAudioReadyMs),
        },
        schedule: {
          scheduledFirstAudioMs: available(tts?.scheduledFirstAudioMs),
          firstPlayStartedMs: available(tts?.firstPlayStartedMs),
          maxStreamScheduleGapMs: available(tts?.maxStreamScheduleGapMs),
          streamScheduleGapsMs,
          playbackGapsMs,
        },
        chunks: timingChunks,
      };
    };
    const summarizeBridge = (bridge) => {
      const policyId = typeof bridge?.policyId === "string" ? bridge.policyId : "unavailable";
      const policyVersion = policyId.includes("@") ? policyId.slice(policyId.lastIndexOf("@") + 1) : "unavailable";
      // Deliberately keep this narrower than the runtime bridge telemetry: no
      // bridge text, asset metadata/URL, manifest/provenance or audio data.
      return {
        allowed: bridge?.allowed === true,
        reason: bridge?.reason || "unavailable",
        policy: { id: policyId, version: policyVersion },
        status: bridge?.status || "unavailable",
        assetStatus: bridge?.assetStatus || "unavailable",
        selectedAssetId: bridge?.asset?.assetId || "unavailable",
        initialTier: bridge?.initialTier || "unavailable",
        selectionBasis: bridge?.selectionBasis || "unavailable",
        answerCharacters: Number.isFinite(bridge?.answerCharacters) ? bridge.answerCharacters : "unavailable",
        estimatedSpeechMs: available(bridge?.estimatedSpeechMs),
        queueAssetIds: Array.isArray(bridge?.queue) ? bridge.queue.map(String) : [],
        playedAssetIds: Array.isArray(bridge?.playedAssetIds) ? bridge.playedAssetIds.map(String) : [],
        assetFailures: Array.isArray(bridge?.assetFailures) ? bridge.assetFailures.map(String) : [],
        browserFallbackUsed: bridge?.browserFallbackUsed === true,
        startedMs: available(bridge?.startedMs),
        firstPlayStartedMs: available(bridge?.firstPlayStartedMs),
        completedMs: available(bridge?.completedMs),
        completionSource: bridge?.completionSource === "ended" || bridge?.completionSource === "watchdog" ? bridge.completionSource : "unavailable",
        watchdogTriggered: bridge?.watchdogTriggered === true,
        watchdogDurationMs: available(bridge?.watchdogDurationMs),
        watchdogGraceMs: available(bridge?.watchdogGraceMs),
        queueState: {
          cursor: Number.isFinite(bridge?.queueState?.cursor) ? bridge.queueState.cursor : "unavailable",
          remaining: Number.isFinite(bridge?.queueState?.remaining) ? bridge.queueState.remaining : "unavailable",
        },
        cancelReason: bridge?.cancelReason || "unavailable",
        cancelledMs: available(bridge?.cancelledMs),
        queueGapMs: available(bridge?.queueGapMs),
        maxAssets: Number.isFinite(bridge?.maxPrebakedAssetsPerRun) ? bridge.maxPrebakedAssetsPerRun : "unavailable",
        elapsedWaitMs: available(bridge?.elapsedWaitMs),
      };
    };
    const submitAt = performance.now();
    const runResult = await window.runCommand(input);
    // Bind the observation to the run created by this command. Do not let a
    // later command's latestRun satisfy this measurement's completion state.
    const initialDebug = window.__runtimeDebug?.() || window.__vehicleDebug?.();
    const measuredRun = initialDebug?.latestRun || null;
    const deadline = performance.now() + timeoutMs;
    let completionWaitTimedOut = false;
    let latestRunReplaced = false;
    while (performance.now() < deadline) {
      const run = (window.__runtimeDebug?.() || window.__vehicleDebug?.())?.latestRun;
      if (measuredRun && run !== measuredRun) {
        latestRunReplaced = true;
        break;
      }
      const tts = run?.ttsTelemetry;
      const terminal = ["completed", "failed", "fallback", "unavailable"].includes(tts?.status);
      if (waitForCompletion ? terminal : (Number.isFinite(tts?.scheduledFirstAudioMs) || terminal)) break;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (waitForCompletion && performance.now() >= deadline) completionWaitTimedOut = true;
    // Do not fall through to a potentially newer latestRun at reporting time.
    const run = measuredRun || {};
    const tts = run.ttsTelemetry || null;
    const runtimeResult = run.result || {};
    const semanticTelemetry = runtimeResult.semanticTelemetry || {};
    const llmTelemetry = runtimeResult.cloudResult?.telemetry || runtimeResult.conversationResult?.telemetry || {};
    return {
      submittedAtMs: Math.round(submitAt),
      resultIntent: runResult?.parsedCommand?.intent || run.result?.parsedCommand?.intent || "unavailable",
      ttsStatus: tts?.status || "unavailable",
      completionWait: {
        enabled: waitForCompletion,
        timedOut: completionWaitTimedOut,
        latestRunCaptured: Boolean(measuredRun),
        latestRunReplaced,
      },
      scheduledFirstAudioMs: Number.isFinite(tts?.scheduledFirstAudioMs) && Number.isFinite(tts?.startedAtMs)
        ? Math.round((tts.startedAtMs - submitAt) + tts.scheduledFirstAudioMs)
        : "unavailable",
      adapterScheduledFirstAudioMs: Number.isFinite(tts?.scheduledFirstAudioMs) ? tts.scheduledFirstAudioMs : "unavailable",
      // This whitelist intentionally omits user input/history, prompts, event
      // messages/data, assistant text, manual excerpts and full TTS telemetry.
      latestRunTelemetry: {
        runtime: {
          status: run.error ? "error" : run.endedAt ? "completed" : "running",
          startedAt: run.startedAt || "unavailable",
          endedAt: run.endedAt || "unavailable",
          durationMs: Number.isFinite(run.startedAtPerf) && Number.isFinite(run.endedAtPerf)
            ? Math.round(run.endedAtPerf - run.startedAtPerf)
            : "unavailable",
          events: summarizeEvents(run.events),
        },
        semantic: {
          provider: semanticTelemetry.provider || "unavailable",
          durationMs: telemetryDuration(semanticTelemetry),
        },
        llm: {
          provider: llmTelemetry.provider || "unavailable",
          model: llmTelemetry.model || "unavailable",
          durationMs: telemetryDuration(llmTelemetry),
          promptChars: Number.isFinite(llmTelemetry.promptChars) ? llmTelemetry.promptChars : "unavailable",
          promptEvalDurationMs: available(llmTelemetry.ollamaDurations?.prompt_eval_duration_ms),
          promptEvalCount: Number.isFinite(llmTelemetry.ollamaDurations?.prompt_eval_count) ? llmTelemetry.ollamaDurations.prompt_eval_count : "unavailable",
          evalDurationMs: available(llmTelemetry.ollamaDurations?.eval_duration_ms),
          evalCount: Number.isFinite(llmTelemetry.ollamaDurations?.eval_count) ? llmTelemetry.ollamaDurations.eval_count : "unavailable",
        },
        manual: summarizeManualEvidence(runtimeResult.manualEvidence, runtimeResult.manualQueryPlan),
        tts: summarizeTts(tts),
        bridge: summarizeBridge(tts?.bridge),
      },
    };
  }, { input, timeoutMs, waitForCompletion });
  const output = projectScheduledAudioBenchmarkReport({
    ok: Number.isFinite(result.adapterScheduledFirstAudioMs),
    measurement: "WebAudio source.start scheduling timestamp",
    physicalAcousticMeasurement: false,
    waitForCompletion,
    inputChars: input.length,
    ...result,
  });
  await fs.writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exitCode = 1;
  } catch {
  const output = projectScheduledAudioBenchmarkReport({ ok: false, measurement: "WebAudio source.start scheduling timestamp", physicalAcousticMeasurement: false, reason: "benchmark-failed" });
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
    const output = projectScheduledAudioBenchmarkReport({
      ok: false,
      measurement: "WebAudio source.start scheduling timestamp",
      physicalAcousticMeasurement: false,
      reason: "benchmark-failed",
    });
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  });
}
