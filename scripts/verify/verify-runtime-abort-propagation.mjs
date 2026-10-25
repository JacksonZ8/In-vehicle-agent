import assert from "node:assert/strict";

const selectedCase = process.argv.find((argument) => argument.startsWith("--case="))?.slice("--case=".length) || "all";
const selectedRuntimeStage = process.argv.find((argument) => argument.startsWith("--runtime-stage="))
  ?.slice("--runtime-stage=".length) || "all";
const PUBLIC_VEHICLE_SLU_PROFILE = Object.freeze({
  provider: "dashscope",
  model: "qwen3.5-flash-2026-02-23",
  mode: "non-thinking",
  schemaVersion: "nio-vehicle-slu-contract@2.0.0",
  fallbackConfigured: true,
  watchdogMs: null,
  readiness: Object.freeze({ status: "ready" }),
});

function createAbortLikeError(signal) {
  const error = new Error("aborted");
  error.name = "AbortError";
  error.reason = signal.reason;
  return error;
}

function createProviderInternalAbortError(reason) {
  const error = new Error(reason);
  error.name = "AbortError";
  error.reason = reason;
  return error;
}

async function assertCancellation(promise, reason, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, "AbortError", message);
    assert.equal(error?.reason, reason, `${message}: cancellation reason must be preserved`);
    return true;
  });
}

function trackAbortListeners(controller = new AbortController()) {
  const listeners = new Set();
  const { signal } = controller;
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === "abort") listeners.add(listener);
    return addEventListener(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") listeners.delete(listener);
    return removeEventListener(type, listener, options);
  };
  return { controller, signal, listenerCount: () => listeners.size };
}

async function verifyUtility() {
  const {
    composeAbortSignals,
    createAbortError,
    isCancellationError,
    throwIfAborted,
  } = await import(`../../src/runtime/abort-utils.js?verify=${Date.now()}`);

  const reason = { code: "user-cancelled" };
  const created = createAbortError(reason);
  assert.equal(created.name, "AbortError");
  assert.equal(created.reason, reason);
  assert.equal(isCancellationError(created), true);
  assert.equal(isCancellationError(new Error("ordinary failure")), false);

  const alreadyAborted = trackAbortListeners();
  alreadyAborted.controller.abort(reason);
  const untouched = trackAbortListeners();
  const precomposed = composeAbortSignals([alreadyAborted.signal, untouched.signal]);
  assert.equal(precomposed.signal.aborted, true, "an already-aborted input must abort the composed signal immediately");
  assert.equal(precomposed.signal.reason, reason, "an already-aborted input reason must be preserved");
  assert.equal(alreadyAborted.listenerCount(), 0);
  assert.equal(untouched.listenerCount(), 0, "later inputs must not gain listeners after immediate abort");
  assert.throws(
    () => throwIfAborted(precomposed.signal),
    (error) => error.name === "AbortError" && error.reason === reason,
  );
  precomposed.dispose();
  precomposed.dispose();

  const first = trackAbortListeners();
  const second = trackAbortListeners();
  const composed = composeAbortSignals([first.signal, second.signal]);
  assert.equal(first.listenerCount(), 1);
  assert.equal(second.listenerCount(), 1);
  second.controller.abort("second-cancelled");
  assert.equal(composed.signal.aborted, true);
  assert.equal(composed.signal.reason, "second-cancelled", "the aborting input reason must reach the composed signal");
  assert.equal(first.listenerCount(), 0, "listeners must detach from non-aborted inputs after composition aborts");
  assert.equal(second.listenerCount(), 0, "listeners must detach from the aborting input");
  composed.dispose();
  composed.dispose();
  assert.equal(first.listenerCount(), 0, "dispose must be idempotent");
  assert.equal(second.listenerCount(), 0, "dispose must remain idempotent for every input");
}

async function verifyLocalSemantic() {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    let fetchBehavior = (_url, options) => new Promise((_resolve, reject) => {
      requests.push(options);
      options.signal.addEventListener("abort", () => reject(createAbortLikeError(options.signal)), { once: true });
    });
    const { LocalModelAdapter } = await import(`../../src/semantic/local-model-adapter.js?verify-abort=${Date.now()}`);
    const adapter = new LocalModelAdapter({
      endpoint: "/semantic",
      watchdogMs: 20,
      providerProfile: PUBLIC_VEHICLE_SLU_PROFILE,
      fetchImpl: (...args) => fetchBehavior(...args),
    });

    const preAborted = new AbortController();
    preAborted.abort("semantic-pre-cancelled");
    await assertCancellation(
      adapter.parse("你好，给我讲个笑话", { requestId: "semantic-pre", signal: preAborted.signal }),
      "semantic-pre-cancelled",
      "pre-aborted semantic parsing must reject",
    );
    assert.equal(requests.length, 0, "pre-aborted semantic parsing must not dispatch fetch");

    const caller = new AbortController();
    const pending = adapter.parse("你好，给我讲个笑话", {
      requestId: "semantic-mid",
      signal: caller.signal,
    });
    assert.equal(requests.length, 1);
    caller.abort("semantic-user-cancelled");
    await assertCancellation(pending, "semantic-user-cancelled", "semantic caller cancellation must reject");
    assert.equal(requests[0].signal.aborted, true, "semantic fetch must receive the composed abort signal");

    const timeoutResult = await adapter.parse("你好，给我讲个笑话", { requestId: "semantic-timeout" });
    assert.equal(timeoutResult.semanticEnvelope, null);
    assert.equal(timeoutResult.executionDisabled, true, "semantic timeout must fail closed");
    assert.equal(timeoutResult.reasonCode, "semantic-endpoint-unavailable");
    assert.equal(timeoutResult.command.intent, "conversation.general");
    assert.equal(timeoutResult.command.actionability.actionable, false);
    assert.equal(timeoutResult.telemetry.provider, "local-semantic-endpoint");
    assert.equal(Object.hasOwn(timeoutResult.telemetry, "semanticPolicy"), false);

    const providerAbort = createProviderInternalAbortError("semantic-provider-internal-abort");
    fetchBehavior = async () => { throw providerAbort; };
    const liveCaller = new AbortController();
    const providerAbortResult = await adapter.parse("你好，给我讲个笑话", {
      requestId: "semantic-provider-abort",
      signal: liveCaller.signal,
    });
    assert.equal(liveCaller.signal.aborted, false);
    assert.equal(providerAbortResult.semanticEnvelope, null);
    assert.equal(providerAbortResult.executionDisabled, true);
    assert.equal(providerAbortResult.reasonCode, "semantic-endpoint-unavailable");
    assert.equal(providerAbortResult.command.actionability.actionable, false);
    assert.equal(providerAbortResult.telemetry.provider, "local-semantic-endpoint");
    assert.equal(Object.hasOwn(providerAbortResult.telemetry, "semanticPolicy"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyCloudLlm() {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      requests.push(options);
      options.signal.addEventListener("abort", () => reject(createAbortLikeError(options.signal)), { once: true });
    });
    const { CloudLLMAdapter } = await import(`../../src/runtime/cloud-llm-adapter.js?verify-abort=${Date.now()}`);
    const command = { intent: "conversation.general", slots: {}, rawText: "测试" };
    const adapter = new CloudLLMAdapter({
      endpoint: "/api/local-llm",
      timeoutMs: 20,
      structuredTimeoutMs: 20,
    });

    const preAborted = new AbortController();
    preAborted.abort("cloud-pre-cancelled");
    await assertCancellation(
      adapter.plan(command, { statePatch: {} }, { signal: preAborted.signal }),
      "cloud-pre-cancelled",
      "pre-aborted Cloud planning must reject",
    );
    assert.equal(requests.length, 0, "pre-aborted Cloud planning must not dispatch fetch");

    const planCaller = new AbortController();
    const planPending = adapter.plan(command, { statePatch: {} }, { signal: planCaller.signal });
    planCaller.abort("cloud-plan-cancelled");
    await assertCancellation(planPending, "cloud-plan-cancelled", "Cloud plan cancellation must bypass degradation");

    const relationCaller = new AbortController();
    const relationPending = adapter.classifyTurnRelation({
      sessionId: "session-1",
      turnId: "turn-1",
      currentGoalSummary: "打开车窗",
      rawText: "改成一半",
      signal: relationCaller.signal,
    });
    relationCaller.abort("cloud-relation-cancelled");
    await assertCancellation(
      relationPending,
      "cloud-relation-cancelled",
      "Task 3 turn-relation cancellation must retain its reason",
    );

    const structuredCaller = new AbortController();
    const structuredPending = adapter.createTaskPlan({
      runId: "run-1",
      goalEnvelope: {},
      catalogProjection: [],
      signal: structuredCaller.signal,
    });
    structuredCaller.abort("cloud-structured-cancelled");
    await assertCancellation(
      structuredPending,
      "cloud-structured-cancelled",
      "structured Cloud cancellation must reach the shared transport",
    );

    const timeoutResult = await adapter.plan(command, { statePatch: {} });
    assert.equal(timeoutResult.degraded, true, "Cloud timeout must retain existing degraded planning behavior");
    assert.match(timeoutResult.summary, /已回退 mock 规划/);
    assert.equal(requests.every((request) => request.signal), true);

    const providerAbort = createProviderInternalAbortError("cloud-provider-internal-abort");
    globalThis.fetch = async () => { throw providerAbort; };
    const liveCaller = new AbortController();
    const providerAbortResult = await adapter.plan(
      command,
      { statePatch: { source: "fixture" } },
      { signal: liveCaller.signal },
    );
    assert.equal(liveCaller.signal.aborted, false);
    assert.equal(providerAbortResult.enabled, false);
    assert.equal(providerAbortResult.degraded, true);
    assert.match(providerAbortResult.summary, /已回退 mock 规划/);
    assert.deepEqual(providerAbortResult.toolContext, { source: "fixture" });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyExternalData() {
  const { ExternalDataAdapter } = await import(`../../src/external-data/external-data-adapter.js?verify-abort=${Date.now()}`);
  let registerCalls = 0;
  const adapter = new ExternalDataAdapter({
    commandRegistry: {
      now: () => Date.parse("2026-07-31T00:00:00.000Z"),
      register() {
        registerCalls += 1;
        return true;
      },
    },
  });
  const caller = new AbortController();
  caller.abort("external-user-cancelled");
  await assertCancellation(
    adapter.execute({
      requestId: "external-cancelled",
      commandId: "external-cancelled:1:navigation.planRoute",
      tool: "navigation.planRoute",
      args: { origin: "上海", destination: "杭州", energyPolicy: "balanced" },
    }, { signal: caller.signal }),
    "external-user-cancelled",
    "pre-aborted ExternalData dispatch must reject",
  );
  assert.equal(registerCalls, 0, "cancelled read-only dispatch must stop before command registration");
}

async function verifyVoiceOutput() {
  const originals = {
    window: globalThis.window,
    SpeechSynthesisUtterance: globalThis.SpeechSynthesisUtterance,
    fetch: globalThis.fetch,
    Audio: globalThis.Audio,
    URL: globalThis.URL,
  };
  let browserFallbackCalls = 0;
  let browserCancelCalls = 0;
  let resolveTtsImmediately = false;
  const requests = [];
  const audioInstances = [];
  const revokedObjectUrls = [];
  const spokenUtterances = [];
  const windowTimers = new Map();
  let objectUrlSequence = 0;
  let windowTimerSequence = 0;
  const runWindowTimer = (timerId) => {
    const callback = windowTimers.get(timerId);
    assert.equal(typeof callback, "function", `window timer ${timerId} must exist`);
    windowTimers.delete(timerId);
    callback();
  };
  try {
    globalThis.window = {
      speechSynthesis: {
        cancel() {
          browserCancelCalls += 1;
        },
        pause() {},
        resume() {},
        speak(utterance) {
          browserFallbackCalls += 1;
          spokenUtterances.push(utterance);
        },
      },
      SpeechSynthesisUtterance: class {
        constructor(text) {
          this.text = text;
        }
      },
      setTimeout(callback) {
        const timerId = ++windowTimerSequence;
        windowTimers.set(timerId, callback);
        return timerId;
      },
      clearTimeout(timerId) {
        windowTimers.delete(timerId);
      },
    };
    globalThis.SpeechSynthesisUtterance = globalThis.window.SpeechSynthesisUtterance;
    globalThis.URL = {
      createObjectURL: () => `blob:test-${++objectUrlSequence}`,
      revokeObjectURL(url) {
        revokedObjectUrls.push(url);
      },
    };
    globalThis.Audio = class {
      constructor(src = "") {
        this.src = src;
        this.currentTime = 0;
        this.pauseCalls = 0;
        this.playCalls = 0;
        audioInstances.push(this);
      }
      async play() {
        this.playCalls += 1;
        this.onplay?.();
      }
      pause() {
        this.pauseCalls += 1;
      }
    };
    globalThis.fetch = (url, options = {}) => {
      if (String(url).includes("waiting-bridge.catalog")) return Promise.resolve({ ok: false });
      requests.push(options);
      if (resolveTtsImmediately) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "audio/wav" },
          blob: async () => ({ size: 1 }),
        });
      }
      return new Promise((_resolve, reject) => {
        const safetyTimeout = setTimeout(() => reject(new Error("voice verifier safety timeout")), 30);
        options.signal.addEventListener("abort", () => {
          clearTimeout(safetyTimeout);
          reject(createAbortLikeError(options.signal));
        }, { once: true });
      });
    };
    const {
      VoiceOutputAdapter,
      createResponseEnvelope,
    } = await import(`../../src/voice/voice-output-adapter.js?verify-abort=${Date.now()}`);
    const adapter = new VoiceOutputAdapter({ provider: "gpt-sovits", endpoint: "/api/tts" });

    const preAborted = new AbortController();
    preAborted.abort("voice-pre-cancelled");
    await assertCancellation(
      adapter.speak("不应播报", { signal: preAborted.signal }),
      "voice-pre-cancelled",
      "pre-aborted TTS must reject",
    );
    assert.equal(requests.length, 0, "pre-aborted TTS must not dispatch synthesis");
    assert.equal(browserFallbackCalls, 0, "pre-aborted TTS must not start browser fallback");

    const caller = new AbortController();
    const pending = adapter.speak("测试语音取消", { signal: caller.signal });
    await Promise.resolve();
    assert.equal(requests.length, 1);
    caller.abort("voice-user-cancelled");
    await assertCancellation(pending, "voice-user-cancelled", "TTS caller cancellation must reject");
    assert.equal(requests[0].signal.aborted, true, "TTS fetch must receive the composed abort signal");
    assert.equal(browserFallbackCalls, 0, "cancelled TTS must not start browser fallback");

    const scheduledBridgeAdapter = new VoiceOutputAdapter({ provider: "gpt-sovits", endpoint: "/api/tts" });
    const scheduledBridgeCaller = trackAbortListeners();
    const scheduledBridgePending = scheduledBridgeAdapter.speak(
      createResponseEnvelope("等待合成", { voiceBridge: { allowed: true } }),
      { signal: scheduledBridgeCaller.signal },
    );
    const staleBridgeTimer = windowTimers.get(scheduledBridgeAdapter.bridgeTimer);
    assert.equal(typeof staleBridgeTimer, "function", "authorized bridge must schedule its threshold timer");
    scheduledBridgeCaller.controller.abort("voice-bridge-scheduled-cancelled");
    await assertCancellation(
      scheduledBridgePending,
      "voice-bridge-scheduled-cancelled",
      "caller cancellation with a scheduled bridge must reject",
    );
    assert.equal(scheduledBridgeAdapter.bridgeTimer, null, "caller cancellation must clear the bridge timer");
    assert.equal(windowTimers.size, 0, "caller cancellation must leave no bridge timers");
    staleBridgeTimer();
    assert.equal(browserFallbackCalls, 0, "a cleared stale bridge callback must not start browser speech");
    assert.equal(scheduledBridgeCaller.listenerCount(), 0, "pending-run caller listener must detach after cancellation");

    const bridgeAudioAdapter = new VoiceOutputAdapter({ provider: "gpt-sovits", endpoint: "/api/tts" });
    bridgeAudioAdapter.prebakedBridgeCatalog = {
      items: [{
        assetId: "short-review",
        tier: "short",
        fileName: "short-review.wav",
        durationMs: 100,
        answerCharacterRange: { minInclusive: 0, maxInclusive: 40 },
        profileId: "review",
        synthesisProfileId: "review",
        licenseBoundary: "local-non-commercial-testing-only",
      }],
    };
    const bridgeAudioCaller = trackAbortListeners();
    const bridgeAudioPending = bridgeAudioAdapter.speak(
      createResponseEnvelope("等待桥接音频", { voiceBridge: { allowed: true } }),
      { signal: bridgeAudioCaller.signal },
    );
    runWindowTimer(bridgeAudioAdapter.bridgeTimer);
    const activeBridgeAudio = bridgeAudioAdapter.bridgeAudio;
    assert.ok(activeBridgeAudio, "bridge threshold must start the pre-baked audio fixture");
    assert.equal(activeBridgeAudio.playCalls, 1);
    assert.ok(bridgeAudioAdapter.bridgeWatchdogTimer, "started bridge audio must own a watchdog");
    bridgeAudioCaller.controller.abort("voice-bridge-audio-cancelled");
    await assertCancellation(
      bridgeAudioPending,
      "voice-bridge-audio-cancelled",
      "caller cancellation with active bridge audio must reject",
    );
    assert.equal(activeBridgeAudio.pauseCalls, 1, "caller cancellation must pause active bridge audio");
    assert.equal(activeBridgeAudio.currentTime, 0, "caller cancellation must reset active bridge audio");
    assert.equal(bridgeAudioAdapter.bridgeAudio, null);
    assert.equal(bridgeAudioAdapter.bridgeWatchdogTimer, null);
    assert.equal(windowTimers.size, 0, "bridge teardown must clear the watchdog timer");
    assert.equal(bridgeAudioCaller.listenerCount(), 0);

    resolveTtsImmediately = true;
    const playbackCaller = trackAbortListeners();
    await adapter.speak("已经开始播放的语音", { signal: playbackCaller.signal });
    const playbackAudio = audioInstances.at(-1);
    const playbackObjectUrl = playbackAudio.src;
    assert.equal(playbackCaller.listenerCount(), 1, "caller listener must remain through HTML Audio playback");
    playbackCaller.controller.abort("voice-playback-cancelled");
    assert.equal(playbackAudio.pauseCalls, 1, "playback cancellation must pause audible HTML Audio");
    assert.equal(playbackAudio.currentTime, 0, "playback cancellation must reset HTML Audio");
    assert.ok(revokedObjectUrls.includes(playbackObjectUrl), "playback cancellation must revoke the active Object URL");
    assert.equal(adapter.audio, null);
    assert.equal(adapter.objectUrl, "");
    playbackAudio.onerror?.();
    assert.equal(browserFallbackCalls, 0, "post-synthesis cancellation must suppress later audio-error fallback");
    assert.equal(playbackCaller.listenerCount(), 0, "playback caller listener must detach after cancellation");

    const replacementAdapter = new VoiceOutputAdapter({ provider: "gpt-sovits", endpoint: "/api/tts" });
    const staleCaller = trackAbortListeners();
    await replacementAdapter.speak("旧播放", { signal: staleCaller.signal });
    const replacedAudio = audioInstances.at(-1);
    const currentCaller = trackAbortListeners();
    await replacementAdapter.speak("新播放", { signal: currentCaller.signal });
    const currentAudio = audioInstances.at(-1);
    assert.equal(replacedAudio.pauseCalls, 1, "replacement must stop the old audible run");
    assert.equal(staleCaller.listenerCount(), 0, "replacement must detach the old caller listener");
    assert.equal(currentCaller.listenerCount(), 1);
    staleCaller.controller.abort("stale-voice-cancelled");
    assert.equal(currentAudio.pauseCalls, 0, "a stale caller signal must not stop the replacement run");
    replacementAdapter.stop();
    assert.equal(currentAudio.pauseCalls, 1);
    assert.equal(currentCaller.listenerCount(), 0, "explicit stop must detach the current caller listener");

    const completedAdapter = new VoiceOutputAdapter({ provider: "gpt-sovits", endpoint: "/api/tts" });
    const completedCaller = trackAbortListeners();
    await completedAdapter.speak("自然结束", { signal: completedCaller.signal });
    assert.equal(completedCaller.listenerCount(), 1);
    audioInstances.at(-1).onended?.();
    await Promise.resolve();
    assert.equal(completedCaller.listenerCount(), 0, "normal HTML Audio completion must detach the caller listener");

    const browserAdapter = new VoiceOutputAdapter({ provider: "browser" });
    const browserCaller = trackAbortListeners();
    await browserAdapter.speak("浏览器语音取消", { signal: browserCaller.signal });
    const cancelCallsBeforeBrowserAbort = browserCancelCalls;
    assert.equal(browserCaller.listenerCount(), 1, "browser speech must retain its caller listener while audible");
    browserCaller.controller.abort("voice-browser-cancelled");
    assert.equal(browserCancelCalls, cancelCallsBeforeBrowserAbort + 1, "browser caller cancellation must cancel speech synthesis");
    assert.equal(browserCaller.listenerCount(), 0);

    const browserCompletedCaller = trackAbortListeners();
    await browserAdapter.speak("浏览器语音自然结束", { signal: browserCompletedCaller.signal });
    assert.equal(browserCompletedCaller.listenerCount(), 1);
    spokenUtterances.at(-1).onend?.();
    assert.equal(browserCompletedCaller.listenerCount(), 0, "browser speech completion must detach the caller listener");

    const browserFailedCaller = trackAbortListeners();
    await browserAdapter.speak("浏览器语音错误", { signal: browserFailedCaller.signal });
    assert.equal(browserFailedCaller.listenerCount(), 1);
    spokenUtterances.at(-1).onerror?.();
    assert.equal(browserFailedCaller.listenerCount(), 0, "browser speech error must detach the caller listener");

    const wavHeader = new Uint8Array(44);
    const wavView = new DataView(wavHeader.buffer);
    const writeAscii = (offset, value) => wavHeader.set([...value].map((character) => character.charCodeAt(0)), offset);
    writeAscii(0, "RIFF");
    wavView.setUint32(4, 40, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    wavView.setUint32(16, 16, true);
    wavView.setUint16(20, 1, true);
    wavView.setUint16(22, 1, true);
    wavView.setUint32(24, 24_000, true);
    wavView.setUint32(28, 48_000, true);
    wavView.setUint16(32, 2, true);
    wavView.setUint16(34, 16, true);
    writeAscii(36, "data");
    wavView.setUint32(40, 4, true);
    const streamingBytes = new Uint8Array([...wavHeader, 0, 0, 10, 0]);
    const streamingSources = [];
    globalThis.window.AudioContext = class {
      constructor() {
        this.currentTime = 0;
        this.state = "running";
        this.destination = {};
      }
      async resume() {}
      createBuffer(_channels, frames, sampleRate) {
        return { duration: frames / sampleRate, getChannelData: () => new Float32Array(frames) };
      }
      createBufferSource() {
        const source = {
          onended: null,
          stopCalls: 0,
          connect() {},
          start() {},
          stop() {
            this.stopCalls += 1;
            queueMicrotask(() => this.onended?.());
          },
        };
        streamingSources.push(source);
        return source;
      }
    };
    globalThis.fetch = async (url) => {
      if (String(url).includes("waiting-bridge.catalog")) return { ok: false };
      let readCount = 0;
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            if (name === "x-nio-tts-proxy-mode") return "streaming-poc";
            if (name === "content-type") return "audio/wav";
            return null;
          },
        },
        body: {
          getReader: () => ({
            read: async () => readCount++ === 0
              ? { done: false, value: streamingBytes }
              : { done: true },
          }),
        },
      };
    };
    const streamingAdapter = new VoiceOutputAdapter({
      provider: "gpt-sovits",
      streamingPoc: true,
      streamingEndpoint: "/api/tts-streaming-poc",
    });
    const streamingCaller = trackAbortListeners();
    const streamingFallbacksBeforeAbort = browserFallbackCalls;
    const streamingPending = streamingAdapter.speak("流式取消", { signal: streamingCaller.signal });
    for (let attempt = 0; attempt < 10 && streamingAdapter.ttsTelemetry?.chunks?.[0]?.completeAudioReadyMs === undefined; attempt += 1) {
      await Promise.resolve();
    }
    assert.equal(streamingSources.length, 1, "streaming fixture must schedule an audible Web Audio source");
    assert.equal(
      typeof streamingAdapter.ttsTelemetry.chunks[0].completeAudioReadyMs,
      "number",
      "streaming fixture must finish reading and be waiting only for the scheduled source",
    );
    streamingCaller.controller.abort("voice-streaming-cancelled");
    assert.equal(streamingSources[0].stopCalls, 1, "streaming caller cancellation must stop scheduled Web Audio");
    await assertCancellation(
      streamingPending,
      "voice-streaming-cancelled",
      "pending streaming speak must reject after caller cancellation",
    );
    assert.equal(streamingCaller.listenerCount(), 0);
    assert.equal(browserFallbackCalls, streamingFallbacksBeforeAbort, "streaming cancellation must not start browser fallback");
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

async function verifyLiveControllers() {
  const [
    { CabinAssistantController },
    { OrchestratorController },
    { executeKnowledgeSubplan },
    { createExecutionFacts, createGoalEnvelope, createTaskPlan },
    { createKnowledgeAnswer, createKnowledgeDelegation, createKnowledgeSubplan },
    { createAbortError },
  ] = await Promise.all([
    import(`../../src/agents/cabin-assistant-controller.js?verify-abort=${Date.now()}`),
    import(`../../src/agents/orchestrator-controller.js?verify-abort=${Date.now()}`),
    import(`../../src/application/use-cases/vehicle-knowledge-execution.js?verify-abort=${Date.now()}`),
    import(`../../src/agents/agent-contracts.js?verify-abort=${Date.now()}`),
    import(`../../src/application/contracts/vehicle-knowledge.js?verify-abort=${Date.now()}`),
    import(`../../src/runtime/abort-utils.js?verify-controller-abort=${Date.now()}`),
  ]);

  const runId = "abort-live-controller";
  const parsedCommand = {
    requestId: runId,
    rawText: "解释 ES8 尾门开启条件",
    intent: "conversation.general",
    slots: { topic: "vehicle_knowledge" },
    slotProvenance: {},
    speechAct: "question",
    actionability: {
      actionable: false,
      source: "abort-verifier",
      intendedIntent: "conversation.general",
    },
  };
  const goal = createGoalEnvelope({
    goalId: `goal:${runId}`,
    runId,
    objective: parsedCommand.rawText,
    interactionType: "explain",
    domain: "manual",
    constraints: [],
    contextRefs: [],
    requiredClarifications: [],
    readyForPlanning: true,
    model: "abort-verifier",
    provider: "fixture",
    confidenceStrength: "strong",
  });
  const planSteps = [{
    stepId: "manual",
    capabilityId: "manual.retrieve",
    dependsOn: [],
    input: { query: parsedCommand.rawText },
    expectedOutput: "manual-evidence",
    accessMode: "read",
    status: "planned",
  }, {
    stepId: "response",
    capabilityId: "response.synthesize",
    dependsOn: ["manual"],
    input: { facts: { summary: "根据手册回答。", evidenceRefs: [] } },
    expectedOutput: "response",
    accessMode: "read",
    status: "planned",
  }];
  const plan = createTaskPlan({
    planId: `plan:${runId}`,
    goalId: goal.goalId,
    runId,
    steps: planSteps,
    selectedCapabilities: planSteps.map((step) => step.capabilityId),
    writeActionCount: 0,
    planningSummary: "检索后回答。",
    model: "abort-verifier",
    provider: "fixture",
    status: "planned",
  });
  const facts = createExecutionFacts({
    runId,
    goalId: goal.goalId,
    planId: plan.planId,
    stepResults: plan.steps.map((step) => ({
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      status: "completed",
      result: { summary: "done" },
    })),
    evidenceRefs: [],
    safetyDecision: null,
    toolResult: null,
    confirmedVehicleState: null,
    degraded: false,
    failureReason: "",
    completionStatus: "completed",
  });

  const goalEntered = deferred();
  const cabin = new CabinAssistantController({
    modelAdapter: {
      formGoal(input) {
        return stageResultAfterAbortWindow(input.signal, goalEntered, {
          output: goal,
          telemetry: {},
        });
      },
      synthesizeAgentResponse() {
        return { output: { response: "完成", writeCompletionStatus: "not-applicable" }, telemetry: {} };
      },
    },
  });
  const goalCaller = new AbortController();
  const goalPending = cabin.formGoal({
    runId,
    rawText: goal.objective,
    parsedCommand,
    context: {},
    signal: goalCaller.signal,
  });
  await goalEntered.promise;
  goalCaller.abort("cabin-goal-cancelled");
  await assertCancellation(goalPending, "cabin-goal-cancelled", "Cabin goal cancellation must bypass degradation");

  const synthesisEntered = deferred();
  cabin.modelAdapter.synthesizeAgentResponse = (input) => stageResultAfterAbortWindow(
    input.signal,
    synthesisEntered,
    { output: { response: "完成", writeCompletionStatus: "not-applicable" }, telemetry: {} },
  );
  const synthesisCaller = new AbortController();
  const synthesisPending = cabin.synthesize({
    goalEnvelope: goal,
    taskPlan: plan,
    executionFacts: facts,
    signal: synthesisCaller.signal,
  });
  await synthesisEntered.promise;
  synthesisCaller.abort("cabin-synthesis-cancelled");
  await assertCancellation(
    synthesisPending,
    "cabin-synthesis-cancelled",
    "Cabin synthesis cancellation must bypass facts-only fallback",
  );

  const providerAbort = createAbortError("controller-provider-internal-abort");
  cabin.modelAdapter.formGoal = async () => { throw providerAbort; };
  const degradedGoal = await cabin.formGoal({
    runId,
    rawText: goal.objective,
    parsedCommand,
    context: {},
    signal: new AbortController().signal,
  });
  assert.equal(degradedGoal.goalEnvelope, null);
  assert.equal(degradedGoal.degraded, true);
  assert.equal(degradedGoal.telemetry.reason, "model-unavailable");

  const planningEntered = deferred();
  const orchestrator = new OrchestratorController({
    modelAdapter: {
      createTaskPlan(input) {
        return stageResultAfterAbortWindow(input.signal, planningEntered, {
          output: plan,
          telemetry: {},
        });
      },
    },
  });
  const planningCaller = new AbortController();
  const planningPending = orchestrator.plan({
    runId,
    goalEnvelope: goal,
    signal: planningCaller.signal,
  });
  await planningEntered.promise;
  planningCaller.abort("orchestrator-cancelled");
  await assertCancellation(planningPending, "orchestrator-cancelled", "Orchestrator planning must be cancellable");

  const delegation = createKnowledgeDelegation({
    delegationId: `delegation:${runId}`,
    runId,
    parentPlanId: plan.planId,
    parentStepId: "manual",
    knowledgeGoal: parsedCommand.rawText,
    vehicleScope: "nio-es8-user-manual-2026",
    allowedCapabilities: ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
    allowVehicleStateRead: false,
    requireSafetyEligibilityExplanation: false,
    expectedAnswerContract: "KnowledgeAnswer",
    dependsOn: [],
  });
  const knowledgeSteps = [{
    stepId: "manual",
    capabilityId: "knowledge.manual.retrieve",
    dependsOn: [],
    input: { query: delegation.knowledgeGoal },
    expectedOutput: "manual-evidence",
    accessMode: "read",
    status: "planned",
  }, {
    stepId: "answer",
    capabilityId: "knowledge.answer.synthesize",
    dependsOn: ["manual"],
    input: { facts: { summary: "回答", evidenceRefs: [] } },
    expectedOutput: "knowledge-answer",
    accessMode: "read",
    status: "planned",
  }];
  const subplan = createKnowledgeSubplan({
    subplanId: `subplan:${runId}`,
    delegationId: delegation.delegationId,
    runId,
    parentPlanId: delegation.parentPlanId,
    parentStepId: delegation.parentStepId,
    steps: knowledgeSteps,
    selectedCapabilities: knowledgeSteps.map((step) => step.capabilityId),
    planningSummary: "检索后回答。",
    model: "fixture",
    provider: "fixture",
    status: "planned",
  });
  const answer = createKnowledgeAnswer({
    delegationId: delegation.delegationId,
    runId,
    outcomeStatus: "answered",
    supportStatus: "supported",
    answer: "尾门开启条件见手册。",
    evidenceRefs: [{ id: "manual:tailgate", source: "manual", type: "manual", title: "尾门", citation: "p.1" }],
    vehicleStateRefs: [],
    safetyAssessmentRef: null,
    limitations: [],
    model: "fixture",
    provider: "fixture",
    durationMs: 1,
    degraded: false,
  });
  const knowledgePlanningEntered = deferred();
  const knowledgeModelAdapter = {
      createTaskPlan() { throw new Error("not used by knowledge planning"); },
      formGoal() { throw new Error("not used by knowledge synthesis"); },
      synthesizeAgentResponse() { throw new Error("not used by knowledge synthesis"); },
      createVehicleKnowledgeSubplan(input) {
        return stageResultAfterAbortWindow(input.signal, knowledgePlanningEntered, {
          output: subplan,
          telemetry: {},
        });
      },
      synthesizeVehicleKnowledgeAnswer() {
        return { output: answer, telemetry: {} };
      },
  };
  const knowledgeOrchestrator = new OrchestratorController({
    modelAdapter: knowledgeModelAdapter,
  });
  const knowledgeCabin = new CabinAssistantController({
    modelAdapter: knowledgeModelAdapter,
  });
  const knowledgePlanningCaller = new AbortController();
  const knowledgePlanningPending = knowledgeOrchestrator.planKnowledgeTask({
    delegation,
    complexity: "multi-target",
    signal: knowledgePlanningCaller.signal,
  });
  await knowledgePlanningEntered.promise;
  knowledgePlanningCaller.abort("knowledge-plan-cancelled");
  await assertCancellation(
    knowledgePlanningPending,
    "knowledge-plan-cancelled",
    "Orchestrator knowledge planning cancellation must bypass invalid-plan fallback",
  );

  const knowledgeSynthesisEntered = deferred();
  knowledgeModelAdapter.synthesizeVehicleKnowledgeAnswer = (input) => stageResultAfterAbortWindow(
    input.signal,
    knowledgeSynthesisEntered,
    { output: answer, telemetry: {} },
  );
  const knowledgeSynthesisCaller = new AbortController();
  const knowledgeSynthesisPending = knowledgeCabin.composeKnowledgeResponse({
    delegation,
    subplan,
    executionFacts: {
      outcomeStatus: "completed",
      evidenceRefs: answer.evidenceRefs,
      evidence: [],
      vehicleStateRefs: [],
      safetyAssessmentRef: null,
    },
    signal: knowledgeSynthesisCaller.signal,
  });
  await knowledgeSynthesisEntered.promise;
  knowledgeSynthesisCaller.abort("knowledge-synthesis-cancelled");
  await assertCancellation(
    knowledgeSynthesisPending,
    "knowledge-synthesis-cancelled",
    "Cabin knowledge synthesis cancellation must bypass unavailable fallback",
  );

  const evidenceEntered = deferred();
  const evidenceCaller = new AbortController();
  const evidencePending = executeKnowledgeSubplan({
    delegation,
    subplan,
    manualRetriever(_query, input) {
      return stageResultAfterAbortWindow(input.signal, evidenceEntered, []);
    },
    signal: evidenceCaller.signal,
  });
  await evidenceEntered.promise;
  evidenceCaller.abort("knowledge-evidence-cancelled");
  await assertCancellation(
    evidencePending,
    "knowledge-evidence-cancelled",
    "knowledge evidence cancellation must bypass unavailable fallback",
  );

  const lateEvidenceEntered = deferred();
  const lateEvidenceResult = deferred();
  const lateEvidenceCaller = new AbortController();
  const lateEvidencePending = executeKnowledgeSubplan({
    delegation,
    subplan,
    manualRetriever(_query, input) {
      assert.equal(input.signal, lateEvidenceCaller.signal);
      lateEvidenceEntered.resolve();
      return lateEvidenceResult.promise;
    },
    signal: lateEvidenceCaller.signal,
  });
  await lateEvidenceEntered.promise;
  const lateEvidenceReason = Object.freeze({ code: "knowledge-evidence-late-cancelled" });
  lateEvidenceCaller.abort(lateEvidenceReason);
  lateEvidenceResult.resolve([]);
  await assertCancellation(
    lateEvidencePending,
    lateEvidenceReason,
    "a late successful Manual dependency must retain the caller cancellation terminal",
  );

  knowledgeModelAdapter.createVehicleKnowledgeSubplan = async () => { throw providerAbort; };
  const unavailablePlan = await knowledgeOrchestrator.planKnowledgeTask({
    delegation,
    complexity: "multi-target",
    signal: new AbortController().signal,
  });
  assert.equal(unavailablePlan.subplan, null);
  assert.equal(unavailablePlan.validation.ok, false);
  assert.equal(unavailablePlan.telemetry.reason, "model-unavailable");
}

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function stageResultAfterAbortWindow(signal, entered, value) {
  entered.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(result);
    };
    const onAbort = () => finish(reject, createAbortLikeError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else setTimeout(() => finish(resolve, value), 10);
  });
}

const cases = {
  utility: verifyUtility,
  local: verifyLocalSemantic,
  cloud: verifyCloudLlm,
  external: verifyExternalData,
  voice: verifyVoiceOutput,
  controllers: verifyLiveControllers,
};

const selected = selectedCase === "all" ? Object.entries(cases) : [[selectedCase, cases[selectedCase]]];
assert.equal(typeof selected[0]?.[1], "function", `unknown abort verifier case: ${selectedCase}`);
for (const [name, verify] of selected) {
  await verify();
  console.log(`PASS runtime abort propagation: ${name}`);
}
