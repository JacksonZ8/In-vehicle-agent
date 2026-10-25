import { launchChromium } from "../lib/playwright-loader.mjs";
import {
  assertNoRuntimeExecutionPath,
  createHmiVehicleSluFixtureResponse,
  createHmiVehicleSluFrame,
  loadHmiVehicleSluFixtureProfile,
} from "../lib/hmi-test-helpers.mjs";
const baseUrl = process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173";
const screenshotPath = "/tmp/nio-hmi-manual-conversation-evidence.png";
const commandText = "尾门开启时要注意什么？";

function assertMatch(text, pattern, message) {
  if (!pattern.test(text)) throw new Error(`${message}. Card text: ${text}`);
}

const browser = await launchChromium();
const page = await browser.newPage();
let fixtureStatus = null;
const userGuidePreflightRequests = [];
const manualRagRequestKinds = [];

try {
  const vehicleSluProfile = await loadHmiVehicleSluFixtureProfile(baseUrl);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/manual-rag") {
      manualRagRequestKinds.push(request.headers()["x-nio-private-manual-candidate"] === "1" ? "prefetch" : "direct");
    }
    if (request.method() === "GET" && url.pathname === "/api/userguide") {
      userGuidePreflightRequests.push(url);
    }
  });
  await page.route("**/api/local-semantic", async (route) => {
    const request = route.request().postDataJSON();
    const query = String(request.text || "").trim();
    const response = createHmiVehicleSluFixtureResponse({
      profile: vehicleSluProfile,
      requestId: request.requestId,
      conversationGoal: { summary: query, need: "explain" },
      vehicleFrames: [createHmiVehicleSluFrame({
        frameId: `manual-${request.requestId}`,
        capability: "knowledge",
        intent: "vehicle.knowledge.query",
        speechAct: "question",
        knowledgeNeed: "manual",
        slots: { query, vehicleModel: "ES8" },
        standaloneQuery: query,
      })],
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.route("**/api/manual-rag", async (route) => {
    if (!fixtureStatus) return route.continue();
    if (fixtureStatus === "unavailable") {
      return route.fulfill({ status: 503, body: "manual RAG unavailable fixture" });
    }
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runId: body.runId,
        query: body.query,
        status: "miss",
        evidence: [],
        reason: "live-verifier-miss-fixture",
      }),
    });
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const initialStatus = page.locator('[data-testid="manual-evidence-status"]');
  await initialStatus.waitFor({ state: "visible" });
  if (await initialStatus.getAttribute("data-status") !== "not_requested"
    || await page.locator('#assistantText a[data-testid="manual-primary-evidence-link"]').count()) {
    throw new Error("Initial manual evidence state must be not_requested without a link.");
  }
  await page.evaluate(() => {
    window.__manualEvidenceObservedStatuses = [];
    const record = () => {
      const statusName = document.querySelector('[data-testid="manual-evidence-status"]')
        ?.getAttribute("data-status");
      if (statusName) window.__manualEvidenceObservedStatuses.push(statusName);
    };
    new MutationObserver(record).observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    record();
  });
  await page.locator("#commandInput").fill(commandText);
  await page.locator("#runButton").click();

  const status = page.locator('[data-testid="manual-evidence-status"]');
  const card = page.locator('[data-testid="run-detail-card"][data-card-kind="manual-conversation-evidence"]');
  await card.waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForFunction(() => {
    const cardText = document.querySelector('[data-testid="run-detail-card"][data-card-kind="manual-conversation-evidence"]')?.innerText || "";
    const statusNode = document.querySelector('[data-testid="manual-evidence-status"]');
    return statusNode?.getAttribute("data-status") === "hit"
      && cardText.includes("已命中")
      && cardText.includes("vector-bge-m3");
  }, null, { timeout: 90_000 });

  if (await status.getAttribute("data-status") !== "hit") {
    throw new Error("Conversation manual evidence status did not stabilize as hit.");
  }
  const observedStatuses = await page.evaluate(() => window.__manualEvidenceObservedStatuses || []);
  // A prefetched retrieval has usually finished before the answer path consumes it, so its
  // search-started/hit transitions replay in one tick and "searching" is never rendered.
  const prefetchedOnly = manualRagRequestKinds.length > 0
    && manualRagRequestKinds.every((kind) => kind === "prefetch");
  if (!prefetchedOnly && !observedStatuses.includes("searching")) {
    throw new Error(`Manual evidence searching state was not observed: ${observedStatuses.join(",")}`);
  }
  const answerLinks = page.locator('#assistantText a[data-testid="manual-primary-evidence-link"]');
  if (await answerLinks.count() !== 1) {
    throw new Error("Conversation answer must expose exactly one primary manual evidence link.");
  }
  const href = await answerLinks.getAttribute("href");
  const target = new URL(href, baseUrl);
  if (target.pathname !== "/userguide") throw new Error(`Unexpected evidence target path: ${target.pathname}`);
  const queryKeys = [...target.searchParams.keys()];
  if (queryKeys.length !== 3
    || new Set(queryKeys).size !== 3
    || !["source", "chunk", "run"].every((key) => target.searchParams.has(key))) {
    throw new Error(`Evidence target exposed unexpected query parameters: ${target.search}`);
  }
  const cardText = await card.innerText();
  const evidenceRefs = JSON.parse(await card.locator("code[data-manual-evidence-refs]").innerText());
  if (!evidenceRefs.length || evidenceRefs.some((item) => (
    !item?.sourceId
    || !item?.chunkId
    || !item?.score
    || !Object.hasOwn(item.score, "retrieval")
    || !Object.hasOwn(item.score, "rerank")
    || !Object.hasOwn(item.score, "grounding")
  ))) {
    throw new Error("Conversation detail card did not preserve all accepted EvidenceRefs and scores.");
  }
  if (target.searchParams.get("source") !== evidenceRefs[0].sourceId
    || target.searchParams.get("chunk") !== evidenceRefs[0].chunkId) {
    throw new Error("Conversation answer link did not target rank 1 evidence.");
  }
  const matchingPreflight = userGuidePreflightRequests.find((requestUrl) => (
    requestUrl.searchParams.get("source") === evidenceRefs[0].sourceId
    && requestUrl.searchParams.get("chunk") === evidenceRefs[0].chunkId
    && requestUrl.searchParams.get("run") === target.searchParams.get("run")
    && [...requestUrl.searchParams.keys()].length === 3
    && new Set(requestUrl.searchParams.keys()).size === 3
  ));
  if (!matchingPreflight) {
    throw new Error("The hit link was shown without a matching GET /api/userguide preflight.");
  }
  const targetRunId = target.searchParams.get("run");
  await page.waitForFunction((runId) => {
    const debug = window.__runtimeDebug?.();
    return debug?.currentRun === null
      && debug?.latestRun?.requestId === runId
      && debug?.latestRun?.result?.requestId === runId;
  }, targetRunId, { timeout: 90_000 });
  const runtimeDebug = await page.evaluate(() => window.__runtimeDebug?.());
  if (!runtimeDebug?.detailCards?.some((item) => item.cardKind === "manual-conversation-evidence")) {
    throw new Error("window.__runtimeDebug did not expose manual-conversation-evidence detail card.");
  }
  const runResult = runtimeDebug?.latestRun?.result || runtimeDebug?.lastRuntimeResult || {};
  const association = await page.evaluate(() => {
    const debug = window.__runtimeDebug?.();
    return {
      debugRequestId: debug?.requestId || null,
      latestRunRequestId: debug?.latestRun?.requestId || null,
      latestResultRequestId: debug?.latestRun?.result?.requestId || null,
      lastResultRequestId: debug?.lastRuntimeResult?.requestId || null,
      assistantRunId: document.querySelector("#assistantText")?.dataset?.runId || null,
    };
  });
  if (!runResult.requestId
    || [
      targetRunId,
      association.debugRequestId,
      association.latestRunRequestId,
      association.latestResultRequestId,
      association.lastResultRequestId,
      association.assistantRunId,
    ].some((runId) => runId !== runResult.requestId)) {
    throw new Error(`Conversation answer link was not bound to the current runId: ${JSON.stringify({
      targetRunId,
      runResultRequestId: runResult.requestId || null,
      ...association,
    })}`);
  }
  assertNoRuntimeExecutionPath(runResult, "Conversation manual question");
  assertMatch(cardText, /已命中/, "Conversation manual evidence card did not show hit status");
  assertMatch(cardText, /vector-bge-m3/, "Conversation manual evidence card did not show vector retrieval mode");
  assertMatch(cardText, /Embedding\s+(embedded|ready)/i, "Conversation manual evidence card did not show embedding status");
  assertMatch(cardText, /(?:第\s*\d+(?:\s*[-–]\s*\d+)?\s*页|\bpp?\.\s*\d+(?:\s*[-–]\s*\d+)?)/i, "Conversation manual evidence card did not show a real page citation");
  assertMatch(cardText, /Query：[^\n]*尾门/, "Conversation manual evidence card did not show its retrieval query");
  assertMatch(cardText, /rank 1 主证据链接/, "Conversation card did not explain the primary-link boundary");
  if (await page.locator('[data-testid="run-detail-card"][data-card-kind="manual-safety-evidence"]').count()) {
    throw new Error("Conversation manual refs were rendered as a Safety evidence card.");
  }

  await page.screenshot({ path: screenshotPath, fullPage: true });

  for (const [expectedStatus, fixtureCommand, fixedMessage] of [
    ["miss", "手册中是否有火星弹射座椅说明？", "已查询用户手册，但没有找到足够可靠的证据"],
    ["unavailable", "手册服务不可用时如何处理尾门问题？", "用户手册服务暂时不可用"],
  ]) {
    fixtureStatus = expectedStatus;
    await page.locator("#commandInput").fill(fixtureCommand);
    await page.locator("#runButton").click();
    await page.waitForFunction((statusName) => (
      document.querySelector('[data-testid="manual-evidence-status"]')?.getAttribute("data-status") === statusName
    ), expectedStatus, { timeout: 90_000 });
    await page.waitForFunction((expectedSpeech) => (
      window.__runtimeDebug?.().manualEvidenceBoundary?.speechText === expectedSpeech
    ), fixedMessage, { timeout: 90_000 });
    if (await page.locator('#assistantText a[data-testid="manual-primary-evidence-link"]').count()) {
      throw new Error(`${expectedStatus} must not expose a manual evidence link.`);
    }
    const answerText = await page.locator("#assistantText").innerText();
    if (!answerText.includes(fixedMessage)) {
      throw new Error(`${expectedStatus} did not render its fixed answer: ${answerText}`);
    }
    const boundaryDebug = await page.evaluate(() => window.__runtimeDebug?.());
    if (boundaryDebug?.mode === "blocked") {
      throw new Error(`${expectedStatus} incorrectly escalated to blocked runtime mode.`);
    }
    if (boundaryDebug?.manualEvidenceBoundary?.speechText !== fixedMessage
      || boundaryDebug?.manualEvidenceBoundary?.speechTextProvenance !== "manual-evidence-boundary") {
      throw new Error(`${expectedStatus} did not expose fixed manual boundary speech/provenance.`);
    }
    if (expectedStatus === "unavailable") {
      const unavailableCardText = await card.innerText();
      assertMatch(unavailableCardText, /manual RAG HTTP 503/i, "Unavailable detail did not expose its failure reason");
    }
  }
  fixtureStatus = null;
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    command: commandText,
    screenshotPath,
    checks: {
      hit: true,
      vehicleSluFixture: "nio-vehicle-slu-contract@2.0.0",
      runAssociation: association,
      searchingObserved: true,
      hitTargetPreflight: true,
      notRequested: true,
      miss: true,
      unavailable: true,
      unavailableFixedAnswerAndSpeech: true,
      unavailableNotBlocked: true,
      retrievalMode: "vector-bge-m3",
      embeddingStatus: true,
      realPageCitation: true,
      query: true,
      noVehicleTools: true,
      primaryLinkBoundary: true,
      stableCardKind: "manual-conversation-evidence",
      runtimeDebugDetailCards: true,
      primaryEvidenceLinkCount: 1,
      controlledQueryParameters: ["source", "chunk", "run"],
      acceptedEvidenceRefCount: evidenceRefs.length,
      safetyCardAbsent: true,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, baseUrl, command: commandText, screenshotPath, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
