"use strict";

const sherpaOnnx = require("sherpa-onnx-node");

let extractor = null;
let config = null;

function send(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

function createVad() {
  return new sherpaOnnx.Vad({
    sileroVad: {
      model: config.vadModelPath,
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.3,
      windowSize: 512,
      maxSpeechDuration: 8,
    },
    sampleRate: config.sampleRate,
    numThreads: 1,
    debug: false,
    provider: "cpu",
  }, 10);
}

function decodePcm16(frame) {
  if (!(frame instanceof Uint8Array) || frame.byteLength % 2 !== 0) {
    throw new TypeError("invalid-pcm-payload");
  }
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  let clippedSamples = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = bytes.readInt16LE(index * 2);
    if (Math.abs(value) >= 32_760) clippedSamples += 1;
    samples[index] = value / 32_768;
  }
  return { samples, clippedSamples };
}

function detectSpeechSamples(samples) {
  const vad = createVad();
  const windowSize = vad.config.sileroVad.windowSize;
  for (let offset = 0; offset < samples.length; offset += windowSize) {
    const remaining = samples.length - offset;
    if (remaining >= windowSize) {
      vad.acceptWaveform(samples.subarray(offset, offset + windowSize));
      continue;
    }
    const padded = new Float32Array(windowSize);
    padded.set(samples.subarray(offset));
    vad.acceptWaveform(padded);
  }
  vad.flush();
  let speechSamples = 0;
  while (!vad.isEmpty()) {
    speechSamples += vad.front().samples.length;
    vad.pop();
  }
  return Math.min(samples.length, speechSamples);
}

function analyze(message) {
  if (!extractor || !config) throw new Error("local-speaker-worker-not-ready");
  const { samples, clippedSamples } = decodePcm16(message.pcm);
  const durationMs = Math.round(samples.length * 1000 / config.sampleRate);
  const quality = config.quality;
  let outcome = null;
  if (durationMs < quality.minimumDurationMs) outcome = "too-short";
  else if (durationMs > quality.maximumDurationMs) outcome = "too-long";

  const clippedSampleRatio = samples.length ? clippedSamples / samples.length : 1;
  if (!outcome && clippedSampleRatio > quality.maximumClippedSampleRatio) outcome = "clipped";

  const speechSamples = outcome ? 0 : detectSpeechSamples(samples);
  const speechRatio = samples.length ? speechSamples / samples.length : 0;
  if (!outcome && speechRatio < quality.minimumSpeechRatio) outcome = "insufficient-speech";

  if (outcome) {
    send({ type: "analysis.result", requestId: message.requestId, outcome });
    return;
  }

  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: config.sampleRate, samples });
  const embedding = extractor.compute(stream);
  if (!(embedding instanceof Float32Array)
    || embedding.length !== extractor.dim
    || !Array.from(embedding).every(Number.isFinite)) {
    throw new Error("local-speaker-embedding-failed");
  }
  send({
    type: "analysis.result",
    requestId: message.requestId,
    outcome: "accepted",
    embedding,
  });
}

process.on("message", (message) => {
  try {
    if (!message || typeof message !== "object") return;
    if (message.type === "initialize") {
      config = message.config;
      extractor = new sherpaOnnx.SpeakerEmbeddingExtractor({
        model: config.speakerModelPath,
        numThreads: 1,
        debug: false,
        provider: "cpu",
      });
      send({ type: "ready", embeddingDimension: extractor.dim });
    } else if (message.type === "analyze") analyze(message);
    else if (message.type === "stop") process.exit(0);
  } catch (error) {
    send({
      type: "analysis.error",
      requestId: message?.requestId ?? null,
      reasonCode: typeof error?.message === "string" && /^[a-z0-9-]{1,64}$/.test(error.message)
        ? error.message
        : "local-speaker-inference-failed",
    });
  }
});

process.on("disconnect", () => process.exit(0));
