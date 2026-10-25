import {
  ModelProviderError,
  normalizeModelProviderResult,
} from "./model-provider-contract.js";
import { isCancellationError } from "../../runtime/abort-utils.js";
import {
  VEHICLE_SLU_COMPACT_MODEL,
  VEHICLE_SLU_COMPACT_GENERATION_PROFILE,
  VEHICLE_SLU_COMPACT_SYSTEM,
} from "../../semantic/vehicle-slu-compact-v9.js";

const PROFILES = Object.freeze({
  default: undefined,
  "compact-conversation": Object.freeze({ temperature: 0.2, num_predict: 24 }),
  "weather-composer": Object.freeze({ temperature: 0.2, num_predict: 96 }),
  "structured-agent": Object.freeze({ temperature: 0 }),
  [VEHICLE_SLU_COMPACT_GENERATION_PROFILE]: Object.freeze({ temperature: 0, num_predict: 512, num_ctx: 4096 }),
});

function resolveProfile(name) {
  const profileName = name || "default";
  if (!Object.hasOwn(PROFILES, profileName)) {
    throw new ModelProviderError("Ollama generation profile is not allowed", {
      code: "provider-request-invalid",
      provider: "ollama",
    });
  }
  return PROFILES[profileName];
}

export function createOllamaModelProvider({ client, model }) {
  async function generate({
    task,
    prompt,
    outputMode,
    jsonSchema,
    generationProfile,
    timeoutMs,
    signal,
    nonThinking = false,
  } = {}) {
    let clientInvoked = false;
    try {
      const options = resolveProfile(generationProfile);
      const compact = generationProfile === VEHICLE_SLU_COMPACT_GENERATION_PROFILE;
      if (compact && (task !== "vehicle_slu" || model !== VEHICLE_SLU_COMPACT_MODEL)) {
        throw new ModelProviderError("Compact Vehicle-SLU generation profile does not match the task or model", {
          code: "provider-request-invalid",
          provider: "ollama",
        });
      }
      clientInvoked = true;
      const generated = await client.generate({
        model,
        prompt,
        ...(compact ? { system: VEHICLE_SLU_COMPACT_SYSTEM } : {}),
        timeoutMs,
        signal,
        format: outputMode === "json-object" ? jsonSchema : undefined,
        options,
        think: nonThinking ? false : undefined,
      });
      const normalized = normalizeModelProviderResult({
        text: generated.text,
        provider: "ollama",
        model,
        durationMs: generated.durationMs,
        finishReason: generated.finishReason,
        usage: {
          inputTokens: generated.promptTokens,
          outputTokens: generated.outputTokens,
        },
        externalModelRequestCount: 1,
      });
      return Object.freeze({ ...normalized, providerTelemetry: generated.providerTelemetry });
    } catch (error) {
      const externalModelRequestCount = clientInvoked ? 1 : 0;
      if (isCancellationError(error)) {
        error.externalModelRequestCount = externalModelRequestCount;
        throw error;
      }
      if (error instanceof ModelProviderError) {
        error.externalModelRequestCount = externalModelRequestCount;
        throw error;
      }
      throw new ModelProviderError(error.message || "Ollama generation failed", {
        code: error.code || "generation-unavailable",
        provider: "ollama",
        durationMs: error._telemetry?.durationMs ?? null,
        externalModelRequestCount,
        details: {
          reasonCode: error.code || "generation-unavailable",
        },
        cause: error,
      });
    }
  }

  return Object.freeze({ id: "ollama", model, generate });
}
