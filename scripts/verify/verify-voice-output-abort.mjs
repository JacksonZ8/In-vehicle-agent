import assert from "node:assert/strict";

const originals = {
  window: globalThis.window,
  SpeechSynthesisUtterance: globalThis.SpeechSynthesisUtterance,
  fetch: globalThis.fetch,
  Audio: globalThis.Audio,
  URL: globalThis.URL,
};
let browserSpeakCalls = 0;
const requests = [];

try {
  globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() { browserSpeakCalls += 1; } },
    SpeechSynthesisUtterance: class {},
  };
  globalThis.SpeechSynthesisUtterance = globalThis.window.SpeechSynthesisUtterance;
  globalThis.URL = { createObjectURL: () => "blob:test", revokeObjectURL() {} };
  globalThis.Audio = class {};
  globalThis.fetch = (url, options) => {
    if (String(url).includes("waiting-bridge.catalog")) return Promise.resolve({ ok: false });
    return new Promise((_resolve, reject) => {
    requests.push(options);
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
  };

  const { VoiceOutputAdapter } = await import(`../../src/voice/voice-output-adapter.js?abort-test=${Date.now()}`);

  const stopped = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  const stopPromise = stopped.speak("first request");
  await Promise.resolve();
  stopped.stop();
  await stopPromise;
  assert.equal(requests[0].signal.aborted, true, "stop() should abort the pending TTS fetch");
  assert.equal(browserSpeakCalls, 0, "AbortError must not trigger browser fallback");

  const replacement = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  const firstPromise = replacement.speak("first request");
  await Promise.resolve();
  const secondPromise = replacement.speak("second request");
  await Promise.resolve();
  assert.equal(requests[1].signal.aborted, true, "a later speak() should abort the earlier TTS fetch");
  replacement.stop();
  await Promise.all([firstPromise, secondPromise]);
  assert.equal(browserSpeakCalls, 0, "cancelled requests must not create browser fallback speech");

  console.log(JSON.stringify({ stopAborted: true, replacementAborted: true, browserFallbackCalls: browserSpeakCalls }, null, 2));
} finally {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
