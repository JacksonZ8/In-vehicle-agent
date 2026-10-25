const TRANSITION_ECHOES = new Set([
  "我",
  "我在",
  "NOMI",
  "诺米",
  "嗨NOMI",
  "嗨诺米",
]);

function normalizedPhrase(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\p{White_Space}\p{Punctuation}]+/gu, "")
    .toUpperCase();
}

export function classifyLocalWakeTranscript(value) {
  const text = String(value || "").trim();
  if (!text) return Object.freeze({ kind: "empty", text: "" });
  return Object.freeze({
    kind: TRANSITION_ECHOES.has(normalizedPhrase(text)) ? "transition-echo" : "command",
    text,
  });
}
