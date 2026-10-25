import assert from "node:assert/strict";
import { launchChromium } from "../lib/playwright-loader.mjs";
import {
  assertNoHmiBootFailure,
  createHmiVehicleSluFixtureResponse,
  createHmiVehicleSluFrame,
  loadHmiVehicleSluFixtureProfile,
} from "../lib/hmi-test-helpers.mjs";
import { buildRunEventViewModel } from "../../src/app/run-event-presenter.js";
import { createRunEvent } from "../../src/runtime/run-event-protocol.js";
import {
  applyHmiPresentation,
  mapVehicleExecutionToHmi,
  reduceVehicleHmiState,
} from "../../src/vehicle/hmi-animation-adapter.js";

const hmiTimeoutMs = 240_000;
const staticOnly = process.argv.includes("--static-only");

async function withinTimeout(stage, operation, timeoutMs = hmiTimeoutMs) {
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

assert.equal(hmiTimeoutMs, 240_000);

async function captureVehiclePresentation(page) {
  return page.evaluate(() => {
    const debug = window.__vehicleDebug?.();
    return JSON.parse(JSON.stringify({
      pendingVehicleExecutionCount: debug?.pendingVehicleExecutionCount ?? null,
      pendingVehicleExecutionFingerprint: debug?.pendingVehicleExecutionFingerprint ?? null,
      vehicleRig: debug?.vehicleRig ?? null,
    }));
  });
}

const delegationId = "delegation:hmi-b3";
const subplanId = "subplan:hmi-b3";
const manualEvidenceRef = Object.freeze({
  sourceId: "manual:tailgate",
  sourceVersion: "1.0.0",
  chunkId: "chunk:tailgate:1",
  pageStart: 1,
  pageEnd: 1,
  excerpt: "ES8 尾门开启前需要确认周围安全。",
  score: Object.freeze({ retrieval: 0.96, rerank: null, grounding: 0.92 }),
});
const vehicleStateRef = Object.freeze({ id: "snapshot:hmi-b3", source: "demo-sensor-simulator" });
const safetyAssessment = Object.freeze({
  allowed: true,
  action: "allow",
  reasonCode: "safe-to-explain",
  snapshotId: vehicleStateRef.id,
  policyId: "knowledge-safety@1",
});
const event = (sequence, component, phase, parentEventId, knowledge, summary = phase) => createRunEvent({
  eventId: `event:hmi-b3:${sequence}`,
  runId: "hmi-b3",
  parentEventId,
  sequence,
  timestamp: `2026-07-29T00:00:00.${String(sequence).padStart(3, "0")}Z`,
  component,
  phase,
  status: "completed",
  summary,
  refs: [],
  model: null,
  provider: null,
  durationMs: null,
  metadata: { knowledge },
});
const events = [
  event(1, "orchestrator", "knowledge-delegation", null, {
    delegationId,
    delegation: {
      delegationId,
      runId: "hmi-b3",
      parentPlanId: "plan:hmi",
      parentStepId: "delegate",
      knowledgeGoal: "解释 ES8 尾门条件",
      vehicleScope: "ES8",
      allowedCapabilities: [
        "knowledge.manual.retrieve",
        "knowledge.vehicle-state.read",
        "knowledge.safety.assess",
        "knowledge.answer.synthesize",
      ],
      allowVehicleStateRead: true,
      requireSafetyEligibilityExplanation: true,
      expectedAnswerContract: "grounded-answer",
      dependsOn: [],
    },
  }),
  event(2, "orchestrator", "knowledge-subplanning", "event:hmi-b3:1", {
    delegationId,
    subplanId,
    validation: { ok: true },
    subplan: {
      subplanId,
      delegationId,
      runId: "hmi-b3",
      parentPlanId: "plan:hmi",
      parentStepId: "delegate",
      selectedCapabilities: [
        "knowledge.manual.retrieve",
        "knowledge.vehicle-state.read",
        "knowledge.safety.assess",
        "knowledge.answer.synthesize",
      ],
      steps: [
        { stepId: "manual", capabilityId: "knowledge.manual.retrieve", dependsOn: [], accessMode: "read", status: "planned" },
        { stepId: "state", capabilityId: "knowledge.vehicle-state.read", dependsOn: ["manual"], accessMode: "read", status: "planned" },
        { stepId: "safety", capabilityId: "knowledge.safety.assess", dependsOn: ["state"], accessMode: "read", status: "planned" },
        { stepId: "answer", capabilityId: "knowledge.answer.synthesize", dependsOn: ["safety"], accessMode: "read", status: "planned" },
      ],
      planningSummary: "依次读取手册、车辆状态、Safety 结论并合成回答。",
      status: "planned",
    },
  }),
  event(3, "manualRetriever", "knowledge-evidence", "event:hmi-b3:2", {
    delegationId, subplanId, stepId: "manual", capabilityId: "knowledge.manual.retrieve",
    dependsOnEventIds: [], outcomeStatus: "answered", retrievalStatus: "hit",
    evidenceRefs: [manualEvidenceRef],
  }),
  event(4, "vehicleStateProvider", "knowledge-state-read", "event:hmi-b3:3", {
    delegationId, subplanId, stepId: "state", capabilityId: "knowledge.vehicle-state.read",
    dependsOnEventIds: ["event:hmi-b3:3"], outcomeStatus: "answered",
    vehicleStateRefs: [vehicleStateRef],
  }),
  event(5, "safety", "knowledge-safety-assessment", "event:hmi-b3:4", {
    delegationId, subplanId, stepId: "safety", capabilityId: "knowledge.safety.assess",
    dependsOnEventIds: ["event:hmi-b3:4"], outcomeStatus: "answered",
    safetyAssessment,
  }),
  event(6, "cabinAssistant", "knowledge-answer", "event:hmi-b3:5", {
    delegationId, subplanId, stepId: "answer", capabilityId: "knowledge.answer.synthesize",
    dependsOnEventIds: ["event:hmi-b3:5"], outcomeStatus: "answered",
    evidenceRefs: [manualEvidenceRef], vehicleStateRefs: [vehicleStateRef],
    supportStatus: "supported", safetyAssessment,
  }, "尾门条件见手册。"),
];
const view = buildRunEventViewModel({ runId: "hmi-b3", status: "completed", events });
assert.equal(view.b3.vehicleKnowledge.delegation.parentPlanId, "plan:hmi");
assert.equal(view.b3.vehicleKnowledge.subplan.parentEventId, "event:hmi-b3:1");
assert.equal(view.b3.vehicleKnowledge.evidence[0].sourceId, "manual:tailgate");
assert.equal(view.b3.vehicleKnowledge.outcome.summary, "尾门条件见手册。");
assert.equal(view.b3.vehicleKnowledge.state[0].id, "snapshot:hmi-b3");
assert.equal(view.b3.vehicleKnowledge.safetyAssessment.action, "allow");
assert.equal(view.b3.vehicleKnowledge.safetyAssessment.snapshotId, "snapshot:hmi-b3");
assert.equal(view.b3.vehicleKnowledge.outcome.eventId, "event:hmi-b3:6");
assert.deepEqual(view.b3.vehicleKnowledge.outcome.dependsOnEventIds, ["event:hmi-b3:5"]);

const knowledgePresentation = mapVehicleExecutionToHmi({
  toolResult: { tool: "knowledge.answer.synthesize", commandId: "knowledge:1", executionState: "observed-succeeded" },
  vehicleStateSnapshot: { id: "snapshot:unchanged", values: { tailgateOpen: true } },
});
assert.equal(knowledgePresentation.noAnimation, true, "knowledge phase has no vehicle animation mapping");
const before = { pendingVehicleExecutionsByComponent: new Map(), confirmedVehicleStateSnapshot: { id: "snapshot:before" } };
const after = reduceVehicleHmiState(before, knowledgePresentation, { vehicleStateSnapshot: { id: "snapshot:changed" } });
assert.equal(after.accepted, false);
assert.equal(after.confirmedVehicleStateSnapshot.id, "snapshot:before");
let animationCalls = 0;
applyHmiPresentation(knowledgePresentation, { playScenarioAnimation() { animationCalls += 1; } });
assert.equal(animationCalls, 0);

console.log(JSON.stringify({
  staticHmi: true,
  eventBackedCardData: true,
  eventChain: true,
  vehicleAnimationIndependent: true,
}, null, 2));

if (!staticOnly) {
  const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
  const screenshotPath = "/tmp/nio-hmi-b3-vehicle-knowledge.png";
  let browser;
  const modelDiagnostics = [];
  try {
    await withinTimeout("b3-hmi-acceptance", async () => {
      const vehicleSluProfile = await loadHmiVehicleSluFixtureProfile(baseUrl);
      browser = await launchChromium({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
      await page.route("**/api/local-llm", async (route) => {
        const request = route.request().postDataJSON();
        const response = await route.fetch({ timeout: 100_000 });
        const payload = await response.json().catch(() => ({}));
        modelDiagnostics.push({
          task: request.task || null,
          status: response.status(),
          durationMs: payload.telemetry?.durationMs ?? null,
          reasonCode: payload.telemetry?.structuredValidationReason
            ?? payload.telemetry?.reason
            ?? null,
          validationSubreason: payload.telemetry?.structuredValidationSubreason ?? null,
          structuredRetryCount: payload.telemetry?.structuredRetryCount ?? null,
        });
        await route.fulfill({ response });
      });
      await page.route("**/api/local-semantic", async (route) => {
        const request = route.request().postDataJSON();
        const query = "ES8 尾门现在是否满足开启条件";
        const response = createHmiVehicleSluFixtureResponse({
          profile: vehicleSluProfile,
          requestId: request.requestId,
          conversationGoal: { summary: query, need: "explain" },
          vehicleFrames: [createHmiVehicleSluFrame({
            frameId: `tailgate-eligibility-${request.requestId}`,
            capability: "knowledge",
            intent: "vehicle.knowledge.query",
            speechAct: "question",
            knowledgeNeed: "manual",
            slots: {
              query,
              vehicleModel: "ES8",
              eligibilityAction: "body.tailgate.open",
            },
            standaloneQuery: query,
          })],
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(response),
        });
      });
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await assertNoHmiBootFailure(page, "B3 vehicle knowledge boot");
      assert.equal(await page.locator("#commandInput").count(), 1, "knowledge goal input is required");
      await page.locator("#developerStatePreset").selectOption("safe");
      await page.locator("#developerStateApplyPreset").click();
      await page.waitForFunction(() => {
        const values = window.__runtimeDebug?.()?.providerScenarioSnapshot?.values;
        return values?.speedKph === 0 && values?.gear === "P" && values?.rearClearance === true;
      });
      // Capture only after the ES7 model has loaded; otherwise the baseline is an empty rig.
      await page.waitForFunction(() => window.__vehicleLoadState === "loaded", null, { timeout: 60_000 });
      const vehicleBefore = await captureVehiclePresentation(page);
      const previousRequestId = await page.evaluate(() => window.__runtimeDebug?.()?.latestRun?.requestId || null);
      await page.locator("#commandInput").fill("ES8 尾门现在是否满足开启条件");
      await page.locator("#runButton").click();
      await page.waitForFunction((requestId) => {
        const debug = window.__runtimeDebug?.();
        return debug?.currentRun === null && debug?.latestRun?.requestId && debug.latestRun.requestId !== requestId;
      }, previousRequestId, { timeout: hmiTimeoutMs });
      const debug = await page.evaluate(() => window.__runtimeDebug?.());
      const result = debug?.latestRun?.result;
      const phases = new Set((debug?.events || []).map((event) => event.phase));
      for (const phase of ["knowledge-delegation", "knowledge-state-read", "knowledge-safety-assessment", "knowledge-answer"]) {
        assert.equal(phases.has(phase), true, `${phase} Run Event is required`);
      }
      const projectionText = await page.locator('[data-card-kind="b3-vehicle-knowledge"] code').innerText();
      const knowledgeProjection = JSON.parse(projectionText);
      if (knowledgeProjection.outcome?.outcomeStatus !== "answered") {
        console.error(JSON.stringify({
          b3Outcome: knowledgeProjection.outcome,
          knowledgeResult: result.knowledgeResult,
          knowledgeExecution: result.knowledgeExecution,
          modelDiagnostics,
        }, null, 2).slice(0, 8_000));
      }
      assert.ok(knowledgeProjection.evidence?.length > 0, "real Manual RAG evidence must be projected");
      assert.equal(knowledgeProjection.outcome?.outcomeStatus, "answered",
        "knowledge HMI acceptance requires an answered terminal outcome");
      assert.ok(["supported", "partial"].includes(knowledgeProjection.outcome?.supportStatus),
        "knowledge HMI acceptance requires supported or partial evidence grounding");
      assert.doesNotMatch(String(result.assistantResponse || ""), /抱歉[，,]?(我们)?暂时无法完成/,
        "successful knowledge acceptance must not render the unavailable apology");
      const snapshotId = knowledgeProjection.state?.[0]?.id;
      assert.ok(snapshotId, "Provider snapshot must be projected to the B3 card");
      assert.equal(knowledgeProjection.safetyAssessment?.snapshotId, snapshotId,
        "Safety assessment must retain the projected Provider snapshot identity");
      assert.ok(knowledgeProjection.safetyAssessment?.action, "Safety assessment action must be projected");
      assert.equal(result.toolCall, null, "knowledge HMI acceptance must not create a Vehicle ToolCall");
      assert.equal(result.toolResult, null, "knowledge HMI acceptance must not create a Vehicle ToolResult");
      const vehicleAfter = await captureVehiclePresentation(page);
      assert.deepEqual(vehicleAfter, vehicleBefore, "knowledge acceptance must not change HMI or vehicle-model presentation");
      await page.screenshot({ path: screenshotPath, fullPage: true });
    });
    console.log(JSON.stringify({
      online: true,
      screenshotPath,
      hmiTimeoutMs,
      modelDiagnostics,
    }, null, 2));
  } finally {
    await browser?.close();
  }
}
