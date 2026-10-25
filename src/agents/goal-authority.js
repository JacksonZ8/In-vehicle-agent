import { extractRequestedManualModels } from "../manual/manual-corpus-registry.js";

const KNOWLEDGE_SEMANTIC_DOMAINS = Object.freeze(["vehicle_knowledge", "manual_knowledge"]);
const VEHICLE_SLU_KNOWLEDGE_SOURCE = "vehicle-slu-knowledge-frame";
const TAILGATE_ELIGIBILITY_ACTION = "body.tailgate.open";

export function resolveTrustedKnowledgeDelegationAuthority(goal) {
  if (!isTrustedKnowledgeGoal(goal)) return null;
  const requestedModels = extractRequestedManualModels(goal.objective);
  if (requestedModels.some((model) => model !== "ES8")) return null;
  const currentEligibility = goal.contextRefs[0].eligibilityAction === TAILGATE_ELIGIBILITY_ACTION;
  return Object.freeze({
    knowledgeGoal: goal.objective,
    vehicleScope: "nio-es8-user-manual-2026",
    allowVehicleStateRead: currentEligibility,
    requireSafetyEligibilityExplanation: currentEligibility,
    expectedAnswerContract: "KnowledgeAnswer",
  });
}

export function resolveVehicleSluKnowledgeGoalAuthority(frame) {
  if (!frame || frame.capability !== "knowledge" || frame.intent !== "vehicle.knowledge.query"
    || frame.speechAct !== "question" || frame.knowledgeNeed !== "manual" || frame.actionNeed !== "none"
    || !Array.isArray(frame.missingSlots) || frame.missingSlots.length !== 0
    || typeof frame.slots?.query !== "string" || !frame.slots.query.trim()
    || typeof frame.standaloneQuery !== "string"
    || frame.standaloneQuery.trim() !== frame.slots.query.trim()
    || (frame.slots.vehicleModel && frame.slots.vehicleModel !== "ES8")) {
    return null;
  }
  const interactionType = "question";
  const eligibilityAction = frame.slots.eligibilityAction === TAILGATE_ELIGIBILITY_ACTION
    ? TAILGATE_ELIGIBILITY_ACTION
    : null;
  const contextRef = Object.freeze({
    type: "trusted-conversation-goal",
    source: VEHICLE_SLU_KNOWLEDGE_SOURCE,
    interactionType,
    semanticDomain: "vehicle_knowledge",
    goalDomain: "manual",
    eligibilityAction,
  });
  return Object.freeze({
    objective: frame.slots.query.trim(),
    interactionType,
    domain: "manual",
    eligibilityAction,
    contextRef,
  });
}

// Knowledge authority comes only from a Vehicle-SLU knowledge frame. A goal formed from
// raw text must not claim it, so any trusted-conversation-goal ref is rejected here.
export function goalClaimsNoKnowledgeAuthority(goal) {
  return !Array.isArray(goal?.contextRefs)
    || goal.contextRefs.every((ref) => ref?.type !== "trusted-conversation-goal");
}

export function isTrustedKnowledgeGoal(goal) {
  if (goal?.interactionType === "command" || goal?.domain !== "manual"
    || !Array.isArray(goal?.contextRefs) || goal.contextRefs.length !== 1) {
    return false;
  }
  const ref = goal.contextRefs[0];
  return ref?.type === "trusted-conversation-goal"
    && ref?.source === VEHICLE_SLU_KNOWLEDGE_SOURCE
    && ref?.interactionType === goal.interactionType
    && KNOWLEDGE_SEMANTIC_DOMAINS.includes(ref?.semanticDomain)
    && ref?.goalDomain === "manual"
    && [null, TAILGATE_ELIGIBILITY_ACTION].includes(ref?.eligibilityAction)
    && Object.keys(ref).length === 6;
}
