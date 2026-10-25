import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { MANUAL_CORPUS_REGISTRY } from "../../src/manual/manual-corpus-registry.js";

const source = JSON.parse(await readFile(new URL("../../data/manual-rag/es8-manual-source.json", import.meta.url), "utf8"));
const buildScript = await readFile(new URL("../assets/build-manual-rag.py", import.meta.url), "utf8");
// The ES8 manual PDF is NIO copyright material and is not distributed with the public snapshot;
// without it only the digest comparison is skipped, every metadata contract is still checked.
const pdfUrl = new URL("../../references/ES8用户手册.pdf", import.meta.url);
const expectedDigest = existsSync(pdfUrl) ? await sha256File(pdfUrl) : null;
const corpus = MANUAL_CORPUS_REGISTRY.corpora["nio-es8-user-manual-2026"];

assert.equal(source.sourceId, "nio-es8-user-manual-2026");
assert.equal(source.title, "蔚来 ES8 用户手册");
assert.equal(source.sourceVersion, "2026");
assert.equal(typeof source.sourceVersion, "string", "manual sourceVersion must be an immutable string");
assert.notEqual(source.sourceVersion.trim(), "", "manual sourceVersion must not be empty");
assert.match(source.contentDigest, /^sha256:[0-9a-f]{64}$/, "manual contentDigest must be a lowercase SHA-256 digest");
if (expectedDigest) assert.equal(source.contentDigest, expectedDigest, "manual source metadata digest must match the PDF");
assert.equal(source.sourceFile, "ES8用户手册.pdf", "manual source metadata must use a project-relative sourceFile");
assert.doesNotMatch(source.sourceFile, /^\/|^[A-Za-z]:[\\/]/, "manual sourceFile must not be absolute");
assert.doesNotMatch(JSON.stringify(source), /\/Users\/apple|\/private\/|\/var\/folders|Downloads\/蔚来车载智能交互设计/);
assert.equal(corpus?.sourceId, source.sourceId, "registry and source metadata must identify the same manual");
assert.equal(corpus?.sourceVersion, source.sourceVersion, "registry and source metadata must use the same sourceVersion");
assert.equal(corpus?.contentDigest, source.contentDigest, "registry and source metadata must use the same contentDigest");
if (expectedDigest) assert.equal(corpus?.contentDigest, expectedDigest, "registry digest must match the PDF");
assert.equal(corpus?.pagesPath, "data/manual-rag/es8-manual-pages.jsonl");
assert.equal(corpus?.pdfPath, "references/ES8用户手册.pdf");
assert.match(buildScript, /"sourceFile": SOURCE_FILE/, "build-manual-rag.py must write project-relative sourceFile metadata");
assert.doesNotMatch(buildScript, /"sourceFile":\s*str\(PDF_PATH\)/, "build-manual-rag.py must not write absolute sourceFile metadata");
assert.match(buildScript, /SOURCE_VERSION = "2026"/, "build-manual-rag.py must use a controlled sourceVersion constant");
assert.match(buildScript, /"sourceVersion": SOURCE_VERSION/, "build-manual-rag.py must write the controlled sourceVersion");
assert.match(buildScript, /"contentDigest": sha256_file\(PDF_PATH\)/, "build-manual-rag.py must write a file-derived contentDigest");
assert.match(buildScript, /metadata-only migration/, "build-manual-rag.py README template must describe the metadata-only migration");
assert.match(buildScript, /sourceVersion/, "build-manual-rag.py README template must document sourceVersion");
assert.match(buildScript, /contentDigest/, "build-manual-rag.py README template must document contentDigest");
assert.match(buildScript, /chunks and embeddings remain unchanged/, "build-manual-rag.py README template must preserve the embeddings-unchanged statement");
assert.match(buildScript, /references\/ES8用户手册\.pdf/, "build-manual-rag.py README template must state the digest source file");

console.log(expectedDigest
  ? "manual source metadata verification passed"
  : "manual source metadata verification passed (PDF not present; digest comparison skipped)");

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}
