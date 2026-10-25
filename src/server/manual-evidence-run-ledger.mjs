import { validateManualEvidenceRef } from "../manual/manual-evidence-ref.js";
import { MANUAL_CORPUS_REGISTRY } from "../manual/manual-corpus-registry.js";
import { assertDeepFrozenManualCorpusRegistry } from "./manual-corpus-registry-guard.mjs";

const MAX_RUNS = 100;
const STATUSES = new Set(["hit", "miss", "unavailable"]);
const corpusRegistryByLedger = new WeakMap();

export function manualEvidenceRunLedgerUsesCorpusRegistry(ledger, corpusRegistry) {
  return corpusRegistryByLedger.has(ledger)
    && corpusRegistryByLedger.get(ledger) === corpusRegistry;
}

export class ManualEvidenceRunLedger {
  #runs = new Map();
  #corpusRegistry;

  constructor({ corpusRegistry = MANUAL_CORPUS_REGISTRY } = {}) {
    assertDeepFrozenManualCorpusRegistry(corpusRegistry);
    this.#corpusRegistry = corpusRegistry;
    corpusRegistryByLedger.set(this, corpusRegistry);
  }

  record(runId, evidenceRefs, { status } = {}) {
    const normalizedRunId = requireRunId(runId);
    if (!Array.isArray(evidenceRefs)) throw new TypeError("evidenceRefs must be an array");

    const normalizedStatus = status ?? (evidenceRefs.length > 0 ? "hit" : "miss");
    if (!STATUSES.has(normalizedStatus)) {
      throw new TypeError(`unsupported manual evidence status: ${normalizedStatus}`);
    }
    if (normalizedStatus === "hit" && evidenceRefs.length === 0) {
      throw new TypeError("hit status requires non-empty evidenceRefs");
    }
    if (normalizedStatus !== "hit" && evidenceRefs.length > 0) {
      throw new TypeError(`${normalizedStatus} status requires empty evidenceRefs`);
    }

    const acceptedRefs = evidenceRefs.map((ref) => {
      const validation = validateManualEvidenceRef(ref, this.#corpusRegistry);
      if (!validation.valid) {
        throw new TypeError(`invalid manual evidence ref: ${validation.reason}`);
      }
      return freezeEvidenceRef(ref);
    });
    const snapshot = Object.freeze({
      runId: normalizedRunId,
      status: normalizedStatus,
      evidenceRefs: Object.freeze(acceptedRefs),
    });

    this.#runs.set(normalizedRunId, snapshot);
    if (this.#runs.size > MAX_RUNS) {
      this.#runs.delete(this.#runs.keys().next().value);
    }
    return snapshot;
  }

  get(runId) {
    return this.#runs.get(String(runId || "").trim()) ?? null;
  }

  find(runId, { sourceId, chunkId } = {}) {
    const snapshot = this.get(runId);
    if (!snapshot) return null;
    return snapshot.evidenceRefs.find((ref) => (
      ref.sourceId === sourceId && ref.chunkId === chunkId
    )) ?? null;
  }
}

function requireRunId(runId) {
  if (typeof runId !== "string" || !runId.trim()) {
    throw new TypeError("runId must be a non-empty string");
  }
  return runId.trim();
}

function freezeEvidenceRef(ref) {
  return Object.freeze({
    sourceId: ref.sourceId,
    sourceVersion: ref.sourceVersion,
    chunkId: ref.chunkId,
    pageStart: ref.pageStart,
    pageEnd: ref.pageEnd,
    excerpt: ref.excerpt,
    score: Object.freeze({ ...ref.score }),
  });
}
