#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = [
  "benchmarks/compare-local-llm-models.mjs",
  "benchmarks/profile-local-llm-latency.mjs",
  "evaluation/evaluate-llm-prompt-style-candidates.mjs",
];

for (const file of files) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const conversationCaseCount = [...source.matchAll(/intent:\s*"conversation\.general"/g)].length;
  const conversationGoalCount = [...source.matchAll(/conversationGoal:\s*\{/g)].length;
  assert.ok(conversationGoalCount >= conversationCaseCount, `${file}: every conversation.general fixture should include conversationGoal`);
}

const promptStyleSource = await readFile(new URL("../evaluation/evaluate-llm-prompt-style-candidates.mjs", import.meta.url), "utf8");
assert.match(promptStyleSource, /resolveConversationRoute/, "prompt-style candidate evaluator must consume ConversationRoute");
assert.doesNotMatch(
  promptStyleSource,
  /topic\s*===\s*["']vehicle_knowledge["']/,
  "prompt-style candidate evaluator must not branch vehicle knowledge prompt context on legacy slots.topic",
);
assert.doesNotMatch(
  promptStyleSource,
  /function\s+normalizeConversationTopic\b/,
  "prompt-style candidate evaluator must not keep a local topic normalizer; use agent-schemas ConversationRoute",
);

console.log(JSON.stringify({
  ok: true,
  files,
  policy: "conversation-goal-fixtures",
}, null, 2));
