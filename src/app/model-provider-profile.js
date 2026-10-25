import { B3_B4_RUNTIME_CONTRACT_VERSION } from "../runtime/runtime-contract-version.js";

const MODEL_TASK_IDS = Object.freeze([
  "vehicle_slu",
  "orchestrator_plan",
  "cabin_response",
  "knowledge_answer",
  "rag_rerank",
  "asr_realtime",
  "tts_realtime",
]);
const LLM_TASK_IDS = new Set([
  "vehicle_slu",
  "orchestrator_plan",
  "cabin_response",
  "knowledge_answer",
  "rag_rerank",
]);
const PROVIDER_IDS = new Set(["ollama", "dashscope"]);
const TASK_MODES = new Set(["legacy", "non-thinking"]);
const READINESS_REASON_CODES = new Set([
  "provider-config-invalid",
  "provider-profile-unavailable",
  "provider-unavailable",
]);
const UNAVAILABLE_REASON_CODE = "provider-profile-unavailable";

function safeToken(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && value.trim() === value
    && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value);
}

function safeReasonCode(value) {
  return READINESS_REASON_CODES.has(value) ? value : UNAVAILABLE_REASON_CODE;
}

function blockedTaskProfile() {
  return Object.freeze({
    provider: null,
    model: null,
    mode: null,
    schemaVersion: null,
    fallbackConfigured: false,
    watchdogMs: null,
    primaryReadiness: Object.freeze({
      status: "blocked",
      reasonCode: UNAVAILABLE_REASON_CODE,
    }),
    readiness: Object.freeze({
      status: "blocked",
      reasonCode: UNAVAILABLE_REASON_CODE,
    }),
  });
}

function blockedProfileSet() {
  const tasks = {};
  for (const task of MODEL_TASK_IDS) tasks[task] = blockedTaskProfile();
  return Object.freeze({
    schemaVersion: 3,
    runtimeContractVersion: B3_B4_RUNTIME_CONTRACT_VERSION,
    tasks: Object.freeze(tasks),
  });
}

function normalizeReadiness(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.status === "ready") return Object.freeze({ status: "ready" });
  if (value.status !== "blocked") return null;
  return Object.freeze({
    status: "blocked",
    reasonCode: safeReasonCode(value.reasonCode),
  });
}

function normalizeTask(task, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const readiness = normalizeReadiness(value.readiness);
  const primaryReadiness = normalizeReadiness(value.primaryReadiness);
  const validWatchdog = value.watchdogMs === null
    || (Number.isSafeInteger(value.watchdogMs) && value.watchdogMs > 0);
  if (!readiness || !primaryReadiness || !validWatchdog
    || typeof value.fallbackConfigured !== "boolean") return null;

  if (LLM_TASK_IDS.has(task)) {
    if (!PROVIDER_IDS.has(value.provider)
      || !safeToken(value.model)
      || !TASK_MODES.has(value.mode)
      || (value.schemaVersion !== null && !safeToken(value.schemaVersion))) return null;
  } else if (value.provider !== null
    || value.model !== null
    || value.mode !== null
    || value.schemaVersion !== null) return null;

  return Object.freeze({
    provider: value.provider,
    model: value.model,
    mode: value.mode,
    schemaVersion: value.schemaVersion,
    fallbackConfigured: value.fallbackConfigured,
    watchdogMs: value.watchdogMs,
    primaryReadiness,
    readiness,
  });
}

function normalizeProfile(value) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== 3
    || value.runtimeContractVersion !== B3_B4_RUNTIME_CONTRACT_VERSION
    || !value.tasks
    || typeof value.tasks !== "object"
    || Array.isArray(value.tasks)) return null;

  const tasks = {};
  for (const task of MODEL_TASK_IDS) {
    tasks[task] = normalizeTask(task, value.tasks[task]) || blockedTaskProfile();
  }
  return Object.freeze({
    schemaVersion: 3,
    runtimeContractVersion: B3_B4_RUNTIME_CONTRACT_VERSION,
    tasks: Object.freeze(tasks),
  });
}

export async function loadModelProviderProfile({
  endpoint = "/api/model-provider-profile",
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = 1_500,
} = {}) {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      signal: timeoutController.signal,
      cache: "no-store",
    });
    if (!response.ok) return blockedProfileSet();
    return normalizeProfile(await response.json()) || blockedProfileSet();
  } catch {
    return blockedProfileSet();
  } finally {
    clearTimeout(timeout);
  }
}
