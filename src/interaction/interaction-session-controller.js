import { createInteractionEvent } from "./interaction-event-protocol.js";
import { InteractionSessionLedger } from "./interaction-session-ledger.js";
import { INTERACTION_SESSION_POLICY } from "./interaction-session-policy.js";

function defaultSetTimer(callback, delayMs) {
  return globalThis.setTimeout(callback, delayMs);
}

function defaultClearTimer(timerId) {
  globalThis.clearTimeout(timerId);
}

export class InteractionSessionController {
  #ledger;
  #now;
  #setTimer;
  #clearTimer;
  #createId;
  #listeners = new Set();
  #state = "dormant";
  #sessionId = null;
  #sequence = 0;
  #activeTurn = null;
  #pendingReplacementTurn = null;
  #lastTurn = null;
  #followUpTimer = null;
  #followUpDeadlineAt = null;
  #cancellationInProgress = false;

  constructor({
    ledger = new InteractionSessionLedger(),
    now = Date.now,
    setTimer = defaultSetTimer,
    clearTimer = defaultClearTimer,
    createId = defaultCreateId,
  } = {}) {
    for (const [name, value] of Object.entries({
      now,
      setTimer,
      clearTimer,
      createId,
    })) {
      if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
    }
    if (!ledger || typeof ledger.append !== "function"
      || typeof ledger.getCurrentSession !== "function"
      || typeof ledger.getPreviousSession !== "function"
      || typeof ledger.closeSession !== "function") {
      throw new TypeError("ledger must implement the interaction session ledger interface");
    }
    this.#ledger = ledger;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#createId = createId;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  wake({ provider, simulated = false } = {}) {
    if (this.#state !== "dormant") {
      throw new Error(`cannot wake while interaction session is ${this.#state}`);
    }
    requireText(provider, "provider");

    this.#sessionId = this.#newId("session");
    this.#sequence = 0;
    this.#state = "listening";
    this.#emit({
      participantId: "wakeWordProvider",
      phase: "session-awakened",
      status: "done",
      simulated,
      data: { provider },
    });
    this.#emit({
      participantId: "interactionSession",
      phase: "session-listening",
      status: "pending",
      simulated,
      data: { provider },
    });
    return this.getSnapshot();
  }

  startListening() {
    if (this.#state !== "follow-up-window") {
      throw new Error(`cannot start listening while interaction session is ${this.#state}`);
    }
    this.#exitFollowUpWindow();
    this.#state = "listening";
    this.#emit({
      participantId: "interactionSession",
      phase: "session-listening",
      status: "pending",
      data: {},
    });
    return this.getSnapshot();
  }

  submitTurn({
    rawText,
    trigger,
    relation,
    deadlineAt = null,
  } = {}) {
    if (this.#state !== "listening" && !this.#activeTurn) {
      throw new Error(`cannot submit turn while interaction session is ${this.#state}`);
    }
    if (this.#state === "dormant" || this.#state === "follow-up-window") {
      throw new Error(`cannot submit turn while interaction session is ${this.#state}`);
    }
    requireText(rawText, "rawText");
    requireText(trigger, "trigger");
    requireText(relation, "relation");

    const internalTurn = this.#createTurn({
      rawText: rawText.trim(),
      trigger: trigger.trim(),
      relation: relation.trim(),
      deadlineAt,
    });
    const isReplacement = this.#activeTurn !== null;

    if (isReplacement && this.#pendingReplacementTurn) {
      this.#cancelQueuedTurn(this.#pendingReplacementTurn, "superseded-before-start");
      this.#pendingReplacementTurn = null;
    }
    if (isReplacement) {
      this.#pendingReplacementTurn = internalTurn;
    } else {
      this.#activeTurn = internalTurn;
      this.#state = "processing";
    }

    this.#emitTurnCollected(internalTurn);
    this.#emit({
      ...this.#turnReference(internalTurn),
      participantId: "interactionSession",
      phase: "turn-submitted",
      status: isReplacement ? "queued" : "thinking",
      data: {
        trigger: internalTurn.context.trigger,
        rawText: internalTurn.rawText,
      },
    });
    this.#emit({
      ...this.#turnReference(internalTurn),
      participantId: "interactionSession",
      phase: "turn-relation-classified",
      status: "done",
      data: { relation: internalTurn.context.relation },
    });
    return internalTurn.context;
  }

  requestCancellation(reasonCode = "user-cancelled") {
    if (this.#cancellationInProgress) return this.getSnapshot();
    if (!this.#activeTurn || !["processing", "speaking"].includes(this.#state)) {
      throw new Error(`cannot request cancellation while interaction session is ${this.#state}`);
    }
    if (!INTERACTION_SESSION_POLICY.cancellationReasons.includes(reasonCode)) {
      throw new TypeError(`unsupported cancellation reason: ${reasonCode}`);
    }

    const turn = this.#activeTurn;
    this.#cancellationInProgress = true;
    try {
      this.#emit({
        ...this.#turnReference(turn),
        participantId: "interactionSession",
        phase: "turn-cancel-requested",
        status: "pending",
        reasonCode,
        data: {},
      });
      this.#emit({
        ...this.#turnReference(turn),
        participantId: "interactionSession",
        phase: "turn-cancelling",
        status: "working",
        reasonCode,
        data: {},
      });
      this.#abortTurn(turn, reasonCode);
      this.#emit({
        ...this.#turnReference(turn),
        ...this.#turnLinks(turn),
        participantId: "interactionSession",
        phase: "turn-cancelled",
        status: "cancelled",
        reasonCode,
        data: {},
      });
      this.#finishActiveTurn(turn);
      return this.getSnapshot();
    } finally {
      this.#cancellationInProgress = false;
    }
  }

  beginSpeaking(turnId) {
    if (!this.#activeTurn
      || this.#activeTurn.context.turnId !== turnId
      || this.#state !== "processing") {
      throw new Error(`cannot begin speaking for turn: ${turnId}`);
    }
    this.#state = "speaking";
    return this.#activeTurn.context;
  }

  linkRun(turnId, { runId, parentRunId = null, eventIds = [] } = {}) {
    const turn = this.#requireActiveTurn(turnId, "link run to");
    const normalizedRunId = normalizeRequiredText(runId, "runId");
    const normalizedParentRunId = parentRunId === null
      ? null
      : normalizeRequiredText(parentRunId, "parentRunId");
    const normalizedEventIds = normalizeUniqueIds(eventIds, "eventIds");

    appendUnique(turn.relatedRunIds, normalizedRunId);
    appendUnique(turn.relatedRunIds, normalizedParentRunId);
    for (const eventId of normalizedEventIds) appendUnique(turn.relatedRunEventIds, eventId);
    return this.#turnReference(turn);
  }

  completeTurn(turnId, {
    outputMode = null,
    relatedRunIds = [],
    relatedRunEventIds = [],
  } = {}) {
    const turn = this.#requireActiveTurn(turnId, "complete");
    const terminalRunIds = mergeUnique(
      turn.relatedRunIds,
      normalizeUniqueIds(relatedRunIds, "relatedRunIds"),
    );
    const terminalRunEventIds = mergeUnique(
      turn.relatedRunEventIds,
      normalizeUniqueIds(relatedRunEventIds, "relatedRunEventIds"),
    );
    this.#emit({
      ...this.#turnReference(turn),
      participantId: "interactionSession",
      phase: "turn-completed",
      status: "done",
      relatedRunIds: terminalRunIds,
      relatedRunEventIds: terminalRunEventIds,
      data: { outputMode },
    });
    this.#finishActiveTurn(turn);
    return this.getSnapshot();
  }

  failTurn(turnId, {
    reasonCode = "turn-failed",
    relatedRunIds = [],
    relatedRunEventIds = [],
  } = {}) {
    const turn = this.#requireActiveTurn(turnId, "fail");
    requireText(reasonCode, "reasonCode");
    const terminalRunIds = mergeUnique(
      turn.relatedRunIds,
      normalizeUniqueIds(relatedRunIds, "relatedRunIds"),
    );
    const terminalRunEventIds = mergeUnique(
      turn.relatedRunEventIds,
      normalizeUniqueIds(relatedRunEventIds, "relatedRunEventIds"),
    );
    this.#emit({
      ...this.#turnReference(turn),
      participantId: "interactionSession",
      phase: "turn-failed",
      status: "error",
      reasonCode,
      relatedRunIds: terminalRunIds,
      relatedRunEventIds: terminalRunEventIds,
      data: {},
    });
    this.#finishActiveTurn(turn);
    return this.getSnapshot();
  }

  closeSession({ reasonCode = null } = {}) {
    if (this.#state === "dormant" || !this.#sessionId) {
      throw new Error("cannot close a dormant interaction session");
    }

    this.#exitFollowUpWindow();
    if (this.#activeTurn) {
      const turn = this.#activeTurn;
      this.#abortTurn(turn, "session-closed");
      this.#emit({
        ...this.#turnReference(turn),
        ...this.#turnLinks(turn),
        participantId: "interactionSession",
        phase: "turn-cancelled",
        status: "cancelled",
        reasonCode: "session-closed",
        data: {},
      });
      this.#lastTurn = turn;
      this.#activeTurn = null;
    }
    if (this.#pendingReplacementTurn) {
      this.#cancelQueuedTurn(this.#pendingReplacementTurn, "session-closed");
      this.#pendingReplacementTurn = null;
    }

    const closingEvent = this.#createEvent({
      ...(this.#lastTurn ? this.#turnReference(this.#lastTurn) : {}),
      participantId: "interactionSession",
      phase: "session-closed",
      status: "done",
      reasonCode,
      data: {},
    });
    this.#ledger.append(closingEvent);
    this.#sequence = closingEvent.sequence;

    const closingSessionId = this.#sessionId;
    this.#ledger.closeSession(closingSessionId, {
      closedAt: this.#timestamp(),
      reasonCode,
    });
    this.#state = "dormant";
    this.#sessionId = null;
    this.#sequence = 0;
    this.#activeTurn = null;
    this.#pendingReplacementTurn = null;
    this.#lastTurn = null;
    this.#followUpDeadlineAt = null;
    this.#notify(closingEvent);
    return this.getSnapshot();
  }

  getSnapshot() {
    return Object.freeze({
      state: this.#state,
      sessionId: this.#sessionId,
      activeTurn: this.#activeTurn?.context || null,
      pendingReplacementTurn: this.#pendingReplacementTurn?.context || null,
      followUpDeadlineAt: this.#followUpDeadlineAt,
      currentSession: projectSession(this.#ledger.getCurrentSession()),
      previousSession: projectSession(this.#ledger.getPreviousSession()),
    });
  }

  isCurrent(identity) {
    if (!identity || typeof identity !== "object" || Array.isArray(identity) || !this.#activeTurn) return false;
    if (![identity.sessionId, identity.turnId, identity.runId]
      .every((value) => typeof value === "string" && value.trim())) return false;
    const active = this.#activeTurn.context;
    return identity.sessionId === active.sessionId
      && identity.turnId === active.turnId
      && identity.runId === active.runId;
  }

  #createTurn({ rawText, trigger, relation, deadlineAt }) {
    const abortController = new AbortController();
    const context = Object.freeze({
      sessionId: this.#sessionId,
      turnId: this.#newId("turn"),
      runId: this.#newId("run"),
      trigger,
      relation,
      deadlineAt,
      signal: abortController.signal,
    });
    return {
      context,
      abortController,
      rawText,
      relatedRunIds: [],
      relatedRunEventIds: [],
    };
  }

  #emitTurnCollected(turn) {
    this.#emit({
      ...this.#turnReference(turn),
      participantId: "interactionSession",
      phase: "turn-collected",
      status: "done",
      data: {
        trigger: turn.context.trigger,
        rawText: turn.rawText,
      },
    });
  }

  #cancelQueuedTurn(turn, reasonCode) {
    this.#abortTurn(turn, reasonCode);
    this.#emit({
      ...this.#turnReference(turn),
      participantId: "interactionSession",
      phase: "turn-cancelled",
      status: "cancelled",
      reasonCode,
      data: {},
    });
  }

  #abortTurn(turn, reasonCode) {
    if (!turn.abortController.signal.aborted) turn.abortController.abort(reasonCode);
  }

  #requireActiveTurn(turnId, action) {
    if (!this.#activeTurn
      || this.#activeTurn.context.turnId !== turnId
      || !["processing", "speaking"].includes(this.#state)) {
      throw new Error(`cannot ${action} turn: ${turnId}`);
    }
    return this.#activeTurn;
  }

  #finishActiveTurn(turn) {
    this.#lastTurn = turn;
    this.#activeTurn = null;
    if (this.#pendingReplacementTurn) {
      this.#activeTurn = this.#pendingReplacementTurn;
      this.#pendingReplacementTurn = null;
      this.#state = "processing";
      return;
    }
    this.#openFollowUpWindow(turn);
  }

  #openFollowUpWindow(turn) {
    this.#exitFollowUpWindow();
    this.#state = "follow-up-window";
    const sessionId = this.#sessionId;
    this.#followUpDeadlineAt = this.#now() + INTERACTION_SESSION_POLICY.followUpWindowMs;
    const event = this.#createEvent({
      ...this.#turnReference(turn),
      participantId: "interactionSession",
      phase: "follow-up-window-opened",
      status: "pending",
      data: { deadlineAt: new Date(this.#followUpDeadlineAt).toISOString() },
    });
    this.#ledger.append(event);
    this.#sequence = event.sequence;
    this.#followUpTimer = this.#setTimer(() => {
      if (this.#state === "follow-up-window" && this.#sessionId === sessionId) {
        this.closeSession({ reasonCode: "follow-up-window-expired" });
      }
    }, INTERACTION_SESSION_POLICY.followUpWindowMs);
    this.#notify(event);
  }

  #exitFollowUpWindow() {
    if (this.#followUpTimer !== null) {
      this.#clearTimer(this.#followUpTimer);
      this.#followUpTimer = null;
    }
    this.#followUpDeadlineAt = null;
  }

  #turnReference(turn) {
    return {
      turnId: turn.context.turnId,
      runId: turn.context.runId,
    };
  }

  #turnLinks(turn) {
    return {
      relatedRunIds: [...turn.relatedRunIds],
      relatedRunEventIds: [...turn.relatedRunEventIds],
    };
  }

  #emit(input) {
    const event = this.#createEvent(input);
    this.#ledger.append(event);
    this.#sequence = event.sequence;
    this.#notify(event);
    return event;
  }

  #createEvent({
    participantId,
    phase,
    status,
    turnId = null,
    runId = null,
    reasonCode = null,
    relatedRunIds = [],
    relatedRunEventIds = [],
    simulated = false,
    data = {},
  }) {
    return createInteractionEvent({
      interactionEventId: this.#newId("interaction-event"),
      sessionId: this.#sessionId,
      turnId,
      runId,
      sequence: this.#sequence + 1,
      timestamp: this.#timestamp(),
      participantId,
      phase,
      status,
      reasonCode,
      relatedRunIds,
      relatedRunEventIds,
      simulated,
      data,
    });
  }

  #notify(event) {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) listener(snapshot, event);
  }

  #newId(kind) {
    const value = this.#createId(kind);
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError("createId must return a non-empty string");
    }
    return value.trim();
  }

  #timestamp() {
    const value = this.#now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("now must return a valid time");
    return date.toISOString();
  }
}

function defaultCreateId(kind) {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${kind}:${suffix}`;
}

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function normalizeRequiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeUniqueIds(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const normalized = value.map((item) => (
    typeof item === "string" ? item.trim() : ""
  ));
  if (normalized.some((item) => !item)) {
    throw new TypeError(`${name} must contain non-empty strings`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${name} must contain unique non-empty strings`);
  }
  return normalized;
}

function appendUnique(target, value) {
  if (value !== null && !target.includes(value)) target.push(value);
}

function mergeUnique(first, second) {
  const merged = [...first];
  for (const value of second) appendUnique(merged, value);
  return merged;
}

function projectSession(session) {
  if (!session) return null;
  const relatedRunIds = [];
  for (const event of session.events) {
    for (const runId of event.relatedRunIds || []) appendUnique(relatedRunIds, runId);
  }
  return Object.freeze({
    ...session,
    relatedRunIds: Object.freeze(relatedRunIds),
  });
}
