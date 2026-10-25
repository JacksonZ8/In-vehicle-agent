export const MANUAL_CLAIM_GROUNDING_POLICY = Object.freeze({
  id: "nio-manual-claim-grounding",
  version: "1.4.0",
  answerClaims: Object.freeze({
    id: "nio-manual-answer-claims",
    version: "1.0.0",
    supportedStatus: "supported",
    evidenceExtractStatus: "evidence-extract",
    provenance: "manual-claim-grounding",
  }),
  deterministicFacts: Object.freeze({
    id: "nio-manual-deterministic-fact-extraction",
    version: "1.0.0",
    negation: Object.freeze({ pattern: "(?:不得|不能|不可|禁止|避免|无需|不需|不要|未|没有|无)", flags: "u" }),
    conditions: Object.freeze([
      Object.freeze({ id: "driving", pattern: "(?:行驶中|车辆行驶|行车时|高速行驶)", flags: "u", opposes: Object.freeze(["stationary", "park-gear"]) }),
      Object.freeze({ id: "stationary", pattern: "(?:静止时|车辆静止|停稳后|停车后)", flags: "u", opposes: Object.freeze(["driving"]) }),
      Object.freeze({ id: "park-gear", pattern: "(?:P\\s*挡|驻车挡)", flags: "iu", opposes: Object.freeze(["driving"]) }),
      Object.freeze({ id: "before-opening", pattern: "(?:开启|打开|开启尾门|操作)前", flags: "u", opposes: Object.freeze(["after-opening"]) }),
      Object.freeze({ id: "before-closing", pattern: "(?:关闭|关闭车窗|操作)前", flags: "u", opposes: Object.freeze(["after-closing"]) }),
      Object.freeze({ id: "after-opening", pattern: "(?:开启|打开)后", flags: "u", opposes: Object.freeze(["before-opening"]) }),
      Object.freeze({ id: "after-closing", pattern: "(?:关闭)后", flags: "u", opposes: Object.freeze(["before-closing"]) }),
    ]),
    component: Object.freeze({
      pattern: "(?:左前|右前|左后|右后|主驾|副驾)?(?:尾门|前舱盖|引擎盖|车门|车窗|天窗|遮阳帘|儿童锁|座椅|安全带|雨刮(?:片)?|轮胎|胎压|空调|香氛|充电口|电池|制动|方向盘|车灯|后备箱)",
      flags: "gu",
    }),
    numberUnit: Object.freeze({
      pattern: "(-?\\d+(?:\\.\\d+)?)\\s*(℃|%|km\\/h|kPa|bar|mm|cm|m|km|小时|分钟|秒|度|毫米|厘米|米|公里|千帕)",
      flags: "giu",
    }),
    unitAliases: Object.freeze({
      毫米: "mm",
      厘米: "cm",
      公里: "km",
      千帕: "kpa",
    }),
  }),
  lexicalCandidate: Object.freeze({
    id: "nio-manual-lexical-candidate-scoring",
    version: "1.0.0",
    minCandidateSharedTerms: 1,
    minSupportSharedTerms: 2,
    minSupportCoverage: 0.58,
    sharedScoreWeight: 10,
    chineseNgramMin: 2,
    chineseNgramMax: 4,
    genericTerms: Object.freeze(["用户", "手册", "车辆", "可以", "需要", "应该", "进行", "相关", "情况", "注意", "确认", "操作", "使用", "功能", "系统"]),
  }),
  speech: Object.freeze({
    defaultMaxClaims: 3,
    maxClaimsLimit: 5,
    defaultTargetChars: 120,
    minTargetChars: 40,
    // Backward-compatible aliases for existing Runtime/HMI assertions.
    maxClaims: 3,
    targetChars: 120,
  }),
});

const compiledPolicy = compileManualClaimGroundingPolicy(MANUAL_CLAIM_GROUNDING_POLICY);

export function groundManualAnswer(summary, evidence, question, options = {}) {
  const source = String(summary || "").trim();
  const items = normalizeEvidence(evidence);
  const claims = splitManualClaims(source).filter(isVerifiableManualClaim);
  const claimAudits = claims.map((claim, index) => evaluateClaim(claim, index, items, question));
  const retained = claimAudits.filter((item) => item.status === "supported");
  const unsupported = claimAudits.filter((item) => item.status !== "supported");
  const fallbackApplied = retained.length === 0;
  const fallback = fallbackApplied ? buildEvidenceOnlyFallback(items, question, options) : null;
  const answer = fallbackApplied ? fallback.answer : retained.map((item) => item.claim).join("");
  const citedIds = fallbackApplied
    ? fallback.evidenceIds
    : [...new Set(retained.map((item) => item.supportedBy.chunkId))];
  const citedEvidence = citedIds.map((id) => items.find((item) => item.chunkId === id)).filter(Boolean);
  const answerClaims = buildManualAnswerClaims(retained, fallback);

  return {
    answer,
    citedEvidence,
    audit: {
      policy: { ...MANUAL_CLAIM_GROUNDING_POLICY },
      status: fallbackApplied ? "fallback" : unsupported.length ? "partial" : "grounded",
      answerClaims,
      answerClaimsPolicy: { ...MANUAL_CLAIM_GROUNDING_POLICY.answerClaims },
      claimAudits,
      unsupportedClaims: unsupported.map((item) => item.claim),
      retainedClaims: retained.map((item) => item.claim),
      fallbackApplied,
      fallback: fallbackApplied ? fallback.audit : null,
      evidenceIds: citedIds,
      answerChars: answer.length,
    },
  };
}

function buildManualAnswerClaims(retained, fallback) {
  const policy = MANUAL_CLAIM_GROUNDING_POLICY.answerClaims;
  if (retained.length) {
    return retained.map((item) => ({
      claimId: item.claimId,
      text: item.claim,
      status: policy.supportedStatus,
      provenance: policy.provenance,
      evidence: item.supportedBy ? {
        chunkId: item.supportedBy.chunkId,
        citation: item.supportedBy.citation,
        sentence: item.supportedBy.sentence,
      } : null,
      deterministicFacts: item.validation?.deterministicFacts?.claim || null,
    }));
  }
  const selected = Array.isArray(fallback?.audit?.selected) ? fallback.audit.selected : [];
  return selected.map((item, index) => ({
    claimId: `fallback-${index + 1}`,
    text: item.sentence,
    status: policy.evidenceExtractStatus,
    provenance: policy.provenance,
    evidence: {
      chunkId: item.chunkId,
      citation: item.citation,
      sentence: item.sentence,
    },
    lexicalCandidate: item.lexicalCandidate || null,
  }));
}

function evaluateClaim(claim, index, evidence, question) {
  const candidates = evidence.flatMap((item) => splitManualClaims(item.excerpt || item.text || "").map((sentence, sentenceIndex) => {
    const lexical = lexicalCandidateScore(claim, sentence);
    return { item, sentence, sentenceIndex, lexical };
  })).filter((item) => item.lexical.shared >= compiledPolicy.lexical.minCandidateSharedTerms)
    .sort((left, right) => right.lexical.score - left.lexical.score);
  const attempts = candidates.map((candidate) => validateCandidate(claim, candidate, question));
  const supported = attempts.find((item) => item.supported);
  return {
    claimId: `claim-${index + 1}`,
    claim,
    status: supported ? "supported" : "unsupported",
    supportedBy: supported ? {
      chunkId: supported.chunkId,
      citation: supported.citation,
      sentence: supported.sentence,
    } : null,
    candidateEvidenceIds: [...new Set(candidates.map((item) => item.item.chunkId))],
    validation: supported || attempts[0] || { supported: false, reasons: ["no-lexical-candidate"] },
  };
}

function validateCandidate(claim, candidate, question) {
  const evidenceSentence = candidate.sentence;
  const reasons = [];
  const claimFacts = extractDeterministicFacts(claim);
  const evidenceFacts = extractDeterministicFacts(evidenceSentence);
  const contextualComponents = claimFacts.components.length ? claimFacts.components : extractDeterministicFacts(question).components;
  if (!numberFactsSupported(claimFacts.numbers, evidenceFacts.numbers)) reasons.push("number-or-unit-mismatch");
  if (claimFacts.negative !== evidenceFacts.negative && (claimFacts.negative || evidenceFacts.negative)) reasons.push("polarity-mismatch");
  if (!subjectsCompatible(contextualComponents, evidenceFacts.components)) reasons.push("subject-mismatch");
  if (!conditionsCompatible(claimFacts.conditions, evidenceFacts.conditions)) reasons.push("condition-or-temporal-mismatch");
  if (
    candidate.lexical.coverage < compiledPolicy.lexical.minSupportCoverage
    || candidate.lexical.shared < compiledPolicy.lexical.minSupportSharedTerms
  ) reasons.push("insufficient-lexical-candidate");
  return {
    supported: reasons.length === 0,
    reasons,
    chunkId: candidate.item.chunkId,
    citation: candidate.item.citation,
    sentence: evidenceSentence,
    lexicalCandidate: candidate.lexical,
    deterministicFacts: { claim: claimFacts, evidence: evidenceFacts },
  };
}

function extractDeterministicFacts(text) {
  const source = String(text || "");
  return {
    numbers: [...source.matchAll(compiledPolicy.facts.numberUnit)].map((match) => ({ value: Number(match[1]), unit: normalizeUnit(match[2]) })),
    negative: compiledPolicy.facts.negation.test(source),
    components: [...new Set(source.match(compiledPolicy.facts.component) || [])],
    conditions: compiledPolicy.facts.conditions.filter(({ pattern }) => pattern.test(source)).map(({ id }) => id),
  };
}

function numberFactsSupported(claimFacts, evidenceFacts) {
  return claimFacts.every((claim) => evidenceFacts.some((evidence) => evidence.value === claim.value && evidence.unit === claim.unit));
}

function normalizeUnit(unit) {
  const value = String(unit || "").toLowerCase();
  return compiledPolicy.facts.unitAliases[value] || value;
}

function subjectsCompatible(claim, evidence) {
  if (!claim.length || !evidence.length) return claim.length === 0 && evidence.length === 0;
  return claim.every((subject) => evidence.includes(subject));
}

function conditionsCompatible(claim, evidence) {
  if (evidence.some((condition) => !claim.includes(condition)) || claim.some((condition) => !evidence.includes(condition))) return false;
  return !claim.some((condition) => evidence.some((actual) => compiledPolicy.facts.oppositeConditions.get(condition)?.has(actual)));
}

function lexicalCandidateScore(claim, evidenceSentence) {
  const claimTerms = extractLexicalTerms(claim);
  const evidenceTerms = new Set(extractLexicalTerms(evidenceSentence));
  const shared = claimTerms.filter((term) => evidenceTerms.has(term)).length;
  return {
    shared,
    coverage: claimTerms.length ? shared / claimTerms.length : 0,
    score: shared * compiledPolicy.lexical.sharedScoreWeight + (claimTerms.length ? shared / claimTerms.length : 0),
  };
}

function extractLexicalTerms(text) {
  const source = String(text || "");
  const normalized = String(text || "")
    .replace(/《[^》]+》/g, "")
    .replace(/第\s*\d+(?:-\d+)?\s*页/g, "")
    .replace(/[^\u3400-\u9fffA-Za-z0-9%]+/g, "");
  const terms = new Set();
  for (const component of source.match(compiledPolicy.facts.component) || []) terms.add(`component:${component}`);
  for (const match of source.matchAll(compiledPolicy.facts.numberUnit)) terms.add(`number:${Number(match[1])}:${normalizeUnit(match[2])}`);
  for (const { id, pattern } of compiledPolicy.facts.conditions) {
    if (pattern.test(source)) terms.add(`condition:${id}`);
  }
  for (const word of normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]+/gi) || []) {
    if (/^[a-z0-9]+$/i.test(word)) {
      if (word.length > 1 && !/^\d+$/.test(word)) terms.add(word.toLowerCase());
      continue;
    }
    for (let size = compiledPolicy.lexical.chineseNgramMin; size <= Math.min(compiledPolicy.lexical.chineseNgramMax, word.length); size += 1) {
      for (let index = 0; index <= word.length - size; index += 1) {
        const term = word.slice(index, index + size).toLowerCase();
        if (!compiledPolicy.lexical.genericTerms.has(term)) terms.add(term);
      }
    }
  }
  return [...terms];
}

function buildEvidenceOnlyFallback(evidence, question, options) {
  const speechPolicy = MANUAL_CLAIM_GROUNDING_POLICY.speech;
  const maxClaims = Math.max(1, Math.min(
    speechPolicy.maxClaimsLimit,
    Number(options.maxFallbackClaims || speechPolicy.defaultMaxClaims),
  ));
  const targetChars = Math.max(
    speechPolicy.minTargetChars,
    Number(options.targetSpeechChars || speechPolicy.defaultTargetChars),
  );
  const ranked = evidence.flatMap((item) => splitManualClaims(item.excerpt || item.text || "").map((sentence, index) => ({
    item, sentence, index, lexical: lexicalCandidateScore(question, sentence),
  }))).sort((left, right) => right.lexical.score - left.lexical.score || left.index - right.index);
  const candidates = ranked.filter((item) => item.lexical.shared > 0);
  if (candidates.length === 0) {
    const answer = "我没有在当前手册证据里找到能回答这个问题的依据，不能编造操作步骤。";
    return {
      answer,
      evidenceIds: [],
      audit: {
        mode: "no-question-related-evidence",
        selected: [],
        maxClaims,
        targetChars,
        boundaryReason: "zero-lexical-overlap",
      },
    };
  }
  const selected = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (selected.length >= maxClaims) break;
    if (selected.length > 0 && chars + candidate.sentence.length > targetChars) continue;
    selected.push(candidate);
    chars += candidate.sentence.length;
  }
  const answer = selected.map((item) => item.sentence).join("");
  return {
    answer,
    evidenceIds: [...new Set(selected.map((item) => item.item.chunkId))],
    audit: {
      mode: "question-related-evidence-extract",
      selected: selected.map((item) => ({ chunkId: item.item.chunkId, citation: item.item.citation, sentence: item.sentence, lexicalCandidate: item.lexical })),
      maxClaims,
      targetChars,
    },
  };
}

function normalizeEvidence(evidence) {
  return (Array.isArray(evidence) ? evidence : []).map((item) => ({ ...item, excerpt: item.excerpt || item.text || "" }));
}

export function splitManualClaims(text) {
  return String(text || "")
    .replace(/\n*手册依据：[\s\S]*$/u, "")
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isVerifiableManualClaim(claim) {
  return !/(当前|无法|不能|未能|没有).*(服务|检索|访问|编造|提供)|降级原因|仅供参考|请查阅|建议咨询|手册依据/u.test(claim);
}

function compileManualClaimGroundingPolicy(policy) {
  const facts = policy.deterministicFacts;
  return Object.freeze({
    facts: Object.freeze({
      negation: compilePolicyRegex(facts.negation),
      conditions: facts.conditions.map((condition) => Object.freeze({
        id: condition.id,
        pattern: compilePolicyRegex(condition),
      })),
      oppositeConditions: new Map(facts.conditions.map((condition) => [condition.id, new Set(condition.opposes || [])])),
      component: compilePolicyRegex(facts.component),
      numberUnit: compilePolicyRegex(facts.numberUnit),
      unitAliases: Object.fromEntries(Object.entries(facts.unitAliases || {}).map(([from, to]) => [from.toLowerCase(), String(to).toLowerCase()])),
    }),
    lexical: Object.freeze({
      ...policy.lexicalCandidate,
      genericTerms: new Set(policy.lexicalCandidate.genericTerms || []),
    }),
  });
}

function compilePolicyRegex(spec) {
  return new RegExp(spec.pattern, spec.flags || "u");
}
