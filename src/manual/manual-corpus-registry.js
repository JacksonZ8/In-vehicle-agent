export const MANUAL_CORPUS_REGISTRY = Object.freeze({
  id: "nio-manual-corpus-registry",
  version: "1.2.0",
  defaultCorpusId: "nio-es8-user-manual-2026",
  profileMode: "local-dev",
  corpora: Object.freeze({
    "nio-es8-user-manual-2026": Object.freeze({
      sourceId: "nio-es8-user-manual-2026",
      sourceVersion: "2026",
      contentDigest: "sha256:bec6a67e8012ca81e006a07296b430e4107823a281772f2418664458ee40c590",
      pagesPath: "data/manual-rag/es8-manual-pages.jsonl",
      pdfPath: "references/ES8用户手册.pdf",
      title: "蔚来 ES8 用户手册",
      model: "ES8",
      applicableModels: Object.freeze(["ES8"]),
      localDevAssumedCorpusAllowed: true,
      artifacts: Object.freeze({
        chunksPath: "data/manual-rag/es8-manual-chunks.jsonl",
        embeddingsPath: "data/manual-rag/es8-manual-embeddings.jsonl",
      }),
      calibration: Object.freeze({
        id: "nio-es8-manual-evidence-eligibility-calibration@1.0.0",
        method: "12 authoritative ES8 positive queries plus explicit negative/OOD queries; keyword candidates use real corpus scores, vector boundary uses labeled injectable fixtures until online bge-m3 acceptance",
        metrics: Object.freeze({
          oodNegativeCases: 8,
          positiveGolden: "es8-manual-rag-golden-v1.json",
          falsePositiveRisk: "local-dev calibrated; not production-approved",
          recallBoundary: "single ES8 corpus only; do not extrapolate to ES6/ET/EC",
        }),
        thresholds: Object.freeze({
          "vector-bge-m3": Object.freeze({ minScore: 0.42, minCoverage: 0.12, minEntityCoverage: 0.34 }),
          "keyword-fallback": Object.freeze({ minScore: 70, minCoverage: 0.16, minEntityCoverage: 0.34 }),
          default: Object.freeze({ minCoverage: 0.12, minEntityCoverage: 0.5 }),
        }),
        vehicleEntities: Object.freeze([
          "尾门", "后备箱", "车窗", "智能钥匙", "雨刮", "防夹", "安全气囊", "警告灯", "儿童安全座椅",
          "方向盘", "双键重启", "胎压", "制动液", "空调滤芯", "座椅", "充电", "换电", "前舱盖", "安全带",
        ]),
        answerabilityTerms: Object.freeze(["设置", "调节", "开启", "关闭", "更换", "安装", "检查", "保养", "注意", "警告", "应", "请", "步骤", "故障", "操作"]),
      }),
    }),
    "nio-et5-user-manual-placeholder": Object.freeze({
      sourceId: "nio-et5-user-manual-placeholder",
      title: "蔚来 ET5 用户手册（占位，未接入索引）",
      model: "ET5",
      applicableModels: Object.freeze(["ET5"]),
      localDevAssumedCorpusAllowed: false,
      retrievalReady: false,
      artifacts: Object.freeze({
        chunksPath: "",
        embeddingsPath: "",
      }),
      calibration: Object.freeze({
        id: "nio-et5-manual-placeholder-calibration@0.1.0",
        method: "placeholder corpus for selector/cache/citation isolation only; no ET5 manual chunks or embeddings are indexed",
        metrics: Object.freeze({
          oodNegativeCases: 0,
          positiveGolden: "",
          falsePositiveRisk: "no retrieval allowed until real ET5 corpus is built and reviewed",
          recallBoundary: "placeholder only; must return artifact-unavailable instead of ES8 fallback",
        }),
        thresholds: Object.freeze({
          "vector-bge-m3": Object.freeze({ minScore: 1, minCoverage: 1, minEntityCoverage: 1 }),
          "keyword-fallback": Object.freeze({ minScore: Infinity, minCoverage: 1, minEntityCoverage: 1 }),
          default: Object.freeze({ minCoverage: 1, minEntityCoverage: 1 }),
        }),
        vehicleEntities: Object.freeze(["尾门", "车窗", "座椅", "空调", "充电", "胎压"]),
        answerabilityTerms: Object.freeze([]),
      }),
    }),
  }),
});

export function getManualCorpus(corpusId = MANUAL_CORPUS_REGISTRY.defaultCorpusId) {
  return MANUAL_CORPUS_REGISTRY.corpora[corpusId] || null;
}

export function findManualCorpusForCandidate(candidate = {}) {
  return Object.values(MANUAL_CORPUS_REGISTRY.corpora).find((corpus) => (
    candidate?.sourceId === corpus.sourceId && candidate?.title === corpus.title
  )) || null;
}

export function getManualCorpusArtifacts(corpusId = MANUAL_CORPUS_REGISTRY.defaultCorpusId) {
  const corpus = getManualCorpus(corpusId);
  return {
    corpusId: corpus?.sourceId || "",
    title: corpus?.title || "用户手册",
    retrievalReady: corpus?.retrievalReady !== false,
    chunksPath: corpus?.artifacts?.chunksPath || "",
    embeddingsPath: corpus?.artifacts?.embeddingsPath || "",
  };
}

export function selectManualCorpusForContext(context = {}) {
  const requestedModels = extractRequestedManualModels(`${context.rawText || ""} ${context.vehicleModel || ""}`);
  const explicitCorpus = context.corpusId ? getManualCorpus(context.corpusId) : null;
  const candidateCorpora = explicitCorpus ? [explicitCorpus] : Object.values(MANUAL_CORPUS_REGISTRY.corpora);

  if (requestedModels.length) {
    const corpus = candidateCorpora.find((item) => {
      const applicableModels = Array.isArray(item?.applicableModels) ? item.applicableModels : [];
      return requestedModels.every((model) => applicableModels.includes(model));
    });
    if (corpus) {
      return {
        status: "selected",
        applicable: true,
        assumedCorpus: false,
        corpusId: corpus.sourceId,
        title: corpus.title,
        requestedModels,
        reason: "explicit-model-match",
      };
    }
    return {
      status: "not-applicable",
      applicable: false,
      assumedCorpus: false,
      corpusId: explicitCorpus?.sourceId || "",
      title: explicitCorpus?.title || "",
      requestedModels,
      reason: "model-mismatch",
    };
  }

  const corpus = explicitCorpus || getManualCorpus();
  const allowDevelopmentAssumedCorpus = context.allowDevelopmentAssumedCorpus
    ?? (context.profileMode ? context.profileMode === "local-dev" : corpus?.localDevAssumedCorpusAllowed === true);
  if (!allowDevelopmentAssumedCorpus) {
    return {
      status: "not-applicable",
      applicable: false,
      assumedCorpus: false,
      corpusId: corpus?.sourceId || "",
      title: corpus?.title || "",
      requestedModels,
      reason: "no-model-specified-corpus-required",
    };
  }
  return {
    status: "selected",
    applicable: true,
    assumedCorpus: true,
    corpusId: corpus?.sourceId || "",
    title: corpus?.title || "",
    requestedModels,
    reason: "no-model-specified-development-corpus-assumed",
  };
}

export function extractRequestedManualModels(value = "") {
  const text = String(value || "").toUpperCase();
  return [...text.matchAll(/(?:NIO|蔚来)?\s*(ES|ET|EC|EL|EP)\s*[- ]?(\d{1,2})\b/g)]
    .map((match) => `${match[1]}${match[2]}`)
    .filter((model, index, list) => model && list.indexOf(model) === index);
}

export function formatManualCitationForChunk(chunk = {}, options = {}) {
  const corpus = findManualCorpusForCandidate(chunk)
    || getManualCorpus(chunk.sourceId)
    || getManualCorpus(options.corpusId);
  const title = chunk.title || corpus?.title || "用户手册";
  const pageStart = chunk.pageStart;
  const pageEnd = chunk.pageEnd || chunk.pageStart;
  const sectionTitle = chunk.sectionTitle || chunk.citation || "相关章节";
  const pages = pageStart === pageEnd || !pageEnd ? `p.${pageStart}` : `pp.${pageStart}-${pageEnd}`;
  return `${title} ${pages}「${sectionTitle}」`;
}

export function formatManualCitationForDisplay(chunk = {}, options = {}) {
  const corpus = findManualCorpusForCandidate(chunk)
    || getManualCorpus(chunk.sourceId)
    || getManualCorpus(options.corpusId);
  const title = chunk.title || corpus?.title || "用户手册";
  const pageStart = chunk.pageStart;
  const pageEnd = chunk.pageEnd || chunk.pageStart;
  const sectionTitle = chunk.sectionTitle || chunk.citation || "相关章节";
  const pages = pageStart === pageEnd || !pageEnd ? `第 ${pageStart} 页` : `第 ${pageStart}-${pageEnd} 页`;
  return `《${title}》${pages}「${sectionTitle}」`;
}

export function formatManualMissSummary(corpusLike = {}, retrievalLabel = "检索") {
  const corpus = findManualCorpusForCandidate(corpusLike)
    || getManualCorpus(corpusLike.sourceId)
    || getManualCorpus(corpusLike.corpusId);
  const title = corpusLike.title || corpus?.title || "已接入的用户手册";
  return `未在${title}${retrievalLabel ? `的${retrievalLabel}` : ""}中找到相关证据。`;
}

export function getManualCorpusRegistryAudit() {
  return {
    id: MANUAL_CORPUS_REGISTRY.id,
    version: MANUAL_CORPUS_REGISTRY.version,
    defaultCorpusId: MANUAL_CORPUS_REGISTRY.defaultCorpusId,
    profileMode: MANUAL_CORPUS_REGISTRY.profileMode,
    corpusIds: Object.keys(MANUAL_CORPUS_REGISTRY.corpora),
  };
}
