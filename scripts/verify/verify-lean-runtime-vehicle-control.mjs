#!/usr/bin/env node
import assert from "node:assert/strict";
import { createVehicleControlUseCase } from "../../src/application/use-cases/vehicle-control.js";
import { createToolCall } from "../../src/runtime/agent-schemas.js";
import { createVehicleSluEnvelope } from "../../src/semantic/vehicle-slu-contract.js";
import { RUN_EVENT_PROTOCOL, validateRunEvent } from "../../src/runtime/run-event-protocol.js";
import {
  callNames,
  countCalls,
  createLeanRuntimeVehicleControlHarness,
} from "../lib/lean-runtime-test-harness.mjs";

assert.deepEqual(RUN_EVENT_PROTOCOL, { id: "nio-run-event", version: "2.0.0" });

assert.equal(typeof createVehicleControlUseCase, "function");

const safeHarness = createLeanRuntimeVehicleControlHarness();
assert.equal(typeof safeHarness.useCase.executeAuthorizedVehicleCommand, "function");
const safe = await safeHarness.runtime.run(
  "把主驾车窗打开一半",
  { requestId: "run:control:safe" },
);
assert.deepEqual(callNames(safeHarness.calls).slice(0, 5), [
  "provider.refresh",
  "provider.read",
  "safety.evaluate",
  "vehicle.execute",
  "vehicle.adapter.execute",
]);
assert.equal(safe.runtimeTelemetry.modelCallCount, 1);
assert.equal(countCalls(safeHarness.calls, "manual.retrieve"), 0);
assert.equal(safe.toolCall.commandId, "run:control:safe:1:body.window.setPosition");
assert.deepEqual(safe.toolCall.args, {
  zone: "front_left",
  percent: 50,
  antiPinch: true,
});
assert.equal(safe.toolResult.commandId, safe.toolCall.commandId);
assert.equal(safe.toolResult.executionState, "observed-succeeded");
assert.equal(safe.toolResult.confirmedSnapshotId, safe.vehicleStateSnapshot.id);
assert.equal(safe.vehicleStateSnapshot, safeHarness.provider.getSnapshot());
assert.match(safe.assistantResponse, /传感器.*确认|已确认.*完成/);
assertValidEvents(safe);
assert.equal(hasPhaseParticipant(safe, "vehicle-safety", "safety"), true);
assert.equal(hasPhaseParticipant(safe, "vehicle-execution", "vehicleTool"), true);
assert.equal(hasPhaseParticipant(safe, "vehicle-execution", "vehicleStateProvider"), true);

const partialWindowText = "前排车窗开到一半，后排车窗也打开";
const partialWindowHarness = createLeanRuntimeVehicleControlHarness({
  modelBehavior: {
    async parse(_text, input) {
      return {
        semanticEnvelope: createVehicleSluEnvelope({
          contractVersion: "nio-vehicle-slu-contract@2.0.0",
          requestId: input.requestId,
          domain: "vehicle",
          conversationGoal: { summary: partialWindowText, need: "none" },
          vehicleFrames: [{
            frameId: "f1",
            capability: "control",
            intent: "body.window.setPosition",
            speechAct: "command",
            knowledgeNeed: "none",
            actionNeed: "clarify",
            slots: {},
            missingSlots: ["zone", "percent"],
            clarificationQuestion: "你希望调节哪扇车窗，开到多少？",
            standaloneQuery: null,
            confidence: 0.8,
          }],
          domainConfidence: 0.9,
        }),
      };
    },
  },
});
const partialWindow = await partialWindowHarness.runtime.run(partialWindowText, {
  requestId: "run:control:partial-front-windows",
});
assert.equal(partialWindow.routeDecision.disposition, "clarify");
assert.equal(partialWindow.toolCall, null, "raw text cannot rescue the incomplete model frame");
assert.equal(countCalls(partialWindowHarness.calls, "vehicle.adapter.execute"), 0);
assert.equal(partialWindow.runtimeTelemetry.modelCallCount, 1);

const modelFrontWindows = createLeanRuntimeVehicleControlHarness({
  modelBehavior: {
    async parse(_text, input) {
      return {
        semanticEnvelope: createVehicleSluEnvelope({
          requestId: input.requestId,
          domain: "vehicle",
          conversationGoal: { summary: "模型仅确认前排目标", need: "none" },
          vehicleFrames: [{
            frameId: "f1", capability: "control", intent: "cabin.comfort.applySettings",
            speechAct: "command", knowledgeNeed: "none", actionNeed: "execute",
            slots: { windowTargets: [
              { zone: "front_left", percent: 50 }, { zone: "front_right", percent: 50 },
            ] },
            missingSlots: [], clarificationQuestion: null, standaloneQuery: null, confidence: 0.8,
          }],
          domainConfidence: 0.9,
        }),
      };
    },
  },
});
const modelFrontResult = await modelFrontWindows.runtime.run(partialWindowText, {
  requestId: "run:control:model-front-windows",
});
assert.deepEqual(modelFrontResult.toolCall.args.windowTargets, [
  { zone: "front_left", percent: 50 }, { zone: "front_right", percent: 50 },
]);
assert.equal(modelFrontResult.toolResult.executionState, "observed-succeeded");
assert.doesNotMatch(modelFrontResult.assistantResponse, /后排两扇车窗各需要多少开度/,
  "raw text must not create a clarification absent from the model frames");

safeHarness.resetCalls();
const reusableRunId = safe.requestId;
const reusableToolCall = createToolCall(
  reusableRunId,
  safe.safetyDecision.safeIntent,
  safe.safetyDecision.safeSlots,
  true,
  safe.safetyDecision.slotProvenance,
  { sequence: 2 },
);
const reusableExecution = await safeHarness.useCase.executeAuthorizedVehicleCommand({
  runId: reusableRunId,
  toolCall: reusableToolCall,
  safetyDecision: safe.safetyDecision,
  signal: undefined,
  deadlineAt: undefined,
  vehicleSensorMode: "success",
  vehicleSensorLatencyMs: 0,
  throwIfAborted() {},
  emit() {},
});
assert.equal(reusableExecution.toolResult.commandId, `${reusableRunId}:2:body.window.setPosition`);
assert.equal(reusableExecution.toolResult.executionState, "observed-succeeded");

const forgedDecisionCases = [
  {
    label: "same-run shallow copy",
    runId: safe.requestId,
    sequence: 3,
    decision: { ...safe.safetyDecision },
  },
  {
    label: "cross-run shallow copy",
    runId: "run:control:foreign-safety-decision",
    sequence: 1,
    decision: {
      ...safe.safetyDecision,
      requestId: "run:control:foreign-safety-decision",
    },
  },
  {
    label: "constructed decision",
    runId: safe.requestId,
    sequence: 4,
    decision: {
      requestId: safe.requestId,
      allowed: true,
      action: safe.safetyDecision.action,
      safeIntent: safe.safetyDecision.safeIntent,
      safeSlots: safe.safetyDecision.safeSlots,
      slotProvenance: safe.safetyDecision.slotProvenance,
    },
  },
];
for (const forged of forgedDecisionCases) {
  safeHarness.resetCalls();
  const toolCall = createToolCall(
    forged.runId,
    forged.decision.safeIntent,
    forged.decision.safeSlots,
    true,
    forged.decision.slotProvenance,
    { sequence: forged.sequence },
  );
  await assert.rejects(
    safeHarness.useCase.executeAuthorizedVehicleCommand({
      runId: forged.runId,
      toolCall,
      safetyDecision: forged.decision,
      signal: undefined,
      deadlineAt: undefined,
      vehicleSensorMode: "success",
      vehicleSensorLatencyMs: 0,
      throwIfAborted() {},
      emit() {},
    }),
    /Safety-allowed canonical command/,
    forged.label,
  );
  assert.equal(countCalls(safeHarness.calls, "vehicle.execute"), 0, forged.label);
  assert.equal(countCalls(safeHarness.calls, "vehicle.adapter.execute"), 0, forged.label);
}

const unsafeHarness = createLeanRuntimeVehicleControlHarness({
  safetyState: { rearClearance: false },
});
const unsafe = await unsafeHarness.runtime.run(
  "打开尾门",
  { requestId: "run:control:unsafe" },
);
assert.deepEqual(callNames(unsafeHarness.calls), [
  "provider.refresh", "provider.read", "safety.evaluate",
]);
assert.equal(unsafe.safetyDecision.action, "reject");
assert.equal(unsafe.toolCall, null);
assert.equal(unsafe.toolResult, null);
assert.equal(unsafe.runtimeTelemetry.modelCallCount, 1, "ordinary turns request one model before Safety");
assert.match(unsafe.assistantResponse, /拦截|未执行|不能执行/);
assert.equal(hasParticipant(unsafe, "vehicleTool"), false);
assert.equal(hasParticipant(unsafe, "confirmation"), false);
assertValidEvents(unsafe);

let confirmationManualCandidatePreparations = 0;
const confirmationHarness = createLeanRuntimeVehicleControlHarness({
  safetyState: { rearClearance: null },
  prepareManualRetrievalCandidate() {
    confirmationManualCandidatePreparations += 1;
    return { consume() {}, discard() {} };
  },
});
const challengeResult = await confirmationHarness.runtime.run(
  "打开尾门",
  { requestId: "run:control:challenge" },
);
const challenge = challengeResult.safetyDecision.confirmationChallenge;
assert.equal(challengeResult.safetyDecision.action, "require_confirmation");
assert.equal(challengeResult.toolCall, null);
assert.equal(challengeResult.toolResult, null);
assert.equal(Date.parse(challenge.expiresAt) - Date.parse(challenge.issuedAt), 120_000);
assert.equal(challenge.requestId, "run:control:challenge");
assert.equal(challenge.assertions.length > 0, true);
assert.equal(Object.hasOwn(challenge, "continuationBinding"), false);
assert.match(challengeResult.assistantResponse, /确认.*执行|安全确认/);
assert.equal(countCalls(confirmationHarness.calls, "vehicle.execute"), 0);
assert.equal(hasPhaseParticipant(challengeResult, "vehicle-confirmation", "confirmation"), true);
assert.equal(confirmationHarness.getRouteResolveCount(), 1);
assert.equal(confirmationManualCandidatePreparations, 1);
assertValidEvents(challengeResult);
const privateContinuation = confirmationHarness.useCase.resolveConfirmationContinuation({
  confirmationResponse: responseFor(challenge),
  rawText: "打开尾门",
});
assert.equal(privateContinuation.status, "resolved");
assert.deepEqual(Object.keys(privateContinuation.binding).sort(), [
  "parsedCommand",
  "rawText",
  "routeDecision",
  "routeValidation",
]);
assert.equal(Object.hasOwn(privateContinuation.binding, "semanticTelemetry"), false);
assert.equal(Object.hasOwn(privateContinuation.binding, "vehicleStateSnapshot"), false);

confirmationHarness.resetCalls();
const confirmed = await confirmationHarness.runtime.run(
  "打开尾门",
  {
    requestId: "run:control:confirmed",
    confirmationResponse: responseFor(challenge),
  },
);
assert.equal(confirmed.safetyDecision.action, "allow");
assert.equal(confirmed.toolCall.commandId, "run:control:confirmed:1:body.tailgate.open");
assert.equal(confirmed.toolResult.executionState, "observed-succeeded");
assert.equal(confirmed.toolResult.confirmedSnapshotId, confirmed.vehicleStateSnapshot.id);
assert.equal(countCalls(confirmationHarness.calls, "provider.refresh"), 1);
assert.equal(countCalls(confirmationHarness.calls, "safety.evaluate"), 2);
assert.equal(countCalls(confirmationHarness.calls, "vehicle.execute"), 1);
assert.equal(countCalls(confirmationHarness.calls, "vehicle.adapter.execute"), 1);
assert.equal(countCalls(confirmationHarness.calls, "sensor.submit"), 1);
assert.equal(countCalls(confirmationHarness.calls, "provider.ingestObservation"), 1);
assert.equal(confirmationHarness.getRouteResolveCount(), 1);
assert.equal(confirmationManualCandidatePreparations, 1);
assert.equal(confirmed.runtimeTelemetry.modelCallCount, 0);
assert.equal(hasPhaseParticipant(confirmed, "route-decision", "vehicleSluModel"), false);
assert.equal(hasPhaseParticipant(confirmed, "vehicle-execution", "vehicleStateProvider"), true);
const confirmationRouteEvent = confirmed.events.find((event) => event.phase === "route-decision");
assert.equal(confirmationRouteEvent?.component, "runtimeKernel");
assert.equal(confirmationRouteEvent?.metadata?.routing?.semanticSource, "confirmation-continuation");
assertValidEvents(confirmed);

const keepOpenText = "尾门就保持开着吧，一会还得拿东西";
// The following cases verify Provider/Safety state handling against one fixed model command.
const keepOpenModel = {
  async parse(_text, input) {
    return {
      semanticEnvelope: createVehicleSluEnvelope({
        requestId: input.requestId, domain: "vehicle",
        conversationGoal: { summary: keepOpenText, need: "none" },
        vehicleFrames: [{
          frameId: "f1", capability: "control", intent: "body.tailgate.open",
          speechAct: "command", knowledgeNeed: "none", actionNeed: "execute",
          slots: { open: true }, missingSlots: [], clarificationQuestion: null,
          standaloneQuery: null, confidence: 0.8,
        }],
        domainConfidence: 0.9,
      }),
    };
  },
};
const alreadyOpenTailgateHarness = createLeanRuntimeVehicleControlHarness({
  modelBehavior: keepOpenModel,
  safetyState: { tailgateOpen: true },
});
const alreadyOpenTailgate = await alreadyOpenTailgateHarness.runtime.run(keepOpenText, {
  requestId: "run:control:tailgate-already-open",
});
assert.equal(alreadyOpenTailgate.safetyDecision.action, "allow");
assert.equal(alreadyOpenTailgate.toolCall, null);
assert.equal(alreadyOpenTailgate.toolResult, null);
assert.equal(countCalls(alreadyOpenTailgateHarness.calls, "vehicle.execute"), 0);
assert.equal(countCalls(alreadyOpenTailgateHarness.calls, "vehicle.adapter.execute"), 0);
assert.match(alreadyOpenTailgate.assistantResponse, /已经开着|无需重复/);
assertValidEvents(alreadyOpenTailgate);

const closedTailgateHarness = createLeanRuntimeVehicleControlHarness({
  modelBehavior: keepOpenModel,
  safetyState: { tailgateOpen: false },
});
const closedTailgate = await closedTailgateHarness.runtime.run(keepOpenText, {
  requestId: "run:control:tailgate-closed",
});
assert.equal(closedTailgate.safetyDecision.action, "allow");
assert.equal(closedTailgate.toolCall.tool, "body.tailgate.open");
assert.deepEqual(closedTailgate.toolCall.args, { open: true });
assert.equal(countCalls(closedTailgateHarness.calls, "vehicle.adapter.execute"), 1);
assertValidEvents(closedTailgate);

const staleTailgateHarness = createLeanRuntimeVehicleControlHarness({
  modelBehavior: keepOpenModel,
  safetyState: { tailgateOpen: true },
  staleProvider: true,
});
const staleTailgate = await staleTailgateHarness.runtime.run(keepOpenText, {
  requestId: "run:control:tailgate-state-unknown",
});
assert.equal(staleTailgate.safetyDecision.action, "unavailable");
assert.equal(staleTailgate.toolCall, null);
assert.equal(countCalls(staleTailgateHarness.calls, "vehicle.adapter.execute"), 0);
assertValidEvents(staleTailgate);

confirmationHarness.resetCalls();
const replayed = await confirmationHarness.runtime.run(
  "打开尾门",
  {
    requestId: "run:control:replayed",
    confirmationResponse: responseFor(challenge),
  },
);
assert.equal(replayed.safetyDecision.action, "reject");
assert.match(replayed.safetyDecision.reason, /已使用|重复/);
assert.equal(replayed.toolCall, null);
assert.equal(replayed.toolResult, null);
assert.equal(countCalls(confirmationHarness.calls, "vehicle.adapter.execute"), 0);
assert.equal(confirmationHarness.getRouteResolveCount(), 1);
assert.equal(replayed.runtimeTelemetry.modelCallCount, 0);

{
  const bothInitialSafetyEntered = deferred();
  const releaseInitialSafety = deferred();
  let barrierEnabled = false;
  let initialSafetyEvaluations = 0;
  let trustedSafetyEvaluations = 0;
  const harness = createLeanRuntimeVehicleControlHarness({
    safetyState: { rearClearance: null },
    async refreshVehicleStateForSafety(_input, provider) {
      return { ok: true, snapshot: provider.getSnapshot() };
    },
    async evaluateSafety(command, input, realGateway) {
      const decision = realGateway.evaluate(command, input);
      const trusted = Object.hasOwn(input, "trustedConfirmationAssertions");
      if (barrierEnabled && !trusted) {
        initialSafetyEvaluations += 1;
        if (initialSafetyEvaluations === 2) bothInitialSafetyEntered.resolve();
        await releaseInitialSafety.promise;
      }
      if (trusted) {
        trustedSafetyEvaluations += 1;
      }
      return decision;
    },
  });
  const issued = await harness.runtime.run(
    "打开尾门",
    { requestId: "run:control:concurrent-replay:issue" },
  );
  const response = responseFor(issued.safetyDecision.confirmationChallenge);
  barrierEnabled = true;
  harness.resetCalls();
  const firstRun = harness.useCase.execute(directControlContext({
    runId: "run:control:concurrent-replay:first",
    parsedCommand: issued.parsedCommand,
    confirmationResponse: response,
  }));
  const secondRun = harness.useCase.execute(directControlContext({
    runId: "run:control:concurrent-replay:second",
    parsedCommand: issued.parsedCommand,
    confirmationResponse: response,
  }));
  await bothInitialSafetyEntered.promise;
  releaseInitialSafety.resolve();
  const results = await Promise.all([firstRun, secondRun]);
  const completed = results.filter((result) => result.toolResult?.executionState === "observed-succeeded");
  const rejected = results.filter((result) => result.safetyDecision?.action === "reject");
  assert.equal(trustedSafetyEvaluations, 1);
  assert.equal(completed.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].safetyDecision.reason, /已使用|重复|验证中/);
  assert.equal(rejected[0].toolCall, null);
  assert.equal(rejected[0].toolResult, null);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 1);
  assert.equal(
    harness.calls.filter((entry) => entry.name === "vehicle.adapter.execute"
      && rejected.some((result) => result.safetyDecision.requestId === entry.input.requestId)).length,
    0,
  );
}

{
  const harness = createLeanRuntimeVehicleControlHarness({ safetyState: { rearClearance: null } });
  const issued = await harness.runtime.run(
    "打开尾门",
    { requestId: "run:control:digest-reservation:issue" },
  );
  const response = responseFor(issued.safetyDecision.confirmationChallenge);
  const mismatchedAction = directControlContext({
    runId: "run:control:digest-reservation:mismatch",
    parsedCommand: issued.parsedCommand,
    confirmationResponse: response,
  });
  mismatchedAction.parsedCommand = {
    ...mismatchedAction.parsedCommand,
    slots: { ...mismatchedAction.parsedCommand.slots, requestVariant: "changed" },
    slotProvenance: {
      ...mismatchedAction.parsedCommand.slotProvenance,
      requestVariant: "explicit",
    },
  };
  const mismatch = await harness.useCase.execute(mismatchedAction);
  assert.equal(mismatch.safetyDecision.action, "reject");
  assert.match(mismatch.safetyDecision.reason, /动作参数/);
  harness.resetCalls();
  const acceptedAfterRelease = await harness.useCase.execute(directControlContext({
    runId: "run:control:digest-reservation:accepted",
    parsedCommand: issued.parsedCommand,
    confirmationResponse: response,
  }));
  assert.equal(acceptedAfterRelease.toolResult.executionState, "observed-succeeded");
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 1);
}

for (const [label, responsePatch, reasonPattern] of [
  ["wrong-token", { responseToken: "wrong-token" }, /token/i],
  ["wrong-digest", { actionDigest: `${challenge.actionDigest}:tampered` }, /动作参数/],
  ["wrong-policy", { policyId: "other-policy" }, /策略/],
  ["missing-assertion", { acceptedAssertions: [] }, /断言/],
]) {
  const harness = createLeanRuntimeVehicleControlHarness({ safetyState: { rearClearance: null } });
  const issued = await harness.runtime.run("打开尾门", { requestId: `run:control:${label}:issue` });
  harness.resetCalls();
  const blocked = await harness.runtime.run("打开尾门", {
    requestId: `run:control:${label}:respond`,
    confirmationResponse: responseFor(issued.safetyDecision.confirmationChallenge, responsePatch),
  });
  assert.equal(blocked.safetyDecision.action, "reject", label);
  assert.match(blocked.safetyDecision.reason, reasonPattern, label);
  assert.equal(blocked.toolCall, null, label);
  assert.equal(blocked.toolResult, null, label);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 0, label);
  assert.equal(harness.getRouteResolveCount(), 1, label);
  assert.equal(blocked.runtimeTelemetry.modelCallCount, 0, label);
}

{
  const harness = createLeanRuntimeVehicleControlHarness({ safetyState: { rearClearance: null } });
  const issued = await harness.runtime.run("打开尾门", { requestId: "run:control:cross-request:issue" });
  harness.resetCalls();
  const blocked = await harness.runtime.run("打开尾门", {
    requestId: "run:control:cross-request:respond",
    confirmationResponse: responseFor(issued.safetyDecision.confirmationChallenge, {
      requestId: "run:other-request",
    }),
  });
  assertInvalidConfirmationContinuation(blocked);
  assert.equal(harness.getRouteResolveCount(), 1);
  assert.equal(countCalls(harness.calls, "provider.refresh"), 0);
  assert.equal(countCalls(harness.calls, "safety.evaluate"), 0);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 0);
}

{
  const harness = createLeanRuntimeVehicleControlHarness({ safetyState: { rearClearance: null } });
  const blocked = await harness.runtime.run("打开尾门", {
    requestId: "run:control:random-confirmation:respond",
    confirmationResponse: {
      challengeId: "confirm-random-missing",
      requestId: "run:control:random-confirmation:issue",
      responseToken: "forged-token",
      actionDigest: "forged-digest",
      policyId: "forged-policy",
      acceptedAssertions: [],
    },
  });
  assertInvalidConfirmationContinuation(blocked);
  assert.equal(harness.getRouteResolveCount(), 0);
  assert.equal(countCalls(harness.calls, "provider.refresh"), 0);
  assert.equal(countCalls(harness.calls, "safety.evaluate"), 0);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 0);
}

{
  let changedUnsafe = false;
  const harness = createLeanRuntimeVehicleControlHarness({
    safetyState: { rearClearance: null },
    refreshVehicleStateForSafety(_input, provider) {
      return provider.ingestDemoSensorState({
        source: "demo-sensor-simulator",
        simulated: true,
        capturedAt: "2026-08-04T10:00:00.000Z",
        values: {
          ...provider.getSnapshot().values,
          rearClearance: changedUnsafe ? false : null,
        },
      });
    },
  });
  const issued = await harness.runtime.run("打开尾门", {
    requestId: "run:control:changed-unsafe:issue",
  });
  changedUnsafe = true;
  harness.resetCalls();
  const blocked = await harness.runtime.run("打开尾门", {
    requestId: "run:control:changed-unsafe:respond",
    confirmationResponse: responseFor(issued.safetyDecision.confirmationChallenge),
  });
  assert.equal(blocked.safetyDecision.action, "reject");
  assert.match(blocked.safetyDecision.reason, /后方空间/);
  assert.equal(blocked.runtimeTelemetry.modelCallCount, 0);
  assert.equal(harness.getRouteResolveCount(), 1);
  assert.equal(countCalls(harness.calls, "provider.refresh"), 1);
  assert.equal(countCalls(harness.calls, "safety.evaluate"), 1);
  assert.equal(countCalls(harness.calls, "vehicle.execute"), 0);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 0);
  assertValidEvents(blocked);
}

{
  const harness = createLeanRuntimeVehicleControlHarness({ safetyState: { rearClearance: null } });
  const issued = await harness.runtime.run("打开尾门", { requestId: "run:control:cross-action:issue" });
  harness.resetCalls();
  const blocked = await harness.runtime.run("关闭尾门", {
    requestId: "run:control:cross-action:respond",
    confirmationResponse: responseFor(issued.safetyDecision.confirmationChallenge),
  });
  assertInvalidConfirmationContinuation(blocked);
  assert.equal(harness.getRouteResolveCount(), 1);
  assert.equal(countCalls(harness.calls, "provider.refresh"), 0);
  assert.equal(countCalls(harness.calls, "safety.evaluate"), 0);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 0);
}

{
  const harness = createLeanRuntimeVehicleControlHarness({ safetyState: { rearClearance: null } });
  const issued = await harness.runtime.run("打开尾门", { requestId: "run:control:expired:issue" });
  harness.advanceNow(120_001);
  harness.resetCalls();
  const expired = await harness.runtime.run("打开尾门", {
    requestId: "run:control:expired:respond",
    confirmationResponse: responseFor(issued.safetyDecision.confirmationChallenge),
  });
  assertInvalidConfirmationContinuation(expired);
  assert.equal(harness.getRouteResolveCount(), 1);
  assert.equal(countCalls(harness.calls, "provider.refresh"), 0);
  assert.equal(countCalls(harness.calls, "safety.evaluate"), 0);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 0);
}

const staleHarness = createLeanRuntimeVehicleControlHarness({ staleProvider: true });
const stale = await staleHarness.runtime.run(
  "把主驾车窗打开一半",
  { requestId: "run:control:stale-provider" },
);
assert.equal(stale.safetyDecision.action, "unavailable");
assert.equal(stale.toolCall, null);
assert.equal(stale.toolResult, null);
assert.equal(countCalls(staleHarness.calls, "vehicle.adapter.execute"), 0);
assert.match(stale.assistantResponse, /过期|等待.*刷新|未执行/);

const providerFaultHarness = createLeanRuntimeVehicleControlHarness({ providerFault: "identity-mismatch" });
await assert.rejects(
  providerFaultHarness.runtime.run(
    "把主驾车窗打开一半",
    { requestId: "run:control:provider-fault" },
  ),
  /shared Provider snapshot/i,
);
assert.equal(countCalls(providerFaultHarness.calls, "safety.evaluate"), 0);
assert.equal(countCalls(providerFaultHarness.calls, "vehicle.adapter.execute"), 0);

const mismatchedEnvelopeHarness = createLeanRuntimeVehicleControlHarness({
  mutateCoordinatorEnvelope(envelope) {
    return {
      ...envelope,
      toolResult: { ...envelope.toolResult, commandId: "command:forged" },
    };
  },
});
const mismatchedEnvelope = await mismatchedEnvelopeHarness.runtime.run(
  "把主驾车窗打开一半",
  { requestId: "run:control:command-id-mismatch" },
);
assert.equal(mismatchedEnvelope.toolCall.commandId, "run:control:command-id-mismatch:1:body.window.setPosition");
assert.equal(mismatchedEnvelope.toolResult.commandId, mismatchedEnvelope.toolCall.commandId);
assert.equal(mismatchedEnvelope.toolResult.ok, false);
assert.equal(mismatchedEnvelope.toolResult.executionState, "failed");
assert.match(mismatchedEnvelope.assistantResponse, /未成功|失败/);

const rejectedCoordinatorHarness = createLeanRuntimeVehicleControlHarness({
  mutateCoordinatorEnvelope() {
    throw new Error("coordinator transport failed");
  },
});
const rejectedCoordinator = await rejectedCoordinatorHarness.runtime.run(
  "把主驾车窗打开一半",
  { requestId: "run:control:coordinator-rejected" },
);
assert.equal(rejectedCoordinator.toolResult.executionState, "failed");
assert.equal(rejectedCoordinator.toolResult.executionError.code, "coordinator-boundary-invalid");
assert.match(rejectedCoordinator.assistantResponse, /未成功|失败/);

{
  const controller = new AbortController();
  const harness = createLeanRuntimeVehicleControlHarness({
    onSafetyEvaluated() { controller.abort("cancel-before-dispatch"); },
  });
  await assert.rejects(
    harness.runtime.run("把主驾车窗打开一半", {
      requestId: "run:control:cancel-before-dispatch",
      signal: controller.signal,
    }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 0);
  assert.equal(countCalls(harness.calls, "provider.ingestObservation"), 0);
}

{
  const controller = new AbortController();
  const harness = createLeanRuntimeVehicleControlHarness({
    onAdapterAccepted() { controller.abort("cancel-after-adapter-accepted"); },
  });
  await assert.rejects(
    harness.runtime.run("把主驾车窗打开一半", {
      requestId: "run:control:cancel-after-accepted",
      signal: controller.signal,
    }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 1);
  const events = harness.ledger.getPreviousRun().events;
  assert.equal(events.some((event) => event.phase === "vehicle-execution" && event.status === "processing"), true);
  const providerTerminal = events.find((event) => (
    event.phase === "vehicle-execution"
    && event.status === "completed"
    && event.metadata?.vehicle?.commitmentState === "provider-terminal"
  ));
  assert.ok(providerTerminal, "post-dispatch cancellation must preserve the Provider terminal");
  assert.equal(providerTerminal.metadata.vehicle.cancellation.physicalUndoClaimed, false);
  assert.equal(events.some((event) => event.phase === "final-response" && event.status === "completed"), false);
  assert.equal(harness.ledger.getPreviousRun().status, "cancelled");
}

for (const [sensorMode, expectedState, responsePattern] of [
  ["no-update", "timeout", /超时|未确认/],
  ["timeout", "timeout", /超时|未确认/],
]) {
  const harness = createLeanRuntimeVehicleControlHarness(sensorMode === "no-update"
    ? { confirmationTimeoutMs: 1, timeoutScheduler: (callback) => setTimeout(callback, 0) }
    : {});
  const result = await harness.runtime.run("把主驾车窗打开一半", {
    requestId: `run:control:${sensorMode}`,
    vehicleSensorMode: sensorMode,
  });
  assert.equal(result.toolResult.executionState, expectedState, sensorMode);
  assert.equal(result.toolResult.ok, false, sensorMode);
  assert.equal("confirmedSnapshotId" in result.toolResult, false, sensorMode);
  assert.match(result.assistantResponse, responsePattern, sensorMode);
  assert.equal(result.runtimeTelemetry.modelCallCount, 1, sensorMode);
  assert.equal(countCalls(harness.calls, "manual.retrieve"), 0, sensorMode);
}

for (const result of [
  safe,
  unsafe,
  challengeResult,
  stale,
  mismatchedEnvelope,
  rejectedCoordinator,
]) {
  assert.equal(result.runtimeTelemetry.modelCallCount, 1);
}

console.log("lean runtime vehicle control verification passed");

function responseFor(challenge, patch = {}) {
  return {
    challengeId: challenge.id,
    requestId: challenge.requestId,
    responseToken: challenge.responseToken,
    actionDigest: challenge.actionDigest,
    policyId: challenge.policyId,
    acceptedAssertions: challenge.assertions.map((assertion) => assertion.id),
    ...patch,
  };
}

function assertValidEvents(result) {
  assert.equal(result.events.every((event) => validateRunEvent(event).length === 0), true);
}

function hasParticipant(result, participantId) {
  return result.events.some((event) => event.component === participantId);
}

function hasPhaseParticipant(result, phase, participantId) {
  return result.events.some((event) => event.phase === phase && event.component === participantId);
}

function assertInvalidConfirmationContinuation(result) {
  assert.equal(result.routeDecision.disposition, "respond");
  assert.equal(result.routeDecision.semanticSource, "confirmation-continuation");
  assert.equal(result.routeDecision.reasonCode, "confirmation-continuation-invalid");
  assert.equal(result.safetyDecision, null);
  assert.equal(result.toolCall, null);
  assert.equal(result.toolResult, null);
  assert.equal(result.runtimeTelemetry.modelCallCount, 0);
  assert.match(result.assistantResponse, /安全确认已失效|重新发起/);
  assertValidEvents(result);
}

function directControlContext({ runId, parsedCommand, confirmationResponse }) {
  return {
    runId,
    rawText: "打开尾门",
    parsedCommand: { ...parsedCommand, requestId: runId },
    confirmationResponse,
    signal: undefined,
    deadlineAt: undefined,
    vehicleSensorMode: "success",
    vehicleSensorLatencyMs: 0,
    throwIfAborted() {},
    emit() {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
