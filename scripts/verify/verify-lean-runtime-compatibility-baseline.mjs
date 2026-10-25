import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  callNames,
  countCalls,
  createCompatibilityHarness,
} from "../lib/lean-runtime-test-harness.mjs";
import { InteractionSessionController } from "../../src/interaction/interaction-session-controller.js";
import { buildInteractionSessionDebugSnapshot } from "../../src/app/run-event-presenter.js";
import { projectPublicHmiEvidence } from "../benchmarks/run-b4-baseline.mjs";

const modelCallNames = new Set(["semantic.parse", "cloud.converse", "cloud.plan", "cloud.explain"]);
const cases = [
  {
    id: "chat",
    input: "你好，陪我聊聊",
    expected: {
      route: { disposition: "execute", routeId: "chat", mode: "direct" },
      calls: ["semantic.parse", "cloud.converse"],
      modelCalls: 2,
    },
  },
  {
    id: "knowledge-static",
    input: "ES8 打开尾门前需要确认什么条件？",
    expected: {
      route: { disposition: "execute", routeId: "vehicle-knowledge", mode: "direct" },
      calls: ["semantic.parse", "manual.retrieve", "knowledge.synthesize", "cloud.explain"],
      modelCalls: 2,
    },
  },
  {
    id: "knowledge-current-safe",
    input: "我的 ES8 现在是否可以打开尾门？",
    semanticEnvelope(requestId) {
      return {
        contractVersion: "nio-vehicle-slu-contract@2.0.0",
        requestId,
        domain: "vehicle",
        conversationGoal: { summary: "ES8 尾门当前开启资格", need: "explain" },
        vehicleFrames: [{
          frameId: `frame:${requestId}:tailgate-eligibility`,
          capability: "knowledge",
          intent: "vehicle.knowledge.query",
          speechAct: "question",
          knowledgeNeed: "manual",
          actionNeed: "none",
          slots: {
            query: "ES8 尾门现在是否可以打开？",
            vehicleModel: "ES8",
            eligibilityAction: "body.tailgate.open",
          },
          missingSlots: [],
          clarificationQuestion: null,
          standaloneQuery: "ES8 尾门现在是否可以打开？",
          confidence: 0.99,
        }],
        domainConfidence: 0.99,
      };
    },
    expected: {
      route: { disposition: "execute", routeId: "vehicle-knowledge", mode: "direct" },
      calls: [
        "semantic.parse", "manual.retrieve", "provider.refresh", "provider.read", "provider.read",
        "safety.evaluate", "knowledge.synthesize", "cloud.explain",
      ],
      modelCalls: 2,
    },
  },
  {
    id: "control-safe",
    input: "把主驾车窗打开一半",
    expected: {
      route: { disposition: "execute", routeId: "vehicle-control", mode: "direct" },
      calls: [
        "semantic.parse", "provider.refresh", "provider.read", "safety.evaluate", "vehicle.execute",
        "vehicle.adapter.execute", "provider.write", "sensor.submit",
        "provider.ingestObservation", "provider.read", "provider.read",
      ],
      modelCalls: 1,
    },
  },
  {
    id: "control-unsafe",
    input: "打开尾门",
    harnessOptions: { safetyState: { rearClearance: null } },
    expected: {
      route: { disposition: "execute", routeId: "vehicle-control", mode: "direct" },
      calls: ["semantic.parse", "provider.refresh", "provider.read", "safety.evaluate"],
      modelCalls: 1,
    },
  },
  {
    id: "clarification",
    input: "把座椅调一下",
    expected: {
      route: { disposition: "clarify", routeId: null, mode: null },
      calls: ["semantic.parse"],
      modelCalls: 1,
    },
  },
  {
    id: "weather",
    input: "明天上海天气怎么样？",
    expected: {
      route: { disposition: "execute", routeId: "task", mode: "direct-capability" },
      calls: ["semantic.parse", "external.execute"],
      modelCalls: 1,
    },
  },
];

const results = new Map();
for (const { id, input, harnessOptions = {}, semanticEnvelope, expected } of cases) {
  const harness = createCompatibilityHarness({
    route: id,
    ...harnessOptions,
    ...(semanticEnvelope ? {
      modelBehavior: {
        async parse(_text, input) {
          return { semanticEnvelope: semanticEnvelope(input.requestId) };
        },
      },
    } : {}),
  });
  const requestId = `baseline:${id}`;
  const result = await harness.runtime.run(input, { requestId });
  assert.deepEqual({
    disposition: result.routeDecision.disposition,
    routeId: result.routeDecision.routeId,
    mode: result.routeDecision.mode,
  }, expected.route, `${id}: exact production route`);
  assert.deepEqual(callNames(harness.calls), expected.calls, `${id}: exact capability calls`);
  assert.equal(countCalls(harness.calls, "semantic.parse"), 1, `${id}: exactly one Vehicle-SLU call`);
  assert.equal(
    harness.calls.filter((entry) => modelCallNames.has(entry.name)).length,
    expected.modelCalls,
    `${id}: exact model call count`,
  );
  assert.equal(result.requestId, requestId, id);
  results.set(id, { harness, result, requestId });
}

const safe = results.get("control-safe");
assert.equal(safe.result.safetyDecision.allowed, true);
assert.ok(countCalls(safe.harness.calls, "safety.evaluate") >= 1);
assert.equal(countCalls(safe.harness.calls, "vehicle.adapter.execute"), 1);
assert.equal(countCalls(safe.harness.calls, "sensor.submit"), 1);
assert.equal(countCalls(safe.harness.calls, "provider.ingestObservation"), 1);
assert.equal(safe.result.toolCall.commandId, "baseline:control-safe:1:body.window.setPosition");
assert.equal(safe.result.toolResult.commandId, safe.result.toolCall.commandId);
assert.equal(safe.result.toolResult.confirmedSnapshotId, safe.result.vehicleStateSnapshot.id);

const unsafe = results.get("control-unsafe");
assert.equal(countCalls(unsafe.harness.calls, "vehicle.adapter.execute"), 0);
assert.equal(unsafe.result.safetyDecision.action, "require_confirmation");

for (const id of ["knowledge-static", "knowledge-current-safe"]) {
  const { harness } = results.get(id);
  assert.equal(countCalls(harness.calls, "vehicle.execute"), 0, `${id}: no Vehicle Tool calls`);
  assert.equal(countCalls(harness.calls, "vehicle.adapter.execute"), 0, `${id}: no vehicle Adapter calls`);
  assert.equal(countCalls(harness.calls, "provider.write"), 0, `${id}: no Provider writes`);
  assert.equal(countCalls(harness.calls, "provider.ingestObservation"), 0, `${id}: no Provider confirmation`);
}

const staticKnowledge = results.get("knowledge-static");
assert.equal(countCalls(staticKnowledge.harness.calls, "provider.refresh"), 0, "static knowledge has zero Provider reads");
assert.equal(countCalls(staticKnowledge.harness.calls, "provider.read"), 0, "static knowledge has zero Provider snapshots");
assert.equal(countCalls(staticKnowledge.harness.calls, "safety.evaluate"), 0, "static knowledge has zero Safety evaluation");

const weather = results.get("weather");
assert.equal(countCalls(weather.harness.calls, "manual.retrieve"), 0);
assert.equal(countCalls(weather.harness.calls, "safety.evaluate"), 0);
assert.equal(countCalls(weather.harness.calls, "vehicle.adapter.execute"), 0);
assert.equal(countCalls(weather.harness.calls, "provider.ingestObservation"), 0);
assert.equal(countCalls(weather.harness.calls, "sensor.submit"), 0);

const goldenFixture = JSON.parse(await readFile(
  new URL("../../data/semantic-golden/vehicle-slu-2.0.0.json", import.meta.url),
  "utf8",
));
const mixed009 = goldenFixture.cases.find(({ id }) => id === "slu-mixed-009");
assert.ok(mixed009, "slu-mixed-009 must remain in the frozen fixture");
const mixedRequestId = "baseline:slu-mixed-009-runtime-owner";
const mixedEnvelope = structuredClone(mixed009.expected.semanticEnvelope);
mixedEnvelope.requestId = mixedRequestId;
const mixedHarness = createCompatibilityHarness({
  route: "mixed-state-media-runtime-owner",
  modelBehavior: {
    async parse() {
      return { semanticEnvelope: mixedEnvelope };
    },
  },
});
const mixedResult = await mixedHarness.runtime.run(mixed009.text, { requestId: mixedRequestId });
assert.deepEqual({
  disposition: mixedResult.routeDecision.disposition,
  routeId: mixedResult.routeDecision.routeId,
  mode: mixedResult.routeDecision.mode,
}, { disposition: "execute", routeId: "task", mode: "orchestrated" },
"slu-mixed-009 must enter the real runtime-to-complex-task path");
assert.deepEqual(mixedResult.executionFacts.stepResults.map(({ capabilityId }) => capabilityId),
  ["vehicle-state-provider.read"],
  "the deterministic compatibility plan must select only the registered state owner");
assert.equal(countCalls(mixedHarness.calls, "orchestrator.plan"), 1);
assert.equal(countCalls(mixedHarness.calls, "state.owner.execute"), 1);
assert.ok(countCalls(mixedHarness.calls, "provider.read") >= 1,
  "state capability must reach VehicleStateProvider through vehicleKnowledgeUseCase state-only execution");
for (const forbiddenCall of [
  "manual.retrieve",
  "memory.read",
  "session-memory.read",
  "knowledge.plan",
  "knowledge.synthesize",
  "cloud.plan",
  "cloud.explain",
  "external.execute",
  "vehicle.execute",
  "vehicle.adapter.execute",
  "provider.write",
  "provider.ingestObservation",
  "sensor.submit",
]) {
  assert.equal(countCalls(mixedHarness.calls, forbiddenCall), 0,
    `slu-mixed-009 must not invoke ${forbiddenCall}`);
}
assert.match(mixedResult.assistantResponse, /media-1/,
  "unsupported media frame must remain explicit and deferred in the final boundary");

const stateWeatherRequestId = "baseline:state-weather-owner-authority";
const stateWeatherEnvelope = vehicleEnvelope(stateWeatherRequestId, [
  readonlyFrame("state-weather-state", "knowledge", "vehicle.state.query", {
    stateFields: ["speedKph"],
  }),
  readonlyFrame("state-weather-weather", "weather", "weather.query", {
    location: "杭州",
    timeRange: "today",
  }),
]);
const stateWeatherHarness = createCompatibilityHarness({
  route: "state-weather-owner-authority",
  modelBehavior: { async parse() { return { semanticEnvelope: stateWeatherEnvelope }; } },
});
const stateWeatherResult = await stateWeatherHarness.runtime.run(
  "这段原文故意不提供天气权威",
  { requestId: stateWeatherRequestId },
);
assert.equal(stateWeatherResult.parsedCommand.slots.topic, "vehicle_state",
  "global compatibility projection deliberately remains a state command in this regression");
assert.equal(countCalls(stateWeatherHarness.calls, "state.owner.execute"), 1);
assert.equal(countCalls(stateWeatherHarness.calls, "external.owner.execute"), 1);
const weatherAdapterCall = stateWeatherHarness.calls.find(({ name }) => name === "external.execute");
assert.deepEqual(weatherAdapterCall.input.toolCall, {
  requestId: stateWeatherRequestId,
  commandId: `${stateWeatherRequestId}:weather-state-weather-weather:1:external.query`,
  tool: "conversation.general",
  args: {
    topic: "weather_query",
    externalDataType: "weather",
    query: "{\"intent\":\"weather.query\",\"location\":\"杭州\",\"timeRange\":\"today\"}",
    location: "杭州",
    timeRange: "today",
  },
}, "weather owner must use only the exact weather step/frame, never the global parsed command");
assert.equal(stateWeatherResult.taskStatus, "completed");

const manualStateRequestId = "baseline:manual-state-owner-authority";
const manualFrameQuery = "ES8 车窗防夹如何工作？";
const manualStateEnvelope = vehicleEnvelope(manualStateRequestId, [
  readonlyFrame("manual-state-state-first", "knowledge", "vehicle.state.query", {
    stateFields: ["gear"],
  }),
  readonlyFrame("manual-state-manual-second", "knowledge", "vehicle.knowledge.query", {
    query: manualFrameQuery,
    vehicleModel: "ES8",
  }, { knowledgeNeed: "manual", standaloneQuery: manualFrameQuery }),
]);
const manualStateHarness = createCompatibilityHarness({
  route: "manual-state-owner-authority",
  modelBehavior: { async parse() { return { semanticEnvelope: manualStateEnvelope }; } },
});
const manualStateResult = await manualStateHarness.runtime.run(
  "冲突原文：请只查尾门，不要查车窗防夹",
  { requestId: manualStateRequestId },
);
assert.equal(countCalls(manualStateHarness.calls, "state.owner.execute"), 1);
assert.equal(countCalls(manualStateHarness.calls, "knowledge.owner.execute"), 1);
assert.ok(countCalls(manualStateHarness.calls, "provider.read") >= 1,
  "state owner must reach the Provider using its own scoped frame");
assert.equal(countCalls(manualStateHarness.calls, "manual.retrieve"), 1,
  "manual owner must reach Manual RAG using its own scoped frame");
assert.equal(
  manualStateHarness.calls.find(({ name }) => name === "manual.retrieve").input.query,
  manualFrameQuery,
  "typed manual frame query must override conflicting raw text",
);
assert.equal(manualStateResult.taskStatus, "completed");

const tailgate = await runTailgateConfirmation();
const {
  controllerSnapshot,
  issuedTurn,
  confirmedTurn,
  issued,
  confirmed,
  challenge,
  confirmationResponse,
  issuedCalls,
  confirmedCalls,
} = tailgate;
assert.equal(issued.requestId, issuedTurn.runId);
assert.deepEqual(issued.interactionRef, { sessionId: issuedTurn.sessionId, turnId: issuedTurn.turnId });
assert.equal(confirmed.requestId, confirmedTurn.runId);
assert.deepEqual(confirmed.interactionRef, { sessionId: confirmedTurn.sessionId, turnId: confirmedTurn.turnId });
assert.ok(challenge, "tailgate must issue a confirmation challenge before writing");
assert.equal(challenge.requestId, issuedTurn.runId);
assert.equal(confirmationResponse.challengeId, challenge.id);
assert.equal(confirmationResponse.requestId, challenge.requestId);
assert.equal(confirmationResponse.responseToken, challenge.responseToken);
assert.equal(confirmationResponse.actionDigest, challenge.actionDigest);
assert.equal(confirmationResponse.policyId, challenge.policyId);
assert.equal(countCalls(issuedCalls, "vehicle.adapter.execute"), 0);
assert.equal(confirmed.toolCall.commandId, `${confirmedTurn.runId}:1:body.tailgate.open`);
assert.equal(confirmed.toolResult.confirmedSnapshotId, confirmed.vehicleStateSnapshot.id);
assert.equal(countCalls(confirmedCalls, "vehicle.adapter.execute"), 1);
assert.equal(countCalls(confirmedCalls, "provider.ingestObservation"), 1);

const publicConfirmationEvidence = projectConfirmationEvidence({
  controllerSnapshot,
  confirmed,
});
assert.deepEqual(controllerSnapshot.currentSession.relatedRunIds, [issuedTurn.runId, confirmedTurn.runId]);
assert.deepEqual(publicConfirmationEvidence.interactionRunIds, [issuedTurn.runId, confirmedTurn.runId]);
assert.ok(callNames(safe.harness.calls).includes("provider.write"), "provider.write is the compatibility alias for Adapter dispatch");
console.log("lean runtime compatibility baseline passed");

function projectConfirmationEvidence({ controllerSnapshot, confirmed }) {
  const interactionDebug = buildInteractionSessionDebugSnapshot(controllerSnapshot);
  return projectPublicHmiEvidence({
    probeResult: { runDebug: { requestId: confirmed.requestId, result: confirmed } },
    publicDebug: {
      relatedRunIds: controllerSnapshot.currentSession.relatedRunIds,
      interactionEvents: interactionDebug.interactionEvents,
    },
  });
}

async function runTailgateConfirmation() {
  let now = Date.parse("2026-08-04T00:00:00.000Z");
  let sequence = 0;
  const controller = new InteractionSessionController({
    now: () => (now += 1),
    setTimer: () => "compatibility-timer",
    clearTimer: () => {},
    createId(kind) {
      sequence += 1;
      return `${kind}:tailgate:${sequence}`;
    },
  });
  const harness = createCompatibilityHarness({
    route: "control-unsafe",
    safetyState: { rearClearance: null },
  });
  controller.wake({ provider: "compatibility-harness", simulated: true });
  const issuedTurn = controller.submitTurn({ rawText: "打开尾门", trigger: "text", relation: "new-goal" });
  const issued = await harness.runtime.run("打开尾门", {
    requestId: issuedTurn.runId,
    sessionId: issuedTurn.sessionId,
    interactionRef: { sessionId: issuedTurn.sessionId, turnId: issuedTurn.turnId },
  });
  controller.linkRun(issuedTurn.turnId, {
    runId: issued.requestId,
    eventIds: issued.events.map((event) => event.eventId),
  });
  const challenge = issued.safetyDecision.confirmationChallenge;
  const issuedCalls = [...harness.calls];
  controller.completeTurn(issuedTurn.turnId, { outputMode: "text" });
  controller.startListening();
  const confirmedTurn = controller.submitTurn({ rawText: "确认打开尾门", trigger: "text", relation: "follow-up" });
  const confirmationResponse = {
    challengeId: challenge.id,
    requestId: challenge.requestId,
    responseToken: challenge.responseToken,
    actionDigest: challenge.actionDigest,
    policyId: challenge.policyId,
    acceptedAssertions: challenge.assertions.map((assertion) => assertion.id),
  };
  harness.resetCalls();
  const confirmed = await harness.runtime.run("打开尾门", {
    requestId: confirmedTurn.runId,
    sessionId: confirmedTurn.sessionId,
    interactionRef: { sessionId: confirmedTurn.sessionId, turnId: confirmedTurn.turnId },
    confirmationResponse,
  });
  controller.linkRun(confirmedTurn.turnId, {
    runId: confirmed.requestId,
    parentRunId: issued.requestId,
    eventIds: confirmed.events.map((event) => event.eventId),
  });
  const confirmedCalls = [...harness.calls];
  controller.completeTurn(confirmedTurn.turnId, { outputMode: "text" });
  return {
    controllerSnapshot: controller.getSnapshot(),
    issuedTurn,
    confirmedTurn,
    issued,
    confirmed,
    challenge,
    confirmationResponse,
    issuedCalls,
    confirmedCalls,
  };
}

function vehicleEnvelope(requestId, vehicleFrames) {
  return {
    contractVersion: "nio-vehicle-slu-contract@2.0.0",
    requestId,
    domain: "vehicle",
    conversationGoal: { summary: "执行结构化只读请求", need: "explain" },
    vehicleFrames,
    domainConfidence: 0.99,
  };
}

function readonlyFrame(frameId, capability, intent, slots, overrides = {}) {
  return {
    frameId,
    capability,
    intent,
    speechAct: "question",
    knowledgeNeed: "none",
    actionNeed: "none",
    slots,
    missingSlots: [],
    clarificationQuestion: null,
    standaloneQuery: null,
    confidence: 0.98,
    ...overrides,
  };
}
