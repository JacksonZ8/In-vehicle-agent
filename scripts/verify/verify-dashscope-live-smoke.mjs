import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const STATIC_ONLY = process.argv.includes("--static-only");
const LIVE_OPT_IN = "NIO_ALLOW_LIVE_MODEL_TESTS";
const FIXED_PROVIDER = "dashscope";
const FIXED_MODEL = "qwen3.5-flash";
// Cloud Vehicle-SLU is an explicit opt-in (NIO_VEHICLE_SLU_PROFILE=cloud-dashscope on the
// Agent Server) with exactly one semantic request: no schema repair and no fallback provider.
const OPT_IN_PROFILE_ENV = "NIO_VEHICLE_SLU_PROFILE=cloud-dashscope";
const RUNTIME_CONTRACT_VERSION = "b3-b4-runtime@1.0.0";
const VEHICLE_SLU_CONTRACT_VERSION = "nio-vehicle-slu-contract@2.0.0";
const REVISION_SOURCES = Object.freeze([
  "provider-observed",
  "pinned-model-id",
]);
const PUBLIC_PROFILE_SCHEMA_VERSION = 3;
const AGENT_BASE_URL = "http://127.0.0.1:4173";
const REQUEST_TIMEOUT_MS = 15_000;
const VEHICLE_SLU_REQUESTS = 1;
const NORMAL_EXTERNAL_MODEL_REQUESTS = 1;
const MAX_SCHEMA_REPAIR_CALLS = 0;
const MAX_FALLBACK_CALLS = 0;
const MAX_EXTERNAL_MODEL_REQUESTS = 1;
const ALLOW_REQUEST_LOOP = false;
const REQUEST_PLAN = Object.freeze({
  task: "vehicle_slu",
  vehicleSluRequests: VEHICLE_SLU_REQUESTS,
  normalExternalModelCalls: NORMAL_EXTERNAL_MODEL_REQUESTS,
  maxExternalModelCalls: MAX_EXTERNAL_MODEL_REQUESTS,
  maxSchemaRepairCalls: MAX_SCHEMA_REPAIR_CALLS,
  maxFallbackCalls: MAX_FALLBACK_CALLS,
  loop: ALLOW_REQUEST_LOOP,
});
const OUTPUT_FIELDS = Object.freeze([
  "task",
  "status",
  "provider",
  "model",
  "revision",
  "revisionSource",
  "contractVersion",
  "fallbackActive",
  "externalModelRequestCount",
  "reasonCode",
]);

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function liveOptInAllowed(env = {}) {
  return env[LIVE_OPT_IN] === "true";
}

function safeToken(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && value.trim() === value
    && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value)
    ? value
    : null;
}

function safeReasonCode(value) {
  return safeToken(value) || "unavailable";
}

function safeRevisionSource(value) {
  return REVISION_SOURCES.includes(value) ? value : null;
}

function projectRevisionQualification({
  provider,
  model,
  revision,
  revisionSource,
} = {}) {
  const safeRevision = safeToken(revision);
  const safeSource = safeRevisionSource(revisionSource);
  if (!safeRevision || !safeSource) return null;
  if (safeSource === "provider-observed") {
    return Object.freeze({ revision: safeRevision, revisionSource: safeSource });
  }
  if (safeSource === "pinned-model-id"
    && provider === FIXED_PROVIDER
    && model === FIXED_MODEL
    && safeRevision === FIXED_MODEL) {
    return Object.freeze({ revision: safeRevision, revisionSource: safeSource });
  }
  return null;
}

function qualifyResponseRevision({ telemetry, provider, model }) {
  const explicitQualification = projectRevisionQualification({
    provider,
    model,
    revision: telemetry.revision ?? telemetry.modelRevision,
    revisionSource: telemetry.revisionSource,
  });
  if (explicitQualification) return explicitQualification;
  if (provider === FIXED_PROVIDER && model === FIXED_MODEL) {
    return Object.freeze({
      revision: FIXED_MODEL,
      revisionSource: "pinned-model-id",
    });
  }
  return null;
}

function safeExternalModelRequestCount(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_EXTERNAL_MODEL_REQUESTS
    ? value
    : null;
}

function projectSmokeResult({
  status,
  provider,
  model,
  revision,
  revisionSource,
  contractVersion,
  fallbackActive,
  externalModelRequestCount,
  reasonCode,
} = {}) {
  const allowedIdentity = provider === FIXED_PROVIDER && model === FIXED_MODEL;
  const revisionQualification = projectRevisionQualification({
    provider,
    model,
    revision,
    revisionSource,
  });
  const contractValid = contractVersion === VEHICLE_SLU_CONTRACT_VERSION;
  return Object.freeze({
    task: "vehicle_slu",
    status: status === "passed" && allowedIdentity && contractValid && revisionQualification
      ? "passed"
      : "failed",
    provider: allowedIdentity ? provider : "unavailable",
    model: allowedIdentity ? model : "unavailable",
    revision: revisionQualification?.revision ?? null,
    revisionSource: revisionQualification?.revisionSource ?? null,
    contractVersion: contractValid ? contractVersion : null,
    fallbackActive: typeof fallbackActive === "boolean" ? fallbackActive : null,
    externalModelRequestCount: safeExternalModelRequestCount(externalModelRequestCount),
    reasonCode: safeReasonCode(reasonCode),
  });
}

function smokeFailure(reasonCode, details = {}) {
  const error = new Error(reasonCode);
  error.safeResult = projectSmokeResult({
    status: "failed",
    reasonCode,
    ...details,
  });
  return error;
}

async function readJson(response) {
  try {
    return { parsed: true, payload: await response.json() };
  } catch {
    return { parsed: false, payload: null };
  }
}

async function requireVehicleSluProfile(fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${AGENT_BASE_URL}/api/model-provider-profile`, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw smokeFailure("profile-request-failed");
  }
  const parsed = await readJson(response);
  if (!response.ok || !parsed.parsed || !isRecord(parsed.payload)) {
    throw smokeFailure("profile-response-invalid");
  }
  const publicSet = parsed.payload;
  const profile = publicSet.tasks?.vehicle_slu;
  if (publicSet.schemaVersion !== PUBLIC_PROFILE_SCHEMA_VERSION
    || publicSet.runtimeContractVersion !== RUNTIME_CONTRACT_VERSION
    || !isRecord(profile)
    || profile.provider !== FIXED_PROVIDER
    || profile.model !== FIXED_MODEL
    || profile.mode !== "non-thinking"
    || profile.schemaVersion !== VEHICLE_SLU_CONTRACT_VERSION
    || profile.fallbackConfigured !== false
    || profile.readiness?.status !== "ready") {
    throw smokeFailure("profile-identity-mismatch");
  }
  return Object.freeze({
    runtimeContractVersion: publicSet.runtimeContractVersion,
    provider: profile.provider,
    model: profile.model,
    mode: profile.mode,
    schemaVersion: profile.schemaVersion,
    fallbackConfigured: profile.fallbackConfigured,
  });
}

function classifyVehicleSluResponse({ responseOk, parsed, payload }) {
  if (!responseOk || !parsed || !isRecord(payload) || !isRecord(payload.telemetry)) {
    return projectSmokeResult({
      status: "failed",
      reasonCode: "vehicle-slu-response-invalid",
    });
  }
  const { telemetry } = payload;
  const envelope = payload.semanticEnvelope;
  const fallbackActive = telemetry.fallbackActive === true;
  const identityValid = !fallbackActive
    && telemetry.provider === FIXED_PROVIDER
    && telemetry.model === FIXED_MODEL
    && payload.model === FIXED_MODEL;
  const envelopeValid = isRecord(envelope)
    && envelope.contractVersion === VEHICLE_SLU_CONTRACT_VERSION
    && typeof envelope.requestId === "string";
  const requestCount = safeExternalModelRequestCount(telemetry.externalModelRequestCount);
  const revisionQualification = qualifyResponseRevision({
    telemetry,
    provider: telemetry.provider,
    model: telemetry.model,
  });
  const passed = identityValid
    && envelopeValid
    && requestCount !== null
    && revisionQualification !== null;
  return projectSmokeResult({
    status: passed ? "passed" : "failed",
    provider: telemetry.provider,
    model: telemetry.model,
    revision: revisionQualification?.revision,
    revisionSource: revisionQualification?.revisionSource,
    contractVersion: envelope?.contractVersion,
    fallbackActive,
    externalModelRequestCount: telemetry.externalModelRequestCount,
    reasonCode: passed ? "vehicle-slu-valid" : "vehicle-slu-contract-invalid",
  });
}

async function requestVehicleSlu({ fetchImpl = fetch } = {}) {
  const requestId = "live-smoke:vehicle-slu:1";
  let response;
  try {
    response = await fetchImpl(`${AGENT_BASE_URL}/api/local-semantic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, text: "你好，请简单介绍一下你能做什么。" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw smokeFailure("vehicle-slu-request-failed");
  }
  const parsed = await readJson(response);
  return classifyVehicleSluResponse({
    responseOk: response.ok,
    parsed: parsed.parsed,
    payload: parsed.payload,
  });
}

function printRequestPlan() {
  console.log(JSON.stringify({ type: "live-model-request-plan", ...REQUEST_PLAN }));
}

async function verifyStaticContract() {
  assert.equal(liveOptInAllowed({}), false);
  assert.equal(liveOptInAllowed({ [LIVE_OPT_IN]: "false" }), false);
  assert.equal(liveOptInAllowed({ [LIVE_OPT_IN]: "true" }), true);
  assert.deepEqual(REQUEST_PLAN, {
    task: "vehicle_slu",
    vehicleSluRequests: 1,
    normalExternalModelCalls: 1,
    maxExternalModelCalls: 1,
    maxSchemaRepairCalls: 0,
    maxFallbackCalls: 0,
    loop: false,
  });
  assert.equal(Object.isFrozen(REQUEST_PLAN), true);

  const validProfileSet = {
    schemaVersion: 3,
    runtimeContractVersion: "b3-b4-runtime@1.0.0",
    tasks: {
      vehicle_slu: {
        provider: "dashscope",
        model: "qwen3.5-flash",
        mode: "non-thinking",
        schemaVersion: "nio-vehicle-slu-contract@2.0.0",
        fallbackConfigured: false,
        watchdogMs: null,
        readiness: { status: "ready" },
      },
    },
  };
  const profileCalls = [];
  const profile = await requireVehicleSluProfile(async (url, options) => {
    profileCalls.push({ url, method: options.method });
    return { ok: true, async json() { return validProfileSet; } };
  });
  assert.deepEqual(profile, {
    runtimeContractVersion: "b3-b4-runtime@1.0.0",
    provider: FIXED_PROVIDER,
    model: FIXED_MODEL,
    mode: "non-thinking",
    schemaVersion: VEHICLE_SLU_CONTRACT_VERSION,
    fallbackConfigured: false,
  });
  assert.deepEqual(profileCalls, [{
    url: `${AGENT_BASE_URL}/api/model-provider-profile`,
    method: "GET",
  }]);

  for (const invalidProfileSet of [
    { ...validProfileSet, runtimeContractVersion: undefined },
    { ...validProfileSet, runtimeContractVersion: "b3-b4-runtime@0.9.0" },
    {
      ...validProfileSet,
      tasks: { vehicle_slu: { ...validProfileSet.tasks.vehicle_slu, fallbackConfigured: true } },
    },
    {
      ...validProfileSet,
      tasks: { vehicle_slu: { ...validProfileSet.tasks.vehicle_slu, provider: "ollama" } },
    },
  ]) {
    await assert.rejects(
      () => requireVehicleSluProfile(async () => ({
        ok: true,
        async json() { return invalidProfileSet; },
      })),
      (error) => error?.safeResult?.reasonCode === "profile-identity-mismatch",
      "wrong runtime contract, a configured fallback or the local default profile must fail before the Vehicle request",
    );
  }

  const projected = projectSmokeResult({
    status: "passed",
    provider: FIXED_PROVIDER,
    model: FIXED_MODEL,
    revision: "2026-02-23",
    revisionSource: "provider-observed",
    contractVersion: VEHICLE_SLU_CONTRACT_VERSION,
    fallbackActive: false,
    externalModelRequestCount: 1,
    reasonCode: "vehicle-slu-valid",
    rawPrompt: "must-not-project",
    apiKey: "must-not-project",
  });
  assert.deepEqual(Object.keys(projected), [...OUTPUT_FIELDS]);
  assert.equal(JSON.stringify(projected).includes("must-not-project"), false);
  assert.equal(projected.revisionSource, "provider-observed");

  const unqualifiedRevision = projectSmokeResult({
    status: "passed",
    provider: FIXED_PROVIDER,
    model: FIXED_MODEL,
    contractVersion: VEHICLE_SLU_CONTRACT_VERSION,
    fallbackActive: false,
    externalModelRequestCount: 1,
    reasonCode: "vehicle-slu-valid",
  });
  assert.equal(unqualifiedRevision.status, "failed",
    "a live result without a qualified revision identity must fail");

  const validResponse = {
    model: FIXED_MODEL,
    semanticEnvelope: {
      contractVersion: VEHICLE_SLU_CONTRACT_VERSION,
      requestId: "live-smoke:vehicle-slu:1",
    },
    telemetry: {
      provider: FIXED_PROVIDER,
      model: FIXED_MODEL,
      fallbackActive: false,
      externalModelRequestCount: 1,
    },
  };
  const pinnedRevisionResult = classifyVehicleSluResponse({
    responseOk: true,
    parsed: true,
    payload: validResponse,
  });
  assert.equal(pinnedRevisionResult.status, "passed");
  assert.equal(pinnedRevisionResult.revision, FIXED_MODEL);
  assert.equal(pinnedRevisionResult.revisionSource, "pinned-model-id",
    "a pinned model ID is a qualification source, not Provider-observed metadata");

  for (const [label, telemetry] of [
    ["fallback", { ...validResponse.telemetry, provider: "ollama", model: "qwen3:8b", fallbackActive: true }],
    ["repair or second request", { ...validResponse.telemetry, externalModelRequestCount: 2 }],
  ]) {
    const result = classifyVehicleSluResponse({
      responseOk: true,
      parsed: true,
      payload: { ...validResponse, telemetry },
    });
    assert.equal(result.status, "failed", `${label} must fail: cloud Vehicle-SLU is one request with no fallback`);
  }

  const source = await readFile(new URL(import.meta.url), "utf8");
  const forbiddenMutationFragments = [
    ["/api", "/pull"].join(""),
    ["/api", "/create"].join(""),
    ["/api", "/delete"].join(""),
  ];
  for (const fragment of forbiddenMutationFragments) {
    assert.equal(source.includes(fragment), false,
      `live smoke must not contain model mutation endpoint ${fragment}`);
  }
  assert.match(source, /if \(!STATIC_ONLY && !liveOptInAllowed\(process\.env\)\)/);
  assert.match(source, /printRequestPlan\(\);\s*const profile = await requireVehicleSluProfile/);

  console.log(JSON.stringify({
    status: "PASS",
    mode: "static-only",
    task: "vehicle_slu",
    profile,
    requestPlan: REQUEST_PLAN,
    networkTouched: false,
  }));
}

async function runLiveSmoke() {
  printRequestPlan();
  const profile = await requireVehicleSluProfile();
  console.log(JSON.stringify({ type: "live-model-approved-identity", profile }));
  const result = await requestVehicleSlu();
  console.log(JSON.stringify(result));
  if (result.status !== "passed") process.exitCode = 1;
}

if (!STATIC_ONLY && !liveOptInAllowed(process.env)) {
  throw new Error(
    `Live model smoke is disabled; obtain authorization, start the Agent Server with ${OPT_IN_PROFILE_ENV} and set ${LIVE_OPT_IN}=true`,
  );
}

if (STATIC_ONLY) {
  await verifyStaticContract();
} else {
  try {
    await runLiveSmoke();
  } catch (error) {
    console.error(JSON.stringify(
      error?.safeResult
        ?? projectSmokeResult({ status: "failed", reasonCode: "live-smoke-failed" }),
    ));
    process.exitCode = 1;
  }
}
