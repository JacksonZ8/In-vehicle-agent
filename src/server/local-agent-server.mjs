import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildManualVectorEvidenceSummary,
  warmManualEmbeddingModel,
  warmReadyManualVectorIndexes,
} from "../manual/manual-rag-vector-retriever.js";
import { buildManualEvidenceSummary as buildKeywordManualEvidenceSummary } from "../manual/manual-rag-retriever.js";
import {
  createRuntimeWarmupCoordinator,
  handleRuntimeWarmupBody,
} from "./runtime-warmup.mjs";
import { buildDemoReadiness } from "./demo-readiness.mjs";
import {
  formatManualCitationForDisplay,
  MANUAL_CORPUS_REGISTRY,
} from "../manual/manual-corpus-registry.js";
import { resolveManualRagApiStatus } from "../manual/manual-evidence-eligibility.js";
import { createManualRagApiResponse } from "../manual/manual-rag-presentation.js";
import {
  ManualEvidenceRunLedger,
  manualEvidenceRunLedgerUsesCorpusRegistry,
} from "./manual-evidence-run-ledger.mjs";
import {
  createManualUserGuideRepository,
  manualUserGuideRepositoryUsesCorpusRegistry,
} from "./manual-userguide-repository.mjs";
import {
  resolveConversationRoute,
} from "../runtime/agent-schemas.js";
import { resolveTtsSynthesisProfile } from "../voice/tts-profile-loader.mjs";
import { runGptSoVitsStartupWarmup } from "../voice/gptsovits-runtime-warmup.mjs";
import {
  buildWeatherAdviceFromPolicy,
  WEATHER_ADVICE_POLICY,
} from "../external-data/weather-advice-policy.js";
import {
  buildConversationBoundaryResponse,
  buildVehicleSluBoundaryResponse,
} from "../runtime/boundary-response-builder.js";
import {
  buildTemplatePlanningSummary,
  isTemplatePlanningSummaryCandidate as isTemplatePlanningSummaryCandidateByContract,
  PLANNING_TEMPLATE_RENDERER_CAPABILITY,
} from "../runtime/planning-renderer-contract.js";
import {
  buildVehicleKnowledgeContext,
  buildVehicleKnowledgeFallback,
  getVehicleKnowledgeApplicability,
  vehicleKnowledgeRecommendations,
} from "../external-data/vehicle-knowledge.js";
import {
  B2_UNCONFIRMED_WRITE_RESPONSE,
  B2_WRITE_COMPLETION_STATUS,
  buildB2SafetyRejectedResponse,
  buildGoalFormationPrompt,
  buildResponseSynthesisPrompt,
  buildRecoveryProposalPrompt,
  buildTaskPlanningPrompt,
  buildTurnRelationPrompt,
  buildVehicleKnowledgePlanningPrompt,
  buildVehicleKnowledgeSynthesisPrompt,
  buildTrustedPlanningContextRefs,
  resolveConversationPlanningGoalAuthority,
  resolveEligibleTaskPlanningCapabilities,
  resolveWriteCompletionStatus,
} from "../runtime/cloud-llm-adapter.js";
import {
  validateGoalEnvelope,
  validateTaskPlanShape,
} from "../agents/agent-contracts.js";
import { validatePlanAgainstCatalog } from "../agents/plan-validator.js";
import {
  createKnowledgeAnswer,
  createKnowledgeClarificationRequest,
  createKnowledgeSubplan,
  isKnowledgeClarificationAllowed,
} from "../application/contracts/vehicle-knowledge.js";
import { getKnowledgeCapability } from "../agents/knowledge-capability-catalog.js";
import {
  KNOWLEDGE_ELIGIBILITY_TOPOLOGY,
  validateKnowledgeSubplan,
} from "../agents/knowledge-plan-validator.js";
import { validateKnowledgeTerminalBoundary } from "../agents/cabin-assistant-controller.js";
import {
  goalClaimsNoKnowledgeAuthority,
  resolveTrustedKnowledgeDelegationAuthority,
} from "../agents/goal-authority.js";
import {
  createAbortError,
  isCancellationError,
  throwIfAborted,
} from "../runtime/abort-utils.js";
import {
  createCapabilityFailure,
  RECOVERY_ACTIONS,
} from "../interaction/recovery-policy.js";
import {
  createVehicleSluEnvelope,
  VEHICLE_SLU_CONTRACT,
  VEHICLE_SLU_OUTPUT_SCHEMA,
  VEHICLE_SLU_PROMPT_VERSION,
} from "../semantic/vehicle-slu-contract.js";
import { normalizeVehicleSluGeneratedEnvelope } from "../semantic/vehicle-slu-generated-normalizer.js";
import {
  getVehicleWriteCapabilityForIntent,
  projectVehicleWriteBinding,
} from "../vehicle/vehicle-write-capabilities.js";
import { buildVehicleSluPrompt } from "../semantic/vehicle-slu-prompt.js";
import { expandVehicleSluCompact, VEHICLE_SLU_COMPACT_OUTPUT_FORMAT } from "../semantic/vehicle-slu-compact.js";
import {
  buildVehicleSluCompactV9Prompt,
  isVehicleSluCompactModel,
  VEHICLE_SLU_COMPACT_PROMPT_VERSION,
  VEHICLE_SLU_COMPACT_GENERATION_PROFILE,
  VEHICLE_SLU_COMPACT_SYSTEM,
} from "../semantic/vehicle-slu-compact-v9.js";
import { createOllamaGenerateClient } from "./model-providers/ollama-generate-client.js";
import {
  boundExternalModelRequestCount,
  ModelProviderError,
} from "./model-providers/model-provider-contract.js";
import { resolveModelProviderConnections } from "./model-providers/model-provider-config.js";
import { createModelProviderRegistry } from "./model-providers/model-provider-registry.js";
import {
  createPublicModelTaskProfileSet,
  projectPublicModelTaskProfileSet,
  resolveModelTaskProfiles,
} from "./model-providers/model-task-profile.js";
import { resolveBenchmarkFaultProfile } from "../benchmark/benchmark-fault-profile.js";
import { createLocalVoiceGatewayCoordinator } from "./local-voice-gateway-coordinator.mjs";
import {
  attachLocalVoiceWebSocketGateway,
  isSameOriginLoopbackRequest,
} from "./local-voice-websocket-gateway.mjs";
import { assertDeepFrozenManualCorpusRegistry, plainDataObject } from "./manual-corpus-registry-guard.mjs";
import {
  WEATHER_COMPARISON_GROUNDING_POLICY,
  buildWeatherComposerPrompt,
  buildWeatherFactPack,
  buildWeatherQueryPlan,
  deriveWeatherAnswerClaimsFromText,
  fetchOpenMeteoWeather,
  formatWeatherSummary,
  isOpenWeatherQuestion,
  normalizeWeatherAdapterReasonCode,
  normalizeWeatherComposerOutput,
  normalizeWeatherGroundingReasons,
  resolveTemporalRange,
  resolveWeatherLocation,
  shouldFetchWeatherData,
  validateWeatherComposedAnswer,
  weatherComposerFallback,
  weatherTimeoutMs,
} from "./weather/weather-service.mjs";
import {
  canWriteResponse,
  createRequestAbortScope,
  json,
  readBinaryBody,
  readBody,
} from "./http/http-io.mjs";
import {
  buildTtsPayload,
  gptSoVitsEndpoint,
  handleTts,
  handleTtsStreamingPoc,
} from "./tts/tts-routes.mjs";
import {
  handleManualUserGuide,
  handleManualUserGuidePdf,
} from "./manual/manual-userguide-routes.mjs";
import { resolveLocalSpeakerIdentityReadiness } from "./local-speaker-identity-profile.mjs";
import { createVoiceIdentityStore } from "./voice-identity-store.mjs";
import { createVoiceIdentityEnrollmentCoordinator } from "./voice-identity-enrollment-coordinator.mjs";
import { createVoiceIdentityCalibrationCoordinator } from "./voice-identity-calibration-coordinator.mjs";
import { createVoiceIdentityVerificationPolicyStore } from "./voice-identity-verification-policy.mjs";
import { createVoiceIdentityProofStore } from "./voice-identity-proof-store.mjs";
import { createVoiceIdentityProofCoordinator } from "./voice-identity-proof-coordinator.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverProcessStartedAt = Date.now();
export const defaultModelTaskProfiles = resolveModelTaskProfiles(process.env);
const root = path.resolve(__dirname, "../..");
const startPort = Number(process.env.NIO_AGENT_PORT || process.argv[2] || 4173);
const allowPortFallback = process.env.NIO_ALLOW_PORT_FALLBACK === "true";
const ollamaUrl = process.env.NIO_OLLAMA_URL || "http://127.0.0.1:11434";
const llmTimeoutMs = Number(process.env.NIO_LLM_TIMEOUT_MS || 30000);
const structuredAgentTimeoutMs = resolveStructuredAgentTimeoutMs(
  process.env.NIO_B2_STRUCTURED_TIMEOUT_MS,
);
const VEHICLE_KNOWLEDGE_STRUCTURED_TIMEOUT_MS = 90_000;
const llmPromptStyle = process.env.NIO_LLM_PROMPT_STYLE === "compact" ? "compact" : "verbose";
const llmConversationCompactOutputEnabled = process.env.NIO_LLM_CONVERSATION_COMPACT_OUTPUT !== "false";
const llmConversationCompactOutputBudget = 24;
const llmPlanningSummaryMode = process.env.NIO_LLM_PLANNING_SUMMARY_MODE === "template" ? "template" : "llm";
const llmResponseCacheSize = Math.max(0, Math.floor(Number(process.env.NIO_LLM_RESPONSE_CACHE_SIZE || 32)));
const llmResponseCacheTtlMs = Math.max(0, Math.floor(Number(process.env.NIO_LLM_RESPONSE_CACHE_TTL_MS || 600000)));
const ollamaKeepAlive = process.env.NIO_OLLAMA_KEEP_ALIVE || "24h";
const ollamaHealthTimeoutMs = Number(process.env.NIO_OLLAMA_HEALTH_TIMEOUT_MS || 1500);
const ollamaWarmupOnStart = process.env.NIO_OLLAMA_WARMUP_ON_START !== "false";
const ollamaWarmupTimeoutMs = Number(process.env.NIO_OLLAMA_WARMUP_TIMEOUT_MS || 120000);
const ollamaWarmupPrompt = process.env.NIO_OLLAMA_WARMUP_PROMPT || "请只回复：ok";
const ollamaGenerateClient = createOllamaGenerateClient({
  baseUrl: ollamaUrl,
  keepAlive: ollamaKeepAlive,
});
const defaultModelProviderConnections = resolveModelProviderConnections(process.env, {
  ollamaClient: ollamaGenerateClient,
});
const defaultModelProviderRegistry = createModelProviderRegistry({
  taskProfiles: defaultModelTaskProfiles,
  connections: defaultModelProviderConnections,
  publicProfiles: createPublicModelTaskProfileSet(
    defaultModelTaskProfiles,
    defaultModelProviderConnections,
  ),
});
const manualRagWarmupOnStart = process.env.NIO_MANUAL_RAG_WARMUP_ON_START !== "false";

const gptSoVitsWarmupOnStart = process.env.NIO_GPT_SOVITS_WARMUP_ON_START !== "false";

const benchmarkExternalModelRequestLimitHeader = "x-nio-benchmark-external-model-request-limit";
const llmResponseCache = new Map();
const manualRagMaxTopK = 8;
const structuredAgentTasks = Object.freeze({
  b2_goal_formation: "GoalEnvelopeInput",
  b2_task_planning: "TaskPlanInput",
  b2_response_synthesis: "AgentResponseInput",
  b3_turn_relation: "TurnRelationResult",
  b3_vehicle_knowledge_planning: "KnowledgePlanningResult",
  b3_vehicle_knowledge_synthesis: "KnowledgeAnswerDraft",
  b3_recovery_proposal: "RecoveryProposal",
});
const KNOWLEDGE_ANSWER_DRAFT_FIELDS = Object.freeze([
  "outcomeStatus", "supportStatus", "answer", "limitations", "degraded",
]);
const KNOWLEDGE_ANSWER_SERVER_OWNED_FIELDS = new Set([
  "delegationId", "runId", "evidenceRefs", "vehicleStateRefs", "safetyAssessmentRef",
  "model", "provider", "durationMs",
]);

const cabinStructuredTasks = Object.freeze(new Set([
  "b2_response_synthesis",
]));

function modelTaskForStructuredAgent(task) {
  if (task === "b3_vehicle_knowledge_synthesis") return "knowledge_answer";
  return cabinStructuredTasks.has(task) ? "cabin_response" : "orchestrator_plan";
}

const benchmarkFaultTaskById = Object.freeze({
  "goal-formation-timeout": "b2_goal_formation",
  "task-planning-timeout": "b2_task_planning",
  "weather-timeout": "conversation_general",
});

export function resolveBenchmarkFaultRequest(body, {
  enabled = process.env.NIO_DEV_BENCHMARK_FAULTS === "true",
  boundary,
} = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Object.hasOwn(body, "benchmarkFaultId")) return null;
  const selected = resolveBenchmarkFaultProfile(body.benchmarkFaultId, { enabled });
  if (boundary === "manual-rag") {
    return selected.target === "manual-rag" ? selected : null;
  }
  if (boundary !== "local-llm") throw new TypeError("unknown benchmark fault boundary");
  if (selected.id === "weather-timeout" && !shouldFetchWeatherData(body)) return null;
  return benchmarkFaultTaskById[selected.id] === body.task ? selected : null;
}

export function buildBenchmarkModelError(profile) {
  if (!profile || profile.target !== "structured-model") {
    throw new TypeError("structured benchmark fault profile is required");
  }
  return Object.freeze({
    stage: profile.stage,
    code: profile.code,
    retryable: profile.retryable,
    simulated: true,
  });
}

function benchmarkFaultTelemetry(profile) {
  return {
    benchmarkFaultId: profile.id,
    stage: profile.stage,
    target: profile.target,
    code: profile.code,
    retryable: profile.retryable,
    simulated: true,
  };
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function hasOwnValue(object, key) {
  return object && Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined && object[key] !== null;
}

function hasAnyExternalDataMarker(body) {
  const parsed = body.parsedCommand || {};
  const slots = parsed.slots || {};
  return (
    body.requiresExternalData === true
    || parsed.requiresExternalData === true
    || slots.requiresExternalData === true
    || hasOwnValue(body, "externalDataType")
    || hasOwnValue(parsed, "externalDataType")
    || hasOwnValue(slots, "externalDataType")
    || hasOwnValue(body, "weatherData")
    || hasOwnValue(body, "externalData")
  );
}

function isVehicleControlIntent(intent) {
  return [
    "body.window.setPosition",
    "body.tailgate.open",
    "seat.driver.setBackrestAngle",
    "cabin.climate.setPreset",
    "energy.findSwapStation",
    "navigation.planRoute",
  ].includes(intent);
}

function isLlmResponseCacheEligible(body) {
  const parsed = body.parsedCommand || {};
  const intent = parsed.intent || "";
  const route = resolveConversationRoute("", parsed);
  return (
    llmResponseCacheSize > 0
    && llmResponseCacheTtlMs > 0
    && (body.task === "conversation_general" || intent === "conversation.general")
    && route.isVehicleKnowledge
    && body.task !== "safety_explain"
    && body.task !== "planning"
    && intent !== "safety.reject"
    && !isVehicleControlIntent(intent)
    && !hasAnyExternalDataMarker(body)
  );
}

function pruneExpiredLlmResponseCache(now = Date.now()) {
  for (const [key, entry] of llmResponseCache) {
    if (entry.expiresAt <= now) llmResponseCache.delete(key);
  }
}

function getLlmResponseCacheEntry(key, now = Date.now()) {
  if (llmResponseCacheSize <= 0 || llmResponseCacheTtlMs <= 0) return null;
  const entry = llmResponseCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    llmResponseCache.delete(key);
    return null;
  }
  llmResponseCache.delete(key);
  llmResponseCache.set(key, entry);
  return entry;
}

function setLlmResponseCacheEntry(key, responseBody, now = Date.now()) {
  if (llmResponseCacheSize <= 0 || llmResponseCacheTtlMs <= 0) return;
  pruneExpiredLlmResponseCache(now);
  llmResponseCache.set(key, {
    responseBody: JSON.parse(JSON.stringify(responseBody)),
    expiresAt: now + llmResponseCacheTtlMs,
  });
  while (llmResponseCache.size > llmResponseCacheSize) {
    const oldestKey = llmResponseCache.keys().next().value;
    llmResponseCache.delete(oldestKey);
  }
}

export function buildLlmResponseCacheKey({
  provider,
  model,
  promptStyle,
  conversationOutputMode,
  prompt,
}) {
  return JSON.stringify({
    provider,
    model,
    promptStyle,
    conversationOutputMode,
    prompt,
  });
}

function buildLlmCacheTelemetry(entry, startedAt, promptChars) {
  const cachedTelemetry = entry.responseBody.telemetry || {};
  return {
    ...cachedTelemetry,
    provider: cachedTelemetry.provider || "unknown",
    model: cachedTelemetry.model || "unknown",
    cachedProvider: cachedTelemetry.provider || "unknown",
    cachedModel: cachedTelemetry.model || "unknown",
    cacheHit: true,
    cacheEligible: true,
    cacheType: "llm-response",
    cacheSize: llmResponseCache.size,
    durationMs: Date.now() - startedAt,
    promptChars,
    promptStyle: llmPromptStyle,
    planningSummaryMode: llmPlanningSummaryMode,
    ollamaDurations: {},
    degraded: false,
    mocked: false,
    externalModelRequestCount: 0,
  };
}

function normalizeWeatherUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const fields = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens"];
  const normalized = {};
  for (const field of fields) {
    const value = usage[field];
    normalized[field] = typeof value === "number"
      && Number.isSafeInteger(value)
      && value >= 0
      ? value
      : null;
  }
  normalized.unavailableReason = fields.some((field) => normalized[field] === null)
    ? "provider-usage-unavailable"
    : null;
  return normalized;
}

function normalizeWeatherOllamaDurations(durations) {
  if (!durations || typeof durations !== "object" || Array.isArray(durations)) return {};
  const fields = [
    "total_duration_ms",
    "load_duration_ms",
    "prompt_eval_duration_ms",
    "eval_duration_ms",
    "prompt_eval_count",
    "eval_count",
  ];
  return Object.fromEntries(fields.flatMap((field) => {
    const value = durations[field];
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? [[field, Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)]]
      : [];
  }));
}

function normalizeProviderKeepAlive(providerId, value) {
  if (providerId !== "ollama" || typeof value !== "string") return "unavailable";
  const normalized = value.trim();
  return /^(?:-?\d+(?:\.\d+)?(?:ns|us|ms|s|m|h)?|0)$/.test(normalized)
    ? normalized
    : "unavailable";
}

function normalizeWeatherFinishReason(reason) {
  return ["stop", "length", "content_filter", "tool_calls"].includes(reason)
    ? reason
    : null;
}

async function composeWeatherResponse(weatherData, query, {
  registry = defaultModelProviderRegistry,
  requestId = "llm-text",
  task = "planning",
  signal,
  externalModelRequestLimit = null,
} = {}) {
  const startedAt = Date.now();
  const factPack = buildWeatherFactPack(weatherData, query);
  const prompt = buildWeatherComposerPrompt(query, factPack);
  let generated;
  let externalModelRequestCount = 0;
  let composerOutput = { response: "", answerClaims: null, structured: false };
  let grounding = { status: "fallback", reasonCodes: [], unsupportedCount: 0 };
  let fallback = false;
  let fallbackReason = "";
  const taskProvider = registry.providerFor("cabin_response");
  const generationProvider = taskProvider.id;
  const generationModel = taskProvider.model;
  try {
    generated = await callTextProviderGenerate({
      body: { requestId, task },
      prompt,
      generationProfile: "weather-composer",
      registry,
      signal,
      externalModelRequestLimit,
    });
    externalModelRequestCount = boundExternalModelRequestCount(
      generated?.externalModelRequestCount,
    );
    throwIfAborted(signal);
    composerOutput = normalizeWeatherComposerOutput({ response: generated.text });
    const claimsForGrounding = Array.isArray(composerOutput.answerClaims) && composerOutput.answerClaims.length
      ? composerOutput.answerClaims
      : deriveWeatherAnswerClaimsFromText(composerOutput.response, factPack);
    const answerClaimsStatusSource = Array.isArray(composerOutput.answerClaims) && composerOutput.answerClaims.length
      ? "model"
      : claimsForGrounding.length ? "derived-from-text" : "absent";
    const validation = validateWeatherComposedAnswer(composerOutput.response, factPack, {
      answerClaims: claimsForGrounding.length ? claimsForGrounding : null,
    });
    if (!validation.ok) {
      fallback = true;
      const reasonCodes = normalizeWeatherGroundingReasons(validation.unsupported);
      fallbackReason = reasonCodes[0] || "unsupported-weather-claim";
      grounding = {
        status: "rejected",
        reasonCodes,
        unsupportedCount: Math.min(validation.unsupported.length, 64),
        answerClaimsStatus: answerClaimsStatusSource === "absent" ? "absent" : "rejected",
        answerClaimsSource: answerClaimsStatusSource,
      };
    } else {
      grounding = {
        status: "grounded",
        reasonCodes: [],
        unsupportedCount: 0,
        answerClaimsStatus: answerClaimsStatusSource === "absent" ? "absent" : "validated",
        answerClaimsSource: answerClaimsStatusSource,
      };
    }
    composerOutput.answerClaims = claimsForGrounding.length ? claimsForGrounding : composerOutput.answerClaims;
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    externalModelRequestCount = boundExternalModelRequestCount(
      error?.externalModelRequestCount,
    );
    fallback = true;
    fallbackReason = normalizeTextGenerationReason(error);
    grounding = { status: "error", reasonCodes: [], unsupportedCount: 0 };
  }
  return {
    summary: fallback ? weatherComposerFallback(weatherData, query, fallbackReason, factPack) : composerOutput.response.trim(),
    model: "weather-response-composer",
    prompt,
    factPack,
    telemetry: {
      runtime: "local-agent-server",
      modelType: "weather-response-composer",
      provider: generationProvider,
      model: generationModel,
      generationProvider,
      generationModel,
      mocked: false,
      degraded: fallback,
      fallback,
      reason: fallback ? fallbackReason : "weather-composer-grounded",
      ...(fallbackReason ? { fallbackReason } : {}),
      grounding,
      composerOutputFormat: composerOutput.structured
        ? "json-with-answer-claims"
        : Array.isArray(composerOutput.answerClaims) && composerOutput.answerClaims.length
          ? "text-derived-answer-claims"
          : "text",
      weatherAdvicePolicyId: WEATHER_ADVICE_POLICY.id,
      weatherAdviceContext: factPack.adviceContext,
      weatherComparisonGroundingPolicyId: WEATHER_COMPARISON_GROUNDING_POLICY.id,
      externalDataProvider: "open-meteo",
      cacheHit: false,
      cacheEligible: false,
      durationMs: Number.isFinite(generated?.durationMs) && generated.durationMs >= 0
        ? Math.min(Math.floor(generated.durationMs), 86_400_000)
        : Math.min(Date.now() - startedAt, 86_400_000),
      finishReason: normalizeWeatherFinishReason(generated?.finishReason ?? generated?.done_reason),
      usage: normalizeWeatherUsage(generated?.usage),
      ollamaDurations: normalizeWeatherOllamaDurations(
        generated?.providerTelemetry?.ollamaDurations
        || generated?._telemetry?.ollamaDurations,
      ),
      externalModelRequestCount,
    },
  };
}

function mockLlmSummary(body) {
  const parsed = body.parsedCommand || {};
  const intent = parsed.intent || "unknown";
  const rawText = String(body.rawText || parsed.rawText || body.prompt || "").trim();
  const route = resolveConversationRoute("", parsed);
  const slots = parsed.slots || {};
  const isConversation = body.task === "conversation_general" || intent === "conversation.general";
  const isSafety = body.task === "safety_explain" || intent === "safety.reject";
  let summary;
  if (isConversation) {
    summary = Array.isArray(body.manualEvidence) && body.manualEvidence.length
      ? buildManualEvidenceReply(body.manualEvidence, body.fallbackReason)
      : buildConversationBoundaryReply(rawText, route, {
      requiresExternalData: route.requiresExternalData,
      externalDataType: route.externalDataType,
      needsClarification: slots.needsClarification,
      clarification: slots.clarification,
      weatherData: body.weatherData,
      reason: body.fallbackReason || "本地大模型不可用，使用主题边界回复。",
      });
  } else if (isSafety) {
    summary = "本地大模型解释：该指令涉及关键安全能力，车端安全网关已优先拦截，并提供低风险替代方案。";
  } else {
    summary = `本地大模型规划：已基于 ${intent} 和本地工具结果生成 HMI 安全摘要，执行仍以车端工具和安全网关为准。`;
  }

  return {
    summary,
    recommendations: isConversation
      ? body.weatherData
        ? ["基于 Open-Meteo 实时天气回答", "不伪造 POI、路线、路况或补能信息"]
        : conversationRecommendations(route)
      : isSafety
      ? ["保留碰撞、车道和疲劳提醒", "允许降低普通提示音量"]
      : ["优先使用车端工具结果", "云端接口后续可替换为真实 LLM"],
  };
}

function buildManualEvidenceReply(evidence, reason = "") {
  const entries = evidence.slice(0, 2).map((item) => {
    return `${formatManualCitationForDisplay(item)}指出：${item.excerpt || "未提供可引用摘录"}`;
  });
  return `模型服务暂不可用，以下仅转述已检索到的手册证据，不补充未引用的操作步骤或限制：${entries.join("；")}。${reason ? `降级原因：${reason}` : ""}`;
}

function buildConversationBoundaryReply(rawText, routeOrTopic, options = {}) {
  return buildConversationBoundaryResponse(rawText, routeOrTopic, {
    ...options,
    formatWeatherSummary,
    buildVehicleKnowledgeFallback,
    buildGeneralQaFallback,
  });
}

function buildGeneralQaFallback(rawText = "", reason = "") {
  const text = String(rawText || "").trim();
  const reasonText = reason ? `降级原因：${reason}` : "";
  const degradedNote = `当前本地大模型不可用，回答会更简略。${reasonText}`;

  if (/实时|今天|现在|最新|联网|上网|网页|网上|搜索|查一下|新闻|政策|价格|报价|附近|周边|离我|定位|路线|导航|路况|拥堵|车辆状态|车况|胎压|电量|里程|故障|诊断|维修|保养|法规|年检|保险|完整手册|用户手册|说明书/.test(text)) {
    return `这个问题可能需要实时数据、附近地点、真实车辆状态、完整手册步骤、维修诊断或法规信息；当前还没有接入对应数据，所以我不能编造结论。你可以换成通用原理或非实时建议来问，我可以先给思路。${degradedNote}`;
  }
  if (/为什么|为啥|为何/.test(text)) {
    return `常见原因可以先从环境条件、使用方式、系统限制和个体差异几方面排查；先看最直接的触发因素，再看是否有长期习惯或外部条件影响。这个回答是通用分析框架，适合先帮你缩小方向。${degradedNote}`;
  }
  if (/如何|怎么|怎样|建议|怎么办/.test(text)) {
    return `可以先从低风险、容易执行的做法开始：确认目标，避开明显风险，再选择一两个最容易坚持的动作试行。如果涉及健康、安全或专业判断，建议把场景说具体一点，我再按通用原则帮你拆解。${degradedNote}`;
  }
  if (/是什么|什么是|解释|讲讲|介绍/.test(text)) {
    return `简单说，可以先把它理解为一个由定义、作用、适用场景和限制组成的问题。你可以告诉我想听原理、例子还是利弊，我会按那个方向继续展开。${degradedNote}`;
  }
  return `我可以先给通用思路，但还需要你补充想问的方向，比如原因、做法、利弊或例子。涉及实时天气、附近地点、真实车辆状态、完整手册步骤、维修诊断或法规时，我会明确说明未接入对应数据。${degradedNote}`;
}

function conversationRecommendations(routeOrTopic, externalDataType = "") {
  const route = typeof routeOrTopic === "object" && routeOrTopic
    ? routeOrTopic
    : {
        topic: routeOrTopic,
        externalDataType,
        isWeather: routeOrTopic === "weather_query" || externalDataType === "weather",
        isPoi: routeOrTopic === "food_recommendation" || externalDataType === "poi",
        isWebSearch: routeOrTopic === "web_search" || externalDataType === "web-search",
        isVehicleKnowledge: routeOrTopic === "vehicle_knowledge",
      };
  if (route.isWeather) return ["不编造天气、气温或预警", "接入天气 adapter 后补充实时结果"];
  if (route.isPoi) return ["不编造真实店名、距离、评分或营业状态", "接入地图 / POI 后补充真实推荐"];
  if (route.isWebSearch) return ["不编造联网事实、来源或时间", "接入云端搜索 adapter 后补充带来源的结果"];
  if (route.isVehicleKnowledge) return vehicleKnowledgeRecommendations();
  return ["保持开放对话边界", "涉及实时数据时说明未接入"];
}

function formatOllamaError(error, context) {
  if (error.name === "AbortError") {
    return `${context} timeout after ${error.timeoutMs}ms; Ollama may be starting, loading the model, or busy`;
  }
  if (error.cause?.code === "ECONNREFUSED") {
    return `${context} connection refused at ${ollamaUrl}; is Ollama running?`;
  }
  return `${context} failed: ${error.message}`;
}

async function checkOllamaHealth(timeoutMs = ollamaHealthTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await fetch(new URL("/api/tags", ollamaUrl), {
      method: "GET",
      signal: controller.signal,
    });
    if (!result.ok) {
      throw new Error(`HTTP ${result.status}`);
    }

    const data = await result.json();
    const models = Array.isArray(data.models) ? data.models.map((item) => item.name).filter(Boolean) : [];
    return { ok: true, models };
  } catch (error) {
    error.timeoutMs = timeoutMs;
    throw new Error(formatOllamaError(error, "Ollama health check"));
  } finally {
    clearTimeout(timeout);
  }
}

async function callOllamaGenerate({
  model,
  prompt,
  system,
  timeoutMs,
  format,
  options,
  think,
  signal,
  fetchImpl,
}) {
  const client = fetchImpl
    ? createOllamaGenerateClient({ baseUrl: ollamaUrl, keepAlive: ollamaKeepAlive, fetchImpl })
    : ollamaGenerateClient;
  const generated = await client.generate({ model, prompt, system, timeoutMs, format, options, think, signal });
  return {
    response: generated.text,
    done_reason: generated.finishReason,
    prompt_eval_count: generated.promptTokens,
    eval_count: generated.outputTokens,
    _telemetry: {
      durationMs: generated.durationMs,
      ...generated.providerTelemetry,
    },
  };
}

// Non-business startup transport warmup. Runtime handlers must route model
// generation through the task registry instead of reusing this raw helper.
async function warmOllamaModels() {
  try {
    const health = await checkOllamaHealth();
    const expectedModels = Array.from(new Set(
      Object.values(defaultModelTaskProfiles).flatMap((profile) => [
        ...(profile.provider === "ollama" ? [profile.model] : []),
        ...(profile.fallback?.provider === "ollama" ? [profile.fallback.model] : []),
      ]),
    ));
    const missingModels = expectedModels.filter((model) => !health.models.includes(model));
    if (missingModels.length) {
      console.warn(`Ollama is reachable, but these configured models were not listed: ${missingModels.join(", ")}`);
    }

    for (const model of expectedModels) {
      try {
        const semanticWarmup = buildVehicleSluStartupWarmupRequest(model);
        await callOllamaGenerate({
          model,
          prompt: semanticWarmup?.prompt || ollamaWarmupPrompt,
          ...(semanticWarmup ? { system: VEHICLE_SLU_COMPACT_SYSTEM } : {}),
          timeoutMs: ollamaWarmupTimeoutMs,
          ...(semanticWarmup ? { format: VEHICLE_SLU_COMPACT_OUTPUT_FORMAT } : {}),
          options: { num_predict: 1, temperature: 0, ...(semanticWarmup ? { num_ctx: 4096 } : {}) },
          think: false,
        });
      } catch (error) {
        console.warn(`Ollama warmup failed for ${model}: ${error.message}`);
      }
    }
    console.log(`Ollama warmup requested for: ${expectedModels.join(", ")}`);
  } catch (error) {
    console.warn(`Ollama warmup skipped: ${error.message}`);
  }
}

function buildVehicleSluStartupWarmupRequest(model) {
  const profile = defaultModelTaskProfiles.vehicle_slu;
  const usesConfiguredSemanticModel = [profile.model, profile.fallback?.model]
    .some((candidate) => candidate === model);
  if (!usesConfiguredSemanticModel || !isVehicleSluCompactModel({ provider: "ollama", model })) return null;
  return {
    prompt: buildVehicleSluCompactV9Prompt({ text: "你好" }),
    system: VEHICLE_SLU_COMPACT_SYSTEM,
  };
}

async function warmManualRagRuntime() {
  try {
    const telemetry = await warmReadyManualVectorIndexes();
    for (const corpus of telemetry.corpora) {
      const details = corpus.status === "ready"
        ? `${corpus.chunkCount} chunks / ${corpus.generatedRows} embeddings`
        : corpus.reason || "no artifacts";
      const logger = corpus.status === "failed" ? console.warn : console.log;
      logger(`Manual RAG index warmup ${corpus.status} for ${corpus.corpusId} in ${corpus.durationMs}ms (${details})`);
    }
    if (telemetry.status !== "ready") return { status: "failed", durationMs: telemetry.durationMs };
    const embeddingWarmup = await warmManualEmbeddingModel();
    console.log(`Manual RAG embedding warmup ready in ${embeddingWarmup.durationMs}ms`);
    return embeddingWarmup;
  } catch (error) {
    console.warn(`Manual RAG index warmup skipped: ${error.message}`);
    return { status: "failed", durationMs: 0 };
  }
}

const defaultRuntimeWarmupCoordinator = createRuntimeWarmupCoordinator({
  warmManualRag: warmManualRagRuntime,
  warmGptSoVits: () => runGptSoVitsStartupWarmup({ endpoint: gptSoVitsEndpoint }),
});

let ollamaReadinessCache = null;

async function readOllamaDemoReadiness() {
  const now = Date.now();
  if (ollamaReadinessCache && ollamaReadinessCache.expiresAt > now) {
    return ollamaReadinessCache.value;
  }
  const startedAt = now;
  let value;
  try {
    await checkOllamaHealth();
    value = Object.freeze({ ready: true, durationMs: Date.now() - startedAt });
  } catch {
    value = Object.freeze({ ready: false, durationMs: Date.now() - startedAt });
  }
  ollamaReadinessCache = Object.freeze({
    expiresAt: Date.now() + 5_000,
    value,
  });
  return value;
}

async function resolveDefaultDemoReadiness({
  modelProviderRegistry = defaultModelProviderRegistry,
  modelTaskProfiles = defaultModelTaskProfiles,
  runtimeWarmupCoordinator = defaultRuntimeWarmupCoordinator,
  localVoiceCoordinator,
} = {}) {
  const [ollamaHealth] = await Promise.all([readOllamaDemoReadiness()]);
  const vehicleAssetReady = [
    path.join(root, "assets/models/nio-es7/nio-es7-animated.glb"),
    path.join(root, "assets/models/nio-es7/nio-es7-component-manifest.json"),
  ].every((target) => fs.existsSync(target));
  return buildDemoReadiness({
    now: Date.now(),
    startedAt: serverProcessStartedAt,
    publicProfiles: projectPublicModelTaskProfileSet(modelProviderRegistry.publicProfiles),
    taskProfiles: modelTaskProfiles,
    warmupSnapshot: runtimeWarmupCoordinator.snapshot?.(),
    ollamaHealth,
    hmiReady: fs.existsSync(path.join(root, "index.html")),
    vehicleAssetReady,
    deterministicRuntimeReady: true,
    localVoiceReadiness: localVoiceCoordinator?.getReadiness?.(),
  });
}

function buildVerboseLlmPrompt(body) {
  if (body.task === "conversation_general" || body.parsedCommand?.intent === "conversation.general") {
    const rawText = String(body.rawText || body.parsedCommand?.rawText || body.prompt || "").trim();
    const route = resolveConversationRoute("", body.parsedCommand || {});
    const vehicleKnowledgeContext = route.isVehicleKnowledge ? buildVehicleKnowledgeContext(rawText) : "";
    const weatherData = body.weatherData;
    const manualEvidenceContext = buildManualEvidenceContext(body.manualEvidence);
    return [
      "你是蔚来车载本地智能助手，正在车内和用户自然对话。",
      "请用简洁、自然、适合语音播报的中文回答，控制在 1 到 3 句话，优先直接回答问题。",
      weatherData
        ? "如果用户问天气：已有 Open-Meteo 天气数据，必须以该数据回答；不要再说未接入实时天气，也不要编造数据中没有的天气、气温或预警。"
        : "如果用户问天气：本次没有拿到 weatherData 时，才说明天气 adapter 暂不可用；不要编造天气、气温或预警。",
      "车内/座舱空气质量属于车辆知识；外部/城市/今天空气质量属于天气或实时数据。",
      "如果用户问美食、餐厅或附近推荐：当前没有接入真实地图、POI、定位和营业状态，不要编造具体店名、距离、评分或地址。",
      "如果用户问最新信息、新闻、政策、价格、网页搜索或需要联网核验的问题：当前没有接入云端联网搜索，不要编造网页事实、来源或时间。",
      route.isVehicleKnowledge
        ? "如果用户问车辆知识：优先基于下方 ES8 官方用户手册证据回答；未提供相关证据时不得编造具体操作、安全限制、故障处理或维修步骤。"
        : "如果用户问车辆知识：当前知识范围为 ES8 官方用户手册；未提供相关证据时只能给一般说明，不能编造手册步骤。",
      "可以给出口味方向、选择建议、询问偏好，或建议接入地图后再给真实店铺。",
      "不要声称已经执行车控动作；车控动作必须由 Vehicle Tools 执行。",
      manualEvidenceContext ? "本次已提供真实用户手册证据：只能基于与用户问题直接相关的证据回答，不必复述全部命中；不得补充未出现的步骤或限制；正文尽量不超过 120 个汉字，回答末尾必须保留页码引用。" : "涉及用户手册操作、安全限制、故障处理或保养的问题，如未提供手册证据，必须明确说明不能编造手册步骤。",
      vehicleKnowledgeContext ? `车辆知识上下文：\n${vehicleKnowledgeContext}` : "",
      manualEvidenceContext ? `用户手册证据：\n${manualEvidenceContext}` : "",
      weatherData ? `Open-Meteo 天气数据：\n${JSON.stringify(weatherData)}` : "",
      body.prompt ? `用户提示：${body.prompt}` : "",
      body.rawText ? `用户原文：${body.rawText}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "你是蔚来车载本地 HMI 规划与安全解释模型。",
    "请用简洁中文生成一段面向车内用户的安全摘要，强调执行以车端工具和安全网关为准。",
    "不要编造已执行的车控结果。",
    body.prompt ? `用户提示：${body.prompt}` : "",
    `任务：${body.task || "planning"}`,
    `语义解析：${JSON.stringify(body.parsedCommand || {})}`,
    `工具结果：${JSON.stringify(body.toolResult || {})}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCompactLlmPrompt(body) {
  if (body.task === "conversation_general" || body.parsedCommand?.intent === "conversation.general") {
    const rawText = String(body.rawText || body.parsedCommand?.rawText || body.prompt || "").trim();
    const route = resolveConversationRoute("", body.parsedCommand || {});
    const vehicleKnowledgeContext = route.isVehicleKnowledge ? buildVehicleKnowledgeContext(rawText) : "";
    const weatherData = body.weatherData;
    const manualEvidenceContext = buildManualEvidenceContext(body.manualEvidence);
    return [
      "角色：蔚来车载本地助手。用简短自然中文回答。",
      weatherData
        ? "天气：只能基于 weatherData 回答，不补编数据外天气/预警。"
        : "天气：未提供 weatherData 时不得编造天气、气温或预警。",
      "POI/联网：不得编造餐厅、距离、评分、新闻、网页事实或来源。",
      "车辆知识：只基于已接入种子源/上下文做一般说明；非完整手册，操作/安全/维修/法规需提示边界。",
      manualEvidenceContext ? "手册：仅按 manualEvidence 回答，不能补编步骤；保留真实页码引用。" : "手册：无 evidence 时不得编造操作、安全、故障或保养步骤。",
      "车控：不得声称已执行，执行只能来自 Vehicle Tools；摘要以 Safety Gateway/工具结果为准。",
      vehicleKnowledgeContext ? `车辆知识上下文：\n${vehicleKnowledgeContext}` : "",
      manualEvidenceContext ? `manualEvidence：\n${manualEvidenceContext}` : "",
      weatherData ? `weatherData：\n${JSON.stringify(weatherData)}` : "",
      body.prompt ? `用户提示：${body.prompt}` : "",
      `用户原文：${body.rawText || rawText}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "角色：蔚来车载 HMI 规划摘要模型。用一句简短中文给用户安全摘要。",
    "只基于 parsedCommand/toolResult；不编造车控结果；以 Safety Gateway 和工具结果为准。",
    body.prompt ? `用户提示：${body.prompt}` : "",
    `任务：${body.task || "planning"}`,
    `parsedCommand：${JSON.stringify(body.parsedCommand || {})}`,
    `toolResult：${JSON.stringify(body.toolResult || {})}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildLlmPrompt(body) {
  return llmPromptStyle === "compact" ? buildCompactLlmPrompt(body) : buildVerboseLlmPrompt(body);
}

export function buildStructuredAgentPrompt(body) {
  if (body.task === "b3_turn_relation") {
    return buildTurnRelationPrompt({
      currentGoalSummary: body.currentGoalSummary,
      rawText: body.rawText,
    });
  }
  if (body.task === "b2_goal_formation") {
    return buildGoalFormationPrompt({
      runId: body.runId,
      rawText: body.rawText,
      parsedCommand: body.parsedCommand,
      context: body.context,
    });
  }
  if (body.task === "b2_task_planning") {
    return buildTaskPlanningPrompt({
      goalEnvelope: body.goalEnvelope,
      catalogProjection: body.capabilityCatalog,
      semanticAuthority: body.semanticAuthority,
    });
  }
  if (body.task === "b3_vehicle_knowledge_planning") {
    return buildVehicleKnowledgePlanningPrompt({
      delegation: body.delegation,
      catalogProjection: body.capabilityCatalog,
    });
  }
  if (body.task === "b3_vehicle_knowledge_synthesis") {
    return buildVehicleKnowledgeSynthesisPrompt({
      delegation: body.delegation,
      subplan: body.subplan,
      executionFacts: body.executionFacts,
    });
  }
  if (body.task === "b3_recovery_proposal") {
    const failure = createCapabilityFailure(body.failure);
    const availableActions = normalizeRecoveryAvailableActions(body.availableActions);
    if (availableActions.length === 0) {
      throw new TypeError("recovery proposal requires at least one available action");
    }
    return buildRecoveryProposalPrompt({
      failure,
      availableActions,
    });
  }
  return buildResponseSynthesisPrompt({
    goalEnvelope: body.goalEnvelope,
    taskPlan: body.taskPlan,
    executionFacts: body.executionFacts,
    knowledgeDelegation: body.knowledgeDelegation,
    knowledgeSubplan: body.knowledgeSubplan,
    knowledgeResult: body.knowledgeResult,
  });
}

function resolveStructuredAgentTimeoutMs(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : 90_000;
}

function resolveOptionalWatchdogMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const watchdogMs = Math.floor(Number(value));
  return Number.isFinite(watchdogMs) && watchdogMs > 0
    ? watchdogMs
    : null;
}

function buildStructuredAgentJsonSchema(body) {
  if (body.task === "b3_turn_relation") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["relation", "reasonCode", "requiresClarification"],
      properties: {
        relation: {
          type: "string",
          enum: ["new-goal", "follow-up", "correction"],
        },
        reasonCode: { type: "string", minLength: 1, maxLength: 80 },
        requiresClarification: { type: "boolean" },
      },
    };
  }
  if (body.task === "b3_recovery_proposal") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["action", "reasonCode"],
      properties: {
        action: {
          type: "string",
          enum: normalizeRecoveryAvailableActions(body.availableActions),
        },
        reasonCode: { type: "string", minLength: 1, maxLength: 80 },
      },
    };
  }
  if (body.task === "b2_goal_formation") {
    const trustedPlanningContextRefs = buildTrustedPlanningContextRefs(body.parsedCommand);
    const goalAuthority = resolveConversationPlanningGoalAuthority(body.parsedCommand, body.rawText);
    return {
      type: "object",
      additionalProperties: false,
      required: [
        "goalId", "runId", "objective", "interactionType", "domain", "constraints",
        "contextRefs", "requiredClarifications", "readyForPlanning", "model", "provider",
        "confidenceStrength",
      ],
      properties: {
        goalId: nonEmptyStringSchema(),
        runId: typeof body.runId === "string"
          ? { type: "string", const: body.runId }
          : nonEmptyStringSchema(),
        objective: goalAuthority
          ? { type: "string", const: goalAuthority.objective }
          : nonEmptyStringSchema(),
        interactionType: goalAuthority
          ? { type: "string", const: goalAuthority.interactionType }
          : nonEmptyStringSchema(),
        domain: goalAuthority
          ? { type: "string", const: goalAuthority.domain }
          : nonEmptyStringSchema(),
        constraints: stringArraySchema(),
        contextRefs: trustedContextRefsSchema(trustedPlanningContextRefs),
        requiredClarifications: stringArraySchema(),
        readyForPlanning: { type: "boolean" },
        model: nonEmptyStringSchema(),
        provider: nonEmptyStringSchema(),
        confidenceStrength: nonEmptyStringSchema(),
      },
    };
  }
  if (body.task === "b2_task_planning") {
    const readOnlyGoal = body.goalEnvelope?.interactionType !== "command";
    const readOnlyExternalInformationGoal = readOnlyGoal
      && body.goalEnvelope?.domain === "external-information";
    const capabilities = resolveEligibleTaskPlanningCapabilities({
      goalEnvelope: body.goalEnvelope,
      catalogProjection: body.capabilityCatalog,
      semanticAuthority: body.semanticAuthority,
    });
    const capabilityIds = capabilities.map((capability) => capability?.id).filter(Boolean);
    const vehicleSluFrameAuthority = findVehicleSluFrameAuthority(body.goalEnvelope?.contextRefs);
    const knowledgeDelegationAuthority = resolveTrustedKnowledgeDelegationAuthority(
      body.goalEnvelope,
    );
    const stepSchemas = capabilities.map((capability) => ({
      type: "object",
      additionalProperties: false,
      required: [
        "stepId", "capabilityId", "dependsOn", "input", "expectedOutput", "accessMode", "status",
      ],
      properties: {
        stepId: nonEmptyStringSchema(),
        capabilityId: { type: "string", const: capability.id },
        dependsOn: stringArraySchema(),
        input: bindCapabilityInputSchema(
          capability,
          vehicleSluFrameAuthority,
          knowledgeDelegationAuthority,
        ),
        expectedOutput: nonEmptyStringSchema(),
        accessMode: { type: "string", const: capability.accessMode },
        status: nonEmptyStringSchema(),
      },
    }));
    return {
      type: "object",
      additionalProperties: false,
      required: [
        "planId", "goalId", "runId", "steps", "selectedCapabilities",
        "writeActionCount", "planningSummary", "model", "provider", "status",
      ],
      properties: {
        planId: nonEmptyStringSchema(),
        goalId: typeof body.goalEnvelope?.goalId === "string"
          ? { type: "string", const: body.goalEnvelope.goalId }
          : nonEmptyStringSchema(),
        runId: typeof body.goalEnvelope?.runId === "string"
          ? { type: "string", const: body.goalEnvelope.runId }
          : nonEmptyStringSchema(),
        steps: {
          type: "array",
          ...(readOnlyExternalInformationGoal ? { minItems: 1 } : {}),
          maxItems: readOnlyExternalInformationGoal ? 1 : 6,
          items: { oneOf: stepSchemas },
        },
        selectedCapabilities: {
          type: "array",
          ...(readOnlyExternalInformationGoal ? { minItems: 1, maxItems: 1 } : {}),
          items: { type: "string", enum: capabilityIds },
        },
        writeActionCount: readOnlyGoal
          ? { type: "integer", const: 0 }
          : { type: "integer", minimum: 0, maximum: 1 },
        planningSummary: nonEmptyStringSchema(),
        model: nonEmptyStringSchema(),
        provider: nonEmptyStringSchema(),
        status: nonEmptyStringSchema(),
      },
    };
  }
  if (body.task === "b3_vehicle_knowledge_planning") {
    return buildKnowledgeSubplanSchema(body);
  }
  if (body.task === "b3_vehicle_knowledge_synthesis") {
    return buildKnowledgeAnswerDraftSchema();
  }
  const expectedStatus = resolveWriteCompletionStatus(body.taskPlan, body.executionFacts);
  return {
    type: "object",
    additionalProperties: false,
    required: ["response", "writeCompletionStatus"],
    properties: {
      response: expectedStatus === B2_WRITE_COMPLETION_STATUS.unconfirmed
        ? { type: "string", const: B2_UNCONFIRMED_WRITE_RESPONSE }
        : expectedStatus === B2_WRITE_COMPLETION_STATUS.blocked
          ? { type: "string", const: buildB2SafetyRejectedResponse(body.executionFacts) }
          : nonEmptyStringSchema(),
      writeCompletionStatus: { type: "string", const: expectedStatus },
    },
  };
}

function normalizeRecoveryAvailableActions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((action) => RECOVERY_ACTIONS.includes(action)))];
}

function buildKnowledgeSubplanSchema(body) {
  const delegation = body.delegation ?? {};
  const fixedEligibilityPlan = !isKnowledgeClarificationAllowed(delegation);
  const eligibilityTopology = new Map(
    KNOWLEDGE_ELIGIBILITY_TOPOLOGY.map((entry) => [entry.capabilityId, entry]),
  );
  const capabilities = Array.isArray(delegation.allowedCapabilities)
    ? delegation.allowedCapabilities.map(getKnowledgeCapability).filter(Boolean)
    : [];
  const stepSchemas = capabilities.map((capability) => {
    const topology = fixedEligibilityPlan ? eligibilityTopology.get(capability.id) : null;
    const inputSchema = structuredClone(capability.inputSchema);
    for (const [field, value] of Object.entries(topology?.input ?? {})) {
      inputSchema.properties[field] = {
        ...inputSchema.properties[field],
        const: value,
      };
    }
    return {
      type: "object",
      additionalProperties: false,
      required: ["stepId", "capabilityId", "dependsOn", "input", "expectedOutput", "accessMode", "status"],
      properties: {
        stepId: topology ? { type: "string", const: topology.stepId } : nonEmptyStringSchema(),
        capabilityId: { type: "string", const: capability.id },
        dependsOn: topology
          ? { type: "array", const: topology.dependsOn, items: { type: "string" } }
          : stringArraySchema(),
        input: inputSchema,
        expectedOutput: nonEmptyStringSchema(),
        accessMode: { type: "string", const: "read" },
        status: nonEmptyStringSchema(),
      },
    };
  });
  const subplan = {
    type: "object",
    additionalProperties: false,
    required: [
      "subplanId", "delegationId", "runId", "parentPlanId", "parentStepId", "steps",
      "selectedCapabilities", "planningSummary", "model", "provider", "status",
    ],
    properties: {
      subplanId: nonEmptyStringSchema(),
      delegationId: { type: "string", const: delegation.delegationId },
      runId: { type: "string", const: delegation.runId },
      parentPlanId: { type: "string", const: delegation.parentPlanId },
      parentStepId: { type: "string", const: delegation.parentStepId },
      steps: {
        type: "array",
        minItems: fixedEligibilityPlan ? 4 : 1,
        maxItems: 4,
        items: fixedEligibilityPlan
          ? KNOWLEDGE_ELIGIBILITY_TOPOLOGY.map(({ capabilityId }) => (
            stepSchemas.find((schema) => schema.properties.capabilityId.const === capabilityId)
          ))
          : { oneOf: stepSchemas },
        ...(fixedEligibilityPlan ? { additionalItems: false } : {}),
      },
      selectedCapabilities: fixedEligibilityPlan
        ? { type: "array", const: capabilities.map(({ id }) => id), items: { type: "string" } }
        : { type: "array", items: { type: "string", enum: capabilities.map(({ id }) => id) } },
      planningSummary: nonEmptyStringSchema(),
      model: nonEmptyStringSchema(),
      provider: nonEmptyStringSchema(),
      status: nonEmptyStringSchema(),
    },
  };
  const clarification = {
    type: "object",
    additionalProperties: false,
    required: ["delegationId", "runId", "outcomeStatus", "questions", "reasonCode", "model", "provider"],
    properties: {
      delegationId: { type: "string", const: delegation.delegationId },
      runId: { type: "string", const: delegation.runId },
      outcomeStatus: { type: "string", const: "clarification" },
      questions: { type: "array", minItems: 1, items: nonEmptyStringSchema() },
      reasonCode: nonEmptyStringSchema(), model: nonEmptyStringSchema(), provider: nonEmptyStringSchema(),
    },
  };
  return {
    oneOf: isKnowledgeClarificationAllowed(delegation)
      ? [subplan, clarification]
      : [subplan],
  };
}

function buildKnowledgeAnswerDraftSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["outcomeStatus", "supportStatus", "answer", "limitations", "degraded"],
    properties: {
      outcomeStatus: { type: "string", const: "answered" },
      supportStatus: { type: "string", enum: ["supported", "partial", "unsupported"] },
      answer: nonEmptyStringSchema(),
      limitations: stringArraySchema(),
      degraded: { type: "boolean" },
    },
  };
}

function nonEmptyStringSchema() {
  return { type: "string", minLength: 1 };
}

function stringArraySchema() {
  return { type: "array", items: { type: "string" } };
}

function trustedContextRefsSchema(contextRefs) {
  if (!contextRefs.length) {
    return {
      type: "array",
      maxItems: 0,
      items: { type: "object" },
    };
  }
  const [ref] = contextRefs;
  return {
    type: "array",
    minItems: 1,
    maxItems: 1,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["type", "intent", "targetZone", "percent", "provenance"],
      properties: {
        type: { type: "string", const: ref.type },
        intent: { type: "string", const: ref.intent },
        targetZone: { type: "string", const: ref.targetZone },
        percent: { type: "number", const: ref.percent },
        provenance: {
          type: "object",
          additionalProperties: false,
          required: ["targetZone", "percent"],
          properties: {
            targetZone: { type: "string", const: ref.provenance.targetZone },
            percent: { type: "string", const: ref.provenance.percent },
          },
        },
      },
    },
  };
}

function findVehicleSluFrameAuthority(contextRefs) {
  if (!Array.isArray(contextRefs)) return null;
  const frames = contextRefs.filter((ref) => ref?.type === "vehicle-slu-frame-authority");
  return frames.length === 1 ? frames[0] : null;
}

function bindCapabilityInputSchema(capability, vehicleSluFrameAuthority, knowledgeDelegationAuthority) {
  const schema = structuredClone(capability.inputSchema);
  const vehicleInput = projectVehicleSluCapabilityInput(capability.id, vehicleSluFrameAuthority);
  for (const [field, value] of Object.entries(vehicleInput || {})) {
    schema.properties[field] = { ...schema.properties[field], const: value };
  }
  if (capability.id === "manual.retrieve" && knowledgeDelegationAuthority) {
    schema.properties.query = {
      ...schema.properties.query,
      const: knowledgeDelegationAuthority.knowledgeGoal,
    };
  }
  return schema;
}

function projectVehicleSluCapabilityInput(capabilityId, frame) {
  if (!frame || frame.actionNeed !== "execute" || frame.capability !== "control") return null;
  const binding = projectVehicleWriteBinding(frame);
  return binding?.capabilityId === capabilityId ? binding.input : null;
}

function plainDataEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => plainDataEqual(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && plainDataEqual(left[key], right[key]));
}

async function callStructuredAgentGenerate({
  body,
  prompt,
  signal,
  registry,
  externalModelRequestLimit = null,
  fallbackOnly = false,
}) {
  const modelTask = modelTaskForStructuredAgent(body.task);
  const provider = registry.providerFor(modelTask);
  try {
    const generationRequest = {
      requestId: body.requestId || body.runId || body.turnId || "structured-agent",
      task: body.task,
      prompt,
      outputMode: "json-object",
      jsonSchema: buildStructuredAgentJsonSchema(body),
      generationProfile: "structured-agent",
      externalModelRequestLimit,
      signal,
    };
    const generated = fallbackOnly
      ? await registry.generateFallbackForTask(modelTask, generationRequest)
      : await registry.generateForTask(modelTask, generationRequest);
    throwIfAborted(signal);
    return generated;
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    if (isCancellationError(error) || error instanceof ModelProviderError) throw error;
    throw new ModelProviderError("Model Provider generation failed", {
      code: "provider-unavailable",
      provider: provider?.id || "unknown",
      details: { reasonCode: "provider-unavailable", retryable: true },
      cause: error,
    });
  }
}

const publicProviderFailureReasonCodes = Object.freeze(new Set([
  "provider-config-invalid",
  "provider-auth-failed",
  "provider-rate-limited",
  "provider-unavailable",
  "provider-network-error",
  "provider-response-invalid",
  "provider-schema-invalid-after-repair",
  "provider-safety-refusal",
  "provider-request-budget-exhausted",
  "generation-timeout",
  "generation-unavailable",
]));

function normalizeProviderFailureReasonCode(error) {
  const candidates = [error?.details?.reasonCode, error?.code];
  const reasonCode = candidates.find((candidate) => (
    typeof candidate === "string" && publicProviderFailureReasonCodes.has(candidate)
  ));
  return reasonCode || "provider-unavailable";
}

function normalizeTextGenerationReason(error) {
  if (error?.code === "cancelled") return "cancelled";
  return normalizeProviderFailureReasonCode(error);
}

async function callTextProviderGenerate({
  body,
  prompt,
  generationProfile,
  registry,
  signal,
  externalModelRequestLimit = null,
}) {
  const provider = registry.providerFor("cabin_response");
  try {
    const generated = await registry.generateForTask("cabin_response", {
      requestId: body.requestId || "llm-text",
      task: body.task || "planning",
      prompt,
      outputMode: "text",
      generationProfile,
      externalModelRequestLimit,
      signal,
    });
    throwIfAborted(signal);
    return generated;
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    if (isCancellationError(error) || error instanceof ModelProviderError) throw error;
    throw new ModelProviderError("Model Provider generation failed", {
      code: "provider-unavailable",
      provider: provider.id,
      details: { reasonCode: "provider-unavailable", retryable: true },
      cause: error,
    });
  }
}

function parseFirstJsonObject(text) {
  const source = String(text || "");
  const start = source.indexOf("{");
  if (start < 0) throw new SyntaxError("structured response does not contain a JSON object");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;
    const parsed = JSON.parse(source.slice(start, index + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SyntaxError("structured response must be a JSON object");
    }
    return parsed;
  }
  throw new SyntaxError("structured response contains an incomplete JSON object");
}

function getStructuredValidationDetail(body, output) {
  if (body.task === "b3_turn_relation") {
    return validateTurnRelationOutput(output)
      ? { reasonCode: "", validationSubreason: "" }
      : { reasonCode: "turn-relation-invalid", validationSubreason: "contract-invalid" };
  }
  if (body.task?.startsWith("b3_vehicle_knowledge_") && containsKnowledgeForbiddenField(output)) {
    return { reasonCode: "forbidden-output-field", validationSubreason: "forbidden-field" };
  }
  if (containsStructuredSecret(output)) {
    return { reasonCode: "forbidden-output-field", validationSubreason: "forbidden-field" };
  }
  if (body.task === "b3_recovery_proposal") {
    const fields = output && typeof output === "object" && !Array.isArray(output)
      ? Object.keys(output)
      : [];
    const availableActions = normalizeRecoveryAvailableActions(body.availableActions);
    const valid = fields.length === 2
      && fields.includes("action")
      && fields.includes("reasonCode")
      && availableActions.includes(output.action)
      && typeof output.reasonCode === "string"
      && output.reasonCode.trim().length >= 1
      && Array.from(output.reasonCode).length <= 80;
    return valid
      ? { reasonCode: "", validationSubreason: "" }
      : { reasonCode: "recovery-proposal-invalid", validationSubreason: "contract-invalid" };
  }
  if (body.task === "b3_vehicle_knowledge_planning") {
    if (body.delegation?.vehicleScope !== "nio-es8-user-manual-2026") {
      return { reasonCode: "knowledge-subplan-invalid", validationSubreason: "vehicle-scope-not-applicable" };
    }
    try {
      if (output?.outcomeStatus === "clarification") {
        if (!isKnowledgeClarificationAllowed(body.delegation)) {
          return { reasonCode: "knowledge-subplan-invalid", validationSubreason: "clarification-not-allowed" };
        }
        const clarification = createKnowledgeClarificationRequest(output);
        if (clarification.delegationId !== body.delegation?.delegationId || clarification.runId !== body.delegation?.runId) {
          return { reasonCode: "knowledge-subplan-invalid", validationSubreason: "association-invalid" };
        }
        return { reasonCode: "", validationSubreason: "" };
      }
      const subplan = createKnowledgeSubplan(output);
      const validation = validateKnowledgeSubplan(subplan, body.delegation);
      if (validation.ok) return { reasonCode: "", validationSubreason: "" };
      return {
        reasonCode: "knowledge-subplan-invalid",
        validationSubreason: knowledgeValidationSubreason(validation.errors),
      };
    } catch {
      return { reasonCode: "knowledge-subplan-invalid", validationSubreason: "contract-invalid" };
    }
  }
  if (body.task === "b3_vehicle_knowledge_synthesis") {
    if (body.delegation?.vehicleScope !== "nio-es8-user-manual-2026"
      || body.executionFacts?.outcomeStatus !== "completed") {
      return { reasonCode: "knowledge-result-invalid", validationSubreason: "execution-not-completed" };
    }
    return validateKnowledgeAnswerDraft(output);
  }
  if (body.task === "b2_goal_formation") {
    const contractErrors = validateGoalEnvelope(output);
    if (contractErrors.length) {
      return { reasonCode: "goal-contract-invalid", validationSubreason: "contract-invalid" };
    }
    if (typeof body.runId === "string" && output.runId !== body.runId) {
      return { reasonCode: "goal-contract-invalid", validationSubreason: "association-invalid" };
    }
    const trustedPlanningContextRefs = buildTrustedPlanningContextRefs(body.parsedCommand);
    if (!plainDataEqual(output.contextRefs, trustedPlanningContextRefs)) {
      return { reasonCode: "goal-contract-invalid", validationSubreason: "association-invalid" };
    }
    if (!goalClaimsNoKnowledgeAuthority(output)) {
      return { reasonCode: "goal-contract-invalid", validationSubreason: "association-invalid" };
    }
    const effectiveAuthority = resolveConversationPlanningGoalAuthority(body.parsedCommand, body.rawText);
    if (effectiveAuthority && (
      output.objective !== effectiveAuthority.objective
      || output.interactionType !== effectiveAuthority.interactionType
      || output.domain !== effectiveAuthority.domain
    )) {
      return { reasonCode: "goal-contract-invalid", validationSubreason: "association-invalid" };
    }
    return { reasonCode: "", validationSubreason: "" };
  }
  if (body.task === "b2_task_planning") {
    const allowedCapabilityIds = new Set(
      resolveEligibleTaskPlanningCapabilities({
        goalEnvelope: body.goalEnvelope,
        catalogProjection: body.capabilityCatalog,
        semanticAuthority: body.semanticAuthority,
      }).map((capability) => capability?.id).filter(Boolean),
    );
    const shapeErrors = validateTaskPlanShape(output);
    const validation = validatePlanAgainstCatalog(output, body.goalEnvelope);
    const errors = [...shapeErrors, ...validation.errors];
    const projectedIdsOnly = Array.isArray(output?.selectedCapabilities)
      && output.selectedCapabilities.every((id) => allowedCapabilityIds.has(id))
      && Array.isArray(output?.steps)
      && output.steps.every((step) => allowedCapabilityIds.has(step?.capabilityId));
    const trustedInputAssociationValid = taskPlanMatchesTrustedContext(
      output,
      body.goalEnvelope?.contextRefs,
    );
    if (projectedIdsOnly && validation.ok) {
      return trustedInputAssociationValid
        ? { reasonCode: "", validationSubreason: "" }
        : { reasonCode: "plan-contract-invalid", validationSubreason: "association-invalid" };
    }
    return {
      reasonCode: "plan-contract-invalid",
      validationSubreason: classifyPlanValidationSubreason(errors, projectedIdsOnly),
    };
  }
  if (typeof output.response !== "string" || !output.response.trim()) {
    return { reasonCode: "synthesis-response-missing", validationSubreason: "missing-required" };
  }
  const outputFields = Object.keys(output);
  if (
    outputFields.length !== 2
    || !outputFields.includes("response")
    || !outputFields.includes("writeCompletionStatus")
  ) {
    return { reasonCode: "synthesis-contract-invalid", validationSubreason: "contract-invalid" };
  }
  const expectedStatus = resolveWriteCompletionStatus(body.taskPlan, body.executionFacts);
  if (output.writeCompletionStatus !== expectedStatus) {
    return { reasonCode: "synthesis-completion-status-invalid", validationSubreason: "status-invalid" };
  }
  if (
    expectedStatus === B2_WRITE_COMPLETION_STATUS.unconfirmed
    && output.response !== B2_UNCONFIRMED_WRITE_RESPONSE
  ) {
    return { reasonCode: "synthesis-unconfirmed-write-misstated", validationSubreason: "claim-invalid" };
  }
  if (
    expectedStatus === B2_WRITE_COMPLETION_STATUS.blocked
    && output.response !== buildB2SafetyRejectedResponse(body.executionFacts)
  ) {
    return { reasonCode: "synthesis-safety-rejection-misstated", validationSubreason: "claim-invalid" };
  }
  return { reasonCode: "", validationSubreason: "" };
}

function validateTurnRelationOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const fields = Object.keys(output);
  if (fields.length !== 3
    || !["relation", "reasonCode", "requiresClarification"].every((field) => fields.includes(field))) {
    return false;
  }
  return ["new-goal", "follow-up", "correction"].includes(output.relation)
    && typeof output.reasonCode === "string"
    && Array.from(output.reasonCode).length >= 1
    && Array.from(output.reasonCode).length <= 80
    && typeof output.requiresClarification === "boolean";
}

function validateKnowledgeAnswerDraft(output) {
  if (!plainDataObject(output)) {
    return { reasonCode: "knowledge-result-invalid", validationSubreason: "contract-invalid" };
  }
  const fields = Object.keys(output);
  if (fields.some((field) => KNOWLEDGE_ANSWER_SERVER_OWNED_FIELDS.has(field))) {
    return { reasonCode: "knowledge-result-invalid", validationSubreason: "server-owned-field" };
  }
  if (fields.length !== KNOWLEDGE_ANSWER_DRAFT_FIELDS.length
    || !KNOWLEDGE_ANSWER_DRAFT_FIELDS.every((field) => fields.includes(field))) {
    return { reasonCode: "knowledge-result-invalid", validationSubreason: "contract-invalid" };
  }
  const valid = output.outcomeStatus === "answered"
    && ["supported", "partial", "unsupported"].includes(output.supportStatus)
    && typeof output.answer === "string"
    && output.answer.trim().length > 0
    && Array.isArray(output.limitations)
    && output.limitations.every((item) => typeof item === "string" && item.trim().length > 0)
    && typeof output.degraded === "boolean";
  return valid
    ? { reasonCode: "", validationSubreason: "" }
    : { reasonCode: "knowledge-result-invalid", validationSubreason: "contract-invalid" };
}

function requireServerTelemetryText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function createServerOwnedKnowledgeAnswerEnvelope({ body, draft, telemetry } = {}) {
  if (body?.delegation?.vehicleScope !== "nio-es8-user-manual-2026"
    || body?.executionFacts?.outcomeStatus !== "completed") {
    throw new TypeError("server-owned knowledge envelope requires completed ES8 execution");
  }
  const draftValidation = validateKnowledgeAnswerDraft(draft);
  if (draftValidation.reasonCode) {
    throw new TypeError(`invalid KnowledgeAnswerDraft: ${draftValidation.validationSubreason}`);
  }
  const durationMs = Number(telemetry?.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new TypeError("knowledge Provider durationMs must be non-negative");
  }
  const result = createKnowledgeAnswer({
    delegationId: body.delegation.delegationId,
    runId: body.delegation.runId,
    outcomeStatus: draft.outcomeStatus,
    supportStatus: draft.supportStatus,
    answer: draft.answer,
    evidenceRefs: structuredClone(body.executionFacts.evidenceRefs ?? []),
    vehicleStateRefs: structuredClone(body.executionFacts.vehicleStateRefs ?? []),
    safetyAssessmentRef: body.executionFacts.safetyAssessmentRef == null
      ? null
      : structuredClone(body.executionFacts.safetyAssessmentRef),
    limitations: [...draft.limitations],
    model: requireServerTelemetryText(telemetry?.model, "knowledge Provider model"),
    provider: requireServerTelemetryText(telemetry?.provider, "knowledge Provider identity"),
    durationMs,
    degraded: draft.degraded === true
      || body.executionFacts.degraded === true
      || telemetry?.fallbackActive === true
      || telemetry?.degraded === true,
  });
  const boundaryErrors = validateKnowledgeTerminalBoundary(result, body.executionFacts);
  if (boundaryErrors.length > 0) {
    throw new TypeError(`server-owned knowledge envelope invalid: ${boundaryErrors[0]}`);
  }
  if (result.delegationId !== body.delegation.delegationId
    || result.runId !== body.delegation.runId) {
    throw new TypeError("server-owned knowledge envelope association mismatch");
  }
  return result;
}

function knowledgeValidationSubreason(errors) {
  if (errors.some((error) => /association|must match delegation/.test(error))) return "association-invalid";
  if (errors.some((error) => /dependency|ancestor|earlier/.test(error))) return "dependency-invalid";
  if (errors.some((error) => /read-only|access mode/.test(error))) return "write-policy-invalid";
  if (errors.some((error) => /unknown capability|authorized/.test(error))) return "catalog-invalid";
  if (errors.some((error) => /input/.test(error))) return "input-schema-invalid";
  return "contract-invalid";
}

function getStructuredValidationFailure(body, output) {
  return getStructuredValidationDetail(body, output).reasonCode;
}

function classifyPlanValidationSubreason(errors, projectedIdsOnly) {
  if (errors.some((error) => /unknown (?:step )?field/.test(error))) return "unknown-field";
  if (errors.some((error) => /at most \d+ steps/.test(error))) return "step-count";
  if (errors.some((error) => (
    /goalId must match|runId must match|must match trusted GoalEnvelope authority|manual\.retrieve query must match trusted knowledge/.test(error)
  ))) return "association-invalid";
  if (!projectedIdsOnly || errors.some((error) => /unknown capability|not allowed for domain/.test(error))) {
    return "catalog-invalid";
  }
  if (errors.some((error) => /capability input/.test(error))) return "input-schema-invalid";
  if (errors.some((error) => /dependency|cyclic|requires safety\.evaluate/.test(error))) {
    return "dependency-invalid";
  }
  if (errors.some((error) => /selectedCapabilities must match/.test(error))) return "projection-invalid";
  if (errors.some((error) => /write|access mode/.test(error))) return "write-policy-invalid";
  if (errors.some((error) => /required|must be (?:a |an )?(?:non-empty )?(?:string|array|object|boolean|integer)/.test(error))) {
    return "missing-required";
  }
  return "contract-invalid";
}

function taskPlanMatchesTrustedContext(taskPlan, contextRefs) {
  const frame = findVehicleSluFrameAuthority(contextRefs);
  if (!frame) return true;
  const capabilityId = getVehicleWriteCapabilityForIntent(frame.intent)?.capabilityId;
  const expectedInput = projectVehicleSluCapabilityInput(capabilityId, frame);
  if (!capabilityId || !expectedInput) return false;
  const step = Array.isArray(taskPlan?.steps)
    ? taskPlan.steps.find((candidate) => candidate?.capabilityId === capabilityId)
    : null;
  return plainDataEqual(step?.input, expectedInput);
}

function containsStructuredSecret(value) {
  if (Array.isArray(value)) return value.some(containsStructuredSecret);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nestedValue]) => (
    ["prompt", "rawprompt", "rawmodelresponse", "chainofthought", "chain_of_thought"].includes(key.toLowerCase())
    || containsStructuredSecret(nestedValue)
  ));
}

function containsKnowledgeForbiddenField(value) {
  if (Array.isArray(value)) return value.some(containsKnowledgeForbiddenField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nestedValue]) => (
    ["toolcall", "toolresult", "writeactioncount"].includes(key.toLowerCase())
    || containsKnowledgeForbiddenField(nestedValue)
  ));
}

export function structuredShapeInstruction(body) {
  if (body.task === "b3_turn_relation") {
    return "The root object must contain exactly relation, reasonCode, and requiresClarification. relation must be new-goal, follow-up, or correction. Never include tools, capabilities, Safety outcomes, or vehicle slots.";
  }
  if (body.task === "b2_goal_formation") {
    return "The root object must match the complete GoalEnvelopeInput contract, including every required field and no unknown fields; it must not be wrapped.";
  }
  if (body.task === "b2_task_planning") {
    return "The root object must match the complete TaskPlanInput contract and the supplied catalog, including step input schemas, dependencies, safety requirements, and at most one write.";
  }
  if (body.task === "b3_vehicle_knowledge_planning") {
    return isKnowledgeClarificationAllowed(body.delegation)
      ? "The root object must match KnowledgePlanningResult exactly: either a valid KnowledgeSubplan or a valid bound KnowledgeClarificationRequest. Preserve every delegation association; clarification must not plan retrieval, Provider, or Safety work; never include a Vehicle ToolCall or write capability."
      : "The root object must match a valid KnowledgeSubplan exactly. Preserve every delegation association; plan the authorized manual, Provider, Safety, and synthesis reads; never include a Vehicle ToolCall or write capability.";
  }
  if (body.task === "b3_vehicle_knowledge_synthesis") {
    return "The root object must match KnowledgeAnswerDraft exactly with only outcomeStatus, supportStatus, answer, limitations, and degraded. The server owns associations, references, Provider/model identity, and timing.";
  }
  if (body.task === "b3_recovery_proposal") {
    return "The root object must contain exactly action and reasonCode. action must be one of caller-supplied availableActions. This proposal never authorizes itself.";
  }
  const writeCompletionStatus = resolveWriteCompletionStatus(body.taskPlan, body.executionFacts);
  if (writeCompletionStatus === B2_WRITE_COMPLETION_STATUS.blocked) {
    return `The root object must set writeCompletionStatus to "blocked" and response exactly to: ${buildB2SafetyRejectedResponse(body.executionFacts)}`;
  }
  if (writeCompletionStatus === B2_WRITE_COMPLETION_STATUS.unconfirmed) {
    return `The root object must set writeCompletionStatus to "unconfirmed" and response exactly to: ${B2_UNCONFIRMED_WRITE_RESPONSE}`;
  }
  if (writeCompletionStatus === B2_WRITE_COMPLETION_STATUS.confirmed) {
    return "The root object must set writeCompletionStatus to \"confirmed\" and describe only Provider-confirmed facts.";
  }
  return "This is read-only. The root object must set writeCompletionStatus to \"not-applicable\" and use a neutral read-only response.";
}

function structuredRepairGuidance(body, validationSubreason) {
  if (body.task === "b3_turn_relation") {
    return "Classify only the relationship to the bounded current-goal summary; remove every tool, capability, Safety, slot, and unknown field.";
  }
  if (body.task === "b2_goal_formation" && validationSubreason === "association-invalid") {
    return `Set runId exactly to the request runId: ${JSON.stringify(body.runId)}.`;
  }
  if (body.task === "b3_vehicle_knowledge_planning") {
    const guidance = {
      "association-invalid": "Copy delegationId, runId, parentPlanId, and parentStepId exactly from KnowledgeDelegation.",
      "dependency-invalid": "Dependencies may reference only earlier steps; Safety evaluation requires a Provider read ancestor.",
      "write-policy-invalid": "Use accessMode read for every step and never include a Vehicle ToolCall or write capability.",
      "catalog-invalid": "Use only capabilities listed in the supplied read-only knowledge catalog and delegation authorization.",
      "input-schema-invalid": "Make each step input match its code-owned catalog inputSchema exactly.",
      "clarification-not-allowed": "Do not ask for clarification. Return the authorized manual → Provider → Safety → synthesis KnowledgeSubplan.",
    };
    return guidance[validationSubreason] || (isKnowledgeClarificationAllowed(body.delegation)
      ? "Return a complete valid KnowledgePlanningResult: either an authorized read-only KnowledgeSubplan or a bound KnowledgeClarificationRequest when the goal is ambiguous."
      : "Return the complete authorized read-only KnowledgeSubplan; clarification is not allowed for this explicit eligibility request.");
  }
  if (body.task === "b3_vehicle_knowledge_synthesis") {
    return "Return only the five KnowledgeAnswerDraft fields. Do not include associations, references, Provider/model identity, timing, unsupported claims, or forbidden telemetry fields.";
  }
  if (body.task === "b3_recovery_proposal") {
    return `Choose only from availableActions: ${JSON.stringify(normalizeRecoveryAvailableActions(body.availableActions))}. Never retry a vehicle write, override Safety, or invent evidence.`;
  }
  if (body.task !== "b2_task_planning") return "";
  const knowledgeDelegationAuthority = resolveTrustedKnowledgeDelegationAuthority(
    body.goalEnvelope,
  );
  const externalInformationCommand = body.goalEnvelope?.interactionType === "command"
    && body.goalEnvelope?.domain === "external-information";
  const readOnlyExternalInformationGoal = body.goalEnvelope?.interactionType !== "command"
    && body.goalEnvelope?.domain === "external-information";
  const withGoalInvariant = (guidance) => [
    readOnlyExternalInformationGoal
      ? "This read-only external-information Goal must contain exactly one read external.query step, with no other capability step."
      : "",
    guidance,
  ].filter(Boolean).join("\n");
  if (validationSubreason === "unknown-field") {
    const projectedInputSchemas = Array.isArray(body.capabilityCatalog)
      ? body.capabilityCatalog.map((capability) => ({
        capabilityId: capability?.id,
        inputSchema: capability?.inputSchema,
      }))
      : [];
    return withGoalInvariant([
      "Remove all undeclared keys from the root, every step, and every nested input object.",
      "Allowed TaskPlan root keys exactly: planId, goalId, runId, steps, selectedCapabilities, writeActionCount, planningSummary, model, provider, status.",
      "Allowed step keys exactly: stepId, capabilityId, dependsOn, input, expectedOutput, accessMode, status.",
      `Exact inputSchema by capability: ${JSON.stringify(projectedInputSchemas)}.`,
    ].join("\n"));
  }
  const guidance = {
    "missing-required": "Include every required TaskPlanInput and step field with the required primitive type.",
    "step-count": "Return between one and six ordered steps.",
    "association-invalid": knowledgeDelegationAuthority
      ? `Copy goalId and runId exactly from the supplied GoalEnvelope. The sole manual.retrieve input query must equal: ${JSON.stringify(knowledgeDelegationAuthority.knowledgeGoal)}`
      : `Copy goalId, runId, and every trusted-command-slots capability input exactly from the supplied GoalEnvelope: ${body.goalEnvelope?.goalId} / ${body.goalEnvelope?.runId} / ${JSON.stringify(body.goalEnvelope?.contextRefs || [])}.`,
    "catalog-invalid": "Use only capability IDs present in the supplied capability catalog and allowed for the goal domain.",
    "input-schema-invalid": "For every step, make input match that capability's required inputSchema exactly, including number versus string types.",
    "dependency-invalid": externalInformationCommand
      ? "For external.query in this command Goal, add an earlier safety.evaluate ancestor through dependsOn."
      : "Every capability whose requiresSafety is true, whether read or write, must have an earlier safety.evaluate ancestor through dependsOn.",
    "projection-invalid": "Set selectedCapabilities to the capabilityId values from steps in exactly the same order.",
    "write-policy-invalid": "Match accessMode to the catalog, set writeActionCount to the write-step count, and include at most one write.",
  };
  return withGoalInvariant(
    guidance[validationSubreason]
      || "Recheck the complete TaskPlanInput contract against the supplied GoalEnvelope and capability catalog.",
  );
}

function buildStructuredRepairPrompt(
  body,
  originalPrompt,
  schemaName,
  invalidOutputLength,
  validationSubreason,
) {
  return [
    originalPrompt,
    `Return one valid JSON object matching ${schemaName}.`,
    `The previous structured output was invalid and had ${invalidOutputLength} characters.`,
    validationSubreason ? `Validation category: ${validationSubreason}.` : "",
    structuredRepairGuidance(body, validationSubreason),
    structuredShapeInstruction(body),
    "Do not include markdown, prompts, or chain of thought.",
  ].filter(Boolean).join("\n");
}

async function runStructuredOutputProtocol({ body, initialResponse, repair }) {
  const schemaName = structuredAgentTasks[body.task];
  const maxStructuredRetries = body.task === "b3_vehicle_knowledge_synthesis" ? 0 : 1;
  let responseText = String(initialResponse || "");

  for (let structuredRetryCount = 0;
    structuredRetryCount <= maxStructuredRetries;
    structuredRetryCount += 1) {
    let reasonCode = "json-object-parse-failed";
    let validationSubreason = "parse-failed";
    try {
      const output = parseFirstJsonObject(responseText);
      const validationDetail = getStructuredValidationDetail(body, output);
      reasonCode = validationDetail.reasonCode;
      validationSubreason = validationDetail.validationSubreason;
      if (!reasonCode) {
        return {
          status: 200,
          output,
          structuredRetryCount,
        };
      }
    } catch {
      // Parsing and task-contract failures share the same single repair budget.
    }

    if (structuredRetryCount === maxStructuredRetries) {
      return {
        status: 422,
        schemaName,
        reasonCode,
        validationSubreason,
        invalidOutputLength: boundedInvalidOutputLength(responseText),
        structuredRetryCount,
      };
    }

    const repairMetadata = {
      schemaName,
      validationSubreason,
      invalidOutputLength: boundedInvalidOutputLength(responseText),
    };
    if (!body.task.startsWith("b3_vehicle_knowledge_")) repairMetadata.reasonCode = reasonCode;
    responseText = String(await repair(repairMetadata) || "");
  }

  throw new Error("unreachable structured output protocol state");
}

function boundedInvalidOutputLength(value) {
  return Math.min(String(value || "").length, 8_192);
}

const structuredUsageFields = Object.freeze([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
]);

function aggregateStructuredUsage(usages) {
  const boundedUsages = usages.slice(0, 2);
  const aggregated = {};
  for (const field of structuredUsageFields) {
    const values = boundedUsages.map((usage) => {
      const value = usage?.[field];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    });
    const sum = values.reduce((total, value) => total + (value ?? 0), 0);
    aggregated[field] = values.length > 0
      && values.every((value) => value !== null)
      && Number.isSafeInteger(sum)
      ? sum
      : null;
  }
  aggregated.unavailableReason = structuredUsageFields.some((field) => aggregated[field] === null)
    ? "provider-usage-unavailable"
    : null;
  return aggregated;
}

function assertStructuredPhaseActive({
  signal,
  deadline,
  startedAt,
  provider,
  externalModelRequestCount = 0,
}) {
  throwIfAborted(signal);
  if (Date.now() < deadline) return;
  throw new ModelProviderError("Structured Agent phase timed out", {
    code: "generation-timeout",
    provider: provider.id,
    durationMs: Date.now() - startedAt,
    externalModelRequestCount,
    details: { reasonCode: "generation-timeout", retryable: true },
  });
}

async function handleStructuredAgentTask(
  body,
  response,
  signal,
  registry,
  externalModelRequestLimit = null,
) {
  const schemaName = structuredAgentTasks[body.task];
  const startedAt = Date.now();
  const modelTask = modelTaskForStructuredAgent(body.task);
  const provider = registry.providerFor(modelTask);
  // A plan with no eligible capability (e.g. a vehicle command without Vehicle-SLU
  // authority) has no valid schema; fail closed before any model request.
  if (body.task === "b2_task_planning" && !resolveEligibleTaskPlanningCapabilities({
    goalEnvelope: body.goalEnvelope,
    catalogProjection: body.capabilityCatalog,
    semanticAuthority: body.semanticAuthority,
  }).length) {
    json(response, 422, {
      error: { code: "plan-binding-unavailable", message: "no capability is eligible for this goal" },
      telemetry: {
        provider: provider.id,
        model: provider.model,
        degraded: true,
        reason: "plan-binding-unavailable",
        structuredValidationReason: "plan-binding-unavailable",
        externalModelRequestCount: 0,
      },
    });
    return;
  }
  const prompt = buildStructuredAgentPrompt(body);
  const profile = registry.profileFor(modelTask);
  const phaseTimeoutMs = profile.watchdogMs
    ?? (body.task.startsWith("b3_vehicle_knowledge_")
      ? VEHICLE_KNOWLEDGE_STRUCTURED_TIMEOUT_MS
      : structuredAgentTimeoutMs);
  const phaseDeadline = startedAt + phaseTimeoutMs;
  let externalModelRequestCount = 0;
  const generateStructured = async (input) => {
    if (externalModelRequestLimit !== null
      && externalModelRequestCount >= externalModelRequestLimit) {
      throw new ModelProviderError("Model Provider request budget is exhausted", {
        code: "provider-request-budget-exhausted",
        provider: provider.id,
        externalModelRequestCount,
        details: {
          reasonCode: "provider-request-budget-exhausted",
          retryable: false,
        },
      });
    }
    const remainingExternalModelRequests = externalModelRequestLimit === null
      ? null
      : externalModelRequestLimit - externalModelRequestCount;
    try {
      const generated = await callStructuredAgentGenerate({
        ...input,
        externalModelRequestLimit: remainingExternalModelRequests,
      });
      externalModelRequestCount = boundExternalModelRequestCount(
        externalModelRequestCount + boundExternalModelRequestCount(generated.externalModelRequestCount),
      );
      return generated;
    } catch (error) {
      externalModelRequestCount = boundExternalModelRequestCount(
        externalModelRequestCount + boundExternalModelRequestCount(error?.externalModelRequestCount),
      );
      if (error && typeof error === "object") {
        error.externalModelRequestCount = externalModelRequestCount;
      }
      throw error;
    }
  };
  let finalGenerated = await generateStructured({
    body,
    prompt,
    signal,
    registry,
  });
  assertStructuredPhaseActive({
    signal,
    deadline: phaseDeadline,
    startedAt,
    provider,
    externalModelRequestCount,
  });
  const generatedUsages = [finalGenerated.usage];
  let providerDurationMs = Number.isFinite(finalGenerated.durationMs) ? finalGenerated.durationMs : 0;
  const runOutputProtocol = (initialResponse) => runStructuredOutputProtocol({
    body,
    initialResponse,
    repair: async ({ invalidOutputLength, validationSubreason }) => {
      const remainingMs = phaseDeadline - Date.now();
      if (remainingMs <= 0) {
        throw new ModelProviderError("Structured Agent phase timed out", {
          code: "generation-timeout",
          provider: provider.id,
          durationMs: Date.now() - startedAt,
          externalModelRequestCount,
          details: { reasonCode: "generation-timeout", retryable: true },
        });
      }
      const repaired = await generateStructured({
        body,
        prompt: buildStructuredRepairPrompt(
          body,
          prompt,
          schemaName,
          invalidOutputLength,
          validationSubreason,
        ),
        signal,
        registry,
      });
      assertStructuredPhaseActive({
        signal,
        deadline: phaseDeadline,
        startedAt,
        provider,
        externalModelRequestCount,
      });
      finalGenerated = repaired;
      generatedUsages.push(repaired.usage);
      if (Number.isFinite(repaired.durationMs)) providerDurationMs += repaired.durationMs;
      return repaired.text;
    },
  });
  let result = await runOutputProtocol(finalGenerated.text);
  const primaryStructuredFailure = result.status === 200
    ? null
    : {
        reasonCode: result.reasonCode,
        validationSubreason: result.validationSubreason,
      };
  const canUseLocalKnowledgeFallback = [
    "b3_vehicle_knowledge_planning",
    "b3_vehicle_knowledge_synthesis",
  ].includes(body.task)
    && result.status !== 200
    && finalGenerated.fallbackActive !== true
    && profile.fallback?.provider !== profile.provider
    && typeof registry.generateFallbackForTask === "function"
    && (externalModelRequestLimit === null
      || externalModelRequestCount < externalModelRequestLimit)
    && Date.now() < phaseDeadline;
  if (canUseLocalKnowledgeFallback) {
    const fallback = await generateStructured({
      body,
      prompt,
      signal,
      registry,
      fallbackOnly: true,
    });
    assertStructuredPhaseActive({
      signal,
      deadline: phaseDeadline,
      startedAt,
      provider,
      externalModelRequestCount,
    });
    finalGenerated = fallback;
    generatedUsages.push(fallback.usage);
    if (Number.isFinite(fallback.durationMs)) providerDurationMs += fallback.durationMs;
    result = await runOutputProtocol(finalGenerated.text);
  }
  const durationMs = providerDurationMs || (Date.now() - startedAt);

  if (result.status === 200) {
    throwIfAborted(signal);
    let output = result.output;
    if (body.task === "b3_vehicle_knowledge_synthesis") {
      try {
        output = createServerOwnedKnowledgeAnswerEnvelope({
          body,
          draft: result.output,
          telemetry: {
            provider: finalGenerated.provider,
            model: finalGenerated.model,
            durationMs,
            fallbackActive: finalGenerated.fallbackActive === true,
          },
        });
      } catch {
        json(response, 422, {
          error: "invalid KnowledgeAnswer server envelope",
          telemetry: {
            provider: finalGenerated.provider,
            model: finalGenerated.model,
            durationMs,
            degraded: true,
            reason: "invalid-structured-output",
            structuredRetryCount: result.structuredRetryCount,
            schemaName,
            structuredValidationReason: "knowledge-result-invalid",
            structuredValidationSubreason: "server-envelope-invalid",
            invalidOutputLength: 0,
            externalModelRequestCount,
            ...(typeof finalGenerated.fallbackActive === "boolean"
              ? { fallbackActive: finalGenerated.fallbackActive }
              : {}),
            ...(typeof finalGenerated.primaryFailureReasonCode === "string"
              ? { primaryFailureReasonCode: finalGenerated.primaryFailureReasonCode }
              : {}),
          },
        });
        return;
      }
    }
    json(response, 200, {
      output,
      telemetry: {
        provider: finalGenerated.provider,
        model: finalGenerated.model,
        durationMs,
        finishReason: finalGenerated.finishReason,
        usage: aggregateStructuredUsage(generatedUsages),
        structuredRetryCount: result.structuredRetryCount,
        firstPassValid: result.structuredRetryCount === 0,
        degraded: output?.degraded === true || finalGenerated.fallbackActive === true,
        ...(typeof finalGenerated.fallbackActive === "boolean"
          ? { fallbackActive: finalGenerated.fallbackActive }
          : {}),
        ...(typeof finalGenerated.primaryFailureReasonCode === "string"
          ? { primaryFailureReasonCode: finalGenerated.primaryFailureReasonCode }
          : {}),
        ...(body.task.startsWith("b3_vehicle_knowledge_") && primaryStructuredFailure
          ? {
              primaryStructuredValidationReason: primaryStructuredFailure.reasonCode,
              primaryStructuredValidationSubreason: primaryStructuredFailure.validationSubreason,
            }
          : {}),
        reason: result.structuredRetryCount === 0 ? "structured-output-valid" : "structured-output-repaired",
        externalModelRequestCount,
      },
    });
    return;
  }

  throwIfAborted(signal);
  json(response, 422, {
    error: `invalid ${schemaName} model output`,
    telemetry: {
      provider: finalGenerated.provider,
      model: finalGenerated.model,
      durationMs,
      degraded: true,
      reason: "invalid-structured-output",
      structuredRetryCount: result.structuredRetryCount,
      schemaName: result.schemaName,
      structuredValidationReason: result.reasonCode,
      structuredValidationSubreason: result.validationSubreason,
      invalidOutputLength: result.invalidOutputLength,
      externalModelRequestCount,
      ...(typeof finalGenerated.fallbackActive === "boolean"
        ? { fallbackActive: finalGenerated.fallbackActive, fallbackAttempted: true }
        : {}),
      ...(typeof finalGenerated.primaryFailureReasonCode === "string"
        ? { primaryFailureReasonCode: finalGenerated.primaryFailureReasonCode }
        : {}),
    },
  });
}

function resolveConversationCompactOutput(body, route) {
  const requested = typeof body?.conversationCompactOutput === "boolean"
    ? body.conversationCompactOutput
    : llmConversationCompactOutputEnabled;
  const isConversation = body?.task === "conversation_general" || body?.parsedCommand?.intent === "conversation.general";
  const hasManualEvidence = Array.isArray(body?.manualEvidence) && body.manualEvidence.length > 0;
  const hasExternalData = Boolean(body?.weatherData || body?.externalData)
    || route?.requiresExternalData === true
    || body?.parsedCommand?.requiresExternalData === true
    || body?.parsedCommand?.slots?.requiresExternalData === true;
  const hasToolOrSafetyContext = Boolean(body?.toolResult && Object.keys(body.toolResult).length)
    || Boolean(body?.safetyDecision);
  const eligible = isConversation
    && !hasManualEvidence
    && !hasExternalData
    && !hasToolOrSafetyContext
    && !route?.isVehicleKnowledge;
  return {
    requested,
    eligible,
    enabled: requested && eligible,
    mode: requested && eligible ? "compact" : "standard",
    outputBudget: requested && eligible ? llmConversationCompactOutputBudget : null,
    exclusionReason: requested && !eligible
      ? hasManualEvidence ? "manual-evidence"
        : hasExternalData ? "external-data"
          : hasToolOrSafetyContext ? "tool-or-safety-context"
            : route?.isVehicleKnowledge ? "vehicle-knowledge" : "not-conversation"
      : "",
  };
}

function buildCompactConversationOutputPrompt(body) {
  const rawText = String(body.rawText || body.parsedCommand?.rawText || body.prompt || "").trim();
  return [
    "你是车载本地助手。只回答用户当前的普通开放问题。",
    "用自然、完整、适合播报的中文直接回答；最多两句。",
    "不得编造实时数据、地点、网页事实、车辆状态或已执行动作。",
    `用户：${rawText}`,
  ].join("\n");
}

function compactConversationOutputTelemetry(candidate) {
  return {
    conversationOutputMode: candidate.mode,
    conversationOutputBudget: candidate.outputBudget,
    conversationOutputRequested: candidate.requested,
    conversationOutputEligible: candidate.eligible,
    ...(candidate.exclusionReason ? { conversationOutputExclusionReason: candidate.exclusionReason } : {}),
  };
}

function buildManualEvidenceContext(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return "";
  return evidence.slice(0, 3).map((item, index) => {
    return `${index + 1}. ${formatManualCitationForDisplay(item)}：${item.excerpt || ""}`;
  }).join("\n");
}

function isTemplatePlanningSummaryCandidate(body) {
  return isTemplatePlanningSummaryCandidateByContract(body, { planningSummaryMode: llmPlanningSummaryMode });
}

function isSafetyRejectionBoundary(body = {}) {
  const safetyDecision = body.safetyDecision || {};
  const parsedCommand = body.parsedCommand || {};
  return parsedCommand.intent === "safety.reject"
    || body.toolResult?.tool === "safety.reject"
    || safetyDecision.action === "reject";
}

function buildSafetyRejectionBoundaryResponse(body = {}) {
  const summary = [
    body.toolResult?.hmiSummary,
    body.safetyDecision?.reason,
    body.parsedCommand?.slots?.reason,
  ].find((candidate) => typeof candidate === "string" && candidate.trim())
    || "该请求涉及关键安全能力，当前不会执行。";
  return {
    summary: summary.trim(),
    recommendations: ["保留关键安全保护", "确认环境安全后再尝试低风险方案"],
  };
}

function buildTrustedTextGenerationFallback(body, conversationRoute, reasonCode) {
  const manualEvidence = Array.isArray(body.manualEvidence) ? body.manualEvidence : [];
  if (manualEvidence.length) {
    return {
      summary: buildManualEvidenceReply(manualEvidence, reasonCode),
      recommendations: conversationRecommendations(conversationRoute),
    };
  }
  if (body.task === "conversation_general" || body.parsedCommand?.intent === "conversation.general") {
    if (
      conversationRoute.isVehicleKnowledge
      || conversationRoute.isWeather
      || conversationRoute.isPoi
      || conversationRoute.isWebSearch
    ) {
      const rawText = String(body.rawText || body.parsedCommand?.rawText || body.prompt || "").trim();
      return {
        summary: buildConversationBoundaryReply(rawText, conversationRoute, {
          requiresExternalData: conversationRoute.requiresExternalData,
          externalDataType: conversationRoute.externalDataType,
          weatherData: body.weatherData,
          reason: reasonCode,
        }),
        recommendations: conversationRecommendations(conversationRoute),
      };
    }
    return null;
  }
  const hmiSummary = body.toolResult?.hmiSummary;
  if (typeof hmiSummary === "string" && hmiSummary.trim()) {
    return {
      summary: hmiSummary.trim(),
      recommendations: ["执行事实仅以车端工具结果为准", "保留安全网关裁决"],
    };
  }
  return null;
}

async function runVehicleSluSemanticBoundary({
  text,
  requestId,
  pending,
  conversationContext,
  signal,
  registry,
  now = Date.now,
} = {}) {
  throwIfAborted(signal);
  if (!registry
    || typeof registry.providerFor !== "function"
    || typeof registry.profileFor !== "function"
    || typeof registry.generateForTask !== "function") {
    throw new TypeError("Vehicle-SLU task registry is required");
  }
  const startedAt = now();
  const provider = registry.providerFor("vehicle_slu");
  const profile = registry.profileFor("vehicle_slu");
  const compact = isVehicleSluCompactModel(profile);
  const prompt = compact
    ? buildVehicleSluCompactV9Prompt({ text, pending, conversationContext })
    : buildVehicleSluPrompt({ text, requestId, pending });
  const promptVersion = compact ? VEHICLE_SLU_COMPACT_PROMPT_VERSION : VEHICLE_SLU_PROMPT_VERSION;
  const parseGeneratedText = compact
    ? (responseText) => expandVehicleSluCompact(JSON.parse(responseText), { requestId, text })
    : (responseText) => parseVehicleSluGeneratedText(responseText, requestId);
  const effectiveModel = provider.model;
  const effectiveWatchdogMs = resolveOptionalWatchdogMs(profile.watchdogMs);
  let generated;
  try {
    generated = await registry.generateForTask("vehicle_slu", {
      requestId,
      task: "vehicle_slu",
      prompt,
      outputMode: "json-object",
      jsonSchema: compact ? VEHICLE_SLU_COMPACT_OUTPUT_FORMAT : VEHICLE_SLU_OUTPUT_SCHEMA,
      generationProfile: compact ? VEHICLE_SLU_COMPACT_GENERATION_PROFILE : "structured-agent",
      externalModelRequestLimit: 1,
      signal,
    });
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    const reasonCode = "semantic-model-unavailable";
    const fallbackAttempted = error?.fallbackAttempted === true;
    const failedProvider = fallbackAttempted && typeof profile.fallback?.provider === "string"
      ? profile.fallback.provider
      : provider.id;
    const failedModel = fallbackAttempted && typeof profile.fallback?.model === "string"
      ? profile.fallback.model
      : effectiveModel;
    const providerFailureReasonCode = normalizeProviderFailureReasonCode(error);
    return {
      model: failedModel,
      semanticEnvelope: null,
      executionDisabled: true,
      reasonCode,
      telemetry: buildVehicleSluTelemetry({
        provider: failedProvider,
        model: failedModel,
        promptVersion,
        promptChars: prompt.length,
        durationMs: now() - startedAt,
        watchdogMs: effectiveWatchdogMs,
        ollamaDurations: error?._telemetry?.ollamaDurations,
        degraded: true,
        providerFailureReasonCode,
        fallbackAttempted: fallbackAttempted || undefined,
        primaryFailureReasonCode: fallbackAttempted
          ? error?.primaryFailureReasonCode
          : undefined,
        externalModelRequestCount: error?.externalModelRequestCount,
      }),
    };
  }

  let semanticEnvelope;
  try {
    semanticEnvelope = parseGeneratedText(generated.text);
  } catch {
    const generatedModel = generated.model;
    return {
      model: generatedModel,
      semanticEnvelope: null,
      executionDisabled: true,
      reasonCode: "semantic-contract-invalid",
      telemetry: buildVehicleSluTelemetry({
        provider: generated.provider,
        model: generatedModel,
        promptVersion,
        promptChars: prompt.length,
        durationMs: now() - startedAt,
        watchdogMs: effectiveWatchdogMs,
        ollamaDurations: generated?._telemetry?.ollamaDurations,
        degraded: true,
        fallbackActive: generated?.fallbackActive,
        primaryFailureReasonCode: generated?.primaryFailureReasonCode,
        externalModelRequestCount: generated?.externalModelRequestCount,
      }),
    };
  }

  const generatedModel = generated.model;
  return {
    model: generatedModel,
    semanticEnvelope,
    telemetry: buildVehicleSluTelemetry({
      provider: generated.provider,
      model: generatedModel,
      promptVersion,
      promptChars: prompt.length,
      durationMs: now() - startedAt,
      watchdogMs: effectiveWatchdogMs,
      ollamaDurations: generated?.providerTelemetry?.ollamaDurations
        || generated?._telemetry?.ollamaDurations,
      degraded: false,
      fallbackActive: generated?.fallbackActive,
      primaryFailureReasonCode: generated?.primaryFailureReasonCode,
      externalModelRequestCount: generated?.externalModelRequestCount,
    }),
  };
}

function parseVehicleSluGeneratedText(responseText, requestId) {
  const normalized = normalizeVehicleSluGeneratedEnvelope(JSON.parse(responseText));
  const semanticEnvelope = createVehicleSluEnvelope(
    repairVehicleSluClarificationQuestions(normalized),
  );
  if (semanticEnvelope.requestId !== requestId) {
    throw new TypeError("Vehicle-SLU response requestId mismatch");
  }
  return semanticEnvelope;
}

function repairVehicleSluClarificationQuestions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray(value.vehicleFrames)) return value;
  return {
    ...value,
    vehicleFrames: value.vehicleFrames.map((frame) => {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)
        || frame.actionNeed !== "clarify"
        || !Array.isArray(frame.missingSlots)
        || frame.missingSlots.length === 0
        || hasContextualClarificationQuestion(frame.clarificationQuestion)) return frame;
      return {
        ...frame,
        clarificationQuestion: buildVehicleSluBoundaryResponse({
          reasonCode: "missing-required-slots",
          missingSlots: frame.missingSlots,
        }),
      };
    }),
  };
}

function hasContextualClarificationQuestion(value) {
  const question = typeof value === "string" ? value.trim() : "";
  return Boolean(question)
    && !["请补充需要执行的具体参数。", "请补充需要执行的具体参数"].includes(question);
}

function buildVehicleSluTelemetry({
  provider = "ollama",
  model,
  promptVersion,
  promptChars,
  durationMs,
  watchdogMs,
  ollamaDurations,
  degraded,
  fallbackActive,
  fallbackAttempted,
  primaryFailureReasonCode,
  providerFailureReasonCode,
  externalModelRequestCount,
}) {
  return {
    provider,
    model,
    modelType: "vehicle-slu",
    contractVersion: VEHICLE_SLU_CONTRACT.ref,
    promptVersion,
    promptChars,
    durationMs,
    semanticDecisionMs: durationMs,
    firstModelTokenMs: null,
    firstModelTokenStatus: "unobservable-non-streaming",
    slowStage: durationMs > 3_000 ? "semantic-decision" : null,
    watchdogMs: resolveOptionalWatchdogMs(watchdogMs),
    ollamaDurations: normalizeWeatherOllamaDurations(ollamaDurations),
    degraded,
    ...(typeof fallbackActive === "boolean" ? { fallbackActive } : {}),
    ...(typeof fallbackAttempted === "boolean" ? { fallbackAttempted } : {}),
    ...(typeof primaryFailureReasonCode === "string" ? { primaryFailureReasonCode } : {}),
    ...(typeof providerFailureReasonCode === "string" ? { providerFailureReasonCode } : {}),
    ...(Number.isSafeInteger(externalModelRequestCount)
      ? { externalModelRequestCount: boundExternalModelRequestCount(externalModelRequestCount) }
      : {}),
  };
}

function readBenchmarkExternalModelRequestLimit(request) {
  const value = request?.headers?.[benchmarkExternalModelRequestLimitHeader];
  if (value === undefined) return null;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2 || String(limit) !== value) {
    throw new TypeError(`${benchmarkExternalModelRequestLimitHeader} must be an integer from 1 to 2`);
  }
  return limit;
}

async function handleSemantic(request, response, signal, registry = defaultModelProviderRegistry) {
  const body = await readBody(request, { signal });
  const result = await runVehicleSluSemanticBoundary({
    text: body.text,
    requestId: body.requestId || `local-${Date.now()}`,
    pending: body.pending,
    conversationContext: body.conversationContext,
    signal,
    registry,
  });
  json(response, 200, result);
}

async function handleLlm(
  request,
  response,
  signal,
  registry = defaultModelProviderRegistry,
  weatherDataFetcher = fetchOpenMeteoWeather,
) {
  const body = await readBody(request, { signal });
  const externalModelRequestLimit = readBenchmarkExternalModelRequestLimit(request);
  const benchmarkFault = resolveBenchmarkFaultRequest(body, { boundary: "local-llm" });
  if (Object.hasOwn(structuredAgentTasks, body.task)) {
    if (benchmarkFault?.target === "structured-model") {
      const simulatedError = buildBenchmarkModelError(benchmarkFault);
      const provider = registry.providerFor(modelTaskForStructuredAgent(body.task));
      json(response, 504, {
        error: simulatedError,
        telemetry: {
          provider: provider.id,
          model: provider.model,
          degraded: true,
          reason: simulatedError.code,
          structuredValidationReason: simulatedError.code,
          externalModelRequestCount: 0,
          ...benchmarkFaultTelemetry(benchmarkFault),
        },
      });
      return;
    }
    try {
      await handleStructuredAgentTask(
        body,
        response,
        signal,
        registry,
        externalModelRequestLimit,
      );
    } catch (error) {
      if (isCancellationError(error)
        || ["cancelled", "user-cancelled"].includes(error?.code)) throw error;
      const modelTask = modelTaskForStructuredAgent(body.task);
      if (!writeStructuredProviderFailure(response, error, registry, modelTask)) throw error;
    }
    return;
  }
  const tool = body.toolResult || {};
  const startedAt = Date.now();
  const rawConversationText = body.rawText || body.parsedCommand?.rawText || body.prompt || "";
  const conversationRoute = resolveConversationRoute("", body.parsedCommand || {});
  const compactConversationOutput = resolveConversationCompactOutput(body, conversationRoute);
  let weatherData;
  let weatherErrorCode;
  let weatherLocationClarification;

  if (isTemplatePlanningSummaryCandidate(body)) {
    const rendererIdentity = `${PLANNING_TEMPLATE_RENDERER_CAPABILITY.id}@${PLANNING_TEMPLATE_RENDERER_CAPABILITY.version}`;
    json(response, 200, {
      enabled: true,
      local: true,
      model: rendererIdentity,
      summary: buildTemplatePlanningSummary(tool),
      prompt: "",
      toolContext: tool.statePatch || {},
      recommendations: ["优先使用车端工具结果", "执行前保留安全网关校验"],
      telemetry: {
        runtime: "local-agent-server",
        modelType: "llm-planner",
        mocked: true,
        degraded: false,
        provider: "local-template",
        model: rendererIdentity,
        reason: "planning-template-fast-path",
        promptStyle: llmPromptStyle,
        promptChars: 0,
        timeoutMs: llmTimeoutMs,
        durationMs: Date.now() - startedAt,
        ollamaDurations: {},
        keepAlive: ollamaKeepAlive,
        planningSummaryMode: llmPlanningSummaryMode,
        planningRendererCapability: {
          id: PLANNING_TEMPLATE_RENDERER_CAPABILITY.id,
          version: PLANNING_TEMPLATE_RENDERER_CAPABILITY.version,
        },
        externalModelRequestCount: 0,
      },
    });
    return;
  }

  if (isSafetyRejectionBoundary(body)) {
    const boundary = buildSafetyRejectionBoundaryResponse(body);
    json(response, 200, {
      enabled: true,
      local: true,
      model: "safety-rejection-boundary",
      summary: boundary.summary,
      prompt: "",
      toolContext: tool.statePatch || {},
      recommendations: boundary.recommendations,
      telemetry: {
        runtime: "local-agent-server",
        modelType: "safety-rejection-boundary",
        provider: "local-boundary",
        model: "safety-rejection-boundary",
        mocked: false,
        degraded: false,
        reason: "safety-rejection-boundary",
        promptStyle: llmPromptStyle,
        promptChars: 0,
        timeoutMs: llmTimeoutMs,
        durationMs: Date.now() - startedAt,
        ollamaDurations: {},
        keepAlive: ollamaKeepAlive,
        planningSummaryMode: llmPlanningSummaryMode,
        cacheHit: false,
        cacheEligible: false,
        externalModelRequestCount: 0,
      },
    });
    return;
  }

  if (benchmarkFault?.target === "weather-adapter") {
    weatherErrorCode = benchmarkFault.code;
  } else if (shouldFetchWeatherData(body)) {
    try {
      weatherData = await weatherDataFetcher(
        body.rawText || body.parsedCommand?.rawText || body.prompt || "",
        { signal },
      );
    } catch (error) {
      if (signal?.aborted) throw createAbortError(signal.reason);
      weatherErrorCode = normalizeWeatherAdapterReasonCode(error.code);
      weatherLocationClarification = error.details?.weatherLocationClarification;
    }
  }

  if (weatherData) {
    const query = body.rawText || body.parsedCommand?.rawText || body.prompt || "";
    const composed = isOpenWeatherQuestion(query)
      ? await composeWeatherResponse(weatherData, query, {
          registry,
          requestId: body.requestId || "llm-text",
          task: body.task || "planning",
          signal,
          externalModelRequestLimit,
        })
      : null;
    json(response, 200, {
      enabled: true,
      local: true,
      model: composed?.model || "weather-template",
      summary: composed?.summary || formatWeatherSummary(weatherData, "", query),
      prompt: composed?.prompt || "",
      toolContext: {},
      recommendations: ["基于 Open-Meteo 实时天气与三日预报回答", "天气查询不创建车辆控制动作"],
      weatherData,
      externalData: { weather: weatherData },
      telemetry: composed?.telemetry ? {
        ...composed.telemetry,
        ...compactConversationOutputTelemetry(compactConversationOutput),
      } : {
        runtime: "local-agent-server",
        modelType: "weather-adapter",
        mocked: false,
        degraded: false,
        provider: "open-meteo",
        externalDataProvider: "open-meteo",
        cacheHit: false,
        cacheEligible: false,
        durationMs: Date.now() - startedAt,
        ...compactConversationOutputTelemetry(compactConversationOutput),
        externalModelRequestCount: 0,
      },
    });
    return;
  }

  if (weatherLocationClarification) {
    json(response, 200, {
      enabled: true,
      local: true,
      model: "weather-location-clarification",
      summary: weatherLocationClarification.clarification,
      prompt: "",
      toolContext: {},
      recommendations: ["请用户明确天气查询地点", "不使用默认杭州伪装当前位置或目的地"],
      weatherLocationClarification,
      telemetry: {
        runtime: "local-agent-server",
        modelType: "weather-location-clarification",
        mocked: false,
        degraded: false,
        provider: "local-boundary",
        reason: weatherErrorCode,
        promptStyle: llmPromptStyle,
        promptChars: 0,
        timeoutMs: llmTimeoutMs,
        durationMs: Date.now() - startedAt,
        ollamaDurations: {},
        keepAlive: ollamaKeepAlive,
        planningSummaryMode: llmPlanningSummaryMode,
        cacheHit: false,
        cacheEligible: false,
        cacheType: "llm-response",
        cacheSize: llmResponseCache.size,
        ...compactConversationOutputTelemetry(compactConversationOutput),
        externalModelRequestCount: 0,
      },
    });
    return;
  }

  if (weatherErrorCode) {
    json(response, 200, {
      enabled: true,
      local: true,
      model: "weather-unavailable-boundary",
      summary: "暂时无法获取实时天气，请稍后重试。",
      prompt: "",
      toolContext: {},
      recommendations: ["稍后重试实时天气查询", "不在缺少 Weather Adapter 事实时生成天气结论"],
      telemetry: {
        runtime: "local-agent-server",
        modelType: "weather-unavailable-boundary",
        provider: "local-boundary",
        model: "weather-unavailable-boundary",
        mocked: false,
        degraded: true,
        reason: weatherErrorCode,
        promptStyle: llmPromptStyle,
        promptChars: 0,
        timeoutMs: weatherTimeoutMs,
        durationMs: Date.now() - startedAt,
        ollamaDurations: {},
        keepAlive: ollamaKeepAlive,
        planningSummaryMode: llmPlanningSummaryMode,
        cacheHit: false,
        cacheEligible: false,
        ...(benchmarkFault ? benchmarkFaultTelemetry(benchmarkFault) : {}),
        ...compactConversationOutputTelemetry(compactConversationOutput),
        externalModelRequestCount: 0,
      },
    });
    return;
  }

  const vehicleKnowledgeApplicability = conversationRoute.isVehicleKnowledge
    ? getVehicleKnowledgeApplicability(rawConversationText)
    : null;
  if (vehicleKnowledgeApplicability?.status === "not-applicable") {
    const summary = buildVehicleKnowledgeFallback(rawConversationText);
    json(response, 200, {
      enabled: true,
      local: true,
      model: "vehicle-knowledge-boundary",
      summary,
      prompt: "",
      toolContext: {},
      recommendations: vehicleKnowledgeRecommendations(),
      telemetry: {
        runtime: "local-agent-server",
        modelType: "vehicle-knowledge-boundary",
        mocked: false,
        degraded: false,
        provider: "local-boundary",
        reason: "vehicle-knowledge-seed-not-applicable",
        promptStyle: llmPromptStyle,
        promptChars: 0,
        timeoutMs: llmTimeoutMs,
        durationMs: Date.now() - startedAt,
        ollamaDurations: {},
        keepAlive: ollamaKeepAlive,
        planningSummaryMode: llmPlanningSummaryMode,
        cacheHit: false,
        cacheEligible: false,
        cacheType: "llm-response",
        cacheSize: llmResponseCache.size,
        vehicleKnowledgeApplicability,
        ...compactConversationOutputTelemetry(compactConversationOutput),
        externalModelRequestCount: 0,
      },
    });
    return;
  }

  const llmBody = weatherData ? { ...body, weatherData, externalData: { weather: weatherData } } : body;
  const llmPrompt = compactConversationOutput.enabled
    ? buildCompactConversationOutputPrompt(llmBody)
    : buildLlmPrompt(llmBody);
  const cacheEligible = isLlmResponseCacheEligible(llmBody);
  const cabinProvider = registry.providerFor("cabin_response");
  const cacheKey = cacheEligible ? buildLlmResponseCacheKey({
    provider: cabinProvider.id,
    model: cabinProvider.model,
    promptStyle: llmPromptStyle,
    conversationOutputMode: compactConversationOutput.mode,
    prompt: llmPrompt,
  }) : "";
  const cachedEntry = cacheEligible ? getLlmResponseCacheEntry(cacheKey) : null;
  if (cachedEntry) {
    json(response, 200, {
      ...cachedEntry.responseBody,
      telemetry: buildLlmCacheTelemetry(cachedEntry, startedAt, llmPrompt.length),
    });
    return;
  }

  try {
    const generationProfile = compactConversationOutput.enabled
      ? "compact-conversation"
      : "default";
    const generated = await callTextProviderGenerate({
      body,
      prompt: llmPrompt,
      generationProfile,
      registry,
      signal,
      externalModelRequestLimit,
    });
    throwIfAborted(signal);
    const providerTelemetry = generated.providerTelemetry || {};
    const generationTimeoutMs = registry.profileFor("cabin_response").watchdogMs;
    const responseBody = {
      enabled: true,
      local: true,
      model: generated.model,
      summary: generated.text.trim(),
      prompt: llmPrompt,
      toolContext: tool.statePatch || {},
      recommendations: weatherData ? ["基于 Open-Meteo 实时天气回答", "不伪造 POI、路线、路况或补能信息"] : ["优先使用车端工具结果", "执行前保留安全网关校验"],
      ...(weatherData ? { weatherData, externalData: { weather: weatherData } } : {}),
      telemetry: {
        runtime: "local-agent-server",
        modelType: "llm-planner",
        mocked: false,
        degraded: false,
        provider: generated.provider,
        model: generated.model,
        reason: "model-provider-success",
        promptStyle: llmPromptStyle,
        promptChars: llmPrompt.length,
        timeoutMs: generationTimeoutMs,
        durationMs: generated.durationMs,
        finishReason: generated.finishReason,
        usage: generated.usage,
        ollamaDurations: normalizeWeatherOllamaDurations(providerTelemetry.ollamaDurations),
        keepAlive: normalizeProviderKeepAlive(
          generated.provider,
          providerTelemetry.keepAlive ?? ollamaKeepAlive,
        ),
        planningSummaryMode: llmPlanningSummaryMode,
        conversationOutputMode: compactConversationOutput.mode,
        conversationOutputBudget: compactConversationOutput.outputBudget,
        conversationOutputRequested: compactConversationOutput.requested,
        conversationOutputEligible: compactConversationOutput.eligible,
        ...(compactConversationOutput.exclusionReason ? { conversationOutputExclusionReason: compactConversationOutput.exclusionReason } : {}),
        cacheHit: false,
        cacheEligible,
        cacheType: "llm-response",
        cacheSize: llmResponseCache.size,
        ...(weatherData ? { externalDataProvider: "open-meteo" } : {}),
        externalModelRequestCount: boundExternalModelRequestCount(
          generated.externalModelRequestCount,
        ),
      },
    };
    if (cacheEligible && !generated.fallbackActive) {
      setLlmResponseCacheEntry(cacheKey, responseBody);
      responseBody.telemetry.cacheSize = llmResponseCache.size;
    }
    json(response, 200, responseBody);
    return;
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    const reasonCode = normalizeTextGenerationReason(error);
    const fallback = buildTrustedTextGenerationFallback(llmBody, conversationRoute, reasonCode);
    const cabinProfile = registry.profileFor("cabin_response");
    const generationTimeoutMs = cabinProfile.watchdogMs;
    const failedProvider = error?.fallbackAttempted === true
      && typeof cabinProfile.fallback?.provider === "string"
      ? cabinProfile.fallback.provider
      : cabinProvider.id;
    const failedModel = error?.fallbackAttempted === true
      && typeof cabinProfile.fallback?.model === "string"
      ? cabinProfile.fallback.model
      : cabinProvider.model;
    json(response, 200, {
      enabled: true,
      local: true,
      model: failedModel,
      summary: fallback?.summary || "抱歉，我们暂时无法完成。",
      prompt: llmPrompt,
      toolContext: tool.statePatch || {},
      recommendations: fallback?.recommendations || ["请稍后重试"],
      ...(weatherData ? { weatherData, externalData: { weather: weatherData } } : {}),
      telemetry: {
        runtime: "local-agent-server",
        modelType: "llm-planner",
        mocked: false,
        degraded: true,
        provider: failedProvider,
        model: failedModel,
        reason: reasonCode,
        providerFailureReasonCode: reasonCode,
        promptStyle: llmPromptStyle,
        promptChars: llmPrompt.length,
        timeoutMs: generationTimeoutMs,
        durationMs: Number.isFinite(error.durationMs)
          ? error.durationMs
          : Date.now() - startedAt,
        finishReason: null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          cachedInputTokens: null,
          unavailableReason: "provider-usage-unavailable",
        },
        ollamaDurations: {},
        keepAlive: ollamaKeepAlive,
        planningSummaryMode: llmPlanningSummaryMode,
        conversationOutputMode: compactConversationOutput.mode,
        conversationOutputBudget: compactConversationOutput.outputBudget,
        conversationOutputRequested: compactConversationOutput.requested,
        conversationOutputEligible: compactConversationOutput.eligible,
        ...(compactConversationOutput.exclusionReason ? { conversationOutputExclusionReason: compactConversationOutput.exclusionReason } : {}),
        cacheHit: false,
        cacheEligible,
        cacheType: "llm-response",
        cacheSize: llmResponseCache.size,
        ...(weatherData ? { externalDataProvider: "open-meteo" } : {}),
        externalModelRequestCount: boundExternalModelRequestCount(
          error?.externalModelRequestCount,
        ),
      },
    });
    return;
  }
}

async function handleWeather(request, response, signal, weatherDataFetcher = fetchOpenMeteoWeather) {
  const startedAt = Date.now();
  let body;
  try {
    body = await readBody(request, { signal });
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    json(response, 400, { ok: false, error: { code: "invalid_request", message: error.message } });
    return;
  }
  const query = String(body.query || "").trim();
  if (!query) {
    json(response, 400, { ok: false, error: { code: "missing_query", message: "missing query" } });
    return;
  }
  try {
    const weatherData = await weatherDataFetcher(query, {
      location: typeof body.location === "string" ? body.location : null,
      locationContext: body.locationContext,
      signal,
    });
    throwIfAborted(signal);
    json(response, 200, {
      ok: true,
      weatherData,
      summary: formatWeatherSummary(weatherData, "", query),
      telemetry: {
        runtime: "local-agent-server",
        provider: "open-meteo",
        timeoutMs: weatherTimeoutMs,
        durationMs: Date.now() - startedAt,
        locationResolution: weatherData.location.resolution,
        defaulted: weatherData.location.defaulted,
        cacheHit: false,
      },
    });
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    const status = Number(error.status) || 502;
    const weatherLocationClarification = error.details?.weatherLocationClarification;
    json(response, status, {
      ok: false,
      error: {
        code: error.code || "weather_upstream_error",
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        ...(weatherLocationClarification ? { weatherLocationClarification } : {}),
      },
      telemetry: {
        runtime: "local-agent-server",
        provider: "open-meteo",
        timeoutMs: weatherTimeoutMs,
        durationMs: Date.now() - startedAt,
        cacheHit: false,
      },
    });
  }
}

function normalizeManualRagTopK(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(0, Math.min(manualRagMaxTopK, Math.floor(parsed)));
}

function buildManualRagOptions(body = {}, topK = normalizeManualRagTopK(body.topK)) {
  const filters = body.filters && typeof body.filters === "object" ? body.filters : {};
  return {
    topK,
    vehicleModel: body.vehicleModel ?? filters.vehicleModel,
    corpusId: body.corpusId ?? filters.corpusId,
    profileMode: body.profileMode ?? filters.profileMode,
    allowDevelopmentAssumedCorpus: typeof body.allowDevelopmentAssumedCorpus === "boolean"
      ? body.allowDevelopmentAssumedCorpus
      : typeof filters.allowDevelopmentAssumedCorpus === "boolean"
        ? filters.allowDevelopmentAssumedCorpus
        : undefined,
  };
}

async function handleManualRag(request, response, signal, serverManualRagOptions = {}) {
  let body;
  try {
    body = await readBody(request, { signal });
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    json(response, 400, {
      error: {
        code: "invalid-request",
        message: error.message,
      },
    });
    return;
  }

  const {
    buildVectorEvidenceSummary = buildManualVectorEvidenceSummary,
    buildKeywordEvidenceSummary = buildKeywordManualEvidenceSummary,
    corpusRegistry = MANUAL_CORPUS_REGISTRY,
    evidenceRunLedger,
    runIdFactory = randomUUID,
    ...retrievalOverrides
  } = serverManualRagOptions;
  const runId = typeof body.runId === "string" && body.runId.trim()
    ? body.runId.trim()
    : String(runIdFactory());
  const benchmarkFault = resolveBenchmarkFaultRequest(body, { boundary: "manual-rag" });
  if (benchmarkFault) {
    const result = createManualRagApiResponse({
      query: String(body.query || "").trim(),
      runId,
      status: "unavailable",
      reason: benchmarkFault.code,
      telemetry: {
        retrievalMode: "unavailable",
        embeddingStatus: "unavailable",
        reason: benchmarkFault.code,
        ...benchmarkFaultTelemetry(benchmarkFault),
      },
      corpusRegistry,
    });
    evidenceRunLedger?.record(runId, result.evidence, { status: result.status });
    json(response, 200, result);
    return;
  }

  const query = String(body.query || "").trim();
  const topK = normalizeManualRagTopK(body.topK);
  if (!query) {
    json(response, 400, {
      error: {
        code: "invalid-request",
        message: "missing query",
      },
    });
    return;
  }

  const manualRagOptions = {
    ...buildManualRagOptions(body, topK),
    ...retrievalOverrides,
    signal,
    fetchImpl: retrievalOverrides.fetchImpl || fetch,
  };
  const respond = (result) => {
    evidenceRunLedger?.record(runId, result.evidence, { status: result.status });
    json(response, 200, result);
  };
  const respondUnavailable = (reason, telemetry) => respond(createManualRagApiResponse({
    query,
    runId,
    status: "unavailable",
    reason,
    telemetry: { ...telemetry, reason, topK },
    corpusRegistry,
  }));

  let vectorResult;
  try {
    vectorResult = await buildVectorEvidenceSummary(query, manualRagOptions);
    throwIfAborted(signal);
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    await respondWithKeywordFallback(error);
    return;
  }

  const vectorTelemetry = {
    ...(vectorResult.telemetry || {}),
    retrievalMode: vectorResult.telemetry?.retrievalMode || "vector-bge-m3",
    embeddingStatus: vectorResult.telemetry?.embeddingStatus || "embedded",
    topK,
  };
  try {
    const evidence = Array.isArray(vectorResult.evidence) ? vectorResult.evidence : [];
    const status = resolveManualRagApiStatus(evidence, vectorTelemetry);
    respond(createManualRagApiResponse({
      query: vectorResult.query || query,
      runId,
      status,
      reason: status === "hit" ? "" : vectorTelemetry.missReason || "low-confidence",
      evidence,
      summary: vectorResult.summary || "",
      telemetry: vectorTelemetry,
      corpusRegistry,
    }));
  } catch (error) {
    // Evidence that fails the EvidenceRef contract is rejected, never re-sourced from fallback.
    respondUnavailable(error.code || "retrieval-unavailable", {
      retrievalMode: vectorTelemetry.retrievalMode,
      embeddingStatus: vectorTelemetry.embeddingStatus,
      primaryRetrievalStatus: "rejected",
    });
  }

  async function respondWithKeywordFallback(vectorError) {
    const vectorFailureTelemetry = vectorError.telemetry && typeof vectorError.telemetry === "object"
      ? vectorError.telemetry
      : {};
    const vectorFailureReason = vectorError.code || vectorFailureTelemetry.reason || "retrieval-unavailable";
    const fallbackFailureTelemetry = {
      retrievalMode: "unavailable",
      embeddingStatus: vectorFailureTelemetry.embeddingStatus || "unavailable",
      primaryRetrievalStatus: "unavailable",
      primaryRetrievalReason: vectorFailureReason,
    };
    let keywordResult;
    try {
      keywordResult = await buildKeywordEvidenceSummary(query, manualRagOptions);
      throwIfAborted(signal);
    } catch (fallbackError) {
      if (signal?.aborted) throw createAbortError(signal.reason);
      const fallbackTelemetry = fallbackError.telemetry && typeof fallbackError.telemetry === "object"
        ? fallbackError.telemetry
        : {};
      respondUnavailable(vectorFailureReason, {
        ...fallbackFailureTelemetry,
        keywordFallbackStatus: "unavailable",
        keywordFallbackReason: fallbackError.code || fallbackTelemetry.reason || "keyword-retrieval-unavailable",
      });
      return;
    }
    const evidence = Array.isArray(keywordResult.evidence) ? keywordResult.evidence : [];
    const telemetry = {
      ...(keywordResult.telemetry || {}),
      retrievalMode: "keyword-fallback",
      primaryRetrievalStatus: "unavailable",
      primaryRetrievalReason: vectorFailureReason,
      topK,
    };
    // A keyword-only pass is not a completed retrieval: without the primary vector recall
    // a non-hit surfaces as unavailable rather than an authoritative miss.
    if (resolveManualRagApiStatus(evidence, telemetry) !== "hit") {
      respondUnavailable(vectorFailureReason, { ...fallbackFailureTelemetry, keywordFallbackStatus: "miss" });
      return;
    }
    try {
      respond(createManualRagApiResponse({
        query: keywordResult.query || query,
        runId,
        status: "hit",
        reason: "",
        evidence,
        summary: keywordResult.summary || "",
        telemetry,
        corpusRegistry,
      }));
    } catch (error) {
      respondUnavailable(vectorFailureReason, {
        ...fallbackFailureTelemetry,
        keywordFallbackStatus: "rejected",
        keywordFallbackReason: error.code || "keyword-evidence-rejected",
      });
    }
  }
}

function serveStatic(request, response) {
  const rawRequestPath = String(request.url || "").split("?", 1)[0];
  const url = new URL(request.url, "http://127.0.0.1");
  const requestPathname = rawRequestPath === "/userguide" ? "/userguide.html" : url.pathname;
  const pathname = decodeURIComponent(requestPathname === "/" ? "/index.html" : requestPathname);
  if (pathname === "/.local-services" || pathname.startsWith("/.local-services/")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const filePath = path.normalize(path.join(root, pathname));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(data);
  });
}

async function handleAbortablePost(request, response, handler) {
  const abortScope = createRequestAbortScope(request, response);
  try {
    await handler(request, response, abortScope.signal);
  } finally {
    abortScope.dispose();
  }
}

const providerHttpStatus = Object.freeze({
  "provider-config-invalid": 503,
  "provider-auth-failed": 502,
  "provider-rate-limited": 503,
  "provider-unavailable": 502,
  "generation-timeout": 504,
});

const speakerEnrollmentHttpStatus = Object.freeze({
  "local-speaker-model-unavailable": 503,
  "local-speaker-model-unverified": 503,
  "local-speaker-model-digest-mismatch": 503,
  "local-speaker-enrollment-capacity": 429,
  "local-speaker-enrollment-busy": 409,
  "local-speaker-phrase-order-invalid": 409,
  "local-speaker-enrollment-session-unavailable": 404,
  "local-speaker-pcm-size-invalid": 413,
  "pcm-too-large": 413,
});

const speakerCalibrationHttpStatus = Object.freeze({
  ...speakerEnrollmentHttpStatus,
  "local-speaker-calibration-capacity": 429,
  "local-speaker-calibration-busy": 409,
  "local-speaker-calibration-step-order-invalid": 409,
  "local-speaker-calibration-session-unavailable": 404,
  "local-speaker-profile-not-enrolled": 409,
  "local-speaker-recalibration-required": 409,
  "local-speaker-calibration-profile-changed": 409,
});

const speakerProofHttpStatus = Object.freeze({
  ...speakerCalibrationHttpStatus,
  "local-voice-confirmation-ambiguous": 422,
  "local-speaker-confirmation-review": 422,
  "local-speaker-confirmation-quality": 422,
  "local-speaker-confirmation-mismatch": 422,
  "voice-proof-policy-mismatch": 409,
  "voice-proof-unavailable": 409,
  "voice-proof-expired": 409,
  "voice-proof-consumed": 409,
  "voice-proof-busy": 409,
  "voice-proof-binding-mismatch": 409,
});

function sendSpeakerEnrollmentError(response, error) {
  const reasonCode = Object.hasOwn(speakerEnrollmentHttpStatus, error?.code)
    ? error.code
    : "local-speaker-enrollment-failed";
  json(
    response,
    speakerEnrollmentHttpStatus[reasonCode] || 503,
    { error: "local voice identity enrollment failed", reasonCode },
    { "cache-control": "no-store" },
  );
}

function sendSpeakerCalibrationError(response, error) {
  const reasonCode = Object.hasOwn(speakerCalibrationHttpStatus, error?.code)
    ? error.code
    : "local-speaker-calibration-failed";
  json(
    response,
    speakerCalibrationHttpStatus[reasonCode] || 503,
    { error: "local voice identity calibration failed", reasonCode },
    { "cache-control": "no-store" },
  );
}

function sendSpeakerProofError(response, error) {
  const reasonCode = Object.hasOwn(speakerProofHttpStatus, error?.code)
    ? error.code
    : "local-speaker-confirmation-failed";
  json(
    response,
    speakerProofHttpStatus[reasonCode] || 503,
    { error: "local voice identity proof failed", reasonCode },
    { "cache-control": "no-store" },
  );
}

function writeStructuredProviderFailure(response, error, registry, modelTask) {
  if (!(error instanceof ModelProviderError)) return false;
  const profile = registry.profileFor(modelTask);
  const failedProfile = error.fallbackAttempted === true && profile.fallback
    ? profile.fallback
    : profile;
  const reason = normalizeProviderFailureReasonCode(error);
  const upstreamAuthStatus = reason === "provider-auth-failed"
    && [401, 403].includes(error.details?.upstreamStatus)
    ? error.details.upstreamStatus
    : null;
  json(response, providerHttpStatus[reason] || 502, {
    error: "structured model generation failed",
    telemetry: {
      provider: failedProfile.provider,
      model: failedProfile.model,
      degraded: true,
      reason,
      structuredValidationReason: reason,
      fallbackActive: false,
      fallbackAttempted: error.fallbackAttempted === true,
      ...(error.fallbackAttempted === true
        && typeof error.primaryFailureReasonCode === "string"
        && publicProviderFailureReasonCodes.has(error.primaryFailureReasonCode)
        ? { primaryFailureReasonCode: error.primaryFailureReasonCode }
        : {}),
      ...(Number.isFinite(error.durationMs) ? { durationMs: error.durationMs } : {}),
      ...(upstreamAuthStatus === null ? {} : { upstreamStatus: upstreamAuthStatus }),
      externalModelRequestCount: boundExternalModelRequestCount(
        error.externalModelRequestCount,
      ),
    },
  });
  return true;
}

export function createServer({
  manualRagOptions = {},
  manualUserGuideOptions = {},
  modelProviderRegistry = defaultModelProviderRegistry,
  modelTaskProfiles = defaultModelTaskProfiles,
  weatherDataFetcher = fetchOpenMeteoWeather,
  runtimeWarmupCoordinator = defaultRuntimeWarmupCoordinator,
  demoReadinessResolver,
  localVoiceCoordinator = createLocalVoiceGatewayCoordinator(),
  voiceIdentityStore = createVoiceIdentityStore(),
  voiceIdentityPolicyStore = createVoiceIdentityVerificationPolicyStore(),
  speakerIdentityReadinessResolver = resolveLocalSpeakerIdentityReadiness,
  voiceIdentityEnrollmentCoordinator = createVoiceIdentityEnrollmentCoordinator({
    store: voiceIdentityStore,
    readinessResolver: speakerIdentityReadinessResolver,
  }),
  voiceIdentityCalibrationCoordinator = createVoiceIdentityCalibrationCoordinator({
    store: voiceIdentityStore,
    policyStore: voiceIdentityPolicyStore,
    readinessResolver: speakerIdentityReadinessResolver,
  }),
  voiceIdentityProofStore = createVoiceIdentityProofStore(),
  voiceIdentityProofCoordinator = createVoiceIdentityProofCoordinator({
    store: voiceIdentityStore,
    policyStore: voiceIdentityPolicyStore,
    proofStore: voiceIdentityProofStore,
  }),
} = {}) {
  if (manualRagOptions.corpusRegistry
    && manualUserGuideOptions.corpusRegistry
    && manualRagOptions.corpusRegistry !== manualUserGuideOptions.corpusRegistry) {
    const error = new TypeError("manual RAG and user-guide corpusRegistry must be the same object");
    error.code = "manual-corpus-registry-mismatch";
    throw error;
  }
  const manualCorpusRegistry = manualRagOptions.corpusRegistry
    ?? manualUserGuideOptions.corpusRegistry
    ?? MANUAL_CORPUS_REGISTRY;
  assertDeepFrozenManualCorpusRegistry(manualCorpusRegistry);
  const evidenceRunLedger = manualRagOptions.evidenceRunLedger
    ?? new ManualEvidenceRunLedger({ corpusRegistry: manualCorpusRegistry });
  if (!manualEvidenceRunLedgerUsesCorpusRegistry(evidenceRunLedger, manualCorpusRegistry)) {
    const error = new TypeError("manual evidence ledger must use the server corpusRegistry");
    error.code = "manual-evidence-ledger-registry-mismatch";
    throw error;
  }
  const userGuideRepository = manualUserGuideOptions.repository
    ?? createManualUserGuideRepository({
      corpusRegistry: manualCorpusRegistry,
      readFile: manualUserGuideOptions.readFile,
    });
  if (!manualUserGuideRepositoryUsesCorpusRegistry(userGuideRepository, manualCorpusRegistry)) {
    const error = new TypeError("manual user-guide repository must use the server corpusRegistry");
    error.code = "manual-userguide-repository-registry-mismatch";
    throw error;
  }
  const serverManualRagOptions = {
    ...manualRagOptions,
    corpusRegistry: manualCorpusRegistry,
    evidenceRunLedger,
  };
  const serverManualUserGuideOptions = {
    repository: userGuideRepository,
    evidenceRunLedger,
  };
  const resolveDemoReadiness = typeof demoReadinessResolver === "function"
    ? demoReadinessResolver
    : () => resolveDefaultDemoReadiness({
      modelProviderRegistry,
      modelTaskProfiles,
      runtimeWarmupCoordinator,
      localVoiceCoordinator,
    });
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        json(response, 204, {});
        return;
      }
      if (request.method === "GET" && request.url === "/api/model-provider-profile") {
        json(
          response,
          200,
          projectPublicModelTaskProfileSet(modelProviderRegistry.publicProfiles),
          { "cache-control": "no-store" },
        );
        return;
      }
      if (request.method === "GET" && request.url === "/api/demo-readiness") {
        json(
          response,
          200,
          await resolveDemoReadiness(),
          { "cache-control": "no-store" },
        );
        return;
      }
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      const requestPathname = requestUrl.pathname;
      if (request.method === "GET" && requestPathname === "/api/local-voice/identity") {
        const speakerReadiness = speakerIdentityReadinessResolver();
        const enrolledProfile = await voiceIdentityStore.readProfile().catch(() => null);
        const verification = await voiceIdentityPolicyStore.getPublicStatus({
          profile: enrolledProfile,
        });
        json(
          response,
          200,
          await voiceIdentityStore.getPublicStatus({
            modelReadiness: speakerReadiness,
            registrationAvailable: speakerReadiness.status === "ready"
              && Boolean(voiceIdentityEnrollmentCoordinator),
            reasonCode: null,
            verification: {
              ...verification,
              calibrationAvailable: speakerReadiness.status === "ready"
                && Boolean(enrolledProfile)
                && Boolean(voiceIdentityCalibrationCoordinator),
            },
          }),
          { "cache-control": "no-store" },
        );
        return;
      }
      if (request.method === "POST"
        && requestPathname === "/api/local-voice/identity/calibration/session") {
        if (!isSameOriginLoopbackRequest(request)) {
          json(response, 403, { error: "local voice origin rejected" }, { "cache-control": "no-store" });
          return;
        }
        try {
          json(
            response,
            201,
            await voiceIdentityCalibrationCoordinator.start({ origin: request.headers.origin }),
            { "cache-control": "no-store" },
          );
        } catch (error) {
          sendSpeakerCalibrationError(response, error);
        }
        return;
      }
      if (request.method === "POST"
        && requestPathname === "/api/local-voice/identity/calibration/sample") {
        if (!isSameOriginLoopbackRequest(request)) {
          json(response, 403, { error: "local voice origin rejected" }, { "cache-control": "no-store" });
          return;
        }
        if (String(request.headers["content-type"] || "").split(";", 1)[0].trim()
          !== "application/octet-stream") {
          json(
            response,
            415,
            { error: "local voice PCM content type required" },
            { "cache-control": "no-store" },
          );
          return;
        }
        await handleAbortablePost(request, response, async (scopedRequest, scopedResponse, signal) => {
          try {
            const pcm = await readBinaryBody(scopedRequest, { signal, maxBytes: 256_000 });
            const result = await voiceIdentityCalibrationCoordinator.submitSample({
              sessionId: requestUrl.searchParams.get("sessionId"),
              stepId: requestUrl.searchParams.get("stepId"),
              origin: scopedRequest.headers.origin,
              pcm,
            });
            json(scopedResponse, 200, result, { "cache-control": "no-store" });
          } catch (error) {
            sendSpeakerCalibrationError(scopedResponse, error);
          }
        });
        return;
      }
      if (request.method === "POST"
        && requestPathname === "/api/local-voice/identity/calibration/cancel") {
        if (!isSameOriginLoopbackRequest(request)) {
          json(response, 403, { error: "local voice origin rejected" }, { "cache-control": "no-store" });
          return;
        }
        try {
          voiceIdentityCalibrationCoordinator.cancel({
            sessionId: requestUrl.searchParams.get("sessionId"),
            origin: request.headers.origin,
          });
          json(response, 200, { cancelled: true }, { "cache-control": "no-store" });
        } catch (error) {
          sendSpeakerCalibrationError(response, error);
        }
        return;
      }
      if (request.method === "POST"
        && requestPathname === "/api/local-voice/identity/proof") {
        if (!isSameOriginLoopbackRequest(request)) {
          json(response, 403, { error: "local voice origin rejected" }, { "cache-control": "no-store" });
          return;
        }
        if (String(request.headers["content-type"] || "").split(";", 1)[0].trim()
          !== "application/octet-stream") {
          json(
            response,
            415,
            { error: "local voice PCM content type required" },
            { "cache-control": "no-store" },
          );
          return;
        }
        await handleAbortablePost(request, response, async (scopedRequest, scopedResponse, signal) => {
          try {
            const pcm = await readBinaryBody(scopedRequest, { signal, maxBytes: 256_000 });
            const result = await voiceIdentityProofCoordinator.issue({
              sessionId: requestUrl.searchParams.get("sessionId"),
              challengeId: requestUrl.searchParams.get("challengeId"),
              requestId: requestUrl.searchParams.get("requestId"),
              actionDigest: requestUrl.searchParams.get("actionDigest"),
              policyId: requestUrl.searchParams.get("policyId"),
              pcm,
            });
            const statusCode = result.status === "matched" || result.status === "cancelled" ? 200 : 422;
            json(scopedResponse, statusCode, result, { "cache-control": "no-store" });
          } catch (error) {
            sendSpeakerProofError(scopedResponse, error);
          }
        });
        return;
      }
      if (request.method === "POST"
        && requestPathname === "/api/local-voice/identity/proof/consume") {
        if (!isSameOriginLoopbackRequest(request)) {
          json(response, 403, { error: "local voice origin rejected" }, { "cache-control": "no-store" });
          return;
        }
        await handleAbortablePost(request, response, async (scopedRequest, scopedResponse, signal) => {
          try {
            const body = await readBody(scopedRequest, { signal });
            const result = await voiceIdentityProofCoordinator.consume(body);
            json(scopedResponse, result.ok ? 200 : 409, result, { "cache-control": "no-store" });
          } catch (error) {
            sendSpeakerProofError(scopedResponse, error);
          }
        });
        return;
      }
      if (request.method === "POST"
        && requestPathname === "/api/local-voice/identity/enrollment/session") {
        if (!isSameOriginLoopbackRequest(request)) {
          json(response, 403, { error: "local voice origin rejected" }, { "cache-control": "no-store" });
          return;
        }
        try {
          json(
            response,
            201,
            voiceIdentityEnrollmentCoordinator.start({ origin: request.headers.origin }),
            { "cache-control": "no-store" },
          );
        } catch (error) {
          sendSpeakerEnrollmentError(response, error);
        }
        return;
      }
      if (request.method === "POST"
        && requestPathname === "/api/local-voice/identity/enrollment/sample") {
        if (!isSameOriginLoopbackRequest(request)) {
          json(response, 403, { error: "local voice origin rejected" }, { "cache-control": "no-store" });
          return;
        }
        if (String(request.headers["content-type"] || "").split(";", 1)[0].trim()
          !== "application/octet-stream") {
          json(
            response,
            415,
            { error: "local voice PCM content type required" },
            { "cache-control": "no-store" },
          );
          return;
        }
        await handleAbortablePost(request, response, async (scopedRequest, scopedResponse, signal) => {
          try {
            const pcm = await readBinaryBody(scopedRequest, { signal, maxBytes: 256_000 });
            const result = await voiceIdentityEnrollmentCoordinator.submitSample({
              sessionId: requestUrl.searchParams.get("sessionId"),
              phraseId: requestUrl.searchParams.get("phraseId"),
              origin: scopedRequest.headers.origin,
              pcm,
            });
            json(scopedResponse, 200, result, { "cache-control": "no-store" });
          } catch (error) {
            sendSpeakerEnrollmentError(scopedResponse, error);
          }
        });
        return;
      }
      if (request.method === "POST"
        && requestPathname === "/api/local-voice/identity/enrollment/cancel") {
        if (!isSameOriginLoopbackRequest(request)) {
          json(response, 403, { error: "local voice origin rejected" }, { "cache-control": "no-store" });
          return;
        }
        try {
          voiceIdentityEnrollmentCoordinator.cancel({
            sessionId: requestUrl.searchParams.get("sessionId"),
            origin: request.headers.origin,
          });
          json(response, 200, { cancelled: true }, { "cache-control": "no-store" });
        } catch (error) {
          sendSpeakerEnrollmentError(response, error);
        }
        return;
      }
      if (request.method === "POST" && requestPathname === "/api/local-voice/identity/delete") {
        if (!isSameOriginLoopbackRequest(request)) {
          json(response, 403, { error: "local voice origin rejected" }, { "cache-control": "no-store" });
          return;
        }
        try {
          await voiceIdentityStore.deleteProfile();
          await voiceIdentityPolicyStore.deletePolicy();
        } catch {
          json(
            response,
            500,
            { error: "local voice identity deletion failed" },
            { "cache-control": "no-store" },
          );
          return;
        }
        const speakerReadiness = speakerIdentityReadinessResolver();
        json(
          response,
          200,
          await voiceIdentityStore.getPublicStatus({
            modelReadiness: speakerReadiness,
            registrationAvailable: speakerReadiness.status === "ready"
              && Boolean(voiceIdentityEnrollmentCoordinator),
            reasonCode: null,
          }),
          { "cache-control": "no-store" },
        );
        return;
      }
      if (request.method === "POST" && requestPathname === "/api/local-voice/session") {
        if (!isSameOriginLoopbackRequest(request)) {
          json(response, 403, { error: "local voice origin rejected" }, { "cache-control": "no-store" });
          return;
        }
        json(
          response,
          201,
          localVoiceCoordinator.issueSession({ origin: request.headers.origin }),
          { "cache-control": "no-store" },
        );
        return;
      }
      if (request.method === "GET" && requestPathname === "/api/userguide") {
        await handleManualUserGuide(request, response, serverManualUserGuideOptions);
        return;
      }
      if (request.method === "GET" && requestPathname === "/api/userguide/pdf") {
        await handleManualUserGuidePdf(request, response, serverManualUserGuideOptions);
        return;
      }
      if (request.method === "POST" && request.url === "/api/runtime-warmup") {
        await handleAbortablePost(request, response, async (scopedRequest, scopedResponse, signal) => {
          const body = await readBody(scopedRequest, { signal });
          const result = await handleRuntimeWarmupBody(body, runtimeWarmupCoordinator);
          json(scopedResponse, result.statusCode, result.body, { "cache-control": "no-store" });
        });
        return;
      }
      if (request.method === "POST" && request.url === "/api/local-semantic") {
        await handleAbortablePost(
          request,
          response,
          (scopedRequest, scopedResponse, signal) => handleSemantic(
            scopedRequest,
            scopedResponse,
            signal,
            modelProviderRegistry,
          ),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/api/local-llm") {
        await handleAbortablePost(
          request,
          response,
          (scopedRequest, scopedResponse, signal) => handleLlm(
            scopedRequest,
            scopedResponse,
            signal,
            modelProviderRegistry,
            weatherDataFetcher,
          ),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/api/weather") {
        await handleAbortablePost(
          request,
          response,
          (scopedRequest, scopedResponse, signal) => handleWeather(
            scopedRequest,
            scopedResponse,
            signal,
            weatherDataFetcher,
          ),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/api/manual-rag") {
        await handleAbortablePost(
          request,
          response,
          (scopedRequest, scopedResponse, signal) => handleManualRag(
            scopedRequest,
            scopedResponse,
            signal,
            serverManualRagOptions,
          ),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/api/tts") {
        await handleAbortablePost(request, response, handleTts);
        return;
      }
      if (request.method === "POST" && request.url === "/api/tts-streaming-poc") {
        await handleAbortablePost(request, response, handleTtsStreamingPoc);
        return;
      }
      serveStatic(request, response);
    } catch (error) {
      if (isCancellationError(error)
        || ["cancelled", "user-cancelled"].includes(error?.code)
        || !canWriteResponse(response)) return;
      if (error instanceof ModelProviderError) {
        const provider = modelProviderRegistry.providerFor("orchestrator_plan");
        json(response, providerHttpStatus[error.code] || 502, {
          error: "structured model generation failed",
          telemetry: {
            provider: provider.id,
            model: provider.model,
            degraded: true,
            reason: error.code,
            structuredValidationReason: error.code,
            durationMs: error.durationMs,
            externalModelRequestCount: boundExternalModelRequestCount(
              error.externalModelRequestCount,
            ),
          },
        });
        return;
      }
      if (["format-schema-rejected", "generation-timeout", "generation-unavailable"].includes(error.code)) {
        const provider = modelProviderRegistry.providerFor("orchestrator_plan");
        json(response, error.code === "generation-timeout" ? 504 : 502, {
          error: "structured model generation failed",
          telemetry: {
            provider: provider.id,
            degraded: true,
            reason: error.code,
            structuredValidationReason: error.code,
            durationMs: error._telemetry?.durationMs,
            externalModelRequestCount: 0,
          },
        });
        return;
      }
      json(response, 500, { error: error.message });
    }
  });
  attachLocalVoiceWebSocketGateway(server, { coordinator: localVoiceCoordinator });
  server.once("close", () => voiceIdentityEnrollmentCoordinator?.close?.());
  server.once("close", () => voiceIdentityCalibrationCoordinator?.close?.());
  server.once("close", () => voiceIdentityProofCoordinator?.close?.());
  return server;
}

function listen(port) {
  const server = createServer();
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && allowPortFallback && port < startPort + 20) {
      listen(port + 1);
      return;
    }
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Close the old local-agent-server process, then reopen http://127.0.0.1:${startPort}/`);
      console.error("If you intentionally want a temporary alternate port, start with NIO_ALLOW_PORT_FALLBACK=true.");
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`NIO local agent server: http://127.0.0.1:${port}/`);
    console.log(`Semantic endpoint:       http://127.0.0.1:${port}/api/local-semantic`);
    console.log(`Local LLM endpoint:      http://127.0.0.1:${port}/api/local-llm`);
    console.log(`Weather endpoint:        http://127.0.0.1:${port}/api/weather`);
    console.log(`Manual RAG endpoint:     http://127.0.0.1:${port}/api/manual-rag`);
    console.log(`Local TTS proxy:         http://127.0.0.1:${port}/api/tts`);
    if (ollamaWarmupOnStart) {
      void warmOllamaModels();
    }
    if (manualRagWarmupOnStart && gptSoVitsWarmupOnStart) {
      void defaultRuntimeWarmupCoordinator.warmup();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  listen(startPort);
}

export {
  buildStructuredAgentJsonSchema,
  buildStructuredRepairPrompt,
  buildWeatherComposerPrompt,
  buildWeatherFactPack,
  buildWeatherQueryPlan,
  buildTtsPayload,
  buildWeatherAdviceFromPolicy,
  composeWeatherResponse,
  fetchOpenMeteoWeather,
  formatWeatherSummary,
  isOpenWeatherQuestion,
  resolveTemporalRange,
  resolveTtsSynthesisProfile,
  resolveWeatherLocation,
  getStructuredValidationDetail,
  getStructuredValidationFailure,
  handleManualRag,
  callStructuredAgentGenerate,
  resolveStructuredAgentTimeoutMs,
  runVehicleSluSemanticBoundary,
  runStructuredOutputProtocol,
  validateWeatherComposedAnswer,
  VEHICLE_KNOWLEDGE_STRUCTURED_TIMEOUT_MS,
  WEATHER_ADVICE_POLICY,
};
