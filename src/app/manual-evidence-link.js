import { getManualCorpus } from "../manual/manual-corpus-registry.js";
import {
  createManualRagConsumerEvidence,
  isManualEvidenceRef,
  isTrustedManualRagConsumerEvidence,
  isTrustedManualRagConsumerEvidenceRef,
} from "../manual/manual-evidence-eligibility.js";
import {
  MANUAL_CONSTRAINT_REGISTRY,
  publishManualConstraints,
} from "../manual/manual-constraint-registry.js";
import {
  createAbortError,
  isCancellationError,
} from "../runtime/abort-utils.js";

const LINK_INPUT_FIELDS = Object.freeze(["evidenceRef", "evidenceRefs", "runId", "targetValidation"]);
const RESULT_STATES = new Set(["hit", "miss", "unavailable"]);
const SAFETY_ACTIONS = new Set(["allow", "reject", "clamp", "require_confirmation"]);
const EMPTY_LIST = Object.freeze([]);
const validatedManualEvidenceTargets = new WeakSet();
const validatedManualEvidenceTargetBindings = new WeakMap();

export const MANUAL_EVIDENCE_MESSAGES = Object.freeze({
  not_requested: "本轮未查询用户手册",
  searching: "正在查询用户手册",
  hit: "已查询用户手册，找到可靠证据",
  miss: "已查询用户手册，但没有找到足够可靠的证据",
  unavailable: "用户手册服务暂时不可用",
});

export function createManualEvidenceLink(input = {}) {
  if (!isRecord(input) || !hasExactFields(input, LINK_INPUT_FIELDS)) {
    throw new TypeError("manual evidence link requires only evidenceRef, evidenceRefs, runId and targetValidation");
  }
  const { evidenceRef, evidenceRefs, runId, targetValidation } = input;
  const normalizedRunId = requireNonEmptyString(runId, "runId");
  if (!isTrustedManualRagConsumerEvidence(evidenceRefs)
    || evidenceRefs.metadata?.status !== "hit"
    || evidenceRefs.metadata?.runId !== normalizedRunId
    || evidenceRefs.length === 0
    || evidenceRefs[0] !== evidenceRef
    || !isTrustedManualRagConsumerEvidenceRef(evidenceRef)
    || !isRegisteredEvidenceRef(evidenceRef)
    || !isValidatedTargetFor(targetValidation, evidenceRefs, normalizedRunId)) {
    throw new TypeError("manual evidence link requires the trusted rank-1 EvidenceRef");
  }
  return `/userguide?source=${encodeURIComponent(evidenceRef.sourceId)}&chunk=${encodeURIComponent(evidenceRef.chunkId)}&run=${encodeURIComponent(normalizedRunId)}`;
}

export async function retrieveManualEvidenceFromBrowser({
  query,
  runId,
  topK = 5,
  vehicleModel = "ES8",
  signal,
  fetchImpl,
  currentOrigin,
  onTransition = () => {},
} = {}) {
  const normalizedRunId = typeof runId === "string" ? runId.trim() : "";
  const normalizedQuery = String(query || "");
  const emit = (event) => onTransition(Object.freeze(event));
  const fail = (reason) => {
    const evidenceRefs = createUnavailableConsumerEvidence(normalizedRunId, normalizedQuery, reason);
    emit({ type: "request-failed", runId: normalizedRunId, reason, evidenceRefs });
    return evidenceRefs;
  };

  if (signal?.aborted) {
    emit({ type: "request-aborted", runId: normalizedRunId });
    throw createAbortError(signal.reason);
  }
  emit({ type: "search-started", runId: normalizedRunId, query: normalizedQuery });

  try {
    if (typeof fetchImpl !== "function") return fail("manual-rag-fetch-unavailable");
    const response = await fetchImpl("/api/manual-rag", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: normalizedQuery,
        ...(normalizedRunId ? { runId: normalizedRunId } : {}),
        topK,
        vehicleModel,
        filters: { vehicleModel },
      }),
      signal,
    });
    if (signal?.aborted) throw createAbortError(signal.reason);
    if (!response?.ok) return fail(`manual RAG HTTP ${response?.status ?? "unknown"}`);

    let result;
    try {
      result = await response.json();
    } catch {
      return fail("manual RAG invalid JSON");
    }
    if (signal?.aborted) throw createAbortError(signal.reason);
    if (!isExpectedEndpointResponse(response.url, currentOrigin, "/api/manual-rag")) {
      return fail("manual RAG origin mismatch");
    }

    const evidenceRefs = createManualRagConsumerEvidence(result);
    if (evidenceRefs.metadata?.runId !== normalizedRunId) {
      return fail("manual RAG run mismatch");
    }

    let targetValidation = null;
    if (evidenceRefs.metadata?.status === "hit") {
      targetValidation = await preflightManualEvidenceTarget({
        evidenceRefs,
        runId: normalizedRunId,
        signal,
        fetchImpl,
        currentOrigin,
      });
      if (signal?.aborted) throw createAbortError(signal.reason);
      if (!targetValidation.ok) return fail(targetValidation.reason);
      targetValidation = targetValidation.token;
    }

    emit({
      type: "response-received",
      runId: normalizedRunId,
      evidenceRefs,
      responseUrl: response.url,
      currentOrigin,
      targetValidation,
    });
    return evidenceRefs;
  } catch (error) {
    if (signal?.aborted || isCancellationError(error)) {
      emit({ type: "request-aborted", runId: normalizedRunId });
      throw createAbortError(signal?.reason ?? error);
    }
    return fail(error?.message || "manual RAG network error");
  }
}

export function projectTrustedManualEvidenceRef(reference) {
  if (!isTrustedManualRagConsumerEvidenceRef(reference) || !isManualEvidenceRef(reference)) {
    throw new TypeError("app TaskPlan boundary requires a trusted Manual EvidenceRef");
  }
  return Object.freeze({
    sourceId: reference.sourceId,
    sourceVersion: reference.sourceVersion,
    chunkId: reference.chunkId,
    pageStart: reference.pageStart,
    pageEnd: reference.pageEnd,
    excerpt: reference.excerpt,
    score: Object.freeze({
      retrieval: reference.score.retrieval,
      rerank: reference.score.rerank,
      grounding: reference.score.grounding,
    }),
  });
}

export function createManualEvidenceRunState(runId = null) {
  return freezeState({
    runId: typeof runId === "string" && runId.trim() ? runId.trim() : null,
    requested: false,
    searching: false,
    status: "not_requested",
    evidenceRefs: EMPTY_LIST,
    query: "",
    telemetry: null,
    reason: "",
    targetValidation: null,
  });
}

export function reduceManualEvidenceRun(state, event = {}) {
  const current = isRecord(state) ? state : createManualEvidenceRunState();
  if (!isRecord(event)) return current;
  if (event.type === "run-started") return createManualEvidenceRunState(event.runId);
  if (event.runId !== current.runId) return current;

  if (event.type === "search-started") {
    return freezeState({
      ...current,
      requested: true,
      searching: true,
      status: "searching",
      evidenceRefs: EMPTY_LIST,
      query: String(event.query || ""),
      telemetry: null,
      reason: "",
      targetValidation: null,
    });
  }
  if (event.type === "request-aborted") return createManualEvidenceRunState(current.runId);
  if (event.type === "request-failed") {
    const reason = String(event.reason || "manual-rag-request-failed");
    const telemetry = isTrustedManualRagConsumerEvidence(event.evidenceRefs)
      && event.evidenceRefs.metadata?.status === "unavailable"
      && event.evidenceRefs.metadata?.runId === current.runId
      ? event.evidenceRefs.metadata
      : Object.freeze({ reason });
    return unavailableState(current, reason, telemetry);
  }
  if (event.type !== "response-received") return current;

  if (!isTrustedManualRagConsumerEvidence(event.evidenceRefs)) {
    return unavailableState(current, "invalid-evidence-ref-contract");
  }
  if (!isExpectedManualRagResponse(event.responseUrl, event.currentOrigin)) {
    return unavailableState(current, "manual-rag-origin-mismatch");
  }
  if (event.evidenceRefs.metadata?.runId !== current.runId) {
    return unavailableState(current, "manual-rag-run-mismatch");
  }

  const status = event.evidenceRefs.metadata?.status;
  if (!RESULT_STATES.has(status)) {
    return unavailableState(current, "invalid-evidence-ref-contract");
  }
  if (status === "hit" && !isValidatedTargetFor(
    event.targetValidation,
    event.evidenceRefs,
    current.runId,
  )) {
    return unavailableState(current, "manual userguide target validation missing");
  }
  return freezeState({
    ...current,
    requested: true,
    searching: false,
    status,
    evidenceRefs: status === "hit" ? event.evidenceRefs : EMPTY_LIST,
    query: String(event.evidenceRefs.metadata?.query || current.query || ""),
    telemetry: event.evidenceRefs.metadata || null,
    reason: String(event.evidenceRefs.metadata?.reason || ""),
    targetValidation: status === "hit" ? event.targetValidation : null,
  });
}

export function createManualEvidencePresentation(state = {}) {
  const resolvedStatus = resolveStatus(state);
  if (resolvedStatus !== "hit") return emptyPresentation(resolvedStatus);

  const evidenceRefs = state.evidenceRefs;
  if (!isTrustedManualRagConsumerEvidence(evidenceRefs)
    || evidenceRefs.metadata?.status !== "hit"
    || !evidenceRefs.length) {
    return emptyPresentation("unavailable");
  }

  let primaryLink;
  try {
    primaryLink = createManualEvidenceLink({
      evidenceRef: evidenceRefs[0],
      evidenceRefs,
      runId: state.runId,
      targetValidation: state.targetValidation,
    });
  } catch {
    return emptyPresentation("unavailable");
  }

  return Object.freeze({
    status: "hit",
    message: MANUAL_EVIDENCE_MESSAGES.hit,
    evidenceRefs,
    primaryEvidenceRef: evidenceRefs[0],
    primaryLink,
    targetValidation: state.targetValidation,
  });
}

export function resolveManualEvidenceAnswer({ presentation, rawAnswer, rawSpeechText } = {}) {
  const status = presentation?.status;
  if (status === "miss" || status === "unavailable") {
    const fixed = MANUAL_EVIDENCE_MESSAGES[status];
    return Object.freeze({ answerText: fixed, speechText: fixed });
  }
  return Object.freeze({ answerText: rawAnswer, speechText: rawSpeechText });
}

export function createManualSafetyEvidencePresentation(safetyDecision) {
  const audit = validateSafetyDecision(safetyDecision);
  if (!audit.valid) return emptySafetyPresentation();
  const evidence = audit.evidence.length ? Object.freeze([...audit.evidence]) : EMPTY_LIST;
  const acceptedConstraints = audit.constraints.length
    ? Object.freeze([...audit.constraints])
    : EMPTY_LIST;
  return Object.freeze({
    visible: evidence.length > 0 || acceptedConstraints.length > 0,
    evidence,
    constraints: acceptedConstraints,
  });
}

async function preflightManualEvidenceTarget({
  evidenceRefs,
  runId,
  signal,
  fetchImpl,
  currentOrigin,
}) {
  const primary = evidenceRefs[0];
  const params = new URLSearchParams({
    source: primary.sourceId,
    chunk: primary.chunkId,
    run: runId,
  });
  let response;
  try {
    response = await fetchImpl(`/api/userguide?${params.toString()}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (signal?.aborted || isCancellationError(error)) throw error;
    return { ok: false, reason: error?.message || "manual userguide target network error" };
  }
  if (!response?.ok) {
    return { ok: false, reason: `manual userguide target HTTP ${response?.status ?? "unknown"}` };
  }
  if (!isExpectedEndpointResponse(response.url, currentOrigin, "/api/userguide", {
    source: primary.sourceId,
    chunk: primary.chunkId,
    run: runId,
  })) {
    return { ok: false, reason: "manual userguide target origin or params mismatch" };
  }
  let target;
  try {
    target = await response.json();
  } catch {
    return { ok: false, reason: "manual userguide target invalid JSON" };
  }
  if (!isMatchingEvidenceTarget(target, primary)) {
    return { ok: false, reason: "manual userguide target evidence or page mismatch" };
  }
  const token = Object.freeze({});
  validatedManualEvidenceTargets.add(token);
  validatedManualEvidenceTargetBindings.set(token, Object.freeze({ evidenceRefs, runId }));
  return { ok: true, token };
}

function createUnavailableConsumerEvidence(runId, query, reason) {
  return createManualRagConsumerEvidence({
    runId,
    query,
    status: "unavailable",
    evidence: [],
    reason,
    telemetry: { reason },
  });
}

function unavailableState(current, reason, telemetry = null) {
  return freezeState({
    ...current,
    requested: true,
    searching: false,
    status: "unavailable",
    evidenceRefs: EMPTY_LIST,
    telemetry: telemetry || Object.freeze({ reason }),
    reason,
    targetValidation: null,
  });
}

function resolveStatus({ requested, searching, status }) {
  if (requested !== true) return "not_requested";
  if (searching === true) return "searching";
  return RESULT_STATES.has(status) ? status : "unavailable";
}

function emptyPresentation(status) {
  return Object.freeze({
    status,
    message: MANUAL_EVIDENCE_MESSAGES[status],
    evidenceRefs: EMPTY_LIST,
    primaryEvidenceRef: null,
    primaryLink: null,
  });
}

function isRegisteredEvidenceRef(value) {
  if (!isManualEvidenceRef(value)) return false;
  const corpus = getManualCorpus(value?.sourceId);
  return Boolean(corpus)
    && value.sourceVersion === corpus.sourceVersion
    && value.pageStart > 0
    && value.pageEnd >= value.pageStart;
}

function isExpectedManualRagResponse(responseUrl, currentOrigin) {
  return isExpectedEndpointResponse(responseUrl, currentOrigin, "/api/manual-rag");
}

function isExpectedEndpointResponse(responseUrl, currentOrigin, pathname, expectedParams = null) {
  try {
    const origin = new URL(currentOrigin);
    const response = new URL(responseUrl, origin);
    if (response.origin !== origin.origin || response.pathname !== pathname || response.hash !== "") return false;
    if (!expectedParams) return response.search === "";
    const keys = [...response.searchParams.keys()];
    const expectedKeys = Object.keys(expectedParams);
    return keys.length === expectedKeys.length
      && new Set(keys).size === expectedKeys.length
      && expectedKeys.every((key) => response.searchParams.get(key) === expectedParams[key]);
  } catch {
    return false;
  }
}

function isMatchingEvidenceTarget(target, evidenceRef) {
  if (!isRecord(target)
    || target.source?.sourceId !== evidenceRef.sourceId
    || target.source?.sourceVersion !== evidenceRef.sourceVersion
    || canonicalJson(target.currentEvidence) !== canonicalJson(evidenceRef)
    || target.highlight?.chunkId !== evidenceRef.chunkId
    || target.highlight?.pageStart !== evidenceRef.pageStart
    || target.highlight?.pageEnd !== evidenceRef.pageEnd
    || target.highlight?.excerpt !== evidenceRef.excerpt
    || !Array.isArray(target.pages)) return false;
  const pages = target.pages.map((page) => page?.pageNumber);
  const expectedPages = Array.from(
    { length: evidenceRef.pageEnd - evidenceRef.pageStart + 1 },
    (_value, index) => evidenceRef.pageStart + index,
  );
  return canonicalJson(pages) === canonicalJson(expectedPages);
}

function isValidatedTargetFor(token, evidenceRefs, runId) {
  if (!token || !validatedManualEvidenceTargets.has(token)) return false;
  const binding = validatedManualEvidenceTargetBindings.get(token);
  return binding?.evidenceRefs === evidenceRefs
    && binding?.runId === runId
    && evidenceRefs.metadata?.runId === runId;
}

function validateSafetyDecision(value) {
  if (!isRecord(value)
    || !nonEmptyString(value.requestId)
    || typeof value.allowed !== "boolean"
    || !SAFETY_ACTIONS.has(value.action)
    || !nonEmptyString(value.reason)
    || !nonEmptyString(value.vehicleStateSnapshotId)
    || !isRecord(value.vehicleStateAudit)
    || value.vehicleStateAudit.snapshotId !== value.vehicleStateSnapshotId
    || !isRecord(value.manualEvidenceSummary)
    || value.manualEvidenceStatus !== value.manualEvidenceSummary.status
    || String(value.manualEvidenceQuery || "") !== String(value.manualEvidenceSummary.query || "")
    || !Array.isArray(value.manualEvidence)
    || value.manualEvidenceSummary.evidenceCount !== value.manualEvidence.length) {
    return { valid: false, evidence: EMPTY_LIST, constraints: EMPTY_LIST };
  }
  const evidence = value.manualEvidence;
  const validEvidenceContract = value.manualEvidenceStatus === "hit"
    ? evidence.length > 0 && evidence.every(isRegisteredEvidenceRef)
    : evidence.length === 0;
  if (!validEvidenceContract) return { valid: false, evidence: EMPTY_LIST, constraints: EMPTY_LIST };

  const requestedConstraints = Array.isArray(value.manualSafetyConstraints)
    ? value.manualSafetyConstraints
    : EMPTY_LIST;
  const controlledEvidence = evidence.filter(matchesControlledSafetyEvidenceIdentity);
  const publishedConstraints = controlledEvidence.length === evidence.length
    ? publishManualConstraints({ status: "hit", evidence: controlledEvidence }).published
    : EMPTY_LIST;
  const requestedConstraintKeys = requestedConstraints.map(canonicalJson).sort();
  const publishedConstraintKeys = publishedConstraints.map(canonicalJson).sort();
  if (controlledEvidence.length !== evidence.length
    || publishedConstraints.length !== evidence.length
    || requestedConstraints.some((constraint) => !isPublishedRegistryConstraint(constraint))
    || canonicalJson(requestedConstraintKeys) !== canonicalJson(publishedConstraintKeys)) {
    return { valid: false, evidence: EMPTY_LIST, constraints: EMPTY_LIST };
  }
  return {
    valid: true,
    evidence: controlledEvidence.filter(containsReviewedSafetySpan),
    constraints: requestedConstraints,
  };
}

function matchesControlledSafetyEvidenceIdentity(ref) {
  const entry = MANUAL_CONSTRAINT_REGISTRY.entries.find((candidate) => (
    candidate.sourceId === ref.sourceId && candidate.chunkId === ref.chunkId
  ));
  if (!entry) return false;
  const corpus = getManualCorpus(entry.sourceId);
  return Boolean(corpus)
    && ref.sourceVersion === corpus.sourceVersion
    && ref.pageStart === entry.citation.pageStart
    && ref.pageEnd === entry.citation.pageEnd;
}

function containsReviewedSafetySpan(ref) {
  const entry = MANUAL_CONSTRAINT_REGISTRY.entries.find((candidate) => (
    candidate.sourceId === ref.sourceId && candidate.chunkId === ref.chunkId
  ));
  return Boolean(entry)
    && normalizeReviewedSpan(ref.excerpt).includes(normalizeReviewedSpan(entry.citation.span));
}

function normalizeReviewedSpan(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, "");
}

const publishedRegistryConstraintKeys = new Set(
  MANUAL_CONSTRAINT_REGISTRY.entries.flatMap((entry) => {
    const corpus = getManualCorpus(entry.sourceId);
    if (!corpus) return [];
    const published = publishManualConstraints({
      status: "hit",
      evidence: [{
        sourceId: entry.sourceId,
        sourceVersion: corpus.sourceVersion,
        chunkId: entry.chunkId,
        pageStart: entry.citation.pageStart,
        pageEnd: entry.citation.pageEnd,
        excerpt: entry.citation.span,
        score: { retrieval: 1, rerank: null, grounding: null },
      }],
    }).published;
    return published.map(canonicalJson);
  }),
);

function isPublishedRegistryConstraint(value) {
  return isRecord(value) && publishedRegistryConstraintKeys.has(canonicalJson(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function emptySafetyPresentation() {
  return Object.freeze({ visible: false, evidence: EMPTY_LIST, constraints: EMPTY_LIST });
}

function freezeState(state) {
  return Object.freeze(state);
}

function hasExactFields(value, expectedFields) {
  const fields = Object.keys(value);
  return fields.length === expectedFields.length
    && fields.every((field) => expectedFields.includes(field));
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
