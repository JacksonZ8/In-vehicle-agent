import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getManualVectorWarmupTelemetry,
  retrieveManualVectorChunks,
  warmManualEmbeddingModel,
  warmReadyManualVectorIndexes,
} from "../../src/manual/manual-rag-vector-retriever.js";

const ES8 = "nio-es8-user-manual-2026";
const ET5 = "nio-et5-user-manual-placeholder";

// Warming must load only ready artifacts; it must not create a query/result cache entry.
const initialWarmup = await warmReadyManualVectorIndexes();
assert.equal(initialWarmup.status, "ready");
assert.deepEqual(initialWarmup.corpora.map((corpus) => corpus.corpusId), [ES8]);
assert.equal(initialWarmup.corpora[0].status, "ready");
assert.equal(initialWarmup.corpora[0].generatedRows, 411);
assert.equal(initialWarmup.corpora[0].chunkCount, 411);
assert.ok(initialWarmup.corpora[0].durationMs >= 0);
assert.equal(getManualVectorWarmupTelemetry(ES8).status, "ready");

const placeholderWarmup = await warmReadyManualVectorIndexes({ corpusId: ET5 });
assert.equal(placeholderWarmup.corpora.length, 1);
assert.deepEqual(placeholderWarmup.corpora[0], {
  corpusId: ET5,
  status: "skipped",
  reason: "corpus-artifact-unavailable",
  durationMs: 0,
});

// A broken optional warmup is recorded, not thrown; startup can continue normally.
const failedWarmup = await warmReadyManualVectorIndexes({
  corpusId: ES8,
  chunksPath: "/private/tmp/nio-manual-warmup-missing-chunks.jsonl",
});
assert.equal(failedWarmup.status, "degraded");
assert.equal(failedWarmup.corpora[0].status, "failed");
assert.match(failedWarmup.corpora[0].reason, /ENOENT/);

// Restore the ready cache/state before proving the first real retrieval remains unchanged.
const restoredWarmup = await warmReadyManualVectorIndexes();
assert.equal(restoredWarmup.status, "ready");

const chunks = (await readJsonl(new URL("../../data/manual-rag/es8-manual-chunks.jsonl", import.meta.url)));
const embeddings = await readJsonl(new URL("../../data/manual-rag/es8-manual-embeddings.jsonl", import.meta.url));
const tailgateChunk = chunks.find((chunk) => String(chunk.sectionTitle).includes("尾门"));
assert.ok(tailgateChunk, "fixture needs an authoritative ES8 tailgate chunk");
const tailgateEmbedding = embeddings.find((row) => row.chunkId === tailgateChunk.chunkId)?.embedding;
assert.ok(Array.isArray(tailgateEmbedding) && tailgateEmbedding.length === 1024, "fixture needs the matching ES8 embedding");

const originalFetch = globalThis.fetch;
const embeddingBodies = [];
globalThis.fetch = async (url, options) => {
  assert.match(String(url), /\/api\/embed$/);
  embeddingBodies.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ embeddings: [tailgateEmbedding] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
try {
  const embeddingWarmup = await warmManualEmbeddingModel({
    corpusId: ES8,
    baseUrl: "http://manual-warmup-test.invalid",
  });
  assert.deepEqual(embeddingWarmup, {
    status: "ready",
    durationMs: embeddingWarmup.durationMs,
    corpusId: ES8,
    embeddingModel: "bge-m3",
    dimensions: 1024,
  });
  assert.deepEqual(embeddingBodies[0], {
    model: "bge-m3",
    input: "NIO manual retrieval model warmup",
    keep_alive: "24h",
  });

  const results = await retrieveManualVectorChunks("尾门怎么打开", {
    corpusId: ES8,
    vehicleModel: "ES8",
    topK: 1,
    baseUrl: "http://manual-warmup-test.invalid",
  });
  assert.equal(results.metadata.cacheHit, false, "warmup must not write a user query result cache entry");
  assert.equal(results.metadata.indexWarmup.status, "ready");
  assert.equal(results.length, 1, "first real query must still retrieve reviewed evidence");
  assert.equal(results[0].chunkId, tailgateChunk.chunkId);
  assert.equal(results[0].sourceId, ES8);
  assert.match(results[0].citation, /蔚来 ES8 用户手册/);
  assert.deepEqual(embeddingBodies[1], {
    model: "bge-m3",
    input: "尾门怎么打开",
    keep_alive: "24h",
  }, "the first user query must perform its own embedding with the same keep-alive");
  assert.equal(embeddingBodies.length, 2);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Manual RAG startup warmup checks passed.");

async function readJsonl(url) {
  return (await readFile(url, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
