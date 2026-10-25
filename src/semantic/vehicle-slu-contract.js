import { VEHICLE_STATE_KEYS } from "../safety/vehicle-state.js";

export const VEHICLE_SLU_CONTRACT_VERSION = "nio-vehicle-slu-contract@2.0.0";
export const VEHICLE_SLU_CONTRACT = Object.freeze({
  id: "nio-vehicle-slu-contract",
  version: "2.0.0",
  ref: VEHICLE_SLU_CONTRACT_VERSION,
});
// @2.0.0 保持既有必填字段；dialogueAction 是可选增量，由模型明确取消 pending。
export const VEHICLE_SLU_PROMPT_VERSION = "nio-vehicle-slu-prompt@2.3.0";
export const VEHICLE_SLU_DOMAINS = Object.freeze(["vehicle", "non_vehicle", "unknown"]);
// 时间范围收口为枚举：与运行时/verify 既有约定（today/tomorrow）对齐，
// 消除「明天下午」vs「tomorrow:afternoon」这类双侧值域不一致导致的判错。
export const VEHICLE_SLU_TIMERANGE_VALUES = Object.freeze([
  "today", "tomorrow", "tomorrow_afternoon", "tonight", "this_weekend", "this_week", "next_week",
]);
export const CONVERSATION_NEEDS = Object.freeze(["none", "social", "explain"]);
export const SPEECH_ACTS = Object.freeze(["question", "command", "report", "complaint", "social"]);
export const KNOWLEDGE_NEEDS = Object.freeze(["none", "manual"]);
export const ACTION_NEEDS = Object.freeze(["none", "clarify", "execute"]);
export const VEHICLE_SLU_CAPABILITIES = Object.freeze([
  "control", "knowledge", "navigation", "weather", "media", "phone",
]);
export const VEHICLE_SLU_ONTOLOGY = deepFreeze({
  control: {
    executable: [
      "body.window.setPosition", "body.tailgate.open",
      "seat.driver.setBackrestAngle", "seat.comfort.setLevel", "cabin.comfort.applySettings",
      "vehicle.component.setState", "cabin.climate.setPreset",
    ],
    readonly: ["safety.reject"],
  },
  knowledge: { readonly: ["vehicle.knowledge.query", "vehicle.state.query"] },
  navigation: { readonly: [], executable: ["navigation.planRoute", "energy.findSwapStation", "navigation.cancel"] },
  weather: { readonly: ["weather.query"] },
  media: { executable: ["media.play"] },
  phone: { executable: ["phone.call"] },
});
export const VEHICLE_SLU_SLOT_SCHEMAS = deepFreeze({
  "body.window.setPosition": { allowed: ["zone", "percent"], required: ["zone", "percent"] },
  "body.tailgate.open": { allowed: ["open"], required: ["open"] },
  "seat.driver.setBackrestAngle": { allowed: ["seat", "angle"], required: ["seat", "angle"] },
  "seat.comfort.setLevel": { allowed: ["seatZone", "seatMode", "level"], required: ["seatZone", "seatMode", "level"] },
  "vehicle.component.setState": { allowed: ["actionId", "value"], required: ["actionId", "value"] },
  "cabin.climate.setPreset": {
    allowed: ["temperature", "temperatureDelta", "climatePower", "climateMode", "fanLevel", "airflow", "passengerMode"],
    required: [],
    // "control" is only a missing-slot marker: the request names no controllable climate target.
    missingSlotMarkers: ["control"],
  },
  "cabin.comfort.applySettings": {
    allowed: ["windowTargets", "temperature", "temperatureDelta", "climatePower", "climateMode", "fanLevel"],
    required: [],
    missingSlotMarkers: ["control"],
  },
  "vehicle.knowledge.query": { allowed: ["query", "vehicleModel", "eligibilityAction"] },
  "vehicle.state.query": { allowed: ["stateFields"] },
  "weather.query": { allowed: ["location", "timeRange"] },
  "navigation.planRoute": { allowed: ["origin", "destination"] },
  "energy.findSwapStation": { allowed: ["destination"] },
  // navigation.cancel 是「撤回类」意图：取消已发起的导航。destination 可选，
  // 仅当原话明说被取消的路线时才填（如「取消去机场的导航」）。
  "navigation.cancel": { allowed: ["destination"] },
  "media.play": { allowed: ["query"] },
  "phone.call": { allowed: ["contact"] },
  "safety.reject": { allowed: [] },
});

export function getMissingVehicleSluRequiredSlots(intent, slots = {}) {
  if (intent === "cabin.climate.setPreset" || intent === "cabin.comfort.applySettings") {
    const candidates = intent === "cabin.climate.setPreset"
      ? ["temperature", "temperatureDelta", "climatePower", "climateMode", "fanLevel", "airflow", "passengerMode"]
      : ["windowTargets", "temperature", "temperatureDelta", "climatePower", "climateMode", "fanLevel"];
    return candidates.some((slot) => slots?.[slot] !== undefined && slots[slot] !== null && slots[slot] !== ""
      && (!Array.isArray(slots[slot]) || slots[slot].length > 0))
      ? []
      : ["control"];
  }
  const required = VEHICLE_SLU_SLOT_SCHEMAS[intent]?.required ?? [];
  return required.filter((slot) => {
    const value = slots?.[slot];
    return value === undefined || value === null || value === "";
  });
}

const VEHICLE_SLU_INTENTS = Object.freeze(Object.values(VEHICLE_SLU_ONTOLOGY)
  .flatMap(({ executable = [], readonly = [] }) => [...executable, ...readonly]));
const VEHICLE_SLU_SLOT_PROPERTIES = deepFreeze({
  zone: { type: "string", enum: ["front_left", "front_right", "rear_left", "rear_right"] },
  percent: { type: "number", minimum: 0, maximum: 100 },
  open: { type: "boolean" },
  seat: { type: "string", enum: ["driver"] },
  seatZone: { type: "string", enum: ["driver", "passenger", "row2_left", "row2_right", "row3_left", "row3_right"] },
  seatMode: { type: "string", enum: ["heat", "ventilation"] },
  angle: { type: "number" },
  level: { type: "number", minimum: 0, maximum: 3 },
  actionId: { type: "string" },
  value: { type: "number" },
  temperature: { type: "number", minimum: 15, maximum: 31 },
  temperatureDelta: { type: "number", integer: true, minimum: -16, maximum: 16 },
  climatePower: { type: "boolean" },
  climateMode: { type: "string", enum: ["auto", "cooling", "heating", "ventilation"] },
  fanLevel: { type: "number", minimum: 0, maximum: 8 },
  airflow: { type: "string", enum: ["auto", "low", "medium", "high", "rear_soft"] },
  passengerMode: { type: "string", enum: ["comfort", "child_comfort"] },
  windowTargets: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["zone", "percent"],
      properties: {
        zone: { type: "string", enum: ["front_left", "front_right", "rear_left", "rear_right"] },
        percent: { type: "number", minimum: 0, maximum: 100 },
      },
    },
  },
  query: { type: "string" },
  vehicleModel: { type: "string" },
  eligibilityAction: { type: "string", enum: ["body.tailgate.open"] },
  stateFields: { type: "array", uniqueItems: true, items: { type: "string", enum: [...VEHICLE_STATE_KEYS] } },
  location: { type: "string" },
  timeRange: { type: "string", enum: [...VEHICLE_SLU_TIMERANGE_VALUES] },
  origin: { type: "string" },
  destination: { type: "string" },
  contact: { type: "string" },
});

export const VEHICLE_SLU_OUTPUT_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["contractVersion", "requestId", "domain", "conversationGoal", "vehicleFrames", "domainConfidence"],
  properties: {
    contractVersion: { type: "string", const: VEHICLE_SLU_CONTRACT_VERSION },
    requestId: { type: "string", minLength: 1 },
    domain: { type: "string", enum: [...VEHICLE_SLU_DOMAINS] },
    conversationGoal: {
      type: "object", additionalProperties: false, required: ["summary", "need"],
      properties: { summary: { type: "string" }, need: { type: "string", enum: [...CONVERSATION_NEEDS] }, dialogueAction: { type: "string", enum: ["cancel_pending"] } },
    },
    vehicleFrames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "frameId", "capability", "intent", "speechAct", "knowledgeNeed", "actionNeed", "slots",
          "missingSlots", "clarificationQuestion", "standaloneQuery", "confidence",
        ],
        properties: {
          frameId: { type: "string", minLength: 1 },
          capability: { type: "string", enum: [...VEHICLE_SLU_CAPABILITIES] },
          intent: { type: "string", enum: [...VEHICLE_SLU_INTENTS] },
          speechAct: { type: "string", enum: [...SPEECH_ACTS] },
          knowledgeNeed: { type: "string", enum: [...KNOWLEDGE_NEEDS] },
          actionNeed: { type: "string", enum: [...ACTION_NEEDS] },
          slots: { type: "object", additionalProperties: false, properties: VEHICLE_SLU_SLOT_PROPERTIES },
          missingSlots: { type: "array", uniqueItems: true, items: { type: "string" } },
          clarificationQuestion: { type: ["string", "null"], minLength: 1 },
          standaloneQuery: { type: ["string", "null"], minLength: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    domainConfidence: { type: "number", minimum: 0, maximum: 1 },
  },
});

const ENVELOPE_KEYS = new Set(["contractVersion", "requestId", "domain", "conversationGoal", "vehicleFrames", "domainConfidence"]);
const CONVERSATION_GOAL_KEYS = new Set(["summary", "need", "dialogueAction"]);
const FRAME_KEYS = new Set([
  "frameId", "capability", "intent", "speechAct", "knowledgeNeed", "actionNeed", "slots",
  "missingSlots", "clarificationQuestion", "standaloneQuery", "confidence",
]);

export function validateVehicleSluEnvelope(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["envelope must be plain data"] };
  if (!validatePlainData(value, "envelope", errors)) return { ok: false, errors };
  validateKeys(value, ENVELOPE_KEYS, "envelope", errors);
  if (value.contractVersion !== VEHICLE_SLU_CONTRACT_VERSION) errors.push("invalid contractVersion");
  if (typeof value.requestId !== "string" || !value.requestId) errors.push("invalid requestId");
  if (!VEHICLE_SLU_DOMAINS.includes(value.domain)) errors.push("invalid domain");
  validateConversationGoal(value.conversationGoal, errors);
  if (!Array.isArray(value.vehicleFrames)) errors.push("vehicleFrames must be an array");
  if (!isConfidence(value.domainConfidence)) errors.push("invalid domainConfidence");

  if (Array.isArray(value.vehicleFrames)) {
    const frameIds = new Set();
    value.vehicleFrames.forEach((frame, index) => {
      validateFrame(frame, index, errors);
      if (isPlainObject(frame) && typeof frame.frameId === "string") {
        if (frameIds.has(frame.frameId)) errors.push(`duplicate frameId: ${frame.frameId}`);
        frameIds.add(frame.frameId);
      }
    });
    if (value.domain !== "vehicle" && value.vehicleFrames.length !== 0) {
      errors.push(`${value.domain} domain must not have vehicleFrames`);
    }
  }
  if (value.conversationGoal?.dialogueAction === "cancel_pending"
    && (value.domain !== "vehicle" || value.conversationGoal.need !== "explain"
      || !Array.isArray(value.vehicleFrames) || value.vehicleFrames.length !== 0)) {
    errors.push("cancel_pending requires vehicle/explain with no action frames");
  }
  return { ok: errors.length === 0, errors };
}

export function createVehicleSluEnvelope(value) {
  const withVersion = Object.hasOwn(value ?? {}, "contractVersion")
    ? value
    : { ...value, contractVersion: VEHICLE_SLU_CONTRACT_VERSION };
  const validation = validateVehicleSluEnvelope(withVersion);
  if (!validation.ok) throw new TypeError(`invalid Vehicle-SLU envelope: ${validation.errors.join("; ")}`);
  return deepFreeze(structuredClone(withVersion));
}

export function projectVehicleSluSummary(envelope) {
  const validation = validateVehicleSluEnvelope(envelope);
  if (!validation.ok) throw new TypeError(`invalid Vehicle-SLU envelope: ${validation.errors.join("; ")}`);
  return deepFreeze({
    contractVersion: envelope.contractVersion,
    requestId: envelope.requestId,
    domain: envelope.domain,
    conversationGoal: structuredClone(envelope.conversationGoal),
    domainConfidence: envelope.domainConfidence,
    vehicleFrames: envelope.vehicleFrames.map((frame) => ({
      frameId: frame.frameId,
      capability: frame.capability,
      intent: frame.intent,
      speechAct: frame.speechAct,
      knowledgeNeed: frame.knowledgeNeed,
      actionNeed: frame.actionNeed,
      missingSlots: structuredClone(frame.missingSlots),
      clarificationQuestion: frame.clarificationQuestion,
      standaloneQuery: frame.standaloneQuery,
      confidence: frame.confidence,
      slotNames: Object.keys(frame.slots),
    })),
  });
}

function validateConversationGoal(value, errors) {
  if (!isPlainObject(value)) return errors.push("conversationGoal must be plain data");
  validateKeys(value, CONVERSATION_GOAL_KEYS, "conversationGoal", errors);
  if (typeof value.summary !== "string") errors.push("invalid conversationGoal.summary");
  if (!CONVERSATION_NEEDS.includes(value.need)) errors.push("invalid conversationGoal.need");
  if (Object.hasOwn(value, "dialogueAction") && value.dialogueAction !== "cancel_pending") {
    errors.push("invalid conversationGoal.dialogueAction");
  }
}

function validateFrame(frame, index, errors) {
  const path = `vehicleFrames[${index}]`;
  if (!isPlainObject(frame)) return errors.push(`${path} must be plain data`);
  validateKeys(frame, FRAME_KEYS, path, errors);
  if (typeof frame.frameId !== "string" || !frame.frameId) errors.push(`invalid ${path}.frameId`);
  if (!VEHICLE_SLU_CAPABILITIES.includes(frame.capability)) errors.push(`invalid ${path}.capability`);
  const type = intentType(frame.capability, frame.intent);
  if (!type) errors.push(`invalid ${path}.intent`);
  if (!SPEECH_ACTS.includes(frame.speechAct)) errors.push(`invalid ${path}.speechAct`);
  if (!KNOWLEDGE_NEEDS.includes(frame.knowledgeNeed)) errors.push(`invalid ${path}.knowledgeNeed`);
  if (!ACTION_NEEDS.includes(frame.actionNeed)) errors.push(`invalid ${path}.actionNeed`);
  if (frame.knowledgeNeed === "manual" && frame.intent !== "vehicle.knowledge.query") errors.push(`invalid ${path}.knowledgeNeed`);
  if (frame.actionNeed !== "none" && type !== "executable") errors.push(`readonly ${path}.intent cannot request action`);
  if (frame.actionNeed === "execute" && frame.speechAct !== "command") errors.push(`execute ${path}.speechAct must be command`);
  validateSlots(frame, path, errors);
  validateMissingSlots(frame, path, errors);
  if (frame.actionNeed === "clarify") {
    if (typeof frame.clarificationQuestion !== "string" || !frame.clarificationQuestion.trim()) {
      errors.push(`invalid ${path}.clarificationQuestion`);
    }
  } else if (frame.clarificationQuestion !== null) {
    errors.push(`invalid ${path}.clarificationQuestion`);
  }
  if (frame.knowledgeNeed === "manual") {
    if (typeof frame.standaloneQuery !== "string" || !frame.standaloneQuery.trim()) {
      errors.push(`invalid ${path}.standaloneQuery`);
    }
  } else if (frame.standaloneQuery !== null) {
    errors.push(`invalid ${path}.standaloneQuery`);
  }
  if (!isConfidence(frame.confidence)) errors.push(`invalid ${path}.confidence`);
}

function validateSlots(frame, path, errors) {
  if (!isPlainObject(frame.slots)) return errors.push(`${path}.slots must be plain data`);
  const allowed = new Set(VEHICLE_SLU_SLOT_SCHEMAS[frame.intent]?.allowed ?? []);
  Reflect.ownKeys(frame.slots).forEach((key) => {
    if (!allowed.has(key)) errors.push(`unknown ${path}.slots.${key}`);
    else if (!validateSlotValue(frame.slots[key], VEHICLE_SLU_SLOT_PROPERTIES[key])) errors.push(`invalid ${path}.slots.${key}`);
  });
  if (Object.hasOwn(frame.slots, "eligibilityAction") && frame.intent !== "vehicle.knowledge.query") {
    errors.push(`invalid ${path}.slots.eligibilityAction`);
  }
  if (frame.intent === "cabin.comfort.applySettings" && Array.isArray(frame.slots.windowTargets)) {
    const zones = frame.slots.windowTargets.map((target) => target.zone);
    if (new Set(zones).size !== zones.length) errors.push(`duplicate ${path}.slots.windowTargets zone`);
  }
  if (Object.hasOwn(frame.slots, "temperature") && Object.hasOwn(frame.slots, "temperatureDelta")) {
    errors.push(`conflicting ${path}.slots temperature and temperatureDelta`);
  }
}

function validateMissingSlots(frame, path, errors) {
  if (!Array.isArray(frame.missingSlots)) {
    errors.push(`${path}.missingSlots must be an array`);
    return;
  }
  if (new Set(frame.missingSlots).size !== frame.missingSlots.length) {
    errors.push(`duplicate ${path}.missingSlots`);
  }
  const schema = VEHICLE_SLU_SLOT_SCHEMAS[frame.intent];
  const allowed = new Set([...(schema?.allowed ?? []), ...(schema?.missingSlotMarkers ?? [])]);
  frame.missingSlots.forEach((slot) => {
    if (typeof slot !== "string" || !allowed.has(slot)) errors.push(`invalid ${path}.missingSlots entry`);
    else if (isPlainObject(frame.slots) && Object.hasOwn(frame.slots, slot)) {
      errors.push(`provided ${path}.slots.${slot} cannot be missing`);
    }
  });
  if (frame.actionNeed === "clarify" && frame.missingSlots.length === 0) {
    errors.push(`clarify ${path} requires missingSlots`);
  }
  if (frame.actionNeed !== "clarify" && frame.missingSlots.length !== 0) {
    errors.push(`non-clarify ${path} must not have missingSlots`);
  }
}

function validateSlotValue(value, schema) {
  if (!schema) return false;
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return false;
  if (schema.integer && !Number.isInteger(value)) return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  if (schema.type === "object") {
    if (!isPlainObject(value)) return false;
    const properties = schema.properties || {};
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
    if (Object.entries(value).some(([key, entry]) => !validateSlotValue(entry, properties[key]))) return false;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (schema.uniqueItems && new Set(value).size !== value.length) return false;
    if (schema.items && value.some((entry) => !validateSlotValue(entry, schema.items))) return false;
  }
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (Number.isFinite(schema.minimum) && value < schema.minimum) return false;
  if (Number.isFinite(schema.maximum) && value > schema.maximum) return false;
  return true;
}

function intentType(capability, intent) {
  const entries = VEHICLE_SLU_ONTOLOGY[capability];
  if (entries?.executable?.includes(intent)) return "executable";
  if (entries?.readonly?.includes(intent)) return "readonly";
  return null;
}

function validateKeys(value, allowed, path, errors) {
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) errors.push(`invalid own property in ${path}`);
    else if (!allowed.has(key)) errors.push(`unknown ${path}.${key}`);
  });
}

function validatePlainData(value, path, errors, ancestors = new Set()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`non-finite ${path}`);
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    errors.push(`non-plain ${path}`);
    return false;
  }
  if (ancestors.has(value)) {
    errors.push(`cyclic ${path}`);
    return false;
  }
  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    Reflect.ownKeys(value).forEach((key) => {
      if (key === "length") return;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !isArrayIndex(key) || !descriptor?.enumerable || !("value" in descriptor)) {
        errors.push(`invalid own property in ${path}`); valid = false;
      } else if (!validatePlainData(descriptor.value, `${path}[${key}]`, errors, ancestors)) valid = false;
    });
  } else if (!isPlainObject(value)) {
    errors.push(`non-plain ${path}`); valid = false;
  } else {
    Reflect.ownKeys(value).forEach((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
        errors.push(`invalid own property in ${path}`); valid = false;
      } else if (!validatePlainData(descriptor.value, `${path}.${key}`, errors, ancestors)) valid = false;
    });
  }
  ancestors.delete(value);
  return valid;
}

function isArrayIndex(key) {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}

function isConfidence(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}
