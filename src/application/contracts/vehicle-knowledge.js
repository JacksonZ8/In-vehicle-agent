export const VEHICLE_KNOWLEDGE_CONTRACT = Object.freeze({
  id: "nio-vehicle-knowledge-contract@1.0.0",
  version: "1.0.0",
});

export const KNOWLEDGE_OUTCOME_STATUSES = Object.freeze([
  "answered", "clarification", "not-applicable", "unavailable",
]);

export const KNOWLEDGE_SUPPORT_STATUSES = Object.freeze([
  "supported", "partial", "unsupported",
]);

const DELEGATION_FIELDS = new Set([
  "delegationId", "runId", "parentPlanId", "parentStepId", "knowledgeGoal",
  "vehicleScope", "allowedCapabilities", "allowVehicleStateRead",
  "requireSafetyEligibilityExplanation", "expectedAnswerContract", "dependsOn",
]);
const SUBPLAN_FIELDS = new Set([
  "subplanId", "delegationId", "runId", "parentPlanId", "parentStepId", "steps",
  "selectedCapabilities", "planningSummary", "model", "provider", "status",
]);
const STEP_FIELDS = new Set([
  "stepId", "capabilityId", "dependsOn", "input", "expectedOutput", "accessMode", "status",
]);
const ANSWER_FIELDS = new Set([
  "delegationId", "runId", "outcomeStatus", "supportStatus", "answer", "evidenceRefs",
  "vehicleStateRefs", "safetyAssessmentRef", "limitations", "model", "provider",
  "durationMs", "degraded",
]);
const CLARIFICATION_FIELDS = new Set([
  "delegationId", "runId", "outcomeStatus", "questions", "reasonCode", "model", "provider",
]);
const TERMINAL_FIELDS = new Set([
  "delegationId", "runId", "outcomeStatus", "reasonCode", "limitations", "degraded",
]);
const FORBIDDEN_RESULT_FIELDS = new Set([
  "toolCall", "toolResult", "writeActionCount", "rawPrompt", "rawModelResponse", "chainOfThought",
]);

export function createKnowledgeDelegation(input = {}) {
  rejectUnknownFields(input, DELEGATION_FIELDS, "delegation");
  requireStrings(input, [
    "delegationId", "runId", "parentPlanId", "parentStepId", "knowledgeGoal",
    "vehicleScope", "expectedAnswerContract",
  ]);
  requireStringArray(input.allowedCapabilities, "allowedCapabilities", { nonEmpty: true });
  requireStringArray(input.dependsOn, "dependsOn");
  requireBoolean(input.allowVehicleStateRead, "allowVehicleStateRead");
  requireBoolean(
    input.requireSafetyEligibilityExplanation,
    "requireSafetyEligibilityExplanation",
  );
  return deepFreeze({
    delegationId: input.delegationId.trim(),
    runId: input.runId.trim(),
    parentPlanId: input.parentPlanId.trim(),
    parentStepId: input.parentStepId.trim(),
    knowledgeGoal: input.knowledgeGoal.trim(),
    vehicleScope: input.vehicleScope.trim(),
    allowedCapabilities: [...input.allowedCapabilities],
    allowVehicleStateRead: input.allowVehicleStateRead,
    requireSafetyEligibilityExplanation: input.requireSafetyEligibilityExplanation,
    expectedAnswerContract: input.expectedAnswerContract.trim(),
    dependsOn: [...input.dependsOn],
  });
}

// Both eligibility flags are only granted for a Vehicle-SLU tailgate eligibility frame, so a
// complete eligibility authority already identifies a fixed eligibility plan.
export function isKnowledgeClarificationAllowed(delegation = {}) {
  return !(delegation.vehicleScope === "nio-es8-user-manual-2026"
    && delegation.allowVehicleStateRead === true
    && delegation.requireSafetyEligibilityExplanation === true);
}

export function createKnowledgeSubplan(input = {}) {
  rejectUnknownFields(input, SUBPLAN_FIELDS, "knowledge subplan");
  requireStrings(input, [
    "subplanId", "delegationId", "runId", "parentPlanId", "parentStepId",
    "planningSummary", "model", "provider", "status",
  ]);
  if (!Array.isArray(input.steps)) throw new TypeError("steps must be an array");
  requireStringArray(input.selectedCapabilities, "selectedCapabilities");
  const steps = input.steps.map((step, index) => normalizeStep(step, index));
  if (steps.some((step) => step.accessMode !== "read")) {
    throw new TypeError("knowledge subplan steps must be read-only");
  }
  if (input.selectedCapabilities.length !== steps.length
    || input.selectedCapabilities.some((id, index) => id !== steps[index].capabilityId)) {
    throw new TypeError("selectedCapabilities must match knowledge subplan steps");
  }
  return deepFreeze({
    subplanId: input.subplanId.trim(),
    delegationId: input.delegationId.trim(),
    runId: input.runId.trim(),
    parentPlanId: input.parentPlanId.trim(),
    parentStepId: input.parentStepId.trim(),
    steps,
    selectedCapabilities: [...input.selectedCapabilities],
    planningSummary: input.planningSummary.trim(),
    model: input.model.trim(),
    provider: input.provider.trim(),
    status: input.status.trim(),
  });
}

export function createKnowledgeAnswer(input = {}) {
  rejectForbiddenResultFields(input);
  rejectUnknownFields(input, ANSWER_FIELDS, "knowledge answer");
  requireStrings(input, [
    "delegationId", "runId", "outcomeStatus", "supportStatus", "answer", "model", "provider",
  ]);
  if (input.outcomeStatus !== "answered") {
    throw new TypeError("knowledge answer outcomeStatus must be answered");
  }
  if (!KNOWLEDGE_SUPPORT_STATUSES.includes(input.supportStatus)) {
    throw new TypeError("unknown knowledge supportStatus");
  }
  requirePlainDataArray(input.evidenceRefs, "evidenceRefs");
  requirePlainDataArray(input.vehicleStateRefs, "vehicleStateRefs");
  requireStringArray(input.limitations, "limitations");
  if (input.safetyAssessmentRef !== null && !isRecord(input.safetyAssessmentRef)) {
    throw new TypeError("safetyAssessmentRef must be an object or null");
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new TypeError("durationMs must be a non-negative number");
  }
  requireBoolean(input.degraded, "degraded");
  if (input.supportStatus === "supported"
    && input.evidenceRefs.length === 0
    && input.vehicleStateRefs.length === 0
    && input.safetyAssessmentRef === null) {
    throw new TypeError("supported answer requires evidence, vehicle state, or Safety assessment");
  }
  return deepFreeze({
    delegationId: input.delegationId.trim(),
    runId: input.runId.trim(),
    outcomeStatus: "answered",
    supportStatus: input.supportStatus,
    answer: input.answer.trim(),
    evidenceRefs: clone(input.evidenceRefs),
    vehicleStateRefs: clone(input.vehicleStateRefs),
    safetyAssessmentRef: clone(input.safetyAssessmentRef),
    limitations: [...input.limitations],
    model: input.model.trim(),
    provider: input.provider.trim(),
    durationMs: input.durationMs,
    degraded: input.degraded,
  });
}

export function createKnowledgeClarificationRequest(input = {}) {
  rejectForbiddenResultFields(input);
  rejectUnknownFields(input, CLARIFICATION_FIELDS, "knowledge clarification");
  requireStrings(input, ["delegationId", "runId", "outcomeStatus", "reasonCode", "model", "provider"]);
  if (input.outcomeStatus !== "clarification") {
    throw new TypeError("knowledge clarification outcomeStatus must be clarification");
  }
  requireStringArray(input.questions, "questions", { nonEmpty: true });
  return deepFreeze({
    delegationId: input.delegationId.trim(),
    runId: input.runId.trim(),
    outcomeStatus: "clarification",
    questions: [...input.questions],
    reasonCode: input.reasonCode.trim(),
    model: input.model.trim(),
    provider: input.provider.trim(),
  });
}

export function createKnowledgeTerminalResult(input = {}) {
  rejectForbiddenResultFields(input);
  rejectUnknownFields(input, TERMINAL_FIELDS, "knowledge terminal result");
  requireStrings(input, ["delegationId", "runId", "outcomeStatus", "reasonCode"]);
  if (!["not-applicable", "unavailable"].includes(input.outcomeStatus)) {
    throw new TypeError(
      input.outcomeStatus === "answered"
        ? "answered outcome requires createKnowledgeAnswer"
        : "terminal outcomeStatus must be not-applicable or unavailable",
    );
  }
  requireStringArray(input.limitations, "limitations");
  requireBoolean(input.degraded, "degraded");
  return deepFreeze({
    delegationId: input.delegationId.trim(),
    runId: input.runId.trim(),
    outcomeStatus: input.outcomeStatus,
    reasonCode: input.reasonCode.trim(),
    limitations: [...input.limitations],
    degraded: input.degraded,
  });
}

function normalizeStep(step, index) {
  if (!isRecord(step)) throw new TypeError(`knowledge subplan step ${index} must be an object`);
  rejectUnknownFields(step, STEP_FIELDS, `knowledge subplan step ${index}`);
  requireStrings(step, ["stepId", "capabilityId", "expectedOutput", "accessMode", "status"]);
  requireStringArray(step.dependsOn, `steps[${index}].dependsOn`);
  if (!isRecord(step.input)) throw new TypeError(`steps[${index}].input must be an object`);
  return {
    stepId: step.stepId.trim(),
    capabilityId: step.capabilityId.trim(),
    dependsOn: [...step.dependsOn],
    input: clone(step.input),
    expectedOutput: step.expectedOutput.trim(),
    accessMode: step.accessMode.trim(),
    status: step.status.trim(),
  };
}

function rejectForbiddenResultFields(input) {
  for (const field of Object.keys(isRecord(input) ? input : {})) {
    if (FORBIDDEN_RESULT_FIELDS.has(field)) {
      throw new TypeError(`forbidden knowledge result field: ${field}`);
    }
  }
}

function rejectUnknownFields(input, allowedFields, label) {
  if (!isRecord(input)) throw new TypeError(`${label} must be an object`);
  const unknown = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unknown) throw new TypeError(`unknown ${label} field: ${unknown}`);
}

function requireStrings(input, fields) {
  for (const field of fields) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      throw new TypeError(`${field} must be a non-empty string`);
    }
  }
}

function requireStringArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  if (nonEmpty && value.length === 0) throw new TypeError(`${label} must not be empty`);
}

function requirePlainDataArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new TypeError(`${label} must be an array of objects`);
  }
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
}

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

