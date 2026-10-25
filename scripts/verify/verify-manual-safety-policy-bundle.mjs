import assert from "node:assert/strict";
import {
  MANUAL_SAFETY_POLICY_BUNDLE,
  computeManualSafetyPolicyBundleDigest,
  evaluateManualSafetyPolicy,
  verifyManualSafetyPolicyBundle,
} from "../../src/manual/manual-safety-policy.js";
import { dispatchConstrainedSafetyEffect } from "../../src/safety/safety-gateway.js";

const command = (intent, slots) => ({ intent, slots });
const constraint = (topic, overrides = {}) => ({
  id: `constraint-${topic}`,
  topic,
  source: `chunk-${topic}`,
  sourceId: "nio-es8-user-manual-2026",
  chunkId: `chunk-${topic}`,
  manualVersion: "nio-es8-user-manual-2026",
  registryId: "nio-es8-local-dev-manual-constraint-registry",
  registryVersion: "1.0.0",
  reviewStatus: "approved-for-local-dev",
  humanReviewed: false,
  productionApproved: false,
  citationSpan: `fixture reviewed span for ${topic}`,
  sourceProvenance: {
    manualVersion: "nio-es8-user-manual-2026",
    sourceId: "nio-es8-user-manual-2026",
    chunkId: `chunk-${topic}`,
  },
  citation: `fixture citation for ${topic}`,
  note: `fixture ${topic} constraint`,
  ...overrides,
});
const evaluate = (overrides = {}) => evaluateManualSafetyPolicy({
  parsedCommand: command("body.tailgate.open", { open: true }),
  trustedVehicleState: { rearClearance: null },
  manualSafetyConstraints: [constraint("tailgate-clearance")],
  baselineEffect: "require_confirmation",
  ...overrides,
});
const signedClone = (mutate) => {
  const bundle = structuredClone(MANUAL_SAFETY_POLICY_BUNDLE);
  mutate(bundle);
  bundle.integrity.digest = computeManualSafetyPolicyBundleDigest(bundle);
  return bundle;
};

const integrity = verifyManualSafetyPolicyBundle();
assert.equal(integrity.valid, true);
assert.equal(integrity.algorithm, "sha256");
assert.match(integrity.trustBoundary, /no external signer or PKI/);
assert.equal(Object.isFrozen(MANUAL_SAFETY_POLICY_BUNDLE), true);
assert.equal(Object.isFrozen(MANUAL_SAFETY_POLICY_BUNDLE.policies[0].applicability.all), true);
assert.equal(MANUAL_SAFETY_POLICY_BUNDLE.policies.length, 2);
for (const policy of MANUAL_SAFETY_POLICY_BUNDLE.policies) {
  for (const field of ["policyId", "version", "manualVersion", "applicability", "effect", "priority", "citationBinding", "testVectors"]) {
    assert.ok(Object.hasOwn(policy, field), `${policy.policyId} missing ${field}`);
  }
  assert.ok(policy.testVectors.length >= 3);
}

const tailgate = evaluate();
assert.equal(tailgate.applied, true);
assert.equal(tailgate.effect, "require_confirmation");
assert.equal(tailgate.constraintTopic, "tailgate-clearance");
assert.equal(tailgate.citation, "fixture citation for tailgate-clearance");
assert.equal(tailgate.integrity.valid, true);
assert.equal(tailgate.bundleDigest, integrity.actualDigest);

assert.equal(evaluate({ trustedVehicleState: { rearClearance: true } }), null, "known clearance is not applicable");
assert.equal(evaluate({ parsedCommand: command("seat.driver.setBackrestAngle", { angle: 100 }) }), null, "wrong intent is not applicable");

const wrongTopic = evaluate({ manualSafetyConstraints: [constraint("tailgate-operation")] });
assert.equal(wrongTopic.applied, false);
assert.equal(wrongTopic.fallback, true);
assert.equal(wrongTopic.source, "fixed-rule-fallback");

const legacyUnreviewedConstraint = evaluate({
  manualSafetyConstraints: [{ id: "legacy", topic: "tailgate-clearance", citation: "unbound fixture" }],
});
assert.equal(legacyUnreviewedConstraint.applied, false, "legacy topic/citation objects cannot bypass ConstraintRegistry provenance");
assert.equal(legacyUnreviewedConstraint.source, "fixed-rule-fallback");

for (const [label, overrides] of [
  ["revoked-status", { reviewStatus: "revoked" }],
  ["production-flipped", { reviewStatus: "approved-for-production", humanReviewed: true, productionApproved: true }],
  ["rollback-version", { registryVersion: "0.9.0" }],
  ["future-unsigned-version", { registryVersion: "1.1.0" }],
]) {
  const result = evaluate({ manualSafetyConstraints: [constraint("tailgate-clearance", overrides)] });
  assert.equal(result.applied, false, `${label}: untrusted constraint trust-state must not apply`);
  assert.equal(result.source, "fixed-rule-fallback", `${label}: untrusted constraint trust-state must fall back`);
}

const priorityBundle = signedClone((bundle) => {
  const stricter = structuredClone(bundle.policies[0]);
  stricter.policyId = "tailgate-clearance-reject";
  stricter.effect = "reject";
  stricter.priority = 1;
  bundle.policies.push(stricter);
});
const priority = evaluate({ bundle: priorityBundle });
assert.equal(priority.policyId, "tailgate-clearance-reject");
assert.equal(priority.effect, "reject", "effect precedence must outrank numeric policy priority");

const weakerThanBaseline = evaluate({ baselineEffect: "reject" });
assert.equal(weakerThanBaseline.applied, false);
assert.equal(weakerThanBaseline.reason, "manual-policy-cannot-weaken-baseline");
assert.equal(weakerThanBaseline.source, "fixed-rule-fallback");

const tampered = structuredClone(MANUAL_SAFETY_POLICY_BUNDLE);
tampered.policies[0].priority += 1;
const tamperedResult = evaluate({ bundle: tampered });
assert.equal(tamperedResult.applied, false);
assert.equal(tamperedResult.integrity.valid, false);
assert.equal(tamperedResult.integrity.reason, "digest-mismatch");

const unknownOperator = signedClone((bundle) => { bundle.policies[0].applicability.all[0].operator = "contains"; });
assert.equal(evaluate({ bundle: unknownOperator }).integrity.reason, "unknown-operator:contains");

const invalidEffect = signedClone((bundle) => { bundle.policies[0].effect = "permit"; });
assert.equal(evaluate({ bundle: invalidEffect }).integrity.reason, "invalid-effect:permit");

const allowEffect = signedClone((bundle) => { bundle.policies[0].effect = "allow"; });
assert.equal(evaluate({ bundle: allowEffect }).integrity.reason, "invalid-effect:allow");

const missingField = signedClone((bundle) => { delete bundle.policies[0].manualVersion; });
assert.equal(evaluate({ bundle: missingField }).integrity.reason, "missing-policy-field:manualVersion");

const invalidCitationOperator = signedClone((bundle) => { bundle.policies[0].citationBinding.condition.operator = "matches"; });
assert.equal(evaluate({ bundle: invalidCitationOperator }).integrity.reason, "invalid-citation-binding");

const clampBundle = signedClone((bundle) => { bundle.policies[0].effect = "clamp"; });
const clampPolicy = evaluate({ bundle: clampBundle, baselineEffect: "allow" });
assert.equal(clampPolicy.applied, true);
assert.equal(clampPolicy.effect, "clamp");
const dispatchFixture = {
  baselineEffect: "allow",
  parsedCommand: { requestId: "clamp-dispatch-fixture", intent: "fixture.intent", slots: { value: "requested" } },
  reason: "fixture bounded result",
  alternative: "",
  manualEvidence: { status: "miss", query: "", evidence: [], telemetry: {} },
  manualSafetyPolicy: clampPolicy,
};
const clamped = dispatchConstrainedSafetyEffect({ ...dispatchFixture, effectSafeSlots: { value: "validated-safe-fixture" } });
assert.equal(clamped.action, "clamp");
assert.deepEqual(clamped.safeSlots, { value: "validated-safe-fixture" });
const clampWithoutSlots = dispatchConstrainedSafetyEffect(dispatchFixture);
assert.equal(clampWithoutSlots.action, "reject");
assert.match(clampWithoutSlots.reason, /缺少经校验的安全参数/);
for (const effect of ["allow", "unknown-fixture-effect"]) {
  const invalidDispatch = dispatchConstrainedSafetyEffect({
    ...dispatchFixture,
    manualSafetyPolicy: { ...clampPolicy, effect },
    effectSafeSlots: { value: "must-not-be-used" },
  });
  assert.equal(invalidDispatch.action, "reject", `${effect} must fail closed`);
}

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  bundle: `${MANUAL_SAFETY_POLICY_BUNDLE.bundleId}@${MANUAL_SAFETY_POLICY_BUNDLE.version}`,
  digest: integrity.actualDigest,
  cases: 21,
  result: "passed",
}, null, 2));
