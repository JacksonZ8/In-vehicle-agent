export const MANUAL_ANSWER_COMPOSER_POLICY = Object.freeze({
  id: "nio-manual-answer-composer",
  version: "1.0.0",
  provenance: "manual-answer-claims",
  supportedPrefix: "根据已接入手册，",
  fallbackPrefix: "我不能确认原回答中的说法。已接入手册里与这个问题相关的内容是：",
});

export function composeManualAnswer(manualGrounding = {}, options = {}) {
  const policy = options.policy || MANUAL_ANSWER_COMPOSER_POLICY;
  const claims = Array.isArray(manualGrounding.answerClaims) ? manualGrounding.answerClaims : [];
  const status = manualGrounding.status || "unknown";
  if (!claims.length) {
    return {
      text: String(manualGrounding.answer || "").trim(),
      policy: { ...policy },
      status,
      provenance: policy.provenance,
      claimCount: 0,
    };
  }
  const texts = uniqueClaimTexts(claims);
  const prefix = claims.every((item) => item.status === "supported")
    ? policy.supportedPrefix
    : policy.fallbackPrefix;
  return {
    text: `${prefix}${texts.join("")}`,
    policy: { ...policy },
    status,
    provenance: policy.provenance,
    claimCount: claims.length,
  };
}

function uniqueClaimTexts(claims) {
  const seen = new Set();
  const result = [];
  for (const claim of claims) {
    const text = String(claim?.text || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(ensureTerminalPunctuation(text));
  }
  return result;
}

function ensureTerminalPunctuation(text) {
  return /[。！？!?；;]$/u.test(text) ? text : `${text}。`;
}
