import assert from "node:assert/strict";
import { presentProgress } from "../../src/application/progress-presenter.js";
import {
  createRunEvent,
  RUN_EVENT_PROTOCOL,
  TASK_PROGRESS_STAGES,
  validateRunEvent,
} from "../../src/runtime/run-event-protocol.js";

const snapshot = (currentStage, status = "running", overrides = {}) => ({
  taskId: "task:progress:1",
  runId: "run:progress:1",
  status,
  currentStage,
  completedStepIds: [],
  activeStepIds: [],
  pendingStepIds: [],
  committedEffects: [],
  latestFactsRef: null,
  cancellationState: "none",
  updatedAt: "2026-08-05T00:00:00.000Z",
  ...overrides,
});

const taskSnapshot = snapshot("executing");
const progressEvent = createRunEvent({
  eventId: "event:progress:1",
  runId: "run:progress:1",
  parentEventId: null,
  sequence: 1,
  timestamp: "2026-08-05T00:00:00.000Z",
  component: "responsePresentation",
  phase: "task-snapshot",
  status: "processing",
  summary: "正在执行已通过校验的步骤",
  refs: ["task:progress:1"],
  metadata: { task: { snapshot: taskSnapshot } },
});

assert.deepEqual(TASK_PROGRESS_STAGES, ["accepted", "planning", "executing", "waiting", "finalizing"]);
assert.equal(Object.isFrozen(TASK_PROGRESS_STAGES), true);
assert.throws(() => TASK_PROGRESS_STAGES.push("invented"), TypeError);
assert.equal(presentProgress(snapshot("accepted", "queued")), "已收到目标，正在确定处理路径");
assert.equal(presentProgress(snapshot("planning"), progressEvent), "正在拆解需要协同的步骤");
assert.equal(presentProgress(snapshot("executing")), "正在执行已通过校验的步骤");
assert.equal(presentProgress(snapshot("waiting", "waiting")), "正在等待外部能力返回");
assert.equal(presentProgress(snapshot("finalizing")), "执行事实已汇总，正在生成回复");
assert.equal(presentProgress(snapshot("planning"), { ...progressEvent, runId: "run:other" }), null);
for (const invalid of [snapshot("unknown"), snapshot("finalizing", "completed"), snapshot("finalizing", "failed"), snapshot("finalizing", "cancelled"), { currentStage: "planning", status: "running" }, null]) {
  assert.equal(presentProgress(invalid), null);
}
assert.equal(Object.isFrozen(progressEvent), true);
assert.equal(Object.isFrozen(progressEvent.metadata), true);
assert.equal(Object.isFrozen(progressEvent.metadata.task.snapshot), true);
assert.deepEqual(RUN_EVENT_PROTOCOL, { id: "nio-run-event", version: "2.0.0" });
assert.deepEqual(validateRunEvent(progressEvent), []);
for (const legacy of ["participantId", "kind", "outputSummary", "data", "requestId", "agentId", "message"]) {
  assert.equal(Object.hasOwn(progressEvent, legacy), false);
}

console.log("Lean runtime progress presenter v2 verifier passed.");
