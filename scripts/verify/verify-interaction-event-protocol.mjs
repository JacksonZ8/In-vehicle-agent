import assert from "node:assert/strict";
import {
  createInteractionEvent,
  validateInteractionEvent,
} from "../../src/interaction/interaction-event-protocol.js";
import { getParticipant } from "../../src/runtime/participant-registry.js";
import {
  createInteractionRef,
  createRunEvent,
  validateRunEvent,
} from "../../src/runtime/run-event-protocol.js";

assert.equal(getParticipant("wakeWordProvider").type, "deterministic-service");
assert.equal(getParticipant("interactionSession").type, "deterministic-service");
assert.equal(getParticipant("recoveryPolicy").type, "deterministic-service");

const awakened = createInteractionEvent({
  interactionEventId: "interaction:event:1",
  sessionId: "session:1",
  turnId: null,
  runId: null,
  sequence: 1,
  timestamp: "2026-07-30T00:00:00.000Z",
  participantId: "wakeWordProvider",
  phase: "session-awakened",
  status: "done",
  relatedRunEventIds: [],
  simulated: true,
  data: { provider: "browser-transcript-gate" },
});
assert.deepEqual(validateInteractionEvent(awakened), []);
assert.throws(() => createInteractionEvent({ ...awakened, phase: "unknown" }), /phase/);
assert.throws(() => createInteractionEvent({ ...awakened, turnId: "turn:1", runId: "" }), /runId/);
assert.throws(() => createInteractionEvent({
  ...awakened,
  phase: "turn-submitted",
}), /turnId and runId/);
assert.ok(Object.isFrozen(awakened.data));
assert.ok(Object.isFrozen(awakened.relatedRunEventIds));

const wakeOnlyClosed = createInteractionEvent({
  ...awakened,
  interactionEventId: "interaction:event:wake-only-close",
  sequence: 2,
  participantId: "interactionSession",
  phase: "session-closed",
  status: "done",
});
assert.equal(wakeOnlyClosed.turnId, null);
assert.equal(wakeOnlyClosed.runId, null);
assert.deepEqual(validateInteractionEvent(wakeOnlyClosed), []);

const failed = createInteractionEvent({
  ...awakened,
  interactionEventId: "interaction:event:2",
  turnId: "turn:1",
  runId: "run:1",
  participantId: "recoveryPolicy",
  phase: "turn-failed",
  reasonCode: " capability-unavailable ",
});
assert.equal(failed.reasonCode, "capability-unavailable");
assert.deepEqual(validateInteractionEvent(failed), []);
assert.throws(
  () => createInteractionEvent({ ...failed, reasonCode: 42 }),
  /reasonCode must be a string or null/,
);

const interactionRef = createInteractionRef({ sessionId: " session:1 ", turnId: " turn:1 " });
assert.deepEqual(interactionRef, { sessionId: "session:1", turnId: "turn:1" });
assert.ok(Object.isFrozen(interactionRef));
assert.throws(() => createInteractionRef({ sessionId: "session:1", turnId: "" }), /requires sessionId and turnId/);

const runEvent = createRunEvent({
  eventId: "run:event:1",
  runId: "run:1",
  parentEventId: null,
  sequence: 1,
  timestamp: "2026-07-30T00:00:00.000Z",
  component: "voiceBridgeEligibility",
  phase: "voice-bridge-eligibility",
  status: "completed",
  summary: "本轮不启用等待语音桥。",
  refs: [],
  metadata: {
    interactionRef,
    voiceBridgeEligibility: {
      allowed: false,
      noToolOrSafetyPath: true,
      requestId: "run:1",
      reason: "text-only",
      policyId: "voice-bridge",
      policyVersion: "1",
    },
  },
});
assert.deepEqual(validateRunEvent(runEvent), []);
assert.match(
  validateRunEvent({ ...runEvent, metadata: { ...runEvent.metadata, interactionRef: { sessionId: "session:1", turnId: "" } } }).join("; "),
  /interactionRef requires sessionId and turnId/,
);

console.log("interaction event protocol verification passed");
