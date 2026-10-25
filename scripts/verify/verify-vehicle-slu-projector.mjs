import assert from "node:assert/strict";
import { createVehicleSluEnvelope } from "../../src/semantic/vehicle-slu-contract.js";
import { projectVehicleSluEnvelope } from "../../src/semantic/vehicle-slu-projector.js";

const mixedEnvelope = createVehicleSluEnvelope({
  contractVersion: "nio-vehicle-slu-contract@2.0.0",
  requestId: "project:mixed",
  domain: "vehicle",
  conversationGoal: { summary: "解释防夹功能并打开副驾车窗", need: "explain" },
  vehicleFrames: [
    frame({
      frameId: "manual-1",
      capability: "knowledge",
      intent: "vehicle.knowledge.query",
      speechAct: "question",
      knowledgeNeed: "manual",
      slots: { query: "ES8 车窗防夹功能", vehicleModel: "ES8" },
      standaloneQuery: "ES8 车窗防夹功能如何工作",
      confidence: 0.96,
    }),
    frame({
      frameId: "execute-1",
      capability: "control",
      intent: "body.window.setPosition",
      speechAct: "command",
      actionNeed: "execute",
      slots: { zone: "front_right", percent: 50 },
      confidence: 0.97,
    }),
    frame({
      frameId: "clarify-1",
      capability: "control",
      intent: "seat.driver.setBackrestAngle",
      speechAct: "command",
      actionNeed: "clarify",
      slots: { seat: "driver" },
      missingSlots: ["angle"],
      clarificationQuestion: "你希望主驾靠背调到多少度？",
      confidence: 0.91,
    }),
  ],
  domainConfidence: 0.98,
});

const projected = projectVehicleSluEnvelope(mixedEnvelope);
assert.deepEqual(Object.keys(projected).sort(), [
  "clarifyFrames",
  "conversationGoal",
  "domain",
  "domainConfidence",
  "executeFrames",
  "manualFrames",
  "needs",
  "requestId",
  "vehicleFrames",
].sort(), "projector exposes only Vehicle-SLU 2.0 dimensions");
assert.equal(projected.requestId, "project:mixed");
assert.equal(projected.domain, "vehicle");
assert.equal(projected.domainConfidence, 0.98);
assert.deepEqual(projected.conversationGoal, {
  summary: "解释防夹功能并打开副驾车窗",
  need: "explain",
});
assert.deepEqual(projected.vehicleFrames, mixedEnvelope.vehicleFrames,
  "all frames and model order must be preserved without folding");
assert.deepEqual(projected.manualFrames.map(({ frameId }) => frameId), ["manual-1"]);
assert.deepEqual(projected.executeFrames.map(({ frameId }) => frameId), ["execute-1"]);
assert.deepEqual(projected.clarifyFrames.map(({ frameId }) => frameId), ["clarify-1"]);
assert.deepEqual(projected.needs, { manual: true, execute: true, clarify: true });
assert.equal(Object.isFrozen(projected), true);
assert.equal(Object.isFrozen(projected.vehicleFrames), true);
assert.equal(Object.isFrozen(projected.vehicleFrames[0].slots), true);
assert.notEqual(projected.vehicleFrames, mixedEnvelope.vehicleFrames,
  "projection must not retain the caller's mutable array identity");

for (const [domain, need] of [["non_vehicle", "social"], ["unknown", "none"]]) {
  const envelope = createVehicleSluEnvelope({
    contractVersion: "nio-vehicle-slu-contract@2.0.0",
    requestId: `project:${domain}`,
    domain,
    conversationGoal: { summary: `处理 ${domain}`, need },
    vehicleFrames: [],
    domainConfidence: 0.5,
  });
  const result = projectVehicleSluEnvelope(envelope);
  assert.deepEqual(result.vehicleFrames, []);
  assert.deepEqual(result.manualFrames, []);
  assert.deepEqual(result.executeFrames, []);
  assert.deepEqual(result.clarifyFrames, []);
  assert.deepEqual(result.needs, { manual: false, execute: false, clarify: false });
}

assert.throws(
  () => projectVehicleSluEnvelope({ ...mixedEnvelope, contractVersion: "wrong" }),
  /invalid Vehicle-SLU envelope/,
);

console.log("Vehicle-SLU 2.0 projector verification passed");

function frame(input) {
  return {
    frameId: input.frameId,
    capability: input.capability,
    intent: input.intent,
    speechAct: input.speechAct,
    knowledgeNeed: input.knowledgeNeed ?? "none",
    actionNeed: input.actionNeed ?? "none",
    slots: input.slots,
    missingSlots: input.missingSlots ?? [],
    clarificationQuestion: input.clarificationQuestion ?? null,
    standaloneQuery: input.standaloneQuery ?? null,
    confidence: input.confidence,
  };
}
