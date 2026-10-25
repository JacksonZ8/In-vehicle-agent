import {
  createRunEvent,
  validateB3RunEventSequence,
  validateRunEvent,
} from "./run-event-protocol.js";

export class RunEventLedger {
  #current = null;
  #previous = null;
  #eventIds = new Set();
  #listeners = new Set();

  append(event) {
    const validationErrors = validateRunEvent(event);
    if (validationErrors.length > 0) {
      throw new TypeError(`event must satisfy the canonical Run Event v2 contract: ${validationErrors.join("; ")}`);
    }
    const canonicalEvent = createRunEvent(event);
    if (this.#eventIds.has(canonicalEvent.eventId)) {
      throw new Error(`duplicate eventId: ${canonicalEvent.eventId}`);
    }
    if (this.#current && this.#current.runId !== canonicalEvent.runId) {
      throw new Error("complete the current run before appending a different runId");
    }
    if (this.#current?.events.some((currentEvent) => currentEvent.sequence === canonicalEvent.sequence)) {
      throw new Error(`duplicate sequence: ${canonicalEvent.sequence}`);
    }
    const currentEvents = this.#current?.events || [];
    if (canonicalEvent.parentEventId === null) {
      if (currentEvents.length > 0) throw new Error("only the first event may have parentEventId=null");
    } else {
      const parent = currentEvents.find((candidate) => candidate.eventId === canonicalEvent.parentEventId);
      if (!parent) throw new Error("parentEventId must reference an existing event in the same run");
      if (parent.runId !== canonicalEvent.runId || parent.sequence >= canonicalEvent.sequence) {
        throw new Error("parentEventId must reference an earlier event in the same run");
      }
    }
    const sequenceErrors = validateB3RunEventSequence([
      ...currentEvents,
      canonicalEvent,
    ]);
    if (sequenceErrors.length > 0) throw new Error(sequenceErrors.join("; "));

    if (!this.#current) {
      this.#current = {
        runId: canonicalEvent.runId,
        startedAt: canonicalEvent.timestamp,
        events: [],
      };
    }

    this.#eventIds.add(canonicalEvent.eventId);
    this.#current.events.push(canonicalEvent);
    this.#current.events.sort((left, right) => left.sequence - right.sequence);
    this.#current.startedAt = this.#current.events[0].timestamp;
    const snapshot = this.getCurrentRun();
    this.#notify(snapshot);
    return snapshot;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#listeners.add(listener);
  }

  getCurrentRun() {
    if (!this.#current) return null;
    return createRunSnapshot({
      ...this.#current,
      status: "active",
      completedAt: null,
    });
  }

  getPreviousRun() {
    return this.#previous;
  }

  completeRun(runId) {
    return this.#finishRun(runId, "completed", "complete");
  }

  terminateRun(runId, status = "failed") {
    if (!["failed", "cancelled"].includes(status)) {
      throw new TypeError(`unsupported terminal run status: ${status}`);
    }
    return this.#finishRun(runId, status, "terminate");
  }

  #finishRun(runId, status, action) {
    if (!this.#current || this.#current.runId !== runId) {
      throw new Error(`cannot ${action} run: ${runId}`);
    }

    this.#previous = createRunSnapshot({
      ...this.#current,
      status,
      completedAt: this.#current.events.at(-1).timestamp,
    });
    this.#current = null;
    this.#eventIds = new Set(this.#previous.events.map((event) => event.eventId));
    this.#notify(this.#previous);
    return this.#previous;
  }

  createReplay(runId) {
    const run = [this.getCurrentRun(), this.#previous].find((candidate) => candidate?.runId === runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    return new RunEventReplay(run);
  }

  #notify(snapshot) {
    for (const listener of this.#listeners) listener(snapshot);
  }
}

class RunEventReplay {
  #runId;
  #events;
  #cursor = 0;

  constructor(run) {
    this.#runId = run.runId;
    this.#events = Object.freeze([...run.events]);
  }

  get runId() {
    return this.#runId;
  }

  get cursor() {
    return this.#cursor;
  }

  get eventCount() {
    return this.#events.length;
  }

  get visibleEvents() {
    return Object.freeze(this.#events.slice(0, this.#cursor));
  }

  get canStepBack() {
    return this.#cursor > 0;
  }

  get canStepForward() {
    return this.#cursor < this.#events.length;
  }

  stepForward() {
    if (this.canStepForward) this.#cursor += 1;
    return this;
  }

  stepBack() {
    if (this.canStepBack) this.#cursor -= 1;
    return this;
  }

  seek(sequence) {
    const index = this.#events.findIndex((event) => event.sequence === sequence);
    if (index < 0) throw new RangeError(`sequence not found: ${sequence}`);
    this.#cursor = index + 1;
    return this;
  }

  reset() {
    this.#cursor = 0;
    return this;
  }
}

function createRunSnapshot({ runId, status, startedAt, completedAt, events }) {
  return Object.freeze({
    runId,
    status,
    startedAt,
    completedAt,
    events: Object.freeze([...events]),
  });
}
