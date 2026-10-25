import assert from "node:assert/strict";
import { createModelProviderRegistry } from "../../src/server/model-providers/model-provider-registry.js";
import { ModelProviderError } from "../../src/server/model-providers/model-provider-contract.js";
import { runVehicleSluSemanticBoundary } from "../../src/server/local-agent-server.mjs";
import { VEHICLE_SLU_COMPACT_MODEL } from "../../src/semantic/vehicle-slu-compact-v9.js";

const compactProfile = { task: "vehicle_slu", provider: "ollama", model: VEHICLE_SLU_COMPACT_MODEL, mode: "non-thinking", schemaVersion: "nio-vehicle-slu-contract@2.0.0", watchdogMs: null };
const primaryProfile = { task: "vehicle_slu", provider: "dashscope", model: "qwen3.5-flash", mode: "non-thinking", watchdogMs: null, fallback: { provider: "ollama", model: "qwen3:8b" } };

function harness(profile, primaryGenerate, fallbackGenerate) {
  const calls = [];
  const registry = createModelProviderRegistry({
    taskProfiles: { [profile.task]: profile },
    connections: { ollama: { readiness: { status: "ready" } }, dashscope: { readiness: { status: "ready" } } },
    providerFactories: {
      [profile.provider]: ({ profile: selected }) => ({ id: selected.provider, model: selected.model, async generate(request) { calls.push({ provider: selected.provider, request }); return primaryGenerate(request, calls.length); } }),
      ...(profile.fallback ? { [profile.fallback.provider]: ({ profile: selected }) => ({ id: selected.provider, model: selected.model, async generate(request) { calls.push({ provider: selected.provider, request }); return fallbackGenerate(request); } }) } : {}),
    },
  });
  return { registry, calls };
}

function generated(profile, value) {
  return { provider: profile.provider, model: profile.model, text: typeof value === "string" ? value : JSON.stringify(value), durationMs: 1, externalModelRequestCount: 1 };
}

const compactEmpty = { d: "non_vehicle", n: "social", f: [] };
const badExecution = { d: "vehicle", n: "none", f: [{ i: "body.window.setPosition", s: "command", a: "execute", p: { zone: "front_left" } }] };
for (const [label, value, valid] of [["valid", compactEmpty, true], ["invalid-json", "{", false], ["invalid-schema", {}, false], ["missing-slot", badExecution, false]]) {
  const { registry, calls } = harness(compactProfile, () => generated(compactProfile, value));
  const result = await runVehicleSluSemanticBoundary({ text: "合成离线输入", requestId: `single-${label}`, registry, externalModelRequestLimit: 2 });
  assert.equal(calls.length, 1, `${label} must make one primary attempt even with budget 2`);
  assert.equal(result.semanticEnvelope !== null, valid);
  assert.equal(result.telemetry.externalModelRequestCount, 1);
  if (!valid) {
    assert.equal(result.reasonCode, "semantic-contract-invalid");
    assert.equal(result.executionDisabled, true);
  }
}

for (const count of [0, 1]) {
  const { registry, calls } = harness(primaryProfile, () => {
    throw new ModelProviderError("synthetic primary unavailable", { code: count ? "provider-network-error" : "provider-config-invalid", provider: primaryProfile.provider, externalModelRequestCount: count });
  }, () => { throw new Error("SLU fallback must never run"); });
  const result = await runVehicleSluSemanticBoundary({ text: "合成离线输入", requestId: `primary-failed-${count}`, registry, externalModelRequestLimit: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "dashscope");
  assert.equal(result.semanticEnvelope, null);
  assert.equal(result.executionDisabled, true);
  assert.equal(result.telemetry.externalModelRequestCount, count);
  assert.equal(Object.hasOwn(result.telemetry, "fallbackAttempted"), false);
}

for (const text of ["北京今天天气怎么样", "这里今天天气怎么样", "目的地今天天气怎么样"]) {
  const value = { contractVersion: "nio-vehicle-slu-contract@2.0.0", requestId: "weather-model-value", domain: "vehicle", conversationGoal: { summary: "天气", need: "explain" }, domainConfidence: 0, vehicleFrames: [{ frameId: "f1", capability: "weather", intent: "weather.query", speechAct: "question", knowledgeNeed: "none", actionNeed: "none", slots: { location: "上海", timeRange: "today" }, missingSlots: [], clarificationQuestion: null, standaloneQuery: null, confidence: 0 }] };
  const { registry, calls } = harness(primaryProfile, () => generated(primaryProfile, value));
  const result = await runVehicleSluSemanticBoundary({ text, requestId: value.requestId, registry });
  assert.equal(calls.length, 1);
  assert.equal(result.semanticEnvelope.vehicleFrames[0].slots.location, "上海");
  delete value.vehicleFrames[0].slots.location;
  const missing = await runVehicleSluSemanticBoundary({ text, requestId: value.requestId, registry });
  assert.equal(Object.hasOwn(missing.semanticEnvelope.vehicleFrames[0].slots, "location"), false);
}

// The selected registry task owns this policy; a caller's request.task cannot bypass it.
{
  const { registry, calls } = harness(primaryProfile, () => generated(primaryProfile, "{}"), () => { throw new Error("unexpected fallback"); });
  await registry.generateForTask("vehicle_slu", { task: "cabin_response", structuredOutput: { validate: () => { throw new Error("synthetic invalid"); }, repairPrompt: () => "repair" }, externalModelRequestLimit: 2 });
  assert.equal(calls.length, 1);
}

for (const task of ["cabin_response", "knowledge_answer"]) {
  const profile = { ...primaryProfile, task };
  const repaired = harness(profile, (_request, count) => generated(profile, count === 1 ? "{}" : '{"valid":true}'));
  const request = { task: "vehicle_slu", prompt: "synthetic", structuredOutput: { validate: text => { assert.equal(JSON.parse(text).valid, true); }, repairPrompt: () => "synthetic repair" } };
  const repairResult = await repaired.registry.generateForTask(task, request);
  assert.equal(repaired.calls.length, 2, `${task} must retain schema repair`);
  assert.equal(repairResult.externalModelRequestCount, 2);

  const fallback = harness(profile, () => { throw new ModelProviderError("synthetic primary unavailable", { code: "provider-network-error", provider: "dashscope", externalModelRequestCount: 1 }); }, () => generated({ provider: "ollama", model: "qwen3:8b" }, '{"valid":true}'));
  const fallbackResult = await fallback.registry.generateForTask(task, request);
  assert.equal(fallback.calls.length, 2, `${task} must retain fallback`);
  assert.equal(fallbackResult.fallbackActive, true);
  assert.equal(fallbackResult.externalModelRequestCount, 2);
}

console.log("Vehicle-SLU semantic authority boundary verification passed (mocked providers; zero network/model/service calls)");
