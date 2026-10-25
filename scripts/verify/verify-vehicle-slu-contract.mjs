import assert from "node:assert/strict";
import {
  createVehicleSluEnvelope,
  projectVehicleSluSummary,
  validateVehicleSluEnvelope,
  VEHICLE_SLU_SLOT_SCHEMAS,
  getMissingVehicleSluRequiredSlots,
} from "../../src/semantic/vehicle-slu-contract.js";
import { projectVehicleSluEnvelope } from "../../src/semantic/vehicle-slu-projector.js";
import { buildVehicleSluPrompt } from "../../src/semantic/vehicle-slu-prompt.js";

const controlFrame = {
  frameId: "control-window",
  capability: "control",
  intent: "body.window.setPosition",
  speechAct: "command",
  knowledgeNeed: "none",
  actionNeed: "execute",
  slots: { zone: "front_left", percent: 50 },
  missingSlots: [],
  clarificationQuestion: null,
  standaloneQuery: null,
  confidence: 0.97,
};
const knowledgeFrame = {
  frameId: "knowledge-anti-pinch",
  capability: "knowledge",
  intent: "vehicle.knowledge.query",
  speechAct: "question",
  knowledgeNeed: "manual",
  actionNeed: "none",
  slots: {},
  missingSlots: [],
  clarificationQuestion: null,
  standaloneQuery: "解释车窗防夹",
  confidence: 0.94,
};
const clarifyFrame = {
  ...controlFrame,
  frameId: "clarify-window",
  actionNeed: "clarify",
  slots: { zone: "front_left" },
  missingSlots: ["percent"],
  clarificationQuestion: "主驾车窗要开到多少？",
};
const compoundInput = {
  requestId: "req-compound",
  domain: "vehicle",
  conversationGoal: { summary: "开窗并解释防夹", need: "explain" },
  vehicleFrames: [controlFrame, knowledgeFrame],
  domainConfidence: 0.98,
};

const envelope = createVehicleSluEnvelope(compoundInput);
const validCompoundInput = { ...compoundInput, contractVersion: "nio-vehicle-slu-contract@2.0.0" };
assert.deepEqual(VEHICLE_SLU_SLOT_SCHEMAS["body.window.setPosition"].required, ["zone", "percent"],
  "Vehicle-SLU must publish the canonical required window slots");
assert.deepEqual(VEHICLE_SLU_SLOT_SCHEMAS["body.tailgate.open"].required, ["open"],
  "Vehicle-SLU must publish the canonical required tailgate slots");
assert.deepEqual(VEHICLE_SLU_SLOT_SCHEMAS["seat.driver.setBackrestAngle"].required, ["seat", "angle"],
  "Vehicle-SLU must publish the canonical required seat slots");
assert.deepEqual(VEHICLE_SLU_SLOT_SCHEMAS["cabin.climate.setPreset"].required, [],
  "Vehicle-SLU climate accepts any one explicit control setting");
assert.deepEqual(getMissingVehicleSluRequiredSlots("cabin.climate.setPreset", {}), ["control"]);
assert.equal(envelope.contractVersion, "nio-vehicle-slu-contract@2.0.0");
assert.equal(envelope.vehicleFrames.length, 2);
assert.equal(envelope.vehicleFrames[0].actionNeed, "execute");
assert.equal(envelope.vehicleFrames[1].knowledgeNeed, "manual");
const summary = projectVehicleSluSummary(envelope);
assert.equal(summary.vehicleFrames.length, 2);
assert.deepEqual(summary.vehicleFrames[0].missingSlots, []);
assert.equal(summary.vehicleFrames[0].clarificationQuestion, null);
assert.equal(summary.vehicleFrames[1].standaloneQuery, "解释车窗防夹");
assert.equal(Object.isFrozen(summary.vehicleFrames[0].missingSlots), true);

const clarifyValidation = validateVehicleSluEnvelope({ ...validCompoundInput, vehicleFrames: [clarifyFrame] });
assert.equal(clarifyValidation.ok, true,
  `Vehicle SLU 2.0 accepts an explicit missing-slot clarification frame: ${clarifyValidation.errors.join("; ")}`);

const projected = projectVehicleSluEnvelope(envelope);
assert.equal(projected.executeFrames.length, 1);
assert.equal(projected.manualFrames.length, 1);
assert.equal(projected.executeFrames[0].intent, controlFrame.intent);
assert.equal(projected.manualFrames[0].intent, knowledgeFrame.intent);
assert.notEqual(projected.conversationGoal, envelope.conversationGoal);
assert.notEqual(projected.vehicleFrames, envelope.vehicleFrames);
assert.notEqual(projected.executeFrames[0], envelope.vehicleFrames[0]);
assert.notEqual(projected.manualFrames[0], envelope.vehicleFrames[1]);
assert.equal(Object.isFrozen(projected.conversationGoal), true);
assert.equal(Object.isFrozen(projected.vehicleFrames[0].slots), true);
assert.equal(Object.isFrozen(projected.vehicleFrames[0].missingSlots), true);

const prompt = buildVehicleSluPrompt({
  text: "调到 50%",
  requestId: "req-pending",
  pending: {
    taskId: "task-window",
    intent: controlFrame.intent,
    acceptedSlots: { zone: "front_left" },
    missingSlots: ["percent"],
    clarificationQuestion: "要开到多少？",
    sessionMemory: { zone: "rear_right" },
  },
});
assert.match(prompt, /"taskId":"task-window"/);
assert.match(prompt, /"acceptedSlots":\["zone"\]/);
assert.match(prompt, /missingSlots[,、]clarificationQuestion[,、]standaloneQuery/);
const pendingLine = prompt.split("\n").find((line) => line.startsWith("Pending clarification:"));
// Accepted slot values are re-validated against the current contract; unrelated pending fields never reach the prompt.
assert.match(pendingLine, /"acceptedSlotValues":\{"zone":"front_left"\}/);
assert.doesNotMatch(pendingLine, /rear_right|sessionMemory/);

const missingStandaloneQueryFrame = { ...controlFrame };
delete missingStandaloneQueryFrame.standaloneQuery;

for (const [label, invalid] of [
  ["unknown contract version", { ...validCompoundInput, contractVersion: "nio-vehicle-slu-contract@9.0.0" }],
  ["unknown domain", { ...validCompoundInput, domain: "other" }],
  ["duplicate frameId", { ...validCompoundInput, vehicleFrames: [controlFrame, { ...knowledgeFrame, frameId: controlFrame.frameId }] }],
  ["invalid enum", { ...validCompoundInput, vehicleFrames: [{ ...controlFrame, actionNeed: "answer" }, knowledgeFrame] }],
  ["out of bounds slot", { ...validCompoundInput, vehicleFrames: [{ ...controlFrame, slots: { ...controlFrame.slots, percent: 101 } }, knowledgeFrame] }],
  ["unknown domain requesting RAG", { ...validCompoundInput, domain: "unknown", vehicleFrames: [knowledgeFrame] }],
  ["unknown domain requesting execute", { ...validCompoundInput, domain: "unknown", vehicleFrames: [controlFrame] }],
  ["missing required field", { ...validCompoundInput, vehicleFrames: [missingStandaloneQueryFrame] }],
  ["invalid missingSlots field", { ...validCompoundInput, vehicleFrames: [{ ...clarifyFrame, missingSlots: ["bogus"] }] }],
  ["duplicate missingSlots", { ...validCompoundInput, vehicleFrames: [{ ...clarifyFrame, missingSlots: ["percent", "percent"] }] }],
  ["already supplied missing slot", { ...validCompoundInput, vehicleFrames: [{ ...clarifyFrame, missingSlots: ["zone"] }] }],
  ["clarify without missingSlots", { ...validCompoundInput, vehicleFrames: [{ ...clarifyFrame, missingSlots: [] }] }],
  ["empty clarification question", { ...validCompoundInput, vehicleFrames: [{ ...clarifyFrame, clarificationQuestion: "" }] }],
  ["non-clarify question", { ...validCompoundInput, vehicleFrames: [{ ...controlFrame, clarificationQuestion: "继续吗？" }] }],
  ["manual without standaloneQuery", { ...validCompoundInput, vehicleFrames: [{ ...knowledgeFrame, standaloneQuery: null }] }],
  ["manual with empty standaloneQuery", { ...validCompoundInput, vehicleFrames: [{ ...knowledgeFrame, standaloneQuery: " " }] }],
  ["non-manual standaloneQuery", { ...validCompoundInput, vehicleFrames: [{ ...controlFrame, standaloneQuery: "打开主驾车窗" }] }],
  ["non-clarify missingSlots", { ...validCompoundInput, vehicleFrames: [{ ...controlFrame, missingSlots: ["percent"], slots: { zone: "front_left" } }] }],
]) {
  assert.equal(validateVehicleSluEnvelope(invalid).ok, false, `Vehicle SLU 2.0 rejects ${label}`);
}

console.log("PASS Vehicle SLU 2.0 contract");
