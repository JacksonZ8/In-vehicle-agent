export const INTERACTION_SESSION_POLICY = deepFreeze({
  id: "nio-interaction-session-policy",
  version: "1.0.0",
  followUpWindowMs: 5_000,
  maxQueuedReplacementTurns: 1,
  cancellationReasons: [
    "user-cancelled",
    "barge-in-replaced",
    "session-closed",
    "turn-deadline-exceeded",
    "superseded-before-start",
  ],
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
