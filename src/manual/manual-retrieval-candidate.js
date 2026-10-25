import {
  composeAbortSignals,
  throwIfAborted,
} from "../runtime/abort-utils.js";

export const MANUAL_RETRIEVAL_CANDIDATE_MISMATCH = "manual-retrieval-candidate-mismatch";

export function normalizeManualCandidateQuery(value) {
  return String(value || "").trim().replaceAll(/\s+/g, " ");
}

export function prepareManualRetrievalCandidate({
  runId,
  query,
  vehicleModel = "ES8",
  signal,
  retrieve,
  validateResult = (result) => result,
  onConsume = () => {},
  monotonicNow = () => globalThis.performance.now(),
} = {}) {
  const binding = Object.freeze({
    runId: requireText(runId, "runId"),
    query: requireText(normalizeManualCandidateQuery(query), "query"),
    vehicleModel: requireText(vehicleModel, "vehicleModel"),
  });
  if (typeof retrieve !== "function") throw new TypeError("retrieve must be a function");
  if (typeof validateResult !== "function") throw new TypeError("validateResult must be a function");
  if (typeof onConsume !== "function") throw new TypeError("onConsume must be a function");
  if (typeof monotonicNow !== "function") throw new TypeError("monotonicNow must be a function");
  throwIfAborted(signal);

  const privateController = new AbortController();
  const composed = composeAbortSignals([signal, privateController.signal]);
  const startedAt = monotonicNow();
  let state = "pending";
  let invocation;
  try {
    invocation = retrieve(binding.query, {
      runId: binding.runId,
      vehicleModel: binding.vehicleModel,
      signal: composed.signal,
    });
  } catch (error) {
    invocation = Promise.reject(error);
  }
  const outcomePromise = Promise.resolve(invocation).then(
    (result) => Object.freeze({
      status: "fulfilled",
      result,
      durationMs: measuredDuration(startedAt, monotonicNow()),
    }),
    (error) => Object.freeze({
      status: "rejected",
      error,
      durationMs: measuredDuration(startedAt, monotonicNow()),
    }),
  );

  return Object.freeze({
    async consume(input = {}) {
      if (state === "discarded") throw candidateError("manual-retrieval-candidate-discarded");
      if (state === "consumed") throw candidateError("manual-retrieval-candidate-consumed");
      const requestedBinding = {
        runId: String(input.runId || "").trim(),
        query: normalizeManualCandidateQuery(input.query),
        vehicleModel: String(input.vehicleModel || "").trim(),
      };
      if (requestedBinding.runId !== binding.runId
        || requestedBinding.query !== binding.query
        || requestedBinding.vehicleModel !== binding.vehicleModel) {
        throw candidateError(MANUAL_RETRIEVAL_CANDIDATE_MISMATCH);
      }
      state = "consumed";
      try {
        throwIfAborted(composed.signal);
        const outcome = await outcomePromise;
        throwIfAborted(composed.signal);
        if (outcome.status === "rejected") throw outcome.error;
        const result = validateResult(outcome.result);
        onConsume(result);
        return Object.freeze({ result, durationMs: outcome.durationMs });
      } finally {
        composed.dispose();
      }
    },

    discard(reasonCode = "manual-retrieval-candidate-discarded") {
      if (state !== "pending") return false;
      state = "discarded";
      if (!privateController.signal.aborted) privateController.abort(reasonCode);
      composed.dispose();
      return true;
    },
  });
}

function candidateError(code) {
  const error = new Error(code);
  error.name = code === "manual-retrieval-candidate-discarded" ? "AbortError" : "Error";
  error.code = code;
  if (error.name === "AbortError") error.reason = code;
  return error;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function measuredDuration(startedAt, endedAt) {
  const durationMs = Number(endedAt) - Number(startedAt);
  return Number.isFinite(durationMs) && durationMs >= 0
    ? Math.min(2_147_483_647, Math.round(durationMs))
    : 0;
}
