import assert from "node:assert/strict";
import {
  BackgroundTaskCoordinator,
  createTaskSnapshot,
} from "../../src/application/background-task-coordinator.js";
import {
  createExecutionFacts,
  createGoalEnvelope,
  createTaskPlan,
} from "../../src/agents/agent-contracts.js";
import { createTaskPlanExecution } from "../../src/runtime/task-plan-execution.js";

const runId = "run:background:happy";
const goalEnvelope = createGoalEnvelope({
  goalId: `goal:${runId}`,
  runId,
  objective: "汇总车辆使用建议",
  interactionType: "question",
  domain: "manual",
  constraints: [],
  contextRefs: [],
  requiredClarifications: [],
  readyForPlanning: true,
  model: "test-cabin",
  provider: "test",
  confidenceStrength: "high",
});
const taskPlan = createTaskPlan({
  planId: `plan:${runId}`,
  goalId: goalEnvelope.goalId,
  runId,
  steps: [
    {
      stepId: "manual",
      capabilityId: "manual.retrieve",
      dependsOn: [],
      input: { query: "车辆使用建议" },
      expectedOutput: "manual evidence",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "response",
      capabilityId: "response.synthesize",
      dependsOn: ["manual"],
      input: { facts: { summary: "", evidenceRefs: [] } },
      expectedOutput: "response",
      accessMode: "read",
      status: "planned",
    },
  ],
  selectedCapabilities: ["manual.retrieve", "response.synthesize"],
  writeActionCount: 0,
  planningSummary: "先检索，再汇总。",
  model: "test-orchestrator",
  provider: "test",
  status: "planned",
});

const calls = [];
const snapshots = [];
let tick = 0;
const coordinator = new BackgroundTaskCoordinator({
  cabin: {
    async formGoal() {
      calls.push("cabin.formGoal");
      return { goalEnvelope, telemetry: { model: "test-cabin", provider: "test" } };
    },
    async synthesize({ executionFacts }) {
      calls.push("cabin.synthesize");
      assert.equal(Object.isFrozen(executionFacts), true);
      return { text: "已根据执行事实完成汇总。", telemetry: { model: "test-cabin", provider: "test" } };
    },
  },
  orchestrator: {
    async plan() {
      calls.push("orchestrator.plan");
      return {
        taskPlan,
        validation: { ok: true, plan: taskPlan, errors: [] },
        telemetry: { model: "test-orchestrator", provider: "test" },
      };
    },
  },
  createExecutionLedger: createTaskPlanExecution,
  async executeCapability({ step }) {
    calls.push(`capability:${step.stepId}`);
    if (step.stepId === "manual") {
      return { evidenceRefs: [{ id: "manual:1", source: "manual", type: "manual" }] };
    }
    return { summary: "facts ready" };
  },
  now: () => Date.UTC(2026, 7, 5, 0, 0, tick++),
});
coordinator.subscribe((snapshot) => snapshots.push(snapshot));

const resultPromise = coordinator.run({ runId, taskId: runId, rawText: "请汇总车辆使用建议" });
assert.equal(snapshots[0].currentStage, "accepted", "accepted snapshot must publish synchronously");
assert.equal(calls[0], "cabin.formGoal", "accepted must publish before the first async dependency settles");
const result = await resultPromise;
assert.deepEqual(calls, [
  "cabin.formGoal",
  "orchestrator.plan",
  "capability:manual",
  "capability:response",
  "cabin.synthesize",
]);
assert.equal(result.assistantResponse, "已根据执行事实完成汇总。");
assert.deepEqual(result.modelCalls.map((call) => call.phase), [
  "goal-formation",
  "task-planning",
  "final-synthesis",
]);
assert.equal(result.executionFacts.completionStatus, "completed");
assert.equal(snapshots[0].currentStage, "accepted");
assert.equal(snapshots.at(-1).status, "completed");
assert.equal(coordinator.getSnapshot(runId), snapshots.at(-1));
assert.equal(Object.isFrozen(snapshots.at(-1)), true);

const normalized = createTaskSnapshot({
  taskId: "task:dedupe",
  runId: "run:dedupe",
  status: "running",
  currentStage: "executing",
  completedStepIds: ["a", "a"],
  activeStepIds: ["b", "b"],
  pendingStepIds: ["c", "c"],
  committedEffects: [],
  latestFactsRef: null,
  cancellationState: "none",
  updatedAt: "2026-08-05T00:00:00.000Z",
});
assert.deepEqual(normalized.completedStepIds, ["a"]);
assert.deepEqual(normalized.activeStepIds, ["b"]);
assert.deepEqual(normalized.pendingStepIds, ["c"]);
assert.throws(() => normalized.pendingStepIds.push("d"), TypeError);

await verifyInvalidPlanFailsBeforeCapability();
await verifyUnknownCapabilityFailsClosed();
await verifyCapabilityAccessModeFailsClosed();
await verifyMoreThanOneWriteFailsBeforeCapability();
await verifyCancellationBeforeDispatch();
await verifyLateReadResultIsolation();
await verifyFinalSynthesisCancellationLifecycle();
await verifyCommittedEffectCancellationDuringFinalSynthesis();
await verifyCommittedEffectTruthAfterCancellation();
await verifyCommittedEffectTruthAfterFailure();
await verifyUnconfirmedWriteCannotCompleteTask();
await verifyRunnableDependencyScheduling();
await verifySynthesisFactsOnlyFallback();
await verifySafetyRejectScheduling();

console.log("Lean runtime background task verifier passed.");

async function verifyInvalidPlanFailsBeforeCapability() {
  const fixture = createCoordinatorFixture({
    runId: "run:background:invalid-plan",
    planResult: { taskPlan: null, validation: { ok: false, errors: ["invalid"] }, telemetry: {} },
  });
  await assert.rejects(
    fixture.coordinator.run({ runId: fixture.runId, rawText: "invalid" }),
    /invalid TaskPlan/,
  );
  assert.equal(fixture.capabilityCalls.length, 0);
  assert.equal(fixture.synthesisCalls, 0);
  assert.equal(fixture.coordinator.getSnapshot(fixture.runId).status, "failed");

  const mismatchRunId = "run:background:validation-mismatch";
  const mismatchGoal = goalFor(mismatchRunId);
  const mismatchPlan = readPlanFor(mismatchRunId, mismatchGoal.goalId);
  const mismatch = createCoordinatorFixture({
    runId: mismatchRunId,
    goal: mismatchGoal,
    taskPlan: mismatchPlan,
    planResult: {
      taskPlan: mismatchPlan,
      validation: { ok: true, plan: readPlanFor(mismatchRunId, mismatchGoal.goalId), errors: [] },
      telemetry: {},
    },
  });
  await assert.rejects(
    mismatch.coordinator.run({ runId: mismatchRunId, rawText: "mismatched validation" }),
    /invalid TaskPlan/,
  );
  assert.equal(mismatch.capabilityCalls.length, 0);
}

async function verifyUnknownCapabilityFailsClosed() {
  const caseRunId = "run:background:unknown";
  const goal = goalFor(caseRunId);
  const unknownPlan = rawPlan(caseRunId, goal.goalId, [{
    stepId: "unknown",
    capabilityId: "vehicle.magic.execute",
    dependsOn: [],
    input: {},
    expectedOutput: "never",
    accessMode: "read",
    status: "planned",
  }]);
  const fixture = createCoordinatorFixture({ runId: caseRunId, goal, taskPlan: unknownPlan });
  await assert.rejects(
    fixture.coordinator.run({ runId: caseRunId, rawText: "unknown" }),
    /validated TaskPlan|unsupported capability/,
  );
  assert.equal(fixture.capabilityCalls.length, 0);
}

async function verifyCapabilityAccessModeFailsClosed() {
  const caseRunId = "run:background:access-mode-mismatch";
  const goal = goalFor(caseRunId);
  const plan = createTaskPlan(rawPlan(caseRunId, goal.goalId, [
    planStep("manual", "manual.retrieve", [], "write", { query: "manual" }),
  ]));
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    goal,
    taskPlan: plan,
    createExecutionLedger: createRunnableTestLedger,
  });
  await assert.rejects(
    fixture.coordinator.run({ runId: caseRunId, rawText: "mismatched access mode" }),
    /capability accessMode mismatch/,
  );
  assert.equal(fixture.capabilityCalls.length, 0);
}

async function verifyMoreThanOneWriteFailsBeforeCapability() {
  const caseRunId = "run:background:two-writes";
  const goal = goalFor(caseRunId, { interactionType: "command", domain: "vehicle-control" });
  const plan = rawPlan(caseRunId, goal.goalId, [
    planStep("safety", "safety.evaluate", [], "read", { action: "vehicle command" }),
    planStep("window", "vehicle.window.set-position", ["safety"], "write", { zone: "front_left", percent: 50 }),
    planStep("seat", "vehicle.seat.set-backrest", ["safety"], "write", { zone: "driver", angle: 100 }),
  ]);
  const fixture = createCoordinatorFixture({ runId: caseRunId, goal, taskPlan: plan });
  await assert.rejects(
    fixture.coordinator.run({ runId: caseRunId, rawText: "two writes" }),
    /at most one write/,
  );
  assert.equal(fixture.capabilityCalls.length, 0);
}

async function verifyCancellationBeforeDispatch() {
  const caseRunId = "run:background:cancel-before-dispatch";
  const planGate = deferred();
  const planStarted = deferred();
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    async planBehavior(result) {
      planStarted.resolve();
      await planGate.promise;
      return result;
    },
  });
  const pending = fixture.coordinator.run({ runId: caseRunId, rawText: "cancel before dispatch" });
  await planStarted.promise;
  const cancelled = fixture.coordinator.cancel(caseRunId, "user-cancelled");
  assert.equal(cancelled.status, "running");
  assert.equal(cancelled.cancellationState, "requested");
  planGate.resolve();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(fixture.capabilityCalls.length, 0);
  assert.equal(fixture.coordinator.getSnapshot(caseRunId).status, "cancelled");
}

async function verifyLateReadResultIsolation() {
  const caseRunId = "run:background:late-read";
  const capabilityStarted = deferred();
  const capabilityGate = deferred();
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    async capabilityBehavior({ step }) {
      if (step.stepId === "manual") {
        capabilityStarted.resolve();
        await capabilityGate.promise;
        return { evidenceRefs: [{ id: "late", source: "manual", type: "manual" }] };
      }
      return { summary: "must not run" };
    },
  });
  const pending = fixture.coordinator.run({ runId: caseRunId, rawText: "late read" });
  await capabilityStarted.promise;
  fixture.coordinator.cancel(caseRunId, "user-cancelled");
  capabilityGate.resolve();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  const snapshot = fixture.coordinator.getSnapshot(caseRunId);
  assert.deepEqual(snapshot.completedStepIds, []);
  assert.deepEqual(snapshot.activeStepIds, []);
  assert.deepEqual(snapshot.pendingStepIds, []);
  assert.deepEqual(snapshot.committedEffects, []);
  assert.deepEqual(fixture.capabilityCalls, ["manual"]);
}

async function verifyFinalSynthesisCancellationLifecycle() {
  const caseRunId = "run:background:cancel-final-synthesis";
  const synthesisStarted = deferred();
  const synthesisGate = deferred();
  let synthesisAttempt = 0;
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    async synthesisBehavior() {
      synthesisAttempt += 1;
      if (synthesisAttempt === 1) {
        synthesisStarted.resolve();
        await synthesisGate.promise;
      }
      return {
        text: synthesisAttempt === 1 ? "late synthesis must not win" : "fresh synthesis",
        telemetry: { model: "test-cabin", provider: "test" },
      };
    },
  });
  const pending = fixture.coordinator.run({ runId: caseRunId, taskId: caseRunId, rawText: "cancel final synthesis" });
  await synthesisStarted.promise;
  const finalizing = fixture.coordinator.getSnapshot(caseRunId);
  assert.equal(finalizing.currentStage, "finalizing");
  assert.equal(["running", "waiting"].includes(finalizing.status), true);

  const requested = fixture.coordinator.cancel(caseRunId, "user-cancelled-finalizing");
  assert.equal(requested.cancellationState, "requested");
  assert.equal(["running", "waiting"].includes(requested.status), true);
  await assert.rejects(
    fixture.coordinator.run({ runId: caseRunId, taskId: caseRunId, rawText: "must not reenter" }),
    /already active/,
  );
  synthesisGate.resolve();
  await assert.rejects(pending, (error) => error?.name === "AbortError");

  const cancelled = fixture.coordinator.getSnapshot(caseRunId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellationState, "cancelled");
  assert.deepEqual(cancelled.activeStepIds, []);
  assert.deepEqual(cancelled.pendingStepIds, []);

  const reused = await fixture.coordinator.run({
    runId: caseRunId,
    taskId: caseRunId,
    rawText: "reuse after settled",
  });
  assert.equal(reused.status, "completed");
  assert.notEqual(reused.assistantResponse, "late synthesis must not win");
}

async function verifyCommittedEffectCancellationDuringFinalSynthesis() {
  const caseRunId = "run:background:cancel-final-synthesis-after-commit";
  const goal = goalFor(caseRunId, { interactionType: "command", domain: "vehicle-control" });
  const plan = createTaskPlan(rawPlan(caseRunId, goal.goalId, [
    planStep("safety", "safety.evaluate", [], "read", { action: "open window" }),
    planStep("window", "vehicle.window.set-position", ["safety"], "write", { zone: "front_left", percent: 50 }),
    planStep("response", "response.synthesize", ["window"], "read", {
      facts: { summary: "", evidenceRefs: [] },
    }),
  ]));
  const synthesisStarted = deferred();
  const synthesisGate = deferred();
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    goal,
    taskPlan: plan,
    async capabilityBehavior({ step }) {
      if (step.stepId === "safety") {
        return { safetyDecision: { allowed: true, action: "allow", reason: "safe" } };
      }
      if (step.stepId === "window") {
        return committedWindowResult(caseRunId, "snapshot:final-synthesis-cancel");
      }
      return { summary: "facts ready" };
    },
    async synthesisBehavior() {
      synthesisStarted.resolve();
      await synthesisGate.promise;
      return {
        text: "late completed answer must be ignored",
        telemetry: { model: "test-cabin", provider: "test" },
      };
    },
  });
  const pending = fixture.coordinator.run({ runId: caseRunId, rawText: "cancel final response after commit" });
  await synthesisStarted.promise;
  const finalizing = fixture.coordinator.getSnapshot(caseRunId);
  assert.equal(finalizing.status, "running");
  assert.equal(finalizing.currentStage, "finalizing");
  assert.equal(finalizing.committedEffects.length, 1);

  fixture.coordinator.cancel(caseRunId, "user-cancelled-final-synthesis-after-commit");
  synthesisGate.resolve();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.executionFacts.completionStatus, "incomplete");
  assert.equal(result.executionFacts.degraded, true);
  assert.equal(result.committedEffects.length, 1);
  assert.equal(result.executionFacts.toolResult.executionState, "observed-succeeded");
  assert.equal(result.executionFacts.confirmedVehicleState.id, "snapshot:final-synthesis-cancel");
  assert.match(result.assistantResponse, /取消/);
  assert.match(result.assistantResponse, /保留|已确认/);
  assert.doesNotMatch(result.assistantResponse, /late completed answer|已完成|成功|撤销/);
  assert.deepEqual(result.modelCalls.map((call) => call.phase), [
    "goal-formation", "task-planning", "final-synthesis",
  ]);
  assert.equal(result.modelCalls.at(-1).telemetry.degraded, true);
  assert.equal(result.modelCalls.at(-1).telemetry.reason, "synthesis-cancelled");
  const cancelled = fixture.coordinator.getSnapshot(caseRunId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellationState, "cancelled");
  assert.equal(cancelled.committedEffects.length, 1);
  assert.deepEqual(cancelled.activeStepIds, []);
  assert.deepEqual(cancelled.pendingStepIds, []);
  assert.deepEqual(fixture.capabilityCalls, ["safety", "window", "response"]);
}

async function verifyCommittedEffectTruthAfterCancellation() {
  const caseRunId = "run:background:committed-write";
  const goal = goalFor(caseRunId, { interactionType: "command", domain: "vehicle-control" });
  const plan = createTaskPlan(rawPlan(caseRunId, goal.goalId, [
    planStep("safety", "safety.evaluate", [], "read", { action: "open window" }),
    planStep("window", "vehicle.window.set-position", ["safety"], "write", { zone: "front_left", percent: 50 }),
    planStep("response", "response.synthesize", ["window"], "read", {
      facts: { summary: "", evidenceRefs: [] },
    }),
  ]));
  const writeStarted = deferred();
  const writeGate = deferred();
  const trustedSafetyDecision = Object.freeze({
    requestId: caseRunId,
    allowed: true,
    action: "allow",
    safeIntent: "vehicle.window.set-position",
  });
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    goal,
    taskPlan: plan,
    async capabilityBehavior({ step }) {
      if (step.stepId === "safety") return { safetyDecision: trustedSafetyDecision };
      if (step.stepId === "window") {
        writeStarted.resolve();
        await writeGate.promise;
        return {
          toolResult: {
            requestId: caseRunId,
            commandId: `${caseRunId}:1:vehicle.window.set-position`,
            tool: "vehicle.window.set-position",
            ok: true,
            executionState: "observed-succeeded",
            confirmedSnapshotId: "snapshot:committed",
            source: "trusted-task5-owner",
          },
          confirmedVehicleState: {
            id: "snapshot:committed",
            source: "demo-sensor-simulator",
            capturedAt: "2026-08-05T00:00:00.000Z",
            values: { windowPositionPercentByZone: { front_left: 50 } },
          },
        };
      }
      return { summary: "must not run after cancellation" };
    },
  });
  const pending = fixture.coordinator.run({ runId: caseRunId, rawText: "commit then cancel" });
  await writeStarted.promise;
  fixture.coordinator.cancel(caseRunId, "user-cancelled-after-dispatch");
  writeGate.resolve();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.executionFacts.completionStatus, "incomplete");
  assert.equal(result.executionFacts.toolResult.executionState, "observed-succeeded");
  assert.equal(result.committedEffects.length, 1);
  assert.equal(result.committedEffects[0].commandId, `${caseRunId}:1:vehicle.window.set-position`);
  assert.match(result.assistantResponse, /已提交|已确认|保留/);
  assert.equal(fixture.synthesisCalls, 0, "cancellation must not launch final model synthesis");
  const snapshot = fixture.coordinator.getSnapshot(caseRunId);
  assert.equal(snapshot.status, "cancelled");
  assert.equal(snapshot.committedEffects.length, 1);
  assert.equal(snapshot.latestFactsRef, `execution-facts:${caseRunId}:plan:${caseRunId}`);
  assert.throws(() => {
    snapshot.committedEffects[0].commandId = "forged";
  }, TypeError);
  assert.deepEqual(fixture.capabilityCalls, ["safety", "window"]);
}

async function verifyCommittedEffectTruthAfterFailure() {
  const caseRunId = "run:background:committed-then-failed";
  const goal = goalFor(caseRunId, { interactionType: "command", domain: "vehicle-control" });
  const plan = createTaskPlan(rawPlan(caseRunId, goal.goalId, [
    planStep("safety", "safety.evaluate", [], "read", { action: "open window" }),
    planStep("window", "vehicle.window.set-position", ["safety"], "write", { zone: "front_left", percent: 50 }),
    planStep("response", "response.synthesize", ["window"], "read", {
      facts: { summary: "", evidenceRefs: [] },
    }),
  ]));
  const trustedSafetyDecision = Object.freeze({
    requestId: caseRunId,
    allowed: true,
    action: "allow",
    safeIntent: "vehicle.window.set-position",
  });
  const failedSynthesisStarted = deferred();
  const failedSynthesisGate = deferred();
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    goal,
    taskPlan: plan,
    async capabilityBehavior({ step }) {
      if (step.stepId === "safety") return { safetyDecision: trustedSafetyDecision };
      if (step.stepId === "window") return committedWindowResult(caseRunId, "snapshot:failed-run");
      throw new Error("downstream response capability failed");
    },
    async synthesisBehavior() {
      failedSynthesisStarted.resolve();
      await failedSynthesisGate.promise;
      return {
        text: "must not upgrade failed task",
        telemetry: { model: "test-cabin", provider: "test" },
      };
    },
  });
  const pending = fixture.coordinator.run({ runId: caseRunId, rawText: "commit then fail" });
  await failedSynthesisStarted.promise;
  const finalizing = fixture.coordinator.getSnapshot(caseRunId);
  assert.equal(finalizing.currentStage, "finalizing");
  assert.equal(finalizing.status, "running");
  await assert.rejects(
    fixture.coordinator.run({ runId: caseRunId, rawText: "must not reenter failed finalization" }),
    /already active/,
  );
  failedSynthesisGate.resolve();
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.executionFacts.completionStatus, "incomplete");
  assert.equal(result.executionFacts.toolResult.executionState, "observed-succeeded");
  assert.equal(result.committedEffects.length, 1);
  assert.match(result.assistantResponse, /未完整完成|保留/);
  assert.equal(fixture.synthesisCalls, 1);
  assert.deepEqual(result.modelCalls.map((call) => call.phase), [
    "goal-formation", "task-planning", "final-synthesis",
  ]);
  assert.equal(fixture.coordinator.getSnapshot(caseRunId).status, "failed");
}

async function verifyUnconfirmedWriteCannotCompleteTask() {
  const caseRunId = "run:background:unconfirmed-write";
  const goal = goalFor(caseRunId, { interactionType: "command", domain: "vehicle-control" });
  const plan = createTaskPlan(rawPlan(caseRunId, goal.goalId, [
    planStep("safety", "safety.evaluate", [], "read", { action: "open window" }),
    planStep("window", "vehicle.window.set-position", ["safety"], "write", { zone: "front_left", percent: 50 }),
    planStep("response", "response.synthesize", ["window"], "read", {
      facts: { summary: "", evidenceRefs: [] },
    }),
  ]));
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    goal,
    taskPlan: plan,
    async capabilityBehavior({ step }) {
      if (step.stepId === "safety") {
        return { safetyDecision: { allowed: true, action: "allow", reason: "safe" } };
      }
      if (step.stepId === "window") {
        return {
          toolResult: {
            requestId: caseRunId,
            commandId: `${caseRunId}:1:vehicle.window.set-position`,
            tool: "vehicle.window.set-position",
            ok: false,
            executionState: "failed",
            source: "trusted-task5-owner",
          },
          confirmedVehicleState: null,
        };
      }
      return { summary: "facts ready" };
    },
  });
  const result = await fixture.coordinator.run({ runId: caseRunId, rawText: "unconfirmed write" });
  assert.equal(result.executionFacts.completionStatus, "incomplete");
  assert.equal(result.status, "failed");
  assert.equal(fixture.coordinator.getSnapshot(caseRunId).status, "failed");
  assert.equal(fixture.synthesisCalls, 1);
  assert.deepEqual(result.modelCalls.map((call) => call.phase), [
    "goal-formation", "task-planning", "final-synthesis",
  ]);
  assert.match(result.assistantResponse, /最终确认|无法完整完成/);
  assert.doesNotMatch(result.assistantResponse, /已完成|成功/);
  assert.doesNotMatch(result.assistantResponse, /execution-incomplete/);
  assert.equal(result.executionFacts.failureReason, "execution-incomplete");
  assert.deepEqual(result.committedEffects, []);
}

async function verifyRunnableDependencyScheduling() {
  const caseRunId = "run:background:runnable-order";
  const goal = goalFor(caseRunId);
  const plan = createTaskPlan(rawPlan(caseRunId, goal.goalId, [
    planStep("response", "response.synthesize", ["manual"], "read", {
      facts: { summary: "", evidenceRefs: [] },
    }),
    planStep("manual", "manual.retrieve", [], "read", { query: "manual" }),
  ]));
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    goal,
    taskPlan: plan,
    createExecutionLedger: createRunnableTestLedger,
  });
  const result = await fixture.coordinator.run({ runId: caseRunId, rawText: "dependency order" });
  assert.equal(result.status, "completed");
  assert.deepEqual(fixture.capabilityCalls, ["manual", "response"]);
}

async function verifySynthesisFactsOnlyFallback() {
  const caseRunId = "run:background:synthesis-failure";
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    async synthesisBehavior() {
      throw new Error("model unavailable");
    },
  });
  const result = await fixture.coordinator.run({ runId: caseRunId, rawText: "synthesis failure" });
  assert.equal(result.status, "completed");
  assert.match(result.assistantResponse, /执行事实已汇总|回复暂时无法生成/);
  assert.equal(result.executionFacts.completionStatus, "completed");
  assert.deepEqual(result.modelCalls.map((call) => call.phase), [
    "goal-formation", "task-planning", "final-synthesis",
  ]);
  assert.equal(result.modelCalls.at(-1).telemetry.degraded, true);
  assert.equal(fixture.coordinator.getSnapshot(caseRunId).status, "completed");
}

async function verifySafetyRejectScheduling() {
  const explicit = await runSafetyTerminalCase({
    runId: "run:background:safety-reject",
    safetyDecision: {
      allowed: false,
      action: "reject",
      reason: "车速条件不满足",
      reasonCode: "vehicle-moving",
    },
  });
  assert.equal(explicit.result.status, "failed");
  assert.equal(explicit.result.executionFacts.safetyDecision.allowed, false);
  assert.equal(explicit.result.executionFacts.safetyDecision.action, "reject");
  assert.equal(explicit.result.toolResult, undefined);
  assert.deepEqual(explicit.fixture.capabilityCalls, ["safety", "response"]);
  assert.equal(explicit.fixture.synthesisCalls, 1);
  assert.match(explicit.result.assistantResponse, /安全|车速条件不满足|未通过/);
  assert.doesNotMatch(explicit.result.assistantResponse, /safety-rejected/);
  assert.equal(explicit.fixture.coordinator.getSnapshot(explicit.runId).status, "failed");

  for (const [suffix, safetyDecision] of [
    ["unknown", { allowed: false, action: "unavailable", reason: "Safety unavailable" }],
  ]) {
    const runIdForCase = `run:background:safety-${suffix}`;
    const terminal = runSafetyTerminalCase({ runId: runIdForCase, safetyDecision });
    await assert.rejects(terminal.then((value) => value.result), /no ledger-runnable task step/);
    const fixtureForCase = await terminal.then(
      () => null,
      (error) => error.fixture,
    );
    assert.deepEqual(fixtureForCase.capabilityCalls, ["safety"]);
    assert.equal(fixtureForCase.synthesisCalls, 0);
    const snapshot = fixtureForCase.coordinator.getSnapshot(runIdForCase);
    assert.equal(snapshot.status, "failed");
    assert.deepEqual(snapshot.activeStepIds, []);
    assert.deepEqual(snapshot.pendingStepIds, []);
  }

  const confirmation = await runSafetyTerminalCase({
    runId: "run:background:safety-confirmation",
    safetyDecision: {
      allowed: false,
      action: "require_confirmation",
      reason: "confirmation required",
    },
  });
  assert.equal(confirmation.result.status, "failed");
  assert.equal(confirmation.result.executionFacts.completionStatus, "incomplete");
  assert.equal(confirmation.result.executionFacts.safetyDecision.action, "require_confirmation");
  assert.equal(
    confirmation.result.executionFacts.safetyDecision.confirmationChallenge.id,
    "challenge:background",
  );
  assert.equal(confirmation.result.executionFacts.toolResult, null);
  assert.deepEqual(confirmation.result.committedEffects, []);
  assert.deepEqual(confirmation.fixture.capabilityCalls, ["safety", "window", "response"]);
  assert.equal(confirmation.fixture.synthesisCalls, 1);
  assert.equal(
    confirmation.fixture.coordinator.getSnapshot(confirmation.runId).status,
    "failed",
  );
}

async function runSafetyTerminalCase({ runId: caseRunId, safetyDecision }) {
  const goal = goalFor(caseRunId, { interactionType: "command", domain: "vehicle-control" });
  const plan = createTaskPlan(rawPlan(caseRunId, goal.goalId, [
    planStep("safety", "safety.evaluate", [], "read", { action: "open window" }),
    planStep("window", "vehicle.window.set-position", ["safety"], "write", { zone: "front_left", percent: 50 }),
    planStep("response", "response.synthesize", ["window"], "read", {
      facts: { summary: "", evidenceRefs: [] },
    }),
  ]));
  const fixture = createCoordinatorFixture({
    runId: caseRunId,
    goal,
    taskPlan: plan,
    async capabilityBehavior({ step }) {
      if (step.stepId === "safety") return { safetyDecision };
      if (step.stepId === "window" && safetyDecision.action === "require_confirmation") {
        return {
          safetyDecision: {
            ...safetyDecision,
            confirmationChallenge: {
              id: "challenge:background",
              requestId: caseRunId,
              actionDigest: "sha256:background",
              policyId: "background-policy",
              policyVersion: "1.0.0",
              assertions: [{
                id: "background.user-acknowledged",
                prompt: "确认测试安全条件。",
                proofType: "user-acknowledgement",
                riskType: "test",
              }],
              issuedAt: "2026-08-05T00:00:00.000Z",
              expiresAt: "2026-08-05T00:02:00.000Z",
              responseToken: "background-response-token",
            },
          },
        };
      }
      if (step.stepId === "window") throw new Error("vehicle write must not dispatch");
      return { summary: "Safety facts ready" };
    },
  });
  try {
    const result = await fixture.coordinator.run({ runId: caseRunId, rawText: "Safety terminal" });
    return { runId: caseRunId, fixture, result };
  } catch (error) {
    error.fixture = fixture;
    throw error;
  }
}

function createCoordinatorFixture({
  runId: caseRunId,
  goal = goalFor(caseRunId),
  taskPlan: plan = readPlanFor(caseRunId, goal.goalId),
  planResult,
  planBehavior,
  capabilityBehavior,
  synthesisBehavior,
  createExecutionLedger = createTaskPlanExecution,
} = {}) {
  const capabilityCalls = [];
  let synthesisCalls = 0;
  const successfulPlanResult = planResult ?? {
    taskPlan: plan,
    validation: { ok: true, plan, errors: [] },
    telemetry: { model: "test-orchestrator", provider: "test" },
  };
  let time = 0;
  const coordinatorUnderTest = new BackgroundTaskCoordinator({
    cabin: {
      async formGoal() {
        return { goalEnvelope: goal, telemetry: { model: "test-cabin", provider: "test" } };
      },
      async synthesize() {
        synthesisCalls += 1;
        if (typeof synthesisBehavior === "function") return synthesisBehavior();
        return { text: "facts synthesized", telemetry: { model: "test-cabin", provider: "test" } };
      },
    },
    orchestrator: {
      async plan() {
        return typeof planBehavior === "function"
          ? planBehavior(successfulPlanResult)
          : successfulPlanResult;
      },
    },
    createExecutionLedger,
    async executeCapability(input) {
      capabilityCalls.push(input.step.stepId);
      if (typeof capabilityBehavior === "function") return capabilityBehavior(input);
      return input.step.capabilityId === "manual.retrieve"
        ? { evidenceRefs: [{ id: "manual:fixture", source: "manual", type: "manual" }] }
        : { summary: "facts ready" };
    },
    now: () => Date.UTC(2026, 7, 5, 1, 0, time++),
  });
  return {
    runId: caseRunId,
    coordinator: coordinatorUnderTest,
    capabilityCalls,
    get synthesisCalls() { return synthesisCalls; },
  };
}

function createRunnableTestLedger(plan) {
  const entries = plan.steps.map((step) => ({ step, status: "planned", result: null }));
  const entryById = new Map(entries.map((entry) => [entry.step.stepId, entry]));
  return {
    canExecute(stepId) {
      const entry = entryById.get(stepId);
      if (!entry || entry.status !== "planned") return { allowed: false, reasonCode: "terminal" };
      const ready = entry.step.dependsOn.every((id) => entryById.get(id)?.status === "completed");
      return { allowed: ready, reasonCode: ready ? "ready" : "dependency-pending" };
    },
    start(stepId) { entryById.get(stepId).status = "running"; },
    complete(stepId, value) {
      const entry = entryById.get(stepId);
      entry.status = "completed";
      entry.result = value;
    },
    fail(stepId, reason) {
      const entry = entryById.get(stepId);
      entry.status = "failed";
      entry.failureReason = reason;
    },
    blockSafetyRejected(stepId) {
      const entry = entryById.get(stepId);
      entry.status = "blocked";
      entry.failureReason = "safety-rejected";
    },
    cancel(reason = "cancelled") {
      for (const entry of entries) {
        if (!["completed", "failed"].includes(entry.status)) {
          entry.status = "failed";
          entry.failureReason = reason;
        }
      }
    },
    buildExecutionFacts(input = {}) {
      return createExecutionFacts({
        runId: plan.runId,
        goalId: plan.goalId,
        planId: plan.planId,
        stepResults: entries.map((entry) => ({
          stepId: entry.step.stepId,
          capabilityId: entry.step.capabilityId,
          status: entry.status,
        })),
        evidenceRefs: [],
        safetyDecision: null,
        toolResult: null,
        confirmedVehicleState: null,
        degraded: false,
        failureReason: "",
        completionStatus: input.completionStatus || "completed",
      });
    },
    snapshot() {
      return {
        runId: plan.runId,
        goalId: plan.goalId,
        planId: plan.planId,
        steps: entries.map((entry) => ({ ...entry.step, status: entry.status })),
      };
    },
  };
}

function goalFor(caseRunId, overrides = {}) {
  return createGoalEnvelope({
    goalId: `goal:${caseRunId}`,
    runId: caseRunId,
    objective: "执行后台任务",
    interactionType: "question",
    domain: "manual",
    constraints: [],
    contextRefs: [],
    requiredClarifications: [],
    readyForPlanning: true,
    model: "test-cabin",
    provider: "test",
    confidenceStrength: "high",
    ...overrides,
  });
}

function readPlanFor(caseRunId, goalId) {
  return createTaskPlan(rawPlan(caseRunId, goalId, [
    planStep("manual", "manual.retrieve", [], "read", { query: "manual" }),
    planStep("response", "response.synthesize", ["manual"], "read", {
      facts: { summary: "", evidenceRefs: [] },
    }),
  ]));
}

function rawPlan(caseRunId, goalId, steps) {
  return {
    planId: `plan:${caseRunId}`,
    goalId,
    runId: caseRunId,
    steps,
    selectedCapabilities: steps.map((step) => step.capabilityId),
    writeActionCount: steps.filter((step) => step.accessMode === "write").length,
    planningSummary: "fixture plan",
    model: "test-orchestrator",
    provider: "test",
    status: "planned",
  };
}

function planStep(stepId, capabilityId, dependsOn, accessMode, input) {
  return {
    stepId,
    capabilityId,
    dependsOn,
    input,
    expectedOutput: "capability result",
    accessMode,
    status: "planned",
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function committedWindowResult(caseRunId, snapshotId) {
  return {
    toolResult: {
      requestId: caseRunId,
      commandId: `${caseRunId}:1:vehicle.window.set-position`,
      tool: "vehicle.window.set-position",
      ok: true,
      executionState: "observed-succeeded",
      confirmedSnapshotId: snapshotId,
      source: "trusted-task5-owner",
    },
    confirmedVehicleState: {
      id: snapshotId,
      source: "demo-sensor-simulator",
      capturedAt: "2026-08-05T00:00:00.000Z",
      values: { windowPositionPercentByZone: { front_left: 50 } },
    },
  };
}
