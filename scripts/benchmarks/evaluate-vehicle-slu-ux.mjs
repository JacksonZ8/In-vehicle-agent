#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { RoutePolicy } from "../../src/application/route-policy.js";
import { projectVehicleSluConversationContext } from "../../src/semantic/vehicle-slu-conversation-context.js";
import {
  expandVehicleSluCompact,
  VEHICLE_SLU_COMPACT_OUTPUT_FORMAT,
} from "../../src/semantic/vehicle-slu-compact.js";
import {
  buildVehicleSluCompactV9Prompt,
  VEHICLE_SLU_COMPACT_GENERATION_PROFILE,
  VEHICLE_SLU_COMPACT_PROMPT_VERSION,
  VEHICLE_SLU_COMPACT_SYSTEM,
} from "../../src/semantic/vehicle-slu-compact-v9.js";
import {
  VEHICLE_SLU_CONTRACT_VERSION,
  VEHICLE_SLU_DOMAINS,
  VEHICLE_SLU_ONTOLOGY,
} from "../../src/semantic/vehicle-slu-contract.js";

export const VEHICLE_SLU_UX_CASE_TIMEOUT_MS = 3_000;
export const VEHICLE_SLU_UX_WARMUP_TIMEOUT_MS = 120_000;
const VEHICLE_SLU_UX_KEEP_ALIVE = "5m";
const SERVICE_CAPABILITIES = new Set(["navigation", "media", "phone"]);
const CONTROL_INTENTS = new Set(VEHICLE_SLU_ONTOLOGY.control.executable);

export function validateVehicleSluUxFixture(fixture) {
  if (!isRecord(fixture)) throw new TypeError("fixture must be an object");
  if (fixture.contractVersion !== "vehicle-slu-ux@1.0.0") throw new TypeError("invalid UX contractVersion");
  if (typeof fixture.datasetVersion !== "string" || !fixture.datasetVersion.trim()) {
    throw new TypeError("datasetVersion is required");
  }
  if (!new Set(["development", "acceptance"]).has(fixture.split)) {
    throw new TypeError("split must be development or acceptance");
  }
  if (!new Set(["draft", "reviewed", "adjudicated"]).has(fixture.labelReviewStatus)) {
    throw new TypeError("fixture labelReviewStatus is invalid");
  }
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    throw new TypeError("fixture cases must be a non-empty array");
  }

  const ids = new Set();
  const utterances = new Set();
  for (const entry of fixture.cases) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
      throw new TypeError("every case requires an id");
    }
    if (ids.has(entry.id)) throw new TypeError(`duplicate case id: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.category !== "string" || !entry.category.trim()) {
      throw new TypeError(`${entry.id}: category is required`);
    }
    if (!new Set(["draft", "reviewed", "adjudicated"]).has(entry.labelReviewStatus)) {
      throw new TypeError(`${entry.id}: invalid labelReviewStatus`);
    }
    if (!isRecord(entry.source)
      || typeof entry.source.author !== "string"
      || typeof entry.source.method !== "string"
      || typeof entry.source.secondReviewer !== "string") {
      throw new TypeError(`${entry.id}: source authoring/review record is required`);
    }
    const minimumTurnCount = entry.partialCompletionRequired === true ? 1 : 2;
    if (!Array.isArray(entry.turns) || entry.turns.length < minimumTurnCount) {
      throw new TypeError(`${entry.id}: UX cases must contain at least ${minimumTurnCount} turn(s)`);
    }
    if (entry.closureRequired && (!Number.isInteger(entry.closureTurn)
      || entry.closureTurn < 2 || entry.closureTurn > entry.turns.length)) {
      throw new TypeError(`${entry.id}: closureTurn must be a one-based turn after the clarification`);
    }

    for (const [turnIndex, turn] of entry.turns.entries()) {
      if (!isRecord(turn) || typeof turn.text !== "string" || !turn.text.trim()) {
        throw new TypeError(`${entry.id}: turn ${turnIndex + 1} requires text`);
      }
      const normalized = normalizeText(turn.text);
      if (utterances.has(normalized)) throw new TypeError(`${entry.id}: duplicate normalized utterance`);
      utterances.add(normalized);
      validateExpectedTurn(entry.id, turnIndex, turn.expected);
      if (turn.answeredSlots !== undefined
        && (!Array.isArray(turn.answeredSlots)
          || turn.answeredSlots.some((slot) => typeof slot !== "string" || !slot.trim()))) {
        throw new TypeError(`${entry.id}: turn ${turnIndex + 1} answeredSlots must be strings`);
      }
    }
  }

  if (fixture.split === "acceptance"
    && (fixture.cases.some((entry) => entry.labelReviewStatus !== "adjudicated")
      || fixture.labelReviewStatus !== "adjudicated")) {
    throw new TypeError("acceptance fixture requires adjudicated labels for every case");
  }
  return fixture;
}

function validateExpectedTurn(caseId, turnIndex, expected) {
  if (!isRecord(expected) || !VEHICLE_SLU_DOMAINS.includes(expected.domain)
    || !["none", "social", "explain"].includes(expected.conversationNeed)
    || !Array.isArray(expected.frames)
    || !isRecord(expected.route)
    || !["execute", "clarify", "respond", "cancel"].includes(expected.route.disposition)
    || !(expected.route.routeId === null || typeof expected.route.routeId === "string")) {
    throw new TypeError(`${caseId}: turn ${turnIndex + 1} has an invalid expectation`);
  }
  if (expected.route.disposition === "execute"
    ? !new Set(["chat", "vehicle-knowledge", "vehicle-control", "task"]).has(expected.route.routeId)
    : expected.route.routeId !== null) {
    throw new TypeError(`${caseId}: turn ${turnIndex + 1} has an invalid expected route: execute selects a supported use case; terminal routes require routeId:null`);
  }
  for (const frame of expected.frames) {
    if (!isRecord(frame)
      || typeof frame.intent !== "string"
      || !["execute", "clarify", "none"].includes(frame.actionNeed)
      || !isRecord(frame.slots)
      || !Array.isArray(frame.missingSlots)) {
      throw new TypeError(`${caseId}: turn ${turnIndex + 1} has an invalid expected frame`);
    }
    if (frame.missingSlots.some((slot) => typeof slot !== "string" || !slot.trim())) {
      throw new TypeError(`${caseId}: turn ${turnIndex + 1} has an invalid missing slot`);
    }
  }
  const effectiveFrames = expected.effectiveFrames ?? expected.frames;
  if (!Array.isArray(effectiveFrames)) throw new TypeError(`${caseId}: effectiveFrames must be an array`);
  for (const frame of effectiveFrames) {
    if (!isRecord(frame)
      || typeof frame.intent !== "string"
      || !["execute", "clarify", "none"].includes(frame.actionNeed)
      || !isRecord(frame.slots)
      || !Array.isArray(frame.missingSlots)) {
      throw new TypeError(`${caseId}: turn ${turnIndex + 1} has an invalid effective frame`);
    }
  }
  validateCompactTarget(expected, expected.frames, caseId, turnIndex, "model");
  validateCompactTarget(expected, effectiveFrames, caseId, turnIndex, "effective");
}

function validateCompactTarget(expected, frames, caseId, turnIndex, label) {
  const expanded = expandVehicleSluCompact({
    d: expected.domain,
    n: expected.conversationNeed,
    ...(Object.hasOwn(expected, "dialogueAction") ? { c: expected.dialogueAction } : {}),
    f: frames.map((frame) => ({
      i: frame.intent,
      s: frame.speechAct || (isReadonlyIntent(frame.intent) ? "question" : "command"),
      a: frame.actionNeed,
      p: frame.slots,
      ...(frame.intent === "vehicle.knowledge.query" ? { k: "manual" } : {}),
    })),
  }, { requestId: `fixture:${caseId}:${turnIndex + 1}:${label}` });
  for (const [frameIndex, expectedFrame] of frames.entries()) {
    const expandedFrame = expanded.vehicleFrames[frameIndex];
    if (JSON.stringify(expandedFrame.missingSlots) !== JSON.stringify(expectedFrame.missingSlots)) {
      throw new TypeError(`${caseId}: turn ${turnIndex + 1} ${label} missingSlots disagree with the contract`);
    }
  }
}

function isReadonlyIntent(intent) {
  return intent === "vehicle.knowledge.query"
    || intent === "vehicle.state.query"
    || intent === "weather.query";
}

function isSingleCompleteWindowRoute(route) {
  const frames = route.semanticEnvelope?.vehicleFrames;
  return route.decision.routeId === "vehicle-control"
    && frames?.length === 1
    && frames[0].intent === "body.window.setPosition"
    && frames[0].actionNeed === "execute";
}

// Recalculate scores from saved observations without generating or changing turn evidence.
export function rescoreVehicleSluUxCases(cases) {
  if (!Array.isArray(cases)) throw new TypeError("cases must be an array");
  return cases.map((entry) => ({ ...entry, result: scoreConversationCase(entry) }));
}

export function projectVehicleSluUxMetrics(cases) {
  if (!Array.isArray(cases)) throw new TypeError("cases must be an array");
  const turns = cases.flatMap((entry) => entry.turns || []);
  const caseResults = cases.map((entry) => entry.result || {});
  const expectedFrames = turns.flatMap((turn) => scoredExpectedFrames(turn));
  const unrequestedVehicleWriteCount = turns.reduce((total, turn) => total
    + countUnrequestedFrames(turn.result?.rawFrames, expectedRequestedFrames(turn), isVehicleWrite), 0);
  const vehicleExecuteTargetMismatchCount = turns.reduce((total, turn) => total
    + countRequestedTargetMismatchFrames(turn.result?.rawFrames, expectedRequestedFrames(turn), isVehicleWrite), 0);
  const unrequestedServiceExecutionCount = turns.reduce((total, turn) => total
    + countUnrequestedFrames(turn.result?.rawFrames, expectedRequestedFrames(turn), isServiceExecution), 0);
  const serviceExecuteTargetMismatchCount = turns.reduce((total, turn) => total
    + countRequestedTargetMismatchFrames(turn.result?.rawFrames, expectedRequestedFrames(turn), isServiceExecution), 0);
  const repeatedClarificationCount = turns.reduce((total, turn) => {
    const answered = new Set(turn.answeredSlots || []);
    return total + (turn.result?.effectiveFrames || []).reduce((count, frame) => (
      count + (frame.actionNeed === "clarify"
        ? frame.missingSlots.filter((slot) => answered.has(slot)).length
        : 0)
    ), 0);
  }, 0);
  const expectedNoClarificationTurns = turns.filter((turn) => (
    expectedRoute(turn).disposition !== "clarify"
    && !scoredExpectedFrames(turn).some((frame) => frame.actionNeed === "clarify")
  ));
  const overClarificationTurns = expectedNoClarificationTurns.filter((turn) => (
    turn.result?.route?.disposition === "clarify"
    || (turn.result?.effectiveFrames || []).some((frame) => frame.actionNeed === "clarify")
  ));
  const closureCases = cases.filter((entry) => entry.closureRequired === true);
  const closureSuccessCount = closureCases.filter((entry) => entry.result?.clarificationClosed === true).length;
  const mixedCases = cases.filter((entry) => entry.partialCompletionRequired === true);
  const mixedPartialSuccessCount = mixedCases.filter((entry) => entry.result?.allEffectiveOutcomesMatched === true
    && entry.result?.unrequestedVehicleWriteCount === 0
    && entry.result?.unrequestedServiceExecutionCount === 0).length;
  const captureCount = turns.filter((turn) => isTurnIntentCaptured(turn)).length;
  const preRouteCaptureCount = turns.filter((turn) => isPreRouteIntentCaptured(turn)).length;
  const modelTurns = turns.filter((turn) => Number(turn.result?.modelInvocations) > 0);
  const modelExpectedFrames = modelTurns.flatMap((turn) => turn.expected?.frames || []);
  const modelCaptureCount = modelTurns.filter((turn) => isPreRouteIntentCaptured(turn)).length;
  const rawFrameCount = turns.reduce((total, turn) => total
    + countMatchedSemanticFrames(turn.expected?.frames, turn.result?.rawFrames), 0);
  const modelRawFrameCount = modelTurns.reduce((total, turn) => total
    + countMatchedSemanticFrames(turn.expected?.frames, turn.result?.rawFrames), 0);
  const effectiveFrameCount = turns.reduce((total, turn) => total
    + countMatchedSemanticFrames(scoredExpectedFrames(turn), turn.result?.effectiveFrames), 0);
  const unexpectedFrameCount = turns.reduce((total, turn) => total
    + countUnmatchedActualFrames(scoredExpectedFrames(turn), turn.result?.rawFrames), 0);
  const routeDecisionMatches = turns.filter((turn) => turn.result?.route?.disposition === expectedRoute(turn).disposition
    && turn.result?.route?.routeId === expectedRoute(turn).routeId).length;
  const latencyMs = turns.map((turn) => turn.result?.latencyMs)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const modelLatencyMs = modelTurns.map((turn) => turn.result?.latencyMs)
    .filter((value) => Number.isFinite(value) && value >= 0);

  return {
    conversationCaseCount: cases.length,
    turnCount: turns.length,
    intentCapture: metric(captureCount, turns.length),
    preRouteIntentCapture: metric(preRouteCaptureCount, turns.length),
    modelIntentCapture: metric(modelCaptureCount, modelTurns.length),
    modelInvocationCount: modelTurns.reduce((total, turn) => total + Number(turn.result.modelInvocations), 0),
    modelFailureTurnCount: modelTurns.filter((turn) => turn.result?.status !== "ok").length,
    semanticFrameMatch: metric(effectiveFrameCount, expectedFrames.length),
    preRouteSemanticFrameMatch: metric(rawFrameCount, expectedFrames.length),
    modelRawSemanticFrameMatch: metric(modelRawFrameCount, modelExpectedFrames.length),
    unexpectedFrameCount,
    routeDecisionAccuracy: metric(routeDecisionMatches, turns.length),
    necessaryClarificationClosure: metric(closureSuccessCount, closureCases.length),
    unnecessaryClarificationTurns: metric(overClarificationTurns.length, expectedNoClarificationTurns.length),
    repeatedClarificationCount,
    unrequestedVehicleWriteCount,
    vehicleExecuteTargetMismatchCount,
    vehicleWriteSafetyViolationCount: unrequestedVehicleWriteCount + vehicleExecuteTargetMismatchCount,
    unrequestedServiceExecutionCount,
    serviceExecuteTargetMismatchCount,
    mixedTaskPartialCompletion: metric(mixedPartialSuccessCount, mixedCases.length),
    parserRouteClosure: metric(caseResults.filter((entry) => entry.parserRouteClosed === true).length, cases.length),
    userVisibleResponseQuality: "not-measured: parser-only replay does not run chat/knowledge answer generation",
    p50Ms: nearestRank(latencyMs, 0.5),
    p95Ms: nearestRank(latencyMs, 0.95),
    modelP50Ms: nearestRank(modelLatencyMs, 0.5),
    modelP95Ms: nearestRank(modelLatencyMs, 0.95),
    failureCaseIds: cases.filter((entry) => entry.result?.allExpectedFramesMatched !== true).map((entry) => entry.id),
  };
}

export async function auditVehicleSluUxRouteCompatibility(fixture) {
  validateVehicleSluUxFixture(fixture);
  const gaps = [];
  let compatibleTurnCount = 0;
  for (const entry of fixture.cases) {
    let pending = null;
    let lastVehicleIntent = "";
    let lastVehicleQuery = "";
    for (const [turnIndex, turn] of entry.turns.entries()) {
      const requestId = `vehicle-slu-ux-route-audit:${entry.id}:${turnIndex + 1}`;
      const semanticEnvelope = expandExpectedEnvelope(turn.expected, requestId, turn.text);
      const routePolicy = new RoutePolicy({
        localModel: { parse: async () => ({ semanticEnvelope, telemetry: { model: "fixture-expectation" } }) },
      });
      const route = await routePolicy.resolve(turn.text, {
        requestId,
        runId: requestId,
        pending,
        lastVehicleIntent,
        lastVehicleQuery,
      });
      const effectiveTargets = turn.expected.effectiveFrames ?? turn.expected.frames;
      const framesMatch = countMatchedSemanticFrames(effectiveTargets, route.semanticEnvelope?.vehicleFrames || [])
        === effectiveTargets.length
        && (route.semanticEnvelope?.vehicleFrames || []).length === effectiveTargets.length;
      const routeMatches = route.decision.disposition === turn.expected.route.disposition
        && route.decision.routeId === turn.expected.route.routeId;
      if (framesMatch && routeMatches) compatibleTurnCount += 1;
      else gaps.push({
        caseId: entry.id,
        turnId: turn.id || `turn-${turnIndex + 1}`,
        expectedRoute: turn.expected.route,
        actualRoute: { disposition: route.decision.disposition, routeId: route.decision.routeId },
        expectedEffectiveFrames: effectiveTargets,
        actualEffectiveFrames: route.semanticEnvelope?.vehicleFrames || [],
        routeMatches,
        framesMatch,
        clarificationAction: route.clarificationTransition?.action || null,
        clarificationReasonCode: route.clarificationTransition?.reasonCode || null,
      });
      pending = advancePendingClarification(pending, route.clarificationTransition, {
        requestId,
        utterance: turn.text,
      });
      const knowledgeFrame = route.semanticEnvelope?.vehicleFrames.find((frame) => frame.intent === "vehicle.knowledge.query");
      if (route.decision.routeId === "vehicle-knowledge" && knowledgeFrame) {
        lastVehicleIntent = knowledgeFrame.intent;
        lastVehicleQuery = knowledgeFrame.slots.query || "";
      } else if (isSingleCompleteWindowRoute(route)) {
        lastVehicleIntent = "body.window.setPosition";
        lastVehicleQuery = "";
      } else if (route.semanticEnvelope) {
        lastVehicleIntent = "";
        lastVehicleQuery = "";
      }
    }
  }
  const turnCount = fixture.cases.reduce((total, entry) => total + entry.turns.length, 0);
  return { turnCount, compatibleTurnCount, gapCount: gaps.length, gaps };
}

function expandExpectedEnvelope(expected, requestId, text) {
  return expandVehicleSluCompact({
    d: expected.domain,
    n: expected.conversationNeed,
    ...(Object.hasOwn(expected, "dialogueAction") ? { c: expected.dialogueAction } : {}),
    f: expected.frames.map((frame) => ({
      i: frame.intent,
      s: frame.speechAct || (isReadonlyIntent(frame.intent) ? "question" : "command"),
      a: frame.actionNeed,
      p: frame.slots,
      ...(frame.intent === "vehicle.knowledge.query" ? { k: "manual" } : {}),
    })),
  }, { requestId, text });
}

export async function evaluateVehicleSluUx({
  fixture,
  models,
  baseUrl = process.env.NIO_OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  fetchImpl = globalThis.fetch,
  rawModelDiagnostic = false,
} = {}) {
  validateVehicleSluUxFixture(fixture);
  if (typeof rawModelDiagnostic !== "boolean") throw new TypeError("rawModelDiagnostic must be a boolean");
  if (rawModelDiagnostic && (fixture.split !== "development"
    || fixture.datasetVersion !== "vehicle-slu-ux-user-reviewed-development@0.3.0"
    || fixture.labelReviewStatus !== "reviewed")) {
    throw new TypeError("raw-model diagnostic is restricted to reviewed development@0.3.0 fixtures");
  }
  if (!Array.isArray(models) || !models.length || models.some((model) => typeof model !== "string" || !model.trim())) {
    throw new TypeError("models must contain at least one model name");
  }
  const localBaseUrl = normalizeLocalOllamaBaseUrl(baseUrl);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const routeCompatibility = await auditVehicleSluUxRouteCompatibility(fixture);
  const modelResults = [];
  const runtime = await readOllamaRuntimeMetadata(localBaseUrl, fetchImpl);

  for (const requestedModel of models) {
    const model = requestedModel.trim();
    const modelIdentity = await readOllamaModelIdentity(localBaseUrl, model, fetchImpl);
    const warmup = await warmupOllamaModel({ baseUrl: localBaseUrl, model, fetchImpl });
    const resultCases = [];
    for (const fixtureCase of fixture.cases) {
      const caseTrace = { ...fixtureCase, turns: [] };
      let pending = null;
      let lastVehicleIntent = "";
      let lastVehicleQuery = "";
      let conversationContext = null;
      for (const [turnIndex, fixtureTurn] of fixtureCase.turns.entries()) {
        const requestId = `vehicle-slu-ux:${fixtureCase.id}:${turnIndex + 1}`;
        const pendingBefore = Boolean(pending);
        const observation = await evaluateTurn({
          baseUrl: localBaseUrl,
          model,
          requestId,
          fixtureCase,
          fixtureTurn,
          turnIndex,
          pending,
          lastVehicleIntent,
          lastVehicleQuery,
          conversationContext,
          fetchImpl,
        });
        caseTrace.turns.push({
          turnId: fixtureTurn.id || `turn-${turnIndex + 1}`,
          text: fixtureTurn.text,
          answeredSlots: fixtureTurn.answeredSlots || [],
          pendingBefore,
          expected: fixtureTurn.expected,
          result: observation,
        });
        pending = advancePendingClarification(pending, observation.route?.clarificationTransition, {
          requestId,
          utterance: fixtureTurn.text,
        });
        conversationContext = observation.status === "ok" && observation.route?.disposition === "execute"
          ? projectVehicleSluConversationContext({
            frames: (observation.effectiveFrames || []).map(({ intent, slots }) => ({ intent, slots })),
          })
          : null;
        const knowledgeFrame = observation.effectiveFrames?.find((frame) => frame.intent === "vehicle.knowledge.query");
        if (observation.route?.routeId === "vehicle-knowledge" && knowledgeFrame) {
          lastVehicleIntent = knowledgeFrame.intent;
          lastVehicleQuery = knowledgeFrame.slots.query || "";
        } else if (observation.route?.routeId === "vehicle-control"
          && observation.effectiveFrames?.length === 1
          && observation.effectiveFrames[0].intent === "body.window.setPosition"
          && observation.effectiveFrames[0].actionNeed === "execute") {
          lastVehicleIntent = "body.window.setPosition";
          lastVehicleQuery = "";
        } else if (observation.status === "ok") {
          lastVehicleIntent = "";
          lastVehicleQuery = "";
        }
      }
      caseTrace.result = scoreConversationCase(caseTrace);
      resultCases.push(caseTrace);
    }
    modelResults.push({
      model,
      modelIdentity,
      rawModelDiagnostic,
      promptVersion: VEHICLE_SLU_COMPACT_PROMPT_VERSION,
      contractVersion: VEHICLE_SLU_CONTRACT_VERSION,
      generationProfile: VEHICLE_SLU_COMPACT_GENERATION_PROFILE,
      warmup,
      cases: resultCases,
      metrics: projectVehicleSluUxMetrics(resultCases),
    });
  }
  return {
    evidenceLevel: fixture.split === "acceptance" ? "qualification" : "development",
    evaluationMode: rawModelDiagnostic ? "raw-model-shadow-diagnostic" : "production-route-replay",
    datasetVersion: fixture.datasetVersion,
    split: fixture.split,
    caseCount: fixture.cases.length,
    contractVersion: fixture.contractVersion,
    runtime,
    routeCompatibility,
    responseObservability: "parser-routing-only",
    vehicleExecutionObservability: "semantic execute intents only; no vehicle tool is invoked",
    models: modelResults,
  };
}

async function evaluateTurn({
  baseUrl,
  model,
  requestId,
  fixtureTurn,
  pending,
  lastVehicleIntent,
  lastVehicleQuery,
  conversationContext,
  fetchImpl,
}) {
  const startedAt = performance.now();
  let generated;
  let rawSemanticEnvelope;
  let contractInvalid = false;
  let modelInvocations = 0;
  try {
    const routePolicy = new RoutePolicy({
      localModel: {
        async parse(text, options) {
          modelInvocations += 1;
          const prompt = buildVehicleSluCompactV9Prompt({
            text,
            pending: options.pending,
            conversationContext: options.conversationContext,
          });
          generated = await postJson({
            url: `${baseUrl}/api/generate`,
            body: {
              model,
              prompt,
              system: VEHICLE_SLU_COMPACT_SYSTEM,
              stream: false,
              keep_alive: VEHICLE_SLU_UX_KEEP_ALIVE,
              format: VEHICLE_SLU_COMPACT_OUTPUT_FORMAT,
              think: false,
              options: { temperature: 0, num_predict: 512, num_ctx: 4096 },
            },
            fetchImpl,
            timeoutMs: VEHICLE_SLU_UX_CASE_TIMEOUT_MS,
          });
          try {
            rawSemanticEnvelope = expandVehicleSluCompact(JSON.parse(generated?.response), {
              requestId: options.requestId,
              text,
            });
            return { semanticEnvelope: rawSemanticEnvelope, telemetry: { model } };
          } catch {
            contractInvalid = true;
            return {
              semanticEnvelope: null,
              executionDisabled: true,
              reasonCode: "semantic-contract-invalid",
              telemetry: { model },
            };
          }
        },
      },
    });
    const route = await routePolicy.resolve(fixtureTurn.text, {
      requestId,
      runId: requestId,
      pending,
      lastVehicleIntent,
      lastVehicleQuery,
      ...(conversationContext ? { conversationContext } : {}),
    });
    return {
      status: contractInvalid ? "contract-invalid" : "ok",
      ...(contractInvalid ? { errorCode: "CONTRACT_INVALID" } : {}),
      latencyMs: Math.round(performance.now() - startedAt),
      rawFrames: rawSemanticEnvelope?.vehicleFrames || [],
      semanticSource: route.decision.semanticSource,
      modelInvocations,
      rawDomain: rawSemanticEnvelope?.domain ?? null,
      rawConversationNeed: rawSemanticEnvelope?.conversationGoal?.need ?? null,
      rawDialogueAction: rawSemanticEnvelope?.conversationGoal?.dialogueAction ?? null,
      effectiveFrames: route.semanticEnvelope?.vehicleFrames || [],
      domain: route.semanticEnvelope?.domain ?? null,
      conversationNeed: route.semanticEnvelope?.conversationGoal?.need ?? null,
      dialogueAction: route.semanticEnvelope?.conversationGoal?.dialogueAction ?? null,
      route: {
        disposition: route.decision.disposition,
        routeId: route.decision.routeId,
        reasonCode: route.decision.reasonCode,
        assistantResponse: route.assistantResponse,
        clarificationTransition: route.clarificationTransition,
      },
      ollamaDurations: sanitizeOllamaDurations(generated),
    };
  } catch (error) {
    const timeout = error?.name === "AbortError" || error?.code === "CASE_TIMEOUT";
    return {
      status: timeout ? "timeout" : "generation-error",
      latencyMs: Math.round(performance.now() - startedAt),
      modelInvocations,
      errorCode: timeout ? "TIMEOUT" : sanitizeErrorCode(error),
    };
  }
}

function advancePendingClarification(current, transition, { requestId, utterance }) {
  if (!transition || ["none", "preserve", "reject"].includes(transition.action)) return current;
  if (transition.action === "open" || (transition.action === "replace" && transition.nextPending)) {
    const candidate = transition.nextPending;
    return {
      taskId: `clarification:${requestId}:${candidate.frameId}`,
      intent: candidate.intent,
      acceptedSlots: { ...candidate.acceptedSlots },
      missingSlots: [...candidate.missingSlots],
      slotProvenance: Object.fromEntries(Object.keys(candidate.acceptedSlots).map((slot) => [slot, "original-turn"])),
      clarificationQuestion: candidate.clarificationQuestion,
      originalUtterance: utterance,
    };
  }
  if (transition.action === "merge") {
    const next = transition.nextPending;
    const changed = Object.keys(next.acceptedSlots).filter((slot) => (
      !Object.hasOwn(current?.acceptedSlots || {}, slot)
      || JSON.stringify(current.acceptedSlots[slot]) !== JSON.stringify(next.acceptedSlots[slot])
    ));
    return {
      ...current,
      ...next,
      taskId: current?.taskId || `clarification:${requestId}`,
      slotProvenance: {
        ...(current?.slotProvenance || {}),
        ...Object.fromEntries(changed.map((slot) => [slot, "clarification-turn"])),
      },
      originalUtterance: current?.originalUtterance || utterance,
    };
  }
  if (["resolve", "replace", "cancel"].includes(transition.action)) return null;
  return current;
}

function scoreConversationCase(entry) {
  const expectedMatches = entry.turns.map((turn) => isTurnPreRouteFullyMatched(turn));
  const effectiveOutcomeMatches = entry.turns.map((turn) => isTurnEffectiveOutcomeMatched(turn));
  const unrequestedVehicleWriteCount = entry.turns.reduce((count, turn) => count
    + countUnrequestedFrames(turn.result?.rawFrames, expectedRequestedFrames(turn), isVehicleWrite), 0);
  const vehicleExecuteTargetMismatchCount = entry.turns.reduce((count, turn) => count
    + countRequestedTargetMismatchFrames(turn.result?.rawFrames, expectedRequestedFrames(turn), isVehicleWrite), 0);
  const unrequestedServiceExecutionCount = entry.turns.reduce((count, turn) => count
    + countUnrequestedFrames(turn.result?.rawFrames, expectedRequestedFrames(turn), isServiceExecution), 0);
  const serviceExecuteTargetMismatchCount = entry.turns.reduce((count, turn) => count
    + countRequestedTargetMismatchFrames(turn.result?.rawFrames, expectedRequestedFrames(turn), isServiceExecution), 0);
  const closureIndex = Number.isInteger(entry.closureTurn) ? entry.closureTurn - 1 : -1;
  const clarificationClosed = entry.closureRequired !== true || (
    closureIndex >= 1
    && effectiveOutcomeMatches.slice(0, closureIndex + 1).every(Boolean)
    && entry.turns.slice(0, closureIndex).filter((turn) => turn.result?.route?.disposition === "clarify").length === 1
    && entry.turns.slice(closureIndex).every((turn) => turn.result?.route?.disposition !== "clarify")
  );
  return {
    allExpectedFramesMatched: expectedMatches.every(Boolean),
    allEffectiveOutcomesMatched: effectiveOutcomeMatches.every(Boolean),
    clarificationClosed,
    parserRouteClosed: expectedMatches.at(-1) === true,
    unrequestedVehicleWriteCount,
    vehicleExecuteTargetMismatchCount,
    vehicleWriteSafetyViolationCount: unrequestedVehicleWriteCount + vehicleExecuteTargetMismatchCount,
    unrequestedServiceExecutionCount,
    serviceExecuteTargetMismatchCount,
  };
}

function countMatchedIntentFrames(expectedFrames = [], actualFrames = []) {
  return countUniqueMatches(expectedFrames, actualFrames, (expected, actual) => (
    acceptedIntents(expected).includes(actual.intent)
  ));
}

function countUnmatchedActualFrames(expectedFrames = [], actualFrames = []) {
  return Math.max(0, actualFrames.length - countMatchedIntentFrames(expectedFrames, actualFrames));
}

function isTurnIntentCaptured(turn) {
  const result = turn.result;
  return result?.status === "ok"
    && result.domain === turn.expected?.domain
    && result.conversationNeed === turn.expected?.conversationNeed
    && (result.dialogueAction ?? null) === (turn.expected?.dialogueAction ?? null)
    && countMatchedIntentFrames(turn.expected?.frames, result.effectiveFrames) === (turn.expected?.frames || []).length;
}

function isPreRouteIntentCaptured(turn) {
  const result = turn.result;
  return result?.status === "ok"
    && result.rawDomain === turn.expected?.domain
    && result.rawConversationNeed === turn.expected?.conversationNeed
    && (result.rawDialogueAction ?? null) === (turn.expected?.dialogueAction ?? null)
    && countMatchedIntentFrames(turn.expected?.frames, result.rawFrames) === (turn.expected?.frames || []).length;
}

function isTurnPreRouteFullyMatched(turn) {
  const result = turn.result;
  const expectedFrames = turn.expected?.frames || [];
  return isPreRouteIntentCaptured(turn)
    && countMatchedSemanticFrames(expectedFrames, result.rawFrames) === expectedFrames.length
    && result.rawFrames.length === expectedFrames.length;
}

function isTurnEffectiveOutcomeMatched(turn) {
  const result = turn.result;
  const expectedFrames = scoredExpectedFrames(turn);
  return result?.status === "ok"
    && result.domain === turn.expected?.domain
    && result.conversationNeed === turn.expected?.conversationNeed
    && (result.dialogueAction ?? null) === (turn.expected?.dialogueAction ?? null)
    && countMatchedSemanticFrames(expectedFrames, result.effectiveFrames) === expectedFrames.length
    && result.effectiveFrames.length === expectedFrames.length
    && result.route?.disposition === expectedRoute(turn).disposition
    && result.route?.routeId === expectedRoute(turn).routeId;
}

function expectedEffectiveFrames(turn) {
  return turn.expected?.effectiveFrames ?? turn.expected?.frames ?? [];
}

function scoredExpectedFrames(turn) {
  return expectedEffectiveFrames(turn);
}

function expectedRoute(turn) {
  return turn.expected?.route || {};
}

function expectedRequestedFrames(turn) {
  return { raw: turn.expected?.frames || [],
    effective: turn.pendingBefore === true
      ? expectedEffectiveFrames(turn).filter((frame) => frame.actionNeed === "execute") : [] };
}

function countMatchedSemanticFrames(expectedFrames = [], actualFrames = []) {
  return countUniqueMatches(expectedFrames, actualFrames, (expected, actual) => (
    acceptedIntents(expected).includes(actual.intent)
    && expected.actionNeed === actual.actionNeed
    && sameRecord(expected.slots, actual.slots)
    && sameArray(expected.missingSlots, actual.missingSlots)
  ));
}

function countUniqueMatches(expectedFrames, actualFrames, predicate) {
  const unused = [...actualFrames];
  let count = 0;
  for (const expected of expectedFrames) {
    const index = unused.findIndex((actual) => predicate(expected, actual));
    if (index < 0) continue;
    unused.splice(index, 1);
    count += 1;
  }
  return count;
}

function countUnrequestedFrames(actualFrames = [], requests = [], predicate) {
  return countExecutionRequestErrors(actualFrames, requests, predicate).unrequested;
}

function countRequestedTargetMismatchFrames(actualFrames = [], requests = [], predicate) {
  return countExecutionRequestErrors(actualFrames, requests, predicate).targetMismatch;
}

function countExecutionRequestErrors(actualFrames, requests, predicate) {
  // All counters share one allocation, including aliases across capabilities.
  const executable = actualFrames.filter((frame) => frame.actionNeed === "execute").sort((left, right) => {
    const key = (frame) => JSON.stringify([frame.intent, frame.capability,
      Object.keys(frame.slots || {}).sort().map((name) => [name, frame.slots[name]])]);
    return key(left).localeCompare(key(right));
  });
  const matching = matchExecutionRequests(executable, requests);
  let unrequested = 0;
  let targetMismatch = 0;
  for (const [index, actual] of executable.entries()) {
    if (!predicate(actual)) continue;
    const bit = 2 ** (executable.length - index - 1);
    if (!(matching.matched & bit)) unrequested++;
    else if (!(matching.exact & bit)) targetMismatch++;
  }
  return { unrequested, targetMismatch };
}

// Jointly bind raw->effective and request->actual, each at most once. The
// priority is complete raw anchors, merged requests, exact targets, then intent
// matches. Canonical actual masks break ties independently of frame order.
function matchExecutionRequests(actual, { raw, effective }) {
  // Compact fixtures and successful compact observations are bounded to 8.
  if (Math.max(raw.length, effective.length, actual.length) > 8) {
    throw new TypeError("execution request scoring exceeds the compact frame limit");
  }
  const base = raw.length + 1;
  const maskBase = 2 ** actual.length;
  const tieScale = maskBase ** 2;
  const planScale = base ** 2 * tieScale;
  const actualBits = actual.map((_, index) => 2 ** (actual.length - index - 1));
  const offset = 2 ** effective.length;
  const stateCount = offset * maskBase;
  let scores = new Float64Array(stateCount).fill(-1);
  scores[0] = 0;
  for (const original of raw) {
    const direct = original.actionNeed === "execute" ? [original] : [];
    const choices = [{ bit: 0, priority: 0, candidates: direct }];
    if (original.actionNeed !== "none") {
      for (const [index, complete] of effective.entries()) {
        const intents = acceptedIntents(original).filter((intent) => acceptedIntents(complete).includes(intent));
        if (!intents.length || !Object.entries(original.slots || {}).every(([key, value]) => (
          Object.hasOwn(complete.slots || {}, key)
          && JSON.stringify(complete.slots[key]) === JSON.stringify(value)
        ))) continue;
        choices.push({ bit: 2 ** index,
          priority: (1 + (original.actionNeed === "execute" && sameRecord(original.slots, complete.slots) ? base : 0)) * planScale,
          candidates: [...direct, { ...complete, acceptedIntentSet: intents }] });
      }
    }
    for (const choice of choices) choice.weights = actual.map((output, index) => {
      const matching = choice.candidates.filter((frame) => acceptedIntents(frame).includes(output.intent));
      if (!matching.length) return 0;
      const exact = matching.some((frame) => sameRecord(frame.slots, output.slots));
      return (1 + (exact ? base : 0)) * tieScale
        + (exact ? actualBits[index] * maskBase : 0) + actualBits[index];
    });
    const next = new Float64Array(stateCount).fill(-1);
    for (let used = 0; used < stateCount; used++) {
      if (scores[used] < 0) continue;
      for (const choice of choices) {
        if (used & choice.bit) continue;
        const mask = used | choice.bit;
        const score = scores[used] + choice.priority;
        next[mask] = Math.max(next[mask], score);
        for (const [index, bit] of actualBits.entries()) {
          const actualBit = bit * offset;
          if (used & actualBit || !choice.weights[index]) continue;
          const assigned = mask | actualBit;
          next[assigned] = Math.max(next[assigned], score + choice.weights[index]);
        }
      }
    }
    scores = next;
  }
  const best = scores.reduce((left, right) => Math.max(left, right), 0) % tieScale;
  return { exact: Math.floor(best / maskBase), matched: best % maskBase };
}

function acceptedIntents(frame) {
  return Array.isArray(frame?.acceptedIntentSet) && frame.acceptedIntentSet.length
    ? frame.acceptedIntentSet
    : [frame?.intent].filter(Boolean);
}

function isVehicleWrite(frame) {
  return frame?.capability === "control" && frame?.actionNeed === "execute" && CONTROL_INTENTS.has(frame.intent);
}

function isServiceExecution(frame) {
  return SERVICE_CAPABILITIES.has(frame?.capability) && frame?.actionNeed === "execute";
}

function sameRecord(left, right) {
  const keys = Object.keys(left || {}).sort();
  const actualKeys = Object.keys(right || {}).sort();
  return keys.length === actualKeys.length
    && keys.every((key, index) => key === actualKeys[index] && JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function sameArray(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function metric(numerator, denominator) {
  return { numerator, denominator, rate: denominator ? numerator / denominator : null };
}

function nearestRank(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function normalizeText(value) {
  return value.toLowerCase().replace(/[\s，。！？、,.!?~～…\-—：:；]/gu, "");
}

function normalizeLocalOllamaBaseUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new TypeError("Vehicle-SLU UX evaluation requires a local Ollama endpoint");
  }
  return url.href.replace(/\/$/u, "");
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
      const error = new Error("local Vehicle-SLU generation request failed");
      error.code = Number.isInteger(response?.status) ? `OLLAMA_HTTP_${response.status}` : "OLLAMA_HTTP_ERROR";
      throw error;
    }
    return response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("Vehicle-SLU UX case exceeded the generation deadline");
      timeoutError.name = "AbortError";
      timeoutError.code = "CASE_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function warmupOllamaModel({ baseUrl, model, fetchImpl }) {
  const startedAt = performance.now();
  const generated = await postJson({
    url: `${baseUrl}/api/generate`,
    body: {
      model,
      prompt: buildVehicleSluCompactV9Prompt({ text: "你好" }),
      system: VEHICLE_SLU_COMPACT_SYSTEM,
      stream: false,
      keep_alive: VEHICLE_SLU_UX_KEEP_ALIVE,
      format: VEHICLE_SLU_COMPACT_OUTPUT_FORMAT,
      think: false,
      options: { temperature: 0, num_predict: 1, num_ctx: 4096 },
    },
    fetchImpl,
    timeoutMs: VEHICLE_SLU_UX_WARMUP_TIMEOUT_MS,
  });
  return {
    status: "ok",
    durationMs: Math.round(performance.now() - startedAt),
    keepAlive: VEHICLE_SLU_UX_KEEP_ALIVE,
    ollamaDurations: sanitizeOllamaDurations(generated),
  };
}

async function readOllamaRuntimeMetadata(baseUrl, fetchImpl) {
  const version = await fetchOllamaJson({
    url: `${baseUrl}/api/version`,
    fetchImpl,
    timeoutMs: 5_000,
  });
  return {
    engine: "ollama",
    version: typeof version?.version === "string" ? version.version : null,
    hostPlatform: process.platform,
    hostArchitecture: process.arch,
    loadDurationSource: "per-request Ollama load_duration_ns",
  };
}

async function readOllamaModelIdentity(baseUrl, model, fetchImpl) {
  const tags = await fetchOllamaJson({
    url: `${baseUrl}/api/tags`,
    fetchImpl,
    timeoutMs: 5_000,
  });
  const tag = tags?.models?.find((entry) => entry.name === model);
  if (!tag) throw new Error(`Ollama model is not installed: ${model}`);
  const details = await fetchOllamaJson({
    url: `${baseUrl}/api/show`,
    method: "POST",
    body: { model },
    fetchImpl,
    timeoutMs: 5_000,
  });
  return {
    name: tag.name,
    digest: typeof tag.digest === "string" ? tag.digest : null,
    sizeBytes: Number.isFinite(tag.size) ? tag.size : null,
    modifiedAt: typeof tag.modified_at === "string" ? tag.modified_at : null,
    family: typeof details?.details?.family === "string" ? details.details.family : null,
    parameterSize: typeof details?.details?.parameter_size === "string" ? details.details.parameter_size : null,
    quantizationLevel: typeof details?.details?.quantization_level === "string"
      ? details.details.quantization_level
      : null,
  };
}

async function fetchOllamaJson({ url, method = "GET", body, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      ...(body ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      } : {}),
      signal: controller.signal,
    });
    if (!response?.ok) {
      const error = new Error("local Ollama metadata request failed");
      error.code = Number.isInteger(response?.status) ? `OLLAMA_HTTP_${response.status}` : "OLLAMA_HTTP_ERROR";
      throw error;
    }
    return response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error("Ollama metadata request exceeded the deadline");
      timeoutError.name = "AbortError";
      timeoutError.code = "OLLAMA_METADATA_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeOllamaDurations(value) {
  const fields = {
    total_duration: "totalDurationNs",
    load_duration: "loadDurationNs",
    prompt_eval_count: "promptEvalCount",
    prompt_eval_duration: "promptEvalDurationNs",
    eval_count: "evalCount",
    eval_duration: "evalDurationNs",
  };
  return Object.fromEntries(Object.entries(fields)
    .filter(([source]) => Number.isFinite(value?.[source]) && value[source] >= 0)
    .map(([source, target]) => [target, Math.round(value[source])]));
}

function sanitizeErrorCode(error) {
  const code = String(error?.code || error?.name || "GENERATION_ERROR");
  return /^[A-Z0-9_:-]{1,80}$/u.test(code) ? code : "GENERATION_ERROR";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseVehicleSluUxArguments(argv) {
  const values = new Map();
  let validateOnly = false;
  let rawModelDiagnostic = false;
  for (let index = 0; index < argv.length;) {
    const key = argv[index];
    if (!["--models", "--fixture", "--base-url", "--validate-only", "--raw-model-diagnostic"].includes(key) || values.has(key)) {
      throw new TypeError("usage: --models model-a,model-b --fixture path [--base-url http://127.0.0.1:11434] [--validate-only] [--raw-model-diagnostic]");
    }
    values.set(key, true);
    if (key === "--validate-only" || key === "--raw-model-diagnostic") {
      if (key === "--validate-only") validateOnly = true;
      if (key === "--raw-model-diagnostic") rawModelDiagnostic = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new TypeError("missing value for Vehicle-SLU UX evaluator argument");
    }
    values.set(key, value);
    index += 2;
  }
  const fixture = values.get("--fixture");
  if (!fixture || (!validateOnly && !values.has("--models"))) {
    throw new TypeError("--fixture and, unless --validate-only, --models are required");
  }
  return {
    fixture,
    models: String(values.get("--models") || "").split(",").map((model) => model.trim()).filter(Boolean),
    baseUrl: values.get("--base-url"),
    validateOnly,
    ...(rawModelDiagnostic ? { rawModelDiagnostic: true } : {}),
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseVehicleSluUxArguments(argv);
  const fixturePath = resolve(options.fixture);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  validateVehicleSluUxFixture(fixture);
  if (options.rawModelDiagnostic && options.validateOnly) {
    throw new TypeError("--raw-model-diagnostic cannot be combined with --validate-only");
  }
  if (options.validateOnly) {
    const compatibility = await auditVehicleSluUxRouteCompatibility(fixture);
    console.log(`Vehicle-SLU UX fixture valid: ${fixture.datasetVersion}, ${fixture.cases.length} conversation cases`);
    console.log(`Route compatibility: ${compatibility.compatibleTurnCount}/${compatibility.turnCount}; gaps=${compatibility.gapCount}`);
    if (compatibility.gaps.length) console.log(JSON.stringify(compatibility.gaps, null, 2));
    return;
  }
  const result = await evaluateVehicleSluUx({
    fixture,
    models: options.models,
    rawModelDiagnostic: options.rawModelDiagnostic,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
  const createdAt = new Date().toISOString();
  const outputDirectory = resolve("artifacts/vehicle-slu-ux", createdAt.replace(/[:.]/gu, "-"));
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "results.json"), `${JSON.stringify({ createdAt, ...result }, null, 2)}\n`, "utf8");
  await writeFile(resolve(outputDirectory, "summary.md"), buildSummary({ createdAt, ...result }), "utf8");
  console.log(`Vehicle-SLU UX evaluation written to ${outputDirectory}`);
}

function buildSummary(results) {
  const lines = [
    "# Vehicle-SLU multi-turn UX evaluation",
    "",
    `- Created: ${results.createdAt}`,
    `- Dataset: ${results.datasetVersion} (${results.split}; ${results.caseCount} conversations)`,
    `- Evidence: ${results.evidenceLevel}`,
    `- Evaluation mode: ${results.evaluationMode}; one Vehicle-SLU model request per turn, structured validation and pending merge only`,
    `- Gold-route compatibility: ${results.routeCompatibility.compatibleTurnCount}/${results.routeCompatibility.turnCount} expected turns match current RoutePolicy`,
    `- Observation boundary: ${results.responseObservability}`,
    `- Runtime: ${results.runtime.engine} ${results.runtime.version || "unknown"} on ${results.runtime.hostPlatform}/${results.runtime.hostArchitecture}; per-call model load durations recorded`,
    ...results.models.map((entry) => `- Model warmup: ${entry.model} ${entry.warmup.status} in ${entry.warmup.durationMs} ms (full compact prompt prefill; keep_alive=${entry.warmup.keepAlive}; excluded from per-turn latency)`),
    "",
    "| Model (digest / quantization) | Product intent (effective) | Pre-route intent | Model intent | Effective frame | Pre-route frame | Model raw frame | Route decision | Clarification closure | Extra clarification | Repeated slot questions | Unrequested vehicle executes | Vehicle target mismatch | Unrequested service executes | Service target mismatch | Mixed partial completion | Parser/route P50 | Parser/route P95 | Model calls | Model failed turns | Model P50 | Model P95 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const entry of results.models) {
    const metrics = entry.metrics;
    const digest = entry.modelIdentity.digest?.slice(0, 12) || "unknown";
    const quantization = entry.modelIdentity.quantizationLevel || "unknown";
    lines.push(`| ${entry.model} (${digest} / ${quantization}) | ${renderMetric(metrics.intentCapture)} | ${renderMetric(metrics.preRouteIntentCapture)} | ${renderMetric(metrics.modelIntentCapture)} | ${renderMetric(metrics.semanticFrameMatch)} | ${renderMetric(metrics.preRouteSemanticFrameMatch)} | ${renderMetric(metrics.modelRawSemanticFrameMatch)} | ${renderMetric(metrics.routeDecisionAccuracy)} | ${renderMetric(metrics.necessaryClarificationClosure)} | ${renderMetric(metrics.unnecessaryClarificationTurns)} | ${metrics.repeatedClarificationCount} | ${metrics.unrequestedVehicleWriteCount} | ${metrics.vehicleExecuteTargetMismatchCount} | ${metrics.unrequestedServiceExecutionCount} | ${metrics.serviceExecuteTargetMismatchCount} | ${renderMetric(metrics.mixedTaskPartialCompletion)} | ${metrics.p50Ms ?? "N/A"} ms | ${metrics.p95Ms ?? "N/A"} ms | ${metrics.modelInvocationCount} | ${metrics.modelFailureTurnCount} | ${metrics.modelP50Ms ?? "N/A"} ms | ${metrics.modelP95Ms ?? "N/A"} ms |`);
  }
  lines.push("", "Product intent uses final effective frames and routing; pre-route intent scores the selected parser output; model intent scores only turns that invoked the model.", "Parser/route latency excludes downstream vehicle/service tools and user-facing knowledge or chat generation.", "User-visible answer quality is not measured: this replay covers Vehicle-SLU parsing and route policy only.");
  return `${lines.join("\n")}\n`;
}

function renderMetric(value) {
  return value.denominator ? `${value.numerator}/${value.denominator} (${(value.rate * 100).toFixed(1)}%)` : "N/A";
}

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
