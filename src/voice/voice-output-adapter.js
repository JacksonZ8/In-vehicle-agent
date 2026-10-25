import {
  composeAbortSignals,
  createAbortError,
  isCancellationError,
  throwIfAborted,
} from "../runtime/abort-utils.js";

// HC-P1-10: provider capabilities replace hardcoded chunk length, pre-fetch window, and lang.
export const VOICE_PROVIDER_CAPABILITY_POLICY = Object.freeze({
  id: "nio-voice-provider-capability@1.1.0",
  providers: Object.freeze({
    "gpt-sovits": Object.freeze({
      maxChunkLength: 48,        // characters per TTS request (provider limit)
      prefetchWindow: 1,         // chunks to pre-fetch ahead of playback
      maxConcurrentRequests: 1,  // current GPT-SoVITS API is safest with one in-flight lookahead
      separateShortOpener: false, // avoid tiny opener requests that create large inter-chunk gaps
      supportedLanguages: Object.freeze(["zh", "zh-CN"]),
      defaultLang: "zh-CN",
      supportsStreaming: false,
      estimatedCharsPerSecond: 5.5,  // for adaptive window calculation
    }),
    "browser": Object.freeze({
      maxChunkLength: Infinity,  // Browser SpeechSynthesis handles full text
      prefetchWindow: 0,
      maxConcurrentRequests: 0,
      separateShortOpener: false,
      supportedLanguages: Object.freeze(["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR"]),
      defaultLang: "zh-CN",
      supportsStreaming: false,
      estimatedCharsPerSecond: 4.0,
    }),
  }),
});

const PROVIDER_CAPABILITIES = VOICE_PROVIDER_CAPABILITY_POLICY.providers;

export function getVoiceProviderCapabilities(provider = DEFAULT_PROVIDER) {
  const capabilities = PROVIDER_CAPABILITIES[provider] || PROVIDER_CAPABILITIES[DEFAULT_PROVIDER];
  return { ...capabilities, supportedLanguages: [...(capabilities.supportedLanguages || [])] };
}

const DEFAULT_PROVIDER = "browser";
const DEFAULT_LANG = "zh-CN";

const TTS_RESPONSE_HEADER_NAMES = [
  "x-nio-tts-proxy-total-ms",
  "x-nio-tts-upstream-first-response-ms",
  "x-nio-tts-upstream-complete-read-ms",
  "x-nio-tts-audio-bytes",
  "x-nio-tts-status",
  "x-nio-tts-error",
  "x-nio-tts-streaming-mode",
  "x-nio-tts-upstream-status",
  "x-nio-tts-profile-id",
  "x-nio-tts-profile-version",
  "x-nio-tts-synthesis-profile-id",
  "x-nio-tts-license-boundary",
  "x-nio-tts-diagnostic-request-id",
];

// ---- HC-P1-10: ResponseEnvelope — separates display text from speech text ----
export function createResponseEnvelope(displayText, opts = {}) {
  const speechText = opts.speechText || buildVehicleSpeechText(displayText);
  return {
    displayText: String(displayText || ""),
    speechText: String(speechText || ""),
    speechTextPolicy: opts.speechTextPolicy || null,
    citations: Array.isArray(opts.citations) ? opts.citations : [],
    provenance: opts.provenance || "assistant-response",
    voiceBridge: opts.voiceBridge || null,
  };
}

export const VEHICLE_SPEECH_TEXT_POLICY = {
  id: "nio-vehicle-speech-text@1.1.0",
};

// A short, neutral bridge removes a long silent wait while the local
// development TTS is generating. It is intentionally opt-in per response:
// callers must establish that the final response is stable and non-sensitive.
export const VOICE_BRIDGE_POLICY = Object.freeze({
  id: "nio-voice-bridge@1.1.0",
  enabledByDefault: true,
  thresholdMs: 500,
  text: "正在为你处理",
  maxChars: 6,
  allowedUse: "conversation-general-only",
  // A catalog duration is a local asset contract, not a progress estimate.
  // The small grace allows a stuck element to be stopped safely.
  prebakedWatchdogGraceMs: 750,
  maxPrebakedAssetsPerRun: 1,
  maxPrebakedAssetsPerTurn: 1,
});

export const PREBAKED_WAITING_BRIDGE_CATALOG_URL = "/assets/tts/prebaked/sandrone-dev-zh-waiting-bridge.catalog.json";

export function getVehicleSpeechTextPolicy(provider = DEFAULT_PROVIDER) {
  return {
    ...VEHICLE_SPEECH_TEXT_POLICY,
    providerCapabilityPolicyId: VOICE_PROVIDER_CAPABILITY_POLICY.id,
  };
}

// HC-P1-10: configurable citation stripping (was hardcoded "手册依据：")
const CITATION_PATTERNS = [
  /\n+\s*手册依据：[\s\S]*$/u,
  /\n+\s*参考来源[：:][\s\S]*$/u,
  /\n+\s*数据来源[：:][\s\S]*$/u,
];

function stripCitationSuffix(text) {
  let result = String(text || "");
  for (const pattern of CITATION_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.trim();
}

function normalizeSpeechDisplayText(text) {
  return stripCitationSuffix(text)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/#{1,6}\s*/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "。")
    .replace(/。{2,}/g, "。")
    .trim();
}

function splitSpeechSentences(text) {
  return String(text || "").match(/[^。！？!?；;]+[。！？!?；;]*/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
}

function isSpeechAppendixSentence(sentence) {
  return /数据来自|时间边界|参考来源|手册依据|引用|Open-Meteo|retrieval|embedding|chunk|来源[:：]/iu.test(sentence);
}

export function buildVehicleSpeechText(displayText) {
  const normalized = normalizeSpeechDisplayText(displayText);
  if (!normalized) return "";
  return splitSpeechSentences(normalized)
    .filter((sentence) => !isSpeechAppendixSentence(sentence))
    .join("");
}

export function readTtsResponseTelemetry(headers) {
  return Object.fromEntries(TTS_RESPONSE_HEADER_NAMES.map((name) => [name, headers?.get?.(name) || "unavailable"]));
}

export function prepareSpeechText(text) {
  // HC-P1-10: use ResponseEnvelope if available, otherwise strip citation patterns
  if (typeof text === "object" && text !== null && text.speechText) {
    return String(text.speechText).trim();
  }
  return stripCitationSuffix(String(text || ""));
}

// HC-P1-10: chunk length is now capability-driven, not hardcoded 48
export function splitSpeechText(text, provider = DEFAULT_PROVIDER) {
  const normalized = prepareSpeechText(text);
  if (!normalized) return [];

  const caps = getVoiceProviderCapabilities(provider);
  const maxLength = caps.maxChunkLength;
  if (maxLength === Infinity || normalized.length <= maxLength) return [normalized];

  const openerMatch = normalized.match(/^.{1,8}?[，,]/u);
  const separateShortOpener = caps.separateShortOpener === true;
  const opener = separateShortOpener ? openerMatch?.[0] || "" : "";
  const body = opener && normalized.length - opener.length > 0 ? normalized.slice(opener.length) : normalized;
  const sentences = body.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/g) || [body];
  const segments = sentences.flatMap((sentence) => {
    const trimmed = sentence.trim();
    if (!trimmed) return [];
    const parts = [];
    for (let offset = 0; offset < trimmed.length; offset += maxLength) {
      parts.push(trimmed.slice(offset, offset + maxLength));
    }
    return parts;
  });
  const chunks = [];
  let current = "";
  const appendSegment = (segment) => {
    if (!segment) return;
    if (current && current.length + segment.length <= maxLength) {
      current += segment;
      return;
    }
    if (current) chunks.push(current);
    current = segment;
  };
  if (opener) chunks.push(opener);
  else if (segments.length > 1 && segments[0].length <= 8) chunks.push(segments.shift());
  for (const segment of segments) appendSegment(segment);
  if (current) chunks.push(current);
  return chunks;
}

function estimateSpeechDurationMs(text, capabilities = {}) {
  const charsPerSecond = Number(capabilities.estimatedCharsPerSecond);
  if (!Number.isFinite(charsPerSecond) || charsPerSecond <= 0) return undefined;
  return Math.round((String(text || "").length / charsPerSecond) * 1000);
}

function appendBytes(left, right) {
  const next = new Uint8Array(left.byteLength + right.byteLength);
  next.set(left, 0);
  next.set(right, left.byteLength);
  return next;
}

// The PoC deliberately accepts only standard PCM/float WAV. Anything else
// fails into the existing browser-speech fallback instead of guessing bytes.
function parsePcmWavHeader(bytes) {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") throw new Error("Streaming PoC expected RIFF/WAVE");
  let offset = 12;
  let format;
  let dataOffset = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > bytes.byteLength) return null;
    if (id === "fmt ") {
      format = {
        format: view.getUint16(offset + 8, true), channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true), blockAlign: view.getUint16(offset + 20, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      };
    }
    if (id === "data") { dataOffset = offset + 8; break; }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset === null || !format) return null;
  if (![1, 3].includes(format.format) || ![16, 32].includes(format.bitsPerSample) || !format.channels || !format.sampleRate || !format.blockAlign) {
    throw new Error("Streaming PoC supports PCM16/float32 WAV only");
  }
  return { ...format, bytesPerSample: format.bitsPerSample / 8, dataOffset };
}

function supportsBrowserSpeech() {
  return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export function waitForVoicePlaybackCompletion(adapter, startPlayback) {
  if (!adapter || typeof adapter.subscribeStatus !== "function") {
    throw new TypeError("adapter.subscribeStatus is required");
  }
  if (typeof startPlayback !== "function") throw new TypeError("startPlayback must be a function");

  return new Promise((resolve, reject) => {
    let settled = false;
    let sawNonIdle = false;
    let statusRevision = 0;
    let unsubscribe = () => {};
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      callback(value);
    };
    const confirmIdle = (revision) => {
      queueMicrotask(() => queueMicrotask(() => {
        if (!settled && sawNonIdle && statusRevision === revision && adapter.status === "idle") {
          settle(resolve);
        }
      }));
    };
    unsubscribe = adapter.subscribeStatus(({ status }) => {
      statusRevision += 1;
      if (status !== "idle") {
        sawNonIdle = true;
        return;
      }
      if (sawNonIdle) confirmIdle(statusRevision);
    });

    let playback;
    try {
      playback = startPlayback();
    } catch (error) {
      settle(reject, error);
      return;
    }
    Promise.resolve(playback).then(
      () => {
        if (sawNonIdle && adapter.status === "idle") confirmIdle(statusRevision);
      },
      (error) => {
        if (isCancellationError(error) && sawNonIdle && adapter.status === "idle") {
          confirmIdle(statusRevision);
          return;
        }
        settle(reject, error);
      },
    );
  });
}

export class VoiceOutputAdapter {
  constructor(config = {}) {
    this.provider = config.provider || DEFAULT_PROVIDER;
    this.endpoint = config.endpoint || "/api/tts";
    // Explicit opt-in only. The normal GPT-SoVITS WAV/blob path remains the
    // production-development default until this experiment is measured.
    this.streamingPoc = config.streamingPoc === true;
    this.streamingEndpoint = config.streamingEndpoint || "/api/tts-streaming-poc";
    this.audioContext = null;
    this.streamingSources = new Set();
    this.browserSupported = supportsBrowserSpeech();
    // HC-P1-10: provider capabilities drive chunking and prefetch
    this.capabilities = getVoiceProviderCapabilities(this.provider);
    this.status = "idle";
    this.mode = "browser";
    this.audio = null;
    this.utterance = null;
    this.objectUrl = "";
    this.playId = 0;
    this.voiceRunAbortBinding = null;
    this.ttsAbortController = null;
    this.ttsAbortControllers = new Map();
    this.ttsChunks = [];
    this.ttsChunkIndex = 0;
    this.ttsOriginalText = "";
    this.prefetchedAudio = new Map();
    this.prefetchPromises = new Map();
    this.bridgeEnabled = config.bridgeEnabled !== false;
    this.bridgeTimer = null;
    this.bridgeUtterance = null;
    this.bridgeAudio = null;
    this.bridgeAudioAssetId = null;
    this.bridgeWatchdogTimer = null;
    this.bridgePlayId = null;
    this.earlyBridgeRequestId = null;
    this.lastProgressTurnId = null;
    this.bridgeSelectionCursors = new Map();
    // This is deliberately best-effort. It starts while the HMI is idle and
    // never delays final TTS, text rendering, or a vehicle request.
    this.prebakedBridgeCatalog = null;
    this.prebakedBridgeAudioCache = new Map();
    this.prebakedBridgeCatalogPromise = this.loadPrebakedBridgeCatalog();
    this.statusListeners = new Set();
    this.onStatusChange = () => {};
    this.onTelemetry = () => {};
    this.ttsTelemetry = null;
  }

  get supported() {
    return this.browserSupported || this.provider === "gpt-sovits";
  }

  // HC-P1-10: label from capabilities, not hardcoded strings
  get label() {
    if (this.mode === "gpt-sovits") return "角色TTS";
    if (this.mode === "browser") return "浏览器兜底";
    return "语音不可用";
  }

  get defaultLang() {
    return this.capabilities.defaultLang || DEFAULT_LANG;
  }

  setStatus(status, mode = this.mode) {
    this.status = status;
    this.mode = mode;
    const snapshot = Object.freeze({ status, mode, label: this.label });
    this.onStatusChange(snapshot);
    for (const listener of this.statusListeners) {
      try { listener(snapshot); } catch {}
    }
  }

  subscribeStatus(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.statusListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.statusListeners.delete(listener);
    };
  }

  emitTelemetry(patch = {}) {
    if (!this.ttsTelemetry) return;
    Object.assign(this.ttsTelemetry, patch);
    this.onTelemetry(JSON.parse(JSON.stringify(this.ttsTelemetry)));
  }

  refreshChunkGapTelemetry() {
    if (!this.ttsTelemetry) return;
    const chunkGapsMs = (this.ttsTelemetry.chunks || [])
      .map((chunk) => chunk?.previousEndToPlayStartGapMs)
      .filter((value) => Number.isFinite(value));
    this.ttsTelemetry.chunkGapsMs = chunkGapsMs;
    this.ttsTelemetry.maxChunkGapMs = chunkGapsMs.length ? Math.max(...chunkGapsMs) : "unavailable";
  }

  bindVoiceRunAbort(signal, playId) {
    this.detachVoiceRunAbort();
    if (!signal) return;
    const onAbort = () => {
      if (this.voiceRunAbortBinding?.listener !== onAbort || playId !== this.playId) return;
      this.stop();
    };
    this.voiceRunAbortBinding = { signal, playId, listener: onAbort };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  detachVoiceRunAbort(playId) {
    const binding = this.voiceRunAbortBinding;
    if (!binding || (playId !== undefined && binding.playId !== playId)) return;
    this.voiceRunAbortBinding = null;
    binding.signal.removeEventListener("abort", binding.listener);
  }

  async speak(text, options = {}) {
    throwIfAborted(options.signal);
    const displayText = typeof text === "object" && text !== null ? String(text.displayText || text.speechText || "") : String(text || "");
    const response = prepareSpeechText(text);
    const bridgeRequest = typeof text === "object" && text !== null ? text.voiceBridge : null;
    const preserveEarlyBridge = bridgeRequest?.allowed === true
      && bridgeRequest?.requestId
      && bridgeRequest.requestId === this.earlyBridgeRequestId;
    // A Runtime-authorized early bridge belongs to this same request. Preserve
    // its run identity so its already-registered onended/watchdog callbacks
    // can safely finish the single neutral asset while final TTS is loading.
    // Every other speak still starts a distinct run in stop().
    this.stop({ preserveBridge: preserveEarlyBridge, preserveBridgePlayId: this.playId });
    if (!response) return;
    const playId = this.playId;
    this.bindVoiceRunAbort(options.signal, playId);
    throwIfAborted(options.signal);
    // HC-P1-10: chunk count from provider capabilities, not hardcoded gpt-sovits check
    const chunks = this.provider === "gpt-sovits" ? splitSpeechText(response, this.provider) : [response];
    const speechPolicy = typeof text === "object" && text !== null && text.speechTextPolicy
      ? text.speechTextPolicy
      : getVehicleSpeechTextPolicy(this.provider);
    const speechProvenance = typeof text === "object" && text !== null ? text.provenance || "assistant-response" : "legacy-text";
    const bridge = preserveEarlyBridge && this.ttsTelemetry?.bridge
      ? this.updateEarlyBridgeForFinalAnswer(this.ttsTelemetry.bridge, response)
      : this.resolveBridge(bridgeRequest, response);
    this.ttsTelemetry = {
      provider: this.provider,
      status: "preparing",
      displayTextChars: displayText.length,
      speechTextChars: response.length,
      speechTextPolicy: speechPolicy,
      speechTextProvenance: speechProvenance,
      chunkCount: chunks.length,
      startedAtMs: Math.round(performance.now()),
      chunkGapsMs: [],
      maxChunkGapMs: "unavailable",
      chunks: [],
      bridge,
      capabilities: {
        maxChunkLength: this.capabilities.maxChunkLength,
        prefetchWindow: this.capabilities.prefetchWindow,
        separateShortOpener: this.capabilities.separateShortOpener,
        defaultLang: this.capabilities.defaultLang,
        estimatedCharsPerSecond: this.capabilities.estimatedCharsPerSecond,
        supportsStreaming: this.capabilities.supportsStreaming,
        streamingPoc: this.streamingPoc,
      },
    };
    this.telemetryStartedAt = performance.now();
    this.emitTelemetry();

    if (this.provider === "gpt-sovits") {
      this.ttsChunks = chunks;
      this.ttsChunkIndex = 0;
      this.ttsOriginalText = response;
      try {
        this.setStatus("loading", "gpt-sovits");
        if (!preserveEarlyBridge) this.scheduleBridge(playId, bridge);
        if (this.streamingPoc && this.ttsChunks.length === 1) {
          await this.playStreamingPoc(this.ttsChunks[0], 0, playId, options.signal);
          this.detachVoiceRunAbort(playId);
          return;
        }
        const prepared = await this.prepareGptSoVitsAudio(this.ttsChunks[0], 0, playId, options.signal);
        throwIfAborted(options.signal);
        if (!prepared) return;
        this.prefetchNextTtsChunks(playId, 0, options.signal);
        await this.playPreparedTtsAudio(prepared, playId, options.signal);
        return;
      } catch (error) {
        if (options.signal?.aborted) throw createAbortError(options.signal.reason);
        if (playId !== this.playId) return;
        if (isCancellationError(error)) return;
        this.emitTelemetry({ status: "fallback", error: error.message });
        this.resetTtsQueue();
        if (options.allowBrowserFallback === false) {
          this.setStatus("idle", "gpt-sovits");
          return;
        }
        this.setStatus("fallback", "browser");
        console.warn(`GPT-SoVITS TTS unavailable, using browser fallback: ${error.message}`);
      }
    }

    if (options.allowBrowserFallback === false) {
      this.setStatus("idle", this.provider === "gpt-sovits" ? "gpt-sovits" : "unavailable");
      return;
    }
    if (this.provider !== "gpt-sovits") this.setStatus("loading", "browser");
    this.speakWithBrowser(response, playId);
  }

  async loadPrebakedBridgeCatalog() {
    try {
      const response = await fetch(PREBAKED_WAITING_BRIDGE_CATALOG_URL, { cache: "force-cache" });
      const catalog = response.ok ? await response.json() : null;
      if (!Array.isArray(catalog?.items) || catalog.licenseBoundary !== "local-non-commercial-testing-only") return null;
      this.prebakedBridgeCatalog = catalog;
      // Only the initial early-bridge tier is warmed. This stays local,
      // best-effort, and deliberately does not delay catalog availability.
      this.preloadEarlyPrebakedBridgeAssets(catalog);
      return catalog;
    } catch {
      return null;
    }
  }

  preloadEarlyPrebakedBridgeAssets(catalog) {
    const initialAssets = Array.isArray(catalog?.items) ? catalog.items.filter((item) => item?.tier === "short").slice(0, 3) : [];
    for (const asset of initialAssets) {
      if (!asset?.assetId || !asset.fileName || this.prebakedBridgeAudioCache.has(asset.assetId)) continue;
      const audio = new Audio(`/assets/tts/prebaked/${asset.fileName}`);
      audio.preload = "auto";
      const entry = { audio, state: "loading", failureType: null };
      this.prebakedBridgeAudioCache.set(asset.assetId, entry);
      audio.oncanplaythrough = () => {
        if (this.prebakedBridgeAudioCache.get(asset.assetId) === entry) entry.state = "ready";
      };
      audio.onerror = () => {
        if (this.prebakedBridgeAudioCache.get(asset.assetId) === entry) {
          entry.state = "failed";
          entry.failureType = "preload-audio-error";
        }
      };
      try { audio.load?.(); } catch {
        entry.state = "failed";
        entry.failureType = "preload-load-error";
      }
    }
  }

  resolveBridge(request, speechText = "") {
    const allowed = this.bridgeEnabled && request?.allowed === true && this.browserSupported;
    const reason = !this.bridgeEnabled ? "disabled-by-config"
      : request?.allowed !== true ? request?.reason || "not-authorized-by-caller"
        : !this.browserSupported ? "browser-speech-unavailable" : "eligible";
    return {
      policyId: VOICE_BRIDGE_POLICY.id,
      enabled: this.bridgeEnabled,
      allowed: allowed,
      reason,
      thresholdMs: VOICE_BRIDGE_POLICY.thresholdMs,
      maxChars: VOICE_BRIDGE_POLICY.maxChars,
      answerCharacters: String(speechText || "").length,
      estimatedSpeechMs: estimateSpeechDurationMs(speechText, this.capabilities),
      selectionBasis: "estimated-answer-character-count-not-real-time-progress",
      elapsedWaitMs: 0,
      queue: [],
      playedAssetIds: [],
      assetFailures: [],
      completionSources: [],
      assetStatus: allowed ? "catalog-loading" : "not-applicable",
      status: allowed ? "waiting-threshold" : "not-started",
    };
  }

  bridgeElapsedMs(bridge) {
    return Math.round(performance.now() - Number(bridge?.originStartedAt || this.telemetryStartedAt || performance.now()));
  }

  updateEarlyBridgeForFinalAnswer(bridge, speechText) {
    bridge.answerCharacters = String(speechText || "").length;
    bridge.estimatedSpeechMs = estimateSpeechDurationMs(speechText, this.capabilities);
    bridge.finalAnswerKnown = true;
    bridge.finalAnswerSelectionBasis = "final-answer-character-count-after-early-authorization";
    // Do not replace an asset already scheduled or playing. That would create
    // a second silence and would falsely imply that Runtime knew the answer.
    return bridge;
  }

  startEarlyBridge(authorization = {}) {
    if (!this.bridgeEnabled || authorization?.allowed !== true || !authorization?.requestId || !this.browserSupported) return false;
    if (this.earlyBridgeRequestId === authorization.requestId) return true;
    const turnId = typeof authorization.turnId === "string" ? authorization.turnId.trim() : "";
    if (turnId && this.lastProgressTurnId === turnId) return false;
    this.stop();
    const bridge = this.resolveBridge(authorization, "");
    bridge.policyId = authorization.policyId || bridge.policyId;
    bridge.policyVersion = authorization.policyVersion || "unknown";
    bridge.reason = authorization.reason || "runtime-authorization";
    bridge.noToolOrSafetyPath = authorization.noToolOrSafetyPath === true;
    bridge.interactionEventId = authorization.interactionEventId || null;
    bridge.turnId = turnId || null;
    bridge.selectionBasis = "early-authorization-not-final-answer-length";
    bridge.answerCharacters = null;
    bridge.estimatedSpeechMs = null;
    bridge.originStartedAt = performance.now();
    this.earlyBridgeRequestId = authorization.requestId;
    if (turnId) this.lastProgressTurnId = turnId;
    this.ttsTelemetry = {
      provider: this.provider,
      status: "waiting-for-final-response",
      startedAtMs: Math.round(bridge.originStartedAt),
      chunks: [],
      bridge,
    };
    this.telemetryStartedAt = bridge.originStartedAt;
    this.emitTelemetry();
    this.scheduleBridge(this.playId, bridge);
    return true;
  }

  selectPrebakedBridgeAsset(bridge) {
    const items = this.prebakedBridgeCatalog?.items;
    if (!Array.isArray(items) || !items.length) return null;
    const answerCharacters = Number(bridge.answerCharacters) || 0;
    const eligible = items.filter((item) => {
      const range = item?.answerCharacterRange || {};
      return answerCharacters >= Number(range.minInclusive || 0)
        && (range.maxInclusive === null || answerCharacters <= Number(range.maxInclusive));
    });
    if (!eligible.length) return null;
    const tier = bridge.selectionBasis === "early-authorization-not-final-answer-length" ? "short" : eligible[0].tier;
    const tierEligible = items.filter((item) => item.tier === tier);
    const cursor = this.bridgeSelectionCursors.get(tier) || 0;
    const asset = tierEligible[cursor % tierEligible.length];
    this.bridgeSelectionCursors.set(tier, cursor + 1);
    return asset;
  }

  buildPrebakedBridgeQueue(bridge) {
    const items = this.prebakedBridgeCatalog?.items;
    const initial = this.selectPrebakedBridgeAsset(bridge);
    if (!initial || !Array.isArray(items)) return [];
    // A bridge is one neutral acknowledgement, not a progress soundtrack.
    // Waiting after it ends remains silent until the final response is ready.
    const queue = [initial];
    bridge.initialTier = initial.tier;
    bridge.queue = queue.map((item) => item.assetId);
    bridge.maxPrebakedAssetsPerRun = VOICE_BRIDGE_POLICY.maxPrebakedAssetsPerRun;
    bridge.maxPrebakedAssetsPerTurn = VOICE_BRIDGE_POLICY.maxPrebakedAssetsPerTurn;
    bridge.queueCursor = 0;
    return queue;
  }

  updateBridgeWaitTelemetry(bridge) {
    bridge.elapsedWaitMs = this.bridgeElapsedMs(bridge);
  }

  clearPrebakedBridgeWatchdog() {
    if (!this.bridgeWatchdogTimer) return;
    window.clearTimeout(this.bridgeWatchdogTimer);
    this.bridgeWatchdogTimer = null;
  }

  completePrebakedBridgeAsset(playId, bridge, asset, audio, queue, completionSource) {
    if (playId !== this.playId || this.bridgeAudio !== audio || this.bridgePlayId !== playId) return;
    this.clearPrebakedBridgeWatchdog();
    this.bridgeAudio = null;
    this.releasePrebakedBridgeAudio(asset.assetId, audio);
    this.bridgeAudioAssetId = null;
    bridge.status = "completed";
    bridge.completionSource = completionSource;
    if (["ended", "watchdog"].includes(completionSource)) {
      bridge.completionSources ??= [];
      bridge.completionSources.push(completionSource);
    }
    bridge.watchdogTriggered = completionSource === "watchdog";
    bridge.queueState = { cursor: bridge.queueCursor, remaining: Math.max(0, queue.length - bridge.playedAssetIds.length - bridge.assetFailures.length) };
    bridge.completedMs = this.bridgeElapsedMs(bridge);
    this.updateBridgeWaitTelemetry(bridge);
    this.emitTelemetry();
  }

  scheduleBridge(playId, bridge) {
    if (!bridge?.allowed) return;
    this.bridgeTimer = window.setTimeout(() => this.startBridge(playId), bridge.thresholdMs);
  }

  startBridge(playId) {
    this.bridgeTimer = null;
    if (playId !== this.playId || !this.ttsTelemetry?.bridge?.allowed || !this.browserSupported) return;
    const bridge = this.ttsTelemetry.bridge;
    const queue = this.buildPrebakedBridgeQueue(bridge);
    if (queue.length) {
      this.playNextPrebakedBridge(playId, bridge, queue);
      return;
    }
    this.startBrowserBridge(playId, bridge, "catalog-unavailable");
  }

  playNextPrebakedBridge(playId, bridge, queue = null) {
    if (playId !== this.playId || !bridge.allowed || this.bridgeAudio || this.bridgeUtterance) return;
    const planned = queue || (this.prebakedBridgeCatalog?.items || []).filter((item) => bridge.queue.includes(item.assetId));
    const asset = planned.find((item) => !bridge.playedAssetIds.includes(item.assetId) && !bridge.assetFailures.includes(item.assetId));
    if (!asset) {
      if (planned.length && bridge.assetFailures.length === planned.length && !bridge.browserFallbackUsed) {
        bridge.browserFallbackUsed = true;
        this.startBrowserBridge(playId, bridge, bridge.assetFailures.length ? "all-prebaked-assets-failed" : "prebaked-queue-complete");
      } else {
        bridge.status = "completed";
        this.updateBridgeWaitTelemetry(bridge);
        this.emitTelemetry();
      }
      return;
    }
    bridge.queueCursor = bridge.playedAssetIds.length + bridge.assetFailures.length;
    this.startPrebakedBridge(playId, bridge, asset, planned);
  }

  startPrebakedBridge(playId, bridge, asset, queue) {
    const cachedEntry = this.prebakedBridgeAudioCache.get(asset.assetId);
    const usesCachedAudio = cachedEntry?.state === "ready" && cachedEntry.audio && cachedEntry.audio !== this.bridgeAudio;
    bridge.assetStatus = "selected";
    bridge.assetPreload = {
      state: cachedEntry?.state || "not-cached",
      selected: usesCachedAudio ? "cached" : "not-cached",
      failureType: cachedEntry?.failureType || null,
    };
    bridge.asset = {
      assetId: asset.assetId, tier: asset.tier, durationMs: asset.durationMs,
      profileId: asset.profileId, synthesisProfileId: asset.synthesisProfileId,
      licenseBoundary: asset.licenseBoundary,
    };
    bridge.startedMs ??= this.bridgeElapsedMs(bridge);
    this.updateBridgeWaitTelemetry(bridge);
    this.bridgePlayId = playId;
    const audio = usesCachedAudio ? cachedEntry.audio : new Audio(`/assets/tts/prebaked/${asset.fileName}`);
    audio.preload = "auto";
    audio.oncanplaythrough = null;
    audio.onplay = () => {
      if (playId !== this.playId || this.bridgeAudio !== audio) return;
      bridge.status = "playing";
      bridge.playedAssetIds.push(asset.assetId);
      bridge.firstPlayStartedMs = this.bridgeElapsedMs(bridge);
      bridge.completionSource = null;
      bridge.watchdogTriggered = false;
      bridge.watchdogDurationMs = Number.isFinite(asset.durationMs) ? asset.durationMs : null;
      bridge.watchdogGraceMs = Number.isFinite(asset.durationMs) ? VOICE_BRIDGE_POLICY.prebakedWatchdogGraceMs : null;
      bridge.queueState = { cursor: bridge.queueCursor, remaining: Math.max(0, queue.length - bridge.playedAssetIds.length - bridge.assetFailures.length) };
      if (Number.isFinite(asset.durationMs) && asset.durationMs > 0) {
        this.clearPrebakedBridgeWatchdog();
        this.bridgeWatchdogTimer = window.setTimeout(() => {
          this.bridgeWatchdogTimer = null;
          // stopBridge/final handoff clears this timer. Keep this guard so a
          // stale timer can never alter a replacement run.
          if (playId !== this.playId || this.bridgeAudio !== audio || this.bridgePlayId !== playId) return;
          try { audio.pause(); audio.currentTime = 0; } catch {}
          this.completePrebakedBridgeAsset(playId, bridge, asset, audio, queue, "watchdog");
        }, asset.durationMs + VOICE_BRIDGE_POLICY.prebakedWatchdogGraceMs);
      }
      this.updateBridgeWaitTelemetry(bridge);
      this.emitTelemetry();
    };
    audio.onended = () => {
      this.completePrebakedBridgeAsset(playId, bridge, asset, audio, queue, "ended");
    };
    audio.onerror = () => {
      if (this.bridgeAudio !== audio) return;
      this.clearPrebakedBridgeWatchdog();
      this.bridgeAudio = null;
      this.releasePrebakedBridgeAudio(asset.assetId, audio, "prebaked-asset-error");
      this.bridgeAudioAssetId = null;
      bridge.assetStatus = "failed";
      bridge.assetError = "prebaked-asset-error";
      bridge.assetFailures.push(asset.assetId);
      this.updateBridgeWaitTelemetry(bridge);
      this.emitTelemetry();
      this.playNextPrebakedBridge(playId, bridge, queue);
    };
    this.bridgeAudio = audio;
    this.bridgeAudioAssetId = asset.assetId;
    bridge.status = "starting-prebaked";
    audio.play().catch(() => audio.onerror?.());
    this.emitTelemetry();
  }

  releasePrebakedBridgeAudio(assetId, audio, failureType = null) {
    const entry = this.prebakedBridgeAudioCache.get(assetId);
    if (!entry || entry.audio !== audio) return;
    audio.onplay = null;
    audio.onended = null;
    audio.onerror = null;
    try { audio.pause(); audio.currentTime = 0; } catch {}
    if (failureType) {
      entry.state = "failed";
      entry.failureType = failureType;
      return;
    }
    entry.state = "ready";
  }

  startBrowserBridge(playId, bridge, fallbackReason = "catalog-unavailable") {
    bridge.assetStatus = bridge.assetStatus === "selected" ? bridge.assetStatus : "unavailable";
    bridge.browserFallbackReason = fallbackReason;
    bridge.status = "playing";
    bridge.startedMs = this.bridgeElapsedMs(bridge);
    this.updateBridgeWaitTelemetry(bridge);
    this.bridgePlayId = playId;
    const utterance = new SpeechSynthesisUtterance(VOICE_BRIDGE_POLICY.text.slice(0, VOICE_BRIDGE_POLICY.maxChars));
    utterance.lang = this.defaultLang;
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onstart = () => {
      if (playId !== this.playId || this.bridgeUtterance !== utterance) return;
      bridge.firstPlayStartedMs = this.bridgeElapsedMs(bridge);
      this.emitTelemetry();
    };
    utterance.onend = () => {
      if (this.bridgeUtterance !== utterance) return;
      this.bridgeUtterance = null;
      bridge.status = "completed";
      bridge.completedMs = this.bridgeElapsedMs(bridge);
      this.emitTelemetry();
    };
    utterance.onerror = () => {
      if (this.bridgeUtterance !== utterance) return;
      this.bridgeUtterance = null;
      bridge.status = "failed";
      bridge.error = "browser-speech-error";
      this.emitTelemetry();
    };
    this.bridgeUtterance = utterance;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    this.emitTelemetry();
  }

  stopBridge(reason = "final-tts-ready") {
    if (this.bridgeTimer) {
      window.clearTimeout(this.bridgeTimer);
      this.bridgeTimer = null;
      if (this.ttsTelemetry?.bridge?.status === "waiting-threshold") this.ttsTelemetry.bridge.status = "not-needed";
    }
    this.clearPrebakedBridgeWatchdog();
    const bridge = this.ttsTelemetry?.bridge;
    if (this.bridgeAudio) {
      const audio = this.bridgeAudio;
      const assetId = this.bridgeAudioAssetId;
      this.bridgeAudio = null;
      this.bridgeAudioAssetId = null;
      audio.onplay = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.currentTime = 0;
      this.releasePrebakedBridgeAudio(assetId, audio);
    }
    if (!this.bridgeUtterance && !this.bridgeAudio && (!bridge || !["starting-prebaked", "playing"].includes(bridge.status))) {
      if (["final-tts-ready", "browser-fallback-ready", "stop-or-replace"].includes(reason)) this.earlyBridgeRequestId = null;
      return;
    }
    this.bridgeUtterance = null;
    this.bridgePlayId = null;
    if (bridge && ["starting-prebaked", "playing"].includes(bridge.status)) {
      bridge.status = "cancelled";
      bridge.cancelReason = reason;
      bridge.cancelledMs = this.bridgeElapsedMs(bridge);
      this.updateBridgeWaitTelemetry(bridge);
    }
    if (["final-tts-ready", "browser-fallback-ready", "stop-or-replace"].includes(reason)) this.earlyBridgeRequestId = null;
    window.speechSynthesis.cancel();
    this.emitTelemetry();
  }

  async playStreamingPoc(text, index, playId, signal) {
    throwIfAborted(signal);
    if (!(window.AudioContext || window.webkitAudioContext)) {
      throw new Error("Web Audio is unavailable for streaming PoC");
    }
    const controller = new AbortController();
    const composed = composeAbortSignals([signal, controller.signal]);
    this.ttsAbortController = controller;
    this.ttsAbortControllers.set(index, controller);
    const chunkTelemetry = {
      index, textChars: String(text || "").length, streamingPoc: true,
      requestStartMs: Math.round(performance.now() - this.telemetryStartedAt),
      streamChunkArrivalMs: [], streamScheduleGapsMs: [],
    };
    this.ttsTelemetry.chunks[index] = chunkTelemetry;
    this.emitTelemetry({ status: "requesting-streaming-poc" });
    try {
      throwIfAborted(composed.signal);
      const response = await fetch(this.streamingEndpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }), signal: composed.signal,
      });
      throwIfAborted(composed.signal);
      chunkTelemetry.responseHeadersMs = Math.round(performance.now() - this.telemetryStartedAt);
      chunkTelemetry.requestToResponseHeadersMs = chunkTelemetry.responseHeadersMs - chunkTelemetry.requestStartMs;
      chunkTelemetry.httpStatus = response.status;
      chunkTelemetry.responseHeaders = readTtsResponseTelemetry(response.headers);
      if (!response.ok || !response.body || response.headers.get("x-nio-tts-proxy-mode") !== "streaming-poc") {
        throw new Error(`Streaming PoC unavailable: HTTP ${response.status}`);
      }
      this.audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioContext.state === "suspended") await this.audioContext.resume();
      const reader = response.body.getReader();
      let pending = new Uint8Array(0);
      let wav = null;
      let nextStartAt = this.audioContext.currentTime + 0.04;
      let active = 0;
      let streamFinished = false;
      let finish;
      const finished = new Promise((resolve) => { finish = resolve; });
      const maybeFinish = () => { if (streamFinished && active === 0) finish(); };
      const schedulePcm = (pcm) => {
        if (!pcm.byteLength || playId !== this.playId) return;
        const frames = Math.floor(pcm.byteLength / wav.blockAlign);
        if (!frames) return;
        const audioBuffer = this.audioContext.createBuffer(wav.channels, frames, wav.sampleRate);
        const view = new DataView(pcm.buffer, pcm.byteOffset, frames * wav.blockAlign);
        for (let channel = 0; channel < wav.channels; channel += 1) {
          const data = audioBuffer.getChannelData(channel);
          for (let frame = 0; frame < frames; frame += 1) {
            const offset = (frame * wav.blockAlign) + (channel * wav.bytesPerSample);
            data[frame] = wav.format === 3 ? view.getFloat32(offset, true) : view.getInt16(offset, true) / 32768;
          }
        }
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);
        const scheduledAt = Math.max(this.audioContext.currentTime + 0.02, nextStartAt);
        const priorEnd = nextStartAt;
        nextStartAt = scheduledAt + audioBuffer.duration;
        const gapMs = Math.max(0, Math.round((scheduledAt - priorEnd) * 1000));
        if (chunkTelemetry.streamScheduleGapsMs.length) chunkTelemetry.streamScheduleGapsMs.push(gapMs);
        else chunkTelemetry.streamScheduleGapsMs.push(gapMs);
        active += 1;
        this.streamingSources.add(source);
        source.onended = () => { active -= 1; this.streamingSources.delete(source); maybeFinish(); };
        source.start(scheduledAt);
        if (this.ttsTelemetry.firstAudibleMs === undefined) {
          this.stopBridge("final-tts-ready");
          // This is a Web Audio scheduling timestamp, not a device-level
          // acoustic measurement. Keep the legacy field for the existing
          // simulated benchmark while exposing the precise name for real-browser
          // harnesses.
          this.ttsTelemetry.scheduledFirstAudioMs = Math.round(performance.now() - this.telemetryStartedAt + Math.max(0, (scheduledAt - this.audioContext.currentTime) * 1000));
          this.ttsTelemetry.firstAudibleMs = this.ttsTelemetry.scheduledFirstAudioMs;
          this.ttsTelemetry.firstPlayStartedMs = this.ttsTelemetry.firstAudibleMs;
          this.emitTelemetry({ status: "playing-streaming-poc", scheduledFirstAudioMs: this.ttsTelemetry.scheduledFirstAudioMs, firstAudibleMs: this.ttsTelemetry.firstAudibleMs, firstPlayStartedMs: this.ttsTelemetry.firstAudibleMs });
          this.setStatus("speaking", "gpt-sovits");
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        throwIfAborted(composed.signal);
        if (done) break;
        chunkTelemetry.streamChunkArrivalMs.push(Math.round(performance.now() - this.telemetryStartedAt));
        pending = appendBytes(pending, value);
        if (!wav) {
          wav = parsePcmWavHeader(pending);
          if (!wav) continue;
          pending = pending.slice(wav.dataOffset);
        }
        const usable = pending.byteLength - (pending.byteLength % wav.blockAlign);
        if (usable) { schedulePcm(pending.slice(0, usable)); pending = pending.slice(usable); }
        this.emitTelemetry();
      }
      streamFinished = true;
      chunkTelemetry.completeAudioReadyMs = Math.round(performance.now() - this.telemetryStartedAt);
      chunkTelemetry.requestToCompleteAudioReadyMs = chunkTelemetry.completeAudioReadyMs - chunkTelemetry.requestStartMs;
      if (!wav || this.ttsTelemetry.firstAudibleMs === undefined) throw new Error("Streaming PoC received no playable PCM WAV frames");
      maybeFinish();
      await finished;
      throwIfAborted(composed.signal);
      this.emitTelemetry({ status: "completed", completedMs: Math.round(performance.now() - this.telemetryStartedAt), maxStreamScheduleGapMs: Math.max(...chunkTelemetry.streamScheduleGapsMs) });
      this.setStatus("idle", "gpt-sovits");
    } finally {
      composed.dispose();
      if (this.ttsAbortController === controller) this.ttsAbortController = null;
      if (this.ttsAbortControllers.get(index) === controller) this.ttsAbortControllers.delete(index);
    }
  }

  async prepareGptSoVitsAudio(text, index, playId, signal) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const composed = composeAbortSignals([signal, controller.signal]);
    this.ttsAbortController = controller;
    this.ttsAbortControllers.set(index, controller);
    const chunkTelemetry = {
      index,
      textChars: String(text || "").length,
      estimatedSpeechMs: estimateSpeechDurationMs(text, this.capabilities),
      requestStartMs: Math.round(performance.now() - this.telemetryStartedAt),
    };
    this.ttsTelemetry.chunks[index] = chunkTelemetry;
    this.emitTelemetry({ status: index === 0 ? "requesting-first-chunk" : "prefetching" });
    try {
      throwIfAborted(composed.signal);
      const result = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: composed.signal,
      });
      throwIfAborted(composed.signal);
      chunkTelemetry.responseHeadersMs = Math.round(performance.now() - this.telemetryStartedAt);
      chunkTelemetry.requestToResponseHeadersMs = chunkTelemetry.responseHeadersMs - chunkTelemetry.requestStartMs;
      chunkTelemetry.httpStatus = result.status;
      chunkTelemetry.responseHeaders = readTtsResponseTelemetry(result.headers);
      this.emitTelemetry();
      if (playId !== this.playId) return false;

      const contentType = result.headers.get("content-type") || "";
      if (!result.ok || contentType.includes("application/json")) {
        let message = `TTS HTTP ${result.status}`;
        try {
          const data = await result.json();
          message = data.error || data.reason || message;
        } catch {
          // Keep the HTTP status message when the body is not JSON.
        }
        throw new Error(message);
      }

      const blob = await result.blob();
      throwIfAborted(composed.signal);
      chunkTelemetry.completeAudioReadyMs = Math.round(performance.now() - this.telemetryStartedAt);
      chunkTelemetry.requestToCompleteAudioReadyMs = chunkTelemetry.completeAudioReadyMs - chunkTelemetry.requestStartMs;
      chunkTelemetry.audioBytes = blob.size;
      this.emitTelemetry({ status: index === 0 ? "first-chunk-ready" : "prefetched" });
      if (playId !== this.playId) return false;
      if (!blob.size) throw new Error("TTS returned empty audio");

      const objectUrl = URL.createObjectURL(blob);
      if (playId !== this.playId) {
        URL.revokeObjectURL(objectUrl);
        return null;
      }
      return { audio: new Audio(objectUrl), objectUrl, index };
    } finally {
      composed.dispose();
      if (this.ttsAbortController === controller) this.ttsAbortController = null;
      if (this.ttsAbortControllers.get(index) === controller) this.ttsAbortControllers.delete(index);
    }
  }

  async playPreparedTtsAudio(prepared, playId, signal) {
    throwIfAborted(signal);
    if (playId !== this.playId) {
      URL.revokeObjectURL(prepared.objectUrl);
      return;
    }
    this.ttsChunkIndex = prepared.index;
    this.audio = prepared.audio;
    this.objectUrl = prepared.objectUrl;
    this.audio.onplay = () => {
      if (playId !== this.playId) return;
      const chunkTelemetry = this.ttsTelemetry?.chunks?.[prepared.index];
      if (chunkTelemetry) chunkTelemetry.playStartedMs = Math.round(performance.now() - this.telemetryStartedAt);
      this.stopBridge("final-tts-ready");
      const previous = this.ttsTelemetry?.chunks?.[prepared.index - 1];
      if (chunkTelemetry && previous?.playEndedMs !== undefined) {
        chunkTelemetry.previousEndToPlayStartGapMs = chunkTelemetry.playStartedMs - previous.playEndedMs;
        this.refreshChunkGapTelemetry();
      }
      this.emitTelemetry({
        status: "playing",
        firstPlayStartedMs: this.ttsTelemetry.firstPlayStartedMs ?? chunkTelemetry?.playStartedMs,
      });
      this.setStatus("speaking", "gpt-sovits");
      this.prefetchNextTtsChunks(playId, prepared.index, signal);
    };
    this.audio.onended = () => {
      const chunkTelemetry = this.ttsTelemetry?.chunks?.[prepared.index];
      if (chunkTelemetry) {
        chunkTelemetry.playEndedMs = Math.round(performance.now() - this.telemetryStartedAt);
        chunkTelemetry.playDurationMs = chunkTelemetry.playEndedMs - (chunkTelemetry.playStartedMs ?? chunkTelemetry.playEndedMs);
        this.emitTelemetry();
      }
      void this.playNextTtsChunk(playId, signal);
    };
    this.audio.onerror = () => {
      if (!signal?.aborted) this.fallbackRemainingTtsText(playId, this.ttsChunkIndex, signal);
    };
    await this.audio.play();
  }

  prefetchNextTtsChunks(playId, fromIndex = this.ttsChunkIndex, signal) {
    const prefetchWindow = Math.max(0, Math.floor(Number(this.capabilities.prefetchWindow || 0)));
    const maxConcurrent = Math.max(1, Math.floor(Number(this.capabilities.maxConcurrentRequests || prefetchWindow || 1)));
    if (signal?.aborted || playId !== this.playId || prefetchWindow <= 0) return;
    for (let nextIndex = fromIndex + 1; nextIndex < this.ttsChunks.length && nextIndex <= fromIndex + prefetchWindow; nextIndex += 1) {
      if (this.prefetchedAudio.has(nextIndex) || this.prefetchPromises.has(nextIndex)) continue;
      if (this.prefetchPromises.size >= maxConcurrent) break;
      const prefetchPromise = this.prepareGptSoVitsAudio(this.ttsChunks[nextIndex], nextIndex, playId, signal)
        .then((prepared) => {
          this.prefetchPromises.delete(nextIndex);
          if (!prepared) return null;
          if (playId !== this.playId) {
            URL.revokeObjectURL(prepared.objectUrl);
            return null;
          }
          this.prefetchedAudio.set(nextIndex, prepared);
          this.prefetchNextTtsChunks(playId, fromIndex, signal);
          return prepared;
        })
        .catch((error) => {
          this.prefetchPromises.delete(nextIndex);
          const failed = { prefetchError: error, index: nextIndex };
          this.prefetchedAudio.set(nextIndex, failed);
          return failed;
        });
      this.prefetchPromises.set(nextIndex, prefetchPromise);
    }
  }

  async waitForPreparedChunk(index) {
    const ready = this.prefetchedAudio.get(index);
    if (ready) return ready;
    const pending = this.prefetchPromises.get(index);
    if (pending) return pending;
    return null;
  }

  releasePreparedChunk(index) {
    this.prefetchedAudio.delete(index);
    this.prefetchPromises.delete(index);
  }

  async playNextTtsChunk(playId, signal) {
    if (signal?.aborted || playId !== this.playId) return;
    this.clearAudio(null);
    const nextIndex = this.ttsChunkIndex + 1;
    if (nextIndex >= this.ttsChunks.length) {
      this.emitTelemetry({ status: "completed", completedMs: Math.round(performance.now() - this.telemetryStartedAt) });
      this.resetTtsQueue();
      this.setStatus("idle", "gpt-sovits");
      this.detachVoiceRunAbort(playId);
      return;
    }
    try {
      const ready = this.prefetchedAudio.get(nextIndex);
      if (!ready) this.setStatus("loading", "gpt-sovits");
      const prepared = ready || await this.waitForPreparedChunk(nextIndex);
      if (playId !== this.playId || !prepared) return;
      if (prepared.prefetchError) throw prepared.prefetchError;
      this.releasePreparedChunk(nextIndex);
      await this.playPreparedTtsAudio(prepared, playId, signal);
    } catch (error) {
      if (signal?.aborted || playId !== this.playId || isCancellationError(error)) return;
      this.releasePreparedChunk(nextIndex);
      this.emitTelemetry({ status: "fallback", error: error.message });
      this.fallbackRemainingTtsText(playId, nextIndex, signal);
    }
  }

  fallbackRemainingTtsText(playId, startIndex = this.ttsChunkIndex, signal) {
    if (playId !== this.playId) return;
    const remainingText = startIndex === 0
      ? this.ttsOriginalText
      : this.ttsChunks.slice(startIndex).join("");
    this.stop();
    if (!remainingText || signal?.aborted) return;
    const fallbackPlayId = this.playId;
    this.bindVoiceRunAbort(signal, fallbackPlayId);
    this.setStatus("fallback", "browser");
    this.speakWithBrowser(remainingText, fallbackPlayId);
  }

  speakWithBrowser(text, playId = this.playId) {
    this.stopBridge("browser-fallback-ready");
    if (!this.browserSupported) {
      this.emitTelemetry({ provider: "unavailable", status: "unavailable" });
      this.setStatus("idle", "unavailable");
      this.detachVoiceRunAbort(playId);
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = this.defaultLang;
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.onstart = () => {
      if (playId !== this.playId || this.utterance !== utterance) return;
      this.emitTelemetry({ provider: "browser", status: "playing", firstPlayStartedMs: Math.round(performance.now() - this.telemetryStartedAt) });
      this.setStatus("speaking", "browser");
    };
    utterance.onend = () => {
      if (playId !== this.playId || this.utterance !== utterance) return;
      this.utterance = null;
      this.emitTelemetry({ status: "completed", completedMs: Math.round(performance.now() - this.telemetryStartedAt) });
      this.setStatus("idle", "browser");
      this.detachVoiceRunAbort(playId);
    };
    utterance.onerror = () => {
      if (playId !== this.playId || this.utterance !== utterance) return;
      this.utterance = null;
      this.emitTelemetry({ status: "failed", error: "browser-speech-error" });
      this.setStatus("idle", "browser");
      this.detachVoiceRunAbort(playId);
    };
    this.utterance = utterance;
    window.speechSynthesis.speak(utterance);
  }

  pause() {
    if (this.audio) {
      this.audio.pause();
      this.setStatus("paused", "gpt-sovits");
      return;
    }
    if (this.browserSupported) {
      window.speechSynthesis.pause();
      this.setStatus("paused", "browser");
    }
  }

  resume() {
    if (this.audio) {
      this.audio.play().catch(() => this.clearAudio("idle"));
      this.setStatus("speaking", "gpt-sovits");
      return;
    }
    if (this.browserSupported) {
      window.speechSynthesis.resume();
      this.setStatus("speaking", "browser");
    }
  }

  stop({ preserveBridge = false, preserveBridgePlayId = null } = {}) {
    this.detachVoiceRunAbort();
    // This narrow handoff is only valid when speak() has just matched the
    // Runtime request id to the current early bridge. A stale caller cannot
    // retain callbacks by merely setting preserveBridge.
    const preserveCurrentEarlyBridge = preserveBridge === true
      && preserveBridgePlayId === this.playId
      && Boolean(this.earlyBridgeRequestId)
      && this.ttsTelemetry?.bridge?.allowed === true;
    if (!preserveCurrentEarlyBridge) this.playId += 1;
    if (!preserveCurrentEarlyBridge) {
      this.stopBridge("stop-or-replace");
      this.earlyBridgeRequestId = null;
    }
    if (this.ttsAbortController) {
      this.ttsAbortController.abort();
      this.ttsAbortController = null;
    }
    for (const controller of this.ttsAbortControllers.values()) controller.abort();
    this.ttsAbortControllers.clear();
    for (const source of this.streamingSources) { try { source.stop(); } catch {} }
    this.streamingSources.clear();
    for (const prepared of this.prefetchedAudio.values()) {
      if (prepared?.objectUrl) URL.revokeObjectURL(prepared.objectUrl);
    }
    this.prefetchedAudio.clear();
    this.prefetchPromises.clear();
    this.resetTtsQueue();
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.clearAudio("idle");
    }
    if (this.browserSupported) {
      window.speechSynthesis.cancel();
    }
    this.utterance = null;
    this.setStatus("idle", this.mode === "gpt-sovits" ? "gpt-sovits" : "browser");
  }

  clearAudio(status) {
    this.audio = null;
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = "";
    }
    if (status) this.setStatus(status, "gpt-sovits");
  }

  resetTtsQueue() {
    this.ttsChunks = [];
    this.ttsChunkIndex = 0;
    this.ttsOriginalText = "";
    this.prefetchedAudio.clear();
    this.prefetchPromises.clear();
  }
}
