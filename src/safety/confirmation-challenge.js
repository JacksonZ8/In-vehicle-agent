const OMITTED_ACTION_SLOT_KEYS = new Set(["confirmRearClearance"]);

export const TAILGATE_CLEARANCE_ASSERTION = "tailgate.rear-clearance-acknowledged";

export const CONFIRMATION_ASSERTION_POLICY_REGISTRY = Object.freeze({
  "tailgate-clearance-confirmation": Object.freeze([
    Object.freeze({
      id: TAILGATE_CLEARANCE_ASSERTION,
      prompt: "我已确认尾门后方无人且无障碍物。",
      proofType: "user-acknowledgement",
      riskType: "tailgate-clearance",
    }),
  ]),
});

const VERIFIED_ASSERTION_SETS = new WeakSet();

export function createTrustedConfirmationAssertions(assertions) {
  const trusted = Object.freeze({ ...(assertions || {}) });
  VERIFIED_ASSERTION_SETS.add(trusted);
  return trusted;
}

export function isTrustedConfirmationAssertions(assertions) {
  return Boolean(assertions && typeof assertions === "object" && VERIFIED_ASSERTION_SETS.has(assertions));
}

export function resolveConfirmationAssertions(policy = {}, parsedCommand = {}) {
  const policyAssertions = normalizeConfirmationAssertions(policy.confirmationAssertions);
  if (policyAssertions.length) return policyAssertions;
  const registeredAssertions = CONFIRMATION_ASSERTION_POLICY_REGISTRY[String(policy.policyId || "")];
  if (registeredAssertions?.length) return registeredAssertions.map((item) => ({ ...item }));
  return [{
    id: `${slugFor(policy.policyId || parsedCommand.intent || "safety")}.user-acknowledged`,
    prompt: "我已阅读并确认本次安全提示，仍希望继续执行。",
    proofType: "user-acknowledgement",
    riskType: "generic-safety-confirmation",
  }];
}

export async function createActionDigest(parsedCommand, policy = {}) {
  const slots = Object.fromEntries(
    Object.entries(parsedCommand?.slots || {})
      .filter(([key]) => !OMITTED_ACTION_SLOT_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const binding = stableStringify({
    requestId: String(parsedCommand?.requestId || ""),
    intent: String(parsedCommand?.intent || ""),
    slots,
    policy: {
      policyId: String(policy?.policyId || ""),
      version: String(policy?.version || ""),
      source: String(policy?.source || ""),
      constraintId: String(policy?.constraintId || ""),
      applied: policy?.applied === true,
      fallback: policy?.fallback === true,
    },
  });
  return `sha256:${await sha256Hex(binding)}`;
}

export function createResponseToken() {
  const bytes = new Uint8Array(24);
  if (!globalThis.crypto?.getRandomValues) throw new Error("Secure random generator is unavailable");
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeConfirmationAssertions(assertions) {
  if (!Array.isArray(assertions)) return [];
  return assertions
    .map((item) => ({
      id: String(item?.id || "").trim(),
      prompt: String(item?.prompt || "").trim(),
      ...(item?.proofType ? { proofType: String(item.proofType) } : {}),
      ...(item?.riskType ? { riskType: String(item.riskType) } : {}),
    }))
    .filter((item) => item.id && item.prompt);
}

function slugFor(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "safety";
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  if (!globalThis.crypto?.subtle) throw new Error("SHA-256 is unavailable");
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data)));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
