import { RuntimeKernel } from "../application/runtime-kernel.js";
import { RoutePolicy } from "../application/route-policy.js";
import { createChatUseCase } from "../application/use-cases/chat.js";
import { createVehicleKnowledgeUseCase } from "../application/use-cases/vehicle-knowledge.js";
import { createVehicleControlUseCase } from "../application/use-cases/vehicle-control.js";
import {
  createComplexTaskUseCase,
  createManualRetrieveCapabilityOwner,
} from "../application/use-cases/complex-task.js";
import { LocalModelAdapter } from "../semantic/local-model-adapter.js";
import {
  createVehicleSluReadonlyStepScope,
  createVehicleSluWeatherStepAuthority,
} from "../semantic/vehicle-slu-orchestration.js";
import { RunEventLedger } from "../runtime/run-event-ledger.js";
import { PendingClarificationStore } from "../runtime/pending-clarification-store.js";
import { SessionMemory } from "../runtime/session-memory.js";
import { SAFETY_BASELINE } from "../runtime/agent-schemas.js";
import { ExternalDataAdapter } from "../external-data/external-data-adapter.js";
import { prepareManualRetrievalCandidate } from "../manual/manual-retrieval-candidate.js";
import { isTrustedManualRagConsumerEvidence } from "../manual/manual-evidence-eligibility.js";
import { createRuntimePresentationBridge } from "./runtime-presentation-bridge.js";
import { CloudLLMAdapter } from "../runtime/cloud-llm-adapter.js";
import { loadModelProviderProfile } from "./model-provider-profile.js";
import {
  applyRuntimeActiveLevels,
  applyVehicleAssetStatus,
  loadDemoReadiness,
  projectDemoReadinessView,
  shouldRetryDemoLocalWarmup,
} from "./demo-readiness-panel.js";
import { CabinAssistantController } from "../agents/cabin-assistant-controller.js";
import { OrchestratorController } from "../agents/orchestrator-controller.js";
import { createTaskPlanExecution } from "../runtime/task-plan-execution.js";
import { RUN_EVENT_PROTOCOL } from "../runtime/run-event-protocol.js";
import {
  buildHmiRunDebugSnapshot,
  buildInteractionSessionDebugSnapshot,
  buildPendingConfirmationDebugSnapshot,
  buildPendingConfirmationViewModel,
  buildProviderSnapshotSummary,
  buildRunEventDebugSnapshot,
  buildRunDetailViewModel,
  buildRunEventViewModel,
  buildRuntimeResultDebugSnapshot,
  createSafeRunEventProjectionListener,
  createStableHmiRunDebugFacade,
  getB2VisibleCardKinds,
} from "./run-event-presenter.js";
import {
  applyExternalDataHmiAnimation,
  applyHmiPresentation,
  mapVehicleExecutionToHmi,
  registerDispatchedVehicleCommand,
  reduceVehicleHmiState,
  resolveModeByScenario,
} from "../vehicle/hmi-animation-adapter.js";
import {
  VoiceOutputAdapter,
  buildVehicleSpeechText,
  createResponseEnvelope,
  getVehicleSpeechTextPolicy,
  waitForVoicePlaybackCompletion,
} from "../voice/voice-output-adapter.js";
import { LocalVoiceGatewayClient } from "../voice/local-voice-gateway-client.js";
import { VoiceCaptureController } from "../voice/voice-capture-controller.js";
import { classifyLocalWakeTranscript } from "../voice/local-wake-transcript.js";
import {
  isCurrentVoiceFollowUpWindow,
  shouldStartAutomaticVoiceFollowUp,
} from "./voice-follow-up-policy.js";
import {
  cancelVoiceIdentityCalibration,
  cancelVoiceIdentityEnrollment,
  createUnavailableVoiceIdentityStatus,
  deleteVoiceIdentityProfile,
  loadVoiceIdentityStatus,
  PRIMARY_DRIVER_CALIBRATION_SAMPLE_COUNT,
  PRIMARY_DRIVER_CALIBRATION_STEPS,
  PRIMARY_DRIVER_ENROLLMENT_PHRASES,
  projectVoiceIdentityView,
  startVoiceIdentityCalibration,
  startVoiceIdentityEnrollment,
  submitVoiceIdentityCalibrationSample,
  submitVoiceIdentitySample,
  VOICE_IDENTITY_OUTCOME_LABELS,
} from "./voice-identity-enrollment.js";
import { VoiceIdentityPcmRecorder } from "./voice-identity-capture.js";
import { DevVehicleStateProvider } from "../safety/vehicle-state.js";
import { classifyRuntimeResult } from "../application/result-semantics.js";
import {
  SafetyGateway,
  VEHICLE_STATE_FRESHNESS_POLICY,
} from "../safety/safety-gateway.js";
import { VehicleTools } from "../vehicle/vehicle-tools.js";
import { DemoSensorSimulator } from "../vehicle/demo-sensor-simulator.js";
import {
  applyDemoScenario as applyScenarioToProvider,
  getDemoScenario,
  normalizeDemoScenarioInput,
} from "../vehicle/demo-scenario-catalog.js";
import {
  ES7_ACTION_CATALOG,
  ES7_GENERIC_ACTION_IDS,
} from "../vehicle/es7-action-catalog.js";
import { DeveloperVehicleStateController } from "./developer-vehicle-state-controller.js";
import { VehicleExecutionCoordinator } from "../vehicle/vehicle-execution-coordinator.js";
import { createSafetyStateRefresh } from "./safety-state-refresh.js";
import {
  applyAppRuntimeVehicleEventEffects,
  reduceAppRuntimeVehicleEvent,
  reduceAppRuntimeVehicleResult,
  selectAppRuntimeVehicleMetricsSnapshot,
} from "./runtime-result-state.js";
import { InteractionSessionController } from "../interaction/interaction-session-controller.js";
import { BrowserTranscriptWakeWordProvider } from "../interaction/wake-word-provider.js";
import { classifyExplicitTurnGate } from "../interaction/turn-relation.js";
import { createConfirmationDecisionGate } from "./confirmation-decision-gate.js";
import {
  createManualEvidencePresentation,
  createManualEvidenceRunState,
  createManualSafetyEvidencePresentation,
  projectTrustedManualEvidenceRef,
  reduceManualEvidenceRun,
  resolveManualEvidenceAnswer,
  retrieveManualEvidenceFromBrowser,
} from "./manual-evidence-link.js";
import {
  buildBenchmarkVehicleFaultReceipt,
  observeBenchmarkCoordinatorSettlement,
  observeBenchmarkSensorSubmission,
  projectBenchmarkVehicleEvidence,
  resetBenchmarkRunEvidenceState,
  resolveBenchmarkFaultProfile,
  verifyBenchmarkFaultReceipt,
} from "../benchmark/benchmark-fault-profile.js";

const appBootStartedAt = Date.now();
const VOICE_IDENTITY_CONFIRMATION_ENABLED = window.NIO_VOICE_IDENTITY_CONFIRMATION_ENABLED === true;
const components = [];
const participantTypeLabels = Object.freeze({
  "ai-agent": "AI Agent",
  "model-service": "Model Service",
  "deterministic-service": "Deterministic Service",
  "tool-interface": "Tool / Interface",
  presentation: "Presentation",
});
const componentPresentationById = new Map([
  ["cabinAssistant", { tier: "AI Agent", role: "与用户沟通并负责最终回答" }],
  ["orchestrator", { tier: "AI Agent", role: "复杂目标规划与协同" }],
  ["vehicleSluModel", { tier: "车端模型", role: "车辆语义理解" }],
  ["cabinModel", { tier: "座舱模型", role: "对话与答案生成" }],
  ["orchestratorModel", { tier: "规划模型", role: "任务与知识计划生成" }],
  ["ragEmbeddingModel", { tier: "RAG 模型", role: "查询向量化" }],
  ["ragRerankModel", { tier: "RAG 模型", role: "证据重排" }],
  ["runtimeKernel", { tier: "确定性服务", role: "运行时编排入口" }],
  ["manualRetriever", { tier: "确定性服务", role: "用户手册检索与证据约束" }],
  ["safety", { tier: "确定性服务", role: "车辆动作安全裁决" }],
  ["vehicleStateProvider", { tier: "确定性服务", role: "车辆状态唯一事实源" }],
  ["confirmation", { tier: "确定性服务", role: "高风险动作确认" }],
  ["voiceBridgeEligibility", { tier: "确定性服务", role: "等待提示授权策略" }],
  ["vehicleTool", { tier: "工具接口", role: "车辆动作派发与终态关联" }],
  ["externalDataAdapter", { tier: "工具接口", role: "只读外部数据访问" }],
  ["responsePresentation", { tier: "呈现层", role: "结果与任务状态呈现" }],
]);

const quickCommands = {
  trip: "帮我规划明天从上海到杭州的路线，优先换电。",
  family: "车里有孩子，把空调调到24度并降低后排风量。",
  energy: "现在电量还够到目的地吗？帮我找最近的换电站。",
  offline: "如果高速上断网了，还能继续导航和控制空调吗？",
  safety: "行驶中帮我关闭所有安全提醒。",
  windowControl: "帮我打开主驾车窗到一半。",
  trunkControl: "帮我打开后备箱。",
  seatControl: "把主驾座椅靠背调到112度。",
};

const quickVehicleStatePatches = {
  safety: { speedKph: 62, gear: "D" },
};

const WINDOW_ZONE_BY_ACTION_ID = Object.freeze({
  front_left_window_open: "front_left",
  front_right_window_open: "front_right",
  rear_left_window_open: "rear_left",
  rear_right_window_open: "rear_right",
});
const DEVELOPER_SEAT_ACTION_IDS = Object.freeze([
  "driver_seat_fore_aft",
  "driver_seat_height",
  "driver_seat_backrest_recline",
  "driver_seat_headrest_height",
]);
const DEMO_INITIAL_VEHICLE_STATE = Object.freeze({
  windowPositionPercentByZone: Object.freeze({
    front_left: 0,
    front_right: 0,
    rear_left: 0,
    rear_right: 0,
  }),
  vehicleLocked: false,
  tailgateOpen: false,
  driverBackrestAngle: SAFETY_BASELINE.seat.defaultAngle,
  componentActionStateById: Object.freeze(Object.fromEntries(
    ES7_GENERIC_ACTION_IDS.map((actionId) => [actionId, ES7_ACTION_CATALOG[actionId].defaultValue]),
  )),
  cabinTemperature: 22,
  climatePower: false,
  climateMode: "auto",
  fanLevel: 0,
  airflow: "auto",
  passengerMode: "comfort",
  seatComfortByZone: Object.freeze(Object.fromEntries(
    ["driver", "passenger", "row2_left", "row2_right", "row3_left", "row3_right"]
      .map((zone) => [zone, Object.freeze({ mode: "off", level: 0 })]),
  )),
  batteryPercent: 72,
  speedKph: 0,
  gear: "P",
  rearClearance: null,
  windowAntiPinchAvailable: true,
  rainDetected: false,
});

const vehicleTools = new VehicleTools();
const demoSensorSimulator = new DemoSensorSimulator({
  defaultLatencyMs: 450,
  initialVehicleState: DEMO_INITIAL_VEHICLE_STATE,
});
const vehicleStateProvider = new DevVehicleStateProvider();
vehicleStateProvider.ingestDemoSensorState(demoSensorSimulator.readVehicleState());
const safetyStateRefresh = createSafetyStateRefresh({
  vehicleStateProvider,
  readVehicleState: () => demoSensorSimulator.readVehicleState(),
});
const vehicleExecutionCoordinator = new VehicleExecutionCoordinator({
  vehicleTools,
  sensorSimulator: demoSensorSimulator,
  vehicleStateProvider,
});

const benchmarkFaultProfileId = typeof window.NIO_BENCHMARK_FAULT_PROFILE === "string"
  ? window.NIO_BENCHMARK_FAULT_PROFILE
  : null;
const benchmarkFaultsEnabled = window.NIO_DEV_BENCHMARK_FAULTS === true;
const benchmarkFaultProfile = benchmarkFaultProfileId === null
  ? null
  : resolveBenchmarkFaultProfile(benchmarkFaultProfileId, { enabled: benchmarkFaultsEnabled });
const benchmarkRunEvidenceState = {
  manualRagReceipt: null,
  confirmedAnimationCount: 0,
  runtimeResult: null,
  runId: null,
  sensorSubmissionMarkers: [],
  terminalSensorSubmissionMarkers: [],
};

function installBenchmarkManualRagTransport(profile) {
  if (profile?.target !== "manual-rag") return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url;
    if (url !== "/api/manual-rag") return originalFetch(input, init);
    const privateCandidate = new Headers(init.headers)
      .get("x-nio-private-manual-candidate") === "1";
    if (!privateCandidate) benchmarkRunEvidenceState.manualRagReceipt = null;
    const body = JSON.parse(String(init.body || "{}"));
    const response = await originalFetch(input, {
      ...init,
      body: JSON.stringify({ ...body, benchmarkFaultId: profile.id }),
    });
    try {
      const responseBody = await response.clone().json();
      if (!privateCandidate) {
        benchmarkRunEvidenceState.manualRagReceipt = verifyBenchmarkFaultReceipt(
          responseBody?.telemetry,
          profile,
        );
      }
    } catch {
      if (!privateCandidate) benchmarkRunEvidenceState.manualRagReceipt = null;
    }
    return response;
  };
}

installBenchmarkManualRagTransport(benchmarkFaultProfile);

void startRuntimeWarmup();
const modelProviderProfile = await loadModelProviderProfile({
  endpoint: "/api/model-provider-profile",
  timeoutMs: 1_500,
});

const cloudModelAdapter = new CloudLLMAdapter({
  endpoint: window.NIO_LOCAL_LLM_ENDPOINT || "",
  timeoutMs: window.NIO_LOCAL_LLM_TIMEOUT_MS || 30000,
  providerProfile: modelProviderProfile,
  conversationCompactOutput: window.NIO_LLM_CONVERSATION_COMPACT_OUTPUT !== false,
  benchmarkFaultsEnabled,
  benchmarkFaultId: benchmarkFaultProfile?.id,
});
const now = Date.now;
const localModel = new LocalModelAdapter({
  endpoint: window.NIO_LOCAL_MODEL_ENDPOINT || "",
  watchdogMs: window.NIO_LOCAL_MODEL_WATCHDOG_MS,
  model: window.NIO_LOCAL_MODEL_NAME || "local-semantic-parser",
  providerProfile: modelProviderProfile.tasks.vehicle_slu,
});
const routePolicy = new RoutePolicy({ localModel });
const safetyGateway = new SafetyGateway({}, { now });
const externalDataAdapter = new ExternalDataAdapter();
const runEventLedger = new RunEventLedger();
const sessionMemory = new SessionMemory({ now });
const pendingClarifications = new PendingClarificationStore();
const cabinAssistantController = new CabinAssistantController({ modelAdapter: cloudModelAdapter, now });
const orchestratorController = new OrchestratorController({ modelAdapter: cloudModelAdapter });
const manualRetriever = retrieveManualChunksFromBrowser;
const chatUseCase = createChatUseCase({ cloudAdapter: cloudModelAdapter });
const vehicleKnowledgeUseCase = createVehicleKnowledgeUseCase({
  orchestratorController,
  cabinAssistantController,
  manualRetriever,
  refreshVehicleState: safetyStateRefresh.refresh,
  readVehicleStateSnapshot: () => vehicleStateProvider.getSnapshot(),
  vehicleStateProvider,
  safetyGateway,
  now,
  monotonicNow: performance.now.bind(performance),
});

async function consumeVoiceIdentityProof(binding) {
  try {
    const response = await window.fetch("/api/local-voice/identity/proof/consume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(binding),
    });
    const body = await response.json().catch(() => ({}));
    return response.ok && body?.ok === true ? body : { ok: false };
  } catch {
    return { ok: false };
  }
}

const vehicleControlUseCase = createVehicleControlUseCase({
  refreshVehicleStateForSafety: safetyStateRefresh.refresh,
  vehicleStateProvider,
  safetyGateway,
  vehicleExecutionCoordinator,
  now,
  voiceIdentityProofVerifier: VOICE_IDENTITY_CONFIRMATION_ENABLED
    ? consumeVoiceIdentityProof
    : undefined,
});
const complexTaskCapabilityOwners = Object.freeze({
  "manual.retrieve": createManualRetrieveCapabilityOwner({
    manualRetriever,
    projectEvidenceRef: projectManualChunkEvidenceRef,
  }),
  "memory.read": Object.freeze({
    async execute({ context }) {
      const memoryRead = sessionMemory.buildConversationHint(context.interactionRef?.sessionId);
      return { summary: `已读取 ${memoryRead.hint.turns.length} 条不可执行会话记忆提示。` };
    },
  }),
  "external.query": Object.freeze({
    async execute({ step, context, signal, deadlineAt }) {
      const weatherAuthority = createVehicleSluWeatherStepAuthority({
        semanticEnvelope: context.semanticEnvelope,
        semanticAuthority: context.semanticAuthority,
        step,
      });
      const result = await externalDataAdapter.execute({
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
  "safety.evaluate": Object.freeze({
    async execute({ context, signal, deadlineAt }) {
      const refreshed = await safetyStateRefresh.refresh({
        runId: context.runId,
        requestId: context.runId,
        parsedCommand: context.parsedCommand,
        signal,
        deadlineAt,
      });
      const snapshot = vehicleStateProvider.getSnapshot();
      if (!refreshed?.ok || refreshed.snapshot !== snapshot) {
        throw new Error("shared-provider-refresh-mismatch");
      }
      return { safetyDecision: await safetyGateway.evaluate(context.parsedCommand, {
        vehicleStateSnapshot: snapshot,
      }) };
    },
  }),
  "confirmation.issue": Object.freeze({
    async execute() {
      return { summary: "车辆写入的确认挑战由 Vehicle Control 边界签发。" };
    },
  }),
  "vehicle-state-provider.read": Object.freeze({
    async execute({ step, context }) {
      const scoped = createVehicleSluReadonlyStepScope({
        semanticEnvelope: context.semanticEnvelope,
        semanticAuthority: context.semanticAuthority,
        step,
      });
      return vehicleKnowledgeUseCase.execute({ ...context, semanticEnvelope: scoped.semanticEnvelope });
    },
  }),
});
const complexTaskUseCase = createComplexTaskUseCase({
  externalDataAdapter,
  cabin: cabinAssistantController,
  orchestrator: orchestratorController,
  createExecutionLedger: createTaskPlanExecution,
  capabilityOwners: complexTaskCapabilityOwners,
  vehicleControl: vehicleControlUseCase,
  now,
});
const runtime = new RuntimeKernel({
  routePolicy,
  useCases: Object.freeze({
    chat: chatUseCase,
    "vehicle-knowledge": vehicleKnowledgeUseCase,
    "vehicle-control": vehicleControlUseCase,
    task: complexTaskUseCase,
  }),
  runEventLedger,
  sessionMemory,
  pendingClarifications,
  now,
  prepareManualRetrievalCandidate: prepareBrowserManualRetrievalCandidate,
});

async function retrieveManualChunksFromBrowser(query, options = {}) {
  const runId = typeof options.runId === "string" && options.runId.trim()
    ? options.runId.trim()
    : state.currentRun?.requestId;
  return retrieveManualEvidenceFromBrowser({
    query,
    runId,
    topK: options.topK || 5,
    vehicleModel: options.vehicleModel || "ES8",
    signal: options.signal,
    fetchImpl: window.fetch.bind(window),
    currentOrigin: window.location.origin,
    onTransition: transitionManualEvidenceRun,
  });
}

function prepareBrowserManualRetrievalCandidate({ runId, query, vehicleModel, signal }) {
  const privateTransitions = [];
  let privateBenchmarkReceipt = null;
  return prepareManualRetrievalCandidate({
    runId,
    query,
    vehicleModel,
    signal,
    retrieve: (candidateQuery, options) => retrieveManualEvidenceFromBrowser({
      query: candidateQuery,
      runId: options.runId,
      topK: 5,
      vehicleModel: options.vehicleModel,
      signal: options.signal,
      async fetchImpl(input, init = {}) {
        const headers = new Headers(init.headers);
        headers.set("x-nio-private-manual-candidate", "1");
        const response = await window.fetch(input, { ...init, headers });
        if (benchmarkFaultProfile?.target === "manual-rag") {
          try {
            const body = await response.clone().json();
            privateBenchmarkReceipt = verifyBenchmarkFaultReceipt(
              body?.telemetry,
              benchmarkFaultProfile,
            );
          } catch {
            privateBenchmarkReceipt = null;
          }
        }
        return response;
      },
      currentOrigin: window.location.origin,
      onTransition(event) {
        privateTransitions.push(event);
      },
    }),
    validateResult(result) {
      if (!isTrustedManualRagConsumerEvidence(result)) {
        throw new TypeError("candidate must preserve trusted Manual RAG evidence");
      }
      if (result.metadata?.status === "hit") {
        result.forEach(projectManualChunkEvidenceRef);
      }
      return result;
    },
    onConsume() {
      privateTransitions.forEach(transitionManualEvidenceRun);
      privateTransitions.length = 0;
      if (benchmarkFaultProfile?.target === "manual-rag") {
        benchmarkRunEvidenceState.manualRagReceipt = privateBenchmarkReceipt;
      }
    },
    monotonicNow: performance.now.bind(performance),
  });
}

function projectManualChunkEvidenceRef(chunk) {
  return projectTrustedManualEvidenceRef(chunk);
}

installBenchmarkWeatherQueryBridge();
installB2AcceptanceCounters();

function installBenchmarkWeatherQueryBridge() {
  if (benchmarkFaultProfile?.target !== "weather-adapter") return;
  const originalExecute = externalDataAdapter.execute.bind(externalDataAdapter);
  externalDataAdapter.execute = async (toolCall, options = {}) => {
    const benchmarkResult = await cloudModelAdapter.executeBenchmarkWeatherFaultQuery(
      toolCall,
      options,
    );
    return benchmarkResult || originalExecute(toolCall, options);
  };
}

function installB2AcceptanceCounters() {
  const counts = {
    safetyCallCount: 0,
    toolCallCount: 0,
    sensorSubmissionCount: 0,
    providerCallCount: 0,
    providerAcceptedCount: 0,
    providerStateChangeCount: 0,
    adapterAcceptedCount: 0,
    lastVehicleTerminalTransaction: null,
  };
  Object.defineProperty(window, "__b2AcceptanceCalls", {
    configurable: true,
    enumerable: true,
    get: () => counts,
  });
  if (window.NIO_B2_ACCEPTANCE_INSTRUMENTATION !== true) return;
  const wrap = (target, method, field) => {
    const original = target?.[method];
    if (typeof original !== "function") throw new TypeError(`B2 acceptance method unavailable: ${method}`);
    target[method] = (...args) => {
      counts[field] += 1;
      return original.apply(target, args);
    };
  };
  wrap(safetyGateway, "evaluate", "safetyCallCount");
  const executeVehicle = vehicleExecutionCoordinator.execute;
  vehicleExecutionCoordinator.execute = (...args) => {
    counts.toolCallCount += 1;
    return observeBenchmarkCoordinatorSettlement(
      benchmarkRunEvidenceState,
      () => executeVehicle.apply(vehicleExecutionCoordinator, args),
    );
  };
  const submitSensor = demoSensorSimulator.submit;
  demoSensorSimulator.submit = (...args) => {
    counts.sensorSubmissionCount += 1;
    return observeBenchmarkSensorSubmission(
      benchmarkRunEvidenceState,
      () => submitSensor.apply(demoSensorSimulator, args),
    );
  };
  const ingestObservation = vehicleStateProvider.ingestObservation;
  vehicleStateProvider.ingestObservation = (...args) => {
    counts.providerCallCount += 1;
    const beforeValues = vehicleStateProvider.getSnapshot()?.values;
    const outcome = ingestObservation.apply(vehicleStateProvider, args);
    if (outcome?.ok === true) {
      counts.providerAcceptedCount += 1;
      const afterValues = vehicleStateProvider.getSnapshot()?.values;
      if (JSON.stringify(beforeValues) !== JSON.stringify(afterValues)) {
        counts.providerStateChangeCount += 1;
      }
    }
    return outcome;
  };
  const executeVehicleTool = vehicleTools.execute;
  vehicleTools.execute = (...args) => Promise.resolve(executeVehicleTool.apply(vehicleTools, args))
    .then((result) => {
      if (result?.executionState === "accepted") counts.adapterAcceptedCount += 1;
      return result;
    });
}

function applyDemoScenario(idOrPatch) {
  const selectedScenario = normalizeDemoScenarioInput(idOrPatch);
  if (!selectedScenario) throw new TypeError("invalid demo scenario");
  return applyScenarioToProvider({
    simulator: demoSensorSimulator,
    vehicleStateProvider,
    scenario: selectedScenario,
  });
}

const voiceOutputAdapter = new VoiceOutputAdapter({
  provider: window.NIO_TTS_PROVIDER || "gpt-sovits",
  endpoint: window.NIO_TTS_ENDPOINT || "/api/tts",
  // Experimental only: set true from a local test harness; normal HMI stays buffered.
  streamingPoc: window.NIO_TTS_STREAMING_POC === true,
  streamingEndpoint: window.NIO_TTS_STREAMING_ENDPOINT || "/api/tts-streaming-poc",
  // Default-on but explicitly auditable. Set false to disable the neutral
  // browser bridge without changing the final TTS or Safety path.
  bridgeEnabled: window.NIO_TTS_BRIDGE_ENABLED !== false,
});
const interactionSessionController = new InteractionSessionController();
const wakeWordProvider = new BrowserTranscriptWakeWordProvider();
const localVoiceGatewayClient = typeof window.WebSocket === "function"
  ? new LocalVoiceGatewayClient()
  : null;
const voiceCaptureController = localVoiceGatewayClient
  && navigator.mediaDevices?.getUserMedia
  && (window.AudioContext || window.webkitAudioContext)
  ? new VoiceCaptureController({
    gateway: localVoiceGatewayClient,
    allowSimulated: window.NIO_LOCAL_VOICE_ALLOW_SIMULATED === true,
  })
  : null;
const voiceIdentityRecorder = VOICE_IDENTITY_CONFIRMATION_ENABLED
  && navigator.mediaDevices?.getUserMedia
  && (window.AudioContext || window.webkitAudioContext)
  ? new VoiceIdentityPcmRecorder()
  : null;
const voiceConfirmationRecorder = VOICE_IDENTITY_CONFIRMATION_ENABLED
  && navigator.mediaDevices?.getUserMedia
  && (window.AudioContext || window.webkitAudioContext)
  ? new VoiceIdentityPcmRecorder({ maxCaptureMs: 8_000 })
  : null;
const pendingTurnExecutions = new Map();

const state = {
  mode: "idle",
  running: false,
  // Turn whose Run has finished executing but whose reply is still being spoken.
  speechOnlyTurnId: null,
  recognition: null,
  listening: false,
  requestedVoiceTurnOrigin: null,
  activeVoiceTurnOrigin: null,
  lastRuntimeResult: null,
  demoReadiness: null,
  demoReadinessVehicleAssetStatus: "loading",
  demoReadinessPollingTimer: null,
  demoReadinessStartedAt: appBootStartedAt,
  lastVehicleHmiPresentation: null,
  dispatchedVehicleCommandsByCommandId: new Map(),
  verifiedVehicleTerminalsByCommandId: new Map(),
  pendingVehicleExecutionsByComponent: new Map(),
  confirmedVehicleStateSnapshot: null,
  consumedRuntimeRequestIds: new Set(),
  pendingConfirmation: null,
  currentRun: null,
  runEventViewModel: null,
  developerStateNotice: "Provider 状态已就绪",
  developerStateNoticeLevel: "info",
  preserveDeveloperStateOnNextRun: false,
  replay: {
    controller: null,
    run: null,
  },
  runtimeDebugLatestRunSource: null,
  runtimeDebugLatestRunController: null,
  manualEvidenceRun: createManualEvidenceRunState(),
  runFeedback: {
    token: 0,
    requestId: null,
  },
  eventHistory: [],
  providerSnapshot: vehicleStateProvider.getSnapshot(),
  voiceOutput: {
    supported: voiceOutputAdapter.supported,
    status: "idle",
    activeProvider: null,
    providerLabel: voiceOutputAdapter.label,
    text: "",
    speechText: "",
    speechTextProvenance: "",
    telemetryRun: null,
  },
  localVoice: voiceCaptureController?.getSnapshot() || Object.freeze({
    state: "degraded",
    reasonCode: "browser-local-voice-unsupported",
    enabled: false,
    gateway: null,
  }),
  localVoiceActiveService: null,
  voiceIdentity: createUnavailableVoiceIdentityStatus(),
  voiceIdentityEnrollment: {
    session: null,
    recordingPhraseId: null,
    processingPhraseId: null,
    stepStates: new Map(),
    timer: null,
    restoreLocalVoiceStandby: false,
  },
  voiceIdentityCalibration: {
    session: null,
    recordingStepId: null,
    processingStepId: null,
    stepStates: new Map(),
    timer: null,
    restoreLocalVoiceStandby: false,
  },
  voiceConfirmation: {
    recording: false,
    processing: false,
    fallbackUsed: false,
    claim: null,
    restoreLocalVoiceStandby: false,
  },
};

function beginManualEvidenceRun(runId) {
  transitionManualEvidenceRun({ type: "run-started", runId });
}

function transitionManualEvidenceRun(event) {
  const previous = state.manualEvidenceRun;
  const next = reduceManualEvidenceRun(previous, event);
  if (next === previous) return false;
  state.manualEvidenceRun = next;
  renderManualEvidenceAnswerState();
  renderRunDetails();
  return true;
}

function getManualEvidencePresentation(runId = state.manualEvidenceRun.runId) {
  if (!runId || state.manualEvidenceRun.runId !== runId) {
    return createManualEvidencePresentation();
  }
  return createManualEvidencePresentation(state.manualEvidenceRun);
}

const presentationBridge = createRuntimePresentationBridge({
  state,
  interactionSessionController,
  render: renderRuntimePresentation,
  applyVehiclePresentation: applyRuntimeVehiclePresentation,
  startVoiceBridge(authorization) {
    voiceOutputAdapter.startEarlyBridge(authorization);
  },
});

const els = {
  agentList: document.querySelector("#agentList"),
  eventLog: document.querySelector("#eventLog"),
  vehicleScene: document.querySelector("#vehicleScene"),
  modelStatus: document.querySelector("#modelStatus"),
  commandInput: document.querySelector("#commandInput"),
  micButton: document.querySelector("#micButton"),
  runButton: document.querySelector("#runButton"),
  runSummary: document.querySelector("#runSummary"),
  runDetailContent: document.querySelector("#runDetailContent"),
  modeTitle: document.querySelector("#modeTitle"),
  modePill: document.querySelector("#modePill"),
  activeTask: document.querySelector("#activeTask"),
  safetyMode: document.querySelector("#safetyMode"),
  batteryMetric: document.querySelector("#batteryMetric"),
  speedMetric: document.querySelector("#speedMetric"),
  networkMetric: document.querySelector("#networkMetric"),
  modelRouteMetric: document.querySelector("#modelRouteMetric"),
  demoReadinessToggle: document.querySelector("#demoReadinessToggle"),
  demoReadinessPanel: document.querySelector("#demoReadinessPanel"),
  demoReadinessSummary: document.querySelector("#demoReadinessSummary"),
  demoReadinessElapsed: document.querySelector("#demoReadinessElapsed"),
  demoReadinessRefresh: document.querySelector("#demoReadinessRefresh"),
  demoReadinessContent: document.querySelector("#demoReadinessContent"),
  localVoiceEnableButton: document.querySelector("#localVoiceEnableButton"),
  localVoiceStatus: document.querySelector("#localVoiceStatus"),
  voiceIdentitySettings: document.querySelector(".voice-identity-settings"),
  voiceIdentityStatus: document.querySelector("#voiceIdentityStatus"),
  voiceIdentityManageButton: document.querySelector("#voiceIdentityManageButton"),
  voiceIdentityEnrollment: document.querySelector("#voiceIdentityEnrollment"),
  voiceIdentityReason: document.querySelector("#voiceIdentityReason"),
  voiceIdentityEnrollButton: document.querySelector("#voiceIdentityEnrollButton"),
  voiceIdentityCancelButton: document.querySelector("#voiceIdentityCancelButton"),
  voiceIdentityDeleteButton: document.querySelector("#voiceIdentityDeleteButton"),
  voiceIdentityPhraseItems: [...document.querySelectorAll("[data-voice-phrase]")],
  voiceIdentityRecordButtons: [...document.querySelectorAll("[data-voice-record]")],
  voiceIdentityCalibrationStatus: document.querySelector("#voiceIdentityCalibrationStatus"),
  voiceIdentityCalibrationReason: document.querySelector("#voiceIdentityCalibrationReason"),
  voiceIdentityCalibrationSteps: document.querySelector("#voiceIdentityCalibrationSteps"),
  voiceIdentityCalibrateButton: document.querySelector("#voiceIdentityCalibrateButton"),
  voiceIdentityCalibrationCancelButton: document.querySelector(
    "#voiceIdentityCalibrationCancelButton",
  ),
  driveMetric: document.querySelector("#driveMetric"),
  destinationMetric: document.querySelector("#destinationMetric"),
  assistantText: document.querySelector("#assistantText"),
  runFeedback: document.querySelector("#runFeedback"),
  ttsProviderStatus: document.querySelector("#ttsProviderStatus"),
  ttsPauseButton: document.querySelector("#ttsPauseButton"),
  ttsResumeButton: document.querySelector("#ttsResumeButton"),
  ttsStopButton: document.querySelector("#ttsStopButton"),
  interactionSessionStatus: document.querySelector('[data-testid="interaction-session-status"]'),
  stopCurrentTaskButton: document.querySelector('[data-testid="stop-current-task"]'),
  clearSessionMemoryButton: document.querySelector("#clearSessionMemoryButton"),
  developerStatePanel: document.querySelector(".developer-vehicle-state-panel"),
  developerStateSource: document.querySelector("#developerStateSource"),
  developerStateSnapshot: document.querySelector("#developerStateSnapshot"),
  developerStateCapturedAt: document.querySelector("#developerStateCapturedAt"),
  developerStateLock: document.querySelector("#developerStateLock"),
  developerStatePreset: document.querySelector("#developerStatePreset"),
  developerStateApplyPreset: document.querySelector("#developerStateApplyPreset"),
  developerBatteryPercent: document.querySelector("#developerBatteryPercent"),
  developerSpeedKph: document.querySelector("#developerSpeedKph"),
  developerGear: document.querySelector("#developerGear"),
  developerRearClearance: document.querySelector("#developerRearClearance"),
  developerWindowAntiPinch: document.querySelector("#developerWindowAntiPinch"),
  developerRainDetected: document.querySelector("#developerRainDetected"),
  developerCabinTemperature: document.querySelector("#developerCabinTemperature"),
  developerClimatePower: document.querySelector("#developerClimatePower"),
  developerClimateMode: document.querySelector("#developerClimateMode"),
  developerFanLevel: document.querySelector("#developerFanLevel"),
  developerAirflow: document.querySelector("#developerAirflow"),
  developerPassengerMode: document.querySelector("#developerPassengerMode"),
  developerSeatComfortSummary: document.querySelector("#developerSeatComfortSummary"),
  developerSeatControls: document.querySelector("#developerSeatControls"),
  developerContinuousControls: document.querySelector("#developerContinuousControls"),
  developerBinaryControls: document.querySelector("#developerBinaryControls"),
  developerStateReset: document.querySelector("#developerStateReset"),
  developerStateStatus: document.querySelector("#developerStateStatus"),
  replayBackButton: document.querySelector("#replayBackButton"),
  replayForwardButton: document.querySelector("#replayForwardButton"),
  replayLiveButton: document.querySelector("#replayLiveButton"),
  replayPosition: document.querySelector("#replayPosition"),
  safetyConfirmationModal: document.querySelector("#safetyConfirmationModal"),
  safetyConfirmationDialog: document.querySelector(".safety-confirmation-dialog"),
  safetyConfirmationReason: document.querySelector("#safetyConfirmationReason"),
  safetyConfirmationAction: document.querySelector("#safetyConfirmationAction"),
  safetyConfirmationAlternativeRow: document.querySelector("#safetyConfirmationAlternativeRow"),
  safetyConfirmationAlternative: document.querySelector("#safetyConfirmationAlternative"),
  safetyConfirmationAssertions: document.querySelector("#safetyConfirmationAssertions"),
  safetyConfirmationVoiceState: document.querySelector("#safetyConfirmationVoiceState"),
  safetyConfirmationVoice: document.querySelector("#safetyConfirmationVoice"),
  safetyConfirmationCancel: document.querySelector("#safetyConfirmationCancel"),
  safetyConfirmationConfirm: document.querySelector("#safetyConfirmationConfirm"),
};

let confirmationModalOwnerId = null;
let confirmationModalReturnFocus = null;
const confirmationDecisionGate = createConfirmationDecisionGate();

const developerVehicleStateController = new DeveloperVehicleStateController({
  simulator: demoSensorSimulator,
  vehicleStateProvider,
  initialState: DEMO_INITIAL_VEHICLE_STATE,
  isLocked: isDeveloperVehicleStateLocked,
  onSnapshot: projectDeveloperVehicleStateSnapshot,
  onAudit: (audit) => {
    const fields = audit.changedFields.length ? audit.changedFields.join(", ") : "state";
    addRuntimeEvent(
      "developer",
      `${audit.label} · ${fields} · ${audit.snapshotId || "snapshot unavailable"}`,
      "info",
    );
  },
});

const sessionId = `browser-${globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

const modeTitles = {
  idle: "系统待命",
  listening: "正在聆听",
  planning: "路线规划中",
  energy: "补能决策中",
  cabin: "座舱调节中",
  tailgate: "尾门已开启",
  safety: "安全校验中",
  offline: "端侧兜底中",
  conversation: "对话生成中",
  pending: "车辆执行中",
  completed: "协同完成",
  blocked: "安全拦截",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripNomiWakeWord(value) {
  return String(value || "")
    .normalize("NFKC")
    .trimStart()
    .replace(/^nomi(?=$|[\p{White_Space}\p{Punctuation}])\s*[,，:：]?\s*/iu, "")
    .trim();
}

function renderInteractionSessionStatus(snapshot = interactionSessionController.getSnapshot()) {
  if (els.interactionSessionStatus) {
    const labels = {
      dormant: state.localVoice?.enabled ? "NOMI 常驻待命" : "会话未唤醒",
      listening: "NOMI 正在聆听",
      processing: "NOMI 正在处理",
      speaking: "NOMI 正在播报",
      "follow-up-window": "NOMI 等待追问（5 秒）",
    };
    els.interactionSessionStatus.textContent = labels[snapshot.state] || snapshot.state;
    els.interactionSessionStatus.dataset.state = snapshot.state;
  }
  if (els.stopCurrentTaskButton) {
    els.stopCurrentTaskButton.disabled = !snapshot.activeTurn
      || !["processing", "speaking"].includes(snapshot.state);
  }
}

function prepareInteractionTurn(text, runOptions = {}) {
  const rawText = String(text || "").trim();
  if (!rawText) return null;
  let command = rawText;
  const voiceTurnOrigin = runOptions.inputSource === "voice"
    && ["barge-in", "follow-up", "local-wake", "push-to-talk"].includes(runOptions.voiceTurnOrigin)
    ? runOptions.voiceTurnOrigin
    : null;
  let trigger = voiceTurnOrigin === "local-wake"
    ? "wake-word"
    : voiceTurnOrigin === "push-to-talk" ? "explicit-hmi"
    : voiceTurnOrigin || (runOptions.inputSource === "voice" ? "voice" : "explicit-hmi");
  let snapshot = interactionSessionController.getSnapshot();

  if (snapshot.state === "dormant") {
    if (runOptions.inputSource === "voice" && voiceTurnOrigin !== "push-to-talk") {
      const wake = wakeWordProvider.detect(rawText);
      if (!wake.matched) {
        addRuntimeEvent("voice", "未检测到 NOMI 唤醒词，未开启交互会话", "info");
        return null;
      }
      interactionSessionController.wake({ provider: wake.provider, simulated: wake.simulated });
      command = stripNomiWakeWord(rawText);
      trigger = "wake-word";
    } else {
      interactionSessionController.wake({
        provider: voiceTurnOrigin === "push-to-talk" ? "explicit-microphone-control" : "explicit-hmi-control",
        simulated: true,
      });
    }
    snapshot = interactionSessionController.getSnapshot();
  } else if (snapshot.state === "follow-up-window") {
    interactionSessionController.startListening();
    snapshot = interactionSessionController.getSnapshot();
    trigger = voiceTurnOrigin || "follow-up";
  }

  if (!command) return null;
  const explicitGate = classifyExplicitTurnGate(command);
  if (explicitGate.decision === "explicit-cancel") {
    runtime.cancelPendingClarification(sessionId, "user-cancelled");
    if (snapshot.activeTurn) {
      transitionManualEvidenceRun({ type: "request-aborted", runId: snapshot.activeTurn.runId });
      interactionSessionController.requestCancellation("user-cancelled");
    } else if (snapshot.state !== "dormant") {
      interactionSessionController.closeSession({ reasonCode: "user-cancelled" });
    }
    return null;
  }
  if (explicitGate.decision === "explicit-close" && snapshot.state !== "dormant") {
    runtime.cancelPendingClarification(sessionId, "explicit-close");
    if (snapshot.activeTurn) {
      transitionManualEvidenceRun({ type: "request-aborted", runId: snapshot.activeTurn.runId });
    }
    interactionSessionController.closeSession({ reasonCode: "explicit-close" });
    return null;
  }

  const replacing = Boolean(snapshot.activeTurn);
  const turn = interactionSessionController.submitTurn({
    rawText: command,
    trigger: replacing ? "barge-in" : trigger,
    relation: replacing || trigger === "barge-in"
      ? "correction"
      : trigger === "follow-up" ? "follow-up" : "new-goal",
  });
  return { command, replacing, turn };
}

function renderComponents() {
  els.agentList.innerHTML = components.length ? components
    .map(
      (component) => `
        <article class="agent-card ${component.status}" data-component="${escapeHtml(component.id)}" data-component-type="${escapeHtml(component.type)}">
          <div class="agent-top">
            <span class="agent-name">${escapeHtml(component.name)}</span>
            <span class="agent-status">${component.status}</span>
          </div>
          <div class="agent-tier"><span class="participant-type-badge">${escapeHtml(participantTypeLabels[component.type] || component.type)}</span></div>
          <div class="agent-role">${escapeHtml(component.role)}</div>
          <div class="agent-task">${escapeHtml(component.currentTask)}</div>
        </article>
      `,
    )
    .join("") : `<div class="empty-state component-empty-state">当前 Run 尚无协同组件事件</div>`;
}

function resetComponents() {
  components.splice(0, components.length);
  renderComponents();
}

function setMode(mode, task = "") {
  state.mode = mode;
  els.vehicleScene.dataset.mode = mode;
  els.modeTitle.textContent = modeTitles[mode] || "系统运行中";
  els.modePill.textContent = mode.toUpperCase();
  if (task) els.activeTask.textContent = task;
}

function addRuntimeEvent(sourceLabel, message, level = "info") {
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  state.eventHistory.unshift({ sourceLabel, message, level, time, observedAt: now.toISOString() });
  state.eventHistory = state.eventHistory.slice(0, 80);
  const item = document.createElement("div");
  item.className = `event-item ${level}`;
  item.innerHTML = `
    <strong>${escapeHtml(sourceLabel)}</strong>
    <time>${time}</time>
    <span>${escapeHtml(message)}</span>
  `;
  els.eventLog.querySelector(".empty-state")?.remove();
  els.eventLog.prepend(item);
  while (els.eventLog.children.length > 80) {
    els.eventLog.lastElementChild?.remove();
  }
}

function developerBooleanValue(value) {
  if (value === "") return null;
  return value === "true";
}

function isDeveloperVehicleStateLocked() {
  return state.running
    || state.pendingVehicleExecutionsByComponent.size > 0
    || Boolean(state.pendingConfirmation);
}

function defaultStaleCapturedAt() {
  return new Date(Date.now() - 5 * 60_000).toISOString();
}

function developerActionPatch(actionId, value) {
  const zone = WINDOW_ZONE_BY_ACTION_ID[actionId];
  if (zone) return { windowPositionPercentByZone: { [zone]: value } };
  if (actionId === "tailgate_open") return { tailgateOpen: value === 1 };
  if (actionId === "driver_seat_backrest_recline") {
    return { driverBackrestAngle: SAFETY_BASELINE.seat.defaultAngle - value };
  }
  return { componentActionStateById: { [actionId]: value } };
}

function developerActionValue(snapshot, actionId) {
  const values = snapshot?.values || {};
  const zone = WINDOW_ZONE_BY_ACTION_ID[actionId];
  if (zone) return values.windowPositionPercentByZone?.[zone] ?? null;
  if (actionId === "tailgate_open") {
    return typeof values.tailgateOpen === "boolean" ? Number(values.tailgateOpen) : null;
  }
  if (actionId === "driver_seat_backrest_recline") {
    return Number.isFinite(values.driverBackrestAngle)
      ? SAFETY_BASELINE.seat.defaultAngle - values.driverBackrestAngle
      : null;
  }
  return values.componentActionStateById?.[actionId] ?? null;
}

function developerActionOutput(definition, value) {
  if (!Number.isFinite(value)) return "unknown";
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(1));
  if (definition.unit === "percent") return `${rounded}%`;
  if (definition.unit === "degree") return `${rounded}°`;
  if (definition.unit === "centimeter") return `${rounded} cm`;
  return String(rounded);
}

function developerRangeControlMarkup(definition) {
  return `
    <label class="developer-range-control" data-developer-action="${escapeHtml(definition.id)}">
      <span>${escapeHtml(definition.label)} <output data-developer-action-output="${escapeHtml(definition.id)}">unknown</output></span>
      <input
        type="range"
        min="${definition.minimum}"
        max="${definition.maximum}"
        step="1"
        value="${definition.defaultValue}"
        data-developer-action-input="${escapeHtml(definition.id)}"
        aria-label="${escapeHtml(definition.label)}"
      />
    </label>
  `;
}

function buildDeveloperVehicleStateControls() {
  const definitions = Object.values(ES7_ACTION_CATALOG);
  const seatDefinitions = DEVELOPER_SEAT_ACTION_IDS.map((actionId) => ES7_ACTION_CATALOG[actionId]);
  const continuousDefinitions = definitions.filter(
    (definition) => !DEVELOPER_SEAT_ACTION_IDS.includes(definition.id) && definition.unit !== "binary",
  );
  const binaryDefinitions = definitions.filter((definition) => definition.unit === "binary");
  if (seatDefinitions.length !== 4 || continuousDefinitions.length !== 6 || binaryDefinitions.length !== 15) {
    throw new Error("Developer vehicle state controls must map all 25 ES7 clips exactly once");
  }

  els.developerSeatControls.innerHTML = seatDefinitions.map(developerRangeControlMarkup).join("");
  els.developerContinuousControls.innerHTML = continuousDefinitions.map(developerRangeControlMarkup).join("");
  els.developerBinaryControls.innerHTML = binaryDefinitions.map((definition) => `
    <button type="button" data-developer-action-button="${escapeHtml(definition.id)}" aria-pressed="false">
      ${escapeHtml(definition.label)}
    </button>
  `).join("");
}

function setDeveloperStateNotice(message, level = "info") {
  state.developerStateNotice = message;
  state.developerStateNoticeLevel = level;
}

function handleDeveloperStateResult(result, successMessage) {
  if (result?.ok === true) {
    setDeveloperStateNotice(successMessage, "info");
  } else if (result?.reason === "locked") {
    setDeveloperStateNotice("智能协作执行中，开发者状态编辑已锁定", "warning");
  } else {
    setDeveloperStateNotice(`状态未修改：${result?.reason || "unknown error"}`, "warning");
  }
  renderDeveloperVehicleStatePanel(result?.snapshot || vehicleStateProvider.getSnapshot());
  return result;
}

function projectDeveloperVehicleStateSnapshot(snapshot, result = {}) {
  state.providerSnapshot = snapshot;
  const capturedMs = Date.parse(result.reading?.capturedAt || snapshot?.capturedAt || "");
  state.preserveDeveloperStateOnNextRun = Number.isFinite(capturedMs)
    && Date.now() - capturedMs > VEHICLE_STATE_FRESHNESS_POLICY.maxAgeMs;
  renderVehicleStateMetrics(snapshot);
  const projected = window.vehicleRig?.syncConfirmedState?.(snapshot, { immediate: false }) === true;
  if (!projected && !window.vehicleRig) {
    setDeveloperStateNotice("Provider 已更新，车模等待加载", "info");
  }
  renderDeveloperVehicleStatePanel(snapshot);
}

function renderDeveloperVehicleStatePanel(snapshot = vehicleStateProvider.getSnapshot()) {
  if (!els.developerStatePanel || !snapshot) return;
  const values = snapshot.values || {};
  const locked = isDeveloperVehicleStateLocked();
  els.developerStatePanel.classList.toggle("developer-state-panel-locked", locked);
  els.developerStateSource.textContent = snapshot.source || "unknown";
  els.developerStateSnapshot.textContent = snapshot.id || "unknown";
  els.developerStateSnapshot.title = snapshot.id || "";
  els.developerStateCapturedAt.textContent = snapshot.capturedAt
    ? new Date(snapshot.capturedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "unknown";
  els.developerStateLock.textContent = locked ? "已锁定" : "可编辑";
  els.developerStateLock.dataset.state = locked ? "locked" : "ready";

  els.developerBatteryPercent.value = values.batteryPercent ?? "";
  els.developerSpeedKph.value = values.speedKph ?? "";
  els.developerGear.value = values.gear ?? "";
  els.developerRearClearance.value = values.rearClearance === null ? "" : String(values.rearClearance);
  els.developerWindowAntiPinch.value = values.windowAntiPinchAvailable === null
    ? ""
    : String(values.windowAntiPinchAvailable);
  els.developerRainDetected.value = values.rainDetected === null ? "" : String(values.rainDetected);
  els.developerCabinTemperature.value = values.cabinTemperature ?? "";
  els.developerClimatePower.value = values.climatePower == null ? "" : String(values.climatePower);
  els.developerClimateMode.value = values.climateMode ?? "";
  els.developerFanLevel.value = values.fanLevel ?? "";
  els.developerAirflow.value = values.airflow ?? "";
  els.developerPassengerMode.value = values.passengerMode ?? "";

  Object.values(ES7_ACTION_CATALOG).forEach((definition) => {
    const value = developerActionValue(snapshot, definition.id);
    const input = els.developerStatePanel.querySelector(
      `[data-developer-action-input="${definition.id}"]`,
    );
    const output = els.developerStatePanel.querySelector(
      `[data-developer-action-output="${definition.id}"]`,
    );
    const button = els.developerStatePanel.querySelector(
      `[data-developer-action-button="${definition.id}"]`,
    );
    if (input) {
      input.value = Number.isFinite(value) ? value : definition.defaultValue;
      input.closest(".developer-range-control")?.toggleAttribute("data-unknown", !Number.isFinite(value));
    }
    if (output) output.textContent = developerActionOutput(definition, value);
    if (button) {
      button.setAttribute("aria-pressed", value === 1 ? "true" : "false");
      button.dataset.state = Number.isFinite(value) ? "known" : "unknown";
    }
  });

  els.developerStatePanel.querySelectorAll("input, select, button").forEach((control) => {
    control.disabled = locked;
  });
  els.developerStateStatus.textContent = locked
    ? "智能协作执行中，开发者状态编辑已锁定"
    : state.developerStateNotice;
  els.developerStateStatus.dataset.level = locked ? "warning" : state.developerStateNoticeLevel;
}

function applyDeveloperActionValue(actionId, value, { audit = true } = {}) {
  const definition = ES7_ACTION_CATALOG[actionId];
  if (!definition || !Number.isFinite(value)) {
    return handleDeveloperStateResult({ ok: false, reason: "invalid action value" }, "");
  }
  const result = developerVehicleStateController.applyPatch(developerActionPatch(actionId, value), {
    audit,
    label: `开发者模拟 ${definition.label} 状态已更新`,
  });
  return handleDeveloperStateResult(result, `${definition.label} 已同步到 Provider`);
}

function applyDeveloperStatePreset() {
  const presetId = els.developerStatePreset.value;
  const scenario = getDemoScenario(presetId);
  if (!scenario) return;
  const result = developerVehicleStateController.applyPatch(scenario.values, {
    mode: scenario.simulatorMode,
    capturedAt: presetId === "stale" ? defaultStaleCapturedAt() : null,
    label: `开发者模拟 ${presetId} 状态已应用`,
  });
  handleDeveloperStateResult(result, `${presetId} 状态已同步到 Provider`);
}

function setupDeveloperVehicleStatePanel() {
  buildDeveloperVehicleStateControls();
  const fieldBindings = [
    [els.developerBatteryPercent, "batteryPercent", (value) => (value === "" ? Number.NaN : Number(value))],
    [els.developerSpeedKph, "speedKph", (value) => (value === "" ? null : Number(value))],
    [els.developerGear, "gear", (value) => value || null],
    [els.developerRearClearance, "rearClearance", developerBooleanValue],
    [els.developerWindowAntiPinch, "windowAntiPinchAvailable", developerBooleanValue],
    [els.developerRainDetected, "rainDetected", developerBooleanValue],
    [els.developerCabinTemperature, "cabinTemperature", (value) => (value === "" ? null : Number(value))],
    [els.developerClimatePower, "climatePower", developerBooleanValue],
    [els.developerClimateMode, "climateMode", (value) => value || null],
    [els.developerFanLevel, "fanLevel", (value) => (value === "" ? null : Number(value))],
    [els.developerAirflow, "airflow", (value) => value || null],
    [els.developerPassengerMode, "passengerMode", (value) => value || null],
  ];
  fieldBindings.forEach(([control, field, parse]) => {
    control.addEventListener("change", () => {
      const result = developerVehicleStateController.applyPatch({ [field]: parse(control.value) }, {
        label: `开发者模拟 ${field} 状态已更新`,
      });
      handleDeveloperStateResult(result, `${field} 已同步到 Provider`);
    });
  });

  els.developerStatePanel.querySelectorAll("[data-developer-action-input]").forEach((input) => {
    let pendingFrame = 0;
    const actionId = input.dataset.developerActionInput;
    const isSeatAdjustment = DEVELOPER_SEAT_ACTION_IDS.includes(actionId);
    const finishSeatFocus = (reason = "developer-seat-input-complete") => {
      if (!isSeatAdjustment) return;
      window.vehicleRig?.endSeatAdjustmentFocus?.({ delayMs: 1200, reason });
    };
    input.addEventListener("input", () => {
      const definition = ES7_ACTION_CATALOG[actionId];
      if (isSeatAdjustment && !isDeveloperVehicleStateLocked()) {
        window.vehicleRig?.beginSeatAdjustmentFocus?.({ reason: "developer-seat-input" });
      }
      const output = els.developerStatePanel.querySelector(
        `[data-developer-action-output="${definition.id}"]`,
      );
      if (output) output.textContent = developerActionOutput(definition, Number(input.value));
      if (pendingFrame) cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = 0;
        applyDeveloperActionValue(definition.id, Number(input.value), { audit: false });
      });
    });
    input.addEventListener("change", () => {
      const definition = ES7_ACTION_CATALOG[actionId];
      if (pendingFrame) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = 0;
      }
      const result = applyDeveloperActionValue(definition.id, Number(input.value), { audit: false });
      if (result?.ok) {
        developerVehicleStateController.audit({
          label: `开发者模拟 ${definition.label} 状态已更新`,
          changedFields: Object.keys(developerActionPatch(definition.id, Number(input.value))),
        });
      }
      if (isSeatAdjustment) {
        window.vehicleRig?.endSeatAdjustmentFocus?.({
          delayMs: result?.ok ? 1200 : 0,
          reason: result?.ok ? "developer-seat-input-complete" : "developer-seat-input-rejected",
        });
      }
    });
    input.addEventListener("pointerup", () => finishSeatFocus());
    input.addEventListener("pointercancel", () => finishSeatFocus("developer-seat-input-cancelled"));
    input.addEventListener("blur", () => finishSeatFocus());
  });

  els.developerStatePanel.querySelectorAll("[data-developer-action-button]").forEach((button) => {
    button.addEventListener("click", () => {
      const actionId = button.dataset.developerActionButton;
      const current = developerActionValue(vehicleStateProvider.getSnapshot(), actionId);
      applyDeveloperActionValue(actionId, current === 1 ? 0 : 1);
    });
  });
  els.developerStateApplyPreset.addEventListener("click", applyDeveloperStatePreset);
  els.developerStateReset.addEventListener("click", () => {
    const result = developerVehicleStateController.reset();
    handleDeveloperStateResult(result, "车辆模拟状态已复位");
  });
  renderDeveloperVehicleStatePanel(vehicleStateProvider.getSnapshot());
}

function createSafeDebugFingerprint(value) {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function buildScenarioProviderSummary(snapshot) {
  return buildProviderSnapshotSummary(snapshot, {
    maxAgeMs: VEHICLE_STATE_FRESHNESS_POLICY.maxAgeMs,
  });
}

function buildPendingVehicleExecutionFingerprint(pendingExecutions) {
  const summary = [...pendingExecutions.entries()]
    .map(([component, pending]) => ({
      component: String(component),
      commandId: typeof pending?.commandId === "string" ? pending.commandId : null,
      phase: typeof pending?.phase === "string" ? pending.phase : null,
      visualScenario: typeof pending?.visualScenario === "string" ? pending.visualScenario : null,
    }))
    .sort((left, right) => left.component.localeCompare(right.component));
  return createSafeDebugFingerprint(summary);
}

function liveRunEventSnapshot() {
  return runtime.runEventLedger.getCurrentRun() || runtime.runEventLedger.getPreviousRun();
}

function projectRunEventSnapshot(run, events = run?.events) {
  if (!run) return null;
  return buildRunEventViewModel({ ...run, events });
}

function renderReplayControls() {
  if (!els.replayPosition) return;
  const previousRun = runtime.runEventLedger.getPreviousRun();
  const replay = state.replay.controller;
  const replaying = Boolean(replay && state.replay.run);
  const eventCount = replaying ? replay.eventCount : previousRun?.events.length || 0;
  const cursor = replaying ? replay.cursor : eventCount;
  els.replayPosition.textContent = `${replaying ? "Replay" : "Live"} · ${cursor} / ${eventCount}`;
  els.replayBackButton.disabled = state.running || !previousRun || (replaying && !replay.canStepBack);
  els.replayForwardButton.disabled = state.running || !replaying || !replay.canStepForward;
  els.replayLiveButton.disabled = state.running || !replaying;
}

function renderReplayProjection() {
  const replay = state.replay.controller;
  const run = state.replay.run;
  if (!replay || !run) return;
  state.runEventViewModel = projectRunEventSnapshot(run, replay.visibleEvents);
  renderRunEventProjection(state.runEventViewModel);
  renderRunDetails();
  renderReplayControls();
}

function stepReplayBack() {
  if (state.running) return;
  if (!state.replay.controller) {
    const previousRun = runtime.runEventLedger.getPreviousRun();
    if (!previousRun) return;
    const controller = runtime.runEventLedger.createReplay(previousRun.runId);
    while (controller.canStepForward) controller.stepForward();
    state.replay = { controller, run: previousRun };
  }
  state.replay.controller.stepBack();
  renderReplayProjection();
}

function stepReplayForward() {
  if (state.running || !state.replay.controller) return;
  state.replay.controller.stepForward();
  renderReplayProjection();
}

function returnToLiveProjection() {
  if (!state.replay.controller) {
    renderReplayControls();
    return;
  }
  state.replay = { controller: null, run: null };
  const run = liveRunEventSnapshot();
  state.runEventViewModel = projectRunEventSnapshot(run);
  if (state.runEventViewModel) renderRunEventProjection(state.runEventViewModel);
  renderRunDetails();
  renderReplayControls();
}

function renderRunEventProjection(viewModel) {
  const visibleComponents = viewModel.components.map((component) => {
    const presentation = componentPresentationById.get(component.id);
    return {
      id: component.id,
      name: component.label,
      type: component.type,
      tier: presentation?.tier || component.type,
      role: presentation?.role || "当前 Run 实际协同组件",
      status: component.status,
      currentTask: b2ComponentTask(viewModel.b2, component)
        || b3ComponentTask(viewModel.b3, component)
        || component.summary,
    };
  });
  components.splice(0, components.length, ...visibleComponents);
  renderComponents();

  const visibleLogItems = viewModel.logItems.slice(-80);
  state.eventHistory = visibleLogItems
    .map((item) => ({
      sourceLabel: item.componentLabel,
      message: item.summary,
      level: runtimeEventLevel(item.status),
      time: new Date(item.timestamp).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      observedAt: item.timestamp,
    }))
    .reverse();
  els.eventLog.innerHTML = visibleLogItems
    .map((item) => `
      <div class="event-item ${runtimeEventLevel(item.status)}">
        <strong>${escapeHtml(item.componentLabel)}</strong>
        <time>${escapeHtml(new Date(item.timestamp).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }))}</time>
        <span>${escapeHtml(item.summary)}</span>
      </div>
    `)
    .join("");
}

function b2ComponentTask(b2, component) {
  if (!b2) return "";
  if (component.id === "orchestrator") {
    if (b2.degradation) return b2.degradation.summary;
    if (b2.executionFacts) {
      const completed = b2.executionFacts.stepResults
        .filter((step) => step.status === "completed").length;
      return `Plan steps ${completed}/${b2.executionFacts.stepResults.length}`;
    }
    if (b2.plan) return `Plan steps 0/${b2.plan.steps.length}`;
  }
  if (component.id === "cabinAssistant") {
    if (b2.response) return b2.response;
    if (b2.goal?.objective) return b2.goal.objective;
    if (b2.goal?.requiredClarifications?.length) return b2.goal.requiredClarifications[0];
  }
  return "";
}

function b3ComponentTask(b3, component) {
  const knowledge = b3?.vehicleKnowledge;
  if (!knowledge) return "";
  if (component.id === "orchestrator" && knowledge.subplan) return "知识子计划已协调";
  if (component.id === "cabinAssistant") {
    return knowledge.outcome?.outcomeStatus || knowledge.goal || "知识回答组织中";
  }
  if (component.id === "manualRetriever" && knowledge.evidence?.length) return `Evidence ${knowledge.evidence.length}`;
  if (component.id === "vehicleStateProvider" && knowledge.state?.length) return "Provider snapshot 已读取";
  if (component.id === "safety" && knowledge.safetyAssessment) return knowledge.safetyAssessment.action || "Safety assessment";
  return "";
}

function refreshRunEventProjection(run) {
  state.replay = { controller: null, run: null };
  state.runEventViewModel = projectRunEventSnapshot(run);
  renderRunEventProjection(state.runEventViewModel);
  renderReplayControls();
}

function runtimeEventLevel(status) {
  if (["cancelled", "safety_rejected", "unavailable", "failed", "uncertain"].includes(status)) return "warning";
  if (status === "completed") return "success";
  return "info";
}

function beginRunFeedback() {
  state.runFeedback.token += 1;
  state.runFeedback.requestId = null;
  setRunFeedback("正在理解这次请求", state.runFeedback.token);
  return state.runFeedback.token;
}

function setRunFeedback(message, token = state.runFeedback.token) {
  if (token !== state.runFeedback.token || !els.runFeedback) return false;
  els.runFeedback.textContent = message;
  return true;
}

function bindRunFeedbackRequest(event) {
  if (!state.currentRun || !event?.runId) return false;
  const currentRequestId = state.currentRun.requestId || state.runFeedback.requestId;
  if (currentRequestId && currentRequestId !== event.runId) return false;
  state.currentRun.requestId = event.runId;
  state.runFeedback.requestId = event.runId;
  return true;
}

function updateRunFeedbackFromRuntimeEvent(event) {
  if (!bindRunFeedbackRequest(event)) return;
  const token = state.runFeedback.token;
  if (event.component === "cabinAssistant" && event.phase === "intake") {
    setRunFeedback("正在理解这次请求", token);
  } else if (event.component === "vehicleSluModel" && event.status === "completed") {
    setRunFeedback("语义解析完成，正在确定处理路径", token);
  } else if (["manualQueryPlanner", "orchestrator", "orchestratorModel"].includes(event.component)) {
    setRunFeedback("正在确定处理路径", token);
  } else if (["cabinModel", "cabinAssistant"].includes(event.component)
    && !["unavailable", "failed", "cancelled"].includes(event.status)) {
    setRunFeedback("正在组织回复", token);
  } else if (event.component === "responsePresentation" && event.status === "completed") {
    setRunFeedback("回复已生成，正在准备语音", token);
  }
}

function updateRunFeedbackFromVoiceStatus(status, token = state.voiceOutput.feedbackToken) {
  if (token !== state.runFeedback.token) return;
  if (status === "loading") {
    setRunFeedback("回复已生成，正在准备语音", token);
  } else if (status === "speaking") {
    setRunFeedback("正在播报", token);
  } else if (status === "paused") {
    setRunFeedback("播报已暂停", token);
  } else if (status === "idle" && !state.running) {
    setRunFeedback("", token);
  }
}

function isCurrentRuntimeInteraction(requestId, interactionRef) {
  const matchingRun = [state.currentRun, state.lastRunDetail]
    .find((run) => run?.requestId === requestId && run?.interactionTurn);
  const turn = matchingRun?.interactionTurn;
  return Boolean(turn
    && interactionRef?.sessionId === turn.sessionId
    && interactionRef?.turnId === turn.turnId
    && interactionSessionController.isCurrent(turn));
}

function renderRuntimePresentation(update) {
  if (update.type === "result") return applyRuntimeResult(update.result, update.turnContext);
  const { event, mode } = update;
  if (state.currentRun && event?.runId && !bindRunFeedbackRequest(event)) return null;
  setMode(mode, event?.summary || "");
  const run = liveRunEventSnapshot();
  if (run) refreshRunEventProjection(run);
  renderRunSummary();
  renderRunDetails();
  updateRunFeedbackFromRuntimeEvent(event);
  return null;
}

function applyRuntimeVehiclePresentation(input) {
  if (input.authorization === "pending") {
    const toolCall = input.toolCall;
    const event = {
      runId: input.event.runId,
      component: "vehicleTool",
      phase: "vehicle-execution",
      status: "processing",
      toolCall,
    };
    const registration = registerDispatchedVehicleCommand(
      state.dispatchedVehicleCommandsByCommandId,
      event,
      { currentRequestId: state.currentRun?.requestId },
    );
    if (!registration.accepted) return { accepted: false, reason: "dispatch-registration-rejected" };
    state.dispatchedVehicleCommandsByCommandId = registration.dispatchedVehicleCommandsByCommandId;
    const pendingPresentation = mapVehicleExecutionToHmi({
      toolResult: {
        requestId: toolCall.requestId,
        commandId: toolCall.commandId,
        tool: toolCall.tool,
        executionState: "submitted",
        ok: false,
      },
      vehicleStateSnapshot: null,
      previousConfirmedState: state.confirmedVehicleStateSnapshot,
    });
    const nextHmiState = reduceVehicleHmiState(state, pendingPresentation);
    state.pendingVehicleExecutionsByComponent = nextHmiState.pendingVehicleExecutionsByComponent;
    if (state.currentRun) {
      state.currentRun.pendingVehicleCommandId = pendingPresentation.commandId;
      state.currentRun.pendingVehicleComponent = pendingPresentation.component;
      state.currentRun.pendingVehicleTool = toolCall.tool;
    }
    applyHmiPresentation(pendingPresentation);
    return { accepted: true, presentation: pendingPresentation };
  }

  const terminalEvent = {
    runId: input.event.runId,
    component: "vehicleTool",
    phase: "vehicle-execution",
    status: input.event.status,
    toolResult: input.toolResult,
    providerSnapshot: input.providerSnapshot,
    commitmentState: input.commitmentState,
    cancellation: input.cancellation,
  };
  const pendingBefore = state.pendingVehicleExecutionsByComponent.size;
  const { transaction, nextState } = reduceAppRuntimeVehicleEvent(
    state,
    terminalEvent,
    { currentRequestId: state.currentRun?.requestId },
  );
  if (window.NIO_B2_ACCEPTANCE_INSTRUMENTATION === true) {
    window.__b2AcceptanceCalls.lastVehicleTerminalTransaction = {
      requestId: terminalEvent.runId,
      dataRequestId: terminalEvent.toolResult.requestId || null,
      commandId: terminalEvent.toolResult.commandId || null,
      pendingBefore,
      handled: transaction.handled === true,
      contractValid: transaction.contractValid === true,
      pendingAfter: nextState.pendingVehicleExecutionsByComponent?.size ?? null,
    };
  }
  if (!transaction.handled) return { accepted: false, reason: "vehicle-terminal-reducer-rejected" };
  state.currentRun = nextState.currentRun;
  state.pendingVehicleExecutionsByComponent = nextState.pendingVehicleExecutionsByComponent;
  state.dispatchedVehicleCommandsByCommandId = nextState.dispatchedVehicleCommandsByCommandId;
  state.verifiedVehicleTerminalsByCommandId = nextState.verifiedVehicleTerminalsByCommandId;
  state.confirmedVehicleStateSnapshot = nextState.confirmedVehicleStateSnapshot;
  if (transaction.presentation?.phase === "confirmed") {
    state.lastVehicleHmiPresentation = transaction.presentation;
    if (benchmarkFaultProfile?.target === "demo-sensor-submission") {
      benchmarkRunEvidenceState.confirmedAnimationCount += 1;
    }
  }
  applyAppRuntimeVehicleEventEffects(transaction, {
    applyPresentation: applyHmiPresentation,
    renderMetrics: () => renderVehicleStateMetrics(state.confirmedVehicleStateSnapshot),
  });
  if (transaction.presentationAccepted !== true) {
    window.vehicleRig?.endSeatAdjustmentFocus?.({
      delayMs: 0,
      reason: "vehicle-terminal-presentation-rejected",
    });
  }
  return { accepted: transaction.presentationAccepted === true, transaction };
}

runtime.runEventLedger.subscribe(createSafeRunEventProjectionListener((run) => {
  const interactionRef = run?.events?.at(-1)?.metadata?.interactionRef;
  if (!isCurrentRuntimeInteraction(run?.runId, interactionRef)) return;
  refreshRunEventProjection(run);
}));
runtime.onEvent((event) => {
  state.providerSnapshot = vehicleStateProvider.getSnapshot();
  renderDeveloperVehicleStatePanel(state.providerSnapshot);
  presentationBridge.handleEvent(event);
});
interactionSessionController.subscribe((snapshot, event) => {
  renderInteractionSessionStatus(snapshot);
  if (shouldStartAutomaticVoiceFollowUp({
    snapshot,
    event,
    localVoiceEnabled: state.localVoice.enabled,
    recognitionAvailable: Boolean(state.recognition),
    pendingConfirmation: Boolean(state.pendingConfirmation),
  })) {
    void startAutomaticVoiceFollowUp(snapshot);
    return;
  }
  if (snapshot.state === "dormant" && voiceCaptureController?.getSnapshot().enabled) {
    setMode("idle", "系统待命");
    if (state.listening && state.activeVoiceTurnOrigin === "follow-up") {
      try {
        state.recognition?.abort();
      } catch {
        state.listening = false;
        state.activeVoiceTurnOrigin = null;
        void voiceCaptureController.resumeStandby();
      }
    } else {
      void voiceCaptureController.resumeStandby();
    }
  }
});

function getVehicleCapabilities() {
  return window.vehicleRig?.getCapabilities?.() || {
    originalMovableWindow: false,
    originalMovableTailgate: false,
    originalMovableSeatBack: false,
    manifestBindings: [],
    missingOriginalComponents: ["frontLeftWindow", "tailgate", "driverSeatBackrest"],
    reason: "车模能力尚未初始化，ES7 机械 clip 暂不可用。",
  };
}

function componentCapabilityFromIntent(intent) {
  const map = {
    "body.window.setPosition": "window",
    "body.tailgate.open": "tailgate",
    "seat.driver.setBackrestAngle": "seatBack",
  };
  return map[intent] || "";
}

function getCapabilityLimitation(result, trustedVehicleTool = null) {
  const componentCapability = componentCapabilityFromIntent(
    trustedVehicleTool || result.toolCall?.tool || result.toolResult?.tool
      || result.parsedCommand?.intent,
  );
  const capabilityKeyByType = {
    window: "originalMovableWindow",
    tailgate: "originalMovableTailgate",
    seatBack: "originalMovableSeatBack",
  };
  const labelByType = {
    window: "车窗",
    tailgate: "后备箱 / 尾门",
    seatBack: "座椅靠背",
  };
  const key = capabilityKeyByType[componentCapability];
  if (!key) return null;

  const capabilities = getVehicleCapabilities();
  if (capabilities[key]) return null;

  const boundMeshes = capabilities.originalGlbMeshes?.boundOriginalMeshes?.length
    ? capabilities.originalGlbMeshes.boundOriginalMeshes.join(" / ")
    : "NIO ES7 stable component nodes";
  return {
    title: `${labelByType[componentCapability]}模型能力限制`,
    body: "当前 NIO ES7 动效仅投影已确认的本地模拟车辆状态，不代表接入真实车辆硬件。",
    detail: capabilities.reason,
    meshes: boundMeshes,
    bindings: capabilities.manifestBindings?.length ? capabilities.manifestBindings.join(" / ") : "无 GLB 可动节点绑定",
    missing: capabilities.missingOriginalComponents?.length ? capabilities.missingOriginalComponents.join(" / ") : "无缺失必需组件",
  };
}

function buildVehicleComponentRows() {
  const capabilities = getVehicleCapabilities();
  const manifest = capabilities.componentManifest || {};
  const labelByComponent = {
    body: "车身",
    bodyGlass: "玻璃",
    cabinInterior: "座舱",
    wheels: "轮组",
    rearLights: "尾灯",
    frontLeftWindow: "主驾车窗",
    tailgate: "尾门",
    driverSeatBackrest: "主驾靠背",
    batteryPack: "电池",
    chassis: "底盘",
    sensorModule: "感知模块",
  };

  return Object.entries(manifest).map(([componentId, item]) => {
    const state = item.bound ? "bound" : item.required ? "missing" : "optional";
    const stateLabel = item.bound ? "GLB绑定" : item.required ? "缺失" : "可选";
    return {
      componentId,
      label: labelByComponent[componentId] || componentId,
      state,
      stateLabel,
      action: item.action?.type || item.feedback || "highlight",
      aliases: item.aliases || [],
    };
  });
}

function renderVehicleComponentAuditCard() {
  const capabilities = getVehicleCapabilities();
  const rows = buildVehicleComponentRows();
  const missing = capabilities.missingOriginalComponents || [];
  const bindings = capabilities.manifestBindings || [];
  const modelSource = capabilities.originalGlbMeshes?.source || window.vehicleRig?.getState?.().activeVehicleModelSource || "等待 GLB";
  const source = window.__vehicleComponentManifest?.source || "等待 manifest";

  return `
    <article ${detailCardAttrs("vehicle-component-audit", "detail-card wide component-audit-card")}>
      <h3>车模组件绑定状态</h3>
      <div class="component-audit-summary">
        <span>Manifest：${escapeHtml(source)}</span>
        <span>模型：${escapeHtml(modelSource)}</span>
        <span>GLB绑定 ${bindings.length} / 缺失必需 ${missing.length}</span>
        <span>${escapeHtml(capabilities.modelLoaded ? "GLB 已加载" : "GLB 未完成加载")}</span>
      </div>
      <div class="component-audit-grid">
        ${rows.map((row) => `
          <div class="component-audit-item ${escapeHtml(row.state)}">
            <strong>${escapeHtml(row.label)}</strong>
            <span>${escapeHtml(row.stateLabel)}</span>
            <em>${escapeHtml(row.action)}</em>
          </div>
        `).join("")}
      </div>
      <p class="detail-note">${escapeHtml(capabilities.reason || "车模组件能力来自当前 ES7 GLB 稳定节点和 25 条机械 clip。")}</p>
    </article>
  `;
}

function stringifyDetail(value) {
  if (value === undefined || value === null || value === "") return "无可用数据";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildSemanticAuditDetail(result, semanticDecision) {
  const semanticEnvelope = result?.semanticEnvelope || null;
  return {
    contractVersion: semanticEnvelope?.contractVersion || "unavailable",
    domain: semanticEnvelope?.domain || "unavailable",
    domainConfidence: semanticEnvelope?.domainConfidence ?? null,
    vehicleFrames: semanticEnvelope?.vehicleFrames || [],
    contractValidation: semanticDecision?.contractValidation || null,
    capabilityValidation: semanticDecision?.capabilityValidation || null,
    slotValidation: semanticDecision?.slotValidation || null,
    executionDisabled: result?.executionDisabled === true,
    reasonCode: result?.routeDecision?.reasonCode || null,
    provider: semanticDecision?.provider || null,
    model: semanticDecision?.model || null,
    latencyMs: Number.isFinite(semanticDecision?.durationMs) ? semanticDecision.durationMs : null,
    promptVersion: semanticDecision?.promptVersion || null,
  };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "待测";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function detailCardAttrs(cardKind, classNames = "detail-card") {
  return `class="${escapeHtml(classNames)}" data-testid="run-detail-card" data-card-kind="${escapeHtml(cardKind)}"`;
}

function renderManualEvidenceCards(manualEvidence, safetyDecision, manualQueryPlan, userInput = "", runId = null) {
  return [
    renderManualConversationEvidenceCard(manualEvidence, manualQueryPlan, userInput, runId),
    renderManualSafetyEvidenceCard(safetyDecision),
  ].join("");
}

function renderManualConversationEvidenceCard(manualEvidence, manualQueryPlan, userInput, runId) {
  const presentation = getManualEvidencePresentation(runId);
  const runEvidence = state.manualEvidenceRun.runId === runId ? state.manualEvidenceRun : {};
  const evidenceRefs = presentation.evidenceRefs;
  const telemetry = runEvidence.telemetry || manualEvidence?.telemetry || {};
  const eligibilityPolicy = telemetry.eligibilityPolicy || {};
  const corpusApplicability = telemetry.corpusApplicability || {};
  const query = runEvidence.query || manualEvidence?.query || userInput;
  const statusText = {
    not_requested: "未触发",
    searching: "查询中",
    hit: "已命中",
    miss: "未命中",
    unavailable: "服务不可用",
  }[presentation.status];
  const evidenceRows = evidenceRefs.map((item, index) => `
    <div class="trace-row done">
      <span>Rank ${index + 1} · ${escapeHtml(formatManualEvidencePages(item))}</span>
      <strong>${escapeHtml(`${item.sourceId} / ${item.chunkId}`)}</strong>
      <em>${escapeHtml(`${formatManualEvidenceScores(item.score)} · ${item.excerpt}`)}</em>
    </div>
  `).join("");

  return `
    <article ${detailCardAttrs("manual-conversation-evidence", "detail-card wide")} data-manual-status="${escapeHtml(presentation.status)}">
      <h3>用户手册问答证据</h3>
      <div class="metric-grid compact">
        <div class="metric"><span>状态</span><strong>${escapeHtml(statusText)}</strong></div>
        <div class="metric"><span>检索模式</span><strong>${escapeHtml(telemetry.retrievalMode || "unavailable")}</strong></div>
        <div class="metric"><span>Accepted EvidenceRef</span><strong>${evidenceRefs.length}</strong></div>
        <div class="metric"><span>Embedding</span><strong>${escapeHtml(telemetry.embeddingStatus || "unknown")}</strong></div>
        <div class="metric"><span>Eligibility Policy</span><strong>${escapeHtml(eligibilityPolicy.id ? `${eligibilityPolicy.id}@${eligibilityPolicy.version || "unknown"}` : "unavailable")}</strong></div>
        <div class="metric"><span>Eligibility 结果</span><strong>${escapeHtml(`${telemetry.acceptedCount ?? evidenceRefs.length} accepted / ${telemetry.rejectedCount ?? 0} rejected`)}</strong></div>
        <div class="metric"><span>Miss reason</span><strong>${escapeHtml(telemetry.missReason || telemetry.reason || "--")}</strong></div>
        <div class="metric"><span>车型适用性</span><strong>${escapeHtml(corpusApplicability.reason || "unavailable")}</strong></div>
      </div>
      <p class="detail-note">${escapeHtml(presentation.message)}</p>
      <p class="detail-note">Query：${escapeHtml(query || "未触发手册检索")}</p>
      <p class="detail-note">Query Plan：${escapeHtml(manualQueryPlan?.policy ? `${manualQueryPlan.policy.id}@${manualQueryPlan.policy.version}` : "unavailable")} · ${escapeHtml(`${manualQueryPlan?.knowledgeNeed || "none"} / ${manualQueryPlan?.actionNeed || "none"} / topK ${manualQueryPlan?.adaptiveK ?? "--"}`)}</p>
      ${manualQueryPlan ? `<code>${escapeHtml(stringifyDetail(manualQueryPlan))}</code>` : ""}
      <p class="detail-note">${escapeHtml(presentation.status === "hit"
        ? "回答区仅展示 rank 1 主证据链接；本卡保留全部 accepted EvidenceRef 与分数。"
        : "本状态不生成用户手册链接。")}</p>
      <div class="trace-table">
        ${evidenceRows || `<div class="trace-row muted"><span>${escapeHtml(statusText)}</span><strong>--</strong><em>没有 accepted EvidenceRef</em></div>`}
      </div>
      ${evidenceRefs.length ? `<code data-manual-evidence-refs>${escapeHtml(stringifyDetail(evidenceRefs))}</code>` : ""}
    </article>
  `;
}

function renderManualSafetyEvidenceCard(safetyDecision) {
  const safetyPresentation = createManualSafetyEvidencePresentation(safetyDecision);
  if (!safetyPresentation.visible) return "";
  const summary = safetyDecision?.manualEvidenceSummary || {};
  const evidence = safetyPresentation.evidence;
  const constraints = safetyPresentation.constraints;

  const notes = Array.isArray(safetyDecision?.manualSafetyNotes) ? safetyDecision.manualSafetyNotes : [];
  const telemetry = safetyDecision?.manualEvidenceTelemetry || {};
  const evidenceRows = evidence.map((item) => `
    <div class="trace-row done">
      <span>${escapeHtml(item.citation || formatManualEvidencePages(item))}</span>
      <strong>${escapeHtml(item.category || item.chunkId || "safety-evidence")}</strong>
      <em>${escapeHtml(item.excerpt || item.sectionTitle || "无摘要")}</em>
    </div>
  `).join("");
  const constraintRows = constraints.map((item) => `
    <div class="trace-row done">
      <span>${escapeHtml(item.topic || "manual-constraint")}</span>
      <strong>${escapeHtml(item.constraintType || "audit")}</strong>
      <em>${escapeHtml(item.note || item.citation || "手册约束线索")}</em>
    </div>
  `).join("");

  return `
    <article ${detailCardAttrs("manual-safety-evidence", "detail-card wide")} data-safety-evidence-source="safety-decision">
      <h3>手册安全证据</h3>
      <div class="metric-grid compact">
        <div class="metric"><span>状态</span><strong>${escapeHtml(summary.status || "hit")}</strong></div>
        <div class="metric"><span>检索模式</span><strong>${escapeHtml(summary.retrievalMode || telemetry.retrievalMode || "unavailable")}</strong></div>
        <div class="metric"><span>Safety evidence</span><strong>${evidence.length}</strong></div>
        <div class="metric"><span>Safety constraints</span><strong>${constraints.length}</strong></div>
      </div>
      <p class="detail-note">Query：${escapeHtml(summary.query || safetyDecision.manualEvidenceQuery || "无")}</p>
      ${notes.map((note) => `<p class="detail-note">${escapeHtml(note)}</p>`).join("")}
      <div class="trace-table">${constraintRows}${evidenceRows}</div>
    </article>
  `;
}

function formatManualEvidencePages(item = {}) {
  if (!Number.isInteger(item.pageStart)) return "未标注页码";
  const pageEnd = Number.isInteger(item.pageEnd) ? item.pageEnd : item.pageStart;
  return item.pageStart === pageEnd ? `p.${item.pageStart}` : `pp.${item.pageStart}-${pageEnd}`;
}

function formatManualEvidenceScores(score = {}) {
  const value = (candidate) => Number.isFinite(candidate) ? String(candidate) : "未执行";
  return `retrieval ${value(score.retrieval)} / rerank ${value(score.rerank)} / grounding ${value(score.grounding)}`;
}

function renderWeatherLocationClarificationCard(clarification) {
  if (!clarification) return "";
  const candidates = Array.isArray(clarification.candidates) ? clarification.candidates : [];
  const candidateRows = candidates.slice(0, 5).map((item) => `
    <div class="trace-row blocked">
      <span>${escapeHtml(item.city || "未知地点")}</span>
      <strong>${escapeHtml([item.admin1, item.country].filter(Boolean).join(" · ") || "需补充地区")}</strong>
      <em>${escapeHtml(Number.isFinite(item.latitude) && Number.isFinite(item.longitude) ? `${item.latitude}, ${item.longitude}` : "坐标不可用")}</em>
    </div>
  `).join("");
  return `
    <article ${detailCardAttrs("weather-location-clarification", "detail-card wide")}>
      <h3>天气地点澄清</h3>
      <div class="metric-grid compact">
        <div class="metric"><span>Policy</span><strong>${escapeHtml(clarification.policy || "unavailable")}</strong></div>
        <div class="metric"><span>错误码</span><strong>${escapeHtml(clarification.code || "unknown")}</strong></div>
        <div class="metric"><span>请求地点</span><strong>${escapeHtml(clarification.requestedName || clarification.reference || "未提供")}</strong></div>
        <div class="metric"><span>候选数</span><strong>${escapeHtml(candidates.length)}</strong></div>
      </div>
      <p class="detail-note">${escapeHtml(clarification.clarification || "请明确要查询天气的城市或地区。")}</p>
      <div class="trace-table">
        ${candidateRows || `<div class="trace-row muted"><span>无候选项</span><strong>--</strong><em>需要可信 LocationContext 或用户明确城市</em></div>`}
      </div>
      <code>${escapeHtml(stringifyDetail(clarification))}</code>
    </article>
  `;
}

function getPendingConfirmationAssertions(pending) {
  const assertions = Array.isArray(pending?.challenge?.assertions) ? pending.challenge.assertions : [];
  return assertions
    .map((assertion) => ({
      id: String(assertion?.id || "").trim(),
      prompt: String(assertion?.prompt || "").trim(),
    }))
    .filter((assertion) => assertion.id && assertion.prompt);
}

function describePendingConfirmation(pending) {
  const assertions = getPendingConfirmationAssertions(pending);
  const summary = assertions.map((assertion) => assertion.prompt).join("；");
  return summary || pending?.reason || "用户完成安全二次确认";
}

function renderPendingConfirmationModal() {
  const modal = els.safetyConfirmationModal;
  if (!modal) return;
  const pending = buildPendingConfirmationViewModel(state.pendingConfirmation);
  const ownerId = pending?.challenge?.id || "";
  if (!pending?.challenge || !ownerId) {
    const wasOpen = modal.hidden === false;
    modal.hidden = true;
    document.body.classList.remove("safety-confirmation-open");
    confirmationModalOwnerId = null;
    if (wasOpen) {
      const returnFocus = confirmationModalReturnFocus;
      confirmationModalReturnFocus = null;
      window.queueMicrotask(() => {
        if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
      });
    }
    return;
  }

  const opening = modal.hidden || confirmationModalOwnerId !== ownerId;
  if (opening && modal.hidden) confirmationModalReturnFocus = document.activeElement;
  if (opening) {
    state.voiceConfirmation.fallbackUsed = false;
    state.voiceConfirmation.recording = false;
    state.voiceConfirmation.processing = false;
  }
  confirmationModalOwnerId = ownerId;
  els.safetyConfirmationReason.textContent = pending.reason || "当前动作需要用户二次确认。";
  els.safetyConfirmationAction.textContent = pending.input || pending.intent || "待确认车辆动作";
  els.safetyConfirmationAlternative.textContent = pending.alternative;
  els.safetyConfirmationAlternativeRow.hidden = !pending.alternative;
  els.safetyConfirmationAssertions.replaceChildren();
  const assertions = getPendingConfirmationAssertions(pending);
  const prompts = assertions.length
    ? assertions.map((assertion) => assertion.prompt)
    : ["我已理解本次安全提示，并确认继续执行。"];
  prompts.forEach((prompt) => {
    const item = document.createElement("li");
    item.textContent = prompt;
    els.safetyConfirmationAssertions.append(item);
  });
  const voiceReady = state.voiceIdentity?.verification?.status === "calibrated"
    && state.voiceIdentity?.profileStatus === "enrolled"
    && VOICE_IDENTITY_CONFIRMATION_ENABLED
    && Boolean(voiceConfirmationRecorder);
  const voiceConfirmation = state.voiceConfirmation;
  els.safetyConfirmationVoiceState.dataset.state = voiceConfirmation.processing
    ? "processing"
    : voiceConfirmation.recording ? "listening" : voiceReady ? "ready" : "unavailable";
  els.safetyConfirmationVoiceState.textContent = voiceConfirmation.processing
    ? "正在本机校验确认短语与主驾声纹……"
    : voiceConfirmation.recording
      ? "正在录音，请说“确认执行”或“取消”。"
      : voiceReady
        ? voiceConfirmation.fallbackUsed
          ? "短语未通过，请按提示完整说“我是主驾，我确认执行”，或使用屏幕按钮。"
          : "可使用本机已标定的主驾声纹完成语音确认。"
        : "语音确认不可用，请使用屏幕按钮。";
  els.safetyConfirmationVoiceState.hidden = !VOICE_IDENTITY_CONFIRMATION_ENABLED;
  const controlsBusy = confirmationControlsBusy();
  els.safetyConfirmationDialog.setAttribute("aria-busy", String(controlsBusy));
  els.safetyConfirmationCancel.disabled = controlsBusy;
  els.safetyConfirmationConfirm.disabled = controlsBusy;
  if (els.safetyConfirmationVoice) {
    els.safetyConfirmationVoice.hidden = !VOICE_IDENTITY_CONFIRMATION_ENABLED;
    els.safetyConfirmationVoice.disabled = controlsBusy || !voiceReady || voiceConfirmation.processing;
    els.safetyConfirmationVoice.textContent = voiceConfirmation.recording ? "结束录音" : "录音确认";
  }
  modal.hidden = false;
  document.body.classList.add("safety-confirmation-open");
  if (opening) {
    window.queueMicrotask(() => {
      const focusTarget = els.safetyConfirmationCancel?.disabled
        ? els.safetyConfirmationDialog
        : els.safetyConfirmationCancel;
      focusTarget?.focus();
    });
  }
}

// A Run that has finished executing but is still speaking its reply must not block the safety
// confirmation modal: the user may act at once, which stops the playback first.
function confirmationControlsBusy() {
  return state.running && state.speechOnlyTurnId === null;
}

async function finishSpokenTurnForConfirmation() {
  if (!state.running) return true;
  const turnId = state.speechOnlyTurnId;
  if (turnId === null) return false;
  const entry = pendingTurnExecutions.get(turnId);
  stopVoiceOutput();
  await entry?.completion;
  return !state.running;
}

function cancelPendingAction() {
  const pending = state.pendingConfirmation;
  if (!pending?.challenge || confirmationControlsBusy()) return false;
  const claim = confirmationDecisionGate.claim({
    challengeId: pending.challenge.id,
    channel: "cancel",
  });
  if (!claim) return false;
  if (state.running) stopVoiceOutput();
  state.pendingConfirmation = null;
  addRuntimeEvent("safety", `用户取消安全确认：${describePendingConfirmation(pending)}。未重新进入 Runtime`, "info");
  setMode("blocked", "已取消本次安全确认");
  renderRunSummary();
  renderRunDetails();
  confirmationDecisionGate.release(claim);
  return true;
}

function handleConfirmationModalKeydown(event) {
  if (els.safetyConfirmationModal?.hidden !== false) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelPendingAction();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...els.safetyConfirmationDialog.querySelectorAll(
    'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  if (!focusable.length) {
    event.preventDefault();
    els.safetyConfirmationDialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!els.safetyConfirmationDialog.contains(document.activeElement)
    || document.activeElement === els.safetyConfirmationDialog) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function renderVoiceOutputControls() {
  const supported = state.voiceOutput.supported;
  const speaking = state.voiceOutput.status === "speaking";
  const paused = state.voiceOutput.status === "paused";
  const loading = state.voiceOutput.status === "loading";

  if (els.ttsPauseButton) els.ttsPauseButton.disabled = !supported || !speaking;
  if (els.ttsResumeButton) els.ttsResumeButton.disabled = !supported || !paused;
  if (els.ttsStopButton) els.ttsStopButton.disabled = !supported || (!speaking && !paused && !loading);
  if (els.ttsProviderStatus) els.ttsProviderStatus.textContent = `语音：${state.voiceOutput.providerLabel}`;
}

function setVoiceOutputStatus(status, providerLabel = state.voiceOutput.providerLabel) {
  state.voiceOutput.status = status;
  state.voiceOutput.providerLabel = providerLabel;
  renderVoiceOutputControls();
}

function renderNetworkStatus() {
  if (!els.networkMetric) return;
  const status = {
    value: "网络未知",
    source: "dev-fixture",
    capturedAt: new Date().toISOString(),
  };
  els.networkMetric.textContent = `开发环境 · ${status.value}`;
  els.networkMetric.title = `source=${status.source}; capturedAt=${status.capturedAt}; 未接入真实网络状态 provider`;
}

function renderModelRouteStatus(result = null, { effectiveVehicleControl = false } = {}) {
  if (!els.modelRouteMetric) return;
  if (!result) {
    els.modelRouteMetric.textContent = "待运行";
    els.modelRouteMetric.title = "等待 Runtime 结果";
    return;
  }
  const routeId = result.routeDecision?.routeId || null;
  const degraded = result.runtimeTelemetry?.degraded === true || result.mode === "degraded";
  const routeLabel = {
    chat: "Cabin 对话",
    "vehicle-knowledge": "车辆知识",
    "vehicle-control": "车辆控制",
    task: result.routeDecision?.mode === "orchestrated" ? "协同任务" : "外部能力",
  }[routeId];
  const label = routeLabel || (!effectiveVehicleControl
    && result.parsedCommand?.intent === "conversation.general"
    ? degraded ? "本地对话兜底" : "本地 LLM 对话"
    : degraded ? "本地规则兜底" : "本地模型链路");
  els.modelRouteMetric.textContent = label;
  els.modelRouteMetric.title = `route=${routeId || "unknown"}; mode=${result.routeDecision?.mode || result.mode || "unknown"}; source=runtime`;
}

function renderDemoReadiness() {
  if (!state.demoReadiness || !els.demoReadinessContent) return;
  const view = projectDemoReadinessView(state.demoReadiness);
  if (els.demoReadinessSummary) els.demoReadinessSummary.textContent = view.summary;
  if (els.demoReadinessElapsed) els.demoReadinessElapsed.textContent = view.elapsedLabel;
  if (els.demoReadinessPanel) els.demoReadinessPanel.dataset.state = view.status;
  if (els.demoReadinessToggle) {
    els.demoReadinessToggle.dataset.state = view.status;
    els.demoReadinessToggle.title = `${view.statusLabel} · 点击查看各步骤模型服务级别`;
  }
  els.demoReadinessContent.innerHTML = view.stages.map((stage) => {
    const configuredService = [stage.provider, stage.model].filter(Boolean).join(" · ") || "无外部模型";
    const activeService = [stage.activeProvider, stage.activeModel].filter(Boolean).join(" · ");
    const activeLabel = activeService
      ? `${stage.activeLevelLabel} · ${activeService}`
      : stage.activeLevelLabel;
    return `
      <article class="demo-readiness-stage" data-state="${escapeHtml(stage.status)}">
        <div>
          <strong>${escapeHtml(stage.label)}</strong>
          <span>${escapeHtml(configuredService)}</span>
          <small>${escapeHtml(stage.verification || "状态检查")}</small>
        </div>
        <div>
          <span>配置级别</span>
          <strong class="demo-readiness-level">${escapeHtml(stage.configuredLevelLabel)}</strong>
          <small>实际使用：${escapeHtml(activeLabel)}</small>
        </div>
        <div class="demo-readiness-stage-status">
          <strong>${escapeHtml(stage.statusLabel)}</strong>
          <span>${escapeHtml(`${stage.durationMs} ms`)}</span>
          ${stage.reasonLabel ? `<small title="${escapeHtml(stage.reasonLabel)}">${escapeHtml(stage.reasonLabel)}</small>` : ""}
        </div>
      </article>
    `;
  }).join("");
}

function updateDemoReadinessFromRuntime(
  result = state.lastRuntimeResult,
  voiceProvider = null,
  localVoiceService = state.localVoiceActiveService,
) {
  if (!state.demoReadiness) return;
  state.demoReadiness = applyRuntimeActiveLevels(state.demoReadiness, result, {
    voiceProvider,
    localVoiceService,
  });
  renderDemoReadiness();
}

function updateDemoVehicleAssetStatus(status) {
  state.demoReadinessVehicleAssetStatus = status;
  if (!state.demoReadiness) return;
  state.demoReadiness = applyVehicleAssetStatus(state.demoReadiness, status);
  renderDemoReadiness();
}

async function refreshDemoReadiness() {
  const snapshot = await loadDemoReadiness();
  state.demoReadiness = applyVehicleAssetStatus(snapshot, state.demoReadinessVehicleAssetStatus);
  state.demoReadiness = applyRuntimeActiveLevels(state.demoReadiness, state.lastRuntimeResult, {
    voiceProvider: state.voiceOutput.activeProvider,
    localVoiceService: state.localVoiceActiveService,
  });
  renderDemoReadiness();
  return state.demoReadiness;
}

function startDemoReadinessPolling() {
  const poll = async () => {
    const snapshot = await refreshDemoReadiness();
    const elapsed = Date.now() - state.demoReadinessStartedAt;
    if (snapshot.status === "full" || elapsed >= 30_000) {
      state.demoReadinessPollingTimer = null;
      return;
    }
    if (shouldRetryDemoLocalWarmup(snapshot)) void startRuntimeWarmup();
    state.demoReadinessPollingTimer = window.setTimeout(poll, 2_000);
  };
  poll();
}

function setupDemoReadinessPanel() {
  els.demoReadinessToggle?.addEventListener("click", () => {
    const expanded = els.demoReadinessToggle.getAttribute("aria-expanded") === "true";
    els.demoReadinessToggle.setAttribute("aria-expanded", String(!expanded));
    if (els.demoReadinessPanel) els.demoReadinessPanel.hidden = expanded;
  });
  els.demoReadinessRefresh?.addEventListener("click", () => {
    const tasks = [refreshDemoReadiness()];
    if (VOICE_IDENTITY_CONFIRMATION_ENABLED) tasks.push(refreshVoiceIdentityStatus());
    void Promise.all(tasks);
  });
  document.addEventListener("keydown", (event) => {
    if (els.safetyConfirmationModal?.hidden === false) return;
    if (event.key !== "Escape" || els.demoReadinessPanel?.hidden !== false) return;
    els.demoReadinessPanel.hidden = true;
    els.demoReadinessToggle?.setAttribute("aria-expanded", "false");
    els.demoReadinessToggle?.focus();
  });
}

function renderVoiceIdentitySettings(status = state.voiceIdentity) {
  if (!VOICE_IDENTITY_CONFIRMATION_ENABLED) {
    if (els.voiceIdentitySettings) els.voiceIdentitySettings.hidden = true;
    return;
  }
  if (els.voiceIdentitySettings) els.voiceIdentitySettings.hidden = false;
  const view = projectVoiceIdentityView(status);
  const enrollment = state.voiceIdentityEnrollment;
  const calibration = state.voiceIdentityCalibration;
  const enrollmentActive = Boolean(enrollment.session);
  const calibrationActive = Boolean(calibration.session);
  const anyFlowActive = enrollmentActive || calibrationActive;
  if (els.voiceIdentitySettings) els.voiceIdentitySettings.dataset.state = status.capabilityStatus;
  if (els.voiceIdentityStatus) {
    els.voiceIdentityStatus.textContent = view.statusLabel;
    els.voiceIdentityStatus.dataset.state = status.capabilityStatus;
  }
  if (els.voiceIdentityReason) {
    els.voiceIdentityReason.textContent = enrollmentActive
      ? `请完成第 ${enrollment.session.acceptedCount + 1} 段，朗读后点击结束；最长自动录制 6 秒。`
      : view.reasonLabel
        || (view.available ? "请依次朗读三句固定短句。" : "声纹能力当前不可用。" );
  }
  if (els.voiceIdentityEnrollButton) {
    els.voiceIdentityEnrollButton.textContent = enrollmentActive ? "注册进行中" : view.actionLabel;
    els.voiceIdentityEnrollButton.disabled = anyFlowActive
      || view.actionDisabled
      || !voiceIdentityRecorder;
    els.voiceIdentityEnrollButton.title = !voiceIdentityRecorder
      ? "当前浏览器不支持本地 PCM 录音"
      : view.actionDisabled ? view.reasonLabel : "";
  }
  if (els.voiceIdentityCancelButton) {
    els.voiceIdentityCancelButton.hidden = !enrollmentActive;
    els.voiceIdentityCancelButton.disabled = Boolean(enrollment.processingPhraseId);
  }
  if (els.voiceIdentityDeleteButton) els.voiceIdentityDeleteButton.hidden = anyFlowActive
    || !view.deleteVisible;
  if (els.voiceIdentityCalibrationStatus) {
    els.voiceIdentityCalibrationStatus.textContent = view.calibrationStatusLabel;
    els.voiceIdentityCalibrationStatus.dataset.state = view.calibrationStatus;
  }
  if (els.voiceIdentityCalibrationReason) {
    els.voiceIdentityCalibrationReason.textContent = calibrationActive
      ? `请完成第 ${calibration.session.acceptedCount + 1} / ${PRIMARY_DRIVER_CALIBRATION_SAMPLE_COUNT} 段；按提示调整距离与环境。`
      : !view.enrolled
        ? "请先完成三段主驾声纹注册，再进行安全确认标定。"
        : view.calibrationStatus === "calibrated"
          ? "当前验证策略已与主驾声纹档案绑定；重新注册后需要重新标定。"
          : `按三种距离与环境依次录制${PRIMARY_DRIVER_CALIBRATION_SAMPLE_COUNT}段，完成后仅保存本地验证策略。`;
  }
  if (els.voiceIdentityCalibrationSteps) {
    els.voiceIdentityCalibrationSteps.hidden = !view.enrolled && !calibrationActive;
  }
  if (els.voiceIdentityCalibrateButton) {
    els.voiceIdentityCalibrateButton.textContent = calibrationActive
      ? "标定进行中"
      : view.calibrationActionLabel;
    els.voiceIdentityCalibrateButton.disabled = anyFlowActive
      || !view.calibrationAvailable
      || !voiceIdentityRecorder;
  }
  if (els.voiceIdentityCalibrationCancelButton) {
    els.voiceIdentityCalibrationCancelButton.hidden = !calibrationActive;
    els.voiceIdentityCalibrationCancelButton.disabled = Boolean(calibration.processingStepId);
  }
  renderVoiceIdentityEnrollmentSteps();
  renderVoiceIdentityCalibrationSteps();
}

function renderVoiceIdentityEnrollmentSteps() {
  const enrollment = state.voiceIdentityEnrollment;
  const currentPhraseId = enrollment.session?.nextPhraseId || null;
  for (const [index, phrase] of PRIMARY_DRIVER_ENROLLMENT_PHRASES.entries()) {
    const item = els.voiceIdentityPhraseItems.find(
      (candidate) => candidate.dataset.voicePhrase === phrase.id,
    );
    const button = els.voiceIdentityRecordButtons.find(
      (candidate) => candidate.dataset.voiceRecord === phrase.id,
    );
    const step = enrollment.stepStates.get(phrase.id) || { state: "pending", label: "未录制" };
    if (item) {
      item.dataset.state = step.state;
      const status = item.querySelector("small");
      if (status) status.textContent = step.label;
    }
    if (!button) continue;
    const recording = enrollment.recordingPhraseId === phrase.id;
    const processing = enrollment.processingPhraseId === phrase.id;
    button.textContent = recording
      ? "结束并检查"
      : processing ? "正在检查" : step.state === "accepted" ? "已完成" : `录制第 ${index + 1} 段`;
    button.disabled = step.state === "accepted"
      || processing
      || Boolean(enrollment.processingPhraseId)
      || (Boolean(enrollment.recordingPhraseId) && !recording)
      || !enrollment.session
      || (!recording && currentPhraseId !== phrase.id);
  }
}

function setVoiceIdentityStepState(phraseId, stepState, label) {
  state.voiceIdentityEnrollment.stepStates.set(phraseId, { state: stepState, label });
  renderVoiceIdentitySettings();
}

function buildVoiceIdentityCalibrationSteps() {
  if (!els.voiceIdentityCalibrationSteps
    || els.voiceIdentityCalibrationSteps.childElementCount > 0) return;
  for (const [index, step] of PRIMARY_DRIVER_CALIBRATION_STEPS.entries()) {
    const item = document.createElement("li");
    item.dataset.voiceCalibrationStep = step.id;
    item.dataset.state = "pending";
    const number = document.createElement("span");
    number.textContent = String(index + 1);
    const description = document.createElement("div");
    const prompt = document.createElement("p");
    prompt.textContent = step.prompt;
    const status = document.createElement("small");
    status.setAttribute("role", "status");
    status.textContent = `${step.conditionLabel} · 未录制`;
    description.append(prompt, status);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.voiceCalibrationRecord = step.id;
    button.textContent = `录制第 ${index + 1} 段`;
    button.disabled = true;
    button.addEventListener("click", () => {
      if (state.voiceIdentityCalibration.recordingStepId === step.id) {
        void processVoiceIdentityCalibrationRecording(step.id);
      } else {
        void startVoiceIdentityCalibrationRecording(step.id);
      }
    });
    item.append(number, description, button);
    els.voiceIdentityCalibrationSteps.append(item);
  }
}

function renderVoiceIdentityCalibrationSteps() {
  const calibration = state.voiceIdentityCalibration;
  const currentStepId = calibration.session?.nextStepId || null;
  for (const [index, step] of PRIMARY_DRIVER_CALIBRATION_STEPS.entries()) {
    const item = els.voiceIdentityCalibrationSteps?.querySelector(
      `[data-voice-calibration-step="${step.id}"]`,
    );
    const button = item?.querySelector(`[data-voice-calibration-record="${step.id}"]`);
    const stepState = calibration.stepStates.get(step.id)
      || { state: "pending", label: `${step.conditionLabel} · 未录制` };
    if (item) {
      item.dataset.state = stepState.state;
      const status = item.querySelector("small");
      if (status) status.textContent = stepState.label;
    }
    if (!button) continue;
    const recording = calibration.recordingStepId === step.id;
    const processing = calibration.processingStepId === step.id;
    button.textContent = recording
      ? "结束并检查"
      : processing ? "正在检查" : stepState.state === "accepted"
        ? "已完成"
        : `录制第 ${index + 1} 段`;
    button.disabled = stepState.state === "accepted"
      || processing
      || Boolean(calibration.processingStepId)
      || (Boolean(calibration.recordingStepId) && !recording)
      || !calibration.session
      || (!recording && currentStepId !== step.id);
  }
}

function setVoiceIdentityCalibrationStepState(stepId, stepState, label) {
  state.voiceIdentityCalibration.stepStates.set(stepId, { state: stepState, label });
  renderVoiceIdentitySettings();
}

function stopVoiceIdentityRecordingTimer() {
  if (state.voiceIdentityEnrollment.timer) window.clearInterval(state.voiceIdentityEnrollment.timer);
  state.voiceIdentityEnrollment.timer = null;
}

function stopVoiceIdentityCalibrationTimer() {
  if (state.voiceIdentityCalibration.timer) {
    window.clearInterval(state.voiceIdentityCalibration.timer);
  }
  state.voiceIdentityCalibration.timer = null;
}

async function restoreLocalVoiceAfterEnrollment() {
  const shouldRestore = state.voiceIdentityEnrollment.restoreLocalVoiceStandby;
  state.voiceIdentityEnrollment.restoreLocalVoiceStandby = false;
  if (shouldRestore) await voiceCaptureController?.resumeStandby();
}

async function beginVoiceIdentityEnrollment() {
  if (!voiceIdentityRecorder || state.voiceIdentityEnrollment.session
    || state.voiceIdentityCalibration.session) return;
  els.voiceIdentityEnrollButton.disabled = true;
  try {
    const restoreLocalVoiceStandby = voiceCaptureController?.getSnapshot().enabled === true;
    if (restoreLocalVoiceStandby) await voiceCaptureController.suspendForBrowserRecognition();
    try {
      const session = await startVoiceIdentityEnrollment();
      state.voiceIdentityEnrollment.session = session;
      state.voiceIdentityEnrollment.restoreLocalVoiceStandby = restoreLocalVoiceStandby;
      state.voiceIdentityEnrollment.stepStates.clear();
      els.voiceIdentityManageButton?.setAttribute("aria-expanded", "true");
      if (els.voiceIdentityEnrollment) els.voiceIdentityEnrollment.hidden = false;
      renderVoiceIdentitySettings();
    } catch (error) {
      if (restoreLocalVoiceStandby) await voiceCaptureController?.resumeStandby();
      throw error;
    }
  } catch {
    addRuntimeEvent("voice", "无法开始主驾声纹注册，本地档案保持不变", "warning");
    await refreshVoiceIdentityStatus();
  }
}

async function startVoiceIdentityPhraseRecording(phraseId) {
  const enrollment = state.voiceIdentityEnrollment;
  if (!enrollment.session || enrollment.session.nextPhraseId !== phraseId
    || enrollment.recordingPhraseId || enrollment.processingPhraseId) return;
  setVoiceIdentityStepState(phraseId, "recording", "正在请求麦克风");
  try {
    await voiceIdentityRecorder.start({
      onAutoStop: (pcm) => processVoiceIdentityPhraseRecording(phraseId, pcm),
    });
    enrollment.recordingPhraseId = phraseId;
    setVoiceIdentityStepState(phraseId, "recording", "正在录制 0.0 秒");
    const startedAt = performance.now();
    stopVoiceIdentityRecordingTimer();
    enrollment.timer = window.setInterval(() => {
      if (enrollment.recordingPhraseId !== phraseId) return;
      const elapsed = Math.min(6, (performance.now() - startedAt) / 1000);
      const item = els.voiceIdentityPhraseItems.find(
        (candidate) => candidate.dataset.voicePhrase === phraseId,
      );
      const status = item?.querySelector("small");
      if (status) status.textContent = `正在录制 ${elapsed.toFixed(1)} 秒`;
    }, 100);
  } catch (error) {
    enrollment.recordingPhraseId = null;
    setVoiceIdentityStepState(
      phraseId,
      "rejected",
      error?.name === "NotAllowedError" ? "未获得麦克风权限" : "无法启动本地录音",
    );
  }
}

async function processVoiceIdentityPhraseRecording(phraseId, suppliedPcm = null) {
  const enrollment = state.voiceIdentityEnrollment;
  if (!enrollment.session || enrollment.processingPhraseId) return;
  enrollment.processingPhraseId = phraseId;
  enrollment.recordingPhraseId = null;
  stopVoiceIdentityRecordingTimer();
  setVoiceIdentityStepState(phraseId, "recording", "正在本地检查语音质量");
  try {
    const pcm = suppliedPcm || await voiceIdentityRecorder.stop();
    const result = await submitVoiceIdentitySample({
      sessionId: enrollment.session.sessionId,
      phraseId,
      pcm,
    });
    if (result.outcome !== "accepted") {
      setVoiceIdentityStepState(
        phraseId,
        "rejected",
        VOICE_IDENTITY_OUTCOME_LABELS[result.outcome] || "录音未通过，请重试",
      );
      return;
    }
    enrollment.session = result.complete ? null : result;
    setVoiceIdentityStepState(phraseId, "accepted", "录制通过");
    if (!result.complete) return;
    addRuntimeEvent("voice", "三段主驾声纹已在本机完成聚合注册", "success");
    await refreshVoiceIdentityStatus();
    await restoreLocalVoiceAfterEnrollment();
  } catch {
    setVoiceIdentityStepState(phraseId, "rejected", "本地检查失败，请重新录制");
  } finally {
    enrollment.processingPhraseId = null;
    renderVoiceIdentitySettings();
  }
}

async function cancelActiveVoiceIdentityEnrollment() {
  const enrollment = state.voiceIdentityEnrollment;
  const sessionId = enrollment.session?.sessionId;
  stopVoiceIdentityRecordingTimer();
  await voiceIdentityRecorder?.cancel();
  if (sessionId) await cancelVoiceIdentityEnrollment(sessionId).catch(() => {});
  enrollment.session = null;
  enrollment.recordingPhraseId = null;
  enrollment.processingPhraseId = null;
  enrollment.stepStates.clear();
  await restoreLocalVoiceAfterEnrollment();
  renderVoiceIdentitySettings();
}

async function restoreLocalVoiceAfterCalibration() {
  const shouldRestore = state.voiceIdentityCalibration.restoreLocalVoiceStandby;
  state.voiceIdentityCalibration.restoreLocalVoiceStandby = false;
  if (shouldRestore) await voiceCaptureController?.resumeStandby();
}

async function beginVoiceIdentityCalibration() {
  const calibration = state.voiceIdentityCalibration;
  if (!voiceIdentityRecorder || calibration.session || state.voiceIdentityEnrollment.session) return;
  els.voiceIdentityCalibrateButton.disabled = true;
  try {
    const restoreLocalVoiceStandby = voiceCaptureController?.getSnapshot().enabled === true;
    if (restoreLocalVoiceStandby) await voiceCaptureController.suspendForBrowserRecognition();
    try {
      const session = await startVoiceIdentityCalibration();
      calibration.session = session;
      calibration.restoreLocalVoiceStandby = restoreLocalVoiceStandby;
      calibration.stepStates.clear();
      els.voiceIdentityManageButton?.setAttribute("aria-expanded", "true");
      if (els.voiceIdentityEnrollment) els.voiceIdentityEnrollment.hidden = false;
      renderVoiceIdentitySettings();
    } catch (error) {
      if (restoreLocalVoiceStandby) await voiceCaptureController?.resumeStandby();
      throw error;
    }
  } catch {
    addRuntimeEvent("voice", "无法开始安全确认声纹标定，当前档案与策略保持不变", "warning");
    await refreshVoiceIdentityStatus();
  }
}

async function startVoiceIdentityCalibrationRecording(stepId) {
  const calibration = state.voiceIdentityCalibration;
  if (!calibration.session || calibration.session.nextStepId !== stepId
    || calibration.recordingStepId || calibration.processingStepId) return;
  const step = PRIMARY_DRIVER_CALIBRATION_STEPS.find((candidate) => candidate.id === stepId);
  setVoiceIdentityCalibrationStepState(stepId, "recording", "正在请求麦克风");
  try {
    await voiceIdentityRecorder.start({
      onAutoStop: (pcm) => processVoiceIdentityCalibrationRecording(stepId, pcm),
    });
    calibration.recordingStepId = stepId;
    setVoiceIdentityCalibrationStepState(stepId, "recording", `${step.conditionLabel} · 正在录制 0.0 秒`);
    const startedAt = performance.now();
    stopVoiceIdentityCalibrationTimer();
    calibration.timer = window.setInterval(() => {
      if (calibration.recordingStepId !== stepId) return;
      const elapsed = Math.min(6, (performance.now() - startedAt) / 1000);
      const item = els.voiceIdentityCalibrationSteps?.querySelector(
        `[data-voice-calibration-step="${stepId}"]`,
      );
      const status = item?.querySelector("small");
      if (status) status.textContent = `${step.conditionLabel} · 正在录制 ${elapsed.toFixed(1)} 秒`;
    }, 100);
  } catch (error) {
    calibration.recordingStepId = null;
    setVoiceIdentityCalibrationStepState(
      stepId,
      "rejected",
      error?.name === "NotAllowedError" ? "未获得麦克风权限" : "无法启动本地录音",
    );
  }
}

async function processVoiceIdentityCalibrationRecording(stepId, suppliedPcm = null) {
  const calibration = state.voiceIdentityCalibration;
  if (!calibration.session || calibration.processingStepId) return;
  calibration.processingStepId = stepId;
  calibration.recordingStepId = null;
  stopVoiceIdentityCalibrationTimer();
  setVoiceIdentityCalibrationStepState(stepId, "recording", "正在本地检查语音质量与一致性");
  try {
    const pcm = suppliedPcm || await voiceIdentityRecorder.stop();
    const result = await submitVoiceIdentityCalibrationSample({
      sessionId: calibration.session.sessionId,
      stepId,
      pcm,
    });
    if (result.outcome === "calibration-insufficient") {
      calibration.session = result;
      setVoiceIdentityCalibrationStepState(
        stepId,
        "rejected",
        `第 ${result.acceptedCount + 1} 段一致性不足，请重新录制`,
      );
      addRuntimeEvent("voice", "当前段一致性不足，已保留前面通过的样本，可直接重录当前段", "warning");
      return;
    }
    if (result.outcome !== "accepted") {
      setVoiceIdentityCalibrationStepState(
        stepId,
        "rejected",
        VOICE_IDENTITY_OUTCOME_LABELS[result.outcome] || "录音未通过，请重试",
      );
      return;
    }
    calibration.session = result.complete ? null : result;
    setVoiceIdentityCalibrationStepState(stepId, "accepted", "录制通过");
    if (!result.complete) return;
    addRuntimeEvent("voice", "五段主驾声纹标定已完成，本地验证策略已生效", "success");
    await refreshVoiceIdentityStatus();
    await restoreLocalVoiceAfterCalibration().catch(() => {});
  } catch {
    setVoiceIdentityCalibrationStepState(stepId, "rejected", "本地检查失败，请重新录制");
  } finally {
    calibration.processingStepId = null;
    renderVoiceIdentitySettings();
  }
}

async function cancelActiveVoiceIdentityCalibration() {
  const calibration = state.voiceIdentityCalibration;
  const sessionId = calibration.session?.sessionId;
  stopVoiceIdentityCalibrationTimer();
  await voiceIdentityRecorder?.cancel();
  if (sessionId) await cancelVoiceIdentityCalibration(sessionId).catch(() => {});
  calibration.session = null;
  calibration.recordingStepId = null;
  calibration.processingStepId = null;
  calibration.stepStates.clear();
  await restoreLocalVoiceAfterCalibration().catch(() => {});
  renderVoiceIdentitySettings();
}

async function refreshVoiceIdentityStatus() {
  try {
    state.voiceIdentity = await loadVoiceIdentityStatus();
  } catch {
    state.voiceIdentity = createUnavailableVoiceIdentityStatus();
  }
  renderVoiceIdentitySettings();
  return state.voiceIdentity;
}

function setupVoiceIdentitySettings() {
  if (!VOICE_IDENTITY_CONFIRMATION_ENABLED) return;
  buildVoiceIdentityCalibrationSteps();
  renderVoiceIdentitySettings();
  els.voiceIdentityManageButton?.addEventListener("click", () => {
    const expanded = els.voiceIdentityManageButton.getAttribute("aria-expanded") === "true";
    els.voiceIdentityManageButton.setAttribute("aria-expanded", String(!expanded));
    if (els.voiceIdentityEnrollment) els.voiceIdentityEnrollment.hidden = expanded;
  });
  els.voiceIdentityEnrollButton?.addEventListener("click", beginVoiceIdentityEnrollment);
  els.voiceIdentityRecordButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const phraseId = button.dataset.voiceRecord;
      if (state.voiceIdentityEnrollment.recordingPhraseId === phraseId) {
        void processVoiceIdentityPhraseRecording(phraseId);
      } else {
        void startVoiceIdentityPhraseRecording(phraseId);
      }
    });
  });
  els.voiceIdentityCancelButton?.addEventListener("click", () => {
    void cancelActiveVoiceIdentityEnrollment();
  });
  els.voiceIdentityCalibrateButton?.addEventListener("click", beginVoiceIdentityCalibration);
  els.voiceIdentityCalibrationCancelButton?.addEventListener("click", () => {
    void cancelActiveVoiceIdentityCalibration();
  });
  els.voiceIdentityDeleteButton?.addEventListener("click", async () => {
    if (!window.confirm("确认删除当前 Mac 上的主驾声纹？删除后语音安全确认将不可用。")) return;
    els.voiceIdentityDeleteButton.disabled = true;
    try {
      state.voiceIdentity = await deleteVoiceIdentityProfile();
      renderVoiceIdentitySettings();
      addRuntimeEvent("voice", "本地主驾声纹已删除", "info");
    } catch {
      addRuntimeEvent("voice", "本地主驾声纹删除失败，档案保持不变", "warning");
    } finally {
      els.voiceIdentityDeleteButton.disabled = false;
    }
  });
  window.addEventListener("beforeunload", () => {
    stopVoiceIdentityRecordingTimer();
    stopVoiceIdentityCalibrationTimer();
    const calibrationSessionId = state.voiceIdentityCalibration.session?.sessionId;
    if (calibrationSessionId && typeof navigator.sendBeacon === "function") {
      const query = new URLSearchParams({ sessionId: calibrationSessionId });
      navigator.sendBeacon(`/api/local-voice/identity/calibration/cancel?${query}`);
    }
    void voiceIdentityRecorder?.cancel();
  });
  void refreshVoiceIdentityStatus();
}

const localVoiceStatusLabels = Object.freeze({
  disabled: "常驻唤醒未启用",
  arming: "正在检查本地模型与麦克风",
  disabling: "正在关闭常驻唤醒",
  standby: "正在本地等待 NOMI / 嗨，NOMI",
  "wake-detected": "已检测到 NOMI",
  "command-listening": "已切换到浏览器指令转写",
  degraded: "本地唤醒当前不可用",
});

const localVoiceReasonLabels = Object.freeze({
  "browser-local-voice-unsupported": "当前浏览器不支持本地音频采集，请使用按键说话或文字输入",
  "local-voice-model-unavailable": "本地唤醒模型尚未安装，按键说话和文字输入不受影响",
  "microphone-permission-denied": "麦克风权限未授予，常驻唤醒保持关闭",
  "local-voice-setup-failed": "本地唤醒初始化失败，已降级到按键说话和文字输入",
  "microphone-resume-failed": "麦克风恢复失败，常驻唤醒已停止",
  "local-voice-connection-closed": "本地语音连接已断开，已停止麦克风采集",
});

function renderLocalVoiceSettings(snapshot = state.localVoice) {
  if (els.localVoiceStatus) {
    els.localVoiceStatus.textContent = snapshot.reasonCode
      ? localVoiceReasonLabels[snapshot.reasonCode] || localVoiceStatusLabels.degraded
      : localVoiceStatusLabels[snapshot.state] || localVoiceStatusLabels.degraded;
    els.localVoiceStatus.dataset.state = snapshot.state;
  }
  if (els.localVoiceEnableButton) {
    els.localVoiceEnableButton.disabled = ["arming", "disabling"].includes(snapshot.state);
    els.localVoiceEnableButton.setAttribute("aria-pressed", String(snapshot.enabled === true));
    els.localVoiceEnableButton.textContent = snapshot.state === "disabling"
      ? "正在关闭…"
      : snapshot.enabled
      ? "关闭常驻唤醒"
      : snapshot.state === "degraded" ? "重新检查" : "启用常驻唤醒";
  }
}

async function playLocalWakeAcknowledgement() {
  if (voiceOutputAdapter.provider !== "gpt-sovits") return;
  try {
    await waitForVoicePlaybackCompletion(voiceOutputAdapter, () => (
      voiceOutputAdapter.speak("我在", { allowBrowserFallback: false })
    ));
  } catch (error) {
    addRuntimeEvent("voice", `GPT-SoVITS 唤醒应答不可用：${error.message}`, "warning");
  }
}

async function handleLocalVoiceStateChange(snapshot, event = null) {
  state.localVoice = snapshot;
  renderLocalVoiceSettings(snapshot);
  renderInteractionSessionStatus();
  if (event?.type !== "wake.detected") return;
  state.localVoiceActiveService = Object.freeze({
    provider: event.provider,
    model: snapshot.gateway?.readiness?.model ?? null,
  });
  updateDemoReadinessFromRuntime();
  const interactionSnapshot = interactionSessionController.getSnapshot();
  if (interactionSnapshot.state !== "dormant") {
    await voiceCaptureController?.resumeStandby();
    return;
  }
  await voiceCaptureController?.suspendForBrowserRecognition();
  interactionSessionController.wake({ provider: event.provider, simulated: event.simulated });
  setMode("listening", "NOMI 已唤醒，等待指令");
  if (els.assistantText) els.assistantText.textContent = "我在";
  addRuntimeEvent("voice", "本地 NOMI 唤醒已触发，正在切换到浏览器指令转写", "success");
  await playLocalWakeAcknowledgement();
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  if (!startBrowserSpeechRecognition("local-wake")) {
    interactionSessionController.closeSession({ reasonCode: "voice-transcription-unavailable" });
  }
}

function setupLocalVoice() {
  renderLocalVoiceSettings();
  if (!voiceCaptureController) return;
  voiceCaptureController.subscribe((snapshot, event) => {
    void handleLocalVoiceStateChange(snapshot, event);
  });
  els.localVoiceEnableButton?.addEventListener("click", async () => {
    const snapshot = voiceCaptureController.getSnapshot();
    if (snapshot.enabled) {
      await voiceCaptureController.disable();
      addRuntimeEvent("voice", "常驻 NOMI 唤醒已关闭，按键说话和文字输入保持可用", "info");
      return;
    }
    const result = await voiceCaptureController.enable();
    if (result.state === "standby") {
      addRuntimeEvent("voice", "常驻 NOMI 唤醒已启用，音频仅流向当前 Mac 本地服务", "success");
    } else {
      addRuntimeEvent("voice", localVoiceReasonLabels[result.reasonCode] || "常驻唤醒不可用", "warning");
    }
  });
  window.addEventListener("pagehide", () => {
    void voiceCaptureController.disable();
  }, { once: true });
}

voiceOutputAdapter.onStatusChange = ({ status, label }) => {
  state.voiceOutput.activeProvider = status === "fallback"
    ? "browser-speech"
    : voiceOutputAdapter.provider;
  setVoiceOutputStatus(status === "fallback" ? "idle" : status, label);
  updateDemoReadinessFromRuntime(
    state.lastRuntimeResult,
    state.voiceOutput.activeProvider,
  );
  updateRunFeedbackFromVoiceStatus(status);
};

voiceOutputAdapter.onTelemetry = (telemetry) => {
  const run = state.voiceOutput.telemetryRun;
  if (!run) return;
  if (run.interactionTurn && !interactionSessionController.isCurrent(run.interactionTurn)) return;
  run.ttsTelemetry = telemetry;
  renderRunDetails();
};

function stopVoiceOutput() {
  voiceOutputAdapter.stop();
}

function renderAssistantText(text, runId) {
  if (!els.assistantText) return false;
  const ownerRunId = typeof runId === "string" ? runId.trim() : "";
  if (ownerRunId) els.assistantText.dataset.runId = ownerRunId;
  else delete els.assistantText.dataset.runId;
  els.assistantText.textContent = String(text || "");
  renderManualEvidenceAnswerState();
  return true;
}

function renderManualEvidenceAnswerState() {
  if (!els.assistantText) return;
  els.assistantText.querySelector('[data-testid="manual-evidence-status"]')?.remove();
  const runId = els.assistantText.dataset.runId || null;
  const presentation = getManualEvidencePresentation(runId);
  const status = document.createElement("span");
  status.className = "manual-evidence-answer-state";
  status.setAttribute("data-testid", "manual-evidence-status");
  status.dataset.status = presentation.status;
  status.textContent = presentation.message;
  if (presentation.primaryLink) {
    const link = document.createElement("a");
    link.setAttribute("data-testid", "manual-primary-evidence-link");
    link.href = presentation.primaryLink;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "查看主证据";
    status.append(" ", link);
  }
  els.assistantText.append(status);
}

async function speakAssistantResponse(text, opts = {}) {
  const response = String(text || "").trim();
  const speechTextPolicy = getVehicleSpeechTextPolicy(voiceOutputAdapter.provider);
  const speechText = String(opts.speechText || "").trim() || buildVehicleSpeechText(response);
  const speechTextProvenance = opts.provenance || "nio-vehicle-speech-text@1.0.0";
  state.voiceOutput.text = response;
  state.voiceOutput.speechText = speechText;
  state.voiceOutput.speechTextProvenance = speechTextProvenance;
  state.voiceOutput.telemetryRun = latestRun();
  state.voiceOutput.feedbackToken = state.runFeedback.token;
  if (!response) {
    renderAssistantText("等待开放对话或车端响应", opts.runId);
    stopVoiceOutput();
    setRunFeedback("");
    return;
  }

  renderAssistantText(response, opts.runId);
  setRunFeedback("回复已生成，正在准备语音", state.voiceOutput.feedbackToken);
  if (!state.voiceOutput.supported) {
    setVoiceOutputStatus("idle");
    return;
  }

  await waitForVoicePlaybackCompletion(voiceOutputAdapter, () => (
    voiceOutputAdapter.speak(createResponseEnvelope(response, {
      speechText,
      speechTextPolicy,
      provenance: speechTextProvenance,
      voiceBridge: opts.voiceBridge || null,
    }), { signal: opts.signal })
  ));
  renderVoiceOutputControls();
}

function pauseVoiceOutput() {
  if (!state.voiceOutput.supported || state.voiceOutput.status !== "speaking") return;
  voiceOutputAdapter.pause();
}

function resumeVoiceOutput() {
  if (!state.voiceOutput.supported || state.voiceOutput.status !== "paused") return;
  voiceOutputAdapter.resume();
}

function latestRun() {
  return state.currentRun || state.lastRunDetail || null;
}

function getRunDetailCardDebug() {
  return [...document.querySelectorAll('[data-testid="run-detail-card"][data-card-kind]')]
    .map((card) => ({
      cardKind: card.dataset.cardKind || "unknown",
      testId: card.dataset.testid || card.getAttribute("data-testid") || "",
      title: card.querySelector("h3")?.textContent?.trim() || "",
      visible: card.offsetParent !== null,
    }));
}

function getSafeRuntimeDebugLatestRun(run, events) {
  const projection = buildHmiRunDebugSnapshot(run, { events });
  if (!projection) {
    state.runtimeDebugLatestRunSource = null;
    state.runtimeDebugLatestRunController = null;
    return null;
  }
  if (state.runtimeDebugLatestRunSource !== run) {
    state.runtimeDebugLatestRunSource = run;
    state.runtimeDebugLatestRunController = createStableHmiRunDebugFacade(projection);
  } else {
    state.runtimeDebugLatestRunController.update(projection);
  }
  return state.runtimeDebugLatestRunController.facade;
}

function countBenchmarkEntries(value, keyPattern, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  let count = 0;
  for (const [key, nested] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      if (Array.isArray(nested)) count += nested.length;
      else if (typeof nested === "string" && nested.trim()) count += 1;
    }
    count += countBenchmarkEntries(nested, keyPattern, seen);
  }
  return count;
}

function actualVehicleFaultReceipt(result) {
  return buildBenchmarkVehicleFaultReceipt({
    profile: benchmarkFaultProfile,
    result,
    sensorSubmissionMarkers: benchmarkRunEvidenceState.terminalSensorSubmissionMarkers,
  });
}

function buildBenchmarkFaultEvidence() {
  if (!benchmarkFaultProfile) return null;
  const result = benchmarkRunEvidenceState.runtimeResult || {};
  const counts = window.__b2AcceptanceCalls || {};
  const countOrNull = (field) => Number.isInteger(counts[field]) ? counts[field] : null;
  let receipt = null;
  if (["structured-model", "weather-adapter"].includes(benchmarkFaultProfile.target)) {
    receipt = verifyBenchmarkFaultReceipt(
      cloudModelAdapter.getBenchmarkFaultReceipt(),
      benchmarkFaultProfile,
    );
  } else if (benchmarkFaultProfile.target === "manual-rag") {
    receipt = verifyBenchmarkFaultReceipt(
      benchmarkRunEvidenceState.manualRagReceipt,
      benchmarkFaultProfile,
    );
  } else if (benchmarkFaultProfile.target === "demo-sensor-submission") {
    receipt = actualVehicleFaultReceipt(result);
  }
  return Object.freeze({
    receipt,
    model: Object.freeze({
      planPresent: Boolean(result.taskPlan),
      planProvenance: result.planningFallback?.source
        || (result.taskPlan ? "model" : "none"),
    }),
    rag: Object.freeze({
      evidenceCount: countBenchmarkEntries({
        manualEvidence: result.manualEvidence,
        knowledgeResult: result.knowledgeResult,
        knowledgeExecution: result.knowledgeExecution,
      }, /evidence/i),
      citationCount: countBenchmarkEntries({
        manualEvidence: result.manualEvidence,
        knowledgeResult: result.knowledgeResult,
        knowledgeExecution: result.knowledgeExecution,
      }, /citation/i),
    }),
    weather: Object.freeze({
      toolCallCount: countOrNull("toolCallCount"),
      adapterAcceptedCount: countOrNull("adapterAcceptedCount"),
      providerCallCount: countOrNull("providerCallCount"),
    }),
    vehicle: projectBenchmarkVehicleEvidence({
      result,
      counts,
      confirmedAnimationCount: benchmarkRunEvidenceState.confirmedAnimationCount,
      sensorSubmissionMarkers: benchmarkRunEvidenceState.terminalSensorSubmissionMarkers,
    }),
  });
}

function getRuntimeDebugSnapshot() {
  const run = latestRun();
  const currentRun = runtime.runEventLedger.getCurrentRun();
  const previousRun = runtime.runEventLedger.getPreviousRun();
  const currentRunSnapshot = buildRunEventDebugSnapshot(currentRun);
  const previousRunSnapshot = buildRunEventDebugSnapshot(previousRun);
  const safeEvents = state.runEventViewModel?.logItems || [];
  const presenterDebugSnapshot = currentRunSnapshot || previousRunSnapshot;
  const lastResultEvents = state.lastRuntimeResult?.requestId === run?.result?.requestId
    ? safeEvents
    : previousRunSnapshot?.events || [];
  const latestRunSnapshot = getSafeRuntimeDebugLatestRun(run, safeEvents);
  const manualSafetyClonePresentation = createManualSafetyEvidencePresentation(
    structuredClone(run?.result?.safetyDecision || null),
  );
  const interactionDebug = buildInteractionSessionDebugSnapshot(
    interactionSessionController.getSnapshot(),
  );
  return {
    interactionSession: interactionDebug.interactionSession,
    currentTurn: interactionDebug.currentTurn,
    queuedTurn: interactionDebug.queuedTurn,
    interactionEvents: interactionDebug.interactionEvents,
    relatedRunIds: interactionDebug.relatedRunIds,
    running: state.running,
    developerVehicleStateLocked: isDeveloperVehicleStateLocked(),
    providerScenarioSnapshot: buildScenarioProviderSummary(vehicleStateProvider.getSnapshot()),
    providerSnapshotSummary: buildProviderSnapshotSummary(vehicleStateProvider.getSnapshot(), {
      maxAgeMs: VEHICLE_STATE_FRESHNESS_POLICY.maxAgeMs,
    }),
    pendingVehicleExecutionCount: state.pendingVehicleExecutionsByComponent.size,
    pendingVehicleExecutionFingerprint: buildPendingVehicleExecutionFingerprint(
      state.pendingVehicleExecutionsByComponent,
    ),
    lastRuntimeResult: buildRuntimeResultDebugSnapshot(state.lastRuntimeResult, { events: lastResultEvents }),
    routeDecision: state.lastRuntimeResult?.routeDecision || null,
    runtimeTelemetry: state.lastRuntimeResult?.runtimeTelemetry || null,
    latestRun: latestRunSnapshot,
    requestId: latestRunSnapshot?.result?.requestId || null,
    intent: latestRunSnapshot?.result?.parsedCommand?.intent || null,
    mode: latestRunSnapshot?.result?.mode || state.mode,
    events: presenterDebugSnapshot?.events || [],
    ttsTelemetry: latestRunSnapshot?.ttsTelemetry || null,
    manualEvidenceBoundary: Object.freeze({
      status: state.manualEvidenceRun.status,
      reason: state.manualEvidenceRun.reason,
      speechText: ["miss", "unavailable"].includes(state.manualEvidenceRun.status)
        ? state.voiceOutput.speechText
        : "",
      speechTextProvenance: ["miss", "unavailable"].includes(state.manualEvidenceRun.status)
        ? state.voiceOutput.speechTextProvenance
        : "",
    }),
    manualSafetyCloneBoundary: Object.freeze({
      visible: manualSafetyClonePresentation.visible,
      evidenceCount: manualSafetyClonePresentation.evidence.length,
      constraintCount: manualSafetyClonePresentation.constraints.length,
    }),
    detailCards: getRunDetailCardDebug(),
    pendingConfirmation: buildPendingConfirmationDebugSnapshot(state.pendingConfirmation),
    runEventProtocol: RUN_EVENT_PROTOCOL,
    currentRun: currentRunSnapshot,
    previousRun: previousRunSnapshot,
    components: presenterDebugSnapshot?.components || [],
    runtimeAcceptanceCounters: window.__b2AcceptanceCalls,
    ...(benchmarkFaultProfile ? { benchmarkFaultEvidence: buildBenchmarkFaultEvidence() } : {}),
  };
}

function buildTimelineRows(timelineItems = []) {
  if (!timelineItems.length) {
    return `<div class="trace-row muted"><span>等待事件</span><strong>--</strong><em>Runtime 尚未输出协同组件事件</em></div>`;
  }
  let previousOffset = 0;
  return timelineItems
    .map((item) => {
      const duration = item.durationMs ?? item.offsetMs - previousOffset;
      previousOffset = item.offsetMs;
      return `
        <div class="trace-row ${item.status}">
          <span>${escapeHtml(item.componentLabel)}</span>
          <strong>+${formatDuration(duration)}</strong>
          <em>${escapeHtml(item.summary)}</em>
        </div>
      `;
    })
    .join("");
}

function renderB2ProjectionCards(b2) {
  const visibleCardKinds = getB2VisibleCardKinds(b2);
  if (!visibleCardKinds.length) return "";
  const stepRows = b2.executionFacts?.stepResults || b2.plan?.steps || [];
  const degradation = b2.degradation
    ? `<p class="detail-note b2-degraded">${escapeHtml(b2.degradation.message)} · ${escapeHtml(b2.degradation.reasonCode)}</p>`
    : "";
  const planningFallback = b2.planningFallback
    ? `<p class="detail-note b2-degraded">${escapeHtml(b2.planningFallback.label)} · ${escapeHtml(b2.planningFallback.reasonCode)}</p>`
    : "";
  const cabinCard = visibleCardKinds.includes("b2-goal") ? `
    <article ${detailCardAttrs("b2-goal", "detail-card b2-agent-detail")}>
      <h3>Cabin Assistant · Goal / Facts</h3>
      ${degradation}
      <code>${escapeHtml(stringifyDetail({
        goal: b2.goal,
        executionFacts: b2.executionFacts,
        response: b2.response,
      }))}</code>
    </article>
  ` : "";
  const orchestratorCard = visibleCardKinds.includes("b2-plan") ? `
    <article ${detailCardAttrs("b2-plan", "detail-card b2-agent-detail")}>
      <h3>Orchestrator · Plan / Validation</h3>
      ${planningFallback}
      <div class="b2-plan-progress">
        ${stepRows.map((step) => `
          <span data-step-status="${escapeHtml(step.status || "planned")}">
            ${escapeHtml(step.capabilityId || step.stepId || "step")} · ${escapeHtml(step.status || "planned")}
          </span>
        `).join("") || "<span>等待真实 TaskPlan 事件</span>"}
      </div>
      <code>${escapeHtml(stringifyDetail({
        plan: b2.plan,
        validation: b2.validation,
        planningFallback: b2.planningFallback,
      }))}</code>
    </article>
  ` : "";
  return `${cabinCard}${orchestratorCard}`;
}

function renderVehicleKnowledgeProjectionCard(b3) {
  const knowledge = b3?.vehicleKnowledge;
  if (!knowledge?.delegation) return "";
  return `
    <article ${detailCardAttrs("b3-vehicle-knowledge", "detail-card wide b2-agent-detail")}>
      <h3>车辆知识链路 · Delegation / Evidence</h3>
      <code>${escapeHtml(stringifyDetail({
        goal: knowledge.goal,
        delegation: knowledge.delegation,
        subplan: knowledge.subplan,
        evidence: knowledge.evidence,
        state: knowledge.state,
        safetyAssessment: knowledge.safetyAssessment,
        outcome: knowledge.outcome,
        limitations: knowledge.limitations,
      }))}</code>
    </article>
  `;
}

function renderRunSummary() {
  const run = latestRun();
  if (!els.runSummary) return;
  if (!run) {
    els.runSummary.innerHTML = `
      <strong>等待 Runtime 结果</strong>
      <span>执行指令后，下滑查看思考流程、LLM 输入输出与耗时。</span>
      <a href="#runDetailSection">查看详情</a>
    `;
    return;
  }

  const status = run.error ? "执行异常" : run.endedAtPerf ? "执行完成" : "执行中";
  const intent = run.result?.parsedCommand?.intent || "解析中";
  const duration = run.endedAtPerf ? formatDuration(run.endedAtPerf - run.startedAtPerf) : formatDuration(performance.now() - run.startedAtPerf);
  els.runSummary.innerHTML = `
    <strong>${status} · ${escapeHtml(intent)}</strong>
    <span>${escapeHtml(run.input)} · UI 观测 ${duration}</span>
    <a href="#runDetailSection">查看详情</a>
  `;
}

function renderRunDetails() {
  renderPendingConfirmationModal();
  const run = latestRun();
  if (!els.runDetailContent) return;
  if (!run) {
    els.runDetailContent.innerHTML = `
      <article ${detailCardAttrs("waiting", "detail-card wide")}>
        <h3>等待执行</h3>
        <span>输入语音或文本指令后，这里会展开智能体思考、组件交接、LLM 输入输出、工具调用和 telemetry。</span>
      </article>
    `;
    return;
  }

  const detail = buildRunDetailViewModel(run, {
    mode: state.replay.controller && state.replay.run ? "replay" : "live",
    eventViewModel: state.runEventViewModel,
  });
  if (detail.mode === "replay") {
    els.runDetailContent.innerHTML = `
      <article ${detailCardAttrs("agent-timeline", "detail-card wide")}>
        <h3>协同执行流程</h3>
        <div class="trace-table">${buildTimelineRows(detail.timelineItems)}</div>
      </article>
      <article ${detailCardAttrs("replay-privacy", "detail-card wide")}>
        <h3>回放隐私边界</h3>
        <p class="detail-note">${escapeHtml(detail.privacyNotice)}</p>
      </article>
      ${renderB2ProjectionCards(detail.b2)}
      ${renderVehicleKnowledgeProjectionCard(detail.b3)}
    `;
    return;
  }

  const result = detail.result;
  const semanticAudit = buildSemanticAuditDetail(result, detail.semanticDecision);
  const parsedCommand = result.parsedCommand;
  const safetyDecision = result.safetyDecision;
  const toolCall = result.toolCall;
  const toolResult = result.toolResult;
  const cloudResult = result.cloudResult;
  const weatherLocationClarification = detail.weatherLocationClarification;
  const assistantResponse = result.assistantResponse || result.conversationResult?.summary || cloudResult?.summary || toolResult?.hmiSummary || "";
  const resultSemantics = classifyRuntimeResult({
    safetyAction: result.safetyDecision?.action,
    executionState: result.toolResult?.executionState,
    fallbackActive: result.runtimeTelemetry?.fallback === true,
  });
  const totalMs = detail.endedAtPerf && detail.startedAtPerf
    ? detail.endedAtPerf - detail.startedAtPerf
    : Number.isFinite(detail.startedAtPerf) ? performance.now() - detail.startedAtPerf : null;
  const telemetry = {
    routeDecision: result.routeDecision || {},
    runtime: result.runtimeTelemetry || {},
    semantic: result.semanticTelemetry || {},
    llm: cloudResult?.telemetry || {},
  };
  const limitation = result.parsedCommand && toolResult ? getCapabilityLimitation(result) : null;
  const tts = detail.ttsTelemetry;
  const firstChunk = tts?.chunks?.[0];
  const vehicleStateSnapshot = Object.hasOwn(result, "vehicleStateSnapshot")
    ? result.vehicleStateSnapshot
    : null;
  const ttsMetric = (value) => Number.isFinite(value) ? formatDuration(value) : "unavailable";

  els.runDetailContent.innerHTML = `
    <article ${detailCardAttrs("agent-timeline", "detail-card wide")}>
      <h3>协同执行流程</h3>
      <div class="trace-table">${buildTimelineRows(detail.timelineItems)}</div>
    </article>
    ${renderB2ProjectionCards(detail.b2)}
    ${renderVehicleKnowledgeProjectionCard(detail.b3)}
    <article ${detailCardAttrs("tts-speed", "detail-card wide")}>
      <h3>TTS 响应速度</h3>
      <div class="metric-grid compact">
        <div class="metric"><span>Provider / 状态</span><strong>${escapeHtml(tts ? `${tts.provider} / ${tts.status}` : "unavailable")}</strong></div>
        <div class="metric"><span>分块数</span><strong>${escapeHtml(tts?.chunkCount ?? "unavailable")}</strong></div>
        <div class="metric"><span>首块请求 → 响应头</span><strong>${ttsMetric(firstChunk?.requestToResponseHeadersMs)}</strong></div>
        <div class="metric"><span>首块请求 → 完整音频就绪</span><strong>${ttsMetric(firstChunk?.requestToCompleteAudioReadyMs)}</strong></div>
        <div class="metric"><span>首块开始播放</span><strong>${ttsMetric(tts?.firstPlayStartedMs)}</strong></div>
        <div class="metric"><span>最大分块间隔</span><strong>${ttsMetric(tts?.maxChunkGapMs)}</strong></div>
      </div>
      <p class="detail-note">以上为浏览器观测的首块请求耗时，以及从发起播报到 Audio 开始播放的耗时；当前代理会缓冲完整音频，不代表字节流 TTFA。</p>
      <code>${escapeHtml(stringifyDetail(tts || "当前运行尚未触发 TTS，指标不可用。"))}</code>
    </article>
    <article ${detailCardAttrs("user-input")}>
      <h3>用户输入</h3>
      <code>${escapeHtml(detail.userInput)}</code>
    </article>
    <article ${detailCardAttrs("semantic-output")}>
      <h3>本地语义模型输出</h3>
      <code>${escapeHtml(stringifyDetail({
        semanticAudit,
        parsedCommand,
      }))}</code>
    </article>
    <article ${detailCardAttrs("vehicle-state-snapshot")}>
      <h3>VehicleState Snapshot</h3>
      <p class="detail-note">${vehicleStateSnapshot?.simulated ? "模拟状态" : "车辆状态"} · ${escapeHtml(vehicleStateSnapshot?.source || "unknown")}</p>
      <code>${escapeHtml(stringifyDetail(vehicleStateSnapshot || "状态不可用"))}</code>
    </article>
    <article ${detailCardAttrs("agent-communication")}>
      <h3>组件交接与沟通</h3>
      <p class="detail-note">结果语义：${escapeHtml(resultSemantics.status)} · 可声称成功：${resultSemantics.canClaimSuccess ? "是" : "否"} · 需要补参：${resultSemantics.shouldAskForSlots ? "是" : "否"}</p>
      <code>${escapeHtml(stringifyDetail({
        safetyDecision,
        toolCall,
        conversationResult: result.conversationResult,
        response: assistantResponse,
      }))}</code>
    </article>
    <article ${detailCardAttrs("llm-input")}>
      <h3>LLM 输入元数据</h3>
      <p class="detail-note">仅展示安全结构化元数据，不展示 prompt 正文、会话记忆、token、原始 data 或思维链。</p>
      <code>${escapeHtml(stringifyDetail(Object.keys(detail.llmInput).length
        ? detail.llmInput
        : "该指令未触发 LLM prompt，基础车控由车端 Runtime 直接处理。"))}</code>
    </article>
    <article ${detailCardAttrs("llm-output")}>
      <h3>LLM 输出 / 车端响应</h3>
      <code>${escapeHtml(stringifyDetail(cloudResult?.summary || (toolResult?.hmiSummary ? `未调用 LLM，车端响应：${toolResult.hmiSummary}` : null) || assistantResponse || detail.runtimeError || "等待输出"))}</code>
    </article>
    ${renderWeatherLocationClarificationCard(weatherLocationClarification)}
    <article ${detailCardAttrs("stage-timing")}>
      <h3>阶段耗时</h3>
      <div class="metric-grid compact">
        <div class="metric"><span>UI 总耗时</span><strong>${formatDuration(totalMs)}</strong></div>
        <div class="metric"><span>事件数</span><strong>${detail.timelineItems.length}</strong></div>
        <div class="metric"><span>请求 ID</span><strong>${escapeHtml(result.requestId || "生成中")}</strong></div>
        <div class="metric"><span>链路模式</span><strong>${escapeHtml(result.routeDecision?.mode || result.mode || "运行中")}</strong></div>
      </div>
    </article>
    <article ${detailCardAttrs("model-telemetry")}>
      <h3>模型 Telemetry</h3>
      <code>${escapeHtml(stringifyDetail(telemetry))}</code>
    </article>
    ${renderManualEvidenceCards(result.manualEvidence, safetyDecision, result.manualQueryPlan, detail.userInput, result.requestId || run.requestId)}
    ${renderVehicleComponentAuditCard()}
    <article ${detailCardAttrs("tool-result", "detail-card wide")}>
      <h3>工具结果 / 车身反馈</h3>
      <code>${escapeHtml(stringifyDetail(toolResult || "开放对话未触发 Vehicle Tools。"))}</code>
      ${limitation ? `<p class="detail-note">${escapeHtml(limitation.body)}</p>` : ""}
    </article>
  `;
}

function applyRuntimeResult(result, turnContext) {
  const { sessionId, turnId, runId } = turnContext || {};
  if (!result
    || result.requestId !== runId
    || result.interactionRef?.sessionId !== sessionId
    || result.interactionRef?.turnId !== turnId
    || !interactionSessionController.isCurrent({ sessionId, turnId, runId })) return null;
  if (!state.currentRun?.requestId
    || state.currentRun.requestId !== result.requestId
    || state.consumedRuntimeRequestIds.has(result.requestId)) return;
  const parsedCommand = result.parsedCommand || {};
  const toolResult = result.toolResult;
  // This boundary delegates to reduceVehicleRuntimeResultTransaction before
  // any presentation route can trust parsedCommand.
  const trustedVehicleTool = state.currentRun.pendingVehicleTool || null;
  const appRuntimeVehicleResult = reduceAppRuntimeVehicleResult(state, result);
  const {
    consumable,
    effectiveVehicleControl,
    transaction,
  } = appRuntimeVehicleResult;
  const safetyBlockedVehicleControl =
    appRuntimeVehicleResult.safetyBlockedVehicleControl;
  if (!consumable) return null;
  const runtimeVehicleMetricsSnapshot = selectAppRuntimeVehicleMetricsSnapshot(
    state,
    result,
    appRuntimeVehicleResult,
  );
  let vehicleExecutionContractFailure = false;
  let hmiPresentation = null;
  let nextVehicleHmiState = null;
  let vehiclePresentationAccepted = false;
  let vehicleAnimationAccepted = false;
  if (transaction) {
    hmiPresentation = transaction.presentation;
    nextVehicleHmiState = {
      ...transaction,
      accepted: true,
    };
    vehiclePresentationAccepted = true;
    vehicleAnimationAccepted = transaction.contractValid
      && transaction.presentationAccepted;
    vehicleExecutionContractFailure = !transaction.contractValid;
  }
  if (vehiclePresentationAccepted && nextVehicleHmiState) {
    state.dispatchedVehicleCommandsByCommandId =
      nextVehicleHmiState.dispatchedVehicleCommandsByCommandId;
    state.verifiedVehicleTerminalsByCommandId =
      nextVehicleHmiState.verifiedVehicleTerminalsByCommandId;
    state.pendingVehicleExecutionsByComponent =
      nextVehicleHmiState.pendingVehicleExecutionsByComponent;
    state.confirmedVehicleStateSnapshot =
      nextVehicleHmiState.confirmedVehicleStateSnapshot;
  }
  if (benchmarkFaultProfile?.target === "demo-sensor-submission"
    && vehicleAnimationAccepted) benchmarkRunEvidenceState.confirmedAnimationCount += 1;
  if (vehiclePresentationAccepted && !vehicleAnimationAccepted) {
    window.vehicleRig?.endSeatAdjustmentFocus?.({
      delayMs: 0,
      reason: "vehicle-result-presentation-rejected",
    });
  }
  const contractFailureResponse = "车辆执行结果未通过终态校验。";
  const presentationResult = vehicleExecutionContractFailure
    ? {
      ...result,
      assistantResponse: contractFailureResponse,
      assistantSpeechText: contractFailureResponse,
      conversationResult: null,
      cloudResult: null,
      toolResult: toolResult
        ? { ...toolResult, hmiSummary: contractFailureResponse }
        : toolResult,
    }
    : result;
  result = presentationResult;
  state.consumedRuntimeRequestIds.add(result.requestId);
  state.lastRuntimeResult = presentationResult;
  updateDemoReadinessFromRuntime(presentationResult);
  if (benchmarkFaultProfile) {
    benchmarkRunEvidenceState.runtimeResult = presentationResult;
    benchmarkRunEvidenceState.runId = presentationResult.requestId;
  }
  if (result.safetyDecision?.action === "require_confirmation") {
    const challenge = result.safetyDecision.confirmationChallenge;
    state.pendingConfirmation = {
      runId: result.requestId,
      input: result.rawText || state.currentRun?.input || "",
      intent: result.parsedCommand?.intent || "",
      action: result.safetyDecision.action,
      reason: result.safetyDecision.reason || "",
      alternative: result.safetyDecision.alternative || "",
      challenge,
    };
  } else {
    state.pendingConfirmation = null;
  }
  const voiceBridgeEvent = state.currentRun?.events?.findLast?.(
    (event) => event.component === "voiceBridgeEligibility",
  );
  if (state.currentRun) {
    state.currentRun.result = presentationResult;
    state.currentRun.endedAt = new Date().toISOString();
    state.currentRun.endedAtPerf = performance.now();
    state.lastRunDetail = state.currentRun;
    state.currentRun = null;
  }
  if (!effectiveVehicleControl) renderVehicleStateMetrics(runtimeVehicleMetricsSnapshot);
  const rawAssistantResponse = vehicleExecutionContractFailure
    ? contractFailureResponse
    : result.assistantResponse || result.conversationResult?.summary
      || result.cloudResult?.summary || toolResult?.hmiSummary || "";
  const manualEvidencePresentation = getManualEvidencePresentation(result.requestId);
  const manualAnswer = resolveManualEvidenceAnswer({
    presentation: manualEvidencePresentation,
    rawAnswer: rawAssistantResponse,
    rawSpeechText: result.assistantSpeechText,
  });
  const manualBoundarySpeech = ["miss", "unavailable"].includes(manualEvidencePresentation.status);
  const assistantResponse = manualAnswer.answerText;
  let speechPromise = Promise.resolve();
  if (assistantResponse) {
    interactionSessionController.beginSpeaking(turnId);
    renderInteractionSessionStatus();
    const voiceBridge = vehicleExecutionContractFailure
      ? { allowed: false, reason: "vehicle-terminal-contract-invalid" }
      : result.voiceBridgeEligibility || { allowed: false, reason: "runtime-authorization-unavailable" };
    speechPromise = speakAssistantResponse(assistantResponse, {
      runId: result.requestId,
      speechText: manualAnswer.speechText,
      provenance: manualBoundarySpeech
        ? "manual-evidence-boundary"
        : !vehicleExecutionContractFailure && manualAnswer.speechText
          ? "manual-runtime-speech-text"
        : "nio-vehicle-speech-text@1.0.0",
      voiceBridge: {
        ...voiceBridge,
        interactionEventId: voiceBridgeEvent?.eventId || null,
        turnId,
      },
      signal: turnContext.signal,
    });
  } else setRunFeedback("");

  if (!effectiveVehicleControl && parsedCommand.intent === "conversation.general") {
    renderModelRouteStatus(result, { effectiveVehicleControl });
    els.destinationMetric.textContent = "开放对话";
    els.safetyMode.textContent = "开放对话未触发 Vehicle Tools";

    setMode("completed", assistantResponse || "开放对话回复已生成");
    renderRunSummary();
    renderRunDetails();
    addRuntimeEvent("conversation", "未创建车控 toolCall，已完成文本与语音回复", "success");
    return { outputMode: assistantResponse ? "voice" : "text", speechPromise };
  }

  let statePatch = {};
  if (vehiclePresentationAccepted && nextVehicleHmiState) {
    state.lastVehicleHmiPresentation = vehicleAnimationAccepted && hmiPresentation.phase === "confirmed"
      ? hmiPresentation
      : state.lastVehicleHmiPresentation;
    if (vehicleAnimationAccepted) applyHmiPresentation(hmiPresentation);
  } else if (toolResult && !effectiveVehicleControl) {
    statePatch = toolResult.statePatch || {};
    hmiPresentation = applyExternalDataHmiAnimation(toolResult);
  }
  if (effectiveVehicleControl) {
    renderVehicleStateMetrics(runtimeVehicleMetricsSnapshot);
  }
  const visualScenario = hmiPresentation?.visualScenario || toolResult?.visualScenario || "cabin";
  const finalMode = safetyBlockedVehicleControl || vehicleExecutionContractFailure
    ? "blocked"
    : hmiPresentation?.phase === "pending"
    ? "pending"
    : hmiPresentation?.phase === "cancelled"
      || (effectiveVehicleControl && hmiPresentation?.phase === "unsupported")
      ? "blocked"
      : hmiPresentation?.mode === "no-animation"
        ? "completed"
        : (hmiPresentation?.mode || resolveModeByScenario(visualScenario, "completed"));

  renderModelRouteStatus(presentationResult, { effectiveVehicleControl });
  els.destinationMetric.textContent = effectiveVehicleControl
    ? trustedVehicleTool || toolResult?.tool || "车辆控制"
    : statePatch.destination || parsedCommand.slots?.destination || parsedCommand.intent;
  els.safetyMode.textContent = result.safetyDecision?.allowed ? result.safetyDecision.reason : "关键安全提醒不可关闭";

  setMode(
    finalMode,
    vehicleExecutionContractFailure
      ? contractFailureResponse
      : toolResult?.hmiSummary || hmiPresentation?.reason || assistantResponse,
  );
  renderRunSummary();
  renderRunDetails();

  const limitation = toolResult && effectiveVehicleControl
    ? getCapabilityLimitation(result, trustedVehicleTool)
    : null;
  if (limitation) addRuntimeEvent("vehicle", limitation.body, "warning");
  return { outputMode: assistantResponse ? "voice" : "text", speechPromise };
}

function renderVehicleStateMetrics(snapshot) {
  const values = snapshot?.values || {};
  els.batteryMetric.textContent = Number.isFinite(values.batteryPercent) ? `${values.batteryPercent}%` : "--";
  els.speedMetric.textContent = Number.isFinite(values.speedKph) ? `${values.speedKph} km/h` : "--";
  els.driveMetric.textContent = snapshot
    ? `${snapshot.simulated ? "模拟状态" : "车辆状态"} · ${snapshot.source}`
    : "状态不可用";
  renderEs8InterfaceState(values);
  renderEs8VehicleLockState(values);
}

function renderEs8VehicleLockState(values = {}) {
  const button = document.querySelector("#es8VehicleLockToggle");
  const locked = values.vehicleLocked;
  if (button) {
    button.textContent = typeof locked === "boolean"
      ? `全车：${locked ? "已锁止" : "已解锁"}`
      : "门锁状态未知";
    button.disabled = typeof locked !== "boolean";
    button.setAttribute("aria-pressed", String(locked === true));
  }
}

function renderEs8InterfaceState(values = {}) {
  const climateToggle = document.querySelector("#es8ClimatePowerToggle");
  if (climateToggle) {
    climateToggle.textContent = typeof values.climatePower === "boolean"
      ? `空调：${values.climatePower ? "开启" : "关闭"}`
      : "空调状态未知";
    climateToggle.disabled = typeof values.climatePower !== "boolean";
    climateToggle.setAttribute("aria-pressed", String(values.climatePower === true));
  }
  const climateTemperature = document.querySelector("#es8ClimateTemperature");
  if (climateTemperature) {
    climateTemperature.textContent = Number.isFinite(values.cabinTemperature)
      ? `设定温度：${values.cabinTemperature}°C`
      : "设定温度：状态未知";
  }
  const climateMode = document.querySelector("#es8ClimateMode");
  if (climateMode) {
    if (Object.hasOwn(ES8_CLIMATE_MODE_LABELS, values.climateMode)) climateMode.value = values.climateMode;
    climateMode.disabled = !Object.hasOwn(ES8_CLIMATE_MODE_LABELS, values.climateMode);
  }

  const seatLabels = {
    driver: "主驾",
    passenger: "副驾",
    row2_left: "二排左",
    row2_right: "二排右",
    row3_left: "三排左",
    row3_right: "三排右",
  };
  const activeSeats = Object.entries(values.seatComfortByZone || {})
    .filter(([, setting]) => setting?.mode !== "off" && Number.isInteger(setting?.level) && setting.level > 0)
    .map(([zone, setting]) => `${seatLabels[zone] || zone}${setting.mode === "heat" ? "加热" : "通风"} ${setting.level} 挡`);
  if (els.developerSeatComfortSummary) {
    els.developerSeatComfortSummary.textContent = activeSeats.join(" · ") || "当前无座椅加热或通风";
  }
}

async function confirmPendingAction() {
  const pending = state.pendingConfirmation;
  if (!pending?.challenge || confirmationControlsBusy()) return;
  const claim = confirmationDecisionGate.claim({
    challengeId: pending.challenge.id,
    channel: "screen",
  });
  if (!claim) return;
  try {
    if (!(await finishSpokenTurnForConfirmation())) return;
    if (state.pendingConfirmation?.challenge?.id !== pending.challenge.id) return;
    addRuntimeEvent("safety", `用户完成安全确认：${describePendingConfirmation(pending)}。重新进入 Runtime 与 Safety Gateway`, "info");
    await runCommand(pending.input, {
      confirmationResponse: {
        challengeId: pending.challenge.id,
        requestId: pending.challenge.requestId,
        responseToken: pending.challenge.responseToken,
        actionDigest: pending.challenge.actionDigest,
        policyId: pending.challenge.policyId,
        acceptedAssertions: pending.challenge.assertions.map((assertion) => assertion.id),
      },
    });
  } finally {
    confirmationDecisionGate.release(claim);
    if (state.pendingConfirmation?.challenge?.id === pending.challenge.id) renderRunDetails();
  }
}

const ES8_CLIMATE_MODE_LABELS = Object.freeze({
  auto: "自动",
  cooling: "制冷",
  heating: "制热",
  ventilation: "通风 / 自然风",
});
const ES8_WINDOW_ZONES = Object.freeze(["front_left", "front_right", "rear_left", "rear_right"]);
const ES8_MANUAL_SCENE_GUIDANCE = Object.freeze({
  rest: "休憩模式：电量充足或正在充电且高压与空调正常；开启前关闭车门和尾门。场景会自动锁车、关窗并展开遮阳帘。",
  camp: "露营模式：电量充足或正在充电、高压与空调正常，且车辆在 P 挡。车辆保持上电，部分远程车控会禁用。",
  theater: "影院模式：续航高于 10 km 或正在充电且高压正常；开启前关闭所有车门和尾门。",
});

function setEs8InterfaceStatus(message) {
  const output = document.querySelector("#es8InterfaceStatus");
  if (output) output.textContent = message;
}

function applyEs8InterfacePatch(patch, label, successMessage) {
  const result = developerVehicleStateController.applyPatch(patch, { label });
  setEs8InterfaceStatus(result.ok
    ? `${successMessage}；已写入本地模拟快照。`
    : `接口未更新：${result.reason || "Provider 更新失败"}。`);
  return result;
}

function setupEs8InterfaceControls() {
  const controls = document.querySelector("#es8InterfaceControls");
  if (!controls) return;

  document.querySelector("#es8ClimatePowerToggle")?.addEventListener("click", () => {
    const current = vehicleStateProvider.getSnapshot()?.values?.climatePower;
    if (typeof current !== "boolean") {
      setEs8InterfaceStatus("空调开关状态未知，未修改快照。");
      return;
    }
    applyEs8InterfacePatch(
      { climatePower: !current },
      `网页空调接口已${current ? "关闭" : "开启"}`,
      `空调已${current ? "关闭" : "开启"}`,
    );
  });

  document.querySelector("#es8ClimateMode")?.addEventListener("change", (event) => {
    const mode = event.currentTarget.value;
    const label = ES8_CLIMATE_MODE_LABELS[mode];
    if (!label) return;
    applyEs8InterfacePatch(
      { climateMode: mode },
      "网页空调模式接口已更新",
      `空调模式已设为${label}`,
    );
  });

  controls.addEventListener("click", (event) => {
    const manualScene = event.target.closest("[data-es8-manual-scene]");
    if (manualScene) {
      controls.querySelectorAll("[data-es8-manual-scene]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button === manualScene));
      });
      const guidance = ES8_MANUAL_SCENE_GUIDANCE[manualScene.dataset.es8ManualScene];
      const output = document.querySelector("#es8ManualSceneDetails");
      if (guidance && output) output.textContent = guidance;
      return;
    }

    const action = event.target.closest("[data-es8-api-action]")?.dataset.es8ApiAction;
    if (!action) return;

    if (action === "vehicle-lock-toggle") {
      const current = vehicleStateProvider.getSnapshot()?.values?.vehicleLocked;
      if (typeof current !== "boolean") {
        setEs8InterfaceStatus("全车门锁状态未知，未修改快照。");
        return;
      }
      applyEs8InterfacePatch(
        { vehicleLocked: !current },
        `网页全车门锁接口已${current ? "解锁" : "锁止"}`,
        `全车已${current ? "解锁" : "锁止"}`,
      );
      return;
    }

    const positions = action === "window-vent"
      ? { front_left: 10, rear_right: 10 }
      : Object.fromEntries(ES8_WINDOW_ZONES.map((zone) => [zone, action === "window-open-all" ? 100 : 0]));
    const labels = {
      "window-vent": "左前与右后车窗已设为约 10%",
      "window-open-all": "全部车窗已开启",
      "window-close-all": "全部车窗已关闭",
    };
    if (labels[action]) {
      applyEs8InterfacePatch(
        { windowPositionPercentByZone: positions },
        `网页车窗接口已更新：${labels[action]}`,
        labels[action],
      );
      return;
    }

  });
}

async function submitVoiceConfirmation(pending, claim, suppliedPcm = null) {
  const confirmation = state.voiceConfirmation;
  confirmation.processing = true;
  confirmation.recording = false;
  renderPendingConfirmationModal();
  try {
    const pcm = suppliedPcm || await voiceConfirmationRecorder.stop();
    const query = new URLSearchParams({
      sessionId,
      challengeId: pending.challenge.id,
      requestId: pending.challenge.requestId,
      actionDigest: pending.challenge.actionDigest,
      policyId: pending.challenge.policyId,
    });
    const response = await window.fetch(`/api/local-voice/identity/proof?${query}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: pcm,
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({}));
    if (result.status === "cancelled") {
      state.pendingConfirmation = null;
      addRuntimeEvent("safety", "语音确认已取消，未调用车辆工具。", "info");
      setMode("blocked", "已取消本次安全确认");
      renderRunSummary();
      renderRunDetails();
      return;
    }
    if (!response.ok || result.status !== "matched" || !result.proofId) {
      confirmation.fallbackUsed = true;
      addRuntimeEvent("safety", "语音确认未通过，仍可使用屏幕按钮完成确认。", "warning");
      return;
    }
    addRuntimeEvent("safety", "主驾语音确认已通过，重新进入 Runtime 与 Safety Gateway。", "info");
    await runCommand(pending.input, {
      confirmationResponse: {
        challengeId: pending.challenge.id,
        requestId: pending.challenge.requestId,
        responseToken: pending.challenge.responseToken,
        actionDigest: pending.challenge.actionDigest,
        policyId: pending.challenge.policyId,
        acceptedAssertions: pending.challenge.assertions.map((assertion) => assertion.id),
        confirmationChannel: "voice",
        voiceProofId: result.proofId,
      },
    });
  } catch {
    confirmation.fallbackUsed = true;
    addRuntimeEvent("safety", "本地语音确认暂不可用，请使用屏幕按钮。", "warning");
  } finally {
    confirmation.processing = false;
    confirmation.recording = false;
    confirmation.claim = null;
    confirmation.restoreLocalVoiceStandby = false;
    confirmationDecisionGate.release(claim);
    renderPendingConfirmationModal();
    await voiceCaptureController?.resumeStandby();
  }
}

async function toggleVoiceConfirmation() {
  const pending = state.pendingConfirmation;
  if (!pending?.challenge || confirmationControlsBusy() || !voiceConfirmationRecorder) return;
  const confirmation = state.voiceConfirmation;
  if (confirmation.recording) {
    const claim = confirmation.claim;
    if (claim) await submitVoiceConfirmation(pending, claim);
    return;
  }
  const claim = confirmationDecisionGate.claim({
    challengeId: pending.challenge.id,
    channel: "voice",
  });
  if (!claim) return;
  // Stop the spoken reply before recording so the confirmation phrase is not mixed with TTS.
  if (!(await finishSpokenTurnForConfirmation())
    || state.pendingConfirmation?.challenge?.id !== pending.challenge.id) {
    confirmationDecisionGate.release(claim);
    return;
  }
  confirmation.claim = claim;
  confirmation.fallbackUsed = false;
  confirmation.recording = true;
  try {
    const restoreLocalVoiceStandby = voiceCaptureController?.getSnapshot().enabled === true;
    if (restoreLocalVoiceStandby) await voiceCaptureController.suspendForBrowserRecognition();
    confirmation.restoreLocalVoiceStandby = restoreLocalVoiceStandby;
    await voiceConfirmationRecorder.start({
      onAutoStop: (pcm) => void submitVoiceConfirmation(pending, claim, pcm),
    });
    renderPendingConfirmationModal();
  } catch {
    confirmation.recording = false;
    confirmation.claim = null;
    confirmationDecisionGate.release(claim);
    confirmation.fallbackUsed = true;
    addRuntimeEvent("safety", "无法启动本地语音确认，请使用屏幕按钮。", "warning");
    await voiceCaptureController?.resumeStandby();
    renderPendingConfirmationModal();
  }
}

async function runCommand(text, runOptions = {}) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    addRuntimeEvent("system", "请输入或选择一条指令", "warning");
    return Promise.resolve(null);
  }

  const prepared = prepareInteractionTurn(rawText, runOptions);
  if (!prepared) return Promise.resolve(null);
  const { command, replacing, turn } = prepared;
  let resolveExecution;
  const completion = new Promise((resolve) => {
    resolveExecution = resolve;
  });
  pendingTurnExecutions.set(turn.turnId, {
    command,
    completion,
    resolve: resolveExecution,
    runOptions,
    started: false,
    turn,
  });
  if (replacing) interactionSessionController.requestCancellation("barge-in-replaced");
  pruneCancelledTurnExecutions();
  drainInteractionTurnExecutions();
  return completion;
}

function pruneCancelledTurnExecutions() {
  for (const [turnId, entry] of pendingTurnExecutions) {
    if (entry.started || !entry.turn.signal.aborted) continue;
    pendingTurnExecutions.delete(turnId);
    entry.resolve(null);
  }
}

function drainInteractionTurnExecutions() {
  if (state.running) return;
  pruneCancelledTurnExecutions();
  const activeTurn = interactionSessionController.getSnapshot().activeTurn;
  const entry = activeTurn ? pendingTurnExecutions.get(activeTurn.turnId) : null;
  if (!entry || !interactionSessionController.isCurrent(entry.turn)) return;
  void executeInteractionTurn(entry);
}

async function executeInteractionTurn(entry) {
  const { command, runOptions, turn } = entry;
  if (state.running || entry.started || !interactionSessionController.isCurrent(turn)) return;
  resetBenchmarkRunEvidenceState(
    benchmarkRunEvidenceState,
    () => cloudModelAdapter.resetBenchmarkFaultReceipt(),
  );
  entry.started = true;

  returnToLiveProjection();
  state.running = true;
  renderDeveloperVehicleStatePanel();
  renderReplayControls();
  state.voiceOutput.telemetryRun = null;
  stopVoiceOutput();
  const feedbackToken = beginRunFeedback();
  const requestId = turn.runId;
  const interactionRef = Object.freeze({
    sessionId: turn.sessionId,
    turnId: turn.turnId,
  });
  beginManualEvidenceRun(requestId);
  renderAssistantText("正在生成回复", requestId);
  resetComponents();
  els.eventLog.innerHTML = "";
  state.eventHistory = [];
  state.runEventViewModel = null;
  state.currentRun = {
    requestId,
    input: command,
    startedAt: new Date().toISOString(),
    startedAtPerf: performance.now(),
    events: [],
    result: null,
    error: "",
    feedbackToken,
    interactionTurn: turn,
    confirmationParentRunId: runOptions.confirmationResponse
      ? state.pendingConfirmation?.runId || null
      : null,
  };
  let completionValue = null;
  try {
    const hasScenarioOverride = runOptions.demoScenario != null || runOptions.vehicleStatePatch != null;
    let vehicleStateSnapshot;
    if (state.preserveDeveloperStateOnNextRun && !hasScenarioOverride) {
      vehicleStateSnapshot = vehicleStateProvider.getSnapshot();
      safetyStateRefresh.markStaged(vehicleStateSnapshot, { preserve: true });
      state.preserveDeveloperStateOnNextRun = false;
    } else {
      const scenarioInput = runOptions.demoScenario
        ?? runOptions.vehicleStatePatch
        ?? {};
      const { ingestion } = applyDemoScenario(scenarioInput);
      if (!ingestion.ok) throw new Error(`Demo sensor state rejected: ${ingestion.reason}`);
      safetyStateRefresh.markStaged(ingestion.snapshot);
      state.preserveDeveloperStateOnNextRun = false;
      vehicleStateSnapshot = vehicleStateProvider.getSnapshot();
    }
    state.currentRun.vehicleStateSnapshot = vehicleStateSnapshot;
    renderVehicleStateMetrics(vehicleStateSnapshot);
    renderDeveloperVehicleStatePanel(vehicleStateSnapshot);
    els.commandInput.value = command;
    addRuntimeEvent("runtime", "Runtime 执行中：Input → Local Model → Intent Router → 协同组件 / Tools → HMI", "info");
    renderRunSummary();
    renderRunDetails();

    const result = await runtime.run(command, {
      requestId,
      vehicleStateSnapshot,
      confirmationResponse: runOptions.confirmationResponse || null,
      sessionId: turn.sessionId,
      clarificationSessionId: sessionId,
      interactionRef: { sessionId: turn.sessionId, turnId: turn.turnId },
      signal: turn.signal,
      deadlineAt: turn.deadlineAt,
      vehicleSensorMode: benchmarkFaultProfile?.id === "vehicle-confirmation-timeout"
        ? "timeout"
        : undefined,
    });
    if (!interactionSessionController.isCurrent({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    })) return;
    const presentation = presentationBridge.applyResult(result, turn);
    if (!presentation.accepted) return;
    state.speechOnlyTurnId = turn.turnId;
    renderPendingConfirmationModal();
    await presentation.speechPromise;
    if (!interactionSessionController.isCurrent({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    })) return;
    interactionSessionController.completeTurn(turn.turnId, {
      outputMode: presentation.outputMode,
    });
    completionValue = result;
  } catch (error) {
    if (turn.signal.aborted) {
      transitionManualEvidenceRun({ type: "request-aborted", runId: turn.runId });
      if (state.currentRun?.interactionTurn?.turnId === turn.turnId) {
        state.currentRun.endedAt = new Date().toISOString();
        state.currentRun.endedAtPerf = performance.now();
        state.currentRun.cancelled = true;
        state.lastRunDetail = state.currentRun;
        state.currentRun = null;
      }
      return;
    }
    if (!interactionSessionController.isCurrent({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    })) return;
    setMode("blocked", "Runtime 执行异常");
    if (state.currentRun) {
      const pendingComponent = state.currentRun.pendingVehicleComponent;
      const pendingCommandId = state.currentRun.pendingVehicleCommandId;
      const pending = state.pendingVehicleExecutionsByComponent.get(pendingComponent);
      if (pending?.commandId === pendingCommandId) {
        state.pendingVehicleExecutionsByComponent.delete(pendingComponent);
      }
      if (pendingCommandId) {
        state.dispatchedVehicleCommandsByCommandId.delete(pendingCommandId);
      }
      state.currentRun.error = error.message;
      state.currentRun.endedAt = new Date().toISOString();
      state.currentRun.endedAtPerf = performance.now();
      state.lastRunDetail = state.currentRun;
      state.currentRun = null;
    }
    addRuntimeEvent("runtime", `执行异常：${error.message}`, "warning");
    setRunFeedback("本次处理未完成，请重试", feedbackToken);
    renderRunSummary();
    renderRunDetails();
    interactionSessionController.failTurn(turn.turnId, { reasonCode: "runtime-failed" });
  } finally {
    if (state.speechOnlyTurnId === turn.turnId) state.speechOnlyTurnId = null;
    state.running = false;
    if (completionValue) {
      updateRunFeedbackFromVoiceStatus(state.voiceOutput.status, feedbackToken);
    }
    pendingTurnExecutions.delete(turn.turnId);
    entry.resolve(completionValue);
    renderDeveloperVehicleStatePanel();
    renderReplayControls();
    if (state.pendingConfirmation) renderRunDetails();
    pruneCancelledTurnExecutions();
    drainInteractionTurnExecutions();
  }
}

function startBrowserSpeechRecognition(origin = null) {
  if (!state.recognition) {
    addRuntimeEvent("voice", "语音不可用，已启用文本输入兜底", "warning");
    els.commandInput.focus();
    return false;
  }
  try {
    state.requestedVoiceTurnOrigin = origin;
    state.recognition.start();
    return true;
  } catch {
    state.requestedVoiceTurnOrigin = null;
    addRuntimeEvent("voice", "语音识别正在初始化，请稍后再试", "warning");
    return false;
  }
}

async function startAutomaticVoiceFollowUp(openingSnapshot) {
  await voiceCaptureController?.suspendForBrowserRecognition();
  const snapshot = interactionSessionController.getSnapshot();
  if (!isCurrentVoiceFollowUpWindow(snapshot, {
    sessionId: openingSnapshot.sessionId,
    deadlineAt: openingSnapshot.followUpDeadlineAt,
  })) {
    if (snapshot.state === "dormant") await voiceCaptureController?.resumeStandby();
    return false;
  }
  if (startBrowserSpeechRecognition("follow-up")) return true;
  interactionSessionController.closeSession({ reasonCode: "follow-up-recognition-unavailable" });
  return false;
}

function setupSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    addRuntimeEvent("voice", "当前浏览器不支持语音识别，可使用文本输入或快捷场景", "warning");
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = false;
  let currentTranscript = "";
  let voiceTurnOrigin = null;
  let recognitionErrorCode = null;

  recognition.onstart = () => {
    const interactionSnapshot = interactionSessionController.getSnapshot();
    voiceTurnOrigin = state.requestedVoiceTurnOrigin || (interactionSnapshot.state === "speaking"
      ? "barge-in"
      : interactionSnapshot.state === "follow-up-window" ? "follow-up" : null);
    state.requestedVoiceTurnOrigin = null;
    state.activeVoiceTurnOrigin = voiceTurnOrigin;
    recognitionErrorCode = null;
    if (voiceTurnOrigin === "follow-up"
      && !isCurrentVoiceFollowUpWindow(interactionSnapshot)) {
      state.listening = true;
      recognition.abort();
      return;
    }
    voiceOutputAdapter.stop({ reason: "barge-in-replaced" });
    if (interactionSnapshot.state === "speaking" && interactionSnapshot.activeTurn) {
      interactionSessionController.requestCancellation("barge-in-replaced");
    }
    currentTranscript = "";
    state.listening = true;
    els.micButton.classList.add("recording");
    setMode("listening", "正在聆听语音");
  };

  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      transcript += event.results[i][0].transcript;
    }
    currentTranscript = transcript;
    els.commandInput.value = transcript;
  };

  recognition.onerror = (event) => {
    recognitionErrorCode = event?.error || "unknown";
    if (event?.error === "aborted" && voiceTurnOrigin === "follow-up") return;
    if (event?.error === "no-speech" && voiceTurnOrigin === "follow-up") return;
    if (event?.error === "no-speech" && ["local-wake", "local-wake-retry"].includes(voiceTurnOrigin)) {
      addRuntimeEvent("voice", "唤醒后未听到指令，已返回常驻等待", "info");
      return;
    }
    addRuntimeEvent("voice", "语音识别不可用，请使用文本输入或快捷场景", "warning");
  };

  recognition.onend = () => {
    state.listening = false;
    state.activeVoiceTurnOrigin = null;
    els.micButton.classList.remove("recording");
    const text = currentTranscript.trim();
    const turnOrigin = voiceTurnOrigin;
    voiceTurnOrigin = null;
    const localWakeTranscript = ["local-wake", "local-wake-retry"].includes(turnOrigin)
      ? classifyLocalWakeTranscript(text)
      : null;
    if (turnOrigin === "follow-up") {
      const snapshot = interactionSessionController.getSnapshot();
      if (text && isCurrentVoiceFollowUpWindow(snapshot)) {
        interactionSessionController.startListening();
        runCommand(text, { inputSource: "voice", voiceTurnOrigin: "follow-up" });
      } else {
        if (snapshot.state === "follow-up-window") {
          interactionSessionController.closeSession({
            reasonCode: recognitionErrorCode && recognitionErrorCode !== "no-speech"
              ? "follow-up-recognition-unavailable"
              : "follow-up-voice-empty",
          });
        }
        void voiceCaptureController?.resumeStandby();
      }
      recognitionErrorCode = null;
      return;
    }
    if (turnOrigin === "local-wake" && localWakeTranscript?.kind === "transition-echo") {
      els.commandInput.value = "";
      setMode("listening", "已唤醒，请说指令");
      window.setTimeout(() => {
        if (!startBrowserSpeechRecognition("local-wake-retry")) {
          interactionSessionController.closeSession({ reasonCode: "voice-transcription-unavailable" });
        }
      }, 250);
      return;
    }
    if (localWakeTranscript?.kind === "transition-echo") els.commandInput.value = "";
    const acceptedText = localWakeTranscript?.kind === "command" ? localWakeTranscript.text : text;
    if (acceptedText && localWakeTranscript?.kind !== "transition-echo") {
      runCommand(acceptedText, {
        inputSource: "voice",
        voiceTurnOrigin: turnOrigin === "local-wake-retry" ? "local-wake" : turnOrigin,
      });
    } else if (["local-wake", "local-wake-retry"].includes(turnOrigin)) {
      const snapshot = interactionSessionController.getSnapshot();
      if (snapshot.state !== "dormant") {
        interactionSessionController.closeSession({ reasonCode: "voice-input-empty" });
      }
    } else if (turnOrigin === "push-to-talk") {
      void voiceCaptureController?.resumeStandby();
    }
  };

  state.recognition = recognition;
}

function setupEvents() {
  els.micButton.addEventListener("click", async () => {
    if (state.listening) {
      state.recognition.stop();
      return;
    }
    const interactionState = interactionSessionController.getSnapshot().state;
    const requestedOrigin = ["speaking", "follow-up-window"].includes(interactionState)
      ? null
      : "push-to-talk";
    if (state.localVoice.enabled) await voiceCaptureController?.suspendForBrowserRecognition();
    if (!startBrowserSpeechRecognition(requestedOrigin)) {
      await voiceCaptureController?.resumeStandby();
    }
  });

  els.runButton.addEventListener("click", () => runCommand(els.commandInput.value));
  els.safetyConfirmationConfirm?.addEventListener("click", confirmPendingAction);
  els.safetyConfirmationVoice?.addEventListener("click", () => void toggleVoiceConfirmation());
  els.safetyConfirmationCancel?.addEventListener("click", cancelPendingAction);
  document.addEventListener("keydown", handleConfirmationModalKeydown);
  els.ttsPauseButton?.addEventListener("click", pauseVoiceOutput);
  els.ttsResumeButton?.addEventListener("click", resumeVoiceOutput);
  els.ttsStopButton?.addEventListener("click", stopVoiceOutput);
  els.stopCurrentTaskButton?.addEventListener("click", () => {
    runtime.cancelPendingClarification(sessionId, "user-cancelled");
    const snapshot = interactionSessionController.getSnapshot();
    if (!snapshot.activeTurn || !["processing", "speaking"].includes(snapshot.state)) return;
    transitionManualEvidenceRun({ type: "request-aborted", runId: snapshot.activeTurn.runId });
    interactionSessionController.requestCancellation("user-cancelled");
  });
  els.clearSessionMemoryButton?.addEventListener("click", () => {
    const sessionSnapshot = interactionSessionController.getSnapshot();
    const activeSessionId = sessionSnapshot.sessionId
      || sessionSnapshot.previousSession?.sessionId
      || sessionId;
    sessionMemory.clear(activeSessionId);
    addRuntimeEvent("conversation", "已清除本次浏览器会话的短期记忆。", "info");
  });
  els.replayBackButton?.addEventListener("click", stepReplayBack);
  els.replayForwardButton?.addEventListener("click", stepReplayForward);
  els.replayLiveButton?.addEventListener("click", returnToLiveProjection);

  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = quickCommands[button.dataset.scenario];
      els.commandInput.value = text;
      runCommand(text, { vehicleStatePatch: quickVehicleStatePatches[button.dataset.scenario] || null });
    });
  });

}

function setupVehicleModel() {
  updateDemoVehicleAssetStatus(window.vehicleRig?.getState?.().modelLoaded === true ? "ready" : "loading");
  window.setTimeout(() => {
    if (!window.vehicleRig && els.modelStatus) {
      const bootError = window.__vehicleBootError ? `：${window.__vehicleBootError}` : "";
      els.modelStatus.textContent = `Three.js 开发车模未启动，无法展示车辆可视化${bootError}`;
      addRuntimeEvent("vehicle", `Three.js 模块未加载，中央仅保留协同流程与结果面板${bootError}`, "warning");
      updateDemoVehicleAssetStatus("failed");
    }
  }, 5000);

  window.addEventListener("vehicleRigReady", () => {
    window.__vehicleBootError = null;
    els.vehicleScene.classList.add("three-ready");
    if (els.modelStatus) {
      els.modelStatus.textContent = "Three.js 渲染器已初始化，正在加载 NIO ES7 组件动画 GLB";
      els.modelStatus.dataset.state = "loading";
    }
  });

  window.addEventListener("vehicleModelLoaded", () => {
    updateDemoVehicleAssetStatus("ready");
    const currentSnapshot = state.providerSnapshot || state.confirmedVehicleStateSnapshot;
    const restored = window.vehicleRig?.syncConfirmedState?.(currentSnapshot, { immediate: true }) === true;
    if (!restored && state.lastVehicleHmiPresentation) {
      applyHmiPresentation(state.lastVehicleHmiPresentation);
    }
    addRuntimeEvent("vehicle", "Three.js 已加载 NIO ES7 GLB、25 条机械动作与已确认车辆状态动画适配层", "success");
  });

  window.addEventListener("vehicleModelLoadFailed", (event) => {
    updateDemoVehicleAssetStatus("failed");
    const detail = event.detail?.message ? `：${event.detail.message}` : "";
    if (els.modelStatus) {
      const prefix = event.detail?.reason === "timeout" ? "NIO ES7 GLB 加载超时" : "NIO ES7 GLB 加载失败";
      els.modelStatus.textContent = `${prefix}，当前无法展示车辆可视化${detail}`;
      els.modelStatus.dataset.state = event.detail?.reason === "timeout" ? "timeout" : "failed";
    }
    addRuntimeEvent("vehicle", `NIO ES7 GLB 加载失败，当前无法展示车辆可视化${detail}`, "warning");
  });
}

function startRuntimeWarmup() {
  const readiness = fetch("/api/runtime-warmup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`runtime warmup HTTP ${response.status}`);
    return response.json();
  }).catch(() => ({
    status: "degraded",
    durationMs: 0,
    tasks: {
      manualRag: { status: "degraded", durationMs: 0 },
      gptSoVits: { status: "degraded", durationMs: 0 },
    },
  }));
  if (window.NIO_B2_ACCEPTANCE_INSTRUMENTATION === true) {
    Object.defineProperty(window, "__runtimeWarmupReady", {
      configurable: true,
      enumerable: false,
      value: readiness,
      writable: false,
    });
  }
  return readiness;
}

function boot() {
  renderInteractionSessionStatus();
  renderManualEvidenceAnswerState();
  renderComponents();
  renderRunSummary();
  renderRunDetails();
  setupEs8InterfaceControls();
  setupDeveloperVehicleStatePanel();
  renderVehicleStateMetrics(vehicleStateProvider.getSnapshot());
  renderReplayControls();
  renderVoiceOutputControls();
  renderNetworkStatus();
  renderModelRouteStatus();
  setupDemoReadinessPanel();
  setupLocalVoice();
  setupVoiceIdentitySettings();
  startDemoReadinessPolling();
  setupVehicleModel();
  setupSpeech();
  setupEvents();
  window.__runtimeDebug = getRuntimeDebugSnapshot;
  window.__vehicleDebug = () => ({
    ...getRuntimeDebugSnapshot(),
    vehicleRig: window.vehicleRig?.getState?.(),
    vehicleCapabilities: window.vehicleRig?.getCapabilities?.(),
  });
  window.runCommand = runCommand;
  addRuntimeEvent("system", "本地协同 Runtime 已就绪，可使用语音、文本或快捷场景", "success");
}

boot();
