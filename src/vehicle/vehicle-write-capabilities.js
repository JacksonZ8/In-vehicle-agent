// Single source for vehicle write intents and their orchestrated capability bindings.
// Vehicle-SLU frames, Orchestrator plans, server plan checks and the complex-task owner all
// project through this table so a new write intent is registered in exactly one place.

const CABIN_SETTING_SLOTS = Object.freeze([
  "windowTargets", "temperature", "temperatureDelta", "climatePower", "climateMode", "fanLevel",
]);
const CLIMATE_SLOTS = Object.freeze([
  "temperature", "temperatureDelta", "climatePower", "climateMode", "fanLevel", "airflow", "passengerMode",
]);

function pickPresent(source, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
}

function pickAll(source, keys) {
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

const DEFINITIONS = {
  "body.window.setPosition": {
    capabilityId: "vehicle.window.set-position",
    component: "window",
    stepSuffix: "window",
    pickSlots: (slots) => pickAll(slots, ["zone", "percent"]),
    isComplete: (slots) => typeof slots.zone === "string" && Number.isFinite(slots.percent),
    toInput: (slots) => ({ zone: slots.zone, percent: slots.percent }),
    toSlots: (input) => ({ zone: input.zone, percent: input.percent }),
  },
  "seat.driver.setBackrestAngle": {
    capabilityId: "vehicle.seat.set-backrest",
    component: "seat",
    stepSuffix: "seat",
    pickSlots: (slots) => pickAll(slots, ["seat", "angle"]),
    isComplete: (slots) => slots.seat === "driver" && Number.isFinite(slots.angle),
    toInput: (slots) => ({ zone: slots.seat, angle: slots.angle }),
    toSlots: (input) => {
      if (input.zone !== "driver") throw new TypeError("vehicle.seat.set-backrest supports only the driver zone");
      return { seat: input.zone, angle: input.angle };
    },
  },
  "seat.comfort.setLevel": {
    capabilityId: "vehicle.seat.set-comfort",
    component: "seat",
    stepSuffix: "seat-comfort",
    pickSlots: (slots) => pickAll(slots, ["seatZone", "seatMode", "level"]),
    isComplete: (slots) => typeof slots.seatZone === "string"
      && typeof slots.seatMode === "string"
      && Number.isInteger(slots.level),
    toInput: (slots) => ({ seatZone: slots.seatZone, seatMode: slots.seatMode, level: slots.level }),
    toSlots: (input) => ({ seatZone: input.seatZone, seatMode: input.seatMode, level: input.level }),
  },
  "cabin.comfort.applySettings": {
    capabilityId: "vehicle.cabin.apply-settings",
    component: "cabin",
    stepSuffix: "cabin",
    pickSlots: (slots) => pickPresent(slots, CABIN_SETTING_SLOTS),
    isComplete: (slots) => Object.keys(pickPresent(slots, CABIN_SETTING_SLOTS)).length > 0,
    toInput: (slots) => pickPresent(slots, CABIN_SETTING_SLOTS),
    toSlots: (input) => pickPresent(input, CABIN_SETTING_SLOTS),
  },
  "cabin.climate.setPreset": {
    capabilityId: "vehicle.climate.set",
    component: "climate",
    stepSuffix: "climate",
    pickSlots: (slots) => pickPresent(slots, CLIMATE_SLOTS),
    isComplete: (slots) => Object.keys(pickPresent(slots, CLIMATE_SLOTS)).length > 0,
    toInput: (slots) => pickPresent(slots, CLIMATE_SLOTS),
    toSlots: (input) => pickPresent(input, CLIMATE_SLOTS),
  },
  "body.tailgate.open": {
    capabilityId: "vehicle.tailgate.set",
    component: "tailgate",
    stepSuffix: "tailgate",
    pickSlots: (slots) => ({ open: slots.open }),
    isComplete: (slots) => typeof slots.open === "boolean",
    toInput: (slots) => ({ state: slots.open ? "open" : "closed" }),
    toSlots: (input) => {
      if (!["open", "closed"].includes(input.state)) {
        throw new TypeError("vehicle.tailgate.set state must be open or closed");
      }
      return { open: input.state === "open" };
    },
  },
  "vehicle.component.setState": {
    capabilityId: "vehicle.component.set-state",
    component: "vehicle-component",
    stepSuffix: "component",
    pickSlots: (slots) => pickAll(slots, ["actionId", "value"]),
    isComplete: (slots) => typeof slots.actionId === "string" && Number.isFinite(slots.value),
    toInput: (slots) => ({ actionId: slots.actionId, value: slots.value }),
    toSlots: (input) => ({ actionId: input.actionId, value: input.value }),
  },
};

export const VEHICLE_WRITE_CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([intent, definition]) => [intent, Object.freeze({ intent, ...definition })]),
));

const BY_CAPABILITY_ID = new Map(Object.values(VEHICLE_WRITE_CAPABILITIES)
  .map((definition) => [definition.capabilityId, definition]));

export const VEHICLE_WRITE_CAPABILITY_IDS = Object.freeze([...BY_CAPABILITY_ID.keys()]);

// Execution component owning each vehicle write tool (the tool name is the write intent).
export const VEHICLE_COMPONENT_BY_TOOL = Object.freeze(Object.fromEntries(
  Object.values(VEHICLE_WRITE_CAPABILITIES).map(({ intent, component }) => [intent, component]),
));

export function getVehicleWriteCapabilityForIntent(intent) {
  return Object.hasOwn(VEHICLE_WRITE_CAPABILITIES, intent) ? VEHICLE_WRITE_CAPABILITIES[intent] : null;
}

export function getVehicleWriteCapabilityById(capabilityId) {
  return BY_CAPABILITY_ID.get(capabilityId) ?? null;
}

// Projects a complete write frame (or normalized command) to its orchestrated capability step.
export function projectVehicleWriteBinding({ intent, slots } = {}) {
  const definition = getVehicleWriteCapabilityForIntent(intent);
  const values = slots && typeof slots === "object" && !Array.isArray(slots) ? slots : {};
  if (!definition || !definition.isComplete(values)) return null;
  return {
    capabilityId: definition.capabilityId,
    input: definition.toInput(values),
    safetyAction: intent,
    stepSuffix: definition.stepSuffix,
  };
}
