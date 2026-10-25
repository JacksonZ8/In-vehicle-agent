# ES8 Manual RAG Data

Generated from `ES8用户手册.pdf` for the P0 manual RAG preparation step.

This is a metadata-only migration: `sourceVersion` and `contentDigest` version the ES8 manual source while chunks and embeddings remain unchanged. `contentDigest` is the SHA-256 of `references/ES8用户手册.pdf`.

- `es8-manual-source.json`: source metadata, PDF metadata, page count, extraction tool, and chunking version.
- `es8-manual-pages.jsonl`: one extracted text row per PDF page.
- `es8-manual-chunks.jsonl`: deterministic text chunks with page spans, section titles, categories, tags, and `embeddingStatus: "pending"`.
- `es8-manual-embedding-queue.jsonl`: pending embedding queue rows for `BGE-base-zh-v1.5`.
- `es8-manual-embeddings.jsonl`: contains 411 real embeddings generated with local Ollama `bge-m3`; never create fake vectors.
- `es8-manual-embeddings-manifest.json`: generated with the embedding run metadata when vectors are built.
- `es8-manual-rag-golden-v1.json`: versioned retrieval-quality golden set. Its expected chunk/page/section metadata is checked against `es8-manual-chunks.jsonl` before evaluation.

Chunking uses stable page heading/title heuristics plus ~900 Chinese-character windows with ~100 characters of overlap. Full 411-chunk embedding generation and vector runtime integration are available in the fixed local service.

Embedding build script:

- Run `node scripts/build-manual-embeddings.mjs --dry-run` from the project root to validate the queue and report the configured model without writing vectors.
- Run `NIO_MANUAL_EMBEDDING_MODEL=bge-m3 node scripts/build-manual-embeddings.mjs --limit 3` for the current small real generation test after installing Ollama `bge-m3`.
- The default embedding model is `BGE-base-zh-v1.5`; override with `NIO_MANUAL_EMBEDDING_MODEL`.
- The default Ollama URL is `http://127.0.0.1:11434`; override with `NIO_OLLAMA_BASE_URL`.
- Current local Ollama setup includes `bge-m3:latest`, `qwen2.5:3b`, and `qwen2.5:7b`. `bge-m3` is the current BGE-compatible embedding model for local validation; exact `BGE-base-zh-v1.5` remains the default adapter target unless overridden.

Adapter status:

- `manual-rag-retriever.js` provides a read-only keyword/category fallback retriever over `es8-manual-chunks.jsonl`.
- Retrieval metadata is explicitly marked `retrievalMode: "keyword-fallback"` and `embeddingStatus: "pending"`.
- It remains the auditable fallback when vector retrieval is unavailable and does not generate embeddings.

Quality evaluation:

- Run `node scripts/evaluate-manual-rag-quality.mjs` while the fixed `4173` service is available.
- The evaluator calls `POST /api/manual-rag` for operation, safety, fault, and maintenance cases and reports Recall@K, expected-citation hit rate, returned-citation integrity, category summaries, and each case's topK results.
- Defaults are topK `3`, minimum Recall@K `0.75`, and minimum citation hit rate `0.75`. Override with `NIO_MANUAL_RAG_EVAL_TOP_K`, `NIO_MANUAL_RAG_MIN_RECALL`, `NIO_MANUAL_RAG_MIN_CITATION_HIT_RATE`, or `NIO_AGENT_BASE_URL`.
- Threshold failures and any citation metadata inconsistent with the authoritative chunks exit non-zero.
