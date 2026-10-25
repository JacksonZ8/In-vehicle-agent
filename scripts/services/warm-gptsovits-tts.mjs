#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  buildTtsStartupWarmupRequest,
  runGptSoVitsStartupWarmup,
} from "../../src/voice/gptsovits-runtime-warmup.mjs";

export {
  buildTtsStartupWarmupRequest,
  runGptSoVitsStartupWarmup,
  TTS_STARTUP_WARMUP_TEXT,
} from "../../src/voice/gptsovits-runtime-warmup.mjs";

async function main() {
  const result = await runGptSoVitsStartupWarmup();
  console.log(`[tts-warmup] ${JSON.stringify(result)}`);
  // A failed warmup is intentionally observable but never a startup failure.
  process.exitCode = 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
