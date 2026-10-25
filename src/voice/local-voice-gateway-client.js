import { LOCAL_VOICE_PROTOCOL } from "./local-voice-protocol.js";

const EVENT_TYPES = new Set(["session.ready", "wake.detected", "voice.error"]);
const SESSION_READY_TIMEOUT_MS = 5_000;

function normalizeEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== LOCAL_VOICE_PROTOCOL.schemaVersion
    || !EVENT_TYPES.has(value.type)
    || typeof value.sessionId !== "string"
    || !Number.isSafeInteger(value.sequence)
    || typeof value.observedAt !== "string"
    || !LOCAL_VOICE_PROTOCOL.modes.includes(value.mode)
    || typeof value.provider !== "string"
    || typeof value.simulated !== "boolean") return null;
  const observedAt = new Date(value.observedAt);
  if (!Number.isFinite(observedAt.getTime())) return null;
  return Object.freeze({
    schemaVersion: LOCAL_VOICE_PROTOCOL.schemaVersion,
    type: value.type,
    sessionId: value.sessionId,
    sequence: value.sequence,
    observedAt: observedAt.toISOString(),
    mode: value.mode,
    provider: value.provider,
    simulated: value.simulated,
    phrase: ["NOMI", "嗨，NOMI"].includes(value.phrase) ? value.phrase : null,
    reasonCode: typeof value.reasonCode === "string" ? value.reasonCode : null,
  });
}

function normalizeOffer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== LOCAL_VOICE_PROTOCOL.schemaVersion
    || typeof value.sessionId !== "string"
    || typeof value.nonce !== "string"
    || typeof value.websocketPath !== "string"
    || !value.websocketPath.startsWith("/api/local-voice/stream?")) return null;
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    sessionId: value.sessionId,
    nonce: value.nonce,
    websocketPath: value.websocketPath,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
    readiness: value.readiness && typeof value.readiness === "object"
      ? Object.freeze({
        status: value.readiness.status,
        provider: value.readiness.provider,
        model: value.readiness.model ?? null,
        reasonCode: value.readiness.reasonCode ?? null,
        simulated: value.readiness.simulated === true,
      })
      : null,
  });
}

export class LocalVoiceGatewayClient {
  #createWebSocket;
  #fetch;
  #intentionalCloses = new WeakSet();
  #listeners = new Set();
  #location;
  #offer = null;
  #ready = false;
  #websocket = null;

  constructor({
    fetchImpl = globalThis.fetch?.bind(globalThis),
    createWebSocket = (url) => new globalThis.WebSocket(url),
    location = globalThis.location,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    if (typeof createWebSocket !== "function") throw new TypeError("createWebSocket is required");
    if (!location?.origin) throw new TypeError("location.origin is required");
    this.#fetch = fetchImpl;
    this.#createWebSocket = createWebSocket;
    this.#location = location;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start({ mode = "wake", timeoutMs = SESSION_READY_TIMEOUT_MS } = {}) {
    if (!LOCAL_VOICE_PROTOCOL.modes.includes(mode)) throw new TypeError("unsupported voice mode");
    if (this.#websocket) throw new Error("local voice gateway already started");
    const response = await this.#fetch("/api/local-voice/session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`local voice session HTTP ${response.status}`);
    const offer = normalizeOffer(await response.json());
    if (!offer) throw new Error("invalid local voice session offer");
    this.#offer = offer;
    const websocketUrl = new URL(offer.websocketPath, this.#location.origin);
    websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
    const websocket = this.#createWebSocket(websocketUrl.href);
    this.#websocket = websocket;
    websocket.binaryType = "arraybuffer";

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = globalThis.setTimeout(() => finish(reject, new Error("local voice gateway timeout")), timeoutMs);
      const cleanup = () => globalThis.clearTimeout(timer);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      websocket.onopen = () => {
        if (this.#websocket !== websocket) return;
        websocket.send(JSON.stringify({
          schemaVersion: LOCAL_VOICE_PROTOCOL.schemaVersion,
          type: "session.start",
          sessionId: offer.sessionId,
          nonce: offer.nonce,
          sampleRate: LOCAL_VOICE_PROTOCOL.sampleRate,
          channels: LOCAL_VOICE_PROTOCOL.channels,
          frameSamples: LOCAL_VOICE_PROTOCOL.frameSamples,
          mode,
        }));
      };
      websocket.onmessage = (message) => {
        if (this.#websocket !== websocket) return;
        if (typeof message.data !== "string") return;
        let event;
        try {
          event = normalizeEvent(JSON.parse(message.data));
        } catch {
          event = null;
        }
        if (!event || event.sessionId !== offer.sessionId) return;
        if (event.type === "session.ready") {
          this.#ready = true;
          finish(resolve, Object.freeze({ offer, event }));
        }
        if (event.type === "voice.error" && !this.#ready) {
          finish(reject, new Error(event.reasonCode || "local voice worker unavailable"));
        }
        for (const listener of this.#listeners) listener(event);
      };
      websocket.onerror = () => {
        if (!settled) finish(reject, new Error("local voice websocket unavailable"));
      };
      websocket.onclose = () => {
        const isCurrentWebSocket = this.#websocket === websocket;
        if (isCurrentWebSocket) {
          this.#ready = false;
          this.#websocket = null;
        }
        if (!settled) finish(reject, new Error("local voice websocket closed"));
        if (this.#intentionalCloses.delete(websocket)) return;
        if (!isCurrentWebSocket) return;
        const closedEvent = Object.freeze({
          schemaVersion: LOCAL_VOICE_PROTOCOL.schemaVersion,
          type: "gateway.closed",
          sessionId: offer.sessionId,
          sequence: 0,
          observedAt: new Date().toISOString(),
          mode,
          provider: "local-voice-gateway",
          simulated: false,
          phrase: null,
          reasonCode: "local-voice-connection-closed",
        });
        for (const listener of this.#listeners) listener(closedEvent);
      };
    });
  }

  sendFrame(frame) {
    const websocket = this.#websocket;
    if (!this.#ready || !websocket || websocket.readyState !== 1) return false;
    if (!(frame instanceof ArrayBuffer) || frame.byteLength !== LOCAL_VOICE_PROTOCOL.frameBytes) {
      throw new TypeError("invalid local voice PCM frame");
    }
    if (websocket.bufferedAmount > LOCAL_VOICE_PROTOCOL.frameBytes * LOCAL_VOICE_PROTOCOL.maxBufferedFrames) {
      return false;
    }
    websocket.send(frame);
    return true;
  }

  setMode(mode) {
    if (!LOCAL_VOICE_PROTOCOL.modes.includes(mode)) throw new TypeError("unsupported voice mode");
    if (!this.#ready || !this.#websocket || !this.#offer) return false;
    this.#websocket.send(JSON.stringify({
      schemaVersion: LOCAL_VOICE_PROTOCOL.schemaVersion,
      type: "mode.set",
      sessionId: this.#offer.sessionId,
      mode,
    }));
    return true;
  }

  stop() {
    const websocket = this.#websocket;
    if (websocket && this.#offer && websocket.readyState === 1) {
      this.#intentionalCloses.add(websocket);
      websocket.send(JSON.stringify({
        schemaVersion: LOCAL_VOICE_PROTOCOL.schemaVersion,
        type: "session.stop",
        sessionId: this.#offer.sessionId,
      }));
      websocket.close(1000, "client-stopped");
    } else if (websocket) {
      this.#intentionalCloses.add(websocket);
      websocket.close();
    }
    this.#ready = false;
    this.#websocket = null;
    this.#offer = null;
  }

  getSnapshot() {
    return Object.freeze({
      connected: Boolean(this.#websocket),
      ready: this.#ready,
      sessionId: this.#offer?.sessionId ?? null,
      readiness: this.#offer?.readiness ?? null,
    });
  }
}
