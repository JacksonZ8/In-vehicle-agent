const SCHEMA_VERSION = "nio-demo-readiness@1.0.0";
const STATUS_IDS = new Set(["full", "degraded", "blocked"]);
const STAGE_STATUS_IDS = new Set(["ready", "warming", "degraded", "disabled", "blocked"]);
const LEVEL_IDS = new Set([
  "primary",
  "fallback",
  "local-model",
  "deterministic",
  "browser-fallback",
  "unavailable",
]);
const LOCAL_WARMUP_STAGE_IDS = new Set(["manual_rag", "tts"]);

const statusLabels = Object.freeze({
  full: "完整可演示",
  degraded: "降级可演示",
  blocked: "不可演示",
});

const stageStatusLabels = Object.freeze({
  ready: "已就绪",
  warming: "预热中",
  degraded: "已降级",
  disabled: "未启用",
  blocked: "未就绪",
});

const levelLabels = Object.freeze({
  primary: "主用模型",
  fallback: "本地模型回退",
  "local-model": "本机模型",
  deterministic: "确定性 Runtime",
  "browser-fallback": "浏览器语音兜底",
  unavailable: "未就绪",
});

const reasonLabels = Object.freeze({
  "dependency-checking": "正在检查本地依赖",
  "warmup-unavailable": "本地预热不可用",
  "primary-provider-unavailable": "主用服务不可用，已使用回退",
  "provider-unavailable": "模型服务不可用",
  "hmi-unavailable": "HMI 或 Agent Server 不可用",
  "vehicle-asset-unavailable": "ES7 运行资产不可用",
  "deterministic-runtime-unavailable": "确定性 Runtime 不可用",
  "no-response-path": "当前没有可用响应路径",
  "readiness-unavailable": "就绪状态接口不可用",
  "browser-asset-loading": "浏览器正在加载 ES7 车模",
  "browser-asset-failed": "浏览器未能加载 ES7 车模",
  "local-voice-model-unavailable": "本地唤醒模型尚未安装",
  "local-voice-unavailable": "本地语音能力不可用",
});

function safeText(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized && normalized.length <= 128 ? normalized : fallback;
}

function safeDuration(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0
    ? Math.min(2_147_483_647, Math.round(normalized))
    : 0;
}

function normalizeFallback(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provider = safeText(value.provider);
  if (!provider) return null;
  return Object.freeze({
    provider,
    model: safeText(value.model),
    status: safeText(value.status, "configured"),
  });
}

function normalizeStage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = safeText(value.id);
  const label = safeText(value.label);
  const status = STAGE_STATUS_IDS.has(value.status) ? value.status : null;
  const configuredLevel = LEVEL_IDS.has(value.configuredLevel) ? value.configuredLevel : null;
  if (!id || !label || !status || !configuredLevel) return null;
  return Object.freeze({
    id,
    label,
    status,
    configuredLevel,
    activeLevel: LEVEL_IDS.has(value.activeLevel) ? value.activeLevel : null,
    activeProvider: safeText(value.activeProvider),
    activeModel: safeText(value.activeModel),
    provider: safeText(value.provider),
    model: safeText(value.model),
    fallback: normalizeFallback(value.fallback),
    verification: safeText(value.verification),
    durationMs: safeDuration(value.durationMs),
    reasonCode: safeText(value.reasonCode),
    lastCheckedAt: safeText(value.lastCheckedAt),
  });
}

export function normalizeDemoReadiness(value) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || !STATUS_IDS.has(value.status)
    || !Array.isArray(value.stages)) return null;
  const stages = value.stages.map(normalizeStage);
  if (stages.some((stage) => !stage)) return null;
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    status: value.status,
    deadlineMs: safeDuration(value.deadlineMs),
    elapsedMs: safeDuration(value.elapsedMs),
    capturedAt: safeText(value.capturedAt),
    stages: Object.freeze(stages),
  });
}

function unavailableSnapshot() {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    status: "degraded",
    deadlineMs: 30_000,
    elapsedMs: 0,
    capturedAt: new Date().toISOString(),
    stages: Object.freeze([Object.freeze({
      id: "readiness_contract",
      label: "运行准备状态",
      status: "degraded",
      configuredLevel: "unavailable",
      activeLevel: null,
      provider: null,
      model: null,
      fallback: null,
      verification: "client-fallback",
      durationMs: 0,
      reasonCode: "readiness-unavailable",
      lastCheckedAt: new Date().toISOString(),
    })]),
  });
}

export async function loadDemoReadiness({
  endpoint = "/api/demo-readiness",
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = 2_000,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return unavailableSnapshot();
    return normalizeDemoReadiness(await response.json()) || unavailableSnapshot();
  } catch {
    return unavailableSnapshot();
  } finally {
    clearTimeout(timeout);
  }
}

function recomputeStatus(snapshot, stages) {
  const hmi = stages.find((stage) => stage.id === "hmi_shell");
  const responsePath = stages.find((stage) => stage.id === "usable_response_path");
  if (hmi?.status === "blocked" || responsePath?.status === "blocked") return "blocked";
  return stages.every((stage) => stage.status === "ready") ? "full" : "degraded";
}

export function applyVehicleAssetStatus(snapshot, status) {
  if (!snapshot || !["loading", "ready", "failed"].includes(status)) return snapshot;
  const stages = snapshot.stages.map((stage) => {
    if (stage.id !== "vehicle_asset") return stage;
    if (status === "ready") return Object.freeze({
      ...stage,
      status: "ready",
      reasonCode: null,
      verification: "browser-load",
    });
    return Object.freeze({
      ...stage,
      status: status === "loading" ? "warming" : "degraded",
      reasonCode: status === "loading" ? "browser-asset-loading" : "browser-asset-failed",
      verification: "browser-load",
    });
  });
  return Object.freeze({ ...snapshot, status: recomputeStatus(snapshot, stages), stages: Object.freeze(stages) });
}

export function shouldRetryDemoLocalWarmup(snapshot) {
  return Array.isArray(snapshot?.stages)
    && snapshot.stages.some((stage) => (
      LOCAL_WARMUP_STAGE_IDS.has(stage?.id) && stage?.status !== "ready"
    ));
}

const phaseStageIds = Object.freeze({
  "route-decision": "vehicle_slu",
  "goal-formation": "orchestrator_plan",
  "task-planning": "orchestrator_plan",
  "knowledge-subplanning": "orchestrator_plan",
  "chat-response": "cabin_response",
  "final-synthesis": "cabin_response",
  "knowledge-answer": "knowledge_answer",
});

function levelForCall(stage, telemetry) {
  const provider = String(telemetry?.provider || "");
  const reasonCode = String(telemetry?.reasonCode || "");
  if (provider === "model-provider-profile"
    || provider.endsWith("-endpoint")
    || reasonCode.includes("unavailable")) return "unavailable";
  if (telemetry?.fallback === true || telemetry?.provider === stage?.fallback?.provider) return "fallback";
  return "primary";
}

export function applyRuntimeActiveLevels(snapshot, result, {
  voiceProvider = null,
  localVoiceService = null,
} = {}) {
  if (!snapshot) return snapshot;
  const activeByStage = new Map();
  for (const call of result?.runtimeTelemetry?.modelCalls || []) {
    const stageId = phaseStageIds[call?.phase];
    if (!stageId || !call?.telemetry) continue;
    activeByStage.set(stageId, call.telemetry);
  }
  if (result?.safetyDecision || result?.toolResult) {
    activeByStage.set("safety_runtime", { provider: "deterministic-runtime", deterministic: true });
  }
  if (result?.manualEvidence || result?.manualRetrievalCandidate) {
    activeByStage.set("manual_rag", { provider: "local-rag", deterministic: true });
  }
  if (voiceProvider) activeByStage.set("tts", { provider: voiceProvider });
  if (localVoiceService?.provider) {
    activeByStage.set("local_voice_wake", {
      provider: localVoiceService.provider,
      model: localVoiceService.model,
      localModel: true,
    });
  }

  const stages = snapshot.stages.map((stage) => {
    const telemetry = activeByStage.get(stage.id);
    if (!telemetry) return stage;
    const browserFallback = stage.id === "tts" && /browser/i.test(String(telemetry.provider));
    const deterministic = telemetry.deterministic === true;
    const localModel = telemetry.localModel === true;
    return Object.freeze({
      ...stage,
      activeLevel: browserFallback
        ? "browser-fallback"
        : localModel ? "local-model"
        : deterministic ? "deterministic" : levelForCall(stage, telemetry),
      activeProvider: safeText(telemetry.provider),
      activeModel: safeText(telemetry.model),
    });
  });
  return Object.freeze({ ...snapshot, stages: Object.freeze(stages) });
}

export function projectDemoReadinessView(snapshot) {
  const safeSnapshot = normalizeDemoReadiness(snapshot) || snapshot || unavailableSnapshot();
  const readyCount = safeSnapshot.stages.filter((stage) => stage.status === "ready").length;
  return Object.freeze({
    status: safeSnapshot.status,
    statusLabel: statusLabels[safeSnapshot.status] || statusLabels.degraded,
    summary: `${statusLabels[safeSnapshot.status] || statusLabels.degraded} · ${readyCount}/${safeSnapshot.stages.length}`,
    elapsedLabel: `${(safeSnapshot.elapsedMs / 1000).toFixed(1)}s / ${(safeSnapshot.deadlineMs / 1000).toFixed(0)}s`,
    capturedAt: safeSnapshot.capturedAt,
    stages: Object.freeze(safeSnapshot.stages.map((stage) => Object.freeze({
      ...stage,
      statusLabel: stageStatusLabels[stage.status] || stageStatusLabels.blocked,
      configuredLevelLabel: stage.id === "manual_rag" && stage.provider === "keyword-retrieval"
        ? "关键词检索回退"
        : levelLabels[stage.configuredLevel] || levelLabels.unavailable,
      activeLevelLabel: stage.activeLevel
        ? stage.id === "manual_rag" && stage.activeProvider === "keyword-retrieval"
          ? "关键词检索回退"
          : levelLabels[stage.activeLevel] || levelLabels.unavailable
        : "尚未运行",
      reasonLabel: stage.reasonCode ? reasonLabels[stage.reasonCode] || "服务状态不可用" : null,
    }))),
  });
}
