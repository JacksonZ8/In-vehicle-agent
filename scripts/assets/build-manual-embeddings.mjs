import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_MODEL = "BGE-base-zh-v1.5";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const dataDir = path.join(repoRoot, "data", "manual-rag");
const queuePath = path.join(dataDir, "es8-manual-embedding-queue.jsonl");
const embeddingsPath = path.join(dataDir, "es8-manual-embeddings.jsonl");
const manifestPath = path.join(dataDir, "es8-manual-embeddings-manifest.json");

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--limit") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--limit requires a positive integer value");
      }
      const limit = Number.parseInt(value, 10);
      if (!Number.isInteger(limit) || limit < 1 || String(limit) !== value) {
        throw new Error("--limit requires a positive integer value");
      }
      args.limit = limit;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

async function readQueue() {
  const queue = [];
  const reader = createInterface({
    input: createReadStream(queuePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of reader) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let row;
    try {
      row = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid JSON in ${path.relative(repoRoot, queuePath)} line ${lineNumber}: ${error.message}`);
    }

    if (!row.chunkId || !row.sourceId || !row.text) {
      throw new Error(
        `Invalid queue row at line ${lineNumber}: expected chunkId, sourceId, and text`,
      );
    }

    queue.push(row);
  }

  return queue;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();

  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!response.ok) {
    const detail = body?.error || body?.message || text || response.statusText;
    throw new Error(`Ollama request failed: HTTP ${response.status} ${detail}`);
  }

  return body;
}

async function listOllamaModels(baseUrl) {
  const body = await fetchJson(new URL("/api/tags", baseUrl));
  if (!Array.isArray(body.models)) {
    throw new Error("Ollama /api/tags response did not include a models array");
  }
  return body.models
    .map((model) => model?.name || model?.model)
    .filter((name) => typeof name === "string" && name.length > 0);
}

function hasModel(models, modelName) {
  return models.includes(modelName) || models.includes(`${modelName}:latest`);
}

async function embedText(baseUrl, modelName, text) {
  const body = await fetchJson(new URL("/api/embed", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      input: text,
    }),
  });

  const embedding = Array.isArray(body.embedding) ? body.embedding : body.embeddings?.[0];
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("Ollama /api/embed response did not include a non-empty embedding vector");
  }
  if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Ollama /api/embed returned a non-numeric embedding vector");
  }

  return embedding;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const embeddingModel = process.env.NIO_MANUAL_EMBEDDING_MODEL || DEFAULT_MODEL;
  const ollamaBaseUrl = process.env.NIO_OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;

  const queue = await readQueue();
  const selectedQueue = args.limit ? queue.slice(0, args.limit) : queue;

  console.log(`Manual embedding queue: ${queue.length} rows`);
  console.log(`Selected rows: ${selectedQueue.length}`);
  console.log(`Embedding model: ${embeddingModel}`);
  console.log(`Ollama base URL: ${ollamaBaseUrl}`);

  if (typeof fetch !== "function") {
    throw new Error("This Node.js runtime does not provide fetch. Use Node 18+ to build embeddings.");
  }

  let models = [];
  try {
    models = await listOllamaModels(ollamaBaseUrl);
  } catch (error) {
    if (args.dryRun) {
      console.warn(`Dry run: unable to reach Ollama /api/tags (${error.message}). No embeddings will be generated.`);
      return;
    }
    throw error;
  }

  console.log(`Ollama models: ${models.length ? models.join(", ") : "(none)"}`);
  if (!hasModel(models, embeddingModel)) {
    const message = [
      `Required embedding model is not installed in Ollama: ${embeddingModel}`,
      "Install or configure a compatible BGE embedding model before generating vectors.",
      "Set NIO_MANUAL_EMBEDDING_MODEL if the local model name differs.",
      "No embedding file was written.",
    ].join("\n");

    if (args.dryRun) {
      console.warn(`Dry run: ${message}`);
      return;
    }
    throw new Error(message);
  }

  if (args.dryRun) {
    console.log("Dry run complete: model is available. No embeddings were generated.");
    return;
  }

  await mkdir(dataDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const tempEmbeddingsPath = `${embeddingsPath}.tmp`;
  const tempManifestPath = `${manifestPath}.tmp`;
  const outputRows = [];
  let dimensions;

  try {
    for (const row of selectedQueue) {
      const embedding = await embedText(ollamaBaseUrl, embeddingModel, row.text);
      if (dimensions === undefined) {
        dimensions = embedding.length;
      } else if (dimensions !== embedding.length) {
        throw new Error(
          `Embedding dimension mismatch for ${row.chunkId}: expected ${dimensions}, got ${embedding.length}`,
        );
      }

      outputRows.push(
        JSON.stringify({
          chunkId: row.chunkId,
          sourceId: row.sourceId,
          embeddingModel,
          dimensions: embedding.length,
          embedding,
          status: "embedded",
          generatedAt,
        }),
      );
      console.log(`Embedded ${row.chunkId} (${outputRows.length}/${selectedQueue.length})`);
    }

    await writeFile(tempEmbeddingsPath, `${outputRows.join("\n")}\n`, "utf8");
    await writeFile(
      tempManifestPath,
      `${JSON.stringify(
        {
          sourceQueue: path.relative(repoRoot, queuePath),
          outputFile: path.relative(repoRoot, embeddingsPath),
          embeddingModel,
          ollamaBaseUrl,
          totalQueueRows: queue.length,
          generatedRows: outputRows.length,
          limit: args.limit ?? null,
          dimensions,
          status: "complete",
          generatedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await rename(tempEmbeddingsPath, embeddingsPath);
    await rename(tempManifestPath, manifestPath);
  } catch (error) {
    await rm(tempEmbeddingsPath, { force: true });
    await rm(tempManifestPath, { force: true });
    throw error;
  }

  console.log(`Wrote ${path.relative(repoRoot, embeddingsPath)}`);
  console.log(`Wrote ${path.relative(repoRoot, manifestPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
