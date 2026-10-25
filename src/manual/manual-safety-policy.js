const EFFECT_PRIORITY = Object.freeze({ allow: 0, clamp: 1, require_confirmation: 2, reject: 3 });
const SUPPORTED_OPERATORS = new Set(["eq", "notEq", "isUnknown"]);
const REQUIRED_POLICY_FIELDS = Object.freeze([
  "policyId",
  "version",
  "manualVersion",
  "applicability",
  "effect",
  "priority",
  "citationBinding",
  "testVectors",
]);
const LOCAL_DEV_CONSTRAINT_REGISTRY_ID = "nio-es8-local-dev-manual-constraint-registry";
const LOCAL_DEV_CONSTRAINT_REGISTRY_VERSION = "1.0.0";

const POLICY_BUNDLE_PAYLOAD = {
  bundleId: "nio-es8-manual-safety-policy-bundle",
  version: "1.0.0",
  integrityBoundary: "local-built-in-bundle",
  policies: [
    {
      policyId: "tailgate-clearance-confirmation",
      version: "1.0.0",
      manualVersion: "nio-es8-user-manual-2026",
      applicability: {
        all: [
          { source: "command.intent", operator: "eq", value: "body.tailgate.open" },
          { source: "command.slots.open", operator: "notEq", value: false },
          { source: "vehicle.rearClearance", operator: "isUnknown" },
        ],
      },
      effect: "require_confirmation",
      priority: 200,
      citationBinding: {
        condition: { source: "constraint.topic", operator: "eq", value: "tailgate-clearance" },
        requireCitation: true,
      },
      testVectors: [
        { id: "tailgate-unknown-with-constraint", expected: "require_confirmation" },
        { id: "tailgate-known-clearance-not-applicable", expected: "not_applicable" },
        { id: "tailgate-unknown-without-constraint", expected: "fixed_rule_fallback" },
      ],
    },
    {
      policyId: "window-anti-pinch-protection",
      version: "1.0.0",
      manualVersion: "nio-es8-user-manual-2026",
      applicability: {
        all: [
          { source: "command.intent", operator: "eq", value: "body.window.setPosition" },
          { source: "command.slots.percent", operator: "eq", value: 0 },
          { source: "vehicle.windowAntiPinchAvailable", operator: "eq", value: false },
        ],
      },
      effect: "reject",
      priority: 300,
      citationBinding: {
        condition: { source: "constraint.topic", operator: "eq", value: "window-anti-pinch" },
        requireCitation: true,
      },
      testVectors: [
        { id: "window-close-protection-unavailable", expected: "reject" },
        { id: "window-open-not-applicable", expected: "not_applicable" },
        { id: "window-close-without-constraint", expected: "fixed_rule_fallback" },
      ],
    },
  ],
};

// This digest protects only the repository's built-in offline bundle. It is not an external signature or PKI claim.
export const MANUAL_SAFETY_POLICY_BUNDLE = deepFreeze({
  ...POLICY_BUNDLE_PAYLOAD,
  integrity: {
    algorithm: "sha256",
    digest: "sha256:450932b44ee28ecbb061d03e3bfa00701f34c22d8ee44536f77edc2227b69922",
    trustBoundary: "local-built-in-integrity-only; no external signer or PKI",
  },
});

export const TAILGATE_CLEARANCE_CONFIRMATION_POLICY = Object.freeze({
  version: "1.0.0",
  policyId: "tailgate-clearance-confirmation",
});

export const WINDOW_ANTI_PINCH_PROTECTION_POLICY = Object.freeze({
  version: "1.0.0",
  policyId: "window-anti-pinch-protection",
});

export function evaluateManualSafetyPolicy({
  parsedCommand,
  trustedVehicleState = {},
  manualSafetyConstraints = [],
  baselineEffect,
  bundle = MANUAL_SAFETY_POLICY_BUNDLE,
} = {}) {
  const integrity = verifyManualSafetyPolicyBundle(bundle);
  if (!integrity.valid) {
    return {
      matched: false,
      applied: false,
      source: "fixed-rule-fallback",
      constraint: "",
      citation: "",
      fallback: true,
      bundleDigest: integrity.actualDigest,
      integrity,
    };
  }

  const facts = { command: parsedCommand || {}, vehicle: trustedVehicleState || {} };
  const candidates = bundle.policies
    .filter((policy) => matchesApplicability(policy.applicability, facts))
    .sort(comparePolicies);
  if (!candidates.length) return null;

  const baselineRank = EFFECT_PRIORITY[baselineEffect];
  if (baselineRank == null) {
    return {
      matched: false,
      applied: false,
      source: "fixed-rule-fallback",
      constraint: "",
      citation: "",
      fallback: true,
      reason: "invalid-or-missing-baseline-effect",
      bundleDigest: integrity.actualDigest,
      integrity,
    };
  }
  const applicable = candidates.filter((policy) => EFFECT_PRIORITY[policy.effect] >= baselineRank);
  const selected = applicable[0];
  if (!selected) {
    return {
      matched: true,
      applied: false,
      source: "fixed-rule-fallback",
      constraint: "",
      citation: "",
      fallback: true,
      baselineEffect,
      reason: "manual-policy-cannot-weaken-baseline",
      bundleDigest: integrity.actualDigest,
      integrity,
    };
  }

  const constraint = manualSafetyConstraints.find((item) => matchesCondition(
    selected.citationBinding.condition,
    { ...facts, constraint: item },
  ) && isPublishedConstraintBinding(item, selected)
    && (!selected.citationBinding.requireCitation || Boolean(item.citation)));
  const common = {
    policyId: selected.policyId,
    version: selected.version,
    manualVersion: selected.manualVersion,
    effect: selected.effect,
    priority: selected.priority,
    matched: true,
    baselineEffect,
    bundleDigest: integrity.actualDigest,
    integrity,
  };
  if (!constraint) {
    return {
      ...common,
      applied: false,
      source: "fixed-rule-fallback",
      constraint: "",
      constraintId: "",
      citation: "",
      fallback: true,
    };
  }

  return {
    ...common,
    applied: true,
    constraintPublicationStatus: constraint.reviewStatus,
    humanReviewed: constraint.humanReviewed,
    productionApproved: constraint.productionApproved,
    source: constraint.source,
    constraint: constraint.note || constraint.constraintType || constraint.topic,
    constraintId: constraint.id,
    citation: constraint.citation,
    constraintTopic: constraint.topic,
  };
}

function isPublishedConstraintBinding(constraint, policy) {
  return constraint?.registryId === LOCAL_DEV_CONSTRAINT_REGISTRY_ID
    && constraint.registryVersion === LOCAL_DEV_CONSTRAINT_REGISTRY_VERSION
    && constraint.reviewStatus === "approved-for-local-dev"
    && constraint.humanReviewed === false
    && constraint.productionApproved === false
    && constraint.manualVersion === policy.manualVersion
    && constraint.sourceProvenance?.manualVersion === policy.manualVersion
    && constraint.sourceProvenance?.sourceId === constraint.sourceId
    && constraint.sourceProvenance?.chunkId === constraint.chunkId
    && Boolean(constraint.citationSpan);
}

export function verifyManualSafetyPolicyBundle(bundle = MANUAL_SAFETY_POLICY_BUNDLE) {
  const invalid = (reason, actualDigest = "") => ({
    valid: false,
    reason,
    algorithm: bundle?.integrity?.algorithm || "unknown",
    expectedDigest: bundle?.integrity?.digest || "",
    actualDigest,
    trustBoundary: "local-built-in-integrity-only; no external signer or PKI",
  });
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.policies)) return invalid("invalid-bundle-shape");
  if (bundle.integrity?.algorithm !== "sha256" || typeof bundle.integrity?.digest !== "string") return invalid("invalid-integrity-metadata");

  for (const policy of bundle.policies) {
    const missing = REQUIRED_POLICY_FIELDS.find((field) => !Object.hasOwn(policy || {}, field));
    if (missing) return invalid(`missing-policy-field:${missing}`);
    if (!Object.hasOwn(EFFECT_PRIORITY, policy.effect) || policy.effect === "allow") return invalid(`invalid-effect:${policy.effect}`);
    if (!Number.isFinite(policy.priority)) return invalid("invalid-priority");
    if (!Array.isArray(policy.applicability?.all) || !policy.applicability.all.length) return invalid("invalid-applicability");
    if (!Array.isArray(policy.testVectors) || !policy.testVectors.length) return invalid("missing-test-vectors");
    if (!policy.citationBinding?.condition || !SUPPORTED_OPERATORS.has(policy.citationBinding.condition.operator)) {
      return invalid("invalid-citation-binding");
    }
    if (!isAllowedSource(policy.citationBinding.condition.source) || !policy.citationBinding.condition.source.startsWith("constraint.")) {
      return invalid("invalid-citation-source");
    }
    for (const condition of policy.applicability.all) {
      if (!SUPPORTED_OPERATORS.has(condition?.operator)) return invalid(`unknown-operator:${condition?.operator}`);
      if (!isAllowedSource(condition?.source)) return invalid(`unknown-source:${condition?.source}`);
    }
  }

  const payload = { ...bundle };
  delete payload.integrity;
  const actualDigest = `sha256:${sha256(stableStringify(payload))}`;
  if (actualDigest !== bundle.integrity.digest) return invalid("digest-mismatch", actualDigest);
  return {
    valid: true,
    reason: "verified-local-built-in-bundle",
    algorithm: "sha256",
    expectedDigest: bundle.integrity.digest,
    actualDigest,
    trustBoundary: bundle.integrity.trustBoundary,
  };
}

export function computeManualSafetyPolicyBundleDigest(bundlePayload) {
  const payload = { ...bundlePayload };
  delete payload.integrity;
  return `sha256:${sha256(stableStringify(payload))}`;
}

function matchesApplicability(applicability, facts) {
  return applicability.all.every((condition) => matchesCondition(condition, facts));
}

function matchesCondition(condition, facts) {
  const actual = readPath(facts, condition.source);
  if (condition.operator === "eq") return actual === condition.value;
  if (condition.operator === "notEq") return actual !== condition.value;
  if (condition.operator === "isUnknown") return actual == null;
  return false;
}

function comparePolicies(left, right) {
  return EFFECT_PRIORITY[right.effect] - EFFECT_PRIORITY[left.effect]
    || right.priority - left.priority
    || left.policyId.localeCompare(right.policyId);
}

function isAllowedSource(source) {
  return typeof source === "string" && /^(command\.(intent|slots\.[A-Za-z][A-Za-z0-9_]*)|vehicle\.[A-Za-z][A-Za-z0-9_]*|constraint\.topic)$/.test(source);
}

function readPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// Small synchronous SHA-256 implementation keeps the policy evaluator browser-compatible.
function sha256(input) {
  const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
  const maxWord = 2 ** 32;
  const words = [];
  const ascii = unescape(encodeURIComponent(input));
  const bitLength = ascii.length * 8;
  const hash = [];
  const constants = [];
  const isComposite = {};
  let primeCounter = 0;
  for (let candidate = 2; primeCounter < 64; candidate += 1) {
    if (isComposite[candidate]) continue;
    for (let multiple = candidate * candidate; multiple < 312; multiple += candidate) isComposite[multiple] = true;
    if (primeCounter < 8) hash[primeCounter] = (candidate ** 0.5 * maxWord) | 0;
    constants[primeCounter] = (candidate ** (1 / 3) * maxWord) | 0;
    primeCounter += 1;
  }
  let padded = `${ascii}\x80`;
  while (padded.length % 64 !== 56) padded += "\x00";
  for (let index = 0; index < padded.length; index += 1) words[index >> 2] |= padded.charCodeAt(index) << ((3 - index) % 4) * 8;
  words.push((bitLength / maxWord) | 0, bitLength);
  for (let block = 0; block < words.length; block += 16) {
    const working = hash.slice(0, 8);
    const schedule = [];
    for (let round = 0; round < 64; round += 1) {
      const word = round < 16 ? words[block + round] : (
        schedule[round - 16]
        + (rightRotate(schedule[round - 15], 7) ^ rightRotate(schedule[round - 15], 18) ^ (schedule[round - 15] >>> 3))
        + schedule[round - 7]
        + (rightRotate(schedule[round - 2], 17) ^ rightRotate(schedule[round - 2], 19) ^ (schedule[round - 2] >>> 10))
      );
      schedule[round] = word | 0;
      const sigma1 = rightRotate(working[4], 6) ^ rightRotate(working[4], 11) ^ rightRotate(working[4], 25);
      const choice = (working[4] & working[5]) ^ (~working[4] & working[6]);
      const temp1 = (working[7] + sigma1 + choice + constants[round] + schedule[round]) | 0;
      const sigma0 = rightRotate(working[0], 2) ^ rightRotate(working[0], 13) ^ rightRotate(working[0], 22);
      const majority = (working[0] & working[1]) ^ (working[0] & working[2]) ^ (working[1] & working[2]);
      const temp2 = (sigma0 + majority) | 0;
      working.pop();
      working.unshift((temp1 + temp2) | 0);
      working[4] = (working[4] + temp1) | 0;
    }
    for (let index = 0; index < 8; index += 1) hash[index] = (hash[index] + working[index]) | 0;
  }
  return hash.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}
