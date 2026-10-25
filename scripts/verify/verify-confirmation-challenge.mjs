import assert from "node:assert/strict";
import {
  createTrustedConfirmationAssertions,
  isTrustedConfirmationAssertions,
} from "../../src/safety/confirmation-challenge.js";
import { SafetyGateway } from "../../src/safety/safety-gateway.js";
import { createVehicleStateSnapshot } from "../../src/safety/vehicle-state.js";
import {
  countCalls,
  createLeanRuntimeVehicleControlHarness,
} from "../lib/lean-runtime-test-harness.mjs";

const tailgateHarness = createLeanRuntimeVehicleControlHarness({
  safetyState: { rearClearance: null },
});
const issued = await tailgateHarness.runtime.run("打开尾门", {
  requestId: "confirmation:tailgate:issue",
});
const tailgateChallenge = issued.safetyDecision.confirmationChallenge;
assert.equal(issued.safetyDecision.action, "require_confirmation");
assert.equal(issued.toolCall, null);
assert.equal(issued.toolResult, null);
assert.ok(tailgateChallenge.id);
assert.deepEqual(
  tailgateChallenge.assertions.map((item) => item.id),
  ["tailgate.rear-clearance-acknowledged"],
);
assert.equal(countCalls(tailgateHarness.calls, "vehicle.adapter.execute"), 0);

tailgateHarness.resetCalls();
const accepted = await tailgateHarness.runtime.run("打开尾门", {
  requestId: "confirmation:tailgate:accept",
  confirmationResponse: responseFor(tailgateChallenge),
});
assert.equal(accepted.safetyDecision.action, "allow");
assert.equal(accepted.toolResult.executionState, "observed-succeeded");
assert.equal(countCalls(tailgateHarness.calls, "vehicle.adapter.execute"), 1);

tailgateHarness.resetCalls();
const replay = await tailgateHarness.runtime.run("打开尾门", {
  requestId: "confirmation:tailgate:replay",
  confirmationResponse: responseFor(tailgateChallenge),
});
assert.equal(replay.safetyDecision.action, "reject");
assert.match(replay.safetyDecision.reason, /已使用|重复/);
assert.equal(replay.toolCall, null);
assert.equal(replay.toolResult, null);
assert.equal(countCalls(tailgateHarness.calls, "vehicle.adapter.execute"), 0);

const snapshotCapturedAt = new Date().toISOString();
const snapshot = createVehicleStateSnapshot({
  id: "confirmation-anti-forgery-snapshot",
  source: "confirmation-test",
  simulated: true,
  capturedAt: snapshotCapturedAt,
  freshnessMs: 0,
  values: {
    speedKph: 0,
    gear: "P",
    rearClearance: null,
    tailgateOpen: true,
    cabinTemperature: 24,
    airflow: "auto",
    passengerMode: "child_comfort",
    windowAntiPinchAvailable: true,
  },
  capturedAtByField: {
    speedKph: snapshotCapturedAt,
    gear: snapshotCapturedAt,
    rearClearance: snapshotCapturedAt,
    tailgateOpen: snapshotCapturedAt,
    cabinTemperature: snapshotCapturedAt,
    airflow: snapshotCapturedAt,
    passengerMode: snapshotCapturedAt,
    windowAntiPinchAvailable: snapshotCapturedAt,
  },
});
const gateway = new SafetyGateway();
const bypassAttempt = gateway.evaluate(tailgateCommand({
  confirmRearClearance: true,
}), {
  vehicleStateSnapshot: snapshot,
  manualEvidence: { status: "miss", evidence: [], query: "", telemetry: {} },
});
assert.equal(
  bypassAttempt.action,
  "require_confirmation",
  "ordinary parsed slots cannot satisfy a trusted confirmation assertion",
);
const forgedRuntimeContext = gateway.evaluate(tailgateCommand(), {
  vehicleStateSnapshot: snapshot,
  trustedConfirmationAssertions: {
    "tailgate.rear-clearance-acknowledged": true,
  },
  manualEvidence: { status: "miss", evidence: [], query: "", telemetry: {} },
});
assert.equal(
  forgedRuntimeContext.action,
  "require_confirmation",
  "unbranded context objects cannot forge Runtime-verified assertions",
);

const climateAssertion = Object.freeze({
  id: "climate.sensitive-passenger-acknowledged",
  prompt: "我已确认车内乘员同意当前空调设置。",
  proofType: "user-acknowledgement",
  riskType: "cabin-comfort",
});
const climatePolicy = Object.freeze({
  policyId: "climate-sensitive-passenger-confirmation",
  version: "1.0.0",
  source: "unit-policy-bundle",
  constraintId: "unit-climate-sensitive-passenger",
  applied: true,
  confirmationAssertions: [climateAssertion],
});
const climateHarness = createLeanRuntimeVehicleControlHarness({
  async evaluateSafety(command, input, realGateway) {
    if (command.intent !== "cabin.climate.setPreset") {
      return realGateway.evaluate(command, input);
    }
    return climateSafetyDecision(command, input);
  },
});
const climateText = "把儿童模式空调调到24度";
const climateIssued = await climateHarness.runtime.run(climateText, {
  requestId: "confirmation:climate:issue",
});
const climateChallenge = climateIssued.safetyDecision.confirmationChallenge;
assert.equal(climateIssued.safetyDecision.action, "require_confirmation");
assert.deepEqual(
  climateChallenge.assertions,
  [climateAssertion],
  "non-tailgate policy must provide its own assertion contract",
);
assert.equal(
  climateChallenge.assertions[0].id.includes("tailgate"),
  false,
  "non-tailgate confirmation must not inherit tailgate assertion id",
);
assert.match(
  climateChallenge.assertions[0].prompt,
  /空调|乘员/,
  "non-tailgate confirmation must not inherit tailgate prompt",
);

climateHarness.resetCalls();
const wrongRiskAssertion = await climateHarness.runtime.run(climateText, {
  requestId: "confirmation:climate:wrong-risk",
  confirmationResponse: responseFor(climateChallenge, {
    acceptedAssertions: ["tailgate.rear-clearance-acknowledged"],
  }),
});
assert.equal(wrongRiskAssertion.safetyDecision.action, "reject");
assert.match(wrongRiskAssertion.safetyDecision.reason, /断言不完整/);
assert.equal(countCalls(climateHarness.calls, "vehicle.adapter.execute"), 0);

const parsedClimate = climateIssued.parsedCommand;
const parsedSlotForgery = climateSafetyDecision({
  ...parsedClimate,
  slots: {
    ...parsedClimate.slots,
    [climateAssertion.id]: true,
  },
}, {});
assert.equal(
  parsedSlotForgery.action,
  "require_confirmation",
  "ordinary parsed confirmation slots cannot forge a risk-specific trusted assertion",
);
const unbrandedClimateContext = climateSafetyDecision(parsedClimate, {
  trustedConfirmationAssertions: {
    [climateAssertion.id]: true,
  },
});
assert.equal(
  unbrandedClimateContext.action,
  "require_confirmation",
  "unbranded context cannot satisfy the non-tailgate assertion",
);
const forgedBrandedButWrongAssertion = climateSafetyDecision(parsedClimate, {
  trustedConfirmationAssertions: createTrustedConfirmationAssertions({
    "tailgate.rear-clearance-acknowledged": true,
  }),
});
assert.equal(
  forgedBrandedButWrongAssertion.action,
  "require_confirmation",
  "trusted assertions are risk-specific and must not cross policy risk types",
);

climateHarness.resetCalls();
const climateAccepted = await climateHarness.runtime.run(climateText, {
  requestId: "confirmation:climate:accept",
  confirmationResponse: responseFor(climateChallenge),
});
assert.equal(climateAccepted.safetyDecision.action, "allow");
assert.equal(climateAccepted.toolResult.executionState, "observed-succeeded");
assert.equal(countCalls(climateHarness.calls, "vehicle.adapter.execute"), 1);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "lean-tailgate-valid-once",
    "lean-tailgate-replay",
    "tailgate-slot-bypass",
    "tailgate-context-forgery",
    "policy-specific-assertions",
    "cross-risk-rejection",
    "non-tailgate-slot-forgery",
    "non-tailgate-context-forgery",
  ],
}, null, 2));

function climateSafetyDecision(command, context = {}) {
  const assertions = context.trustedConfirmationAssertions;
  const confirmed = isTrustedConfirmationAssertions(assertions)
    && assertions[climateAssertion.id] === true;
  if (confirmed) {
    return {
      requestId: command.requestId,
      allowed: true,
      action: "allow",
      safeIntent: command.intent,
      safeSlots: command.slots,
      slotProvenance: command.slotProvenance,
      reason: "策略声明的确认断言已满足。",
      alternative: "",
      manualSafetyPolicy: climatePolicy,
    };
  }
  return {
    requestId: command.requestId,
    allowed: false,
    action: "require_confirmation",
    safeIntent: "safety.reject",
    safeSlots: {
      reason: "需要确认敏感乘员舒适性。",
      originalIntent: command.intent,
    },
    slotProvenance: command.slotProvenance,
    reason: "需要确认敏感乘员舒适性。",
    alternative: "请确认乘员已同意该空调设置。",
    manualSafetyPolicy: climatePolicy,
  };
}

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

function tailgateCommand(extraSlots = {}) {
  const slots = { open: true, ...extraSlots };
  return {
    requestId: "confirmation-direct-tailgate",
    rawText: "open tailgate",
    intent: "body.tailgate.open",
    confidence: 1,
    slots,
    slotProvenance: Object.fromEntries(Object.keys(slots).map((key) => [key, "explicit"])),
    speechAct: "command",
    actionability: {
      actionable: true,
      source: "test",
      reason: "explicit",
      intendedIntent: "body.tailgate.open",
    },
    source: "rule-parser",
  };
}
