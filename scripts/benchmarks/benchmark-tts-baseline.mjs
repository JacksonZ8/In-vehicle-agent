import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const singleRun = process.env.NIO_TTS_BENCHMARK_MODE === "single";
const textCases = [
  { label: "short", text: "您好，尾门开启前请确认后方空间安全。" },
  { label: "medium", text: "您好，尾门开启前请确认后方没有人员和障碍物。车辆必须处于静止状态并挂入 P 挡，确认安全后再继续操作。" },
  { label: "long", text: "您好，下面是一段用于本地语音基线测试的说明。尾门开启前，请确认车辆已经静止并处于 P 挡，同时确认后方和周边没有人员、宠物或障碍物。若环境不确定，请先查看周围情况，再决定是否继续操作。本测试只记录代理总耗时、上游响应读取耗时和音频字节数，不把任何网络响应时间伪装成首帧音频时间。" },
];

function telemetryHeaders(headers) {
  const names = [
    "x-nio-tts-proxy-total-ms",
    "x-nio-tts-upstream-first-response-ms",
    "x-nio-tts-upstream-complete-read-ms",
    "x-nio-tts-audio-bytes",
    "x-nio-tts-status",
    "x-nio-tts-streaming-mode",
    "x-nio-tts-upstream-status",
    "x-nio-tts-profile-id",
    "x-nio-tts-profile-version",
    "x-nio-tts-synthesis-profile-id",
    "x-nio-tts-license-boundary",
  ];
  return Object.fromEntries(names.map((name) => [name, headers.get(name) || "unavailable"]));
}

function readWavDuration(buffer) {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + size > buffer.length) return null;
    if (id === "fmt " && size >= 16) byteRate = buffer.readUInt32LE(dataOffset + 8);
    if (id === "data") dataSize = size;
    offset = dataOffset + size + (size % 2);
  }
  return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
}

async function runCase(item, temperatureState) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: item.text }),
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const wallTimeMs = Math.round(performance.now() - startedAt);
  const contentType = response.headers.get("content-type") || "";
  const wavDurationSeconds = contentType.includes("audio") ? readWavDuration(bytes) : null;
  return buildTtsBenchmarkResult({
    item,
    temperatureState,
    response,
    bytes,
    wallTimeMs,
    wavDurationSeconds,
  });
}

export function buildTtsBenchmarkResult({
  item,
  temperatureState,
  response,
  bytes,
  wallTimeMs,
  wavDurationSeconds,
}) {
  const contentType = response.headers.get("content-type") || "";
  return {
    label: item.label,
    temperatureState,
    status: response.status,
    ok: response.ok,
    reason: response.ok ? "tts-response-ok" : "tts-response-failed",
    contentType,
    wallTimeMs,
    responseTelemetry: telemetryHeaders(response.headers),
    audioBytes: bytes.length,
    wavDurationSeconds: wavDurationSeconds == null ? "unavailable" : Number(wavDurationSeconds.toFixed(3)),
    rtf: wavDurationSeconds == null ? "unavailable" : Number((wallTimeMs / 1000 / wavDurationSeconds).toFixed(3)),
  };
}

async function main() {
  const cases = singleRun
    ? [{ ...textCases[0], temperatureState: "uncontrolled-single-request" }]
    : textCases.flatMap((item) => [
      { ...item, temperatureState: "cold-uncontrolled-no-service-restart" },
      { ...item, temperatureState: "hot-uncontrolled-after-prior-request" },
    ]);
  const results = [];
  for (const item of cases) results.push(await runCase(item, item.temperatureState));
  console.log(JSON.stringify({ baseUrl, mode: singleRun ? "single" : "full", note: "TTFA is unavailable: this proxy buffers the complete upstream audio response before returning it.", results }, null, 2));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(`benchmark-tts-baseline failed: ${error.message}`);
    process.exitCode = 1;
  });
}
