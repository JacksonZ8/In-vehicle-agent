import {
  composeAbortSignals,
  createAbortError,
} from "../../runtime/abort-utils.js";

function nsToMs(value) {
  return typeof value === "number" ? Math.round(value / 1e6) : undefined;
}

export function buildOllamaDurations(data) {
  return {
    total_duration_ms: nsToMs(data.total_duration),
    load_duration_ms: nsToMs(data.load_duration),
    prompt_eval_duration_ms: nsToMs(data.prompt_eval_duration),
    eval_duration_ms: nsToMs(data.eval_duration),
    prompt_eval_count: data.prompt_eval_count,
    eval_count: data.eval_count,
  };
}

function classifyOllamaGenerateFailure({ status, upstreamBody, hasSchemaFormat }) {
  const safeSignal = String(upstreamBody || "").slice(0, 2_000).toLowerCase();
  if (hasSchemaFormat
    && [400, 422, 500].includes(status)
    && /schema|grammar|format|json.*constraint|constraint.*json/.test(safeSignal)) {
    return "format-schema-rejected";
  }
  return "generation-unavailable";
}

function formatOllamaError(error, context, baseUrl) {
  if (error.name === "AbortError" && Number.isFinite(error.timeoutMs)) {
    return `${context} timeout after ${error.timeoutMs}ms; Ollama may be starting, loading the model, or busy`;
  }
  if (error.cause?.code === "ECONNREFUSED") {
    return `${context} connection refused at ${baseUrl}; is Ollama running?`;
  }
  return `${context} failed: ${error.message}`;
}

export function createOllamaGenerateClient({ baseUrl, keepAlive, fetchImpl, scheduler } = {}) {
  const timerScheduler = scheduler || {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
  };

  async function generate({ model, prompt, system, timeoutMs, format, options, think, signal }) {
    const startedAt = Date.now();
    const hasWatchdog = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const timeoutController = hasWatchdog ? new AbortController() : null;
    let timedOut = false;
    const timeout = timeoutController
      ? timerScheduler.setTimeout(() => {
        timedOut = true;
        timeoutController.abort(createAbortError(`Ollama generate ${model} timeout`));
      }, timeoutMs)
      : null;
    const abortScope = composeAbortSignals([signal, timeoutController?.signal]);

    try {
      const result = await (fetchImpl || globalThis.fetch)(new URL("/api/generate", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          ...(typeof system === "string" ? { system } : {}),
          stream: false,
          keep_alive: keepAlive,
          ...(options ? { options } : {}),
          ...(format ? { format } : {}),
          ...(think !== undefined ? { think } : {}),
        }),
        signal: abortScope.signal,
      });

      if (!result.ok) {
        const upstreamBody = await result.text().catch(() => "");
        const upstreamError = new Error(`HTTP ${result.status}`);
        upstreamError.code = classifyOllamaGenerateFailure({
          status: result.status,
          upstreamBody,
          hasSchemaFormat: Boolean(format && typeof format === "object"),
        });
        throw upstreamError;
      }

      const data = await result.json();
      const durationMs = Date.now() - startedAt;
      const providerTelemetry = {
        ollamaDurations: buildOllamaDurations(data),
        keepAlive,
      };
      if (typeof data.response !== "string" || !data.response.trim()) {
        const emptyResponseError = new Error(`empty response from model ${model}${data.done_reason ? ` (done_reason=${data.done_reason})` : ""}`);
        emptyResponseError._telemetry = { durationMs, ...providerTelemetry };
        throw emptyResponseError;
      }

      return {
        text: data.response,
        finishReason: data.done_reason || null,
        promptTokens: data.prompt_eval_count ?? null,
        outputTokens: data.eval_count ?? null,
        durationMs,
        providerTelemetry,
      };
    } catch (error) {
      if (signal?.aborted) throw createAbortError(signal.reason);
      const failureCode = timedOut
        ? "generation-timeout"
        : typeof error.code === "string"
          ? error.code
          : "generation-unavailable";
      if (timedOut) error.timeoutMs = timeoutMs;
      const formattedError = new Error(formatOllamaError(error, `Ollama generate ${model}`, baseUrl));
      formattedError.code = failureCode;
      formattedError._telemetry = error._telemetry || {
        durationMs: Date.now() - startedAt,
        ollamaDurations: {},
        keepAlive,
      };
      throw formattedError;
    } finally {
      if (timeout !== null) timerScheduler.clearTimeout(timeout);
      abortScope.dispose();
    }
  }

  return Object.freeze({ generate });
}
