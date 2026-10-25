import {
  createVehicleSluEnvelope,
  VEHICLE_SLU_CONTRACT,
  VEHICLE_SLU_PROMPT_VERSION,
} from "../../src/semantic/vehicle-slu-contract.js";
import {
  isVehicleSluCompactModel,
  VEHICLE_SLU_COMPACT_PROMPT_VERSION,
} from "../../src/semantic/vehicle-slu-compact-v9.js";

const BOOT_FAILURE_PATTERN = /node:fs\/promises|boot failed|启动失败|Boot failed/i;

export async function assertNoHmiBootFailure(page, phase = "verification") {
  const bodyText = await page.locator("body").innerText();
  if (BOOT_FAILURE_PATTERN.test(bodyText)) {
    throw new Error(`Page contains boot failure text during ${phase}.`);
  }
}

export function assertNoRuntimeExecutionPath(result, label = "request") {
  if (result?.toolCall) {
    throw new Error(`${label} generated toolCall: ${JSON.stringify(result.toolCall)}`);
  }
  if (result?.safetyDecision) {
    throw new Error(`${label} reached Safety Gateway: ${JSON.stringify(result.safetyDecision)}`);
  }
  if (result?.toolResult) {
    throw new Error(`${label} reached Vehicle Tool: ${JSON.stringify(result.toolResult)}`);
  }
}

export async function loadHmiVehicleSluFixtureProfile(baseUrl) {
  const response = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/api/model-provider-profile`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Model provider profile returned HTTP ${response.status}.`);
  const profile = (await response.json())?.tasks?.vehicle_slu;
  if (!profile
    || profile.readiness?.status !== "ready"
    || !["ollama", "dashscope"].includes(profile.provider)
    || typeof profile.model !== "string"
    || !profile.model
    || profile.schemaVersion !== VEHICLE_SLU_CONTRACT.ref) {
    throw new Error("Vehicle-SLU fixture requires a ready V2 provider profile.");
  }
  return profile;
}

export function createHmiVehicleSluFixtureResponse({
  profile,
  requestId,
  domain = "vehicle",
  conversationGoal,
  vehicleFrames = [],
  domainConfidence = 0.99,
}) {
  const semanticEnvelope = createVehicleSluEnvelope({
    contractVersion: VEHICLE_SLU_CONTRACT.ref,
    requestId,
    domain,
    conversationGoal,
    vehicleFrames,
    domainConfidence,
  });
  return {
    model: profile.model,
    semanticEnvelope,
    telemetry: {
      provider: profile.provider,
      model: profile.model,
      modelType: "vehicle-slu",
      contractVersion: VEHICLE_SLU_CONTRACT.ref,
      // Same rule as LocalModelAdapter: the compact model is served the compact prompt.
      promptVersion: isVehicleSluCompactModel(profile)
        ? VEHICLE_SLU_COMPACT_PROMPT_VERSION
        : VEHICLE_SLU_PROMPT_VERSION,
      promptChars: 1,
      durationMs: 0,
      semanticDecisionMs: 0,
      firstModelTokenMs: null,
      firstModelTokenStatus: "unobservable-non-streaming",
      slowStage: null,
      watchdogMs: null,
      ollamaDurations: {},
      degraded: false,
      externalModelRequestCount: 0,
    },
  };
}

export function createHmiVehicleSluFrame({
  frameId,
  capability,
  intent,
  speechAct = "question",
  knowledgeNeed = "none",
  actionNeed = "none",
  slots = {},
  missingSlots = [],
  clarificationQuestion = null,
  standaloneQuery = null,
  confidence = 0.98,
}) {
  return {
    frameId,
    capability,
    intent,
    speechAct,
    knowledgeNeed,
    actionNeed,
    slots,
    missingSlots,
    clarificationQuestion,
    standaloneQuery,
    confidence,
  };
}
