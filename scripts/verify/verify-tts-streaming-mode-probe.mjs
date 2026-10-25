import assert from "node:assert/strict";
import { parseTtsStreamingMode } from "../../src/voice/tts-profile-loader.mjs";
import {
  buildProbePayload,
  resolveProbeStreamingTuning,
  resolveProbeStreamingMode,
  runProbe,
} from "../evaluation/probe-gptsovits-streaming.mjs";

assert.equal(parseTtsStreamingMode(false), 0);
assert.equal(parseTtsStreamingMode(true), 1);
assert.equal(parseTtsStreamingMode(0), 0);
assert.equal(parseTtsStreamingMode("2"), 2);
assert.equal(parseTtsStreamingMode(3), 3);
assert.throws(() => parseTtsStreamingMode("trueish"), /Invalid GPT-SoVITS streaming mode/);
assert.throws(() => parseTtsStreamingMode(4), /Invalid GPT-SoVITS streaming mode/);
assert.throws(() => parseTtsStreamingMode(-1), /Invalid GPT-SoVITS streaming mode/);
assert.equal(resolveProbeStreamingMode({ env: { NIO_TTS_PROBE_STREAMING_MODE: "2" }, argv: [] }), 2);
assert.equal(resolveProbeStreamingMode({ env: { NIO_TTS_PROBE_STREAMING_MODE: "1" }, argv: ["--streaming-mode=3"] }), 3);
assert.throws(() => resolveProbeStreamingMode({ env: {}, argv: ["--streaming-mode", "4"] }), /Invalid GPT-SoVITS streaming mode/);

const defaultTuningPayload = buildProbePayload({ env: { NIO_GPT_SOVITS_REF_AUDIO_PATH: "/tmp/test-reference.wav" }, argv: [] });
assert.equal("min_chunk_length" in defaultTuningPayload, false, "unset probe tuning must preserve GPT-SoVITS defaults");
assert.equal("fragment_interval" in defaultTuningPayload, false, "unset probe tuning must preserve GPT-SoVITS defaults");
assert.equal("parallel_infer" in defaultTuningPayload, false, "unset probe tuning must preserve GPT-SoVITS defaults");
assert.deepEqual(resolveProbeStreamingTuning({
  env: {
    NIO_TTS_PROBE_MIN_CHUNK_LENGTH: "12",
    NIO_TTS_PROBE_FRAGMENT_INTERVAL: "0.25",
    NIO_TTS_PROBE_PARALLEL_INFER: "false",
  },
  argv: [],
}), { minChunkLength: 12, fragmentInterval: 0.25, parallelInfer: false });
assert.deepEqual(resolveProbeStreamingTuning({
  env: { NIO_TTS_PROBE_MIN_CHUNK_LENGTH: "12" },
  argv: ["--min-chunk-length=16", "--fragment-interval", "0", "--parallel-infer", "true"],
}), { minChunkLength: 16, fragmentInterval: 0, parallelInfer: true });
assert.throws(() => resolveProbeStreamingTuning({ env: {}, argv: ["--min-chunk-length", "1.5"] }), /Expected an integer/);
assert.throws(() => resolveProbeStreamingTuning({ env: {}, argv: ["--fragment-interval", "-0.1"] }), /finite number/);
assert.throws(() => resolveProbeStreamingTuning({ env: {}, argv: ["--parallel-infer", "yes"] }), /Expected boolean/);

const probePayload = buildProbePayload({ env: { NIO_TTS_PROBE_STREAMING_MODE: "3", NIO_GPT_SOVITS_REF_AUDIO_PATH: "/tmp/test-reference.wav" }, argv: [] });
assert.equal(probePayload.streaming_mode, 3);

let receivedPayload;
const report = await runProbe({
  env: { NIO_GPT_SOVITS_REF_AUDIO_PATH: "/tmp/test-reference.wav" },
  argv: ["--streaming-mode", "3", "--min-chunk-length", "16", "--fragment-interval=0.25", "--parallel-infer", "true"],
  endpoint: "http://mock-gptsovits.invalid/tts",
  fetchImpl: async (_endpoint, request) => {
    receivedPayload = JSON.parse(request.body);
    return new Response(Buffer.from("RIFF0000WAVE"), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  },
});
assert.equal(report.request.streaming_mode, 3);
assert.equal(receivedPayload.streaming_mode, 3);
assert.equal(report.request.min_chunk_length, 16);
assert.equal(report.request.fragment_interval, 0.25);
assert.equal(report.request.parallel_infer, true);
assert.equal(receivedPayload.min_chunk_length, 16);
assert.equal(receivedPayload.fragment_interval, 0.25);
assert.equal(receivedPayload.parallel_infer, true);

console.log(JSON.stringify({
  streamingModeMapping: "false->0, true->1, integers 0..3",
  invalidValuesFailFast: true,
  selectedModeForwardedToMock: true,
  defaultTuningOmitted: true,
  streamingTuningForwardedToMock: true,
}, null, 2));
