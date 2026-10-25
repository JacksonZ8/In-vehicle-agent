import assert from "node:assert/strict";
import { composeManualAnswer, MANUAL_ANSWER_COMPOSER_POLICY } from "../../src/manual/manual-answer-composer.js";

assert.equal(`${MANUAL_ANSWER_COMPOSER_POLICY.id}@${MANUAL_ANSWER_COMPOSER_POLICY.version}`, "nio-manual-answer-composer@1.0.0");
assert.equal(MANUAL_ANSWER_COMPOSER_POLICY.provenance, "manual-answer-claims");

const supported = composeManualAnswer({
  status: "grounded",
  answerClaims: [
    {
      claimId: "claim-1",
      text: "开启尾门前请确认后方空间。",
      status: "supported",
      provenance: "manual-claim-grounding",
      evidence: { chunkId: "manual-1", citation: "p.88", sentence: "开启尾门前请确认后方空间。" },
    },
  ],
});
assert.equal(supported.text, "根据已接入手册，开启尾门前请确认后方空间。");
assert.equal(supported.policy.id, MANUAL_ANSWER_COMPOSER_POLICY.id);
assert.equal(supported.claimCount, 1);

const fallback = composeManualAnswer({
  status: "fallback",
  answerClaims: [
    {
      claimId: "fallback-1",
      text: "胎压报警后请减速并在安全地点检查轮胎。",
      status: "evidence-extract",
      provenance: "manual-claim-grounding",
      evidence: { chunkId: "tire-1", citation: "p.210", sentence: "胎压报警后请减速并在安全地点检查轮胎。" },
    },
  ],
});
assert.equal(fallback.text, "我不能确认原回答中的说法。已接入手册里与这个问题相关的内容是：胎压报警后请减速并在安全地点检查轮胎。");
assert.equal(fallback.provenance, MANUAL_ANSWER_COMPOSER_POLICY.provenance);

const noEvidence = composeManualAnswer({ status: "no-evidence", answer: "不能编造操作步骤。", answerClaims: [] });
assert.equal(noEvidence.text, "不能编造操作步骤。");
assert.equal(noEvidence.claimCount, 0);

console.log(JSON.stringify({ ok: true, policy: MANUAL_ANSWER_COMPOSER_POLICY }, null, 2));
