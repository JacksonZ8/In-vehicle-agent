import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatManualCitationForChunk } from "../../src/manual/manual-corpus-registry.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const goldenPath = path.join(root, "data/manual-rag/es8-manual-rag-golden-v1.json");
const chunksPath = path.join(root, "data/manual-rag/es8-manual-chunks.jsonl");
const sourcePath = path.join(root, "data/manual-rag/es8-manual-source.json");
const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const topK = integerEnv("NIO_MANUAL_RAG_EVAL_TOP_K", 3, 1, 8);
const minRecall = ratioEnv("NIO_MANUAL_RAG_MIN_RECALL", 0.75);
const minCitationHitRate = ratioEnv("NIO_MANUAL_RAG_MIN_CITATION_HIT_RATE", 0.75);

async function main() {
  const [golden, source, chunks] = await Promise.all([
    readJson(goldenPath),
    readJson(sourcePath),
    readJsonl(chunksPath),
  ]);
  const chunksById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  validateGolden(golden, source, chunksById);

  const results = [];
  for (const item of golden.cases) results.push(await evaluateCase(item, chunksById));

  const expectedCount = results.reduce((sum, item) => sum + item.expectedChunkIds.length, 0);
  const retrievedExpectedCount = results.reduce((sum, item) => sum + item.retrievedExpectedChunkIds.length, 0);
  const citationHitCount = results.filter((item) => item.citationHit).length;
  const returnedCitationCount = results.reduce((sum, item) => sum + item.returnedCitationCount, 0);
  const validReturnedCitationCount = results.reduce((sum, item) => sum + item.validReturnedCitationCount, 0);
  const recallAtK = divide(retrievedExpectedCount, expectedCount);
  const citationHitRate = divide(citationHitCount, results.length);
  const citationIntegrityRate = divide(validReturnedCitationCount, returnedCitationCount);
  const categories = Object.fromEntries(
    [...new Set(results.map((item) => item.category))].map((category) => {
      const cases = results.filter((item) => item.category === category);
      const categoryExpected = cases.reduce((sum, item) => sum + item.expectedChunkIds.length, 0);
      const categoryRetrieved = cases.reduce((sum, item) => sum + item.retrievedExpectedChunkIds.length, 0);
      return [category, {
        cases: cases.length,
        recallAtK: divide(categoryRetrieved, categoryExpected),
        citationHitRate: divide(cases.filter((item) => item.citationHit).length, cases.length),
      }];
    }),
  );

  const report = {
    evaluationVersion: golden.version,
    checkedAt: new Date().toISOString(),
    baseUrl,
    topK,
    thresholds: { minRecallAtK: minRecall, minCitationHitRate },
    metrics: {
      caseCount: results.length,
      expectedChunkCount: expectedCount,
      retrievedExpectedChunkCount: retrievedExpectedCount,
      recallAtK,
      citationHitCount,
      citationHitRate,
      citationIntegrityRate,
    },
    categories,
    cases: results,
  };
  console.log(JSON.stringify(report, null, 2));

  assert.ok(recallAtK >= minRecall, `Recall@${topK} ${recallAtK} is below ${minRecall}`);
  assert.ok(
    citationHitRate >= minCitationHitRate,
    `citation hit rate ${citationHitRate} is below ${minCitationHitRate}`,
  );
  assert.equal(citationIntegrityRate, 1, "returned citation metadata does not match the authoritative chunks");
}

async function evaluateCase(item, chunksById) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/manual-rag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: item.query, topK }),
    signal: AbortSignal.timeout(15_000),
  });
  const rawBody = await response.text();
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new Error(`${item.id}: response is not JSON: ${rawBody.slice(0, 200)}`);
  }
  assert.equal(response.status, 200, `${item.id}: HTTP ${response.status}: ${rawBody.slice(0, 300)}`);
  assert.equal(body.status, "hit", `${item.id}: expected hit, got ${body.status}`);

  const evidence = Array.isArray(body.evidence) ? body.evidence.slice(0, topK) : [];
  const expectedChunkIds = item.expectedChunks.map((expected) => expected.chunkId);
  const returnedChunkIds = evidence.map((entry) => entry.chunkId);
  const retrievedExpectedChunkIds = expectedChunkIds.filter((chunkId) => returnedChunkIds.includes(chunkId));
  const citationChecks = evidence.map((entry) => validateReturnedCitation(entry, chunksById));
  const expectedCitations = item.expectedChunks.map((expected) => citationFor(expected));
  const citationHit = evidence.some(
    (entry) => expectedChunkIds.includes(entry.chunkId) && expectedCitations.includes(entry.citation),
  );

  return {
    id: item.id,
    category: item.category,
    query: item.query,
    elapsedMs: Math.round(performance.now() - startedAt),
    status: body.status,
    retrievalMode: body.telemetry?.retrievalMode,
    embeddingStatus: body.telemetry?.embeddingStatus,
    expectedChunkIds,
    expectedCitations,
    retrievedExpectedChunkIds,
    recallAtK: divide(retrievedExpectedChunkIds.length, expectedChunkIds.length),
    citationHit,
    returnedCitationCount: citationChecks.length,
    validReturnedCitationCount: citationChecks.filter(Boolean).length,
    topK: evidence.map((entry) => ({
      rank: entry.rank,
      chunkId: entry.chunkId,
      pageStart: entry.pageStart,
      pageEnd: entry.pageEnd,
      sectionTitle: entry.sectionTitle,
      citation: entry.citation,
      score: entry.score,
    })),
  };
}

function validateGolden(golden, source, chunksById) {
  assert.equal(golden.sourceId, source.sourceId, "golden sourceId differs from manual source");
  assert.equal(
    golden.chunkingVersion,
    source.chunkingVersion,
    "golden chunkingVersion differs from manual source",
  );
  assert.ok(Array.isArray(golden.cases) && golden.cases.length > 0, "golden cases are empty");
  const ids = new Set();
  for (const item of golden.cases) {
    assert.ok(item.id && !ids.has(item.id), `duplicate or missing golden case id: ${item.id}`);
    ids.add(item.id);
    assert.ok(item.category && item.query, `${item.id}: category and query are required`);
    assert.ok(Array.isArray(item.expectedChunks) && item.expectedChunks.length, `${item.id}: expectedChunks missing`);
    for (const expected of item.expectedChunks) {
      const actual = chunksById.get(expected.chunkId);
      assert.ok(actual, `${item.id}: unknown expected chunk ${expected.chunkId}`);
      for (const field of ["pageStart", "pageEnd", "sectionTitle"]) {
        assert.equal(
          expected[field],
          actual[field],
          `${item.id}: ${expected.chunkId} ${field} differs from authoritative chunk`,
        );
      }
      assert.equal(actual.sourceId, golden.sourceId, `${item.id}: sourceId mismatch`);
    }
  }
  for (const category of ["操作", "安全", "故障", "保养"]) {
    assert.ok(golden.cases.filter((item) => item.category === category).length >= 3, `${category}: needs >= 3 cases`);
  }
}

function validateReturnedCitation(entry, chunksById) {
  const chunk = chunksById.get(entry.chunkId);
  if (!chunk) return false;
  return entry.pageStart === chunk.pageStart
    && entry.pageEnd === chunk.pageEnd
    && entry.sectionTitle === chunk.sectionTitle
    && entry.citation === citationFor(chunk);
}

function citationFor(chunk) {
  return formatManualCitationForChunk(chunk);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonl(filePath) {
  return (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function integerEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function ratioEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function divide(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(6)) : 0;
}

main().catch((error) => {
  console.error(`evaluate-manual-rag-quality failed: ${error.message}`);
  process.exitCode = 1;
});
