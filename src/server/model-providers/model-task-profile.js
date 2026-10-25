import { B3_B4_RUNTIME_CONTRACT_VERSION } from "../../runtime/runtime-contract-version.js";
import { MODEL_PROVIDER_IDS } from "./model-provider-contract.js";
import {
  VEHICLE_SLU_COMPACT_MODEL,
  VEHICLE_SLU_COMPACT_PROFILE,
} from "../../semantic/vehicle-slu-compact-v9.js";

const CONTRACT_VERSION = "nio-model-task-profile@1.0.0";
const DEFAULT_OLLAMA_MODEL = "qwen3:8b";
const LEGACY_OLLAMA_MODEL = "qwen2.5:7b";
const DEFAULT_DASHSCOPE_MODEL = "qwen-plus";
const VEHICLE_SLU_DASHSCOPE_MODEL = "qwen3.5-flash";
const KNOWLEDGE_ANSWER_DASHSCOPE_MODEL = "qwen3.8-flash";

export const APPROVED_MODEL_IDS_BY_PROVIDER = Object.freeze({
  ollama: Object.freeze([DEFAULT_OLLAMA_MODEL, LEGACY_OLLAMA_MODEL]),
  dashscope: Object.freeze([
    DEFAULT_DASHSCOPE_MODEL,
    VEHICLE_SLU_DASHSCOPE_MODEL,
    KNOWLEDGE_ANSWER_DASHSCOPE_MODEL,
  ]),
});

export const MODEL_TASK_IDS = Object.freeze([
  "vehicle_slu",
  "orchestrator_plan",
  "cabin_response",
  "knowledge_answer",
  "rag_rerank",
  "asr_realtime",
  "tts_realtime",
]);

const LLM_TASK_IDS = Object.freeze(MODEL_TASK_IDS.filter((task) => (
  task !== "asr_realtime" && task !== "tts_realtime"
)));
const LLM_TASK_ID_SET = new Set(LLM_TASK_IDS);
const MODEL_PROVIDER_ID_SET = new Set(MODEL_PROVIDER_IDS);
const PUBLIC_TASK_MODES = new Set(["legacy", "non-thinking"]);
const PUBLIC_READINESS_REASON_CODES = new Set([
  "provider-config-invalid",
  "provider-profile-unavailable",
  "provider-unavailable",
]);
const PUBLIC_PROFILE_SCHEMA_VERSION = 3;
const UNAVAILABLE_REASON_CODE = "provider-profile-unavailable";

function readString(env, name, fallback = "") {
  return typeof env[name] === "string" ? env[name].trim() : fallback;
}

function resolveWatchdogMs(value) {
  const watchdogMs = Number(value);
  return Number.isSafeInteger(watchdogMs) && watchdogMs > 0 ? watchdogMs : null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function safePublicToken(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && value.trim() === value
    && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value);
}

function safePublicReasonCode(value) {
  return PUBLIC_READINESS_REASON_CODES.has(value) ? value : UNAVAILABLE_REASON_CODE;
}

function isSupportedProviderProfile(value) {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && MODEL_PROVIDER_ID_SET.has(value.provider)
      && APPROVED_MODEL_IDS_BY_PROVIDER[value.provider]?.includes(value.model),
  );
}

function resolvePublicTaskReadiness(profile, connections) {
  const primaryReadiness = connections?.[profile.provider]?.readiness;
  if (primaryReadiness?.status === "ready") return primaryReadiness;
  if (!isSupportedProviderProfile(profile.fallback)) return primaryReadiness;
  const fallbackReadiness = connections?.[profile.fallback.provider]?.readiness;
  return fallbackReadiness?.status === "ready" ? fallbackReadiness : primaryReadiness;
}

function createBlockedPublicTaskProfile(reasonCode = UNAVAILABLE_REASON_CODE) {
  return deepFreeze({
    provider: null,
    model: null,
    mode: null,
    schemaVersion: null,
    fallbackConfigured: false,
    watchdogMs: null,
    primaryReadiness: {
      status: "blocked",
      reasonCode: safePublicReasonCode(reasonCode),
    },
    readiness: {
      status: "blocked",
      reasonCode: safePublicReasonCode(reasonCode),
    },
  });
}

function projectPublicReadiness(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.status === "ready") return Object.freeze({ status: "ready" });
  if (value.status !== "blocked") return null;
  return Object.freeze({
    status: "blocked",
    reasonCode: safePublicReasonCode(value.reasonCode),
  });
}

function projectPublicTaskProfile(task, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const readiness = projectPublicReadiness(value.readiness);
  const primaryReadiness = projectPublicReadiness(value.primaryReadiness);
  const watchdogMs = value.watchdogMs;
  const validWatchdog = watchdogMs === null
    || (Number.isSafeInteger(watchdogMs) && watchdogMs > 0);
  if (!readiness || !primaryReadiness || !validWatchdog
    || typeof value.fallbackConfigured !== "boolean") return null;

  if (!LLM_TASK_ID_SET.has(task)) {
    if (value.provider !== null
      || value.model !== null
      || value.mode !== null
      || value.schemaVersion !== null) return null;
  } else if (!MODEL_PROVIDER_ID_SET.has(value.provider)
    || !safePublicToken(value.model)
    || !PUBLIC_TASK_MODES.has(value.mode)
    || (value.schemaVersion !== null && !safePublicToken(value.schemaVersion))) {
    return null;
  }

  return deepFreeze({
    provider: value.provider,
    model: value.model,
    mode: value.mode,
    schemaVersion: value.schemaVersion,
    fallbackConfigured: value.fallbackConfigured,
    watchdogMs,
    primaryReadiness,
    readiness,
  });
}

function blockedPublicTaskSet() {
  const tasks = {};
  for (const task of MODEL_TASK_IDS) tasks[task] = createBlockedPublicTaskProfile();
  return Object.freeze(tasks);
}

export function projectPublicModelTaskProfileSet(source) {
  const validEnvelope = source
    && typeof source === "object"
    && !Array.isArray(source)
    && source.schemaVersion === PUBLIC_PROFILE_SCHEMA_VERSION
    && source.runtimeContractVersion === B3_B4_RUNTIME_CONTRACT_VERSION
    && source.tasks
    && typeof source.tasks === "object"
    && !Array.isArray(source.tasks);
  if (!validEnvelope) {
    return Object.freeze({
      schemaVersion: PUBLIC_PROFILE_SCHEMA_VERSION,
      runtimeContractVersion: B3_B4_RUNTIME_CONTRACT_VERSION,
      tasks: blockedPublicTaskSet(),
    });
  }

  const tasks = {};
  for (const task of MODEL_TASK_IDS) {
    tasks[task] = projectPublicTaskProfile(task, source.tasks[task])
      || createBlockedPublicTaskProfile();
  }
  return Object.freeze({
    schemaVersion: PUBLIC_PROFILE_SCHEMA_VERSION,
    runtimeContractVersion: B3_B4_RUNTIME_CONTRACT_VERSION,
    tasks: Object.freeze(tasks),
  });
}

export function createPublicModelTaskProfileSet(taskProfiles = {}, connections = {}) {
  const tasks = {};
  for (const task of MODEL_TASK_IDS) {
    const profile = taskProfiles?.[task];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) continue;
    if (LLM_TASK_ID_SET.has(task)) {
      const fallbackConfigured = isSupportedProviderProfile(profile.fallback);
      tasks[task] = {
        provider: profile.provider,
        model: profile.model,
        mode: profile.mode ?? null,
        schemaVersion: profile.schemaVersion ?? null,
        fallbackConfigured,
        watchdogMs: profile.watchdogMs ?? null,
        primaryReadiness: connections?.[profile.provider]?.readiness,
        readiness: resolvePublicTaskReadiness(profile, connections),
      };
      continue;
    }
    tasks[task] = {
      provider: null,
      model: null,
      mode: null,
      schemaVersion: null,
      fallbackConfigured: false,
      watchdogMs: profile.watchdogMs ?? null,
      primaryReadiness: safePublicToken(profile.implementation)
        ? { status: "ready" }
        : { status: "blocked", reasonCode: UNAVAILABLE_REASON_CODE },
      readiness: safePublicToken(profile.implementation)
        ? { status: "ready" }
        : { status: "blocked", reasonCode: UNAVAILABLE_REASON_CODE },
    };
  }
  return projectPublicModelTaskProfileSet({
    schemaVersion: PUBLIC_PROFILE_SCHEMA_VERSION,
    runtimeContractVersion: B3_B4_RUNTIME_CONTRACT_VERSION,
    tasks,
  });
}

function taskEnvName(task, suffix) {
  return `NIO_${task.toUpperCase()}_${suffix}`;
}

function profileError(task, field) {
  return new Error(`Model task profile ${task} has an unsupported ${field}`);
}

function resolveLegacyLlmConfig(env) {
  const provider = readString(env, "NIO_LLM_PROVIDER", "ollama");
  if (!MODEL_PROVIDER_IDS.includes(provider)) throw profileError("legacy", "provider");

  const model = provider === "dashscope"
    ? readString(env, "NIO_DASHSCOPE_MODEL", DEFAULT_DASHSCOPE_MODEL)
    : readString(env, "NIO_LLM_MODEL", DEFAULT_OLLAMA_MODEL);
  const legacyModel = provider === "dashscope" ? DEFAULT_DASHSCOPE_MODEL : DEFAULT_OLLAMA_MODEL;
  if (model !== legacyModel) throw profileError("legacy", "model");
  return { provider, model };
}

const VEHICLE_SLU_CLOUD_PROFILE = "cloud-dashscope";

// Vehicle-SLU defaults to the local compact model; DashScope is an explicit opt-in.
// Either way it is a single semantic request with no repair and no fallback provider.
function resolveVehicleSluProfile(env) {
  const providerName = taskEnvName("vehicle_slu", "PROVIDER");
  const modelName = taskEnvName("vehicle_slu", "MODEL");
  const fallbackProviderName = taskEnvName("vehicle_slu", "FALLBACK_PROVIDER");
  const fallbackModelName = taskEnvName("vehicle_slu", "FALLBACK_MODEL");
  const profileName = taskEnvName("vehicle_slu", "PROFILE");
  if (Object.hasOwn(env, fallbackProviderName) || Object.hasOwn(env, fallbackModelName)) {
    throw profileError("vehicle_slu", "fallback provider or model");
  }
  const selectedProfile = readString(env, profileName, VEHICLE_SLU_COMPACT_PROFILE);
  const local = selectedProfile === VEHICLE_SLU_COMPACT_PROFILE;
  if (!local && selectedProfile !== VEHICLE_SLU_CLOUD_PROFILE) {
    throw profileError("vehicle_slu", "profile");
  }
  const provider = local ? "ollama" : "dashscope";
  const model = local ? VEHICLE_SLU_COMPACT_MODEL : VEHICLE_SLU_DASHSCOPE_MODEL;
  if ((Object.hasOwn(env, providerName) && readString(env, providerName) !== provider)
    || (Object.hasOwn(env, modelName) && readString(env, modelName) !== model)) {
    throw profileError("vehicle_slu", "provider or model");
  }
  return {
    contractVersion: CONTRACT_VERSION,
    task: "vehicle_slu",
    provider,
    model,
    mode: "non-thinking",
    schemaVersion: "nio-vehicle-slu-contract@2.0.0",
    watchdogMs: resolveWatchdogMs(env[taskEnvName("vehicle_slu", "WATCHDOG_MS")]),
  };
}

function resolveCabinResponseProfile(env) {
  const providerName = taskEnvName("cabin_response", "PROVIDER");
  const modelName = taskEnvName("cabin_response", "MODEL");
  const fallbackProviderName = taskEnvName("cabin_response", "FALLBACK_PROVIDER");
  const fallbackModelName = taskEnvName("cabin_response", "FALLBACK_MODEL");
  const hasPrimaryOverride = Object.hasOwn(env, providerName) || Object.hasOwn(env, modelName);
  const hasFallbackOverride = Object.hasOwn(env, fallbackProviderName) || Object.hasOwn(env, fallbackModelName);

  if (hasPrimaryOverride && (
    readString(env, providerName) !== "dashscope"
    || readString(env, modelName) !== DEFAULT_DASHSCOPE_MODEL
  )) {
    throw profileError("cabin_response", "provider or model");
  }

  if (hasFallbackOverride && (
    readString(env, fallbackProviderName) !== "ollama"
    || readString(env, fallbackModelName) !== DEFAULT_OLLAMA_MODEL
  )) {
    throw profileError("cabin_response", "fallback provider or model");
  }

  return {
    contractVersion: CONTRACT_VERSION,
    task: "cabin_response",
    provider: "dashscope",
    model: DEFAULT_DASHSCOPE_MODEL,
    mode: "non-thinking",
    fallbackProfile: "cabin_response_local",
    fallback: { provider: "ollama", model: DEFAULT_OLLAMA_MODEL },
    watchdogMs: resolveWatchdogMs(env[taskEnvName("cabin_response", "WATCHDOG_MS")]),
  };
}

function resolveKnowledgeAnswerProfile(env) {
  const providerName = taskEnvName("knowledge_answer", "PROVIDER");
  const modelName = taskEnvName("knowledge_answer", "MODEL");
  const fallbackProviderName = taskEnvName("knowledge_answer", "FALLBACK_PROVIDER");
  const fallbackModelName = taskEnvName("knowledge_answer", "FALLBACK_MODEL");
  const hasPrimaryOverride = Object.hasOwn(env, providerName) || Object.hasOwn(env, modelName);
  const hasFallbackOverride = Object.hasOwn(env, fallbackProviderName) || Object.hasOwn(env, fallbackModelName);

  if (hasPrimaryOverride && (
    readString(env, providerName) !== "dashscope"
    || readString(env, modelName) !== KNOWLEDGE_ANSWER_DASHSCOPE_MODEL
  )) {
    throw profileError("knowledge_answer", "provider or model");
  }

  if (hasFallbackOverride && (
    readString(env, fallbackProviderName) !== "ollama"
    || readString(env, fallbackModelName) !== DEFAULT_OLLAMA_MODEL
  )) {
    throw profileError("knowledge_answer", "fallback provider or model");
  }

  return {
    contractVersion: CONTRACT_VERSION,
    task: "knowledge_answer",
    provider: "dashscope",
    model: KNOWLEDGE_ANSWER_DASHSCOPE_MODEL,
    mode: "non-thinking",
    schemaVersion: "nio-knowledge-answer-contract@1.0.0",
    fallbackProfile: "knowledge_answer_local",
    fallback: { provider: "ollama", model: DEFAULT_OLLAMA_MODEL },
    watchdogMs: resolveWatchdogMs(env[taskEnvName("knowledge_answer", "WATCHDOG_MS")]),
  };
}

function rejectUnsupportedModelOverride(task, env) {
  for (const suffix of ["PROVIDER", "MODEL", "FALLBACK_PROVIDER", "FALLBACK_MODEL"]) {
    if (Object.hasOwn(env, taskEnvName(task, suffix))) {
      throw profileError(task, "provider or model");
    }
  }
}

function resolveLegacyLlmProfile(task, legacy, env) {
  rejectUnsupportedModelOverride(task, env);
  return {
    contractVersion: CONTRACT_VERSION,
    task,
    provider: legacy.provider,
    model: legacy.model,
    mode: legacy.provider === "ollama" ? "non-thinking" : "legacy",
    watchdogMs: resolveWatchdogMs(env[taskEnvName(task, "WATCHDOG_MS")]),
  };
}

function resolveOrchestratorPlanProfile(env) {
  const providerName = taskEnvName("orchestrator_plan", "PROVIDER");
  const modelName = taskEnvName("orchestrator_plan", "MODEL");
  const fallbackProviderName = taskEnvName("orchestrator_plan", "FALLBACK_PROVIDER");
  const fallbackModelName = taskEnvName("orchestrator_plan", "FALLBACK_MODEL");
  const hasPrimaryOverride = Object.hasOwn(env, providerName) || Object.hasOwn(env, modelName);
  const hasFallbackOverride = Object.hasOwn(env, fallbackProviderName) || Object.hasOwn(env, fallbackModelName);

  if (hasPrimaryOverride && (
    readString(env, providerName) !== "dashscope"
    || readString(env, modelName) !== DEFAULT_DASHSCOPE_MODEL
  )) {
    throw profileError("orchestrator_plan", "provider or model");
  }

  if (hasFallbackOverride && (
    readString(env, fallbackProviderName) !== "ollama"
    || readString(env, fallbackModelName) !== DEFAULT_OLLAMA_MODEL
  )) {
    throw profileError("orchestrator_plan", "fallback provider or model");
  }

  return {
    contractVersion: CONTRACT_VERSION,
    task: "orchestrator_plan",
    provider: "dashscope",
    model: DEFAULT_DASHSCOPE_MODEL,
    mode: "non-thinking",
    fallbackProfile: "orchestrator_plan_local",
    fallback: { provider: "ollama", model: DEFAULT_OLLAMA_MODEL },
    watchdogMs: resolveWatchdogMs(env[taskEnvName("orchestrator_plan", "WATCHDOG_MS")]),
  };
}

function resolveImplementationProfile(task, implementation, env) {
  rejectUnsupportedModelOverride(task, env);
  return {
    contractVersion: CONTRACT_VERSION,
    task,
    implementation,
    provider: null,
    model: null,
    watchdogMs: resolveWatchdogMs(env[taskEnvName(task, "WATCHDOG_MS")]),
  };
}

export function resolveModelTaskProfiles(env = {}) {
  const legacy = resolveLegacyLlmConfig(env);
  const profiles = {
    vehicle_slu: resolveVehicleSluProfile(env),
    orchestrator_plan: resolveOrchestratorPlanProfile(env),
    cabin_response: resolveCabinResponseProfile(env),
    knowledge_answer: resolveKnowledgeAnswerProfile(env),
    rag_rerank: resolveLegacyLlmProfile("rag_rerank", legacy, env),
    asr_realtime: resolveImplementationProfile("asr_realtime", "browser-speech-recognition", env),
    tts_realtime: resolveImplementationProfile("tts_realtime", "gpt-sovits", env),
  };
  return deepFreeze(profiles);
}

export function isModelTaskId(task) {
  return MODEL_TASK_IDS.includes(task);
}
