import { VEHICLE_COMPONENT_BY_TOOL } from "../vehicle/vehicle-write-capabilities.js";

function profile(id, stage, code, retryable, sideEffectClass, target) {
  return Object.freeze({ id, stage, code, retryable, sideEffectClass, target });
}

export const BENCHMARK_FAULT_PROFILE = Object.freeze({
  "goal-formation-timeout": profile(
    "goal-formation-timeout",
    "goal-formation",
    "generation-timeout",
    true,
    "none",
    "structured-model",
  ),
  "task-planning-timeout": profile(
    "task-planning-timeout",
    "task-planning",
    "generation-timeout",
    true,
    "none",
    "structured-model",
  ),
  "vehicle-knowledge-rag-unavailable": profile(
    "vehicle-knowledge-rag-unavailable",
    "vehicle-knowledge-rag",
    "rag-unavailable",
    true,
    "readonly",
    "manual-rag",
  ),
  "weather-timeout": profile(
    "weather-timeout",
    "weather-adapter",
    "weather-timeout",
    true,
    "readonly",
    "weather-adapter",
  ),
  "vehicle-confirmation-timeout": profile(
    "vehicle-confirmation-timeout",
    "sensor-confirmation",
    "sensor-timeout",
    true,
    "write-observation",
    "demo-sensor-submission",
  ),
});

export function resolveBenchmarkFaultProfile(input, { enabled } = {}) {
  if (enabled !== true) throw new Error("benchmark faults are disabled");
  const id = typeof input === "string" ? input.trim() : "";
  const selected = BENCHMARK_FAULT_PROFILE[id];
  if (!selected) throw new Error(`unknown benchmark fault: ${id || "<missing>"}`);
  return selected;
}

export function verifyBenchmarkFaultReceipt(input, expectedProfile) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !expectedProfile || typeof expectedProfile !== "object") return null;
  const faultId = input.benchmarkFaultId ?? input.faultId;
  if (faultId !== expectedProfile.id
    || input.stage !== expectedProfile.stage
    || input.target !== expectedProfile.target
    || input.code !== expectedProfile.code
    || input.retryable !== expectedProfile.retryable
    || input.simulated !== true) return null;
  return Object.freeze({
    faultId: expectedProfile.id,
    stage: expectedProfile.stage,
    target: expectedProfile.target,
    code: expectedProfile.code,
    retryable: expectedProfile.retryable,
    simulated: true,
  });
}

function nonnegativeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function sensorSubmissionMarker({
  settled = false,
  resultType = null,
  commandId = null,
  component = null,
} = {}) {
  return Object.freeze({
    called: true,
    settled,
    resultType,
    commandId,
    component,
  });
}

export function observeBenchmarkSensorSubmission(state, submit) {
  const markers = state.sensorSubmissionMarkers;
  const markerIndex = markers.push(sensorSubmissionMarker()) - 1;
  let submission;
  try {
    submission = submit();
  } catch (error) {
    throw error;
  }
  return Promise.resolve(submission).then((result) => {
    markers[markerIndex] = sensorSubmissionMarker({
      settled: true,
      resultType: typeof result?.type === "string" ? result.type : null,
      commandId: typeof result?.commandId === "string" ? result.commandId : null,
      component: typeof result?.component === "string" ? result.component : null,
    });
    return result;
  });
}

export function captureBenchmarkSensorSubmissionMarkers(state) {
  return Object.freeze((state.sensorSubmissionMarkers || []).map((marker) => Object.freeze({
    called: marker?.called === true,
    settled: marker?.settled === true,
    resultType: typeof marker?.resultType === "string" ? marker.resultType : null,
    commandId: typeof marker?.commandId === "string" ? marker.commandId : null,
    component: typeof marker?.component === "string" ? marker.component : null,
  })));
}

export function observeBenchmarkCoordinatorSettlement(state, execute) {
  const captureTerminalMarkers = () => {
    state.terminalSensorSubmissionMarkers = captureBenchmarkSensorSubmissionMarkers(state);
  };
  let execution;
  try {
    execution = execute();
  } catch (error) {
    captureTerminalMarkers();
    throw error;
  }
  return Promise.resolve(execution).then(
    (result) => {
      captureTerminalMarkers();
      return result;
    },
    (error) => {
      captureTerminalMarkers();
      throw error;
    },
  );
}

export function buildBenchmarkVehicleFaultReceipt({
  profile,
  result = {},
  sensorSubmissionMarkers = [],
} = {}) {
  if (profile?.target !== "demo-sensor-submission"
    || !Array.isArray(sensorSubmissionMarkers)
    || sensorSubmissionMarkers.length !== 1) return null;
  const marker = sensorSubmissionMarkers[0];
  const terminal = result?.toolResult;
  const executionError = terminal?.executionError;
  if (marker?.called !== true
    || marker.settled !== true
    || marker.resultType !== "timeout"
    || marker.commandId !== terminal?.commandId
    || marker.component !== VEHICLE_COMPONENT_BY_TOOL[terminal?.tool]
    || terminal?.executionState !== "timeout"
    || terminal?.simulated !== true
    || executionError?.stage !== "sensor-confirmation"
    || executionError?.code !== "sensor-timeout") return null;
  return verifyBenchmarkFaultReceipt({
    benchmarkFaultId: profile.id,
    stage: executionError.stage,
    target: profile.target,
    code: executionError.code,
    retryable: executionError.retryable,
    simulated: terminal.simulated,
  }, profile);
}

export function projectBenchmarkVehicleEvidence({
  result = {},
  counts = {},
  confirmedAnimationCount = 0,
  sensorSubmissionMarkers = null,
} = {}) {
  const submissionCount = Array.isArray(sensorSubmissionMarkers)
    ? sensorSubmissionMarkers.length
    : nonnegativeCount(counts.sensorSubmissionCount);
  const providerCallCount = nonnegativeCount(counts.providerCallCount);
  const acceptedCount = nonnegativeCount(counts.providerAcceptedCount);
  const stateChangeCount = nonnegativeCount(counts.providerStateChangeCount);
  const providerConfirmationCount = providerCallCount !== null
    && acceptedCount !== null
    && acceptedCount <= providerCallCount
    ? acceptedCount
    : null;
  const confirmedStatePatchCount = providerConfirmationCount !== null
    && stateChangeCount !== null
    && stateChangeCount <= providerConfirmationCount
    ? stateChangeCount
    : null;
  return Object.freeze({
    submissionCount,
    timeoutTerminal: result?.toolResult?.executionState === "timeout"
      && result?.toolResult?.executionError?.stage === "sensor-confirmation"
      && result?.toolResult?.executionError?.code === "sensor-timeout",
    automaticWriteRetries: submissionCount === null ? null : Math.max(0, submissionCount - 1),
    providerConfirmationCount,
    confirmedStatePatchCount,
    confirmedAnimationCount: nonnegativeCount(confirmedAnimationCount),
  });
}

export function resetBenchmarkRunEvidenceState(state, resetModelReceipt) {
  state.manualRagReceipt = null;
  state.confirmedAnimationCount = 0;
  state.runtimeResult = null;
  state.runId = null;
  state.sensorSubmissionMarkers = [];
  state.terminalSensorSubmissionMarkers = [];
  if (typeof resetModelReceipt === "function") resetModelReceipt();
  return state;
}
