import assert from "node:assert/strict";
import fs from "node:fs";
import * as runEventPresenter from "../../src/app/run-event-presenter.js";
const {
  buildHmiRunDebugSnapshot,
  buildPendingConfirmationDebugSnapshot,
  buildRunEventDebugSnapshot,
  buildRunEventViewModel,
  buildRuntimeResultDebugSnapshot,
  createStableHmiRunDebugFacade,
  createSafeRunEventProjectionListener,
} = runEventPresenter;
import { RunEventLedger } from "../../src/runtime/run-event-ledger.js";
import { createRunEvent } from "../../src/runtime/run-event-protocol.js";

function event(sequence, overrides = {}) {
  const runId = overrides.runId || "presenter-run";
  return createRunEvent({
    eventId: `event:${runId}:${sequence}`,
    runId,
    parentEventId: sequence === 1 ? null : `event:${runId}:${sequence - 1}`,
    sequence,
    timestamp: `2026-07-26T00:00:00.${String((sequence - 1) * 50).padStart(3, "0")}Z`,
    component: "cabinAssistant",
    phase: "intake",
    status: "processing",
    summary: `event ${sequence}`,
    refs: [],
    metadata: {},
    ...overrides,
  });
}

const events = [
  event(1, { summary: "已接收用户输入。" }),
  event(2, {
    component: "vehicleSluModel",
    phase: "route-decision",
    status: "completed",
    summary: "车辆语义解析完成。",
    model: "vehicle-slu-test",
    provider: "local",
    durationMs: 32,
    metadata: {
      simulated: true,
      routing: {
        routeId: "chat", mode: "direct", disposition: "execute",
        semanticSource: "vehicle-slu",
        validation: { contract: { ok: true }, capability: { ok: true }, slot: { ok: true } },
      },
    },
  }),
  event(3, {
    component: "voiceBridgeEligibility",
    phase: "voice-bridge-eligibility",
    status: "completed",
    summary: "等待提示策略已完成。",
    metadata: {
      policyVersion: "voice@1",
      voiceBridgeEligibility: {
        allowed: true,
        noToolOrSafetyPath: true,
        requestId: "presenter-run",
        reason: "ordinary-chat",
        policyId: "voice-policy",
        policyVersion: "voice@1",
      },
    },
  }),
  event(4, {
    component: "cabinModel",
    phase: "chat-response",
    status: "completed",
    summary: "Cabin 模型调用完成。",
    model: "cabin-test",
    provider: "cloud",
    durationMs: 20,
    metadata: { modelTelemetry: { revision: "cabin@1" } },
  }),
  event(5, {
    component: "cabinAssistant",
    phase: "chat-response",
    status: "completed",
    summary: "你好，我可以帮你。",
    metadata: { presentation: { responseSource: "foreground-cabin" } },
  }),
  event(6, {
    component: "cabinAssistant",
    phase: "final-response",
    status: "completed",
    summary: "回复已完成。",
    metadata: { presentation: { outcomeStatus: "answered" } },
  }),
];
const run = Object.freeze({
  runId: "presenter-run",
  status: "completed",
  startedAt: events[0].timestamp,
  completedAt: events.at(-1).timestamp,
  events: Object.freeze(events),
});

const zeroView = buildRunEventViewModel(run, { cursor: 0 });
assert.deepEqual(zeroView.components, []);
assert.deepEqual(zeroView.logItems, []);
const cursorView = buildRunEventViewModel(run, { cursor: 3 });
assert.deepEqual(cursorView.components.map(({ id }) => id), [
  "cabinAssistant", "vehicleSluModel", "voiceBridgeEligibility",
]);
assert.deepEqual(cursorView.logItems.map(({ sequence }) => sequence), [1, 2, 3]);
assert.equal(cursorView.terminalStatus, null);

const view = buildRunEventViewModel(run);
assert.deepEqual(view.components.map(({ id }) => id), [
  "cabinAssistant", "vehicleSluModel", "voiceBridgeEligibility", "cabinModel",
]);
for (const absent of [
  "orchestrator", "orchestratorModel", "manualRetriever", "ragEmbeddingModel",
  "ragRerankModel", "safety", "vehicleStateProvider", "vehicleTool",
]) assert.equal(view.components.some(({ id }) => id === absent), false);
assert.equal(view.components.find(({ id }) => id === "cabinAssistant").summary, "回复已完成。");
assert.equal(view.components.find(({ id }) => id === "vehicleSluModel").type, "model-service");
assert.deepEqual(Object.keys(view.logItems[0]).sort(), [
  "component", "componentLabel", "componentType", "degraded", "durationMs", "eventId",
  "model", "observedAt", "observedMs", "parentEventId", "phase", "provider", "reasonCode",
  "refs", "sequence", "simulated", "status", "summary", "timestamp",
].sort());
for (const alias of ["participantId", "participantLabel", "participantType", "agentId", "kind", "message", "data"]) {
  assert.equal(Object.hasOwn(view.logItems[0], alias), false);
}
assert.ok(Object.isFrozen(view));
assert.ok(Object.isFrozen(view.components));
assert.ok(Object.isFrozen(view.components[0]));
assert.ok(Object.isFrozen(view.logItems));
assert.ok(Object.isFrozen(view.timelineItems));

const privateSentinel = "PRESENTER_PRIVATE_SENTINEL";
const forgedScenario = {
  ...events[0],
  component: "vehicleStateProvider",
  componentType: "deterministic-service",
  phase: "developer-scenario",
  metadata: {
    developerScenario: {
      scenarioId: "scenario:1",
      source: "simulator",
      simulatorMode: "safe",
    },
  },
};
const forgedView = buildRunEventViewModel({ runId: "presenter-run", status: "completed", events: [forgedScenario] });
assert.deepEqual(forgedView.logItems[0].scenarioAudit, {
  scenarioId: "scenario:1",
  source: "simulator",
  simulatorMode: "safe",
});
assert.doesNotMatch(JSON.stringify(forgedView), new RegExp(privateSentinel));

for (const [label, invalidEvent] of [
  ["phase", { ...events[0], phase: "not-a-phase" }],
  ["status", { ...events[0], status: "not-a-status" }],
  ["top-level", { ...events[0], unexpected: "PRESENTER_POISON" }],
  ["metadata", { ...events[0], metadata: { prompt: "PRESENTER_POISON" } }],
]) {
  const invalidView = buildRunEventViewModel({
    runId: "presenter-run",
    status: "completed",
    events: [invalidEvent],
  });
  assert.deepEqual(invalidView.components, [], `${label} must not light a component card`);
  assert.deepEqual(invalidView.logItems, [], `${label} must not enter the public log`);
  assert.deepEqual(invalidView.timelineItems, [], `${label} must not enter replay`);
}

const knowledgeDelegationId = "delegation:knowledge-run:1";
const strictEvidence = {
  sourceId: "owner-manual",
  sourceVersion: "2026.08",
  chunkId: "chunk:tailgate",
  pageStart: 10,
  pageEnd: 11,
  excerpt: "尾门开启条件",
  score: { retrieval: 0.9, rerank: 0.8, grounding: 0.95 },
};
const knowledgeBase = {
  protocol: { id: "nio-run-event", version: "2.0.0" },
  runId: "knowledge-run",
  componentType: "ai-agent",
  status: "completed",
  refs: [], model: null, provider: null, durationMs: null,
};
const knowledgeEvents = [
  {
    ...knowledgeBase,
    eventId: "event:knowledge-run:1", parentEventId: null, sequence: 1,
    timestamp: "2026-07-26T00:00:00.000Z", component: "orchestrator",
    phase: "knowledge-delegation", summary: "已建立知识委派。",
    metadata: { knowledge: { delegationId: knowledgeDelegationId, delegation: {
      delegationId: knowledgeDelegationId, runId: "knowledge-run", parentPlanId: "plan:1",
      parentStepId: "step:1", knowledgeGoal: "解释尾门开启条件", vehicleScope: "ES8",
      allowedCapabilities: ["knowledge.manual.retrieve"], allowVehicleStateRead: false,
      requireSafetyEligibilityExplanation: false, expectedAnswerContract: "answer@1", dependsOn: [],
    } } },
  },
  {
    ...knowledgeBase,
    eventId: "event:knowledge-run:2", parentEventId: "event:knowledge-run:1", sequence: 2,
    timestamp: "2026-07-26T00:00:00.050Z", component: "manualRetriever",
    componentType: "deterministic-service", phase: "knowledge-evidence", summary: "证据命中。",
    refs: ["chunk:tailgate"], metadata: { knowledge: {
      delegationId: knowledgeDelegationId, subplanId: "subplan:1", stepId: "step:manual",
      capabilityId: "knowledge.manual.retrieve", dependsOnEventIds: [], outcomeStatus: "completed",
      retrievalStatus: "hit", evidenceRefs: [strictEvidence],
    } },
  },
  {
    ...knowledgeBase,
    eventId: "event:knowledge-run:3", parentEventId: "event:knowledge-run:2", sequence: 3,
    timestamp: "2026-07-26T00:00:00.100Z", component: "cabinAssistant",
    phase: "knowledge-answer", summary: "已生成知识回答。", refs: ["chunk:tailgate"],
    metadata: { knowledge: {
      delegationId: knowledgeDelegationId, subplanId: "subplan:1", stepId: "step:answer",
      capabilityId: "knowledge.answer", dependsOnEventIds: ["event:knowledge-run:2"],
      outcomeStatus: "answered", evidenceRefs: [strictEvidence], vehicleStateRefs: [],
      supportStatus: "supported",
    } },
  },
];
const knowledgeView = buildRunEventViewModel({ runId: "knowledge-run", status: "completed", events: knowledgeEvents });
assert.equal(knowledgeView.b3.vehicleKnowledge.goal, "解释尾门开启条件");
assert.deepEqual(knowledgeView.b3.vehicleKnowledge.evidence[0], strictEvidence);
assert.equal(knowledgeView.b3.vehicleKnowledge.outcome.supportStatus, "supported");
assert.equal(knowledgeView.components.find(({ id }) => id === "orchestrator").type, "ai-agent");
assert.equal(knowledgeView.components.find(({ id }) => id === "manualRetriever").type, "deterministic-service");

const debugSnapshot = buildRunEventDebugSnapshot(run);
assert.deepEqual(debugSnapshot.events.map(({ sequence }) => sequence), [1, 2, 3, 4, 5, 6]);
assert.deepEqual(debugSnapshot.components.map(({ id }) => id), view.components.map(({ id }) => id));
assert.equal(debugSnapshot.events[0].message, undefined);
assert.equal(debugSnapshot.events[0].participantId, undefined);
assert.equal(debugSnapshot.terminalStatus, "completed");
assert.doesNotMatch(JSON.stringify(debugSnapshot), new RegExp(privateSentinel));

const planningFallback = {
  source: "deterministic-knowledge-delegation-fallback",
  reasonCode: "model-timeout",
  degraded: true,
};

const providerSnapshot = Object.freeze({
  id: "provider-snapshot-1", source: "demo-sensor-simulator", simulated: true,
  capturedAt: "2026-07-26T00:00:00.000Z",
  values: Object.freeze({ speedKph: 0, gear: "P", rearClearance: true,
    windowAntiPinchAvailable: true, rainDetected: false, rawPayload: privateSentinel }),
});
const capturedAtMs = Date.parse(providerSnapshot.capturedAt);
const freshProviderSummary = runEventPresenter.buildProviderSnapshotSummary(providerSnapshot, {
  nowMs: capturedAtMs + 5_000, maxAgeMs: 5_000,
});
const staleProviderSummary = runEventPresenter.buildProviderSnapshotSummary(providerSnapshot, {
  nowMs: capturedAtMs + 5_001, maxAgeMs: 5_000,
});
assert.equal(freshProviderSummary.freshness, "fresh");
assert.equal(staleProviderSummary.freshness, "stale");
assert.equal(freshProviderSummary.fingerprint, staleProviderSummary.fingerprint);
assert.doesNotMatch(JSON.stringify(staleProviderSummary), new RegExp(privateSentinel));

const runtimePrivateSentinel = "RUNTIME_PRIVATE_SENTINEL";
const rawRuntimeResult = {
  requestId: "presenter-run",
  rawText: runtimePrivateSentinel,
  mode: "edge-model",
  agentMode: "b2",
  semanticEnvelope: {
    contractVersion: "nio-vehicle-slu-contract@2.0.0",
    requestId: "presenter-run",
    domain: "vehicle",
    conversationGoal: { summary: "车窗调整", need: "none" },
    vehicleFrames: [{
      frameId: "frame-1",
      capability: "control",
      intent: "body.window.setPosition",
      speechAct: "command",
      knowledgeNeed: "none",
      actionNeed: "execute",
      slots: { zone: "front_right", percent: 50, prompt: runtimePrivateSentinel },
      missingSlots: [],
      clarificationQuestion: null,
      standaloneQuery: null,
      confidence: 0.97,
      rawResponse: runtimePrivateSentinel,
    }],
    domainConfidence: 0.98,
    chainOfThought: runtimePrivateSentinel,
  },
  executionDisabled: false,
  parsedCommand: {
    intent: "body.tailgate.open",
    conversationGoal: { domain: "vehicle-control", goal: runtimePrivateSentinel },
    semanticPolicy: { id: "nio-semantic-policy", version: "1.0.0" },
    intentNormalization: {
      source: "semantic-policy-compound-guard",
      reason: "compound-or-conflicting-input",
    },
    slots: { open: true, prompt: runtimePrivateSentinel },
    prompt: runtimePrivateSentinel,
  },
  semanticTelemetry: {
    provider: "ollama",
    model: "vehicle-slu-test",
    durationMs: 12,
    promptVersion: "nio-vehicle-slu-prompt@2.0.0",
    prompt: runtimePrivateSentinel,
  },
  runtimeTelemetry: {
    modelCallCount: 1,
    modelCalls: [{
      phase: "chat-response",
      telemetry: {
        provider: "ollama",
        summary: runtimePrivateSentinel,
      },
    }],
  },
  safetyDecision: {
    allowed: true,
    action: "allow",
    confirmationChallenge: {
      id: "challenge-1",
      actionDigest: "digest-1",
      responseToken: runtimePrivateSentinel,
      assertions: [{ id: "rear-clearance" }],
    },
    manualSafetyConstraints: [{ topic: "window-anti-pinch", prompt: runtimePrivateSentinel }],
  },
  toolCall: {
    requestId: "presenter-run",
    commandId: "command-1",
    tool: "body.tailgate.open",
    args: { open: true },
    requiresSafety: false,
  },
  toolResult: {
    requestId: "presenter-run",
    commandId: "command-1",
    tool: "body.tailgate.open",
    ok: true,
    hmiSummary: "opened",
    confirmedSnapshotId: "snapshot-1",
    executionState: "observed-succeeded",
    executionTrace: [{
      state: "submitted",
      source: "demo-vehicle-adapter",
      at: "2026-07-26T00:00:00.000Z",
      summary: runtimePrivateSentinel,
    }],
  },
  vehicleStateSnapshot: {
    id: "snapshot-1",
    source: "demo-sensor-simulator",
    capturedAt: "2026-07-26T00:00:00.000Z",
    values: {
      speedKph: 0,
      gear: "P",
      rearClearance: true,
      windowAntiPinchAvailable: true,
      rainDetected: false,
      rawPayload: runtimePrivateSentinel,
    },
    capturedAtByField: {
      speedKph: "2026-07-26T00:00:00.000Z",
      gear: "2026-07-26T00:00:00.000Z",
      rearClearance: "2026-07-26T00:00:00.000Z",
      windowAntiPinchAvailable: "2026-07-26T00:00:00.000Z",
      rainDetected: "2026-07-26T00:00:00.000Z",
      rawPayload: runtimePrivateSentinel,
    },
    rawText: runtimePrivateSentinel,
  },
  cloudResult: {
    model: "weather-location-clarification",
    summary: "location required",
    output: { summary: runtimePrivateSentinel },
    prompt: runtimePrivateSentinel,
    telemetry: {
      provider: "local-boundary",
      promptChars: 0,
      prompt: runtimePrivateSentinel,
      ollamaDurations: {
        prompt_eval_duration_ms: 10,
        prompt_eval_count: 11,
        eval_duration_ms: 12,
        eval_count: 13,
      },
      weatherLocationClarification: { policy: "nio-weather-location-clarification@1.0.0" },
    },
  },
  conversationResult: {
    summary: "conversation summary",
    output: { summary: runtimePrivateSentinel },
    prompt: runtimePrivateSentinel,
    telemetry: {
      provider: "ollama",
      reason: runtimePrivateSentinel,
      reasonCode: "model-unavailable",
      summary: runtimePrivateSentinel,
      output: { summary: runtimePrivateSentinel },
      prompt: runtimePrivateSentinel,
    },
  },
  assistantResponse: "structured answer",
  planningFallback,
  manualEvidence: {
    status: "hit",
    query: runtimePrivateSentinel,
    evidence: [{ chunkId: "chunk-1", title: "Tailgate", prompt: runtimePrivateSentinel }],
    telemetry: {
      durationMs: 18,
      retrievalMode: "hybrid",
      acceptedCount: 2,
      rejectedCount: 1,
      missReason: "",
      eligibilityPolicy: { id: "nio-manual-evidence-eligibility", version: "1.0.0" },
      candidateDecisions: [{ chunkId: "chunk-1", applicable: true }],
      corpusApplicability: { applicable: true },
    },
    prompt: runtimePrivateSentinel,
  },
  manualQueryPlan: {
    policy: "nio-manual-query-plan@1.5.0",
    query: runtimePrivateSentinel,
    knowledgeNeed: "manual",
    actionNeed: "explain",
    adaptiveK: 4,
    prompt: runtimePrivateSentinel,
  },
  events: events.map((item) => ({ ...item, data: { rawText: runtimePrivateSentinel } })),
  debugPayload: { chainOfThought: runtimePrivateSentinel },
};
const safeRuntimeResult = buildRuntimeResultDebugSnapshot(rawRuntimeResult, {
  events: view.logItems,
});
assert.deepEqual({
  modelTelemetrySummary: safeRuntimeResult.runtimeTelemetry?.modelCalls?.[0]?.telemetry?.summary,
  executionTraceSummary: safeRuntimeResult.toolResult?.executionTrace?.[0]?.summary,
  conversationTelemetryReason: safeRuntimeResult.conversationResult?.telemetry?.reason,
}, {
  modelTelemetrySummary: undefined,
  executionTraceSummary: undefined,
  conversationTelemetryReason: undefined,
});
assert.equal(safeRuntimeResult.requestId, "presenter-run");
assert.equal(safeRuntimeResult.mode, "edge-model");
assert.equal(safeRuntimeResult.agentMode, "b2");
assert.deepEqual(safeRuntimeResult.semanticEnvelope.vehicleFrames[0], {
  frameId: "frame-1",
  capability: "control",
  intent: "body.window.setPosition",
  speechAct: "command",
  knowledgeNeed: "none",
  actionNeed: "execute",
  slots: { zone: "front_right", percent: 50 },
  missingSlots: [],
  clarificationQuestion: null,
  standaloneQuery: null,
  confidence: 0.97,
});
assert.equal(safeRuntimeResult.semanticEnvelope.domain, "vehicle");
assert.equal(safeRuntimeResult.semanticEnvelope.conversationGoal.need, "none");
assert.equal(safeRuntimeResult.semanticEnvelope.domainConfidence, 0.98);
assert.equal(safeRuntimeResult.executionDisabled, false);
assert.deepEqual(safeRuntimeResult.planningFallback, planningFallback);
assert.equal(safeRuntimeResult.parsedCommand.intent, "body.tailgate.open");
assert.equal(safeRuntimeResult.parsedCommand.semanticPolicy.id, "nio-semantic-policy");
assert.equal(safeRuntimeResult.parsedCommand.intentNormalization.source, "semantic-policy-compound-guard");
assert.equal(safeRuntimeResult.parsedCommand.conversationGoal.domain, "vehicle-control");
assert.equal(safeRuntimeResult.parsedCommand.conversationGoal.goal, undefined);
assert.equal(safeRuntimeResult.semanticTelemetry.provider, "ollama");
assert.equal(safeRuntimeResult.runtimeTelemetry.modelCalls[0].phase, "chat-response");
assert.equal(safeRuntimeResult.runtimeTelemetry.modelCalls[0].telemetry.provider, "ollama");
assert.equal(safeRuntimeResult.safetyDecision.allowed, true);
assert.equal(safeRuntimeResult.toolResult.tool, "body.tailgate.open");
assert.equal(safeRuntimeResult.toolCall.requiresSafety, false);
assert.equal(safeRuntimeResult.toolResult.confirmedSnapshotId, "snapshot-1");
assert.deepEqual(safeRuntimeResult.toolResult.executionTrace[0], {
  state: "submitted",
  source: "demo-vehicle-adapter",
  at: "2026-07-26T00:00:00.000Z",
});
assert.deepEqual(safeRuntimeResult.vehicleStateSnapshot.values, {
  speedKph: 0,
  gear: "P",
  rearClearance: true,
  windowAntiPinchAvailable: true,
  rainDetected: false,
});
assert.deepEqual(safeRuntimeResult.vehicleStateSnapshot.capturedAtByField, {
  speedKph: "2026-07-26T00:00:00.000Z",
  gear: "2026-07-26T00:00:00.000Z",
  rearClearance: "2026-07-26T00:00:00.000Z",
  windowAntiPinchAvailable: "2026-07-26T00:00:00.000Z",
  rainDetected: "2026-07-26T00:00:00.000Z",
});
assert.equal(safeRuntimeResult.semanticTelemetry.promptVersion, "nio-vehicle-slu-prompt@2.0.0");
assert.equal(safeRuntimeResult.cloudResult.telemetry.provider, "local-boundary");
assert.equal(safeRuntimeResult.cloudResult.telemetry.promptChars, 0);
assert.equal(safeRuntimeResult.cloudResult.telemetry.ollamaDurations.prompt_eval_count, 11);
assert.equal(safeRuntimeResult.conversationResult.summary, "conversation summary");
assert.equal(safeRuntimeResult.conversationResult.telemetry.provider, "ollama");
assert.equal(safeRuntimeResult.conversationResult.telemetry.reasonCode, "model-unavailable");
assert.equal(safeRuntimeResult.conversationResult.telemetry.summary, undefined);
assert.equal(safeRuntimeResult.conversationResult.output, undefined);
assert.equal(safeRuntimeResult.cloudResult.output, undefined);
assert.equal(safeRuntimeResult.assistantResponse, "structured answer");
assert.equal(safeRuntimeResult.manualEvidence.evidence[0].chunkId, "chunk-1");
assert.equal(safeRuntimeResult.manualEvidence.query, undefined);
assert.equal(safeRuntimeResult.manualEvidence.queryChars, runtimePrivateSentinel.length);
assert.equal(safeRuntimeResult.manualEvidence.telemetry.retrievalMode, "hybrid");
assert.equal(safeRuntimeResult.manualEvidence.telemetry.acceptedCount, 2);
assert.equal(safeRuntimeResult.manualEvidence.telemetry.rejectedCount, 1);
assert.equal(safeRuntimeResult.manualEvidence.telemetry.eligibilityPolicy.id, "nio-manual-evidence-eligibility");
assert.equal(safeRuntimeResult.manualEvidence.telemetry.candidateDecisions[0].chunkId, "chunk-1");
assert.equal(safeRuntimeResult.manualEvidence.telemetry.corpusApplicability.applicable, true);
assert.equal(safeRuntimeResult.manualQueryPlan.query, undefined);
assert.equal(safeRuntimeResult.manualQueryPlan.adaptiveK, 4);
assert.deepEqual(safeRuntimeResult.events.map((item) => item.sequence), [1, 2, 3, 4, 5, 6]);
assert.equal(safeRuntimeResult.events[0].component, "cabinAssistant");
assert.equal(safeRuntimeResult.events[0].agentId, undefined);
assert.equal(safeRuntimeResult.events[0].message, undefined);
assert.equal(safeRuntimeResult.safetyDecision.confirmationChallenge.id, "challenge-1");
assert.equal(safeRuntimeResult.safetyDecision.confirmationChallenge.actionDigest, "digest-1");
assert.equal(safeRuntimeResult.safetyDecision.confirmationChallenge.responseToken, undefined);
assert.equal(safeRuntimeResult.rawText, undefined);
assert.equal(safeRuntimeResult.parsedCommand.prompt, undefined);
assert.equal(safeRuntimeResult.cloudResult.prompt, undefined);
assert.doesNotMatch(JSON.stringify(safeRuntimeResult), new RegExp(runtimePrivateSentinel));

const safeLatestRun = buildHmiRunDebugSnapshot({
  input: runtimePrivateSentinel,
  requestId: "presenter-run",
  result: rawRuntimeResult,
  events: rawRuntimeResult.events,
  error: runtimePrivateSentinel,
  startedAt: "2026-07-26T00:00:00.000Z",
  endedAt: "2026-07-26T00:00:01.000Z",
  startedAtPerf: 100,
  endedAtPerf: 180,
  ttsTelemetry: {
    status: "completed",
    provider: "gpt-sovits",
    startedAtMs: 2,
    scheduledFirstAudioMs: 42,
    firstPlayStartedMs: 48,
    completedMs: 80,
    maxStreamScheduleGapMs: 9,
    chunks: [{
      index: 0,
      textChars: 12,
      requestStartMs: 4,
      responseHeadersMs: 10,
      streamChunkArrivalMs: [14, 20],
      completeAudioReadyMs: 30,
      requestToResponseHeadersMs: 6,
      requestToCompleteAudioReadyMs: 26,
      previousEndToPlayStartGapMs: 0,
      streamScheduleGapsMs: [0, 6],
      responseHeaders: {
        "x-nio-tts-diagnostic-request-id": "diagnostic-1",
        "x-nio-tts-profile-id": "sandrone-dev",
      },
    }],
    bridge: {
      allowed: true,
      policyId: "nio-bridge@1.0.0",
      status: "completed",
      assetStatus: "ready",
      asset: { assetId: "asset-1" },
      queue: ["asset-1", "asset-2"],
      playedAssetIds: ["asset-1"],
      browserFallbackUsed: false,
      startedMs: 8,
      completedMs: 72,
      watchdogTriggered: false,
      queueState: { cursor: 2, remaining: 0 },
      maxPrebakedAssetsPerRun: 2,
      elapsedWaitMs: 20,
    },
    prompt: runtimePrivateSentinel,
  },
}, {
  events: view.logItems,
});
assert.equal(safeLatestRun.requestId, "presenter-run");
assert.equal(safeLatestRun.result.parsedCommand.intent, "body.tailgate.open");
assert.equal(safeLatestRun.ttsTelemetry.status, "completed");
assert.equal(safeLatestRun.ttsTelemetry.startedAtMs, 2);
assert.equal(safeLatestRun.ttsTelemetry.scheduledFirstAudioMs, 42);
assert.equal(safeLatestRun.ttsTelemetry.firstPlayStartedMs, 48);
assert.equal(safeLatestRun.ttsTelemetry.chunks[0].index, 0);
assert.equal(safeLatestRun.ttsTelemetry.chunks[0].requestStartMs, 4);
assert.equal(safeLatestRun.ttsTelemetry.chunks[0].completeAudioReadyMs, 30);
assert.equal(safeLatestRun.ttsTelemetry.chunks[0].requestToCompleteAudioReadyMs, 26);
assert.equal(safeLatestRun.ttsTelemetry.chunks[0].responseHeaders["x-nio-tts-diagnostic-request-id"], "diagnostic-1");
assert.equal(safeLatestRun.ttsTelemetry.chunks[0].responseHeaders["x-nio-tts-profile-id"], "sandrone-dev");
assert.deepEqual(safeLatestRun.ttsTelemetry.chunks[0].streamChunkArrivalMs, [14, 20]);
assert.deepEqual(safeLatestRun.ttsTelemetry.chunks[0].streamScheduleGapsMs, [0, 6]);
assert.equal(safeLatestRun.ttsTelemetry.bridge.queueState.cursor, 2);
assert.equal(safeLatestRun.ttsTelemetry.bridge.queueState.remaining, 0);
assert.deepEqual(safeLatestRun.ttsTelemetry.bridge.queue, ["asset-1", "asset-2"]);
assert.equal(safeLatestRun.ttsTelemetry.bridge.asset.assetId, "asset-1");
assert.equal(safeLatestRun.ttsTelemetry.bridge.maxPrebakedAssetsPerRun, 2);
assert.equal(safeLatestRun.ttsTelemetry.bridge.elapsedWaitMs, 20);
assert.equal(safeLatestRun.startedAtPerf, 100);
assert.equal(safeLatestRun.endedAtPerf, 180);
assert.equal(safeLatestRun.input, undefined);
assert.equal(safeLatestRun.error, "Runtime execution failed");
assert.deepEqual(safeLatestRun.events.map((item) => item.sequence), [1, 2, 3, 4, 5, 6]);
assert.doesNotMatch(JSON.stringify(safeLatestRun), new RegExp(runtimePrivateSentinel));

assert.equal(
  typeof runEventPresenter.buildRunDetailViewModel,
  "function",
  "Presenter must own the privacy-safe Live/Replay detail projection",
);
const replayDetail = runEventPresenter.buildRunDetailViewModel({
  input: "USER_OWNED_INPUT_SENTINEL",
  requestId: "presenter-run",
  result: rawRuntimeResult,
  events: rawRuntimeResult.events,
  ttsTelemetry: {
    prompt: runtimePrivateSentinel,
    token: runtimePrivateSentinel,
  },
}, {
  mode: "replay",
  eventViewModel: cursorView,
});
assert.equal(replayDetail.mode, "replay");
assert.deepEqual(replayDetail.timelineItems.map((item) => item.sequence), [1, 2, 3]);
assert.equal(replayDetail.result, null, "Replay details must not expose the completed Live result");
assert.equal(replayDetail.userInput, null, "Replay details must show only cursor-derived event presentation");
assert.equal(replayDetail.ttsTelemetry, null, "Replay details must not expose future Live TTS state");
assert.match(replayDetail.privacyNotice, /回放|事件|隐私/);
assert.doesNotMatch(
  JSON.stringify(replayDetail),
  /RUNTIME_PRIVATE_SENTINEL|USER_OWNED_INPUT_SENTINEL/,
  "Replay details must not leak final Live fields outside the visible event cursor",
);

const livePrivateResult = {
  ...rawRuntimeResult,
  rawText: runtimePrivateSentinel,
  sessionMemory: { turns: [{ rawText: runtimePrivateSentinel }] },
  token: runtimePrivateSentinel,
  data: { rawText: runtimePrivateSentinel },
  chainOfThought: runtimePrivateSentinel,
  cloudResult: {
    ...rawRuntimeResult.cloudResult,
    prompt: runtimePrivateSentinel,
    rawText: runtimePrivateSentinel,
    token: runtimePrivateSentinel,
    data: { private: runtimePrivateSentinel },
    telemetry: {
      ...rawRuntimeResult.cloudResult.telemetry,
      promptStyle: "compact",
      promptChars: runtimePrivateSentinel.length,
      sessionMemory: runtimePrivateSentinel,
    },
  },
  toolResult: {
    ...rawRuntimeResult.toolResult,
    rawText: runtimePrivateSentinel,
    token: runtimePrivateSentinel,
    data: { private: runtimePrivateSentinel },
  },
};
const liveDetail = runEventPresenter.buildRunDetailViewModel({
  input: "USER_OWNED_INPUT_SENTINEL",
  requestId: "presenter-run",
  result: livePrivateResult,
  events: rawRuntimeResult.events,
  startedAtPerf: 100,
  endedAtPerf: 180,
  ttsTelemetry: {
    status: "completed",
    provider: "gpt-sovits",
    prompt: runtimePrivateSentinel,
    token: runtimePrivateSentinel,
  },
}, {
  mode: "live",
  eventViewModel: view,
});
assert.equal(liveDetail.mode, "live");
assert.equal(liveDetail.userInput, "USER_OWNED_INPUT_SENTINEL", "the user's own input remains visible in Live details");
assert.equal(liveDetail.result.rawText, undefined);
assert.equal(liveDetail.result.sessionMemory, undefined);
assert.equal(liveDetail.result.cloudResult.prompt, undefined);
assert.equal(liveDetail.result.toolResult.data, undefined);
assert.deepEqual(liveDetail.llmInput, {
  model: "weather-location-clarification",
  provider: "local-boundary",
  promptChars: runtimePrivateSentinel.length,
  promptStyle: "compact",
});
assert.equal(liveDetail.ttsTelemetry.status, "completed");
assert.deepEqual(liveDetail.timelineItems.map((item) => item.sequence), [1, 2, 3, 4, 5, 6]);
assert.doesNotMatch(
  JSON.stringify(liveDetail.result),
  /RUNTIME_PRIVATE_SENTINEL/,
  "Live detail projection must exclude raw prompts, session memory, tokens, data, and chain-of-thought",
);

const activeRunDetail = runEventPresenter.buildRunDetailViewModel({
  input: "USER_OWNED_INPUT_SENTINEL",
  requestId: "active-run",
  result: null,
  vehicleStateSnapshot: {
    id: "active-snapshot",
    source: "demo-sensor-simulator",
    values: {
      speedKph: 0,
      gear: "P",
      rawPayload: runtimePrivateSentinel,
    },
  },
}, {
  mode: "live",
  eventViewModel: { logItems: [], timelineItems: [] },
});
assert.equal(activeRunDetail.result.vehicleStateSnapshot?.id, "active-snapshot");
assert.deepEqual(activeRunDetail.result.vehicleStateSnapshot?.values, {
  speedKph: 0,
  gear: "P",
});
assert.doesNotMatch(JSON.stringify(activeRunDetail), new RegExp(runtimePrivateSentinel));

const safePendingConfirmation = buildPendingConfirmationDebugSnapshot({
  input: runtimePrivateSentinel,
  intent: "body.tailgate.open",
  action: "require_confirmation",
  challenge: {
    id: "challenge-1",
    actionDigest: "digest-1",
    responseToken: runtimePrivateSentinel,
    assertions: [{ id: "rear-clearance", prompt: "Rear is clear" }],
  },
});
assert.equal(safePendingConfirmation.input, undefined);
assert.equal(safePendingConfirmation.challenge.actionDigest, "digest-1");
assert.equal(safePendingConfirmation.challenge.responseToken, undefined);
assert.doesNotMatch(JSON.stringify(safePendingConfirmation), new RegExp(runtimePrivateSentinel));

assert.equal(
  typeof runEventPresenter.buildPendingConfirmationViewModel,
  "function",
  "Presenter must project the confirmation content rendered by Live details",
);
const confirmationView = runEventPresenter.buildPendingConfirmationViewModel({
  input: "USER_OWNED_INPUT_SENTINEL",
  intent: "body.tailgate.open",
  action: "require_confirmation",
  reason: "需要确认尾门后方安全",
  alternative: "保持尾门关闭",
  challenge: {
    id: "challenge-1",
    actionDigest: "digest-1",
    responseToken: runtimePrivateSentinel,
    assertions: [{
      id: "rear-clearance",
      prompt: "我已确认尾门后方无人且无障碍物",
      token: runtimePrivateSentinel,
    }],
  },
});
assert.equal(confirmationView.input, "USER_OWNED_INPUT_SENTINEL");
assert.equal(confirmationView.challenge.id, "challenge-1");
assert.equal(confirmationView.challenge.assertions[0].prompt, "我已确认尾门后方无人且无障碍物");
assert.equal(confirmationView.challenge.responseToken, undefined);
assert.doesNotMatch(JSON.stringify(confirmationView), new RegExp(runtimePrivateSentinel));

const stableFacadeController = createStableHmiRunDebugFacade(safeLatestRun);
const stableFacade = stableFacadeController.facade;
assert.ok(Object.isFrozen(stableFacade));
assert.equal(stableFacade.requestId, "presenter-run");
assert.throws(() => {
  stableFacade.requestId = "forged";
}, TypeError);
assert.throws(() => {
  stableFacade.result.mode = "forged";
}, TypeError);
const updatedSafeLatestRun = buildHmiRunDebugSnapshot({
  ...safeLatestRun,
  ttsTelemetry: { status: "playing", scheduledFirstAudioMs: 44 },
}, {
  events: view.logItems,
});
assert.equal(stableFacadeController.update(updatedSafeLatestRun), stableFacade);
assert.equal(stableFacade.requestId, "presenter-run");
assert.equal(stableFacade.ttsTelemetry.status, "playing");
assert.equal(stableFacade.ttsTelemetry.scheduledFirstAudioMs, 44);
assert.equal(stableFacade.update, undefined);

const ledger = new RunEventLedger();
let latestProjection = null;
const projectionListener = createSafeRunEventProjectionListener(
  (snapshot) => {
    latestProjection = buildRunEventViewModel(snapshot);
  },
);
ledger.subscribe(projectionListener);
for (const item of events) ledger.append(item);
assert.equal(latestProjection.terminalStatus, null);
ledger.completeRun(run.runId);
assert.equal(latestProjection.terminalStatus, "completed");
assert.deepEqual(
  latestProjection.components.map((component) => component.id),
  view.components.map((component) => component.id),
);

const swallowedProjectionError = new Error("projection failed");
const swallowedErrorHandlerError = new Error("error handler failed");
const nonThrowingListener = createSafeRunEventProjectionListener(
  () => {
    throw swallowedProjectionError;
  },
  (error) => {
    assert.equal(error, swallowedProjectionError);
    throw swallowedErrorHandlerError;
  },
);
assert.doesNotThrow(() => nonThrowingListener(run));

const app = fs.readFileSync(new URL("../../src/app/app.js", import.meta.url), "utf8");
assert.match(app, /data-component="\$\{escapeHtml\(component\.id\)\}" data-component-type="\$\{escapeHtml\(component\.type\)\}"/);
assert.match(app, /runtime\.runEventLedger\.subscribe\(/);
assert.match(app, /createSafeRunEventProjectionListener\(/);
assert.match(app, /const currentRunSnapshot = buildRunEventDebugSnapshot\(currentRun\)/);
assert.match(app, /const previousRunSnapshot = buildRunEventDebugSnapshot\(previousRun\)/);
assert.match(app, /currentRun: currentRunSnapshot/);
assert.match(app, /previousRun: previousRunSnapshot/);
assert.match(app, /viewModel\.logItems\.slice\(-80\)/);
assert.match(app, /lastRuntimeResult: buildRuntimeResultDebugSnapshot\(/);
assert.match(app, /const latestRunSnapshot = getSafeRuntimeDebugLatestRun\(run, safeEvents\)/);
assert.match(app, /latestRun: latestRunSnapshot/);
assert.match(app, /events: presenterDebugSnapshot\?\.events \|\| \[\]/);
assert.match(app, /components: presenterDebugSnapshot\?\.components \|\| \[\]/);
assert.match(app, /pendingConfirmation: buildPendingConfirmationDebugSnapshot\(state\.pendingConfirmation\)/);
assert.doesNotMatch(app, /lastRuntimeResult: state\.lastRuntimeResult/);
assert.doesNotMatch(app, /latestRun: run,/);
assert.doesNotMatch(app, /events: Array\.isArray\(run\?\.events\) \? run\.events : \[\]/);
assert.match(app, /while \(els\.eventLog\.children\.length > 80\)/);
assert.match(app, /createStableHmiRunDebugFacade\(projection\)/);
assert.doesNotMatch(app, /Object\.assign\(state\.runtimeDebugLatestRun/);
assert.equal(
  (app.match(/buildRunEventViewModel\(/g) || []).length,
  1,
  "ledger subscription must be the single Presenter projection path",
);
assert.match(app, /renderB2ProjectionCards\(detail\.b2\)/, "B2 details must reuse the existing run detail area");
assert.match(app, /b2ComponentTask\(viewModel\.b2, component\)/, "B2 progress must reuse current component cards");
assert.doesNotMatch(app, /b2PageState|b2Store/, "B2 presentation must not add a second page state store");

assert.ok(Object.isFrozen(view.b2), "B2 projection must be deeply frozen");
assert.deepEqual(view.b2, {
  visibility: {
    cabinAssistant: true,
    orchestrator: false,
  },
  goal: null,
  plan: null,
  validation: null,
  executionFacts: null,
  planningFallback: null,
  degradation: null,
  response: null,
});

console.log("run event presenter verification passed");
