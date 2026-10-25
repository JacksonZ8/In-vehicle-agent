export const RECOVERY_POLICY = Object.freeze({
  id: "nio-recovery-policy",
  version: "1.0.0",
  maxRequestsPerStage: 2,
});

export const RECOVERY_ACTIONS = Object.freeze([
  "retry-readonly",
  "continue-with-partial-facts",
  "ask-user",
  "degrade",
  "stop",
]);

const RECOVERY_ACTION_SET = new Set(RECOVERY_ACTIONS);
const SIDE_EFFECT_CLASSES = new Set(["none", "readonly", "vehicle-write"]);
const SAFETY_OUTCOME_CODES = new Set([
  "safety-blocked",
  "safety-rejected",
  "safety-not-authorized",
  "safety-confirmation-required",
  "confirmation-required",
  "clarification-required",
]);
const EVIDENCE_MISS_CODES = new Set([
  "evidence-miss",
  "manual-evidence-miss",
  "rag-miss",
  "manual-rag-miss",
]);
const CANCELLED_CODES = new Set([
  "turn-cancelled",
  "user-cancelled",
  "barge-in-replaced",
  "session-closed",
  "turn-deadline-exceeded",
  "superseded-before-start",
]);
const FORBIDDEN_FAILURE_FIELDS = new Set([
  "prompt",
  "rawprompt",
  "rawmodelresponse",
  "chainofthought",
  "authorization",
  "headers",
  "credentials",
  "secret",
]);
const SENSITIVE_FAILURE_FIELD_SUFFIXES = Object.freeze([
  "prompt",
  "rawmodelresponse",
  "chainofthought",
  "cot",
  "authorization",
  "authorizationheader",
  "headers",
  "secret",
  "token",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "password",
  "passwd",
  "cookie",
  "setcookie",
  "bearer",
  "bearertoken",
  "privatekey",
  "clientsecret",
  "credential",
  "credentials",
  "modeloutput",
  "modelresponse",
  "rawresponse",
  "rawoutput",
  "completion",
  "prompttext",
]);

export function createCapabilityFailure(input = {}) {
  if (!isRecord(input)) throw new TypeError("CapabilityFailure input must be an object");
  const structuredRepairCount = requireCount(
    input.structuredRepairCount ?? 0,
    "structuredRepairCount",
  );
  const transportRetryCount = requireCount(
    input.transportRetryCount ?? 0,
    "transportRetryCount",
  );
  if (structuredRepairCount + transportRetryCount > 1) {
    throw new TypeError("CapabilityFailure shared request budget must not exceed one retry");
  }

  const sideEffectClass = requireString(input.sideEffectClass, "sideEffectClass");
  if (!SIDE_EFFECT_CLASSES.has(sideEffectClass)) {
    throw new TypeError("sideEffectClass must be none, readonly, or vehicle-write");
  }
  const attempt = requireInteger(input.attempt, "attempt", 1);
  const remainingBudgetMs = requireFiniteNumber(
    input.remainingBudgetMs,
    "remainingBudgetMs",
    0,
  );
  const partialFacts = input.partialFacts === undefined
    ? []
    : sanitizePlainData(input.partialFacts, "partialFacts");

  return deepFreeze({
    failureId: requireString(input.failureId, "failureId"),
    sessionId: requireString(input.sessionId, "sessionId"),
    turnId: requireString(input.turnId, "turnId"),
    runId: requireString(input.runId, "runId"),
    stage: requireString(input.stage, "stage"),
    capabilityId: requireString(input.capabilityId, "capabilityId"),
    reasonCode: requireString(input.reasonCode, "reasonCode"),
    retryable: input.retryable === true,
    sideEffectClass,
    attempt,
    remainingBudgetMs,
    partialFacts,
    structuredRepairCount,
    transportRetryCount,
  });
}

export function authorizeRecovery({
  failure,
  proposal,
  turnContext = {},
  attemptTimeoutMs,
} = {}) {
  const normalizedFailure = createCapabilityFailure(failure);
  const action = normalizeProposalAction(proposal);
  const availableActions = normalizeAvailableActions(turnContext.availableActions);
  const timeoutMs = requireFiniteNumber(attemptTimeoutMs, "attemptTimeoutMs", 1);
  const policyVersion = `${RECOVERY_POLICY.id}@${RECOVERY_POLICY.version}`;

  const reject = (reasonCode) => deepFreeze({
    authorized: false,
    action,
    reasonCode,
    policyVersion,
  });
  const authorize = (reasonCode) => deepFreeze({
    authorized: true,
    action,
    reasonCode,
    policyVersion,
  });

  if (isCancelled(normalizedFailure, turnContext)) return reject("turn-cancelled");
  if (SAFETY_OUTCOME_CODES.has(normalizedFailure.reasonCode)) {
    return reject("safety-outcome-not-failure");
  }
  if (action === "retry-readonly"
    && EVIDENCE_MISS_CODES.has(normalizedFailure.reasonCode)) {
    return reject("evidence-miss-not-retryable");
  }
  if (action === "retry-readonly"
    && normalizedFailure.sideEffectClass === "vehicle-write") {
    return reject("vehicle-write-never-auto-retried");
  }
  if (!availableActions.includes(action)) return reject("proposal-not-available");

  if (action === "continue-with-partial-facts") {
    return hasPartialFacts(normalizedFailure.partialFacts)
      ? authorize("partial-facts-authorized")
      : reject("partial-facts-unavailable");
  }
  if (action !== "retry-readonly") {
    return authorize(`recovery-${action}-authorized`);
  }
  if (normalizedFailure.retryable !== true) return reject("failure-not-retryable");
  if (!["none", "readonly"].includes(normalizedFailure.sideEffectClass)) {
    return reject("side-effect-class-not-retryable");
  }
  if (normalizedFailure.attempt >= RECOVERY_POLICY.maxRequestsPerStage) {
    return reject("recovery-attempt-limit");
  }
  if (normalizedFailure.structuredRepairCount + normalizedFailure.transportRetryCount >= 1) {
    return reject("request-budget-exhausted");
  }
  if (normalizedFailure.remainingBudgetMs < timeoutMs) {
    return reject("insufficient-recovery-budget");
  }
  return authorize("readonly-retry-authorized");
}

function normalizeProposalAction(proposal) {
  const action = typeof proposal === "string" ? proposal : proposal?.action;
  if (!RECOVERY_ACTION_SET.has(action)) {
    throw new TypeError("proposal action must be a RecoveryPolicy allowlist value");
  }
  return action;
}

function normalizeAvailableActions(value) {
  if (!Array.isArray(value)) throw new TypeError("turnContext.availableActions must be an array");
  const actions = [];
  for (const action of value) {
    if (!RECOVERY_ACTION_SET.has(action)) {
      throw new TypeError("availableActions must contain only RecoveryPolicy allowlist values");
    }
    if (!actions.includes(action)) actions.push(action);
  }
  return Object.freeze(actions);
}

function isCancelled(failure, turnContext) {
  return turnContext?.cancelled === true
    || turnContext?.signal?.aborted === true
    || CANCELLED_CODES.has(failure.reasonCode);
}

function hasPartialFacts(value) {
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireInteger(value, name, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function requireCount(value, name) {
  return requireInteger(value, name, 0);
}

function requireFiniteNumber(value, name, minimum) {
  if (!Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

function sanitizePlainData(value, name) {
  if (value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePlainData(item, name));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (isForbiddenFailureField(key)) {
        throw new TypeError(`${name} must not contain private model or credential fields`);
      }
      return [key, sanitizePlainData(item, name)];
    }));
  }
  throw new TypeError(`${name} must contain only plain serializable data`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeFieldName(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isForbiddenFailureField(value) {
  const normalized = normalizeFieldName(value);
  return FORBIDDEN_FAILURE_FIELDS.has(normalized)
    || SENSITIVE_FAILURE_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isRecord(value)) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
