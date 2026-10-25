import assert from "node:assert/strict";
import {
  executeKnowledgeSubplan,
  getManualRetrievalDuration,
} from "../../src/application/use-cases/vehicle-knowledge-execution.js";
import { createKnowledgeDelegation, createKnowledgeSubplan } from "../../src/application/contracts/vehicle-knowledge.js";
import { SafetyGateway } from "../../src/safety/safety-gateway.js";
import { DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";
import { DemoSensorSimulator } from "../../src/vehicle/demo-sensor-simulator.js";

const NOW = Date.parse("2025-07-29T09:00:00.000Z");

function delegation({ eligibility = false, vehicleScope = "nio-es8-user-manual-2026" } = {}) {
  return createKnowledgeDelegation({
    delegationId: `delegation:executor:${eligibility ? "eligibility" : "manual"}`,
    runId: `executor-${eligibility ? "eligibility" : "manual"}`,
    parentPlanId: "plan:executor",
    parentStepId: "delegate-knowledge",
    knowledgeGoal: "解释 ES8 尾门开启条件",
    vehicleScope,
    allowedCapabilities: eligibility
      ? ["knowledge.manual.retrieve", "knowledge.vehicle-state.read", "knowledge.safety.evaluate", "knowledge.answer.synthesize"]
      : ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
    allowVehicleStateRead: eligibility,
    requireSafetyEligibilityExplanation: eligibility,
    expectedAnswerContract: "KnowledgeAnswer",
    dependsOn: [],
  });
}

function subplan(activeDelegation, { eligibility = false } = {}) {
  const steps = [{
    stepId: "manual",
    capabilityId: "knowledge.manual.retrieve",
    dependsOn: [],
    input: { query: eligibility ? "ES8 尾门 开启 安全" : activeDelegation.knowledgeGoal },
    expectedOutput: "manual-evidence",
    accessMode: "read",
    status: "planned",
  }];
  if (eligibility) {
    steps.push({
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
      expectedOutput: "safety-assessment",
      accessMode: "read",
      status: "planned",
    });
  }
  steps.push({
    stepId: "answer",
    capabilityId: "knowledge.answer.synthesize",
    dependsOn: eligibility ? ["manual", "safety"] : ["manual"],
    input: { facts: { summary: "尾门开启条件", evidenceRefs: ["manual:tailgate"] } },
    expectedOutput: "knowledge-answer",
    accessMode: "read",
    status: "planned",
  });
  return createKnowledgeSubplan({
    subplanId: `subplan:${activeDelegation.runId}`,
    delegationId: activeDelegation.delegationId,
    runId: activeDelegation.runId,
    parentPlanId: activeDelegation.parentPlanId,
    parentStepId: activeDelegation.parentStepId,
    steps,
    selectedCapabilities: steps.map((step) => step.capabilityId),
    planningSummary: "按只读知识能力执行。",
    model: "qwen2.5:7b",
    provider: "ollama",
    status: "planned",
  });
}

function safeValues() {
  return {
    batteryPercent: 80,
    speedKph: 0,
    gear: "P",
    rearClearance: true,
    windowAntiPinchAvailable: true,
    rainDetected: false,
    driverBackrestAngle: 100,
  };
}

function stateFromSimulator({ values = safeValues(), mode = "success", patch = {}, capturedAt = NOW } = {}) {
  const simulator = new DemoSensorSimulator({
    now: () => new Date(capturedAt),
    initialVehicleState: values,
  });
  const provider = new DevVehicleStateProvider();
  const reading = simulator.readVehicleState(patch, { mode });
  const ingestion = provider.ingestDemoSensorState(reading);
  assert.equal(ingestion.ok, true, "Demo Sensor reading must form the Provider snapshot");
  return { provider, snapshot: provider.getSnapshot() };
}

function manualChunk() {
  return {
    chunkId: "manual:tailgate",
    sourceId: "nio-es8-user-manual-2026",
    sourceVersion: "2026",
    title: "ES8 用户手册",
    citation: "尾门章节",
    pageStart: 120,
    pageEnd: 120,
    excerpt: "开启尾门前应确认开闭路径附近没有障碍物。",
    text: "开启尾门前应确认开闭路径附近没有障碍物。",
    score: { retrieval: 0.87, rerank: null, grounding: null },
  };
}

function manualChunksWithStatus(status) {
  const chunks = [];
  Object.defineProperty(chunks, "metadata", {
    enumerable: false,
    value: Object.freeze({ status }),
  });
  return chunks;
}

function dependencies(callOrder, { provider, snapshot: stateSnapshot }, safetyGateway = new SafetyGateway({}, { now: () => NOW })) {
  const counts = { provider: 0, safety: 0 };
  return {
    counts,
    manualRetriever: async (query) => {
      callOrder.push("manual.retrieve");
      assert.equal(query, "ES8 尾门 开启 安全");
      return [manualChunk()];
    },
    refreshVehicleState: async () => ({ ok: true, snapshot: provider.getSnapshot() }),
    readVehicleStateSnapshot() {
        counts.provider += 1;
        callOrder.push("vehicle-state.read");
        return provider.getSnapshot();
    },
    safetyGateway: {
      evaluate(command, context) {
        counts.safety += 1;
        callOrder.push("safety.evaluate");
        assert.equal(command.intent, "body.tailgate.open");
        assert.deepEqual(command.slots, { open: true });
        assert.deepEqual(command.slotProvenance, { open: "explicit" });
        assert.equal(context.vehicleStateSnapshot, stateSnapshot, "Safety must receive the exact Provider snapshot");
        return safetyGateway.evaluate(command, context);
      },
    },
  };
}

function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

{
  const callOrder = [];
  const activeDelegation = delegation();
  const measurementTicks = [10, 37];
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation),
    manualRetriever: async () => {
      callOrder.push("manual.retrieve");
      return [manualChunk()];
    },
    vehicleStateProvider: { getSnapshot: () => { throw new Error("static plan must not read Provider"); } },
    safetyGateway: { evaluate: () => { throw new Error("static plan must not reach Safety"); } },
    now: () => NOW,
    monotonicNow: () => measurementTicks.shift(),
  });
  assert.deepEqual(callOrder, ["manual.retrieve"], "static knowledge must call only Manual RAG");
  assert.equal(result.outcomeStatus, "completed");
  assert.deepEqual(result.evidenceRefs, [{
    sourceId: "nio-es8-user-manual-2026",
    sourceVersion: "2026",
    chunkId: "manual:tailgate",
    pageStart: 120,
    pageEnd: 120,
    excerpt: "开启尾门前应确认开闭路径附近没有障碍物。",
    score: { retrieval: 0.87, rerank: null, grounding: null },
  }]);
  assert.equal(result.vehicleStateRef, null);
  assert.equal(result.safetyAssessment, null);
  assert.equal(result.vehicleToolCalls, 0);
  assert.equal(getManualRetrievalDuration(result), 27);
  assert.equal(Object.hasOwn(result, "manualRetrievalDurationMs"), false);
  assertDeepFrozen(result);
}

for (const [label, chunks, expectedOutcome, expectedDuration] of [
  ["miss", [], "completed", 9],
  ["unavailable", manualChunksWithStatus("unavailable"), "unavailable", 14],
]) {
  const activeDelegation = delegation();
  const ticks = label === "miss" ? [20, 29] : [30, 44];
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation),
    manualRetriever: async () => chunks,
    now: () => NOW,
    monotonicNow: () => ticks.shift(),
  });
  assert.equal(result.outcomeStatus, expectedOutcome, label);
  assert.equal(getManualRetrievalDuration(result), expectedDuration, label);
  assert.equal(Object.hasOwn(result, "manualRetrievalDurationMs"), false, label);
}

{
  const activeDelegation = delegation();
  const ticks = [50, 69];
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation),
    manualRetriever: async () => { throw new Error("PRIVATE_MANUAL_FAILURE"); },
    now: () => NOW,
    monotonicNow: () => ticks.shift(),
  });
  assert.equal(result.outcomeStatus, "unavailable");
  assert.equal(getManualRetrievalDuration(result), 19);
  assert.equal(Object.hasOwn(result, "manualRetrievalDurationMs"), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MANUAL_FAILURE/);
}

for (const [label, values, safetyAction] of [
  ["safe", safeValues(), "allow"],
  ["unsafe", { ...safeValues(), speedKph: 12, gear: "D", rearClearance: false }, "reject"],
]) {
  const callOrder = [];
  const activeDelegation = delegation({ eligibility: true });
  const state = stateFromSimulator({ values });
  const { counts, ...runtimeDependencies } = dependencies(callOrder, state);
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation, { eligibility: true }),
    ...runtimeDependencies,
    now: () => NOW,
  });
  assert.deepEqual(callOrder, ["manual.retrieve", "vehicle-state.read", "safety.evaluate"]);
  assert.equal(result.outcomeStatus, "completed");
  assert.equal(result.safetyAssessment.action, safetyAction, `${label} Safety action must be preserved exactly`);
  assert.equal(result.safetyAssessmentRef.action, safetyAction);
  assert.equal(Object.hasOwn(result.safetyAssessmentRef, "manualEvidence"), false,
    "synthesis-facing Safety reference must not duplicate full Manual evidence");
  assert.equal(result.evidence[0].excerpt, "开启尾门前应确认开闭路径附近没有障碍物。");
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.ok(result.evidence.every(({ excerpt }) => excerpt.length <= 320));
  assert.equal(result.vehicleStateRef.snapshotId, state.snapshot.id);
  assert.equal(counts.provider, 1, "Provider must be read exactly once at its owned step");
  assert.equal(counts.safety, 1);
  assert.equal(result.vehicleToolCalls, 0);
}

{
  const stepNow = NOW + 100_000;
  const activeDelegation = delegation({ eligibility: true });
  const stale = stateFromSimulator({ capturedAt: NOW });
  const simulator = new DemoSensorSimulator({
    now: () => new Date(stepNow),
    initialVehicleState: safeValues(),
  });
  let refreshedSnapshot = null;
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation, { eligibility: true }),
    manualRetriever: async () => [manualChunk()],
    refreshVehicleState: async () => {
      const ingestion = stale.provider.ingestDemoSensorState(simulator.readVehicleState());
      refreshedSnapshot = ingestion.snapshot;
      return ingestion;
    },
    readVehicleStateSnapshot: () => stale.provider.getSnapshot(),
    vehicleStateProvider: stale.provider,
    safetyGateway: new SafetyGateway({}, { now: () => stepNow }),
    now: () => stepNow,
  });
  assert.equal(result.outcomeStatus, "completed", "step-time sensor refresh must replace a snapshot made stale by LLM latency");
  assert.equal(result.vehicleStateRef.snapshotId, refreshedSnapshot.id);
  assert.equal(result.safetyAssessment.vehicleStateSnapshotId, refreshedSnapshot.id);
  assert.equal(result.safetyAssessment.vehicleStateAudit.snapshotId, refreshedSnapshot.id);
  assert.equal(result.vehicleToolCalls, 0);
}

{
  const callOrder = [];
  const activeDelegation = delegation({ eligibility: true });
  const state = stateFromSimulator();
  const { counts, ...runtimeDependencies } = dependencies(callOrder, state);
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation, { eligibility: true }),
    ...runtimeDependencies,
    safetyGateway: {
      evaluate() {
        callOrder.push("safety.evaluate");
        return { allowed: true, action: "allow", vehicleStateSnapshotId: "snapshot:replacement" };
      },
    },
    now: () => NOW,
  });
  assert.equal(result.outcomeStatus, "unavailable", "Safety must not replace the Provider snapshot identity");
  assert.equal(counts.provider, 1);
  assert.equal(result.vehicleToolCalls, 0);
}

for (const [label, makeAssessment] of [
  ["missing allowed", (snapshotId) => ({ action: "allow", vehicleStateSnapshotId: snapshotId })],
  ["missing snapshot identity", () => ({ allowed: true, action: "allow" })],
  ["only vehicleStateSnapshotId", (snapshotId) => ({
    allowed: true, action: "allow", vehicleStateSnapshotId: snapshotId,
  })],
  ["only vehicleStateAudit snapshotId", (snapshotId) => ({
    allowed: true, action: "allow", vehicleStateAudit: { snapshotId },
  })],
  ["conflicting snapshot identities", (snapshotId) => ({
    allowed: true,
    action: "allow",
    vehicleStateSnapshotId: snapshotId,
    vehicleStateAudit: { snapshotId: "snapshot:replacement" },
  })],
]) {
  const callOrder = [];
  const activeDelegation = delegation({ eligibility: true });
  const state = stateFromSimulator();
  const assessment = makeAssessment(state.snapshot.id);
  const { counts, ...runtimeDependencies } = dependencies(callOrder, state);
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation, { eligibility: true }),
    ...runtimeDependencies,
    safetyGateway: {
      evaluate() {
        callOrder.push("safety.evaluate");
        return assessment;
      },
    },
    now: () => NOW,
  });
  assert.equal(result.outcomeStatus, "unavailable", `${label} must fail closed`);
  assert.equal(counts.provider, 1);
  assert.equal(result.vehicleToolCalls, 0);
}

for (const [label, state] of [
  ["unknown", stateFromSimulator({ values: { ...safeValues(), speedKph: null, gear: null, rearClearance: null } })],
  ["stale", stateFromSimulator({ capturedAt: NOW - 6_000 })],
  ["sensor-fault", stateFromSimulator({ mode: "sensor-fault", patch: { speedKph: null, gear: null, rearClearance: null } })],
]) {
  const callOrder = [];
  const activeDelegation = delegation({ eligibility: true });
  const { counts, ...runtimeDependencies } = dependencies(callOrder, state);
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation, { eligibility: true }),
    ...runtimeDependencies,
    now: () => NOW,
  });
  assert.equal(result.outcomeStatus, "unavailable", `${label} Provider state must fail closed for current eligibility`);
  assert.equal(result.vehicleToolCalls, 0);
  assert.equal(counts.provider, 1, `${label} Provider must still be read once`);
  assert.equal(callOrder.includes("safety.evaluate"), false, `${label} state must not reach Safety`);
}

{
  const callOrder = [];
  const activeDelegation = delegation({ eligibility: true });
  const state = stateFromSimulator();
  const { counts, ...runtimeDependencies } = dependencies(callOrder, state);
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation, { eligibility: true }),
    ...runtimeDependencies,
    readVehicleStateSnapshot() {
        callOrder.push("vehicle-state.read");
        throw new Error("Provider unavailable");
    },
    now: () => NOW,
  });
  assert.equal(result.outcomeStatus, "unavailable");
  assert.equal(result.reasonCode, "vehicle-state-unavailable");
  assert.equal(result.vehicleToolCalls, 0);
  assert.equal(counts.provider, 0, "replacement unavailable Provider owns the only read");
  assert.equal(callOrder.includes("safety.evaluate"), false);
}

{
  const activeDelegation = delegation({ eligibility: true });
  let providerReads = 0;
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation, { eligibility: true }),
    manualRetriever: async () => [manualChunk()],
    refreshVehicleState: async () => ({ ok: false, reason: "sensor-refresh-failed" }),
    readVehicleStateSnapshot: () => {
      providerReads += 1;
      return null;
    },
    safetyGateway: { evaluate: () => { throw new Error("refresh failure must not reach Safety"); } },
    now: () => NOW,
  });
  assert.equal(result.outcomeStatus, "unavailable");
  assert.equal(result.reasonCode, "vehicle-state-unavailable");
  assert.equal(providerReads, 0, "failed refresh must not read or reuse the prior Provider snapshot");
  assert.equal(result.vehicleToolCalls, 0);
}

{
  const activeDelegation = delegation({ eligibility: true });
  const state = stateFromSimulator();
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation, { eligibility: true }),
    manualRetriever: async () => [manualChunk()],
    refreshVehicleState: async () => ({ ok: true, snapshot: state.snapshot }),
    readVehicleStateSnapshot: () => structuredClone(state.snapshot),
    safetyGateway: { evaluate: () => { throw new Error("non-Provider snapshot identity must not reach Safety"); } },
    now: () => NOW,
  });
  assert.equal(result.outcomeStatus, "unavailable");
  assert.equal(result.reasonCode, "vehicle-state-unavailable");
  assert.equal(result.vehicleToolCalls, 0);
}

{
  const callOrder = [];
  const activeDelegation = delegation({ vehicleScope: "nio-et5-user-manual-2026" });
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation),
    manualRetriever: async () => { throw new Error("off-scope must not retrieve"); },
    vehicleStateProvider: { getSnapshot: () => { throw new Error("off-scope must not read Provider"); } },
    safetyGateway: { evaluate: () => { throw new Error("off-scope must not reach Safety"); } },
    now: () => NOW,
  });
  assert.equal(result.outcomeStatus, "not-applicable");
  assert.deepEqual(callOrder, [], "off-scope execution must not call RAG, Provider, or Safety");
  assert.equal(result.vehicleToolCalls, 0);
}

{
  const callOrder = [];
  let forbiddenOwnerReads = 0;
  const forbiddenOwner = new Proxy({}, {
    get() {
      forbiddenOwnerReads += 1;
      throw new Error("deterministic execution must not read a model or Agent owner");
    },
  });
  const activeDelegation = delegation({ eligibility: true });
  const state = stateFromSimulator();
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation, { eligibility: true }),
    manualRetriever: async (_query, input) => {
      callOrder.push("manual.retrieve");
      assert.equal(input.signal, undefined);
      return [manualChunk()];
    },
    refreshVehicleState: async () => {
      callOrder.push("vehicle-state.refresh");
      return { ok: true, snapshot: state.snapshot };
    },
    readVehicleStateSnapshot: () => {
      callOrder.push("vehicle-state.read");
      return state.provider.getSnapshot();
    },
    safetyGateway: {
      evaluate(command, context) {
        callOrder.push("safety.evaluate");
        return new SafetyGateway({}, { now: () => NOW }).evaluate(command, context);
      },
    },
    modelAdapter: forbiddenOwner,
    orchestratorController: forbiddenOwner,
    cabinAssistantController: forbiddenOwner,
    now: () => NOW,
  });
  assert.deepEqual(callOrder, [
    "manual.retrieve",
    "vehicle-state.refresh",
    "vehicle-state.read",
    "safety.evaluate",
  ]);
  assert.equal(forbiddenOwnerReads, 0, "execution must have zero model/Agent owner reads");
  assert.equal(Object.hasOwn(result, "agentOwner"), false);
  assert.equal(Object.hasOwn(result, "modelCall"), false);
}

{
  const activeDelegation = delegation();
  let ordinaryRetrievals = 0;
  const candidateChunks = Object.freeze(Object.assign([manualChunk()], {
    metadata: Object.freeze({ status: "hit", runId: activeDelegation.runId }),
  }));
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation),
    manualRetriever: async () => {
      ordinaryRetrievals += 1;
      throw new Error("exact candidate must suppress ordinary retrieval");
    },
    manualRetrievalCandidate: Object.freeze({
      async consume(binding) {
        assert.deepEqual(binding, {
          runId: activeDelegation.runId,
          query: activeDelegation.knowledgeGoal,
          vehicleModel: "ES8",
        });
        return Object.freeze({ result: candidateChunks, durationMs: 5000 });
      },
      discard() { return false; },
    }),
  });
  assert.equal(result.outcomeStatus, "completed");
  assert.equal(ordinaryRetrievals, 0);
  assert.equal(getManualRetrievalDuration(result), 5000);
}

{
  const activeDelegation = delegation();
  let ordinaryRetrievals = 0;
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation),
    manualRetriever: async () => {
      ordinaryRetrievals += 1;
      return [manualChunk()];
    },
    manualRetrievalCandidate: Object.freeze({
      async consume() {
        const error = new Error("binding mismatch");
        error.code = "manual-retrieval-candidate-mismatch";
        throw error;
      },
      discard() { return false; },
    }),
  });
  assert.equal(result.outcomeStatus, "completed");
  assert.equal(ordinaryRetrievals, 1, "binding mismatch must use one canonical retrieval");
}

{
  const activeDelegation = delegation();
  let ordinaryRetrievals = 0;
  const unavailable = Object.freeze(Object.assign([], {
    metadata: Object.freeze({
      status: "unavailable",
      runId: activeDelegation.runId,
      reason: "manual-rag-unavailable",
    }),
  }));
  const result = await executeKnowledgeSubplan({
    delegation: activeDelegation,
    subplan: subplan(activeDelegation),
    manualRetriever: async () => {
      ordinaryRetrievals += 1;
      return [manualChunk()];
    },
    manualRetrievalCandidate: Object.freeze({
      async consume() {
        return Object.freeze({ result: unavailable, durationMs: 3000 });
      },
      discard() { return false; },
    }),
  });
  assert.equal(result.outcomeStatus, "unavailable");
  assert.equal(result.reasonCode, "manual-rag-unavailable");
  assert.equal(ordinaryRetrievals, 0, "exact unavailable candidate must not duplicate retrieval");
  assert.equal(getManualRetrievalDuration(result), 3000);
}

function abortFrom(signal, reason) {
  const error = new Error(String(reason));
  error.name = "AbortError";
  assert.equal(signal.aborted, true);
  return error;
}

{
  const controller = new AbortController();
  const activeDelegation = delegation();
  await assert.rejects(
    executeKnowledgeSubplan({
      delegation: activeDelegation,
      subplan: subplan(activeDelegation),
      signal: controller.signal,
      manualRetriever: async (_query, input) => {
        assert.equal(input.signal, controller.signal, "RAG must receive the caller AbortSignal");
        controller.abort("rag-cancelled");
        throw abortFrom(controller.signal, "rag-cancelled");
      },
    }),
    (error) => error?.name === "AbortError",
    "RAG cancellation must propagate",
  );
}

{
  const controller = new AbortController();
  const activeDelegation = delegation({ eligibility: true });
  let providerReads = 0;
  await assert.rejects(
    executeKnowledgeSubplan({
      delegation: activeDelegation,
      subplan: subplan(activeDelegation, { eligibility: true }),
      signal: controller.signal,
      manualRetriever: async () => [manualChunk()],
      refreshVehicleState: async (input) => {
        assert.equal(input.signal, controller.signal, "state refresh must receive the caller AbortSignal");
        controller.abort("state-cancelled");
        throw abortFrom(controller.signal, "state-cancelled");
      },
      readVehicleStateSnapshot: () => {
        providerReads += 1;
        return null;
      },
      safetyGateway: { evaluate: () => { throw new Error("cancelled state must not reach Safety"); } },
    }),
    (error) => error?.name === "AbortError",
    "state cancellation must propagate",
  );
  assert.equal(providerReads, 0);
}

{
  const controller = new AbortController();
  const activeDelegation = delegation({ eligibility: true });
  const state = stateFromSimulator();
  await assert.rejects(
    executeKnowledgeSubplan({
      delegation: activeDelegation,
      subplan: subplan(activeDelegation, { eligibility: true }),
      signal: controller.signal,
      manualRetriever: async () => [manualChunk()],
      refreshVehicleState: async () => ({ ok: true, snapshot: state.snapshot }),
      readVehicleStateSnapshot: () => state.provider.getSnapshot(),
      safetyGateway: {
        async evaluate(_command, context) {
          assert.equal(context.signal, controller.signal, "Safety must receive the caller AbortSignal");
          controller.abort("safety-cancelled");
          throw abortFrom(controller.signal, "safety-cancelled");
        },
      },
      now: () => NOW,
    }),
    (error) => error?.name === "AbortError",
    "Safety cancellation must propagate",
  );
}

console.log("vehicle knowledge execution verification passed");
