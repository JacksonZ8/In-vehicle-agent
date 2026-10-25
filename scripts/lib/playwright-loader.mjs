const DEFAULT_PLAYWRIGHT_MODULES = Object.freeze([
  "playwright",
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/playwright/index.mjs",
  "/Applications/Codex.app/Contents/Resources/cua_node/lib/node_modules/playwright/index.mjs",
]);

export async function loadChromium() {
  const moduleCandidates = [
    process.env.NIO_PLAYWRIGHT_MODULE,
    ...DEFAULT_PLAYWRIGHT_MODULES,
  ].filter(Boolean);
  let lastError = null;
  for (const modulePath of moduleCandidates) {
    try {
      return (await import(modulePath)).chromium;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to load Playwright. Set NIO_PLAYWRIGHT_MODULE to an installed playwright module. Last error: ${lastError?.message || "unknown"}`);
}

// The headless shell renders WebGL with SwiftShader on the CPU; the ES7 scene then blocks the
// main thread for seconds and breaks timer-based checks. Playwright's full Chromium in new
// headless mode uses the GPU, so it is the default unless a channel or executable is chosen.
const DEFAULT_CHROMIUM_CHANNEL = "chromium";

export function resolveChromiumLaunchOptions(options = {}, env = process.env) {
  const executablePath = String(env.NIO_PLAYWRIGHT_EXECUTABLE_PATH || "").trim();
  if (executablePath) return { ...options, executablePath };
  return { channel: DEFAULT_CHROMIUM_CHANNEL, ...options };
}

export async function launchChromium(options = {}) {
  const chromium = await loadChromium();
  return chromium.launch(resolveChromiumLaunchOptions(options));
}

export const PLAYWRIGHT_LOADER_MODULES = DEFAULT_PLAYWRIGHT_MODULES;
