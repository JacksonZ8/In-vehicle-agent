"use strict";

const sherpaOnnx = require("sherpa-onnx-node");

let active = false;
let keywordSpotter = null;
let mode = "wake";
let stream = null;

function send(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

function fail(reasonCode) {
  send({ type: "error", reasonCode });
}

function resetStream() {
  stream = keywordSpotter.createStream();
}

function initialize(message) {
  keywordSpotter = new sherpaOnnx.KeywordSpotter(message.config);
  mode = message.mode;
  resetStream();
  active = true;
  send({ type: "ready" });
}

function processFrame(message) {
  if (!active || !stream || !(message.frame instanceof Uint8Array)) {
    fail("local-voice-worker-not-ready");
    return;
  }
  const bytes = Buffer.from(message.frame.buffer, message.frame.byteOffset, message.frame.byteLength);
  if (bytes.byteLength !== 640) {
    fail("invalid-pcm-frame");
    return;
  }
  const samples = new Float32Array(320);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readInt16LE(index * 2) / 32768;
  }
  if (mode === "wake") {
    stream.acceptWaveform({ sampleRate: 16_000, samples });
    while (keywordSpotter.isReady(stream)) {
      keywordSpotter.decode(stream);
      const keyword = keywordSpotter.getResult(stream)?.keyword || "";
      if (keyword === "NOMI" || keyword === "嗨_NOMI") {
        send({
          type: "wake.detected",
          phrase: keyword === "NOMI" ? "NOMI" : "嗨，NOMI",
        });
        keywordSpotter.reset(stream);
      }
    }
  }
  send({ type: "frame.processed" });
}

process.on("message", (message) => {
  try {
    if (!message || typeof message !== "object") return;
    if (message.type === "initialize") initialize(message);
    else if (message.type === "frame") processFrame(message);
    else if (message.type === "mode.set") {
      mode = message.mode;
      if (keywordSpotter) resetStream();
    } else if (message.type === "stop") process.exit(0);
  } catch {
    fail("local-voice-inference-failed");
  }
});

process.on("disconnect", () => process.exit(0));
