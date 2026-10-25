#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  createExecutionFacts,
  createGoalEnvelope,
  createTaskPlan,
} from "../../src/agents/agent-contracts.js";
import { createTaskSnapshot } from "../../src/application/background-task-coordinator.js";
import { RuntimeKernel } from "../../src/application/runtime-kernel.js";
import { createRouteDecision } from "../../src/application/route-policy.js";
import {
  createComplexTaskUseCase,
  createManualRetrieveCapabilityOwner,
} from "../../src/application/use-cases/complex-task.js";
import { InteractionSessionController } from "../../src/interaction/interaction-session-controller.js";
import { InteractionSessionLedger } from "../../src/interaction/interaction-session-ledger.js";
import { RunEventLedger } from "../../src/runtime/run-event-ledger.js";
import { RUN_EVENT_PROTOCOL } from "../../src/runtime/run-event-protocol.js";
import {
  createTrustedSlotProvenance,
  isTrustedRequiredSlotProvenance,
} from "../../src/runtime/agent-schemas.js";
import { SessionMemory } from "../../src/runtime/session-memory.js";
import { createTaskPlanExecution } from "../../src/runtime/task-plan-execution.js";
import { createManualRagConsumerEvidence } from "../../src/manual/manual-evidence-eligibility.js";
import { createVehicleSluEnvelope } from "../../src/semantic/vehicle-slu-contract.js";
import { createVehicleSluGoalEnvelope } from "../../src/semantic/vehicle-slu-orchestration.js";
import {
  countCalls,
  createLeanRuntimeVehicleControlHarness,
} from "../lib/lean-runtime-test-harness.mjs";

const fixedNow = () => Date.parse("2026-08-05T02:00:00.000Z");

assert.deepEqual(RUN_EVENT_PROTOCOL, { id: "nio-run-event", version: "2.0.0" });

const readRunId = "run:complex:handoff";
const readGoal = goal(readRunId, "manual", "question");
const readPlan = plan(readRunId, readGoal.goalId, [
  step("manual", "manual.retrieve", [], "read", { query: "ES8 尾门开启条件" }),
  step("response", "response.synthesize", ["manual"], "read", {
    facts: { summary: "基于已完成步骤回答", evidenceRefs: [] },
  }),
]);
const calls = [];
const events = [];
const readUseCase = createUseCase({
  goalEnvelope: readGoal,
  taskPlan: readPlan,
  calls,
  capabilityOwners: {
    "manual.retrieve": {
      async execute(input) {
        calls.push({ name: "manual.execute", input });
        return {
          summary: "驾驶员应先确认车辆静止且后方空间安全。",
          evidenceRefs: [{ id: "manual:tailgate", source: "manual", type: "manual" }],
        };
      },
    },
  },
});
const readPending = readUseCase.execute(context(readRunId, events));
assert.equal(events.length >= 1, true, "accepted progress must be emitted synchronously");
assert.deepEqual(projectEvent(events[0]), {
  component: "responsePresentation",
  phase: "task-snapshot",
  status: "queued",
  summary: "已收到目标，正在确定处理路径",
  currentStage: "accepted",
});
const readResult = await readPending;
assert.equal(readResult.assistantResponse, "已根据执行事实完成回答。");
assert.equal(readResult.taskSnapshot.status, "completed");
assert.equal(events.at(-1).status, "completed");
assert.equal(events.at(-1).metadata.task.snapshot, readResult.taskSnapshot);
assert.deepEqual(readResult.modelCalls.map((call) => call.phase), [
  "goal-formation", "task-planning", "final-synthesis",
]);
assert.deepEqual(calls.map((call) => call.name), [
  "cabin.formGoal", "orchestrator.plan", "manual.execute", "cabin.synthesize",
]);
assert.equal(calls.filter((call) => call.name === "cabin.synthesize").length, 1);
assert.equal(calls.some((call) => call.name === "response.execute"), false);
assert.equal(readResult.executionFacts.completionStatus, "completed");
assert.equal(readResult.committedEffects.length, 0);
assert.deepEqual(projectComplexCausalOrder(events), [
  "goal-formation:cabinModel",
  "goal-formation:cabinAssistant",
  "task-planning:orchestratorModel",
  "task-planning:orchestrator",
  "task-snapshot:execution-or-waiting",
  "final-synthesis:cabinModel",
  "final-synthesis:cabinAssistant",
  "task-snapshot:terminal",
]);
assert.equal(events.some((event) => event.metadata?.task?.snapshot?.currentStage === "planning"), true);
assert.equal(events.some((event) => event.metadata?.task?.snapshot?.currentStage === "waiting"), true);
assert.equal(events.some((event) => /%|思考链/.test(event.summary)), false);

const unavailableRunId = "run:complex:manual-unavailable";
const unavailableGoal = goal(unavailableRunId, "manual", "question");
const unavailablePlan = plan(unavailableRunId, unavailableGoal.goalId, [
  step("manual", "manual.retrieve", [], "read", { query: "ES8 车窗初始化" }),
  step("response", "response.synthesize", ["manual"], "read", {
    facts: { summary: "基于已完成步骤回答", evidenceRefs: [] },
  }),
]);
const unavailableEvidence = createManualRagConsumerEvidence({
  query: "ES8 车窗初始化",
  runId: "manual-rag:unavailable",
  status: "unavailable",
  evidence: [],
  summary: "",
  reason: "embedding-unavailable",
  telemetry: { embeddingStatus: "unavailable", rawError: "must-not-propagate" },
});
const unavailableUseCase = createUseCase({
  goalEnvelope: unavailableGoal,
  taskPlan: unavailablePlan,
  calls: [],
  capabilityOwners: {
    "manual.retrieve": createManualRetrieveCapabilityOwner({
      manualRetriever: async () => unavailableEvidence,
      projectEvidenceRef: () => {
        throw new Error("unavailable evidence must not be projected as a hit");
      },
    }),
  },
});
const unavailableResult = await unavailableUseCase.execute(context(unavailableRunId, []));
const unavailableManualStep = unavailableResult.executionFacts.stepResults.find(
  (item) => item.capabilityId === "manual.retrieve",
);
assert.deepEqual(unavailableManualStep.result, {
  status: "unavailable",
  reason: "embedding-unavailable",
  summary: "手册检索当前不可用。",
});
assert.equal(JSON.stringify(unavailableManualStep).includes("rawError"), false);

const vehicleRunId = "run:complex:vehicle-owner";
const vehicleGoal = goal(vehicleRunId, "vehicle-control", "command");
const vehiclePlan = plan(vehicleRunId, vehicleGoal.goalId, [
  step("safety", "safety.evaluate", [], "read", { action: "window-position" }),
  step("window", "vehicle.window.set-position", ["safety"], "write", {
    zone: "driver", percent: 40,
  }),
  step("response", "response.synthesize", ["window"], "read", {
    facts: { summary: "车窗执行结果", evidenceRefs: [] },
  }),
]);
const vehicleCalls = [];
const vehicleControl = {
  async execute(input) {
    vehicleCalls.push(input);
    assert.equal(Object.hasOwn(input, "safetyDecision"), false);
    assert.equal(Object.hasOwn(input, "toolCall"), false);
    assert.equal(input.parsedCommand.intent, "body.window.setPosition");
    assert.deepEqual(input.parsedCommand.slots, { zone: "driver", percent: 40 });
    assert.equal(input.parsedCommand.speechAct, "command");
    assert.equal(input.parsedCommand.actionability.actionable, true);
    return {
      toolResult: {
        requestId: vehicleRunId,
        commandId: `${vehicleRunId}:1:body.window.setPosition`,
        tool: "body.window.setPosition",
        ok: true,
        executionState: "observed-succeeded",
        confirmedSnapshotId: "snapshot:confirmed",
        hmiSummary: "主驾车窗已调整到 40%。",
        visualScenario: "vehicle-control",
        source: "vehicle-execution-coordinator",
        simulated: true,
        timestamp: "2026-08-05T02:00:00.000Z",
      },
      vehicleStateSnapshot: {
        id: "snapshot:confirmed",
        values: { windowPositionPercentByZone: { driver: 40 } },
      },
    };
  },
};
const vehicleUseCase = createUseCase({
  goalEnvelope: vehicleGoal,
  taskPlan: vehiclePlan,
  calls: [],
  vehicleControl,
  capabilityOwners: {
    "safety.evaluate": {
      async execute() {
        return {
          safetyDecision: {
            allowed: true,
            action: "allow",
            reason: "规划阶段的 Safety 前置检查已通过。",
            alternative: "",
            reasonCode: "allowed",
            vehicleStateSnapshotId: "snapshot:planning",
            policyId: "window-policy",
          },
        };
      },
    },
  },
});
const vehicleAuthority = {
  requestId: vehicleRunId,
  intent: "body.window.setPosition",
  speechAct: "command",
  actionability: { actionable: true, reason: "explicit-command" },
  slots: { zone: "driver", percent: 40 },
  slotProvenance: { zone: "explicit", percent: "explicit" },
};
const vehicleResult = await vehicleUseCase.execute(context(vehicleRunId, [], {
  parsedCommand: vehicleAuthority,
}));
assert.equal(vehicleCalls.length, 1, "the injected Task 5 owner must be the only vehicle-write boundary");
assert.deepEqual(vehicleCalls[0].parsedCommand.slotProvenance, {
  zone: "explicit",
  percent: "explicit",
});
assert.equal(vehicleResult.executionFacts.toolResult.commandId, `${vehicleRunId}:1:body.window.setPosition`);
assert.equal(vehicleResult.executionFacts.confirmedVehicleState.id, "snapshot:confirmed");
assert.equal(vehicleResult.committedEffects.length, 1);
assert.equal(vehicleResult.committedEffects[0].commandId, `${vehicleRunId}:1:body.window.setPosition`);

await assert.rejects(
  vehicleUseCase.execute(context(vehicleRunId, [], {
    parsedCommand: {
      ...vehicleAuthority,
      slots: { zone: "driver", percent: 41 },
    },
  })),
  /must exactly match the normalized command authority/,
);
await assert.rejects(
  vehicleUseCase.execute(context(vehicleRunId, [], {
    parsedCommand: {
      ...vehicleAuthority,
      slotProvenance: { zone: "explicit" },
    },
  })),
  /trusted required-slot provenance/,
);
assert.equal(vehicleCalls.length, 1, "invalid command authority must fail before Task 5 dispatch");
for (const untrustedSource of ["context", "memory-reference", "context-memory", "unknown"]) {
  assert.equal(
    isTrustedRequiredSlotProvenance(untrustedSource, { contextTrusted: false }),
    false,
  );
  await assert.rejects(
    vehicleUseCase.execute(context(vehicleRunId, [], {
      parsedCommand: {
        ...vehicleAuthority,
        slotProvenance: { zone: untrustedSource, percent: untrustedSource },
      },
    })),
    /trusted required-slot provenance/,
    `${untrustedSource} must not authorize an orchestrated vehicle write`,
  );
}
assert.equal(isTrustedRequiredSlotProvenance("explicit"), true);
assert.equal(isTrustedRequiredSlotProvenance("context"), true);
assert.equal(isTrustedRequiredSlotProvenance("context", { contextTrusted: false }), false);
assert.equal(isTrustedRequiredSlotProvenance("original-turn"), true);
assert.equal(isTrustedRequiredSlotProvenance("clarification-turn"), true);
assert.equal(vehicleCalls.length, 1, "untrusted provenance must fail before Task 5 dispatch");
const trustedContextProvenance = createTrustedSlotProvenance({
  zone: "context",
  percent: "context",
});
await vehicleUseCase.execute(context(vehicleRunId, [], {
  parsedCommand: {
    ...vehicleAuthority,
    slotProvenance: trustedContextProvenance,
  },
}));
assert.equal(vehicleCalls.length, 2, "branded context provenance remains valid for orchestrated writes");
assert.equal(vehicleCalls[1].parsedCommand.slotProvenance, trustedContextProvenance);

const tailgateRunId = "run:complex:tailgate-state";
const tailgateGoal = goal(tailgateRunId, "vehicle-control", "command");
const tailgatePlan = plan(tailgateRunId, tailgateGoal.goalId, [
  step("safety", "safety.evaluate", [], "read", { action: "tailgate" }),
  step("confirmation", "confirmation.issue", ["safety"], "read", { action: "tailgate" }),
  step("tailgate", "vehicle.tailgate.set", ["confirmation"], "write", { state: "toggle" }),
]);
let tailgateDispatches = 0;
const tailgateUseCase = createUseCase({
  goalEnvelope: tailgateGoal,
  taskPlan: tailgatePlan,
  calls: [],
  vehicleControl: {
    async execute() {
      tailgateDispatches += 1;
      throw new Error("invalid tailgate state must not reach Task 5");
    },
  },
  capabilityOwners: {
    "safety.evaluate": {
      async execute() {
        return { safetyDecision: { allowed: true, action: "allow" } };
      },
    },
    "confirmation.issue": {
      async execute() {
        return { summary: "plan confirmation gate complete" };
      },
    },
  },
});
await assert.rejects(
  tailgateUseCase.execute(context(tailgateRunId, [], {
    parsedCommand: {
      requestId: tailgateRunId,
      intent: "body.tailgate.open",
      speechAct: "command",
      actionability: { actionable: true },
      slots: { open: true },
      slotProvenance: { open: "explicit" },
    },
  })),
  /state must be open or closed/,
);
assert.equal(tailgateDispatches, 0);

const climateRunId = "run:complex:climate-derived-slots";
const climateGoal = goal(climateRunId, "vehicle-control", "command");
const climatePlan = plan(climateRunId, climateGoal.goalId, [
  step("safety", "safety.evaluate", [], "read", { action: "climate" }),
  step("climate", "vehicle.climate.set", ["safety"], "write", { temperature: 22 }),
]);
let climateDispatch = null;
const climateUseCase = createUseCase({
  goalEnvelope: climateGoal,
  taskPlan: climatePlan,
  calls: [],
  vehicleControl: {
    async execute(input) {
      climateDispatch = input;
      return {};
    },
  },
  capabilityOwners: {
    "safety.evaluate": {
      async execute() {
        return { safetyDecision: { allowed: true, action: "allow" } };
      },
    },
  },
});
const climateSlots = {
  temperature: 22,
  requestedTemperature: 22,
  temperatureOutOfRange: false,
};
const climateProvenance = {
  temperature: "explicit",
  requestedTemperature: "explicit",
  temperatureOutOfRange: "context",
};
await climateUseCase.execute(context(climateRunId, [], {
  parsedCommand: {
    requestId: climateRunId,
    intent: "cabin.climate.setPreset",
    speechAct: "command",
    actionability: { actionable: true },
    slots: climateSlots,
    slotProvenance: climateProvenance,
  },
}));
assert.equal(climateDispatch.parsedCommand.slots, climateSlots);
assert.equal(climateDispatch.parsedCommand.slotProvenance, climateProvenance);

const unknownRunId = "run:complex:unknown";
const unknownGoal = goal(unknownRunId, "manual", "question");
const unknownPlan = plan(unknownRunId, unknownGoal.goalId, [
  step("unknown", "unknown.capability", [], "read", {}),
]);
const unknownEvents = [];
await assert.rejects(
  createUseCase({ goalEnvelope: unknownGoal, taskPlan: unknownPlan, calls: [] })
    .execute(context(unknownRunId, unknownEvents)),
  /unsupported capability: unknown\.capability/,
);
assert.deepEqual(projectComplexCausalOrder(unknownEvents), [
  "goal-formation:cabinModel",
  "goal-formation:cabinAssistant",
  "task-planning:orchestratorModel",
  "task-snapshot:terminal",
]);

let directCalls = 0;
const directUseCase = createComplexTaskUseCase({
  externalDataAdapter: {
    async execute(toolCall) {
      directCalls += 1;
      return {
        requestId: toolCall.requestId,
        commandId: toolCall.commandId,
        tool: toolCall.tool,
        ok: false,
        executionState: "rejected",
        executionError: {
          code: "weather-upstream-unavailable",
          message: "unavailable",
          stage: "execution",
          retryable: true,
        },
      };
    },
  },
});
const directResult = await directUseCase.execute(context("run:direct:regression", [], {
  mode: "direct-capability",
  rawText: "上海天气怎么样",
  parsedCommand: {
    intent: "conversation.general",
    slots: { externalDataType: "weather" },
  },
}));
assert.equal(directCalls, 1);
assert.equal(directResult.assistantResponse, "天气实时信息暂时不可用。");
assert.deepEqual(directResult.modelCalls, []);

const TASK_POISON = "TASK_RAW_CAPABILITY_OR_MODEL_PAYLOAD_MUST_NOT_LEAK";
const failedRunId = "run:kernel:task-failed";
const failedFixture = runtimeTaskFragment(failedRunId, "failed", {
  committed: true,
  poison: TASK_POISON,
});
const failedRuntime = await runRuntimeTaskFragment(failedRunId, failedFixture.fragment);
assert.equal(failedRuntime.result.status, "failed");
assert.equal(failedRuntime.result.taskStatus, "failed");
assert.equal(failedRuntime.result.executionFacts.completionStatus, "incomplete");
assert.equal(failedRuntime.result.committedEffects.length, 1);
assert.equal(failedRuntime.result.taskSnapshot.status, "failed");
assert.equal(failedRuntime.result.toolResult.commandId, failedFixture.commandId);
assert.equal(failedRuntime.result.vehicleStateSnapshot.id, failedFixture.snapshotId);
assert.equal(failedRuntime.result.safetyDecision.allowed, true);
assert.equal(JSON.stringify(failedRuntime.result).includes(TASK_POISON), false);
assert.equal(Object.isFrozen(failedRuntime.result.executionFacts), true);
assert.equal(Object.isFrozen(failedRuntime.result.executionFacts.stepResults), true);
assert.equal(Object.isFrozen(failedRuntime.result.committedEffects[0]), true);
assert.equal(Object.isFrozen(failedRuntime.result.taskSnapshot), true);
assert.equal(failedRuntime.result.events.at(-1).status, "failed");
assert.equal(failedRuntime.result.runtimeTelemetry.degraded, true);
assert.equal(failedRuntime.ledger.getPreviousRun().status, "failed");

const completedRunId = "run:kernel:task-completed";
const completedFixture = runtimeTaskFragment(completedRunId, "completed");
const completedRuntime = await runRuntimeTaskFragment(completedRunId, completedFixture.fragment);
assert.equal(completedRuntime.result.status, "completed");
assert.equal(completedRuntime.result.executionFacts.completionStatus, "completed");
assert.equal(completedRuntime.result.events.at(-1).status, "completed");
assert.equal(completedRuntime.result.runtimeTelemetry.degraded, false);
assert.equal(completedRuntime.ledger.getPreviousRun().status, "completed");

const safetyRejectedRunId = "run:kernel:task-safety-rejected";
const safetyRejectedFixture = runtimeTaskFragment(safetyRejectedRunId, "failed", {
  safetyRejected: true,
});
const safetyRejectedRuntime = await runRuntimeTaskFragment(
  safetyRejectedRunId,
  safetyRejectedFixture.fragment,
);
assert.equal(safetyRejectedRuntime.result.status, "failed");
assert.equal(safetyRejectedRuntime.result.executionFacts.completionStatus, "completed");
assert.equal(safetyRejectedRuntime.result.safetyDecision.allowed, false);
assert.equal(safetyRejectedRuntime.result.safetyDecision.action, "reject");
assert.equal(safetyRejectedRuntime.result.events.at(-1).status, "failed");
assert.equal(safetyRejectedRuntime.ledger.getPreviousRun().status, "failed");

const readOnlyRunId = "run:kernel:task-read-only-empty";
const readOnlyFixture = runtimeTaskFragment(readOnlyRunId, "completed", { readOnly: true });
const readOnlyRuntime = await runRuntimeTaskFragment(readOnlyRunId, readOnlyFixture.fragment);
assert.equal(readOnlyRuntime.result.status, "completed");
assert.equal(readOnlyRuntime.result.committedEffects.length, 0);
assert.equal(readOnlyRuntime.result.toolResult, null);

const invalidCommitCases = [
  ["missing-effect", { providerConfirmed: true, includeEffect: false }],
  ["unconfirmed-effect", { providerConfirmed: false, includeEffect: true }],
  ["extra-effect", { committed: true, extraCommittedEffect: true }],
  ["step-only-confirmed", { stepProviderConfirmed: true }],
  ["extra-confirmed-step", { committed: true, extraConfirmedStep: true }],
  ["wrong-step", { committed: true, effectOverrides: { stepId: "other-step" } }],
  ["wrong-capability", { committed: true, effectOverrides: { capabilityId: "manual.retrieve" } }],
  ["wrong-command", { committed: true, effectOverrides: { commandId: "command:other" } }],
  ["wrong-tool", { committed: true, effectOverrides: { tool: "body.tailgate.open" } }],
  ["wrong-snapshot", { committed: true, effectOverrides: { confirmedSnapshotId: "snapshot:other" } }],
  ["tool-not-ok", { committed: true, toolOverrides: { ok: false } }],
  ["ok-false-no-effect", {
    providerConfirmed: true,
    includeEffect: false,
    toolOverrides: { ok: false },
  }],
  ["foreign-request", { committed: true, foreignRequestId: true }],
  ["foreign-command", { committed: true, foreignCommandId: true }],
];
for (const [name, options] of invalidCommitCases) {
  const runId = `run:kernel:commit-invariant:${name}`;
  const fixture = runtimeTaskFragment(runId, "failed", options);
  await assert.rejects(
    runRuntimeTaskFragment(runId, fixture.fragment),
    (error) => error instanceof TypeError
      && /committed|Provider-confirmed|requestId|commandId/.test(error.message),
    name,
  );
}

const failedToolRunId = "run:kernel:legal-failed-tool-result";
const failedToolFixture = runtimeTaskFragment(failedToolRunId, "failed", {
  providerConfirmed: true,
  stepProviderConfirmed: true,
  includeEffect: false,
  omitConfirmedSnapshotId: true,
  stepStatus: "failed",
  toolOverrides: { ok: false, executionState: "failed" },
});
const failedToolRuntime = await runRuntimeTaskFragment(failedToolRunId, failedToolFixture.fragment);
assert.equal(failedToolRuntime.result.toolResult.ok, false);
assert.equal(failedToolRuntime.result.toolResult.executionState, "failed");
assert.equal(failedToolRuntime.result.committedEffects.length, 0);

const modelPoison = "TASK_MODEL_CALL_PRIVATE_DATA_MUST_NOT_LEAK";
const sourceModelCall = {
  phase: "goal-formation",
  rawPrompt: modelPoison,
  telemetry: {
    model: "goal-model",
    provider: "test",
    durationMs: 17.4,
    degraded: false,
    reason: "fixture",
    structuredRetryCount: 1,
    rawModelResponse: modelPoison,
    nested: { poison: modelPoison },
  },
};
const modelRunId = "run:kernel:task-model-call-projection";
const modelFixture = runtimeTaskFragment(modelRunId, "completed", {
  modelCalls: [sourceModelCall],
  readOnly: true,
});
const modelRuntime = await runRuntimeTaskFragment(modelRunId, modelFixture.fragment);
const projectedModelCall = modelRuntime.result.runtimeTelemetry.modelCalls[0];
assert.deepEqual(projectedModelCall, {
  phase: "goal-formation",
  telemetry: {
    model: "goal-model",
    provider: "test",
    durationMs: 17.4,
    degraded: false,
    reason: "fixture",
    structuredRetryCount: 1,
  },
});
assert.equal(JSON.stringify(modelRuntime.result).includes(modelPoison), false);
assert.equal(Object.isFrozen(projectedModelCall), true);
assert.equal(Object.isFrozen(projectedModelCall.telemetry), true);
sourceModelCall.phase = "task-planning";
sourceModelCall.telemetry.model = "mutated-source";
assert.equal(projectedModelCall.phase, "goal-formation");
assert.equal(projectedModelCall.telemetry.model, "goal-model");
assert.throws(() => { projectedModelCall.telemetry.model = "mutated-result"; }, TypeError);

const invalidModelRunId = "run:kernel:task-model-call-invalid-phase";
const invalidModelFixture = runtimeTaskFragment(invalidModelRunId, "completed", {
  modelCalls: [{ phase: "chain-of-thought", telemetry: {} }],
  readOnly: true,
});
await assert.rejects(
  runRuntimeTaskFragment(invalidModelRunId, invalidModelFixture.fragment),
  (error) => error instanceof TypeError && /model call phase/.test(error.message),
);

const cancelledRunId = "run:kernel:task-cancelled-committed";
const cancelledController = new AbortController();
const cancelledFixture = runtimeTaskFragment(cancelledRunId, "cancelled", {
  committed: true,
  factsCompleted: true,
});
const cancelledRuntime = await runRuntimeTaskFragment(cancelledRunId, cancelledFixture.fragment, {
  controller: cancelledController,
  abortBeforeReturn: true,
});
assert.equal(cancelledRuntime.result.status, "cancelled");
assert.equal(cancelledRuntime.result.executionFacts.completionStatus, "completed");
assert.equal(cancelledRuntime.result.committedEffects.length, 1);
assert.equal(cancelledRuntime.result.events.at(-1).status, "cancelled");
assert.equal(cancelledRuntime.result.runtimeTelemetry.degraded, true);
assert.equal(cancelledRuntime.ledger.getPreviousRun().status, "cancelled");

const emptyCancelledRunId = "run:kernel:task-cancelled-empty";
const emptyCancelledController = new AbortController();
const emptyCancelledFixture = runtimeTaskFragment(emptyCancelledRunId, "cancelled");
await assert.rejects(
  runRuntimeTaskFragment(emptyCancelledRunId, emptyCancelledFixture.fragment, {
    controller: emptyCancelledController,
    abortBeforeReturn: true,
  }),
  (error) => error?.name === "AbortError",
);

const ordinaryAbortRunId = "run:kernel:ordinary-abort-empty";
const ordinaryAbortController = new AbortController();
const ordinaryAbortFixture = runtimeTaskFragment(ordinaryAbortRunId, "completed");
await assert.rejects(
  runRuntimeTaskFragment(ordinaryAbortRunId, ordinaryAbortFixture.fragment, {
    controller: ordinaryAbortController,
    abortBeforeReturn: true,
  }),
  (error) => error?.name === "AbortError",
);

const causalRunId = "run:kernel:complex-causal-order";
const CAUSAL_PRIVATE_PAYLOAD = "ORCHESTRATED_MODEL_PRIVATE_PAYLOAD_MUST_NOT_LEAK";
const causalHandoff = await runRealComplexSuccess(causalRunId, {
  privateModelPayload: CAUSAL_PRIVATE_PAYLOAD,
  privateTelemetryReasons: {
    goal: "PRIVATE_VALID_GOAL_REASON",
    plan: "PRIVATE_VALID_PLAN_REASON",
    synthesis: "PRIVATE_VALID_SYNTHESIS_REASON",
  },
});
assert.deepEqual(projectComplexCausalOrder(causalHandoff.result.events), [
  "goal-formation:cabinModel",
  "goal-formation:cabinAssistant",
  "task-planning:orchestratorModel",
  "task-planning:orchestrator",
  "task-snapshot:execution-or-waiting",
  "final-synthesis:cabinModel",
  "final-synthesis:cabinAssistant",
  "task-snapshot:terminal",
  "final-response:cabinAssistant",
]);
assert.equal(JSON.stringify(causalHandoff.result.events).includes(CAUSAL_PRIVATE_PAYLOAD), false);
for (const event of causalHandoff.result.events.filter((candidate) => (
  ["goal-formation", "task-planning", "final-synthesis"].includes(candidate.phase)
  && ["cabinAssistant", "orchestrator"].includes(candidate.component)
))) {
  assert.deepEqual(event.metadata, { degraded: false });
}

const semanticCausalRunId = "run:kernel:complex-semantic-causal-order";
const semanticCausalHandoff = await runRealComplexSuccess(semanticCausalRunId, {
  semanticEnvelope: manualSemanticEnvelope(semanticCausalRunId),
});
assert.deepEqual(projectComplexCausalOrder(semanticCausalHandoff.result.events), [
  "task-planning:orchestratorModel",
  "task-planning:orchestrator",
  "task-snapshot:execution-or-waiting",
  "final-synthesis:cabinModel",
  "final-synthesis:cabinAssistant",
  "task-snapshot:terminal",
  "final-response:cabinAssistant",
]);
assert.equal(
  semanticCausalHandoff.calls.some((call) => call.name === "cabin.formGoal"),
  false,
  "a validated semantic envelope must be the sole goal source",
);

const foregroundPoisonRunId = "run:kernel:complex-foreground-private-reason";
const foregroundPoisonHandoff = await runRealComplexSuccess(foregroundPoisonRunId, {
  semanticEnvelope: manualSemanticEnvelope(foregroundPoisonRunId, { need: "social" }),
  privateTelemetryReasons: { foreground: "PRIVATE_FOREGROUND_REASON" },
});
assert.equal(
  JSON.stringify(foregroundPoisonHandoff.result.events).includes("PRIVATE_FOREGROUND_REASON"),
  false,
);

const committedCancellation = await runRealComplexCommittedCancellation(
  "run:kernel:complex-committed-cancellation",
);
assert.equal(committedCancellation.result.status, "cancelled");
assert.equal(committedCancellation.result.committedEffects.length, 1);
assert.deepEqual(projectComplexCausalOrder(committedCancellation.result.events), [
  "goal-formation:cabinModel",
  "goal-formation:cabinAssistant",
  "task-planning:orchestratorModel",
  "task-planning:orchestrator",
  "task-snapshot:execution-or-waiting",
  "task-snapshot:terminal",
  "final-response:cabinAssistant",
]);
assert.equal(
  committedCancellation.result.events.some((event) => event.phase === "final-synthesis"),
  false,
  "a cancelled synthesis result must not be fabricated as a completed model or Agent event",
);

const cancelledHandoff = await runRealComplexFailure("run:kernel:complex-abort", {
  cancelDuringGoal: true,
});
assert.equal(cancelledHandoff.error?.name, "AbortError");
assertTerminalSnapshotBeforeFinal(cancelledHandoff.ledger, "cancelled", "cancelled");
assert.deepEqual(projectComplexCausalOrder(cancelledHandoff.ledger.getPreviousRun().events), [
  "task-snapshot:terminal",
  "final-response:cabinAssistant",
]);

const failedHandoff = await runRealComplexFailure("run:kernel:complex-failure");
assert.equal(failedHandoff.error, failedHandoff.expectedError);
assertTerminalSnapshotBeforeFinal(failedHandoff.ledger, "failed", "failed");
assert.deepEqual(projectComplexCausalOrder(failedHandoff.ledger.getPreviousRun().events), [
  "goal-formation:cabinModel",
  "goal-formation:cabinAssistant",
  "task-planning:orchestratorModel",
  "task-snapshot:terminal",
  "final-response:cabinAssistant",
]);

const invalidPlanHandoff = await runRealComplexFailure(
  "run:kernel:complex-invalid-task-plan",
  { invalidPlan: true },
);
assert.equal(invalidPlanHandoff.error instanceof TypeError, true);
assert.deepEqual(invalidPlanHandoff.ledger.getPreviousRun().events
  .filter((event) => event.phase === "task-planning")
  .map((event) => `${event.component}:${event.status}`), [
  "orchestratorModel:failed",
]);

const boundaryMatrixCases = [
  ["invalid-goal", "goal-formation"],
  ["invalid-plan", "task-planning"],
  ["invalid-synthesis", "final-synthesis"],
  ["unavailable-goal", "goal-formation"],
  ["unavailable-plan", "task-planning"],
  ["unavailable-synthesis", "final-synthesis"],
];
const boundaryMatrixObserved = {};
const boundaryMatrixReasonLeaks = {};
for (const [boundaryCase, phase] of boundaryMatrixCases) {
  const handoff = await runRealComplexFailure(
    `run:kernel:complex-boundary:${boundaryCase}`,
    { boundaryCase },
  );
  const boundaryEvents = handoff.ledger.getPreviousRun().events;
  boundaryMatrixReasonLeaks[boundaryCase] = boundaryEvents
    .map((event) => event.metadata?.modelTelemetry?.fallbackReasonCode)
    .filter((reason) => typeof reason === "string" && reason.startsWith("PRIVATE_"));
  assert.equal(
    JSON.stringify(boundaryEvents).includes("private provider error must not be published"),
    false,
  );
  boundaryMatrixObserved[boundaryCase] = boundaryEvents
    .filter((event) => event.phase === phase)
    .map((event) => ({
      component: event.component,
      status: event.status,
      reasonCode: event.metadata.reasonCode,
      degraded: event.metadata.degraded,
    }));
}
assert.deepEqual(boundaryMatrixObserved, {
  "invalid-goal": [{
    component: "cabinModel", status: "failed", reasonCode: "goal-envelope-invalid", degraded: true,
  }],
  "invalid-plan": [{
    component: "orchestratorModel", status: "failed", reasonCode: "task-plan-invalid", degraded: true,
  }],
  "invalid-synthesis": [{
    component: "cabinModel", status: "failed", reasonCode: "final-synthesis-boundary-invalid", degraded: true,
  }],
  "unavailable-goal": [{
    component: "cabinModel", status: "unavailable", reasonCode: "goal-model-unavailable", degraded: true,
  }],
  "unavailable-plan": [{
    component: "orchestratorModel", status: "unavailable", reasonCode: "task-planning-model-unavailable", degraded: true,
  }],
  "unavailable-synthesis": [{
    component: "cabinModel", status: "unavailable", reasonCode: "final-synthesis-model-unavailable", degraded: true,
  }],
});
assert.deepEqual({
  valid: causalHandoff.result.events
    .map((event) => event.metadata?.modelTelemetry?.fallbackReasonCode)
    .filter((reason) => typeof reason === "string" && reason.startsWith("PRIVATE_")),
  invalid: Object.fromEntries(
    Object.entries(boundaryMatrixReasonLeaks).filter(([name]) => name.startsWith("invalid-")),
  ),
}, {
  valid: [],
  invalid: {
    "invalid-goal": [],
    "invalid-plan": [],
    "invalid-synthesis": [],
  },
}, "generic telemetry.reason must stay private");

const cancelledPlanBoundary = await runRealComplexFailure(
  "run:kernel:complex-boundary:cancelled-plan",
  { boundaryCase: "cancelled-plan" },
);
assert.equal(cancelledPlanBoundary.error?.name, "AbortError");
assert.deepEqual(cancelledPlanBoundary.ledger.getPreviousRun().events
  .filter((event) => event.phase === "task-planning"), []);
assert.equal(cancelledPlanBoundary.ledger.getPreviousRun().status, "cancelled");

await verifyCompoundConfirmationHandoff();

console.log("Lean Runtime complex-task handoff verification passed.");

async function verifyCompoundConfirmationHandoff() {
  const oldRunId = "run:compound:confirmation-challenge";
  const confirmedRunId = "run:compound:confirmation-resume";
  const task5Harness = createLeanRuntimeVehicleControlHarness({
    safetyState: { rearClearance: null },
  });
  let clockMs = Date.parse("2026-08-04T10:00:00.000Z");
  const now = () => clockMs++;
  const compoundUseCase = createComplexTaskUseCase({
    externalDataAdapter: {
      async execute() {
        throw new Error("compound vehicle plan must not call the direct external adapter");
      },
    },
    cabin: {
      async formGoal(input) {
        return {
          goalEnvelope: goal(input.runId, "vehicle-control", "command"),
          telemetry: { model: "goal-model", provider: "test" },
        };
      },
      async respondForeground(input) {
        calls.push({ name: "cabin.respondForeground", input });
        return {
          text: "我先处理车内任务。",
          telemetry: {
            model: "foreground-model",
            provider: "test",
            ...(privateTelemetryReasons.foreground
              ? { reason: privateTelemetryReasons.foreground }
              : {}),
          },
        };
      },
      async synthesize() {
        return {
          text: "尾门动作已由传感器确认。",
          telemetry: { model: "final-model", provider: "test" },
        };
      },
    },
    orchestrator: {
      async plan(input) {
        const taskPlan = plan(input.runId, input.goalEnvelope.goalId, [
          step("safety", "safety.evaluate", [], "read", { action: "tailgate-open" }),
          step("confirmation", "confirmation.issue", ["safety"], "read", {
            action: "tailgate-open",
          }),
          step("tailgate", "vehicle.tailgate.set", ["confirmation"], "write", {
            state: "open",
          }),
          step("response", "response.synthesize", ["tailgate"], "read", {
            facts: { summary: "基于 Task5 的终态事实回答", evidenceRefs: [] },
          }),
        ]);
        return {
          taskPlan,
          validation: { ok: true, errors: [], plan: taskPlan },
          telemetry: { model: "planner-model", provider: "test" },
        };
      },
    },
    createExecutionLedger: createTaskPlanExecution,
    capabilityOwners: {
      "safety.evaluate": {
        async execute() {
          return {
            safetyDecision: {
              allowed: false,
              action: "require_confirmation",
              reason: "尾门开启需要用户确认后方空间。",
              alternative: "请确认后方空间安全。",
              reasonCode: "confirmation-required",
              vehicleStateSnapshotId: "snapshot:compound:planning",
              policyId: "tailgate-clearance",
            },
          };
        },
      },
      "confirmation.issue": {
        async execute() {
          return { summary: "Task5 confirmation owner is ready" };
        },
      },
    },
    vehicleControl: task5Harness.useCase,
    now,
  });
  const runEventLedger = new RunEventLedger();
  const runtime = new RuntimeKernel({
    routePolicy: {
      async resolve(rawText, options) {
        return {
          decision: createRouteDecision({
            disposition: "execute",
            routeId: "task",
            mode: "orchestrated",
            confidence: 1,
            reasonCode: "compound-confirmation-regression",
            semanticSource: "deterministic",
            normalizedIntentRef: "body.tailgate.open",
            runId: options.runId,
          }),
          parsedCommand: Object.freeze({
            requestId: options.runId,
            rawText,
            intent: "body.tailgate.open",
            speechAct: "command",
            actionability: Object.freeze({ actionable: true, reason: "explicit-command" }),
            slots: Object.freeze({ open: true }),
            slotProvenance: Object.freeze({ open: "explicit" }),
          }),
          semanticTelemetry: Object.freeze({}),
        };
      },
    },
    useCases: Object.freeze({ task: compoundUseCase }),
    runEventLedger,
    sessionMemory: new SessionMemory({ now }),
    now,
    createRequestId: () => "unexpected-compound-request-id",
  });
  const interaction = new InteractionSessionController({
    ledger: new InteractionSessionLedger(),
    now,
    createId: (() => {
      let sequence = 0;
      return (kind) => `${kind}:compound:${++sequence}`;
    })(),
    setTimer: () => 1,
    clearTimer() {},
  });

  interaction.wake({ provider: "compound-test", simulated: true });
  const challengeTurn = interaction.submitTurn({
    rawText: "打开尾门",
    trigger: "explicit-hmi",
    relation: "new-goal",
  });
  const challenged = await runtime.run("打开尾门", {
    requestId: oldRunId,
    interactionRef: challengeTurn,
  });
  const challenge = challenged.safetyDecision?.confirmationChallenge;
  assert.equal(challenged.status, "failed");
  assert.equal(challenged.executionFacts.completionStatus, "incomplete");
  assert.deepEqual(challenged.committedEffects, []);
  assert.equal(challenged.toolResult, null);
  assert.equal(challenged.safetyDecision.action, "require_confirmation");
  assert.equal(typeof challenge?.id, "string", "Task5 must issue the canonical challenge");
  assert.equal(challenge.requestId, oldRunId);
  assert.equal(typeof challenge.responseToken, "string");
  assert.equal(Array.isArray(challenge.assertions) && challenge.assertions.length > 0, true);
  assert.equal(countCalls(task5Harness.calls, "vehicle.execute"), 0);
  assert.equal(countCalls(task5Harness.calls, "vehicle.adapter.execute"), 0);
  interaction.linkRun(challengeTurn.turnId, {
    runId: oldRunId,
    eventIds: challenged.events.map((event) => event.eventId),
  });
  interaction.completeTurn(challengeTurn.turnId, { outputMode: "text" });

  task5Harness.resetCalls();
  interaction.startListening();
  const confirmationTurn = interaction.submitTurn({
    rawText: "确认后方空间安全",
    trigger: "follow-up",
    relation: "follow-up",
  });
  const confirmationResponse = {
    challengeId: challenge.id,
    requestId: challenge.requestId,
    responseToken: challenge.responseToken,
    actionDigest: challenge.actionDigest,
    policyId: challenge.policyId,
    acceptedAssertions: challenge.assertions.map((assertion) => assertion.id),
  };
  const confirmed = await runtime.run("确认后方空间安全", {
    requestId: confirmedRunId,
    interactionRef: confirmationTurn,
    confirmationResponse,
  });
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.executionFacts.completionStatus, "completed");
  assert.equal(confirmed.safetyDecision.allowed, true);
  assert.equal(confirmed.toolResult.requestId, confirmedRunId);
  assert.equal(confirmed.toolResult.executionState, "observed-succeeded");
  assert.equal(confirmed.vehicleStateSnapshot.id, confirmed.toolResult.confirmedSnapshotId);
  assert.equal(confirmed.committedEffects.length, 1);
  assert.equal(countCalls(task5Harness.calls, "safety.evaluate"), 2);
  assert.equal(countCalls(task5Harness.calls, "vehicle.execute"), 1);
  assert.equal(countCalls(task5Harness.calls, "vehicle.adapter.execute"), 1);
  interaction.linkRun(confirmationTurn.turnId, {
    runId: confirmedRunId,
    parentRunId: oldRunId,
    eventIds: confirmed.events.map((event) => event.eventId),
  });
  interaction.completeTurn(confirmationTurn.turnId, { outputMode: "text" });
  assert.deepEqual(
    interaction.getSnapshot().currentSession.relatedRunIds,
    [oldRunId, confirmedRunId],
    "interaction session must preserve first-seen Run linkage",
  );

  task5Harness.resetCalls();
  const replayed = await task5Harness.useCase.execute({
    runId: "run:compound:confirmation-replay",
    rawText: "再次确认",
    parsedCommand: {
      requestId: "run:compound:confirmation-replay",
      intent: "body.tailgate.open",
      speechAct: "command",
      actionability: { actionable: true, reason: "explicit-command" },
      slots: { open: true },
      slotProvenance: { open: "explicit" },
    },
    confirmationResponse,
    signal: undefined,
    deadlineAt: undefined,
    vehicleSensorMode: "success",
    vehicleSensorLatencyMs: 0,
    throwIfAborted() {},
    emit() {},
  });
  assert.equal(replayed.safetyDecision.action, "reject");
  assert.match(replayed.safetyDecision.reason, /已使用|重复/);
  assert.equal(countCalls(task5Harness.calls, "vehicle.execute"), 0);
  assert.equal(countCalls(task5Harness.calls, "vehicle.adapter.execute"), 0);
}

function createUseCase({
  goalEnvelope,
  taskPlan,
  calls,
  capabilityOwners = {},
  vehicleControl,
  privateModelPayload = "",
  privateTelemetryReasons = {},
}) {
  return createComplexTaskUseCase({
    externalDataAdapter: { async execute() { throw new Error("direct adapter must stay inactive"); } },
    cabin: {
      async formGoal(input) {
        calls.push({ name: "cabin.formGoal", input });
        return {
          goalEnvelope,
          telemetry: {
            model: "goal-model",
            provider: "test",
            ...(privateModelPayload ? { rawModelResponse: privateModelPayload } : {}),
            ...(privateTelemetryReasons.goal ? { reason: privateTelemetryReasons.goal } : {}),
          },
        };
      },
      async synthesize(input) {
        calls.push({ name: "cabin.synthesize", input });
        return {
          text: "已根据执行事实完成回答。",
          telemetry: {
            model: "final-model",
            provider: "test",
            ...(privateModelPayload ? { rawModelResponse: privateModelPayload } : {}),
            ...(privateTelemetryReasons.synthesis
              ? { reason: privateTelemetryReasons.synthesis }
              : {}),
          },
          ...(privateModelPayload ? { rawOutput: privateModelPayload } : {}),
        };
      },
    },
    orchestrator: {
      async plan(input) {
        calls.push({ name: "orchestrator.plan", input });
        return {
          taskPlan,
          validation: { ok: true, errors: [], plan: taskPlan },
          telemetry: {
            model: "planner-model",
            provider: "test",
            ...(privateModelPayload ? { rawModelResponse: privateModelPayload } : {}),
            ...(privateTelemetryReasons.plan ? { reason: privateTelemetryReasons.plan } : {}),
          },
          ...(privateModelPayload ? { rawOutput: privateModelPayload } : {}),
        };
      },
    },
    createExecutionLedger: createTaskPlanExecution,
    capabilityOwners,
    vehicleControl,
    now: fixedNow,
  });
}

function context(runId, events, overrides = {}) {
  const signal = new AbortController().signal;
  return {
    runId,
    rawText: overrides.rawText ?? "先查询条件，再执行并回答。",
    routeDecision: { routeId: "task", mode: overrides.mode ?? "orchestrated" },
    parsedCommand: overrides.parsedCommand ?? {
      requestId: runId,
      intent: "conversation.general",
      slots: {},
    },
    signal,
    deadlineAt: fixedNow() + 12_000,
    emit(event) {
      const emitted = { ...event, eventId: `event:${runId}:${events.length + 1}`, runId };
      events.push(emitted);
      return emitted;
    },
    throwIfAborted() {
      if (signal.aborted) throw signal.reason;
    },
  };
}

function goal(runId, domain, interactionType) {
  return createGoalEnvelope({
    goalId: `goal:${runId}`,
    runId,
    objective: "完成经过校验的复合目标",
    interactionType,
    domain,
    constraints: [],
    contextRefs: [],
    requiredClarifications: [],
    readyForPlanning: true,
    model: "goal-model",
    provider: "test",
    confidenceStrength: "high",
  });
}

function plan(runId, goalId, steps) {
  return createTaskPlan({
    planId: `plan:${runId}`,
    goalId,
    runId,
    steps,
    selectedCapabilities: steps.map((item) => item.capabilityId),
    writeActionCount: steps.filter((item) => item.accessMode === "write").length,
    planningSummary: "只执行声明的能力。",
    model: "planner-model",
    provider: "test",
    status: "ready",
  });
}

function step(stepId, capabilityId, dependsOn, accessMode, input) {
  return {
    stepId,
    capabilityId,
    dependsOn,
    input,
    expectedOutput: `${stepId}-result`,
    accessMode,
    status: "planned",
  };
}

function projectEvent(event) {
  return {
    component: event.component,
    phase: event.phase,
    status: event.status,
    summary: event.summary,
    currentStage: event.metadata.task.snapshot.currentStage,
  };
}

function runtimeTaskFragment(runId, status, {
  committed = false,
  effectOverrides = {},
  extraCommittedEffect = false,
  extraConfirmedStep = false,
  factsCompleted = false,
  foreignCommandId = false,
  foreignRequestId = false,
  includeEffect = committed,
  modelCalls = [],
  omitConfirmedSnapshotId = false,
  poison = "",
  providerConfirmed = committed,
  readOnly = false,
  safetyRejected = false,
  stepProviderConfirmed = providerConfirmed,
  stepStatus = null,
  toolOverrides = {},
} = {}) {
  const factStepId = readOnly ? "read" : "write";
  const factCapabilityId = readOnly ? "manual.retrieve" : "vehicle.window.set-position";
  const commandId = foreignCommandId
    ? "run:foreign:1:body.window.setPosition"
    : `${runId}:1:body.window.setPosition`;
  const snapshotId = `snapshot:${runId}`;
  const committedEffect = {
    stepId: factStepId,
    capabilityId: factCapabilityId,
    commandId,
    tool: "body.window.setPosition",
    executionState: "observed-succeeded",
    confirmedSnapshotId: snapshotId,
    ...(poison ? { rawCapabilityPayload: poison } : {}),
    ...effectOverrides,
  };
  const toolResult = {
    requestId: foreignRequestId ? "run:foreign" : runId,
    commandId,
    tool: "body.window.setPosition",
    ok: true,
    executionState: "observed-succeeded",
    confirmedSnapshotId: snapshotId,
    hmiSummary: "Provider 已确认车窗动作。",
    visualScenario: "vehicle-control",
    source: "vehicle-execution-coordinator",
    simulated: true,
    timestamp: "2026-08-05T02:00:00.000Z",
    ...toolOverrides,
  };
  if (omitConfirmedSnapshotId) delete toolResult.confirmedSnapshotId;
  const confirmedVehicleState = {
    id: snapshotId,
    source: "demo-sensor-simulator",
    simulated: true,
    values: { windowPositionPercentByZone: { front_left: 40 } },
  };
  const completionStatus = status === "completed" || factsCompleted || safetyRejected
    ? "completed"
    : "incomplete";
  const committedEffects = includeEffect
    ? [committedEffect, ...(extraCommittedEffect ? [{ ...committedEffect, commandId: `${commandId}:extra` }] : [])]
    : [];
  const safetyDecision = safetyRejected ? {
    allowed: false,
    action: "reject",
    reason: "Safety rejected the write action",
    vehicleStateSnapshotId: snapshotId,
  } : providerConfirmed ? {
    allowed: true,
    action: "allow",
    reason: "Safety allowed",
    vehicleStateSnapshotId: snapshotId,
  } : null;
  const stepResults = [{
    stepId: factStepId,
    capabilityId: factCapabilityId,
    status: stepStatus ?? (stepProviderConfirmed || status === "completed"
      ? "completed"
      : safetyRejected ? "blocked" : "failed"),
    result: stepProviderConfirmed ? {
      toolResult,
      confirmedVehicleState,
    } : safetyRejected ? {
      safetyDecision,
      confirmedVehicleState,
    } : { summary: "只保留受限事实" },
  }];
  if (extraConfirmedStep) {
    const extraSnapshotId = `${snapshotId}:extra`;
    stepResults.push({
      stepId: "write-extra",
      capabilityId: "vehicle.tailgate.set",
      status: "completed",
      result: {
        toolResult: {
          ...toolResult,
          commandId: `${runId}:2:body.tailgate.open`,
          tool: "body.tailgate.open",
          confirmedSnapshotId: extraSnapshotId,
        },
        confirmedVehicleState: { ...confirmedVehicleState, id: extraSnapshotId },
      },
    });
  }
  const executionFacts = createExecutionFacts({
    runId,
    goalId: `goal:${runId}`,
    planId: `plan:${runId}`,
    stepResults,
    evidenceRefs: [{
      id: `evidence:${runId}`,
      source: "test",
      type: "runtime-task",
    }],
    safetyDecision,
    toolResult: providerConfirmed ? toolResult : null,
    confirmedVehicleState: providerConfirmed || safetyRejected ? confirmedVehicleState : null,
    degraded: status !== "completed",
    failureReason: status === "completed" ? "" : `${status}-task`,
    completionStatus,
  });
  const taskSnapshot = createTaskSnapshot({
    taskId: runId,
    runId,
    status,
    currentStage: "finalizing",
    completedStepIds: stepResults
      .filter((result) => result.status === "completed")
      .map((result) => result.stepId),
    activeStepIds: [],
    pendingStepIds: [],
    committedEffects,
    latestFactsRef: `execution-facts:${runId}:plan:${runId}`,
    cancellationState: status === "cancelled" ? "cancelled" : "none",
    updatedAt: "2026-08-05T02:00:00.000Z",
  });
  return {
    commandId,
    snapshotId,
    fragment: Object.freeze({
      status,
      assistantResponse: status === "completed" ? "任务已完成。" : "任务未完整完成。",
      executionFacts,
      committedEffects,
      taskSnapshot,
      modelCalls: Object.freeze([...modelCalls]),
      degraded: status !== "completed",
      ...(poison ? { rawModelResponse: poison } : {}),
    }),
  };
}

async function runRuntimeTaskFragment(runId, fragment, {
  controller = new AbortController(),
  abortBeforeReturn = false,
} = {}) {
  const ledger = new RunEventLedger();
  const runtime = new RuntimeKernel({
    routePolicy: {
      async resolve(_rawText, options) {
        return {
          decision: createRouteDecision({
            disposition: "execute",
            routeId: "task",
            mode: "orchestrated",
            confidence: 1,
            reasonCode: "task-runtime-verifier",
            semanticSource: "deterministic",
            normalizedIntentRef: null,
            runId: options.runId,
          }),
          parsedCommand: {
            requestId: options.runId,
            rawText: "执行后台任务",
            intent: "conversation.general",
            slots: {},
          },
          semanticTelemetry: {},
        };
      },
    },
    useCases: {
      task: {
        async execute() {
          if (abortBeforeReturn) controller.abort("runtime-task-cancelled");
          return fragment;
        },
      },
    },
    runEventLedger: ledger,
    sessionMemory: new SessionMemory(),
    now: fixedNow,
    createRequestId: () => runId,
  });
  const result = await runtime.run("执行后台任务", {
    requestId: runId,
    signal: controller.signal,
  });
  return { result, ledger };
}

async function runRealComplexFailure(runId, {
  cancelDuringGoal = false,
  invalidPlan = false,
  boundaryCase = "",
} = {}) {
  const controller = new AbortController();
  const expectedError = new Error("planner-failed-before-ledger");
  const boundaryError = new Error("private provider error must not be published");
  const goalEnvelope = goal(runId, "manual", "question");
  const validPlan = plan(runId, goalEnvelope.goalId, [
    step("manual", "manual.retrieve", [], "read", { query: "ES8 尾门开启条件" }),
    step("response", "response.synthesize", ["manual"], "read", {
      facts: { summary: "基于已完成步骤回答", evidenceRefs: [] },
    }),
  ]);
  const activeBoundaryCase = invalidPlan ? "invalid-plan" : boundaryCase;
  const useCase = createComplexTaskUseCase({
    externalDataAdapter: { async execute() { throw new Error("direct adapter must stay inactive"); } },
    cabin: {
      async formGoal() {
        if (cancelDuringGoal) controller.abort("cancelled-during-goal");
        if (activeBoundaryCase === "unavailable-goal") throw boundaryError;
        if (activeBoundaryCase === "invalid-goal") {
          return {
            goalEnvelope: null,
            telemetry: {
              model: "goal-model",
              provider: "test",
              validationSubreason: "schema-invalid",
              reason: "PRIVATE_INVALID_GOAL_REASON",
            },
          };
        }
        return { goalEnvelope, telemetry: { model: "goal-model", provider: "test" } };
      },
      async synthesize() {
        if (activeBoundaryCase === "unavailable-synthesis") throw boundaryError;
        if (activeBoundaryCase === "invalid-synthesis") {
          return {
            text: "",
            telemetry: {
              model: "final-model",
              provider: "test",
              validationSubreason: "empty-text",
              reason: "PRIVATE_INVALID_SYNTHESIS_REASON",
            },
          };
        }
        return { text: "已根据执行事实完成回答。", telemetry: { model: "final-model", provider: "test" } };
      },
    },
    orchestrator: {
      async plan() {
        if (activeBoundaryCase === "invalid-plan") {
          return {
            taskPlan: null,
            validation: { ok: false, errors: ["schema-invalid"], plan: null },
            telemetry: {
              model: "planner",
              provider: "test",
              validationSubreason: "schema-invalid",
              reason: "PRIVATE_INVALID_PLAN_REASON",
            },
          };
        }
        if (["invalid-synthesis", "unavailable-synthesis"].includes(activeBoundaryCase)) {
          return {
            taskPlan: validPlan,
            validation: { ok: true, errors: [], plan: validPlan },
            telemetry: { model: "planner-model", provider: "test" },
          };
        }
        if (activeBoundaryCase === "cancelled-plan") {
          const error = new Error("cancelled planner result must not be published");
          error.name = "AbortError";
          throw error;
        }
        if (activeBoundaryCase === "unavailable-plan") throw boundaryError;
        throw expectedError;
      },
    },
    createExecutionLedger: createTaskPlanExecution,
    capabilityOwners: {
      "manual.retrieve": {
        async execute() {
          return {
            summary: "驾驶员应先确认车辆静止且后方空间安全。",
            evidenceRefs: [{ id: "manual:tailgate", source: "manual", type: "manual" }],
          };
        },
      },
    },
    now: fixedNow,
  });
  const ledger = new RunEventLedger();
  const runtime = new RuntimeKernel({
    routePolicy: {
      async resolve(_rawText, options) {
        return {
          decision: createRouteDecision({
            disposition: "execute",
            routeId: "task",
            mode: "orchestrated",
            confidence: 1,
            reasonCode: "real-complex-failure-verifier",
            semanticSource: "deterministic",
            normalizedIntentRef: null,
            runId: options.runId,
          }),
          parsedCommand: {
            requestId: options.runId,
            rawText: "执行后台任务",
            intent: "conversation.general",
            slots: {},
          },
          semanticTelemetry: {},
        };
      },
    },
    useCases: { task: useCase },
    runEventLedger: ledger,
    sessionMemory: new SessionMemory(),
    now: fixedNow,
    createRequestId: () => runId,
  });
  let error = null;
  try {
    await runtime.run("执行后台任务", { requestId: runId, signal: controller.signal });
  } catch (caught) {
    error = caught;
  }
  return { error, expectedError, ledger };
}

async function runRealComplexSuccess(runId, {
  semanticEnvelope = null,
  privateModelPayload = "",
  privateTelemetryReasons = {},
} = {}) {
  const goalEnvelope = semanticEnvelope
    ? createVehicleSluGoalEnvelope(semanticEnvelope)
    : goal(runId, "manual", "question");
  const taskPlan = plan(runId, goalEnvelope.goalId, [
    step("manual", "manual.retrieve", [], "read", { query: "ES8 尾门开启条件" }),
    step("response", "response.synthesize", ["manual"], "read", {
      facts: { summary: "基于已完成步骤回答", evidenceRefs: [] },
    }),
  ]);
  const calls = [];
  const useCase = createUseCase({
    goalEnvelope,
    taskPlan,
    calls,
    privateModelPayload,
    privateTelemetryReasons,
    capabilityOwners: {
      "manual.retrieve": {
        async execute() {
          return {
            summary: "驾驶员应先确认车辆静止且后方空间安全。",
            evidenceRefs: [{ id: "manual:tailgate", source: "manual", type: "manual" }],
          };
        },
      },
    },
  });
  const ledger = new RunEventLedger();
  const runtime = new RuntimeKernel({
    routePolicy: {
      async resolve(_rawText, options) {
        return {
          decision: createRouteDecision({
            disposition: "execute",
            routeId: "task",
            mode: "orchestrated",
            confidence: 1,
            reasonCode: "real-complex-causal-order-verifier",
            semanticSource: "deterministic",
            normalizedIntentRef: null,
            runId: options.runId,
          }),
          parsedCommand: {
            requestId: options.runId,
            rawText: "执行后台任务",
            intent: "conversation.general",
            slots: {},
          },
          semanticTelemetry: {},
          ...(semanticEnvelope ? { semanticEnvelope } : {}),
        };
      },
    },
    useCases: { task: useCase },
    runEventLedger: ledger,
    sessionMemory: new SessionMemory(),
    now: fixedNow,
    createRequestId: () => runId,
  });
  const result = await runtime.run("执行后台任务", { requestId: runId });
  return { result, ledger, calls };
}

function manualSemanticEnvelope(runId, { need = "none" } = {}) {
  return createVehicleSluEnvelope({
    requestId: runId,
    domain: "vehicle",
    conversationGoal: { summary: "查询尾门开启条件", need },
    vehicleFrames: [{
      frameId: `${runId}:manual`,
      capability: "knowledge",
      intent: "vehicle.knowledge.query",
      speechAct: "question",
      knowledgeNeed: "manual",
      actionNeed: "none",
      slots: { query: "ES8 尾门开启条件" },
      missingSlots: [],
      clarificationQuestion: null,
      standaloneQuery: "ES8 尾门开启条件",
      confidence: 0.99,
    }],
    domainConfidence: 0.99,
  });
}

async function runRealComplexCommittedCancellation(runId) {
  const controller = new AbortController();
  const goalEnvelope = goal(runId, "vehicle-control", "command");
  const taskPlan = plan(runId, goalEnvelope.goalId, [
    step("safety", "safety.evaluate", [], "read", { action: "window-position" }),
    step("window", "vehicle.window.set-position", ["safety"], "write", {
      zone: "driver",
      percent: 40,
    }),
    step("response", "response.synthesize", ["window"], "read", {
      facts: { summary: "基于已提交事实回答", evidenceRefs: [] },
    }),
  ]);
  const useCase = createComplexTaskUseCase({
    externalDataAdapter: { async execute() { throw new Error("direct adapter must stay inactive"); } },
    cabin: {
      async formGoal() {
        return { goalEnvelope, telemetry: { model: "goal-model", provider: "test" } };
      },
      async synthesize() {
        controller.abort("cancelled-during-final-synthesis");
        return {
          text: "this cancelled result must not be presented",
          telemetry: { model: "final-model", provider: "test" },
        };
      },
    },
    orchestrator: {
      async plan() {
        return {
          taskPlan,
          validation: { ok: true, errors: [], plan: taskPlan },
          telemetry: { model: "planner-model", provider: "test" },
        };
      },
    },
    createExecutionLedger: createTaskPlanExecution,
    capabilityOwners: {
      "safety.evaluate": {
        async execute() {
          return {
            safetyDecision: {
              allowed: true,
              action: "allow",
              reason: "当前传感器事实允许调整车窗。",
              alternative: "",
              reasonCode: "allowed",
              vehicleStateSnapshotId: "snapshot:planning",
              policyId: "window-policy",
            },
          };
        },
      },
    },
    vehicleControl: {
      async execute() {
        return {
          toolResult: {
            requestId: runId,
            commandId: `${runId}:1:body.window.setPosition`,
            tool: "body.window.setPosition",
            ok: true,
            executionState: "observed-succeeded",
            confirmedSnapshotId: "snapshot:confirmed",
            hmiSummary: "主驾车窗已调整到 40%。",
            visualScenario: "vehicle-control",
            source: "vehicle-execution-coordinator",
            simulated: true,
            timestamp: "2026-08-05T02:00:00.000Z",
          },
          vehicleStateSnapshot: {
            id: "snapshot:confirmed",
            values: { windowPositionPercentByZone: { driver: 40 } },
          },
        };
      },
    },
    now: fixedNow,
  });
  const ledger = new RunEventLedger();
  const runtime = new RuntimeKernel({
    routePolicy: {
      async resolve(_rawText, options) {
        return {
          decision: createRouteDecision({
            disposition: "execute",
            routeId: "task",
            mode: "orchestrated",
            confidence: 1,
            reasonCode: "real-complex-committed-cancellation-verifier",
            semanticSource: "deterministic",
            normalizedIntentRef: "body.window.setPosition",
            runId: options.runId,
          }),
          parsedCommand: {
            requestId: options.runId,
            rawText: "把主驾车窗调到 40%",
            intent: "body.window.setPosition",
            speechAct: "command",
            actionability: { actionable: true, reason: "explicit-command" },
            slots: { zone: "driver", percent: 40 },
            slotProvenance: { zone: "explicit", percent: "explicit" },
          },
          semanticTelemetry: {},
        };
      },
    },
    useCases: { task: useCase },
    runEventLedger: ledger,
    sessionMemory: new SessionMemory(),
    now: fixedNow,
    createRequestId: () => runId,
  });
  const result = await runtime.run("把主驾车窗调到 40%", {
    requestId: runId,
    signal: controller.signal,
  });
  return { result, ledger };
}

function projectComplexCausalOrder(events) {
  const projected = [];
  let hasExecutionSnapshot = false;
  for (const event of events) {
    if (["goal-formation", "task-planning", "final-synthesis"].includes(event.phase)) {
      projected.push(`${event.phase}:${event.component}`);
      continue;
    }
    if (event.phase === "task-snapshot"
      && ["executing", "waiting"].includes(event.metadata?.task?.snapshot?.currentStage)
      && !hasExecutionSnapshot) {
      projected.push("task-snapshot:execution-or-waiting");
      hasExecutionSnapshot = true;
      continue;
    }
    if (event.phase === "task-snapshot"
      && ["completed", "failed", "cancelled"].includes(event.metadata?.task?.snapshot?.status)) {
      projected.push("task-snapshot:terminal");
      continue;
    }
    if (event.phase === "final-response") {
      projected.push(`final-response:${event.component}`);
    }
  }
  return projected;
}

function assertTerminalSnapshotBeforeFinal(ledger, taskStatus, eventStatus) {
  const run = ledger.getPreviousRun();
  const terminalSnapshots = run.events.filter((event) => (
    event.phase === "task-snapshot"
    && event.metadata?.task?.snapshot?.status === taskStatus
  ));
  assert.equal(terminalSnapshots.length, 1);
  const snapshotEvent = terminalSnapshots[0];
  const finalEvent = run.events.find((event) => event.phase === "final-response");
  assert.equal(snapshotEvent.status, eventStatus);
  assert.equal(finalEvent.status, eventStatus);
  assert.equal(snapshotEvent.sequence < finalEvent.sequence, true);
  assert.deepEqual(snapshotEvent.metadata.task.snapshot.committedEffects, []);
  assert.equal(snapshotEvent.metadata.task.snapshot.latestFactsRef, null);
  assert.equal(Object.hasOwn(snapshotEvent.metadata.task, "executionFacts"), false);
  assert.equal(run.status, eventStatus === "cancelled" ? "cancelled" : "failed");
}
