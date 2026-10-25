import { getParticipant, requireParticipant } from "../runtime/participant-registry.js";

export const INTERACTION_EVENT_PROTOCOL = Object.freeze({
  id: "nio-interaction-event",
  version: "1.0.0",
});

export const INTERACTION_EVENT_PHASES = Object.freeze([
  "session-awakened", "session-listening", "turn-collected", "turn-submitted",
  "turn-relation-classified", "turn-cancel-requested", "turn-cancelling",
  "turn-cancelled", "turn-completed", "turn-failed",
  "follow-up-window-opened", "session-closed",
]);

export const INTERACTION_EVENT_STATUSES = Object.freeze([
  "queued", "thinking", "working", "pending", "done", "blocked", "error", "cancelled",
]);

const PHASE_SET = new Set(INTERACTION_EVENT_PHASES);
const STATUS_SET = new Set(INTERACTION_EVENT_STATUSES);
const TURN_SUBMITTED_INDEX = INTERACTION_EVENT_PHASES.indexOf("turn-submitted");
const FOLLOW_UP_WINDOW_OPENED_INDEX = INTERACTION_EVENT_PHASES.indexOf("follow-up-window-opened");

export function createInteractionEvent(input = {}) {
  const errors = validateInteractionEventFields(input);
  let participant;
  if (!errors.some((error) => error.startsWith("participantId"))) {
    try {
      participant = requireParticipant(input.participantId);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length > 0) throw new TypeError(errors.join("; "));

  const event = {
    protocol: INTERACTION_EVENT_PROTOCOL,
    interactionEventId: normalizeRequired(input.interactionEventId),
    sessionId: normalizeRequired(input.sessionId),
    turnId: normalizeOptional(input.turnId),
    runId: normalizeOptional(input.runId),
    sequence: input.sequence,
    timestamp: normalizeRequired(input.timestamp),
    participantId: normalizeRequired(input.participantId),
    participantType: participant.type,
    phase: normalizeRequired(input.phase),
    status: normalizeRequired(input.status),
    reasonCode: normalizeOptional(input.reasonCode),
    relatedRunIds: normalizeIdArray(input.relatedRunIds),
    relatedRunEventIds: normalizeIdArray(input.relatedRunEventIds),
    simulated: input.simulated === true,
    data: cloneAndFreeze(input.data),
  };
  const validationErrors = validateInteractionEvent(event);
  if (validationErrors.length > 0) throw new TypeError(validationErrors.join("; "));
  return Object.freeze(event);
}

export function validateInteractionEvent(event) {
  const errors = validateInteractionEventFields(event);
  if (!isRecord(event)) return errors;
  if (event.protocol?.id !== INTERACTION_EVENT_PROTOCOL.id
    || event.protocol?.version !== INTERACTION_EVENT_PROTOCOL.version) {
    errors.push("protocol must identify nio-interaction-event@1.0.0");
  }
  const participant = getParticipant(event.participantId);
  if (!participant) {
    errors.push(`unregistered participant: ${event.participantId}`);
  } else if (event.participantType !== participant.type) {
    errors.push("participantType must match the participant registry");
  }
  return errors;
}

function validateInteractionEventFields(value) {
  if (!isRecord(value)) return ["interaction event must be an object"];
  const errors = [];
  for (const field of ["interactionEventId", "sessionId", "participantId", "phase", "status"]) {
    if (!normalizeRequired(value[field])) errors.push(`${field} must be a non-empty string`);
  }
  if (!Number.isInteger(value.sequence) || value.sequence < 1) {
    errors.push("sequence must be an integer >= 1");
  }
  if (!isIsoTimestamp(value.timestamp)) errors.push("timestamp must be a parseable ISO timestamp");
  if (normalizeRequired(value.phase) && !PHASE_SET.has(normalizeRequired(value.phase))) {
    errors.push("phase is not supported");
  }
  if (normalizeRequired(value.status) && !STATUS_SET.has(normalizeRequired(value.status))) {
    errors.push("status is not supported");
  }
  if (value.reasonCode != null && typeof value.reasonCode !== "string") {
    errors.push("reasonCode must be a string or null");
  }
  if (value.turnId != null && typeof value.turnId !== "string") {
    errors.push("turnId must be a string or null");
  }
  if (value.runId != null && typeof value.runId !== "string") {
    errors.push("runId must be a string or null");
  }
  const turnId = normalizeOptional(value.turnId);
  const runId = normalizeOptional(value.runId);
  if (turnId && !runId) errors.push("runId is required when turnId is present");
  if (runId && !turnId) errors.push("turnId is required when runId is present");
  const phaseIndex = INTERACTION_EVENT_PHASES.indexOf(normalizeRequired(value.phase));
  if (phaseIndex >= TURN_SUBMITTED_INDEX
    && phaseIndex <= FOLLOW_UP_WINDOW_OPENED_INDEX
    && (!turnId || !runId)) {
    errors.push("turnId and runId are required for Turn lifecycle events");
  }
  validateUniqueIdArray(value.relatedRunIds, "relatedRunIds", errors, { optional: true });
  validateUniqueIdArray(value.relatedRunEventIds, "relatedRunEventIds", errors);
  if (!isRecord(value.data)) errors.push("data must be an object");
  return errors;
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function normalizeRequired(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptional(value) {
  return normalizeRequired(value) || null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateUniqueIdArray(value, field, errors, { optional = false } = {}) {
  if (optional && value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  const normalized = value.map(normalizeRequired);
  if (normalized.some((id) => !id)) {
    errors.push(`${field} must contain non-empty strings`);
    return;
  }
  if (new Set(normalized).size !== normalized.length) {
    errors.push(`${field} must contain unique non-empty strings`);
  }
}

function normalizeIdArray(value) {
  return Object.freeze((value || []).map((id) => normalizeRequired(id)));
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  if (isRecord(value)) return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)]),
  ));
  return value;
}
