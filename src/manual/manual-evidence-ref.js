import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANUAL_CORPUS_REGISTRY } from "./manual-corpus-registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REQUIRED_FIELDS = Object.freeze([
  "sourceId",
  "sourceVersion",
  "chunkId",
  "pageStart",
  "pageEnd",
  "excerpt",
  "score",
]);
const SCORE_FIELDS = Object.freeze(["retrieval", "rerank", "grounding"]);
const chunksByRegistry = new WeakMap();

export function createManualEvidenceRef({
  sourceId,
  sourceVersion,
  chunkId,
  pageStart,
  pageEnd,
  excerpt,
  retrievalScore,
  rerankScore = null,
  groundingScore = null,
} = {}) {
  requireNonEmptyString(sourceId, "sourceId");
  requireNonEmptyString(sourceVersion, "sourceVersion");
  requireNonEmptyString(chunkId, "chunkId");
  requireInteger(pageStart, "pageStart");
  requireInteger(pageEnd, "pageEnd");
  requireNonEmptyString(excerpt, "excerpt");
  requireScore(retrievalScore, "retrievalScore", false);
  requireScore(rerankScore, "rerankScore", true);
  requireScore(groundingScore, "groundingScore", true);

  return Object.freeze({
    sourceId: sourceId.trim(),
    sourceVersion: sourceVersion.trim(),
    chunkId: chunkId.trim(),
    pageStart,
    pageEnd,
    excerpt: excerpt.trim(),
    score: Object.freeze({
      retrieval: Number(retrievalScore),
      rerank: rerankScore === null ? null : Number(rerankScore),
      grounding: groundingScore === null ? null : Number(groundingScore),
    }),
  });
}

export function validateManualEvidenceRef(ref, corpusRegistry = MANUAL_CORPUS_REGISTRY) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return fail("invalid-ref-shape");
  const unexpectedField = Object.keys(ref).find((field) => !REQUIRED_FIELDS.includes(field));
  if (unexpectedField) return fail(`unexpected-field:${unexpectedField}`);
  const missingField = REQUIRED_FIELDS.find((field) => !Object.hasOwn(ref, field));
  if (missingField) return fail(`missing-field:${missingField}`);
  if (!nonEmptyString(ref.sourceId)) return fail("invalid-source-id");
  if (!nonEmptyString(ref.sourceVersion)) return fail("invalid-source-version");
  if (!nonEmptyString(ref.chunkId)) return fail("invalid-chunk-id");
  if (!Number.isInteger(ref.pageStart) || !Number.isInteger(ref.pageEnd)) return fail("invalid-page-range");
  if (!nonEmptyString(ref.excerpt)) return fail("invalid-excerpt");

  const scoreValidation = validateScore(ref.score);
  if (!scoreValidation.valid) return scoreValidation;
  if (!corpusRegistry || typeof corpusRegistry !== "object" || !corpusRegistry.corpora) {
    return fail("invalid-corpus-registry");
  }

  const corpus = Object.values(corpusRegistry.corpora).find(
    (candidate) => candidate?.sourceId === ref.sourceId,
  );
  if (!corpus) return fail("source-not-registered");
  if (corpus.sourceVersion !== ref.sourceVersion) return fail("source-version-mismatch");

  const loaded = loadCorpusChunks(corpusRegistry, corpus);
  if (!loaded.valid) return loaded;
  const chunk = loaded.chunks.get(ref.chunkId);
  if (!chunk || chunk.sourceId !== corpus.sourceId) return fail("chunk-not-registered");
  const pageEnd = chunk.pageEnd ?? chunk.pageStart;
  if (ref.pageStart !== chunk.pageStart || ref.pageEnd !== pageEnd) return fail("chunk-page-mismatch");
  return { valid: true, reason: "registry-verified" };
}

function loadCorpusChunks(corpusRegistry, corpus) {
  let registryCache = chunksByRegistry.get(corpusRegistry);
  if (!registryCache) {
    registryCache = new Map();
    chunksByRegistry.set(corpusRegistry, registryCache);
  }
  if (registryCache.has(corpus.sourceId)) {
    return { valid: true, chunks: registryCache.get(corpus.sourceId) };
  }

  const chunksPath = String(corpus.artifacts?.chunksPath || "");
  if (!chunksPath) return fail("corpus-chunks-unavailable");
  const absolutePath = path.resolve(root, chunksPath);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) return fail("corpus-chunks-path-outside-project");
  try {
    const chunks = new Map(
      readFileSync(absolutePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((chunk) => chunk?.sourceId === corpus.sourceId)
        .map((chunk) => [chunk.chunkId, chunk]),
    );
    registryCache.set(corpus.sourceId, chunks);
    return { valid: true, chunks };
  } catch {
    return fail("corpus-chunks-unavailable");
  }
}

function validateScore(score) {
  if (!score || typeof score !== "object" || Array.isArray(score)) return fail("invalid-score-shape");
  const unexpectedField = Object.keys(score).find((field) => !SCORE_FIELDS.includes(field));
  if (unexpectedField) return fail(`unexpected-score-field:${unexpectedField}`);
  const missingField = SCORE_FIELDS.find((field) => !Object.hasOwn(score, field));
  if (missingField) return fail(`missing-score-field:${missingField}`);
  if (!Number.isFinite(score.retrieval)) return fail("invalid-retrieval-score");
  if (score.rerank !== null && !Number.isFinite(score.rerank)) return fail("invalid-rerank-score");
  if (score.grounding !== null && !Number.isFinite(score.grounding)) return fail("invalid-grounding-score");
  return { valid: true, reason: "valid-score" };
}

function requireNonEmptyString(value, field) {
  if (!nonEmptyString(value)) throw new TypeError(`${field} must be a non-empty string`);
}

function requireInteger(value, field) {
  if (!Number.isInteger(value)) throw new TypeError(`${field} must be an integer`);
}

function requireScore(value, field, nullable) {
  if (nullable && value === null) return;
  if (!Number.isFinite(Number(value))) throw new TypeError(`${field} must be a finite number${nullable ? " or null" : ""}`);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(reason) {
  return { valid: false, reason };
}
