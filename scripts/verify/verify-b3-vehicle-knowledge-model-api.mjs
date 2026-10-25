import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import Ajv from "ajv";
import {
  buildStructuredAgentJsonSchema,
  buildStructuredRepairPrompt,
  callStructuredAgentGenerate,
  createServer,
  createServerOwnedKnowledgeAnswerEnvelope,
  structuredShapeInstruction,
  getStructuredValidationDetail,
  resolveStructuredAgentTimeoutMs,
  runStructuredOutputProtocol,
  VEHICLE_KNOWLEDGE_STRUCTURED_TIMEOUT_MS,
} from "../../src/server/local-agent-server.mjs";
import {
  buildVehicleKnowledgePlanningPrompt,
  buildVehicleKnowledgeSynthesisPrompt,
  CloudLLMAdapter,
  VEHICLE_KNOWLEDGE_MODEL_PHASE_TIMEOUT_MS,
  VEHICLE_KNOWLEDGE_TRANSPORT_TIMEOUT_MS,
} from "../../src/runtime/cloud-llm-adapter.js";
import { getKnowledgeCapabilityCatalogProjection } from "../../src/agents/knowledge-capability-catalog.js";
import { OrchestratorController } from "../../src/agents/orchestrator-controller.js";
import { createKnowledgeDelegation } from "../../src/application/contracts/vehicle-knowledge.js";

const modelTimeoutMs = 90_000;

class FakeRouteRequest extends EventEmitter {
  constructor(body) {
    super();
    this.method = "POST";
    this.url = "/api/local-llm";
    this.body = JSON.stringify(body);
    this.headers = { "content-type": "application/json" };
    this.aborted = false;
    this.destroyed = false;
  }

  send() {
    this.emit("data", Buffer.from(this.body));
    this.emit("end");
  }
}

class FakeRouteResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  closed = false;
  headersSent = false;
  status = null;
  body = null;

  writeHead(status) {
    this.status = status;
    this.headersSent = true;
  }

  end(body = "") {
    this.body = body ? JSON.parse(body) : null;
    this.writableEnded = true;
  }
}

async function postToLocalServer(server, body) {
  const request = new FakeRouteRequest(body);
  const response = new FakeRouteResponse();
  const pending = server.listeners("request")[0](request, response);
  request.send();
  await pending;
  return response;
}

async function withinTimeout(stage, operation, timeoutMs = modelTimeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${stage} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

const delegation = createKnowledgeDelegation({
  delegationId: "delegation:protocol-run:knowledge",
  runId: "protocol-run",
  parentPlanId: "plan:protocol-run",
  parentStepId: "delegate-knowledge",
  knowledgeGoal: "解释 ES8 尾门开启条件",
  vehicleScope: "nio-es8-user-manual-2026",
  allowedCapabilities: ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
  allowVehicleStateRead: false,
  requireSafetyEligibilityExplanation: false,
  expectedAnswerContract: "KnowledgeAnswer",
  dependsOn: [],
});
const catalogProjection = getKnowledgeCapabilityCatalogProjection();

function createOnlineEligibilityFixture(uniqueId) {
  const suffix = String(uniqueId).replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  const runId = `online-b3-${suffix}`;
  const onlineDelegation = createKnowledgeDelegation({
    delegationId: `delegation:${runId}:knowledge`,
    runId,
    parentPlanId: `plan:${runId}`,
    parentStepId: `delegate-knowledge-${suffix}`,
    knowledgeGoal: "ES8 尾门现在是否满足开启条件",
    vehicleScope: "nio-es8-user-manual-2026",
    allowedCapabilities: [
      "knowledge.manual.retrieve",
      "knowledge.vehicle-state.read",
      "knowledge.safety.evaluate",
      "knowledge.answer.synthesize",
    ],
    allowVehicleStateRead: true,
    requireSafetyEligibilityExplanation: true,
    expectedAnswerContract: "KnowledgeAnswer",
    dependsOn: [],
  });
  return {
    delegation: onlineDelegation,
    planningBody: {
      task: "b3_vehicle_knowledge_planning",
      delegation: onlineDelegation,
      capabilityCatalog: catalogProjection,
    },
    executionFacts: {
      outcomeStatus: "completed",
      evidenceRefs: [{ id: `manual:tailgate:${suffix}` }],
      evidence: [{
        id: `manual:tailgate:${suffix}`,
        excerpt: `唯一冷启动证据 ${suffix}：开启尾门前必须确认开闭路径无障碍物。`,
      }],
      vehicleStateRefs: [{ snapshotId: `provider:${runId}`, scope: "tailgate" }],
      safetyAssessmentRef: {
        allowed: false,
        action: "require_confirmation",
        reason: "cold-request-fixture",
      },
    },
  };
}

const planningBody = {
  task: "b3_vehicle_knowledge_planning",
  delegation,
  capabilityCatalog: catalogProjection,
};
const subplan = {
  subplanId: "knowledge-plan:protocol-run",
  delegationId: delegation.delegationId,
  runId: delegation.runId,
  parentPlanId: delegation.parentPlanId,
  parentStepId: delegation.parentStepId,
  steps: [{
    stepId: "manual", capabilityId: "knowledge.manual.retrieve", dependsOn: [],
    input: { query: delegation.knowledgeGoal }, expectedOutput: "manual-evidence",
    accessMode: "read", status: "planned",
  }, {
    stepId: "answer", capabilityId: "knowledge.answer.synthesize", dependsOn: ["manual"],
    input: { facts: { summary: "基于已检索正文回答。", evidenceRefs: [] } },
    expectedOutput: "knowledge-answer", accessMode: "read", status: "planned",
  }],
  selectedCapabilities: ["knowledge.manual.retrieve", "knowledge.answer.synthesize"],
  planningSummary: "检索 ES8 手册证据。",
  model: "qwen3:8b",
  provider: "ollama",
  status: "planned",
};

const planningFallbackCalls = { primary: 0, fallback: 0 };
const planningFallbackRegistry = Object.freeze({
  providerFor(task) {
    assert.equal(task, "orchestrator_plan");
    return Object.freeze({ id: "dashscope", model: "qwen-plus" });
  },
  profileFor(task) {
    assert.equal(task, "orchestrator_plan");
    return Object.freeze({
      task,
      provider: "dashscope",
      model: "qwen-plus",
      watchdogMs: null,
      fallback: { provider: "ollama", model: "qwen3:8b" },
    });
  },
  async generateForTask(task, request) {
    assert.equal(task, "orchestrator_plan");
    assert.equal(request.task, "b3_vehicle_knowledge_planning");
    planningFallbackCalls.primary += 1;
    return {
      text: "{}",
      provider: "dashscope",
      model: "qwen-plus",
      durationMs: 3,
      externalModelRequestCount: 1,
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, cachedInputTokens: null },
    };
  },
  async generateFallbackForTask(task, request) {
    assert.equal(task, "orchestrator_plan");
    assert.equal(request.task, "b3_vehicle_knowledge_planning");
    planningFallbackCalls.fallback += 1;
    return {
      text: JSON.stringify(subplan),
      provider: "ollama",
      model: "qwen3:8b",
      durationMs: 5,
      externalModelRequestCount: 1,
      fallbackActive: true,
      primaryFailureReasonCode: "provider-response-invalid",
      usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9, cachedInputTokens: null },
    };
  },
});
const planningFallbackResponse = await postToLocalServer(
  createServer({ modelProviderRegistry: planningFallbackRegistry }),
  planningBody,
);
assert.equal(planningFallbackResponse.status, 200);
assert.equal(planningFallbackResponse.body.telemetry.provider, "ollama");
assert.equal(planningFallbackResponse.body.telemetry.model, "qwen3:8b");
assert.equal(planningFallbackResponse.body.telemetry.fallbackActive, true);
assert.equal(planningFallbackResponse.body.telemetry.degraded, true);
assert.ok(planningFallbackResponse.body.telemetry.primaryStructuredValidationReason);
assert.deepEqual(planningFallbackCalls, { primary: 2, fallback: 1 });
assert.equal(planningFallbackResponse.body.telemetry.externalModelRequestCount, 3,
  "cloud generation, one repair, and local fallback use at most three model requests");
assert.equal(planningFallbackResponse.body.output.delegationId, delegation.delegationId);

assert.equal(resolveStructuredAgentTimeoutMs(undefined), 90_000);
assert.equal(VEHICLE_KNOWLEDGE_STRUCTURED_TIMEOUT_MS, 90_000);
assert.equal(VEHICLE_KNOWLEDGE_MODEL_PHASE_TIMEOUT_MS, 90_000);
assert.equal(VEHICLE_KNOWLEDGE_TRANSPORT_TIMEOUT_MS, 95_000);
assert.equal(modelTimeoutMs, 90_000);
const uniqueOnlineFixtureA = createOnlineEligibilityFixture("cold-a");
const uniqueOnlineFixtureB = createOnlineEligibilityFixture("cold-b");
assert.notEqual(uniqueOnlineFixtureA.delegation.runId, uniqueOnlineFixtureB.delegation.runId);
assert.notEqual(uniqueOnlineFixtureA.delegation.delegationId, uniqueOnlineFixtureB.delegation.delegationId);
assert.equal(
  buildStructuredAgentJsonSchema(uniqueOnlineFixtureA.planningBody)
    .oneOf[0].properties.runId.const,
  uniqueOnlineFixtureA.delegation.runId,
);
const planningSchema = buildStructuredAgentJsonSchema(planningBody);
assert.equal(planningSchema.oneOf.every((schema) => schema.additionalProperties === false), true);
const planningSubplanSchema = planningSchema.oneOf.find((schema) => schema.properties?.steps);
assert.equal(planningSubplanSchema.properties.steps.items.oneOf.some(
  (schema) => schema.properties.accessMode.const === "write",
), false);
assert.equal(planningSubplanSchema.properties.delegationId.const, delegation.delegationId);
assert.equal(planningSchema.oneOf.some((schema) => schema.properties?.outcomeStatus?.const === "clarification"), true);
const eligibilityDelegation = createKnowledgeDelegation({
  ...delegation,
  knowledgeGoal: "ES8 尾门现在是否满足开启条件",
  allowedCapabilities: [
    "knowledge.manual.retrieve",
    "knowledge.vehicle-state.read",
    "knowledge.safety.evaluate",
    "knowledge.answer.synthesize",
  ],
  allowVehicleStateRead: true,
  requireSafetyEligibilityExplanation: true,
});
const safetyPlanningBody = {
  ...planningBody,
  delegation: eligibilityDelegation,
};
const safetyPlanningSchema = buildStructuredAgentJsonSchema(safetyPlanningBody);
const eligibilityStepsSchema = safetyPlanningSchema.oneOf[0].properties.steps;
assert.equal(Array.isArray(eligibilityStepsSchema.items), true, "draft-07 tuple schema is required");
assert.equal(eligibilityStepsSchema.additionalItems, false);
const eligibilityItemSchemas = eligibilityStepsSchema.items;
const safetyStepSchema = eligibilityItemSchemas.find(
  (schema) => schema.properties.capabilityId.const === "knowledge.safety.evaluate",
);
assert.equal(eligibilityStepsSchema.minItems, 4);
assert.equal(eligibilityStepsSchema.maxItems, 4);
assert.deepEqual(
  safetyPlanningSchema.oneOf[0].properties.selectedCapabilities.const,
  [
    "knowledge.manual.retrieve",
    "knowledge.vehicle-state.read",
    "knowledge.safety.evaluate",
    "knowledge.answer.synthesize",
  ],
);
const validateEligibilitySchema = new Ajv({ allErrors: true, strict: false })
  .compile(safetyPlanningSchema);
assert.deepEqual(
  Object.fromEntries(eligibilityItemSchemas.map((schema) => [
    schema.properties.capabilityId.const,
    {
      stepId: schema.properties.stepId.const,
      dependsOn: schema.properties.dependsOn.const,
    },
  ])),
  {
    "knowledge.manual.retrieve": { stepId: "manual", dependsOn: [] },
    "knowledge.vehicle-state.read": { stepId: "vehicle-state", dependsOn: ["manual"] },
    "knowledge.safety.evaluate": { stepId: "safety", dependsOn: ["vehicle-state"] },
    "knowledge.answer.synthesize": { stepId: "answer", dependsOn: ["manual", "safety"] },
  },
);
assert.equal(
  eligibilityItemSchemas[0].properties.input.properties.query.const,
  "ES8 尾门 开启 安全",
);
assert.equal(
  eligibilityItemSchemas[1].properties.input.properties.scope.const,
  "tailgate",
);
const eligibilitySubplan = {
  ...subplan,
  delegationId: eligibilityDelegation.delegationId,
  runId: eligibilityDelegation.runId,
  parentPlanId: eligibilityDelegation.parentPlanId,
  parentStepId: eligibilityDelegation.parentStepId,
  steps: [
    {
      stepId: "manual",
      capabilityId: "knowledge.manual.retrieve",
      dependsOn: [],
      input: { query: "ES8 尾门 开启 安全" },
      expectedOutput: "manual-evidence",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "vehicle-state",
      capabilityId: "knowledge.vehicle-state.read",
      dependsOn: ["manual"],
      input: { scope: "tailgate" },
      expectedOutput: "vehicle-state",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "safety",
      capabilityId: "knowledge.safety.evaluate",
      dependsOn: ["vehicle-state"],
      input: { action: "body.tailgate.open" },
      expectedOutput: "safety-assessment",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "answer",
      capabilityId: "knowledge.answer.synthesize",
      dependsOn: ["manual", "safety"],
      input: { facts: { summary: "ES8 尾门当前开启资格", evidenceRefs: ["manual", "state", "safety"] } },
      expectedOutput: "knowledge-answer",
      accessMode: "read",
      status: "planned",
    },
  ],
  selectedCapabilities: [
    "knowledge.manual.retrieve",
    "knowledge.vehicle-state.read",
    "knowledge.safety.evaluate",
    "knowledge.answer.synthesize",
  ],
};
assert.equal(validateEligibilitySchema(eligibilitySubplan), true, JSON.stringify(validateEligibilitySchema.errors));
const repeatedManualSchemaPlan = structuredClone(eligibilitySubplan);
repeatedManualSchemaPlan.steps = Array.from({ length: 4 }, () => structuredClone(eligibilitySubplan.steps[0]));
assert.equal(validateEligibilitySchema(repeatedManualSchemaPlan), false);
const reorderedEligibilitySchemaPlan = structuredClone(eligibilitySubplan);
[reorderedEligibilitySchemaPlan.steps[0], reorderedEligibilitySchemaPlan.steps[1]] = [
  reorderedEligibilitySchemaPlan.steps[1],
  reorderedEligibilitySchemaPlan.steps[0],
];
assert.equal(validateEligibilitySchema(reorderedEligibilitySchemaPlan), false);
const legacyStateIdSchemaPlan = structuredClone(eligibilitySubplan);
legacyStateIdSchemaPlan.steps[1].stepId = "state";
legacyStateIdSchemaPlan.steps[2].dependsOn = ["state"];
assert.equal(validateEligibilitySchema(legacyStateIdSchemaPlan), false);
const rawGoalQuerySchemaPlan = structuredClone(eligibilitySubplan);
rawGoalQuerySchemaPlan.steps[0].input.query = eligibilityDelegation.knowledgeGoal;
assert.equal(validateEligibilitySchema(rawGoalQuerySchemaPlan), false);
const wrongProviderScopeSchemaPlan = structuredClone(eligibilitySubplan);
wrongProviderScopeSchemaPlan.steps[1].input.scope = "nio-es8-user-manual-2026";
assert.equal(validateEligibilitySchema(wrongProviderScopeSchemaPlan), false);
assert.equal(safetyStepSchema?.properties.input.properties.action.const, "body.tailgate.open");
assert.equal(
  safetyPlanningSchema.oneOf.some((schema) => schema.properties?.outcomeStatus?.const === "clarification"),
  false,
  "an explicit ES8 tailgate eligibility delegation must not offer clarification",
);
assert.equal(
  getStructuredValidationDetail(safetyPlanningBody, {
    delegationId: eligibilityDelegation.delegationId,
    runId: eligibilityDelegation.runId,
    outcomeStatus: "clarification",
    questions: ["请说明要了解什么。"],
    reasonCode: "ambiguous_context",
    model: "qwen2.5:7b",
    provider: "ollama",
  }).validationSubreason,
  "clarification-not-allowed",
);
assert.equal(getStructuredValidationDetail(planningBody, subplan).reasonCode, "");
assert.equal(getStructuredValidationDetail(planningBody, {
  ...subplan,
  runId: "forged-run",
}).validationSubreason, "association-invalid");
const offScopePlanningBody = {
  ...planningBody,
  delegation: { ...delegation, vehicleScope: "nio-et5-user-manual-2026" },
};
assert.deepEqual(
  getStructuredValidationDetail(offScopePlanningBody, {
    ...subplan,
    delegationId: offScopePlanningBody.delegation.delegationId,
    runId: offScopePlanningBody.delegation.runId,
    parentPlanId: offScopePlanningBody.delegation.parentPlanId,
    parentStepId: offScopePlanningBody.delegation.parentStepId,
  }),
  { reasonCode: "knowledge-subplan-invalid", validationSubreason: "vehicle-scope-not-applicable" },
  "off-scope planning must fail closed before an ES8 subplan is accepted",
);

const planningPrompt = buildVehicleKnowledgePlanningPrompt({ delegation, catalogProjection });
for (const rule of [
  /Use only the supplied read-only knowledge catalog/i,
  /Never create Vehicle ToolCall or write capability/i,
  /Safety eligibility requires Provider read/i,
  /Unsupported evidence must produce an unsupported answer path/i,
  /Preserve delegationId, runId, parentPlanId, and parentStepId exactly/i,
]) assert.match(planningPrompt, rule);
assert.match(
  planningPrompt,
  /Exact KnowledgeSubplan root fields: subplanId, delegationId, runId, parentPlanId, parentStepId, steps, selectedCapabilities, planningSummary, model, provider, status\./,
  "knowledge planning prompt must enumerate every subplan root field",
);
assert.match(
  planningPrompt,
  /Exact knowledge step fields: stepId, capabilityId, dependsOn, input, expectedOutput, accessMode, status\./,
  "knowledge planning prompt must enumerate every step field",
);
assert.match(
  planningPrompt,
  /Exact KnowledgeClarificationRequest root fields: delegationId, runId, outcomeStatus, questions, reasonCode, model, provider\./,
  "clarification-eligible planning prompt must enumerate every clarification field",
);
const subplanExamplePrefix = "Canonical KnowledgeSubplan JSON example for this delegation and catalog: ";
const subplanExampleLine = planningPrompt
  .split("\n")
  .find((line) => line.startsWith(subplanExamplePrefix));
assert.ok(subplanExampleLine, "knowledge planning prompt must include a bound subplan example");
const planningPromptExample = JSON.parse(subplanExampleLine.slice(subplanExamplePrefix.length));
assert.deepEqual(
  getStructuredValidationDetail(planningBody, planningPromptExample),
  { reasonCode: "", validationSubreason: "" },
  "knowledge subplan example must satisfy the server-owned delegation contract",
);
const clarificationExamplePrefix = "Canonical KnowledgeClarificationRequest JSON example for this delegation: ";
const clarificationExampleLine = planningPrompt
  .split("\n")
  .find((line) => line.startsWith(clarificationExamplePrefix));
assert.ok(clarificationExampleLine, "clarification-eligible prompt must include a bound clarification example");
const clarificationPromptExample = JSON.parse(
  clarificationExampleLine.slice(clarificationExamplePrefix.length),
);
assert.deepEqual(
  getStructuredValidationDetail(planningBody, clarificationPromptExample),
  { reasonCode: "", validationSubreason: "" },
  "knowledge clarification example must satisfy the server-owned delegation contract",
);
assert.equal(JSON.stringify(planningPrompt).includes("handler"), false);
assert.match(structuredShapeInstruction(planningBody), /KnowledgePlanningResult/);
assert.match(structuredShapeInstruction(planningBody), /KnowledgeClarificationRequest/);
const eligibilityPlanningPrompt = buildVehicleKnowledgePlanningPrompt({
  delegation: eligibilityDelegation,
  catalogProjection,
});
assert.match(eligibilityPlanningPrompt, /must not ask for clarification/i);
assert.match(eligibilityPlanningPrompt, /manual.*Provider.*Safety.*synthesis/i);
assert.match(eligibilityPlanningPrompt, /manual → vehicle-state → safety → answer/);
assert.match(eligibilityPlanningPrompt, /exactly once/i);
const eligibilitySubplanExampleLine = eligibilityPlanningPrompt
  .split("\n")
  .find((line) => line.startsWith(subplanExamplePrefix));
assert.ok(eligibilitySubplanExampleLine);
assert.deepEqual(
  getStructuredValidationDetail(
    safetyPlanningBody,
    JSON.parse(eligibilitySubplanExampleLine.slice(subplanExamplePrefix.length)),
  ),
  { reasonCode: "", validationSubreason: "" },
  "fixed eligibility prompt must include the exact authorized four-step example",
);
assert.doesNotMatch(eligibilityPlanningPrompt, /KnowledgeClarificationRequest/);
assert.doesNotMatch(
  structuredShapeInstruction(safetyPlanningBody),
  /KnowledgeClarificationRequest/,
);

const synthesisBody = {
  task: "b3_vehicle_knowledge_synthesis",
  delegation,
  subplan,
  executionFacts: {
    outcomeStatus: "completed",
    reasonCode: "PROMPT_OUTCOME_CODE_UNIQUE",
    evidenceRefs: [{
      sourceId: "PROMPT_SOURCE_SENTINEL",
      sourceVersion: "PROMPT_VERSION_SENTINEL",
      chunkId: "PROMPT_CHUNK_SENTINEL",
      pageStart: 87651,
      pageEnd: 87652,
      excerpt: "PROMPT_EXCERPT_SENTINEL",
      score: { retrieval: 0.876543, rerank: null, grounding: null },
    }],
    evidence: [{ excerpt: "LEGACY_EVIDENCE_MUST_NOT_ENTER_PROMPT" }],
    vehicleStateRefs: [{ snapshotId: "PROMPT_VEHICLE_SNAPSHOT_SENTINEL", scope: "tailgate" }],
    safetyAssessmentRef: {
      requestId: "PROMPT_SAFETY_REQUEST_SENTINEL",
      allowed: false,
      action: "reject",
      reason: "PROMPT_SAFETY_REASON_SENTINEL",
      reasonCode: "PROMPT_SAFETY_CODE_SENTINEL",
      vehicleStateSnapshotId: "PROMPT_SAFETY_SNAPSHOT_SENTINEL",
      policyId: "PROMPT_POLICY_SENTINEL",
      manualEvidenceStatus: "hit",
    },
    degraded: false,
    manualRetrievalDurationMs: 777_777,
  },
};
const synthesisSchema = buildStructuredAgentJsonSchema(synthesisBody);
assert.equal(synthesisSchema.type, "object");
assert.equal(synthesisSchema.additionalProperties, false);
assert.deepEqual(synthesisSchema.required, [
  "outcomeStatus", "supportStatus", "answer", "limitations", "degraded",
]);
assert.deepEqual(Object.keys(synthesisSchema.properties), synthesisSchema.required);
assert.equal(synthesisSchema.properties.outcomeStatus.const, "answered");
for (const serverOwnedField of [
  "delegationId", "runId", "evidenceRefs", "vehicleStateRefs", "safetyAssessmentRef",
  "model", "provider", "durationMs",
]) {
  assert.equal(Object.hasOwn(synthesisSchema.properties, serverOwnedField), false,
    `${serverOwnedField} must not be model-owned`);
}
assert.match(buildVehicleKnowledgeSynthesisPrompt(synthesisBody), /ExecutionFacts/);
const providerRequests = [];
const fakeProvider = {
  id: "fake-provider",
  model: "fake-model",
};
const fakeRegistry = {
  providerFor() {
    return fakeProvider;
  },
  async generateForTask(modelTask, request) {
    providerRequests.push({ modelTask, ...request });
    return {
      text: "{}",
      provider: "fake-provider",
      model: "fake-model",
      durationMs: 1,
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: null },
    };
  },
};
await callStructuredAgentGenerate({
  body: { ...planningBody, provider: "untrusted", model: "untrusted", timeoutMs: 1 },
  prompt: "trusted-planning-prompt",
  registry: fakeRegistry,
});
await callStructuredAgentGenerate({
  body: { ...synthesisBody, provider: "untrusted", model: "untrusted", timeoutMs: 1 },
  prompt: "trusted-synthesis-prompt",
  registry: fakeRegistry,
});
assert.deepEqual(
  providerRequests.map(({ modelTask, task, generationProfile }) => ({ modelTask, task, generationProfile })),
  [
    {
      modelTask: "orchestrator_plan",
      task: "b3_vehicle_knowledge_planning",
      generationProfile: "structured-agent",
    },
    {
      modelTask: "knowledge_answer",
      task: "b3_vehicle_knowledge_synthesis",
      generationProfile: "structured-agent",
    },
  ],
  "B3 Provider requests must use the task registry and structured generation profile",
);
assert.deepEqual(providerRequests[0].jsonSchema, planningSchema);
assert.deepEqual(providerRequests[1].jsonSchema, synthesisSchema);
const completedSynthesisBody = synthesisBody;
const completedSynthesisSchema = buildStructuredAgentJsonSchema(completedSynthesisBody);
assert.deepEqual(completedSynthesisSchema, synthesisSchema);
const completedSynthesisPrompt = buildVehicleKnowledgeSynthesisPrompt(completedSynthesisBody);
assert.match(
  completedSynthesisPrompt,
  /Return exactly one answered JSON object/i,
  "completed synthesis prompt must require only the answered branch",
);
assert.match(
  completedSynthesisPrompt,
  /Exact draft root fields: outcomeStatus, supportStatus, answer, limitations, degraded\./,
  "completed synthesis prompt must enumerate only model-owned answer semantics",
);
assert.doesNotMatch(
  completedSynthesisPrompt,
  /KnowledgeClarificationRequest|KnowledgeTerminalResult/,
  "completed synthesis prompt must not advertise schema-forbidden outcome families",
);
assert.doesNotMatch(completedSynthesisPrompt, /Canonical answered JSON example bound to ExecutionFacts/);
assert.doesNotMatch(completedSynthesisPrompt, /LEGACY_EVIDENCE_MUST_NOT_ENTER_PROMPT/);
assert.doesNotMatch(completedSynthesisPrompt, /manualRetrievalDurationMs|777777/);
assert.doesNotMatch(completedSynthesisPrompt, new RegExp(delegation.delegationId));
assert.doesNotMatch(completedSynthesisPrompt, new RegExp(delegation.runId));
for (const sentinel of [
  "PROMPT_OUTCOME_CODE_UNIQUE",
  "PROMPT_SOURCE_SENTINEL",
  "PROMPT_VERSION_SENTINEL",
  "PROMPT_CHUNK_SENTINEL",
  "PROMPT_EXCERPT_SENTINEL",
  "PROMPT_VEHICLE_SNAPSHOT_SENTINEL",
  "PROMPT_SAFETY_REQUEST_SENTINEL",
  "PROMPT_SAFETY_REASON_SENTINEL",
  "PROMPT_SAFETY_CODE_SENTINEL",
  "PROMPT_SAFETY_SNAPSHOT_SENTINEL",
  "PROMPT_POLICY_SENTINEL",
]) {
  assert.equal(completedSynthesisPrompt.split(sentinel).length - 1, 1,
    `${sentinel} must be serialized exactly once in its authoritative prompt block`);
}
for (const serializedFact of [
  '"pageStart":87651',
  '"pageEnd":87652',
  '"retrieval":0.876543',
]) {
  assert.equal(completedSynthesisPrompt.split(serializedFact).length - 1, 1,
    `${serializedFact} must be serialized exactly once`);
}
for (const rule of [
  /Manual claims must be derived only from bounded evidenceRefs\[\]\.excerpt/i,
  /SafetyAssessmentRef is authoritative/i,
  /Never create Vehicle ToolCall, a write capability, raw prompt\/model response, or chain of thought/i,
]) assert.match(completedSynthesisPrompt, rule);
assert.doesNotMatch(
  completedSynthesisPrompt,
  /copy evidenceRefs|preserve delegationId|"provider"|durationMs/i,
);
assert.ok(
  completedSynthesisPrompt.length < 2_000,
  `compacted prompt length=${completedSynthesisPrompt.length}; legacy fixture length=2826`,
);
const synthesisPromptPrivateSentinel = "STEP_RESULT_MUST_NOT_ENTER_SYNTHESIS_PROMPT";
const boundedSynthesisPrompt = buildVehicleKnowledgeSynthesisPrompt({
  ...completedSynthesisBody,
  executionFacts: {
    ...completedSynthesisBody.executionFacts,
    evidence: [{
      id: "manual:tailgate",
      source: "nio-es8-user-manual-2026",
      title: "尾门",
      citation: "ES8 用户手册",
      excerpt: "打开尾门前请确认周边环境。",
    }],
    stepResults: { privateDiagnostic: synthesisPromptPrivateSentinel },
  },
  subplan: { ...completedSynthesisBody.subplan, privateDiagnostic: synthesisPromptPrivateSentinel },
});
assert.doesNotMatch(boundedSynthesisPrompt, /打开尾门前请确认周边环境/);
assert.doesNotMatch(
  boundedSynthesisPrompt,
  new RegExp(synthesisPromptPrivateSentinel),
  "synthesis prompt must omit subplan and execution diagnostics that add no answer facts",
);
const validDraft = {
  outcomeStatus: "answered",
  supportStatus: "supported",
  answer: "根据手册证据，开启尾门前需要确认周边安全条件。",
  limitations: [],
  degraded: false,
};
assert.deepEqual(
  getStructuredValidationDetail(completedSynthesisBody, validDraft),
  { reasonCode: "", validationSubreason: "" },
  "semantic-only knowledge answer draft must pass",
);
for (const serverOwnedField of [
  "delegationId", "runId", "evidenceRefs", "vehicleStateRefs", "safetyAssessmentRef",
  "model", "provider", "durationMs",
]) {
  assert.deepEqual(
    getStructuredValidationDetail(completedSynthesisBody, {
      ...validDraft,
      [serverOwnedField]: serverOwnedField.endsWith("Refs") ? [] : "MODEL_CLAIM",
    }),
    { reasonCode: "knowledge-result-invalid", validationSubreason: "server-owned-field" },
    `${serverOwnedField} must be rejected instead of overwritten`,
  );
}
const authoritativeEnvelope = createServerOwnedKnowledgeAnswerEnvelope({
  body: completedSynthesisBody,
  draft: validDraft,
  telemetry: {
    provider: "ACTUAL_PROVIDER",
    model: "ACTUAL_MODEL",
    durationMs: 4321,
    fallbackActive: true,
  },
});
assert.deepEqual(authoritativeEnvelope.evidenceRefs, completedSynthesisBody.executionFacts.evidenceRefs);
assert.deepEqual(authoritativeEnvelope.vehicleStateRefs, completedSynthesisBody.executionFacts.vehicleStateRefs);
assert.deepEqual(authoritativeEnvelope.safetyAssessmentRef, completedSynthesisBody.executionFacts.safetyAssessmentRef);
assert.equal(authoritativeEnvelope.delegationId, delegation.delegationId);
assert.equal(authoritativeEnvelope.runId, delegation.runId);
assert.equal(authoritativeEnvelope.provider, "ACTUAL_PROVIDER");
assert.equal(authoritativeEnvelope.model, "ACTUAL_MODEL");
assert.equal(authoritativeEnvelope.durationMs, 4321);
assert.equal(authoritativeEnvelope.degraded, true, "server-observed fallback degradation is monotonic");
assert.throws(
  () => createServerOwnedKnowledgeAnswerEnvelope({
    body: { ...completedSynthesisBody, delegation: offScopePlanningBody.delegation },
    draft: validDraft,
    telemetry: { provider: "ACTUAL_PROVIDER", model: "ACTUAL_MODEL", durationMs: 1 },
  }),
  /completed ES8/i,
);

let repairCalls = 0;
let synthesisRepairCalls = 0;
const boundedSynthesisAttempt = await runStructuredOutputProtocol({
  body: completedSynthesisBody,
  initialResponse: "{\"injected\":true}",
  repair: async () => {
    synthesisRepairCalls += 1;
    throw new Error("vehicle knowledge synthesis must not issue a second model request");
  },
});
assert.equal(boundedSynthesisAttempt.status, 422);
assert.equal(boundedSynthesisAttempt.structuredRetryCount, 0);
assert.equal(synthesisRepairCalls, 0);

const repaired = await runStructuredOutputProtocol({
  body: planningBody,
  initialResponse: "{\"injected\":true}",
  repair: async (metadata) => {
    repairCalls += 1;
    assert.deepEqual(Object.keys(metadata).sort(), [
      "invalidOutputLength", "schemaName", "validationSubreason",
    ]);
    assert.equal(JSON.stringify(metadata).includes("injected"), false);
    return JSON.stringify(subplan);
  },
});
assert.equal(repaired.status, 200);
assert.equal(repaired.structuredRetryCount, 1);
assert.equal(repairCalls, 1);
const repairedEligibility = await runStructuredOutputProtocol({
  body: safetyPlanningBody,
  initialResponse: JSON.stringify({
    delegationId: eligibilityDelegation.delegationId,
    runId: eligibilityDelegation.runId,
    outcomeStatus: "clarification",
    questions: ["请补充上下文。"],
    reasonCode: "ambiguous_context",
    model: "qwen2.5:7b",
    provider: "ollama",
  }),
  repair: async ({ validationSubreason }) => {
    assert.equal(validationSubreason, "clarification-not-allowed");
    return JSON.stringify(eligibilitySubplan);
  },
});
assert.equal(repairedEligibility.status, 200);
assert.equal(repairedEligibility.structuredRetryCount, 1);
assert.equal(repairedEligibility.output.steps.length, 4);

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const transportTimeouts = [];
try {
  globalThis.setTimeout = (_callback, timeoutMs) => {
    transportTimeouts.push(timeoutMs);
    return { timeoutMs };
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async () => new Response(JSON.stringify({
    output: eligibilitySubplan,
    telemetry: {},
  }), { status: 200, headers: { "content-type": "application/json" } });
  const transportAdapter = new CloudLLMAdapter({ endpoint: "/api/local-llm" });
  await transportAdapter.createVehicleKnowledgeSubplan({
    delegation: eligibilityDelegation,
    catalogProjection,
  });
  await transportAdapter.synthesizeVehicleKnowledgeAnswer({
    delegation: eligibilityDelegation,
    subplan: eligibilitySubplan,
    executionFacts: {},
  });
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
assert.deepEqual(
  transportTimeouts,
  [95_000, 95_000],
  "B3 planning and synthesis transport must outlive the 90s server phase budget",
);
assert.match(
  buildStructuredRepairPrompt(planningBody, "original", "KnowledgeSubplan", 42, "association-invalid"),
  /42 characters/,
);

const bounded = await runStructuredOutputProtocol({
  body: planningBody,
  initialResponse: "x".repeat(10_000),
  repair: async ({ invalidOutputLength }) => {
    assert.equal(invalidOutputLength, 8_192);
    return JSON.stringify(subplan);
  },
});
assert.equal(bounded.status, 200);

console.log("B3 vehicle knowledge model API protocol verification passed");

if (!process.argv.includes("--protocol-only")) {
  const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
  const endpoint = `${baseUrl}/api/local-llm`;
  const call = async (stage, body) => withinTimeout(stage, async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`${stage}: ${endpoint} returned HTTP ${response.status}`);
      error.diagnostic = {
        stage,
        status: response.status,
        durationMs: payload.telemetry?.durationMs ?? null,
        reasonCode: payload.telemetry?.structuredValidationReason ?? payload.telemetry?.reason ?? null,
        validationSubreason: payload.telemetry?.structuredValidationSubreason ?? null,
      };
      throw error;
    }
    assert.equal(typeof payload.output, "object", `${stage}: structured output is required`);
    assert.equal(Object.hasOwn(payload, "prompt"), false, `${stage}: prompt must not be exposed`);
    assert.equal(Object.hasOwn(payload, "rawModelResponse"), false, `${stage}: raw model output must not be exposed`);
    assert.ok(Number.isFinite(payload.telemetry?.durationMs), `${stage}: model duration is required`);
    assert.ok(payload.telemetry.durationMs <= modelTimeoutMs, `${stage}: model duration exceeds timeout`);
    return payload;
  }, VEHICLE_KNOWLEDGE_TRANSPORT_TIMEOUT_MS);
  const onlineFixture = createOnlineEligibilityFixture(randomUUID());
  try {
    const onlineOrchestrator = new OrchestratorController({
      modelAdapter: new CloudLLMAdapter({ endpoint }),
    });
    const onlinePlan = await withinTimeout(
      "b3-planning-cold",
      () => onlineOrchestrator.planKnowledgeTask({
        delegation: onlineFixture.delegation,
        complexity: "multi-target",
      }),
      VEHICLE_KNOWLEDGE_TRANSPORT_TIMEOUT_MS,
    );
    assert.equal(onlinePlan.validation.ok, true, onlinePlan.validation.errors.join("; "));
    assert.equal(onlinePlan.subplan.delegationId, onlineFixture.delegation.delegationId);
    const onlineSynthesis = await call("b3-synthesis", {
      task: "b3_vehicle_knowledge_synthesis",
      delegation: onlineFixture.delegation,
      subplan: onlinePlan.subplan,
      executionFacts: onlineFixture.executionFacts,
    });
    assert.equal(onlineSynthesis.output.delegationId, onlineFixture.delegation.delegationId);
    console.log(JSON.stringify({
      online: true,
      runId: onlineFixture.delegation.runId,
      phases: ["b3-planning-cold", "b3-synthesis"],
      durationsMs: [onlinePlan.telemetry.durationMs, onlineSynthesis.telemetry.durationMs],
      diagnostics: [
        {
          stage: "b3-planning-cold",
          status: 200,
          durationMs: onlinePlan.telemetry.durationMs,
          provider: onlinePlan.telemetry.provider ?? null,
          model: onlinePlan.telemetry.model ?? null,
          fallbackActive: onlinePlan.telemetry.fallbackActive ?? null,
          reasonCode: onlinePlan.telemetry.reason ?? null,
          validationSubreason: onlinePlan.telemetry.structuredValidationSubreason ?? null,
        },
        {
          stage: "b3-synthesis",
          status: 200,
          durationMs: onlineSynthesis.telemetry.durationMs,
          provider: onlineSynthesis.telemetry.provider ?? null,
          model: onlineSynthesis.telemetry.model ?? null,
          fallbackActive: onlineSynthesis.telemetry.fallbackActive ?? null,
          primaryFailureReasonCode: onlineSynthesis.telemetry.primaryFailureReasonCode ?? null,
          primaryStructuredValidationReason: onlineSynthesis.telemetry.primaryStructuredValidationReason ?? null,
          primaryStructuredValidationSubreason: onlineSynthesis.telemetry.primaryStructuredValidationSubreason ?? null,
          externalModelRequestCount: onlineSynthesis.telemetry.externalModelRequestCount ?? null,
          reasonCode: onlineSynthesis.telemetry.reason ?? null,
          validationSubreason: onlineSynthesis.telemetry.structuredValidationSubreason ?? null,
        },
      ],
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      online: false,
      runId: onlineFixture.delegation.runId,
      diagnostic: error?.diagnostic ?? {
        stage: "transport",
        status: null,
        durationMs: null,
        reasonCode: error?.name || "unknown-error",
        validationSubreason: null,
      },
    }, null, 2));
    process.exitCode = 1;
  }
}
