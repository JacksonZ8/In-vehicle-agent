import {
  createExecutionFacts,
  validateTaskPlanShape,
} from "../agents/agent-contracts.js";
import { getCapability } from "../agents/capability-catalog.js";
import { VEHICLE_STATE_KEYS } from "../safety/vehicle-state.js";
import { validateKnowledgeSubplan } from "../agents/knowledge-plan-validator.js";
import { isManualEvidenceRef } from "../manual/manual-evidence-eligibility.js";

const TERMINAL_STATES = new Set(["completed", "failed", "blocked"]);
const EVIDENCE_REF_FIELDS = ["id", "source", "type", "title", "citation", "snapshotId"];
const STRICT_MANUAL_EVIDENCE_REF_FIELDS = Object.freeze([
  "sourceId", "sourceVersion", "chunkId", "pageStart", "pageEnd", "excerpt", "score",
]);
const SAFETY_DECISION_FIELDS = [
  "allowed", "action", "reason", "alternative", "reasonCode", "vehicleStateSnapshotId", "policyId",
];
const CONFIRMATION_CHALLENGE_FIELDS = [
  "id", "requestId", "actionDigest", "policyId", "policyVersion", "issuedAt", "expiresAt",
  "responseToken",
];
const CONFIRMATION_ASSERTION_FIELDS = ["id", "prompt", "proofType", "riskType"];
const TOOL_RESULT_FIELDS = [
  "requestId", "commandId", "tool", "ok", "executionState", "confirmedSnapshotId",
  "hmiSummary", "visualScenario", "source", "simulated", "timestamp",
];
const MANUAL_RETRIEVAL_STATUSES = new Set(["hit", "miss", "unavailable"]);

export function createTaskPlanExecution(taskPlan) {
  const ownedPlan = deepFreeze(structuredClone(taskPlan));
  if (!isValidatedTaskPlan(ownedPlan)) {
    throw new TypeError("createTaskPlanExecution requires a validated TaskPlan");
  }

  const steps = new Map(ownedPlan.steps.map((step) => [
    step.stepId,
    {
      definition: step,
      status: "planned",
      result: null,
      failureReason: "",
    },
  ]));

  function findByCapability(capabilityId) {
    for (const entry of steps.values()) {
      if (entry.definition.capabilityId === capabilityId) return stepSnapshot(entry);
    }
    return null;
  }

  function getWriteStep() {
    for (const entry of steps.values()) {
      if (entry.definition.accessMode === "write") return stepSnapshot(entry);
    }
    return null;
  }

  function canExecute(stepId) {
    const entry = steps.get(stepId);
    if (!entry) return decision(false, "unknown-step");
    if (entry.status !== "planned") return decision(false, "terminal");

    for (const dependencyId of entry.definition.dependsOn) {
      const dependency = steps.get(dependencyId);
      if (!dependency || dependency.status === "failed") {
        return decision(false, "dependency-failed");
      }
      if (dependency.status === "blocked") {
        if (entry.definition.capabilityId === "response.synthesize"
          && dependency.failureReason === "safety-rejected") continue;
        return decision(false, "dependency-failed");
      }
      if (dependency.status !== "completed") {
        return decision(false, "dependency-pending");
      }
    }
    if (entry.definition.accessMode === "write") {
      const safetyBlock = safetyDependencyBlockReason(entry.definition, steps);
      if (safetyBlock === "confirmation-owner-required") {
        return decision(true, safetyBlock);
      }
      if (safetyBlock) return decision(false, safetyBlock);
    }
    return decision(true, "ready");
  }

  function start(stepId) {
    const eligibility = canExecute(stepId);
    if (!eligibility.allowed) throw new Error(`cannot start step ${stepId}: ${eligibility.reasonCode}`);
    const entry = steps.get(stepId);
    entry.status = "running";
    return stepSnapshot(entry);
  }

  function complete(stepId, result = {}) {
    const entry = requireRunning(stepId, "complete");
    entry.result = projectStepResult(entry.definition, result);
    entry.status = "completed";
    return stepSnapshot(entry);
  }

  function fail(stepId, reason) {
    const entry = requireRunning(stepId, "fail");
    entry.failureReason = typeof reason === "string" ? reason.trim() : "";
    entry.status = "failed";
    return stepSnapshot(entry);
  }

  function blockSafetyRejected(stepId) {
    const eligibility = canExecute(stepId);
    if (eligibility.reasonCode !== "safety-rejected") {
      throw new Error(`cannot block step ${stepId}: safety-rejected authorization required`);
    }
    const entry = steps.get(stepId);
    entry.status = "blocked";
    entry.failureReason = "safety-rejected";
    return stepSnapshot(entry);
  }

  function cancel(reason = "turn-cancelled") {
    cancelNonterminalSteps(steps, reason);
    return snapshot();
  }

  function buildExecutionFacts(input = {}) {
    const safeInput = projectExecutionFactsInput(input);
    const writeEntry = [...steps.values()].find((entry) => entry.definition.accessMode === "write") ?? null;
    const ledgerToolResult = writeEntry?.result?.toolResult ?? null;
    const ledgerVehicleState = writeEntry?.result?.confirmedVehicleState ?? null;
    const providerConfirmed = writeEntry?.status === "completed"
      && hasMatchingProviderConfirmation(ledgerToolResult, ledgerVehicleState);
    const hasWrite = ownedPlan.steps.some((step) => step.accessMode === "write");
    const safetyDecision = completedSafetyDecision(steps);
    const safetyRejectedWrite = writeEntry?.status === "blocked"
      && writeEntry.failureReason === "safety-rejected"
      && isExplicitSafetyReject(safetyDecision);
    const safeToolResult = ledgerToolResult === null
      ? null
      : providerConfirmed
        ? ledgerToolResult
        : withoutKey(ledgerToolResult, "confirmedSnapshotId");

    return createExecutionFacts({
      runId: ownedPlan.runId,
      goalId: ownedPlan.goalId,
      planId: ownedPlan.planId,
      stepResults: [...steps.values()].map((entry) => ({
        stepId: entry.definition.stepId,
        capabilityId: entry.definition.capabilityId,
        status: entry.status,
        ...(entry.result === null ? {} : { result: entry.result }),
        ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
      })),
      evidenceRefs: resolveExecutionEvidenceRefs(safeInput.evidenceRefs, steps),
      safetyDecision,
      toolResult: safeToolResult,
      confirmedVehicleState: providerConfirmed ? ledgerVehicleState : null,
      degraded: typeof safeInput.degraded === "boolean" ? safeInput.degraded : false,
      failureReason: typeof safeInput.failureReason === "string" ? safeInput.failureReason : "",
      completionStatus: !allStepsResolved(steps)
        || (hasWrite && !providerConfirmed && !safetyRejectedWrite)
        ? "incomplete"
        : typeof safeInput.completionStatus === "string" && safeInput.completionStatus.trim()
          ? safeInput.completionStatus
          : "completed",
    });
  }

  function snapshot() {
    return deepFreeze({
      runId: ownedPlan.runId,
      goalId: ownedPlan.goalId,
      planId: ownedPlan.planId,
      steps: [...steps.values()].map(stepSnapshot),
    });
  }

  function requireRunning(stepId, operation) {
    const entry = steps.get(stepId);
    if (!entry) throw new Error(`cannot ${operation} step ${stepId}: unknown-step`);
    if (TERMINAL_STATES.has(entry.status)) {
      throw new Error(`cannot ${operation} step ${stepId}: terminal`);
    }
    if (entry.status !== "running") {
      throw new Error(`cannot ${operation} step ${stepId}: step-not-running`);
    }
    return entry;
  }

  return Object.freeze({
    findByCapability,
    getWriteStep,
    canExecute,
    start,
    complete,
    fail,
    blockSafetyRejected,
    cancel,
    buildExecutionFacts,
    snapshot,
  });
}

export function createKnowledgeSubplanExecution(subplan, delegation) {
  const ownedSubplan = deepFreeze(structuredClone(subplan));
  const validation = validateKnowledgeSubplan(ownedSubplan, delegation);
  if (!validation.ok) {
    throw new TypeError("createKnowledgeSubplanExecution requires a validated KnowledgeSubplan");
  }

  const steps = new Map(ownedSubplan.steps.map((step) => [
    step.stepId,
    { definition: step, status: "planned", result: null, failureReason: "" },
  ]));

  function findByCapability(capabilityId) {
    for (const entry of steps.values()) {
      if (entry.definition.capabilityId === capabilityId) return knowledgeStepSnapshot(entry);
    }
    return null;
  }

  function canExecute(stepId) {
    const entry = steps.get(stepId);
    if (!entry) return decision(false, "unknown-step");
    if (entry.status !== "planned") return decision(false, "terminal");
    for (const dependencyId of entry.definition.dependsOn) {
      const dependency = steps.get(dependencyId);
      if (!dependency || dependency.status === "failed") return decision(false, "dependency-failed");
      if (dependency.status !== "completed") return decision(false, "dependency-pending");
    }
    return decision(true, "ready");
  }

  function start(stepId) {
    const eligibility = canExecute(stepId);
    if (!eligibility.allowed) throw new Error(`cannot start knowledge step ${stepId}: ${eligibility.reasonCode}`);
    const entry = steps.get(stepId);
    entry.status = "running";
    return knowledgeStepSnapshot(entry);
  }

  function complete(stepId, result = {}) {
    const entry = requireKnowledgeStepRunning(steps, stepId, "complete");
    entry.result = deepFreeze(structuredClone(isRecord(result) ? result : {}));
    entry.status = "completed";
    return knowledgeStepSnapshot(entry);
  }

  function fail(stepId, reason) {
    const entry = requireKnowledgeStepRunning(steps, stepId, "fail");
    entry.failureReason = typeof reason === "string" ? reason.trim() : "";
    entry.status = "failed";
    return knowledgeStepSnapshot(entry);
  }

  function cancel(reason = "turn-cancelled") {
    cancelNonterminalSteps(steps, reason);
    return snapshot();
  }

  function snapshot() {
    return deepFreeze({
      delegationId: ownedSubplan.delegationId,
      subplanId: ownedSubplan.subplanId,
      steps: [...steps.values()].map(knowledgeStepSnapshot),
    });
  }

  return Object.freeze({ findByCapability, canExecute, start, complete, fail, cancel, snapshot });
}

function cancelNonterminalSteps(steps, reason) {
  const failureReason = typeof reason === "string" && reason.trim()
    ? reason.trim()
    : "turn-cancelled";
  for (const entry of steps.values()) {
    if (TERMINAL_STATES.has(entry.status)) continue;
    entry.status = "failed";
    entry.failureReason = failureReason;
  }
}

function isValidatedTaskPlan(taskPlan) {
  if (!isRecord(taskPlan)
    || !Object.isFrozen(taskPlan)
    || validateTaskPlanShape(taskPlan).length !== 0) return false;

  const indexes = new Map();
  for (const [index, step] of taskPlan.steps.entries()) {
    if (indexes.has(step.stepId)) return false;
    indexes.set(step.stepId, index);
    const capability = getCapability(step.capabilityId);
    if (!capability || capability.accessMode !== step.accessMode) return false;
  }
  for (const [index, step] of taskPlan.steps.entries()) {
    if (step.dependsOn.some((dependencyId) => !indexes.has(dependencyId) || indexes.get(dependencyId) >= index)) {
      return false;
    }
    const capability = getCapability(step.capabilityId);
    if (capability.requiresSafety && !hasSafetyAncestor(step, taskPlan.steps, indexes)) return false;
  }
  return taskPlan.selectedCapabilities.length === taskPlan.steps.length
    && taskPlan.selectedCapabilities.every((id, index) => id === taskPlan.steps[index]?.capabilityId);
}

function hasSafetyAncestor(step, planSteps, indexes, visited = new Set()) {
  if (visited.has(step.stepId)) return false;
  visited.add(step.stepId);
  for (const dependencyId of step.dependsOn) {
    const dependency = planSteps[indexes.get(dependencyId)];
    if (dependency?.capabilityId === "safety.evaluate") return true;
    if (dependency && hasSafetyAncestor(dependency, planSteps, indexes, visited)) return true;
  }
  return false;
}

function isAllowedSafetyResult(result) {
  return isRecord(result?.safetyDecision) && result.safetyDecision.allowed === true;
}

function isConfirmationRequiredSafetyResult(result) {
  return isRecord(result?.safetyDecision)
    && result.safetyDecision.allowed === false
    && result.safetyDecision.action === "require_confirmation";
}

function safetyDependencyBlockReason(step, steps, visited = new Set()) {
  if (visited.has(step.stepId)) return "";
  visited.add(step.stepId);
  let explicitReject = false;
  let confirmationOwnerRequired = false;
  for (const dependencyId of step.dependsOn) {
    const dependency = steps.get(dependencyId);
    if (!dependency) continue;
    if (dependency.definition.capabilityId === "safety.evaluate") {
      if (isAllowedSafetyResult(dependency.result)) continue;
      if (isConfirmationRequiredSafetyResult(dependency.result)) {
        confirmationOwnerRequired = true;
        continue;
      }
      if (isExplicitSafetyReject(dependency.result?.safetyDecision)) {
        explicitReject = true;
        continue;
      }
      return "dependency-failed";
    }
    const nestedReason = safetyDependencyBlockReason(dependency.definition, steps, visited);
    if (nestedReason === "dependency-failed") return nestedReason;
    if (nestedReason === "safety-rejected") explicitReject = true;
    if (nestedReason === "confirmation-owner-required") confirmationOwnerRequired = true;
  }
  if (explicitReject) return "safety-rejected";
  return confirmationOwnerRequired ? "confirmation-owner-required" : "";
}

function isExplicitSafetyReject(value) {
  return isRecord(value) && value.allowed === false && value.action === "reject";
}

function hasMatchingProviderConfirmation(toolResult, confirmedVehicleState) {
  const snapshotId = toolResult?.confirmedSnapshotId;
  return toolResult?.executionState === "observed-succeeded"
    && typeof snapshotId === "string"
    && Boolean(snapshotId.trim())
    && confirmedVehicleState?.id === snapshotId;
}

function collectEvidenceRefs(steps) {
  const refs = [];
  for (const entry of steps.values()) {
    if (Array.isArray(entry.result?.evidenceRefs)) refs.push(...entry.result.evidenceRefs);
  }
  return refs;
}

function resolveExecutionEvidenceRefs(inputEvidenceRefs, steps) {
  if (!Array.isArray(inputEvidenceRefs)) return collectEvidenceRefs(steps);
  return [
    ...inputEvidenceRefs,
    ...collectCompletedManualStrictEvidenceRefs(steps),
  ];
}

function collectCompletedManualStrictEvidenceRefs(steps) {
  const refs = [];
  for (const entry of steps.values()) {
    if (entry.definition.capabilityId !== "manual.retrieve" || entry.status !== "completed") continue;
    for (const reference of entry.result?.evidenceRefs || []) {
      if (isManualEvidenceRef(reference)) refs.push(reference);
    }
  }
  return refs;
}

function allStepsResolved(steps) {
  return [...steps.values()].every((entry) => entry.status === "completed" || entry.status === "blocked");
}

function stepSnapshot(entry) {
  return deepFreeze({
    ...structuredClone(entry.definition),
    status: entry.status,
    ...(entry.result === null ? {} : { result: structuredClone(entry.result) }),
    ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
  });
}

function knowledgeStepSnapshot(entry) {
  return deepFreeze({
    ...structuredClone(entry.definition),
    status: entry.status,
    ...(entry.result === null ? {} : { result: structuredClone(entry.result) }),
    ...(entry.failureReason ? { failureReason: entry.failureReason } : {}),
  });
}

function requireKnowledgeStepRunning(steps, stepId, operation) {
  const entry = steps.get(stepId);
  if (!entry) throw new Error(`cannot ${operation} knowledge step ${stepId}: unknown-step`);
  if (TERMINAL_STATES.has(entry.status)) {
    throw new Error(`cannot ${operation} knowledge step ${stepId}: terminal`);
  }
  if (entry.status !== "running") {
    throw new Error(`cannot ${operation} knowledge step ${stepId}: step-not-running`);
  }
  return entry;
}

function decision(allowed, reasonCode) {
  return Object.freeze({ allowed, reasonCode });
}

function projectStepResult(step, result) {
  if (!isRecord(result)) return Object.freeze({});
  const projected = {};
  const evidenceRefs = projectEvidenceRefs(result.evidenceRefs, {
    allowStrictManual: step.capabilityId === "manual.retrieve",
  });
  if (evidenceRefs.length) projected.evidenceRefs = evidenceRefs;
  if (step.capabilityId === "manual.retrieve") {
    if (MANUAL_RETRIEVAL_STATUSES.has(result.status)) projected.status = result.status;
    if (typeof result.reason === "string") projected.reason = result.reason;
  }
  if (step.capabilityId === "safety.evaluate" && isRecord(result.safetyDecision)) {
    projected.safetyDecision = projectSafetyDecision(result.safetyDecision);
  } else if (step.accessMode === "write") {
    if (isRecord(result.safetyDecision)) {
      projected.safetyDecision = projectSafetyDecision(result.safetyDecision);
    }
    if (isRecord(result.toolResult)) projected.toolResult = projectToolResult(result.toolResult);
    if (isRecord(result.confirmedVehicleState)) {
      projected.confirmedVehicleState = projectVehicleState(result.confirmedVehicleState);
    }
  } else if (typeof result.summary === "string") {
    projected.summary = result.summary;
  }
  return deepFreeze(projected);
}

function projectExecutionFactsInput(input) {
  if (!isRecord(input)) return {};
  return {
    ...(Array.isArray(input.evidenceRefs)
      ? { evidenceRefs: projectEvidenceRefs(input.evidenceRefs) }
      : {}),
    degraded: input.degraded === true,
    failureReason: typeof input.failureReason === "string" ? input.failureReason : "",
    completionStatus: typeof input.completionStatus === "string" ? input.completionStatus : "",
  };
}

function projectEvidenceRefs(value, { allowStrictManual = false } = {}) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((reference) => {
    if (isManualEvidenceRef(reference)) {
      return allowStrictManual ? [projectStrictManualEvidenceRef(reference)] : [];
    }
    if (looksLikeStrictManualEvidenceRef(reference)) return [];
    const legacyReference = projectStringFields(reference, EVIDENCE_REF_FIELDS);
    return Object.keys(legacyReference).length ? [legacyReference] : [];
  });
}

function projectStrictManualEvidenceRef(reference) {
  return {
    sourceId: reference.sourceId,
    sourceVersion: reference.sourceVersion,
    chunkId: reference.chunkId,
    pageStart: reference.pageStart,
    pageEnd: reference.pageEnd,
    excerpt: reference.excerpt,
    score: {
      retrieval: reference.score.retrieval,
      rerank: reference.score.rerank,
      grounding: reference.score.grounding,
    },
  };
}

function looksLikeStrictManualEvidenceRef(reference) {
  return STRICT_MANUAL_EVIDENCE_REF_FIELDS.some((field) => Object.hasOwn(reference, field));
}

function projectSafetyDecision(value) {
  const projected = {
    ...(typeof value.allowed === "boolean" ? { allowed: value.allowed } : {}),
    ...projectStringFields(value, SAFETY_DECISION_FIELDS.filter((field) => field !== "allowed")),
  };
  if (value.allowed === false
    && value.action === "require_confirmation"
    && isRecord(value.confirmationChallenge)) {
    projected.confirmationChallenge = projectConfirmationChallenge(value.confirmationChallenge);
  }
  return projected;
}

function projectConfirmationChallenge(value) {
  const challenge = projectStringFields(value, CONFIRMATION_CHALLENGE_FIELDS);
  if (Array.isArray(value.assertions)) {
    challenge.assertions = value.assertions
      .filter(isRecord)
      .map((assertion) => projectStringFields(assertion, CONFIRMATION_ASSERTION_FIELDS));
  }
  return challenge;
}

function projectToolResult(value) {
  const projected = {
    ...projectStringFields(value, TOOL_RESULT_FIELDS.filter((field) => !["ok", "simulated"].includes(field))),
    ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
    ...(typeof value.simulated === "boolean" ? { simulated: value.simulated } : {}),
  };
  if (isRecord(value.executionError)) {
    const executionError = {
      ...projectStringFields(value.executionError, ["code", "message", "stage"]),
      ...(typeof value.executionError.retryable === "boolean"
        ? { retryable: value.executionError.retryable }
        : {}),
    };
    if (Object.keys(executionError).length) projected.executionError = executionError;
  }
  return projected;
}

function projectVehicleState(value) {
  const projected = {
    ...projectStringFields(value, ["id", "capturedAt", "source"]),
    ...(typeof value.simulated === "boolean" ? { simulated: value.simulated } : {}),
    ...(typeof value.freshnessMs === "number" && Number.isFinite(value.freshnessMs)
      ? { freshnessMs: value.freshnessMs }
      : {}),
  };
  const values = isRecord(value.values) ? value.values : value;
  const projectedValues = {};
  for (const field of VEHICLE_STATE_KEYS) {
    if (["windowPositionPercentByZone", "componentActionStateById", "seatComfortByZone"].includes(field)) continue;
    const fieldValue = values[field];
    if (fieldValue === null
      || typeof fieldValue === "string"
      || typeof fieldValue === "boolean"
      || (typeof fieldValue === "number" && Number.isFinite(fieldValue))) {
      projectedValues[field] = fieldValue;
    }
  }
  if (isRecord(values.windowPositionPercentByZone)) {
    const positions = {};
    for (const zone of ["front_left", "front_right", "rear_left", "rear_right"]) {
      const percent = values.windowPositionPercentByZone[zone];
      if (typeof percent === "number" && Number.isFinite(percent)) positions[zone] = percent;
    }
    if (Object.keys(positions).length) projectedValues.windowPositionPercentByZone = positions;
  }
  if (isRecord(values.seatComfortByZone)) {
    const seatComfort = Object.fromEntries(Object.entries(values.seatComfortByZone)
      .filter(([, setting]) => isRecord(setting)
        && typeof setting.mode === "string"
        && Number.isInteger(setting.level))
      .map(([zone, setting]) => [zone, { mode: setting.mode, level: setting.level }]));
    if (Object.keys(seatComfort).length) projectedValues.seatComfortByZone = seatComfort;
  }
  if (isRecord(values.componentActionStateById)) {
    const componentActions = Object.fromEntries(
      Object.entries(values.componentActionStateById)
        .filter(([, actionValue]) => typeof actionValue === "number" && Number.isFinite(actionValue)),
    );
    if (Object.keys(componentActions).length) projectedValues.componentActionStateById = componentActions;
  }
  if (Object.keys(projectedValues).length) projected.values = projectedValues;
  return projected;
}

function projectStringFields(value, fields) {
  const projected = {};
  if (!isRecord(value)) return projected;
  for (const field of fields) {
    if (typeof value[field] === "string") {
      projected[field] = value[field];
    }
  }
  return projected;
}

function completedSafetyDecision(steps) {
  for (const entry of steps.values()) {
    if (entry.definition.accessMode === "write"
      && entry.status === "completed"
      && isRecord(entry.result?.safetyDecision)) {
      return entry.result.safetyDecision;
    }
  }
  for (const entry of steps.values()) {
    if (entry.definition.capabilityId === "safety.evaluate"
      && entry.status === "completed"
      && isRecord(entry.result?.safetyDecision)) {
      return entry.result.safetyDecision;
    }
  }
  return null;
}

function withoutKey(value, keyToRemove) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== keyToRemove));
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isRecord(value)) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
