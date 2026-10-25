import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { retrieveManualChunks } from "../../src/manual/manual-rag-retriever.js";

const source = await readFile(new URL("../../src/manual/manual-rag-retriever.js", import.meta.url), "utf8");

assert.doesNotMatch(source, /const\s+KEY_TERMS\b/, "manual fallback must not rely on a fixed domain KEY_TERMS list");
assert.match(source, /buildManualLexicalIndex/, "manual fallback should build a corpus-derived lexical index");
assert.match(source, /isManualAnchorToken/, "manual fallback should require a manual anchor before accepting candidates");
assert.match(source, /lexicalIndex:\s*"manual-corpus-lexical-index@0\.2\.0"/, "retrieval metadata should expose lexical index version");
assert.match(source, /manual-corpus-lexical-synonym-overlay@0\.1\.0/, "manual fallback should expose a versioned synonym overlay");

const cases = [
  {
    query: "遮阳帘怎么使用？",
    expectedChunk: "es8-manual-chunk-0068",
    expectedTitle: "门窗 / 遮阳帘",
  },
  {
    query: "智能香氛怎么调节？",
    expectedChunk: "es8-manual-chunk-0123",
    expectedTitle: "座椅与空调 / 智能香氛系统",
  },
  {
    query: "智能香薰怎么调节？",
    expectedChunk: "es8-manual-chunk-0123",
    expectedTitle: "座椅与空调 / 智能香氛系统",
  },
  {
    query: "遮阳板怎么使用？",
    expectedChunk: "es8-manual-chunk-0068",
    expectedTitle: "门窗 / 遮阳帘",
  },
  {
    query: "车外放电有什么限制？",
    expectedChunk: "es8-manual-chunk-0092",
    expectedTitle: "补能与供电 / 车外放电作业",
  },
];

for (const item of cases) {
  const evidence = await retrieveManualChunks(item.query, { topK: 3 });
  assert.equal(evidence.metadata.lexicalIndex, "manual-corpus-lexical-index@0.2.0");
  assert.ok(evidence.length > 0, `${item.query} should retrieve manual evidence`);
  assert.equal(evidence[0].chunkId, item.expectedChunk);
  assert.equal(evidence[0].sectionTitle, item.expectedTitle);
  assert.equal(evidence[0].retrievalMode, "keyword-fallback");
}

const unsupported = await retrieveManualChunks("ES8 能不能在水上航行？", { topK: 3 });
assert.equal(unsupported.length, 0, "unsupported body-fragment matches should stay below the evidence boundary");
assert.equal(unsupported.metadata.missReason, "low-confidence");

console.log(
  JSON.stringify(
    {
      status: "ok",
      lexicalIndex: "manual-corpus-lexical-index@0.2.0",
      corpusDrivenCases: cases.length,
      unsupportedMissReason: unsupported.metadata.missReason,
    },
    null,
    2,
  ),
);
