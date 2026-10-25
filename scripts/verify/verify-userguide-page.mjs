import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { MANUAL_CORPUS_REGISTRY } from "../../src/manual/manual-corpus-registry.js";
import { ManualEvidenceRunLedger } from "../../src/server/manual-evidence-run-ledger.mjs";
import { createServer } from "../../src/server/local-agent-server.mjs";
import { launchChromium } from "../lib/playwright-loader.mjs";

const sourceId = MANUAL_CORPUS_REGISTRY.defaultCorpusId;
const corpus = MANUAL_CORPUS_REGISTRY.corpora[sourceId];
const chunks = (await readFile(new URL("../../data/manual-rag/es8-manual-chunks.jsonl", import.meta.url), "utf8"))
  .trim()
  .split(/\r?\n/u)
  .map((line) => JSON.parse(line));
const pages = (await readFile(new URL("../../data/manual-rag/es8-manual-pages.jsonl", import.meta.url), "utf8"))
  .trim()
  .split(/\r?\n/u)
  .map((line) => JSON.parse(line));

function evidenceRef(chunkId, excerpt) {
  const chunk = chunks.find((candidate) => candidate.chunkId === chunkId);
  assert.ok(chunk, `missing verifier chunk ${chunkId}`);
  return Object.freeze({
    sourceId,
    sourceVersion: corpus.sourceVersion,
    chunkId,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    excerpt,
    score: Object.freeze({ retrieval: 0.8, rerank: null, grounding: null }),
  });
}

const firstEvidence = evidenceRef(
  "es8-manual-chunk-0055",
  "您可以使用以下两种方式设置并记忆尾门的开启高度：",
);
const secondEvidence = evidenceRef(
  "es8-manual-chunk-0057",
  "行车前，请务必确认前舱盖已正确关闭。",
);
const runId = "run-userguide-page";
const ledger = new ManualEvidenceRunLedger();
ledger.record(runId, [firstEvidence, secondEvidence], { status: "hit" });
const userGuideHtml = await readFile(new URL("../../userguide.html", import.meta.url), "utf8");
const appSource = await readFile(new URL("../../src/app/app.js", import.meta.url), "utf8");
const userGuideModule = await import("../../src/app/userguide.js");
assert.equal(typeof userGuideModule.createUserGuideState, "function");
assert.equal(typeof userGuideModule.reduceUserGuideState, "function");
assert.equal(
  typeof userGuideModule.createLatestSelectionGeneration,
  "function",
  "the controller needs a pure generation boundary for stale success/failure suppression",
);
assert.equal(
  typeof userGuideModule.resolveReturnToConsoleAction,
  "function",
  "the return control needs a pure same-origin navigation decision",
);
assert.equal(
  typeof userGuideModule.returnToConsole,
  "function",
  "the return control needs one tested browser effect boundary",
);
assert.match(userGuideHtml, /data-testid=["']return-to-console["']/u);
assert.match(userGuideHtml, />\s*← 返回操作台\s*</u);
assert.match(appSource, /link\.target\s*=\s*["']_blank["']/u);
assert.match(appSource, /link\.rel\s*=\s*["']noopener["']/u);
const initialState = userGuideModule.createUserGuideState();
assert.deepEqual(Object.keys(initialState), [
  "document",
  "evidenceRefs",
  "activeChunkId",
  "drawerExpanded",
]);
assert.equal(Object.isFrozen(initialState), true);
assert.deepEqual(initialState, {
  document: null,
  evidenceRefs: [],
  activeChunkId: null,
  drawerExpanded: false,
});
const selectionGeneration = userGuideModule.createLatestSelectionGeneration();
const staleSelection = selectionGeneration.begin();
const latestSelection = selectionGeneration.begin();
assert.equal(selectionGeneration.isCurrent(staleSelection), false);
assert.equal(selectionGeneration.isCurrent(latestSelection), true);

assert.equal(userGuideModule.resolveReturnToConsoleAction({
  origin: "http://127.0.0.1:4173",
  referrer: "http://127.0.0.1:4173/",
  historyLength: 2,
}), "history-back");
assert.equal(userGuideModule.resolveReturnToConsoleAction({
  origin: "http://127.0.0.1:4173",
  referrer: "http://127.0.0.1:4173/",
  historyLength: 1,
}), "close-or-root");
assert.equal(userGuideModule.resolveReturnToConsoleAction({
  origin: "http://127.0.0.1:4173",
  referrer: "https://untrusted.example/console",
  historyLength: 5,
}), "close-or-root");

const historyEffects = createReturnEffects();
assert.equal(userGuideModule.returnToConsole(historyEffects.window), "history-back");
assert.deepEqual(historyEffects.calls, ["history.back"]);

const blockedCloseEffects = createReturnEffects({ historyLength: 1, closeSucceeds: false });
assert.equal(userGuideModule.returnToConsole(blockedCloseEffects.window), "close-or-root");
assert.deepEqual(blockedCloseEffects.calls, ["window.close", "schedule"]);
blockedCloseEffects.flush();
assert.deepEqual(blockedCloseEffects.calls, ["window.close", "schedule", "location.assign:/"]);

const successfulCloseEffects = createReturnEffects({ historyLength: 1, closeSucceeds: true });
assert.equal(userGuideModule.returnToConsole(successfulCloseEffects.window), "close-or-root");
successfulCloseEffects.flush();
assert.deepEqual(successfulCloseEffects.calls, ["window.close", "schedule"]);

if (process.argv.includes("--pure")) {
  console.log("user guide pure state, selection, and return navigation verification passed");
  process.exit(0);
}

const server = createServer({ manualRagOptions: { evidenceRunLedger: ledger } });

let browser;
try {
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const routed = await fetch(`${origin}/userguide?source=${encodeURIComponent(sourceId)}`);
  assert.equal(routed.status, 200, "/userguide must map exactly to userguide.html even with a query");
  assert.match(routed.headers.get("content-type") || "", /text\/html/u);
  assert.match(await routed.text(), /id="userGuideApp"/u);
  for (const rawPath of [
    "/x/../userguide",
    "/x/%2e%2e/userguide",
    "/%2e%2e/userguide",
    "/userguide/",
    "/userguide-extra",
  ]) {
    const nonRoute = await rawServerGet(address.port, rawPath);
    assert.equal(nonRoute.statusCode, 404, `${rawPath} must not acquire the exact /userguide mapping`);
    assert.doesNotMatch(nonRoute.body, /id="userGuideApp"/u);
  }

  browser = await launchChromium({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${origin}/userguide`, { waitUntil: "domcontentloaded" });
  await waitForReady(page);
  assert.equal(await page.locator("[data-manual-page]").count(), pages.length, "browse must render the full ES8 manual");
  assert.equal(await activeMarkCount(page), 0, "browse must not invent a highlight");
  assert.equal(await page.locator("#evidenceRegion").isHidden(), true, "browse must not invent a current-run drawer");
  assert.equal((await page.locator("body").innerText()).includes("本次可信证据"), false);
  assert.equal(await page.locator("#guideTitle").innerText(), corpus.title);
  assert.equal(await page.getByTestId("return-to-console").isVisible(), true);
  assert.equal(await page.getByTestId("return-to-console").innerText(), "← 返回操作台");

  let delayedSecondTarget = false;
  await page.route("**/api/userguide?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("run") === runId && url.searchParams.get("chunk") === secondEvidence.chunkId) {
      delayedSecondTarget = true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await route.continue();
  });
  await page.goto(
    `${origin}/userguide?source=${encodeURIComponent(sourceId)}&chunk=${encodeURIComponent(firstEvidence.chunkId)}&run=${encodeURIComponent(runId)}`,
    { waitUntil: "domcontentloaded" },
  );
  await waitForReady(page);
  assert.equal(await activeMarkCount(page), 1);
  assert.equal(await page.locator("mark[data-evidence-active]").innerText(), firstEvidence.excerpt);
  const drawerToggle = page.locator("#evidenceDrawerToggle");
  assert.equal(await drawerToggle.innerText(), "本次可信证据 2 条");
  assert.equal(await drawerToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator("#evidenceDrawer").isHidden(), true, "drawer must be completely collapsed initially");
  assert.equal(
    await page.locator("#pdfLink").getAttribute("href"),
    `/api/userguide/pdf?source=${encodeURIComponent(sourceId)}#page=${firstEvidence.pageStart}`,
  );

  await drawerToggle.click();
  assert.equal(await drawerToggle.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("[data-evidence-rank]").count(), 2);
  assert.deepEqual(
    await page.locator("[data-evidence-rank]").evaluateAll((items) => items.map((item) => item.dataset.evidenceRank)),
    ["1", "2"],
  );
  await page.locator('[data-evidence-rank="2"]').click();
  assert.equal(await activeMarkCount(page), 0, "selecting another rank must clear the old mark before target loading");
  await page.waitForFunction(
    (chunkId) => document.querySelector("mark[data-evidence-active]")?.dataset.chunkId === chunkId,
    secondEvidence.chunkId,
  );
  assert.equal(delayedSecondTarget, true);
  assert.equal(await activeMarkCount(page), 1, "rank switching must never accumulate marks");
  assert.equal(await page.locator("mark[data-evidence-active]").innerText(), secondEvidence.excerpt);
  assert.equal(
    await page.locator("#pdfLink").getAttribute("href"),
    `/api/userguide/pdf?source=${encodeURIComponent(sourceId)}#page=${secondEvidence.pageStart}`,
  );

  await page.goto(
    `${origin}/userguide?source=${encodeURIComponent(sourceId)}&chunk=${encodeURIComponent(firstEvidence.chunkId)}&run=expired-run`,
    { waitUntil: "domcontentloaded" },
  );
  await waitForError(page);
  assert.match(await page.locator("#userGuideError").innerText(), /过期|重新查询/u);
  assert.equal(await page.getByTestId("return-to-console").isVisible(), true,
    "the return control must remain available when evidence loading fails");
  await assertFailClosed(page);

  await page.goto(
    `${origin}/userguide?source=${encodeURIComponent(sourceId)}&chunk=missing-chunk&run=${encodeURIComponent(runId)}`,
    { waitUntil: "domcontentloaded" },
  );
  await waitForError(page);
  assert.match(await page.locator("#userGuideError").innerText(), /未找到|无法加载/u);
  await assertFailClosed(page);

  const duplicateUrl = `${origin}/userguide?source=${encodeURIComponent(sourceId)}&source=${encodeURIComponent(sourceId)}`;
  await page.goto(duplicateUrl, { waitUntil: "domcontentloaded" });
  await waitForError(page);
  assert.match(await page.locator("#userGuideError").innerText(), /链接参数|无效/u);
  await assertFailClosed(page);

  await page.goto(
    `${origin}/userguide?source=${encodeURIComponent(sourceId)}&query=${encodeURIComponent('<img src=x onerror="window.__queryExecuted=1">')}`,
    { waitUntil: "domcontentloaded" },
  );
  await waitForError(page);
  assert.equal(await page.evaluate(() => window.__queryExecuted), undefined);
  await assertFailClosed(page);

  await page.unroute("**/api/userguide?*");
  const xssExcerpt = '<img src=x onerror="window.__responseExecuted=1">';
  const xssRef = {
    ...firstEvidence,
    excerpt: xssExcerpt,
  };
  const xssTarget = {
    source: {
      sourceId,
      sourceVersion: corpus.sourceVersion,
      contentDigest: corpus.contentDigest,
      title: xssExcerpt,
      model: "ES8",
      applicableModels: ["ES8"],
    },
    pages: [{ pageNumber: firstEvidence.pageStart, sourceId, charCount: xssExcerpt.length, text: xssExcerpt }],
    currentEvidence: xssRef,
    evidence: [xssRef],
    highlight: {
      chunkId: xssRef.chunkId,
      pageStart: xssRef.pageStart,
      pageEnd: xssRef.pageEnd,
      excerpt: xssExcerpt,
      locations: [{ pageNumber: xssRef.pageStart, start: 0, end: xssExcerpt.length }],
    },
    pdfUrl: `/api/userguide/pdf?source=${encodeURIComponent(sourceId)}`,
  };
  await page.route("**/api/userguide?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(xssTarget),
  }));
  await page.goto(
    `${origin}/userguide?source=${encodeURIComponent(sourceId)}&chunk=${encodeURIComponent(firstEvidence.chunkId)}&run=run-xss`,
    { waitUntil: "domcontentloaded" },
  );
  await waitForReady(page);
  assert.equal(await page.evaluate(() => window.__responseExecuted), undefined);
  assert.equal(await page.locator("#manualPages img, #manualPages script").count(), 0);
  assert.equal(await page.locator("mark[data-evidence-active]").innerText(), xssExcerpt);

  await page.unroute("**/api/userguide?*");
  const strictEvidenceCases = [
    ["retrieval must be finite", (target) => {
      target.currentEvidence.score.retrieval = null;
      target.evidence[0].score.retrieval = null;
    }],
    ["EvidenceRef must reject extra fields", (target) => {
      target.currentEvidence.unexpected = "forged";
      target.evidence[0].unexpected = "forged";
    }],
    ["EvidenceRef must reject missing fields", (target) => {
      delete target.currentEvidence.excerpt;
      delete target.evidence[0].excerpt;
    }],
    ["score must reject extra fields", (target) => {
      target.currentEvidence.score.unexpected = 1;
      target.evidence[0].score.unexpected = 1;
    }],
    ["score must reject missing fields", (target) => {
      delete target.currentEvidence.score.grounding;
      delete target.evidence[0].score.grounding;
    }],
    ["currentEvidence score must equal its accepted rank", (target) => {
      target.currentEvidence = structuredClone(target.currentEvidence);
      target.currentEvidence.score.retrieval = 0.91;
    }],
  ];
  for (let index = 0; index < strictEvidenceCases.length; index += 1) {
    const [label, mutate] = strictEvidenceCases[index];
    const invalidTarget = structuredClone(xssTarget);
    mutate(invalidTarget);
    await assertRejectedTarget(page, origin, invalidTarget, `strict-${index}`, label);
  }

  const crossPageRef = {
    ...structuredClone(firstEvidence),
    chunkId: "browser-cross-page",
    pageStart: 70,
    pageEnd: 71,
    excerpt: "跨页证据前半 后半结束",
  };
  const crossPageTarget = {
    source: structuredClone(xssTarget.source),
    pages: [
      { pageNumber: 70, sourceId, charCount: 12, text: "页眉 跨页证据前半" },
      { pageNumber: 71, sourceId, charCount: 11, text: "后半结束 页脚" },
    ],
    currentEvidence: structuredClone(crossPageRef),
    evidence: [structuredClone(crossPageRef)],
    highlight: {
      chunkId: crossPageRef.chunkId,
      pageStart: 70,
      pageEnd: 71,
      excerpt: crossPageRef.excerpt,
      locations: [
        { pageNumber: 70, start: "页眉 ".length, end: "页眉 跨页证据前半".length },
        { pageNumber: 71, start: 0, end: "后半结束".length },
      ],
    },
    pdfUrl: `/api/userguide/pdf?source=${encodeURIComponent(sourceId)}`,
  };
  await page.unroute("**/api/userguide?*");
  await page.route("**/api/userguide?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(crossPageTarget),
  }));
  await page.goto(
    `${origin}/userguide?source=${encodeURIComponent(sourceId)}&chunk=${encodeURIComponent(crossPageRef.chunkId)}&run=run-cross-page-browser`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(() => ["ready", "error"].includes(
    document.querySelector("#userGuideApp")?.dataset.loadState,
  ));
  assert.equal(
    await page.locator("#userGuideApp").getAttribute("data-load-state"),
    "ready",
    "a validated cross-page location set must render",
  );
  assert.equal(await activeMarkCount(page), 1);
  assert.equal(await page.locator("mark[data-evidence-active]").innerText(), crossPageRef.excerpt);
  assert.equal(await page.locator("mark[data-evidence-cross-page]").count(), 1);
  assert.equal(
    await page.locator("mark[data-evidence-cross-page]").evaluate((mark) => mark.closest("[data-manual-page]")?.dataset.manualPage),
    "70",
    "the single cross-page callout must anchor to its first authoritative location",
  );

  const tamperedLocationsTarget = structuredClone(xssTarget);
  tamperedLocationsTarget.highlight.locations[0].end -= 1;
  await assertRejectedTarget(
    page,
    origin,
    tamperedLocationsTarget,
    "tampered-locations",
    "location offsets whose text does not reconstruct the excerpt must fail closed",
  );

  await verifyLatestRankWins(page, origin, { lateRank2Failure: false });
  await verifyLatestRankWins(page, origin, { lateRank2Failure: true });
  await verifySwitchScoreDriftFailsClosed(page, origin);

  const maliciousTarget = structuredClone(xssTarget);
  maliciousTarget.pdfUrl = "https://attacker.invalid/manual.pdf";
  await assertRejectedTarget(page, origin, maliciousTarget, "malicious-pdf", "arbitrary PDF URL must fail closed");
  assert.equal(await page.locator('a[href^="https://attacker.invalid"]').count(), 0);

  const duplicateEvidenceTarget = structuredClone(xssTarget);
  duplicateEvidenceTarget.evidence.push(structuredClone(xssRef));
  await assertRejectedTarget(
    page,
    origin,
    duplicateEvidenceTarget,
    "duplicate-evidence",
    "duplicate evidence must fail closed independently of PDF validation",
  );
  assert.deepEqual(pageErrors, []);

  console.log("user guide page verification passed");
} finally {
  await browser?.close().catch(() => {});
  await closeServer(server);
}

async function waitForReady(page) {
  await page.waitForSelector('#userGuideApp[data-load-state="ready"]');
}

async function waitForError(page) {
  await page.waitForSelector('#userGuideApp[data-load-state="error"]');
}

async function activeMarkCount(page) {
  return page.locator("mark[data-evidence-active]").count();
}

async function assertFailClosed(page) {
  assert.equal(await activeMarkCount(page), 0);
  assert.equal(await page.locator("[data-manual-page]").count(), 0);
  assert.equal(await page.locator("#evidenceRegion").isHidden(), true);
}

async function assertRejectedTarget(page, origin, target, runSuffix, label) {
  await page.unroute("**/api/userguide?*");
  await page.route("**/api/userguide?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(target),
  }));
  await page.goto(
    `${origin}/userguide?source=${encodeURIComponent(sourceId)}&chunk=${encodeURIComponent(target.currentEvidence.chunkId)}&run=${encodeURIComponent(runSuffix)}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(() => ["ready", "error"].includes(
    document.querySelector("#userGuideApp")?.dataset.loadState,
  ));
  assert.equal(await page.locator("#userGuideApp").getAttribute("data-load-state"), "error", label);
  await assertFailClosed(page);
}

function raceEvidenceRefs() {
  return [
    ["race-rank-1", 80, "第一条可信证据", 0.83],
    ["race-rank-2", 81, "第二条可信证据", 0.79],
    ["race-rank-3", 82, "第三条可信证据", 0.74],
  ].map(([chunkId, pageStart, excerpt, retrieval]) => ({
    sourceId,
    sourceVersion: corpus.sourceVersion,
    chunkId,
    pageStart,
    pageEnd: pageStart,
    excerpt,
    score: { retrieval, rerank: null, grounding: null },
  }));
}

function browserTargetFor(evidence, evidenceRefs) {
  const prefix = `页 ${evidence.pageStart} · `;
  const pageText = `${prefix}${evidence.excerpt} · 页脚`;
  return {
    source: {
      sourceId,
      sourceVersion: corpus.sourceVersion,
      contentDigest: corpus.contentDigest,
      title: corpus.title,
      model: "ES8",
      applicableModels: ["ES8"],
    },
    pages: [{
      pageNumber: evidence.pageStart,
      sourceId,
      charCount: pageText.length,
      text: pageText,
    }],
    currentEvidence: structuredClone(evidence),
    evidence: structuredClone(evidenceRefs),
    highlight: {
      chunkId: evidence.chunkId,
      pageStart: evidence.pageStart,
      pageEnd: evidence.pageEnd,
      excerpt: evidence.excerpt,
      locations: [{
        pageNumber: evidence.pageStart,
        start: prefix.length,
        end: prefix.length + evidence.excerpt.length,
      }],
    },
    pdfUrl: `/api/userguide/pdf?source=${encodeURIComponent(sourceId)}`,
  };
}

async function verifyLatestRankWins(page, origin, { lateRank2Failure }) {
  const evidenceRefs = raceEvidenceRefs();
  const runId = lateRank2Failure ? "race-late-failure" : "race-late-success";
  let releaseRank2;
  let noteRank2Requested;
  let noteRank2Completed;
  const rank2Gate = new Promise((resolve) => { releaseRank2 = resolve; });
  const rank2Requested = new Promise((resolve) => { noteRank2Requested = resolve; });
  const rank2Completed = new Promise((resolve) => { noteRank2Completed = resolve; });

  await page.unroute("**/api/userguide?*");
  await page.route("**/api/userguide?*", async (route) => {
    const url = new URL(route.request().url());
    const chunkId = url.searchParams.get("chunk");
    const evidence = evidenceRefs.find((ref) => ref.chunkId === chunkId);
    assert.ok(evidence, `unexpected race chunk ${chunkId}`);
    if (chunkId === evidenceRefs[1].chunkId) {
      noteRank2Requested();
      await rank2Gate;
      if (lateRank2Failure) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "evidence-target-not-found", message: "late rank 2" } }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(browserTargetFor(evidence, evidenceRefs)),
        });
      }
      noteRank2Completed();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(browserTargetFor(evidence, evidenceRefs)),
    });
  });

  await page.goto(
    `${origin}/userguide?source=${encodeURIComponent(sourceId)}&chunk=${encodeURIComponent(evidenceRefs[0].chunkId)}&run=${runId}`,
    { waitUntil: "domcontentloaded" },
  );
  await waitForReady(page);
  await page.locator("#evidenceDrawerToggle").click();
  await page.locator('[data-evidence-rank="2"]').click();
  await rank2Requested;
  await page.locator('[data-evidence-rank="3"]').click();
  await page.waitForFunction(
    (chunkId) => document.querySelector("mark[data-evidence-active]")?.dataset.chunkId === chunkId,
    evidenceRefs[2].chunkId,
  );
  releaseRank2();
  await rank2Completed;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  assert.equal(await page.locator("#userGuideApp").getAttribute("data-load-state"), "ready");
  assert.equal(await activeMarkCount(page), 1);
  assert.equal(
    await page.locator("mark[data-evidence-active]").getAttribute("data-chunk-id"),
    evidenceRefs[2].chunkId,
    `late rank 2 ${lateRank2Failure ? "failure" : "success"} must not replace rank 3`,
  );
  assert.equal(await page.locator("#userGuideError").isHidden(), true);
  assert.equal(
    await page.locator("#pdfLink").getAttribute("href"),
    `/api/userguide/pdf?source=${encodeURIComponent(sourceId)}#page=${evidenceRefs[2].pageStart}`,
  );
}

async function verifySwitchScoreDriftFailsClosed(page, origin) {
  const evidenceRefs = raceEvidenceRefs();
  const runId = "switch-score-drift";
  await page.unroute("**/api/userguide?*");
  await page.route("**/api/userguide?*", async (route) => {
    const url = new URL(route.request().url());
    const chunkId = url.searchParams.get("chunk");
    const evidence = evidenceRefs.find((ref) => ref.chunkId === chunkId);
    const target = browserTargetFor(evidence, evidenceRefs);
    if (chunkId === evidenceRefs[1].chunkId) {
      target.evidence[0].score.retrieval += 0.01;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(target) });
  });
  await page.goto(
    `${origin}/userguide?source=${encodeURIComponent(sourceId)}&chunk=${encodeURIComponent(evidenceRefs[0].chunkId)}&run=${runId}`,
    { waitUntil: "domcontentloaded" },
  );
  await waitForReady(page);
  await page.locator("#evidenceDrawerToggle").click();
  await page.locator('[data-evidence-rank="2"]').click();
  await waitForError(page);
  await assertFailClosed(page);
}

function createReturnEffects({ historyLength = 2, closeSucceeds = false } = {}) {
  const calls = [];
  const scheduled = [];
  const window = {
    closed: false,
    document: { referrer: "http://127.0.0.1:4173/" },
    location: {
      origin: "http://127.0.0.1:4173",
      assign(path) { calls.push(`location.assign:${path}`); },
    },
    history: {
      length: historyLength,
      back() { calls.push("history.back"); },
    },
    close() {
      calls.push("window.close");
      this.closed = closeSucceeds;
    },
    setTimeout(callback) {
      calls.push("schedule");
      scheduled.push(callback);
      return scheduled.length;
    },
  };
  return {
    window,
    calls,
    flush() {
      for (const callback of scheduled.splice(0)) callback();
    },
  };
}

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      target.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(target) {
  if (!target.listening) return Promise.resolve();
  target.closeAllConnections?.();
  return new Promise((resolve, reject) => {
    target.close((error) => (error ? reject(error) : resolve()));
  });
}

function rawServerGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: requestPath,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}
