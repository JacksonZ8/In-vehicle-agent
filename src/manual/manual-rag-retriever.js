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
  selectManualCorpusForContext,
} from "./manual-corpus-registry.js";
import { throwIfAborted } from "../runtime/abort-utils.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const RETRIEVAL_METADATA = {
  retrievalMode: "keyword-fallback",
  embeddingStatus: "pending",
  lexicalIndex: "manual-corpus-lexical-index@0.2.0",
};

let cachedChunks = null;
let cachedChunksPath = "";
let cachedLexicalIndex = null;
let cachedLexicalIndexPath = "";

const QUERY_BOILERPLATE_WORDS = new Set(["怎么", "如何", "一下", "可以", "什么", "哪些", "事项", "一下子"]);

export async function loadManualChunks(options = {}) {
  throwIfAborted(options.signal);
  const { chunksPath } = resolveManualRetrieverPaths(options);
  if (cachedChunks && cachedChunksPath === chunksPath) return cachedChunks;

  const readFileImpl = options.readFileImpl || readFile;
  const jsonl = await readFileImpl(chunksPath, {
    encoding: "utf8",
    signal: options.signal,
  });
  throwIfAborted(options.signal);
  cachedChunks = jsonl
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  throwIfAborted(options.signal);
  cachedChunksPath = chunksPath;
  return cachedChunks;
}

export async function retrieveManualChunks(query, options = {}) {
  throwIfAborted(options.signal);
  const normalizedQuery = normalizeText(query);
  const selection = selectManualCorpusForContext({
    rawText: query,
    vehicleModel: options.vehicleModel,
    corpusId: options.corpusId,
    profileMode: options.profileMode,
    allowDevelopmentAssumedCorpus: options.allowDevelopmentAssumedCorpus,
  });
  const corpusOptions = { ...options, corpusId: selection.corpusId || options.corpusId };
  if (!normalizedQuery) return withMetadata([], buildEmptyEligibilityTelemetry(query, corpusOptions, selection));
  if (!selection.applicable) return withMetadata([], buildEmptyEligibilityTelemetry(query, corpusOptions, selection));

  const topK = Number.isFinite(options.topK) ? Math.max(0, options.topK) : 5;
  if (topK === 0) return withMetadata([], buildEmptyEligibilityTelemetry(query, corpusOptions, selection));
  const artifacts = getManualCorpusArtifacts(selection.corpusId);
  if (artifacts.retrievalReady === false || !artifacts.chunksPath) {
    return withMetadata([], {
      ...buildEmptyEligibilityTelemetry(query, corpusOptions, selection),
      corpusId: artifacts.corpusId,
      corpusTitle: artifacts.title,
      manualCorpusSelection: selection,
      corpusArtifactStatus: "unavailable",
      missReason: "corpus-artifact-unavailable",
    });
  }

  const chunks = await loadManualChunks(corpusOptions);
  throwIfAborted(options.signal);
  const { chunksPath } = resolveManualRetrieverPaths(corpusOptions);
  const lexicalIndex = getManualLexicalIndex(chunks, chunksPath);
  throwIfAborted(options.signal);
  const categories = normalizeCategoryFilter(options);
  const queryTokens = tokenizeQuery(normalizedQuery, lexicalIndex);
  throwIfAborted(options.signal);

  const candidates = chunks
    .filter((chunk) => matchesCategory(chunk, categories))
    .map((chunk) => {
      const score = scoreChunk(chunk, normalizedQuery, queryTokens, lexicalIndex);
      return score > 0 ? toResult(chunk, score) : null;
    })
    .filter(Boolean)
    .sort(compareResults)
    .slice(0, Math.min(chunks.length, Math.max(topK * 3, topK)));

  throwIfAborted(options.signal);
  const eligibility = filterManualEvidence(normalizedQuery, candidates, {
    retrievalMode: RETRIEVAL_METADATA.retrievalMode,
    vehicleModel: options.vehicleModel,
    corpusId: selection.corpusId,
  });
  return withMetadata(eligibility.evidence.slice(0, topK), { ...eligibility.telemetry, manualCorpusSelection: selection });
}

export async function buildManualEvidenceSummary(query, options = {}) {
  throwIfAborted(options.signal);
  const chunks = await retrieveManualChunks(query, options);
  throwIfAborted(options.signal);
  const selection = chunks.metadata?.manualCorpusSelection;
  const corpusArtifacts = selection?.applicable ? getManualCorpusArtifacts(selection.corpusId) : { title: "已接入的用户手册" };
  return buildPresentedManualEvidenceSummary({
    query,
    chunks,
    missSummary: { summary: formatManualMissSummary(corpusArtifacts, "关键词 fallback") },
    missTelemetry: { ...chunks.metadata, corpusId: corpusArtifacts.corpusId, corpusTitle: corpusArtifacts.title },
    makeExcerpt: (chunk) => makeExcerpt(chunk.text, query),
  });
}

function buildEmptyEligibilityTelemetry(query, options, selection) {
  return buildEmptyManualEligibilityTelemetry({
    query,
    options,
    selection,
    retrievalMode: RETRIEVAL_METADATA.retrievalMode,
    filterEvidence: filterManualEvidence,
  });
}

function resolveManualRetrieverPaths(options = {}) {
  const artifacts = getManualCorpusArtifacts(options.corpusId);
  return {
    corpusId: artifacts.corpusId,
    corpusTitle: artifacts.title,
    chunksPath: options.chunksPath || path.join(root, artifacts.chunksPath),
  };
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

function scoreChunk(chunk, normalizedQuery, queryTokens, lexicalIndex) {
  const text = normalizeText(chunk.text);
  const sectionTitle = normalizeText(chunk.sectionTitle);
  const sectionLeaf = sectionTitle.split("/").pop() || sectionTitle;
  const category = normalizeText(chunk.category);
  const tags = Array.isArray(chunk.tags) ? chunk.tags.map(normalizeText) : [];
  const haystack = `${sectionTitle}\n${category}\n${tags.join("\n")}\n${text}`;
  let score = 0;
  let matchedManualAnchor = false;

  if (text.includes(normalizedQuery)) score += 12;
  if (sectionTitle.includes(normalizedQuery)) {
    matchedManualAnchor = true;
    score += 16;
  }
  if (category === normalizedQuery || tags.includes(normalizedQuery)) {
    matchedManualAnchor = true;
    score += 20;
  }

  for (const token of queryTokens) {
    if (!token || QUERY_BOILERPLATE_WORDS.has(token)) continue;
    const lexicalWeight = getLexicalWeight(token, lexicalIndex);
    const genericMetadataToken = isGenericMetadataToken(token, lexicalIndex);
    if (text.includes(token)) score += (token.length > 1 ? 4 : 1) * lexicalWeight;
    if (sectionTitle.includes(token)) score += (token.length > 1 ? 8 : 2) * lexicalWeight;
    if (!genericMetadataToken && category.includes(token)) score += (token.length > 1 ? 10 : 3) * lexicalWeight;
    if (!genericMetadataToken && tags.some((tag) => tag.includes(token))) {
      score += (token.length > 1 ? 9 : 3) * lexicalWeight;
    }
    if (haystack.includes(token)) score += lexicalWeight;
    if (isManualAnchorToken(token, lexicalIndex) && haystack.includes(token)) {
      matchedManualAnchor = true;
    }
  }

  for (const phrase of extractQueryPhrases(normalizedQuery, lexicalIndex)) {
    if (sectionLeaf === phrase) score += 36;
    if (text.includes(phrase)) score += phrase.length * 3;
    if (sectionTitle.includes(phrase)) score += phrase.length * 4;
    if (tags.some((tag) => tag.includes(phrase))) score += phrase.length * 4;
  }

  if (!matchedManualAnchor) return 0;
  return Number(score.toFixed(2));
}

function tokenizeQuery(query, lexicalIndex) {
  const tokens = new Set();
  const words = query.match(/[a-z0-9]+|[\u4e00-\u9fff]+/gi) || [];
  for (const word of words) {
    if (/^[a-z0-9]+$/i.test(word)) {
      tokens.add(word.toLowerCase());
      continue;
    }
    let lexicalTermCount = 0;
    for (const term of lexicalIndex?.terms || []) {
      if (!word.includes(term)) continue;
      tokens.add(term);
      lexicalTermCount += 1;
      if (lexicalTermCount >= 48) break;
    }
    for (let size = 2; size <= Math.min(4, word.length); size += 1) {
      for (let index = 0; index <= word.length - size; index += 1) {
        tokens.add(word.slice(index, index + size));
      }
    }
  }
  for (const synonym of expandManualLexicalSynonyms(tokens, lexicalIndex)) tokens.add(synonym);
  return [...tokens].filter((token) => !QUERY_BOILERPLATE_WORDS.has(token));
}

function extractQueryPhrases(query, lexicalIndex) {
  const phrases = new Set();
  for (const term of lexicalIndex?.terms || []) {
    if (query.includes(term) && term.length > 1) phrases.add(term);
    if (phrases.size >= 48) break;
  }
  if (query.length > 1) phrases.add(query);
  return [...phrases];
}

function getManualLexicalIndex(chunks, chunksPath) {
  if (cachedLexicalIndex && cachedLexicalIndexPath === chunksPath) return cachedLexicalIndex;
  cachedLexicalIndex = buildManualLexicalIndex(chunks);
  cachedLexicalIndexPath = chunksPath;
  return cachedLexicalIndex;
}

function buildManualLexicalIndex(chunks) {
  const documentFrequency = new Map();
  const metadataTerms = new Set();
  const totalDocs = chunks.length || 1;

  for (const chunk of chunks) {
    const chunkMetadataTerms = collectMetadataTerms(chunk);
    for (const term of chunkMetadataTerms) metadataTerms.add(term);

    const docTerms = new Set(chunkMetadataTerms);
    for (const term of collectCorpusTerms(chunk)) docTerms.add(term);

    for (const term of docTerms) {
      if (!isUsefulLexicalTerm(term)) continue;
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  const termStats = new Map();
  const maxCommonDocs = Math.max(24, Math.ceil(totalDocs * 0.35));

  for (const [term, df] of documentFrequency.entries()) {
    const fromMetadata = metadataTerms.has(term);
    if (!fromMetadata && df < 2) continue;
    if (!fromMetadata && df > maxCommonDocs) continue;
    termStats.set(term, {
      df,
      idf: Number((Math.log(1 + totalDocs / (1 + df)) + 1).toFixed(4)),
      fromMetadata,
      genericForMetadata: df / totalDocs >= 0.18,
    });
  }

  const terms = [...termStats.keys()].sort((left, right) => {
    if (right.length !== left.length) return right.length - left.length;
    const leftDf = termStats.get(left)?.df || 0;
    const rightDf = termStats.get(right)?.df || 0;
    if (leftDf !== rightDf) return leftDf - rightDf;
    return left.localeCompare(right);
  });

  return {
    version: RETRIEVAL_METADATA.lexicalIndex,
    totalDocs,
    terms,
    termStats,
    synonymPolicy: buildManualLexicalSynonymPolicy(termStats),
  };
}

function buildManualLexicalSynonymPolicy(termStats = new Map()) {
  const groups = [
    ["遮阳帘", "遮阳板", "遮光帘"],
    ["香氛", "香薰", "香味"],
    ["车外放电", "外放电", "对外放电", "v2l"],
    ["前舱盖", "引擎盖", "机舱盖"],
  ];
  const aliases = new Map();
  for (const group of groups) {
    const canonical = group.find((term) => termStats.has(term));
    if (!canonical) continue;
    for (const term of group) {
      if (term !== canonical) aliases.set(term.toLowerCase(), canonical);
    }
  }
  return {
    id: "manual-corpus-lexical-synonym-overlay@0.1.0",
    provenance: "local-dev corpus-derived alias overlay; aliases activate only when the canonical term exists in the current corpus lexical index",
    aliases,
  };
}

function expandManualLexicalSynonyms(tokens, lexicalIndex = {}) {
  const aliases = lexicalIndex.synonymPolicy?.aliases;
  if (!(aliases instanceof Map)) return [];
  const expanded = new Set();
  for (const token of tokens) {
    const alias = aliases.get(String(token || "").toLowerCase());
    if (alias) expanded.add(alias);
  }
  return [...expanded];
}

function collectMetadataTerms(chunk) {
  const terms = new Set();
  const rawParts = [
    chunk.category,
    chunk.sectionTitle,
    ...(Array.isArray(chunk.tags) ? chunk.tags : []),
  ];
  for (const part of rawParts) {
    for (const segment of splitLexicalSegments(part)) {
      if (segment.length >= 2 && segment.length <= 18) terms.add(segment);
      for (const term of collectChineseNgrams(segment, 2, 6)) terms.add(term);
    }
  }
  return terms;
}

function collectCorpusTerms(chunk) {
  const text = normalizeText(
    `${chunk.sectionTitle || ""}\n${chunk.category || ""}\n${Array.isArray(chunk.tags) ? chunk.tags.join("\n") : ""}\n${chunk.text || ""}`,
  );
  const terms = new Set();
  const words = text.match(/[a-z0-9]+|[\u4e00-\u9fff]+/gi) || [];
  for (const word of words) {
    if (/^[a-z0-9]+$/i.test(word)) {
      if (word.length > 1 && !/^\d+$/.test(word)) terms.add(word.toLowerCase());
      continue;
    }
    for (const term of collectChineseNgrams(word, 2, 6)) terms.add(term);
  }
  return terms;
}

function splitLexicalSegments(value) {
  return normalizeText(value)
    .split(/[/>｜|,，、:：;；()（）[\]【】"'“”‘’\s]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function collectChineseNgrams(value, minSize, maxSize) {
  const terms = new Set();
  const words = String(value || "").match(/[\u4e00-\u9fff]+/g) || [];
  for (const word of words) {
    for (let size = minSize; size <= Math.min(maxSize, word.length); size += 1) {
      for (let index = 0; index <= word.length - size; index += 1) {
        terms.add(word.slice(index, index + size));
      }
    }
  }
  return terms;
}

function isUsefulLexicalTerm(term) {
  if (!term || term.length < 2 || term.length > 18) return false;
  if (QUERY_BOILERPLATE_WORDS.has(term)) return false;
  if (/^\d+$/.test(term)) return false;
  return true;
}

function getLexicalWeight(token, lexicalIndex) {
  const stat = lexicalIndex?.termStats?.get(token);
  if (!stat) return 1;
  return Math.min(3, Math.max(1, stat.idf));
}

function isGenericMetadataToken(token, lexicalIndex) {
  if (token.length <= 1) return true;
  const stat = lexicalIndex?.termStats?.get(token);
  return Boolean(stat?.genericForMetadata);
}

function isManualAnchorToken(token, lexicalIndex) {
  const stat = lexicalIndex?.termStats?.get(token);
  return Boolean(stat?.fromMetadata && !stat.genericForMetadata);
}

function toResult(chunk, score) {
  const pageEnd = chunk.pageEnd || chunk.pageStart;
  const citation = formatManualCitationForChunk({ ...chunk, pageEnd });
  return toManualRetrievalEvidence({
    ...chunk,
    pageEnd,
    reviewedCitationSpans: buildReviewedCitationProofs(chunk),
    citation,
  }, {
    score,
    retrievalMetadata: RETRIEVAL_METADATA,
  });
}

function compareResults(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  if (left.pageStart !== right.pageStart) return left.pageStart - right.pageStart;
  return String(left.chunkId).localeCompare(String(right.chunkId));
}

function withMetadata(results, eligibilityTelemetry = {}) {
  Object.defineProperty(results, "metadata", {
    value: { ...RETRIEVAL_METADATA, ...eligibilityTelemetry, count: results.length },
    enumerable: false,
  });
  return results;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

function makeExcerpt(text, query) {
  const compactText = String(text || "").replace(/\s+/g, " ").trim();
  const tokens = tokenizeQuery(normalizeText(query)).filter((token) => token.length > 1);
  const hitIndex = tokens
    .map((token) => compactText.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const start = hitIndex >= 0 ? Math.max(0, hitIndex - 24) : 0;
  const excerpt = compactText.slice(start, start + 96);
  return `${start > 0 ? "..." : ""}${excerpt}${start + 96 < compactText.length ? "..." : ""}`;
}
