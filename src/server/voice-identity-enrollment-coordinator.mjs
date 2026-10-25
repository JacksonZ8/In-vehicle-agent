import { randomBytes } from "node:crypto";
import { VOICE_IDENTITY_ENROLLMENT_CONTRACT } from "../voice/voice-identity-enrollment-contract.js";
import {
  LOCAL_SPEAKER_IDENTITY_MODEL_PROFILE,
  resolveLocalSpeakerIdentityReadiness,
} from "./local-speaker-identity-profile.mjs";
import { createLocalSpeakerIdentityWorker } from "./local-speaker-identity-worker.mjs";
import { createVoiceIdentityStore } from "./voice-identity-store.mjs";

const SESSION_TTL_MS = 5 * 60_000;
const MAX_SESSIONS = 2;
const MAX_PCM_BYTES = 16_000 * 2 * 8;

function token(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function requireOrigin(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new TypeError("origin is required");
  }
  return value.trim();
}

function publicSession(session) {
  const next = VOICE_IDENTITY_ENROLLMENT_CONTRACT.phrases[session.embeddings.length] ?? null;
  return Object.freeze({
    schemaVersion: VOICE_IDENTITY_ENROLLMENT_CONTRACT.schemaVersion,
    sessionId: session.sessionId,
    acceptedCount: session.embeddings.length,
    sampleCount: VOICE_IDENTITY_ENROLLMENT_CONTRACT.sampleCount,
    nextPhraseId: next?.id ?? null,
    complete: next === null,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
}

export class VoiceIdentityEnrollmentCoordinator {
  #now;
  #profile;
  #readinessResolver;
  #sessions = new Map();
  #store;
  #worker;

  constructor({
    now = Date.now,
    profile = LOCAL_SPEAKER_IDENTITY_MODEL_PROFILE,
    readinessResolver = resolveLocalSpeakerIdentityReadiness,
    store = createVoiceIdentityStore(),
    worker = createLocalSpeakerIdentityWorker({ profile }),
  } = {}) {
    if (typeof now !== "function" || typeof readinessResolver !== "function") {
      throw new TypeError("now and readinessResolver must be functions");
    }
    if (!store || typeof store.saveEnrollment !== "function") throw new TypeError("store is required");
    if (!worker || typeof worker.analyzePcm16 !== "function") throw new TypeError("worker is required");
    this.#now = now;
    this.#profile = profile;
    this.#readinessResolver = readinessResolver;
    this.#store = store;
    this.#worker = worker;
  }

  start({ origin } = {}) {
    const normalizedOrigin = requireOrigin(origin);
    this.#prune();
    const readiness = this.#readinessResolver(this.#profile);
    if (readiness.status !== "ready") {
      const error = new Error(readiness.reasonCode || "local-speaker-model-unavailable");
      error.code = readiness.reasonCode || "local-speaker-model-unavailable";
      throw error;
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      const error = new Error("local-speaker-enrollment-capacity");
      error.code = "local-speaker-enrollment-capacity";
      throw error;
    }
    const now = Number(this.#now());
    if (!Number.isFinite(now)) throw new TypeError("now must return a finite number");
    const session = {
      sessionId: `speaker-${token()}`,
      origin: normalizedOrigin,
      expiresAt: now + SESSION_TTL_MS,
      embeddings: [],
      busy: false,
    };
    this.#sessions.set(session.sessionId, session);
    return publicSession(session);
  }

  async submitSample({ sessionId, origin, phraseId, pcm } = {}) {
    const session = this.#requireSession(sessionId, origin);
    if (session.busy) {
      const error = new Error("local-speaker-enrollment-busy");
      error.code = "local-speaker-enrollment-busy";
      throw error;
    }
    const expectedPhrase = VOICE_IDENTITY_ENROLLMENT_CONTRACT.phrases[session.embeddings.length];
    if (!expectedPhrase || phraseId !== expectedPhrase.id) {
      const error = new Error("local-speaker-phrase-order-invalid");
      error.code = "local-speaker-phrase-order-invalid";
      throw error;
    }
    if (!Buffer.isBuffer(pcm) || pcm.byteLength < 2 || pcm.byteLength > MAX_PCM_BYTES) {
      const error = new Error("local-speaker-pcm-size-invalid");
      error.code = "local-speaker-pcm-size-invalid";
      throw error;
    }
    session.busy = true;
    try {
      const result = await this.#worker.analyzePcm16(pcm);
      if (result.outcome !== "accepted") {
        return Object.freeze({
          ...publicSession(session),
          outcome: result.outcome,
          phraseId,
        });
      }
      session.embeddings.push(result.embedding);
      if (session.embeddings.length < VOICE_IDENTITY_ENROLLMENT_CONTRACT.sampleCount) {
        return Object.freeze({
          ...publicSession(session),
          outcome: "accepted",
          phraseId,
        });
      }
      let profile;
      try {
        profile = await this.#store.saveEnrollment({
          samples: session.embeddings,
          modelId: this.#profile.speakerModelId,
          modelDigest: this.#profile.speakerModelSha256,
        });
      } catch (error) {
        session.embeddings.pop();
        throw error;
      }
      this.#sessions.delete(session.sessionId);
      session.embeddings.length = 0;
      return Object.freeze({
        schemaVersion: VOICE_IDENTITY_ENROLLMENT_CONTRACT.schemaVersion,
        sessionId: null,
        acceptedCount: VOICE_IDENTITY_ENROLLMENT_CONTRACT.sampleCount,
        sampleCount: VOICE_IDENTITY_ENROLLMENT_CONTRACT.sampleCount,
        nextPhraseId: null,
        complete: true,
        expiresAt: null,
        outcome: "accepted",
        phraseId,
        profileVersion: profile.profileVersion,
      });
    } finally {
      session.busy = false;
    }
  }

  cancel({ sessionId, origin } = {}) {
    const session = this.#requireSession(sessionId, origin);
    if (session.busy) {
      const error = new Error("local-speaker-enrollment-busy");
      error.code = "local-speaker-enrollment-busy";
      throw error;
    }
    this.#sessions.delete(session.sessionId);
    session.embeddings.length = 0;
    return true;
  }

  close() {
    for (const session of this.#sessions.values()) session.embeddings.length = 0;
    this.#sessions.clear();
    this.#worker.stop?.();
  }

  #requireSession(sessionId, origin) {
    this.#prune();
    if (typeof sessionId !== "string" || !/^speaker-[A-Za-z0-9_-]{24,}$/.test(sessionId)) {
      throw new TypeError("invalid enrollment session");
    }
    const session = this.#sessions.get(sessionId);
    if (!session || session.origin !== requireOrigin(origin)) {
      const error = new Error("local-speaker-enrollment-session-unavailable");
      error.code = "local-speaker-enrollment-session-unavailable";
      throw error;
    }
    return session;
  }

  #prune() {
    const now = Number(this.#now());
    for (const [sessionId, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        session.embeddings.length = 0;
        this.#sessions.delete(sessionId);
      }
    }
  }
}

export function createVoiceIdentityEnrollmentCoordinator(options) {
  return new VoiceIdentityEnrollmentCoordinator(options);
}
