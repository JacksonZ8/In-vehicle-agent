import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { CloudLLMAdapter } from "../../src/runtime/cloud-llm-adapter.js";
import { getCapabilityCatalogProjection } from "../../src/agents/capability-catalog.js";
import { resolveModelProviderConnections } from "../../src/server/model-providers/model-provider-config.js";
import { ModelProviderError } from "../../src/server/model-providers/model-provider-contract.js";
import { createModelProviderRegistry } from "../../src/server/model-providers/model-provider-registry.js";
import { resolveModelTaskProfiles } from "../../src/server/model-providers/model-task-profile.js";
import { PLANNING_TEMPLATE_RENDERER_CAPABILITY } from "../../src/runtime/planning-renderer-contract.js";
const previousPlanningSummaryMode = process.env.NIO_LLM_PLANNING_SUMMARY_MODE;
process.env.NIO_LLM_PLANNING_SUMMARY_MODE = "template";
const localAgentServer = await import("../../src/server/local-agent-server.mjs");
const {
  buildStructuredAgentJsonSchema,
  callStructuredAgentGenerate,
  composeWeatherResponse,
  createServer,
} = localAgentServer;
if (previousPlanningSummaryMode === undefined) delete process.env.NIO_LLM_PLANNING_SUMMARY_MODE;
else process.env.NIO_LLM_PLANNING_SUMMARY_MODE = previousPlanningSummaryMode;

assert.equal(Object.hasOwn(localAgentServer, "callOllamaGenerate"), false,
  "the raw Ollama transport helper must not remain a public test hook");
const serverSource = await readFile(
  new URL("../../src/server/local-agent-server.mjs", import.meta.url),
  "utf8",
);
const warmupSource = serverSource.match(
  /async function warmOllamaModels\(\) \{[\s\S]*?\n}\n\nasync function warmManualRagRuntime/,
)?.[0] || "";
assert.ok(warmupSource, "startup Ollama transport warmup must remain inspectable");
assert.equal((serverSource.match(/\bcallOllamaGenerate\s*\(/g) || []).length, 2,
  "raw Ollama transport calls must be limited to the helper definition and startup warmup");
assert.equal((warmupSource.match(/\bcallOllamaGenerate\s*\(/g) || []).length, 1,
  "startup warmup must be the raw Ollama helper's only caller");

function createDashScopeFetch() {
  const fetchImpl = async () => {
    fetchImpl.calls += 1;
    return new Response(JSON.stringify({
      choices: [{
        message: { content: "{\"relation\":\"follow-up\",\"reasonCode\":\"same-goal\",\"requiresClarification\":false}" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  fetchImpl.calls = 0;
  return fetchImpl;
}

class FakeRequest extends EventEmitter {
  constructor(body, headers = {}) {
    super();
    this.method = "POST";
    this.url = "/api/local-llm";
    this.body = JSON.stringify(body);
    this.headers = { ...headers };
    this.aborted = false;
    this.destroyed = false;
  }

  send() {
    this.emit("data", Buffer.from(this.body));
    this.emit("end");
  }
}

class FakeResponse extends EventEmitter {
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

async function postToServer(server, body, { headers = {} } = {}) {
  const request = new FakeRequest(body, headers);
  const response = new FakeResponse();
  const pending = server.listeners("request")[0](request, response);
  request.send();
  await pending;
  return response;
}

function createTaskRegistry(taskProviders, {
  taskCalls = [],
  watchdogMsByTask = {},
  publicProfiles = {},
} = {}) {
  const requireProvider = (task) => {
    const provider = taskProviders[task];
    assert.ok(provider, `test registry is missing explicit task ${task}`);
    return provider;
  };
  return Object.freeze({
    providerFor: requireProvider,
    profileFor(task) {
      const provider = requireProvider(task);
      return Object.freeze({
        task,
        provider: provider.id,
        model: provider.model,
        watchdogMs: watchdogMsByTask[task] ?? null,
      });
    },
    async generateForTask(task, request) {
      taskCalls.push(task);
      return requireProvider(task).generate(request);
    },
    publicProfiles: Object.freeze(publicProfiles),
  });
}

const dashScopeFetch = createDashScopeFetch();
const unavailableOllamaClient = Object.freeze({
  async generate() {
    throw new Error("injected Ollama fallback failure");
  },
});
const dashScopeConnections = resolveModelProviderConnections({
  NIO_LLM_PROVIDER: "dashscope",
  DASHSCOPE_API_KEY: "fake-secret-for-test",
}, {
  ollamaClient: unavailableOllamaClient,
});
const registry = createModelProviderRegistry({
  taskProfiles: resolveModelTaskProfiles({ NIO_LLM_PROVIDER: "dashscope", NIO_VEHICLE_SLU_PROFILE: "cloud-dashscope" }),
  connections: dashScopeConnections,
  fetchImpl: dashScopeFetch,
});
const vehicleSluProvider = registry.providerFor("vehicle_slu");
assert.equal(vehicleSluProvider.id, "dashscope");
assert.equal(JSON.stringify(registry.publicProfiles).includes("fake-secret-for-test"), false);

const generated = await registry.generateForTask("vehicle_slu", {
  requestId: "ready",
  task: "b3_turn_relation",
  prompt: "Return JSON",
  outputMode: "json-object",
  generationProfile: "structured-agent",
  timeoutMs: 12_000,
});
assert.equal(generated.provider, "dashscope");
assert.equal(generated.fallbackActive, false);
assert.equal(dashScopeFetch.calls, 1);
assert.equal(generated.externalModelRequestCount, 1,
  "one real DashScope upstream fetch attempt must be exposed as one bounded external call");

const blockedFetch = createDashScopeFetch();
const blockedConnections = resolveModelProviderConnections(
  { NIO_LLM_PROVIDER: "dashscope" },
  { ollamaClient: unavailableOllamaClient },
);
const blocked = createModelProviderRegistry({
  taskProfiles: resolveModelTaskProfiles({ NIO_LLM_PROVIDER: "dashscope" }),
  connections: blockedConnections,
  fetchImpl: blockedFetch,
});
await assert.rejects(
  blocked.generateForTask("vehicle_slu", {
    requestId: "blocked",
    task: "b2_goal_formation",
    prompt: "Return JSON",
    outputMode: "json-object",
    generationProfile: "structured-agent",
    timeoutMs: 12_000,
  }),
  (error) => error?.code === "generation-unavailable"
    && error?.provider === "ollama"
    && error?.externalModelRequestCount === 1,
);
assert.equal(blockedFetch.calls, 0,
  "a blocked DashScope primary must not fetch before the configured Ollama fallback is attempted");

const unknown = createModelProviderRegistry({
  taskProfiles: Object.freeze({
    vehicle_slu: Object.freeze({
      task: "vehicle_slu",
      provider: "untrusted-provider",
      model: "untrusted-model",
      watchdogMs: null,
    }),
  }),
  connections: Object.freeze({}),
  fetchImpl: blockedFetch,
});
await assert.rejects(
  unknown.generateForTask("vehicle_slu", { prompt: "Return JSON" }),
  (error) => error?.code === "provider-config-invalid" && error?.provider === "untrusted-provider",
);
assert.equal(blockedFetch.calls, 0, "unknown provider must not fall back to a configured implementation");

await assert.rejects(
  registry.generateForTask("unknown-task", { prompt: "Return JSON" }),
  (error) => error?.code === "provider-config-invalid",
);

const injectedSeventhTask = "injected_seventh_task";
const injectedSeventhTaskRegistry = createModelProviderRegistry({
  taskProfiles: Object.freeze({
    ...resolveModelTaskProfiles({ NIO_LLM_PROVIDER: "dashscope" }),
    [injectedSeventhTask]: Object.freeze({
      task: injectedSeventhTask,
      provider: "dashscope",
      model: "qwen-plus",
      watchdogMs: null,
    }),
  }),
  connections: dashScopeConnections,
  fetchImpl: dashScopeFetch,
});
assert.throws(
  () => injectedSeventhTaskRegistry.providerFor(injectedSeventhTask),
  (error) => error?.code === "provider-config-invalid",
  "an injected profile must not extend the fixed six model task IDs",
);

const mixedEnvironment = {
  NIO_LLM_PROVIDER: "ollama",
  NIO_VEHICLE_SLU_PROFILE: "cloud-dashscope",
  NIO_VEHICLE_SLU_PROVIDER: "dashscope",
  NIO_VEHICLE_SLU_MODEL: "qwen3.5-flash",
  DASHSCOPE_API_KEY: "mixed-provider-secret",
};
const mixedConnections = resolveModelProviderConnections(mixedEnvironment, {
  ollamaClient: unavailableOllamaClient,
});
const mixedRegistry = createModelProviderRegistry({
  taskProfiles: resolveModelTaskProfiles(mixedEnvironment),
  connections: mixedConnections,
  fetchImpl: dashScopeFetch,
});
assert.equal(mixedRegistry.providerFor("vehicle_slu").id, "dashscope");
assert.equal(mixedRegistry.providerFor("vehicle_slu").model, "qwen3.5-flash");
assert.equal(mixedRegistry.providerFor("orchestrator_plan").id, "dashscope");
assert.equal(mixedRegistry.providerFor("orchestrator_plan").model, "qwen-plus");
assert.deepEqual(Object.keys(mixedConnections.ollama).sort(), ["client", "readiness"]);
assert.deepEqual(Object.keys(mixedConnections.dashscope).sort(), ["baseUrl", "readiness"]);
assert.equal(Object.hasOwn(mixedConnections.ollama, "model"), false);
assert.equal(Object.hasOwn(mixedConnections.dashscope, "model"), false);
assert.equal(Object.getOwnPropertyDescriptor(mixedConnections.dashscope, "apiKey")?.enumerable, false);
assert.equal(JSON.stringify(mixedRegistry).includes("mixed-provider-secret"), false);
assert.equal(JSON.stringify(mixedRegistry).includes("compatible-mode"), false);

const taskBodies = [
  { task: "b2_goal_formation", requestId: "route-goal" },
  { task: "b2_task_planning", runId: "route-plan" },
  { task: "b2_response_synthesis", turnId: "route-synthesis" },
  { task: "b3_turn_relation", requestId: "route-relation" },
  { task: "b3_vehicle_knowledge_planning", runId: "route-knowledge-plan" },
  { task: "b3_vehicle_knowledge_synthesis", runId: "route-knowledge-answer" },
  { task: "b3_recovery_proposal", runId: "route-recovery" },
];
const captured = [];
const capturedModelTasks = [];
const fakeProvider = Object.freeze({
  id: "dashscope",
  model: "trusted-model",
  async generate(request) {
    captured.push(request);
    return {
      text: "{}",
      provider: "dashscope",
      model: "trusted-model",
      durationMs: 4,
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, cachedInputTokens: null },
    };
  },
});

for (const taskBody of taskBodies) {
  const body = {
    ...taskBody,
    provider: "ollama",
    model: "attacker-model",
    baseUrl: "https://attacker.invalid/v1",
    timeoutMs: 1,
    jsonSchema: { type: "string" },
    generationProfile: "default",
  };
  await callStructuredAgentGenerate({
    body,
    prompt: "trusted-prompt",
    registry: createTaskRegistry({
      orchestrator_plan: fakeProvider,
      cabin_response: fakeProvider,
      knowledge_answer: fakeProvider,
    }, { taskCalls: capturedModelTasks }),
  });
  const request = captured.at(-1);
  assert.equal(request.requestId, body.requestId || body.runId || body.turnId || "structured-agent");
  assert.equal(request.task, body.task);
  assert.equal(request.prompt, "trusted-prompt");
  assert.equal(request.outputMode, "json-object");
  assert.deepEqual(request.jsonSchema, buildStructuredAgentJsonSchema(body));
  assert.equal(request.generationProfile, "structured-agent");
  assert.equal(Object.hasOwn(request, "timeoutMs"), false);
  assert.equal(Object.hasOwn(request, "model"), false);
  assert.equal(Object.hasOwn(request, "baseUrl"), false);
}
assert.equal(captured.length, 7, "all seven structured tasks must use the Provider boundary");
assert.deepEqual(capturedModelTasks, [
  "orchestrator_plan",
  "orchestrator_plan",
  "cabin_response",
  "orchestrator_plan",
  "orchestrator_plan",
  "knowledge_answer",
  "orchestrator_plan",
]);

const routedCalls = [];
const injectedRegistry = createTaskRegistry({
  orchestrator_plan: Object.freeze({
    id: "dashscope",
    model: "trusted-model",
    async generate(request) {
      routedCalls.push(request);
      return {
        text: JSON.stringify({
          relation: "follow-up",
          reasonCode: "same-goal",
          requiresClarification: false,
        }),
        provider: "dashscope",
        model: "trusted-model",
        durationMs: 7,
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13, cachedInputTokens: 0 },
        externalModelRequestCount: 1,
      };
    },
  }),
}, { watchdogMsByTask: { orchestrator_plan: 12_000 } });
const routedResponse = await postToServer(createServer({ modelProviderRegistry: injectedRegistry }), {
  task: "b3_turn_relation",
  requestId: "route-server",
  currentGoalSummary: "车窗控制",
  rawText: "再开一点",
  provider: "ollama",
  model: "attacker-model",
  timeoutMs: 1,
  generationProfile: "default",
});
assert.equal(routedResponse.status, 200);
assert.equal(routedCalls.length, 1);
assert.equal(Object.hasOwn(routedCalls[0], "timeoutMs"), false);
assert.equal(routedCalls[0].generationProfile, "structured-agent");
assert.deepEqual(routedResponse.body.telemetry, {
  provider: "dashscope",
  model: "trusted-model",
  durationMs: 7,
  finishReason: "stop",
  usage: {
    inputTokens: 8,
    outputTokens: 5,
    totalTokens: 13,
    cachedInputTokens: 0,
    unavailableReason: null,
  },
  structuredRetryCount: 0,
  firstPassValid: true,
  degraded: false,
  reason: "structured-output-valid",
  externalModelRequestCount: 1,
});

const benchmarkLimitedCalls = [];
const benchmarkLimitedRegistry = createTaskRegistry({
  orchestrator_plan: Object.freeze({
    id: "dashscope",
    model: "trusted-model",
    async generate(request) {
      benchmarkLimitedCalls.push(request);
      return {
        text: JSON.stringify({
          relation: "follow-up",
          reasonCode: "same-goal",
          requiresClarification: false,
        }),
        provider: "dashscope",
        model: "trusted-model",
        durationMs: 7,
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13, cachedInputTokens: 0 },
        externalModelRequestCount: 1,
      };
    },
  }),
});
const benchmarkLimitedResponse = await postToServer(
  createServer({ modelProviderRegistry: benchmarkLimitedRegistry }),
  {
    task: "b3_turn_relation",
    requestId: "route-server-budget-limited",
    currentGoalSummary: "车窗控制",
    rawText: "再开一点",
  },
  { headers: { "x-nio-benchmark-external-model-request-limit": "1" } },
);
assert.equal(benchmarkLimitedResponse.status, 200);
assert.equal(benchmarkLimitedCalls.length, 1);
assert.equal(benchmarkLimitedCalls[0].externalModelRequestLimit, 1,
  "the trusted benchmark header must reach the Provider Registry request boundary");
const benchmarkTwoCallResponse = await postToServer(
  createServer({ modelProviderRegistry: benchmarkLimitedRegistry }),
  {
    task: "b3_turn_relation",
    requestId: "route-server-budget-two-call",
    currentGoalSummary: "车窗控制",
    rawText: "再开一点",
  },
  { headers: { "x-nio-benchmark-external-model-request-limit": "2" } },
);
assert.equal(benchmarkTwoCallResponse.status, 200);
assert.equal(benchmarkLimitedCalls.at(-1).externalModelRequestLimit, 2,
  "the trusted benchmark header must allow the scenario's remaining two-call ceiling");

const repairCalls = [];
const repairRegistry = createTaskRegistry({
  orchestrator_plan: Object.freeze({
    id: "dashscope",
    model: "trusted-model",
    async generate(request) {
      repairCalls.push(request);
      if (repairCalls.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return {
          text: JSON.stringify({
            relation: "follow-up",
            reasonCode: "same-goal",
            requiresClarification: false,
            toolCall: { name: "vehicle.write" },
          }),
          provider: "dashscope",
          model: "trusted-model",
          durationMs: 3,
          finishReason: "stop",
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            totalTokens: 10,
            cachedInputTokens: null,
            unavailableReason: "provider-usage-unavailable",
          },
          externalModelRequestCount: 1,
        };
      }
      return {
        text: JSON.stringify({
          relation: "follow-up",
          reasonCode: "same-goal",
          requiresClarification: false,
        }),
        provider: "dashscope",
        model: "trusted-model",
        durationMs: 3,
        finishReason: "stop",
        usage: {
          inputTokens: 4,
          outputTokens: 4,
          totalTokens: 8,
          cachedInputTokens: null,
          unavailableReason: "provider-usage-unavailable",
        },
        externalModelRequestCount: 1,
      };
    },
  }),
}, { watchdogMsByTask: { orchestrator_plan: 12_000 } });
const repairedResponse = await postToServer(createServer({ modelProviderRegistry: repairRegistry }), {
  task: "b3_turn_relation",
  requestId: "route-repair",
  currentGoalSummary: "车窗控制",
  rawText: "再开一点",
});
assert.equal(repairedResponse.status, 200);
assert.equal(repairCalls.length, 2, "invalid Provider authority fields may consume only one repair");
assert.equal(Object.hasOwn(repairCalls[1], "timeoutMs"), false);
assert.equal(Object.hasOwn(repairedResponse.body.output, "toolCall"), false);
assert.equal(repairedResponse.body.telemetry.structuredRetryCount, 1);
assert.equal(repairedResponse.body.telemetry.externalModelRequestCount, 2,
  "one local HTTP request plus one structured repair must report two external calls");
assert.equal(repairedResponse.body.telemetry.firstPassValid, false);
assert.equal(repairedResponse.body.telemetry.durationMs, 6);
assert.deepEqual(repairedResponse.body.telemetry.usage, {
  inputTokens: 9,
  outputTokens: 9,
  totalTokens: 18,
  cachedInputTokens: null,
  unavailableReason: "provider-usage-unavailable",
});

for (const [label, provider] of [
  ["initial", {
    calls: 0,
    textReads: 0,
    async generate() {
      this.calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        get text() {
          provider.textReads += 1;
          return "{\"wrong\":true}";
        },
        provider: "dashscope",
        model: "trusted-model",
        durationMs: 15,
        finishReason: "stop",
        usage: null,
        externalModelRequestCount: 1,
      };
    },
  }],
  ["repair", {
    calls: 0,
    repairTextReads: 0,
    async generate() {
      this.calls += 1;
      if (this.calls === 1) {
        return {
          text: "{\"wrong\":true}",
          provider: "dashscope",
          model: "trusted-model",
          durationMs: 1,
          finishReason: "stop",
          usage: null,
          externalModelRequestCount: 1,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        get text() {
          provider.repairTextReads += 1;
          return "{\"relation\":\"follow-up\",\"reasonCode\":\"same-goal\",\"requiresClarification\":false}";
        },
        provider: "dashscope",
        model: "trusted-model",
        durationMs: 15,
        finishReason: "stop",
        usage: null,
        externalModelRequestCount: 1,
      };
    },
  }],
]) {
  const deadlineRegistry = createTaskRegistry({
    orchestrator_plan: Object.freeze({
      id: "dashscope",
      model: "trusted-model",
      generate: provider.generate.bind(provider),
    }),
  }, { watchdogMsByTask: { orchestrator_plan: 10 } });
  const deadlineResponse = await postToServer(createServer({ modelProviderRegistry: deadlineRegistry }), {
    task: "b3_turn_relation",
    currentGoalSummary: "车窗控制",
    rawText: "再开一点",
  });
  assert.equal(deadlineResponse.status, 504, `${label}: late Provider resolve must time out`);
assert.equal(deadlineResponse.body.telemetry.reason, "generation-timeout");
  assert.equal(deadlineResponse.body.telemetry.externalModelRequestCount,
    label === "initial" ? 1 : 2,
    `${label}: safe timeout telemetry must retain every attempted external call`);
  assert.equal(provider.calls, label === "initial" ? 1 : 2);
  assert.equal(provider.textReads ?? provider.repairTextReads, 0, `${label}: late text must not be read`);
}

let unboundPlanningCalls = 0;
const unboundPlanningProvider = Object.freeze({
  id: "dashscope",
  model: "trusted-model",
  async generate() {
    unboundPlanningCalls += 1;
    throw new Error("an unbound vehicle command plan must not reach a model");
  },
});
const unboundPlanningResponse = await postToServer(createServer({
  modelProviderRegistry: createTaskRegistry({ orchestrator_plan: unboundPlanningProvider }),
}), {
  task: "b2_task_planning",
  runId: "route-unbound-command-plan",
  goalEnvelope: {
    goalId: "goal:route-unbound-command-plan",
    runId: "route-unbound-command-plan",
    objective: "把主驾车窗打开一半",
    interactionType: "command",
    domain: "vehicle-control",
    constraints: [],
    contextRefs: [],
    requiredClarifications: [],
    readyForPlanning: true,
    model: "trusted-model",
    provider: "dashscope",
    confidenceStrength: "strong",
  },
  capabilityCatalog: getCapabilityCatalogProjection(),
});
assert.equal(unboundPlanningResponse.status, 422,
  "a vehicle command plan without Vehicle-SLU authority must fail closed");
assert.equal(unboundPlanningResponse.body.error.code, "plan-binding-unavailable");
assert.equal(unboundPlanningResponse.body.telemetry.externalModelRequestCount, 0);
assert.equal(unboundPlanningCalls, 0, "no model request may be sent for a plan with no eligible capability");

const blockedResponse = await postToServer(createServer({ modelProviderRegistry: blocked }), {
  task: "b3_turn_relation",
  currentGoalSummary: "SECRET_PROMPT",
  rawText: "SECRET_OUTPUT",
});
assert.equal(blockedResponse.status, 502);
assert.equal(blockedFetch.calls, 0);
assert.equal(JSON.stringify(blockedResponse.body).includes("SECRET"), false);
assert.equal(blockedResponse.body.telemetry.provider, "ollama");
assert.equal(blockedResponse.body.telemetry.reason, "generation-unavailable");
assert.equal(blockedResponse.body.telemetry.externalModelRequestCount, 1,
  "the local planner attempt must be retained when Ollama is unavailable");

for (const upstreamStatus of [401, 403]) {
  const knowledgeAuthFetch = async () => new Response(JSON.stringify({
    error: { type: upstreamStatus === 401 ? "invalid_api_key" : "model_access_denied" },
  }), {
    status: upstreamStatus,
    headers: { "content-type": "application/json" },
  });
  knowledgeAuthFetch.calls = 0;
  const countedKnowledgeAuthFetch = async (...args) => {
    knowledgeAuthFetch.calls += 1;
    return knowledgeAuthFetch(...args);
  };
  const knowledgeAuthOllamaClient = {
    calls: 0,
    async generate() {
      this.calls += 1;
      return {
        text: JSON.stringify({
          outcomeStatus: "answered",
          supportStatus: "unsupported",
          answer: "本地后备模型连通性验证。",
          limitations: ["本次未提供手册证据。"],
          degraded: true,
        }),
        durationMs: 4,
      };
    },
  };
  const knowledgeAuthConnections = resolveModelProviderConnections({
    NIO_LLM_PROVIDER: "ollama",
    DASHSCOPE_API_KEY: "fake-secret-for-test",
  }, {
    ollamaClient: knowledgeAuthOllamaClient,
  });
  const knowledgeAuthRegistry = createModelProviderRegistry({
    taskProfiles: resolveModelTaskProfiles({ NIO_LLM_PROVIDER: "ollama" }),
    connections: knowledgeAuthConnections,
    fetchImpl: countedKnowledgeAuthFetch,
  });
  const knowledgeAuthResponse = await postToServer(
    createServer({ modelProviderRegistry: knowledgeAuthRegistry }),
    {
      task: "b3_vehicle_knowledge_synthesis",
      runId: `knowledge-auth-failure-${upstreamStatus}`,
      delegation: {
        delegationId: `delegation:knowledge-auth-failure-${upstreamStatus}`,
        runId: `knowledge-auth-failure-${upstreamStatus}`,
        vehicleScope: "nio-es8-user-manual-2026",
        knowledgeGoal: "合成模型连通性验证",
      },
      executionFacts: {
        outcomeStatus: "completed",
        evidenceRefs: [],
        vehicleStateRefs: [],
        safetyAssessmentRef: null,
        degraded: false,
      },
    },
  );
  assert.equal(knowledgeAuthResponse.status, 200);
  assert.equal(knowledgeAuthResponse.body.telemetry.provider, "ollama");
  assert.equal(knowledgeAuthResponse.body.telemetry.model, "qwen3:8b");
  assert.equal(knowledgeAuthResponse.body.telemetry.primaryFailureReasonCode, "provider-auth-failed");
  assert.equal(knowledgeAuthResponse.body.telemetry.externalModelRequestCount, 2);
  assert.equal(knowledgeAuthResponse.body.telemetry.fallbackActive, true);
  assert.equal(knowledgeAuthResponse.body.telemetry.degraded, true);
  assert.equal(knowledgeAuthFetch.calls, 1,
    "an authentication failure must not be retried against another model with the same provider credentials");
  assert.equal(knowledgeAuthOllamaClient.calls, 1,
    "an authentication failure should use the configured local Knowledge Answer fallback once");
  assert.equal(JSON.stringify(knowledgeAuthResponse.body).includes("fake-secret-for-test"), false);
  assert.equal(JSON.stringify(knowledgeAuthResponse.body).includes("model_access_denied"), false);
}

let sameProviderAuthFetchCalls = 0;
const sameProviderAuthRegistry = createModelProviderRegistry({
  taskProfiles: {
    ...resolveModelTaskProfiles({ NIO_LLM_PROVIDER: "ollama" }),
    knowledge_answer: {
      ...resolveModelTaskProfiles({ NIO_LLM_PROVIDER: "ollama" }).knowledge_answer,
      fallback: { provider: "dashscope", model: "qwen-plus" },
    },
  },
  connections: resolveModelProviderConnections({
    DASHSCOPE_API_KEY: "fake-secret-for-test",
  }, { ollamaClient: unavailableOllamaClient }),
  fetchImpl: async () => {
    sameProviderAuthFetchCalls += 1;
    return new Response(JSON.stringify({ error: { type: "model_access_denied" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  },
});
await assert.rejects(
  sameProviderAuthRegistry.generateForTask("knowledge_answer", {
    task: "b3_vehicle_knowledge_synthesis",
    prompt: "Synthetic auth fallback guard probe.",
    outputMode: "text",
  }),
  (error) => error.code === "provider-auth-failed",
);
assert.equal(sameProviderAuthFetchCalls, 1,
  "an auth failure must never retry against a second model using the same provider credentials");

let schemaInvalidCloudCalls = 0;
const schemaFallbackOllamaClient = {
  calls: 0,
  async generate() {
    this.calls += 1;
    return {
      text: JSON.stringify({
        outcomeStatus: "answered",
        supportStatus: "unsupported",
        answer: "本地模型确认没有手册证据可用于回答。",
        limitations: ["合成测试未提供手册证据。"],
        degraded: true,
      }),
      durationMs: 5,
    };
  },
};
const schemaFallbackRegistry = createModelProviderRegistry({
  taskProfiles: resolveModelTaskProfiles({ NIO_LLM_PROVIDER: "ollama" }),
  connections: resolveModelProviderConnections({
    DASHSCOPE_API_KEY: "fake-secret-for-test",
  }, { ollamaClient: schemaFallbackOllamaClient }),
  fetchImpl: async () => {
    schemaInvalidCloudCalls += 1;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});
const schemaFallbackRunId = "knowledge-invalid-schema-local-fallback";
const schemaFallbackResponse = await postToServer(
  createServer({ modelProviderRegistry: schemaFallbackRegistry }),
  {
    task: "b3_vehicle_knowledge_synthesis",
    runId: schemaFallbackRunId,
    delegation: {
      delegationId: `delegation:${schemaFallbackRunId}`,
      runId: schemaFallbackRunId,
      vehicleScope: "nio-es8-user-manual-2026",
      knowledgeGoal: "合成 schema 回退验证",
    },
    executionFacts: {
      outcomeStatus: "completed",
      evidenceRefs: [],
      vehicleStateRefs: [],
      safetyAssessmentRef: null,
      degraded: false,
    },
  },
  { headers: { "x-nio-benchmark-external-model-request-limit": "2" } },
);
assert.equal(schemaFallbackResponse.status, 200);
assert.equal(schemaFallbackResponse.body.telemetry.provider, "ollama");
assert.equal(schemaFallbackResponse.body.telemetry.model, "qwen3:8b");
assert.equal(schemaFallbackResponse.body.telemetry.fallbackActive, true);
assert.equal(schemaFallbackResponse.body.telemetry.primaryFailureReasonCode, "provider-response-invalid");
assert.equal(schemaFallbackResponse.body.telemetry.primaryStructuredValidationReason, "knowledge-result-invalid");
assert.equal(schemaFallbackResponse.body.telemetry.primaryStructuredValidationSubreason, "contract-invalid");
assert.equal(schemaFallbackResponse.body.telemetry.externalModelRequestCount, 2);
assert.equal(schemaFallbackResponse.body.output.degraded, true);
assert.equal(schemaInvalidCloudCalls, 1,
  "invalid primary output must lead to one local fallback, never another DashScope request");
assert.equal(schemaFallbackOllamaClient.calls, 1);

const originalFailureProjectionFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({
  error: "structured model generation failed",
  telemetry: {
    provider: "dashscope",
    model: "qwen3.8-flash",
    degraded: true,
    reason: "provider-auth-failed",
    structuredValidationReason: "provider-auth-failed",
    fallbackActive: false,
    fallbackAttempted: false,
    externalModelRequestCount: 1,
  },
}), { status: 502, headers: { "content-type": "application/json" } });
try {
  const adapter = new CloudLLMAdapter({ endpoint: "http://127.0.0.1:4173/api/local-llm" });
  await assert.rejects(
    adapter.postLocalLlm({ task: "b3_vehicle_knowledge_synthesis", prompt: "safe test" }, 1000),
    (error) => {
      assert.deepEqual(error.telemetry, {
        degraded: true,
        reason: "provider-auth-failed",
        model: "qwen3.8-flash",
        provider: "dashscope",
        fallbackActive: false,
        fallbackAttempted: false,
        externalModelRequestCount: 1,
      });
      return true;
    },
  );
} finally {
  globalThis.fetch = originalFailureProjectionFetch;
}

for (const [code, expectedStatus] of Object.entries({
  "provider-auth-failed": 502,
  "provider-rate-limited": 503,
  "provider-unavailable": 502,
  "generation-timeout": 504,
})) {
  const failureRegistry = createTaskRegistry({
    orchestrator_plan: Object.freeze({
      id: "dashscope",
      model: "trusted-model",
      async generate() {
        throw new ModelProviderError("SECRET_UPSTREAM_FAILURE", {
          code,
          provider: "spoofed-provider",
          durationMs: 9,
          externalModelRequestCount: 1,
          details: {
            reasonCode: code,
            upstreamStatus: code === "provider-auth-failed" ? 401 : 503,
          },
        });
      },
    }),
  }, { watchdogMsByTask: { orchestrator_plan: 12_000 } });
  const failureResponse = await postToServer(createServer({ modelProviderRegistry: failureRegistry }), {
    task: "b3_turn_relation",
    currentGoalSummary: "SECRET_PROMPT",
    rawText: "SECRET_OUTPUT",
  });
  assert.equal(failureResponse.status, expectedStatus, `${code}: local HTTP mapping`);
  assert.equal(failureResponse.body.telemetry.reason, code);
  assert.equal(failureResponse.body.telemetry.durationMs, 9);
  assert.equal(failureResponse.body.telemetry.provider, "dashscope");
  assert.equal(failureResponse.body.telemetry.model, "trusted-model");
  assert.equal(failureResponse.body.telemetry.externalModelRequestCount, 1,
    `${code}: safe Provider errors must retain the attempted external call count`);
  assert.equal(JSON.stringify(failureResponse.body).includes("SECRET"), false);
  assert.equal(failureResponse.body.telemetry.upstreamStatus,
    code === "provider-auth-failed" ? 401 : undefined,
    `${code}: only auth failures may expose a 401/403 diagnostic`);
}

const contractViolationRegistry = createTaskRegistry({
  orchestrator_plan: Object.freeze({
    id: "future-provider",
    model: "trusted-model",
    async generate() {
      throw new Error("SECRET_PROVIDER_IMPLEMENTATION_FAILURE");
    },
  }),
}, { watchdogMsByTask: { orchestrator_plan: 12_000 } });
const contractViolationResponse = await postToServer(
  createServer({ modelProviderRegistry: contractViolationRegistry }),
  { task: "b3_turn_relation", currentGoalSummary: "SECRET_PROMPT", rawText: "SECRET_OUTPUT" },
);
assert.equal(contractViolationResponse.status, 502);
assert.equal(contractViolationResponse.body.telemetry.reason, "provider-unavailable");
assert.equal(JSON.stringify(contractViolationResponse.body).includes("SECRET"), false);

const ordinaryCalls = [];
const ordinaryRegistry = createTaskRegistry({
  cabin_response: Object.freeze({
    id: "dashscope",
    model: "trusted-model",
    async generate(request) {
      ordinaryCalls.push(request);
      const text = request.generationProfile === "weather-composer"
        ? "今天偏热，穿透气短袖会更舒服；如果长时间在户外，可以带上雨具备用。"
        : request.generationProfile === "compact-conversation"
          ? "这是一条简短的普通对话回答。"
          : "这是一条有界的默认生成结果。";
      return {
        text,
        provider: "dashscope",
        model: "trusted-model",
        durationMs: 6,
        finishReason: "stop",
        usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10, cachedInputTokens: 0 },
        externalModelRequestCount: 1,
      };
    },
  }),
}, { watchdogMsByTask: { cabin_response: 12_000 } });

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (new URL(url).hostname === "api.open-meteo.com") {
    throw new Error("guarded weather network failure");
  }
  return new Response(JSON.stringify({
    response: "今天偏热，穿透气短袖会更舒服；如果长时间在户外，可以带上雨具备用。",
    done_reason: "stop",
    prompt_eval_count: 6,
    eval_count: 4,
  }), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  const ordinaryServer = createServer({ modelProviderRegistry: ordinaryRegistry });
  const compactResponse = await postToServer(ordinaryServer, {
    task: "conversation_general",
    requestId: "ordinary-compact",
    rawText: "讲一个露营小建议",
    parsedCommand: {
      intent: "conversation.general",
      rawText: "讲一个露营小建议",
      slots: { topic: "general_qa" },
    },
    provider: "ollama",
    model: "attacker-model",
    timeoutMs: 1,
    generationProfile: "structured-agent",
  });
  assert.equal(compactResponse.status, 200);
  assert.equal(compactResponse.body.telemetry.externalModelRequestCount, 1,
    "ordinary text success must expose the Provider external request count");

  const weatherData = {
    location: { city: "杭州", resolution: "known-city", defaulted: false },
    current: {
      time: "2026-08-02T14:00",
      weatherDescription: "局部多云",
      temperature2m: 31,
      apparentTemperature: 35,
      relativeHumidity2m: 68,
      precipitation: 0,
      windSpeed10m: 9,
    },
    forecast: [{
      date: "2026-08-02",
      weatherDescription: "局部多云",
      temperatureMax: 34,
      temperatureMin: 26,
      apparentTemperatureMax: 39,
      apparentTemperatureMin: 29,
      precipitationSum: 0,
      precipitationProbabilityMax: 20,
      windSpeed10mMax: 15,
    }],
    hourly: [],
    units: {
      temperature2m: "°C",
      apparentTemperature: "°C",
      precipitation: "mm",
      precipitationProbability: "%",
      windSpeed10m: "km/h",
    },
    provider: "open-meteo",
  };
  const weatherResponse = await composeWeatherResponse(
    weatherData,
    "今天杭州的天气适合穿什么衣服",
    { registry: ordinaryRegistry, requestId: "ordinary-weather", task: "conversation_general" },
  );
  assert.equal(weatherResponse.telemetry.fallback, false);

  const defaultResponse = await postToServer(ordinaryServer, {
    task: "planning",
    requestId: "ordinary-default",
    rawText: "生成一条不声称车辆执行成功的有界摘要",
    parsedCommand: { intent: "unknown", slots: {} },
    toolResult: {},
  });
  assert.equal(defaultResponse.status, 200);

  assert.deepEqual(ordinaryCalls.map((call) => call.generationProfile), [
    "compact-conversation",
    "weather-composer",
    "default",
  ]);
  assert.equal(ordinaryCalls.every((call) => call.outputMode === "text"), true);
  assert.equal(ordinaryCalls.every((call) => !Object.hasOwn(call, "timeoutMs")), true);
  assert.equal(ordinaryCalls.every((call) => !Object.hasOwn(call, "model")), true);

  const cachedKnowledgeBody = {
    task: "conversation_general",
    requestId: "ordinary-cache",
    rawText: "介绍一下 ES6 的 NOMI 智能座舱",
    parsedCommand: {
      intent: "conversation.general",
      rawText: "介绍一下 ES6 的 NOMI 智能座舱",
      slots: { topic: "vehicle_knowledge" },
    },
  };
  const uncachedKnowledgeResponse = await postToServer(ordinaryServer, cachedKnowledgeBody);
  const callsBeforeCacheHit = ordinaryCalls.length;
  const cachedKnowledgeResponse = await postToServer(ordinaryServer, cachedKnowledgeBody);
  assert.equal(uncachedKnowledgeResponse.body.telemetry.externalModelRequestCount, 1);
  assert.equal(cachedKnowledgeResponse.body.telemetry.cacheHit, true);
  assert.equal(cachedKnowledgeResponse.body.telemetry.externalModelRequestCount, 0,
    "a cache hit must not inherit the original Provider request count");
  assert.equal(ordinaryCalls.length, callsBeforeCacheHit,
    "a cache hit must not call the Provider");

  const callsBeforeBoundaries = ordinaryCalls.length;
  const deterministicBodies = [
    {
      label: "planning-template",
      body: {
        task: "planning",
        rawText: "打开主驾车窗一半",
        parsedCommand: { intent: "body.window.setPosition", slots: { zone: "front_left", percent: 50 } },
        safetyDecision: { allowed: true, action: "allow" },
        toolResult: { ok: true, tool: "body.window.setPosition", source: "dev-adapter", hmiSummary: "主驾车窗已调至 50%", statePatch: { windows: { frontLeft: 50 } } },
      },
    },
    {
      label: "weather-location-clarification",
      body: {
        task: "conversation_general",
        rawText: "这里天气怎么样",
        parsedCommand: { intent: "conversation.general", rawText: "这里天气怎么样", slots: { topic: "weather_query" } },
      },
    },
    {
      label: "vehicle-knowledge-inapplicable",
      body: {
        task: "conversation_general",
        rawText: "说说蔚来 ES8 的空气质量能力",
        parsedCommand: { intent: "conversation.general", rawText: "说说蔚来 ES8 的空气质量能力", slots: { topic: "vehicle_knowledge" } },
      },
    },
    {
      label: "safety-rejection",
      body: {
        task: "planning",
        rawText: "行驶中打开尾门",
        parsedCommand: { intent: "safety.reject", rawText: "行驶中打开尾门", slots: { reason: "车辆行驶中禁止打开尾门。" } },
        safetyDecision: { allowed: false, action: "reject", reason: "车辆行驶中禁止打开尾门。" },
        toolResult: { ok: false, tool: "safety.reject", hmiSummary: "车辆行驶中不能打开尾门。" },
      },
    },
  ];
  for (const { label, body } of deterministicBodies) {
    const boundaryResponse = await postToServer(ordinaryServer, body);
    assert.equal(boundaryResponse.status, 200, label);
    assert.equal(boundaryResponse.body.telemetry.externalModelRequestCount, 0,
      `${label} must explicitly report zero external model requests`);
    assert.equal(ordinaryCalls.length, callsBeforeBoundaries, `${label} must not call Provider`);
    if (label === "planning-template") {
      const rendererIdentity = `${PLANNING_TEMPLATE_RENDERER_CAPABILITY.id}@${PLANNING_TEMPLATE_RENDERER_CAPABILITY.version}`;
      assert.equal(boundaryResponse.body.model, rendererIdentity,
        "the no-model template path must identify its deterministic renderer, not an LLM model");
      assert.equal(boundaryResponse.body.telemetry.model, rendererIdentity);
    }
  }

  const weatherFailureCalls = [];
  const weatherFailureRegistry = createTaskRegistry({
    cabin_response: Object.freeze({
      id: "dashscope",
      model: "trusted-model",
      async generate(request) {
        weatherFailureCalls.push(request);
        return {
          text: "杭州今天39°C，天气晴朗。",
          provider: "dashscope",
          model: "trusted-model",
          durationMs: 4,
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6, cachedInputTokens: 0 },
        };
      },
    }),
  }, { watchdogMsByTask: { cabin_response: 12_000 } });
  const failedWeatherResponse = await postToServer(createServer({
    modelProviderRegistry: weatherFailureRegistry,
    weatherDataFetcher: async () => {
      const error = new Error("SECRET_WEATHER_UPSTREAM_BODY");
      error.code = "weather_timeout";
      throw error;
    },
  }), {
    task: "conversation_general",
    requestId: "weather-adapter-failure",
    rawText: "杭州今天天气怎么样",
    parsedCommand: {
      intent: "conversation.general",
      rawText: "杭州今天天气怎么样",
      requiresExternalData: true,
      externalDataType: "weather",
      slots: { topic: "weather_query", city: "杭州", requiresExternalData: true, externalDataType: "weather" },
    },
  });
  assert.equal(failedWeatherResponse.status, 200);
  assert.equal(weatherFailureCalls.length, 0, "weather Adapter failure must fail closed before Provider");
  assert.match(failedWeatherResponse.body.summary, /暂时无法获取实时天气/);
  assert.match(failedWeatherResponse.body.summary, /稍后重试/);
  assert.doesNotMatch(failedWeatherResponse.body.summary, /39°C|晴朗/);
  assert.equal(failedWeatherResponse.body.telemetry.provider, "local-boundary");
  assert.equal(failedWeatherResponse.body.telemetry.reason, "weather_timeout");
  assert.equal(JSON.stringify(failedWeatherResponse.body).includes("SECRET_WEATHER"), false);

  const failureCalls = [];
  const failureRegistry = createTaskRegistry({
    cabin_response: Object.freeze({
      id: "dashscope",
      model: "trusted-model",
      async generate(request) {
        failureCalls.push(request);
        throw new ModelProviderError("SECRET_FAILURE", {
          code: "provider-unavailable",
          provider: "spoofed-provider",
          durationMs: 5,
          externalModelRequestCount: 1,
        });
      },
    }),
  }, { watchdogMsByTask: { cabin_response: 12_000 } });
  const failedSynthesis = await postToServer(createServer({ modelProviderRegistry: failureRegistry }), {
    task: "planning",
    requestId: "ordinary-failure",
    rawText: "生成最终摘要",
    parsedCommand: { intent: "unknown", slots: {} },
    toolResult: {},
  });
  assert.equal(failedSynthesis.status, 200);
  assert.equal(failureCalls.length, 1, "DashScope failure must not replay on Ollama");
  assert.match(failedSynthesis.body.summary, /^抱歉[\uff0c,]我们暂时无法完成/);
  assert.equal(failedSynthesis.body.telemetry.provider, "dashscope");
  assert.equal(failedSynthesis.body.telemetry.model, "trusted-model");
  assert.equal(failedSynthesis.body.telemetry.reason, "provider-unavailable");
  assert.equal(failedSynthesis.body.telemetry.degraded, true);
  assert.equal(failedSynthesis.body.telemetry.externalModelRequestCount, 1,
    "ordinary text failure must retain the attempted Provider request count");
  assert.equal(JSON.stringify(failedSynthesis.body).includes("SECRET"), false);

  for (const providerFailureReasonCode of [
    "provider-safety-refusal",
    "generation-timeout",
    "provider-network-error",
    "provider-response-invalid",
    "provider-schema-invalid-after-repair",
  ]) {
    const secretFailureText = `SECRET_${providerFailureReasonCode}`;
    const degradedRegistry = createTaskRegistry({
      cabin_response: Object.freeze({
        id: "dashscope",
        model: "trusted-model",
        async generate() {
          throw new ModelProviderError(secretFailureText, {
            code: providerFailureReasonCode,
            provider: "spoofed-provider",
            durationMs: 8,
            externalModelRequestCount: 1,
            details: {
              reasonCode: providerFailureReasonCode,
              errorType: secretFailureText,
            },
          });
        },
      }),
    }, { watchdogMsByTask: { cabin_response: 12_000 } });
    const degradedResponse = await postToServer(
      createServer({ modelProviderRegistry: degradedRegistry }),
      {
        task: "planning",
        requestId: `ordinary-${providerFailureReasonCode}`,
        rawText: "生成最终摘要",
        parsedCommand: { intent: "unknown", slots: {} },
        toolResult: {},
      },
    );

    assert.equal(degradedResponse.status, 200, providerFailureReasonCode);
    assert.match(degradedResponse.body.summary, /^抱歉[，,]我们暂时无法完成/);
    assert.equal(degradedResponse.body.telemetry.degraded, true);
    assert.equal(degradedResponse.body.telemetry.provider, "dashscope");
    assert.equal(degradedResponse.body.telemetry.model, "trusted-model");
    assert.equal(degradedResponse.body.telemetry.reason, providerFailureReasonCode);
    assert.equal(
      degradedResponse.body.telemetry.providerFailureReasonCode,
      providerFailureReasonCode,
    );
    assert.equal(degradedResponse.body.telemetry.externalModelRequestCount, 1);
    assert.equal(JSON.stringify(degradedResponse.body).includes(secretFailureText), false);
    assert.equal(JSON.stringify(degradedResponse.body).includes("spoofed-provider"), false);
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Model Provider registry, structured routing, and ordinary routing verification passed");
