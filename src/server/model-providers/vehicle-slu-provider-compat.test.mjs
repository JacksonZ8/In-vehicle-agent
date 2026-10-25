import assert from "node:assert/strict";
import test from "node:test";

import { normalizeVehicleSluGeneratedEnvelope } from "../../semantic/vehicle-slu-generated-normalizer.js";
import {
  createVehicleSluEnvelope,
  VEHICLE_SLU_OUTPUT_SCHEMA,
} from "../../semantic/vehicle-slu-contract.js";
import {
  createDashScopeModelProvider,
  projectDashScopeToolSchema,
} from "./dashscope-model-provider.js";
import { createModelProviderRegistry } from "./model-provider-registry.js";

function collectSchemaKeys(value, keys = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSchemaKeys(entry, keys));
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, entry] of Object.entries(value)) {
    keys.push(key);
    collectSchemaKeys(entry, keys);
  }
  return keys;
}

test("DashScope Vehicle-SLU tool schema uses the verified compatible subset", async () => {
  const original = structuredClone(VEHICLE_SLU_OUTPUT_SCHEMA);
  const projected = projectDashScopeToolSchema(VEHICLE_SLU_OUTPUT_SCHEMA);
  const schemaKeys = collectSchemaKeys(projected);

  assert.deepEqual(VEHICLE_SLU_OUTPUT_SCHEMA, original);
  assert.equal(schemaKeys.includes("const"), false);
  assert.equal(schemaKeys.includes("uniqueItems"), false);
  assert.equal(schemaKeys.includes("minLength"), false);
  for (const unsupported of [
    "additionalProperties",
    "maxLength",
    "maximum",
    "minimum",
    "pattern",
  ]) {
    assert.equal(schemaKeys.includes(unsupported), false, `${unsupported} must be removed`);
  }
  assert.equal(projected.properties.contractVersion.enum[0], "nio-vehicle-slu-contract@2.0.0");
  assert.equal(
    projected.properties.vehicleFrames.items.properties.standaloneQuery.type,
    "string",
  );

  let requestBody;
  const provider = createDashScopeModelProvider({
    apiKey: "test-only",
    baseUrl: "https://dashscope.invalid/compatible-mode/v1",
    model: "qwen3.5-flash",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            tool_calls: [{ function: { arguments: "{\"intent\":\"weather.query\"}" } }],
          },
        }],
        usage: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await provider.generate({
    task: "vehicle_slu",
    prompt: "Return JSON",
    outputMode: "json-object",
    jsonSchema: VEHICLE_SLU_OUTPUT_SCHEMA,
  });
  assert.deepEqual(requestBody.tools[0].function.parameters, projected);
});

test("DashScope exposes invalid request responses as a distinct fallback reason", async () => {
  const provider = createDashScopeModelProvider({
    apiKey: "test-only",
    baseUrl: "https://dashscope.invalid/compatible-mode/v1",
    model: "qwen3.5-flash",
    fetchImpl: async () => new Response("Invalid request parameters", { status: 400 }),
  });

  await assert.rejects(
    provider.generate({
      task: "vehicle_slu",
      prompt: "Return JSON",
      outputMode: "json-object",
      jsonSchema: VEHICLE_SLU_OUTPUT_SCHEMA,
    }),
    (error) => error?.code === "provider-invalid-request"
      && error?.details?.upstreamStatus === 400,
  );
});

test("Cabin response retains fallback after a DashScope invalid request", async () => {
  const registry = createModelProviderRegistry({
    taskProfiles: {
      cabin_response: {
        task: "cabin_response",
        provider: "dashscope",
        model: "qwen3.5-flash",
        mode: "non-thinking",
        readiness: { status: "ready" },
        fallback: {
          provider: "ollama",
          model: "qwen3:8b",
          mode: "non-thinking",
          readiness: { status: "ready" },
        },
      },
    },
    connections: {
      dashscope: {
        apiKey: "test-only",
        baseUrl: "https://dashscope.invalid/compatible-mode/v1",
        readiness: { status: "ready" },
      },
      ollama: { readiness: { status: "ready" } },
    },
    fetchImpl: async () => new Response("Invalid request parameters", { status: 400 }),
    providerFactories: {
      ollama: ({ profile }) => ({
        id: "ollama",
        model: profile.model,
        async generate() {
          return {
            provider: "ollama",
            model: profile.model,
            text: "{}",
            externalModelRequestCount: 1,
          };
        },
      }),
    },
  });

  const generated = await registry.generateForTask("cabin_response", {
    task: "cabin_response",
    prompt: "Return JSON",
    outputMode: "json-object",
    jsonSchema: VEHICLE_SLU_OUTPUT_SCHEMA,
  });
  assert.equal(generated.provider, "ollama");
  assert.equal(generated.fallbackActive, true);
  assert.equal(generated.primaryFailureReasonCode, "provider-invalid-request");
  assert.equal(generated.externalModelRequestCount, 2);
});

test("Vehicle-SLU generated normalization clears irrelevant presentation fields", () => {
  const generated = {
    vehicleFrames: [{
      intent: "weather.query",
      actionNeed: "none",
      knowledgeNeed: "none",
      clarificationQuestion: "请补充参数",
      standaloneQuery: "上海今天天气怎么样",
      slots: { location: "上海", timeRange: "今天" },
    }],
  };

  const normalized = normalizeVehicleSluGeneratedEnvelope(generated);
  assert.equal(normalized.vehicleFrames[0].clarificationQuestion, null);
  assert.equal(normalized.vehicleFrames[0].standaloneQuery, null);
  assert.deepEqual(normalized.vehicleFrames[0].slots, { location: "上海", timeRange: "今天" });
  assert.equal(generated.vehicleFrames[0].slots.location, "上海");
});

test("Vehicle-SLU generated normalization drops readonly missingSlots as non-action formatting", () => {
  const generated = {
    requestId: "weather-no-location",
    domain: "vehicle",
    conversationGoal: { summary: "查询今天天气", need: "none" },
    vehicleFrames: [{
      frameId: "weather-1",
      intent: "weather.query",
      capability: "weather",
      speechAct: "question",
      knowledgeNeed: "none",
      actionNeed: "none",
      slots: { timeRange: "today" },
      missingSlots: ["location"],
      clarificationQuestion: "请问要查哪个城市？",
      standaloneQuery: null,
      confidence: 0.95,
    }],
    domainConfidence: 0.98,
  };

  const normalized = normalizeVehicleSluGeneratedEnvelope(generated);
  assert.deepEqual(normalized.vehicleFrames[0].missingSlots, []);
  assert.equal(normalized.vehicleFrames[0].clarificationQuestion, null);
  assert.doesNotThrow(() => createVehicleSluEnvelope(normalized));
});

test("Vehicle-SLU generated normalization preserves model weather location", () => {
  const generated = {
    vehicleFrames: [{
      intent: "weather.query",
      actionNeed: "none",
      knowledgeNeed: "none",
      clarificationQuestion: null,
      standaloneQuery: null,
      slots: { location: "北京", timeRange: "今天" },
    }],
  };

  const normalized = normalizeVehicleSluGeneratedEnvelope(generated, {
    explicitWeatherLocation: "上海",
  });
  assert.equal(normalized.vehicleFrames[0].slots.location, "北京");
});

test("Vehicle-SLU generated normalization cannot derive model weather location references", () => {
  const generated = {
    vehicleFrames: [{
      intent: "weather.query",
      actionNeed: "none",
      knowledgeNeed: "none",
      clarificationQuestion: null,
      standaloneQuery: null,
      slots: { location: "北京", timeRange: "今天" },
    }],
  };

  const normalized = normalizeVehicleSluGeneratedEnvelope(generated, {
    weatherLocationReference: "current",
  });
  assert.equal(normalized.vehicleFrames[0].slots.location, "北京");
});
