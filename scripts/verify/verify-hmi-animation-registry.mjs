import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applyExternalDataHmiAnimation,
  mapExternalDataToolResultToHmiAnimation,
  resolveModeByScenario,
  resolvePresentationByScenario,
} from "../../src/vehicle/hmi-animation-adapter.js";
import { createRuntimePresentationBridge } from "../../src/app/runtime-presentation-bridge.js";

const vehicleThree = fs.readFileSync(new URL("../../src/app/vehicle-three.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../src/app/app.js", import.meta.url), "utf8");

assert.equal(resolvePresentationByScenario("windowControl").defaultComponent, "frontLeftWindow");
assert.equal(resolvePresentationByScenario("trunkControl").defaultComponent, "tailgate");
assert.equal(resolvePresentationByScenario("componentControl").defaultComponent, "vehicleComponent");
assert.equal(resolvePresentationByScenario("energy").defaultComponent, "battery");
assert.equal(resolveModeByScenario("windowControl"), "cabin");
assert.equal(resolveModeByScenario("trunkControl"), "tailgate");
assert.equal(resolveModeByScenario("componentControl"), "cabin");
assert.equal(resolveModeByScenario("energy"), "energy");
assert.equal(resolveModeByScenario("planning"), "planning");
assert.equal(resolveModeByScenario("blocked"), "blocked");
assert.equal(resolveModeByScenario("none"), "no-animation");
assert.match(vehicleThree, /resolvePresentationByScenario/);
const playScenarioStart = vehicleThree.indexOf("playScenarioAnimation(scenarioOrMode, options = {}) {");
const playScenarioEnd = vehicleThree.indexOf("  getState() {", playScenarioStart);
const playScenarioSource = vehicleThree.slice(playScenarioStart, playScenarioEnd);
assert.ok(playScenarioStart >= 0 && playScenarioEnd > playScenarioStart);
assert.match(playScenarioSource, /if \(!modelLoaded\) return false;/);
assert.match(playScenarioSource, /es7AnimationRuntime\?\.setConfirmedSnapshot\(/);
assert.match(playScenarioSource, /animationController\.play\(scenarioOrMode, options\);/);
assert.match(playScenarioSource, /return true;/,
  "the public rig must explicitly distinguish an accepted animation from a model-not-loaded no-op");
assert.doesNotMatch(vehicleThree, /const componentByScenario =/);
assert.match(app, /createRuntimePresentationBridge\(\{/);
assert.match(app, /applyVehiclePresentation: applyRuntimeVehiclePresentation/);
assert.match(app, /tailgate:\s*"尾门已开启"/);
verifyRuntimePresentationBoundary();

const navigation = mapExternalDataToolResultToHmiAnimation({
  tool: "navigation.planRoute",
  ok: true,
  source: "external-data-dev-adapter",
  statePatch: { destination: "公司", distanceKm: "simulated" },
});
assert.equal(navigation.visualScenario, "planning");
assert.equal(navigation.mode, "completed");
assert.equal(navigation.component, "body");
assert.equal(navigation.statePatch.destination, "公司");

const vehicleWriteViaExternalCompatibility = mapExternalDataToolResultToHmiAnimation({
  tool: "body.window.setPosition",
  ok: true,
  statePatch: { windowPositionPercent: 100 },
});
assert.equal(vehicleWriteViaExternalCompatibility.visualScenario, "none");
assert.equal(vehicleWriteViaExternalCompatibility.noAnimation, true);

const unknown = mapExternalDataToolResultToHmiAnimation({
  tool: "external-data.unknown",
  ok: false,
  statePatch: { rejected: true },
});
assert.equal(unknown.visualScenario, "none");
assert.equal(unknown.noAnimation, true);

const played = [];
applyExternalDataHmiAnimation(navigation, {
  playScenarioAnimation(scenario, animation) {
    played.push({ scenario, animation });
  },
});
applyExternalDataHmiAnimation(unknown, {
  playScenarioAnimation() {
    played.push("unexpected");
  },
});
assert.equal(played.length, 1);
assert.equal(played[0].scenario, "planning");

console.log(JSON.stringify({
  registryResolution: true,
  externalDataCompatibilityIsIndependent: true,
  unknownToolsNoAnimation: true,
}, null, 2));

function verifyRuntimePresentationBoundary() {
  const runId = "run:animation-registry";
  const turn = Object.freeze({
    sessionId: "session:animation-registry",
    turnId: "turn:animation-registry",
    runId,
  });
  const state = {
    mode: "idle",
    currentRun: { requestId: runId, interactionTurn: turn, events: [] },
    consumedRuntimeRequestIds: new Set(),
    providerSnapshot: null,
  };
  const vehicleCalls = [];
  const bridge = createRuntimePresentationBridge({
    state,
    interactionSessionController: {
      isCurrent(identity) {
        return identity?.sessionId === turn.sessionId
          && identity?.turnId === turn.turnId
          && identity?.runId === turn.runId;
      },
      linkRun() {},
    },
    render() {},
    applyVehiclePresentation(input) {
      vehicleCalls.push(input);
    },
  });
  const command = Object.freeze({
    requestId: runId,
    commandId: `${runId}:1:body.window.setPosition`,
    tool: "body.window.setPosition",
    args: Object.freeze({ zone: "front_left", percent: 50 }),
  });
  const interactionRef = Object.freeze({ sessionId: turn.sessionId, turnId: turn.turnId });
  const baseEvent = {
    runId,
    component: "vehicleTool",
    componentType: "tool-interface",
    phase: "vehicle-execution",
    refs: Object.freeze([]),
  };
  const pending = bridge.handleEvent(Object.freeze({
    ...baseEvent,
    eventId: `event:${runId}:1`,
    sequence: 1,
    timestamp: "2026-08-05T12:00:00.000Z",
    status: "processing",
    metadata: Object.freeze({
      interactionRef,
      vehicle: Object.freeze({ toolCall: command, commitmentState: "dispatching" }),
    }),
  }));
  assert.equal(pending.vehicle.authorized, true);
  assert.equal(vehicleCalls.at(-1).authorization, "pending");

  state.providerSnapshot = Object.freeze({
    id: "snapshot:animation-registry",
    source: "demo-sensor-simulator",
    simulated: true,
    capturedAt: "2026-08-05T12:00:00.005Z",
    capturedAtByField: Object.freeze({
      windowPositionPercentByZone: "2026-08-05T12:00:00.005Z",
    }),
    values: Object.freeze({
      windowPositionPercentByZone: Object.freeze({ front_left: 50 }),
    }),
  });
  const requestedState = Object.freeze({
    windowPositionPercentByZone: Object.freeze({ front_left: 50 }),
  });
  const terminal = bridge.handleEvent(Object.freeze({
    ...baseEvent,
    eventId: `event:${runId}:2`,
    sequence: 2,
    timestamp: "2026-08-05T12:00:00.006Z",
    status: "completed",
    metadata: Object.freeze({
      interactionRef,
      vehicle: Object.freeze({
        commitmentState: "provider-terminal",
        cancellation: Object.freeze({ requested: false, physicalUndoClaimed: false }),
        toolResult: Object.freeze({
          requestId: runId,
          commandId: command.commandId,
          tool: command.tool,
          ok: true,
          executionState: "observed-succeeded",
          confirmedSnapshotId: state.providerSnapshot.id,
          requestedState,
          executionTrace: Object.freeze([
            Object.freeze({ state: "submitted", source: "demo", at: "2026-08-05T12:00:00.000Z" }),
            Object.freeze({ state: "accepted", source: "demo", at: "2026-08-05T12:00:00.001Z" }),
            Object.freeze({ state: "executing", source: "demo", at: "2026-08-05T12:00:00.002Z" }),
            Object.freeze({ state: "observed-succeeded", source: "demo", at: "2026-08-05T12:00:00.003Z" }),
          ]),
        }),
      }),
    }),
  }));
  assert.equal(terminal.vehicle.authorized, true);
  assert.equal(vehicleCalls.at(-1).authorization, "confirmed");
  assert.equal(vehicleCalls.filter((call) => call.authorization === "confirmed").length, 1);

  const conflictCommand = Object.freeze({
    ...command,
    commandId: `${runId}:2:body.window.setPosition`,
  });
  bridge.handleEvent(Object.freeze({
    ...baseEvent,
    eventId: `event:${runId}:3`,
    sequence: 3,
    timestamp: "2026-08-05T12:00:00.007Z",
    status: "processing",
    metadata: Object.freeze({
      interactionRef,
      vehicle: Object.freeze({ toolCall: conflictCommand, commitmentState: "dispatching" }),
    }),
  }));
  state.providerSnapshot = Object.freeze({
    ...state.providerSnapshot,
    id: "snapshot:animation-conflict",
    capturedAt: "2026-08-05T12:00:00.012Z",
    capturedAtByField: Object.freeze({
      windowPositionPercentByZone: "2026-08-05T12:00:00.012Z",
    }),
    values: Object.freeze({
      windowPositionPercentByZone: Object.freeze({ front_left: 30 }),
    }),
  });
  const conflict = bridge.handleEvent(Object.freeze({
    ...baseEvent,
    eventId: `event:${runId}:4`,
    sequence: 4,
    timestamp: "2026-08-05T12:00:00.013Z",
    status: "failed",
    metadata: Object.freeze({
      interactionRef,
      reasonCode: "sensor-observation-conflict",
      vehicle: Object.freeze({
        snapshot: Object.freeze({
          id: state.providerSnapshot.id,
          source: state.providerSnapshot.source,
          simulated: true,
          capturedAt: state.providerSnapshot.capturedAt,
        }),
        commitmentState: "provider-terminal",
        cancellation: Object.freeze({ requested: false, physicalUndoClaimed: false }),
        toolResult: Object.freeze({
          requestId: runId,
          commandId: conflictCommand.commandId,
          tool: conflictCommand.tool,
          ok: false,
          executionState: "failed",
          requestedState,
          executionError: Object.freeze({
            code: "sensor-observation-conflict",
            stage: "sensor-confirmation",
            retryable: false,
          }),
          executionTrace: Object.freeze([
            Object.freeze({ state: "submitted", source: "demo", at: "2026-08-05T12:00:00.007Z" }),
            Object.freeze({ state: "accepted", source: "demo", at: "2026-08-05T12:00:00.008Z" }),
            Object.freeze({ state: "executing", source: "demo", at: "2026-08-05T12:00:00.009Z" }),
            Object.freeze({ state: "failed", source: "demo", at: "2026-08-05T12:00:00.010Z" }),
          ]),
        }),
      }),
    }),
  }));
  assert.equal(conflict.vehicle.authorized, false, "failed command must remain failed");
  assert.equal(vehicleCalls.at(-1).authorization, "actual-state");
  assert.strictEqual(vehicleCalls.at(-1).providerSnapshot, state.providerSnapshot);

  const callsAfterBoundConflict = vehicleCalls.length;
  const unboundCommand = Object.freeze({
    ...conflictCommand,
    commandId: `${runId}:3:body.window.setPosition`,
  });
  const unboundConflictMetadata = Object.freeze({
    interactionRef,
    reasonCode: "sensor-observation-conflict",
    vehicle: Object.freeze({
      snapshot: Object.freeze({
        id: state.providerSnapshot.id,
        source: state.providerSnapshot.source,
        simulated: true,
        capturedAt: state.providerSnapshot.capturedAt,
      }),
      commitmentState: "provider-terminal",
      cancellation: Object.freeze({ requested: false, physicalUndoClaimed: false }),
      toolResult: Object.freeze({
        ...vehicleCalls.at(-1).toolResult,
        commandId: unboundCommand.commandId,
      }),
    }),
  });
  const unboundConflict = bridge.handleEvent(Object.freeze({
    ...baseEvent,
    eventId: `event:${runId}:5`,
    sequence: 5,
    timestamp: "2026-08-05T12:00:00.014Z",
    status: "failed",
    metadata: unboundConflictMetadata,
  }));
  assert.equal(unboundConflict.vehicle.authorized, false);
  assert.equal(vehicleCalls.length, callsAfterBoundConflict,
    "a conflict without a registered dispatch must not reach vehicle presentation");

  const crossRunConflict = bridge.handleEvent(Object.freeze({
    ...baseEvent,
    runId: "run:forged-conflict",
    eventId: "event:run:forged-conflict:1",
    sequence: 1,
    timestamp: "2026-08-05T12:00:00.015Z",
    status: "failed",
    metadata: unboundConflictMetadata,
  }));
  assert.equal(crossRunConflict.accepted, false);
  assert.equal(vehicleCalls.length, callsAfterBoundConflict,
    "a cross-Run conflict must not reach vehicle presentation");
}
