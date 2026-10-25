import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { MANUAL_CORPUS_REGISTRY } from "../../src/manual/manual-corpus-registry.js";
import * as manualEligibility from "../../src/manual/manual-evidence-eligibility.js";
import { ManualEvidenceRunLedger } from "../../src/server/manual-evidence-run-ledger.mjs";
import { createManualUserGuideRepository } from "../../src/server/manual-userguide-repository.mjs";

const serverModule = await import("../../src/server/local-agent-server.mjs");
assert.equal(
  typeof serverModule.handleManualRag,
  "function",
  "Task 2 must export handleManualRag for an in-process server-boundary verification",
);
const { createServer, handleManualRag } = serverModule;
const { handleManualUserGuidePdf } = await import("../../src/server/manual/manual-userguide-routes.mjs");
assert.equal(
  typeof manualEligibility.createManualRagConsumerEvidence,
  "function",
  "browser consumers need a pure strict EvidenceRef/status projection",
);
const { createManualRagConsumerEvidence } = manualEligibility;

const validEvidenceRef = Object.freeze({
  sourceId: "nio-es8-user-manual-2026",
  sourceVersion: "2026",
  chunkId: "es8-manual-chunk-0055",
  pageStart: 66,
  pageEnd: 66,
  excerpt: "您可以设置并记忆尾门的开启高度。",
  score: Object.freeze({ retrieval: 0.72, rerank: null, grounding: null }),
});

function createResponseRecorder() {
  const response = new EventEmitter();
  response.destroyed = false;
  response.closed = false;
  response.headersSent = false;
  response.writableEnded = false;
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode;
    response.headers = headers;
    response.headersSent = true;
  };
  response.end = (body = "") => {
    response.rawBody = Buffer.isBuffer(body) ? body : String(body);
    const contentType = response.headers?.["content-type"] || "";
    response.body = contentType.includes("application/json") && response.rawBody.length
      ? JSON.parse(String(response.rawBody))
      : response.rawBody;
    response.writableEnded = true;
  };
  response.chunks = [];
  response.write = (chunk) => {
    response.chunks.push(Buffer.from(chunk));
    return true;
  };
  return response;
}

async function invokeManualRag(body, manualRagOptions, signal = new AbortController().signal) {
  const request = Readable.from([JSON.stringify(body)]);
  const response = createResponseRecorder();
  await handleManualRag(request, response, signal, manualRagOptions);
  return response;
}

async function invokeServerManualRag(server, body) {
  const request = Readable.from([JSON.stringify(body)]);
  request.method = "POST";
  request.url = "/api/manual-rag";
  const response = createResponseRecorder();
  await server.listeners("request")[0](request, response);
  return response;
}

async function invokeServerGet(server, url) {
  const request = Readable.from([]);
  request.method = "GET";
  request.url = url;
  const response = createResponseRecorder();
  await server.listeners("request")[0](request, response);
  if (response.chunks.length) {
    response.rawBody = Buffer.concat(response.chunks);
    response.body = response.rawBody;
  }
  return response;
}

function assertNormalizedResponse(response, { status, query, runId }) {
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.body).slice(0, 6), [
    "query",
    "runId",
    "status",
    "evidence",
    "summary",
    "telemetry",
  ]);
  assert.equal(response.body.query, query);
  assert.equal(response.body.runId, runId);
  assert.equal(response.body.status, status);
  assert.ok(Array.isArray(response.body.evidence));
  assert.equal(typeof response.body.summary, "string");
  assert.ok(response.body.telemetry && typeof response.body.telemetry === "object");
  assert.notEqual(response.body.status, "error");
}

const observedDefaultLedgers = [];
const originalLedgerRecord = ManualEvidenceRunLedger.prototype.record;
ManualEvidenceRunLedger.prototype.record = function observeServerLedger(...args) {
  if (!observedDefaultLedgers.includes(this)) observedDefaultLedgers.push(this);
  return Reflect.apply(originalLedgerRecord, this, args);
};
try {
  const hitServer = createServer({
    manualRagOptions: {
      buildVectorEvidenceSummary: async (query) => ({
        query,
        evidence: [validEvidenceRef],
        summary: "server A hit",
        telemetry: { retrievalMode: "vector-bge-m3", embeddingStatus: "embedded" },
      }),
    },
  });
  const missServer = createServer({
    manualRagOptions: {
      buildVectorEvidenceSummary: async (query) => ({
        query,
        evidence: [],
        summary: "server B miss",
        telemetry: {
          retrievalMode: "vector-bge-m3",
          embeddingStatus: "embedded",
          missReason: "not-answerable",
        },
      }),
    },
  });
  await invokeServerManualRag(hitServer, { query: "server A", runId: "shared-run" });
  await invokeServerManualRag(missServer, { query: "server B", runId: "shared-run" });
  const hitLedger = observedDefaultLedgers[0];
  const missLedger = observedDefaultLedgers[1];
  const sameRunIsolation = {
    ledgerCount: observedDefaultLedgers.length,
    serverAStatus: hitLedger?.get("shared-run")?.status ?? null,
    serverBStatus: missLedger?.get("shared-run")?.status ?? null,
  };

  for (let index = 0; index < 100; index += 1) {
    await invokeServerManualRag(hitServer, {
      query: `server A FIFO ${index}`,
      runId: `server-a-fifo-${index}`,
    });
  }
  assert.equal(
    missLedger?.get("shared-run")?.status ?? null,
    "miss",
    "FIFO eviction in server A must not evict server B state",
  );
  assert.deepEqual(sameRunIsolation, {
    ledgerCount: 2,
    serverAStatus: "hit",
    serverBStatus: "miss",
  }, "two createServer instances must not overwrite the same runId in a shared default ledger");
} finally {
  ManualEvidenceRunLedger.prototype.record = originalLedgerRecord;
}

const explicitlyInjectedLedger = new ManualEvidenceRunLedger();
const explicitlyInjectedServer = createServer({
  manualRagOptions: {
    evidenceRunLedger: explicitlyInjectedLedger,
    buildVectorEvidenceSummary: async (query) => ({
      query,
      evidence: [],
      summary: "explicit injection miss",
      telemetry: {
        retrievalMode: "vector-bge-m3",
        embeddingStatus: "embedded",
        missReason: "not-answerable",
      },
    }),
  },
});
await invokeServerManualRag(explicitlyInjectedServer, {
  query: "explicit injection",
  runId: "explicit-ledger-run",
});
assert.equal(explicitlyInjectedLedger.get("explicit-ledger-run")?.status, "miss");

const evidenceRunLedger = new ManualEvidenceRunLedger();
const hitResponse = await invokeManualRag(
  { query: "如何设置 ES8 尾门开启高度？", runId: "run-hit", topK: 3 },
  {
    evidenceRunLedger,
    buildVectorEvidenceSummary: async () => ({
      query: "如何设置 ES8 尾门开启高度？",
      evidence: [validEvidenceRef],
      summary: "尾门开启高度可在设置中调整。",
      telemetry: { retrievalMode: "vector-bge-m3", embeddingStatus: "embedded" },
    }),
  },
);
assertNormalizedResponse(hitResponse, {
  status: "hit",
  query: "如何设置 ES8 尾门开启高度？",
  runId: "run-hit",
});
assert.deepEqual(hitResponse.body.evidence, [validEvidenceRef]);
assert.equal(hitResponse.body.evidence[0].sourceVersion, "2026");
assert.equal(hitResponse.body.evidence[0].score.rerank, null);
assert.equal(hitResponse.body.evidence[0].score.grounding, null);
const consumedHit = createManualRagConsumerEvidence(hitResponse.body);
assert.equal(consumedHit.metadata.status, "hit");
assert.equal(consumedHit.metadata.runId, "run-hit");
assert.equal(Object.isFrozen(consumedHit), true, "consumer evidence array must be immutable");
assert.deepEqual(consumedHit, [validEvidenceRef]);
assert.equal(Object.hasOwn(consumedHit[0], "manualVersion"), false);
assert.equal(Object.hasOwn(consumedHit[0], "title"), false);
assert.equal(Object.hasOwn(consumedHit[0], "citation"), false);
assert.equal(typeof consumedHit[0].score, "object", "consumer must not coerce the score object to a legacy number");
assert.deepEqual(evidenceRunLedger.get("run-hit"), {
  runId: "run-hit",
  status: "hit",
  evidenceRefs: [validEvidenceRef],
});

let missRetrievalCount = 0;
const missResponse = await invokeManualRag(
  { query: "今天杭州天气怎么样？" },
  {
    runIdFactory: () => "run-miss",
    evidenceRunLedger,
    buildVectorEvidenceSummary: async () => {
      missRetrievalCount += 1;
      return {
        query: "今天杭州天气怎么样？",
        evidence: [],
        summary: "未在已接入的用户手册中找到相关证据。",
        telemetry: {
          retrievalMode: "vector-bge-m3",
          embeddingStatus: "embedded",
          missReason: "not-answerable",
        },
      };
    },
  },
);
assertNormalizedResponse(missResponse, {
  status: "miss",
  query: "今天杭州天气怎么样？",
  runId: "run-miss",
});
assert.equal(missRetrievalCount, 1, "a miss must not trigger a fallback retrieval");
assert.deepEqual(missResponse.body.evidence, []);
assert.equal(missResponse.body.reason, "not-answerable");
assert.doesNotMatch(JSON.stringify(missResponse.body), /degraded|fallback|clarif|supplement/i);
assert.deepEqual(evidenceRunLedger.get("run-miss"), {
  runId: "run-miss",
  status: "miss",
  evidenceRefs: [],
});

const indexUnavailableResponse = await invokeManualRag(
  { query: "ET5 尾门怎么打开？" },
  {
    runIdFactory: () => "run-index-unavailable",
    evidenceRunLedger,
    buildVectorEvidenceSummary: async () => ({
      query: "ET5 尾门怎么打开？",
      evidence: [],
      summary: "不应展示的 miss 文案",
      telemetry: {
        retrievalMode: "vector-bge-m3",
        embeddingStatus: "unavailable",
        corpusArtifactStatus: "unavailable",
        missReason: "corpus-artifact-unavailable",
      },
    }),
  },
);
assertNormalizedResponse(indexUnavailableResponse, {
  status: "unavailable",
  query: "ET5 尾门怎么打开？",
  runId: "run-index-unavailable",
});
assert.deepEqual(indexUnavailableResponse.body.evidence, []);
assert.equal(indexUnavailableResponse.body.summary, "");
assert.equal(indexUnavailableResponse.body.reason, "corpus-artifact-unavailable");
const consumedUnavailable = createManualRagConsumerEvidence(indexUnavailableResponse.body);
assert.equal(consumedUnavailable.length, 0);
assert.equal(Object.isFrozen(consumedUnavailable), true, "empty unavailable evidence array must be immutable");
assert.equal(consumedUnavailable.metadata.status, "unavailable");
assert.equal(consumedUnavailable.metadata.reason, "corpus-artifact-unavailable");
assert.deepEqual(evidenceRunLedger.get("run-index-unavailable"), {
  runId: "run-index-unavailable",
  status: "unavailable",
  evidenceRefs: [],
});

const forgedClientResponse = await invokeManualRag(
  {
    query: "今天杭州天气怎么样？",
    runId: "run-client-forged",
    evidenceRefs: [{ ...validEvidenceRef, pageStart: 999, pageEnd: 999 }],
  },
  {
    evidenceRunLedger,
    buildVectorEvidenceSummary: async () => ({
      query: "今天杭州天气怎么样？",
      evidence: [],
      summary: "未在已接入的用户手册中找到相关证据。",
      telemetry: {
        retrievalMode: "vector-bge-m3",
        embeddingStatus: "embedded",
        missReason: "not-answerable",
      },
    }),
  },
);
assertNormalizedResponse(forgedClientResponse, {
  status: "miss",
  query: "今天杭州天气怎么样？",
  runId: "run-client-forged",
});
assert.deepEqual(evidenceRunLedger.get("run-client-forged"), {
  runId: "run-client-forged",
  status: "miss",
  evidenceRefs: [],
}, "client-supplied EvidenceRefs must never be registered");
assert.equal(evidenceRunLedger.find("run-client-forged", {
  sourceId: validEvidenceRef.sourceId,
  chunkId: validEvidenceRef.chunkId,
}), null);

let embeddingFetchCount = 0;
const embeddingUnavailableResponse = await invokeManualRag(
  { query: "ES8 车窗真实 embedding 错误路径 20260808" },
  {
    runIdFactory: () => "run-embedding-unavailable",
    baseUrl: "http://manual-rag-verification.invalid",
    fetchImpl: async () => {
      embeddingFetchCount += 1;
      return new Response("forced embedding failure", { status: 503 });
    },
  },
);
assertNormalizedResponse(embeddingUnavailableResponse, {
  status: "unavailable",
  query: "ES8 车窗真实 embedding 错误路径 20260808",
  runId: "run-embedding-unavailable",
});
assert.equal(embeddingFetchCount, 1, "the real vector retriever must reach the injected embedding transport exactly once");
assert.equal(embeddingUnavailableResponse.body.reason, "embedding-unavailable");
assert.equal(embeddingUnavailableResponse.body.telemetry.embeddingStatus, "unavailable");
assert.deepEqual(embeddingUnavailableResponse.body.evidence, []);

const optionalRerankResponse = await invokeManualRag(
  { query: "ES8 尾门怎么打开？" },
  {
    runIdFactory: () => "run-rerank-optional",
    buildVectorEvidenceSummary: async () => ({
      query: "ES8 尾门怎么打开？",
      evidence: [validEvidenceRef],
      summary: "本轮未配置必需 rerank，使用已标定本地证据。",
      telemetry: {
        retrievalMode: "vector-bge-m3",
        embeddingStatus: "embedded",
        rerankStatus: "unavailable",
        rerankRequired: false,
      },
    }),
  },
);
assertNormalizedResponse(optionalRerankResponse, {
  status: "hit",
  query: "ES8 尾门怎么打开？",
  runId: "run-rerank-optional",
});
assert.equal(optionalRerankResponse.body.evidence[0].score.rerank, null);

const requiredRerankResponse = await invokeManualRag(
  { query: "ES8 尾门怎么打开？" },
  {
    runIdFactory: () => "run-rerank-required",
    buildVectorEvidenceSummary: async () => ({
      query: "ES8 尾门怎么打开？",
      evidence: [validEvidenceRef],
      summary: "不应展示的缺失必需 rerank 结果",
      telemetry: {
        retrievalMode: "vector-bge-m3",
        embeddingStatus: "embedded",
        rerankStatus: "unavailable",
        rerankRequired: true,
        missReason: "rerank-unavailable",
      },
    }),
  },
);
assertNormalizedResponse(requiredRerankResponse, {
  status: "unavailable",
  query: "ES8 尾门怎么打开？",
  runId: "run-rerank-required",
});
assert.equal(requiredRerankResponse.body.reason, "rerank-unavailable");
assert.deepEqual(requiredRerankResponse.body.evidence, []);
assert.equal(requiredRerankResponse.body.summary, "");

const tamperedResponse = await invokeManualRag(
  { query: "ES8 尾门怎么打开？" },
  {
    runIdFactory: () => "run-tampered",
    corpusRegistry: MANUAL_CORPUS_REGISTRY,
    buildVectorEvidenceSummary: async () => ({
      query: "ES8 尾门怎么打开？",
      evidence: [{ ...validEvidenceRef, pageStart: 999, pageEnd: 999 }],
      summary: "untrusted",
      telemetry: { retrievalMode: "vector-bge-m3", embeddingStatus: "embedded" },
    }),
  },
);
assertNormalizedResponse(tamperedResponse, {
  status: "unavailable",
  query: "ES8 尾门怎么打开？",
  runId: "run-tampered",
});
assert.equal(tamperedResponse.body.reason, "invalid-evidence-ref:chunk-page-mismatch");
assert.deepEqual(tamperedResponse.body.evidence, []);

const abortController = new AbortController();
const abortRequest = Readable.from([JSON.stringify({ query: "ES8 尾门怎么打开？" })]);
const abortResponse = createResponseRecorder();
const aborted = handleManualRag(
  abortRequest,
  abortResponse,
  abortController.signal,
  {
    runIdFactory: () => "run-abort",
    buildVectorEvidenceSummary: async (_query, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  },
);
setImmediate(() => abortController.abort(new Error("verification abort")));
await assert.rejects(aborted, /verification abort/);
assert.equal(abortResponse.headersSent, false, "abort must not be converted into a response state");

const invalidInputResponse = await invokeManualRag(
  { query: "" },
  { runIdFactory: () => "run-invalid" },
);
assert.equal(invalidInputResponse.statusCode, 400);
assert.equal(invalidInputResponse.body.error.code, "invalid-request");
assert.notEqual(invalidInputResponse.body.status, "error");

const userGuideSourceId = validEvidenceRef.sourceId;
const userGuideCorpus = MANUAL_CORPUS_REGISTRY.corpora[userGuideSourceId];
const secondEvidenceRef = Object.freeze({
  ...validEvidenceRef,
  chunkId: "es8-manual-chunk-0057",
  pageStart: 68,
  pageEnd: 68,
  excerpt: "行车前，请务必确认前舱盖已正确关闭。",
});
const userGuidePages = [
  { charCount: validEvidenceRef.excerpt.length, pageNumber: 66, sourceId: userGuideSourceId, text: validEvidenceRef.excerpt },
  { charCount: secondEvidenceRef.excerpt.length, pageNumber: 68, sourceId: userGuideSourceId, text: secondEvidenceRef.excerpt },
].map((item) => JSON.stringify(item)).join("\n");
const userGuideChunks = [
  {
    chunkId: validEvidenceRef.chunkId,
    pageStart: 66,
    pageEnd: 66,
    sectionTitle: "门窗 / 尾门开启高度设置",
    sourceId: userGuideSourceId,
    text: validEvidenceRef.excerpt,
  },
  {
    chunkId: secondEvidenceRef.chunkId,
    pageStart: 68,
    pageEnd: 68,
    sectionTitle: "门窗 / 前舱盖",
    sourceId: userGuideSourceId,
    text: secondEvidenceRef.excerpt,
  },
].map((item) => JSON.stringify(item)).join("\n");
const userGuideReads = [];
const userGuideRepository = createManualUserGuideRepository({
  corpusRegistry: MANUAL_CORPUS_REGISTRY,
  readFile: async (fileHandle, _encoding, kind) => {
    assert.equal(typeof fileHandle?.stat, "function");
    assert.ok(["pages", "chunks"].includes(kind));
    userGuideReads.push(kind);
    if (kind === "pages") return userGuidePages;
    if (kind === "chunks") return userGuideChunks;
    throw new Error("unexpected user-guide artifact kind");
  },
});
const userGuideLedger = new ManualEvidenceRunLedger();
userGuideLedger.record("run-userguide", [validEvidenceRef, secondEvidenceRef], { status: "hit" });
userGuideLedger.record("run-wrong-chunk", [secondEvidenceRef], { status: "hit" });

const copiedRegistryObject = Object.freeze({ ...MANUAL_CORPUS_REGISTRY });
assert.throws(
  () => createServer({
    manualRagOptions: { corpusRegistry: MANUAL_CORPUS_REGISTRY },
    manualUserGuideOptions: { corpusRegistry: copiedRegistryObject },
  }),
  (error) => error?.code === "manual-corpus-registry-mismatch",
  "different registry objects must fail fast even when their content is equal",
);

const mutableNestedRegistry = Object.freeze({
  ...MANUAL_CORPUS_REGISTRY,
  corpora: Object.freeze({
    ...MANUAL_CORPUS_REGISTRY.corpora,
    [userGuideSourceId]: {
      ...MANUAL_CORPUS_REGISTRY.corpora[userGuideSourceId],
    },
  }),
});
assert.throws(
  () => createServer({
    manualRagOptions: { corpusRegistry: mutableNestedRegistry },
  }),
  (error) => error?.code === "manual-corpus-registry-not-deep-frozen",
  "createServer must reject a registry whose nested object graph can drift",
);

let serverCorporaAccessorReads = 0;
const serverAccessorRegistry = {};
Object.defineProperty(serverAccessorRegistry, "corpora", {
  enumerable: true,
  get() {
    serverCorporaAccessorReads += 1;
    return MANUAL_CORPUS_REGISTRY.corpora;
  },
});
Object.freeze(serverAccessorRegistry);
assert.throws(
  () => createServer({
    manualRagOptions: { corpusRegistry: serverAccessorRegistry },
  }),
  (error) => error?.code === "manual-corpus-registry-not-deep-frozen",
  "createServer must reject registry accessors before composing dependencies",
);
assert.equal(
  serverCorporaAccessorReads,
  0,
  "createServer registry validation must not invoke a corpora accessor",
);

const serverInternalSlotRegistry = Object.freeze({
  ...MANUAL_CORPUS_REGISTRY,
  mutableMetadata: Object.freeze(new Map([["version", "driftable"]])),
});
assert.throws(
  () => createServer({
    manualRagOptions: { corpusRegistry: serverInternalSlotRegistry },
  }),
  (error) => error?.code === "manual-corpus-registry-not-deep-frozen",
  "createServer must reject frozen internal-slot containers",
);

const userGuideOnlyRegistry = Object.freeze({
  ...MANUAL_CORPUS_REGISTRY,
  corpora: Object.freeze({
    ...MANUAL_CORPUS_REGISTRY.corpora,
    [userGuideSourceId]: Object.freeze({
      ...userGuideCorpus,
      sourceVersion: "userguide-only-version",
    }),
  }),
});
const nonDefaultEvidenceRef = Object.freeze({
  ...validEvidenceRef,
  sourceVersion: "userguide-only-version",
});
const nonDefaultLedger = new ManualEvidenceRunLedger({ corpusRegistry: userGuideOnlyRegistry });
nonDefaultLedger.record("run-non-default-registry", [nonDefaultEvidenceRef], { status: "hit" });
assert.doesNotThrow(() => createServer({
  manualRagOptions: {
    corpusRegistry: userGuideOnlyRegistry,
    evidenceRunLedger: nonDefaultLedger,
  },
  manualUserGuideOptions: { corpusRegistry: userGuideOnlyRegistry },
}), "a ledger bound to the unified non-default registry must be accepted");
assert.throws(
  () => createServer({
    manualRagOptions: {
      corpusRegistry: userGuideOnlyRegistry,
      evidenceRunLedger: new ManualEvidenceRunLedger(),
    },
    manualUserGuideOptions: { corpusRegistry: userGuideOnlyRegistry },
  }),
  (error) => error?.code === "manual-evidence-ledger-registry-mismatch",
  "an explicitly injected ledger bound to another registry must fail fast",
);
assert.throws(
  () => createServer({
    manualRagOptions: { corpusRegistry: userGuideOnlyRegistry },
    manualUserGuideOptions: { repository: userGuideRepository },
  }),
  (error) => error?.code === "manual-userguide-repository-registry-mismatch",
  "an explicitly injected repository bound to another registry must fail fast",
);
assert.throws(
  () => createServer({
    manualUserGuideOptions: {
      repository: {
        getBrowseDocument: async () => null,
        getEvidenceTarget: async () => null,
        getPdfAsset: () => null,
      },
    },
  }),
  (error) => error?.code === "manual-userguide-repository-registry-mismatch",
  "an explicitly injected repository without registry identity proof must fail fast",
);
assert.throws(
  () => createServer({
    manualRagOptions: {
      evidenceRunLedger: {
        usesCorpusRegistry: () => true,
        record: () => {},
        get: () => null,
        find: () => null,
      },
    },
  }),
  (error) => error?.code === "manual-evidence-ledger-registry-mismatch",
  "a forged ledger registry self-report must fail fast",
);
assert.throws(
  () => createServer({
    manualUserGuideOptions: {
      repository: {
        usesCorpusRegistry: () => true,
        getBrowseDocument: async () => null,
        getEvidenceTarget: async () => null,
        getPdfAsset: () => null,
      },
    },
  }),
  (error) => error?.code === "manual-userguide-repository-registry-mismatch",
  "a forged repository registry self-report must fail fast",
);

const nonDefaultRepository = createManualUserGuideRepository({
  corpusRegistry: userGuideOnlyRegistry,
  readFile: async (_fileHandle, _encoding, kind) => (
    kind === "pages" ? userGuidePages : userGuideChunks
  ),
});
const nonDefaultE2eLedger = new ManualEvidenceRunLedger({ corpusRegistry: userGuideOnlyRegistry });
const nonDefaultE2eServer = createServer({
  manualRagOptions: {
    corpusRegistry: userGuideOnlyRegistry,
    evidenceRunLedger: nonDefaultE2eLedger,
    buildVectorEvidenceSummary: async (query) => ({
      query,
      evidence: [nonDefaultEvidenceRef],
      summary: "non-default registry hit",
      telemetry: { retrievalMode: "vector-bge-m3", embeddingStatus: "embedded" },
    }),
  },
  manualUserGuideOptions: {
    corpusRegistry: userGuideOnlyRegistry,
    repository: nonDefaultRepository,
  },
});
const nonDefaultRagResponse = await invokeServerManualRag(nonDefaultE2eServer, {
  query: "non-default registry end to end",
  runId: "run-non-default-e2e",
});
assert.equal(nonDefaultRagResponse.statusCode, 200);
assert.equal(nonDefaultRagResponse.body.status, "hit");
assert.equal(
  nonDefaultE2eLedger.get("run-non-default-e2e")?.evidenceRefs[0]?.sourceVersion,
  "userguide-only-version",
  "the real manual RAG handler must persist the non-default evidence in the bound ledger",
);
const nonDefaultTargetResponse = await invokeServerGet(
  nonDefaultE2eServer,
  `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=${encodeURIComponent(nonDefaultEvidenceRef.chunkId)}&run=run-non-default-e2e`,
);
assert.equal(nonDefaultTargetResponse.statusCode, 200);
assert.equal(nonDefaultTargetResponse.body.source.sourceVersion, "userguide-only-version");
assert.deepEqual(nonDefaultTargetResponse.body.currentEvidence, nonDefaultEvidenceRef);
const userGuideOnlyRegistryServer = createServer({
  manualRagOptions: {
    runIdFactory: () => "run-shared-registry",
    buildVectorEvidenceSummary: async () => ({
      query: "shared registry",
      evidence: [validEvidenceRef],
      summary: "must be rejected against the shared registry",
      telemetry: { retrievalMode: "vector-bge-m3", embeddingStatus: "embedded" },
    }),
  },
  manualUserGuideOptions: { corpusRegistry: userGuideOnlyRegistry },
});
const sharedRegistryResponse = await invokeServerManualRag(
  userGuideOnlyRegistryServer,
  { query: "shared registry" },
);
assert.equal(sharedRegistryResponse.body.status, "unavailable");
assert.equal(
  sharedRegistryResponse.body.reason,
  "invalid-evidence-ref:source-version-mismatch",
  "manual RAG must use a registry supplied only through user-guide options",
);

const userGuideServer = createServer({
  manualRagOptions: { evidenceRunLedger: userGuideLedger },
  manualUserGuideOptions: {
    repository: userGuideRepository,
  },
});

const browseResponse = await invokeServerGet(
  userGuideServer,
  `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}`,
);
assert.equal(browseResponse.statusCode, 200);
assert.equal(browseResponse.body.source.sourceVersion, userGuideCorpus.sourceVersion);
assert.equal(browseResponse.body.source.contentDigest, userGuideCorpus.contentDigest);
assert.deepEqual(browseResponse.body.pages.map((page) => page.pageNumber), [66, 68]);
assert.equal(Object.hasOwn(browseResponse.body, "currentEvidence"), false);
assert.equal(Object.hasOwn(browseResponse.body, "highlight"), false);
assert.doesNotMatch(JSON.stringify(browseResponse.body), /filePath/);
assert.equal(
  browseResponse.body.pdfUrl,
  `/api/userguide/pdf?source=${encodeURIComponent(userGuideSourceId)}`,
);
assert.doesNotMatch(browseResponse.body.pdfUrl, /#page=|page=/i);

const targetResponse = await invokeServerGet(
  userGuideServer,
  `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=${encodeURIComponent(validEvidenceRef.chunkId)}&run=run-userguide`,
);
assert.equal(targetResponse.statusCode, 200);
assert.equal(targetResponse.body.source.sourceVersion, userGuideCorpus.sourceVersion);
assert.equal(targetResponse.body.source.contentDigest, userGuideCorpus.contentDigest);
assert.deepEqual(targetResponse.body.pages.map((page) => page.pageNumber), [66]);
assert.deepEqual(targetResponse.body.currentEvidence, validEvidenceRef);
assert.deepEqual(targetResponse.body.evidence, [validEvidenceRef, secondEvidenceRef]);
assert.equal(targetResponse.body.highlight.pageStart, 66);
assert.doesNotMatch(JSON.stringify(targetResponse.body), /filePath/);

const traversalReadCount = userGuideReads.length;
const traversalResponse = await invokeServerGet(
  userGuideServer,
  "/api/userguide?source=..%2F..%2Fetc%2Fpasswd",
);
assert.equal(traversalResponse.statusCode, 404);
assert.equal(userGuideReads.length, traversalReadCount, "traversal source must not reach readFile");

const maliciousCases = [
  [
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&source=${encodeURIComponent(userGuideSourceId)}`,
    400,
  ],
  [
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=${encodeURIComponent(validEvidenceRef.chunkId)}&chunk=${encodeURIComponent(validEvidenceRef.chunkId)}&run=run-userguide`,
    400,
  ],
  [
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=${encodeURIComponent(validEvidenceRef.chunkId)}&run=run-userguide&run=run-userguide`,
    400,
  ],
  [
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=..%2F..%2Freferences%2FES8%E7%94%A8%E6%88%B7%E6%89%8B%E5%86%8C.pdf&run=run-userguide`,
    404,
  ],
  [
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=unknown-chunk&run=run-userguide`,
    404,
  ],
  [
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=${encodeURIComponent(validEvidenceRef.chunkId)}&run=run-userguide&page=999`,
    400,
  ],
  [
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&path=..%2F..%2Fetc%2Fpasswd`,
    400,
  ],
  [
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&highlight=forged`,
    400,
  ],
  [
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=${encodeURIComponent(validEvidenceRef.chunkId)}&run=unknown-run`,
    404,
  ],
  [
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=${encodeURIComponent(validEvidenceRef.chunkId)}&run=run-wrong-chunk`,
    404,
  ],
];
for (const [url, expectedStatus] of maliciousCases) {
  const response = await invokeServerGet(userGuideServer, url);
  assert.equal(response.statusCode, expectedStatus, url);
}
const unknownRunResponse = await invokeServerGet(
  userGuideServer,
  `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=${encodeURIComponent(validEvidenceRef.chunkId)}&run=unknown-run`,
);
assert.equal(unknownRunResponse.body.error.code, "evidence-run-expired");

const expiredLedger = new ManualEvidenceRunLedger();
expiredLedger.record("run-expired", [validEvidenceRef], { status: "hit" });
for (let index = 0; index < 100; index += 1) {
  expiredLedger.record(`newer-run-${index}`, [], { status: "miss" });
}
const expiredServer = createServer({
  manualRagOptions: { evidenceRunLedger: expiredLedger },
  manualUserGuideOptions: { repository: userGuideRepository },
});
const expiredResponse = await invokeServerGet(
  expiredServer,
  `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}&chunk=${encodeURIComponent(validEvidenceRef.chunkId)}&run=run-expired`,
);
assert.equal(expiredResponse.statusCode, 404);
assert.equal(expiredResponse.body.error.code, "evidence-run-expired");

const pdfResponse = await invokeServerGet(
  userGuideServer,
  `/api/userguide/pdf?source=${encodeURIComponent(userGuideSourceId)}`,
);
assert.equal(pdfResponse.statusCode, 200);
assert.equal(pdfResponse.headers["content-type"], "application/pdf");
assert.equal(pdfResponse.rawBody.subarray(0, 4).toString(), "%PDF");

const forgedPdfPageResponse = await invokeServerGet(
  userGuideServer,
  `/api/userguide/pdf?source=${encodeURIComponent(userGuideSourceId)}&page=999`,
);
assert.equal(forgedPdfPageResponse.statusCode, 400);
for (const extraParameter of [
  `source=${encodeURIComponent(userGuideSourceId)}`,
  "path=..%2F..%2Fetc%2Fpasswd",
  "highlight=forged",
]) {
  const extraPdfResponse = await invokeServerGet(
    userGuideServer,
    `/api/userguide/pdf?source=${encodeURIComponent(userGuideSourceId)}&${extraParameter}`,
  );
  assert.equal(extraPdfResponse.statusCode, 400);
}
const traversalPdfResponse = await invokeServerGet(
  userGuideServer,
  "/api/userguide/pdf?source=..%2F..%2Fetc%2Fpasswd",
);
assert.equal(traversalPdfResponse.statusCode, 404);

function createControlledPdfStream(parts) {
  let index = 0;
  const state = { nextCallCount: 0, returnCount: 0, destroyCount: 0 };
  const stream = {
    state,
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      state.nextCallCount += 1;
      const part = parts[index++];
      if (part instanceof Error) throw part;
      return part ?? { done: true, value: undefined };
    },
    async return() {
      state.returnCount += 1;
      return { done: true, value: undefined };
    },
    destroy() {
      state.destroyCount += 1;
    },
  };
  return stream;
}

function createPdfLifecycleResponse({ backpressure = false } = {}) {
  const response = new EventEmitter();
  response.destroyed = false;
  response.closed = false;
  response.headersSent = false;
  response.writableEnded = false;
  response.writeCount = 0;
  response.endCount = 0;
  response.destroyCount = 0;
  response.firstWrite = new Promise((resolve) => {
    response.markFirstWrite = resolve;
  });
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode;
    response.headers = headers;
    response.headersSent = true;
  };
  response.write = () => {
    response.writeCount += 1;
    response.markFirstWrite();
    return !backpressure;
  };
  response.end = () => {
    response.endCount += 1;
    response.writableEnded = true;
  };
  response.destroy = () => {
    response.destroyCount += 1;
    response.destroyed = true;
  };
  return response;
}

function pdfRequest() {
  return {
    method: "GET",
    url: `/api/userguide/pdf?source=${encodeURIComponent(userGuideSourceId)}`,
  };
}

function pdfRepositoryForStream(stream) {
  return {
    getPdfAsset: () => ({
      contentType: "application/pdf",
      openStream: async () => stream,
    }),
  };
}

const middleErrorStream = createControlledPdfStream([
  { done: false, value: Buffer.from("first") },
  Object.assign(new Error("EIO /secret/manual.pdf"), { code: "EIO" }),
]);
const middleErrorResponse = createPdfLifecycleResponse();
await handleManualUserGuidePdf(pdfRequest(), middleErrorResponse, {
  repository: pdfRepositoryForStream(middleErrorStream),
});
assert.equal(middleErrorResponse.headersSent, true);
assert.equal(
  middleErrorResponse.destroyCount + middleErrorResponse.endCount,
  1,
  "a mid-stream read error must terminate a response whose headers were sent",
);
assert.equal(middleErrorStream.state.returnCount, 1);
assert.equal(middleErrorStream.state.destroyCount, 1);
assert.equal(middleErrorStream.state.nextCallCount, 2, "ordinary iterator rejection must be awaited and consumed");

const preclosedStream = createControlledPdfStream([
  { done: true, value: undefined },
]);
const preclosedResponse = createPdfLifecycleResponse();
preclosedResponse.closed = true;
preclosedResponse.destroyed = true;
await handleManualUserGuidePdf(pdfRequest(), preclosedResponse, {
  repository: pdfRepositoryForStream(preclosedStream),
});
assert.equal(preclosedStream.state.nextCallCount, 0, "a preclosed response must not start iterator.next");
assert.equal(preclosedStream.state.returnCount, 1);
assert.equal(preclosedStream.state.destroyCount, 1);

const drainStream = createControlledPdfStream([
  { done: false, value: Buffer.from("first") },
  { done: true, value: undefined },
]);
const drainResponse = createPdfLifecycleResponse({ backpressure: true });
const drainPending = handleManualUserGuidePdf(pdfRequest(), drainResponse, {
  repository: pdfRepositoryForStream(drainStream),
});
await drainResponse.firstWrite;
drainResponse.emit("drain");
await drainPending;
assert.equal(drainResponse.endCount, 1);
assert.equal(drainStream.state.returnCount, 1);
assert.equal(drainStream.state.destroyCount, 1);

const closeStream = createControlledPdfStream([
  { done: false, value: Buffer.from("first") },
  { done: true, value: undefined },
]);
const closeResponse = createPdfLifecycleResponse({ backpressure: true });
const closePending = handleManualUserGuidePdf(pdfRequest(), closeResponse, {
  repository: pdfRepositoryForStream(closeStream),
});
await closeResponse.firstWrite;
closeResponse.closed = true;
closeResponse.destroyed = true;
closeResponse.emit("close");
await Promise.race([
  closePending,
  new Promise((_, reject) => setTimeout(
    () => reject(new Error("PDF handler hung after client close during drain")),
    100,
  )),
]);
assert.equal(closeStream.state.returnCount, 1);
assert.equal(closeStream.state.destroyCount, 1);

for (const [repositoryCode, secretMessage] of [
  ["userguide-artifact-unavailable", "ENOENT /secret/manual-pages.jsonl"],
  ["userguide-artifact-invalid", "invalid JSON at /secret/manual-chunks.jsonl"],
]) {
  const artifactErrorRepository = createManualUserGuideRepository({
    corpusRegistry: MANUAL_CORPUS_REGISTRY,
    readFile: async (_fileHandle, _encoding, kind) => {
      if (repositoryCode === "userguide-artifact-unavailable") {
        throw Object.assign(new Error(secretMessage), { code: "ENOENT" });
      }
      return kind === "pages" ? secretMessage : userGuideChunks;
    },
  });
  const artifactErrorServer = createServer({
    manualUserGuideOptions: {
      repository: artifactErrorRepository,
    },
  });
  const artifactErrorResponse = await invokeServerGet(
    artifactErrorServer,
    `/api/userguide?source=${encodeURIComponent(userGuideSourceId)}`,
  );
  assert.equal(artifactErrorResponse.statusCode, 503);
  assert.equal(artifactErrorResponse.body.error.code, repositoryCode);
  assert.doesNotMatch(JSON.stringify(artifactErrorResponse.body), /\/secret|ENOENT|manual-(?:pages|chunks)/);
}

console.log("manual rag API boundary verification passed");
