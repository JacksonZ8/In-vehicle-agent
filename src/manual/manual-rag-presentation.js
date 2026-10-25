// Shared presentation-only helpers for Manual RAG retrievers. Retrieval,
// ranking, cache behavior, and evidence eligibility remain owned by callers.
import {
  createManualEvidenceRef,
  validateManualEvidenceRef,
} from "./manual-evidence-ref.js";
import { MANUAL_CORPUS_REGISTRY } from "./manual-corpus-registry.js";

export const MANUAL_RAG_PRESENTATION_STATES = Object.freeze({
  NOT_REQUESTED: "not_requested",
  SEARCHING: "searching",
  HIT: "hit",
  MISS: "miss",
  UNAVAILABLE: "unavailable",
});

const API_RESULT_STATES = new Set([
  MANUAL_RAG_PRESENTATION_STATES.HIT,
  MANUAL_RAG_PRESENTATION_STATES.MISS,
  MANUAL_RAG_PRESENTATION_STATES.UNAVAILABLE,
]);

export function resolveManualRagPresentationStatus({ requested = false, searching = false, status } = {}) {
  if (!requested) return MANUAL_RAG_PRESENTATION_STATES.NOT_REQUESTED;
  if (searching) return MANUAL_RAG_PRESENTATION_STATES.SEARCHING;
  return API_RESULT_STATES.has(status) ? status : MANUAL_RAG_PRESENTATION_STATES.UNAVAILABLE;
}
export function buildEmptyManualEligibilityTelemetry({
  query,
  options,
  selection,
  retrievalMode,
  filterEvidence,
}) {
  const eligibility = filterEvidence(query, [], {
    retrievalMode,
    vehicleModel: options.vehicleModel,
    corpusId: options.corpusId,
    profileMode: options.profileMode,
    allowDevelopmentAssumedCorpus: options.allowDevelopmentAssumedCorpus,
  });
  return { ...eligibility.telemetry, manualCorpusSelection: selection };
}

export function toManualRetrievalEvidence(chunk, { score, retrievalMetadata = {} }) {
  const corpus = Object.values(MANUAL_CORPUS_REGISTRY.corpora || {}).find(
    (candidate) => candidate?.sourceId === chunk.sourceId,
  );
  return {
    chunkId: chunk.chunkId,
    sourceId: chunk.sourceId,
    sourceVersion: chunk.sourceVersion ?? corpus?.sourceVersion ?? null,
    manualVersion: chunk.sourceId,
    title: chunk.title,
    sectionTitle: chunk.sectionTitle,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd || chunk.pageStart,
    category: chunk.category,
    tags: Array.isArray(chunk.tags) ? [...chunk.tags] : [],
    score,
    text: chunk.text,
    reviewedCitationSpans: chunk.reviewedCitationSpans,
    citation: chunk.citation,
    ...retrievalMetadata,
  };
}

export function buildManualEvidenceSummary({
  query,
  chunks,
  missSummary,
  missTelemetry,
  makeExcerpt,
  corpusRegistry = MANUAL_CORPUS_REGISTRY,
}) {
  if (!chunks.length) {
    return {
      query: String(query || ""),
      summary: missSummary.summary,
      evidence: [],
      telemetry: missTelemetry,
    };
  }

  const presented = chunks.map((chunk, index) => {
    const corpus = Object.values(corpusRegistry.corpora || {}).find(
      (candidate) => candidate?.sourceId === chunk.sourceId,
    );
    const ref = createManualEvidenceRef({
      sourceId: chunk.sourceId,
      sourceVersion: corpus?.sourceVersion,
      chunkId: chunk.chunkId,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd ?? chunk.pageStart,
      excerpt: makeExcerpt(chunk),
      retrievalScore: chunk.score?.retrieval ?? chunk.score,
      rerankScore: chunk.rerankScore ?? chunk.score?.rerank ?? null,
      groundingScore: chunk.groundingScore ?? chunk.score?.grounding ?? null,
    });
    const validation = validateManualEvidenceRef(ref, corpusRegistry);
    if (!validation.valid) {
      const error = new TypeError(`invalid manual evidence ref: ${validation.reason}`);
      error.code = `invalid-evidence-ref:${validation.reason}`;
      throw error;
    }
    return {
      rank: index + 1,
      chunkId: chunk.chunkId,
      sourceId: chunk.sourceId,
      manualVersion: chunk.sourceId,
      reviewedCitationSpans: chunk.reviewedCitationSpans,
      title: chunk.title,
      citation: chunk.citation,
      sectionTitle: chunk.sectionTitle,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      category: chunk.category,
      score: chunk.score,
      excerpt: ref.excerpt,
      eligibility: chunks.metadata?.candidateDecisions?.find((item) => item.chunkId === chunk.chunkId),
      evidenceRef: ref,
    };
  });

  return {
    query: String(query || ""),
    summary: presented
      .map((item) => `${item.rank}. 第 ${formatPages(item)} 页「${item.sectionTitle}」（${item.category}）：${item.excerpt}`)
      .join("\n"),
    evidence: presented,
    telemetry: chunks.metadata,
  };
}

export function createManualRagApiResponse({
  query,
  runId,
  status,
  evidence = [],
  summary = "",
  telemetry = {},
  reason = "",
  corpusRegistry = MANUAL_CORPUS_REGISTRY,
}) {
  if (!API_RESULT_STATES.has(status)) throw new TypeError(`unsupported manual RAG API status: ${status}`);
  if (typeof runId !== "string" || !runId.trim()) throw new TypeError("manual RAG response requires runId");

  const normalizedEvidence = status === MANUAL_RAG_PRESENTATION_STATES.HIT
    ? evidence.map((item) => {
      const ref = item?.evidenceRef || item;
      const validation = validateManualEvidenceRef(ref, corpusRegistry);
      if (!validation.valid) {
        const error = new TypeError(`invalid manual evidence ref: ${validation.reason}`);
        error.code = `invalid-evidence-ref:${validation.reason}`;
        throw error;
      }
      return ref;
    })
    : [];

  return {
    query: String(query || ""),
    runId: runId.trim(),
    status,
    evidence: normalizedEvidence,
    summary: status === MANUAL_RAG_PRESENTATION_STATES.UNAVAILABLE ? "" : String(summary || ""),
    telemetry: telemetry && typeof telemetry === "object" ? telemetry : {},
    ...(reason ? { reason: String(reason) } : {}),
  };
}

function formatPages(item) {
  return item.pageStart === item.pageEnd ? item.pageStart : `${item.pageStart}-${item.pageEnd}`;
}
