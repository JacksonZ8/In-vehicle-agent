#!/usr/bin/env node
import assert from "node:assert/strict";
import { createVehicleSluEnvelope } from "../../src/semantic/vehicle-slu-contract.js";
import { projectVehicleSluConversationContext } from "../../src/semantic/vehicle-slu-conversation-context.js";
import { buildVehicleSluCompactV9Prompt } from "../../src/semantic/vehicle-slu-compact-v9.js";
import { createLeanRuntimeVehicleControlHarness } from "../lib/lean-runtime-test-harness.mjs";

const bounded = projectVehicleSluConversationContext({
  frames: [
    { intent: "body.window.setPosition", slots: { zone: "front_left", percent: 10, ignored: "drop" } },
    { intent: "phone.call", slots: { contact: "unsupported" } },
    { intent: "body.window.setPosition", slots: { zone: "front_right", percent: 20 } },
    { intent: "body.window.setPosition", slots: { zone: "rear_left", percent: 30 } },
    { intent: "body.window.setPosition", slots: { zone: "rear_right", percent: 40 } },
    { intent: "vehicle.knowledge.query", slots: { query: "x".repeat(200) } },
  ],
});
assert.deepEqual(bounded.frames.map(({ intent }) => intent), [
  "body.window.setPosition",
  "body.window.setPosition",
  "body.window.setPosition",
  "vehicle.knowledge.query",
]);
assert.equal(bounded.frames[0].slots.zone, "front_right");
assert.equal(bounded.frames[0].slots.ignored, undefined);
assert.equal(bounded.frames[3].slots.query.length, 160);

const prompt = buildVehicleSluCompactV9Prompt({
  text: "换成右前窗，开30%",
  conversationContext: {
    frames: [{ intent: "body.window.setPosition", slots: { zone: "front_left", percent: 40 } }],
  },
});
assert.match(prompt, /上一轮语义上下文只用于当前省略指代/);
assert.match(prompt, /不表示车辆状态或已经执行/);
assert.match(prompt, /"percent":40/);
assert.doesNotMatch(buildVehicleSluCompactV9Prompt({ text: "尾门打开。" }), /priorContext:/,
  "prior context is only serialized when the runtime supplies one");
assert.equal(projectVehicleSluConversationContext({
  frames: [{ intent: "phone.call", slots: { contact: "ignored" } }],
}), null);

const observedContexts = [];
const harness = createLeanRuntimeVehicleControlHarness({
  modelBehavior: {
    async parse(_text, options) {
      observedContexts.push(options.conversationContext || null);
      const requestNumber = observedContexts.length;
      const zone = requestNumber === 2 ? "front_right" : "front_left";
      const percent = requestNumber === 2 ? 30 : 40;
      return {
        semanticEnvelope: createVehicleSluEnvelope({
          requestId: options.requestId,
          domain: "vehicle",
          conversationGoal: { summary: "controlled context check", need: "none" },
          domainConfidence: 0.9,
          vehicleFrames: [{
            frameId: `context-check-${requestNumber}`,
            capability: "control",
            intent: "body.window.setPosition",
            speechAct: "command",
            knowledgeNeed: "none",
            actionNeed: "execute",
            slots: { zone, percent },
            missingSlots: [],
            clarificationQuestion: null,
            standaloneQuery: null,
            confidence: 0.9,
          }],
        }),
      };
    },
  },
});

await harness.runtime.run("first controlled request", {
  requestId: "conversation-context:first",
  sessionId: "context-session-a",
});
await harness.runtime.run("follow-up controlled request", {
  requestId: "conversation-context:follow-up",
  sessionId: "context-session-a",
});
assert.deepEqual(observedContexts[1], {
  frames: [{ intent: "body.window.setPosition", slots: { zone: "front_left", percent: 40 } }],
});

await harness.runtime.run("isolated controlled request", {
  requestId: "conversation-context:isolated",
  sessionId: "context-session-b",
});
assert.equal(observedContexts[2], null);

harness.advanceNow(120_000);
await harness.runtime.run("expired controlled request", {
  requestId: "conversation-context:expired",
  sessionId: "context-session-a",
});
assert.equal(observedContexts[3], null);

process.stdout.write("Vehicle-SLU conversation context checks passed.\n");
