import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBenchmarkScenario } from "../../src/benchmark/run-benchmark-scenarios.js";
import { projectRunMetrics } from "../../src/benchmark/run-metric-projector.js";
import { B4_FAULT_SAMPLE_PLAN } from "../../src/benchmark/run-benchmark-sample-contract.js";
import { buildInteractionSessionDebugSnapshot } from "../../src/app/run-event-presenter.js";
import { InteractionSessionController } from "../../src/interaction/interaction-session-controller.js";
import { InteractionSessionLedger } from "../../src/interaction/interaction-session-ledger.js";
import { createB4BrowserProbe } from "../lib/b4-browser-probe.mjs";
import * as b4RunnerModule from "../benchmarks/run-b4-baseline.mjs";
import {
  parseSingleScenarioArgs,
  projectSingleScenarioDiagnostic,
  projectSingleScenarioFailureDiagnostic,
} from "../benchmarks/run-b4-single-scenario.mjs";
import {
  acquireCheckpointWriterLock,
  applyObservedModelRequestBudget,
  assertAgentServerReady,
  assertLiveAuthorization,
  assertResumeCompatible,
  buildRunPlan,
  createPartialCheckpoint,
  executeMeasuredSamples,
  parseArgs,
  pendingPlanSamples,
  projectBenchmarkServiceProfile,
  releaseCheckpointWriterLock,
  resolveBenchmarkRegion,
  resolveVoiceServiceReadiness,
  sampleFromProbe,
  writePartialCheckpointAtomic,
} from "../benchmarks/run-b4-baseline.mjs";

assert.deepEqual(parseArgs(["--profile", "warm-baseline"]), {
  profile: "warm-baseline",
  repeats: null,
  baselinePath: null,
  outputRoot: "test-results/b4-benchmarks",
  resumePath: null,
  dryRun: false,
  failFast: false,
  authorizedMaxExternalModelRequests: null,
});
assert.equal(parseArgs(["--profile", "warm-baseline", "--repeats", "30"]).repeats, 30);
assert.equal(parseArgs(["--profile", "functional-smoke", "--fail-fast"]).failFast, true);
assert.throws(
  () => parseArgs(["--profile", "warm-baseline", "--repeats", "0"]),
  /positive integer/,
);
assert.throws(() => parseArgs(["--profile", "unknown"]), /unknown benchmark profile/);
assert.throws(() => parseArgs(["--profile"]), /requires a value/);
assert.throws(() => parseArgs(["--profile", "warm-baseline", "--mystery"]), /unknown argument/);
assert.deepEqual(
  parseArgs([
    "--profile", "cold-diagnostic",
    "--baseline", "fixture-baseline.json",
    "--output-root", "fixture-output",
    "--resume", "fixture-partial.json",
    "--dry-run",
    "--authorized-max-external-model-requests", "16",
  ]),
  {
    profile: "cold-diagnostic",
    repeats: null,
    baselinePath: "fixture-baseline.json",
    outputRoot: "fixture-output",
    resumePath: "fixture-partial.json",
    dryRun: true,
    failFast: false,
    authorizedMaxExternalModelRequests: 16,
  },
);

const warmPlan = buildRunPlan({ profile: "warm-baseline", repeats: null });
assert.equal(warmPlan.measuredSamples, 18);
assert.equal(warmPlan.unmeasuredWarmups, 2);
assert.equal(warmPlan.maxExternalModelRequests, 28);
assert.deepEqual(warmPlan.scenarioIds, [
  "conversation-general",
  "weather-readonly",
  "vehicle-knowledge",
  "vehicle-control-safe",
  "vehicle-control-unsafe",
  "clarification",
]);
assert.deepEqual(warmPlan.samples.slice(0, 5).map((sample) => sample.sampleKey), [
  "conversation-general:1",
  "conversation-general:2",
  "conversation-general:3",
  "weather-readonly:1",
  "weather-readonly:2",
]);
assert.deepEqual(warmPlan.warmupScenarioIds, ["conversation-general", "vehicle-knowledge"]);

const functionalPlan = buildRunPlan({ profile: "functional-smoke", repeats: null });
assert.equal(functionalPlan.measuredSamples, 6);
assert.equal(functionalPlan.unmeasuredWarmups, 0);
assert.equal(functionalPlan.maxExternalModelRequests, 8);
assert.doesNotThrow(() => assertLiveAuthorization({
  plan: functionalPlan,
  authorizedMaxExternalModelRequests: 8,
}));
assert.throws(() => assertLiveAuthorization({
  plan: functionalPlan,
  authorizedMaxExternalModelRequests: 7,
}), /exactly 8/);
assert.equal(typeof b4RunnerModule.assertWarmupSamplePassed, "function",
  "warmups must expose a fail-closed sample acceptance boundary before checkpoint completion");
assert.throws(() => b4RunnerModule.assertWarmupSamplePassed({
  scenarioId: "conversation-general",
  projectedMetrics: { outcome: "contract-failed", modelRequests: null },
}, "conversation-general"), /warmup.*external-call contract/i,
"a warmup with missing or invalid external telemetry must stop before checkpoint completion");
assert.throws(() => b4RunnerModule.assertWarmupSamplePassed({
  scenarioId: "conversation-general",
  projectedMetrics: { outcome: "passed", modelRequests: null },
}, "conversation-general"), /warmup.*external-call contract/i,
"a warmup cannot claim passed with an unavailable actual Provider count");
assert.equal(b4RunnerModule.assertWarmupSamplePassed({
  scenarioId: "conversation-general",
  projectedMetrics: { outcome: "passed", modelRequests: 3 },
}, "conversation-general").projectedMetrics.modelRequests, 3);
assert.doesNotThrow(() => assertLiveAuthorization({
  plan: warmPlan,
  authorizedMaxExternalModelRequests: 28,
}));
assert.throws(() => assertLiveAuthorization({
  plan: warmPlan,
  authorizedMaxExternalModelRequests: null,
}), /exactly 28/);

const overriddenWarmPlan = buildRunPlan({ profile: "warm-baseline", repeats: 30 });
assert.equal(overriddenWarmPlan.repeats, 30);
assert.equal(overriddenWarmPlan.measuredSamples, 180);
assert.equal(overriddenWarmPlan.maxExternalModelRequests, 244);
assert.throws(() => assertLiveAuthorization({
  plan: overriddenWarmPlan,
  authorizedMaxExternalModelRequests: 244,
}), /default repeats.*dry-run/i,
  "repeat overrides are planning-only until a versioned report profile authorizes the live run",
);
assert.equal(resolveBenchmarkRegion({ provider: "dashscope" }), "unreported",
  "a public Provider profile without region evidence must not fabricate cn-beijing");
assert.equal(resolveBenchmarkRegion({ provider: "dashscope", regionId: "cn-hangzhou" }), "cn-hangzhou");

{
  let id = 0;
  const sessionController = new InteractionSessionController({
    ledger: new InteractionSessionLedger(),
    now: () => Date.parse("2026-08-05T00:00:00.000Z"),
    setTimer: () => 1,
    clearTimer: () => {},
    createId: (kind) => `${kind}:benchmark:${++id}`,
  });
  sessionController.wake({ provider: "benchmark-history", simulated: true });
  const historical = sessionController.submitTurn({
    rawText: "历史会话",
    trigger: "explicit-hmi",
    relation: "new-goal",
  });
  sessionController.linkRun(historical.turnId, { runId: "run:historical", eventIds: [] });
  sessionController.completeTurn(historical.turnId, { outputMode: "text" });
  sessionController.closeSession({ reasonCode: "explicit-close" });

  sessionController.wake({ provider: "benchmark-current", simulated: true });
  const challenge = sessionController.submitTurn({
    rawText: "打开尾门",
    trigger: "explicit-hmi",
    relation: "new-goal",
  });
  sessionController.linkRun(challenge.turnId, { runId: "run:challenge", eventIds: [] });
  sessionController.completeTurn(challenge.turnId, { outputMode: "text" });
  sessionController.startListening();
  const confirmed = sessionController.submitTurn({
    rawText: "确认",
    trigger: "follow-up",
    relation: "follow-up",
  });
  sessionController.linkRun(confirmed.turnId, {
    runId: "run:confirmed",
    parentRunId: "run:challenge",
    eventIds: [],
  });
  sessionController.completeTurn(confirmed.turnId, { outputMode: "text" });
  sessionController.closeSession({ reasonCode: "explicit-close" });
  const publicDebug = buildInteractionSessionDebugSnapshot(sessionController.getSnapshot());
  assert.equal(publicDebug.currentTurn, null);
  assert.equal(publicDebug.queuedTurn, null);
  assert.equal(publicDebug.interactionSession.sessionId, null);
  assert.deepEqual(publicDebug.relatedRunIds, ["run:challenge", "run:confirmed"]);
  const evidence = b4RunnerModule.projectPublicHmiEvidence({
    probeResult: {
      runDebug: {
        requestId: "run:confirmed",
        result: { interactionRef: { sessionId: confirmed.sessionId, turnId: confirmed.turnId } },
        events: [],
      },
      browserObservation: {
        submittedAtPerf: 1,
        firstFeedbackAtPerf: 2,
        resultVisibleAtPerf: 3,
        resultVisibleRunId: "run:confirmed",
        modelRequestCount: 0,
        externalModelRequestCount: 0,
        safetyCallCount: 0,
        toolCallCount: 0,
        adapterAcceptedCount: 0,
        providerCallCount: 0,
        providerAcceptedCount: 0,
        providerStateChangeCount: 0,
      },
    },
    publicDebug,
  });
  assert.deepEqual(evidence.interactionRunIds, ["run:challenge", "run:confirmed"],
    "public benchmark evidence must consume the bound current-session snapshot and exclude historical Run IDs");
}

const voicePlan = buildRunPlan({ profile: "voice-browser", repeats: null });
assert.equal(voicePlan.measuredSamples, 4);
assert.deepEqual(voicePlan.requiredServiceIds, ["agent-server", "gpt-sovits"]);
assert.deepEqual(voicePlan.scenarioIds, [
  "conversation-general",
  "weather-readonly",
  "vehicle-knowledge",
  "vehicle-control-safe",
]);
const blockedVoiceReadiness = await resolveVoiceServiceReadiness({
  endpoint: "http://127.0.0.1:9880/tts",
  fetchImpl: async () => { throw new Error("fixture unavailable"); },
});
assert.deepEqual(blockedVoiceReadiness, {
  serviceId: "gpt-sovits",
  status: "blocked",
  outcome: "blocked",
  reasonCode: "gpt-sovits-unavailable",
});
const readyVoiceReadiness = await resolveVoiceServiceReadiness({
  endpoint: "http://127.0.0.1:9880/tts",
  fetchImpl: async () => new Response("not found", { status: 404 }),
});
assert.equal(readyVoiceReadiness.status, "ready",
  "any bounded HTTP response proves the existing 9880 listener without synthesizing audio");

const voiceScenario = getBenchmarkScenario("conversation-general");
const blockedVoiceSample = sampleFromProbe(
  { sampleKey: "conversation-general:1", scenarioId: "conversation-general", repeat: 1, voiceRequired: true },
  voiceScenario,
  {
    runDebug: {
      requestId: "run:voice-blocked",
      startedAtPerf: 0,
      endedAtPerf: 25,
      events: [],
      result: {
        routeDecision: { routeId: "chat", mode: "direct" },
        parsedCommand: { needsClarification: false },
        runtimeTelemetry: {
          modelCallCount: 2,
          modelCalls: [
            { phase: "route-decision", telemetry: { durationMs: 1 } },
            { phase: "chat-response", telemetry: { durationMs: 1 } },
          ],
        },
      },
    },
    browserObservation: {
      submittedAtPerf: 0,
      firstFeedbackAtPerf: 5,
      resultVisibleAtPerf: 20,
      resultVisibleRunId: "run:voice-blocked",
      modelRequestCount: 2,
      externalModelRequestCount: 2,
      safetyCallCount: 0,
      toolCallCount: 0,
      adapterAcceptedCount: 0,
      providerCallCount: 0,
      providerAcceptedCount: 0,
      providerStateChangeCount: 0,
    },
    voiceObservation: null,
    voiceObservationFailureCode: "voice-playback-observation-failed",
  },
  "2026-08-03T00:00:00.000Z",
  "2026-08-03T00:00:01.000Z",
);
assert.equal(blockedVoiceSample.projectedMetrics.outcome, "run-degraded");
assert.equal(blockedVoiceSample.projectedMetrics.voice, null);
assert.equal(blockedVoiceSample.diagnostics.code, "voice-playback-observation-failed");

const behaviorInvalidVoiceSample = sampleFromProbe(
  { sampleKey: "conversation-general:1", scenarioId: "conversation-general", repeat: 1, voiceRequired: true },
  voiceScenario,
  {
    runDebug: {
      requestId: "run:voice-contract-invalid",
      startedAtPerf: 0,
      endedAtPerf: 25,
      events: [],
      result: {
        routeDecision: { routeId: "chat", mode: "direct" },
        parsedCommand: { needsClarification: false },
        runtimeTelemetry: {
          modelCallCount: 1,
          modelCalls: [{ phase: "chat-response", telemetry: { durationMs: 1 } }],
        },
      },
    },
    browserObservation: {
      submittedAtPerf: 0,
      firstFeedbackAtPerf: 5,
      resultVisibleAtPerf: 20,
      resultVisibleRunId: "run:voice-contract-invalid",
      modelRequestCount: 0,
      externalModelRequestCount: 0,
      safetyCallCount: 0,
      toolCallCount: 1,
      adapterAcceptedCount: 0,
      providerCallCount: 0,
      providerAcceptedCount: 0,
      providerStateChangeCount: 0,
    },
    voiceObservation: null,
    voiceObservationFailureCode: "voice-playback-observation-failed",
  },
  "2026-08-03T00:00:00.000Z",
  "2026-08-03T00:00:01.000Z",
);
assert.equal(behaviorInvalidVoiceSample.projectedMetrics.outcome, "contract-failed",
  "a missing voice observation must not mask an independent behavior-contract failure");

await assert.rejects(
  assertAgentServerReady("http://127.0.0.1:1", async () => {
    throw new Error("fixture unavailable");
  }),
  /already-running 4173/,
);
const readyCalls = [];
const publicProfile = await assertAgentServerReady("http://127.0.0.1:4173/", async (url, init) => {
  readyCalls.push({ url, init });
  return new Response(JSON.stringify({
    schemaVersion: 3,
    runtimeContractVersion: "b3-b4-runtime@1.0.0",
    tasks: {
      vehicle_slu: {
        provider: "ollama",
        model: "cockpit-slu-v11-round4:latest",
        mode: "non-thinking",
        schemaVersion: "nio-vehicle-slu-contract@2.0.0",
        fallbackConfigured: true,
        watchdogMs: null,
        readiness: { status: "ready" },
      },
      cabin_response: {
        provider: "ollama",
        model: "qwen2.5:7b",
        mode: "legacy",
        schemaVersion: null,
        fallbackConfigured: false,
        watchdogMs: null,
        readiness: { status: "ready" },
      },
      knowledge_answer: {
        provider: "dashscope",
        model: "qwen3.5-flash-2026-02-23",
        mode: "non-thinking",
        schemaVersion: "nio-knowledge-answer-contract@1.0.0",
        fallbackConfigured: true,
        watchdogMs: null,
        readiness: { status: "ready" },
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
});
assert.equal(readyCalls.length, 1);
assert.equal(readyCalls[0].url, "http://127.0.0.1:4173/api/model-provider-profile");
assert.equal(readyCalls[0].init.cache, "no-store");
assert.equal(readyCalls[0].init.signal instanceof AbortSignal, true,
  "readiness must be bounded without controlling service lifecycle");
assert.deepEqual(Object.keys(publicProfile.tasks), ["vehicle_slu", "cabin_response", "knowledge_answer"]);
assert.equal(publicProfile.tasks.vehicle_slu.provider, "ollama");
assert.equal(publicProfile.tasks.vehicle_slu.model, "cockpit-slu-v11-round4:latest");
assert.equal(publicProfile.tasks.cabin_response.provider, "ollama");
assert.equal(publicProfile.tasks.cabin_response.model, "qwen2.5:7b");
assert.equal(publicProfile.tasks.knowledge_answer.provider, "dashscope");
assert.equal(publicProfile.tasks.knowledge_answer.model, "qwen3.5-flash-2026-02-23");
const projectedServiceProfile = projectBenchmarkServiceProfile(
  publicProfile,
  "functional-smoke",
  "2026-08-11T00:00:00.000Z",
);
assert.deepEqual(projectedServiceProfile.providerIds, ["dashscope", "ollama"]);
assert.deepEqual(projectedServiceProfile.modelIds, [
  "cockpit-slu-v11-round4:latest",
  "qwen2.5:7b",
  "qwen3.5-flash-2026-02-23",
]);
await assert.rejects(
  assertAgentServerReady("http://127.0.0.1:4173", async () => new Response(JSON.stringify({
    schemaVersion: 3,
    runtimeContractVersion: "b3-b4-runtime@1.0.0",
    tasks: { vehicle_slu: publicProfile.tasks.vehicle_slu },
  }), { status: 200, headers: { "content-type": "application/json" } })),
  /cabin_response.*not ready/i,
  "readiness must fail before live samples when the Cabin model task is absent",
);
await assert.rejects(
  assertAgentServerReady("http://127.0.0.1:4173", async () => new Response(JSON.stringify({
    ...publicProfile,
    tasks: {
      vehicle_slu: publicProfile.tasks.vehicle_slu,
      cabin_response: publicProfile.tasks.cabin_response,
    },
  }), { status: 200, headers: { "content-type": "application/json" } })),
  /knowledge_answer.*not ready/i,
  "readiness must fail before live samples when the Knowledge Answer model task is absent",
);
await assert.rejects(
  assertAgentServerReady("http://127.0.0.1:4173", async () => new Response(JSON.stringify({
    ...publicProfile,
    runtimeContractVersion: "b3-b4-runtime@0.9.0",
  }), { status: 200, headers: { "content-type": "application/json" } })),
  /runtime contract version mismatch/,
  "a stale 4173 process must fail before any browser sample or model request",
);
await assert.rejects(
  assertAgentServerReady("http://127.0.0.1:4173", async () => new Response(JSON.stringify({
    ...publicProfile,
    runtimeContractVersion: undefined,
  }), { status: 200, headers: { "content-type": "application/json" } })),
  /runtime contract version mismatch/,
  "a pre-version-handshake 4173 process must fail closed",
);
await assert.rejects(
  assertAgentServerReady("http://127.0.0.1:4173", async () => new Response(JSON.stringify({
    schemaVersion: 2,
    runtimeContractVersion: "b3-b4-runtime@1.0.0",
    provider: "dashscope",
    model: "qwen-plus-2025-12-01",
    readiness: { status: "ready" },
  }), { status: 200, headers: { "content-type": "application/json" } })),
  /runtime contract version mismatch/,
  "the superseded flat provider profile must fail closed",
);
await assert.rejects(
  assertAgentServerReady("http://127.0.0.1:4173", async () => new Response("blocked", { status: 503 })),
  /already-running 4173/,
);

const environmentIdentity = Object.freeze({
  commitSha: "fixture-sha",
  dirtyWorktree: true,
  platform: "darwin",
  arch: "arm64",
  osRelease: "24.0.0",
  cpuModel: "Apple M4",
  profile: "warm-baseline",
  providerIds: Object.freeze(["dashscope"]),
  modelIds: Object.freeze(["qwen-plus-2025-12-01"]),
  regionIds: Object.freeze(["unreported"]),
  timeoutConfig: Object.freeze({
    phaseTimeoutMs: 12_000,
    transportTimeoutMs: 15_000,
    scenarioTimeoutMs: 90_000,
  }),
  serviceConfig: Object.freeze({
    requiredServiceIds: Object.freeze(["agent-server"]),
    readinessTimeoutMs: 1_500,
  }),
  serviceReadiness: Object.freeze([Object.freeze({
    serviceId: "agent-server",
    status: "ready",
    checkedAt: "2026-08-03T00:00:00.000Z",
  })]),
  coldStartProof: Object.freeze({ status: "not-applicable", verifiedAt: null, serviceIds: Object.freeze([]) }),
});
function completedSample(scenarioId, repeat) {
  const sampleKey = `${scenarioId}:${repeat}`;
  const scenario = getBenchmarkScenario(scenarioId);
  const runId = `run:${sampleKey}`;
  const modelCallCount = scenario.modelBudget.maxCalls;
  return {
    sampleId: sampleKey,
    sampleKey,
    runId,
    scenarioId,
    repeat,
    timestamps: {
      startedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:00:01.000Z",
    },
    projectedMetrics: {
      outcome: "passed",
      durationMs: 1_000,
      modelRequests: modelCallCount,
      modelCallCount,
      submissionToFirstFeedbackMs: 10,
      submissionToResultVisibleMs: 20,
      phases: Object.fromEntries(scenario.modelBudget.allowedPhases.map((phaseId) => [
        phaseId,
        { value: 10 },
      ])),
      slowestPhase: scenario.modelBudget.allowedPhases.length > 0
        ? { phaseId: scenario.modelBudget.allowedPhases[0], durationMs: 10 }
        : null,
      animation: { value: false, reason: "not-observed" },
      voice: null,
      behavior: {
        resultCategory: scenario.expected.resultCategory,
        dispatchAuthorized: false,
        adapterExecutions: 0,
        vehicleToolCalls: 0,
        vehicleWrites: 0,
        safetyWriteDecisions: 0,
        providerConfirmation: false,
        unsafeProviderExecution: false,
        executionFactsComplete: true,
      },
      contractErrors: [],
      eventSequenceErrors: [],
      budgetErrors: [],
    },
    eventRefs: [`event:${sampleKey}`],
    simulated: scenario.simulated,
    diagnostics: {
      code: "none",
      publicHmiEvidence: {
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
        visibleCardKinds: [],
        interactionRunIds: scenarioId === "vehicle-control-safe"
          ? [`run:${sampleKey}:challenge`, runId]
          : [runId],
        counters: {
          safetyCallCount: 0,
          toolCallCount: 0,
          adapterAcceptedCount: 0,
          providerCallCount: 0,
          providerAcceptedCount: 0,
          providerStateChangeCount: 0,
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
      },
    },
  };
}

const completedSamples = [
  completedSample("conversation-general", 1),
  completedSample("clarification", 3),
];
const checkpoint = createPartialCheckpoint({
  plan: warmPlan,
  environment: environmentIdentity,
  samples: completedSamples,
  completedWarmupScenarioIds: ["conversation-general"],
});
assert.doesNotThrow(() => assertResumeCompatible({ checkpoint, plan: warmPlan, environment: environmentIdentity }));

function assertWarmResumeRejected(nextCheckpoint, nextEnvironment = environmentIdentity, label = "resume mutation") {
  assert.throws(
    () => assertResumeCompatible({
      checkpoint: nextCheckpoint,
      plan: warmPlan,
      environment: nextEnvironment,
    }),
    undefined,
    `${label} must fail closed before completed samples can be skipped`,
  );
}

for (const [label, mutatedCheckpoint] of [
  ["checkpoint root safe-key extra", { ...checkpoint, note: "unsupported" }],
  ["protocol safe-key extra", { ...checkpoint, protocol: { ...checkpoint.protocol, note: "unsupported" } }],
  ["suite safe-key extra", { ...checkpoint, suite: { ...checkpoint.suite, note: "unsupported" } }],
  ["catalog safe-key extra", { ...checkpoint, catalog: { ...checkpoint.catalog, note: "unsupported" } }],
  ["environment root safe-key extra", {
    ...checkpoint,
    environment: { ...checkpoint.environment, note: "unsupported" },
  }],
]) {
  assertWarmResumeRejected(mutatedCheckpoint, environmentIdentity, label);
}

for (const [label, mutateEnvironment] of [
  ["timeoutConfig safe-key extra", (environment) => ({
    ...environment,
    timeoutConfig: { ...environment.timeoutConfig, note: "unsupported" },
  })],
  ["serviceConfig safe-key extra", (environment) => ({
    ...environment,
    serviceConfig: { ...environment.serviceConfig, note: "unsupported" },
  })],
  ["coldStartProof safe-key extra", (environment) => ({
    ...environment,
    coldStartProof: { ...environment.coldStartProof, note: "unsupported" },
  })],
]) {
  const mutatedEnvironment = mutateEnvironment(environmentIdentity);
  const mutatedCheckpoint = createPartialCheckpoint({
    plan: warmPlan,
    environment: mutatedEnvironment,
    samples: completedSamples,
    completedWarmupScenarioIds: ["conversation-general"],
  });
  assertWarmResumeRejected(mutatedCheckpoint, mutatedEnvironment, label);
}

for (const [label, coldStartProof] of [
  ["not-applicable coldStartProof with service IDs", {
    status: "not-applicable", verifiedAt: null, serviceIds: ["agent-server"],
  }],
  ["observed coldStartProof without service IDs", {
    status: "observed", verifiedAt: "2026-08-03T00:00:00.000Z", serviceIds: [],
  }],
  ["observed coldStartProof with non-ISO timestamp", {
    status: "observed", verifiedAt: "2026-08-03", serviceIds: ["agent-server"],
  }],
]) {
  const mutatedEnvironment = { ...environmentIdentity, coldStartProof };
  const mutatedCheckpoint = createPartialCheckpoint({
    plan: warmPlan,
    environment: mutatedEnvironment,
    samples: completedSamples,
    completedWarmupScenarioIds: ["conversation-general"],
  });
  assertWarmResumeRejected(mutatedCheckpoint, mutatedEnvironment, label);
}
const selfConsistentWrongProfileEnvironment = { ...environmentIdentity, profile: "functional-smoke" };
assertWarmResumeRejected(
  createPartialCheckpoint({
    plan: warmPlan,
    environment: selfConsistentWrongProfileEnvironment,
    samples: completedSamples,
    completedWarmupScenarioIds: ["conversation-general"],
  }),
  selfConsistentWrongProfileEnvironment,
  "environment profile inconsistent with the run plan",
);

const readinessExtraCheckpoint = {
  ...checkpoint,
  environment: {
    ...checkpoint.environment,
    serviceReadiness: [{
      ...checkpoint.environment.serviceReadiness[0],
      note: "unsupported",
    }],
  },
};
assertWarmResumeRejected(readinessExtraCheckpoint, environmentIdentity, "serviceReadiness safe-key extra");

for (const [label, mutate] of [
  ["raw sample top-level safe-key extra", (sample) => { sample.note = "unsupported"; }],
  ["diagnostics safe-key extra", (sample) => { sample.diagnostics.note = "unsupported"; }],
  ["projectedMetrics safe-key extra", (sample) => { sample.projectedMetrics.responseText = "unsupported"; }],
  ["public evidence safe-key extra", (sample) => {
    sample.diagnostics.publicHmiEvidence.note = "unsupported";
  }],
  ["public event safe-key extra", (sample) => {
    sample.diagnostics.publicHmiEvidence.events = [{
      eventId: "event:run:conversation-general:1:1",
      parentEventId: null,
      sequence: 1,
      component: "orchestrator",
      componentType: "ai-agent",
      phase: "goal-formation",
      status: "completed",
      refs: [],
      reasonCode: null,
      durationMs: null,
      note: "unsupported",
    }];
  }],
  ["execution trace safe-key extra", (sample) => {
    sample.projectedMetrics.behavior = {
      ...sample.projectedMetrics.behavior,
      dispatchAuthorized: true,
      adapterExecutions: 1,
      vehicleToolCalls: 1,
      vehicleWrites: 1,
      safetyWriteDecisions: 1,
      providerConfirmation: true,
    };
    const evidence = sample.diagnostics.publicHmiEvidence;
    evidence.counters = {
      ...evidence.counters,
      safetyCallCount: 1,
      toolCallCount: 1,
      adapterAcceptedCount: 1,
      providerCallCount: 1,
      providerAcceptedCount: 1,
      providerStateChangeCount: 1,
    };
    evidence.result = {
      ...evidence.result,
      safetyAllowed: true,
      toolCallPresent: true,
      toolResultPresent: true,
      executionState: "observed-succeeded",
      toolCommandId: "command:1",
      resultCommandId: "command:1",
      snapshotId: "snapshot:1",
      confirmedSnapshotId: "snapshot:1",
      snapshotCapturedAt: "2026-08-03T00:00:00.500Z",
      executionTrace: [{
        state: "observed-succeeded",
        at: "2026-08-03T00:00:00.500Z",
        source: "demo-sensor",
        note: "unsupported",
      }],
    };
  }],
]) {
  const invalid = completedSample(
    label.startsWith("execution trace") ? "vehicle-control-safe" : "conversation-general",
    1,
  );
  mutate(invalid);
  assertWarmResumeRejected({ ...checkpoint, samples: [invalid] }, environmentIdentity, label);
}

const nonPassingUnavailableExternalCount = completedSample("conversation-general", 1);
nonPassingUnavailableExternalCount.projectedMetrics = {
  ...nonPassingUnavailableExternalCount.projectedMetrics,
  outcome: "contract-failed",
  modelRequests: null,
  contractErrors: ["actual Provider request count unavailable"],
};
nonPassingUnavailableExternalCount.diagnostics = {
  ...nonPassingUnavailableExternalCount.diagnostics,
  code: "contract-failed",
  publicHmiEvidence: {
    ...nonPassingUnavailableExternalCount.diagnostics.publicHmiEvidence,
    observedExternalModelRequestCount: null,
    instrumentation: {
      ...nonPassingUnavailableExternalCount.diagnostics.publicHmiEvidence.instrumentation,
      externalModelRequestCount: false,
      complete: false,
    },
  },
};
assert.doesNotThrow(
  () => assertResumeCompatible({
    checkpoint: { ...checkpoint, samples: [nonPassingUnavailableExternalCount] },
    plan: warmPlan,
    environment: environmentIdentity,
  }),
  "a non-passing sample may resume with the actual external Provider count unavailable",
);

const stabilityPlan = buildRunPlan({ profile: "stability-faults", repeats: null });
assert.deepEqual(
  stabilityPlan.samples.map(({ sampleKey, scenarioId, repeat, faultId }) => ({
    sampleKey, scenarioId, repeat, faultId,
  })),
  B4_FAULT_SAMPLE_PLAN,
  "the runner stability order and identities must come from the shared fault sample plan",
);
assert.deepEqual(
  b4RunnerModule.B4_FAULT_CASES.map(({ scenarioId, repeat, faultId }) => ({
    sampleKey: `${scenarioId}:${repeat}`, scenarioId, repeat, faultId,
  })),
  B4_FAULT_SAMPLE_PLAN,
  "the local fault boundaries must cover exactly the shared fault sample plan",
);
const repeatedStabilityPlan = buildRunPlan({ profile: "stability-faults", repeats: 2 });
assert.equal(repeatedStabilityPlan.samples.length, 10,
  "two stability cycles must expand the shared five-entry fault template twice");
assert.equal(new Set(repeatedStabilityPlan.samples.map((sample) => sample.sampleKey)).size, 10,
  "repeated stability cycles must keep every derived sample key unique");
assert.deepEqual(
  repeatedStabilityPlan.samples.map((sample) => sample.sampleKey),
  [
    "conversation-general:1",
    "conversation-general:2",
    "vehicle-knowledge:1",
    "weather-readonly:1",
    "vehicle-control-safe:1",
    "conversation-general:3",
    "conversation-general:4",
    "vehicle-knowledge:2",
    "weather-readonly:2",
    "vehicle-control-safe:2",
  ],
  "stability repeats must remain ordered by cycle and advance within each scenario stride",
);

const stabilityEnvironment = { ...environmentIdentity, profile: "stability-faults" };
function stabilitySample(faultPlanEntry) {
  const sample = completedSample(faultPlanEntry.scenarioId, faultPlanEntry.repeat);
  const faultProfile = {
    "goal-formation-timeout": {
      stage: "goal-formation", target: "structured-model", code: "generation-timeout", retryable: true,
    },
    "task-planning-timeout": {
      stage: "task-planning", target: "structured-model", code: "generation-timeout", retryable: true,
    },
    "vehicle-knowledge-rag-unavailable": {
      stage: "vehicle-knowledge-rag", target: "manual-rag", code: "rag-unavailable", retryable: true,
    },
    "weather-timeout": {
      stage: "weather-adapter", target: "weather-adapter", code: "weather-timeout", retryable: true,
    },
    "vehicle-confirmation-timeout": {
      stage: "sensor-confirmation", target: "demo-sensor-submission", code: "sensor-timeout", retryable: true,
    },
  }[faultPlanEntry.faultId];
  sample.diagnostics.benchmarkFaultReceipt = {
    faultId: faultPlanEntry.faultId,
    ...faultProfile,
    simulated: true,
  };
  return sample;
}
const stabilityCheckpoint = createPartialCheckpoint({
  plan: stabilityPlan,
  environment: stabilityEnvironment,
  samples: [stabilitySample(B4_FAULT_SAMPLE_PLAN[0])],
});
assert.doesNotThrow(() => assertResumeCompatible({
  checkpoint: stabilityCheckpoint,
  plan: stabilityPlan,
  environment: stabilityEnvironment,
}));
const missingReceiptSample = stabilitySample(B4_FAULT_SAMPLE_PLAN[0]);
delete missingReceiptSample.diagnostics.benchmarkFaultReceipt;
assert.throws(() => assertResumeCompatible({
  checkpoint: { ...stabilityCheckpoint, samples: [missingReceiptSample] },
  plan: stabilityPlan,
  environment: stabilityEnvironment,
}), /benchmarkFaultReceipt|fault receipt/i);
const swappedReceiptSample = stabilitySample(B4_FAULT_SAMPLE_PLAN[0]);
swappedReceiptSample.diagnostics.benchmarkFaultReceipt = {
  ...stabilitySample(B4_FAULT_SAMPLE_PLAN[1]).diagnostics.benchmarkFaultReceipt,
};
assert.throws(() => assertResumeCompatible({
  checkpoint: { ...stabilityCheckpoint, samples: [swappedReceiptSample] },
  plan: stabilityPlan,
  environment: stabilityEnvironment,
}), /benchmarkFaultReceipt|fault receipt/i);
const extraReceiptSample = stabilitySample(B4_FAULT_SAMPLE_PLAN[0]);
extraReceiptSample.diagnostics.benchmarkFaultReceipt.note = "unsupported";
assert.throws(() => assertResumeCompatible({
  checkpoint: { ...stabilityCheckpoint, samples: [extraReceiptSample] },
  plan: stabilityPlan,
  environment: stabilityEnvironment,
}), /benchmarkFaultReceipt|fault receipt|canonical/i);

const realProjectedFixture = completedSample("conversation-general", 1);
const realProjectedSample = sampleFromProbe(
  { sampleKey: "conversation-general:1", scenarioId: "conversation-general", repeat: 1 },
  getBenchmarkScenario("conversation-general"),
  {
    runDebug: {
      requestId: realProjectedFixture.runId,
      startedAtPerf: 0,
      endedAtPerf: 25,
      events: [],
      result: {
        routeDecision: { routeId: "chat", mode: "direct" },
        parsedCommand: { needsClarification: false },
        runtimeTelemetry: {
          modelCallCount: 2,
          modelCalls: [
            { phase: "route-decision", telemetry: { durationMs: 1 } },
            { phase: "chat-response", telemetry: { durationMs: 1 } },
          ],
        },
      },
    },
    browserObservation: {
      submittedAtPerf: 0,
      firstFeedbackAtPerf: 5,
      resultVisibleAtPerf: 20,
      resultVisibleRunId: realProjectedFixture.runId,
      modelRequestCount: 2,
      externalModelRequestCount: 2,
      safetyCallCount: 0,
      toolCallCount: 0,
      adapterAcceptedCount: 0,
      providerCallCount: 0,
      providerAcceptedCount: 0,
      providerStateChangeCount: 0,
    },
    publicHmiEvidence: realProjectedFixture.diagnostics.publicHmiEvidence,
    voiceObservation: null,
  },
  "2026-08-03T00:00:00.000Z",
  "2026-08-03T00:00:01.000Z",
);
assert.doesNotThrow(
  () => assertResumeCompatible({
    checkpoint: { ...checkpoint, samples: [realProjectedSample] },
    plan: warmPlan,
    environment: environmentIdentity,
  }),
  "resume must accept the actual projectRunMetrics/sampleFromProbe terminal shape",
);
assert.deepEqual(
  pendingPlanSamples({ plan: warmPlan, checkpoint }).map((sample) => sample.sampleKey),
  warmPlan.samples.map((sample) => sample.sampleKey).filter((key) => ![
    "conversation-general:1", "clarification:3",
  ].includes(key)),
  "resume must skip exactly completed sample keys, including non-contiguous keys",
);

const mismatchFixtures = [
  ["report protocol", { protocol: { ...checkpoint.protocol, version: "9.0.0" } }],
  ["suite", { suite: { ...checkpoint.suite, id: "other-suite" } }],
  ["profile", { profile: "functional-smoke" }],
  ["catalog", { catalog: { ...checkpoint.catalog, scenarioIds: [...checkpoint.catalog.scenarioIds].reverse() } }],
  ["commitSha", { environment: { ...checkpoint.environment, commitSha: "other-sha" } }],
  ["dirtyWorktree", { environment: { ...checkpoint.environment, dirtyWorktree: false } }],
  ["platform", { environment: { ...checkpoint.environment, platform: "linux" } }],
  ["arch", { environment: { ...checkpoint.environment, arch: "x64" } }],
  ["osRelease", { environment: { ...checkpoint.environment, osRelease: "other-release" } }],
  ["cpuModel", { environment: { ...checkpoint.environment, cpuModel: "other-cpu" } }],
  ["environment profile", { environment: { ...checkpoint.environment, profile: "functional-smoke" } }],
  ["providerIds", { environment: { ...checkpoint.environment, providerIds: ["ollama"] } }],
  ["modelIds", { environment: { ...checkpoint.environment, modelIds: ["qwen-turbo"] } }],
  ["regionIds", { environment: { ...checkpoint.environment, regionIds: ["local"] } }],
  ["timeoutConfig", { environment: {
    ...checkpoint.environment,
    timeoutConfig: { ...checkpoint.environment.timeoutConfig, phaseTimeoutMs: 12_001 },
  } }],
  ["serviceConfig", { environment: {
    ...checkpoint.environment,
    serviceConfig: { ...checkpoint.environment.serviceConfig, readinessTimeoutMs: 1_501 },
  } }],
  ["serviceReadiness", { environment: {
    ...checkpoint.environment,
    serviceReadiness: [{ serviceId: "agent-server", status: "blocked" }],
  } }],
  ["serviceReadiness", { environment: {
    ...checkpoint.environment,
    serviceReadiness: [{ serviceId: "other-service", status: "ready" }],
  } }],
  ["coldStartProof", { environment: {
    ...checkpoint.environment,
    coldStartProof: { status: "unverified", verifiedAt: null, serviceIds: [] },
  } }],
];
for (const [label, patch] of mismatchFixtures) {
  assert.throws(
    () => assertResumeCompatible({ checkpoint: { ...checkpoint, ...patch }, plan: warmPlan, environment: environmentIdentity }),
    new RegExp(label, "i"),
    `resume must reject a mismatched ${label}`,
  );
}
const checkedAtOnlyChange = {
  ...environmentIdentity,
  serviceReadiness: [{
    ...environmentIdentity.serviceReadiness[0],
    checkedAt: "2026-08-03T00:01:00.000Z",
  }],
};
assert.doesNotThrow(
  () => assertResumeCompatible({ checkpoint, plan: warmPlan, environment: checkedAtOnlyChange }),
  "resume identity deliberately ignores only serviceReadiness.checkedAt",
);
const reorderedCheckpointEnvironment = Object.fromEntries(
  Object.entries({
    ...checkpoint.environment,
    timeoutConfig: Object.fromEntries(Object.entries(checkpoint.environment.timeoutConfig).reverse()),
    serviceConfig: Object.fromEntries(Object.entries(checkpoint.environment.serviceConfig).reverse()),
    coldStartProof: Object.fromEntries(Object.entries(checkpoint.environment.coldStartProof).reverse()),
  }).reverse(),
);
assert.doesNotThrow(
  () => assertResumeCompatible({
    checkpoint: { ...checkpoint, environment: reorderedCheckpointEnvironment },
    plan: warmPlan,
    environment: environmentIdentity,
  }),
  "semantic environment identity must ignore object key insertion order",
);
const multiProviderEnvironment = {
  ...environmentIdentity,
  providerIds: ["dashscope", "fixture-secondary-provider"],
};
const multiProviderCheckpoint = createPartialCheckpoint({
  plan: warmPlan,
  environment: multiProviderEnvironment,
  samples: completedSamples,
  completedWarmupScenarioIds: ["conversation-general"],
});
assert.throws(
  () => assertResumeCompatible({
    checkpoint: multiProviderCheckpoint,
    plan: warmPlan,
    environment: { ...multiProviderEnvironment, providerIds: [...multiProviderEnvironment.providerIds].reverse() },
  }),
  /providerIds/,
  "semantic environment identity must keep array order significant",
);
for (const invalidWarmups of [
  ["vehicle-knowledge"],
  ["conversation-general", "conversation-general"],
  ["conversation-general", "vehicle-knowledge", "weather-readonly"],
]) {
  assert.throws(
    () => assertResumeCompatible({
      checkpoint: { ...checkpoint, completedWarmupScenarioIds: invalidWarmups },
      plan: warmPlan,
      environment: environmentIdentity,
    }),
    /warmup.*fixed-order prefix/i,
  );
}
assert.throws(
  () => assertResumeCompatible({
    checkpoint: {
      ...checkpoint,
      samples: [...checkpoint.samples, {
        sampleId: "unknown:1", sampleKey: "unknown:1", scenarioId: "unknown", repeat: 1,
      }],
    },
    plan: warmPlan,
    environment: environmentIdentity,
  }),
  /completed sample/,
);
const duplicateCompletedSample = completedSample("conversation-general", 1);
assert.throws(
  () => assertResumeCompatible({
    checkpoint: { ...checkpoint, samples: [duplicateCompletedSample, structuredClone(duplicateCompletedSample)] },
    plan: warmPlan,
    environment: environmentIdentity,
  }),
  /completed sample|duplicate/i,
  "resume must reject duplicate sampleKey/sampleId/scenario+repeat identities",
);
for (const [label, mutate] of [
  ["sampleId", (sample) => { sample.sampleId = "conversation-general:2"; }],
  ["sampleKey", (sample) => { sample.sampleKey = "conversation-general:2"; }],
  ["scenario/repeat", (sample) => { sample.repeat = 2; }],
]) {
  const invalid = completedSample("conversation-general", 1);
  mutate(invalid);
  assert.throws(
    () => pendingPlanSamples({ plan: warmPlan, checkpoint: { ...checkpoint, samples: [invalid] } }),
    /completed sample|canonical|sampleId|sampleKey/i,
    `pending samples must not skip a ${label}-mismatched completed sample`,
  );
}
for (const requiredField of ["runId", "timestamps", "projectedMetrics", "eventRefs", "diagnostics"]) {
  const invalid = completedSample("conversation-general", 1);
  delete invalid[requiredField];
  assert.throws(
    () => assertResumeCompatible({
      checkpoint: { ...checkpoint, samples: [invalid] },
      plan: warmPlan,
      environment: environmentIdentity,
    }),
    /completed sample/i,
    `resume must not skip a sample missing ${requiredField}`,
  );
}
for (const [label, mutate] of [
  ["timestamps", (sample) => { sample.timestamps.completedAt = "not-an-iso-time"; }],
  ["projectedMetrics", (sample) => { sample.projectedMetrics = {}; }],
]) {
  const invalid = completedSample("conversation-general", 1);
  mutate(invalid);
  assert.throws(
    () => assertResumeCompatible({
      checkpoint: { ...checkpoint, samples: [invalid] },
      plan: warmPlan,
      environment: environmentIdentity,
    }),
    /completed sample/i,
  );
}
for (const [label, mutate] of [
  ["diagnostics.token", (sample) => { sample.diagnostics.nested = { token: "must-not-resume" }; }],
  ["projectedMetrics.rawPrompt", (sample) => { sample.projectedMetrics.rawPrompt = "must-not-resume"; }],
]) {
  const invalid = completedSample("conversation-general", 1);
  mutate(invalid);
  assert.throws(
    () => assertResumeCompatible({
      checkpoint: { ...checkpoint, samples: [invalid] },
      plan: warmPlan,
      environment: environmentIdentity,
    }),
    /completed sample/i,
    `resume must reject final-report-sensitive field ${label}`,
  );
}
const cyclicSample = completedSample("conversation-general", 1);
cyclicSample.diagnostics.self = cyclicSample.diagnostics;
assert.throws(
  () => assertResumeCompatible({
    checkpoint: { ...checkpoint, samples: [cyclicSample] },
    plan: warmPlan,
    environment: environmentIdentity,
  }),
  undefined,
  "unknown cyclic diagnostics metadata must be rejected by the exact sample schema",
);
for (const [label, mutate] of [
  ["sampleId", (sample) => { delete sample.sampleId; }],
  ["simulated", (sample) => { delete sample.simulated; }],
  ["phases", (sample) => { sample.projectedMetrics.phases = []; }],
  ["behavior", (sample) => { sample.projectedMetrics.behavior = []; }],
  ["resultCategory", (sample) => { sample.projectedMetrics.behavior.resultCategory = "fabricated-category"; }],
  ["resultCategory", (sample) => { sample.projectedMetrics.behavior.resultCategory = "blocked"; }],
  ["contractErrors", (sample) => { sample.projectedMetrics.contractErrors = ["fabricated passing error"]; }],
  ["eventSequenceErrors", (sample) => { sample.projectedMetrics.eventSequenceErrors = ["fabricated passing error"]; }],
  ["phases", (sample) => { delete sample.projectedMetrics.phases["chat-response"]; }],
  ["phases", (sample) => { sample.projectedMetrics.phases.extra = { value: 1 }; }],
  ["phases", (sample) => { sample.projectedMetrics.phases["chat-response"] = []; }],
]) {
  const invalid = completedSample("conversation-general", 1);
  mutate(invalid);
  assert.throws(
    () => assertResumeCompatible({
      checkpoint: { ...checkpoint, samples: [invalid] },
      plan: warmPlan,
      environment: environmentIdentity,
    }),
    /completed sample/i,
    `resume must reject final-report-incompatible ${label}`,
  );
}

const checkpointRoot = mkdtempSync(join(tmpdir(), "b4-checkpoint-"));
try {
  const checkpointPath = join(checkpointRoot, "partial.json");
  writePartialCheckpointAtomic(checkpointPath, checkpoint);
  assert.deepEqual(JSON.parse(readFileSync(checkpointPath, "utf8")), checkpoint);
  const updated = createPartialCheckpoint({
    plan: warmPlan,
    environment: environmentIdentity,
    samples: [...completedSamples, completedSample("conversation-general", 2)],
    completedWarmupScenarioIds: ["conversation-general", "vehicle-knowledge"],
  });
  writePartialCheckpointAtomic(checkpointPath, updated);
  assert.equal(JSON.parse(readFileSync(checkpointPath, "utf8")).samples.length, 3);
  assert.deepEqual(readdirSync(checkpointRoot), ["partial.json"], "atomic writes must not leave temp files");

  const lock = acquireCheckpointWriterLock(checkpointPath);
  assert.equal(existsSync(lock.path), true);
  assert.throws(
    () => acquireCheckpointWriterLock(checkpointPath),
    /writer lock.*already held/i,
    "a concurrent second checkpoint writer must fail closed",
  );
  assert.equal(lock.release(), true);
  assert.equal(existsSync(lock.path), false);
  assert.equal(existsSync(lock.releaseDirectory), false,
    "normal owned release must remove its private quarantine directory");
  const nextLock = acquireCheckpointWriterLock(checkpointPath);
  nextLock.release();

  const staleQuarantineLock = acquireCheckpointWriterLock(checkpointPath);
  const canonicalOwnBytes = readFileSync(staleQuarantineLock.path, "utf8");
  const staleQuarantineBytes = "stale quarantine evidence\n";
  mkdirSync(staleQuarantineLock.releaseDirectory);
  writeFileSync(staleQuarantineLock.releasePath, staleQuarantineBytes, "utf8");
  assert.equal(staleQuarantineLock.release(), false,
    "release must fail closed when this token's quarantine directory already exists");
  assert.equal(readFileSync(staleQuarantineLock.path, "utf8"), canonicalOwnBytes,
    "a stale quarantine must leave the canonical owned lock untouched");
  assert.equal(readFileSync(staleQuarantineLock.releasePath, "utf8"), staleQuarantineBytes,
    "release must preserve pre-existing quarantine bytes exactly");
  rmSync(staleQuarantineLock.path);
  rmSync(staleQuarantineLock.releaseDirectory, { recursive: true });

  const ownershipLock = acquireCheckpointWriterLock(checkpointPath);
  const foreignLockBytes = `${JSON.stringify({ token: "other-writer-token", owner: "foreign" })}\n`;
  writeFileSync(ownershipLock.path, foreignLockBytes, "utf8");
  assert.equal(ownershipLock.release(), false,
    "a lock releaser must not delete a lock whose token no longer belongs to this instance");
  assert.equal(existsSync(ownershipLock.path), true);
  assert.equal(readFileSync(ownershipLock.path, "utf8"), foreignLockBytes,
    "atomic release must restore the exact foreign canonical lock bytes");
  assert.equal(existsSync(ownershipLock.releasePath), true,
    "foreign quarantine bytes must be retained rather than deleted by this instance");
  rmSync(ownershipLock.path);
  rmSync(ownershipLock.releaseDirectory, { recursive: true });

  const primaryRunError = new Error("fixture run failure");
  assert.doesNotThrow(() => releaseCheckpointWriterLock({
    release() { throw new Error("fixture release failure"); },
  }, primaryRunError));
  assert.match(primaryRunError.lockReleaseError, /fixture release failure/,
    "lock cleanup failure must be attached without obscuring the original run error");
  assert.throws(
    () => releaseCheckpointWriterLock({ release() { return false; } }, null),
    /ownership was lost/,
    "lock ownership failure must remain fatal when no original run error exists",
  );

  const originalCheckpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
  const failingFs = {
    ...nodeFs,
    renameSync() {
      throw new Error("injected checkpoint rename failure");
    },
  };
  assert.throws(
    () => writePartialCheckpointAtomic(checkpointPath, checkpoint, failingFs),
    /injected checkpoint rename failure/,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(checkpointPath, "utf8")),
    originalCheckpoint,
    "a failed atomic publish must leave the original checkpoint parseable and unchanged",
  );
  assert.deepEqual(readdirSync(checkpointRoot), ["partial.json"]);
} finally {
  rmSync(checkpointRoot, { recursive: true, force: true });
}

function createExecutablePage({
  safeControl = false,
  animateOnConfirmation = false,
  recordSuccessfulVehicleExecution = false,
  pendingDelayPolls = 0,
  neverPending = false,
  failStage = null,
  invokeFetch = false,
  fetchesPerRun = invokeFetch ? 1 : 0,
  fetchUrlsPerRun = null,
  fetchUrlsByRun = null,
  externalModelRequestCounts = [1],
  providers = ["dashscope"],
  sequentialFetches = false,
  cleanupDisconnectFails = false,
  rigModelLoaded = true,
  rigAnimationOutcome = true,
  rigAnimationThrows = false,
  finalResultVisible = true,
  finalVisibleRunId = null,
  interleaveLateFirstResult = false,
  sameTextLateFirstResult = false,
  repeatFinalResultText = false,
  serializeEvaluateCallbacks = false,
  assistantStatusText = "",
  runtimeWarmupResult = {
    status: "degraded",
    durationMs: 4,
    tasks: {
      manualRag: { status: "ready", durationMs: 2 },
      gptSoVits: { status: "degraded", durationMs: 3 },
    },
  },
} = {}) {
  let clock = 0;
  let runSequence = 0;
  let pendingPolls = 0;
  const calls = [];
  const waits = [];
  const fetchErrors = [];
  const pendingFetches = [];
  const fetchRequests = [];
  let nativeFetchCalls = 0;
  let externalResponseIndex = 0;
  const observerInstances = [];
  const observersByNode = new Map();
  const makeElement = () => {
    let text = "";
    return {
      dataset: {},
      get textContent() { return text; },
      set textContent(value) {
        text = String(value);
        for (const callback of observersByNode.get(this) || []) callback();
      },
    };
  };
  const feedback = makeElement();
  const assistant = makeElement();
  assistant.querySelector = (selector) => (
    selector === '[data-testid="manual-evidence-status"]' && assistantStatusText
      ? { textContent: assistantStatusText }
      : null
  );
  const renderAssistant = (text, runId) => {
    assistant.dataset.runId = runId;
    assistant.textContent = `${text}${assistantStatusText}`;
  };
  const state = {
    currentRun: null,
    currentTurn: null,
    latestRun: null,
    pendingConfirmation: null,
  };
  const counters = {
    safetyCallCount: 0,
    toolCallCount: 0,
    adapterAcceptedCount: 0,
    providerCallCount: 0,
    providerAcceptedCount: 0,
    providerStateChangeCount: 0,
  };
  const vehicleRig = {
    mode: "tailgate-open-residual",
    modelLoaded: rigModelLoaded,
    originalAnimationCalls: 0,
    playScenarioAnimation(_scenario, _options) {
      if (rigAnimationThrows) throw new Error("fixture rig animation failure");
      if (!this.modelLoaded || rigAnimationOutcome !== true) return false;
      this.originalAnimationCalls += 1;
      return true;
    },
  };
  const browserWindow = {
    fetch: async (...args) => {
      nativeFetchCalls += 1;
      fetchRequests.push(args);
      const externalModelRequestCount = externalModelRequestCounts[externalResponseIndex];
      const provider = providers[externalResponseIndex] ?? providers.at(-1);
      externalResponseIndex += 1;
      return new Response(JSON.stringify(externalModelRequestCount === undefined
        ? {}
        : { telemetry: { externalModelRequestCount, provider } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    __b2AcceptanceCalls: counters,
    __runtimeWarmupReady: Promise.resolve(runtimeWarmupResult),
    vehicleRig,
    __runtimeDebug: () => ({ ...state }),
    __vehicleDebug: () => ({ vehicleRig: { mode: vehicleRig.mode, modelLoaded: vehicleRig.modelLoaded } }),
    runCommand(goal, options) {
      runSequence += 1;
      const runId = `actual-public-run-${runSequence}`;
      calls.push({ goal, options: structuredClone(options), runId });
      state.currentTurn = { runId };
      state.currentRun = { requestId: runId };
      feedback.textContent = `feedback-${runSequence}`;
      renderAssistant("正在生成回复", runId);
      if (safeControl && runSequence === 2 && interleaveLateFirstResult) {
        renderAssistant("visible-result-1", "actual-public-run-1");
      }
      if (safeControl && runSequence === 2 && sameTextLateFirstResult) {
        renderAssistant("same-result-text", "actual-public-run-1");
      }
      if (!(safeControl && runSequence === 2 && !finalResultVisible)) {
        const ownedRunId = finalVisibleRunId && runSequence === 2 ? finalVisibleRunId : runId;
        if (repeatFinalResultText) {
          renderAssistant(`repeated-final-result-${runSequence}`, ownedRunId);
          renderAssistant(`repeated-final-result-${runSequence}`, ownedRunId);
        } else if (sameTextLateFirstResult) {
          renderAssistant("same-result-text", ownedRunId);
        } else {
          renderAssistant(`visible-result-${runSequence}`, ownedRunId);
          renderAssistant(`later-visible-result-${runSequence}`, ownedRunId);
        }
      }
      const modelFetchUrls = Array.isArray(fetchUrlsByRun)
        ? fetchUrlsByRun[runSequence - 1] || []
        : Array.isArray(fetchUrlsPerRun)
          ? fetchUrlsPerRun
          : Array.from({ length: fetchesPerRun }, () => "/api/local-llm");
      if (sequentialFetches) {
        const requests = modelFetchUrls.reduce((pending, modelFetchUrl) => pending.then(
          () => browserWindow.fetch(modelFetchUrl),
        ), Promise.resolve());
        pendingFetches.push(requests.catch((error) => {
          fetchErrors.push(error);
          return null;
        }));
      } else {
        for (const modelFetchUrl of modelFetchUrls) {
          pendingFetches.push(browserWindow.fetch(modelFetchUrl).catch((error) => {
            fetchErrors.push(error);
            return null;
          }));
        }
      }
      counters.safetyCallCount += 1;
      return Promise.resolve(null);
    },
  };
  const originalFetch = browserWindow.fetch;
  const originalPlayScenarioAnimation = vehicleRig.playScenarioAnimation;
  const confirmButton = {
    clicks: 0,
    click() {
      if (failStage === "click") throw new Error("fixture click failure");
      this.clicks += 1;
      assert.equal(Object.hasOwn(state.pendingConfirmation.challenge, "responseToken"), false,
        "the public pendingConfirmation fixture intentionally exposes no responseToken");
      browserWindow.runCommand("打开尾门。", { inputSource: "ui-confirm-control" });
    },
  };
  const browserDocument = {
    querySelector(selector) {
      if (selector === "#runFeedback") return feedback;
      if (selector === "#assistantText") return assistant;
      if (selector === "[data-confirm-pending-action]") return confirmButton;
      return null;
    },
  };
  class ExecutableMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.nodes = [];
      this.active = true;
      observerInstances.push(this);
    }

    observe(node) {
      if (!observersByNode.has(node)) observersByNode.set(node, new Set());
      observersByNode.get(node).add(this.callback);
      this.nodes.push(node);
    }

    disconnect() {
      for (const node of this.nodes) observersByNode.get(node)?.delete(this.callback);
      this.nodes = [];
      this.active = false;
      if (cleanupDisconnectFails) throw new Error("fixture observer cleanup failure");
    }
  }
  const globals = {
    window: browserWindow,
    document: browserDocument,
    MutationObserver: ExecutableMutationObserver,
    performance: { now: () => { clock += 10; return clock; } },
  };
  async function execute(callback, payload) {
    const descriptors = Object.fromEntries(Object.keys(globals).map((key) => [
      key, Object.getOwnPropertyDescriptor(globalThis, key),
    ]));
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    try {
      return await callback(payload);
    } finally {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  }
  async function completeCurrentRun() {
    await Promise.all(pendingFetches.splice(0));
    const runId = state.currentTurn.runId;
    const isConfirmation = safeControl && runSequence === 2;
    const commandId = "command:safe-tailgate";
    const assistantResponse = sameTextLateFirstResult
      ? "same-result-text"
      : repeatFinalResultText
        ? `repeated-final-result-${runSequence}`
        : `later-visible-result-${runSequence}`;
    if (isConfirmation && animateOnConfirmation) {
      vehicleRig.playScenarioAnimation("tailgate-open", { commandId });
    }
    if (isConfirmation && recordSuccessfulVehicleExecution) {
      counters.toolCallCount += 1;
      counters.adapterAcceptedCount += 1;
      counters.providerCallCount += 1;
      counters.providerAcceptedCount += 1;
      counters.providerStateChangeCount += 1;
    }
    state.latestRun = {
      requestId: runId,
      startedAtPerf: runSequence === 1 ? 10 : 50,
      endedAtPerf: runSequence === 1 ? 40 : 90,
      events: [],
      error: "",
      result: isConfirmation ? {
        requestId: runId,
        assistantResponse,
        parsedCommand: { needsClarification: false },
        vehicleStateSnapshot: { id: "snapshot:safe-tailgate" },
        safetyDecision: { allowed: true },
        toolCall: { tool: "body.tailgate.open", dispatchAuthorized: true },
        toolResult: {
          tool: "body.tailgate.open",
          commandId,
          executionState: "observed-succeeded",
          confirmedSnapshotId: "snapshot:safe-tailgate",
        },
      } : {
        requestId: runId,
        assistantResponse,
        parsedCommand: { needsClarification: false },
      },
    };
    state.currentRun = null;
    state.currentTurn = null;
    state.pendingConfirmation = safeControl && runSequence === 1
      && pendingDelayPolls === 0 && !neverPending
      ? {
        challenge: {
          id: "challenge:public",
          requestId: runId,
          assertions: [{ id: "parked" }],
        },
      }
      : null;
  }
  return {
    calls,
    waits,
    fetchErrors,
    confirmButton,
    vehicleRig,
    browserWindow,
    async addInitScript(callback) {
      await execute(callback);
    },
    async evaluate(callback, payload) {
      if (failStage === "final-evaluate" && String(callback).includes("browserObservation")) {
        throw new Error("fixture final evaluate failure");
      }
      const executableCallback = serializeEvaluateCallbacks
        ? Function(`"use strict"; return (${callback.toString()});`)()
        : callback;
      return execute(executableCallback, payload);
    },
    async waitForFunction(callback, payload, options) {
      const source = String(callback);
      const stage = source.includes("vehicleRig")
        ? "rig-ready"
        : source.includes("__runtimeWarmupReady")
          ? "runtime-warmup"
        : source.includes("pendingConfirmation")
          ? "pending-wait"
          : source.includes("previousRunId")
            ? "second-run-id"
            : source.includes("currentRun === null") && runSequence === 1
              ? "first-wait"
              : "second-wait";
      waits.push({ payload, options, stage });
      if (failStage === stage) throw new Error(`fixture ${stage} failure`);
      if (state.currentRun && typeof payload === "string" && payload === state.currentTurn?.runId) {
        await execute(() => completeCurrentRun());
      }
      let passed = await execute(callback, payload);
      if (!passed && stage === "pending-wait") {
        while (!passed && pendingPolls < Math.max(1, pendingDelayPolls)) {
          pendingPolls += 1;
          if (!neverPending && pendingPolls >= pendingDelayPolls) {
            state.pendingConfirmation = {
              challenge: {
                id: "challenge:public-delayed",
                requestId: state.latestRun?.requestId,
                assertions: [{ id: "parked" }],
              },
            };
          }
          passed = await execute(callback, payload);
        }
      }
      if (!passed) throw new Error("executable fake wait condition did not pass");
    },
    locator(selector) {
      assert.equal(selector, "[data-confirm-pending-action]");
      return { click: () => execute(() => confirmButton.click()) };
    },
    get pendingPolls() { return pendingPolls; },
    get nativeFetchCalls() { return nativeFetchCalls; },
    get fetchRequests() { return fetchRequests; },
    getProbeState() {
      const probeState = browserWindow.__b4BenchmarkProbe || {};
      return Object.fromEntries([
        "externalModelRequestCount",
        "externalModelRequestReservations",
        "externalModelRequestTelemetryComplete",
        "maximumExternalModelRequests",
        "modelRequestCount",
      ].map((field) => [field, probeState[field]]));
    },
    originalFetch,
    originalPlayScenarioAnimation,
    isInstrumentationClean() {
      return browserWindow.fetch === originalFetch
        && vehicleRig.playScenarioAnimation === originalPlayScenarioAnimation
        && observerInstances.every((observer) => observer.active === false);
    },
  };
}

const executablePage = createExecutablePage({ invokeFetch: true });
const probe = await createB4BrowserProbe({
  page: executablePage,
  scenario: { ...getBenchmarkScenario("conversation-general"), goal: "fixture goal" },
  timeoutMs: 2_000,
});
const probeResult = await probe.run({ requestId: "requested-run-id" });
assert.equal(executablePage.browserWindow.NIO_B2_ACCEPTANCE_INSTRUMENTATION, true,
  "B2 counters must be enabled before HMI boot");
assert.equal(executablePage.calls[0].options.requestId, "requested-run-id");
assert.equal(executablePage.waits[0].payload, "actual-public-run-1",
  "probe must bind the actual public runId instead of fabricating request identity");
assert.equal(probeResult.runDebug.requestId, "actual-public-run-1");
assert.equal(probeResult.browserObservation.submittedAtPerf, 10);
assert.equal(probeResult.browserObservation.firstFeedbackAtPerf, 20);
assert.equal(probeResult.browserObservation.resultVisibleAtPerf, 40,
  "result visibility must select the mutation matching the final public Runtime result");
assert.equal(probeResult.browserObservation.animationConfirmedAtPerf, null);
assert.equal(probeResult.browserObservation.animationCommandId, null);
assert.equal(probeResult.browserObservation.resultVisibleRunId, "actual-public-run-1");
assert.equal(probeResult.browserObservation.providerAcceptedCount, 0);
assert.equal(probeResult.browserObservation.providerStateChangeCount, 0);
assert.equal(probeResult.browserObservation.modelRequestCount, 1,
  "the executable fixture must exercise the real fetch wrapper");

const knowledgeWarmupPage = createExecutablePage();
const knowledgeWarmupProbe = await createB4BrowserProbe({
  page: knowledgeWarmupPage,
  scenario: getBenchmarkScenario("vehicle-knowledge"),
  timeoutMs: 2_000,
});
await knowledgeWarmupProbe.run({ requestId: "requested-knowledge-warmup" });
assert.equal(knowledgeWarmupPage.waits[0].stage, "runtime-warmup",
  "vehicle knowledge must await Manual RAG warmup before submission timing starts");
assert.equal(knowledgeWarmupPage.calls.length, 1);
assert.equal(knowledgeWarmupPage.isInstrumentationClean(), true);

const degradedKnowledgeWarmupPage = createExecutablePage({
  runtimeWarmupResult: {
    status: "degraded",
    durationMs: 3,
    tasks: {
      manualRag: { status: "degraded", durationMs: 2 },
      gptSoVits: { status: "ready", durationMs: 1 },
    },
  },
});
const degradedKnowledgeWarmupProbe = await createB4BrowserProbe({
  page: degradedKnowledgeWarmupPage,
  scenario: getBenchmarkScenario("vehicle-knowledge"),
  timeoutMs: 2_000,
});
await assert.rejects(
  degradedKnowledgeWarmupProbe.run({ requestId: "requested-degraded-knowledge-warmup" }),
  (error) => {
    assert.equal(error.stage, "runtime-warmup");
    assert.equal(error.code, "runtime-warmup-failed");
    return /manual RAG runtime warmup is not ready/.test(error.message);
  },
);
assert.equal(degradedKnowledgeWarmupPage.calls.length, 0,
  "a degraded Manual warmup must fail before any business Run or model request");
assert.equal(degradedKnowledgeWarmupPage.nativeFetchCalls, 0);
assert.equal(degradedKnowledgeWarmupPage.isInstrumentationClean(), true);

const hangingKnowledgeWarmupPage = createExecutablePage({
  runtimeWarmupResult: new Promise(() => {}),
});
const hangingKnowledgeWarmupProbe = await createB4BrowserProbe({
  page: hangingKnowledgeWarmupPage,
  scenario: getBenchmarkScenario("vehicle-knowledge"),
  timeoutMs: 25,
});
await assert.rejects(
  hangingKnowledgeWarmupProbe.run({ requestId: "requested-hanging-knowledge-warmup" }),
  (error) => error.stage === "runtime-warmup" && error.code === "runtime-warmup-timeout",
);
assert.equal(hangingKnowledgeWarmupPage.calls.length, 0);
assert.equal(hangingKnowledgeWarmupPage.isInstrumentationClean(), true);
assert.equal(probeResult.browserObservation.externalModelRequestCount, 1,
  `one local HTTP response must expose its one actual Provider attempt separately: ${JSON.stringify(executablePage.getProbeState())}`);
assert.equal(executablePage.isInstrumentationClean(), true,
  "successful probe completion must disconnect observers and restore fetch/rig wrappers");

const taskRoutedFetchPage = createExecutablePage({
  fetchUrlsPerRun: ["/api/local-semantic", "/api/local-llm"],
  externalModelRequestCounts: [1, 1],
});
const taskRoutedFetchProbe = await createB4BrowserProbe({
  page: taskRoutedFetchPage,
  scenario: getBenchmarkScenario("conversation-general"),
  timeoutMs: 2_000,
});
const taskRoutedFetchResult = await taskRoutedFetchProbe.run({ requestId: "requested-task-routed-count" });
assert.equal(taskRoutedFetchPage.nativeFetchCalls, 2,
  "Vehicle-SLU and downstream model requests must both pass through the observed fetch boundary");
assert.equal(taskRoutedFetchResult.browserObservation.modelRequestCount, 2);
assert.equal(taskRoutedFetchResult.browserObservation.externalModelRequestCount, 2,
  "task-routed Vehicle-SLU and Cabin calls must share one external request budget");
assert.deepEqual(taskRoutedFetchPage.fetchRequests.map(([, init]) => (
  new Headers(init?.headers).get("x-nio-benchmark-external-model-request-limit")
)), ["2", "1"],
"each endpoint must receive only the remaining authorized provider-request allowance");

const mixedProviderBudgetPage = createExecutablePage({
  fetchUrlsPerRun: [
    "/api/local-semantic",
    "/api/local-llm",
    "/api/local-llm",
    "/api/local-llm",
    "/api/local-llm",
  ],
  externalModelRequestCounts: [1, 1, 1, 1, 1],
  providers: ["ollama", "ollama", "dashscope", "dashscope", "dashscope"],
  sequentialFetches: true,
});
const mixedProviderBudgetProbe = await createB4BrowserProbe({
  page: mixedProviderBudgetPage,
  scenario: getBenchmarkScenario("vehicle-knowledge"),
  timeoutMs: 2_000,
});
const mixedProviderBudgetResult = await mixedProviderBudgetProbe.run({
  requestId: "requested-provider-aware-budget",
});
assert.equal(mixedProviderBudgetPage.nativeFetchCalls, 4,
  "local Ollama calls must not consume the DashScope authorization budget");
assert.equal(mixedProviderBudgetResult.browserObservation.modelRequestCount, 4,
  "the browser must count each admitted local and cloud model request");
assert.equal(mixedProviderBudgetResult.browserObservation.externalModelRequestCount, 2,
  "only DashScope requests consume the authorized external-call budget");
assert.deepEqual(mixedProviderBudgetPage.fetchRequests.map(([, init]) => (
  new Headers(init?.headers).get("x-nio-benchmark-external-model-request-limit")
)), ["2", "2", "2", "1"],
"local requests retain the cloud authorization allowance while each DashScope response reduces it");
assert.match(mixedProviderBudgetPage.fetchErrors.at(-1)?.message || "", /budget/,
  "the next DashScope request must be blocked before reaching the provider");
assert.equal(mixedProviderBudgetPage.isInstrumentationClean(), true);

const serializedEvaluatePage = createExecutablePage({
  invokeFetch: true,
  serializeEvaluateCallbacks: true,
});
const serializedEvaluateProbe = await createB4BrowserProbe({
  page: serializedEvaluatePage,
  scenario: getBenchmarkScenario("conversation-general"),
  timeoutMs: 2_000,
});
const serializedEvaluateResult = await serializedEvaluateProbe.run({
  requestId: "requested-serialized-evaluate",
});
assert.equal(serializedEvaluateResult.browserObservation.externalModelRequestCount, 1,
  "the browser callback must not depend on Node-only lexical bindings after Playwright serialization");
assert.equal(
  new Headers(serializedEvaluatePage.fetchRequests[0]?.[1]?.headers)
    .get("x-nio-benchmark-external-model-request-limit"),
  "2",
);

const assistantStatusPage = createExecutablePage({
  invokeFetch: true,
  assistantStatusText: "本轮未查询用户手册",
});
const assistantStatusProbe = await createB4BrowserProbe({
  page: assistantStatusPage,
  scenario: getBenchmarkScenario("conversation-general"),
  timeoutMs: 2_000,
});
const assistantStatusResult = await assistantStatusProbe.run({
  requestId: "requested-assistant-status",
});
assert.equal(assistantStatusResult.browserObservation.resultVisibleRunId, "actual-public-run-1",
  "manual evidence status text must not hide the visible assistant answer from its owning Run");
assert.equal(Number.isFinite(assistantStatusResult.browserObservation.resultVisibleAtPerf), true);

const repairedFetchPage = createExecutablePage({ invokeFetch: true, externalModelRequestCounts: [3] });
const repairedFetchProbe = await createB4BrowserProbe({
  page: repairedFetchPage,
  scenario: { ...getBenchmarkScenario("conversation-general"), goal: "repair count fixture" },
  timeoutMs: 2_000,
});
const repairedFetchResult = await repairedFetchProbe.run({ requestId: "requested-repair-count" });
assert.equal(repairedFetchResult.browserObservation.modelRequestCount, 1,
  "one local HTTP request remains one diagnostic HTTP request");
assert.equal(repairedFetchResult.browserObservation.externalModelRequestCount, null,
  "a local response exceeding the remaining provider-request allowance must invalidate probe telemetry");

const missingExternalTelemetryPage = createExecutablePage({
  invokeFetch: true,
  externalModelRequestCounts: [undefined],
});
const missingExternalTelemetryProbe = await createB4BrowserProbe({
  page: missingExternalTelemetryPage,
  scenario: { ...getBenchmarkScenario("conversation-general"), goal: "missing external telemetry fixture" },
  timeoutMs: 2_000,
});
const missingExternalTelemetryResult = await missingExternalTelemetryProbe.run({
  requestId: "requested-missing-external-count",
});
assert.equal(missingExternalTelemetryResult.browserObservation.externalModelRequestCount, null,
  "missing Provider telemetry must remain unavailable rather than folding to zero");

const preflightBudgetPage = createExecutablePage({
  fetchesPerRun: 2,
  externalModelRequestCounts: [2, 2],
});
const preflightBudgetProbe = await createB4BrowserProbe({
  page: preflightBudgetPage,
  scenario: {
    ...getBenchmarkScenario("conversation-general"),
    goal: "preflight budget fixture",
    modelBudget: { maxCalls: 1, allowedPhases: ["chat-response"] },
  },
  timeoutMs: 2_000,
});
const preflightBudgetResult = await preflightBudgetProbe.run({ requestId: "requested-preflight-budget" });
assert.equal(preflightBudgetPage.nativeFetchCalls, 1,
  "the next local request must be rejected before native fetch when two-call reservation cannot fit");
assert.equal(preflightBudgetResult.browserObservation.modelRequestCount, 1,
  "a preflight rejection must not be reported as a sent local HTTP request");
assert.match(preflightBudgetPage.fetchErrors[0]?.message || "", /external model request budget/i);
assert.equal(preflightBudgetResult.browserObservation.externalModelRequestCount, null,
  "a rejected or unreconciled reservation must make external-call instrumentation unavailable");

const overBudgetProjection = applyObservedModelRequestBudget({
  scenario: getBenchmarkScenario("conversation-general"),
  projectedMetrics: { outcome: "passed", contractErrors: [], budgetErrors: [], modelRequests: 1, modelCallCount: 1 },
  observedExternalModelRequestCount: 7,
  instrumentationComplete: true,
});
assert.equal(overBudgetProjection.outcome, "contract-failed",
  "actual Provider attempts, not local HTTP requests, must enforce the scenario budget");

const cachedProviderProjection = applyObservedModelRequestBudget({
  scenario: getBenchmarkScenario("conversation-general"),
  projectedMetrics: {
    outcome: "passed",
    contractErrors: [],
    budgetErrors: [],
    modelRequests: 1,
    modelCallCount: 1,
  },
  observedExternalModelRequestCount: 0,
  instrumentationComplete: true,
});
assert.equal(cachedProviderProjection.outcome, "passed");
assert.equal(cachedProviderProjection.modelRequests, 0,
  "a cache hit may execute one Runtime model phase without issuing a new Provider request");
assert.deepEqual(cachedProviderProjection.budgetErrors, []);

const residualRigPage = createExecutablePage({ safeControl: true, animateOnConfirmation: false });
const residualRigProbe = await createB4BrowserProbe({
  page: residualRigPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
const residualRigResult = await residualRigProbe.run({ requestId: "requested-residual-rig" });
assert.equal(residualRigPage.confirmButton.clicks, 1, "safe control confirmation must click the public HMI control");
assert.equal(Object.hasOwn(residualRigPage.calls[1].options, "confirmationResponse"), false,
  "the probe must not reconstruct a private confirmation response or responseToken");
assert.equal(residualRigPage.waits[0].payload, null,
  "animation-required samples must wait for the real rig method before submission");
assert.deepEqual(residualRigPage.waits.map((entry) => entry.payload).filter((value) => typeof value === "string"), [
  "actual-public-run-1", "actual-public-run-1", "actual-public-run-2",
]);
assert.equal(residualRigResult.browserObservation.animationConfirmedAtPerf, null,
  "a residual non-idle rig mode must not be mistaken for a new animation call");
assert.equal(residualRigResult.browserObservation.animationCommandId, null);
assert.equal(residualRigPage.isInstrumentationClean(), true);

const oneBudgetConfirmationPage = createExecutablePage({
  safeControl: true,
  animateOnConfirmation: true,
  recordSuccessfulVehicleExecution: true,
  fetchUrlsByRun: [["/api/local-semantic"], []],
  externalModelRequestCounts: [1],
});
const oneBudgetConfirmationProbe = await createB4BrowserProbe({
  page: oneBudgetConfirmationPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
const oneBudgetConfirmationResult = await oneBudgetConfirmationProbe.run({
  requestId: "requested-one-budget-confirmation",
});
assert.equal(oneBudgetConfirmationPage.confirmButton.clicks, 1);
assert.equal(oneBudgetConfirmationPage.nativeFetchCalls, 1,
  "the confirmed second Run must not reserve or issue another semantic model request");
assert.equal(oneBudgetConfirmationPage.getProbeState().externalModelRequestCount, 1);
assert.equal(oneBudgetConfirmationResult.browserObservation.modelRequestCount, 1);
assert.equal(oneBudgetConfirmationResult.browserObservation.toolCallCount, 1);
assert.equal(oneBudgetConfirmationResult.browserObservation.providerAcceptedCount, 1);
assert.equal(oneBudgetConfirmationPage.fetchErrors.length, 0);
assert.equal(oneBudgetConfirmationPage.isInstrumentationClean(), true);

const animatedPage = createExecutablePage({ safeControl: true, animateOnConfirmation: true });
const originalPlayScenarioAnimation = animatedPage.vehicleRig.playScenarioAnimation;
const animatedProbe = await createB4BrowserProbe({
  page: animatedPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
const animatedResult = await animatedProbe.run({ requestId: "requested-animated" });
assert.equal(animatedPage.confirmButton.clicks, 1);
assert.equal(animatedPage.vehicleRig.originalAnimationCalls, 1,
  "animation instrumentation must preserve the real playScenarioAnimation call");
assert.equal(animatedPage.vehicleRig.playScenarioAnimation, originalPlayScenarioAnimation,
  "animation instrumentation must restore the original public rig method");
assert.equal(animatedResult.browserObservation.animationConfirmedAtPerf, 70);
assert.equal(animatedResult.browserObservation.animationCommandId, "command:safe-tailgate");
assert.equal(animatedPage.isInstrumentationClean(), true);

const unloadedRigPage = createExecutablePage({
  safeControl: true,
  animateOnConfirmation: true,
  rigModelLoaded: false,
});
const unloadedRigProbe = await createB4BrowserProbe({
  page: unloadedRigPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
await assert.rejects(
  unloadedRigProbe.run({ requestId: "requested-unloaded-rig" }),
  /wait condition did not pass|rig-ready/i,
  "an unloaded model must fail before animation evidence can be collected",
);
assert.equal(unloadedRigPage.isInstrumentationClean(), true);

const rejectedAnimationPage = createExecutablePage({
  safeControl: true,
  animateOnConfirmation: true,
  rigAnimationOutcome: false,
});
const rejectedAnimationProbe = await createB4BrowserProbe({
  page: rejectedAnimationPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
const rejectedAnimationResult = await rejectedAnimationProbe.run({ requestId: "requested-rejected-animation" });
assert.equal(rejectedAnimationResult.browserObservation.animationConfirmedAtPerf, null,
  "a false rig return must not leave animation success evidence");
assert.equal(rejectedAnimationResult.browserObservation.animationCommandId, null);
assert.equal(rejectedAnimationPage.isInstrumentationClean(), true);

const throwingAnimationPage = createExecutablePage({
  safeControl: true,
  animateOnConfirmation: true,
  rigAnimationThrows: true,
});
const throwingAnimationProbe = await createB4BrowserProbe({
  page: throwingAnimationPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
await assert.rejects(
  throwingAnimationProbe.run({ requestId: "requested-throwing-animation" }),
  /fixture rig animation failure/,
  "a thrown rig call must remain a probe failure rather than animation success",
);
assert.equal(throwingAnimationPage.isInstrumentationClean(), true);

const loadingOnlyFinalPage = createExecutablePage({
  safeControl: true,
  finalResultVisible: false,
});
const loadingOnlyFinalProbe = await createB4BrowserProbe({
  page: loadingOnlyFinalPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
const loadingOnlyFinalResult = await loadingOnlyFinalProbe.run({ requestId: "requested-loading-only-final" });
assert.equal(loadingOnlyFinalResult.browserObservation.resultVisibleAtPerf, null,
  "a first-turn result must not satisfy a loading-only final turn");
assert.equal(loadingOnlyFinalResult.browserObservation.resultVisibleRunId, null);

const mismatchedFinalRunPage = createExecutablePage({
  safeControl: true,
  finalVisibleRunId: "stale-first-turn-run",
});
const mismatchedFinalRunProbe = await createB4BrowserProbe({
  page: mismatchedFinalRunPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
const mismatchedFinalRunResult = await mismatchedFinalRunProbe.run({ requestId: "requested-mismatched-final" });
assert.equal(mismatchedFinalRunResult.browserObservation.resultVisibleAtPerf, null,
  "a matching result owned only by the wrong Run must not provide a visibility timestamp");
assert.equal(mismatchedFinalRunResult.browserObservation.resultVisibleRunId, null,
  "a matching result owned only by the wrong Run must not leak that wrong Run ID");

const interleavedResultPage = createExecutablePage({
  safeControl: true,
  interleaveLateFirstResult: true,
});
const interleavedResultProbe = await createB4BrowserProbe({
  page: interleavedResultPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
const interleavedResult = await interleavedResultProbe.run({ requestId: "requested-interleaved-result" });
assert.equal(interleavedResult.browserObservation.resultVisibleRunId, "actual-public-run-2");
assert.equal(interleavedResult.browserObservation.resultVisibleAtPerf, 70,
  "a late first-turn DOM mutation must not replace the final Run result timestamp");

const sameTextLateFirstPage = createExecutablePage({
  safeControl: true,
  finalResultVisible: false,
  sameTextLateFirstResult: true,
});
const sameTextLateFirstProbe = await createB4BrowserProbe({
  page: sameTextLateFirstPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
const sameTextLateFirst = await sameTextLateFirstProbe.run({ requestId: "requested-same-text-late-first" });
assert.equal(sameTextLateFirst.browserObservation.resultVisibleAtPerf, null,
  "a same-text late first-turn mutation must not satisfy a loading-only final Run");
assert.equal(sameTextLateFirst.browserObservation.resultVisibleRunId, null);

const repeatedFinalResultPage = createExecutablePage({ repeatFinalResultText: true });
const repeatedFinalResultProbe = await createB4BrowserProbe({
  page: repeatedFinalResultPage,
  scenario: { ...getBenchmarkScenario("conversation-general"), goal: "fixture repeated result" },
  timeoutMs: 2_000,
});
const repeatedFinalResult = await repeatedFinalResultProbe.run({ requestId: "requested-repeated-final" });
assert.equal(repeatedFinalResult.browserObservation.resultVisibleAtPerf, 40,
  "the last final-Run-owned matching mutation is the visible result fact");
assert.equal(repeatedFinalResult.browserObservation.resultVisibleRunId, "actual-public-run-1");

const delayedPendingPage = createExecutablePage({
  safeControl: true,
  animateOnConfirmation: true,
  pendingDelayPolls: 2,
});
const delayedPendingProbe = await createB4BrowserProbe({
  page: delayedPendingPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
const delayedPendingResult = await delayedPendingProbe.run({ requestId: "requested-delayed-pending" });
assert.equal(delayedPendingResult.runDebug.requestId, "actual-public-run-1",
  "a terminal first Run without an immediate public confirmation must remain the observed Runtime result");
assert.equal(delayedPendingPage.pendingPolls, 0,
  "the probe must not hide a missing confirmation behind another full scenario timeout");
assert.equal(delayedPendingPage.confirmButton.clicks, 0);
assert.equal(delayedPendingPage.isInstrumentationClean(), true);

const neverPendingPage = createExecutablePage({ safeControl: true, neverPending: true });
const neverPendingProbe = await createB4BrowserProbe({
  page: neverPendingPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
const neverPendingResult = await neverPendingProbe.run({ requestId: "requested-never-pending" });
assert.equal(neverPendingResult.runDebug.requestId, "actual-public-run-1");
assert.equal(neverPendingPage.calls.length, 1,
  "a missing public confirmation must not fabricate a second Runtime Run");
const neverPendingSample = sampleFromProbe(
  { sampleKey: "vehicle-control-safe:1", scenarioId: "vehicle-control-safe", repeat: 1 },
  getBenchmarkScenario("vehicle-control-safe"),
  neverPendingResult,
  "2026-08-03T00:00:00.000Z",
  "2026-08-03T00:00:01.000Z",
);
assert.equal(neverPendingSample.projectedMetrics.outcome, "contract-failed",
  "missing confirmation must become the actual safe-control behavior failure instead of a harness timeout");
assert.equal(neverPendingPage.confirmButton.clicks, 0);
assert.equal(neverPendingPage.isInstrumentationClean(), true);

const stagedSecondRunPage = createExecutablePage({ safeControl: true, failStage: "second-wait" });
const stagedSecondRunProbe = await createB4BrowserProbe({
  page: stagedSecondRunPage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
});
await assert.rejects(
  stagedSecondRunProbe.run({ requestId: "requested-staged-second-run" }),
  (error) => {
    assert.equal(error.stage, "second-run");
    assert.equal(error.code, "second-run-failed");
    return true;
  },
  "a second Runtime wait failure must retain its allowlisted probe stage and code",
);

let sharedDeadlineClock = 0;
const sharedDeadlinePage = createExecutablePage({ safeControl: true, animateOnConfirmation: true });
const sharedDeadlineProbe = await createB4BrowserProbe({
  page: sharedDeadlinePage,
  scenario: getBenchmarkScenario("vehicle-control-safe"),
  timeoutMs: 2_000,
  now: () => {
    const value = sharedDeadlineClock;
    sharedDeadlineClock += 100;
    return value;
  },
});
await sharedDeadlineProbe.run({ requestId: "requested-shared-deadline" });
assert.deepEqual(
  sharedDeadlinePage.waits.map(({ stage, options }) => ({ stage, timeout: options.timeout })),
  [
    { stage: "rig-ready", timeout: 1_900 },
    { stage: "first-wait", timeout: 1_700 },
    { stage: "second-run-id", timeout: 1_400 },
    { stage: "second-wait", timeout: 1_300 },
  ],
  "safe-control submission and waits must recalculate one absolute scenario deadline instead of resetting 2000ms",
);

for (const fixture of [
  { label: "first wait", options: { failStage: "first-wait" }, scenarioId: "conversation-general" },
  { label: "click", options: { safeControl: true, failStage: "click" }, scenarioId: "vehicle-control-safe" },
  { label: "second wait", options: { safeControl: true, failStage: "second-wait" }, scenarioId: "vehicle-control-safe" },
  { label: "final evaluate", options: { failStage: "final-evaluate" }, scenarioId: "conversation-general" },
]) {
  const failingPage = createExecutablePage(fixture.options);
  const failingProbe = await createB4BrowserProbe({
    page: failingPage,
    scenario: getBenchmarkScenario(fixture.scenarioId),
    timeoutMs: 2_000,
  });
  await assert.rejects(
    failingProbe.run({ requestId: `requested-failure-${fixture.label}` }),
    new RegExp(fixture.label.replace(" ", ".*"), "i"),
  );
  assert.equal(failingPage.isInstrumentationClean(), true,
    `${fixture.label} must still disconnect observers and restore fetch/rig wrappers`);
}

const primaryFailurePage = createExecutablePage({
  failStage: "first-wait",
  cleanupDisconnectFails: true,
});
const primaryFailureProbe = await createB4BrowserProbe({
  page: primaryFailurePage,
  scenario: getBenchmarkScenario("conversation-general"),
  timeoutMs: 2_000,
});
await assert.rejects(
  primaryFailureProbe.run({ requestId: "requested-primary-cleanup-failure" }),
  (error) => {
    assert.match(error.message, /first-wait/,
      "cleanup failure must not replace the primary probe failure");
    assert.match(error.cleanupError, /observer cleanup failure/);
    return true;
  },
);
assert.equal(primaryFailurePage.isInstrumentationClean(), true,
  "cleanup must restore instrumentation even when observer disconnect reports an error");

const twoSamplePlan = Object.freeze({
  ...functionalPlan,
  samples: Object.freeze(functionalPlan.samples.slice(0, 2)),
});
const invalidSamplePlan = Object.freeze({
  ...functionalPlan,
  samples: Object.freeze(functionalPlan.samples.slice(0, 1)),
});
const invalidSampleClosedPages = [];
let invalidSamplePartialWrites = 0;
await assert.rejects(
  executeMeasuredSamples({
    plan: invalidSamplePlan,
    checkpoint: createPartialCheckpoint({
      plan: invalidSamplePlan,
      environment: { ...environmentIdentity, profile: "functional-smoke" },
    }),
    async createPage() {
      return { id: "invalid-page", async close() { invalidSampleClosedPages.push(this.id); } };
    },
    async runSample({ page, sample }) {
      return {
        sampleId: sample.sampleKey,
        sampleKey: sample.sampleKey,
        scenarioId: sample.scenarioId,
        repeat: sample.repeat,
        pageId: page.id,
      };
    },
    async writePartial() {
      invalidSamplePartialWrites += 1;
    },
  }),
  /canonical|checkpoint sample|completed sample/i,
  "an identity-matching but non-canonical raw sample must fail before partial checkpoint publication",
);
assert.equal(invalidSamplePartialWrites, 0,
  "an invalid raw sample must never be published to partial checkpoint storage");
assert.deepEqual(invalidSampleClosedPages, ["invalid-page"],
  "the isolated page must still close when raw sample validation fails");

const pageIds = [];
const closedPageIds = [];
const writtenCheckpoints = [];
const measured = await executeMeasuredSamples({
  plan: twoSamplePlan,
  checkpoint: createPartialCheckpoint({
    plan: twoSamplePlan,
    environment: { ...environmentIdentity, profile: "functional-smoke" },
  }),
  async createPage() {
    const page = { id: `page-${pageIds.length + 1}`, async close() { closedPageIds.push(this.id); } };
    pageIds.push(page.id);
    return page;
  },
  async runSample({ sample }) {
    return completedSample(sample.scenarioId, sample.repeat);
  },
  async writePartial(nextCheckpoint) {
    writtenCheckpoints.push(structuredClone(nextCheckpoint));
  },
});
assert.deepEqual(pageIds, ["page-1", "page-2"], "each measured sample must receive a fresh page");
assert.deepEqual(closedPageIds, pageIds, "each isolated sample page must be closed");
assert.equal(writtenCheckpoints.length, 2, "partial.json must be written after every measured sample");
assert.deepEqual(writtenCheckpoints.map((entry) => entry.samples.length), [1, 2]);
assert.equal(measured.samples.length, 2);

const failFastPages = [];
const failFastWrites = [];
await assert.rejects(
  executeMeasuredSamples({
    plan: twoSamplePlan,
    checkpoint: createPartialCheckpoint({
      plan: twoSamplePlan,
      environment: { ...environmentIdentity, profile: "functional-smoke" },
    }),
    failFast: true,
    async createPage() {
      return { async close() { failFastPages.push("closed"); } };
    },
    async runSample() {
      return structuredClone(nonPassingUnavailableExternalCount);
    },
    async writePartial(nextCheckpoint) {
      failFastWrites.push(structuredClone(nextCheckpoint));
    },
  }),
  /fail-fast.*conversation-general:1.*contract-failed/i,
);
assert.deepEqual(failFastPages, ["closed"], "fail-fast must stop before creating a second page");
assert.deepEqual(failFastWrites.map((entry) => entry.samples.length), [1],
  "fail-fast must preserve the first failing sample in partial.json");

const runnerSource = readFileSync(new URL("../benchmarks/run-b4-baseline.mjs", import.meta.url), "utf8");
const probeSource = readFileSync(new URL("../lib/b4-browser-probe.mjs", import.meta.url), "utf8");
for (const [pattern, label] of [
  [/start-local-services|restart-local-services|start-agent-server/i, "service lifecycle script"],
  [/server\s*\.\s*listen\s*\(/, "server.listen"],
  [/node:child_process|\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync)\s*\(|\$\(/, "arbitrary shell execution"],
  [/src\/agents\/|agent-controller\.js/i, "direct Agent controller import"],
]) {
  assert.doesNotMatch(runnerSource, pattern, `runner must not contain ${label}`);
}
for (const required of [
  "MutationObserver", "#runFeedback", "#assistantText", "window.runCommand",
  "window.__runtimeDebug", "window.__vehicleDebug", "window.__b2AcceptanceCalls",
  "[data-confirm-pending-action]", "playScenarioAnimation",
]) {
  assert.ok(probeSource.includes(required), `probe must use public observation boundary: ${required}`);
}
assert.doesNotMatch(probeSource, /responseToken/,
  "probe must not read or reconstruct the private confirmation response token");
assert.doesNotMatch(runnerSource, /cn-beijing/,
  "runner must not hard-code an unreported DashScope region");
assert.doesNotMatch(runnerSource, /observeVoicePlayback[\s\S]{0,200}\.catch\(\(\) => null\)/,
  "voice playback observation failures must become explicit blocked sample evidence");

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
assert.equal(packageJson.scripts["benchmark:b4"], "node scripts/benchmarks/run-b4-baseline.mjs --profile warm-baseline");
assert.equal(packageJson.scripts["benchmark:b4:cold"], "node scripts/benchmarks/run-b4-baseline.mjs --profile cold-diagnostic");
assert.equal(packageJson.scripts["benchmark:b4:faults"], "node scripts/benchmarks/run-b4-baseline.mjs --profile stability-faults");
assert.equal(packageJson.scripts["benchmark:b4:voice"], "node scripts/benchmarks/run-b4-baseline.mjs --profile voice-browser");

assert.equal(typeof createB4BrowserProbe, "function");
assert.equal(getBenchmarkScenario("conversation-general").id, "conversation-general");

assert.deepEqual(parseSingleScenarioArgs([
  "--scenario", "vehicle-knowledge",
  "--authorized-max-external-model-requests", "2",
]), {
  scenarioId: "vehicle-knowledge",
  authorizedMaxExternalModelRequests: 2,
});
assert.throws(
  () => parseSingleScenarioArgs([
    "--scenario", "vehicle-knowledge",
    "--authorized-max-external-model-requests", "1",
  ]),
  /authorization.*2/i,
);

const safeDiagnosticSample = completedSample("vehicle-knowledge", 1);
safeDiagnosticSample.projectedMetrics = {
  ...safeDiagnosticSample.projectedMetrics,
  outcome: "contract-failed",
  contractErrors: ["result visibility exceeds 8000ms"],
  budgetErrors: ["result visibility exceeds 8000ms"],
  submissionToFirstFeedbackMs: 21,
  submissionToResultVisibleMs: 8_421,
};
safeDiagnosticSample.diagnostics.publicHmiEvidence.visibleCardKinds = ["b2-plan", "b3-vehicle-knowledge"];
safeDiagnosticSample.diagnostics.publicHmiEvidence.events = [{
  eventId: "event:knowledge-evidence",
  parentEventId: "event:knowledge-plan",
  sequence: 4,
  component: "manualRetriever",
  componentType: "deterministic-service",
  phase: "knowledge-evidence",
  status: "completed",
  refs: ["manual:chunk:tailgate"],
  reasonCode: null,
  durationMs: 318,
}];
const safeFailureDiagnostic = projectSingleScenarioDiagnostic({
  sample: safeDiagnosticSample,
  modelCalls: [{
    phase: "knowledge-answer",
    prompt: "PRIVATE_RAW_PROMPT",
    rawOutput: "PRIVATE_RAW_MODEL_OUTPUT",
    telemetry: {
      provider: "dashscope",
      model: "qwen-plus-2025-12-01",
      durationMs: 7_991,
      externalModelRequestCount: 1,
      reason: "PRIVATE_PROVIDER_ERROR_MESSAGE",
      reasonCode: "knowledge-answer-slow",
    },
  }],
  manualEvidenceLink: "/userguide?source=nio-es8&chunk=tailgate&run=run%3Avehicle-knowledge%3A1",
});
assert.equal(safeFailureDiagnostic.status, "FAIL");
assert.deepEqual(safeFailureDiagnostic.contractErrors, ["result visibility exceeds 8000ms"]);
assert.equal(safeFailureDiagnostic.latencyMs.manualRetrieval, 318);
assert.equal(safeFailureDiagnostic.manualEvidence.refCount, 1);
assert.equal(safeFailureDiagnostic.modelRequests.calls[0].provider, "dashscope");
assert.equal(safeFailureDiagnostic.modelRequests.calls[0].reasonCode, "knowledge-answer-slow");
const serializedSafeFailure = JSON.stringify(safeFailureDiagnostic);
for (const forbidden of [
  "PRIVATE_RAW_PROMPT",
  "PRIVATE_RAW_MODEL_OUTPUT",
  "PRIVATE_PROVIDER_ERROR_MESSAGE",
  "assistantResponse",
  "excerpt",
]) {
  assert.doesNotMatch(serializedSafeFailure, new RegExp(forbidden),
    `single-scenario diagnostic must not expose ${forbidden}`);
}

const safeFatalDiagnostic = projectSingleScenarioFailureDiagnostic({
  scenarioId: "vehicle-knowledge",
  error: {
    stage: "first-run",
    code: "first-run-timeout",
    message: "PRIVATE_PROVIDER_ERROR_MESSAGE",
    rawOutput: "PRIVATE_RAW_MODEL_OUTPUT",
  },
});
assert.deepEqual(safeFatalDiagnostic, {
  status: "FAIL",
  scenarioId: "vehicle-knowledge",
  failure: { stage: "first-run", reasonCode: "first-run-timeout" },
});
assert.doesNotMatch(JSON.stringify(safeFatalDiagnostic), /PRIVATE_/);

const safePassingSample = completedSample("vehicle-knowledge", 1);
safePassingSample.diagnostics.publicHmiEvidence.events = structuredClone(
  safeDiagnosticSample.diagnostics.publicHmiEvidence.events,
);
const safePassingDiagnostic = projectSingleScenarioDiagnostic({
  sample: safePassingSample,
  manualEvidenceLink: "/userguide?source=nio-es8&chunk=tailgate&run=run%3Avehicle-knowledge%3A1",
});
assert.equal(safePassingDiagnostic.status, "PASS");
assert.equal(safePassingDiagnostic.manualEvidence.status, "hit");

console.log("verify-b4-baseline-runner: PASS");
