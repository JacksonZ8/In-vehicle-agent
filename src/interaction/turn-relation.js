const EXPLICIT_CANCEL_UTTERANCES = new Set(["算了", "取消", "停止", "停一下", "别做了"]);
const EXPLICIT_CLOSE_UTTERANCES = new Set(["不用了", "关闭", "结束对话", "退出"]);

export function classifyExplicitTurnGate(rawText) {
  const utterance = normalizeGateUtterance(rawText);
  let decision = "none";
  if (EXPLICIT_CANCEL_UTTERANCES.has(utterance)) decision = "explicit-cancel";
  else if (EXPLICIT_CLOSE_UTTERANCES.has(utterance)) decision = "explicit-close";
  return Object.freeze({ decision });
}

function normalizeGateUtterance(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[\p{White_Space}\p{Punctuation}]+$/gu, "")
    .trim();
}
