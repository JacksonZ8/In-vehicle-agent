import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  applyObservedModelRequestBudget,
  buildRunPlan,
  projectPublicHmiEvidence,
  runCli as runB4Baseline,
  sampleFromProbe,
} from "../benchmarks/run-b4-baseline.mjs";
import { BENCHMARK_PROFILES } from "../../src/benchmark/run-benchmark-contract.js";
import { B4_BENCHMARK_SCENARIOS } from "../../src/benchmark/run-benchmark-scenarios.js";
import { buildBenchmarkReport } from "../../src/benchmark/run-benchmark-report.js";

const FUNCTIONAL_PROFILE = "functional-smoke";
const FUNCTIONAL_AUTHORIZATION = buildRunPlan({ profile: FUNCTIONAL_PROFILE }).maxExternalModelRequests;
const READ_ONLY_SCENARIOS = new Set([
  "conversation-general", "weather-readonly", "vehicle-knowledge", "clarification",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function eventIndex(events, predicate) {
  return events.findIndex(predicate);
}

const PUBLIC_COMPONENT_TYPES = Object.freeze({
  cabinAssistant: "ai-agent",
  orchestrator: "ai-agent",
  orchestratorModel: "model-service",
  safety: "deterministic-service",
  vehicleTool: "tool-interface",
});

function publicEvent(runId, sequence, component, phase, status, {
  reasonCode = null,
  durationMs = null,
} = {}) {
  return {
    eventId: `event:${runId}:${sequence}`,
    parentEventId: sequence === 1 ? null : `event:${runId}:${sequence - 1}`,
    sequence,
    component,
    componentType: PUBLIC_COMPONENT_TYPES[component],
    phase,
    status,
    refs: [],
    reasonCode,
    durationMs,
  };
}

function validateVisibleRun(sample, evidence, errors) {
  if (!nonEmpty(sample?.runId) || evidence?.runId !== sample.runId) {
    errors.push(`${sample?.scenarioId}: public Run ownership mismatch`);
  }
  if (evidence?.firstFeedbackObserved !== true) {
    errors.push(`${sample?.scenarioId}: first feedback was not visible`);
  }
  if (evidence?.resultVisible !== true) {
    errors.push(`${sample?.scenarioId}: final result was not visible`);
  }
  if (evidence?.resultVisibleRunId !== sample?.runId) {
    errors.push(`${sample?.scenarioId}: final result visibility Run ownership mismatch`);
  }
  if (sample?.outcome !== "passed") {
    errors.push(`${sample?.scenarioId}: sample-nonpassing`);
  }
}

function validateReadOnly(sample, evidence, errors) {
  const behavior = sample.projectedMetrics?.behavior;
  if (evidence.counters?.adapterAcceptedCount !== 0 || behavior?.adapterExecutions !== 0) {
    errors.push(`${sample.scenarioId}: read-only scenario accepted a Vehicle Adapter execution`);
  }
  if (behavior?.vehicleWrites !== 0) {
    errors.push(`${sample.scenarioId}: read-only scenario reported a vehicle write`);
  }
}

function validateKnowledge(sample, evidence, errors) {
  const events = evidence.events || [];
  const phases = [
    "knowledge-delegation", "knowledge-evidence", "knowledge-answer",
  ];
  const indexes = phases.map((phase) => eventIndex(events, (event) => event.phase === phase));
  if (!evidence.visibleCardKinds?.includes("b2-goal")
    || evidence.visibleCardKinds?.includes("b2-plan")
    || !evidence.visibleCardKinds?.includes("b3-vehicle-knowledge")) {
    errors.push("vehicle-knowledge: direct route must show Cabin/B3 truth without a fake Orchestrator plan");
  }
  if (indexes.some((index) => index < 0)
    || indexes.some((index, position) => position > 0 && index <= indexes[position - 1])) {
    errors.push("vehicle-knowledge: public B3 plan/event sequence is incomplete or unordered");
  }
  if (evidence.result?.toolCallPresent || evidence.result?.toolResultPresent) {
    errors.push("vehicle-knowledge: knowledge answer must not expose Vehicle ToolCall/ToolResult");
  }
}

function validateSafeTailgate(sample, evidence, errors) {
  const events = evidence.events || [];
  const safetyIndex = eventIndex(events, (event) => event.component === "safety"
    && event.phase === "vehicle-safety" && event.status === "completed");
  const toolIndex = eventIndex(events, (event) => event.component === "vehicleTool"
    && event.phase === "vehicle-execution");
  const runIds = evidence.interactionRunIds || [];
  const distinctRuns = new Set(runIds);
  const trace = evidence.result?.executionTrace || [];
  const acceptedIndex = trace.findIndex((entry) => entry.state === "accepted");
  const observedIndex = trace.findIndex((entry) => entry.state === "observed-succeeded");
  const acceptedAt = Date.parse(trace[acceptedIndex]?.at || "");
  const snapshotAt = Date.parse(evidence.result?.snapshotCapturedAt || "");

  if (distinctRuns.size < 2 || runIds.at(-1) !== sample.runId) {
    errors.push("vehicle-control-safe: public confirmation did not produce a second owned Run");
  }
  if (evidence.result?.safetyAllowed !== true || safetyIndex < 0 || toolIndex <= safetyIndex) {
    errors.push("vehicle-control-safe: Safety allow must precede the Tool event");
  }
  if (evidence.counters?.adapterAcceptedCount !== 1
    || evidence.counters?.providerCallCount < 1
    || acceptedIndex < 0
    || observedIndex <= acceptedIndex
    || !Number.isFinite(acceptedAt)
    || !Number.isFinite(snapshotAt)
    || snapshotAt < acceptedAt) {
    errors.push("vehicle-control-safe: Adapter acceptance must precede Sensor/Provider observation");
  }
  if (evidence.result?.executionState !== "observed-succeeded"
    || evidence.result?.confirmedSnapshotId !== evidence.result?.snapshotId) {
    errors.push("vehicle-control-safe: Provider-confirmed snapshot evidence is invalid");
  }
  if (!nonEmpty(evidence.result?.toolCommandId)
    || evidence.result.toolCommandId !== evidence.result?.resultCommandId
    || evidence.result.toolCommandId !== evidence.animationCommandId
    || evidence.animationConfirmed !== true) {
    errors.push("vehicle-control-safe: confirmed animation command identity is invalid");
  }
}

function validateUnsafeTailgate(sample, evidence, errors) {
  const safetyBlocked = (evidence.events || []).some((event) => event.component === "safety"
    && event.phase === "vehicle-safety" && event.status === "safety_rejected");
  if (evidence.result?.safetyAllowed !== false || !safetyBlocked) {
    errors.push("vehicle-control-unsafe: public Safety rejection is missing");
  }
  if (evidence.counters?.adapterAcceptedCount !== 0
    || evidence.counters?.providerCallCount !== 0
    || sample.projectedMetrics?.behavior?.vehicleWrites !== 0) {
    errors.push("vehicle-control-unsafe: blocked command crossed a write boundary");
  }
  if (evidence.result?.toolCallPresent
    || evidence.result?.toolResultPresent
    || evidence.animationConfirmed === true
    || evidence.animationCommandId !== null) {
    errors.push("vehicle-control-unsafe: blocked command exposed Tool or animation success");
  }
}

export function validateFunctionalSmokeReport(report) {
  const errors = [];
  const profile = BENCHMARK_PROFILES[FUNCTIONAL_PROFILE];
  if (report?.profile !== FUNCTIONAL_PROFILE || report?.outcome !== "passed") {
    errors.push("functional report must have profile functional-smoke and outcome passed");
  }
  if (!Array.isArray(report?.samples) || report.samples.length !== profile.scenarioIds.length) {
    return [...errors, "functional report must contain exactly six samples"];
  }
  const samplesByScenario = new Map(report.samples.map((sample) => [sample.scenarioId, sample]));
  for (const scenarioId of profile.scenarioIds) {
    const sample = samplesByScenario.get(scenarioId);
    if (!sample || sample.repeat !== 1 || sample.sampleId !== `${scenarioId}:1`) {
      errors.push(`${scenarioId}: required functional sample is missing`);
      continue;
    }
    const evidence = sample.diagnostics?.publicHmiEvidence;
    if (!isRecord(evidence)) {
      errors.push(`${scenarioId}: public HMI evidence is missing`);
      continue;
    }
    if (evidence.instrumentation?.complete !== true) {
      errors.push(`${scenarioId}: public probe instrumentation is incomplete`);
    }
    validateVisibleRun(sample, evidence, errors);
    const maximum = B4_BENCHMARK_SCENARIOS[scenarioId].modelBudget.maxCalls;
    const modelCountValid = Number.isSafeInteger(evidence.observedModelRequestCount)
      && evidence.observedModelRequestCount >= 0;
    const externalCountValid = Number.isSafeInteger(evidence.observedExternalModelRequestCount)
      && evidence.observedExternalModelRequestCount >= 0;
    if (!modelCountValid || !externalCountValid) {
      errors.push(`${scenarioId}: external model calls count-invalid`);
    } else {
      if (evidence.observedExternalModelRequestCount > maximum) {
        errors.push(`${scenarioId}: external model calls budget-exceeded`);
      }
      if (sample.projectedMetrics?.modelRequests !== evidence.observedExternalModelRequestCount) {
        errors.push(`${scenarioId}: external model calls count-mismatch`);
      }
      if (sample.projectedMetrics?.modelCallCount !== evidence.observedModelRequestCount) {
        errors.push(`${scenarioId}: Runtime model phase calls count-mismatch`);
      }
    }
    if (READ_ONLY_SCENARIOS.has(scenarioId)) validateReadOnly(sample, evidence, errors);
    if (scenarioId === "vehicle-knowledge") validateKnowledge(sample, evidence, errors);
    if (scenarioId === "vehicle-control-safe") validateSafeTailgate(sample, evidence, errors);
    if (scenarioId === "vehicle-control-unsafe") validateUnsafeTailgate(sample, evidence, errors);
  }
  return errors;
}

function fixtureEvidence(scenarioId) {
  const modelCallCount = B4_BENCHMARK_SCENARIOS[scenarioId].modelBudget.maxCalls;
  const common = {
    runId: `run:${scenarioId}`,
    firstFeedbackObserved: true,
    resultVisible: true,
    resultVisibleRunId: `run:${scenarioId}`,
    observedModelRequestCount: modelCallCount,
    observedExternalModelRequestCount: modelCallCount,
    instrumentation: {
      modelRequestCount: true,
      externalModelRequestCount: true,
      safetyCallCount: true,
      toolCallCount: true,
      adapterAcceptedCount: true,
      providerCallCount: true,
      providerAcceptedCount: true,
      providerStateChangeCount: true,
      complete: true,
    },
    visibleCardKinds: ["b2-goal", "b2-plan"],
    interactionRunIds: [`run:${scenarioId}`],
    counters: {
      safetyCallCount: 0, toolCallCount: 0, adapterAcceptedCount: 0, providerCallCount: 0,
      providerAcceptedCount: 0, providerStateChangeCount: 0,
    },
    events: [],
    result: {
      safetyAllowed: null,
      toolCallPresent: false,
      toolResultPresent: false,
      executionState: null,
      toolCommandId: null,
      resultCommandId: null,
      snapshotId: null,
      confirmedSnapshotId: null,
      snapshotCapturedAt: null,
      executionTrace: [],
    },
    animationConfirmed: false,
    animationCommandId: null,
  };
  if (scenarioId === "vehicle-knowledge") {
    common.visibleCardKinds = ["b2-goal"];
    common.visibleCardKinds.push("b3-vehicle-knowledge");
    common.events = [
      publicEvent(common.runId, 1, "runtimeKernel", "knowledge-delegation", "completed"),
      publicEvent(common.runId, 2, "manualRetriever", "knowledge-evidence", "completed"),
      publicEvent(common.runId, 3, "cabinAssistant", "knowledge-answer", "completed"),
    ];
  }
  if (scenarioId === "vehicle-control-safe") {
    common.interactionRunIds = ["run:vehicle-control-safe:confirmation", common.runId];
    common.counters = {
      safetyCallCount: 2, toolCallCount: 1, adapterAcceptedCount: 1, providerCallCount: 1,
      providerAcceptedCount: 1, providerStateChangeCount: 1,
    };
    common.events = [
      publicEvent(common.runId, 1, "safety", "vehicle-safety", "completed"),
      publicEvent(common.runId, 2, "vehicleTool", "vehicle-execution", "completed"),
    ];
    common.result = {
      safetyAllowed: true,
      toolCallPresent: true,
      toolResultPresent: true,
      executionState: "observed-succeeded",
      toolCommandId: "command:tailgate",
      resultCommandId: "command:tailgate",
      snapshotId: "snapshot:tailgate",
      confirmedSnapshotId: "snapshot:tailgate",
      snapshotCapturedAt: "2026-08-03T00:00:03.000Z",
      executionTrace: [
        { state: "submitted", at: "2026-08-03T00:00:00.000Z" },
        { state: "accepted", at: "2026-08-03T00:00:01.000Z" },
        { state: "executing", at: "2026-08-03T00:00:02.000Z" },
        { state: "observed-succeeded", at: "2026-08-03T00:00:03.000Z" },
      ],
    };
    common.animationConfirmed = true;
    common.animationCommandId = "command:tailgate";
  }
  if (scenarioId === "vehicle-control-unsafe") {
    common.counters.safetyCallCount = 1;
    common.events = [
      publicEvent(common.runId, 1, "safety", "vehicle-safety", "safety_rejected"),
    ];
    common.result.safetyAllowed = false;
  }
  return common;
}

function fixtureReport() {
  return {
    profile: FUNCTIONAL_PROFILE,
    outcome: "passed",
    samples: Object.keys(B4_BENCHMARK_SCENARIOS).map((scenarioId) => ({
      sampleId: `${scenarioId}:1`,
      runId: `run:${scenarioId}`,
      scenarioId,
      repeat: 1,
      outcome: "passed",
      projectedMetrics: {
        outcome: "passed",
        modelRequests: B4_BENCHMARK_SCENARIOS[scenarioId].modelBudget.maxCalls,
        modelCallCount: B4_BENCHMARK_SCENARIOS[scenarioId].modelBudget.maxCalls,
        behavior: {
          adapterExecutions: scenarioId === "vehicle-control-safe" ? 1 : 0,
          vehicleWrites: scenarioId === "vehicle-control-safe" ? 1 : 0,
        },
      },
      diagnostics: { code: "none", publicHmiEvidence: fixtureEvidence(scenarioId) },
    })),
  };
}

function assertFixtureMutationRejected(validFixture, mutate, pattern) {
  const candidate = structuredClone(validFixture);
  mutate(candidate);
  assert.match(validateFunctionalSmokeReport(candidate).join("; "), pattern);
}

const REPORT_ENVIRONMENT_FIXTURE = Object.freeze({
  commitSha: "fixture-sha",
  dirtyWorktree: true,
  platform: "darwin",
  arch: "arm64",
  osRelease: "24.0.0",
  cpuModel: "Apple M4",
  profile: FUNCTIONAL_PROFILE,
  modelIds: Object.freeze(["qwen-plus-2025-12-01"]),
  providerIds: Object.freeze(["dashscope"]),
  regionIds: Object.freeze(["unreported"]),
  timeoutConfig: Object.freeze({
    phaseTimeoutMs: 12_000, transportTimeoutMs: 15_000, scenarioTimeoutMs: 90_000,
  }),
  serviceConfig: Object.freeze({
    requiredServiceIds: Object.freeze(["agent-server"]), readinessTimeoutMs: 1_500,
  }),
  serviceReadiness: Object.freeze([Object.freeze({
    serviceId: "agent-server", status: "ready", checkedAt: "2026-08-03T00:00:00.000Z",
  })]),
  coldStartProof: Object.freeze({ status: "not-applicable", verifiedAt: null, serviceIds: Object.freeze([]) }),
});

export function parseB4VerifierArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  let staticOnly = false;
  let authorization = null;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seen.has(option)) throw new TypeError(`duplicate argument: ${option}`);
    seen.add(option);
    if (option === "--static-only") {
      staticOnly = true;
      continue;
    }
    if (option === "--authorized-max-external-model-requests") {
      const value = argv[index + 1];
      if (!/^\d+$/.test(value || "")) throw new TypeError(`${option} requires a positive integer`);
      authorization = Number(value);
      index += 1;
      continue;
    }
    throw new TypeError(`unknown argument: ${option}`);
  }
  if (staticOnly && authorization !== null) throw new TypeError("--static-only cannot include live authorization");
  if (!staticOnly && authorization !== FUNCTIONAL_AUTHORIZATION) {
    throw new Error(`live B4 HMI verification requires authorization for exactly ${FUNCTIONAL_AUTHORIZATION} external model requests`);
  }
  return Object.freeze({ staticOnly, authorizedMaxExternalModelRequests: authorization });
}

export async function runStaticB4Verification({ log = true } = {}) {
  const profile = BENCHMARK_PROFILES[FUNCTIONAL_PROFILE];
  const plan = buildRunPlan({ profile: FUNCTIONAL_PROFILE });
  assert.equal(profile.scenarioIds.length, 6);
  assert.equal(profile.repeats, 1);
  assert.equal(plan.maxExternalModelRequests, FUNCTIONAL_AUTHORIZATION);

  const withinBudget = applyObservedModelRequestBudget({
    scenario: B4_BENCHMARK_SCENARIOS["conversation-general"],
    projectedMetrics: {
      outcome: "passed", contractErrors: [], budgetErrors: [], modelRequests: 1, modelCallCount: 1,
    },
    observedExternalModelRequestCount: 1,
  });
  assert.equal(withinBudget.outcome, "passed");
  assert.equal(withinBudget.modelRequests, 1,
    "formal modelRequests must equal the observed actual Provider count");
  const overBudget = applyObservedModelRequestBudget({
    scenario: B4_BENCHMARK_SCENARIOS["conversation-general"],
    projectedMetrics: {
      outcome: "passed", contractErrors: [], budgetErrors: [], modelRequests: 2, modelCallCount: 2,
    },
    observedExternalModelRequestCount: 3,
  });
  assert.equal(overBudget.outcome, "contract-failed");
  assert.equal(overBudget.modelRequests, 3);

  const projectedEvidence = projectPublicHmiEvidence({
    probeResult: {
      runDebug: {
        requestId: "run:fixture",
        events: [
          publicEvent("run:fixture", 1, "orchestratorModel", "task-planning", "failed", {
            reasonCode: "generation-timeout",
          }),
          publicEvent("run:fixture", 2, "orchestratorModel", "task-planning", "failed", {
            reasonCode: "sk-secret123",
          }),
        ],
        result: {},
      },
      browserObservation: {
        submittedAtPerf: 1, firstFeedbackAtPerf: 2, resultVisibleAtPerf: 3,
        resultVisibleRunId: "run:fixture",
        animationConfirmedAtPerf: null, animationCommandId: null, modelRequestCount: 1,
        externalModelRequestCount: 1,
        safetyCallCount: 0, toolCallCount: 0, adapterAcceptedCount: 0, providerCallCount: 0,
        providerAcceptedCount: 0, providerStateChangeCount: 0,
      },
    },
    publicDebug: { detailCards: [{ cardKind: "b2-plan", visible: true }], interactionEvents: [] },
  });
  assert.equal(projectedEvidence.runId, "run:fixture");
  assert.deepEqual(projectedEvidence.visibleCardKinds, ["b2-plan"]);
  assert.equal(projectedEvidence.events[0].reasonCode, "generation-timeout",
    "bounded model failure reasonCode must survive public projection");
  assert.equal(projectedEvidence.events[1].reasonCode, null,
    "unbounded provider output must not enter public benchmark diagnostics");

  const missingModelEvidence = projectPublicHmiEvidence({
    probeResult: {
      runDebug: {
        requestId: "run:missing-model",
        events: [],
        result: { requestId: "run:missing-model", parsedCommand: { needsClarification: false } },
      },
      browserObservation: {
        submittedAtPerf: 1, firstFeedbackAtPerf: 2, resultVisibleAtPerf: 3,
        resultVisibleRunId: "run:missing-model",
        safetyCallCount: 0, toolCallCount: 0, adapterAcceptedCount: 0, providerCallCount: 0,
        providerAcceptedCount: 0, providerStateChangeCount: 0,
      },
    },
    publicDebug: { detailCards: [], interactionEvents: [] },
  });
  assert.equal(missingModelEvidence.observedModelRequestCount, null);
  assert.equal(missingModelEvidence.observedExternalModelRequestCount, null);
  assert.equal(missingModelEvidence.instrumentation.modelRequestCount, false);
  assert.equal(missingModelEvidence.instrumentation.complete, false);

  const missingCounterEvidence = projectPublicHmiEvidence({
    probeResult: {
      runDebug: {
        requestId: "run:missing-counter",
        events: [],
        result: { requestId: "run:missing-counter", parsedCommand: { needsClarification: false } },
      },
      browserObservation: {
        submittedAtPerf: 1, firstFeedbackAtPerf: 2, resultVisibleAtPerf: 3,
        resultVisibleRunId: "run:missing-counter",
        modelRequestCount: 0, externalModelRequestCount: 0,
        safetyCallCount: 0, toolCallCount: 0,
        adapterAcceptedCount: 0, providerCallCount: 0,
        providerAcceptedCount: 0, providerStateChangeCount: 0,
      },
    },
    publicDebug: {
      detailCards: [],
      interactionEvents: [],
      instrumentation: {
        modelRequestCount: true,
        externalModelRequestCount: true,
        safetyCallCount: false,
        toolCallCount: false,
        adapterAcceptedCount: false,
        providerCallCount: false,
        providerAcceptedCount: false,
        providerStateChangeCount: false,
      },
    },
  });
  assert.equal(missingCounterEvidence.counters.adapterAcceptedCount, null);
  assert.equal(missingCounterEvidence.instrumentation.adapterAcceptedCount, false);
  assert.equal(missingCounterEvidence.instrumentation.complete, false);

  const normalizedMissingCounterSample = sampleFromProbe(
    { sampleKey: "conversation-general:1", scenarioId: "conversation-general", repeat: 1 },
    B4_BENCHMARK_SCENARIOS["conversation-general"],
    {
      runDebug: {
        requestId: "run:normalized-missing-counters",
        startedAtPerf: 1,
        endedAtPerf: 3,
        events: [],
        result: { requestId: "run:normalized-missing-counters", parsedCommand: { needsClarification: false } },
      },
      browserObservation: {
        submittedAtPerf: 1, firstFeedbackAtPerf: 2, resultVisibleAtPerf: 3,
        resultVisibleRunId: "run:normalized-missing-counters",
        modelRequestCount: 0, externalModelRequestCount: 0,
        safetyCallCount: 0, toolCallCount: 0,
        adapterAcceptedCount: 0, providerCallCount: 0,
        providerAcceptedCount: 0, providerStateChangeCount: 0,
      },
      publicHmiEvidence: missingCounterEvidence,
    },
    "2026-08-03T00:00:00.000Z",
    "2026-08-03T00:00:01.000Z",
  );
  assert.equal(normalizedMissingCounterSample.projectedMetrics.outcome, "contract-failed");

  const missingInstrumentationSample = sampleFromProbe(
    { sampleKey: "conversation-general:1", scenarioId: "conversation-general", repeat: 1 },
    B4_BENCHMARK_SCENARIOS["conversation-general"],
    {
      runDebug: {
        requestId: "run:missing-model",
        startedAtPerf: 1,
        endedAtPerf: 3,
        events: [],
        result: { requestId: "run:missing-model", parsedCommand: { needsClarification: false } },
      },
      browserObservation: {
        submittedAtPerf: 1, firstFeedbackAtPerf: 2, resultVisibleAtPerf: 3,
        resultVisibleRunId: "run:missing-model",
        safetyCallCount: 0, toolCallCount: 0, adapterAcceptedCount: 0, providerCallCount: 0,
        providerAcceptedCount: 0, providerStateChangeCount: 0,
      },
      publicHmiEvidence: missingModelEvidence,
    },
    "2026-08-03T00:00:00.000Z",
    "2026-08-03T00:00:01.000Z",
  );
  assert.equal(missingInstrumentationSample.projectedMetrics.outcome, "contract-failed");
  assert.equal(missingInstrumentationSample.projectedMetrics.modelRequests, null,
    "missing external telemetry must not fall back to HTTP or model-event counts");
  const chainedReport = buildBenchmarkReport({
    profile: FUNCTIONAL_PROFILE,
    environment: REPORT_ENVIRONMENT_FIXTURE,
    samples: [missingInstrumentationSample],
    generatedAt: "2026-08-03T00:00:02.000Z",
    idFactory: () => "task7-public-evidence-chain",
  });
  assert.deepEqual(
    chainedReport.samples[0].diagnostics.publicHmiEvidence,
    missingModelEvidence,
    "public HMI diagnostics must survive projection, sampling, and report normalization",
  );
  assert.match(validateFunctionalSmokeReport(chainedReport).join("; "), /exactly six samples/);

  const validFixture = fixtureReport();
  assert.deepEqual(validateFunctionalSmokeReport(validFixture), []);
  let liveRunnerArgs = null;
  await runLiveB4Verification({
    authorizedMaxExternalModelRequests: FUNCTIONAL_AUTHORIZATION,
    runner: async (args) => {
      liveRunnerArgs = [...args];
      return { report: validFixture };
    },
  });
  assert.equal(liveRunnerArgs.includes("--fail-fast"), true,
    "functional live acceptance must stop after its first non-passing sample");
  const visibleFailure = structuredClone(validFixture);
  visibleFailure.outcome = "blocked";
  visibleFailure.samples[0].outcome = "run-degraded";
  visibleFailure.samples[0].projectedMetrics.outcome = "run-degraded";
  assert.equal(visibleFailure.samples[0].diagnostics.publicHmiEvidence.resultVisible, true);
  assert.match(validateFunctionalSmokeReport(visibleFailure).join("; "), /sample-nonpassing/);
  assertFixtureMutationRejected(validFixture, (report) => {
    const sample = report.samples.find((candidate) => candidate.scenarioId === "conversation-general");
    sample.diagnostics.publicHmiEvidence.observedExternalModelRequestCount = null;
  }, /count-invalid/);
  assertFixtureMutationRejected(validFixture, (report) => {
    const sample = report.samples.find((candidate) => candidate.scenarioId === "conversation-general");
    sample.diagnostics.publicHmiEvidence.observedExternalModelRequestCount = 7;
    sample.projectedMetrics.modelRequests = 7;
  }, /budget-exceeded/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "conversation-general")
      .projectedMetrics.modelRequests = 1;
  }, /count-mismatch/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "conversation-general")
      .diagnostics.publicHmiEvidence.observedModelRequestCount = 1;
  }, /Runtime model phase calls count-mismatch/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "conversation-general")
      .diagnostics.publicHmiEvidence.resultVisibleRunId = "run:other";
  }, /result visibility Run ownership mismatch/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "conversation-general")
      .projectedMetrics.behavior.vehicleWrites = 1;
  }, /read-only scenario reported a vehicle write/);
  assertFixtureMutationRejected(validFixture, (report) => {
    const evidence = report.samples.find((sample) => sample.scenarioId === "vehicle-knowledge")
      .diagnostics.publicHmiEvidence;
    evidence.visibleCardKinds = evidence.visibleCardKinds.filter((kind) => kind !== "b3-vehicle-knowledge");
  }, /direct route must show Cabin\/B3 truth/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "vehicle-knowledge")
      .diagnostics.publicHmiEvidence.visibleCardKinds.push("b2-plan");
  }, /direct route must show Cabin\/B3 truth/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "vehicle-knowledge")
      .diagnostics.publicHmiEvidence.events.reverse();
  }, /plan\/event sequence/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "vehicle-knowledge")
      .diagnostics.publicHmiEvidence.result.toolCallPresent = true;
  }, /must not expose Vehicle ToolCall/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "vehicle-control-safe")
      .diagnostics.publicHmiEvidence.interactionRunIds = ["run:vehicle-control-safe"];
  }, /did not produce a second owned Run/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "vehicle-control-safe")
      .diagnostics.publicHmiEvidence.events.reverse();
  }, /Safety allow must precede/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "vehicle-control-safe")
      .diagnostics.publicHmiEvidence.result.confirmedSnapshotId = "snapshot:mismatch";
  }, /Provider-confirmed snapshot evidence/);
  assertFixtureMutationRejected(validFixture, (report) => {
    report.samples.find((sample) => sample.scenarioId === "vehicle-control-safe")
      .diagnostics.publicHmiEvidence.animationCommandId = "command:mismatch";
  }, /animation command identity/);
  assertFixtureMutationRejected(validFixture, (report) => {
    const evidence = report.samples.find((sample) => sample.scenarioId === "vehicle-control-unsafe")
      .diagnostics.publicHmiEvidence;
    evidence.counters.adapterAcceptedCount = 1;
    evidence.counters.providerCallCount = 1;
  }, /crossed a write boundary/);
  assertFixtureMutationRejected(validFixture, (report) => {
    const evidence = report.samples.find((sample) => sample.scenarioId === "vehicle-control-unsafe")
      .diagnostics.publicHmiEvidence;
    evidence.animationConfirmed = true;
    evidence.animationCommandId = "command:forbidden";
  }, /exposed Tool or animation success/);

  const runnerSource = await readFile(
    new URL("../benchmarks/run-b4-baseline.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(runnerSource.includes("start-local-services"), false);
  assert.equal(runnerSource.includes("restart-local-services"), false);
  assert.equal(runnerSource.includes("stop-local-services"), false);

  const output = Object.freeze({
    static: "PASS",
    profile: FUNCTIONAL_PROFILE,
    scenarioRuns: 6,
    maxExternalModelRequests: FUNCTIONAL_AUTHORIZATION,
    servicesControlled: false,
  });
  if (log) console.log(JSON.stringify(output));
  return output;
}

export async function runLiveB4Verification({
  authorizedMaxExternalModelRequests,
  runner = runB4Baseline,
} = {}) {
  if (authorizedMaxExternalModelRequests !== FUNCTIONAL_AUTHORIZATION) {
    throw new Error(`live B4 HMI verification requires authorization for exactly ${FUNCTIONAL_AUTHORIZATION} external model requests`);
  }
  const result = await runner([
    "--profile", FUNCTIONAL_PROFILE,
    "--fail-fast",
    "--authorized-max-external-model-requests", String(FUNCTIONAL_AUTHORIZATION),
  ]);
  const errors = validateFunctionalSmokeReport(result?.report);
  if (errors.length > 0) throw new Error(`B4 functional HMI verification failed: ${errors.join("; ")}`);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseB4VerifierArgs(argv);
  if (args.staticOnly) return runStaticB4Verification();
  const result = await runLiveB4Verification(args);
  console.log(JSON.stringify({
    status: "PASS", profile: FUNCTIONAL_PROFILE, scenarioRuns: result.report.samples.length,
  }));
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`verify-hmi-b4-baseline: ${error.message}`);
    process.exitCode = 1;
  });
}
