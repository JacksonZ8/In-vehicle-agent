import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildBenchmarkReport,
  renderBenchmarkMarkdown,
  summarizeMetric,
  writeBenchmarkReport,
} from "../../src/benchmark/run-benchmark-report.js";
import { compareBenchmarkReports } from "../../src/benchmark/baseline-comparator.js";
import { BENCHMARK_PROFILES, validateBenchmarkReport } from "../../src/benchmark/run-benchmark-contract.js";
import { B4_BENCHMARK_SCENARIOS } from "../../src/benchmark/run-benchmark-scenarios.js";
import { readBenchmarkEnvironment } from "../lib/b4-benchmark-environment.mjs";

const ISO = "2026-08-03T00:00:00.000Z";
const environment = {
  commitSha: "fixture-sha",
  dirtyWorktree: false,
  platform: "darwin",
  arch: "arm64",
  osRelease: "24.0.0",
  cpuModel: "Apple M4",
  profile: "cold-diagnostic",
  modelIds: ["qwen-plus-2025-12-01"],
  providerIds: ["dashscope"],
  regionIds: ["cn-beijing"],
  timeoutConfig: { phaseTimeoutMs: 90_000, transportTimeoutMs: 90_000, scenarioTimeoutMs: 360_000 },
  serviceConfig: { requiredServiceIds: ["agent-server"], readinessTimeoutMs: 1_000 },
  serviceReadiness: [{ serviceId: "agent-server", status: "ready", checkedAt: ISO }],
  coldStartProof: { status: "observed", verifiedAt: ISO, serviceIds: ["agent-server"] },
};

function publicHmiEvidence(scenarioId, runId) {
  const modelCallCount = B4_BENCHMARK_SCENARIOS[scenarioId].modelBudget.maxCalls;
  const safeControl = scenarioId === "vehicle-control-safe";
  const unsafeControl = scenarioId === "vehicle-control-unsafe";
  const commandId = safeControl ? `command:${runId}` : null;
  const snapshotId = safeControl ? `snapshot:${runId}` : null;
  return {
    runId,
    resultVisibleRunId: runId,
    firstFeedbackObserved: true,
    resultVisible: true,
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
    visibleCardKinds: [safeControl ? "vehicle-control" : "b2-plan"],
    interactionRunIds: safeControl ? [`challenge:${runId}`, runId] : [runId],
    counters: {
      safetyCallCount: safeControl || unsafeControl ? 1 : 0,
      toolCallCount: safeControl ? 1 : 0,
      adapterAcceptedCount: safeControl ? 1 : 0,
      providerCallCount: safeControl ? 1 : 0,
      providerAcceptedCount: safeControl ? 1 : 0,
      providerStateChangeCount: safeControl ? 1 : 0,
    },
    events: [{
      eventId: `event:${runId}:1`,
      parentEventId: null,
      sequence: 1,
      component: "runtimeKernel",
      componentType: "deterministic-service",
      phase: "intake",
      status: "completed",
      refs: [],
      reasonCode: null,
      durationMs: null,
    }, {
      eventId: `event:${runId}:2`,
      parentEventId: `event:${runId}:1`,
      sequence: 2,
      component: "vehicleSluModel",
      componentType: "model-service",
      phase: "route-decision",
      status: "completed",
      refs: [],
      reasonCode: null,
      durationMs: 20,
    }, {
      eventId: `event:${runId}:3`,
      parentEventId: `event:${runId}:2`,
      sequence: 3,
      component: "cabinAssistant",
      componentType: "ai-agent",
      phase: "final-response",
      status: "completed",
      refs: [],
      reasonCode: "generation-timeout",
      durationMs: null,
    }],
    result: {
      safetyAllowed: safeControl ? true : unsafeControl ? false : null,
      toolCallPresent: safeControl,
      toolResultPresent: safeControl,
      executionState: safeControl ? "observed-succeeded" : null,
      toolCommandId: commandId,
      resultCommandId: commandId,
      snapshotId,
      confirmedSnapshotId: snapshotId,
      snapshotCapturedAt: safeControl ? ISO : null,
      executionTrace: [],
    },
    animationConfirmed: safeControl,
    animationCommandId: commandId,
  };
}

function sample(scenarioId, repeat, durationMs, overrides = {}, latency = {}) {
  const sampleId = `${scenarioId}:${repeat}`;
  const scenario = B4_BENCHMARK_SCENARIOS[scenarioId];
  const modelCallCount = scenario.modelBudget.maxCalls;
  const safeControl = scenarioId === "vehicle-control-safe";
  const phaseValues = Object.fromEntries(scenario.modelBudget.allowedPhases.map((phaseId) => [
    phaseId,
    { value: phaseId === "route-decision" ? 50 : 100 },
  ]));
  const slowestPhaseId = scenario.modelBudget.allowedPhases.find((phaseId) => phaseId !== "route-decision")
    || scenario.modelBudget.allowedPhases[0]
    || null;
  return {
    sampleId,
    sampleKey: sampleId,
    runId: `run:${scenarioId}:${repeat}`,
    scenarioId,
    repeat,
    timestamps: { startedAt: ISO, completedAt: "2026-08-03T00:00:01.000Z" },
    projectedMetrics: {
      outcome: "passed",
      durationMs,
      modelRequests: modelCallCount,
      modelCallCount,
      submissionToFirstFeedbackMs: latency.firstFeedbackMs ?? 20,
      submissionToResultVisibleMs: latency.resultVisibleMs ?? 80,
      phases: phaseValues,
      slowestPhase: slowestPhaseId
        ? { phaseId: slowestPhaseId, durationMs: phaseValues[slowestPhaseId].value }
        : null,
      animation: safeControl ? { value: true } : { value: null, reason: "animation-not-required" },
      voice: null,
      behavior: {
        resultCategory: scenario.expected.resultCategory,
        dispatchAuthorized: safeControl,
        adapterExecutions: safeControl ? 1 : 0,
        vehicleToolCalls: safeControl ? 1 : 0,
        vehicleWrites: safeControl ? 1 : 0,
        safetyWriteDecisions: safeControl ? 1 : 0,
        providerConfirmation: safeControl,
        unsafeProviderExecution: false,
        executionFactsComplete: true,
      },
      contractErrors: [],
      eventSequenceErrors: [],
      budgetErrors: [],
    },
    eventRefs: ["run-event:fixture"],
    simulated: scenario.simulated,
    diagnostics: { code: "none", publicHmiEvidence: publicHmiEvidence(scenarioId, `run:${scenarioId}:${repeat}`) },
    ...overrides,
  };
}

const samples = [
  sample("conversation-general", 1, 100),
  sample("vehicle-knowledge", 1, 200),
];

function reportWithMedian(median) {
  const report = buildBenchmarkReport({
    profile: "cold-diagnostic",
    environment,
    samples: [sample("conversation-general", 1, median), sample("vehicle-knowledge", 1, median)],
    generatedAt: ISO,
  });
  return report;
}

assert.deepEqual(summarizeMetric([30, 10, 20]), {
  count: 3, min: 10, median: 20, max: 30, p95: null,
});
assert.deepEqual(summarizeMetric([null, 10]), {
  count: 1, min: 10, median: 10, max: 10, p95: null,
}, "unavailable external-call counts must be omitted instead of fabricated as zero");
assert.equal(summarizeMetric(Array.from({ length: 20 }, (_, index) => index + 1)).p95, 19);

const report = buildBenchmarkReport({ profile: "cold-diagnostic", environment, samples, generatedAt: ISO });
assert.deepEqual(validateBenchmarkReport(report), []);
assert.equal(Object.hasOwn(report.samples[0], "sampleKey"), false,
  "the checkpoint-only sampleKey must not enter a final report sample");
assert.equal(report.samples[0].diagnostics.publicHmiEvidence.resultVisibleRunId, report.samples[0].runId);
assert.equal(report.samples[0].diagnostics.publicHmiEvidence.observedExternalModelRequestCount, 2);
assert.equal(
  report.samples[0].diagnostics.publicHmiEvidence.events[2].reasonCode,
  "generation-timeout",
  "canonical report must retain a bounded public event reasonCode",
);
assert.ok(Object.isFrozen(report) && Object.isFrozen(report.environment) && Object.isFrozen(report.samples));
assert.notEqual(
  report.reportId,
  buildBenchmarkReport({ profile: "cold-diagnostic", environment, samples, generatedAt: ISO }).reportId,
  "a final report writer must not reuse a report ID",
);
assert.throws(
  () => buildBenchmarkReport({
    profile: "cold-diagnostic",
    environment,
    samples: [sample("conversation-general", 1, 100, {
      projectedMetrics: undefined,
      metrics: {
        outcome: "passed", durationMs: 100, modelRequests: 1,
        phases: { "goal-formation": { value: 100 } }, behavior: { resultCategory: "answered" },
      },
    }), sample("vehicle-knowledge", 1, 200)],
    generatedAt: ISO,
  }),
  /projectedMetrics|allowed/,
  "a caller-supplied metrics object must not bypass the Task 2 projector",
);
assert.deepEqual(report.scenarios.map((entry) => entry.scenarioId), ["conversation-general", "vehicle-knowledge"]);
assert.deepEqual(report.metrics.durationMs, { count: 2, min: 100, median: 150, max: 200, p95: null });
assert.equal(report.scenarios[1].slowestPhase.phaseId, "knowledge-answer");
assert.equal(report.scenarios[0].behaviorOutcome, "answered");

function warmSamples(conversationLatencies) {
  return BENCHMARK_PROFILES["warm-baseline"].scenarioIds.flatMap((scenarioId) => Array.from(
    { length: BENCHMARK_PROFILES["warm-baseline"].repeats },
    (_, index) => sample(scenarioId, index + 1, 100, {}, {
      resultVisibleMs: scenarioId === "conversation-general" ? conversationLatencies[index] : 100,
    }),
  ));
}

const warmReportEnvironment = {
  ...environment,
  profile: "warm-baseline",
  coldStartProof: { status: "not-applicable", verifiedAt: null, serviceIds: [] },
};
assert.equal(BENCHMARK_PROFILES["warm-baseline"].performanceGate, true,
  "warm-baseline must opt into the report-level median performance gate");
const warmMedianPass = buildBenchmarkReport({
  profile: "warm-baseline",
  environment: warmReportEnvironment,
  samples: warmSamples([1_000, 1_000, 7_001]),
  generatedAt: ISO,
});
assert.equal(warmMedianPass.outcome, "passed",
  "two fast and one slow chat sample must pass because the median is within the 7 second chat contract");
const warmMedianFail = buildBenchmarkReport({
  profile: "warm-baseline",
  environment: warmReportEnvironment,
  samples: warmSamples([7_001, 7_001, 1_000]),
  generatedAt: ISO,
});
assert.equal(warmMedianFail.outcome, "contract-failed",
  "two slow and one fast chat sample must fail because the median exceeds the 7 second chat contract");
const forgedWarmMedianPass = structuredClone(warmMedianFail);
forgedWarmMedianPass.outcome = "passed";
forgedWarmMedianPass.behaviorGate.outcome = "passed";
assert.ok(
  validateBenchmarkReport(forgedWarmMedianPass).some((error) => /performance|median/i.test(error)),
  "the report validator must independently reject a forged passing outcome over the warm median gate",
);
for (const [field, label] of [
  ["submissionToFirstFeedbackMs", "feedback"],
  ["submissionToResultVisibleMs", "result visibility"],
]) {
  const missingTelemetrySamples = warmSamples([1_000, 1_000, 1_000]);
  missingTelemetrySamples.find((candidate) => (
    candidate.scenarioId === "conversation-general" && candidate.repeat === 3
  )).projectedMetrics[field] = null;
  const missingTelemetryReport = buildBenchmarkReport({
    profile: "warm-baseline",
    environment: warmReportEnvironment,
    samples: missingTelemetrySamples,
    generatedAt: ISO,
  });
  assert.equal(missingTelemetryReport.outcome, "contract-failed",
    `missing warm ${label} telemetry must fail closed`);
  const forgedMissingTelemetryPass = structuredClone(missingTelemetryReport);
  forgedMissingTelemetryPass.outcome = "passed";
  forgedMissingTelemetryPass.behaviorGate.outcome = "passed";
  assert.ok(validateBenchmarkReport(forgedMissingTelemetryPass).some(
    (error) => /performance|median/i.test(error),
  ), `the validator must independently reject missing warm ${label} telemetry`);
}

const missingExternalTelemetry = structuredClone(samples[0]);
missingExternalTelemetry.projectedMetrics.outcome = "contract-failed";
missingExternalTelemetry.projectedMetrics.contractErrors = ["public probe instrumentation is unavailable"];
missingExternalTelemetry.projectedMetrics.modelRequests = null;
missingExternalTelemetry.projectedMetrics.modelCallCount = null;
missingExternalTelemetry.diagnostics.code = "contract-failed";
missingExternalTelemetry.diagnostics.publicHmiEvidence.observedModelRequestCount = null;
missingExternalTelemetry.diagnostics.publicHmiEvidence.observedExternalModelRequestCount = null;
missingExternalTelemetry.diagnostics.publicHmiEvidence.instrumentation.modelRequestCount = false;
missingExternalTelemetry.diagnostics.publicHmiEvidence.instrumentation.externalModelRequestCount = false;
missingExternalTelemetry.diagnostics.publicHmiEvidence.instrumentation.complete = false;
const unavailableCountReport = buildBenchmarkReport({
  profile: "cold-diagnostic",
  environment,
  samples: [missingExternalTelemetry, samples[1]],
  generatedAt: ISO,
});
assert.equal(unavailableCountReport.samples[0].metrics.modelRequests, null);
assert.deepEqual(unavailableCountReport.metrics.modelRequests, {
  count: 1, min: 2, median: 2, max: 2, p95: null,
});

function assertRawSampleMutationRejected(label, mutate) {
  const mutated = structuredClone(samples);
  mutate(mutated[0]);
  assert.throws(
    () => buildBenchmarkReport({ profile: "cold-diagnostic", environment, samples: mutated, generatedAt: ISO }),
    /allowed|canonical|sample|field|key|evidence|match|visible|animation|counter|behavior|receipt|command|toolresult|execution/i,
    `report builder must reject ${label}`,
  );
}

for (const [label, mutate] of [
  ["a safe-named raw sample payload", (value) => { value.note = "raw response"; }],
  ["a safe-named diagnostics payload", (value) => { value.diagnostics.note = "raw response"; }],
  ["a projected response payload", (value) => { value.projectedMetrics.responseText = "raw response"; }],
  ["a public evidence payload", (value) => {
    value.diagnostics.publicHmiEvidence.note = "raw response";
  }],
  ["an unsafe public event reasonCode", (value) => {
    value.diagnostics.publicHmiEvidence.events[0].reasonCode = "sk-secret123";
  }],
  ["a completed sample without public evidence", (value) => {
    delete value.diagnostics.publicHmiEvidence;
  }],
  ["a dispatch authorization contradicted by complete zero execution counters", (value) => {
    value.projectedMetrics.behavior.dispatchAuthorized = true;
  }],
  ["an unsafe-provider flag contradicted by complete zero execution counters", (value) => {
    value.projectedMetrics.behavior.unsafeProviderExecution = true;
  }],
  ["an execution-completeness flag contradicted by five present valid counters", (value) => {
    value.projectedMetrics.behavior.executionFactsComplete = false;
  }],
  ["a projected safety-write count contradicted by public facts", (value) => {
    value.projectedMetrics.behavior.safetyWriteDecisions = 1;
  }],
  ["a projected tool-call count contradicted by public counters", (value) => {
    value.projectedMetrics.behavior.vehicleToolCalls = 1;
  }],
  ["a projected adapter count contradicted by public counters", (value) => {
    value.projectedMetrics.behavior.adapterExecutions = 1;
  }],
  ["a projected vehicle-write count contradicted by public counters", (value) => {
    value.projectedMetrics.behavior.vehicleWrites = 1;
  }],
  ["a projected provider confirmation contradicted by public facts", (value) => {
    value.projectedMetrics.behavior.providerConfirmation = true;
  }],
  ["a projected animation contradicted by public facts", (value) => {
    value.projectedMetrics.animation = { value: true };
  }],
  ["a public animation contradicted by projected facts", (value) => {
    value.diagnostics.publicHmiEvidence.animationConfirmed = true;
    value.diagnostics.publicHmiEvidence.animationCommandId = "command:fixture";
  }],
  ["a passed sample without a visible final result", (value) => {
    value.diagnostics.publicHmiEvidence.resultVisible = false;
    value.diagnostics.publicHmiEvidence.resultVisibleRunId = null;
  }],
  ["a tool command ID without a Runtime ToolCall", (value) => {
    value.diagnostics.publicHmiEvidence.result.toolCommandId = "command:orphan-tool-call";
  }],
  ["a result command ID without a Runtime ToolResult", (value) => {
    value.diagnostics.publicHmiEvidence.result.resultCommandId = "command:orphan-tool-result";
  }],
  ["an execution state without a Runtime ToolResult", (value) => {
    value.diagnostics.publicHmiEvidence.result.executionState = "submitted";
  }],
  ["a confirmed snapshot ID without a Runtime ToolResult", (value) => {
    value.diagnostics.publicHmiEvidence.result.confirmedSnapshotId = "snapshot:orphan-tool-result";
  }],
  ["an execution trace without a Runtime ToolResult", (value) => {
    value.diagnostics.publicHmiEvidence.result.executionTrace = [{
      state: "submitted", at: ISO, source: "vehicle-adapter",
    }];
  }],
  ["an execution-trace payload", (value) => {
    value.diagnostics.publicHmiEvidence.result.executionTrace = [{
      state: "submitted", at: ISO, source: "vehicle-adapter", note: "raw response",
    }];
  }],
  ["fault receipt metadata outside the fault profile", (value) => {
    value.diagnostics.benchmarkFaultReceipt = {
      faultId: "goal-formation-timeout",
      stage: "goal-formation",
      target: "structured-model",
      code: "generation-timeout",
      retryable: true,
      simulated: true,
      note: "raw response",
    };
  }],
]) {
  assertRawSampleMutationRejected(label, mutate);
}

assert.throws(
  () => buildBenchmarkReport({
    profile: "cold-diagnostic",
    environment,
    samples: [...samples, structuredClone(samples[0])],
    generatedAt: ISO,
  }),
  /duplicate|exact|planned|sample/i,
  "a passing report must reject a duplicate planned scenario/repeat",
);
const extraRepeat = structuredClone(samples[0]);
extraRepeat.sampleId = "conversation-general:2";
extraRepeat.sampleKey = "conversation-general:2";
extraRepeat.runId = "run:conversation-general:2";
extraRepeat.repeat = 2;
extraRepeat.diagnostics.publicHmiEvidence.runId = extraRepeat.runId;
extraRepeat.diagnostics.publicHmiEvidence.resultVisibleRunId = extraRepeat.runId;
extraRepeat.diagnostics.publicHmiEvidence.interactionRunIds = [extraRepeat.runId];
assert.throws(
  () => buildBenchmarkReport({
    profile: "cold-diagnostic", environment, samples: [...samples, extraRepeat], generatedAt: ISO,
  }),
  /extra|exact|planned|sample/i,
  "a passing report must reject an extra repeat",
);
const duplicateSampleId = structuredClone(samples);
duplicateSampleId[1].sampleId = duplicateSampleId[0].sampleId;
duplicateSampleId[1].sampleKey = duplicateSampleId[0].sampleKey;
assert.throws(
  () => buildBenchmarkReport({ profile: "cold-diagnostic", environment, samples: duplicateSampleId, generatedAt: ISO }),
  /sampleId|sampleKey|canonical|duplicate/i,
  "a passing report must reject a duplicate sample ID",
);
const mismatchedSampleId = structuredClone(samples);
mismatchedSampleId[0].sampleId = "fixture-safe-id";
assert.throws(
  () => buildBenchmarkReport({ profile: "cold-diagnostic", environment, samples: mismatchedSampleId, generatedAt: ISO }),
  /sampleId|canonical/i,
  "a sample ID must equal scenarioId:repeat",
);

const markdown = renderBenchmarkMarkdown(report);
for (const expected of ["conversation-general", "count", "min/median/max", "slowest phase", "behavior outcome", "degraded reason", "comparison"]) {
  assert.match(markdown, new RegExp(expected, "i"), `Markdown must include ${expected}`);
}

assert.equal(compareBenchmarkReports({
  baseline: reportWithMedian(100),
  candidate: reportWithMedian(121),
  warningRatio: 0.20,
}).status, "regression-warning");
assert.equal(compareBenchmarkReports({
  baseline: reportWithMedian(100),
  candidate: buildBenchmarkReport({
    profile: "cold-diagnostic",
    environment: { ...environment, modelIds: ["different-model"] },
    samples,
    generatedAt: ISO,
  }),
}).status, "blocked-environment-mismatch");
assert.equal(compareBenchmarkReports({
  baseline: reportWithMedian(100),
  candidate: { ...reportWithMedian(100), protocol: { id: "other-report", version: "1.0.0" } },
}).status, "blocked-environment-mismatch");

for (const key of ["rawPrompt", "prompt", "modelOutput", "authorization", "apiKey", "cwd", "username"]) {
  const unsafe = {
    ...environment,
    nested: { [key]: "secret" },
  };
  assert.throws(
    () => buildBenchmarkReport({ profile: "cold-diagnostic", environment: unsafe, samples, generatedAt: ISO }),
    /sensitive|allowed/i,
    `report builder must reject recursively unsafe ${key}`,
  );
}

const observedEnvironment = readBenchmarkEnvironment({
  cwd: process.cwd(),
  profile: "cold-diagnostic",
  serviceProfile: {
    modelIds: ["qwen-plus-2025-12-01"],
    providerIds: ["dashscope"],
    regionIds: ["cn-beijing"],
    timeoutConfig: {
      phaseTimeoutMs: 90_000, transportTimeoutMs: 90_000, scenarioTimeoutMs: 360_000,
      fullCommand: "forbidden",
    },
    serviceConfig: { requiredServiceIds: ["agent-server"], readinessTimeoutMs: 1_000 },
    serviceReadiness: [{ serviceId: "agent-server", status: "ready", checkedAt: ISO }],
    coldStartTelemetry: { observed: true, verifiedAt: ISO, serviceIds: ["agent-server"] },
  },
});
assert.deepEqual(Object.keys(observedEnvironment).sort(), [
  "arch", "coldStartProof", "commitSha", "cpuModel", "dirtyWorktree", "modelIds", "osRelease", "platform",
  "profile", "providerIds", "regionIds", "serviceConfig", "serviceReadiness", "timeoutConfig",
].sort());
assert.equal(observedEnvironment.coldStartProof.status, "observed");
assert.ok(Object.isFrozen(observedEnvironment));
assert.deepEqual(observedEnvironment.timeoutConfig, {
  phaseTimeoutMs: 90_000, transportTimeoutMs: 90_000, scenarioTimeoutMs: 360_000,
});

const warmEnvironment = readBenchmarkEnvironment({
  cwd: process.cwd(),
  profile: "warm-baseline",
  serviceProfile: {
    modelIds: ["qwen-plus-2025-12-01"], providerIds: ["dashscope"], regionIds: ["cn-beijing"],
    timeoutConfig: { phaseTimeoutMs: 90_000, transportTimeoutMs: 90_000, scenarioTimeoutMs: 360_000 },
    serviceConfig: { requiredServiceIds: ["agent-server"], readinessTimeoutMs: 1_000 },
    serviceReadiness: [{ serviceId: "agent-server", status: "ready", checkedAt: ISO }],
    coldStartTelemetry: { observed: true, verifiedAt: ISO, serviceIds: ["agent-server"] },
  },
});
assert.deepEqual(warmEnvironment.coldStartProof, { status: "not-applicable", verifiedAt: null, serviceIds: [] });

const invalidColdEnvironment = readBenchmarkEnvironment({
  cwd: process.cwd(),
  profile: "cold-diagnostic",
  serviceProfile: {
    modelIds: ["qwen-plus-2025-12-01"], providerIds: ["dashscope"], regionIds: ["cn-beijing"],
    timeoutConfig: { phaseTimeoutMs: 90_000, transportTimeoutMs: 90_000, scenarioTimeoutMs: 360_000 },
    serviceConfig: { requiredServiceIds: ["agent-server"], readinessTimeoutMs: 1_000 },
    serviceReadiness: [{ serviceId: "agent-server", status: "ready", checkedAt: ISO }],
    coldStartTelemetry: { observed: true, verifiedAt: "not-an-iso-time", serviceIds: [] },
  },
});
assert.deepEqual(invalidColdEnvironment.coldStartProof, { status: "unverified", verifiedAt: null, serviceIds: [] });

const stableReport = buildBenchmarkReport({
  profile: "cold-diagnostic", environment, samples, generatedAt: ISO, idFactory: () => "report-immutable",
});
const outputRoot = mkdtempSync(join(tmpdir(), "b4-report-writer-"));
try {
  const written = writeBenchmarkReport({ report: stableReport, outputRoot });
  const jsonBefore = readFileSync(written.jsonPath);
  const markdownBefore = readFileSync(written.markdownPath);
  assert.throws(() => writeBenchmarkReport({ report: stableReport, outputRoot }), /exist|overwrite/i);
  assert.deepEqual(readFileSync(written.jsonPath), jsonBefore);
  assert.deepEqual(readFileSync(written.markdownPath), markdownBefore);
  assert.throws(
    () => writeBenchmarkReport({ report: { ...stableReport, reportId: "../outside-output-root" }, outputRoot }),
    /safe reportId/,
    "a writer must keep the final report directory under outputRoot",
  );

  const failedOutputRoot = mkdtempSync(join(tmpdir(), "b4-report-writer-failure-"));
  try {
    const renderFailureReport = { ...stableReport, reportId: "benchmark-render-failure" };
    delete renderFailureReport.scenarios;
    assert.throws(
      () => writeBenchmarkReport({ report: renderFailureReport, outputRoot: failedOutputRoot }),
      /canonical|scenarios|allowed/,
      "an incomplete canonical report must fail before a final directory is created",
    );
    assert.equal(existsSync(join(failedOutputRoot, renderFailureReport.reportId)), false);
    assert.deepEqual(readdirSync(failedOutputRoot), []);

    let writes = 0;
    const secondWriteFailureFs = {
      mkdirSync,
      renameSync,
      rmSync,
      existsSync,
      writeFileSync(path, data, options) {
        writes += 1;
        if (writes === 2) throw new Error("injected second write failure");
        return writeFileSync(path, data, options);
      },
    };
    const writeFailureReport = { ...stableReport, reportId: "benchmark-write-failure" };
    assert.throws(
      () => writeBenchmarkReport({
        report: writeFailureReport, outputRoot: failedOutputRoot, fs: secondWriteFailureFs, idFactory: () => "test-temp",
      }),
      /injected second write failure/,
      "a failed temporary Markdown write must not publish a final directory",
    );
    assert.equal(existsSync(join(failedOutputRoot, writeFailureReport.reportId)), false);
    assert.deepEqual(readdirSync(failedOutputRoot), []);
  } finally {
    rmSync(failedOutputRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: "PASS", reportId: report.reportId, scenarioCount: report.scenarios.length }));
