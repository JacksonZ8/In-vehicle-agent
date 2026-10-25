import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MANUAL_CONSTRAINT_REGISTRY,
  buildReviewedCitationProofs,
  computeManualConstraintRegistryDigest,
  publishManualConstraints,
  verifyManualConstraintRegistry,
} from "../../src/manual/manual-constraint-registry.js";
import { buildManualEvidenceSummary, retrieveManualChunks } from "../../src/manual/manual-rag-retriever.js";

const chunks = fs.readFileSync(new URL("../../data/manual-rag/es8-manual-chunks.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map(JSON.parse);
const golden = JSON.parse(fs.readFileSync(new URL("../../data/manual-rag/manual-constraint-registry-golden-1.0.0.json", import.meta.url), "utf8"));
const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
const asEvidence = (chunk, overrides = {}) => ({
  chunkId: chunk.chunkId,
  sourceId: chunk.sourceId,
  manualVersion: chunk.sourceId,
  title: chunk.title,
  sectionTitle: chunk.sectionTitle,
  pageStart: chunk.pageStart,
  pageEnd: chunk.pageEnd,
  excerpt: chunk.text,
  reviewedCitationSpans: buildReviewedCitationProofs(chunk),
  ...overrides,
});
const publish = (evidence, registry) => publishManualConstraints({ status: "hit", evidence }, registry);
const resigned = (mutate) => {
  const registry = structuredClone(MANUAL_CONSTRAINT_REGISTRY);
  mutate(registry);
  registry.integrity.digest = computeManualConstraintRegistryDigest(registry);
  return registry;
};

const integrity = verifyManualConstraintRegistry();
assert.equal(integrity.valid, true);
assert.match(integrity.trustBoundary, /no human approval/);
assert.equal(Object.isFrozen(MANUAL_CONSTRAINT_REGISTRY), true);
assert.equal(MANUAL_CONSTRAINT_REGISTRY.entries.length, 2);

for (const testCase of golden.positiveCases) {
  const result = publish([asEvidence(byId.get(testCase.chunkId))]);
  assert.equal(result.published.length, 1, testCase.id);
  assert.equal(result.published[0].id, testCase.expectedRegistryId);
  assert.equal(result.published[0].citationSpan.length > 0, true);
  assert.equal(result.published[0].reviewStatus, "approved-for-local-dev");
  assert.equal(result.published[0].humanReviewed, false);
  assert.equal(result.published[0].productionApproved, false);
  assert.equal(result.telemetry.integrity.valid, true);
  assert.equal(result.telemetry.humanReviewed, false);
  assert.equal(result.telemetry.productionApproved, false);
}

const strictTailgateRef = Object.freeze({
  sourceId: "nio-es8-user-manual-2026",
  sourceVersion: "2026",
  chunkId: "es8-manual-chunk-0052",
  pageStart: 62,
  pageEnd: 63,
  excerpt: "打开或关闭尾门前，请确认尾门的开/闭路径附近无障碍物。",
  score: Object.freeze({ retrieval: 0.81, rerank: null, grounding: null }),
});
const strictPublication = publish([strictTailgateRef]);
assert.equal(strictPublication.published.length, 1, "strict server EvidenceRef must retain the local approved constraint");
assert.equal(strictPublication.published[0].id, "es8-tailgate-clear-path");
assert.equal(strictPublication.candidates[0].evidenceContract, "manual-evidence-ref@1.0.0");
assert.match(strictPublication.telemetry.contentBinding, /local constraint registry allowlist/);

for (const [id, pageStart, pageEnd] of [
  ["strict-broad-page", 1, 999],
  ["strict-wrong-page", 61, 61],
]) {
  const result = publish([{ ...strictTailgateRef, pageStart, pageEnd }]);
  assert.equal(result.published.length, 0, `${id} must not bind to the local reviewed page range`);
  assert.equal(result.candidates[0].published, false, id);
  assert.ok(result.candidates[0].reasons.includes("citation-page-range-mismatch"), id);
}

const forgedRichEvidence = {
  ...strictTailgateRef,
  manualVersion: "nio-es8-user-manual-2026",
  title: "browser forged title",
  reviewedCitationSpans: [{ registryEntryId: "es8-tailgate-clear-path" }],
};
const forgedPublication = publish([forgedRichEvidence]);
assert.equal(forgedPublication.published.length, 0, "browser-added rich fields must not bypass the strict ref or legacy proof boundary");
assert.ok(forgedPublication.candidates[0].reasons.length > 0);

const alteredFullChunk = { ...byId.get("es8-manual-chunk-0052"), text: `${byId.get("es8-manual-chunk-0052").text}\n未审核的其他内容变更` };
assert.equal(buildReviewedCitationProofs(alteredFullChunk).length, 0, "retained span with altered full chunk must not produce binding");
assert.equal(publish([asEvidence(alteredFullChunk)]).published.length, 0, "retained span with altered full chunk must not publish");

for (const [query, chunkId] of [["尾门路径障碍物", "es8-manual-chunk-0052"], ["车窗防夹失效初始化", "es8-manual-chunk-0065"]]) {
  const retrieved = await retrieveManualChunks(query, { topK: 8 });
  const chunk = retrieved.find((item) => item.chunkId === chunkId);
  assert.ok(chunk, `${chunkId} must be returned by the real keyword retriever`);
  assert.equal(chunk.reviewedCitationSpans.length, 1, `${chunkId} carries full-chunk reviewed proof`);
  const apiShape = await buildManualEvidenceSummary(query, { topK: 8 });
  const evidence = JSON.parse(JSON.stringify(apiShape)).evidence.find((item) => item.chunkId === chunkId);
  assert.ok(evidence, `${chunkId} survives API JSON shape`);
  assert.equal(evidence.reviewedCitationSpans.length, 1, `${chunkId} proof survives API JSON shape`);
  assert.equal(publish([evidence]).published.length, 1, `${chunkId} API evidence can publish`);
  const proofless = { ...evidence, reviewedCitationSpans: [], excerpt: evidence.excerpt.slice(0, 32) };
  assert.equal(publish([proofless]).published.length, 0, `${chunkId} truncated excerpt without proof cannot publish`);
}

const tailgate = byId.get("es8-manual-chunk-0052");
const window = byId.get("es8-manual-chunk-0065");
const directory = chunks.find((chunk) => /目录/.test(chunk.sectionTitle || chunk.category || "")) || chunks[0];
const negativeEvidence = [
  ["unknown-chunk", asEvidence(tailgate, { chunkId: "es8-manual-chunk-9999" })],
  ["same-keywords-different-subject", asEvidence(tailgate, { chunkId: "es8-manual-chunk-0065", excerpt: "尾门防夹与车窗防夹关键词同时出现。" })],
  ["negation-reversal", asEvidence(window, { excerpt: "若防夹保护功能失效，无需进行车窗初始化。", reviewedCitationSpans: [] })],
  ["exception-reversal", asEvidence(tailgate, { excerpt: "除非有人，否则打开尾门前无需确认路径附近障碍物。", reviewedCitationSpans: [] })],
  ["missing-reviewed-span", asEvidence(window, { excerpt: "本节介绍车窗防夹功能。", reviewedCitationSpans: [] })],
  ["wrong-manual-version", asEvidence(window, { manualVersion: "nio-es8-user-manual-2025" })],
  ["wrong-source", asEvidence(window, { sourceId: "nio-es6-user-manual-2026" })],
  ["directory-noise", asEvidence(directory)],
];
for (const [id, evidence] of negativeEvidence) {
  const result = publish([evidence]);
  assert.equal(result.published.length, 0, id);
  assert.equal(result.candidates.length, 1, `${id} retains candidate audit`);
  assert.equal(result.candidates[0].published, false, id);
}

const malformedRegistries = [
  ["registry-tampered", (() => { const value = structuredClone(MANUAL_CONSTRAINT_REGISTRY); value.entries[0].citation.span += "篡改"; return value; })()],
  ["registry-missing-field", resigned((value) => { delete value.entries[0].subject; })],
  ["registry-unknown-effect", resigned((value) => { value.entries[0].effect = "permit"; })],
  ["registry-not-approved", resigned((value) => { value.entries[0].status = "draft"; })],
];
for (const [id, registry] of malformedRegistries) {
  const result = publish([asEvidence(tailgate)], registry);
  assert.equal(result.published.length, 0, id);
  assert.equal(result.telemetry.integrity.valid, false, id);
}

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  golden: `${golden.goldenId}@${golden.version}`,
  registry: `${MANUAL_CONSTRAINT_REGISTRY.registryId}@${MANUAL_CONSTRAINT_REGISTRY.version}`,
  digest: integrity.actualDigest,
  positiveCases: golden.positiveCases.length,
  negativeCases: golden.negativeCases.length,
  result: "passed",
}, null, 2));
