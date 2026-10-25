import {
  BENCHMARK_FAULT_PROFILE,
  verifyBenchmarkFaultReceipt,
} from "./benchmark-fault-profile.js";
import { B4_BENCHMARK_SCENARIOS } from "./run-benchmark-scenarios.js";
import {
  RUN_EVENT_PHASES,
  RUN_EVENT_STATUSES,
} from "../runtime/run-event-protocol.js";
import { getParticipant } from "../runtime/participant-registry.js";
import { VEHICLE_EXECUTION_STATES } from "../vehicle/execution-state-contract.js";

export const BENCHMARK_SAMPLE_OUTCOMES = Object.freeze([
  "passed", "run-degraded", "run-failed", "contract-failed",
]);

export const BENCHMARK_RESULT_CATEGORIES = Object.freeze([...new Set(
  Object.values(B4_BENCHMARK_SCENARIOS).map((scenario) => scenario.expected.resultCategory),
)]);

export const B4_FAULT_SAMPLE_PLAN = Object.freeze([
  Object.freeze({
    sampleKey: "conversation-general:1",
    scenarioId: "conversation-general",
    repeat: 1,
    faultId: "goal-formation-timeout",
  }),
  Object.freeze({
    sampleKey: "conversation-general:2",
    scenarioId: "conversation-general",
    repeat: 2,
    faultId: "task-planning-timeout",
  }),
  Object.freeze({
    sampleKey: "vehicle-knowledge:1",
    scenarioId: "vehicle-knowledge",
    repeat: 1,
    faultId: "vehicle-knowledge-rag-unavailable",
  }),
  Object.freeze({
    sampleKey: "weather-readonly:1",
    scenarioId: "weather-readonly",
    repeat: 1,
    faultId: "weather-timeout",
  }),
  Object.freeze({
    sampleKey: "vehicle-control-safe:1",
    scenarioId: "vehicle-control-safe",
    repeat: 1,
    faultId: "vehicle-confirmation-timeout",
  }),
]);

const RAW_SAMPLE_KEYS = Object.freeze([
  "sampleId", "sampleKey", "runId", "scenarioId", "repeat", "timestamps",
  "projectedMetrics", "eventRefs", "simulated", "diagnostics",
]);
const FINAL_SAMPLE_KEYS = Object.freeze([
  "sampleId", "runId", "scenarioId", "repeat", "outcome", "timestamps", "metrics",
  "result", "eventRefs", "simulated", "diagnostics", "projectedMetrics",
]);
const TIMESTAMP_KEYS = Object.freeze(["startedAt", "completedAt"]);
const PROJECTED_METRIC_KEYS = Object.freeze([
  "outcome", "contractErrors", "eventSequenceErrors", "budgetErrors", "durationMs", "modelRequests",
  "modelCallCount", "submissionToFirstFeedbackMs", "submissionToResultVisibleMs", "phases", "slowestPhase", "animation",
  "voice", "behavior",
]);
const BEHAVIOR_KEYS = Object.freeze([
  "resultCategory", "dispatchAuthorized", "adapterExecutions", "vehicleToolCalls",
  "vehicleWrites", "safetyWriteDecisions", "providerConfirmation", "unsafeProviderExecution",
  "executionFactsComplete",
]);
const DIAGNOSTIC_CODES = new Set([
  "none", "run-degraded", "run-failed", "contract-failed",
  "voice-playback-observation-failed", "browser-fallback-not-gpt-sovits",
  "gpt-sovits-playback-blocked",
]);
const FAULT_RECEIPT_KEYS = Object.freeze([
  "faultId", "stage", "target", "code", "retryable", "simulated",
]);
const PUBLIC_EVIDENCE_KEYS = Object.freeze([
  "runId", "resultVisibleRunId", "firstFeedbackObserved", "resultVisible",
  "observedModelRequestCount", "observedExternalModelRequestCount", "instrumentation",
  "visibleCardKinds", "interactionRunIds", "counters", "events", "result",
  "animationConfirmed", "animationCommandId",
]);
const INSTRUMENTATION_KEYS = Object.freeze([
  "modelRequestCount", "externalModelRequestCount", "safetyCallCount", "toolCallCount",
  "adapterAcceptedCount", "providerCallCount", "providerAcceptedCount",
  "providerStateChangeCount", "complete",
]);
const EXECUTION_COUNTER_KEYS = Object.freeze([
  "safetyCallCount", "toolCallCount", "adapterAcceptedCount", "providerCallCount",
  "providerAcceptedCount", "providerStateChangeCount",
]);
const EXECUTION_FACT_COUNTER_KEYS = Object.freeze([
  "toolCallCount", "adapterAcceptedCount", "providerCallCount",
  "providerAcceptedCount", "providerStateChangeCount",
]);
const PUBLIC_EVENT_KEYS = Object.freeze([
  "eventId", "parentEventId", "sequence", "component", "componentType", "phase", "status",
  "refs", "reasonCode", "durationMs",
]);
const PUBLIC_RESULT_KEYS = Object.freeze([
  "safetyAllowed", "toolCallPresent", "toolResultPresent", "executionState", "toolCommandId",
  "resultCommandId", "snapshotId", "confirmedSnapshotId", "snapshotCapturedAt", "executionTrace",
]);
const EXECUTION_TRACE_KEYS = Object.freeze(["state", "at", "source"]);
const PUBLIC_REASON_CODE_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const SENSITIVE_REASON_CODE_PATTERN = /secret|token|api[-_]?key|authorization|bearer|prompt|raw[-_]?response/;

export function isPublicBenchmarkReasonCode(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 80
    && PUBLIC_REASON_CODE_PATTERN.test(value)
    && !SENSITIVE_REASON_CODE_PATTERN.test(value);
}

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) {
    fail(`${label} must contain exactly the allowed keys`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function isoTimestamp(value, label) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    fail(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function duration(value, label) {
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be a finite non-negative number`);
  return value;
}

function nullableDuration(value, label) {
  return value === null ? null : duration(value, label);
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}

function nullableCount(value, label) {
  return value === null ? null : count(value, label);
}

function boolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function nullableBoolean(value, label) {
  return value === null ? null : boolean(value, label);
}

function nullableString(value, label) {
  return value === null ? null : nonEmptyString(value, label);
}

function nullableReasonCode(value, label) {
  if (value === null) return null;
  const reasonCode = nonEmptyString(value, label);
  if (!isPublicBenchmarkReasonCode(reasonCode)) {
    fail(`${label} must be a bounded diagnostic code`);
  }
  return reasonCode;
}

function stringArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)
    || (nonEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    fail(`${label} must be ${nonEmpty ? "a non-empty " : "an "}array of non-empty strings`);
  }
  return value.map((entry) => entry);
}

function canonicalTimestamps(value) {
  exactKeys(value, TIMESTAMP_KEYS, "sample.timestamps");
  const startedAt = isoTimestamp(value.startedAt, "sample.timestamps.startedAt");
  const completedAt = isoTimestamp(value.completedAt, "sample.timestamps.completedAt");
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    fail("sample.timestamps.completedAt must not precede startedAt");
  }
  return { startedAt, completedAt };
}

function canonicalProjection(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "value") {
    return { value: duration(value.value, `${label}.value`) };
  }
  exactKeys(value, ["value", "reason"], label);
  if (value.value !== null) fail(`${label}.value must be null when a reason is present`);
  return { value: null, reason: nonEmptyString(value.reason, `${label}.reason`) };
}

function canonicalAnimation(value) {
  if (!isRecord(value)) fail("projectedMetrics.animation must be an object");
  if (Object.keys(value).length === 1 && Object.hasOwn(value, "value") && value.value === true) {
    return { value: true };
  }
  exactKeys(value, ["value", "reason"], "projectedMetrics.animation");
  if (value.value !== false && value.value !== null) {
    fail("projectedMetrics.animation.value must be true, false, or null");
  }
  return {
    value: value.value,
    reason: nonEmptyString(value.reason, "projectedMetrics.animation.reason"),
  };
}

function canonicalVoice(value) {
  if (value === null) return null;
  exactKeys(value, ["submissionToFirstAudibleMs", "submissionToCompletedMs"], "projectedMetrics.voice");
  return {
    submissionToFirstAudibleMs: nullableDuration(
      value.submissionToFirstAudibleMs,
      "projectedMetrics.voice.submissionToFirstAudibleMs",
    ),
    submissionToCompletedMs: nullableDuration(
      value.submissionToCompletedMs,
      "projectedMetrics.voice.submissionToCompletedMs",
    ),
  };
}

function canonicalBehavior(value) {
  exactKeys(value, BEHAVIOR_KEYS, "projectedMetrics.behavior");
  if (!BENCHMARK_RESULT_CATEGORIES.includes(value.resultCategory)) {
    fail("projectedMetrics.behavior.resultCategory must be supported");
  }
  if (value.safetyWriteDecisions !== 0 && value.safetyWriteDecisions !== 1) {
    fail("projectedMetrics.behavior.safetyWriteDecisions must be zero or one");
  }
  return {
    resultCategory: value.resultCategory,
    dispatchAuthorized: nullableBoolean(value.dispatchAuthorized, "projectedMetrics.behavior.dispatchAuthorized"),
    adapterExecutions: nullableCount(value.adapterExecutions, "projectedMetrics.behavior.adapterExecutions"),
    vehicleToolCalls: nullableCount(value.vehicleToolCalls, "projectedMetrics.behavior.vehicleToolCalls"),
    vehicleWrites: nullableCount(value.vehicleWrites, "projectedMetrics.behavior.vehicleWrites"),
    safetyWriteDecisions: value.safetyWriteDecisions,
    providerConfirmation: boolean(value.providerConfirmation, "projectedMetrics.behavior.providerConfirmation"),
    unsafeProviderExecution: boolean(value.unsafeProviderExecution, "projectedMetrics.behavior.unsafeProviderExecution"),
    executionFactsComplete: boolean(value.executionFactsComplete, "projectedMetrics.behavior.executionFactsComplete"),
  };
}

function canonicalProjectedMetrics(value, scenario) {
  exactKeys(value, PROJECTED_METRIC_KEYS, "sample.projectedMetrics");
  if (!BENCHMARK_SAMPLE_OUTCOMES.includes(value.outcome)) {
    fail("projectedMetrics.outcome must be supported");
  }
  const contractErrors = stringArray(value.contractErrors, "projectedMetrics.contractErrors");
  const eventSequenceErrors = stringArray(value.eventSequenceErrors, "projectedMetrics.eventSequenceErrors");
  const budgetErrors = stringArray(value.budgetErrors, "projectedMetrics.budgetErrors");
  if (value.outcome === "passed" && (contractErrors.length > 0 || eventSequenceErrors.length > 0 || budgetErrors.length > 0)) {
    fail("passed projectedMetrics must not contain contract errors");
  }
  const modelRequests = value.modelRequests === null
    ? null
    : count(value.modelRequests, "projectedMetrics.modelRequests");
  if (modelRequests === null && value.outcome === "passed") {
    fail("passed projectedMetrics require an observed external model request count");
  }
  const modelCallCount = value.modelCallCount === null
    ? null
    : count(value.modelCallCount, "projectedMetrics.modelCallCount");
  if (modelCallCount === null && value.outcome === "passed") {
    fail("passed projectedMetrics require runtime model telemetry");
  }
  if (modelCallCount !== null && modelCallCount > scenario.modelBudget.maxCalls) {
    fail("projectedMetrics model call count must not exceed the canonical scenario budget");
  }
  exactKeys(value.phases, scenario.modelBudget.allowedPhases, "projectedMetrics.phases");
  const phases = Object.fromEntries(scenario.modelBudget.allowedPhases.map((phaseId) => [
    phaseId,
    canonicalProjection(value.phases[phaseId], `projectedMetrics.phases.${phaseId}`),
  ]));
  const slowestPhase = value.slowestPhase === null
    ? null
    : (() => {
      exactKeys(value.slowestPhase, ["phaseId", "durationMs"], "projectedMetrics.slowestPhase");
      const phaseId = nonEmptyString(value.slowestPhase.phaseId, "projectedMetrics.slowestPhase.phaseId");
      const durationMs = duration(value.slowestPhase.durationMs, "projectedMetrics.slowestPhase.durationMs");
      if (!Object.hasOwn(phases, phaseId) || phases[phaseId].value !== durationMs) {
        fail("projectedMetrics.slowestPhase must identify an observed allowed phase");
      }
      return { phaseId, durationMs };
    })();
  if (modelCallCount > 0
    && (slowestPhase === null || !Object.values(phases).some((phase) => Number.isFinite(phase.value)))) {
    fail("positive Runtime model call counts require an observed allowed phase duration and slowestPhase");
  }
  const behavior = canonicalBehavior(value.behavior);
  if (value.outcome === "passed" && behavior.resultCategory !== scenario.expected.resultCategory) {
    fail("passed sample result category must match the scenario contract");
  }
  return {
    outcome: value.outcome,
    contractErrors,
    eventSequenceErrors,
    budgetErrors,
    durationMs: duration(value.durationMs, "projectedMetrics.durationMs"),
    modelRequests,
    modelCallCount,
    submissionToFirstFeedbackMs: nullableDuration(
      value.submissionToFirstFeedbackMs,
      "projectedMetrics.submissionToFirstFeedbackMs",
    ),
    submissionToResultVisibleMs: nullableDuration(
      value.submissionToResultVisibleMs,
      "projectedMetrics.submissionToResultVisibleMs",
    ),
    phases,
    slowestPhase,
    animation: canonicalAnimation(value.animation),
    voice: canonicalVoice(value.voice),
    behavior,
  };
}

function canonicalFaultReceipt(value) {
  exactKeys(value, FAULT_RECEIPT_KEYS, "diagnostics.benchmarkFaultReceipt");
  const profile = BENCHMARK_FAULT_PROFILE[value.faultId];
  const canonical = verifyBenchmarkFaultReceipt(value, profile);
  if (!canonical || FAULT_RECEIPT_KEYS.some((key) => canonical[key] !== value[key])) {
    fail("diagnostics.benchmarkFaultReceipt must match a canonical fault profile");
  }
  return Object.fromEntries(FAULT_RECEIPT_KEYS.map((key) => [key, canonical[key]]));
}

function canonicalInstrumentation(value) {
  exactKeys(value, INSTRUMENTATION_KEYS, "publicHmiEvidence.instrumentation");
  const projected = Object.fromEntries(INSTRUMENTATION_KEYS.map((key) => [
    key,
    boolean(value[key], `publicHmiEvidence.instrumentation.${key}`),
  ]));
  const expectedComplete = INSTRUMENTATION_KEYS
    .filter((key) => key !== "complete")
    .every((key) => projected[key] === true);
  if (projected.complete !== expectedComplete) {
    fail("publicHmiEvidence.instrumentation.complete must match the counter presence flags");
  }
  return projected;
}

function canonicalCounters(value, instrumentation) {
  exactKeys(value, EXECUTION_COUNTER_KEYS, "publicHmiEvidence.counters");
  const projected = Object.fromEntries(EXECUTION_COUNTER_KEYS.map((key) => {
    const counterValue = nullableCount(value[key], `publicHmiEvidence.counters.${key}`);
    if ((instrumentation[key] === true) !== (counterValue !== null)) {
      fail(`publicHmiEvidence.counters.${key} must match its instrumentation presence flag`);
    }
    return [key, counterValue];
  }));
  if (projected.adapterAcceptedCount !== null
    && projected.toolCallCount !== null
    && projected.adapterAcceptedCount > projected.toolCallCount) {
    fail("adapterAcceptedCount must not exceed toolCallCount");
  }
  if (projected.providerAcceptedCount !== null
    && projected.providerCallCount !== null
    && projected.providerAcceptedCount > projected.providerCallCount) {
    fail("providerAcceptedCount must not exceed providerCallCount");
  }
  if (projected.providerStateChangeCount !== null
    && projected.providerAcceptedCount !== null
    && projected.providerStateChangeCount > projected.providerAcceptedCount) {
    fail("providerStateChangeCount must not exceed providerAcceptedCount");
  }
  return projected;
}

function canonicalPublicEvents(value) {
  if (!Array.isArray(value)) fail("publicHmiEvidence.events must be an array");
  const seenEventIds = new Set();
  let previousSequence = 0;
  return value.map((event, index) => {
    exactKeys(event, PUBLIC_EVENT_KEYS, `publicHmiEvidence.events[${index}]`);
    const label = `publicHmiEvidence.events[${index}]`;
    const eventId = nonEmptyString(event.eventId, `${label}.eventId`);
    if (seenEventIds.has(eventId)) fail(`${label}.eventId must be unique`);
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence <= previousSequence) {
      fail(`${label}.sequence must be a strictly increasing positive safe integer`);
    }
    const parentEventId = nullableString(event.parentEventId, `${label}.parentEventId`);
    if (parentEventId !== null && !seenEventIds.has(parentEventId)) {
      fail(`${label}.parentEventId must identify an earlier public event`);
    }
    const component = nonEmptyString(event.component, `${label}.component`);
    const registeredComponent = getParticipant(component);
    if (!registeredComponent || registeredComponent.type !== event.componentType) {
      fail(`${label}.componentType must match the registered component`);
    }
    if (!RUN_EVENT_PHASES.includes(event.phase)) fail(`${label}.phase is unsupported`);
    if (!RUN_EVENT_STATUSES.includes(event.status)) fail(`${label}.status is unsupported`);
    const refs = stringArray(event.refs, `${label}.refs`);
    if (new Set(refs).size !== refs.length) fail(`${label}.refs must be unique`);
    if (event.durationMs !== null
      && (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0)) {
      fail(`${label}.durationMs must be a non-negative safe integer or null`);
    }
    seenEventIds.add(eventId);
    previousSequence = event.sequence;
    return {
      eventId,
      parentEventId,
      sequence: event.sequence,
      component,
      componentType: event.componentType,
      phase: event.phase,
      status: event.status,
      refs,
      reasonCode: nullableReasonCode(
        event.reasonCode,
        `${label}.reasonCode`,
      ),
      durationMs: event.durationMs,
    };
  });
}

function canonicalExecutionTrace(value) {
  if (!Array.isArray(value)) fail("publicHmiEvidence.result.executionTrace must be an array");
  return value.map((entry, index) => {
    exactKeys(entry, EXECUTION_TRACE_KEYS, `publicHmiEvidence.result.executionTrace[${index}]`);
    if (!VEHICLE_EXECUTION_STATES.includes(entry.state)) {
      fail(`publicHmiEvidence.result.executionTrace[${index}].state is unsupported`);
    }
    return {
      state: entry.state,
      at: isoTimestamp(entry.at, `publicHmiEvidence.result.executionTrace[${index}].at`),
      source: nonEmptyString(entry.source, `publicHmiEvidence.result.executionTrace[${index}].source`),
    };
  });
}

function canonicalPublicResult(value) {
  exactKeys(value, PUBLIC_RESULT_KEYS, "publicHmiEvidence.result");
  if (value.executionState !== null && !VEHICLE_EXECUTION_STATES.includes(value.executionState)) {
    fail("publicHmiEvidence.result.executionState is unsupported");
  }
  return {
    safetyAllowed: nullableBoolean(value.safetyAllowed, "publicHmiEvidence.result.safetyAllowed"),
    toolCallPresent: boolean(value.toolCallPresent, "publicHmiEvidence.result.toolCallPresent"),
    toolResultPresent: boolean(value.toolResultPresent, "publicHmiEvidence.result.toolResultPresent"),
    executionState: value.executionState,
    toolCommandId: nullableString(value.toolCommandId, "publicHmiEvidence.result.toolCommandId"),
    resultCommandId: nullableString(value.resultCommandId, "publicHmiEvidence.result.resultCommandId"),
    snapshotId: nullableString(value.snapshotId, "publicHmiEvidence.result.snapshotId"),
    confirmedSnapshotId: nullableString(value.confirmedSnapshotId, "publicHmiEvidence.result.confirmedSnapshotId"),
    snapshotCapturedAt: value.snapshotCapturedAt === null
      ? null
      : isoTimestamp(value.snapshotCapturedAt, "publicHmiEvidence.result.snapshotCapturedAt"),
    executionTrace: canonicalExecutionTrace(value.executionTrace),
  };
}

function canonicalPublicEvidence(value, sampleRunId, projectedMetrics, scenario) {
  exactKeys(value, PUBLIC_EVIDENCE_KEYS, "diagnostics.publicHmiEvidence");
  const runId = nonEmptyString(value.runId, "publicHmiEvidence.runId");
  if (runId !== sampleRunId) fail("publicHmiEvidence.runId must match the sample runId");
  const resultVisible = boolean(value.resultVisible, "publicHmiEvidence.resultVisible");
  const resultVisibleRunId = nullableString(value.resultVisibleRunId, "publicHmiEvidence.resultVisibleRunId");
  if ((resultVisible && resultVisibleRunId !== runId) || (!resultVisible && resultVisibleRunId !== null)) {
    fail("publicHmiEvidence.resultVisibleRunId must identify exactly the visible final Run");
  }
  const instrumentation = canonicalInstrumentation(value.instrumentation);
  const observedModelRequestCount = nullableCount(
    value.observedModelRequestCount,
    "publicHmiEvidence.observedModelRequestCount",
  );
  const observedExternalModelRequestCount = nullableCount(
    value.observedExternalModelRequestCount,
    "publicHmiEvidence.observedExternalModelRequestCount",
  );
  if ((instrumentation.modelRequestCount === true) !== (observedModelRequestCount !== null)) {
    fail("observedModelRequestCount must match its instrumentation presence flag");
  }
  if ((instrumentation.externalModelRequestCount === true) !== (observedExternalModelRequestCount !== null)) {
    fail("observedExternalModelRequestCount must match its instrumentation presence flag");
  }
  if (observedExternalModelRequestCount !== null
    && projectedMetrics.modelRequests !== observedExternalModelRequestCount) {
    fail("projectedMetrics.modelRequests must equal the observed external Provider count");
  }
  if (observedModelRequestCount !== null
    && projectedMetrics.modelCallCount !== observedModelRequestCount) {
    fail("projectedMetrics.modelCallCount must equal the observed model phase request count");
  }
  if (observedExternalModelRequestCount === null
    && (projectedMetrics.modelRequests !== null || projectedMetrics.outcome === "passed")) {
    fail("missing external Provider telemetry must remain unavailable and non-passing");
  }
  if (instrumentation.complete === false && projectedMetrics.outcome === "passed") {
    fail("incomplete public instrumentation must not produce a passed sample");
  }
  if (projectedMetrics.outcome === "passed" && !resultVisible) {
    fail("passed samples require a visible final result for the sample Run");
  }
  const animationConfirmed = boolean(value.animationConfirmed, "publicHmiEvidence.animationConfirmed");
  const animationCommandId = nullableString(value.animationCommandId, "publicHmiEvidence.animationCommandId");
  if (animationConfirmed !== (animationCommandId !== null)) {
    fail("publicHmiEvidence animation confirmation must have one correlated command ID");
  }
  const counters = canonicalCounters(value.counters, instrumentation);
  const result = canonicalPublicResult(value.result);
  const behavior = projectedMetrics.behavior;
  const executionFactsComplete = EXECUTION_FACT_COUNTER_KEYS
    .every((key) => counters[key] !== null)
    && counters.adapterAcceptedCount <= counters.toolCallCount
    && counters.providerAcceptedCount <= counters.providerCallCount
    && counters.providerStateChangeCount <= counters.providerAcceptedCount;
  const expectedDispatchAuthorized = executionFactsComplete ? counters.toolCallCount > 0 : null;
  const expectedAdapterExecutions = executionFactsComplete ? counters.adapterAcceptedCount : null;
  const expectedVehicleToolCalls = executionFactsComplete ? counters.toolCallCount : null;
  const expectedVehicleWrites = executionFactsComplete ? counters.providerStateChangeCount : null;
  if (behavior.dispatchAuthorized !== expectedDispatchAuthorized
    || behavior.adapterExecutions !== expectedAdapterExecutions
    || behavior.vehicleToolCalls !== expectedVehicleToolCalls
    || behavior.vehicleWrites !== expectedVehicleWrites) {
    fail("projected behavior execution counts must match the public HMI counters");
  }
  if (behavior.executionFactsComplete !== executionFactsComplete) {
    fail("projected executionFactsComplete must match the five public execution counters");
  }
  const crossedExecutionBoundary = executionFactsComplete
    && EXECUTION_FACT_COUNTER_KEYS.some((key) => counters[key] > 0);
  const expectedUnsafeProviderExecution = crossedExecutionBoundary && result.safetyAllowed !== true;
  if (behavior.unsafeProviderExecution !== expectedUnsafeProviderExecution) {
    fail("projected unsafeProviderExecution must match the public safety and execution facts");
  }
  if ((result.safetyAllowed !== true || result.toolCallPresent === false)
    && behavior.safetyWriteDecisions !== 0) {
    fail("projected safety-write decisions must match the public HMI result facts");
  }
  if (!result.toolCallPresent && result.toolCommandId !== null) {
    fail("public HMI toolCommandId requires a Runtime ToolCall");
  }
  if (!result.toolResultPresent
    && (result.resultCommandId !== null
      || result.executionState !== null
      || result.confirmedSnapshotId !== null
      || result.executionTrace.length > 0)) {
    fail("public HMI ToolResult facts require a Runtime ToolResult");
  }
  const expectedProviderConfirmation = executionFactsComplete
    && result.toolResultPresent
    && counters.providerAcceptedCount > 0
    && result.executionState === "observed-succeeded"
    && result.confirmedSnapshotId !== null
    && result.confirmedSnapshotId === result.snapshotId;
  if (behavior.providerConfirmation !== expectedProviderConfirmation) {
    fail("projected provider confirmation must match the public HMI execution facts");
  }
  if (animationConfirmed !== (projectedMetrics.animation.value === true)) {
    fail("projected animation confirmation must match the public HMI animation fact");
  }
  if (animationConfirmed
    && (animationCommandId !== result.resultCommandId
      || (result.toolCommandId !== null && animationCommandId !== result.toolCommandId))) {
    fail("public HMI animation command must match the visible result command");
  }
  const interactionRunIds = stringArray(value.interactionRunIds, "publicHmiEvidence.interactionRunIds");
  if (new Set(interactionRunIds).size !== interactionRunIds.length) {
    fail("publicHmiEvidence.interactionRunIds must be unique");
  }
  if (scenario.id === "vehicle-control-safe"
    && (interactionRunIds.length < 2 || interactionRunIds.at(-1) !== sampleRunId)) {
    fail("vehicle-control-safe requires challenge and confirmation Run evidence ending at the visible final Run");
  }
  return {
    runId,
    resultVisibleRunId,
    firstFeedbackObserved: boolean(value.firstFeedbackObserved, "publicHmiEvidence.firstFeedbackObserved"),
    resultVisible,
    observedModelRequestCount,
    observedExternalModelRequestCount,
    instrumentation,
    visibleCardKinds: stringArray(value.visibleCardKinds, "publicHmiEvidence.visibleCardKinds"),
    interactionRunIds,
    counters,
    events: canonicalPublicEvents(value.events),
    result,
    animationConfirmed,
    animationCommandId,
  };
}

function canonicalDiagnostics(value, { profile, sampleId, runId, projectedMetrics, scenario }) {
  if (!isRecord(value)) fail("sample.diagnostics must be an object");
  const allowedKeys = ["code", "benchmarkFaultReceipt", "publicHmiEvidence"];
  if (!Object.hasOwn(value, "code")
    || !Object.hasOwn(value, "publicHmiEvidence")
    || Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    fail("sample.diagnostics must contain only allowed canonical fields");
  }
  if (!DIAGNOSTIC_CODES.has(value.code)) fail("sample.diagnostics.code is unsupported");
  const receiptPresent = Object.hasOwn(value, "benchmarkFaultReceipt");
  const plannedFault = B4_FAULT_SAMPLE_PLAN.find((entry) => entry.sampleKey === sampleId);
  if (profile === "stability-faults" && !plannedFault) {
    fail("stability-faults samples must belong to the planned fault sample set");
  }
  if (profile === "stability-faults" && !receiptPresent) {
    fail("stability-faults samples require their planned benchmark fault receipt");
  }
  if (receiptPresent && profile !== "stability-faults") {
    fail("benchmark fault receipts are allowed only for the stability-faults profile");
  }
  const benchmarkFaultReceipt = receiptPresent
    ? canonicalFaultReceipt(value.benchmarkFaultReceipt)
    : null;
  if (plannedFault && benchmarkFaultReceipt && benchmarkFaultReceipt.faultId !== plannedFault.faultId) {
    fail("benchmark fault receipt must match the sample's planned fault");
  }
  return {
    code: value.code,
    ...(benchmarkFaultReceipt ? { benchmarkFaultReceipt } : {}),
    publicHmiEvidence: canonicalPublicEvidence(value.publicHmiEvidence, runId, projectedMetrics, scenario),
  };
}

function canonicalIdentity(sample) {
  const scenario = B4_BENCHMARK_SCENARIOS[sample.scenarioId];
  if (!scenario) fail("sample.scenarioId must identify a B4 benchmark scenario");
  if (!Number.isSafeInteger(sample.repeat) || sample.repeat < 1) {
    fail("sample.repeat must be a positive safe integer");
  }
  const sampleId = nonEmptyString(sample.sampleId, "sample.sampleId");
  const canonicalId = `${sample.scenarioId}:${sample.repeat}`;
  if (sampleId !== canonicalId) fail("sampleId must equal the canonical scenarioId:repeat ID");
  return { scenario, sampleId };
}

export function canonicalizeCheckpointSample(sample, { profile } = {}) {
  exactKeys(sample, RAW_SAMPLE_KEYS, "checkpoint sample");
  const { scenario, sampleId } = canonicalIdentity(sample);
  if (sample.sampleKey !== sampleId) fail("sampleKey must equal the canonical sampleId");
  const runId = nonEmptyString(sample.runId, "sample.runId");
  const projectedMetrics = canonicalProjectedMetrics(sample.projectedMetrics, scenario);
  if (sample.simulated !== scenario.simulated) fail("sample.simulated must match the scenario contract");
  return {
    sampleId,
    sampleKey: sampleId,
    runId,
    scenarioId: sample.scenarioId,
    repeat: sample.repeat,
    timestamps: canonicalTimestamps(sample.timestamps),
    projectedMetrics,
    eventRefs: stringArray(sample.eventRefs, "sample.eventRefs", { nonEmpty: true }),
    simulated: sample.simulated,
    diagnostics: canonicalDiagnostics(sample.diagnostics, { profile, sampleId, runId, projectedMetrics, scenario }),
  };
}

export function finalBenchmarkSampleFromCheckpoint(sample, { profile } = {}) {
  const canonical = canonicalizeCheckpointSample(sample, { profile });
  return {
    sampleId: canonical.sampleId,
    runId: canonical.runId,
    scenarioId: canonical.scenarioId,
    repeat: canonical.repeat,
    outcome: canonical.projectedMetrics.outcome,
    timestamps: canonical.timestamps,
    metrics: {
      durationMs: canonical.projectedMetrics.durationMs,
      modelRequests: canonical.projectedMetrics.modelRequests,
      modelCallCount: canonical.projectedMetrics.modelCallCount,
    },
    result: { category: canonical.projectedMetrics.behavior.resultCategory },
    eventRefs: canonical.eventRefs,
    simulated: canonical.simulated,
    diagnostics: canonical.diagnostics,
    projectedMetrics: canonical.projectedMetrics,
  };
}

function canonicalFinalSample(sample, { profile } = {}) {
  exactKeys(sample, FINAL_SAMPLE_KEYS, "final report sample");
  const { scenario, sampleId } = canonicalIdentity(sample);
  const runId = nonEmptyString(sample.runId, "sample.runId");
  const projectedMetrics = canonicalProjectedMetrics(sample.projectedMetrics, scenario);
  if (sample.outcome !== projectedMetrics.outcome) fail("sample.outcome must match projectedMetrics.outcome");
  exactKeys(sample.metrics, ["durationMs", "modelRequests", "modelCallCount"], "sample.metrics");
  if (sample.metrics.durationMs !== projectedMetrics.durationMs
    || sample.metrics.modelRequests !== projectedMetrics.modelRequests
    || sample.metrics.modelCallCount !== projectedMetrics.modelCallCount) {
    fail("sample.metrics must equal the canonical projected metrics");
  }
  exactKeys(sample.result, ["category"], "sample.result");
  if (sample.result.category !== projectedMetrics.behavior.resultCategory) {
    fail("sample.result.category must equal projectedMetrics.behavior.resultCategory");
  }
  if (sample.simulated !== scenario.simulated) fail("sample.simulated must match the scenario contract");
  return {
    sampleId,
    runId,
    scenarioId: sample.scenarioId,
    repeat: sample.repeat,
    outcome: sample.outcome,
    timestamps: canonicalTimestamps(sample.timestamps),
    metrics: {
      durationMs: duration(sample.metrics.durationMs, "sample.metrics.durationMs"),
      modelRequests: sample.metrics.modelRequests === null
        ? null
        : count(sample.metrics.modelRequests, "sample.metrics.modelRequests"),
      modelCallCount: sample.metrics.modelCallCount === null
        ? null
        : count(sample.metrics.modelCallCount, "sample.metrics.modelCallCount"),
    },
    result: { category: sample.result.category },
    eventRefs: stringArray(sample.eventRefs, "sample.eventRefs", { nonEmpty: true }),
    simulated: sample.simulated,
    diagnostics: canonicalDiagnostics(sample.diagnostics, { profile, sampleId, runId, projectedMetrics, scenario }),
    projectedMetrics,
  };
}

export function validateFinalBenchmarkSample(sample, options = {}) {
  try {
    canonicalFinalSample(sample, options);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function expectedProfileSampleKeys(profileId, profile) {
  if (profileId === "stability-faults") {
    return B4_FAULT_SAMPLE_PLAN.map((sample) => sample.sampleKey);
  }
  if (!profile || !Array.isArray(profile.scenarioIds) || !Number.isSafeInteger(profile.repeats)) return null;
  return profile.scenarioIds.flatMap((scenarioId) => Array.from(
    { length: profile.repeats },
    (_, index) => `${scenarioId}:${index + 1}`,
  ));
}
