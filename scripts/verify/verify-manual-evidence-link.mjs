import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as manualEvidenceLink from "../../src/app/manual-evidence-link.js";
import * as manualEligibility from "../../src/manual/manual-evidence-eligibility.js";
import { publishManualConstraints } from "../../src/manual/manual-constraint-registry.js";
import { buildManualEvidenceSummary as buildPresentedManualEvidenceSummary } from "../../src/manual/manual-rag-presentation.js";
import { SafetyGateway } from "../../src/safety/safety-gateway.js";
import { createVehicleStateSnapshot } from "../../src/safety/vehicle-state.js";

for (const [name, exported] of [
  ["createManualEvidenceRunState", manualEvidenceLink.createManualEvidenceRunState],
  ["reduceManualEvidenceRun", manualEvidenceLink.reduceManualEvidenceRun],
  ["resolveManualEvidenceAnswer", manualEvidenceLink.resolveManualEvidenceAnswer],
  ["createManualSafetyEvidencePresentation", manualEvidenceLink.createManualSafetyEvidencePresentation],
  ["retrieveManualEvidenceFromBrowser", manualEvidenceLink.retrieveManualEvidenceFromBrowser],
  ["projectTrustedManualEvidenceRef", manualEvidenceLink.projectTrustedManualEvidenceRef],
  ["isTrustedManualRagConsumerEvidence", manualEligibility.isTrustedManualRagConsumerEvidence],
  ["isTrustedManualRagConsumerEvidenceRef", manualEligibility.isTrustedManualRagConsumerEvidenceRef],
]) {
  assert.equal(typeof exported, "function", `${name} must be exported for the real offline boundary test`);
}

const {
  createManualEvidenceLink,
  createManualEvidencePresentation,
  createManualEvidenceRunState,
  createManualSafetyEvidencePresentation,
  projectTrustedManualEvidenceRef,
  reduceManualEvidenceRun,
  resolveManualEvidenceAnswer,
  retrieveManualEvidenceFromBrowser,
} = manualEvidenceLink;
const {
  createManualRagConsumerEvidence,
  isTrustedManualRagConsumerEvidence,
  isTrustedManualRagConsumerEvidenceRef,
} = manualEligibility;

const firstRef = Object.freeze({
  sourceId: "nio-es8-user-manual-2026",
  sourceVersion: "2026",
  chunkId: "es8-manual-chunk-0055",
  pageStart: 66,
  pageEnd: 66,
  excerpt: "您可以设置并记忆尾门的开启高度。",
  score: Object.freeze({ retrieval: 0.72, rerank: null, grounding: 0.8 }),
});
const secondRef = Object.freeze({
  sourceId: "nio-es8-user-manual-2026",
  sourceVersion: "2026",
  chunkId: "es8-manual-chunk-0057",
  pageStart: 68,
  pageEnd: 68,
  excerpt: "行车前，请务必确认前舱盖已正确关闭。",
  score: Object.freeze({ retrieval: 0.68, rerank: 0.76, grounding: null }),
});
const runId = "run/当前 1";
const currentOrigin = "http://hmi.local";
const rawAnswer = "原始回答";
const rawSpeechText = "原始播报";

function consumerResult(status, evidence, responseRunId = runId, extras = {}) {
  return createManualRagConsumerEvidence({
    query: "ES8 尾门",
    runId: responseRunId,
    status,
    evidence,
    telemetry: { retrievalMode: "vector-bge-m3", embeddingStatus: "embedded" },
    ...extras,
  });
}

function jsonResponse({ url, status = 200, body, jsonError = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    async json() {
      if (jsonError) throw jsonError;
      return structuredClone(body);
    },
  };
}

function validTargetBody(ref = firstRef) {
  return {
    source: { sourceId: ref.sourceId, sourceVersion: ref.sourceVersion },
    pages: Array.from(
      { length: ref.pageEnd - ref.pageStart + 1 },
      (_value, index) => ({ pageNumber: ref.pageStart + index, text: "fixture" }),
    ),
    currentEvidence: structuredClone(ref),
    evidence: [structuredClone(ref)],
    highlight: {
      chunkId: ref.chunkId,
      pageStart: ref.pageStart,
      pageEnd: ref.pageEnd,
      excerpt: ref.excerpt,
    },
  };
}

function changedTargetBody(change) {
  const target = validTargetBody();
  change(target);
  return target;
}

function createFetchFixture({
  ragStatus = 200,
  ragUrl = `${currentOrigin}/api/manual-rag`,
  ragBody = {
    runId,
    query: "ES8 尾门",
    status: "hit",
    evidence: [firstRef, secondRef],
    telemetry: { retrievalMode: "vector-bge-m3", embeddingStatus: "embedded" },
  },
  ragJsonError = null,
  ragError = null,
  targetStatus = 200,
  targetUrl = `${currentOrigin}/api/userguide?source=${encodeURIComponent(firstRef.sourceId)}&chunk=${encodeURIComponent(firstRef.chunkId)}&run=${encodeURIComponent(runId)}`,
  targetBody = validTargetBody(),
  targetJsonError = null,
  targetError = null,
} = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    if ((init.method || "GET") === "POST") {
      if (ragError) throw ragError;
      return jsonResponse({ url: ragUrl, status: ragStatus, body: ragBody, jsonError: ragJsonError });
    }
    if (targetError) throw targetError;
    return jsonResponse({ url: targetUrl, status: targetStatus, body: targetBody, jsonError: targetJsonError });
  };
  return { fetchImpl, calls };
}

async function runInjectedTransport(fetchFixture, options = {}) {
  const targetRunId = options.runId || runId;
  let state = createManualEvidenceRunState(targetRunId);
  const states = [state];
  const events = [];
  const onTransition = (event) => {
    events.push(event);
    state = reduceManualEvidenceRun(state, event);
    states.push(state);
    options.afterTransition?.(event, { getState: () => state, setState: (next) => { state = next; } });
  };
  const evidenceRefs = await retrieveManualEvidenceFromBrowser({
    query: "ES8 尾门",
    runId: targetRunId,
    topK: 5,
    vehicleModel: "ES8",
    signal: options.signal,
    fetchImpl: fetchFixture.fetchImpl,
    currentOrigin,
    onTransition,
  });
  return { evidenceRefs, state, states, events, calls: fetchFixture.calls };
}

const hitTransport = await runInjectedTransport(createFetchFixture());
const trustedHit = hitTransport.evidenceRefs;
const hitState = hitTransport.state;
const hitPresentation = createManualEvidencePresentation(hitState);
assert.equal(hitTransport.states.some((state) => state.status === "searching"), true);
assert.equal(hitTransport.calls.length, 2, "hit must POST RAG and preflight its rank-1 target");
assert.equal(hitTransport.calls[0].input, "/api/manual-rag");
assert.equal(hitTransport.calls[0].init.method, "POST");
assert.equal(hitTransport.calls[1].init.method, "GET");
const postedBody = JSON.parse(hitTransport.calls[0].init.body);
assert.equal(postedBody.runId, runId);
assert.equal(postedBody.query, "ES8 尾门");
const preflightRequest = new URL(hitTransport.calls[1].input, currentOrigin);
assert.equal(preflightRequest.pathname, "/api/userguide");
assert.deepEqual(new Set(preflightRequest.searchParams.keys()), new Set(["source", "chunk", "run"]));
assert.equal([...preflightRequest.searchParams.keys()].length, 3);
assert.equal(preflightRequest.searchParams.get("source"), firstRef.sourceId);
assert.equal(preflightRequest.searchParams.get("chunk"), firstRef.chunkId);
assert.equal(preflightRequest.searchParams.get("run"), runId);
assert.equal(isTrustedManualRagConsumerEvidence(trustedHit), true);
assert.equal(isTrustedManualRagConsumerEvidenceRef(trustedHit[0]), true);
const projectedTrustedRef = projectTrustedManualEvidenceRef(trustedHit[0]);
assert.deepEqual(projectedTrustedRef, firstRef);
assert.notEqual(projectedTrustedRef, trustedHit[0]);
assert.equal(Object.isFrozen(projectedTrustedRef), true);
assert.equal(Object.isFrozen(projectedTrustedRef.score), true);
assert.throws(
  () => projectTrustedManualEvidenceRef(structuredClone(trustedHit[0])),
  /trusted.*EvidenceRef/i,
  "an unbranded strict clone must not enter the app TaskPlan boundary",
);
assert.throws(
  () => projectTrustedManualEvidenceRef({
    id: "manual:bare-citation",
    source: "manual",
    citation: "p.66",
  }),
  /trusted.*EvidenceRef/i,
  "a bare citation must not be rebuilt as a strict EvidenceRef",
);
assert.equal(hitState.status, "hit");
assert.equal(hitPresentation.primaryEvidenceRef, trustedHit[0]);
assert.ok(hitPresentation.primaryLink);

const controlledLink = createManualEvidenceLink({
  evidenceRef: trustedHit[0],
  evidenceRefs: trustedHit,
  runId,
  targetValidation: hitState.targetValidation,
});
assert.equal(controlledLink, hitPresentation.primaryLink);
const parsedLink = new URL(controlledLink, currentOrigin);
const queryKeys = [...parsedLink.searchParams.keys()];
assert.equal(queryKeys.length, 3);
assert.equal(new Set(queryKeys).size, 3);
assert.deepEqual(new Set(queryKeys), new Set(["source", "chunk", "run"]));
assert.equal(parsedLink.searchParams.get("run"), runId);
assert.throws(() => createManualEvidenceLink({
  evidenceRef: trustedHit[0],
  evidenceRefs: trustedHit,
  runId: "wrong-run",
  targetValidation: hitState.targetValidation,
}), TypeError, "link runId must equal branded evidence metadata runId");
assert.throws(() => createManualEvidenceLink({
  evidenceRef: trustedHit[0],
  evidenceRefs: trustedHit,
  runId,
  targetValidation: Object.freeze({}),
}), TypeError, "a forged preflight token must not create a link");

for (const invalidInput of [
  {},
  { evidenceRef: trustedHit[0], evidenceRefs: trustedHit, runId },
  { evidenceRef: trustedHit[1], evidenceRefs: trustedHit, runId, targetValidation: hitState.targetValidation },
  { evidenceRef: trustedHit[0], evidenceRefs: trustedHit, runId, targetValidation: hitState.targetValidation, backendUrl: "https://backend.invalid/forged" },
]) {
  assert.throws(() => createManualEvidenceLink(invalidInput), TypeError);
}

const failureCases = [
  ["http non-2xx", createFetchFixture({ ragStatus: 503, ragBody: {} }), /HTTP 503/i],
  ["invalid JSON", createFetchFixture({ ragJsonError: new SyntaxError("bad json") }), /json/i],
  ["network", createFetchFixture({ ragError: new Error("socket closed") }), /socket closed|network/i],
  ["RAG origin", createFetchFixture({ ragUrl: "https://backend.invalid/api/manual-rag" }), /origin/i],
  ["run mismatch", createFetchFixture({ ragBody: { runId: "other-run", status: "hit", evidence: [firstRef] } }), /run/i],
  ["contract mismatch", createFetchFixture({ ragBody: { runId, status: "miss", evidence: [firstRef] } }), /contract/i],
  ["target 404", createFetchFixture({ targetStatus: 404 }), /404/i],
  ["target invalid JSON", createFetchFixture({ targetJsonError: new SyntaxError("bad target json") }), /invalid JSON/i],
  ["target origin", createFetchFixture({ targetUrl: `https://backend.invalid/api/userguide?source=${firstRef.sourceId}&chunk=${firstRef.chunkId}&run=${encodeURIComponent(runId)}` }), /origin|target/i],
  ["target params", createFetchFixture({ targetUrl: `${currentOrigin}/api/userguide?source=${firstRef.sourceId}&chunk=${firstRef.chunkId}&run=${encodeURIComponent(runId)}&page=999` }), /target|param/i],
  ["target source version", createFetchFixture({ targetBody: changedTargetBody((target) => { target.source.sourceVersion = "forged"; }) }), /target|mismatch/i],
  ["target current evidence", createFetchFixture({ targetBody: changedTargetBody((target) => { target.currentEvidence.chunkId = "forged"; }) }), /target|mismatch/i],
  ["target highlight", createFetchFixture({ targetBody: changedTargetBody((target) => { target.highlight.pageEnd = 999; }) }), /target|page|mismatch/i],
  ["target highlight excerpt", createFetchFixture({ targetBody: changedTargetBody((target) => {
    target.highlight.excerpt = "forged highlight excerpt";
  }) }), /target|mismatch/i],
  ["target excerpt", createFetchFixture({ targetBody: changedTargetBody((target) => {
    target.currentEvidence.excerpt = "forged excerpt";
    target.highlight.excerpt = "forged excerpt";
  }) }), /target|mismatch/i],
  ["target wrong page", createFetchFixture({ targetBody: validTargetBody({ ...firstRef, pageStart: 999, pageEnd: 999 }) }), /target|page|mismatch/i],
];

for (const [label, fixture, reasonPattern] of failureCases) {
  const settled = await runInjectedTransport(fixture);
  assert.equal(isTrustedManualRagConsumerEvidence(settled.evidenceRefs), true, label);
  assert.equal(settled.evidenceRefs.metadata.status, "unavailable", label);
  assert.deepEqual(settled.evidenceRefs, [], label);
  assert.equal(settled.state.status, "unavailable", label);
  assert.match(settled.state.reason, reasonPattern, label);
  assert.equal(settled.state.telemetry?.reason, settled.state.reason, `${label}: readable failure telemetry`);
  assert.equal(createManualEvidencePresentation(settled.state).primaryLink, null, label);
  assert.deepEqual(resolveManualEvidenceAnswer({
    presentation: createManualEvidencePresentation(settled.state),
    rawAnswer,
    rawSpeechText,
  }), {
    answerText: "用户手册服务暂时不可用",
    speechText: "用户手册服务暂时不可用",
  }, label);
}

for (const status of ["miss", "unavailable"]) {
  const fixture = createFetchFixture({
    ragBody: { runId, query: "ES8 尾门", status, evidence: [], reason: `${status}-fixture` },
  });
  const settled = await runInjectedTransport(fixture);
  assert.equal(settled.calls.length, 1, `${status} must not preflight a target`);
  assert.equal(settled.state.status, status);
  assert.equal(createManualEvidencePresentation(settled.state).primaryLink, null);
}

const abortController = new AbortController();
let abortState = createManualEvidenceRunState(runId);
await assert.rejects(
  retrieveManualEvidenceFromBrowser({
    query: "ES8 尾门",
    runId,
    signal: abortController.signal,
    currentOrigin,
    onTransition(event) { abortState = reduceManualEvidenceRun(abortState, event); },
    async fetchImpl() {
      abortController.abort("fixture-abort");
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  }),
  (error) => error?.name === "AbortError",
);
assert.equal(abortState.status, "not_requested");
assert.equal(createManualEvidencePresentation(abortState).primaryLink, null);

let releaseOldRequest;
const oldRequest = new Promise((resolve) => { releaseOldRequest = resolve; });
let rapidState = createManualEvidenceRunState(runId);
const rapidFetch = createFetchFixture();
const oldPromise = retrieveManualEvidenceFromBrowser({
  query: "ES8 尾门",
  runId,
  currentOrigin,
  onTransition(event) { rapidState = reduceManualEvidenceRun(rapidState, event); },
  async fetchImpl(input, init) {
    if ((init?.method || "GET") === "POST") await oldRequest;
    return rapidFetch.fetchImpl(input, init);
  },
});
rapidState = reduceManualEvidenceRun(rapidState, { type: "run-started", runId: "run-next" });
const newRunState = rapidState;
releaseOldRequest();
await oldPromise;
assert.equal(rapidState, newRunState, "an old actual transport response must not mutate a rapid rerun");

const staleAbortController = new AbortController();
let releaseStaleAbort;
const staleAbortGate = new Promise((resolve) => { releaseStaleAbort = resolve; });
let staleAbortState = createManualEvidenceRunState(runId);
const staleAbortPromise = retrieveManualEvidenceFromBrowser({
  query: "ES8 尾门",
  runId,
  signal: staleAbortController.signal,
  currentOrigin,
  onTransition(event) { staleAbortState = reduceManualEvidenceRun(staleAbortState, event); },
  async fetchImpl() {
    await staleAbortGate;
    const error = new Error("stale abort");
    error.name = "AbortError";
    throw error;
  },
});
staleAbortState = reduceManualEvidenceRun(staleAbortState, { type: "run-started", runId: "run-after-abort" });
const stateBeforeStaleAbort = staleAbortState;
staleAbortController.abort("stale");
releaseStaleAbort();
await assert.rejects(staleAbortPromise, (error) => error?.name === "AbortError");
assert.equal(staleAbortState, stateBeforeStaleAbort, "an old actual transport abort must not clear a new run");

const notRequestedState = createManualEvidenceRunState(runId);
const searchingState = reduceManualEvidenceRun(notRequestedState, {
  type: "search-started", runId, query: "ES8 尾门",
});
for (const state of [notRequestedState, searchingState, hitState]) {
  assert.deepEqual(resolveManualEvidenceAnswer({
    presentation: createManualEvidencePresentation(state),
    rawAnswer,
    rawSpeechText,
  }), { answerText: rawAnswer, speechText: rawSpeechText });
}

const actualManualChunks = (await readFile(
  new URL("../../data/manual-rag/es8-manual-chunks.jsonl", import.meta.url),
  "utf8",
))
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function projectActualApiEvidenceRef(chunkId) {
  const actualChunk = actualManualChunks.find((chunk) => chunk.chunkId === chunkId);
  assert.ok(actualChunk, `actual Manual RAG chunk ${chunkId} must exist`);
  const summary = buildPresentedManualEvidenceSummary({
    query: "Safety Gateway manual evidence",
    chunks: [{
      ...actualChunk,
      score: { retrieval: 0.84, rerank: null, grounding: null },
    }],
    missSummary: { summary: "" },
    missTelemetry: {},
    makeExcerpt(chunk) {
      const compactText = String(chunk.text || "").replace(/\s+/gu, " ").trim();
      const excerpt = compactText.slice(0, 96);
      return `${excerpt}${excerpt.length < compactText.length ? "..." : ""}`;
    },
  });
  return summary.evidence[0].evidenceRef;
}

function createSafetyCommand(intent, slots) {
  return {
    requestId: `task5-real-${intent}`,
    rawText: intent,
    intent,
    confidence: 1,
    slots,
    slotProvenance: Object.fromEntries(Object.keys(slots).map((key) => [key, "explicit"])),
    speechAct: "command",
    actionability: {
      actionable: true,
      reason: "Task5 real decision fixture",
      source: "task5-real-fixture",
      intendedIntent: intent,
    },
    source: "task5-real-fixture",
  };
}

function createRealSafetyDecision({ evidenceRef, intent, slots }) {
  const capturedAt = "2026-08-08T00:00:00.000Z";
  const snapshot = createVehicleStateSnapshot({
    id: `task5-real-${evidenceRef.chunkId}`,
    source: "task5-real-fixture",
    simulated: true,
    capturedAt,
    freshnessMs: 0,
    values: {
      speedKph: 0,
      gear: "P",
      rearClearance: null,
      windowAntiPinchAvailable: false,
      rainDetected: false,
      driverBackrestAngle: 106,
    },
    capturedAtByField: { rearClearance: capturedAt },
  });
  return new SafetyGateway({}, { now: () => Date.parse(capturedAt) }).evaluate(
    createSafetyCommand(intent, slots),
    {
      vehicleStateSnapshot: snapshot,
      manualEvidence: {
        status: "hit",
        query: intent,
        evidence: [evidenceRef],
        telemetry: {
          evidenceContract: manualEligibility.MANUAL_EVIDENCE_REF_CONTRACT,
          retrievalMode: "vector-bge-m3",
          embeddingStatus: "embedded",
        },
      },
    },
  );
}

for (const safetyCase of [
  {
    chunkId: "es8-manual-chunk-0052",
    intent: "body.tailgate.open",
    slots: { open: true },
    topic: "tailgate-clearance",
  },
  {
    chunkId: "es8-manual-chunk-0065",
    intent: "body.window.setPosition",
    slots: { zone: "front_left", percent: 0 },
    topic: "window-anti-pinch",
  },
]) {
  const apiEvidenceRef = projectActualApiEvidenceRef(safetyCase.chunkId);
  const safetyDecision = createRealSafetyDecision({ ...safetyCase, evidenceRef: apiEvidenceRef });
  const publishedConstraint = safetyDecision.manualSafetyConstraints.find(
    (constraint) => constraint.topic === safetyCase.topic,
  );
  assert.ok(publishedConstraint, `${safetyCase.chunkId}: SafetyGateway must publish its canonical constraint`);
  assert.equal(
    apiEvidenceRef.excerpt.normalize("NFKC").replace(/\s+/gu, "")
      .includes(publishedConstraint.citationSpan.normalize("NFKC").replace(/\s+/gu, "")),
    false,
    `${safetyCase.chunkId}: the real 96-character API excerpt must not be hand-filled with the later reviewed span`,
  );
  const presentation = createManualSafetyEvidencePresentation(structuredClone(safetyDecision));
  assert.equal(presentation.visible, true, `${safetyCase.chunkId}: canonical constraint must remain visible after clone`);
  assert.deepEqual(presentation.constraints, [publishedConstraint], `${safetyCase.chunkId}: canonical constraint`);
  assert.deepEqual(presentation.evidence, [], `${safetyCase.chunkId}: short excerpt is not raw Safety evidence`);
}

const strictWindowRef = Object.freeze({
  sourceId: "nio-es8-user-manual-2026",
  sourceVersion: "2026",
  chunkId: "es8-manual-chunk-0065",
  pageStart: 79,
  pageEnd: 79,
  excerpt: "若车窗一键升窗和防夹保护功能失效（如低压蓄电池断电后重启），请按以下方法进行车窗初始化：",
  score: Object.freeze({ retrieval: 0.84, rerank: null, grounding: null }),
});
const publishedWindowConstraint = publishManualConstraints({
  status: "hit",
  evidence: [strictWindowRef],
}).published[0];
assert.ok(publishedWindowConstraint);

const safetyFixture = structuredClone({
  requestId: "safety-run-1",
  allowed: false,
  action: "reject",
  reason: "车窗防夹保护不可用",
  vehicleStateSnapshotId: "snapshot-1",
  vehicleStateAudit: { snapshotId: "snapshot-1" },
  manualEvidenceStatus: "hit",
  manualEvidenceQuery: "关闭主驾车窗",
  manualEvidenceSummary: {
    status: "hit",
    query: "关闭主驾车窗",
    evidenceCount: 1,
  },
  manualEvidence: [strictWindowRef],
  manualSafetyConstraints: [publishedWindowConstraint],
});
const clonedSafety = createManualSafetyEvidencePresentation(structuredClone(safetyFixture));
assert.equal(clonedSafety.visible, true, "a real structuredClone SafetyDecision must remain displayable");
assert.deepEqual(clonedSafety.evidence, [strictWindowRef]);
assert.deepEqual(clonedSafety.constraints, [publishedWindowConstraint]);

for (const [label, decision] of [
  ["empty", null],
  ["ordinary RAG", { manualEvidence: [strictWindowRef] }],
  ["copied canonical constraint shell", { allowed: false, action: "reject", manualSafetyConstraints: [structuredClone(publishedWindowConstraint)] }],
  ["unknown action", { ...safetyFixture, action: "override" }],
  ["empty reason", { ...safetyFixture, reason: "" }],
  ["snapshot audit mismatch", { ...safetyFixture, vehicleStateAudit: { snapshotId: "other" } }],
  ["status audit mismatch", { ...safetyFixture, manualEvidenceStatus: "miss" }],
  ["query audit mismatch", { ...safetyFixture, manualEvidenceSummary: { ...safetyFixture.manualEvidenceSummary, query: "other" } }],
  ["count audit mismatch", { ...safetyFixture, manualEvidenceSummary: { ...safetyFixture.manualEvidenceSummary, evidenceCount: 2 } }],
  ["wrong source version", { ...safetyFixture, manualEvidence: [{ ...strictWindowRef, sourceVersion: "forged" }] }],
  ["unknown chunk", {
    ...safetyFixture,
    manualEvidence: [{ ...strictWindowRef, chunkId: "es8-manual-chunk-9999" }],
    manualSafetyConstraints: [],
  }],
  ["wrong controlled page", { ...safetyFixture, manualEvidence: [{ ...strictWindowRef, pageStart: 78, pageEnd: 79 }] }],
  ["evidence without constraint", { ...safetyFixture, manualSafetyConstraints: [] }],
  ["extra uncontrolled evidence", {
    ...safetyFixture,
    manualEvidenceSummary: { ...safetyFixture.manualEvidenceSummary, evidenceCount: 2 },
    manualEvidence: [strictWindowRef, { ...strictWindowRef, chunkId: "es8-manual-chunk-9999" }],
  }],
  ["forged constraint topic", { ...safetyFixture, manualSafetyConstraints: [{ ...publishedWindowConstraint, topic: "forged" }] }],
]) {
  const presentation = createManualSafetyEvidencePresentation(structuredClone(decision));
  assert.equal(presentation.visible, false, label);
  assert.deepEqual(presentation.evidence, [], label);
  assert.deepEqual(presentation.constraints, [], label);
}

const appSource = await readFile(new URL("../../src/app/app.js", import.meta.url), "utf8");
assert.match(
  appSource,
  /retrieveManualEvidenceFromBrowser\s*\(\s*\{/,
  "the app browser retriever must call the injected production transport coordinator",
);
assert.doesNotMatch(
  appSource,
  /async function retrieveManualChunksFromBrowser[\s\S]*?await fetch\(\s*["']\/api\/manual-rag/,
  "the app must not retain a second inline Manual RAG transport path",
);
assert.match(
  appSource,
  /manual-evidence-boundary/,
  "fixed manual boundary speech must have independent provenance",
);
assert.match(
  appSource,
  /manualEvidenceBoundary\s*:/,
  "runtimeDebug must expose the fixed manual boundary speech for live acceptance",
);
assert.match(
  appSource,
  /manualSafetyCloneBoundary\s*:/,
  "runtimeDebug must expose the structural clone Safety acceptance result",
);

console.log("manual evidence link verification passed");
