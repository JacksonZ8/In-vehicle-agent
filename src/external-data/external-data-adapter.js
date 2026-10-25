import { createToolResult } from "../runtime/agent-schemas.js";
import { throwIfAborted } from "../runtime/abort-utils.js";
import { DevCommandRegistry } from "../vehicle/execution-state-contract.js";

const DEV_EXTERNAL_SOURCE = "external-data-dev-adapter";
const WEATHER_EXTERNAL_SOURCE = "weather-api-adapter";
const WEATHER_ERROR_CODES = new Set([
  "invalid_request",
  "missing_query",
  "weather_timeout",
  "weather_upstream_error",
  "weather_location_not_found",
  "weather_location_ambiguous",
  "weather_location_needs_clarification",
]);

function createLocalTrace(state, at, source = DEV_EXTERNAL_SOURCE) {
  return Object.freeze([Object.freeze({ state, source, at })]);
}

function createExternalExecution(requestId, commandId, registry, now, source = DEV_EXTERNAL_SOURCE) {
  const timestamp = new Date(now()).toISOString();
  if (!registry.register(commandId)) {
    return {
      requestId,
      commandId,
      timestamp,
      executionState: "duplicate-command",
      executionTrace: createLocalTrace("duplicate-command", timestamp, source),
      reason: `重复 commandId ${commandId}`,
    };
  }
  if (registry.timeoutCommandIds?.has(commandId)) {
    return {
      requestId,
      commandId,
      timestamp,
      executionState: "timeout",
      executionTrace: createLocalTrace("timeout", timestamp, source),
      reason: `commandId ${commandId} 在开发外部数据适配器中模拟超时`,
    };
  }
  return {
    requestId,
    commandId,
    timestamp,
    executionState: "accepted",
    executionTrace: createLocalTrace("accepted", timestamp, source),
  };
}

function createDevExternalResult(requestId, tool, statePatch, hmiSummary, visualScenario, execution) {
  return createToolResult(
    requestId, tool, true, statePatch,
    hmiSummary,
    visualScenario,
    DEV_EXTERNAL_SOURCE,
    {
      simulated: true,
      executionState: "accepted",
      commandId: execution.commandId,
      timestamp: execution.timestamp,
      observedState: {},
      requestedState: { ...statePatch },
      statePatchSource: "external-data-dev-fixture",
      executionTrace: execution.executionTrace,
    },
  );
}

function createExternalExecutionFailure(requestId, tool, execution, visualScenario = "blocked") {
  const statePatch = {
    rejected: true,
    reason: execution.reason,
    executionState: execution.executionState,
  };
  return createToolResult(
    requestId, tool, false, statePatch,
    `${execution.reason}。开发外部数据适配器未返回查询结果。`,
    visualScenario,
    DEV_EXTERNAL_SOURCE,
    {
      simulated: true,
      executionState: execution.executionState,
      commandId: execution.commandId,
      timestamp: execution.timestamp,
      observedState: {},
      executionTrace: execution.executionTrace,
      executionError: {
        code: execution.executionState,
        message: execution.reason,
        stage: "submission",
        retryable: execution.executionState === "timeout",
      },
    },
  );
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWeatherConversation(toolCall) {
  return toolCall?.tool === "conversation.general"
    && (toolCall?.args?.topic === "weather_query"
      || toolCall?.args?.externalDataType === "weather");
}

function normalizeWeatherErrorCode(value) {
  return WEATHER_ERROR_CODES.has(value) ? value : "weather_upstream_error";
}

function weatherErrorMessage(code) {
  if (code === "weather_location_not_found") return "未找到可用的天气地点。";
  if (code === "weather_location_ambiguous" || code === "weather_location_needs_clarification") {
    return "天气地点需要进一步确认。";
  }
  if (code === "missing_query" || code === "invalid_request") return "天气查询请求无效。";
  if (code === "weather_timeout") return "天气查询超时。";
  return "天气数据暂时不可用。";
}

function createWeatherFailure(toolCall, execution, code, { retryable = false, clarification = null } = {}) {
  const normalizedCode = normalizeWeatherErrorCode(code);
  const message = weatherErrorMessage(normalizedCode);
  const result = createToolResult(
    toolCall.requestId,
    toolCall.tool,
    false,
    { rejected: true, reason: message },
    message,
    "blocked",
    WEATHER_EXTERNAL_SOURCE,
    {
      simulated: false,
      executionState: "failed",
      commandId: execution.commandId,
      timestamp: execution.timestamp,
      observedState: {},
      executionError: {
        code: normalizedCode,
        message,
        stage: "execution",
        retryable,
      },
    },
  );
  // The weather service's location clarification (reference, candidates) is the evidence the
  // HMI presents; it is validated again by the weather use case before use.
  return isRecord(clarification) ? { ...result, weatherLocationClarification: clarification } : result;
}

function projectWeatherEvidence(weatherData) {
  const provider = typeof weatherData?.provider === "string" && weatherData.provider.trim()
    ? weatherData.provider.trim()
    : "open-meteo";
  const fetchedAt = typeof weatherData?.fetchedAt === "string" && weatherData.fetchedAt.trim()
    ? weatherData.fetchedAt.trim()
    : "unknown-time";
  const city = typeof weatherData?.location?.city === "string" && weatherData.location.city.trim()
    ? weatherData.location.city.trim()
    : "目标地点";
  const citation = typeof weatherData?.source === "string" && weatherData.source.trim()
    ? weatherData.source.trim()
    : "open-meteo";
  return [{
    id: `weather:${provider}:${fetchedAt}`,
    source: provider,
    type: "external-weather",
    title: `${city}天气`,
    citation,
  }];
}

export class ExternalDataAdapter {
  constructor(config = {}) {
    this.commandRegistry = config.commandRegistry || new DevCommandRegistry(config);
    this.now = config.now || this.commandRegistry.now || (() => Date.now());
    this.fetchImpl = config.fetchImpl || globalThis.fetch?.bind(globalThis);
    this.weatherEndpoint = config.weatherEndpoint || "/api/weather";
  }

  async execute(toolCall, options = {}) {
    throwIfAborted(options.signal);
    const handlers = {
      "energy.findSwapStation": () => this.findSwapStation(toolCall),
      "navigation.planRoute": () => this.planRoute(toolCall),
      ...(isWeatherConversation(toolCall)
        ? { "conversation.general": () => this.queryWeather(toolCall, options) }
        : {}),
    };
    const handler = handlers[toolCall.tool];
    if (handler) return handler();
    if (!toolCall.commandId || typeof toolCall.commandId !== "string") {
      throw new TypeError("commandId is required");
    }
    return createToolResult(
      toolCall.requestId,
      toolCall.tool || "external-data.unknown",
      false,
      {
        rejected: true,
        reason: `未知外部数据工具 ${toolCall.tool}`,
        alternative: "请改用已支持的导航或补能查询。",
      },
      `未知外部数据工具 ${toolCall.tool}，请改用已支持的导航或补能查询。`,
      "blocked",
      DEV_EXTERNAL_SOURCE,
      {
        simulated: false,
        executionState: "failed",
        commandId: toolCall.commandId,
        observedState: {
          rejected: true,
          reason: `未知外部数据工具 ${toolCall.tool}`,
        },
      },
    );
  }

  async queryWeather(toolCall, options = {}) {
    const { requestId, commandId, tool, args = {} } = toolCall;
    if (!commandId || typeof commandId !== "string") throw new TypeError("commandId is required");
    const execution = createExternalExecution(
      requestId,
      commandId,
      this.commandRegistry,
      this.now,
      WEATHER_EXTERNAL_SOURCE,
    );
    if (execution.executionState !== "accepted") {
      return createExternalExecutionFailure(requestId, tool, execution);
    }
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query || typeof this.fetchImpl !== "function") {
      return createWeatherFailure(toolCall, execution, query ? "weather_upstream_error" : "missing_query");
    }
    let response;
    try {
      response = await this.fetchImpl(this.weatherEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          ...(typeof args.location === "string" && args.location.trim() ? { location: args.location.trim() } : {}),
          ...(isRecord(args.locationContext) ? { locationContext: args.locationContext } : {}),
        }),
        signal: options.signal,
      });
      throwIfAborted(options.signal);
    } catch {
      throwIfAborted(options.signal);
      return createWeatherFailure(toolCall, execution, "weather_upstream_error", { retryable: true });
    }
    let payload;
    try {
      payload = await response.json();
      throwIfAborted(options.signal);
    } catch {
      throwIfAborted(options.signal);
      return createWeatherFailure(toolCall, execution, "weather_upstream_error", { retryable: true });
    }
    if (!response.ok || payload?.ok !== true) {
      return createWeatherFailure(toolCall, execution, payload?.error?.code, {
        retryable: response.status >= 500
          || ["weather_timeout", "weather_upstream_error"].includes(payload?.error?.code),
        clarification: payload?.error?.details?.weatherLocationClarification,
      });
    }
    if (!isRecord(payload.weatherData) || typeof payload.summary !== "string" || !payload.summary.trim()) {
      return createWeatherFailure(toolCall, execution, "weather_upstream_error", { retryable: true });
    }
    const weatherData = structuredClone(payload.weatherData);
    const result = createToolResult(
      requestId,
      tool,
      true,
      { weatherData },
      payload.summary.trim(),
      "planning",
      WEATHER_EXTERNAL_SOURCE,
      {
        simulated: false,
        executionState: "accepted",
        commandId,
        timestamp: execution.timestamp,
        observedState: {},
        statePatchSource: "weather-api-grounding",
        executionTrace: execution.executionTrace,
      },
    );
    return { ...result, evidenceRefs: projectWeatherEvidence(weatherData) };
  }

  // HC-P1-06: read-only external data placeholder. No station, queue, detour,
  // battery, distance, or duration is presented as real-time map/energy data.
  findSwapStation(toolCall) {
    const { requestId, commandId, tool, args } = toolCall;
    const execution = createExternalExecution(requestId, commandId, this.commandRegistry, this.now);
    if (execution.executionState !== "accepted") {
      return createExternalExecutionFailure(requestId, tool, execution, "energy");
    }
    const statePatch = {
      destination: args.destination,
      swapStationFound: "simulated-none",
      batteryArrivalPercent: "simulated",
      queueMinutes: "simulated",
      detourMinutes: "simulated",
    };
    return createDevExternalResult(
      requestId, tool, statePatch,
      `换电站查询：目的地 ${args.destination}（模拟结果——开发环境无真实换电站数据）。`,
      "energy",
      execution,
    );
  }

  // HC-P1-06: read-only external data placeholder. Route facts remain simulated
  // until a real routing provider is connected.
  planRoute(toolCall) {
    const { requestId, commandId, tool, args } = toolCall;
    const execution = createExternalExecution(requestId, commandId, this.commandRegistry, this.now);
    if (execution.executionState !== "accepted") {
      return createExternalExecutionFailure(requestId, tool, execution, "planning");
    }
    const statePatch = {
      origin: args.origin,
      destination: args.destination,
      distanceKm: "simulated",
      durationMinutes: "simulated",
      energyPolicy: args.energyPolicy,
    };
    return createDevExternalResult(
      requestId, tool, statePatch,
      `已规划从 ${args.origin} 到 ${args.destination} 的路线（模拟结果——开发环境无真实导航数据），补能策略：${args.energyPolicy}。`,
      "planning",
      execution,
    );
  }
}
