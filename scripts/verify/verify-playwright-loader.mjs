import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveChromiumLaunchOptions } from "../lib/playwright-loader.mjs";

// Every verify/benchmark script that drives a browser must launch through the shared loader so
// NIO_PLAYWRIGHT_MODULE and NIO_PLAYWRIGHT_EXECUTABLE_PATH always apply.
const scriptDirectories = ["../verify/", "../benchmarks/"];
const scripts = scriptDirectories.flatMap((directory) => fs.readdirSync(new URL(directory, import.meta.url))
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => `${directory}${name}`))
  .filter((script) => script !== "../verify/verify-playwright-loader.mjs")
  .filter((script) => fs.readFileSync(new URL(script, import.meta.url), "utf8").includes("playwright-loader.mjs"));
assert.ok(scripts.length >= 10, "browser-driving scripts must be discovered");

const helper = fs.readFileSync(new URL("../lib/playwright-loader.mjs", import.meta.url), "utf8");
assert.match(helper, /NIO_PLAYWRIGHT_MODULE/);
assert.match(helper, /NIO_PLAYWRIGHT_EXECUTABLE_PATH/);
assert.match(helper, /PLAYWRIGHT_LOADER_MODULES/);
assert.deepEqual(
  resolveChromiumLaunchOptions(
    { headless: true },
    { NIO_PLAYWRIGHT_EXECUTABLE_PATH: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  ),
  {
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
);
assert.deepEqual(
  resolveChromiumLaunchOptions({ headless: true }, {}),
  { channel: "chromium", headless: true },
  "default launches use GPU-backed full Chromium, not the SwiftShader headless shell",
);
assert.deepEqual(
  resolveChromiumLaunchOptions({ headless: true, channel: "chrome" }, {}),
  { channel: "chrome", headless: true },
  "an explicit channel wins over the default",
);

for (const script of scripts) {
  const source = fs.readFileSync(new URL(script, import.meta.url), "utf8");
  assert.match(source, /import \{ launchChromium \} from "\.\.\/lib\/playwright-loader\.mjs";/, `${script}: must import launchChromium from the shared loader`);
  assert.doesNotMatch(source, /\.launch\(/, `${script}: must not call browserType.launch() directly; use launchChromium()`);
  assert.doesNotMatch(source, /bundledPlaywrightPaths/, `${script}: must not keep local bundled paths`);
  assert.doesNotMatch(source, /async function loadChromium/, `${script}: must not keep local loader function`);
  assert.doesNotMatch(source, /\/Applications\/(?:ChatGPT|Codex)\.app\/Contents\/Resources\/cua_node\/lib\/node_modules\/playwright\/index\.mjs/, `${script}: must not hardcode app playwright path`);
}

console.log(JSON.stringify({
  sharedPlaywrightLoader: true,
  envOverride: "NIO_PLAYWRIGHT_MODULE",
  executableOverride: "NIO_PLAYWRIGHT_EXECUTABLE_PATH",
  migratedScripts: scripts.length,
}, null, 2));
