import {
  createLocalVoiceEvent,
  LOCAL_VOICE_PROTOCOL,
  validateLocalVoicePcmFrame,
} from "./local-voice-protocol.js";

export class DeterministicLocalVoiceFakeWorker {
  #active = false;
  #frameCount = 0;
  #mode = "wake";
  #now;
  #sequence = 0;
  #sessionId = null;
  #wakeAfterFrames;

  constructor({ wakeAfterFrames = null, now = Date.now } = {}) {
    if (wakeAfterFrames !== null
      && (!Number.isSafeInteger(wakeAfterFrames) || wakeAfterFrames < 1)) {
      throw new TypeError("wakeAfterFrames must be null or a positive integer");
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.#wakeAfterFrames = wakeAfterFrames;
    this.#now = now;
  }

  start({ sessionId, mode = "wake" } = {}) {
    if (this.#active) throw new Error("local voice fake worker already active");
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new TypeError("sessionId is required");
    }
    if (!LOCAL_VOICE_PROTOCOL.modes.includes(mode)) throw new TypeError("unsupported voice mode");
    this.#active = true;
    this.#frameCount = 0;
    this.#mode = mode;
    this.#sequence = 0;
    this.#sessionId = sessionId.trim();
    return this.getSnapshot();
  }

  setMode(mode) {
    if (!this.#active) throw new Error("local voice fake worker is not active");
    if (!LOCAL_VOICE_PROTOCOL.modes.includes(mode)) throw new TypeError("unsupported voice mode");
    this.#mode = mode;
    this.#frameCount = 0;
    return this.getSnapshot();
  }

  processFrame(frame) {
    if (!this.#active) throw new Error("local voice fake worker is not active");
    const validation = validateLocalVoicePcmFrame(frame);
    if (!validation.ok) {
      const error = new TypeError(validation.reasonCode);
      error.code = validation.reasonCode;
      throw error;
    }
    this.#frameCount += 1;
    if (this.#mode !== "wake"
      || this.#wakeAfterFrames === null
      || this.#frameCount !== this.#wakeAfterFrames) return Object.freeze([]);
    this.#sequence += 1;
    return Object.freeze([createLocalVoiceEvent("wake.detected", {
      sessionId: this.#sessionId,
      sequence: this.#sequence,
      observedAt: this.#now(),
      mode: this.#mode,
      provider: "fake-local-kws",
      simulated: true,
      phrase: "NOMI",
    })]);
  }

  stop() {
    this.#active = false;
    this.#frameCount = 0;
    this.#sessionId = null;
    return this.getSnapshot();
  }

  getSnapshot() {
    return Object.freeze({
      active: this.#active,
      frameCount: this.#frameCount,
      mode: this.#mode,
      provider: "fake-local-kws",
      simulated: true,
      sessionId: this.#sessionId,
    });
  }
}
