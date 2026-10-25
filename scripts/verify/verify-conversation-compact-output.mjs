import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CloudLLMAdapter } from "../../src/runtime/cloud-llm-adapter.js";

const serverSource = await readFile(new URL("../../src/server/local-agent-server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /const llmConversationCompactOutputBudget = 24/);
assert.match(serverSource, /function resolveConversationCompactOutput/);
assert.match(serverSource, /!hasManualEvidence/);
assert.match(serverSource, /!hasExternalData/);
assert.match(serverSource, /!hasToolOrSafetyContext/);
assert.match(serverSource, /!route\?\.isVehicleKnowledge/);
assert.match(serverSource, /buildCompactConversationOutputPrompt/);
assert.match(serverSource, /generationProfile = compactConversationOutput\.enabled/);
assert.match(serverSource, /"compact-conversation"/);
assert.match(serverSource, /outputMode: "text"/);
assert.match(serverSource, /conversationOutputMode/);
assert.match(serverSource, /conversationOutputExclusionReason/);

const received = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  received.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ summary: "完整回答，不应由客户端截断。", telemetry: { provider: "fixture" } }), { status: 200 });
};
const endpoint = "http://local-fixture.invalid";
const command = {
  rawText: "讲个露营小建议",
  intent: "conversation.general",
  slots: { topic: "general_qa" },
};
try {
  await new CloudLLMAdapter({ endpoint }).converse(command.rawText, command, {});
  await new CloudLLMAdapter({ endpoint, conversationCompactOutput: false }).converse(command.rawText, command, {});
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(received.length, 2);
assert.equal(received[0].conversationCompactOutput, true, "eligible ordinary conversation must default to compact output");
assert.equal(received[1].conversationCompactOutput, false, "explicit false must retain the standard output budget");
assert.equal(received[1].task, "conversation_general");
assert.equal(received[1].parsedCommand.intent, "conversation.general");
assert.equal(received[1].manualEvidence.length, 0);
assert.match(serverSource, /不得编造实时数据、地点、网页事实、车辆状态或已执行动作/,
  "compact candidate must retain the essential anti-fabrication boundary");
assert.match(serverSource, /typeof body\?\.conversationCompactOutput === "boolean"/,
  "server must allow an explicit request-level compact disable");
assert.match(serverSource, /NIO_LLM_CONVERSATION_COMPACT_OUTPUT !== "false"/,
  "server default must enable compact output while retaining an environment kill switch");
console.log(JSON.stringify({ defaultMode: "compact", explicitDisableMode: "standard", outputBudget: 24, routeExclusions: ["manual", "external", "tool-or-safety", "vehicle-knowledge"] }, null, 2));
