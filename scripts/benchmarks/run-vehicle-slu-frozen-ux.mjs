#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateVehicleSluUx, validateVehicleSluUxFixture } from "./evaluate-vehicle-slu-ux.mjs";
import { VEHICLE_SLU_COMPACT_PROMPT_VERSION, VEHICLE_SLU_COMPACT_GENERATION_PROFILE } from "../../src/semantic/vehicle-slu-compact-v9.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function vehicleSluFreezeIdentity(freeze) {
  return sha256(JSON.stringify({
    modelDigest: freeze.modelDigest,
    fixtureSha256: freeze.fixtureSha256,
    promptVersion: freeze.promptVersion,
    generationProfile: freeze.generationProfile,
    sourceSha256: Object.fromEntries(Object.entries(freeze.sourceSha256).sort(([left], [right]) => left.localeCompare(right))),
  }));
}

export async function assertVehicleSluFrozenFiles(freeze) {
  assert.equal(freeze.promptVersion, VEHICLE_SLU_COMPACT_PROMPT_VERSION);
  assert.equal(freeze.generationProfile, VEHICLE_SLU_COMPACT_GENERATION_PROFILE);
  for (const [path, digest] of Object.entries(freeze.sourceSha256)) assert.equal(sha256(await readFile(resolve(repoRoot, path))), digest, `frozen source changed: ${path}`);
  const bytes = await readFile(resolve(freeze.fixturePath));
  assert.equal(sha256(bytes), freeze.fixtureSha256, "frozen fixture changed");
  const fixture = JSON.parse(bytes);
  validateVehicleSluUxFixture(fixture);
  return fixture;
}

async function assertModelIdentity(freeze) {
  const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(5000) });
  assert(response.ok, "local Ollama metadata unavailable");
  const tag = (await response.json()).models.find((entry) => entry.name === freeze.model);
  assert.equal(tag?.digest, freeze.modelDigest, "frozen model digest changed or missing");
}

async function main([freezePath, outputDirectory, ...extra]) {
  if (!freezePath || !outputDirectory || extra.length) throw new TypeError("usage: FREEZE.json NEW_OUTPUT_DIRECTORY");
  const absoluteFreezePath = resolve(freezePath);
  const freeze = JSON.parse(await readFile(absoluteFreezePath, "utf8"));
  assert.equal(freeze.purpose, "personal-local-research");
  const fixture = await assertVehicleSluFrozenFiles(freeze);
  await assertModelIdentity(freeze);
  const out = resolve(outputDirectory);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out);
  const lockPath = resolve(repoRoot, "artifacts/vehicle-slu-ux-frozen", `${vehicleSluFreezeIdentity(freeze)}.run.lock.json`);
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = new Date().toISOString();
  const record = (status, additions = {}) => JSON.stringify({ status, startedAt, freezePath: absoluteFreezePath, outputDirectory: out, ...additions }, null, 2) + "\n";
  await writeFile(lockPath, record("started"), { flag: "wx" });
  let calls = 0;
  try {
    console.log("Frozen local model/fixture verified; one run locked. Starting warmup and diagnostic replay.");
    const result = await evaluateVehicleSluUx({ fixture, models: [freeze.model], baseUrl: "http://127.0.0.1:11434", fetchImpl: async (url, options) => {
      if (url.endsWith("/api/generate")) {
        calls += 1;
        if (calls === 2 || (calls - 1) % 10 === 0) console.log(`Diagnostic replay progress: ${calls - 1}/${fixture.cases.reduce((sum, entry) => sum + entry.turns.length, 0)} turns requested`);
      }
      return fetch(url, options);
    } });
    await assertVehicleSluFrozenFiles(freeze);
    await assertModelIdentity(freeze);
    const results = { createdAt: new Date().toISOString(), freeze, freezePath: absoluteFreezePath, integrity: "verified-before-and-after", ...result, fullAcceptanceCoverage: fixture.fullAcceptanceCoverage, fullQualificationEligible: fixture.fullAcceptanceCoverage?.fullQualificationEligible !== false && fixture.split === "acceptance" };
    await writeFile(resolve(out, "results.json"), JSON.stringify(results, null, 2) + "\n", { flag: "wx" });
    await writeFile(resolve(out, "summary.md"), `# Frozen Vehicle-SLU local research diagnostic\n\n- Dataset: ${result.datasetVersion}\n- Coverage: ${result.caseCount} cases / ${result.models[0].metrics.turnCount} turns; full qualification eligible: ${results.fullQualificationEligible}\n- Known excluded capability gap: uxacc-026 (unsupported exact weather dates); original 40-case truth retained separately.\n- Source/model/fixture integrity: verified before and after.\n- Observation: parser/routing only; no actual vehicle tools or final answer quality measured.\n\n\`\`\`json\n${JSON.stringify(result.models[0].metrics, null, 2)}\n\`\`\`\n`, { flag: "wx" });
    await writeFile(lockPath, record("completed", { completedAt: results.createdAt, modelRequestCountIncludingWarmup: calls }));
    console.log(JSON.stringify({ outputDirectory: out, integrity: results.integrity, fullQualificationEligible: results.fullQualificationEligible, metrics: result.models[0].metrics }));
  } catch (error) {
    await writeFile(lockPath, record("failed", { failedAt: new Date().toISOString(), error: error.message, modelRequestCountIncludingWarmup: calls }));
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
