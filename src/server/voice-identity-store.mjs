import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROFILE_SCHEMA_VERSION = "nio-voice-identity-profile@1.0.0";
const PUBLIC_SCHEMA_VERSION = "nio-voice-identity-public@1.0.0";
const DEFAULT_PROFILE_PATH = path.join(
  root,
  ".local-services/voice-identity/primary-driver.json",
);

function requireDigest(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireToken(value, name) {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > 160
    || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new TypeError(`${name} must be a bounded token`);
  }
  return value;
}

export function normalizeSpeakerEmbedding(value, name = "embedding") {
  if (!Array.isArray(value) || value.length < 16 || value.length > 4_096) {
    throw new TypeError(`${name} dimension is invalid`);
  }
  const values = value.map((item) => Number(item));
  if (!values.every(Number.isFinite)) throw new TypeError(`${name} must contain finite numbers`);
  const norm = Math.sqrt(values.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || norm <= 1e-9) throw new TypeError(`${name} norm is invalid`);
  return values.map((item) => item / norm);
}

export function aggregateSpeakerEmbeddings(samples) {
  if (!Array.isArray(samples) || samples.length !== 3) {
    throw new TypeError("exactly three speaker samples are required");
  }
  const normalized = samples.map((sample, index) => normalizeSpeakerEmbedding(sample, `samples[${index}]`));
  const dimension = normalized[0].length;
  if (!normalized.every((sample) => sample.length === dimension)) {
    throw new TypeError("speaker sample dimensions must match");
  }
  const aggregate = Array.from({ length: dimension }, (_, index) => (
    normalized.reduce((sum, sample) => sum + sample[index], 0) / normalized.length
  ));
  return Object.freeze(normalizeSpeakerEmbedding(aggregate, "aggregate embedding"));
}

function validateStoredProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== PROFILE_SCHEMA_VERSION
    || !Number.isSafeInteger(value.profileVersion)
    || value.profileVersion < 1
    || value.sampleCount !== 3) {
    throw new TypeError("invalid voice identity profile");
  }
  const enrolledAt = new Date(value.enrolledAt);
  if (!Number.isFinite(enrolledAt.getTime())) throw new TypeError("invalid enrollment time");
  const embedding = normalizeSpeakerEmbedding(value.aggregateEmbedding, "aggregateEmbedding");
  return Object.freeze({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId: requireToken(value.profileId, "profileId"),
    profileVersion: value.profileVersion,
    modelId: requireToken(value.modelId, "modelId"),
    modelDigest: requireDigest(value.modelDigest, "modelDigest"),
    aggregateEmbedding: Object.freeze(embedding),
    enrolledAt: enrolledAt.toISOString(),
    sampleCount: 3,
  });
}

export function projectPublicVoiceIdentityStatus(profile, {
  modelReadiness = {},
  registrationAvailable = false,
  reasonCode = null,
  verification = {},
} = {}) {
  const enrolled = Boolean(profile);
  const capabilityStatus = modelReadiness.status === "ready" ? "ready" : "degraded";
  return Object.freeze({
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    profileStatus: enrolled ? "enrolled" : "not-enrolled",
    capabilityStatus,
    registrationAvailable: registrationAvailable === true && capabilityStatus === "ready",
    reasonCode: reasonCode || modelReadiness.reasonCode || null,
    model: Object.freeze({
      provider: modelReadiness.provider || null,
      id: modelReadiness.model || profile?.modelId || null,
    }),
    enrolledAt: profile?.enrolledAt || null,
    sampleCount: profile?.sampleCount || 0,
    profileVersion: profile?.profileVersion || null,
    verification: Object.freeze({
      status: ["not-calibrated", "calibrated", "recalibration-required"]
        .includes(verification.status)
        ? verification.status
        : "not-calibrated",
      calibrationAvailable: verification.calibrationAvailable === true
        && enrolled
        && capabilityStatus === "ready",
      calibratedAt: typeof verification.calibratedAt === "string"
        ? verification.calibratedAt
        : null,
    }),
  });
}

export class VoiceIdentityStore {
  #createId;
  #now;
  #profilePath;

  constructor({
    profilePath = DEFAULT_PROFILE_PATH,
    createId = () => `primary-driver-${randomUUID()}`,
    now = Date.now,
  } = {}) {
    if (typeof profilePath !== "string" || !path.isAbsolute(profilePath)) {
      throw new TypeError("profilePath must be absolute");
    }
    if (typeof createId !== "function" || typeof now !== "function") {
      throw new TypeError("createId and now must be functions");
    }
    this.#profilePath = profilePath;
    this.#createId = createId;
    this.#now = now;
  }

  async readProfile() {
    try {
      const stat = await fs.lstat(this.#profilePath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error("voice identity profile permissions are invalid");
      }
      return validateStoredProfile(JSON.parse(await fs.readFile(this.#profilePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async saveEnrollment({ samples, modelId, modelDigest } = {}) {
    let previous = null;
    try {
      previous = await this.readProfile();
    } catch {
      const stat = await fs.lstat(this.#profilePath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error("voice identity profile permissions are invalid");
      }
    }
    const aggregateEmbedding = aggregateSpeakerEmbeddings(samples);
    const enrolledAt = new Date(Number(this.#now()));
    if (!Number.isFinite(enrolledAt.getTime())) throw new TypeError("now must return a finite time");
    const profile = validateStoredProfile({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profileId: this.#createId(),
      profileVersion: (previous?.profileVersion || 0) + 1,
      modelId,
      modelDigest,
      aggregateEmbedding,
      enrolledAt: enrolledAt.toISOString(),
      sampleCount: 3,
    });
    await this.#writeAtomically(profile);
    return profile;
  }

  async deleteProfile() {
    try {
      await fs.unlink(this.#profilePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async getPublicStatus(options = {}) {
    try {
      return projectPublicVoiceIdentityStatus(await this.readProfile(), options);
    } catch {
      return projectPublicVoiceIdentityStatus(null, {
        ...options,
        registrationAvailable: false,
        reasonCode: "local-speaker-profile-invalid",
      });
    }
  }

  async #writeAtomically(profile) {
    const directory = path.dirname(this.#profilePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("voice identity directory is invalid");
    }
    await fs.chmod(directory, 0o700);
    const temporaryPath = `${this.#profilePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(profile)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporaryPath, this.#profilePath);
      await fs.chmod(this.#profilePath, 0o600);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}

export function createVoiceIdentityStore(options) {
  return new VoiceIdentityStore(options);
}
