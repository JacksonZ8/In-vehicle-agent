import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const groupName = process.argv[2];
const manifest = JSON.parse(await readFile(new URL("./regression-groups.json", import.meta.url), "utf8"));
const group = manifest.groups?.[groupName];

if (!groupName || !group) {
  throw new Error(`Unknown regression group \"${groupName || ""}\". Run npm run verify:groups to inspect the manifest.`);
}

if (group.requirements.length) {
  console.log(`Requirements for ${groupName}: ${group.requirements.join(", ")}. This runner does not start services.`);
}

for (const entry of group.scripts) {
  const script = typeof entry === "string" ? entry : entry.script;
  const args = typeof entry === "string" ? [] : entry.args;
  console.log(`\n> node scripts/verify/${script}${args.length ? ` ${args.join(" ")}` : ""}`);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(`../verify/${script}`, import.meta.url)), ...args],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
