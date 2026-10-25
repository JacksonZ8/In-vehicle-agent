import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const originals = {
  window: globalThis.window, fetch: globalThis.fetch, Audio: globalThis.Audio,
  SpeechSynthesisUtterance: globalThis.SpeechSynthesisUtterance, URL: globalThis.URL,
};
const catalog = JSON.parse(await readFile(new URL("../../assets/tts/prebaked/sandrone-dev-zh-waiting-bridge.catalog.json", import.meta.url)));
const timers = new Map();
const spoken = [];
const audioInstances = [];
let nextTimer = 1;
let cancelled = 0;
let remainingAudioFailures = 0;
let remainingPreloadFailures = 0;
let deferPreloadReadiness = false;
let resolveTts;

function runNextTimer() {
  const id = timers.keys().next().value;
  const callback = timers.get(id);
  timers.delete(id);
  callback();
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

try {
  globalThis.URL = { createObjectURL: () => "blob:bridge", revokeObjectURL() {} };
  globalThis.Audio = class {
    constructor(src) { this.src = src; audioInstances.push(this); }
    load() {
      if (remainingPreloadFailures > 0) { remainingPreloadFailures -= 1; this.onerror?.(); return; }
      if (!deferPreloadReadiness) this.oncanplaythrough?.();
    }
    async play() {
      if (remainingAudioFailures > 0) { remainingAudioFailures -= 1; throw new Error("asset failed"); }
      this.onplay?.();
    }
    pause() { this.paused = true; }
  };
  globalThis.window = {
    setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    speechSynthesis: {
      cancel() { cancelled += 1; },
      speak(utterance) { spoken.push(utterance.text); utterance.onstart?.(); },
      pause() {}, resume() {},
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
  };
  globalThis.SpeechSynthesisUtterance = globalThis.window.SpeechSynthesisUtterance;
  globalThis.fetch = (url) => {
    if (String(url).includes("waiting-bridge.catalog")) return Promise.resolve({ ok: true, json: async () => catalog });
    return new Promise((resolve) => { resolveTts = resolve; });
  };

  const { VoiceOutputAdapter, createResponseEnvelope, PREBAKED_WAITING_BRIDGE_CATALOG_URL, VOICE_BRIDGE_POLICY } = await import(`../../src/voice/voice-output-adapter.js?bridge=${Date.now()}`);
  assert.match(PREBAKED_WAITING_BRIDGE_CATALOG_URL, /waiting-bridge\.catalog/);
  assert.equal(VOICE_BRIDGE_POLICY.thresholdMs, 500, "ordinary general bridge must use the approved 500ms trial threshold");
  const samples = [];
  const adapter = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  adapter.onTelemetry = (entry) => samples.push(entry);
  await adapter.prebakedBridgeCatalogPromise;
  assert.equal(audioInstances.filter((audio) => /sandrone-dev-zh-short-/.test(audio.src)).length, 3, "catalog must non-blockingly preload the three short early assets");

  const beforeThresholdBridgeAudioCount = audioInstances.filter((audio) => /sandrone-dev-zh-/.test(audio.src)).length;
  const beforeThreshold = adapter.speak(createResponseEnvelope("阈值前完成。", { voiceBridge: { allowed: true } }));
  assert.equal(adapter.ttsTelemetry.bridge.status, "waiting-threshold");
  resolveTts({ ok: true, status: 200, headers: new Headers({ "content-type": "audio/wav" }), blob: async () => new Blob(["audio"]) });
  await beforeThreshold;
  assert.equal(adapter.bridgeAudio, null, "final TTS handoff before the 500ms threshold must not start a pre-baked asset");
  assert.equal(audioInstances.filter((audio) => /sandrone-dev-zh-/.test(audio.src)).length, beforeThresholdBridgeAudioCount, "a completed response before the threshold must not construct a bridge asset");

  const pending = adapter.speak(createResponseEnvelope("短答。", { voiceBridge: { allowed: true } }));
  assert.equal(adapter.ttsTelemetry.bridge.thresholdMs, 500);
  runNextTimer();
  assert.match(adapter.bridgeAudio.src, /sandrone-dev-zh-short-/);
  const bridgeAudio = audioInstances.find((audio) => /sandrone-dev-zh-short-processing\.wav$/.test(audio.src));
  assert.equal(samples.at(-1).bridge.asset.tier, "short");
  assert.equal(samples.at(-1).bridge.selectionBasis, "estimated-answer-character-count-not-real-time-progress");
  assert.equal(samples.at(-1).bridge.estimatedSpeechMs, 545, "estimated duration must be explicit telemetry, not live progress");
  assert.deepEqual(samples.at(-1).bridge.queue.length, 1, "each request may plan only one neutral asset");
  assert.deepEqual(samples.at(-1).bridge.playedAssetIds, ["short-processing"]);
  assert.deepEqual(samples.at(-1).bridge.assetPreload, { state: "ready", selected: "cached", failureType: null }, "early bridge must reuse a ready preloaded asset");
  assert.doesNotMatch(JSON.stringify(samples.at(-1).bridge), /\.wav|正在为你处理/, "bridge telemetry must not expose asset paths or bridge text");
  resolveTts({ ok: true, status: 200, headers: new Headers({ "content-type": "audio/wav" }), blob: async () => new Blob(["audio"]) });
  await pending;
  assert.equal(samples.at(-1).bridge.status, "cancelled", "final TTS handoff must cancel the asset");
  assert.equal(bridgeAudio.paused, true);

  deferPreloadReadiness = true;
  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalog }) : new Promise(() => {});
  const notReady = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await notReady.prebakedBridgeCatalogPromise;
  void notReady.speak(createResponseEnvelope("缓存未就绪。", { voiceBridge: { allowed: true } }));
  runNextTimer();
  assert.equal(notReady.ttsTelemetry.bridge.assetPreload.selected, "not-cached", "loading cache must preserve the existing non-cached play path");
  notReady.stop();
  deferPreloadReadiness = false;

  remainingPreloadFailures = 3;
  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalog }) : new Promise(() => {});
  const preloadFailed = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await preloadFailed.prebakedBridgeCatalogPromise;
  void preloadFailed.speak(createResponseEnvelope("预载失败。", { voiceBridge: { allowed: true } }));
  runNextTimer();
  assert.equal(preloadFailed.ttsTelemetry.bridge.assetPreload.failureType, "preload-audio-error", "preload failure must be labeled without a URL or message");
  assert.equal(preloadFailed.ttsTelemetry.bridge.assetPreload.selected, "not-cached", "preload failure must retain existing playback/fallback behavior");
  preloadFailed.stop();

  let resolveEarlyTts;
  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalog })
    : new Promise((resolve) => { resolveEarlyTts = resolve; });
  const early = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await early.prebakedBridgeCatalogPromise;
  assert.equal(early.startEarlyBridge({ requestId: "early-1", turnId: "turn:early-1", interactionEventId: "event:early-1", allowed: true, reason: "ordinary-general-conversation", policyId: "runtime-policy", policyVersion: "1", noToolOrSafetyPath: true }), true);
  const earlyPlayId = early.playId;
  const earlyTimerCount = timers.size;
  assert.equal(early.startEarlyBridge({ requestId: "early-1-retry", turnId: "turn:early-1", interactionEventId: "event:early-1-retry", allowed: true, reason: "ordinary-general-conversation", policyId: "runtime-policy", policyVersion: "1", noToolOrSafetyPath: true }), false,
    "a second event-backed authorization for one Turn must not start another progress asset");
  assert.equal(early.playId, earlyPlayId, "same-Turn progress suppression must not replace playback");
  assert.equal(timers.size, earlyTimerCount, "same-Turn progress suppression must not schedule another threshold");
  runNextTimer();
  const earlyAudio = early.bridgeAudio;
  assert.equal(early.ttsTelemetry.bridge.selectionBasis, "early-authorization-not-final-answer-length");
  assert.equal(early.ttsTelemetry.bridge.answerCharacters, null, "early selection must not claim the final length exists");
  const earlyPending = early.speak(createResponseEnvelope("最终回答已经生成。", { voiceBridge: { requestId: "early-1", allowed: true } }));
  assert.equal(earlyAudio.paused, undefined, "final speak must preserve the already playing early asset until final audio starts");
  assert.equal(early.ttsTelemetry.bridge.finalAnswerSelectionBasis, "final-answer-character-count-after-early-authorization");
  resolveEarlyTts({ ok: true, status: 200, headers: new Headers({ "content-type": "audio/wav" }), blob: async () => new Blob(["audio"]) });
  await earlyPending;
  early.stop();

  // The final answer must preserve the early bridge's playId only for this
  // matching Runtime request. Watchdog completion ends the one neutral asset
  // and leaves the user in silence until final Sandrone audio is ready.
  let resolveEarlyWatchdogTts;
  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalog })
    : new Promise((resolve) => { resolveEarlyWatchdogTts = resolve; });
  const earlyWatchdog = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await earlyWatchdog.prebakedBridgeCatalogPromise;
  assert.equal(earlyWatchdog.startEarlyBridge({ requestId: "early-watchdog", allowed: true, reason: "ordinary-general-conversation", policyId: "runtime-policy", policyVersion: "1", noToolOrSafetyPath: true }), true);
  runNextTimer();
  const firstEarlyWatchdogAudio = earlyWatchdog.bridgeAudio;
  const earlyWatchdogPending = earlyWatchdog.speak(createResponseEnvelope("同请求最终回答。", { voiceBridge: { requestId: "early-watchdog", allowed: true } }));
  runNextTimer();
  assert.equal(firstEarlyWatchdogAudio.paused, true, "preserved early watchdog must complete the first asset");
  assert.deepEqual(earlyWatchdog.ttsTelemetry.bridge.completionSources, ["watchdog"]);
  assert.equal(earlyWatchdog.bridgeAudio, null, "watchdog must not start another neutral asset");
  assert.equal(earlyWatchdog.ttsTelemetry.bridge.status, "completed");
  resolveEarlyWatchdogTts({ ok: true, status: 200, headers: new Headers({ "content-type": "audio/wav" }), blob: async () => new Blob(["audio"]) });
  await earlyWatchdogPending;
  assert.equal(timers.size, 0, "final handoff must leave no bridge timer");
  earlyWatchdog.stop();

  // onended has the same single-asset behavior.
  let resolveEarlyEndedTts;
  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalog })
    : new Promise((resolve) => { resolveEarlyEndedTts = resolve; });
  const earlyEnded = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await earlyEnded.prebakedBridgeCatalogPromise;
  assert.equal(earlyEnded.startEarlyBridge({ requestId: "early-ended", allowed: true, reason: "ordinary-general-conversation", policyId: "runtime-policy", policyVersion: "1", noToolOrSafetyPath: true }), true);
  runNextTimer();
  const firstEarlyEndedAudio = earlyEnded.bridgeAudio;
  const earlyEndedPending = earlyEnded.speak(createResponseEnvelope("同请求另一条最终回答。", { voiceBridge: { requestId: "early-ended", allowed: true } }));
  firstEarlyEndedAudio.onended?.();
  assert.deepEqual(earlyEnded.ttsTelemetry.bridge.completionSources, ["ended"]);
  assert.equal(earlyEnded.bridgeAudio, null, "ended must not start another neutral asset");
  assert.equal(earlyEnded.ttsTelemetry.bridge.status, "completed");
  resolveEarlyEndedTts({ ok: true, status: 200, headers: new Headers({ "content-type": "audio/wav" }), blob: async () => new Blob(["audio"]) });
  await earlyEndedPending;
  assert.equal(timers.size, 0, "onended handoff must leave no bridge timer");
  earlyEnded.stop();

  // A new request does not inherit the old run. Captured old callbacks remain
  // inert after stop/replace even if the browser delivers them late.
  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalog }) : new Promise(() => {});
  const replacedEarly = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await replacedEarly.prebakedBridgeCatalogPromise;
  replacedEarly.startEarlyBridge({ requestId: "early-replaced", allowed: true, reason: "ordinary-general-conversation", policyId: "runtime-policy", policyVersion: "1", noToolOrSafetyPath: true });
  runNextTimer();
  const staleEnded = replacedEarly.bridgeAudio.onended;
  const oldPlayId = replacedEarly.playId;
  void replacedEarly.speak(createResponseEnvelope("新请求最终回答。", { voiceBridge: { requestId: "different-request", allowed: true } }));
  assert.equal(replacedEarly.playId, oldPlayId + 1, "a different request must create a new playId");
  staleEnded?.();
  assert.equal(replacedEarly.bridgeAudio, null, "late callbacks from the old run must not revive its bridge");
  replacedEarly.stop();

  const singleEnded = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await singleEnded.prebakedBridgeCatalogPromise;
  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalog }) : new Promise(() => {});
  void singleEnded.speak(createResponseEnvelope("单条等待。", { voiceBridge: { allowed: true } }));
  runNextTimer();
  const endedAudio = singleEnded.bridgeAudio;
  endedAudio.onended?.();
  assert.equal(singleEnded.ttsTelemetry.bridge.status, "completed");
  assert.deepEqual(singleEnded.ttsTelemetry.bridge.playedAssetIds, [singleEnded.ttsTelemetry.bridge.asset.assetId]);
  assert.equal(singleEnded.bridgeAudio, null, "ended asset must leave the bridge silent");
  assert.equal(timers.size, 0, "ended asset must not schedule another bridge");
  singleEnded.stop();

  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalog }) : new Promise(() => {});
  const watchdog = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await watchdog.prebakedBridgeCatalogPromise;
  void watchdog.speak(createResponseEnvelope("watchdog 等待。", { voiceBridge: { allowed: true } }));
  runNextTimer();
  const watchedAudio = watchdog.bridgeAudio;
  runNextTimer();
  assert.equal(watchedAudio.paused, true, "watchdog must safely stop a stuck, actually started asset");
  assert.equal(watchdog.ttsTelemetry.bridge.completionSource, "watchdog");
  assert.equal(watchdog.ttsTelemetry.bridge.watchdogTriggered, true);
  assert.equal(watchdog.ttsTelemetry.bridge.watchdogDurationMs > 0, true);
  assert.equal(watchdog.ttsTelemetry.bridge.queueState.remaining >= 0, true);
  assert.equal(watchdog.ttsTelemetry.bridge.status, "completed", "watchdog must leave the bridge silent");
  assert.equal(watchdog.bridgeAudio, null, "watchdog must not advance to another asset");
  watchdog.stop();

  const catalogWithoutDuration = structuredClone(catalog);
  delete catalogWithoutDuration.items[0].durationMs;
  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalogWithoutDuration }) : new Promise(() => {});
  const noDuration = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await noDuration.prebakedBridgeCatalogPromise;
  void noDuration.speak(createResponseEnvelope("无时长。", { voiceBridge: { allowed: true } }));
  runNextTimer();
  const noDurationAudio = noDuration.bridgeAudio;
  assert.equal(noDuration.ttsTelemetry.bridge.watchdogDurationMs, null, "assets without catalog duration must retain onended-only completion");
  noDurationAudio.onended?.();
  assert.equal(noDuration.ttsTelemetry.bridge.completionSource, "ended");
  noDuration.stop();

  for (const [text, tier] of [["中".repeat(41), "medium"], ["长".repeat(101), "long"], ["很".repeat(181), "very-long"]]) {
    globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
      ? Promise.resolve({ ok: true, json: async () => catalog })
      : new Promise(() => {});
    const itemAdapter = new VoiceOutputAdapter({ provider: "gpt-sovits" });
    await itemAdapter.prebakedBridgeCatalogPromise;
    void itemAdapter.speak(createResponseEnvelope(text, { voiceBridge: { allowed: true } }));
    runNextTimer();
    assert.equal(itemAdapter.ttsTelemetry.bridge.asset.tier, tier, `${tier} selection`);
    assert.equal(itemAdapter.ttsTelemetry.bridge.initialTier, tier, `${tier} initial tier telemetry`);
    itemAdapter.stop();
  }

  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalog })
    : new Promise(() => {});
  const fallbackAdapter = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await fallbackAdapter.prebakedBridgeCatalogPromise;
  remainingAudioFailures = catalog.items.length;
  const spokenBeforeFallback = spoken.length;
  void fallbackAdapter.speak(createResponseEnvelope("资产错误。", { voiceBridge: { allowed: true } }));
  runNextTimer();
  for (let index = 0; index < catalog.items.length + 2; index += 1) await flush();
  assert.equal(fallbackAdapter.ttsTelemetry.bridge.assetError, "prebaked-asset-error");
  assert.equal(fallbackAdapter.ttsTelemetry.bridge.browserFallbackReason, "all-prebaked-assets-failed");
  assert.equal(spoken.at(-1), "正在为你处理", "asset error must retain browser neutral bridge");
  assert.equal(spoken.length, spokenBeforeFallback + 1, "browser bridge fallback must run at most once");
  fallbackAdapter.stop();

  const forbidden = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await forbidden.prebakedBridgeCatalogPromise;
  globalThis.fetch = async (url) => String(url).includes("waiting-bridge.catalog")
    ? { ok: true, json: async () => catalog }
    : { ok: true, status: 200, headers: new Headers({ "content-type": "audio/wav" }), blob: async () => new Blob(["audio"]) };
  await forbidden.speak(createResponseEnvelope("需要确认后方安全。", { voiceBridge: { allowed: false, reason: "safety-decision" } }));
  assert.equal(forbidden.ttsTelemetry.bridge.status, "not-started");

  const stopped = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await stopped.prebakedBridgeCatalogPromise;
  globalThis.fetch = () => new Promise(() => {});
  void stopped.speak(createResponseEnvelope("等待中的普通对话。", { voiceBridge: { allowed: true } }));
  runNextTimer();
  const stoppedAudio = stopped.bridgeAudio;
  stopped.stop();
  assert.equal(stoppedAudio.paused, true, "stop/replace must pause and reset prebuilt audio");
  assert.equal(stoppedAudio.currentTime, 0);

  let resolveHandoffTts;
  remainingAudioFailures = 0;
  globalThis.fetch = (url) => String(url).includes("waiting-bridge.catalog")
    ? Promise.resolve({ ok: true, json: async () => catalog })
    : new Promise((resolve) => { resolveHandoffTts = resolve; });
  const handoffAfterSingle = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  await handoffAfterSingle.prebakedBridgeCatalogPromise;
  const handoffPending = handoffAfterSingle.speak(createResponseEnvelope("中".repeat(60), { voiceBridge: { allowed: true } }));
  runNextTimer();
  const handoffAudio = handoffAfterSingle.bridgeAudio;
  resolveHandoffTts({ ok: true, status: 200, headers: new Headers({ "content-type": "audio/wav" }), blob: async () => new Blob(["audio"]) });
  await handoffPending;
  assert.equal(handoffAudio.paused, true, "final handoff must cancel the active single asset");

  const app = await readFile(new originals.URL("../../src/app/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /function resolveVoiceBridgeEligibility/, "HMI must not reconstruct Runtime authorization");
  assert.match(app, /event\.component === "voiceBridgeEligibility"/, "HMI must consume the Runtime authority event");
  assert.match(app, /voiceOutputAdapter\.startEarlyBridge\(authorization\)/, "HMI must pass only Runtime authorization to the adapter");
  assert.match(app, /result\.voiceBridgeEligibility \|\| \{ allowed: false, reason: "runtime-authorization-unavailable" \}/, "final speech must preserve Runtime authority only");
  assert.ok(cancelled > 0);
  console.log(JSON.stringify({ catalogTierSelection: true, singleAssetCap: true, watchdogSilence: true, noDurationOnended: true, finalHandoff: true, allAssetsUnavailableFallback: true, stopReplace: true, restrictedPaths: true }, null, 2));
} finally {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
}
