import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  createVehicleSluEnvelope,
  getMissingVehicleSluRequiredSlots,
  VEHICLE_SLU_CONTRACT,
  VEHICLE_SLU_OUTPUT_SCHEMA,
  VEHICLE_SLU_PROMPT_VERSION,
  VEHICLE_SLU_SLOT_SCHEMAS,
} from "../../src/semantic/vehicle-slu-contract.js";
import { buildVehicleSluPrompt } from "../../src/semantic/vehicle-slu-prompt.js";
import {
  expandVehicleSluCompact,
  VEHICLE_SLU_COMPACT_OUTPUT_FORMAT,
} from "../../src/semantic/vehicle-slu-compact.js";
import {
  buildVehicleSluCompactV9Prompt,
  VEHICLE_SLU_COMPACT_GENERATION_PROFILE,
  VEHICLE_SLU_COMPACT_MODEL,
  VEHICLE_SLU_COMPACT_PROFILE,
  VEHICLE_SLU_COMPACT_PROMPT_VERSION,
  VEHICLE_SLU_COMPACT_SYSTEM,
} from "../../src/semantic/vehicle-slu-compact-v9.js";
import { VEHICLE_STATE_KEYS } from "../../src/safety/vehicle-state.js";
import { isVehicleControlIntent } from "../../src/runtime/agent-schemas.js";

export const VEHICLE_SLU_CASE_TIMEOUT_MS = 3_000;
export const VEHICLE_SLU_MODEL_WARMUP_TIMEOUT_MS = 120_000;

const FIXTURE_VERSION = "vehicle-slu-golden@2.0.2";
const FIXED_FIXTURE_CATEGORIES = Object.freeze({
  "chat-emotion": Object.freeze({ count: 30, idPrefix: "slu-chat" }),
  "open-qa": Object.freeze({ count: 20, idPrefix: "slu-open-qa" }),
  "vehicle-knowledge": Object.freeze({ count: 15, idPrefix: "slu-vehicle-knowledge" }),
  "complete-control": Object.freeze({ count: 15, idPrefix: "slu-complete-control" }),
  "incomplete-control": Object.freeze({ count: 10, idPrefix: "slu-incomplete-control" }),
  "vehicle-services": Object.freeze({ count: 10, idPrefix: "slu-services" }),
  "non-execution": Object.freeze({ count: 10, idPrefix: "slu-non-execution" }),
  "mixed-multi-intent": Object.freeze({ count: 10, idPrefix: "slu-mixed" }),
});
const FIXED_FIXTURE_CASE_COUNT = Object.values(FIXED_FIXTURE_CATEGORIES)
  .reduce((total, { count }) => total + count, 0);
const NON_EXECUTION_SPEECH_ACTS = Object.freeze({
  "slu-non-execution-001": "report",
  "slu-non-execution-002": "question",
  "slu-non-execution-003": "command",
  "slu-non-execution-004": "complaint",
  "slu-non-execution-005": "command",
  "slu-non-execution-006": "command",
  "slu-non-execution-007": "question",
  "slu-non-execution-008": "report",
  "slu-non-execution-009": "command",
  "slu-non-execution-010": "command",
});
const PUBLIC_SLOT_STRING_MAX_LENGTH = 160;
const PUBLIC_STATE_FIELDS_MAX_LENGTH = 32;
const PUBLIC_STATE_FIELD_SET = new Set(VEHICLE_STATE_KEYS);
const OMIT_PUBLIC_SLOT = Symbol("omit-public-slot");
const KEY_CHAT_CATEGORIES = new Set(["chat-emotion", "open-qa"]);
const DYNAMIC_CONTROL_SLOT_INTENTS = new Set(["cabin.climate.setPreset", "cabin.comfort.applySettings"]);
const DIAGNOSTIC_SAMPLING = Object.freeze({
  strategy: "first-contract-valid-per-frozen-category",
  perCategory: 2,
  caseCount: Object.keys(FIXED_FIXTURE_CATEGORIES).length * 2,
});
const DIAGNOSTIC_DECISION = Object.freeze({
  selectedModel: null,
  productionQualified: false,
  decision: "diagnostic-only",
  reason: "diagnostic-sample-not-qualification",
});
const OLLAMA_DURATION_FIELDS = Object.freeze({
  total_duration: "totalDurationNs",
  load_duration: "loadDurationNs",
  prompt_eval_count: "promptEvalCount",
  prompt_eval_duration: "promptEvalDurationNs",
  eval_count: "evalCount",
  eval_duration: "evalDurationNs",
});

export function projectVehicleSluMetrics(runs) {
  if (!Array.isArray(runs)) throw new TypeError("runs must be an array");
  const total = runs.length;
  const completeControlRuns = runs.filter((entry) => entry?.category === "complete-control");
  const zeroWriteRuns = runs.filter((entry) => entry?.expected?.vehicleWriteCount === 0);
  const keyChatRuns = runs.filter((entry) => KEY_CHAT_CATEGORIES.has(entry?.category));
  const latencies = runs
    .map((entry) => entry?.latencyMs)
    .filter((value) => Number.isFinite(value) && value >= 0);

  const domainCorrectCount = runs.filter((entry) => entry?.status === "ok"
    && entry.semanticEnvelope?.domain === entry.expected?.semanticEnvelope?.domain).length;
  const completeIntentCorrectCount = completeControlRuns.filter(hasExactControlIntents).length;
  const completeRequiredSlotCorrectCount = completeControlRuns.filter(hasExactControlRequiredSlots).length;
  const falseVehicleWriteCount = zeroWriteRuns.filter((entry) => entry?.status === "ok"
    && hasVehicleWriteRequest(entry.semanticEnvelope)).length;
  const keyChatFalseClarificationCount = keyChatRuns.filter((entry) => entry?.status === "ok"
    && hasVehicleControlClarification(entry.semanticEnvelope)).length;
  const semanticCorrect = runs.map((entry) => entry?.status === "ok"
    && isDeepStrictEqual(
      canonicalSemanticEnvelope(entry.semanticEnvelope),
      canonicalSemanticEnvelope(entry.expected?.semanticEnvelope),
    ));

  const categoryEntries = new Map();
  runs.forEach((entry, index) => {
    const category = String(entry?.category || "unknown");
    const current = categoryEntries.get(category) || { total: 0, correct: 0 };
    current.total += 1;
    if (semanticCorrect[index]) current.correct += 1;
    categoryEntries.set(category, current);
  });
  const perCategory = Object.fromEntries([...categoryEntries].map(([category, counts]) => [
    category,
    { ...counts, accuracy: ratio(counts.correct, counts.total) },
  ]));
  const categoryAccuracies = Object.values(perCategory).map(({ accuracy }) => accuracy);

  const metrics = {
    total,
    domainAccuracy: ratio(domainCorrectCount, total),
    completeControlIntentAccuracy: ratio(completeIntentCorrectCount, completeControlRuns.length),
    completeControlRequiredSlotAccuracy: ratio(completeRequiredSlotCorrectCount, completeControlRuns.length),
    falseVehicleWriteCount,
    falseVehicleWriteRate: ratio(falseVehicleWriteCount, zeroWriteRuns.length),
    keyChatFalseClarificationCount,
    keyChatFalseClarificationRate: ratio(keyChatFalseClarificationCount, keyChatRuns.length),
    contractInvalidCount: runs.filter(({ status }) => status === "invalid-json" || status === "contract-invalid").length,
    invalidJsonCount: runs.filter(({ status }) => status === "invalid-json").length,
    timeoutCount: runs.filter(({ status }) => status === "timeout").length,
    generationErrorCount: runs.filter(({ status }) => status === "generation-error").length,
    semanticAccuracy: ratio(semanticCorrect.filter(Boolean).length, total),
    macroSemanticAccuracy: ratio(categoryAccuracies.reduce((sum, value) => sum + value, 0), categoryAccuracies.length),
    perCategory,
    p50Ms: nearestRank(latencies, 0.5),
    p95Ms: nearestRank(latencies, 0.95),
  };
  return { ...metrics, gatesPassed: evaluateVehicleSluEligibility(metrics).eligible };
}

export function evaluateVehicleSluEligibility(metrics) {
  const gates = {
    zeroFalseVehicleWrites: metrics?.falseVehicleWriteCount === 0,
    zeroKeyChatFalseClarifications: metrics?.keyChatFalseClarificationCount === 0,
    domainAccuracy: finiteAtLeast(metrics?.domainAccuracy, 0.95),
    completeControlIntentAccuracy: finiteAtLeast(metrics?.completeControlIntentAccuracy, 0.95),
    completeControlRequiredSlotAccuracy: finiteAtLeast(metrics?.completeControlRequiredSlotAccuracy, 0.95),
    p50Latency: finiteAtMost(metrics?.p50Ms, 1_000),
    p95Latency: finiteAtMost(metrics?.p95Ms, 2_000),
  };
  return { eligible: Object.values(gates).every(Boolean), gates };
}

export function selectVehicleSluModel({ baseline, candidate }) {
  assertModelResult(baseline, "baseline");
  assertModelResult(candidate, "candidate");
  const baselineEligible = evaluateVehicleSluEligibility(baseline.metrics).eligible;
  const candidateEligible = evaluateVehicleSluEligibility(candidate.metrics).eligible;
  const macroImprovement = candidate.metrics.macroSemanticAccuracy - baseline.metrics.macroSemanticAccuracy;
  const p95Improvement = baseline.metrics.p95Ms > 0
    ? (baseline.metrics.p95Ms - candidate.metrics.p95Ms) / baseline.metrics.p95Ms
    : 0;
  const macroBenefit = macroImprovement + Number.EPSILON >= 0.02;
  const p95Benefit = p95Improvement + Number.EPSILON >= 0.15;
  const materialBenefit = macroBenefit || p95Benefit;
  const safetyRegression = candidate.metrics.falseVehicleWriteCount > baseline.metrics.falseVehicleWriteCount
    || candidate.metrics.keyChatFalseClarificationCount > baseline.metrics.keyChatFalseClarificationCount;
  const semanticRegression = [
    "domainAccuracy",
    "completeControlIntentAccuracy",
    "completeControlRequiredSlotAccuracy",
  ].some((field) => candidate.metrics[field] < baseline.metrics[field]);

  if (materialBenefit && safetyRegression) {
    return retentionDecision(baseline, baselineEligible, "safety-gate-regression");
  }
  if (materialBenefit && semanticRegression) {
    return retentionDecision(baseline, baselineEligible, "semantic-gate-regression");
  }

  if (candidateEligible && macroBenefit) {
    return productionDecision(candidate.model, "replace-baseline", "macro-semantic-improvement");
  }
  if (candidateEligible && p95Benefit) {
    return productionDecision(candidate.model, "replace-baseline", "p95-latency-improvement");
  }
  if (baselineEligible) {
    return productionDecision(baseline.model, "retain-baseline", "no-material-benefit");
  }
  if (candidateEligible) {
    return {
      selectedModel: baseline.model,
      productionQualified: false,
      decision: "retain-baseline",
      reason: "candidate-no-material-benefit",
    };
  }

  const selected = saferDevelopmentResult(baseline, candidate);
  return {
    selectedModel: selected.model,
    productionQualified: false,
    decision: "development-only",
    reason: selected.metrics.falseVehicleWriteCount === 0
      ? "neither-eligible-safer-zero-false-write"
      : "neither-eligible-fewest-false-writes",
  };
}

export function validateVehicleSluFixture(fixture, { diagnostic = false, diagnosticAll = false } = {}) {
  if (typeof diagnostic !== "boolean") throw new TypeError("diagnostic must be a boolean");
  if (typeof diagnosticAll !== "boolean" || (diagnosticAll && !diagnostic)) {
    throw new TypeError("diagnosticAll requires diagnostic mode");
  }
  if (!isRecord(fixture)) throw new TypeError("fixture must be an object");
  assertExactKeys(fixture, ["contractVersion", "datasetVersion", "split", "cases"], "fixture");
  if (fixture.contractVersion !== VEHICLE_SLU_CONTRACT.ref) throw new TypeError("invalid fixture contractVersion");
  if (fixture.datasetVersion !== FIXTURE_VERSION) throw new TypeError("invalid fixture datasetVersion");
  if (fixture.split !== "acceptance") throw new TypeError("invalid fixture split");
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== FIXED_FIXTURE_CASE_COUNT) {
    throw new TypeError(`fixture must contain exactly ${FIXED_FIXTURE_CASE_COUNT} cases`);
  }

  const counts = Object.fromEntries(Object.keys(FIXED_FIXTURE_CATEGORIES).map((category) => [category, 0]));
  const idsByCategory = Object.fromEntries(Object.keys(FIXED_FIXTURE_CATEGORIES).map((category) => [category, []]));
  for (const entry of fixture.cases) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) throw new TypeError("invalid fixture case id");
    if (!Object.hasOwn(FIXED_FIXTURE_CATEGORIES, entry.category)) {
      throw new TypeError(`unknown fixture category: ${String(entry.category)}`);
    }
    counts[entry.category] += 1;
    idsByCategory[entry.category].push(entry.id);
  }
  const expectedCounts = Object.fromEntries(Object.entries(FIXED_FIXTURE_CATEGORIES)
    .map(([category, { count }]) => [category, count]));
  if (!isDeepStrictEqual(counts, expectedCounts)) throw new TypeError("fixture does not match frozen category counts");
  for (const [category, { count, idPrefix }] of Object.entries(FIXED_FIXTURE_CATEGORIES)) {
    const expectedIds = Array.from({ length: count }, (_, index) => `${idPrefix}-${String(index + 1).padStart(3, "0")}`);
    if (!isDeepStrictEqual([...idsByCategory[category]].sort(), expectedIds)) {
      throw new TypeError(`${category}: fixture does not match frozen ID range`);
    }
  }

  const ids = new Set();
  const texts = new Set();
  for (const entry of fixture.cases) {
    assertExactKeys(entry, ["id", "category", "text", "expected"], "case");
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) throw new TypeError("invalid fixture case id");
    if (ids.has(entry.id)) throw new TypeError(`duplicate fixture case id: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.category !== "string" || !entry.category) throw new TypeError(`${entry.id}: invalid category`);
    if (typeof entry.text !== "string" || !entry.text.trim()) throw new TypeError(`${entry.id}: invalid text`);
    const normalizedText = normalizeText(entry.text);
    if (texts.has(normalizedText)) throw new TypeError(`${entry.id}: duplicate normalized text`);
    texts.add(normalizedText);
    if (!isRecord(entry.expected)) throw new TypeError(`${entry.id}: invalid expected result`);
    assertExactKeys(entry.expected, ["semanticEnvelope", "routeId", "disposition", "vehicleWriteCount"], "expected");
    const expectedEnvelope = createVehicleSluEnvelope(entry.expected.semanticEnvelope);
    if (expectedEnvelope.requestId !== `fixture:${entry.id}`) throw new TypeError(`${entry.id}: unstable requestId`);
    if (![0, 1].includes(entry.expected.vehicleWriteCount)) throw new TypeError(`${entry.id}: invalid vehicleWriteCount`);
    if (!diagnostic) validateFixtureCategoryMatrix(entry, expectedEnvelope);
  }
  if (diagnostic) {
    selectDiagnosticCases(fixture.cases, { allContractValid: diagnosticAll });
  }
  const safetyRejectFrames = fixture.cases.flatMap((entry) => entry.expected.semanticEnvelope.vehicleFrames
    .filter((frame) => frame.intent === "safety.reject")
    .map((frame) => ({ entry, frame })));
  if (safetyRejectFrames.length !== 1) {
    throw new TypeError("fixture must contain exactly one safety.reject frame");
  }
  const protectedCase = safetyRejectFrames[0].entry;
  if (protectedCase.category !== "non-execution"
    || protectedCase.expected.routeId !== null
    || protectedCase.expected.disposition !== "respond"
    || protectedCase.expected.vehicleWriteCount !== 0) {
    throw new TypeError("safety.reject must use the canonical non-execution outcome");
  }
  return fixture;
}

function validateFixtureCategoryMatrix(entry, envelope) {
  const { id, category, expected } = entry;
  const frames = envelope.vehicleFrames;
  fixtureAssert(envelope.conversationGoal.need === expectedConversationNeed(entry),
    `${id}: category conversation need`);
  const oneFrame = () => fixtureAssert(frames.length === 1, `${id}: category requires exactly one vehicle frame`);
  const completeControlFrames = frames.filter((frame) => frame.capability === "control"
    && frame.actionNeed === "execute" && isVehicleControlIntent(frame.intent) && hasCanonicalRequiredControlSlots(frame));

  if (KEY_CHAT_CATEGORIES.has(category)) {
    fixtureAssert(envelope.domain === "non_vehicle" && frames.length === 0, `${id}: chat semantic shape`);
    fixtureOutcome(entry, "chat", "execute", 0, "chat");
    return;
  }
  fixtureAssert(envelope.domain === "vehicle", `${id}: vehicle category domain`);

  if (category === "vehicle-knowledge") {
    oneFrame();
    fixtureAssert(frames[0].capability === "knowledge" && frames[0].speechAct === "question"
      && frames[0].actionNeed === "none"
      && ["vehicle.knowledge.query", "vehicle.state.query"].includes(frames[0].intent), `${id}: knowledge frame`);
    fixtureAssert(frames[0].knowledgeNeed === (frames[0].intent === "vehicle.knowledge.query" ? "manual" : "none"),
      `${id}: knowledge need`);
    fixtureOutcome(entry, "vehicle-knowledge", "execute", 0, "knowledge");
  } else if (category === "complete-control") {
    oneFrame();
    fixtureAssert(frames[0].capability === "control" && frames[0].speechAct === "command"
      && frames[0].actionNeed === "execute"
      && isVehicleControlIntent(frames[0].intent) && hasCanonicalRequiredControlSlots(frames[0]), `${id}: complete-control frame`);
    fixtureOutcome(entry, "vehicle-control", "execute", 1, "complete-control");
  } else if (category === "incomplete-control") {
    oneFrame();
    fixtureAssert(frames[0].capability === "control" && frames[0].speechAct === "command"
      && frames[0].actionNeed === "clarify"
      && isVehicleControlIntent(frames[0].intent) && hasCanonicalIncompleteControlSlots(frames[0]), `${id}: incomplete-control frame`);
    fixtureOutcome(entry, null, "clarify", 0, "incomplete-control");
  } else if (category === "vehicle-services") {
    oneFrame();
    const frame = frames[0];
    fixtureAssert(["weather", "navigation", "media", "phone"].includes(frame.capability), `${id}: vehicle service frame`);
    if (frame.capability === "weather") {
      fixtureAssert(frame.intent === "weather.query" && frame.speechAct === "question"
        && frame.actionNeed === "none", `${id}: weather service frame`);
      fixtureOutcome(entry, "task", "execute", 0, "weather service");
    } else {
      fixtureAssert(frame.speechAct === "command" && frame.actionNeed === "execute",
        `${id}: deferred service action need`);
      fixtureOutcome(entry, null, "respond", 0, "deferred service");
    }
  } else if (category === "non-execution") {
    oneFrame();
    const frame = frames[0];
    fixtureAssert(frame.speechAct === NON_EXECUTION_SPEECH_ACTS[id]
      && frame.actionNeed === "none", `${id}: non-execution shape`);
    if (frame.intent === "safety.reject") fixtureOutcome(entry, null, "respond", 0, "protected safety");
    else if (frame.capability === "control" && isVehicleControlIntent(frame.intent)) {
      fixtureOutcome(entry, "chat", "execute", 0, "non-executing control");
    } else if (frame.capability === "knowledge"
      && ["vehicle.knowledge.query", "vehicle.state.query"].includes(frame.intent)) {
      fixtureOutcome(entry, "vehicle-knowledge", "execute", 0, "non-execution knowledge");
    } else if (["navigation", "media", "phone"].includes(frame.capability)) {
      fixtureOutcome(entry, null, "respond", 0, "deferred non-execution service");
    } else fixtureAssert(false, `${id}: non-execution frame`);
  } else if (category === "mixed-multi-intent") {
    fixtureAssert(frames.length > 0, `${id}: mixed frames`);
    for (const frame of frames) {
      if (frame.capability === "control") {
        fixtureAssert(frame.actionNeed === "execute" && frame.speechAct === "command"
          && isVehicleControlIntent(frame.intent)
          && hasCanonicalRequiredControlSlots(frame), `${id}: mixed control frame`);
      } else if (frame.capability === "knowledge") {
        fixtureAssert(frame.actionNeed === "none" && frame.speechAct === "question"
          && ["vehicle.knowledge.query", "vehicle.state.query"].includes(frame.intent), `${id}: mixed knowledge frame`);
      } else if (frame.capability === "weather") {
        fixtureAssert(frame.actionNeed === "none" && frame.speechAct === "question"
          && frame.intent === "weather.query", `${id}: mixed weather frame`);
      } else {
        fixtureAssert(["navigation", "media", "phone"].includes(frame.capability)
          && frame.actionNeed === "execute" && frame.speechAct === "command",
          `${id}: mixed deferred service frame`);
      }
    }
    const hasLocallySupportedFrame = frames.some((frame) => frame.capability === "knowledge"
      || frame.capability === "weather" || isVehicleControlIntent(frame.intent));
    fixtureOutcome(
      entry,
      hasLocallySupportedFrame ? "task" : null,
      hasLocallySupportedFrame ? "execute" : "respond",
      hasLocallySupportedFrame ? Math.min(1, completeControlFrames.length) : 0,
      "mixed",
    );
  }
}

function expectedConversationNeed(entry) {
  if (["chat-emotion", "mixed-multi-intent"].includes(entry.category)) return "social";
  if (["open-qa", "vehicle-knowledge", "non-execution"].includes(entry.category)) return "explain";
  return entry.expected.semanticEnvelope.vehicleFrames.some((frame) => frame.speechAct === "question")
    ? "explain"
    : "none";
}

function fixtureOutcome(entry, routeId, disposition, vehicleWriteCount, label) {
  const expected = entry.expected;
  fixtureAssert(expected.routeId === routeId
    && expected.disposition === disposition
    && expected.vehicleWriteCount === vehicleWriteCount, `${entry.id}: ${label} outcome`);
}

function hasCanonicalRequiredControlSlots(frame) {
  const required = VEHICLE_SLU_SLOT_SCHEMAS[frame.intent]?.required ?? [];
  const scoredKeys = controlSlotKeys(frame);
  return frame.actionNeed === "execute"
    && frame.missingSlots.length === 0
    && scoredKeys.length > 0
    && getMissingVehicleSluRequiredSlots(frame.intent, frame.slots).length === 0
    && (required.length > 0
      ? required.every((key) => canonicalControlSlotValue(frame.intent, key, frame.slots?.[key]))
      : DYNAMIC_CONTROL_SLOT_INTENTS.has(frame.intent));
}

function hasCanonicalIncompleteControlSlots(frame) {
  const required = VEHICLE_SLU_SLOT_SCHEMAS[frame.intent]?.required ?? [];
  const missing = getMissingVehicleSluRequiredSlots(frame.intent, frame.slots);
  return missing.length > 0
    && isDeepStrictEqual(frame.missingSlots, missing)
    && typeof frame.clarificationQuestion === "string"
    && frame.clarificationQuestion.trim().length > 0
    && required
    .filter((key) => !missing.includes(key))
    .every((key) => canonicalControlSlotValue(frame.intent, key, frame.slots[key]));
}

function canonicalControlSlotValue(intent, key, value) {
  if (intent === "body.window.setPosition" && key === "zone") {
    return ["front_left", "front_right", "rear_left", "rear_right"].includes(value);
  }
  if (intent === "body.window.setPosition" && key === "percent") {
    return Number.isFinite(value) && value >= 0 && value <= 100;
  }
  if (intent === "body.tailgate.open" && key === "open") return typeof value === "boolean";
  if (intent === "seat.driver.setBackrestAngle" && key === "seat") return value === "driver";
  if (intent === "seat.driver.setBackrestAngle" && key === "angle") return Number.isFinite(value);
  if (intent === "cabin.climate.setPreset" && key === "temperature") return Number.isFinite(value);
  return false;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isRecord(value) || !isDeepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort())) {
    throw new TypeError(`${label}: exact keys required`);
  }
}

function fixtureAssert(condition, message) {
  if (!condition) throw new TypeError(message);
}

export async function evaluateVehicleSluModels({
  models,
  fixture,
  diagnostic = false,
  diagnosticAll = false,
  baseUrl = process.env.NIO_OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  fetchImpl = globalThis.fetch,
  platformSummary = readPlatformSummary(),
} = {}) {
  validateVehicleSluFixture(fixture, { diagnostic, diagnosticAll });
  const diagnosticSelection = diagnostic
    ? selectDiagnosticCases(fixture.cases, { allContractValid: diagnosticAll })
    : null;
  const evaluationCases = diagnostic ? diagnosticSelection.cases : fixture.cases;
  const localBaseUrl = normalizeLocalOllamaBaseUrl(baseUrl);
  if (!Array.isArray(models) || models.length === 0 || models.some((model) => typeof model !== "string" || !model.trim())) {
    throw new TypeError("models must contain at least one model name");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  const modelResults = [];
  for (const requestedModel of models) {
    const model = requestedModel.trim();
    const profile = resolveVehicleSluEvaluationProfile(model);
    const modelMetadata = await readOllamaModelMetadata({ localBaseUrl, model, fetchImpl });
    const warmup = await warmupVehicleSluModel({
      localBaseUrl,
      model,
      profile,
      entry: evaluationCases[0],
      fetchImpl,
    });
    const runs = [];
    const metricRuns = [];
    for (let index = 0; index < evaluationCases.length; index += 1) {
      const entry = evaluationCases[index];
      const observation = await evaluateCase({
        localBaseUrl,
        model,
        entry,
        fetchImpl,
        coldWarm: "warm",
        profile,
      });
      runs.push(publicEvaluationRun(observation));
      metricRuns.push({ ...observation, expected: entry.expected });
    }
    modelResults.push({
      model,
      evaluationProfile: profile.id,
      promptVersion: profile.promptVersion,
      modelMetadata,
      warmup,
      runs,
      metrics: projectVehicleSluMetrics(metricRuns),
    });
  }

  return {
    evidenceLevel: diagnostic ? "diagnostic" : "qualification",
    ...(diagnostic ? {
      sampling: {
        strategy: diagnosticSelection.strategy,
        perCategory: diagnosticAll ? null : DIAGNOSTIC_SAMPLING.perCategory,
        caseCount: evaluationCases.length,
        caseIds: evaluationCases.map(({ id }) => id),
        excludedCases: diagnosticSelection.excludedCases,
      },
      decision: DIAGNOSTIC_DECISION,
    } : {}),
    fixture: {
      contractVersion: fixture.contractVersion,
      datasetVersion: fixture.datasetVersion,
      split: fixture.split,
      caseCount: fixture.cases.length,
    },
    platform: sanitizePlatformSummary(platformSummary),
    models: modelResults,
  };
}

async function warmupVehicleSluModel({ localBaseUrl, model, profile, entry, fetchImpl }) {
  const startedAt = performance.now();
  const generated = await postJson({
    url: `${localBaseUrl}/api/generate`,
    body: {
      model,
      prompt: profile.buildPrompt({ entry, requestId: "benchmark:warmup" }),
      ...(profile.system ? { system: profile.system } : {}),
      stream: false,
      keep_alive: "5m",
      format: profile.outputSchema,
      think: false,
      options: { ...profile.generationOptions, num_predict: 1 },
    },
    fetchImpl,
    timeoutMs: VEHICLE_SLU_MODEL_WARMUP_TIMEOUT_MS,
  });
  return {
    status: "ok",
    durationMs: roundedDuration(startedAt),
    keepAlive: "5m",
    ollamaDurations: sanitizeOllamaDurations(generated),
  };
}

function selectDiagnosticCases(cases, { allContractValid = false } = {}) {
  const counts = Object.fromEntries(Object.keys(FIXED_FIXTURE_CATEGORIES).map((category) => [category, 0]));
  const selected = [];
  const excludedCases = [];
  for (const entry of cases) {
    let envelope;
    try {
      envelope = createVehicleSluEnvelope(entry.expected.semanticEnvelope);
      validateFixtureCategoryMatrix(entry, envelope);
    } catch (error) {
      excludedCases.push({ caseId: entry.id, reason: error.message });
      continue;
    }
    if (allContractValid || counts[entry.category] < DIAGNOSTIC_SAMPLING.perCategory) {
      counts[entry.category] += 1;
      selected.push(entry);
    }
  }
  if (allContractValid && selected.length === 0) {
    throw new TypeError("diagnostic sample must contain contract-valid cases");
  }
  if (!allContractValid && (selected.length !== DIAGNOSTIC_SAMPLING.caseCount
    || Object.values(counts).some((count) => count !== DIAGNOSTIC_SAMPLING.perCategory))) {
    throw new TypeError("diagnostic sample must contain exactly two contract-valid cases from every frozen category");
  }
  return {
    cases: selected,
    excludedCases,
    strategy: allContractValid ? "all-contract-valid-cases" : DIAGNOSTIC_SAMPLING.strategy,
  };
}

async function evaluateCase({ localBaseUrl, model, entry, fetchImpl, coldWarm, profile }) {
  const requestId = `benchmark:${entry.id}`;
  const prompt = profile.buildPrompt({ entry, requestId });
  const startedAt = performance.now();
  try {
    const generated = await postJson({
      url: `${localBaseUrl}/api/generate`,
      body: {
        model,
        prompt,
        ...(profile.system ? { system: profile.system } : {}),
        stream: false,
        format: profile.outputSchema,
        think: false,
        options: profile.generationOptions,
      },
      fetchImpl,
      timeoutMs: VEHICLE_SLU_CASE_TIMEOUT_MS,
    });
    const base = publicCaseObservation(entry, coldWarm, startedAt, generated);
    let parsed;
    try {
      parsed = JSON.parse(generated?.response);
    } catch {
      return { ...base, status: "invalid-json", errorCode: "INVALID_JSON" };
    }
    try {
      const semanticEnvelope = profile.expand(parsed, { entry, requestId });
      if (semanticEnvelope.requestId !== requestId) {
        throw new TypeError("Vehicle-SLU response requestId mismatch");
      }
      return {
        ...base,
        status: "ok",
        semanticEnvelope,
      };
    } catch {
      return { ...base, status: "contract-invalid", errorCode: "CONTRACT_INVALID" };
    }
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.code === "CASE_TIMEOUT";
    return {
      caseId: entry.id,
      category: entry.category,
      coldWarm,
      latencyMs: roundedDuration(startedAt),
      status: timedOut ? "timeout" : "generation-error",
      errorCode: timedOut ? "TIMEOUT" : sanitizeErrorCode(error),
    };
  }
}

function resolveVehicleSluEvaluationProfile(model) {
  if (model === VEHICLE_SLU_COMPACT_MODEL) {
    return Object.freeze({
      id: VEHICLE_SLU_COMPACT_PROFILE,
      promptVersion: VEHICLE_SLU_COMPACT_PROMPT_VERSION,
      outputSchema: VEHICLE_SLU_COMPACT_OUTPUT_FORMAT,
      system: VEHICLE_SLU_COMPACT_SYSTEM,
      generationOptions: Object.freeze({ temperature: 0, num_predict: 512, num_ctx: 4096 }),
      buildPrompt: ({ entry }) => buildVehicleSluCompactV9Prompt({ text: entry.text }),
      expand: (value, { entry, requestId }) => expandVehicleSluCompact(value, {
        requestId,
        text: entry.text,
      }),
    });
  }
  return Object.freeze({
    id: "vehicle-slu-contract-v2",
    promptVersion: VEHICLE_SLU_PROMPT_VERSION,
    outputSchema: VEHICLE_SLU_OUTPUT_SCHEMA,
    system: null,
    generationOptions: Object.freeze({ temperature: 0, num_predict: 128 }),
    buildPrompt: ({ entry, requestId }) => buildVehicleSluPrompt({ text: entry.text, requestId }),
    expand: (value) => createVehicleSluEnvelope(value),
  });
}

async function readOllamaModelMetadata({ localBaseUrl, model, fetchImpl }) {
  try {
    const shown = await postJson({
      url: `${localBaseUrl}/api/show`,
      body: { model },
      fetchImpl,
      timeoutMs: VEHICLE_SLU_CASE_TIMEOUT_MS,
    });
    const details = isRecord(shown?.details) ? shown.details : {};
    return {
      format: safeString(details.format),
      family: safeString(details.family),
      families: Array.isArray(details.families) ? details.families.filter((entry) => typeof entry === "string") : [],
      parameterSize: safeString(details.parameter_size),
      quantizationLevel: safeString(details.quantization_level),
    };
  } catch (error) {
    return { errorCode: sanitizeErrorCode(error) };
  }
}

async function postJson({ url, body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response?.ok) {
      const error = new Error("local generation request failed");
      error.code = Number.isInteger(response?.status) ? `OLLAMA_HTTP_${response.status}` : "OLLAMA_HTTP_ERROR";
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("local generation deadline exceeded");
      timeoutError.name = "AbortError";
      timeoutError.code = "CASE_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function publicCaseObservation(entry, coldWarm, startedAt, generated) {
  return {
    caseId: entry.id,
    category: entry.category,
    coldWarm,
    latencyMs: roundedDuration(startedAt),
    ollamaDurations: sanitizeOllamaDurations(generated),
  };
}

function publicEvaluationRun(observation) {
  const { semanticEnvelope, ...safeObservation } = observation;
  if (!semanticEnvelope) return safeObservation;
  return {
    ...safeObservation,
    prediction: {
      contractVersion: semanticEnvelope.contractVersion,
      domain: semanticEnvelope.domain,
      conversationNeed: semanticEnvelope.conversationGoal.need,
      vehicleFrames: semanticEnvelope.vehicleFrames.map((entry) => ({
        capability: entry.capability,
        intent: entry.intent,
        speechAct: entry.speechAct,
        knowledgeNeed: entry.knowledgeNeed,
        actionNeed: entry.actionNeed,
        missingSlots: [...entry.missingSlots],
        clarificationQuestion: entry.clarificationQuestion,
        standaloneQuery: entry.standaloneQuery,
        slots: projectPublicVehicleSluSlots(entry.intent, entry.slots),
      })),
    },
  };
}

function projectPublicVehicleSluSlots(intent, slots) {
  const schema = VEHICLE_SLU_SLOT_SCHEMAS[intent];
  if (!schema || !isRecord(slots)) return {};
  const projected = {};
  for (const key of schema.allowed) {
    if (!Object.hasOwn(slots, key)) continue;
    const value = projectPublicVehicleSluSlotValue(key, slots[key]);
    if (value !== OMIT_PUBLIC_SLOT) projected[key] = value;
  }
  return projected;
}

function projectPublicVehicleSluSlotValue(key, value) {
  if (["query", "vehicleModel", "location", "timeRange", "origin", "destination", "contact"].includes(key)) {
    return typeof value === "string" ? value.slice(0, PUBLIC_SLOT_STRING_MAX_LENGTH) : OMIT_PUBLIC_SLOT;
  }
  if (key === "zone") {
    return ["front_left", "front_right", "rear_left", "rear_right"].includes(value)
      ? value : OMIT_PUBLIC_SLOT;
  }
  if (key === "seat") return value === "driver" ? value : OMIT_PUBLIC_SLOT;
  if (key === "percent") {
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : OMIT_PUBLIC_SLOT;
  }
  if (["angle", "temperature"].includes(key)) return Number.isFinite(value) ? value : OMIT_PUBLIC_SLOT;
  if (key === "open") return typeof value === "boolean" ? value : OMIT_PUBLIC_SLOT;
  if (key === "stateFields" && Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string" && PUBLIC_STATE_FIELD_SET.has(entry))
      .slice(0, PUBLIC_STATE_FIELDS_MAX_LENGTH);
  }
  return OMIT_PUBLIC_SLOT;
}

function sanitizeOllamaDurations(value) {
  const result = {};
  for (const [source, target] of Object.entries(OLLAMA_DURATION_FIELDS)) {
    if (Number.isFinite(value?.[source]) && value[source] >= 0) result[target] = Math.round(value[source]);
  }
  return result;
}

function canonicalSemanticEnvelope(value) {
  if (!isRecord(value)) return null;
  return {
    domain: value.domain,
    conversationNeed: value.conversationGoal?.need,
    vehicleFrames: Array.isArray(value.vehicleFrames) ? value.vehicleFrames.map((entry) => ({
      capability: entry.capability,
      intent: entry.intent,
      speechAct: entry.speechAct,
      knowledgeNeed: entry.knowledgeNeed,
      actionNeed: entry.actionNeed,
      slots: entry.slots,
      missingSlots: entry.missingSlots,
      clarificationQuestion: entry.clarificationQuestion,
      standaloneQuery: entry.standaloneQuery,
    })) : null,
  };
}

function hasExactControlIntents(entry) {
  if (entry?.status !== "ok") return false;
  const expectedFrames = supportedControlFrames(entry.expected?.semanticEnvelope);
  const actualFrames = supportedControlFrames(entry.semanticEnvelope);
  const expected = expectedFrames.map(({ intent }) => intent);
  const actual = actualFrames.map(({ intent }) => intent);
  return expected.length > 0
    && expectedFrames.every(({ actionNeed, missingSlots }) => actionNeed === "execute" && missingSlots.length === 0)
    && actualFrames.every(({ actionNeed, missingSlots }) => actionNeed === "execute" && missingSlots.length === 0)
    && isDeepStrictEqual(actual, expected);
}

function hasExactControlRequiredSlots(entry) {
  if (!hasExactControlIntents(entry)) return false;
  const expectedFrames = supportedControlFrames(entry.expected?.semanticEnvelope);
  const actualFrames = supportedControlFrames(entry.semanticEnvelope);
  return expectedFrames.every((expectedFrame, index) => {
    const scoredKeys = controlSlotKeys(expectedFrame);
    const expectedSlots = Object.fromEntries(scoredKeys.map((key) => [key, expectedFrame.slots?.[key]]));
    const actualSlots = Object.fromEntries(scoredKeys.map((key) => [key, actualFrames[index]?.slots?.[key]]));
    return scoredKeys.length > 0 && isDeepStrictEqual(actualSlots, expectedSlots);
  });
}

function controlSlotKeys(frame) {
  const schema = VEHICLE_SLU_SLOT_SCHEMAS[frame.intent];
  const required = schema?.required ?? [];
  if (required.length > 0) return required;
  if (!DYNAMIC_CONTROL_SLOT_INTENTS.has(frame.intent)) return [];
  return (schema?.allowed ?? []).filter((key) => (
    frame.slots?.[key] !== undefined && frame.slots?.[key] !== null && frame.slots?.[key] !== ""
  ));
}

function supportedControlFrames(envelope) {
  return Array.isArray(envelope?.vehicleFrames)
    ? envelope.vehicleFrames.filter((entry) => entry?.capability === "control" && isVehicleControlIntent(entry.intent))
    : [];
}

function hasVehicleWriteRequest(envelope) {
  return supportedControlFrames(envelope).some((entry) => entry.actionNeed === "execute"
    && entry.missingSlots.length === 0);
}

function hasVehicleControlClarification(envelope) {
  return envelope?.domain === "vehicle"
    && supportedControlFrames(envelope).some((entry) => entry.actionNeed === "clarify"
      && entry.missingSlots.length > 0);
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(percentile * ordered.length) - 1];
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function finiteAtLeast(value, minimum) {
  return Number.isFinite(value) && value >= minimum;
}

function finiteAtMost(value, maximum) {
  return Number.isFinite(value) && value <= maximum;
}

function assertModelResult(value, label) {
  if (!isRecord(value) || typeof value.model !== "string" || !isRecord(value.metrics)) {
    throw new TypeError(`${label} model result is invalid`);
  }
}

function productionDecision(selectedModel, decision, reason) {
  return { selectedModel, productionQualified: true, decision, reason };
}

function retentionDecision(baseline, productionQualified, reason) {
  return {
    selectedModel: baseline.model,
    productionQualified,
    decision: "retain-baseline",
    reason,
  };
}

function saferDevelopmentResult(baseline, candidate) {
  const score = (entry) => [
    entry.metrics.falseVehicleWriteCount === 0 ? 0 : 1,
    entry.metrics.falseVehicleWriteCount,
    entry.metrics.keyChatFalseClarificationCount,
  ];
  const baselineScore = score(baseline);
  const candidateScore = score(candidate);
  for (let index = 0; index < baselineScore.length; index += 1) {
    if (candidateScore[index] < baselineScore[index]) return candidate;
    if (candidateScore[index] > baselineScore[index]) return baseline;
  }
  return baseline;
}

function normalizeLocalOllamaBaseUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new TypeError("Vehicle-SLU evaluation requires a local Ollama HTTP endpoint");
  }
  return url.href.replace(/\/$/, "");
}

function readPlatformSummary() {
  const cpuList = cpus();
  return {
    platform: platform(),
    arch: arch(),
    cpuCount: cpuList.length,
    cpuModel: cpuList[0]?.model || "unknown",
  };
}

function sanitizePlatformSummary(value) {
  return {
    platform: safeString(value?.platform),
    arch: safeString(value?.arch),
    cpuCount: Number.isInteger(value?.cpuCount) && value.cpuCount >= 0 ? value.cpuCount : 0,
    cpuModel: safeString(value?.cpuModel),
  };
}

function safeString(value) {
  return typeof value === "string" ? value : "";
}

function sanitizeErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : "OLLAMA_GENERATION_FAILED";
}

function roundedDuration(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function normalizeText(text) {
  return text.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]/gu, "");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseVehicleSluEvaluatorArguments(argv);
  const fixturePath = resolve(options.fixture);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const evaluation = await evaluateVehicleSluModels({
    models: options.models,
    fixture,
    diagnostic: options.diagnostic,
    diagnosticAll: options.diagnosticAll,
  });
  const decision = evaluation.evidenceLevel === "diagnostic"
    ? evaluation.decision
    : evaluation.models.length === 2
      ? selectVehicleSluModel({ baseline: evaluation.models[0], candidate: evaluation.models[1] })
      : null;
  const createdAt = new Date().toISOString();
  const artifactDirectory = resolve("artifacts/vehicle-slu", createdAt.replace(/[:.]/g, "-"));
  const results = { createdAt, ...evaluation, decision };
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(resolve(artifactDirectory, "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  await writeFile(resolve(artifactDirectory, "summary.md"), buildVehicleSluEvaluationSummary(results), "utf8");
  console.log(`Vehicle-SLU evaluation written to ${artifactDirectory}`);
}

export function parseVehicleSluEvaluatorArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError("arguments must be an array");
  const values = new Map();
  let diagnostic = false;
  let diagnosticAll = false;
  for (let index = 0; index < argv.length;) {
    const key = argv[index];
    if (!["--models", "--fixture", "--diagnostic", "--diagnostic-all"].includes(key) || values.has(key)) {
      throw new TypeError("usage: --models model-a,model-b --fixture path/to/fixture.json [--diagnostic | --diagnostic-all]");
    }
    values.set(key, true);
    if (key === "--diagnostic" || key === "--diagnostic-all") {
      diagnostic = true;
      if (key === "--diagnostic-all") diagnosticAll = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new TypeError("usage: --models model-a,model-b --fixture path/to/fixture.json [--diagnostic | --diagnostic-all]");
    }
    values.set(key, value);
    index += 2;
  }
  const models = String(values.get("--models") || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const fixture = values.get("--fixture");
  if (models.length === 0 || !fixture) throw new TypeError("both --models and --fixture are required");
  return { models, fixture, diagnostic, diagnosticAll };
}

export function buildVehicleSluEvaluationSummary(results) {
  const lines = [
    "# Vehicle-SLU local model evaluation",
    "",
    `- Created: ${results.createdAt}`,
    `- Evidence: ${results.evidenceLevel}`,
    ...(results.evidenceLevel === "diagnostic"
      ? [`- Sample: ${results.sampling.caseCount}/${results.fixture.caseCount} cases (${results.sampling.strategy === "all-contract-valid-cases"
        ? "all contract-valid cases"
        : `first ${results.sampling.perCategory} contract-valid per category`})`]
      : []),
    ...(results.evidenceLevel === "diagnostic" && results.sampling.excludedCases.length > 0
      ? [`- Excluded stale labels: ${results.sampling.excludedCases.map(({ caseId }) => caseId).join(", ")}`]
      : []),
    `- Fixture: ${results.fixture.datasetVersion} (${results.fixture.caseCount} cases)`,
    `- Prompt profiles: ${results.models.map(({ model, evaluationProfile, promptVersion }) => (
      `${model}=${evaluationProfile} (${promptVersion})`
    )).join("; ")}`,
    `- Model warmup: ${results.models.map(({ model, warmup }) => (
      `${model} ${warmup?.status === "ok" ? `${warmup.durationMs} ms` : "failed"}`
    )).join("; ")} (full profile prompt and schema; excluded from case latency)`,
    "- Percentiles: nearest-rank over every measured case latency.",
    "",
    "| Model | Eligible | Domain | Control intent | Required slots | False writes | Chat clarifications | P50 | P95 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const entry of results.models) {
    const metrics = entry.metrics;
    const eligibility = results.evidenceLevel === "diagnostic" ? "n/a" : metrics.gatesPassed ? "yes" : "no";
    lines.push(`| ${entry.model} | ${eligibility} | ${percent(metrics.domainAccuracy)} | ${percent(metrics.completeControlIntentAccuracy)} | ${percent(metrics.completeControlRequiredSlotAccuracy)} | ${metrics.falseVehicleWriteCount} | ${metrics.keyChatFalseClarificationCount} | ${metrics.p50Ms ?? "n/a"} ms | ${metrics.p95Ms ?? "n/a"} ms |`);
  }
  if (results.decision) {
    const decisionLabel = results.evidenceLevel === "diagnostic"
      ? results.decision.decision
      : results.decision.selectedModel;
    lines.push("", `Decision: **${decisionLabel}** — ${results.decision.reason}.`);
  }
  return `${lines.join("\n")}\n`;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
