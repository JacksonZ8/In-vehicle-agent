import { VOICE_IDENTITY_ENROLLMENT_CONTRACT } from "../voice/voice-identity-enrollment-contract.js";
import { VOICE_IDENTITY_CALIBRATION_CONTRACT } from "../voice/voice-identity-calibration-contract.js";

export const PRIMARY_DRIVER_ENROLLMENT_PHRASES = VOICE_IDENTITY_ENROLLMENT_CONTRACT.phrases;
export const PRIMARY_DRIVER_CALIBRATION_STEPS = VOICE_IDENTITY_CALIBRATION_CONTRACT.steps;
export const PRIMARY_DRIVER_CALIBRATION_SAMPLE_COUNT = VOICE_IDENTITY_CALIBRATION_CONTRACT.sampleCount;

const REASON_LABELS = Object.freeze({
  "local-speaker-model-unavailable": "本地声纹或 VAD 模型尚未安装",
  "local-speaker-model-unverified": "本地声纹模型尚未完成校验",
  "local-speaker-model-digest-mismatch": "本地声纹模型校验失败",
  "local-speaker-enrollment-not-connected": "声纹注册推理链路尚未接入",
  "local-speaker-profile-invalid": "本地主驾声纹档案无效，需要重新注册",
  "voice-identity-status-unavailable": "暂时无法读取本地主驾声纹状态",
});

export const VOICE_IDENTITY_OUTCOME_LABELS = Object.freeze({
  accepted: "录制通过",
  "too-short": "录音不足 2.5 秒，请重新朗读",
  "too-long": "录音超过 8 秒，请重新朗读",
  "insufficient-speech": "有效语音不足，请靠近麦克风重新朗读",
  clipped: "录音音量过大，请稍微离远后重试",
  unavailable: "本地声纹服务暂时不可用",
  "calibration-insufficient": "当前段样本一致性不足，请重新录制",
});

const VERIFICATION_STATUS_LABELS = Object.freeze({
  "not-calibrated": "安全确认尚未标定",
  calibrated: "安全确认已标定",
  "recalibration-required": "档案已变化，需要重新标定",
});

function normalizeEnrollmentSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== VOICE_IDENTITY_ENROLLMENT_CONTRACT.schemaVersion
    || !Number.isSafeInteger(value.acceptedCount)
    || value.acceptedCount < 0
    || value.acceptedCount > VOICE_IDENTITY_ENROLLMENT_CONTRACT.sampleCount
    || value.sampleCount !== VOICE_IDENTITY_ENROLLMENT_CONTRACT.sampleCount
    || typeof value.complete !== "boolean") {
    throw new TypeError("invalid voice identity enrollment response");
  }
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : null;
  const nextPhraseId = typeof value.nextPhraseId === "string" ? value.nextPhraseId : null;
  if (!value.complete && (!sessionId || !nextPhraseId)) {
    throw new TypeError("incomplete enrollment response is missing session state");
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    sessionId,
    acceptedCount: value.acceptedCount,
    sampleCount: value.sampleCount,
    nextPhraseId,
    complete: value.complete,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
    outcome: VOICE_IDENTITY_ENROLLMENT_CONTRACT.publicOutcomes.includes(value.outcome)
      ? value.outcome
      : null,
    phraseId: typeof value.phraseId === "string" ? value.phraseId : null,
    profileVersion: Number.isSafeInteger(value.profileVersion) ? value.profileVersion : null,
  });
}

function normalizeCalibrationSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== VOICE_IDENTITY_CALIBRATION_CONTRACT.schemaVersion
    || !Number.isSafeInteger(value.acceptedCount)
    || value.acceptedCount < 0
    || value.acceptedCount > VOICE_IDENTITY_CALIBRATION_CONTRACT.sampleCount
    || value.sampleCount !== VOICE_IDENTITY_CALIBRATION_CONTRACT.sampleCount
    || typeof value.complete !== "boolean") {
    throw new TypeError("invalid voice identity calibration response");
  }
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : null;
  const nextStepId = typeof value.nextStepId === "string" ? value.nextStepId : null;
  if (!value.complete && (!sessionId || !nextStepId)) {
    throw new TypeError("incomplete calibration response is missing session state");
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    sessionId,
    acceptedCount: value.acceptedCount,
    sampleCount: value.sampleCount,
    nextStepId,
    complete: value.complete,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
    outcome: VOICE_IDENTITY_CALIBRATION_CONTRACT.publicOutcomes.includes(value.outcome)
      ? value.outcome
      : null,
    stepId: typeof value.stepId === "string" ? value.stepId : null,
  });
}

function normalizePublicVoiceIdentityStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== "nio-voice-identity-public@1.0.0"
    || !["enrolled", "not-enrolled"].includes(value.profileStatus)
    || !["ready", "degraded"].includes(value.capabilityStatus)
    || typeof value.registrationAvailable !== "boolean"
    || !["not-calibrated", "calibrated", "recalibration-required"].includes(
      value.verification?.status,
    )
    || typeof value.verification?.calibrationAvailable !== "boolean") {
    throw new TypeError("invalid public voice identity status");
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    profileStatus: value.profileStatus,
    capabilityStatus: value.capabilityStatus,
    registrationAvailable: value.registrationAvailable,
    reasonCode: typeof value.reasonCode === "string" ? value.reasonCode : null,
    model: Object.freeze({
      provider: typeof value.model?.provider === "string" ? value.model.provider : null,
      id: typeof value.model?.id === "string" ? value.model.id : null,
    }),
    enrolledAt: typeof value.enrolledAt === "string" ? value.enrolledAt : null,
    sampleCount: Number.isSafeInteger(value.sampleCount) ? value.sampleCount : 0,
    profileVersion: Number.isSafeInteger(value.profileVersion) ? value.profileVersion : null,
    verification: Object.freeze({
      status: value.verification.status,
      calibrationAvailable: value.verification.calibrationAvailable,
      calibratedAt: typeof value.verification.calibratedAt === "string"
        ? value.verification.calibratedAt
        : null,
    }),
  });
}

export function createUnavailableVoiceIdentityStatus(
  reasonCode = "voice-identity-status-unavailable",
) {
  return Object.freeze({
    schemaVersion: "nio-voice-identity-public@1.0.0",
    profileStatus: "not-enrolled",
    capabilityStatus: "degraded",
    registrationAvailable: false,
    reasonCode,
    model: Object.freeze({ provider: null, id: null }),
    enrolledAt: null,
    sampleCount: 0,
    profileVersion: null,
    verification: Object.freeze({
      status: "not-calibrated",
      calibrationAvailable: false,
      calibratedAt: null,
    }),
  });
}

export async function loadVoiceIdentityStatus(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const response = await fetchImpl("/api/local-voice/identity", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`voice identity status HTTP ${response.status}`);
  return normalizePublicVoiceIdentityStatus(await response.json());
}

export async function deleteVoiceIdentityProfile(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const response = await fetchImpl("/api/local-voice/identity/delete", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`voice identity deletion HTTP ${response.status}`);
  return normalizePublicVoiceIdentityStatus(await response.json());
}

export async function startVoiceIdentityEnrollment(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const response = await fetchImpl("/api/local-voice/identity/enrollment/session", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`voice identity enrollment HTTP ${response.status}`);
  return normalizeEnrollmentSession(await response.json());
}

export async function submitVoiceIdentitySample({ sessionId, phraseId, pcm },
  fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  if (!(pcm instanceof ArrayBuffer)) throw new TypeError("pcm must be an ArrayBuffer");
  const query = new URLSearchParams({ sessionId, phraseId });
  const response = await fetchImpl(`/api/local-voice/identity/enrollment/sample?${query}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/octet-stream" },
    body: pcm,
  });
  if (!response.ok) throw new Error(`voice identity sample HTTP ${response.status}`);
  return normalizeEnrollmentSession(await response.json());
}

export async function cancelVoiceIdentityEnrollment(sessionId,
  fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const query = new URLSearchParams({ sessionId });
  const response = await fetchImpl(`/api/local-voice/identity/enrollment/cancel?${query}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`voice identity enrollment cancel HTTP ${response.status}`);
  return true;
}

export async function startVoiceIdentityCalibration(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const response = await fetchImpl("/api/local-voice/identity/calibration/session", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`voice identity calibration HTTP ${response.status}`);
  return normalizeCalibrationSession(await response.json());
}

export async function submitVoiceIdentityCalibrationSample({ sessionId, stepId, pcm },
  fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  if (!(pcm instanceof ArrayBuffer)) throw new TypeError("pcm must be an ArrayBuffer");
  const query = new URLSearchParams({ sessionId, stepId });
  const response = await fetchImpl(`/api/local-voice/identity/calibration/sample?${query}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/octet-stream" },
    body: pcm,
  });
  if (!response.ok) throw new Error(`voice identity calibration sample HTTP ${response.status}`);
  return normalizeCalibrationSession(await response.json());
}

export async function cancelVoiceIdentityCalibration(sessionId,
  fetchImpl = globalThis.fetch?.bind(globalThis)) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
  const query = new URLSearchParams({ sessionId });
  const response = await fetchImpl(`/api/local-voice/identity/calibration/cancel?${query}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`voice identity calibration cancel HTTP ${response.status}`);
  return true;
}

export function projectVoiceIdentityView(status) {
  const enrolled = status?.profileStatus === "enrolled";
  const available = status?.registrationAvailable === true;
  const reasonLabel = REASON_LABELS[status?.reasonCode] || "";
  const statusLabel = enrolled
    ? status.capabilityStatus === "ready" ? "主驾已注册" : "主驾已注册 · 当前不可用"
    : available ? "可以注册主驾声纹" : "主驾声纹未就绪";
  return Object.freeze({
    enrolled,
    available,
    statusLabel,
    reasonLabel,
    actionLabel: enrolled ? "重新注册主驾声纹" : "开始三段声纹注册",
    actionDisabled: !available,
    deleteVisible: enrolled,
    modelLabel: [status?.model?.provider, status?.model?.id].filter(Boolean).join(" · "),
    calibrationStatus: status?.verification?.status || "not-calibrated",
    calibrationStatusLabel: VERIFICATION_STATUS_LABELS[status?.verification?.status]
      || VERIFICATION_STATUS_LABELS["not-calibrated"],
    calibrationAvailable: status?.verification?.calibrationAvailable === true,
    calibrationActionLabel: status?.verification?.status === "calibrated"
      ? `重新完成${PRIMARY_DRIVER_CALIBRATION_SAMPLE_COUNT}段标定`
      : `开始${PRIMARY_DRIVER_CALIBRATION_SAMPLE_COUNT}段安全确认标定`,
  });
}
