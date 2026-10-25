import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const endpoint = process.env.NIO_AGENT_ENDPOINT || "http://127.0.0.1:4173";
const repeats = Math.max(3, Number(process.env.NIO_COMPACT_AB_REPEATS || 3));
const rawText = process.env.NIO_COMPACT_AB_TEXT || "露营前需要注意什么？";

function percentile(values, p) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1);
  return ordered[index];
}

function stableTextDigest(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

export function buildCompactBenchmarkSample({ body, wallMs }) {
  const summary = String(body.summary || "").trim();
  if (body.telemetry?.degraded || !summary) {
    throw new Error("compact benchmark produced degraded or empty output");
  }
  const lines = summary.split(/\r?\n/);
  const sentenceCount = summary.split(/[.!?。！？]+/u).filter((item) => item.trim()).length;
  return {
    wallMs,
    durationMs: body.telemetry?.durationMs,
    promptChars: body.telemetry?.promptChars,
    promptEvalMs: body.telemetry?.ollamaDurations?.prompt_eval_duration_ms,
    evalMs: body.telemetry?.ollamaDurations?.eval_duration_ms,
    evalCount: body.telemetry?.ollamaDurations?.eval_count,
    mode: body.telemetry?.conversationOutputMode,
    outputBudget: body.telemetry?.conversationOutputBudget,
    summaryChars: summary.length,
    summarySha256: stableTextDigest(summary),
    lineCount: lines.length,
    sentenceCount,
    singleParagraph: lines.length === 1,
  };
}

async function run(compact) {
  const samples = [];
  for (let index = 0; index < repeats; index += 1) {
    const startedAt = performance.now();
    const response = await fetch(`${endpoint}/api/local-llm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "conversation_general",
        rawText,
        parsedCommand: { rawText, intent: "conversation.general", slots: { topic: "general_qa" } },
        manualEvidence: [],
        conversationCompactOutput: compact,
      }),
    });
    if (!response.ok) throw new Error(`${compact ? "compact" : "standard"} HTTP ${response.status}`);
    const body = await response.json();
    samples.push(buildCompactBenchmarkSample({
      body,
      wallMs: Math.round(performance.now() - startedAt),
    }));
  }
  const metric = (key) => samples.map((item) => Number(item[key])).filter(Number.isFinite);
  return {
    samples,
    p50WallMs: percentile(metric("wallMs"), 0.5),
    p95WallMs: percentile(metric("wallMs"), 0.95),
    p50DurationMs: percentile(metric("durationMs"), 0.5),
    p95DurationMs: percentile(metric("durationMs"), 0.95),
  };
}

export function buildCompactBenchmarkReport({
  endpoint: reportEndpoint,
  repeats: reportRepeats,
  rawText: reportInput,
  standard,
  compact,
}) {
  return {
    endpoint: reportEndpoint,
    repeats: reportRepeats,
    inputChars: String(reportInput || "").length,
    inputSha256: stableTextDigest(reportInput),
    standard,
    compact,
    p50WallMsDelta: compact.p50WallMs - standard.p50WallMs,
    p95WallMsDelta: compact.p95WallMs - standard.p95WallMs,
    note: "A negative delta is faster. Compare length, stable digest and structural fields; this report intentionally omits raw input and model output.",
  };
}

async function main() {
  const standard = await run(false);
  const compact = await run(true);
  console.log(JSON.stringify(buildCompactBenchmarkReport({
    endpoint,
    repeats,
    rawText,
    standard,
    compact,
  }), null, 2));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(`benchmark-conversation-compact-output failed: ${error.message}`);
    process.exitCode = 1;
  });
}
