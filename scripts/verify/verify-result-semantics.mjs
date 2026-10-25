#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  classifyRuntimeResult,
  RUNTIME_RESULT_STATUSES,
} from "../../src/application/result-semantics.js";

// 每个状态必须落入唯一用户行为；除 awaiting_clarification 外不得索要通用参数。
const cases = [
  [{ disposition: "clarify" }, { status: "awaiting_clarification", reasonCode: "clarification-required", canClaimSuccess: false, shouldAskForSlots: true }],
  [{ outcomeStatus: "clarification" }, { status: "awaiting_clarification", reasonCode: "clarification-required", canClaimSuccess: false, shouldAskForSlots: true }],
  [{ clarificationRequest: { question: "主驾车窗打开到多少？" } }, { status: "awaiting_clarification", reasonCode: "clarification-required", canClaimSuccess: false, shouldAskForSlots: true }],
  [{ disposition: "cancel" }, { status: "cancelled", reasonCode: "cancelled", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ taskStatus: "cancelled" }, { status: "cancelled", reasonCode: "cancelled", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ reasonCode: "user-cancelled" }, { status: "cancelled", reasonCode: "cancelled", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ safetyAction: "reject" }, { status: "safety_rejected", reasonCode: "safety-rejected", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ safetyAction: "unavailable" }, { status: "safety_unavailable", reasonCode: "safety-unavailable", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ providerUnavailable: true }, { status: "provider_unavailable", reasonCode: "provider-unavailable", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ executionState: "failed" }, { status: "execution_failed", reasonCode: "execution-failed", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ executionState: "no-update" }, { status: "execution_failed", reasonCode: "execution-failed", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ executionState: "timeout" }, { status: "execution_uncertain", reasonCode: "execution-uncertain", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ retrievalStatus: "miss" }, { status: "rag_miss", reasonCode: "rag-miss", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ fallbackActive: true, retrievalStatus: "hit" }, { status: "fallback_active", reasonCode: "fallback-active", canClaimSuccess: true, shouldAskForSlots: false }],
  [{ fallbackActive: true, retrievalStatus: "miss" }, { status: "rag_miss", reasonCode: "rag-miss", canClaimSuccess: false, shouldAskForSlots: false }, "RAG miss 是业务结果，优先于模型层 fallback 标记"],
  [{ safetyAction: "reject", fallbackActive: true }, { status: "safety_rejected", reasonCode: "safety-rejected", canClaimSuccess: false, shouldAskForSlots: false }],
  [{ executionState: "observed-succeeded" }, { status: "completed", reasonCode: "", canClaimSuccess: true, shouldAskForSlots: false }],
  [{}, { status: "completed", reasonCode: "", canClaimSuccess: true, shouldAskForSlots: false }],
  [null, { status: "completed", reasonCode: "", canClaimSuccess: true, shouldAskForSlots: false }],
];

for (const [input, expected, note] of cases) {
  const actual = classifyRuntimeResult(input);
  assert.deepEqual(actual, expected, `${note || "case"} input=${JSON.stringify(input)}`);
  assert.equal(Object.isFrozen(actual), true);
}

// 状态集合封闭且唯一。
assert.equal(new Set(RUNTIME_RESULT_STATUSES).size, RUNTIME_RESULT_STATUSES.length);
for (const status of RUNTIME_RESULT_STATUSES) {
  const classification = classifyRuntimeResult({ [status === "awaiting_clarification" ? "disposition" : "safetyAction"]: undefined });
  assert.ok(classification, `status ${status} must be classified`);
}

// 除 awaiting_clarification 外，任何状态都不得索要通用参数；只有可声称成功的状态才 canClaimSuccess。
for (const status of RUNTIME_RESULT_STATUSES) {
  const caseRow = cases.find(([, expected]) => expected.status === status);
  assert.ok(caseRow, `status ${status} must appear in the table`);
  const [, expected] = caseRow;
  if (status !== "awaiting_clarification") {
    assert.equal(expected.shouldAskForSlots, false, `${status} must not ask for generic slots`);
  }
  if (expected.canClaimSuccess) {
    assert.equal(expected.status === "completed" || expected.status === "fallback_active", true,
      "only completed and fallback_active may claim success");
  }
}

console.log("result semantics verification passed");
