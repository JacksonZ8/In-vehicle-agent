export class PendingClarificationStore {
  constructor() {
    this.pendingBySession = new Map();
  }

  get(sessionId) {
    const pending = this.pendingBySession.get(normalizeSessionId(sessionId));
    return pending ? immutableSnapshot(pending) : null;
  }

  set(sessionId, pending) {
    const id = normalizeSessionId(sessionId);
    const next = normalizePending(pending);
    const replacedTaskId = this.pendingBySession.get(id)?.taskId || null;
    this.pendingBySession.set(id, next);
    return { status: "stored", taskId: next.taskId, replacedTaskId };
  }

  mergeSlots(sessionId, update = {}) {
    if (Object.hasOwn(update, "intent")) throw new Error("intent override is not allowed");
    const id = normalizeSessionId(sessionId);
    const pending = this.pendingBySession.get(id);
    if (!pending) return { status: "missing" };

    const slots = requireRecord(update.slots, "slots");
    const slotProvenance = requireRecord(update.slotProvenance, "slotProvenance");
    for (const key of Object.keys(slots)) {
      if (!pending.missingSlots.includes(key)) throw new Error(`undeclared slot: ${key}`);
      if (!hasProvenance(slotProvenance[key])) throw new Error(`missing provenance: ${key}`);
    }
    for (const key of Object.keys(slotProvenance)) {
      if (!Object.hasOwn(slots, key) || !pending.missingSlots.includes(key)) {
        throw new Error(`undeclared provenance: ${key}`);
      }
    }

    const acceptedSlots = { ...pending.acceptedSlots, ...slots };
    const next = {
      ...pending,
      acceptedSlots,
      missingSlots: pending.missingSlots.filter((key) => !Object.hasOwn(slots, key)),
      slotProvenance: { ...pending.slotProvenance, ...slotProvenance },
    };
    this.pendingBySession.set(id, next);
    if (!next.missingSlots.length) return { status: "resolved" };
    return { status: "pending", taskId: next.taskId };
  }

  clear(sessionId, reasonCode) {
    const id = normalizeSessionId(sessionId);
    const reason = String(reasonCode || "").trim();
    if (!reason) throw new Error("reasonCode is required");
    const pending = this.pendingBySession.get(id);
    if (!pending) return { status: "missing", reasonCode: reason };
    this.pendingBySession.delete(id);
    return { status: "cleared", taskId: pending.taskId, reasonCode: reason };
  }
}

export function createPendingClarification({
  taskId,
  intent,
  acceptedSlots,
  missingSlots,
  slotProvenance,
  clarificationQuestion,
  originalUtterance,
} = {}) {
  return immutableSnapshot(normalizePending({
    taskId,
    intent,
    acceptedSlots,
    missingSlots,
    slotProvenance,
    clarificationQuestion,
    originalUtterance,
  }));
}

function normalizePending(pending = {}) {
  const taskId = String(pending.taskId || "").trim();
  const intent = String(pending.intent || "").trim();
  const clarificationQuestion = String(pending.clarificationQuestion || "").trim();
  const originalUtterance = String(pending.originalUtterance || "").trim();
  if (!taskId) throw new Error("taskId is required");
  if (!intent) throw new Error("intent is required");
  if (!clarificationQuestion) throw new Error("clarificationQuestion is required");
  if (!originalUtterance) throw new Error("originalUtterance is required");

  const acceptedSlots = requireRecord(pending.acceptedSlots, "acceptedSlots");
  if (!Array.isArray(pending.missingSlots)) throw new Error("missingSlots is required");
  const missingSlots = [...new Set(pending.missingSlots.map((key) => String(key).trim()).filter(Boolean))];
  const slotProvenance = requireRecord(pending.slotProvenance, "slotProvenance");
  for (const key of Object.keys(acceptedSlots)) {
    if (!hasProvenance(slotProvenance[key])) throw new Error(`missing provenance: ${key}`);
  }
  return {
    taskId,
    intent,
    acceptedSlots: { ...acceptedSlots },
    missingSlots,
    slotProvenance: { ...slotProvenance },
    clarificationQuestion,
    originalUtterance,
  };
}

function normalizeSessionId(value) {
  const sessionId = String(value || "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  return sessionId;
}

function requireRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is required`);
  return value;
}

function hasProvenance(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableSnapshot(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableSnapshot));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableSnapshot(item)])));
}
