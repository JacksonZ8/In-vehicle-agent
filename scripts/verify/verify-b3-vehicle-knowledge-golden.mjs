import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CabinAssistantController } from "../../src/agents/cabin-assistant-controller.js";
import { OrchestratorController } from "../../src/agents/orchestrator-controller.js";
import { executeKnowledgeSubplan } from "../../src/application/use-cases/vehicle-knowledge-execution.js";
import {
  createKnowledgeAnswer,
  createKnowledgeDelegation,
  createKnowledgeSubplan,
  createKnowledgeTerminalResult,
} from "../../src/application/contracts/vehicle-knowledge.js";
import { SafetyGateway } from "../../src/safety/safety-gateway.js";
import { DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";
import { DemoSensorSimulator } from "../../src/vehicle/demo-sensor-simulator.js";
import { retrieveManualChunks } from "../../src/manual/manual-rag-retriever.js";

const root = new URL("../../", import.meta.url);
const modelTimeoutMs = 90_000;
const scenarioTimeoutMs = 90_000;
const totalTimeoutMs = 360_000;
const hmiTimeoutMs = 240_000;
const scenarioIds = Object.freeze([
  "static-manual",
  "strict-api-hit",
  "manual-rag-unavailable",
  "eligibility-safe",
  "eligibility-unsafe",
  "eligibility-not-current",
  "partial-evidence",
  "unsupported-no-evidence",
  "non-es8-not-applicable",
  "model-unavailable",
  "provider-unavailable",
  "safety-unavailable",
]);
const behaviorScenarioGroups = Object.freeze({
  "simple-manual": Object.freeze(["static-manual", "partial-evidence"]),
  "vehicle-state": Object.freeze(["strict-api-hit", "provider-unavailable"]),
  "non-es8": Object.freeze(["non-es8-not-applicable"]),
  "rag-miss": Object.freeze(["unsupported-no-evidence"]),
  "safety-eligibility": Object.freeze([
    "eligibility-safe",
    "eligibility-unsafe",
    "eligibility-not-current",
    "safety-unavailable",
  ]),
  "retrieval-unavailable": Object.freeze(["manual-rag-unavailable"]),
  "model-boundary": Object.freeze(["model-unavailable"]),
});

function boundedDiagnostic({ stage, scenario, result = {}, telemetry = {}, selectedCapabilities = [] } = {}) {
  return {
    stage: stage || null,
    scenario: scenario || null,
    outcomeStatus: result?.outcomeStatus || null,
    supportStatus: result?.supportStatus || null,
    modelDurationMs: Number.isFinite(telemetry?.durationMs) ? telemetry.durationMs : null,
    reasonCode: result?.reasonCode || telemetry?.reason || null,
    validationSubreason: telemetry?.validationSubreason || null,
    selectedSpecialistCapabilities: Array.isArray(selectedCapabilities)
      ? selectedCapabilities.slice(0, 4)
      : [],
    snapshotIdentityPresent: Boolean(
      result?.vehicleStateRef?.snapshotId
      || result?.vehicleStateRefs?.some?.((reference) => reference?.snapshotId)
      || result?.safetyAssessmentRef?.vehicleStateSnapshotId,
    ),
    safetyAction: result?.safetyAssessmentRef?.action || result?.safetyAssessment?.action || null,
  };
}

function assertBoundedDiagnostic(diagnostic) {
  assert.deepEqual(Object.keys(diagnostic), [
    "stage", "scenario", "outcomeStatus", "supportStatus", "modelDurationMs",
    "reasonCode", "validationSubreason", "selectedSpecialistCapabilities",
    "snapshotIdentityPresent", "safetyAction",
  ]);
  assert.equal(JSON.stringify(diagnostic).match(/prompt|raw.?model|chain.?of.?thought|authorization|secret/i), null);
}

class GoldenFailure extends Error {
  constructor(diagnostic, cause) {
    super("B3 vehicle knowledge golden scenario failed");
    this.diagnostic = diagnostic;
    this.cause = cause;
  }
}

async function withinTimeout(stage, operation, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function manualChunk(id, title = "ES8 用户手册") {
  return Object.freeze({
    chunkId: id,
    sourceId: "nio-es8-user-manual-2026",
    sourceVersion: "2026",
    title,
    citation: "尾门章节",
    pageStart: 62,
    pageEnd: 63,
    excerpt: `仅此证据可确认：${id} 对应的尾门路径必须无障碍物。`,
    text: `仅此证据可确认：${id} 对应的尾门路径必须无障碍物。`,
    score: Object.freeze({ retrieval: 0.81, rerank: null, grounding: null }),
  });
}

function strictManualRef() {
  return Object.freeze({
    sourceId: "nio-es8-user-manual-2026",
    sourceVersion: "2026",
    chunkId: "es8-manual-chunk-0052",
    pageStart: 62,
    pageEnd: 63,
    excerpt: "打开或关闭尾门前，请确认尾门的开/闭路径附近无障碍物。",
    score: Object.freeze({ retrieval: 0.81, rerank: null, grounding: null }),
  });
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

function createDelegation(scenario, { eligibility = false, scope = "nio-es8-user-manual-2026" } = {}) {
  return createKnowledgeDelegation({
    delegationId: `delegation:golden:${scenario}`,
    runId: `golden:${scenario}`,
    parentPlanId: `plan:golden:${scenario}`,
    parentStepId: "delegate-knowledge",
    knowledgeGoal: eligibility ? "ES8 尾门现在是否满足开启条件" : "解释 ES8 尾门开启条件",
    vehicleScope: scope,
    allowedCapabilities: eligibility
      ? ["knowledge.manual.retrieve", "knowledge.vehicle-state.read", "knowledge.safety.evaluate", "knowledge.answer.synthesize"]
      : ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
    allowVehicleStateRead: eligibility,
    requireSafetyEligibilityExplanation: eligibility,
    expectedAnswerContract: "KnowledgeAnswer",
    dependsOn: [],
  });
}

function createSubplan(delegation, { eligibility = false } = {}) {
  const steps = [{
    stepId: "manual",
    capabilityId: "knowledge.manual.retrieve",
    dependsOn: [],
    input: { query: eligibility ? "ES8 尾门 开启 安全" : delegation.knowledgeGoal },
    expectedOutput: "manual-evidence",
    accessMode: "read",
    status: "planned",
  }];
  if (eligibility) steps.push({
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
  steps.push({
    stepId: "answer",
    capabilityId: "knowledge.answer.synthesize",
    dependsOn: eligibility ? ["manual", "safety"] : ["manual"],
    input: { facts: { summary: "基于实际完成的手册与当前状态证据回答。", evidenceRefs: [] } },
    expectedOutput: "knowledge-answer",
    accessMode: "read",
    status: "planned",
  });
  return createKnowledgeSubplan({
    subplanId: `subplan:${delegation.runId}`,
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    parentPlanId: delegation.parentPlanId,
    parentStepId: delegation.parentStepId,
    steps,
    selectedCapabilities: steps.map((step) => step.capabilityId),
    planningSummary: "只读检索、状态读取和 Safety 资格评估。",
    model: "golden-fixture",
    provider: "golden-fixture",
    status: "planned",
  });
}

function createFixtureAdapter({ subplan, supportStatus = "supported", failPlanning = null, failSynthesis = null } = {}) {
  return Object.freeze({
    async createTaskPlan() { throw new Error("general task planning must not be reached"); },
    async formGoal() { throw new Error("goal formation must not be reached"); },
    async synthesizeAgentResponse() { throw new Error("general synthesis must not be reached"); },
    async createVehicleKnowledgeSubplan() {
      if (failPlanning) throw failPlanning;
      return { output: subplan, telemetry: { model: "golden-fixture", provider: "fixture", durationMs: 1, degraded: false, reason: "", validationSubreason: "" } };
    },
    async synthesizeVehicleKnowledgeAnswer({ delegation, executionFacts }) {
      if (failSynthesis) throw failSynthesis;
      return {
        output: createKnowledgeAnswer({
          delegationId: delegation.delegationId,
          runId: delegation.runId,
          outcomeStatus: "answered",
          supportStatus,
          answer: supportStatus === "unsupported"
            ? "当前手册没有可靠证据支持该问题。"
            : executionFacts.evidence?.[0]?.excerpt || "当前没有可用于回答的手册正文。",
          evidenceRefs: executionFacts.evidenceRefs,
          vehicleStateRefs: executionFacts.vehicleStateRefs,
          safetyAssessmentRef: executionFacts.safetyAssessmentRef,
          limitations: supportStatus === "partial" ? ["手册仅覆盖可确认的部分。"] : [],
          model: "golden-fixture",
          provider: "fixture",
          durationMs: 1,
          degraded: false,
        }),
        telemetry: { model: "golden-fixture", provider: "fixture", durationMs: 1, degraded: false, reason: "", validationSubreason: "" },
      };
    },
  });
}

function createProviderFromReading({ scenario, values, readPatch = values, mode = "success", stale = false }) {
  const now = Date.now();
  const simulator = new DemoSensorSimulator({ now: () => new Date(now), initialVehicleState: values });
  const provider = new DevVehicleStateProvider();
  const reading = simulator.readVehicleState(readPatch, { mode });
  const ingested = provider.ingestDemoSensorState(stale
    ? { ...reading, capturedAt: new Date(now - 6_000).toISOString() }
    : reading);
  assert.equal(ingested.ok, true, `${scenario}: DemoSensorSimulator reading must be ingested by Provider`);
  return Object.freeze({
    provider,
    get snapshot() { return provider.getSnapshot(); },
    now,
    refreshVehicleState() {
      if (stale) return { ok: true, snapshot: provider.getSnapshot() };
      return provider.ingestDemoSensorState(simulator.readVehicleState(readPatch, { mode }));
    },
    readVehicleStateSnapshot() {
      return provider.getSnapshot();
    },
  });
}

function safeState() {
  return { batteryPercent: 80, speedKph: 0, gear: "P", rearClearance: true, windowAntiPinchAvailable: true, rainDetected: false, driverBackrestAngle: 100 };
}

async function executeFixtureScenario({ scenario, eligibility = false, scope, manualRetriever, refreshVehicleState, readVehicleStateSnapshot, safetyGateway, supportStatus = "supported", failPlanning = null, failSynthesis = null, now = Date.now }) {
  const delegation = createDelegation(scenario, { eligibility, scope });
  const subplan = createSubplan(delegation, { eligibility });
  const modelAdapter = createFixtureAdapter({ subplan, supportStatus, failPlanning, failSynthesis });
  const orchestrator = new OrchestratorController({ modelAdapter, now });
  const cabin = new CabinAssistantController({ modelAdapter, now });
  const planned = failPlanning
    ? await withinTimeout("model-planning", () => orchestrator.planKnowledgeTask({
        delegation,
        complexity: "multi-target",
      }), modelTimeoutMs)
    : Object.freeze({
        subplan,
        validation: Object.freeze({ ok: true, status: "knowledge-plan-valid", errors: Object.freeze([]), plan: subplan }),
        telemetry: Object.freeze({}),
      });
  if (!planned.validation.ok) return { delegation, planned, execution: null, result: null };
  const execution = await executeKnowledgeSubplan({
    delegation,
    subplan: planned.subplan,
    manualRetriever,
    refreshVehicleState,
    readVehicleStateSnapshot,
    safetyGateway,
    now,
  });
  if (execution.outcomeStatus !== "completed") return { delegation, planned, execution, result: null };
  const synthesized = await withinTimeout("model-synthesis", () => cabin.composeKnowledgeResponse({
    delegation,
    subplan: planned.subplan,
    executionFacts: execution,
  }), modelTimeoutMs);
  return { delegation, planned, execution, result: synthesized.result, telemetry: synthesized.telemetry };
}

async function assertScenario(scenario, expectation) {
  try {
    const outcome = await withinTimeout(`scenario:${scenario}`, expectation.run, scenarioTimeoutMs);
    await expectation.assert(outcome);
    const result = outcome.result || outcome.execution || {};
    assert.equal(result.vehicleToolCalls || 0, 0, `${scenario}: Vehicle ToolCall must remain zero`);
    return outcome;
  } catch (error) {
    if (error instanceof GoldenFailure) throw error;
    const partial = error?.outcome || {};
    const diagnostic = boundedDiagnostic({
      stage: error?.stage || "scenario",
      scenario,
      result: partial.result || partial.execution || {},
      telemetry: partial.telemetry || {},
      selectedCapabilities: partial.planned?.subplan?.selectedCapabilities || [],
    });
    assertBoundedDiagnostic(diagnostic);
    throw new GoldenFailure(diagnostic, error);
  }
}

async function runOnlineGoldenSuite() {
  await assertScenario("static-manual", {
    run: async () => {
      const staticManual = await retrieveManualChunks("ES8 尾门开启条件", { topK: 5, vehicleModel: "ES8", filters: { vehicleModel: "ES8" } });
      return executeFixtureScenario({
        scenario: "static-manual",
        manualRetriever: async () => staticManual,
        provider: { getSnapshot() { throw new Error("static manual must not read Provider"); } },
        safetyGateway: { evaluate() { throw new Error("static manual must not call Safety"); } },
      });
    },
    assert: ({ execution, result }) => {
      assert.equal(execution.outcomeStatus, "completed");
      assert.ok(execution.evidenceRefs.length > 0, "static manual must retain ES8 evidence");
      assert.equal(result?.outcomeStatus, "answered");
      assert.equal(result?.supportStatus, "supported");
      assert.equal(typeof result?.answer, "string");
      assert.ok(result.answer.trim(), "static answer must be non-empty without fixing model wording");
    },
  });

  await assertScenario("strict-api-hit", {
    run: () => {
      const fixture = createProviderFromReading({ scenario: "strict-api-hit", values: safeState() });
      return executeFixtureScenario({
        scenario: "strict-api-hit",
        eligibility: true,
        manualRetriever: async () => manualApiEvidence([strictManualRef()], {
          status: "hit",
          runId: "manual-rag:strict-hit",
          retrievalMode: "vector-bge-m3",
          embeddingStatus: "embedded",
        }),
        refreshVehicleState: fixture.refreshVehicleState,
        readVehicleStateSnapshot: fixture.readVehicleStateSnapshot,
        safetyGateway: new SafetyGateway({}, { now: () => fixture.now }),
        now: () => fixture.now,
      });
    },
    assert: ({ execution, result }) => {
      assert.equal(execution.outcomeStatus, "completed");
      assert.equal(execution.safetyAssessment.manualEvidenceStatus, "hit");
      assert.equal(execution.evidenceRefs[0].sourceId, "nio-es8-user-manual-2026");
      assert.equal(execution.evidenceRefs[0].pageStart, 62);
      assert.equal(execution.evidenceRefs[0].pageEnd, 63);
      assert.match(execution.evidence[0].excerpt, /尾门.*障碍物/);
      assert.equal(typeof result?.answer, "string");
      assert.ok(result.answer.trim(), "eligibility answer must be non-empty without fixing model wording");
      assert.equal(result?.safetyAssessmentRef?.action, "allow");
    },
  });

  await assertScenario("manual-rag-unavailable", {
    run: () => executeFixtureScenario({
      scenario: "manual-rag-unavailable",
      manualRetriever: async () => manualApiEvidence([], {
        status: "unavailable",
        runId: "manual-rag:unavailable",
        retrievalMode: "vector-bge-m3",
        embeddingStatus: "unavailable",
        reason: "embedding-unavailable",
      }),
      provider: { getSnapshot() { throw new Error("unavailable manual RAG must stop before Provider"); } },
      safetyGateway: { evaluate() { throw new Error("unavailable manual RAG must stop before Safety"); } },
    }),
    assert: ({ execution, result }) => {
      assert.equal(result, null);
      assert.equal(execution.outcomeStatus, "unavailable");
      assert.equal(execution.reasonCode, "manual-rag-unavailable");
      assert.equal(execution.manualEvidenceStatus, "unavailable");
      assert.equal(execution.manualEvidenceTelemetry.reason, "embedding-unavailable");
    },
  });

  for (const [scenario, state, expectedAction] of [
    ["eligibility-safe", safeState(), "allow"],
    ["eligibility-unsafe", { ...safeState(), speedKph: 12, gear: "D", rearClearance: false }, "reject"],
  ]) {
    const fixture = createProviderFromReading({ scenario, values: state });
    await assertScenario(scenario, {
      run: () => executeFixtureScenario({
        scenario,
        eligibility: true,
        manualRetriever: async () => [manualChunk(`manual:${scenario}`)],
        refreshVehicleState: fixture.refreshVehicleState,
        readVehicleStateSnapshot: fixture.readVehicleStateSnapshot,
        safetyGateway: new SafetyGateway({}, { now: () => fixture.now }),
        now: () => fixture.now,
      }),
      assert: ({ execution, result }) => {
        assert.equal(execution.outcomeStatus, "completed");
        assert.equal(execution.vehicleStateRef.snapshotId, fixture.snapshot.id, "Safety must use the ingested Provider snapshot");
        assert.equal(execution.safetyAssessment.action, expectedAction, "Safety action must be preserved exactly");
        assert.equal(result?.safetyAssessmentRef?.action, expectedAction);
      },
    });
  }

  for (const [label, fixtureOptions] of [
    ["unknown", { values: { ...safeState(), speedKph: null, gear: null, rearClearance: null } }],
    ["stale", { values: safeState(), stale: true }],
    ["sensor-fault", {
      values: safeState(),
      readPatch: { speedKph: null, gear: null, rearClearance: null },
      mode: "sensor-fault",
    }],
  ]) {
    await assertScenario("eligibility-not-current", {
      run: () => {
        const fixture = createProviderFromReading({ scenario: label, ...fixtureOptions });
        return executeFixtureScenario({
          scenario: `eligibility-${label}`,
          eligibility: true,
          manualRetriever: async () => [manualChunk(`manual:${label}`)],
          refreshVehicleState: fixture.refreshVehicleState,
          readVehicleStateSnapshot: fixture.readVehicleStateSnapshot,
          safetyGateway: new SafetyGateway({}, { now: () => fixture.now }),
          now: () => fixture.now,
        });
      },
      assert: ({ execution }) => {
        assert.equal(execution.outcomeStatus, "unavailable", `${label}: current eligibility must fail closed`);
        assert.equal(execution.vehicleStateRef, null, `${label}: unusable snapshot must not be referenced`);
      },
    });
  }

  await assertScenario("partial-evidence", {
    run: () => executeFixtureScenario({
      scenario: "partial-evidence",
      manualRetriever: async () => [manualChunk("manual:partial")],
      provider: { getSnapshot() { throw new Error("partial manual must not read Provider"); } },
      safetyGateway: { evaluate() { throw new Error("partial manual must not call Safety"); } },
      supportStatus: "partial",
    }),
    assert: ({ result }) => assert.equal(result?.supportStatus, "partial"),
  });

  await assertScenario("unsupported-no-evidence", {
    run: () => executeFixtureScenario({
      scenario: "unsupported-no-evidence",
      manualRetriever: async () => [],
      provider: { getSnapshot() { throw new Error("unsupported manual must not read Provider"); } },
      safetyGateway: { evaluate() { throw new Error("unsupported manual must not call Safety"); } },
      supportStatus: "unsupported",
    }),
    assert: ({ result }) => {
      assert.equal(result?.outcomeStatus, "answered");
      assert.equal(result?.supportStatus, "unsupported");
      assert.equal(result?.evidenceRefs.length, 0);
    },
  });

  await assertScenario("non-es8-not-applicable", {
    run: async () => {
      const delegation = createDelegation("non-es8-not-applicable", { scope: "nio-et5-user-manual-2026" });
      const execution = await executeKnowledgeSubplan({ delegation, subplan: createSubplan(delegation), manualRetriever: async () => { throw new Error("non-ES8 must not retrieve ES8 evidence"); } });
      return { execution };
    },
    assert: ({ execution }) => {
      assert.equal(execution.outcomeStatus, "not-applicable");
      assert.deepEqual(execution.evidenceRefs, []);
      assert.deepEqual(execution.vehicleStateRefs, []);
    },
  });

  await assertScenario("model-unavailable", {
    run: async () => {
      const unavailable = await executeFixtureScenario({
        scenario: "model-unavailable",
        manualRetriever: async () => [manualChunk("manual:model")],
        provider: { getSnapshot() { throw new Error("model failure must stop before Provider"); } },
        safetyGateway: { evaluate() { throw new Error("model failure must stop before Safety"); } },
        failPlanning: Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      });
      const delegation = createDelegation("model-invalid-output");
      const invalidOutputController = new OrchestratorController({
        modelAdapter: {
          async createTaskPlan() { throw new Error("not reached"); },
          async createVehicleKnowledgeSubplan() { return { output: { injected: true }, telemetry: { durationMs: 1 } }; },
          async synthesizeVehicleKnowledgeAnswer() { throw new Error("not reached"); },
        },
      });
      const forgedAssociationController = new OrchestratorController({
        modelAdapter: {
          async createTaskPlan() { throw new Error("not reached"); },
          async createVehicleKnowledgeSubplan() { return { output: { ...createSubplan(delegation), runId: "forged-run" }, telemetry: { durationMs: 1 } }; },
          async synthesizeVehicleKnowledgeAnswer() { throw new Error("not reached"); },
        },
      });
      return {
        ...unavailable,
        invalidOutput: await invalidOutputController.planKnowledgeTask({ delegation, complexity: "multi-target" }),
        forgedAssociation: await forgedAssociationController.planKnowledgeTask({ delegation, complexity: "multi-target" }),
      };
    },
    assert: ({ planned, execution, invalidOutput, forgedAssociation }) => {
      assert.equal(planned.validation.ok, false, "model timeout must fail closed");
      assert.equal(execution, null);
      assert.equal(invalidOutput.validation.ok, false, "illegal structured model output must fail closed");
      assert.equal(forgedAssociation.validation.ok, false, "forged delegation association must fail closed");
      assert.match(forgedAssociation.validation.errors.join(" "), /runId|association/i);
    },
  });

  await assertScenario("provider-unavailable", {
    run: () => executeFixtureScenario({
      scenario: "provider-unavailable",
      eligibility: true,
      manualRetriever: async () => [manualChunk("manual:provider")],
      refreshVehicleState: async () => ({ ok: false, reason: "Provider unavailable" }),
      readVehicleStateSnapshot: () => { throw new Error("Provider unavailable"); },
      safetyGateway: { evaluate() { throw new Error("Provider failure must not reach Safety"); } },
    }),
    assert: ({ execution }) => {
      assert.equal(execution.outcomeStatus, "unavailable");
      assert.equal(execution.reasonCode, "vehicle-state-unavailable");
    },
  });

  await assertScenario("safety-unavailable", {
    run: () => {
      const fixture = createProviderFromReading({ scenario: "safety-unavailable", values: safeState() });
      return executeFixtureScenario({
        scenario: "safety-unavailable",
        eligibility: true,
        manualRetriever: async () => [manualChunk("manual:safety")],
        refreshVehicleState: fixture.refreshVehicleState,
        readVehicleStateSnapshot: fixture.readVehicleStateSnapshot,
        safetyGateway: { evaluate() { throw new Error("Safety unavailable"); } },
        now: () => fixture.now,
      });
    },
    assert: ({ execution }) => assert.equal(execution.outcomeStatus, "unavailable"),
  });
}

async function readProject(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

async function verifyContracts() {
  assert.equal(modelTimeoutMs, 90_000);
  assert.equal(scenarioTimeoutMs, 90_000);
  assert.equal(totalTimeoutMs, 360_000);
  assert.equal(hmiTimeoutMs, 240_000);
  assert.equal(scenarioIds.length, 12);
  const groupedScenarioIds = Object.values(behaviorScenarioGroups).flat();
  assert.equal(
    groupedScenarioIds.length,
    new Set(groupedScenarioIds).size,
    "a golden fixture must not appear in more than one behavior-oriented baseline group",
  );
  assert.deepEqual(
    [...groupedScenarioIds].sort(),
    [...scenarioIds].sort(),
    "every golden fixture must belong to one behavior-oriented baseline group",
  );
  const goldenSource = await readFile(new URL("./verify-b3-vehicle-knowledge-golden.mjs", import.meta.url), "utf8");
  assert.match(goldenSource, /withinTimeout\("golden-group", \(\) => runGoldenGroup\(/,
    "one golden-group deadline must enclose contracts and every scenario");
  assert.match(goldenSource, /run: async \(\) => \{\s+const staticManual = await retrieveManualChunks/s,
    "static manual retrieval must remain inside its 90s scenario operation");

  const delegation = createDelegation("contract-boundary");
  const invalidOutputController = new OrchestratorController({
    modelAdapter: {
      async createTaskPlan() { throw new Error("not reached"); },
      async createVehicleKnowledgeSubplan() {
        return { output: { injected: true }, telemetry: { durationMs: 1 } };
      },
      async synthesizeVehicleKnowledgeAnswer() { throw new Error("not reached"); },
    },
  });
  const invalidOutput = await invalidOutputController.planKnowledgeTask({ delegation, complexity: "multi-target" });
  assert.equal(invalidOutput.validation.ok, false, "invalid structured planning output must fail closed at the controller boundary");
  const forgedAssociationController = new OrchestratorController({
    modelAdapter: {
      async createTaskPlan() { throw new Error("not reached"); },
      async createVehicleKnowledgeSubplan() {
        return { output: { ...createSubplan(delegation), runId: "forged-run" }, telemetry: { durationMs: 1 } };
      },
      async synthesizeVehicleKnowledgeAnswer() { throw new Error("not reached"); },
    },
  });
  const forgedAssociation = await forgedAssociationController.planKnowledgeTask({ delegation, complexity: "multi-target" });
  assert.equal(forgedAssociation.validation.ok, false, "forged delegation association must fail closed at the validator boundary");
  assert.match(forgedAssociation.validation.errors.join(" "), /runId|association/i);

  const manifest = JSON.parse(await readProject("scripts/lib/regression-groups.json"));
  const runtimeSafety = new Set(manifest.groups?.["runtime-safety"]?.scripts || []);
  for (const script of [
    "verify-vehicle-knowledge-contract.mjs",
    "verify-vehicle-knowledge-plan-validator.mjs",
    "verify-knowledge-agent-handoff.mjs",
    "verify-vehicle-knowledge-execution.mjs",
    "verify-lean-runtime-vehicle-knowledge.mjs",
  ]) assert.equal(runtimeSafety.has(script), true, `${script} must be in runtime-safety`);
  assert.equal(new Set(manifest.groups?.online?.scripts || []).has("verify-b3-vehicle-knowledge-model-api.mjs"), true);
  assert.equal(new Set(manifest.groups?.online?.scripts || []).has("verify-b3-vehicle-knowledge-golden.mjs"), true);
  assert.equal(new Set(manifest.groups?.hmi?.scripts || []).has("verify-hmi-b3-vehicle-knowledge.mjs"), true);

  const modelVerifier = await readProject("scripts/verify/verify-b3-vehicle-knowledge-model-api.mjs");
  assert.match(modelVerifier, /modelTimeoutMs\s*=\s*90_000/);
  assert.match(modelVerifier, /Promise\.race/);
  assert.match(modelVerifier, /clearTimeout/);
  const hmiVerifier = await readProject("scripts/verify/verify-hmi-b3-vehicle-knowledge.mjs");
  assert.match(hmiVerifier, /hmiTimeoutMs\s*=\s*240_000/);
  assert.match(hmiVerifier, /Promise\.race/);
  assert.match(hmiVerifier, /clearTimeout/);
  const runner = await readProject("scripts/lib/run-regression-group.mjs");
  assert.doesNotMatch(runner, /start-local-services|restart-local-services|listen\s*\(/);

  assertBoundedDiagnostic(boundedDiagnostic({
    stage: "contract-only",
    scenario: scenarioIds[0],
    result: { outcomeStatus: "answered", supportStatus: "supported" },
    telemetry: { durationMs: 1, validationSubreason: "" },
    selectedCapabilities: ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
  }));
}

async function runGoldenGroup({ contractOnly }) {
  await verifyContracts();
  if (contractOnly) return;
  await runOnlineGoldenSuite();
}

async function main() {
  const contractOnly = process.argv.includes("--contract-only");
  await withinTimeout("golden-group", () => runGoldenGroup({ contractOnly }), totalTimeoutMs);
  if (contractOnly) {
    console.log("B3 vehicle knowledge golden contract verification passed");
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    behaviors: Object.keys(behaviorScenarioGroups),
    scenarios: scenarioIds,
    totalTimeoutMs,
  }, null, 2));
}

main().catch((error) => {
  if (error instanceof GoldenFailure) {
    console.error(JSON.stringify({ ok: false, diagnostic: error.diagnostic }, null, 2));
  } else {
    console.error(JSON.stringify({
      ok: false,
      diagnostic: boundedDiagnostic({ stage: "bootstrap", scenario: null, result: { reasonCode: "verification-failed" } }),
    }, null, 2));
  }
  process.exitCode = 1;
});
