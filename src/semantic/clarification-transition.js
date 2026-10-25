import {
  getMissingVehicleSluRequiredSlots,
  VEHICLE_SLU_SLOT_SCHEMAS,
} from "./vehicle-slu-contract.js";
import { CLARIFY_QUESTION_TEMPLATES } from "./vehicle-slu-prompt.js";

export function resolveClarificationTransition({ pending, envelope }) {
  const actionFrame = firstActionFrame(envelope);
  const base = { nextPending: null, resolvedFrame: null };

  if (envelope.conversationGoal?.dialogueAction === "cancel_pending") {
    return { action: "cancel", ...base, reasonCode: "model-cancelled-pending" };
  }

  if (!pending) {
    if (actionFrame?.actionNeed === "clarify") {
      return {
        action: "open",
        nextPending: pendingCandidate(actionFrame),
        resolvedFrame: null,
        reasonCode: "clarification-opened",
      };
    }
    return { action: "none", ...base, reasonCode: "no-pending-clarification" };
  }

  if (envelope.domain === "non_vehicle") {
    return { action: "preserve", ...base, reasonCode: "non-vehicle-domain" };
  }
  if (envelope.domain === "unknown") {
    return { action: "preserve", ...base, reasonCode: "unknown-domain" };
  }
  if (!actionFrame) {
    return { action: "preserve", ...base, reasonCode: "no-action-frame" };
  }

  if (actionFrame.intent !== pending.intent) {
    return replacePending(actionFrame);
  }

  const slotNames = Object.keys(actionFrame.slots);
  const allowedSlots = new Set(VEHICLE_SLU_SLOT_SCHEMAS[actionFrame.intent]?.allowed || []);
  if (slotNames.some((slot) => !allowedSlots.has(slot))) {
    return { action: "reject", ...base, reasonCode: "undeclared-slot" };
  }

  const acceptedSlots = { ...pending.acceptedSlots, ...actionFrame.slots };
  const missingSlots = getMissingVehicleSluRequiredSlots(actionFrame.intent, acceptedSlots);
  if (missingSlots.length) {
    return {
      action: "merge",
      nextPending: {
        ...pending,
        acceptedSlots,
        missingSlots,
        clarificationQuestion: projectPendingClarificationQuestion({
          ...pending, acceptedSlots, missingSlots,
        }),
      },
      resolvedFrame: null,
      reasonCode: "clarification-merged",
    };
  }

  return {
    action: "resolve",
    nextPending: null,
    resolvedFrame: resolvedFrame(actionFrame, acceptedSlots),
    reasonCode: "clarification-resolved",
  };
}

// Presentation only: the accepted structured slots remain the semantic authority.
export function projectPendingClarificationQuestion(pending) {
  const missingSlots = getMissingVehicleSluRequiredSlots(pending.intent, pending.acceptedSlots);
  return CLARIFY_QUESTION_TEMPLATES[
    `${pending.intent}|${[...missingSlots].sort().join(",")}`
  ] || pending.clarificationQuestion;
}

function firstActionFrame(envelope) {
  return envelope.vehicleFrames.find((frame) => frame.actionNeed === "clarify" || frame.actionNeed === "execute") ?? null;
}

function pendingCandidate(frame) {
  return {
    frameId: frame.frameId,
    intent: frame.intent,
    acceptedSlots: { ...frame.slots },
    missingSlots: [...frame.missingSlots],
    clarificationQuestion: frame.clarificationQuestion,
  };
}

function replacePending(frame) {
  if (frame.actionNeed === "clarify") {
    return {
      action: "replace",
      nextPending: pendingCandidate(frame),
      resolvedFrame: null,
      reasonCode: "conflicting-intent-replaced",
    };
  }
  return {
    action: "replace",
    nextPending: null,
    resolvedFrame: resolvedFrame(frame, frame.slots),
    reasonCode: "conflicting-intent-resolved",
  };
}

function resolvedFrame(frame, slots) {
  return {
    ...frame,
    actionNeed: "execute",
    slots: { ...slots },
    missingSlots: [],
    clarificationQuestion: null,
  };
}
