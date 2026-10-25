import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LOCAL_VOICE_PROTOCOL, validateLocalVoicePcmFrame } from "../voice/local-voice-protocol.js";
import {
  createSherpaKeywordSpotterConfig,
  LOCAL_VOICE_MODEL_PROFILE,
} from "./local-voice-model-profile.mjs";

const CHILD_PATH = fileURLToPath(new URL("../voice/local-voice-sherpa-child.cjs", import.meta.url));
const MAX_IN_FLIGHT_FRAMES = 8;

export class LocalVoiceSherpaWorker {
  #active = false;
  #child = null;
  #emit = null;
  #inFlightFrames = 0;
  #mode = "wake";
  #onError = null;
  #onReady = null;
  #profile;
  #sessionId = null;

  constructor({ profile = LOCAL_VOICE_MODEL_PROFILE } = {}) {
    this.#profile = profile;
  }

  start({ sessionId, mode = "wake", emit, onReady, onError } = {}) {
    if (this.#child) throw new Error("local voice sherpa worker already started");
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new TypeError("sessionId is required");
    if (!LOCAL_VOICE_PROTOCOL.modes.includes(mode)) throw new TypeError("unsupported voice mode");
    if (typeof emit !== "function" || typeof onReady !== "function" || typeof onError !== "function") {
      throw new TypeError("worker callbacks are required");
    }
    this.#sessionId = sessionId.trim();
    this.#mode = mode;
    this.#emit = emit;
    this.#onReady = onReady;
    this.#onError = onError;
    const child = fork(CHILD_PATH, [], {
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.#child = child;
    child.on("message", (message) => this.#handleMessage(message));
    child.once("error", () => this.#fail("local-voice-worker-unavailable"));
    child.once("exit", (code) => {
      const wasActive = this.#active;
      this.#active = false;
      this.#child = null;
      this.#inFlightFrames = 0;
      if (code !== 0 || wasActive) this.#fail("local-voice-worker-stopped");
    });
    child.send({
      type: "initialize",
      mode,
      config: createSherpaKeywordSpotterConfig(this.#profile),
    });
    return this.getSnapshot();
  }

  setMode(mode) {
    if (!this.#child) throw new Error("local voice sherpa worker is not active");
    if (!LOCAL_VOICE_PROTOCOL.modes.includes(mode)) throw new TypeError("unsupported voice mode");
    this.#mode = mode;
    this.#child.send({ type: "mode.set", mode });
    return this.getSnapshot();
  }

  processFrame(frame) {
    if (!this.#active || !this.#child) throw new Error("local voice sherpa worker is not active");
    const validation = validateLocalVoicePcmFrame(frame);
    if (!validation.ok) throw new TypeError(validation.reasonCode);
    if (this.#inFlightFrames >= MAX_IN_FLIGHT_FRAMES) return Object.freeze([]);
    const bytes = frame instanceof ArrayBuffer
      ? Buffer.from(frame)
      : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    this.#inFlightFrames += 1;
    this.#child.send({ type: "frame", frame: new Uint8Array(bytes) }, (error) => {
      if (error) this.#fail("local-voice-worker-unavailable");
    });
    return Object.freeze([]);
  }

  stop() {
    const child = this.#child;
    this.#active = false;
    this.#child = null;
    this.#inFlightFrames = 0;
    this.#emit = null;
    this.#onReady = null;
    this.#onError = null;
    if (child?.connected) child.send({ type: "stop" });
    child?.disconnect?.();
    return this.getSnapshot();
  }

  getSnapshot() {
    return Object.freeze({
      active: this.#active,
      mode: this.#mode,
      provider: this.#profile.provider,
      model: this.#profile.modelId,
      simulated: false,
      sessionId: this.#sessionId,
      inFlightFrames: this.#inFlightFrames,
    });
  }

  #handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      this.#active = true;
      this.#onReady?.();
      return;
    }
    if (message.type === "frame.processed") {
      this.#inFlightFrames = Math.max(0, this.#inFlightFrames - 1);
      return;
    }
    if (message.type === "wake.detected"
      && ["NOMI", "嗨，NOMI"].includes(message.phrase)) {
      this.#emit?.(Object.freeze({ type: message.type, phrase: message.phrase }));
      return;
    }
    if (message.type === "error" && typeof message.reasonCode === "string") {
      this.#fail(message.reasonCode);
    }
  }

  #fail(reasonCode) {
    this.#onError?.(reasonCode);
  }
}
