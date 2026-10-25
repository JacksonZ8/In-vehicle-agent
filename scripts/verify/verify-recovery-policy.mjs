import assert from "node:assert/strict";
import {
  authorizeRecovery,
  createCapabilityFailure,
  RECOVERY_ACTIONS,
} from "../../src/interaction/recovery-policy.js";
import { OrchestratorController } from "../../src/agents/orchestrator-controller.js";
import { CloudLLMAdapter } from "../../src/runtime/cloud-llm-adapter.js";
import {
  buildStructuredAgentJsonSchema,
  buildStructuredAgentPrompt,
  getStructuredValidationDetail,
} from "../../src/server/local-agent-server.mjs";

const turnContext = Object.freeze({
  availableActions: Object.freeze([
    "retry-readonly",
    "continue-with-partial-facts",
    "ask-user",
    "degrade",
    "stop",
  ]),
  cancelled: false,
});

function failure(overrides = {}) {
  return createCapabilityFailure({
    failureId: "failure:run-1:manual",
    sessionId: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    stage: "capability-execution",
    capabilityId: "manual.retrieve",
    reasonCode: "model-timeout",
    retryable: true,
    sideEffectClass: "readonly",
    attempt: 1,
    remainingBudgetMs: 2_000,
    partialFacts: [],
    structuredRepairCount: 0,
    transportRetryCount: 0,
    ...overrides,
  });
}

function authorize(capabilityFailure, action, overrides = {}) {
  return authorizeRecovery({
    failure: capabilityFailure,
    proposal: { action, reasonCode: `proposal-${action}` },
    turnContext,
    attemptTimeoutMs: 1_000,
    ...overrides,
  });
}

assert.deepEqual([...RECOVERY_ACTIONS], [
  "retry-readonly",
  "continue-with-partial-facts",
  "ask-user",
  "degrade",
  "stop",
]);

const readonlyTimeout = failure();
assert.equal(authorize(readonlyTimeout, "retry-readonly").authorized, true);
assert.equal(authorize(
  failure({ attempt: 2 }),
  "retry-readonly",
).authorized, false);
assert.equal(authorize(
  failure({ reasonCode: "evidence-miss", retryable: false }),
  "retry-readonly",
).reasonCode, "evidence-miss-not-retryable");
assert.equal(authorize(
  failure({ reasonCode: "safety-blocked", retryable: false }),
  "retry-readonly",
).reasonCode, "safety-outcome-not-failure");
assert.equal(authorize(
  failure({ capabilityId: "vehicle.window.set-position", sideEffectClass: "vehicle-write" }),
  "retry-readonly",
).reasonCode, "vehicle-write-never-auto-retried");
assert.equal(authorize(
  failure({ reasonCode: "turn-cancelled", retryable: false }),
  "retry-readonly",
).reasonCode, "turn-cancelled");
assert.equal(authorize(
  failure({ remainingBudgetMs: 999 }),
  "retry-readonly",
).reasonCode, "insufficient-recovery-budget");
assert.equal(authorize(
  readonlyTimeout,
  "retry-readonly",
  { turnContext: { ...turnContext, availableActions: ["degrade", "stop"] } },
).reasonCode, "proposal-not-available");
assert.equal(authorize(
  failure({ structuredRepairCount: 1 }),
  "retry-readonly",
).reasonCode, "request-budget-exhausted");
assert.equal(authorize(
  failure({ transportRetryCount: 1 }),
  "retry-readonly",
).reasonCode, "request-budget-exhausted");
assert.throws(
  () => failure({ structuredRepairCount: 1, transportRetryCount: 1 }),
  /shared request budget/i,
);
assert.throws(
  () => failure({ partialFacts: [{ rawModelResponse: "SECRET" }] }),
  /private model or credential fields/i,
);
for (const sensitiveKey of [
  "token",
  "id_token",
  "auth-token",
  "apiKey",
  "x-api-key",
  "access_token",
  "refresh-token",
  "password",
  "passwd",
  "cookie",
  "set-cookie",
  "sessionToken",
  "bearer",
  "privateKey",
  "client_secret",
  "credential",
  "modelOutput",
  "raw_model_output",
  "model-response",
  "rawResponse",
  "raw-output",
  "completion",
  "raw_completion",
  "systemPrompt",
  "promptText",
  "system_prompt_text",
  "chain_of_thought",
  "authorizationHeader",
]) {
  assert.throws(
    () => failure({ partialFacts: [{ nested: { [sensitiveKey]: "SECRET" } }] }),
    /private model or credential fields/i,
    `partialFacts must reject normalized sensitive key ${sensitiveKey}`,
  );
}
assert.deepEqual(
  failure({ partialFacts: [{ usage: { tokenCount: 24 } }] }).partialFacts,
  [{ usage: { tokenCount: 24 } }],
  "token suffix filtering must not reject non-secret tokenCount telemetry",
);
assert.throws(
  () => authorize(readonlyTimeout, "invented-action"),
  /proposal action/i,
);

const partialFacts = [{ kind: "manual-evidence", id: "evidence-1" }];
const immutableFailure = failure({ partialFacts });
partialFacts[0].id = "mutated";
assert.equal(immutableFailure.partialFacts[0].id, "evidence-1");
assert.equal(Object.isFrozen(immutableFailure), true);
assert.equal(Object.isFrozen(immutableFailure.partialFacts), true);

const nonRetryDecision = authorize(readonlyTimeout, "degrade");
assert.equal(nonRetryDecision.authorized, true);
assert.equal(nonRetryDecision.action, "degrade");
assert.equal(nonRetryDecision.policyVersion, "nio-recovery-policy@1.0.0");

const proposalModel = {
  calls: [],
  async createTaskPlan() {
    throw new Error("not used");
  },
  async proposeRecovery(input) {
    this.calls.push(input);
    return {
      output: { action: "retry-readonly", reasonCode: "transient-read-failure" },
      telemetry: {
        provider: "ollama",
        model: "qwen2.5:7b",
        durationMs: 12,
        degraded: false,
        structuredRetryCount: 0,
        rawModelResponse: "must-not-leak",
      },
    };
  },
};
const orchestrator = new OrchestratorController({ modelAdapter: proposalModel });
const proposed = await orchestrator.proposeRecovery({
  failure: readonlyTimeout,
  availableActions: ["retry-readonly", "degrade", "stop"],
});
assert.deepEqual(proposed.proposal, {
  action: "retry-readonly",
  reasonCode: "transient-read-failure",
});
assert.equal(proposed.validation.ok, true);
assert.equal(proposalModel.calls.length, 1);
assert.deepEqual(proposalModel.calls[0].availableActions, [
  "retry-readonly",
  "degrade",
  "stop",
]);
assert.equal(Object.isFrozen(proposalModel.calls[0].availableActions), true);
assert.equal("authorization" in proposed, false);
assert.equal(JSON.stringify(proposed).includes("rawModelResponse"), false);

proposalModel.proposeRecovery = async () => ({
  output: { action: "invented-action", reasonCode: "ignore-policy" },
  telemetry: { degraded: false },
});
const invalidProposal = await orchestrator.proposeRecovery({
  failure: readonlyTimeout,
  availableActions: ["degrade", "stop"],
});
assert.equal(invalidProposal.proposal, null);
assert.equal(invalidProposal.validation.ok, false);

assert.equal(
  authorize(failure({ partialFacts: [{ kind: "manual-evidence", id: "fact-1" }] }), "continue-with-partial-facts").reasonCode,
  "partial-facts-authorized",
);
assert.equal(
  authorize(failure({ partialFacts: [] }), "continue-with-partial-facts").reasonCode,
  "partial-facts-unavailable",
);
assert.equal(
  authorize(readonlyTimeout, "retry-readonly", {
    turnContext: { ...turnContext, cancelled: true },
  }).reasonCode,
  "turn-cancelled",
);
const abortedTurn = new AbortController();
abortedTurn.abort("recovery-user-cancelled");
assert.equal(
  authorize(readonlyTimeout, "retry-readonly", {
    turnContext: { ...turnContext, signal: abortedTurn.signal },
  }).reasonCode,
  "turn-cancelled",
);
assert.equal(
  authorize(failure({ attempt: 2 }), "retry-readonly").reasonCode,
  "recovery-attempt-limit",
);
assert.equal(
  authorize(failure({ remainingBudgetMs: 999 }), "retry-readonly").reasonCode,
  "insufficient-recovery-budget",
);
assert.equal(
  Object.hasOwn(createCapabilityFailure({ ...readonlyTimeout, prompt: "must-not-project" }), "prompt"),
  false,
  "unknown top-level private fields must not enter the public failure contract",
);

const schema = buildStructuredAgentJsonSchema({
  task: "b3_recovery_proposal",
  availableActions: ["retry-readonly", "degrade", "stop"],
});
assert.deepEqual(schema.required, ["action", "reasonCode"]);
assert.deepEqual(schema.properties.action.enum, ["retry-readonly", "degrade", "stop"]);
assert.equal(
  getStructuredValidationDetail(
    {
      task: "b3_recovery_proposal",
      availableActions: ["retry-readonly", "degrade", "stop"],
    },
    { action: "retry-readonly", reasonCode: "transient-read-failure" },
  ).reasonCode,
  "",
);
assert.equal(
  getStructuredValidationDetail(
    {
      task: "b3_recovery_proposal",
      availableActions: ["degrade", "stop"],
    },
    { action: "retry-readonly", reasonCode: "ignore-caller-actions" },
  ).reasonCode,
  "recovery-proposal-invalid",
);
assert.match(
  buildStructuredAgentPrompt({
    task: "b3_recovery_proposal",
    failure: readonlyTimeout,
    availableActions: ["degrade", "stop"],
  }),
  /only.*availableActions/i,
);

const originalFetch = globalThis.fetch;
const transportBodies = [];
globalThis.fetch = async (_url, options) => {
  transportBodies.push(JSON.parse(options.body));
  return {
    ok: true,
    async json() {
      return {
        output: { action: "degrade", reasonCode: "bounded-fallback" },
        telemetry: { provider: "ollama", structuredRetryCount: 0 },
      };
    },
  };
};
try {
  const adapter = new CloudLLMAdapter({
    endpoint: "http://127.0.0.1:4173/api/local-llm",
    structuredTimeoutMs: 1_000,
  });
  const adapterResult = await adapter.proposeRecovery({
    failure: readonlyTimeout,
    availableActions: ["degrade", "stop"],
  });
  assert.equal(adapterResult.output.action, "degrade");
  assert.equal(transportBodies.length, 1);
  assert.equal(transportBodies[0].task, "b3_recovery_proposal");
  assert.deepEqual(transportBodies[0].availableActions, ["degrade", "stop"]);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Recovery policy verifier passed.");
