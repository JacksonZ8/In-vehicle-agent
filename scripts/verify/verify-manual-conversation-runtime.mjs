import assert from "node:assert/strict";
import {
  groundManualAnswer,
  MANUAL_CLAIM_GROUNDING_POLICY,
} from "../../src/manual/manual-claim-grounding.js";
import { MANUAL_SPEECH_POLICY } from "../../src/manual/manual-speech-policy.js";
import { createLeanRuntimeVehicleKnowledgeHarness } from "../lib/lean-runtime-test-harness.mjs";

const manualText = "ES8 打开尾门前需要确认什么条件？";
const groundedCandidateClaim = "开启尾门前请确认  后方空间。";
const TRUSTED_MANUAL = Object.freeze({
  sourceId: "nio-es8-user-manual-2026",
  title: "蔚来 ES8 用户手册",
});

const hit = await runKnowledgeCase({
  id: "grounded",
  chunks: [manualChunk({
    chunkId: "manual-1",
    citation: "第 88 页 · 尾门开启",
    text: "开启尾门前请确认后方空间。",
  })],
  summary: `${groundedCandidateClaim}\n\n手册依据：模型伪造引用`,
});
assert.equal(hit.result.toolCall, null);
assert.equal(hit.result.toolResult, null);
assert.equal(hit.result.safetyDecision, null);
assert.equal(hit.result.manualEvidence.status, "hit");
assert.equal(hit.result.manualQueryPlan.source, "vehicle-slu-frame");
assert.equal(hit.retrieval.query, hit.result.manualQueryPlan.query);
assert.deepEqual(hit.retrieval.options, {
  corpusId: "nio-es8-user-manual-2026",
  vehicleModel: "ES8",
});
assert.ok(
  hit.grounding,
  "the production static vehicle-knowledge path must attach its Manual grounding audit",
);
assert.equal(hit.grounding.status, "grounded");
assert.equal(hit.grounding.fallbackApplied, false);
assert.deepEqual(hit.grounding.evidenceIds, ["manual-1"]);
assert.deepEqual(hit.grounding.retainedClaims, [groundedCandidateClaim]);
assert.equal(hit.grounding.answerClaimsPolicy.id, "nio-manual-answer-claims");
assert.deepEqual(hit.grounding.answerClaims.map((item) => item.text), [groundedCandidateClaim]);
assert.equal(hit.grounding.answerClaims[0].status, "supported");
assert.equal(hit.grounding.answerClaims[0].evidence.chunkId, "manual-1");
assert.equal(hit.grounding.answerChars, groundedCandidateClaim.length);
assert.equal(hit.result.assistantResponse, "根据已接入手册，开启尾门前请确认 后方空间。");
assert.doesNotMatch(hit.result.assistantResponse, /\n| {2,}|手册依据|模型伪造引用/);
assert.equal(hit.result.runtimeTelemetry.modelCallCount, 1);
assert.equal(hit.synthesisInput.executionFacts.evidence[0].citation, "第 88 页 · 尾门开启");

const partial = await runKnowledgeCase({
  id: "partial",
  chunks: [manualChunk({
    chunkId: "manual-partial",
    citation: "第 88 页 · 尾门开启",
    text: "开启尾门前请确认后方空间。",
  })],
  summary: "开启尾门前请确认后方空间。尾门可以在高速行驶时打开。",
});
assert.equal(partial.grounding.status, "partial");
assert.equal(partial.grounding.fallbackApplied, false);
assert.deepEqual(partial.grounding.retainedClaims, ["开启尾门前请确认后方空间。"]);
assert.equal(partial.grounding.claimAudits[1].status, "unsupported");
assert.match(partial.grounding.claimAudits[1].validation.reasons.join(","), /condition-or-temporal-mismatch/);
assert.match(partial.result.assistantResponse, /确认后方空间/);
assert.doesNotMatch(partial.result.assistantResponse, /高速行驶/);
assert.deepEqual(partial.grounding.evidenceIds, ["manual-partial"]);

const fallback = await runKnowledgeCase({
  id: "fallback",
  chunks: [manualChunk({
    chunkId: "manual-unsupported",
    citation: "第 88 页 · 尾门开启",
    text: "开启尾门前请确认后方空间。",
  })],
  summary: "尾门可以在车辆高速行驶时打开。",
});
assert.equal(fallback.grounding.status, "fallback");
assert.equal(fallback.grounding.fallbackApplied, true);
assert.match(fallback.grounding.unsupportedClaims[0], /高速行驶/);
assert.deepEqual(fallback.grounding.retainedClaims, []);
assert.equal(fallback.grounding.answerClaims[0].status, "evidence-extract");
assert.equal(fallback.grounding.answerClaims[0].evidence.chunkId, "manual-unsupported");
assert.ok(fallback.grounding.answerChars <= 180);
assert.doesNotMatch(fallback.result.assistantResponse, /高速行驶时打开/);
assert.match(fallback.result.assistantResponse, /开启尾门前请确认后方空间/);
assert.match(
  fallback.result.assistantResponse,
  /我不能确认原回答中的说法。已接入手册里与这个问题相关的内容是：/,
);
assert.doesNotMatch(fallback.result.assistantResponse, /高速行驶/);

const noEvidence = await runKnowledgeCase({
  id: "no-evidence",
  chunks: [],
  summary: "不得在无证据时保留这条模型说法。",
});
assert.equal(noEvidence.result.manualEvidence.status, "miss");
assert.deepEqual(noEvidence.result.manualEvidence.evidenceRefs, []);
assert.equal(noEvidence.grounding.status, "no-evidence");
assert.equal(noEvidence.grounding.fallbackApplied, true);
assert.deepEqual(noEvidence.grounding.claimAudits.map((item) => item.status), ["unsupported"]);
assert.deepEqual(noEvidence.grounding.answerClaims, []);
assert.equal(noEvidence.result.assistantResponse, MANUAL_SPEECH_POLICY.noEvidenceText);
assert.equal(noEvidence.result.runtimeTelemetry.modelCallCount, 1);
assert.equal(MANUAL_CLAIM_GROUNDING_POLICY.id, "nio-manual-claim-grounding");
assert.equal(MANUAL_CLAIM_GROUNDING_POLICY.version, "1.4.0");

const citations = await runKnowledgeCase({
  id: "citation-binding",
  chunks: [
    manualChunk({
      chunkId: "citation-support",
      citation: "第 88 页 · 尾门开启",
      text: "开启尾门前请确认后方空间。",
    }),
    manualChunk({
      chunkId: "citation-unused",
      citation: "第 89 页 · 尾门高度",
      text: "尾门开启高度可以设置。",
    }),
  ],
  summary: "开启尾门前请确认后方空间。",
});
assert.deepEqual(citations.grounding.evidenceIds, ["citation-support"]);
assert.deepEqual(
  citations.grounding.answerClaims.map((claim) => claim.evidence.chunkId),
  ["citation-support"],
);
assert.equal(citations.result.manualEvidence.evidenceRefs.length, 2, "retrieval audit keeps both source chunks");
assert.equal(
  citations.synthesisInput.executionFacts.evidenceRefs.some((item) => item.chunkId === "citation-unused"),
  true,
  "grounding must bind citations from the real lean execution facts rather than hiding unused retrievals",
);

const currentEligibility = await runKnowledgeCase({
  id: "current-eligibility-safety-authority",
  rawText: "我的 ES8 现在能打开尾门吗？",
  chunks: [manualChunk({
    chunkId: "current-manual",
    citation: "第 88 页 · 尾门开启",
    text: "开启尾门前请确认后方空间。",
  })],
  summary: "只看手册就能断言当前一定可以打开尾门。",
});
assert.match(currentEligibility.result.assistantResponse, /Safety 评估.*当前满足开启条件/);
assert.doesNotMatch(currentEligibility.result.assistantResponse, /只看手册|一定可以/);
assert.equal(Object.hasOwn(currentEligibility.result.manualEvidence, "grounding"), false);
assert.deepEqual(
  currentEligibility.result.safetyDecision,
  currentEligibility.synthesisInput.executionFacts.safetyAssessmentRef,
);
assert.equal(currentEligibility.synthesisInput.executionFacts.vehicleStateRefs.length, 1);

const operationGrounding = groundManualAnswer(
  "打开尾门。",
  [manualChunk({ chunkId: "operation-evidence", citation: "第 88 页", text: "开启尾门前请确认后方空间。" })],
  "打开尾门",
);
assert.notEqual(operationGrounding.audit.status, "grounded", "a vehicle operation must not be reclassified as a grounded explanation");

console.log("manual conversation lean runtime verification passed");

async function runKnowledgeCase({ id, chunks, summary, rawText = manualText }) {
  let retrieval = null;
  let synthesisInput = null;
  const harness = createLeanRuntimeVehicleKnowledgeHarness({
    manualRetriever(query, options) {
      retrieval = { query, options };
      return chunks;
    },
    modelBehavior: {
      synthesize(input) {
        synthesisInput = input;
        const candidateOutput = {
          delegationId: input.delegation.delegationId,
          runId: input.delegation.runId,
          outcomeStatus: "answered",
          supportStatus: input.executionFacts.evidenceRefs.length ? "supported" : "unsupported",
          answer: summary,
          evidenceRefs: input.executionFacts.evidenceRefs,
          vehicleStateRefs: input.executionFacts.vehicleStateRefs,
          safetyAssessmentRef: input.executionFacts.safetyAssessmentRef,
          limitations: [],
          model: "untrusted-candidate-fixture",
          provider: "local-test",
          durationMs: 1,
          degraded: input.executionFacts.evidenceRefs.length === 0,
        };
        return {
          output: candidateOutput,
          telemetry: {
            model: "untrusted-candidate-fixture",
            provider: "local-test",
            durationMs: 1,
            degraded: input.executionFacts.evidenceRefs.length === 0,
          },
        };
      },
    },
  });
  const result = await harness.runtime.run(rawText, {
    requestId: `manual-conversation:${id}`,
  });
  return {
    result,
    retrieval,
    grounding: result.manualEvidence?.grounding ?? null,
    synthesisInput,
  };
}

function manualChunk({ chunkId, citation, text }) {
  return {
    ...TRUSTED_MANUAL,
    sourceVersion: "2026",
    chunkId,
    citation,
    pageStart: 88,
    pageEnd: 88,
    excerpt: text,
    text,
    score: { retrieval: 0.8, rerank: null, grounding: null },
  };
}
