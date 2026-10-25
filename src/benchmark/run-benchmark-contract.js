import { B4_BENCHMARK_SCENARIOS } from "./run-benchmark-scenarios.js";
import {
  expectedProfileSampleKeys,
  validateFinalBenchmarkSample,
} from "./run-benchmark-sample-contract.js";
import { evaluateBenchmarkMedianLatencyContract } from "./run-metric-projector.js";

export const RUN_BENCHMARK_REPORT = Object.freeze({
  id: "nio-run-benchmark-report",
  version: "1.0.0",
});

export const RUN_BENCHMARK_SUITE = Object.freeze({
  id: "nio-b4-benchmark-suite",
  version: "1.0.0",
});

const ALL_SCENARIO_IDS = Object.freeze(Object.keys(B4_BENCHMARK_SCENARIOS));
const FAULT_MATRIX_SCENARIO_IDS = Object.freeze([
  "conversation-general", "weather-readonly", "vehicle-knowledge", "vehicle-control-safe",
]);
const VOICE_SUBSET_SCENARIO_IDS = Object.freeze([
  "conversation-general", "weather-readonly", "vehicle-knowledge", "vehicle-control-safe",
]);

function profile(scenarioIds, repeats, { performanceGate = false } = {}) {
  return Object.freeze({
    scenarioIds: Object.freeze([...scenarioIds]),
    repeats,
    performanceGate,
  });
}

export const BENCHMARK_PROFILES = Object.freeze({
  "functional-smoke": profile(ALL_SCENARIO_IDS, 1),
  "warm-baseline": profile(ALL_SCENARIO_IDS, 3, { performanceGate: true }),
  "cold-diagnostic": profile(["conversation-general", "vehicle-knowledge"], 1),
  "stability-faults": profile(FAULT_MATRIX_SCENARIO_IDS, 1),
  "voice-browser": profile(VOICE_SUBSET_SCENARIO_IDS, 1),
});

function sameContract(value, expected) {
  return value?.id === expected.id && value?.version === expected.version;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

const REPORT_OUTCOMES = Object.freeze([
  "passed", "passed-with-warning", "contract-failed", "harness-error", "blocked",
]);
const PASSING_REPORT_OUTCOMES = new Set(["passed", "passed-with-warning"]);
const SENSITIVE_FIELD_PATTERN = /prompt|raw.?model|model.?output|chain.?of.?thought|authorization|secret|credential|token|api.?key|cwd|username/i;
const REPORT_KEYS = Object.freeze([
  "protocol", "suite", "reportId", "profile", "generatedAt", "environment", "samples",
  "summary", "behaviorGate", "outcome", "metrics", "scenarios", "comparison",
]);
const CONTRACT_KEYS = Object.freeze(["id", "version"]);
const SUMMARY_KEYS = Object.freeze(["sampleCount", "passedSamples", "failedSamples"]);
const BEHAVIOR_GATE_KEYS = Object.freeze(["outcome", "scenarioIds"]);
const REPORT_METRIC_KEYS = Object.freeze(["durationMs", "modelRequests"]);
const METRIC_SUMMARY_KEYS = Object.freeze(["count", "min", "median", "max", "p95"]);
const SCENARIO_SUMMARY_KEYS = Object.freeze([
  "scenarioId", "count", "durationMs", "slowestPhase", "behaviorOutcome", "degradedReasons",
]);
const SLOWEST_PHASE_KEYS = Object.freeze(["phaseId", "durationMs"]);
const ENVIRONMENT_KEYS = Object.freeze([
  "commitSha", "dirtyWorktree", "platform", "arch", "osRelease", "cpuModel", "profile",
  "modelIds", "providerIds", "regionIds", "timeoutConfig", "serviceConfig", "serviceReadiness", "coldStartProof",
]);
const TIMEOUT_CONFIG_KEYS = Object.freeze(["phaseTimeoutMs", "transportTimeoutMs", "scenarioTimeoutMs"]);
const SERVICE_CONFIG_KEYS = Object.freeze(["requiredServiceIds", "readinessTimeoutMs"]);
const SERVICE_READINESS_KEYS = Object.freeze(["serviceId", "status", "checkedAt"]);
const COLD_START_PROOF_KEYS = Object.freeze(["status", "verifiedAt", "serviceIds"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function hasExactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

function hasTimeoutConfig(value) {
  return isRecord(value)
    && hasExactKeys(value, TIMEOUT_CONFIG_KEYS)
    && Object.values(value).every((entry) => Number.isFinite(entry) && entry > 0);
}

function hasServiceConfig(value) {
  return hasExactKeys(value, SERVICE_CONFIG_KEYS)
    && isStringArray(value.requiredServiceIds)
    && Number.isFinite(value.readinessTimeoutMs)
    && value.readinessTimeoutMs > 0;
}

function hasEnvironmentNestedMetadata(environment) {
  return isRecord(environment)
    && hasTimeoutConfig(environment.timeoutConfig)
    && hasServiceConfig(environment.serviceConfig)
    && hasServiceReadiness(environment.serviceReadiness)
    && hasColdStartProof(environment.coldStartProof);
}

function hasRequiredEnvironmentMetadata(environment) {
  return isRecord(environment)
    && Object.keys(environment).length === ENVIRONMENT_KEYS.length
    && Object.keys(environment).every((key) => ENVIRONMENT_KEYS.includes(key))
    && isNonEmptyString(environment.commitSha)
    && typeof environment.dirtyWorktree === "boolean"
    && isNonEmptyString(environment.osRelease)
    && isNonEmptyString(environment.cpuModel)
    && Object.hasOwn(BENCHMARK_PROFILES, environment.profile)
    && isStringArray(environment.providerIds)
    && isStringArray(environment.modelIds)
    && isStringArray(environment.regionIds)
    && isNonEmptyString(environment.platform)
    && isNonEmptyString(environment.arch)
    && hasEnvironmentNestedMetadata(environment);
}

function hasServiceReadiness(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isRecord(entry)
    && hasExactKeys(entry, SERVICE_READINESS_KEYS)
    && isNonEmptyString(entry.serviceId)
    && ["ready", "blocked", "unavailable"].includes(entry.status)
    && isIsoTimestamp(entry.checkedAt));
}

function hasColdStartProof(value) {
  if (!hasExactKeys(value, COLD_START_PROOF_KEYS) || !["observed", "unverified", "not-applicable"].includes(value.status)) return false;
  if (value.status === "observed") {
    return isIsoTimestamp(value.verifiedAt) && isStringArray(value.serviceIds);
  }
  if (value.status === "unverified") {
    return value.verifiedAt === null && Array.isArray(value.serviceIds)
      && value.serviceIds.every(isNonEmptyString);
  }
  return value.verifiedAt === null && Array.isArray(value.serviceIds) && value.serviceIds.length === 0;
}

function hasMetricSummary(value) {
  if (!hasExactKeys(value, METRIC_SUMMARY_KEYS)
    || !Number.isSafeInteger(value.count)
    || value.count < 0) return false;
  if (value.count === 0) {
    return [value.min, value.median, value.max, value.p95].every((entry) => entry === null);
  }
  if (![value.min, value.median, value.max].every((entry) => Number.isFinite(entry) && entry >= 0)
    || value.min > value.median
    || value.median > value.max) return false;
  return value.p95 === null || (Number.isFinite(value.p95) && value.p95 >= value.min && value.p95 <= value.max);
}

function hasReportMetrics(value) {
  return hasExactKeys(value, REPORT_METRIC_KEYS)
    && hasMetricSummary(value.durationMs)
    && hasMetricSummary(value.modelRequests);
}

function summarizeModelRequests(samples) {
  if (!Array.isArray(samples)) return null;
  const values = samples.map((sample) => sample?.metrics?.modelRequests);
  if (values.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) return null;
  const sorted = values.filter((value) => value !== null).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, min: null, median: null, max: null, p95: null };
  }
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    min: sorted[0],
    median: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
    max: sorted.at(-1),
    p95: sorted.length < 20 ? null : sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function sameMetricSummary(value, expected) {
  return expected !== null
    && hasExactKeys(value, METRIC_SUMMARY_KEYS)
    && METRIC_SUMMARY_KEYS.every((key) => value[key] === expected[key]);
}

function completeMedian(values) {
  if (!Array.isArray(values)
    || values.length === 0
    || values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function benchmarkPerformanceGateErrors({ profile, samples } = {}) {
  const benchmarkProfile = BENCHMARK_PROFILES[profile];
  if (benchmarkProfile?.performanceGate !== true || !Array.isArray(samples)) return [];
  return benchmarkProfile.scenarioIds.flatMap((scenarioId) => {
    const matching = samples.filter((sample) => sample?.scenarioId === scenarioId);
    if (matching.length < 3) return [];
    return evaluateBenchmarkMedianLatencyContract({
      contractId: scenarioId,
      submissionToFirstFeedbackMedianMs: completeMedian(matching.map(
        (sample) => sample?.projectedMetrics?.submissionToFirstFeedbackMs,
      )),
      submissionToResultVisibleMedianMs: completeMedian(matching.map(
        (sample) => sample?.projectedMetrics?.submissionToResultVisibleMs,
      )),
    }).map((error) => `${scenarioId}: ${error}`);
  });
}

function hasScenarioSummaries(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => {
    if (!hasExactKeys(entry, SCENARIO_SUMMARY_KEYS)
      || !Object.hasOwn(B4_BENCHMARK_SCENARIOS, entry.scenarioId)
      || !Number.isSafeInteger(entry.count)
      || entry.count < 1
      || !hasMetricSummary(entry.durationMs)
      || !["answered", "executed", "blocked", "clarification", "mixed"].includes(entry.behaviorOutcome)
      || !Array.isArray(entry.degradedReasons)
      || entry.degradedReasons.some((reason) => !isNonEmptyString(reason))) return false;
    return entry.slowestPhase === null
      || (hasExactKeys(entry.slowestPhase, SLOWEST_PHASE_KEYS)
        && isNonEmptyString(entry.slowestPhase.phaseId)
        && Number.isFinite(entry.slowestPhase.durationMs)
        && entry.slowestPhase.durationMs >= 0);
  });
}

function hasComparison(value) {
  if (!isRecord(value) || !isNonEmptyString(value.status)) return false;
  if (["not-compared", "blocked-environment-mismatch", "blocked-insufficient-metrics"].includes(value.status)) {
    return hasExactKeys(value, ["status"]);
  }
  return ["passed", "regression-warning"].includes(value.status)
    && hasExactKeys(value, ["status", "baselineMedian", "candidateMedian", "ratio", "warningRatio"])
    && [value.baselineMedian, value.candidateMedian, value.ratio, value.warningRatio]
      .every((entry) => Number.isFinite(entry));
}

function containsSensitiveField(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, nested]) => SENSITIVE_FIELD_PATTERN.test(key)
    || containsSensitiveField(nested, seen));
}

export function validateBenchmarkReport(report) {
  const errors = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return ["report must be an object"];
  }
  if (!hasExactKeys(report, REPORT_KEYS)) {
    errors.push("report must contain exactly the allowed canonical fields");
  }
  if (!sameContract(report.protocol, RUN_BENCHMARK_REPORT)) {
    errors.push("protocol must equal RUN_BENCHMARK_REPORT");
  }
  if (isRecord(report.protocol) && !hasExactKeys(report.protocol, CONTRACT_KEYS)) {
    errors.push("protocol must contain exactly id and version");
  }
  if (!sameContract(report.suite, RUN_BENCHMARK_SUITE)) {
    errors.push("suite must equal RUN_BENCHMARK_SUITE");
  }
  if (isRecord(report.suite) && !hasExactKeys(report.suite, CONTRACT_KEYS)) {
    errors.push("suite must contain exactly id and version");
  }
  if (!isNonEmptyString(report.reportId)) errors.push("reportId must be a non-empty string");
  if (!Object.hasOwn(BENCHMARK_PROFILES, report.profile)) errors.push("profile must name a benchmark profile");
  if (!isIsoTimestamp(report.generatedAt)) {
    errors.push("generatedAt must be an ISO-8601 timestamp");
  }
  if (!hasRequiredEnvironmentMetadata(report.environment)) {
    errors.push("environment must contain the required execution metadata");
  }
  if (isRecord(report.environment) && !Object.keys(report.environment).every((key) => ENVIRONMENT_KEYS.includes(key))) {
    errors.push("environment must contain only allowed execution metadata");
  }
  if (isRecord(report.environment) && !hasEnvironmentNestedMetadata(report.environment)) {
    errors.push("environment nested metadata must contain only allowed fields");
  }
  if (Object.hasOwn(report, "serviceReadiness")) {
    errors.push("serviceReadiness must be stored only in environment");
  }
  if (Object.hasOwn(report, "coldStartProof")) {
    errors.push("coldStartProof must be stored only in environment");
  }
  if (report.environment?.profile && report.environment.profile !== report.profile) {
    errors.push("environment profile must match report profile");
  }
  if (report.profile === "cold-diagnostic" && report.environment?.coldStartProof?.status === "not-applicable") {
    errors.push("cold-diagnostic reports require cold-start evidence or an explicit unverified result");
  }
  if (report.profile !== "cold-diagnostic" && report.environment?.coldStartProof?.status !== "not-applicable") {
    errors.push("non-cold profiles must use a not-applicable cold-start proof");
  }
  if (!Array.isArray(report.samples) || report.samples.length === 0) {
    errors.push("samples must contain at least one valid benchmark sample");
  } else {
    const sampleErrors = report.samples.flatMap((sample, index) => validateFinalBenchmarkSample(sample, {
      profile: report.profile,
    }).map((error) => `sample ${index}: ${error}`));
    if (sampleErrors.length > 0) {
      errors.push("samples must contain valid benchmark samples");
      errors.push(...sampleErrors);
    }
  }
  if (!hasValidSummary(report.summary, report.samples)) {
    errors.push("summary must match the benchmark sample outcomes");
  }
  if (!hasValidBehaviorGate(report.behaviorGate)) {
    errors.push("behaviorGate must contain an allowed outcome and scenario coverage");
  }
  if (!hasReportMetrics(report.metrics)) {
    errors.push("metrics must contain exact canonical benchmark summaries");
  }
  const expectedModelRequests = summarizeModelRequests(report.samples);
  if (expectedModelRequests !== null
    && !sameMetricSummary(report.metrics?.modelRequests, expectedModelRequests)) {
    errors.push("metrics.modelRequests must exactly summarize non-null canonical sample counts");
  }
  if (!hasScenarioSummaries(report.scenarios)) {
    errors.push("scenarios must contain exact canonical scenario summaries");
  }
  if (!hasComparison(report.comparison)) {
    errors.push("comparison must contain an exact canonical comparison result");
  }
  if (!REPORT_OUTCOMES.includes(report.outcome)) errors.push("outcome must be a supported report outcome");
  const performanceGateErrors = benchmarkPerformanceGateErrors({
    profile: report.profile,
    samples: report.samples,
  });
  if (performanceGateErrors.length > 0
    && (PASSING_REPORT_OUTCOMES.has(report.outcome) || report.behaviorGate?.outcome === "passed")) {
    errors.push("warm performance median violations require non-passing report and gate outcomes");
  }
  if (PASSING_REPORT_OUTCOMES.has(report.outcome)) validatePassedReport(report, errors);
  if (REPORT_OUTCOMES.includes(report.outcome)
    && !PASSING_REPORT_OUTCOMES.has(report.outcome)
    && report.behaviorGate?.outcome === "passed") {
    errors.push("non-passing reports must not have a passed behaviorGate");
  }
  if (containsSensitiveField(report)) errors.push("report must not contain sensitive fields");
  return errors;
}

function hasValidSummary(summary, samples) {
  if (!hasExactKeys(summary, SUMMARY_KEYS) || !Array.isArray(samples)) return false;
  const passedSamples = samples.filter((sample) => sample?.outcome === "passed").length;
  return Number.isInteger(summary.sampleCount)
    && summary.sampleCount === samples.length
    && Number.isInteger(summary.passedSamples)
    && summary.passedSamples === passedSamples
    && Number.isInteger(summary.failedSamples)
    && summary.failedSamples === samples.length - passedSamples;
}

function hasValidBehaviorGate(behaviorGate) {
  return hasExactKeys(behaviorGate, BEHAVIOR_GATE_KEYS)
    && REPORT_OUTCOMES.includes(behaviorGate.outcome)
    && isStringArray(behaviorGate.scenarioIds)
    && behaviorGate.scenarioIds.every((scenarioId) => Object.hasOwn(B4_BENCHMARK_SCENARIOS, scenarioId));
}

function validatePassedReport(report, errors) {
  const profile = BENCHMARK_PROFILES[report.profile];
  if (!profile || !Array.isArray(report.samples)) return;
  const expectedSampleKeys = expectedProfileSampleKeys(report.profile, profile);
  const actualCounts = new Map();
  const sampleIdCounts = new Map();
  for (const sample of report.samples) {
    const canonicalId = `${sample?.scenarioId}:${sample?.repeat}`;
    actualCounts.set(canonicalId, (actualCounts.get(canonicalId) || 0) + 1);
    sampleIdCounts.set(sample?.sampleId, (sampleIdCounts.get(sample?.sampleId) || 0) + 1);
  }
  const exactMultiset = Array.isArray(expectedSampleKeys)
    && report.samples.length === expectedSampleKeys.length
    && report.samples.every((sample) => sample?.outcome === "passed")
    && expectedSampleKeys.every((key) => actualCounts.get(key) === 1)
    && [...actualCounts.keys()].every((key) => expectedSampleKeys.includes(key))
    && [...sampleIdCounts.values()].every((value) => value === 1);
  if (!exactMultiset) {
    errors.push("passed reports must contain a passed sample for every profile scenario repeat");
    errors.push("passed reports must contain exactly the planned sample multiset without duplicates or extras");
  }
  const behaviorGateScenarioIds = new Set(report.behaviorGate?.scenarioIds || []);
  if (report.behaviorGate?.outcome !== "passed"
    || behaviorGateScenarioIds.size !== profile.scenarioIds.length
    || report.behaviorGate?.scenarioIds?.length !== profile.scenarioIds.length
    || profile.scenarioIds.some((scenarioId) => !behaviorGateScenarioIds.has(scenarioId))) {
    errors.push("passed behaviorGate must cover every profile scenario");
  }
  const readiness = report.environment?.serviceReadiness || [];
  if ((report.environment?.serviceConfig?.requiredServiceIds || []).some((serviceId) => {
    const observations = readiness.filter((entry) => entry.serviceId === serviceId);
    return observations.length === 0 || observations.some((entry) => entry.status !== "ready");
  })) {
    errors.push("passing reports require every required service to be ready");
  }
}
