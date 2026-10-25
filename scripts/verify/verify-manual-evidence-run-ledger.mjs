import assert from "node:assert/strict";
import { MANUAL_CORPUS_REGISTRY } from "../../src/manual/manual-corpus-registry.js";
import * as ledgerModule from "../../src/server/manual-evidence-run-ledger.mjs";

const {
  ManualEvidenceRunLedger,
  manualEvidenceRunLedgerUsesCorpusRegistry,
} = ledgerModule;

assert.equal(
  typeof manualEvidenceRunLedgerUsesCorpusRegistry,
  "function",
  "ledger registry identity proof must be an unforgeable module export",
);

function evidenceRef(chunkId, pageStart, pageEnd, excerpt) {
  return {
    sourceId: "nio-es8-user-manual-2026",
    sourceVersion: "2026",
    chunkId,
    pageStart,
    pageEnd,
    excerpt,
    score: { retrieval: 0.72, rerank: null, grounding: null },
  };
}

const first = evidenceRef(
  "es8-manual-chunk-0055",
  66,
  66,
  "您可以设置并记忆尾门的开启高度。",
);
const second = evidenceRef(
  "es8-manual-chunk-0057",
  68,
  68,
  "行车前，请务必确认前舱盖已正确关闭。",
);

const nonDefaultRegistry = Object.freeze({
  ...MANUAL_CORPUS_REGISTRY,
  corpora: Object.freeze({
    ...MANUAL_CORPUS_REGISTRY.corpora,
    "nio-es8-user-manual-2026": Object.freeze({
      ...MANUAL_CORPUS_REGISTRY.corpora["nio-es8-user-manual-2026"],
      sourceVersion: "custom-registry-version",
    }),
  }),
});
const nonDefaultEvidence = {
  ...evidenceRef(
    "es8-manual-chunk-0055",
    66,
    66,
    "您可以设置并记忆尾门的开启高度。",
  ),
  sourceVersion: "custom-registry-version",
};
const nonDefaultLedger = new ManualEvidenceRunLedger({ corpusRegistry: nonDefaultRegistry });
assert.equal(
  Object.hasOwn(nonDefaultLedger, "usesCorpusRegistry"),
  false,
  "ledger must not expose a forgeable registry self-report",
);
assert.equal(manualEvidenceRunLedgerUsesCorpusRegistry(nonDefaultLedger, nonDefaultRegistry), true);
assert.equal(manualEvidenceRunLedgerUsesCorpusRegistry(nonDefaultLedger, MANUAL_CORPUS_REGISTRY), false);
assert.equal(manualEvidenceRunLedgerUsesCorpusRegistry({
  usesCorpusRegistry: () => true,
}, nonDefaultRegistry), false, "a forged self-report must not acquire the ledger brand");
assert.equal(
  manualEvidenceRunLedgerUsesCorpusRegistry({}, undefined),
  false,
  "an unbranded value must not match merely because both registry lookups are undefined",
);
assert.equal(
  nonDefaultLedger.record("custom-run", [nonDefaultEvidence], { status: "hit" }).evidenceRefs[0].sourceVersion,
  "custom-registry-version",
  "record must validate against the ledger-bound registry instead of the global registry",
);
assert.throws(
  () => new ManualEvidenceRunLedger().record("global-run", [nonDefaultEvidence], { status: "hit" }),
  /source-version-mismatch/,
);

const mutableNestedRegistry = Object.freeze({
  ...MANUAL_CORPUS_REGISTRY,
  corpora: Object.freeze({
    ...MANUAL_CORPUS_REGISTRY.corpora,
    "nio-es8-user-manual-2026": {
      ...MANUAL_CORPUS_REGISTRY.corpora["nio-es8-user-manual-2026"],
    },
  }),
});
assert.throws(
  () => new ManualEvidenceRunLedger({ corpusRegistry: mutableNestedRegistry }),
  (error) => error?.code === "manual-corpus-registry-not-deep-frozen",
  "a top-level frozen registry with mutable nested state must fail fast",
);

function registryWithProbe(probe) {
  return Object.freeze({
    ...MANUAL_CORPUS_REGISTRY,
    validationProbe: probe,
  });
}

function assertUnsafeRegistryRejected(corpusRegistry, message) {
  assert.throws(
    () => new ManualEvidenceRunLedger({ corpusRegistry }),
    (error) => error?.code === "manual-corpus-registry-not-deep-frozen",
    message,
  );
}

const inheritedCorpora = Object.freeze(Object.create(Object.freeze({
  corpora: { ...MANUAL_CORPUS_REGISTRY.corpora },
})));
assertUnsafeRegistryRejected(
  inheritedCorpora,
  "a frozen registry must not inherit mutable corpora from its prototype",
);

let corporaAccessorReads = 0;
const accessorRegistry = {};
Object.defineProperty(accessorRegistry, "corpora", {
  enumerable: true,
  get() {
    corporaAccessorReads += 1;
    return MANUAL_CORPUS_REGISTRY.corpora;
  },
});
Object.freeze(accessorRegistry);
assertUnsafeRegistryRejected(
  accessorRegistry,
  "a registry corpora accessor must fail fast",
);
assert.equal(corporaAccessorReads, 0, "registry validation must not invoke the corpora accessor");

let inheritedSourceVersionReads = 0;
Object.defineProperty(Object.prototype, "sourceVersion", {
  configurable: true,
  get() {
    inheritedSourceVersionReads += 1;
    return "prototype-version";
  },
});
try {
  assertUnsafeRegistryRejected(
    MANUAL_CORPUS_REGISTRY,
    "a corpus with an inherited sourceVersion must fail fast even when the field is optional",
  );
  assert.equal(
    inheritedSourceVersionReads,
    0,
    "registry validation must not invoke an inherited sourceVersion accessor",
  );
} finally {
  delete Object.prototype.sourceVersion;
}

const cyclicProbe = {};
cyclicProbe.self = cyclicProbe;
Object.freeze(cyclicProbe);
const accessorProbe = {};
Object.defineProperty(accessorProbe, "value", {
  enumerable: true,
  get: () => "dynamic",
});
Object.freeze(accessorProbe);
class RegistryProbe {
  constructor() {
    this.value = "mutable-by-type";
  }
}
for (const [label, probe] of [
  ["Map", Object.freeze(new Map([["mutable", true]]))],
  ["Set", Object.freeze(new Set(["mutable"]))],
  ["Date", Object.freeze(new Date(0))],
  ["typed array", Object.freeze(new Uint8Array())],
  ["class instance", Object.freeze(new RegistryProbe())],
  ["accessor", accessorProbe],
  ["symbol", Symbol("registry-probe")],
  ["function", Object.freeze(() => "dynamic")],
  ["cycle", cyclicProbe],
]) {
  assertUnsafeRegistryRejected(
    registryWithProbe(probe),
    `a registry containing ${label} data must fail fast`,
  );
}

const nullPrototypeCorpus = Object.freeze(Object.assign(
  Object.create(null),
  MANUAL_CORPUS_REGISTRY.corpora["nio-es8-user-manual-2026"],
  { sourceVersion: "null-prototype-version" },
));
const nullPrototypeCorpora = Object.freeze(Object.assign(
  Object.create(null),
  MANUAL_CORPUS_REGISTRY.corpora,
  { "nio-es8-user-manual-2026": nullPrototypeCorpus },
));
const nullPrototypeRegistry = Object.freeze(Object.assign(
  Object.create(null),
  MANUAL_CORPUS_REGISTRY,
  { corpora: nullPrototypeCorpora },
));
assert.doesNotThrow(
  () => new ManualEvidenceRunLedger({ corpusRegistry: nullPrototypeRegistry }),
  "a deeply frozen null-prototype registry must remain supported",
);

assert.throws(() => {
  nonDefaultRegistry.corpora["nio-es8-user-manual-2026"].sourceVersion = "drifted";
}, TypeError, "the accepted non-default registry graph must reject nested mutation");

const ledger = new ManualEvidenceRunLedger();
const firstSnapshot = ledger.record("run-a", [first, second], { status: "hit" });
assert.deepEqual(firstSnapshot.evidenceRefs.map((ref) => ref.chunkId), [
  "es8-manual-chunk-0055",
  "es8-manual-chunk-0057",
], "accepted refs must preserve retrieval rank order");
assert.equal(firstSnapshot.status, "hit");

first.excerpt = "caller mutation";
first.score.retrieval = 0;
assert.equal(ledger.get("run-a").evidenceRefs[0].excerpt, "您可以设置并记忆尾门的开启高度。");
assert.equal(ledger.get("run-a").evidenceRefs[0].score.retrieval, 0.72);
assert.ok(Object.isFrozen(firstSnapshot));
assert.ok(Object.isFrozen(firstSnapshot.evidenceRefs));
assert.ok(Object.isFrozen(firstSnapshot.evidenceRefs[0]));
assert.ok(Object.isFrozen(firstSnapshot.evidenceRefs[0].score));
assert.throws(() => firstSnapshot.evidenceRefs.push(second), TypeError);
assert.throws(() => {
  firstSnapshot.evidenceRefs[0].excerpt = "snapshot mutation";
}, TypeError);

const beforeRejectedReplacement = ledger.get("run-a");
const forged = evidenceRef(
  "es8-manual-chunk-0055",
  999,
  999,
  "伪造页码的证据。",
);
assert.throws(
  () => ledger.record("run-a", [second, forged], { status: "hit" }),
  /invalid manual evidence ref: chunk-page-mismatch/i,
);
assert.equal(
  ledger.get("run-a"),
  beforeRejectedReplacement,
  "a rejected replacement must leave the prior snapshot intact",
);

const replaced = ledger.record("run-a", [second], { status: "hit" });
assert.deepEqual(replaced.evidenceRefs.map((ref) => ref.chunkId), ["es8-manual-chunk-0057"]);
assert.equal(ledger.find("run-a", {
  sourceId: "nio-es8-user-manual-2026",
  chunkId: "es8-manual-chunk-0057",
}), replaced.evidenceRefs[0]);
assert.equal(ledger.find("run-a", {
  sourceId: "nio-es8-user-manual-2026",
  chunkId: "es8-manual-chunk-0055",
}), null);

const miss = ledger.record("run-miss", [], { status: "miss" });
const unavailable = ledger.record("run-unavailable", [], { status: "unavailable" });
assert.equal(miss.status, "miss");
assert.deepEqual(miss.evidenceRefs, []);
assert.equal(unavailable.status, "unavailable");
assert.deepEqual(unavailable.evidenceRefs, []);
assert.throws(() => ledger.record("invalid-hit", [], { status: "hit" }), /hit.*non-empty/i);
assert.throws(() => ledger.record("invalid-miss", [second], { status: "miss" }), /miss.*empty/i);
assert.throws(() => ledger.record("invalid-status", [], { status: "error" }), /unsupported.*status/i);

assert.equal(ledger.get("unknown-run"), null);
assert.equal(ledger.find("unknown-run", {
  sourceId: second.sourceId,
  chunkId: second.chunkId,
}), null);

const fifo = new ManualEvidenceRunLedger();
for (let index = 0; index < 100; index += 1) {
  fifo.record(`fifo-${index}`, [], { status: "miss" });
}
fifo.record("fifo-0", [], { status: "unavailable" });
fifo.record("fifo-100", [], { status: "unavailable" });
assert.equal(
  fifo.get("fifo-0"),
  null,
  "replacing the oldest run must not move it before the 101st distinct run evicts it",
);
assert.equal(fifo.get("fifo-1").runId, "fifo-1");
assert.equal(fifo.get("fifo-100").status, "unavailable");

console.log("manual evidence run ledger verification passed");
