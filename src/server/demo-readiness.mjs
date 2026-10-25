export const DEMO_READINESS_SCHEMA_VERSION = "nio-demo-readiness@1.0.0";
export const DEMO_READINESS_DEADLINE_MS = 30_000;

const MODEL_STAGE_LABELS = Object.freeze({
  vehicle_slu: "语义解析",
  orchestrator_plan: "任务规划",
  cabin_response: "座舱回答",
  knowledge_answer: "知识回答",
});

function duration(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0
    ? Math.min(2_147_483_647, Math.round(normalized))
    : 0;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function fallbackSummary(profile, ollamaHealth) {
  if (!profile?.fallback?.provider || !profile?.fallback?.model) return null;
  return Object.freeze({
    provider: profile.fallback.provider,
    model: profile.fallback.model,
    status: profile.fallback.provider === "ollama"
      ? ollamaHealth?.ready === true ? "ready" : "blocked"
      : "configured",
  });
}

function modelStage(taskId, publicProfile, profile, ollamaHealth, checkedAt) {
  const taskReady = publicProfile?.readiness?.status === "ready";
  const primaryConfigured = publicProfile?.primaryReadiness?.status === "ready";
  const primaryIsOllama = publicProfile?.provider === "ollama";
  const primaryReady = primaryConfigured && (!primaryIsOllama || ollamaHealth?.ready === true);
  const fallback = fallbackSummary(profile, ollamaHealth);
  const fallbackReady = !primaryReady && taskReady && Boolean(fallback);
  const usingFallback = !primaryReady && fallbackReady;
  const status = primaryReady ? "ready" : usingFallback ? "degraded" : "blocked";
  const reasonCode = primaryReady
    ? null
    : usingFallback ? "primary-provider-unavailable" : "provider-unavailable";

  return Object.freeze({
    id: taskId,
    label: MODEL_STAGE_LABELS[taskId],
    status,
    configuredLevel: primaryReady ? "primary" : usingFallback ? "fallback" : "unavailable",
    activeLevel: null,
    provider: primaryReady
      ? publicProfile.provider
      : usingFallback ? fallback.provider : publicProfile?.provider ?? null,
    model: primaryReady
      ? publicProfile.model
      : usingFallback ? fallback.model : publicProfile?.model ?? null,
    fallback,
    verification: primaryReady && publicProfile.provider === "dashscope"
      ? "configuration-only"
      : "local-health",
    durationMs: primaryIsOllama || fallback?.provider === "ollama"
      ? duration(ollamaHealth?.durationMs)
      : 0,
    reasonCode,
    lastCheckedAt: checkedAt,
  });
}

function warmupStage(taskId, label, task, checkedAt) {
  if (task?.status === "ready") {
    return Object.freeze({
      id: taskId,
      label,
      status: "ready",
      configuredLevel: "primary",
      activeLevel: null,
      provider: taskId === "manual_rag" ? "local-rag" : "gpt-sovits",
      model: task?.model ?? task?.profile ?? null,
      fallback: taskId === "manual_rag"
        ? Object.freeze({ provider: "keyword-retrieval", model: null, status: "ready" })
        : Object.freeze({ provider: "browser-speech", model: null, status: "ready" }),
      verification: "local-warmup",
      durationMs: duration(task.durationMs),
      reasonCode: null,
      lastCheckedAt: checkedAt,
    });
  }

  const warming = task?.status === "warming" || task?.status === "checking" || !task;
  return Object.freeze({
    id: taskId,
    label,
    status: warming ? "warming" : "degraded",
    configuredLevel: taskId === "manual_rag" ? "deterministic" : "browser-fallback",
    activeLevel: null,
    provider: taskId === "manual_rag" ? "keyword-retrieval" : "browser-speech",
    model: null,
    fallback: null,
    verification: warming ? "pending" : "local-warmup",
    durationMs: duration(task?.durationMs),
    reasonCode: warming ? "dependency-checking" : "warmup-unavailable",
    lastCheckedAt: checkedAt,
  });
}

function fixedStage({
  id,
  label,
  ready,
  provider,
  reasonCode,
  checkedAt,
}) {
  return Object.freeze({
    id,
    label,
    status: ready ? "ready" : "blocked",
    configuredLevel: ready ? "deterministic" : "unavailable",
    activeLevel: ready ? "deterministic" : null,
    provider: ready ? provider : null,
    model: null,
    fallback: null,
    verification: "local-check",
    durationMs: 0,
    reasonCode: ready ? null : reasonCode,
    lastCheckedAt: checkedAt,
  });
}

function localVoiceStage(readiness, checkedAt) {
  const status = ["ready", "degraded", "disabled"].includes(readiness?.status)
    ? readiness.status
    : "degraded";
  return Object.freeze({
    id: "local_voice_wake",
    label: "本地唤醒",
    status,
    configuredLevel: status === "ready" ? "local-model" : "unavailable",
    activeLevel: null,
    provider: readiness?.provider ?? null,
    model: readiness?.model ?? null,
    fallback: null,
    verification: readiness?.simulated === true ? "contract-only" : "local-health",
    durationMs: 0,
    reasonCode: status === "ready"
      ? null
      : readiness?.reasonCode ?? "local-voice-unavailable",
    lastCheckedAt: checkedAt,
  });
}

export function buildDemoReadiness({
  now = Date.now(),
  startedAt = now,
  deadlineMs = DEMO_READINESS_DEADLINE_MS,
  publicProfiles,
  taskProfiles,
  warmupSnapshot,
  ollamaHealth,
  hmiReady = true,
  vehicleAssetReady = true,
  deterministicRuntimeReady = true,
  localVoiceReadiness,
} = {}) {
  const checkedAt = timestamp(now);
  const stages = [
    fixedStage({
      id: "hmi_shell",
      label: "HMI 与 Agent Server",
      ready: hmiReady,
      provider: "local-agent-server",
      reasonCode: "hmi-unavailable",
      checkedAt,
    }),
    fixedStage({
      id: "vehicle_asset",
      label: "ES7 车模",
      ready: vehicleAssetReady,
      provider: "es7-runtime-asset",
      reasonCode: "vehicle-asset-unavailable",
      checkedAt,
    }),
    ...Object.keys(MODEL_STAGE_LABELS).map((taskId) => modelStage(
      taskId,
      publicProfiles?.tasks?.[taskId],
      taskProfiles?.[taskId],
      ollamaHealth,
      checkedAt,
    )),
    warmupStage("manual_rag", "手册检索", warmupSnapshot?.tasks?.manualRag, checkedAt),
    fixedStage({
      id: "safety_runtime",
      label: "车控与安全",
      ready: deterministicRuntimeReady,
      provider: "deterministic-runtime",
      reasonCode: "deterministic-runtime-unavailable",
      checkedAt,
    }),
    localVoiceStage(localVoiceReadiness, checkedAt),
    warmupStage("tts", "语音输出", warmupSnapshot?.tasks?.gptSoVits, checkedAt),
  ];

  const vehicleSemanticRouteReady = stages.some(
    (stage) => stage.id === "vehicle_slu" && stage.status !== "blocked",
  );
  const textAnswerRouteReady = stages.some(
    (stage) => ["cabin_response", "knowledge_answer"].includes(stage.id)
      && stage.status !== "blocked",
  );
  const usableResponsePath = hmiReady
    && vehicleSemanticRouteReady
    && (deterministicRuntimeReady || textAnswerRouteReady);
  stages.push(fixedStage({
    id: "usable_response_path",
    label: "可用响应路径",
    ready: usableResponsePath,
    provider: "runtime-routing",
    reasonCode: "no-response-path",
    checkedAt,
  }));

  const criticalReady = hmiReady && usableResponsePath;
  const allReady = stages.every((stage) => stage.status === "ready");
  const status = !criticalReady ? "blocked" : allReady ? "full" : "degraded";

  return Object.freeze({
    schemaVersion: DEMO_READINESS_SCHEMA_VERSION,
    status,
    deadlineMs: duration(deadlineMs),
    elapsedMs: Math.min(
      duration(Number(now) - Number(startedAt)),
      duration(deadlineMs),
    ),
    capturedAt: checkedAt,
    stages: Object.freeze(stages),
  });
}
