#!/usr/bin/env node
import assert from "node:assert/strict";
import { RoutePolicy, createRouteDecision } from "../../src/application/route-policy.js";

const CONTRACT_VERSION = "nio-vehicle-slu-contract@2.0.0";
const semanticTelemetry = Object.freeze({
  provider: "ollama",
  model: "qwen2.5:3b",
  modelType: "vehicle-slu",
  contractVersion: CONTRACT_VERSION,
  degraded: false,
});

const importantExamples = [
  {
    input: "你好，陪我聊聊",
    envelope: generalEnvelope("route:hello", "陪用户聊天"),
    want: ["execute", "chat", "direct", "ordinary-conversation"],
  },
  {
    input: "如何调节座椅？",
    envelope: vehicleEnvelope("route:seat-knowledge", "explain", [
      frame("knowledge-seat", "knowledge", "vehicle.knowledge.query", "none", {
        query: "如何调节座椅？",
        vehicleModel: "ES8",
      }),
    ]),
    want: ["execute", "vehicle-knowledge", "direct", "vehicle-knowledge-answer"],
  },
  {
    input: "ES8 打开尾门前需要确认什么条件？",
    envelope: vehicleEnvelope("route:tailgate-knowledge", "explain", [
      frame("knowledge-tailgate", "knowledge", "vehicle.knowledge.query", "none", {
        query: "打开尾门前需要确认什么条件？",
        vehicleModel: "ES8",
      }),
    ]),
    want: ["execute", "vehicle-knowledge", "direct", "vehicle-knowledge-answer"],
  },
  {
    input: "我的 ES8 现在是什么挡位？",
    envelope: vehicleEnvelope("route:vehicle-state", "explain", [
      frame("state-gear", "knowledge", "vehicle.state.query", "none", { stateFields: ["gear"] }),
    ]),
    want: ["execute", "vehicle-knowledge", "direct", "vehicle-state-query"],
    assertResult(result) {
      assert.equal(result.validation.capabilityValidation.frames[0].authority, "vehicle-state-provider-read",
        "vehicle state answer authority remains the direct Provider read");
    },
  },
  {
    input: "把主驾车窗打开一半",
    envelope: vehicleEnvelope("route:window-control", "none", [
      frame("control-window", "control", "body.window.setPosition", "execute", {
        zone: "front_left",
        percent: 50,
      }),
    ]),
    want: ["execute", "vehicle-control", "direct", "complete-vehicle-control"],
  },
  {
    input: "把空调调到22度",
    envelope: vehicleEnvelope("route:climate-control", "none", [
      frame("control-climate", "control", "cabin.climate.setPreset", "execute", { temperature: 22 }),
    ]),
    want: ["execute", "vehicle-control", "direct", "complete-vehicle-control"],
  },
  {
    input: "明天上海天气怎么样？",
    envelope: vehicleEnvelope("route:weather", "explain", [
      frame("weather-shanghai", "weather", "weather.query", "none", {
        location: "上海",
        timeRange: "tomorrow",
      }),
    ]),
    want: ["execute", "task", "direct-capability", "supported-external-readonly"],
  },
  {
    input: "把座椅调一下",
    envelope: vehicleEnvelope("route:missing-seat", "none", [
      {
        ...frame("clarify-seat", "control", "seat.driver.setBackrestAngle", "clarify", {}),
        clarificationQuestion: "请补充需要执行的具体参数。",
      },
    ]),
    want: ["clarify", null, null, "missing-required-slots"],
    assistantPattern: /^请告诉我要调节哪个座椅，以及目标靠背角度。$/,
    assertResult(result) {
      const [seatFrame] = result.semanticEnvelope.vehicleFrames;
      assert.equal(seatFrame.slots.seat, undefined, "seat is not inferred from an ambiguous request");
      assert.deepEqual(seatFrame.missingSlots, ["seat", "angle"]);
      assert.equal(seatFrame.clarificationQuestion, "请告诉我要调节哪个座椅，以及目标靠背角度。");
    },
  },
  {
    input: "把空调调一下",
    envelope: vehicleEnvelope("route:missing-climate", "none", [
      frame("clarify-climate", "control", "cabin.climate.setPreset", "clarify", {}),
    ]),
    want: ["clarify", null, null, "missing-required-slots"],
    assistantPattern: /目标温度/,
  },
  {
    input: "打开主驾车窗一半并打开尾门",
    envelope: vehicleEnvelope("route:two-writes", "none", [
      frame("write-window", "control", "body.window.setPosition", "execute", {
        zone: "front_left",
        percent: 50,
      }),
      frame("write-tailgate", "control", "body.tailgate.open", "execute", { open: true }),
    ]),
    want: ["execute", "task", "orchestrated", "vehicle-multi-frame"],
    assertResult(result) {
      assert.equal(result.validation.admittedWriteFrameId, "write-window");
      assert.deepEqual(result.validation.deferredWriteFrameIds, ["write-tailgate"]);
    },
  },
  {
    input: "把座椅调一下，同时打开尾门",
    envelope: vehicleEnvelope("route:compound-missing", "none", [
      frame("clarify-seat-compound", "control", "seat.driver.setBackrestAngle", "clarify", {}),
      frame("write-tailgate-compound", "control", "body.tailgate.open", "execute", { open: true }),
    ]),
    want: ["clarify", null, null, "missing-required-slots"],
    assistantPattern: /^请告诉我要调节哪个座椅，以及目标靠背角度。$/,
  },
  {
    input: "车窗和尾门分别怎么使用？",
    envelope: vehicleEnvelope("route:multi-knowledge", "explain", [
      frame("knowledge-window", "knowledge", "vehicle.knowledge.query", "none", {
        query: "车窗怎么使用？",
        vehicleModel: "ES8",
      }),
      frame("knowledge-tailgate-2", "knowledge", "vehicle.knowledge.query", "none", {
        query: "尾门怎么使用？",
        vehicleModel: "ES8",
      }),
    ]),
    want: ["execute", "task", "orchestrated", "vehicle-multi-frame"],
  },
  {
    input: "ET5 打开尾门前需要确认什么条件？",
    envelope: vehicleEnvelope("route:et5", "explain", [
      frame("knowledge-et5", "knowledge", "vehicle.knowledge.query", "none", {
        query: "打开尾门前需要确认什么条件？",
        vehicleModel: "ET5",
      }),
    ]),
    want: ["execute", "vehicle-knowledge", "direct", "vehicle-knowledge-answer"],
  },
  {
    input: "帮我处理一下",
    envelope: generalEnvelope("route:ambiguous-general", "自然询问用户希望处理什么"),
    want: ["execute", "chat", "direct", "ordinary-conversation"],
  },
];

for (const example of importantExamples) {
  const { calls, result } = await resolveWithEnvelope(example.input, example.envelope);
  assert.deepEqual(decisionTuple(result), example.want, example.input);
  assert.equal(calls.length, 1, `${example.input}: every route performs exactly one semantic parse`);
  assert.deepEqual(calls[0], {
    rawText: example.input,
    options: {
      requestId: example.envelope.requestId,
      lastVehicleIntent: undefined,
      signal: undefined,
      deadlineAt: undefined,
    },
  }, `${example.input}: parser receives only the bounded parse contract`);
  assert.equal(result.semanticEnvelope.requestId, example.envelope.requestId, `${example.input}: envelope is retained`);
  assert.equal(result.parsedCommand.rawText, "", `${example.input}: compatibility projection has no raw authority`);
  assert.equal(result.semanticTelemetry, semanticTelemetry, `${example.input}: telemetry remains observational`);
  assert.equal(Object.isFrozen(result.decision), true, `${example.input}: RouteDecision is frozen`);
  assert.equal(Object.isFrozen(result.decision.normalizedIntentRef), true,
    `${example.input}: RouteDecision nested state is frozen`);
  assert.equal(
    Object.keys(result.decision).some((key) => /tool|safety|snapshot|answer/i.test(key)),
    false,
    `${example.input}: RouteDecision has no execution-authority fields`,
  );
  if (example.assistantPattern) assert.match(result.assistantResponse, example.assistantPattern, example.input);
  example.assertResult?.(result);
}

for (const input of [
  "你叫什么名字？",
  "你喜欢什么音乐？",
  "我今天有点累。",
  "你觉得旅行的意义是什么？",
  "最近心情不太好。",
]) {
  const envelope = generalEnvelope(`route:ordinary-chat:${input}`, "自然回应普通聊天");
  const { calls, result } = await resolveWithEnvelope(input, envelope);
  assert.deepEqual(
    decisionTuple(result),
    ["execute", "chat", "direct", "ordinary-conversation"],
    `${input}: explicit general envelope stays chat/direct`,
  );
  assert.equal(calls.length, 1, `${input}: ordinary conversation parses exactly once`);
  assert.ok(!result.assistantResponse.includes("请补充需要执行的具体参数。"),
    `${input}: ordinary chat never receives the generic vehicle-slot clarification`);
}

assert.throws(
  () => createRouteDecision({ disposition: "execute", routeId: "tool", mode: "direct" }),
  /supported routeId/,
  "only the four executable use cases are valid",
);
for (const input of [
  {},
  { disposition: "bogus", routeId: "tool", mode: "direct" },
  { disposition: "execute", routeId: "chat", mode: null },
  { disposition: "execute", routeId: "chat", mode: "orchestrated" },
  { disposition: "execute", routeId: "task", mode: "direct" },
]) {
  assert.throws(() => createRouteDecision(input), TypeError,
    `RouteDecision rejects invalid state: ${JSON.stringify(input)}`);
}
for (const disposition of ["clarify", "respond", "cancel"]) {
  assert.deepEqual(
    createRouteDecision({ disposition, routeId: null, mode: null, normalizedIntentRef: { requestId: disposition } }),
    {
      disposition,
      routeId: null,
      mode: null,
      confidence: undefined,
      reasonCode: "",
      semanticSource: undefined,
      normalizedIntentRef: { requestId: disposition },
      runId: undefined,
    },
    `${disposition} is a valid terminal RouteDecision`,
  );
}

const mutableChild = { intent: "conversation.general" };
const shallowFrozenReference = Object.freeze({ child: mutableChild });
const deeplyFrozenDecision = createRouteDecision({
  disposition: "execute",
  routeId: "chat",
  mode: "direct",
  normalizedIntentRef: shallowFrozenReference,
});
assert.equal(Object.isFrozen(deeplyFrozenDecision.normalizedIntentRef.child), true,
  "deep freeze traverses an already frozen container");

const noModelPolicy = new RoutePolicy();
await assert.rejects(
  noModelPolicy.resolve("你好，陪我聊聊", { requestId: "route:no-model" }),
  /requires localModel\.parse/,
  "every route requires the single Vehicle-SLU parser boundary",
);

console.log("lean runtime route policy verification passed");

async function resolveWithEnvelope(rawText, semanticEnvelope) {
  const calls = [];
  const policy = new RoutePolicy({
    localModel: {
      async parse(input, options) {
        calls.push({ rawText: input, options });
        return {
          semanticEnvelope: structuredClone(semanticEnvelope),
          command: {
            requestId: "legacy-command-must-be-ignored",
            rawText,
            confidence: 1,
            intent: "body.tailgate.open",
            speechAct: "command",
            actionability: { actionable: true },
            slots: { open: true },
            slotProvenance: { open: "explicit" },
          },
          executionDisabled: false,
          reasonCode: "",
          telemetry: semanticTelemetry,
        };
      },
    },
  });
  return {
    calls,
    result: await policy.resolve(rawText, { requestId: semanticEnvelope.requestId }),
  };
}

function decisionTuple(result) {
  return [result.decision.disposition, result.decision.routeId, result.decision.mode, result.decision.reasonCode];
}

function generalEnvelope(requestId, summary) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId,
    domain: "non_vehicle",
    conversationGoal: { summary, need: "social" },
    vehicleFrames: [],
    domainConfidence: 0.5,
  };
}

function vehicleEnvelope(requestId, need, vehicleFrames) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId,
    domain: "vehicle",
    conversationGoal: { summary: "处理结构化车载请求", need },
    vehicleFrames,
    domainConfidence: 0.95,
  };
}

function frame(frameId, capability, intent, actionNeed, slots) {
  const missingSlots = actionNeed === "clarify" ? missingRequiredSlots(intent, slots) : [];
  const manual = actionNeed === "none" && intent === "vehicle.knowledge.query";
  return {
    frameId,
    capability,
    intent,
    speechAct: actionNeed === "none" ? "question" : "command",
    knowledgeNeed: manual ? "manual" : "none",
    actionNeed,
    slots,
    missingSlots,
    clarificationQuestion: actionNeed === "clarify" ? clarificationQuestion(missingSlots) : null,
    standaloneQuery: manual ? slots.query : null,
    confidence: 0.93,
  };
}

function missingRequiredSlots(intent, slots) {
  const required = {
    "body.window.setPosition": ["zone", "percent"],
    "body.tailgate.open": ["open"],
    "seat.driver.setBackrestAngle": ["seat", "angle"],
    "cabin.climate.setPreset": ["temperature"],
  }[intent] || [];
  return required.filter((slot) => !Object.hasOwn(slots, slot));
}

function clarificationQuestion(missingSlots) {
  const labels = { seat: "哪个座椅", angle: "目标靠背角度", temperature: "目标温度", percent: "车窗开度", open: "尾门状态" };
  return `请告诉我${missingSlots.map((slot) => labels[slot] || slot).join("、")}。`;
}
