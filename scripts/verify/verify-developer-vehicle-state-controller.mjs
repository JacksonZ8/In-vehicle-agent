import assert from "node:assert/strict";
import { DeveloperVehicleStateController } from "../../src/app/developer-vehicle-state-controller.js";
import { DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";
import { DemoSensorSimulator } from "../../src/vehicle/demo-sensor-simulator.js";
import {
  ES7_ACTION_CATALOG,
  ES7_GENERIC_ACTION_IDS,
} from "../../src/vehicle/es7-action-catalog.js";

const componentActionStateById = Object.freeze(Object.fromEntries(
  ES7_GENERIC_ACTION_IDS.map((actionId) => [actionId, ES7_ACTION_CATALOG[actionId].defaultValue]),
));
const initialState = Object.freeze({
  windowPositionPercentByZone: Object.freeze({
    front_left: 0,
    front_right: 0,
    rear_left: 0,
    rear_right: 0,
  }),
  tailgateOpen: false,
  driverBackrestAngle: 106,
  componentActionStateById,
  cabinTemperature: 22,
  airflow: "auto",
  passengerMode: "comfort",
  batteryPercent: 72,
  speedKph: 0,
  gear: "P",
  rearClearance: null,
  windowAntiPinchAvailable: true,
  rainDetected: false,
});

let locked = false;
const snapshots = [];
const audits = [];
const simulator = new DemoSensorSimulator({ initialVehicleState: initialState });
const provider = new DevVehicleStateProvider();
assert.equal(provider.ingestDemoSensorState(simulator.readVehicleState()).ok, true);

const controller = new DeveloperVehicleStateController({
  simulator,
  vehicleStateProvider: provider,
  initialState,
  isLocked: () => locked,
  onSnapshot: (snapshot) => snapshots.push(snapshot),
  onAudit: (audit) => audits.push(audit),
});

const firstWindow = controller.applyPatch({
  windowPositionPercentByZone: { front_left: 35 },
});
assert.equal(firstWindow.ok, true);
assert.equal(firstWindow.snapshot.values.windowPositionPercentByZone.front_left, 35);
assert.equal(firstWindow.snapshot.values.windowPositionPercentByZone.front_right, 0);

const secondWindow = controller.applyPatch({
  windowPositionPercentByZone: { rear_right: 80 },
});
assert.equal(secondWindow.ok, true);
assert.deepEqual(secondWindow.snapshot.values.windowPositionPercentByZone, {
  front_left: 35,
  front_right: 0,
  rear_left: 0,
  rear_right: 80,
});

const component = controller.applyPatch({
  componentActionStateById: { front_left_door_open: 1 },
});
assert.equal(component.ok, true);
assert.equal(component.snapshot.values.componentActionStateById.front_left_door_open, 1);
assert.equal(component.snapshot.values.componentActionStateById.driver_seat_height, 0);

const invalidSnapshotId = provider.getSnapshot().id;
const invalid = controller.applyPatch({ batteryPercent: 101 });
assert.equal(invalid.ok, false);
assert.equal(provider.getSnapshot().id, invalidSnapshotId);

locked = true;
const lockedSnapshotId = provider.getSnapshot().id;
const lockedResult = controller.applyPatch({ speedKph: 30 });
assert.equal(lockedResult.ok, false);
assert.equal(lockedResult.reason, "locked");
assert.equal(provider.getSnapshot().id, lockedSnapshotId);
locked = false;

const staleAt = new Date(Date.now() - 60_000).toISOString();
const stale = controller.applyPatch({ speedKph: 0 }, { capturedAt: staleAt });
assert.equal(stale.ok, true);
assert.equal(stale.snapshot.capturedAt, staleAt);

const fault = controller.applyPatch({
  speedKph: 0,
  gear: "P",
  rearClearance: true,
  windowAntiPinchAvailable: true,
  rainDetected: false,
  driverBackrestAngle: 106,
}, { mode: "sensor-fault" });
assert.equal(fault.ok, true);
assert.equal(fault.snapshot.values.speedKph, null);
assert.equal(fault.snapshot.values.gear, null);

const reset = controller.reset();
assert.equal(reset.ok, true);
assert.equal(reset.snapshot.values.speedKph, 0);
assert.equal(reset.snapshot.values.gear, "P");
assert.equal(reset.snapshot.values.componentActionStateById.front_left_door_open, 0);
assert.equal(reset.snapshot.values.windowPositionPercentByZone.rear_right, 0);
assert.ok(snapshots.length >= 6);
assert.ok(audits.every((entry) => entry.source === "demo-sensor-simulator"));

console.log("Developer vehicle state controller verification passed.");
