import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createManualRagConsumerEvidence,
  filterManualEvidence,
  MANUAL_EVIDENCE_ELIGIBILITY_POLICY,
} from "../../src/manual/manual-evidence-eligibility.js";
import { buildManualEvidenceSummary, retrieveManualChunks } from "../../src/manual/manual-rag-retriever.js";
import { retrieveManualVectorChunks } from "../../src/manual/manual-rag-vector-retriever.js";
import * as manualRagPresentation from "../../src/manual/manual-rag-presentation.js";
import {
  formatManualCitationForChunk,
  formatManualCitationForDisplay,
  formatManualMissSummary,
  getManualCorpusArtifacts,
  MANUAL_CORPUS_REGISTRY,
  selectManualCorpusForContext,
} from "../../src/manual/manual-corpus-registry.js";

let manualEvidenceRef = {};
try {
  manualEvidenceRef = await import("../../src/manual/manual-evidence-ref.js");
} catch {
  // The assertions below turn a missing Task 2 module into a focused RED result.
}

assert.equal(
  typeof manualEvidenceRef.createManualEvidenceRef,
  "function",
  "Task 2 must export createManualEvidenceRef",
);
assert.equal(
  typeof manualEvidenceRef.validateManualEvidenceRef,
  "function",
  "Task 2 must export validateManualEvidenceRef",
);
assert.equal(
  typeof manualRagPresentation.resolveManualRagPresentationStatus,
  "function",
  "Task 2 must define the five-state presentation boundary",
);

const {
  createManualEvidenceRef,
  validateManualEvidenceRef,
} = manualEvidenceRef;
const {
  buildManualEvidenceSummary: buildPresentedManualEvidenceSummary,
  MANUAL_RAG_PRESENTATION_STATES,
  resolveManualRagPresentationStatus,
} = manualRagPresentation;

const validEvidenceRef = createManualEvidenceRef({
  sourceId: "nio-es8-user-manual-2026",
  sourceVersion: "2026",
  chunkId: "es8-manual-chunk-0055",
  pageStart: 66,
  pageEnd: 66,
  excerpt: "您可以使用以下两种方式设置并记忆尾门的开启高度。",
  retrievalScore: 0.72,
});
assert.deepEqual(Object.keys(validEvidenceRef), [
  "sourceId",
  "sourceVersion",
  "chunkId",
  "pageStart",
  "pageEnd",
  "excerpt",
  "score",
]);
assert.deepEqual(validEvidenceRef.score, {
  retrieval: 0.72,
  rerank: null,
  grounding: null,
});
assert.equal(validateManualEvidenceRef(validEvidenceRef, MANUAL_CORPUS_REGISTRY).valid, true);

for (const [name, mutation, expectedReason] of [
  ["source", { sourceId: "model-invented-source" }, "source-not-registered"],
  ["version", { sourceVersion: "model-invented-version" }, "source-version-mismatch"],
  ["chunk", { chunkId: "model-invented-chunk" }, "chunk-not-registered"],
  ["page start", { pageStart: 65 }, "chunk-page-mismatch"],
  ["page end", { pageEnd: 67 }, "chunk-page-mismatch"],
]) {
  const validation = validateManualEvidenceRef(
    { ...validEvidenceRef, ...mutation },
    MANUAL_CORPUS_REGISTRY,
  );
  assert.equal(validation.valid, false, name);
  assert.equal(validation.reason, expectedReason, name);
}
const unexpectedField = validateManualEvidenceRef(
  { ...validEvidenceRef, modelCitation: "p.999" },
  MANUAL_CORPUS_REGISTRY,
);
assert.equal(unexpectedField.valid, false);
assert.equal(unexpectedField.reason, "unexpected-field:modelCitation");

function assertInvalidConsumerContract(result, label) {
  const consumed = createManualRagConsumerEvidence({
    query: "ES8 尾门",
    runId: `run-${label}`,
    telemetry: {},
    ...result,
  });
  assert.equal(consumed.metadata.status, "unavailable", `${label}: status must fail closed`);
  assert.equal(consumed.metadata.reason, "invalid-evidence-ref-contract", `${label}: reason must name the contract`);
  assert.deepEqual([...consumed], [], `${label}: invalid refs must be discarded`);
}

assertInvalidConsumerContract({ status: "hit", evidence: [] }, "empty-hit");
assertInvalidConsumerContract({ status: "miss", evidence: [validEvidenceRef] }, "miss-with-ref");
assertInvalidConsumerContract({ status: "unavailable", evidence: [validEvidenceRef] }, "unavailable-with-ref");
assertInvalidConsumerContract({ status: "unexpected", evidence: [] }, "invalid-status");
assertInvalidConsumerContract({
  status: "hit",
  evidence: [{ ...validEvidenceRef, sourceId: "model-invented-source" }],
}, "unknown-source");
assertInvalidConsumerContract({
  status: "hit",
  evidence: [{ ...validEvidenceRef, sourceVersion: "model-invented-version" }],
}, "wrong-source-version");

for (const status of ["miss", "unavailable"]) {
  const consumed = createManualRagConsumerEvidence({
    query: "ES8 尾门",
    runId: `run-valid-${status}`,
    status,
    evidence: [],
    reason: `${status}-reason`,
  });
  assert.equal(consumed.metadata.status, status);
  assert.equal(consumed.metadata.reason, `${status}-reason`);
  assert.deepEqual([...consumed], []);
}

assert.deepEqual(Object.values(MANUAL_RAG_PRESENTATION_STATES), [
  "not_requested",
  "searching",
  "hit",
  "miss",
  "unavailable",
]);
assert.equal(resolveManualRagPresentationStatus(), "not_requested");
assert.equal(resolveManualRagPresentationStatus({ requested: true, searching: true }), "searching");
assert.equal(resolveManualRagPresentationStatus({ requested: true, status: "hit" }), "hit");
assert.equal(resolveManualRagPresentationStatus({ requested: true, status: "miss" }), "miss");
assert.equal(resolveManualRagPresentationStatus({ requested: true, status: "unavailable" }), "unavailable");

const trusted = {
  chunkId: "fixture-tailgate",
  sourceId: "nio-es8-user-manual-2026",
  title: "蔚来 ES8 用户手册",
  sectionTitle: "门窗 / 尾门开启高度设置",
  pageStart: 66,
  pageEnd: 66,
  category: "操作",
  text: "您可以在车辆设置中设置尾门开启高度，操作时请注意尾门周围空间。",
  score: 0.72,
  retrievalMode: "vector-bge-m3",
};

const accepted = filterManualEvidence("如何设置 ES8 尾门开启高度？", [trusted], { retrievalMode: "vector-bge-m3" });
assert.equal(accepted.evidence.length, 1);
assert.equal(accepted.telemetry.acceptedCount, 1);
assert.equal(accepted.telemetry.eligibilityPolicy.version, "1.1.0");
assert.equal(accepted.telemetry.eligibilityPolicy.registry.id, "nio-manual-corpus-registry");
assert.equal(accepted.telemetry.eligibilityPolicy.registry.version, "1.2.0");
assert.equal(accepted.telemetry.eligibilityPolicy.corpus.calibration.id, "nio-es8-manual-evidence-eligibility-calibration@1.0.0");
assert.match(accepted.telemetry.eligibilityPolicy.corpus.calibration.method, /negative\/OOD/);

for (const [name, query, candidate, expectedReason] of [
  ["low vector", "如何设置 ES8 尾门开启高度？", { ...trusted, score: 0.1 }, "low-confidence"],
  ["wrong source", "如何设置 ES8 尾门开启高度？", { ...trusted, sourceId: "untrusted" }, "low-confidence"],
  ["other model", "ES6 尾门怎么打开？", trusted, "not-applicable"],
  ["directory", "ES8 尾门怎么打开？", { ...trusted, sectionTitle: "前置说明 / 目录", pageStart: 3 }, "low-confidence"],
  ["weather", "今天杭州天气怎么样？", trusted, "not-answerable"],
]) {
  const result = filterManualEvidence(query, [candidate], { retrievalMode: "vector-bge-m3" });
  assert.equal(result.evidence.length, 0, name);
  assert.equal(result.telemetry.missReason, expectedReason, name);
}

const assumed = filterManualEvidence("如何设置尾门开启高度？", [trusted], { retrievalMode: "vector-bge-m3" });
assert.equal(assumed.evidence.length, 1);
assert.equal(assumed.telemetry.assumedCorpus, true);
assert.equal(assumed.telemetry.corpusApplicability.reason, "no-model-specified-development-corpus-assumed");
const strictUnknownModel = filterManualEvidence("如何设置尾门开启高度？", [trusted], {
  retrievalMode: "vector-bge-m3",
  profileMode: "production",
});
assert.equal(strictUnknownModel.evidence.length, 0);
assert.equal(strictUnknownModel.telemetry.assumedCorpus, false);
assert.equal(strictUnknownModel.telemetry.corpusApplicability.reason, "no-model-specified-corpus-required");
assert.equal(strictUnknownModel.telemetry.missReason, "not-applicable");
const emptyOtherModel = filterManualEvidence("ES6 尾门怎么打开？", [], { retrievalMode: "vector-bge-m3" });
assert.equal(emptyOtherModel.telemetry.missReason, "not-applicable");
assert.equal(emptyOtherModel.telemetry.corpusApplicability.reason, "model-mismatch");
assert.equal(MANUAL_EVIDENCE_ELIGIBILITY_POLICY.corpus.sourceId, "nio-es8-user-manual-2026");
assert.equal(MANUAL_EVIDENCE_ELIGIBILITY_POLICY.version, "1.1.0");
assert.equal(MANUAL_CORPUS_REGISTRY.defaultCorpusId, "nio-es8-user-manual-2026");
assert.equal(MANUAL_CORPUS_REGISTRY.version, "1.2.0");
assert.equal(MANUAL_CORPUS_REGISTRY.corpora["nio-es8-user-manual-2026"].calibration.thresholds["vector-bge-m3"].minScore, 0.42);
assert.equal(getManualCorpusArtifacts().chunksPath, "data/manual-rag/es8-manual-chunks.jsonl");
assert.equal(getManualCorpusArtifacts().embeddingsPath, "data/manual-rag/es8-manual-embeddings.jsonl");
assert.equal(getManualCorpusArtifacts("nio-et5-user-manual-placeholder").retrievalReady, false);
assert.equal(getManualCorpusArtifacts("nio-et5-user-manual-placeholder").chunksPath, "");
assert.deepEqual(selectManualCorpusForContext({ rawText: "ES8 尾门怎么打开？" }), {
  status: "selected",
  applicable: true,
  assumedCorpus: false,
  corpusId: "nio-es8-user-manual-2026",
  title: "蔚来 ES8 用户手册",
  requestedModels: ["ES8"],
  reason: "explicit-model-match",
});
assert.deepEqual(selectManualCorpusForContext({ rawText: "ET5 尾门怎么打开？" }), {
  status: "selected",
  applicable: true,
  assumedCorpus: false,
  corpusId: "nio-et5-user-manual-placeholder",
  title: "蔚来 ET5 用户手册（占位，未接入索引）",
  requestedModels: ["ET5"],
  reason: "explicit-model-match",
});
assert.equal(selectManualCorpusForContext({ rawText: "ES6 尾门怎么打开？" }).reason, "model-mismatch");
assert.equal(selectManualCorpusForContext({ rawText: "尾门怎么打开？", profileMode: "production" }).reason, "no-model-specified-corpus-required");
assert.equal(formatManualCitationForChunk(trusted), "蔚来 ES8 用户手册 p.66「门窗 / 尾门开启高度设置」");
assert.equal(formatManualCitationForDisplay(trusted), "《蔚来 ES8 用户手册》第 66 页「门窗 / 尾门开启高度设置」");
assert.equal(formatManualMissSummary(getManualCorpusArtifacts(), "向量索引"), "未在蔚来 ES8 用户手册的向量索引中找到相关证据。");

for (const sourcePath of [
  "../../src/server/local-agent-server.mjs",
  "../../src/manual/manual-rag-retriever.js",
  "../../src/manual/manual-rag-vector-retriever.js",
]) {
  const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  assert.doesNotMatch(source, /ES8 用户手册 p/, `${sourcePath} must use ManualCorpusRegistry citation formatter`);
  assert.doesNotMatch(source, /《ES8 用户手册》/, `${sourcePath} must use ManualCorpusRegistry display formatter`);
  assert.doesNotMatch(source, /未在 ES8 用户手册/, `${sourcePath} must use ManualCorpusRegistry miss summary formatter`);
}

for (const sourcePath of [
  "../../src/manual/manual-rag-retriever.js",
  "../../src/manual/manual-rag-vector-retriever.js",
]) {
  const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  assert.doesNotMatch(source, /es8-manual-(chunks|embeddings)\.jsonl/, `${sourcePath} must read manual artifact paths from ManualCorpusRegistry`);
  assert.match(source, /manual-rag-presentation\.js/, `${sourcePath} must delegate shared presentation-only work`);
}

const presentationChunks = [{
  ...trusted,
  chunkId: "es8-manual-chunk-0055",
  reviewedCitationSpans: [],
  citation: formatManualCitationForChunk(trusted),
  score: 0.72,
}];
Object.defineProperty(presentationChunks, "metadata", {
  value: { candidateDecisions: [{ chunkId: "es8-manual-chunk-0055", decision: "accepted" }], retrievalMode: "fixture" },
});
const presentationSummary = buildPresentedManualEvidenceSummary({
  query: "如何设置 ES8 尾门开启高度？",
  chunks: presentationChunks,
  missSummary: { summary: "unused" },
  missTelemetry: { unused: true },
  makeExcerpt: (chunk) => `excerpt:${chunk.chunkId}`,
});
assert.deepEqual(presentationSummary.evidence[0].evidenceRef, {
  sourceId: "nio-es8-user-manual-2026",
  sourceVersion: "2026",
  chunkId: "es8-manual-chunk-0055",
  pageStart: 66,
  pageEnd: 66,
  excerpt: "excerpt:es8-manual-chunk-0055",
  score: { retrieval: 0.72, rerank: null, grounding: null },
});
assert.equal(
  validateManualEvidenceRef(presentationSummary.evidence[0].evidenceRef, MANUAL_CORPUS_REGISTRY).valid,
  true,
);
assert.deepEqual(presentationSummary.evidence[0].reviewedCitationSpans, []);
assert.equal(presentationSummary.summary, "1. 第 66 页「门窗 / 尾门开启高度设置」（操作）：excerpt:es8-manual-chunk-0055");

const keywordOtherModel = await retrieveManualChunks("ES6 尾门怎么打开？", { topK: 3 });
assert.equal(keywordOtherModel.length, 0);
assert.equal(keywordOtherModel.metadata.manualCorpusSelection.reason, "model-mismatch");
assert.equal(keywordOtherModel.metadata.missReason, "not-applicable");

const keywordPlaceholderModel = await retrieveManualChunks("ET5 尾门怎么打开？", { topK: 3 });
assert.equal(keywordPlaceholderModel.length, 0);
assert.equal(keywordPlaceholderModel.metadata.manualCorpusSelection.corpusId, "nio-et5-user-manual-placeholder");
assert.equal(keywordPlaceholderModel.metadata.corpusArtifactStatus, "unavailable");
assert.equal(keywordPlaceholderModel.metadata.missReason, "corpus-artifact-unavailable");
assert.equal(keywordPlaceholderModel.metadata.corpusTitle, "蔚来 ET5 用户手册（占位，未接入索引）");

const keywordSummary = await buildManualEvidenceSummary("如何设置 ES8 尾门开启高度？", { topK: 3 });
assert.ok(keywordSummary.evidence.length > 0, "keyword evidence summary should retain retrieved evidence");
assert.equal(validateManualEvidenceRef(keywordSummary.evidence[0].evidenceRef, MANUAL_CORPUS_REGISTRY).valid, true);
assert.equal(keywordSummary.evidence[0].evidenceRef.score.rerank, null);
assert.equal(keywordSummary.evidence[0].evidenceRef.score.grounding, null);
assert.equal(keywordSummary.telemetry.retrievalMode, "keyword-fallback");

const vectorOtherModel = await retrieveManualVectorChunks("ES6 尾门怎么打开？", { topK: 3 });
assert.equal(vectorOtherModel.length, 0);
assert.equal(vectorOtherModel.metadata.manualCorpusSelection.reason, "model-mismatch");
assert.equal(vectorOtherModel.metadata.missReason, "not-applicable");
assert.equal(vectorOtherModel.metadata.chunkCount, 0, "not-applicable corpus selection should return before loading ES8 vector index");
const vectorPlaceholderModel = await retrieveManualVectorChunks("ET5 尾门怎么打开？", { topK: 3 });
assert.equal(vectorPlaceholderModel.length, 0);
assert.equal(vectorPlaceholderModel.metadata.manualCorpusSelection.corpusId, "nio-et5-user-manual-placeholder");
assert.equal(vectorPlaceholderModel.metadata.corpusArtifactStatus, "unavailable");
assert.equal(vectorPlaceholderModel.metadata.missReason, "corpus-artifact-unavailable");
assert.equal(vectorPlaceholderModel.metadata.chunkCount, 0, "placeholder corpus selection should return before loading any vector index");
assert.equal(vectorPlaceholderModel.metadata.generatedRows, 0);
console.log("manual evidence eligibility verification passed");
