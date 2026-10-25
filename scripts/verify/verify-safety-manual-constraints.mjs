import assert from "node:assert/strict";
import { SafetyGateway } from "../../src/safety/safety-gateway.js";
import { createVehicleStateSnapshot } from "../../src/safety/vehicle-state.js";
import { evaluateManualSafetyPolicy } from "../../src/manual/manual-safety-policy.js";

function command(intent, slots = {}) {
  return {
    requestId: `verify-manual-constraints-${intent}`,
    rawText: intent,
    intent,
    confidence: 1,
    slots,
    slotProvenance: Object.fromEntries(Object.keys(slots).map((key) => [key, "explicit"])),
    speechAct: "command",
    actionability: { actionable: true, reason: "unit fixture", source: "unit-fixture", intendedIntent: intent },
    source: "unit-fixture",
  };
}

function manualEvidence(evidence) {
  return {
    status: "hit",
    query: `${evidence[0]?.sectionTitle || "车辆功能"}如何操作，有哪些注意事项？`,
    evidence,
    telemetry: {
      retrievalMode: "unit-fixture",
      embeddingStatus: "fixture",
    },
  };
}

function evidenceItem(overrides) {
  return {
    chunkId: "unit-fixture-chunk",
    sourceId: "nio-es8-user-manual-2026",
    manualVersion: "nio-es8-user-manual-2026",
    title: "蔚来 ES8 用户手册",
    citation: "",
    sectionTitle: "",
    category: "unit-fixture",
    score: 1,
    excerpt: "",
    ...overrides,
  };
}

function reviewedProof(registryEntryId, chunkId, page, span, contentDigest) {
  return [{
    registryEntryId,
    registryVersion: "1.0.0",
    manualVersion: "nio-es8-user-manual-2026",
    sourceId: "nio-es8-user-manual-2026",
    chunkId,
    page,
    span,
    contentDigest,
  }];
}

function evaluate(parsedCommand, contextPatch = {}) {
  const { manualEvidence, trustedConfirmationAssertions, vehicleStateSnapshot, ...vehicleStateValues } = contextPatch;
  const capturedAt = new Date().toISOString();
  const values = {
    speedKph: 0,
    gear: "P",
    rearClearance: null,
    windowAntiPinchAvailable: true,
    rainDetected: false,
    driverBackrestAngle: 106,
    ...vehicleStateValues,
  };
  return new SafetyGateway().evaluate(parsedCommand, {
    vehicleStateSnapshot: vehicleStateSnapshot || createVehicleStateSnapshot({
      source: "unit-fixture",
      simulated: true,
      capturedAt,
      freshnessMs: 0,
      values,
      capturedAtByField: values.rearClearance === null ? { rearClearance: capturedAt } : {},
    }),
    manualEvidence,
    trustedConfirmationAssertions,
  });
}

const windowDecision = evaluate(
  command("body.window.setPosition", { zone: "front_left", percent: 50 }),
  {
    manualEvidence: manualEvidence([
      evidenceItem({
        chunkId: "es8-manual-chunk-0065",
        pageStart: 79,
        pageEnd: 79,
        sectionTitle: "车窗防夹",
        excerpt: "若车窗一键升窗和防夹保护功能失效（如低压蓄电池断电后重启），请按以下方法进行车窗初始化：",
        reviewedCitationSpans: reviewedProof("es8-window-anti-pinch-unavailable", "es8-manual-chunk-0065", 79, "若车窗一键升窗和防夹保护功能失效（如低压蓄电池断电后重启），请按以下方法进行车窗初始化：", "sha256:a1d5d920ec6a6a31e0c51370e1d4d8e9ef2ffc32ff8a2ed19063b3a6409b0ff4"),
      }),
    ]),
  },
);
assert.equal(windowDecision.allowed, true, "window decision remains allowed");
assert.equal(windowDecision.action, "allow", "window action remains allow");
assert.ok(
  windowDecision.manualSafetyConstraints.some((item) => item.topic === "window-anti-pinch"),
  "window anti-pinch constraint should be extracted",
);
assert.equal(windowDecision.registryTelemetry.integrity.valid, true);
assert.equal(windowDecision.registryTelemetry.publishedCount, 1);
assert.equal(windowDecision.manualConstraintCandidates[0].published, true);

const strictWindowRef = Object.freeze({
  sourceId: "nio-es8-user-manual-2026",
  sourceVersion: "2026",
  chunkId: "es8-manual-chunk-0065",
  pageStart: 79,
  pageEnd: 79,
  excerpt: "若车窗一键升窗和防夹保护功能失效，请按手册方法进行车窗初始化。",
  score: Object.freeze({ retrieval: 0.84, rerank: null, grounding: null }),
});
const strictWindowDecision = evaluate(
  command("body.window.setPosition", { zone: "front_left", percent: 0 }),
  {
    windowAntiPinchAvailable: false,
    manualEvidence: {
      status: "hit",
      query: "ES8 车窗防夹失效后怎么处理？",
      evidence: [strictWindowRef],
      telemetry: {
        evidenceContract: "manual-evidence-ref@1.0.0",
        retrievalMode: "vector-bge-m3",
        embeddingStatus: "embedded",
      },
    },
  },
);
assert.equal(strictWindowDecision.manualEvidenceStatus, "hit", "Safety must preserve a server-validated strict ref hit");
assert.equal(strictWindowDecision.registryTelemetry.publishedCount, 1, "strict ref must publish through the local constraint allowlist");
assert.equal(strictWindowDecision.manualSafetyPolicy.applied, true);
assert.equal(strictWindowDecision.manualSafetyPolicy.constraintId, "es8-window-anti-pinch-unavailable");

const unavailableEvidenceDecision = evaluate(
  command("body.window.setPosition", { zone: "front_left", percent: 50 }),
  {
    manualEvidence: {
      status: "unavailable",
      query: "ES8 车窗怎么控制？",
      evidence: [],
      telemetry: {
        evidenceContract: "manual-evidence-ref@1.0.0",
        retrievalMode: "vector-bge-m3",
        embeddingStatus: "unavailable",
        reason: "embedding-unavailable",
      },
    },
  },
);
assert.equal(unavailableEvidenceDecision.manualEvidenceStatus, "unavailable");
assert.equal(unavailableEvidenceDecision.manualEvidenceSummary.status, "unavailable");
assert.equal(unavailableEvidenceDecision.manualEvidenceTelemetry.reason, "embedding-unavailable");
assert.deepEqual(unavailableEvidenceDecision.manualEvidence, []);

const windowProtectionDecision = evaluate(
  command("body.window.setPosition", { zone: "front_left", percent: 0 }),
  {
    windowAntiPinchAvailable: false,
    manualEvidence: manualEvidence([
      evidenceItem({
        chunkId: "es8-manual-chunk-0065",
        pageStart: 79,
        pageEnd: 79,
        sectionTitle: "车窗防夹",
        excerpt: "若车窗一键升窗和防夹保护功能失效（如低压蓄电池断电后重启），请按以下方法进行车窗初始化：",
        reviewedCitationSpans: reviewedProof("es8-window-anti-pinch-unavailable", "es8-manual-chunk-0065", 79, "若车窗一键升窗和防夹保护功能失效（如低压蓄电池断电后重启），请按以下方法进行车窗初始化：", "sha256:a1d5d920ec6a6a31e0c51370e1d4d8e9ef2ffc32ff8a2ed19063b3a6409b0ff4"),
      }),
    ]),
  },
);
assert.equal(windowProtectionDecision.allowed, false, "manual window protection policy blocks closing without anti-pinch");
assert.equal(windowProtectionDecision.action, "reject", "manual window protection policy uses reject");
assert.deepEqual(
  {
    version: windowProtectionDecision.manualSafetyPolicy.version,
    policyId: windowProtectionDecision.manualSafetyPolicy.policyId,
    effect: windowProtectionDecision.manualSafetyPolicy.effect,
    applied: windowProtectionDecision.manualSafetyPolicy.applied,
    source: windowProtectionDecision.manualSafetyPolicy.source,
    constraintId: windowProtectionDecision.manualSafetyPolicy.constraintId,
    citation: windowProtectionDecision.manualSafetyPolicy.citation,
    integrityValid: windowProtectionDecision.manualSafetyPolicy.integrity.valid,
  },
  {
    version: "1.0.0",
    policyId: "window-anti-pinch-protection",
    effect: "reject",
    applied: true,
    source: "es8-manual-chunk-0065",
    constraintId: "es8-window-anti-pinch-unavailable",
    citation: "ES8 用户手册 p.79",
    integrityValid: true,
  },
  "matched window anti-pinch evidence should drive the verified bundle policy",
);

const windowProtectionFallbackDecision = evaluate(
  command("body.window.setPosition", { zone: "front_left", percent: 0 }),
  {
    windowAntiPinchAvailable: false,
    manualEvidence: { status: "miss", query: "window anti-pinch", evidence: [], telemetry: {} },
  },
);
assert.equal(windowProtectionFallbackDecision.allowed, false, "window fixed fallback remains blocked");
assert.equal(windowProtectionFallbackDecision.action, "reject", "window fixed fallback remains reject");
assert.equal(windowProtectionFallbackDecision.manualSafetyPolicy.policyId, "window-anti-pinch-protection");
assert.equal(windowProtectionFallbackDecision.manualSafetyPolicy.applied, false);
assert.equal(windowProtectionFallbackDecision.manualSafetyPolicy.source, "fixed-rule-fallback");
assert.equal(windowProtectionFallbackDecision.manualSafetyPolicy.fallback, true);
assert.equal(windowProtectionFallbackDecision.manualSafetyPolicy.integrity.valid, true);

const lowConfidenceWindowDecision = evaluate(
  command("body.window.setPosition", { zone: "front_left", percent: 0 }),
  {
    windowAntiPinchAvailable: false,
    manualEvidence: {
      status: "hit",
      query: "车窗防夹关闭有哪些注意事项？",
      evidence: [evidenceItem({ sourceId: "untrusted-old-api", sectionTitle: "车窗防夹", excerpt: "关闭车窗时保持防夹保护。" })],
      telemetry: { retrievalMode: "unit-fixture" },
    },
  },
);
assert.equal(lowConfidenceWindowDecision.action, "reject");
assert.equal(lowConfidenceWindowDecision.manualSafetyPolicy.applied, false);
assert.equal(lowConfidenceWindowDecision.manualSafetyPolicy.source, "fixed-rule-fallback");
assert.equal(lowConfidenceWindowDecision.manualEvidence.length, 0);
assert.equal(lowConfidenceWindowDecision.manualEvidenceTelemetry.missReason, "low-confidence");

const tailgateDecision = evaluate(
  command("body.tailgate.open", { open: true }),
  {
    rearClearance: null,
    manualEvidence: manualEvidence([
      evidenceItem({
        chunkId: "es8-manual-chunk-0052",
        pageStart: 62,
        pageEnd: 63,
        sectionTitle: "尾门开启",
        excerpt: "打开或关闭尾门前，请确认尾门的开/闭路径附近无障碍物，以避免造成人身伤害或财产损失。",
        reviewedCitationSpans: reviewedProof("es8-tailgate-clear-path", "es8-manual-chunk-0052", 62, "打开或关闭尾门前，请确认尾门的开/闭路径附近无障碍物，以避免造成人身伤害或财产损失。", "sha256:d56948110fc2cc85a4f8468d7213eb52a9e7a57cb18049e4867fbde41c52dc97"),
      }),
    ]),
  },
);
assert.equal(tailgateDecision.allowed, false, "tailgate decision remains blocked");
assert.equal(tailgateDecision.action, "require_confirmation", "tailgate action remains require_confirmation");
assert.ok(
  tailgateDecision.manualSafetyConstraints.some((item) => item.topic === "tailgate-clearance"),
  "tailgate clearance constraint should be extracted",
);
assert.equal(tailgateDecision.manualSafetyPolicy.policyId, "tailgate-clearance-confirmation");
assert.equal(tailgateDecision.manualSafetyPolicy.version, "1.0.0");
assert.equal(tailgateDecision.manualSafetyPolicy.effect, "require_confirmation");
assert.equal(tailgateDecision.manualSafetyPolicy.applied, true);
assert.equal(tailgateDecision.manualSafetyPolicy.source, "es8-manual-chunk-0052");
assert.equal(tailgateDecision.manualSafetyPolicy.constraintId, "es8-tailgate-clear-path");
assert.equal(tailgateDecision.manualSafetyPolicy.citation, "ES8 用户手册 p.62");
assert.equal(tailgateDecision.manualSafetyPolicy.integrity.valid, true);
assert.equal(tailgateDecision.manualSafetyPolicy.humanReviewed, false);
assert.equal(tailgateDecision.manualSafetyPolicy.productionApproved, false);
assert.deepEqual(
  Object.keys(tailgateDecision.manualSafetyConstraints[0]).filter((key) => [
    "subject", "action", "preconditions", "effect", "exceptions", "citationSpan",
    "registryId", "registryVersion", "reviewStatus", "sourceProvenance",
  ].includes(key)).sort(),
  ["action", "citationSpan", "effect", "exceptions", "preconditions", "registryId", "registryVersion", "reviewStatus", "sourceProvenance", "subject"],
  "published constraint exposes reviewed semantics and provenance",
);

const tailgateFallbackDecision = evaluate(
  command("body.tailgate.open", { open: true }),
  {
    rearClearance: null,
    manualEvidence: { status: "miss", query: "tailgate", evidence: [], telemetry: {} },
  },
);
assert.equal(tailgateFallbackDecision.allowed, false, "tailgate fallback remains blocked");
assert.equal(tailgateFallbackDecision.action, "require_confirmation", "tailgate fallback remains require_confirmation");
assert.equal(tailgateFallbackDecision.manualSafetyPolicy.policyId, "tailgate-clearance-confirmation");
assert.equal(tailgateFallbackDecision.manualSafetyPolicy.applied, false);
assert.equal(tailgateFallbackDecision.manualSafetyPolicy.source, "fixed-rule-fallback");
assert.equal(tailgateFallbackDecision.manualSafetyPolicy.fallback, true);
assert.equal(tailgateFallbackDecision.manualSafetyPolicy.integrity.valid, true);

const tailgateAntiPinchDecision = evaluate(
  command("body.tailgate.open", { open: true }),
  {
    rearClearance: null,
    manualEvidence: manualEvidence([
      evidenceItem({
        chunkId: "fixture-tailgate-anti-pinch",
        sectionTitle: "尾门开启高度设置",
        excerpt: "尾门开启过程中如触发防夹保护，应先确认尾门周边空间后再继续开启。",
      }),
    ]),
  },
);
assert.equal(tailgateAntiPinchDecision.allowed, false, "tailgate anti-pinch fixture remains blocked");
assert.equal(tailgateAntiPinchDecision.action, "require_confirmation", "tailgate anti-pinch fixture remains require_confirmation");
assert.equal(tailgateAntiPinchDecision.manualSafetyConstraints.length, 0, "unreviewed keyword overlap must not publish a constraint");
assert.equal(tailgateAntiPinchDecision.manualSafetyPolicy.applied, false);
assert.equal(tailgateAntiPinchDecision.manualSafetyPolicy.source, "fixed-rule-fallback");

const productionFlippedTailgateDecision = evaluate(
  command("body.tailgate.open", { open: true }),
  {
    rearClearance: null,
    manualEvidence: manualEvidence([
      evidenceItem({
        chunkId: "es8-manual-chunk-0052",
        pageStart: 62,
        pageEnd: 63,
        sectionTitle: "尾门开启",
        excerpt: "打开或关闭尾门前，请确认尾门的开/闭路径附近无障碍物，以避免造成人身伤害或财产损失。",
        reviewedCitationSpans: reviewedProof("es8-tailgate-clear-path", "es8-manual-chunk-0052", 62, "打开或关闭尾门前，请确认尾门的开/闭路径附近无障碍物，以避免造成人身伤害或财产损失。", "sha256:d56948110fc2cc85a4f8468d7213eb52a9e7a57cb18049e4867fbde41c52dc97"),
      }),
    ]),
  },
);
const flippedConstraint = {
  ...productionFlippedTailgateDecision.manualSafetyConstraints[0],
  reviewStatus: "approved-for-production",
  humanReviewed: true,
  productionApproved: true,
};
const productionFlippedPolicy = evaluateManualSafetyPolicy({
  parsedCommand: command("body.tailgate.open", { open: true }),
  trustedVehicleState: { rearClearance: null },
  manualSafetyConstraints: [flippedConstraint],
  baselineEffect: "require_confirmation",
});
assert.equal(productionFlippedPolicy.applied, false, "flipping local-dev constraint into production must not apply");
assert.equal(productionFlippedPolicy.source, "fixed-rule-fallback");
assert.equal(tailgateAntiPinchDecision.manualConstraintCandidates[0].published, false);
assert.equal(tailgateAntiPinchDecision.registryTelemetry.publishedCount, 0);
assert.equal(
  tailgateAntiPinchDecision.manualSafetyConstraints.some((item) => item.topic === "window-anti-pinch"),
  false,
  "tailgate anti-pinch fixture must not extract window anti-pinch constraint",
);

const seatDecision = evaluate(
  command("seat.driver.setBackrestAngle", { seat: "driver", angle: 112 }),
  {
    manualEvidence: manualEvidence([
      evidenceItem({
        chunkId: "fixture-child-seat",
        sectionTitle: "儿童安全座椅",
        excerpt: "儿童乘员应使用适合身高体重的儿童安全座椅。",
      }),
    ]),
  },
);
assert.equal(seatDecision.allowed, true, "seat decision remains allowed");
assert.equal(seatDecision.action, "allow", "seat action remains allow");
assert.equal(
  seatDecision.manualSafetyConstraints.some((item) => item.topic === "driver-backrest"),
  false,
  "child-seat evidence must not become a driver backrest constraint",
);

console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      fixtureOnly: true,
      cases: [
        {
          name: "window anti-pinch fixture",
          allowed: windowDecision.allowed,
          action: windowDecision.action,
          topics: windowDecision.manualSafetyConstraints.map((item) => item.topic),
        },
        {
          name: "tailgate unknown rear clearance fixture",
          allowed: tailgateDecision.allowed,
          action: tailgateDecision.action,
          topics: tailgateDecision.manualSafetyConstraints.map((item) => item.topic),
          manualSafetyPolicy: tailgateDecision.manualSafetyPolicy,
        },
        {
          name: "tailgate fixed-rule fallback without manual evidence",
          allowed: tailgateFallbackDecision.allowed,
          action: tailgateFallbackDecision.action,
          manualSafetyPolicy: tailgateFallbackDecision.manualSafetyPolicy,
        },
        {
          name: "tailgate anti-pinch fixture stays tailgate-only",
          allowed: tailgateAntiPinchDecision.allowed,
          action: tailgateAntiPinchDecision.action,
          topics: tailgateAntiPinchDecision.manualSafetyConstraints.map((item) => item.topic),
        },
        {
          name: "child seat evidence does not imply driver backrest",
          allowed: seatDecision.allowed,
          action: seatDecision.action,
          topics: seatDecision.manualSafetyConstraints.map((item) => item.topic),
        },
      ],
    },
    null,
    2,
  ),
);
