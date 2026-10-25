import assert from "node:assert/strict";
import fs from "node:fs/promises";

globalThis.window = {};
globalThis.URL.createObjectURL = () => "blob:tts-test";
globalThis.URL.revokeObjectURL = () => {};
globalThis.Audio = class {
  async play() {
    this.onplay?.();
  }
  pause() {}
};

const responseHeaders = new Headers({
  "content-type": "audio/wav",
  "x-nio-tts-proxy-total-ms": "321",
  "x-nio-tts-upstream-first-response-ms": "123",
  "x-nio-tts-streaming-mode": "buffered",
  "x-nio-tts-profile-id": "sandrone-dev",
  "x-nio-tts-profile-version": "1.0.0",
  "x-nio-tts-synthesis-profile-id": "sandrone-dev-gptsovits-cpu-balanced@1.0.0",
  "x-nio-tts-license-boundary": "local-non-commercial-testing-only",
});
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: responseHeaders,
  blob: async () => new Blob(["audio"]),
});

const { VoiceOutputAdapter, VEHICLE_SPEECH_TEXT_POLICY, buildVehicleSpeechText, createResponseEnvelope, readTtsResponseTelemetry } = await import(`../../src/voice/voice-output-adapter.js?tts-telemetry=${Date.now()}`);
const parsedHeaders = readTtsResponseTelemetry(responseHeaders);
assert.equal(parsedHeaders["x-nio-tts-proxy-total-ms"], "321");
assert.equal(parsedHeaders["x-nio-tts-upstream-first-response-ms"], "123");
assert.equal(parsedHeaders["x-nio-tts-error"], "unavailable");
assert.equal(parsedHeaders["x-nio-tts-profile-id"], "sandrone-dev");
assert.equal(parsedHeaders["x-nio-tts-synthesis-profile-id"], "sandrone-dev-gptsovits-cpu-balanced@1.0.0");
assert.equal(parsedHeaders["x-nio-tts-license-boundary"], "local-non-commercial-testing-only");
assert.equal(
  buildVehicleSpeechText("杭州今天小阵雨，25.2°C到33°C，降水概率最高100%。数据来自 Open-Meteo，时间边界 2026-07-11T20:45。"),
  "杭州今天小阵雨，25.2°C到33°C，降水概率最高100%。",
);
assert.equal(
  buildVehicleSpeechText("尾门开启前请确认后方安全。\n\n手册依据：ES8 用户手册 p.62「尾门」"),
  "尾门开启前请确认后方安全。",
);
assert.equal(
  buildVehicleSpeechText("第一句说明当前可以执行。第二句保留关键建议。第三句和后面的长解释也应完整朗读。"),
  "第一句说明当前可以执行。第二句保留关键建议。第三句和后面的长解释也应完整朗读。",
);

const samples = [];
const adapter = new VoiceOutputAdapter({ provider: "gpt-sovits", endpoint: "/api/tts" });
adapter.onTelemetry = (sample) => samples.push(sample);
await adapter.speak(createResponseEnvelope("这是一次屏幕显示的遥测验证。数据来自 Open-Meteo，时间边界 2026-07-11T20:45。"));
const playing = samples.at(-1);
assert.equal(playing.provider, "gpt-sovits");
assert.equal(playing.status, "playing");
assert.equal(playing.chunkCount, 1);
assert.ok(playing.displayTextChars > playing.speechTextChars);
assert.equal(playing.speechTextPolicy.id, VEHICLE_SPEECH_TEXT_POLICY.id);
assert.equal(playing.speechTextPolicy.providerCapabilityPolicyId, "nio-voice-provider-capability@1.1.0");
assert.equal(playing.speechTextProvenance, "assistant-response");
assert.equal(playing.capabilities.separateShortOpener, false);
assert.equal(playing.chunks[0].httpStatus, 200);
assert.equal(playing.chunks[0].responseHeaders["x-nio-tts-streaming-mode"], "buffered");
assert.equal(typeof playing.chunks[0].responseHeadersMs, "number");
assert.equal(typeof playing.chunks[0].requestToResponseHeadersMs, "number");
assert.equal(typeof playing.chunks[0].completeAudioReadyMs, "number");
assert.equal(typeof playing.chunks[0].requestToCompleteAudioReadyMs, "number");
assert.equal(typeof playing.firstPlayStartedMs, "number");

const unavailableSamples = [];
const unavailable = new VoiceOutputAdapter({ provider: "browser" });
unavailable.onTelemetry = (sample) => unavailableSamples.push(sample);
await unavailable.speak("浏览器语音不可用。");
assert.equal(unavailableSamples.at(-1).provider, "unavailable");
assert.equal(unavailableSamples.at(-1).status, "unavailable");

const appSource = await fs.readFile(new URL("../../src/app/app.js", import.meta.url), "utf8");
assert.match(appSource, /<h3>TTS 响应速度<\/h3>/);
assert.match(appSource, /首块请求 → 完整音频就绪/);
assert.match(appSource, /最大分块间隔/);
assert.match(appSource, /不代表字节流 TTFA/);
assert.match(appSource, /firstChunk\?\.requestToResponseHeadersMs/);
assert.match(appSource, /tts\?\.firstPlayStartedMs/);
assert.match(appSource, /tts\?\.maxChunkGapMs/);
assert.match(appSource, /const speechTextPolicy = getVehicleSpeechTextPolicy\(voiceOutputAdapter\.provider\)/);
assert.match(appSource, /rawSpeechText: result\.assistantSpeechText/);
assert.match(appSource, /manual-runtime-speech-text/);
assert.match(appSource, /speechTextPolicy,/);
assert.match(appSource, /function getRuntimeDebugSnapshot\(\)/);
assert.match(appSource, /latestRun: latestRunSnapshot/);
assert.match(appSource, /window\.__runtimeDebug = getRuntimeDebugSnapshot;/);

console.log(JSON.stringify({
  responseHeaders: true,
  completeFirstChunkReady: true,
  firstPlayback: true,
  unavailableBoundary: true,
  bufferedTtfaLabel: true,
  latestRunDebugHook: true,
  speechTextGovernance: true,
}, null, 2));
