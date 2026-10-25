import assert from "node:assert/strict";

const originals = {
  window: globalThis.window,
  SpeechSynthesisUtterance: globalThis.SpeechSynthesisUtterance,
  fetch: globalThis.fetch,
};
const utterances = [];

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

try {
  globalThis.window = {
    speechSynthesis: {
      cancel() {}, pause() {}, resume() {},
      speak(utterance) { utterances.push(utterance); utterance.onstart?.(); },
    },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
  };
  globalThis.SpeechSynthesisUtterance = globalThis.window.SpeechSynthesisUtterance;
  globalThis.fetch = async () => ({ ok: false });

  const { VoiceOutputAdapter, waitForVoicePlaybackCompletion } = await import(
    `../../src/voice/voice-output-adapter.js?playback-completion=${Date.now()}`
  );

  const adapter = new VoiceOutputAdapter({ provider: "browser" });
  const statuses = [];
  const unsubscribe = adapter.subscribeStatus(({ status }) => statuses.push(status));
  adapter.setStatus("loading", "browser");
  unsubscribe();
  adapter.setStatus("speaking", "browser");
  assert.deepEqual(statuses, ["loading"], "unsubscribe must stop status delivery");

  let completed = false;
  const playback = waitForVoicePlaybackCompletion(adapter, () => adapter.speak("受控播报。"));
  playback.then(() => { completed = true; });
  await flush();
  assert.equal(adapter.status, "speaking");
  assert.equal(completed, false, "onstart must not complete playback waiting");
  utterances.at(-1).onend();
  await playback;
  assert.equal(completed, true, "onend must complete playback waiting");

  const stopped = waitForVoicePlaybackCompletion(adapter, () => adapter.speak("停止播报。"));
  await flush();
  adapter.stop();
  await stopped;
  assert.equal(adapter.status, "idle", "Stop TTS must resolve playback waiting at idle");

  let fallbackCompleted = false;
  const fallback = waitForVoicePlaybackCompletion(adapter, () => {
    adapter.setStatus("loading", "gpt-sovits");
    adapter.setStatus("idle", "gpt-sovits");
    adapter.setStatus("fallback", "browser");
  });
  fallback.then(() => { fallbackCompleted = true; });
  await flush();
  assert.equal(fallbackCompleted, false,
    "a synchronous GPT stop-to-browser fallback transition must not look playback-complete");
  adapter.setStatus("idle", "browser");
  await fallback;

  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
  const loadingAdapter = new VoiceOutputAdapter({ provider: "gpt-sovits" });
  const cancelledLoading = waitForVoicePlaybackCompletion(
    loadingAdapter,
    () => loadingAdapter.speak("合成中停止。"),
  );
  await flush();
  assert.equal(loadingAdapter.status, "loading");
  loadingAdapter.stop();
  await cancelledLoading;
  assert.equal(loadingAdapter.status, "idle", "cancelling synthesis must resolve playback waiting");

  globalThis.window.speechSynthesis.speak = () => { throw new Error("schedule failed"); };
  await assert.rejects(
    waitForVoicePlaybackCompletion(adapter, () => adapter.speak("调度失败。")),
    /schedule failed/,
    "browser scheduling failure must reject playback waiting",
  );

  console.log(JSON.stringify({ subscription: true, onendCompletion: true, stopCompletion: true, loadingCancelCompletion: true, fallbackIdleGuard: true, schedulingFailure: true }, null, 2));
} finally {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
