import assert from "node:assert/strict";
import { B4_BENCHMARK_SCENARIOS } from "../../src/benchmark/run-benchmark-scenarios.js";
import { calculateAcceptanceCallBudget } from "../lib/b3-b4-cloud-call-budget.mjs";

const functional = calculateAcceptanceCallBudget({
  scenarioIds: Object.keys(B4_BENCHMARK_SCENARIOS),
  repeats: 1,
  includeWarmup: false,
  includeInterruptVerifier: true,
});
assert.equal(functional.maxExternalModelRequests, 8);
assert.equal(functional.interruptVerifierExternalModelRequests, 0);

const candidate = calculateAcceptanceCallBudget({
  scenarioIds: Object.keys(B4_BENCHMARK_SCENARIOS),
  repeats: 3,
  includeWarmup: true,
  includeInterruptVerifier: false,
});
assert.equal(candidate.maxExternalModelRequests, 28);

assert.throws(
  () => calculateAcceptanceCallBudget({
    scenarioIds: ["missing-scenario"], repeats: 1, includeWarmup: false, includeInterruptVerifier: false,
  }),
  /unknown benchmark scenario/i,
);
assert.throws(
  () => calculateAcceptanceCallBudget({
    scenarioIds: ["conversation-general"], repeats: 0, includeWarmup: false, includeInterruptVerifier: false,
  }),
  /repeats must be a positive integer/i,
);

console.log(JSON.stringify({
  status: "PASS",
  verifier: "b3-b4-cloud-call-budget",
  functional: functional.maxExternalModelRequests,
  candidate: candidate.maxExternalModelRequests,
  interruptVerifierExternalModelRequests: functional.interruptVerifierExternalModelRequests,
}));
