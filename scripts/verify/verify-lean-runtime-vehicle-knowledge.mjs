#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  callNames,
  createCompatibilityHarness,
  createLeanRuntimeVehicleKnowledgeHarness,
} from "../lib/lean-runtime-test-harness.mjs";
import { resolveVehicleSluKnowledgeGoalAuthority } from "../../src/agents/goal-authority.js";
import { RUN_EVENT_PROTOCOL, validateRunEvent } from "../../src/runtime/run-event-protocol.js";
import { prepareManualRetrievalCandidate } from "../../src/manual/manual-retrieval-candidate.js";

assert.deepEqual(RUN_EVENT_PROTOCOL, { id: "nio-run-event", version: "2.0.0" });

// Read-only knowledge authority is derived only from a Vehicle-SLU knowledge frame.
const knowledgeFrame = Object.freeze({
  frameId: "frame:knowledge-authority",
  capability: "knowledge",
  intent: "vehicle.knowledge.query",
  speechAct: "question",
  knowledgeNeed: "manual",
  actionNeed: "none",
  slots: { query: "ES8 尾门能不能打开？", vehicleModel: "ES8" },
  missingSlots: [],
  clarificationQuestion: null,
  standaloneQuery: "ES8 尾门能不能打开？",
  confidence: 1,
});
assert.ok(resolveVehicleSluKnowledgeGoalAuthority(knowledgeFrame), "a knowledge frame grants authority");
assert.equal(
  resolveVehicleSluKnowledgeGoalAuthority({
    ...knowledgeFrame,
    capability: "control",
    intent: "body.window.setPosition",
    speechAct: "command",
    actionNeed: "execute",
  }),
  null,
  "an actionable vehicle command frame must never receive read-only knowledge authority",
);
verifyEligibilityClaimPredicate();

const vehicleStateHarness = createCompatibilityHarness({
  route: "vehicle-state-role-baseline",
  modelBehavior: {
    async parse(_text, input) {
      return { semanticEnvelope: vehicleStateQueryEnvelope(input.requestId) };
    },
  },
});
const vehicleStateResult = await vehicleStateHarness.runtime.run(
  "我的 ES8 当前挡位和车速是多少？",
  { requestId: "run:knowledge:vehicle-state" },
);
assert.deepEqual(callNames(vehicleStateHarness.calls), ["semantic.parse", "provider.read"]);
assert.equal(vehicleStateResult.routeDecision.reasonCode, "vehicle-state-query");
assert.equal(vehicleStateResult.manualEvidence, null);
assert.equal(vehicleStateResult.safetyDecision, null);
assert.equal(vehicleStateResult.toolCall, null);
assert.equal(vehicleStateResult.toolResult, null);
assert.ok(vehicleStateResult.vehicleStateSnapshot?.id);
assert.deepEqual(Object.keys(vehicleStateResult.vehicleStateSnapshot.values).sort(), ["gear", "speedKph"]);
assert.deepEqual(vehicleStateParticipants(vehicleStateResult), ["vehicleStateProvider", "cabinAssistant"]);
assertNonEmptyAssistantResponse(vehicleStateResult, "vehicle state query");
assertValidEvents(vehicleStateResult);

const staticHarness = createLeanRuntimeVehicleKnowledgeHarness();
const staticBefore = structuredClone(staticHarness.provider.getSnapshot().values);
const staticResult = await staticHarness.runtime.run(
  "ES8 打开尾门前需要确认什么条件？",
  { requestId: "run:knowledge:static" },
);
assert.deepEqual(callNames(staticHarness.calls), ["manual.retrieve", "knowledge.synthesize"]);
assert.equal(staticResult.toolCall, null);
assert.equal(staticResult.toolResult, null);
assert.equal(staticResult.runtimeTelemetry.modelCallCount, 1);
assert.deepEqual(staticResult.runtimeTelemetry.modelCalls, [{
  phase: "knowledge-answer",
  telemetry: {
    model: "fake-knowledge-answer",
    provider: "fake-cloud",
    durationMs: 1,
    degraded: false,
  },
}]);
assert.equal(staticResult.manualEvidence.status, "hit");
assert.equal(staticResult.manualEvidence.evidenceRefs.length, 1);
const strictManualEvidenceRef = {
  sourceId: "nio-es8-user-manual-2026",
  sourceVersion: "2026.07",
  chunkId: "manual:tailgate",
  pageStart: 88,
  pageEnd: 89,
  excerpt: "开启尾门前应确认开闭路径附近没有障碍物。",
  score: { retrieval: 0.92, rerank: null, grounding: 0.95 },
};
assert.deepEqual(staticResult.manualEvidence.evidenceRefs[0], strictManualEvidenceRef);
assert.deepEqual(
  staticResult.events.find((event) => event.phase === "knowledge-evidence")
    .metadata.knowledge.evidenceRefs[0],
  strictManualEvidenceRef,
  "Run Event metadata must preserve all seven Manual EvidenceRef fields and every score",
);
const staticEvidenceEvent = staticResult.events.find((event) => event.phase === "knowledge-evidence");
assert.equal(staticEvidenceEvent.durationMs, 1,
  "Manual Retriever duration must use the existing RunEvent top-level field");
assert.equal(Object.hasOwn(staticEvidenceEvent.metadata.knowledge, "durationMs"), false);
assert.doesNotMatch(JSON.stringify(staticEvidenceEvent), /manualRetrievalDurationMs|embedding|prompt|PRIVATE_RAW/);
assert.deepEqual(staticHarness.provider.getSnapshot().values, staticBefore);
assert.deepEqual(knowledgeParticipants(staticResult), ["manualRetriever", "cabinAssistant"]);
assertDirectKnowledgeEntry(staticResult);
assert.equal(hasKnowledgeParticipant(staticResult, "vehicleStateProvider"), false);
assert.equal(hasKnowledgeParticipant(staticResult, "safety"), false);
assertValidEvents(staticResult);

const candidateCalls = [];
const candidateHarness = createLeanRuntimeVehicleKnowledgeHarness({
  prepareManualRetrievalCandidate(input) {
    return prepareManualRetrievalCandidate({
      ...input,
      retrieve(candidateQuery, options) {
        candidateCalls.push({ query: candidateQuery, options });
        return [strictManualEvidenceRef];
      },
      monotonicNow: (() => {
        const ticks = [0, 5000];
        return () => ticks.shift();
      })(),
    });
  },
});
const candidateResult = await candidateHarness.runtime.run(
  "ES8 尾门怎么开？",
  { requestId: "run:knowledge:parallel-candidate" },
);
assert.equal(candidateCalls.length, 1);
assert.equal(candidateCalls[0].query, "ES8 尾门怎么开？");
assert.equal(callNames(candidateHarness.calls).includes("manual.retrieve"), false,
  "exact candidate must suppress the ordinary serial retriever");
assert.equal(candidateResult.manualEvidence.status, "hit");
assert.equal(
  candidateResult.events.find((event) => event.phase === "knowledge-evidence").durationMs,
  5000,
  "committed evidence event must preserve candidate retrieval duration",
);
assertValidEvents(candidateResult);

const currentHarness = createLeanRuntimeVehicleKnowledgeHarness();
const currentBefore = structuredClone(currentHarness.provider.getSnapshot().values);
const currentResult = await currentHarness.runtime.run(
  "我的 ES8 现在能打开尾门吗？",
  { requestId: "run:knowledge:current" },
);
assert.deepEqual(callNames(currentHarness.calls), [
  "manual.retrieve", "provider.refresh", "provider.read", "safety.evaluate", "knowledge.synthesize",
]);
assert.equal(currentResult.toolCall, null);
assert.equal(currentResult.toolResult, null);
assert.equal(currentResult.runtimeTelemetry.modelCallCount, 1);
assert.equal(currentResult.safetyDecision.allowed, true);
assertDirectKnowledgeEntry(currentResult);
assert.equal(hasKnowledgeParticipant(currentResult, "vehicleStateProvider"), true);
assert.equal(hasKnowledgeParticipant(currentResult, "safety"), true);
assert.deepEqual(currentHarness.provider.getSnapshot().values, currentBefore);
assertValidEvents(currentResult);

const complexHarness = createLeanRuntimeVehicleKnowledgeHarness();
const complexResult = await complexHarness.runtime.run(
  "比较 ES8 尾门和车窗的安全条件",
  { requestId: "run:knowledge:complex" },
);
assert.deepEqual(callNames(complexHarness.calls), [
  "orchestrator.planKnowledgeTask", "knowledge.plan", "manual.retrieve", "knowledge.synthesize",
]);
assert.equal(complexResult.runtimeTelemetry.modelCallCount, 2);
assert.deepEqual(
  complexResult.runtimeTelemetry.modelCalls.map((call) => call.phase),
  ["knowledge-subplanning", "knowledge-answer"],
);
assertDirectKnowledgeEntry(complexResult, { allowsOrchestrator: true });
assert.equal(callNames(complexHarness.calls).includes("knowledge.plan"), true);
assert.equal(complexResult.events.some((event) => event.phase === "knowledge-subplanning"), true);
assertModelPrecedesAgent(complexResult, {
  modelPhase: "knowledge-plan-model",
  agentPhase: "knowledge-subplanning",
  modelComponent: "orchestratorModel",
  agentComponent: "orchestrator",
});
assertModelPrecedesAgent(complexResult, {
  modelPhase: "knowledge-answer-model",
  agentPhase: "knowledge-answer",
  modelComponent: "cabinModel",
  agentComponent: "cabinAssistant",
});
assert.equal(hasKnowledgeParticipant(complexResult, "vehicleStateProvider"), false);
assert.equal(hasKnowledgeParticipant(complexResult, "safety"), false);
assert.equal(complexResult.toolCall, null);
assert.equal(complexResult.toolResult, null);
assertValidEvents(complexResult);

const knowledgePoisonHarness = createLeanRuntimeVehicleKnowledgeHarness({
  privateKnowledgeTelemetryReason: "PRIVATE_KNOWLEDGE_REASON",
});
const knowledgePoisonResult = await knowledgePoisonHarness.runtime.run(
  "比较 ES8 尾门和车窗的安全条件",
  { requestId: "run:knowledge:private-reason" },
);
assert.equal(JSON.stringify(knowledgePoisonResult.events).includes("PRIVATE_KNOWLEDGE_REASON"), false);

const invalidAnswerHarness = createLeanRuntimeVehicleKnowledgeHarness({
  modelBehavior: {
    async synthesize() {
      const error = new Error("PRIVATE_INVALID_ANSWER_BODY");
      error.telemetry = {
        provider: "dashscope",
        model: "qwen3.5-flash-2026-02-23",
        durationMs: 4567,
        degraded: true,
        reason: "knowledge-result-invalid",
      };
      throw error;
    },
  },
});
const invalidAnswer = await invalidAnswerHarness.runtime.run(
  "ES8 打开尾门前需要确认什么条件？",
  { requestId: "run:knowledge:invalid-answer" },
);
assert.equal(knowledgeAnswerBoundary(invalidAnswer).outcomeStatus, "unavailable");
assert.equal(knowledgeAnswerEvent(invalidAnswer).metadata.reasonCode, "knowledge-result-invalid");
assert.deepEqual(invalidAnswer.runtimeTelemetry.modelCalls, [{
  phase: "knowledge-answer",
  telemetry: {
    provider: "dashscope",
    model: "qwen3.5-flash-2026-02-23",
    durationMs: 4567,
    degraded: true,
    reason: "knowledge-result-invalid",
    reasonCode: "knowledge-result-invalid",
  },
}]);
assert.equal(JSON.stringify(invalidAnswer.events).includes("PRIVATE_INVALID_ANSWER_BODY"), false);
assertValidEvents(invalidAnswer);

const ragMissHarness = createLeanRuntimeVehicleKnowledgeHarness({ ragMiss: true });
const ragMiss = await ragMissHarness.runtime.run(
  "ES8 打开尾门前需要确认什么条件？",
  { requestId: "run:knowledge:rag-miss" },
);
assert.deepEqual(callNames(ragMissHarness.calls), ["manual.retrieve", "knowledge.synthesize"]);
assert.equal(ragMiss.manualEvidence.status, "miss");
assert.deepEqual(ragMiss.manualEvidence.evidenceRefs, []);
assert.equal(knowledgeAnswerBoundary(ragMiss).outcomeStatus, "answered");
assert.equal(knowledgeAnswerBoundary(ragMiss).supportStatus, "unsupported");
assertNonEmptyAssistantResponse(ragMiss, "RAG miss");
assert.equal(hasRagMissBoundary(ragMiss.assistantResponse), true);
assertNoPositiveEligibilityClaim(ragMiss, "RAG miss");
assert.equal(ragMiss.runtimeTelemetry.degraded, true);
assert.equal(ragMiss.toolCall, null);

const ragUnavailableHarness = createLeanRuntimeVehicleKnowledgeHarness({
  manualRetriever: async () => manualApiEvidence([], {
    status: "unavailable",
    runId: "run:knowledge:rag-unavailable",
    retrievalMode: "vector-bge-m3",
    embeddingStatus: "unavailable",
    reason: "embedding-unavailable",
  }),
});
const ragUnavailable = await ragUnavailableHarness.runtime.run(
  "ES8 打开尾门前需要确认什么条件？",
  { requestId: "run:knowledge:rag-unavailable" },
);
assert.deepEqual(callNames(ragUnavailableHarness.calls), ["manual.retrieve"]);
assert.equal(ragUnavailable.runtimeTelemetry.modelCallCount, 0);
assert.equal(knowledgeAnswerBoundary(ragUnavailable).outcomeStatus, "unavailable");
assert.equal(knowledgeAnswerEvent(ragUnavailable).metadata.reasonCode, "manual-rag-unavailable");
assert.deepEqual(knowledgeParticipants(ragUnavailable), ["manualRetriever", "cabinAssistant"]);
assertNonEmptyAssistantResponse(ragUnavailable, "RAG unavailable");
assert.equal(ragUnavailable.toolCall, null);

const otherModelHarness = createLeanRuntimeVehicleKnowledgeHarness();
const otherModel = await otherModelHarness.runtime.run(
  "ET5 打开尾门前需要确认什么条件？",
  { requestId: "run:knowledge:other-model" },
);
assert.deepEqual(callNames(otherModelHarness.calls), []);
assert.equal(otherModel.runtimeTelemetry.modelCallCount, 0);
assert.equal(otherModel.manualEvidence, null);
assert.equal(otherModel.routeDecision.reasonCode, "vehicle-knowledge-not-applicable");
assertNonEmptyAssistantResponse(otherModel, "non-ES8 boundary");
assert.equal(hasNonEs8Boundary(otherModel.assistantResponse), true);
assertNoPositiveEligibilityClaim(otherModel, "non-ES8 boundary");
assert.equal(otherModel.events.some((event) => event.component === "manualRetriever"), false);
assert.equal(otherModel.toolCall, null);

const staleHarness = createLeanRuntimeVehicleKnowledgeHarness({ staleProvider: true });
const stale = await staleHarness.runtime.run(
  "我的 ES8 现在能打开尾门吗？",
  { requestId: "run:knowledge:stale-provider" },
);
assert.deepEqual(callNames(staleHarness.calls), ["manual.retrieve", "provider.refresh", "provider.read"]);
assert.equal(stale.runtimeTelemetry.modelCallCount, 0);
assert.equal(stale.runtimeTelemetry.degraded, true);
assert.equal(knowledgeAnswerBoundary(stale).outcomeStatus, "unavailable");
assert.equal(knowledgeAnswerEvent(stale).metadata.reasonCode, "vehicle-state-not-current");
assertNonEmptyAssistantResponse(stale, "stale vehicle state");
assert.equal(hasStaleStateBoundary(stale.assistantResponse), true);
assertNoPositiveEligibilityClaim(stale, "stale vehicle state");
assert.equal(hasKnowledgeParticipant(stale, "vehicleStateProvider"), true);
assert.equal(hasKnowledgeParticipant(stale, "safety"), false);
assert.equal(stale.safetyDecision, null);
assert.equal(stale.toolCall, null);

const safetyUnavailableHarness = createLeanRuntimeVehicleKnowledgeHarness({ safetyUnavailable: true });
const safetyUnavailable = await safetyUnavailableHarness.runtime.run(
  "我的 ES8 现在能打开尾门吗？",
  { requestId: "run:knowledge:safety-unavailable" },
);
assert.deepEqual(callNames(safetyUnavailableHarness.calls), [
  "manual.retrieve", "provider.refresh", "provider.read", "safety.evaluate",
]);
assert.equal(safetyUnavailable.runtimeTelemetry.modelCallCount, 0);
assert.equal(safetyUnavailable.runtimeTelemetry.degraded, true);
assert.equal(knowledgeAnswerBoundary(safetyUnavailable).outcomeStatus, "unavailable");
assert.equal(knowledgeAnswerEvent(safetyUnavailable).metadata.reasonCode, "knowledge-capability-unavailable");
assertNonEmptyAssistantResponse(safetyUnavailable, "Safety unavailable");
assert.equal(hasSafetyUnavailableBoundary(safetyUnavailable.assistantResponse), true);
assertNoPositiveEligibilityClaim(safetyUnavailable, "Safety unavailable");
assert.equal(hasKnowledgeParticipant(safetyUnavailable, "safety"), true);
assert.equal(safetyUnavailable.safetyDecision, null);
assert.equal(safetyUnavailable.toolCall, null);

const cancellationStarted = deferred();
const cancellationLate = deferred();
const cancellationHarness = createLeanRuntimeVehicleKnowledgeHarness({
  manualRetriever() {
    cancellationStarted.resolve();
    return cancellationLate.promise;
  },
});
const abortController = new AbortController();
const cancelledRun = cancellationHarness.runtime.run(
  "ES8 打开尾门前需要确认什么条件？",
  { requestId: "run:knowledge:cancelled", signal: abortController.signal },
);
await cancellationStarted.promise;
abortController.abort("user-cancelled");
cancellationLate.resolve([{
  chunkId: "manual:late",
  sourceId: "nio-es8-user-manual-2026",
  title: "ES8 用户手册",
  citation: "迟到证据",
  text: "该迟到证据不得公开。",
}]);
await assert.rejects(cancelledRun, (error) => error?.name === "AbortError");
assert.deepEqual(callNames(cancellationHarness.calls), ["manual.retrieve"]);
assert.equal(cancellationHarness.ledger.getCurrentRun(), null);
assert.equal(cancellationHarness.ledger.getPreviousRun().status, "cancelled");
assert.equal(
  cancellationHarness.ledger.getPreviousRun().events.some((event) => event.summary?.includes("迟到证据")),
  false,
);

const observedBehaviorBaseline = Object.freeze([
  observeBehavior("simple-manual", staticHarness, staticResult),
  observeBehavior("vehicle-state", vehicleStateHarness, vehicleStateResult, {
    participants: vehicleStateParticipants(vehicleStateResult),
  }),
  observeBehavior("complex-multi-component", complexHarness, complexResult),
  observeBehavior("non-es8", otherModelHarness, otherModel),
  observeBehavior("rag-miss", ragMissHarness, ragMiss),
  observeBehavior("safety-eligibility", currentHarness, currentResult),
  observeBehavior("cancellation-late-result", cancellationHarness, null, {
    events: cancellationHarness.ledger.getPreviousRun().events,
  }),
]);
assert.deepEqual(observedBehaviorBaseline, [
  {
    id: "simple-manual",
    serviceCallOrder: ["manual.retrieve", "knowledge.synthesize"],
    participants: ["manualRetriever", "cabinAssistant"],
    evidenceStatus: "hit",
    evidenceRefCount: 1,
    safetyCallCount: 0,
    vehicleCallCount: 0,
    finalStatus: "completed",
  },
  {
    id: "vehicle-state",
    serviceCallOrder: ["semantic.parse", "provider.read"],
    participants: ["vehicleStateProvider", "cabinAssistant"],
    evidenceStatus: null,
    evidenceRefCount: 0,
    safetyCallCount: 0,
    vehicleCallCount: 0,
    finalStatus: "completed",
  },
  {
    id: "complex-multi-component",
    serviceCallOrder: ["orchestrator.planKnowledgeTask", "knowledge.plan", "manual.retrieve", "knowledge.synthesize"],
    participants: ["orchestrator", "manualRetriever", "cabinAssistant"],
    evidenceStatus: "hit",
    evidenceRefCount: 1,
    safetyCallCount: 0,
    vehicleCallCount: 0,
    finalStatus: "completed",
  },
  {
    id: "non-es8",
    serviceCallOrder: [],
    participants: ["cabinAssistant"],
    evidenceStatus: null,
    evidenceRefCount: 0,
    safetyCallCount: 0,
    vehicleCallCount: 0,
    finalStatus: "completed",
  },
  {
    id: "rag-miss",
    serviceCallOrder: ["manual.retrieve", "knowledge.synthesize"],
    participants: ["manualRetriever", "cabinAssistant"],
    evidenceStatus: "miss",
    evidenceRefCount: 0,
    safetyCallCount: 0,
    vehicleCallCount: 0,
    finalStatus: "completed",
  },
  {
    id: "safety-eligibility",
    serviceCallOrder: [
      "manual.retrieve", "provider.refresh", "provider.read", "safety.evaluate", "knowledge.synthesize",
    ],
    participants: ["manualRetriever", "vehicleStateProvider", "safety", "cabinAssistant"],
    evidenceStatus: "hit",
    evidenceRefCount: 1,
    safetyCallCount: 1,
    vehicleCallCount: 0,
    finalStatus: "completed",
  },
  {
    id: "cancellation-late-result",
    serviceCallOrder: ["manual.retrieve"],
    participants: [],
    evidenceStatus: null,
    evidenceRefCount: 0,
    safetyCallCount: 0,
    vehicleCallCount: 0,
    finalStatus: "cancelled",
  },
]);
assert.equal(hasKnowledgeParticipant(staticResult, "cabinAssistant"), true);
assert.equal(hasKnowledgeParticipant(complexResult, "orchestrator"), true);
assert.equal(hasKnowledgeParticipant(complexResult, "cabinAssistant"), true);

for (const [label, harness, result] of [
  ["static", staticHarness, staticResult],
  ["current", currentHarness, currentResult],
  ["complex", complexHarness, complexResult],
  ["rag-miss", ragMissHarness, ragMiss],
  ["rag-unavailable", ragUnavailableHarness, ragUnavailable],
  ["other-model", otherModelHarness, otherModel],
  ["stale", staleHarness, stale],
  ["safety-unavailable", safetyUnavailableHarness, safetyUnavailable],
]) {
  assert.equal(result.toolCall, null, `${label}: no Vehicle ToolCall`);
  assert.equal(result.toolResult, null, `${label}: no Vehicle ToolResult`);
  assert.equal(
    callNames(harness.calls).some((name) => /vehicle\.|provider\.write|animation/i.test(name)),
    false,
    `${label}: zero vehicle/animation mutation`,
  );
}

console.log("lean runtime vehicle knowledge verification passed");

function knowledgeParticipants(result) {
  return knowledgeParticipantsFromEvents(result.events);
}

function knowledgeParticipantsFromEvents(events) {
  return events
    .filter((event) => event.phase.startsWith("knowledge-")
      || (event.phase === "final-synthesis" && event.component === "cabinAssistant"))
    .filter((event) => event.phase !== "knowledge-delegation")
    .filter((event) => !["cabinModel", "orchestratorModel"].includes(event.component))
    .map((event) => event.component);
}

function observeBehavior(id, harness, result, {
  events = result?.events || [],
  participants = knowledgeParticipantsFromEvents(events),
} = {}) {
  const names = callNames(harness.calls);
  return {
    id,
    serviceCallOrder: names,
    participants,
    evidenceStatus: result?.manualEvidence?.status ?? null,
    evidenceRefCount: result?.manualEvidence?.evidenceRefs?.length ?? 0,
    safetyCallCount: names.filter((name) => name === "safety.evaluate").length,
    vehicleCallCount: names.filter((name) => /^(?:vehicle\.|provider\.write|animation)/i.test(name)).length,
    finalStatus: harness.ledger?.getPreviousRun()?.status ?? finalStatusFromEvents(events),
  };
}

function assertNonEmptyAssistantResponse(result, label) {
  assert.equal(typeof result?.assistantResponse, "string", `${label}: assistant response must be a string`);
  assert.ok(result.assistantResponse.trim(), `${label}: assistant response must be non-empty`);
}

function assertNoPositiveEligibilityClaim(result, label) {
  assert.equal(
    hasUnnegatedPositiveEligibilityClaim(result.assistantResponse),
    false,
    `${label}: fail-closed boundary must not claim positive current eligibility`,
  );
}

function hasUnnegatedPositiveEligibilityClaim(value) {
  const candidatePatterns = [
    /(?:能够|可以|允许|准许|能)[^，,。！？!?；;\n]{0,12}(?:打开|开启)/gu,
    /(?:Safety|安全)[^，,。！？!?；;\n]{0,12}(?:通过|允许|合格)/giu,
    /(?:满足|符合)[^，,。！？!?；;\n]{0,8}(?:打开|开启)\s*条件/gu,
    /(?:打开|开启)\s*条件[^，,。！？!?；;\n]{0,10}(?:满足|符合)/gu,
  ];
  return eligibilityClauses(value).some((clause) => candidatePatterns.some((pattern) => (
    [...clause.matchAll(pattern)].some((match) => !eligibilityClaimIsNegated(clause, match.index, match[0]))
  )));
}

function eligibilityClauses(value) {
  return String(value || "")
    .split(/[。！？!?；;\n]+|(?:，|,)?\s*(?:但是|但|不过|然而|却|仍然|仍|也)\s*/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function eligibilityClaimIsNegated(clause, matchIndex, matchedClaim) {
  const hasQuestionMarker = /(?:是否|能否|可否)/u.test(matchedClaim);
  const hasGovernedStrongNegation = /(?:无法|不能|不可|难以|禁止|拒绝)[^，,。！？!?；;\n]{0,4}(?:确认|判断|证明|打开|开启|满足|通过)/u.test(matchedClaim);
  const hasDirectPredicateNegation = /(?:不|未)\s*(?:能|可|允许|准许|打开|开启|满足|通过)/u.test(matchedClaim);
  if (hasQuestionMarker || hasGovernedStrongNegation || hasDirectPredicateNegation) {
    return true;
  }
  const prefix = clause.slice(0, matchIndex);
  const scope = prefix.split(/[，,：:]/u).at(-1).replace(/\s+/gu, "").slice(-28);
  if (/(?:没有|缺少|无|未有).{0,8}(?:证据|依据|资料).{0,8}(?:证明|表明|支持)$/u.test(scope)) {
    return true;
  }
  if (/(?:尚)?(?:不能|无法)(?:据此)?(?:证明|表明|认为|确认|判断)(?:当前)?(?:是否)?$/u.test(scope)) {
    return true;
  }
  return /(?:无法|不能|不可|未能|尚不能|暂不能|难以|禁止|拒绝|不|未|没|无)(?:确认|判断|说明|保证|确定)?(?:是否)?$/u.test(scope);
}

function hasRagMissBoundary(value) {
  const text = String(value || "");
  const evidenceInsufficient = /(?:未|没|无).{0,24}(?:证据|依据|资料)|(?:证据|依据|资料).{0,12}(?:不足|缺失|不够|不充分|不可靠)/u.test(text);
  const conclusionRefused = /(?:不能|无法|不可|暂不能|不应|拒绝).{0,18}(?:回答|结论|判断|确认|编造|操作步骤)/u.test(text);
  return evidenceInsufficient && conclusionRefused;
}

function hasNonEs8Boundary(value) {
  const text = String(value || "");
  return /(?:仅|只).{0,8}(?:支持|接入|适用|覆盖).{0,8}ES8/u.test(text)
    || /(?:ET5|其他车型|目标车型).{0,14}(?:不支持|不适用|未接入|无法回答)/u.test(text)
    || /(?:不支持|不适用|未接入|无法回答).{0,14}(?:ET5|其他车型|目标车型)/u.test(text);
}

function hasStaleStateBoundary(value) {
  const text = String(value || "");
  return /(?:车辆)?状态.{0,14}(?:过期|失效|陈旧|非当前|不.{0,3}当前|无法确认|不可确认)/u.test(text)
    || /(?:无法|不能|暂不能).{0,14}(?:确认|判断|生成).{0,14}(?:当前)?(?:车辆)?(?:状态|资格|结论)/u.test(text);
}

function hasSafetyUnavailableBoundary(value) {
  const text = String(value || "");
  return /(?:Safety|安全|检查|评估).{0,14}(?:不可用|失败|未完成)/iu.test(text)
    || /(?:车辆知识执行|资格检查).{0,14}(?:不可用|失败|未完成)/u.test(text);
}

function verifyEligibilityClaimPredicate() {
  const unsafe = [
    "可以打开尾门。",
    "允许开启尾门。",
    "Safety 评估通过。",
    "满足开启条件。",
    "未找到证据，但可以打开尾门。",
    "仅支持 ES8，但 ET5 也可以打开尾门。",
    "车辆状态已过期，但可以打开尾门。",
    "Safety 不可用，但可以打开尾门。",
    "未找到证据，无法给出结论，但可以正常打开尾门。",
    "车辆状态已失效，暂不能判断；但可以把尾门打开。",
    "Safety 检查失败，暂不能判断，不过尾门开启条件均已满足。",
    "允许把尾门开启。",
    "能够打开尾门。",
    "能正常打开尾门。",
    "可以在无障碍时打开尾门。",
    "可以在未发现障碍时打开尾门。",
    "可以在不影响安全时打开尾门。",
    "不下雨时能够打开尾门。",
    "打开条件已经满足。",
    "没有证据，但可以打开尾门。",
  ];
  for (const text of unsafe) {
    assert.throws(
      () => assertNoPositiveEligibilityClaim({ assistantResponse: text }, `unsafe fixture: ${text}`),
      assert.AssertionError,
      `unnegated or contradictory positive eligibility must be rejected: ${text}`,
    );
  }
  for (const text of [
    "当前不可以打开尾门。",
    "现在不允许开启尾门。",
    "当前无法确认是否可以打开尾门。",
    "不能判断是否满足开启条件。",
    "没有证据证明可以打开尾门。",
    "不能据此认为可以打开尾门。",
    "尚无法确认当前是否可以打开尾门。",
    "可以确认当前无法打开尾门。",
    "可以判断目前不能打开尾门。",
    "开启条件尚未满足。",
  ]) {
    assert.doesNotThrow(
      () => assertNoPositiveEligibilityClaim({ assistantResponse: text }, `safe fixture: ${text}`),
      `negated or uncertain eligibility must remain allowed: ${text}`,
    );
  }
  for (const [label, predicate, text] of [
    ["RAG evidence shortage", hasRagMissBoundary, "手册资料不足，暂不能回答。"],
    ["non-ES8 unsupported", hasNonEs8Boundary, "暂不支持 ET5 车型知识。"],
    ["stale state", hasStaleStateBoundary, "车辆状态已失效，暂不能判断。"],
    ["Safety failure", hasSafetyUnavailableBoundary, "Safety 检查失败，暂不能判断。"],
  ]) {
    assert.equal(predicate(text), true, `${label}: broad fail-closed wording must remain accepted`);
  }
}

function knowledgeAnswerBoundary(result) {
  return knowledgeAnswerEvent(result).metadata.knowledge;
}

function knowledgeAnswerEvent(result) {
  const event = result.events.find((candidate) => (
    candidate.phase === "knowledge-answer" && candidate.component === "cabinAssistant"
  ));
  assert.ok(event, "knowledge result must publish a knowledge-answer boundary event");
  return event;
}

function manualApiEvidence(refs, metadata) {
  const evidence = [...refs];
  Object.defineProperty(evidence, "metadata", {
    value: Object.freeze({
      evidenceContract: "manual-evidence-ref@1.0.0",
      ...metadata,
    }),
  });
  return evidence;
}

function vehicleStateParticipants(result) {
  return result.events
    .filter((event) => event.phase === "capability-execution"
      || (event.phase === "final-synthesis" && event.component === "cabinAssistant"))
    .map((event) => event.component);
}

function finalStatusFromEvents(events) {
  const terminal = [...events].reverse().find((event) => event.phase === "final-response");
  if (terminal?.status === "completed") return "completed";
  return terminal?.status ?? null;
}

function vehicleStateQueryEnvelope(requestId) {
  return {
    contractVersion: "nio-vehicle-slu-contract@2.0.0",
    requestId,
    domain: "vehicle",
    conversationGoal: { summary: "读取当前车辆状态", need: "explain" },
    vehicleFrames: [{
      frameId: `frame:${requestId}:vehicle-state`,
      capability: "knowledge",
      intent: "vehicle.state.query",
      speechAct: "question",
      knowledgeNeed: "none",
      actionNeed: "none",
      slots: { stateFields: ["speedKph", "gear"] },
      missingSlots: [],
      clarificationQuestion: null,
      standaloneQuery: null,
      confidence: 0.99,
    }],
    domainConfidence: 0.99,
  };
}

function hasKnowledgeParticipant(result, participantId) {
  return result.events.some((event) => event.phase.startsWith("knowledge-")
    && event.component === participantId);
}

function assertDirectKnowledgeEntry(result, { allowsOrchestrator = false } = {}) {
  const delegation = result.events.find((event) => event.phase === "knowledge-delegation");
  assert.ok(delegation, "direct knowledge must publish one knowledge entry event");
  assert.equal(delegation.component, "runtimeKernel");
  assert.equal(delegation.componentType, "deterministic-service");
  assert.equal(
    result.events.some((event) => event.component === "orchestrator"),
    allowsOrchestrator,
    allowsOrchestrator
      ? "complex direct knowledge must project its Orchestrator planner"
      : "simple direct knowledge must not project an unused Orchestrator",
  );
}

function assertValidEvents(result) {
  assert.equal(result.events.every((event) => validateRunEvent(event).length === 0), true);
}

function assertModelPrecedesAgent(result, {
  modelPhase,
  agentPhase,
  modelComponent,
  agentComponent,
}) {
  const modelEvents = result.events.filter((event) => (
    event.phase === modelPhase && event.component === modelComponent
  ));
  const agentEvent = result.events.find((event) => (
    event.phase === agentPhase && event.component === agentComponent
  ));
  assert.equal(modelEvents.length, 1, `${modelPhase}: model component must emit exactly once`);
  assert.ok(agentEvent, `${agentPhase}: dependent Agent event must exist`);
  assert.ok(modelEvents[0].sequence < agentEvent.sequence, `${modelPhase}: model result must precede Agent result`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
