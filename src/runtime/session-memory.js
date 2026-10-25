export const SESSION_MEMORY_POLICY = Object.freeze({
  id: "nio-session-memory",
  version: "1.1.0",
  storage: "runtime-memory-only",
  maxTurns: 6,
  ttlMs: 30 * 60 * 1000,
  prohibitedUses: Object.freeze([
    "vehicle-control-slots", "vehicle-state", "external-data", "location", "weather",
    "poi", "traffic", "confirmation", "manual-facts", "manual-citations", "execution-status",
  ]),
});

export class SessionMemory {
  constructor(config = {}) {
    this.now = config.now || (() => Date.now());
    this.maxTurns = config.maxTurns || SESSION_MEMORY_POLICY.maxTurns;
    this.ttlMs = config.ttlMs || SESSION_MEMORY_POLICY.ttlMs;
    this.sessions = new Map();
  }

  read(sessionId) {
    const id = normalizeSessionId(sessionId);
    this.prune(id);
    const turns = this.sessions.get(id) || [];
    return {
      policy: { ...SESSION_MEMORY_POLICY },
      sessionId: id,
      turns: turns.map((turn) => ({ ...turn })),
    };
  }

  buildConversationHint(sessionId) {
    const startedAt = highResolutionNow();
    const snapshot = this.read(sessionId);
    const hint = {
      type: "ConversationMemoryHint",
      policy: { ...SESSION_MEMORY_POLICY },
      sessionId: snapshot.sessionId,
      executable: false,
      neverExecutableFacts: [...SESSION_MEMORY_POLICY.prohibitedUses],
      purpose: "conversation-topic-continuity-only",
      turns: snapshot.turns.map((turn) => ({
        sourceTurnId: turn.turnId,
        provenance: turn.provenance,
        expiresAt: turn.expiresAt,
        purpose: "conversation-topic-continuity-only",
        executable: false,
        user: { ...turn.user },
        assistant: { ...turn.assistant },
      })),
    };
    const chars = hint.turns.reduce((total, turn) => total + turn.user.text.length + turn.assistant.text.length, 0);
    return {
      hint,
      telemetry: {
        policy: "nio-conversation-memory-hint@1.0.0",
        durationMs: highResolutionNow() - startedAt,
        turnCount: hint.turns.length,
        chars,
        synchronous: true,
        io: "none",
        modelCalls: 0,
        vectorRetrievals: 0,
      },
    };
  }

  write(sessionId, record) {
    if (!isEligibleSessionMemoryRecord(record)) return null;
    const id = normalizeSessionId(sessionId);
    this.prune(id);
    const createdAtMs = this.now();
    const turn = {
      turnId: String(record.turnId || ""),
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + this.ttlMs).toISOString(),
      provenance: "runtime-result-open-conversation",
      user: { role: "user", text: String(record.userText).trim() },
      assistant: { role: "assistant", text: String(record.assistantText).trim() },
    };
    const next = [...(this.sessions.get(id) || []), turn].slice(-this.maxTurns);
    this.sessions.set(id, next);
    return { ...turn };
  }

  clear(sessionId) {
    return this.sessions.delete(normalizeSessionId(sessionId));
  }

  prune(sessionId) {
    const id = normalizeSessionId(sessionId);
    const now = this.now();
    const turns = (this.sessions.get(id) || []).filter((turn) => now < Date.parse(turn.expiresAt));
    if (turns.length) this.sessions.set(id, turns);
    else this.sessions.delete(id);
  }
}

function highResolutionNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function isEligibleSessionMemoryRecord(record = {}) {
  if (record.intent !== "conversation.general" || record.needsClarification || record.hasManualEvidence || record.requiresExternalData) return false;
  const userText = String(record.userText || "").trim();
  const assistantText = String(record.assistantText || "").trim();
  if (!userText || !assistantText) return false;
  return !/^(?:取消|撤销|不用了|不需要了|算了|别(?:再)?(?:说|执行)?|不要(?:再)?(?:说|执行)?|否认)(?:\s|$|[，。,.！!?])/i.test(userText);
}

function normalizeSessionId(value) {
  const id = String(value || "").trim();
  return id || "default-browser-session";
}
