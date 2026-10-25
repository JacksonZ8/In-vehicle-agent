import assert from "node:assert/strict";
import {
  resolveVoiceBridgeEligibility,
  VOICE_BRIDGE_AUTHORIZATION_POLICY,
} from "../../src/application/voice-bridge-policy.js";

const ordinary = { intent: "conversation.general", slots: {} };
const plan = { knowledgeNeed: "none", actionNeed: "none" };
const check = (label, input, allowed, reason) => {
  const result = resolveVoiceBridgeEligibility({ requestId: `bridge-${label}`, ...input });
  assert.equal(result.allowed, allowed, label);
  assert.equal(result.reason, reason, label);
  assert.equal(result.policyId, VOICE_BRIDGE_AUTHORIZATION_POLICY.id);
  assert.equal(result.noToolOrSafetyPath, allowed, label);
  assert.deepEqual(Object.keys(result).sort(), ["allowed", "noToolOrSafetyPath", "policyId", "policyVersion", "reason", "requestId"].sort(), "event data must remain narrow");
};

check("ordinary", { command: ordinary, manualQueryPlan: plan, conversationRoute: {} }, true, "ordinary-general-conversation");
check("manual", { command: ordinary, manualQueryPlan: { knowledgeNeed: "manual", actionNeed: "explain" }, conversationRoute: {}, manualQuestion: true }, false, "manual-knowledge-or-action");
check("weather", { command: { ...ordinary, externalDataType: "weather" }, manualQueryPlan: plan, conversationRoute: { requiresExternalData: true } }, false, "external-data-or-poi-route");
check("poi", { command: { ...ordinary, slots: { requiresPoi: true } }, manualQueryPlan: plan, conversationRoute: {} }, false, "external-data-or-poi-route");
check("tool", { command: { intent: "body.window.setPosition", slots: {} }, manualQueryPlan: plan, conversationRoute: {} }, false, "non-conversation-intent");
check("vehicle", { command: { intent: "body.tailgate.open", slots: {} }, manualQueryPlan: plan, conversationRoute: {} }, false, "non-conversation-intent");
check("safety", { command: { intent: "safety.reject", slots: {} }, manualQueryPlan: plan, conversationRoute: {} }, false, "non-conversation-intent");
check("clarification", { command: { ...ordinary, slots: { needsClarification: true } }, manualQueryPlan: plan, conversationRoute: {} }, false, "clarification-required");

console.log(JSON.stringify({ ok: true, policy: VOICE_BRIDGE_AUTHORIZATION_POLICY, matrix: ["ordinary", "manual", "weather", "poi", "tool", "vehicle", "safety", "clarification"] }, null, 2));
