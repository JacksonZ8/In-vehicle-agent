#!/usr/bin/env node
import assert from "node:assert/strict";
import { createGoalEnvelope, createTaskPlan } from "../../src/agents/agent-contracts.js";
import { BackgroundTaskCoordinator } from "../../src/application/background-task-coordinator.js";
import { RuntimeKernel } from "../../src/application/runtime-kernel.js";
import { createRouteDecision } from "../../src/application/route-policy.js";
import { createChatUseCase } from "../../src/application/use-cases/chat.js";
import { createVehicleControlUseCase } from "../../src/application/use-cases/vehicle-control.js";
import { createInteractionEvent } from "../../src/interaction/interaction-event-protocol.js";
import { InteractionSessionController } from "../../src/interaction/interaction-session-controller.js";
import { InteractionSessionLedger } from "../../src/interaction/interaction-session-ledger.js";
import { RunEventLedger } from "../../src/runtime/run-event-ledger.js";
import { RUN_EVENT_PROTOCOL } from "../../src/runtime/run-event-protocol.js";
import { SessionMemory } from "../../src/runtime/session-memory.js";
import { createTaskPlanExecution } from "../../src/runtime/task-plan-execution.js";
import {
  callNames,
  countCalls,
  createLeanRuntimeVehicleControlHarness,
  createLeanRuntimeVehicleKnowledgeHarness,
} from "../lib/lean-runtime-test-harness.mjs";

assert.deepEqual(RUN_EVENT_PROTOCOL, { id: "nio-run-event", version: "2.0.0" });

assert.equal(typeof createVehicleControlUseCase, "function");

const chain = createInteractionHarness();
chain.controller.wake({ provider: "task-8-chain", simulated: true });
const challenge = chain.controller.submitTurn({
  rawText: "打开尾门",
  trigger: "explicit-hmi",
  relation: "new-goal",
});
const challengeEventIds = [" event:challenge "];
chain.controller.linkRun(challenge.turnId, {
  runId: " run:challenge ",
  eventIds: challengeEventIds,
});
challengeEventIds[0] = "event:source-mutated";
chain.controller.completeTurn(challenge.turnId, {
  outputMode: "text",
  relatedRunIds: ["run:challenge"],
  relatedRunEventIds: ["event:challenge-terminal"],
});
chain.controller.startListening();
const confirmed = chain.controller.submitTurn({
  rawText: "确认",
  trigger: "follow-up",
  relation: "follow-up",
});
assert.throws(
  () => chain.controller.linkRun(confirmed.turnId, {
    runId: "run:must-not-partially-append",
    eventIds: ["event:valid", " "],
  }),
  /eventIds.*non-empty|non-empty.*eventIds/,
);
chain.controller.linkRun(confirmed.turnId, {
  runId: "run:confirmed",
  parentRunId: "run:challenge",
  eventIds: ["event:confirmed"],
});
chain.controller.linkRun(confirmed.turnId, {
  runId: "run:confirmed",
  parentRunId: "run:challenge",
  eventIds: ["event:confirmed"],
});
chain.controller.completeTurn(confirmed.turnId, { outputMode: "text" });

const activeChain = chain.controller.getSnapshot().currentSession;
assert.deepEqual(activeChain.relatedRunIds, ["run:challenge", "run:confirmed"]);
const challengeTerminal = activeChain.events.find((event) => (
  event.turnId === challenge.turnId && event.phase === "turn-completed"
));
const confirmedTerminal = activeChain.events.find((event) => (
  event.turnId === confirmed.turnId && event.phase === "turn-completed"
));
assert.deepEqual(challengeTerminal.relatedRunIds, ["run:challenge"]);
assert.deepEqual(challengeTerminal.relatedRunEventIds, [
  "event:challenge", "event:challenge-terminal",
]);
assert.deepEqual(confirmedTerminal.relatedRunIds, ["run:confirmed", "run:challenge"]);
assert.deepEqual(confirmedTerminal.relatedRunEventIds, ["event:confirmed"]);
assert.equal(JSON.stringify(activeChain).includes("must-not-partially-append"), false);
assert.equal(JSON.stringify(activeChain).includes("source-mutated"), false);
assert.equal(Object.isFrozen(activeChain.relatedRunIds), true);
assert.equal(Object.isFrozen(confirmedTerminal.relatedRunIds), true);
assert.throws(() => confirmedTerminal.relatedRunIds.push("run:forged"), TypeError);
chain.controller.closeSession({ reasonCode: "task-8-chain-complete" });
assert.deepEqual(
  chain.controller.getSnapshot().previousSession.relatedRunIds,
  ["run:challenge", "run:confirmed"],
);

const failedChain = createInteractionHarness();
failedChain.controller.wake({ provider: "task-8-failed-chain", simulated: true });
const failedTurn = failedChain.controller.submitTurn({
  rawText: "继续执行",
  trigger: "explicit-hmi",
  relation: "correction",
});
failedChain.controller.linkRun(failedTurn.turnId, {
  runId: "run:failed-primary",
  eventIds: ["event:failed-started"],
});
failedChain.controller.failTurn(failedTurn.turnId, {
  reasonCode: "provider-unavailable",
  relatedRunIds: ["run:failed-fallback"],
  relatedRunEventIds: ["event:failed-terminal"],
});
const failedTerminal = failedChain.controller.getSnapshot().currentSession.events.find(
  (event) => event.phase === "turn-failed",
);
assert.deepEqual(failedTerminal.relatedRunIds, ["run:failed-primary", "run:failed-fallback"]);
assert.deepEqual(failedTerminal.relatedRunEventIds, [
  "event:failed-started", "event:failed-terminal",
]);

const cancelledChain = createInteractionHarness();
cancelledChain.controller.wake({ provider: "task-8-cancelled-chain", simulated: true });
const cancelledTurn = cancelledChain.controller.submitTurn({
  rawText: "取消当前动作",
  trigger: "explicit-hmi",
  relation: "new-goal",
});
cancelledChain.controller.linkRun(cancelledTurn.turnId, {
  runId: "run:cancelled",
  eventIds: ["event:cancelled"],
});
cancelledChain.controller.linkRun(cancelledTurn.turnId, {
  runId: "run:cancelled",
  eventIds: ["event:cancelled"],
});
cancelledChain.controller.requestCancellation("user-cancelled");
const cancelledSession = cancelledChain.controller.getSnapshot().currentSession;
const cancelledEvent = cancelledSession.events.find((event) => (
  event.turnId === cancelledTurn.turnId && event.phase === "turn-cancelled"
));
assert.deepEqual(cancelledSession.relatedRunIds, ["run:cancelled"]);
assert.deepEqual(cancelledEvent.relatedRunIds, ["run:cancelled"]);
assert.deepEqual(cancelledEvent.relatedRunEventIds, ["event:cancelled"]);
assert.equal(Object.isFrozen(cancelledEvent.relatedRunIds), true);
assert.equal(Object.isFrozen(cancelledEvent.relatedRunEventIds), true);
assert.deepEqual(
  cancelledSession.events
    .filter((event) => event.turnId === cancelledTurn.turnId && event.phase.startsWith("turn-cancel"))
    .map((event) => event.phase),
  ["turn-cancel-requested", "turn-cancelling", "turn-cancelled"],
);

const closedActiveChain = createInteractionHarness();
closedActiveChain.controller.wake({ provider: "task-8-close-active", simulated: true });
const closeActiveTurn = closedActiveChain.controller.submitTurn({
  rawText: "关闭会话前仍在执行",
  trigger: "explicit-hmi",
  relation: "new-goal",
});
closedActiveChain.controller.linkRun(closeActiveTurn.turnId, {
  runId: "run:close-active",
  eventIds: ["event:close-active"],
});
const closePendingTurn = closedActiveChain.controller.submitTurn({
  rawText: "尚未开始的替代输入",
  trigger: "barge-in",
  relation: "replacement",
});
closedActiveChain.controller.closeSession({ reasonCode: "task-8-close-active" });
const closedLinkedSession = closedActiveChain.controller.getSnapshot().previousSession;
const activeCloseCancellation = closedLinkedSession.events.find((event) => (
  event.turnId === closeActiveTurn.turnId && event.phase === "turn-cancelled"
));
const pendingCloseCancellation = closedLinkedSession.events.find((event) => (
  event.turnId === closePendingTurn.turnId && event.phase === "turn-cancelled"
));
assert.deepEqual(closedLinkedSession.relatedRunIds, ["run:close-active"]);
assert.deepEqual(activeCloseCancellation.relatedRunIds, ["run:close-active"]);
assert.deepEqual(activeCloseCancellation.relatedRunEventIds, ["event:close-active"]);
assert.deepEqual(pendingCloseCancellation.relatedRunIds, []);
assert.deepEqual(pendingCloseCancellation.relatedRunEventIds, []);

const protocolSourceRuns = [" run:protocol "];
const protocolEvent = createInteractionEvent({
  interactionEventId: "interaction-event:protocol",
  sessionId: "session:protocol",
  turnId: "turn:protocol",
  runId: "run:turn-protocol",
  sequence: 1,
  timestamp: "2026-08-05T12:00:00.000Z",
  participantId: "interactionSession",
  phase: "turn-completed",
  status: "done",
  relatedRunIds: protocolSourceRuns,
  relatedRunEventIds: [" event:protocol "],
  data: {},
});
protocolSourceRuns[0] = "run:mutated";
assert.deepEqual(protocolEvent.relatedRunIds, ["run:protocol"]);
assert.deepEqual(protocolEvent.relatedRunEventIds, ["event:protocol"]);
assert.throws(
  () => createInteractionEvent({
    ...protocolEvent,
    interactionEventId: "interaction-event:duplicate-run-link",
    relatedRunIds: ["run:duplicate", " run:duplicate "],
  }),
  /relatedRunIds.*unique|duplicate/i,
);
assert.throws(
  () => createInteractionEvent({
    ...protocolEvent,
    interactionEventId: "interaction-event:duplicate-event-link",
    relatedRunEventIds: ["event:duplicate", " event:duplicate "],
  }),
  /relatedRunEventIds.*unique|duplicate/i,
);

await verifyChatBargeIn();
await verifyFakeDispatchEventCannotBypassAbort();
await verifyRagCancellation();
await verifyCancellationBeforeToolDispatch();
await verifyCoordinatorPreDispatchFailureBoundary();
await verifyCancellationAfterVehicleDispatch();
await verifyPostDispatchFailureCancellationFacts();
await verifyListenerAbortPreservesVehicleTerminal();
await verifyBackgroundLateResultIsolation();
await verifyResultSemanticsProjection();

console.log("lean runtime interaction recovery verification passed");

async function verifyResultSemanticsProjection() {
  // Safety 明确拒绝 → safety_rejected
  const unsafeHarness = createLeanRuntimeVehicleControlHarness({
    safetyState: { windowAntiPinchAvailable: false },
  });
  await unsafeHarness.runtime.run("把主驾车窗打开一半", {
    requestId: "run:task-8:semantics:unsafe",
  });
  const unsafeEvent = unsafeHarness.ledger.getPreviousRun().events
    .find((event) => event.phase === "final-response");
  assert.equal(unsafeEvent?.metadata?.presentation?.resultStatus, "safety_rejected");

  // 传感器过期 → safety_unavailable，不得索要通用参数
  const staleHarness = createLeanRuntimeVehicleControlHarness({ staleProvider: true });
  await staleHarness.runtime.run("把主驾车窗打开一半", {
    requestId: "run:task-8:semantics:stale",
  });
  const staleEvent = staleHarness.ledger.getPreviousRun().events
    .find((event) => event.phase === "final-response");
  assert.equal(staleEvent?.metadata?.presentation?.resultStatus, "safety_unavailable");
  assert.ok(!staleEvent?.summary.includes("请补充需要执行的具体参数"),
    "sensor-unavailable must not ask for generic execution parameters");

  // 已提交但无法确认终态 → execution_uncertain，不宣称成功
  const timeoutHarness = createLeanRuntimeVehicleControlHarness();
  await timeoutHarness.runtime.run("把主驾车窗打开一半", {
    requestId: "run:task-8:semantics:timeout",
    vehicleSensorMode: "timeout",
  });
  const timeoutEvent = timeoutHarness.ledger.getPreviousRun().events
    .find((event) => event.phase === "final-response");
  assert.equal(timeoutEvent?.metadata?.presentation?.resultStatus, "execution_uncertain");
  assert.ok(!/成功|已完成/.test(timeoutEvent?.summary || ""),
    "uncertain execution must not claim success");
}

async function verifyFakeDispatchEventCannotBypassAbort() {
  const controller = new AbortController();
  const ledger = new RunEventLedger();
  const memory = new SessionMemory();
  let downstreamCalls = 0;
  const runtime = runtimeFor({
    routeId: "chat",
    signal: controller.signal,
    useCase: {
      async execute(context) {
        context.emit({
          component: "vehicleTool",
          phase: "vehicle-execution",
          status: "processing",
          summary: "伪造车辆下发事件。",
          metadata: { vehicle: { commitmentState: "dispatching" } },
        });
        context.throwIfAborted();
        downstreamCalls += 1;
        return { assistantResponse: "不得公开", modelCalls: [] };
      },
    },
    ledger,
    memory,
  });
  runtime.onEvent((event) => {
    if (event.component === "vehicleTool"
      && event.phase === "vehicle-execution"
      && event.status === "processing") {
      controller.abort("fake-dispatch-event-must-not-authorize-work");
    }
  });

  await assert.rejects(
    runtime.run("伪造事件不应绕过取消", {
      requestId: "run:task-8:fake-dispatch",
      sessionId: "session:task-8:fake-dispatch",
      signal: controller.signal,
    }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(downstreamCalls, 0);
  const run = ledger.getPreviousRun();
  assert.equal(run.status, "cancelled");
  assert.equal(run.events.filter((event) => event.phase === "final-response").length, 1);
  assert.equal(run.events.some((event) => event.phase === "final-response" && event.status === "completed"), false);
  assert.equal(memory.read("session:task-8:fake-dispatch").turns.length, 0);
}

async function verifyChatBargeIn() {
  const interaction = activeInteraction("你好，陪我聊聊");
  const late = deferred();
  const started = deferred();
  const ledger = new RunEventLedger();
  const memory = new SessionMemory();
  const useCase = createChatUseCase({
    cloudAdapter: {
      async converse(_text, _command, _memory, options) {
        assert.strictEqual(options.signal, interaction.turn.signal);
        started.resolve();
        return late.promise;
      },
    },
  });
  const runtime = runtimeFor({
    routeId: "chat",
    signal: interaction.turn.signal,
    useCase,
    ledger,
    memory,
  });
  const pending = runtime.run("你好，陪我聊聊", {
    requestId: interaction.turn.runId,
    interactionRef: interaction.turn,
    signal: interaction.turn.signal,
  });
  await started.promise;
  interaction.controller.requestCancellation("barge-in-replaced");
  late.resolve({
    summary: "迟到的 Cabin 回复不得公开。",
    telemetry: { model: "late-chat", provider: "test" },
  });
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  const run = ledger.getPreviousRun();
  assert.equal(run.status, "cancelled");
  assert.equal(run.events.filter((event) => event.phase === "final-response").length, 1);
  assert.equal(run.events.some((event) => event.componentType === "model-service"), false);
  assert.equal(JSON.stringify(run.events).includes("迟到的 Cabin"), false);
  assert.equal(memory.read(interaction.turn.sessionId).turns.length, 0);
  interaction.controller.closeSession();
}

async function verifyRagCancellation() {
  const interaction = activeInteraction("ES8 打开尾门前需要确认什么条件？");
  const started = deferred();
  const late = deferred();
  const harness = createLeanRuntimeVehicleKnowledgeHarness({
    manualRetriever(_query, input) {
      assert.strictEqual(input.signal, interaction.turn.signal);
      started.resolve();
      return late.promise;
    },
  });
  const pending = harness.runtime.run("ES8 打开尾门前需要确认什么条件？", {
    requestId: interaction.turn.runId,
    interactionRef: interaction.turn,
    signal: interaction.turn.signal,
  });
  await started.promise;
  interaction.controller.requestCancellation("barge-in-replaced");
  late.resolve([{
    chunkId: "manual:late",
    sourceId: "nio-es8-user-manual-2026",
    title: "ES8 用户手册",
    citation: "迟到证据",
    text: "迟到 RAG 不得进入回复。",
  }]);
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.deepEqual(callNames(harness.calls), ["manual.retrieve"]);
  const run = harness.ledger.getPreviousRun();
  assert.equal(run.status, "cancelled");
  assert.equal(run.events.some((event) => event.phase === "knowledge-answer"), false);
  assert.equal(run.events.some((event) => event.componentType === "model-service"), false);
  assert.equal(JSON.stringify(run.events).includes("迟到 RAG"), false);
  assert.equal(callNames(harness.calls).some((name) => /safety|vehicle|adapter|animation/i.test(name)), false);
  interaction.controller.closeSession();
}

async function verifyCancellationBeforeToolDispatch() {
  const interaction = activeInteraction("把主驾车窗打开一半");
  const harness = createLeanRuntimeVehicleControlHarness({
    onSafetyEvaluated() {
      interaction.controller.requestCancellation("barge-in-replaced");
    },
  });
  await assert.rejects(
    harness.runtime.run("把主驾车窗打开一半", {
      requestId: interaction.turn.runId,
      interactionRef: interaction.turn,
      signal: interaction.turn.signal,
    }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(countCalls(harness.calls, "safety.evaluate"), 1);
  assert.equal(countCalls(harness.calls, "vehicle.execute"), 0);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 0);
  assert.equal(countCalls(harness.calls, "provider.ingestObservation"), 0);
  assert.equal(harness.ledger.getPreviousRun().status, "cancelled");
  interaction.controller.closeSession();
}

async function verifyCoordinatorPreDispatchFailureBoundary() {
  for (const [label, execute] of [
    ["sync-throw", () => { throw new Error("coordinator sync pre-dispatch failure"); }],
    ["async-throw", async () => { throw new Error("coordinator async pre-dispatch failure"); }],
  ]) {
    const requestId = `run:task-8:coordinator-${label}`;
    const sessionId = `session:task-8:coordinator-${label}`;
    const harness = runtimeWithVehicleCoordinator({ execute });
    const result = await harness.runtime.run("把主驾车窗打开一半", {
      requestId,
      sessionId,
    });
    assert.equal(result.toolResult.executionState, "failed", label);
    assert.equal(result.toolResult.ok, false, label);
    assert.equal(result.toolResult.requestId, requestId, label);
    assert.equal(
      result.toolResult.commandId,
      `${requestId}:1:body.window.setPosition`,
      label,
    );
    assert.equal("confirmedSnapshotId" in result.toolResult, false, label);
    const run = harness.ledger.getPreviousRun();
    assert.equal(run.status, "completed", label);
    assert.equal(
      run.events.some((event) => event.phase === "vehicle-execution" && event.status === "processing"),
      false,
      label,
    );
    assert.equal(
      run.events.some((event) => (
        event.component === "vehicleStateProvider" && event.phase === "vehicle-execution"
      )),
      false,
      label,
    );
    const terminal = run.events.find((event) => (
      event.component === "vehicleTool" && event.phase === "vehicle-execution"
    ));
    assert.ok(terminal, `${label} must produce a normalized non-success vehicle terminal`);
    assert.equal(terminal.status, "failed", label);
    assert.equal(terminal.metadata.vehicle.commitmentState, "pre-dispatch", label);
    assert.deepEqual(terminal.metadata.vehicle.cancellation, {
      requested: false,
      physicalUndoClaimed: false,
    }, label);
    assert.equal(harness.runtime.sessionMemory.read(sessionId).turns.length, 0, label);
  }

  const controller = new AbortController();
  const cancelled = runtimeWithVehicleCoordinator({
    execute() {
      controller.abort("cancel-before-coordinator-dispatch");
      throw new Error("coordinator failed while cancellation was active");
    },
  });
  await assert.rejects(
    cancelled.runtime.run("把主驾车窗打开一半", {
      requestId: "run:task-8:coordinator-pre-dispatch-cancelled",
      signal: controller.signal,
    }),
    (error) => error?.name === "AbortError",
  );
  const cancelledRun = cancelled.ledger.getPreviousRun();
  assert.equal(cancelledRun.status, "cancelled");
  assert.equal(
    cancelledRun.events.some((event) => event.phase === "vehicle-execution"),
    false,
  );
}

async function verifyCancellationAfterVehicleDispatch() {
  const interaction = activeInteraction("把主驾车窗打开一半");
  const harness = createLeanRuntimeVehicleControlHarness({
    onAdapterAccepted() {
      interaction.controller.requestCancellation("barge-in-replaced");
    },
  });
  await assert.rejects(
    harness.runtime.run("把主驾车窗打开一半", {
      requestId: interaction.turn.runId,
      interactionRef: interaction.turn,
      signal: interaction.turn.signal,
    }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 1);
  assert.equal(countCalls(harness.calls, "provider.ingestObservation"), 1);
  const run = harness.ledger.getPreviousRun();
  assert.equal(run.status, "cancelled");
  const terminal = run.events.find((event) => (
    event.component === "vehicleTool"
    && event.phase === "vehicle-execution"
    && event.metadata?.vehicle?.commitmentState === "provider-terminal"
  ));
  assert.ok(terminal, "post-dispatch cancellation must retain the Provider terminal event");
  assert.equal(terminal.metadata.vehicle.toolResult.executionState, "observed-succeeded");
  assert.deepEqual(terminal.metadata.vehicle.cancellation, {
    requested: true,
    physicalUndoClaimed: false,
  });
  const providerEvent = run.events.find((event) => (
    event.component === "vehicleStateProvider"
    && event.phase === "vehicle-execution"
  ));
  assert.ok(providerEvent);
  assert.equal(
    terminal.metadata.vehicle.toolResult.confirmedSnapshotId,
    providerEvent.metadata.vehicle.snapshot.id,
  );
  assert.equal(
    terminal.metadata.vehicle.toolResult.commandId,
    `${interaction.turn.runId}:1:body.window.setPosition`,
  );
  const final = run.events.find((event) => event.phase === "final-response");
  assert.equal(final.status, "cancelled");
  assert.equal(terminal.sequence < final.sequence, true);
  assert.equal(run.events.some((event) => event.phase === "final-response" && event.status === "completed"), false);
  assert.deepEqual(
    run.events
      .filter((event) => event.componentType === "model-service")
      .map(({ component, phase, status }) => ({ component, phase, status })),
    [{ component: "vehicleSluModel", phase: "route-decision", status: "completed" }],
    "post-dispatch cancellation keeps the completed Vehicle-SLU parse but launches no later model work",
  );
  interaction.controller.closeSession();
}

async function verifyPostDispatchFailureCancellationFacts() {
  const cases = [
    {
      label: "rejected",
      mutateCoordinatorEnvelope() {
        return Promise.reject(new Error("coordinator rejected after dispatch"));
      },
      expectedExecutionState: "failed",
    },
    {
      label: "thrown",
      mutateCoordinatorEnvelope() {
        throw new Error("coordinator threw after dispatch");
      },
      expectedExecutionState: "failed",
    },
    {
      label: "malformed",
      mutateCoordinatorEnvelope() {
        return {
          commitmentState: "provider-terminal",
          cancellation: { requested: false, physicalUndoClaimed: true },
        };
      },
      expectedExecutionState: "failed",
    },
    {
      label: "forged-cancellation",
      mutateCoordinatorEnvelope(envelope) {
        return {
          ...envelope,
          cancellation: { requested: false, physicalUndoClaimed: true },
        };
      },
      expectedExecutionState: "observed-succeeded",
    },
    {
      label: "timeout",
      vehicleSensorMode: "timeout",
      expectedExecutionState: "timeout",
    },
  ];

  for (const testCase of cases) {
    const controller = new AbortController();
    const requestId = `run:task-8:post-dispatch-${testCase.label}`;
    const sessionId = `session:task-8:post-dispatch-${testCase.label}`;
    const harness = createLeanRuntimeVehicleControlHarness({
      onAdapterAccepted() {
        controller.abort(`cancel-${testCase.label}`);
      },
      ...(testCase.mutateCoordinatorEnvelope
        ? { mutateCoordinatorEnvelope: testCase.mutateCoordinatorEnvelope }
        : {}),
    });
    await assert.rejects(
      harness.runtime.run("把主驾车窗打开一半", {
        requestId,
        sessionId,
        signal: controller.signal,
        ...(testCase.vehicleSensorMode
          ? { vehicleSensorMode: testCase.vehicleSensorMode }
          : {}),
      }),
      (error) => error?.name === "AbortError",
      testCase.label,
    );

    const run = harness.ledger.getPreviousRun();
    assert.equal(run.status, "cancelled", testCase.label);
    const terminal = run.events.find((event) => (
      event.component === "vehicleTool"
      && event.phase === "vehicle-execution"
      && event.status !== "processing"
    ));
    assert.ok(terminal, `${testCase.label} must retain a vehicle terminal fact`);
    assert.equal(terminal.metadata.vehicle.toolResult.executionState, testCase.expectedExecutionState, testCase.label);
    assert.equal(terminal.metadata.vehicle.toolResult.requestId, requestId, testCase.label);
    assert.equal(
      terminal.metadata.vehicle.toolResult.commandId,
      `${requestId}:1:body.window.setPosition`,
      testCase.label,
    );
    assert.deepEqual(terminal.metadata.vehicle.cancellation, {
      requested: true,
      physicalUndoClaimed: false,
    }, testCase.label);
    if (testCase.expectedExecutionState === "observed-succeeded") {
      assert.equal(
        terminal.metadata.vehicle.toolResult.confirmedSnapshotId,
        harness.provider.getSnapshot().id,
        testCase.label,
      );
    } else {
      assert.equal(terminal.metadata.vehicle.toolResult.ok, false, testCase.label);
      assert.equal("confirmedSnapshotId" in terminal.metadata.vehicle.toolResult, false, testCase.label);
    }
    assert.equal(
      run.events.some((event) => event.phase === "final-response" && event.status === "completed"),
      false,
      testCase.label,
    );
    assert.equal(
      run.events.filter((event) => event.phase === "final-response" && event.status === "cancelled").length,
      1,
      testCase.label,
    );
    assert.equal(harness.runtime.sessionMemory.read(sessionId).turns.length, 0, testCase.label);
  }
}

async function verifyListenerAbortPreservesVehicleTerminal() {
  const controller = new AbortController();
  const requestId = "run:task-8:listener-abort";
  const sessionId = "session:task-8:listener-abort";
  const harness = createLeanRuntimeVehicleControlHarness();
  harness.runtime.onEvent((event) => {
    if (event.component === "vehicleTool"
      && event.phase === "vehicle-execution"
      && event.status === "processing"
      && event.metadata?.vehicle?.commitmentState === "dispatching") {
      controller.abort("listener-abort-after-real-dispatch");
    }
  });
  await assert.rejects(
    harness.runtime.run("把主驾车窗打开一半", {
      requestId,
      sessionId,
      signal: controller.signal,
    }),
    (error) => error?.name === "AbortError",
  );

  const run = harness.ledger.getPreviousRun();
  const terminal = run.events.find((event) => (
    event.component === "vehicleTool"
    && event.phase === "vehicle-execution"
    && event.status === "completed"
  ));
  assert.ok(terminal, "listener abort must retain the real Provider terminal");
  assert.equal(terminal.metadata.vehicle.toolResult.executionState, "observed-succeeded");
  assert.equal(terminal.metadata.vehicle.toolResult.confirmedSnapshotId, harness.provider.getSnapshot().id);
  assert.deepEqual(terminal.metadata.vehicle.cancellation, {
    requested: true,
    physicalUndoClaimed: false,
  });
  assert.equal(run.status, "cancelled");
  assert.equal(run.events.some((event) => event.phase === "final-response" && event.status === "completed"), false);
  assert.equal(harness.runtime.sessionMemory.read(sessionId).turns.length, 0);
}

async function verifyBackgroundLateResultIsolation() {
  const runId = "run:task-8:background-cancel";
  const controller = new AbortController();
  const manualStarted = deferred();
  const manualLate = deferred();
  const calls = [];
  const goal = createGoalEnvelope({
    goalId: `goal:${runId}`,
    runId,
    objective: "检索后回答",
    interactionType: "question",
    domain: "manual",
    constraints: [],
    contextRefs: [],
    requiredClarifications: [],
    readyForPlanning: true,
    model: "task-8",
    provider: "test",
    confidenceStrength: "high",
  });
  const plan = createTaskPlan({
    planId: `plan:${runId}`,
    goalId: goal.goalId,
    runId,
    steps: [
      taskStep("manual", "manual.retrieve", [], { query: "ES8" }),
      taskStep("response", "response.synthesize", ["manual"], { facts: {} }),
    ],
    selectedCapabilities: ["manual.retrieve", "response.synthesize"],
    writeActionCount: 0,
    planningSummary: "只读后回答",
    model: "task-8",
    provider: "test",
    status: "ready",
  });
  const coordinator = new BackgroundTaskCoordinator({
    cabin: {
      async formGoal(input) {
        assert.strictEqual(input.signal, controller.signal);
        return { goalEnvelope: goal, telemetry: {} };
      },
      async synthesize() {
        calls.push("cabin.synthesize");
        return { text: "must not run", telemetry: {} };
      },
    },
    orchestrator: {
      async plan(input) {
        assert.strictEqual(input.signal, controller.signal);
        return { taskPlan: plan, validation: { ok: true, plan }, telemetry: {} };
      },
    },
    createExecutionLedger: createTaskPlanExecution,
    async executeCapability(input) {
      assert.strictEqual(input.signal, controller.signal);
      calls.push(input.step.stepId);
      if (input.step.stepId === "manual") {
        manualStarted.resolve();
        return manualLate.promise;
      }
      return { summary: "must not run" };
    },
    now: monotonicClock(),
  });
  const pending = coordinator.run({
    runId,
    rawText: "检索后回答",
    signal: controller.signal,
  });
  await manualStarted.promise;
  controller.abort("barge-in-replaced");
  manualLate.resolve({ evidenceRefs: [{ id: "late", source: "manual", type: "manual" }] });
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.deepEqual(calls, ["manual"]);
  const snapshot = coordinator.getSnapshot(runId);
  assert.equal(snapshot.status, "cancelled");
  assert.deepEqual(snapshot.committedEffects, []);
  assert.deepEqual(snapshot.completedStepIds, []);
  assert.deepEqual(snapshot.activeStepIds, []);
}

function createInteractionHarness() {
  let sequence = 0;
  const ledger = new InteractionSessionLedger();
  const controller = new InteractionSessionController({
    ledger,
    now: monotonicClock(),
    createId: (kind) => `${kind}:task-8:${++sequence}`,
    setTimer: () => 1,
    clearTimer() {},
  });
  return { controller, ledger };
}

function activeInteraction(rawText) {
  const harness = createInteractionHarness();
  harness.controller.wake({ provider: "task-8", simulated: true });
  const turn = harness.controller.submitTurn({
    rawText,
    trigger: "wake-word",
    relation: "new-goal",
  });
  return { ...harness, turn };
}

function runtimeFor({ routeId, signal, useCase, ledger, memory }) {
  return new RuntimeKernel({
    routePolicy: {
      async resolve(rawText, options) {
        assert.strictEqual(options.signal, signal);
        return {
          decision: createRouteDecision({
            disposition: "execute",
            routeId,
            mode: "direct",
            confidence: 1,
            reasonCode: `task-8-${routeId}`,
            semanticSource: "deterministic",
            normalizedIntentRef: null,
            runId: options.runId,
          }),
          parsedCommand: {
            requestId: options.runId,
            rawText,
            intent: "conversation.general",
            slots: {},
          },
          semanticTelemetry: {},
        };
      },
    },
    useCases: { [routeId]: useCase },
    runEventLedger: ledger,
    sessionMemory: memory,
    now: monotonicClock(),
    createRequestId: () => "unexpected-task-8-run",
  });
}

function runtimeWithVehicleCoordinator(vehicleExecutionCoordinator) {
  const now = monotonicClock();
  const snapshot = Object.freeze({
    id: "snapshot:task-8:pre-dispatch-failure",
    simulated: true,
    values: Object.freeze({
      speedKph: 0,
      gear: "P",
      windowAntiPinchAvailable: true,
      rainDetected: false,
    }),
  });
  const vehicleStateProvider = Object.freeze({
    getSnapshot: () => snapshot,
  });
  const useCase = createVehicleControlUseCase({
    async refreshVehicleStateForSafety() {
      return { ok: true, snapshot };
    },
    vehicleStateProvider,
    safetyGateway: {
      async evaluate(parsedCommand) {
        return Object.freeze({
          requestId: parsedCommand.requestId,
          allowed: true,
          action: "allow",
          safeIntent: parsedCommand.intent,
          safeSlots: parsedCommand.slots,
          slotProvenance: parsedCommand.slotProvenance,
          reason: "task-8 pre-dispatch boundary allow",
          alternative: "",
        });
      },
    },
    vehicleExecutionCoordinator,
    now,
  });
  const ledger = new RunEventLedger();
  const memory = new SessionMemory({ now });
  const runtime = new RuntimeKernel({
    routePolicy: {
      async resolve(rawText, options) {
        return {
          decision: createRouteDecision({
            disposition: "execute",
            routeId: "vehicle-control",
            mode: "direct",
            confidence: 1,
            reasonCode: "task-8-pre-dispatch-coordinator-failure",
            semanticSource: "deterministic",
            normalizedIntentRef: "body.window.setPosition",
            runId: options.runId,
          }),
          parsedCommand: Object.freeze({
            requestId: options.runId,
            rawText,
            intent: "body.window.setPosition",
            speechAct: "command",
            actionability: Object.freeze({ actionable: true, reason: "explicit-command" }),
            slots: Object.freeze({ zone: "front_left", percent: 50 }),
            slotProvenance: Object.freeze({ zone: "explicit", percent: "explicit" }),
          }),
          semanticTelemetry: Object.freeze({}),
        };
      },
    },
    useCases: Object.freeze({ "vehicle-control": useCase }),
    runEventLedger: ledger,
    sessionMemory: memory,
    now,
    createRequestId: () => "unexpected-task-8-pre-dispatch-run",
  });
  return { runtime, ledger };
}

function taskStep(stepId, capabilityId, dependsOn, input) {
  return {
    stepId,
    capabilityId,
    dependsOn,
    input,
    expectedOutput: `${stepId}-result`,
    accessMode: "read",
    status: "planned",
  };
}

function monotonicClock() {
  let value = Date.parse("2026-08-05T12:00:00.000Z");
  return () => value++;
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
