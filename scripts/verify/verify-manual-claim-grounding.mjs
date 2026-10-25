import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { groundManualAnswer, MANUAL_CLAIM_GROUNDING_POLICY } from "../../src/manual/manual-claim-grounding.js";

const golden = JSON.parse(await readFile(new URL("../../data/manual-rag/manual-claim-grounding-golden-1.0.0.json", import.meta.url), "utf8"));
const source = await readFile(new URL("../../src/manual/manual-claim-grounding.js", import.meta.url), "utf8");
assert.deepEqual(golden.policy, { id: MANUAL_CLAIM_GROUNDING_POLICY.id, version: MANUAL_CLAIM_GROUNDING_POLICY.version });
assert.equal(
  `${MANUAL_CLAIM_GROUNDING_POLICY.id}@${MANUAL_CLAIM_GROUNDING_POLICY.version}`,
  "nio-manual-claim-grounding@1.4.0",
  "manual claim grounding policy must stay versioned",
);
assert.equal(
  `${MANUAL_CLAIM_GROUNDING_POLICY.answerClaims.id}@${MANUAL_CLAIM_GROUNDING_POLICY.answerClaims.version}`,
  "nio-manual-answer-claims@1.0.0",
  "manual answer claims policy must stay versioned",
);
assert.equal(
  `${MANUAL_CLAIM_GROUNDING_POLICY.deterministicFacts.id}@${MANUAL_CLAIM_GROUNDING_POLICY.deterministicFacts.version}`,
  "nio-manual-deterministic-fact-extraction@1.0.0",
  "deterministic fact extraction policy must stay versioned",
);
assert.equal(
  `${MANUAL_CLAIM_GROUNDING_POLICY.lexicalCandidate.id}@${MANUAL_CLAIM_GROUNDING_POLICY.lexicalCandidate.version}`,
  "nio-manual-lexical-candidate-scoring@1.0.0",
  "lexical candidate scoring policy must stay versioned",
);
assert.ok(
  ["negation", "component", "numberUnit"].every((name) => MANUAL_CLAIM_GROUNDING_POLICY.deterministicFacts[name]?.pattern),
  "deterministic fact policy must expose negation/component/numberUnit patterns",
);
assert.ok(
  MANUAL_CLAIM_GROUNDING_POLICY.deterministicFacts.conditions.length >= 7,
  "deterministic fact policy must expose condition patterns",
);
assert.ok(
  MANUAL_CLAIM_GROUNDING_POLICY.lexicalCandidate.genericTerms.includes("用户"),
  "lexical policy must expose generic term list",
);
assert.doesNotMatch(
  source,
  /const\s+(?:NEGATION_PATTERN|CONDITION_PATTERNS|OPPOSITE_CONDITIONS|COMPONENT_PATTERN|NUMBER_UNIT_PATTERN|GENERIC_LEXICAL_TERMS)\s*=/,
  "manual claim grounding must not keep standalone deterministic fact regex/set constants outside policy",
);
assert.doesNotMatch(
  source,
  /candidate\.lexical\.coverage\s*<\s*0\.58|candidate\.lexical\.shared\s*<\s*2|item\.lexical\.shared\s*>=\s*1|shared\s*\*\s*10|size\s*<=\s*Math\.min\(4,/,
  "manual claim grounding must not keep standalone lexical scoring thresholds outside policy",
);

const results = golden.cases.map((item) => {
  const result = groundManualAnswer(item.summary, item.evidence, item.question);
  assert.equal(result.audit.status, item.expectedStatus, item.id);
  assert.equal(result.audit.policy.id, golden.policy.id, item.id);
  assert.equal(result.audit.policy.version, golden.policy.version, item.id);
  if (item.expectedRetained !== undefined) assert.equal(result.audit.retainedClaims.length, item.expectedRetained, item.id);
  if (item.expectedUnsupported !== undefined) assert.equal(result.audit.unsupportedClaims.length, item.expectedUnsupported, item.id);
  if (item.expectedReason) assert.ok(result.audit.claimAudits[0].validation.reasons.includes(item.expectedReason), `${item.id}: ${result.audit.claimAudits[0].validation.reasons.join(",")}`);
  if (item.expectedEvidenceIds) assert.deepEqual(result.audit.evidenceIds, item.expectedEvidenceIds, item.id);
  if (item.expectedAnswerIncludes) assert.match(result.answer, new RegExp(item.expectedAnswerIncludes), item.id);
  if (item.expectedFallbackMode) assert.equal(result.audit.fallback?.mode, item.expectedFallbackMode, item.id);
  assert.equal(result.audit.answerClaimsPolicy.id, MANUAL_CLAIM_GROUNDING_POLICY.answerClaims.id, item.id);
  assert.equal(result.audit.answerClaimsPolicy.version, MANUAL_CLAIM_GROUNDING_POLICY.answerClaims.version, item.id);
  assert.equal(result.audit.answerClaims.length, result.audit.status === "fallback" ? result.audit.fallback?.selected?.length || 0 : result.audit.retainedClaims.length, item.id);
  for (const claim of result.audit.answerClaims) {
    assert.match(claim.claimId, /^(claim|fallback)-\d+$/, item.id);
    assert.equal(claim.provenance, MANUAL_CLAIM_GROUNDING_POLICY.answerClaims.provenance, item.id);
    assert.ok(claim.text.length > 0, item.id);
    assert.ok(["supported", "evidence-extract"].includes(claim.status), item.id);
    assert.ok(claim.evidence?.chunkId, item.id);
    assert.ok(claim.evidence?.sentence, item.id);
  }
  assert.deepEqual(result.citedEvidence.map((entry) => entry.chunkId), result.audit.evidenceIds, `${item.id}: citations must bind to actual support/fallback`);
  assert.ok(result.answer.length <= MANUAL_CLAIM_GROUNDING_POLICY.speech.targetChars || result.audit.status !== "fallback", `${item.id}: fallback speech boundary`);
  return { id: item.id, status: result.audit.status, evidenceIds: result.audit.evidenceIds };
});

const customFallback = groundManualAnswer(
  "香氛可以在高速行驶时自动更换。",
  [
    { chunkId: "fragrance-1", citation: "p.10", excerpt: "香氛盒更换前，请先关闭香氛系统。" },
    { chunkId: "fragrance-2", citation: "p.11", excerpt: "香氛盒位于前排中央区域。" },
    { chunkId: "fragrance-3", citation: "p.12", excerpt: "更换香氛盒时，请按提示取出旧香氛盒。" },
    { chunkId: "fragrance-4", citation: "p.13", excerpt: "安装新香氛盒后，请确认香氛盒固定到位。" },
  ],
  "香氛盒怎么更换？",
  { maxFallbackClaims: 4, targetSpeechChars: 260 },
);
assert.equal(customFallback.audit.status, "fallback");
assert.equal(customFallback.audit.fallback?.maxClaims, 4);
assert.equal(customFallback.audit.fallback?.targetChars, 260);
assert.deepEqual([...customFallback.audit.evidenceIds].sort(), ["fragrance-1", "fragrance-2", "fragrance-3", "fragrance-4"]);
assert.equal(customFallback.audit.fallback?.selected.length, 4);
assert.equal(customFallback.audit.answerClaims.length, 4);
assert.ok(customFallback.audit.answerClaims.every((item) => item.status === MANUAL_CLAIM_GROUNDING_POLICY.answerClaims.evidenceExtractStatus));

console.log(JSON.stringify({ policy: golden.policy, passed: results.length, results }, null, 2));
