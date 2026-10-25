import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const productionFiles = [
  "src/semantic/local-model-adapter.js",
  "src/application/route-policy.js",
  "src/application/use-cases/complex-task.js",
  "src/application/runtime-kernel.js",
  "src/application/background-task-coordinator.js",
  "src/agents/goal-authority.js",
  "src/agents/orchestrator-controller.js",
  "src/semantic/vehicle-slu-orchestration.js",
  "src/server/local-agent-server.mjs",
  "src/runtime/cloud-llm-adapter.js",
  "src/semantic/semantic-parser.js",
  "scripts/benchmarks/evaluate-vehicle-slu-models.mjs",
];

const forbidden = [
  ["parseCommandWithSemanticPolicy", /\bparseCommandWithSemanticPolicy\b/],
  ["evaluateSemanticFastPath", /\bevaluateSemanticFastPath\b/],
  ["normalizeSemanticCandidateWithPolicy", /\bnormalizeSemanticCandidateWithPolicy\b/],
  ["classifyCompoundOrConflictingInput", /\bclassifyCompoundOrConflictingInput\b/],
  ["OBVIOUS_CHAT_PATTERN", /\bOBVIOUS_CHAT_PATTERN\b/],
  ["UNDERSPECIFIED_REQUEST_PATTERN", /\bUNDERSPECIFIED_REQUEST_PATTERN\b/],
  ["rules provider", /provider\s*:\s*["']rules["']/],
  ["semantic-policy production import", /(?:from\s+["'][^"']*semantic-policy\.js["']|import\s*\([^)]*semantic-policy\.js)/],
  ["SEMANTIC_POLICY", /\bSEMANTIC_POLICY\b/],
  ["semanticPolicy identifier", /\bsemanticPolicy\b/],
  ["omitSemanticPolicy identifier", /\bomitSemanticPolicy\b/],
  ["Vehicle-SLU 1.0 contract", /nio-vehicle-slu-contract@1\.0\.0/],
  ["Vehicle-SLU legacy enum", /\bVEHICLE_SLU_(?:SCOPE|MODE)S\b/],
  ["Vehicle-SLU semantic scope", /semanticEnvelope\?*\.scope/],
  ["Vehicle-SLU conversation reply flag", /conversationGoal\?*\.requiresReply/],
  ["Vehicle-SLU legacy confidence", new RegExp("\\bscope" + "Confidence\\b")],
  ["Vehicle-SLU frame mode", /resolveVehicleSluKnowledgeGoalAuthority\s*\([^)]*frame[^)]*\)\s*\{[\s\S]{0,600}\bframe\?*\.mode\b/],
];

const activeVehicleSluReadRules = [
  ["src/app/run-event-presenter.js", [
    ["Vehicle-SLU presenter envelope scope", /function projectVehicleSluEnvelopeDebug\s*\([^)]*\)\s*\{[\s\S]{0,2200}\bvalue\?*\.scope\b/],
    ["Vehicle-SLU presenter envelope reply flag", /function projectVehicleSluEnvelopeDebug\s*\([^)]*\)\s*\{[\s\S]{0,2200}\bconversationGoal\?*\.requiresReply\b/],
    ["Vehicle-SLU presenter envelope confidence", /function projectVehicleSluEnvelopeDebug\s*\([^)]*\)\s*\{[\s\S]{0,2200}\bscopeConfidence\b/],
    ["Vehicle-SLU presenter semantic scope", /function buildSemanticDecisionProjection\s*\([^)]*\)\s*\{[\s\S]{0,1800}\bsummary\?*\.scope\b/],
    ["Vehicle-SLU presenter semantic reply flag", /function buildSemanticDecisionProjection\s*\([^)]*\)\s*\{[\s\S]{0,1800}\brequiresReply\b/],
    ["Vehicle-SLU presenter semantic confidence", /function buildSemanticDecisionProjection\s*\([^)]*\)\s*\{[\s\S]{0,1800}\bscopeConfidence\b/],
    ["Vehicle-SLU presenter envelope frame mode", /function projectVehicleSluEnvelopeDebug\s*\([^)]*\)\s*\{[\s\S]{0,2200}\bframe\?*\.mode\b/],
    ["Vehicle-SLU presenter semantic frame mode", /function buildSemanticDecisionProjection\s*\([^)]*\)\s*\{[\s\S]{0,1800}\bframe\?*\.mode\b/],
  ]],
  ["src/server/local-agent-server.mjs", [
    ["Vehicle-SLU capability binding frame mode", /function projectVehicleSluCapabilityInput\s*\([^)]*\)\s*\{[\s\S]{0,500}\bframe\?*\.mode\b/],
  ]],
];

const patternsByLabel = new Map([
  ...forbidden,
  ...activeVehicleSluReadRules.flatMap(([, rules]) => rules),
]);
assert.equal(
  patternsByLabel.get("semanticPolicy identifier")?.test("const payload = { semanticPolicy };") ?? false,
  true,
  "static gate must reject shorthand semanticPolicy identifiers",
);
assert.equal(
  patternsByLabel.get("omitSemanticPolicy identifier")?.test("omitSemanticPolicy") ?? false,
  true,
  "static gate must reject omitSemanticPolicy compatibility identifiers",
);
assert.equal(
  patternsByLabel.get("Vehicle-SLU frame mode")?.test(
    "function resolveVehicleSluKnowledgeGoalAuthority(frame) { return frame.mode; }",
  ) ?? false,
  true,
  "static gate must reject the exact legacy Vehicle-SLU frame.mode read",
);
assert.equal(
  patternsByLabel.get("Vehicle-SLU frame mode")?.test(
    "function resolveRoute(routeDecision) { return routeDecision.mode; }",
  ) ?? true,
  false,
  "static gate must preserve unrelated runtime mode fields",
);
for (const [label, source] of [
  ["Vehicle-SLU presenter envelope scope", "function projectVehicleSluEnvelopeDebug(value) { return value.scope; }"],
  ["Vehicle-SLU presenter envelope reply flag", "function projectVehicleSluEnvelopeDebug(value) { return value.conversationGoal?.requiresReply; }"],
  ["Vehicle-SLU presenter envelope confidence", "function projectVehicleSluEnvelopeDebug(value) { return value.scopeConfidence; }"],
  ["Vehicle-SLU presenter semantic scope", "function buildSemanticDecisionProjection(events) { const summary = events[0]; return summary.scope; }"],
  ["Vehicle-SLU presenter semantic reply flag", "function buildSemanticDecisionProjection(events) { return events[0].requiresReply; }"],
  ["Vehicle-SLU presenter semantic confidence", "function buildSemanticDecisionProjection(events) { return events[0].scopeConfidence; }"],
  ["Vehicle-SLU presenter envelope frame mode", "function projectVehicleSluEnvelopeDebug(value) { return value.vehicleFrames.map((frame) => frame.mode); }"],
  ["Vehicle-SLU presenter semantic frame mode", "function buildSemanticDecisionProjection(events) { return events.map((frame) => frame.mode); }"],
  ["Vehicle-SLU capability binding frame mode", "function projectVehicleSluCapabilityInput(capabilityId, frame) { return frame.mode; }"],
]) {
  assert.equal(
    patternsByLabel.get(label)?.test(source) ?? false,
    true,
    `static gate must reject ${label}`,
  );
}
assert.equal(
  patternsByLabel.get("Vehicle-SLU capability binding frame mode")?.test(
    "function resolveRoute(routeDecision) { return routeDecision.mode; }",
  ) ?? true,
  false,
  "static gate must not reject unrelated downstream mode fields",
);

const violations = [];
for (const file of productionFiles) {
  const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) violations.push(`${file}: ${label}`);
  }
}
for (const [file, rules] of activeVehicleSluReadRules) {
  const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
  for (const [label, pattern] of rules) {
    if (pattern.test(source)) violations.push(`${file}: ${label}`);
  }
}

assert.deepEqual(
  violations,
  [],
  `production Vehicle-SLU authority must not depend on legacy semantic policy:\n${violations.join("\n")}`,
);

console.log("Vehicle-SLU no-legacy production authority verification passed");
