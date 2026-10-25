import {
  ES7_ACTION_CATALOG,
  normalizeEs7ComponentActionStateById,
} from "./es7-action-catalog.js";

export const DEMO_SENSOR_MODES = Object.freeze(["success", "no-update", "conflict", "timeout"]);
export const DEMO_VEHICLE_STATE_READ_MODES = Object.freeze(["success", "sensor-fault"]);

const FIELDS_BY_COMPONENT = Object.freeze({
  window: Object.freeze(["windowPositionPercentByZone"]),
  "vehicle-lock": Object.freeze(["vehicleLocked"]),
  tailgate: Object.freeze(["tailgateOpen"]),
  seat: Object.freeze(["driverBackrestAngle", "seatComfortByZone"]),
  "vehicle-component": Object.freeze(["componentActionStateById"]),
  climate: Object.freeze(["cabinTemperature", "climatePower", "climateMode", "fanLevel", "airflow", "passengerMode"]),
  cabin: Object.freeze([
    "windowPositionPercentByZone", "cabinTemperature", "climatePower", "climateMode", "fanLevel", "airflow", "passengerMode",
  ]),
});
const WINDOW_ZONES = new Set(["front_left", "front_right", "rear_left", "rear_right"]);
const AIRFLOW_MODES = new Set(["auto", "low", "medium", "high", "rear_soft"]);
const PASSENGER_MODES = new Set(["comfort", "child_comfort"]);
const CLIMATE_MODES = new Set(["auto", "cooling", "heating", "ventilation"]);
const SEAT_ZONES = new Set(["driver", "passenger", "row2_left", "row2_right", "row3_left", "row3_right"]);
const SEAT_COMFORT_MODES = new Set(["off", "heat", "ventilation"]);
const VEHICLE_STATE_FIELDS = new Set([
  "windowPositionPercentByZone",
  "tailgateOpen",
  "driverBackrestAngle",
  "seatComfortByZone",
  "componentActionStateById",
  "cabinTemperature",
  "vehicleLocked",
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
const SENSOR_FAULT_VEHICLE_STATE_FIELDS = new Set([
  "speedKph",
  "gear",
  "rearClearance",
  "windowAntiPinchAvailable",
  "rainDetected",
  "driverBackrestAngle",
  "cabinTemperature",
]);
const NULLABLE_VEHICLE_STATE_FIELDS = new Set([
  ...SENSOR_FAULT_VEHICLE_STATE_FIELDS,
  "vehicleLocked",
  "climatePower",
  "climateMode",
  "fanLevel",
  "airflow",
  "passengerMode",
]);
const GEARS = new Set(["P", "R", "N", "D"]);

function clone(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function timestamp(now) {
  const value = now();
  const capturedAt = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (Date.parse(capturedAt) > Date.now()) throw new RangeError("capturedAt is in the future");
  return capturedAt;
}

function valuesFor(component, requestedState) {
  return Object.fromEntries(FIELDS_BY_COMPONENT[component].filter((field) => Object.hasOwn(requestedState, field))
    .map((field) => [field, clone(requestedState[field])]));
}

function validWindowPositions(value) {
  const entries = isRecord(value) ? Object.entries(value) : [];
  return entries.length > 0
    && entries.every(([zone, percent]) => WINDOW_ZONES.has(zone) && isFiniteNumber(percent) && percent >= 0 && percent <= 100);
}

function validSeatComfort(value) {
  const entries = isRecord(value) ? Object.entries(value) : [];
  return entries.length > 0 && entries.every(([zone, setting]) => SEAT_ZONES.has(zone)
    && isRecord(setting)
    && SEAT_COMFORT_MODES.has(setting.mode)
    && Number.isInteger(setting.level) && setting.level >= 0 && setting.level <= 3
    && ((setting.level === 0 && setting.mode === "off") || (setting.level > 0 && setting.mode !== "off")));
}

function validClimateSettings(value) {
  return (!Object.hasOwn(value, "cabinTemperature") || (isFiniteNumber(value.cabinTemperature) && value.cabinTemperature >= 15 && value.cabinTemperature <= 31))
    && (!Object.hasOwn(value, "climatePower") || typeof value.climatePower === "boolean")
    && (!Object.hasOwn(value, "climateMode") || CLIMATE_MODES.has(value.climateMode))
    && (!Object.hasOwn(value, "fanLevel") || (Number.isInteger(value.fanLevel) && value.fanLevel >= 0 && value.fanLevel <= 8))
    && (!Object.hasOwn(value, "airflow") || AIRFLOW_MODES.has(value.airflow))
    && (!Object.hasOwn(value, "passengerMode") || PASSENGER_MODES.has(value.passengerMode));
}

function validRequestedState(component, requestedState) {
  if (!isPlainObject(requestedState)) return false;
  const fields = FIELDS_BY_COMPONENT[component];
  const keys = Object.keys(requestedState);
  if (keys.length === 0 || keys.some((key) => !fields.includes(key))) return false;

  if (component === "window") return validWindowPositions(requestedState.windowPositionPercentByZone);
  if (component === "vehicle-lock") return typeof requestedState.vehicleLocked === "boolean";
  if (component === "tailgate") return typeof requestedState.tailgateOpen === "boolean";
  if (component === "seat") return (!Object.hasOwn(requestedState, "driverBackrestAngle") || isFiniteNumber(requestedState.driverBackrestAngle))
    && (!Object.hasOwn(requestedState, "seatComfortByZone") || validSeatComfort(requestedState.seatComfortByZone));
  if (component === "vehicle-component") {
    return normalizeEs7ComponentActionStateById(requestedState.componentActionStateById) !== null;
  }
  if (component === "cabin") {
    return (!Object.hasOwn(requestedState, "windowPositionPercentByZone") || validWindowPositions(requestedState.windowPositionPercentByZone))
      && validClimateSettings(requestedState);
  }
  return validClimateSettings(requestedState);
}

function validVehicleStatePatch(patch) {
  if (!isPlainObject(patch) || Object.keys(patch).some((key) => !VEHICLE_STATE_FIELDS.has(key))) return false;
  return Object.entries(patch).every(([key, value]) => {
    if (value === null) return NULLABLE_VEHICLE_STATE_FIELDS.has(key);
    if (key === "windowPositionPercentByZone") return validWindowPositions(value);
    if (key === "tailgateOpen") return typeof value === "boolean";
    if (key === "componentActionStateById") return normalizeEs7ComponentActionStateById(value) !== null;
    if (key === "seatComfortByZone") return validSeatComfort(value);
    if (key === "cabinTemperature") return isFiniteNumber(value) && value >= 15 && value <= 31;
    if (key === "climatePower") return typeof value === "boolean";
    if (key === "climateMode") return CLIMATE_MODES.has(value);
    if (key === "fanLevel") return Number.isInteger(value) && value >= 0 && value <= 8;
    if (key === "airflow") return AIRFLOW_MODES.has(value);
    if (key === "passengerMode") return PASSENGER_MODES.has(value);
    if (key === "batteryPercent") return isFiniteNumber(value) && value >= 0 && value <= 100;
    if (key === "speedKph") return isFiniteNumber(value) && value >= 0;
    if (key === "driverBackrestAngle") return isFiniteNumber(value);
    if (key === "gear") return GEARS.has(value);
    return typeof value === "boolean";
  });
}

export function validateDemoVehicleStatePatch(patch) {
  return validVehicleStatePatch(patch);
}

function validateSubmission({ commandId, component, requestedState, mode, latencyMs }) {
  if (typeof commandId !== "string" || !commandId.trim()) throw new TypeError("invalid commandId");
  if (!Object.hasOwn(FIELDS_BY_COMPONENT, component)) throw new TypeError("invalid component");
  if (!DEMO_SENSOR_MODES.includes(mode)) throw new TypeError("invalid mode");
  if (!isFiniteNumber(latencyMs) || latencyMs < 0) throw new TypeError("invalid latencyMs");
  if (!validRequestedState(component, requestedState)) throw new TypeError("invalid requestedState");
}

function conflictValues(component, requestedState) {
  const values = valuesFor(component, requestedState);

  if (component === "window") {
    values.windowPositionPercentByZone = Object.fromEntries(
      Object.entries(values.windowPositionPercentByZone).map(([zone, percent]) => [zone, percent === 0 ? 100 : 0]),
    );
  }
  if (component === "vehicle-lock") values.vehicleLocked = !values.vehicleLocked;
  if (component === "tailgate") values.tailgateOpen = !values.tailgateOpen;
  if (component === "seat") {
    if (values.seatComfortByZone) {
      values.seatComfortByZone = Object.fromEntries(Object.entries(values.seatComfortByZone).map(([zone, setting]) => [zone, {
        mode: setting.mode === "off" ? "heat" : "off",
        level: setting.mode === "off" ? 1 : 0,
      }]));
    } else {
      values.driverBackrestAngle = values.driverBackrestAngle === 0 ? 1 : 0;
    }
  }
  if (component === "vehicle-component") {
    values.componentActionStateById = Object.fromEntries(
      Object.entries(values.componentActionStateById).map(([actionId, value]) => {
        const definition = ES7_ACTION_CATALOG[actionId];
        const conflict = definition.unit === "binary"
          ? (value === 0 ? 1 : 0)
          : (value === definition.minimum ? definition.maximum : definition.minimum);
        return [actionId, conflict];
      }),
    );
  }
  if (component === "climate") {
    if (Object.hasOwn(values, "cabinTemperature")) values.cabinTemperature = values.cabinTemperature === 0 ? 1 : 0;
    else if (Object.hasOwn(values, "climatePower")) values.climatePower = !values.climatePower;
    else if (Object.hasOwn(values, "fanLevel")) values.fanLevel = values.fanLevel === 0 ? 1 : 0;
    else if (Object.hasOwn(values, "climateMode")) values.climateMode = values.climateMode === "auto" ? "cooling" : "auto";
    else if (Object.hasOwn(values, "airflow")) values.airflow = values.airflow === "auto" ? "low" : "auto";
    else if (Object.hasOwn(values, "passengerMode")) values.passengerMode = values.passengerMode === "comfort" ? "child_comfort" : "comfort";
  }
  if (component === "cabin") {
    if (values.windowPositionPercentByZone) {
      values.windowPositionPercentByZone = Object.fromEntries(Object.entries(values.windowPositionPercentByZone)
        .map(([zone, percent]) => [zone, percent === 0 ? 100 : 0]));
    } else if (Object.hasOwn(values, "climatePower")) values.climatePower = !values.climatePower;
    else if (Object.hasOwn(values, "fanLevel")) values.fanLevel = values.fanLevel === 0 ? 1 : 0;
    else if (Object.hasOwn(values, "cabinTemperature")) values.cabinTemperature = values.cabinTemperature === 31 ? 30 : values.cabinTemperature + 1;
  }
  return values;
}

function noUpdate(commandId, component) {
  return Object.freeze({ type: "no-update", commandId, component });
}

function timeout(commandId, component) {
  return Object.freeze({ type: "timeout", commandId, component });
}

export class DemoSensorSimulator {
  constructor({
    now = () => new Date(),
    scheduler = (callback, latencyMs) => setTimeout(callback, latencyMs),
    defaultLatencyMs = 0,
    initialVehicleState = {},
  } = {}) {
    if (!validVehicleStatePatch(initialVehicleState)) throw new TypeError("invalid initial vehicle state");
    this.now = now;
    this.scheduler = scheduler;
    this.defaultLatencyMs = defaultLatencyMs;
    this.vehicleState = clone(initialVehicleState);
    this.sequence = 0;
  }

  readVehicleState(patch = {}, { mode = "success" } = {}) {
    if (!validVehicleStatePatch(patch)) throw new TypeError("invalid vehicle state patch");
    if (!DEMO_VEHICLE_STATE_READ_MODES.includes(mode)) throw new TypeError("invalid vehicle state read mode");
    if (mode === "sensor-fault"
      && Object.keys(patch).some((key) => !SENSOR_FAULT_VEHICLE_STATE_FIELDS.has(key))) {
      throw new TypeError("invalid sensor-fault vehicle state patch");
    }
    const values = mode === "sensor-fault"
      ? Object.fromEntries(Object.keys(patch).map((key) => [key, null]))
      : clone(patch);
    this.vehicleState = mergeVehicleState(this.vehicleState, values);
    return deepFreeze({
      source: "demo-sensor-simulator",
      simulated: true,
      capturedAt: timestamp(this.now),
      values: clone(this.vehicleState),
    });
  }

  submit({ commandId, component, requestedState, mode = "success", latencyMs } = {}) {
    const delay = latencyMs ?? this.defaultLatencyMs;
    try {
      validateSubmission({ commandId, component, requestedState, mode, latencyMs: delay });
    } catch (error) {
      return Promise.reject(error);
    }

    const sequence = ++this.sequence;
    const request = clone(requestedState);

    if (mode === "no-update") return Promise.resolve(noUpdate(commandId, component));

    return new Promise((resolve, reject) => {
      this.scheduler(() => {
        try {
          if (mode === "timeout") {
            resolve(timeout(commandId, component));
            return;
          }

          const capturedAt = timestamp(this.now);
          const values = mode === "conflict"
            ? conflictValues(component, request)
            : valuesFor(component, request);
          this.vehicleState = mergeVehicleState(this.vehicleState, values);
          resolve(deepFreeze({
            observationId: `demo-observation:${commandId}:${component}:${sequence}:${capturedAt}`,
            commandId,
            component,
            source: "demo-sensor-simulator",
            simulated: true,
            capturedAt,
            values,
          }));
        } catch (error) {
          reject(error);
        }
      }, delay);
    });
  }
}

function mergeVehicleState(current, patch) {
  const merged = { ...current, ...clone(patch) };
  if (Object.hasOwn(patch, "windowPositionPercentByZone")
    && patch.windowPositionPercentByZone !== null) {
    merged.windowPositionPercentByZone = {
      ...(current.windowPositionPercentByZone || {}),
      ...clone(patch.windowPositionPercentByZone),
    };
  }
  if (Object.hasOwn(patch, "componentActionStateById")) {
    merged.componentActionStateById = patch.componentActionStateById === null
      ? null
      : {
        ...(current.componentActionStateById || {}),
        ...clone(patch.componentActionStateById),
      };
  }
  return merged;
}
