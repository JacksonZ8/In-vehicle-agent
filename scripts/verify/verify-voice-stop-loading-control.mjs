import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../src/app/app.js", import.meta.url), "utf8");

assert.match(source, /const loading = state\.voiceOutput\.status === "loading";/, "loading state should be considered by voice controls");
assert.match(
  source,
  /els\.ttsStopButton\.disabled = !supported \|\| \(!speaking && !paused && !loading\);/,
  "Stop should remain enabled while a supported GPT-SoVITS request is loading",
);

console.log(JSON.stringify({ loadingStopEnabled: true }, null, 2));
