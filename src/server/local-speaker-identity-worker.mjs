import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { VOICE_IDENTITY_ENROLLMENT_CONTRACT } from "../voice/voice-identity-enrollment-contract.js";
import { LOCAL_SPEAKER_IDENTITY_MODEL_PROFILE } from "./local-speaker-identity-profile.mjs";

const CHILD_PATH = fileURLToPath(new URL("../voice/local-speaker-identity-child.cjs", import.meta.url));
const INITIALIZE_TIMEOUT_MS = 5_000;
const ANALYSIS_TIMEOUT_MS = 12_000;

export class LocalSpeakerIdentityWorker {
  #child = null;
  #initializePromise = null;
  #pending = new Map();
  #profile;

  constructor({ profile = LOCAL_SPEAKER_IDENTITY_MODEL_PROFILE } = {}) {
    this.#profile = profile;
  }

  async analyzePcm16(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.byteLength < 2 || pcm.byteLength % 2 !== 0) {
      throw new TypeError("pcm must be an even-length Buffer");
    }
    await this.#ensureReady();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("local-speaker-analysis-timeout"));
      }, ANALYSIS_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#child.send({
        type: "analyze",
        requestId,
        pcm: new Uint8Array(pcm),
      }, (error) => {
        if (error) this.#rejectPending(requestId, new Error("local-speaker-worker-unavailable"));
      });
    });
  }

  stop() {
    const child = this.#child;
    this.#child = null;
    this.#initializePromise = null;
    this.#rejectAll(new Error("local-speaker-worker-stopped"));
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
        reject(new Error("local-speaker-worker-timeout"));
        this.stop();
      }, INITIALIZE_TIMEOUT_MS);
      const onMessage = (message) => {
        if (message?.type === "ready") {
          clearTimeout(timer);
          this.#initializePromise = null;
          resolve();
          return;
        }
        this.#handleMessage(message);
      };
      child.on("message", onMessage);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("local-speaker-worker-unavailable"));
        this.stop();
      });
      child.once("exit", () => {
        clearTimeout(timer);
        if (this.#child === child) {
          this.#child = null;
          this.#initializePromise = null;
          this.#rejectAll(new Error("local-speaker-worker-stopped"));
        }
      });
      child.send({
        type: "initialize",
        config: {
          speakerModelPath: this.#profile.speakerModelPath,
          vadModelPath: this.#profile.vadModelPath,
          sampleRate: 16_000,
          quality: VOICE_IDENTITY_ENROLLMENT_CONTRACT.quality,
        },
      });
    });
    return this.#initializePromise;
  }

  #handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "analysis.result") {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.requestId);
      pending.resolve(Object.freeze({
        outcome: message.outcome,
        embedding: message.embedding instanceof Float32Array
          ? Object.freeze(Array.from(message.embedding))
          : null,
      }));
      return;
    }
    if (message.type === "analysis.error") {
      this.#rejectPending(
        message.requestId,
        new Error(message.reasonCode || "local-speaker-inference-failed"),
      );
    }
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

export function createLocalSpeakerIdentityWorker(options) {
  return new LocalSpeakerIdentityWorker(options);
}
