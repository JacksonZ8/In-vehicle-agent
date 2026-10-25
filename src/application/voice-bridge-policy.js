export const VOICE_BRIDGE_AUTHORIZATION_POLICY = Object.freeze({
  id: "nio-runtime-voice-bridge-authorization@1.0.0",
  version: "1.0.0",
  allowedUse: "conversation.general-without-manual-external-tool-or-safety-path",
});

// This decision is made before the LLM and is deliberately conservative. It
// is an HMI waiting-audio authorization only: it never authorizes a tool,
// Safety decision, data access, or vehicle operation.
export function resolveVoiceBridgeEligibility({
  requestId,
  command,
  manualQueryPlan,
  conversationRoute,
  manualQuestion = false,
} = {}) {
  const route = conversationRoute || {};
  const slots = command?.slots || {};
  const requiresExternalData = route.requiresExternalData === true
    || command?.requiresExternalData === true
    || slots.requiresExternalData === true
    || Boolean(command?.externalDataType || slots.externalDataType || slots.requiresPoi);
  const allowed = command?.intent === "conversation.general"
    && slots.needsClarification !== true
    && manualQuestion !== true
    && manualQueryPlan?.knowledgeNeed === "none"
    && manualQueryPlan?.actionNeed === "none"
    && requiresExternalData !== true;
  const reason = command?.intent !== "conversation.general" ? "non-conversation-intent"
    : slots.needsClarification === true ? "clarification-required"
      : manualQuestion || manualQueryPlan?.knowledgeNeed !== "none" || manualQueryPlan?.actionNeed !== "none" ? "manual-knowledge-or-action"
        : requiresExternalData ? "external-data-or-poi-route"
          : allowed ? "ordinary-general-conversation" : "unknown-or-exception";
  return {
    requestId: String(requestId || ""),
    allowed,
    reason,
    policyId: VOICE_BRIDGE_AUTHORIZATION_POLICY.id,
    policyVersion: VOICE_BRIDGE_AUTHORIZATION_POLICY.version,
    noToolOrSafetyPath: allowed,
  };
}
