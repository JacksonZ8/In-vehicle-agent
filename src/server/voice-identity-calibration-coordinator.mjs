import { randomBytes } from "node:crypto";
import { VOICE_IDENTITY_CALIBRATION_CONTRACT } from "../voice/voice-identity-calibration-contract.js";
import {
  LOCAL_SPEAKER_IDENTITY_MODEL_PROFILE,
  resolveLocalSpeakerIdentityReadiness,
} from "./local-speaker-identity-profile.mjs";
import { createLocalSpeakerIdentityWorker } from "./local-speaker-identity-worker.mjs";
import { createVoiceIdentityStore } from "./voice-identity-store.mjs";
import {
  cosineSpeakerSimilarity,
  createVoiceIdentityVerificationPolicyStore,
} from "./voice-identity-verification-policy.mjs";

const SESSION_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 1;
const MAX_PCM_BYTES = 16_000 * 2 * 8;

function token(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireOrigin(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new TypeError("origin is required");
  }
  return value.trim();
}

function sameProfile(left, right) {
  return Boolean(left && right)
    && left.profileId === right.profileId
    && left.profileVersion === right.profileVersion
    && left.modelId === right.modelId
    && left.modelDigest === right.modelDigest;
}

function clearScores(session) {
  session.scores.fill(0);
  session.scores.length = 0;
}

function publicSession(session) {
  const next = VOICE_IDENTITY_CALIBRATION_CONTRACT.steps[session.scores.length] ?? null;
  return Object.freeze({
    schemaVersion: VOICE_IDENTITY_CALIBRATION_CONTRACT.schemaVersion,
    sessionId: session.sessionId,
    acceptedCount: session.scores.length,
    sampleCount: VOICE_IDENTITY_CALIBRATION_CONTRACT.sampleCount,
    nextStepId: next?.id ?? null,
    complete: next === null,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
}

export class VoiceIdentityCalibrationCoordinator {
  #now;
  #policyStore;
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
    policyStore = createVoiceIdentityVerificationPolicyStore(),
    worker = createLocalSpeakerIdentityWorker({ profile }),
  } = {}) {
    if (typeof now !== "function" || typeof readinessResolver !== "function") {
      throw new TypeError("now and readinessResolver must be functions");
    }
    if (!store || typeof store.readProfile !== "function") throw new TypeError("store is required");
    if (!policyStore || typeof policyStore.saveCalibration !== "function") {
      throw new TypeError("policyStore is required");
    }
    if (!worker || typeof worker.analyzePcm16 !== "function") throw new TypeError("worker is required");
    this.#now = now;
    this.#profile = profile;
    this.#readinessResolver = readinessResolver;
    this.#store = store;
    this.#policyStore = policyStore;
    this.#worker = worker;
  }

  async start({ origin } = {}) {
    const normalizedOrigin = requireOrigin(origin);
    this.#prune();
    const readiness = this.#readinessResolver(this.#profile);
    if (readiness.status !== "ready") {
      throw codedError(readiness.reasonCode || "local-speaker-model-unavailable");
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      throw codedError("local-speaker-calibration-capacity");
    }
    const enrolledProfile = await this.#store.readProfile();
    if (!enrolledProfile) throw codedError("local-speaker-profile-not-enrolled");
    if (enrolledProfile.modelId !== this.#profile.speakerModelId
      || enrolledProfile.modelDigest !== this.#profile.speakerModelSha256) {
      throw codedError("local-speaker-recalibration-required");
    }
    const now = Number(this.#now());
    if (!Number.isFinite(now)) throw new TypeError("now must return a finite number");
    const session = {
      sessionId: `speaker-calibration-${token()}`,
      origin: normalizedOrigin,
      expiresAt: now + SESSION_TTL_MS,
      profile: enrolledProfile,
      scores: [],
      busy: false,
    };
    this.#sessions.set(session.sessionId, session);
    return publicSession(session);
  }

  async submitSample({ sessionId, origin, stepId, pcm } = {}) {
    const session = this.#requireSession(sessionId, origin);
    if (session.busy) throw codedError("local-speaker-calibration-busy");
    const expectedStep = VOICE_IDENTITY_CALIBRATION_CONTRACT.steps[session.scores.length];
    if (!expectedStep || stepId !== expectedStep.id) {
      throw codedError("local-speaker-calibration-step-order-invalid");
    }
    if (!Buffer.isBuffer(pcm) || pcm.byteLength < 2 || pcm.byteLength > MAX_PCM_BYTES) {
      throw codedError("local-speaker-pcm-size-invalid");
    }
    session.busy = true;
    try {
      const currentProfile = await this.#store.readProfile();
      if (!sameProfile(currentProfile, session.profile)) {
        this.#dropSession(session);
        throw codedError("local-speaker-calibration-profile-changed");
      }
      const result = await this.#worker.analyzePcm16(pcm);
      if (result.outcome !== "accepted") {
        return Object.freeze({
          ...publicSession(session),
          outcome: result.outcome,
          stepId,
        });
      }
      let score;
      try {
        score = cosineSpeakerSimilarity(session.profile.aggregateEmbedding, result.embedding);
      } finally {
        if (Array.isArray(result.embedding) && !Object.isFrozen(result.embedding)) {
          result.embedding.fill(0);
        }
      }
      session.scores.push(score);
      if (session.scores.length < VOICE_IDENTITY_CALIBRATION_CONTRACT.sampleCount) {
        return Object.freeze({
          ...publicSession(session),
          outcome: "accepted",
          stepId,
        });
      }
      try {
        const policy = await this.#policyStore.saveCalibration({
          profile: currentProfile,
          scores: session.scores,
        });
        this.#dropSession(session);
        return Object.freeze({
          schemaVersion: VOICE_IDENTITY_CALIBRATION_CONTRACT.schemaVersion,
          sessionId: null,
          acceptedCount: VOICE_IDENTITY_CALIBRATION_CONTRACT.sampleCount,
          sampleCount: VOICE_IDENTITY_CALIBRATION_CONTRACT.sampleCount,
          nextStepId: null,
          complete: true,
          expiresAt: null,
          outcome: "accepted",
          stepId,
          policyVersion: policy.policyVersion,
        });
      } catch (error) {
        if (error?.code === "local-speaker-calibration-insufficient") {
          session.scores.pop();
          return Object.freeze({
            ...publicSession(session),
            outcome: "calibration-insufficient",
            stepId,
          });
        }
        session.scores.pop();
        throw error;
      }
    } finally {
      session.busy = false;
    }
  }

  cancel({ sessionId, origin } = {}) {
    const session = this.#requireSession(sessionId, origin);
    if (session.busy) throw codedError("local-speaker-calibration-busy");
    this.#dropSession(session);
    return true;
  }

  close() {
    for (const session of this.#sessions.values()) clearScores(session);
    this.#sessions.clear();
    this.#worker.stop?.();
  }

  #dropSession(session) {
    this.#sessions.delete(session.sessionId);
    clearScores(session);
    session.profile = null;
  }

  #requireSession(sessionId, origin) {
    this.#prune();
    if (typeof sessionId !== "string"
      || !/^speaker-calibration-[A-Za-z0-9_-]{24,}$/.test(sessionId)) {
      throw new TypeError("invalid calibration session");
    }
    const session = this.#sessions.get(sessionId);
    if (!session || session.origin !== requireOrigin(origin)) {
      throw codedError("local-speaker-calibration-session-unavailable");
    }
    return session;
  }

  #prune() {
    const now = Number(this.#now());
    for (const session of this.#sessions.values()) {
      if (session.expiresAt <= now) this.#dropSession(session);
    }
  }
}

export function createVoiceIdentityCalibrationCoordinator(options) {
  return new VoiceIdentityCalibrationCoordinator(options);
}
