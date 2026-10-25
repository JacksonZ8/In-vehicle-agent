#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildRunDetailViewModel,
  buildRunEventViewModel,
  buildRuntimeResultDebugSnapshot,
} from "../../src/app/run-event-presenter.js";
import { RuntimeKernel } from "../../src/application/runtime-kernel.js";
import { RoutePolicy } from "../../src/application/route-policy.js";
import { RunEventLedger } from "../../src/runtime/run-event-ledger.js";
import { SessionMemory } from "../../src/runtime/session-memory.js";

const PRIVATE_SENTINELS = [
  "RAW_PROMPT_SENTINEL",
  "RAW_RESPONSE_SENTINEL",
  "CHAIN_OF_THOUGHT_SENTINEL",
  "TOOL_AUTHORITY_SENTINEL",
];

const semanticEnvelope = {
  contractVersion: "nio-vehicle-slu-contract@2.0.0",
  requestId: "run:observability:snapshot",
  domain: "vehicle",
  conversationGoal: { summary: "打开右前车窗到一半", need: "none" },
  vehicleFrames: [{
    frameId: "frame-1",
    capability: "control",
    intent: "body.window.setPosition",
    speechAct: "command",
    knowledgeNeed: "none",
    actionNeed: "execute",
    slots: { zone: "front_right", percent: 50 },
    missingSlots: [],
    clarificationQuestion: null,
    standaloneQuery: null,
    confidence: 0.97,
  }],
  domainConfidence: 0.98,
};

const snapshot = buildRuntimeResultDebugSnapshot({
  requestId: semanticEnvelope.requestId,
  semanticEnvelope: {
    ...semanticEnvelope,
    rawPrompt: PRIVATE_SENTINELS[0],
    rawResponse: PRIVATE_SENTINELS[1],
    chainOfThought: PRIVATE_SENTINELS[2],
    vehicleFrames: [{
      ...semanticEnvelope.vehicleFrames[0],
      slots: {
        ...semanticEnvelope.vehicleFrames[0].slots,
        prompt: PRIVATE_SENTINELS[0],
        nestedTool: { authority: PRIVATE_SENTINELS[3] },
      },
      clarificationQuestion: PRIVATE_SENTINELS[0],
      standaloneQuery: PRIVATE_SENTINELS[1],
      rawResponse: PRIVATE_SENTINELS[1],
    }],
  },
  executionDisabled: false,
  rawPrompt: PRIVATE_SENTINELS[0],
  rawResponse: PRIVATE_SENTINELS[1],
  chainOfThought: PRIVATE_SENTINELS[2],
  semanticAuthority: { toolAuthority: PRIVATE_SENTINELS[3] },
});

assert.deepEqual(snapshot.semanticEnvelope.vehicleFrames[0], {
  frameId: "frame-1",
  capability: "control",
  intent: "body.window.setPosition",
  speechAct: "command",
  knowledgeNeed: "none",
  actionNeed: "execute",
  slots: { zone: "front_right", percent: 50 },
  missingSlots: [],
  clarificationQuestion: null,
  standaloneQuery: null,
  confidence: 0.97,
});
assert.equal(snapshot.executionDisabled, false);
assertNoPrivateData(snapshot, "runtime debug snapshot");
assert.equal(
  buildRuntimeResultDebugSnapshot({ executionDisabled: "not-a-boolean" }).executionDisabled,
  false,
  "the debug boundary must normalize executionDisabled to a boolean",
);

const slotMatrixFrames = [
  frame("knowledge-query", "knowledge", "vehicle.knowledge.query", {
    speechAct: "question",
    knowledgeNeed: "manual",
    actionNeed: "none",
    slots: {
      query: "ES8 车窗防夹如何工作？",
      vehicleModel: "ES8",
      eligibilityAction: "body.tailgate.open",
      prompt: PRIVATE_SENTINELS[0],
    },
    standaloneQuery: "ES8 车窗防夹如何工作？",
  }),
  frame("vehicle-state", "knowledge", "vehicle.state.query", {
    speechAct: "question",
    actionNeed: "none",
    slots: {
      stateFields: ["speedKph", "gear"],
      nestedTool: { authority: PRIVATE_SENTINELS[3] },
    },
  }),
  frame("weather", "weather", "weather.query", {
    speechAct: "question",
    actionNeed: "none",
    slots: {
      location: "杭州",
      timeRange: "today",
      rawResponse: PRIVATE_SENTINELS[1],
    },
  }),
  frame("navigation", "navigation", "navigation.planRoute", {
    slots: {
      origin: "当前位置",
      destination: "西湖",
      chainOfThought: PRIVATE_SENTINELS[2],
    },
  }),
  frame("energy", "navigation", "energy.findSwapStation", { slots: { destination: "杭州" } }),
  frame("media", "media", "media.play", { slots: { query: "播放古典音乐" } }),
  frame("phone", "phone", "phone.call", { slots: { contact: "张三" } }),
  frame("window", "control", "body.window.setPosition", { slots: { zone: "front_right", percent: 50 } }),
  frame("window-clarify", "control", "body.window.setPosition", {
    actionNeed: "clarify",
    slots: { zone: "front_left" },
    missingSlots: ["percent"],
    clarificationQuestion: "请问主驾车窗要调到多少？",
  }),
  frame("tailgate", "control", "body.tailgate.open", { slots: { open: true } }),
  frame("seat", "control", "seat.driver.setBackrestAngle", { slots: { seat: "driver", angle: 112 } }),
  frame("climate", "control", "cabin.climate.setPreset", { slots: { temperature: 24 } }),
];
const slotMatrixSnapshot = buildRuntimeResultDebugSnapshot({
  semanticEnvelope: {
    contractVersion: "nio-vehicle-slu-contract@2.0.0",
    requestId: "run:observability:slot-matrix",
    domain: "vehicle",
    conversationGoal: { summary: "车载能力槽位审计", need: "explain", rawPrompt: PRIVATE_SENTINELS[0] },
    vehicleFrames: slotMatrixFrames,
    domainConfidence: 0.96,
    toolAuthority: PRIVATE_SENTINELS[3],
  },
  executionDisabled: false,
});
assert.deepEqual({ ...slotMatrixSnapshot.semanticEnvelope, vehicleFrames: undefined }, {
  contractVersion: "nio-vehicle-slu-contract@2.0.0",
  requestId: "run:observability:slot-matrix",
  domain: "vehicle",
  conversationGoal: { summary: "车载能力槽位审计", need: "explain" },
  vehicleFrames: undefined,
  domainConfidence: 0.96,
});
assert.deepEqual(slotMatrixSnapshot.semanticEnvelope.vehicleFrames.map(({ frameId, slots }) => ({ frameId, slots })), [
  { frameId: "knowledge-query", slots: { query: "ES8 车窗防夹如何工作？", vehicleModel: "ES8", eligibilityAction: "body.tailgate.open" } },
  { frameId: "vehicle-state", slots: { stateFields: ["speedKph", "gear"] } },
  { frameId: "weather", slots: { location: "杭州", timeRange: "today" } },
  { frameId: "navigation", slots: { origin: "当前位置", destination: "西湖" } },
  { frameId: "energy", slots: { destination: "杭州" } },
  { frameId: "media", slots: { query: "播放古典音乐" } },
  { frameId: "phone", slots: { contact: "张三" } },
  { frameId: "window", slots: { zone: "front_right", percent: 50 } },
  { frameId: "window-clarify", slots: { zone: "front_left" } },
  { frameId: "tailgate", slots: { open: true } },
  { frameId: "seat", slots: { seat: "driver", angle: 112 } },
  { frameId: "climate", slots: { temperature: 24 } },
]);
assert.deepEqual(
  slotMatrixSnapshot.semanticEnvelope.vehicleFrames.map((item) => ({
    frameId: item.frameId,
    speechAct: item.speechAct,
    knowledgeNeed: item.knowledgeNeed,
    actionNeed: item.actionNeed,
    missingSlots: item.missingSlots,
    clarificationQuestion: item.clarificationQuestion,
    standaloneQuery: item.standaloneQuery,
  })),
  [
    { frameId: "knowledge-query", speechAct: "question", knowledgeNeed: "manual", actionNeed: "none", missingSlots: [], clarificationQuestion: null, standaloneQuery: "ES8 车窗防夹如何工作？" },
    { frameId: "vehicle-state", speechAct: "question", knowledgeNeed: "none", actionNeed: "none", missingSlots: [], clarificationQuestion: null, standaloneQuery: null },
    { frameId: "weather", speechAct: "question", knowledgeNeed: "none", actionNeed: "none", missingSlots: [], clarificationQuestion: null, standaloneQuery: null },
    { frameId: "navigation", speechAct: "command", knowledgeNeed: "none", actionNeed: "execute", missingSlots: [], clarificationQuestion: null, standaloneQuery: null },
    { frameId: "energy", speechAct: "command", knowledgeNeed: "none", actionNeed: "execute", missingSlots: [], clarificationQuestion: null, standaloneQuery: null },
    { frameId: "media", speechAct: "command", knowledgeNeed: "none", actionNeed: "execute", missingSlots: [], clarificationQuestion: null, standaloneQuery: null },
    { frameId: "phone", speechAct: "command", knowledgeNeed: "none", actionNeed: "execute", missingSlots: [], clarificationQuestion: null, standaloneQuery: null },
    { frameId: "window", speechAct: "command", knowledgeNeed: "none", actionNeed: "execute", missingSlots: [], clarificationQuestion: null, standaloneQuery: null },
    { frameId: "window-clarify", speechAct: "command", knowledgeNeed: "none", actionNeed: "clarify", missingSlots: ["percent"], clarificationQuestion: "请问主驾车窗要调到多少？", standaloneQuery: null },
    { frameId: "tailgate", speechAct: "command", knowledgeNeed: "none", actionNeed: "execute", missingSlots: [], clarificationQuestion: null, standaloneQuery: null },
    { frameId: "seat", speechAct: "command", knowledgeNeed: "none", actionNeed: "execute", missingSlots: [], clarificationQuestion: null, standaloneQuery: null },
    { frameId: "climate", speechAct: "command", knowledgeNeed: "none", actionNeed: "execute", missingSlots: [], clarificationQuestion: null, standaloneQuery: null },
  ],
);
assertNoPrivateData(slotMatrixSnapshot, "Vehicle-SLU ontology slot projection");

const invalidSlotTypeSnapshot = buildRuntimeResultDebugSnapshot({
  semanticEnvelope: {
    ...semanticEnvelope,
    vehicleFrames: [frame("invalid-slot", "knowledge", "vehicle.knowledge.query", {
      speechAct: "question",
      knowledgeNeed: "manual",
      actionNeed: "none",
      slots: {
        query: { rawPrompt: PRIVATE_SENTINELS[0] },
        vehicleModel: "ES8",
      },
      standaloneQuery: "ES8 车窗防夹如何工作？",
    })],
  },
});
assert.deepEqual(invalidSlotTypeSnapshot.semanticEnvelope.vehicleFrames[0].slots, { vehicleModel: "ES8" });
assertNoPrivateData(invalidSlotTypeSnapshot, "invalid semantic slot type projection");

const slotTypeGuardSnapshot = buildRuntimeResultDebugSnapshot({
  semanticEnvelope: {
    ...semanticEnvelope,
    vehicleFrames: [
      frame("bad-window", "control", "body.window.setPosition", { slots: { zone: "front_right", percent: "50" } }),
      frame("bad-tailgate", "control", "body.tailgate.open", { slots: { open: 1 } }),
      frame("bad-state", "knowledge", "vehicle.state.query", {
        speechAct: "question",
        actionNeed: "none",
        slots: { stateFields: ["speedKph", { rawPrompt: PRIVATE_SENTINELS[0] }] },
      }),
      frame("bad-phone", "phone", "phone.call", { slots: { contact: { rawResponse: PRIVATE_SENTINELS[1] } } }),
    ],
  },
});
assert.deepEqual(slotTypeGuardSnapshot.semanticEnvelope.vehicleFrames.map(({ slots }) => slots), [
  { zone: "front_right" },
  {},
  {},
  {},
]);
assertNoPrivateData(slotTypeGuardSnapshot, "Vehicle-SLU slot type guards");

const runtimeEnvelope = {
  contractVersion: "nio-vehicle-slu-contract@2.0.0",
  requestId: "run:observability:event",
  domain: "vehicle",
  conversationGoal: { summary: "把主驾车窗调一下", need: "none" },
  vehicleFrames: [{
    frameId: "frame:window-clarify",
    capability: "control",
    intent: "body.window.setPosition",
    speechAct: "command",
    knowledgeNeed: "none",
    actionNeed: "clarify",
    slots: { zone: "front_left" },
    missingSlots: ["percent"],
    clarificationQuestion: "请问主驾车窗要调到多少？",
    standaloneQuery: null,
    confidence: 0.99,
  }],
  domainConfidence: 0.99,
};
const routePolicy = new RoutePolicy({
  localModel: {
    async parse() {
      return {
        semanticEnvelope: runtimeEnvelope,
        telemetry: {
          model: "vehicle-slu-test",
          provider: "injected",
          durationMs: 17.5,
          promptVersion: "nio-vehicle-slu-prompt@2.0.0",
        },
      };
    },
  },
});
const runtime = new RuntimeKernel({
  routePolicy: {
    async resolve(rawText, options) {
      const resolution = await routePolicy.resolve(rawText, options);
      return {
        ...resolution,
        rawPrompt: PRIVATE_SENTINELS[0],
        rawResponse: PRIVATE_SENTINELS[1],
        chainOfThought: PRIVATE_SENTINELS[2],
        toolAuthority: PRIVATE_SENTINELS[3],
        validation: {
          ...resolution.validation,
          rawResponse: PRIVATE_SENTINELS[1],
          capabilityValidation: {
            ...resolution.validation.capabilityValidation,
            nestedTool: { authority: PRIVATE_SENTINELS[3] },
          },
        },
      };
    },
  },
  useCases: {},
  runEventLedger: new RunEventLedger(),
  sessionMemory: new SessionMemory(),
  now: (() => {
    let now = Date.parse("2026-08-06T08:00:00.000Z");
    return () => now++;
  })(),
});
const result = await runtime.run("这是不得进入 route event data 的原始文本", {
  requestId: runtimeEnvelope.requestId,
});
const routeEvent = result.events.find((event) => event.phase === "route-decision");
assert.deepEqual(Object.keys(routeEvent.metadata).sort(), [
  "degraded",
  "modelTelemetry",
  "reasonCode",
  "routing",
]);
assert.deepEqual(Object.keys(routeEvent.metadata.routing).sort(), [
  "disposition",
  "mode",
  "routeId",
  "semanticSource",
  "semanticSummary",
  "validation",
]);
assert.deepEqual(routeEvent.metadata.routing.semanticSummary, {
  contractVersion: runtimeEnvelope.contractVersion,
  requestId: runtimeEnvelope.requestId,
  domain: "vehicle",
  conversationGoal: { summary: "把主驾车窗调一下", need: "none" },
  domainConfidence: 0.99,
  vehicleFrames: [{
    frameId: "frame:window-clarify",
    capability: "control",
    intent: "body.window.setPosition",
    speechAct: "command",
    knowledgeNeed: "none",
    actionNeed: "clarify",
    missingSlots: ["percent"],
    clarificationQuestion: "请问主驾车窗要调到多少？",
    confidence: 0.99,
    slotNames: ["zone"],
  }],
});
assert.deepEqual(routeEvent.metadata.routing.validation.contract, { ok: true });
assert.deepEqual(routeEvent.metadata.routing.validation.capability, { ok: true });
assert.deepEqual(
  routeEvent.metadata.routing.validation.slot,
  { ok: false },
  "a clarification frame must expose its missing-slot validation state without losing V2 semantics",
);
assertNoPrivateData(routeEvent.metadata, "route event metadata");

const eventViewModel = buildRunEventViewModel({
  runId: result.requestId,
  status: "completed",
  startedAt: result.events[0].timestamp,
  completedAt: result.events.at(-1).timestamp,
  events: result.events,
});
const detail = buildRunDetailViewModel({
  input: "用户输入可见",
  requestId: result.requestId,
  result,
  events: result.events,
  startedAtPerf: 10,
  endedAtPerf: 27,
}, { eventViewModel });
assert.deepEqual(detail.semanticDecision.semanticSummary, {
  ...routeEvent.metadata.routing.semanticSummary,
  vehicleFrames: routeEvent.metadata.routing.semanticSummary.vehicleFrames.map((frame) => ({
    ...frame,
    standaloneQuery: null,
  })),
});
assert.deepEqual(detail.semanticDecision.contractValidation, { ok: true });
assert.equal(detail.semanticDecision.provider, "injected");
assert.equal(detail.semanticDecision.model, "vehicle-slu-test");
assert.equal(detail.semanticDecision.durationMs, 18);
assert.equal(detail.semanticDecision.promptVersion, "nio-vehicle-slu-prompt@2.0.0");
assertNoPrivateData(detail.semanticDecision, "HMI semantic decision projection");

const generalSnapshot = buildRuntimeResultDebugSnapshot({
  requestId: "run:observability:general",
  semanticEnvelope: {
    contractVersion: "nio-vehicle-slu-contract@2.0.0",
    requestId: "run:observability:general",
    domain: "non_vehicle",
    conversationGoal: { summary: "聊聊天", need: "social", prompt: PRIVATE_SENTINELS[0] },
    vehicleFrames: [],
    domainConfidence: 0.93,
    rawResponse: PRIVATE_SENTINELS[1],
  },
  executionDisabled: false,
});
assert.deepEqual(generalSnapshot.semanticEnvelope, {
  contractVersion: "nio-vehicle-slu-contract@2.0.0",
  requestId: "run:observability:general",
  domain: "non_vehicle",
  conversationGoal: { summary: "聊聊天", need: "social" },
  vehicleFrames: [],
  domainConfidence: 0.93,
});
assertNoPrivateData(generalSnapshot, "general semantic envelope projection");

const failureRuntime = new RuntimeKernel({
  routePolicy: new RoutePolicy({
    localModel: {
      async parse() {
        return {
          semanticEnvelope: null,
          executionDisabled: true,
          reasonCode: "semantic-model-unavailable",
          telemetry: {
            provider: "injected",
            model: "vehicle-slu-test",
            durationMs: 2,
            rawResponse: PRIVATE_SENTINELS[1],
          },
        };
      },
    },
  }),
  useCases: {},
  runEventLedger: new RunEventLedger(),
  sessionMemory: new SessionMemory(),
  now: (() => {
    let now = Date.parse("2026-08-06T08:01:00.000Z");
    return () => now++;
  })(),
});
const failureResult = await failureRuntime.run("即使像车控也不得泄漏", { requestId: "run:observability:failure" });
const failureEventView = buildRunEventViewModel({
  runId: failureResult.requestId,
  status: "completed",
  startedAt: failureResult.events[0].timestamp,
  completedAt: failureResult.events.at(-1).timestamp,
  events: failureResult.events,
});
const failureDetail = buildRunDetailViewModel({
  input: "用户可见输入",
  requestId: failureResult.requestId,
  result: failureResult,
  events: failureResult.events,
}, { eventViewModel: failureEventView });
assert.equal(failureDetail.result.semanticEnvelope, null);
assert.equal(failureDetail.result.executionDisabled, true);
assert.equal(failureDetail.semanticDecision, null);
const failureRouteEvent = failureResult.events.find((event) => event.phase === "route-decision");
assert.equal(Object.hasOwn(failureRouteEvent.metadata.routing, "semanticSummary"), false);
assertNoPrivateData(failureRouteEvent.metadata, "fail-closed route event metadata");
assertNoPrivateData(failureDetail, "fail-closed detail projection");

assert.equal(buildRuntimeResultDebugSnapshot(null), null);
assert.deepEqual(buildRuntimeResultDebugSnapshot({}), { events: [] });
assert.equal(buildRunDetailViewModel(null), null);
const emptyDetail = buildRunDetailViewModel({ input: "", result: {}, events: [] }, {
  eventViewModel: buildRunEventViewModel({ status: "completed", events: [] }),
});
assert.deepEqual(emptyDetail.result, { events: [] });
assert.equal(emptyDetail.semanticDecision, null);
assertNoPrivateData(emptyDetail, "empty detail projection");

console.log("Vehicle-SLU observability verification passed");

function assertNoPrivateData(value, label) {
  const serialized = JSON.stringify(value);
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.doesNotMatch(serialized, new RegExp(sentinel), `${label} must exclude ${sentinel}`);
  }
  assert.doesNotMatch(serialized, /"(?:rawPrompt|rawResponse|chainOfThought|toolAuthority|nestedTool)"/, `${label} must exclude private keys`);
}

function frame(frameId, capability, intent, {
  speechAct = "command",
  knowledgeNeed = "none",
  actionNeed = "execute",
  slots = {},
  missingSlots = [],
  clarificationQuestion = null,
  standaloneQuery = null,
  confidence = 0.91,
} = {}) {
  return {
    frameId,
    capability,
    intent,
    speechAct,
    knowledgeNeed,
    actionNeed,
    slots,
    missingSlots,
    clarificationQuestion,
    standaloneQuery,
    confidence,
  };
}
