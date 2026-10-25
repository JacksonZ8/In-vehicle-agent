#!/usr/bin/env node
import assert from "node:assert/strict";
import { RoutePolicy, createRouteDecision } from "../../src/application/route-policy.js";
import { resolveClarificationTransition } from "../../src/semantic/clarification-transition.js";
import { validateVehicleSluEnvelope } from "../../src/semantic/vehicle-slu-contract.js";
import { createVehicleSluPlanAuthority } from "../../src/semantic/vehicle-slu-orchestration.js";

const CONTRACT_VERSION = "nio-vehicle-slu-contract@2.0.0";
const TELEMETRY = Object.freeze({
  provider: "ollama",
  model: "qwen2.5:3b",
  modelType: "vehicle-slu",
  contractVersion: CONTRACT_VERSION,
  degraded: false,
});
const FORGED_LEGACY_COMMAND = Object.freeze({
  requestId: "forged-legacy-command",
  rawText: "legacy command must not be route authority",
  source: "legacy-test-double",
  confidence: 1,
  intent: "body.tailgate.open",
  speechAct: "command",
  actionability: Object.freeze({ actionable: true }),
  slots: Object.freeze({ open: true }),
  slotProvenance: Object.freeze({ open: "explicit" }),
});

const cases = [
  {
    id: "general",
    modelResult: success(generalEnvelope("route-general")),
    want: route("execute", "chat", "direct", "ordinary-conversation"),
  },
  {
    id: "knowledge",
    modelResult: success(vehicleEnvelope("route-knowledge", "explain", [
      frame("knowledge-1", "knowledge", "vehicle.knowledge.query", "none", {
        query: "ES8 车窗防夹如何工作？",
        vehicleModel: "ES8",
      }),
    ])),
    want: route("execute", "vehicle-knowledge", "direct", "vehicle-knowledge-answer"),
  },
  {
    id: "vehicle-state",
    modelResult: success(vehicleEnvelope("route-state", "explain", [
      frame("state-1", "knowledge", "vehicle.state.query", "none", {
        stateFields: ["speedKph", "gear"],
      }),
    ])),
    want: route("execute", "vehicle-knowledge", "direct", "vehicle-state-query"),
    assertResult(result) {
      assert.deepEqual(result.validation.capabilityValidation.frames, [{
        frameId: "state-1",
        capability: "knowledge",
        intent: "vehicle.state.query",
        status: "registered",
        authority: "vehicle-state-provider-read",
      }], "vehicle state must preserve direct Provider read authority in validation");
      assert.equal(result.parsedCommand.slots.stateFields[0], "speedKph");
    },
  },
  {
    id: "weather",
    modelResult: success(vehicleEnvelope("route-weather", "explain", [
      frame("weather-1", "weather", "weather.query", "none", {
        location: "上海",
        timeRange: "tomorrow",
      }),
    ])),
    want: route("execute", "task", "direct-capability", "supported-external-readonly"),
  },
  ...completeControlCases(),
  ...missingControlCases(),
  {
    id: "missing-execute-window",
    modelResult: success(vehicleEnvelope("route-missing-execute-window", "none", [
      frame("missing-execute-window-frame", "control", "body.window.setPosition", "execute", {
        zone: "front_left",
      }),
      frame("missing-execute-weather-frame", "weather", "weather.query", "none", {
        location: "杭州",
        timeRange: "today",
      }),
    ], "调整车窗并查看天气")),
    want: route("clarify", null, null, "missing-required-slots"),
    assistantPattern: /多少开度|车窗开度/,
    assertResult(result) {
      assert.equal(result.validation.admittedWriteFrameId, null,
        "an execute-labelled frame with absent canonical slots must admit no write");
      assert.deepEqual(result.validation.slotValidation.frames[0].missingRequiredSlots, ["percent"]);
      assert.equal(validateVehicleSluEnvelope(result.semanticEnvelope).ok, true,
        "defensive missing-slot handling must return a valid V2 envelope");
      assert.deepEqual(result.semanticEnvelope.vehicleFrames[0], {
        ...result.semanticEnvelope.vehicleFrames[0],
        actionNeed: "clarify",
        missingSlots: ["percent"],
        clarificationQuestion: result.assistantResponse,
      }, "the incomplete execute frame must be normalized into persistent clarification authority");
      assert.match(result.semanticEnvelope.vehicleFrames[0].clarificationQuestion, /多少开度|车窗开度/);
      assert.equal(result.semanticEnvelope.requestId, "route-missing-execute-window");
      assert.equal(result.semanticEnvelope.domain, "vehicle");
      assert.deepEqual(result.semanticEnvelope.conversationGoal, {
        summary: "调整车窗并查看天气",
        need: "none",
      });
      assert.deepEqual(result.semanticEnvelope.vehicleFrames.map(({ frameId, actionNeed }) => ({
        frameId,
        actionNeed,
      })), [
        { frameId: "missing-execute-window-frame", actionNeed: "clarify" },
        { frameId: "missing-execute-weather-frame", actionNeed: "none" },
      ], "normalization must preserve unrelated frames and source order");
      assert.equal(result.parsedCommand.actionability.actionable, false,
        "the compatibility command must be reprojected as non-actionable");
      assert.deepEqual(resolveClarificationTransition({
        pending: null,
        envelope: result.semanticEnvelope,
      }), {
        action: "open",
        nextPending: {
          frameId: "missing-execute-window-frame",
          intent: "body.window.setPosition",
          acceptedSlots: { zone: "front_left" },
          missingSlots: ["percent"],
          clarificationQuestion: result.assistantResponse,
        },
        resolvedFrame: null,
        reasonCode: "clarification-opened",
      }, "the returned envelope must open a persistent clarification without fallback translation");
    },
  },
  ...["complete-first", "missing-first"].map((order) => {
    const tailgate = frame("terminal-mixed-tailgate", "control", "body.tailgate.open", "execute", {
      open: true,
    });
    const window = frame("terminal-mixed-window", "control", "body.window.setPosition", "execute", {
      zone: "front_left",
    });
    return {
      id: `terminal-mixed-clarification-${order}`,
      modelResult: success(vehicleEnvelope(`route-terminal-mixed-${order}`, "none",
        order === "complete-first" ? [tailgate, window] : [window, tailgate],
        "打开尾门并调整车窗")),
      want: route("clarify", null, null, "missing-required-slots"),
      assistantPattern: /多少开度|车窗开度/,
      assertResult(result) {
        assert.equal(validateVehicleSluEnvelope(result.semanticEnvelope).ok, true,
          `${order}: normalized terminal envelope must remain valid V2`);
        assert.equal(result.parsedCommand.actionability.actionable, false,
          `${order}: terminal clarification projection must be non-actionable`);
        assert.equal(createVehicleSluPlanAuthority(result.semanticEnvelope).admittedWriteFrameId, null,
          `${order}: terminal clarification must retain zero admitted write authority`);
        const capabilityFrames = {
          tailgate: {
            frameId: "terminal-mixed-tailgate",
            capability: "control",
            intent: "body.tailgate.open",
            status: "registered",
            authority: "cabin-response",
          },
          window: {
            frameId: "terminal-mixed-window",
            capability: "control",
            intent: "body.window.setPosition",
            status: "registered",
            authority: "vehicle-control-clarification",
          },
        };
        assert.deepEqual(result.validation.capabilityValidation.frames,
          order === "complete-first"
            ? [capabilityFrames.tailgate, capabilityFrames.window]
            : [capabilityFrames.window, capabilityFrames.tailgate],
          `${order}: validation authority must be recomputed from the normalized envelope`);
        assert.equal(result.validation.capabilityValidation.frames.some(
          ({ authority }) => authority === "vehicle-control-write"), false,
        `${order}: terminal validation must expose no vehicle-control-write authority`);
        assert.deepEqual(result.validation.slotValidation, {
          ok: false,
          auditedFrameIds: ["terminal-mixed-window"],
          frames: [{
            frameId: "terminal-mixed-window",
            intent: "body.window.setPosition",
            missingRequiredSlots: ["percent"],
          }],
        }, `${order}: slot validation must audit only the normalized clarification target`);
        assert.equal(result.validation.admittedWriteFrameId, null,
          `${order}: normalized validation must admit no write`);
        assert.deepEqual(result.validation.deferredWriteFrameIds, [],
          `${order}: normalized validation must retain no stale deferred write`);
        const normalizedById = new Map(result.semanticEnvelope.vehicleFrames.map((item) => [item.frameId, item]));
        assert.deepEqual(normalizedById.get("terminal-mixed-window"), {
          ...window,
          actionNeed: "clarify",
          missingSlots: ["percent"],
          clarificationQuestion: result.assistantResponse,
        }, `${order}: only the missing window becomes the clarification target`);
        assert.deepEqual(normalizedById.get("terminal-mixed-tailgate"), {
          ...tailgate,
          actionNeed: "none",
        }, `${order}: the complete tailgate keeps identity/slots but becomes explicitly non-executable`);
        assert.deepEqual(result.semanticEnvelope.vehicleFrames.map(({ frameId }) => frameId),
          (order === "complete-first" ? [tailgate, window] : [window, tailgate]).map(({ frameId }) => frameId),
          `${order}: normalization must not reorder or delete frames`);
        const transition = resolveClarificationTransition({ pending: null, envelope: result.semanticEnvelope });
        assert.equal(transition.action, "open", `${order}: the missing frame must open pending`);
        assert.equal(transition.nextPending.intent, "body.window.setPosition");
        assert.deepEqual(transition.nextPending.missingSlots, ["percent"]);
      },
    };
  }),
  {
    id: "unknown-domain",
    modelResult: success(unknownEnvelope("route-unknown")),
    want: route("clarify", null, null, "unknown-domain"),
    assistantPattern: /再说明/,
    assertResult(result) {
      assert.deepEqual(result.semanticEnvelope.vehicleFrames, [],
        "unknown domain must expose zero vehicle frames");
      assert.deepEqual(result.validation.capabilityValidation.registeredFrameIds, [],
        "unknown domain must authorize zero downstream capabilities");
    },
  },
  ...unsupportedCapabilityCases(),
  {
    id: "protected-capability",
    modelResult: success(vehicleEnvelope("route-protected", "explain", [
      frame("protected-1", "control", "safety.reject", "none", {}),
    ])),
    want: route("respond", null, null, "protected-capability"),
    assistantPattern: /安全提醒不能关闭/,
  },
  {
    id: "protected-plus-complete-write",
    modelResult: success(vehicleEnvelope("route-protected-plus-write", "explain", [
      frame("protected-mixed-window", "control", "body.window.setPosition", "execute", {
        zone: "front_left",
        percent: 40,
      }),
      frame("protected-mixed-safety", "control", "safety.reject", "none", {}),
    ])),
    want: route("respond", null, null, "protected-capability"),
    assistantPattern: /安全提醒不能关闭/,
    assertResult(result) {
      assert.deepEqual(result.semanticEnvelope.vehicleFrames.map(({ frameId }) => frameId), [
        "protected-mixed-window",
        "protected-mixed-safety",
      ], "protected mixed write must retain every frame without admitting the write");
      assert.equal(result.validation.admittedWriteFrameId, null,
        "protected mixed write must remain terminal with zero admitted writes");
    },
  },
  {
    id: "protected-plus-readonly-unsupported",
    modelResult: success(vehicleEnvelope("route-protected-plus-readonly-unsupported", "explain", [
      frame("protected-mixed-knowledge", "knowledge", "vehicle.knowledge.query", "none", {
        query: "车窗防夹原理",
        vehicleModel: "ES8",
      }),
      frame("protected-mixed-media", "media", "media.play", "execute", { query: "古典音乐" }),
      frame("protected-mixed-safety-last", "control", "safety.reject", "none", {}),
    ])),
    want: route("respond", null, null, "protected-capability"),
    capabilityDeferredFrameIds: ["protected-mixed-media"],
    assistantPattern: /安全提醒不能关闭/,
    assertResult(result) {
      assert.deepEqual(result.semanticEnvelope.vehicleFrames.map(({ frameId }) => frameId), [
        "protected-mixed-knowledge",
        "protected-mixed-media",
        "protected-mixed-safety-last",
      ], "protected mixed readonly/unsupported result must retain every frame");
      assert.equal(result.validation.admittedWriteFrameId, null,
        "protected mixed readonly/unsupported result must remain terminal with zero admitted writes");
    },
  },
  {
    id: "control-answer",
    modelResult: success(vehicleEnvelope("route-control-answer", "explain", [
      frame("control-answer-1", "control", "cabin.climate.setPreset", "none", {}),
    ])),
    want: route("execute", "chat", "direct", "vehicle-slu-control-answer"),
    assertResult(result) {
      assert.deepEqual(result.validation.slotValidation.auditedFrameIds, [],
        "control/answer must not enter vehicle write slot audit");
    },
  },
  {
    id: "semantic-timeout",
    modelResult: semanticFailure("semantic-timeout"),
    want: route("respond", null, null, "semantic-timeout"),
    executionDisabled: true,
    assistantPattern: /不会执行车辆或座舱操作/,
  },
  {
    id: "semantic-failure-invalid-reason",
    modelResult: semanticFailure("semantic-forged-provider"),
    want: route("respond", null, null, "semantic-contract-invalid"),
    executionDisabled: true,
    assistantPattern: /不会执行车辆或座舱操作/,
  },
  {
    id: "contract-invalid",
    modelResult: success({
      ...generalEnvelope("route-contract-invalid"),
      contractVersion: "nio-vehicle-slu-contract@999.0.0",
    }),
    want: route("respond", null, null, "semantic-contract-invalid"),
    executionDisabled: true,
    assistantPattern: /不会执行车辆或座舱操作/,
  },
  {
    id: "mixed-conversation-single-write",
    modelResult: success(vehicleEnvelope("route-mixed-write", "social", [
      frame("mixed-window-1", "control", "body.window.setPosition", "execute", {
        zone: "front_right",
        percent: 50,
      }),
    ], "聊聊旅行并打开副驾车窗一半")),
    want: route("execute", "task", "orchestrated", "vehicle-multi-frame"),
    admittedWriteFrameId: "mixed-window-1",
  },
  {
    id: "multiple-readonly-frames",
    modelResult: success(vehicleEnvelope("route-multiple-readonly", "explain", [
      frame("multi-knowledge-1", "knowledge", "vehicle.knowledge.query", "none", {
        query: "车窗防夹原理",
        vehicleModel: "ES8",
      }),
      frame("multi-weather-1", "weather", "weather.query", "none", {
        location: "杭州",
        timeRange: "today",
      }),
    ])),
    want: route("execute", "task", "orchestrated", "vehicle-multi-frame"),
  },
  {
    id: "two-control-writes",
    modelResult: success(vehicleEnvelope("route-two-writes", "none", [
      frame("write-window-1", "control", "body.window.setPosition", "execute", {
        zone: "front_left",
        percent: 20,
      }),
      frame("write-tailgate-2", "control", "body.tailgate.open", "execute", { open: true }),
    ])),
    want: route("execute", "task", "orchestrated", "vehicle-multi-frame"),
    admittedWriteFrameId: "write-window-1",
    deferredWriteFrameIds: ["write-tailgate-2"],
    assistantPattern: /只会处理一个车辆操作/,
  },
  {
    id: "supported-plus-unsupported",
    modelResult: success(vehicleEnvelope("route-partial-capability", "none", [
      frame("supported-window-1", "control", "body.window.setPosition", "execute", {
        zone: "rear_left",
        percent: 0,
      }),
      frame("unsupported-media-2", "media", "media.play", "execute", { query: "古典音乐" }),
    ])),
    want: route("execute", "task", "orchestrated", "vehicle-multi-frame"),
    admittedWriteFrameId: "supported-window-1",
    capabilityDeferredFrameIds: ["unsupported-media-2"],
    assistantPattern: /媒体播放目前还不能完成/,
  },
  {
    id: "mixed-only-unsupported",
    modelResult: success(vehicleEnvelope("route-mixed-unsupported", "social", [
      frame("unsupported-navigation-only", "navigation", "navigation.planRoute", "execute", {
        origin: "杭州",
        destination: "上海",
      }),
    ], "聊聊旅行并规划路线")),
    want: route("respond", null, null, "unsupported-capability"),
    capabilityDeferredFrameIds: ["unsupported-navigation-only"],
    assistantPattern: /导航目前还不能完成/,
  },
];

for (const testCase of cases) {
  const first = await resolveOnce(testCase, `与路由结构无关的文本甲：${testCase.id}`);
  const second = await resolveOnce(testCase, `completely unrelated raw text B: ${testCase.id}`);

  assert.deepEqual(decisionTuple(first.result), testCase.want, `${testCase.id}: route matrix`);
  assert.deepEqual(stableResolution(first.result), stableResolution(second.result),
    `${testCase.id}: identical semantic result must ignore unrelated rawText`);
  assert.equal(first.calls.length, 1, `${testCase.id}: first resolve calls localModel.parse exactly once`);
  assert.equal(second.calls.length, 1, `${testCase.id}: second resolve calls localModel.parse exactly once`);
  assert.equal(first.calls[0].rawText, `与路由结构无关的文本甲：${testCase.id}`,
    `${testCase.id}: rawText is only forwarded to the semantic parser`);
  assert.deepEqual(first.calls[0].options, {
    requestId: requestIdOf(testCase.modelResult, testCase.id),
    lastVehicleIntent: undefined,
    signal: undefined,
    deadlineAt: undefined,
  }, `${testCase.id}: parser options remain bounded`);

  assert.deepEqual(Object.keys(first.result).sort(), [
    "assistantResponse",
    "decision",
    "executionDisabled",
    "parsedCommand",
    "semanticEnvelope",
    "semanticTelemetry",
    "validation",
  ], `${testCase.id}: route resolution exposes the complete contract`);
  assert.equal(first.result.executionDisabled, testCase.executionDisabled === true,
    `${testCase.id}: executionDisabled`);
  assert.equal(first.result.semanticTelemetry, TELEMETRY, `${testCase.id}: telemetry is forwarded without authority`);
  assert.equal(first.result.parsedCommand.rawText, "", `${testCase.id}: projected command has no raw-text authority`);
  assert.notEqual(first.result.parsedCommand.requestId, FORGED_LEGACY_COMMAND.requestId,
    `${testCase.id}: legacy command requestId is ignored`);
  assert.equal(Object.isFrozen(first.result.decision), true, `${testCase.id}: decision is frozen`);
  assert.equal(Object.isFrozen(first.result.validation), true, `${testCase.id}: validation is frozen`);
  assert.equal(Object.isFrozen(first.result.semanticEnvelope), true, `${testCase.id}: envelope is frozen or null`);

  const terminal = first.result.decision.disposition !== "execute";
  if (terminal) {
    assert.deepEqual([first.result.decision.routeId, first.result.decision.mode], [null, null],
      `${testCase.id}: terminal result selects no route`);
    assert.equal(first.result.validation.admittedWriteFrameId, null,
      `${testCase.id}: terminal result admits zero writes`);
    assert.ok(first.result.assistantResponse, `${testCase.id}: terminal result has structured assistant copy`);
  }
  if (testCase.assistantPattern) {
    assert.match(first.result.assistantResponse, testCase.assistantPattern, `${testCase.id}: structured boundary copy`);
  }
  assert.equal(first.result.validation.admittedWriteFrameId, testCase.admittedWriteFrameId ?? null,
    `${testCase.id}: admitted write candidate`);
  assert.deepEqual(first.result.validation.deferredWriteFrameIds, testCase.deferredWriteFrameIds ?? [],
    `${testCase.id}: extra writes are retained as deferred`);
  assert.deepEqual(
    first.result.validation.capabilityValidation.deferredFrameIds,
    testCase.capabilityDeferredFrameIds ?? [],
    `${testCase.id}: unsupported capability frames are retained as deferred`,
  );
  testCase.assertResult?.(first.result);
}

const missingExpectations = new Map([
  ["missing-window", ["percent"]],
  ["missing-tailgate", ["open"]],
  ["missing-seat", ["angle"]],
  ["missing-climate", ["control", "temperature"]],
]);
for (const [id, missingRequiredSlots] of missingExpectations) {
  const testCase = cases.find((entry) => entry.id === id);
  const { result } = await resolveOnce(testCase, `missing-slot-audit:${id}`);
  assert.deepEqual(result.validation.slotValidation.frames, [{
    frameId: `${id}-frame`,
    intent: testCase.modelResult.semanticEnvelope.vehicleFrames[0].intent,
    missingRequiredSlots,
  }], `${id}: missing slots are exact schema-derived keys`);
  assert.ok(!result.assistantResponse.includes("请补充需要执行的具体参数。"),
    `${id}: clarification must be targeted rather than generic`);
}

for (const disposition of ["clarify", "respond", "cancel"]) {
  assert.doesNotThrow(
    () => createRouteDecision({ disposition, routeId: null, mode: null }),
    `${disposition}: supported terminal RouteDecision`,
  );
  assert.throws(
    () => createRouteDecision({ disposition, routeId: "chat", mode: "direct" }),
    /cannot select a use case/,
    `${disposition}: terminal RouteDecision cannot select a use case`,
  );
}

console.log(`Vehicle-SLU route policy verification passed (${cases.length} matrix cases)`);

const genericFollowupEnvelope = success(vehicleEnvelope("route-openqa-followup", "explain", [
  frame("wrong-domain-knowledge", "knowledge", "vehicle.knowledge.query", "none", {
    query: "用一个日常例子解释一下",
  }),
]));
const genericFollowup = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(genericFollowupEnvelope) },
}).resolve("用一个日常例子解释一下。", { requestId: "route-openqa-followup" });
assert.equal(genericFollowup.decision.routeId, "vehicle-knowledge", "the model envelope owns follow-up routing");
assert.deepEqual(genericFollowup.semanticEnvelope, genericFollowupEnvelope.semanticEnvelope, "raw follow-up phrasing cannot clear model frames");
for (const [index, text] of ["简单说说背后的原因就好。", "再来一句短一点的。"].entries()) {
  const followup = await new RoutePolicy({
    localModel: { parse: async () => cloneModelResult(genericFollowupEnvelope) },
  }).resolve(text, { requestId: `route-openqa-followup-${index + 2}` });
  assert.equal(followup.decision.routeId, "vehicle-knowledge", `${text}: preserve the model route`);
  assert.deepEqual(followup.semanticEnvelope, genericFollowupEnvelope.semanticEnvelope, `${text}: no raw semantic override`);
}

const vehicleFollowup = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(genericFollowupEnvelope) },
}).resolve("用一个日常例子解释一下。", {
  requestId: "route-vehicle-followup",
  lastVehicleIntent: "vehicle.knowledge.query",
});
assert.equal(vehicleFollowup.decision.routeId, "vehicle-knowledge",
  "a known vehicle-knowledge context must not be rewritten as general chat");

for (const [text, requestId, expectedNeed] of [
  ["什么是能量守恒？", "route-explicit-general-question", "explain"],
  ["为什么雨后的空气闻起来不一样？", "route-explicit-why-question", "explain"],
  ["给今天的自己写一句打气的话。", "route-explicit-encouragement", "social"],
]) {
  let calls = 0;
  const envelope = { ...generalEnvelope(requestId), conversationGoal: { summary: "模型确认的普通请求", need: expectedNeed } };
  const result = await new RoutePolicy({
    localModel: { parse: async () => { calls++; return success(envelope); } },
  }).resolve(text, { requestId });
  assert.equal(calls, 1, `${text}: ordinary requests use one Vehicle-SLU call`);
  assert.equal(result.decision.routeId, "chat", `${text}: model-selected Cabin chat`);
  assert.equal(result.semanticEnvelope.conversationGoal.need, expectedNeed);
  assert.deepEqual(result.semanticEnvelope.vehicleFrames, [], `${text}: do not create vehicle actions`);
}

let vehicleQuestionModelCalls = 0;
const vehicleQuestion = await new RoutePolicy({
  localModel: {
    async parse() {
      vehicleQuestionModelCalls += 1;
      return success(vehicleEnvelope("route-vehicle-question", "explain", [
        frame("vehicle-question", "knowledge", "vehicle.knowledge.query", "none", {
          query: "ES8 车窗防夹是什么",
          vehicleModel: "ES8",
        }),
      ]));
    },
  },
}).resolve("什么是 ES8 车窗防夹？", { requestId: "route-vehicle-question" });
assert.equal(vehicleQuestionModelCalls, 1, "vehicle-related questions must remain under Vehicle-SLU interpretation");
assert.equal(vehicleQuestion.decision.routeId, "vehicle-knowledge");

for (const [text, requestId, stateFields] of [
  ["现在的挡位和车速分别是多少？", "route-direct-state-gear-speed", ["gear", "speedKph"]],
  ["后备厢现在是开着还是关着？", "route-direct-state-tailgate", ["tailgateOpen"]],
]) {
  let modelCalls = 0;
  const result = await new RoutePolicy({
    localModel: { parse: async () => { modelCalls += 1; return success(vehicleEnvelope(requestId, "explain", [
      frame("model-state-query", "knowledge", "vehicle.state.query", "none", { stateFields }),
    ])); } },
  }).resolve(text, { requestId });
  assert.equal(modelCalls, 1, `${text}: current-state questions require model semantics`);
  assert.equal(result.decision.routeId, "vehicle-knowledge");
  assert.deepEqual(result.semanticEnvelope.vehicleFrames.map(({ intent, actionNeed, slots }) => ({
    intent, actionNeed, slots,
  })), [{ intent: "vehicle.state.query", actionNeed: "none", slots: { stateFields } }]);
  assert.equal(result.validation.admittedWriteFrameId, null, `${text}: state questions must remain read-only`);
}

const pendingWindow = {
  taskId: "pending-window-open",
  frameId: "pending-window-frame",
  intent: "body.window.setPosition",
  acceptedSlots: { zone: "front_left" },
  missingSlots: ["percent"],
  clarificationQuestion: "请告诉我车窗要调到多少开度。",
};
const stateOnlyMusicSpeedModelResult = success(vehicleEnvelope("route-explicit-music-speed", "explain", [
  frame("state-only", "knowledge", "vehicle.state.query", "none", { stateFields: ["speedKph"] }),
]));
const explicitMusicSpeed = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(stateOnlyMusicSpeedModelResult) },
}).resolve("我想听歌，也想知道现在车速。", { requestId: "route-explicit-music-speed" });
assert.deepEqual(explicitMusicSpeed.semanticEnvelope, stateOnlyMusicSpeedModelResult.semanticEnvelope,
  "a missing music frame cannot be recovered from raw text");
assert.equal(explicitMusicSpeed.validation.admittedWriteFrameId, null,
  "state-read projection must not create vehicle writes");

const explicitClimateMusic = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(stateOnlyMusicSpeedModelResult) },
}).resolve("先告诉我车内温度和电量，再播放轻音乐。", { requestId: "route-explicit-climate-music" });
assert.deepEqual(explicitClimateMusic.semanticEnvelope, stateOnlyMusicSpeedModelResult.semanticEnvelope,
  "raw mixed requests cannot change state fields or add media frames");

const negativeMusicSpeed = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(stateOnlyMusicSpeedModelResult) },
}).resolve("别播放音乐，只告诉我车速。", { requestId: "route-negative-music-speed" });
assert.deepEqual(negativeMusicSpeed.semanticEnvelope.vehicleFrames.map(({ intent }) => intent), ["vehicle.state.query"],
  "a negative media request must preserve the state query without creating a media frame");

const directNegativeMusicSpeed = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(stateOnlyMusicSpeedModelResult) },
}).resolve("不播放音乐，只告诉我车速。", { requestId: "route-direct-negative-music-speed" });
assert.deepEqual(directNegativeMusicSpeed.semanticEnvelope.vehicleFrames.map(({ intent }) => intent), ["vehicle.state.query"],
  "a direct negative playback phrase must keep the state query only");

const negativeDesireMusicSpeed = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(stateOnlyMusicSpeedModelResult) },
}).resolve("我不想听歌，只想知道现在车速。", { requestId: "route-negative-desire-music-speed" });
assert.deepEqual(negativeDesireMusicSpeed.semanticEnvelope.vehicleFrames.map(({ intent }) => intent), ["vehicle.state.query"],
  "a negative music mention must not trigger the explicit music mapping");

const hypotheticalMusicSpeed = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(stateOnlyMusicSpeedModelResult) },
}).resolve("如果我想听歌，也想知道现在车速。", { requestId: "route-hypothetical-music-speed" });
assert.deepEqual(hypotheticalMusicSpeed.semanticEnvelope.vehicleFrames.map(({ intent }) => intent), ["vehicle.state.query"],
  "a hypothetical music mention must not trigger the explicit music mapping");

const reportedMusicSpeed = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(stateOnlyMusicSpeedModelResult) },
}).resolve("我朋友想听歌，也想知道现在车速。", { requestId: "route-reported-music-speed" });
assert.deepEqual(reportedMusicSpeed.semanticEnvelope.vehicleFrames.map(({ intent }) => intent), ["vehicle.state.query"],
  "a third-party report must not become the current user's media command");

const abbreviatedMusicSpeed = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(stateOnlyMusicSpeedModelResult) },
}).resolve("想听歌，也想知道现在车速。", { requestId: "route-abbreviated-music-speed" });
assert.deepEqual(abbreviatedMusicSpeed.semanticEnvelope, stateOnlyMusicSpeedModelResult.semanticEnvelope,
  "elliptical phrasing cannot recover missing model frames");

const pendingMusicSpeed = await new RoutePolicy({
  localModel: { parse: async () => cloneModelResult(stateOnlyMusicSpeedModelResult) },
}).resolve("我想听歌，也想知道现在车速。", {
  requestId: "route-pending-music-speed",
  pending: pendingWindow,
});
assert.deepEqual(pendingMusicSpeed.semanticEnvelope.vehicleFrames.map(({ intent }) => intent), ["vehicle.state.query"],
  "an open clarification must prevent a new standalone music mapping from stealing the turn");

const cancelThenOpenTailgate = await new RoutePolicy({
  localModel: {
    parse: async () => success(vehicleEnvelope("route-cancel-then-tailgate", "none", [
      frame("tailgate-new-command", "control", "body.tailgate.open", "none", { open: true }),
    ])),
  },
}).resolve("算了，帮我把尾门打开", {
  requestId: "route-cancel-then-tailgate",
  pending: pendingWindow,
});
assert.equal(cancelThenOpenTailgate.decision.routeId, "chat",
  "raw cancel-and-open text cannot upgrade the model actionNeed:none");
assert.equal(cancelThenOpenTailgate.clarificationTransition.action, "preserve");
assert.deepEqual(cancelThenOpenTailgate.semanticEnvelope.vehicleFrames.map(({ intent, actionNeed, slots }) => ({
  intent, actionNeed, slots,
})), [{ intent: "body.tailgate.open", actionNeed: "none", slots: { open: true } }]);

let conflictingFrontWindowModelCalls = 0;
const conflictingFrontWindow = await new RoutePolicy({
  localModel: {
    parse: async () => {
      conflictingFrontWindowModelCalls += 1;
      return success(vehicleEnvelope("route-conflicting-front-window-model", "none", [
        frame("unsafe-close-front-window", "control", "body.window.setPosition", "execute", {
          zone: "front_right",
          percent: 0,
        }),
      ]));
    },
  },
}).resolve("关上主副驾车窗打开一点点", { requestId: "route-conflicting-front-window" });
assert.equal(conflictingFrontWindowModelCalls, 1,
  "conflicting raw directions still use the single model parser");
assert.deepEqual(decisionTuple(conflictingFrontWindow), route("execute", "vehicle-control", "direct", "complete-vehicle-control"));
assert.deepEqual(conflictingFrontWindow.semanticEnvelope.vehicleFrames.map(({ intent, actionNeed, slots }) => ({
  intent, actionNeed, slots,
})), [{ intent: "body.window.setPosition", actionNeed: "execute", slots: { zone: "front_right", percent: 0 } }],
  "RoutePolicy cannot replace model targets with a raw grouped-window interpretation");

for (const [utterance, requestId, modelFrames] of [
  [
    "前窗全部关死",
    "route-reviewed-front-window-group-close",
    [frame("partial-front-close", "control", "body.window.setPosition", "execute", {
      zone: "front_left", percent: 0,
    })],
    [{ zone: "front_left", percent: 0 }, { zone: "front_right", percent: 0 }],
  ],
  [
    "前排车窗开到百分之七十后排车窗开到百分之六十",
    "route-reviewed-front-rear-window-groups",
    [
      frame("missing-front-zones", "control", "body.window.setPosition", "clarify", { percent: 70 }),
      frame("missing-rear-zones", "control", "body.window.setPosition", "clarify", { percent: 60 }),
    ],
    [
      { zone: "front_left", percent: 70 },
      { zone: "front_right", percent: 70 },
      { zone: "rear_left", percent: 60 },
      { zone: "rear_right", percent: 60 },
    ],
  ],
]) {
  const groupedWindowResult = await new RoutePolicy({
    localModel: {
      parse: async () => success(vehicleEnvelope(requestId, "none", modelFrames)),
    },
  }).resolve(utterance, { requestId });
  assert.equal(groupedWindowResult.decision.routeId, modelFrames[0].actionNeed === "execute" ? "vehicle-control" : null);
  assert.deepEqual(groupedWindowResult.semanticEnvelope.vehicleFrames.map(({ intent, actionNeed, slots }) => ({
    intent, actionNeed, slots,
  })), modelFrames.map(({ intent, actionNeed, slots }) => ({ intent, actionNeed, slots })),
  `${utterance}: preserve model window frames without raw group expansion`);
}

for (const [utterance, requestId] of [
  [
    "打开空调空调风挡调二挡",
    "route-reviewed-climate-fan-level",
    "cabin.climate.setPreset",
    { climatePower: true, fanLevel: 2 },
  ],
  [
    "打开空调打开空调一挡",
    "route-reviewed-climate-one-bar",
    "cabin.climate.setPreset",
    { climatePower: true, fanLevel: 1 },
  ],
  [
    "风力等级调到最小",
    "route-reviewed-climate-minimum-airflow",
    "cabin.climate.setPreset",
    { climatePower: true, fanLevel: 1 },
  ],
  [
    "将空调温度调至二十五风速调到四",
    "route-reviewed-climate-temperature-and-fan",
    "cabin.climate.setPreset",
    { temperature: 25, fanLevel: 4, climatePower: true },
  ],
  [
    "关闭全部车窗打开空调",
    "route-reviewed-windows-and-climate",
    "cabin.comfort.applySettings",
    {
      windowTargets: [
        { zone: "front_left", percent: 0 }, { zone: "front_right", percent: 0 },
        { zone: "rear_left", percent: 0 }, { zone: "rear_right", percent: 0 },
      ],
      climatePower: true,
    },
  ],
  [
    "开窗通风关闭空调",
    "route-reviewed-ventilation-windows-and-climate",
    "cabin.comfort.applySettings",
    {
      windowTargets: [
        { zone: "front_left", percent: 100 }, { zone: "front_right", percent: 100 },
        { zone: "rear_left", percent: 100 }, { zone: "rear_right", percent: 100 },
      ],
      climatePower: false,
    },
  ],
]) {
  const climateResult = await new RoutePolicy({
    localModel: {
      parse: async () => success(vehicleEnvelope(requestId, "none", [
        frame("wrong-climate-frame", "control", "cabin.climate.setPreset", "clarify", {}),
      ])),
    },
  }).resolve(utterance, { requestId });
  assert.ok(climateResult.semanticEnvelope, `${utterance}: expected a valid semantic envelope, got ${JSON.stringify(climateResult.decision)}`);
  assert.deepEqual(climateResult.semanticEnvelope.vehicleFrames.map(({ intent, actionNeed, slots }) => ({
    intent, actionNeed, slots,
  })), [{ intent: "cabin.climate.setPreset", actionNeed: "clarify", slots: {} }],
  `${utterance}: raw controls cannot fill the model missing control slot`);
  assert.equal(climateResult.decision.disposition, "clarify");
}

const parkComfortPartialExecution = await new RoutePolicy({
  localModel: {
    parse: async () => success(vehicleEnvelope("route-reviewed-park-comfort-partial", "none", [
      frame("ambiguous-park-comfort", "control", "cabin.comfort.applySettings", "clarify", {}),
    ])),
  },
}).resolve("打开空调打开驻车舒享", { requestId: "route-reviewed-park-comfort-partial" });
assert.equal(parkComfortPartialExecution.semanticEnvelope, null,
  "raw parking-comfort phrasing cannot repair an invalid model clarification frame");
assert.equal(parkComfortPartialExecution.decision.disposition, "respond");
assert.equal(parkComfortPartialExecution.executionDisabled, true);
assert.equal(parkComfortPartialExecution.validation.admittedWriteFrameId, null);

const reviewedSeatOverride = await new RoutePolicy({
  localModel: {
    parse: async () => success(vehicleEnvelope("route-reviewed-seat-vertical", "none", [
      frame("wrong-seat-angle", "control", "seat.driver.setBackrestAngle", "execute", {
        seat: "driver", angle: 0,
      }),
    ])),
  },
}).resolve("主驾座椅竖直", { requestId: "route-reviewed-seat-vertical" });
assert.deepEqual(reviewedSeatOverride.semanticEnvelope.vehicleFrames.map(({ intent, actionNeed, slots }) => ({
  intent, actionNeed, slots,
})), [{
  intent: "seat.driver.setBackrestAngle",
  actionNeed: "execute",
  slots: { seat: "driver", angle: 0 },
}], "raw vertical-backrest phrasing cannot overwrite the model target");

const confirmedAsrNoiseWindowClose = await new RoutePolicy({
  localModel: {
    parse: async () => success(vehicleEnvelope("route-reviewed-asr-noise-window-close", "none", [])),
  },
}).resolve("先不外面哗哗下雨呢，快把右后窗关严实咯！", {
  requestId: "route-reviewed-asr-noise-window-close",
});
assert.deepEqual(confirmedAsrNoiseWindowClose.semanticEnvelope.vehicleFrames, [],
  "an ASR-specific raw preface cannot create a missing model command");
assert.equal(confirmedAsrNoiseWindowClose.decision.disposition, "clarify");

const explicitWindowEndpoint = await new RoutePolicy({
  localModel: {
    parse: async () => success(vehicleEnvelope("route-reviewed-window-endpoint", "none", [])),
  },
}).resolve("后排左侧窗户拉到底", { requestId: "route-reviewed-window-endpoint" });
assert.deepEqual(explicitWindowEndpoint.semanticEnvelope.vehicleFrames, [],
  "raw window endpoints cannot create a missing model command");
assert.equal(explicitWindowEndpoint.decision.disposition, "clarify");

const rearSeatbeltReminder = await new RoutePolicy({
  localModel: {
    parse: async () => success(vehicleEnvelope("route-reviewed-rear-seatbelt-reminder", "explain", [
      frame("rear-seatbelt-manual-query", "knowledge", "vehicle.knowledge.query", "none", {
        query: "ES8 如何在对应座位的儿童座椅模式中关闭安全带未系提醒？",
      }),
    ])),
  },
}).resolve("关闭后排安全带提醒", { requestId: "route-reviewed-rear-seatbelt-reminder" });
assert.equal(rearSeatbeltReminder.validation.admittedWriteFrameId, null,
  "rear-seat safety settings must never be expanded into rear-window writes");
assert.equal(rearSeatbeltReminder.decision.routeId, "vehicle-knowledge",
  "a rear-seat reference must not replace a manual answer with rear-window control");

for (const [utterance, requestId, expectedQuery] of [
  [
    "关闭后排安全带提醒",
    "route-reviewed-seatbelt-manual-guidance",
    "ES8 如何在对应座位的儿童座椅模式中关闭安全带未系提醒？",
  ],
  [
    "座椅一键成床",
    "route-reviewed-sofa-bed-manual-guidance",
    "ES8“座椅一键成床”对应的沙发床模式及适用座椅、驻车和操作条件",
  ],
  [
    "帮我看下前面的窗户能不能关上",
    "route-reviewed-front-window-capability-question",
    "前排车窗是否可以关闭",
  ],
]) {
  let calls = 0;
  const manualGuidance = await new RoutePolicy({
    localModel: {
      parse: async () => { calls++; return success(vehicleEnvelope(requestId, "explain", [
        frame("model-manual-guidance", "knowledge", "vehicle.knowledge.query", "none", { query: expectedQuery }),
      ])); },
    },
  }).resolve(utterance, { requestId });
  assert.equal(calls, 1, "manual guidance requires one model interpretation");
  assert.equal(manualGuidance.decision.semanticSource, "model");
  assert.equal(manualGuidance.decision.routeId, "vehicle-knowledge");
  assert.equal(manualGuidance.validation.admittedWriteFrameId, null);
  assert.equal(manualGuidance.semanticEnvelope.vehicleFrames[0].slots.query, expectedQuery);
}

const tailgateLockGuidance = await new RoutePolicy({
  localModel: {
    parse: async () => semanticFailure("semantic-endpoint-unavailable"),
  },
}).resolve("尾箱门锁好咧", { requestId: "route-reviewed-tailgate-lock" });
assert.equal(tailgateLockGuidance.decision.semanticSource, "model");
assert.equal(tailgateLockGuidance.executionDisabled, true, "an unavailable model cannot be recovered by a raw safety rejection");
assert.equal(tailgateLockGuidance.decision.disposition, "respond");
assert.equal(tailgateLockGuidance.validation.admittedWriteFrameId, null);

async function resolveOnce(testCase, rawText) {
  const calls = [];
  const requestId = requestIdOf(testCase.modelResult, testCase.id);
  const policy = new RoutePolicy({
    localModel: {
      async parse(receivedRawText, options) {
        calls.push({ rawText: receivedRawText, options });
        return cloneModelResult(testCase.modelResult);
      },
    },
  });
  return {
    calls,
    result: await policy.resolve(rawText, { requestId }),
  };
}

function stableResolution(result) {
  return {
    decision: result.decision,
    parsedCommand: result.parsedCommand,
    semanticEnvelope: result.semanticEnvelope,
    executionDisabled: result.executionDisabled,
    assistantResponse: result.assistantResponse,
    validation: result.validation,
  };
}

function decisionTuple(result) {
  return [result.decision.disposition, result.decision.routeId, result.decision.mode, result.decision.reasonCode];
}

function route(disposition, routeId, mode, reasonCode) {
  return [disposition, routeId, mode, reasonCode];
}

function completeControlCases() {
  return [
    ["window", "body.window.setPosition", { zone: "front_right", percent: 50 }],
    ["tailgate", "body.tailgate.open", { open: true }],
    ["seat", "seat.driver.setBackrestAngle", { seat: "driver", angle: 106 }],
    ["climate", "cabin.climate.setPreset", { temperature: 24 }],
  ].map(([id, intent, slots]) => ({
    id: `complete-${id}`,
    modelResult: success(vehicleEnvelope(`route-complete-${id}`, "none", [
      frame(`complete-${id}-frame`, "control", intent, "execute", slots),
    ])),
    want: route("execute", "vehicle-control", "direct", "complete-vehicle-control"),
    admittedWriteFrameId: `complete-${id}-frame`,
  }));
}

function missingControlCases() {
  const assistantPatternById = {
    window: /percent|多少开度|车窗开度/,
    tailgate: /open|尾门|后备箱/,
    seat: /angle|靠背.*多少度|目标靠背角度/,
    climate: /temperature|温度|多少度/,
  };
  return [
    ["window", "body.window.setPosition", { zone: "front_right" }],
    ["tailgate", "body.tailgate.open", {}],
    ["seat", "seat.driver.setBackrestAngle", { seat: "driver" }],
    ["climate", "cabin.climate.setPreset", {}],
  ].map(([id, intent, slots]) => ({
    id: `missing-${id}`,
    modelResult: success(vehicleEnvelope(`route-missing-${id}`, "none", [
      frame(`missing-${id}-frame`, "control", intent, "clarify", slots),
    ])),
    want: route("clarify", null, null, "missing-required-slots"),
    assistantPattern: assistantPatternById[id],
  }));
}

function unsupportedCapabilityCases() {
  return [
    ["navigation", "navigation.planRoute", { origin: "杭州", destination: "上海" }],
    ["media", "media.play", { query: "古典音乐" }],
    ["phone", "phone.call", { contact: "张三" }],
  ].map(([capability, intent, slots]) => ({
    id: `unsupported-${capability}`,
    modelResult: success(vehicleEnvelope(`route-unsupported-${capability}`, "none", [
      frame(`unsupported-${capability}-frame`, capability, intent, "execute", slots),
    ])),
    want: route("respond", null, null, "unsupported-capability"),
    capabilityDeferredFrameIds: [`unsupported-${capability}-frame`],
    assistantPattern: /目前还不能完成/,
  }));
}

function success(semanticEnvelope) {
  return {
    semanticEnvelope,
    command: FORGED_LEGACY_COMMAND,
    executionDisabled: false,
    reasonCode: "",
    telemetry: TELEMETRY,
  };
}

function semanticFailure(reasonCode) {
  return {
    semanticEnvelope: null,
    command: FORGED_LEGACY_COMMAND,
    executionDisabled: true,
    reasonCode,
    telemetry: TELEMETRY,
  };
}

function generalEnvelope(requestId) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId,
    domain: "non_vehicle",
    conversationGoal: { summary: "普通聊天", need: "social" },
    vehicleFrames: [],
    domainConfidence: 0.4,
  };
}

function unknownEnvelope(requestId) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId,
    domain: "unknown",
    conversationGoal: { summary: "需要确认用户需求", need: "none" },
    vehicleFrames: [],
    domainConfidence: 0.3,
  };
}

function vehicleEnvelope(requestId, need, vehicleFrames, summary = "处理结构化车载请求") {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId,
    domain: "vehicle",
    conversationGoal: { summary, need },
    vehicleFrames,
    domainConfidence: 0.96,
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
    clarificationQuestion: actionNeed === "clarify" ? `请告诉我缺少的${missingSlots.join("、")}。` : null,
    standaloneQuery: manual ? slots.query : null,
    confidence: 0.94,
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

function requestIdOf(modelResult, id) {
  return modelResult.semanticEnvelope?.requestId || `route-${id}`;
}

function cloneModelResult(modelResult) {
  return {
    ...modelResult,
    semanticEnvelope: modelResult.semanticEnvelope === null
      ? null
      : structuredClone(modelResult.semanticEnvelope),
  };
}
