#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  PendingClarificationStore,
  createPendingClarification,
} from "../../src/runtime/pending-clarification-store.js";

const store = new PendingClarificationStore();
const pending = createPendingClarification({
  taskId: "task-a",
  intent: "vehicle.ac.set_temperature",
  acceptedSlots: { zone: "driver" },
  missingSlots: ["percent"],
  slotProvenance: { zone: "original-turn" },
  clarificationQuestion: "请问要调到多少？",
  originalUtterance: "把主驾空调调高",
});

assert.equal(store.get("session-a"), null, "new sessions have no pending clarification");
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = () => { throw new Error("pending clarification must not schedule a TTL timer"); };
assert.doesNotThrow(() => new PendingClarificationStore().set("timer-free", pending));
globalThis.setTimeout = originalSetTimeout;
assert.deepEqual(store.set("session-a", pending), {
  status: "stored",
  taskId: "task-a",
  replacedTaskId: null,
});
assert.deepEqual(store.set("session-a", { ...pending, taskId: "task-b" }), {
  status: "stored",
  taskId: "task-b",
  replacedTaskId: "task-a",
});
assert.equal(store.get("session-b"), null, "sessions remain isolated");

const snapshot = store.get("session-a");
assert.throws(() => { snapshot.acceptedSlots.zone = "passenger"; }, TypeError);
assert.equal(store.get("session-a").acceptedSlots.zone, "driver", "get returns an immutable snapshot");

assert.throws(
  () => store.mergeSlots("session-a", {
    slots: { percent: 50, zone: "passenger" },
    slotProvenance: { percent: "clarification-turn", zone: "clarification-turn" },
  }),
  /undeclared slot: zone/,
);
assert.throws(
  () => store.mergeSlots("session-a", {
    intent: "vehicle.window.open",
    slots: { percent: 50 },
    slotProvenance: { percent: "clarification-turn" },
  }),
  /intent override is not allowed/,
);
assert.throws(
  () => store.mergeSlots("session-a", {
    slots: { percent: 50 },
    slotProvenance: {},
  }),
  /missing provenance: percent/,
);
assert.throws(
  () => store.mergeSlots("session-a", {
    slots: { percent: 50 },
    slotProvenance: { percent: "clarification-turn", zone: "clarification-turn" },
  }),
  /undeclared provenance: zone/,
);

assert.deepEqual(store.mergeSlots("session-a", {
  slots: { percent: 50 },
  slotProvenance: { percent: "clarification-turn" },
}), {
  status: "resolved",
});
assert.deepEqual(store.get("session-a").acceptedSlots, { zone: "driver", percent: 50 });
assert.deepEqual(store.get("session-a").missingSlots, []);
assert.equal(store.get("session-a").slotProvenance.percent, "clarification-turn");

assert.deepEqual(store.clear("session-a", "cancelled-by-user"), {
  status: "cleared",
  taskId: "task-b",
  reasonCode: "cancelled-by-user",
});
assert.equal(store.get("session-a"), null);

assert.throws(
  () => createPendingClarification({ ...pending, slotProvenance: undefined }),
  /slotProvenance is required/,
);

console.log("verify-pending-clarification-store.mjs: passed");
