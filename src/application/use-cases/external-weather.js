import { createToolCall } from "../../runtime/agent-schemas.js";

const WEATHER_UNAVAILABLE = "天气实时信息暂时不可用。";
const WEATHER_ADAPTER_SOURCE = "weather-api-adapter";
const WEATHER_GROUNDING_SOURCE = "weather-api-grounding";
const WEATHER_CLARIFICATION_POLICY = "nio-weather-location-clarification@1.0.0";
const LOCATION_CLARIFICATION_CODES = new Set([
  "weather_location_ambiguous",
  "weather_location_needs_clarification",
]);

export function createDirectExternalWeatherUseCase({ externalDataAdapter } = {}) {
  if (!externalDataAdapter || typeof externalDataAdapter.execute !== "function") {
    throw new TypeError("externalDataAdapter.execute() is required");
  }
  return Object.freeze({
    async execute(context = {}) {
      context.throwIfAborted();
      const toolCall = createDirectExternalToolCall(context);
      context.emit({
        component: "externalDataAdapter",
        phase: "external-query",
        status: "processing",
        summary: "ExternalDataAdapter 已接收只读天气查询。",
        refs: [toolCall.commandId],
        metadata: { external: { toolCall: projectExternalToolCall(toolCall) } },
      });
      const adapterResult = await externalDataAdapter.execute(toolCall, {
        signal: context.signal,
        deadlineAt: context.deadlineAt,
      });
      context.throwIfAborted();
      const outcome = inspectWeatherOutcome(toolCall, adapterResult);
      const adapterEvent = context.emit({
        component: "externalDataAdapter",
        phase: "external-query",
        status: externalOutcomeStatus(outcome),
        summary: outcome.assistantResponse,
        refs: [toolCall.commandId, ...outcome.evidenceRefs.map((ref) => ref.id)],
        metadata: {
          reasonCode: outcome.reasonCode,
          simulated: outcome.toolResult?.simulated === true,
          degraded: outcome.degraded,
          external: {
            toolCall: projectExternalToolCall(toolCall),
            toolResult: projectExternalToolResult(outcome.toolResult),
            evidenceRefs: outcome.evidenceRefs,
            responseSource: outcome.grounded ? "external-weather-evidence" : "deterministic-boundary",
          },
        },
      });
      context.emit({
        parentEventId: adapterEvent.eventId,
        component: "responsePresentation",
        phase: "external-query",
        status: externalOutcomeStatus(outcome),
        summary: outcome.assistantResponse,
        refs: outcome.evidenceRefs.map((ref) => ref.id),
        metadata: {
          reasonCode: outcome.reasonCode,
          degraded: outcome.degraded,
          presentation: {
            responseSource: outcome.grounded ? "external-weather-evidence" : "deterministic-boundary",
            outcomeStatus: weatherOutcomeStatus(outcome),
          },
        },
      });
      return Object.freeze({
        assistantResponse: outcome.assistantResponse,
        toolCall,
        toolResult: outcome.toolResult,
        modelCalls: Object.freeze([]),
        degraded: outcome.degraded,
        outcomeStatus: weatherOutcomeStatus(outcome),
        reasonCode: outcome.reasonCode,
      });
    },
  });
}

function externalOutcomeStatus(outcome) {
  if (outcome.grounded) return "completed";
  return LOCATION_CLARIFICATION_CODES.has(outcome.reasonCode)
    ? "awaiting_clarification"
    : "unavailable";
}

function weatherOutcomeStatus(outcome) {
  if (outcome.grounded) return "answered";
  return LOCATION_CLARIFICATION_CODES.has(outcome.reasonCode) ? "clarification" : "unavailable";
}

function projectExternalToolCall(toolCall) {
  return Object.freeze({
    requestId: toolCall.requestId,
    commandId: toolCall.commandId,
    tool: toolCall.tool,
    args: Object.freeze({
      topic: toolCall.args?.topic,
      externalDataType: toolCall.args?.externalDataType,
    }),
  });
}

function projectExternalToolResult(toolResult = {}) {
  const projected = {
    requestId: toolResult.requestId,
    commandId: toolResult.commandId,
    tool: toolResult.tool,
    ok: toolResult.ok === true,
    executionState: toolResult.executionState,
    simulated: toolResult.simulated === true,
    source: toolResult.source,
  };
  if (typeof toolResult.timestamp === "string") projected.timestamp = toolResult.timestamp;
  if (toolResult.executionError) {
    projected.executionError = {
      code: toolResult.executionError.code,
      stage: toolResult.executionError.stage,
      retryable: toolResult.executionError.retryable === true,
    };
  }
  if (toolResult.weatherLocationClarification) {
    const source = toolResult.weatherLocationClarification;
    projected.locationClarification = {
      policy: source.policy,
      code: source.code,
      ...(source.reference ? { reference: source.reference } : {}),
      ...(Array.isArray(source.candidates)
        ? { candidates: source.candidates.map((candidate) => ({
          ...(candidate.city ? { city: candidate.city } : {}),
          ...(candidate.admin1 ? { admin1: candidate.admin1 } : {}),
          ...(candidate.country ? { country: candidate.country } : {}),
        })) }
        : {}),
    };
  }
  return deepFreeze(projected);
}
function createDirectExternalToolCall(context) {
  const externalDataType = context.parsedCommand?.slots?.externalDataType;
  if (context.parsedCommand?.intent !== "conversation.general" || externalDataType !== "weather") {
    throw new TypeError("unsupported direct external capability");
  }
  // The location is the Vehicle-SLU weather.location slot; the raw text only shapes the answer.
  const location = context.parsedCommand.slots.location;
  return createToolCall(context.runId, "conversation.general", {
    topic: "weather_query",
    externalDataType: "weather",
    query: context.rawText,
    rawText: context.rawText,
    ...(typeof location === "string" && location.trim() ? { location: location.trim() } : {}),
  }, false, {}, { sequence: 1 });
}

function inspectWeatherOutcome(toolCall, adapterResult) {
  if (isCanonicalWeatherSuccess(toolCall, adapterResult)) {
    const toolResult = projectGroundedWeatherResult(toolCall, adapterResult);
    return {
      assistantResponse: toolResult.hmiSummary,
      toolResult,
      evidenceRefs: toolResult.evidenceRefs,
      grounded: true,
      degraded: false,
      reasonCode: "external-weather-grounded",
    };
  }

  const identityMatches = matchesToolIdentity(toolCall, adapterResult);
  const clarification = identityMatches && adapterResult?.ok === false
    ? projectLocationClarification(adapterResult)
    : null;
  if (clarification) {
    const toolResult = projectFailedWeatherResult(toolCall, adapterResult, { clarification });
    return {
      assistantResponse: clarification.clarification,
      toolResult,
      evidenceRefs: Object.freeze([]),
      grounded: false,
      degraded: true,
      reasonCode: clarification.code,
    };
  }

  const toolResult = projectFailedWeatherResult(toolCall, adapterResult);
  return {
    assistantResponse: WEATHER_UNAVAILABLE,
    toolResult,
    evidenceRefs: Object.freeze([]),
    grounded: false,
    degraded: true,
    reasonCode: toolResult?.executionError?.code || "external-weather-unavailable",
  };
}

function isCanonicalWeatherSuccess(toolCall, result) {
  return result?.ok === true
    && matchesToolIdentity(toolCall, result)
    && result.executionState === "accepted"
    && result.simulated === false
    && result.source === WEATHER_ADAPTER_SOURCE
    && result.statePatchSource === WEATHER_GROUNDING_SOURCE
    && result.visualScenario === "planning"
    && result.executionError == null
    && isRecord(result.statePatch)
    && isRecord(result.statePatch.weatherData)
    && isRecord(result.observedState)
    && !hasFailureMarker(result.statePatch)
    && !hasFailureMarker(result.observedState)
    && isCanonicalAcceptedTrace(result.executionTrace)
    && isIsoTimestamp(result.timestamp)
    && typeof result.hmiSummary === "string"
    && result.hmiSummary.trim().length > 0
    && Array.isArray(result.evidenceRefs)
    && result.evidenceRefs.some(isExternalWeatherEvidence);
}

function isCanonicalAcceptedTrace(trace) {
  return Array.isArray(trace)
    && trace.length > 0
    && trace.every((entry) => isRecord(entry)
      && entry.state === "accepted"
      && entry.source === WEATHER_ADAPTER_SOURCE
      && isIsoTimestamp(entry.at));
}

function hasFailureMarker(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasFailureMarker);
  return Object.entries(value).some(([key, item]) => {
    const normalizedKey = key.toLowerCase().replaceAll(/[^a-z]/g, "");
    if (["state", "status", "executionstate"].includes(normalizedKey)
      && typeof item === "string"
      && /^(?:rejected|blocked|failed|error|cancelled|canceled|timeout|duplicate-command)$/.test(item)) {
      return true;
    }
    if (["rejected", "blocked", "failed", "error", "cancelled", "canceled", "timeout", "duplicate"]
      .some((marker) => normalizedKey.includes(marker))
      && isTruthyFailureMarker(item)) {
      return true;
    }
    return hasFailureMarker(item);
  });
}

function isTruthyFailureMarker(value) {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !["", "false", "none", "ok"].includes(value.trim().toLowerCase());
  return value != null && typeof value === "object" && Object.keys(value).length > 0;
}

function matchesToolIdentity(toolCall, result) {
  return result?.requestId === toolCall.requestId
    && result?.commandId === toolCall.commandId
    && result?.tool === toolCall.tool;
}

function isExternalWeatherEvidence(value) {
  return value
    && typeof value === "object"
    && value.type === "external-weather"
    && typeof value.id === "string"
    && value.id.trim().length > 0
    && typeof value.source === "string"
    && value.source.trim().length > 0;
}

function projectGroundedWeatherResult(toolCall, result) {
  return deepFreeze({
    requestId: toolCall.requestId,
    commandId: toolCall.commandId,
    tool: toolCall.tool,
    ok: true,
    executionState: "accepted",
    simulated: false,
    statePatch: { weatherData: projectWeatherData(result.statePatch.weatherData) },
    observedState: {},
    statePatchSource: WEATHER_GROUNDING_SOURCE,
    executionTrace: result.executionTrace.map(projectAcceptedTraceEntry),
    hmiSummary: result.hmiSummary.trim(),
    visualScenario: "planning",
    source: WEATHER_ADAPTER_SOURCE,
    timestamp: result.timestamp,
    evidenceRefs: result.evidenceRefs
      .filter(isExternalWeatherEvidence)
      .map(projectWeatherEvidence),
  });
}

function projectWeatherData(value) {
  const projected = {};
  copyStringFields(projected, value, ["provider", "source", "fetchedAt"]);
  if (isRecord(value.location)) {
    projected.location = {};
    copyStringFields(projected.location, value.location, ["city", "resolution"]);
    if (typeof value.location.defaulted === "boolean") {
      projected.location.defaulted = value.location.defaulted;
    }
  }
  if (isRecord(value.current)) {
    projected.current = {};
    copyFiniteNumberFields(projected.current, value.current, ["temperature2m", "apparentTemperature"]);
    copyStringFields(projected.current, value.current, ["weatherDescription"]);
  }
  if (Array.isArray(value.forecast)) {
    projected.forecast = value.forecast.filter(isRecord).map((entry) => {
      const item = {};
      copyStringFields(item, entry, ["date", "weatherDescription"]);
      copyFiniteNumberFields(item, entry, [
        "temperatureMin", "temperatureMax", "precipitationProbabilityMax",
      ]);
      return item;
    });
  }
  if (isRecord(value.units)) {
    projected.units = {};
    copyStringFields(projected.units, value.units, [
      "temperature2m", "apparentTemperature", "precipitationProbability",
    ]);
  }
  return projected;
}

function projectWeatherEvidence(value) {
  const projected = {
    id: value.id.trim(),
    source: value.source.trim(),
    type: "external-weather",
  };
  copyStringFields(projected, value, ["title", "citation"]);
  return projected;
}

function projectAcceptedTraceEntry(value) {
  return {
    state: "accepted",
    source: WEATHER_ADAPTER_SOURCE,
    at: value.at,
  };
}

function projectLocationClarification(result) {
  const code = result?.executionError?.code;
  if (!LOCATION_CLARIFICATION_CODES.has(code)) return null;
  const provided = result.weatherLocationClarification
    || result.executionError?.weatherLocationClarification
    || result.executionError?.details?.weatherLocationClarification;
  if (provided && typeof provided === "object"
    && provided.policy === WEATHER_CLARIFICATION_POLICY
    && provided.code === code
    && typeof provided.clarification === "string"
    && provided.clarification.trim()) {
    const projection = {
      policy: WEATHER_CLARIFICATION_POLICY,
      code,
      clarification: provided.clarification.trim(),
    };
    if (["current", "destination"].includes(provided.reference)) {
      projection.reference = provided.reference;
    }
    if (Array.isArray(provided.candidates)) {
      projection.candidates = provided.candidates.filter(isRecord).map((candidate) => {
        const projected = {};
        copyStringFields(projected, candidate, ["city", "admin1", "country"]);
        return projected;
      });
    }
    return deepFreeze(projection);
  }
  const fallback = code === "weather_location_ambiguous"
    ? "天气地点存在歧义，请补充省份或城市信息。"
    : "请补充需要查询天气的城市。";
  return Object.freeze({
    policy: WEATHER_CLARIFICATION_POLICY,
    code,
    clarification: fallback,
  });
}

function projectFailedWeatherResult(toolCall, result, { clarification } = {}) {
  const executionError = matchesToolIdentity(toolCall, result) && result?.executionError != null
    ? projectExecutionError(result.executionError)
    : deepFreeze({
      code: "external-evidence-invalid",
      message: "ExternalDataAdapter did not return grounded weather evidence.",
      stage: "grounding",
      retryable: true,
    });
  return deepFreeze({
    requestId: toolCall.requestId,
    commandId: toolCall.commandId,
    tool: toolCall.tool,
    ok: false,
    executionState: "failed",
    simulated: false,
    statePatch: { rejected: true, reason: clarification?.clarification || WEATHER_UNAVAILABLE },
    observedState: {},
    executionError,
    hmiSummary: clarification?.clarification || WEATHER_UNAVAILABLE,
    visualScenario: "blocked",
    source: WEATHER_ADAPTER_SOURCE,
    evidenceRefs: [],
    ...(clarification ? { weatherLocationClarification: clarification } : {}),
  });
}

function projectExecutionError(value) {
  return deepFreeze({
    code: nonEmptyString(value?.code) || "external-weather-unavailable",
    message: nonEmptyString(value?.message) || WEATHER_UNAVAILABLE,
    stage: nonEmptyString(value?.stage) || "execution",
    retryable: value?.retryable === true,
  });
}

function copyStringFields(target, source, fields) {
  for (const field of fields) {
    const value = nonEmptyString(source?.[field]);
    if (value) target[field] = value;
  }
}

function copyFiniteNumberFields(target, source, fields) {
  for (const field of fields) {
    if (Number.isFinite(source?.[field])) target[field] = source[field];
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}
