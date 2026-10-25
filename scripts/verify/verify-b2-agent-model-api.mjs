import assert from "node:assert/strict";
import {
  buildStructuredAgentJsonSchema,
  buildStructuredAgentPrompt,
  buildStructuredRepairPrompt,
  callStructuredAgentGenerate,
  getStructuredValidationDetail,
  getStructuredValidationFailure,
  resolveStructuredAgentTimeoutMs,
  runStructuredOutputProtocol,
} from "../../src/server/local-agent-server.mjs";
import {
  CloudLLMAdapter,
  buildGoalFormationPrompt,
  buildTrustedPlanningContextRefs,
  buildResponseSynthesisPrompt,
  buildTaskPlanningPrompt,
  resolveEligibleTaskPlanningCapabilities,
} from "../../src/runtime/cloud-llm-adapter.js";
import { getCapabilityCatalogProjection } from "../../src/agents/capability-catalog.js";
import { ModelProviderError } from "../../src/server/model-providers/model-provider-contract.js";
import {
  createVehicleSluGoalEnvelope,
  createVehicleSluPlanAuthority,
} from "../../src/semantic/vehicle-slu-orchestration.js";

const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const endpoint = `${baseUrl}/api/local-llm`;
const capabilityCatalog = [
  {
    id: "safety.evaluate",
    label: "Safety Gateway",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: { action: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string" } },
      additionalProperties: false,
    },
    accessMode: "read",
    requiresSafety: false,
    allowedDomains: ["vehicle-control"],
    degradationPolicy: "respond-with-available-evidence",
  },
  {
    id: "vehicle.window.set-position",
    label: "Window Position",
    inputSchema: {
      type: "object",
      required: ["zone", "percent"],
      properties: {
        zone: { type: "string" },
        percent: { type: "number" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["status"],
      properties: { status: { type: "string" } },
      additionalProperties: false,
    },
    accessMode: "write",
    requiresSafety: true,
    allowedDomains: ["vehicle-control"],
    degradationPolicy: "fail-closed",
  },
];
const goalEnvelope = {
  goalId: "goal:verify-b2-goal",
  runId: "verify-b2-goal",
  objective: "把主驾车窗打开一半",
  interactionType: "command",
  domain: "vehicle-control",
  constraints: ["driver-zone", "position-50"],
  contextRefs: [],
  requiredClarifications: [],
  readyForPlanning: true,
  model: "qwen2.5:7b",
  provider: "ollama",
  confidenceStrength: "strong",
};

function createControlPlanningFixture({ requestId, summary, intent, slots }) {
  const envelope = {
    contractVersion: "nio-vehicle-slu-contract@2.0.0",
    requestId,
    domain: "vehicle",
    conversationGoal: { summary, need: "none" },
    vehicleFrames: [{
      frameId: `frame:${requestId}`,
      capability: "control",
      intent,
      speechAct: "command",
      knowledgeNeed: "none",
      actionNeed: "execute",
      slots,
      missingSlots: [],
      clarificationQuestion: null,
      standaloneQuery: null,
      confidence: 0.99,
    }],
    domainConfidence: 0.99,
  };
  const goal = createVehicleSluGoalEnvelope(envelope);
  return {
    goal,
    goalEnvelope: goal,
    semanticAuthority: createVehicleSluPlanAuthority(envelope),
  };
}

const windowPlanningFixture = createControlPlanningFixture({
  requestId: goalEnvelope.runId,
  summary: "把主驾车窗打开一半",
  intent: "body.window.setPosition",
  slots: { zone: "front_left", percent: 50 },
});
const taskPlan = {
  planId: "plan:verify-b2-goal",
  goalId: goalEnvelope.goalId,
  runId: goalEnvelope.runId,
  steps: [
    {
      stepId: "safety",
      capabilityId: "safety.evaluate",
      dependsOn: [],
      input: { action: "window-position" },
      expectedOutput: "safety-decision",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "window",
      capabilityId: "vehicle.window.set-position",
      dependsOn: ["safety"],
      input: { zone: "front_left", percent: 50 },
      expectedOutput: "provider-confirmed-window-position",
      accessMode: "write",
      status: "planned",
    },
  ],
  selectedCapabilities: ["safety.evaluate", "vehicle.window.set-position"],
  writeActionCount: 1,
  planningSummary: "先通过安全检查，再执行用户指定的车窗位置变更。",
  model: "qwen2.5:7b",
  provider: "ollama",
  status: "planned",
};

function validSynthesisBody(overrides = {}) {
  return {
    task: "b2_response_synthesis",
    goalEnvelope,
    taskPlan,
    executionFacts: {
      runId: goalEnvelope.runId,
      goalId: goalEnvelope.goalId,
      planId: taskPlan.planId,
      stepResults: [{ stepId: "window", status: "awaiting-confirmation" }],
      evidenceRefs: [],
      safetyDecision: { allowed: true, confirmationRequired: true },
      toolResult: null,
      confirmedVehicleState: null,
      degraded: false,
      failureReason: "",
      completionStatus: "awaiting-confirmation",
      ...overrides,
    },
  };
}

const knowledgePrompt = buildStructuredAgentPrompt(validSynthesisBody({
  knowledgeDelegation: { delegationId: "delegation:run-1:knowledge", vehicleScope: "nio-es8-user-manual-2026" },
  knowledgeSubplan: { subplanId: "subplan:run-1" },
  knowledgeResult: { outcomeStatus: "answered", supportStatus: "partial", limitations: ["Provider unavailable"], vehicleStateRefs: [{ snapshotId: "provider-1" }], safetyAssessmentRef: { action: "reject" } },
}));
assert.match(knowledgePrompt, /"supportStatus":"partial"/);
assert.match(knowledgePrompt, /"Provider unavailable"/);
assert.match(knowledgePrompt, /"snapshotId":"provider-1"/);

async function verifyStructuredProtocol() {
  assert.equal(resolveStructuredAgentTimeoutMs(undefined), 90_000);
  assert.equal(resolveStructuredAgentTimeoutMs("invalid"), 90_000);
  assert.equal(resolveStructuredAgentTimeoutMs("90000"), 90_000);
  const driverCommand = {
    intent: "body.window.setPosition",
    slots: { zone: "front_left", percent: 50 },
    slotProvenance: { zone: "explicit", percent: "explicit" },
  };
  const passengerCommand = {
    ...driverCommand,
    slots: { zone: "front_right", percent: 50 },
  };
  const driverRefs = buildTrustedPlanningContextRefs(driverCommand);
  const passengerRefs = buildTrustedPlanningContextRefs(passengerCommand);
  assert.equal(driverRefs[0].targetZone, "front_left");
  assert.equal(driverRefs[0].percent, 50);
  assert.equal(passengerRefs[0].targetZone, "front_right");
  const goalSchema = buildStructuredAgentJsonSchema({
    task: "b2_goal_formation",
    runId: goalEnvelope.runId,
    parsedCommand: driverCommand,
  });
  assert.equal(goalSchema.additionalProperties, false);
  assert.deepEqual(goalSchema.required, [
    "goalId", "runId", "objective", "interactionType", "domain", "constraints",
    "contextRefs", "requiredClarifications", "readyForPlanning", "model", "provider",
    "confidenceStrength",
  ]);
  assert.equal(Object.hasOwn(goalSchema.properties.contextRefs, "const"), false);
  assert.equal(goalSchema.properties.contextRefs.items.additionalProperties, false);
  assert.equal(goalSchema.properties.contextRefs.items.properties.targetZone.const, "front_left");
  assert.equal(goalSchema.properties.contextRefs.items.properties.percent.const, 50);
  const synthesisSchema = buildStructuredAgentJsonSchema(validSynthesisBody());
  assert.equal(synthesisSchema.additionalProperties, false);
  assert.deepEqual(synthesisSchema.required, ["response", "writeCompletionStatus"]);
  const safetyRejectedBody = validSynthesisBody({
    stepResults: [{
      stepId: "window",
      capabilityId: "vehicle.window.set-position",
      status: "blocked",
      failureReason: "safety-rejected",
    }],
    safetyDecision: {
      allowed: false,
      action: "reject",
      reason: "当前防夹状态不满足要求",
    },
    completionStatus: "completed",
  });
  const safetyRejectedResponse = "当前操作未通过安全校验：当前防夹状态不满足要求";
  const safetyRejectedSchema = buildStructuredAgentJsonSchema(safetyRejectedBody);
  assert.equal(safetyRejectedSchema.properties.writeCompletionStatus.const, "blocked");
  assert.equal(safetyRejectedSchema.properties.response.const, safetyRejectedResponse);
  for (const safetyDecision of [
    null,
    { allowed: false },
    { allowed: false, action: "require_confirmation", reason: "需要确认" },
  ]) {
    const nonRejectSchema = buildStructuredAgentJsonSchema(validSynthesisBody({ safetyDecision }));
    assert.equal(
      nonRejectSchema.properties.writeCompletionStatus.const,
      "unconfirmed",
      "missing, unknown, and confirmation-required Safety outcomes must not use the blocked contract",
    );
  }

  assert.equal(
    getStructuredValidationFailure({ task: "b2_goal_formation" }, goalEnvelope),
    "",
    "goal validation should accept the complete GoalEnvelope contract",
  );
  assert.equal(
    getStructuredValidationFailure(
      { task: "b2_goal_formation" },
      { ...goalEnvelope, injected: "unknown" },
    ),
    "goal-contract-invalid",
    "goal validation should reject unknown contract fields",
  );
  assert.equal(
    getStructuredValidationFailure(
      { task: "b2_goal_formation" },
      { objective: goalEnvelope.objective },
    ),
    "goal-contract-invalid",
    "goal validation should reject missing required contract fields",
  );
  assert.deepEqual(
    getStructuredValidationDetail(
      { task: "b2_goal_formation", runId: goalEnvelope.runId },
      { ...goalEnvelope, runId: "model-invented-run" },
    ),
    { reasonCode: "goal-contract-invalid", validationSubreason: "association-invalid" },
    "goal validation must reject a model-invented runId before Orchestrator throws",
  );
  const commandGoalPrompt = buildGoalFormationPrompt({
    runId: goalEnvelope.runId,
    rawText: goalEnvelope.objective,
    parsedCommand: { speechAct: "command" },
    context: {},
  });
  assert.match(
    commandGoalPrompt,
    new RegExp(`runId exactly[^\\n]*${goalEnvelope.runId}`, "i"),
    "goal prompt must bind the model output to the request runId",
  );
  assert.match(
    commandGoalPrompt,
    /"interactionType":"command","domain":"vehicle-control"/,
    "command Goal shape must preserve the existing vehicle-control behavior",
  );
  const weatherParsedCommand = {
    intent: "conversation.general",
    speechAct: "question",
    slots: { topic: "weather_query" },
    conversationGoal: {
      interactionType: "question",
      domain: "weather",
      goal: "今天杭州天气怎么样？",
      externalDataType: "weather",
      requiresExternalData: true,
    },
  };
  const weatherGoalSchema = buildStructuredAgentJsonSchema({
    task: "b2_goal_formation",
    runId: "verify-b2-weather-goal",
    rawText: "今天杭州天气怎么样？",
    parsedCommand: weatherParsedCommand,
  });
  assert.equal(
    weatherGoalSchema.properties.domain.const,
    "external-information",
    "semantic weather must map to the capability catalog's external-information planning domain",
  );
  assert.equal(weatherGoalSchema.properties.interactionType.const, "question");
  const weatherGoalPrompt = buildGoalFormationPrompt({
    runId: "verify-b2-weather-goal",
    rawText: "今天杭州天气怎么样？",
    parsedCommand: weatherParsedCommand,
    context: {},
  });
  assert.match(
    weatherGoalPrompt,
    /"interactionType":"question","domain":"external-information"/,
    "weather Goal example must use the canonical B2 planning domain",
  );
  const validWeatherGoal = {
    ...goalEnvelope,
    goalId: "goal:verify-b2-weather-goal",
    runId: "verify-b2-weather-goal",
    objective: "今天杭州天气怎么样？",
    interactionType: "question",
    domain: "external-information",
    contextRefs: [],
  };
  assert.deepEqual(
    getStructuredValidationDetail({
      task: "b2_goal_formation",
      runId: validWeatherGoal.runId,
      rawText: validWeatherGoal.objective,
      parsedCommand: weatherParsedCommand,
    }, validWeatherGoal),
    { reasonCode: "", validationSubreason: "" },
  );
  assert.deepEqual(
    getStructuredValidationDetail({
      task: "b2_goal_formation",
      runId: validWeatherGoal.runId,
      rawText: validWeatherGoal.objective,
      parsedCommand: weatherParsedCommand,
    }, { ...validWeatherGoal, domain: "weather" }),
    { reasonCode: "goal-contract-invalid", validationSubreason: "association-invalid" },
    "the model must not leak semantic weather into the planning-domain contract",
  );
  const genericVehicleKnowledgeSchema = buildStructuredAgentJsonSchema({
    task: "b2_goal_formation",
    runId: "verify-generic-vehicle-knowledge",
    rawText: "帮我检查车辆状态并给出建议。",
    parsedCommand: {
      intent: "conversation.general",
      speechAct: "question",
      slots: { topic: "vehicle_knowledge" },
      conversationGoal: {
        interactionType: "question",
        domain: "vehicle_knowledge",
        goal: "帮我检查车辆状态并给出建议。",
      },
    },
  });
  assert.equal(
    genericVehicleKnowledgeSchema.properties.domain.const,
    "manual",
    "generic vehicle_knowledge must use the catalog's manual planning domain without gaining specialist authority",
  );
  const vehicleKnowledgeParsedCommand = {
    intent: "conversation.general",
    speechAct: "report",
    slots: { topic: "vehicle_knowledge" },
    conversationGoal: {
      interactionType: "question",
      domain: "vehicle_knowledge",
      goal: "ES8 尾门现在是否满足开启条件",
    },
  };
  const vehicleKnowledgeGoalPrompt = buildGoalFormationPrompt({
    runId: "verify-b3-vehicle-knowledge-goal",
    rawText: "ES8 尾门现在是否满足开启条件",
    parsedCommand: vehicleKnowledgeParsedCommand,
    context: {},
  });
  const vehicleKnowledgeShapePrefix = "Minimal JSON shape example (replace values from the request): ";
  const vehicleKnowledgeShape = JSON.parse(
    vehicleKnowledgeGoalPrompt
      .split("\n")
      .find((line) => line.startsWith(vehicleKnowledgeShapePrefix))
      .slice(vehicleKnowledgeShapePrefix.length),
  );
  assert.equal(
    vehicleKnowledgeShape.interactionType,
    "question",
    "normalized conversationGoal interactionType must be authoritative for Goal formation",
  );
  assert.equal(
    vehicleKnowledgeShape.domain,
    "manual",
    "normalized vehicle knowledge domain must map to the canonical manual Goal domain",
  );
  const sluKnowledgeRef = {
    type: "trusted-conversation-goal",
    source: "vehicle-slu-knowledge-frame",
    interactionType: "question",
    semanticDomain: "vehicle_knowledge",
    goalDomain: "manual",
    eligibilityAction: null,
  };
  assert.deepEqual(
    vehicleKnowledgeShape.contextRefs,
    [],
    "goal formation without a Vehicle-SLU frame carries no knowledge authority contextRef",
  );
  const vehicleKnowledgeGoalSchema = buildStructuredAgentJsonSchema({
    task: "b2_goal_formation",
    runId: "verify-b3-vehicle-knowledge-goal",
    rawText: "ES8 尾门现在是否满足开启条件",
    parsedCommand: vehicleKnowledgeParsedCommand,
  });
  assert.equal(vehicleKnowledgeGoalSchema.properties.interactionType.const, "question");
  assert.equal(vehicleKnowledgeGoalSchema.properties.domain.const, "manual");
  assert.equal(vehicleKnowledgeGoalSchema.properties.contextRefs.maxItems, 0);
  const validVehicleKnowledgeGoal = {
    ...goalEnvelope,
    goalId: "goal:verify-b3-vehicle-knowledge-goal",
    runId: "verify-b3-vehicle-knowledge-goal",
    objective: "ES8 尾门现在是否满足开启条件",
    interactionType: "question",
    domain: "manual",
    contextRefs: [],
  };
  assert.deepEqual(
    getStructuredValidationDetail({
      task: "b2_goal_formation",
      runId: validVehicleKnowledgeGoal.runId,
      rawText: validVehicleKnowledgeGoal.objective,
      parsedCommand: vehicleKnowledgeParsedCommand,
    }, validVehicleKnowledgeGoal),
    { reasonCode: "", validationSubreason: "" },
  );
  assert.deepEqual(
    getStructuredValidationDetail({
      task: "b2_goal_formation",
      runId: validVehicleKnowledgeGoal.runId,
      rawText: validVehicleKnowledgeGoal.objective,
      parsedCommand: vehicleKnowledgeParsedCommand,
    }, {
      ...validVehicleKnowledgeGoal,
      interactionType: "command",
      domain: "vehicle-control",
    }),
    { reasonCode: "goal-contract-invalid", validationSubreason: "association-invalid" },
    "model must not override the normalized knowledge Goal authority",
  );
  assert.deepEqual(
    getStructuredValidationDetail({
      task: "b2_goal_formation",
      runId: validVehicleKnowledgeGoal.runId,
      rawText: validVehicleKnowledgeGoal.objective,
      parsedCommand: vehicleKnowledgeParsedCommand,
    }, { ...validVehicleKnowledgeGoal, contextRefs: [sluKnowledgeRef] }),
    { reasonCode: "goal-contract-invalid", validationSubreason: "association-invalid" },
    "raw-text goal formation must not claim Vehicle-SLU knowledge authority",
  );
  // Planning-time knowledge authority comes only from a Vehicle-SLU knowledge frame.
  const sluKnowledgeGoal = { ...validVehicleKnowledgeGoal, contextRefs: [sluKnowledgeRef] };
  const knowledgePlanningBody = {
    task: "b2_task_planning",
    goalEnvelope: sluKnowledgeGoal,
    capabilityCatalog: getCapabilityCatalogProjection(),
  };
  const knowledgePlanningSchema = buildStructuredAgentJsonSchema(knowledgePlanningBody);
  assert.equal(knowledgePlanningSchema.properties.steps.items.oneOf.length, 1);
  assert.equal(
    knowledgePlanningSchema.properties.steps.items.oneOf[0].properties.capabilityId.const,
    "manual.retrieve",
    "trusted knowledge Goal schema must expose only the Manual RAG capability",
  );
  const knowledgeRetrieveInputSchema = knowledgePlanningSchema.properties.steps.items.oneOf[0]
    .properties.input;
  assert.equal(
    knowledgeRetrieveInputSchema.properties.query.const,
    sluKnowledgeGoal.objective,
    "knowledge TaskPlan schema must bind Manual RAG query to Goal-derived authority",
  );
  const knowledgePlanningPrompt = buildTaskPlanningPrompt({
    goalEnvelope: sluKnowledgeGoal,
    catalogProjection: knowledgePlanningBody.capabilityCatalog,
  });
  assert.match(knowledgePlanningPrompt, /exactly one manual\.retrieve/i);
  assert.doesNotMatch(
    knowledgePlanningPrompt.split("Catalog projection:").at(-1),
    /"id":"memory\.read"|"id":"safety\.evaluate"|"id":"response\.synthesize"/,
    "trusted knowledge Goal prompt must not expose legacy parent-plan bypass capabilities",
  );
  const knowledgePlanExamplePrefix = "Canonical JSON example for this GoalEnvelope and catalog: ";
  const knowledgePlanExampleLine = knowledgePlanningPrompt
    .split("\n")
    .find((line) => line.startsWith(knowledgePlanExamplePrefix));
  assert.ok(
    knowledgePlanExampleLine,
    "trusted knowledge planning must receive a GoalEnvelope-bound canonical TaskPlan example",
  );
  const knowledgePlanExample = JSON.parse(
    knowledgePlanExampleLine.slice(knowledgePlanExamplePrefix.length),
  );
  assert.deepEqual(
    knowledgePlanExample.steps[0].input,
    { query: sluKnowledgeGoal.objective },
    "Manual RAG input must be bound to code-owned Goal authority",
  );
  assert.deepEqual(
    getStructuredValidationDetail(knowledgePlanningBody, knowledgePlanExample),
    { reasonCode: "", validationSubreason: "" },
    "trusted knowledge canonical TaskPlan must satisfy the production validator",
  );
  for (const [field, replacement] of Object.entries({ query: "被篡改的知识目标" })) {
    const mutatedKnowledgePlan = structuredClone(knowledgePlanExample);
    mutatedKnowledgePlan.steps[0].input[field] = replacement;
    assert.deepEqual(
      getStructuredValidationDetail(knowledgePlanningBody, mutatedKnowledgePlan),
      { reasonCode: "plan-contract-invalid", validationSubreason: "association-invalid" },
      `Manual RAG authority mutation must be classified as association-invalid: ${field}`,
    );
  }
  const knowledgeAssociationRepairPrompt = buildStructuredRepairPrompt(
    knowledgePlanningBody,
    "ORIGINAL_KNOWLEDGE_PROMPT",
    "TaskPlanInput",
    64,
    "association-invalid",
  );
  assert.equal(
    knowledgeAssociationRepairPrompt.includes(
      `The sole manual.retrieve input query must equal: ${JSON.stringify(sluKnowledgeGoal.objective)}`,
    ),
    true,
    "knowledge association repair must echo the exact Goal-derived Manual RAG query",
  );
  assert.match(
    vehicleKnowledgeGoalPrompt,
    /preserve the normalized conversationGoal interactionType[\s\S]*map vehicle_knowledge and manual_knowledge domains to manual[\s\S]*must not rewrite a knowledge question as vehicle-control or report/i,
    "Goal prompt must preserve question intent and explicitly map semantic knowledge domains to manual",
  );
  const manualKnowledgePrompt = buildGoalFormationPrompt({
    runId: "verify-domain-manual-knowledge",
    rawText: "查用户手册，ES8 尾门开启条件是什么",
    parsedCommand: {
      speechAct: "report",
      conversationGoal: { interactionType: "question", domain: "manual_knowledge" },
    },
    context: {},
  });
  const manualKnowledgeShape = JSON.parse(
    manualKnowledgePrompt
      .split("\n")
      .find((line) => line.startsWith(vehicleKnowledgeShapePrefix))
      .slice(vehicleKnowledgeShapePrefix.length),
  );
  assert.equal(manualKnowledgeShape.interactionType, "question");
  assert.equal(
    manualKnowledgeShape.domain,
    "manual",
    "manual_knowledge must map to the canonical manual Goal domain",
  );

  const weatherPlanningBody = {
    task: "b2_task_planning",
    goalEnvelope: validWeatherGoal,
    capabilityCatalog: getCapabilityCatalogProjection(),
  };
  const expectedWeatherCapabilityIds = [
    "external.query",
  ];
  const weatherPlanningSchema = buildStructuredAgentJsonSchema(weatherPlanningBody);
  assert.equal(weatherPlanningSchema.properties.steps.minItems, 1);
  assert.equal(weatherPlanningSchema.properties.steps.maxItems, 1);
  assert.equal(weatherPlanningSchema.properties.selectedCapabilities.minItems, 1);
  assert.equal(weatherPlanningSchema.properties.selectedCapabilities.maxItems, 1);
  assert.deepEqual(
    weatherPlanningSchema.properties.steps.items.oneOf
      .map((schema) => schema.properties.capabilityId.const),
    expectedWeatherCapabilityIds,
    "TaskPlan schema must expose only capabilities allowed for the Goal domain",
  );
  assert.deepEqual(
    weatherPlanningSchema.properties.selectedCapabilities.items.enum,
    ["external.query"],
  );
  const weatherPlanningPrompt = buildTaskPlanningPrompt({
    goalEnvelope: validWeatherGoal,
    catalogProjection: weatherPlanningBody.capabilityCatalog,
  });
  const weatherCatalogPrefix = "Catalog projection: ";
  const weatherCatalog = JSON.parse(
    weatherPlanningPrompt
      .split("\n")
      .find((line) => line.startsWith(weatherCatalogPrefix))
      .slice(weatherCatalogPrefix.length),
  );
  assert.deepEqual(
    weatherCatalog.map(({ id }) => id),
    expectedWeatherCapabilityIds,
    "TaskPlan Prompt and schema must share the Goal-domain eligible catalog",
  );
  assert.equal(
    weatherCatalog.some(({ id }) => id === "safety.evaluate"),
    false,
    "read-only external-information Prompt must not expose Safety as a selectable capability",
  );
  assert.match(
    weatherPlanningPrompt,
    /read-only external-information Goal must contain exactly one read external\.query step/i,
    "weather Prompt must state the fail-closed external.query planning invariant",
  );
  assert.doesNotMatch(
    weatherPlanningPrompt,
    /command external-information Goal[^\n]*external\.query[^\n]*safety\.evaluate/i,
    "weather read-only Prompt must not inherit the actionable external command Safety rule",
  );
  const weatherPlanExampleLine = weatherPlanningPrompt
    .split("\n")
    .find((line) => line.startsWith(knowledgePlanExamplePrefix));
  assert.ok(
    weatherPlanExampleLine,
    "external-information planning must receive a GoalEnvelope-bound canonical TaskPlan example",
  );
  const weatherPlanExample = JSON.parse(
    weatherPlanExampleLine.slice(knowledgePlanExamplePrefix.length),
  );
  assert.deepEqual(
    weatherPlanExample.selectedCapabilities,
    ["external.query"],
    "weather canonical planning must use the read-only external query without Safety",
  );
  const weatherExternalStep = weatherPlanExample.steps.find(
    (step) => step.capabilityId === "external.query",
  );
  assert.deepEqual(weatherExternalStep.dependsOn, []);
  assert.equal(
    weatherPlanExample.steps.some((step) => step.capabilityId === "safety.evaluate"),
    false,
    "weather canonical planning must not route conversation.general through Safety",
  );
  assert.deepEqual(
    getStructuredValidationDetail(weatherPlanningBody, weatherPlanExample),
    { reasonCode: "", validationSubreason: "" },
    "weather canonical TaskPlan must satisfy the production read-only validator",
  );
  const weatherContractRepairPrompt = buildStructuredRepairPrompt(
    weatherPlanningBody,
    "ORIGINAL_WEATHER_PROMPT",
    "TaskPlanInput",
    64,
    "contract-invalid",
  );
  assert.match(
    weatherContractRepairPrompt,
    /read-only external-information Goal must contain exactly one read external\.query step/i,
    "weather repair must restate the exact external.query planning invariant",
  );
  const weatherDependencyRepairPrompt = buildStructuredRepairPrompt(
    weatherPlanningBody,
    weatherPlanningPrompt,
    "TaskPlanInput",
    64,
    "dependency-invalid",
  );
  assert.match(
    weatherDependencyRepairPrompt,
    /requiresSafety[^\n]*(?:read or write)[^\n]*earlier safety\.evaluate ancestor/i,
    "repair guidance must cover every safety-required capability, including reads",
  );
  const navigationPlanningBody = {
    ...weatherPlanningBody,
    goalEnvelope: {
      ...validWeatherGoal,
      goalId: "goal:verify-navigation-command",
      runId: "verify-navigation-command",
      objective: "规划去测试地点的路线",
      interactionType: "command",
    },
  };
  const navigationPlanningPrompt = buildTaskPlanningPrompt({
    goalEnvelope: navigationPlanningBody.goalEnvelope,
    catalogProjection: navigationPlanningBody.capabilityCatalog,
  });
  assert.match(
    navigationPlanningPrompt,
    /command external-information Goal[^\n]*external\.query[^\n]*earlier safety\.evaluate ancestor/i,
    "actionable external command Prompt must require Safety before external.query",
  );
  assert.doesNotMatch(
    navigationPlanningPrompt,
    /vehicle-slu-frame-authority|vehicle\.tailgate\.set|vehicle-control write/i,
    "non-vehicle commands must not receive Vehicle-SLU write-binding instructions",
  );
  assert.equal(
    buildStructuredAgentJsonSchema(navigationPlanningBody).properties.steps.items.oneOf
      .some((schema) => schema.properties.capabilityId.const === "safety.evaluate"),
    true,
    "command external-information schema must keep Safety selectable",
  );
  assert.match(
    buildStructuredRepairPrompt(
      navigationPlanningBody,
      navigationPlanningPrompt,
      "TaskPlanInput",
      64,
      "dependency-invalid",
    ),
    /external\.query[^\n]*command Goal[^\n]*earlier safety\.evaluate ancestor/i,
    "dependency repair must explain the dynamic command external.query Safety rule",
  );

  const planningBody = {
    task: "b2_task_planning",
    goalEnvelope: windowPlanningFixture.goalEnvelope,
    capabilityCatalog,
    semanticAuthority: windowPlanningFixture.semanticAuthority,
  };
  const planningSchema = buildStructuredAgentJsonSchema(planningBody);
  assert.equal(planningSchema.additionalProperties, false);
  assert.equal(planningSchema.properties.steps.items.oneOf.length, capabilityCatalog.length);
  for (const stepSchema of planningSchema.properties.steps.items.oneOf) {
    assert.equal(stepSchema.additionalProperties, false);
    assert.deepEqual(stepSchema.required, [
      "stepId", "capabilityId", "dependsOn", "input", "expectedOutput", "accessMode", "status",
    ]);
  }
  const windowStepSchema = planningSchema.properties.steps.items.oneOf
    .find((schema) => schema.properties.capabilityId.const === "vehicle.window.set-position");
  assert.equal(windowStepSchema.properties.input.properties.zone.const, "front_left");
  assert.equal(windowStepSchema.properties.input.properties.percent.const, 50);
  const questionPlanningSchema = buildStructuredAgentJsonSchema({
    ...planningBody,
    goalEnvelope: {
      ...planningBody.goalEnvelope,
      interactionType: "question",
    },
  });
  assert.equal(
    questionPlanningSchema.properties.writeActionCount.const,
    0,
    "read-only GoalEnvelope must bind writeActionCount to zero",
  );
  assert.equal(
    questionPlanningSchema.properties.steps.items.oneOf.some(
      (schema) => schema.properties.accessMode.const === "write",
    ),
    false,
    "read-only GoalEnvelope must not expose write capability schemas",
  );
  const questionPlanningPrompt = buildTaskPlanningPrompt({
    goalEnvelope: {
      ...planningBody.goalEnvelope,
      interactionType: "question",
    },
    catalogProjection: capabilityCatalog,
  });
  assert.doesNotMatch(
    questionPlanningPrompt.split("Catalog projection:").at(-1),
    /"accessMode":"write"/,
    "read-only GoalEnvelope prompt must use the same read-only catalog as its schema",
  );
  assert.doesNotMatch(
    questionPlanningPrompt,
    /explicit requested state change|mandatory dependency chain/,
    "read-only GoalEnvelope prompt must not contain write-planning instructions",
  );
  assert.match(
    questionPlanningPrompt,
    /read-only[\s\S]*writeActionCount[^\\n]*0/i,
    "read-only GoalEnvelope prompt must explicitly require a zero-write plan",
  );
  assert.deepEqual(
    getStructuredValidationDetail(
      {
        task: "b2_goal_formation",
        runId: goalEnvelope.runId,
        parsedCommand: driverCommand,
      },
      { ...goalEnvelope, contextRefs: passengerRefs },
    ),
    { reasonCode: "goal-contract-invalid", validationSubreason: "association-invalid" },
    "Goal validation must reject model-swapped trusted command slots",
  );
  assert.deepEqual(
    getStructuredValidationDetail(planningBody, {
      ...taskPlan,
      steps: taskPlan.steps.map((step) => step.capabilityId === "vehicle.window.set-position"
        ? { ...step, input: { ...step.input, zone: "front_right" } }
        : step),
    }),
    { reasonCode: "plan-contract-invalid", validationSubreason: "association-invalid" },
    "TaskPlan validation must reject a model-swapped trusted command target",
  );
  const providerRequests = [];
  const fakeProvider = {
    id: "fake-provider",
    model: "fake-model",
    async generate(request) {
      providerRequests.push(request);
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
  const fakeRegistry = {
    providerFor() { return fakeProvider; },
    generateForTask(_task, request) { return fakeProvider.generate(request); },
  };
  await callStructuredAgentGenerate({
    body: planningBody,
    prompt: "fake-prompt",
    registry: fakeRegistry,
  });
  assert.deepEqual(
    providerRequests[0].jsonSchema,
    planningSchema,
    "structured Agent generation must send the code-owned JSON Schema object to the active Provider",
  );
  assert.equal(providerRequests[0].generationProfile, "structured-agent");
  assert.equal(providerRequests[0].outputMode, "json-object");
  const deterministicTaskCases = [
    ["b2_goal_formation", { task: "b2_goal_formation" }, goalEnvelope],
    ["b2_task_planning", planningBody, taskPlan],
    ["b2_response_synthesis", validSynthesisBody(), {
      response: "写入操作尚未确认完成。",
      writeCompletionStatus: "unconfirmed",
    }],
  ];
  const deterministicGenerations = [];
  const requestStart = providerRequests.length;
  for (const [, body] of deterministicTaskCases) {
    deterministicGenerations.push(await callStructuredAgentGenerate({
      body,
      prompt: "initial",
      registry: fakeRegistry,
    }));
    deterministicGenerations.push(await callStructuredAgentGenerate({
      body,
      prompt: "repair",
      registry: fakeRegistry,
    }));
  }
  for (const generation of deterministicGenerations) {
    assert.equal(generation.provider, "fake-provider");
    assert.equal(typeof generation.durationMs, "number");
  }
  const deterministicRequests = providerRequests.slice(requestStart);
  assert.equal(deterministicRequests.length, 6);
  for (let index = 0; index < deterministicTaskCases.length; index += 1) {
    const [task] = deterministicTaskCases[index];
    for (const request of deterministicRequests.slice(index * 2, index * 2 + 2)) {
      assert.equal(request.generationProfile, "structured-agent", `${task}: generation profile`);
      assert.equal(request.outputMode, "json-object", `${task}: structured output mode`);
      assert.equal(
        Object.hasOwn(request, "timeoutMs"),
        false,
        `${task}: Provider Registry must own the trusted watchdog`,
      );
    }
  }
  const commandCatalog = [
    {
      id: "manual.retrieve",
      label: "Manual RAG",
      accessMode: "read",
      requiresSafety: false,
      inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    },
    ...capabilityCatalog,
    {
      id: "response.synthesize",
      label: "Response Synthesis",
      accessMode: "read",
      requiresSafety: false,
      inputSchema: {
        type: "object",
        required: ["facts"],
        properties: { facts: { type: "object" } },
      },
    },
  ];
  const commandPlanningPrompt = buildTaskPlanningPrompt({
    goalEnvelope: windowPlanningFixture.goalEnvelope,
    catalogProjection: commandCatalog,
    semanticAuthority: windowPlanningFixture.semanticAuthority,
  });
  assert.match(
    commandPlanningPrompt,
    /vehicle-control write[\s\S]*vehicle-slu-frame-authority/i,
    "planning prompt must bind vehicle writes to Vehicle-SLU frame authority",
  );
  assert.match(
    commandPlanningPrompt,
    /safety\.evaluate[\s\S]*write[\s\S]*response\.synthesize/i,
    "planning prompt must explain the general safety → write → response dependency pattern",
  );
  assert.match(
    commandPlanningPrompt,
    /Never recover vehicle authority from objective or constraints/i,
    "planning prompt must forbid objective/constraint authority recovery",
  );
  assert.match(
    commandPlanningPrompt,
    /Exact TaskPlan root fields: planId, goalId, runId, steps, selectedCapabilities, writeActionCount, planningSummary, model, provider, status\./,
    "planning prompt must enumerate the exact TaskPlan root fields",
  );
  assert.match(
    commandPlanningPrompt,
    /Exact step fields: stepId, capabilityId, dependsOn, input, expectedOutput, accessMode, status\./,
    "planning prompt must enumerate the exact step fields",
  );
  const commandExamplePrefix = "Canonical JSON example for this GoalEnvelope and catalog: ";
  const commandExampleLine = commandPlanningPrompt
    .split("\n")
    .find((line) => line.startsWith(commandExamplePrefix));
  assert.ok(commandExampleLine, "vehicle commands must receive a bound canonical plan example");
  const commandExample = JSON.parse(commandExampleLine.slice(commandExamplePrefix.length));
  assert.deepEqual(
    getStructuredValidationDetail({
      task: "b2_task_planning",
      goalEnvelope: windowPlanningFixture.goalEnvelope,
      capabilityCatalog: commandCatalog,
      semanticAuthority: windowPlanningFixture.semanticAuthority,
    }, commandExample),
    { reasonCode: "", validationSubreason: "" },
    "vehicle-command example must satisfy the server-owned plan contract",
  );
  assert.deepEqual(
    commandExample.steps.find((step) => step.capabilityId === "vehicle.window.set-position")?.input,
    { zone: "front_left", percent: 50 },
    "vehicle-command example must preserve trusted command slots exactly",
  );
  assert.equal(
    commandExample.selectedCapabilities.includes("manual.retrieve"),
    false,
    "vehicle-command example must not copy an unrelated read-only capability",
  );
  const tailgatePlanningFixture = createControlPlanningFixture({
    requestId: "verify-b2-tailgate",
    summary: "帮我打开后备箱",
    intent: "body.tailgate.open",
    slots: { open: true },
  });
  const tailgateGoalEnvelope = tailgatePlanningFixture.goalEnvelope;
  const tailgateCatalog = getCapabilityCatalogProjection();
  const tailgatePlanningPrompt = buildTaskPlanningPrompt({
    goalEnvelope: tailgateGoalEnvelope,
    catalogProjection: tailgateCatalog,
    semanticAuthority: tailgatePlanningFixture.semanticAuthority,
  });
  const tailgatePromptCatalog = JSON.parse(
    tailgatePlanningPrompt
      .split("\n")
      .find((line) => line.startsWith(weatherCatalogPrefix))
      .slice(weatherCatalogPrefix.length),
  );
  const expectedTailgateCapabilities = [
    "safety.evaluate",
    "confirmation.issue",
    "vehicle.tailgate.set",
    "response.synthesize",
  ];
  assert.deepEqual(
    tailgatePromptCatalog.map(({ id }) => id),
    expectedTailgateCapabilities,
    "tailgate Prompt must expose only Safety, confirmation, target write, and response",
  );
  assert.match(
    tailgatePlanningPrompt,
    /vehicle\.tailgate\.set[\s\S]*safety\.evaluate\s*→\s*confirmation\.issue\s*→\s*vehicle\.tailgate\.set/,
    "tailgate planning prompt must require the three-stage confirmation dependency",
  );
  const tailgateExampleLine = tailgatePlanningPrompt
    .split("\n")
    .find((line) => line.startsWith(commandExamplePrefix));
  assert.ok(tailgateExampleLine);
  const tailgateExample = JSON.parse(tailgateExampleLine.slice(commandExamplePrefix.length));
  assert.deepEqual(
    tailgateExample.steps.map(({ stepId, capabilityId, dependsOn }) => ({
      stepId,
      capabilityId,
      dependsOn,
    })),
    [
      { stepId: "safety-tailgate", capabilityId: "safety.evaluate", dependsOn: [] },
      { stepId: "confirmation-tailgate", capabilityId: "confirmation.issue", dependsOn: ["safety-tailgate"] },
      { stepId: "write-tailgate", capabilityId: "vehicle.tailgate.set", dependsOn: ["confirmation-tailgate"] },
      { stepId: "response-tailgate", capabilityId: "response.synthesize", dependsOn: ["write-tailgate"] },
    ],
    "tailgate canonical example must match the prompt's fixed dependency topology",
  );
  assert.deepEqual(
    getStructuredValidationDetail({
      task: "b2_task_planning",
      goalEnvelope: tailgateGoalEnvelope,
      capabilityCatalog: tailgateCatalog,
      semanticAuthority: tailgatePlanningFixture.semanticAuthority,
    }, tailgateExample),
    { reasonCode: "", validationSubreason: "" },
    "tailgate canonical example must satisfy the server-owned plan contract",
  );
  assert.deepEqual(tailgateExample.steps[0].input, { action: "body.tailgate.open" });
  assert.deepEqual(tailgateExample.steps[1].input, { action: "body.tailgate.open" });
  const clarifyTailgateEnvelope = {
    contractVersion: "nio-vehicle-slu-contract@2.0.0",
    requestId: "verify-b2-tailgate-clarify",
    domain: "vehicle",
    conversationGoal: { summary: "帮我操作后备箱", need: "none" },
    vehicleFrames: [{
      frameId: "frame:verify-b2-tailgate-clarify",
      capability: "control",
      intent: "body.tailgate.open",
      speechAct: "command",
      knowledgeNeed: "none",
      actionNeed: "clarify",
      slots: {},
      missingSlots: ["open"],
      clarificationQuestion: "请问要打开还是关闭后备箱？",
      standaloneQuery: null,
      confidence: 0.99,
    }],
    domainConfidence: 0.99,
  };
  const clarifyTailgateAuthority = createVehicleSluPlanAuthority(clarifyTailgateEnvelope);
  assert.deepEqual(
    {
      admittedWriteFrameId: clarifyTailgateAuthority.admittedWriteFrameId,
      allowedCapabilityIds: clarifyTailgateAuthority.allowedCapabilityIds,
      deferredFrameIds: clarifyTailgateAuthority.deferredFrameIds,
    },
    {
      admittedWriteFrameId: null,
      allowedCapabilityIds: [],
      deferredFrameIds: ["frame:verify-b2-tailgate-clarify"],
    },
    "a valid clarify frame must carry no Vehicle-SLU write planning authority",
  );
  const serverBindingProbeDomain = "vehicle-control-clarification-probe";
  const clarifyTailgateGoal = {
    ...tailgateGoalEnvelope,
    goalId: "goal:verify-b2-tailgate-clarify",
    runId: clarifyTailgateEnvelope.requestId,
    objective: clarifyTailgateEnvelope.conversationGoal.summary,
    domain: serverBindingProbeDomain,
    contextRefs: [{
      type: "vehicle-slu-frame-authority",
      ...clarifyTailgateEnvelope.vehicleFrames[0],
    }],
  };
  const clarifyTailgateCatalog = tailgateCatalog
    .filter(({ id }) => expectedTailgateCapabilities.includes(id))
    .map((capability) => ({ ...capability, allowedDomains: [serverBindingProbeDomain] }));
  const clarifyTailgatePlanningBody = {
    task: "b2_task_planning",
    goalEnvelope: clarifyTailgateGoal,
    capabilityCatalog: clarifyTailgateCatalog,
  };
  const clarifyTailgateSchema = buildStructuredAgentJsonSchema(clarifyTailgatePlanningBody);
  const clarifyTailgateWriteSchema = clarifyTailgateSchema.properties.steps.items.oneOf
    .find((schema) => schema.properties.capabilityId.const === "vehicle.tailgate.set");
  assert.ok(clarifyTailgateWriteSchema, "server binding probe must reach the real tailgate step schema");
  assert.equal(
    Object.hasOwn(clarifyTailgateWriteSchema.properties.input.properties.state, "const"),
    false,
    "a clarify frame must not bind a tailgate state const",
  );
  const clarifyTailgateWritePlan = {
    ...tailgateExample,
    planId: "plan:verify-b2-tailgate-clarify",
    goalId: clarifyTailgateGoal.goalId,
    runId: clarifyTailgateGoal.runId,
    steps: tailgateExample.steps.map((step) => (
      step.capabilityId === "vehicle.tailgate.set"
        ? { ...step, input: { state: "closed" } }
        : step
    )),
  };
  assert.deepEqual(
    getStructuredValidationDetail(clarifyTailgatePlanningBody, clarifyTailgateWritePlan),
    { reasonCode: "plan-contract-invalid", validationSubreason: "catalog-invalid" },
    "a clarify frame must not validate a tailgate write plan",
  );
  const vehicleCommandCases = [
    {
      label: "window",
      goal: windowPlanningFixture.goalEnvelope,
      semanticAuthority: windowPlanningFixture.semanticAuthority,
      capabilityId: "vehicle.window.set-position",
      input: { zone: "front_left", percent: 50 },
      action: "body.window.setPosition",
    },
    {
      label: "seat",
      ...createControlPlanningFixture({
        requestId: "verify-b2-seat",
        summary: "把主驾座椅靠背调到110度",
        intent: "seat.driver.setBackrestAngle",
        slots: { seat: "driver", angle: 110 },
      }),
      capabilityId: "vehicle.seat.set-backrest",
      input: { zone: "driver", angle: 110 },
      action: "seat.driver.setBackrestAngle",
    },
    {
      label: "climate",
      ...createControlPlanningFixture({
        requestId: "verify-b2-climate",
        summary: "把空调调到22度",
        intent: "cabin.climate.setPreset",
        slots: { temperature: 22 },
      }),
      capabilityId: "vehicle.climate.set",
      input: { temperature: 22 },
      action: "cabin.climate.setPreset",
    },
  ];
  for (const fixture of vehicleCommandCases) {
    const prompt = buildTaskPlanningPrompt({
      goalEnvelope: fixture.goal,
      catalogProjection: tailgateCatalog,
      semanticAuthority: fixture.semanticAuthority,
    });
    const exampleLine = prompt.split("\n")
      .find((line) => line.startsWith(commandExamplePrefix));
    assert.ok(exampleLine, `${fixture.label}: a fully bound command needs a canonical example`);
    const example = JSON.parse(exampleLine.slice(commandExamplePrefix.length));
    const promptCatalog = JSON.parse(
      prompt
        .split("\n")
        .find((line) => line.startsWith(weatherCatalogPrefix))
        .slice(weatherCatalogPrefix.length),
    );
    const expectedCapabilities = [
      "safety.evaluate",
      fixture.capabilityId,
      "response.synthesize",
    ];
    assert.deepEqual(
      promptCatalog.map(({ id }) => id),
      expectedCapabilities,
      `${fixture.label}: Prompt must expose only Safety, the target write, and response`,
    );
    assert.deepEqual(
      buildStructuredAgentJsonSchema({
        task: "b2_task_planning",
        goalEnvelope: fixture.goal,
        capabilityCatalog: tailgateCatalog,
        semanticAuthority: fixture.semanticAuthority,
      }).properties.steps.items.oneOf.map((schema) => schema.properties.capabilityId.const),
      expectedCapabilities,
      `${fixture.label}: schema must match the narrowed Prompt catalog`,
    );
    assert.deepEqual(
      example.selectedCapabilities,
      expectedCapabilities,
      `${fixture.label}: example must select only the matching write topology`,
    );
    assert.deepEqual(example.steps[0].input, { action: fixture.action });
    assert.deepEqual(example.steps[1].input, fixture.input);
    assert.deepEqual(example.steps[2].dependsOn, [example.steps[1].stepId]);
    assert.deepEqual(
      getStructuredValidationDetail({
        task: "b2_task_planning",
        goalEnvelope: fixture.goal,
        capabilityCatalog: tailgateCatalog,
        semanticAuthority: fixture.semanticAuthority,
      }, example),
      { reasonCode: "", validationSubreason: "" },
      `${fixture.label}: bound example must satisfy the server-owned plan contract`,
    );
  }
  const incompleteCommandGoal = {
    ...goalEnvelope,
    objective: "打开主驾车窗",
    constraints: ["driver-zone"],
    contextRefs: [],
  };
  const incompleteCommandPrompt = buildTaskPlanningPrompt({
    goalEnvelope: incompleteCommandGoal,
    catalogProjection: tailgateCatalog,
  });
  assert.deepEqual(
    resolveEligibleTaskPlanningCapabilities({
      goalEnvelope: incompleteCommandGoal,
      catalogProjection: tailgateCatalog,
    }),
    [],
    "missing vehicle binding must fail closed with an empty eligible catalog",
  );
  assert.doesNotMatch(
    incompleteCommandPrompt,
    /Canonical JSON example for this GoalEnvelope and catalog:/,
    "a command with an unbound required input must not invent a canonical example",
  );
  assert.match(
    incompleteCommandPrompt,
    /No canonical JSON example is available/i,
    "a command with an unbound required input must take the explicit no-example path",
  );
  const conflictingCommandGoal = {
    ...goalEnvelope,
    objective: "把主驾车窗调到50%",
    constraints: ["passenger-zone", "position-50"],
    contextRefs: driverRefs,
  };
  const originalFetch = globalThis.fetch;
  let unresolvedBindingFetchCalls = 0;
  try {
    globalThis.fetch = async () => {
      unresolvedBindingFetchCalls += 1;
      throw new Error("unresolved vehicle binding must not reach fetch");
    };
    const adapter = new CloudLLMAdapter({ endpoint: "http://offline.invalid/api/local-llm" });
    for (const [label, unresolvedGoal] of [
      ["missing", incompleteCommandGoal],
      ["conflicting", conflictingCommandGoal],
    ]) {
      await assert.rejects(
        adapter.createTaskPlan({
          runId: unresolvedGoal.runId,
          goalEnvelope: unresolvedGoal,
          catalogProjection: tailgateCatalog,
        }),
        (error) => {
          assert.equal(error.code, "plan-binding-unavailable", `${label}: normalized error code`);
          assert.deepEqual(error.telemetry, {
            degraded: true,
            reason: "plan-binding-unavailable",
            externalModelRequestCount: 0,
          }, `${label}: normalized fail-closed telemetry`);
          return true;
        },
        `${label}: unresolved vehicle binding must fail before local LLM transport`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    unresolvedBindingFetchCalls,
    0,
    "missing/conflicting vehicle bindings must consume zero local or external model requests",
  );
  const unresolvedPlanningBody = {
    task: "b2_task_planning",
    goalEnvelope: incompleteCommandGoal,
    capabilityCatalog: tailgateCatalog,
  };
  const unresolvedPlanningSchema = buildStructuredAgentJsonSchema(unresolvedPlanningBody);
  assert.deepEqual(
    unresolvedPlanningSchema.properties.steps.items.oneOf,
    [],
    "unknown vehicle binding schema must expose no capability step",
  );
  assert.deepEqual(
    unresolvedPlanningSchema.properties.selectedCapabilities.items.enum,
    [],
    "unknown vehicle binding schema must expose no selected capability",
  );
  const emptyUnresolvedPlan = {
    ...taskPlan,
    steps: [],
    selectedCapabilities: [],
    writeActionCount: 0,
  };
  assert.deepEqual(
    getStructuredValidationDetail(unresolvedPlanningBody, emptyUnresolvedPlan),
    { reasonCode: "plan-contract-invalid", validationSubreason: "write-policy-invalid" },
    "unknown vehicle binding must reject an empty plan",
  );
  for (const [label, arbitraryWritePlan] of [
    ["window", taskPlan],
    ["tailgate", tailgateExample],
  ]) {
    assert.deepEqual(
      getStructuredValidationDetail(unresolvedPlanningBody, arbitraryWritePlan),
      {
        reasonCode: "plan-contract-invalid",
        validationSubreason: label === "tailgate" ? "association-invalid" : "catalog-invalid",
      },
      `${label}: unknown vehicle binding must reject an otherwise valid arbitrary write plan`,
    );
  }
  const assertNoCanonicalCommandExample = (label, goal) => {
    const unresolvedGoal = { ...goalEnvelope, ...goal, contextRefs: goal.contextRefs ?? [] };
    const prompt = buildTaskPlanningPrompt({
      goalEnvelope: unresolvedGoal,
      catalogProjection: tailgateCatalog,
    });
    assert.deepEqual(
      resolveEligibleTaskPlanningCapabilities({
        goalEnvelope: unresolvedGoal,
        catalogProjection: tailgateCatalog,
      }),
      [],
      `${label}: conflicting vehicle binding must expose no eligible capability`,
    );
    assert.doesNotMatch(
      prompt,
      /Canonical JSON example for this GoalEnvelope and catalog:/,
      `${label}: conflicting sources must not produce a canonical example`,
    );
    assert.match(prompt, /No canonical JSON example is available/i);
  };
  for (const [label, goal] of [
    ["window trusted/constraint zone conflict", {
      objective: "把主驾车窗调到50%",
      constraints: ["passenger-zone", "position-50"],
      contextRefs: driverRefs,
    }],
    ["window zone conflict", {
      objective: "把主驾车窗调到50%",
      constraints: ["passenger-zone", "position-50"],
    }],
    ["window objective/constraint percent conflict", {
      objective: "把主驾车窗调到50%",
      constraints: ["driver-zone", "position-20"],
    }],
    ["window multiple position constraints", {
      objective: "调节主驾车窗",
      constraints: ["driver-zone", "position-20", "position-50"],
    }],
    ["seat objective/constraint angle conflict", {
      objective: "把主驾座椅靠背调到110度",
      constraints: ["driver-seat", "angle-100"],
    }],
    ["seat multiple angle constraints", {
      objective: "调节主驾座椅靠背",
      constraints: ["driver-seat", "angle-100", "angle-110"],
    }],
    ["climate objective/constraint temperature conflict", {
      objective: "把空调调到22度",
      constraints: ["temperature-24"],
    }],
    ["climate multiple temperature constraints", {
      objective: "调节空调",
      constraints: ["temperature-22", "temperature-24"],
    }],
  ]) assertNoCanonicalCommandExample(label, goal);

  const objectiveOnlyPrompt = buildTaskPlanningPrompt({
    goalEnvelope: {
      ...goalEnvelope,
      objective: "把主驾车窗调到50%",
      constraints: ["driver-zone", "position-50", "position-50"],
      contextRefs: [],
    },
    catalogProjection: tailgateCatalog,
  });
  assert.doesNotMatch(
    objectiveOnlyPrompt,
    /Canonical JSON example for this GoalEnvelope and catalog:/,
    "objective and constraint duplicates must not recover Vehicle-SLU write authority",
  );
  const tailgatePlanningSchema = buildStructuredAgentJsonSchema({
    task: "b2_task_planning",
    goalEnvelope: tailgateGoalEnvelope,
    capabilityCatalog: tailgateCatalog,
    semanticAuthority: tailgatePlanningFixture.semanticAuthority,
  });
  assert.equal(
    tailgatePlanningSchema.allOf,
    undefined,
    "task planning schema must remain capability-local so unrelated plans do not inherit tailgate conditionals",
  );
  assert.deepEqual(
    tailgatePlanningSchema.properties.steps.items.oneOf
      .map((schema) => schema.properties.capabilityId.const),
    expectedTailgateCapabilities,
    "tailgate schema must match the narrowed Prompt catalog",
  );
  const classifiedInvalidPlans = [
    [{ ...taskPlan, planningSummary: undefined }, "missing-required"],
    [{ ...taskPlan, injected: "unknown" }, "unknown-field"],
    [{
      ...taskPlan,
      steps: Array.from({ length: 7 }, (_, index) => ({
        ...taskPlan.steps[0],
        stepId: `step-${index}`,
      })),
      selectedCapabilities: Array.from({ length: 7 }, () => "safety.evaluate"),
    }, "step-count"],
    [{ ...taskPlan, runId: "wrong-run" }, "association-invalid"],
    [{
      ...taskPlan,
      steps: [{ ...taskPlan.steps[0], capabilityId: "unknown.capability" }],
      selectedCapabilities: ["unknown.capability"],
      writeActionCount: 0,
    }, "catalog-invalid"],
    [{
      ...taskPlan,
      steps: [{ ...taskPlan.steps[0], input: {} }],
      selectedCapabilities: ["safety.evaluate"],
      writeActionCount: 0,
    }, "input-schema-invalid"],
  ];
  for (const [invalidPlan, validationSubreason] of classifiedInvalidPlans) {
    assert.deepEqual(
      getStructuredValidationDetail(planningBody, invalidPlan),
      { reasonCode: "plan-contract-invalid", validationSubreason },
    );
  }
  const unknownFieldRepairPrompt = buildStructuredRepairPrompt(
    planningBody,
    "ORIGINAL_PROMPT_WITHOUT_MODEL_OUTPUT",
    "TaskPlanInput",
    321,
    "unknown-field",
  );
  assert.match(
    unknownFieldRepairPrompt,
    /Allowed TaskPlan root keys exactly: planId, goalId, runId, steps, selectedCapabilities, writeActionCount, planningSummary, model, provider, status\./,
    "unknown-field repair must enumerate exact TaskPlan root keys",
  );
  assert.match(
    unknownFieldRepairPrompt,
    /Allowed step keys exactly: stepId, capabilityId, dependsOn, input, expectedOutput, accessMode, status\./,
    "unknown-field repair must enumerate exact step keys",
  );
  assert.match(
    unknownFieldRepairPrompt,
    /Exact inputSchema by capability:[\s\S]*safety\.evaluate[\s\S]*vehicle\.window\.set-position/,
    "unknown-field repair must include catalog-projected nested input schemas",
  );
  assert.match(
    unknownFieldRepairPrompt,
    /Remove all undeclared keys from the root, every step, and every nested input object\./,
    "unknown-field repair must give an explicit recursive removal instruction",
  );
  assert.doesNotMatch(
    unknownFieldRepairPrompt,
    /SECRET_MODEL_EXTRA_FIELD/,
    "repair diagnostics must not contain raw invalid model output",
  );
  assert.equal(
    getStructuredValidationFailure(planningBody, taskPlan),
    "",
    "plan validation should accept the complete TaskPlan and catalog contracts",
  );
  const invalidPlans = [
    { ...taskPlan, injected: "unknown" },
    { ...taskPlan, steps: [{ ...taskPlan.steps[0], injected: "unknown" }] },
    {
      ...taskPlan,
      steps: Array.from({ length: 7 }, (_, index) => ({
        ...taskPlan.steps[0],
        stepId: `step-${index}`,
      })),
      selectedCapabilities: Array.from({ length: 7 }, () => "safety.evaluate"),
    },
    {
      ...taskPlan,
      steps: [taskPlan.steps[1]],
      selectedCapabilities: ["vehicle.window.set-position"],
      writeActionCount: 1,
    },
    {
      ...taskPlan,
      selectedCapabilities: ["vehicle.window.set-position", "safety.evaluate"],
    },
    {
      ...taskPlan,
      steps: [
        ...taskPlan.steps,
        { ...taskPlan.steps[1], stepId: "window-2" },
      ],
      selectedCapabilities: [
        "safety.evaluate",
        "vehicle.window.set-position",
        "vehicle.window.set-position",
      ],
      writeActionCount: 2,
    },
    {
      ...taskPlan,
      steps: [
        taskPlan.steps[0],
        {
          ...taskPlan.steps[1],
          input: { zone: "driver", percent: "50" },
        },
      ],
    },
    {
      ...taskPlan,
      steps: [{
        ...taskPlan.steps[0],
        capabilityId: "manual.retrieve",
        input: { query: "车窗" },
      }],
      selectedCapabilities: ["manual.retrieve"],
      writeActionCount: 0,
    },
  ];
  for (const invalidPlan of invalidPlans) {
    assert.equal(
      getStructuredValidationFailure(planningBody, invalidPlan),
      "plan-contract-invalid",
      "plan validation should enforce TaskPlan shape, projection, dependencies, and safety",
    );
  }

  const unconfirmedBody = validSynthesisBody({
    completionStatus: "completed",
    toolResult: { executionState: "adapter-accepted", confirmedSnapshotId: "snapshot-1" },
    confirmedVehicleState: { id: "snapshot-1" },
  });
  assert.equal(
    getStructuredValidationFailure(unconfirmedBody, {
      response: "车窗已成功打开，但状态尚未确认。",
      writeCompletionStatus: "unconfirmed",
    }),
    "synthesis-unconfirmed-write-misstated",
    "adapter acceptance must not authorize a completion or success claim",
  );
  assert.equal(
    getStructuredValidationFailure(unconfirmedBody, {
      response: "车窗已经到位，但尚未确认。",
      writeCompletionStatus: "unconfirmed",
    }),
    "synthesis-unconfirmed-write-misstated",
    "unconfirmed writes must reject unsupported result-state synonyms",
  );
  assert.equal(
    getStructuredValidationFailure(unconfirmedBody, {
      response: "写入操作尚未确认完成。",
      writeCompletionStatus: "unconfirmed",
    }),
    "",
    "unconfirmed writes should accept only the conservative structured response",
  );
  assert.equal(
    getStructuredValidationFailure(safetyRejectedBody, {
      response: safetyRejectedResponse,
      writeCompletionStatus: "blocked",
    }),
    "",
    "an explicit Safety rejection should accept the bounded blocked response contract",
  );
  assert.equal(
    getStructuredValidationFailure(safetyRejectedBody, {
      response: "车窗已打开。",
      writeCompletionStatus: "blocked",
    }),
    "synthesis-safety-rejection-misstated",
    "a blocked response must not replace the authoritative Safety rejection with a success claim",
  );
  const safetyRejectedPrompt = buildResponseSynthesisPrompt({
    goalEnvelope,
    taskPlan,
    executionFacts: safetyRejectedBody.executionFacts,
  });
  assert.match(safetyRejectedPrompt, /writeCompletionStatus to "blocked"/);
  assert.match(safetyRejectedPrompt, new RegExp(safetyRejectedResponse));
  assert.doesNotMatch(safetyRejectedPrompt, /unconfirmed write|writeCompletionStatus to "unconfirmed"/i);
  assert.equal(
    getStructuredValidationFailure(validSynthesisBody({
      completionStatus: "completed",
      toolResult: { executionState: "observed-succeeded", confirmedSnapshotId: "" },
      confirmedVehicleState: { id: "" },
    }), { response: "车窗已打开。", writeCompletionStatus: "confirmed" }),
    "synthesis-completion-status-invalid",
    "an empty confirmed snapshot identifier must not authorize completion",
  );
  assert.equal(
    getStructuredValidationFailure(validSynthesisBody({
      completionStatus: "completed",
      toolResult: { executionState: "observed-succeeded", confirmedSnapshotId: "snapshot-1" },
      confirmedVehicleState: { id: "snapshot-2" },
    }), { response: "车窗操作成功。", writeCompletionStatus: "confirmed" }),
    "synthesis-completion-status-invalid",
    "a mismatched confirmed vehicle snapshot must not authorize completion",
  );
  assert.equal(
    getStructuredValidationFailure(validSynthesisBody({
      completionStatus: "completed",
      toolResult: { executionState: "observed-succeeded", confirmedSnapshotId: " snapshot-1 " },
      confirmedVehicleState: { id: "snapshot-1" },
    }), { response: "车窗已打开。", writeCompletionStatus: "confirmed" }),
    "synthesis-completion-status-invalid",
    "snapshot identifiers must match exactly, without whitespace normalization",
  );
  assert.equal(
    getStructuredValidationFailure(validSynthesisBody({
      completionStatus: "completed",
      toolResult: { executionState: "observed-succeeded", confirmedSnapshotId: "snapshot-1" },
      confirmedVehicleState: { id: "snapshot-1" },
    }), { response: "车窗已成功打开。", writeCompletionStatus: "confirmed" }),
    "",
    "matching observed-succeeded facts should authorize a completion claim",
  );
  assert.equal(
    getStructuredValidationFailure({
      ...validSynthesisBody(),
      taskPlan: {
        ...taskPlan,
        steps: [taskPlan.steps[0]],
        selectedCapabilities: ["safety.evaluate"],
        writeActionCount: 0,
      },
    }, { response: "只读安全检查已完成。", writeCompletionStatus: "not-applicable" }),
    "",
    "read-only synthesis should not be forced to describe a write as incomplete",
  );
  const readOnlyTaskPlan = {
    ...taskPlan,
    steps: [taskPlan.steps[0]],
    selectedCapabilities: ["safety.evaluate"],
    writeActionCount: 0,
  };
  const readOnlyPrompt = buildResponseSynthesisPrompt({
    goalEnvelope,
    taskPlan: readOnlyTaskPlan,
    executionFacts: validSynthesisBody().executionFacts,
  });
  assert.doesNotMatch(
    readOnlyPrompt,
    /尚未确认完成|当前仍未完成|写入操作/,
    "read-only synthesis prompt must not contain unconfirmed-write instructions or examples",
  );
  assert.match(
    readOnlyPrompt,
    /read-only|只读/i,
    "read-only synthesis prompt should use a neutral read-only constraint",
  );

  let repairCalls = 0;
  const repaired = await runStructuredOutputProtocol({
    body: { task: "b2_goal_formation" },
    initialResponse: JSON.stringify({ objective: goalEnvelope.objective }),
    repair: async (repairMetadata) => {
      repairCalls += 1;
      assert.deepEqual(Object.keys(repairMetadata).sort(), [
        "invalidOutputLength",
        "reasonCode",
        "schemaName",
        "validationSubreason",
      ]);
      return JSON.stringify(goalEnvelope);
    },
  });
  assert.equal(repaired.status, 200, "wrong-shape JSON should be repairable");
  assert.equal(repaired.structuredRetryCount, 1, "wrong-shape JSON should consume one repair");
  assert.equal(repairCalls, 1, "repair should run exactly once");
  assert.deepEqual(repaired.output, goalEnvelope, "repair should return the validated contract output");

  for (const [task, body, validOutput] of deterministicTaskCases) {
    const outcomes = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      outcomes.push(await runStructuredOutputProtocol({
        body,
        initialResponse: "{\"wrong\":\"shape\"}",
        repair: async () => JSON.stringify(validOutput),
      }));
    }
    assert.ok(outcomes.every((outcome) => outcome.status === 200), `${task}: repeated fixture status`);
    assert.ok(outcomes.every((outcome) => outcome.structuredRetryCount === 1),
      `${task}: repeated fixture must preserve the one-repair protocol`);
    assert.ok(outcomes.every((outcome) => JSON.stringify(outcome.output) === JSON.stringify(validOutput)),
      `${task}: repeated deterministic fixtures must produce the same contract output`);
  }

  const invalidRawOutput = "SECRET_MODEL_OUTPUT_WITHOUT_JSON";
  repairCalls = 0;
  const rejected = await runStructuredOutputProtocol({
    body: { task: "b2_goal_formation" },
    initialResponse: invalidRawOutput,
    repair: async (repairMetadata) => {
      repairCalls += 1;
      assert.equal(JSON.stringify(repairMetadata).includes("SECRET"), false);
      return "{\"maliciousSecretKey\":\"SECRET_REPAIR_OUTPUT\"}";
    },
  });
  assert.equal(rejected.status, 422, "a second invalid structured output should return 422");
  assert.equal(rejected.structuredRetryCount, 1, "a second invalid output must not add another retry");
  assert.equal(repairCalls, 1, "the structured protocol must perform at most one repair");
  assert.deepEqual(Object.keys(rejected).sort(), [
    "invalidOutputLength",
    "reasonCode",
    "schemaName",
    "status",
    "structuredRetryCount",
    "validationSubreason",
  ]);
  assert.equal(JSON.stringify(rejected).includes("SECRET"), false, "422 diagnostics must not leak raw model output");
  assert.equal(JSON.stringify(rejected).includes("maliciousSecretKey"), false, "422 diagnostics must not leak model keys");

  let timeoutProviderCalls = 0;
  let timeoutRepairCalls = 0;
  const timeoutProvider = {
    id: "fake-timeout-provider",
    model: "fake-timeout-model",
    async generate() {
      timeoutProviderCalls += 1;
      throw new ModelProviderError("fake structured generation timed out", {
        code: "generation-timeout",
        provider: "fake-timeout-provider",
        durationMs: 12_000,
        externalModelRequestCount: 1,
        details: { reasonCode: "generation-timeout", retryable: true },
      });
    },
  };
  const timeoutRegistry = {
    providerFor() { return timeoutProvider; },
    generateForTask(_task, request) { return timeoutProvider.generate(request); },
  };
  await assert.rejects(
    async () => {
      const initial = await callStructuredAgentGenerate({
        body: planningBody,
        prompt: "offline-timeout-test",
        registry: timeoutRegistry,
      });
      await runStructuredOutputProtocol({
        body: planningBody,
        initialResponse: initial.text,
        repair: async () => {
          timeoutRepairCalls += 1;
          return "{}";
        },
      });
    },
    (error) => {
      assert.equal(error.code, "generation-timeout");
      assert.equal(error.externalModelRequestCount, 1);
      return true;
    },
    "initial provider timeout must stay distinct from structured validation failure",
  );
  assert.equal(timeoutProviderCalls, 1, "timeout path must record one external generation attempt");
  assert.equal(timeoutRepairCalls, 0, "initial provider timeout must not enter structured repair");
}

// Structured B2 tasks run on per-task model profiles (see modelTaskForStructuredAgent on the
// server); the live expectation comes from the server's public profile, not this process's env.
const LIVE_MODEL_TASK_BY_STRUCTURED_TASK = Object.freeze({
  b2_goal_formation: "orchestrator_plan",
  b2_task_planning: "orchestrator_plan",
  b2_response_synthesis: "cabin_response",
});
let liveTaskProfiles = null;

async function loadLiveTaskProfiles() {
  const response = await fetch(`${baseUrl}/api/model-provider-profile`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `model provider profile returned HTTP ${response.status}`);
  liveTaskProfiles = (await response.json()).tasks;
}

function assertTelemetry(telemetry, label, structuredTask) {
  assert.ok(telemetry && typeof telemetry === "object", `${label}: telemetry should exist`);
  const profile = liveTaskProfiles?.[LIVE_MODEL_TASK_BY_STRUCTURED_TASK[structuredTask]];
  assert.ok(profile, `${label}: live task profile should exist for ${structuredTask}`);
  const primaryReady = profile.primaryReadiness?.status === "ready";
  if (primaryReady) {
    assert.equal(telemetry.provider, profile.provider, `${label}: telemetry.provider should report the task primary provider`);
    assert.notEqual(telemetry.fallbackActive, true, `${label}: a ready primary provider must not fall back`);
  } else {
    assert.equal(profile.fallbackConfigured, true, `${label}: an unavailable primary needs a configured fallback`);
    assert.equal(telemetry.fallbackActive, true, `${label}: an unavailable primary must report fallbackActive`);
    assert.equal(telemetry.provider, "ollama", `${label}: the fallback provider is local Ollama`);
  }
  assert.ok(typeof telemetry.model === "string" && telemetry.model.length > 0, `${label}: telemetry.model should exist`);
  assert.equal(typeof telemetry.durationMs, "number", `${label}: telemetry.durationMs should be a number`);
  assert.ok(telemetry.finishReason === null || typeof telemetry.finishReason === "string", `${label}: finishReason`);
  assert.ok(telemetry.usage && typeof telemetry.usage === "object", `${label}: usage should exist`);
  assert.equal(
    telemetry.degraded,
    !primaryReady,
    `${label}: telemetry.degraded must be true exactly when the task ran on its fallback`,
  );
  assert.equal(typeof telemetry.reason, "string", `${label}: telemetry.reason should be a string`);
  assert.equal(typeof telemetry.firstPassValid, "boolean", `${label}: firstPassValid should be a boolean`);
  assert.ok(
    telemetry.structuredRetryCount === 0 || telemetry.structuredRetryCount === 1,
    `${label}: structuredRetryCount should be zero or one`,
  );
}

function assertSafeResponse(body, label, structuredTask) {
  assert.ok(body.output && typeof body.output === "object" && !Array.isArray(body.output), `${label}: output should be an object`);
  assert.equal(Object.hasOwn(body, "prompt"), false, `${label}: response must not expose prompt`);
  assert.equal(Object.hasOwn(body, "chainOfThought"), false, `${label}: response must not expose chainOfThought`);
  assert.equal(Object.hasOwn(body.output, "prompt"), false, `${label}: output must not expose prompt`);
  assert.equal(Object.hasOwn(body.output, "chainOfThought"), false, `${label}: output must not expose chainOfThought`);
  assertTelemetry(body.telemetry, label, structuredTask);
}

async function postStructuredTask(label, payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawBody: text };
  }
  assert.ok(response.ok, `${label}: ${endpoint} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  assertSafeResponse(body, label, payload.task);
  return body;
}

async function main() {
  await verifyStructuredProtocol();
  if (process.argv.includes("--offline") || process.argv.includes("--protocol-only")) {
    console.log("B2 structured output offline verification passed");
    return;
  }
  await loadLiveTaskProfiles();

  const goal = await postStructuredTask("goal formation", {
    task: "b2_goal_formation",
    runId: "verify-b2-goal",
    rawText: "把主驾车窗打开一半",
    parsedCommand: {
      intent: "body.window.setPosition",
      speechAct: "command",
      slots: { zone: "driver", percent: 50 },
    },
    capabilityCatalog: [{ id: "vehicle.window.set-position", accessMode: "write" }],
  });
  assert.ok(
    typeof goal.output.objective === "string" && goal.output.objective.trim().length > 0,
    `goal formation: output.objective should be a non-empty string (output keys: ${Object.keys(goal.output).join(", ") || "none"})`,
  );

  // Vehicle command planning is only eligible with Vehicle-SLU plan authority.
  const livePlanningCatalog = getCapabilityCatalogProjection();
  const plan = await postStructuredTask("task planning", {
    task: "b2_task_planning",
    runId: windowPlanningFixture.goalEnvelope.runId,
    goalEnvelope: windowPlanningFixture.goalEnvelope,
    semanticAuthority: windowPlanningFixture.semanticAuthority,
    capabilityCatalog: livePlanningCatalog,
  });
  const allowedCapabilityIds = new Set(livePlanningCatalog.map((capability) => capability.id));
  const plannedCapabilityIds = [
    ...(Array.isArray(plan.output.selectedCapabilities) ? plan.output.selectedCapabilities : []),
    ...(Array.isArray(plan.output.steps) ? plan.output.steps.map((step) => step?.capabilityId) : []),
  ];
  assert.ok(plannedCapabilityIds.length > 0, "task planning: output should select at least one catalog capability");
  assert.equal(
    plannedCapabilityIds.every((id) => allowedCapabilityIds.has(id)),
    true,
    "task planning: output must contain catalog capability IDs only",
  );

  const synthesis = await postStructuredTask("response synthesis", {
    task: "b2_response_synthesis",
    runId: "verify-b2-synthesis",
    goalEnvelope,
    taskPlan,
    executionFacts: {
      runId: goalEnvelope.runId,
      goalId: goalEnvelope.goalId,
      planId: taskPlan.planId,
      stepResults: [{ stepId: "window", status: "awaiting-confirmation" }],
      evidenceRefs: [],
      safetyDecision: { allowed: true, confirmationRequired: true },
      toolResult: null,
      confirmedVehicleState: null,
      degraded: false,
      failureReason: "",
      completionStatus: "awaiting-confirmation",
    },
  });
  const synthesisText = JSON.stringify(synthesis.output);
  assert.match(
    synthesisText,
    /未完成|尚未完成|未确认|等待确认|待确认|not completed|unconfirmed/i,
    "response synthesis: an unconfirmed write must be described as not completed",
  );
  assert.doesNotMatch(
    synthesisText,
    /已完成|已经完成|已执行|已经执行|完成了/,
    "response synthesis: an unconfirmed write must not be presented as completed",
  );

  console.log(JSON.stringify({
    baseUrl,
    tasks: [
      { task: "b2_goal_formation", telemetry: goal.telemetry },
      { task: "b2_task_planning", telemetry: plan.telemetry },
      { task: "b2_response_synthesis", telemetry: synthesis.telemetry },
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(`verify-b2-agent-model-api failed: ${error.message}`);
  process.exitCode = 1;
});
