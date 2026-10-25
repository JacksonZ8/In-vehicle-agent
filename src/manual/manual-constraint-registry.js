import { computeManualSafetyPolicyBundleDigest } from "./manual-safety-policy.js";
import { getManualCorpus } from "./manual-corpus-registry.js";
import {
  isManualEvidenceRef,
  MANUAL_EVIDENCE_REF_CONTRACT,
} from "./manual-evidence-eligibility.js";

const MANUAL_VERSION = "nio-es8-user-manual-2026";
const REQUIRED_ENTRY_FIELDS = Object.freeze([
  "id", "status", "manualVersion", "sourceId", "chunkId", "subject", "action",
  "preconditions", "effect", "exceptions", "citation", "contentDigest", "review", "testVectors",
]);
const SUPPORTED_EFFECTS = new Set(["reject", "require_confirmation", "clamp"]);

const REGISTRY_PAYLOAD = {
  registryId: "nio-es8-local-dev-manual-constraint-registry",
  version: "1.0.0",
  integrityBoundary: "codex-local-source-verification; not human-reviewed or production-approved",
  entries: [
    {
      id: "es8-tailgate-clear-path",
      status: "approved-for-local-dev",
      manualVersion: MANUAL_VERSION,
      sourceId: MANUAL_VERSION,
      chunkId: "es8-manual-chunk-0052",
      contentDigest: "sha256:d56948110fc2cc85a4f8468d7213eb52a9e7a57cb18049e4867fbde41c52dc97",
      topic: "tailgate-clearance",
      subject: "tailgate",
      action: "open-or-close",
      preconditions: [{ fact: "tailgate.pathClear", operator: "eq", value: true }],
      effect: "require_confirmation",
      exceptions: [],
      citation: {
        page: 62,
        pageStart: 62,
        pageEnd: 63,
        span: "打开或关闭尾门前，请确认尾门的开/闭路径附近无障碍物，以避免造成人身伤害或财产损失。",
      },
      review: {
        status: "source-verified-for-local-dev",
        method: "codex-local-source-span-verification",
        reviewedAt: "2026-07-13",
        reviewerRole: "codex-execution-agent",
        humanReviewed: false,
        productionApproved: false,
        trustBoundary: "Codex local source verification only; no human approval, external authority, signer, or PKI",
      },
      testVectors: ["exact-reviewed-span", "missing-span-rejected", "wrong-chunk-rejected"],
    },
    {
      id: "es8-window-anti-pinch-unavailable",
      status: "approved-for-local-dev",
      manualVersion: MANUAL_VERSION,
      sourceId: MANUAL_VERSION,
      chunkId: "es8-manual-chunk-0065",
      contentDigest: "sha256:a1d5d920ec6a6a31e0c51370e1d4d8e9ef2ffc32ff8a2ed19063b3a6409b0ff4",
      topic: "window-anti-pinch",
      subject: "window",
      action: "close",
      preconditions: [{ fact: "window.antiPinchAvailable", operator: "eq", value: false }],
      effect: "reject",
      exceptions: [],
      citation: {
        page: 79,
        pageStart: 79,
        pageEnd: 79,
        span: "若车窗一键升窗和防夹保护功能失效（如低压蓄电池断电后重启），请按以下方法进行车窗初始化：",
      },
      review: {
        status: "source-verified-for-local-dev",
        method: "codex-local-source-span-verification",
        reviewedAt: "2026-07-13",
        reviewerRole: "codex-execution-agent",
        humanReviewed: false,
        productionApproved: false,
        trustBoundary: "Codex local source verification only; no human approval, external authority, signer, or PKI",
      },
      testVectors: ["exact-reviewed-span", "different-subject-rejected", "negated-span-rejected"],
    },
  ],
};

export const MANUAL_CONSTRAINT_REGISTRY = deepFreeze({
  ...REGISTRY_PAYLOAD,
  integrity: {
    algorithm: "sha256",
    digest: "sha256:7fbb8f71eef39627734315f2b2914b41d7b1a90a383c7b76df2f7a12b11dae47",
    trustBoundary: "Codex local source/content integrity only; no human approval, identity authentication, external signer, or PKI",
  },
});

export function publishManualConstraints(manualEvidence = {}, registry = MANUAL_CONSTRAINT_REGISTRY) {
  const integrity = verifyManualConstraintRegistry(registry);
  const evidence = manualEvidence.status === "hit" && Array.isArray(manualEvidence.evidence)
    ? manualEvidence.evidence
    : [];
  const candidates = [];
  const published = [];

  for (const item of evidence) {
    const strictRef = isManualEvidenceRef(item);
    const entry = integrity.valid
      ? registry.entries.find((candidate) => candidate.sourceId === item.sourceId && candidate.chunkId === item.chunkId)
      : null;
    const reasons = [];
    if (!integrity.valid) reasons.push(`registry-integrity:${integrity.reason}`);
    if (integrity.valid && !entry) reasons.push("not-in-approved-registry");
    if (entry) {
      if (item.sourceId !== entry.sourceId) reasons.push("source-mismatch");
      if (item.chunkId !== entry.chunkId) reasons.push("chunk-mismatch");
      if (strictRef) {
        const corpus = getManualCorpus(item.sourceId);
        if (!corpus || item.sourceVersion !== corpus.sourceVersion) reasons.push("source-version-mismatch");
        if (!evidenceMatchesControlledPageRange(item, entry.citation)) {
          reasons.push("citation-page-range-mismatch");
        }
      } else {
        if (item.manualVersion !== entry.manualVersion) reasons.push("manual-version-mismatch");
        if (!hasFullContentBinding(item, entry) && !hasValidCitationProof(item, entry, registry)) {
          reasons.push("reviewed-span-missing-or-changed");
        }
        if (!evidenceCoversPage(item, entry.citation.page)) reasons.push("citation-page-mismatch");
      }
      if (entry.status !== "approved-for-local-dev" || entry.review?.status !== "source-verified-for-local-dev") reasons.push("not-approved-for-local-dev");
    }
    const publishedCandidate = Boolean(entry) && reasons.length === 0;
    candidates.push({
      evidenceId: item.chunkId || null,
      registryEntryId: entry?.id || null,
      candidate: true,
      published: publishedCandidate,
      reasons,
      sourceId: item.sourceId || null,
      manualVersion: strictRef ? entry?.manualVersion || null : item.manualVersion || null,
      evidenceContract: strictRef ? MANUAL_EVIDENCE_REF_CONTRACT : "legacy-rich-evidence",
    });
    if (publishedCandidate) published.push(toPublishedConstraint(entry, registry));
  }

  return {
    published,
    candidates,
    telemetry: {
      registryId: registry?.registryId || null,
      registryVersion: registry?.version || null,
      reviewBoundary: registry?.integrityBoundary || "unknown",
      humanReviewed: false,
      productionApproved: false,
      contentBinding: "legacy normalized-full-chunk-sha256/proof or strict server EvidenceRef identity plus local constraint registry allowlist; browser transport is not identity authentication",
      integrity,
      evidenceCount: evidence.length,
      candidateCount: candidates.length,
      publishedCount: published.length,
      rejectedCount: candidates.length - published.length,
    },
  };
}

export function buildReviewedCitationProofs(chunk, registry = MANUAL_CONSTRAINT_REGISTRY) {
  if (!verifyManualConstraintRegistry(registry).valid) return [];
  return registry.entries
    .filter((entry) => entry.status === "approved-for-local-dev"
      && chunk?.sourceId === entry.sourceId
      && chunk?.chunkId === entry.chunkId
      && evidenceCoversPage(chunk, entry.citation.page)
      && computeManualConstraintContentDigest(chunk?.text) === entry.contentDigest
      && spanIncluded(chunk?.text, entry.citation.span))
    .map((entry) => ({
      registryEntryId: entry.id,
      registryVersion: registry.version,
      manualVersion: entry.manualVersion,
      sourceId: entry.sourceId,
      chunkId: entry.chunkId,
      page: entry.citation.page,
      span: entry.citation.span,
      contentDigest: entry.contentDigest,
    }));
}

export function verifyManualConstraintRegistry(registry = MANUAL_CONSTRAINT_REGISTRY) {
  const fail = (reason, actualDigest = "") => ({
    valid: false,
    reason,
    expectedDigest: registry?.integrity?.digest || "",
    actualDigest,
    trustBoundary: "Codex local source/content integrity only; no human approval, identity authentication, external signer, or PKI",
  });
  if (!registry || !Array.isArray(registry.entries)) return fail("invalid-registry-shape");
  if (registry.registryId !== "nio-es8-local-dev-manual-constraint-registry" || !/^\d+\.\d+\.\d+$/.test(registry.version || "")) {
    return fail("invalid-registry-identity");
  }
  if (registry.integrity?.algorithm !== "sha256" || typeof registry.integrity?.digest !== "string") return fail("invalid-integrity-metadata");
  for (const entry of registry.entries) {
    const missing = REQUIRED_ENTRY_FIELDS.find((field) => !Object.hasOwn(entry || {}, field));
    if (missing) return fail(`missing-entry-field:${missing}`);
    if (entry.status !== "approved-for-local-dev" || entry.review?.status !== "source-verified-for-local-dev") return fail("entry-not-approved-for-local-dev");
    if (!SUPPORTED_EFFECTS.has(entry.effect)) return fail(`unknown-effect:${entry.effect}`);
    if (entry.manualVersion !== entry.sourceId) return fail("manual-source-version-mismatch");
    if (!/^es8-manual-chunk-\d{4}$/.test(entry.chunkId)) return fail("invalid-chunk-id");
    if (!Array.isArray(entry.preconditions) || !Array.isArray(entry.exceptions)) return fail("invalid-condition-shape");
    if (!Number.isInteger(entry.citation?.page)
      || !Number.isInteger(entry.citation?.pageStart)
      || !Number.isInteger(entry.citation?.pageEnd)
      || entry.citation.pageStart > entry.citation.pageEnd
      || entry.citation.page < entry.citation.pageStart
      || entry.citation.page > entry.citation.pageEnd
      || !String(entry.citation?.span || "").trim()) return fail("invalid-citation");
    if (!entry.review?.method || !entry.review?.reviewedAt || !entry.review?.reviewerRole || !entry.review?.trustBoundary
      || entry.review.humanReviewed !== false || entry.review.productionApproved !== false) {
      return fail("invalid-review-metadata");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(entry.contentDigest)) return fail("invalid-content-digest");
    if (!Array.isArray(entry.testVectors) || !entry.testVectors.length) return fail("missing-test-vectors");
  }
  const actualDigest = computeManualConstraintRegistryDigest(registry);
  if (actualDigest !== registry.integrity.digest) return fail("digest-mismatch", actualDigest);
  return {
    valid: true,
    reason: "verified-codex-local-source-registry",
    expectedDigest: registry.integrity.digest,
    actualDigest,
    trustBoundary: registry.integrity.trustBoundary,
  };
}

export function computeManualConstraintRegistryDigest(registry) {
  const payload = { ...registry };
  delete payload.integrity;
  return computeManualSafetyPolicyBundleDigest(payload);
}

export function computeManualConstraintContentDigest(text) {
  return computeManualSafetyPolicyBundleDigest({ normalizedContent: normalizeText(text) });
}

function toPublishedConstraint(entry, registry) {
  return {
    id: entry.id,
    registryId: registry.registryId,
    registryVersion: registry.version,
    reviewStatus: entry.status,
    humanReviewed: entry.review.humanReviewed,
    productionApproved: entry.review.productionApproved,
    manualVersion: entry.manualVersion,
    sourceId: entry.sourceId,
    chunkId: entry.chunkId,
    source: entry.chunkId,
    topic: entry.topic,
    subject: entry.subject,
    action: entry.action,
    preconditions: entry.preconditions,
    effect: entry.effect,
    exceptions: entry.exceptions,
    constraintType: "reviewed-manual-policy",
    citationSpan: entry.citation.span,
    citation: formatCitation(entry),
    note: entry.citation.span,
    sourceProvenance: {
      manualVersion: entry.manualVersion,
      sourceId: entry.sourceId,
      chunkId: entry.chunkId,
      page: entry.citation.page,
      reviewMethod: entry.review.method,
      contentDigest: entry.contentDigest,
    },
  };
}

function spanIncluded(text, span) {
  return normalizeText(text).includes(normalizeText(span));
}

function hasFullContentBinding(item, entry) {
  return typeof item?.text === "string"
    && spanIncluded(item.text, entry.citation.span)
    && computeManualConstraintContentDigest(item.text) === entry.contentDigest;
}

function hasValidCitationProof(item, entry, registry) {
  return Array.isArray(item.reviewedCitationSpans) && item.reviewedCitationSpans.some((proof) =>
    proof?.registryEntryId === entry.id
    && proof.registryVersion === registry.version
    && proof.manualVersion === entry.manualVersion
    && proof.sourceId === entry.sourceId
    && proof.chunkId === entry.chunkId
    && proof.page === entry.citation.page
    && proof.contentDigest === entry.contentDigest
    && normalizeText(proof.span) === normalizeText(entry.citation.span));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, "");
}

function evidenceCoversPage(item, page) {
  return Number.isInteger(item.pageStart)
    && Number.isInteger(item.pageEnd || item.pageStart)
    && page >= item.pageStart
    && page <= (item.pageEnd || item.pageStart);
}

function evidenceMatchesControlledPageRange(item, citation) {
  return item.pageStart === citation?.pageStart && item.pageEnd === citation?.pageEnd;
}

function formatCitation(entry) {
  return `ES8 用户手册 p.${entry.citation.page}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
