import {
  DEMO_VEHICLE_STATE_READ_MODES,
  validateDemoVehicleStatePatch,
} from "./demo-sensor-simulator.js";

const SAFE_VALUES = Object.freeze({
  speedKph: 0,
  gear: "P",
  rearClearance: true,
  windowAntiPinchAvailable: true,
  rainDetected: false,
  driverBackrestAngle: 106,
  cabinTemperature: 22,
});

const UNSAFE_VALUES = Object.freeze({
  speedKph: 35,
  gear: "D",
  rearClearance: false,
  windowAntiPinchAvailable: false,
  rainDetected: true,
  driverBackrestAngle: 112,
  cabinTemperature: 22,
});

const UNKNOWN_VALUES = Object.freeze({
  speedKph: null,
  gear: null,
  rearClearance: null,
  windowAntiPinchAvailable: null,
  rainDetected: null,
  driverBackrestAngle: null,
  cabinTemperature: null,
});

const CONFIRMATION_VALUES = Object.freeze({
  ...SAFE_VALUES,
  rearClearance: null,
});

function scenario(id, values, simulatorMode = "success") {
  return Object.freeze({ id, values, simulatorMode });
}

export const DEMO_SCENARIO_CATALOG = Object.freeze({
  safe: scenario("safe", SAFE_VALUES),
  unsafe: scenario("unsafe", UNSAFE_VALUES),
  unknown: scenario("unknown", UNKNOWN_VALUES),
  confirmation: scenario("confirmation", CONFIRMATION_VALUES),
  stale: scenario("stale", SAFE_VALUES),
  "sensor-fault": scenario("sensor-fault", SAFE_VALUES, "sensor-fault"),
});

export function getDemoScenario(id) {
  return DEMO_SCENARIO_CATALOG[String(id || "")] || null;
}

export function validateDemoScenarioPatch(patch) {
  return validateDemoVehicleStatePatch(patch);
}

export function normalizeDemoScenarioInput(input) {
  if (typeof input === "string") return getDemoScenario(input);
  if (input && typeof input === "object" && !Array.isArray(input) && Object.hasOwn(input, "id")) {
    const keys = Object.keys(input);
    const validKeys = new Set(["id", "values", "simulatorMode"]);
    if (keys.some((key) => !validKeys.has(key))
      || typeof input.id !== "string"
      || !input.id.trim()
      || !validateDemoScenarioPatch(input.values)
      || !DEMO_VEHICLE_STATE_READ_MODES.includes(input.simulatorMode)) {
      return null;
    }
    return scenario(input.id.trim(), Object.freeze({ ...input.values }), input.simulatorMode);
  }
  if (!validateDemoScenarioPatch(input)) return null;
  return scenario("custom", Object.freeze({ ...input }));
}

export function createDemoScenarioAuditData({
  scenario: input,
  stagedAt,
  capturedAtMode,
  capturedAt = null,
} = {}) {
  const selectedScenario = normalizeDemoScenarioInput(input);
  if (!selectedScenario) throw new TypeError("invalid demo scenario");
  if (!["now", "explicit"].includes(capturedAtMode)) throw new TypeError("invalid capturedAt mode");
  if (typeof stagedAt !== "string" || !Number.isFinite(Date.parse(stagedAt))) {
    throw new TypeError("invalid stagedAt");
  }
  if (capturedAt !== null && (typeof capturedAt !== "string" || !Number.isFinite(Date.parse(capturedAt)))) {
    throw new TypeError("invalid capturedAt");
  }
  return Object.freeze({
    scenarioId: selectedScenario.id,
    source: "demo-sensor-simulator",
    simulatorMode: selectedScenario.simulatorMode,
    capturedAtMode,
    stagedAt,
    ...(capturedAt ? { capturedAt } : {}),
  });
}

export function applyDemoScenario({
  simulator,
  vehicleStateProvider,
  scenario: selectedScenario,
}) {
  if (!selectedScenario || typeof selectedScenario.id !== "string" || !selectedScenario.id.trim()) {
    throw new TypeError("invalid demo scenario");
  }
  if (!validateDemoScenarioPatch(selectedScenario.values)) {
    throw new TypeError("invalid demo scenario values");
  }
  const reading = simulator.readVehicleState(selectedScenario.values, {
    mode: selectedScenario.simulatorMode,
  });
  const ingestion = vehicleStateProvider.ingestDemoSensorState(reading);
  return Object.freeze({ scenarioId: selectedScenario.id, reading, ingestion });
}
