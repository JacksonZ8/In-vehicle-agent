import {
  ModelProviderError,
  normalizeModelProviderResult,
} from "./model-provider-contract.js";
import { composeAbortSignals } from "../../runtime/abort-utils.js";

const VEHICLE_KNOWLEDGE_MAX_COMPLETION_TOKENS = 768;
const SAFETY_REFUSAL_SIGNALS = Object.freeze(new Set([
  "contentfilter",
  "safetyrefusal",
  "providersafetyrefusal",
  "datainspectionfailed",
  "riskcontent",
]));

const DASHSCOPE_UNSUPPORTED_TOOL_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "maxLength",
  "maximum",
  "minLength",
  "minimum",
  "pattern",
  "uniqueItems",
]);
const DASHSCOPE_JSON_SCHEMA_UNSUPPORTED_KEYS = new Set([
  "maxLength",
  "maximum",
  "minLength",
  "minimum",
  "pattern",
  "uniqueItems",
]);

export function projectDashScopeToolSchema(value, parentKey = "") {
  if (Array.isArray(value)) {
    if (parentKey === "type" && value.includes("null")) {
      const concreteTypes = value.filter((entry) => entry !== "null");
      if (concreteTypes.length === 1) return concreteTypes[0];
    }
    return value.map((entry) => projectDashScopeToolSchema(entry));
  }
  if (!value || typeof value !== "object") return value;

  const projected = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DASHSCOPE_UNSUPPORTED_TOOL_SCHEMA_KEYS.has(key)) continue;
    if (key === "const") {
      projected.enum = [entry];
      continue;
    }
    projected[key] = projectDashScopeToolSchema(entry, key);
  }
  return projected;
}

function projectDashScopeJsonSchema(value) {
  if (Array.isArray(value)) return value.map(projectDashScopeJsonSchema);
  if (!value || typeof value !== "object") return value;

  const projected = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DASHSCOPE_JSON_SCHEMA_UNSUPPORTED_KEYS.has(key)) continue;
    if (key === "const") {
      projected.enum = [entry];
      continue;
    }
    projected[key] = projectDashScopeJsonSchema(entry);
  }
  return projected;
}

function normalizeProviderSignal(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function hasExplicitSafetyRefusalSignal(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return [payload.code, payload.type, payload.error?.code, payload.error?.type]
    .some((value) => SAFETY_REFUSAL_SIGNALS.has(normalizeProviderSignal(value)));
}

function reasonCodeForStatus(status) {
  if (status === 401 || status === 403) return "provider-auth-failed";
  if (status === 429) return "provider-rate-limited";
  if (status === 400 || status === 422) return "provider-invalid-request";
  return "provider-unavailable";
}

function createProviderError({
  code,
  durationMs,
  externalModelRequestCount,
  status = null,
  errorType,
}) {
  return new ModelProviderError("DashScope generation failed", {
    code,
    provider: "dashscope",
    status,
    durationMs,
    externalModelRequestCount,
    details: {
      reasonCode: code,
      retryable: [
        "provider-rate-limited",
        "provider-unavailable",
        "provider-network-error",
        "generation-timeout",
      ].includes(code),
      errorType,
      ...(typeof status === "number" ? { upstreamStatus: status } : {}),
    },
  });
}

function buildRequestBody({ model, prompt, outputMode, jsonSchema, generationProfile, task }) {
  if (outputMode === "json-object" && jsonSchema && task === "vehicle_slu") {
    return {
      model,
      messages: [{ role: "user", content: prompt }],
      enable_thinking: false,
      stream: false,
      tools: [{
        type: "function",
        function: {
          name: "vehicle_slu",
          description: "将车载指令解析为 Vehicle-SLU 2.0 结构化语义",
          parameters: projectDashScopeToolSchema(jsonSchema),
        },
      }],
      tool_choice: { type: "function", function: { name: "vehicle_slu" } },
    };
  }
  const useStrictKnowledgeSchema = outputMode === "json-object"
    && task === "b3_vehicle_knowledge_synthesis"
    && jsonSchema
    && /^qwen3\.8-(?:flash|max)(?:-|$)/i.test(model);
  if (useStrictKnowledgeSchema) {
    return {
      model,
      messages: [{ role: "user", content: prompt }],
      enable_thinking: false,
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "knowledge_answer_draft",
          strict: true,
          schema: projectDashScopeJsonSchema(jsonSchema),
        },
      },
    };
  }
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    enable_thinking: false,
    stream: false,
    ...(outputMode === "json-object"
      ? {
          response_format: { type: "json_object" },
          ...(task === "b3_vehicle_knowledge_synthesis"
            ? { max_completion_tokens: VEHICLE_KNOWLEDGE_MAX_COMPLETION_TOKENS }
            : {}),
        }
      : generationProfile === "compact-conversation"
        ? { max_completion_tokens: 24 }
        : generationProfile === "weather-composer"
          ? { max_completion_tokens: 96 }
          : {}),
  };
}

async function discardUpstreamBody(response) {
  const body = await response.text().catch(() => "");
  try {
    return hasExplicitSafetyRefusalSignal(JSON.parse(body));
  } catch {
    return false;
  }
}

function awaitWithAbort(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => settle(
      reject,
      new DOMException("The operation was aborted", "AbortError"),
    );

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (settled) return undefined;
        if (signal?.aborted) {
          abort();
          return undefined;
        }
        return operation();
      })
      .then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error),
      );
  });
}

function normalizeDashScopeResponse(data, { model, durationMs, externalModelRequestCount }) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  if (choice?.finish_reason === "content_filter") {
    throw createProviderError({
      code: "provider-safety-refusal",
      durationMs,
      externalModelRequestCount,
      errorType: "safety-refusal",
    });
  }
  const toolArguments = choice?.message?.tool_calls?.[0]?.function?.arguments;
  const content = typeof toolArguments === "string" && toolArguments.trim()
    ? toolArguments
    : choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw createProviderError({
      code: "provider-response-invalid",
      durationMs,
      externalModelRequestCount,
      errorType: "invalid-response",
    });
  }

  return normalizeModelProviderResult({
    text: content,
    provider: "dashscope",
    model,
    durationMs,
    externalModelRequestCount,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage: {
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    },
  });
}

export function createDashScopeModelProvider({
  apiKey,
  baseUrl,
  model,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  scheduler = globalThis,
}) {
  async function generate({
    task,
    prompt,
    outputMode,
    jsonSchema,
    generationProfile,
    watchdogMs,
    signal,
  } = {}) {
    const startedAt = now();
    const hasWatchdog = Number.isSafeInteger(watchdogMs) && watchdogMs > 0;
    const timeoutController = hasWatchdog ? new AbortController() : null;
    let timedOut = false;
    let externalModelRequestCount = 0;
    const timeout = timeoutController
      ? scheduler.setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, watchdogMs)
      : null;
    const abortScope = composeAbortSignals([signal, timeoutController?.signal]);

    try {
      const response = await awaitWithAbort(() => {
        externalModelRequestCount = 1;
        return fetchImpl(
          new URL("chat/completions", `${baseUrl}/`),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(buildRequestBody({ model, prompt, outputMode, jsonSchema, generationProfile, task })),
            signal: abortScope.signal,
          },
        );
      }, abortScope.signal);

      if (!response.ok) {
        const safetyRefusal = await awaitWithAbort(
          () => discardUpstreamBody(response),
          abortScope.signal,
        );
        throw createProviderError({
          code: safetyRefusal
            ? "provider-safety-refusal"
            : reasonCodeForStatus(response.status),
          durationMs: now() - startedAt,
          externalModelRequestCount,
          status: response.status,
          errorType: safetyRefusal ? "safety-refusal" : "upstream-http",
        });
      }

      let data;
      try {
        data = await awaitWithAbort(() => response.json(), abortScope.signal);
      } catch {
        throw createProviderError({
          code: "provider-response-invalid",
          durationMs: now() - startedAt,
          externalModelRequestCount,
          errorType: "invalid-response",
        });
      }

      return normalizeDashScopeResponse(data, {
        model,
        durationMs: now() - startedAt,
        externalModelRequestCount,
      });
    } catch (error) {
      const durationMs = now() - startedAt;
      if (signal?.aborted) {
        throw createProviderError({
          code: "cancelled",
          durationMs,
          externalModelRequestCount,
          errorType: "external-cancellation",
        });
      }
      if (timedOut || timeoutController?.signal.aborted) {
        throw createProviderError({
          code: "generation-timeout",
          durationMs,
          externalModelRequestCount,
          errorType: "timeout",
        });
      }
      if (error instanceof ModelProviderError) throw error;
      throw createProviderError({
        code: "provider-network-error",
        durationMs,
        externalModelRequestCount,
        errorType: "network",
      });
    } finally {
      if (timeout !== null) scheduler.clearTimeout(timeout);
      abortScope.dispose();
    }
  }

  return Object.freeze({ id: "dashscope", model, generate });
}
