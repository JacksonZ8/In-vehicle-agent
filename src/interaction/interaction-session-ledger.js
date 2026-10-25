export class InteractionSessionLedger {
  #current = null;
  #previous = null;
  #interactionEventIds = new Set();
  #listeners = new Set();

  append(event) {
    if (!event || typeof event !== "object") {
      throw new TypeError("interaction event must be an object");
    }
    if (this.#interactionEventIds.has(event.interactionEventId)) {
      throw new Error(`duplicate interactionEventId: ${event.interactionEventId}`);
    }
    if (this.#current && this.#current.sessionId !== event.sessionId) {
      throw new Error("close the current session before appending a different sessionId");
    }

    const expectedSequence = (this.#current?.events.length || 0) + 1;
    if (event.sequence !== expectedSequence) {
      throw new Error(`expected interaction event sequence ${expectedSequence}`);
    }

    if (!this.#current) {
      this.#current = {
        sessionId: event.sessionId,
        startedAt: event.timestamp,
        events: [],
      };
    }
    this.#interactionEventIds.add(event.interactionEventId);
    this.#current.events.push(event);

    const snapshot = this.getCurrentSession();
    this.#notify(snapshot);
    return snapshot;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getCurrentSession() {
    if (!this.#current) return null;
    return createSessionSummary({
      ...this.#current,
      status: "active",
      closedAt: null,
      reasonCode: null,
    });
  }

  getPreviousSession() {
    return this.#previous;
  }

  closeSession(sessionId, { closedAt, reasonCode = null } = {}) {
    if (!this.#current || this.#current.sessionId !== sessionId) {
      throw new Error(`cannot close session: ${sessionId}`);
    }
    this.#previous = createSessionSummary({
      ...this.#current,
      status: "closed",
      closedAt: closedAt || this.#current.events.at(-1)?.timestamp || this.#current.startedAt,
      reasonCode,
    });
    this.#current = null;
    this.#notify(this.#previous);
    return this.#previous;
  }

  #notify(snapshot) {
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function createSessionSummary({
  sessionId,
  status,
  startedAt,
  closedAt,
  reasonCode,
  events,
}) {
  return Object.freeze({
    sessionId,
    status,
    startedAt,
    closedAt,
    reasonCode,
    events: Object.freeze([...events]),
  });
}
