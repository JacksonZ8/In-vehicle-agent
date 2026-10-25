import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VOICE_IDENTITY_CALIBRATION_CONTRACT } from "../voice/voice-identity-calibration-contract.js";
import { normalizeSpeakerEmbedding } from "./voice-identity-store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY_SCHEMA_VERSION = "nio-voice-identity-verification-policy@1.1.0";
const DEFAULT_POLICY_PATH = path.join(
  root,
  ".local-services/voice-identity/verification-policy.json",
);
const PASS_FLOOR = 0.65;
const PASS_CEILING = 0.80;
const REVIEW_FLOOR = 0.55;
const REVIEW_MARGIN = 0.08;
const CALIBRATION_MARGIN = 0.02;
const CALIBRATION_SAMPLE_COUNT = VOICE_IDENTITY_CALIBRATION_CONTRACT.sampleCount;
const MINIMUM_PASS_COUNT = CALIBRATION_SAMPLE_COUNT - 1;
const POLICY_FIELDS = Object.freeze([
  "schemaVersion",
  "policyId",
  "policyVersion",
  "profileId",
  "profileVersion",
  "modelId",
  "modelDigest",
  "passThreshold",
  "reviewThreshold",
  "sampleCount",
  "calibratedAt",
]);

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedToken(value, name) {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > 180
    || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new TypeError(`${name} must be a bounded token`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function finiteThreshold(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < -1 || number > 1) {
    throw new TypeError(`${name} must be between -1 and 1`);
  }
  return number;
}

function roundThreshold(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function cosineSpeakerSimilarity(reference, sample) {
  const left = normalizeSpeakerEmbedding(reference, "reference embedding");
  const right = normalizeSpeakerEmbedding(sample, "sample embedding");
  if (left.length !== right.length) throw new TypeError("speaker embedding dimensions must match");
  return roundThreshold(left.reduce((sum, value, index) => sum + value * right[index], 0));
}

export function classifyVoiceIdentityEmbedding({ profile, policy, embedding } = {}) {
  if (!profile || !policy) return "unavailable";
  if (!policyMatchesProfile(policy, profile)) return "recalibration-required";
  const score = cosineSpeakerSimilarity(profile.aggregateEmbedding, embedding);
  if (score >= policy.passThreshold) return "matched";
  if (score >= policy.reviewThreshold) return "ambiguous";
  return "mismatch";
}

export function deriveVoiceIdentityThresholds(scores) {
  if (!Array.isArray(scores)
    || scores.length !== CALIBRATION_SAMPLE_COUNT) {
    throw new TypeError(`exactly ${CALIBRATION_SAMPLE_COUNT} calibration scores are required`);
  }
  const sorted = scores.map((score, index) => finiteThreshold(score, `scores[${index}]`))
    .sort((left, right) => left - right);
  const acceptedAtFloor = sorted.filter((score) => score >= PASS_FLOOR).length;
  if (acceptedAtFloor < MINIMUM_PASS_COUNT) {
    throw codedError("local-speaker-calibration-insufficient");
  }
  const lowerQuintile = 0.2 * sorted[0] + 0.8 * sorted[1];
  const passThreshold = roundThreshold(Math.min(
    PASS_CEILING,
    Math.max(PASS_FLOOR, lowerQuintile - CALIBRATION_MARGIN),
  ));
  const reviewThreshold = roundThreshold(Math.max(REVIEW_FLOOR, passThreshold - REVIEW_MARGIN));
  return Object.freeze({
    passThreshold,
    reviewThreshold,
    sampleCount: sorted.length,
  });
}

function validateProfileBinding(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)
    || !Number.isSafeInteger(profile.profileVersion)
    || profile.profileVersion < 1) {
    throw new TypeError("valid voice identity profile is required");
  }
  return Object.freeze({
    profileId: boundedToken(profile.profileId, "profileId"),
    profileVersion: profile.profileVersion,
    modelId: boundedToken(profile.modelId, "modelId"),
    modelDigest: digest(profile.modelDigest, "modelDigest"),
  });
}

function validateStoredPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== POLICY_FIELDS.length
    || !POLICY_FIELDS.every((field) => Object.hasOwn(value, field))
    || value.schemaVersion !== POLICY_SCHEMA_VERSION
    || value.policyVersion !== 1
    || value.sampleCount !== VOICE_IDENTITY_CALIBRATION_CONTRACT.sampleCount) {
    throw new TypeError("invalid voice identity verification policy");
  }
  const calibratedAt = new Date(value.calibratedAt);
  if (!Number.isFinite(calibratedAt.getTime())) throw new TypeError("invalid calibration time");
  const passThreshold = finiteThreshold(value.passThreshold, "passThreshold");
  const reviewThreshold = finiteThreshold(value.reviewThreshold, "reviewThreshold");
  if (passThreshold < PASS_FLOOR
    || passThreshold > PASS_CEILING
    || reviewThreshold < REVIEW_FLOOR
    || reviewThreshold >= passThreshold) {
    throw new TypeError("verification policy thresholds are invalid");
  }
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    policyId: boundedToken(value.policyId, "policyId"),
    policyVersion: 1,
    ...validateProfileBinding(value),
    passThreshold,
    reviewThreshold,
    sampleCount: VOICE_IDENTITY_CALIBRATION_CONTRACT.sampleCount,
    calibratedAt: calibratedAt.toISOString(),
  });
}

function policyMatchesProfile(policy, profile) {
  const binding = validateProfileBinding(profile);
  return policy.profileId === binding.profileId
    && policy.profileVersion === binding.profileVersion
    && policy.modelId === binding.modelId
    && policy.modelDigest === binding.modelDigest;
}

export class VoiceIdentityVerificationPolicyStore {
  #createId;
  #now;
  #policyPath;

  constructor({
    policyPath = DEFAULT_POLICY_PATH,
    createId = () => `voice-policy-${randomUUID()}`,
    now = Date.now,
  } = {}) {
    if (typeof policyPath !== "string" || !path.isAbsolute(policyPath)) {
      throw new TypeError("policyPath must be absolute");
    }
    if (typeof createId !== "function" || typeof now !== "function") {
      throw new TypeError("createId and now must be functions");
    }
    this.#policyPath = policyPath;
    this.#createId = createId;
    this.#now = now;
  }

  async readPolicy({ profile } = {}) {
    try {
      const stat = await fs.lstat(this.#policyPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error("voice identity verification policy permissions are invalid");
      }
      const policy = validateStoredPolicy(JSON.parse(await fs.readFile(this.#policyPath, "utf8")));
      if (!policyMatchesProfile(policy, profile)) {
        throw codedError("local-speaker-recalibration-required");
      }
      return policy;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async saveCalibration({ profile, scores } = {}) {
    const binding = validateProfileBinding(profile);
    const thresholds = deriveVoiceIdentityThresholds(scores);
    const calibratedAt = new Date(Number(this.#now()));
    if (!Number.isFinite(calibratedAt.getTime())) throw new TypeError("now must return a finite time");
    const policy = validateStoredPolicy({
      schemaVersion: POLICY_SCHEMA_VERSION,
      policyId: this.#createId(),
      policyVersion: 1,
      ...binding,
      ...thresholds,
      calibratedAt: calibratedAt.toISOString(),
    });
    await this.#assertReplaceable();
    await this.#writeAtomically(policy);
    return policy;
  }

  async deletePolicy() {
    try {
      await fs.unlink(this.#policyPath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async getPublicStatus({ profile } = {}) {
    if (!profile) return Object.freeze({ status: "not-calibrated", calibratedAt: null });
    try {
      const policy = await this.readPolicy({ profile });
      return Object.freeze({
        status: policy ? "calibrated" : "not-calibrated",
        calibratedAt: policy?.calibratedAt || null,
      });
    } catch {
      return Object.freeze({ status: "recalibration-required", calibratedAt: null });
    }
  }

  async #assertReplaceable() {
    try {
      const stat = await fs.lstat(this.#policyPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error("voice identity verification policy permissions are invalid");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async #writeAtomically(policy) {
    const directory = path.dirname(this.#policyPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("voice identity directory is invalid");
    }
    await fs.chmod(directory, 0o700);
    const temporaryPath = `${this.#policyPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(policy)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.#policyPath);
      await fs.chmod(this.#policyPath, 0o600);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}

export function createVoiceIdentityVerificationPolicyStore(options) {
  return new VoiceIdentityVerificationPolicyStore(options);
}
