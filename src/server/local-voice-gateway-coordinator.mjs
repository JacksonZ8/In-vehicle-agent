import { randomBytes } from "node:crypto";
import { DeterministicLocalVoiceFakeWorker } from "../voice/local-voice-fake-worker.js";
import { resolveLocalVoiceModelReadiness } from "./local-voice-model-profile.mjs";
import { LocalVoiceSherpaWorker } from "./local-voice-sherpa-worker.mjs";
import {
  createLocalVoiceEvent,
  LOCAL_VOICE_PROTOCOL,
  parseLocalVoiceControlMessage,
  validateLocalVoicePcmFrame,
} from "../voice/local-voice-protocol.js";

const SESSION_OFFER_TTL_MS = 30_000;
const MAX_LOCAL_VOICE_SESSIONS = 4;

function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function requireOrigin(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new TypeError("origin is required");
  }
  return value.trim();
}

function requireSessionId(value) {
  if (typeof value !== "string"
    || value.length < 8
    || value.length > 128
    || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new TypeError("invalid local voice session id");
  }
  return value;
}

function publicOffer(session, readiness) {
  return Object.freeze({
    schemaVersion: LOCAL_VOICE_PROTOCOL.schemaVersion,
    sessionId: session.sessionId,
    nonce: session.nonce,
    expiresAt: new Date(session.expiresAt).toISOString(),
    websocketPath: `/api/local-voice/stream?sessionId=${encodeURIComponent(session.sessionId)}`,
    audio: Object.freeze({
      sampleRate: LOCAL_VOICE_PROTOCOL.sampleRate,
      channels: LOCAL_VOICE_PROTOCOL.channels,
      frameSamples: LOCAL_VOICE_PROTOCOL.frameSamples,
      frameDurationMs: LOCAL_VOICE_PROTOCOL.frameDurationMs,
    }),
    readiness,
  });
}

export class LocalVoiceGatewayCoordinator {
  #createId;
  #createNonce;
  #createWorker;
  #now;
  #offerTtlMs;
  #readiness;
  #sessions = new Map();

  constructor({
    now = Date.now,
    createId = () => `voice-${randomToken(18)}`,
    createNonce = () => randomToken(32),
    createWorker,
    readiness,
    offerTtlMs = SESSION_OFFER_TTL_MS,
  } = {}) {
    const hasCustomWorker = typeof createWorker === "function";
    const resolvedReadiness = readiness ?? (hasCustomWorker
      ? Object.freeze({
        status: "degraded",
        provider: "fake-local-kws",
        model: null,
        reasonCode: "local-voice-model-unavailable",
        simulated: true,
      })
      : resolveLocalVoiceModelReadiness());
    const workerFactory = createWorker ?? (resolvedReadiness.status === "ready"
      ? () => new LocalVoiceSherpaWorker()
      : () => new DeterministicLocalVoiceFakeWorker());
    for (const [name, value] of Object.entries({ now, createId, createNonce, createWorker: workerFactory })) {
      if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
    }
    if (!Number.isSafeInteger(offerTtlMs) || offerTtlMs < 1_000 || offerTtlMs > 120_000) {
      throw new TypeError("offerTtlMs must be between 1000 and 120000");
    }
    this.#now = now;
    this.#createId = createId;
    this.#createNonce = createNonce;
    this.#createWorker = workerFactory;
    this.#readiness = resolvedReadiness;
    this.#offerTtlMs = offerTtlMs;
  }

  issueSession({ origin } = {}) {
    const normalizedOrigin = requireOrigin(origin);
    this.#pruneExpired();
    if (this.#sessions.size >= MAX_LOCAL_VOICE_SESSIONS) {
      throw new Error("local voice session capacity reached");
    }
    const issuedAt = Number(this.#now());
    if (!Number.isFinite(issuedAt)) throw new TypeError("now must return a finite number");
    const sessionId = requireSessionId(this.#createId());
    if (this.#sessions.has(sessionId)) throw new Error("duplicate local voice session id");
    const nonce = this.#createNonce();
    if (typeof nonce !== "string" || nonce.length < 24 || nonce.length > 256) {
      throw new TypeError("invalid local voice session nonce");
    }
    const session = {
      sessionId,
      nonce,
      origin: normalizedOrigin,
      issuedAt,
      expiresAt: issuedAt + this.#offerTtlMs,
      state: "offered",
      mode: "wake",
      sequence: 0,
      send: null,
      worker: null,
    };
    this.#sessions.set(sessionId, session);
    return publicOffer(session, this.getReadiness());
  }

  connect({ sessionId, origin, send } = {}) {
    const session = this.#requireOfferedSession(sessionId, origin);
    if (typeof send !== "function") throw new TypeError("send must be a function");
    session.state = "connected";
    session.send = send;
    return Object.freeze({ sessionId: session.sessionId, state: session.state });
  }

  receiveText(sessionId, value) {
    const session = this.#requireSession(sessionId);
    let decoded = value;
    if (typeof value === "string") {
      try {
        decoded = JSON.parse(value);
      } catch {
        return this.#fail(session, "invalid-control-message");
      }
    }
    const message = parseLocalVoiceControlMessage(decoded);
    if (!message || message.sessionId !== session.sessionId) {
      return this.#fail(session, "invalid-control-message");
    }
    if (message.type === "session.start") return this.#start(session, message);
    if (message.type === "mode.set") return this.#setMode(session, message.mode);
    this.disconnect(session.sessionId, "client-stopped");
    return Object.freeze({ ok: true, closed: true });
  }

  receiveBinary(sessionId, frame) {
    const session = this.#requireSession(sessionId);
    if (session.state !== "active" || !session.worker) {
      return this.#fail(session, "voice-session-not-active");
    }
    const validation = validateLocalVoicePcmFrame(frame);
    if (!validation.ok) return this.#fail(session, validation.reasonCode);
    const events = session.worker.processFrame(frame);
    for (const event of events) {
      session.sequence += 1;
      session.send(Object.freeze({ ...event, sequence: session.sequence }));
    }
    return Object.freeze({ ok: true, emitted: events.length });
  }

  disconnect(sessionId, reasonCode = "connection-closed") {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    session.worker?.stop?.();
    session.state = "closed";
    session.send = null;
    session.nonce = null;
    this.#sessions.delete(sessionId);
    return reasonCode;
  }

  close() {
    for (const sessionId of [...this.#sessions.keys()]) this.disconnect(sessionId, "server-stopped");
  }

  getReadiness() {
    return this.#readiness;
  }

  #requireOfferedSession(sessionId, origin) {
    const session = this.#requireSession(sessionId);
    if (session.state !== "offered") throw new Error("local voice session already connected");
    if (session.origin !== requireOrigin(origin)) throw new Error("local voice origin mismatch");
    if (session.expiresAt <= Number(this.#now())) {
      this.disconnect(session.sessionId, "session-offer-expired");
      throw new Error("local voice session offer expired");
    }
    return session;
  }

  #requireSession(sessionId) {
    const normalized = requireSessionId(sessionId);
    const session = this.#sessions.get(normalized);
    if (!session) throw new Error("local voice session unavailable");
    return session;
  }

  #start(session, message) {
    if (session.state !== "connected" || message.nonce !== session.nonce) {
      return this.#fail(session, "invalid-session-start");
    }
    const worker = this.#createWorker();
    if (!worker || typeof worker.start !== "function"
      || typeof worker.processFrame !== "function"
      || typeof worker.setMode !== "function"
      || typeof worker.stop !== "function") {
      return this.#fail(session, "local-voice-worker-unavailable");
    }
    session.worker = worker;
    session.mode = message.mode;
    session.state = "starting";
    session.nonce = null;
    worker.start({
      sessionId: session.sessionId,
      mode: message.mode,
      emit: (event) => this.#emitWorkerEvent(session, event),
      onReady: () => this.#workerReady(session),
      onError: (reasonCode) => this.#fail(session, reasonCode),
    });
    if (worker.getSnapshot?.().active === true) this.#workerReady(session);
    return Object.freeze({ ok: true, state: session.state });
  }

  #workerReady(session) {
    if (session.state !== "starting" || !session.worker) return;
    session.state = "active";
    const snapshot = session.worker.getSnapshot?.() || {};
    session.sequence += 1;
    session.send(createLocalVoiceEvent("session.ready", {
      sessionId: session.sessionId,
      sequence: session.sequence,
      observedAt: this.#now(),
      mode: session.mode,
      provider: snapshot.provider || "local-voice-worker",
      simulated: snapshot.simulated === true,
    }));
  }

  #emitWorkerEvent(session, event) {
    if (session.state !== "active" || event?.type !== "wake.detected") return;
    session.sequence += 1;
    session.send(createLocalVoiceEvent("wake.detected", {
      sessionId: session.sessionId,
      sequence: session.sequence,
      observedAt: this.#now(),
      mode: session.mode,
      provider: session.worker?.getSnapshot?.().provider || "local-voice-worker",
      simulated: session.worker?.getSnapshot?.().simulated === true,
      phrase: event.phrase,
    }));
  }

  #setMode(session, mode) {
    if (session.state !== "active" || !session.worker) {
      return this.#fail(session, "voice-session-not-active");
    }
    session.worker.setMode(mode);
    session.mode = mode;
    return Object.freeze({ ok: true, state: session.state, mode });
  }

  #fail(session, reasonCode) {
    if (session.send) {
      session.sequence += 1;
      session.send(createLocalVoiceEvent("voice.error", {
        sessionId: session.sessionId,
        sequence: session.sequence,
        observedAt: this.#now(),
        mode: session.mode,
        provider: "local-voice-gateway",
        simulated: false,
        reasonCode,
      }));
    }
    return Object.freeze({ ok: false, reasonCode });
  }

  #pruneExpired() {
    const now = Number(this.#now());
    for (const [sessionId, session] of this.#sessions) {
      if (session.state === "offered" && session.expiresAt <= now) {
        this.disconnect(sessionId, "session-offer-expired");
      }
    }
  }
}

export function createLocalVoiceGatewayCoordinator(options) {
  return new LocalVoiceGatewayCoordinator(options);
}
