import assert from "node:assert/strict";
import { RunEventLedger } from "../../src/runtime/run-event-ledger.js";
import { createRunEvent } from "../../src/runtime/run-event-protocol.js";

function event(sequence, overrides = {}) {
  return createRunEvent({
    eventId: `event:run-a:${sequence}`,
    runId: "run-a",
    parentEventId: sequence === 1 ? null : `event:run-a:${sequence - 1}`,
    sequence,
    timestamp: `2026-08-08T00:00:0${sequence}.000Z`,
    component: "runtimeKernel",
    phase: "intake",
    status: sequence === 3 ? "completed" : "processing",
    summary: `event ${sequence}`,
    refs: [],
    metadata: {},
    ...overrides,
  });
}

const mutableCanonicalEvent = structuredClone(event(1, {
  eventId: "event:mutable:1",
  runId: "run:mutable",
}));
const mutableLedger = new RunEventLedger();
mutableLedger.append(mutableCanonicalEvent);
mutableCanonicalEvent.summary = "mutated after append";
mutableCanonicalEvent.refs.push("ref:mutated");
mutableCanonicalEvent.metadata.degraded = true;
assert.equal(mutableLedger.getCurrentRun().events[0].summary, "event 1");
assert.deepEqual(mutableLedger.getCurrentRun().events[0].refs, []);
assert.deepEqual(mutableLedger.getCurrentRun().events[0].metadata, {});
assert.ok(Object.isFrozen(mutableLedger.getCurrentRun().events[0]));

const forgedLegacyLedger = new RunEventLedger();
assert.throws(() => forgedLegacyLedger.append({
  eventId: "legacy:1",
  runId: "run:legacy",
  parentEventId: null,
  sequence: 1,
  timestamp: "not-iso",
  participantId: "cabinAssistant",
  kind: "response",
  status: "done",
  data: { rawOutput: "PRIVATE" },
}), /canonical|protocol|event|unknown|legacy|timestamp|sensitive/i);
assert.equal(forgedLegacyLedger.getCurrentRun(), null);

const events = [event(1), event(2), event(3)];
const otherRunEvent = event(1, {
  eventId: "event:run-b:1",
  runId: "run-b",
  timestamp: "2026-08-08T00:01:00.000Z",
});
const ledger = new RunEventLedger();
const snapshots = [];
ledger.subscribe((snapshot) => snapshots.push(snapshot));

ledger.append(events[0]);
assert.deepEqual(ledger.getCurrentRun(), {
  runId: "run-a", status: "active", startedAt: events[0].timestamp, completedAt: null, events: [events[0]],
});
ledger.append(events[1]);
ledger.append(events[2]);
assert.deepEqual(ledger.getCurrentRun().events, events);
assert.throws(() => ledger.append(events[0]), /duplicate eventId/i);
assert.throws(() => ledger.append(event(2, { eventId: "event:run-a:duplicate-sequence" })), /duplicate sequence/i);
assert.throws(() => ledger.append(otherRunEvent), /complete.*current run/i);
assert.ok(Object.isFrozen(snapshots.at(-1)));
assert.ok(Object.isFrozen(snapshots.at(-1).events));

const completed = ledger.completeRun("run-a");
assert.equal(completed.status, "completed");
assert.deepEqual(completed.events, events);
assert.equal(ledger.getCurrentRun(), null);
assert.equal(ledger.getPreviousRun(), completed);

ledger.append(otherRunEvent);
const failed = ledger.terminateRun("run-b", "failed");
assert.equal(failed.status, "failed");
assert.throws(() => ledger.terminateRun("missing", "failed"), /cannot terminate/i);
assert.throws(() => new RunEventLedger().terminateRun("missing", "error"), /unsupported terminal run status|cannot terminate/i);

const cancelledLedger = new RunEventLedger();
cancelledLedger.append(otherRunEvent);
assert.equal(cancelledLedger.terminateRun("run-b", "cancelled").status, "cancelled");

const parentLedger = new RunEventLedger();
parentLedger.append(events[0]);
assert.throws(() => parentLedger.append(event(3, {
  eventId: "event:run-a:missing-parent",
  sequence: 2,
  parentEventId: "event:run-a:not-found",
})), /parentEventId.*existing|parent/i);
assert.throws(() => parentLedger.append(event(3, {
  eventId: "event:run-a:future-parent",
  sequence: 2,
  parentEventId: events[2].eventId,
})), /parentEventId.*existing|parent/i);
assert.throws(() => parentLedger.append(event(2, {
  eventId: "event:run-a:cross-run-parent",
  parentEventId: otherRunEvent.eventId,
})), /parentEventId.*same run|parent/i);

const outOfOrderLedger = new RunEventLedger();
assert.throws(() => outOfOrderLedger.append(events[1]), /first event.*parentEventId|null|parent/i);

const b3 = ({ sequence, component, phase, parentEventId = null, knowledge }) => createRunEvent({
  eventId: `event:b3:${sequence}`,
  runId: "run:b3",
  parentEventId,
  sequence,
  timestamp: `2026-08-08T00:02:0${sequence}.000Z`,
  component,
  phase,
  status: "completed",
  summary: phase,
  refs: [],
  metadata: { knowledge },
});
const delegationId = "delegation:b3";
const delegation = b3({
  sequence: 1,
  component: "orchestrator",
  phase: "knowledge-delegation",
  knowledge: {
    delegationId,
    delegation: {
      delegationId,
      runId: "run:b3",
      parentPlanId: "parent",
      parentStepId: "knowledge",
      knowledgeGoal: "验证 B3 ledger",
      vehicleScope: "nio-es8-user-manual-2026",
      allowedCapabilities: ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
      allowVehicleStateRead: false,
      requireSafetyEligibilityExplanation: false,
      expectedAnswerContract: "knowledge-answer@1",
      dependsOn: [],
    },
  },
});
const subplan = b3({
  sequence: 2, component: "orchestrator", phase: "knowledge-subplanning", parentEventId: delegation.eventId,
  knowledge: {
    delegationId,
    subplanId: "subplan:b3",
    validation: { ok: true },
    subplan: {
      subplanId: "subplan:b3", delegationId, runId: "run:b3", parentPlanId: "parent", parentStepId: "knowledge",
      selectedCapabilities: ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
      steps: [
        { stepId: "manual", capabilityId: "knowledge.manual.retrieve", dependsOn: [], accessMode: "read", status: "queued" },
        { stepId: "answer", capabilityId: "knowledge.answer.synthesize", dependsOn: ["manual"], accessMode: "read", status: "queued" },
      ],
      planningSummary: "manual then answer", status: "ready",
    },
  },
});
const manual = b3({ sequence: 3, component: "manualRetriever", phase: "knowledge-evidence", parentEventId: subplan.eventId, knowledge: { delegationId, subplanId: "subplan:b3", stepId: "manual", capabilityId: "knowledge.manual.retrieve", dependsOnEventIds: [], outcomeStatus: "completed", retrievalStatus: "miss", evidenceRefs: [] } });
const answer = b3({ sequence: 4, component: "cabinAssistant", phase: "knowledge-answer", parentEventId: manual.eventId, knowledge: { delegationId, subplanId: "subplan:b3", stepId: "answer", capabilityId: "knowledge.answer.synthesize", dependsOnEventIds: [manual.eventId], outcomeStatus: "answered", supportStatus: "unsupported", evidenceRefs: [], vehicleStateRefs: [] } });
const b3Ledger = new RunEventLedger();
for (const item of [delegation, subplan, manual, answer]) assert.doesNotThrow(() => b3Ledger.append(item));

const missingDependencyLedger = new RunEventLedger();
for (const item of [delegation, subplan, manual]) missingDependencyLedger.append(item);
assert.throws(() => missingDependencyLedger.append(createRunEvent({
  ...answer,
  eventId: "event:b3:missing-dependency",
  metadata: { knowledge: { ...answer.metadata.knowledge, dependsOnEventIds: [] } },
})), /dependsOnEventIds/i);

const replayLedger = new RunEventLedger();
for (const item of events) replayLedger.append(item);
const replay = replayLedger.createReplay("run-a");
assert.deepEqual(replay.visibleEvents, []);
replay.stepForward().stepForward();
assert.deepEqual(replay.visibleEvents, events.slice(0, 2));
replay.stepBack();
assert.deepEqual(replay.visibleEvents, events.slice(0, 1));
replay.seek(3);
assert.deepEqual(replay.visibleEvents, events);
replay.reset();
assert.deepEqual(replay.visibleEvents, []);

console.log("run event ledger v2 verification passed");
