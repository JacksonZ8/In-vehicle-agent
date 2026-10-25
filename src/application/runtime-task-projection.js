import { createExecutionFacts } from "../agents/agent-contracts.js";
import { createTaskSnapshot } from "./background-task-coordinator.js";

export function projectUseCaseFragment(routeDecision, fragment, runId) {
  if (routeDecision?.routeId !== "task" || routeDecision?.mode !== "orchestrated") return fragment;
  if (fragment === null || typeof fragment !== "object" || Array.isArray(fragment)) {
    throw new TypeError("orchestrated task must return a fragment object");
  }
  const taskStatus = String(fragment.status ?? "").trim();
  if (!["completed", "failed", "cancelled"].includes(taskStatus)) throw new TypeError("unsupported task status");
  const executionFacts = createExecutionFacts(fragment.executionFacts);
  if (executionFacts.runId !== runId) throw new TypeError("ExecutionFacts runId must match Runtime runId");
  const validatedSnapshot = fragment.taskSnapshot == null ? null : createTaskSnapshot(fragment.taskSnapshot);
  if (validatedSnapshot
    && (validatedSnapshot.runId !== runId || validatedSnapshot.status !== taskStatus)) {
    throw new TypeError("TaskSnapshot identifiers and status must match Runtime task");
  }
  const committedEffects = projectCommittedEffects(validatedSnapshot?.committedEffects
    ?? fragment.committedEffects);
  if (Object.hasOwn(fragment, "committedEffects")
    && JSON.stringify(projectCommittedEffects(fragment.committedEffects))
      !== JSON.stringify(committedEffects)) {
    throw new TypeError("TaskSnapshot committed effects must match task fragment");
  }
  const completedFacts = executionFacts.completionStatus === "completed";
  const safetyRejected = executionFacts.safetyDecision?.allowed === false
    && executionFacts.safetyDecision?.action === "reject";
  if ((taskStatus === "completed" && !completedFacts)
    || (taskStatus === "failed" && completedFacts && !safetyRejected)
    || (taskStatus === "cancelled" && completedFacts && committedEffects.length === 0)) {
    throw new TypeError("task status must match ExecutionFacts completionStatus");
  }
  assertCommittedEffectsMatchFacts(committedEffects, executionFacts);
  const taskSnapshot = validatedSnapshot == null
    ? null : createTaskSnapshot({ ...validatedSnapshot, committedEffects });
  const modelCalls = projectTaskModelCalls(fragment.modelCalls);
  const degraded = taskStatus !== "completed"
    || fragment.degraded === true
    || executionFacts.degraded === true
    || modelCalls.some((call) => call?.telemetry?.degraded === true);
  return Object.freeze({
    assistantResponse: typeof fragment.assistantResponse === "string" ? fragment.assistantResponse.trim() : "",
    modelCalls,
    degraded,
    taskStatus,
    status: taskStatus,
    executionFacts,
    committedEffects,
    taskSnapshot,
    safetyDecision: executionFacts.safetyDecision,
    toolCall: null,
    toolResult: executionFacts.toolResult,
    vehicleStateSnapshot: executionFacts.confirmedVehicleState,
  });
}
const COMMITTED_EFFECT_FIELDS = Object.freeze(
  ["stepId", "capabilityId", "commandId", "tool", "executionState", "confirmedSnapshotId"],
);

function projectCommittedEffects(value) {
  if (!Array.isArray(value)) throw new TypeError("committedEffects must be an array");
  if (value.length > 1) throw new TypeError("orchestrated task may expose at most one committed effect");
  return Object.freeze(value.map((effect) => {
    if (effect === null || typeof effect !== "object" || Array.isArray(effect)) {
      throw new TypeError("committed effect must be an object");
    }
    const projected = Object.fromEntries(COMMITTED_EFFECT_FIELDS.map((field) => {
      const fieldValue = typeof effect[field] === "string" ? effect[field].trim() : "";
      if (!fieldValue) throw new TypeError(`committed effect ${field} must be a non-empty string`);
      return [field, fieldValue];
    }));
    if (projected.executionState !== "observed-succeeded") {
      throw new TypeError("committed effect must be Provider-confirmed");
    }
    return Object.freeze(projected);
  }));
}

function assertCommittedEffectsMatchFacts(effects, facts) {
  const toolResult = facts.toolResult;
  assertToolResultBoundary(toolResult, facts.confirmedVehicleState, facts.runId);
  for (const step of facts.stepResults) {
    const result = step?.result;
    assertToolResultBoundary(result?.toolResult, result?.confirmedVehicleState, facts.runId);
  }
  const providerConfirmed = hasProviderConfirmation(toolResult, facts.confirmedVehicleState);
  const confirmedSteps = facts.stepResults.filter((step) => (
    hasProviderConfirmation(step?.result?.toolResult, step?.result?.confirmedVehicleState)
  ));
  if ((!providerConfirmed && confirmedSteps.length > 0)
    || (providerConfirmed
      && (confirmedSteps.length !== 1 || confirmedSteps[0].status !== "completed"))) {
    throw new TypeError("top-level and step Provider-confirmed ExecutionFacts must match");
  }
  if (effects.length !== (providerConfirmed ? 1 : 0)) {
    throw new TypeError("committed effect count must match Provider-confirmed ExecutionFacts");
  }
  if (!providerConfirmed) return;
  const effect = effects[0];
  const step = confirmedSteps[0];
  const stepToolResult = step?.result?.toolResult;
  const stepState = step?.result?.confirmedVehicleState;
  if (step?.stepId !== effect.stepId
    || step?.capabilityId !== effect.capabilityId
    || step?.status !== "completed"
    || toolResult.commandId !== effect.commandId
    || toolResult.tool !== effect.tool
    || toolResult.confirmedSnapshotId !== effect.confirmedSnapshotId
    || stepToolResult?.ok !== true
    || stepToolResult?.commandId !== effect.commandId
    || stepToolResult?.tool !== effect.tool
    || stepToolResult?.executionState !== effect.executionState
    || stepToolResult?.confirmedSnapshotId !== effect.confirmedSnapshotId
    || stepState?.id !== effect.confirmedSnapshotId) {
    throw new TypeError("committed effect must match Provider-confirmed ExecutionFacts");
  }
}

function hasProviderConfirmation(toolResult, confirmedState) {
  return toolResult?.ok === true
    && toolResult.executionState === "observed-succeeded"
    && typeof toolResult.confirmedSnapshotId === "string"
    && toolResult.confirmedSnapshotId.trim() !== ""
    && confirmedState?.id === toolResult.confirmedSnapshotId;
}

function assertToolResultBoundary(toolResult, confirmedState, runId) {
  if (toolResult == null) return;
  const claimsSuccess = toolResult.ok === true
    || ["observed-succeeded", "succeeded", "success", "completed"]
      .includes(toolResult.executionState)
    || Object.hasOwn(toolResult, "confirmedSnapshotId");
  if (claimsSuccess && !hasProviderConfirmation(toolResult, confirmedState)) {
    throw new TypeError("incomplete Provider-confirmed ToolResult success claim");
  }
  if (toolResult.requestId !== runId) {
    throw new TypeError("ToolResult requestId must match ExecutionFacts runId");
  }
  const tool = typeof toolResult.tool === "string" ? toolResult.tool : "";
  const commandId = typeof toolResult.commandId === "string" ? toolResult.commandId : "";
  const prefix = `${runId}:`;
  const suffix = `:${tool}`;
  const sequenceText = commandId.startsWith(prefix) && commandId.endsWith(suffix)
    ? commandId.slice(prefix.length, -suffix.length)
    : "";
  const sequence = Number(sequenceText);
  if (!tool || !/^[1-9]\d*$/.test(sequenceText) || !Number.isSafeInteger(sequence)) {
    throw new TypeError("ToolResult commandId must be canonical for ExecutionFacts runId");
  }
}

const TASK_MODEL_CALL_PHASES = new Set([
  "goal-formation", "task-planning", "final-synthesis",
  "knowledge-subplanning", "knowledge-answer",
]);

function projectTaskModelCalls(value) {
  if (!Array.isArray(value)) throw new TypeError("orchestrated task modelCalls must be an array");
  return Object.freeze(value.map((call) => {
    const phase = typeof call?.phase === "string" ? call.phase.trim() : "";
    if (!TASK_MODEL_CALL_PHASES.has(phase)) throw new TypeError("unsupported task model call phase");
    const source = call?.telemetry && typeof call.telemetry === "object" ? call.telemetry : {};
    const telemetry = {};
    for (const field of ["model", "provider", "reason"]) {
      if (typeof source[field] === "string") telemetry[field] = source[field];
    }
    if (Number.isFinite(source.durationMs)) telemetry.durationMs = source.durationMs;
    if (typeof source.degraded === "boolean") telemetry.degraded = source.degraded;
    if (Number.isInteger(source.structuredRetryCount)) {
      telemetry.structuredRetryCount = source.structuredRetryCount;
    }
    return Object.freeze({ phase, telemetry: Object.freeze(telemetry) });
  }));
}
