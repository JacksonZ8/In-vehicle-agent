"use strict";

const sherpaOnnx = require("sherpa-onnx-node");

let active = false;
let keywordSpotter = null;
let config = null;

const INTENT_BY_KEYWORD = Object.freeze({
  "确认": "confirm",
  "确认执行": "confirm",
  "我是主驾，我确认执行": "confirm",
  "继续": "confirm",
  "取消": "cancel",
  "不要": "cancel",
  "算了": "cancel",
});

function send(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

function decodePcm16(frame) {
  if (!(frame instanceof Uint8Array) || frame.byteLength < 2 || frame.byteLength % 2 !== 0) {
    throw new TypeError("invalid-pcm-payload");
  }
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readInt16LE(index * 2) / 32_768;
  }
  return samples;
}

function initialize(message) {
  config = message.config;
  keywordSpotter = new sherpaOnnx.KeywordSpotter(config);
  active = true;
  send({ type: "ready" });
}

function analyze(message) {
  if (!active || !keywordSpotter || !config) throw new Error("local-voice-confirmation-not-ready");
  const samples = decodePcm16(message.pcm);
  const stream = keywordSpotter.createStream();
  const hits = [];
  for (let offset = 0; offset < samples.length; offset += 320) {
    const frame = new Float32Array(320);
    frame.set(samples.subarray(offset, Math.min(offset + 320, samples.length)));
    stream.acceptWaveform({ sampleRate: config.featConfig.sampleRate, samples: frame });
    while (keywordSpotter.isReady(stream)) {
      keywordSpotter.decode(stream);
      const keyword = keywordSpotter.getResult(stream)?.keyword || "";
      if (!keyword) continue;
      const label = keyword.startsWith("@") ? keyword.slice(1) : keyword;
      const intent = INTENT_BY_KEYWORD[label];
      if (intent && !hits.includes(intent)) hits.push(intent);
      keywordSpotter.reset(stream);
    }
  }
  send({
    type: "analysis.result",
    requestId: message.requestId,
    intent: hits.length === 1 ? hits[0] : hits.length > 1 ? "ambiguous" : "unknown",
  });
}

process.on("message", (message) => {
  try {
    if (!message || typeof message !== "object") return;
    if (message.type === "initialize") initialize(message);
    else if (message.type === "analyze") analyze(message);
    else if (message.type === "stop") process.exit(0);
  } catch (error) {
    send({
      type: "analysis.result",
      requestId: message?.requestId ?? null,
      intent: "unknown",
      reasonCode: typeof error?.message === "string" ? error.message : "local-voice-confirmation-failed",
    });
  }
});

process.on("disconnect", () => process.exit(0));
