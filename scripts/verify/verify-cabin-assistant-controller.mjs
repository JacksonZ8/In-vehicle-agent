import assert from "node:assert/strict";
import {
  CabinAssistantController,
  renderVehicleStateResponse,
} from "../../src/agents/cabin-assistant-controller.js";
import {
  createExecutionFacts,
  createGoalEnvelope,
  createTaskPlan,
} from "../../src/agents/agent-contracts.js";
import { isTrustedKnowledgeGoal } from "../../src/agents/goal-authority.js";

const parsedCommand = Object.freeze({
  intent: "vehicle.ventilate",
  slots: { weather: "rain" },
});

const validGoalOutput = {
  goalId: "goal:run-1",
  runId: "run-1",
  objective: "在下雨约束下改善车内通风",
  interactionType: "command",
  domain: "vehicle-control",
  constraints: ["outside-raining"],
  contextRefs: [],
  requiredClarifications: [],
  readyForPlanning: true,
  model: "qwen2.5:7b",
  provider: "ollama",
  confidenceStrength: "strong",
};

function createFakeModel(handlers = {}) {
  return {
    calls: [],
    async formGoal(input) {
      this.calls.push({ method: "formGoal", input });
      return handlers.formGoal?.(input) ?? {
        output: validGoalOutput,
        telemetry: {
          model: "qwen2.5:7b",
          provider: "ollama",
          durationMs: 12,
          degraded: false,
          reason: "",
          structuredRetryCount: 0,
          rawPrompt: "must-not-leak",
        },
      };
    },
    async synthesizeAgentResponse(input) {
      this.calls.push({ method: "synthesizeAgentResponse", input });
      return handlers.synthesizeAgentResponse?.(input) ?? {
        output: { response: "写入操作尚未确认完成。", writeCompletionStatus: "unconfirmed" },
        telemetry: {
          model: "qwen2.5:7b",
          provider: "ollama",
          durationMs: 9,
          degraded: false,
          structuredRetryCount: 0,
          tokenCount: 999,
        },
      };
    },
    async respondForeground(input) {
      this.calls.push({ method: "respondForeground", input });
      return handlers.respondForeground?.(input) ?? {
        output: { response: "我先回应开放对话，车辆请求仍在处理中。" },
        telemetry: { model: "qwen2.5:7b", provider: "ollama", durationMs: 3, degraded: false },
      };
    },
  };
}

const fakeModel = createFakeModel();
const controller = new CabinAssistantController({ modelAdapter: fakeModel });
assert.equal(renderVehicleStateResponse({
  stateFields: ["speedKph", "gear"],
  vehicleStateSnapshot: { values: { speedKph: 42, gear: "D", cabinTemperature: 21 } },
}), "当前车辆状态：speedKph=42，gear=D。");
const result = await controller.formGoal({
  runId: "run-1",
  rawText: "有点闷，帮我通风，但外面正在下雨。",
  parsedCommand,
  context: { memoryRefs: [] },
});
assert.equal(result.goalEnvelope.objective, "在下雨约束下改善车内通风");
assert.equal(result.goalEnvelope.readyForPlanning, true);
assert.equal(result.clarificationRequest, null);
assert.equal(fakeModel.calls.length, 1);
assert.equal(fakeModel.calls[0].method, "formGoal");
assert.equal(JSON.stringify(fakeModel.calls).includes("vehicleTools"), false);
assert.deepEqual(result.telemetry, {
  model: "qwen2.5:7b",
  provider: "ollama",
  durationMs: 12,
  degraded: false,
  reason: "",
  structuredRetryCount: 0,
});
assert.equal(Object.isFrozen(result.telemetry), true);

const clarificationModel = createFakeModel({
  formGoal: () => ({
    output: {
      runId: "run-2",
      goalId: "goal:run-2",
      questions: ["您希望打开哪一侧车窗？"],
      reasonCode: "missing-window-zone",
      model: "qwen2.5:7b",
      provider: "ollama",
    },
    telemetry: { model: "qwen2.5:7b", provider: "ollama", durationMs: 4, degraded: false },
  }),
});
const clarification = await new CabinAssistantController({ modelAdapter: clarificationModel }).formGoal({
  runId: "run-2",
  rawText: "打开车窗",
  parsedCommand,
  context: {},
});
assert.equal(clarification.goalEnvelope, null);
assert.deepEqual(clarification.clarificationRequest.questions, ["您希望打开哪一侧车窗？"]);

const notReadyGoalModel = createFakeModel({
  formGoal: () => ({
    output: {
      ...validGoalOutput,
      goalId: "goal:run-3",
      runId: "run-3",
      requiredClarifications: ["您希望打开哪一侧车窗？"],
      readyForPlanning: false,
      confidenceStrength: "weak",
    },
    telemetry: { model: "qwen2.5:7b", provider: "ollama", degraded: false },
  }),
});
const notReadyGoal = await new CabinAssistantController({ modelAdapter: notReadyGoalModel }).formGoal({
  runId: "run-3",
  rawText: "打开车窗",
  parsedCommand,
  context: {},
});
assert.equal(notReadyGoal.goalEnvelope, null);
assert.deepEqual(notReadyGoal.clarificationRequest.questions, ["您希望打开哪一侧车窗？"]);
assert.equal(notReadyGoal.clarificationRequest.reasonCode, "goal-requires-clarification");

const knowledgeParsedCommand = {
  intent: "conversation.general",
  speechAct: "report",
  slots: { topic: "vehicle_knowledge" },
  conversationGoal: {
    interactionType: "explain",
    domain: "vehicle_knowledge",
    goal: "ES8 尾门现在是否满足开启条件",
  },
};
const trustedKnowledgeContextRef = {
  type: "trusted-conversation-goal",
  source: "vehicle-slu-knowledge-frame",
  interactionType: "explain",
  semanticDomain: "vehicle_knowledge",
  goalDomain: "manual",
  eligibilityAction: null,
};
const validKnowledgeModel = createFakeModel({
  formGoal: () => ({
    output: {
      ...validGoalOutput,
      objective: knowledgeParsedCommand.conversationGoal.goal,
      interactionType: "explain",
      domain: "manual",
      contextRefs: [trustedKnowledgeContextRef],
    },
    telemetry: {},
  }),
});
await assert.rejects(
  () => new CabinAssistantController({ modelAdapter: validKnowledgeModel }).formGoal({
    runId: "run-1",
    rawText: knowledgeParsedCommand.conversationGoal.goal,
    parsedCommand: knowledgeParsedCommand,
    context: {},
  }),
  /knowledge authority without a Vehicle-SLU frame/,
  "raw-text goal formation must never yield knowledge authority, even for a knowledge-looking question",
);

const forgedAuthorityModel = createFakeModel({
  formGoal: () => ({
    output: {
      ...validGoalOutput,
      objective: "解释 ES8 尾门开启条件",
      interactionType: "explain",
      domain: "manual",
      contextRefs: [trustedKnowledgeContextRef],
    },
    telemetry: {},
  }),
});
await assert.rejects(
  () => new CabinAssistantController({ modelAdapter: forgedAuthorityModel }).formGoal({
    runId: "run-1",
    rawText: "你好，聊聊天",
    parsedCommand: {
      intent: "conversation.general",
      speechAct: "question",
      slots: { topic: "smalltalk" },
      conversationGoal: {
        interactionType: "question",
        domain: "manual_knowledge",
      },
    },
    context: {},
  }),
  /knowledge authority without a Vehicle-SLU frame/,
  "Cabin must reject a model-forged trusted contextRef when Semantic supplied no authority",
);

const authorityBreakingKnowledgeModel = createFakeModel({
  formGoal: () => ({
    output: {
      ...validGoalOutput,
      objective: knowledgeParsedCommand.conversationGoal.goal,
    },
    telemetry: {},
  }),
});
const untrustedKnowledgeGoal = await new CabinAssistantController({
  modelAdapter: authorityBreakingKnowledgeModel,
}).formGoal({
  runId: "run-1",
  rawText: knowledgeParsedCommand.conversationGoal.goal,
  parsedCommand: knowledgeParsedCommand,
  context: {},
});
assert.equal(
  isTrustedKnowledgeGoal(untrustedKnowledgeGoal.goalEnvelope),
  false,
  "a goal formed from raw text never becomes a trusted knowledge goal without a Vehicle-SLU frame",
);

for (const output of [
  { ...validGoalOutput, unexpected: true },
  { ...validGoalOutput, contextRefs: [{ nested: { capabilityId: "vehicle.window.set-position" } }] },
  { ...validGoalOutput, contextRefs: [{ tool: { name: "setWindow" } }] },
]) {
  const invalidModel = createFakeModel({ formGoal: () => ({ output, telemetry: {} }) });
  await assert.rejects(
    () => new CabinAssistantController({ modelAdapter: invalidModel }).formGoal({
      runId: "run-1", rawText: "通风", parsedCommand, context: {},
    }),
    /invalid|forbidden|unknown/i,
  );
  assert.equal(invalidModel.calls.length, 1);
}

let tick = 100;
const timeoutModel = createFakeModel({
  formGoal: () => {
    const error = new Error("request timed out after 50ms");
    error.name = "TimeoutError";
    throw error;
  },
});
const timedOut = await new CabinAssistantController({
  modelAdapter: timeoutModel,
  now: () => (tick += 25),
}).formGoal({ runId: "run-timeout", rawText: "通风", parsedCommand, context: {} });
assert.equal(timedOut.goalEnvelope, null);
assert.equal(timedOut.clarificationRequest, null);
assert.equal(timedOut.degraded, true);
assert.equal(timedOut.telemetry.reason, "model-timeout");
assert.equal(timedOut.telemetry.durationMs, 25);

const goalEnvelope = createGoalEnvelope(validGoalOutput);
const taskPlan = createTaskPlan({
  planId: "plan:run-1",
  goalId: goalEnvelope.goalId,
  runId: goalEnvelope.runId,
  steps: [{
    stepId: "step-1",
    capabilityId: "vehicle.window.set-position",
    dependsOn: [],
    input: { zone: "driver", percent: 50 },
    expectedOutput: "provider-confirmed-window-position",
    accessMode: "write",
    status: "planned",
  }],
  selectedCapabilities: ["vehicle.window.set-position"],
  planningSummary: "设置主驾车窗。",
  model: "qwen2.5:7b",
  provider: "ollama",
  status: "planned",
});
const unconfirmedFacts = createExecutionFacts({
  runId: goalEnvelope.runId,
  goalId: goalEnvelope.goalId,
  planId: taskPlan.planId,
  stepResults: [{ stepId: "step-1", status: "adapter-accepted" }],
  evidenceRefs: [],
  safetyDecision: { allowed: true },
  toolResult: { executionState: "adapter-accepted" },
  confirmedVehicleState: null,
  degraded: false,
  failureReason: "",
  completionStatus: "incomplete",
});

const synthesis = await controller.synthesize({ goalEnvelope, taskPlan, executionFacts: unconfirmedFacts });
assert.equal(synthesis.text, "写入操作尚未确认完成。");
assert.equal(synthesis.text.includes("已完成"), false);
assert.equal(synthesis.degraded, false);
assert.equal(Object.hasOwn(synthesis.telemetry, "tokenCount"), false);

const safetyRejectedFacts = createExecutionFacts({
  ...unconfirmedFacts,
  stepResults: [{
    stepId: "step-1",
    capabilityId: "vehicle.window.set-position",
    status: "blocked",
    failureReason: "safety-rejected",
  }],
  safetyDecision: {
    allowed: false,
    action: "reject",
    reason: "当前防夹状态不满足要求",
  },
  toolResult: null,
  degraded: false,
  failureReason: "",
  completionStatus: "completed",
});
const safetyRejectedModel = createFakeModel({
  synthesizeAgentResponse: () => ({
    output: {
      response: "当前操作未通过安全校验：当前防夹状态不满足要求",
      writeCompletionStatus: "blocked",
    },
    telemetry: { model: "qwen2.5:7b", provider: "ollama", durationMs: 2, degraded: false },
  }),
});
const safetyRejectedSynthesis = await new CabinAssistantController({
  modelAdapter: safetyRejectedModel,
}).synthesize({
  goalEnvelope,
  taskPlan,
  executionFacts: safetyRejectedFacts,
});
assert.equal(safetyRejectedSynthesis.degraded, false);
assert.match(safetyRejectedSynthesis.text, /未通过安全校验/);
assert.match(safetyRejectedSynthesis.text, /防夹状态不满足要求/);
assert.doesNotMatch(safetyRejectedSynthesis.text, /已.*(?:打开|完成)|成功/);

for (const safetyDecision of [
  null,
  { allowed: false },
  { allowed: false, action: "require_confirmation", reason: "需要确认" },
]) {
  const nonRejectFacts = createExecutionFacts({
    ...unconfirmedFacts,
    safetyDecision,
  });
  const nonRejectSynthesis = await controller.synthesize({
    goalEnvelope,
    taskPlan,
    executionFacts: nonRejectFacts,
  });
  assert.equal(
    nonRejectSynthesis.text,
    "写入操作尚未确认完成。",
    "missing, unknown, and confirmation-required Safety outcomes must not be presented as explicit rejection",
  );
}

const lyingModel = createFakeModel({
  synthesizeAgentResponse: () => ({
    output: { response: "车窗已经打开。", writeCompletionStatus: "confirmed" },
    telemetry: { model: "qwen2.5:7b", provider: "ollama", durationMs: 1, degraded: false },
  }),
});
const refusedUpgrade = await new CabinAssistantController({ modelAdapter: lyingModel }).synthesize({
  goalEnvelope,
  taskPlan,
  executionFacts: unconfirmedFacts,
});
assert.equal(refusedUpgrade.degraded, true);
assert.equal(refusedUpgrade.text, "写入操作尚未确认完成。");
assert.equal(refusedUpgrade.text.includes("已经打开"), false);

const lyingForegroundModel = createFakeModel({
  respondForeground: () => ({
    output: { response: "副驾车窗已经打开到一半。" },
    telemetry: { model: "qwen2.5:7b", provider: "ollama", durationMs: 1, degraded: false },
  }),
});
const refusedForegroundClaim = await new CabinAssistantController({
  modelAdapter: lyingForegroundModel,
}).respondForeground({
  conversationGoal: { summary: "聊聊旅行，同时调整副驾车窗", requiresReply: true },
  pendingFrameIds: ["frame-window"],
  executionDisabled: false,
});
assert.equal(refusedForegroundClaim.text, "我先回应你的开放话题，车内请求正在处理中。");
assert.equal(refusedForegroundClaim.degraded, false,
  "deterministic foreground rendering follows model telemetry, not response wording");
assert.equal(refusedForegroundClaim.text.includes("副驾车窗已经打开"), false);
const foregroundCall = lyingForegroundModel.calls.find((call) => call.method === "respondForeground");
assert.deepEqual(Object.keys(foregroundCall.input).sort(), [
  "conversationGoal", "executionDisabled", "pendingFrameIds",
]);
assert.equal(JSON.stringify(foregroundCall.input).includes("rawText"), false);
assert.equal(JSON.stringify(foregroundCall.input).includes("tool"), false);
assert.equal(JSON.stringify(foregroundCall.input).includes("capability"), false);

for (const modelText of [
  "当前车速是 42 km/h。",
  "挡位为 D。",
  "副驾侧窗降好了。",
  "电池电量还有80%。",
  "旅行时我喜欢打开车窗吹风。",
]) {
  const stateClaimModel = createFakeModel({
    respondForeground: () => ({ output: { response: modelText }, telemetry: { degraded: false } }),
  });
  const result = await new CabinAssistantController({ modelAdapter: stateClaimModel }).respondForeground({
    conversationGoal: { summary: "聊聊旅行", requiresReply: true },
    pendingFrameIds: ["frame-window"],
    executionDisabled: false,
  });
  assert.equal(result.text, "我先回应你的开放话题，车内请求正在处理中。");
  assert.equal(result.text.includes(modelText), false, `foreground must never relay model free text: ${modelText}`);
  assert.equal(result.degraded, false, "safe deterministic rendering must not blacklist normal model wording");
}
const degradedForegroundModel = createFakeModel({
  respondForeground: () => ({
    output: { response: "任意模型自由文本" },
    telemetry: { provider: "ollama", degraded: true, reason: "model-degraded" },
  }),
});
const degradedForeground = await new CabinAssistantController({
  modelAdapter: degradedForegroundModel,
}).respondForeground({
  conversationGoal: { summary: "聊聊旅行", requiresReply: true },
  pendingFrameIds: ["frame-window"],
  executionDisabled: false,
});
assert.equal(degradedForeground.text, "我先回应你的开放话题，车内请求正在处理中。");
assert.equal(degradedForeground.degraded, true);
assert.equal(degradedForeground.telemetry.reason, "model-degraded");

const contradictoryFacts = createExecutionFacts({
  ...unconfirmedFacts,
  toolResult: {
    executionState: "observed-succeeded",
    confirmedSnapshotId: "snapshot-1",
  },
  confirmedVehicleState: { id: "snapshot-1" },
  completionStatus: "incomplete",
});
const contradictoryModel = createFakeModel({
  synthesizeAgentResponse: () => ({
    output: { response: "车窗已经打开。", writeCompletionStatus: "confirmed" },
    telemetry: { model: "qwen2.5:7b", provider: "ollama", durationMs: 1, degraded: false },
  }),
});
const contradictoryResult = await new CabinAssistantController({ modelAdapter: contradictoryModel }).synthesize({
  goalEnvelope,
  taskPlan,
  executionFacts: contradictoryFacts,
});
assert.equal(contradictoryResult.degraded, true);
assert.match(contradictoryResult.text, /尚未确认完成/);
assert.equal(contradictoryResult.text.includes("已经打开"), false);

const failedFacts = createExecutionFacts({
  ...unconfirmedFacts,
  degraded: true,
  failureReason: "Provider 未返回确认状态",
});
const failingSynthesisModel = createFakeModel({
  synthesizeAgentResponse: () => { throw new Error("model unavailable"); },
});
const fallback = await new CabinAssistantController({ modelAdapter: failingSynthesisModel }).synthesize({
  goalEnvelope,
  taskPlan,
  executionFacts: failedFacts,
});
assert.equal(fallback.degraded, true);
assert.equal(fallback.text, "抱歉，暂时无法完成：Provider 未返回确认状态。");
assert.equal(JSON.stringify(fallback).includes("model unavailable"), false);

const knowledgeClarificationFallback = await new CabinAssistantController({ modelAdapter: failingSynthesisModel }).synthesize({
  goalEnvelope,
  taskPlan,
  executionFacts: unconfirmedFacts,
  knowledgeResult: {
    delegationId: "delegation:run-1:knowledge", runId: "run-1", outcomeStatus: "clarification",
    questions: ["请说明您想了解尾门功能还是当前开启资格。"], reasonCode: "knowledge-goal-ambiguous",
    model: "test", provider: "test",
  },
});
assert.equal(knowledgeClarificationFallback.text, "请说明您想了解尾门功能还是当前开启资格。");
assert.equal(knowledgeClarificationFallback.text.includes("尚未确认"), false);

let knowledgeBypassCalls = 0;
const knowledgeBypassModel = createFakeModel({
  synthesizeAgentResponse: () => {
    knowledgeBypassCalls += 1;
    return { output: { response: "模型试图改写 Safety 结论。", writeCompletionStatus: "not-applicable" }, telemetry: {} };
  },
});
const knowledgeAuthorityResponse = await new CabinAssistantController({
  modelAdapter: knowledgeBypassModel,
}).synthesize({
  goalEnvelope,
  taskPlan,
  executionFacts: unconfirmedFacts,
  knowledgeResult: {
    delegationId: "delegation:run-1:knowledge", runId: "run-1", outcomeStatus: "answered",
    supportStatus: "supported", answer: "根据 Safety 评估，当前不满足开启条件。",
    evidenceRefs: [{ id: "manual:tailgate" }], vehicleStateRefs: [{ snapshotId: "provider-1" }],
    safetyAssessmentRef: { allowed: false, action: "reject" }, limitations: [],
    model: "test", provider: "test", durationMs: 1, degraded: false,
  },
});
assert.equal(knowledgeAuthorityResponse.text, "根据 Safety 评估，当前不满足开启条件。");
assert.equal(knowledgeBypassCalls, 0, "Cabin Assistant must relay validated knowledge result without model rewrite");

await assert.rejects(
  () => controller.synthesize({
    goalEnvelope: { ...goalEnvelope, objective: "" },
    taskPlan,
    executionFacts: unconfirmedFacts,
  }),
  /objective/,
);
await assert.rejects(
  () => controller.synthesize({
    goalEnvelope,
    taskPlan: { ...taskPlan, unknown: true },
    executionFacts: unconfirmedFacts,
  }),
  /unknown field/,
);
await assert.rejects(
  () => controller.synthesize({
    goalEnvelope,
    taskPlan,
    executionFacts: { ...unconfirmedFacts, adapterAcceptance: true },
  }),
  /forbidden field/,
);

for (const mismatchedInput of [
  {
    goalEnvelope,
    taskPlan: { ...taskPlan, runId: "run-other" },
    executionFacts: unconfirmedFacts,
  },
  {
    goalEnvelope,
    taskPlan: { ...taskPlan, goalId: "goal:other" },
    executionFacts: unconfirmedFacts,
  },
  {
    goalEnvelope,
    taskPlan,
    executionFacts: { ...unconfirmedFacts, runId: "run-other" },
  },
  {
    goalEnvelope,
    taskPlan,
    executionFacts: { ...unconfirmedFacts, goalId: "goal:other" },
  },
  {
    goalEnvelope,
    taskPlan,
    executionFacts: { ...unconfirmedFacts, planId: "plan:other" },
  },
]) {
  const mismatchModel = createFakeModel();
  await assert.rejects(
    () => new CabinAssistantController({ modelAdapter: mismatchModel }).synthesize(mismatchedInput),
    /contract identifiers must match/,
  );
  assert.equal(mismatchModel.calls.length, 0);
}

console.log("cabin assistant controller verification passed");
