import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { filterManualEvidence } from "./manual-evidence-eligibility.js";
import { buildReviewedCitationProofs } from "./manual-constraint-registry.js";
import {
  buildEmptyManualEligibilityTelemetry,
  buildManualEvidenceSummary as buildPresentedManualEvidenceSummary,
  toManualRetrievalEvidence,
} from "./manual-rag-presentation.js";
import {
  formatManualCitationForChunk,
  formatManualMissSummary,
  getManualCorpusArtifacts,
  MANUAL_CORPUS_REGISTRY,
  selectManualCorpusForContext,
} from "./manual-corpus-registry.js";
import {
  createAbortError,
  isCancellationError,
  throwIfAborted,
} from "../runtime/abort-utils.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MODEL = "bge-m3";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const RETRIEVAL_MODE = "vector-bge-m3";
const EMBEDDING_STATUS = "embedded";
const MAX_TOP_K = 8;
const DEFAULT_RESULT_CACHE_SIZE = 64;
const DEFAULT_OLLAMA_KEEP_ALIVE = "24h";
const MANUAL_EMBEDDING_WARMUP_INPUT = "NIO manual retrieval model warmup";

let cachedIndex = null;
let cachedIndexKey = "";
const resultCache = new Map();
const indexWarmupByCorpusId = new Map();

export class ManualVectorRetrievalError extends Error {
  constructor(message, telemetry = {}) {
    super(message);
    this.name = "ManualVectorRetrievalError";
    this.telemetry = telemetry;
  }
}

export async function retrieveManualVectorChunks(query, options = {}) {
  throwIfAborted(options.signal);
  const normalizedQuery = String(query || "").trim();
  const selection = selectManualCorpusForContext({
    rawText: query,
    vehicleModel: options.vehicleModel,
    corpusId: options.corpusId,
    profileMode: options.profileMode,
    allowDevelopmentAssumedCorpus: options.allowDevelopmentAssumedCorpus,
  });
  const corpusOptions = { ...options, corpusId: selection.corpusId || options.corpusId };
  if (!normalizedQuery) return withMetadata([], {}, buildEmptyEligibilityTelemetry(query, corpusOptions, selection));
  if (!selection.applicable) return withMetadata([], {}, buildEmptyEligibilityTelemetry(query, corpusOptions, selection));

  const topK = normalizeTopK(options.topK);
  if (topK === 0) return withMetadata([], {}, buildEmptyEligibilityTelemetry(query, corpusOptions, selection));
  const artifacts = getManualCorpusArtifacts(selection.corpusId);
  if (artifacts.retrievalReady === false || !artifacts.chunksPath || !artifacts.embeddingsPath) {
    return withMetadata([], {
      corpusId: artifacts.corpusId,
      corpusTitle: artifacts.title,
      embeddingModel: manualEmbeddingModel(),
      dimensions: 0,
      chunkCount: 0,
      generatedRows: 0,
    }, {
      ...buildEmptyEligibilityTelemetry(query, corpusOptions, selection),
      manualCorpusSelection: selection,
      corpusArtifactStatus: "unavailable",
      missReason: "corpus-artifact-unavailable",
      cacheHit: false,
      cacheType: "disabled",
      cacheSize: resultCache.size,
      cacheCapacity: manualResultCacheSize(),
    });
  }

  const index = await loadManualVectorIndex(corpusOptions);
  const resultCacheSize = manualResultCacheSize();
  const resultCacheKey =
    resultCacheSize > 0 ? makeResultCacheKey(normalizedQuery, topK, options, index, cachedIndexKey) : "";
  if (resultCacheKey && resultCache.has(resultCacheKey)) {
    const cachedEntry = resultCache.get(resultCacheKey);
    resultCache.delete(resultCacheKey);
    resultCache.set(resultCacheKey, cachedEntry);
    return withMetadata(cloneResults(cachedEntry.results), index, {
      cacheHit: true,
      cacheType: "result",
      cacheSize: resultCache.size,
      cacheCapacity: resultCacheSize,
      ...cachedEntry.eligibilityTelemetry,
      manualCorpusSelection: selection,
    });
  }

  let queryEmbedding;
  try {
    queryEmbedding = await embedQuery(normalizedQuery, options);
  } catch (error) {
    if (options.signal?.aborted) throw createAbortError(options.signal.reason);
    if (isCancellationError(error)) throw error;
    throw new ManualVectorRetrievalError(
      error.message,
      buildTelemetry(index, {
        embeddingStatus: "unavailable",
        reason: "embedding-unavailable",
        cacheHit: false,
        cacheType: resultCacheSize > 0 ? "result" : "disabled",
        cacheSize: resultCache.size,
        cacheCapacity: resultCacheSize,
      }),
    );
  }
  if (queryEmbedding.length !== index.dimensions) {
    throw new ManualVectorRetrievalError(
      `query embedding dimensions mismatch: expected ${index.dimensions}, got ${queryEmbedding.length}`,
      buildTelemetry(index, {
        embeddingStatus: "unavailable",
        reason: "embedding-dimension-mismatch",
        cacheHit: false,
        cacheType: resultCacheSize > 0 ? "result" : "disabled",
        cacheSize: resultCache.size,
        cacheCapacity: resultCacheSize,
      }),
    );
  }

  const categories = normalizeCategoryFilter(options);
  const candidates = index.rows
    .filter((row) => matchesCategory(row.chunk, categories))
    .map((row) => toResult(row.chunk, cosineSimilarity(queryEmbedding, row.embedding), index))
    .sort(compareResults)
    .slice(0, Math.min(index.rows.length, Math.max(topK * 3, topK)));

  const eligibility = filterManualEvidence(normalizedQuery, candidates, {
    retrievalMode: RETRIEVAL_MODE,
    vehicleModel: options.vehicleModel,
    corpusId: selection.corpusId,
  });
  const results = eligibility.evidence.slice(0, topK);

  if (resultCacheKey) {
    resultCache.set(resultCacheKey, {
      results: cloneResults(results),
      eligibilityTelemetry: eligibility.telemetry,
    });
    pruneResultCache(resultCacheSize);
  } else {
    pruneResultCache(resultCacheSize);
  }

  return withMetadata(results, index, {
    cacheHit: false,
    cacheType: resultCacheSize > 0 ? "result" : "disabled",
    cacheSize: resultCache.size,
    cacheCapacity: resultCacheSize,
    ...eligibility.telemetry,
    manualCorpusSelection: selection,
  });
}

export async function buildManualVectorEvidenceSummary(query, options = {}) {
  const chunks = await retrieveManualVectorChunks(query, options);
  const selection = chunks.metadata?.manualCorpusSelection;
  const corpusArtifacts = selection?.applicable ? getManualCorpusArtifacts(selection.corpusId) : { title: "已接入的用户手册" };
  return buildPresentedManualEvidenceSummary({
    query,
    chunks,
    missSummary: { summary: formatManualMissSummary(corpusArtifacts, "向量索引") },
    missTelemetry: chunks.metadata,
    makeExcerpt: (chunk) => makeExcerpt(chunk.text),
  });
}

function buildEmptyEligibilityTelemetry(query, options, selection) {
  return buildEmptyManualEligibilityTelemetry({
    query,
    options,
    selection,
    retrievalMode: RETRIEVAL_MODE,
    filterEvidence: filterManualEvidence,
  });
}

export async function loadManualVectorIndex(options = {}) {
  const { chunksPath, embeddingsPath } = resolveManualVectorRetrieverPaths(options);
  const cacheKey = `${chunksPath}\n${embeddingsPath}`;
  if (cachedIndex && cachedIndexKey === cacheKey) return cachedIndex;

  const [chunks, embeddings] = await Promise.all([
    readJsonl(chunksPath),
    readJsonl(embeddingsPath),
  ]);
  const embeddingsByChunkId = new Map();
  let dimensions = 0;
  let embeddingModel = "";

  for (const row of embeddings) {
    if (!row?.chunkId) throw new Error("embedding row missing chunkId");
    if (!Array.isArray(row.embedding) || !row.embedding.length) {
      throw new Error(`embedding row ${row.chunkId} missing embedding vector`);
    }
    if (embeddingsByChunkId.has(row.chunkId)) {
      throw new Error(`duplicate embedding row for ${row.chunkId}`);
    }
    const rowDimensions = Number(row.dimensions || row.embedding.length);
    if (rowDimensions !== row.embedding.length) {
      throw new Error(`embedding dimensions mismatch for ${row.chunkId}`);
    }
    if (!dimensions) dimensions = rowDimensions;
    if (rowDimensions !== dimensions) {
      throw new Error(`mixed embedding dimensions: expected ${dimensions}, got ${rowDimensions}`);
    }
    if (!embeddingModel) embeddingModel = String(row.embeddingModel || "");
    embeddingsByChunkId.set(row.chunkId, row);
  }

  if (embeddingsByChunkId.size !== chunks.length) {
    throw new ManualVectorRetrievalError(
      `manual rag embeddings incomplete: ${embeddingsByChunkId.size}/${chunks.length} rows generated`,
      {
        retrievalMode: RETRIEVAL_MODE,
        embeddingStatus: EMBEDDING_STATUS,
        embeddingModel: embeddingModel || manualEmbeddingModel(),
        dimensions,
        chunkCount: chunks.length,
        generatedRows: embeddingsByChunkId.size,
      },
    );
  }

  const rows = chunks.map((chunk) => {
    const embeddingRow = embeddingsByChunkId.get(chunk.chunkId);
    if (!embeddingRow) throw new Error(`missing embedding for ${chunk.chunkId}`);
    return { chunk, embedding: embeddingRow.embedding.map(Number) };
  });

  cachedIndex = {
    rows,
    corpusId: options.corpusId || getManualCorpusArtifacts().corpusId,
    corpusTitle: getManualCorpusArtifacts(options.corpusId).title,
    embeddingModel: embeddingModel || manualEmbeddingModel(),
    dimensions,
    chunkCount: chunks.length,
    generatedRows: embeddingsByChunkId.size,
  };
  cachedIndexKey = cacheKey;
  return cachedIndex;
}

// Startup warming only loads reviewed local artifacts into the existing index cache.
// It never embeds a query or writes the query-result cache, so it cannot influence
// corpus selection, eligibility, citations, or a later user's retrieval result.
export async function warmReadyManualVectorIndexes(options = {}) {
  const startedAt = Date.now();
  const requestedCorpusIds = options.corpusId
    ? [String(options.corpusId)]
    : Object.values(MANUAL_CORPUS_REGISTRY.corpora)
      .filter((corpus) => corpus.retrievalReady !== false && corpus.artifacts?.chunksPath && corpus.artifacts?.embeddingsPath)
      .map((corpus) => corpus.sourceId);
  const corpora = [];

  for (const corpusId of requestedCorpusIds) {
    const artifacts = getManualCorpusArtifacts(corpusId);
    if (artifacts.retrievalReady === false || !artifacts.chunksPath || !artifacts.embeddingsPath) {
      const skipped = {
        corpusId: artifacts.corpusId || corpusId,
        status: "skipped",
        reason: "corpus-artifact-unavailable",
        durationMs: 0,
      };
      indexWarmupByCorpusId.set(skipped.corpusId, skipped);
      corpora.push(skipped);
      continue;
    }

    const corpusStartedAt = Date.now();
    try {
      const index = await loadManualVectorIndex({ ...options, corpusId });
      const warmed = {
        corpusId: artifacts.corpusId,
        status: "ready",
        durationMs: Date.now() - corpusStartedAt,
        chunkCount: index.chunkCount,
        generatedRows: index.generatedRows,
        warmedAt: new Date().toISOString(),
      };
      indexWarmupByCorpusId.set(artifacts.corpusId, warmed);
      corpora.push(warmed);
    } catch (error) {
      const failed = {
        corpusId: artifacts.corpusId,
        status: "failed",
        durationMs: Date.now() - corpusStartedAt,
        reason: error.message,
        warmedAt: new Date().toISOString(),
      };
      indexWarmupByCorpusId.set(artifacts.corpusId, failed);
      corpora.push(failed);
    }
  }

  return {
    status: corpora.some((corpus) => corpus.status === "failed") ? "degraded" : "ready",
    durationMs: Date.now() - startedAt,
    corpora,
  };
}

export function getManualVectorWarmupTelemetry(corpusId) {
  const artifacts = getManualCorpusArtifacts(corpusId);
  const telemetry = indexWarmupByCorpusId.get(artifacts.corpusId);
  return telemetry ? { ...telemetry } : {
    corpusId: artifacts.corpusId,
    status: "not-started",
    durationMs: 0,
  };
}

export async function warmManualEmbeddingModel(options = {}) {
  const startedAt = Date.now();
  const index = await loadManualVectorIndex(options);
  const embedding = await embedQuery(MANUAL_EMBEDDING_WARMUP_INPUT, options);
  if (embedding.length !== index.dimensions) {
    throw new ManualVectorRetrievalError(
      `warmup embedding dimensions mismatch: expected ${index.dimensions}, got ${embedding.length}`,
    );
  }
  return {
    status: "ready",
    durationMs: Date.now() - startedAt,
    corpusId: index.corpusId,
    embeddingModel: index.embeddingModel,
    dimensions: index.dimensions,
  };
}

function resolveManualVectorRetrieverPaths(options = {}) {
  const artifacts = getManualCorpusArtifacts(options.corpusId);
  return {
    corpusId: artifacts.corpusId,
    corpusTitle: artifacts.title,
    chunksPath: options.chunksPath || path.join(root, artifacts.chunksPath),
    embeddingsPath: options.embeddingsPath || path.join(root, artifacts.embeddingsPath),
  };
}

async function embedQuery(query, options) {
  throwIfAborted(options.signal);
  const embeddingModel = options.embeddingModel || manualEmbeddingModel();
  const baseUrl = String(options.baseUrl || manualOllamaBaseUrl()).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: embeddingModel,
      input: query,
      keep_alive: manualOllamaKeepAlive(options.keepAlive),
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`query embedding failed: ${response.status} ${text}`.trim());
  }
  const payload = await response.json();
  const embedding = Array.isArray(payload.embeddings?.[0])
    ? payload.embeddings[0]
    : Array.isArray(payload.embedding)
      ? payload.embedding
      : null;
  if (!embedding?.length) throw new Error("query embedding failed: empty embedding response");
  return embedding.map(Number);
}

async function readJsonl(filePath) {
  const jsonl = await readFile(filePath, "utf8");
  return jsonl
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalizeTopK(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(0, Math.min(MAX_TOP_K, Math.floor(parsed)));
}

function normalizeCategoryFilter(options) {
  const raw = [];
  if (options.category) raw.push(options.category);
  if (Array.isArray(options.categories)) raw.push(...options.categories);
  return raw.map((category) => String(category).trim()).filter(Boolean);
}

function matchesCategory(chunk, categories) {
  return !categories.length || categories.includes(chunk.category);
}

function toResult(chunk, score, index) {
  const pageEnd = chunk.pageEnd || chunk.pageStart;
  const citation = formatManualCitationForChunk({ ...chunk, pageEnd });
  return toManualRetrievalEvidence({
    ...chunk,
    pageEnd,
    reviewedCitationSpans: buildReviewedCitationProofs(chunk),
    citation,
  }, {
    score: Number(score.toFixed(6)),
    retrievalMetadata: {
      retrievalMode: RETRIEVAL_MODE,
      embeddingStatus: EMBEDDING_STATUS,
      embeddingModel: index.embeddingModel,
      dimensions: index.dimensions,
    },
  });
}

function compareResults(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  if (left.pageStart !== right.pageStart) return left.pageStart - right.pageStart;
  return String(left.chunkId).localeCompare(String(right.chunkId));
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function withMetadata(results, index = {}, telemetry = {}) {
  Object.defineProperty(results, "metadata", {
    value: { ...buildTelemetry(index, telemetry), count: results.length },
    enumerable: false,
  });
  return results;
}

function buildTelemetry(index = {}, telemetry = {}) {
  const corpusId = index.corpusId || getManualCorpusArtifacts().corpusId;
  return {
    retrievalMode: RETRIEVAL_MODE,
    embeddingStatus: EMBEDDING_STATUS,
    corpusId,
    corpusTitle: index.corpusTitle || getManualCorpusArtifacts().title,
    embeddingModel: index.embeddingModel || manualEmbeddingModel(),
    dimensions: index.dimensions || 0,
    chunkCount: index.chunkCount || 0,
    generatedRows: index.generatedRows || 0,
    indexWarmup: getManualVectorWarmupTelemetry(corpusId),
    ...telemetry,
  };
}

function makeResultCacheKey(query, topK, options, index, indexCacheKey) {
  return JSON.stringify({
    query,
    topK,
    categories: normalizeCategoryFilter(options).sort(),
    corpusId: String(options.corpusId || ""),
    profileMode: String(options.profileMode || ""),
    allowDevelopmentAssumedCorpus: options.allowDevelopmentAssumedCorpus === undefined
      ? null
      : options.allowDevelopmentAssumedCorpus === true,
    embeddingModel: options.embeddingModel || manualEmbeddingModel(),
    indexEmbeddingModel: index.embeddingModel || manualEmbeddingModel(),
    indexCacheKey,
    vehicleModel: String(options.vehicleModel || ""),
  });
}

function cloneResults(results) {
  return results.map((result) => ({
    ...result,
    tags: Array.isArray(result.tags) ? [...result.tags] : [],
  }));
}

function pruneResultCache(capacity) {
  if (capacity <= 0) {
    resultCache.clear();
    return;
  }
  while (resultCache.size > capacity) {
    const oldestKey = resultCache.keys().next().value;
    resultCache.delete(oldestKey);
  }
}

function manualEmbeddingModel() {
  return process.env.NIO_MANUAL_EMBEDDING_MODEL || DEFAULT_MODEL;
}

function manualOllamaBaseUrl() {
  return process.env.NIO_OLLAMA_BASE_URL || DEFAULT_BASE_URL;
}

function manualOllamaKeepAlive(value = process.env.NIO_OLLAMA_KEEP_ALIVE) {
  const normalized = String(value || DEFAULT_OLLAMA_KEEP_ALIVE).trim();
  return /^(?:-1|0|[1-9]\d*(?:ms|s|m|h))$/.test(normalized)
    ? normalized
    : DEFAULT_OLLAMA_KEEP_ALIVE;
}

function manualResultCacheSize() {
  const parsed = Number(process.env.NIO_MANUAL_RAG_RESULT_CACHE_SIZE);
  if (!Number.isFinite(parsed)) return DEFAULT_RESULT_CACHE_SIZE;
  return Math.max(0, Math.floor(parsed));
}

function makeExcerpt(text) {
  const compactText = String(text || "").replace(/\s+/g, " ").trim();
  const excerpt = compactText.slice(0, 96);
  return `${excerpt}${excerpt.length < compactText.length ? "..." : ""}`;
}
