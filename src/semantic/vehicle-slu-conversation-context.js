import {
  createVehicleSluEnvelope,
  VEHICLE_SLU_ONTOLOGY,
  VEHICLE_SLU_SLOT_SCHEMAS,
} from "./vehicle-slu-contract.js";

const MAX_CONTEXT_FRAMES = 4;
const MAX_CONTEXT_STRING_LENGTH = 160;
const CONTEXTUAL_INTENTS = new Set([
  "body.window.setPosition",
  "body.tailgate.open",
  "seat.driver.setBackrestAngle",
  "seat.comfort.setLevel",
  "cabin.comfort.applySettings",
  "cabin.climate.setPreset",
  "vehicle.knowledge.query",
  "vehicle.state.query",
  "navigation.planRoute",
  "energy.findSwapStation",
  "weather.query",
]);

export function projectVehicleSluConversationContext(value) {
  if (!isPlainRecord(value) || !Array.isArray(value.frames)) return null;
  const frames = [];

  for (const frame of value.frames.slice(-MAX_CONTEXT_FRAMES)) {
    if (!isPlainRecord(frame)
      || !CONTEXTUAL_INTENTS.has(frame.intent)
      || !isPlainRecord(frame.slots)) continue;

    const slots = projectVehicleSluSlotValues(frame.intent, frame.slots);
    if (slots) frames.push({ intent: frame.intent, slots });
  }

  return frames.length ? { frames } : null;
}

// Validate and bound slots already supplied by structured model semantics.
// Pending tasks use the ontology; prior context retains its narrower whitelist.
export function projectVehicleSluSlotValues(intent, acceptedSlots) {
  if (typeof intent !== "string" || !isPlainRecord(acceptedSlots)
    || !Object.hasOwn(VEHICLE_SLU_SLOT_SCHEMAS, intent)) return null;
  try {
    const slotSchema = VEHICLE_SLU_SLOT_SCHEMAS[intent];
    const slots = Object.fromEntries(Object.entries(acceptedSlots)
      .filter(([key]) => slotSchema.allowed.includes(key))
      .map(([key, slotValue]) => [key, projectSlotValue(slotValue)]));
    const capability = Object.entries(VEHICLE_SLU_ONTOLOGY).find(([, intents]) => (
      (intents.executable || []).includes(intent)
      || (intents.readonly || []).includes(intent)
    ))?.[0];
    if (!capability) return null;

    const validated = createVehicleSluEnvelope({
      requestId: "vehicle-slu-slot-values",
      domain: "vehicle",
      conversationGoal: { summary: "prior requested meaning", need: "none" },
      domainConfidence: 0,
      vehicleFrames: [{
        frameId: "slot-values",
        capability,
        intent,
        speechAct: "question",
        knowledgeNeed: "none",
        actionNeed: "none",
        slots,
        missingSlots: [],
        clarificationQuestion: null,
        standaloneQuery: null,
        confidence: 0,
      }],
    });
    return validated.vehicleFrames[0].slots;
  } catch {
    return null;
  }
}

function projectSlotValue(value, ancestors = new Set(), depth = 0) {
  if (typeof value === "string") return value.trim().slice(0, MAX_CONTEXT_STRING_LENGTH);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object" || depth >= 4 || ancestors.has(value)) {
    throw new TypeError("conversation context slot value is not bounded plain data");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 8) throw new TypeError("conversation context array is too large");
      return value.map((entry) => projectSlotValue(entry, ancestors, depth + 1));
    }
    if (!isPlainRecord(value)) throw new TypeError("conversation context object is not plain data");
    const entries = Object.entries(value);
    if (entries.length > 16) throw new TypeError("conversation context object is too large");
    return Object.fromEntries(entries.map(([key, entry]) => [
      key.slice(0, MAX_CONTEXT_STRING_LENGTH),
      projectSlotValue(entry, ancestors, depth + 1),
    ]));
  } finally {
    ancestors.delete(value);
  }
}

function isPlainRecord(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
