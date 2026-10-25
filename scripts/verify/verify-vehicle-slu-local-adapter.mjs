import assert from "node:assert/strict";
import { LocalModelAdapter } from "../../src/semantic/local-model-adapter.js";
import { buildVehicleSluPrompt } from "../../src/semantic/vehicle-slu-prompt.js";
import { runVehicleSluSemanticBoundary } from "../../src/server/local-agent-server.mjs";
import { ModelProviderError } from "../../src/server/model-providers/model-provider-contract.js";
import { createModelProviderRegistry } from "../../src/server/model-providers/model-provider-registry.js";
import {
  createPublicModelTaskProfileSet,
  resolveModelTaskProfiles,
} from "../../src/server/model-providers/model-task-profile.js";
import {
  ACTION_NEEDS,
  CONVERSATION_NEEDS,
  KNOWLEDGE_NEEDS,
  SPEECH_ACTS,
  VEHICLE_SLU_CAPABILITIES,
  VEHICLE_SLU_CONTRACT,
  VEHICLE_SLU_DOMAINS,
  VEHICLE_SLU_OUTPUT_SCHEMA,
  VEHICLE_SLU_PROMPT_VERSION,
  VEHICLE_SLU_SLOT_SCHEMAS,
} from "../../src/semantic/vehicle-slu-contract.js";

const CONTRACT_VERSION = "nio-vehicle-slu-contract@2.0.0";
const PRIMARY_PROVIDER = "dashscope";
const PRIMARY_MODEL = "qwen3.5-flash";
const PUBLIC_VEHICLE_SLU_PROFILE = Object.freeze({
  provider: PRIMARY_PROVIDER,
  model: PRIMARY_MODEL,
  mode: "non-thinking",
  schemaVersion: CONTRACT_VERSION,
  fallbackConfigured: true,
  watchdogMs: null,
  readiness: Object.freeze({ status: "ready" }),
});

const sharedPrompt = buildVehicleSluPrompt({
  text: "  把主驾车窗打开一半  ",
  requestId: "prompt-contract-check",
});
assert.match(sharedPrompt, new RegExp(`Contract: ${VEHICLE_SLU_CONTRACT.ref}`));
assert.match(sharedPrompt, new RegExp(`Prompt: ${VEHICLE_SLU_PROMPT_VERSION}`));
for (const capability of ["control", "knowledge", "navigation", "weather", "media", "phone"]) {
  assert.ok(sharedPrompt.includes(`${capability}:`), `prompt must include ${capability} ontology`);
}
// Budget covers the ES8 cabin ontology and fixed clarify templates; the default local profile uses the compact prompt.
assert.ok(sharedPrompt.length <= 4_500, `prompt must stay within 4500 chars, got ${sharedPrompt.length}`);
assert.doesNotMatch(sharedPrompt, /JSON shape:/);
assert.match(sharedPrompt, /front_left.*front_right.*rear_left.*rear_right/);
assert.match(sharedPrompt, /body\.window\.setPosition.*zone.*percent/);
assert.match(sharedPrompt, /vehicle\.state\.query.*stateFields.*windowPositionPercentByZone/);
assert.match(sharedPrompt, /vehicle.*non_vehicle.*unknown/);
assert.match(sharedPrompt, /knowledgeNeed/);
assert.match(sharedPrompt, /actionNeed/);
assert.match(sharedPrompt, /missingSlots/);
assert.match(sharedPrompt, /standaloneQuery/);
assert.match(sharedPrompt, /execute/);
assert.match(sharedPrompt, /clarify/);
assert.match(sharedPrompt, /readonly/);
assert.match(sharedPrompt, /独立请求.*独立 frame.*不得折叠/);
assert.match(sharedPrompt, /普通否定、假设、陈述和信息问题不得输出 execute/);
assert.match(sharedPrompt, /不要输出.*推理过程/);
assert.doesNotMatch(sharedPrompt, /请(?:展示|给出|解释).*(?:思维链|推理过程)|chain[- ]of[- ]thought/i);
assert.match(sharedPrompt, /RequestId: prompt-contract-check/);
assert.match(sharedPrompt, /User: 把主驾车窗打开一半$/);

const expectedIntents = [
  "body.window.setPosition",
  "body.tailgate.open",
  "seat.driver.setBackrestAngle",
  "seat.comfort.setLevel",
  "cabin.comfort.applySettings",
  "vehicle.component.setState",
  "cabin.climate.setPreset",
  "safety.reject",
  "vehicle.knowledge.query",
  "vehicle.state.query",
  "navigation.planRoute",
  "energy.findSwapStation",
  "navigation.cancel",
  "weather.query",
  "media.play",
  "phone.call",
];
for (const intent of expectedIntents) assert.ok(sharedPrompt.includes(intent), `prompt must retain ${intent}`);

assert.equal(VEHICLE_SLU_OUTPUT_SCHEMA.type, "object");
assert.equal(VEHICLE_SLU_OUTPUT_SCHEMA.additionalProperties, false);
assert.deepEqual(VEHICLE_SLU_OUTPUT_SCHEMA.required, [
  "contractVersion", "requestId", "domain", "conversationGoal", "vehicleFrames", "domainConfidence",
]);
assert.deepEqual(VEHICLE_SLU_OUTPUT_SCHEMA.properties.domain.enum, [...VEHICLE_SLU_DOMAINS]);
assert.equal(VEHICLE_SLU_OUTPUT_SCHEMA.properties.conversationGoal.additionalProperties, false);
assert.deepEqual(VEHICLE_SLU_OUTPUT_SCHEMA.properties.conversationGoal.required, ["summary", "need"]);
assert.deepEqual(VEHICLE_SLU_OUTPUT_SCHEMA.properties.conversationGoal.properties.need.enum, [...CONVERSATION_NEEDS]);
const frameSchema = VEHICLE_SLU_OUTPUT_SCHEMA.properties.vehicleFrames.items;
assert.equal(frameSchema.additionalProperties, false);
assert.deepEqual(frameSchema.required, [
  "frameId", "capability", "intent", "speechAct", "knowledgeNeed", "actionNeed", "slots",
  "missingSlots", "clarificationQuestion", "standaloneQuery", "confidence",
]);
assert.deepEqual(frameSchema.properties.capability.enum, [...VEHICLE_SLU_CAPABILITIES]);
assert.deepEqual(frameSchema.properties.intent.enum, expectedIntents);
assert.deepEqual(frameSchema.properties.speechAct.enum, [...SPEECH_ACTS]);
assert.deepEqual(frameSchema.properties.knowledgeNeed.enum, [...KNOWLEDGE_NEEDS]);
assert.deepEqual(frameSchema.properties.actionNeed.enum, [...ACTION_NEEDS]);
assert.deepEqual(
  [frameSchema.properties.confidence.minimum, frameSchema.properties.confidence.maximum],
  [0, 1],
);
assert.deepEqual(
  [VEHICLE_SLU_OUTPUT_SCHEMA.properties.domainConfidence.minimum,
    VEHICLE_SLU_OUTPUT_SCHEMA.properties.domainConfidence.maximum],
  [0, 1],
);
const slotsSchema = frameSchema.properties.slots;
assert.equal(slotsSchema.additionalProperties, false);
assert.deepEqual(Object.keys(slotsSchema.properties).sort(), [
  ...new Set(Object.values(VEHICLE_SLU_SLOT_SCHEMAS).flatMap(({ allowed }) => allowed)),
].sort());
assert.deepEqual(slotsSchema.properties.zone.enum, ["front_left", "front_right", "rear_left", "rear_right"]);
assert.deepEqual(
  [slotsSchema.properties.percent.type, slotsSchema.properties.percent.minimum, slotsSchema.properties.percent.maximum],
  ["number", 0, 100],
);
assert.equal(slotsSchema.properties.stateFields.type, "array");
assert.equal(slotsSchema.properties.stateFields.uniqueItems, true);
assert.equal(Object.isFrozen(VEHICLE_SLU_OUTPUT_SCHEMA), true);
assert.equal(Object.isFrozen(frameSchema), true);
assert.equal(Object.isFrozen(slotsSchema.properties), true);

function generalEnvelope(requestId) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId,
    domain: "non_vehicle",
    conversationGoal: { summary: "回应用户的开放式问题", need: "social" },
    vehicleFrames: [],
    domainConfidence: 0.91,
  };
}

let directGenerateBypassCalls = 0;
await assert.rejects(
  runVehicleSluSemanticBoundary({
    text: "验证 Vehicle-SLU 不接受直连 generate 旁路",
    requestId: "server-direct-generate-bypass-rejected",
    generate: async () => {
      directGenerateBypassCalls += 1;
      return {
        response: JSON.stringify(generalEnvelope("server-direct-generate-bypass-rejected")),
        _telemetry: {},
      };
    },
  }),
  (error) => error instanceof TypeError && /registry/i.test(error.message),
  "Vehicle-SLU must require an explicit task registry instead of accepting direct generate",
);
assert.equal(directGenerateBypassCalls, 0,
  "the rejected Vehicle-SLU direct path must not call the injected generator");

function vehicleEnvelope(requestId) {
  return {
    contractVersion: CONTRACT_VERSION,
    requestId,
    domain: "vehicle",
    conversationGoal: { summary: "打开主驾车窗到一半", need: "none" },
    vehicleFrames: [{
      frameId: "frame-window",
      capability: "control",
      intent: "body.window.setPosition",
      speechAct: "command",
      knowledgeNeed: "none",
      actionNeed: "execute",
      slots: { zone: "front_left", percent: 50 },
      missingSlots: [],
      clarificationQuestion: null,
      standaloneQuery: null,
      confidence: 0.98,
    }],
    domainConfidence: 0.99,
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

function endpointTelemetry({
  provider = PRIMARY_PROVIDER,
  model = PRIMARY_MODEL,
  degraded = false,
  watchdogMs = null,
  ollamaDurations = {},
} = {}) {
  return {
    provider,
    model,
    modelType: "vehicle-slu",
    contractVersion: CONTRACT_VERSION,
    promptVersion: VEHICLE_SLU_PROMPT_VERSION,
    promptChars: 800,
    durationMs: 12,
    semanticDecisionMs: 12,
    firstModelTokenMs: null,
    firstModelTokenStatus: "unobservable-non-streaming",
    slowStage: null,
    watchdogMs,
    ollamaDurations,
    degraded,
  };
}

function successResponse(semanticEnvelope) {
  return {
    model: PRIMARY_MODEL,
    semanticEnvelope,
    telemetry: endpointTelemetry(),
  };
}

function failureResponse(reasonCode = "semantic-model-unavailable") {
  return {
    model: PRIMARY_MODEL,
    semanticEnvelope: null,
    executionDisabled: true,
    reasonCode,
    telemetry: endpointTelemetry({ degraded: true }),
  };
}

function createAdapter(fetchImpl, watchdogMs = 50) {
  return new LocalModelAdapter({
    endpoint: "/api/local-semantic",
    fetchImpl,
    watchdogMs,
    model: "local-semantic-parser",
    providerProfile: PUBLIC_VEHICLE_SLU_PROFILE,
  });
}

const originalGlobalFetch = globalThis.fetch;
const lateBoundAdapter = new LocalModelAdapter({
  endpoint: "/api/local-semantic",
  watchdogMs: null,
  model: "local-semantic-parser",
  providerProfile: PUBLIC_VEHICLE_SLU_PROFILE,
});
let lateBoundFetchCalls = 0;
try {
  globalThis.fetch = async () => {
    lateBoundFetchCalls += 1;
    return jsonResponse(successResponse(generalEnvelope("adapter-late-bound-fetch")));
  };
  const lateBoundResult = await lateBoundAdapter.parse("你好", {
    requestId: "adapter-late-bound-fetch",
  });
  assert.equal(lateBoundResult.semanticEnvelope?.requestId, "adapter-late-bound-fetch");
  assert.equal(lateBoundFetchCalls, 1,
    "the default browser transport must observe a fetch wrapper installed after adapter construction");
} finally {
  globalThis.fetch = originalGlobalFetch;
}

function assertSinglePost(calls, { requestId, text, pending = null }) {
  assert.equal(calls.length, 1, `${requestId}: semantic parsing must issue exactly one request`);
  assert.equal(calls[0].url, "/api/local-semantic");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  const expectedBody = {
    model: "local-semantic-parser",
    requestId,
    task: "vehicle_semantic_parse",
    text,
    lastVehicleIntent: "",
  };
  if (pending) expectedBody.pending = pending;
  assert.deepEqual(JSON.parse(calls[0].options.body), expectedBody);
}

async function parseWithResponse({ requestId, text, body, status = 200 }) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(body, { status });
  };
  const result = await createAdapter(fetchImpl).parse(text, { requestId });
  assertSinglePost(calls, { requestId, text });
  return result;
}

const general = await parseWithResponse({
  requestId: "adapter-general",
  text: "你好，给我讲个笑话",
  body: successResponse(generalEnvelope("adapter-general")),
});
assert.equal(general.semanticEnvelope.domain, "non_vehicle");
assert.equal(general.command, undefined, "successful V2 adapter responses do not create a legacy command projection");
assert.equal(general.executionDisabled, false);
assert.equal(general.reasonCode, "");

const vehicle = await parseWithResponse({
  requestId: "adapter-vehicle",
  text: "把主驾车窗打开一半",
  body: successResponse(vehicleEnvelope("adapter-vehicle")),
});
assert.equal(vehicle.semanticEnvelope.domain, "vehicle");
assert.equal(vehicle.semanticEnvelope.vehicleFrames[0].actionNeed, "execute");
assert.equal(vehicle.command, undefined, "Vehicle-SLU 2.0 frame remains the sole semantic authority");
assert.equal(vehicle.executionDisabled, false);

const pendingSummary = {
  taskId: "pending:adapter-window",
  intent: "body.window.setPosition",
  missingSlots: ["percent"],
  acceptedSlots: ["zone"],
  clarificationQuestion: "主驾车窗要打开到多少？",
};
const pendingCalls = [];
const pendingAdapterResult = await createAdapter(async (url, options) => {
  pendingCalls.push({ url, options });
  return jsonResponse(successResponse(generalEnvelope("adapter-pending-summary")));
}).parse("50%", {
  requestId: "adapter-pending-summary",
  pending: {
    ...pendingSummary,
    acceptedSlots: { zone: "front_left" },
    slotProvenance: { zone: "original-turn-secret" },
    originalUtterance: "打开主驾车窗",
    sessionMemory: "主驾 50% 不得进入语义请求",
  },
});
assert.equal(pendingAdapterResult.semanticEnvelope.domain, "non_vehicle");
assertSinglePost(pendingCalls, {
  requestId: "adapter-pending-summary",
  text: "50%",
  // Contract-validated accepted values are forwarded; provenance, utterance and memory are not.
  pending: { ...pendingSummary, acceptedSlotValues: { zone: "front_left" } },
});
assert.doesNotMatch(pendingCalls[0].options.body, /original-turn-secret|打开主驾车窗|不得进入语义请求/);

const invalidShape = await parseWithResponse({
  requestId: "adapter-invalid-shape",
  text: "把主驾车窗打开一半",
  body: {
    model: "legacy-semantic-parser",
    parsedCommand: {
      intent: "body.window.setPosition",
      slots: { zone: "front_left", percent: 50 },
    },
    telemetry: { provider: "rules" },
  },
});
assert.equal(invalidShape.semanticEnvelope, null);
assert.equal(invalidShape.executionDisabled, true);
assert.equal(invalidShape.reasonCode, "semantic-contract-invalid");
assert.equal(invalidShape.command.intent, "conversation.general");
assert.deepEqual(invalidShape.command.slots, {});
assert.equal(invalidShape.command.actionability.actionable, false);
assert.equal(invalidShape.command.rawText, "");
const failClosedCommand = invalidShape.command;

const mismatchedEnvelope = vehicleEnvelope("adapter-contract-mismatch");
mismatchedEnvelope.vehicleFrames[0].missingSlots = ["percent"];
const contractMismatch = await parseWithResponse({
  requestId: "adapter-contract-mismatch",
  text: "解释一下这个功能",
  body: successResponse(mismatchedEnvelope),
});
assert.equal(contractMismatch.semanticEnvelope, null);
assert.equal(contractMismatch.executionDisabled, true);
assert.equal(contractMismatch.reasonCode, "semantic-contract-invalid");
assert.equal(contractMismatch.command.actionability.actionable, false);
assert.equal(contractMismatch.command, failClosedCommand);

const adversarialResponse = successResponse(generalEnvelope("adapter-telemetry-sanitized"));
adversarialResponse.telemetry.rawText = "secret user text";
adversarialResponse.telemetry.errorMessage = "secret provider error";
adversarialResponse.telemetry.ollamaDurations = {
  total_duration_ms: 12,
  load_duration_ms: -1,
  prompt_eval_duration_ms: 3,
  eval_duration_ms: Number.POSITIVE_INFINITY,
  prompt_eval_count: 4,
  eval_count: 5,
  rawText: "nested secret user text",
  errorMessage: "nested secret provider error",
  details: { rawText: "deep secret", errorMessage: "deep failure" },
};
const sanitizedTelemetry = await parseWithResponse({
  requestId: "adapter-telemetry-sanitized",
  text: "讲个笑话",
  body: adversarialResponse,
});
assert.deepEqual(sanitizedTelemetry.telemetry.ollamaDurations, {
  total_duration_ms: 12,
  prompt_eval_duration_ms: 3,
  prompt_eval_count: 4,
  eval_count: 5,
});
assert.doesNotMatch(JSON.stringify(sanitizedTelemetry.telemetry), /secret|errorMessage|rawText|details/);

const invalidSuccessMetadataCases = [
  ["provider-rules", (body) => { body.telemetry.provider = "rules"; }],
  ["model-type", (body) => { body.telemetry.modelType = "semantic-parser"; }],
  ["contract-version", (body) => { body.telemetry.contractVersion = "nio-vehicle-slu-contract@0.9.0"; }],
  ["prompt-version", (body) => { body.telemetry.promptVersion = "nio-vehicle-slu-prompt@0.9.0"; }],
  ["degraded", (body) => { body.telemetry.degraded = true; }],
  ["missing-telemetry", (body) => { delete body.telemetry; }],
  ["missing-root-model", (body) => { delete body.model; }],
  ["model-provenance", (body) => { body.telemetry.model = "other-model"; }],
  ["semantic-decision-duration", (body) => { body.telemetry.semanticDecisionMs += 1; }],
  ["fake-first-model-token", (body) => { body.telemetry.firstModelTokenMs = 4; }],
  ["first-model-token-status", (body) => { body.telemetry.firstModelTokenStatus = "observed"; }],
  ["slow-stage", (body) => { body.telemetry.slowStage = "semantic-decision"; }],
  ["forged-provider-model", (body) => {
    body.model = "forged-model";
    body.telemetry.model = "forged-model";
  }],
  ["fallback-active-type", (body) => { body.telemetry.fallbackActive = "true"; }],
  ["fallback-attempted-type", (body) => { body.telemetry.fallbackAttempted = 1; }],
  ["request-count-type", (body) => { body.telemetry.externalModelRequestCount = "1"; }],
  ["request-count-bound", (body) => { body.telemetry.externalModelRequestCount = 4; }],
  ["primary-reason-token", (body) => { body.telemetry.primaryFailureReasonCode = "bad reason"; }],
  ["provider-reason-token", (body) => { body.telemetry.providerFailureReasonCode = "bad reason"; }],
  ["fallback-provider-token", (body) => {
    body.telemetry.fallbackActive = true;
    body.telemetry.provider = "ollama<script>";
    body.model = "qwen3:8b";
    body.telemetry.model = body.model;
  }],
  ["fallback-model-token", (body) => {
    body.telemetry.fallbackActive = true;
    body.telemetry.provider = "ollama";
    body.model = "bad model";
    body.telemetry.model = body.model;
  }],
];
for (const [label, mutate] of invalidSuccessMetadataCases) {
  const requestId = `adapter-invalid-success-${label}`;
  const body = successResponse(generalEnvelope(requestId));
  mutate(body);
  const result = await parseWithResponse({ requestId, text: "讲个笑话", body });
  assert.equal(result.semanticEnvelope, null, `${label}: invalid success metadata must fail closed`);
  assert.equal(result.executionDisabled, true, `${label}: execution disabled`);
  assert.equal(result.reasonCode, "semantic-contract-invalid", `${label}: stable reason`);
  assert.equal(result.command, failClosedCommand, `${label}: constant compatibility command`);
  assert.equal(result.command.actionability.actionable, false, `${label}: nonactionable compatibility command`);
}

const unconfiguredFallbackBody = successResponse(generalEnvelope("adapter-unconfigured-fallback"));
unconfiguredFallbackBody.model = "qwen3:8b";
unconfiguredFallbackBody.telemetry.provider = "ollama";
unconfiguredFallbackBody.telemetry.model = unconfiguredFallbackBody.model;
unconfiguredFallbackBody.telemetry.fallbackActive = true;
unconfiguredFallbackBody.telemetry.primaryFailureReasonCode = "provider-network-error";
unconfiguredFallbackBody.telemetry.externalModelRequestCount = 2;
const unconfiguredFallback = await new LocalModelAdapter({
  endpoint: "/api/local-semantic",
  providerProfile: Object.freeze({
    ...PUBLIC_VEHICLE_SLU_PROFILE,
    fallbackConfigured: false,
  }),
  fetchImpl: async () => jsonResponse(unconfiguredFallbackBody),
}).parse("讲个笑话", { requestId: "adapter-unconfigured-fallback" });
assert.equal(unconfiguredFallback.semanticEnvelope, null);
assert.equal(unconfiguredFallback.executionDisabled, true);
assert.equal(unconfiguredFallback.reasonCode, "semantic-contract-invalid",
  "a fallback result must be rejected when the public profile does not configure fallback");

const endpointFailure = await parseWithResponse({
  requestId: "adapter-endpoint-failure-response",
  text: "讲个笑话",
  body: failureResponse("semantic-model-unavailable"),
});
assert.equal(endpointFailure.semanticEnvelope, null);
assert.equal(endpointFailure.executionDisabled, true);
assert.equal(endpointFailure.reasonCode, "semantic-model-unavailable");
assert.equal(endpointFailure.command, failClosedCommand);
assert.equal(endpointFailure.telemetry.provider, PRIMARY_PROVIDER);
assert.equal(endpointFailure.telemetry.degraded, true);

const auditableEndpointFailureBody = failureResponse("semantic-model-unavailable");
auditableEndpointFailureBody.telemetry.providerFailureReasonCode = "provider-safety-refusal";
auditableEndpointFailureBody.telemetry.externalModelRequestCount = 1;
const auditableEndpointFailure = await parseWithResponse({
  requestId: "adapter-auditable-endpoint-failure",
  text: "解析请求",
  body: auditableEndpointFailureBody,
});
assert.equal(auditableEndpointFailure.reasonCode, "semantic-model-unavailable");
assert.equal(
  auditableEndpointFailure.telemetry.providerFailureReasonCode,
  "provider-safety-refusal",
);
assert.equal(auditableEndpointFailure.telemetry.externalModelRequestCount, 1);

const invalidFailureMetadataCases = [
  ["provider-rules", (body) => { body.telemetry.provider = "rules"; }],
  ["model-type", (body) => { body.telemetry.modelType = "semantic-parser"; }],
  ["contract-version", (body) => { body.telemetry.contractVersion = "nio-vehicle-slu-contract@0.9.0"; }],
  ["prompt-version", (body) => { body.telemetry.promptVersion = "nio-vehicle-slu-prompt@0.9.0"; }],
  ["degraded", (body) => { body.telemetry.degraded = false; }],
  ["missing-telemetry", (body) => { delete body.telemetry; }],
  ["missing-root-model", (body) => { delete body.model; }],
  ["model-provenance", (body) => { body.telemetry.model = "other-model"; }],
];
for (const [label, mutate] of invalidFailureMetadataCases) {
  const requestId = `adapter-invalid-failure-${label}`;
  const body = failureResponse("semantic-model-unavailable");
  mutate(body);
  const result = await parseWithResponse({ requestId, text: "讲个笑话", body });
  assert.equal(result.semanticEnvelope, null, `${label}: invalid failure response remains fail closed`);
  assert.equal(result.executionDisabled, true, `${label}: execution disabled`);
  assert.equal(result.reasonCode, "semantic-contract-invalid", `${label}: invalid endpoint failure is a contract failure`);
  assert.equal(result.command, failClosedCommand, `${label}: constant compatibility command`);
  assert.equal(result.command.actionability.actionable, false, `${label}: nonactionable compatibility command`);
}

const httpFailure = await parseWithResponse({
  requestId: "adapter-http-failure",
  text: "解释一下这个功能",
  body: { error: "upstream unavailable" },
  status: 503,
});
assert.equal(httpFailure.semanticEnvelope, null);
assert.equal(httpFailure.executionDisabled, true);
assert.equal(httpFailure.reasonCode, "semantic-endpoint-unavailable");
assert.equal(httpFailure.command.actionability.actionable, false);
assert.equal(httpFailure.command, failClosedCommand);

const timeoutCalls = [];
const timeoutText = "请判断这个请求属于哪个能力";
const timeout = await createAdapter((url, options) => new Promise((_resolve, reject) => {
  timeoutCalls.push({ url, options });
  options.signal.addEventListener("abort", () => {
    const error = new Error("timed out");
    error.name = "AbortError";
    reject(error);
  }, { once: true });
}), 10).parse(timeoutText, { requestId: "adapter-timeout" });
assertSinglePost(timeoutCalls, { requestId: "adapter-timeout", text: timeoutText });
assert.equal(timeout.semanticEnvelope, null);
assert.equal(timeout.executionDisabled, true);
assert.equal(timeout.reasonCode, "semantic-endpoint-unavailable");
assert.equal(timeout.command.actionability.actionable, false);

const abortCalls = [];
const caller = new AbortController();
const abortText = "请判断这个请求属于哪个能力";
const pending = createAdapter((url, options) => new Promise((_resolve, reject) => {
  abortCalls.push({ url, options });
  options.signal.addEventListener("abort", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    error.reason = options.signal.reason;
    reject(error);
  }, { once: true });
})).parse(abortText, { requestId: "adapter-caller-abort", signal: caller.signal });
caller.abort("semantic-user-cancelled");
await assert.rejects(pending, (error) => {
  assert.equal(error?.name, "AbortError");
  assert.equal(error?.reason, "semantic-user-cancelled");
  return true;
});
assertSinglePost(abortCalls, { requestId: "adapter-caller-abort", text: abortText });

for (const [label, providerProfile] of [
  ["missing", undefined],
  ["blocked", {
    provider: null,
    model: null,
    mode: null,
    schemaVersion: null,
    fallbackConfigured: false,
    watchdogMs: null,
    readiness: { status: "blocked", reasonCode: "provider-profile-unavailable" },
  }],
]) {
  let fetchCalls = 0;
  const adapter = new LocalModelAdapter({
    endpoint: "/api/local-semantic",
    providerProfile,
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(successResponse(generalEnvelope(`adapter-profile-${label}`)));
    },
  });
  const result = await adapter.parse("讲个笑话", { requestId: `adapter-profile-${label}` });
  assert.equal(result.semanticEnvelope, null, `${label} profile must fail closed`);
  assert.equal(result.executionDisabled, true, `${label} profile disables execution`);
  assert.equal(result.reasonCode, "semantic-model-unavailable", `${label} profile reason`);
  assert.equal(fetchCalls, 0, `${label} profile must not call the semantic endpoint`);
}

function vehicleSluProviderResult(response, ollamaDurations = {}) {
  return {
    text: typeof response === "string" ? response : JSON.stringify(response),
    provider: PRIMARY_PROVIDER,
    model: PRIMARY_MODEL,
    durationMs: 99,
    providerTelemetry: {
      ollamaDurations,
      keepAlive: "24h",
    },
  };
}

function createVehicleSluTaskRegistry({
  generateForVehicleSlu,
  calls = [],
  watchdogMs = null,
} = {}) {
  const provider = Object.freeze({ id: PRIMARY_PROVIDER, model: PRIMARY_MODEL });
  const profile = Object.freeze({
    task: "vehicle_slu",
    provider: provider.id,
    model: provider.model,
    watchdogMs,
  });
  const requireVehicleSluTask = (task) => {
    assert.equal(task, "vehicle_slu", `test registry is missing explicit task ${task}`);
  };
  return Object.freeze({
    providerFor(task) {
      requireVehicleSluTask(task);
      return provider;
    },
    profileFor(task) {
      requireVehicleSluTask(task);
      return profile;
    },
    async generateForTask(task, request) {
      requireVehicleSluTask(task);
      calls.push({ task, request, profile });
      return generateForVehicleSlu(request);
    },
  });
}

async function runServerBoundaryCase({
  requestId,
  response,
  error,
  ollamaDurations,
  pending,
  watchdogMs,
}) {
  const calls = [];
  const ticks = [100, 112];
  let tickIndex = 0;
  const registry = createVehicleSluTaskRegistry({
    calls,
    watchdogMs: watchdogMs ?? null,
    generateForVehicleSlu: async () => {
      if (error) throw error;
      return vehicleSluProviderResult(response, ollamaDurations);
    },
  });
  const result = await runVehicleSluSemanticBoundary({
    text: "离线语义边界测试",
    requestId,
    pending,
    now: () => ticks[Math.min(tickIndex++, ticks.length - 1)],
    registry,
  });
  assert.equal(calls.length, 1, `${requestId}: server boundary must generate exactly once`);
  assert.equal(calls[0].task, "vehicle_slu");
  assert.equal(calls[0].profile.watchdogMs, watchdogMs ?? null);
  assert.equal(Object.hasOwn(calls[0].request, "model"), false);
  assert.equal(Object.hasOwn(calls[0].request, "timeoutMs"), false);
  assert.equal(Object.hasOwn(calls[0].request, "watchdogMs"), false);
  assert.equal(Object.hasOwn(calls[0].request, "options"), false);
  assert.equal(Object.hasOwn(calls[0].request, "think"), false);
  assert.equal(calls[0].request.outputMode, "json-object");
  assert.equal(calls[0].request.generationProfile, "structured-agent");
  assert.strictEqual(calls[0].request.jsonSchema, VEHICLE_SLU_OUTPUT_SCHEMA);
  assert.equal(calls[0].request.externalModelRequestLimit, 1);
  assert.equal(Object.hasOwn(calls[0].request, "structuredOutput"), false);
  assert.match(calls[0].request.prompt, new RegExp(`RequestId: ${requestId}`));
  return result;
}

function assertServerFailure(result, reasonCode, secret = "", watchdogMs = null) {
  assert.deepEqual(Object.keys(result).sort(), [
    "executionDisabled", "model", "reasonCode", "semanticEnvelope", "telemetry",
  ]);
  assert.equal(result.model, PRIMARY_MODEL);
  assert.equal(result.semanticEnvelope, null);
  assert.equal(result.executionDisabled, true);
  assert.equal(result.reasonCode, reasonCode);
  assert.equal(result.telemetry.provider, PRIMARY_PROVIDER);
  assert.equal(result.telemetry.model, result.model);
  assert.equal(result.telemetry.modelType, "vehicle-slu");
  assert.equal(result.telemetry.contractVersion, CONTRACT_VERSION);
  assert.equal(result.telemetry.promptVersion, VEHICLE_SLU_PROMPT_VERSION);
  assert.equal(result.telemetry.semanticDecisionMs, result.telemetry.durationMs);
  assert.equal(result.telemetry.firstModelTokenMs, null);
  assert.equal(result.telemetry.firstModelTokenStatus, "unobservable-non-streaming");
  assert.equal(
    result.telemetry.slowStage,
    result.telemetry.durationMs > 3_000 ? "semantic-decision" : null,
  );
  assert.equal(result.telemetry.watchdogMs, watchdogMs);
  assert.equal(Object.hasOwn(result.telemetry, "timeoutMs"), false);
  assert.equal(result.telemetry.degraded, true);
  assert.equal(Object.hasOwn(result, "parsedCommand"), false);
  assert.equal(Object.hasOwn(result, "semanticPolicy"), false);
  assert.equal(Object.hasOwn(result.telemetry, "semanticPolicy"), false);
  assert.notEqual(result.telemetry.provider, "rules");
  if (secret) assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
}

const serverSuccessDurations = {
  total_duration_ms: 20,
  load_duration_ms: 2,
  prompt_eval_duration_ms: 4,
  eval_duration_ms: 5,
  prompt_eval_count: 6,
  eval_count: 7,
  rawText: "server nested raw text",
  errorMessage: "server nested error detail",
  details: { rawText: "server deep raw text" },
};
const serverSuccess = await runServerBoundaryCase({
  requestId: "server-success",
  response: generalEnvelope("server-success"),
  ollamaDurations: serverSuccessDurations,
});
assert.deepEqual(Object.keys(serverSuccess).sort(), ["model", "semanticEnvelope", "telemetry"]);
assert.equal(serverSuccess.semanticEnvelope.domain, "non_vehicle");
assert.equal(serverSuccess.telemetry.durationMs, 12);
assert.equal(serverSuccess.telemetry.degraded, false);
assert.deepEqual(serverSuccess.telemetry.ollamaDurations, {
  total_duration_ms: 20,
  load_duration_ms: 2,
  prompt_eval_duration_ms: 4,
  eval_duration_ms: 5,
  prompt_eval_count: 6,
  eval_count: 7,
});
assert.doesNotMatch(JSON.stringify(serverSuccess), /server nested|errorMessage|rawText|details/);

let pendingServerPrompt = "";
await runVehicleSluSemanticBoundary({
  text: "50%",
  requestId: "server-pending-summary",
  pending: {
    ...pendingSummary,
    acceptedSlots: { zone: "front_left" },
    slotProvenance: { zone: "server-secret-provenance" },
    originalUtterance: "server-secret-original-utterance",
    sessionMemory: "server-secret-session-memory",
  },
  registry: createVehicleSluTaskRegistry({
    generateForVehicleSlu: async (request) => {
      pendingServerPrompt = request.prompt;
      return vehicleSluProviderResult(generalEnvelope("server-pending-summary"));
    },
  }),
});
assert.match(pendingServerPrompt, /"taskId":"pending:adapter-window"/);
assert.match(pendingServerPrompt, /"acceptedSlots":\["zone"\]/);
assert.doesNotMatch(pendingServerPrompt, /server-secret-provenance|server-secret-original-utterance|server-secret-session-memory/);

const invalidJson = await runServerBoundaryCase({
  requestId: "server-invalid-json",
  response: "not-json-server-invalid-json-secret",
});
assertServerFailure(invalidJson, "semantic-contract-invalid", "server-invalid-json-secret");

const invalidContractEnvelope = vehicleEnvelope("server-invalid-contract");
invalidContractEnvelope.vehicleFrames[0].missingSlots = ["percent"];
const invalidContract = await runServerBoundaryCase({
  requestId: "server-invalid-contract",
  response: invalidContractEnvelope,
});
assertServerFailure(invalidContract, "semantic-contract-invalid");

const invalidClarificationQuestion = vehicleEnvelope("server-invalid-clarification-question");
invalidClarificationQuestion.vehicleFrames[0] = {
  ...invalidClarificationQuestion.vehicleFrames[0],
  actionNeed: "clarify",
  slots: { zone: "front_left" },
  missingSlots: ["percent"],
  clarificationQuestion: "请补充需要执行的具体参数。",
};
const repairedClarification = await runServerBoundaryCase({
  requestId: "server-invalid-clarification-question",
  response: invalidClarificationQuestion,
});
assert.equal(repairedClarification.semanticEnvelope.vehicleFrames[0].actionNeed, "clarify");
assert.equal(
  repairedClarification.semanticEnvelope.vehicleFrames[0].clarificationQuestion,
  "请告诉我多少开度。",
  "an invalid model question is repaired to the deterministic contextual slot question",
);

const requestMismatch = await runServerBoundaryCase({
  requestId: "server-request-mismatch",
  response: generalEnvelope("server-other-request"),
});
assertServerFailure(requestMismatch, "semantic-contract-invalid");

const timeoutError = new Error("server-timeout-secret");
timeoutError.code = "generation-timeout";
timeoutError._telemetry = {
  ollamaDurations: {
    total_duration_ms: 3000,
    prompt_eval_count: 8,
    rawText: "server timeout raw text",
    errorMessage: "server timeout detail",
  },
};
const serverTimeout = await runServerBoundaryCase({
  requestId: "server-timeout",
  error: timeoutError,
  watchdogMs: 25,
});
assertServerFailure(serverTimeout, "semantic-model-unavailable", "server-timeout-secret", 25);
assert.equal(serverTimeout.telemetry.watchdogMs, 25);
assert.deepEqual(serverTimeout.telemetry.ollamaDurations, {
  total_duration_ms: 3000,
  prompt_eval_count: 8,
});

const unavailableError = new TypeError("server-unavailable-secret");
unavailableError.code = "generation-unavailable";
unavailableError._telemetry = { ollamaDurations: { eval_count: 1, details: { error: "secret" } } };
const serverUnavailable = await runServerBoundaryCase({
  requestId: "server-unavailable",
  error: unavailableError,
});
assertServerFailure(serverUnavailable, "semantic-model-unavailable", "server-unavailable-secret");
assert.deepEqual(serverUnavailable.telemetry.ollamaDurations, { eval_count: 1 });

const serverAbortCalls = [];
const serverCaller = new AbortController();
const serverAbortPending = runVehicleSluSemanticBoundary({
  text: "离线调用者取消",
  requestId: "server-caller-abort",
  signal: serverCaller.signal,
  registry: createVehicleSluTaskRegistry({
    generateForVehicleSlu: (request) => new Promise((_resolve, reject) => {
      serverAbortCalls.push(request);
      request.signal.addEventListener("abort", () => {
        const error = new Error("server caller abort detail");
        error.name = "AbortError";
        error.reason = request.signal.reason;
        reject(error);
      }, { once: true });
    }),
  }),
});
assert.equal(serverAbortCalls.length, 1);
assert.equal(Object.hasOwn(serverAbortCalls[0], "timeoutMs"), false);
serverCaller.abort("server-user-cancelled");
await assert.rejects(serverAbortPending, (error) => {
  assert.equal(error?.name, "AbortError");
  assert.equal(error?.reason, "server-user-cancelled");
  return true;
});
assert.equal(serverAbortCalls.length, 1);

const serverLateAbortCalls = [];
const serverLateCaller = new AbortController();
const serverLateAbortPending = runVehicleSluSemanticBoundary({
  text: "离线模型返回后的调用者取消",
  requestId: "server-late-caller-abort",
  signal: serverLateCaller.signal,
  registry: createVehicleSluTaskRegistry({
    generateForVehicleSlu: (request) => {
      serverLateAbortCalls.push(request);
      queueMicrotask(() => serverLateCaller.abort("server-late-user-cancelled"));
      return Promise.resolve(vehicleSluProviderResult(
        generalEnvelope("server-late-caller-abort"),
      ));
    },
  }),
});
await assert.rejects(serverLateAbortPending, (error) => {
  assert.equal(error?.name, "AbortError");
  assert.equal(error?.reason, "server-late-user-cancelled");
  return true;
});
assert.equal(serverLateAbortCalls.length, 1);
assert.equal(Object.hasOwn(serverLateAbortCalls[0], "timeoutMs"), false);

async function verifyProductionBoundaryBrowserIntegration() {
  const taskProfiles = resolveModelTaskProfiles({
    NIO_LLM_PROVIDER: "ollama",
    NIO_LLM_MODEL: "qwen3:8b",
    NIO_VEHICLE_SLU_PROFILE: "cloud-dashscope",
  });
  const connections = {
    dashscope: { readiness: { status: "ready" } },
    ollama: { readiness: { status: "ready" } },
  };
  const publicVehicleProfile = createPublicModelTaskProfileSet(
    taskProfiles,
    connections,
  ).tasks.vehicle_slu;
  assert.equal(Object.hasOwn(publicVehicleProfile, "fallback"), false);
  assert.equal(Object.hasOwn(publicVehicleProfile, "fallbackProfile"), false);
  assert.doesNotMatch(JSON.stringify(publicVehicleProfile), /qwen3\.5:9b/,
    "the browser public profile must not expose fallback identity");

  const runCase = async ({
    requestId,
    dashscopeGenerate,
    ollamaGenerate,
    ticks = [100, 112],
  }) => {
    let tick = 0;
    const factory = (provider, generate) => ({ profile }) => Object.freeze({
      id: provider,
      model: profile.model,
      async generate(request) {
        if (typeof generate !== "function") throw new Error(`unexpected ${provider} call`);
        return generate({ profile, request });
      },
    });
    const registry = createModelProviderRegistry({
      taskProfiles,
      connections,
      providerFactories: {
        dashscope: factory("dashscope", dashscopeGenerate),
        ollama: factory("ollama", ollamaGenerate),
      },
    });
    const serverResult = await runVehicleSluSemanticBoundary({
      text: "浏览器生产边界集成",
      requestId,
      registry,
      now: () => ticks[Math.min(tick++, ticks.length - 1)],
    });
    const adapter = new LocalModelAdapter({
      endpoint: "/api/local-semantic",
      providerProfile: publicVehicleProfile,
      watchdogMs: null,
      fetchImpl: async () => jsonResponse(serverResult),
    });
    return { serverResult, browserResult: await adapter.parse("浏览器生产边界集成", { requestId }) };
  };

  const primaryRequestId = "adapter-production-primary";
  const primary = await runCase({
    requestId: primaryRequestId,
    dashscopeGenerate: ({ profile }) => ({
      text: JSON.stringify(generalEnvelope(primaryRequestId)),
      provider: profile.provider,
      model: profile.model,
      durationMs: 12,
      externalModelRequestCount: 1,
    }),
  });
  assert.deepEqual(primary.browserResult.semanticEnvelope, primary.serverResult.semanticEnvelope,
    "browser must accept the migrated public primary provider/model");
  assert.equal(primary.browserResult.telemetry.provider, "dashscope");
  assert.equal(primary.browserResult.telemetry.model, "qwen3.5-flash");
  assert.equal(primary.browserResult.telemetry.fallbackActive, false);
  assert.equal(primary.browserResult.telemetry.externalModelRequestCount, 1);

  const fallbackRequestId = "adapter-production-fallback";
  const fallback = await runCase({
    requestId: fallbackRequestId,
    dashscopeGenerate: () => {
      throw new ModelProviderError("primary network failure", {
        code: "provider-network-error",
        provider: "dashscope",
        externalModelRequestCount: 1,
      });
    },
    ollamaGenerate: ({ profile }) => ({
      text: JSON.stringify(generalEnvelope(fallbackRequestId)),
      provider: profile.provider,
      model: profile.model,
      durationMs: 12,
      externalModelRequestCount: 1,
    }),
  });
  assert.deepEqual(fallback.browserResult.semanticEnvelope, fallback.serverResult.semanticEnvelope);
  assert.equal(fallback.browserResult.semanticEnvelope, null);
  assert.equal(fallback.browserResult.executionDisabled, true);
  assert.equal(fallback.browserResult.telemetry.provider, "dashscope");
  assert.equal(fallback.browserResult.telemetry.model, "qwen3.5-flash");
  assert.equal(Object.hasOwn(fallback.browserResult.telemetry, "fallbackActive"), false);
  assert.equal(fallback.browserResult.telemetry.providerFailureReasonCode, "provider-network-error");
  assert.equal(fallback.browserResult.telemetry.externalModelRequestCount, 1);

  const dualFailure = await runCase({
    requestId: "adapter-production-dual-failure",
    dashscopeGenerate: () => {
      throw new ModelProviderError("primary network failure", {
        code: "provider-network-error",
        provider: "dashscope",
        externalModelRequestCount: 1,
      });
    },
    ollamaGenerate: () => {
      throw new ModelProviderError("fallback unavailable", {
        code: "provider-unavailable",
        provider: "ollama",
        externalModelRequestCount: 1,
      });
    },
  });
  assert.equal(dualFailure.browserResult.semanticEnvelope, null);
  assert.equal(dualFailure.browserResult.reasonCode, "semantic-model-unavailable");
  assert.equal(dualFailure.browserResult.telemetry.provider, "dashscope");
  assert.equal(dualFailure.browserResult.telemetry.model, "qwen3.5-flash");
  assert.equal(Object.hasOwn(dualFailure.browserResult.telemetry, "fallbackAttempted"), false);
  assert.equal(dualFailure.browserResult.telemetry.providerFailureReasonCode, "provider-network-error");
  assert.equal(dualFailure.browserResult.telemetry.externalModelRequestCount, 1);

  const slowRequestId = "adapter-production-slow-null-watchdog";
  const slow = await runCase({
    requestId: slowRequestId,
    ticks: [100, 3_201],
    dashscopeGenerate: ({ profile }) => ({
      text: JSON.stringify(generalEnvelope(slowRequestId)),
      provider: profile.provider,
      model: profile.model,
      durationMs: 3_101,
      externalModelRequestCount: 1,
    }),
  });
  assert.deepEqual(slow.browserResult.semanticEnvelope, slow.serverResult.semanticEnvelope);
  assert.equal(slow.browserResult.executionDisabled, false);
  assert.equal(slow.browserResult.telemetry.watchdogMs, null);
  assert.equal(slow.browserResult.telemetry.semanticDecisionMs, 3_101);
  assert.equal(slow.browserResult.telemetry.slowStage, "semantic-decision");
}

await verifyProductionBoundaryBrowserIntegration();

console.log("Vehicle-SLU local adapter verification passed");
