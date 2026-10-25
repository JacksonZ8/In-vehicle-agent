import assert from "node:assert/strict";
import { RuntimeKernel } from "../../src/application/runtime-kernel.js";
import { createRouteDecision } from "../../src/application/route-policy.js";
import { createChatUseCase } from "../../src/application/use-cases/chat.js";
import { createVehicleControlUseCase } from "../../src/application/use-cases/vehicle-control.js";
import { CloudLLMAdapter } from "../../src/runtime/cloud-llm-adapter.js";
import { RunEventLedger } from "../../src/runtime/run-event-ledger.js";
import { RUN_EVENT_PROTOCOL } from "../../src/runtime/run-event-protocol.js";
import { SessionMemory } from "../../src/runtime/session-memory.js";
import { SafetyGateway } from "../../src/safety/safety-gateway.js";
import { DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";
import { createLeanRuntimeRoutePolicy } from "../lib/lean-runtime-test-harness.mjs";

assert.deepEqual(RUN_EVENT_PROTOCOL, { id: "nio-run-event", version: "2.0.0" });

let now = Date.parse("2026-07-20T00:00:00.000Z");
const memory = new SessionMemory({ now: () => now });
for (let index = 1; index <= 7; index += 1) {
  memory.write("cap", {
    turnId: `turn-${index}`,
    intent: "conversation.general",
    userText: `问题 ${index}`,
    assistantText: `回答 ${index}`,
  });
}
assert.deepEqual(
  memory.read("cap").turns.map((turn) => turn.turnId),
  ["turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7"],
);
assert.equal(memory.read("other").turns.length, 0, "sessions must stay isolated");
memory.write("ttl", {
  turnId: "ttl-1",
  intent: "conversation.general",
  userText: "问题",
  assistantText: "回答",
});
now += 30 * 60 * 1000;
assert.equal(memory.read("ttl").turns.length, 0, "expired turns must be pruned");
memory.clear("cap");
assert.equal(memory.read("cap").turns.length, 0, "clear must remove the current session only");
assert.equal(memory.read("other").turns.length, 0);

const sessionId = "session:memory-hint";
const runtimeMemory = new SessionMemory({ now: () => now });
runtimeMemory.write(sessionId, {
  turnId: "turn:seed",
  intent: "conversation.general",
  userText: "先讲讲露营准备",
  assistantText: "回答：先讲讲露营准备",
});
let promptResponse = null;
let receivedMemoryHint = null;
const concreteCloud = new CloudLLMAdapter();
const chatRuntime = new RuntimeKernel({
  routePolicy: createLeanRuntimeRoutePolicy(),
  useCases: {
    chat: createChatUseCase({
      cloudAdapter: {
        async converse(rawText, parsedCommand, context, options) {
          receivedMemoryHint = context.memoryHint;
          promptResponse = await concreteCloud.converse(rawText, parsedCommand, context, options);
          return promptResponse;
        },
      },
    }),
  },
  runEventLedger: new RunEventLedger(),
  sessionMemory: runtimeMemory,
  now: createClock(now),
  createRequestId: () => "unexpected-memory-request",
});
const followup = await chatRuntime.run("你好，继续说", {
  requestId: "run:session-memory-followup",
  sessionId,
});
assert.equal(receivedMemoryHint.turns.length, 1, "follow-up must receive its prior turn");
assert.equal(receivedMemoryHint.turns[0].user.text, "先讲讲露营准备");
assert.equal(receivedMemoryHint.type, "ConversationMemoryHint");
assert.equal(receivedMemoryHint.executable, false);
assert.ok(receivedMemoryHint.neverExecutableFacts.includes("vehicle-control-slots"));
assert.equal(receivedMemoryHint.turns[0].executable, false);
assert.equal(receivedMemoryHint.turns[0].provenance, "runtime-result-open-conversation");
assert.ok(receivedMemoryHint.turns[0].expiresAt);
assert.equal(
  countOccurrences(promptResponse.prompt, '"type":"ConversationMemoryHint"'),
  1,
  "prompt must inject ConversationMemoryHint exactly once",
);
assert.equal(
  countOccurrences(promptResponse.prompt, '"sourceTurnId":"turn:seed"'),
  1,
  "prompt must not repeat memory turns through generic context serialization",
);
assert.equal(promptResponse.prompt.includes('"memoryHint"'), true);
assert.equal(promptResponse.prompt.includes("先讲讲露营准备"), true, "the model input receives the one allowed hint");
assert.equal(
  JSON.stringify(followup.events).includes("先讲讲露营准备"),
  false,
  "Run Event audit must not retain raw remembered user text",
);
assert.equal(
  JSON.stringify(followup.events).includes("回答：先讲讲露营准备"),
  false,
  "Run Event audit must not retain raw remembered assistant text",
);
assert.equal(
  followup.events.some((event) => Object.hasOwn(event.metadata, "memoryHint")
    || Object.hasOwn(event.metadata, "memoryContext")),
  false,
  "Run Event metadata must not retain the full memory hint",
);

const memoryRead = runtimeMemory.buildConversationHint(sessionId);
assert.equal(memoryRead.telemetry.synchronous, true);
assert.equal(memoryRead.telemetry.io, "none");
assert.equal(memoryRead.telemetry.modelCalls, 0);
assert.equal(memoryRead.telemetry.vectorRetrievals, 0);
assert.equal(memoryRead.telemetry.turnCount, 2);
assert.equal(Object.hasOwn(memoryRead.telemetry, "turns"), false);
assert.equal(JSON.stringify(memoryRead.telemetry).includes("先讲讲露营准备"), false);
assert.equal(JSON.stringify(memoryRead.telemetry).includes("回答：先讲讲露营准备"), false);
assert.ok(memoryRead.telemetry.durationMs < 50, "memory hint construction must remain synchronously bounded");

await verifyRememberedVehicleSlotsCannotAuthorizeControl();

console.log("session memory verification passed");

async function verifyRememberedVehicleSlotsCannotAuthorizeControl() {
  const controlNowMs = Date.parse("2026-08-04T13:00:00.000Z");
  const controlMemory = new SessionMemory({ now: () => controlNowMs });
  let memoryHintBuilds = 0;
  const originalBuildHint = controlMemory.buildConversationHint.bind(controlMemory);
  controlMemory.buildConversationHint = (id) => {
    memoryHintBuilds += 1;
    return originalBuildHint(id);
  };

  const values = {
    speedKph: 0,
    gear: "P",
    rearClearance: true,
    windowAntiPinchAvailable: true,
  };
  const provider = new DevVehicleStateProvider(values);
  provider.ingestDemoSensorState({
    source: "demo-sensor-simulator",
    simulated: true,
    capturedAt: new Date(controlNowMs).toISOString(),
    values,
  });
  const safetyGateway = new SafetyGateway({}, { now: () => controlNowMs });
  let executionCalls = 0;
  const controlUseCase = createVehicleControlUseCase({
    async refreshVehicleStateForSafety() {
      return { ok: true, snapshot: provider.getSnapshot() };
    },
    vehicleStateProvider: provider,
    safetyGateway,
    vehicleExecutionCoordinator: {
      async execute() {
        executionCalls += 1;
        throw new Error("memory-sourced control must never reach vehicle execution");
      },
    },
    now: () => controlNowMs,
  });

  const routePolicy = {
    async resolve(rawText, options = {}) {
      const chat = rawText.startsWith("记住");
      const parsedCommand = chat
        ? conversationCommand(rawText, options.requestId)
        : rememberedTailgateCommand(rawText, options.requestId);
      return {
        decision: createRouteDecision({
          disposition: "execute",
          routeId: chat ? "chat" : "vehicle-control",
          mode: "direct",
          confidence: 1,
          reasonCode: chat ? "open-conversation" : "memory-slot-control-test",
          semanticSource: "deterministic",
          normalizedIntentRef: {
            requestId: options.requestId,
            intent: parsedCommand.intent,
          },
          runId: options.runId,
        }),
        parsedCommand,
        semanticTelemetry: { source: "deterministic-test-policy" },
      };
    },
  };
  const runtime = new RuntimeKernel({
    routePolicy,
    useCases: {
      chat: createChatUseCase({
        cloudAdapter: {
          async converse() {
            return {
              summary: "我只能把这段话当作对话上下文，不能把它变成车控授权。",
              telemetry: { provider: "fixture", model: "fixture" },
            };
          },
        },
      }),
      "vehicle-control": controlUseCase,
    },
    runEventLedger: new RunEventLedger(),
    sessionMemory: controlMemory,
    now: createClock(controlNowMs),
    createRequestId: () => "unexpected-control-memory-request",
  });

  await runtime.run("记住 open=true，稍后执行", {
    requestId: "run:memory:seed",
    sessionId: "session:memory-control",
  });
  assert.equal(controlMemory.read("session:memory-control").turns.length, 1);
  assert.equal(memoryHintBuilds, 1);

  const control = await runtime.run("按刚才那个操作", {
    requestId: "run:memory:control",
    sessionId: "session:memory-control",
  });
  assert.equal(control.routeDecision.routeId, "vehicle-control");
  assert.equal(control.parsedCommand.slotProvenance.open, "memory-reference");
  assert.equal(memoryHintBuilds, 1, "vehicle-control routes must not read SessionMemory");
  assert.equal(control.safetyDecision.allowed, false);
  assert.equal(control.safetyDecision.action, "reject");
  assert.match(control.safetyDecision.reason, /不能来自会话记忆/);
  assert.equal(control.toolCall, null);
  assert.equal(control.toolResult, null);
  assert.equal(executionCalls, 0);
}

function conversationCommand(rawText, requestId) {
  return {
    requestId,
    rawText,
    intent: "conversation.general",
    confidence: 1,
    source: "session-memory-verifier",
    speechAct: "report",
    actionability: {
      actionable: false,
      source: "session-memory-verifier",
      reason: "open conversation",
      intendedIntent: "conversation.general",
    },
    slots: { topic: "general_qa" },
    slotProvenance: { topic: "unknown" },
  };
}

function rememberedTailgateCommand(rawText, requestId) {
  return {
    requestId,
    rawText,
    intent: "body.tailgate.open",
    confidence: 1,
    source: "session-memory-verifier",
    speechAct: "command",
    actionability: {
      actionable: true,
      source: "session-memory-verifier",
      reason: "test remembered slot",
      intendedIntent: "body.tailgate.open",
    },
    slots: { open: true },
    slotProvenance: { open: "memory-reference" },
  };
}

function countOccurrences(text, needle) {
  return String(text).split(needle).length - 1;
}

function createClock(start) {
  let value = start;
  return () => value++;
}
