const VOICE_FOLLOW_UP_TRIGGERS = new Set(["wake-word", "follow-up"]);

function findTurnTrigger(snapshot, turnId) {
  const events = snapshot?.currentSession?.events;
  if (!Array.isArray(events) || !turnId) return null;
  return events.findLast((event) => (
    event?.turnId === turnId
    && event.phase === "turn-submitted"
  ))?.data?.trigger ?? null;
}

export function shouldStartAutomaticVoiceFollowUp({
  snapshot,
  event,
  localVoiceEnabled,
  recognitionAvailable,
  pendingConfirmation,
} = {}) {
  if (snapshot?.state !== "follow-up-window"
    || event?.phase !== "follow-up-window-opened"
    || localVoiceEnabled !== true
    || recognitionAvailable !== true
    || pendingConfirmation === true) {
    return false;
  }
  return VOICE_FOLLOW_UP_TRIGGERS.has(findTurnTrigger(snapshot, event.turnId));
}

export function isCurrentVoiceFollowUpWindow(snapshot, {
  sessionId = snapshot?.sessionId,
  deadlineAt = snapshot?.followUpDeadlineAt,
  now = Date.now(),
} = {}) {
  return snapshot?.state === "follow-up-window"
    && snapshot.sessionId === sessionId
    && snapshot.followUpDeadlineAt === deadlineAt
    && Number.isFinite(deadlineAt)
    && now < deadlineAt;
}
