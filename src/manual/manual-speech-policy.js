export const MANUAL_SPEECH_POLICY = Object.freeze({
  id: "nio-manual-speech-text",
  version: "1.1.0",
  provenance: "manual-runtime-speech-text",
  appendixPattern: "\\n+\\s*手册依据：[\\s\\S]*$",
  whitespacePattern: "\\s+",
  terminalPattern: "[。！？!?；;]$",
  noEvidenceText: "我没在已接入手册里找到可靠依据，不能编造操作步骤。",
});

export function buildManualSpeechText(answer, audit = {}, options = {}) {
  const policy = options.policy || MANUAL_SPEECH_POLICY;
  const normalized = normalizeManualSpeechSource(answer, policy);
  if (!normalized) return "";
  if (audit?.status === "no-evidence") return policy.noEvidenceText;
  return ensureTerminalPunctuation(normalized, policy);
}

function normalizeManualSpeechSource(answer, policy) {
  return String(answer || "")
    .replace(new RegExp(policy.appendixPattern, "u"), "")
    .replace(new RegExp(policy.whitespacePattern, "gu"), " ")
    .trim();
}

function ensureTerminalPunctuation(text, policy) {
  const value = String(text || "").trim();
  if (!value) return "";
  return new RegExp(policy.terminalPattern, "u").test(value) ? value : `${value}。`;
}
