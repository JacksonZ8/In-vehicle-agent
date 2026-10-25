import { B4_BENCHMARK_SCENARIOS } from "./run-benchmark-scenarios.js";
import * as nodeFs from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BENCHMARK_PROFILES,
  RUN_BENCHMARK_REPORT,
  RUN_BENCHMARK_SUITE,
  benchmarkPerformanceGateErrors,
  validateBenchmarkReport,
} from "./run-benchmark-contract.js";
import { finalBenchmarkSampleFromCheckpoint } from "./run-benchmark-sample-contract.js";

const SENSITIVE_FIELD_PATTERN = /prompt|raw.?model|model.?output|chain.?of.?thought|authorization|secret|credential|token|api.?key|cwd|username/i;

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function containsSensitiveField(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, nested]) => SENSITIVE_FIELD_PATTERN.test(key)
    || containsSensitiveField(nested, seen));
}

function numericValues(values) {
  if (!Array.isArray(values)
    || values.some((value) => value !== null && (!Number.isFinite(value) || value < 0))) {
    throw new TypeError("metric values must be finite non-negative numbers");
  }
  return values.filter((value) => value !== null).sort((left, right) => left - right);
}

export function summarizeMetric(values) {
  const sorted = numericValues(values);
  if (sorted.length === 0) return freeze({ count: 0, min: null, median: null, max: null, p95: null });
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return freeze({
    count: sorted.length,
    min: sorted[0],
    median,
    max: sorted.at(-1),
    p95: sorted.length < 20 ? null : sorted[Math.ceil(sorted.length * 0.95) - 1],
  });
}

function reportOutcome(samples, profile) {
  if (samples.some((sample) => sample.outcome === "contract-failed")) return "contract-failed";
  if (samples.some((sample) => sample.outcome === "run-failed")) return "harness-error";
  if (samples.some((sample) => sample.outcome === "run-degraded")) return "blocked";
  if (benchmarkPerformanceGateErrors({ profile, samples }).length > 0) return "contract-failed";
  return "passed";
}

function scenarioSummaries(samples) {
  const order = Object.keys(B4_BENCHMARK_SCENARIOS);
  return order.flatMap((scenarioId) => {
    const matching = samples.filter((sample) => sample.scenarioId === scenarioId);
    if (matching.length === 0) return [];
    const slowest = matching
      .map((sample) => sample.projectedMetrics?.slowestPhase)
      .filter((phase) => Number.isFinite(phase?.durationMs))
      .sort((left, right) => right.durationMs - left.durationMs)[0] || null;
    return [{
      scenarioId,
      count: matching.length,
      durationMs: summarizeMetric(matching.map((sample) => sample.metrics.durationMs)),
      slowestPhase: slowest ? { phaseId: slowest.phaseId, durationMs: slowest.durationMs } : null,
      behaviorOutcome: matching.map((sample) => sample.result.category).every((value) => value === matching[0].result.category)
        ? matching[0].result.category
        : "mixed",
      degradedReasons: matching.filter((sample) => sample.outcome === "run-degraded")
        .map((sample) => sample.diagnostics?.code).filter(Boolean),
    }];
  });
}

function mintReportId(idFactory) {
  const id = idFactory();
  if (typeof id !== "string" || !id.trim()) throw new TypeError("idFactory must return a non-empty report ID");
  return `benchmark-${id}`;
}

export function buildBenchmarkReport({ profile, environment, samples, generatedAt, idFactory = randomUUID } = {}) {
  if (containsSensitiveField(environment) || containsSensitiveField(samples)) {
    throw new TypeError("report inputs must not contain sensitive fields");
  }
  if (!BENCHMARK_PROFILES[profile]) throw new TypeError("profile must name a benchmark profile");
  if (!Array.isArray(samples)) throw new TypeError("samples must be an array");
  const canonicalSamples = samples.map((sample) => finalBenchmarkSampleFromCheckpoint(sample, { profile }))
    .sort((left, right) => {
      const scenarioOrder = Object.keys(B4_BENCHMARK_SCENARIOS);
      return scenarioOrder.indexOf(left.scenarioId) - scenarioOrder.indexOf(right.scenarioId) || left.repeat - right.repeat;
    });
  const outcome = reportOutcome(canonicalSamples, profile);
  const report = {
    protocol: clone(RUN_BENCHMARK_REPORT),
    suite: clone(RUN_BENCHMARK_SUITE),
    reportId: mintReportId(idFactory),
    profile,
    generatedAt,
    environment: clone(environment),
    samples: canonicalSamples,
    summary: {
      sampleCount: canonicalSamples.length,
      passedSamples: canonicalSamples.filter((sample) => sample.outcome === "passed").length,
      failedSamples: canonicalSamples.filter((sample) => sample.outcome !== "passed").length,
    },
    behaviorGate: {
      outcome: outcome === "passed" ? "passed" : outcome,
      scenarioIds: [...new Set(canonicalSamples.map((sample) => sample.scenarioId))],
    },
    outcome,
    metrics: {
      durationMs: summarizeMetric(canonicalSamples.map((sample) => sample.metrics.durationMs)),
      modelRequests: summarizeMetric(canonicalSamples.map((sample) => sample.metrics.modelRequests)),
    },
    scenarios: scenarioSummaries(canonicalSamples),
    comparison: { status: "not-compared" },
  };
  const errors = validateBenchmarkReport(report);
  if (errors.length > 0) throw new TypeError(`invalid benchmark report: ${errors.join("; ")}`);
  return freeze(report);
}

export function renderBenchmarkMarkdown(report) {
  const lines = [
    "# Benchmark report",
    "",
    `Outcome: ${report.outcome}`,
    "",
    "## Scenarios",
    "",
    "| scenario | count | min/median/max | slowest phase | behavior outcome | degraded reason |",
    "| --- | ---: | --- | --- | --- | --- |",
    ...report.scenarios.map((scenario) => `| ${scenario.scenarioId} | ${scenario.count} | ${scenario.durationMs.min}/${scenario.durationMs.median}/${scenario.durationMs.max} | ${scenario.slowestPhase ? `${scenario.slowestPhase.phaseId} (${scenario.slowestPhase.durationMs}ms)` : "none"} | ${scenario.behaviorOutcome} | ${scenario.degradedReasons.join(", ") || "none"} |`),
    "",
    "## Comparison",
    "",
    `comparison: ${report.comparison?.status || "not-compared"}`,
  ];
  return lines.join("\n");
}

function safeTemporaryDirectory(outputRoot, reportId, idFactory) {
  const token = idFactory();
  if (typeof token !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(token)) {
    throw new TypeError("idFactory must return a safe temporary ID");
  }
  return join(outputRoot, `.b4-${reportId}-${token}`);
}

function isOwnedTemporaryDirectory(outputRoot, directory, reportId) {
  const root = resolve(outputRoot);
  const temporary = resolve(directory);
  return temporary.startsWith(`${root}${sep}`)
    && temporary.slice(root.length + 1).startsWith(`.b4-${reportId}-`);
}

export function writeBenchmarkReport({ report, outputRoot, fs = nodeFs, idFactory = randomUUID } = {}) {
  if (!report || typeof report !== "object" || typeof report.reportId !== "string" || !report.reportId.trim()) {
    throw new TypeError("report must have a non-empty reportId");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(report.reportId)) {
    throw new TypeError("report must have a safe reportId");
  }
  if (typeof outputRoot !== "string" || !outputRoot.trim()) throw new TypeError("outputRoot must be a non-empty path");
  const errors = validateBenchmarkReport(report);
  if (errors.length > 0) throw new TypeError(`invalid benchmark report: ${errors.join("; ")}`);
  const directory = join(outputRoot, report.reportId);
  const json = JSON.stringify(report, null, 2);
  if (typeof json !== "string") throw new TypeError("report must serialize to JSON");
  const markdown = renderBenchmarkMarkdown(report);
  if (fs.existsSync(directory)) throw new Error("final report directory already exists");
  const temporaryDirectory = safeTemporaryDirectory(outputRoot, report.reportId, idFactory);
  let published = false;
  fs.mkdirSync(temporaryDirectory);
  const jsonPath = join(directory, "benchmark.json");
  const markdownPath = join(directory, "benchmark.md");
  try {
    fs.writeFileSync(join(temporaryDirectory, "benchmark.json"), `${json}\n`, { encoding: "utf8", flag: "wx" });
    fs.writeFileSync(join(temporaryDirectory, "benchmark.md"), markdown, { encoding: "utf8", flag: "wx" });
    if (fs.existsSync(directory)) throw new Error("final report directory already exists");
    fs.renameSync(temporaryDirectory, directory);
    published = true;
    return freeze({ directory, jsonPath, markdownPath });
  } finally {
    if (!published && isOwnedTemporaryDirectory(outputRoot, temporaryDirectory, report.reportId)) {
      try {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      } catch {
        // Preserve the original write or rename failure; cleanup only targets this invocation's directory.
      }
    }
  }
}
