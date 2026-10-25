import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  VEHICLE_SLU_OUTPUT_SCHEMA,
} from "../../src/semantic/vehicle-slu-contract.js";
import { expandVehicleSluCompact, VEHICLE_SLU_COMPACT_OUTPUT_FORMAT } from "../../src/semantic/vehicle-slu-compact.js";
import {
  buildVehicleSluCompactV9Prompt,
  VEHICLE_SLU_COMPACT_MODEL,
  VEHICLE_SLU_COMPACT_PROFILE,
  VEHICLE_SLU_COMPACT_PROMPT_VERSION,
  VEHICLE_SLU_COMPACT_SYSTEM,
} from "../../src/semantic/vehicle-slu-compact-v9.js";
import {
  buildVehicleSluEvaluationSummary,
  evaluateVehicleSluEligibility,
  evaluateVehicleSluModels,
  parseVehicleSluEvaluatorArguments,
  projectVehicleSluMetrics,
  selectVehicleSluModel,
  validateVehicleSluFixture,
  VEHICLE_SLU_CASE_TIMEOUT_MS,
} from "../benchmarks/evaluate-vehicle-slu-models.mjs";

const CONTRACT = "nio-vehicle-slu-contract@2.0.0";

function envelope(requestId, domain, frames = [], need = domain === "non_vehicle" ? "social" : "none") {
  return {
    contractVersion: CONTRACT,
    requestId,
    domain,
    conversationGoal: { summary: `goal:${requestId}`, need },
    vehicleFrames: frames,
    domainConfidence: 1,
  };
}

function frame(intent, actionNeed, slots = {}) {
  const capability = intent === "safety.reject"
    || intent.startsWith("body.") || intent.startsWith("seat.") || intent.startsWith("cabin.")
    ? "control"
    : intent.startsWith("vehicle.") ? "knowledge"
      : intent.startsWith("weather.") ? "weather" : "navigation";
  const manual = actionNeed === "none" && intent === "vehicle.knowledge.query";
  const missingSlots = actionNeed === "clarify" ? missingRequiredSlots(intent, slots) : [];
  return {
    frameId: `frame:${intent}`,
    capability,
    intent,
    speechAct: actionNeed === "none" ? "question" : "command",
    knowledgeNeed: manual ? "manual" : "none",
    actionNeed,
    slots,
    missingSlots,
    clarificationQuestion: actionNeed === "clarify" ? `请补充${missingSlots.join("、")}。` : null,
    standaloneQuery: manual ? slots.query : null,
    confidence: 1,
  };
}

function fixtureCase(id, category, expectedEnvelope, vehicleWriteCount = 0) {
  return {
    id,
    category,
    text: `text:${id}`,
    expected: {
      semanticEnvelope: expectedEnvelope,
      routeId: expectedEnvelope.domain === "non_vehicle" ? "chat" : null,
      disposition: "execute",
      vehicleWriteCount,
    },
  };
}

function run(entry, status, latencyMs, semanticEnvelope = null) {
  return {
    caseId: entry.id,
    category: entry.category,
    expected: entry.expected,
    status,
    latencyMs,
    ...(semanticEnvelope ? { semanticEnvelope } : {}),
  };
}

const chat = fixtureCase("chat", "chat-emotion", envelope("fixture:chat", "non_vehicle"));
const openInvalidJson = fixtureCase("open-json", "open-qa", envelope("fixture:open-json", "non_vehicle", [], "explain"));
const openContractInvalid = fixtureCase("open-contract", "open-qa", envelope("fixture:open-contract", "non_vehicle", [], "explain"));
const controlWindow = fixtureCase(
  "control-window",
  "complete-control",
  envelope("fixture:control-window", "vehicle", [
    frame("body.window.setPosition", "execute", { zone: "front_right", percent: 50 }),
  ]),
  1,
);
const controlTailgate = fixtureCase(
  "control-tailgate",
  "complete-control",
  envelope("fixture:control-tailgate", "vehicle", [frame("body.tailgate.open", "execute", { open: true })]),
  1,
);
const controlClimate = fixtureCase(
  "control-climate",
  "complete-control",
  envelope("fixture:control-climate", "vehicle", [frame("cabin.climate.setPreset", "execute", { temperature: 22 })]),
  1,
);
const nonExecution = fixtureCase(
  "non-execution",
  "non-execution",
  envelope("fixture:non-execution", "vehicle", [frame("vehicle.knowledge.query", "none", { query: "tailgate" })], "explain"),
);
const knowledgeTimeout = fixtureCase(
  "knowledge-timeout",
  "vehicle-knowledge",
  envelope("fixture:knowledge-timeout", "vehicle", [frame("vehicle.knowledge.query", "none", { query: "battery" })], "explain"),
);
const service = fixtureCase(
  "service",
  "vehicle-services",
  envelope("fixture:service", "vehicle", [frame("weather.query", "none", { location: "苏州", timeRange: "今晚" })], "explain"),
);
const mixed = fixtureCase(
  "mixed",
  "mixed-multi-intent",
  envelope("fixture:mixed", "vehicle", [frame("vehicle.state.query", "none", { stateFields: ["speedKph"] })], "social"),
);

const fakeRuns = [
  run(chat, "ok", 100, envelope("prediction:chat", "vehicle", [
    frame("body.window.setPosition", "clarify", {}),
  ])),
  run(openInvalidJson, "invalid-json", 200),
  run(openContractInvalid, "contract-invalid", 300),
  run(controlWindow, "ok", 400, envelope("prediction:control-window", "vehicle", [
    frame("body.window.setPosition", "execute", { zone: "front_right", percent: 50 }),
  ])),
  run(controlTailgate, "ok", 500, envelope("prediction:control-tailgate", "vehicle", [
    frame("body.tailgate.open", "execute", { open: false }),
  ])),
  run(controlClimate, "ok", 600, envelope("prediction:control-climate", "vehicle", [
    frame("body.tailgate.open", "execute", { open: true }),
  ])),
  run(nonExecution, "ok", 700, envelope("prediction:non-execution", "vehicle", [
    frame("body.tailgate.open", "execute", { open: true }),
  ])),
  run(knowledgeTimeout, "timeout", 3_000),
  run(service, "ok", 800, envelope("prediction:service", "vehicle", [
    frame("weather.query", "none", { location: "苏州", timeRange: "今晚" }),
  ], "explain")),
  run(mixed, "ok", 900, envelope("prediction:mixed", "vehicle", [
    frame("vehicle.state.query", "none", { stateFields: ["speedKph"] }),
  ], "social")),
];

const metrics = projectVehicleSluMetrics(fakeRuns);
assert.equal(metrics.total, 10);
assert.equal(metrics.domainAccuracy, 0.6);
assert.equal(metrics.completeControlIntentAccuracy, 2 / 3);
assert.equal(metrics.completeControlRequiredSlotAccuracy, 1 / 3);
assert.equal(metrics.falseVehicleWriteCount, 1);
assert.equal(metrics.falseVehicleWriteRate, 1 / 7);
assert.equal(metrics.keyChatFalseClarificationCount, 1);
assert.equal(metrics.keyChatFalseClarificationRate, 1 / 3);
assert.equal(metrics.contractInvalidCount, 2, "invalid JSON and schema-invalid JSON both fail the contract gate");
assert.equal(metrics.invalidJsonCount, 1);
assert.equal(metrics.timeoutCount, 1);
assert.equal(metrics.semanticAccuracy, 0.3);
assert.equal(metrics.macroSemanticAccuracy, 1 / 3);
assert.deepEqual(metrics.perCategory, {
  "chat-emotion": { total: 1, correct: 0, accuracy: 0 },
  "open-qa": { total: 2, correct: 0, accuracy: 0 },
  "complete-control": { total: 3, correct: 1, accuracy: 1 / 3 },
  "non-execution": { total: 1, correct: 0, accuracy: 0 },
  "vehicle-knowledge": { total: 1, correct: 0, accuracy: 0 },
  "vehicle-services": { total: 1, correct: 1, accuracy: 1 },
  "mixed-multi-intent": { total: 1, correct: 1, accuracy: 1 },
});
assert.equal(metrics.p50Ms, 500, "nearest-rank P50 of ten ordered values is rank 5");

const exactDynamicClimateSlots = projectVehicleSluMetrics([
  run(controlClimate, "ok", 100, envelope("prediction:control-climate", "vehicle", [
    frame("cabin.climate.setPreset", "execute", { temperature: 22 }),
  ])),
]);
assert.equal(exactDynamicClimateSlots.completeControlRequiredSlotAccuracy, 1,
  "dynamic climate intents must score their populated runtime slots");
const wrongDynamicClimateSlots = projectVehicleSluMetrics([
  run(controlClimate, "ok", 100, envelope("prediction:control-climate", "vehicle", [
    frame("cabin.climate.setPreset", "execute", { temperature: 23 }),
  ])),
]);
assert.equal(wrongDynamicClimateSlots.completeControlRequiredSlotAccuracy, 0,
  "a wrong dynamic climate value must fail required-slot accuracy");
assert.equal(metrics.p95Ms, 3_000, "nearest-rank P95 of ten ordered values is rank 10");
assert.equal(metrics.gatesPassed, false);

const nonExecutingCompleteControlMetrics = projectVehicleSluMetrics([
  run(controlWindow, "ok", 400, envelope("prediction:control-window-readonly", "vehicle", [
    frame("body.window.setPosition", "none", { zone: "front_right", percent: 50 }),
  ], "explain")),
]);
assert.equal(nonExecutingCompleteControlMetrics.completeControlIntentAccuracy, 0,
  "a complete-control intent is correct only when actionNeed is execute",
);
assert.equal(nonExecutingCompleteControlMetrics.completeControlRequiredSlotAccuracy, 0,
  "matching required slots in a readonly frame must not pass the execution gate",
);
assert.equal(nonExecutingCompleteControlMetrics.gatesPassed, false);

const falseClarificationChatMetrics = projectVehicleSluMetrics([
  run(chat, "ok", 400, envelope("prediction:chat-clarify", "vehicle", [
    frame("body.window.setPosition", "clarify", { zone: "front_right" }),
  ])),
]);
assert.equal(falseClarificationChatMetrics.keyChatFalseClarificationCount, 1,
  "a declared supported control clarification is a false vehicle clarification for key chat",
);
assert.equal(falseClarificationChatMetrics.falseVehicleWriteCount, 0,
  "a clarification prediction is not a complete false write",
);

const incompleteExecuteChatMetrics = projectVehicleSluMetrics([
  run(chat, "ok", 400, envelope("prediction:chat-incomplete-execute", "vehicle", [
    frame("body.window.setPosition", "execute", { zone: "front_right" }),
  ])),
]);
assert.equal(incompleteExecuteChatMetrics.falseVehicleWriteCount, 1,
  "an execute-labelled control with an absent canonical slot is still a false vehicle write request",
);
assert.equal(incompleteExecuteChatMetrics.keyChatFalseClarificationCount, 0,
  "an execute-labelled control must not be disguised as a normal clarification",
);

const exactBoundary = {
  falseVehicleWriteCount: 0,
  keyChatFalseClarificationCount: 0,
  domainAccuracy: 0.95,
  completeControlIntentAccuracy: 0.95,
  completeControlRequiredSlotAccuracy: 0.95,
  p50Ms: 1_000,
  p95Ms: 2_000,
  macroSemanticAccuracy: 0.8,
};
assert.deepEqual(evaluateVehicleSluEligibility(exactBoundary), {
  eligible: true,
  gates: {
    zeroFalseVehicleWrites: true,
    zeroKeyChatFalseClarifications: true,
    domainAccuracy: true,
    completeControlIntentAccuracy: true,
    completeControlRequiredSlotAccuracy: true,
    p50Latency: true,
    p95Latency: true,
  },
});
assert.equal(evaluateVehicleSluEligibility({ ...exactBoundary, p95Ms: 2_001 }).eligible, false);
assert.equal(evaluateVehicleSluEligibility({ ...exactBoundary, falseVehicleWriteCount: 1 }).eligible, false);

const baseline = { model: "qwen2.5:3b", metrics: exactBoundary };
const macroWinner = {
  model: "Qwen3.5-2B",
  metrics: { ...exactBoundary, macroSemanticAccuracy: 0.82 },
};
assert.deepEqual(selectVehicleSluModel({ baseline, candidate: macroWinner }), {
  selectedModel: "Qwen3.5-2B",
  productionQualified: true,
  decision: "replace-baseline",
  reason: "macro-semantic-improvement",
});
const latencyWinner = {
  model: "Qwen3.5-2B",
  metrics: { ...exactBoundary, macroSemanticAccuracy: 0.8, p95Ms: 1_700 },
};
assert.equal(selectVehicleSluModel({ baseline, candidate: latencyWinner }).reason, "p95-latency-improvement");
assert.deepEqual(selectVehicleSluModel({
  baseline: { model: "qwen2.5:3b", metrics: { ...exactBoundary, domainAccuracy: 0.99 } },
  candidate: {
    model: "Qwen3.5-2B",
    metrics: { ...exactBoundary, domainAccuracy: 0.95, p95Ms: 1_700 },
  },
}), {
  selectedModel: "qwen2.5:3b",
  productionQualified: true,
  decision: "retain-baseline",
  reason: "semantic-gate-regression",
}, "a P95 win must not cover a semantic gate regression");
assert.deepEqual(selectVehicleSluModel({
  baseline,
  candidate: {
    model: "Qwen3.5-2B",
    metrics: { ...exactBoundary, macroSemanticAccuracy: 0.9, falseVehicleWriteCount: 1 },
  },
}), {
  selectedModel: "qwen2.5:3b",
  productionQualified: true,
  decision: "retain-baseline",
  reason: "safety-gate-regression",
}, "a material semantic win must not cover a false-write regression");
assert.deepEqual(selectVehicleSluModel({
  baseline,
  candidate: { model: "Qwen3.5-2B", metrics: { ...exactBoundary, macroSemanticAccuracy: 0.819, p95Ms: 1_701 } },
}), {
  selectedModel: "qwen2.5:3b",
  productionQualified: true,
  decision: "retain-baseline",
  reason: "no-material-benefit",
});
assert.deepEqual(selectVehicleSluModel({
  baseline: { model: "qwen2.5:3b", metrics: { ...exactBoundary, domainAccuracy: 0.94 } },
  candidate: { model: "Qwen3.5-2B", metrics: { ...exactBoundary, macroSemanticAccuracy: 0.8, p95Ms: 2_000 } },
}), {
  selectedModel: "qwen2.5:3b",
  productionQualified: false,
  decision: "retain-baseline",
  reason: "candidate-no-material-benefit",
}, "candidate eligibility alone must not bypass the fixed material-benefit rule");
assert.deepEqual(selectVehicleSluModel({
  baseline: { model: "qwen2.5:3b", metrics: { ...exactBoundary, falseVehicleWriteCount: 2 } },
  candidate: {
    model: "Qwen3.5-2B",
    metrics: { ...exactBoundary, falseVehicleWriteCount: 0, keyChatFalseClarificationCount: 1 },
  },
}), {
  selectedModel: "Qwen3.5-2B",
  productionQualified: false,
  decision: "development-only",
  reason: "neither-eligible-safer-zero-false-write",
});

const runnerFixture = JSON.parse(await readFile(
  new URL("../../data/semantic-golden/vehicle-slu-2.0.0.json", import.meta.url),
  "utf8",
));
assert.equal(validateVehicleSluFixture(runnerFixture), runnerFixture,
  "the frozen fixture must match the current dynamic climate contract");
// A test-only copy with stale climate labels exercises contract-invalid case exclusion.
const staleFixture = structuredClone(runnerFixture);
for (const entry of staleFixture.cases.filter(({ id }) => (
  id === "slu-incomplete-control-007" || id === "slu-incomplete-control-008"
))) {
  const climateFrame = entry.expected.semanticEnvelope.vehicleFrames[0];
  climateFrame.missingSlots = ["temperature"];
  climateFrame.clarificationQuestion = "请告诉我空调要调到多少度。";
}
assert.throws(() => validateVehicleSluFixture(staleFixture),
  /slu-incomplete-control-007: incomplete-control frame/,
  "a stale missing-slot annotation must fail full validation");
assert.equal(validateVehicleSluFixture(staleFixture, { diagnostic: true }), staleFixture,
  "diagnostic validation should allow unrelated semantic drift outside its sample");

const truncatedFixture = { ...runnerFixture, cases: runnerFixture.cases.slice(0, -1) };
const expandedFixture = { ...runnerFixture, cases: [...runnerFixture.cases, structuredClone(runnerFixture.cases[0])] };
const unknownCategoryFixture = structuredClone(runnerFixture);
unknownCategoryFixture.cases[0].category = "unknown-category";
const missingCategoryFixture = structuredClone(runnerFixture);
delete missingCategoryFixture.cases[0].category;
const miscountedCategoryFixture = structuredClone(runnerFixture);
miscountedCategoryFixture.cases[0].category = "open-qa";
const wrongIdRangeFixture = structuredClone(runnerFixture);
wrongIdRangeFixture.cases[0].id = "slu-chat-031";
wrongIdRangeFixture.cases[0].expected.semanticEnvelope.requestId = "fixture:slu-chat-031";
const rootExtraKeyFixture = structuredClone(runnerFixture);
rootExtraKeyFixture.unexpected = true;
const caseExtraKeyFixture = structuredClone(runnerFixture);
caseExtraKeyFixture.cases[0].unexpected = true;
const expectedExtraKeyFixture = structuredClone(runnerFixture);
expectedExtraKeyFixture.cases[0].expected.unexpected = true;
const chatWriteMutantFixture = structuredClone(runnerFixture);
chatWriteMutantFixture.cases[0].expected.vehicleWriteCount = 1;
const zeroSafetyRejectFixture = structuredClone(runnerFixture);
const removedSafetyRejectCase = zeroSafetyRejectFixture.cases
  .find(({ id }) => id === "slu-non-execution-010");
removedSafetyRejectCase.expected.semanticEnvelope.vehicleFrames = [{
  ...frame("vehicle.knowledge.query", "none", { query: "安全提醒功能" }),
  frameId: "knowledge-1",
  speechAct: "command",
}];
removedSafetyRejectCase.expected.routeId = "vehicle-knowledge";
removedSafetyRejectCase.expected.disposition = "execute";
const multipleSafetyRejectFixture = structuredClone(runnerFixture);
const addedSafetyRejectCase = multipleSafetyRejectFixture.cases
  .find(({ id }) => id === "slu-non-execution-001");
addedSafetyRejectCase.expected.semanticEnvelope.vehicleFrames = [{
  ...frame("safety.reject", "none", {}),
  frameId: "safety-2",
  speechAct: "report",
}];
addedSafetyRejectCase.expected.routeId = null;
addedSafetyRejectCase.expected.disposition = "respond";

let validationFetchCalls = 0;
for (const [invalidFixture, expectedError] of [
  [truncatedFixture, /exactly 120 cases/],
  [expandedFixture, /exactly 120 cases/],
  [unknownCategoryFixture, /unknown fixture category/],
  [missingCategoryFixture, /unknown fixture category/],
  [miscountedCategoryFixture, /frozen category counts/],
  [wrongIdRangeFixture, /frozen ID range/],
  [rootExtraKeyFixture, /fixture: exact keys required/],
  [caseExtraKeyFixture, /case: exact keys required/],
  [expectedExtraKeyFixture, /expected: exact keys required/],
  [chatWriteMutantFixture, /chat outcome/],
  [zeroSafetyRejectFixture, /exactly one safety.reject/],
  [multipleSafetyRejectFixture, /exactly one safety.reject/],
]) {
  await assert.rejects(evaluateVehicleSluModels({
    models: ["model-a"],
    fixture: invalidFixture,
    baseUrl: "http://127.0.0.1:11434",
    fetchImpl: async () => {
      validationFetchCalls += 1;
      throw new Error("fetch must not run before fixture validation");
    },
  }), expectedError);
}
assert.equal(validationFetchCalls, 0, "all frozen-fixture failures must occur before the first fetch");
let diagnosticValidationFetchCalls = 0;
await assert.rejects(evaluateVehicleSluModels({
  models: ["model-a"],
  fixture: truncatedFixture,
  diagnostic: true,
  baseUrl: "http://127.0.0.1:11434",
  fetchImpl: async () => {
    diagnosticValidationFetchCalls += 1;
    throw new Error("diagnostic fetch must not run before complete fixture validation");
  },
}), /exactly 120 cases/);
assert.equal(diagnosticValidationFetchCalls, 0,
  "diagnostic mode must validate global fixture structure before sampling or fetch");

const calls = [];
let activeGenerateCalls = 0;
let maxActiveGenerateCalls = 0;
let generationIndex = 0;
const fakeFetch = async (url, options) => {
  const body = JSON.parse(options.body);
  calls.push({ url, body, hasSignal: Boolean(options.signal) });
  if (url.endsWith("/api/show")) {
    return response({
      details: {
        format: "gguf",
        family: "qwen",
        families: ["qwen"],
        parameter_size: "2B",
        quantization_level: "Q4_K_M",
      },
      template: "must-not-be-stored",
    });
  }
  activeGenerateCalls += 1;
  maxActiveGenerateCalls = Math.max(maxActiveGenerateCalls, activeGenerateCalls);
  await Promise.resolve();
  if (body.prompt.includes("RequestId: benchmark:warmup")) {
    activeGenerateCalls -= 1;
    return response({ response: "{}", total_duration: 1, eval_count: 1 });
  }
  const current = generationIndex++;
  activeGenerateCalls -= 1;
  if (current === 0) return response({ response: "not-json", total_duration: 12 });
  if (current === 1) return response({ response: "{}", total_duration: 14 });
  if (current === 2) {
    const error = new Error("injected abort");
    error.name = "AbortError";
    throw error;
  }
  if (current === 3) return response({}, 503);
  if (current === 4) {
    return response({
      response: JSON.stringify(envelope(`benchmark:${runnerFixture.cases[current].id}`, "vehicle", [{
        ...frame("vehicle.knowledge.query", "none", {
          query: {
            headers: { authorization: "Bearer secret" },
            credentials: { token: "secret" },
            chainOfThought: "private reasoning",
            rawResponse: "raw provider response",
          },
          vehicleModel: "M".repeat(500),
        }),
        frameId: "hostile-knowledge",
      }], "explain")),
      total_duration: 20,
    });
  }
  if (current === 5) {
    return response({
      response: JSON.stringify(envelope(`benchmark:${runnerFixture.cases[current].id}`, "vehicle", [{
        ...frame("vehicle.knowledge.query", "none", { query: "safe query", vehicleModel: "M".repeat(500) }),
        frameId: "valid-knowledge",
      }], "explain")),
      total_duration: 20,
      eval_count: 5,
    });
  }
  if (current === 6) {
    return response({
      response: JSON.stringify({
        ...runnerFixture.cases[current].expected.semanticEnvelope,
        requestId: "benchmark:mismatched-case",
      }),
      total_duration: 20,
    });
  }
  const sourceCase = runnerFixture.cases[current];
  return response({
    response: JSON.stringify({ ...sourceCase.expected.semanticEnvelope, requestId: `benchmark:${sourceCase.id}` }),
    total_duration: 20,
    eval_count: 5,
    hidden: "must-not-be-stored",
  });
};

const evaluated = await evaluateVehicleSluModels({
  models: ["model-a"],
  fixture: runnerFixture,
  baseUrl: "http://127.0.0.1:11434",
  fetchImpl: fakeFetch,
  platformSummary: { platform: "test", arch: "test", cpuCount: 1, cpuModel: "test" },
});
assert.equal(calls.length, 122, "one metadata call, one warmup, and exactly 120 case calls");
assert.deepEqual([new URL(calls[0].url).pathname, calls[0].body.model], ["/api/show", "model-a"]);
assert.deepEqual([new URL(calls[1].url).pathname, calls[1].body.model], ["/api/generate", "model-a"]);
assert.equal(calls[1].body.options.num_predict, 1, "the full profile prompt is prefetched with minimal generation");
assert.equal(evaluated.models[0].warmup.status, "ok");
assert.equal(evaluated.models[0].warmup.ollamaDurations.evalCount, 1);
for (let index = 0; index < runnerFixture.cases.length; index += 1) {
  const call = calls[index + 2];
  assert.deepEqual([new URL(call.url).pathname, call.body.model], ["/api/generate", "model-a"]);
  assert.ok(call.body.prompt.includes(`RequestId: benchmark:${runnerFixture.cases[index].id}`),
    `${runnerFixture.cases[index].id}: cases must retain frozen sequential order`,
  );
}
assert.equal(maxActiveGenerateCalls, 1, "models and cases must execute sequentially");
assert.ok(calls.every(({ hasSignal }) => hasSignal), "every local request must be abortable");
for (const call of calls.filter(({ url, body }) => url.endsWith("/api/generate")
  && body.options.num_predict !== 1)) {
  assert.equal(call.body.stream, false);
  assert.deepEqual(call.body.format, VEHICLE_SLU_OUTPUT_SCHEMA);
  assert.deepEqual({
    think: call.body.think,
    options: call.body.options,
  }, {
    think: false,
    options: { temperature: 0, num_predict: 128 },
  }, "every Vehicle-SLU evaluation generation must use production structured-generation controls");
}
assert.equal(evaluated.models[0].runs[0].status, "invalid-json");
assert.deepEqual(evaluated.models[0].runs.slice(0, 4).map(({ status, errorCode }) => ({ status, errorCode })), [
  { status: "invalid-json", errorCode: "INVALID_JSON" },
  { status: "contract-invalid", errorCode: "CONTRACT_INVALID" },
  { status: "timeout", errorCode: "TIMEOUT" },
  { status: "generation-error", errorCode: "OLLAMA_HTTP_503" },
]);
assert.equal(evaluated.models[0].runs[5].status, "ok", "contract failures must not stop later cases");
assert.deepEqual(
  { status: evaluated.models[0].runs[6].status, errorCode: evaluated.models[0].runs[6].errorCode },
  { status: "contract-invalid", errorCode: "CONTRACT_INVALID" },
  "a valid-looking response for a different request must fail the evaluator correlation boundary",
);
assert.equal(evaluated.models[0].runs.length, 120);
assert.equal(evaluated.fixture.caseCount, 120);
assert.equal(evaluated.evidenceLevel, "qualification", "default mode remains full qualification evidence");
assert.deepEqual(evaluated.models[0].modelMetadata, {
  format: "gguf",
  family: "qwen",
  families: ["qwen"],
  parameterSize: "2B",
  quantizationLevel: "Q4_K_M",
});
assert.equal(evaluated.models[0].evaluationProfile, "vehicle-slu-contract-v2");
assert.equal(evaluated.models[0].runs[0].errorCode, "INVALID_JSON");
assert.equal(evaluated.models[0].runs[0].coldWarm, "warm");
assert.equal(evaluated.models[0].runs[1].coldWarm, "warm");
assert.equal(evaluated.models[0].runs[5].ollamaDurations.totalDurationNs, 20);
assert.equal(evaluated.models[0].runs[5].ollamaDurations.evalCount, 5);
assert.deepEqual(evaluated.models[0].runs[5].prediction, {
  contractVersion: CONTRACT,
  domain: "vehicle",
  conversationNeed: "explain",
  vehicleFrames: [{
    capability: "knowledge",
    intent: "vehicle.knowledge.query",
    speechAct: "question",
    knowledgeNeed: "manual",
    actionNeed: "none",
    missingSlots: [],
    clarificationQuestion: null,
    standaloneQuery: "safe query",
    slots: { query: "safe query", vehicleModel: "M".repeat(160) },
  }],
});
assert.equal(evaluated.models[0].runs[4].status, "contract-invalid",
  "hostile non-primitive slot data must fail the semantic contract");
assert.deepEqual(evaluated.models[0].runs[5].prediction.vehicleFrames[0].slots, {
  query: "safe query",
  vehicleModel: "M".repeat(160),
}, "public slot projection keeps bounded contract-valid primitive values");
assert.equal(evaluated.models[0].metrics.contractInvalidCount, 4);
assert.equal(evaluated.models[0].metrics.timeoutCount, 1);
assert.equal(evaluated.models[0].metrics.generationErrorCount, 1);
assert.ok(!JSON.stringify(evaluated).includes("conversationGoal"), "stored predictions must omit free-form summaries");
assert.ok(!JSON.stringify(evaluated).includes("must-not-be-stored"));
for (const forbiddenKey of ["rawPrompt", "rawResponse", "headers", "authorization", "credentials", "chainOfThought"]) {
  assert.ok(!JSON.stringify(evaluated).includes(forbiddenKey));
}

await assert.rejects(
  evaluateVehicleSluModels({
    models: ["model-a"],
    fixture: { ...runnerFixture, contractVersion: "wrong" },
    baseUrl: "http://127.0.0.1:11434",
    fetchImpl: async () => assert.fail("fixture validation must happen before inference"),
  }),
  /fixture contractVersion/,
);
await assert.rejects(
  evaluateVehicleSluModels({ models: ["model-a"], fixture: runnerFixture, baseUrl: "https://example.com", fetchImpl: fakeFetch }),
  /local Ollama/,
);

assert.equal(VEHICLE_SLU_CASE_TIMEOUT_MS, 3_000);
const evaluatorSource = await readFile(new URL("../benchmarks/evaluate-vehicle-slu-models.mjs", import.meta.url), "utf8");
for (const forbidden of ["DashScope", "CloudLLMAdapter", "/api/local-llm", "dashscope.aliyuncs.com", "api.openai.com"]) {
  assert.ok(!evaluatorSource.includes(forbidden), `evaluator must not contain forbidden provider path: ${forbidden}`);
}
assert.ok(!/\bretr(?:y|ies|ied|ying)\b/i.test(evaluatorSource), "evaluator must not implement retries");

const diagnosticCalls = [];
let diagnosticActiveCalls = 0;
let diagnosticMaxActiveCalls = 0;
const diagnosticFetch = async (url, options) => {
  diagnosticActiveCalls += 1;
  diagnosticMaxActiveCalls = Math.max(diagnosticMaxActiveCalls, diagnosticActiveCalls);
  await Promise.resolve();
  diagnosticActiveCalls -= 1;
  const body = JSON.parse(options.body);
  diagnosticCalls.push({ pathname: new URL(url).pathname, body, hasSignal: Boolean(options.signal) });
  if (url.endsWith("/api/show")) return response({ details: {} });
  const caseId = /RequestId: benchmark:([^\n]+)/.exec(body.prompt)?.[1];
  if (caseId === "warmup") return response({ response: "{}", total_duration: 1, eval_count: 1 });
  const sourceCase = runnerFixture.cases.find(({ id }) => id === caseId);
  assert.ok(sourceCase, `diagnostic fake received an unknown case: ${caseId}`);
  return response({
    response: JSON.stringify({
      ...sourceCase.expected.semanticEnvelope,
      requestId: `benchmark:${sourceCase.id}`,
    }),
  });
};
const diagnosticEvaluated = await evaluateVehicleSluModels({
  models: ["diagnostic-a", "diagnostic-b"],
  fixture: staleFixture,
  diagnostic: true,
  baseUrl: "http://127.0.0.1:11434",
  fetchImpl: diagnosticFetch,
  platformSummary: { platform: "test", arch: "test", cpuCount: 1, cpuModel: "test" },
});
const expectedDiagnosticCaseIds = [
  "slu-chat-001", "slu-chat-002",
  "slu-open-qa-001", "slu-open-qa-002",
  "slu-vehicle-knowledge-001", "slu-vehicle-knowledge-002",
  "slu-complete-control-001", "slu-complete-control-002",
  "slu-incomplete-control-001", "slu-incomplete-control-002",
  "slu-services-001", "slu-services-002",
  "slu-non-execution-001", "slu-non-execution-002",
  "slu-mixed-001", "slu-mixed-002",
];
assert.equal(diagnosticCalls.length, 36,
  "two diagnostic models use exactly 2 metadata, 2 warmups, and 32 case calls");
assert.equal(diagnosticMaxActiveCalls, 1, "diagnostic metadata and generations remain sequential");
assert.ok(diagnosticCalls.every(({ hasSignal }) => hasSignal), "every diagnostic request remains abortable");
assert.deepEqual(diagnosticCalls.map(({ pathname, body }) => [pathname, body.options?.num_predict]), [
  ["/api/show", undefined], ["/api/generate", 1], ...Array(16).fill(["/api/generate", 128]),
  ["/api/show", undefined], ["/api/generate", 1], ...Array(16).fill(["/api/generate", 128]),
]);
assert.deepEqual(diagnosticCalls
  .filter(({ pathname, body }) => pathname === "/api/generate" && body.options.num_predict !== 1)
  .map(({ body }) => /RequestId: benchmark:([^\n]+)/.exec(body.prompt)?.[1]), [
  ...expectedDiagnosticCaseIds,
  ...expectedDiagnosticCaseIds,
], "diagnostic mode picks the first contract-valid cases in every frozen category");
assert.deepEqual(diagnosticEvaluated.models.map(({ runs }) => runs.length), [16, 16]);
assert.deepEqual(diagnosticEvaluated.models.map(({ metrics }) => metrics.gatesPassed), [true, true],
  "diagnostic ineligibility must be independent of passing projected metrics");
assert.equal(diagnosticEvaluated.fixture.caseCount, 120, "diagnostic evidence retains the validated source size");
assert.equal(diagnosticEvaluated.evidenceLevel, "diagnostic");
assert.deepEqual(diagnosticEvaluated.sampling, {
  strategy: "first-contract-valid-per-frozen-category",
  perCategory: 2,
  caseCount: 16,
  caseIds: expectedDiagnosticCaseIds,
  excludedCases: [
    { caseId: "slu-incomplete-control-007", reason: "slu-incomplete-control-007: incomplete-control frame" },
    { caseId: "slu-incomplete-control-008", reason: "slu-incomplete-control-008: incomplete-control frame" },
  ],
});
assert.deepEqual(diagnosticEvaluated.decision, {
  selectedModel: null,
  productionQualified: false,
  decision: "diagnostic-only",
  reason: "diagnostic-sample-not-qualification",
});
const diagnosticSummary = buildVehicleSluEvaluationSummary({
  createdAt: "2026-08-07T00:00:00.000Z",
  ...diagnosticEvaluated,
});
assert.ok(diagnosticSummary.includes("- Evidence: diagnostic"));
assert.ok(diagnosticSummary.includes("- Sample: 16/120 cases (first 2 contract-valid per category)"),
  "diagnostic summary must distinguish the metric sample from the validated fixture source");
assert.ok(diagnosticSummary.includes("- Excluded stale labels: slu-incomplete-control-007, slu-incomplete-control-008"),
  "diagnostic summary must disclose cases skipped for stale fixture labels");
assert.ok(diagnosticSummary.includes("| diagnostic-a | n/a |"),
  "diagnostic summary must render eligibility as n/a");
assert.ok(!diagnosticSummary.includes("| diagnostic-a | yes |"));
assert.ok(!diagnosticSummary.includes("| diagnostic-a | no |"));
assert.ok(diagnosticSummary.includes(
  "Decision: **diagnostic-only** — diagnostic-sample-not-qualification.",
), "diagnostic summary must not present null as a selected production model");
let diagnosticAllGenerateCalls = 0;
const diagnosticAllEvaluated = await evaluateVehicleSluModels({
  models: ["diagnostic-all"],
  fixture: staleFixture,
  diagnostic: true,
  diagnosticAll: true,
  baseUrl: "http://127.0.0.1:11434",
  fetchImpl: async (url) => {
    if (url.endsWith("/api/show")) return response({ details: {} });
    diagnosticAllGenerateCalls += 1;
    return response({ response: "not-json" });
  },
  platformSummary: { platform: "test", arch: "test", cpuCount: 1, cpuModel: "test" },
});
assert.equal(diagnosticAllEvaluated.evidenceLevel, "diagnostic");
assert.equal(diagnosticAllEvaluated.models[0].runs.length, diagnosticAllEvaluated.sampling.caseCount);
assert.equal(diagnosticAllGenerateCalls, diagnosticAllEvaluated.sampling.caseCount + 1,
  "diagnostic-all adds one unmeasured model warmup before measured cases");
assert.equal(diagnosticAllEvaluated.sampling.strategy, "all-contract-valid-cases");
assert.ok(diagnosticAllEvaluated.sampling.caseCount > 16,
  "all-case diagnostic mode must include more than the quick category sample");
assert.deepEqual(diagnosticAllEvaluated.sampling.excludedCases.map(({ caseId }) => caseId), [
  "slu-incomplete-control-007",
  "slu-incomplete-control-008",
]);
const diagnosticAllSummary = buildVehicleSluEvaluationSummary({
  createdAt: "2026-08-07T00:00:00.000Z",
  ...diagnosticAllEvaluated,
});
assert.ok(diagnosticAllSummary.includes("all contract-valid cases"));
const qualificationSummary = buildVehicleSluEvaluationSummary({
  createdAt: "2026-08-07T00:00:00.000Z",
  ...evaluated,
  decision: null,
});
assert.ok(qualificationSummary.includes("- Evidence: qualification"),
  "full summary must identify qualification evidence explicitly");

const compactCalls = [];
const compactFetch = async (url, options) => {
  const body = JSON.parse(options.body);
  compactCalls.push({ url, body, hasSignal: Boolean(options.signal) });
  if (url.endsWith("/api/show")) return response({ details: {} });
  const sourceCase = runnerFixture.cases.find(({ text }) => body.prompt.endsWith(`用户:${text}`));
  assert.ok(sourceCase, "compact prompt must retain the exact source utterance");
  const expected = sourceCase.expected.semanticEnvelope;
  return response({
    response: JSON.stringify({
      d: expected.domain,
      n: expected.conversationGoal.need,
      f: expected.vehicleFrames.map((entry) => ({
        i: entry.intent,
        s: entry.speechAct,
        a: entry.actionNeed,
        p: entry.slots,
        ...(entry.knowledgeNeed === "manual" ? { k: "manual" } : {}),
      })),
    }),
    total_duration: 20,
    eval_count: 5,
    hidden: "must-not-be-stored",
  });
};
const compactEvaluated = await evaluateVehicleSluModels({
  models: [VEHICLE_SLU_COMPACT_MODEL],
  fixture: runnerFixture,
  baseUrl: "http://127.0.0.1:11434",
  fetchImpl: compactFetch,
  platformSummary: { platform: "test", arch: "test", cpuCount: 1, cpuModel: "test" },
});
assert.equal(compactCalls.length, 122);
assert.ok(compactCalls.every(({ hasSignal }) => hasSignal));
const compactGenerateCalls = compactCalls.filter(({ url }) => url.endsWith("/api/generate"));
assert.ok(compactGenerateCalls.every(({ body }) => body.system === VEHICLE_SLU_COMPACT_SYSTEM));
assert.ok(compactGenerateCalls.every(({ body }) => isDeepStrictEqual(body.format, VEHICLE_SLU_COMPACT_OUTPUT_FORMAT)));
assert.equal(compactGenerateCalls[0].body.options.num_predict, 1,
  "compact warmup uses the full compact prompt and output format with one generated token");
assert.ok(compactGenerateCalls.slice(1).every(({ body }) => body.options.num_predict === 512
  && body.options.num_ctx === 4096
  && body.options.temperature === 0));
assert.ok(compactGenerateCalls.every(({ body }) => body.prompt.includes(VEHICLE_SLU_COMPACT_PROMPT_VERSION)));
for (const rule of [
  "要求关闭安全保护用safety.reject、s=command、a=none、p={}",
  "导航未说起点只允许origin=当前位置",
  "天气location、导航/补能destination、媒体query、电话contact分别逐字提取各自目标",
]) {
  assert.ok(compactGenerateCalls.every(({ body }) => body.prompt.includes(rule)),
    `compact prompt must carry the ontology rule: ${rule}`);
}
assert.equal(compactEvaluated.models[0].evaluationProfile, VEHICLE_SLU_COMPACT_PROFILE);
assert.equal(compactEvaluated.models[0].promptVersion, VEHICLE_SLU_COMPACT_PROMPT_VERSION);
// The qualified compact prompt bytes are pinned; changing them requires a prompt version bump.
assert.equal(
  createHash("sha256").update(buildVehicleSluCompactV9Prompt({ text: "x" })).digest("hex"),
  "b06a806ff3a9bf56f7066866e316e065e6635b4a35b9454e1261cb89dbb639ff",
  `${VEHICLE_SLU_COMPACT_PROMPT_VERSION} prompt bytes changed without a version bump`,
);
assert.equal(compactEvaluated.models[0].metrics.semanticAccuracy, 1,
  "compact output must expand through the production contract before metric projection");
assert.equal(compactEvaluated.models[0].metrics.falseVehicleWriteCount, 0);

const expandedSeatClarification = expandVehicleSluCompact({
  d: "vehicle",
  n: "none",
  f: [{ i: "seat.comfort.setLevel", s: "command", a: "clarify", p: {} }],
}, { requestId: "fixture:seat-comfort-clarification", text: "把座椅调舒服一点。" });
assert.deepEqual(expandedSeatClarification.vehicleFrames[0].missingSlots, ["seatZone", "seatMode", "level"]);
assert.equal(expandedSeatClarification.vehicleFrames[0].actionNeed, "clarify");
assert.equal(expandedSeatClarification.vehicleFrames[0].clarificationQuestion,
  "请告诉我要调节哪个座位的加热或通风，以及要调到几挡。");
for (const slots of [
  { seatZone: "driver" },
  { seatMode: "heat" },
  { level: 1 },
  { seatZone: "driver", seatMode: "heat" },
  { seatZone: "driver", level: 1 },
  { seatMode: "heat", level: 1 },
]) {
  const clarification = expandVehicleSluCompact({
    d: "vehicle",
    n: "none",
    f: [{ i: "seat.comfort.setLevel", s: "command", a: "clarify", p: slots }],
  }, { requestId: `fixture:seat-comfort-clarification:${Object.keys(slots).join("+")}`, text: "座椅舒适设置" });
  assert.equal(clarification.vehicleFrames[0].actionNeed, "clarify");
  assert.ok(clarification.vehicleFrames[0].missingSlots.length > 0);
  assert.ok(clarification.vehicleFrames[0].clarificationQuestion);
}
const compactSummary = buildVehicleSluEvaluationSummary({
  createdAt: "2026-09-23T00:00:00.000Z",
  ...compactEvaluated,
  decision: null,
});
assert.ok(compactSummary.includes(`${VEHICLE_SLU_COMPACT_PROFILE} (${VEHICLE_SLU_COMPACT_PROMPT_VERSION})`));

assert.deepEqual(parseVehicleSluEvaluatorArguments([
  "--diagnostic",
  "--models", "model-a, model-b",
  "--fixture", "fixture.json",
]), {
  models: ["model-a", "model-b"],
  fixture: "fixture.json",
  diagnostic: true,
  diagnosticAll: false,
}, "--diagnostic is a valueless flag");
assert.deepEqual(parseVehicleSluEvaluatorArguments([
  "--models", "model-a",
  "--fixture", "fixture.json",
]), {
  models: ["model-a"],
  fixture: "fixture.json",
  diagnostic: false,
  diagnosticAll: false,
}, "omitting --diagnostic preserves full qualification mode");
assert.deepEqual(parseVehicleSluEvaluatorArguments([
  "--diagnostic-all",
  "--models", "model-a",
  "--fixture", "fixture.json",
]), {
  models: ["model-a"],
  fixture: "fixture.json",
  diagnostic: true,
  diagnosticAll: true,
}, "--diagnostic-all must remain non-qualifying while scanning contract-valid fixture rows");
for (const invalidArguments of [
  ["--diagnostic", "--diagnostic", "--models", "model-a", "--fixture", "fixture.json"],
  ["--models", "model-a", "--models", "model-b", "--fixture", "fixture.json"],
  ["--models", "model-a", "--fixture", "one.json", "--fixture", "two.json"],
  ["--models", "model-a", "--fixture", "fixture.json", "--unknown"],
  ["--diagnostic", "true", "--models", "model-a", "--fixture", "fixture.json"],
  ["--models", "model-a"],
  ["--fixture", "fixture.json"],
]) {
  assert.throws(() => parseVehicleSluEvaluatorArguments(invalidArguments), TypeError,
    `CLI must fail closed: ${invalidArguments.join(" ")}`);
}

console.log("Vehicle-SLU evaluator verification passed");

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; },
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
