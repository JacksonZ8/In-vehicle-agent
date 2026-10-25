import assert from "node:assert/strict";

const runtimeResultState = await import(
  new URL("../../src/app/runtime-result-state.js", import.meta.url)
).catch(() => ({}));
assert.equal(typeof runtimeResultState.reduceAppRuntimeVehicleResult, "function");
assert.equal(typeof runtimeResultState.reduceAppRuntimeVehicleEvent, "function");
assert.equal(
  typeof runtimeResultState.selectAppRuntimeVehicleMetricsSnapshot,
  "function",
);

const {
  reduceAppRuntimeVehicleEvent,
  reduceAppRuntimeVehicleResult,
  selectAppRuntimeVehicleMetricsSnapshot,
} = runtimeResultState;
const original = {
  requestId: "app-runtime-result-1",
  commandId: "app-runtime-result-1:1:body.window.setPosition",
  tool: "body.window.setPosition",
  args: { zone: "front_left", percent: 50 },
};
const requestedState = {
  windowPositionPercentByZone: { front_left: 50 },
};
const previousSnapshot = {
  id: "app-runtime-snapshot-before",
  source: "demo-sensor-simulator",
  simulated: true,
  capturedAt: "2026-07-30T00:00:00.000Z",
  values: { windowPositionPercentByZone: { front_left: 20 } },
  capturedAtByField: {
    windowPositionPercentByZone: "2026-07-30T00:00:00.000Z",
  },
};
const terminalSnapshot = {
  id: "app-runtime-snapshot-terminal",
  source: "demo-sensor-simulator",
  simulated: true,
  capturedAt: "2026-07-30T00:00:02.000Z",
  values: { windowPositionPercentByZone: { front_left: 50 } },
  capturedAtByField: {
    windowPositionPercentByZone: "2026-07-30T00:00:02.000Z",
  },
};
const currentVehicleState = () => ({
  currentRun: {
    requestId: original.requestId,
    pendingVehicleCommandId: original.commandId,
    pendingVehicleTool: original.tool,
  },
  dispatchedVehicleCommandsByCommandId: new Map([[
    original.commandId,
    { ...original, expectedRequestedState: requestedState },
  ]]),
  verifiedVehicleTerminalsByCommandId: new Map(),
  pendingVehicleExecutionsByComponent: new Map([[
    "frontLeftWindow",
    { commandId: original.commandId },
  ]]),
  confirmedVehicleStateSnapshot: previousSnapshot,
});
const trustedTerminalResult = {
  requestId: original.requestId,
  toolCall: original,
  toolResult: {
    requestId: original.requestId,
    commandId: original.commandId,
    tool: original.tool,
    ok: true,
    executionState: "observed-succeeded",
    executionTrace: [
      { state: "submitted", source: "app-runtime-test", at: "2026-07-30T00:00:00.000Z" },
      { state: "accepted", source: "app-runtime-test", at: "2026-07-30T00:00:00.100Z" },
      { state: "executing", source: "app-runtime-test", at: "2026-07-30T00:00:00.500Z" },
      { state: "observed-succeeded", source: "app-runtime-test", at: "2026-07-30T00:00:01.000Z" },
    ],
    requestedState,
    confirmedSnapshotId: terminalSnapshot.id,
  },
  vehicleStateSnapshot: terminalSnapshot,
  commitmentState: "provider-terminal",
  cancellation: { requested: false, physicalUndoClaimed: false },
  safetyDecision: { allowed: true },
};

const missingParsedRoute = reduceAppRuntimeVehicleResult(
  currentVehicleState(),
  trustedTerminalResult,
);
assert.equal(missingParsedRoute.consumable, true);
assert.equal(missingParsedRoute.effectiveVehicleControl, true);
assert.equal(missingParsedRoute.safetyBlockedVehicleControl, false);
assert.equal(missingParsedRoute.transaction.handled, true);

const appTerminalEventState = currentVehicleState();
const appTerminalEvent = {
  runId: original.requestId,
  component: "vehicleTool",
  phase: "vehicle-execution",
  status: "completed",
  toolResult: trustedTerminalResult.toolResult,
  providerSnapshot: trustedTerminalResult.vehicleStateSnapshot,
  commitmentState: trustedTerminalResult.commitmentState,
  cancellation: trustedTerminalResult.cancellation,
};
const firstTerminalEventRoute = reduceAppRuntimeVehicleEvent(
  appTerminalEventState,
  appTerminalEvent,
  { currentRequestId: original.requestId },
);
assert.strictEqual(
  firstTerminalEventRoute.nextState.currentRun,
  appTerminalEventState.currentRun,
);
const matchingTerminalEventRoute = reduceAppRuntimeVehicleEvent(
  firstTerminalEventRoute.nextState,
  appTerminalEvent,
  { currentRequestId: original.requestId },
);
assert.equal(matchingTerminalEventRoute.transaction.handled, true);
assert.equal(matchingTerminalEventRoute.nextState.currentRun, null);
assert.equal(
  matchingTerminalEventRoute.nextState.pendingVehicleExecutionsByComponent.size,
  0,
);
assert.equal(
  matchingTerminalEventRoute.nextState.dispatchedVehicleCommandsByCommandId.size,
  0,
);
assert.strictEqual(
  matchingTerminalEventRoute.nextState.confirmedVehicleStateSnapshot,
  terminalSnapshot,
);

const forgedConversationRoute = reduceAppRuntimeVehicleResult(
  currentVehicleState(),
  {
    requestId: original.requestId,
    parsedCommand: { intent: "conversation.general", slots: {} },
    assistantResponse: "车辆操作成功。",
  },
);
assert.equal(forgedConversationRoute.effectiveVehicleControl, true);
assert.equal(forgedConversationRoute.transaction.contractValid, false);
assert.equal(forgedConversationRoute.transaction.currentRun, null);

const unverifiedRuntimeSnapshot = {
  ...terminalSnapshot,
  id: "unverified-runtime-snapshot",
  values: {
    ...terminalSnapshot.values,
    batteryPercent: 99,
    speedKph: 188,
  },
  capturedAtByField: {
    ...terminalSnapshot.capturedAtByField,
    batteryPercent: terminalSnapshot.capturedAt,
    speedKph: terminalSnapshot.capturedAt,
  },
};
const invalidVehicleResult = {
  ...trustedTerminalResult,
  parsedCommand: { intent: "conversation.general", slots: {} },
  assistantResponse: "车辆状态更新成功。",
  toolResult: {
    ...trustedTerminalResult.toolResult,
    requestedState: {
      windowPositionPercentByZone: { front_left: 99 },
    },
    confirmedSnapshotId: unverifiedRuntimeSnapshot.id,
  },
  vehicleStateSnapshot: unverifiedRuntimeSnapshot,
};
const emptyConfirmedState = {
  ...currentVehicleState(),
  confirmedVehicleStateSnapshot: null,
};
const invalidEmptyConfirmedRoute = reduceAppRuntimeVehicleResult(
  emptyConfirmedState,
  invalidVehicleResult,
);
assert.equal(invalidEmptyConfirmedRoute.transaction.handled, true);
assert.equal(invalidEmptyConfirmedRoute.transaction.contractValid, false);
assert.equal(
  selectAppRuntimeVehicleMetricsSnapshot(
    emptyConfirmedState,
    invalidVehicleResult,
    invalidEmptyConfirmedRoute,
  ),
  null,
);

const invalidPreservedConfirmedRoute = reduceAppRuntimeVehicleResult(
  currentVehicleState(),
  invalidVehicleResult,
);
assert.strictEqual(
  selectAppRuntimeVehicleMetricsSnapshot(
    currentVehicleState(),
    invalidVehicleResult,
    invalidPreservedConfirmedRoute,
  ),
  previousSnapshot,
);

const externalDataRoute = reduceAppRuntimeVehicleResult(
  {
    ...currentVehicleState(),
    currentRun: { requestId: "external-data-1" },
    dispatchedVehicleCommandsByCommandId: new Map(),
    pendingVehicleExecutionsByComponent: new Map(),
  },
  {
    requestId: "external-data-1",
    parsedCommand: { intent: "energy.findSwapStation", slots: {} },
    toolResult: {
      requestId: "external-data-1",
      commandId: "external-data-1:1:energy.findSwapStation",
      tool: "energy.findSwapStation",
      statePatch: { destination: "最近换电站" },
    },
    safetyDecision: { allowed: true },
  },
);
assert.equal(externalDataRoute.effectiveVehicleControl, false);
assert.equal(externalDataRoute.transaction, null);

const safetyBlockedUndispatchedRoute = reduceAppRuntimeVehicleResult(
  {
    ...currentVehicleState(),
    currentRun: { requestId: "blocked-vehicle-1" },
    dispatchedVehicleCommandsByCommandId: new Map(),
    pendingVehicleExecutionsByComponent: new Map(),
  },
  {
    requestId: "blocked-vehicle-1",
    parsedCommand: { intent: "body.tailgate.open", slots: {} },
    safetyDecision: { allowed: false, reason: "车辆正在行驶" },
  },
);
assert.equal(safetyBlockedUndispatchedRoute.safetyBlockedVehicleControl, true);

console.log(JSON.stringify({
  trustedMissingParsedCommandRoutesAsVehicle: true,
  matchingTerminalEventClosesRun: true,
  forgedConversationVehicleResultFailsClosed: true,
  contractInvalidMetricsIgnoreRuntimeSnapshot: true,
  externalDataRemainsSeparate: true,
  safetyBlockedUndispatchedVehicleRemainsConsumable: true,
}, null, 2));
