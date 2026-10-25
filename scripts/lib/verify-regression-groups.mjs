import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const manifest = JSON.parse(await readFile(new URL("scripts/lib/regression-groups.json", root), "utf8"));
const requiredGroups = ["semantic", "runtime-safety", "manual", "voice", "hmi", "online"];
const offlineGroups = new Set(["semantic", "runtime-safety", "manual", "voice"]);
const grouped = [];
const b3RuntimeSafetyVerifiers = Object.freeze([
  "verify-vehicle-knowledge-contract.mjs",
  "verify-vehicle-knowledge-plan-validator.mjs",
  "verify-knowledge-agent-handoff.mjs",
  "verify-vehicle-knowledge-execution.mjs",
]);
const b3InterruptibleSessionVerifierGroups = Object.freeze({
  "runtime-safety": Object.freeze([
    "verify-interaction-event-protocol.mjs",
    "verify-interaction-session-controller.mjs",
    "verify-wake-word-and-turn-relation.mjs",
    "verify-server-upstream-abort.mjs",
  ]),
  hmi: Object.freeze([
    "verify-hmi-interruptible-session.mjs",
  ]),
});
const additionalVerifierGroups = Object.freeze({
  "runtime-safety": Object.freeze([
    "verify-app-runtime-result-state.mjs",
  ]),
  voice: Object.freeze([
    "verify-voice-playback-completion.mjs",
  ]),
});
function normalizeScriptEntry(entry) {
  if (typeof entry === "string") return { script: entry, args: [] };
  assert.ok(entry && typeof entry === "object" && !Array.isArray(entry), "verifier entry must be a string or object");
  assert.ok(Array.isArray(entry.args), `${entry.script || "verifier"} args must be an array`);
  for (const arg of entry.args) assert.match(arg, /^--[a-z0-9-]+$/, `${entry.script} only accepts long-option args`);
  return entry;
}
function groupScripts(groupName) {
  return manifest.groups[groupName].scripts.map((entry) => normalizeScriptEntry(entry).script);
}
const modelProviderOfflineVerifiers = Object.freeze([
  "verify-model-task-profile.mjs",
  "verify-model-provider-config.mjs",
  "verify-ollama-model-provider.mjs",
  "verify-dashscope-model-provider.mjs",
  "verify-model-provider-routing.mjs",
  "verify-model-provider-fallback.mjs",
  "verify-model-provider-browser-profile.mjs",
  "verify-model-provider-secret-boundary.mjs",
]);
const modelProviderCommand = modelProviderOfflineVerifiers
  .map((script) => `node scripts/verify/${script}`)
  .join(" && ");
const standaloneOptInVerifiers = Object.freeze({
  "verify-dashscope-live-smoke.mjs": "verify:dashscope:live",
  "verify-cloud-provider-qualification.mjs": "verify:cloud-provider:qualification",
});
const b4RuntimeSafetyVerifiers = Object.freeze([
  "verify-b4-benchmark-contract.mjs",
  "verify-b4-metric-projector.mjs",
  "verify-b4-report-builder.mjs",
  "verify-b4-baseline-runner.mjs",
  "verify-b4-fault-profile.mjs",
  "verify-b3-b4-cloud-call-budget.mjs",
]);
const explicitOnlyHmiVerifiers = Object.freeze([
  "verify-hmi-b4-baseline.mjs",
]);
const expectedB4OfflineCommand = [
  ...b4RuntimeSafetyVerifiers.map((script) => `node scripts/verify/${script}`),
  "node scripts/verify/verify-hmi-b4-baseline.mjs --static-only",
].join(" && ");

assert.equal(manifest.version, 2, "regression group manifest version");
for (const groupName of requiredGroups) {
  const group = manifest.groups?.[groupName];
  assert.ok(group, `missing ${groupName} group`);
  assert.ok(Array.isArray(group.requirements), `${groupName} requirements must be an array`);
  assert.ok(Array.isArray(group.scripts) && group.scripts.length > 0, `${groupName} scripts must be a non-empty array`);
  assert.equal(packageJson.scripts[`verify:${groupName}`], `node scripts/lib/run-regression-group.mjs ${groupName}`, `npm entry for ${groupName}`);
  if (offlineGroups.has(groupName)) {
    assert.deepEqual(group.requirements, [], `${groupName} must not require a service or Playwright`);
  }
  for (const entry of group.scripts) {
    const { script } = normalizeScriptEntry(entry);
    assert.match(script, /^verify-[a-z0-9-]+\.mjs$/, `${groupName} only accepts verifier scripts`);
    assert.ok(existsSync(new URL(`scripts/verify/${script}`, root)), `${groupName} references missing ${script}`);
    grouped.push(script);
  }
}

assert.equal(new Set(grouped).size, grouped.length, "each verifier must belong to exactly one group");
assert.deepEqual(
  groupScripts("runtime-safety").filter((script) => b4RuntimeSafetyVerifiers.includes(script)),
  b4RuntimeSafetyVerifiers,
  "the six pure B4 verifiers belong exactly once to runtime-safety in dependency order",
);
for (const script of explicitOnlyHmiVerifiers) {
  assert.equal(grouped.includes(script), false, `${script} must remain explicit-only`);
}
// Verifiers that git ignores (for example via .git/info/exclude) are local-only and stay
// out of the version-controlled manifest.
function listGitIgnoredVerifiers() {
  try {
    return new Set(execFileSync("git", [
      "ls-files", "--others", "--ignored", "--exclude-standard", "--", "scripts/verify/",
    ], { cwd: fileURLToPath(root), encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((file) => file.replace(/^scripts\/verify\//, "")));
  } catch {
    return new Set();
  }
}
const gitIgnoredVerifiers = listGitIgnoredVerifiers();
const verifierFiles = (await readdir(new URL("scripts/verify/", root)))
  .filter((file) => /^verify-[a-z0-9-]+\.mjs$/.test(file))
  .filter((file) => !gitIgnoredVerifiers.has(file))
  .filter((file) => file !== "verify-regression-groups.mjs")
  .filter((file) => !Object.hasOwn(standaloneOptInVerifiers, file))
  .filter((file) => !explicitOnlyHmiVerifiers.includes(file))
  .sort();
assert.deepEqual([...grouped].sort(), verifierFiles, "manifest must cover every verify-*.mjs exactly once");
for (const [script, allowedPackageCommand] of Object.entries(standaloneOptInVerifiers)) {
  assert.equal(grouped.includes(script), false, `${script} must remain standalone and opt-in`);
  for (const [command, value] of Object.entries(packageJson.scripts || {})) {
    if (!String(value).includes(`scripts/verify/${script}`)) continue;
    assert.equal(command, allowedPackageCommand, `${script} may only use ${allowedPackageCommand}`);
  }
}
const defaultAggregateCommands = Object.freeze([
  ...requiredGroups.map((groupName) => `verify:${groupName}`),
  "verify:offline",
  "verify:model-provider",
  "verify:groups",
  "verify:layout",
]);
function transitivePackageCommands(command, visited = new Set()) {
  if (visited.has(command)) return visited;
  visited.add(command);
  const value = String(packageJson.scripts?.[command] || "");
  for (const match of value.matchAll(/\bnpm run ([a-z0-9:-]+)/g)) {
    transitivePackageCommands(match[1], visited);
  }
  return visited;
}
for (const command of defaultAggregateCommands) {
  const value = String(packageJson.scripts?.[command] || "");
  for (const [script, optInCommand] of Object.entries(standaloneOptInVerifiers)) {
    assert.equal(value.includes(script), false, `${command} must not include ${script}`);
    assert.equal(value.includes(optInCommand), false, `${command} must not invoke ${optInCommand}`);
  }
  const transitive = transitivePackageCommands(command);
  for (const forbiddenCommand of [
    "verify:b4:offline",
    "verify:dashscope:live",
    "verify:cloud-provider:qualification",
    "benchmark:b4",
    "benchmark:b4:cold",
    "benchmark:b4:faults",
    "benchmark:b4:voice",
  ]) {
    assert.equal(transitive.has(forbiddenCommand), false, `${command} must not transitively invoke ${forbiddenCommand}`);
  }
}
assert.equal(packageJson.scripts["verify:offline"], "npm run verify:semantic && npm run verify:runtime-safety && npm run verify:manual && npm run verify:voice && npm run test:unit");
assert.equal(packageJson.scripts["verify:groups"], "node scripts/lib/verify-regression-groups.mjs");
assert.equal(packageJson.scripts["verify:model-provider"], modelProviderCommand);
assert.equal(packageJson.scripts["verify:b4:offline"], expectedB4OfflineCommand);
for (const [command, value] of Object.entries(packageJson.scripts || {})) {
  for (const script of explicitOnlyHmiVerifiers) {
    if (!String(value).includes(`scripts/verify/${script} --static-only`)) continue;
    assert.equal(command, "verify:b4:offline", `${script} static mode may only appear in verify:b4:offline`);
  }
}
const runtimeSafetyScripts = groupScripts("runtime-safety");
const modelProviderIndexes = modelProviderOfflineVerifiers.map((script) => runtimeSafetyScripts.indexOf(script));
assert.ok(modelProviderIndexes.every((index) => index >= 0), "all Model Provider verifiers belong to runtime-safety");
assert.deepEqual(
  modelProviderIndexes,
  [...modelProviderIndexes].sort((left, right) => left - right),
  "Model Provider verifiers must stay in dependency order",
);
for (const groupName of requiredGroups) {
  assert.equal(
    groupScripts(groupName).some((script) => /live-smoke|qualification/.test(script)),
    false,
    `${groupName} must not include live smoke or qualification scripts`,
  );
}
for (const script of b3RuntimeSafetyVerifiers) {
  assert.ok(groupScripts("runtime-safety").includes(script), `${script} belongs to runtime-safety`);
}
for (const [groupName, scripts] of Object.entries(b3InterruptibleSessionVerifierGroups)) {
  for (const script of scripts) {
    assert.ok(groupScripts(groupName).includes(script), `${script} belongs to ${groupName}`);
  }
}
for (const [groupName, scripts] of Object.entries(additionalVerifierGroups)) {
  for (const script of scripts) {
    assert.ok(groupScripts(groupName).includes(script), `${script} belongs to ${groupName}`);
  }
}
assert.ok(groupScripts("online").includes("verify-b3-vehicle-knowledge-model-api.mjs"));
assert.ok(groupScripts("online").includes("verify-b3-vehicle-knowledge-golden.mjs"));
assert.ok(groupScripts("hmi").includes("verify-hmi-b3-vehicle-knowledge.mjs"));
assert.deepEqual(
  manifest.groups.hmi.scripts.find((entry) => normalizeScriptEntry(entry).script === "verify-hmi-lean-runtime-composition.mjs"),
  { script: "verify-hmi-lean-runtime-composition.mjs", args: ["--static-only"] },
  "HMI lean runtime composition must run in explicit static-only mode",
);
const runnerSource = await readFile(new URL("scripts/lib/run-regression-group.mjs", root), "utf8");
assert.doesNotMatch(runnerSource, /start-local-services|restart-local-services|listen\s*\(/, "regression runner must not start services");

console.log(`regression group verification passed (${grouped.length} verifier scripts)`);
