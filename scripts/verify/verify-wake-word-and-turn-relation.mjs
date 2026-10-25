import assert from "node:assert/strict";
import { CabinAssistantController } from "../../src/agents/cabin-assistant-controller.js";
import {
  BrowserTranscriptWakeWordProvider,
} from "../../src/interaction/wake-word-provider.js";
import { classifyExplicitTurnGate } from "../../src/interaction/turn-relation.js";
import { CloudLLMAdapter } from "../../src/runtime/cloud-llm-adapter.js";
import {
  buildStructuredAgentJsonSchema,
  buildStructuredAgentPrompt,
  getStructuredValidationDetail,
} from "../../src/server/local-agent-server.mjs";

const observedAtMs = Date.parse("2026-07-31T08:09:10.000Z");
const provider = new BrowserTranscriptWakeWordProvider({ now: () => observedAtMs });
for (const transcript of ["NOMI", "nomi，帮我看看", "ＮＯＭＩ：打开空调"]) {
  const detection = provider.detect(transcript);
  assert.deepEqual(detection, {
    provider: "browser-transcript-wake-gate",
    providerVersion: "1.0.0",
    matched: true,
    normalizedWakeWord: "NOMI",
    observedAt: "2026-07-31T08:09:10.000Z",
    source: "browser-transcript-gate",
    simulated: true,
    environment: "development",
  }, `${transcript} should return the complete anchored NOMI detection`);
}
for (const transcript of ["economics", "nominal", "你好 NOMI", "我们正常聊天", "nomi帮我看看"]) {
  assert.deepEqual(
    provider.detect(transcript),
    {
      provider: "browser-transcript-wake-gate",
      providerVersion: "1.0.0",
      matched: false,
      normalizedWakeWord: null,
      observedAt: "2026-07-31T08:09:10.000Z",
      source: "browser-transcript-gate",
      simulated: true,
      environment: "development",
    },
    `${transcript} must not trigger a substring or unanchored wake match`,
  );
}
assert.throws(
  () => new BrowserTranscriptWakeWordProvider({ now: "not-a-function" }),
  /now must be a function/i,
);
assert.throws(
  () => new BrowserTranscriptWakeWordProvider({ now: () => Number.NaN }).detect("NOMI"),
  /valid time/i,
);

assert.equal(classifyExplicitTurnGate("算了").decision, "explicit-cancel");
assert.equal(classifyExplicitTurnGate(" 算了！ ").decision, "explicit-cancel");
assert.equal(classifyExplicitTurnGate("停一下").decision, "explicit-cancel");
assert.equal(classifyExplicitTurnGate("不用了").decision, "explicit-close");
assert.equal(classifyExplicitTurnGate("不用了。").decision, "explicit-close");
assert.equal(classifyExplicitTurnGate("这个账怎么算了").decision, "none");
assert.equal(classifyExplicitTurnGate("这个不用了的方案还有问题").decision, "none");
assert.equal(classifyExplicitTurnGate("“停一下”这个词是什么意思").decision, "none");
assert.equal(classifyExplicitTurnGate("继续").decision, "none");

const acceptedRelations = ["new-goal", "follow-up", "correction"];

function createModelAdapter(outputFactory) {
  return {
    calls: [],
    async formGoal() {
      throw new Error("not used");
    },
    async synthesizeAgentResponse() {
      throw new Error("not used");
    },
    async classifyTurnRelation(input) {
      this.calls.push(input);
      return {
        output: outputFactory(),
        telemetry: {
          model: "offline-stub",
          provider: "test",
          durationMs: 2,
          degraded: false,
          reason: "structured-output-valid",
          structuredRetryCount: 0,
          rawPrompt: "must-not-leak",
        },
      };
    },
  };
}

for (const relation of acceptedRelations) {
  const modelAdapter = createModelAdapter(() => ({
    relation,
    reasonCode: `classified-${relation}`,
    requiresClarification: false,
  }));
  const signal = new AbortController().signal;
  const controller = new CabinAssistantController({ modelAdapter });
  const result = await controller.classifyTurnRelation({
    sessionId: "session:1",
    turnId: "turn:1",
    currentGoal: {
      objective: "导航去公司",
      capabilityCatalog: [{ id: "vehicle.window.set-position" }],
      safetyDecision: { allowed: false },
      rawModelResponse: "old model response",
      slots: { zone: "front_left" },
    },
    rawText: "改去机场",
    signal,
  });

  assert.equal(result.relation, relation);
  assert.equal(result.reasonCode, `classified-${relation}`);
  assert.equal(result.requiresClarification, false);
  assert.equal(result.degraded, false);
  assert.equal(Object.hasOwn(result.telemetry, "rawPrompt"), false);
  assert.deepEqual(Object.keys(modelAdapter.calls[0]).sort(), [
    "currentGoalSummary",
    "rawText",
    "sessionId",
    "signal",
    "turnId",
  ]);
  assert.equal(modelAdapter.calls[0].currentGoalSummary, "导航去公司");
  assert.equal(modelAdapter.calls[0].rawText, "改去机场");
  assert.equal(modelAdapter.calls[0].signal, signal);
  const serializedInput = JSON.stringify(modelAdapter.calls[0]);
  assert.doesNotMatch(
    serializedInput,
    /capabilityCatalog|safetyDecision|rawModelResponse|vehicle\.window|front_left/,
  );
}

{
  const modelAdapter = createModelAdapter(() => ({
    relation: "follow-up",
    reasonCode: "bounded-summary",
    requiresClarification: false,
  }));
  await new CabinAssistantController({ modelAdapter }).classifyTurnRelation({
    sessionId: "session:bounded",
    turnId: "turn:bounded",
    currentGoal: { objective: "目".repeat(400) },
    rawText: "继续",
  });
  assert.equal(modelAdapter.calls[0].currentGoalSummary.length, 240);
}

for (const pollutedOutput of [
  {
    relation: "follow-up",
    reasonCode: "tries-tool",
    requiresClarification: false,
    tool: "vehicle.window.set-position",
  },
  {
    relation: "correction",
    reasonCode: "tries-capability",
    requiresClarification: false,
    capabilityId: "vehicle.window.set-position",
  },
  {
    relation: "new-goal",
    reasonCode: "tries-slots",
    requiresClarification: false,
    slots: { zone: "front_left" },
  },
]) {
  const modelAdapter = createModelAdapter(() => pollutedOutput);
  await assert.rejects(
    () => new CabinAssistantController({ modelAdapter }).classifyTurnRelation({
      sessionId: "session:pollution",
      turnId: "turn:pollution",
      currentGoal: "打开空调",
      rawText: "继续",
    }),
    /invalid|forbidden|unknown/i,
  );
}

for (const invalidOutput of [
  { relation: "cancel", reasonCode: "not-owned", requiresClarification: false },
  { relation: "follow-up", reasonCode: "", requiresClarification: false },
  { relation: "follow-up", reasonCode: "x".repeat(81), requiresClarification: false },
  { relation: "follow-up", reasonCode: "wrong-type", requiresClarification: "false" },
]) {
  const modelAdapter = createModelAdapter(() => invalidOutput);
  await assert.rejects(
    () => new CabinAssistantController({ modelAdapter }).classifyTurnRelation({
      sessionId: "session:invalid",
      turnId: "turn:invalid",
      currentGoal: "打开空调",
      rawText: "继续",
    }),
    /invalid/i,
  );
}

const relationBody = {
  task: "b3_turn_relation",
  sessionId: "session:protocol",
  turnId: "turn:protocol",
  currentGoalSummary: "导航去公司",
  rawText: "改去机场",
  capabilityCatalog: [{ id: "vehicle.window.set-position" }],
  safetyDecision: { allowed: false },
  rawModelResponse: "old response",
};
const relationSchema = buildStructuredAgentJsonSchema(relationBody);
assert.deepEqual(relationSchema, {
  type: "object",
  additionalProperties: false,
  required: ["relation", "reasonCode", "requiresClarification"],
  properties: {
    relation: { type: "string", enum: acceptedRelations },
    reasonCode: { type: "string", minLength: 1, maxLength: 80 },
    requiresClarification: { type: "boolean" },
  },
});
assert.deepEqual(
  getStructuredValidationDetail(relationBody, {
    relation: "correction",
    reasonCode: "changes-destination",
    requiresClarification: false,
  }),
  { reasonCode: "", validationSubreason: "" },
);
assert.deepEqual(
  getStructuredValidationDetail(relationBody, {
    relation: "correction",
    reasonCode: "changes-destination",
    requiresClarification: false,
    vehicleSlots: { destination: "机场" },
  }),
  { reasonCode: "turn-relation-invalid", validationSubreason: "contract-invalid" },
);
const relationPrompt = buildStructuredAgentPrompt(relationBody);
assert.match(relationPrompt, /导航去公司/);
assert.match(relationPrompt, /改去机场/);
assert.match(
  relationPrompt,
  /exact JSON root fields: relation \(string: new-goal\|follow-up\|correction\), reasonCode \(non-empty string, 1-80 characters\), requiresClarification \(boolean\)/i,
  "turn prompt must enumerate the exact root keys, types, and relation enum",
);
const relationExamplePrefix = "Minimal legal JSON example: ";
const relationExampleLine = relationPrompt
  .split("\n")
  .find((line) => line.startsWith(relationExamplePrefix));
assert.ok(relationExampleLine, "turn prompt must include one minimal legal JSON example");
const relationExample = JSON.parse(relationExampleLine.slice(relationExamplePrefix.length));
assert.deepEqual(
  getStructuredValidationDetail(relationBody, relationExample),
  { reasonCode: "", validationSubreason: "" },
  "turn prompt example must satisfy the server-owned relation contract",
);
assert.doesNotMatch(
  relationPrompt,
  /capabilityCatalog|safetyDecision|rawModelResponse|vehicle\.window|old response/,
);

{
  const originalFetch = globalThis.fetch;
  let requestBody;
  try {
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return {
            output: {
              relation: "new-goal",
              reasonCode: "new-objective",
              requiresClarification: false,
            },
            telemetry: {},
          };
        },
      };
    };
    const adapter = new CloudLLMAdapter({
      endpoint: "http://offline.test/api/local-llm",
      model: "offline-stub",
      structuredTimeoutMs: 1_000,
    });
    await adapter.classifyTurnRelation({
      sessionId: "session:cloud",
      turnId: "turn:cloud",
      currentGoalSummary: "目".repeat(400),
      rawText: "打开座椅加热",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(Object.keys(requestBody).sort(), [
    "currentGoalSummary",
    "model",
    "prompt",
    "rawText",
    "sessionId",
    "task",
    "turnId",
  ]);
  assert.equal(requestBody.task, "b3_turn_relation");
  assert.equal(requestBody.currentGoalSummary.length, 240);
  assert.doesNotMatch(
    JSON.stringify(requestBody),
    /capabilityCatalog|safetyDecision|rawModelResponse|semanticPolicy/,
  );
}

console.log("Wake word and turn relation verification passed");
