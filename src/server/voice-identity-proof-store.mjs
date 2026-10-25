import { randomUUID } from "node:crypto";

const PROOF_TTL_MS = 8_000;
const MAX_TOKEN_LENGTH = 180;

function token(value, name, { min = 1, max = MAX_TOKEN_LENGTH } = {}) {
  if (typeof value !== "string"
    || value.length < min
    || value.length > max
    || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new TypeError(`${name} must be a bounded token`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a SHA-256 action digest`);
  }
  return value;
}

function isoTime(value, name) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} must be a valid time`);
  return date.toISOString();
}

export const VOICE_IDENTITY_PROOF_TTL_MS = PROOF_TTL_MS;

export class VoiceIdentityProofStore {
  #createId;
  #now;
  #proofs = new Map();

  constructor({
    createId = () => `voice-proof-${randomUUID()}`,
    now = Date.now,
  } = {}) {
    if (typeof createId !== "function" || typeof now !== "function") {
      throw new TypeError("createId and now are required");
    }
    this.#createId = createId;
    this.#now = now;
  }

  issue({
    profileId,
    profileVersion,
    sessionId,
    challengeId,
    requestId,
    actionDigest,
    policyId,
    detectedIntent = "confirm",
  } = {}) {
    const issuedAtMs = Number(this.#now());
    if (!Number.isFinite(issuedAtMs)) throw new TypeError("now must return a finite number");
    const proofId = token(this.#createId(), "proofId", { min: 12, max: 220 });
    if (this.#proofs.has(proofId)) throw new Error("duplicate voice proof id");
    if (!Number.isSafeInteger(profileVersion) || profileVersion < 1) {
      throw new TypeError("profileVersion must be a positive integer");
    }
    if (detectedIntent !== "confirm") throw new TypeError("voice proof intent must be confirm");
    const proof = Object.freeze({
      proofId,
      profileId: token(profileId, "profileId"),
      profileVersion,
      sessionId: token(sessionId, "sessionId", { min: 8, max: 128 }),
      challengeId: token(challengeId, "challengeId"),
      requestId: token(requestId, "requestId"),
      actionDigest: digest(actionDigest, "actionDigest"),
      policyId: token(policyId, "policyId"),
      detectedIntent,
      issuedAt: isoTime(issuedAtMs, "issuedAt"),
      expiresAt: isoTime(issuedAtMs + PROOF_TTL_MS, "expiresAt"),
    });
    this.#proofs.set(proofId, { proof, consumed: false, consuming: false });
    this.#prune(issuedAtMs);
    return Object.freeze({ proofId });
  }

  consume({
    proofId,
    profileId,
    profileVersion,
    sessionId,
    challengeId,
    requestId,
    actionDigest,
    policyId,
    now = this.#now(),
  } = {}) {
    const record = this.#proofs.get(proofId);
    if (!record) return failure("voice-proof-unavailable");
    const nowMs = Number(now);
    this.#prune(nowMs);
    if (!this.#proofs.has(proofId)) return failure("voice-proof-expired");
    if (record.consumed) return failure("voice-proof-consumed");
    if (record.consuming) return failure("voice-proof-busy");
    const proof = record.proof;
    if (proof.profileId !== profileId || proof.profileVersion !== profileVersion) {
      return failure("voice-proof-profile-mismatch");
    }
    if (proof.sessionId !== sessionId
      || proof.challengeId !== challengeId
      || proof.requestId !== requestId
      || proof.actionDigest !== actionDigest
      || proof.policyId !== policyId) {
      return failure("voice-proof-binding-mismatch");
    }
    record.consuming = true;
    record.consumed = true;
    record.consuming = false;
    this.#proofs.delete(proofId);
    return Object.freeze({ ok: true, detectedIntent: proof.detectedIntent });
  }

  invalidateProfile({ profileId, profileVersion } = {}) {
    for (const [proofId, record] of this.#proofs) {
      if (record.proof.profileId === profileId && record.proof.profileVersion !== profileVersion) {
        this.#proofs.delete(proofId);
      }
    }
  }

  clear() {
    this.#proofs.clear();
  }

  #prune(nowMs) {
    if (!Number.isFinite(nowMs)) return;
    for (const [proofId, record] of this.#proofs) {
      if (nowMs >= Date.parse(record.proof.expiresAt)) this.#proofs.delete(proofId);
    }
  }
}

function failure(reasonCode) {
  return Object.freeze({ ok: false, reasonCode });
}

export function createVoiceIdentityProofStore(options) {
  return new VoiceIdentityProofStore(options);
}
