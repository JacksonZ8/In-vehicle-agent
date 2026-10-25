import { isTerminalExecutionState } from "../vehicle/execution-state-contract.js";
import { normalizeEs7ComponentActionStateById } from "../vehicle/es7-action-catalog.js";
import { VEHICLE_COMPONENT_BY_TOOL as COMPONENT_BY_TOOL } from "../vehicle/vehicle-write-capabilities.js";

export const VEHICLE_STATE_KEYS = Object.freeze([
  "windowPositionPercentByZone",
  "vehicleLocked",
  "tailgateOpen",
  "driverBackrestAngle",
  "seatComfortByZone",
  "componentActionStateById",
  "cabinTemperature",
  "climatePower",
  "climateMode",
  "fanLevel",
  "airflow",
  "passengerMode",
  "batteryPercent",
  "speedKph",
  "gear",
  "rearClearance",
  "windowAntiPinchAvailable",
  "rainDetected",
]);

const WINDOW_ZONES = new Set(["front_left", "front_right", "rear_left", "rear_right"]);
const GEARS = new Set(["P", "R", "N", "D"]);
const AIRFLOW_MODES = new Set(["auto", "low", "medium", "high", "rear_soft"]);
const PASSENGER_MODES = new Set(["comfort", "child_comfort"]);
const CLIMATE_MODES = new Set(["auto", "cooling", "heating", "ventilation"]);
const SEAT_ZONES = new Set(["driver", "passenger", "row2_left", "row2_right", "row3_left", "row3_right"]);
const SEAT_COMFORT_MODES = new Set(["off", "heat", "ventilation"]);
const STATE_FIELDS_BY_COMPONENT = Object.freeze({
  window: Object.freeze(["windowPositionPercentByZone"]),
  tailgate: Object.freeze(["tailgateOpen"]),
  seat: Object.freeze(["driverBackrestAngle", "seatComfortByZone"]),
  "vehicle-component": Object.freeze(["componentActionStateById"]),
  climate: Object.freeze(["cabinTemperature", "climatePower", "climateMode", "fanLevel", "airflow", "passengerMode"]),
  cabin: Object.freeze([
    "windowPositionPercentByZone", "cabinTemperature", "climatePower", "climateMode", "fanLevel", "airflow", "passengerMode",
  ]),
});
const OBSERVATION_KEYS = new Set([
  "observationId",
  "commandId",
  "component",
  "source",
  "simulated",
  "capturedAt",
  "values",
]);
const DEMO_SENSOR_STATE_KEYS = new Set(VEHICLE_STATE_KEYS);
const DEMO_SENSOR_READING_KEYS = new Set([
  "source",
  "simulated",
  "capturedAt",
  "values",
]);

let snapshotSequence = 0;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeNumber(value, { percent = false } = {}) {
  if (!isFiniteNumber(value)) return null;
  if (percent && (value < 0 || value > 100)) return null;
  return value;
}

function normalizeBoolean(value) {
  return value === null || typeof value === "boolean" ? value : null;
}

function normalizeEnum(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function normalizeWindowPositions(value) {
  if (value === null || !isRecord(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([zone, percent]) => WINDOW_ZONES.has(zone) && normalizeNumber(percent, { percent: true }) !== null)) {
    return null;
  }
  return Object.freeze(Object.fromEntries(entries));
}

function normalizeSeatComfort(value) {
  if (value === null || !isRecord(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([zone, setting]) => SEAT_ZONES.has(zone)
    && isRecord(setting)
    && SEAT_COMFORT_MODES.has(setting.mode)
    && Number.isInteger(setting.level)
    && setting.level >= 0 && setting.level <= 3
    && ((setting.level === 0 && setting.mode === "off") || (setting.level > 0 && setting.mode !== "off")))) {
    return null;
  }
  return Object.freeze(Object.fromEntries(entries.map(([zone, setting]) => [zone, Object.freeze({ ...setting })])));
}

function mergeVehicleStateValues(previousValues, patch) {
  const merged = { ...previousValues, ...patch };
  if (Object.hasOwn(patch, "windowPositionPercentByZone")
    && patch.windowPositionPercentByZone !== null) {
    merged.windowPositionPercentByZone = {
      ...(previousValues.windowPositionPercentByZone || {}),
      ...patch.windowPositionPercentByZone,
    };
  }
  if (Object.hasOwn(patch, "componentActionStateById")) {
    merged.componentActionStateById = patch.componentActionStateById === null
      ? null
      : {
        ...(previousValues.componentActionStateById || {}),
        ...patch.componentActionStateById,
      };
  }
  return merged;
}

function isObservationValueValid(key, rawValue, normalizedValue) {
  if (rawValue === null) return normalizedValue === null;
  return normalizedValue !== null;
}

function snapshotId(input) {
  return typeof input.id === "string" && input.id.trim()
    ? input.id.trim()
    : `vehicle-state-${Date.now().toString(36)}-${++snapshotSequence}`;
}

function normalizeFreshnessMs(value) {
  return isFiniteNumber(value) ? Math.max(0, value) : null;
}

function normalizeCapturedAt(value) {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return null;
  return value.trim();
}

function normalizeCapturedAtByField(values, capturedAt, suppliedTimestamps) {
  const supplied = isRecord(suppliedTimestamps) ? suppliedTimestamps : {};
  return Object.freeze(Object.fromEntries(VEHICLE_STATE_KEYS.map((key) => {
    if (Object.hasOwn(supplied, key)) return [key, normalizeCapturedAt(supplied[key])];
    return [key, values[key] === null ? null : capturedAt];
  })));
}

function updateCapturedAtByField(previousSnapshot, values, capturedAt) {
  return Object.fromEntries(VEHICLE_STATE_KEYS.map((key) => [
    key,
    Object.hasOwn(values, key) ? capturedAt : previousSnapshot.capturedAtByField[key],
  ]));
}

function submittedAt(execution) {
  const entry = Array.isArray(execution?.executionTrace)
    ? execution.executionTrace.find((item) => item?.state === "submitted")
    : null;
  const timestamp = typeof entry?.at === "string" ? Date.parse(entry.at) : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function normalizeVehicleStateValues(values = {}) {
  const normalized = Object.fromEntries(VEHICLE_STATE_KEYS.map((key) => [key, null]));
  if (!isRecord(values)) return Object.freeze(normalized);

  normalized.windowPositionPercentByZone = normalizeWindowPositions(values.windowPositionPercentByZone);
  normalized.vehicleLocked = normalizeBoolean(values.vehicleLocked);
  normalized.tailgateOpen = normalizeBoolean(values.tailgateOpen);
  normalized.driverBackrestAngle = normalizeNumber(values.driverBackrestAngle);
  normalized.seatComfortByZone = normalizeSeatComfort(values.seatComfortByZone);
  normalized.componentActionStateById = values.componentActionStateById === null
    ? null
    : normalizeEs7ComponentActionStateById(values.componentActionStateById);
  normalized.cabinTemperature = normalizeNumber(values.cabinTemperature);
  normalized.climatePower = normalizeBoolean(values.climatePower);
  normalized.climateMode = normalizeEnum(values.climateMode, CLIMATE_MODES);
  normalized.fanLevel = normalizeNumber(values.fanLevel);
  normalized.airflow = normalizeEnum(values.airflow, AIRFLOW_MODES);
  normalized.passengerMode = normalizeEnum(values.passengerMode, PASSENGER_MODES);
  normalized.batteryPercent = normalizeNumber(values.batteryPercent, { percent: true });
  normalized.speedKph = normalizeNumber(values.speedKph);
  normalized.gear = normalizeEnum(values.gear, GEARS);
  normalized.rearClearance = normalizeBoolean(values.rearClearance);
  normalized.windowAntiPinchAvailable = normalizeBoolean(values.windowAntiPinchAvailable);
  normalized.rainDetected = normalizeBoolean(values.rainDetected);
  return Object.freeze(normalized);
}

export function createVehicleStateSnapshot(input = {}) {
  const capturedAt = normalizeCapturedAt(input.capturedAt);
  const values = normalizeVehicleStateValues(input.values);
  return Object.freeze({
    id: snapshotId(input),
    source: typeof input.source === "string" && input.source.trim() ? input.source.trim() : "unknown",
    simulated: input.simulated === true,
    capturedAt,
    freshnessMs: normalizeFreshnessMs(input.freshnessMs),
    values,
    capturedAtByField: normalizeCapturedAtByField(values, capturedAt, input.capturedAtByField),
  });
}

export function projectVehicleContext(snapshot) {
  return { ...createVehicleStateSnapshot(snapshot).values };
}

export class DevVehicleStateProvider {
  constructor(fixture = {}) {
    this.snapshot = createVehicleStateSnapshot({
      source: "dev-fixture",
      simulated: true,
      capturedAt: new Date().toISOString(),
      freshnessMs: 0,
      values: fixture,
    });
    this.ingestedObservationIds = new Set();
  }

  getSnapshot() {
    return this.snapshot;
  }

  ingestDemoSensorState(reading) {
    const invalid = this.validateDemoSensorState(reading);
    if (invalid) return { ok: false, reason: invalid };

    this.snapshot = createVehicleStateSnapshot({
      source: reading.source,
      simulated: reading.simulated,
      capturedAt: reading.capturedAt,
      freshnessMs: 0,
      values: mergeVehicleStateValues(this.snapshot.values, reading.values),
      capturedAtByField: updateCapturedAtByField(this.snapshot, reading.values, reading.capturedAt),
    });
    return { ok: true, snapshot: this.snapshot };
  }

  ingestObservation(observation, { execution } = {}) {
    const invalid = this.validateObservation(observation, execution);
    if (invalid) return { ok: false, reason: invalid };

    this.ingestedObservationIds.add(observation.observationId);
    this.snapshot = createVehicleStateSnapshot({
      source: observation.source,
      simulated: observation.simulated,
      capturedAt: observation.capturedAt,
      freshnessMs: 0,
      values: mergeVehicleStateValues(this.snapshot.values, observation.values),
      capturedAtByField: updateCapturedAtByField(this.snapshot, observation.values, observation.capturedAt),
    });
    return { ok: true, snapshot: this.snapshot };
  }

  validateObservation(observation, execution) {
    if (!isRecord(observation) || Object.keys(observation).some((key) => !OBSERVATION_KEYS.has(key))) {
      return "invalid observation";
    }
    if (typeof observation.observationId !== "string" || !observation.observationId.trim()) return "invalid observationId";
    if (this.ingestedObservationIds.has(observation.observationId)) return "duplicate observationId";
    if (typeof observation.commandId !== "string" || !observation.commandId.trim()) return "invalid commandId";
    if (!isRecord(execution) || observation.commandId !== execution.commandId) return "commandId mismatch";
    if (isTerminalExecutionState(execution.executionState)) return "execution is terminal";

    const expectedComponent = COMPONENT_BY_TOOL[execution.tool];
    if (!expectedComponent || observation.component !== expectedComponent) return "component mismatch";
    if (observation.source !== "demo-sensor-simulator" || observation.simulated !== true) return "invalid observation source";

    const capturedMs = typeof observation.capturedAt === "string" ? Date.parse(observation.capturedAt) : NaN;
    if (!Number.isFinite(capturedMs) || capturedMs > Date.now()) return "invalid capturedAt";
    const executionSubmittedAt = submittedAt(execution);
    if (executionSubmittedAt === null) return "invalid execution submission timestamp";
    if (capturedMs < executionSubmittedAt) return "capturedAt predates submission";

    const allowedFields = STATE_FIELDS_BY_COMPONENT[observation.component];
    if (!isRecord(observation.values) || Object.keys(observation.values).length === 0
      || Object.keys(observation.values).some((key) => !allowedFields.includes(key))) {
      return "observation contains unauthorized values";
    }
    const normalizedValues = normalizeVehicleStateValues(observation.values);
    if (Object.keys(observation.values).some((key) => !isObservationValueValid(key, observation.values[key], normalizedValues[key]))) {
      return "observation contains invalid values";
    }
    return null;
  }

  validateDemoSensorState(reading) {
    if (!isRecord(reading) || Object.keys(reading).some((key) => !DEMO_SENSOR_READING_KEYS.has(key))) {
      return "invalid demo sensor state";
    }
    if (reading.source !== "demo-sensor-simulator" || reading.simulated !== true) return "invalid demo sensor source";
    const capturedMs = typeof reading.capturedAt === "string" ? Date.parse(reading.capturedAt) : NaN;
    if (!Number.isFinite(capturedMs) || capturedMs > Date.now()) return "invalid demo sensor capturedAt";
    if (!isRecord(reading.values) || Object.keys(reading.values).length === 0
      || Object.keys(reading.values).some((key) => !DEMO_SENSOR_STATE_KEYS.has(key))) {
      return "invalid demo sensor values";
    }
    const normalizedValues = normalizeVehicleStateValues(reading.values);
    if (Object.keys(reading.values).some((key) => !isObservationValueValid(key, reading.values[key], normalizedValues[key]))) {
      return "invalid demo sensor values";
    }
    return null;
  }
}
