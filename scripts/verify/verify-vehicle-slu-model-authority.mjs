import assert from "node:assert/strict";
import { RoutePolicy } from "../../src/application/route-policy.js";
import { createVehicleSluEnvelope, getMissingVehicleSluRequiredSlots } from "../../src/semantic/vehicle-slu-contract.js";
import { evaluateVehicleSluUx } from "../benchmarks/evaluate-vehicle-slu-ux.mjs";

const nonVehicle = (requestId) => createVehicleSluEnvelope({
  requestId,
  domain: "non_vehicle",
  conversationGoal: { summary: "模型判定普通对话", need: "social" },
  vehicleFrames: [],
  domainConfidence: 0.9,
});
const frame = (intent, slots, actionNeed = "execute") => ({
  frameId: "f1", capability: "control", intent, speechAct: "command",
  knowledgeNeed: "none", actionNeed, slots,
  missingSlots: actionNeed === "clarify" ? getMissingVehicleSluRequiredSlots(intent, slots) : [],
  clarificationQuestion: actionNeed === "clarify" ? "请补充明确参数。" : null,
  standaloneQuery: null, confidence: 0.9,
});
const vehicle = (requestId, frames) => createVehicleSluEnvelope({
  requestId, domain: "vehicle", conversationGoal: { summary: "模型结构化意图", need: "none" },
  vehicleFrames: frames, domainConfidence: 0.9,
});
async function resolveWithModel(rawText, semanticEnvelope, options = {}, modelResult = {}) {
  const calls = [];
  const result = await new RoutePolicy({ localModel: {
    async parse(text, parseOptions) {
      calls.push({ text, options: parseOptions });
      return { semanticEnvelope, semanticSource: "untrusted-claimed-source", ...modelResult };
    },
  } }).resolve(rawText, { requestId: "authority-check", runId: "authority-check", ...options });
  assert.equal(calls.length, 1, `${rawText}: exactly one parser call`);
  assert.equal(calls[0].text, rawText, "only forward original text to the model");
  assert.equal(result.decision.semanticSource, "model", "route authority derives from the parser boundary");
  return { result, calls };
}

for (const rawText of [
  "打开尾门", "把主驾窗开到30%", "把前排车窗打开一半", "将空调温度设为22度",
  "把主驾座椅靠背调成竖直", "现在车速是多少", "车窗怎么操作", "别开车窗",
  "我很烦", "什么是能量守恒", "用一个日常例子解释一下", "关闭碰撞预警",
]) {
  const { result } = await resolveWithModel(rawText, nonVehicle("authority-check"));
  assert.equal(result.decision.routeId, "chat", "raw text cannot create a vehicle route");
  assert.equal(result.semanticEnvelope.domain, "non_vehicle");
  assert.deepEqual(result.semanticEnvelope.vehicleFrames, []);
  assert.equal(result.parsedCommand.actionability.actionable, false);
}

const modelWindow = vehicle("authority-check", [frame("body.window.setPosition", { zone: "front_right", percent: 40 })]);
const { result: keptWindow } = await resolveWithModel("主驾车窗调成40%", modelWindow);
assert.deepEqual(keptWindow.parsedCommand.slots, { zone: "front_right", percent: 40 },
  "raw zone cues cannot overwrite the model target");
const { result: missingWindow } = await resolveWithModel("主驾车窗开到30%", vehicle("authority-check", [frame("body.window.setPosition", { zone: "front_left" })]));
assert.equal(missingWindow.decision.disposition, "clarify");
assert.deepEqual(missingWindow.semanticEnvelope.vehicleFrames[0].slots, { zone: "front_left" });
assert.deepEqual(missingWindow.semanticEnvelope.vehicleFrames[0].missingSlots, ["percent"],
  "raw percentage cannot recover a missing model slot");

const pending = {
  taskId: "synthetic-window-task", intent: "body.window.setPosition",
  acceptedSlots: { zone: "front_left" }, missingSlots: ["percent"],
  slotProvenance: { zone: "original-turn" }, clarificationQuestion: "请给出车窗开度。",
  originalUtterance: "模型已确认的车窗请求",
};
const { result: pendingChat } = await resolveWithModel("三成吧", nonVehicle("authority-check"), { pending });
assert.equal(pendingChat.decision.routeId, "chat", "raw pending answer cannot manufacture a control frame");
assert.equal(pendingChat.clarificationTransition.action, "preserve");
const { result: pendingResolved, calls: pendingCalls } = await resolveWithModel("由模型解释的补答", vehicle("authority-check", [frame("body.window.setPosition", { percent: 30 }, "clarify")]), { pending });
assert.equal(pendingCalls[0].options.pending, pending);
assert.equal(pendingResolved.clarificationTransition.action, "resolve");
assert.equal(pendingResolved.decision.routeId, "vehicle-control");
assert.deepEqual(pendingResolved.parsedCommand.slots, { zone: "front_left", percent: 30 });
assert.deepEqual(pendingResolved.parsedCommand.slotProvenance, { zone: "original-turn", percent: "clarification-turn" });

for (const reasonCode of ["semantic-timeout", "semantic-endpoint-unavailable", "semantic-contract-invalid"]) {
  const { result } = await resolveWithModel("打开尾门", null, {}, { executionDisabled: true, reasonCode });
  assert.equal(result.decision.disposition, "respond");
  assert.equal(result.decision.routeId, null);
  assert.equal(result.executionDisabled, true);
  assert.equal(result.parsedCommand.actionability.actionable, false);
}
const { result: invalid } = await resolveWithModel("把主驾窗开到30%", { contractVersion: "invalid" });
assert.equal(invalid.executionDisabled, true);
assert.equal(invalid.decision.routeId, null);
const protectedFrame = { ...frame("safety.reject", {}, "none"), frameId: "f2" };
const { result: protectedResult } = await resolveWithModel("打开空调驻车舒享", vehicle("authority-check", [frame("cabin.climate.setPreset", { climatePower: true }), protectedFrame]));
assert.equal(protectedResult.decision.disposition, "respond", "raw reviewed phrase cannot exempt protected frames");
assert.equal(protectedResult.decision.routeId, null);

const fixture = {
  contractVersion: "vehicle-slu-ux@1.0.0", datasetVersion: "vehicle-slu-ux-user-reviewed-development@0.3.0",
  split: "development", labelReviewStatus: "reviewed",
  cases: [{ id: "synthetic-authority", category: "synthetic", labelReviewStatus: "reviewed",
    source: { author: "synthetic-verifier", method: "synthetic-only", secondReviewer: "synthetic-verifier" },
    turns: [
      { text: "打开尾门", expected: { domain: "non_vehicle", conversationNeed: "social", frames: [], route: { disposition: "execute", routeId: "chat" } } },
      { text: "把主驾窗开到30%", expected: { domain: "non_vehicle", conversationNeed: "social", frames: [], route: { disposition: "execute", routeId: "chat" } } },
    ],
  }],
};
for (const rawModelDiagnostic of [false, true]) {
  let requests = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    let value;
    if (path === "/api/version") value = { version: "synthetic" };
    else if (path === "/api/tags") value = { models: [{ name: "synthetic", digest: "synthetic", size: 0 }] };
    else if (path === "/api/show") value = { details: {} };
    else if (path === "/api/generate") { requests++; value = { response: JSON.stringify({ d: "non_vehicle", n: "social", f: [] }) }; }
    else throw new Error(`Unexpected synthetic request: ${path}`);
    return { ok: true, json: async () => value };
  };
  const report = await evaluateVehicleSluUx({ fixture, models: ["synthetic"], rawModelDiagnostic, fetchImpl });
  assert.equal(requests, 3, "one warmup plus one model request per turn");
  for (const turn of report.models[0].cases[0].turns) {
    assert.equal(turn.result.modelInvocations, 1);
    assert.equal(turn.result.semanticSource, "model");
    assert.equal(turn.result.rawDomain, "non_vehicle");
    assert.deepEqual(turn.result.rawFrames, []);
    assert.deepEqual(turn.result.effectiveFrames, []);
    assert.equal(turn.result.route.routeId, "chat");
  }
}

const pendingFixture = structuredClone(fixture);
pendingFixture.cases[0] = {
  ...pendingFixture.cases[0], id: "synthetic-pending-authority", closureRequired: true, closureTurn: 2,
  turns: [
    { text: "请先问明确的车窗开度", expected: { domain: "vehicle", conversationNeed: "none",
      frames: [{ intent: "body.window.setPosition", actionNeed: "clarify", slots: { zone: "front_left" }, missingSlots: ["percent"] }],
      route: { disposition: "clarify", routeId: null } } },
    { text: "模型解释的补答内容", answeredSlots: ["percent"], expected: { domain: "vehicle", conversationNeed: "none",
      frames: [{ intent: "body.window.setPosition", actionNeed: "clarify", slots: { percent: 30 }, missingSlots: ["zone"] }],
      effectiveFrames: [{ intent: "body.window.setPosition", actionNeed: "execute", slots: { zone: "front_left", percent: 30 }, missingSlots: [] }],
      route: { disposition: "execute", routeId: "vehicle-control" } } },
  ],
};
let pendingRequests = 0;
const pendingReport = await evaluateVehicleSluUx({ fixture: pendingFixture, models: ["synthetic"], fetchImpl: async (url) => {
  const path = new URL(url).pathname;
  let value;
  if (path === "/api/version") value = { version: "synthetic" };
  else if (path === "/api/tags") value = { models: [{ name: "synthetic", digest: "synthetic", size: 0 }] };
  else if (path === "/api/show") value = { details: {} };
  else if (path === "/api/generate") {
    pendingRequests++;
    const slots = pendingRequests === 2 ? { zone: "front_left" } : { percent: 30 };
    value = { response: JSON.stringify({ d: "vehicle", n: "none", f: [{ i: "body.window.setPosition", s: "command", a: "clarify", p: slots }] }) };
  } else throw new Error(`Unexpected synthetic request: ${path}`);
  return { ok: true, json: async () => value };
} });
assert.equal(pendingRequests, 3);
const pendingAnswer = pendingReport.models[0].cases[0].turns[1].result;
assert.equal(pendingAnswer.modelInvocations, 1);
assert.deepEqual(pendingAnswer.rawFrames[0].slots, { percent: 30 }, "evaluator keeps unmerged model slots");
assert.deepEqual(pendingAnswer.effectiveFrames[0].slots, { zone: "front_left", percent: 30 }, "effective frames include only structured pending merge");
assert.equal(pendingAnswer.route.routeId, "vehicle-control");

for (const failure of ["invalid-json", "timeout", "request-error"]) {
  const failureReport = await evaluateVehicleSluUx({ fixture, models: ["synthetic"], fetchImpl: async (url, options = {}) => {
    const path = new URL(url).pathname;
    let value;
    if (path === "/api/version") value = { version: "synthetic" };
    else if (path === "/api/tags") value = { models: [{ name: "synthetic", digest: "synthetic", size: 0 }] };
    else if (path === "/api/show") value = { details: {} };
    else if (path === "/api/generate") {
      const warmup = JSON.parse(options.body).options.num_predict === 1;
      if (!warmup && failure !== "invalid-json") {
        const error = new Error("Synthetic request failure");
        error.code = failure === "timeout" ? "CASE_TIMEOUT" : "SYNTHETIC_REQUEST_ERROR";
        throw error;
      }
      value = { response: "{" };
    } else throw new Error(`Unexpected synthetic request: ${path}`);
    return { ok: true, json: async () => value };
  } });
  for (const turn of failureReport.models[0].cases[0].turns) {
    assert.equal(turn.result.modelInvocations, 1);
    if (failure === "invalid-json") {
      assert.equal(turn.result.status, "contract-invalid");
      assert.equal(turn.result.route.disposition, "respond");
      assert.equal(turn.result.route.routeId, null);
      assert.deepEqual(turn.result.effectiveFrames, []);
    } else {
      assert.equal(turn.result.status, failure === "timeout" ? "timeout" : "generation-error");
      assert.equal(turn.result.errorCode, failure === "timeout" ? "TIMEOUT" : "SYNTHETIC_REQUEST_ERROR");
      assert.equal(turn.result.route, undefined, "request failures cannot select a route");
    }
  }
}

console.log("Vehicle-SLU single-model semantic authority verification passed (synthetic stubs only; no network or vehicle execution)");
