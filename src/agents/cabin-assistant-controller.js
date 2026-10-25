import {
  createClarificationRequest,
  createExecutionFacts,
  createGoalEnvelope,
  createTaskPlan,
} from "./agent-contracts.js";
import {
  createKnowledgeAnswer,
  createKnowledgeClarificationRequest,
  createKnowledgeDelegation,
  createKnowledgeSubplan,
  createKnowledgeTerminalResult,
} from "../application/contracts/vehicle-knowledge.js";
import { validateKnowledgeSubplan } from "./knowledge-plan-validator.js";
import { goalClaimsNoKnowledgeAuthority } from "./goal-authority.js";
import {
  createAbortError,
  throwIfAborted,
} from "../runtime/abort-utils.js";
import { classifyRuntimeResult } from "../application/result-semantics.js";

const TELEMETRY_FIELDS = Object.freeze([
  "model",
  "provider",
  "durationMs",
  "degraded",
  "reason",
  "reasonCode",
  "structuredRetryCount",
  "validationSubreason",
  "primaryFailureReasonCode",
  "fallbackActive",
  "fallbackAttempted",
  "externalModelRequestCount",
]);
const PUBLIC_MODEL_REASON_CODES = Object.freeze(new Set([
  "association-invalid",
  "evidence-ref-invalid",
  "forbidden-output-field",
  "generation-timeout",
  "knowledge-execution-unavailable",
  "knowledge-result-invalid",
  "knowledge-subplan-invalid",
  "model-timeout",
  "model-unavailable",
  "provider-auth-failed",
  "provider-config-invalid",
  "provider-network-error",
  "provider-rate-limited",
  "provider-request-budget-exhausted",
  "provider-response-invalid",
  "provider-safety-refusal",
  "provider-schema-invalid-after-repair",
  "provider-unavailable",
  "safety-assessment-ref-invalid",
  "vehicle-state-ref-invalid",
]));
const UNCONFIRMED_WRITE_RESPONSE = "写入操作尚未确认完成。";
const FOREGROUND_FALLBACK_RESPONSE = "我先处理你的车内请求。";
const FOREGROUND_PENDING_RESPONSE = "我先回应你的开放话题，车内请求正在处理中。";
const FOREGROUND_DISABLED_RESPONSE = "我先回应你的开放话题，本轮不会执行车内操作。";
const TURN_RELATIONS = Object.freeze(["new-goal", "follow-up", "correction"]);
const CURRENT_GOAL_SUMMARY_MAX_CHARS = 240;

export class CabinAssistantController {
  constructor(options = {}) {
    const unknownFields = Object.keys(options).filter((field) => !["modelAdapter", "now"].includes(field));
    if (unknownFields.length) throw new TypeError(`unknown constructor field: ${unknownFields[0]}`);
    if (!options.modelAdapter || typeof options.modelAdapter.formGoal !== "function"
      || typeof options.modelAdapter.synthesizeAgentResponse !== "function") {
      throw new TypeError("modelAdapter must provide formGoal() and synthesizeAgentResponse()");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("now must be a function");
    }
    this.modelAdapter = options.modelAdapter;
    this.now = options.now ?? Date.now;
  }

  async formGoal(input = {}) {
    throwIfAborted(input.signal);
    const startedAt = this.now();
    let modelResult;
    try {
      modelResult = await this.modelAdapter.formGoal({
        runId: input.runId,
        rawText: input.rawText,
        parsedCommand: input.parsedCommand,
        context: input.context,
        ...optionalTurnContext(input.signal, input.deadlineAt),
      });
      throwIfAborted(input.signal);
    } catch (error) {
      rethrowCancellation(error, input.signal);
      return freezeResult({
        goalEnvelope: null,
        clarificationRequest: null,
        telemetry: projectAgentModelTelemetry({
          durationMs: Math.max(0, this.now() - startedAt),
          degraded: true,
          reason: isTimeout(error) ? "model-timeout" : "model-unavailable",
        }),
        degraded: true,
      });
    }

    rejectCapabilityAndToolFields(modelResult?.output);
    const telemetry = projectAgentModelTelemetry(modelResult?.telemetry);
    if (isClarificationOutput(modelResult?.output)) {
      return freezeResult({
        goalEnvelope: null,
        clarificationRequest: createClarificationRequest(modelResult.output),
        telemetry,
        degraded: modelResult?.telemetry?.degraded === true,
      });
    }
    const goalEnvelope = createGoalEnvelope(modelResult?.output);
    if (!goalClaimsNoKnowledgeAuthority(goalEnvelope)) {
      throw new TypeError("GoalEnvelope claims knowledge authority without a Vehicle-SLU frame");
    }
    if (!goalEnvelope.readyForPlanning) {
      return freezeResult({
        goalEnvelope: null,
        clarificationRequest: createClarificationRequest({
          runId: goalEnvelope.runId,
          goalId: goalEnvelope.goalId,
          questions: goalEnvelope.requiredClarifications,
          reasonCode: "goal-requires-clarification",
          model: goalEnvelope.model,
          provider: goalEnvelope.provider,
        }),
        telemetry,
        degraded: modelResult?.telemetry?.degraded === true,
      });
    }
    return freezeResult({
      goalEnvelope,
      clarificationRequest: null,
      telemetry,
      degraded: modelResult?.telemetry?.degraded === true,
    });
  }

  async classifyTurnRelation(input = {}) {
    throwIfAborted(input.signal);
    if (typeof this.modelAdapter.classifyTurnRelation !== "function") {
      throw new TypeError("modelAdapter must provide classifyTurnRelation()");
    }
    requireNonEmptyText(input.sessionId, "sessionId");
    requireNonEmptyText(input.turnId, "turnId");
    requireNonEmptyText(input.rawText, "rawText");

    const modelResult = await this.modelAdapter.classifyTurnRelation({
      sessionId: input.sessionId,
      turnId: input.turnId,
      currentGoalSummary: summarizeCurrentGoal(input.currentGoal),
      rawText: input.rawText,
      ...optionalTurnContext(input.signal, input.deadlineAt),
    });
    throwIfAborted(input.signal);
    const classification = validateTurnRelationOutput(modelResult?.output);
    return freezeResult({
      ...classification,
      telemetry: projectAgentModelTelemetry(modelResult?.telemetry),
      degraded: modelResult?.telemetry?.degraded === true,
    });
  }

  async respondForeground(input = {}) {
    throwIfAborted(input.signal);
    if (typeof this.modelAdapter.respondForeground !== "function") {
      return freezeResult({
        text: FOREGROUND_FALLBACK_RESPONSE,
        telemetry: projectAgentModelTelemetry({ degraded: true, reason: "foreground-model-unavailable" }),
        degraded: true,
      });
    }
    const conversationGoal = validateForegroundConversationGoal(input.conversationGoal);
    const pendingFrameIds = validatePendingFrameIds(input.pendingFrameIds);
    try {
      const modelResult = await this.modelAdapter.respondForeground({
        conversationGoal,
        pendingFrameIds,
        executionDisabled: input.executionDisabled === true,
        ...optionalTurnContext(input.signal),
      });
      throwIfAborted(input.signal);
      const telemetry = projectAgentModelTelemetry(modelResult?.telemetry);
      return freezeResult({
        text: input.executionDisabled === true
          ? FOREGROUND_DISABLED_RESPONSE
          : FOREGROUND_PENDING_RESPONSE,
        telemetry,
        degraded: telemetry.degraded === true,
      });
    } catch (error) {
      rethrowCancellation(error, input.signal);
      return freezeResult({
        text: FOREGROUND_FALLBACK_RESPONSE,
        telemetry: projectAgentModelTelemetry({ degraded: true, reason: "foreground-response-failed" }),
        degraded: true,
      });
    }
  }

  async synthesize(input = {}) {
    throwIfAborted(input.signal);
    const goalEnvelope = createGoalEnvelope(input.goalEnvelope);
    const taskPlan = createTaskPlan(input.taskPlan);
    const executionFacts = createExecutionFacts(input.executionFacts);
    assertMatchingContractIdentifiers(goalEnvelope, taskPlan, executionFacts);
    const knowledgeClarification = resolveKnowledgeClarification(input.knowledgeResult, executionFacts.runId);
    if (knowledgeClarification) {
      return freezeResult({
        text: knowledgeClarification.questions[0],
        telemetry: projectAgentModelTelemetry({ degraded: false, reason: "knowledge-clarification" }),
        degraded: false,
      });
    }
    const knowledgeTerminal = resolveKnowledgeTerminal(input.knowledgeResult, executionFacts.runId);
    if (knowledgeTerminal) return knowledgeTerminal;
    const expectedStatus = resolveWriteCompletionStatus(taskPlan, executionFacts);

    try {
      const modelResult = await this.modelAdapter.synthesizeAgentResponse({
        runId: executionFacts.runId,
        goalEnvelope,
        taskPlan,
        executionFacts,
        knowledgeDelegation: input.knowledgeDelegation ?? null,
        knowledgeSubplan: input.knowledgeSubplan ?? null,
        knowledgeResult: input.knowledgeResult ?? null,
        executionDisabled: input.executionDisabled === true,
        deferredFrameIds: validatePendingFrameIds(input.deferredFrameIds ?? []),
        ...optionalTurnContext(input.signal, input.deadlineAt),
      });
      throwIfAborted(input.signal);
      const text = validateSynthesisOutput(modelResult?.output, expectedStatus, executionFacts);
      return freezeResult({
        text,
        telemetry: projectAgentModelTelemetry(modelResult?.telemetry),
        degraded: modelResult?.telemetry?.degraded === true,
      });
    } catch (error) {
      rethrowCancellation(error, input.signal);
      return freezeResult({
        text: expectedStatus === "unconfirmed" && !executionFacts.failureReason
          ? UNCONFIRMED_WRITE_RESPONSE
          : buildFactsOnlyFallback(executionFacts),
        telemetry: projectAgentModelTelemetry({ degraded: true, reason: "synthesis-failed" }),
        degraded: true,
      });
    }
  }

  async composeKnowledgeResponse(input = {}) {
    throwIfAborted(input.signal);
    if (typeof this.modelAdapter.synthesizeVehicleKnowledgeAnswer !== "function") {
      throw new TypeError("modelAdapter must provide synthesizeVehicleKnowledgeAnswer()");
    }
    const delegation = createKnowledgeDelegation(input.delegation);
    if (delegation.vehicleScope !== "nio-es8-user-manual-2026") {
      return knowledgeNotApplicableResult(delegation);
    }
    const subplan = createKnowledgeSubplan(input.subplan);
    const subplanValidation = validateKnowledgeSubplan(subplan, delegation);
    if (!subplanValidation.ok) {
      return knowledgeUnavailableResult(
        delegation,
        "knowledge-subplan-invalid",
        subplanValidation.errors,
      );
    }
    const executionFacts = deepFreeze(structuredClone(input.executionFacts ?? {}));
    if (delegation.requireSafetyEligibilityExplanation
      && executionFacts.outcomeStatus !== "completed") {
      return knowledgeUnavailableResult(
        delegation,
        executionFacts.reasonCode || "knowledge-execution-unavailable",
        ["车辆知识执行未完成，不能生成当前资格结论。"],
      );
    }

    const startedAt = this.now();
    let modelResult;
    try {
      modelResult = await this.modelAdapter.synthesizeVehicleKnowledgeAnswer({
        delegation,
        subplan,
        executionFacts,
        ...optionalTurnContext(input.signal, input.deadlineAt),
      });
      throwIfAborted(input.signal);
    } catch (error) {
      rethrowCancellation(error, input.signal);
      const errorTelemetry = error?.telemetry
        && typeof error.telemetry === "object"
        && !Array.isArray(error.telemetry)
        ? error.telemetry
        : {};
      const fallbackReason = isTimeout(error) ? "model-timeout" : "model-unavailable";
      const reasonCode = publicModelReasonCode(errorTelemetry.reasonCode)
        || publicModelReasonCode(errorTelemetry.reason)
        || fallbackReason;
      const failureDurationMs = Number.isFinite(errorTelemetry.durationMs)
        ? errorTelemetry.durationMs
        : Math.max(0, this.now() - startedAt);
      return knowledgeUnavailableResult(
        delegation,
        reasonCode,
        ["Cabin Assistant 知识回答阶段不可用。"],
        {
          ...errorTelemetry,
          durationMs: failureDurationMs,
          degraded: true,
          reason: reasonCode,
          reasonCode,
        },
      );
    }

    const telemetry = projectAgentModelTelemetry(modelResult?.telemetry);
    try {
      if (executionFacts.outcomeStatus === "completed"
        && modelResult?.output?.outcomeStatus !== "answered") {
        return knowledgeUnavailableResult(delegation, "knowledge-result-invalid", [
          "已完成的车辆知识执行必须返回 answered 终态。",
        ], telemetry);
      }
      const boundaryErrors = validateKnowledgeTerminalBoundary(modelResult?.output, executionFacts);
      if (boundaryErrors.length) {
        return knowledgeUnavailableResult(
          delegation,
          "knowledge-result-invalid",
          boundaryErrors,
          telemetry,
        );
      }
      const result = createKnowledgeTerminalOutput(
        applyKnowledgeSafetyAuthority(modelResult?.output, delegation, executionFacts),
      );
      if (result.delegationId !== delegation.delegationId || result.runId !== delegation.runId) {
        return knowledgeUnavailableResult(
          delegation,
          "association-invalid",
          ["模型输出关联不匹配。"],
          telemetry,
        );
      }
      return deepFreeze({
        result,
        validation: validKnowledgeTerminalValidation(result),
        telemetry,
      });
    } catch (error) {
      return knowledgeUnavailableResult(
        delegation,
        "knowledge-result-invalid",
        [knowledgeContractError(error)],
        telemetry,
      );
    }
  }

  presentKnowledgeBoundary(input = {}) {
    rejectUnknownKnowledgeBoundaryFields(input);
    requireNonEmptyText(input.runId, "runId");
    const hasResult = Object.hasOwn(input, "result");
    const hasVehicleState = Object.hasOwn(input, "vehicleStateSnapshot")
      || Object.hasOwn(input, "stateFields");
    if (hasResult === hasVehicleState) {
      throw new TypeError("knowledge boundary requires exactly one typed result or vehicle state");
    }

    if (hasVehicleState) {
      if (Object.hasOwn(input, "delegationId")) {
        throw new TypeError("vehicle-state boundary must not contain delegationId");
      }
      return freezeResult({
        text: renderVehicleStateResponse({
          stateFields: input.stateFields,
          vehicleStateSnapshot: input.vehicleStateSnapshot,
        }),
        outcomeStatus: "answered",
        reasonCode: "vehicle-state-provider-read",
        eventStatus: "completed",
        degraded: false,
        result: null,
      });
    }

    requireNonEmptyText(input.delegationId, "delegationId");
    const result = createKnowledgeTerminalOutput(input.result);
    if (result.runId !== input.runId.trim()
      || result.delegationId !== input.delegationId.trim()) {
      throw new TypeError("knowledge boundary result association must match runId and delegationId");
    }
    return freezeResult({
      text: renderKnowledgeBoundaryText(result),
      outcomeStatus: result.outcomeStatus,
      reasonCode: result.outcomeStatus === "answered" ? "" : result.reasonCode,
      eventStatus: result.outcomeStatus === "answered"
        ? "completed"
        : result.outcomeStatus === "clarification" ? "awaiting_clarification" : "unavailable",
      degraded: result.degraded === true,
      result,
    });
  }
}

const FORBIDDEN_KNOWLEDGE_RESULT_FIELDS = new Set([
  "toolcall", "toolresult", "writeactioncount", "rawprompt", "rawmodelresponse", "chainofthought",
  "tokencount", "providercommand", "adapteracceptance", "headers", "authorization", "toolargs",
]);

export function validateKnowledgeTerminalBoundary(output, executionFacts = {}) {
  const errors = [];
  const forbiddenPath = findForbiddenKnowledgeField(output);
  if (forbiddenPath) errors.push(`forbidden knowledge result field: ${forbiddenPath}`);
  if (output?.outcomeStatus !== "answered") return Object.freeze(errors);
  if (executionFacts?.outcomeStatus && executionFacts.outcomeStatus !== "completed") {
    errors.push("knowledge-execution-incomplete");
  }
  if (!knowledgeReferencesAreCompleted(output.evidenceRefs, executionFacts?.evidenceRefs)) {
    errors.push("evidence-ref-invalid");
  }
  if (!knowledgeReferencesAreCompleted(output.vehicleStateRefs, executionFacts?.vehicleStateRefs)) {
    errors.push("vehicle-state-ref-invalid");
  }
  if (output.safetyAssessmentRef !== null
    && !canonicalKnowledgeDataEqual(output.safetyAssessmentRef, executionFacts?.safetyAssessmentRef)) {
    errors.push("safety-assessment-ref-invalid");
  }
  if (executionFacts?.safetyAssessmentRef) {
    if (!Array.isArray(output.vehicleStateRefs) || output.vehicleStateRefs.length === 0) {
      errors.push("eligibility-vehicle-state-ref-required");
    }
    if (!output.safetyAssessmentRef) errors.push("eligibility-safety-assessment-required");
  }
  return Object.freeze(errors);
}

function applyKnowledgeSafetyAuthority(output, delegation, executionFacts) {
  if (output?.outcomeStatus !== "answered" || !delegation.requireSafetyEligibilityExplanation) {
    return output;
  }
  const assessment = executionFacts.safetyAssessmentRef;
  if (!assessment || typeof assessment.allowed !== "boolean"
    || !Array.isArray(executionFacts.vehicleStateRefs) || executionFacts.vehicleStateRefs.length === 0) {
    return output;
  }
  const reason = typeof assessment.reason === "string" && assessment.reason.trim()
    ? `：${assessment.reason.trim()}`
    : "。";
  const safetyConclusion = assessment.allowed
    ? `根据当前车辆状态与 Safety 评估，当前满足开启条件${reason}`
    : `根据当前车辆状态与 Safety 评估，当前不满足开启条件${reason}`;
  return { ...output, answer: safetyConclusion };
}

function knowledgeReferencesAreCompleted(references, completedReferences) {
  if (!Array.isArray(references) || !Array.isArray(completedReferences)) return false;
  return references.every((reference) => completedReferences.some(
    (completedReference) => canonicalKnowledgeDataEqual(reference, completedReference),
  ));
}

function findForbiddenKnowledgeField(value, path = "") {
  if (Array.isArray(value)) {
    for (const [index, nestedValue] of value.entries()) {
      const nested = findForbiddenKnowledgeField(nestedValue, `${path}[${index}]`);
      if (nested) return nested;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  for (const [key, nestedValue] of Object.entries(value)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KNOWLEDGE_RESULT_FIELDS.has(normalizeKnowledgeField(key))) return currentPath;
    const nested = findForbiddenKnowledgeField(nestedValue, currentPath);
    if (nested) return nested;
  }
  return "";
}

function normalizeKnowledgeField(value) {
  return String(value).toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function canonicalKnowledgeDataEqual(left, right) {
  return canonicalizeKnowledgeData(left) === canonicalizeKnowledgeData(right);
}

function canonicalizeKnowledgeData(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeKnowledgeData).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalizeKnowledgeData(value[key])}`
  )).join(",")}}`;
}

function createKnowledgeTerminalOutput(output) {
  switch (output?.outcomeStatus) {
    case "answered": return createKnowledgeAnswer(output);
    case "clarification": return createKnowledgeClarificationRequest(output);
    case "not-applicable":
    case "unavailable": return createKnowledgeTerminalResult(output);
    default: throw new TypeError("unknown knowledge result outcomeStatus");
  }
}

function knowledgeUnavailableResult(delegation, reasonCode, limitations, telemetry = {}) {
  const result = createKnowledgeTerminalResult({
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    outcomeStatus: "unavailable",
    reasonCode,
    limitations,
    degraded: true,
  });
  return deepFreeze({
    result,
    validation: validKnowledgeTerminalValidation(result),
    telemetry: projectAgentModelTelemetry({ ...telemetry, reasonCode }),
  });
}

function knowledgeNotApplicableResult(delegation) {
  const result = createKnowledgeTerminalResult({
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    outcomeStatus: "not-applicable",
    reasonCode: "vehicle-scope-not-applicable",
    limitations: ["首版仅接入 ES8 车型知识。"],
    degraded: false,
  });
  return deepFreeze({
    result,
    validation: validKnowledgeTerminalValidation(result),
    telemetry: {},
  });
}

function validKnowledgeTerminalValidation(result) {
  return { ok: true, status: "knowledge-result-valid", errors: [], result };
}

function rejectUnknownKnowledgeBoundaryFields(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("knowledge boundary input must be an object");
  }
  const allowedFields = new Set([
    "runId", "delegationId", "result", "stateFields", "vehicleStateSnapshot",
  ]);
  const unknown = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unknown) throw new TypeError(`unknown knowledge boundary field: ${unknown}`);
}

function renderKnowledgeBoundaryText(result) {
  if (result.outcomeStatus === "answered") return result.answer;
  if (result.outcomeStatus === "clarification") return result.questions[0];
  const limitation = result.limitations.find((item) => typeof item === "string" && item.trim()) ?? "";
  if (result.outcomeStatus === "not-applicable") {
    return limitation || "当前车辆知识范围不适用于该请求。";
  }
  return `抱歉，我们暂时无法完成${limitation ? `：${limitation.trim()}` : "。"}`;
}

function knowledgeContractError(error) {
  return error instanceof Error ? error.message : "invalid knowledge model output";
}

export function renderVehicleStateResponse(input = {}) {
  const stateFields = validatePendingFrameIds(input.stateFields);
  const snapshot = input.vehicleStateSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || !snapshot.values || typeof snapshot.values !== "object" || Array.isArray(snapshot.values)) {
    throw new TypeError("vehicleStateSnapshot must contain values");
  }
  return `当前车辆状态：${stateFields
    .map((field) => `${field}=${String(snapshot.values[field])}`)
    .join("，")}。`;
}

function validateForegroundConversationGoal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.summary !== "string" || typeof value.requiresReply !== "boolean") {
    throw new TypeError("conversationGoal must contain summary and requiresReply");
  }
  return Object.freeze({ summary: value.summary, requiresReply: value.requiresReply });
}

function validatePendingFrameIds(value) {
  if (!Array.isArray(value) || value.some((frameId) => typeof frameId !== "string" || !frameId.trim())) {
    throw new TypeError("pendingFrameIds must contain non-empty strings");
  }
  return Object.freeze([...new Set(value.map((frameId) => frameId.trim()))]);
}

function summarizeCurrentGoal(currentGoal) {
  const value = typeof currentGoal === "string"
    ? currentGoal
    : ["summary", "objective", "goal", "description"]
      .map((field) => currentGoal?.[field])
      .find((candidate) => typeof candidate === "string");
  return Array.from((value ?? "").normalize("NFKC").trim())
    .slice(0, CURRENT_GOAL_SUMMARY_MAX_CHARS)
    .join("");
}

function validateTurnRelationOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new TypeError("invalid turn relation output");
  }
  const fields = Object.keys(output);
  const expectedFields = ["relation", "reasonCode", "requiresClarification"];
  if (fields.length !== expectedFields.length
    || expectedFields.some((field) => !fields.includes(field))) {
    throw new TypeError("invalid turn relation output fields");
  }
  if (!TURN_RELATIONS.includes(output.relation)) {
    throw new TypeError("invalid turn relation");
  }
  if (typeof output.reasonCode !== "string"
    || Array.from(output.reasonCode).length < 1
    || Array.from(output.reasonCode).length > 80) {
    throw new TypeError("invalid turn relation reasonCode");
  }
  if (typeof output.requiresClarification !== "boolean") {
    throw new TypeError("invalid turn relation requiresClarification");
  }
  return Object.freeze({
    relation: output.relation,
    reasonCode: output.reasonCode,
    requiresClarification: output.requiresClarification,
  });
}

function resolveKnowledgeTerminal(value, runId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.runId !== runId) return null;
  if (value.outcomeStatus === "answered" && typeof value.answer === "string" && value.answer.trim()) {
    return freezeResult({
      text: value.answer.trim(),
      telemetry: projectAgentModelTelemetry({ degraded: value.degraded === true, reason: "knowledge-result-relay" }),
      degraded: value.degraded === true,
    });
  }
  if (value.outcomeStatus === "unavailable") {
    const limitation = Array.isArray(value.limitations) ? value.limitations.find((item) => typeof item === "string" && item.trim()) : "";
    return freezeResult({
      text: `抱歉，我们暂时无法完成${limitation ? `：${limitation.trim()}` : "。"}`,
      telemetry: projectAgentModelTelemetry({ degraded: true, reason: value.reasonCode || "knowledge-unavailable" }),
      degraded: true,
    });
  }
  if (value.outcomeStatus === "not-applicable") {
    const limitation = Array.isArray(value.limitations) ? value.limitations.find((item) => typeof item === "string" && item.trim()) : "";
    return freezeResult({
      text: limitation ? limitation.trim() : "当前车辆知识范围不适用于该请求。",
      telemetry: projectAgentModelTelemetry({ degraded: false, reason: value.reasonCode || "knowledge-not-applicable" }),
      degraded: false,
    });
  }
  return null;
}

export function projectAgentModelTelemetry(telemetry = {}) {
  const projected = {};
  if (telemetry && typeof telemetry === "object" && !Array.isArray(telemetry)) {
    for (const field of TELEMETRY_FIELDS) {
      if (!Object.hasOwn(telemetry, field)) continue;
      if (field === "reasonCode") {
        const reasonCode = publicModelReasonCode(telemetry[field]);
        if (reasonCode) projected.reasonCode = reasonCode;
        continue;
      }
      projected[field] = telemetry[field];
    }
  }
  return Object.freeze(projected);
}

function publicModelReasonCode(value) {
  return typeof value === "string" && PUBLIC_MODEL_REASON_CODES.has(value) ? value : null;
}

function rejectCapabilityAndToolFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) rejectCapabilityAndToolFields(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nestedValue] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (normalized.includes("capability") || normalized.includes("tool")) {
      throw new TypeError(`forbidden Cabin model field: ${key}`);
    }
    rejectCapabilityAndToolFields(nestedValue);
  }
}

function isClarificationOutput(output) {
  return output && typeof output === "object" && !Array.isArray(output)
    && (Object.hasOwn(output, "questions") || Object.hasOwn(output, "reasonCode"));
}

function validateSynthesisOutput(output, expectedStatus, facts) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new TypeError("invalid synthesis output");
  }
  const fields = Object.keys(output);
  if (fields.length !== 2 || !fields.includes("response") || !fields.includes("writeCompletionStatus")) {
    throw new TypeError("invalid synthesis output fields");
  }
  if (typeof output.response !== "string" || !output.response.trim()) {
    throw new TypeError("invalid synthesis response");
  }
  if (output.writeCompletionStatus !== expectedStatus) {
    throw new TypeError("synthesis cannot upgrade completion status");
  }
  if (expectedStatus === "unconfirmed" && output.response !== UNCONFIRMED_WRITE_RESPONSE) {
    throw new TypeError("unconfirmed write response must remain conservative");
  }
  if (expectedStatus === "blocked" && output.response !== buildSafetyRejectedResponse(facts)) {
    throw new TypeError("blocked write response must preserve the Safety rejection");
  }
  return output.response.trim();
}

function resolveWriteCompletionStatus(taskPlan, facts) {
  const hasWrite = taskPlan.steps.some((step) => step.accessMode === "write");
  if (!hasWrite) return "not-applicable";
  if (isExplicitSafetyReject(facts.safetyDecision)) return "blocked";
  const snapshotId = facts.toolResult?.confirmedSnapshotId;
  const confirmed = facts.toolResult?.executionState === "observed-succeeded"
    && facts.completionStatus === "completed"
    && typeof snapshotId === "string"
    && snapshotId.trim().length > 0
    && facts.confirmedVehicleState?.id === snapshotId;
  return confirmed ? "confirmed" : "unconfirmed";
}

function assertMatchingContractIdentifiers(goalEnvelope, taskPlan, facts) {
  const matches = taskPlan.runId === goalEnvelope.runId
    && taskPlan.goalId === goalEnvelope.goalId
    && facts.runId === goalEnvelope.runId
    && facts.goalId === goalEnvelope.goalId
    && facts.planId === taskPlan.planId;
  if (!matches) throw new TypeError("goal, plan, and execution facts contract identifiers must match");
}

function buildFactsOnlyFallback(facts) {
  if (facts.failureReason) return `抱歉，暂时无法完成：${facts.failureReason}。`;
  const classification = classifyRuntimeResult({
    safetyAction: facts.safetyDecision?.action,
    executionState: facts.toolResult?.executionState,
  });
  if (classification.status === "safety_rejected") return buildSafetyRejectedResponse(facts);
  if (classification.status === "execution_uncertain" || classification.status === "execution_failed") {
    return "抱歉，操作结果尚未确认完成。";
  }
  if (facts.completionStatus === "completed"
    && facts.toolResult?.executionState === "observed-succeeded"
    && facts.confirmedVehicleState?.id === facts.toolResult?.confirmedSnapshotId) {
    return "操作已由车辆状态确认完成。";
  }
  return "抱歉，操作结果尚未确认完成。";
}

function isExplicitSafetyReject(decision) {
  return decision?.allowed === false && decision?.action === "reject";
}

function buildSafetyRejectedResponse(facts) {
  const reason = typeof facts?.safetyDecision?.reason === "string"
    ? facts.safetyDecision.reason.trim()
    : "";
  return reason
    ? `当前操作未通过安全校验：${reason}`
    : "当前操作未通过安全校验。";
}

function resolveKnowledgeClarification(value, runId) {
  if (!value || value.outcomeStatus !== "clarification") return null;
  const clarification = createKnowledgeClarificationRequest(value);
  if (clarification.runId !== runId) throw new TypeError("knowledge clarification runId must match execution facts");
  return clarification;
}

function isTimeout(error) {
  return /timeout|timed out/i.test(`${error?.name || ""} ${error?.message || ""}`);
}

function rethrowCancellation(error, signal) {
  if (signal?.aborted) {
    throw createAbortError(signal?.reason ?? error);
  }
}

function optionalTurnContext(signal, deadlineAt) {
  return {
    ...(signal !== undefined ? { signal } : {}),
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  };
}

function requireNonEmptyText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function freezeResult(value) {
  return Object.freeze(value);
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
