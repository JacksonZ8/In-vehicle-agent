import { createKnowledgeSubplanExecution } from "../../runtime/task-plan-execution.js";
import { createKnowledgeDelegation, createKnowledgeSubplan } from "../contracts/vehicle-knowledge.js";
import { validateKnowledgeSubplan } from "../../agents/knowledge-plan-validator.js";
import {
  createAbortError,
  throwIfAborted,
} from "../../runtime/abort-utils.js";
import { MANUAL_RETRIEVAL_CANDIDATE_MISMATCH } from "../../manual/manual-retrieval-candidate.js";

const ES8_SCOPE = "nio-es8-user-manual-2026";
const MAX_STATE_AGE_MS = 5_000;
const manualRetrievalDurationByExecutionFacts = new WeakMap();
const SAFETY_ELIGIBILITY_ACTIONS = Object.freeze({
  "body.tailgate.open": Object.freeze({
    slots: Object.freeze({ open: true }),
    slotProvenance: Object.freeze({ open: "explicit" }),
    requiredStateFields: Object.freeze(["speedKph", "gear", "rearClearance"]),
  }),
});

export async function executeKnowledgeSubplan(input = {}) {
  throwIfAborted(input.signal);
  let delegation;
  try {
    delegation = createKnowledgeDelegation(input.delegation);
  } catch {
    return unavailableResult(null, "knowledge-delegation-invalid", []);
  }
  if (delegation.vehicleScope !== ES8_SCOPE) return notApplicableResult(delegation);

  let subplan;
  try {
    subplan = createKnowledgeSubplan(input.subplan);
  } catch {
    return unavailableResult(delegation, "knowledge-subplan-invalid", []);
  }
  const validation = validateKnowledgeSubplan(subplan, delegation);
  if (!validation.ok) return unavailableResult(delegation, "knowledge-subplan-invalid", []);

  let ledger;
  try {
    ledger = createKnowledgeSubplanExecution(subplan, delegation);
  } catch {
    return unavailableResult(delegation, "knowledge-subplan-invalid", []);
  }

  const now = typeof input.now === "function" ? input.now : Date.now;
  const monotonicNow = typeof input.monotonicNow === "function"
    ? input.monotonicNow
    : () => globalThis.performance.now();
  const evidenceRefs = [];
  const evidence = [];
  let manualEvidence = null;
  let vehicleStateSnapshot = null;
  let vehicleStateRef = null;
  let safetyAssessment = null;
  let manualRetrievalDurationMs = null;
  const safetyStep = subplan.steps.find((step) => step.capabilityId === "knowledge.safety.evaluate") ?? null;
  const requiredStateFields = safetyStep
    ? SAFETY_ELIGIBILITY_ACTIONS[safetyStep.input.action]?.requiredStateFields ?? []
    : [];

  for (const step of subplan.steps) {
    throwIfExecutionAborted(input.signal, ledger);
    const eligibility = ledger.canExecute(step.stepId);
    if (!eligibility.allowed) {
      return unavailableResult(delegation, "knowledge-step-not-runnable", ledger.snapshot(), {
        evidenceRefs, vehicleStateRef, safetyAssessment, manualRetrievalDurationMs,
      });
    }
    ledger.start(step.stepId);
    try {
      if (step.capabilityId === "knowledge.manual.retrieve") {
        let chunks;
        const candidateConsumption = await consumeManualCandidate(
          input.manualRetrievalCandidate,
          {
            runId: delegation.runId,
            query: step.input.query,
            vehicleModel: "ES8",
          },
          input.signal,
        );
        if (candidateConsumption) {
          chunks = candidateConsumption.chunks;
          manualRetrievalDurationMs = candidateConsumption.durationMs;
        } else {
          const retrievalStartedAt = monotonicNow();
          try {
            chunks = await retrieveManual(
              input.manualRetriever,
              step.input.query,
              delegation.vehicleScope,
              input.signal,
              input.deadlineAt,
            );
          } finally {
            manualRetrievalDurationMs = measuredDuration(retrievalStartedAt, monotonicNow());
          }
        }
        throwIfExecutionAborted(input.signal, ledger);
        manualEvidence = manualEvidenceFromChunks(step.input.query, chunks);
        if (manualEvidence.status === "unavailable") {
          ledger.fail(step.stepId, "manual-rag-unavailable");
          return unavailableResult(delegation, "manual-rag-unavailable", ledger.snapshot(), {
            evidenceRefs,
            evidence,
            vehicleStateRef,
            safetyAssessment,
            manualEvidence,
            manualRetrievalDurationMs,
          });
        }
        const references = projectManualEvidenceRefs(chunks);
        evidence.push(...projectManualEvidence(chunks));
        evidenceRefs.push(...references);
        ledger.complete(step.stepId, { evidenceRefs: references });
      } else if (step.capabilityId === "knowledge.vehicle-state.read") {
        vehicleStateSnapshot = await refreshAndReadProviderSnapshot({
          refreshVehicleState: input.refreshVehicleState,
          readVehicleStateSnapshot: input.readVehicleStateSnapshot,
          delegation,
          step,
          signal: input.signal,
          deadlineAt: input.deadlineAt,
        });
        throwIfExecutionAborted(input.signal, ledger);
        const stateStatus = currentStateStatus(vehicleStateSnapshot, now(), requiredStateFields);
        if (stateStatus !== "current") {
          ledger.fail(step.stepId, stateStatus === "unavailable" ? "vehicle-state-unavailable" : "vehicle-state-not-current");
          return unavailableResult(delegation, stateStatus === "unavailable" ? "vehicle-state-unavailable" : "vehicle-state-not-current", ledger.snapshot(), {
            evidenceRefs, evidence, vehicleStateRef: null, safetyAssessment: null, manualRetrievalDurationMs,
          });
        }
        vehicleStateRef = Object.freeze({ snapshotId: vehicleStateSnapshot.id });
        ledger.complete(step.stepId, { vehicleStateRef });
      } else if (step.capabilityId === "knowledge.safety.evaluate") {
        if (!vehicleStateSnapshot) throw new Error("vehicle-state-missing");
        safetyAssessment = await evaluateSafety({
          safetyGateway: input.safetyGateway,
          delegation,
          step,
          vehicleStateSnapshot,
          manualEvidence,
          signal: input.signal,
          deadlineAt: input.deadlineAt,
        });
        throwIfExecutionAborted(input.signal, ledger);
        ledger.complete(step.stepId, { safetyAssessment });
      } else if (step.capabilityId === "knowledge.answer.synthesize") {
        ledger.complete(step.stepId, {
          summary: step.input.facts.summary,
          evidenceRefs: [...evidenceRefs],
        });
      } else {
        throw new Error("knowledge-capability-owner-invalid");
      }
    } catch (error) {
      rethrowCancellation(error, input.signal, ledger);
      ledger.fail(step.stepId, "knowledge-capability-unavailable");
      return unavailableResult(delegation, "knowledge-capability-unavailable", ledger.snapshot(), {
        evidenceRefs, evidence, vehicleStateRef, safetyAssessment, manualRetrievalDurationMs,
      });
    }
  }

  return completeResult(delegation, ledger.snapshot(), {
    evidenceRefs, evidence, vehicleStateRef, safetyAssessment, manualRetrievalDurationMs,
  });
}

export function getManualRetrievalDuration(executionFacts) {
  const durationMs = executionFacts && typeof executionFacts === "object"
    ? manualRetrievalDurationByExecutionFacts.get(executionFacts)
    : null;
  return Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : null;
}

function measuredDuration(startedAt, endedAt) {
  const durationMs = Number(endedAt) - Number(startedAt);
  return Number.isFinite(durationMs) && durationMs >= 0
    ? Math.min(2_147_483_647, Math.round(durationMs))
    : 0;
}

function rememberManualRetrievalDuration(executionFacts, durationMs) {
  if (Number.isSafeInteger(durationMs) && durationMs >= 0) {
    manualRetrievalDurationByExecutionFacts.set(executionFacts, durationMs);
  }
  return executionFacts;
}

async function consumeManualCandidate(candidate, binding, signal) {
  if (!candidate) return null;
  try {
    const consumed = await candidate.consume(binding);
    throwIfAborted(signal);
    if (!consumed || typeof consumed !== "object" || Array.isArray(consumed)
      || !Number.isSafeInteger(consumed.durationMs) || consumed.durationMs < 0) {
      throw new TypeError("manual retrieval candidate returned an invalid result");
    }
    return Object.freeze({
      chunks: requireManualChunks(consumed.result),
      durationMs: consumed.durationMs,
    });
  } catch (error) {
    if (error?.code === MANUAL_RETRIEVAL_CANDIDATE_MISMATCH) return null;
    throw error;
  }
}

async function retrieveManual(manualRetriever, query, corpusId, signal, deadlineAt) {
  if (typeof manualRetriever !== "function") throw new TypeError("manualRetriever must be a function");
  throwIfAborted(signal);
  const chunks = await manualRetriever(query, {
    corpusId,
    vehicleModel: "ES8",
    ...optionalTurnContext(signal, deadlineAt),
  });
  throwIfAborted(signal);
  return requireManualChunks(chunks);
}

function requireManualChunks(value) {
  if (!Array.isArray(value)) throw new TypeError("manualRetriever must return an array");
  return value;
}

async function refreshAndReadProviderSnapshot({
  refreshVehicleState,
  readVehicleStateSnapshot,
  delegation,
  step,
  signal,
  deadlineAt,
}) {
  if (typeof refreshVehicleState !== "function"
    || typeof readVehicleStateSnapshot !== "function") return null;
  try {
    const refreshed = await refreshVehicleState({
      runId: delegation.runId,
      delegationId: delegation.delegationId,
      scope: step.input.scope,
      ...optionalTurnContext(signal, deadlineAt),
    });
    throwIfAborted(signal);
    if (!refreshed || typeof refreshed !== "object" || Array.isArray(refreshed)
      || refreshed.ok !== true || !refreshed.snapshot) return null;
    const providerSnapshot = readVehicleStateSnapshot();
    if (providerSnapshot !== refreshed.snapshot
      || providerSnapshot?.id !== refreshed.snapshot?.id) return null;
    return providerSnapshot;
  } catch (error) {
    rethrowCancellation(error, signal);
    return null;
  }
}

async function evaluateSafety({
  safetyGateway,
  delegation,
  step,
  vehicleStateSnapshot,
  manualEvidence,
  signal,
  deadlineAt,
}) {
  if (!safetyGateway || typeof safetyGateway.evaluate !== "function") throw new TypeError("safetyGateway must provide evaluate()");
  throwIfAborted(signal);
  const eligibilityAction = SAFETY_ELIGIBILITY_ACTIONS[step.input.action];
  if (!eligibilityAction) throw new TypeError("Safety eligibility action is not allowlisted");
  const command = Object.freeze({
    requestId: `knowledge:${delegation.delegationId}:${step.stepId}`,
    intent: step.input.action,
    slots: eligibilityAction.slots,
    slotProvenance: eligibilityAction.slotProvenance,
    speechAct: "command",
    actionability: Object.freeze({ actionable: true }),
  });
  const assessment = await safetyGateway.evaluate(command, {
    vehicleStateSnapshot,
    manualEvidence: manualEvidence || { status: "miss", query: "", evidence: [], telemetry: {} },
    ...optionalTurnContext(signal, deadlineAt),
  });
  throwIfAborted(signal);
  if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)
    || typeof assessment.allowed !== "boolean"
    || typeof assessment.action !== "string" || !assessment.action.trim()) {
    throw new TypeError("Safety assessment is invalid");
  }
  const assessmentSnapshotId = assessment.vehicleStateSnapshotId;
  const auditSnapshotId = assessment.vehicleStateAudit?.snapshotId;
  const hasAssessmentSnapshotId = typeof assessmentSnapshotId === "string" && assessmentSnapshotId.trim();
  const hasAuditSnapshotId = typeof auditSnapshotId === "string" && auditSnapshotId.trim();
  if (!hasAssessmentSnapshotId
    || !hasAuditSnapshotId
    || assessmentSnapshotId !== vehicleStateSnapshot.id
    || auditSnapshotId !== vehicleStateSnapshot.id
    || assessmentSnapshotId !== auditSnapshotId) {
    throw new TypeError("Safety assessment replaced the Provider snapshot");
  }
  return deepFreeze(structuredClone(assessment));
}

function currentStateStatus(snapshot, nowMs, requiredStateFields = []) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || typeof snapshot.id !== "string" || !snapshot.id.trim()
    || !snapshot.values || typeof snapshot.values !== "object" || Array.isArray(snapshot.values)) {
    return "unavailable";
  }
  const capturedAt = typeof snapshot.capturedAt === "string" ? Date.parse(snapshot.capturedAt) : NaN;
  if (!Number.isFinite(capturedAt) || !Number.isFinite(nowMs)) return "unavailable";
  const freshnessMs = Number.isFinite(snapshot.freshnessMs) ? Math.max(0, snapshot.freshnessMs) : 0;
  if (nowMs - capturedAt + freshnessMs > MAX_STATE_AGE_MS) return "stale";
  const values = Object.values(snapshot.values);
  if (!values.length || values.every((value) => value === null)) return "unavailable";
  if (requiredStateFields.some((field) => snapshot.values[field] === null || snapshot.values[field] === undefined)) {
    return "unavailable";
  }
  return "current";
}

function manualEvidenceFromChunks(query, chunks) {
  const metadata = chunks.metadata && typeof chunks.metadata === "object"
    ? chunks.metadata
    : {};
  const requestedStatus = ["hit", "miss", "unavailable"].includes(metadata.status)
    ? metadata.status
    : null;
  const status = requestedStatus || (chunks.length ? "hit" : "miss");
  return Object.freeze({
    status,
    query: String(metadata.query || query),
    evidence: status === "hit" ? deepFreeze(structuredClone(chunks)) : [],
    telemetry: deepFreeze(structuredClone(metadata)),
  });
}

function projectManualEvidenceRefs(chunks) {
  return chunks.filter(isRecord).slice(0, 2).map((chunk) => {
    const excerpt = String(chunk.excerpt ?? chunk.text ?? "").trim();
    const pageStart = Number.isInteger(chunk.pageStart) ? chunk.pageStart : null;
    const pageEnd = Number.isInteger(chunk.pageEnd) ? chunk.pageEnd : pageStart;
    const retrieval = Number.isFinite(chunk.score?.retrieval)
      ? chunk.score.retrieval
      : Number.isFinite(chunk.retrievalScore) ? chunk.retrievalScore
        : Number.isFinite(chunk.score) ? chunk.score : null;
    if (typeof chunk.sourceId !== "string" || !chunk.sourceId.trim()
      || typeof chunk.sourceVersion !== "string" || !chunk.sourceVersion.trim()
      || typeof chunk.chunkId !== "string" || !chunk.chunkId.trim()
      || pageStart === null || pageEnd === null || !excerpt || retrieval === null) {
      throw new TypeError("manual retrieval must preserve strict Manual EvidenceRef fields");
    }
    return {
      sourceId: chunk.sourceId.trim(),
      sourceVersion: chunk.sourceVersion.trim(),
      chunkId: chunk.chunkId.trim(),
      pageStart,
      pageEnd,
      excerpt,
      score: {
        retrieval,
        rerank: Number.isFinite(chunk.score?.rerank) ? chunk.score.rerank
          : Number.isFinite(chunk.rerankScore) ? chunk.rerankScore : null,
        grounding: Number.isFinite(chunk.score?.grounding) ? chunk.score.grounding
          : Number.isFinite(chunk.groundingScore) ? chunk.groundingScore : null,
      },
    };
  });
}

function projectManualEvidence(chunks) {
  return chunks.filter(isRecord).slice(0, 2).map((chunk) => ({
    id: typeof chunk.chunkId === "string" ? chunk.chunkId : "",
    source: typeof chunk.sourceId === "string" ? chunk.sourceId : "",
    title: manualEvidenceTitle(chunk),
    citation: manualEvidenceCitation(chunk),
    excerpt: String(chunk.text ?? chunk.excerpt ?? "").trim().slice(0, 320),
  })).filter((item) => item.id && item.source && item.excerpt);
}

function completeResult(delegation, stepResults, {
  evidenceRefs,
  evidence,
  vehicleStateRef,
  safetyAssessment,
  manualRetrievalDurationMs,
}) {
  const safetyRef = projectSafetyAssessmentRef(safetyAssessment);
  const result = deepFreeze({
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    outcomeStatus: "completed",
    reasonCode: "",
    stepResults,
    evidenceRefs: structuredClone(evidenceRefs),
    evidence: structuredClone(evidence),
    vehicleStateRef: vehicleStateRef ? structuredClone(vehicleStateRef) : null,
    vehicleStateRefs: vehicleStateRef ? [structuredClone(vehicleStateRef)] : [],
    safetyAssessment: safetyRef,
    safetyAssessmentRef: safetyRef,
    degraded: false,
    vehicleToolCalls: 0,
  });
  return rememberManualRetrievalDuration(result, manualRetrievalDurationMs);
}

function unavailableResult(delegation, reasonCode, stepResults, references = {}) {
  const safetyRef = projectSafetyAssessmentRef(references.safetyAssessment);
  const result = deepFreeze({
    delegationId: delegation?.delegationId || "",
    runId: delegation?.runId || "",
    outcomeStatus: "unavailable",
    reasonCode,
    stepResults: stepResults || Object.freeze({ steps: [] }),
    evidenceRefs: structuredClone(references.evidenceRefs || []),
    evidence: structuredClone(references.evidence || []),
    vehicleStateRef: references.vehicleStateRef ? structuredClone(references.vehicleStateRef) : null,
    vehicleStateRefs: references.vehicleStateRef ? [structuredClone(references.vehicleStateRef)] : [],
    safetyAssessment: safetyRef,
    safetyAssessmentRef: safetyRef,
    manualEvidenceStatus: references.manualEvidence?.status || null,
    manualEvidenceTelemetry: structuredClone(references.manualEvidence?.telemetry || {}),
    degraded: true,
    vehicleToolCalls: 0,
  });
  return rememberManualRetrievalDuration(result, references.manualRetrievalDurationMs);
}

function manualEvidenceTitle(item = {}) {
  if (typeof item.title === "string" && item.title.trim()) return item.title;
  const sourceId = typeof item.sourceId === "string" ? item.sourceId : "manual";
  const sourceVersion = typeof item.sourceVersion === "string" ? item.sourceVersion : "unknown";
  return `${sourceId}@${sourceVersion}`;
}

function manualEvidenceCitation(item = {}) {
  if (typeof item.citation === "string" && item.citation.trim()) return item.citation;
  if (!Number.isInteger(item.pageStart)) return "";
  const pageEnd = Number.isInteger(item.pageEnd) ? item.pageEnd : item.pageStart;
  return item.pageStart === pageEnd ? `p.${item.pageStart}` : `pp.${item.pageStart}-${pageEnd}`;
}

function projectSafetyAssessmentRef(assessment) {
  if (!isRecord(assessment)) return null;
  const projected = {};
  for (const field of [
    "requestId", "allowed", "action", "reason", "alternative", "reasonCode",
    "vehicleStateSnapshotId", "policyId", "manualEvidenceStatus",
  ]) {
    if (Object.hasOwn(assessment, field)) projected[field] = structuredClone(assessment[field]);
  }
  if (isRecord(assessment.vehicleStateAudit)) {
    projected.vehicleStateAudit = {};
    for (const field of ["snapshotId", "source", "simulated", "capturedAt", "freshnessMs", "freshness"]) {
      if (Object.hasOwn(assessment.vehicleStateAudit, field)) {
        projected.vehicleStateAudit[field] = structuredClone(assessment.vehicleStateAudit[field]);
      }
    }
  }
  return projected;
}

function notApplicableResult(delegation) {
  return deepFreeze({
    delegationId: delegation.delegationId,
    runId: delegation.runId,
    outcomeStatus: "not-applicable",
    reasonCode: "vehicle-scope-not-applicable",
    stepResults: Object.freeze({ steps: [] }),
    evidenceRefs: [],
    evidence: [],
    vehicleStateRef: null,
    vehicleStateRefs: [],
    safetyAssessment: null,
    safetyAssessmentRef: null,
    degraded: false,
    vehicleToolCalls: 0,
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function throwIfExecutionAborted(signal, executionLedger) {
  if (signal?.aborted) executionLedger.cancel("turn-cancelled");
  throwIfAborted(signal);
}

function rethrowCancellation(error, signal, executionLedger = null) {
  if (signal?.aborted) {
    executionLedger?.cancel("turn-cancelled");
    throw createAbortError(signal?.reason ?? error);
  }
}

function optionalTurnContext(signal, deadlineAt) {
  return {
    ...(signal !== undefined ? { signal } : {}),
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  };
}
