import { buildManualEvidenceSummary, retrieveManualChunks } from "../../src/manual/manual-rag-retriever.js";

const queries = ["车窗怎么控制", "尾门应急开启", "安全气囊注意事项", "保养轮胎"];

for (const query of queries) {
  const results = await retrieveManualChunks(query, { topK: 3 });
  console.log(`\n# ${query}`);
  console.log(
    `metadata retrievalMode=${results.metadata.retrievalMode} embeddingStatus=${results.metadata.embeddingStatus}`,
  );
  for (const result of results) {
    const page =
      result.pageStart === result.pageEnd ? result.pageStart : `${result.pageStart}-${result.pageEnd}`;
    console.log(
      `${result.chunkId} | page=${page} | category=${result.category} | score=${result.score} | ${result.sectionTitle}`,
    );
  }

  const evidence = await buildManualEvidenceSummary(query, { topK: 1 });
  console.log(`top evidence: ${evidence.summary.split("\n")[0]}`);
}
