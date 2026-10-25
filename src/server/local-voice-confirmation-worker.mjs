import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { LOCAL_VOICE_MODEL_PROFILE, createSherpaKeywordSpotterConfig } from "./local-voice-model-profile.mjs";

const CHILD_PATH = fileURLToPath(new URL("../voice/local-voice-confirmation-child.cjs", import.meta.url));
const INITIALIZE_TIMEOUT_MS = 5_000;
const ANALYSIS_TIMEOUT_MS = 8_000;
const MAX_PCM_BYTES = 256_000;

export class LocalVoiceConfirmationWorker {
  #child = null;
  #initializePromise = null;
  #pending = new Map();
  #profile;

  constructor({ profile = LOCAL_VOICE_MODEL_PROFILE } = {}) {
    this.#profile = profile;
  }

  async analyzePcm16(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.byteLength < 2 || pcm.byteLength > MAX_PCM_BYTES
      || pcm.byteLength % 2 !== 0) {
      throw new TypeError("pcm must be an even-length bounded Buffer");
    }
    await this.#ensureReady();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("local-voice-confirmation-timeout"));
      }, ANALYSIS_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#child.send({ type: "analyze", requestId, pcm: new Uint8Array(pcm) }, (error) => {
        if (error) this.#rejectPending(requestId, new Error("local-voice-confirmation-unavailable"));
      });
    });
  }

  stop() {
    const child = this.#child;
    this.#child = null;
    this.#initializePromise = null;
    this.#rejectAll(new Error("local-voice-confirmation-stopped"));
    if (child?.connected) child.send({ type: "stop" });
    child?.disconnect?.();
  }

  async #ensureReady() {
    if (this.#child?.connected && !this.#initializePromise) return;
    if (this.#initializePromise) return this.#initializePromise;
    this.#initializePromise = new Promise((resolve, reject) => {
      const child = fork(CHILD_PATH, [], {
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      this.#child = child;
      const timer = setTimeout(() => {
        reject(new Error("local-voice-confirmation-timeout"));
        this.stop();
      }, INITIALIZE_TIMEOUT_MS);
      child.on("message", (message) => {
        if (message?.type === "ready") {
          clearTimeout(timer);
          this.#initializePromise = null;
          resolve();
          return;
        }
        this.#handleMessage(message);
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("local-voice-confirmation-unavailable"));
        this.stop();
      });
      child.once("exit", () => {
        clearTimeout(timer);
        if (this.#child === child) {
          this.#child = null;
          this.#initializePromise = null;
          this.#rejectAll(new Error("local-voice-confirmation-stopped"));
        }
      });
      child.send({
        type: "initialize",
        config: createSherpaKeywordSpotterConfig(this.#profile, {
          keywordsFile: this.#profile.confirmationKeywordsFile,
        }),
      });
    });
    return this.#initializePromise;
  }

  #handleMessage(message) {
    if (!message || typeof message !== "object" || message.type !== "analysis.result") return;
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.requestId);
    pending.resolve(Object.freeze({
      intent: ["confirm", "cancel", "ambiguous", "unknown"].includes(message.intent)
        ? message.intent
        : "unknown",
    }));
  }

  #rejectPending(requestId, error) {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);
    pending.reject(error);
  }

  #rejectAll(error) {
    for (const requestId of [...this.#pending.keys()]) this.#rejectPending(requestId, error);
  }
}

export function createLocalVoiceConfirmationWorker(options) {
  return new LocalVoiceConfirmationWorker(options);
}
