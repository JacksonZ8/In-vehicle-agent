import { SafetyGateway } from "../../src/safety/safety-gateway.js";
import { DevVehicleStateProvider } from "../../src/safety/vehicle-state.js";
import { DemoSensorSimulator } from "../../src/vehicle/demo-sensor-simulator.js";
import { VehicleExecutionCoordinator } from "../../src/vehicle/vehicle-execution-coordinator.js";
import { VehicleTools } from "../../src/vehicle/vehicle-tools.js";
import { parseCommandWithSemanticPolicy } from "./semantic-policy.js";
import { createVehicleSluEnvelope } from "../../src/semantic/vehicle-slu-contract.js";
import { RuntimeKernel } from "../../src/application/runtime-kernel.js";
import { RoutePolicy, createRouteDecision } from "../../src/application/route-policy.js";
import { createChatUseCase } from "../../src/application/use-cases/chat.js";
import { createVehicleKnowledgeUseCase } from "../../src/application/use-cases/vehicle-knowledge.js";
import { createVehicleControlUseCase } from "../../src/application/use-cases/vehicle-control.js";
import {
  createComplexTaskUseCase,
  createManualRetrieveCapabilityOwner,
} from "../../src/application/use-cases/complex-task.js";
import { createTaskPlan } from "../../src/agents/agent-contracts.js";
import { CabinAssistantController } from "../../src/agents/cabin-assistant-controller.js";
import { OrchestratorController } from "../../src/agents/orchestrator-controller.js";
import { RunEventLedger } from "../../src/runtime/run-event-ledger.js";
import { PendingClarificationStore } from "../../src/runtime/pending-clarification-store.js";
import { SessionMemory } from "../../src/runtime/session-memory.js";
import { createTaskPlanExecution } from "../../src/runtime/task-plan-execution.js";
import { ExternalDataAdapter } from "../../src/external-data/external-data-adapter.js";
import {
  createVehicleSluReadonlyStepScope,
  createVehicleSluWeatherStepAuthority,
  projectVehicleSluReadonlyStepInput,
} from "../../src/semantic/vehicle-slu-orchestration.js";

// Test double only: stands in for the Vehicle-SLU model deciding that a knowledge question asks
// about current tailgate eligibility. Production code never classifies raw text this way.
function isTailgateEligibilityQuestion(text) {
  return /现在|当前|是否满足|能否|可否|能不能|是否可以|为什么不能/.test(text)
    && /尾门|后备箱|tailgate/i.test(text)
    && /开启|打开|开门|开|open/i.test(text);
}

const defaultSafetyState = Object.freeze({
  speedKph: 0,
  gear: "P",
  rearClearance: null,
  tailgateOpen: false,
  windowAntiPinchAvailable: true,
  rainDetected: false,
});

export function createCompatibilityHarness(options = {}) {
  const calls = [];
  const dependencies = createInstrumentedDependencies(options, calls);
  return Object.freeze({
    runtime: createRuntimeUnderTest(dependencies),
    calls,
    provider: dependencies.vehicleStateProvider,
    resetCalls() { calls.length = 0; },
  });
}

export function createLeanRuntimeVehicleKnowledgeHarness(options = {}) {
  const calls = [];
  const nowMs = Number.isFinite(options.nowMs)
    ? options.nowMs
    : Date.parse("2026-08-04T09:00:00.000Z");
  const values = {
    ...defaultSafetyState,
    rearClearance: true,
    ...(options.safetyState || {}),
  };
  const vehicleStateProvider = new DevVehicleStateProvider(values);
  vehicleStateProvider.ingestDemoSensorState({
    source: "demo-sensor-simulator",
    simulated: true,
    capturedAt: new Date(options.staleProvider ? nowMs - 6_000 : nowMs).toISOString(),
    values,
  });

  const manualRetriever = async (query, input) => {
    record(calls, "manual.retrieve", { query, input });
    if (typeof options.manualRetriever === "function") {
      return options.manualRetriever(query, input);
    }
    return options.ragMiss ? [] : [manualChunk()];
  };
  const refreshVehicleState = async (input) => {
    record(calls, "provider.refresh", input);
    if (typeof options.refreshVehicleState === "function") {
      return options.refreshVehicleState(input, vehicleStateProvider);
    }
    return { ok: true, snapshot: vehicleStateProvider.getSnapshot() };
  };
  const readVehicleStateSnapshot = () => {
    record(calls, "provider.read", {});
    if (typeof options.readVehicleStateSnapshot === "function") {
      return options.readVehicleStateSnapshot(vehicleStateProvider);
    }
    return vehicleStateProvider.getSnapshot();
  };
  const realSafetyGateway = new SafetyGateway({}, { now: () => nowMs });
  const safetyGateway = {
    async evaluate(command, input) {
      record(calls, "safety.evaluate", { command, input });
      if (options.safetyUnavailable) throw new Error("Safety unavailable");
      if (typeof options.evaluateSafety === "function") {
        return options.evaluateSafety(command, input, realSafetyGateway);
      }
      return realSafetyGateway.evaluate(command, input);
    },
  };
  const modelAdapter = {
    async createTaskPlan() { throw new Error("general task planning must not be reached"); },
    async formGoal() { throw new Error("goal formation must not be reached"); },
    async synthesizeAgentResponse() { throw new Error("general synthesis must not be reached"); },
    async createVehicleKnowledgeSubplan(input) {
      record(calls, "knowledge.plan", input);
      if (typeof options.modelBehavior?.plan === "function") {
        return options.modelBehavior.plan(input);
      }
      return withPrivateTelemetryReason(
        createKnowledgePlanModelResult(input.delegation),
        options.privateKnowledgeTelemetryReason,
      );
    },
    async synthesizeVehicleKnowledgeAnswer(input) {
      record(calls, "knowledge.synthesize", input);
      if (typeof options.modelBehavior?.synthesize === "function") {
        return options.modelBehavior.synthesize(input);
      }
      return withPrivateTelemetryReason(
        createKnowledgeSynthesisModelResult(input),
        options.privateKnowledgeTelemetryReason,
      );
    },
  };
  const orchestratorController = new OrchestratorController({
    modelAdapter,
    now: createMonotonicClockFrom(nowMs),
  });
  instrumentMethod(
    orchestratorController,
    "planKnowledgeTask",
    "orchestrator.planKnowledgeTask",
    calls,
  );
  const cabinAssistantController = new CabinAssistantController({
    modelAdapter,
    now: createMonotonicClockFrom(nowMs),
  });
  const useCase = createVehicleKnowledgeUseCase({
    orchestratorController,
    cabinAssistantController,
    manualRetriever,
    refreshVehicleState,
    readVehicleStateSnapshot,
    safetyGateway,
    now: () => nowMs,
    monotonicNow: options.monotonicNow || createMonotonicClockFrom(0),
  });
  const runEventLedger = new RunEventLedger();
  const sessionMemory = new SessionMemory({ now: () => nowMs });
  let requestSequence = 0;
  const runtime = new RuntimeKernel({
    routePolicy: createResolvedKnowledgeRoutePolicy(),
    useCases: Object.freeze({ "vehicle-knowledge": useCase }),
    runEventLedger,
    sessionMemory,
    now: createMonotonicClockFrom(nowMs),
    createRequestId: () => `run:lean-knowledge:${++requestSequence}`,
    ...(typeof options.prepareManualRetrievalCandidate === "function"
      ? { prepareManualRetrievalCandidate: options.prepareManualRetrievalCandidate }
      : {}),
  });

  calls.length = 0;
  return Object.freeze({
    runtime,
    calls,
    provider: vehicleStateProvider,
    ledger: runEventLedger,
    resetCalls() { calls.length = 0; },
  });
}

export function createLeanRuntimeVehicleControlHarness(options = {}) {
  const calls = [];
  let nowMs = Number.isFinite(options.nowMs)
    ? options.nowMs
    : Date.parse("2026-08-04T10:00:00.000Z");
  const now = () => nowMs;
  const safetyValues = {
    ...defaultSafetyState,
    rearClearance: true,
    ...(options.safetyState || {}),
  };
  const vehicleStateProvider = new DevVehicleStateProvider(safetyValues);
  vehicleStateProvider.ingestDemoSensorState({
    source: "demo-sensor-simulator",
    simulated: true,
    capturedAt: new Date(options.staleProvider ? nowMs - 6_000 : nowMs).toISOString(),
    values: safetyValues,
  });
  const readProviderSnapshot = vehicleStateProvider.getSnapshot.bind(vehicleStateProvider);
  instrumentMethod(vehicleStateProvider, "getSnapshot", "provider.read", calls);
  instrumentMethod(vehicleStateProvider, "ingestObservation", "provider.ingestObservation", calls);

  const refreshVehicleStateForSafety = async (input) => {
    record(calls, "provider.refresh", input);
    if (typeof options.refreshVehicleStateForSafety === "function") {
      return options.refreshVehicleStateForSafety(input, vehicleStateProvider);
    }
    if (options.staleProvider) return { ok: true, snapshot: readProviderSnapshot() };
    const refreshed = vehicleStateProvider.ingestDemoSensorState({
      source: "demo-sensor-simulator",
      simulated: true,
      capturedAt: new Date(nowMs).toISOString(),
      values: safetyValues,
    });
    if (options.providerFault === "identity-mismatch") {
      return { ok: true, snapshot: structuredClone(refreshed.snapshot) };
    }
    return refreshed;
  };

  const realSafetyGateway = new SafetyGateway({}, { now });
  const safetyGateway = {
    async evaluate(command, input) {
      record(calls, "safety.evaluate", { command, input });
      const decision = typeof options.evaluateSafety === "function"
        ? await options.evaluateSafety(command, input, realSafetyGateway)
        : realSafetyGateway.evaluate(command, input);
      options.onSafetyEvaluated?.(decision);
      return decision;
    },
  };

  const vehicleTools = new VehicleTools({ now });
  const executeVehicleTool = vehicleTools.execute.bind(vehicleTools);
  vehicleTools.execute = async (toolCall) => {
    record(calls, "vehicle.adapter.execute", toolCall);
    const result = await executeVehicleTool(toolCall);
    options.onAdapterAccepted?.(toolCall, result);
    return result;
  };
  const sensorSimulator = new DemoSensorSimulator({
    now: () => new Date(nowMs),
    scheduler: (callback) => callback(),
    initialVehicleState: safetyValues,
  });
  instrumentMethod(sensorSimulator, "submit", "sensor.submit", calls);
  const coordinator = new VehicleExecutionCoordinator({
    vehicleTools,
    sensorSimulator,
    vehicleStateProvider,
    now,
    confirmationTimeoutMs: options.confirmationTimeoutMs ?? 1_000,
    timeoutScheduler: options.timeoutScheduler ?? (() => () => {}),
  });
  const vehicleExecutionCoordinator = {
    async execute(toolCall, input) {
      record(calls, "vehicle.execute", { toolCall, input });
      const envelope = await coordinator.execute(toolCall, input);
      return typeof options.mutateCoordinatorEnvelope === "function"
        ? options.mutateCoordinatorEnvelope(envelope)
        : envelope;
    },
  };

  const useCase = createVehicleControlUseCase({
    refreshVehicleStateForSafety,
    vehicleStateProvider,
    safetyGateway,
    vehicleExecutionCoordinator,
    now,
  });
  let routeResolveCount = 0;
  const leanRuntimeRoutePolicy = createLeanRuntimeRoutePolicy(options.modelBehavior);
  const routePolicy = Object.freeze({
    resolve(...args) {
      routeResolveCount += 1;
      return leanRuntimeRoutePolicy.resolve(...args);
    },
  });
  const runEventLedger = new RunEventLedger();
  const runtime = new RuntimeKernel({
    routePolicy,
    useCases: Object.freeze({ "vehicle-control": useCase }),
    runEventLedger,
    sessionMemory: new SessionMemory({ now }),
    now,
    createRequestId: () => "unexpected-control-request-id",
    ...(typeof options.prepareManualRetrievalCandidate === "function"
      ? { prepareManualRetrievalCandidate: options.prepareManualRetrievalCandidate }
      : {}),
  });

  calls.length = 0;
  return Object.freeze({
    runtime,
    useCase,
    calls,
    provider: vehicleStateProvider,
    ledger: runEventLedger,
    getRouteResolveCount() { return routeResolveCount; },
    advanceNow(durationMs) { nowMs += durationMs; },
    resetCalls() { calls.length = 0; },
  });
}

export function createLeanRuntimeDirectCapabilityHarness(options = {}) {
  const calls = [];
  const weatherRequests = [];
  const nowMs = Number.isFinite(options.nowMs)
    ? options.nowMs
    : Date.parse("2026-08-04T11:00:00.000Z");
  const now = createMonotonicClockFrom(nowMs);
  const concreteAdapter = options.externalDataAdapter || new ExternalDataAdapter({
    now,
    weatherEndpoint: "/api/weather",
    async fetchImpl(url, input) {
      weatherRequests.push({ url, input });
      return new Response(JSON.stringify({
        ok: true,
        summary: "上海明天小雨，25°C到30°C，降水概率最高70%。",
        weatherData: {
          provider: "open-meteo",
          source: "https://api.open-meteo.com/v1/forecast",
          fetchedAt: "2026-08-04T11:00:00.000Z",
          location: { city: "上海", resolution: "city-name", defaulted: false },
          forecast: [{
            date: "2026-08-05",
            weatherDescription: "小雨",
            temperatureMin: 25,
            temperatureMax: 30,
            precipitationProbabilityMax: 70,
          }],
          units: { temperature2m: "°C", precipitationProbability: "%" },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const externalDataAdapter = Object.freeze({
    async execute(toolCall, input) {
      record(calls, "external.execute", { toolCall, input });
      if (typeof options.adapterBehavior === "function") {
        return options.adapterBehavior(toolCall, input, concreteAdapter);
      }
      return concreteAdapter.execute(toolCall, input);
    },
  });
  const useCase = createComplexTaskUseCase({ externalDataAdapter });
  const runEventLedger = new RunEventLedger();
  const runtime = new RuntimeKernel({
    routePolicy: options.routePolicy || createLeanRuntimeRoutePolicy(),
    useCases: Object.freeze({ task: useCase }),
    runEventLedger,
    sessionMemory: new SessionMemory({ now }),
    now,
    createRequestId: () => "unexpected-direct-capability-request-id",
  });

  calls.length = 0;
  return Object.freeze({
    runtime,
    useCase,
    calls,
    ledger: runEventLedger,
    weatherRequests,
    resetCalls() { calls.length = 0; },
  });
}

export const callNames = (calls) => calls.map((entry) => entry.name);
export const countCalls = (calls, name) => calls.filter((entry) => entry.name === name).length;

export function createLeanRuntimeRoutePolicy(modelBehavior = {}) {
  return new RoutePolicy({
    localModel: {
      async parse(rawText, options) {
        const custom = typeof modelBehavior?.parse === "function"
          ? await modelBehavior.parse(rawText, options)
          : null;
        if (custom?.semanticEnvelope || custom?.executionDisabled === true) return custom;
        const command = custom?.command
          ?? parseCommandWithSemanticPolicy(rawText, { requestId: options.requestId });
        return {
          semanticEnvelope: createHarnessSemanticEnvelope(command, rawText, options.requestId),
          telemetry: custom?.telemetry
            ?? { provider: "lean-runtime-harness", model: "deterministic", degraded: false },
        };
      },
    },
  });
}

function createInstrumentedDependencies(options, calls) {
  const now = createMonotonicClock();
  // `route` labels a matrix row for verifier diagnostics only; Runtime behavior
  // is derived from the real deterministic semantic-policy output below.
  const route = typeof options.route === "string" ? options.route : "";
  const safetyValues = {
    ...defaultSafetyState,
    rearClearance: true,
    ...(options.safetyState || {}),
  };
  const vehicleStateProvider = new DevVehicleStateProvider(safetyValues);
  vehicleStateProvider.ingestDemoSensorState({
    source: "demo-sensor-simulator",
    simulated: true,
    capturedAt: new Date(now()).toISOString(),
    values: safetyValues,
  });
  instrumentMethod(vehicleStateProvider, "getSnapshot", "provider.read", calls);
  instrumentMethod(vehicleStateProvider, "ingestObservation", "provider.ingestObservation", calls);

  const vehicleTools = new VehicleTools({ now });
  const executeVehicleTool = vehicleTools.execute.bind(vehicleTools);
  vehicleTools.execute = async (toolCall) => {
    record(calls, "vehicle.adapter.execute", toolCall);
    // `provider.write` is the Task 1 compatibility alias for Adapter dispatch,
    // not a VehicleStateProvider mutation; the latter is `provider.ingestObservation`.
    record(calls, "provider.write", toolCall);
    return executeVehicleTool(toolCall);
  };

  const sensorSimulator = new DemoSensorSimulator({
    now: () => new Date(now()),
    scheduler: (callback) => callback(),
    initialVehicleState: safetyValues,
  });
  instrumentMethod(sensorSimulator, "submit", "sensor.submit", calls);

  const vehicleExecutionCoordinator = new VehicleExecutionCoordinator({
    vehicleTools,
    sensorSimulator,
    vehicleStateProvider,
    now,
    timeoutScheduler: () => () => {},
  });
  instrumentMethod(vehicleExecutionCoordinator, "execute", "vehicle.execute", calls);

  const safetyGateway = new SafetyGateway({}, { now });
  instrumentMethod(safetyGateway, "evaluate", "safety.evaluate", calls);

  const localModel = {
    async parse(text, input) {
      record(calls, "semantic.parse", { route, text, input });
      const custom = typeof options.modelBehavior?.parse === "function"
        ? await options.modelBehavior.parse(text, input)
        : null;
      if (custom?.semanticEnvelope || custom?.executionDisabled === true) return custom;
      const command = custom?.command
        ?? parseCommandWithSemanticPolicy(text, { requestId: input.requestId });
      return {
        semanticEnvelope: createHarnessSemanticEnvelope(command, text, input.requestId),
        telemetry: custom?.telemetry
          ?? { provider: "compatibility-harness", model: "deterministic" },
      };
    },
  };
  const manualRetriever = async (query, input) => {
    record(calls, "manual.retrieve", { query, input });
    return Object.assign([manualChunk()], {
      metadata: { retrievalMode: "compatibility-fixture", embeddingStatus: "ready" },
    });
  };
  const refreshVehicleState = async (input) => {
    record(calls, "provider.refresh", input);
    return { ok: true, snapshot: vehicleStateProvider.getSnapshot() };
  };
  const refreshVehicleStateForSafety = async (input) => {
    record(calls, "provider.refresh", input);
    return vehicleStateProvider.ingestDemoSensorState({
      source: "demo-sensor-simulator",
      simulated: true,
      capturedAt: new Date(now()).toISOString(),
      values: safetyValues,
    });
  };
  const readVehicleStateSnapshot = () => vehicleStateProvider.getSnapshot();
  const externalDataAdapter = {
    async execute(toolCall, input) {
      record(calls, "external.execute", { toolCall, input });
      return {
        requestId: toolCall.requestId,
        commandId: toolCall.commandId,
        tool: toolCall.tool,
        ok: true,
        executionState: "accepted",
        statePatch: {
          weatherData: {
            provider: "compatibility-weather",
            source: "https://compatibility.invalid/weather",
            fetchedAt: new Date(now()).toISOString(),
            location: { city: "上海", resolution: "city-name", defaulted: false },
            forecast: [{
              date: "2026-08-05",
              weatherDescription: "小雨",
              temperatureMin: 25,
              temperatureMax: 30,
              precipitationProbabilityMax: 70,
            }],
            units: { temperature2m: "°C", precipitationProbability: "%" },
          },
        },
        observedState: {},
        statePatchSource: "weather-api-grounding",
        executionTrace: [{ state: "accepted", source: "weather-api-adapter", at: new Date(now()).toISOString() }],
        hmiSummary: "上海明天小雨，25°C到30°C。",
        visualScenario: "planning",
        source: "weather-api-adapter",
        simulated: false,
        timestamp: new Date(now()).toISOString(),
        evidenceRefs: [{
          id: `weather:${toolCall.requestId}`,
          source: "compatibility-weather",
          type: "external-weather",
          title: "上海天气",
          citation: "https://compatibility.invalid/weather",
        }],
      };
    },
  };
  const cloudAdapter = {
    async converse(...input) { record(calls, "cloud.converse", input); return { summary: "兼容性对话回复", telemetry: {} }; },
    async plan(...input) { record(calls, "cloud.plan", input); return { summary: "兼容性规划回复", telemetry: {} }; },
    async explain(...input) { record(calls, "cloud.explain", input); return { summary: "兼容性安全说明", telemetry: {} }; },
  };
  const knowledgeModelAdapter = {
    async createTaskPlan() { throw new Error("knowledge controller task planning must not be reached"); },
    async formGoal() { throw new Error("knowledge controller goal formation must not be reached"); },
    async synthesizeAgentResponse() { throw new Error("knowledge controller general synthesis must not be reached"); },
    async createVehicleKnowledgeSubplan(input) {
      record(calls, "knowledge.plan", input);
      record(calls, "cloud.plan", input);
      return createKnowledgePlanModelResult(input.delegation);
    },
    async synthesizeVehicleKnowledgeAnswer(input) {
      record(calls, "knowledge.synthesize", input);
      record(calls, "cloud.explain", input);
      return createKnowledgeSynthesisModelResult(input);
    },
  };
  const knowledgeOrchestratorController = new OrchestratorController({
    modelAdapter: knowledgeModelAdapter,
    now,
  });
  const knowledgeCabinController = new CabinAssistantController({
    modelAdapter: knowledgeModelAdapter,
    now,
  });
  const cabin = Object.freeze({
    async formGoal(input) {
      record(calls, "cabin.formGoal", input);
      throw new TypeError("Vehicle-SLU compatibility orchestration must bypass cabin.formGoal");
    },
    async respondForeground(input) {
      record(calls, "cabin.respondForeground", input);
      return { text: "我先读取当前车辆状态。", telemetry: { model: "deterministic", provider: "compatibility-harness" } };
    },
    async synthesize(input) {
      record(calls, "cabin.synthesize", input);
      return { text: "已读取当前车辆状态。", telemetry: { model: "deterministic", provider: "compatibility-harness" } };
    },
    async composeKnowledgeResponse(input) {
      return knowledgeCabinController.composeKnowledgeResponse(input);
    },
    presentKnowledgeBoundary(input) {
      return knowledgeCabinController.presentKnowledgeBoundary(input);
    },
  });
  const orchestrator = Object.freeze({
    async plan(input) {
      record(calls, "orchestrator.plan", input);
      const deferred = new Set(input.semanticAuthority?.deferredFrameIds ?? []);
      const frames = input.semanticEnvelope?.vehicleFrames?.filter(
        (frame) => !deferred.has(frame.frameId),
      ) ?? [];
      const steps = frames.map((frame) => {
        const capabilityId = {
          "vehicle.knowledge.query": "manual.retrieve",
          "vehicle.state.query": "vehicle-state-provider.read",
          "weather.query": "external.query",
        }[frame.intent];
        const prefix = {
          "vehicle.knowledge.query": "knowledge",
          "vehicle.state.query": "state",
          "weather.query": "weather",
        }[frame.intent];
        const stepInput = projectVehicleSluReadonlyStepInput(frame);
        if (!capabilityId || !prefix || !stepInput) {
          throw new TypeError("compatibility orchestrator supports registered readonly frames only");
        }
        return {
          stepId: `${prefix}-${frame.frameId}`,
          capabilityId,
          dependsOn: [],
          input: stepInput,
          expectedOutput: `${prefix}-result`,
          accessMode: "read",
          status: "planned",
        };
      });
      if (steps.length === 0) {
        throw new TypeError("compatibility orchestrator requires one registered readonly frame");
      }
      const taskPlan = createTaskPlan({
        planId: `plan:${input.runId}:compatibility-state`,
        goalId: input.goalEnvelope.goalId,
        runId: input.runId,
        steps,
        selectedCapabilities: steps.map(({ capabilityId }) => capabilityId),
        writeActionCount: 0,
        planningSummary: "Execute the registered VehicleStateProvider read only.",
        model: "deterministic",
        provider: "compatibility-harness",
        status: "planned",
      });
      return {
        taskPlan,
        validation: Object.freeze({ ok: true, status: "plan-valid", errors: Object.freeze([]), plan: taskPlan }),
        telemetry: Object.freeze({ model: "deterministic", provider: "compatibility-harness", degraded: false }),
      };
    },
    async planKnowledgeTask(input) {
      record(calls, "orchestrator.planKnowledgeTask", input);
      return knowledgeOrchestratorController.planKnowledgeTask(input);
    },
  });

  calls.length = 0;
  return {
    now,
    localModel,
    safetyGateway,
    vehicleStateProvider,
    vehicleExecutionCoordinator,
    manualRetriever,
    refreshVehicleState,
    refreshVehicleStateForSafety,
    readVehicleStateSnapshot,
    externalDataAdapter,
    cloudAdapter,
    cabin,
    orchestrator,
    calls,
    recordCall(name, input) { record(calls, name, input); },
    instrumentSessionMemoryRead: route === "mixed-state-media-runtime-owner",
  };
}

function createRuntimeUnderTest(dependencies) {
  const vehicleKnowledgeUseCase = createVehicleKnowledgeUseCase({
    orchestratorController: dependencies.orchestrator,
    cabinAssistantController: dependencies.cabin,
    manualRetriever: dependencies.manualRetriever,
    refreshVehicleState: dependencies.refreshVehicleState,
    readVehicleStateSnapshot: dependencies.readVehicleStateSnapshot,
    safetyGateway: dependencies.safetyGateway,
    now: dependencies.now,
  });
  const vehicleControlUseCase = createVehicleControlUseCase({
    refreshVehicleStateForSafety: dependencies.refreshVehicleStateForSafety,
    vehicleStateProvider: dependencies.vehicleStateProvider,
    safetyGateway: dependencies.safetyGateway,
    vehicleExecutionCoordinator: dependencies.vehicleExecutionCoordinator,
    now: dependencies.now,
  });
  const sessionMemory = new SessionMemory({ now: dependencies.now });
  if (dependencies.instrumentSessionMemoryRead) {
    instrumentMethod(sessionMemory, "buildConversationHint", "session-memory.read", dependencies.calls);
  }
  const manualRetrieveCapabilityOwner = createManualRetrieveCapabilityOwner({
    manualRetriever: dependencies.manualRetriever,
    projectEvidenceRef: projectHarnessManualEvidenceRef,
  });
  return new RuntimeKernel({
    routePolicy: new RoutePolicy({ localModel: dependencies.localModel }),
    useCases: Object.freeze({
      chat: createChatUseCase({ cloudAdapter: dependencies.cloudAdapter }),
      "vehicle-knowledge": vehicleKnowledgeUseCase,
      "vehicle-control": vehicleControlUseCase,
      task: createComplexTaskUseCase({
        externalDataAdapter: dependencies.externalDataAdapter,
        cabin: dependencies.cabin,
        orchestrator: dependencies.orchestrator,
        createExecutionLedger: createTaskPlanExecution,
        capabilityOwners: {
          "manual.retrieve": Object.freeze({
            async execute(input) {
              dependencies.recordCall("knowledge.owner.execute", { step: input.step });
              return manualRetrieveCapabilityOwner.execute(input);
            },
          }),
          "vehicle-state-provider.read": Object.freeze({
            async execute({ context, step }) {
              dependencies.recordCall("state.owner.execute", { step });
              const scoped = createVehicleSluReadonlyStepScope({
                semanticEnvelope: context.semanticEnvelope,
                semanticAuthority: context.semanticAuthority,
                step,
              });
              return vehicleKnowledgeUseCase.execute({ ...context, semanticEnvelope: scoped.semanticEnvelope });
            },
          }),
          "external.query": Object.freeze({
            async execute({ context, step, signal, deadlineAt }) {
              dependencies.recordCall("external.owner.execute", { step });
              const weatherAuthority = createVehicleSluWeatherStepAuthority({
                semanticEnvelope: context.semanticEnvelope,
                semanticAuthority: context.semanticAuthority,
                step,
              });
              const result = await dependencies.externalDataAdapter.execute({
                requestId: context.runId,
                commandId: `${context.runId}:${step.stepId}:1:external.query`,
                tool: weatherAuthority.tool,
                args: weatherAuthority.args,
              }, { signal, deadlineAt });
              if (result?.ok !== true) throw new Error(result?.executionError?.code || "external-owner-failed");
              return {
                summary: result.hmiSummary || "外部只读查询已完成。",
                evidenceRefs: result.evidenceRefs || [],
              };
            },
          }),
        },
      }),
    }),
    runEventLedger: new RunEventLedger(),
    sessionMemory,
    pendingClarifications: new PendingClarificationStore(),
    now: dependencies.now,
    createRequestId: () => "unexpected-compatibility-request-id",
  });
}

function instrumentMethod(target, method, name, calls) {
  const original = target[method].bind(target);
  target[method] = (...input) => {
    record(calls, name, input.length === 1 ? input[0] : input);
    return original(...input);
  };
}

function record(calls, name, input) {
  calls.push({ name, input });
}

function createMonotonicClock() {
  let value = Date.parse("2026-08-04T00:00:00.000Z");
  return () => {
    value += 1;
    return value;
  };
}

function createMonotonicClockFrom(start) {
  let value = start;
  return () => value++;
}

function createResolvedKnowledgeRoutePolicy() {
  return Object.freeze({
    async resolve(rawText, options = {}) {
      const parsedCommand = parseCommandWithSemanticPolicy(rawText, { requestId: options.requestId });
      const otherModel = /\b(?:ET|EC|EL|EP|ES)(?!8\b)\s*[- ]?\d{1,2}\b/i.test(rawText)
        || /\bET5\b/i.test(rawText);
      // Test-only stand-in for the Vehicle-SLU model: emit the knowledge frame it would produce.
      const query = String(rawText || "").trim();
      const knowledgeFrame = {
        frameId: `frame:${options.requestId}:knowledge`,
        capability: "knowledge",
        intent: "vehicle.knowledge.query",
        speechAct: "question",
        knowledgeNeed: "manual",
        actionNeed: "none",
        slots: {
          query,
          vehicleModel: otherModel ? "other" : "ES8",
          ...(isTailgateEligibilityQuestion(query) ? { eligibilityAction: "body.tailgate.open" } : {}),
        },
        missingSlots: [],
        clarificationQuestion: null,
        standaloneQuery: query,
        confidence: 1,
      };
      // Like the model, split a question that compares several component groups into one frame each.
      const componentGroupCount = [/尾门|后备箱/, /车窗|防夹/, /座椅|靠背/, /空调|温度|风量/]
        .filter((pattern) => pattern.test(query)).length;
      // An actionable vehicle command is not a knowledge question, so the model emits no knowledge frame.
      const knowledgeFrames = parsedCommand.actionability?.actionable === true ? []
        : componentGroupCount > 1
        ? Array.from({ length: componentGroupCount }, (_, index) => ({ ...knowledgeFrame, frameId: `${knowledgeFrame.frameId}:${index + 1}` }))
        : [knowledgeFrame];
      return {
        decision: createRouteDecision({
          disposition: "execute",
          routeId: "vehicle-knowledge",
          mode: "direct",
          confidence: 1,
          reasonCode: otherModel ? "vehicle-knowledge-not-applicable" : "trusted-vehicle-knowledge",
          semanticSource: "deterministic",
          normalizedIntentRef: { requestId: options.requestId, intent: parsedCommand.intent },
          runId: options.runId,
        }),
        parsedCommand,
        semanticEnvelope: createVehicleSluEnvelope({
          requestId: options.requestId,
          domain: knowledgeFrames.length ? "vehicle" : "unknown",
          conversationGoal: { summary: query.slice(0, 240), need: knowledgeFrames.length ? "explain" : "none" },
          vehicleFrames: knowledgeFrames,
          domainConfidence: 1,
        }),
        semanticTelemetry: Object.freeze({ source: "deterministic" }),
      };
    },
  });
}

function createHarnessSemanticEnvelope(command, rawText, requestId) {
  const requestedIntent = command.slots?.requestedIntent;
  const intent = command.intent !== "conversation.general" ? command.intent : requestedIntent;
  const control = projectHarnessControlFrame(intent, command);
  const knowledge = command.slots?.topic === "vehicle_knowledge";
  const weather = command.slots?.topic === "weather_query";
  const frames = control
    ? [control]
    : knowledge
      ? [{
          frameId: `frame:${requestId}:knowledge`,
          capability: "knowledge",
          intent: "vehicle.knowledge.query",
          speechAct: "question",
          knowledgeNeed: "manual",
          actionNeed: "none",
          slots: {
            query: rawText,
            vehicleModel: /\b(?:ET|EC|EL|EP|ES)(?!8\b)\s*[- ]?\d{1,2}\b/i.test(rawText) ? "other" : "ES8",
          },
          missingSlots: [],
          clarificationQuestion: null,
          standaloneQuery: rawText,
          confidence: command.confidence,
        }]
      : weather
        ? [{
            frameId: `frame:${requestId}:weather`,
            capability: "weather",
            intent: "weather.query",
            speechAct: "question",
            knowledgeNeed: "none",
            actionNeed: "none",
            slots: {},
            missingSlots: [],
            clarificationQuestion: null,
            standaloneQuery: null,
            confidence: command.confidence,
          }]
        : [];
  return {
    contractVersion: "nio-vehicle-slu-contract@2.0.0",
    requestId,
    domain: frames.length ? "vehicle" : "non_vehicle",
    conversationGoal: {
      summary: rawText,
      need: knowledge || weather ? "explain" : frames.length === 0 ? "social" : "none",
    },
    vehicleFrames: frames,
    domainConfidence: command.confidence,
  };
}

function projectHarnessControlFrame(intent, command) {
  const definitions = {
    "body.window.setPosition": ["window", { zone: command.slots?.zone, percent: command.slots?.percent }],
    "body.tailgate.open": ["tailgate", { open: command.slots?.open }],
    "seat.driver.setBackrestAngle": ["seat", { seat: command.slots?.seat, angle: command.slots?.angle }],
    "vehicle.component.setState": ["vehicle-component", { actionId: command.slots?.actionId, value: command.slots?.value }],
    "cabin.climate.setPreset": ["climate", { temperature: command.slots?.temperature }],
  };
  const definition = definitions[intent];
  if (!definition) return null;
  const [id, candidates] = definition;
  const slots = Object.fromEntries(Object.entries(candidates).filter(([, value]) => value !== undefined));
  const actionNeed = command.slots?.needsClarification === true ? "clarify" : "execute";
  const missingSlots = actionNeed === "clarify" ? harnessMissingSlots(intent, slots) : [];
  return {
    frameId: `frame:${command.requestId}:${id}`,
    capability: "control",
    intent,
    speechAct: "command",
    knowledgeNeed: "none",
    actionNeed,
    slots,
    missingSlots,
    clarificationQuestion: actionNeed === "clarify" ? harnessClarificationQuestion(missingSlots) : null,
    standaloneQuery: null,
    confidence: command.confidence,
  };
}

function harnessMissingSlots(intent, slots) {
  const required = {
    "body.window.setPosition": ["zone", "percent"],
    "body.tailgate.open": ["open"],
    "seat.driver.setBackrestAngle": ["seat", "angle"],
    "vehicle.component.setState": ["actionId", "value"],
    "cabin.climate.setPreset": ["temperature"],
  }[intent] || [];
  return required.filter((slot) => !Object.hasOwn(slots, slot));
}

function harnessClarificationQuestion(missingSlots) {
  const labels = {
    zone: "哪一扇车窗",
    percent: "车窗开度",
    open: "尾门打开或关闭",
    seat: "哪个座椅",
    angle: "靠背角度",
    temperature: "目标温度",
  };
  return `请告诉我${missingSlots.map((slot) => labels[slot] || slot).join("、")}。`;
}

function createKnowledgePlanModelResult(delegation) {
  const steps = [
    {
      stepId: "manual",
      capabilityId: "knowledge.manual.retrieve",
      dependsOn: [],
      input: { query: delegation.knowledgeGoal },
      expectedOutput: "manual-evidence",
      accessMode: "read",
      status: "planned",
    },
    {
      stepId: "answer",
      capabilityId: "knowledge.answer.synthesize",
      dependsOn: ["manual"],
      input: { facts: { summary: "仅基于已检索证据回答。", evidenceRefs: ["manual"] } },
      expectedOutput: "knowledge-answer",
      accessMode: "read",
      status: "planned",
    },
  ];
  return {
    output: {
      subplanId: `subplan:${delegation.runId}:model`,
      delegationId: delegation.delegationId,
      runId: delegation.runId,
      parentPlanId: delegation.parentPlanId,
      parentStepId: delegation.parentStepId,
      steps,
      selectedCapabilities: steps.map((step) => step.capabilityId),
      planningSummary: "仅计划已授权的车辆知识读操作。",
      model: "fake-knowledge-plan",
      provider: "fake-cloud",
      status: "planned",
    },
    telemetry: {
      model: "fake-knowledge-plan",
      provider: "fake-cloud",
      durationMs: 1,
      degraded: false,
    },
  };
}

function withPrivateTelemetryReason(result, reason) {
  if (typeof reason !== "string" || !reason) return result;
  return {
    ...result,
    telemetry: { ...result.telemetry, reason },
  };
}

function createKnowledgeSynthesisModelResult({ delegation, executionFacts }) {
  const supported = executionFacts.evidenceRefs.length > 0;
  return {
    output: {
      delegationId: delegation.delegationId,
      runId: delegation.runId,
      outcomeStatus: "answered",
      supportStatus: supported ? "supported" : "unsupported",
      answer: supported
        ? "根据已检索的 ES8 手册证据，请在操作前确认相关安全条件。"
        : "未在 ES8 用户手册检索中找到相关证据，无法给出结论。",
      evidenceRefs: executionFacts.evidenceRefs,
      vehicleStateRefs: executionFacts.vehicleStateRefs,
      safetyAssessmentRef: executionFacts.safetyAssessmentRef,
      limitations: supported ? [] : ["未检索到可用的 ES8 手册证据。"],
      model: "fake-knowledge-answer",
      provider: "fake-cloud",
      durationMs: 1,
      degraded: !supported,
    },
    telemetry: {
      model: "fake-knowledge-answer",
      provider: "fake-cloud",
      durationMs: 1,
      degraded: !supported,
    },
  };
}

function manualChunk() {
  return {
    chunkId: "manual:tailgate",
    sourceId: "nio-es8-user-manual-2026",
    sourceVersion: "2026.07",
    pageStart: 88,
    pageEnd: 89,
    score: { retrieval: 0.92, rerank: null, grounding: 0.95 },
    title: "ES8 用户手册",
    citation: "尾门章节",
    text: "开启尾门前应确认开闭路径附近没有障碍物。",
  };
}

function projectHarnessManualEvidenceRef(chunk) {
  return Object.freeze({
    sourceId: String(chunk.sourceId || "nio-es8-user-manual-2026"),
    sourceVersion: String(chunk.sourceVersion || "2026.07"),
    chunkId: String(chunk.chunkId || "manual-evidence"),
    pageStart: Number.isInteger(chunk.pageStart) ? chunk.pageStart : 1,
    pageEnd: Number.isInteger(chunk.pageEnd) ? chunk.pageEnd : 1,
    excerpt: String(chunk.excerpt || chunk.text || "ES8 用户手册证据"),
    score: Object.freeze({
      retrieval: Number.isFinite(chunk.score?.retrieval) ? chunk.score.retrieval : 1,
      rerank: Number.isFinite(chunk.score?.rerank) ? chunk.score.rerank : null,
      grounding: Number.isFinite(chunk.score?.grounding) ? chunk.score.grounding : null,
    }),
  });
}
