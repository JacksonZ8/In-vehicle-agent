import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { retrieveManualChunks } from "../../src/manual/manual-rag-retriever.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const positive = JSON.parse(await readFile(path.join(root, "data/manual-rag/es8-manual-rag-golden-v1.json"), "utf8"));
const eligibility = JSON.parse(await readFile(path.join(root, "data/manual-rag/manual-evidence-eligibility-golden-1.0.0.json"), "utf8"));
const chunks = (await readFile(path.join(root, "data/manual-rag/es8-manual-chunks.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const chunksById = new Map(chunks.map((item) => [item.chunkId, item]));
const cases = [];

for (const item of positive.cases) {
  const evidence = await retrieveManualChunks(item.query, { topK: 3 });
  const relevant = new Set(item.expectedChunks.map((entry) => entry.chunkId));
  const gains = evidence.map((entry) => relevant.has(entry.chunkId) ? 1 : 0);
  cases.push({ id: item.id, label: "positive", query: item.query, status: evidence.length ? "hit" : "miss", returned: evidence.map((entry) => entry.chunkId), citationCorrect: evidence.every((entry) => citationMatches(entry, chunksById.get(entry.chunkId))), ndcgAt3: ndcg(gains, Math.min(3, relevant.size)), telemetry: evidence.metadata });
}
for (const item of eligibility.negativeCases) {
  const evidence = await retrieveManualChunks(item.query, { topK: 3 });
  cases.push({ id: item.id, label: "negative", query: item.query, status: evidence.length ? "hit" : "miss", returned: evidence.map((entry) => entry.chunkId), expectedReason: item.expectedReason, actualReason: evidence.metadata.missReason, citationCorrect: evidence.every((entry) => citationMatches(entry, chunksById.get(entry.chunkId))), ndcgAt3: evidence.length ? 0 : 1, telemetry: evidence.metadata });
}

const positives = cases.filter((item) => item.label === "positive");
const negatives = cases.filter((item) => item.label === "negative");
const tp = positives.filter((item) => item.status === "hit").length;
const fn = positives.length - tp;
const fp = negatives.filter((item) => item.status === "hit").length;
const tn = negatives.length - fp;
const returnedCitationCount = cases.reduce((sum, item) => sum + item.returned.length, 0);
const validCitationCount = cases.reduce((sum, item) => sum + (item.citationCorrect ? item.returned.length : 0), 0);
const report = {
  evaluationVersion: eligibility.version,
  retrievalMode: "keyword-fallback (real corpus; no fabricated embeddings)",
  metrics: {
    positiveCases: positives.length,
    negativeCases: negatives.length,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, fp + tn),
    ndcgAt3: ratio(positives.reduce((sum, item) => sum + item.ndcgAt3, 0), positives.length),
    citationCorrectness: ratio(validCitationCount, returnedCitationCount),
  },
  cases,
};
console.log(JSON.stringify(report, null, 2));
assert.equal(positives.length, 12);
assert.ok(negatives.length >= 8);
assert.ok(report.metrics.precision >= 0.95);
assert.ok(report.metrics.recall >= 0.9);
assert.ok(report.metrics.falsePositiveRate <= 0.05);
assert.ok(report.metrics.ndcgAt3 >= 0.75);
assert.equal(report.metrics.citationCorrectness, 1);

function citationMatches(entry, chunk) { return Boolean(chunk) && entry.sourceId === chunk.sourceId && entry.pageStart === chunk.pageStart && entry.pageEnd === (chunk.pageEnd || chunk.pageStart) && entry.sectionTitle === chunk.sectionTitle; }
function dcg(gains) { return gains.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0); }
function ndcg(gains, idealRelevant) { const ideal = dcg(Array.from({ length: idealRelevant }, () => 1)); return ideal ? Number((dcg(gains) / ideal).toFixed(6)) : 1; }
function ratio(a, b) { return b ? Number((a / b).toFixed(6)) : 0; }
