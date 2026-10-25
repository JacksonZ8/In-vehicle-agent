import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MANUAL_CORPUS_REGISTRY } from "../../src/manual/manual-corpus-registry.js";
import { ManualEvidenceRunLedger } from "../../src/server/manual-evidence-run-ledger.mjs";
import * as repositoryModule from "../../src/server/manual-userguide-repository.mjs";

const {
  createManualUserGuideRepository,
  manualUserGuideRepositoryUsesCorpusRegistry,
} = repositoryModule;

assert.equal(
  typeof manualUserGuideRepositoryUsesCorpusRegistry,
  "function",
  "repository registry identity proof must be an unforgeable module export",
);

const sourceId = "nio-es8-user-manual-2026";
const corpus = MANUAL_CORPUS_REGISTRY.corpora[sourceId];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pagesJsonl = [
  { charCount: 27, pageNumber: 66, sourceId, text: "页眉\n您可以设置并记忆尾门的开启高度。\n页脚" },
  { charCount: 26, pageNumber: 68, sourceId, text: "页眉\n行车前，请务必确认前舱盖已正确关闭。\n页脚" },
].map((item) => JSON.stringify(item)).join("\n");
const chunksJsonl = [
  {
    chunkId: "es8-manual-chunk-0055",
    pageStart: 66,
    pageEnd: 66,
    sectionTitle: "门窗 / 尾门开启高度设置",
    sourceId,
    text: "您可以设置并记忆尾门的开启高度。",
  },
  {
    chunkId: "es8-manual-chunk-0057",
    pageStart: 68,
    pageEnd: 68,
    sectionTitle: "门窗 / 前舱盖",
    sourceId,
    text: "行车前，请务必确认前舱盖已正确关闭。",
  },
].map((item) => JSON.stringify(item)).join("\n");
const artifactReads = [];

async function readAllowlistedArtifact(fileHandle, encoding, kind) {
  assert.equal(typeof fileHandle?.stat, "function", "readFile seam must receive a safe open handle");
  assert.equal(encoding, "utf8");
  assert.ok(["pages", "chunks"].includes(kind), "readFile seam must receive only a safe artifact kind");
  artifactReads.push(kind);
  if (kind === "pages") return pagesJsonl;
  if (kind === "chunks") return chunksJsonl;
  throw new Error("unexpected artifact kind");
}

function evidenceRef(chunkId, pageStart, excerpt) {
  return Object.freeze({
    sourceId,
    sourceVersion: corpus.sourceVersion,
    chunkId,
    pageStart,
    pageEnd: pageStart,
    excerpt,
    score: Object.freeze({ retrieval: 0.72, rerank: null, grounding: null }),
  });
}

const firstEvidence = evidenceRef(
  "es8-manual-chunk-0055",
  66,
  "您可以设置并记忆尾门的开启高度。",
);
const secondEvidence = evidenceRef(
  "es8-manual-chunk-0057",
  68,
  "行车前，请务必确认前舱盖已正确关闭。",
);
const repository = createManualUserGuideRepository({
  corpusRegistry: MANUAL_CORPUS_REGISTRY,
  readFile: readAllowlistedArtifact,
});
assert.equal(
  Object.hasOwn(repository, "usesCorpusRegistry"),
  false,
  "repository must not expose a forgeable registry self-report",
);
assert.equal(manualUserGuideRepositoryUsesCorpusRegistry(repository, MANUAL_CORPUS_REGISTRY), true);
assert.equal(
  manualUserGuideRepositoryUsesCorpusRegistry(repository, Object.freeze({ ...MANUAL_CORPUS_REGISTRY })),
  false,
);
assert.equal(manualUserGuideRepositoryUsesCorpusRegistry({
  usesCorpusRegistry: () => true,
}, MANUAL_CORPUS_REGISTRY), false, "a forged self-report must not acquire the repository brand");
assert.equal(
  manualUserGuideRepositoryUsesCorpusRegistry({}, undefined),
  false,
  "an unbranded value must not match merely because both registry lookups are undefined",
);

const mutableNestedRegistry = Object.freeze({
  ...MANUAL_CORPUS_REGISTRY,
  corpora: Object.freeze({
    ...MANUAL_CORPUS_REGISTRY.corpora,
    [sourceId]: {
      ...MANUAL_CORPUS_REGISTRY.corpora[sourceId],
    },
  }),
});
assert.throws(
  () => createManualUserGuideRepository({ corpusRegistry: mutableNestedRegistry }),
  (error) => error?.code === "manual-corpus-registry-not-deep-frozen",
  "a top-level frozen registry with mutable nested state must fail fast",
);

function registryWithCorpus(candidateCorpus) {
  return Object.freeze({
    ...MANUAL_CORPUS_REGISTRY,
    corpora: Object.freeze({
      ...MANUAL_CORPUS_REGISTRY.corpora,
      [sourceId]: candidateCorpus,
    }),
  });
}

function frozenObjectWithInheritedField(object, field) {
  const { [field]: inheritedValue, ...ownProperties } = object;
  return Object.freeze(Object.assign(
    Object.create(Object.freeze({ [field]: inheritedValue })),
    ownProperties,
  ));
}

for (const field of ["sourceId", "sourceVersion", "contentDigest", "artifacts", "pagesPath", "pdfPath"]) {
  assert.throws(
    () => createManualUserGuideRepository({
      corpusRegistry: registryWithCorpus(frozenObjectWithInheritedField(corpus, field)),
    }),
    (error) => error?.code === "manual-corpus-registry-not-deep-frozen",
    `a corpus must not inherit its ${field} field`,
  );
}

const inheritedChunksArtifacts = frozenObjectWithInheritedField(corpus.artifacts, "chunksPath");
assert.throws(
  () => createManualUserGuideRepository({
    corpusRegistry: registryWithCorpus(Object.freeze({
      ...corpus,
      artifacts: inheritedChunksArtifacts,
    })),
  }),
  (error) => error?.code === "manual-corpus-registry-not-deep-frozen",
  "artifact paths must be own data properties",
);

assert.equal(
  await repository.getBrowseDocument("../../../../etc/passwd"),
  null,
  "a traversal source must not resolve to any file",
);
assert.equal(artifactReads.length, 0, "a rejected source must not trigger an artifact read");
assert.equal(await repository.getPdfAsset("../references/ES8用户手册.pdf"), null);
assert.equal(artifactReads.length, 0, "a forged PDF source must not trigger an artifact read");

const browse = await repository.getBrowseDocument(sourceId);
assert.equal(browse.source.sourceId, sourceId);
assert.equal(browse.source.sourceVersion, corpus.sourceVersion);
assert.equal(browse.source.contentDigest, corpus.contentDigest);
assert.deepEqual(browse.pages.map((page) => page.pageNumber), [66, 68]);
assert.equal(Object.hasOwn(browse, "currentEvidence"), false);
assert.equal(Object.hasOwn(browse, "highlight"), false);

const ledger = new ManualEvidenceRunLedger();
ledger.record("run-target", [firstEvidence, secondEvidence], { status: "hit" });
const target = await repository.getEvidenceTarget({
  runId: "run-target",
  sourceId,
  chunkId: firstEvidence.chunkId,
  evidenceLedger: ledger,
});
assert.equal(target.source.sourceVersion, corpus.sourceVersion);
assert.equal(target.source.contentDigest, corpus.contentDigest);
assert.deepEqual(target.pages.map((page) => page.pageNumber), [66]);
assert.deepEqual(target.currentEvidence, firstEvidence);
assert.deepEqual(target.evidence, [firstEvidence, secondEvidence]);
assert.deepEqual(target.highlight, {
  chunkId: firstEvidence.chunkId,
  pageStart: 66,
  pageEnd: 66,
  excerpt: firstEvidence.excerpt,
  locations: [{
    pageNumber: 66,
    start: "页眉\n".length,
    end: "页眉\n".length + firstEvidence.excerpt.length,
  }],
});

assert.equal(await repository.getEvidenceTarget({
  runId: "run-target",
  sourceId,
  chunkId: "../../references/ES8用户手册.pdf",
  evidenceLedger: ledger,
}), null, "a chunk injection must not become a file path");
assert.equal(await repository.getEvidenceTarget({
  runId: "run-target",
  sourceId,
  chunkId: "unknown-chunk",
  evidenceLedger: ledger,
}), null, "an unknown chunk must not fall back to arbitrary highlighting");
assert.equal(await repository.getEvidenceTarget({
  runId: "unknown-run",
  sourceId,
  chunkId: firstEvidence.chunkId,
  evidenceLedger: ledger,
}), null, "an unknown run must not authorize a target");

ledger.record("run-other", [secondEvidence], { status: "hit" });
assert.equal(await repository.getEvidenceTarget({
  runId: "run-other",
  sourceId,
  chunkId: firstEvidence.chunkId,
  evidenceLedger: ledger,
}), null, "a chunk absent from the requested run must be rejected");

const forgedEvidence = Object.freeze({ ...firstEvidence, pageStart: 999, pageEnd: 999 });
const forgedLedger = {
  get: () => Object.freeze({
    runId: "run-forged-page",
    status: "hit",
    evidenceRefs: Object.freeze([forgedEvidence]),
  }),
  find: () => forgedEvidence,
};
assert.equal(await repository.getEvidenceTarget({
  runId: "run-forged-page",
  sourceId,
  chunkId: firstEvidence.chunkId,
  evidenceLedger: forgedLedger,
}), null, "a forged ledger page must not select a page");

const pdfAsset = await repository.getPdfAsset(sourceId);
if (existsSync(path.join(projectRoot, corpus.pdfPath))) {
  assert.equal(pdfAsset.sourceId, sourceId);
  assert.equal(pdfAsset.sourceVersion, corpus.sourceVersion);
  assert.equal(pdfAsset.contentDigest, corpus.contentDigest);
  assert.equal(pdfAsset.contentType, "application/pdf");
  assert.equal(Object.hasOwn(pdfAsset, "filePath"), false, "repository must not expose filesystem paths");
  assert.equal(typeof pdfAsset.openStream, "function");
} else {
  assert.equal(pdfAsset, null, "a manual whose PDF is not present must report the PDF as unavailable");
}

assert.deepEqual(
  [...new Set(artifactReads)].sort(),
  ["chunks", "pages"],
  "repository reads must be selected only from registry artifact paths",
);
assert.equal(
  artifactReads.some((kind) => path.isAbsolute(kind) || kind.includes("..")),
  false,
);

function repositoryWithArtifactText({ pagesText = pagesJsonl, chunksText = chunksJsonl } = {}) {
  return createManualUserGuideRepository({
    corpusRegistry: MANUAL_CORPUS_REGISTRY,
    readFile: async (_fileHandle, _encoding, kind) => (
      kind === "pages" ? pagesText : chunksText
    ),
  });
}

await assert.rejects(
  repositoryWithArtifactText({ pagesText: "{invalid-jsonl /secret/pages.jsonl" })
    .getBrowseDocument(sourceId),
  (error) => (
    error?.code === "userguide-artifact-invalid"
    && !String(error.message).includes("/secret/pages.jsonl")
  ),
  "invalid JSONL must become a stable path-free repository error",
);

function jsonl(...items) {
  return items.map((item) => JSON.stringify(item)).join("\n");
}

const page66 = { charCount: 21, pageNumber: 66, sourceId, text: "尾门开启高度设置页面" };
const chunk55 = {
  chunkId: firstEvidence.chunkId,
  pageStart: 66,
  pageEnd: 66,
  sectionTitle: "门窗 / 尾门开启高度设置",
  sourceId,
  text: firstEvidence.excerpt,
};
const invalidArtifactCases = [
  {
    label: "duplicate page number",
    pagesText: jsonl(page66, { ...page66, text: "duplicate page" }),
    chunksText: jsonl(chunk55),
  },
  {
    label: "wrong page source",
    pagesText: jsonl({ ...page66, sourceId: "wrong-source" }),
    chunksText: jsonl(chunk55),
  },
  {
    label: "invalid page number",
    pagesText: jsonl({ ...page66, pageNumber: 0 }),
    chunksText: jsonl(chunk55),
  },
  {
    label: "duplicate chunk id",
    pagesText: jsonl(page66),
    chunksText: jsonl(chunk55, { ...chunk55, text: "overwriting text" }),
  },
  {
    label: "wrong chunk source",
    pagesText: jsonl(page66),
    chunksText: jsonl({ ...chunk55, sourceId: "wrong-source" }),
  },
  {
    label: "invalid chunk page range",
    pagesText: jsonl(page66),
    chunksText: jsonl({ ...chunk55, pageStart: 67, pageEnd: 66 }),
  },
];
for (const invalidCase of invalidArtifactCases) {
  await assert.rejects(
    repositoryWithArtifactText(invalidCase).getBrowseDocument(sourceId),
    (error) => error?.code === "userguide-artifact-invalid",
    `${invalidCase.label} must fail the entire artifact instead of being filtered or overwritten`,
  );
}

function ledgerForRef(ref) {
  return {
    get: () => Object.freeze({
      runId: "run-forged",
      status: "hit",
      evidenceRefs: Object.freeze([ref]),
    }),
    find: () => ref,
  };
}

const crossPageEvidence = Object.freeze({
  ...firstEvidence,
  chunkId: "cross-page-chunk",
  pageStart: 70,
  pageEnd: 71,
  excerpt: "跨页证据前半 后半结束",
});
const crossPageRepository = repositoryWithArtifactText({
  pagesText: jsonl(
    { charCount: 12, pageNumber: 70, sourceId, text: "页眉 跨页证据前半" },
    { charCount: 11, pageNumber: 71, sourceId, text: "后半结束 页脚" },
  ),
  chunksText: jsonl({
    chunkId: crossPageEvidence.chunkId,
    pageStart: 70,
    pageEnd: 71,
    sectionTitle: "跨页证据",
    sourceId,
    text: "跨页证据前半\n后半结束",
  }),
});
const crossPageTarget = await crossPageRepository.getEvidenceTarget({
  runId: "run-cross-page",
  sourceId,
  chunkId: crossPageEvidence.chunkId,
  evidenceLedger: ledgerForRef(crossPageEvidence),
});
assert.deepEqual(crossPageTarget?.highlight.locations, [
  { pageNumber: 70, start: "页眉 ".length, end: "页眉 跨页证据前半".length },
  { pageNumber: 71, start: 0, end: "后半结束".length },
], "a unique normalized excerpt spanning two real pages must carry authoritative offsets");

const ambiguousEvidence = Object.freeze({
  ...firstEvidence,
  chunkId: "ambiguous-chunk",
  pageStart: 72,
  pageEnd: 72,
  excerpt: "重复证据",
});
const ambiguousRepository = repositoryWithArtifactText({
  pagesText: jsonl({
    charCount: 15,
    pageNumber: 72,
    sourceId,
    text: "重复证据 中间 重复证据",
  }),
  chunksText: jsonl({
    chunkId: ambiguousEvidence.chunkId,
    pageStart: 72,
    pageEnd: 72,
    sectionTitle: "歧义证据",
    sourceId,
    text: "重复证据 中间 重复证据",
  }),
});
assert.equal(await ambiguousRepository.getEvidenceTarget({
  runId: "run-ambiguous",
  sourceId,
  chunkId: ambiguousEvidence.chunkId,
  evidenceLedger: ledgerForRef(ambiguousEvidence),
}), null, "an excerpt repeated in the selected page range must fail closed instead of choosing the first match");

const rangedEvidenceWithMissingPage = Object.freeze({
  ...firstEvidence,
  pageEnd: 67,
});
const missingPageRepository = repositoryWithArtifactText({
  pagesText: jsonl(page66),
  chunksText: jsonl({ ...chunk55, pageEnd: 67 }),
});
assert.equal(await missingPageRepository.getEvidenceTarget({
  runId: "run-forged",
  sourceId,
  chunkId: firstEvidence.chunkId,
  evidenceLedger: ledgerForRef(rangedEvidenceWithMissingPage),
}), null, "every page in the target interval must exist exactly once");

const maliciousExcerpt = Object.freeze({
  ...firstEvidence,
  excerpt: "未在 registry chunk 中出现的伪造操作指令。",
});
assert.equal(await repository.getEvidenceTarget({
  runId: "run-forged",
  sourceId,
  chunkId: firstEvidence.chunkId,
  evidenceLedger: ledgerForRef(maliciousExcerpt),
}), null, "ledger excerpt must be a normalized substring of registry chunk.text");

const artifactDivergedRepository = repositoryWithArtifactText({
  chunksText: jsonl({
    ...chunk55,
    text: "captured artifact no longer contains the accepted ledger excerpt",
  }),
});
assert.equal(await artifactDivergedRepository.getEvidenceTarget({
  runId: "run-target",
  sourceId,
  chunkId: firstEvidence.chunkId,
  evidenceLedger: ledger,
}), null, "the repository's captured artifact must remain the final target authority after ledger acceptance");

const abbreviatedExcerpt = Object.freeze({
  ...firstEvidence,
  excerpt: "  ...  您可以设置并记忆尾门的开启高度。  …  ",
});
assert.ok(await repository.getEvidenceTarget({
  runId: "run-forged",
  sourceId,
  chunkId: firstEvidence.chunkId,
  evidenceLedger: ledgerForRef(abbreviatedExcerpt),
}), "leading/trailing ellipsis and whitespace are valid excerpt abbreviation markers");

for (const marker of ["⋯", ". . ."]) {
  const markerRepository = repositoryWithArtifactText({
    pagesText: jsonl(page66),
    chunksText: jsonl({ ...chunk55, text: `说明 ${marker}` }),
  });
  const markerEvidence = Object.freeze({ ...firstEvidence, excerpt: marker });
  assert.equal(await markerRepository.getEvidenceTarget({
    runId: "run-forged",
    sourceId,
    chunkId: firstEvidence.chunkId,
    evidenceLedger: ledgerForRef(markerEvidence),
  }), null, `marker-only excerpt ${marker} must never become a highlight`);
}

function fixtureRegistry(fixtureSourceId, directory, overrides = {}) {
  return Object.freeze({
    id: "fixture-registry",
    version: "1.2.0",
    defaultCorpusId: fixtureSourceId,
    corpora: Object.freeze({
      [fixtureSourceId]: Object.freeze({
        sourceId: fixtureSourceId,
        sourceVersion: "1",
        contentDigest: `sha256:${"a".repeat(64)}`,
        pagesPath: path.relative(projectRoot, path.join(directory, "pages.jsonl")),
        pdfPath: path.relative(projectRoot, path.join(directory, "manual.pdf")),
        title: "fixture manual",
        model: "TEST",
        applicableModels: Object.freeze(["TEST"]),
        artifacts: Object.freeze({
          chunksPath: path.relative(projectRoot, path.join(directory, "chunks.jsonl")),
        }),
        ...overrides,
      }),
    }),
  });
}

async function writeFixtureArtifacts(directory, fixtureSourceId) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "pages.jsonl"), `${JSON.stringify({
    charCount: 12,
    pageNumber: 1,
    sourceId: fixtureSourceId,
    text: "fixture page",
  })}\n`);
  await writeFile(path.join(directory, "chunks.jsonl"), `${JSON.stringify({
    chunkId: "fixture-chunk",
    pageStart: 1,
    pageEnd: 1,
    sectionTitle: "fixture",
    sourceId: fixtureSourceId,
    text: "fixture chunk text",
  })}\n`);
  await writeFile(path.join(directory, "manual.pdf"), "%PDF-fixture");
}

async function verifyFilesystemAllowlist() {
  const insideRoot = await mkdtemp(path.join(projectRoot, ".tmp-userguide-security-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "userguide-outside-"));
  try {
    const outsideSourceId = "outside-symlink-source";
    const outsideCase = path.join(insideRoot, "outside-symlink");
    await writeFixtureArtifacts(outsideCase, outsideSourceId);
    const outsidePages = path.join(outsideRoot, "outside-pages.jsonl");
    await writeFile(outsidePages, `${JSON.stringify({
      charCount: 12,
      pageNumber: 1,
      sourceId: outsideSourceId,
      text: "outside page",
    })}\n`);
    await rm(path.join(outsideCase, "pages.jsonl"));
    await symlink(outsidePages, path.join(outsideCase, "pages.jsonl"));
    const outsideRepository = createManualUserGuideRepository({
      corpusRegistry: fixtureRegistry(outsideSourceId, outsideCase),
    });
    assert.equal(
      await outsideRepository.getBrowseDocument(outsideSourceId),
      null,
      "a root-internal symlink to an outside artifact must not enter the allowlist",
    );

    const directorySourceId = "directory-artifact-source";
    const directoryCase = path.join(insideRoot, "directory-artifact");
    await writeFixtureArtifacts(directoryCase, directorySourceId);
    await rm(path.join(directoryCase, "manual.pdf"));
    await mkdir(path.join(directoryCase, "manual.pdf"));
    const directoryRepository = createManualUserGuideRepository({
      corpusRegistry: fixtureRegistry(directorySourceId, directoryCase),
    });
    assert.equal(
      await directoryRepository.getBrowseDocument(directorySourceId),
      null,
      "a non-regular artifact must not enter the allowlist",
    );

    const replacedSourceId = "replaced-artifact-source";
    const replacedCase = path.join(insideRoot, "replaced-artifact");
    await writeFixtureArtifacts(replacedCase, replacedSourceId);
    const replacedRepository = createManualUserGuideRepository({
      corpusRegistry: fixtureRegistry(replacedSourceId, replacedCase),
    });
    const originalPages = path.join(replacedCase, "pages.jsonl");
    await rename(originalPages, path.join(replacedCase, "pages.original.jsonl"));
    await symlink(outsidePages, originalPages);
    await assert.rejects(
      replacedRepository.getBrowseDocument(replacedSourceId),
      (error) => (
        error?.code === "userguide-artifact-unavailable"
        && !String(error.message).includes(outsideRoot)
        && !String(error.message).includes(originalPages)
      ),
      "a post-construction symlink replacement must fail without leaking a path",
    );

    const replacedPdfSourceId = "replaced-pdf-source";
    const replacedPdfCase = path.join(insideRoot, "replaced-pdf");
    await writeFixtureArtifacts(replacedPdfCase, replacedPdfSourceId);
    const replacedPdfRepository = createManualUserGuideRepository({
      corpusRegistry: fixtureRegistry(replacedPdfSourceId, replacedPdfCase),
    });
    const originalPdf = path.join(replacedPdfCase, "manual.pdf");
    const outsidePdf = path.join(outsideRoot, "outside.pdf");
    await writeFile(outsidePdf, "%PDF-outside");
    await rename(originalPdf, path.join(replacedPdfCase, "manual.original.pdf"));
    await symlink(outsidePdf, originalPdf);
    const replacedPdfAsset = await replacedPdfRepository.getPdfAsset(replacedPdfSourceId);
    await assert.rejects(
      replacedPdfAsset.openStream(),
      (error) => error?.code === "userguide-artifact-unavailable",
      "a post-construction PDF replacement must fail before streaming",
    );

    const invalidMetadataSourceId = "invalid-metadata-source";
    const invalidMetadataCase = path.join(insideRoot, "invalid-metadata");
    await writeFixtureArtifacts(invalidMetadataCase, invalidMetadataSourceId);
    for (const overrides of [
      { sourceVersion: "" },
      { contentDigest: "sha256:not-a-digest" },
    ]) {
      const invalidRepository = createManualUserGuideRepository({
        corpusRegistry: fixtureRegistry(invalidMetadataSourceId, invalidMetadataCase, overrides),
      });
      assert.equal(await invalidRepository.getBrowseDocument(invalidMetadataSourceId), null);
      assert.equal(await invalidRepository.getPdfAsset(invalidMetadataSourceId), null);
    }
  } finally {
    await rm(insideRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}

await verifyFilesystemAllowlist();

console.log("manual user-guide repository verification passed");
