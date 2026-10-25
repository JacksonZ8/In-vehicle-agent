import assert from "node:assert/strict";
import { createToolCall } from "../../src/runtime/agent-schemas.js";
import {
  VEHICLE_EXECUTION_STATES,
  VEHICLE_EXECUTION_TERMINAL_STATES,
  VEHICLE_EXECUTION_TRANSITIONS,
  createVehicleExecution,
  DevCommandRegistry,
  isTerminalExecutionState,
  transitionVehicleExecution,
} from "../../src/vehicle/execution-state-contract.js";

const initial = () => createVehicleExecution({
  requestId: "request-1",
  commandId: "command-1",
  tool: "body.window.setPosition",
  requestedState: { frontLeftWindowPercent: 30 },
  source: "coordinator",
  at: "2026-07-26T00:00:00.000Z",
});

const advance = (execution, nextState, options = {}) => transitionVehicleExecution(execution, nextState, {
  source: "vehicle-service-adapter",
  at: "2026-07-26T00:00:01.000Z",
  ...options,
});

assert.deepEqual(VEHICLE_EXECUTION_STATES, [
  "submitted",
  "accepted",
  "executing",
  "duplicate-command",
  "observed-succeeded",
  "failed",
  "timeout",
]);
assert.deepEqual(VEHICLE_EXECUTION_TERMINAL_STATES, [
  "duplicate-command",
  "observed-succeeded",
  "failed",
  "timeout",
]);
assert.deepEqual(VEHICLE_EXECUTION_TRANSITIONS, {
  submitted: ["duplicate-command", "accepted", "failed", "timeout"],
  accepted: ["executing"],
  executing: ["observed-succeeded", "failed", "timeout"],
  "duplicate-command": [],
  "observed-succeeded": [],
  failed: [],
  timeout: [],
});

const submitted = initial();
assert.equal(submitted.executionState, "submitted");
assert.deepEqual(submitted.executionTrace, [{
  state: "submitted",
  source: "coordinator",
  at: "2026-07-26T00:00:00.000Z",
}]);
assert.deepEqual(submitted.requestedState, { frontLeftWindowPercent: 30 });
assert.equal(Object.isFrozen(submitted), true);
assert.equal(Object.isFrozen(submitted.requestedState), true);
assert.throws(
  () => createVehicleExecution({
    requestId: "request-without-command-id",
    tool: "body.window.setPosition",
    requestedState: {},
    source: "coordinator",
    at: "2026-07-26T00:00:00.000Z",
  }),
  /commandId is required/i,
);
assert.throws(
  () => createVehicleExecution({
    requestId: "request-with-invalid-command-id",
    commandId: 42,
    tool: "body.window.setPosition",
    requestedState: {},
    source: "coordinator",
    at: "2026-07-26T00:00:00.000Z",
  }),
  /commandId is required/i,
);

const accepted = advance(submitted, "accepted");
const executing = advance(accepted, "executing", { traceData: { adapterRequestId: "adapter-1" } });
const executingWithTraceData = advance(accepted, "executing", { traceData: { source: undefined, at: undefined } });
const observed = advance(executing, "observed-succeeded", { traceData: { observationId: "observation-1" } });
assert.equal(observed.executionState, "observed-succeeded");
assert.deepEqual(observed.executionTrace.at(-1), {
  state: "observed-succeeded",
  source: "vehicle-service-adapter",
  at: "2026-07-26T00:00:01.000Z",
  observationId: "observation-1",
});
assert.equal(submitted.executionState, "submitted", "transition must not mutate prior execution");
assert.equal(executingWithTraceData.executionTrace.at(-1).source, "vehicle-service-adapter");
assert.equal(executingWithTraceData.executionTrace.at(-1).at, "2026-07-26T00:00:01.000Z");

const duplicate = advance(initial(), "duplicate-command");
const submittedFailed = advance(initial(), "failed", {
  error: {
    code: "submission-rejected",
    message: "submission rejected before acceptance",
    stage: "submission",
    retryable: false,
  },
});
const submittedTimeout = advance(initial(), "timeout", {
  error: {
    code: "submission-timeout",
    message: "submission did not complete",
    stage: "submission",
    retryable: true,
  },
});
const failed = advance(executing, "failed", {
  error: {
    code: "actuator-rejected",
    message: "vehicle rejected command",
    stage: "execution",
    retryable: false,
  },
});
const timeout = advance(executing, "timeout", {
  error: {
    code: "adapter-timeout",
    message: "vehicle did not respond",
    stage: "execution",
    retryable: true,
  },
});
assert.deepEqual(failed.executionError, {
  code: "actuator-rejected",
  message: "vehicle rejected command",
  stage: "execution",
  retryable: false,
});
assert.deepEqual(timeout.executionError, {
  code: "adapter-timeout",
  message: "vehicle did not respond",
  stage: "execution",
  retryable: true,
});

assert.throws(() => advance(initial(), "executing"), /illegal execution transition/i);
assert.throws(() => advance(advance(initial(), "accepted"), "observed-succeeded"), /illegal execution transition/i);
assert.throws(() => advance(advance(initial(), "accepted"), "failed", {
  error: { code: "wrong-stage", message: "accepted cannot fail", stage: "test", retryable: false },
}), /illegal execution transition/i);
assert.throws(() => advance(advance(initial(), "accepted"), "timeout", {
  error: { code: "wrong-stage", message: "accepted cannot timeout", stage: "test", retryable: false },
}), /illegal execution transition/i);
assert.throws(() => advance(executing, "failed", {
  error: { code: "missing-fields", message: "missing stage and retryable" },
}), /invalid execution error/i);

for (const terminalExecution of [duplicate, observed, submittedFailed, submittedTimeout, failed, timeout]) {
  assert.equal(isTerminalExecutionState(terminalExecution.executionState), true);
  assert.throws(
    () => advance(terminalExecution, "failed", {
      error: { code: "should-not-transition", message: "terminal", stage: "test", retryable: false },
    }),
    /terminal execution state|illegal execution transition/i,
  );
}
assert.equal(isTerminalExecutionState("executing"), false);

const bridgeRegistry = new DevCommandRegistry({ now: () => 0 });
assert.equal(bridgeRegistry.register("bridge-command"), true);
assert.equal(bridgeRegistry.register("bridge-command"), false);
assert.throws(() => bridgeRegistry.register(), /commandId is required/i);
assert.equal(typeof bridgeRegistry.begin, "undefined");

const { VehicleTools } = await import("../../src/vehicle/vehicle-tools.js");
const { ExternalDataAdapter } = await import("../../src/external-data/external-data-adapter.js");
assert.equal(typeof VehicleTools, "function");
assert.equal(typeof ExternalDataAdapter, "function");
assert.equal(
  createToolCall("factory-request", "body.tailgate.open", { open: true }).commandId,
  "factory-request:1:body.tailgate.open",
);
assert.equal(
  createToolCall("factory-request", "body.tailgate.open", { open: true }, true, {}, { sequence: 2 }).commandId,
  "factory-request:2:body.tailgate.open",
);
for (const sequence of [0, -1, 1.5, "2", Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(
    () => createToolCall("factory-request", "body.tailgate.open", { open: true }, true, {}, { sequence }),
    /sequence must be a positive safe integer/i,
  );
}
await assert.rejects(
  () => new VehicleTools().execute({
    requestId: "adapter-must-not-fallback",
    tool: "body.tailgate.open",
    args: { open: true },
  }),
  /commandId is required/i,
);
await assert.rejects(
  () => new ExternalDataAdapter().execute({
    requestId: "external-adapter-must-not-fallback",
    tool: "navigation.planRoute",
    args: { origin: "上海", destination: "杭州", energyPolicy: "balanced" },
  }),
  /commandId is required/i,
);

console.log(JSON.stringify({
  ok: true,
  legalEdgesCovered: 8,
  illegalEdgesRejected: 4,
  terminalStatesFrozen: VEHICLE_EXECUTION_TERMINAL_STATES.length,
}, null, 2));
