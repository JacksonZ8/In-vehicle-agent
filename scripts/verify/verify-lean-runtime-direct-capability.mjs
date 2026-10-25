#!/usr/bin/env node
import assert from "node:assert/strict";
import { createComplexTaskUseCase } from "../../src/application/use-cases/complex-task.js";
import { createDirectExternalWeatherUseCase } from "../../src/application/use-cases/external-weather.js";
import { RUN_EVENT_PROTOCOL, validateRunEvent } from "../../src/runtime/run-event-protocol.js";
import {
  callNames,
  countCalls,
  createLeanRuntimeDirectCapabilityHarness,
} from "../lib/lean-runtime-test-harness.mjs";

const POISON = "POISON_RAW_ADAPTER_PAYLOAD_DO_NOT_LEAK";

assert.deepEqual(RUN_EVENT_PROTOCOL, { id: "nio-run-event", version: "2.0.0" });

assert.equal(typeof createComplexTaskUseCase, "function");
assert.equal(typeof createDirectExternalWeatherUseCase, "function");

assert.throws(
  () => createComplexTaskUseCase(),
  /externalDataAdapter\.execute\(\) is required/,
);

const successAbort = new AbortController();
const successHarness = createLeanRuntimeDirectCapabilityHarness();
const success = await successHarness.runtime.run("明天上海天气怎么样？", {
  requestId: "run:direct:weather:shanghai",
  signal: successAbort.signal,
  deadlineAt: 1_786_000_000_000,
});
assert.equal(success.routeDecision.routeId, "task");
assert.equal(success.routeDecision.mode, "direct-capability");
assert.equal(success.voiceBridgeEligibility.allowed, false);
assert.equal(success.voiceBridgeEligibility.reason, "external-data-or-poi-route");
assert.equal(success.runtimeTelemetry.modelCallCount, 1);
assert.deepEqual(callNames(successHarness.calls), ["external.execute"]);
assert.equal(countCalls(successHarness.calls, "external.execute"), 1);
const successAdapterCall = successHarness.calls[0].input;
assert.deepEqual(successAdapterCall.toolCall, {
  requestId: "run:direct:weather:shanghai",
  commandId: "run:direct:weather:shanghai:1:conversation.general",
  tool: "conversation.general",
  args: {
    topic: "weather_query",
    externalDataType: "weather",
    query: "明天上海天气怎么样？",
    rawText: "明天上海天气怎么样？",
  },
  argProvenance: {
    topic: "unknown",
    externalDataType: "unknown",
    query: "unknown",
    rawText: "unknown",
  },
  requiresSafety: false,
});
assert.equal(successAdapterCall.input.signal, successAbort.signal);
assert.equal(successAdapterCall.input.deadlineAt, 1_786_000_000_000);
assert.equal(success.toolCall, successAdapterCall.toolCall);
assert.equal(success.toolResult.commandId, success.toolCall.commandId);
assert.equal(success.toolResult.ok, true);
assert.equal(success.assistantResponse, "上海明天小雨，25°C到30°C，降水概率最高70%。");
assert.equal(success.toolResult.evidenceRefs[0].type, "external-weather");
assert.equal(successHarness.weatherRequests.length, 1);
assert.deepEqual(JSON.parse(successHarness.weatherRequests[0].input.body), {
  query: "明天上海天气怎么样？",
});
assertDirectIsolation(success, successHarness.calls);
assert.deepEqual(success.events.map(({ component, phase, status }) => ({
  component, phase, status,
})), [
  { component: "cabinAssistant", phase: "intake", status: "processing" },
  { component: "vehicleSluModel", phase: "route-decision", status: "completed" },
  { component: "voiceBridgeEligibility", phase: "voice-bridge-eligibility", status: "completed" },
  { component: "externalDataAdapter", phase: "external-query", status: "processing" },
  { component: "externalDataAdapter", phase: "external-query", status: "completed" },
  { component: "responsePresentation", phase: "external-query", status: "completed" },
  { component: "cabinAssistant", phase: "final-response", status: "completed" },
]);
assert.equal(success.events.every((event) => validateRunEvent(event).length === 0), true);
assert.equal(successHarness.ledger.getCurrentRun(), null);
assert.equal(successHarness.ledger.getPreviousRun().status, "completed");

let poisonedSuccessAdapterResult;
const poisonedSuccessHarness = createLeanRuntimeDirectCapabilityHarness({
  adapterBehavior(toolCall) {
    const base = externalSuccess(toolCall, "上海明天多云。");
    poisonedSuccessAdapterResult = {
      ...base,
      statePatch: {
        weatherData: {
          location: { city: "上海", debugPayload: POISON },
          rawResponse: POISON,
        },
        debugPayload: POISON,
      },
      evidenceRefs: base.evidenceRefs.map((evidence) => ({ ...evidence, debugPayload: POISON })),
      rawResponse: POISON,
      debugPayload: { raw: POISON },
    };
    return poisonedSuccessAdapterResult;
  },
});
const poisonedSuccess = await poisonedSuccessHarness.runtime.run("上海天气怎么样", {
  requestId: "run:direct:weather:poisoned-success",
});
assert.equal(poisonedSuccess.assistantResponse, "上海明天多云。");
assert.notEqual(poisonedSuccess.toolResult, poisonedSuccessAdapterResult);
assert.equal(Object.isFrozen(poisonedSuccess.toolResult), true);
assert.equal(Object.isFrozen(poisonedSuccess.toolResult.statePatch.weatherData), true);
assert.equal(Object.isFrozen(poisonedSuccess.toolResult.evidenceRefs), true);
assert.deepEqual(poisonedSuccess.toolResult.evidenceRefs, [{
  id: "weather:open-meteo:2026-08-04T11:00:00.000Z",
  source: "open-meteo",
  type: "external-weather",
  title: "上海天气",
  citation: "https://api.open-meteo.com/v1/forecast",
}]);
assertPayloadAbsent(poisonedSuccess, POISON, "grounded success projection");
assertDirectIsolation(poisonedSuccess, poisonedSuccessHarness.calls);

for (const clarificationCase of [
  {
    label: "missing location",
    rawText: "这里天气怎么样",
    requestId: "run:direct:weather:missing-location",
    code: "weather_location_needs_clarification",
    clarification: "请补充当前所在城市。",
    extra: { reference: "current" },
  },
  {
    label: "ambiguous location",
    rawText: "朝阳天气怎么样",
    requestId: "run:direct:weather:ambiguous-location",
    code: "weather_location_ambiguous",
    clarification: "请补充省份，确认是北京朝阳还是辽宁朝阳。",
    extra: { candidates: [{ city: "朝阳区", admin1: "北京" }, { city: "朝阳市", admin1: "辽宁" }] },
  },
]) {
  const weatherLocationClarification = Object.freeze({
    policy: "nio-weather-location-clarification@1.0.0",
    code: clarificationCase.code,
    clarification: clarificationCase.clarification,
    ...clarificationCase.extra,
    rawResponse: POISON,
    debugPayload: { raw: POISON },
  });
  const expectedExecutionError = Object.freeze({
    code: clarificationCase.code,
    message: "天气地点需要进一步确认。",
    stage: "execution",
    retryable: false,
  });
  const adapterExecutionError = Object.freeze({
    ...expectedExecutionError,
    rawResponse: POISON,
    details: { debugPayload: POISON },
  });
  const harness = createLeanRuntimeDirectCapabilityHarness({
    adapterBehavior: (toolCall) => externalFailure(toolCall, {
      executionError: adapterExecutionError,
      hmiSummary: POISON,
      weatherLocationClarification,
    }),
  });
  const result = await harness.runtime.run(clarificationCase.rawText, {
    requestId: clarificationCase.requestId,
  });
  assert.equal(result.assistantResponse, clarificationCase.clarification, clarificationCase.label);
  assert.deepEqual(result.toolResult.weatherLocationClarification, {
    policy: "nio-weather-location-clarification@1.0.0",
    code: clarificationCase.code,
    clarification: clarificationCase.clarification,
    ...clarificationCase.extra,
  }, `${clarificationCase.label}: only allowed clarification fields may cross the boundary`);
  assert.deepEqual(result.toolResult.executionError, expectedExecutionError, clarificationCase.label);
  assert.equal(Object.isFrozen(result.toolResult), true, clarificationCase.label);
  assert.equal(Object.isFrozen(result.toolResult.weatherLocationClarification), true, clarificationCase.label);
  assertPayloadAbsent(result, POISON, clarificationCase.label);
  assert.equal(result.toolCall.commandId, `${clarificationCase.requestId}:1:conversation.general`);
  assertDirectIsolation(result, harness.calls);
  assert.equal(hasPhaseParticipant(result, "external-query", "responsePresentation"), true);
}

for (const fallbackClarification of [
  {
    code: "weather_location_needs_clarification",
    response: "请补充需要查询天气的城市。",
  },
  {
    code: "weather_location_ambiguous",
    response: "天气地点存在歧义，请补充省份或城市信息。",
  },
]) {
  const harness = createLeanRuntimeDirectCapabilityHarness({
    adapterBehavior: (toolCall) => externalFailure(toolCall, {
      executionError: Object.freeze({
        code: fallbackClarification.code,
        message: "天气地点需要进一步确认。",
        stage: "execution",
        retryable: false,
      }),
      hmiSummary: "天气地点需要进一步确认。",
    }),
  });
  const result = await harness.runtime.run("这里天气怎么样", {
    requestId: `run:direct:weather:fallback:${fallbackClarification.code}`,
  });
  assert.equal(result.assistantResponse, fallbackClarification.response);
  assert.deepEqual(result.toolResult.weatherLocationClarification, {
    policy: "nio-weather-location-clarification@1.0.0",
    code: fallbackClarification.code,
    clarification: fallbackClarification.response,
  });
  assertDirectIsolation(result, harness.calls);
}

const mismatchedClarificationHarness = createLeanRuntimeDirectCapabilityHarness({
  adapterBehavior: (toolCall) => ({
    ...externalFailure(toolCall, {
      executionError: Object.freeze({
        code: "weather_location_ambiguous",
        message: "ambiguous",
        stage: "execution",
        retryable: false,
      }),
      hmiSummary: "天气地点需要进一步确认。",
      weatherLocationClarification: Object.freeze({
        policy: "nio-weather-location-clarification@1.0.0",
        code: "weather_location_ambiguous",
        clarification: "不可信的跨 Run 澄清。",
      }),
    }),
    commandId: "run:foreign:1:conversation.general",
  }),
});
const mismatchedClarification = await mismatchedClarificationHarness.runtime.run("朝阳天气怎么样", {
  requestId: "run:direct:weather:mismatched-clarification",
});
assert.equal(mismatchedClarification.assistantResponse, "天气实时信息暂时不可用。");
assert.equal(mismatchedClarification.toolResult.executionError.code, "external-evidence-invalid");
assert.equal(JSON.stringify(mismatchedClarification).includes("不可信的跨 Run 澄清。"), false);
assertDirectIsolation(mismatchedClarification, mismatchedClarificationHarness.calls);

const contradictoryClarificationError = Object.freeze({
  code: "weather_location_ambiguous",
  message: "ambiguous",
  stage: "execution",
  retryable: false,
});
const contradictoryClarificationHarness = createLeanRuntimeDirectCapabilityHarness({
  adapterBehavior: (toolCall) => ({
    ...externalSuccess(toolCall, "不可信的成功澄清。"),
    evidenceRefs: [],
    executionError: contradictoryClarificationError,
    weatherLocationClarification: Object.freeze({
      policy: "nio-weather-location-clarification@1.0.0",
      code: "weather_location_ambiguous",
      clarification: "不可信的成功澄清。",
    }),
  }),
});
const contradictoryClarification = await contradictoryClarificationHarness.runtime.run("朝阳天气怎么样", {
  requestId: "run:direct:weather:contradictory-clarification",
});
assert.equal(contradictoryClarification.assistantResponse, "天气实时信息暂时不可用。");
assert.deepEqual(contradictoryClarification.toolResult.executionError, contradictoryClarificationError);
assert.equal(JSON.stringify(contradictoryClarification).includes("不可信的成功澄清。"), false);
assertDirectIsolation(contradictoryClarification, contradictoryClarificationHarness.calls);

const contradictoryTimeoutError = Object.freeze({
  code: "weather_timeout",
  message: "weather request exceeded deadline",
  stage: "execution",
  retryable: true,
});
const contradictoryTimeoutHarness = createLeanRuntimeDirectCapabilityHarness({
  adapterBehavior: (toolCall) => ({
    ...externalSuccess(toolCall, "不可信的超时天气。"),
    executionState: "accepted",
    executionError: contradictoryTimeoutError,
  }),
});
const contradictoryTimeout = await contradictoryTimeoutHarness.runtime.run("上海天气怎么样", {
  requestId: "run:direct:weather:contradictory-timeout",
});
assert.equal(contradictoryTimeout.assistantResponse, "天气实时信息暂时不可用。");
assert.equal(contradictoryTimeout.toolResult.ok, false);
assert.deepEqual(contradictoryTimeout.toolResult.executionError, contradictoryTimeoutError);
assert.equal(JSON.stringify(contradictoryTimeout).includes("不可信的超时天气。"), false);
assertDirectIsolation(contradictoryTimeout, contradictoryTimeoutHarness.calls);

for (const failureCase of [
  {
    label: "timeout",
    requestId: "run:direct:weather:timeout",
    executionError: Object.freeze({
      code: "weather_timeout",
      message: "weather request exceeded deadline",
      stage: "execution",
      retryable: true,
    }),
  },
  {
    label: "upstream failure",
    requestId: "run:direct:weather:upstream",
    executionError: Object.freeze({
      code: "weather_upstream_error",
      message: "weather provider returned 502",
      stage: "execution",
      retryable: true,
    }),
  },
]) {
  const harness = createLeanRuntimeDirectCapabilityHarness({
    adapterBehavior: (toolCall) => externalFailure(toolCall, {
      executionError: Object.freeze({
        ...failureCase.executionError,
        rawResponse: POISON,
        details: { upstreamBody: POISON },
      }),
      hmiSummary: POISON,
    }),
  });
  const result = await harness.runtime.run("上海天气怎么样", {
    requestId: failureCase.requestId,
  });
  assert.equal(result.assistantResponse, "天气实时信息暂时不可用。", failureCase.label);
  assert.deepEqual(
    result.toolResult.executionError,
    failureCase.executionError,
    `${failureCase.label}: only executionError allowlist semantics may be preserved`,
  );
  assert.equal(result.toolResult.hmiSummary, "天气实时信息暂时不可用。");
  assert.deepEqual(result.toolResult.evidenceRefs, []);
  assert.equal(Object.isFrozen(result.toolResult), true, failureCase.label);
  assert.equal(Object.isFrozen(result.toolResult.executionError), true, failureCase.label);
  assertPayloadAbsent(result, POISON, failureCase.label);
  assertDirectIsolation(result, harness.calls);
}

for (const invalidCase of [
  {
    label: "empty evidence",
    patch: { evidenceRefs: [] },
  },
  {
    label: "invalid evidence type",
    patch: { evidenceRefs: [{ id: "manual:1", source: "manual", type: "manual" }] },
  },
  {
    label: "empty summary",
    patch: { hmiSummary: "" },
  },
  {
    label: "mismatched command identity",
    patch: { commandId: "run:foreign:1:conversation.general" },
  },
  {
    label: "non-success execution state",
    patch: { executionState: "failed" },
  },
  {
    label: "rejected state patch",
    patch: { statePatch: { rejected: true } },
  },
  {
    label: "rejected observed state",
    patch: { observedState: { rejected: true } },
  },
  {
    label: "blocked visual scenario",
    patch: { visualScenario: "blocked" },
  },
  {
    label: "failed execution trace",
    patch: { executionTrace: [{ state: "failed", source: "weather-api-adapter", at: "2026-08-04T11:00:00.000Z" }] },
  },
  {
    label: "timeout execution trace",
    patch: { executionTrace: [{ state: "timeout", source: "weather-api-adapter", at: "2026-08-04T11:00:00.000Z" }] },
  },
  {
    label: "simulated success",
    patch: { simulated: true },
  },
]) {
  const fakeWeather = `伪造天气-${invalidCase.label}`;
  const harness = createLeanRuntimeDirectCapabilityHarness({
    adapterBehavior: (toolCall) => {
      const base = externalSuccess(toolCall, fakeWeather);
      return {
        ...base,
        evidenceRefs: base.evidenceRefs.map((evidence) => ({
          ...evidence,
          title: `${fakeWeather}-evidence`,
          debugPayload: fakeWeather,
        })),
        ...invalidCase.patch,
      };
    },
  });
  const result = await harness.runtime.run("上海天气怎么样", {
    requestId: `run:direct:weather:invalid:${invalidCase.label.replaceAll(" ", "-")}`,
  });
  assert.equal(result.assistantResponse, "天气实时信息暂时不可用。", invalidCase.label);
  assert.equal(result.toolResult.ok, false, invalidCase.label);
  assert.equal(result.toolResult.executionError.code, "external-evidence-invalid", invalidCase.label);
  assert.equal(JSON.stringify(result).includes(fakeWeather), false, `${invalidCase.label}: ungrounded summary must be discarded`);
  assertPayloadAbsent(result, fakeWeather, invalidCase.label);
  assertDirectIsolation(result, harness.calls);
}

const unsupportedHarness = createLeanRuntimeDirectCapabilityHarness();
for (const unsupportedType of ["navigation", "map", "poi", "charging", "swap", "web-search"]) {
  await assert.rejects(
    unsupportedHarness.useCase.execute(directContext({ externalDataType: unsupportedType })),
    /unsupported direct external capability/,
    unsupportedType,
  );
}
await assert.rejects(
  unsupportedHarness.useCase.execute(directContext({ mode: "orchestrated" })),
  /direct-capability mode/,
);
assert.equal(countCalls(unsupportedHarness.calls, "external.execute"), 0);

const enteredLateAdapter = deferred();
const releaseLateAdapter = deferred();
let lateToolCall;
const cancellationHarness = createLeanRuntimeDirectCapabilityHarness({
  async adapterBehavior(toolCall) {
    lateToolCall = toolCall;
    enteredLateAdapter.resolve();
    await releaseLateAdapter.promise;
    return externalSuccess(toolCall, "不应暴露的迟到天气结果。");
  },
});
const cancellationController = new AbortController();
const cancelledRun = cancellationHarness.runtime.run("上海天气怎么样", {
  requestId: "run:direct:weather:cancelled",
  signal: cancellationController.signal,
});
await enteredLateAdapter.promise;
cancellationController.abort("user interrupted weather query");
releaseLateAdapter.resolve();
await assert.rejects(cancelledRun, (error) => error?.name === "AbortError");
assert.equal(lateToolCall.commandId, "run:direct:weather:cancelled:1:conversation.general");
assert.equal(countCalls(cancellationHarness.calls, "external.execute"), 1);
assert.equal(cancellationHarness.ledger.getCurrentRun(), null);
const cancelledSnapshot = cancellationHarness.ledger.getPreviousRun();
assert.equal(cancelledSnapshot.status, "cancelled");
assert.equal(cancelledSnapshot.events.some((event) => (
  event.component === "externalDataAdapter" && event.status === "completed"
)), false, "late result must not create a completed Adapter event");
assert.equal(cancelledSnapshot.events.some((event) => event.component === "responsePresentation"), false);
assert.equal(JSON.stringify(cancelledSnapshot).includes("不应暴露的迟到天气结果。"), false);

console.log("lean runtime direct capability verification passed");

function externalSuccess(toolCall, hmiSummary = "上海明天多云。") {
  return {
    requestId: toolCall.requestId,
    commandId: toolCall.commandId,
    tool: toolCall.tool,
    ok: true,
    executionState: "accepted",
    simulated: false,
    statePatch: { weatherData: { location: { city: "上海" } } },
    observedState: {},
    requestedState: undefined,
    statePatchSource: "weather-api-grounding",
    executionTrace: [{ state: "accepted", source: "weather-api-adapter", at: "2026-08-04T11:00:00.000Z" }],
    executionError: undefined,
    hmiSummary,
    visualScenario: "planning",
    source: "weather-api-adapter",
    timestamp: "2026-08-04T11:00:00.000Z",
    evidenceRefs: [{
      id: "weather:open-meteo:2026-08-04T11:00:00.000Z",
      source: "open-meteo",
      type: "external-weather",
      title: "上海天气",
      citation: "https://api.open-meteo.com/v1/forecast",
    }],
  };
}

function externalFailure(toolCall, {
  executionError,
  hmiSummary,
  weatherLocationClarification,
}) {
  return {
    requestId: toolCall.requestId,
    commandId: toolCall.commandId,
    tool: toolCall.tool,
    ok: false,
    executionState: "failed",
    simulated: false,
    statePatch: { rejected: true, reason: hmiSummary },
    observedState: {},
    requestedState: undefined,
    statePatchSource: undefined,
    executionTrace: [{ state: "failed", source: "weather-api-adapter", at: "2026-08-04T11:00:00.000Z" }],
    executionError,
    hmiSummary,
    visualScenario: "blocked",
    source: "weather-api-adapter",
    timestamp: "2026-08-04T11:00:00.000Z",
    evidenceRefs: [],
    ...(weatherLocationClarification ? { weatherLocationClarification } : {}),
  };
}

function directContext({ externalDataType = "weather", mode = "direct-capability" } = {}) {
  return {
    runId: "run:direct:unsupported",
    rawText: "查询外部数据",
    routeDecision: { disposition: "execute", routeId: "task", mode },
    parsedCommand: {
      intent: "conversation.general",
      slots: { topic: "weather_query", requiresExternalData: true, externalDataType },
    },
    signal: undefined,
    deadlineAt: undefined,
    throwIfAborted() {},
    emit() {
      throw new Error("unsupported capability must fail before emitting events");
    },
  };
}

function assertDirectIsolation(result, calls) {
  assert.equal(result.runtimeTelemetry.modelCallCount, 1);
  assert.deepEqual(callNames(calls), ["external.execute"]);
  const forbiddenParticipants = new Set([
    "orchestrator",
    "manualQueryPlanner",
    "manualRetriever",
    "orchestratorModel",
    "safety",
    "vehicleStateProvider",
    "confirmation",
    "vehicleTool",
  ]);
  assert.equal(result.events.some((event) => forbiddenParticipants.has(event.component)), false);
  assert.equal(result.safetyDecision, null);
  assert.equal(result.vehicleStateSnapshot, null);
  assert.equal(result.manualQueryPlan, null);
  assert.equal(result.manualEvidence, null);
  assert.equal(result.events.every((event) => validateRunEvent(event).length === 0), true);
}

function assertPayloadAbsent(result, payload, label) {
  const { events, ...publicResult } = result;
  assert.equal(
    JSON.stringify(publicResult).includes(payload),
    false,
    `${label}: poison must not appear in the public result`,
  );
  assert.equal(
    events.some((event) => JSON.stringify(event).includes(payload)),
    false,
    `${label}: poison must not appear in any Run event`,
  );
}

function hasPhaseParticipant(result, phase, component) {
  return result.events.some((event) => event.phase === phase && event.component === component);
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
