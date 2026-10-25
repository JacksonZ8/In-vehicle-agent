import { B4_BENCHMARK_SCENARIOS, validateBenchmarkScenario } from "../../src/benchmark/run-benchmark-scenarios.js";

const WARMUP_SCENARIO_IDS = Object.freeze(["conversation-general", "vehicle-knowledge"]);

function calculateScenarioRequests(scenarioId) {
  const scenario = B4_BENCHMARK_SCENARIOS[scenarioId];
  if (!scenario) throw new TypeError(`unknown benchmark scenario: ${scenarioId}`);
  const errors = validateBenchmarkScenario(scenario);
  if (errors.length > 0) throw new TypeError(`invalid benchmark scenario ${scenarioId}: ${errors.join("; ")}`);
  return scenario.modelBudget.maxCalls;
}

function validateRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("call budget input must be an object");
  }
  if (!Array.isArray(input.scenarioIds) || input.scenarioIds.length === 0) {
    throw new TypeError("scenarioIds must be a non-empty array");
  }
  if (!Number.isInteger(input.repeats) || input.repeats <= 0) {
    throw new TypeError("repeats must be a positive integer");
  }
  if (typeof input.includeWarmup !== "boolean") throw new TypeError("includeWarmup must be a boolean");
  if (typeof input.includeInterruptVerifier !== "boolean") {
    throw new TypeError("includeInterruptVerifier must be a boolean");
  }
}

export function calculateAcceptanceCallBudget(input) {
  validateRequest(input);
  const measuredExternalModelRequests = input.scenarioIds
    .reduce((total, scenarioId) => total + calculateScenarioRequests(scenarioId), 0) * input.repeats;
  const warmupExternalModelRequests = input.includeWarmup
    ? WARMUP_SCENARIO_IDS.reduce((total, scenarioId) => total + calculateScenarioRequests(scenarioId), 0)
    : 0;
  const interruptVerifierExternalModelRequests = input.includeInterruptVerifier ? 0 : 0;

  return Object.freeze({
    maxExternalModelRequests: measuredExternalModelRequests + warmupExternalModelRequests + interruptVerifierExternalModelRequests,
    measuredExternalModelRequests,
    warmupExternalModelRequests,
    interruptVerifierExternalModelRequests,
  });
}
