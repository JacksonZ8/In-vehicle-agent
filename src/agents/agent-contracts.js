export const B2_MAX_PLAN_STEPS = 6;
export const B2_AGENT_CONTRACTS = Object.freeze({
  id: "nio-b2-agent-contracts",
  version: "1.0.0",
});

const GOAL_FIELDS = new Set([
  "goalId", "runId", "objective", "interactionType", "domain", "constraints",
  "contextRefs", "requiredClarifications", "readyForPlanning", "model", "provider",
  "confidenceStrength",
]);
const PLAN_FIELDS = new Set([
  "planId", "goalId", "runId", "steps", "selectedCapabilities", "writeActionCount",
  "planningSummary", "model", "provider", "status",
]);
const STEP_FIELDS = new Set([
  "stepId", "capabilityId", "dependsOn", "input", "expectedOutput", "accessMode", "status",
]);
const CLARIFICATION_FIELDS = new Set(["runId", "goalId", "questions", "reasonCode", "model", "provider"]);
const EXECUTION_FACTS_FIELDS = new Set([
  "runId", "goalId", "planId", "stepResults", "evidenceRefs", "safetyDecision", "toolResult",
  "confirmedVehicleState", "degraded", "failureReason", "completionStatus",
]);
const FORBIDDEN_EXECUTION_FACT_FIELDS = new Set([
  "requestedState", "adapterAcceptance", "rawPrompt", "rawModelResponse", "chainOfThought",
]);

export function createGoalEnvelope(input = {}) {
  const errors = validateGoalEnvelope(input);
  if (errors.length) throw new TypeError(errors.join("; "));
  return deepFreeze({
    goalId: input.goalId.trim(),
    runId: input.runId.trim(),
    objective: input.objective.trim(),
    interactionType: input.interactionType.trim(),
    domain: input.domain.trim(),
    constraints: [...input.constraints],
    contextRefs: clone(input.contextRefs),
    requiredClarifications: [...input.requiredClarifications],
    readyForPlanning: input.readyForPlanning,
    model: input.model.trim(),
    provider: input.provider.trim(),
    confidenceStrength: input.confidenceStrength.trim(),
  });
}

export function createClarificationRequest(input = {}) {
  const errors = validateClarificationRequest(input);
  if (errors.length) throw new TypeError(errors.join("; "));
  return deepFreeze({
    runId: input.runId.trim(),
    goalId: input.goalId.trim(),
    questions: [...input.questions],
    reasonCode: input.reasonCode.trim(),
    model: input.model.trim(),
    provider: input.provider.trim(),
  });
}

export function createTaskPlan(input = {}) {
  const normalized = {
    planId: input.planId,
    goalId: input.goalId,
    runId: input.runId,
    steps: Array.isArray(input.steps) ? input.steps.map((step) => ({
      stepId: step?.stepId,
      capabilityId: step?.capabilityId,
      dependsOn: Array.isArray(step?.dependsOn) ? [...step.dependsOn] : step?.dependsOn,
      input: isRecord(step?.input) ? clone(step.input) : step?.input,
      expectedOutput: step?.expectedOutput,
      accessMode: step?.accessMode,
      status: step?.status,
    })) : input.steps,
    selectedCapabilities: Array.isArray(input.selectedCapabilities) ? [...input.selectedCapabilities] : input.selectedCapabilities,
    planningSummary: input.planningSummary,
    model: input.model,
    provider: input.provider,
    status: input.status,
  };
  normalized.writeActionCount = Array.isArray(normalized.steps)
    ? normalized.steps.filter((step) => step.accessMode === "write").length
    : 0;
  const errors = [
    ...validateTaskPlanFields(input),
    ...validateTaskPlanShape(normalized),
  ];
  if (Object.hasOwn(input, "writeActionCount") && input.writeActionCount !== normalized.writeActionCount) {
    errors.push("writeActionCount must match steps");
  }
  if (errors.length) throw new TypeError(errors.join("; "));
  return deepFreeze({
    ...normalized,
    planId: normalized.planId.trim(),
    goalId: normalized.goalId.trim(),
    runId: normalized.runId.trim(),
    planningSummary: normalized.planningSummary.trim(),
    model: normalized.model.trim(),
    provider: normalized.provider.trim(),
    status: normalized.status.trim(),
    steps: normalized.steps.map((step) => ({
      ...step,
      stepId: step.stepId.trim(),
      capabilityId: step.capabilityId.trim(),
      expectedOutput: step.expectedOutput.trim(),
      accessMode: step.accessMode.trim(),
      status: step.status.trim(),
    })),
  });
}

export function createExecutionFacts(input = {}) {
  const errors = validateExecutionFacts(input);
  if (errors.length) throw new TypeError(errors.join("; "));
  return deepFreeze({
    runId: input.runId.trim(),
    goalId: input.goalId.trim(),
    planId: input.planId.trim(),
    stepResults: clone(input.stepResults),
    evidenceRefs: clone(input.evidenceRefs),
    safetyDecision: clone(input.safetyDecision),
    toolResult: clone(input.toolResult),
    confirmedVehicleState: clone(input.confirmedVehicleState),
    degraded: input.degraded,
    failureReason: input.failureReason.trim(),
    completionStatus: input.completionStatus.trim(),
  });
}

export function validateGoalEnvelope(input) {
  const errors = validateRecord(input, GOAL_FIELDS, "goal envelope");
  if (!isRecord(input)) return errors;
  validateRequiredStrings(input, ["goalId", "runId", "objective", "interactionType", "domain", "model", "provider", "confidenceStrength"], errors);
  validateStringArray(input.constraints, "constraints", errors);
  validatePlainDataArray(input.contextRefs, "contextRefs", errors);
  validateStringArray(input.requiredClarifications, "requiredClarifications", errors);
  if (typeof input.readyForPlanning !== "boolean") errors.push("readyForPlanning must be a boolean");
  return errors;
}

export function validateTaskPlanShape(input) {
  const errors = validateRecord(input, PLAN_FIELDS, "task plan");
  if (!isRecord(input)) return errors;
  validateRequiredStrings(input, ["planId", "goalId", "runId", "planningSummary", "model", "provider", "status"], errors);
  validateStringArray(input.selectedCapabilities, "selectedCapabilities", errors);
  validateArray(input.steps, "steps", errors);
  if (Array.isArray(input.steps)) {
    if (input.steps.length > B2_MAX_PLAN_STEPS) errors.push(`task plan must contain at most ${B2_MAX_PLAN_STEPS} steps`);
    for (const [index, step] of input.steps.entries()) validateStep(step, index, errors);
  }
  const writeActionCount = Array.isArray(input.steps)
    ? input.steps.filter((step) => step?.accessMode === "write").length
    : 0;
  if (writeActionCount > 1) errors.push("task plan must contain at most one write step");
  if (!Number.isInteger(input.writeActionCount) || input.writeActionCount < 0) {
    errors.push("writeActionCount must be a non-negative integer");
  } else if (input.writeActionCount !== writeActionCount) {
    errors.push("writeActionCount must match steps");
  }
  return errors;
}

function validateTaskPlanFields(input) {
  const errors = validateRecord(input, PLAN_FIELDS, "task plan");
  if (!isRecord(input) || !Array.isArray(input.steps)) return errors;
  for (const [index, step] of input.steps.entries()) {
    validateStep(step, index, errors);
  }
  return errors;
}

function validateClarificationRequest(input) {
  const errors = validateRecord(input, CLARIFICATION_FIELDS, "clarification request");
  if (!isRecord(input)) return errors;
  validateRequiredStrings(input, ["runId", "goalId", "reasonCode", "model", "provider"], errors);
  validateStringArray(input.questions, "questions", errors);
  if (Array.isArray(input.questions) && input.questions.length === 0) errors.push("questions must not be empty");
  return errors;
}

function validateExecutionFacts(input) {
  const errors = validateRecord(input, EXECUTION_FACTS_FIELDS, "execution facts", FORBIDDEN_EXECUTION_FACT_FIELDS);
  if (!isRecord(input)) return errors;
  validateRequiredStrings(input, ["runId", "goalId", "planId", "failureReason", "completionStatus"], errors, ["failureReason"]);
  validatePlainDataArray(input.stepResults, "stepResults", errors);
  validatePlainDataArray(input.evidenceRefs, "evidenceRefs", errors);
  for (const field of ["safetyDecision", "toolResult", "confirmedVehicleState"]) {
    if (input[field] !== null && (!isRecord(input[field]) || !isPlainData(input[field]))) {
      errors.push(`${field} must be an object or null`);
    }
  }
  if (typeof input.degraded !== "boolean") errors.push("degraded must be a boolean");
  return errors;
}

function validateStep(step, index, errors) {
  const prefix = `steps[${index}]`;
  if (!isRecord(step)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const key of Object.keys(step)) {
    if (!STEP_FIELDS.has(key)) errors.push(`unknown step field: ${key}`);
  }
  validateRequiredStrings(step, ["stepId", "capabilityId", "expectedOutput", "accessMode", "status"], errors, [], prefix);
  validateStringArray(step.dependsOn, `${prefix}.dependsOn`, errors);
  if (!isRecord(step.input)) errors.push(`${prefix}.input must be an object`);
  else if (!isPlainData(step.input)) errors.push(`${prefix}.input must contain plain data`);
  if (typeof step.accessMode === "string" && !["read", "write"].includes(step.accessMode.trim())) {
    errors.push(`${prefix}.accessMode must be read or write`);
  }
}

function validateRecord(input, allowedFields, label, forbiddenFields = new Set()) {
  if (!isRecord(input)) return [`${label} must be an object`];
  const errors = [];
  for (const key of Object.keys(input)) {
    if (forbiddenFields.has(key)) errors.push(`forbidden field: ${key}`);
    else if (!allowedFields.has(key)) errors.push(`unknown field: ${key}`);
  }
  return errors;
}

function validateRequiredStrings(input, fields, errors, allowEmpty = [], prefix = "") {
  for (const field of fields) {
    const label = prefix ? `${prefix}.${field}` : field;
    if (typeof input[field] !== "string" || (!allowEmpty.includes(field) && !input[field].trim())) {
      errors.push(`${label} must be a ${allowEmpty.includes(field) ? "string" : "non-empty string"}`);
    }
  }
}

function validateStringArray(value, label, errors) {
  validateArray(value, label, errors);
  if (Array.isArray(value) && value.some((item) => typeof item !== "string" || !item.trim())) {
    errors.push(`${label} must contain non-empty strings`);
  }
}

function validateArray(value, label, errors) {
  if (!Array.isArray(value)) errors.push(`${label} must be an array`);
}

function validatePlainDataArray(value, label, errors) {
  validateArray(value, label, errors);
  if (Array.isArray(value) && !isPlainData(value)) errors.push(`${label} must contain plain data`);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPlainData(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainData);
  return isRecord(value) && Object.values(value).every(isPlainData);
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return Object.freeze(value);
}
