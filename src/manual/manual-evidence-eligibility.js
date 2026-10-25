import {
  findManualCorpusForCandidate,
  getManualCorpus,
  getManualCorpusRegistryAudit,
  MANUAL_CORPUS_REGISTRY,
  selectManualCorpusForContext,
} from "./manual-corpus-registry.js";

export const MANUAL_EVIDENCE_ELIGIBILITY_POLICY = Object.freeze({
  id: "nio-manual-evidence-eligibility",
  version: "1.1.0",
  registry: MANUAL_CORPUS_REGISTRY,
  corpus: Object.freeze({
    sourceId: getManualCorpus().sourceId,
    title: getManualCorpus().title,
    model: getManualCorpus().model,
  }),
  thresholds: getManualCorpus().calibration.thresholds,
});

const QUERY_NOISE = /^(?:[啊哦嗯哈s!?！？。,.]|测试|test){2,}$/i;
const NON_MANUAL_REQUEST = /(?:天气|气温|降水|空气质量|股票|股价|基金|新闻|汇率|附近|周边).*(?:实时|今天|现在|多少|推荐|排队|营业|距离)|(?:今天|现在).*(?:天气|股价|股票)|(?:附近|周边).*(?:餐厅|充电站|换电站|排队)/;
const CONTENT_NOISE = /封面|目录/;
const QUESTION_WORDS = new Set(["如何", "怎么", "怎样", "哪些", "什么", "是否", "可以", "用户手册", "手册", "请问", "告诉", "一下"]);
export const MANUAL_EVIDENCE_REF_CONTRACT = "manual-evidence-ref@1.0.0";
const MANUAL_EVIDENCE_REF_FIELDS = Object.freeze([
  "sourceId", "sourceVersion", "chunkId", "pageStart", "pageEnd", "excerpt", "score",
]);
const MANUAL_EVIDENCE_SCORE_FIELDS = Object.freeze(["retrieval", "rerank", "grounding"]);
const trustedManualRagConsumerEvidence = new WeakSet();
const trustedManualRagConsumerEvidenceRefs = new WeakSet();
export function evaluateManualEvidenceEligibility(query, candidate, options = {}) {
  const retrievalMode = String(options.retrievalMode || candidate?.retrievalMode || "unknown");
  const candidateCorpus = findManualCorpusForCandidate(candidate);
  const targetCorpus = candidateCorpus || getManualCorpus(options.corpusId);
  const applicability = resolveCorpusApplicability(query, options.vehicleModel, targetCorpus, options);
  const metrics = computeMetrics(query, candidate, retrievalMode, targetCorpus);
  const reasons = [];
  if (!candidateCorpus) reasons.push("source-not-trusted");
  if (candidate && targetCorpus && candidate.title !== targetCorpus.title) reasons.push("manual-title-mismatch");
  if (!applicability.applicable) reasons.push("not-applicable");
  if (QUERY_NOISE.test(normalize(query))) reasons.push("not-answerable");
  if (NON_MANUAL_REQUEST.test(normalize(query))) reasons.push("not-answerable");
  if (CONTENT_NOISE.test(String(candidate?.sectionTitle || "")) || Number(candidate?.pageStart) <= 1 || String(candidate?.text || candidate?.excerpt || "").trim().length < 12) reasons.push("document-noise");
  const threshold = targetCorpus?.calibration?.thresholds?.[retrievalMode] || targetCorpus?.calibration?.thresholds?.default || {};
  if (Number.isFinite(threshold.minScore) && (!Number.isFinite(metrics.score) || metrics.score < threshold.minScore)) reasons.push("low-retrieval-score");
  if (metrics.lexicalCoverage < threshold.minCoverage) reasons.push("low-query-coverage");
  if (metrics.queryEntities.length && metrics.entityCoverage < threshold.minEntityCoverage) reasons.push("low-entity-coverage");
  if (!metrics.answerabilitySignal) reasons.push("not-answerable");
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    metrics,
    applicability,
    policy: policyAudit(targetCorpus),
  };
}

export function filterManualEvidence(query, candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const fallbackCorpus = getManualCorpus(options.corpusId);
  const fallbackApplicability = resolveCorpusApplicability(query, options.vehicleModel, fallbackCorpus, options);
  const decisions = list.map((candidate, index) => {
    const { policy: _policy, ...decision } = evaluateManualEvidenceEligibility(query, candidate, options);
    return { index, chunkId: String(candidate?.chunkId || ""), ...decision };
  });
  const evidence = list.filter((_candidate, index) => decisions[index].eligible);
  const queryReasons = [
    ...(!fallbackApplicability.applicable ? ["not-applicable"] : []),
    ...(QUERY_NOISE.test(normalize(query)) || NON_MANUAL_REQUEST.test(normalize(query)) ? ["not-answerable"] : []),
  ];
  const rejectedReasons = [...new Set([
    ...queryReasons,
    ...decisions.flatMap((item) => item.eligible ? [] : item.reasons),
  ])];
  return {
    evidence,
    telemetry: {
      eligibilityPolicy: policyAudit(),
      assumedCorpus: decisions[0]?.applicability?.assumedCorpus === true,
      corpusApplicability: decisions[0]?.applicability || fallbackApplicability,
      candidateDecisions: decisions,
      acceptedCount: evidence.length,
      rejectedCount: list.length - evidence.length,
      missReason: evidence.length ? "" : classifyMissReason(rejectedReasons),
    },
  };
}

export function resolveManualRagApiStatus(evidence, telemetry = {}) {
  const missReason = String(telemetry?.missReason || "");
  if (
    telemetry?.corpusArtifactStatus === "unavailable"
    || telemetry?.embeddingStatus === "unavailable"
    || (telemetry?.rerankRequired === true && telemetry?.rerankStatus === "unavailable")
    || (missReason.endsWith("-unavailable") && missReason !== "rerank-unavailable")
  ) return "unavailable";
  if (Array.isArray(evidence) && evidence.length > 0) return "hit";
  return "miss";
}

export function isManualEvidenceRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  if (fields.length !== MANUAL_EVIDENCE_REF_FIELDS.length
    || fields.some((field) => !MANUAL_EVIDENCE_REF_FIELDS.includes(field))) return false;
  if (![value.sourceId, value.sourceVersion, value.chunkId, value.excerpt]
    .every((field) => typeof field === "string" && field.trim())) return false;
  if (!Number.isInteger(value.pageStart) || !Number.isInteger(value.pageEnd)) return false;
  const score = value.score;
  if (!score || typeof score !== "object" || Array.isArray(score)) return false;
  const scoreFields = Object.keys(score);
  if (scoreFields.length !== MANUAL_EVIDENCE_SCORE_FIELDS.length
    || scoreFields.some((field) => !MANUAL_EVIDENCE_SCORE_FIELDS.includes(field))) return false;
  return Number.isFinite(score.retrieval)
    && (score.rerank === null || Number.isFinite(score.rerank))
    && (score.grounding === null || Number.isFinite(score.grounding));
}

export function createManualRagConsumerEvidence(result = {}) {
  const requestedStatus = result?.status;
  const candidates = Array.isArray(result?.evidence) ? result.evidence : [];
  const knownStatus = ["hit", "miss", "unavailable"].includes(requestedStatus);
  const validHit = requestedStatus === "hit"
    && candidates.length > 0
    && candidates.every(isRegisteredManualEvidenceRef);
  const validEmptyResult = ["miss", "unavailable"].includes(requestedStatus)
    && candidates.length === 0;
  const validContract = knownStatus && (validHit || validEmptyResult);
  const status = validContract ? requestedStatus : "unavailable";
  const evidence = validContract && requestedStatus === "hit"
    ? candidates.map((ref) => {
      const trustedRef = Object.freeze({
        ...ref,
        score: Object.freeze({ ...ref.score }),
      });
      trustedManualRagConsumerEvidenceRefs.add(trustedRef);
      return trustedRef;
    })
    : [];
  const contractReason = validContract ? "" : "invalid-evidence-ref-contract";
  Object.defineProperty(evidence, "metadata", {
    value: Object.freeze({
      ...(result?.telemetry && typeof result.telemetry === "object" ? result.telemetry : {}),
      evidenceContract: MANUAL_EVIDENCE_REF_CONTRACT,
      query: String(result?.query || ""),
      runId: String(result?.runId || ""),
      status,
      summary: status === "unavailable" ? "" : String(result?.summary || ""),
      reason: contractReason || String(result?.reason || result?.telemetry?.reason || ""),
    }),
    enumerable: false,
  });
  const trustedEvidence = Object.freeze(evidence);
  trustedManualRagConsumerEvidence.add(trustedEvidence);
  return trustedEvidence;
}

export function isTrustedManualRagConsumerEvidence(value) {
  return Boolean(value && typeof value === "object"
    && trustedManualRagConsumerEvidence.has(value));
}

export function isTrustedManualRagConsumerEvidenceRef(value) {
  return Boolean(value && typeof value === "object"
    && trustedManualRagConsumerEvidenceRefs.has(value));
}

function isRegisteredManualEvidenceRef(ref) {
  if (!isManualEvidenceRef(ref)) return false;
  const corpus = getManualCorpus(ref.sourceId);
  return Boolean(corpus)
    && typeof corpus.sourceVersion === "string"
    && ref.sourceVersion === corpus.sourceVersion;
}

function resolveCorpusApplicability(query, vehicleModel, corpus = getManualCorpus(), options = {}) {
  const selection = selectManualCorpusForContext({
    rawText: query,
    vehicleModel,
    corpusId: corpus?.sourceId,
    profileMode: options.profileMode,
    allowDevelopmentAssumedCorpus: options.allowDevelopmentAssumedCorpus,
  });
  return {
    applicable: selection.applicable,
    requestedModels: selection.requestedModels,
    assumedCorpus: selection.assumedCorpus,
    corpusId: corpus?.sourceId || selection.corpusId || "",
    reason: selection.reason,
    selection,
  };
}

function computeMetrics(query, candidate, retrievalMode, corpus = getManualCorpus()) {
  const queryTokens = meaningfulTokens(query, corpus);
  const candidateText = [candidate?.sectionTitle, candidate?.category, ...(candidate?.tags || []), candidate?.text, candidate?.excerpt].filter(Boolean).join(" ");
  const candidateNormalized = normalize(candidateText);
  const matchedTokens = queryTokens.filter((token) => candidateNormalized.includes(token));
  const queryEntities = [...(corpus?.calibration?.vehicleEntities || [])].filter((entity) => normalize(query).includes(entity));
  const matchedEntities = queryEntities.filter((entity) => candidateNormalized.includes(entity));
  return {
    retrievalMode,
    score: Number.isFinite(Number(candidate?.score)) ? Number(candidate.score) : null,
    queryTokenCount: queryTokens.length,
    matchedTokenCount: matchedTokens.length,
    lexicalCoverage: ratio(matchedTokens.length, queryTokens.length),
    queryEntities,
    matchedEntities,
    entityCoverage: queryEntities.length ? ratio(matchedEntities.length, queryEntities.length) : 1,
    answerabilitySignal: [...(corpus?.calibration?.answerabilityTerms || [])].some((term) => candidateNormalized.includes(term)),
  };
}

function meaningfulTokens(value, corpus = getManualCorpus()) {
  const text = normalize(value).replace(/请查用户手册|用户手册|注意事项|有哪些|是什么|如何|怎么|怎样|应该|请问|告诉我|一下/g, "");
  const tokens = new Set([...(corpus?.calibration?.vehicleEntities || [])].filter((term) => text.includes(term)));
  for (const word of text.match(/[a-z0-9]+|[\u4e00-\u9fff]+/gi) || []) {
    if (/^[a-z0-9]+$/i.test(word)) { if (word.length > 1) tokens.add(word.toLowerCase()); continue; }
    for (let size = 2; size <= Math.min(4, word.length); size += 1) {
      for (let index = 0; index <= word.length - size; index += 1) {
        const token = word.slice(index, index + size);
        if (!QUESTION_WORDS.has(token)) tokens.add(token);
      }
    }
  }
  return [...tokens];
}

function classifyMissReason(reasons) {
  if (reasons.includes("not-applicable")) return "not-applicable";
  if (reasons.includes("not-answerable")) return "not-answerable";
  return "low-confidence";
}

function policyAudit(corpus = getManualCorpus()) {
  return {
    id: MANUAL_EVIDENCE_ELIGIBILITY_POLICY.id,
    version: MANUAL_EVIDENCE_ELIGIBILITY_POLICY.version,
    registry: getManualCorpusRegistryAudit(),
    corpus: corpus ? {
      sourceId: corpus.sourceId,
      title: corpus.title,
      model: corpus.model,
      applicableModels: [...corpus.applicableModels],
      calibration: {
        id: corpus.calibration.id,
        method: corpus.calibration.method,
        metrics: { ...corpus.calibration.metrics },
      },
    } : null,
    thresholds: corpus?.calibration?.thresholds || {},
  };
}

function ratio(a, b) { return b ? Number((a / b).toFixed(6)) : 0; }
function normalize(value) { return String(value || "").toLowerCase().replace(/\s+/g, "").trim(); }
