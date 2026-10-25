#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(process.argv[2] || path.join(labRoot, "dist/nio-es7-component-manifest.json"));
const metadataPath = path.resolve(process.argv[3] || path.join(labRoot, "references/es7-cc-by/metadata.json"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(labRoot, "schema/es7-components.json"), "utf8"));
const notice = fs.readFileSync(path.join(labRoot, "THIRD_PARTY_NOTICES.md"), "utf8");

const expected = {
  author: metadata.model.author,
  modelUrl: metadata.model.pageUrl,
  license: metadata.license.fullName,
  licenseUrl: metadata.license.url,
  sourceArchiveSha256: metadata.package.sha256,
  sourceGlbSha256: metadata.package.originalFileSha256,
};
for (const [key, value] of Object.entries(expected)) {
  assert.equal(manifest.provenance?.[key], value, `Manifest provenance differs for ${key}`);
}
assert.equal(schema.provenance?.author, expected.author, "Schema author attribution differs");
assert.equal(schema.provenance?.modelUrl, expected.modelUrl, "Schema model URL differs");
assert.equal(schema.provenance?.licenseUrl, expected.licenseUrl, "Schema license URL differs");
for (const requiredText of [expected.author, expected.modelUrl, expected.licenseUrl, "CC BY 4.0"]) {
  assert.ok(notice.includes(requiredText), `THIRD_PARTY_NOTICES.md is missing: ${requiredText}`);
}
assert.equal(metadata.incorporation?.status, "full-es7-asset-authorized-for-animated-derivative",
  "Metadata incorporation status is not approved");

console.log("PASS ES7 attribution contract");
console.log(`- author: ${expected.author}`);
console.log(`- license: ${expected.license}`);
console.log(`- model: ${expected.modelUrl}`);
console.log(`- source hashes: ${expected.sourceArchiveSha256.slice(0, 12)}… / ${expected.sourceGlbSha256.slice(0, 12)}…`);
