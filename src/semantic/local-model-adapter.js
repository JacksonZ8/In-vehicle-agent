import {
  composeAbortSignals,
  createAbortError,
  throwIfAborted,
} from "../runtime/abort-utils.js";
import {
  createVehicleSluEnvelope,
  VEHICLE_SLU_CONTRACT,
  VEHICLE_SLU_PROMPT_VERSION,
} from "./vehicle-slu-contract.js";
import { projectVehicleSluEnvelope } from "./vehicle-slu-projector.js";
import { projectVehicleSluConversationContext } from "./vehicle-slu-conversation-context.js";
import { isVehicleSluCompactModel, VEHICLE_SLU_COMPACT_PROMPT_VERSION } from "./vehicle-slu-compact-v9.js";
import { projectVehicleSluPendingSummary } from "./vehicle-slu-prompt.js";

const FAIL_CLOSED_COMMAND = deepFreeze({
  requestId: "",
  rawText: "",
  source: "vehicle-slu-fail-closed",
  confidence: 0,
  intent: "conversation.general",
  speechAct: "statement",
  actionability: {
    actionable: false,
    reason: "semantic-unavailable",
    source: "vehicle-slu-fail-closed",
    intendedIntent: "conversation.general",
  },
  slots: {},
  slotProvenance: {},
  conversationGoal: {
    summary: "语义解析暂不可用",
    requiresReply: true,
    interactionType: "general_qa",
    domain: "general",
    goal: "语义解析暂不可用",
    source: "vehicle-slu-fail-closed",
  },
});

const STABLE_FAILURE_REASONS = new Set([
  "semantic-contract-invalid",
  "semantic-endpoint-unavailable",
  "semantic-model-unavailable",
  "semantic-timeout",
]);

const MODEL_PROVIDER_IDS = new Set(["ollama", "dashscope"]);
const PUBLIC_TASK_MODES = new Set(["legacy", "non-thinking"]);
const MAX_EXTERNAL_MODEL_REQUEST_COUNT = 3;

const TELEMETRY_KEYS = Object.freeze([
  "runtime",
  "provider",
  "model",
  "modelType",
  "contractVersion",
  "promptVersion",
  "promptChars",
  "durationMs",
  "semanticDecisionMs",
  "firstModelTokenMs",
  "firstModelTokenStatus",
  "slowStage",
  "watchdogMs",
  "ollamaDurations",
  "degraded",
  "fallbackActive",
  "fallbackAttempted",
  "primaryFailureReasonCode",
  "providerFailureReasonCode",
  "externalModelRequestCount",
]);

const OLLAMA_DURATION_KEYS = Object.freeze([
  "total_duration_ms",
  "load_duration_ms",
  "prompt_eval_duration_ms",
  "eval_duration_ms",
  "prompt_eval_count",
  "eval_count",
]);

export class LocalModelAdapter {
  constructor(config = {}) {
    this.endpoint = config.endpoint || globalThis?.NIO_LOCAL_MODEL_ENDPOINT || "";
    this.watchdogMs = normalizeOptionalWatchdogMs(
      Object.hasOwn(config, "watchdogMs")
        ? config.watchdogMs
        : globalThis?.NIO_LOCAL_MODEL_WATCHDOG_MS,
    );
    this.model = config.model || globalThis?.NIO_LOCAL_MODEL_NAME || "local-semantic-parser";
    this.providerProfile = normalizeVehicleSluProviderProfile(config.providerProfile);
    this.fetchImpl = config.fetchImpl || ((...args) => globalThis.fetch(...args));
    this.scheduler = config.scheduler || {
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
    };
  }

  async parse(rawText, options = {}) {
    throwIfAborted(options.signal);
    const startedAt = Date.now();

    if (!this.providerProfile) {
      return failClosed("semantic-model-unavailable", {
        provider: "model-provider-profile",
        model: this.model,
        modelType: "vehicle-slu",
        contractVersion: VEHICLE_SLU_CONTRACT.ref,
        durationMs: Date.now() - startedAt,
        watchdogMs: this.watchdogMs,
      });
    }

    if (!this.endpoint) {
      return failClosed("semantic-endpoint-unavailable", {
        provider: "local-semantic-endpoint",
        model: this.model,
        modelType: "vehicle-slu",
        contractVersion: VEHICLE_SLU_CONTRACT.ref,
        durationMs: Date.now() - startedAt,
        watchdogMs: this.watchdogMs,
      });
    }

    try {
      const json = await this.fetchWithWatchdog(rawText, options);
      throwIfAborted(options.signal);
      const responseShape = validateEndpointResponse(json, this.providerProfile);
      if (responseShape.failure) {
        return failClosed(responseShape.reasonCode, json.telemetry, startedAt);
      }
      const semanticEnvelope = createVehicleSluEnvelope(json.semanticEnvelope);
      if (options.requestId && semanticEnvelope.requestId !== options.requestId) {
        throw new TypeError("Vehicle-SLU requestId mismatch");
      }
      const { parsedCommand: command } = projectVehicleSluEnvelope(semanticEnvelope);
      return {
        semanticEnvelope,
        command,
        executionDisabled: false,
        reasonCode: "",
        telemetry: sanitizeTelemetry(json.telemetry, startedAt),
      };
    } catch (error) {
      if (options.signal?.aborted) {
        throw createAbortError(options.signal?.reason ?? error?.reason ?? error);
      }
      return failClosed(error.reasonCode || "semantic-contract-invalid", {
        provider: "local-semantic-endpoint",
        model: this.model,
        modelType: "vehicle-slu",
        contractVersion: VEHICLE_SLU_CONTRACT.ref,
        watchdogMs: this.watchdogMs,
      }, startedAt);
    }
  }

  async fetchWithWatchdog(rawText, options = {}) {
    const watchdogController = this.watchdogMs === null ? null : new AbortController();
    const watchdog = watchdogController
      ? this.scheduler.setTimeout(
        () => watchdogController.abort(createAbortError("local semantic watchdog expired")),
        this.watchdogMs,
      )
      : null;
    const composed = composeAbortSignals([options.signal, watchdogController?.signal]);
    try {
      throwIfAborted(composed.signal);
      const pending = projectVehicleSluPendingSummary(options.pending);
      const conversationContext = projectVehicleSluConversationContext(options.conversationContext);
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          requestId: options.requestId,
          task: "vehicle_semantic_parse",
          text: rawText,
          lastVehicleIntent: options.lastVehicleIntent || "",
          ...(pending ? { pending } : {}),
          ...(conversationContext ? { conversationContext } : {}),
        }),
        signal: composed.signal,
      });
      throwIfAborted(composed.signal);
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.reasonCode = "semantic-endpoint-unavailable";
        throw error;
      }
      let json;
      try {
        json = await response.json();
      } catch (error) {
        error.reasonCode = "semantic-contract-invalid";
        throw error;
      }
      throwIfAborted(composed.signal);
      return json;
    } catch (error) {
      if (options.signal?.aborted) throw createAbortError(options.signal.reason);
      if (watchdogController?.signal.aborted) {
        const watchdogError = new Error(error?.message || "local semantic endpoint watchdog expired");
        watchdogError.cause = error;
        watchdogError.reasonCode = "semantic-endpoint-unavailable";
        throw watchdogError;
      }
      if (!error.reasonCode) error.reasonCode = "semantic-endpoint-unavailable";
      throw error;
    } finally {
      composed.dispose();
      if (watchdog !== null) this.scheduler.clearTimeout(watchdog);
    }
  }
}

function validateEndpointResponse(value, providerProfile) {
  if (!isPlainObject(value)) throw new TypeError("local semantic response must be an object");
  if (value.semanticEnvelope === null) {
    if (value.executionDisabled !== true || !STABLE_FAILURE_REASONS.has(value.reasonCode)) {
      throw new TypeError("invalid local semantic failure response");
    }
    assertAllowedKeys(value, ["model", "semanticEnvelope", "executionDisabled", "reasonCode", "telemetry"]);
    validateEndpointTelemetry(value.model, value.telemetry, { degraded: true, providerProfile });
    return { failure: true, reasonCode: value.reasonCode };
  }
  assertAllowedKeys(value, ["model", "semanticEnvelope", "telemetry"]);
  validateEndpointTelemetry(value.model, value.telemetry, { degraded: false, providerProfile });
  return { failure: false };
}

function validateEndpointTelemetry(model, telemetry, { degraded, providerProfile }) {
  if (!safeToken(model) || !isPlainObject(telemetry)) {
    throw new TypeError("local semantic response requires model and telemetry");
  }
  const fallbackActive = optionalBoolean(telemetry, "fallbackActive");
  const fallbackAttempted = optionalBoolean(telemetry, "fallbackAttempted");
  const fallbackIdentity = fallbackActive === true || fallbackAttempted === true;
  const compact = isVehicleSluCompactModel(providerProfile);
  const expectedPromptVersion = compact ? VEHICLE_SLU_COMPACT_PROMPT_VERSION : VEHICLE_SLU_PROMPT_VERSION;
  if (!safeProviderToken(telemetry.provider)
    || !safeToken(telemetry.model)
    || model !== telemetry.model
    || telemetry.modelType !== "vehicle-slu"
    || telemetry.contractVersion !== VEHICLE_SLU_CONTRACT.ref
    || telemetry.promptVersion !== expectedPromptVersion
    || telemetry.degraded !== degraded) {
    throw new TypeError("local semantic telemetry provenance mismatch");
  }
  if (fallbackActive === true && fallbackAttempted === true) {
    throw new TypeError("local semantic telemetry fallback state is inconsistent");
  }
  if (fallbackIdentity) {
    if (!providerProfile.fallbackConfigured) {
      throw new TypeError("local semantic telemetry uses an unconfigured fallback");
    }
  } else if (telemetry.provider !== providerProfile.provider
    || telemetry.model !== providerProfile.model) {
    throw new TypeError("local semantic telemetry primary provenance mismatch");
  }
  if (fallbackAttempted === true && !degraded) {
    throw new TypeError("local semantic success cannot claim a failed fallback attempt");
  }
  validateSafeTelemetryFields(telemetry);
  if (!isNonNegativeFinite(telemetry.promptChars)
    || !isNonNegativeFinite(telemetry.durationMs)
    || telemetry.semanticDecisionMs !== telemetry.durationMs
    || telemetry.firstModelTokenMs !== null
    || telemetry.firstModelTokenStatus !== "unobservable-non-streaming"
    || telemetry.slowStage !== (telemetry.semanticDecisionMs > 3_000 ? "semantic-decision" : null)
    || !isOptionalWatchdogMs(telemetry.watchdogMs)
    || !isPlainObject(telemetry.ollamaDurations)) {
    throw new TypeError("invalid local semantic telemetry structure");
  }
}

function normalizeVehicleSluProviderProfile(value) {
  if (!isPlainObject(value)
    || !MODEL_PROVIDER_IDS.has(value.provider)
    || !safeToken(value.provider)
    || !safeToken(value.model)
    || !PUBLIC_TASK_MODES.has(value.mode)
    || value.schemaVersion !== VEHICLE_SLU_CONTRACT.ref
    || typeof value.fallbackConfigured !== "boolean"
    || (isVehicleSluCompactModel(value) && (value.mode !== "non-thinking" || value.fallbackConfigured))
    || !isOptionalProfileWatchdogMs(value.watchdogMs)
    || !isPlainObject(value.readiness)
    || value.readiness.status !== "ready") return null;
  return deepFreeze({
    provider: value.provider,
    model: value.model,
    mode: value.mode,
    schemaVersion: value.schemaVersion,
    fallbackConfigured: value.fallbackConfigured,
    watchdogMs: value.watchdogMs,
    readiness: { status: "ready" },
  });
}

function validateSafeTelemetryFields(telemetry) {
  for (const key of ["primaryFailureReasonCode", "providerFailureReasonCode"]) {
    if (Object.hasOwn(telemetry, key) && !safeToken(telemetry[key])) {
      throw new TypeError(`invalid local semantic telemetry ${key}`);
    }
  }
  if (Object.hasOwn(telemetry, "externalModelRequestCount")
    && (!Number.isSafeInteger(telemetry.externalModelRequestCount)
      || telemetry.externalModelRequestCount < 0
      || telemetry.externalModelRequestCount > MAX_EXTERNAL_MODEL_REQUEST_COUNT)) {
    throw new TypeError("invalid local semantic telemetry externalModelRequestCount");
  }
}

function optionalBoolean(value, key) {
  if (!Object.hasOwn(value, key)) return undefined;
  if (typeof value[key] !== "boolean") {
    throw new TypeError(`invalid local semantic telemetry ${key}`);
  }
  return value[key];
}

function failClosed(reasonCode, telemetry = {}, startedAt) {
  const stableReason = STABLE_FAILURE_REASONS.has(reasonCode)
    ? reasonCode
    : "semantic-contract-invalid";
  return {
    semanticEnvelope: null,
    command: FAIL_CLOSED_COMMAND,
    executionDisabled: true,
    reasonCode: stableReason,
    telemetry: {
      ...sanitizeTelemetry(telemetry, startedAt),
      degraded: true,
    },
  };
}

function sanitizeTelemetry(value, startedAt) {
  const source = isPlainObject(value) ? value : {};
  const telemetry = {};
  for (const key of TELEMETRY_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const entry = source[key];
    if (entry === null || ["string", "boolean"].includes(typeof entry)
      || (typeof entry === "number" && Number.isFinite(entry))) {
      telemetry[key] = entry;
    } else if (key === "ollamaDurations" && isPlainObject(entry)) {
      telemetry[key] = sanitizeOllamaDurations(entry);
    }
  }
  if (!Object.hasOwn(telemetry, "durationMs") && startedAt !== undefined) {
    telemetry.durationMs = Date.now() - startedAt;
  }
  return telemetry;
}

function sanitizeOllamaDurations(value) {
  return Object.fromEntries(OLLAMA_DURATION_KEYS.flatMap((key) => {
    const entry = value[key];
    return isNonNegativeFinite(entry) ? [[key, entry]] : [];
  }));
}

function isNonNegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeOptionalWatchdogMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const watchdogMs = Math.floor(Number(value));
  return Number.isFinite(watchdogMs) && watchdogMs > 0 ? watchdogMs : null;
}

function isOptionalWatchdogMs(value) {
  return value === null
    || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function isOptionalProfileWatchdogMs(value) {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}

function safeToken(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && value.trim() === value
    && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value);
}

function safeProviderToken(value) {
  return MODEL_PROVIDER_IDS.has(value) && safeToken(value);
}

function assertAllowedKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("local semantic response contains unexpected fields");
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
