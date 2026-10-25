import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const verifierSource = await readFile(new URL("./verify-voice-output-chunks.mjs", import.meta.url), "utf8");
assert.doesNotMatch(verifierSource, /gptSoVitsCapabilities\.(?:maxChunkLength|prefetchWindow|maxConcurrentRequests)\s*,\s*\d+/, "voice verifier must not duplicate provider capability literals");

const originals = { window: globalThis.window, SpeechSynthesisUtterance: globalThis.SpeechSynthesisUtterance, fetch: globalThis.fetch, Audio: globalThis.Audio, URL: globalThis.URL };
const browserSpeech = [];
const requests = [];
const audioInstances = [];
const revokedUrls = [];
let urlSequence = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function successfulResponse() {
  return { ok: true, status: 200, headers: { get: () => "audio/wav" }, blob: async () => ({ size: 1 }) };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

try {
  globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak(utterance) { browserSpeech.push(utterance.text); } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
  };
  globalThis.SpeechSynthesisUtterance = globalThis.window.SpeechSynthesisUtterance;
  globalThis.URL = {
    createObjectURL: () => `blob:test-${++urlSequence}`,
    revokeObjectURL(url) { revokedUrls.push(url); },
  };
  globalThis.Audio = class {
    constructor(url) { this.url = url; this.currentTime = 0; this.playCalls = 0; audioInstances.push(this); }
    async play() { this.playCalls += 1; this.onplay?.(); }
    pause() {}
  };
  globalThis.fetch = (_url, options) => {
    const pending = deferred();
    const request = { text: JSON.parse(options.body).text, signal: options.signal, ...pending };
    requests.push(request);
    options.signal.addEventListener("abort", () => pending.reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    return pending.promise;
  };

  const {
    VoiceOutputAdapter,
    VEHICLE_SPEECH_TEXT_POLICY,
    VOICE_PROVIDER_CAPABILITY_POLICY,
    buildVehicleSpeechText,
    createResponseEnvelope,
    getVehicleSpeechTextPolicy,
    getVoiceProviderCapabilities,
    prepareSpeechText,
    splitSpeechText,
  } = await import(`../../src/voice/voice-output-adapter.js?chunk-test=${Date.now()}`);
  const gptSoVitsCapabilities = getVoiceProviderCapabilities("gpt-sovits");
  const gptSoVitsPolicy = VOICE_PROVIDER_CAPABILITY_POLICY.providers["gpt-sovits"];
  assert.deepEqual(gptSoVitsCapabilities, {
    ...gptSoVitsPolicy,
    supportedLanguages: [...gptSoVitsPolicy.supportedLanguages],
  });
  assert.ok(gptSoVitsCapabilities.estimatedCharsPerSecond > 0);
  assert.equal(gptSoVitsCapabilities.separateShortOpener, false);
  assert.equal(
    prepareSpeechText("请先确认后方安全。\n\n手册依据：《ES8 用户手册》第 88 页「尾门开启」。"),
    "请先确认后方安全。",
    "screen citations should remain outside the spoken TTS text",
  );
  assert.equal(
    prepareSpeechText(createResponseEnvelope("屏幕显示文本\n\n手册依据：p.1", { speechText: "只播报这句" })),
    "只播报这句",
    "ResponseEnvelope speechText must drive TTS instead of display text",
  );
  const overlongFirstSentence = `今天杭州阵雨概率偏高，午后体感会比较闷热，如果只是短时间通风可以开一会儿窗，但雨势变大时建议及时关窗，避免雨水进入车内。`;
  const gptSoVitsSpeechPolicy = getVehicleSpeechTextPolicy("gpt-sovits");
  assert.equal(gptSoVitsSpeechPolicy.providerCapabilityPolicyId, VOICE_PROVIDER_CAPABILITY_POLICY.id);
  const completeSpeechText = buildVehicleSpeechText(`${overlongFirstSentence}第二句也必须完整播报。\n\n数据来源：测试数据。`);
  assert.equal(completeSpeechText, `${overlongFirstSentence}第二句也必须完整播报。`, "spoken body should retain every non-audit sentence");
  assert.deepEqual(
    splitSpeechText(completeSpeechText, "gpt-sovits").join(""),
    completeSpeechText,
    "provider chunks must reconstruct the complete spoken body",
  );
  assert.deepEqual(splitSpeechText("短句保持完整。", "gpt-sovits"), ["短句保持完整。"]);
  const maxChunkLength = gptSoVitsPolicy.maxChunkLength;
  assert.deepEqual(splitSpeechText("a".repeat(maxChunkLength + 2), "gpt-sovits"), ["a".repeat(maxChunkLength), "aa"]);
  assert.deepEqual(
    splitSpeechText(`你好，${"a".repeat(maxChunkLength + 12)}`, "gpt-sovits"),
    [`你好，${"a".repeat(maxChunkLength - 3)}`, "a".repeat(15)],
    "short openers should be packed into the first GPT-SoVITS request to avoid tiny opener gap",
  );
  assert.deepEqual(
    splitSpeechText(`${"一".repeat(maxChunkLength)}${"二".repeat(4)}。后续短句。`, "gpt-sovits"),
    ["一".repeat(maxChunkLength), `${"二".repeat(4)}。后续短句。`],
    "tiny non-opener leftovers should be packed into the next TTS request",
  );

  const first = "一".repeat(maxChunkLength);
  const second = "二".repeat(maxChunkLength);
  const third = "三".repeat(24);

  const waiting = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  const waitingSpeak = waiting.speak(`${first}${second}${third}`);
  requests[0].resolve(successfulResponse());
  await waitingSpeak;
  assert.deepEqual(requests.map(({ text }) => text), [first, second], "playing the first chunk should prefetch the next safe lookahead chunk");
  assert.equal(waiting.ttsTelemetry.capabilities.prefetchWindow, 1);
  assert.equal(waiting.ttsTelemetry.capabilities.separateShortOpener, false);
  assert.ok(waiting.ttsTelemetry.chunks[0].estimatedSpeechMs > 0);
  audioInstances[0].onended();
  await flush();
  assert.equal(audioInstances.length, 1, "an ended chunk must wait while lookahead synthesis is pending");
  requests[1].resolve(successfulResponse());
  await flush();
  assert.equal(audioInstances[1].playCalls, 1, "the waiting next chunk should play as soon as synthesis completes");
  assert.ok(Number.isFinite(waiting.ttsTelemetry.chunks[1].previousEndToPlayStartGapMs), "chunk gap telemetry should be recorded");
  assert.deepEqual(waiting.ttsTelemetry.chunkGapsMs, [waiting.ttsTelemetry.chunks[1].previousEndToPlayStartGapMs], "top-level chunk gap telemetry should mirror per-chunk gaps");
  assert.equal(waiting.ttsTelemetry.maxChunkGapMs, waiting.ttsTelemetry.chunks[1].previousEndToPlayStartGapMs, "top-level max chunk gap should be available for HMI/benchmark consumers");
  assert.deepEqual(requests.map(({ text }) => text), [first, second, third], "the third chunk starts prefetching only when the second starts playing");
  requests[2].resolve(successfulResponse());
  await flush();
  assert.equal(audioInstances.length, 3, "the third chunk should be prepared before the second ends");
  audioInstances[1].onended();
  await flush();
  assert.equal(audioInstances[2].playCalls, 1, "a completed lookahead should play immediately on ended");

  const cancelStart = requests.length;
  const cancel = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  const cancelSpeak = cancel.speak(`${first}${second}`);
  requests[cancelStart].resolve(successfulResponse());
  await cancelSpeak;
  const prefetchedUrlIndex = urlSequence;
  assert.equal(requests[cancelStart + 1].text, second);
  cancel.stop();
  assert.equal(requests[cancelStart + 1].signal.aborted, true, "stop should abort lookahead synthesis");
  assert.equal(audioInstances.at(-1).currentTime, 0, "stop should reset current audio");
  assert.ok(revokedUrls.includes(`blob:test-${prefetchedUrlIndex}`), "stop should revoke the current audio URL");

  const firstFailureStart = requests.length;
  const firstFailure = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  const firstFailurePromise = firstFailure.speak("首块失败。第二句不应单独播报。");
  requests[firstFailureStart].reject(new Error("TTS failed"));
  await firstFailurePromise;
  assert.equal(browserSpeech.at(-1), "首块失败。第二句不应单独播报。", "first chunk failure should fall back to the complete original text");

  const laterFailureStart = requests.length;
  const laterFailure = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  const laterFailurePromise = laterFailure.speak(`${first}${second}${third}`);
  requests[laterFailureStart].resolve(successfulResponse());
  await laterFailurePromise;
  requests[laterFailureStart + 1].reject(new Error("TTS failed"));
  await flush();
  audioInstances.at(-1).onended();
  await flush();
  assert.equal(browserSpeech.at(-1), `${second}${third}`, "lookahead failure should fall back only to text not yet played");

  console.log(JSON.stringify({ packedShortFragments: true, shortOpenerPacked: true, boundedLookahead: true, waitsForPending: true, immediatePreparedPlayback: true, chunkGapTelemetry: true, maxConcurrentRequests: true, cancellation: true, fallback: true }, null, 2));
} finally {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
