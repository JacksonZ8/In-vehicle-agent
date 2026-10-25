import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatManualCitationForChunk } from "../../src/manual/manual-corpus-registry.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const topK = 3;
const expectedMode = "vector-bge-m3";
const expectedPolicy = { id: "nio-manual-evidence-eligibility", version: "1.1.0" };
const qualityThresholds = Object.freeze({
  minPrecision: 0.95,
  minClassificationRecall: 0.9,
  maxFalsePositiveRate: 0.05,
  minExpectedChunkRecallAt3: 0.75,
  minPositiveNdcgAt3: 0.75,
  minCitationCorrectness: 1,
  minReasonAccuracy: 0.875,
});

const [positiveGolden, eligibilityGolden, chunks] = await Promise.all([
  readJson(path.join(root, "data/manual-rag/es8-manual-rag-golden-v1.json")),
  readJson(path.join(root, "data/manual-rag/manual-evidence-eligibility-golden-1.0.0.json")),
  readJsonl(path.join(root, "data/manual-rag/es8-manual-chunks.jsonl")),
]);
const chunksById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
if (process.argv.includes("--self-check")) {
  assert.equal(positiveGolden.cases.length, 12);
  assert.ok(eligibilityGolden.negativeCases.length >= 8);
  assert.equal(eligibilityGolden.policyId, expectedPolicy.id);
  assert.equal(eligibilityGolden.policyVersion, expectedPolicy.version);
  assert.deepEqual(qualityThresholds, {
    minPrecision: 0.95,
    minClassificationRecall: 0.9,
    maxFalsePositiveRate: 0.05,
    minExpectedChunkRecallAt3: 0.75,
    minPositiveNdcgAt3: 0.75,
    minCitationCorrectness: 1,
    minReasonAccuracy: 0.875,
  });
  for (const item of positiveGolden.cases) {
    for (const expected of item.expectedChunks) {
      const actual = chunksById.get(expected.chunkId);
      assert.ok(actual, `${item.id}: self-check missing chunk ${expected.chunkId}`);
      assert.equal(actual.sourceId, eligibilityGolden.sourceId);
      assert.equal(actual.pageStart, expected.pageStart);
      assert.equal(actual.pageEnd, expected.pageEnd);
      assert.equal(actual.sectionTitle, expected.sectionTitle);
      assert.equal(citationFor(actual), citationFor(expected));
    }
  }
  for (const item of eligibilityGolden.negativeCases) {
    assert.ok(["low-confidence", "not-applicable", "not-answerable", "corpus-artifact-unavailable"].includes(item.expectedReason), `${item.id}: invalid expected reason`);
    if (item.expectedReason === "corpus-artifact-unavailable") {
      assert.equal(item.expectedCorpusArtifactStatus, "unavailable", `${item.id}: unavailable corpus fixture must declare artifact status`);
      assert.equal(item.expectedGeneratedRows, 0, `${item.id}: unavailable corpus fixture must declare zero embedding rows`);
      assert.equal(item.expectedChunkCount, 0, `${item.id}: unavailable corpus fixture must declare zero chunks`);
    }
  }
  console.log("online manual eligibility evaluator fixture self-check passed");
  process.exit(0);
}
const cases = [];

for (const item of positiveGolden.cases) cases.push(await evaluatePositive(item));
for (const item of eligibilityGolden.negativeCases) cases.push(await evaluateNegative(item));

const positives = cases.filter((item) => item.label === "positive");
const negatives = cases.filter((item) => item.label === "negative");
const tp = positives.filter((item) => item.status === "hit").length;
const fn = positives.length - tp;
const fp = negatives.filter((item) => item.status === "hit").length;
const tn = negatives.length - fp;
const expectedChunkCount = positives.reduce((sum, item) => sum + item.expectedChunkIds.length, 0);
const retrievedExpectedChunkCount = positives.reduce((sum, item) => sum + item.retrievedExpectedChunkIds.length, 0);
const returnedCitationCount = cases.reduce((sum, item) => sum + item.returnedCitationCount, 0);
const validCitationCount = cases.reduce((sum, item) => sum + item.validCitationCount, 0);
const reasonMatchCount = negatives.filter((item) => item.reasonMatches).length;
const report = {
  evaluationVersion: `${eligibilityGolden.version}-online-vector`,
  checkedAt: new Date().toISOString(),
  baseUrl,
  topK,
  requiredRetrievalMode: expectedMode,
  requiredEligibilityPolicy: expectedPolicy,
  thresholds: qualityThresholds,
  metrics: {
    positiveCases: positives.length,
    negativeCases: negatives.length,
    precision: ratio(tp, tp + fp),
    classificationRecall: ratio(tp, tp + fn),
    expectedChunkRecallAt3: ratio(retrievedExpectedChunkCount, expectedChunkCount),
    falsePositiveRate: ratio(fp, fp + tn),
    positiveNdcgAt3: ratio(positives.reduce((sum, item) => sum + item.ndcgAt3, 0), positives.length),
    citationCorrectness: ratio(validCitationCount, returnedCitationCount),
    reasonAccuracy: ratio(reasonMatchCount, negatives.length),
  },
  cases,
};

console.log(JSON.stringify(report, null, 2));
assert.equal(positives.length, 12, "online vector evaluation must retain all 12 positive cases");
assert.ok(negatives.length >= 8, "online vector evaluation needs at least 8 negative/OOD cases");
assert.ok(report.metrics.precision >= qualityThresholds.minPrecision, `precision ${report.metrics.precision} is below ${qualityThresholds.minPrecision}`);
assert.ok(report.metrics.classificationRecall >= qualityThresholds.minClassificationRecall, `classification recall ${report.metrics.classificationRecall} is below ${qualityThresholds.minClassificationRecall}`);
assert.ok(report.metrics.falsePositiveRate <= qualityThresholds.maxFalsePositiveRate, `false-positive rate ${report.metrics.falsePositiveRate} exceeds ${qualityThresholds.maxFalsePositiveRate}`);
assert.ok(report.metrics.expectedChunkRecallAt3 >= qualityThresholds.minExpectedChunkRecallAt3, `expected-chunk Recall@3 ${report.metrics.expectedChunkRecallAt3} is below ${qualityThresholds.minExpectedChunkRecallAt3}`);
assert.ok(report.metrics.positiveNdcgAt3 >= qualityThresholds.minPositiveNdcgAt3, `positive nDCG@3 ${report.metrics.positiveNdcgAt3} is below ${qualityThresholds.minPositiveNdcgAt3}`);
assert.equal(report.metrics.citationCorrectness, qualityThresholds.minCitationCorrectness, "returned citation metadata differs from authoritative chunks");
assert.ok(report.metrics.reasonAccuracy >= qualityThresholds.minReasonAccuracy, `negative miss-reason accuracy ${report.metrics.reasonAccuracy} is below ${qualityThresholds.minReasonAccuracy}`);

async function evaluatePositive(item) {
  const { body, elapsedMs } = await callApi(item.id, item.query);
  assertVectorContract(item.id, body, item);
  const evidence = normalizeEvidence(body.evidence);
  const expectedChunkIds = item.expectedChunks.map((entry) => entry.chunkId);
  const returnedChunkIds = evidence.map((entry) => entry.chunkId);
  const retrievedExpectedChunkIds = expectedChunkIds.filter((id) => returnedChunkIds.includes(id));
  const missingExpected = expectedChunkIds.filter((id) => !returnedChunkIds.includes(id));
  const expectedCitationMismatches = item.expectedChunks.flatMap((expected) => {
    const returned = evidence.find((entry) => entry.chunkId === expected.chunkId);
    return returned && returned.citation !== citationFor(expected)
      ? [{ chunkId: expected.chunkId, expected: citationFor(expected), actual: returned.citation }]
      : [];
  });
  const citationChecks = evidence.map(validateCitation);
  const gains = evidence.map((entry) => expectedChunkIds.includes(entry.chunkId) ? 1 : 0);
  return {
    id: item.id,
    label: "positive",
    query: item.query,
    elapsedMs,
    status: body.status,
    retrievalMode: body.telemetry.retrievalMode,
    expectedChunkIds,
    retrievedExpectedChunkIds,
    missingExpected,
    expectedCitationMismatches,
    returnedCitationCount: citationChecks.length,
    validCitationCount: citationChecks.filter(Boolean).length,
    ndcgAt3: ndcg(gains, expectedChunkIds.length),
    topK: evidence.map(compactEvidence),
    candidateEligibility: compactDecisions(body.telemetry.candidateDecisions),
  };
}

async function evaluateNegative(item) {
  const { body, elapsedMs } = await callApi(item.id, item.query);
  assertVectorContract(item.id, body);
  const evidence = normalizeEvidence(body.evidence);
  const actualReason = body.reason || body.telemetry.missReason || "";
  const decisions = compactDecisions(body.telemetry.candidateDecisions);
  const citationChecks = evidence.map(validateCitation);
  return {
    id: item.id,
    label: "negative",
    query: item.query,
    elapsedMs,
    status: body.status,
    retrievalMode: body.telemetry.retrievalMode,
    expectedReason: item.expectedReason,
    actualReason,
    reasonMatches: actualReason === item.expectedReason,
    unexpectedEvidenceOnMiss: body.status === "miss" && evidence.length > 0,
    eligibleCandidateCount: decisions.filter((entry) => entry.eligible).length,
    expectedChunkIds: [],
    retrievedExpectedChunkIds: [],
    returnedCitationCount: citationChecks.length,
    validCitationCount: citationChecks.filter(Boolean).length,
    ndcgAt3: 1,
    topK: evidence.map(compactEvidence),
    candidateEligibility: decisions,
  };
}

async function callApi(id, query) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/manual-rag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, topK }),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`${id}: response is not JSON: ${raw.slice(0, 200)}`); }
  assert.equal(response.status, 200, `${id}: HTTP ${response.status}: ${raw.slice(0, 300)}`);
  return { body, elapsedMs: Math.round(performance.now() - startedAt) };
}

function assertVectorContract(id, body, item) {
  const selection = body.telemetry?.manualCorpusSelection;
  if (item.expectedReason === "corpus-artifact-unavailable") {
    assert.equal(body.reason || body.telemetry?.missReason, "corpus-artifact-unavailable", `${id}: unavailable corpus reason mismatch`);
    assert.equal(selection?.corpusId, item.expectedCorpusId, `${id}: unavailable corpus id mismatch`);
    assert.equal(body.telemetry?.corpusArtifactStatus, item.expectedCorpusArtifactStatus, `${id}: unavailable corpus artifact status mismatch`);
    assert.equal(Number(body.telemetry?.generatedRows), item.expectedGeneratedRows, `${id}: unavailable corpus must not load embedding rows`);
    assert.equal(Number(body.telemetry?.chunkCount), item.expectedChunkCount, `${id}: unavailable corpus must not load chunks`);
    return;
  }
  assert.equal(body.telemetry?.retrievalMode, expectedMode, `${id}: keyword/error fallback is not accepted as vector evidence`);
  assert.equal(body.telemetry?.embeddingStatus, "embedded", `${id}: real embedded index is required`);
  assert.equal(body.telemetry?.eligibilityPolicy?.id, expectedPolicy.id, `${id}: eligibility policy id mismatch`);
  assert.equal(body.telemetry?.eligibilityPolicy?.version, expectedPolicy.version, `${id}: eligibility policy version mismatch`);
  if (selection?.applicable === false) {
    assert.equal(body.reason || body.telemetry?.missReason, "not-applicable", `${id}: selector skip should be not-applicable`);
    assert.equal(Number(body.telemetry?.generatedRows), 0, `${id}: not-applicable selector should not load ES8 embedding rows`);
    assert.equal(Number(body.telemetry?.chunkCount), 0, `${id}: not-applicable selector should not load ES8 chunks`);
  } else {
    assert.ok(Number(body.telemetry?.generatedRows) === 411, `${id}: expected 411 real embedding rows`);
  }
  assert.ok(Array.isArray(body.telemetry?.candidateDecisions), `${id}: candidate decisions missing`);
  assert.equal(
    Number(body.telemetry?.acceptedCount) + Number(body.telemetry?.rejectedCount),
    body.telemetry.candidateDecisions.length,
    `${id}: accepted/rejected counts do not cover all candidates`,
  );
  assert.ok(!body.telemetry?.fallbackReason, `${id}: vector request contains fallbackReason`);
}

function normalizeEvidence(value) { return Array.isArray(value) ? value.slice(0, topK) : []; }
function compactEvidence(entry) { return { rank: entry.rank, chunkId: entry.chunkId, score: entry.score, citation: entry.citation, eligible: entry.eligibility?.eligible, eligibilityReasons: entry.eligibility?.reasons || [] }; }
function compactDecisions(value) { return (Array.isArray(value) ? value : []).map((entry) => ({ chunkId: entry.chunkId, eligible: entry.eligible === true, reasons: Array.isArray(entry.reasons) ? entry.reasons : [], score: entry.metrics?.score, lexicalCoverage: entry.metrics?.lexicalCoverage, entityCoverage: entry.metrics?.entityCoverage, answerabilitySignal: entry.metrics?.answerabilitySignal })); }
function validateCitation(entry) { const chunk = chunksById.get(entry.chunkId); return Boolean(chunk) && entry.sourceId === chunk.sourceId && entry.title === chunk.title && entry.pageStart === chunk.pageStart && entry.pageEnd === (chunk.pageEnd || chunk.pageStart) && entry.sectionTitle === chunk.sectionTitle && entry.citation === citationFor(chunk); }
function citationFor(chunk) { return formatManualCitationForChunk(chunk); }
function dcg(gains) { return gains.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0); }
function ndcg(gains, relevantCount) { const ideal = dcg(Array.from({ length: Math.min(topK, relevantCount) }, () => 1)); return ideal ? Number((dcg(gains) / ideal).toFixed(6)) : 1; }
function ratio(a, b) { return b ? Number((a / b).toFixed(6)) : 0; }
async function readJson(filePath) { return JSON.parse(await readFile(filePath, "utf8")); }
async function readJsonl(filePath) { return (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse); }
