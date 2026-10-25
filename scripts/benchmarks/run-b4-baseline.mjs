import { readFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  BENCHMARK_PROFILES,
  RUN_BENCHMARK_REPORT,
  RUN_BENCHMARK_SUITE,
} from "../../src/benchmark/run-benchmark-contract.js";
import {
  B4_BENCHMARK_SCENARIOS,
  getBenchmarkScenario,
} from "../../src/benchmark/run-benchmark-scenarios.js";
import { projectRunMetrics } from "../../src/benchmark/run-metric-projector.js";
import {
  buildBenchmarkReport,
  writeBenchmarkReport,
} from "../../src/benchmark/run-benchmark-report.js";
import { compareBenchmarkReports } from "../../src/benchmark/baseline-comparator.js";
import { calculateAcceptanceCallBudget } from "../lib/b3-b4-cloud-call-budget.mjs";
import { readBenchmarkEnvironment } from "../lib/b4-benchmark-environment.mjs";
import { createB4BrowserProbe } from "../lib/b4-browser-probe.mjs";
import {
  installVoicePlaybackProbe,
  isVoicePlaybackProviderObservation,
  observeVoicePlayback,
  recordVoiceSubmission,
} from "../lib/hmi-voice-benchmark-probe.mjs";
import { launchChromium } from "../lib/playwright-loader.mjs";
import {
  BENCHMARK_FAULT_PROFILE,
  verifyBenchmarkFaultReceipt,
} from "../../src/benchmark/benchmark-fault-profile.js";
import {
  B4_FAULT_SAMPLE_PLAN,
  canonicalizeCheckpointSample,
  isPublicBenchmarkReasonCode,
} from "../../src/benchmark/run-benchmark-sample-contract.js";
import { B3_B4_RUNTIME_CONTRACT_VERSION } from "../../src/runtime/runtime-contract-version.js";

const DEFAULT_OUTPUT_ROOT = "test-results/b4-benchmarks";
const DEFAULT_BASE_URL = "http://127.0.0.1:4173";
const WARMUP_SCENARIO_IDS = Object.freeze(["conversation-general", "vehicle-knowledge"]);
const REQUIRED_B4_MODEL_TASK_IDS = Object.freeze([
  "vehicle_slu",
  "cabin_response",
  "knowledge_answer",
]);
const PATH_OPTIONS = Object.freeze({
  "--baseline": "baselinePath",
  "--output-root": "outputRoot",
  "--resume": "resumePath",
});
const POSITIVE_INTEGER_OPTIONS = Object.freeze({
  "--repeats": "repeats",
  "--authorized-max-external-model-requests": "authorizedMaxExternalModelRequests",
});
const CHECKPOINT_KEYS = Object.freeze([
  "protocol", "suite", "profile", "catalog", "environment",
  "completedWarmupScenarioIds", "samples",
]);
const CONTRACT_KEYS = Object.freeze(["id", "version"]);
const ENVIRONMENT_KEYS = Object.freeze([
  "commitSha", "dirtyWorktree", "platform", "arch", "osRelease", "cpuModel", "profile",
  "providerIds", "modelIds", "regionIds", "timeoutConfig", "serviceConfig",
  "serviceReadiness", "coldStartProof",
]);
const TIMEOUT_CONFIG_KEYS = Object.freeze([
  "phaseTimeoutMs", "transportTimeoutMs", "scenarioTimeoutMs",
]);
const SERVICE_CONFIG_KEYS = Object.freeze(["requiredServiceIds", "readinessTimeoutMs"]);
const SERVICE_READINESS_KEYS = Object.freeze(["serviceId", "status"]);
const COLD_START_PROOF_KEYS = Object.freeze(["status", "verifiedAt", "serviceIds"]);
const B4_FAULT_BOUNDARIES = Object.freeze({
  "goal-formation-timeout": Object.freeze({
    type: "model-phase", terminal: Object.freeze(["recovered", "degraded"]), maxRecoveryAttempts: 1,
  }),
  "task-planning-timeout": Object.freeze({
    type: "model-phase", terminal: Object.freeze(["recovered", "degraded"]), maxRecoveryAttempts: 1,
  }),
  "vehicle-knowledge-rag-unavailable": Object.freeze({
    type: "rag-unavailable", maxEvidenceRefs: 0, maxCitations: 0,
  }),
  "weather-timeout": Object.freeze({
    type: "weather-readonly", sideEffectClass: "readonly", vehicleWrites: 0,
  }),
  "vehicle-confirmation-timeout": Object.freeze({
    type: "vehicle-confirmation", automaticWriteRetries: 0, providerConfirmations: 0,
    confirmedAnimations: 0,
  }),
});

const sharedFaultIds = B4_FAULT_SAMPLE_PLAN.map((entry) => entry.faultId);
if (Object.keys(B4_FAULT_BOUNDARIES).length !== sharedFaultIds.length
  || Object.keys(B4_FAULT_BOUNDARIES).some((faultId) => !sharedFaultIds.includes(faultId))) {
  throw new Error("B4 fault boundaries must cover exactly the shared fault sample plan");
}

export const B4_FAULT_CASES = Object.freeze(B4_FAULT_SAMPLE_PLAN.map((entry) => Object.freeze({
  ...entry,
  boundary: B4_FAULT_BOUNDARIES[entry.faultId],
})));

if (B4_FAULT_CASES.some((entry) => !Object.hasOwn(BENCHMARK_FAULT_PROFILE, entry.faultId))) {
  throw new Error("B4 fault cases must use the benchmark fault allowlist");
}

export function assertFaultCaseBoundary(faultCaseInput, observation = {}) {
  const boundary = faultCaseInput?.boundary;
  if (!boundary) throw new TypeError("fault case boundary is required");
  const profile = BENCHMARK_FAULT_PROFILE[faultCaseInput.faultId];
  if (!verifyBenchmarkFaultReceipt(observation.receipt, profile)) {
    throw new Error("fault case requires a verified fault receipt from the actual target response");
  }
  if (boundary.type === "model-phase") {
    if (!boundary.terminal.includes(observation.terminal)) {
      throw new Error("model timeout must end in bounded recovery or an explicit degraded event");
    }
    if (!Number.isInteger(observation.recoveryAttempts)
      || observation.recoveryAttempts < 0
      || observation.recoveryAttempts > boundary.maxRecoveryAttempts) {
      throw new Error("model timeout recovery attempts exceeded the boundary");
    }
    const noPlan = observation.planPresent === false && observation.planProvenance === "none";
    const trustedFallback = observation.planPresent === true
      && observation.planProvenance === "deterministic-knowledge-delegation-fallback";
    if (!noPlan && !trustedFallback) throw new Error("model timeout produced an unverified model plan");
    return true;
  }
  if (boundary.type === "rag-unavailable") {
    if (observation.evidenceCount !== boundary.maxEvidenceRefs
      || observation.citationCount !== boundary.maxCitations) {
      throw new Error("RAG unavailable boundary produced fabricated Manual evidence or citation");
    }
    return true;
  }
  if (boundary.type === "weather-readonly") {
    if (observation.toolCallCount !== 0
      || observation.adapterAcceptedCount !== 0
      || observation.providerCallCount !== 0) {
      throw new Error("weather timeout must have zero vehicle side effect calls");
    }
    return true;
  }
  if (boundary.type === "vehicle-confirmation") {
    if (observation.submissionCount !== 1 || observation.automaticWriteRetries !== 0) {
      throw new Error("vehicle confirmation timeout requires exactly one submission and no automatic write retry");
    }
    if (observation.timeoutTerminal !== true) {
      throw new Error("vehicle confirmation fault requires the actual timeout terminal");
    }
    if (observation.providerConfirmationCount !== 0
      || observation.confirmedStatePatchCount !== 0
      || observation.confirmedAnimationCount !== 0) {
      throw new Error("vehicle confirmation timeout must not claim confirmation, state patch, or animation");
    }
    return true;
  }
  throw new TypeError("unknown fault case boundary");
}

function clone(value) {
  return structuredClone(value);
}

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
}

function positiveInteger(value, option) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new TypeError(`${option} must be a positive integer`);
  }
  return Number(value);
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const parsed = {
    profile: null,
    repeats: null,
    baselinePath: null,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    resumePath: null,
    dryRun: false,
    failFast: false,
    authorizedMaxExternalModelRequests: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--dry-run") {
      if (seen.has(option)) throw new TypeError(`duplicate argument: ${option}`);
      seen.add(option);
      parsed.dryRun = true;
      continue;
    }
    if (option === "--fail-fast") {
      if (seen.has(option)) throw new TypeError(`duplicate argument: ${option}`);
      seen.add(option);
      parsed.failFast = true;
      continue;
    }
    if (option === "--profile") {
      if (seen.has(option)) throw new TypeError(`duplicate argument: ${option}`);
      seen.add(option);
      parsed.profile = requireOptionValue(argv, index, option);
      index += 1;
      continue;
    }
    if (Object.hasOwn(PATH_OPTIONS, option)) {
      if (seen.has(option)) throw new TypeError(`duplicate argument: ${option}`);
      seen.add(option);
      parsed[PATH_OPTIONS[option]] = requireOptionValue(argv, index, option);
      index += 1;
      continue;
    }
    if (Object.hasOwn(POSITIVE_INTEGER_OPTIONS, option)) {
      if (seen.has(option)) throw new TypeError(`duplicate argument: ${option}`);
      seen.add(option);
      const value = requireOptionValue(argv, index, option);
      parsed[POSITIVE_INTEGER_OPTIONS[option]] = positiveInteger(value, option);
      index += 1;
      continue;
    }
    throw new TypeError(`unknown argument: ${option}`);
  }
  if (!parsed.profile) throw new TypeError("--profile requires a value");
  if (!Object.hasOwn(BENCHMARK_PROFILES, parsed.profile)) {
    throw new TypeError(`unknown benchmark profile: ${parsed.profile}`);
  }
  return parsed;
}

export function buildRunPlan({ profile, repeats = null } = {}) {
  const profileContract = BENCHMARK_PROFILES[profile];
  if (!profileContract) throw new TypeError(`unknown benchmark profile: ${profile}`);
  if (repeats !== null && (!Number.isInteger(repeats) || repeats <= 0)) {
    throw new TypeError("repeats must be a positive integer or null");
  }
  const effectiveRepeats = repeats ?? profileContract.repeats;
  const catalogOrder = Object.keys(B4_BENCHMARK_SCENARIOS);
  const scenarioIds = catalogOrder.filter((scenarioId) => profileContract.scenarioIds.includes(scenarioId));
  const warmupScenarioIds = profile === "warm-baseline" ? [...WARMUP_SCENARIO_IDS] : [];
  const samples = profile === "stability-faults"
    ? Array.from({ length: effectiveRepeats }, (_, cycle) => B4_FAULT_CASES.map((entry) => {
        const scenarioStride = B4_FAULT_CASES
          .filter((candidate) => candidate.scenarioId === entry.scenarioId).length;
        const repeat = entry.repeat + cycle * scenarioStride;
        return Object.freeze({
          sampleKey: cycle === 0 ? entry.sampleKey : `${entry.scenarioId}:${repeat}`,
          scenarioId: entry.scenarioId,
          repeat,
          faultId: entry.faultId,
        });
      })).flat()
    : scenarioIds.flatMap((scenarioId) => Array.from(
        { length: effectiveRepeats },
        (_, index) => Object.freeze({
          sampleKey: `${scenarioId}:${index + 1}`,
          scenarioId,
          repeat: index + 1,
          ...(profile === "voice-browser" ? { voiceRequired: true } : {}),
        }),
      ));
  const budgetScenarioIds = profile === "stability-faults"
    ? samples.map((sample) => sample.scenarioId)
    : scenarioIds;
  const budget = calculateAcceptanceCallBudget({
    scenarioIds: budgetScenarioIds,
    repeats: profile === "stability-faults" ? 1 : effectiveRepeats,
    includeWarmup: warmupScenarioIds.length > 0,
    includeInterruptVerifier: false,
  });
  return Object.freeze({
    profile,
    repeats: effectiveRepeats,
    profileRepeats: profileContract.repeats,
    scenarioIds: Object.freeze(scenarioIds),
    faultIds: Object.freeze(samples.map((sample) => sample.faultId).filter(Boolean)),
    warmupScenarioIds: Object.freeze(warmupScenarioIds),
    samples: Object.freeze(samples),
    measuredSamples: samples.length,
    unmeasuredWarmups: warmupScenarioIds.length,
    maxExternalModelRequests: budget.maxExternalModelRequests,
    requiredServiceIds: Object.freeze([
      "agent-server",
      ...(profile === "voice-browser" ? ["gpt-sovits"] : []),
    ]),
  });
}

export function assertLiveAuthorization({ plan, authorizedMaxExternalModelRequests } = {}) {
  if (!plan || typeof plan !== "object") throw new TypeError("plan is required");
  if (plan.repeats !== plan.profileRepeats) {
    throw new Error("live functional/warm runs require default repeats; repeat overrides are dry-run only");
  }
  const expected = plan.maxExternalModelRequests;
  if (authorizedMaxExternalModelRequests !== expected) {
    throw new Error(`live ${plan.profile} requires authorization for exactly ${expected} external model requests`);
  }
  return expected;
}

export async function assertAgentServerReady(baseUrl, fetchImpl = globalThis.fetch) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new TypeError("baseUrl must be a non-empty string");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const profileUrl = `${baseUrl.replace(/\/+$/, "")}/api/model-provider-profile`;
  try {
    const response = await fetchImpl(profileUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_500),
    });
    if (!response?.ok) throw new Error(`readiness status ${response?.status ?? "unavailable"}`);
    const profile = await response.json();
    if (profile?.schemaVersion !== 3
      || profile?.runtimeContractVersion !== B3_B4_RUNTIME_CONTRACT_VERSION) {
      throw new Error("runtime contract version mismatch");
    }
    const tasks = Object.fromEntries(REQUIRED_B4_MODEL_TASK_IDS.map((taskId) => {
      const task = profile.tasks?.[taskId];
      const validWatchdog = task?.watchdogMs === null
        || (Number.isSafeInteger(task?.watchdogMs) && task.watchdogMs > 0);
      // Vehicle-SLU is task-configured and may use the approved local compact profile.
      // Knowledge Answer remains the live DashScope phase covered by this benchmark.
      const requiredProvider = taskId === "knowledge_answer" ? "dashscope" : null;
      if ((requiredProvider && task?.provider !== requiredProvider)
        || typeof task?.provider !== "string"
        || !task.provider.trim()
        || typeof task?.model !== "string"
        || !task.model.trim()
        || task.readiness?.status !== "ready"
        || !validWatchdog) {
        throw new Error(`${taskId} public model provider profile is not ready`);
      }
      return [taskId, Object.freeze({
        provider: task.provider,
        model: task.model,
        watchdogMs: task.watchdogMs,
        readiness: Object.freeze({ status: "ready" }),
      })];
    }));
    return Object.freeze({
      schemaVersion: profile.schemaVersion,
      runtimeContractVersion: profile.runtimeContractVersion,
      tasks: Object.freeze(tasks),
    });
  } catch (error) {
    throw new Error(`B4 requires an already-running 4173 Agent Server; readiness check failed (${error.message})`);
  }
}

export async function resolveVoiceServiceReadiness({
  endpoint = process.env.NIO_GPT_SOVITS_ENDPOINT || "http://127.0.0.1:9880/tts",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    throw new TypeError("GPT-SoVITS endpoint must be a non-empty string");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  try {
    const healthUrl = new URL("/", endpoint).href;
    await fetchImpl(healthUrl, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(1_500),
    });
    return Object.freeze({
      serviceId: "gpt-sovits",
      status: "ready",
      outcome: "ready",
      reasonCode: null,
    });
  } catch {
    return Object.freeze({
      serviceId: "gpt-sovits",
      status: "blocked",
      outcome: "blocked",
      reasonCode: "gpt-sovits-unavailable",
    });
  }
}

function checkpointEnvironment(environment) {
  return {
    commitSha: environment?.commitSha,
    dirtyWorktree: environment?.dirtyWorktree,
    platform: environment?.platform,
    arch: environment?.arch,
    osRelease: environment?.osRelease,
    cpuModel: environment?.cpuModel,
    profile: environment?.profile,
    providerIds: clone(environment?.providerIds || []),
    modelIds: clone(environment?.modelIds || []),
    regionIds: clone(environment?.regionIds || []),
    timeoutConfig: clone(environment?.timeoutConfig || {}),
    serviceConfig: clone(environment?.serviceConfig || {}),
    serviceReadiness: Array.isArray(environment?.serviceReadiness)
      ? environment.serviceReadiness.map((entry) => ({
        serviceId: entry?.serviceId,
        status: entry?.status,
      }))
      : [],
    coldStartProof: clone(environment?.coldStartProof || {}),
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${label} fields mismatch`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function assertStringArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)
    || (nonEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
}

function assertPositiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function isStrictIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function assertCheckpointEnvironmentSchema(environment) {
  assertExactKeys(environment, ENVIRONMENT_KEYS, "resume environment");
  for (const key of ["commitSha", "platform", "arch", "osRelease", "cpuModel", "profile"]) {
    assertNonEmptyString(environment[key], `resume environment ${key}`);
  }
  if (typeof environment.dirtyWorktree !== "boolean") {
    throw new Error("resume environment dirtyWorktree must be boolean");
  }
  for (const key of ["providerIds", "modelIds", "regionIds"]) {
    assertStringArray(environment[key], `resume environment ${key}`, { nonEmpty: true });
  }
  assertExactKeys(environment.timeoutConfig, TIMEOUT_CONFIG_KEYS, "resume environment timeoutConfig");
  for (const key of TIMEOUT_CONFIG_KEYS) {
    assertPositiveNumber(environment.timeoutConfig[key], `resume environment timeoutConfig.${key}`);
  }
  assertExactKeys(environment.serviceConfig, SERVICE_CONFIG_KEYS, "resume environment serviceConfig");
  assertStringArray(
    environment.serviceConfig.requiredServiceIds,
    "resume environment serviceConfig.requiredServiceIds",
    { nonEmpty: true },
  );
  assertPositiveNumber(
    environment.serviceConfig.readinessTimeoutMs,
    "resume environment serviceConfig.readinessTimeoutMs",
  );
  if (!Array.isArray(environment.serviceReadiness) || environment.serviceReadiness.length === 0) {
    throw new Error("resume environment serviceReadiness must be a non-empty array");
  }
  for (const entry of environment.serviceReadiness) {
    assertExactKeys(entry, SERVICE_READINESS_KEYS, "resume environment serviceReadiness");
    assertNonEmptyString(entry.serviceId, "resume environment serviceReadiness.serviceId");
    if (!["ready", "blocked", "unavailable"].includes(entry.status)) {
      throw new Error("resume environment serviceReadiness.status is unsupported");
    }
  }
  assertExactKeys(environment.coldStartProof, COLD_START_PROOF_KEYS, "resume environment coldStartProof");
  if (!["observed", "unverified", "not-applicable"].includes(environment.coldStartProof.status)) {
    throw new Error("resume environment coldStartProof.status is unsupported");
  }
  assertStringArray(environment.coldStartProof.serviceIds, "resume environment coldStartProof.serviceIds");
  if (environment.coldStartProof.status === "observed") {
    if (!isStrictIsoTimestamp(environment.coldStartProof.verifiedAt)
      || environment.coldStartProof.serviceIds.length === 0) {
      throw new Error("resume environment observed coldStartProof requires an ISO timestamp and service IDs");
    }
  } else if (environment.coldStartProof.verifiedAt !== null
    || (environment.coldStartProof.status === "not-applicable"
      && environment.coldStartProof.serviceIds.length !== 0)) {
    throw new Error("resume environment coldStartProof.verifiedAt must be null");
  }
}

export function createPartialCheckpoint({
  plan,
  environment,
  samples = [],
  completedWarmupScenarioIds = [],
} = {}) {
  if (!plan || typeof plan !== "object") throw new TypeError("plan is required");
  if (!Array.isArray(samples) || !Array.isArray(completedWarmupScenarioIds)) {
    throw new TypeError("checkpoint samples and warmups must be arrays");
  }
  return {
    protocol: clone(RUN_BENCHMARK_REPORT),
    suite: clone(RUN_BENCHMARK_SUITE),
    profile: plan.profile,
    catalog: {
      scenarioIds: clone(plan.scenarioIds),
      repeats: plan.repeats,
      ...((plan.faultIds || []).length > 0 ? { faultIds: clone(plan.faultIds) } : {}),
    },
    environment: checkpointEnvironment(environment),
    completedWarmupScenarioIds: clone(completedWarmupScenarioIds),
    samples: clone(samples),
  };
}

function assertCanonicalPlannedSample(sample, plannedSample, profile) {
  const key = sample?.sampleKey;
  let canonical;
  try {
    canonical = canonicalizeCheckpointSample(sample, { profile });
  } catch (error) {
    throw new Error(`completed sample ${key || "<missing>"} is invalid: ${error.message}`);
  }
  if (!isDeepStrictEqual(canonical, sample)) {
    throw new Error(`completed sample ${key || "<missing>"} is not canonical`);
  }
  if (!plannedSample
    || canonical.sampleKey !== plannedSample.sampleKey
    || canonical.scenarioId !== plannedSample.scenarioId
    || canonical.repeat !== plannedSample.repeat) {
    throw new Error(`completed sample ${key || "<missing>"} does not match the run plan`);
  }
  const receiptFaultId = canonical.diagnostics.benchmarkFaultReceipt?.faultId ?? null;
  if ((plannedSample.faultId ?? null) !== receiptFaultId) {
    throw new Error(`completed sample ${key} benchmarkFaultReceipt does not match the run plan`);
  }
  return canonical;
}

function assertCompletedSampleKeys(checkpoint, plan) {
  if (!Array.isArray(checkpoint.samples)) throw new TypeError("resume samples must be an array");
  const plannedByKey = new Map(plan.samples.map((sample) => [sample.sampleKey, sample]));
  if (plannedByKey.size !== plan.samples.length) throw new Error("run plan contains duplicate sample keys");
  const seen = new Set();
  for (const sample of checkpoint.samples) {
    const key = sample?.sampleKey;
    assertCanonicalPlannedSample(sample, plannedByKey.get(key), plan.profile);
    if (seen.has(key)) {
      throw new Error(`resume completed sample key is invalid: ${key || "<missing>"}`);
    }
    seen.add(key);
  }
}

function assertCompletedWarmups(checkpoint, plan) {
  const completed = checkpoint.completedWarmupScenarioIds;
  const expected = plan.warmupScenarioIds;
  if (!Array.isArray(completed)
    || completed.length > expected.length
    || completed.some((scenarioId, index) => scenarioId !== expected[index])) {
    throw new Error("resume warmup IDs must be a fixed-order prefix of the run plan");
  }
}

function assertCheckpointShape(checkpoint, plan) {
  if (!isRecord(checkpoint)) throw new TypeError("resume checkpoint must be an object");
  assertExactKeys(checkpoint, CHECKPOINT_KEYS, "resume checkpoint root");
  assertExactKeys(checkpoint.protocol, CONTRACT_KEYS, "resume report protocol");
  if (!isDeepStrictEqual(checkpoint.protocol, RUN_BENCHMARK_REPORT)) {
    throw new Error("resume report protocol mismatch");
  }
  assertExactKeys(checkpoint.suite, CONTRACT_KEYS, "resume suite");
  if (!isDeepStrictEqual(checkpoint.suite, RUN_BENCHMARK_SUITE)) {
    throw new Error("resume suite mismatch");
  }
  if (!plan || checkpoint.profile !== plan.profile) throw new Error("resume profile mismatch");
  if (checkpoint.environment?.profile !== plan.profile) {
    throw new Error("resume environment profile mismatch");
  }
  const expectedCatalog = {
    scenarioIds: plan.scenarioIds,
    repeats: plan.repeats,
    ...((plan.faultIds || []).length > 0 ? { faultIds: plan.faultIds } : {}),
  };
  assertExactKeys(checkpoint.catalog, Object.keys(expectedCatalog), "resume catalog");
  if (!isDeepStrictEqual(checkpoint.catalog, expectedCatalog)) throw new Error("resume catalog mismatch");
  assertCheckpointEnvironmentSchema(checkpoint.environment);
  assertCompletedWarmups(checkpoint, plan);
  assertCompletedSampleKeys(checkpoint, plan);
}

export function assertResumeCompatible({ checkpoint, plan, environment } = {}) {
  assertCheckpointShape(checkpoint, plan);
  const expectedEnvironment = checkpointEnvironment(environment);
  assertCheckpointEnvironmentSchema(expectedEnvironment);
  for (const field of Object.keys(expectedEnvironment)) {
    if (!isDeepStrictEqual(checkpoint.environment?.[field], expectedEnvironment[field])) {
      throw new Error(`resume environment ${field} mismatch`);
    }
  }
  return true;
}

export function pendingPlanSamples({ plan, checkpoint } = {}) {
  assertCheckpointShape(checkpoint, plan);
  const completed = new Set(checkpoint.samples.map((sample) => sample.sampleKey));
  return plan.samples.filter((sample) => !completed.has(sample.sampleKey));
}

export function writePartialCheckpointAtomic(path, checkpoint, fs = nodeFs) {
  if (typeof path !== "string" || !path.trim()) throw new TypeError("checkpoint path must be non-empty");
  const directory = dirname(path);
  const temporary = join(directory, `.partial-${randomUUID()}.json`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, path);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return path;
}

export function acquireCheckpointWriterLock(checkpointPath, fs = nodeFs) {
  if (typeof checkpointPath !== "string" || !checkpointPath.trim()) {
    throw new TypeError("checkpoint path must be non-empty");
  }
  const directory = dirname(checkpointPath);
  const path = join(directory, ".b4-baseline-writer.lock");
  const token = randomUUID();
  const releaseDirectory = join(directory, `.b4-baseline-writer.${token}.release`);
  const releasePath = join(releaseDirectory, "writer.lock");
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(path, `${JSON.stringify({ token })}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("B4 checkpoint writer lock is already held");
    throw error;
  }
  let released = false;
  return Object.freeze({
    path,
    releaseDirectory,
    releasePath,
    token,
    release() {
      if (released) return false;
      try {
        fs.mkdirSync(releaseDirectory);
      } catch {
        return false;
      }
      try {
        fs.renameSync(path, releasePath);
      } catch {
        try {
          fs.rmdirSync(releaseDirectory);
        } catch {
          // Only an empty quarantine created by this instance may be removed.
        }
        return false;
      }
      const restoreForeignLock = () => {
        try {
          fs.linkSync(releasePath, path);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        return false;
      };
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(releasePath, "utf8"));
      } catch {
        return restoreForeignLock();
      }
      if (owner?.token !== token) return restoreForeignLock();
      fs.rmSync(releasePath, { force: true });
      fs.rmdirSync(releaseDirectory);
      released = true;
      return true;
    },
  });
}

export function releaseCheckpointWriterLock(writerLock, primaryError = null) {
  let releaseError = null;
  try {
    if (!writerLock.release()) {
      throw new Error("B4 checkpoint writer lock ownership was lost; lock was not removed");
    }
  } catch (error) {
    releaseError = error;
  }
  if (!releaseError) return true;
  if (primaryError) {
    try {
      primaryError.lockReleaseError = releaseError.message;
    } catch {
      // Preserve the primary run failure when its error object is immutable.
    }
    return false;
  }
  throw releaseError;
}

export async function executeMeasuredSamples({
  plan,
  checkpoint,
  createPage,
  runSample,
  writePartial,
  envelopeTimeoutMs = null,
  failFast = false,
} = {}) {
  for (const [name, value] of Object.entries({ createPage, runSample, writePartial })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }
  let current = clone(checkpoint);
  const timedOutSampleKeys = [];
  for (const samplePlan of pendingPlanSamples({ plan, checkpoint: current })) {
    const page = await createPage();
    let sample;
    try {
      const timeoutMs = typeof envelopeTimeoutMs === "function"
        ? envelopeTimeoutMs({ sample: samplePlan })
        : envelopeTimeoutMs;
      if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new TypeError("envelope timeout must be a positive finite number or null");
      }
      if (timeoutMs === null) {
        sample = await runSample({ page, sample: samplePlan });
      } else {
        let timeout;
        try {
          sample = await Promise.race([
            Promise.resolve().then(() => runSample({ page, sample: samplePlan })),
            new Promise((_, reject) => {
              timeout = setTimeout(() => {
                const error = new Error(`benchmark sample envelope timed out: ${samplePlan.sampleKey}`);
                error.code = "benchmark-envelope-timeout";
                reject(error);
              }, timeoutMs);
            }),
          ]);
        } catch (error) {
          if (error?.code !== "benchmark-envelope-timeout") throw error;
          timedOutSampleKeys.push(samplePlan.sampleKey);
          continue;
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      await page?.close?.();
    }
    sample = assertCanonicalPlannedSample(sample, samplePlan, plan.profile);
    current = createPartialCheckpoint({
      plan,
      environment: current.environment,
      samples: [...current.samples, sample],
      completedWarmupScenarioIds: current.completedWarmupScenarioIds,
    });
    await writePartial(current);
    if (failFast === true && sample.projectedMetrics.outcome !== "passed") {
      const error = new Error(
        `benchmark fail-fast stopped at ${sample.sampleKey}: ${sample.projectedMetrics.outcome}`,
      );
      error.code = "benchmark-sample-failed";
      error.failedSample = sample;
      error.partialCheckpoint = current;
      throw error;
    }
  }
  if (timedOutSampleKeys.length > 0) {
    const error = new Error(`benchmark envelope timed out for ${timedOutSampleKeys.length} sample(s)`);
    error.code = "benchmark-envelope-timeout";
    error.timedOutSampleKeys = Object.freeze([...timedOutSampleKeys]);
    error.partialCheckpoint = current;
    throw error;
  }
  return current;
}

export function resolveBenchmarkRegion(publicProfile) {
  return typeof publicProfile?.regionId === "string" && publicProfile.regionId.trim()
    ? publicProfile.regionId.trim()
    : "unreported";
}

export function projectBenchmarkServiceProfile(
  publicProfile,
  profile,
  checkedAt,
  voiceReadiness = null,
) {
  const scenarioTimeoutMs = Math.max(...BENCHMARK_PROFILES[profile].scenarioIds
    .map((scenarioId) => getBenchmarkScenario(scenarioId).timeoutMs));
  const modelTasks = REQUIRED_B4_MODEL_TASK_IDS.map((taskId) => publicProfile.tasks[taskId]);
  const modelEnvelopeTimeoutMs = Math.max(...modelTasks.map(
    (task) => task.watchdogMs ?? scenarioTimeoutMs,
  ));
  return {
    modelIds: [...new Set(modelTasks.map((task) => task.model))].sort(),
    providerIds: [...new Set(modelTasks.map((task) => task.provider))].sort(),
    regionIds: [...new Set(modelTasks.map(resolveBenchmarkRegion))].sort(),
    timeoutConfig: {
      phaseTimeoutMs: modelEnvelopeTimeoutMs,
      transportTimeoutMs: modelEnvelopeTimeoutMs,
      scenarioTimeoutMs,
    },
    serviceConfig: {
      requiredServiceIds: [
        "agent-server",
        ...(profile === "voice-browser" ? ["gpt-sovits"] : []),
      ],
      readinessTimeoutMs: 1_500,
    },
    serviceReadiness: [
      { serviceId: "agent-server", status: "ready", checkedAt },
      ...(voiceReadiness ? [{ ...voiceReadiness, checkedAt }] : []),
    ],
    coldStartTelemetry: null,
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`unable to read ${label}: ${error.message}`);
  }
}

export function applyObservedModelRequestBudget({
  scenario,
  projectedMetrics,
  observedExternalModelRequestCount,
  instrumentationComplete = true,
} = {}) {
  if (!scenario?.modelBudget || !projectedMetrics || typeof projectedMetrics !== "object") {
    throw new TypeError("scenario and projectedMetrics are required");
  }
  const externalModelRequestCountPresent = Number.isSafeInteger(observedExternalModelRequestCount)
    && observedExternalModelRequestCount >= 0;
  const maximum = scenario.modelBudget.maxCalls;
  const instrumentationUnavailable = !externalModelRequestCountPresent || instrumentationComplete !== true;
  const exceeded = externalModelRequestCountPresent && observedExternalModelRequestCount > maximum;
  const budgetErrors = [...new Set([
    ...(Array.isArray(projectedMetrics.budgetErrors) ? projectedMetrics.budgetErrors : []),
    ...(exceeded ? ["observed external model request count exceeds scenario contract"] : []),
  ])];
  const contractErrors = [...new Set([
    ...(Array.isArray(projectedMetrics.contractErrors) ? projectedMetrics.contractErrors : []),
    ...(instrumentationUnavailable ? ["public probe instrumentation is unavailable"] : []),
    ...budgetErrors,
  ])];
  return Object.freeze({
    ...projectedMetrics,
    outcome: instrumentationUnavailable || budgetErrors.length > 0 ? "contract-failed" : projectedMetrics.outcome,
    contractErrors: Object.freeze(contractErrors),
    budgetErrors: Object.freeze(budgetErrors),
    modelRequests: externalModelRequestCountPresent
      ? observedExternalModelRequestCount
      : null,
  });
}

const PUBLIC_PROBE_COUNTER_FIELDS = Object.freeze([
  "modelRequestCount",
  "externalModelRequestCount",
  "safetyCallCount",
  "toolCallCount",
  "adapterAcceptedCount",
  "providerCallCount",
  "providerAcceptedCount",
  "providerStateChangeCount",
]);

function projectProbeInstrumentation(browser, declaredPresence = null) {
  const presence = Object.fromEntries(PUBLIC_PROBE_COUNTER_FIELDS.map((field) => [
    field,
    Object.hasOwn(browser, field)
      && Number.isInteger(browser[field])
      && browser[field] >= 0
      && declaredPresence?.[field] !== false,
  ]));
  return Object.freeze({
    ...presence,
    complete: Object.values(presence).every(Boolean),
  });
}

function projectPublicReasonCode(value) {
  if (typeof value !== "string") return null;
  const reasonCode = value.trim();
  return isPublicBenchmarkReasonCode(reasonCode) ? reasonCode : null;
}

export function projectPublicHmiEvidence({ probeResult, publicDebug } = {}) {
  const runDebug = probeResult?.runDebug || {};
  const browser = probeResult?.browserObservation || {};
  const result = runDebug.result || {};
  const instrumentation = projectProbeInstrumentation(browser, publicDebug?.instrumentation);
  const interactionRunIds = [];
  const interactionRef = result.interactionRef;
  const hasInteractionRef = typeof interactionRef?.sessionId === "string"
    && interactionRef.sessionId
    && typeof interactionRef?.turnId === "string"
    && interactionRef.turnId;
  const activeSessionId = publicDebug?.interactionSession?.sessionId;
  const activeSessionConsistent = typeof activeSessionId !== "string"
    || !activeSessionId
    || activeSessionId === interactionRef?.sessionId;
  const turnBound = hasInteractionRef && activeSessionConsistent && (
    [publicDebug?.currentTurn, publicDebug?.queuedTurn].some((turn) => (
      turn?.sessionId === interactionRef.sessionId && turn?.turnId === interactionRef.turnId
    ))
    || (publicDebug?.interactionEvents || []).some((event) => (
      event?.sessionId === interactionRef.sessionId && event?.turnId === interactionRef.turnId
    ))
  );
  if (turnBound) {
    for (const runId of publicDebug?.relatedRunIds || []) {
      if (typeof runId === "string" && runId && !interactionRunIds.includes(runId)) interactionRunIds.push(runId);
    }
  }
  const visibleFinalRunId = browser.resultVisibleRunId === runDebug.requestId
    ? browser.resultVisibleRunId
    : null;
  if (visibleFinalRunId && !interactionRunIds.includes(visibleFinalRunId)) {
    interactionRunIds.push(visibleFinalRunId);
  }
  return {
    runId: runDebug.requestId || null,
    firstFeedbackObserved: Number.isFinite(browser.firstFeedbackAtPerf)
      && Number.isFinite(browser.submittedAtPerf)
      && browser.firstFeedbackAtPerf >= browser.submittedAtPerf,
    resultVisible: Number.isFinite(browser.resultVisibleAtPerf)
      && Number.isFinite(browser.submittedAtPerf)
      && browser.resultVisibleAtPerf >= browser.submittedAtPerf
      && browser.resultVisibleRunId === runDebug.requestId,
    resultVisibleRunId: typeof browser.resultVisibleRunId === "string"
      ? browser.resultVisibleRunId
      : null,
    observedModelRequestCount: instrumentation.modelRequestCount
      ? browser.modelRequestCount
      : null,
    observedExternalModelRequestCount: instrumentation.externalModelRequestCount
      ? browser.externalModelRequestCount
      : null,
    instrumentation,
    visibleCardKinds: (publicDebug?.detailCards || [])
      .filter((card) => card?.visible === true && typeof card.cardKind === "string" && card.cardKind)
      .map((card) => card.cardKind),
    interactionRunIds,
    counters: {
      safetyCallCount: instrumentation.safetyCallCount ? browser.safetyCallCount : null,
      toolCallCount: instrumentation.toolCallCount ? browser.toolCallCount : null,
      adapterAcceptedCount: instrumentation.adapterAcceptedCount ? browser.adapterAcceptedCount : null,
      providerCallCount: instrumentation.providerCallCount ? browser.providerCallCount : null,
      providerAcceptedCount: instrumentation.providerAcceptedCount ? browser.providerAcceptedCount : null,
      providerStateChangeCount: instrumentation.providerStateChangeCount
        ? browser.providerStateChangeCount
        : null,
    },
    events: (runDebug.events || []).map((event) => ({
      eventId: event?.eventId,
      parentEventId: event?.parentEventId ?? null,
      sequence: event?.sequence,
      component: event?.component,
      componentType: event?.componentType,
      phase: event?.phase,
      status: event?.status,
      refs: Array.isArray(event?.refs) ? [...event.refs] : [],
      reasonCode: projectPublicReasonCode(event?.reasonCode),
      durationMs: Number.isSafeInteger(event?.durationMs) && event.durationMs >= 0
        ? event.durationMs
        : null,
    })),
    result: {
      safetyAllowed: typeof result.safetyDecision?.allowed === "boolean"
        ? result.safetyDecision.allowed
        : null,
      toolCallPresent: Boolean(result.toolCall),
      toolResultPresent: Boolean(result.toolResult),
      executionState: result.toolResult?.executionState || null,
      toolCommandId: result.toolCall?.commandId || null,
      resultCommandId: result.toolResult?.commandId || null,
      snapshotId: result.vehicleStateSnapshot?.id || null,
      confirmedSnapshotId: result.toolResult?.confirmedSnapshotId || null,
      snapshotCapturedAt: result.vehicleStateSnapshot?.capturedAt || null,
      executionTrace: Array.isArray(result.toolResult?.executionTrace)
        ? result.toolResult.executionTrace.map((entry) => ({
          state: entry?.state,
          at: entry?.at,
          source: entry?.source,
        }))
        : [],
    },
    animationConfirmed: Number.isFinite(browser.animationConfirmedAtPerf),
    animationCommandId: browser.animationCommandId || null,
  };
}

export function sampleFromProbe(samplePlan, scenario, probeResult, startedAt, completedAt) {
  const providerVoiceObservation = isVoicePlaybackProviderObservation(probeResult.voiceObservation)
    ? {
        submittedAtPerf: probeResult.voiceObservation.submittedAtPerf,
        firstAudibleAtPerf: probeResult.voiceObservation.firstAudioPlaybackAtPerf,
        completedAtPerf: probeResult.voiceObservation.audioPlaybackCompletedAtPerf,
      }
    : null;
  const rawProjectedMetrics = projectRunMetrics({
    scenario,
    runDebug: probeResult.runDebug,
    browserObservation: probeResult.browserObservation,
    voiceObservation: providerVoiceObservation,
  });
  const voiceBlocked = samplePlan.voiceRequired === true && providerVoiceObservation === null;
  const voiceBlockedReason = probeResult.voiceObservationFailureCode
    || (probeResult.voiceObservation?.browserFallbackUsed === true
      ? "browser-fallback-not-gpt-sovits"
      : "gpt-sovits-playback-blocked");
  const voiceProjectedMetrics = voiceBlocked
    ? Object.freeze({
        ...rawProjectedMetrics,
        outcome: rawProjectedMetrics.outcome === "passed"
          ? "run-degraded"
          : rawProjectedMetrics.outcome,
        voice: null,
      })
    : rawProjectedMetrics;
  const instrumentation = projectProbeInstrumentation(
    probeResult.browserObservation || {},
    probeResult.publicHmiEvidence?.instrumentation,
  );
  const projectedMetrics = applyObservedModelRequestBudget({
    scenario,
    projectedMetrics: voiceProjectedMetrics,
    observedExternalModelRequestCount: instrumentation.externalModelRequestCount
      ? probeResult.browserObservation.externalModelRequestCount
      : null,
    instrumentationComplete: instrumentation.complete,
  });
  const eventRefs = (probeResult.runDebug?.events || [])
    .map((event) => event?.eventId)
    .filter((eventId) => typeof eventId === "string" && eventId);
  let benchmarkFaultReceipt = null;
  if (samplePlan.faultId) {
    const selectedCase = B4_FAULT_CASES.find((entry) => entry.faultId === samplePlan.faultId);
    const observation = projectFaultCaseObservation(
      selectedCase,
      probeResult,
      projectedMetrics,
    );
    assertFaultCaseBoundary(selectedCase, observation);
    benchmarkFaultReceipt = verifyBenchmarkFaultReceipt(
      observation.receipt,
      BENCHMARK_FAULT_PROFILE[samplePlan.faultId],
    );
  }
  return {
    sampleId: samplePlan.sampleKey,
    sampleKey: samplePlan.sampleKey,
    runId: probeResult.runDebug?.requestId || samplePlan.sampleKey,
    scenarioId: samplePlan.scenarioId,
    repeat: samplePlan.repeat,
    timestamps: { startedAt, completedAt },
    projectedMetrics,
    eventRefs: eventRefs.length > 0 ? eventRefs : [`run:${probeResult.runDebug?.requestId || samplePlan.sampleKey}`],
    simulated: scenario.simulated,
    diagnostics: {
      code: voiceBlocked
        ? voiceBlockedReason
        : projectedMetrics.outcome === "passed" ? "none" : projectedMetrics.outcome,
      ...(benchmarkFaultReceipt ? { benchmarkFaultReceipt } : {}),
      ...(probeResult.publicHmiEvidence
        ? { publicHmiEvidence: clone(probeResult.publicHmiEvidence) }
        : {}),
    },
  };
}

export function projectFaultCaseObservation(selectedCase, probeResult, projectedMetrics) {
  const evidence = probeResult.faultEvidence || {};
  const browser = probeResult.browserObservation || {};
  if (selectedCase.boundary.type === "model-phase") {
    const events = probeResult.runDebug?.events || [];
    const explicitDegradedEvent = events.some((event) => event?.degraded === true);
    return {
      receipt: evidence.receipt || null,
      terminal: projectedMetrics.outcome === "passed"
        ? "recovered"
        : explicitDegradedEvent ? "degraded" : "failed",
      recoveryAttempts: events.filter((event) => event?.phase === "recovery-attempted").length,
      planPresent: evidence.model?.planPresent,
      planProvenance: evidence.model?.planProvenance,
    };
  }
  if (selectedCase.boundary.type === "rag-unavailable") {
    return {
      receipt: evidence.receipt || null,
      evidenceCount: evidence.rag?.evidenceCount,
      citationCount: evidence.rag?.citationCount,
    };
  }
  if (selectedCase.boundary.type === "weather-readonly") {
    return {
      receipt: evidence.receipt || null,
      toolCallCount: evidence.weather?.toolCallCount,
      adapterAcceptedCount: evidence.weather?.adapterAcceptedCount,
      providerCallCount: evidence.weather?.providerCallCount,
    };
  }
  return {
    receipt: evidence.receipt || null,
    submissionCount: evidence.vehicle?.submissionCount,
    timeoutTerminal: evidence.vehicle?.timeoutTerminal,
    automaticWriteRetries: evidence.vehicle?.automaticWriteRetries,
    providerConfirmationCount: evidence.vehicle?.providerConfirmationCount,
    confirmedStatePatchCount: evidence.vehicle?.confirmedStatePatchCount,
    confirmedAnimationCount: Math.max(
      Number(evidence.vehicle?.confirmedAnimationCount || 0),
      browser.animationConfirmedAtPerf == null ? 0 : 1,
    ),
  };
}

async function installPageBenchmarkFault(page, faultId) {
  if (!faultId) return;
  await page.addInitScript(({ selectedFaultId }) => {
    window.NIO_DEV_BENCHMARK_FAULTS = true;
    window.NIO_BENCHMARK_FAULT_PROFILE = selectedFaultId;
  }, { selectedFaultId: faultId });
}

async function runBrowserScenario({ browser, baseUrl, scenario, samplePlan }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const probe = await createB4BrowserProbe({ page, scenario, timeoutMs: scenario.timeoutMs });
  const startedAt = new Date().toISOString();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForFunction(() => typeof window.__runtimeDebug === "function"
      && typeof window.__vehicleDebug === "function"
      && typeof window.runCommand === "function", null, { timeout: 15_000 });
    const result = await probe.run({ requestId: `b4:${samplePlan.sampleKey}:${randomUUID()}` });
    return sampleFromProbe(samplePlan, scenario, result, startedAt, new Date().toISOString());
  } finally {
    await page.close();
  }
}

export function assertWarmupSamplePassed(sample, scenarioId) {
  if (sample?.scenarioId !== scenarioId
    || sample?.projectedMetrics?.outcome !== "passed"
    || !Number.isSafeInteger(sample?.projectedMetrics?.modelRequests)
    || sample.projectedMetrics.modelRequests < 0) {
    throw new Error(`warmup ${scenarioId || "<unknown>"} did not satisfy the external-call contract`);
  }
  return sample;
}

async function runWarmups({ browser, baseUrl, plan, checkpoint, checkpointPath }) {
  const completed = new Set(checkpoint.completedWarmupScenarioIds);
  let current = checkpoint;
  for (const scenarioId of plan.warmupScenarioIds) {
    if (completed.has(scenarioId)) continue;
    const scenario = getBenchmarkScenario(scenarioId);
    const warmupSample = await runBrowserScenario({
      browser,
      baseUrl,
      scenario,
      samplePlan: { sampleKey: `warmup:${scenarioId}`, scenarioId, repeat: 1 },
    });
    assertWarmupSamplePassed(warmupSample, scenarioId);
    completed.add(scenarioId);
    current = createPartialCheckpoint({
      plan,
      environment: current.environment,
      samples: current.samples,
      completedWarmupScenarioIds: [...completed],
    });
    writePartialCheckpointAtomic(checkpointPath, current);
  }
  return current;
}

function derivedReportWithComparison(report, comparison) {
  const derived = { ...clone(report), comparison: clone(comparison) };
  const freeze = (value) => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze);
    return Object.freeze(value);
  };
  return freeze(derived);
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const plan = buildRunPlan({ profile: args.profile, repeats: args.repeats });
  if (args.dryRun) {
    console.log(JSON.stringify({
      profile: plan.profile,
      repeats: plan.repeats,
      measuredSamples: plan.measuredSamples,
      unmeasuredWarmups: plan.unmeasuredWarmups,
      isolatedPagesAtMost: plan.measuredSamples + plan.unmeasuredWarmups,
      maxExternalModelRequests: plan.maxExternalModelRequests,
      requiredServiceIds: plan.requiredServiceIds,
    }));
    return;
  }
  assertLiveAuthorization({
    plan,
    authorizedMaxExternalModelRequests: args.authorizedMaxExternalModelRequests,
  });
  let voiceReadiness = null;
  if (plan.profile === "voice-browser") {
    voiceReadiness = await resolveVoiceServiceReadiness();
    if (voiceReadiness.status !== "ready") {
      const blocked = Object.freeze({
        profile: plan.profile,
        outcome: "blocked",
        serviceReadiness: Object.freeze([voiceReadiness]),
      });
      console.log(JSON.stringify(blocked));
      return blocked;
    }
  }
  const baseUrl = (process.env.NIO_AGENT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const checkpointPath = args.resumePath || join(args.outputRoot, "partial.json");
  const writerLock = acquireCheckpointWriterLock(checkpointPath);
  let primaryError = null;
  try {
    const publicProfile = await assertAgentServerReady(baseUrl);
    const checkedAt = new Date().toISOString();
    const environment = readBenchmarkEnvironment({
      cwd: process.cwd(),
      profile: plan.profile,
      serviceProfile: projectBenchmarkServiceProfile(
        publicProfile,
        plan.profile,
        checkedAt,
        voiceReadiness,
      ),
    });
    let checkpoint = args.resumePath
      ? readJson(args.resumePath, "resume checkpoint")
      : createPartialCheckpoint({ plan, environment });
    assertResumeCompatible({ checkpoint, plan, environment });
    if (!args.resumePath) writePartialCheckpointAtomic(checkpointPath, checkpoint);

    const browser = await launchChromium({ headless: true });
    try {
      checkpoint = await runWarmups({ browser, baseUrl, plan, checkpoint, checkpointPath });
      checkpoint = await executeMeasuredSamples({
        plan,
        checkpoint,
        createPage: () => browser.newPage({ viewport: { width: 1440, height: 1100 } }),
        runSample: async ({ page, sample }) => {
          const scenario = getBenchmarkScenario(sample.scenarioId);
          await installPageBenchmarkFault(page, sample.faultId);
          const probe = await createB4BrowserProbe({ page, scenario, timeoutMs: scenario.timeoutMs });
          const startedAt = new Date().toISOString();
          if (sample.voiceRequired === true) await installVoicePlaybackProbe({ page });
          await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
          await page.waitForFunction(() => typeof window.__runtimeDebug === "function"
            && typeof window.__vehicleDebug === "function"
            && typeof window.runCommand === "function", null, { timeout: 15_000 });
          const result = await probe.run({ requestId: `b4:${sample.sampleKey}:${randomUUID()}` });
          let voiceObservation = null;
          let voiceObservationFailureCode = null;
          if (sample.voiceRequired === true) {
            await recordVoiceSubmission({
              page,
              requestId: result.runDebug?.requestId,
              submittedAtPerf: result.browserObservation?.submittedAtPerf,
            });
            try {
              voiceObservation = await observeVoicePlayback({
                page,
                requestId: result.runDebug?.requestId,
                timeoutMs: scenario.timeoutMs,
              });
            } catch {
              voiceObservationFailureCode = "voice-playback-observation-failed";
            }
          }
          const faultEvidence = sample.faultId
            ? await page.evaluate(() => window.__runtimeDebug?.()?.benchmarkFaultEvidence || null)
            : null;
          const publicDebug = await page.evaluate(() => {
            const debug = window.__runtimeDebug?.() || {};
            const probeState = window.__b4BenchmarkProbe;
            const counters = window.__b2AcceptanceCalls;
            const hasNonNegativeInteger = (target, field) => target !== null
              && typeof target === "object"
              && Object.prototype.hasOwnProperty.call(target, field)
              && Number.isInteger(target[field])
              && target[field] >= 0;
            return {
              detailCards: debug.detailCards || [],
              currentTurn: debug.currentTurn || null,
              queuedTurn: debug.queuedTurn || null,
              interactionEvents: debug.interactionEvents || [],
              interactionSession: debug.interactionSession || null,
              relatedRunIds: debug.relatedRunIds || [],
              instrumentation: {
                modelRequestCount: hasNonNegativeInteger(probeState, "modelRequestCount"),
                externalModelRequestCount: hasNonNegativeInteger(probeState, "externalModelRequestCount"),
                safetyCallCount: hasNonNegativeInteger(counters, "safetyCallCount"),
                toolCallCount: hasNonNegativeInteger(counters, "toolCallCount"),
                adapterAcceptedCount: hasNonNegativeInteger(counters, "adapterAcceptedCount"),
                providerCallCount: hasNonNegativeInteger(counters, "providerCallCount"),
                providerAcceptedCount: hasNonNegativeInteger(counters, "providerAcceptedCount"),
                providerStateChangeCount: hasNonNegativeInteger(counters, "providerStateChangeCount"),
              },
            };
          });
          const publicHmiEvidence = projectPublicHmiEvidence({ probeResult: result, publicDebug });
          return sampleFromProbe(
            sample,
            scenario,
            {
              ...result,
              faultEvidence,
              voiceObservation,
              voiceObservationFailureCode,
              publicHmiEvidence,
            },
            startedAt,
            new Date().toISOString(),
          );
        },
        writePartial: (nextCheckpoint) => writePartialCheckpointAtomic(checkpointPath, nextCheckpoint),
        envelopeTimeoutMs: ({ sample }) => getBenchmarkScenario(sample.scenarioId).timeoutMs + 5_000,
        failFast: args.failFast,
      });
    } finally {
      await browser.close();
    }

    let report = buildBenchmarkReport({
      profile: plan.profile,
      environment,
      samples: checkpoint.samples,
      generatedAt: new Date().toISOString(),
    });
    if (args.baselinePath) {
      const comparison = compareBenchmarkReports({
        baseline: readJson(args.baselinePath, "baseline report"),
        candidate: report,
      });
      report = derivedReportWithComparison(report, comparison);
    }
    const written = writeBenchmarkReport({ report, outputRoot: args.outputRoot });
    console.log(JSON.stringify({
      reportId: report.reportId,
      outcome: report.outcome,
      sampleCount: report.samples.length,
      directory: written.directory,
    }));
    return Object.freeze({ report, written });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    releaseCheckpointWriterLock(writerLock, primaryError);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli().catch((error) => {
    console.error(`run-b4-baseline: ${error.message}`);
    process.exitCode = 1;
  });
}
