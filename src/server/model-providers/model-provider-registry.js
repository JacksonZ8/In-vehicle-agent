import { isVehicleSluCompactModel } from "../../semantic/vehicle-slu-compact-v9.js";
import { createDashScopeModelProvider } from "./dashscope-model-provider.js";
import {
  boundExternalModelRequestCount,
  ModelProviderError,
} from "./model-provider-contract.js";
import { createOllamaModelProvider } from "./ollama-model-provider.js";
import {
  APPROVED_MODEL_IDS_BY_PROVIDER,
  MODEL_TASK_IDS,
  projectPublicModelTaskProfileSet,
} from "./model-task-profile.js";

const MODEL_TASK_ID_SET = new Set(MODEL_TASK_IDS);

const FALLBACK_ERROR_CODES = Object.freeze(new Set([
  "provider-config-invalid",
  "provider-auth-failed",
  "provider-invalid-request",
  "provider-unavailable",
  "provider-network-error",
  "provider-response-invalid",
  "provider-schema-invalid-after-repair",
]));

const NON_FALLBACK_REASON_CODES = Object.freeze(new Set([
  "clarification-required",
  "low-confidence-clarification",
  "rag-miss",
  "safety-rejected",
  "capability-unavailable",
  "provider-safety-refusal",
  "provider-request-budget-exhausted",
  "user-cancelled",
]));

function createProviderError(profile, reasonCode = "provider-config-invalid") {
  const provider = typeof profile?.provider === "string" ? profile.provider : "unknown";
  return new ModelProviderError("Model Provider configuration is invalid", {
    code: reasonCode,
    provider,
    details: { reasonCode, retryable: false },
  });
}

function createBlockedProvider(profile, reasonCode = "provider-config-invalid") {
  const provider = typeof profile?.provider === "string" ? profile.provider : "unknown";
  return Object.freeze({
    id: provider,
    model: typeof profile?.model === "string" && profile.model ? profile.model : "unknown",
    async generate() {
      throw createProviderError(profile, reasonCode);
    },
  });
}

function isSupportedProfile(profile) {
  if (isVehicleSluCompactModel(profile)) {
    return profile.task === "vehicle_slu"
      && profile.mode === "non-thinking"
      && profile.schemaVersion === "nio-vehicle-slu-contract@2.0.0"
      && !profile.fallback;
  }
  return Boolean(
    profile
      && typeof profile.provider === "string"
      && typeof profile.model === "string"
      && APPROVED_MODEL_IDS_BY_PROVIDER[profile.provider]?.includes(profile.model),
  );
}

function userCancelledError(provider, externalModelRequestCount = 0) {
  return new ModelProviderError("Model request was cancelled by the user", {
    code: "user-cancelled",
    provider: provider?.id || "unknown",
    externalModelRequestCount,
    details: { reasonCode: "user-cancelled", retryable: false },
  });
}

function normalizeExternalModelRequestLimit(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("externalModelRequestLimit must be a positive integer or null");
  }
  return value;
}

function requestBudgetExhaustedError(provider, externalModelRequestCount) {
  return new ModelProviderError("Model Provider request budget is exhausted", {
    code: "provider-request-budget-exhausted",
    provider: provider?.id || "unknown",
    externalModelRequestCount,
    details: {
      reasonCode: "provider-request-budget-exhausted",
      retryable: false,
    },
  });
}

function assertRequestBudgetAvailable(provider, limit, externalModelRequestCount) {
  if (limit !== null && externalModelRequestCount >= limit) {
    throw requestBudgetExhaustedError(provider, externalModelRequestCount);
  }
}

function failureReasonCode(error) {
  return typeof error?.details?.reasonCode === "string"
    ? error.details.reasonCode
    : typeof error?.code === "string" ? error.code : "provider-unavailable";
}

function shouldFallback(error, primary, fallback) {
  const reasonCode = failureReasonCode(error);
  if (reasonCode === "provider-auth-failed") {
    return fallback?.id !== primary?.id;
  }
  return !NON_FALLBACK_REASON_CODES.has(reasonCode)
    && FALLBACK_ERROR_CODES.has(error?.code);
}

function resultWithFallbackState(result, fallbackState) {
  return Object.freeze({ ...result, ...fallbackState });
}

function structuredOutputContract(request) {
  const contract = request?.structuredOutput;
  return contract
    && typeof contract.validate === "function"
    && typeof contract.repairPrompt === "function"
    ? contract
    : null;
}

function structuredValidationErrors(result, contract) {
  if (!contract?.validate) return [];
  try {
    const outcome = contract.validate(result?.text);
    if (outcome === false || outcome?.ok === false) {
      const errors = Array.isArray(outcome?.errors) ? outcome.errors : [];
      return errors.length ? errors : ["structured output validation failed"];
    }
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : "structured output validation failed"];
  }
}

function schemaInvalidAfterRepairError(provider, externalModelRequestCount) {
  return new ModelProviderError("Model Provider output is invalid after one schema repair", {
    code: "provider-schema-invalid-after-repair",
    provider: provider?.id || "unknown",
    externalModelRequestCount,
    details: {
      reasonCode: "provider-schema-invalid-after-repair",
      retryable: false,
    },
  });
}

function annotateFallbackFailure(error, {
  fallback,
  primaryFailureReasonCode,
  externalModelRequestCount,
}) {
  if (!error || typeof error !== "object") return error;
  error.provider = fallback.id;
  error.model = fallback.model;
  error.externalModelRequestCount = externalModelRequestCount;
  error.fallbackAttempted = true;
  error.primaryFailureReasonCode = primaryFailureReasonCode;
  return error;
}

export function createModelProviderRegistry({
  taskProfiles = {},
  connections = {},
  fetchImpl,
  providerFactories = {},
  publicProfiles,
} = {}) {
  const providers = new Map();
  const fallbackProviders = new Map();

  const defaultFactories = {
    ollama: ({ profile, connection }) => createOllamaModelProvider({
      client: connection.client,
      model: profile.model,
    }),
    dashscope: ({ profile, connection }) => createDashScopeModelProvider({
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl,
      model: profile.model,
      fetchImpl,
    }),
  };

  function createProvider(profile) {
    const connection = connections[profile?.provider];
    if (!isSupportedProfile(profile)
      || profile?.readiness?.status === "blocked"
      || connection?.readiness?.status !== "ready") {
      return createBlockedProvider(profile);
    }
    const factory = providerFactories[profile.provider] || defaultFactories[profile.provider];
    return typeof factory === "function"
      ? factory({ profile, connection })
      : createBlockedProvider(profile);
  }

  function requireProfile(task) {
    if (!MODEL_TASK_ID_SET.has(task)) {
      throw createProviderError({ provider: "unknown", model: "unknown" });
    }
    const profile = taskProfiles[task];
    if (!profile) throw createProviderError({ provider: "unknown", model: "unknown" });
    return profile;
  }

  function providerFor(task) {
    const profile = requireProfile(task);
    if (!providers.has(task)) providers.set(task, createProvider(profile));
    return providers.get(task);
  }

  function profileFor(task) {
    return requireProfile(task);
  }

  function fallbackProviderFor(task, profile) {
    if (!profile.fallback) return null;
    if (!fallbackProviders.has(task)) {
      fallbackProviders.set(task, createProvider({
        ...profile.fallback,
        task,
        watchdogMs: profile.watchdogMs,
      }));
    }
    return fallbackProviders.get(task);
  }

  async function callProvider(provider, profile, request) {
    const {
      externalModelRequestLimit: _ignoredExternalModelRequestLimit,
      primaryFailureReasonCode: _ignoredPrimaryFailureReasonCode,
      timeoutMs: _ignoredTimeoutMs,
      watchdogMs: _ignoredWatchdogMs,
      structuredOutput: _structuredOutput,
      ...trustedRequest
    } = request || {};
    return provider.generate({
      ...trustedRequest,
      ...(provider.id === "dashscope"
        ? { watchdogMs: profile.watchdogMs }
        : { timeoutMs: profile.watchdogMs, nonThinking: profile.mode === "non-thinking" }),
    });
  }

  async function generateFallbackForTask(task, request = {}) {
    const profile = requireProfile(task);
    const primary = providerFor(task);
    const fallback = fallbackProviderFor(task, profile);
    if (!fallback || fallback.id === primary.id) {
      throw createProviderError(profile, "provider-response-invalid");
    }
    if (request.signal?.aborted) throw userCancelledError(primary);

    const externalModelRequestLimit = normalizeExternalModelRequestLimit(
      request.externalModelRequestLimit,
    );
    assertRequestBudgetAvailable(primary, externalModelRequestLimit, 0);

    try {
      const result = await callProvider(fallback, profile, request);
      if (request.signal?.aborted) {
        throw userCancelledError(fallback, result?.externalModelRequestCount);
      }
      return resultWithFallbackState(result, {
        fallbackActive: true,
        primaryFailureReasonCode: "provider-response-invalid",
      });
    } catch (fallbackError) {
      const externalModelRequestCount = boundExternalModelRequestCount(
        fallbackError?.externalModelRequestCount,
      );
      if (request.signal?.aborted || fallbackError?.code === "user-cancelled") {
        throw userCancelledError(fallback, externalModelRequestCount);
      }
      throw annotateFallbackFailure(fallbackError, {
        fallback,
        primaryFailureReasonCode: "provider-response-invalid",
        externalModelRequestCount,
      });
    }
  }

  async function callPrimaryWithRepair(primary, profile, request, externalModelRequestLimit) {
    const contract = structuredOutputContract(request);
    const initial = await callProvider(primary, profile, request);
    const initialErrors = structuredValidationErrors(initial, contract);
    if (initialErrors.length === 0) return initial;

    const initialRequestCount = boundExternalModelRequestCount(
      initial?.externalModelRequestCount,
    );
    if (request.signal?.aborted) {
      throw userCancelledError(primary, initialRequestCount);
    }
    assertRequestBudgetAvailable(primary, externalModelRequestLimit, initialRequestCount);

    let repaired;
    try {
      repaired = await callProvider(primary, profile, {
        ...request,
        prompt: contract.repairPrompt({
          prompt: request.prompt,
          validationErrors: initialErrors,
        }),
      });
    } catch (repairError) {
      if (repairError && typeof repairError === "object") {
        repairError.externalModelRequestCount = boundExternalModelRequestCount(
          initialRequestCount
            + boundExternalModelRequestCount(repairError.externalModelRequestCount),
        );
      }
      throw repairError;
    }

    const repairedRequestCount = boundExternalModelRequestCount(
      initialRequestCount + boundExternalModelRequestCount(repaired?.externalModelRequestCount),
    );
    if (request.signal?.aborted) {
      throw userCancelledError(primary, repairedRequestCount);
    }
    if (structuredValidationErrors(repaired, contract).length > 0) {
      throw schemaInvalidAfterRepairError(primary, repairedRequestCount);
    }
    return resultWithFallbackState(repaired, {
      externalModelRequestCount: repairedRequestCount,
    });
  }

  async function generateForTask(task, request = {}) {
    const profile = profileFor(task);
    const primary = providerFor(task);
    const externalModelRequestLimit = normalizeExternalModelRequestLimit(
      request.externalModelRequestLimit,
    );
    if (request.signal?.aborted) throw userCancelledError(primary);

    // Vehicle-SLU has one semantic producer attempt; schema errors fail closed at its boundary.
    if (task === "vehicle_slu") {
      let result;
      try {
        result = await callProvider(primary, profile, request);
      } catch (error) {
        if (request.signal?.aborted) {
          throw userCancelledError(primary, error?.externalModelRequestCount);
        }
        throw error;
      }
      if (request.signal?.aborted) {
        throw userCancelledError(primary, result?.externalModelRequestCount);
      }
      return resultWithFallbackState(result, { fallbackActive: false });
    }

    try {
      const result = await callPrimaryWithRepair(
        primary,
        profile,
        request,
        externalModelRequestLimit,
      );
      if (request.signal?.aborted) {
        throw userCancelledError(primary, result?.externalModelRequestCount);
      }
      return resultWithFallbackState(result, { fallbackActive: false });
    } catch (primaryError) {
      const primaryRequestCount = boundExternalModelRequestCount(
        primaryError?.externalModelRequestCount,
      );
      if (request.signal?.aborted || primaryError?.code === "user-cancelled") {
        throw userCancelledError(primary, primaryRequestCount);
      }
      const fallback = fallbackProviderFor(task, profile);
      if (!fallback || !shouldFallback(primaryError, primary, fallback)) throw primaryError;
      assertRequestBudgetAvailable(primary, externalModelRequestLimit, primaryRequestCount);

      let result;
      try {
        result = await callProvider(fallback, profile, request);
      } catch (fallbackError) {
        const externalModelRequestCount = boundExternalModelRequestCount(
          primaryRequestCount
            + boundExternalModelRequestCount(fallbackError?.externalModelRequestCount),
        );
        if (request.signal?.aborted || fallbackError?.code === "user-cancelled") {
          throw userCancelledError(fallback, externalModelRequestCount);
        }
        throw annotateFallbackFailure(fallbackError, {
          fallback,
          primaryFailureReasonCode: primaryError.code,
          externalModelRequestCount,
        });
      }
      const externalModelRequestCount = boundExternalModelRequestCount(
        primaryRequestCount + boundExternalModelRequestCount(result?.externalModelRequestCount),
      );
      if (request.signal?.aborted) {
        throw userCancelledError(fallback, externalModelRequestCount);
      }
      const contract = structuredOutputContract(request);
      if (structuredValidationErrors(result, contract).length > 0) {
        throw annotateFallbackFailure(
          schemaInvalidAfterRepairError(fallback, externalModelRequestCount),
          {
            fallback,
            primaryFailureReasonCode: primaryError.code,
            externalModelRequestCount,
          },
        );
      }
      return resultWithFallbackState(result, {
        fallbackActive: true,
        primaryFailureReasonCode: primaryError.code,
        externalModelRequestCount,
      });
    }
  }

  return Object.freeze({
    providerFor,
    profileFor,
    generateForTask,
    generateFallbackForTask,
    publicProfiles: projectPublicModelTaskProfileSet(publicProfiles),
  });
}
