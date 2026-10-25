// 结果语义归一化：运行时终态映射到唯一用户行为。
// 对应 spec 13 的结果语义表；safety_unavailable 由 Sensor 唯一事实源（spec 12）引入。
// 除 awaiting_clarification 外，任何状态都不应触发"请补充需要执行的具体参数"类话术。

export const RUNTIME_RESULT_STATUSES = Object.freeze([
  "awaiting_clarification",
  "rag_miss",
  "safety_rejected",
  "safety_unavailable",
  "cancelled",
  "fallback_active",
  "provider_unavailable",
  "execution_failed",
  "execution_uncertain",
  "completed",
]);

const CANCELLED_REASONS = Object.freeze(["cancelled", "user-cancelled", "route-cancelled", "superseded-before-start"]);

export function classifyRuntimeResult(input = {}) {
  const {
    disposition = null,
    taskStatus = null,
    outcomeStatus = null,
    clarificationRequest = null,
    safetyAction = null,
    executionState = null,
    retrievalStatus = null,
    fallbackActive = false,
    providerUnavailable = false,
    reasonCode = null,
  } = isRecord(input) ? input : {};

  if (disposition === "clarify" || clarificationRequest || outcomeStatus === "clarification") {
    return result("awaiting_clarification", "clarification-required", false, true);
  }
  if (disposition === "cancel" || taskStatus === "cancelled" || CANCELLED_REASONS.includes(reasonCode)) {
    return result("cancelled", "cancelled", false, false);
  }
  if (safetyAction === "reject") return result("safety_rejected", "safety-rejected", false, false);
  if (safetyAction === "unavailable") return result("safety_unavailable", "safety-unavailable", false, false);
  if (providerUnavailable) return result("provider_unavailable", "provider-unavailable", false, false);
  if (executionState === "failed" || executionState === "no-update") {
    return result("execution_failed", "execution-failed", false, false);
  }
  if (executionState === "timeout") return result("execution_uncertain", "execution-uncertain", false, false);
  if (retrievalStatus === "miss") return result("rag_miss", "rag-miss", false, false);
  if (fallbackActive === true) return result("fallback_active", "fallback-active", true, false);
  return result("completed", "", true, false);
}

function result(status, reasonCode, canClaimSuccess, shouldAskForSlots) {
  return Object.freeze({ status, reasonCode, canClaimSuccess, shouldAskForSlots });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
