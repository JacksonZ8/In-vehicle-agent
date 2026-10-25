import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createVehicleSluEnvelope,
  getMissingVehicleSluRequiredSlots,
} from "../../src/semantic/vehicle-slu-contract.js";
import { isVehicleControlIntent } from "../../src/runtime/agent-schemas.js";

const fixturePath = fileURLToPath(new URL("../../data/semantic-golden/vehicle-slu-2.0.0.json", import.meta.url));
const expectedCounts = Object.freeze({
  "chat-emotion": 30,
  "open-qa": 20,
  "vehicle-knowledge": 15,
  "complete-control": 15,
  "incomplete-control": 10,
  "vehicle-services": 10,
  "non-execution": 10,
  "mixed-multi-intent": 10,
});
const categoryIds = Object.freeze({
  "chat-emotion": "slu-chat",
  "open-qa": "slu-open-qa",
  "vehicle-knowledge": "slu-vehicle-knowledge",
  "complete-control": "slu-complete-control",
  "incomplete-control": "slu-incomplete-control",
  "vehicle-services": "slu-services",
  "non-execution": "slu-non-execution",
  "mixed-multi-intent": "slu-mixed",
});
const expectedNonExecutionSpeechActs = Object.freeze({
  "slu-non-execution-001": "report",
  "slu-non-execution-002": "question",
  "slu-non-execution-003": "command",
  "slu-non-execution-004": "complaint",
  "slu-non-execution-005": "command",
  "slu-non-execution-006": "command",
  "slu-non-execution-007": "question",
  "slu-non-execution-008": "report",
  "slu-non-execution-009": "command",
  "slu-non-execution-010": "command",
});

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assertExactKeys(fixture, ["contractVersion", "datasetVersion", "split", "cases"], "fixture");
assert.equal(fixture.contractVersion, "nio-vehicle-slu-contract@2.0.0");
assert.equal(fixture.datasetVersion, "vehicle-slu-golden@2.0.2");
assert.equal(fixture.split, "acceptance");
assert.ok(Array.isArray(fixture.cases), "fixture.cases must be an array");
assert.equal(fixture.cases.length, 120);
assert.deepEqual(countByCategory(fixture.cases), expectedCounts);
assert.equal(new Set(fixture.cases.map(({ id }) => id)).size, 120);
for (const [category, count] of Object.entries(expectedCounts)) {
  assert.deepEqual(
    fixture.cases.filter((entry) => entry.category === category).map((entry) => entry.id).sort(),
    Array.from({ length: count }, (_, index) => `${categoryIds[category]}-${String(index + 1).padStart(3, "0")}`),
    `${category}: IDs must use the frozen range`,
  );
}

const normalizedTexts = new Set();
for (const entry of fixture.cases) validateCase(entry, normalizedTexts);
const safetyRejectCases = fixture.cases.filter((entry) => entry.expected.semanticEnvelope.vehicleFrames
  .some((frame) => frame.intent === "safety.reject"));
assert.deepEqual(Object.fromEntries(fixture.cases
  .filter((entry) => entry.category === "non-execution")
  .map((entry) => [entry.id, entry.expected.semanticEnvelope.vehicleFrames[0].speechAct])),
expectedNonExecutionSpeechActs,
"non-execution speech acts must reflect each source utterance rather than a uniform question label");
assert.equal(safetyRejectCases.length, 1,
  "fixture must contain exactly one protected safety.reject case",
);
assert.equal(safetyRejectCases[0].category, "non-execution", "protected reject belongs to non-execution");
assert.equal(fixture.cases.filter((entry) => entry.expected.disposition === "cancel").length, 0,
  "fixture does not model Run cancellation without session-layer evidence");

console.log("Vehicle-SLU golden fixture verification passed");
console.log(`category counts: ${JSON.stringify(countByCategory(fixture.cases))}`);
console.log("total: 120");

function countByCategory(cases) {
  return Object.fromEntries(Object.keys(expectedCounts).map((category) => [
    category,
    cases.filter((entry) => entry.category === category).length,
  ]));
}

function validateCase(entry, normalizedTexts) {
  assertExactKeys(entry, ["id", "category", "text", "expected"], "case");
  assert.equal(typeof entry?.id, "string", "case id must be a string");
  assert.equal(typeof entry?.category, "string", `${entry.id}: category must be a string`);
  assert.equal(typeof entry?.text, "string", `${entry.id}: text must be a string`);
  assert.ok(entry.text.trim(), `${entry.id}: text must not be empty`);
  assert.equal(typeof entry?.expected, "object", `${entry.id}: expected must be an object`);
  assert.match(entry.id, new RegExp(`^${categoryIds[entry.category]}-\\d{3}$`), `${entry.id}: invalid category ID prefix`);

  const normalized = normalizeText(entry.text);
  assert.ok(!normalizedTexts.has(normalized), `${entry.id}: duplicate normalized text`);
  normalizedTexts.add(normalized);

  assertExactKeys(entry.expected, ["semanticEnvelope", "routeId", "disposition", "vehicleWriteCount"], `${entry.id}: expected`);
  const { semanticEnvelope, routeId, disposition, vehicleWriteCount } = entry.expected;
  assert.equal(typeof disposition, "string", `${entry.id}: disposition must be a string`);
  assert.ok(["execute", "clarify", "respond", "cancel"].includes(disposition), `${entry.id}: invalid disposition`);
  assert.ok([0, 1].includes(vehicleWriteCount), `${entry.id}: vehicleWriteCount must be 0 or 1`);
  assert.equal(semanticEnvelope?.requestId, `fixture:${entry.id}`, `${entry.id}: requestId must be stable`);
  const envelope = createVehicleSluEnvelope(semanticEnvelope);
  assert.equal(envelope.conversationGoal.need, expectedConversationNeed(entry),
    `${entry.id}: invalid conversation need`);

  const controlWrites = envelope.vehicleFrames.filter((frame) => frame.capability === "control"
    && frame.actionNeed === "execute" && isVehicleControlIntent(frame.intent)
    && frame.missingSlots.length === 0
    && getMissingVehicleSluRequiredSlots(frame.intent, frame.slots).length === 0);
  if (disposition === "execute") {
    assert.ok(["chat", "vehicle-knowledge", "vehicle-control", "task"].includes(routeId), `${entry.id}: invalid execute routeId`);
  } else assert.equal(routeId, null, `${entry.id}: terminal disposition must not retain a routeId`);

  if (vehicleWriteCount === 1) {
    assert.equal(disposition, "execute", `${entry.id}: a vehicle write requires execute`);
    assert.ok(controlWrites.length > 0, `${entry.id}: a vehicle write requires supported control/execute`);
  }

  assertRuntimeOutcome(entry, envelope, { routeId, disposition, vehicleWriteCount, controlWrites });
}

function assertRuntimeOutcome(entry, envelope, { routeId, disposition, vehicleWriteCount, controlWrites }) {
  const { id, category } = entry;
  const frames = envelope.vehicleFrames;
  const outcome = [disposition, routeId, vehicleWriteCount];
  const oneFrame = () => assert.equal(frames.length, 1, `${id}: category requires exactly one vehicle frame`);
  assert.equal(envelope.conversationGoal.need, expectedConversationNeed(entry), `${id}: category conversation need`);

  if (["chat-emotion", "open-qa"].includes(category)) {
    assert.equal(envelope.domain, "non_vehicle", `${id}: chat must be non-vehicle`);
    assert.equal(frames.length, 0, `${id}: chat must not contain vehicle frames`);
    assert.deepEqual(outcome, ["execute", "chat", 0], `${id}: chat outcome`);
  } else if (category === "vehicle-knowledge") {
    assert.equal(envelope.domain, "vehicle", `${id}: knowledge must be vehicle domain`);
    oneFrame();
    assert.equal(frames[0].capability, "knowledge", `${id}: knowledge capability required`);
    assert.equal(frames[0].speechAct, "question", `${id}: knowledge must be a question`);
    assert.equal(frames[0].actionNeed, "none", `${id}: knowledge must not execute`);
    assert.ok(["vehicle.knowledge.query", "vehicle.state.query"].includes(frames[0].intent), `${id}: invalid knowledge intent`);
    assert.equal(frames[0].knowledgeNeed,
      frames[0].intent === "vehicle.knowledge.query" ? "manual" : "none",
      `${id}: knowledge route dimension`);
    assert.deepEqual(outcome, ["execute", "vehicle-knowledge", 0], `${id}: knowledge outcome`);
  } else if (category === "complete-control") {
    assert.equal(envelope.domain, "vehicle", `${id}: control must be vehicle domain`);
    oneFrame();
    assert.equal(frames[0].capability, "control", `${id}: control capability required`);
    assert.equal(frames[0].speechAct, "command", `${id}: complete control must be a command`);
    assert.equal(frames[0].actionNeed, "execute", `${id}: complete control must execute`);
    assert.deepEqual(frames[0].missingSlots, [], `${id}: complete control declares no missing slots`);
    assert.ok(isVehicleControlIntent(frames[0].intent), `${id}: supported control intent required`);
    assert.deepEqual(getMissingVehicleSluRequiredSlots(frames[0].intent, frames[0].slots), [], `${id}: complete control slots`);
    assert.deepEqual(outcome, ["execute", "vehicle-control", 1], `${id}: complete control outcome`);
  } else if (category === "incomplete-control") {
    assert.equal(envelope.domain, "vehicle", `${id}: incomplete control must be vehicle domain`);
    oneFrame();
    assert.equal(frames[0].capability, "control", `${id}: control capability required`);
    assert.equal(frames[0].speechAct, "command", `${id}: incomplete control preserves command speech act`);
    assert.equal(frames[0].actionNeed, "clarify", `${id}: incomplete control must clarify`);
    assert.ok(isVehicleControlIntent(frames[0].intent), `${id}: supported control intent required`);
    assert.deepEqual(frames[0].missingSlots,
      getMissingVehicleSluRequiredSlots(frames[0].intent, frames[0].slots),
      `${id}: incomplete control declares the schema-derived missing slots`);
    assert.ok(frames[0].clarificationQuestion, `${id}: incomplete control requires a natural clarification question`);
    assert.deepEqual(outcome, ["clarify", null, 0], `${id}: incomplete control outcome`);
  } else if (category === "vehicle-services") {
    assert.equal(envelope.domain, "vehicle", `${id}: service must be vehicle domain`);
    oneFrame();
    assert.ok(["weather", "navigation", "media", "phone"].includes(frames[0].capability), `${id}: service capability required`);
    if (frames[0].capability === "weather") {
      assert.equal(frames[0].speechAct, "question", `${id}: weather must be a question`);
      assert.equal(frames[0].actionNeed, "none", `${id}: weather must be readonly`);
      assert.deepEqual(outcome, ["execute", "task", 0], `${id}: weather outcome`);
    } else {
      assert.equal(frames[0].speechAct, "command", `${id}: deferred service must preserve command speech act`);
      assert.equal(frames[0].actionNeed, "execute", `${id}: deferred service must preserve execute need`);
      assert.deepEqual(outcome, ["respond", null, 0], `${id}: deferred service outcome`);
    }
  } else if (category === "non-execution") {
    assert.equal(envelope.domain, "vehicle", `${id}: non-execution must be vehicle domain`);
    oneFrame();
    assert.equal(frames[0].speechAct, expectedNonExecutionSpeechActs[id],
      `${id}: non-execution speech act must match the source utterance`);
    assert.equal(frames[0].actionNeed, "none", `${id}: non-execution must not request an action`);
    assert.equal(vehicleWriteCount, 0, `${id}: non-execution must not write`);
    if (frames[0].intent === "safety.reject") {
      assert.deepEqual(outcome, ["respond", null, 0], `${id}: protected safety outcome`);
    } else if (frames[0].capability === "control") {
      assert.ok(isVehicleControlIntent(frames[0].intent), `${id}: non-executing control intent required`);
      assert.deepEqual(outcome, ["execute", "chat", 0], `${id}: non-executing control outcome`);
    } else if (frames[0].capability === "knowledge") {
      assert.ok(["vehicle.knowledge.query", "vehicle.state.query"].includes(frames[0].intent), `${id}: non-execution knowledge intent required`);
      assert.deepEqual(outcome, ["execute", "vehicle-knowledge", 0], `${id}: non-execution knowledge outcome`);
    } else if (["navigation", "media", "phone"].includes(frames[0].capability)) {
      assert.deepEqual(outcome, ["respond", null, 0], `${id}: deferred non-execution service outcome`);
    } else assert.fail(`${id}: invalid non-execution frame`);
  } else if (category === "mixed-multi-intent") {
    assert.equal(envelope.domain, "vehicle", `${id}: mixed must be vehicle domain`);
    assert.equal(envelope.conversationGoal.need, "social", `${id}: mixed retains independent social need`);
    assert.ok(frames.length > 0, `${id}: mixed requires a vehicle frame`);
    for (const frame of frames) {
      if (frame.capability === "control" && frame.actionNeed === "execute") {
        assert.ok(isVehicleControlIntent(frame.intent), `${id}: mixed control must use a supported intent`);
        assert.deepEqual(frame.missingSlots, [], `${id}: mixed execute declares no missing slots`);
        assert.deepEqual(getMissingVehicleSluRequiredSlots(frame.intent, frame.slots), [], `${id}: mixed control execute requires complete slots`);
      } else if (frame.capability === "knowledge") {
        assert.ok(["vehicle.knowledge.query", "vehicle.state.query"].includes(frame.intent), `${id}: mixed knowledge intent required`);
        assert.equal(frame.actionNeed, "none", `${id}: mixed knowledge is readonly`);
      } else if (frame.capability === "weather") {
        assert.equal(frame.intent, "weather.query", `${id}: mixed weather intent required`);
        assert.equal(frame.actionNeed, "none", `${id}: mixed weather is readonly`);
      }
    }
    const hasSupportedFrame = frames.some((frame) => isVehicleControlIntent(frame.intent)
      || ["knowledge", "weather"].includes(frame.capability));
    if (!hasSupportedFrame) {
      assert.ok(frames.every((frame) => ["navigation", "media", "phone"].includes(frame.capability)), `${id}: unsupported mixed may contain only deferred service frames`);
    }
    assert.deepEqual(outcome, hasSupportedFrame
      ? ["execute", "task", Math.min(1, controlWrites.length)]
      : ["respond", null, 0], `${id}: mixed outcome`);
  } else assert.fail(`${id}: unsupported category`);
}

function expectedConversationNeed(entry) {
  if (["chat-emotion", "mixed-multi-intent"].includes(entry.category)) return "social";
  if (["open-qa", "vehicle-knowledge", "non-execution"].includes(entry.category)) return "explain";
  return entry.expected.semanticEnvelope.vehicleFrames.some((frame) => frame.speechAct === "question")
    ? "explain"
    : "none";
}

function assertExactKeys(value, allowedKeys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...allowedKeys].sort(), `${label}: exact keys required`);
}

function normalizeText(text) {
  return text.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]/gu, "");
}
