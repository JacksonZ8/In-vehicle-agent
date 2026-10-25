#!/usr/bin/env node
import assert from "node:assert/strict";
import { DemoSensorSimulator } from "../../src/vehicle/demo-sensor-simulator.js";
import { createVehicleStateSnapshot, DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";
import { SafetyGateway, SAFETY_ENFORCEMENT_PROFILES } from "../../src/safety/safety-gateway.js";
import {
  countCalls,
  createLeanRuntimeVehicleControlHarness,
} from "../lib/lean-runtime-test-harness.mjs";

const NOW = Date.parse("2026-08-04T10:00:00.000Z");

function windowCommand(zone = "front_left", percent = 50) {
  return {
    requestId: "sensor-flow:window",
    rawText: "把主驾车窗打开一半",
    intent: "body.window.setPosition",
    confidence: 1,
    slots: { zone, percent },
    slotProvenance: { zone: "explicit", percent: "explicit" },
    speechAct: "command",
    actionability: {
      actionable: true,
      reason: "sensor flow fixture",
      source: "unit-fixture",
      intendedIntent: "body.window.setPosition",
    },
    source: "unit-fixture",
  };
}

// 同一车窗命令的三态表驱动验收：Vehicle Provider 调用次数必须与 Safety 裁决严格对应。
for (const [label, options, expected] of [
  ["safe-fresh", {}, {
    action: "allow", executionCalls: 1, toolState: "observed-succeeded", eventStatus: "completed",
  }],
  ["anti-pinch-unavailable", { safetyState: { windowAntiPinchAvailable: false } }, {
    action: "reject", executionCalls: 0, toolState: null, eventStatus: "safety_rejected",
  }],
  ["stale-provider", { staleProvider: true }, {
    action: "unavailable", executionCalls: 0, toolState: null, eventStatus: "unavailable",
  }],
  ["unknown-rain", { safetyState: { rainDetected: null } }, {
    action: "unavailable", executionCalls: 0, toolState: null, eventStatus: "unavailable",
  }],
]) {
  const harness = createLeanRuntimeVehicleControlHarness(options);
  const result = await harness.runtime.run("把主驾车窗打开一半", {
    requestId: `run:sensor-flow:${label}`,
  });
  assert.equal(result.safetyDecision.action, expected.action, label);
  for (const callName of [
    "vehicle.execute",
    "vehicle.adapter.execute",
    "sensor.submit",
    "provider.ingestObservation",
  ]) {
    assert.equal(
      countCalls(harness.calls, callName),
      expected.executionCalls,
      `${label} ${callName} count`,
    );
  }
  if (expected.toolState === null) {
    assert.equal(result.toolCall, null, label);
    assert.equal(result.toolResult, null, label);
  } else {
    assert.equal(result.toolResult.executionState, expected.toolState, label);
  }
  const safetyEvent = harness.ledger.getPreviousRun().events
    .find((event) => event.component === "safety");
  assert.equal(safetyEvent?.status, expected.eventStatus, `${label} Safety event status`);
}

// Developer panel 只能通过 Demo Sensor 读数进入 Provider；Provider 不暴露直接写 Safety/动画的入口。
{
  const simulator = new DemoSensorSimulator({
    now: () => new Date(NOW),
    initialVehicleState: { windowAntiPinchAvailable: true, rainDetected: false },
  });
  const provider = new DevVehicleStateProvider();
  const before = provider.getSnapshot();
  const reading = simulator.readVehicleState({ windowAntiPinchAvailable: false });
  const ingestion = provider.ingestDemoSensorState(reading);
  assert.equal(ingestion.ok, true);
  const after = provider.getSnapshot();
  assert.equal(after.values.windowAntiPinchAvailable, false);
  assert.notEqual(after.id, before.id, "a new sensor reading must form a new Provider snapshot");

  const decision = new SafetyGateway({}, { now: () => NOW }).evaluate(
    windowCommand(),
    { vehicleStateSnapshot: after },
  );
  assert.equal(decision.action, "reject", "Safety must see the Provider-confirmed anti-pinch state");
  assert.equal(decision.vehicleStateSnapshotId, after.id);

  const providerApi = Object.getOwnPropertyNames(DevVehicleStateProvider.prototype)
    .filter((name) => name !== "constructor");
  for (const forbidden of [
    "setSafetyContext",
    "writeVehicleState",
    "setVehicleState",
    "patchSafetyDecision",
  ]) {
    assert.equal(providerApi.includes(forbidden), false,
      `${forbidden} must not exist on DevVehicleStateProvider`);
  }
}

// 无快照时，需要车辆状态的 intent 必须 fail closed 为 safety_unavailable。
{
  const noSnapshot = new SafetyGateway({}, { now: () => NOW }).evaluate(windowCommand(), {});
  assert.equal(noSnapshot.allowed, false);
  assert.equal(noSnapshot.action, "unavailable");
  assert.equal(noSnapshot.vehicleStateSnapshotId, null);
  assert.equal(noSnapshot.vehicleStateAudit.source, null);
  assert.equal(noSnapshot.vehicleStateAudit.freshness.status, "unavailable");
  assert.equal(noSnapshot.safeSlots.originalIntent, "body.window.setPosition");
}

// 每次 Safety 决定必须携带唯一 vehicleStateSnapshotId、采集时间/新鲜度和 policy/rule/fact refs。
{
  const simulator = new DemoSensorSimulator({
    now: () => new Date(NOW),
    initialVehicleState: {
      speedKph: 0,
      gear: "P",
      rearClearance: true,
      windowAntiPinchAvailable: true,
      rainDetected: false,
      driverBackrestAngle: 106,
      cabinTemperature: 22,
    },
  });
  const provider = new DevVehicleStateProvider();
  provider.ingestDemoSensorState(simulator.readVehicleState());
  const snapshot = provider.ingestDemoSensorState(simulator.readVehicleState()).snapshot;
  const audited = new SafetyGateway({}, { now: () => NOW }).evaluate(
    windowCommand(),
    { vehicleStateSnapshot: snapshot },
  );
  assert.equal(audited.vehicleStateSnapshotId, snapshot.id);
  assert.equal(audited.vehicleStateAudit.snapshotId, snapshot.id);
  assert.equal(audited.vehicleStateAudit.capturedAt, snapshot.capturedAt);
  assert.equal(audited.vehicleStateAudit.freshness.status, "fresh");
  assert.deepEqual(audited.vehicleStateAudit.freshness.invalidatedFields, []);
  for (const field of audited.vehicleStateAudit.requiredFields) {
    assert.equal(audited.vehicleStateAudit.freshness.byField[field].status, "fresh");
  }
  // A missing unrelated cabin temperature must not make fresh window facts stale.
  const partial = createVehicleStateSnapshot({
    ...snapshot, id: `${snapshot.id}:missing-cabin-temperature`,
    values: { ...snapshot.values, cabinTemperature: null },
    capturedAtByField: { ...snapshot.capturedAtByField, cabinTemperature: null },
  });
  const partialDecision = new SafetyGateway({}, { now: () => NOW }).evaluate(
    windowCommand(), { vehicleStateSnapshot: partial },
  );
  assert.equal(partial.values.cabinTemperature, null);
  assert.equal(partialDecision.action, "allow");
  assert.equal(partialDecision.vehicleStateAudit.freshness.status, "partial-stale");
  assert.deepEqual(partialDecision.vehicleStateAudit.freshness.invalidatedFields, ["cabinTemperature"]);
  for (const field of partialDecision.vehicleStateAudit.requiredFields) {
    assert.equal(partialDecision.vehicleStateAudit.freshness.byField[field].status, "fresh");
  }
  assert.equal(
    audited.policyId,
    SAFETY_ENFORCEMENT_PROFILES["body.window.setPosition"].profileId,
  );
  assert.equal(
    audited.policyVersion,
    SAFETY_ENFORCEMENT_PROFILES["body.window.setPosition"].version,
  );
  assert.deepEqual(audited.vehicleStateAudit.requiredFields, [
    "windowAntiPinchAvailable",
    "rainDetected",
  ]);
  assert.deepEqual(
    audited.vehicleStateAudit.factRefs.map((ref) => ref.id),
    [
      `${snapshot.id}#windowAntiPinchAvailable`,
      `${snapshot.id}#rainDetected`,
    ],
  );
}

console.log("safety sensor execution flow verification passed");
