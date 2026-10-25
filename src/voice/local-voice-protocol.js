export const LOCAL_VOICE_PROTOCOL = Object.freeze({
  schemaVersion: "nio-local-voice@1.0.0",
  sampleRate: 16_000,
  channels: 1,
  frameDurationMs: 20,
  frameSamples: 320,
  frameBytes: 640,
  maxBufferedFrames: 50,
  modes: Object.freeze(["wake", "enrollment", "confirmation"]),
});

const CONTROL_TYPES = new Set(["session.start", "mode.set", "session.stop"]);
const MODES = new Set(LOCAL_VOICE_PROTOCOL.modes);
const COMMON_FIELDS = Object.freeze(["schemaVersion", "type", "sessionId"]);
const CONTROL_FIELDS = Object.freeze({
  "session.start": Object.freeze([
    ...COMMON_FIELDS,
    "nonce",
    "sampleRate",
    "channels",
    "frameSamples",
    "mode",
  ]),
  "mode.set": Object.freeze([...COMMON_FIELDS, "mode"]),
  "session.stop": COMMON_FIELDS,
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, allowedFields) {
  const allowed = new Set(allowedFields);
  return Object.keys(value).every((field) => allowed.has(field))
    && allowedFields.every((field) => Object.hasOwn(value, field));
}

function boundedToken(value, { min = 1, max = 128 } = {}) {
  return typeof value === "string"
    && value.length >= min
    && value.length <= max
    && /^[A-Za-z0-9._~-]+$/.test(value);
}

function immutableControl(value) {
  const base = {
    schemaVersion: LOCAL_VOICE_PROTOCOL.schemaVersion,
    type: value.type,
    sessionId: value.sessionId,
  };
  if (value.type === "session.start") {
    return Object.freeze({
      ...base,
      nonce: value.nonce,
      sampleRate: LOCAL_VOICE_PROTOCOL.sampleRate,
      channels: LOCAL_VOICE_PROTOCOL.channels,
      frameSamples: LOCAL_VOICE_PROTOCOL.frameSamples,
      mode: value.mode,
    });
  }
  if (value.type === "mode.set") return Object.freeze({ ...base, mode: value.mode });
  return Object.freeze(base);
}

export function parseLocalVoiceControlMessage(value) {
  if (!isPlainObject(value)
    || value.schemaVersion !== LOCAL_VOICE_PROTOCOL.schemaVersion
    || !CONTROL_TYPES.has(value.type)
    || !exactFields(value, CONTROL_FIELDS[value.type])
    || !boundedToken(value.sessionId)) return null;

  if (value.type === "session.start") {
    if (!boundedToken(value.nonce, { min: 24, max: 256 })
      || value.sampleRate !== LOCAL_VOICE_PROTOCOL.sampleRate
      || value.channels !== LOCAL_VOICE_PROTOCOL.channels
      || value.frameSamples !== LOCAL_VOICE_PROTOCOL.frameSamples
      || !MODES.has(value.mode)) return null;
  }
  if (value.type === "mode.set" && !MODES.has(value.mode)) return null;
  return immutableControl(value);
}

export function validateLocalVoicePcmFrame(value) {
  const byteLength = value instanceof ArrayBuffer
    ? value.byteLength
    : ArrayBuffer.isView(value) ? value.byteLength : -1;
  return Object.freeze({
    ok: byteLength === LOCAL_VOICE_PROTOCOL.frameBytes,
    byteLength,
    reasonCode: byteLength === LOCAL_VOICE_PROTOCOL.frameBytes
      ? null
      : "invalid-pcm-frame",
  });
}

export function createLocalVoiceEvent(type, {
  sessionId,
  sequence,
  observedAt,
  mode,
  provider,
  simulated,
  phrase = null,
  reasonCode = null,
} = {}) {
  if (!boundedToken(type, { max: 64 })
    || !boundedToken(sessionId)
    || !Number.isSafeInteger(sequence)
    || sequence < 1
    || !MODES.has(mode)
    || !boundedToken(provider)
    || typeof simulated !== "boolean") {
    throw new TypeError("invalid local voice event");
  }
  const timestamp = new Date(observedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("invalid local voice event time");
  if (phrase !== null && !["NOMI", "嗨，NOMI"].includes(phrase)) {
    throw new TypeError("unsupported wake phrase");
  }
  if (reasonCode !== null && !boundedToken(reasonCode, { max: 64 })) {
    throw new TypeError("invalid local voice reason code");
  }
  return Object.freeze({
    schemaVersion: LOCAL_VOICE_PROTOCOL.schemaVersion,
    type,
    sessionId,
    sequence,
    observedAt: timestamp.toISOString(),
    mode,
    provider,
    simulated,
    phrase,
    reasonCode,
  });
}
