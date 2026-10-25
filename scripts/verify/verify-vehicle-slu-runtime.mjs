#!/usr/bin/env node
import assert from "node:assert/strict";
import { CabinAssistantController } from "../../src/agents/cabin-assistant-controller.js";
import { OrchestratorController } from "../../src/agents/orchestrator-controller.js";
import { RuntimeKernel } from "../../src/application/runtime-kernel.js";
import { RoutePolicy } from "../../src/application/route-policy.js";
import { createChatUseCase } from "../../src/application/use-cases/chat.js";
import { createComplexTaskUseCase } from "../../src/application/use-cases/complex-task.js";
import { createVehicleKnowledgeUseCase } from "../../src/application/use-cases/vehicle-knowledge.js";
import { createKnowledgeAnswer } from "../../src/application/contracts/vehicle-knowledge.js";
import { RunEventLedger } from "../../src/runtime/run-event-ledger.js";
import { RUN_EVENT_PROTOCOL } from "../../src/runtime/run-event-protocol.js";
import { PendingClarificationStore } from "../../src/runtime/pending-clarification-store.js";
import { SessionMemory } from "../../src/runtime/session-memory.js";
import { createTaskPlanExecution } from "../../src/runtime/task-plan-execution.js";
import { ModelProviderError } from "../../src/server/model-providers/model-provider-contract.js";
import { createModelProviderRegistry } from "../../src/server/model-providers/model-provider-registry.js";
import { resolveModelTaskProfiles } from "../../src/server/model-providers/model-task-profile.js";
import { runVehicleSluSemanticBoundary } from "../../src/server/local-agent-server.mjs";
import {
  countCalls,
  createLeanRuntimeVehicleControlHarness,
} from "../lib/lean-runtime-test-harness.mjs";

const CONTRACT_VERSION = "nio-vehicle-slu-contract@2.0.0";
assert.deepEqual(RUN_EVENT_PROTOCOL, { id: "nio-run-event", version: "2.0.0" });
const now = (() => {
  let value = Date.parse("2026-08-06T08:00:00.000Z");
  return () => value++;
})();

await verifyProviderBoundary();
await verifyGeneralChat();
await verifySemanticFailure();
await verifyVehicleKnowledge();
await verifyCurrentTailgateEligibility();
await verifyVehicleStateQuery();
await verifyWeather();
await verifyCompleteControl();
await verifyMissingControlSlots();
await verifyUnsupportedCapabilities();
await verifyMixedForegroundAndWrite();
await verifyForegroundFailureDoesNotCancelWrite();
await verifyBackgroundEarlyRejectionIsObserved();
await verifyMixedCallerAbort();
await verifyTwoWrites();
await verifySafetyRejection();
await verifyCompletionTruthBoundaries();
await verifyOrchestrationProjection();
await verifyPersistentClarificationRuntime();
await verifyPersistentClarificationOrchestratedRuntime();

console.log("Vehicle-SLU Runtime integration verification passed (20 path groups)");

async function verifyProviderBoundary() {
  const profiles = resolveModelTaskProfiles({
    NIO_LLM_PROVIDER: "ollama",
    NIO_LLM_MODEL: "qwen3:8b",
    NIO_VEHICLE_SLU_PROFILE: "cloud-dashscope",
  });
  assert.equal(profiles.orchestrator_plan.provider, "dashscope");
  assert.equal(profiles.orchestrator_plan.model, "qwen-plus");
  assert.equal(profiles.cabin_response.provider, "dashscope");
  assert.equal(profiles.cabin_response.model, "qwen-plus");
  assert.deepEqual(profiles.cabin_response.fallback, {
    provider: "ollama",
    model: "qwen3:8b",
  });
  assert.equal(profiles.knowledge_answer.provider, "dashscope");
  assert.equal(profiles.knowledge_answer.model, "qwen3.8-flash");
  assert.deepEqual(profiles.knowledge_answer.fallback, {
    provider: "ollama",
    model: "qwen3:8b",
  });
  assert.equal(profiles.rag_rerank.model, "qwen3:8b");

  const fallbackRequestId = "run:vslu:provider-fallback";
  const fallbackEnvelope = envelope(fallbackRequestId, {
    domain: "non_vehicle",
    conversationGoal: { summary: "回应问候", need: "social" },
    frames: [],
  });
  const fallbackHarness = createProviderBoundaryHarness({
    profiles,
    dashscopeGenerate() {
      throw new ModelProviderError("fake primary network failure", {
        code: "provider-network-error",
        provider: "dashscope",
        externalModelRequestCount: 1,
        details: { reasonCode: "provider-network-error", retryable: true },
      });
    },
    ollamaGenerate({ profile }) {
      return providerResult(fallbackEnvelope, profile, 1);
    },
  });
  const fallback = await runVehicleSluSemanticBoundary({
    text: "你好",
    requestId: fallbackRequestId,
    registry: fallbackHarness.registry,
  });
  assert.equal(fallbackHarness.calls.filter(({ provider }) => provider === "dashscope").length, 1);
  assert.equal(fallbackHarness.calls.filter(({ provider }) => provider === "ollama").length, 0);
  assert.equal(fallback.semanticEnvelope, null);
  assert.equal(fallback.executionDisabled, true);
  assert.equal(fallback.model, "qwen3.5-flash");
  assert.equal(fallback.telemetry.provider, "dashscope");
  assert.equal(fallback.telemetry.providerFailureReasonCode, "provider-network-error");
  assert.equal(Object.hasOwn(fallback.telemetry, "fallbackActive"), false);
  assert.equal(fallback.telemetry.externalModelRequestCount, 1);

  const primaryRequestId = "run:vslu:provider-primary";
  const primaryEnvelope = envelope(primaryRequestId, {
    domain: "non_vehicle",
    conversationGoal: { summary: "回应问候", need: "social" },
    frames: [],
  });
  const primaryHarness = createProviderBoundaryHarness({
    profiles,
    dashscopeGenerate({ profile }) {
      return providerResult(primaryEnvelope, profile, 1);
    },
  });
  const primary = await runVehicleSluSemanticBoundary({
    text: "你好",
    requestId: primaryRequestId,
    registry: primaryHarness.registry,
  });
  assert.deepEqual(primary.semanticEnvelope, primaryEnvelope);
  assert.equal(primary.model, "qwen3.5-flash");
  assert.equal(primary.telemetry.provider, "dashscope");
  assert.equal(primary.telemetry.model, "qwen3.5-flash");
  assert.equal(primary.telemetry.fallbackActive, false);
  assert.equal(primary.telemetry.externalModelRequestCount, 1);
  assert.equal(primaryHarness.calls.filter(({ provider }) => provider === "ollama").length, 0);

  const clarificationRequestId = "run:vslu:provider-clarification";
  const clarificationEnvelope = envelope(clarificationRequestId, {
    conversationGoal: { summary: "打开主驾车窗", need: "none" },
    frames: [frame("clarify-window", "control", "body.window.setPosition", "clarify", {
      zone: "front_left",
    }, {
      missingSlots: ["percent"],
      clarificationQuestion: "主驾车窗要打开到多少？",
    })],
  });
  const clarificationHarness = createProviderBoundaryHarness({
    profiles,
    dashscopeGenerate({ profile }) {
      return providerResult(clarificationEnvelope, profile, 1);
    },
  });
  const clarification = await runVehicleSluSemanticBoundary({
    text: "打开主驾车窗",
    requestId: clarificationRequestId,
    registry: clarificationHarness.registry,
  });
  assert.equal(clarification.semanticEnvelope.vehicleFrames[0].actionNeed, "clarify");
  assert.equal(clarification.telemetry.fallbackActive, false);
  assert.equal(clarificationHarness.calls.filter(({ provider }) => provider === "ollama").length, 0,
    "a valid clarification is a business result and must not call fallback");

  const unavailableHarness = createProviderBoundaryHarness({
    profiles,
    dashscopeGenerate() {
      throw new ModelProviderError("fake primary network failure", {
        code: "provider-network-error",
        provider: "dashscope",
        externalModelRequestCount: 1,
        details: { reasonCode: "provider-network-error", retryable: true },
      });
    },
    ollamaGenerate() {
      throw new ModelProviderError("fake fallback unavailable", {
        code: "provider-unavailable",
        provider: "ollama",
        externalModelRequestCount: 1,
        details: { reasonCode: "provider-unavailable", retryable: true },
      });
    },
  });
  const unavailable = await runVehicleSluSemanticBoundary({
    text: "打开主驾车窗",
    requestId: "run:vslu:provider-unavailable",
    registry: unavailableHarness.registry,
  });
  assert.equal(unavailableHarness.calls.filter(({ provider }) => provider === "dashscope").length, 1);
  assert.equal(unavailableHarness.calls.filter(({ provider }) => provider === "ollama").length, 0);
  assert.equal(unavailable.semanticEnvelope, null);
  assert.equal(unavailable.executionDisabled, true);
  assert.equal(unavailable.reasonCode, "semantic-model-unavailable");
  assert.equal(unavailable.model, "qwen3.5-flash",
    "unavailable must identify the failed primary model");
  assert.equal(unavailable.telemetry.provider, "dashscope",
    "unavailable must identify the failed primary provider");
  assert.equal(unavailable.telemetry.model, "qwen3.5-flash");
  assert.equal(unavailable.telemetry.externalModelRequestCount, 1);
  assert.equal(Object.hasOwn(unavailable.telemetry, "fallbackAttempted"), false);
  assert.equal(unavailable.telemetry.providerFailureReasonCode, "provider-network-error");
  assert.equal(Object.hasOwn(unavailable, "clarificationQuestion"), false);
  assert.equal(Object.hasOwn(unavailable, "toolCall"), false);
}

function createProviderBoundaryHarness({ profiles, dashscopeGenerate, ollamaGenerate = null }) {
  const calls = [];
  const createFakeProvider = (provider, generate) => ({ profile }) => Object.freeze({
    id: provider,
    model: profile.model,
    async generate(request) {
      calls.push({ provider, model: profile.model, request });
      if (typeof generate !== "function") {
        throw new Error(`unexpected ${provider} provider call`);
      }
      return generate({ profile, request });
    },
  });
  const registry = createModelProviderRegistry({
    taskProfiles: profiles,
    connections: {
      dashscope: { readiness: { status: "ready" } },
      ollama: { readiness: { status: "ready" } },
    },
    providerFactories: {
      dashscope: createFakeProvider("dashscope", dashscopeGenerate),
      ollama: createFakeProvider("ollama", ollamaGenerate),
    },
  });
  return { calls, registry };
}

function providerResult(semanticEnvelope, profile, externalModelRequestCount) {
  return Object.freeze({
    text: JSON.stringify(semanticEnvelope),
    provider: profile.provider,
    model: profile.model,
    durationMs: 1,
    finishReason: "stop",
    usage: Object.freeze({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedInputTokens: 0,
      unavailableReason: null,
    }),
    externalModelRequestCount,
  });
}

async function verifyGeneralChat() {
  const calls = [];
  const runId = "run:vslu:chat";
  const semanticEnvelope = envelope(runId, {
    domain: "non_vehicle",
    conversationGoal: { summary: "聊聊今天的心情", need: "social" },
    frames: [],
  });
  const runtime = kernel({
    semanticEnvelope,
    calls,
    useCases: {
      chat: createChatUseCase({
        cloudAdapter: {
          async converse(rawText, parsedCommand) {
            calls.push({ name: "cabin.converse", rawText, parsedCommand });
            return { summary: "当然可以。", telemetry: { model: "chat-test", provider: "injected" } };
          },
        },
      }),
    },
  });
  const result = await runtime.run("与结构化摘要不同的原始聊天文本", { requestId: runId });
  assert.equal(result.assistantResponse, "当然可以。");
  assert.deepEqual(result.semanticEnvelope, semanticEnvelope, "Runtime exposes the owned semantic envelope");
  assert.equal(result.executionDisabled, false);
  assert.equal(result.semanticAuthority.admittedWriteFrameId, null);
  assert.equal(countNamed(calls, "semantic.parse"), 1);
  assert.equal(countNamed(calls, "cabin.converse"), 1);
  assertNoCalls(calls, ["orchestrator", "manual", "safety", "tool", "adapter", "provider"]);
  const routeEvent = result.events.find((event) => event.phase === "route-decision");
  assert.equal(routeEvent.metadata.routing.semanticSummary.requestId, runId);
  assert.deepEqual(
    routeEvent.metadata.routing.semanticSummary.conversationGoal,
    { summary: "聊聊今天的心情", need: "social" },
  );
  assert.equal(JSON.stringify(routeEvent.metadata.routing).includes('"slots"'), false,
    "route event keeps only slot names in the bounded Vehicle-SLU summary");
}

async function verifySemanticFailure() {
  const calls = [];
  const runId = "run:vslu:semantic-failure";
  const runtime = kernel({
    semanticEnvelope: null,
    executionDisabled: true,
    reasonCode: "semantic-model-unavailable",
    calls,
    useCases: rejectingUseCases(calls),
  });
  const result = await runtime.run("即使文本像车控也不能执行：打开所有车窗", { requestId: runId });
  assert.equal(result.routeDecision.disposition, "respond");
  assert.equal(result.routeDecision.routeId, null);
  assert.equal(result.executionDisabled, true);
  assert.match(result.assistantResponse, /不会执行车辆或座舱操作/);
  assert.equal(result.events.filter((event) => (
    event.phase === "route-decision" && event.component === "vehicleSluModel"
  )).length, 1);
  assertNoCalls(calls, ["use-case", "orchestrator", "manual", "safety", "tool", "adapter", "provider", "service"]);
}

async function verifyVehicleKnowledge() {
  const calls = [];
  const runId = "run:vslu:knowledge";
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "解释车窗防夹", need: "none" },
    frames: [frame("knowledge-1", "knowledge", "vehicle.knowledge.query", "none", {
      query: "ES8 车窗防夹如何工作？",
      vehicleModel: "ES8",
    })],
  });
  const manualEvidenceChunk = Object.freeze({
    chunkId: "manual:anti-pinch",
    sourceId: "nio-es8-user-manual-2026",
    sourceVersion: "2026",
    title: "车窗防夹",
    citation: "车窗防夹",
    sectionTitle: "车窗防夹",
    pageStart: 120,
    pageEnd: 120,
    text: "车窗上升遇到障碍物时将停止或下降。",
    score: Object.freeze({ retrieval: 0.91, rerank: null, grounding: null }),
  });
  const useCase = createVehicleKnowledgeUseCase({
    orchestratorController: {
      async planKnowledgeTask() { calls.push({ name: "knowledge.plan" }); throw new Error("simple knowledge must not subplan"); },
    },
    cabinAssistantController: {
      async composeKnowledgeResponse(input) {
        calls.push({ name: "knowledge.synthesize", input });
        return {
          result: fixtureKnowledgeAnswer(input, "车窗防夹会在检测到阻力时停止或反向运动。"),
          telemetry: { model: "knowledge-test", provider: "injected" },
        };
      },
      presentKnowledgeBoundary: presentFixtureKnowledgeBoundary,
    },
    async manualRetriever(query, options) {
      calls.push({ name: "manual.retrieve", query, options });
      return [manualEvidenceChunk];
    },
    refreshVehicleState() { calls.push({ name: "provider.refresh" }); },
    readVehicleStateSnapshot() { calls.push({ name: "provider.read" }); },
    safetyGateway: { evaluate() { calls.push({ name: "safety.evaluate" }); } },
    now,
  });
  const result = await kernel({
    semanticEnvelope,
    calls,
    useCases: { "vehicle-knowledge": useCase },
    parsedCommandOverride: {
      requestId: runId,
      rawText: "伪造：查询 ET5 尾门",
      intent: "body.tailgate.open",
      speechAct: "command",
      actionability: { actionable: true, intendedIntent: "body.tailgate.open" },
      slots: { query: "ET5 尾门", vehicleModel: "ET5", open: true },
      conversationGoal: { domain: "vehicle_control", interactionType: "command" },
    },
  })
    .run("这段 rawText 故意不含车型和组件关键词", { requestId: runId });
  assert.equal(countNamed(calls, "manual.retrieve"), 1);
  assert.equal(calls.find((entry) => entry.name === "manual.retrieve").query, "ES8 车窗防夹如何工作？");
  assert.equal(countNamed(calls, "knowledge.synthesize"), 1);
  assertNoCalls(calls, ["safety.evaluate", "provider.refresh", "provider.read", "vehicle.execute", "tool"]);
  assert.equal(result.manualEvidence.status, "hit");
  assert.deepEqual(result.manualQueryPlan, {
    query: "ES8 车窗防夹如何工作？",
    vehicleModel: "ES8",
    accessMode: "read",
    source: "vehicle-slu-frame",
  }, "Vehicle-SLU knowledge must not inherit legacy parsed-command/raw-text query-plan fields");

  calls.length = 0;
  const exactCandidateResult = await kernel({
    semanticEnvelope,
    calls,
    useCases: { "vehicle-knowledge": useCase },
    prepareManualRetrievalCandidate(input) {
      calls.push({ name: "candidate.prepare", input });
      return Object.freeze({
        async consume(binding) {
          calls.push({ name: "candidate.consume", binding });
          return Object.freeze({ result: Object.freeze([manualEvidenceChunk]), durationMs: 3210 });
        },
        discard() { return false; },
      });
    },
  }).run("ES8 车窗防夹如何工作？", { requestId: runId });
  assert.equal(countNamed(calls, "candidate.prepare"), 1);
  assert.equal(countNamed(calls, "candidate.consume"), 1);
  assert.equal(countNamed(calls, "manual.retrieve"), 0);
  assert.deepEqual(calls.find((entry) => entry.name === "candidate.consume").binding, {
    runId,
    query: "ES8 车窗防夹如何工作？",
    vehicleModel: "ES8",
  });
  assert.equal(exactCandidateResult.manualEvidence.status, "hit");
  assert.equal(
    exactCandidateResult.events.find((event) => event.phase === "knowledge-evidence").durationMs,
    3210,
  );
}

async function verifyCurrentTailgateEligibility() {
  const calls = [];
  const runId = "run:vslu:current-tailgate";
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "ES8 尾门当前开启资格", need: "none" },
    frames: [frame("knowledge-tailgate-eligibility", "knowledge", "vehicle.knowledge.query", "none", {
      query: "ES8 尾门现在是否可以打开？",
      vehicleModel: "ES8",
      eligibilityAction: "body.tailgate.open",
    })],
  });
  const snapshot = Object.freeze({
    id: "snapshot:tailgate:current",
    source: "vehicle-state-provider",
    simulated: true,
    capturedAt: "2026-08-06T08:00:00.000Z",
    values: Object.freeze({ speedKph: 0, gear: "P", rearClearance: true }),
  });
  const useCase = createVehicleKnowledgeUseCase({
    orchestratorController: {
      async planKnowledgeTask() { calls.push({ name: "knowledge.plan" }); throw new Error("direct eligibility must not subplan"); },
    },
    cabinAssistantController: {
      async composeKnowledgeResponse(input) {
        calls.push({ name: "knowledge.synthesize", input });
        return {
          result: fixtureKnowledgeAnswer(input, "当前满足尾门开启条件。"),
          telemetry: { model: "knowledge-test", provider: "injected" },
        };
      },
      presentKnowledgeBoundary: presentFixtureKnowledgeBoundary,
    },
    async manualRetriever(query) {
      calls.push({ name: "manual.retrieve", query });
      return [{
        chunkId: "manual:tailgate", sourceId: "nio-es8-user-manual-2026", title: "尾门",
        sourceVersion: "2026", pageStart: 62, pageEnd: 62,
        citation: "尾门", text: "开启尾门前应确认开闭路径附近没有障碍物。",
        score: { retrieval: 0.93, rerank: null, grounding: null },
      }];
    },
    async refreshVehicleState() { calls.push({ name: "provider.refresh" }); return { ok: true, snapshot }; },
    readVehicleStateSnapshot() { calls.push({ name: "provider.read" }); return snapshot; },
    safetyGateway: {
      async evaluate(command, input) {
        calls.push({ name: "safety.evaluate", command, input });
        return {
          allowed: true,
          action: "allow",
          reason: "尾门路径安全。",
          vehicleStateSnapshotId: snapshot.id,
          vehicleStateAudit: { snapshotId: snapshot.id },
        };
      },
    },
    now,
  });
  const result = await kernel({ semanticEnvelope, calls, useCases: { "vehicle-knowledge": useCase } })
    .run("这段 rawText 不能决定当前尾门资格", { requestId: runId });
  assert.deepEqual(calls.map(({ name }) => name), [
    "semantic.parse", "manual.retrieve", "provider.refresh", "provider.read", "safety.evaluate", "knowledge.synthesize",
  ]);
  assert.equal(result.safetyDecision.allowed, true);
  assert.equal(result.toolCall, null);
  assert.equal(result.toolResult, null);
  assertNoCalls(calls, ["vehicle.execute", "vehicle.adapter", "provider.write", "provider.ingest", "sensor"]);
}

async function verifyVehicleStateQuery() {
  const calls = [];
  const runId = "run:vslu:state";
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "当前车速和挡位", need: "none" },
    frames: [frame("state-1", "knowledge", "vehicle.state.query", "none", {
      stateFields: ["speedKph", "gear"],
    })],
  });
  const providerSnapshot = Object.freeze({
    id: "snapshot:state:1",
    source: "vehicle-state-provider",
    simulated: false,
    capturedAt: "2026-08-06T08:00:00.000Z",
    unrestrictedProviderPayload: "must-not-reach-cabin-formatter",
    values: Object.freeze({ speedKph: 42, gear: "D", cabinTemperature: 21 }),
  });
  const formatterInputs = [];
  const useCase = createVehicleKnowledgeUseCase({
    orchestratorController: {
      planKnowledgeTask() { calls.push({ name: "knowledge.plan" }); throw new Error("state query must bypass knowledge model"); },
    },
    cabinAssistantController: {
      composeKnowledgeResponse() { calls.push({ name: "knowledge.synthesize" }); throw new Error("state query must bypass knowledge model"); },
      presentKnowledgeBoundary(input) {
        formatterInputs.push({
          stateFields: input.stateFields,
          vehicleStateSnapshot: input.vehicleStateSnapshot,
        });
        return {
          text: `Cabin renderer：${input.stateFields.map((field) => `${field}=${input.vehicleStateSnapshot.values[field]}`).join("，")}`,
          outcomeStatus: "answered",
          reasonCode: "vehicle-state-provider-read",
          eventStatus: "completed",
          degraded: false,
          result: null,
        };
      },
    },
    manualRetriever() { calls.push({ name: "manual.retrieve" }); throw new Error("state query must bypass Manual RAG"); },
    readVehicleStateSnapshot() { calls.push({ name: "provider.read" }); return providerSnapshot; },
    safetyGateway: { evaluate() { calls.push({ name: "safety.evaluate" }); } },
    now,
  });
  const result = await kernel({ semanticEnvelope, calls, useCases: { "vehicle-knowledge": useCase } })
    .run("模型若看到这段文字可能会编造车速 999", { requestId: runId });
  assert.equal(countNamed(calls, "provider.read"), 1);
  assertNoCalls(calls, ["manual.retrieve", "knowledge.plan", "knowledge.synthesize", "safety.evaluate", "tool"]);
  assert.equal(result.vehicleStateSnapshot.id, providerSnapshot.id);
  assert.deepEqual(result.vehicleStateSnapshot.values, { speedKph: 42, gear: "D" });
  assert.equal(result.assistantResponse, "Cabin renderer：speedKph=42，gear=D");
  assert.doesNotMatch(result.assistantResponse, /999/);
  assert.equal(formatterInputs.length, 1);
  assert.deepEqual(Object.keys(formatterInputs[0]).sort(), ["stateFields", "vehicleStateSnapshot"]);
  assert.deepEqual(formatterInputs[0].stateFields, ["speedKph", "gear"]);
  assert.deepEqual(Object.keys(formatterInputs[0].vehicleStateSnapshot).sort(), [
    "capturedAt", "id", "simulated", "source", "values",
  ]);
  assert.equal(JSON.stringify(formatterInputs[0]).includes("cabinTemperature"), false);
  assert.equal(JSON.stringify(formatterInputs[0]).includes("unrestrictedProviderPayload"), false);
  assert.equal(result.events.filter((event) => event.component === "orchestrator").length, 0,
    "direct state reads must not involve Orchestrator");
  assert.equal(result.events.filter((event) => event.phase === "knowledge-delegation").length, 0,
    "direct state reads must not invent a knowledge-delegation entry event");
  const providerEvents = result.events.filter((event) => (
    event.component === "vehicleStateProvider"
      && event.phase === "capability-execution"
  ));
  assert.equal(providerEvents.length, 1, "direct state reads emit one Provider observation");
  assert.equal(providerEvents[0].metadata.vehicle.snapshot.id, providerSnapshot.id);
  assert.deepEqual(providerEvents[0].metadata.vehicle.stateFields, ["speedKph", "gear"]);
  assert.equal(providerEvents[0].refs.includes("state-1"), true);
}

function presentFixtureKnowledgeBoundary(input) {
  const result = input.result;
  assert.equal(result.runId, input.runId);
  assert.equal(result.delegationId, input.delegationId);
  return {
    text: result.outcomeStatus === "answered"
      ? result.answer
      : result.outcomeStatus === "clarification"
        ? result.questions[0]
        : result.limitations[0],
    outcomeStatus: result.outcomeStatus,
    reasonCode: result.reasonCode || "",
    eventStatus: result.outcomeStatus === "answered"
      ? "completed"
      : result.outcomeStatus === "clarification" ? "awaiting_clarification" : "unavailable",
    degraded: result.degraded === true,
    result,
  };
}

function fixtureKnowledgeAnswer(input, answer) {
  return createKnowledgeAnswer({
    delegationId: input.delegation.delegationId,
    runId: input.delegation.runId,
    outcomeStatus: "answered",
    supportStatus: "supported",
    answer,
    evidenceRefs: input.executionFacts.evidenceRefs,
    vehicleStateRefs: input.executionFacts.vehicleStateRefs,
    safetyAssessmentRef: input.executionFacts.safetyAssessmentRef,
    limitations: [],
    model: "knowledge-test",
    provider: "injected",
    durationMs: 0,
    degraded: false,
  });
}

async function verifyWeather() {
  const calls = [];
  const runId = "run:vslu:weather";
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "查询杭州今天天气", need: "none" },
    frames: [frame("weather-1", "weather", "weather.query", "none", {
      location: "杭州",
      timeRange: "today",
    })],
  });
  const useCase = createComplexTaskUseCase({
    externalDataAdapter: {
      async execute(toolCall) {
        calls.push({ name: "weather.adapter", toolCall });
        return {
          requestId: toolCall.requestId,
          commandId: toolCall.commandId,
          tool: toolCall.tool,
          ok: false,
          executionState: "failed",
          executionError: { code: "weather-test-unavailable", message: "offline", stage: "adapter", retryable: false },
          hmiSummary: "offline",
          source: "weather-api-adapter",
          simulated: false,
          timestamp: "2026-08-06T08:00:00.000Z",
        };
      },
    },
  });
  const result = await kernel({ semanticEnvelope, calls, useCases: { task: useCase } })
    .run("raw text 不含天气关键词", { requestId: runId });
  assert.equal(countNamed(calls, "weather.adapter"), 1);
  assert.equal(calls.find((entry) => entry.name === "weather.adapter").toolCall.args.location, "杭州",
    "the weather ToolCall carries the Vehicle-SLU weather.location slot, not a raw-text extraction");
  assertNoCalls(calls, ["safety", "vehicle.execute", "vehicle.adapter"]);
  assert.match(result.assistantResponse, /天气实时信息暂时不可用/);
}

async function verifyCompleteControl() {
  const calls = [];
  const harness = createLeanRuntimeVehicleControlHarness();
  const runId = "run:vslu:control";
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "副驾车窗调到一半", need: "none" },
    frames: [frame("window-1", "control", "body.window.setPosition", "execute", {
      zone: "front_right",
      percent: 50,
    })],
  });
  const result = await kernel({ semanticEnvelope, calls, useCases: { "vehicle-control": harness.useCase } })
    .run("raw text 故意要求打开尾门", { requestId: runId });
  assert.equal(countCalls(harness.calls, "safety.evaluate"), 1);
  assert.equal(countCalls(harness.calls, "vehicle.execute"), 1);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 1);
  assert.equal(countCalls(harness.calls, "provider.ingestObservation"), 1);
  assert.equal(result.toolResult.commandId, result.toolCall.commandId);
  assert.equal(result.vehicleStateSnapshot.id, result.toolResult.confirmedSnapshotId);
  assert.match(result.assistantResponse, /确认.*完成|操作已完成/);
}

async function verifyMissingControlSlots() {
  const calls = [];
  const runId = "run:vslu:missing-slot";
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "调节副驾车窗", need: "none" },
    frames: [frame("window-missing", "control", "body.window.setPosition", "execute", {
      zone: "front_right",
    })],
  });
  const result = await kernel({ semanticEnvelope, calls, useCases: rejectingUseCases(calls) })
    .run("raw text 写了百分之百也不得补槽", { requestId: runId });
  assert.equal(result.routeDecision.disposition, "clarify");
  assert.equal(result.assistantResponse, "请告诉我多少开度。");
  assertNoCalls(calls, ["use-case", "safety", "tool", "adapter"]);
}

async function verifyUnsupportedCapabilities() {
  const definitions = [
    ["navigation", "navigation.planRoute", { origin: "杭州", destination: "上海" }, /导航目前还不能完成/],
    ["media", "media.play", { query: "古典音乐" }, /媒体播放目前还不能完成/],
    ["phone", "phone.call", { contact: "张三" }, /电话目前还不能完成/],
  ];
  for (const [capability, intent, slots, pattern] of definitions) {
    const calls = [];
    const runId = `run:vslu:unsupported:${capability}`;
    const semanticEnvelope = envelope(runId, {
      conversationGoal: { summary: `unsupported ${capability}`, need: "none" },
      frames: [frame(`${capability}-1`, capability, intent, "execute", slots)],
    });
    const result = await kernel({ semanticEnvelope, calls, useCases: rejectingUseCases(calls) })
      .run("raw text 像车窗控制也不应改变路由", { requestId: runId });
    assert.equal(result.routeDecision.disposition, "respond");
    assert.match(result.assistantResponse, pattern);
    assertNoCalls(calls, ["use-case", "tool", "adapter"]);
  }
}

async function verifyMixedForegroundAndWrite() {
  const harness = createLeanRuntimeVehicleControlHarness();
  const calls = [];
  const runId = "run:vslu:mixed";
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "聊聊旅行，同时把副驾车窗调到一半", need: "social" },
    frames: [frame("mixed-window", "control", "body.window.setPosition", "execute", {
      zone: "front_right",
      percent: 50,
    })],
  });
  const useCase = orchestratedUseCase({ calls, vehicleControl: harness.useCase });
  const result = await kernel({ semanticEnvelope, calls, useCases: { task: useCase } })
    .run("raw text 不提供任何车控权限", { requestId: runId });
  assert.equal(countNamed(calls, "cabin.formGoal"), 0);
  assert.equal(countNamed(calls, "cabin.respondForeground"), 1);
  const foregroundInput = calls.find((entry) => entry.name === "cabin.respondForeground").input;
  assert.equal(Object.hasOwn(foregroundInput, "rawText"), false);
  assert.deepEqual(foregroundInput.pendingFrameIds, ["mixed-window"]);
  assert.equal(countNamed(calls, "orchestrator.plan"), 1);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 1);
  assert.match(result.assistantResponse, /开放话题/);
  assert.match(result.assistantResponse, /确认.*完成|操作已完成/);
  const foregroundModelEvents = result.events.filter((event) => (
    event.phase === "chat-response" && event.component === "cabinModel"
  ));
  const foregroundModelIndex = result.events.findIndex((event) => event === foregroundModelEvents[0]);
  const foregroundEventIndex = result.events.findIndex((event) => (
    event.phase === "chat-response"
      && event.component === "cabinAssistant"
      && event.summary.includes("开放话题")
  ));
  const adapterEventIndex = result.events.findIndex((event) => (
    event.phase === "vehicle-execution" && event.status === "completed"
  ));
  assert.equal(foregroundModelEvents.length, 1, "foreground Cabin model must emit exactly once");
  assert.ok(foregroundModelIndex >= 0 && foregroundModelIndex < foregroundEventIndex,
    "foreground model result is visible before the dependent Cabin Agent response");
  assert.ok(foregroundEventIndex >= 0 && foregroundEventIndex < adapterEventIndex,
    "bounded foreground response is emitted before background completion");
}

async function verifyTwoWrites() {
  const harness = createLeanRuntimeVehicleControlHarness();
  const calls = [];
  const runId = "run:vslu:two-writes";
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "调车窗并开尾门", need: "none" },
    frames: [
      frame("write-window", "control", "body.window.setPosition", "execute", { zone: "front_right", percent: 50 }),
      frame("write-tailgate-deferred", "control", "body.tailgate.open", "execute", { open: true }),
    ],
  });
  const useCase = orchestratedUseCase({ calls, vehicleControl: harness.useCase });
  const result = await kernel({ semanticEnvelope, calls, useCases: { task: useCase } })
    .run("raw text 不能决定哪个写入先执行", { requestId: runId });
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 1);
  assert.deepEqual(result.semanticAuthority.deferredFrameIds, ["write-tailgate-deferred"]);
  assert.match(result.assistantResponse, /write-tailgate-deferred/);
  assert.match(result.assistantResponse, /未执行/);
  assert.doesNotMatch(result.assistantResponse, /^所有.*成功|^全部.*完成/);
}

async function verifyForegroundFailureDoesNotCancelWrite() {
  const harness = createLeanRuntimeVehicleControlHarness();
  const calls = [];
  const runId = "run:vslu:foreground-failure";
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "先聊一句，再调节车窗", need: "social" },
    frames: [frame("foreground-window", "control", "body.window.setPosition", "execute", {
      zone: "front_right",
      percent: 50,
    })],
  });
  const useCase = orchestratedUseCase({ calls, vehicleControl: harness.useCase, failForeground: true });
  const result = await kernel({ semanticEnvelope, calls, useCases: { task: useCase } })
    .run("raw text 不具有车控权限", { requestId: runId });
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 1);
  assert.match(result.assistantResponse, /我先处理你的车内请求/);
  assert.match(result.assistantResponse, /Provider 确认完成/);
}

async function verifyBackgroundEarlyRejectionIsObserved() {
  const calls = [];
  const runId = "run:vslu:background-early-rejection";
  const expectedError = new Error("planner rejected before foreground settled");
  let releaseForeground;
  const foregroundBarrier = new Promise((resolve) => { releaseForeground = resolve; });
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "先聊旅行，再调整车窗", need: "social" },
    frames: [frame("early-reject-window", "control", "body.window.setPosition", "execute", {
      zone: "front_right",
      percent: 50,
    })],
  });
  const useCase = createComplexTaskUseCase({
    externalDataAdapter: { execute() { throw new Error("direct external adapter must stay inactive"); } },
    cabin: {
      async formGoal() { throw new Error("Vehicle-SLU must bypass formGoal"); },
      async respondForeground() {
        calls.push({ name: "cabin.respondForeground" });
        await foregroundBarrier;
        return { text: "旅行话题稍后继续。", telemetry: { provider: "injected" } };
      },
      async synthesize() { throw new Error("synthesis must stay inactive"); },
    },
    orchestrator: {
      async plan() {
        calls.push({ name: "orchestrator.plan" });
        throw expectedError;
      },
    },
    createExecutionLedger: createTaskPlanExecution,
    now,
  });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    const pending = kernel({ semanticEnvelope, calls, useCases: { task: useCase } })
      .run("raw text 不提供执行权限", { requestId: runId })
      .then(() => null, (error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    releaseForeground();
    const error = await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(error, expectedError, "background failure keeps its original error semantics");
    assert.deepEqual(unhandled, [], "background rejection must be observed while foreground is pending");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    releaseForeground();
  }
}

async function verifyMixedCallerAbort() {
  const calls = [];
  const runId = "run:vslu:mixed-caller-abort";
  const controller = new AbortController();
  const ledger = new RunEventLedger();
  let foregroundStartedResolve;
  let backgroundStartedResolve;
  const foregroundStarted = new Promise((resolve) => { foregroundStartedResolve = resolve; });
  const backgroundStarted = new Promise((resolve) => { backgroundStartedResolve = resolve; });
  const waitForAbort = (signal, name) => new Promise((resolve, reject) => {
    const rejectAborted = () => {
      calls.push({ name: `${name}.aborted`, signal });
      reject(new Error(`${name} observed caller abort`));
    };
    if (signal.aborted) rejectAborted();
    else signal.addEventListener("abort", rejectAborted, { once: true });
  });
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "聊聊旅行，同时调整副驾车窗", need: "social" },
    frames: [frame("abort-window", "control", "body.window.setPosition", "execute", {
      zone: "front_right",
      percent: 50,
    })],
  });
  const useCase = createComplexTaskUseCase({
    externalDataAdapter: { execute() { throw new Error("direct external adapter must stay inactive"); } },
    cabin: {
      async formGoal() { throw new Error("Vehicle-SLU must bypass formGoal"); },
      async respondForeground(input) {
        calls.push({ name: "cabin.respondForeground", signal: input.signal });
        foregroundStartedResolve();
        return waitForAbort(input.signal, "foreground");
      },
      async synthesize() {
        calls.push({ name: "cabin.synthesize" });
        throw new Error("post-abort synthesis must stay inactive");
      },
    },
    orchestrator: {
      async plan(input) {
        calls.push({ name: "orchestrator.plan", signal: input.signal });
        backgroundStartedResolve();
        return waitForAbort(input.signal, "background");
      },
    },
    createExecutionLedger: createTaskPlanExecution,
    vehicleControl: {
      async execute() {
        calls.push({ name: "vehicle.execute" });
        throw new Error("post-abort write must stay inactive");
      },
    },
    now,
  });
  const runtime = kernel({
    semanticEnvelope,
    calls,
    useCases: { task: useCase },
    runEventLedger: ledger,
  });
  const pending = runtime.run("raw text 不提供执行权限", {
    requestId: runId,
    signal: controller.signal,
  }).then(() => null, (error) => error);
  await Promise.all([foregroundStarted, backgroundStarted]);
  controller.abort("mixed-caller-abort");
  const error = await pending;
  assert.equal(error?.name, "AbortError");
  assert.equal(calls.find((entry) => entry.name === "cabin.respondForeground").signal, controller.signal);
  assert.equal(calls.find((entry) => entry.name === "orchestrator.plan").signal, controller.signal);
  assert.equal(countNamed(calls, "foreground.aborted"), 1);
  assert.equal(countNamed(calls, "background.aborted"), 1);
  assertNoCalls(calls, ["vehicle.execute", "cabin.synthesize"]);
  assert.equal(ledger.getCurrentRun(), null, "caller abort must close the active Run ledger");
  assert.equal(ledger.getPreviousRun().status, "cancelled");
  assert.equal(ledger.getPreviousRun().events.some((event) => event.phase === "chat-response"), false,
    "no foreground response may be emitted after caller abort");
  assert.equal(ledger.getPreviousRun().events.filter((event) => (
    event.phase === "final-response" && event.status === "cancelled"
  )).length, 1, "Run ledger retains exactly one terminal cancellation response");
}

async function verifySafetyRejection() {
  const calls = [];
  const harness = createLeanRuntimeVehicleControlHarness({
    evaluateSafety(command, input, gateway) {
      const decision = gateway.evaluate(command, input);
      return {
        ...decision,
        allowed: false,
        action: "reject",
        safeIntent: "safety.reject",
        safeSlots: {},
        reason: "测试安全拒绝",
      };
    },
  });
  const runId = "run:vslu:safety-reject";
  const semanticEnvelope = envelope(runId, {
    conversationGoal: { summary: "调节副驾车窗", need: "none" },
    frames: [frame("reject-window", "control", "body.window.setPosition", "execute", {
      zone: "front_right",
      percent: 50,
    })],
  });
  const result = await kernel({ semanticEnvelope, calls, useCases: { "vehicle-control": harness.useCase } })
    .run("raw text 包含完整参数", { requestId: runId });
  assert.equal(result.routeDecision.reasonCode, "complete-vehicle-control");
  assert.equal(result.safetyDecision.action, "reject");
  assert.equal(countCalls(harness.calls, "vehicle.execute"), 0);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 0);
  assert.match(result.assistantResponse, /测试安全拒绝/);
}

async function verifyCompletionTruthBoundaries() {
  const runId = "run:vslu:unconfirmed";
  const goalEnvelope = goal(runId);
  const taskPlan = plan(runId, goalEnvelope.goalId);
  const cabin = new CabinAssistantController({
    modelAdapter: {
      formGoal() { throw new Error("not used"); },
      async synthesizeAgentResponse() {
        return {
          output: { response: "操作已成功完成。", writeCompletionStatus: "confirmed" },
          telemetry: { model: "liar", provider: "injected" },
        };
      },
    },
    now,
  });
  const unconfirmed = await cabin.synthesize({
    goalEnvelope,
    taskPlan,
    executionFacts: {
      runId,
      goalId: goalEnvelope.goalId,
      planId: taskPlan.planId,
      stepResults: [],
      evidenceRefs: [],
      safetyDecision: { allowed: true, action: "allow" },
      toolResult: {
        requestId: runId,
        commandId: `${runId}:1:body.window.setPosition`,
        tool: "body.window.setPosition",
        ok: true,
        executionState: "accepted",
      },
      confirmedVehicleState: null,
      degraded: true,
      failureReason: "",
      completionStatus: "incomplete",
    },
  });
  assert.equal(unconfirmed.text, "写入操作尚未确认完成。");
}

async function verifyOrchestrationProjection() {
  const { createVehicleSluGoalEnvelope, createVehicleSluPlanAuthority } = await import(
    "../../src/semantic/vehicle-slu-orchestration.js"
  );
  const semanticEnvelope = envelope("run:vslu:projection", {
    conversationGoal: { summary: "把副驾车窗调到一半，再开尾门", need: "none" },
    frames: [
      frame("projection-window", "control", "body.window.setPosition", "execute", { zone: "front_right", percent: 50 }),
      frame("projection-tailgate", "control", "body.tailgate.open", "execute", { open: true }),
    ],
  });
  const authority = createVehicleSluPlanAuthority(semanticEnvelope);
  assert.deepEqual(authority.allowedFrameIds, ["projection-window", "projection-tailgate"]);
  assert.deepEqual(authority.deferredFrameIds, ["projection-tailgate"]);
  assert.equal(authority.admittedWriteFrameId, "projection-window");
  assert.ok(authority.allowedCapabilityIds.includes("vehicle.window.set-position"));
  assert.ok(authority.allowedCapabilityIds.includes("safety.evaluate"));
  assert.equal(authority.allowedCapabilityIds.includes("vehicle.tailgate.set"), false,
    "deferred write capability must not appear in executable authority");
  assert.equal(authority.allowedCapabilityIds.includes("confirmation.issue"), false,
    "deferred tailgate confirmation must not appear in executable authority");
  const projectedGoal = createVehicleSluGoalEnvelope(semanticEnvelope);
  assert.equal(projectedGoal.runId, semanticEnvelope.requestId);
  assert.equal(projectedGoal.interactionType, "command");
  assert.equal(projectedGoal.domain, "vehicle-control");
  assert.equal(projectedGoal.contextRefs[0].frameId, "projection-window");
  assert.equal(projectedGoal.contextRefs[0].slots.percent, 50);

  const eligibilityGoal = createVehicleSluGoalEnvelope(envelope("run:vslu:eligibility-projection", {
    conversationGoal: { summary: "ES8 尾门当前开启资格", need: "none" },
    frames: [frame("projection-tailgate-eligibility", "knowledge", "vehicle.knowledge.query", "none", {
      query: "ES8 尾门现在是否可以打开？",
      vehicleModel: "ES8",
      eligibilityAction: "body.tailgate.open",
    })],
  }));
  assert.deepEqual(eligibilityGoal.contextRefs, [{
    type: "trusted-conversation-goal",
    source: "vehicle-slu-knowledge-frame",
    interactionType: "question",
    semanticDomain: "vehicle_knowledge",
    goalDomain: "manual",
    eligibilityAction: "body.tailgate.open",
  }], "Vehicle-SLU goal authority preserves the read-only eligibility selector");

  let planningInput;
  const orchestrator = new OrchestratorController({
    modelAdapter: {
      async createTaskPlan(input) {
        planningInput = input;
        return { output: plan(input.runId, input.goalEnvelope.goalId), telemetry: { provider: "injected" } };
      },
    },
  });
  const planned = await orchestrator.plan({
    runId: semanticEnvelope.requestId,
    goalEnvelope: projectedGoal,
    semanticEnvelope,
    semanticAuthority: authority,
  });
  assert.equal(planned.validation.ok, true);
  assert.equal(planningInput.semanticAuthority, authority);
  assert.deepEqual(planningInput.catalogProjection.map(({ id }) => id), [
    "safety.evaluate",
    "vehicle.window.set-position",
    "response.synthesize",
  ], "deferred tailgate capabilities must not enter the executable catalog");
}

async function verifyPersistentClarificationRuntime() {
  const clarificationSessionId = "browser:vslu:persistent-clarification";
  const store = new PendingClarificationStore();
  const controlHarness = createLeanRuntimeVehicleControlHarness();
  const semanticCalls = [];
  const chatCalls = [];
  const semanticByText = new Map([
    ["打开主驾车窗", envelope("run:vslu:pending-open", {
      conversationGoal: { summary: "打开主驾车窗", need: "none" },
      frames: [frame("pending-window", "control", "body.window.setPosition", "clarify", {
        zone: "front_left",
      }, {
        missingSlots: ["percent"],
        clarificationQuestion: "主驾车窗要打开到多少？",
      })],
    })],
    ["我今天心情不错", envelope("run:vslu:pending-chat", {
      domain: "non_vehicle",
      conversationGoal: { summary: "回应用户心情", need: "social" },
      frames: [],
    })],
    ["继续", envelope("run:vslu:pending-empty-vehicle", {
      conversationGoal: { summary: "", need: "none" },
      frames: [],
    })],
    ["50%", envelope("run:vslu:pending-resolve", {
      conversationGoal: { summary: "补充车窗开度", need: "none" },
      frames: [frame("pending-window-delta", "control", "body.window.setPosition", "execute", {
        percent: 50,
      })],
    })],
    ["调一下主驾座椅", envelope("run:vslu:pending-replace", {
      conversationGoal: { summary: "调节主驾座椅", need: "none" },
      frames: [frame("pending-seat", "control", "seat.driver.setBackrestAngle", "clarify", {
        seat: "driver",
      }, {
        missingSlots: ["angle"],
        clarificationQuestion: "主驾座椅靠背要调到多少度？",
      })],
    })],
    ["112度", envelope("run:vslu:pending-seat-resolve", {
      conversationGoal: { summary: "补充主驾座椅靠背角度", need: "none" },
      frames: [frame("pending-seat-delta", "control", "seat.driver.setBackrestAngle", "execute", {
        angle: 112,
      })],
    })],
    ["副驾50%", envelope("run:vslu:pending-reject", {
      conversationGoal: { summary: "补充车窗位置和开度", need: "none" },
      frames: [frame("pending-window-undeclared", "control", "body.window.setPosition", "execute", {
        zone: "front_right",
        percent: 50,
      })],
    })],
  ]);
  const localModel = {
    async parse(rawText, options) {
      semanticCalls.push({ rawText, options });
      const fixture = semanticByText.get(rawText === "模型返回未声明槽" ? "副驾50%" : rawText);
      if (!fixture) throw new Error(`missing semantic fixture: ${rawText}`);
      const semanticEnvelope = { ...fixture, requestId: options.requestId };
      if (rawText === "模型返回未声明槽") {
        semanticEnvelope.vehicleFrames = semanticEnvelope.vehicleFrames.map((item) => ({
          ...item, slots: { ...item.slots, undeclaredSlot: true },
        }));
      }
      return {
        semanticEnvelope,
        telemetry: { model: "vehicle-slu-test", provider: "injected" },
      };
    },
  };
  const runtime = new RuntimeKernel({
    routePolicy: new RoutePolicy({ localModel }),
    useCases: {
      chat: createChatUseCase({
        cloudAdapter: {
          async converse(rawText, parsedCommand, context) {
            chatCalls.push({ rawText, parsedCommand, context });
            return { summary: "听起来不错。", telemetry: { model: "chat-test", provider: "injected" } };
          },
        },
      }),
      "vehicle-control": controlHarness.useCase,
    },
    runEventLedger: new RunEventLedger(),
    sessionMemory: new SessionMemory({ now }),
    pendingClarifications: store,
    now,
    createRequestId: () => "unexpected-persistent-request-id",
  });
  const runWithStableClarification = (rawText, requestId, temporarySessionId) => runtime.run(rawText, {
    requestId,
    clarificationSessionId,
    interactionRef: {
      sessionId: temporarySessionId,
      turnId: `turn:${temporarySessionId}`,
    },
  });

  const opened = await runWithStableClarification(
    "打开主驾车窗",
    "run:vslu:pending-open",
    "interaction:window-expired-1",
  );
  assert.equal(opened.routeDecision.disposition, "clarify");
  assert.equal(opened.assistantResponse, "主驾车窗要打开到多少？");
  const openedPending = store.get(clarificationSessionId);
  assert.equal(openedPending.intent, "body.window.setPosition");
  assert.deepEqual(openedPending.acceptedSlots, { zone: "front_left" });
  assert.deepEqual(openedPending.missingSlots, ["percent"]);
  assert.equal(openedPending.originalUtterance, "打开主驾车窗");
  assert.ok(openedPending.taskId.includes("run:vslu:pending-open"));
  assert.equal(store.get("interaction:window-expired-1"), null,
    "the five-second interaction session id must never scope persistent clarification");

  const emptyVehicle = await runWithStableClarification(
    "继续",
    "run:vslu:pending-empty-vehicle",
    "interaction:window-expired-2",
  );
  assert.equal(emptyVehicle.routeDecision.disposition, "clarify");
  assert.equal(emptyVehicle.assistantResponse, openedPending.clarificationQuestion,
    "an empty vehicle follow-up keeps the active pending question");
  assert.deepEqual(store.get(clarificationSessionId), openedPending);

  runtime.sessionMemory.write("interaction:window-expired-3", {
    turnId: "memory-must-not-fill-control",
    intent: "conversation.general",
    userText: "主驾 50%",
    assistantText: "只作为闲聊上下文。",
  });
  const chat = await runWithStableClarification(
    "我今天心情不错",
    "run:vslu:pending-chat",
    "interaction:window-expired-3",
  );
  assert.equal(chat.assistantResponse, "听起来不错。");
  assert.equal(chatCalls.length, 1);
  assert.deepEqual(store.get(clarificationSessionId), openedPending,
    "ordinary chat and SessionMemory text must preserve pending without filling slots");
  assert.deepEqual(semanticCalls.at(-1).options.pending.acceptedSlots, { zone: "front_left" });
  assert.equal(Object.hasOwn(semanticCalls.at(-1).options, "memoryHint"), false);

  const resolved = await runWithStableClarification(
    "50%",
    "run:vslu:pending-resolve",
    "interaction:new-wake-session-4",
  );
  assert.equal(resolved.routeDecision.routeId, "vehicle-control");
  assert.deepEqual(resolved.parsedCommand.slots, { zone: "front_left", percent: 50 });
  assert.deepEqual(resolved.parsedCommand.slotProvenance, {
    zone: "original-turn",
    percent: "clarification-turn",
  });
  assert.equal(countCalls(controlHarness.calls, "safety.evaluate"), 1);
  assert.equal(countCalls(controlHarness.calls, "vehicle.execute"), 1);
  assert.deepEqual(
    controlHarness.calls.find((entry) => entry.name === "safety.evaluate").input.command.slotProvenance,
    { zone: "original-turn", percent: "clarification-turn" },
    "Safety receives the exact original/delta provenance",
  );
  const toolArgProvenance = controlHarness.calls
    .find((entry) => entry.name === "vehicle.execute").input.toolCall.argProvenance;
  assert.deepEqual(
    { zone: toolArgProvenance.zone, percent: toolArgProvenance.percent },
    { zone: "original-turn", percent: "clarification-turn" },
    "Vehicle Tool preserves the exact provenance of the resolved clarification slots",
  );
  assert.equal(toolArgProvenance.antiPinch, "context",
    "Safety provenance for its anti-pinch enrichment remains explicit");
  assert.equal(store.get(clarificationSessionId), null,
    "a follow-up from a new temporary interaction session resolves the stable pending");

  await runWithStableClarification("打开主驾车窗", "run:vslu:pending-open", "interaction:replace-5");
  await runWithStableClarification("调一下主驾座椅", "run:vslu:pending-replace", "interaction:replace-6");
  assert.equal(store.get(clarificationSessionId).intent, "seat.driver.setBackrestAngle");
  assert.deepEqual(store.get(clarificationSessionId).missingSlots, ["angle"]);
  const resolvedSeat = await runWithStableClarification(
    "112度",
    "run:vslu:pending-seat-resolve",
    "interaction:seat-resolve-7",
  );
  assert.equal(resolvedSeat.routeDecision.routeId, "vehicle-control");
  assert.deepEqual(resolvedSeat.parsedCommand.slots, { seat: "driver", angle: 112 });
  assert.equal(store.get(clarificationSessionId), null);

  store.clear(clarificationSessionId, "prepare-reject-test");
  await runWithStableClarification("打开主驾车窗", "run:vslu:pending-open", "interaction:reject-7");
  const beforeReject = store.get(clarificationSessionId);
  const vehicleCallsBeforeReject = countCalls(controlHarness.calls, "vehicle.execute");
  const corrected = await runWithStableClarification("副驾50%", "run:vslu:pending-reject", "interaction:reject-8");
  assert.equal(corrected.routeDecision.routeId, "vehicle-control",
    "a validated model correction replaces the original target");
  assert.deepEqual(corrected.parsedCommand.slots, { zone: "front_right", percent: 50 });
  assert.equal(store.get(clarificationSessionId), null);
  assert.equal(countCalls(controlHarness.calls, "vehicle.execute"), vehicleCallsBeforeReject + 1);

  store.set(clarificationSessionId, beforeReject);
  const rejected = await runWithStableClarification("模型返回未声明槽", "run:vslu:pending-invalid-slot", "interaction:reject-9");
  assert.equal(rejected.routeDecision.disposition, "respond");
  assert.equal(rejected.routeDecision.reasonCode, "semantic-contract-invalid");
  assert.equal(rejected.toolCall, null);
  assert.deepEqual(store.get(clarificationSessionId), beforeReject);
  assert.equal(countCalls(controlHarness.calls, "vehicle.execute"), vehicleCallsBeforeReject + 1);

  await verifyPendingCancellationAndLateResult({ store, clarificationSessionId });
}

async function verifyPendingCancellationAndLateResult({ store, clarificationSessionId }) {
  const cancellationPending = {
    taskId: "pending:cancel-test",
    intent: "body.window.setPosition",
    acceptedSlots: { zone: "front_left" },
    missingSlots: ["percent"],
    slotProvenance: { zone: "original-turn" },
    clarificationQuestion: "主驾车窗要打开到多少？",
    originalUtterance: "打开主驾车窗",
  };
  store.set(clarificationSessionId, cancellationPending);
  const terminalCancelRuntime = new RuntimeKernel({
    routePolicy: {
      async resolve(_rawText, options) {
        return {
          decision: {
            disposition: "cancel", routeId: null, mode: null, confidence: 1,
            reasonCode: "user-cancelled", semanticSource: "deterministic", runId: options.runId,
          },
          parsedCommand: { requestId: options.requestId, intent: "conversation.general", slots: {} },
        };
      },
    },
    useCases: {},
    runEventLedger: new RunEventLedger(),
    sessionMemory: new SessionMemory({ now }),
    pendingClarifications: store,
    now,
  });
  const cancelled = await terminalCancelRuntime.run("取消", {
    requestId: "run:vslu:pending-cancel",
    clarificationSessionId,
    interactionRef: { sessionId: "interaction:cancel-9", turnId: "turn:cancel-9" },
  });
  assert.equal(cancelled.routeDecision.disposition, "cancel");
  assert.equal(store.get(clarificationSessionId), null, "terminal cancel clears pending before returning");

  store.set(clarificationSessionId, cancellationPending);
  let releaseSemantic;
  const semanticBarrier = new Promise((resolve) => { releaseSemantic = resolve; });
  const caller = new AbortController();
  const lateRuntime = new RuntimeKernel({
    routePolicy: {
      async resolve(_rawText, options) {
        await semanticBarrier;
        return new RoutePolicy({
          localModel: {
            async parse() {
              return {
                semanticEnvelope: envelope(options.requestId, {
                  conversationGoal: { summary: "补充开度", need: "none" },
                  frames: [frame("late-delta", "control", "body.window.setPosition", "execute", { percent: 50 })],
                }),
                telemetry: { model: "late-test", provider: "injected" },
              };
            },
          },
        }).resolve("50%", options);
      },
    },
    useCases: {
      "vehicle-control": { execute() { throw new Error("late result must not execute"); } },
    },
    runEventLedger: new RunEventLedger(),
    sessionMemory: new SessionMemory({ now }),
    pendingClarifications: store,
    now,
  });
  const late = lateRuntime.run("50%", {
    requestId: "run:vslu:pending-late",
    clarificationSessionId,
    interactionRef: { sessionId: "interaction:late-10", turnId: "turn:late-10" },
    signal: caller.signal,
  });
  caller.abort("user-cancelled");
  releaseSemantic();
  await assert.rejects(late, (error) => error?.name === "AbortError");
  assert.equal(store.get(clarificationSessionId), null, "aborted late semantic result cannot restore pending");
}

async function verifyPersistentClarificationOrchestratedRuntime() {
  const clarificationSessionId = "browser:vslu:orchestrated-clarification";
  const store = new PendingClarificationStore();
  const controlHarness = createLeanRuntimeVehicleControlHarness();
  const calls = [];
  const semanticFixtures = new Map([
    ["打开副驾车窗", {
      conversationGoal: { summary: "打开副驾车窗", need: "none" },
      frames: [frame("orchestrated-pending-window", "control", "body.window.setPosition", "clarify", {
        zone: "front_right",
      }, {
        missingSlots: ["percent"],
        clarificationQuestion: "副驾车窗要打开到多少？",
      })],
    }],
    ["50%，也解释一下为什么开一半", {
      conversationGoal: { summary: "解释并把副驾车窗调到一半", need: "explain" },
      frames: [frame("orchestrated-window-delta", "control", "body.window.setPosition", "execute", {
        percent: 50,
      })],
    }],
  ]);
  const runtime = new RuntimeKernel({
    routePolicy: new RoutePolicy({
      localModel: {
        async parse(rawText, options) {
          const fixture = semanticFixtures.get(rawText);
          if (!fixture) throw new Error(`missing orchestrated clarification fixture: ${rawText}`);
          return {
            semanticEnvelope: envelope(options.requestId, fixture),
            telemetry: { model: "vehicle-slu-test", provider: "injected" },
          };
        },
      },
    }),
    useCases: {
      task: orchestratedUseCase({ calls, vehicleControl: controlHarness.useCase }),
    },
    runEventLedger: new RunEventLedger(),
    sessionMemory: new SessionMemory({ now }),
    pendingClarifications: store,
    now,
  });

  const opened = await runtime.run("打开副驾车窗", {
    requestId: "run:vslu:orchestrated-pending-open",
    clarificationSessionId,
    interactionRef: { sessionId: "interaction:orchestrated-1", turnId: "turn:orchestrated-1" },
  });
  assert.equal(opened.routeDecision.disposition, "clarify");

  const resolved = await runtime.run("50%，也解释一下为什么开一半", {
    requestId: "run:vslu:orchestrated-pending-resolve",
    clarificationSessionId,
    interactionRef: { sessionId: "interaction:orchestrated-2", turnId: "turn:orchestrated-2" },
  });
  assert.equal(resolved.routeDecision.routeId, "task");
  assert.equal(resolved.routeDecision.mode, "orchestrated");
  assert.deepEqual(resolved.parsedCommand.slotProvenance, {
    zone: "original-turn",
    percent: "clarification-turn",
  });
  assert.equal(countCalls(controlHarness.calls, "safety.evaluate"), 1);
  assert.equal(countCalls(controlHarness.calls, "vehicle.execute"), 1);
  assert.deepEqual(
    controlHarness.calls.find((entry) => entry.name === "safety.evaluate").input.command.slotProvenance,
    { zone: "original-turn", percent: "clarification-turn" },
    "orchestrated Safety receives the exact clarification provenance",
  );
  const toolProvenance = controlHarness.calls
    .find((entry) => entry.name === "vehicle.execute").input.toolCall.argProvenance;
  assert.deepEqual(
    { zone: toolProvenance.zone, percent: toolProvenance.percent },
    { zone: "original-turn", percent: "clarification-turn" },
    "orchestrated Vehicle Tool preserves the exact clarification provenance",
  );
  assert.equal(toolProvenance.antiPinch, "context");
  assert.equal(store.get(clarificationSessionId), null);
}

function kernel({ semanticEnvelope, calls, useCases, executionDisabled = false, reasonCode = "semantic-model-unavailable", parsedCommandOverride = null, runEventLedger = new RunEventLedger(), prepareManualRetrievalCandidate = null }) {
  const vehicleSluRoutePolicy = new RoutePolicy({
    localModel: {
      async parse(rawText, options) {
        calls.push({ name: "semantic.parse", rawText, options });
        return semanticEnvelope
          ? { semanticEnvelope, telemetry: { model: "vehicle-slu-test", provider: "injected" } }
          : { semanticEnvelope: null, executionDisabled, reasonCode, telemetry: { model: "vehicle-slu-test", provider: "injected" } };
      },
    },
  });
  return new RuntimeKernel({
    routePolicy: parsedCommandOverride ? {
      async resolve(rawText, options) {
        const resolution = await vehicleSluRoutePolicy.resolve(rawText, options);
        return Object.freeze({ ...resolution, parsedCommand: structuredClone(parsedCommandOverride) });
      },
    } : vehicleSluRoutePolicy,
    useCases,
    runEventLedger,
    sessionMemory: new SessionMemory({ now }),
    now,
    createRequestId: () => "unexpected-generated-request-id",
    ...(prepareManualRetrievalCandidate ? { prepareManualRetrievalCandidate } : {}),
  });
}

function orchestratedUseCase({ calls, vehicleControl, failForeground = false }) {
  return createComplexTaskUseCase({
    externalDataAdapter: { execute() { throw new Error("direct external adapter must stay inactive"); } },
    cabin: {
      async formGoal(input) { calls.push({ name: "cabin.formGoal", input }); throw new Error("Vehicle-SLU must bypass formGoal"); },
      async respondForeground(input) {
        calls.push({ name: "cabin.respondForeground", input });
        if (failForeground) throw new Error("injected foreground failure");
        return { text: "我先回应你的开放话题，车内请求正在处理中。", telemetry: { model: "foreground", provider: "injected" } };
      },
      async synthesize(input) {
        calls.push({ name: "cabin.synthesize", input });
        return { text: "操作已由 Provider 确认完成。", telemetry: { model: "synthesis", provider: "injected" } };
      },
    },
    orchestrator: {
      async plan(input) {
        calls.push({ name: "orchestrator.plan", input });
        const taskPlan = plan(input.runId, input.goalEnvelope.goalId);
        return {
          taskPlan,
          validation: { ok: true, errors: [], plan: taskPlan },
          telemetry: { model: "planner", provider: "injected" },
        };
      },
    },
    createExecutionLedger: createTaskPlanExecution,
    capabilityOwners: {
      "safety.evaluate": {
        async execute() {
          calls.push({ name: "safety.owner" });
          return {
            safetyDecision: { allowed: true, action: "allow", reason: "测试安全允许", reasonCode: "safety-allowed" },
          };
        },
      },
    },
    vehicleControl,
    now,
  });
}

function envelope(requestId, { domain = "vehicle", conversationGoal, frames }) {
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    requestId,
    domain,
    conversationGoal: Object.freeze(conversationGoal),
    vehicleFrames: Object.freeze(frames),
    domainConfidence: 0.98,
  });
}

function frame(frameId, capability, intent, actionNeed, slots, options = {}) {
  const knowledgeNeed = intent === "vehicle.knowledge.query" ? "manual" : "none";
  return Object.freeze({
    frameId,
    capability,
    intent,
    speechAct: actionNeed === "execute" ? "command" : "question",
    knowledgeNeed,
    actionNeed,
    slots: Object.freeze(slots),
    missingSlots: Object.freeze([...(options.missingSlots || [])]),
    clarificationQuestion: options.clarificationQuestion || null,
    standaloneQuery: knowledgeNeed === "manual" ? String(slots.query || "") : null,
    confidence: 0.97,
  });
}

function goal(runId) {
  return {
    goalId: `goal:${runId}`,
    runId,
    objective: "调节副驾车窗",
    interactionType: "command",
    domain: "vehicle-control",
    constraints: [],
    contextRefs: [],
    requiredClarifications: [],
    readyForPlanning: true,
    model: "vehicle-slu",
    provider: "runtime",
    confidenceStrength: "strong",
  };
}

function plan(runId, goalId) {
  const steps = [
    {
      stepId: "safety-window",
      capabilityId: "safety.evaluate",
      dependsOn: [],
      input: { action: "body.window.setPosition" },
      expectedOutput: "safety-decision",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "write-window",
      capabilityId: "vehicle.window.set-position",
      dependsOn: ["safety-window"],
      input: { zone: "front_right", percent: 50 },
      expectedOutput: "provider-confirmed-write",
      accessMode: "write",
      status: "planned",
    },
    {
      stepId: "response-window",
      capabilityId: "response.synthesize",
      dependsOn: ["write-window"],
      input: { facts: { summary: "Use only completed execution facts.", evidenceRefs: [] } },
      expectedOutput: "bounded-response",
      accessMode: "read",
      status: "planned",
    },
  ];
  return {
    planId: `plan:${runId}`,
    goalId,
    runId,
    steps,
    selectedCapabilities: steps.map((step) => step.capabilityId),
    writeActionCount: 1,
    planningSummary: "Execute the admitted Vehicle-SLU frame only.",
    model: "planner",
    provider: "injected",
    status: "planned",
  };
}

function rejectingUseCases(calls) {
  return new Proxy({}, {
    get() {
      return { execute() { calls.push({ name: "use-case.execute" }); throw new Error("terminal route must not execute a use case"); } };
    },
  });
}

function countNamed(calls, name) {
  return calls.filter((entry) => entry.name === name).length;
}

function assertNoCalls(calls, patterns) {
  for (const pattern of patterns) {
    assert.equal(calls.some((entry) => entry.name.includes(pattern)), false, `unexpected call matching ${pattern}`);
  }
}
