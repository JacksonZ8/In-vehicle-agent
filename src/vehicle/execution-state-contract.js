export const VEHICLE_EXECUTION_STATES = Object.freeze([
  "submitted",
  "accepted",
  "executing",
  "duplicate-command",
  "observed-succeeded",
  "failed",
  "timeout",
]);

export const VEHICLE_EXECUTION_TERMINAL_STATES = Object.freeze([
  "duplicate-command",
  "observed-succeeded",
  "failed",
  "timeout",
]);

export const VEHICLE_EXECUTION_TRANSITIONS = Object.freeze({
  submitted: Object.freeze(["duplicate-command", "accepted", "failed", "timeout"]),
  accepted: Object.freeze(["executing"]),
  executing: Object.freeze(["observed-succeeded", "failed", "timeout"]),
  "duplicate-command": Object.freeze([]),
  "observed-succeeded": Object.freeze([]),
  failed: Object.freeze([]),
  timeout: Object.freeze([]),
});

function freezeCopy(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeCopy(item)])));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameStructuredFact(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object"
    || Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key) => Object.hasOwn(right, key) && sameStructuredFact(left[key], right[key]),
    );
}

function coversStructuredFact(observed, requested) {
  if (Object.is(observed, requested)) return true;
  if (!isRecord(observed) || !isRecord(requested)) return false;
  return Object.entries(requested).every(
    ([key, requestedValue]) => Object.hasOwn(observed, key)
      && coversStructuredFact(observed[key], requestedValue),
  );
}

export function inspectObservedSuccessProviderProof({
  toolResult,
  vehicleStateSnapshot,
  expectedRequestedState,
} = {}) {
  if (toolResult?.executionState !== "observed-succeeded") {
    return { ok: false, reason: "execution is not observed-succeeded" };
  }
  if (!isRecord(vehicleStateSnapshot)
    || typeof vehicleStateSnapshot.id !== "string"
    || !vehicleStateSnapshot.id
    || toolResult.confirmedSnapshotId !== vehicleStateSnapshot.id) {
    return { ok: false, reason: "confirmed snapshot id does not match Provider snapshot" };
  }
  const proofBoundaryMs = Math.max(...(Array.isArray(toolResult.executionTrace)
    ? toolResult.executionTrace
      .filter((item) => ["submitted", "accepted", "executing"].includes(item?.state))
      .map((item) => Date.parse(item.at || ""))
    : [NaN]));
  const snapshotCapturedAtMs = Date.parse(vehicleStateSnapshot.capturedAt || "");
  if (!Number.isFinite(proofBoundaryMs)
    || !Number.isFinite(snapshotCapturedAtMs)
    || snapshotCapturedAtMs < proofBoundaryMs) {
    return { ok: false, reason: "Provider snapshot time does not prove a post-execution observation" };
  }
  const requestedState = expectedRequestedState;
  if (!isRecord(requestedState)
    || !sameStructuredFact(toolResult.requestedState, requestedState)
    || !isRecord(vehicleStateSnapshot.values)
    || !isRecord(vehicleStateSnapshot.capturedAtByField)) {
    return { ok: false, reason: "Provider snapshot field facts are invalid" };
  }
  for (const field of Object.keys(requestedState)) {
    const fieldCapturedAtMs = Date.parse(vehicleStateSnapshot.capturedAtByField[field] || "");
    if (!Object.hasOwn(vehicleStateSnapshot.values, field)
      || !Number.isFinite(fieldCapturedAtMs)
      || fieldCapturedAtMs < proofBoundaryMs
      || !(field === "componentActionStateById"
        ? coversStructuredFact(vehicleStateSnapshot.values[field], requestedState[field])
        : sameStructuredFact(vehicleStateSnapshot.values[field], requestedState[field]))) {
      return { ok: false, reason: `Provider field ${field} lacks a post-execution observation` };
    }
  }
  return { ok: true };
}

export function inspectObservedConflictProviderProof({
  toolResult,
  vehicleStateSnapshot,
  expectedRequestedState,
} = {}) {
  if (toolResult?.executionState !== "failed"
    || toolResult?.executionError?.code !== "sensor-observation-conflict") {
    return { ok: false, reason: "execution is not an observed sensor conflict" };
  }
  if (!isRecord(vehicleStateSnapshot)
    || typeof vehicleStateSnapshot.id !== "string"
    || !vehicleStateSnapshot.id) {
    return { ok: false, reason: "Provider conflict snapshot is missing" };
  }
  const proofBoundaryMs = Math.max(...(Array.isArray(toolResult.executionTrace)
    ? toolResult.executionTrace
      .filter((item) => ["submitted", "accepted", "executing"].includes(item?.state))
      .map((item) => Date.parse(item.at || ""))
    : [NaN]));
  const snapshotCapturedAtMs = Date.parse(vehicleStateSnapshot.capturedAt || "");
  const requestedState = expectedRequestedState;
  if (!Number.isFinite(proofBoundaryMs)
    || !Number.isFinite(snapshotCapturedAtMs)
    || snapshotCapturedAtMs < proofBoundaryMs
    || !isRecord(requestedState)
    || !sameStructuredFact(toolResult.requestedState, requestedState)
    || !isRecord(vehicleStateSnapshot.values)
    || !isRecord(vehicleStateSnapshot.capturedAtByField)) {
    return { ok: false, reason: "Provider conflict snapshot facts are invalid" };
  }
  let differsFromRequested = false;
  for (const field of Object.keys(requestedState)) {
    const fieldCapturedAtMs = Date.parse(vehicleStateSnapshot.capturedAtByField[field] || "");
    if (!Object.hasOwn(vehicleStateSnapshot.values, field)
      || !Number.isFinite(fieldCapturedAtMs)
      || fieldCapturedAtMs < proofBoundaryMs) {
      return { ok: false, reason: `Provider field ${field} lacks a post-execution observation` };
    }
    if (!(field === "componentActionStateById"
      ? coversStructuredFact(vehicleStateSnapshot.values[field], requestedState[field])
      : sameStructuredFact(vehicleStateSnapshot.values[field], requestedState[field]))) {
      differsFromRequested = true;
    }
  }
  return differsFromRequested
    ? { ok: true }
    : { ok: false, reason: "Provider snapshot does not contain a conflicting actual state" };
}

export function inspectVehicleTerminalContract({
  toolResult,
  commitmentState,
  cancellation,
} = {}) {
  const executionState = toolResult?.executionState;
  if (!VEHICLE_EXECUTION_TERMINAL_STATES.includes(executionState)) {
    return { ok: false, reason: "vehicle execution is not terminal" };
  }
  if (toolResult.ok !== (executionState === "observed-succeeded")) {
    return { ok: false, reason: "terminal ok flag contradicts execution state" };
  }
  if (!cancellation
    || typeof cancellation !== "object"
    || Array.isArray(cancellation)
    || typeof cancellation.requested !== "boolean"
    || cancellation.physicalUndoClaimed !== false) {
    return { ok: false, reason: "terminal cancellation facts are invalid" };
  }

  const trace = toolResult.executionTrace;
  if (!Array.isArray(trace) || trace.length === 0) {
    return { ok: false, reason: "terminal execution trace is missing" };
  }
  let previousState;
  let previousAtMs = -Infinity;
  for (const [index, traceItem] of trace.entries()) {
    const atMs = Date.parse(traceItem?.at || "");
    if (!isRecord(traceItem)
      || !VEHICLE_EXECUTION_STATES.includes(traceItem.state)
      || typeof traceItem.source !== "string"
      || !traceItem.source.trim()
      || !Number.isFinite(atMs)
      || atMs < previousAtMs
      || (index === 0 && traceItem.state !== "submitted")
      || (previousState
        && !VEHICLE_EXECUTION_TRANSITIONS[previousState]?.includes(traceItem.state))) {
      return { ok: false, reason: "terminal execution trace is invalid" };
    }
    previousState = traceItem.state;
    previousAtMs = atMs;
  }
  if (previousState !== executionState) {
    return { ok: false, reason: "terminal execution trace does not reach execution state" };
  }

  const adapterAccepted = trace.some((traceItem) => traceItem.state === "accepted");
  const expectedCommitmentState = adapterAccepted ? "provider-terminal" : "dispatching";
  if (commitmentState !== expectedCommitmentState) {
    return { ok: false, reason: "terminal commitment contradicts execution trace" };
  }
  return { ok: true, adapterAccepted };
}

export function mergeConfirmedVehicleSnapshot(currentSnapshot, incomingSnapshot) {
  const incomingCapturedAtMs = Date.parse(incomingSnapshot?.capturedAt || "");
  if (!isRecord(incomingSnapshot)
    || typeof incomingSnapshot.id !== "string"
    || !incomingSnapshot.id
    || !isRecord(incomingSnapshot.values)
    || !isRecord(incomingSnapshot.capturedAtByField)
    || !Number.isFinite(incomingCapturedAtMs)) {
    return {
      snapshot: currentSnapshot || null,
      accepted: false,
      idempotent: false,
      reason: "incoming snapshot is invalid or unorderable",
    };
  }
  if (!currentSnapshot) {
    return {
      snapshot: incomingSnapshot,
      accepted: true,
      idempotent: false,
      reason: null,
    };
  }
  if (currentSnapshot.id === incomingSnapshot.id) {
    const idempotent = sameStructuredFact(currentSnapshot, incomingSnapshot);
    return {
      snapshot: currentSnapshot,
      accepted: false,
      idempotent,
      reason: idempotent ? null : "snapshot id maps to conflicting facts",
    };
  }
  const currentCapturedAtMs = Date.parse(currentSnapshot.capturedAt || "");
  if (!Number.isFinite(currentCapturedAtMs) || incomingCapturedAtMs <= currentCapturedAtMs) {
    return {
      snapshot: currentSnapshot,
      accepted: false,
      idempotent: false,
      reason: "incoming snapshot is not strictly newer",
    };
  }
  return {
    snapshot: incomingSnapshot,
    accepted: true,
    idempotent: false,
    reason: null,
  };
}

function createTraceItem(state, source, at, traceData = {}) {
  if (!source || !at) {
    throw new TypeError("execution trace requires source and at");
  }
  return freezeCopy({ ...traceData, state, source, at });
}

function validateExecutionError(error) {
  if (!error || typeof error !== "object" || Array.isArray(error)
    || !error.code || !error.message || !error.stage || typeof error.retryable !== "boolean") {
    throw new TypeError("invalid execution error");
  }
  return freezeCopy({
    code: error.code,
    message: error.message,
    stage: error.stage,
    retryable: error.retryable,
  });
}

export function isTerminalExecutionState(state) {
  return VEHICLE_EXECUTION_TERMINAL_STATES.includes(state);
}

export function createVehicleExecution({
  requestId, commandId, tool, requestedState, source, at,
}) {
  if (!commandId || typeof commandId !== "string") {
    throw new TypeError("commandId is required");
  }
  return freezeCopy({
    requestId,
    commandId,
    tool,
    requestedState: freezeCopy(requestedState),
    executionState: "submitted",
    executionTrace: [createTraceItem("submitted", source, at)],
  });
}

export function transitionVehicleExecution(
  execution,
  nextState,
  { source, at, error, traceData } = {},
) {
  const currentState = execution?.executionState;
  if (isTerminalExecutionState(currentState)) {
    throw new Error(`terminal execution state cannot transition: ${currentState}`);
  }
  if (!VEHICLE_EXECUTION_TRANSITIONS[currentState]?.includes(nextState)) {
    throw new Error(`illegal execution transition: ${currentState} -> ${nextState}`);
  }

  const executionError = ["failed", "timeout"].includes(nextState)
    ? validateExecutionError(error)
    : undefined;
  const executionTrace = [
    ...(execution.executionTrace || []).map(freezeCopy),
    createTraceItem(nextState, source, at, traceData),
  ];

  return freezeCopy({
    ...execution,
    executionState: nextState,
    executionTrace,
    ...(executionError ? { executionError } : {}),
  });
}

export class DevCommandRegistry {
  constructor({ now = () => Date.now(), timeoutCommandIds = [] } = {}) {
    this.now = now;
    this.seenCommandIds = new Set();
    this.timeoutCommandIds = new Set(timeoutCommandIds);
  }

  register(commandId) {
    if (!commandId || typeof commandId !== "string") {
      throw new TypeError("commandId is required for deduplication");
    }
    if (this.seenCommandIds.has(commandId)) return false;
    this.seenCommandIds.add(commandId);
    return true;
  }

}
