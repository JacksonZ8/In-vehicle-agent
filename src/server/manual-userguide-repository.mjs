import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertDeepFrozenManualCorpusRegistry } from "./manual-corpus-registry-guard.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const physicalProjectRoot = realpathSync(projectRoot);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/i;
const corpusRegistryByRepository = new WeakMap();

export function manualUserGuideRepositoryUsesCorpusRegistry(repository, corpusRegistry) {
  return corpusRegistryByRepository.has(repository)
    && corpusRegistryByRepository.get(repository) === corpusRegistry;
}

export function createManualUserGuideRepository({ corpusRegistry, readFile } = {}) {
  assertDeepFrozenManualCorpusRegistry(corpusRegistry);
  if (readFile !== undefined && typeof readFile !== "function") {
    throw new TypeError("readFile must be a function");
  }

  const sources = new Map();
  for (const corpus of Object.values(corpusRegistry.corpora)) {
    const sourceId = nonEmptyString(corpus?.sourceId) ? corpus.sourceId : "";
    const sourceVersion = nonEmptyString(corpus?.sourceVersion) ? corpus.sourceVersion : "";
    const contentDigest = String(corpus?.contentDigest || "");
    if (!sourceId || !sourceVersion || !SHA256_DIGEST.test(contentDigest)) continue;

    const pagesArtifact = captureRegistryArtifact(corpus.pagesPath, "pages");
    const chunksArtifact = captureRegistryArtifact(corpus.artifacts?.chunksPath, "chunks");
    // The PDF is optional (it is not distributed publicly): browsing and evidence pages only need
    // pages/chunks, and getPdfAsset reports the PDF as unavailable when it is absent.
    const pdfArtifact = captureRegistryArtifact(corpus.pdfPath, "pdf");
    if (!pagesArtifact || !chunksArtifact || sources.has(sourceId)) continue;
    if (!pdfArtifact && !isAbsentRegistryArtifact(corpus.pdfPath)) continue;

    const source = Object.freeze({
      sourceId,
      sourceVersion,
      contentDigest,
      title: String(corpus.title || "用户手册"),
      model: String(corpus.model || ""),
      applicableModels: Object.freeze([...(corpus.applicableModels || [])]),
    });
    sources.set(sourceId, {
      source,
      pagesArtifact,
      chunksArtifact,
      pdfArtifact,
      documentPromise: null,
    });
  }

  async function loadDocument(record) {
    if (!record.documentPromise) {
      record.documentPromise = Promise.all([
        readSecureArtifact(record.pagesArtifact, readFile),
        readSecureArtifact(record.chunksArtifact, readFile),
      ]).then(([pagesText, chunksText]) => buildValidatedDocument({
        pagesText,
        chunksText,
        sourceId: record.source.sourceId,
      })).catch((error) => {
        if (["userguide-artifact-unavailable", "userguide-artifact-invalid"].includes(error?.code)) {
          throw error;
        }
        throw artifactError("userguide-artifact-invalid");
      });
    }
    return record.documentPromise;
  }

  const repository = Object.freeze({
    async getBrowseDocument(sourceId) {
      const record = sources.get(exactIdentifier(sourceId));
      if (!record) return null;
      const document = await loadDocument(record);
      return Object.freeze({ source: record.source, pages: document.pages });
    },

    async getEvidenceTarget({ runId, sourceId, chunkId, evidenceLedger } = {}) {
      const record = sources.get(exactIdentifier(sourceId));
      if (!record || !nonEmptyString(runId) || !nonEmptyString(chunkId)) return null;
      const snapshot = evidenceLedger?.get?.(runId);
      if (!snapshot || snapshot.status !== "hit" || !Array.isArray(snapshot.evidenceRefs)) return null;
      const currentEvidence = evidenceLedger?.find?.(runId, { sourceId, chunkId });
      if (!currentEvidence
        || currentEvidence.sourceId !== sourceId
        || currentEvidence.chunkId !== chunkId
        || currentEvidence.sourceVersion !== record.source.sourceVersion
        || !snapshot.evidenceRefs.some((ref) => sameEvidenceTarget(ref, currentEvidence))) return null;

      const document = await loadDocument(record);
      const chunk = document.chunks.get(chunkId);
      if (!chunk
        || currentEvidence.pageStart !== chunk.pageStart
        || currentEvidence.pageEnd !== chunk.pageEnd
        || !excerptComesFromChunk(currentEvidence.excerpt, chunk.text)) return null;

      const selectedPages = [];
      for (let pageNumber = chunk.pageStart; pageNumber <= chunk.pageEnd; pageNumber += 1) {
        const page = document.pagesByNumber.get(pageNumber);
        if (!page) return null;
        selectedPages.push(page);
      }
      const pages = Object.freeze(selectedPages);
      const locations = locateEvidenceExcerpt(pages, currentEvidence.excerpt);
      if (!locations) return null;

      return Object.freeze({
        source: record.source,
        pages,
        currentEvidence,
        evidence: snapshot.evidenceRefs,
        highlight: Object.freeze({
          chunkId: currentEvidence.chunkId,
          pageStart: currentEvidence.pageStart,
          pageEnd: currentEvidence.pageEnd,
          excerpt: currentEvidence.excerpt,
          locations,
        }),
      });
    },

    getPdfAsset(sourceId) {
      const record = sources.get(exactIdentifier(sourceId));
      if (!record?.pdfArtifact) return null;
      return Object.freeze({
        sourceId: record.source.sourceId,
        sourceVersion: record.source.sourceVersion,
        contentDigest: record.source.contentDigest,
        contentType: "application/pdf",
        async openStream() {
          const handle = await openSecureArtifact(record.pdfArtifact);
          try {
            return handle.createReadStream({ autoClose: true });
          } catch {
            await handle.close().catch(() => {});
            throw artifactError("userguide-artifact-unavailable");
          }
        },
      });
    },
  });
  corpusRegistryByRepository.set(repository, corpusRegistry);
  return repository;
}

// Only a configured PDF that does not exist at all may be skipped; anything present but not an
// admissible regular file inside the project (directory, symlink, escape) still rejects the source.
function isAbsentRegistryArtifact(value) {
  if (!nonEmptyString(value)) return false;
  const configuredPath = path.resolve(projectRoot, value);
  if (!isWithinRoot(projectRoot, configuredPath)) return false;
  try {
    lstatSync(configuredPath);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function captureRegistryArtifact(value, kind) {
  if (!nonEmptyString(value)) return null;
  try {
    const configuredPath = path.resolve(projectRoot, value);
    if (!isWithinRoot(projectRoot, configuredPath)) return null;
    const filePath = realpathSync(configuredPath);
    if (!isWithinRoot(physicalProjectRoot, filePath)) return null;
    const stats = statSync(filePath, { bigint: true });
    if (!stats.isFile()) return null;
    return Object.freeze({
      kind,
      filePath,
      dev: stats.dev,
      ino: stats.ino,
    });
  } catch {
    return null;
  }
}

async function readSecureArtifact(artifact, readFile) {
  const handle = await openSecureArtifact(artifact);
  try {
    const value = readFile
      ? await readFile(handle, "utf8", artifact.kind)
      : await handle.readFile({ encoding: "utf8" });
    await assertOpenArtifactIdentity(handle, artifact);
    return value;
  } catch (error) {
    if (error?.code === "userguide-artifact-unavailable") throw error;
    throw artifactError("userguide-artifact-unavailable");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function openSecureArtifact(artifact) {
  let handle;
  try {
    handle = await open(artifact.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    await assertOpenArtifactIdentity(handle, artifact);
    return handle;
  } catch {
    await handle?.close().catch(() => {});
    throw artifactError("userguide-artifact-unavailable");
  }
}

async function assertOpenArtifactIdentity(handle, artifact) {
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile() || stats.dev !== artifact.dev || stats.ino !== artifact.ino) {
    throw artifactError("userguide-artifact-unavailable");
  }
}

function isWithinRoot(rootPath, candidatePath) {
  return candidatePath.startsWith(`${rootPath}${path.sep}`);
}

function artifactError(code) {
  const error = new Error(code === "userguide-artifact-invalid"
    ? "user guide artifact is invalid"
    : "user guide artifact is unavailable");
  error.code = code;
  return error;
}

function buildValidatedDocument({ pagesText, chunksText, sourceId }) {
  const rawPages = parseJsonLines(pagesText);
  const rawChunks = parseJsonLines(chunksText);
  if (!rawPages.length || !rawChunks.length) throw artifactError("userguide-artifact-invalid");

  const pageNumbers = new Set();
  const pages = rawPages.map((page) => {
    if (!plainObject(page)
      || page.sourceId !== sourceId
      || !Number.isInteger(page.pageNumber)
      || page.pageNumber < 1
      || typeof page.text !== "string"
      || pageNumbers.has(page.pageNumber)) {
      throw artifactError("userguide-artifact-invalid");
    }
    pageNumbers.add(page.pageNumber);
    return Object.freeze({
      pageNumber: page.pageNumber,
      sourceId: page.sourceId,
      text: page.text,
      charCount: Number.isInteger(page.charCount) ? page.charCount : page.text.length,
    });
  }).sort((left, right) => left.pageNumber - right.pageNumber);
  const frozenPages = Object.freeze(pages);
  const pagesByNumber = new Map(frozenPages.map((page) => [page.pageNumber, page]));

  const chunks = new Map();
  for (const chunk of rawChunks) {
    const pageEnd = chunk?.pageEnd ?? chunk?.pageStart;
    if (!plainObject(chunk)
      || chunk.sourceId !== sourceId
      || !nonEmptyString(chunk.chunkId)
      || !Number.isInteger(chunk.pageStart)
      || !Number.isInteger(pageEnd)
      || chunk.pageStart < 1
      || pageEnd < chunk.pageStart
      || !nonEmptyString(chunk.text)
      || chunks.has(chunk.chunkId)) {
      throw artifactError("userguide-artifact-invalid");
    }
    chunks.set(chunk.chunkId, Object.freeze({
      chunkId: chunk.chunkId,
      sourceId: chunk.sourceId,
      pageStart: chunk.pageStart,
      pageEnd,
      sectionTitle: String(chunk.sectionTitle || ""),
      text: chunk.text,
    }));
  }
  return Object.freeze({ pages: frozenPages, pagesByNumber, chunks });
}

function sameEvidenceTarget(left, right) {
  return left?.sourceId === right?.sourceId
    && left?.sourceVersion === right?.sourceVersion
    && left?.chunkId === right?.chunkId
    && left?.pageStart === right?.pageStart
    && left?.pageEnd === right?.pageEnd
    && left?.excerpt === right?.excerpt;
}

function excerptComesFromChunk(excerpt, chunkText) {
  const normalizedExcerpt = normalizeExcerpt(excerpt);
  const normalizedChunk = normalizeWhitespace(chunkText);
  return Boolean(normalizedExcerpt) && normalizedChunk.includes(normalizedExcerpt);
}

function normalizeExcerpt(value) {
  const normalized = normalizeWhitespace(value);
  if (/^(?:\.|…|⋯|\s)+$/u.test(normalized)) return "";
  return normalized
    .replace(/^(?:(?:\.\.\.|…)\s*)+/u, "")
    .replace(/(?:\s*(?:\.\.\.|…))+$/u, "")
    .trim();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function locateEvidenceExcerpt(pages, excerpt) {
  const normalizedExcerpt = normalizeExcerpt(excerpt);
  if (!normalizedExcerpt) return null;

  let combined = "";
  const offsets = [];
  for (const page of pages) {
    const normalizedPage = normalizePageWithOffsets(page);
    if (!normalizedPage.value) continue;
    if (combined) {
      combined += " ";
      offsets.push(null);
    }
    combined += normalizedPage.value;
    offsets.push(...normalizedPage.offsets);
  }

  let matchStart = -1;
  let searchFrom = 0;
  for (;;) {
    const candidate = combined.indexOf(normalizedExcerpt, searchFrom);
    if (candidate < 0) break;
    if (matchStart >= 0) return null;
    matchStart = candidate;
    searchFrom = candidate + 1;
  }
  if (matchStart < 0) return null;

  const locations = [];
  const matchEnd = matchStart + normalizedExcerpt.length;
  for (let index = matchStart; index < matchEnd; index += 1) {
    const offset = offsets[index];
    if (!offset) continue;
    const current = locations.at(-1);
    if (current?.pageNumber === offset.pageNumber && offset.start <= current.end) {
      current.end = Math.max(current.end, offset.end);
    } else {
      locations.push({
        pageNumber: offset.pageNumber,
        start: offset.start,
        end: offset.end,
      });
    }
  }
  if (!locations.length) return null;
  const pageByNumber = new Map(pages.map((page) => [page.pageNumber, page]));
  const reconstructed = normalizeWhitespace(locations.map((location) => {
    const page = pageByNumber.get(location.pageNumber);
    if (!page || location.start < 0 || location.end > page.text.length || location.end <= location.start) {
      return "";
    }
    return page.text.slice(location.start, location.end);
  }).join(" "));
  if (reconstructed !== normalizedExcerpt) return null;
  return Object.freeze(locations.map((location) => Object.freeze(location)));
}

function normalizePageWithOffsets(page) {
  let value = "";
  const offsets = [];
  const text = page.text;
  for (let index = 0; index < text.length;) {
    if (/\s/u.test(text[index])) {
      const start = index;
      while (index < text.length && /\s/u.test(text[index])) index += 1;
      if (value && value.at(-1) !== " ") {
        value += " ";
        offsets.push({ pageNumber: page.pageNumber, start, end: index });
      }
      continue;
    }
    value += text[index];
    offsets.push({ pageNumber: page.pageNumber, start: index, end: index + 1 });
    index += 1;
  }
  if (value.endsWith(" ")) {
    value = value.slice(0, -1);
    offsets.pop();
  }
  return { value, offsets };
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function exactIdentifier(value) {
  return typeof value === "string" ? value : "";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
