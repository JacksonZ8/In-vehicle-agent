import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const allowedRootFiles = new Set([
  ".DS_Store",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  // Local-only AOCI cognition index (left out of the public snapshot) and its machine-bound MCP host config (git-ignored).
  ".mcp.json",
  "aoci.code.txt",
  "aoci.meta.txt",
  "aoci.txt",
  "PROJECT_GUIDE.md",
  "README.md",
  "index.html",
  "package-lock.json",
  "package.json",
  "userguide.html",
  "启动本地网页.command",
  "停止本地服务.command",
]);
const allowedRootDirectories = new Set([
  ".aoci",
  ".git",
  ".local-services",
  ".superpowers",
  ".ua",
  ".workbuddy",
  ".worktrees",
  "artifacts",
  "assets",
  "config",
  "data",
  "docs",
  "external",
  "node_modules",
  "references",
  "scripts",
  "src",
  "test-results",
  "vendor",
  "vehicle-model-lab",
]);
const requiredDirectories = [
  "src/app",
  "src/runtime",
  "src/safety",
  "src/vehicle",
  "src/semantic",
  "src/manual",
  "src/external-data",
  "src/voice",
  "src/server",
  "scripts/verify",
  "scripts/services",
  "scripts/benchmarks",
  "scripts/evaluation",
  "scripts/assets",
  "scripts/lib",
  "docs/guides",
  "docs/audits",
  "vehicle-model-lab",
  "vehicle-model-lab/dist",
  "vehicle-model-lab/verify",
];
// references/ holds the undistributed manual PDF and artifacts/ gitignored run outputs; with
// vehicle-model-lab/source they stay allowed root entries when present but are not required in a
// fresh checkout. The development history and experiments live in ../lab, outside this project.
const isAllowedRootEntry = (entry) => entry.isDirectory()
  ? allowedRootDirectories.has(entry.name)
  : allowedRootFiles.has(entry.name) || (entry.name === ".git" && entry.isFile());

assert.equal(isAllowedRootEntry({
  name: ".git",
  isDirectory: () => false,
  isFile: () => false,
}), false, ".git symlinks and other non-file entries must be unexpected");

assert.equal(isAllowedRootEntry({
  name: "test-results",
  isDirectory: () => true,
  isFile: () => false,
}), true, "ignored temporary benchmark output directory must be allowed");
assert.equal(isAllowedRootEntry({
  name: "test-results",
  isDirectory: () => false,
  isFile: () => true,
}), false, "test-results must remain rejected when it is a file");
assert.equal(isAllowedRootEntry({
  name: ".DS_Store",
  isDirectory: () => false,
  isFile: () => true,
}), true, "ignored Finder metadata must be allowed only as a file");
assert.equal(isAllowedRootEntry({
  name: ".worktrees",
  isDirectory: () => true,
  isFile: () => false,
}), true, "ignored Codex worktrees directory must be allowed");
assert.equal(isAllowedRootEntry({
  name: ".workbuddy",
  isDirectory: () => true,
  isFile: () => false,
}), true, "ignored WorkBuddy process data directory must be allowed");
assert.equal(isAllowedRootEntry({
  name: "config",
  isDirectory: () => true,
  isFile: () => false,
}), true, "versioned runtime configuration directory must be allowed");
assert.equal(isAllowedRootEntry({
  name: "vehicle-model-lab",
  isDirectory: () => true,
  isFile: () => false,
}), true, "vehicle model lab must be an allowed project directory");
assert.equal(isAllowedRootEntry({
  name: "停止本地服务.command",
  isDirectory: () => false,
  isFile: () => true,
}), true, "local service stop command must be allowed as a root file");

const entries = await readdir(root, { withFileTypes: true });
const unexpected = entries
  .filter((entry) => !isAllowedRootEntry(entry))
  .map((entry) => entry.name)
  .sort();

assert.deepEqual(unexpected, [], `unexpected root entries: ${unexpected.join(", ")}`);
for (const path of requiredDirectories) {
  assert.ok(existsSync(new URL(`${path}/`, root)), `missing required directory ${path}`);
}

console.log(JSON.stringify({
  rootFiles: [...allowedRootFiles].sort(),
  requiredDirectories: requiredDirectories.length,
  unexpectedEntries: 0,
}, null, 2));
