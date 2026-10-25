import { launchChromium } from "../lib/playwright-loader.mjs";
import {
  assertNoRuntimeExecutionPath,
  createHmiVehicleSluFixtureResponse,
  createHmiVehicleSluFrame,
  loadHmiVehicleSluFixtureProfile,
} from "../lib/hmi-test-helpers.mjs";
const baseUrl = process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173";
const screenshotPath = "/tmp/nio-hmi-manual-eligibility.png";
const commandText = "请查用户手册：ES6 的尾门怎么应急打开？";
const runTimeoutMs = 90_000;
const presentationTimeoutMs = 10_000;

const browser = await launchChromium();
const page = await browser.newPage();
try {
  const vehicleSluProfile = await loadHmiVehicleSluFixtureProfile(baseUrl);
  await page.route("**/api/local-semantic", async (route) => {
    const request = route.request().postDataJSON();
    const query = "ES6 的尾门怎么应急打开？";
    const response = createHmiVehicleSluFixtureResponse({
      profile: vehicleSluProfile,
      requestId: request.requestId,
      conversationGoal: { summary: query, need: "explain" },
      vehicleFrames: [createHmiVehicleSluFrame({
        frameId: "manual-es6-boundary",
        capability: "knowledge",
        intent: "vehicle.knowledge.query",
        speechAct: "question",
        knowledgeNeed: "manual",
        slots: { query, vehicleModel: "ES6" },
        standaloneQuery: query,
      })],
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const previousRequestId = await page.evaluate(() => window.__runtimeDebug?.()?.latestRun?.requestId || null);
  await page.locator("#commandInput").fill(commandText);
  await page.locator("#runButton").click();
  await page.waitForFunction((requestId) => {
    const debug = window.__runtimeDebug?.();
    return debug?.currentRun === null
      && debug?.latestRun?.requestId
      && debug.latestRun.requestId !== requestId;
  }, previousRequestId, { timeout: runTimeoutMs });
  const card = page.locator('[data-testid="run-detail-card"][data-card-kind="manual-conversation-evidence"]');
  await card.waitFor({ state: "visible", timeout: presentationTimeoutMs });
  await page.waitForFunction(() => {
    const debug = window.__runtimeDebug?.();
    const result = debug?.latestRun?.result;
    const finalEvent = debug?.latestRun?.events?.findLast?.((event) => (
      event.component === "cabinAssistant" && event.phase === "final-response"
    ));
    return result?.semanticEnvelope?.vehicleFrames?.[0]?.slots?.vehicleModel === "ES6"
      && result.manualQueryPlan === null
      && result.manualEvidence === null
      && finalEvent?.status === "unavailable";
  }, undefined, { timeout: presentationTimeoutMs });

  const cardText = await card.innerText();
  const runtimeDebug = await page.evaluate(() => window.__runtimeDebug?.());
  if (!runtimeDebug?.detailCards?.some((item) => item.cardKind === "manual-conversation-evidence")) {
    throw new Error("window.__runtimeDebug did not expose manual-conversation-evidence detail card.");
  }
  const runResult = runtimeDebug?.latestRun?.result || runtimeDebug?.lastRuntimeResult || {};
  for (const expected of [
    "未触发",
    "Accepted EvidenceRef\n0",
    "Query Plan：unavailable",
    "none / none / topK --",
    "本状态不生成用户手册链接",
  ]) {
    if (!cardText.includes(expected)) throw new Error(`Missing HMI eligibility evidence in manual card: ${expected}`);
  }
  if (runResult.semanticEnvelope?.vehicleFrames?.[0]?.slots?.vehicleModel !== "ES6"
    || runResult.manualQueryPlan !== null
    || runResult.manualEvidence !== null) {
    throw new Error(`Unexpected non-ES8 knowledge boundary: ${JSON.stringify(runResult)}`);
  }
  assertNoRuntimeExecutionPath(runResult, "Inapplicable manual query");
  if (await page.locator('#assistantText a[data-testid="manual-primary-evidence-link"]').count()) {
    throw new Error("Inapplicable manual query must not expose a manual evidence link.");
  }
  const answerText = await page.locator("#assistantText").innerText();
  if (!answerText.includes("仅接入 ES8") || !answerText.includes("未使用 ES8 手册")) {
    throw new Error(`Non-ES8 boundary answer was not rendered: ${answerText}`);
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    command: commandText,
    screenshotPath,
    checks: {
      vehicleSluFixture: "nio-vehicle-slu-contract@2.0.0",
      modelScopeBoundary: "not-applicable",
      queryPlanNotCreated: true,
      manualRetrievalNotRequested: true,
      evidenceCountZero: true,
      noToolCall: true,
      noSafetyDecision: true,
      noVehicleTool: true,
      noManualEvidenceLink: true,
      stableCardKind: "manual-conversation-evidence",
      runtimeDebugDetailCards: true,
    },
  }, null, 2));
} catch (error) {
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ ok: false, baseUrl, command: commandText, screenshotPath, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
