import { buildVehicleKnowledgeContext, buildVehicleKnowledgeFallback } from "../external-data/vehicle-knowledge.js";
import { buildConversationBoundaryResponse } from "../runtime/boundary-response-builder.js";
import { resolveConversationRoute } from "../runtime/agent-schemas.js";
import { B3_B4_RUNTIME_CONTRACT_VERSION } from "../runtime/runtime-contract-version.js";
import {
  composeAbortSignals,
  createAbortError,
  throwIfAborted,
} from "../runtime/abort-utils.js";
import { isTrustedKnowledgeGoal } from "../agents/goal-authority.js";
import { isKnowledgeClarificationAllowed } from "../application/contracts/vehicle-knowledge.js";
import { KNOWLEDGE_ELIGIBILITY_TOPOLOGY } from "../agents/knowledge-plan-validator.js";
import {
  createCapabilityFailure,
  RECOVERY_ACTIONS,
} from "../interaction/recovery-policy.js";
import {
  resolveBenchmarkFaultProfile,
  verifyBenchmarkFaultReceipt,
} from "../benchmark/benchmark-fault-profile.js";
import {
  VEHICLE_SLU_RESPONSE_PLAN_INPUT,
  createVehicleSluGoalEnvelope,
  createVehicleSluPlanAuthority,
} from "../semantic/vehicle-slu-orchestration.js";
import { VEHICLE_SLU_CONTRACT } from "../semantic/vehicle-slu-contract.js";
import { projectVehicleWriteBinding } from "../vehicle/vehicle-write-capabilities.js";

const DEFAULT_LOCAL_LLM_TIMEOUT_MS = 30000;
const DEFAULT_B2_STRUCTURED_TIMEOUT_MS = 95_000;
const CURRENT_GOAL_SUMMARY_MAX_CHARS = 240;
const BENCHMARK_MODEL_TASK_BY_ID = Object.freeze({
  "goal-formation-timeout": "b2_goal_formation",
  "task-planning-timeout": "b2_task_planning",
  "weather-timeout": "conversation_general",
});
export const VEHICLE_KNOWLEDGE_MODEL_PHASE_TIMEOUT_MS = 90_000;
export const VEHICLE_KNOWLEDGE_TRANSPORT_TIMEOUT_MS = 95_000;
export const B2_UNCONFIRMED_WRITE_RESPONSE = "写入操作尚未确认完成。";
export const B2_WRITE_COMPLETION_STATUS = Object.freeze({
  confirmed: "confirmed",
  blocked: "blocked",
  unconfirmed: "unconfirmed",
  notApplicable: "not-applicable",
});

export class CloudLLMAdapter {
  constructor(config = {}) {
    this.endpoint = config.endpoint || globalThis?.NIO_LOCAL_LLM_ENDPOINT || "";
    this.timeoutMs = resolveTimeoutMs(config.timeoutMs, globalThis?.NIO_LOCAL_LLM_TIMEOUT_MS);
    this.providerProfile = config.providerProfile || null;
    this.structuredTimeoutMs = normalizeTimeoutMs(config.structuredTimeoutMs)
      ?? normalizeTimeoutMs(globalThis?.NIO_B2_STRUCTURED_TIMEOUT_MS)
      ?? DEFAULT_B2_STRUCTURED_TIMEOUT_MS;
    this.model = config.model
      || resolvePublicProfileModel(this.providerProfile)
      || globalThis?.NIO_LOCAL_LLM_NAME
      || "local-planner";
    // Default for eligible ordinary conversation. An explicit false remains an
    // operator kill switch; Safety, tools, RAG and external-data routes are
    // excluded again by the server-side contract.
    this.conversationCompactOutput = config.conversationCompactOutput !== undefined
      ? config.conversationCompactOutput === true
      : globalThis?.NIO_LLM_CONVERSATION_COMPACT_OUTPUT !== false;
    this.benchmarkFaultProfile = typeof config.benchmarkFaultId === "string"
      ? resolveBenchmarkFaultProfile(config.benchmarkFaultId, {
          enabled: config.benchmarkFaultsEnabled === true,
        })
      : null;
    this.benchmarkFaultReceipt = null;
    this.enabled = Boolean(config.enabled || this.endpoint);
  }

  getBenchmarkFaultReceipt() {
    return this.benchmarkFaultReceipt;
  }

  resetBenchmarkFaultReceipt() {
    this.benchmarkFaultReceipt = null;
  }

  async executeBenchmarkWeatherFaultQuery(toolCall, options = {}) {
    if (this.benchmarkFaultProfile?.target !== "weather-adapter"
      || toolCall?.tool !== "conversation.general") return null;
    const slots = toolCall?.args && typeof toolCall.args === "object" ? toolCall.args : {};
    if (slots.topic !== "weather_query" && slots.externalDataType !== "weather") return null;
    const parsedCommand = {
      intent: "conversation.general",
      slots,
      requiresExternalData: true,
      externalDataType: "weather",
    };
    const rawText = typeof slots.rawText === "string"
      ? slots.rawText
      : typeof slots.query === "string" ? slots.query : "";
    const result = await this.converse(rawText, parsedCommand, {}, options);
    const receipt = verifyBenchmarkFaultReceipt(
      this.benchmarkFaultReceipt,
      this.benchmarkFaultProfile,
    );
    if (!receipt) return null;
    return Object.freeze({
      requestId: toolCall.requestId,
      commandId: toolCall.commandId,
      ok: false,
      simulated: true,
      executionState: "timeout",
      hmiSummary: result?.summary || "Weather Adapter timed out.",
      executionError: Object.freeze({
        code: receipt.code,
        stage: receipt.stage,
        retryable: receipt.retryable,
      }),
    });
  }

  async plan(parsedCommand, toolResult, options = {}) {
    throwIfAborted(options.signal);
    if (this.endpoint) {
      try {
        return await this.fetchPlan(parsedCommand, toolResult, options);
      } catch (error) {
        rethrowCancellation(error, options.signal);
        return {
          enabled: false,
          degraded: true,
          prompt: buildCloudPrompt(parsedCommand),
          summary: `本地大模型不可用，已回退 mock 规划：${error.message}`,
          toolContext: toolResult?.statePatch || {},
        };
      }
    }

    return {
      enabled: this.enabled,
      deferred: !this.enabled,
      prompt: buildCloudPrompt(parsedCommand),
      summary: this.enabled
        ? "云端规划接口已启用，当前 demo 仍使用 mock response。"
        : "云端大模型接口已预留，当前不发起真实网络请求。",
      toolContext: toolResult?.statePatch || {},
    };
  }

  async explain(parsedCommand, safetyDecision, options = {}) {
    throwIfAborted(options.signal);
    if (this.endpoint) {
      try {
        return await this.fetchExplain(parsedCommand, safetyDecision, options);
      } catch (error) {
        rethrowCancellation(error, options.signal);
        return {
          enabled: false,
          degraded: true,
          prompt: `Explain vehicle safety decision for ${parsedCommand.intent}: ${safetyDecision.reason}`,
          summary: `本地大模型解释不可用，使用安全网关本地解释：${error.message}`,
        };
      }
    }

    return {
      enabled: this.enabled,
      deferred: !this.enabled,
      prompt: `Explain vehicle safety decision for ${parsedCommand.intent}: ${safetyDecision.reason}`,
      summary: "高风险指令解释由本地安全网关即时生成，云端解释可后续补充。",
    };
  }

  async converse(rawText, parsedCommand, context = {}, options = {}) {
    throwIfAborted(options.signal);
    const prompt = buildConversationPrompt(rawText, parsedCommand, context);
    if (this.endpoint) {
      try {
        return await this.fetchConversation(rawText, parsedCommand, context, prompt, options);
      } catch (error) {
        rethrowCancellation(error, options.signal);
        return {
          enabled: false,
          degraded: true,
          prompt,
          summary: buildConversationFallback(rawText, parsedCommand, error.message, context.manualEvidence),
          telemetry: {
            provider: "local-fallback",
            mocked: true,
            degraded: true,
            reason: error.message,
          },
        };
      }
    }

    return {
      enabled: this.enabled,
      deferred: !this.enabled,
      prompt,
      summary: buildConversationFallback(rawText, parsedCommand, "未配置本地 LLM endpoint", context.manualEvidence),
      telemetry: {
        provider: "browser-runtime",
        mocked: true,
        degraded: true,
        reason: "未配置本地 LLM endpoint",
      },
    };
  }

  async respondForeground({ conversationGoal, pendingFrameIds, executionDisabled, signal }) {
    throwIfAborted(signal);
    const prompt = buildForegroundResponsePrompt({ conversationGoal, pendingFrameIds, executionDisabled });
    if (!this.endpoint) {
      return {
        summary: "我先处理你的车内请求。",
        telemetry: { provider: "browser-runtime", degraded: true, reason: "未配置本地 LLM endpoint" },
      };
    }
    return this.postLocalLlm({
      task: "conversation_general",
      prompt,
      conversationGoal,
      pendingFrameIds,
      executionDisabled: executionDisabled === true,
      conversationCompactOutput: true,
    }, this.timeoutMs, { signal });
  }

  async formGoal({ runId, rawText, parsedCommand, context, catalogProjection, signal }) {
    throwIfAborted(signal);
    return this.postLocalLlm({
      task: "b2_goal_formation",
      runId,
      rawText,
      parsedCommand,
      context,
      capabilityCatalog: catalogProjection,
      prompt: buildGoalFormationPrompt({ runId, rawText, parsedCommand, context }),
    }, this.structuredTimeoutMs, { signal });
  }

  async classifyTurnRelation({
    sessionId,
    turnId,
    currentGoalSummary,
    rawText,
    signal,
  }) {
    throwIfAborted(signal);
    const boundedCurrentGoalSummary = boundCurrentGoalSummary(currentGoalSummary);
    return this.postLocalLlm({
      task: "b3_turn_relation",
      sessionId,
      turnId,
      currentGoalSummary: boundedCurrentGoalSummary,
      rawText,
      prompt: buildTurnRelationPrompt({
        currentGoalSummary: boundedCurrentGoalSummary,
        rawText,
      }),
    }, this.structuredTimeoutMs, { signal });
  }

  async createTaskPlan({ runId, goalEnvelope, catalogProjection, semanticEnvelope = null, semanticAuthority = null, signal }) {
    throwIfAborted(signal);
    const vehicleCommand = goalEnvelope?.interactionType === "command"
      && goalEnvelope?.domain === "vehicle-control";
    const exactVehicleSluBinding = vehicleCommand
      ? matchesVehicleSluPlanningProof(goalEnvelope, semanticEnvelope, semanticAuthority)
      : true;
    const vehicleBinding = vehicleCommand
      ? resolveVehicleCommandExampleBinding(goalEnvelope, semanticAuthority)
      : null;
    const eligibleCatalog = resolveEligibleTaskPlanningCapabilities({
      goalEnvelope,
      catalogProjection,
      semanticAuthority,
    });
    if (vehicleCommand && (!exactVehicleSluBinding || !vehicleBinding || eligibleCatalog.length === 0)) {
      throw createPlanBindingUnavailableError();
    }
    return this.postLocalLlm({
      task: "b2_task_planning",
      runId,
      goalEnvelope,
      capabilityCatalog: catalogProjection,
      ...(semanticAuthority ? { semanticAuthority } : {}),
      prompt: buildTaskPlanningPrompt({ goalEnvelope, catalogProjection, semanticAuthority }),
    }, this.structuredTimeoutMs, { signal });
  }

  async synthesizeAgentResponse({ runId, goalEnvelope, taskPlan, executionFacts, knowledgeDelegation = null, knowledgeSubplan = null, knowledgeResult = null, executionDisabled = false, deferredFrameIds = [], signal }) {
    throwIfAborted(signal);
    return this.postLocalLlm({
      task: "b2_response_synthesis",
      runId,
      goalEnvelope,
      taskPlan,
      executionFacts,
      knowledgeDelegation,
      knowledgeSubplan,
      knowledgeResult,
      executionDisabled: executionDisabled === true,
      deferredFrameIds,
      prompt: buildResponseSynthesisPrompt({
        goalEnvelope,
        taskPlan,
        executionFacts,
        knowledgeDelegation,
        knowledgeSubplan,
        knowledgeResult,
        executionDisabled,
        deferredFrameIds,
      }),
    }, this.structuredTimeoutMs, { signal });
  }

  async createVehicleKnowledgeSubplan({ delegation, catalogProjection, signal }) {
    throwIfAborted(signal);
    return this.postLocalLlm({
      task: "b3_vehicle_knowledge_planning",
      delegation,
      capabilityCatalog: catalogProjection,
      prompt: buildVehicleKnowledgePlanningPrompt({ delegation, catalogProjection }),
    }, this.structuredTimeoutMs, { signal });
  }

  async synthesizeVehicleKnowledgeAnswer({ delegation, subplan, executionFacts, signal }) {
    throwIfAborted(signal);
    return this.postLocalLlm({
      task: "b3_vehicle_knowledge_synthesis",
      delegation,
      subplan,
      executionFacts,
      prompt: buildVehicleKnowledgeSynthesisPrompt({ delegation, subplan, executionFacts }),
    }, this.structuredTimeoutMs, { signal });
  }

  async proposeRecovery({ failure, availableActions, signal }) {
    throwIfAborted(signal);
    const normalizedFailure = createCapabilityFailure(failure);
    const boundedActions = normalizeRecoveryActions(availableActions);
    return this.postLocalLlm({
      task: "b3_recovery_proposal",
      failure: normalizedFailure,
      availableActions: boundedActions,
      prompt: buildRecoveryProposalPrompt({
        failure: normalizedFailure,
        availableActions: boundedActions,
      }),
    }, this.structuredTimeoutMs, { signal });
  }

  async fetchPlan(parsedCommand, toolResult, options = {}) {
    return this.postLocalLlm({
      task: "vehicle_plan",
      prompt: buildCloudPrompt(parsedCommand),
      parsedCommand,
      toolResult,
    }, this.timeoutMs, options);
  }

  async fetchExplain(parsedCommand, safetyDecision, options = {}) {
    return this.postLocalLlm({
      task: "safety_explain",
      prompt: `Explain vehicle safety decision for ${parsedCommand.intent}: ${safetyDecision.reason}`,
      parsedCommand,
      safetyDecision,
    }, this.timeoutMs, options);
  }

  async fetchConversation(rawText, parsedCommand, context, prompt, options = {}) {
    return this.postLocalLlm({
      task: "conversation_general",
      prompt,
      rawText,
      parsedCommand,
      conversationContext: context,
      manualEvidence: context.manualEvidence || [],
      conversationCompactOutput: this.conversationCompactOutput,
    }, this.timeoutMs, options);
  }

  async postLocalLlm(payload, timeoutMs = this.timeoutMs, { signal } = {}) {
    throwIfAborted(signal);
    const requestPayload = payload;
    const benchmarkFaultId = BENCHMARK_MODEL_TASK_BY_ID[this.benchmarkFaultProfile?.id]
      === payload.task
      ? this.benchmarkFaultProfile.id
      : null;
    if (benchmarkFaultId) this.benchmarkFaultReceipt = null;
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const composed = composeAbortSignals([signal, timeoutController.signal]);
    try {
      throwIfAborted(composed.signal);
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          ...requestPayload,
          ...(benchmarkFaultId
            ? { benchmarkFaultId }
            : {}),
        }),
        signal: composed.signal,
      });
      throwIfAborted(composed.signal);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throwIfAborted(composed.signal);
        const serverTelemetry = body?.telemetry || {};
        if (benchmarkFaultId) {
          this.benchmarkFaultReceipt = verifyBenchmarkFaultReceipt(
            serverTelemetry,
            this.benchmarkFaultProfile,
          );
        }
        const reasonCode = typeof serverTelemetry.structuredValidationReason === "string"
          ? serverTelemetry.structuredValidationReason
          : `http-${response.status}`;
        const simulatedError = body?.error && typeof body.error === "object"
          ? body.error
          : null;
        const error = new Error(`local LLM request failed: ${simulatedError?.code || reasonCode}`);
        error.code = simulatedError?.code || reasonCode;
        if (typeof simulatedError?.stage === "string") error.stage = simulatedError.stage;
        if (typeof simulatedError?.retryable === "boolean") error.retryable = simulatedError.retryable;
        if (simulatedError?.simulated === true) error.simulated = true;
        error.telemetry = projectModelFailureTelemetry(serverTelemetry, reasonCode);
        throw error;
      }
      const result = await response.json();
      throwIfAborted(composed.signal);
      if (benchmarkFaultId) {
        this.benchmarkFaultReceipt = verifyBenchmarkFaultReceipt(
          result?.telemetry,
          this.benchmarkFaultProfile,
        );
      }
      return result;
    } catch (error) {
      if (signal?.aborted) throw createAbortError(signal.reason);
      if (timeoutController.signal.aborted) {
        const timeoutError = new Error(error?.message || "local LLM request timed out");
        timeoutError.cause = error;
        throw timeoutError;
      }
      throw error;
    } finally {
      composed.dispose();
      clearTimeout(timeout);
    }
  }
}

function rethrowCancellation(error, signal) {
  if (signal?.aborted) {
    throw createAbortError(signal?.reason ?? error?.reason ?? error);
  }
}

function projectModelFailureTelemetry(telemetry, reasonCode) {
  const projected = {
    degraded: true,
    reason: reasonCode,
  };
  for (const field of ["model", "provider"]) {
    if (typeof telemetry?.[field] === "string") projected[field] = telemetry[field];
  }
  for (const field of ["benchmarkFaultId", "stage", "target", "code"]) {
    if (typeof telemetry?.[field] === "string") projected[field] = telemetry[field];
  }
  for (const field of ["fallbackActive", "fallbackAttempted"]) {
    if (typeof telemetry?.[field] === "boolean") projected[field] = telemetry[field];
  }
  if (typeof telemetry?.primaryFailureReasonCode === "string"
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(telemetry.primaryFailureReasonCode)) {
    projected.primaryFailureReasonCode = telemetry.primaryFailureReasonCode;
  }
  if (typeof telemetry?.retryable === "boolean") projected.retryable = telemetry.retryable;
  if (telemetry?.simulated === true) projected.simulated = true;
  if (Number.isFinite(telemetry?.durationMs) && telemetry.durationMs >= 0) {
    projected.durationMs = telemetry.durationMs;
  }
  if (Number.isInteger(telemetry?.structuredRetryCount)
    && telemetry.structuredRetryCount >= 0) {
    projected.structuredRetryCount = telemetry.structuredRetryCount;
  }
  if (Number.isSafeInteger(telemetry?.externalModelRequestCount)
    && telemetry.externalModelRequestCount >= 0
    && telemetry.externalModelRequestCount <= 2) {
    projected.externalModelRequestCount = telemetry.externalModelRequestCount;
  }
  if (typeof telemetry?.structuredValidationSubreason === "string") {
    projected.validationSubreason = telemetry.structuredValidationSubreason;
  }
  return Object.freeze(projected);
}

function resolveTimeoutMs(configValue, globalValue) {
  return normalizeTimeoutMs(configValue)
    ?? normalizeTimeoutMs(globalValue)
    ?? DEFAULT_LOCAL_LLM_TIMEOUT_MS;
}

function normalizeTimeoutMs(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : null;
}

function resolvePublicProfileModel(profile) {
  if (!profile
    || typeof profile !== "object"
    || Array.isArray(profile)
    || profile.schemaVersion !== 3
    || profile.runtimeContractVersion !== B3_B4_RUNTIME_CONTRACT_VERSION
    || !profile.tasks
    || typeof profile.tasks !== "object"
    || Array.isArray(profile.tasks)) return null;
  for (const task of ["orchestrator_plan", "cabin_response"]) {
    const candidate = profile.tasks[task];
    const model = candidate?.model;
    if (!["ollama", "dashscope"].includes(candidate?.provider)
      || typeof model !== "string"
      || model.length === 0
      || model.length > 128
      || model.trim() !== model
      || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(model)) continue;
    return model;
  }
  return null;
}

function normalizeRecoveryActions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("availableActions must be a non-empty array");
  }
  const actions = [];
  for (const action of value) {
    if (!RECOVERY_ACTIONS.includes(action)) {
      throw new TypeError("availableActions must contain only RecoveryPolicy actions");
    }
    if (!actions.includes(action)) actions.push(action);
  }
  return Object.freeze(actions);
}

function boundCurrentGoalSummary(value) {
  return Array.from(typeof value === "string" ? value.normalize("NFKC").trim() : "")
    .slice(0, CURRENT_GOAL_SUMMARY_MAX_CHARS)
    .join("");
}

function buildCloudPrompt(parsedCommand) {
  return [
    `Vehicle intent: ${parsedCommand.intent}`,
    `Slots: ${JSON.stringify(parsedCommand.slots)}`,
    "Return HMI-safe route, energy, or cabin explanation. Do not bypass local safety gateway.",
  ].join("\n");
}

export function buildTurnRelationPrompt({ currentGoalSummary, rawText }) {
  return [
    "Classify only how the new cabin-assistant utterance relates to the current goal.",
    "Return exactly one JSON object and no other text.",
    "Exact JSON root fields: relation (string: new-goal|follow-up|correction), reasonCode (non-empty string, 1-80 characters), requiresClarification (boolean).",
    `Minimal legal JSON example: ${JSON.stringify({
      relation: "correction",
      reasonCode: "brief-classification-reason",
      requiresClarification: false,
    })}`,
    "The example shows only the required shape; classify the actual utterance instead of copying its relation.",
    "Do not choose tools, capabilities, Safety outcomes, or vehicle slots.",
    `Current goal summary: ${JSON.stringify(boundCurrentGoalSummary(currentGoalSummary))}`,
    `New raw text: ${JSON.stringify(typeof rawText === "string" ? rawText : "")}`,
  ].join("\n");
}

export function buildRecoveryProposalPrompt({ failure, availableActions }) {
  return [
    "Propose one bounded recovery action for a structured capability failure.",
    "Choose only an action present in caller-supplied availableActions.",
    "Return exactly one JSON object with action and reasonCode.",
    "You are proposing only; deterministic RecoveryPolicy owns authorization.",
    "Never override Safety, invent evidence, or retry a vehicle write.",
    `CapabilityFailure: ${JSON.stringify(failure)}`,
    `availableActions: ${JSON.stringify(availableActions)}`,
  ].join("\n");
}

export function buildGoalFormationPrompt({ runId, rawText, parsedCommand, context }) {
  const trustedPlanningContextRefs = buildTrustedPlanningContextRefs(parsedCommand);
  const planningAuthority = resolveConversationPlanningGoalAuthority(parsedCommand, rawText);
  return [
    "Return one JSON object matching GoalEnvelopeInput.",
    "The JSON root must be the GoalEnvelopeInput itself and must not be nested under another key.",
    "Required top-level fields: goalId, runId, objective, interactionType, domain, constraints, contextRefs, requiredClarifications, readyForPlanning, model, provider, confidenceStrength.",
    `Set runId exactly to the request runId: ${JSON.stringify(runId || "run-id")}. Do not invent or modify it.`,
    "Copy the code-owned trusted planning contextRefs exactly; do not reinterpret, replace, or omit their slot values or provenance.",
    "When Parsed command includes a normalized conversationGoal, preserve the normalized conversationGoal interactionType exactly; map vehicle_knowledge and manual_knowledge domains to manual, and you must not rewrite a knowledge question as vehicle-control or report.",
    planningAuthority
      ? `The normalized semantic domain is code-owned routing input. Map it to the B2 planning domain ${planningAuthority.domain} exactly.`
      : "",
    `Trusted planning contextRefs: ${JSON.stringify(trustedPlanningContextRefs)}`,
    `Minimal JSON shape example (replace values from the request): ${JSON.stringify(buildGoalEnvelopeShapeExample(runId, rawText, parsedCommand, trustedPlanningContextRefs))}`,
    "Do not select tools or capabilities.",
    `User input: ${JSON.stringify(rawText)}`,
    `Parsed command: ${JSON.stringify(parsedCommand)}`,
    `Context summary: ${JSON.stringify(context)}`,
  ].join("\n");
}

export function buildTaskPlanningPrompt({ goalEnvelope, catalogProjection, semanticAuthority = null }) {
  const isReadOnlyGoal = goalEnvelope?.interactionType !== "command";
  const isKnowledgeGoal = isTrustedKnowledgeGoal(goalEnvelope);
  const isExternalInformationGoal = isReadOnlyGoal
    && goalEnvelope?.domain === "external-information";
  const isExternalInformationCommand = !isReadOnlyGoal
    && goalEnvelope?.domain === "external-information";
  const isVehicleCommand = goalEnvelope?.interactionType === "command"
    && goalEnvelope?.domain === "vehicle-control";
  const eligibleCatalog = resolveEligibleTaskPlanningCapabilities({
    goalEnvelope,
    catalogProjection,
    semanticAuthority,
  });
  const taskPlanExample = buildTaskPlanShapeExample(goalEnvelope, eligibleCatalog, semanticAuthority);
  return [
    "Return one JSON object matching TaskPlanInput.",
    "The JSON root must be the TaskPlanInput itself, with top-level selectedCapabilities and steps arrays.",
    "Exact TaskPlan root fields: planId, goalId, runId, steps, selectedCapabilities, writeActionCount, planningSummary, model, provider, status.",
    "Exact step fields: stepId, capabilityId, dependsOn, input, expectedOutput, accessMode, status.",
    "Use only capability IDs from the catalog projection. Do not invent capabilities.",
    isReadOnlyGoal
      ? "This GoalEnvelope is read-only. Select only read capabilities from the supplied catalog and set writeActionCount exactly to 0."
      : "Use no more than one write capability and include required safety dependencies.",
    "Every capability whose requiresSafety is true, whether read or write, must have an earlier safety.evaluate ancestor through dependsOn.",
    isExternalInformationCommand
      ? "This command external-information Goal requires external.query to have an earlier safety.evaluate ancestor through dependsOn."
      : "",
    isExternalInformationGoal
      ? "This read-only external-information Goal must contain exactly one read external.query step, with no other capability step."
      : "",
    isKnowledgeGoal
      ? "This trusted knowledge Goal must contain exactly one manual.retrieve step and no other TaskPlan capability. Cabin Assistant composes the final answer outside this plan."
      : "",
    !isReadOnlyGoal
      ? "Every planned capability must help accomplish the GoalEnvelope objective; do not return a merely valid read-only plan for an explicit requested state change."
      : "",
    isVehicleCommand
      ? "For a vehicle-control write, select the capability and copy every input only from the validated vehicle-slu-frame-authority contextRef. Never recover vehicle authority from objective or constraints."
      : "",
    isVehicleCommand
      ? "When that write requiresSafety, use the dependency pattern safety.evaluate → selected write capability → response.synthesize when those capabilities exist in the catalog. Each later step must depend on the preceding required step."
      : "",
    isVehicleCommand
      ? "For vehicle.tailgate.set, the mandatory dependency chain is safety.evaluate → confirmation.issue → vehicle.tailgate.set → response.synthesize. Use stepIds safety-tailgate, confirmation-tailgate, write-tailgate, and response-tailgate, with each later step depending on the immediately preceding step."
      : "",
    (isVehicleCommand || isKnowledgeGoal || isExternalInformationGoal) && taskPlanExample
      ? `Canonical JSON example for this GoalEnvelope and catalog: ${JSON.stringify(taskPlanExample)}`
      : isVehicleCommand
        ? "No canonical JSON example is available because the target write capability or a required input is not fully determined by the trusted GoalEnvelope. Do not copy the catalog's first write or invent placeholder values."
        : `Minimal JSON shape example (replace values from GoalEnvelope and catalog): ${JSON.stringify(taskPlanExample)}`,
    (isVehicleCommand || isKnowledgeGoal || isExternalInformationGoal) && taskPlanExample
      ? "The canonical example is bound to the current trusted GoalEnvelope and catalog. Do not replace it with an unrelated read-only capability."
      : "",
    `GoalEnvelope: ${JSON.stringify(goalEnvelope)}`,
    semanticAuthority ? `Vehicle-SLU plan authority: ${JSON.stringify(semanticAuthority)}` : "",
    `Catalog projection: ${JSON.stringify(eligibleCatalog)}`,
  ].filter(Boolean).join("\n");
}

export function resolveEligibleTaskPlanningCapabilities({ goalEnvelope, catalogProjection, semanticAuthority = null }) {
  const catalog = Array.isArray(catalogProjection) ? catalogProjection : [];
  const isReadOnlyGoal = goalEnvelope?.interactionType !== "command";
  const isKnowledgeGoal = isTrustedKnowledgeGoal(goalEnvelope);
  const isExternalInformationGoal = isReadOnlyGoal
    && goalEnvelope?.domain === "external-information";
  const isVehicleCommand = goalEnvelope?.interactionType === "command"
    && goalEnvelope?.domain === "vehicle-control";
  const vehicleBinding = isVehicleCommand
    ? resolveVehicleCommandExampleBinding(goalEnvelope, semanticAuthority)
    : null;
  if (isVehicleCommand && !vehicleBinding) return [];
  const vehicleCommandCapabilityIds = vehicleBinding
    ? new Set([
        "safety.evaluate",
        ...(vehicleBinding.capabilityId === "vehicle.tailgate.set"
          ? ["confirmation.issue"]
          : []),
        vehicleBinding.capabilityId,
        "response.synthesize",
      ])
    : null;
  const authorityCapabilities = semanticAuthority
    ? new Set(semanticAuthority.allowedCapabilityIds || [])
    : null;
  return catalog.filter((capability) => (
    (!authorityCapabilities || authorityCapabilities.has(capability?.id))
    && (!isReadOnlyGoal || capability?.accessMode !== "write")
    && (!isKnowledgeGoal || capability?.id === "manual.retrieve")
    && (!isExternalInformationGoal || capability?.id === "external.query")
    && (!vehicleCommandCapabilityIds || vehicleCommandCapabilityIds.has(capability?.id))
    && Array.isArray(capability?.allowedDomains)
    && capability.allowedDomains.includes(goalEnvelope?.domain)
  ));
}

export function buildVehicleKnowledgePlanningPrompt({ delegation, catalogProjection }) {
  const clarificationAllowed = isKnowledgeClarificationAllowed(delegation);
  const subplanExample = buildKnowledgeSubplanExample(delegation, catalogProjection);
  return [
    clarificationAllowed
      ? "Return one JSON object matching KnowledgeSubplan or KnowledgeClarificationRequest."
      : "Return one JSON object matching KnowledgeSubplan.",
    clarificationAllowed
      ? "When the vehicle model, feature object, or required eligibility context is ambiguous, return KnowledgeClarificationRequest immediately; do not plan retrieval, Provider, or Safety work."
      : "This is an explicit authorized ES8 tailgate eligibility request: you must not ask for clarification. Use each authorized capability exactly once, with step IDs and dependencies manual → vehicle-state → safety → answer.",
    "Exact KnowledgeSubplan root fields: subplanId, delegationId, runId, parentPlanId, parentStepId, steps, selectedCapabilities, planningSummary, model, provider, status.",
    "Exact knowledge step fields: stepId, capabilityId, dependsOn, input, expectedOutput, accessMode, status.",
    clarificationAllowed
      ? "Exact KnowledgeClarificationRequest root fields: delegationId, runId, outcomeStatus, questions, reasonCode, model, provider."
      : "",
    "Use only the supplied read-only knowledge catalog.",
    "Never create Vehicle ToolCall or write capability.",
    "Safety eligibility requires Provider read → Safety read-only evaluation.",
    "Unsupported evidence must produce an unsupported answer path.",
    "Preserve delegationId, runId, parentPlanId, and parentStepId exactly.",
    "Every dependency must refer to an earlier subplan step.",
    `Canonical KnowledgeSubplan JSON example for this delegation and catalog: ${JSON.stringify(subplanExample)}`,
    clarificationAllowed
      ? `Canonical KnowledgeClarificationRequest JSON example for this delegation: ${JSON.stringify(buildKnowledgeClarificationExample(delegation))}`
      : "",
    `KnowledgeDelegation: ${JSON.stringify(delegation)}`,
    `Read-only knowledge catalog: ${JSON.stringify(catalogProjection)}`,
  ].filter(Boolean).join("\n");
}

export function buildVehicleKnowledgeSynthesisPrompt({ delegation, executionFacts }) {
  const completedInScope = delegation?.vehicleScope === "nio-es8-user-manual-2026"
    && executionFacts?.outcomeStatus === "completed";
  const boundedDelegation = {
    knowledgeGoal: delegation?.knowledgeGoal,
    vehicleScope: delegation?.vehicleScope,
    requireSafetyEligibilityExplanation: delegation?.requireSafetyEligibilityExplanation === true,
  };
  const boundedExecutionFacts = {
    outcomeStatus: executionFacts?.outcomeStatus,
    reasonCode: executionFacts?.reasonCode || "",
    evidenceRefs: executionFacts?.evidenceRefs || [],
    vehicleStateRefs: executionFacts?.vehicleStateRefs || [],
    safetyAssessmentRef: executionFacts?.safetyAssessmentRef ?? null,
    degraded: executionFacts?.degraded === true,
  };
  return [
    completedInScope
      ? "Return exactly one answered JSON object matching KnowledgeAnswerDraft. Do not return clarification, not-applicable, or unavailable."
      : "The knowledge execution is not eligible for answer synthesis.",
    completedInScope
      ? "Exact draft root fields: outcomeStatus, supportStatus, answer, limitations, degraded."
      : "",
    "Use only completed ExecutionFacts; do not fill unsupported claims from model memory.",
    "Manual claims must be derived only from bounded evidenceRefs[].excerpt.",
    "For current eligibility, SafetyAssessmentRef is authoritative; never reverse its allowed/action conclusion.",
    "Never create Vehicle ToolCall, a write capability, raw prompt/model response, or chain of thought.",
    "The server owns all associations, references, Provider identity, model identity, and timing; do not include them.",
    `KnowledgeScope: ${JSON.stringify(boundedDelegation)}`,
    `ExecutionFacts: ${JSON.stringify(boundedExecutionFacts)}`,
  ].filter(Boolean).join("\n");
}

export function buildResponseSynthesisPrompt({ goalEnvelope, taskPlan, executionFacts, knowledgeResult = null, knowledgeDelegation = null, knowledgeSubplan = null, executionDisabled = false, deferredFrameIds = [] }) {
  const writeCompletionStatus = resolveWriteCompletionStatus(taskPlan, executionFacts);
  const safetyRejectedResponse = buildB2SafetyRejectedResponse(executionFacts);
  const responseConstraint = writeCompletionStatus === B2_WRITE_COMPLETION_STATUS.blocked
    ? `Safety explicitly rejected this write. Set writeCompletionStatus to "blocked" and set response exactly to: ${safetyRejectedResponse}`
    : writeCompletionStatus === B2_WRITE_COMPLETION_STATUS.unconfirmed
      ? `This request contains an unconfirmed write. Set writeCompletionStatus to "unconfirmed" and set response exactly to: ${B2_UNCONFIRMED_WRITE_RESPONSE}`
      : writeCompletionStatus === B2_WRITE_COMPLETION_STATUS.confirmed
        ? "This request contains a Provider-confirmed write. Set writeCompletionStatus to \"confirmed\" and describe only confirmed facts."
        : "This is a read-only task. Set writeCompletionStatus to \"not-applicable\" and give a neutral summary of confirmed read-only facts.";
  const exampleResponse = writeCompletionStatus === B2_WRITE_COMPLETION_STATUS.blocked
    ? safetyRejectedResponse
    : writeCompletionStatus === B2_WRITE_COMPLETION_STATUS.unconfirmed
      ? B2_UNCONFIRMED_WRITE_RESPONSE
      : writeCompletionStatus === B2_WRITE_COMPLETION_STATUS.confirmed
        ? "请仅根据 Provider-confirmed success 和已确认车辆状态说明结果。"
        : "请根据已确认的只读事实简洁回答。";
  return [
    "Return one JSON object with a concise response string.",
    "The JSON root must contain top-level response and writeCompletionStatus strings.",
    "Use only confirmed ExecutionFacts.",
    "executionDisabled=true 时不得声称任何座舱动作已执行。",
    "车辆写完成必须同时存在匹配 commandId 的 Provider success 和 confirmedVehicleState。",
    "deferredFrameIds 非空时必须说明哪些请求本轮没有执行。",
    responseConstraint,
    `Minimal JSON example for this request: ${JSON.stringify({
      response: exampleResponse,
      writeCompletionStatus,
    })}`,
    `GoalEnvelope: ${JSON.stringify(goalEnvelope)}`,
    `Validated TaskPlan summary: ${JSON.stringify(summarizeTaskPlan(taskPlan))}`,
    `ExecutionFacts: ${JSON.stringify(executionFacts)}`,
    `KnowledgeDelegation: ${JSON.stringify(knowledgeDelegation)}`,
    `KnowledgeSubplan: ${JSON.stringify(knowledgeSubplan)}`,
    `KnowledgeResult: ${JSON.stringify(knowledgeResult)}`,
    `executionDisabled: ${executionDisabled === true}`,
    `deferredFrameIds: ${JSON.stringify(deferredFrameIds)}`,
  ].join("\n");
}

export function buildForegroundResponsePrompt({ conversationGoal, pendingFrameIds, executionDisabled }) {
  return [
    "请仅回应结构化 conversationGoal 中的开放对话部分。",
    "pendingFrameIds 中的车辆请求仍在处理中；不得声称执行成功、不得编造 Provider 状态。",
    "不要选择工具、能力或 Safety 结论。",
    `conversationGoal: ${JSON.stringify(conversationGoal)}`,
    `pendingFrameIds: ${JSON.stringify(pendingFrameIds)}`,
    `executionDisabled: ${executionDisabled === true}`,
  ].join("\n");
}

export function hasProviderConfirmedWriteSuccess(taskPlan = {}, executionFacts = {}) {
  const hasWrite = Array.isArray(taskPlan.steps)
    && taskPlan.steps.some((step) => step?.accessMode === "write");
  const toolResult = executionFacts.toolResult;
  const confirmedSnapshotId = typeof toolResult?.confirmedSnapshotId === "string"
    ? toolResult.confirmedSnapshotId
    : "";
  const confirmedVehicleState = executionFacts.confirmedVehicleState;
  return hasWrite
    && executionFacts.completionStatus === "completed"
    && toolResult?.executionState === "observed-succeeded"
    && Boolean(confirmedSnapshotId.trim())
    && confirmedVehicleState
    && typeof confirmedVehicleState === "object"
    && !Array.isArray(confirmedVehicleState)
    && confirmedVehicleState.id === confirmedSnapshotId;
}

export function resolveWriteCompletionStatus(taskPlan = {}, executionFacts = {}) {
  const hasWrite = Array.isArray(taskPlan.steps)
    && taskPlan.steps.some((step) => step?.accessMode === "write");
  if (!hasWrite) return B2_WRITE_COMPLETION_STATUS.notApplicable;
  if (isExplicitSafetyReject(executionFacts.safetyDecision)) {
    return B2_WRITE_COMPLETION_STATUS.blocked;
  }
  return hasProviderConfirmedWriteSuccess(taskPlan, executionFacts)
    ? B2_WRITE_COMPLETION_STATUS.confirmed
    : B2_WRITE_COMPLETION_STATUS.unconfirmed;
}

export function buildB2SafetyRejectedResponse(executionFacts = {}) {
  const reason = typeof executionFacts.safetyDecision?.reason === "string"
    ? executionFacts.safetyDecision.reason.trim()
    : "";
  return reason
    ? `当前操作未通过安全校验：${reason}`
    : "当前操作未通过安全校验。";
}

function isExplicitSafetyReject(decision) {
  return decision?.allowed === false && decision?.action === "reject";
}

function summarizeTaskPlan(taskPlan = {}) {
  return {
    planId: taskPlan.planId,
    goalId: taskPlan.goalId,
    runId: taskPlan.runId,
    steps: Array.isArray(taskPlan.steps) ? taskPlan.steps.map((step) => ({
      stepId: step?.stepId,
      capabilityId: step?.capabilityId,
      accessMode: step?.accessMode,
      status: step?.status,
    })) : [],
    planningSummary: taskPlan.planningSummary,
    status: taskPlan.status,
  };
}

function buildTaskPlanShapeExample(goalEnvelope = {}, catalogProjection = [], semanticAuthority = null) {
  const catalog = Array.isArray(catalogProjection) ? catalogProjection : [];
  if (goalEnvelope.interactionType === "command") {
    return buildVehicleCommandTaskPlanExample(goalEnvelope, catalog, semanticAuthority);
  }
  if (isTrustedKnowledgeGoal(goalEnvelope)) {
    const manualRetrieve = catalog.find((candidate) => candidate?.id === "manual.retrieve");
    if (!manualRetrieve || typeof goalEnvelope.objective !== "string" || !goalEnvelope.objective.trim()) return null;
    return buildTaskPlanExampleRoot(goalEnvelope, [{
      stepId: "retrieve-manual",
      capabilityId: manualRetrieve.id,
      dependsOn: [],
      input: { query: goalEnvelope.objective },
      expectedOutput: "manual-evidence",
      accessMode: "read",
      status: "planned",
    }]);
  }
  if (goalEnvelope.domain === "external-information") {
    const externalQuery = catalog.find((candidate) => candidate?.id === "external.query");
    if (!externalQuery) return null;
    return buildTaskPlanExampleRoot(goalEnvelope, [{
      stepId: "external-query",
      capabilityId: externalQuery.id,
      dependsOn: [],
      input: { query: goalEnvelope.objective || "external information query" },
      expectedOutput: "external.query-result",
      accessMode: "read",
      status: "planned",
    }]);
  }
  const capability = catalog.find((candidate) => candidate?.requiresSafety !== true)
    || catalog[0]
    || {
      id: "catalog-capability-id",
      accessMode: "read",
      inputSchema: { type: "object", required: [], properties: {} },
    };
  const step = {
    stepId: "step-1",
    capabilityId: capability.id,
    dependsOn: [],
    input: buildSchemaExample(capability.inputSchema),
    expectedOutput: `${capability.id}-result`,
    accessMode: capability.accessMode === "write" ? "write" : "read",
    status: "planned",
  };
  return buildTaskPlanExampleRoot(goalEnvelope, [step]);
}

function buildVehicleCommandTaskPlanExample(goalEnvelope, catalog, semanticAuthority = null) {
  const binding = resolveVehicleCommandExampleBinding(goalEnvelope, semanticAuthority);
  if (!binding) return null;
  const write = catalog.find((capability) => (
    capability?.id === binding.capabilityId && capability?.accessMode === "write"
  ));
  if (!write || !schemaAcceptsExample(write.inputSchema, binding.input)) return null;
  const safety = write.requiresSafety === true
    ? catalog.find((capability) => capability?.id === "safety.evaluate")
    : null;
  if (write.requiresSafety === true && !safety) return null;
  const confirmation = binding.capabilityId === "vehicle.tailgate.set"
    ? catalog.find((capability) => capability?.id === "confirmation.issue")
    : null;
  if (binding.capabilityId === "vehicle.tailgate.set" && !confirmation) return null;
  const response = catalog.find((capability) => capability?.id === "response.synthesize") || null;
  if (binding.capabilityId === "vehicle.tailgate.set" && !response) return null;

  const capabilities = [safety, confirmation, write, response].filter(Boolean);
  const tailgateStepIds = {
    "safety.evaluate": "safety-tailgate",
    "confirmation.issue": "confirmation-tailgate",
    "vehicle.tailgate.set": "write-tailgate",
    "response.synthesize": "response-tailgate",
  };
  const stepIds = capabilities.map((capability, index) => (
    binding.capabilityId === "vehicle.tailgate.set"
      ? tailgateStepIds[capability.id]
      : `${capability.id === "safety.evaluate" ? "safety" : capability.id === "response.synthesize" ? "response" : "write"}-${binding.stepSuffix || index + 1}`
  ));
  const steps = capabilities.map((capability, index) => ({
    stepId: stepIds[index],
    capabilityId: capability.id,
    dependsOn: index === 0 ? [] : [stepIds[index - 1]],
    input: capability.id === binding.capabilityId
      ? structuredClone(binding.input)
      : capability.id === "safety.evaluate" || capability.id === "confirmation.issue"
        ? { action: binding.safetyAction }
        : structuredClone(VEHICLE_SLU_RESPONSE_PLAN_INPUT),
    expectedOutput: `${capability.id}-result`,
    accessMode: capability.accessMode === "write" ? "write" : "read",
    status: "planned",
  }));
  return buildTaskPlanExampleRoot(goalEnvelope, steps);
}

function buildTaskPlanExampleRoot(goalEnvelope, steps) {
  return {
    planId: `plan:${goalEnvelope.runId || "run-id"}`,
    goalId: goalEnvelope.goalId || "goal-id",
    runId: goalEnvelope.runId || "run-id",
    steps,
    selectedCapabilities: steps.map(({ capabilityId }) => capabilityId),
    writeActionCount: steps.filter(({ accessMode }) => accessMode === "write").length,
    planningSummary: "Use catalog capabilities to pursue the goal.",
    model: "configured-local-model",
    provider: "ollama",
    status: "planned",
  };
}

function resolveVehicleCommandExampleBinding(goalEnvelope, semanticAuthority = null) {
  const vehicleSluFrames = Array.isArray(goalEnvelope?.contextRefs)
    ? goalEnvelope.contextRefs.filter((ref) => ref?.type === "vehicle-slu-frame-authority")
    : [];
  if (vehicleSluFrames.length !== 1) return null;
  const frame = vehicleSluFrames[0];
  if (!semanticAuthority || typeof semanticAuthority !== "object" || Array.isArray(semanticAuthority)) return null;
  if (semanticAuthority.contractVersion !== VEHICLE_SLU_CONTRACT.ref
    || semanticAuthority.requestId !== goalEnvelope?.runId
    || semanticAuthority.admittedWriteFrameId !== frame.frameId
    || !Array.isArray(semanticAuthority.allowedFrameIds)
    || !semanticAuthority.allowedFrameIds.includes(frame.frameId)
    || frame.capability !== "control"
    || frame.actionNeed !== "execute") return null;
  const binding = projectVehicleWriteBinding(frame);
  if (!binding) return null;
  const allowedCapabilityIds = new Set(semanticAuthority.allowedCapabilityIds || []);
  const requiredCapabilityIds = [
    "safety.evaluate",
    ...(binding.capabilityId === "vehicle.tailgate.set" ? ["confirmation.issue"] : []),
    binding.capabilityId,
    "response.synthesize",
  ];
  return requiredCapabilityIds.every((id) => allowedCapabilityIds.has(id)) ? binding : null;
}

function matchesVehicleSluPlanningProof(goalEnvelope, semanticEnvelope, semanticAuthority) {
  try {
    return plainDataEqual(goalEnvelope, createVehicleSluGoalEnvelope(semanticEnvelope))
      && plainDataEqual(semanticAuthority, createVehicleSluPlanAuthority(semanticEnvelope));
  } catch {
    return false;
  }
}

function createPlanBindingUnavailableError() {
  const error = new Error("vehicle command planning binding unavailable");
  error.code = "plan-binding-unavailable";
  error.telemetry = Object.freeze({
    degraded: true,
    reason: "plan-binding-unavailable",
    externalModelRequestCount: 0,
  });
  return error;
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

function schemaAcceptsExample(schema = {}, value) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return (schema.required || []).every((field) => (
      Object.hasOwn(value, field) && schemaAcceptsExample(schema.properties?.[field] || {}, value[field])
    ));
  }
  if (schema.type === "number") return Number.isFinite(value);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "array") return Array.isArray(value);
  return typeof value === "string" && value.length > 0;
}

function buildKnowledgeSubplanExample(delegation = {}, catalogProjection = []) {
  const catalog = Array.isArray(catalogProjection) ? catalogProjection : [];
  const allowed = new Map(catalog
    .filter((capability) => delegation.allowedCapabilities?.includes(capability?.id))
    .map((capability) => [capability.id, capability]));
  const completeEligibilityPlan = delegation.allowVehicleStateRead === true
    && delegation.requireSafetyEligibilityExplanation === true;
  const topology = completeEligibilityPlan
    ? KNOWLEDGE_ELIGIBILITY_TOPOLOGY
    : [
        { capabilityId: "knowledge.manual.retrieve", stepId: "manual", dependsOn: [] },
        { capabilityId: "knowledge.answer.synthesize", stepId: "answer", dependsOn: ["manual"] },
      ];
  const steps = topology.map((entry) => {
    const capability = allowed.get(entry.capabilityId);
    return {
      stepId: entry.stepId,
      capabilityId: entry.capabilityId,
      dependsOn: [...entry.dependsOn],
      input: entry.input
        ? structuredClone(entry.input)
        : buildKnowledgeCapabilityInputExample(capability, delegation),
      expectedOutput: `${entry.stepId}-result`,
      accessMode: "read",
      status: "planned",
    };
  });
  return {
    subplanId: `knowledge-plan:${delegation.runId || "run-id"}`,
    delegationId: delegation.delegationId || "delegation-id",
    runId: delegation.runId || "run-id",
    parentPlanId: delegation.parentPlanId || "parent-plan-id",
    parentStepId: delegation.parentStepId || "parent-step-id",
    steps,
    selectedCapabilities: steps.map(({ capabilityId }) => capabilityId),
    planningSummary: "Use only authorized completed evidence reads before synthesis.",
    model: "configured-local-model",
    provider: "ollama",
    status: "planned",
  };
}

function buildKnowledgeCapabilityInputExample(capability, delegation) {
  if (capability?.id === "knowledge.manual.retrieve") {
    return { query: delegation.knowledgeGoal || "vehicle knowledge question" };
  }
  if (capability?.id === "knowledge.answer.synthesize") {
    return {
      facts: {
        summary: "Synthesize only completed authorized evidence.",
        evidenceRefs: ["manual"],
      },
    };
  }
  return buildSchemaExample(capability?.inputSchema);
}

function buildKnowledgeClarificationExample(delegation = {}) {
  return {
    delegationId: delegation.delegationId || "delegation-id",
    runId: delegation.runId || "run-id",
    outcomeStatus: "clarification",
    questions: ["请补充需要了解的车型或功能对象。"],
    reasonCode: "ambiguous-knowledge-context",
    model: "configured-local-model",
    provider: "ollama",
  };
}

export function buildTrustedPlanningContextRefs(parsedCommand = {}) {
  const provenance = parsedCommand.slotProvenance && typeof parsedCommand.slotProvenance === "object"
    ? parsedCommand.slotProvenance
    : {};
  if (parsedCommand.intent !== "body.window.setPosition") return [];
  const zoneTrusted = ["explicit", "context"].includes(provenance.zone);
  const percentTrusted = ["explicit", "context"].includes(provenance.percent);
  if (!zoneTrusted || !percentTrusted
    || typeof parsedCommand.slots?.zone !== "string"
    || !Number.isFinite(parsedCommand.slots?.percent)) {
    return [];
  }
  return [{
    type: "trusted-command-slots",
    intent: parsedCommand.intent,
    targetZone: parsedCommand.slots.zone,
    percent: parsedCommand.slots.percent,
    provenance: {
      targetZone: provenance.zone,
      percent: provenance.percent,
    },
  }];
}

function buildGoalEnvelopeShapeExample(
  runId,
  rawText,
  parsedCommand = {},
  trustedPlanningContextRefs = buildTrustedPlanningContextRefs(parsedCommand),
) {
  const requestRunId = typeof runId === "string" && runId ? runId : "run-id";
  const planningAuthority = resolveConversationPlanningGoalAuthority(parsedCommand, rawText);
  const conversationGoal = parsedCommand.conversationGoal && typeof parsedCommand.conversationGoal === "object"
    ? parsedCommand.conversationGoal
    : {};
  return {
    goalId: `goal:${requestRunId}`,
    runId: requestRunId,
    objective: planningAuthority?.objective
      || String(rawText || "user objective"),
    interactionType: planningAuthority?.interactionType
      || conversationGoal.interactionType
      || parsedCommand.speechAct
      || "command",
    domain: planningAuthority?.domain
      || "vehicle-control",
    constraints: [],
    contextRefs: trustedPlanningContextRefs,
    requiredClarifications: [],
    readyForPlanning: true,
    model: "configured-local-model",
    provider: "ollama",
    confidenceStrength: "strong",
  };
}

export function resolveConversationPlanningGoalAuthority(parsedCommand = {}, rawText = "") {
  const conversationGoal = parsedCommand?.conversationGoal;
  if (!conversationGoal || typeof conversationGoal !== "object" || Array.isArray(conversationGoal)
    || typeof rawText !== "string" || !rawText.trim()) return null;
  const semanticDomain = conversationGoal.domain;
  const weather = semanticDomain === "weather"
    || conversationGoal.externalDataType === "weather"
    || parsedCommand?.slots?.topic === "weather_query";
  const planningDomain = weather
    ? "external-information"
    : ["vehicle_knowledge", "manual_knowledge"].includes(semanticDomain)
      ? "manual"
      : "";
  if (!planningDomain) return null;
  return Object.freeze({
    objective: rawText,
    interactionType: typeof conversationGoal.interactionType === "string"
      && conversationGoal.interactionType.trim()
      ? conversationGoal.interactionType.trim()
      : "question",
    domain: planningDomain,
  });
}

function buildSchemaExample(schema = {}) {
  if (Object.hasOwn(schema, "const")) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return structuredClone(schema.enum[0]);
  if (schema.type === "object") {
    return Object.fromEntries((schema.required || []).map((field) => [
      field,
      buildSchemaExample(schema.properties?.[field]),
    ]));
  }
  if (schema.type === "array") return [];
  if (schema.type === "number") return 0;
  if (schema.type === "boolean") return false;
  return "value";
}

function buildConversationPrompt(rawText, parsedCommand, context) {
  const route = resolveConversationRoute("", parsedCommand || {});
  const hasVehicleKnowledge = route.isVehicleKnowledge;
  const { memoryContext, ...nonMemoryContext } = context || {};
  return [
    "你是车载本地智能助手，正在车内和用户自然对话。",
    "请用简洁、自然、适合语音播报的中文回答，控制在 1 到 3 句话，优先直接回答问题。",
    "如果用户问天气：服务端会优先尝试 Open-Meteo 天气 adapter；如果没有返回 weatherData，才说明未接入或不可用，不要编造天气、气温或预警。",
    "车内/座舱空气质量属于车辆知识；外部/城市/今天空气质量属于天气或实时数据。",
    "如果用户问美食、餐厅或附近推荐：当前没有接入真实地图、POI、定位和营业状态，不要编造具体店名、距离、评分或地址。",
    "如果用户问最新信息、新闻、政策、价格、网页搜索或需要联网核验的问题：当前没有接入云端联网搜索，不要编造网页事实、来源或时间。",
    "如果语义槽位 slots.needsClarification 为 true：直接追问 slots.clarification，不要编造成已执行动作。",
    hasVehicleKnowledge
      ? "如果用户问车辆知识：优先基于下方 ES8 官方用户手册证据回答；未提供相关证据时不得编造具体操作、安全限制、故障处理或维修步骤。"
      : "如果用户问车辆知识：当前知识范围为 ES8 官方用户手册；未提供相关证据时只能给一般说明，不能编造手册步骤。",
    "可以给出口味方向、选择建议、询问偏好，或建议接入地图后再给真实店铺。",
    "不要声称已经执行车控动作；车控动作必须由 Vehicle Tools 执行。",
    "会话短期记忆只用于开放对话的指代与追问。它不是车辆、位置、天气、POI、路况、确认、手册或执行状态的事实来源；不能据此补齐或改写车控参数。",
    hasVehicleKnowledge ? `车辆知识上下文：\n${buildVehicleKnowledgeContext(rawText)}` : "",
    `用户输入：${String(rawText || "").trim()}`,
    `语义槽位：${JSON.stringify(parsedCommand?.slots || {})}`,
    `会话短期记忆（仅供开放对话引用，每条均含 turnId/provenance/expiry）：${JSON.stringify(memoryContext || null)}`,
    `车辆上下文：${JSON.stringify(nonMemoryContext)}`,
  ].filter(Boolean).join("\n");
}

function buildConversationFallback(rawText, parsedCommand, reason, manualEvidence = []) {
  if (Array.isArray(manualEvidence) && manualEvidence.length) {
    return buildManualEvidenceFallback(manualEvidence, reason);
  }
  const text = String(rawText || parsedCommand?.rawText || "").trim();
  const slots = parsedCommand?.slots || {};
  const route = resolveConversationRoute("", parsedCommand || {});
  return buildConversationBoundaryResponse(text, route, {
    reason,
    externalDataType: route.externalDataType,
    requiresExternalData: route.requiresExternalData,
    needsClarification: slots.needsClarification,
    clarification: slots.clarification,
    buildVehicleKnowledgeFallback,
    buildGeneralQaFallback,
  });
}

function buildManualEvidenceFallback(evidence, reason = "") {
  const entries = evidence.slice(0, 2).map((item) => {
    const pages = item.pageEnd && item.pageEnd !== item.pageStart ? `${item.pageStart}-${item.pageEnd}` : item.pageStart;
    const section = item.sectionTitle || item.citation || "相关章节";
    return `《ES8 用户手册》第 ${pages} 页「${section}」：${item.excerpt || "未提供可引用摘录"}`;
  });
  return `本地对话模型不可用，以下仅转述已检索到的用户手册证据，不补充未引用的步骤或限制：${entries.join("；")}。${reason ? `降级原因：${reason}` : ""}`;
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
