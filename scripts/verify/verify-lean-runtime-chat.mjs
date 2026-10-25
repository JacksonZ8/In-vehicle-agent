#!/usr/bin/env node
import assert from "node:assert/strict";
import { RuntimeKernel } from "../../src/application/runtime-kernel.js";
import { RoutePolicy as VehicleSluRoutePolicy, createRouteDecision } from "../../src/application/route-policy.js";
import { createChatUseCase } from "../../src/application/use-cases/chat.js";
import { RunEventLedger } from "../../src/runtime/run-event-ledger.js";
import { RUN_EVENT_PROTOCOL, validateRunEvent } from "../../src/runtime/run-event-protocol.js";
import { SessionMemory } from "../../src/runtime/session-memory.js";
import { createLeanRuntimeRoutePolicy } from "../lib/lean-runtime-test-harness.mjs";

assert.deepEqual(RUN_EVENT_PROTOCOL, { id: "nio-run-event", version: "2.0.0" });

const calls = [];
const chatLedger = new RunEventLedger();
const chatMemory = new SessionMemory({ now: () => Date.parse("2026-08-04T00:10:00.000Z") });
const writeChatMemory = chatMemory.write.bind(chatMemory);
let chatMemoryWriteCount = 0;
chatMemory.write = (sessionId, record) => {
  chatMemoryWriteCount += 1;
  assert.equal(chatLedger.getCurrentRun(), null, "memory writes only after the active Run closes");
  assert.equal(chatLedger.getPreviousRun()?.status, "completed");
  return writeChatMemory(sessionId, record);
};
const chatUseCase = createChatUseCase({
  cloudAdapter: {
    async converse(rawText, parsedCommand, memoryOptions, runtimeOptions) {
      calls.push("cloud.converse");
      assert.equal(rawText, "你好，陪我聊聊");
      assert.equal(parsedCommand.intent, "conversation.general");
      assert.deepEqual(memoryOptions.memoryHint, {
        type: "ConversationMemoryHint",
        policy: chatMemory.buildConversationHint("session:1").hint.policy,
        sessionId: "session:1",
        executable: false,
        neverExecutableFacts: chatMemory.buildConversationHint("session:1").hint.neverExecutableFacts,
        purpose: "conversation-topic-continuity-only",
        turns: [],
      });
      assert.equal(runtimeOptions.signal, undefined);
      assert.equal(runtimeOptions.deadlineAt, 12345);
      return {
        summary: "当然可以，我们聊聊今天让你开心的事吧。",
        telemetry: { provider: "fake-cloud", model: "fake-chat", degraded: false },
      };
    },
  },
});
const chatKernel = new RuntimeKernel({
  routePolicy: new RoutePolicy(),
  useCases: Object.freeze({ chat: chatUseCase }),
  runEventLedger: chatLedger,
  sessionMemory: chatMemory,
  now: createClock("2026-08-04T00:00:00.000Z"),
  createRequestId: () => "unexpected-generated-id",
});
const listenerEvents = [];
const unsubscribe = chatKernel.onEvent((event) => listenerEvents.push(event));
const result = await chatKernel.run("你好，陪我聊聊", {
  requestId: "run:chat",
  interactionRef: { sessionId: "session:1", turnId: "turn:1" },
  deadlineAt: 12345,
});
unsubscribe();

assert.equal(result.requestId, "run:chat");
assert.equal(result.rawText, "你好，陪我聊聊");
assert.deepEqual(result.interactionRef, { sessionId: "session:1", turnId: "turn:1" });
assert.equal(result.routeDecision.routeId, "chat");
assert.equal(result.routeDecision.mode, "direct");
assert.equal(result.parsedCommand.rawText, "", "Vehicle-SLU projection carries no raw-text authority");
assert.equal(result.assistantResponse, "当然可以，我们聊聊今天让你开心的事吧。");
assert.equal(result.voiceBridgeEligibility.allowed, true);
assert.equal(result.voiceBridgeEligibility.reason, "ordinary-general-conversation");
assert.equal(result.safetyDecision, null);
assert.equal(result.toolCall, null);
assert.equal(result.toolResult, null);
assert.equal(result.vehicleStateSnapshot, null);
assert.equal(result.manualQueryPlan, null);
assert.equal(result.manualEvidence, null);
assert.equal(result.runtimeTelemetry.modelCallCount, 2);
assert.equal(result.runtimeTelemetry.degraded, false);
assert.equal(calls.filter((entry) => entry === "cloud.converse").length, 1);
assert.equal(calls.some((entry) => /orchestrator|manual|safety|tool|provider/i.test(entry)), false);
assert.deepEqual(result.events.map((event) => event.phase), [
  "intake", "route-decision", "voice-bridge-eligibility", "chat-response", "final-response",
]);
assert.deepEqual(
  result.events.filter((event) => event.componentType === "model-service").map((event) => event.component),
  ["vehicleSluModel", "cabinModel"],
  "Vehicle-SLU Runtime emits the sole semantic parse and Cabin conversation calls",
);
assert.equal(result.events.filter((event) => event.component === "cabinAssistant").length >= 1, true);
const chatModelEvent = result.events.find((event) => event.component === "cabinModel");
const chatAnswerEvent = result.events.find((event) => (
  event.component === "cabinAssistant" && event.phase === "final-response"
));
assert.ok(chatModelEvent.sequence < chatAnswerEvent.sequence, "Cabin model telemetry must precede the Cabin answer event");
assert.equal(result.events.filter((event) => event.component === "cabinModel").length, 1);
assert.deepEqual(result.events, listenerEvents);
assert.equal(result.events.every((event) => validateRunEvent(event).length === 0), true);
assert.equal(Object.isFrozen(result), true);
assert.equal(Object.isFrozen(result.events), true);
assert.equal(chatLedger.getCurrentRun(), null);
assert.equal(chatLedger.getPreviousRun().status, "completed");
assert.deepEqual(chatLedger.getPreviousRun().events, result.events);
assert.equal(chatMemoryWriteCount, 1);
assert.deepEqual(chatMemory.read("session:1").turns.map((turn) => ({
  turnId: turn.turnId,
  user: turn.user.text,
  assistant: turn.assistant.text,
})), [{
  turnId: "turn:1",
  user: "你好，陪我聊聊",
  assistant: "当然可以，我们聊聊今天让你开心的事吧。",
}]);

const optionsSessionId = "session:options-only";
const optionsSessionMemory = new SessionMemory({ now: () => Date.parse("2026-08-04T00:20:00.000Z") });
optionsSessionMemory.write(optionsSessionId, {
  turnId: "turn:seed",
  intent: "conversation.general",
  needsClarification: false,
  hasManualEvidence: false,
  requiresExternalData: false,
  userText: "刚才我们聊到旅行。",
  assistantText: "是的，我们正在聊旅行。",
});
const optionsSessionKernel = new RuntimeKernel({
  routePolicy: new RoutePolicy(),
  useCases: {
    chat: createChatUseCase({
      cloudAdapter: {
        async converse(_rawText, _parsedCommand, memoryOptions) {
          assert.equal(memoryOptions.memoryHint.sessionId, optionsSessionId);
          assert.deepEqual(
            memoryOptions.memoryHint.turns.map((turn) => turn.sourceTurnId),
            ["turn:seed"],
          );
          return {
            summary: "好，我们继续聊旅行。",
            telemetry: { provider: "fake-cloud", model: "fake-chat", degraded: false },
          };
        },
      },
    }),
  },
  runEventLedger: new RunEventLedger(),
  sessionMemory: optionsSessionMemory,
  now: createClock("2026-08-04T00:30:00.000Z"),
  createRequestId: () => "unexpected-options-session-id",
});
await optionsSessionKernel.run("你好，继续聊旅行", {
  requestId: "run:options-session",
  sessionId: optionsSessionId,
});
assert.deepEqual(
  optionsSessionMemory.read(optionsSessionId).turns.map((turn) => turn.turnId),
  ["turn:seed", "run:options-session"],
  "options.sessionId must be the common memory read/write target",
);
assert.equal(
  optionsSessionMemory.read("default-browser-session").turns.length,
  0,
  "options.sessionId runs must not leak memory into the default session",
);

const dependencyConfig = {
  routePolicy: new RoutePolicy(),
  useCases: { chat: simpleChatUseCase() },
  runEventLedger: new RunEventLedger(),
  sessionMemory: new SessionMemory(),
};
assert.throws(
  () => new RuntimeKernel({ ...dependencyConfig, runEventLedger: { append() {} } }),
  /getCurrentRun.*completeRun.*terminateRun/i,
);
assert.throws(() => new RuntimeKernel({ ...dependencyConfig, now: 42 }), /now must be a function/i);
assert.throws(
  () => new RuntimeKernel({ ...dependencyConfig, createRequestId: "invalid" }),
  /createRequestId must be a function/i,
);

const completionObserverLedger = new RunEventLedger();
completionObserverLedger.subscribe((snapshot) => {
  if (snapshot.status === "completed") throw new Error("completion-observer-failure");
});
const completionObserverMemory = new SessionMemory();
const completionObserverResult = await new RuntimeKernel({
  routePolicy: new RoutePolicy(),
  useCases: { chat: simpleChatUseCase("completion observer survived") },
  runEventLedger: completionObserverLedger,
  sessionMemory: completionObserverMemory,
  now: createClock("2026-08-04T00:40:00.000Z"),
  createRequestId: () => "run:completion-observer",
}).run("你好，继续聊", { sessionId: "session:completion-observer" });
assert.equal(completionObserverResult.assistantResponse, "completion observer survived");
assert.equal(completionObserverLedger.getCurrentRun(), null);
assert.equal(completionObserverLedger.getPreviousRun().status, "completed");
assert.equal(completionObserverMemory.read("session:completion-observer").turns.length, 1);

const memoryCacheFailureLedger = new RunEventLedger();
let memoryCacheWriteCount = 0;
const memoryCacheFailureResult = await new RuntimeKernel({
  routePolicy: new RoutePolicy(),
  useCases: { chat: simpleChatUseCase("cache failure survived") },
  runEventLedger: memoryCacheFailureLedger,
  sessionMemory: {
    buildConversationHint() { return { hint: null }; },
    write() {
      memoryCacheWriteCount += 1;
      throw new Error("memory-cache-failure");
    },
  },
  now: createClock("2026-08-04T00:50:00.000Z"),
  createRequestId: () => "run:memory-cache-failure",
}).run("你好，继续聊");
assert.equal(memoryCacheFailureResult.assistantResponse, "cache failure survived");
assert.equal(memoryCacheWriteCount, 1);
assert.equal(memoryCacheFailureLedger.getCurrentRun(), null);
assert.equal(memoryCacheFailureLedger.getPreviousRun().status, "completed");

const terminalObserverLedger = new RunEventLedger();
terminalObserverLedger.subscribe((snapshot) => {
  if (snapshot.status === "cancelled") throw new Error("cancel-observer-failure");
});
const terminalObserverResult = await new RuntimeKernel({
  routePolicy: terminalCancelPolicy(),
  useCases: {},
  runEventLedger: terminalObserverLedger,
  sessionMemory: new SessionMemory(),
  now: createClock("2026-08-04T00:55:00.000Z"),
  createRequestId: () => "run:cancel-observer",
}).run("取消");
assert.equal(terminalObserverResult.routeDecision.disposition, "cancel");
assert.equal(terminalObserverLedger.getCurrentRun(), null);
assert.equal(terminalObserverLedger.getPreviousRun().status, "cancelled");

const routeFailure = new Error("route-resolution-failure");
const routeFailureLedger = new RunEventLedger();
await assert.rejects(
  new RuntimeKernel({
    routePolicy: { async resolve() { throw routeFailure; } },
    useCases: {},
    runEventLedger: routeFailureLedger,
    sessionMemory: new SessionMemory(),
    now: createClock("2026-08-04T00:56:00.000Z"),
    createRequestId: () => "run:route-failure",
  }).run("你好"),
  (error) => error === routeFailure,
);
assert.equal(routeFailureLedger.getCurrentRun(), null);
assert.equal(routeFailureLedger.getPreviousRun().status, "failed");

const useCaseFailure = new Error("use-case-failure");
const useCaseFailureLedger = new RunEventLedger();
await assert.rejects(
  new RuntimeKernel({
    routePolicy: new RoutePolicy(),
    useCases: { chat: { async execute() { throw useCaseFailure; } } },
    runEventLedger: useCaseFailureLedger,
    sessionMemory: new SessionMemory(),
    now: createClock("2026-08-04T00:57:00.000Z"),
    createRequestId: () => "run:use-case-failure",
  }).run("你好，继续聊"),
  (error) => error === useCaseFailure,
);
assert.equal(useCaseFailureLedger.getCurrentRun(), null);
assert.equal(useCaseFailureLedger.getPreviousRun().status, "failed");

const appendObserverFailure = new Error("append-observer-failure");
const appendObserverLedger = new RunEventLedger();
appendObserverLedger.subscribe((snapshot) => {
  if (snapshot.status === "active") throw appendObserverFailure;
});
await assert.rejects(
  new RuntimeKernel({
    routePolicy: new RoutePolicy(),
    useCases: { chat: simpleChatUseCase() },
    runEventLedger: appendObserverLedger,
    sessionMemory: new SessionMemory(),
    now: createClock("2026-08-04T00:58:00.000Z"),
    createRequestId: () => "run:append-observer-failure",
  }).run("你好，继续聊"),
  (error) => error === appendObserverFailure,
);
assert.equal(appendObserverLedger.getCurrentRun(), null);
assert.equal(appendObserverLedger.getPreviousRun().status, "failed");

const terminateObserverFailure = new Error("terminate-observer-failure");
const terminateObserverLedger = new RunEventLedger();
terminateObserverLedger.subscribe((snapshot) => {
  if (snapshot.status === "failed") throw terminateObserverFailure;
});
await assert.rejects(
  new RuntimeKernel({
    routePolicy: { async resolve() { throw routeFailure; } },
    useCases: {},
    runEventLedger: terminateObserverLedger,
    sessionMemory: new SessionMemory(),
    now: createClock("2026-08-04T00:59:00.000Z"),
    createRequestId: () => "run:terminate-observer-failure",
  }).run("你好"),
  (error) => error === routeFailure,
);
assert.equal(terminateObserverLedger.getCurrentRun(), null);
assert.equal(terminateObserverLedger.getPreviousRun().status, "failed");

const stuckLedgerDelegate = new RunEventLedger();
let stuckCleanupAttempts = 0;
const stuckLedger = {
  append(event) { return stuckLedgerDelegate.append(event); },
  getCurrentRun() { return stuckLedgerDelegate.getCurrentRun(); },
  completeRun() { throw new Error("complete-finalization-failure"); },
  terminateRun() {
    stuckCleanupAttempts += 1;
    throw new Error("cleanup-finalization-failure");
  },
};
await assert.rejects(
  new RuntimeKernel({
    routePolicy: new RoutePolicy(),
    useCases: { chat: simpleChatUseCase() },
    runEventLedger: stuckLedger,
    sessionMemory: new SessionMemory(),
    now: createClock("2026-08-04T00:59:30.000Z"),
    createRequestId: () => "run:stuck-finalization",
  }).run("你好，继续聊"),
  /complete-finalization-failure/,
);
assert.equal(stuckCleanupAttempts, 1, "active Run cleanup is attempted once");
assert.equal(stuckLedger.getCurrentRun().status, "active", "unrecoverable finalization remains visible");

const stuckErrorDelegate = new RunEventLedger();
let stuckErrorTerminateAttempts = 0;
const stuckPrimaryError = new Error("stuck-primary-route-failure");
const stuckErrorLedger = {
  append(event) { return stuckErrorDelegate.append(event); },
  getCurrentRun() { return stuckErrorDelegate.getCurrentRun(); },
  completeRun(runId) { return stuckErrorDelegate.completeRun(runId); },
  terminateRun() {
    stuckErrorTerminateAttempts += 1;
    throw new Error("stuck-error-finalization-failure");
  },
};
await assert.rejects(
  new RuntimeKernel({
    routePolicy: { async resolve() { throw stuckPrimaryError; } },
    useCases: {},
    runEventLedger: stuckErrorLedger,
    sessionMemory: new SessionMemory(),
    now: createClock("2026-08-04T00:59:35.000Z"),
    createRequestId: () => "run:stuck-error-finalization",
  }).run("你好"),
  (error) => error === stuckPrimaryError
    && /stuck-error-finalization-failure/.test(error.finalizationError?.message),
);
assert.equal(stuckErrorTerminateAttempts, 2, "one terminate plus one bounded cleanup attempt");
assert.equal(stuckErrorLedger.getCurrentRun().status, "active");

for (const [routeId, rawText, fragment] of [
  ["vehicle-knowledge", "ES8 打开尾门前需要确认什么条件？", {
    assistantResponse: "车辆知识回答",
    manualEvidence: { citations: ["manual:tailgate"] },
  }],
  ["vehicle-control", "把主驾车窗打开一半", { assistantResponse: "车辆控制回答" }],
  ["task", "明天上海天气怎么样？", { assistantResponse: "任务回答" }],
]) {
  const memory = createTrackingMemory();
  const ledger = new RunEventLedger();
  const routeResult = await new RuntimeKernel({
    routePolicy: new RoutePolicy(),
    useCases: {
      [routeId]: {
        async execute(context) {
          assert.equal(context.memoryHint, null, `${routeId} must not receive ConversationMemoryHint`);
          return Object.freeze({ ...fragment, modelCalls: Object.freeze([]) });
        },
      },
    },
    runEventLedger: ledger,
    sessionMemory: memory,
    now: createClock("2026-08-04T00:59:40.000Z"),
    createRequestId: () => `run:memory-isolation:${routeId}`,
  }).run(rawText, { sessionId: `session:memory-isolation:${routeId}` });
  assert.equal(routeResult.routeDecision.routeId, routeId);
  assert.deepEqual(memory.calls, { build: 0, write: 0 }, `${routeId} memory isolation`);
  assert.equal(ledger.getPreviousRun().status, "completed");
}

for (const [id, routePolicy, rawText, expectedStatus] of [
  ["clarify", new RoutePolicy(), "把座椅调一下", "completed"],
  ["cancel", terminalCancelPolicy(), "取消", "cancelled"],
]) {
  const memory = createTrackingMemory();
  const ledger = new RunEventLedger();
  const terminalResult = await new RuntimeKernel({
    routePolicy,
    useCases: {},
    runEventLedger: ledger,
    sessionMemory: memory,
    now: createClock("2026-08-04T00:59:50.000Z"),
    createRequestId: () => `run:terminal-memory-isolation:${id}`,
  }).run(rawText, { sessionId: `session:terminal-memory-isolation:${id}` });
  assert.equal(terminalResult.routeDecision.disposition, id);
  assert.deepEqual(memory.calls, { build: 0, write: 0 }, `${id} terminal memory isolation`);
  assert.equal(ledger.getPreviousRun().status, expectedStatus);
}

const semanticClarify = createSemanticPolicyHarness({
  slots: { topic: "general_qa", responseMode: "voice_text", requiresExternalData: false },
});
const semanticClarifyLedger = new RunEventLedger();
const semanticClarifyResult = await new RuntimeKernel({
  routePolicy: semanticClarify.policy,
  useCases: {},
  runEventLedger: semanticClarifyLedger,
  sessionMemory: createTrackingMemory(),
  now: createClock("2026-08-04T00:59:55.000Z"),
  createRequestId: () => "run:semantic-clarify",
}).run("帮我处理一下");
assert.equal(semanticClarify.calls.length, 1);
assert.equal(semanticClarifyResult.routeDecision.disposition, "clarify");
assert.deepEqual(
  semanticClarifyResult.events.filter((event) => event.componentType === "model-service").map((event) => event.component),
  ["vehicleSluModel"],
);
assert.equal(semanticClarifyResult.runtimeTelemetry.modelCallCount, 1);
assert.deepEqual(
  semanticClarifyResult.runtimeTelemetry.modelCalls.map((call) => call.phase),
  ["route-decision"],
);
assert.deepEqual(
  semanticClarifyResult.runtimeTelemetry.modelCalls[0].telemetry,
  semanticClarify.telemetry,
);
assert.equal(semanticClarifyLedger.getPreviousRun().status, "completed");

const semanticExecute = createSemanticPolicyHarness({
  slots: {
    topic: "weather_query",
    responseMode: "voice_text",
    requiresExternalData: true,
    externalDataType: "weather",
    location: "上海",
  },
});
let semanticTaskExecutions = 0;
let semanticTaskModelCalls = 0;
const semanticExecuteLedger = new RunEventLedger();
const semanticExecuteResult = await new RuntimeKernel({
  routePolicy: semanticExecute.policy,
  useCases: {
    task: {
      async execute(context) {
        semanticTaskExecutions += 1;
        assert.equal(context.memoryHint, null);
        semanticTaskModelCalls += 1;
        return Object.freeze({
          assistantResponse: "语义路由任务回答",
          modelCalls: Object.freeze([Object.freeze({
            phase: "final-synthesis",
            telemetry: Object.freeze({ provider: "fake-cloud", model: "fake-task" }),
          })]),
        });
      },
    },
  },
  runEventLedger: semanticExecuteLedger,
  sessionMemory: createTrackingMemory(),
  now: createClock("2026-08-04T00:59:56.000Z"),
  createRequestId: () => "run:semantic-execute",
}).run("帮我处理一下");
assert.equal(semanticExecute.calls.length, 1);
assert.equal(semanticTaskExecutions, 1);
assert.equal(semanticTaskModelCalls, 1);
assert.deepEqual(
  [semanticExecuteResult.routeDecision.disposition, semanticExecuteResult.routeDecision.routeId],
  ["execute", "task"],
);
assert.deepEqual(
  semanticExecuteResult.events.filter((event) => event.componentType === "model-service").map((event) => event.component),
  ["vehicleSluModel", "cabinModel"],
);
assert.equal(semanticExecuteResult.runtimeTelemetry.modelCallCount, 2);
assert.deepEqual(
  semanticExecuteResult.runtimeTelemetry.modelCalls.map((call) => call.phase),
  ["route-decision", "final-synthesis"],
);
assert.equal(
  semanticExecuteResult.runtimeTelemetry.modelCallCount,
  semanticExecute.calls.length + semanticTaskModelCalls,
);
assert.equal(
  semanticExecuteResult.runtimeTelemetry.modelCallCount,
  semanticExecuteResult.events.filter((event) => event.componentType === "model-service").length,
);
assert.equal(semanticExecuteLedger.getPreviousRun().status, "completed");

const terminalCalls = [];
const clarificationLedger = new RunEventLedger();
const clarificationKernel = new RuntimeKernel({
  routePolicy: new RoutePolicy(),
  useCases: rejectingUseCases(terminalCalls),
  runEventLedger: clarificationLedger,
  sessionMemory: new SessionMemory(),
  now: createClock("2026-08-04T01:00:00.000Z"),
  createRequestId: () => "run:clarify",
});
const clarification = await clarificationKernel.run("把座椅调一下", {
  interactionRef: { sessionId: "session:terminal", turnId: "turn:clarify" },
});
assert.deepEqual([
  clarification.routeDecision.disposition,
  clarification.routeDecision.routeId,
  clarification.routeDecision.mode,
], ["clarify", null, null]);
assert.equal(clarification.assistantResponse, "请告诉我要调节哪个座椅，以及目标靠背角度。");
assert.equal(clarification.runtimeTelemetry.modelCallCount, 1);
assert.deepEqual(terminalCalls, []);
assert.equal(clarificationLedger.getPreviousRun().status, "completed");

const terminalCancelLedger = new RunEventLedger();
const terminalCancelKernel = new RuntimeKernel({
  routePolicy: terminalCancelPolicy(),
  useCases: rejectingUseCases(terminalCalls),
  runEventLedger: terminalCancelLedger,
  sessionMemory: new SessionMemory(),
  now: createClock("2026-08-04T02:00:00.000Z"),
  createRequestId: () => "run:terminal-cancel",
});
const terminalCancel = await terminalCancelKernel.run("取消", {
  interactionRef: { sessionId: "session:terminal", turnId: "turn:cancel" },
});
assert.deepEqual([
  terminalCancel.routeDecision.disposition,
  terminalCancel.routeDecision.routeId,
  terminalCancel.routeDecision.mode,
], ["cancel", null, null]);
assert.equal(terminalCancel.assistantResponse, "已取消。");
assert.deepEqual(terminalCalls, []);
assert.equal(terminalCancelLedger.getCurrentRun(), null);
assert.equal(terminalCancelLedger.getPreviousRun().status, "cancelled");

const listenerFailureLedger = new RunEventLedger();
const listenerFailureKernel = new RuntimeKernel({
  routePolicy: new RoutePolicy(),
  useCases: { chat: chatUseCase },
  runEventLedger: listenerFailureLedger,
  sessionMemory: new SessionMemory(),
  now: createClock("2026-08-04T02:30:00.000Z"),
  createRequestId: () => "run:listener-failure",
});
listenerFailureKernel.onEvent(() => {
  throw new Error("listener-failure");
});
await assert.rejects(
  listenerFailureKernel.run("你好，陪我聊聊"),
  /listener-failure/,
);
assert.equal(listenerFailureLedger.getCurrentRun(), null);
assert.equal(listenerFailureLedger.getPreviousRun().status, "failed");

const abortController = new AbortController();
const late = deferred();
const conversationStarted = deferred();
const cancellationLedger = new RunEventLedger();
const cancellationMemory = new SessionMemory();
const cancellationCalls = [];
const cancellationKernel = new RuntimeKernel({
  routePolicy: new RoutePolicy(),
  useCases: {
    chat: createChatUseCase({
      cloudAdapter: {
        async converse() {
          cancellationCalls.push("cloud.converse");
          conversationStarted.resolve();
          return late.promise;
        },
      },
    }),
  },
  runEventLedger: cancellationLedger,
  sessionMemory: cancellationMemory,
  now: createClock("2026-08-04T03:00:00.000Z"),
  createRequestId: () => "unexpected-cancellation-id",
});
const cancelledRun = cancellationKernel.run("你好，陪我聊聊", {
  requestId: "run:cancelled-chat",
  interactionRef: { sessionId: "session:cancelled", turnId: "turn:cancelled" },
  signal: abortController.signal,
});
await conversationStarted.promise;
abortController.abort("user-cancelled");
late.resolve({
  summary: "这个迟到的模型结果绝不能公开或写入记忆。",
  telemetry: { provider: "fake-cloud", model: "late-model" },
});
await assert.rejects(cancelledRun, (error) => error?.name === "AbortError");
assert.deepEqual(cancellationCalls, ["cloud.converse"]);
assert.equal(cancellationLedger.getCurrentRun(), null);
assert.equal(cancellationLedger.getPreviousRun().status, "cancelled");
assert.equal(
  cancellationLedger.getPreviousRun().events.some((event) => event.summary?.includes("迟到")),
  false,
);
assert.equal(cancellationMemory.read("session:cancelled").turns.length, 0);

console.log("lean runtime chat verification passed");

function createClock(start) {
  let value = Date.parse(start);
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

function simpleChatUseCase(summary = "simple chat response") {
  return createChatUseCase({
    cloudAdapter: {
      async converse() {
        return {
          summary,
          telemetry: { provider: "fake-cloud", model: "fake-chat", degraded: false },
        };
      },
    },
  });
}

function createTrackingMemory() {
  const calls = { build: 0, write: 0 };
  return {
    calls,
    buildConversationHint() {
      calls.build += 1;
      return { hint: Object.freeze({ sessionId: "forbidden-memory-hint", turns: Object.freeze([]) }) };
    },
    write() {
      calls.write += 1;
      return null;
    },
  };
}

function createSemanticPolicyHarness({ slots }) {
  const calls = [];
  const telemetry = Object.freeze({ provider: "fake-local", model: "fake-semantic", degraded: false });
  return {
    calls,
    telemetry,
    policy: new RoutePolicy({
      localModel: {
        async parse(rawText, options) {
          calls.push({ rawText, options });
          return {
            semanticEnvelope: Object.freeze({
              contractVersion: "nio-vehicle-slu-contract@2.0.0",
              requestId: options.requestId,
              domain: "vehicle",
              conversationGoal: Object.freeze({ summary: rawText, need: "none" }),
              vehicleFrames: Object.freeze(slots.externalDataType === "weather"
                ? [Object.freeze({
                    frameId: `frame:${options.requestId}:weather`,
                    capability: "weather",
                    intent: "weather.query",
                    speechAct: "question",
                    knowledgeNeed: "none",
                    actionNeed: "none",
                    slots: Object.freeze({ location: slots.location }),
                    missingSlots: Object.freeze([]),
                    clarificationQuestion: null,
                    standaloneQuery: null,
                    confidence: 0.7,
                  })]
                : [Object.freeze({
                    frameId: `frame:${options.requestId}:window`,
                    capability: "control",
                    intent: "body.window.setPosition",
                    speechAct: "command",
                    knowledgeNeed: "none",
                    actionNeed: "clarify",
                    slots: Object.freeze({ zone: "front_right" }),
                    missingSlots: Object.freeze(["percent"]),
                    clarificationQuestion: "请告诉我车窗需要调到多少。",
                    standaloneQuery: null,
                    confidence: 0.7,
                  })]),
              domainConfidence: 0.7,
            }),
            telemetry,
          };
        },
      },
    }),
  };
}

function RoutePolicy(options) {
  return options ? new VehicleSluRoutePolicy(options) : createLeanRuntimeRoutePolicy();
}

function rejectingUseCases(callsList) {
  return new Proxy({}, {
    get(_target, property) {
      return {
        async execute() {
          callsList.push(String(property));
          throw new Error("terminal routes must not execute a use case");
        },
      };
    },
  });
}

function terminalCancelPolicy() {
  return {
    async resolve(_rawText, options) {
      return {
        decision: createRouteDecision({
          disposition: "cancel",
          routeId: null,
          mode: null,
          confidence: 1,
          reasonCode: "explicit-user-cancellation",
          semanticSource: "deterministic",
          normalizedIntentRef: { requestId: options.requestId, intent: "conversation.general" },
          runId: options.runId,
        }),
        parsedCommand: Object.freeze({
          requestId: options.requestId,
          rawText: "取消",
          intent: "conversation.general",
          slots: Object.freeze({}),
        }),
        semanticTelemetry: Object.freeze({ source: "deterministic" }),
      };
    },
  };
}
