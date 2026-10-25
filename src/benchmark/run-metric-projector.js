import {
  getBenchmarkScenario,
  validateBenchmarkScenario,
} from "./run-benchmark-scenarios.js";
import { expectedVehicleRequestedState } from "../vehicle/vehicle-command-contract.js";

const SAMPLE_OUTCOMES = new Set([
  "passed",
  "run-degraded",
  "run-failed",
  "contract-failed",
]);

const BENCHMARK_LATENCY_CONTRACTS = Object.freeze({
  "conversation-general": Object.freeze({ routeId: "chat", mode: "direct", maxResultMs: 7_000 }),
  "weather-readonly": Object.freeze({ routeId: "task", mode: "direct-capability", maxResultMs: 8_000 }),
  "vehicle-knowledge": Object.freeze({ routeId: "vehicle-knowledge", mode: "direct", maxResultMs: 8_000 }),
  "vehicle-control-safe": Object.freeze({ routeId: "vehicle-control", mode: "direct", maxResultMs: 2_000 }),
  "vehicle-control-unsafe": Object.freeze({ routeId: "vehicle-control", mode: "direct", maxResultMs: 2_000 }),
  clarification: Object.freeze({ routeId: null, mode: null, maxResultMs: null }),
  "complex-collaboration": Object.freeze({ routeId: "task", mode: "orchestrated", maxResultMs: 12_000 }),
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteDuration(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function elapsedMs(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start
    : null;
}

function unavailable(reason) {
  return Object.freeze({ value: null, reason });
}

function metric(value, reason) {
  return Number.isFinite(value) && value >= 0
    ? Object.freeze({ value })
    : unavailable(reason);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonnegativeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function projectExecutionFacts(browserObservation) {
  const facts = Object.freeze({
    toolCallCount: nonnegativeCount(browserObservation?.toolCallCount),
    adapterAcceptedCount: nonnegativeCount(browserObservation?.adapterAcceptedCount),
    providerCallCount: nonnegativeCount(browserObservation?.providerCallCount),
    providerAcceptedCount: nonnegativeCount(browserObservation?.providerAcceptedCount),
    providerStateChangeCount: nonnegativeCount(browserObservation?.providerStateChangeCount),
  });
  const complete = Object.values(facts).every((value) => value !== null)
    && facts.adapterAcceptedCount <= facts.toolCallCount
    && facts.providerAcceptedCount <= facts.providerCallCount
    && facts.providerStateChangeCount <= facts.providerAcceptedCount;
  return Object.freeze({ facts, complete });
}

function isVehicleTool(tool) {
  return expectedVehicleRequestedState({ tool, args: {} }) !== null;
}

function isCompletedReadOnlyToolAnswer(toolCall, toolResult, runId, safetyDecision) {
  if (!isRecord(toolCall) || !isRecord(toolResult)
    || safetyDecision != null
    || toolCall.requiresSafety !== false
    || toolCall.tool !== "conversation.general"
    || !isNonEmptyString(runId)
    || toolCall.requestId !== runId
    || toolResult.ok !== true
    || toolResult.executionState !== "accepted") return false;
  return ["requestId", "commandId", "tool"].every((field) => (
    isNonEmptyString(toolCall[field]) && toolCall[field] === toolResult[field]
  ));
}

function canonicalScenario(scenario) {
  const canonical = getBenchmarkScenario(scenario?.id);
  return canonical && validateBenchmarkScenario(scenario).length === 0 ? canonical : null;
}

export function validateBenchmarkEventSequence(events) {
  if (!Array.isArray(events)) return ["events must be an array"];
  const errors = [];
  const seenIds = new Set();
  let previousSequence = null;

  for (const event of events) {
    if (!isRecord(event)) {
      errors.push("events must contain objects");
      continue;
    }
    const eventId = typeof event.eventId === "string" ? event.eventId.trim() : "";
    if (!eventId) {
      errors.push("eventId must be a non-empty string");
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 1) {
      errors.push(`event ${eventId || "<unknown>"} sequence must be a positive integer`);
    } else if (previousSequence !== null && event.sequence <= previousSequence) {
      errors.push("event sequence must be strictly increasing");
    }
    if (Number.isInteger(event.sequence) && event.sequence >= 1) {
      previousSequence = event.sequence;
    }
    if (event.parentEventId != null) {
      const parentEventId = typeof event.parentEventId === "string" ? event.parentEventId.trim() : "";
      if (!parentEventId || !seenIds.has(parentEventId)) {
        errors.push(`event ${eventId || "<unknown>"} parent must precede child`);
      }
    }
    if (eventId) {
      if (seenIds.has(eventId)) {
        errors.push(`duplicate eventId: ${eventId}`);
      } else {
        seenIds.add(eventId);
      }
    }
  }
  return errors;
}

function projectPhase(events, phaseId) {
  const matching = events.filter((event) => event?.phase === phaseId);
  if (matching.length === 0) return unavailable("phase-not-observed");
  const reportedDuration = matching.find((event) => finiteDuration(event.durationMs) !== null)?.durationMs;
  if (finiteDuration(reportedDuration) !== null) return metric(reportedDuration, "phase-duration-unavailable");
  const observed = matching.map((event) => event.observedMs).filter(Number.isFinite);
  if (observed.length < 2) return unavailable("phase-duration-unavailable");
  return metric(Math.max(...observed) - Math.min(...observed), "phase-duration-unavailable");
}

function projectPhases(scenario, modelCalls) {
  return Object.freeze(Object.fromEntries(scenario.modelBudget.allowedPhases.map((phaseId) => {
    const durations = modelCalls
      .filter((call) => call?.phase === phaseId)
      .map((call) => finiteDuration(call?.telemetry?.durationMs))
      .filter((value) => value !== null);
    return [phaseId, durations.length > 0 ? metric(Math.max(...durations), "phase-duration-unavailable") : unavailable("phase-not-observed")];
  })));
}

function projectRuntimeModelCalls(runtimeTelemetry) {
  if (!isRecord(runtimeTelemetry)
    || !Number.isSafeInteger(runtimeTelemetry.modelCallCount)
    || runtimeTelemetry.modelCallCount < 0
    || !Array.isArray(runtimeTelemetry.modelCalls)
    || runtimeTelemetry.modelCalls.length !== runtimeTelemetry.modelCallCount) {
    return null;
  }
  return runtimeTelemetry.modelCalls;
}

function slowestPhase(phases) {
  const values = Object.entries(phases)
    .filter(([, phase]) => Number.isFinite(phase?.value))
    .map(([phaseId, phase]) => ({ phaseId, durationMs: phase.value }));
  return values.sort((left, right) => right.durationMs - left.durationMs)[0] || null;
}

export function evaluateBenchmarkLatencyContract({
  contractId,
  actualRouteDecision,
  submissionToFirstFeedbackMs,
  submissionToResultVisibleMs,
} = {}) {
  const contract = BENCHMARK_LATENCY_CONTRACTS[contractId];
  if (!contract) throw new TypeError("contractId must identify a benchmark latency contract");
  const errors = [];
  if (!isRecord(actualRouteDecision)
    || actualRouteDecision.routeId !== contract.routeId
    || actualRouteDecision.mode !== contract.mode) {
    errors.push("actual route and mode violate canonical scenario contract");
  }
  if (submissionToFirstFeedbackMs === null || submissionToFirstFeedbackMs > 300) {
    errors.push("first feedback exceeds 300ms");
  }
  if (contract.maxResultMs !== null
    && (submissionToResultVisibleMs === null || submissionToResultVisibleMs > contract.maxResultMs)) {
    errors.push(`result visibility exceeds ${contract.maxResultMs}ms`);
  }
  return Object.freeze(errors);
}

export function evaluateBenchmarkMedianLatencyContract({
  contractId,
  submissionToFirstFeedbackMedianMs,
  submissionToResultVisibleMedianMs,
} = {}) {
  const contract = BENCHMARK_LATENCY_CONTRACTS[contractId];
  if (!contract) throw new TypeError("contractId must identify a benchmark latency contract");
  const errors = [];
  if (submissionToFirstFeedbackMedianMs === null || submissionToFirstFeedbackMedianMs > 300) {
    errors.push("median first feedback exceeds 300ms");
  }
  if (contract.maxResultMs !== null
    && (submissionToResultVisibleMedianMs === null
      || submissionToResultVisibleMedianMs > contract.maxResultMs)) {
    errors.push(`median result visibility exceeds ${contract.maxResultMs}ms`);
  }
  return Object.freeze(errors);
}

function projectBehavior(result = {}, browserObservation, runId) {
  const toolCall = isRecord(result.toolCall) ? result.toolCall : null;
  const toolResult = isRecord(result.toolResult) ? result.toolResult : null;
  const safetyAllowed = result.safetyDecision?.allowed === true;
  const vehicleTool = isVehicleTool(toolCall?.tool || toolResult?.tool);
  const completedReadOnlyToolAnswer = isCompletedReadOnlyToolAnswer(
    toolCall,
    toolResult,
    runId,
    result.safetyDecision,
  );
  const confirmed = toolResult?.executionState === "observed-succeeded"
    && typeof toolResult?.confirmedSnapshotId === "string"
    && toolResult.confirmedSnapshotId === result.vehicleStateSnapshot?.id;
  const execution = projectExecutionFacts(browserObservation);
  const { facts } = execution;
  const providerConfirmed = execution.complete
    ? confirmed && facts.providerAcceptedCount > 0
    : false;
  const crossedExecutionBoundary = execution.complete
    && (facts.toolCallCount > 0
      || facts.adapterAcceptedCount > 0
      || facts.providerCallCount > 0
      || facts.providerAcceptedCount > 0
      || facts.providerStateChangeCount > 0);
  const resultCategory = result.parsedCommand?.slots?.needsClarification === true
    || result.parsedCommand?.conversationGoal?.interactionType === "clarification"
    ? "clarification"
    : providerConfirmed
      ? "executed"
      : completedReadOnlyToolAnswer
        ? "answered"
      : toolCall || toolResult || result.safetyDecision?.allowed === false
        ? "blocked"
        : "answered";
  return Object.freeze({
    resultCategory,
    dispatchAuthorized: execution.complete ? facts.toolCallCount > 0 : null,
    adapterExecutions: execution.complete ? facts.adapterAcceptedCount : null,
    vehicleToolCalls: execution.complete ? facts.toolCallCount : null,
    vehicleWrites: execution.complete ? facts.providerStateChangeCount : null,
    safetyWriteDecisions: safetyAllowed && vehicleTool ? 1 : 0,
    providerConfirmation: providerConfirmed,
    unsafeProviderExecution: crossedExecutionBoundary && !safetyAllowed,
    executionFactsComplete: execution.complete,
  });
}

function projectAnimation(scenario, result, browserObservation) {
  if (scenario.expected.animation !== true) return unavailable("animation-not-required");
  const toolResult = result?.toolResult;
  const confirmationMatches = toolResult?.executionState === "observed-succeeded"
    && isNonEmptyString(toolResult?.confirmedSnapshotId)
    && isNonEmptyString(result?.vehicleStateSnapshot?.id)
    && toolResult.confirmedSnapshotId === result.vehicleStateSnapshot.id;
  if (!confirmationMatches) return Object.freeze({ value: false, reason: "provider-confirmation-unavailable" });
  if (!isNonEmptyString(toolResult.commandId) || !isNonEmptyString(browserObservation?.animationCommandId)) {
    return Object.freeze({ value: false, reason: "animation-command-id-unavailable" });
  }
  if (browserObservation?.animationCommandId !== toolResult.commandId) {
    return Object.freeze({ value: false, reason: "animation-command-id-mismatch" });
  }
  if (!Number.isFinite(browserObservation?.animationConfirmedAtPerf)) {
    return Object.freeze({ value: false, reason: "animation-not-observed" });
  }
  return Object.freeze({ value: true });
}

function behaviorContractErrors(scenario, behavior, animation) {
  const errors = [];
  const expected = scenario.expected;
  if (behavior.executionFactsComplete !== true) {
    errors.push("independent execution counters are unavailable or invalid");
  }
  if (behavior.resultCategory !== expected.resultCategory) {
    errors.push("result category violates scenario contract");
  }
  for (const field of ["adapterExecutions", "vehicleToolCalls", "vehicleWrites", "safetyWriteDecisions"]) {
    if (Object.hasOwn(expected, field) && behavior[field] !== expected[field]) {
      errors.push(`${field === "vehicleWrites" ? "vehicle writes" : field} violate scenario contract`);
    }
  }
  if (Object.hasOwn(expected, "dispatchAuthorized") && behavior.dispatchAuthorized !== expected.dispatchAuthorized) {
    errors.push("dispatch authorization violates scenario contract");
  }
  if (expected.providerConfirmation === true && behavior.providerConfirmation !== true) {
    errors.push("provider confirmation violates scenario contract");
  }
  if (expected.animation === true && animation.value !== true) {
    errors.push("animation confirmation violates scenario contract");
  }
  if (behavior.unsafeProviderExecution) {
    errors.push("provider execution without safety authorization violates scenario contract");
  }
  return Object.freeze([...new Set(errors)]);
}

function projectVoice(voiceObservation) {
  if (!isRecord(voiceObservation)) return null;
  return Object.freeze({
    submissionToFirstAudibleMs: elapsedMs(voiceObservation.submittedAtPerf, voiceObservation.firstAudibleAtPerf),
    submissionToCompletedMs: elapsedMs(voiceObservation.submittedAtPerf, voiceObservation.completedAtPerf),
  });
}

export function projectRunMetrics({ scenario, runDebug, browserObservation, voiceObservation } = {}) {
  const canonical = canonicalScenario(scenario);
  if (!canonical) {
    return Object.freeze({
      outcome: "contract-failed",
      contractErrors: Object.freeze(["scenario must match its canonical benchmark contract"]),
      eventSequenceErrors: Object.freeze([]),
      phases: Object.freeze({}),
    });
  }
  const events = Array.isArray(runDebug?.events) ? runDebug.events : [];
  const eventSequenceErrors = Object.freeze(validateBenchmarkEventSequence(events));
  const result = isRecord(runDebug?.result) ? runDebug.result : {};
  const runtimeModelCalls = projectRuntimeModelCalls(result.runtimeTelemetry);
  const behavior = projectBehavior(result, browserObservation, runDebug?.requestId);
  const animation = projectAnimation(canonical, result, browserObservation);
  const submissionToFirstFeedbackMs = elapsedMs(
    browserObservation?.submittedAtPerf,
    browserObservation?.firstFeedbackAtPerf,
  );
  const submissionToResultVisibleMs = elapsedMs(
    browserObservation?.submittedAtPerf,
    browserObservation?.resultVisibleAtPerf,
  );
  const phases = projectPhases(canonical, runtimeModelCalls || []);
  const modelCallCount = runtimeModelCalls?.length ?? null;
  const budgetErrors = Object.freeze([...new Set([
    ...(runtimeModelCalls === null ? ["runtime model telemetry is unavailable"] : []),
    ...(runtimeModelCalls && modelCallCount > canonical.modelBudget.maxCalls
      ? ["runtime model call count exceeds scenario contract"] : []),
    ...(runtimeModelCalls && runtimeModelCalls.some((call) => !canonical.modelBudget.allowedPhases.includes(call?.phase))
      ? ["runtime model call phase violates scenario contract"] : []),
    ...evaluateBenchmarkLatencyContract({
      contractId: canonical.id,
      actualRouteDecision: result.routeDecision,
      submissionToFirstFeedbackMs,
      submissionToResultVisibleMs,
    }),
  ])]);
  const contractErrors = Object.freeze([...new Set([
    ...eventSequenceErrors,
    ...behaviorContractErrors(canonical, behavior, animation),
    ...budgetErrors,
    ...(isNonEmptyString(runDebug?.requestId)
      && browserObservation?.resultVisibleRunId === runDebug.requestId
      && Number.isFinite(browserObservation?.resultVisibleAtPerf)
      ? []
      : ["result visibility does not belong to the final Run"]),
  ])]);
  const runFailed = Boolean(runDebug?.error) || !isRecord(runDebug?.result);
  const runDegraded = result.mode === "degraded" || events.some((event) => event?.degraded === true);
  const outcome = contractErrors.length > 0
    ? "contract-failed"
    : runFailed
      ? "run-failed"
      : runDegraded
        ? "run-degraded"
        : "passed";
  const durationMs = elapsedMs(runDebug?.startedAtPerf, runDebug?.endedAtPerf)
    ?? submissionToResultVisibleMs;
  return Object.freeze({
    outcome: SAMPLE_OUTCOMES.has(outcome) ? outcome : "contract-failed",
    contractErrors,
    eventSequenceErrors,
    durationMs,
    modelRequests: modelCallCount,
    modelCallCount,
    submissionToFirstFeedbackMs,
    submissionToResultVisibleMs,
    phases,
    slowestPhase: slowestPhase(phases),
    budgetErrors,
    animation,
    voice: projectVoice(voiceObservation),
    behavior,
  });
}
