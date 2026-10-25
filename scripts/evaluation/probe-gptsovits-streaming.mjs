import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGptSoVitsPayload,
  parseTtsBoundedInteger,
  parseTtsBoundedNumber,
  parseTtsStrictBoolean,
  parseTtsStreamingMode,
  resolveTtsSynthesisProfile,
} from "../../src/voice/tts-profile-loader.mjs";

function readProbeModeArgument(argv = process.argv.slice(2)) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--streaming-mode=")) return argument.slice("--streaming-mode=".length);
    if (argument === "--streaming-mode") {
      if (argv[index + 1] === undefined) throw new Error("--streaming-mode requires a boolean or integer 0..3 value");
      return argv[index + 1];
    }
  }
  return undefined;
}

function readProbeArgument(name, argv = process.argv.slice(2)) {
  const inlinePrefix = `--${name}=`;
  const flag = `--${name}`;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith(inlinePrefix)) return argument.slice(inlinePrefix.length);
    if (argument === flag) {
      if (argv[index + 1] === undefined) throw new Error(`${flag} requires a value`);
      return argv[index + 1];
    }
  }
  return undefined;
}

export function resolveProbeStreamingMode({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const argumentValue = readProbeModeArgument(argv);
  const environmentValue = env.NIO_TTS_PROBE_STREAMING_MODE;
  // Keep the old probe-only default (`streamingMode: true`) as mode 1. This
  // does not alter the 4173 TTS profile or production endpoint defaults.
  return parseTtsStreamingMode(argumentValue ?? environmentValue, true);
}

// These explicit bounds keep direct protocol experiments finite and fail-fast.
// They are probe-only and intentionally do not alter persisted HMI/profile defaults.
export function resolveProbeStreamingTuning({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const minChunkLengthValue = readProbeArgument("min-chunk-length", argv) ?? env.NIO_TTS_PROBE_MIN_CHUNK_LENGTH;
  const fragmentIntervalValue = readProbeArgument("fragment-interval", argv) ?? env.NIO_TTS_PROBE_FRAGMENT_INTERVAL;
  const parallelInferValue = readProbeArgument("parallel-infer", argv) ?? env.NIO_TTS_PROBE_PARALLEL_INFER;
  return {
    minChunkLength: minChunkLengthValue === undefined
      ? undefined
      : parseTtsBoundedInteger(minChunkLengthValue, { name: "GPT-SoVITS min_chunk_length", min: 1, max: 1000 }),
    fragmentInterval: fragmentIntervalValue === undefined
      ? undefined
      : parseTtsBoundedNumber(fragmentIntervalValue, { name: "GPT-SoVITS fragment_interval", min: 0, max: 60 }),
    parallelInfer: parallelInferValue === undefined
      ? undefined
      : parseTtsStrictBoolean(parallelInferValue, { name: "GPT-SoVITS parallel_infer" }),
  };
}

export function buildProbePayload({ env = process.env, argv = process.argv.slice(2), profile = resolveTtsSynthesisProfile({ env }) } = {}) {
  const streamingMode = resolveProbeStreamingMode({ env, argv });
  const tuning = resolveProbeStreamingTuning({ env, argv });
  return buildGptSoVitsPayload(env.NIO_TTS_PROBE_TEXT || "这是一条本地语音协议探测短句。", {
    ...profile,
    synthesis: { ...profile.synthesis, streamingMode, ...tuning },
  });
}

function detectFormat(bytes) {
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") return "mp3";
  return "unrecognized";
}

export async function runProbe({
  env = process.env,
  argv = process.argv.slice(2),
  endpoint = env.NIO_GPT_SOVITS_ENDPOINT || "http://127.0.0.1:9880/tts",
  fetchImpl = fetch,
} = {}) {
  const profile = resolveTtsSynthesisProfile({ env });
  const payload = buildProbePayload({ env, argv, profile });
  const startedAt = performance.now();
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const firstResponseHeadersMs = Math.round(performance.now() - startedAt);
  const reader = response.body?.getReader();
  const chunks = [];
  let firstBodyChunkMs = null;
  let totalBytes = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstBodyChunkMs === null) firstBodyChunkMs = Math.round(performance.now() - startedAt);
      chunks.push(Buffer.from(value));
      totalBytes += value.byteLength;
    }
  }
  const completeResponseMs = Math.round(performance.now() - startedAt);
  const bytes = Buffer.concat(chunks);
  const report = {
    endpoint,
    request: {
      profileId: profile.profileId,
      synthesisProfileId: profile.synthesis.profileId,
      licenseBoundary: profile.licenseBoundary,
      media_type: payload.media_type,
      streaming_mode: payload.streaming_mode,
      min_chunk_length: payload.min_chunk_length ?? null,
      fragment_interval: payload.fragment_interval ?? null,
      parallel_infer: payload.parallel_infer ?? null,
      textChars: payload.text.length,
    },
    httpStatus: response.status,
    contentType: response.headers.get("content-type") || "unavailable",
    contentLength: response.headers.get("content-length") || "unavailable",
    firstResponseHeadersMs,
    firstBodyChunkMs: firstBodyChunkMs ?? "unavailable",
    completeResponseMs,
    responseBytes: totalBytes,
    detectedFormat: detectFormat(bytes),
    interpretation: "首响应头和首 body chunk 仅是 HTTP 传输观测，不是 TTFA；除非协议能证明分段音频可播放，否则不能据此声称流式首音频。",
    failureBody: response.ok ? undefined : bytes.toString("utf8", 0, 500),
  };
  return report;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  runProbe().then((report) => {
    console.log(JSON.stringify(report, null, 2));
  }).catch((error) => {
    console.error(`probe-gptsovits-streaming failed: ${error.message}`);
    process.exitCode = 1;
  });
}
