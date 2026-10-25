export const MODEL_PROVIDER_IDS = Object.freeze(["ollama", "dashscope"]);
export const GENERATION_PROFILES = Object.freeze([
  "default",
  "compact-conversation",
  "weather-composer",
  "structured-agent",
  "vehicle-slu-compact-v9",
]);

const USAGE_FIELDS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
]);

const ERROR_DETAIL_FIELDS = Object.freeze([
  "reasonCode",
  "retryable",
  "errorType",
  "upstreamStatus",
  "requestId",
]);

const MAX_STRUCTURED_EXTERNAL_MODEL_REQUESTS = 3;

export function boundExternalModelRequestCount(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_STRUCTURED_EXTERNAL_MODEL_REQUESTS)
    : 0;
}

function sanitizeDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }

  const sanitized = {};
  for (const field of ERROR_DETAIL_FIELDS) {
    const value = details[field];
    if (
      typeof value === "string"
      || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
    ) {
      sanitized[field] = value;
    }
  }
  return Object.keys(sanitized).length ? Object.freeze(sanitized) : null;
}

export class ModelProviderError extends Error {
  constructor(message, {
    code = "provider-unavailable",
    provider = "unknown",
    status = null,
    durationMs = null,
    externalModelRequestCount = 0,
    details = null,
    cause,
  } = {}) {
    super(message, { cause });
    this.name = "ModelProviderError";
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.durationMs = durationMs;
    this.externalModelRequestCount = boundExternalModelRequestCount(externalModelRequestCount);
    this.details = sanitizeDetails(details);
  }
}

function normalizeUsageCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function normalizeModelProviderResult(input = {}) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) {
    throw new ModelProviderError("Model Provider returned empty text", {
      code: "provider-response-invalid",
      provider: typeof input.provider === "string" ? input.provider : "unknown",
    });
  }

  const sourceUsage = input.usage && typeof input.usage === "object" ? input.usage : {};
  const usage = Object.fromEntries(
    USAGE_FIELDS.map((field) => [field, normalizeUsageCount(sourceUsage[field])]),
  );
  usage.unavailableReason = USAGE_FIELDS.some((field) => usage[field] === null)
    ? "provider-usage-unavailable"
    : null;

  return Object.freeze({
    text,
    provider: typeof input.provider === "string" ? input.provider : "unknown",
    model: typeof input.model === "string" ? input.model : "unknown",
    durationMs: normalizeUsageCount(input.durationMs),
    finishReason: typeof input.finishReason === "string" ? input.finishReason : null,
    usage: Object.freeze(usage),
    externalModelRequestCount: boundExternalModelRequestCount(input.externalModelRequestCount),
  });
}
