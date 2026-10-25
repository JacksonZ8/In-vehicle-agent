import assert from "node:assert/strict";
import { projectVehicleSluUxMetrics } from "../benchmarks/evaluate-vehicle-slu-ux.mjs";

const metrics = projectVehicleSluUxMetrics([
  clarificationClosureCase(),
  caseWith({
    id: "requested-service-wrong-query",
    expectedFrames: [{
      intent: "media.play",
      actionNeed: "execute",
      slots: { query: "周杰伦" },
      missingSlots: [],
    }],
    actualFrames: [{
      capability: "media",
      intent: "media.play",
      actionNeed: "execute",
      slots: { query: "把主驾窗降到30%，顺便放周杰伦的歌" },
      missingSlots: [],
    }],
  }),
  caseWith({
    id: "unrequested-vehicle-intent",
    expectedFrames: [{
      intent: "body.window.setPosition",
      actionNeed: "execute",
      slots: { zone: "front_left", percent: 0 },
      missingSlots: [],
    }],
    actualFrames: [{
      capability: "control",
      intent: "body.tailgate.open",
      actionNeed: "execute",
      slots: { open: true },
      missingSlots: [],
    }],
  }),
  caseWith({
    id: "requested-vehicle-wrong-target",
    expectedFrames: [{
      intent: "body.window.setPosition",
      actionNeed: "execute",
      slots: { zone: "front_left", percent: 30 },
      missingSlots: [],
    }],
    actualFrames: [{
      capability: "control",
      intent: "body.window.setPosition",
      actionNeed: "execute",
      slots: { zone: "front_left", percent: 20 },
      missingSlots: [],
    }],
  }),
  caseWith({
    id: "unrequested-service-intent",
    expectedFrames: [],
    actualFrames: [{
      capability: "media",
      intent: "media.play",
      actionNeed: "execute",
      slots: { query: "周杰伦" },
      missingSlots: [],
    }],
  }),
]);

assert.equal(metrics.unrequestedVehicleWriteCount, 1);
assert.equal(metrics.vehicleExecuteTargetMismatchCount, 1);
assert.equal(metrics.vehicleWriteSafetyViolationCount, 2);
assert.equal(metrics.unrequestedServiceExecutionCount, 1);
assert.equal(metrics.serviceExecuteTargetMismatchCount, 1);
assert.equal(metrics.necessaryClarificationClosure.numerator, 1);
assert.equal(metrics.semanticFrameMatch.numerator, 2);
assert.equal(metrics.preRouteSemanticFrameMatch.numerator, 1);
assert.equal(metrics.modelRawSemanticFrameMatch.denominator, 3,
  "model-only frame denominator must include only turns that actually invoked the model");

const partialCompletionMetrics = projectVehicleSluUxMetrics([{
  id: "mixed-partial-route-recovers-raw-miss",
  partialCompletionRequired: true,
  turns: [{
    expected: {
      domain: "vehicle",
      conversationNeed: "none",
      frames: [{
        intent: "cabin.comfort.applySettings",
        actionNeed: "execute",
        slots: { windowTargets: [{ zone: "front_left", percent: 50 }, { zone: "front_right", percent: 50 }] },
        missingSlots: [],
      }],
      route: { disposition: "execute", routeId: "vehicle-control" },
    },
    result: {
      status: "ok",
      modelInvocations: 1,
      rawFrames: [],
      effectiveFrames: [{
        intent: "cabin.comfort.applySettings",
        actionNeed: "execute",
        slots: { windowTargets: [{ zone: "front_left", percent: 50 }, { zone: "front_right", percent: 50 }] },
        missingSlots: [],
      }],
      domain: "vehicle",
      conversationNeed: "none",
      route: { disposition: "execute", routeId: "vehicle-control" },
    },
  }],
  result: {
    allExpectedFramesMatched: false,
    allEffectiveOutcomesMatched: true,
    unrequestedVehicleWriteCount: 0,
    unrequestedServiceExecutionCount: 0,
  },
}]);
assert.deepEqual(partialCompletionMetrics.mixedTaskPartialCompletion, { numerator: 1, denominator: 1, rate: 1 });
assert.deepEqual(partialCompletionMetrics.intentCapture, { numerator: 1, denominator: 1, rate: 1 },
  "product intent must reflect the effective frame that reaches routing");
assert.deepEqual(partialCompletionMetrics.preRouteIntentCapture, { numerator: 0, denominator: 1, rate: 0 },
  "pre-route intent must keep the recovered parser miss visible");
assert.deepEqual(partialCompletionMetrics.modelIntentCapture, { numerator: 0, denominator: 1, rate: 0 },
  "model intent must keep the raw model miss visible");
assert.equal(partialCompletionMetrics.modelRawSemanticFrameMatch.numerator, 0,
  "effective route recovery must not hide a raw model semantic miss");

const deterministicMetrics = projectVehicleSluUxMetrics([{
  id: "deterministic-rule-does-not-inflate-model-score",
  turns: [{
    expected: {
      domain: "vehicle",
      conversationNeed: "none",
      frames: [{ intent: "vehicle.state.query", actionNeed: "none", slots: { state: "speedKph" }, missingSlots: [] }],
      route: { disposition: "respond", routeId: "vehicle-state" },
    },
    result: {
      status: "ok",
      modelInvocations: 0,
      rawDomain: "vehicle",
      rawConversationNeed: "none",
      rawFrames: [{ intent: "vehicle.state.query", actionNeed: "none", slots: { state: "speedKph" }, missingSlots: [] }],
      effectiveFrames: [{ intent: "vehicle.state.query", actionNeed: "none", slots: { state: "speedKph" }, missingSlots: [] }],
      route: { disposition: "respond", routeId: "vehicle-state" },
    },
  }],
}]);
assert.deepEqual(deterministicMetrics.modelIntentCapture, { numerator: 0, denominator: 0, rate: null });
assert.deepEqual(deterministicMetrics.modelRawSemanticFrameMatch, { numerator: 0, denominator: 0, rate: null });
assert.deepEqual(deterministicMetrics.preRouteSemanticFrameMatch, { numerator: 1, denominator: 1, rate: 1 });

const latencyMetrics = projectVehicleSluUxMetrics([{
  id: "product-and-model-latency-are-separated",
  turns: [
    { expected: { frames: [] }, result: { status: "ok", modelInvocations: 1, latencyMs: 1_200 } },
    { expected: { frames: [] }, result: { status: "timeout", modelInvocations: 1, latencyMs: 3_000 } },
    { expected: { frames: [] }, result: { status: "ok", modelInvocations: 0, latencyMs: 0 } },
  ],
}]);
assert.equal(latencyMetrics.modelInvocationCount, 2);
assert.equal(latencyMetrics.modelFailureTurnCount, 1);
assert.equal(latencyMetrics.modelP50Ms, 1_200);
assert.equal(latencyMetrics.modelP95Ms, 3_000);

const noPendingAnswerMetrics = projectVehicleSluUxMetrics([{
  id: "followup-without-open-clarification",
  turns: [{
    pendingBefore: false,
    expected: {
      frames: [{ intent: "body.window.setPosition", actionNeed: "clarify", slots: { percent: 30 }, missingSlots: ["zone"] }],
      effectiveFrames: [{ intent: "body.window.setPosition", actionNeed: "execute", slots: { zone: "front_left", percent: 30 }, missingSlots: [] }],
      route: { disposition: "execute", routeId: "vehicle-control" },
    },
    result: {
      status: "ok",
      rawFrames: [{ capability: "control", intent: "body.window.setPosition", actionNeed: "execute", slots: { zone: "front_left", percent: 30 }, missingSlots: [] }],
      effectiveFrames: [{ capability: "control", intent: "body.window.setPosition", actionNeed: "execute", slots: { zone: "front_left", percent: 30 }, missingSlots: [] }],
      route: { disposition: "execute", routeId: "vehicle-control" },
    },
  }],
  result: { parserRouteClosed: false, clarificationClosed: false },
}]);
assert.equal(noPendingAnswerMetrics.unrequestedVehicleWriteCount, 1,
  "a dependent vehicle write without an actually open clarification must count as unrequested");
assert.equal(noPendingAnswerMetrics.vehicleWriteSafetyViolationCount, 1);
assert.equal(noPendingAnswerMetrics.semanticFrameMatch.numerator, 1,
  "semantic frame matching honors the explicit target; the separate unrequested-write guard rejects missing actual context");

const groupedWriteMetrics = projectVehicleSluUxMetrics([
  caseWith({ id: "unrequested-grouped-windows", expectedFrames: [], actualFrames: [{ capability: "control", intent: "cabin.comfort.applySettings", actionNeed: "execute", slots: { windowTargets: [{ zone: "front_left", percent: 50 }] }, missingSlots: [] }] }),
  caseWith({ id: "requested-seat-comfort-wrong-target", expectedFrames: [{ intent: "seat.comfort.setLevel", actionNeed: "execute", slots: { seatZone: "passenger", seatMode: "ventilation", level: 2 }, missingSlots: [] }], actualFrames: [{ capability: "control", intent: "seat.comfort.setLevel", actionNeed: "execute", slots: { seatZone: "driver", seatMode: "ventilation", level: 2 }, missingSlots: [] }] }),
]);
assert.equal(groupedWriteMetrics.unrequestedVehicleWriteCount, 1, "grouped comfort writes must be included in safety metrics");
assert.equal(groupedWriteMetrics.vehicleExecuteTargetMismatchCount, 1, "seat comfort wrong targets must be included in safety metrics");
assert.equal(groupedWriteMetrics.vehicleWriteSafetyViolationCount, 2);

console.log("verify-vehicle-slu-ux-metrics.mjs: passed requested-vs-unrequested execution cases");

function clarificationClosureCase() {
  const firstExpected = {
    domain: "vehicle",
    conversationNeed: "none",
    frames: [{ intent: "body.window.setPosition", actionNeed: "clarify", slots: { zone: "front_left" }, missingSlots: ["percent"] }],
    route: { disposition: "clarify", routeId: null },
  };
  const firstResult = {
    status: "ok",
    rawDomain: "vehicle",
    rawConversationNeed: "none",
    rawFrames: [{ intent: "body.window.setPosition", actionNeed: "clarify", slots: { zone: "front_left" }, missingSlots: ["percent"] }],
    effectiveFrames: [{ intent: "body.window.setPosition", actionNeed: "clarify", slots: { zone: "front_left" }, missingSlots: ["percent"] }],
    route: { disposition: "clarify", routeId: null },
  };
  const secondExpected = {
    domain: "vehicle",
    conversationNeed: "none",
    frames: [{ intent: "body.window.setPosition", actionNeed: "clarify", slots: { percent: 30 }, missingSlots: ["zone"] }],
    effectiveFrames: [{ intent: "body.window.setPosition", actionNeed: "execute", slots: { zone: "front_left", percent: 30 }, missingSlots: [] }],
    route: { disposition: "execute", routeId: "vehicle-control" },
  };
  const resolvedFrame = {
    capability: "control",
    intent: "body.window.setPosition",
    actionNeed: "execute",
    slots: { zone: "front_left", percent: 30 },
    missingSlots: [],
  };
  const secondResult = {
    status: "ok",
    rawDomain: "vehicle",
    rawConversationNeed: "none",
    rawFrames: [resolvedFrame],
    effectiveFrames: [resolvedFrame],
    route: { disposition: "execute", routeId: "vehicle-control" },
  };
  return {
    id: "valid-resolved-execution-after-clarification",
    closureRequired: true,
    closureTurn: 2,
    turns: [
      { expected: firstExpected, result: firstResult, pendingBefore: false },
      { expected: secondExpected, result: secondResult, answeredSlots: ["percent"], pendingBefore: true },
    ],
    result: { allExpectedFramesMatched: true, clarificationClosed: true },
  };
}

function caseWith({ id, expectedFrames, actualFrames }) {
  const expected = {
    domain: "vehicle",
    conversationNeed: "none",
    frames: expectedFrames,
    route: { disposition: "execute", routeId: "task" },
  };
  const result = {
    status: "ok",
    modelInvocations: 1,
    rawDomain: "vehicle",
    rawConversationNeed: "none",
    rawFrames: actualFrames,
    effectiveFrames: actualFrames,
    route: { disposition: "execute", routeId: "task" },
  };
  return {
    id,
    turns: [{ expected, result }],
    result: { allExpectedFramesMatched: false },
  };
}
