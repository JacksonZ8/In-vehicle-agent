import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../../src/server/local-agent-server.mjs", import.meta.url), "utf8");
assert.match(server, /handleTtsStreamingPoc/);
assert.match(server, /request\.url === "\/api\/tts-streaming-poc"/);
const ttsRoutes = await readFile(new URL("../../src/server/tts/tts-routes.mjs", import.meta.url), "utf8");
const proxy = ttsRoutes.slice(ttsRoutes.indexOf("async function handleTtsStreamingPoc"), ttsRoutes.indexOf("function sendTtsJson"));
assert.doesNotMatch(proxy, /arrayBuffer\(|Buffer\.concat|response\.end\(audio\)/, "streaming proxy must not complete-buffer audio");
assert.match(proxy, /upstream\.body\.getReader\(\)/);
assert.match(proxy, /response\.write\(Buffer\.from\(value\)\)/);

const originals = { window: globalThis.window, fetch: globalThis.fetch, SpeechSynthesisUtterance: globalThis.SpeechSynthesisUtterance };
const telemetry = [];
let browserFallbacks = 0;
let sources = 0;

function wavHeader() {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  const write = (offset, value) => bytes.set([...value].map((x) => x.charCodeAt(0)), offset);
  write(0, "RIFF"); view.setUint32(4, 40, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, 4, true);
  return bytes;
}

try {
  globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() { browserFallbacks += 1; } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    AudioContext: class {
      constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; }
      async resume() {}
      createBuffer(_channels, frames, sampleRate) { return { duration: frames / sampleRate, getChannelData: () => new Float32Array(frames) }; }
      createBufferSource() { return { connect() {}, start() { sources += 1; queueMicrotask(() => this.onended?.()); }, stop() {}, onended: null }; }
    },
  };
  globalThis.SpeechSynthesisUtterance = globalThis.window.SpeechSynthesisUtterance;
  const audio = new Uint8Array([...wavHeader(), 0, 0, 10, 0]);
  globalThis.fetch = async () => {
    let index = 0;
    return {
      ok: true, status: 200,
      headers: new Headers({ "content-type": "audio/wav", "x-nio-tts-proxy-mode": "streaming-poc" }),
      body: { getReader: () => ({ read: async () => index < 2 ? { done: false, value: audio.slice(index++ === 0 ? 0 : 30, index === 1 ? 30 : audio.length) } : { done: true } }) },
    };
  };
  const { VoiceOutputAdapter } = await import(`../../src/voice/voice-output-adapter.js?streaming-poc=${Date.now()}`);
  const adapter = new VoiceOutputAdapter({ provider: "gpt-sovits", streamingPoc: true });
  adapter.onTelemetry = (entry) => telemetry.push(entry);
  await adapter.speak("流式验证。");
  const final = telemetry.at(-1);
  assert.equal(final.status, "completed");
  assert.equal(final.chunks[0].streamingPoc, true);
  assert.equal(typeof final.firstAudibleMs, "number");
  assert.ok(sources > 0, "PCM frames must be scheduled with Web Audio");
  assert.equal(browserFallbacks, 0);
  console.log(JSON.stringify({ proxyForwarding: true, firstAudible: true, scheduledSources: sources, fallback: false }, null, 2));
} finally {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
}
