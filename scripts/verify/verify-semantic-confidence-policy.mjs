import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseCommandWithSemanticPolicy } from "../lib/semantic-policy.js";
import { SEMANTIC_CONFIDENCE_POLICY } from "../../src/runtime/agent-schemas.js";

const source = await readFile(new URL("../lib/semantic-policy.js", import.meta.url), "utf8");

assert.match(source, /SEMANTIC_CONFIDENCE_POLICY/, "semantic-policy must import and use SEMANTIC_CONFIDENCE_POLICY");
assert.match(source, /matchStrength/, "semantic-policy must expose matchStrength as the preferred non-probability signal");
assert.doesNotMatch(source, /confidence:\s*0\.\d+/, "semantic-policy must not assign bare decimal confidence literals");
assert.equal(SEMANTIC_CONFIDENCE_POLICY.version, "nio-semantic-confidence@1.1.0");
assert.equal(SEMANTIC_CONFIDENCE_POLICY.preferredOutput, "matchStrength");
assert.equal(SEMANTIC_CONFIDENCE_POLICY.compatibilityField, "confidence");
assert.deepEqual(SEMANTIC_CONFIDENCE_POLICY.matchStrengthPolicy, {
  id: "nio-semantic-match-strength",
  version: "1.0.0",
  levels: ["none", "possible", "weak", "medium", "strong"],
  calibration: "local-dev-rule-derived-not-statistical",
}, "semantic matchStrength policy must stay explicit and non-statistical");

const windowCommand = parseCommandWithSemanticPolicy("把主驾车窗打开一半");
assert.equal(windowCommand.confidence, SEMANTIC_CONFIDENCE_POLICY.values.windowCommand);
assert.equal(windowCommand.semanticPolicy.confidencePolicy.version, SEMANTIC_CONFIDENCE_POLICY.version);
assert.equal(windowCommand.semanticPolicy.confidencePolicy.calibration, SEMANTIC_CONFIDENCE_POLICY.calibration.status);
assert.equal(windowCommand.semanticPolicy.matchStrength.policy.id, "nio-semantic-match-strength");
assert.equal(windowCommand.semanticPolicy.matchStrength.value, "strong");
assert.equal(windowCommand.semanticPolicy.matchStrength.numericConfidenceCompatibility, windowCommand.confidence);
assert.ok(windowCommand.semanticPolicy.matchStrength.provenance.includes("vehicle-intent"));
assert.ok(windowCommand.semanticPolicy.matchStrength.provenance.includes("intent:body.window.setPosition"));

const safetyReject = parseCommandWithSemanticPolicy("关闭全部安全提醒");
assert.equal(safetyReject.confidence, SEMANTIC_CONFIDENCE_POLICY.values.safetyReject);
assert.equal(safetyReject.semanticPolicy.matchStrength.value, "strong");
assert.ok(safetyReject.semanticPolicy.matchStrength.provenance.includes("intent:safety.reject"));
const rearSeatbeltReminder = parseCommandWithSemanticPolicy("关闭后排安全带提醒");
assert.equal(rearSeatbeltReminder.intent, "safety.reject",
  "rear-seat references must not be mistaken for rear-window targets without an explicit window mention");

const bareDegreeClarification = parseCommandWithSemanticPolicy("调到 23 度");
assert.equal(bareDegreeClarification.confidence, SEMANTIC_CONFIDENCE_POLICY.values.bareDegreeClarification);
assert.equal(bareDegreeClarification.semanticPolicy.matchStrength.value, "possible");
assert.ok(bareDegreeClarification.semanticPolicy.matchStrength.provenance.includes("clarification"));

const fallback = parseCommandWithSemanticPolicy("这句话没有明确意图");
assert.equal(fallback.confidence, SEMANTIC_CONFIDENCE_POLICY.values.fallbackConversation);
assert.equal(fallback.semanticPolicy.matchStrength.value, "weak");
assert.ok(fallback.semanticPolicy.matchStrength.provenance.includes("intent:conversation.general"));
assert.equal(fallback.semanticPolicy.matchStrength.numericConfidenceCompatibility, fallback.confidence);

console.log(JSON.stringify({
  status: "ok",
  confidencePolicy: SEMANTIC_CONFIDENCE_POLICY.version,
  calibration: SEMANTIC_CONFIDENCE_POLICY.calibration.status,
  preferredOutput: SEMANTIC_CONFIDENCE_POLICY.preferredOutput,
}, null, 2));
