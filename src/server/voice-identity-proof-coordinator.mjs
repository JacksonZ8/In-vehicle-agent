import {
  LOCAL_SPEAKER_IDENTITY_MODEL_PROFILE,
  resolveLocalSpeakerIdentityReadiness,
} from "./local-speaker-identity-profile.mjs";
import {
  LOCAL_VOICE_MODEL_PROFILE,
  resolveLocalVoiceModelReadiness,
} from "./local-voice-model-profile.mjs";
import { createLocalSpeakerIdentityWorker } from "./local-speaker-identity-worker.mjs";
import { createLocalVoiceConfirmationWorker } from "./local-voice-confirmation-worker.mjs";
import { classifyVoiceIdentityEmbedding } from "./voice-identity-verification-policy.mjs";
import { createVoiceIdentityProofStore } from "./voice-identity-proof-store.mjs";

const MAX_PCM_BYTES = 256_000;

function bounded(value, name, { min = 1, max = 180 } = {}) {
  if (typeof value !== "string"
    || value.length < min
    || value.length > max
    || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new TypeError(`${name} must be a bounded token`);
  }
  return value;
}

function actionDigest(value) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("actionDigest must be a SHA-256 digest");
  }
  return value;
}

function result(status, reasonCode = null) {
  return Object.freeze({ status, ...(reasonCode ? { reasonCode } : {}) });
}

export class VoiceIdentityProofCoordinator {
  #confirmationWorker;
  #now;
  #policyStore;
  #profile;
  #profileReadiness;
  #proofStore;
  #speakerWorker;
  #store;
  #voiceProfile;
  #voiceReadiness;

  constructor({
    now = Date.now,
    profile = LOCAL_SPEAKER_IDENTITY_MODEL_PROFILE,
    voiceProfile = LOCAL_VOICE_MODEL_PROFILE,
    readinessResolver = resolveLocalSpeakerIdentityReadiness,
    voiceReadinessResolver = resolveLocalVoiceModelReadiness,
    store,
    policyStore,
    proofStore = createVoiceIdentityProofStore({ now }),
    speakerWorker = createLocalSpeakerIdentityWorker({ profile }),
    confirmationWorker = createLocalVoiceConfirmationWorker({ profile: voiceProfile }),
  } = {}) {
    if (typeof now !== "function"
      || typeof readinessResolver !== "function"
      || typeof voiceReadinessResolver !== "function") {
      throw new TypeError("proof coordinator functions are required");
    }
    if (!store || typeof store.readProfile !== "function") throw new TypeError("voice identity store is required");
    if (!policyStore || typeof policyStore.readPolicy !== "function") {
      throw new TypeError("voice identity policy store is required");
    }
    if (!proofStore || typeof proofStore.issue !== "function" || typeof proofStore.consume !== "function") {
      throw new TypeError("voice identity proof store is required");
    }
    if (!speakerWorker || typeof speakerWorker.analyzePcm16 !== "function") {
      throw new TypeError("speaker worker is required");
    }
    if (!confirmationWorker || typeof confirmationWorker.analyzePcm16 !== "function") {
      throw new TypeError("confirmation worker is required");
    }
    this.#now = now;
    this.#profile = profile;
    this.#voiceProfile = voiceProfile;
    this.#profileReadiness = readinessResolver;
    this.#voiceReadiness = voiceReadinessResolver;
    this.#store = store;
    this.#policyStore = policyStore;
    this.#proofStore = proofStore;
    this.#speakerWorker = speakerWorker;
    this.#confirmationWorker = confirmationWorker;
  }

  async issue({
    sessionId,
    challengeId,
    requestId,
    actionDigest: digest,
    policyId,
    pcm,
  } = {}) {
    bounded(sessionId, "sessionId", { min: 8, max: 128 });
    bounded(challengeId, "challengeId");
    bounded(requestId, "requestId");
    actionDigest(digest);
    bounded(policyId, "policyId");
    if (!Buffer.isBuffer(pcm) || pcm.byteLength < 2 || pcm.byteLength > MAX_PCM_BYTES
      || pcm.byteLength % 2 !== 0) {
      throw codedError("local-speaker-pcm-size-invalid");
    }
    const speakerReadiness = this.#profileReadiness(this.#profile);
    const voiceReadiness = this.#voiceReadiness({
      ...this.#voiceProfile,
      keywordsFile: this.#voiceProfile.confirmationKeywordsFile,
    });
    if (speakerReadiness.status !== "ready") {
      return result("unavailable", speakerReadiness.reasonCode || "local-speaker-model-unavailable");
    }
    if (voiceReadiness.status !== "ready") {
      return result("unavailable", voiceReadiness.reasonCode || "local-voice-model-unavailable");
    }
    const profile = await this.#store.readProfile().catch(() => null);
    if (!profile) return result("unavailable", "local-speaker-profile-not-enrolled");
    let policy;
    try {
      policy = await this.#policyStore.readPolicy({ profile });
    } catch (error) {
      return result("unavailable", error?.code || "local-speaker-recalibration-required");
    }
    if (!policy || policy.policyId !== policyId) {
      return result("rejected", "voice-proof-policy-mismatch");
    }
    const intent = await this.#confirmationWorker.analyzePcm16(pcm);
    if (intent.intent === "cancel") return result("cancelled");
    if (intent.intent === "ambiguous" || intent.intent === "unknown") {
      return result("rejected", "local-voice-confirmation-ambiguous");
    }
    const speaker = await this.#speakerWorker.analyzePcm16(pcm);
    if (speaker.outcome !== "accepted") {
      return result("rejected", "local-speaker-confirmation-quality");
    }
    const identity = classifyVoiceIdentityEmbedding({
      profile,
      policy,
      embedding: speaker.embedding,
    });
    if (identity === "ambiguous") return result("ambiguous", "local-speaker-confirmation-review");
    if (identity !== "matched") return result("rejected", "local-speaker-confirmation-mismatch");
    return Object.freeze({
      status: "matched",
      ...this.#proofStore.issue({
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
        sessionId,
        challengeId,
        requestId,
        actionDigest: digest,
        policyId,
      }),
    });
  }

  async consume({
    proofId,
    sessionId,
    challengeId,
    requestId,
    actionDigest: digest,
    policyId,
  } = {}) {
    bounded(proofId, "proofId", { min: 12, max: 220 });
    bounded(sessionId, "sessionId", { min: 8, max: 128 });
    bounded(challengeId, "challengeId");
    bounded(requestId, "requestId");
    actionDigest(digest);
    bounded(policyId, "policyId");
    const profile = await this.#store.readProfile().catch(() => null);
    if (!profile) return Object.freeze({ ok: false, reasonCode: "local-speaker-profile-not-enrolled" });
    return this.#proofStore.consume({
      proofId,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      sessionId,
      challengeId,
      requestId,
      actionDigest: digest,
      policyId,
      now: this.#now(),
    });
  }

  close() {
    this.#speakerWorker.stop?.();
    this.#confirmationWorker.stop?.();
    this.#proofStore.clear?.();
  }
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function createVoiceIdentityProofCoordinator(options) {
  return new VoiceIdentityProofCoordinator(options);
}
