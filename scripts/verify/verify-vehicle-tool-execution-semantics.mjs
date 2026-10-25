import assert from "node:assert/strict";
import {
  createToolCall,
  createToolResult,
  createVehicleToolResult,
} from "../../src/runtime/agent-schemas.js";
import { VehicleTools } from "../../src/vehicle/vehicle-tools.js";

function assertVehicleResultContract(result, expected = {}) {
  assert.equal(result.commandId, expected.commandId);
  assert.equal(result.executionState, expected.executionState);
  assert.equal(result.source, "dev-adapter");
  assert.equal(result.simulated, expected.simulated);
  assert.equal("statePatch" in result, false);
  assert.equal("observedState" in result, false);
  assert.equal("statePatchSource" in result, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.executionTrace), true);
  assert.deepEqual(result.executionTrace.map((item) => item.state), expected.traceStates);
}

async function assertRejectsInvalidCommandIds(execute, label) {
  for (const [caseName, commandIdentity] of [
    ["missing", {}],
    ["empty", { commandId: "" }],
    ["non-string", { commandId: 42 }],
  ]) {
    await assert.rejects(
      () => execute(commandIdentity),
      /commandId is required/i,
      `${label} must reject ${caseName} commandId`,
    );
  }
}

const tailgateCall = createToolCall(
  "veh-test-tailgate",
  "body.tailgate.open",
  { open: true },
  true,
  {},
  { sequence: 3 },
);
assert.equal(tailgateCall.commandId, "veh-test-tailgate:3:body.tailgate.open");

const vehicleTools = new VehicleTools({ now: () => Date.parse("2026-07-26T00:00:00.000Z") });
const tailgate = await vehicleTools.execute(tailgateCall);
assertVehicleResultContract(tailgate, {
  commandId: tailgateCall.commandId,
  executionState: "accepted",
  simulated: true,
  traceStates: ["submitted", "accepted"],
});
assert.deepEqual(tailgate.requestedState, { tailgateOpen: true });
assert.equal(Object.isFrozen(tailgate.requestedState), true);

const windowCall = createToolCall(
  "veh-test-window",
  "body.window.setPosition",
  { zone: "front_left", percent: 30 },
);
const window = await vehicleTools.execute(windowCall);
assertVehicleResultContract(window, {
  commandId: windowCall.commandId,
  executionState: "accepted",
  simulated: true,
  traceStates: ["submitted", "accepted"],
});
assert.deepEqual(window.requestedState, {
  windowPositionPercentByZone: { front_left: 30 },
});
assert.equal("antiPinch" in window.requestedState, false);

const seat = await vehicleTools.execute(createToolCall(
  "veh-test-seat",
  "seat.driver.setBackrestAngle",
  { angle: 105 },
));
assert.deepEqual(seat.requestedState, { driverBackrestAngle: 105 });

const hood = await vehicleTools.execute(createToolCall(
  "veh-test-es7-component",
  "vehicle.component.setState",
  { actionId: "hood_open", value: 1 },
));
assertVehicleResultContract(hood, {
  commandId: "veh-test-es7-component:1:vehicle.component.setState",
  executionState: "accepted",
  simulated: true,
  traceStates: ["submitted", "accepted"],
});
assert.deepEqual(hood.requestedState, { componentActionStateById: { hood_open: 1 } });

const bothMirrors = await vehicleTools.execute(createToolCall(
  "veh-test-es7-mirrors",
  "vehicle.component.setState",
  { actionId: "mirrors_fold_both", value: 1 },
));
assert.deepEqual(bothMirrors.requestedState, {
  componentActionStateById: { mirror_left_fold: 1, mirror_right_fold: 1 },
});

const invalidComponent = await vehicleTools.execute(createToolCall(
  "veh-test-es7-invalid",
  "vehicle.component.setState",
  { actionId: "hood_open", value: 2 },
));
assert.equal(invalidComponent.executionState, "failed");
assert.equal(invalidComponent.executionError.code, "invalid-component-action");

const climate = await vehicleTools.execute(createToolCall(
  "veh-test-climate",
  "cabin.climate.setPreset",
  { temperature: 24, airflow: "medium", passengerMode: "all" },
));
assert.deepEqual(climate.requestedState, {
  cabinTemperature: 24,
  airflow: "medium",
  passengerMode: "all",
});

const temperatureOnlyClimate = await vehicleTools.execute(createToolCall(
  "veh-test-climate-temperature-only",
  "cabin.climate.setPreset",
  { temperature: 23 },
));
assert.deepEqual(temperatureOnlyClimate.requestedState, {
  cabinTemperature: 23,
}, "omitted optional climate slots must not become undefined requested-state fields");

const duplicateWindow = await vehicleTools.execute(windowCall);
assertVehicleResultContract(duplicateWindow, {
  commandId: windowCall.commandId,
  executionState: "duplicate-command",
  simulated: true,
  traceStates: ["submitted", "duplicate-command"],
});
assert.deepEqual(duplicateWindow.requestedState, {
  windowPositionPercentByZone: { front_left: 30 },
});
assert.deepEqual(duplicateWindow.executionError, {
  code: "duplicate-command",
  message: `重复 commandId ${windowCall.commandId}`,
  stage: "adapter-begin",
  retryable: false,
});

const timeoutCall = createToolCall(
  "veh-test-timeout",
  "body.tailgate.open",
  { open: false },
);
const timeoutTools = new VehicleTools({
  now: () => Date.parse("2026-07-26T00:00:00.000Z"),
  timeoutCommandIds: [timeoutCall.commandId],
});
const timeoutTailgate = await timeoutTools.execute(timeoutCall);
assertVehicleResultContract(timeoutTailgate, {
  commandId: timeoutCall.commandId,
  executionState: "timeout",
  simulated: true,
  traceStates: ["submitted", "timeout"],
});
assert.deepEqual(timeoutTailgate.executionError, {
  code: "dev-adapter-timeout",
  message: `commandId ${timeoutCall.commandId} 在开发适配器中模拟超时`,
  stage: "submission",
  retryable: true,
});

const safetyCall = createToolCall(
  "veh-test-safety-reject",
  "safety.reject",
  { reason: "测试安全拒绝", alternative: "保持当前状态。" },
);
const safetyRejected = await vehicleTools.execute(safetyCall);
assertVehicleResultContract(safetyRejected, {
  commandId: safetyCall.commandId,
  executionState: "failed",
  simulated: false,
  traceStates: ["submitted", "failed"],
});
assert.equal(safetyRejected.requestedState, undefined);
assert.deepEqual(safetyRejected.executionError, {
  code: "safety-rejected",
  message: "测试安全拒绝",
  stage: "safety",
  retryable: false,
});

const unknownCall = createToolCall("veh-test-unknown", "unknown.tool", {});
const unknown = await vehicleTools.execute(unknownCall);
assertVehicleResultContract(unknown, {
  commandId: unknownCall.commandId,
  executionState: "failed",
  simulated: false,
  traceStates: ["submitted", "failed"],
});
assert.equal(unknown.requestedState, undefined);
assert.equal(unknown.executionError.code, "unknown-tool");

await assertRejectsInvalidCommandIds(
  (commandIdentity) => vehicleTools.execute({
    requestId: "veh-test-invalid-command-id",
    tool: "body.tailgate.open",
    args: { open: true },
    ...commandIdentity,
  }),
  "vehicle command",
);

const mutableRequestedState = { tailgateOpen: true, nested: { source: "test" } };
const factoryResult = createVehicleToolResult({
  requestId: "factory-request",
  commandId: "factory-request:1:body.tailgate.open",
  tool: "body.tailgate.open",
  ok: true,
  executionState: "accepted",
  requestedState: mutableRequestedState,
  executionTrace: [
    { state: "submitted", source: "test", at: "2026-07-26T00:00:00.000Z" },
    { state: "accepted", source: "test", at: "2026-07-26T00:00:01.000Z" },
  ],
  hmiSummary: "test",
  visualScenario: "trunkControl",
  source: "test",
  simulated: true,
  timestamp: "2026-07-26T00:00:00.000Z",
});
mutableRequestedState.nested.source = "mutated";
assert.deepEqual(factoryResult.requestedState, { tailgateOpen: true, nested: { source: "test" } });
assert.equal(Object.isFrozen(factoryResult.requestedState.nested), true);
const observedFactoryResult = createVehicleToolResult({
  requestId: "observed-factory-request",
  commandId: "observed-factory-request:1:body.tailgate.open",
  tool: "body.tailgate.open",
  ok: true,
  executionState: "observed-succeeded",
  confirmedSnapshotId: "snapshot-1",
  executionTrace: [
    { state: "submitted", source: "test", at: "2026-07-26T00:00:00.000Z" },
    { state: "accepted", source: "test", at: "2026-07-26T00:00:01.000Z" },
    { state: "executing", source: "test", at: "2026-07-26T00:00:02.000Z" },
    { state: "observed-succeeded", source: "test", at: "2026-07-26T00:00:03.000Z" },
  ],
  hmiSummary: "test",
  visualScenario: "trunkControl",
  source: "test",
  simulated: false,
  timestamp: "2026-07-26T00:00:03.000Z",
});
assert.equal(observedFactoryResult.confirmedSnapshotId, "snapshot-1");
assert.throws(
  () => createVehicleToolResult({ requestId: "missing-command-id", tool: "body.tailgate.open" }),
  /commandId is required/i,
);
assert.throws(
  () => createVehicleToolResult({
    requestId: "missing-error",
    commandId: "missing-error:1:body.tailgate.open",
    tool: "body.tailgate.open",
    ok: false,
    executionState: "failed",
    executionTrace: [
      { state: "submitted", source: "test", at: "2026-07-26T00:00:00.000Z" },
      { state: "failed", source: "test", at: "2026-07-26T00:00:01.000Z" },
    ],
  }),
  /invalid execution error/i,
);
assert.throws(
  () => createVehicleToolResult({
    requestId: "incomplete-error",
    commandId: "incomplete-error:1:body.tailgate.open",
    tool: "body.tailgate.open",
    ok: false,
    executionState: "failed",
    executionTrace: [
      { state: "submitted", source: "test", at: "2026-07-26T00:00:00.000Z" },
      { state: "failed", source: "test", at: "2026-07-26T00:00:01.000Z" },
    ],
    executionError: { code: "failed", message: "incomplete" },
  }),
  /invalid execution error/i,
);
for (const [caseName, invalid] of [
  ["non-boolean ok", { ok: "true" }],
  ["unknown execution state", { executionState: "succeeded" }],
  ["successful failed state", { executionState: "failed" }],
  ["failed accepted state", { ok: false, executionState: "accepted" }],
  ["missing trace", { executionTrace: [] }],
  ["trace must start submitted", { executionTrace: [{ state: "accepted", source: "test", at: "2026-07-26T00:00:00.000Z" }] }],
  ["trace must end at result state", { executionTrace: [
    { state: "submitted", source: "test", at: "2026-07-26T00:00:00.000Z" },
    { state: "executing", source: "test", at: "2026-07-26T00:00:01.000Z" },
  ] }],
  ["trace must use legal transition", { executionTrace: [
    { state: "submitted", source: "test", at: "2026-07-26T00:00:00.000Z" },
    { state: "executing", source: "test", at: "2026-07-26T00:00:01.000Z" },
    { state: "accepted", source: "test", at: "2026-07-26T00:00:02.000Z" },
  ] }],
  ["invalid trace source", { executionTrace: [
    { state: "submitted", source: "", at: "2026-07-26T00:00:00.000Z" },
    { state: "accepted", source: "test", at: "2026-07-26T00:00:01.000Z" },
  ] }],
  ["confirmed snapshot on unobserved result", { confirmedSnapshotId: "snapshot-1" }],
  ["empty confirmed snapshot", { executionState: "observed-succeeded", executionTrace: observedFactoryResult.executionTrace, confirmedSnapshotId: "" }],
]) {
  assert.throws(
    () => createVehicleToolResult({
      requestId: `invalid-${caseName}`,
      commandId: `invalid-${caseName}:1:body.tailgate.open`,
      tool: "body.tailgate.open",
      ok: true,
      executionState: "accepted",
      executionTrace: factoryResult.executionTrace,
      hmiSummary: "test",
      visualScenario: "trunkControl",
      source: "test",
      simulated: true,
      timestamp: "2026-07-26T00:00:00.000Z",
      ...invalid,
    }),
    /invalid vehicle tool result/i,
    `factory must reject ${caseName}`,
  );
}

const externalCompatibility = createToolResult(
  "external-compatible",
  "navigation.planRoute",
  true,
  { distanceKm: "simulated" },
  "external",
  "planning",
  "external-data-dev-adapter",
);
assert.deepEqual(externalCompatibility.statePatch, { distanceKm: "simulated" });
assert.deepEqual(externalCompatibility.observedState, { distanceKm: "simulated" });

console.log("✅ vehicle tool execution semantics verified");
