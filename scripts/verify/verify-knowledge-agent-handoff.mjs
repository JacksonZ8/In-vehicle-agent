#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  callNames,
  createCompatibilityHarness,
  createLeanRuntimeVehicleKnowledgeHarness,
} from "../lib/lean-runtime-test-harness.mjs";
import {
  CabinAssistantController,
  projectAgentModelTelemetry,
} from "../../src/agents/cabin-assistant-controller.js";
import { OrchestratorController } from "../../src/agents/orchestrator-controller.js";
import {
  createKnowledgeDelegation,
  createKnowledgeSubplan,
} from "../../src/application/contracts/vehicle-knowledge.js";
import {
  AI_AGENT_COMPONENT_IDS,
  PARTICIPANT_REGISTRY,
  PARTICIPANT_TYPES,
} from "../../src/runtime/participant-registry.js";

assert.deepEqual(AI_AGENT_COMPONENT_IDS, ["cabinAssistant", "orchestrator"]);
assert.equal(
  Object.values(PARTICIPANT_REGISTRY)
    .filter(({ type }) => type === PARTICIPANT_TYPES.AI_AGENT).length,
  2,
);
assert.deepEqual(
  projectAgentModelTelemetry({ reasonCode: "PRIVATE_PROVIDER_MESSAGE" }),
  {},
  "arbitrary model reason codes must not cross the public telemetry boundary",
);
assert.deepEqual(
  projectAgentModelTelemetry({
    provider: "dashscope",
    model: "qwen3.5-flash-2026-02-23",
    reason: "provider-auth-failed",
    reasonCode: "provider-auth-failed",
    degraded: true,
    fallbackActive: false,
    fallbackAttempted: false,
    externalModelRequestCount: 1,
  }),
  {
    provider: "dashscope",
    model: "qwen3.5-flash-2026-02-23",
    reason: "provider-auth-failed",
    reasonCode: "provider-auth-failed",
    degraded: true,
    fallbackActive: false,
    fallbackAttempted: false,
    externalModelRequestCount: 1,
  },
  "Knowledge Answer failure telemetry must retain provider, fallback state and bounded call count",
);

const simpleHarness = createLeanRuntimeVehicleKnowledgeHarness();
const simpleManual = await simpleHarness.runtime.run(
  "ES8 打开尾门前需要确认什么条件？",
  { requestId: "run:knowledge-handoff:simple" },
);
assert.deepEqual(knowledgeParticipants(simpleManual), ["manualRetriever", "cabinAssistant"]);
assert.equal(countCalls(simpleHarness, "orchestrator.planKnowledgeTask"), 0);
assert.equal(answerParticipant(simpleManual), "cabinAssistant");

const providerFailureHarness = createLeanRuntimeVehicleKnowledgeHarness({
  modelBehavior: {
    synthesize() {
      const error = new Error("local boundary failure");
      error.telemetry = {
        provider: "dashscope",
        model: "qwen3.5-flash-2026-02-23",
        reason: "provider-auth-failed",
        reasonCode: "provider-auth-failed",
        degraded: true,
        fallbackActive: false,
        fallbackAttempted: false,
        externalModelRequestCount: 1,
      };
      throw error;
    },
  },
});
const providerFailureRun = await providerFailureHarness.runtime.run(
  "ES8 打开尾门前需要确认什么条件？",
  { requestId: "run:knowledge-handoff:provider-failure" },
);
const providerFailureEvent = providerFailureRun.events.find((event) => (
  event.component === "cabinModel" && event.phase === "knowledge-answer-model"
));
assert.ok(providerFailureEvent, "provider failure must retain a model event for diagnosis");
assert.equal(providerFailureEvent.provider, "dashscope");
assert.equal(providerFailureEvent.model, "qwen3.5-flash-2026-02-23");
assert.deepEqual(providerFailureEvent.metadata.modelTelemetry, {
  fallback: false,
  fallbackActive: false,
  fallbackAttempted: false,
  externalModelRequestCount: 1,
});

const complexHarness = createLeanRuntimeVehicleKnowledgeHarness();
const complexManual = await complexHarness.runtime.run(
  "比较 ES8 尾门和车窗的安全条件",
  { requestId: "run:knowledge-handoff:complex" },
);
assert.deepEqual(
  knowledgeParticipants(complexManual),
  ["orchestrator", "manualRetriever", "cabinAssistant"],
);
assert.equal(countCalls(complexHarness, "orchestrator.planKnowledgeTask"), 1);
assert.equal(answerParticipant(complexManual), "cabinAssistant");
assert.deepEqual(callNames(complexHarness.calls), [
  "orchestrator.planKnowledgeTask",
  "knowledge.plan",
  "manual.retrieve",
  "knowledge.synthesize",
]);

const planningClarificationHarness = createLeanRuntimeVehicleKnowledgeHarness({
  modelBehavior: {
    plan({ delegation }) {
      return {
        output: {
          delegationId: delegation.delegationId,
          runId: delegation.runId,
          outcomeStatus: "clarification",
          questions: ["请说明要比较哪个具体功能。"],
          reasonCode: "knowledge-goal-ambiguous",
          model: "fixture-planner",
          provider: "fixture-provider",
        },
        telemetry: { model: "fixture-planner", provider: "fixture-provider", degraded: false },
      };
    },
  },
});
const planningClarification = await planningClarificationHarness.runtime.run(
  "比较 ES8 尾门和车窗的安全条件",
  { requestId: "run:knowledge-handoff:clarification" },
);
assert.equal(planningClarification.assistantResponse, "请说明要比较哪个具体功能。");
assert.deepEqual(
  cabinBoundaryEvent(planningClarification),
  {
    phase: "clarification",
    status: "awaiting_clarification",
    reasonCode: "knowledge-goal-ambiguous",
    outcomeStatus: "clarification",
  },
);
assert.equal(
  planningClarification.events.find((event) => (
    event.phase === "knowledge-plan-model" && event.component === "orchestratorModel"
  ))?.metadata?.degraded,
  false,
  "a valid Orchestrator clarification is pending, not degraded",
);

for (const [label, harness, text] of [
  ["non-ES8", createLeanRuntimeVehicleKnowledgeHarness(), "ET5 打开尾门前需要确认什么条件？"],
  ["authority unavailable", createLeanRuntimeVehicleKnowledgeHarness(), "请打开车窗"],
  ["invalid complex plan", createLeanRuntimeVehicleKnowledgeHarness({
    modelBehavior: { plan() { return { output: {}, telemetry: {} }; } },
  }), "比较 ES8 尾门和车窗的安全条件"],
]) {
  const result = await harness.runtime.run(text, { requestId: `run:knowledge-handoff:${label}` });
  const boundary = cabinBoundaryEvent(result);
  assert.equal(boundary.phase, "final-synthesis", `${label}: Cabin must own deterministic boundary`);
  assert.notEqual(boundary.status, "completed", `${label}: non-answer boundary must preserve terminal status`);
}

const stateHarness = createCompatibilityHarness({
  route: "vehicle-state-role-baseline",
  modelBehavior: {
    async parse(_text, input) {
      return { semanticEnvelope: vehicleStateEnvelope(input.requestId) };
    },
  },
});
const stateResult = await stateHarness.runtime.run(
  "我的 ES8 当前挡位和车速是多少？",
  { requestId: "run:knowledge-handoff:state" },
);
assert.deepEqual(cabinBoundaryEvent(stateResult), {
  phase: "final-synthesis",
  status: "completed",
  reasonCode: "vehicle-state-provider-read",
  outcomeStatus: "answered",
});

await verifyNewOwnerAdversarialBoundaries();

const sourceFiles = await collectSourceFiles(new URL("../../src/", import.meta.url));
for (const file of sourceFiles) {
  const source = await readFile(file, "utf8");
  assert.doesNotMatch(source, /agent\.vehicle-knowledge\.delegate/u, `${file} retains obsolete capability`);
}

console.log("knowledge agent handoff verification passed");

function knowledgeParticipants(result) {
  return result.events
    .filter((event) => event.phase.startsWith("knowledge-"))
    .filter((event) => event.phase !== "knowledge-delegation")
    .filter((event) => !["cabinModel", "orchestratorModel"].includes(event.component))
    .map((event) => event.component);
}

function answerParticipant(result) {
  return result.events.find((event) => event.phase === "knowledge-answer")?.component ?? null;
}

function countCalls(harness, name) {
  return callNames(harness.calls).filter((candidate) => candidate === name).length;
}

function cabinBoundaryEvent(result) {
  const event = result.events.find((candidate) => (
    candidate.component === "cabinAssistant"
    && ["clarification", "final-synthesis", "knowledge-answer"].includes(candidate.phase)
  ));
  assert.ok(event, "vehicle-knowledge user text must cross a Cabin-owned boundary event");
  return {
    phase: event.phase,
    status: event.status,
    reasonCode: event.metadata?.reasonCode,
    outcomeStatus: event.metadata?.knowledge?.outcomeStatus
      ?? event.metadata?.presentation?.outcomeStatus,
  };
}

async function verifyNewOwnerAdversarialBoundaries() {
  const activeDelegation = knowledgeDelegation();
  const eligibilityDelegation = createKnowledgeDelegation({
    ...activeDelegation,
    knowledgeGoal: "ES8 尾门现在是否满足开启条件",
    allowedCapabilities: [
      "knowledge.manual.retrieve",
      "knowledge.vehicle-state.read",
      "knowledge.safety.evaluate",
      "knowledge.answer.synthesize",
    ],
    allowVehicleStateRead: true,
    requireSafetyEligibilityExplanation: true,
  });
  let planningOutput = clarificationOutput(activeDelegation);
  const orchestrator = new OrchestratorController({
    modelAdapter: {
      async createTaskPlan() { throw new Error("not used"); },
      async createVehicleKnowledgeSubplan() { return { output: planningOutput, telemetry: {} }; },
    },
  });
  const acceptedClarification = await orchestrator.planKnowledgeTask({
    delegation: activeDelegation,
    complexity: "multi-target",
  });
  assert.equal(acceptedClarification.clarificationRequest.outcomeStatus, "clarification");

  planningOutput = clarificationOutput(eligibilityDelegation);
  const rejectedEligibility = await orchestrator.planKnowledgeTask({
    delegation: eligibilityDelegation,
    complexity: "multi-target",
  });
  assert.equal(rejectedEligibility.validation.ok, false);
  assert.match(rejectedEligibility.validation.errors.join(" "), /clarification-not-allowed/);

  planningOutput = { ...clarificationOutput(activeDelegation), delegationId: "delegation:forged" };
  const rejectedAssociation = await orchestrator.planKnowledgeTask({
    delegation: activeDelegation,
    complexity: "multi-target",
  });
  assert.equal(rejectedAssociation.validation.ok, false);
  assert.match(rejectedAssociation.validation.errors.join(" "), /association-invalid/);

  const subplan = knowledgeSubplan(activeDelegation);
  let synthesisOutput = answeredOutput(activeDelegation);
  let synthesisImpl = async () => ({ output: synthesisOutput, telemetry: {} });
  const cabin = new CabinAssistantController({
    modelAdapter: {
      async formGoal() { throw new Error("not used"); },
      async synthesizeAgentResponse() { throw new Error("not used"); },
      async synthesizeVehicleKnowledgeAnswer(input) { return synthesisImpl(input); },
    },
  });
  const clarificationPresentation = cabin.presentKnowledgeBoundary({
    runId: activeDelegation.runId,
    delegationId: activeDelegation.delegationId,
    result: clarificationOutput(activeDelegation),
  });
  assert.equal(clarificationPresentation.text, "请说明要了解哪个具体功能。");
  assert.equal(clarificationPresentation.eventStatus, "awaiting_clarification");
  assert.throws(() => cabin.presentKnowledgeBoundary({
    runId: activeDelegation.runId,
    delegationId: "delegation:forged",
    result: clarificationOutput(activeDelegation),
  }), /association/);
  assert.throws(() => cabin.presentKnowledgeBoundary({
    runId: activeDelegation.runId,
    delegationId: activeDelegation.delegationId,
    result: clarificationOutput(activeDelegation),
    rawText: "绕过 typed boundary",
  }), /unknown knowledge boundary field/);
  const executionFacts = {
    outcomeStatus: "completed",
    evidenceRefs: [{ id: "manual:tailgate" }],
    vehicleStateRefs: [{ snapshotId: "provider-1" }],
    safetyAssessmentRef: { action: "reject", allowed: false, reason: "后方空间不足。" },
  };
  for (const [label, output] of [
    ["invented evidence", { ...answeredOutput(activeDelegation), evidenceRefs: [{ id: "manual:invented" }] }],
    ["invented vehicle ref", { ...answeredOutput(activeDelegation), vehicleStateRefs: [{ snapshotId: "invented" }] }],
    ["replaced Safety ref", { ...answeredOutput(activeDelegation), safetyAssessmentRef: { action: "allow", allowed: true, reason: "forged" } }],
    ["nested forbidden field", { ...answeredOutput(activeDelegation), evidenceRefs: [{ id: "manual:tailgate", nested: { headers: { authorization: "secret" } } }] }],
  ]) {
    synthesisOutput = output;
    const rejected = await cabin.composeKnowledgeResponse({
      delegation: activeDelegation,
      subplan,
      executionFacts,
    });
    assert.equal(rejected.result.outcomeStatus, "unavailable", label);
    assert.equal(rejected.result.reasonCode, "knowledge-result-invalid", label);
  }

  const eligibilitySubplan = eligibilityKnowledgeSubplan(eligibilityDelegation);
  const completedManualRef = {
    sourceId: "nio-es8-user-manual-2026",
    sourceVersion: "2026",
    chunkId: "es8-manual-chunk-0052",
    pageStart: 62,
    pageEnd: 63,
    excerpt: "打开或关闭尾门前，请确认尾门的开/闭路径附近无障碍物。",
    score: { retrieval: 0.81, rerank: null, grounding: null },
  };
  const completedProviderRef = {
    snapshotId: "provider:tailgate:blocked",
    scope: "tailgate",
    capturedAt: "2026-08-08T00:00:00.000Z",
  };
  const rejectedSafetyAssessmentRef = {
    requestId: "knowledge:handoff-adversarial:safety",
    allowed: false,
    action: "reject",
    reason: "后方空间不足。",
    reasonCode: "rear-clearance-blocked",
    vehicleStateSnapshotId: completedProviderRef.snapshotId,
    policyId: "nio-safety-policy@1.0.0",
    manualEvidenceStatus: "hit",
  };
  const eligibilityFacts = {
    outcomeStatus: "completed",
    evidenceRefs: [completedManualRef],
    vehicleStateRefs: [completedProviderRef],
    safetyAssessmentRef: rejectedSafetyAssessmentRef,
  };
  const falseAffirmativeModelAnswer = "当前条件已满足，可以开启尾门。";
  synthesisOutput = {
    ...answeredOutput(eligibilityDelegation),
    answer: falseAffirmativeModelAnswer,
    evidenceRefs: eligibilityFacts.evidenceRefs,
    vehicleStateRefs: eligibilityFacts.vehicleStateRefs,
    safetyAssessmentRef: eligibilityFacts.safetyAssessmentRef,
  };
  const safetyAuthoritativeAnswer = await cabin.composeKnowledgeResponse({
    delegation: eligibilityDelegation,
    subplan: eligibilitySubplan,
    executionFacts: eligibilityFacts,
  });
  assert.equal(safetyAuthoritativeAnswer.result.outcomeStatus, "answered");
  assert.match(safetyAuthoritativeAnswer.result.answer, /不满足开启条件|不可开启/);
  assert.match(safetyAuthoritativeAnswer.result.answer, /后方空间不足/);
  assert.equal(safetyAuthoritativeAnswer.result.answer.includes(falseAffirmativeModelAnswer), false);
  assert.doesNotMatch(safetyAuthoritativeAnswer.result.answer, /可以开启尾门/);
  assert.deepEqual(
    safetyAuthoritativeAnswer.result.safetyAssessmentRef,
    rejectedSafetyAssessmentRef,
    "Cabin must preserve the exact completed Safety assessment while rewriting the answer",
  );

  synthesisOutput = { ...answeredOutput(activeDelegation), delegationId: "delegation:forged" };
  const terminalAssociation = await cabin.composeKnowledgeResponse({
    delegation: activeDelegation,
    subplan,
    executionFacts,
  });
  assert.equal(terminalAssociation.result.outcomeStatus, "unavailable");
  assert.equal(terminalAssociation.result.reasonCode, "association-invalid");

  for (const output of [
    clarificationOutput(activeDelegation),
    {
      delegationId: activeDelegation.delegationId,
      runId: activeDelegation.runId,
      outcomeStatus: "not-applicable",
      reasonCode: "vehicle-scope-not-applicable",
      limitations: ["首版仅接入 ES8 车型知识。"],
      degraded: false,
    },
    {
      delegationId: activeDelegation.delegationId,
      runId: activeDelegation.runId,
      outcomeStatus: "unavailable",
      reasonCode: "model-timeout",
      limitations: ["模型阶段不可用。"],
      degraded: true,
    },
  ]) {
    synthesisOutput = output;
    const terminal = await cabin.composeKnowledgeResponse({
      delegation: activeDelegation,
      subplan,
      executionFacts: {},
    });
    assert.equal(terminal.result.outcomeStatus, output.outcomeStatus);
  }

  const synthesisFailure = new Error("private provider failure");
  synthesisFailure.telemetry = {
    provider: "dashscope",
    model: "qwen3.5-flash-2026-02-23",
    durationMs: 4567,
    degraded: true,
    reason: "knowledge-result-invalid",
  };
  synthesisImpl = async () => { throw synthesisFailure; };
  const unavailable = await cabin.composeKnowledgeResponse({
    delegation: activeDelegation,
    subplan,
    executionFacts,
  });
  assert.equal(unavailable.result.reasonCode, "knowledge-result-invalid");
  assert.deepEqual(unavailable.telemetry, {
    provider: "dashscope",
    model: "qwen3.5-flash-2026-02-23",
    durationMs: 4567,
    degraded: true,
    reason: "knowledge-result-invalid",
    reasonCode: "knowledge-result-invalid",
  });

  const synthesisStarted = deferred();
  const lateSynthesis = deferred();
  synthesisImpl = async () => {
    synthesisStarted.resolve();
    return lateSynthesis.promise;
  };
  const abortController = new AbortController();
  const pending = cabin.composeKnowledgeResponse({
    delegation: activeDelegation,
    subplan,
    executionFacts,
    signal: abortController.signal,
  });
  await synthesisStarted.promise;
  const cancellationReason = Object.freeze({ code: "caller-cancelled", turnId: "turn:knowledge" });
  abortController.abort(cancellationReason);
  lateSynthesis.resolve({ output: answeredOutput(activeDelegation), telemetry: {} });
  await assert.rejects(pending, (error) => (
    error?.name === "AbortError"
    && error.reason === cancellationReason
    && error.cause === cancellationReason
  ));
}

function knowledgeDelegation() {
  return createKnowledgeDelegation({
    delegationId: "delegation:handoff-adversarial",
    runId: "run:handoff-adversarial",
    parentPlanId: "plan:handoff-adversarial",
    parentStepId: "manual",
    knowledgeGoal: "比较 ES8 尾门和车窗条件",
    vehicleScope: "nio-es8-user-manual-2026",
    allowedCapabilities: ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
    allowVehicleStateRead: false,
    requireSafetyEligibilityExplanation: false,
    expectedAnswerContract: "KnowledgeAnswer",
    dependsOn: [],
  });
}

function knowledgeSubplan(delegation) {
  return createKnowledgeSubplan({
    subplanId: `subplan:${delegation.runId}`,
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    parentPlanId: delegation.parentPlanId,
    parentStepId: delegation.parentStepId,
    steps: [{
      stepId: "manual",
      capabilityId: "knowledge.manual.retrieve",
      dependsOn: [],
      input: { query: delegation.knowledgeGoal },
      expectedOutput: "manual-evidence",
      accessMode: "read",
      status: "planned",
    }, {
      stepId: "answer",
      capabilityId: "knowledge.answer.synthesize",
      dependsOn: ["manual"],
      input: { facts: { summary: "只基于证据回答。", evidenceRefs: ["manual:tailgate"] } },
      expectedOutput: "knowledge-answer",
      accessMode: "read",
      status: "planned",
    }],
    selectedCapabilities: ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
    planningSummary: "只读证据回答。",
    model: "fixture-planner",
    provider: "fixture-provider",
    status: "planned",
  });
}

function eligibilityKnowledgeSubplan(delegation) {
  return createKnowledgeSubplan({
    subplanId: `subplan:${delegation.runId}:eligibility`,
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    parentPlanId: delegation.parentPlanId,
    parentStepId: delegation.parentStepId,
    steps: [{
      stepId: "manual",
      capabilityId: "knowledge.manual.retrieve",
      dependsOn: [],
      input: { query: "ES8 尾门 开启 安全" },
      expectedOutput: "manual-evidence",
      accessMode: "read",
      status: "planned",
    }, {
      stepId: "vehicle-state",
      capabilityId: "knowledge.vehicle-state.read",
      dependsOn: ["manual"],
      input: { scope: "tailgate" },
      expectedOutput: "vehicle-state",
      accessMode: "read",
      status: "planned",
    }, {
      stepId: "safety",
      capabilityId: "knowledge.safety.evaluate",
      dependsOn: ["vehicle-state"],
      input: { action: "body.tailgate.open" },
      expectedOutput: "safety-eligibility",
      accessMode: "read",
      status: "planned",
    }, {
      stepId: "answer",
      capabilityId: "knowledge.answer.synthesize",
      dependsOn: ["manual", "safety"],
      input: { facts: { summary: "当前尾门状态", evidenceRefs: ["manual", "safety"] } },
      expectedOutput: "knowledge-answer",
      accessMode: "read",
      status: "planned",
    }],
    selectedCapabilities: [
      "knowledge.manual.retrieve",
      "knowledge.vehicle-state.read",
      "knowledge.safety.evaluate",
      "knowledge.answer.synthesize",
    ],
    planningSummary: "检索手册并结合 Provider 与 Safety 判断当前尾门开启资格。",
    model: "fixture-planner",
    provider: "fixture-provider",
    status: "planned",
  });
}

function clarificationOutput(delegation) {
  return {
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    outcomeStatus: "clarification",
    questions: ["请说明要了解哪个具体功能。"],
    reasonCode: "knowledge-goal-ambiguous",
    model: "fixture-planner",
    provider: "fixture-provider",
  };
}

function answeredOutput(delegation) {
  return {
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    outcomeStatus: "answered",
    supportStatus: "supported",
    answer: "仅根据已接受事实回答。",
    evidenceRefs: [{ id: "manual:tailgate" }],
    vehicleStateRefs: [{ snapshotId: "provider-1" }],
    safetyAssessmentRef: { action: "reject", allowed: false, reason: "后方空间不足。" },
    limitations: [],
    model: "fixture-answer",
    provider: "fixture-provider",
    durationMs: 1,
    degraded: false,
  };
}

function vehicleStateEnvelope(requestId) {
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function collectSourceFiles(directoryUrl) {
  const directory = fileURLToPath(directoryUrl);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    if (entry.isDirectory()) return collectSourceFiles(url);
    return entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))
      ? [fileURLToPath(url)]
      : [];
  }));
  return nested.flat();
}
