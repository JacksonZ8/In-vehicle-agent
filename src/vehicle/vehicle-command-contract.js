import { requestedEs7ComponentActionState } from "./es7-action-catalog.js";

const REQUESTED_STATE_BY_TOOL = Object.freeze({
  "body.window.setPosition": (args) => ({
    windowPositionPercentByZone: { [args.zone]: args.percent },
  }),
  "cabin.comfort.applySettings": (args) => ({
    ...(Array.isArray(args.windowTargets) && args.windowTargets.length > 0
      ? { windowPositionPercentByZone: Object.fromEntries(args.windowTargets.map(({ zone, percent }) => [zone, percent])) }
      : {}),
    ...(Object.hasOwn(args, "temperature") ? { cabinTemperature: args.temperature } : {}),
    ...(Object.hasOwn(args, "climatePower") ? { climatePower: args.climatePower } : {}),
    ...(Object.hasOwn(args, "climateMode") ? { climateMode: args.climateMode } : {}),
    ...(Object.hasOwn(args, "fanLevel") ? { fanLevel: args.fanLevel } : {}),
  }),
  "body.tailgate.open": (args) => ({ tailgateOpen: args.open !== false }),
  "seat.driver.setBackrestAngle": (args) => ({ driverBackrestAngle: args.angle }),
  "seat.comfort.setLevel": (args) => ({
    seatComfortByZone: {
      [args.seatZone]: {
        mode: args.level === 0 ? "off" : args.seatMode,
        level: args.level,
      },
    },
  }),
  "vehicle.component.setState": (args) => {
    const componentActionStateById = requestedEs7ComponentActionState(args.actionId, args.value);
    return componentActionStateById ? { componentActionStateById } : null;
  },
  "cabin.climate.setPreset": (args) => ({
    ...(Object.hasOwn(args, "temperature") ? { cabinTemperature: args.temperature } : {}),
    ...(Object.hasOwn(args, "climatePower") ? { climatePower: args.climatePower } : {}),
    ...(Object.hasOwn(args, "climateMode") ? { climateMode: args.climateMode } : {}),
    ...(Object.hasOwn(args, "fanLevel") ? { fanLevel: args.fanLevel } : {}),
    ...(Object.hasOwn(args, "airflow") ? { airflow: args.airflow } : {}),
    ...(Object.hasOwn(args, "passengerMode") ? { passengerMode: args.passengerMode } : {}),
  }),
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sameVehicleStructuredFact(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object"
    || Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key) => Object.hasOwn(right, key) && sameVehicleStructuredFact(left[key], right[key]),
    );
}

export function expectedVehicleRequestedState(toolCall) {
  if (!Object.hasOwn(REQUESTED_STATE_BY_TOOL, toolCall?.tool)) return null;
  const factory = REQUESTED_STATE_BY_TOOL[toolCall?.tool];
  if (!isRecord(toolCall?.args)) return null;
  return factory(toolCall.args);
}
