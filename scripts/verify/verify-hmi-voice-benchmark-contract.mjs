import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  installVoicePlaybackProbe,
  isVoicePlaybackProviderObservation,
  observeVoicePlayback,
  recordVoiceSubmission,
} from "../lib/hmi-voice-benchmark-probe.mjs";

const source = await readFile(new URL("../benchmarks/benchmark-hmi-voice-feedback.mjs", import.meta.url), "utf8");
const b4Source = await readFile(new URL("../benchmarks/run-b4-baseline.mjs", import.meta.url), "utf8");

function createExecutableVoicePage({
  httpOnly = false,
  playbackOnTimer = false,
  sequentialWebAudioOnTimer = false,
  sequentialWebAudioSecondAt = 380,
} = {}) {
  let now = 240;
  let timerPlaybackEmitted = false;
  let sequentialWebAudioEmitted = false;
  let deferredAudioAttempt = null;
  let deferredAudioPlayback = null;
  const scheduledTasks = [];
  const advanceTo = (value) => {
    if (!Number.isFinite(value) || value < now) {
      throw new Error(`fixture performance.now must be monotonic: ${value} < ${now}`);
    }
    now = value;
  };
  const scheduleAt = (at, callback) => {
    if (!Number.isFinite(at) || at < now) throw new Error(`fixture task must not travel backwards: ${at} < ${now}`);
    scheduledTasks.push({ at, callback });
    scheduledTasks.sort((left, right) => left.at - right.at);
  };
  const runScheduledThrough = (target) => {
    while (scheduledTasks.length && scheduledTasks[0].at <= target) {
      const task = scheduledTasks.shift();
      advanceTo(task.at);
      task.callback();
    }
    advanceTo(target);
  };
  const latestRun = {
    requestId: "run:voice",
    ttsTelemetry: {
      provider: "gpt-sovits",
      status: "completed",
      startedAtMs: 200,
      completedMs: 800,
      chunkGapsMs: [12, 18],
      bridge: { browserFallbackUsed: false },
    },
  };
  class FixtureEventTarget {
    constructor() {
      this.listeners = new Map();
    }
    addEventListener(type, listener, options = {}) {
      const entries = this.listeners.get(type) || [];
      entries.push({ listener, once: options?.once === true });
      this.listeners.set(type, entries);
    }
    dispatch(type) {
      const entries = [...(this.listeners.get(type) || [])];
      this.listeners.set(type, entries.filter((entry) => !entry.once));
      this[`on${type}`]?.({ type, target: this });
      for (const entry of entries) entry.listener.call(this, { type, target: this });
    }
  }
  const browserWindow = {
    __runtimeDebug: () => ({ currentRun: null, latestRun }),
    __voiceFeedbackBaseline: { requests: [{ startedAt: 180, completedAt: 220 }] },
    Audio: class extends FixtureEventTarget {
      constructor(src) {
        super();
        this.src = src;
        this.fixture = {};
      }
      play() {
        if (this.fixture.mode === "throw") throw new Error("fixture Audio.play synchronous failure");
        if (this.fixture.mode === "reject") return Promise.reject(new Error("fixture Audio.play rejection"));
        if (this.fixture.mode === "deferred") {
          return new Promise((resolve) => {
            deferredAudioAttempt = { audio: this, resolve };
          });
        }
        if (Number.isFinite(this.fixture.startedAt)) advanceTo(this.fixture.startedAt);
        this.dispatch(this.fixture.startEvent || "playing");
        if (Number.isFinite(this.fixture.endedAt)) {
          if (this.fixture.asyncEnded === true) {
            scheduleAt(this.fixture.endedAt, () => this.dispatch("ended"));
          } else {
            advanceTo(this.fixture.endedAt);
            this.dispatch("ended");
          }
        }
        return Promise.resolve();
      }
    },
    AudioContext: class {
      constructor() { this.currentTime = 1; }
      createBufferSource() {
        const source = new FixtureEventTarget();
        source.context = this;
        source.fixture = {};
        source.start = () => {
          if (source.fixture.mode === "throw") throw new Error("fixture source.start failure");
          if (Number.isFinite(source.fixture.endedAt)) {
            scheduleAt(source.fixture.endedAt, () => source.dispatch("ended"));
          }
        };
        return source;
      }
    },
    setTimeout(callback, delayMs) {
      const target = now + delayMs;
      if (playbackOnTimer && !timerPlaybackEmitted) {
        timerPlaybackEmitted = true;
        const audio = new browserWindow.Audio("blob:gpt-sovits-delayed-fixture");
        audio.fixture = { startedAt: target, endedAt: target + 20, asyncEnded: true };
        void audio.play();
      }
      if (sequentialWebAudioOnTimer && !sequentialWebAudioEmitted) {
        sequentialWebAudioEmitted = true;
        latestRun.ttsTelemetry.completedMs = 100;
        advanceTo(target);
        const firstContext = new browserWindow.AudioContext();
        firstContext.currentTime = 1;
        const first = firstContext.createBufferSource();
        first.fixture = { endedAt: 360 };
        first.onended = () => {
          scheduleAt(sequentialWebAudioSecondAt, () => {
            const secondContext = new browserWindow.AudioContext();
            secondContext.currentTime = 1.1;
            const second = secondContext.createBufferSource();
            second.fixture = { endedAt: 500 };
            second.onended = () => { latestRun.ttsTelemetry.completedMs = 400; };
            second.start(1.12);
          });
        };
        first.start(1.02);
      } else {
        runScheduledThrough(target);
      }
      callback();
    },
  };
  const runInBrowser = async (callback, payload) => {
    const previousWindow = globalThis.window;
    const previousPerformance = globalThis.performance;
    globalThis.window = browserWindow;
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { now: () => now },
    });
    try {
      return await callback(payload);
    } finally {
      globalThis.window = previousWindow;
      Object.defineProperty(globalThis, "performance", {
        configurable: true,
        value: previousPerformance,
      });
    }
  };
  return {
    browserWindow,
    setNow(value) { advanceTo(value); },
    async addInitScript(callback, payload) { return runInBrowser(callback, payload); },
    async evaluate(callback, payload) { return runInBrowser(callback, payload); },
    async emitPlayback(fixture = {}) {
      if (httpOnly) return;
      return runInBrowser(async () => {
        const audio = new browserWindow.Audio(fixture.src || "blob:gpt-sovits-fixture");
        audio.fixture = fixture;
        return audio.play();
      });
    },
    async beginDeferredPlayback(fixture = {}) {
      if (httpOnly) return;
      return runInBrowser(() => {
        const audio = new browserWindow.Audio(fixture.src || "blob:gpt-sovits-deferred-fixture");
        audio.fixture = { ...fixture, mode: "deferred" };
        deferredAudioPlayback = audio.play();
      });
    },
    async resolveDeferredPlayback({ startedAt } = {}) {
      return runInBrowser(async () => {
        if (!deferredAudioAttempt || !deferredAudioPlayback) {
          throw new Error("fixture deferred Audio.play attempt is unavailable");
        }
        if (Number.isFinite(startedAt)) advanceTo(startedAt);
        deferredAudioAttempt.audio.dispatch("playing");
        deferredAudioAttempt.resolve();
        await deferredAudioPlayback;
      });
    },
    async emitWebAudioPlayback(fixture = {}) {
      if (httpOnly) return;
      return runInBrowser(() => {
        const context = new browserWindow.AudioContext();
        if (Number.isFinite(fixture.contextTime)) context.currentTime = fixture.contextTime;
        const source = context.createBufferSource();
        source.fixture = fixture;
        return source.start(fixture.scheduledAt);
      });
    },
    async emitPlaybackForFactRequestId(factRequestId) {
      const stableDebug = browserWindow.__runtimeDebug;
      browserWindow.__runtimeDebug = () => factRequestId === null
        ? {}
        : { latestRun: { ...latestRun, requestId: factRequestId } };
      try {
        return await runInBrowser(async () => {
          const audio = new browserWindow.Audio("blob:gpt-sovits-run-fixture");
          audio.fixture = { startedAt: now, endedAt: now + 10 };
          return audio.play();
        });
      } finally {
        browserWindow.__runtimeDebug = stableDebug;
      }
    },
    async probeState() {
      return runInBrowser(() => ({
        facts: window.__hmiVoicePlaybackProbe.facts.map((fact) => ({
          requestId: fact.requestId,
          startedAtPerf: fact.startedAtPerf,
        })),
        provisionalFacts: (window.__hmiVoicePlaybackProbe.provisionalFacts || []).map((fact) => ({
          requestId: fact.requestId,
          boundaryEpoch: fact.boundaryEpoch,
        })),
        submissionIds: Object.keys(window.__hmiVoicePlaybackProbe.submissions),
        retiredRequestIds: [...(window.__hmiVoicePlaybackProbe.retiredRequestIds || [])],
        requestBoundaryIds: Object.keys(window.__hmiVoicePlaybackProbe.requestBoundaries || {}),
        invalidProvisionalRequestIds: [
          ...(window.__hmiVoicePlaybackProbe.invalidProvisionalRequestIds || []),
        ],
      }));
    },
    async currentPerf() { return runInBrowser(() => performance.now()); },
  };
}

function createNavigationVoicePage() {
  let now = 240;
  let browserWindow = null;
  let cachedAudio = null;
  const initScripts = [];
  const latestRun = {
    requestId: "run:voice",
    ttsTelemetry: {
      provider: "gpt-sovits",
      status: "completed",
      startedAtMs: 200,
      completedMs: 100,
      chunkGapsMs: [],
      bridge: { browserFallbackUsed: false },
    },
  };
  const createWindow = () => {
    class AudioFixture {
      constructor(src) { this.src = src; this.listeners = new Map(); }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      async play() {
        this.listeners.get("playing")?.();
        now += 10;
        this.listeners.get("ended")?.();
      }
    }
    return {
      __runtimeDebug: () => ({ latestRun }),
      __initOrder: [],
      Audio: AudioFixture,
      setTimeout(callback, delayMs) { now += delayMs; callback(); },
    };
  };
  browserWindow = createWindow();
  const runInBrowser = async (callback, payload) => {
    const previousWindow = globalThis.window;
    const previousPerformance = globalThis.performance;
    globalThis.window = browserWindow;
    Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
    try {
      return await callback(payload);
    } finally {
      globalThis.window = previousWindow;
      Object.defineProperty(globalThis, "performance", { configurable: true, value: previousPerformance });
    }
  };
  return {
    async addInitScript(callback, payload) { initScripts.push({ callback, payload }); },
    async evaluate(callback, payload) { return runInBrowser(callback, payload); },
    async goto() {
      browserWindow = createWindow();
      for (const script of initScripts) await runInBrowser(script.callback, script.payload);
      cachedAudio = await runInBrowser(() => new window.Audio("blob:gpt-sovits-cached-at-startup"));
    },
    async playCachedAudio() { return runInBrowser(() => cachedAudio.play()); },
    async initOrder() { return runInBrowser(() => [...window.__initOrder]); },
  };
}

async function preparedPage(options = {}) {
  const page = createExecutableVoicePage(options);
  await installVoicePlaybackProbe({ page });
  await recordVoiceSubmission({ page, requestId: "run:voice", submittedAtPerf: 100 });
  return page;
}

const playbackContractFailures = [];
async function verifyPlaybackCase(name, verification) {
  try {
    await verification();
  } catch (error) {
    playbackContractFailures.push(new Error(`${name}: ${error.message}`, { cause: error }));
  }
}

await verifyPlaybackCase("Audio playback before submission registration binds to the measured run", async () => {
  const page = createExecutableVoicePage();
  await installVoicePlaybackProbe({ page });
  await page.emitPlayback({ startedAt: 260, endedAt: 420 });
  await recordVoiceSubmission({ page, requestId: "run:voice", submittedAtPerf: 100 });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 100 });
  assert.equal(observation.firstAudioPlaybackAtPerf, 260);
  assert.equal(observation.audioPlaybackCompletedAtPerf, 420);
  assert.equal(observation.submissionToFirstAudioPlaybackMs, 160);
});

await verifyPlaybackCase("Web Audio playback before submission registration binds to the measured run", async () => {
  const page = createExecutableVoicePage();
  await installVoicePlaybackProbe({ page });
  await page.emitWebAudioPlayback({ contextTime: 1, scheduledAt: 1.04, endedAt: 360 });
  await recordVoiceSubmission({ page, requestId: "run:voice", submittedAtPerf: 100 });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 200 });
  assert.ok(Math.abs(observation.firstAudioPlaybackAtPerf - 280) < 1e-6);
  assert.equal(observation.audioPlaybackCompletedAtPerf, 360);
});

await verifyPlaybackCase("rejected Audio.play leaves no playback fact", async () => {
  const page = await preparedPage();
  await assert.rejects(page.emitPlayback({ mode: "reject" }), /Audio\.play rejection/);
  await assert.rejects(
    observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 }),
    /browser playback fact/i,
  );
});

await verifyPlaybackCase("synchronously thrown Audio.play leaves no playback fact", async () => {
  const page = await preparedPage();
  await assert.rejects(page.emitPlayback({ mode: "throw" }), /synchronous failure/);
  await assert.rejects(
    observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 }),
    /browser playback fact/i,
  );
});

await verifyPlaybackCase("Audio playing and ended events own playback timestamps", async () => {
  const page = await preparedPage();
  await page.emitPlayback({ startedAt: 260, endedAt: 420 });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 100 });
  assert.equal(observation.submittedAtPerf, 100);
  assert.equal(observation.firstAudioPlaybackAtPerf, 260);
  assert.equal(observation.audioPlaybackCompletedAtPerf, 420,
    "TTS collection closure must not replace the media ended timestamp");
  assert.equal(observation.submissionToFirstAudioPlaybackMs, 160);
  assert.deepEqual(observation.chunkGapsMs, [12, 18]);
  assert.equal(observation.provider, "gpt-sovits");
  assert.equal(observation.browserFallbackUsed, false);
  assert.deepEqual(Object.keys(observation).sort(), [
    "audioPlaybackCompletedAtPerf",
    "browserFallbackUsed",
    "chunkGapsMs",
    "firstAudioPlaybackAtPerf",
    "provider",
    "submissionToFirstAudioPlaybackMs",
    "submittedAtPerf",
  ]);
});

await verifyPlaybackCase("compatible Audio play event proves start", async () => {
  const page = await preparedPage();
  await page.emitPlayback({ startEvent: "play", startedAt: 250, endedAt: 410 });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 100 });
  assert.equal(observation.firstAudioPlaybackAtPerf, 250);
  assert.equal(observation.audioPlaybackCompletedAtPerf, 410);
});

await verifyPlaybackCase("successful Audio start without ended preserves null completion", async () => {
  const page = await preparedPage();
  await page.emitPlayback({ startedAt: 260 });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 40 });
  assert.equal(observation.firstAudioPlaybackAtPerf, 260);
  assert.equal(observation.audioPlaybackCompletedAtPerf, null);
  assert.equal(isVoicePlaybackProviderObservation(observation), false,
    "start-only evidence must not qualify as complete GPT-SoVITS playback");
});

await verifyPlaybackCase("Web Audio records scheduled start and final source completion", async () => {
  const page = await preparedPage();
  await page.emitWebAudioPlayback({ contextTime: 1, scheduledAt: 1.04, endedAt: 360 });
  page.setNow(300);
  await page.emitWebAudioPlayback({ contextTime: 1.06, scheduledAt: 1.08, endedAt: 500 });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 300 });
  assert.ok(Math.abs(observation.firstAudioPlaybackAtPerf - 280) < 1e-6,
    "Web Audio evidence is the successful source.start scheduled boundary");
  assert.equal(observation.audioPlaybackCompletedAtPerf, 500,
    "multiple-source playback completes only at the final correlated ended event");
});

await verifyPlaybackCase("observer waits for a sequential source created after the first source ends", async () => {
  const page = await preparedPage({ sequentialWebAudioOnTimer: true });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 400 });
  assert.ok(Math.abs(observation.firstAudioPlaybackAtPerf - 280) < 1e-6);
  assert.equal(observation.audioPlaybackCompletedAtPerf, 500,
    "terminal telemetry at 300 cannot close a source collection whose next source is created asynchronously");
});

await verifyPlaybackCase("unclosed collection never publishes completion at the caller deadline", async () => {
  const page = await preparedPage({
    sequentialWebAudioOnTimer: true,
    sequentialWebAudioSecondAt: 700,
  });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 400 });
  assert.ok(Math.abs(observation.firstAudioPlaybackAtPerf - 280) < 1e-6);
  assert.equal(observation.audioPlaybackCompletedAtPerf, null,
    "ended evidence is not full playback completion until collection closure is proved");
  assert.deepEqual(Object.keys(observation).sort(), [
    "audioPlaybackCompletedAtPerf",
    "browserFallbackUsed",
    "chunkGapsMs",
    "firstAudioPlaybackAtPerf",
    "provider",
    "submissionToFirstAudioPlaybackMs",
    "submittedAtPerf",
  ]);
});

await verifyPlaybackCase("first playback is the earliest scheduled source rather than insertion order", async () => {
  const page = await preparedPage();
  await page.emitWebAudioPlayback({ contextTime: 1, scheduledAt: 1.2, endedAt: 500 });
  page.setNow(300);
  await page.emitWebAudioPlayback({ contextTime: 1.06, scheduledAt: 1.08, endedAt: 450 });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 300 });
  assert.ok(Math.abs(observation.firstAudioPlaybackAtPerf - 320) < 1e-6,
    "a later-created source may have the earlier AudioContext schedule");
  assert.equal(observation.audioPlaybackCompletedAtPerf, 500);
});

await verifyPlaybackCase("thrown Web Audio start leaves no playback fact", async () => {
  const page = await preparedPage();
  await assert.rejects(page.emitWebAudioPlayback({ mode: "throw", scheduledAt: 1.04 }), /source\.start failure/);
  await assert.rejects(
    observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 }),
    /browser playback fact/i,
  );
});

await verifyPlaybackCase("failed provider attempt followed by local playback reports fallback", async () => {
  const page = await preparedPage();
  await assert.rejects(page.emitPlayback({ mode: "reject" }), /Audio\.play rejection/);
  await page.emitPlayback({ src: "/assets/local-fallback.wav", startedAt: 280, endedAt: 430 });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 100 });
  assert.equal(observation.firstAudioPlaybackAtPerf, 280);
  assert.equal(observation.audioPlaybackCompletedAtPerf, 430);
  assert.equal(observation.browserFallbackUsed, true);
  assert.equal(observation.provider, "browser-fallback");
  assert.equal(isVoicePlaybackProviderObservation(observation), false);
});

await verifyPlaybackCase("successful provider playback followed by local playback selects the fallback chain", async () => {
  const page = await preparedPage();
  await page.emitPlayback({ startedAt: 260, endedAt: 330 });
  await page.emitPlayback({ src: "/assets/local-after-provider.wav", startedAt: 350, endedAt: 430 });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 100 });
  assert.equal(observation.firstAudioPlaybackAtPerf, 350);
  assert.equal(observation.audioPlaybackCompletedAtPerf, 430);
  assert.equal(observation.browserFallbackUsed, true);
  assert.equal(observation.provider, "browser-fallback");
});

await verifyPlaybackCase("observation cleanup removes only the selected request state", async () => {
  const page = await preparedPage();
  await page.emitPlayback({ startedAt: 260, endedAt: 330 });
  await recordVoiceSubmission({ page, requestId: "run:other", submittedAtPerf: 100 });
  await page.emitPlaybackForFactRequestId("run:other");
  await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 100 });
  const state = await page.probeState();
  assert.deepEqual(state.submissionIds, ["run:other"]);
  assert.deepEqual(state.facts.map((fact) => fact.requestId), ["run:other"]);
});

await verifyPlaybackCase("late playback cannot recreate a settled request fact", async () => {
  const page = await preparedPage();
  await recordVoiceSubmission({ page, requestId: "run:other", submittedAtPerf: 100 });
  await page.emitPlaybackForFactRequestId("run:other");
  await assert.rejects(
    observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 }),
    /browser playback fact/i,
  );
  await page.emitPlayback({ startedAt: 300, endedAt: 340 });
  const state = await page.probeState();
  assert.deepEqual(state.submissionIds, ["run:other"]);
  assert.deepEqual(state.facts.map((fact) => fact.requestId), ["run:other"],
    "settled run:voice playback must be ignored while other run facts remain intact");
  assert.deepEqual(state.provisionalFacts, [],
    "retired playback must not be hidden in the provisional collection");
  assert.equal(state.requestBoundaryIds.includes("run:voice"), false,
    "retired playback must not recreate its request boundary");
});

await verifyPlaybackCase("repeated playback for a retired request cannot accumulate provisional state", async () => {
  const page = await preparedPage();
  await assert.rejects(
    observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 }),
    /browser playback fact/i,
  );
  for (let index = 0; index < 20; index += 1) {
    await page.emitPlayback({ startedAt: 300 + (index * 20), endedAt: 310 + (index * 20) });
  }
  const state = await page.probeState();
  assert.deepEqual(state.provisionalFacts, []);
  assert.equal(state.requestBoundaryIds.includes("run:voice"), false);
});

await verifyPlaybackCase("a new submission can legally reuse a retired request id", async () => {
  const page = await preparedPage();
  await assert.rejects(
    observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 }),
    /browser playback fact/i,
  );
  const resubmittedAt = await page.currentPerf();
  await recordVoiceSubmission({ page, requestId: "run:voice", submittedAtPerf: resubmittedAt });
  await page.emitPlayback({ startedAt: resubmittedAt + 20, endedAt: resubmittedAt + 40 });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 40 });
  assert.equal(observation.firstAudioPlaybackAtPerf, resubmittedAt + 20);
});

await verifyPlaybackCase("an old pending Audio attempt cannot cross a reused request generation", async () => {
  const page = await preparedPage();
  await page.beginDeferredPlayback();
  await assert.rejects(
    observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 }),
    /browser playback fact/i,
  );
  const resubmittedAt = await page.currentPerf();
  await recordVoiceSubmission({ page, requestId: "run:voice", submittedAtPerf: resubmittedAt });
  await page.resolveDeferredPlayback({ startedAt: resubmittedAt + 20 });
  const stateAfterLateAttempt = await page.probeState();
  let newObservationPassed = false;
  try {
    await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 });
    newObservationPassed = true;
  } catch (error) {
    assert.match(error.message, /browser playback fact/i);
  }
  assert.deepEqual({
    lateFactRequestIds: stateAfterLateAttempt.facts.map((fact) => fact.requestId),
    newObservationPassed,
  }, {
    lateFactRequestIds: [],
    newObservationPassed: false,
  }, "a fresh submission must not reactivate an in-flight attempt from the retired generation");
});

await verifyPlaybackCase("retirement FIFO eviction never recycles a submission generation", async () => {
  const page = await preparedPage();
  await page.beginDeferredPlayback();
  await assert.rejects(
    observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 }),
    /browser playback fact/i,
  );
  for (let index = 0; index < 129; index += 1) {
    const requestId = `run:epoch-advance:${index}`;
    await recordVoiceSubmission({ page, requestId, submittedAtPerf: await page.currentPerf() });
    await assert.rejects(
      observeVoicePlayback({ page, requestId, timeoutMs: 1 }),
      /browser playback fact/i,
    );
  }
  const resubmittedAt = await page.currentPerf();
  await recordVoiceSubmission({ page, requestId: "run:voice", submittedAtPerf: resubmittedAt });
  await page.resolveDeferredPlayback({ startedAt: resubmittedAt + 20 });
  const stateAfterLateAttempt = await page.probeState();
  let newObservationPassed = false;
  try {
    await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 });
    newObservationPassed = true;
  } catch (error) {
    assert.match(error.message, /browser playback fact/i);
  }
  assert.deepEqual({
    lateFactRequestIds: stateAfterLateAttempt.facts.map((fact) => fact.requestId),
    newObservationPassed,
  }, {
    lateFactRequestIds: [],
    newObservationPassed: false,
  }, "bounded retirement must not cause an old submission generation to be reused");
});

await verifyPlaybackCase("retired request tracking remains bounded", async () => {
  const page = createExecutableVoicePage();
  await installVoicePlaybackProbe({ page });
  for (let index = 0; index < 140; index += 1) {
    const requestId = `run:retired:${index}`;
    await recordVoiceSubmission({ page, requestId, submittedAtPerf: await page.currentPerf() });
    await assert.rejects(
      observeVoicePlayback({ page, requestId, timeoutMs: 1 }),
      /browser playback fact/i,
    );
  }
  const state = await page.probeState();
  assert.ok(state.retiredRequestIds.length > 0 && state.retiredRequestIds.length <= 128,
    "retired request tracking must reject late facts without unbounded growth");
});

await verifyPlaybackCase("unbound provisional request boundaries remain bounded", async () => {
  const page = createExecutableVoicePage();
  await installVoicePlaybackProbe({ page });
  for (let index = 0; index < 160; index += 1) {
    await page.emitPlaybackForFactRequestId(`run:provisional-boundary:${index}`);
  }
  const state = await page.probeState();
  assert.ok(state.requestBoundaryIds.length <= 128,
    "unbound provisional request boundaries must be capped at 128");
  assert.ok(state.provisionalFacts.length <= 512,
    "the global provisional fact collection must remain bounded");
  assert.ok(state.invalidProvisionalRequestIds.length <= 128,
    "the invalid provisional marker must remain bounded");
});

await verifyPlaybackCase("per-boundary overflow clears every fragment before submission binding", async () => {
  const page = createExecutableVoicePage();
  await installVoicePlaybackProbe({ page });
  for (let index = 0; index < 129; index += 1) {
    await page.emitPlaybackForFactRequestId("run:voice");
  }
  const overflowState = await page.probeState();
  assert.deepEqual(
    overflowState.provisionalFacts.filter((fact) => fact.requestId === "run:voice"),
    [],
  );
  assert.equal(overflowState.requestBoundaryIds.includes("run:voice"), false);
  assert.equal(overflowState.invalidProvisionalRequestIds.includes("run:voice"), true);
  await recordVoiceSubmission({ page, requestId: "run:voice", submittedAtPerf: 100 });
  await assert.rejects(
    observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 20 }),
    /browser playback fact/i,
    "a new submission must not bind a surviving overflow fragment",
  );
});

await verifyPlaybackCase("global provisional fact overflow invalidates whole boundaries and stays bounded", async () => {
  const page = createExecutableVoicePage();
  await installVoicePlaybackProbe({ page });
  for (let requestIndex = 0; requestIndex < 5; requestIndex += 1) {
    for (let factIndex = 0; factIndex < 110; factIndex += 1) {
      await page.emitPlaybackForFactRequestId(`run:provisional-global:${requestIndex}`);
    }
  }
  const state = await page.probeState();
  const counts = new Map();
  for (const fact of state.provisionalFacts) {
    counts.set(fact.boundaryEpoch, (counts.get(fact.boundaryEpoch) || 0) + 1);
  }
  assert.ok(state.provisionalFacts.length <= 512);
  assert.ok([...counts.values()].every((count) => count <= 128));
  assert.ok(state.requestBoundaryIds.length <= 128);
  assert.ok(state.invalidProvisionalRequestIds.length <= 128);
});

await verifyPlaybackCase("invalid provisional request markers remain bounded", async () => {
  const page = createExecutableVoicePage();
  await installVoicePlaybackProbe({ page });
  for (let requestIndex = 0; requestIndex < 140; requestIndex += 1) {
    const requestId = `run:provisional-invalid:${requestIndex}`;
    for (let factIndex = 0; factIndex < 129; factIndex += 1) {
      await page.emitPlaybackForFactRequestId(requestId);
    }
  }
  const state = await page.probeState();
  assert.ok(state.invalidProvisionalRequestIds.length > 0
    && state.invalidProvisionalRequestIds.length <= 128,
  "invalid provisional request tracking must remain bounded");
  assert.ok(state.provisionalFacts.length <= 512);
  assert.ok(state.requestBoundaryIds.length <= 128);
});

await verifyPlaybackCase("terminal telemetry still waits for delayed playback fact", async () => {
  const page = await preparedPage({ playbackOnTimer: true });
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 100 });
  assert.equal(observation.firstAudioPlaybackAtPerf, 260);
});

await verifyPlaybackCase("navigation init wraps cached Audio before playback", async () => {
  const page = createNavigationVoicePage();
  await page.addInitScript(() => {
    window.__initOrder.push("audio-mock");
  });
  await installVoicePlaybackProbe({ page });
  await page.goto();
  await recordVoiceSubmission({ page, requestId: "run:voice", submittedAtPerf: 100 });
  await page.playCachedAudio();
  const observation = await observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 100 });
  assert.deepEqual(await page.initOrder(), ["audio-mock"]);
  assert.equal(observation.firstAudioPlaybackAtPerf, 240);
  assert.equal(observation.audioPlaybackCompletedAtPerf, 250);
});

for (const factRequestId of [null, "run:wrong"]) {
  await verifyPlaybackCase(`playback for ${factRequestId ?? "null run"} is not misattributed`, async () => {
    const page = await preparedPage();
    await page.emitPlaybackForFactRequestId(factRequestId);
    await assert.rejects(
      observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 10 }),
      /browser playback fact/i,
    );
  });
}

await verifyPlaybackCase("TTS HTTP timing alone is not playback", async () => {
  const page = await preparedPage({ httpOnly: true });
  await assert.rejects(
    observeVoicePlayback({ page, requestId: "run:voice", timeoutMs: 10 }),
    /browser playback fact/i,
  );
  const state = await page.probeState();
  assert.deepEqual(state.facts, []);
  assert.deepEqual(state.submissionIds, [],
    "timed-out observation must clean its selected request submission");
});

if (playbackContractFailures.length) {
  throw new AggregateError(playbackContractFailures, "voice playback evidence contract failed");
}

assert.match(source, /hmi-voice-benchmark-probe\.mjs/);
assert.match(b4Source, /hmi-voice-benchmark-probe\.mjs/);
assert.ok(source.indexOf("await installVoicePlaybackProbe({ page })") < source.indexOf("await page.goto("),
  "dedicated voice benchmark must register its Audio mock, then the shared probe, before navigation");
const b4MeasuredSampleSource = b4Source.slice(b4Source.indexOf("runSample: async"));
assert.ok(b4MeasuredSampleSource.indexOf("await installVoicePlaybackProbe({ page })")
  < b4MeasuredSampleSource.indexOf("await page.goto("),
"B4 voice samples must register the shared probe before navigation");

assert.match(source, /nio-hmi-voice-feedback-benchmark-contract@1\.0\.0/);
assert.match(source, /NIO_HMI_VOICE_BENCHMARK_STREAMING_POC/);
assert.match(source, /window\.NIO_TTS_STREAMING_POC = enabled/);
assert.match(source, /streamingPocEnabled/);
assert.match(source, /function percentile\(values, percentileValue\)/);
assert.match(source, /Math\.ceil\(\(Math\.max\(0, Math\.min\(100, percentileValue\)\) \/ 100\) \* numeric\.length\)/);
assert.match(source, /function evaluateCaseExpectation\(row\)/);
assert.match(source, /caseExpectationFailures/);
assert.match(source, /case_expectation_failures/);
assert.match(source, /formalBaselineReady:\s*repeats >= 3 && matrixComplete && results\.length === expectedRuns && successfulRuns === expectedRuns && expectationFailures\.length === 0/);
assert.match(source, /expected:\s*\{\s*intent:\s*"body\.tailgate\.open", safetyAction:\s*"require_confirmation"\s*\}/);
assert.match(source, /safetyAction:\s*latestResult\.safetyDecision\?\.action \|\| "unavailable"/);
assert.match(source, /ok:\s*isVoicePlaybackProviderObservation\(voiceObservation\) && caseExpectation\.ok/);
assert.doesNotMatch(source, /audioPlays/,
  "entrypoint must consume the shared playback observer instead of retaining a second Audio.play ledger");
assert.match(source, /minFormalRepeats:\s*3/);
assert.match(source, /formalBaselineReady:\s*repeats >= 3/);
assert.match(source, /evidenceLevel:\s*repeats >= 3 && matrixComplete \? "formal-candidate" : "exploratory"/);
assert.match(source, /speechTextPolicy:\s*countAvailable/);
assert.match(source, /speechTextProvenance:\s*countAvailable/);
assert.match(source, /profileHeaderCoverage/);
assert.match(source, /const latestResult = run\.result \|\| debug\?\.lastRuntimeResult \|\| runResult \|\| \{\}/);
assert.match(source, /resultMode:\s*latestResult\.mode \|\| "unavailable"/);
assert.match(source, /Number\.isFinite\(start\?\.observedMs\)/);
assert.match(source, /x-nio-tts-profile-id/);
assert.match(source, /x-nio-tts-synthesis-profile-id/);
assert.match(source, /x-nio-tts-license-boundary/);
assert.match(source, /submitToFirstAudibleMs/);
assert.match(source, /firstAudibleMs/);
assert.match(source, /repeats_below_formal_baseline_minimum/);
assert.match(source, /selected_cases_do_not_cover_full_family_length_matrix/);
assert.ok((source.match(/benchmarkContract:\s*summarizeBenchmarkContract\(results\)/g) || []).length >= 2, "partial and final output must both include benchmarkContract");

console.log(JSON.stringify({
  benchmarkContract: true,
  formalBaselineGate: true,
  policyCoverage: true,
  profileHeaderCoverage: true,
}, null, 2));
