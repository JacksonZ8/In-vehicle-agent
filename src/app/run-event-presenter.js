import { requireParticipant } from "../runtime/participant-registry.js";
import { validateRunEvent } from "../runtime/run-event-protocol.js";
import { VEHICLE_STATE_KEYS } from "../safety/vehicle-state.js";
import { VEHICLE_SLU_OUTPUT_SCHEMA, VEHICLE_SLU_SLOT_SCHEMAS } from "../semantic/vehicle-slu-contract.js";
import { ES7_GENERIC_ACTION_IDS } from "../vehicle/es7-action-catalog.js";

// Slot projection types follow the Vehicle-SLU contract so new slots are never silently dropped.
const VEHICLE_SLU_SLOT_PROPERTIES = VEHICLE_SLU_OUTPUT_SCHEMA.properties.vehicleFrames.items.properties.slots.properties;
const VEHICLE_SLU_SLOT_TYPES = Object.freeze(Object.fromEntries(Object.entries(VEHICLE_SLU_SLOT_PROPERTIES)
  .map(([field, schema]) => [field, field === "windowTargets" ? "window-target-array"
    : field === "stateFields" ? "state-field-array"
      : schema.type])));
const VEHICLE_STATE_FIELD_SET = new Set(VEHICLE_STATE_KEYS);

const RUNTIME_RESULT_DEBUG_FIELDS = Object.freeze([
  "requestId",
  "interactionRef",
  "routeDecision",
  "runtimeTelemetry",
  "mode",
  "agentMode",
  "parsedCommand",
  "semanticEnvelope",
  "executionDisabled",
  "semanticTelemetry",
  "vehicleStateSnapshot",
  "safetyDecision",
  "toolCall",
  "toolResult",
  "cloudResult",
  "conversationResult",
  "assistantResponse",
  "assistantSpeechText",
  "assistantSpeechPolicy",
  "planningFallback",
  "manualEvidence",
  "manualGrounding",
  "manualAnswerPolicy",
  "manualQueryPlan",
  "voiceBridgeEligibility",
  "memoryContextTelemetry",
  "memoryWrite",
  "status",
  "taskStatus",
  "executionFacts",
  "committedEffects",
  "taskSnapshot",
]);

const SAFE_DEBUG_STRUCTURED_FIELDS = new Set([
  "acceptedAssertions", "acceptedCount", "accessMode", "action", "actionDigest", "actionNeed", "activeStepIds", "adaptiveK",
  "applicable", "assumedCorpus",
  "actionId", "airflow", "allowed", "alternative",
  "angle", "angleOutOfRange", "answerCharacters", "answerChars", "answerClaims",
  "answerClaimsPolicy", "antiPinch", "args", "assertions", "asset", "assetError",
  "assetFailures", "assetId", "assetPreload", "assetStatus", "at", "audioBytes",
  "batteryPercent", "bridge", "browserFallbackUsed",
  "browserFallbackReason", "cacheHit", "cancelReason", "cancellationState", "cancelledMs", "capabilities", "capabilityId",
  "candidateDecisions", "capturedAt", "capturedAtByField", "capturedAtMode", "challenge", "challengeId", "chunkCount", "chunkGapsMs", "chunkId",
  "chunks", "citation", "claimAudits", "code", "commandId", "completeAudioReadyMs", "completionStatus",
  "completedMs", "completionSource", "completionSources", "confidence", "confidenceStrength",
  "confirmedSnapshotId",
  "confirmationChallenge",
  "committedEffects", "completedStepIds", "conversationGoal", "corpusApplicability", "currentStage", "cursor", "dataBoundaries", "decision", "disposition",
  "deferred", "degraded",
  "destination", "displayTextChars", "domain", "driverBackrestAngle", "durationMs",
  "eligibility", "eligibilityPolicy", "elapsedWaitMs", "embeddingStatus", "enabled", "estimatedSpeechMs", "eval_count",
  "eval_duration_ms", "eventCount", "evidence", "evidenceIds",
  "executionError", "executionState", "executionTrace", "externalDataType", "failureReason", "fallback",
  "fallbackApplied", "finalAnswerSelectionBasis", "firstAudibleMs", "firstPlayStartedMs",
  "gear", "goalId", "hmiSummary", "httpStatus", "id", "index", "initialTier", "input",
  "intent", "intentNormalization", "interactionType", "kind", "knowledgeNeed", "label",
  "manualEvidence",
  "manualEvidenceStatus",
  "manualEvidenceTelemetry", "manualSafetyConstraints", "manualSafetyNotes",
  "latestFactsRef", "manualSafetyPolicy", "manualVersion", "maxAssets", "maxChunkGapMs",
  "maxPrebakedAssetsPerRun", "maxPrebakedAssetsPerTurn", "maxStreamScheduleGapMs",
  "memorySourcedRequiredSlots", "minArrivalSoc", "missReason", "missingRequiredSlots",
  "mocked", "mode", "model", "modelCallCount", "modelCalls", "modelType", "needsClarification", "needsConfirmation",
  "ok", "ollamaDurations", "open", "output", "outputChars", "page", "pageEnd", "pageStart", "pendingStepIds", "planId",
  "passengerMode", "percent", "phase", "playedAssetIds", "policy", "policyId",
  "playDurationMs", "playEndedMs", "playStartedMs", "prefetchWindow",
  "previousEndToPlayStartGapMs", "profileId", "provider", "providerCapabilityPolicyId",
  "promptChars", "promptStyle", "promptVersion", "prompt_eval_count", "prompt_eval_duration_ms", "queryChars", "queue", "queueGapMs",
  "queueState", "rank", "rainDetected", "rejectedCount", "remaining",
  "normalizedIntentRef", "relation", "relatedRunIds", "routeId", "reason", "reasonCode", "rearClearance", "requestedAngle", "requestedIntent", "requestedState",
  "requestedTemperature", "requestId", "requestStartMs", "requestToCompleteAudioReadyMs", "runId",
  "requestToResponseHeadersMs", "requiresExternalData", "requiresPoi", "requiresSafety", "responseHeadersMs",
  "responseHeaders", "responseMode", "retainedClaims", "retrievalMode", "retryable",
  "reviewedCitationSpans", "safeIntent", "safeSlots", "seat",
  "scenarioAudit", "scenarioId", "scheduledFirstAudioMs", "selectionBasis", "semanticPolicy", "sequence",
  "separateShortOpener", "simulated", "slotProvenance", "speedKph",
  "semanticSource", "simulatorMode", "slots", "source", "sourceId", "speechTextChars", "speechTextPolicy", "stagedAt",
  "speechTextProvenance", "stage", "state", "statePatch", "status", "summary",
  "startedAtMs", "startedMs", "stepResults", "streamChunkArrivalMs", "streamScheduleGapsMs", "tailgateOpen",
  "taskId", "taskStatus", "temperature", "temperatureOutOfRange", "textChars",
  "thresholdMs", "tier", "timestamp", "title", "tokenCount", "tool", "toolContext",
  "topic", "traceData",
  "telemetry",
  "turnCount", "turnId", "type", "unavailable", "unsupportedClaims", "updatedAt", "values", "vehicleLocked", "vehicleModel",
  "vehicleSpeedKph", "version", "visualScenario", "watchdogDurationMs",
  "watchdogGraceMs", "watchdogTriggered", "weatherLocationClarification",
  "componentActionStateById", "seatComfortByZone", "climatePower", "climateMode", "fanLevel",
  "value", "windowAntiPinchAvailable", "windowPositionPercentByZone", "zone",
  "x-nio-tts-diagnostic-request-id", "x-nio-tts-license-boundary",
  "x-nio-tts-profile-id", "x-nio-tts-synthesis-profile-id",
]);

const RUNTIME_RESULT_TEXT_FIELDS = new Set([
  "requestId", "mode", "agentMode", "assistantResponse", "assistantSpeechText",
  "status", "taskStatus",
]);
const RUNTIME_DEBUG_SCALAR = Symbol("runtime-debug-scalar");
const RUNTIME_DEBUG_ARRAY_ITEM = Symbol("runtime-debug-array-item");
const RUNTIME_STRING_LIST_SCHEMA = runtimeArraySchema(RUNTIME_DEBUG_SCALAR);
const RUNTIME_POLICY_SCHEMA = Object.freeze({
  id: RUNTIME_DEBUG_SCALAR,
  policyId: RUNTIME_DEBUG_SCALAR,
  version: RUNTIME_DEBUG_SCALAR,
  policyVersion: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_WINDOW_POSITIONS_SCHEMA = Object.freeze({
  front_left: RUNTIME_DEBUG_SCALAR,
  front_right: RUNTIME_DEBUG_SCALAR,
  rear_left: RUNTIME_DEBUG_SCALAR,
  rear_right: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_SEAT_COMFORT_SCHEMA = Object.freeze(Object.fromEntries(
  ["driver", "passenger", "row2_left", "row2_right", "row3_left", "row3_right"].map((zone) => [zone, Object.freeze({
    mode: RUNTIME_DEBUG_SCALAR,
    level: RUNTIME_DEBUG_SCALAR,
  })]),
));
const RUNTIME_COMPONENT_ACTIONS_SCHEMA = Object.freeze(Object.fromEntries(
  ES7_GENERIC_ACTION_IDS.map((actionId) => [actionId, RUNTIME_DEBUG_SCALAR]),
));
const RUNTIME_VEHICLE_VALUES_SCHEMA = Object.freeze({
  windowPositionPercentByZone: RUNTIME_WINDOW_POSITIONS_SCHEMA,
  vehicleLocked: RUNTIME_DEBUG_SCALAR,
  tailgateOpen: RUNTIME_DEBUG_SCALAR,
  driverBackrestAngle: RUNTIME_DEBUG_SCALAR,
  seatComfortByZone: RUNTIME_SEAT_COMFORT_SCHEMA,
  componentActionStateById: RUNTIME_COMPONENT_ACTIONS_SCHEMA,
  cabinTemperature: RUNTIME_DEBUG_SCALAR,
  climatePower: RUNTIME_DEBUG_SCALAR,
  climateMode: RUNTIME_DEBUG_SCALAR,
  fanLevel: RUNTIME_DEBUG_SCALAR,
  airflow: RUNTIME_DEBUG_SCALAR,
  passengerMode: RUNTIME_DEBUG_SCALAR,
  batteryPercent: RUNTIME_DEBUG_SCALAR,
  speedKph: RUNTIME_DEBUG_SCALAR,
  gear: RUNTIME_DEBUG_SCALAR,
  rearClearance: RUNTIME_DEBUG_SCALAR,
  windowAntiPinchAvailable: RUNTIME_DEBUG_SCALAR,
  rainDetected: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_CAPTURED_AT_SCHEMA = Object.freeze(Object.fromEntries(
  VEHICLE_STATE_KEYS.map((field) => [field, RUNTIME_DEBUG_SCALAR]),
));
const RUNTIME_VEHICLE_SNAPSHOT_SCHEMA = Object.freeze({
  id: RUNTIME_DEBUG_SCALAR,
  source: RUNTIME_DEBUG_SCALAR,
  simulated: RUNTIME_DEBUG_SCALAR,
  capturedAt: RUNTIME_DEBUG_SCALAR,
  freshnessMs: RUNTIME_DEBUG_SCALAR,
  capturedAtByField: RUNTIME_CAPTURED_AT_SCHEMA,
  values: RUNTIME_VEHICLE_VALUES_SCHEMA,
  latestFactsRef: RUNTIME_DEBUG_SCALAR,
  version: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_EVIDENCE_SCORE_SCHEMA = Object.freeze({
  retrieval: RUNTIME_DEBUG_SCALAR,
  rerank: RUNTIME_DEBUG_SCALAR,
  grounding: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_EVIDENCE_REF_SCHEMA = Object.freeze({
  id: RUNTIME_DEBUG_SCALAR,
  source: RUNTIME_DEBUG_SCALAR,
  sourceId: RUNTIME_DEBUG_SCALAR,
  sourceVersion: RUNTIME_DEBUG_SCALAR,
  type: RUNTIME_DEBUG_SCALAR,
  title: RUNTIME_DEBUG_SCALAR,
  citation: RUNTIME_DEBUG_SCALAR,
  chunkId: RUNTIME_DEBUG_SCALAR,
  page: RUNTIME_DEBUG_SCALAR,
  pageStart: RUNTIME_DEBUG_SCALAR,
  pageEnd: RUNTIME_DEBUG_SCALAR,
  excerpt: RUNTIME_DEBUG_SCALAR,
  score: RUNTIME_EVIDENCE_SCORE_SCHEMA,
});
const RUNTIME_EXECUTION_TRACE_ENTRY_SCHEMA = Object.freeze({
  state: RUNTIME_DEBUG_SCALAR,
  source: RUNTIME_DEBUG_SCALAR,
  at: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_EXECUTION_ERROR_SCHEMA = Object.freeze({
  code: RUNTIME_DEBUG_SCALAR,
  stage: RUNTIME_DEBUG_SCALAR,
  retryable: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_TOOL_ARGS_SCHEMA = Object.freeze({
  zone: RUNTIME_DEBUG_SCALAR,
  percent: RUNTIME_DEBUG_SCALAR,
  open: RUNTIME_DEBUG_SCALAR,
  seat: RUNTIME_DEBUG_SCALAR,
  angle: RUNTIME_DEBUG_SCALAR,
  temperature: RUNTIME_DEBUG_SCALAR,
  airflow: RUNTIME_DEBUG_SCALAR,
  passengerMode: RUNTIME_DEBUG_SCALAR,
  actionId: RUNTIME_DEBUG_SCALAR,
  value: RUNTIME_DEBUG_SCALAR,
  query: RUNTIME_DEBUG_SCALAR,
  vehicleModel: RUNTIME_DEBUG_SCALAR,
  eligibilityAction: RUNTIME_DEBUG_SCALAR,
  stateFields: RUNTIME_STRING_LIST_SCHEMA,
  location: RUNTIME_DEBUG_SCALAR,
  timeRange: RUNTIME_DEBUG_SCALAR,
  origin: RUNTIME_DEBUG_SCALAR,
  destination: RUNTIME_DEBUG_SCALAR,
  contact: RUNTIME_DEBUG_SCALAR,
  topic: RUNTIME_DEBUG_SCALAR,
  externalDataType: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_STATE_PATCH_SCHEMA = Object.freeze({
  ...RUNTIME_VEHICLE_VALUES_SCHEMA,
  destination: RUNTIME_DEBUG_SCALAR,
  location: RUNTIME_DEBUG_SCALAR,
  timestamp: RUNTIME_DEBUG_SCALAR,
  status: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_TOOL_RESULT_SCHEMA = Object.freeze({
  requestId: RUNTIME_DEBUG_SCALAR,
  commandId: RUNTIME_DEBUG_SCALAR,
  tool: RUNTIME_DEBUG_SCALAR,
  ok: RUNTIME_DEBUG_SCALAR,
  executionState: RUNTIME_DEBUG_SCALAR,
  executionTrace: runtimeArraySchema(RUNTIME_EXECUTION_TRACE_ENTRY_SCHEMA),
  executionError: RUNTIME_EXECUTION_ERROR_SCHEMA,
  requestedState: RUNTIME_VEHICLE_VALUES_SCHEMA,
  confirmedSnapshotId: RUNTIME_DEBUG_SCALAR,
  hmiSummary: RUNTIME_DEBUG_SCALAR,
  source: RUNTIME_DEBUG_SCALAR,
  simulated: RUNTIME_DEBUG_SCALAR,
  timestamp: RUNTIME_DEBUG_SCALAR,
  statePatch: RUNTIME_STATE_PATCH_SCHEMA,
  cancellationState: RUNTIME_DEBUG_SCALAR,
  reasonCode: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_CONFIRMATION_ASSERTION_SCHEMA = Object.freeze({ id: RUNTIME_DEBUG_SCALAR });
const RUNTIME_CONFIRMATION_CHALLENGE_SCHEMA = Object.freeze({
  id: RUNTIME_DEBUG_SCALAR,
  challengeId: RUNTIME_DEBUG_SCALAR,
  requestId: RUNTIME_DEBUG_SCALAR,
  actionDigest: RUNTIME_DEBUG_SCALAR,
  policyId: RUNTIME_DEBUG_SCALAR,
  policyVersion: RUNTIME_DEBUG_SCALAR,
  assertions: runtimeArraySchema(RUNTIME_CONFIRMATION_ASSERTION_SCHEMA),
});
const RUNTIME_MANUAL_SAFETY_ITEM_SCHEMA = Object.freeze({
  id: RUNTIME_DEBUG_SCALAR,
  topic: RUNTIME_DEBUG_SCALAR,
  source: RUNTIME_DEBUG_SCALAR,
  title: RUNTIME_DEBUG_SCALAR,
  citation: RUNTIME_DEBUG_SCALAR,
  reasonCode: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_SAFETY_DECISION_SCHEMA = Object.freeze({
  allowed: RUNTIME_DEBUG_SCALAR,
  action: RUNTIME_DEBUG_SCALAR,
  reason: RUNTIME_DEBUG_SCALAR,
  reasonCode: RUNTIME_DEBUG_SCALAR,
  policy: RUNTIME_POLICY_SCHEMA,
  policyId: RUNTIME_DEBUG_SCALAR,
  policyVersion: RUNTIME_DEBUG_SCALAR,
  confirmationChallenge: RUNTIME_CONFIRMATION_CHALLENGE_SCHEMA,
  manualEvidenceStatus: RUNTIME_DEBUG_SCALAR,
  manualEvidenceQuery: RUNTIME_DEBUG_SCALAR,
  manualSafetyConstraints: runtimeArraySchema(RUNTIME_MANUAL_SAFETY_ITEM_SCHEMA),
  manualSafetyNotes: runtimeArraySchema(RUNTIME_MANUAL_SAFETY_ITEM_SCHEMA),
  manualSafetyPolicy: RUNTIME_POLICY_SCHEMA,
});
const RUNTIME_MODEL_TELEMETRY_SCHEMA = Object.freeze({
  provider: RUNTIME_DEBUG_SCALAR,
  model: RUNTIME_DEBUG_SCALAR,
  durationMs: RUNTIME_DEBUG_SCALAR,
  promptChars: RUNTIME_DEBUG_SCALAR,
  promptStyle: RUNTIME_DEBUG_SCALAR,
  promptVersion: RUNTIME_DEBUG_SCALAR,
  status: RUNTIME_DEBUG_SCALAR,
  reasonCode: RUNTIME_DEBUG_SCALAR,
  fallbackReasonCode: RUNTIME_DEBUG_SCALAR,
  validationSubreason: RUNTIME_DEBUG_SCALAR,
  primaryFailureReasonCode: RUNTIME_DEBUG_SCALAR,
  providerFailureReasonCode: RUNTIME_DEBUG_SCALAR,
  fallbackActive: RUNTIME_DEBUG_SCALAR,
  fallbackAttempted: RUNTIME_DEBUG_SCALAR,
  externalModelRequestCount: RUNTIME_DEBUG_SCALAR,
  ollamaDurations: Object.freeze({
    total_duration_ms: RUNTIME_DEBUG_SCALAR,
    load_duration_ms: RUNTIME_DEBUG_SCALAR,
    prompt_eval_duration_ms: RUNTIME_DEBUG_SCALAR,
    eval_duration_ms: RUNTIME_DEBUG_SCALAR,
    prompt_eval_count: RUNTIME_DEBUG_SCALAR,
    eval_count: RUNTIME_DEBUG_SCALAR,
  }),
  degraded: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_MODEL_CALL_SCHEMA = Object.freeze({
  phase: RUNTIME_DEBUG_SCALAR,
  component: RUNTIME_DEBUG_SCALAR,
  model: RUNTIME_DEBUG_SCALAR,
  provider: RUNTIME_DEBUG_SCALAR,
  durationMs: RUNTIME_DEBUG_SCALAR,
  status: RUNTIME_DEBUG_SCALAR,
  reasonCode: RUNTIME_DEBUG_SCALAR,
  telemetry: RUNTIME_MODEL_TELEMETRY_SCHEMA,
});
const RUNTIME_COMMITTED_EFFECT_SCHEMA = Object.freeze({
  stepId: RUNTIME_DEBUG_SCALAR,
  capabilityId: RUNTIME_DEBUG_SCALAR,
  commandId: RUNTIME_DEBUG_SCALAR,
  requestId: RUNTIME_DEBUG_SCALAR,
  tool: RUNTIME_DEBUG_SCALAR,
  executionState: RUNTIME_DEBUG_SCALAR,
  confirmedSnapshotId: RUNTIME_DEBUG_SCALAR,
  source: RUNTIME_DEBUG_SCALAR,
  status: RUNTIME_DEBUG_SCALAR,
  summary: RUNTIME_DEBUG_SCALAR,
  reasonCode: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_STEP_RESULT_VALUE_SCHEMA = Object.freeze({
  status: RUNTIME_DEBUG_SCALAR,
  outcomeStatus: RUNTIME_DEBUG_SCALAR,
  reasonCode: RUNTIME_DEBUG_SCALAR,
  degraded: RUNTIME_DEBUG_SCALAR,
  toolResult: RUNTIME_TOOL_RESULT_SCHEMA,
  confirmedVehicleState: RUNTIME_VEHICLE_SNAPSHOT_SCHEMA,
  safetyDecision: RUNTIME_SAFETY_DECISION_SCHEMA,
  evidenceRefs: runtimeArraySchema(RUNTIME_EVIDENCE_REF_SCHEMA),
});
const RUNTIME_STEP_RESULT_SCHEMA = Object.freeze({
  stepId: RUNTIME_DEBUG_SCALAR,
  capabilityId: RUNTIME_DEBUG_SCALAR,
  status: RUNTIME_DEBUG_SCALAR,
  failureReason: RUNTIME_DEBUG_SCALAR,
  result: RUNTIME_STEP_RESULT_VALUE_SCHEMA,
});
const RUNTIME_SAFETY_ASSESSMENT_REF_SCHEMA = Object.freeze({
  allowed: RUNTIME_DEBUG_SCALAR,
  action: RUNTIME_DEBUG_SCALAR,
  reasonCode: RUNTIME_DEBUG_SCALAR,
  policyId: RUNTIME_DEBUG_SCALAR,
  policyVersion: RUNTIME_DEBUG_SCALAR,
  snapshotId: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_MANUAL_EVIDENCE_TELEMETRY_SCHEMA = Object.freeze({
  durationMs: RUNTIME_DEBUG_SCALAR,
  retrievalMode: RUNTIME_DEBUG_SCALAR,
  acceptedCount: RUNTIME_DEBUG_SCALAR,
  rejectedCount: RUNTIME_DEBUG_SCALAR,
  missReason: RUNTIME_DEBUG_SCALAR,
  eligibilityPolicy: RUNTIME_POLICY_SCHEMA,
  candidateDecisions: runtimeArraySchema(Object.freeze({
    chunkId: RUNTIME_DEBUG_SCALAR,
    applicable: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
  })),
  corpusApplicability: Object.freeze({
    applicable: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
  }),
});
const RUNTIME_MANUAL_EVIDENCE_SCHEMA = Object.freeze({
  status: RUNTIME_DEBUG_SCALAR,
  evidence: runtimeArraySchema(RUNTIME_EVIDENCE_REF_SCHEMA),
  evidenceRefs: runtimeArraySchema(RUNTIME_EVIDENCE_REF_SCHEMA),
  telemetry: RUNTIME_MANUAL_EVIDENCE_TELEMETRY_SCHEMA,
  manualEvidenceStatus: RUNTIME_DEBUG_SCALAR,
  manualEvidenceTelemetry: RUNTIME_MANUAL_EVIDENCE_TELEMETRY_SCHEMA,
  reasonCode: RUNTIME_DEBUG_SCALAR,
  missReason: RUNTIME_DEBUG_SCALAR,
});
const RUNTIME_RESULT_STRUCTURED_CONTRACTS = Object.freeze({
  routeDecision: Object.freeze({
    disposition: RUNTIME_DEBUG_SCALAR,
    routeId: RUNTIME_DEBUG_SCALAR,
    mode: RUNTIME_DEBUG_SCALAR,
    semanticSource: RUNTIME_DEBUG_SCALAR,
    reason: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
    confidence: RUNTIME_DEBUG_SCALAR,
    domain: RUNTIME_DEBUG_SCALAR,
    degraded: RUNTIME_DEBUG_SCALAR,
    validation: Object.freeze({
      contract: Object.freeze({ ok: RUNTIME_DEBUG_SCALAR }),
      capability: Object.freeze({ ok: RUNTIME_DEBUG_SCALAR }),
      slot: Object.freeze({ ok: RUNTIME_DEBUG_SCALAR }),
    }),
  }),
  runtimeTelemetry: Object.freeze({
    modelCallCount: RUNTIME_DEBUG_SCALAR,
    modelCalls: runtimeArraySchema(RUNTIME_MODEL_CALL_SCHEMA),
    eventCount: RUNTIME_DEBUG_SCALAR,
    degraded: RUNTIME_DEBUG_SCALAR,
    durationMs: RUNTIME_DEBUG_SCALAR,
    status: RUNTIME_DEBUG_SCALAR,
    watchdogDurationMs: RUNTIME_DEBUG_SCALAR,
    watchdogGraceMs: RUNTIME_DEBUG_SCALAR,
    watchdogTriggered: RUNTIME_DEBUG_SCALAR,
    fallbackApplied: RUNTIME_DEBUG_SCALAR,
  }),
  parsedCommand: Object.freeze({
    requestId: RUNTIME_DEBUG_SCALAR,
    intent: RUNTIME_DEBUG_SCALAR,
    slots: RUNTIME_TOOL_ARGS_SCHEMA,
    semanticPolicy: RUNTIME_POLICY_SCHEMA,
    intentNormalization: Object.freeze({
      source: RUNTIME_DEBUG_SCALAR,
      reason: RUNTIME_DEBUG_SCALAR,
      reasonCode: RUNTIME_DEBUG_SCALAR,
    }),
    conversationGoal: Object.freeze({
      domain: RUNTIME_DEBUG_SCALAR,
      summary: RUNTIME_DEBUG_SCALAR,
      need: RUNTIME_DEBUG_SCALAR,
    }),
    missingRequiredSlots: RUNTIME_STRING_LIST_SCHEMA,
    needsClarification: RUNTIME_DEBUG_SCALAR,
    needsConfirmation: RUNTIME_DEBUG_SCALAR,
  }),
  semanticTelemetry: Object.freeze({
    ...RUNTIME_MODEL_TELEMETRY_SCHEMA,
    watchdogDurationMs: RUNTIME_DEBUG_SCALAR,
    watchdogTriggered: RUNTIME_DEBUG_SCALAR,
  }),
  vehicleStateSnapshot: RUNTIME_VEHICLE_SNAPSHOT_SCHEMA,
  safetyDecision: RUNTIME_SAFETY_DECISION_SCHEMA,
  toolCall: Object.freeze({
    requestId: RUNTIME_DEBUG_SCALAR,
    commandId: RUNTIME_DEBUG_SCALAR,
    tool: RUNTIME_DEBUG_SCALAR,
    args: RUNTIME_TOOL_ARGS_SCHEMA,
    requiresSafety: RUNTIME_DEBUG_SCALAR,
    capabilityId: RUNTIME_DEBUG_SCALAR,
  }),
  toolResult: RUNTIME_TOOL_RESULT_SCHEMA,
  assistantSpeechPolicy: Object.freeze({
    policy: RUNTIME_POLICY_SCHEMA,
    policyId: RUNTIME_DEBUG_SCALAR,
    version: RUNTIME_DEBUG_SCALAR,
    source: RUNTIME_DEBUG_SCALAR,
    reason: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
    speechTextPolicy: RUNTIME_DEBUG_SCALAR,
  }),
  planningFallback: Object.freeze({
    source: RUNTIME_DEBUG_SCALAR,
    reason: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
    degraded: RUNTIME_DEBUG_SCALAR,
    label: RUNTIME_DEBUG_SCALAR,
  }),
  manualGrounding: Object.freeze({
    status: RUNTIME_DEBUG_SCALAR,
    policy: RUNTIME_POLICY_SCHEMA,
    policyId: RUNTIME_DEBUG_SCALAR,
    version: RUNTIME_DEBUG_SCALAR,
    evidence: runtimeArraySchema(RUNTIME_EVIDENCE_REF_SCHEMA),
    evidenceIds: RUNTIME_STRING_LIST_SCHEMA,
    evidenceRefs: runtimeArraySchema(RUNTIME_EVIDENCE_REF_SCHEMA),
    claimAudits: runtimeArraySchema(Object.freeze({
      id: RUNTIME_DEBUG_SCALAR,
      status: RUNTIME_DEBUG_SCALAR,
      reasonCode: RUNTIME_DEBUG_SCALAR,
      evidenceIds: RUNTIME_STRING_LIST_SCHEMA,
    })),
    retainedClaims: RUNTIME_STRING_LIST_SCHEMA,
    unsupportedClaims: RUNTIME_STRING_LIST_SCHEMA,
    reason: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
  }),
  manualAnswerPolicy: Object.freeze({
    policy: RUNTIME_POLICY_SCHEMA,
    policyId: RUNTIME_DEBUG_SCALAR,
    version: RUNTIME_DEBUG_SCALAR,
    status: RUNTIME_DEBUG_SCALAR,
    selectionBasis: RUNTIME_DEBUG_SCALAR,
    reason: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
    answerClaimsPolicy: RUNTIME_DEBUG_SCALAR,
    finalAnswerSelectionBasis: RUNTIME_DEBUG_SCALAR,
  }),
  manualQueryPlan: Object.freeze({
    policy: RUNTIME_POLICY_SCHEMA,
    policyId: RUNTIME_DEBUG_SCALAR,
    version: RUNTIME_DEBUG_SCALAR,
    knowledgeNeed: RUNTIME_DEBUG_SCALAR,
    actionNeed: RUNTIME_DEBUG_SCALAR,
    adaptiveK: RUNTIME_DEBUG_SCALAR,
    retrievalMode: RUNTIME_DEBUG_SCALAR,
    reason: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
  }),
  voiceBridgeEligibility: Object.freeze({
    allowed: RUNTIME_DEBUG_SCALAR,
    noToolOrSafetyPath: RUNTIME_DEBUG_SCALAR,
    requestId: RUNTIME_DEBUG_SCALAR,
    reason: RUNTIME_DEBUG_SCALAR,
    policyId: RUNTIME_DEBUG_SCALAR,
    policyVersion: RUNTIME_DEBUG_SCALAR,
  }),
  memoryContextTelemetry: Object.freeze({
    status: RUNTIME_DEBUG_SCALAR,
    source: RUNTIME_DEBUG_SCALAR,
    turnCount: RUNTIME_DEBUG_SCALAR,
    tokenCount: RUNTIME_DEBUG_SCALAR,
    durationMs: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
  }),
  memoryWrite: Object.freeze({
    status: RUNTIME_DEBUG_SCALAR,
    source: RUNTIME_DEBUG_SCALAR,
    turnId: RUNTIME_DEBUG_SCALAR,
    runId: RUNTIME_DEBUG_SCALAR,
    updatedAt: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
  }),
  executionFacts: Object.freeze({
    runId: RUNTIME_DEBUG_SCALAR,
    planId: RUNTIME_DEBUG_SCALAR,
    goalId: RUNTIME_DEBUG_SCALAR,
    completionStatus: RUNTIME_DEBUG_SCALAR,
    failureReason: RUNTIME_DEBUG_SCALAR,
    degraded: RUNTIME_DEBUG_SCALAR,
    stepResults: runtimeArraySchema(RUNTIME_STEP_RESULT_SCHEMA),
    safetyDecision: RUNTIME_SAFETY_DECISION_SCHEMA,
    toolResult: RUNTIME_TOOL_RESULT_SCHEMA,
    confirmedVehicleState: RUNTIME_VEHICLE_SNAPSHOT_SCHEMA,
    activeStepIds: RUNTIME_STRING_LIST_SCHEMA,
    pendingStepIds: RUNTIME_STRING_LIST_SCHEMA,
    completedStepIds: RUNTIME_STRING_LIST_SCHEMA,
    latestFactsRef: RUNTIME_DEBUG_SCALAR,
    cancellationState: RUNTIME_DEBUG_SCALAR,
    updatedAt: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
    outcomeStatus: RUNTIME_DEBUG_SCALAR,
    evidenceRefs: runtimeArraySchema(RUNTIME_EVIDENCE_REF_SCHEMA),
    vehicleStateRefs: runtimeArraySchema(RUNTIME_VEHICLE_SNAPSHOT_SCHEMA),
    safetyAssessmentRef: RUNTIME_SAFETY_ASSESSMENT_REF_SCHEMA,
  }),
  committedEffects: runtimeArraySchema(RUNTIME_COMMITTED_EFFECT_SCHEMA),
  taskSnapshot: Object.freeze({
    taskId: RUNTIME_DEBUG_SCALAR,
    runId: RUNTIME_DEBUG_SCALAR,
    planId: RUNTIME_DEBUG_SCALAR,
    goalId: RUNTIME_DEBUG_SCALAR,
    status: RUNTIME_DEBUG_SCALAR,
    currentStage: RUNTIME_DEBUG_SCALAR,
    activeStepIds: RUNTIME_STRING_LIST_SCHEMA,
    pendingStepIds: RUNTIME_STRING_LIST_SCHEMA,
    completedStepIds: RUNTIME_STRING_LIST_SCHEMA,
    committedEffects: runtimeArraySchema(RUNTIME_COMMITTED_EFFECT_SCHEMA),
    latestFactsRef: RUNTIME_DEBUG_SCALAR,
    cancellationState: RUNTIME_DEBUG_SCALAR,
    updatedAt: RUNTIME_DEBUG_SCALAR,
    reasonCode: RUNTIME_DEBUG_SCALAR,
  }),
});

const DEBUG_LOG_ITEM_FIELDS = Object.freeze([
  "eventId",
  "parentEventId",
  "sequence",
  "timestamp",
  "component",
  "componentLabel",
  "componentType",
  "phase",
  "status",
  "summary",
  "refs",
  "observedAt",
  "observedMs",
  "durationMs",
  "model",
  "provider",
  "degraded",
  "simulated",
  "reasonCode",
  "scenarioAudit",
]);

const DEBUG_COMPONENT_FIELDS = Object.freeze([
  "id",
  "label",
  "type",
  "active",
  "status",
  "summary",
  "lastEventId",
  "lastSequence",
  "model",
  "provider",
]);

export function buildProviderSnapshotSummary(snapshot, {
  nowMs = Date.now(),
  maxAgeMs,
} = {}) {
  const values = snapshot?.values || {};
  const stableSummary = Object.freeze({
    id: snapshot?.id || null,
    source: snapshot?.source || "unknown",
    simulated: snapshot?.simulated === true,
    capturedAt: snapshot?.capturedAt || null,
    values: Object.freeze({
      speedKph: values.speedKph ?? null,
      gear: values.gear ?? null,
      rearClearance: values.rearClearance ?? null,
      windowAntiPinchAvailable: values.windowAntiPinchAvailable ?? null,
      rainDetected: values.rainDetected ?? null,
    }),
  });
  const capturedAtMs = Date.parse(stableSummary.capturedAt || "");
  const ageMs = nowMs - capturedAtMs;
  const freshness = Number.isFinite(nowMs)
    && Number.isFinite(maxAgeMs)
    && maxAgeMs >= 0
    && Number.isFinite(capturedAtMs)
    && ageMs >= 0
    && ageMs <= maxAgeMs
    ? "fresh"
    : "stale";
  return Object.freeze({
    ...stableSummary,
    freshness,
    fingerprint: createStableFingerprint(stableSummary),
  });
}

export function getB2VisibleCardKinds(b2) {
  const kinds = [];
  if (b2?.visibility?.cabinAssistant === true) kinds.push("b2-goal");
  if (b2?.visibility?.orchestrator === true) kinds.push("b2-plan");
  return Object.freeze(kinds);
}

export function buildRunEventViewModel(run, { cursor } = {}) {
  const events = Array.isArray(run?.events) ? run.events : [];
  const visibleCount = normalizeCursor(cursor, events.length);
  const visibleEvents = events.slice(0, visibleCount)
    .map(projectCanonicalPresentationEvent)
    .filter(Boolean);
  const componentsById = new Map();

  for (const event of visibleEvents) {
    const component = requireParticipant(event.component);
    componentsById.set(component.id, Object.freeze({
      ...component,
      active: true,
      status: event.status,
      summary: event.summary,
      lastEventId: event.eventId,
      lastSequence: event.sequence,
      model: event.model,
      provider: event.provider,
    }));
  }

  const startedAtMs = parseTimestamp(run?.startedAt)
    ?? parseTimestamp(visibleEvents[0]?.timestamp)
    ?? 0;
  const logItems = visibleEvents.map((event) => createLogItem(event, startedAtMs));
  const timelineItems = visibleEvents.map((event) => Object.freeze({
    ...createLogItem(event, startedAtMs),
    offsetMs: Math.max(0, (parseTimestamp(event.timestamp) ?? startedAtMs) - startedAtMs),
    durationMs: event.durationMs ?? null,
  }));
  const isFullProjection = visibleCount === events.length;
  const b2 = buildB2Projection(visibleEvents);
  const b3 = buildB3Projection(visibleEvents);
  const semanticDecision = buildSemanticDecisionProjection(visibleEvents);

  return Object.freeze({
    components: Object.freeze([...componentsById.values()]),
    logItems: Object.freeze(logItems),
    timelineItems: Object.freeze(timelineItems),
    b2,
    b3,
    semanticDecision,
    activeGoal: b2.goal?.objective || b3.vehicleKnowledge?.goal || null,
    terminalStatus: isFullProjection && run?.status !== "active" ? run?.status || null : null,
  });
}

function projectCanonicalPresentationEvent(event) {
  if (validateRunEvent(event).length > 0
    || !isRecord(event)
    || event.protocol?.id !== "nio-run-event"
    || event.protocol?.version !== "2.0.0"
    || !optionalString(event.eventId)
    || !optionalString(event.runId)
    || !Number.isSafeInteger(event.sequence)
    || event.sequence < 1
    || !optionalString(event.timestamp)
    || !optionalString(event.component)
    || !optionalString(event.componentType)
    || !optionalString(event.phase)
    || !optionalString(event.status)
    || !optionalString(event.summary)
    || !Array.isArray(event.refs)
    || !event.refs.every((value) => optionalString(value))) return null;
  let component;
  try {
    component = requireParticipant(event.component);
  } catch {
    return null;
  }
  if (component.type !== event.componentType) return null;
  return Object.freeze({
    eventId: event.eventId,
    runId: event.runId,
    parentEventId: optionalString(event.parentEventId),
    sequence: event.sequence,
    timestamp: event.timestamp,
    component: component.id,
    componentType: component.type,
    phase: event.phase,
    status: event.status,
    summary: event.summary,
    refs: Object.freeze([...event.refs]),
    model: optionalString(event.model),
    provider: optionalString(event.provider),
    durationMs: Number.isSafeInteger(event.durationMs) && event.durationMs >= 0
      ? event.durationMs
      : null,
    metadata: isRecord(event.metadata) ? event.metadata : Object.freeze({}),
  });
}

function buildB3Projection(events) {
  let goal = null;
  let delegation = null;
  let subplan = null;
  let evidence = [];
  let state = [];
  let safetyAssessment = null;
  let outcome = null;

  for (const event of events) {
    const knowledge = event.metadata?.knowledge;
    if (event.phase === "knowledge-delegation" && isRecord(knowledge?.delegation)) {
      delegation = projectKnowledgeDelegation(event, knowledge.delegation);
      goal = delegation.knowledgeGoal;
    }
    if (event.phase === "knowledge-subplanning" && isRecord(knowledge?.subplan)) {
      subplan = projectKnowledgeSubplan(event, knowledge.subplan);
    }
    if (event.phase === "knowledge-evidence") {
      evidence = projectKnowledgeReferences(knowledge?.evidenceRefs);
    }
    if (event.phase === "knowledge-state-read") {
      state = projectKnowledgeReferences(knowledge?.vehicleStateRefs, ["snapshotId", "id", "source"]);
    }
    if (event.phase === "knowledge-safety-assessment" && isRecord(knowledge?.safetyAssessment)) {
      safetyAssessment = projectSafetySummary(knowledge.safetyAssessment);
    }
    if (["knowledge-answer", "clarification", "final-synthesis"].includes(event.phase)
      && isRecord(knowledge)) {
      outcome = projectKnowledgeOutcome(event, knowledge);
    }
  }

  return deepFreeze({
    vehicleKnowledge: {
      goal,
      delegation,
      subplan,
      evidence,
      state,
      safetyAssessment,
      outcome,
      limitations: outcome?.limitations || [],
    },
  });
}

function projectKnowledgeDelegation(event, value) {
  return {
    eventId: optionalString(event.eventId),
    parentEventId: optionalString(event.parentEventId),
    ...projectStringRecord(value, [
      "delegationId", "runId", "parentPlanId", "parentStepId", "knowledgeGoal", "vehicleScope", "expectedAnswerContract",
    ]),
    allowedCapabilities: stringList(value.allowedCapabilities),
    dependsOn: stringList(value.dependsOn),
    allowVehicleStateRead: value.allowVehicleStateRead === true,
    requireSafetyEligibilityExplanation: value.requireSafetyEligibilityExplanation === true,
  };
}

function projectKnowledgeSubplan(event, value) {
  return {
    eventId: optionalString(event.eventId),
    parentEventId: optionalString(event.parentEventId),
    ...projectStringRecord(value, ["subplanId", "delegationId", "runId", "parentPlanId", "parentStepId", "planningSummary", "status"]),
    selectedCapabilities: stringList(value.selectedCapabilities),
    steps: (Array.isArray(value.steps) ? value.steps : []).filter(isRecord).map((step) => ({
      ...projectStringRecord(step, ["stepId", "capabilityId", "status", "accessMode"]),
      dependsOn: stringList(step.dependsOn),
    })),
  };
}

function projectKnowledgeReferences(value, fields = [
  "sourceId", "sourceVersion", "chunkId", "pageStart", "pageEnd", "excerpt",
  "id", "source", "type", "title", "citation", "snapshotId",
]) {
  return (Array.isArray(value) ? value : []).filter(isRecord)
    .map((reference) => {
      const projected = projectStringRecord(reference, fields);
      for (const field of ["pageStart", "pageEnd"]) {
        if (Number.isSafeInteger(reference[field]) && reference[field] >= 0) {
          projected[field] = reference[field];
        }
      }
      if (isRecord(reference.score)) {
        const score = {};
        for (const field of ["retrieval", "rerank", "grounding"]) {
          if (Number.isFinite(reference.score[field])) score[field] = reference.score[field];
        }
        if (Object.keys(score).length) projected.score = score;
      }
      return projected;
    });
}

function projectKnowledgeOutcome(event, value) {
  return {
    eventId: optionalString(event.eventId),
    parentEventId: optionalString(event.parentEventId),
    summary: optionalString(event.summary),
    dependsOnEventIds: stringList(value.dependsOnEventIds),
    ...projectStringRecord(value, ["delegationId", "runId", "outcomeStatus", "supportStatus"]),
    reasonCode: optionalString(event.metadata?.reasonCode),
    questions: stringList(value.questions),
    limitations: stringList(value.limitations),
    degraded: event.metadata?.degraded === true,
  };
}

function buildB2Projection(events) {
  let goal = null;
  let plan = null;
  let validation = null;
  let executionFacts = null;
  let response = null;
  let planningFallback = null;
  let planningDegradation = null;
  let synthesisDegradation = null;

  for (const event of events) {
    const task = event.metadata?.task;
    if (event.phase === "goal-formation" && isRecord(task?.goal)) {
      goal = projectGoal(task.goal);
    }
    if (event.phase === "clarification" && isRecord(task?.clarificationRequest)) {
      goal = projectClarification(task.clarificationRequest);
    }
    if (event.phase === "task-planning" && isRecord(task?.plan)) {
      plan = projectPlan(task.plan);
      planningFallback = projectPlanningFallback(task?.planningFallback);
    }
    if (event.phase === "plan-validation" && isRecord(task?.validation)) {
      validation = projectValidation(task.validation);
    }
    if (event.phase === "execution-facts" && isRecord(task?.executionFacts)) {
      executionFacts = projectExecutionFacts(task.executionFacts);
    }
    if (event.phase === "final-synthesis" && event.metadata?.degraded === true) {
      synthesisDegradation = projectSynthesisDegradation(event, synthesisDegradation);
    }
    if (event.phase === "final-synthesis" && typeof event.summary === "string") {
      response = event.summary;
    }
    if (isPlanningUnavailableEvent(event)) {
      planningDegradation = projectPlanningDegradation(event);
    }
  }

  const degradation = planningDegradation
    || (executionFacts?.degraded ? projectExecutionDegradation(executionFacts) : null)
    || synthesisDegradation;

  return deepFreeze({
    visibility: {
      cabinAssistant: events.some((event) => event.component === "cabinAssistant"),
      orchestrator: events.some((event) => event.component === "orchestrator"),
    },
    goal,
    plan,
    validation,
    executionFacts,
    planningFallback,
    degradation,
    response,
  });
}

function projectGoal(value) {
  return {
    objective: optionalString(value.objective),
    domain: optionalString(value.domain),
    interactionType: optionalString(value.interactionType),
    constraints: stringList(value.constraints),
    requiredClarifications: stringList(value.requiredClarifications),
    readyForPlanning: value.readyForPlanning === true,
  };
}

function projectClarification(value) {
  return {
    objective: null,
    domain: null,
    interactionType: "clarification",
    constraints: [],
    requiredClarifications: stringList(value.questions),
    readyForPlanning: false,
  };
}

function projectPlan(value) {
  return {
    planId: optionalString(value.planId),
    selectedCapabilities: stringList(value.selectedCapabilities),
    steps: (Array.isArray(value.steps) ? value.steps : [])
      .filter(isRecord)
      .map((step) => ({
        stepId: optionalString(step.stepId),
        capabilityId: optionalString(step.capabilityId),
        dependsOn: stringList(step.dependsOn),
        accessMode: optionalString(step.accessMode),
        status: optionalString(step.status),
      })),
    planningSummary: optionalString(value.planningSummary),
  };
}

function projectValidation(value) {
  const reasons = Array.isArray(value.reasonCodes)
    ? value.reasonCodes
    : Array.isArray(value.errors) ? value.errors : [];
  return {
    ok: value.ok === true,
    reasonCodes: stringList(reasons),
  };
}

function projectPlanningFallback(value) {
  const reasonCodes = new Set([
    "model-timeout",
    "model-unavailable",
    "plan-invalid",
    "knowledge-delegation-missing",
  ]);
  if (!isRecord(value)
    || value.source !== "deterministic-knowledge-delegation-fallback"
    || !reasonCodes.has(value.reasonCode)
    || value.degraded !== true) {
    return null;
  }
  return {
    source: value.source,
    reasonCode: value.reasonCode,
    degraded: true,
    label: "受约束兜底委派",
  };
}

function projectExecutionFacts(value) {
  return {
    completionStatus: optionalString(value.completionStatus),
    degraded: value.degraded === true,
    failureReason: optionalString(value.failureReason) || "",
    stepResults: (Array.isArray(value.stepResults) ? value.stepResults : [])
      .filter(isRecord)
      .map((step) => ({
        stepId: optionalString(step.stepId),
        capabilityId: optionalString(step.capabilityId),
        status: optionalString(step.status),
        ...(optionalString(step.failureReason)
          ? { failureReason: optionalString(step.failureReason) }
          : {}),
      })),
    evidenceRefs: (Array.isArray(value.evidenceRefs) ? value.evidenceRefs : [])
      .filter(isRecord)
      .map((reference) => projectStringRecord(reference, [
        "id", "source", "type", "title", "citation", "snapshotId",
      ])),
    safetySummary: isRecord(value.safetyDecision)
      ? projectSafetySummary(value.safetyDecision)
      : null,
    confirmedSnapshotId: optionalString(value.toolResult?.confirmedSnapshotId)
      || optionalString(value.confirmedVehicleState?.id),
  };
}

function projectSafetySummary(value) {
  const snapshotId = optionalString(value.snapshotId)
    || optionalString(value.vehicleStateSnapshotId);
  return {
    ...(typeof value.allowed === "boolean" ? { allowed: value.allowed } : {}),
    ...projectStringRecord(value, [
      "action", "reason", "alternative", "reasonCode", "policyId",
    ]),
    ...(snapshotId ? { snapshotId } : {}),
  };
}

function isPlanningUnavailableEvent(event) {
  return ["goal-formation", "task-planning"].includes(event.phase)
    && event.status === "unavailable";
}

function projectPlanningDegradation(event) {
  return {
    status: "unavailable",
    reasonCode: optionalString(event?.metadata?.reasonCode) || "agent-planning-unavailable",
    summary: "Agent planning unavailable",
  };
}

function projectExecutionDegradation(executionFacts) {
  return {
    status: "execution-degraded",
    reasonCode: executionFacts.failureReason || "execution-incomplete",
    summary: "Execution degraded",
  };
}

function projectSynthesisDegradation(event, previous) {
  return {
    status: "synthesis-degraded",
    reasonCode: optionalString(event?.metadata?.reasonCode)
      || optionalString(previous?.reasonCode)
      || "final-synthesis-degraded",
    summary: "Final synthesis degraded",
  };
}

function projectStringRecord(value, fields) {
  return Object.fromEntries(fields
    .filter((field) => optionalString(value?.[field]))
    .map((field) => [field, optionalString(value[field])]));
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }
  return value;
}

export function buildRunEventDebugSnapshot(run) {
  if (!run) return null;
  const viewModel = buildRunEventViewModel(run);
  return Object.freeze({
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    eventCount: viewModel.logItems.length,
    events: projectDebugLogItems(viewModel.logItems),
    components: projectDebugComponents(viewModel.components),
    terminalStatus: viewModel.terminalStatus,
  });
}

export function buildInteractionSessionDebugSnapshot(snapshot) {
  const projectTurn = (turn) => turn ? Object.freeze({
    sessionId: optionalString(turn.sessionId),
    turnId: optionalString(turn.turnId),
    runId: optionalString(turn.runId),
    trigger: optionalString(turn.trigger),
    relation: optionalString(turn.relation),
    deadlineAt: optionalString(turn.deadlineAt),
    relatedRunIds: Object.freeze(stringList(turn.relatedRunIds)),
    relatedRunEventIds: Object.freeze(stringList(turn.relatedRunEventIds)),
  }) : null;
  const session = snapshot?.currentSession || snapshot?.previousSession || null;
  const interactionEvents = Object.freeze((session?.events || []).map((event) => Object.freeze({
    interactionEventId: optionalString(event.interactionEventId),
    sessionId: optionalString(event.sessionId),
    turnId: optionalString(event.turnId),
    runId: optionalString(event.runId),
    sequence: Number.isFinite(event.sequence) ? event.sequence : null,
    timestamp: optionalString(event.timestamp),
    participantId: optionalString(event.participantId),
    phase: optionalString(event.phase),
    status: optionalString(event.status),
    reasonCode: optionalString(event.reasonCode),
    relatedRunIds: Object.freeze(stringList(event.relatedRunIds)),
    relatedRunEventIds: Object.freeze(stringList(event.relatedRunEventIds)),
    simulated: event.simulated === true,
  })));
  const relatedRunIds = Object.freeze([...new Set([
    ...stringList(snapshot?.activeTurn?.relatedRunIds),
    ...stringList(snapshot?.pendingReplacementTurn?.relatedRunIds),
    ...interactionEvents.flatMap((event) => event.relatedRunIds),
  ])]);
  return Object.freeze({
    interactionSession: Object.freeze({
      state: optionalString(snapshot?.state) || "dormant",
      sessionId: optionalString(snapshot?.sessionId),
      followUpDeadlineAt: Number.isFinite(snapshot?.followUpDeadlineAt)
        ? new Date(snapshot.followUpDeadlineAt).toISOString()
        : null,
    }),
    currentTurn: projectTurn(snapshot?.activeTurn),
    queuedTurn: projectTurn(snapshot?.pendingReplacementTurn),
    interactionEvents,
    relatedRunIds,
  });
}

export function buildRuntimeResultDebugSnapshot(result, { events = [] } = {}) {
  if (!result) return null;
  const snapshot = {};
  for (const field of RUNTIME_RESULT_DEBUG_FIELDS) {
    if (!Object.hasOwn(result, field)) continue;
    const projected = projectRuntimeResultDebugField(field, result[field]);
    if (projected !== undefined) snapshot[field] = projected;
  }
  snapshot.events = projectDebugLogItems(events);
  return Object.freeze(snapshot);
}

function projectRuntimeResultDebugField(field, value) {
  if (field === "manualEvidence") return cloneManualEvidence(value);
  if (field === "semanticEnvelope") return projectVehicleSluEnvelopeDebug(value);
  if (field === "cloudResult" || field === "conversationResult") {
    return projectModelAdapterResultDebug(value);
  }
  if (field === "executionDisabled") return value === true;
  if (field === "interactionRef") {
    if (value === null) return null;
    if (!isRecord(value)) return undefined;
    return Object.freeze({
      sessionId: optionalString(value.sessionId),
      turnId: optionalString(value.turnId),
    });
  }
  if (RUNTIME_RESULT_TEXT_FIELDS.has(field)) {
    return value === null ? null : optionalString(value);
  }
  const contract = RUNTIME_RESULT_STRUCTURED_CONTRACTS[field];
  if (!contract) return undefined;
  return projectRuntimeDebugSchema(value, contract);
}

function projectModelAdapterResultDebug(value) {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const projected = {};
  for (const field of ["model", "provider", "summary", "status", "reasonCode"]) {
    const text = optionalString(value[field]);
    if (text !== null) projected[field] = text;
  }
  if (typeof value.degraded === "boolean") projected.degraded = value.degraded;
  if (isRecord(value.telemetry)) projected.telemetry = projectModelAdapterTelemetryDebug(value.telemetry);
  if (isRecord(value.weatherLocationClarification)) {
    projected.weatherLocationClarification = projectRuntimeDebugSchema(
      value.weatherLocationClarification,
      Object.freeze({
        policy: RUNTIME_DEBUG_SCALAR,
        code: RUNTIME_DEBUG_SCALAR,
        requestedName: RUNTIME_DEBUG_SCALAR,
        reference: RUNTIME_DEBUG_SCALAR,
        clarification: RUNTIME_DEBUG_SCALAR,
      }),
    );
  }
  return Object.freeze(projected);
}

function projectModelAdapterTelemetryDebug(value) {
  const projected = {};
  for (const field of [
    "provider", "model", "promptStyle", "promptVersion", "status", "reasonCode",
    "fallbackReasonCode", "validationSubreason", "primaryFailureReasonCode",
    "providerFailureReasonCode",
  ]) {
    const text = optionalString(value[field]);
    if (text !== null) projected[field] = text;
  }
  for (const field of [
    "durationMs", "promptChars", "queryChars", "answerChars", "outputChars", "textChars",
    "eval_count", "eval_duration_ms", "prompt_eval_count", "prompt_eval_duration_ms",
    "externalModelRequestCount",
  ]) {
    if (Number.isFinite(value[field])) projected[field] = value[field];
  }
  if (typeof value.degraded === "boolean") projected.degraded = value.degraded;
  for (const field of ["fallbackActive", "fallbackAttempted"]) {
    if (typeof value[field] === "boolean") projected[field] = value[field];
  }
  if (isRecord(value.ollamaDurations)) {
    projected.ollamaDurations = projectRuntimeDebugSchema(
      value.ollamaDurations,
      Object.freeze({
        total_duration_ms: RUNTIME_DEBUG_SCALAR,
        load_duration_ms: RUNTIME_DEBUG_SCALAR,
        eval_count: RUNTIME_DEBUG_SCALAR,
        eval_duration_ms: RUNTIME_DEBUG_SCALAR,
        prompt_eval_count: RUNTIME_DEBUG_SCALAR,
        prompt_eval_duration_ms: RUNTIME_DEBUG_SCALAR,
      }),
    );
  }
  if (isRecord(value.weatherLocationClarification)) {
    projected.weatherLocationClarification = projectRuntimeDebugSchema(
      value.weatherLocationClarification,
      Object.freeze({
        policy: RUNTIME_DEBUG_SCALAR,
        code: RUNTIME_DEBUG_SCALAR,
        requestedName: RUNTIME_DEBUG_SCALAR,
        reference: RUNTIME_DEBUG_SCALAR,
        clarification: RUNTIME_DEBUG_SCALAR,
      }),
    );
  }
  return Object.freeze(projected);
}

export function buildHmiRunDebugSnapshot(run, { events = [] } = {}) {
  if (!run) return null;
  const result = buildRuntimeResultDebugSnapshot(run.result, { events });
  return Object.freeze({
    requestId: result?.requestId || run.requestId || null,
    result,
    events: projectDebugLogItems(events),
    error: run.error ? "Runtime execution failed" : "",
    startedAt: run.startedAt || null,
    endedAt: run.endedAt || null,
    startedAtPerf: Number.isFinite(run.startedAtPerf) ? run.startedAtPerf : null,
    endedAtPerf: Number.isFinite(run.endedAtPerf) ? run.endedAtPerf : null,
    ttsTelemetry: cloneAllowlisted(run.ttsTelemetry),
  });
}

export function buildRunDetailViewModel(run, {
  mode = "live",
  eventViewModel = null,
} = {}) {
  if (!run) return null;
  const timelineItems = Object.freeze([
    ...(Array.isArray(eventViewModel?.timelineItems) ? eventViewModel.timelineItems : []),
  ]);
  if (mode === "replay") {
    return Object.freeze({
      mode: "replay",
      userInput: null,
      result: null,
      ttsTelemetry: null,
      runtimeError: "",
      timelineItems,
      b2: eventViewModel?.b2 || buildB2Projection([]),
      b3: eventViewModel?.b3 || buildB3Projection([]),
      semanticDecision: eventViewModel?.semanticDecision || null,
      llmInput: Object.freeze({}),
      weatherLocationClarification: null,
      privacyNotice: "回放仅展示当前游标之前的 Run Event 参与者、日志与时间线；出于隐私和因果一致性，最终 Live 的 Safety、Tool、LLM 与确认详情均不在回放中显示。",
    });
  }

  const resultSource = run.result || (run.vehicleStateSnapshot ? {
    requestId: run.requestId,
    vehicleStateSnapshot: run.vehicleStateSnapshot,
  } : null);
  const safeRun = buildHmiRunDebugSnapshot({
    ...run,
    result: resultSource,
  }, {
    events: eventViewModel?.logItems || [],
  });
  const result = safeRun?.result || Object.freeze({});
  return Object.freeze({
    mode: "live",
    userInput: String(run.input || ""),
    result,
    ttsTelemetry: safeRun?.ttsTelemetry || null,
    runtimeError: safeRun?.error || "",
    startedAtPerf: safeRun?.startedAtPerf ?? null,
    endedAtPerf: safeRun?.endedAtPerf ?? null,
    timelineItems,
    b2: eventViewModel?.b2 || buildB2Projection([]),
    b3: eventViewModel?.b3 || buildB3Projection([]),
    semanticDecision: eventViewModel?.semanticDecision || null,
    llmInput: buildLlmInputProjection(result.cloudResult),
    weatherLocationClarification: buildWeatherLocationClarificationProjection(run.result),
    privacyNotice: "",
  });
}

const HMI_RUN_DEBUG_FACADE_FIELDS = Object.freeze([
  "requestId",
  "result",
  "events",
  "error",
  "startedAt",
  "endedAt",
  "startedAtPerf",
  "endedAtPerf",
  "ttsTelemetry",
]);

export function createStableHmiRunDebugFacade(initialProjection) {
  let currentProjection = initialProjection;
  const facade = {};
  for (const field of HMI_RUN_DEBUG_FACADE_FIELDS) {
    Object.defineProperty(facade, field, {
      enumerable: true,
      get: () => currentProjection?.[field] ?? null,
    });
  }
  Object.freeze(facade);
  return Object.freeze({
    facade,
    update(nextProjection) {
      currentProjection = nextProjection;
      return facade;
    },
  });
}

export function buildPendingConfirmationDebugSnapshot(pendingConfirmation) {
  if (!pendingConfirmation) return null;
  return Object.freeze({
    runId: optionalString(pendingConfirmation.runId),
    intent: cloneAllowlisted(pendingConfirmation.intent),
    action: cloneAllowlisted(pendingConfirmation.action),
    reason: cloneAllowlisted(pendingConfirmation.reason),
    alternative: cloneAllowlisted(pendingConfirmation.alternative),
    challenge: cloneAllowlisted(pendingConfirmation.challenge),
  });
}

export function buildPendingConfirmationViewModel(pendingConfirmation) {
  if (!pendingConfirmation) return null;
  const challenge = pendingConfirmation.challenge;
  const assertions = Array.isArray(challenge?.assertions)
    ? challenge.assertions.map((assertion) => Object.freeze({
      id: String(assertion?.id || ""),
      prompt: String(assertion?.prompt || ""),
    }))
    : [];
  return Object.freeze({
    input: String(pendingConfirmation.input || ""),
    intent: String(pendingConfirmation.intent || ""),
    action: String(pendingConfirmation.action || ""),
    reason: String(pendingConfirmation.reason || ""),
    alternative: String(pendingConfirmation.alternative || ""),
    challenge: challenge ? Object.freeze({
      id: String(challenge.id || ""),
      requestId: String(challenge.requestId || ""),
      actionDigest: String(challenge.actionDigest || ""),
      policyId: String(challenge.policyId || ""),
      assertions: Object.freeze(assertions),
    }) : null,
  });
}

export function createSafeRunEventProjectionListener(project, onError = () => {}) {
  if (typeof project !== "function") throw new TypeError("project must be a function");
  if (typeof onError !== "function") throw new TypeError("onError must be a function");
  return (run) => {
    try {
      project(run);
    } catch (error) {
      try {
        onError(error);
      } catch {
        // Ledger listeners must never affect Runtime execution.
      }
    }
  };
}

function createLogItem(event, startedAtMs) {
  const component = requireParticipant(event.component);
  const observedAt = event.timestamp ?? null;
  const item = {
    eventId: event.eventId,
    parentEventId: event.parentEventId ?? null,
    sequence: event.sequence,
    timestamp: event.timestamp,
    component: component.id,
    componentLabel: component.label,
    componentType: component.type,
    phase: event.phase,
    status: event.status,
    summary: event.summary,
    refs: Object.freeze([...event.refs]),
    simulated: event.metadata?.simulated === true,
    observedAt,
    observedMs: Math.max(0, (parseTimestamp(observedAt) ?? startedAtMs) - startedAtMs),
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
    model: typeof event.model === "string" && event.model.trim() ? event.model : null,
    provider: typeof event.provider === "string" && event.provider.trim() ? event.provider : null,
    degraded: event.metadata?.degraded === true,
    reasonCode: optionalString(event.metadata?.reasonCode),
  };
  if (event.phase === "developer-scenario") {
    item.scenarioAudit = projectDeveloperScenarioAudit(event.metadata?.developerScenario);
  }
  return Object.freeze(item);
}

function projectDebugLogItems(items) {
  return Object.freeze((Array.isArray(items) ? items : []).map((item) => {
    const projected = {};
    for (const field of DEBUG_LOG_ITEM_FIELDS) {
      if (Object.hasOwn(item, field)) projected[field] = cloneAllowlisted(item[field]);
    }
    return Object.freeze(projected);
  }));
}

function projectDebugComponents(components) {
  return Object.freeze((Array.isArray(components) ? components : []).map((component) => {
    const projected = {};
    for (const field of DEBUG_COMPONENT_FIELDS) {
      if (Object.hasOwn(component, field)) projected[field] = cloneAllowlisted(component[field]);
    }
    return Object.freeze(projected);
  }));
}

function cloneManualEvidence(manualEvidence) {
  const projection = projectRuntimeDebugSchema(manualEvidence, RUNTIME_MANUAL_EVIDENCE_SCHEMA);
  if (!manualEvidence || typeof manualEvidence !== "object") return projection;
  return Object.freeze({
    ...projection,
    queryChars: typeof manualEvidence.query === "string" ? manualEvidence.query.length : 0,
  });
}

function projectVehicleSluEnvelopeDebug(value) {
  if (!isRecord(value)) return null;
  return deepFreeze({
    contractVersion: typeof value.contractVersion === "string" ? value.contractVersion : null,
    requestId: typeof value.requestId === "string" ? value.requestId : null,
    domain: typeof value.domain === "string" ? value.domain : null,
    conversationGoal: {
      summary: typeof value.conversationGoal?.summary === "string" ? value.conversationGoal.summary : "",
      need: optionalString(value.conversationGoal?.need),
    },
    domainConfidence: Number.isFinite(value.domainConfidence) ? value.domainConfidence : null,
    vehicleFrames: (Array.isArray(value.vehicleFrames) ? value.vehicleFrames : [])
      .filter(isRecord)
      .map((frame) => ({
        frameId: typeof frame.frameId === "string" ? frame.frameId : null,
        capability: typeof frame.capability === "string" ? frame.capability : null,
        intent: typeof frame.intent === "string" ? frame.intent : null,
        speechAct: optionalString(frame.speechAct),
        knowledgeNeed: optionalString(frame.knowledgeNeed),
        actionNeed: optionalString(frame.actionNeed),
        slots: projectVehicleSluSlots(frame.intent, frame.slots),
        missingSlots: projectVehicleSluSlotNames(frame.intent, frame.missingSlots),
        clarificationQuestion: frame.actionNeed === "clarify"
          ? optionalString(frame.clarificationQuestion)
          : null,
        standaloneQuery: frame.knowledgeNeed === "manual"
          ? optionalString(frame.standaloneQuery)
          : null,
        confidence: Number.isFinite(frame.confidence) ? frame.confidence : null,
      })),
  });
}

function projectVehicleSluSlots(intent, slots) {
  if (!isRecord(slots)) return {};
  const allowed = VEHICLE_SLU_SLOT_SCHEMAS[intent]?.allowed || [];
  return Object.fromEntries(allowed.flatMap((field) => {
    if (!Object.hasOwn(slots, field)) return [];
    const projected = projectVehicleSluSlotValue(field, slots[field]);
    return projected === undefined ? [] : [[field, projected]];
  }));
}

function projectVehicleSluSlotNames(intent, names) {
  if (!Array.isArray(names)) return [];
  const allowed = new Set(VEHICLE_SLU_SLOT_SCHEMAS[intent]?.allowed || []);
  return [...new Set(names.filter((name) => typeof name === "string" && allowed.has(name)))];
}

function projectVehicleSluSlotValue(field, value) {
  const type = VEHICLE_SLU_SLOT_TYPES[field];
  if (type === "string") return typeof value === "string" ? value : undefined;
  if (type === "number") return Number.isFinite(value) ? value : undefined;
  if (type === "boolean") return typeof value === "boolean" ? value : undefined;
  if (type === "window-target-array") {
    return Array.isArray(value) && value.every((target) => isRecord(target)
      && typeof target.zone === "string"
      && Number.isFinite(target.percent)
      && ["front_left", "front_right", "rear_left", "rear_right"].includes(target.zone))
      ? value.map(({ zone, percent }) => ({ zone, percent }))
      : undefined;
  }
  if (type === "state-field-array") {
    return Array.isArray(value)
      && value.every((entry) => typeof entry === "string" && VEHICLE_STATE_FIELD_SET.has(entry))
      && new Set(value).size === value.length
      ? [...value]
      : undefined;
  }
  return undefined;
}

function buildSemanticDecisionProjection(events) {
  const routeEvent = [...events].reverse().find((event) => (
    event.phase === "route-decision" && isRecord(event.metadata?.routing?.semanticSummary)
  ));
  if (!routeEvent) return null;
  const summary = routeEvent.metadata.routing.semanticSummary;
  return deepFreeze({
    semanticSummary: {
      contractVersion: optionalString(summary.contractVersion),
      requestId: optionalString(summary.requestId),
      domain: optionalString(summary.domain),
      conversationGoal: {
        summary: typeof summary.conversationGoal?.summary === "string"
          ? summary.conversationGoal.summary
          : "",
        need: optionalString(summary.conversationGoal?.need),
      },
      domainConfidence: Number.isFinite(summary.domainConfidence) ? summary.domainConfidence : null,
      vehicleFrames: (Array.isArray(summary.vehicleFrames) ? summary.vehicleFrames : [])
        .filter(isRecord)
        .map((frame) => ({
          frameId: optionalString(frame.frameId),
          capability: optionalString(frame.capability),
          intent: optionalString(frame.intent),
          speechAct: optionalString(frame.speechAct),
          knowledgeNeed: optionalString(frame.knowledgeNeed),
          actionNeed: optionalString(frame.actionNeed),
          missingSlots: projectVehicleSluSlotNames(frame.intent, frame.missingSlots),
          clarificationQuestion: frame.actionNeed === "clarify"
            ? optionalString(frame.clarificationQuestion)
            : null,
          standaloneQuery: frame.knowledgeNeed === "manual"
            ? optionalString(frame.standaloneQuery)
            : null,
          confidence: Number.isFinite(frame.confidence) ? frame.confidence : null,
          slotNames: projectVehicleSluSlotNames(frame.intent, frame.slotNames),
        })),
    },
    contractValidation: projectSemanticValidationStatus(routeEvent.metadata.routing.validation?.contract),
    capabilityValidation: projectSemanticValidationStatus(routeEvent.metadata.routing.validation?.capability),
    slotValidation: projectSemanticValidationStatus(routeEvent.metadata.routing.validation?.slot),
    provider: optionalString(routeEvent.provider),
    model: optionalString(routeEvent.model),
    durationMs: Number.isFinite(routeEvent.durationMs) ? routeEvent.durationMs : null,
    promptVersion: optionalString(routeEvent.metadata?.modelTelemetry?.revision),
  });
}

function projectSemanticValidationStatus(value) {
  return Object.freeze({ ok: value?.ok === true });
}

function projectDeveloperScenarioAudit(data) {
  const audit = {};
  for (const field of [
    "scenarioId",
    "source",
    "simulatorMode",
    "capturedAtMode",
    "stagedAt",
    "capturedAt",
  ]) {
    if (typeof data?.[field] === "string" && data[field]) audit[field] = data[field];
  }
  return Object.freeze(audit);
}

function buildLlmInputProjection(cloudResult) {
  if (!cloudResult || typeof cloudResult !== "object") return Object.freeze({});
  const telemetry = cloudResult.telemetry || {};
  return Object.freeze(Object.fromEntries([
    ["model", cloudResult.model],
    ["provider", telemetry.provider],
    ["promptChars", telemetry.promptChars],
    ["promptStyle", telemetry.promptStyle],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "")));
}

function buildWeatherLocationClarificationProjection(result) {
  const cloudResult = result?.cloudResult;
  const clarification = cloudResult?.weatherLocationClarification
    || cloudResult?.telemetry?.weatherLocationClarification
    || result?.weatherLocationClarification
    || result?.toolResult?.weatherLocationClarification;
  if (!clarification || typeof clarification !== "object") return null;
  const candidates = Array.isArray(clarification.candidates)
    ? clarification.candidates.slice(0, 5).map((candidate) => Object.freeze({
      city: String(candidate?.city || ""),
      admin1: String(candidate?.admin1 || ""),
      country: String(candidate?.country || ""),
      latitude: Number.isFinite(candidate?.latitude) ? candidate.latitude : null,
      longitude: Number.isFinite(candidate?.longitude) ? candidate.longitude : null,
    }))
    : [];
  return Object.freeze({
    policy: String(clarification.policy || ""),
    code: String(clarification.code || ""),
    requestedName: String(clarification.requestedName || ""),
    reference: String(clarification.reference || ""),
    clarification: String(clarification.clarification || ""),
    candidates: Object.freeze(candidates),
  });
}

function runtimeArraySchema(itemSchema) {
  return Object.freeze({ [RUNTIME_DEBUG_ARRAY_ITEM]: itemSchema });
}

function projectRuntimeDebugSchema(value, schema) {
  if (schema === RUNTIME_DEBUG_SCALAR) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    return Number.isFinite(value) ? value : undefined;
  }
  if (isRecord(schema) && Object.hasOwn(schema, RUNTIME_DEBUG_ARRAY_ITEM)) {
    if (!Array.isArray(value)) return undefined;
    return Object.freeze(value.flatMap((item) => {
      const projected = projectRuntimeDebugSchema(item, schema[RUNTIME_DEBUG_ARRAY_ITEM]);
      return projected === undefined ? [] : [projected];
    }));
  }
  if (!isRecord(schema) || !isRecord(value)) return value === null ? null : undefined;
  const projected = {};
  for (const [field, fieldSchema] of Object.entries(schema)) {
    if (!Object.hasOwn(value, field)) continue;
    const fieldValue = projectRuntimeDebugSchema(value[field], fieldSchema);
    if (fieldValue !== undefined) projected[field] = fieldValue;
  }
  return Object.freeze(projected);
}

function cloneAllowlisted(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAllowlisted));
  if (!value || typeof value !== "object") return value ?? null;
  return Object.freeze(Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => SAFE_DEBUG_STRUCTURED_FIELDS.has(key))
      .map(([key, item]) => [key, cloneAllowlisted(item)]),
  ));
}

function normalizeCursor(cursor, eventCount) {
  if (cursor == null) return eventCount;
  if (!Number.isFinite(cursor)) return eventCount;
  return Math.min(eventCount, Math.max(0, Math.floor(cursor)));
}

function parseTimestamp(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function createStableFingerprint(value) {
  const serialized = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
