import assert from "node:assert/strict";
import * as hmiAnimation from "../../src/vehicle/hmi-animation-adapter.js";

const {
  applyHmiPresentation,
  completeDispatchedVehicleCommand,
  consumeCancelledVehicleTerminalEvent,
  mapVehicleExecutionToHmi,
  registerDispatchedVehicleCommand,
  reduceVehicleHmiState,
  reduceVehicleRuntimeResultTransaction,
} = hmiAnimation;

function toolResult({
  tool = "body.window.setPosition",
  commandId = "request-1:1:body.window.setPosition",
  executionState = "executing",
  requestedState = { windowPositionPercentByZone: { front_left: 50 } },
  confirmedSnapshotId,
} = {}) {
  const executionTrace = executionState === "observed-succeeded"
    ? [
      { state: "submitted", source: "hmi-test", at: "2026-07-26T00:00:00.000Z" },
      { state: "accepted", source: "hmi-test", at: "2026-07-26T00:00:00.100Z" },
      { state: "executing", source: "hmi-test", at: "2026-07-26T00:00:00.500Z" },
      { state: "observed-succeeded", source: "hmi-test", at: "2026-07-26T00:00:01.000Z" },
    ]
    : [];
  return {
    requestId: "request-1",
    commandId,
    tool,
    ok: executionState === "observed-succeeded",
    executionState,
    executionTrace,
    requestedState,
    ...(confirmedSnapshotId ? { confirmedSnapshotId } : {}),
  };
}

function snapshot(
  id = "snapshot-2",
  values = {},
  capturedAt = "2026-07-26T00:00:01.000Z",
) {
  const snapshotValues = {
    windowPositionPercentByZone: { front_left: 50 },
    tailgateOpen: false,
    driverBackrestAngle: 106,
    cabinTemperature: 23,
    airflow: "auto",
    passengerMode: "comfort",
    ...values,
  };
  return {
    id,
    source: "demo-sensor-simulator",
    simulated: true,
    capturedAt,
    values: snapshotValues,
    capturedAtByField: Object.fromEntries(
      Object.keys(snapshotValues).map((field) => [field, capturedAt]),
    ),
  };
}

function providerTerminalFacts(requested = false) {
  return {
    commitmentState: "provider-terminal",
    cancellation: {
      requested,
      physicalUndoClaimed: false,
    },
  };
}

for (const executionState of ["submitted", "accepted", "executing"]) {
  const pending = mapVehicleExecutionToHmi({
    toolResult: toolResult({ executionState }),
    vehicleStateSnapshot: snapshot(),
    previousConfirmedState: snapshot("snapshot-1"),
  });
  assert.equal(pending.phase, "pending");
  assert.equal(pending.noAnimation, true);
  assert.equal(pending.animationState, null);
}

const mismatchedConfirmation = mapVehicleExecutionToHmi({
  toolResult: toolResult({
    executionState: "observed-succeeded",
    confirmedSnapshotId: "snapshot-expected",
  }),
  vehicleStateSnapshot: snapshot("snapshot-other"),
  previousConfirmedState: snapshot("snapshot-1"),
  ...providerTerminalFacts(),
});
assert.equal(mismatchedConfirmation.phase, "unsupported");
assert.equal(mismatchedConfirmation.noAnimation, true);

const confirmedWindow = mapVehicleExecutionToHmi({
  toolResult: toolResult({
    executionState: "observed-succeeded",
    requestedState: { windowPositionPercentByZone: { front_left: 99 } },
    confirmedSnapshotId: "snapshot-2",
  }),
  vehicleStateSnapshot: snapshot("snapshot-2", {
    windowPositionPercentByZone: { front_left: 99 },
  }),
  previousConfirmedState: snapshot("snapshot-1"),
  ...providerTerminalFacts(),
});
assert.equal(confirmedWindow.phase, "confirmed");
assert.equal(confirmedWindow.component, "frontLeftWindow");
assert.deepEqual(confirmedWindow.animationState, {
  windowPositionPercent: 99,
  windowPositionPercentByZone: { front_left: 99 },
});
assert.equal(confirmedWindow.noAnimation, false);

assert.equal(typeof hmiAnimation.mapVehicleRuntimeResultToHmi, "function");
assert.equal(typeof hmiAnimation.mapCancelledVehicleEventToHmi, "function");
assert.equal(typeof consumeCancelledVehicleTerminalEvent, "function");

const mappedRuntimeResult = hmiAnimation.mapVehicleRuntimeResultToHmi({
  toolCall: {
    requestId: "request-1",
    commandId: "request-1:1:body.window.setPosition",
    tool: "body.window.setPosition",
    args: { zone: "front_left", percent: 50 },
  },
  toolResult: toolResult({
    executionState: "observed-succeeded",
    confirmedSnapshotId: "snapshot-2",
  }),
  vehicleStateSnapshot: snapshot("snapshot-2"),
  ...providerTerminalFacts(),
}, {
  previousConfirmedState: snapshot("snapshot-1"),
});
assert.equal(mappedRuntimeResult.phase, "confirmed");
assert.equal(mappedRuntimeResult.commandId, "request-1:1:body.window.setPosition");

for (const invalidProofSnapshot of [
  snapshot("snapshot-no-time", {}, null),
  snapshot("snapshot-early", {}, "2026-07-25T23:59:59.000Z"),
  snapshot("snapshot-opposite-provider-value", {
    windowPositionPercentByZone: { front_left: 10 },
  }),
  {
    ...snapshot("snapshot-field-early"),
    capturedAtByField: {
      ...snapshot("snapshot-field-early").capturedAtByField,
      windowPositionPercentByZone: "2026-07-26T00:00:00.100Z",
    },
  },
]) {
  const invalidProof = hmiAnimation.mapVehicleRuntimeResultToHmi({
    toolCall: {
      requestId: "request-1",
      commandId: "request-1:1:body.window.setPosition",
      tool: "body.window.setPosition",
      args: { zone: "front_left", percent: 50 },
    },
    toolResult: toolResult({
      executionState: "observed-succeeded",
      confirmedSnapshotId: invalidProofSnapshot.id,
    }),
    vehicleStateSnapshot: invalidProofSnapshot,
    ...providerTerminalFacts(),
  }, {
    previousConfirmedState: snapshot("snapshot-1"),
  });
  assert.equal(invalidProof.phase, "unsupported");
  assert.equal(invalidProof.noAnimation, true);
}

const cancelledTerminalEvent = {
  runId: "request-1",
  component: "vehicleTool",
  phase: "vehicle-execution",
  status: "completed",
  toolResult: toolResult({
      executionState: "observed-succeeded",
      confirmedSnapshotId: "snapshot-2",
  }),
  providerSnapshot: snapshot("snapshot-2"),
  ...providerTerminalFacts(true),
};

const dispatchedCommand = {
  requestId: cancelledTerminalEvent.runId,
  commandId: cancelledTerminalEvent.toolResult.commandId,
  tool: cancelledTerminalEvent.toolResult.tool,
  args: { zone: "front_left", percent: 50 },
};
const dispatchedRegistry = () => new Map([[
  dispatchedCommand.commandId,
  {
    ...dispatchedCommand,
    expectedRequestedState: { windowPositionPercentByZone: { front_left: 50 } },
  },
]]);

const registered = registerDispatchedVehicleCommand(new Map(), {
  runId: dispatchedCommand.requestId,
  component: "vehicleTool",
  phase: "vehicle-execution",
  status: "processing",
  toolCall: dispatchedCommand,
}, {
  currentRequestId: dispatchedCommand.requestId,
});
assert.equal(registered.accepted, true);
assert.deepEqual(
  registered.dispatchedVehicleCommandsByCommandId.get(dispatchedCommand.commandId),
  {
    ...dispatchedCommand,
    expectedRequestedState: { windowPositionPercentByZone: { front_left: 50 } },
  },
);
for (const invalidDispatchEvent of [
  {
    runId: dispatchedCommand.requestId,
    component: "vehicleTool",
    phase: "vehicle-execution",
    status: "completed",
    toolCall: dispatchedCommand,
  },
  {
    runId: "other-request",
    component: "vehicleTool",
    phase: "vehicle-execution",
    status: "processing",
    toolCall: dispatchedCommand,
  },
]) {
  const rejectedRegistration = registerDispatchedVehicleCommand(
    registered.dispatchedVehicleCommandsByCommandId,
    invalidDispatchEvent,
    { currentRequestId: dispatchedCommand.requestId },
  );
  assert.equal(rejectedRegistration.accepted, false);
  assert.equal(
    rejectedRegistration.dispatchedVehicleCommandsByCommandId,
    registered.dispatchedVehicleCommandsByCommandId,
  );
}
const staleWorkingRegistration = registerDispatchedVehicleCommand(
  new Map(),
  {
    runId: dispatchedCommand.requestId,
    component: "vehicleTool",
    phase: "vehicle-execution",
    status: "processing",
    toolCall: dispatchedCommand,
  },
  { currentRequestId: "new-current-request" },
);
assert.equal(staleWorkingRegistration.accepted, false);
assert.equal(staleWorkingRegistration.dispatchedVehicleCommandsByCommandId.size, 0);

const completedRegistry = completeDispatchedVehicleCommand(
  registered.dispatchedVehicleCommandsByCommandId,
  { requestId: "request-1", toolCall: dispatchedCommand },
);
assert.equal(completedRegistry.accepted, true);
assert.equal(
  completedRegistry.dispatchedVehicleCommandsByCommandId.has(dispatchedCommand.commandId),
  false,
);

const transactionState = () => ({
  currentRun: { requestId: "request-1" },
  dispatchedVehicleCommandsByCommandId: dispatchedRegistry(),
  pendingVehicleExecutionsByComponent: new Map([[
    "frontLeftWindow",
    { commandId: dispatchedCommand.commandId },
  ]]),
  confirmedVehicleStateSnapshot: snapshot(
    "snapshot-before-transaction",
    { windowPositionPercentByZone: { front_left: 20 } },
    "2026-07-26T00:00:00.000Z",
  ),
});
const validTransactionSnapshot = snapshot(
  "snapshot-valid-transaction",
  { windowPositionPercentByZone: { front_left: 50 } },
  "2026-07-26T00:00:02.000Z",
);
const validTransactionResult = {
  requestId: "request-1",
  toolCall: dispatchedCommand,
  toolResult: toolResult({
    executionState: "observed-succeeded",
    confirmedSnapshotId: validTransactionSnapshot.id,
  }),
  vehicleStateSnapshot: validTransactionSnapshot,
  ...providerTerminalFacts(),
};
const validTransaction = reduceVehicleRuntimeResultTransaction(
  transactionState(),
  validTransactionResult,
);
assert.equal(validTransaction.handled, true);
assert.equal(validTransaction.contractValid, true);
assert.equal(validTransaction.currentRun, null);
assert.equal(validTransaction.dispatchedVehicleCommandsByCommandId.size, 0);
assert.equal(validTransaction.pendingVehicleExecutionsByComponent.size, 0);
assert.strictEqual(
  validTransaction.confirmedVehicleStateSnapshot,
  validTransactionSnapshot,
);

const trustedMissingParsedCommand = reduceVehicleRuntimeResultTransaction(
  transactionState(),
  validTransactionResult,
);
assert.equal(trustedMissingParsedCommand.handled, true);

const trustedForgedParsedCommand = reduceVehicleRuntimeResultTransaction(
  transactionState(),
  {
    ...validTransactionResult,
    parsedCommand: { intent: "conversation.general", slots: {} },
  },
);
assert.equal(trustedForgedParsedCommand.handled, true);

const unregisteredExternalToolResult = reduceVehicleRuntimeResultTransaction(
  {
    ...transactionState(),
    currentRun: { requestId: "external-request" },
  },
  {
    requestId: "external-request",
    toolCall: {
      requestId: "external-request",
      commandId: "external-request:1:body.window.setPosition",
      tool: "body.window.setPosition",
      args: { zone: "front_left", percent: 50 },
    },
  },
);
assert.equal(unregisteredExternalToolResult.handled, false);

const trustedCurrentRunOverridesForeignToolCall = reduceVehicleRuntimeResultTransaction(
  {
    ...transactionState(),
    currentRun: {
      requestId: dispatchedCommand.requestId,
      pendingVehicleCommandId: dispatchedCommand.commandId,
      pendingVehicleTool: dispatchedCommand.tool,
    },
  },
  {
    ...validTransactionResult,
    toolCall: {
      requestId: "foreign-request",
      commandId: "foreign-request:9:body.window.setPosition",
      tool: "body.window.setPosition",
      args: { zone: "front_left", percent: 50 },
    },
  },
);
assert.equal(trustedCurrentRunOverridesForeignToolCall.handled, true);
assert.equal(trustedCurrentRunOverridesForeignToolCall.contractValid, true);

const malformedTransaction = reduceVehicleRuntimeResultTransaction(
  transactionState(),
  {
    ...validTransactionResult,
    toolResult: {
      ...validTransactionResult.toolResult,
      ok: false,
      executionState: "failed",
      executionTrace: [],
      confirmedSnapshotId: undefined,
    },
    commitmentState: undefined,
  },
);
assert.equal(malformedTransaction.handled, true);
assert.equal(malformedTransaction.contractValid, false);
assert.equal(malformedTransaction.currentRun, null);
assert.equal(malformedTransaction.dispatchedVehicleCommandsByCommandId.size, 1);
assert.equal(malformedTransaction.pendingVehicleExecutionsByComponent.size, 0);
assert.equal(malformedTransaction.confirmedVehicleStateSnapshot.id, "snapshot-before-transaction");
assert.equal(malformedTransaction.presentation, null);

for (const requestedState of [
  { windowPositionPercentByZone: { front_left: 10 } },
  {},
  undefined,
]) {
  const changedToolResult = { ...validTransactionResult.toolResult };
  if (requestedState === undefined) {
    delete changedToolResult.requestedState;
  } else {
    changedToolResult.requestedState = requestedState;
  }
  const rejectedTarget = reduceVehicleRuntimeResultTransaction(
    transactionState(),
    {
      ...validTransactionResult,
      toolResult: changedToolResult,
    },
  );
  assert.equal(rejectedTarget.handled, true);
  assert.equal(rejectedTarget.contractValid, false);
  assert.equal(rejectedTarget.dispatchedVehicleCommandsByCommandId.size, 1);
  assert.equal(rejectedTarget.pendingVehicleExecutionsByComponent.size, 0);
}

const exactTerminalEvent = {
  runId: "request-1",
  component: "vehicleTool",
  phase: "vehicle-execution",
  status: "completed",
  toolResult: validTransactionResult.toolResult,
  providerSnapshot: validTransactionResult.vehicleStateSnapshot,
  commitmentState: validTransactionResult.commitmentState,
  cancellation: validTransactionResult.cancellation,
};
const resultThenEvent = consumeCancelledVehicleTerminalEvent({
  ...transactionState(),
  ...validTransaction,
}, exactTerminalEvent, {
  currentRequestId: "request-1",
});
assert.equal(resultThenEvent.handled, true);
assert.equal(resultThenEvent.contractValid, true);
assert.equal(resultThenEvent.factsAccepted, false);
assert.equal(resultThenEvent.presentation, null);
assert.equal(resultThenEvent.verifiedVehicleTerminalsByCommandId.size, 1);

const eventFirst = consumeCancelledVehicleTerminalEvent(
  transactionState(),
  exactTerminalEvent,
  { currentRequestId: "request-1" },
);
const eventThenResult = reduceVehicleRuntimeResultTransaction({
  ...transactionState(),
  ...eventFirst,
  currentRun: { requestId: "request-1" },
}, validTransactionResult);
assert.equal(eventThenResult.handled, true);
assert.equal(eventThenResult.contractValid, true);
assert.equal(eventThenResult.currentRun, null);
assert.equal(eventThenResult.factsAccepted, false);
assert.equal(eventThenResult.presentation, null);

const conflictingCrossSourceResult = reduceVehicleRuntimeResultTransaction({
  ...transactionState(),
  ...eventFirst,
  currentRun: { requestId: "request-1" },
}, {
  ...validTransactionResult,
  cancellation: { requested: true, physicalUndoClaimed: false },
});
assert.equal(conflictingCrossSourceResult.handled, true);
assert.equal(conflictingCrossSourceResult.contractValid, false);
assert.equal(conflictingCrossSourceResult.currentRun, null);
assert.equal(conflictingCrossSourceResult.dispatchedVehicleCommandsByCommandId.size, 0);
assert.equal(conflictingCrossSourceResult.pendingVehicleExecutionsByComponent.size, 0);
assert.equal(conflictingCrossSourceResult.verifiedVehicleTerminalsByCommandId.size, 1);
assert.equal(
  conflictingCrossSourceResult.verifiedVehicleTerminalsByCommandId
    .get(dispatchedCommand.commandId).facts.cancellation.requested,
  false,
);

const missingTerminalResult = reduceVehicleRuntimeResultTransaction(
  transactionState(),
  { requestId: "request-1", parsedCommand: { intent: "body.window.setPosition" } },
);
assert.equal(missingTerminalResult.handled, false);

const trustedMissingTerminalResult = reduceVehicleRuntimeResultTransaction({
  ...transactionState(),
  currentRun: {
    requestId: "request-1",
    pendingVehicleCommandId: dispatchedCommand.commandId,
    pendingVehicleTool: dispatchedCommand.tool,
  },
}, { requestId: "request-1" });
assert.equal(trustedMissingTerminalResult.handled, true);
assert.equal(trustedMissingTerminalResult.currentRun, null);
assert.equal(trustedMissingTerminalResult.dispatchedVehicleCommandsByCommandId.size, 1);
assert.equal(trustedMissingTerminalResult.pendingVehicleExecutionsByComponent.size, 0);

const mappedCancelledEvent = hmiAnimation.mapCancelledVehicleEventToHmi(
  cancelledTerminalEvent,
  { previousConfirmedState: snapshot("snapshot-1") },
);
assert.equal(mappedCancelledEvent.phase, "confirmed");
assert.equal(mappedCancelledEvent.commandId, cancelledTerminalEvent.toolResult.commandId);

const oldSnapshot = snapshot(
  "snapshot-1",
  { windowPositionPercentByZone: { front_left: 10 } },
  "2026-07-26T00:00:00.000Z",
);
cancelledTerminalEvent.providerSnapshot = snapshot(
  "snapshot-2",
  { windowPositionPercentByZone: { front_left: 50 } },
  "2026-07-26T00:00:02.000Z",
);

const oldTurnIntoNonVehicleTurn = consumeCancelledVehicleTerminalEvent({
  dispatchedVehicleCommandsByCommandId: dispatchedRegistry(),
  pendingVehicleExecutionsByComponent: new Map([[
    "frontLeftWindow",
    { commandId: cancelledTerminalEvent.toolResult.commandId },
  ]]),
  confirmedVehicleStateSnapshot: oldSnapshot,
}, cancelledTerminalEvent, {
  currentRequestId: "request-new-non-vehicle",
});
assert.equal(oldTurnIntoNonVehicleTurn.handled, true);
assert.equal(oldTurnIntoNonVehicleTurn.factsAccepted, true);
assert.equal(oldTurnIntoNonVehicleTurn.presentation, null);
assert.equal(oldTurnIntoNonVehicleTurn.pendingVehicleExecutionsByComponent.has("frontLeftWindow"), false);
assert.equal(
  oldTurnIntoNonVehicleTurn.confirmedVehicleStateSnapshot.id,
  cancelledTerminalEvent.providerSnapshot.id,
);

const newerPendingState = consumeCancelledVehicleTerminalEvent({
  dispatchedVehicleCommandsByCommandId: new Map([
    [dispatchedCommand.commandId, {
      ...dispatchedCommand,
      expectedRequestedState: { windowPositionPercentByZone: { front_left: 50 } },
    }],
    ["request-new:1:body.window.setPosition", {
      requestId: "request-new",
      commandId: "request-new:1:body.window.setPosition",
      tool: "body.window.setPosition",
      args: { zone: "front_left", percent: 60 },
      expectedRequestedState: { windowPositionPercentByZone: { front_left: 60 } },
    }],
  ]),
  pendingVehicleExecutionsByComponent: new Map([[
    "frontLeftWindow",
    { commandId: "request-new:1:body.window.setPosition" },
  ]]),
  confirmedVehicleStateSnapshot: oldSnapshot,
}, cancelledTerminalEvent, {
  currentRequestId: "request-new",
});
assert.equal(newerPendingState.handled, true);
assert.equal(newerPendingState.factsAccepted, true);
assert.equal(newerPendingState.presentation, null);
assert.equal(
  newerPendingState.pendingVehicleExecutionsByComponent.get("frontLeftWindow").commandId,
  "request-new:1:body.window.setPosition",
);
assert.equal(
  newerPendingState.dispatchedVehicleCommandsByCommandId.has(
    "request-new:1:body.window.setPosition",
  ),
  true,
);
assert.equal(
  newerPendingState.dispatchedVehicleCommandsByCommandId.has(dispatchedCommand.commandId),
  false,
);
assert.equal(newerPendingState.confirmedVehicleStateSnapshot.id, "snapshot-2");

const currentTurnState = consumeCancelledVehicleTerminalEvent({
  dispatchedVehicleCommandsByCommandId: dispatchedRegistry(),
  pendingVehicleExecutionsByComponent: new Map([[
    "frontLeftWindow",
    { commandId: cancelledTerminalEvent.toolResult.commandId },
  ]]),
  confirmedVehicleStateSnapshot: oldSnapshot,
}, cancelledTerminalEvent, {
  currentRequestId: "request-1",
});
assert.equal(currentTurnState.handled, true);
assert.equal(currentTurnState.factsAccepted, true);
assert.equal(currentTurnState.presentation.phase, "confirmed");
assert.equal(currentTurnState.pendingVehicleExecutionsByComponent.has("frontLeftWindow"), false);
assert.equal(
  currentTurnState.dispatchedVehicleCommandsByCommandId.has(dispatchedCommand.commandId),
  false,
);

const conflictSnapshot = snapshot(
  "snapshot-conflict-terminal",
  { windowPositionPercentByZone: { front_left: 30 } },
  "2026-07-26T00:00:03.000Z",
);
const conflictFailureEvent = {
  runId: "request-1",
  component: "vehicleTool",
  phase: "vehicle-execution",
  status: "failed",
  toolResult: {
    ...toolResult({ executionState: "failed" }),
    executionError: {
      code: "sensor-observation-conflict",
      message: "传感器实际状态与请求目标不一致。",
      stage: "sensor-confirmation",
      retryable: false,
    },
    executionTrace: [
      { state: "submitted", source: "hmi-test", at: "2026-07-26T00:00:00.000Z" },
      { state: "accepted", source: "hmi-test", at: "2026-07-26T00:00:00.100Z" },
      { state: "executing", source: "hmi-test", at: "2026-07-26T00:00:00.500Z" },
      { state: "failed", source: "hmi-test", at: "2026-07-26T00:00:01.000Z" },
    ],
  },
  providerSnapshot: conflictSnapshot,
  commitmentState: "provider-terminal",
  cancellation: { requested: false, physicalUndoClaimed: false },
};
const conflictFacts = consumeCancelledVehicleTerminalEvent({
  dispatchedVehicleCommandsByCommandId: dispatchedRegistry(),
  pendingVehicleExecutionsByComponent: new Map([[
    "frontLeftWindow",
    { commandId: dispatchedCommand.commandId },
  ]]),
  confirmedVehicleStateSnapshot: oldSnapshot,
}, conflictFailureEvent, {
  currentRequestId: "request-1",
});
assert.equal(conflictFacts.handled, true);
assert.equal(conflictFacts.factsAccepted, true);
assert.strictEqual(conflictFacts.confirmedVehicleStateSnapshot, conflictSnapshot);
assert.equal(conflictFacts.presentation.phase, "observed-conflict");
assert.equal(conflictFacts.presentation.noAnimation, false);
assert.deepEqual(
  conflictFacts.presentation.animationState,
  { windowPositionPercent: 30, windowPositionPercentByZone: { front_left: 30 } },
  "conflict reconciliation must animate the Provider actual state, never the requested 50%",
);

for (const forgedEvent of [
  {
    ...cancelledTerminalEvent,
    runId: "forged-request",
  },
  {
    ...cancelledTerminalEvent,
    toolResult: {
      ...cancelledTerminalEvent.toolResult,
      commandId: "request-1:forged:body.window.setPosition",
    },
  },
  {
    ...cancelledTerminalEvent,
    status: "processing",
  },
  {
    ...cancelledTerminalEvent,
    runId: "invented-request",
    toolResult: {
      ...cancelledTerminalEvent.toolResult,
      requestId: "invented-request",
      commandId: "invented-request:1:body.window.setPosition",
    },
  },
]) {
  const rejected = consumeCancelledVehicleTerminalEvent({
    dispatchedVehicleCommandsByCommandId: dispatchedRegistry(),
    pendingVehicleExecutionsByComponent: new Map([[
      "frontLeftWindow",
      { commandId: cancelledTerminalEvent.toolResult.commandId },
    ]]),
    confirmedVehicleStateSnapshot: oldSnapshot,
  }, forgedEvent, {
    currentRequestId: "request-new",
  });
  assert.equal(rejected.handled, false);
  assert.equal(rejected.confirmedVehicleStateSnapshot, oldSnapshot);
  assert.equal(rejected.pendingVehicleExecutionsByComponent.has("frontLeftWindow"), true);
  assert.equal(rejected.dispatchedVehicleCommandsByCommandId.size, 1);
}

const genuineDispatchFailureEvent = {
  runId: "request-1",
  component: "vehicleTool",
  phase: "vehicle-execution",
  status: "failed",
  toolResult: {
    ...toolResult({ executionState: "failed" }),
    executionTrace: [
      { state: "submitted", source: "hmi-test", at: "2026-07-26T00:00:00.000Z" },
      { state: "failed", source: "hmi-test", at: "2026-07-26T00:00:00.100Z" },
    ],
  },
  ...providerTerminalFacts(true),
  commitmentState: "dispatching",
};
for (const malformedTerminalEvent of [
  {
    ...genuineDispatchFailureEvent,
    commitmentState: undefined,
  },
  {
    ...genuineDispatchFailureEvent,
    commitmentState: "pre-dispatch",
  },
  {
    ...genuineDispatchFailureEvent,
    commitmentState: "adapter-accepted",
  },
  {
    ...genuineDispatchFailureEvent,
    commitmentState: "provider-terminal",
  },
  {
    ...genuineDispatchFailureEvent,
    toolResult: {
      ...genuineDispatchFailureEvent.toolResult,
      executionTrace: [],
    },
  },
  {
    ...genuineDispatchFailureEvent,
    toolResult: {
      ...genuineDispatchFailureEvent.toolResult,
      executionTrace: [
        { state: "submitted", source: "hmi-test", at: "not-a-time" },
        { state: "failed", source: "hmi-test", at: "2026-07-26T00:00:00.100Z" },
      ],
    },
  },
  {
    ...genuineDispatchFailureEvent,
    toolResult: {
      ...genuineDispatchFailureEvent.toolResult,
      executionTrace: [
        { state: "submitted", source: "hmi-test", at: "2026-07-26T00:00:00.100Z" },
        { state: "failed", source: "hmi-test", at: "2026-07-26T00:00:00.000Z" },
      ],
    },
  },
  {
    ...genuineDispatchFailureEvent,
    toolResult: {
      ...genuineDispatchFailureEvent.toolResult,
      executionTrace: [
        { state: "submitted", source: "hmi-test", at: "2026-07-26T00:00:00.000Z" },
        { state: "accepted", source: "hmi-test", at: "2026-07-26T00:00:00.050Z" },
        { state: "executing", source: "hmi-test", at: "2026-07-26T00:00:00.075Z" },
        { state: "failed", source: "hmi-test", at: "2026-07-26T00:00:00.100Z" },
      ],
    },
    commitmentState: "dispatching",
  },
  {
    ...genuineDispatchFailureEvent,
    cancellation: undefined,
  },
]) {
  const initialState = {
    dispatchedVehicleCommandsByCommandId: dispatchedRegistry(),
    pendingVehicleExecutionsByComponent: new Map([[
      "frontLeftWindow",
      { commandId: dispatchedCommand.commandId },
    ]]),
    confirmedVehicleStateSnapshot: oldSnapshot,
  };
  const rejected = consumeCancelledVehicleTerminalEvent(
    initialState,
    malformedTerminalEvent,
    { currentRequestId: "request-1" },
  );
  assert.equal(rejected.handled, false);
  assert.equal(rejected.dispatchedVehicleCommandsByCommandId.size, 1);
  assert.equal(rejected.pendingVehicleExecutionsByComponent.size, 1);

  const genuineAfterMalformed = consumeCancelledVehicleTerminalEvent(
    {
      dispatchedVehicleCommandsByCommandId:
        rejected.dispatchedVehicleCommandsByCommandId,
      pendingVehicleExecutionsByComponent:
        rejected.pendingVehicleExecutionsByComponent,
      confirmedVehicleStateSnapshot:
        rejected.confirmedVehicleStateSnapshot,
    },
    genuineDispatchFailureEvent,
    { currentRequestId: "request-1" },
  );
  assert.equal(genuineAfterMalformed.handled, true);
  assert.equal(genuineAfterMalformed.dispatchedVehicleCommandsByCommandId.size, 0);
  assert.equal(genuineAfterMalformed.pendingVehicleExecutionsByComponent.size, 0);
}

const firstTerminalConsumption = consumeCancelledVehicleTerminalEvent({
  dispatchedVehicleCommandsByCommandId: dispatchedRegistry(),
  pendingVehicleExecutionsByComponent: new Map([[
    "frontLeftWindow",
    { commandId: cancelledTerminalEvent.toolResult.commandId },
  ]]),
  confirmedVehicleStateSnapshot: oldSnapshot,
}, cancelledTerminalEvent, {
  currentRequestId: "request-1",
});
const matchingCurrentRun = {
  requestId: dispatchedCommand.requestId,
  pendingVehicleCommandId: dispatchedCommand.commandId,
  pendingVehicleTool: dispatchedCommand.tool,
};
const newCommand = {
  requestId: "request-new",
  commandId: "request-new:1:body.tailgate.open",
  tool: "body.tailgate.open",
};
const newCurrentRun = {
  requestId: newCommand.requestId,
  pendingVehicleCommandId: newCommand.commandId,
  pendingVehicleTool: newCommand.tool,
};
const lateOldRuntimeResult = reduceVehicleRuntimeResultTransaction({
  ...transactionState(),
  currentRun: newCurrentRun,
  pendingVehicleExecutionsByComponent: new Map([
    ["frontLeftWindow", { commandId: dispatchedCommand.commandId }],
    ["tailgate", { commandId: newCommand.commandId }],
  ]),
}, validTransactionResult);
assert.equal(lateOldRuntimeResult.handled, true);
assert.equal(lateOldRuntimeResult.contractValid, true);
assert.strictEqual(lateOldRuntimeResult.currentRun, newCurrentRun);
assert.equal(lateOldRuntimeResult.pendingVehicleExecutionsByComponent.size, 1);
assert.equal(
  lateOldRuntimeResult.pendingVehicleExecutionsByComponent
    .get("tailgate").commandId,
  newCommand.commandId,
);
assert.equal(lateOldRuntimeResult.presentation, null);

const replayedTerminalConsumption = consumeCancelledVehicleTerminalEvent({
  dispatchedVehicleCommandsByCommandId:
    firstTerminalConsumption.dispatchedVehicleCommandsByCommandId,
  pendingVehicleExecutionsByComponent:
    firstTerminalConsumption.pendingVehicleExecutionsByComponent,
  confirmedVehicleStateSnapshot:
    firstTerminalConsumption.confirmedVehicleStateSnapshot,
  verifiedVehicleTerminalsByCommandId:
    firstTerminalConsumption.verifiedVehicleTerminalsByCommandId,
  currentRun: matchingCurrentRun,
  pendingVehicleExecutionsByComponent: new Map([[
    "frontLeftWindow",
    { commandId: dispatchedCommand.commandId },
  ]]),
  }, cancelledTerminalEvent, {
  currentRequestId: "request-1",
});
assert.equal(replayedTerminalConsumption.handled, true);
assert.equal(replayedTerminalConsumption.contractValid, true);
assert.equal(replayedTerminalConsumption.currentRun, null);
assert.equal(replayedTerminalConsumption.pendingVehicleExecutionsByComponent.size, 0);
assert.strictEqual(
  replayedTerminalConsumption.verifiedVehicleTerminalsByCommandId
    .get(dispatchedCommand.commandId),
  firstTerminalConsumption.verifiedVehicleTerminalsByCommandId
    .get(dispatchedCommand.commandId),
);
assert.strictEqual(
  replayedTerminalConsumption.confirmedVehicleStateSnapshot,
  firstTerminalConsumption.confirmedVehicleStateSnapshot,
);
assert.equal(replayedTerminalConsumption.presentation, null);

const matchingEventConflict = consumeCancelledVehicleTerminalEvent({
  ...firstTerminalConsumption,
  currentRun: matchingCurrentRun,
  pendingVehicleExecutionsByComponent: new Map([[
    "frontLeftWindow",
    { commandId: dispatchedCommand.commandId },
  ]]),
}, {
  ...cancelledTerminalEvent,
  cancellation: { requested: false, physicalUndoClaimed: false },
}, { currentRequestId: "request-1" });
assert.equal(matchingEventConflict.handled, true);
assert.equal(matchingEventConflict.contractValid, false);
assert.equal(matchingEventConflict.currentRun, null);
assert.equal(matchingEventConflict.pendingVehicleExecutionsByComponent.size, 0);
assert.strictEqual(
  matchingEventConflict.verifiedVehicleTerminalsByCommandId
    .get(dispatchedCommand.commandId),
  firstTerminalConsumption.verifiedVehicleTerminalsByCommandId
    .get(dispatchedCommand.commandId),
);
assert.strictEqual(
  matchingEventConflict.confirmedVehicleStateSnapshot,
  firstTerminalConsumption.confirmedVehicleStateSnapshot,
);
assert.equal(matchingEventConflict.presentation, null);

const runtimeThenEventConflict = consumeCancelledVehicleTerminalEvent(
  reduceVehicleRuntimeResultTransaction(
    {
      ...transactionState(),
      currentRun: { requestId: "request-1" },
    },
    {
      ...validTransactionResult,
      cancellation: { requested: true, physicalUndoClaimed: false },
    },
  ),
  {
    ...cancelledTerminalEvent,
    cancellation: { requested: false, physicalUndoClaimed: false },
  },
  { currentRequestId: "request-1" },
);
assert.equal(runtimeThenEventConflict.handled, true);
assert.equal(runtimeThenEventConflict.contractValid, false);
assert.equal(runtimeThenEventConflict.currentRun, null);
assert.equal(runtimeThenEventConflict.dispatchedVehicleCommandsByCommandId.size, 0);
assert.equal(runtimeThenEventConflict.pendingVehicleExecutionsByComponent.size, 0);

for (const incomingSnapshot of [
  snapshot(
    "snapshot-stale",
    { windowPositionPercentByZone: { front_left: 50 } },
    "2026-07-26T00:00:01.000Z",
  ),
  snapshot(
    "snapshot-current",
    { windowPositionPercentByZone: { front_left: 50 } },
    "2026-07-26T00:00:01.000Z",
  ),
]) {
  const currentSnapshot = snapshot(
    "snapshot-current",
    { windowPositionPercentByZone: { front_left: 60 } },
    "2026-07-26T00:00:03.000Z",
  );
  const staleEvent = {
    ...cancelledTerminalEvent,
    toolResult: {
      ...cancelledTerminalEvent.toolResult,
      confirmedSnapshotId: incomingSnapshot.id,
    },
    providerSnapshot: incomingSnapshot,
  };
  const staleResult = consumeCancelledVehicleTerminalEvent({
    dispatchedVehicleCommandsByCommandId: dispatchedRegistry(),
    pendingVehicleExecutionsByComponent: new Map(),
    confirmedVehicleStateSnapshot: currentSnapshot,
  }, staleEvent, {
    currentRequestId: "request-new",
  });
  assert.equal(staleResult.handled, true);
  assert.equal(staleResult.factsAccepted, false);
  assert.equal(staleResult.presentation, null);
  assert.equal(staleResult.confirmedVehicleStateSnapshot, currentSnapshot);
}

for (const normalMergeCase of [
  {
    name: "older-normal-result",
    current: snapshot(
      "snapshot-newest",
      { windowPositionPercentByZone: { front_left: 60 } },
      "2026-07-26T00:00:03.000Z",
    ),
    incoming: snapshot(
      "snapshot-older-runtime-result",
      { windowPositionPercentByZone: { front_left: 50 } },
      "2026-07-26T00:00:01.000Z",
    ),
    factsAccepted: false,
    presentationAccepted: false,
  },
  {
    name: "same-id-conflicting-normal-result",
    current: snapshot(
      "snapshot-same-id",
      { windowPositionPercentByZone: { front_left: 60 } },
      "2026-07-26T00:00:03.000Z",
    ),
    incoming: snapshot(
      "snapshot-same-id",
      { windowPositionPercentByZone: { front_left: 50 } },
      "2026-07-26T00:00:03.000Z",
    ),
    factsAccepted: false,
    presentationAccepted: false,
  },
  {
    name: "newer-normal-result",
    current: snapshot(
      "snapshot-before-runtime-result",
      { windowPositionPercentByZone: { front_left: 20 } },
      "2026-07-26T00:00:01.000Z",
    ),
    incoming: snapshot(
      "snapshot-newer-runtime-result",
      { windowPositionPercentByZone: { front_left: 50 } },
      "2026-07-26T00:00:03.000Z",
    ),
    factsAccepted: true,
    presentationAccepted: true,
  },
]) {
  const result = {
    toolCall: dispatchedCommand,
    toolResult: toolResult({
      executionState: "observed-succeeded",
      confirmedSnapshotId: normalMergeCase.incoming.id,
    }),
    vehicleStateSnapshot: normalMergeCase.incoming,
    ...providerTerminalFacts(),
  };
  const presentation = hmiAnimation.mapVehicleRuntimeResultToHmi(result, {
    previousConfirmedState: normalMergeCase.current,
  });
  assert.equal(presentation.phase, "confirmed", normalMergeCase.name);
  const reduced = reduceVehicleHmiState({
    pendingVehicleExecutionsByComponent: new Map([[
      "frontLeftWindow",
      { commandId: result.toolResult.commandId },
    ]]),
    confirmedVehicleStateSnapshot: normalMergeCase.current,
  }, presentation, {
    vehicleStateSnapshot: normalMergeCase.incoming,
  });
  assert.equal(reduced.accepted, true, normalMergeCase.name);
  assert.equal(reduced.factsAccepted, normalMergeCase.factsAccepted, normalMergeCase.name);
  assert.equal(
    reduced.presentationAccepted,
    normalMergeCase.presentationAccepted,
    normalMergeCase.name,
  );
  assert.equal(reduced.pendingVehicleExecutionsByComponent.has("frontLeftWindow"), false);
  assert.equal(
    reduced.confirmedVehicleStateSnapshot,
    normalMergeCase.factsAccepted ? normalMergeCase.incoming : normalMergeCase.current,
    normalMergeCase.name,
  );
}

const missingCommitmentFacts = mapVehicleExecutionToHmi({
  toolResult: toolResult({
    executionState: "observed-succeeded",
    confirmedSnapshotId: "snapshot-2",
  }),
  vehicleStateSnapshot: snapshot("snapshot-2"),
  previousConfirmedState: snapshot("snapshot-1"),
});
assert.equal(missingCommitmentFacts.phase, "unsupported");
assert.equal(missingCommitmentFacts.noAnimation, true);

for (const cancellation of [
  undefined,
  {},
  { requested: "yes", physicalUndoClaimed: false },
  { requested: true, physicalUndoClaimed: true },
]) {
  const invalidCancellation = mapVehicleExecutionToHmi({
    toolResult: toolResult({
      executionState: "observed-succeeded",
      confirmedSnapshotId: "snapshot-2",
    }),
    vehicleStateSnapshot: snapshot("snapshot-2"),
    previousConfirmedState: snapshot("snapshot-1"),
    commitmentState: "provider-terminal",
    cancellation,
  });
  assert.equal(invalidCancellation.phase, "unsupported");
  assert.equal(invalidCancellation.noAnimation, true);
}

const priorConfirmed = snapshot("snapshot-prior", {
  windowPositionPercentByZone: { front_left: 20 },
});
for (const executionState of ["failed", "timeout", "duplicate-command"]) {
  const acceptedByAdapter = executionState === "timeout";
  const cancelled = mapVehicleExecutionToHmi({
    toolResult: {
      ...toolResult({ executionState }),
      executionTrace: acceptedByAdapter
        ? [
          { state: "submitted", source: "hmi-test", at: "2026-07-26T00:00:00.000Z" },
          { state: "accepted", source: "hmi-test", at: "2026-07-26T00:00:00.050Z" },
          { state: "executing", source: "hmi-test", at: "2026-07-26T00:00:00.075Z" },
          { state: executionState, source: "hmi-test", at: "2026-07-26T00:00:00.100Z" },
        ]
        : [
          { state: "submitted", source: "hmi-test", at: "2026-07-26T00:00:00.000Z" },
          { state: executionState, source: "hmi-test", at: "2026-07-26T00:00:00.100Z" },
        ],
    },
    vehicleStateSnapshot: null,
    previousConfirmedState: priorConfirmed,
    commitmentState: acceptedByAdapter ? "provider-terminal" : "dispatching",
    cancellation: { requested: false, physicalUndoClaimed: false },
  });
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.noAnimation, true);
  assert.equal(cancelled.animationState, null);
}

let boundedTerminalState = {
  verifiedVehicleTerminalsByCommandId: new Map(),
  confirmedVehicleStateSnapshot: null,
};
for (let index = 1; index <= 130; index += 1) {
  const requestId = `bounded-${index}`;
  const command = {
    requestId,
    commandId: `${requestId}:1:body.window.setPosition`,
    tool: "body.window.setPosition",
    args: { zone: "front_left", percent: 50 },
  };
  const terminalSnapshot = snapshot(
    `bounded-snapshot-${index}`,
    {},
    new Date(Date.parse("2026-07-26T00:00:10.000Z") + index).toISOString(),
  );
  boundedTerminalState = reduceVehicleRuntimeResultTransaction({
    ...boundedTerminalState,
    currentRun: {
      requestId,
      pendingVehicleCommandId: command.commandId,
      pendingVehicleTool: command.tool,
    },
    dispatchedVehicleCommandsByCommandId: new Map([[
      command.commandId,
      {
        ...command,
        expectedRequestedState: { windowPositionPercentByZone: { front_left: 50 } },
      },
    ]]),
    pendingVehicleExecutionsByComponent: new Map([[
      "frontLeftWindow",
      { commandId: command.commandId },
    ]]),
  }, {
    requestId,
    toolCall: command,
    toolResult: {
      ...toolResult({
        commandId: command.commandId,
        executionState: "observed-succeeded",
        confirmedSnapshotId: terminalSnapshot.id,
      }),
      requestId,
    },
    vehicleStateSnapshot: terminalSnapshot,
    ...providerTerminalFacts(),
  });
  assert.equal(boundedTerminalState.handled, true);
}
assert.equal(boundedTerminalState.verifiedVehicleTerminalsByCommandId.size, 128);
assert.equal(
  boundedTerminalState.verifiedVehicleTerminalsByCommandId.has(
    "bounded-1:1:body.window.setPosition",
  ),
  false,
);
assert.equal(
  boundedTerminalState.verifiedVehicleTerminalsByCommandId.has(
    "bounded-130:1:body.window.setPosition",
  ),
  true,
);

const confirmedCases = [
  {
    tool: "body.tailgate.open",
    requestedState: { tailgateOpen: true },
    component: "tailgate",
    expected: { tailgateOpen: true },
  },
  {
    tool: "seat.driver.setBackrestAngle",
    requestedState: { driverBackrestAngle: 130 },
    component: "driverSeatBackrest",
    expected: { driverBackrestAngle: 130 },
  },
  {
    tool: "cabin.climate.setPreset",
    requestedState: { cabinTemperature: 30, airflow: "high", passengerMode: "child_comfort" },
    component: "cabin",
    expected: { cabinTemperature: 30, airflow: "high", passengerMode: "child_comfort" },
  },
];
for (const confirmedCase of confirmedCases) {
  const presentation = mapVehicleExecutionToHmi({
    toolResult: toolResult({
      ...confirmedCase,
      executionState: "observed-succeeded",
      confirmedSnapshotId: "snapshot-2",
    }),
    vehicleStateSnapshot: snapshot("snapshot-2", confirmedCase.requestedState),
    previousConfirmedState: priorConfirmed,
    ...providerTerminalFacts(),
  });
  assert.equal(presentation.phase, "confirmed");
  assert.equal(presentation.component, confirmedCase.component);
  assert.deepEqual(presentation.animationState, confirmedCase.expected);
}

let hmiState = {
  pendingVehicleExecutionsByComponent: new Map(),
  confirmedVehicleStateSnapshot: priorConfirmed,
};
hmiState = reduceVehicleHmiState(hmiState, mapVehicleExecutionToHmi({
  toolResult: toolResult({ commandId: "window-old" }),
  vehicleStateSnapshot: null,
  previousConfirmedState: priorConfirmed,
}));
hmiState = reduceVehicleHmiState(hmiState, mapVehicleExecutionToHmi({
  toolResult: toolResult({
    tool: "body.tailgate.open",
    commandId: "tailgate-1",
    requestedState: { open: true },
  }),
  vehicleStateSnapshot: null,
  previousConfirmedState: priorConfirmed,
}));
hmiState = reduceVehicleHmiState(hmiState, mapVehicleExecutionToHmi({
  toolResult: toolResult({ commandId: "window-new" }),
  vehicleStateSnapshot: null,
  previousConfirmedState: priorConfirmed,
}));
assert.equal(hmiState.pendingVehicleExecutionsByComponent.get("frontLeftWindow").commandId, "window-new");
assert.equal(hmiState.pendingVehicleExecutionsByComponent.get("tailgate").commandId, "tailgate-1");

hmiState = reduceVehicleHmiState(hmiState, mapVehicleExecutionToHmi({
  toolResult: {
    ...toolResult({ commandId: "window-new", executionState: "timeout" }),
    executionTrace: [
      { state: "submitted", source: "hmi-test", at: "2026-07-26T00:00:00.000Z" },
      { state: "accepted", source: "hmi-test", at: "2026-07-26T00:00:00.050Z" },
      { state: "executing", source: "hmi-test", at: "2026-07-26T00:00:00.075Z" },
      { state: "timeout", source: "hmi-test", at: "2026-07-26T00:00:00.100Z" },
    ],
  },
  vehicleStateSnapshot: null,
  previousConfirmedState: priorConfirmed,
  commitmentState: "provider-terminal",
  cancellation: { requested: false, physicalUndoClaimed: false },
}));
assert.equal(hmiState.pendingVehicleExecutionsByComponent.has("frontLeftWindow"), false);
assert.equal(hmiState.pendingVehicleExecutionsByComponent.has("tailgate"), true);
assert.equal(hmiState.confirmedVehicleStateSnapshot, priorConfirmed);

const newerPending = mapVehicleExecutionToHmi({
  toolResult: toolResult({ commandId: "window-newer" }),
  vehicleStateSnapshot: null,
  previousConfirmedState: priorConfirmed,
});
hmiState = reduceVehicleHmiState(hmiState, newerPending);
const lateOldConfirmation = mapVehicleExecutionToHmi({
  toolResult: toolResult({
    commandId: "window-old",
    executionState: "observed-succeeded",
    confirmedSnapshotId: "snapshot-late",
  }),
  vehicleStateSnapshot: snapshot("snapshot-late"),
  previousConfirmedState: priorConfirmed,
  ...providerTerminalFacts(true),
});
const stateAfterLateConfirmation = reduceVehicleHmiState(
  hmiState,
  lateOldConfirmation,
  { vehicleStateSnapshot: snapshot("snapshot-late") },
);
assert.equal(stateAfterLateConfirmation.accepted, false);
assert.equal(
  stateAfterLateConfirmation.pendingVehicleExecutionsByComponent.get("frontLeftWindow").commandId,
  "window-newer",
);
assert.equal(stateAfterLateConfirmation.confirmedVehicleStateSnapshot, priorConfirmed);

const coordinatorFailureWithoutRequestedState = mapVehicleExecutionToHmi({
  toolResult: {
    ...toolResult({
      commandId: "window-newer",
      executionState: "failed",
      requestedState: undefined,
    }),
    executionTrace: [
      { state: "submitted", source: "hmi-test", at: "2026-07-26T00:00:00.000Z" },
      { state: "failed", source: "hmi-test", at: "2026-07-26T00:00:00.100Z" },
    ],
  },
  vehicleStateSnapshot: null,
  previousConfirmedState: priorConfirmed,
  commitmentState: "dispatching",
  cancellation: { requested: false, physicalUndoClaimed: false },
});
assert.equal(coordinatorFailureWithoutRequestedState.phase, "cancelled");
assert.equal(coordinatorFailureWithoutRequestedState.component, "frontLeftWindow");

const unknown = mapVehicleExecutionToHmi({
  toolResult: toolResult({ tool: "body.sunroof.open" }),
  vehicleStateSnapshot: snapshot(),
  previousConfirmedState: priorConfirmed,
});
assert.equal(unknown.phase, "unsupported");
assert.equal(unknown.noAnimation, true);

const played = [];
applyHmiPresentation(confirmedWindow, {
  playScenarioAnimation(scenario, options) {
    played.push({ scenario, options });
  },
});
applyHmiPresentation(conflictFacts.presentation, {
  playScenarioAnimation(scenario, options) {
    played.push({ scenario, options });
  },
});
applyHmiPresentation(unknown, {
  playScenarioAnimation() {
    played.push("unexpected");
  },
});
assert.equal(played.length, 2);
assert.equal(played[0].scenario, "windowControl");
assert.deepEqual(played[0].options.statePatch, {
  windowPositionPercent: 99,
  windowPositionPercentByZone: { front_left: 99 },
});
assert.equal(played[1].scenario, "windowControl");
assert.deepEqual(played[1].options.statePatch, {
  windowPositionPercent: 30,
  windowPositionPercentByZone: { front_left: 30 },
});

console.log(JSON.stringify({
  pendingDoesNotAnimate: true,
  confirmedUsesSnapshotOnly: true,
  cancellationPreservesConfirmedState: true,
  componentPendingReplacement: true,
  lateTerminalFactsMergedWithoutAnimation: true,
  realWindowRequestedStateShape: true,
  unknownToolsFailClosed: true,
  runtimeResultConflictsFailClosed: true,
  terminalReplayIsIdempotent: true,
}, null, 2));
