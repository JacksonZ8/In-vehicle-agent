import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const server = await readFile(new URL("../../src/server/local-agent-server.mjs", import.meta.url), "utf8");
const ttsRoutes = await readFile(new URL("../../src/server/tts/tts-routes.mjs", import.meta.url), "utf8");
const adapter = await readFile(new URL("../../src/voice/voice-output-adapter.js", import.meta.url), "utf8");
const harness = await readFile(new URL("../benchmarks/measure-hmi-real-browser-scheduled-audio.mjs", import.meta.url), "utf8");
const restartScript = await readFile(new URL("../services/restart-local-services.sh", import.meta.url), "utf8");
const proxy = ttsRoutes.slice(ttsRoutes.indexOf("async function handleTtsStreamingPoc"), ttsRoutes.indexOf("function sendTtsJson"));
const diagnostics = ttsRoutes.slice(ttsRoutes.indexOf("const TTS_STREAMING_DIAGNOSTIC_PAYLOAD_FIELDS"), ttsRoutes.indexOf("function sendTtsJson"));

assert.match(ttsRoutes, /NIO_TTS_STREAMING_DIAGNOSTICS === "true"/);
assert.match(ttsRoutes, /"x-nio-tts-diagnostic-request-id"/);
assert.match(proxy, /diagnostics\?\.mark\("received"\)/);
for (const phase of ["bodyParsed", "payloadBuilt", "upstreamFetchStart", "upstreamHeaders", "upstreamFirstBodyRead", "proxyFirstWrite", "completed", "aborted"]) {
  assert.match(proxy, new RegExp(`diagnostics\\?\\.mark\\("${phase}"\\)`), `missing ${phase}`);
}
assert.match(proxy, /upstream\.body\.getReader\(\)/, "streaming must still consume upstream incrementally");
assert.match(proxy, /response\.write\(Buffer\.from\(value\)\)/, "streaming must still forward each upstream chunk");
assert.doesNotMatch(proxy, /arrayBuffer\(|Buffer\.concat|response\.end\(audio\)/, "diagnostics must not turn streaming into buffered audio");
assert.match(server, /createRequestAbortScope\(request, response\)/, "POST routes must share one downstream abort scope");
assert.match(
  server,
  /await handleAbortablePost\(request, response, handleTtsStreamingPoc\)/,
  "streaming TTS route must use the shared downstream abort scope",
);
assert.match(proxy, /composeAbortSignals\(\[signal, timeoutController\.signal\]\)/, "caller cancellation and timeout must be composed");
assert.match(proxy, /signal: abortScope\.signal/, "streaming upstream fetch must receive the composed signal");
assert.doesNotMatch(proxy, /request\.once\("aborted"/, "streaming handler must not install a second request abort listener");

const permitted = ["textLength", "profileId", "synthesisProfileId", "text_lang", "media_type", "streaming_mode", "split_method", "batch_size", "speed_factor", "top_k", "top_p", "temperature"];
for (const field of permitted) assert.match(diagnostics, new RegExp(`\\b${field}\\b`), `missing whitelisted ${field}`);
assert.doesNotMatch(diagnostics, /ref_audio_path|prompt_text|aux_ref_audio_paths|audioBytes|payload\.text/, "diagnostic metadata must not include secret/audio content fields");
assert.match(adapter, /"x-nio-tts-diagnostic-request-id"/);
assert.ok(harness.includes('diagnosticRequestId: chunks[0]?.responseHeaders?.["x-nio-tts-diagnostic-request-id"]'), "real-browser harness must preserve the response id association");

assert.match(
  restartScript,
  /export NIO_TTS_STREAMING_DIAGNOSTICS="\$\{NIO_TTS_STREAMING_DIAGNOSTICS:-false\}"/,
  "launcher default must keep diagnostics disabled",
);
assert.match(
  restartScript,
  /export NIO_TTS_STREAMING_DIAGNOSTICS=\$\(shell_double_quote "\$\{NIO_TTS_STREAMING_DIAGNOSTICS:-false\}"\)/,
  "agent wrapper must safely carry the explicit diagnostics value into launchctl/nohup",
);

const harnessDirectory = await mkdtemp(join(tmpdir(), "nio-tts-diagnostics-wrapper-"));
const harnessPath = join(harnessDirectory, "write-agent-wrapper.sh");
const wrapperPrefix = restartScript.slice(0, restartScript.indexOf('\nmkdir -p "$STATE_DIR" "$LOG_DIR" "$WRAPPER_DIR"'));
await writeFile(harnessPath, `${wrapperPrefix}\nwrite_local_agent_wrapper "$2"\n`, { mode: 0o700 });

async function writeWrapperWithDiagnostics(value) {
  const wrapperPath = join(harnessDirectory, `agent-${value}.sh`);
  await execFileAsync("/bin/bash", [harnessPath, "agent", wrapperPath], {
    env: { ...process.env, NIO_TTS_STREAMING_DIAGNOSTICS: value },
  });
  return readFile(wrapperPath, "utf8");
}

try {
  const defaultWrapper = await writeWrapperWithDiagnostics("false");
  const enabledWrapper = await writeWrapperWithDiagnostics("true");
  assert.match(defaultWrapper, /export NIO_TTS_STREAMING_DIAGNOSTICS="false"/, "default wrapper must disable diagnostics");
  assert.match(enabledWrapper, /export NIO_TTS_STREAMING_DIAGNOSTICS="true"/, "explicit true must reach the agent wrapper");
} finally {
  await rm(harnessDirectory, { recursive: true, force: true });
}

console.log(JSON.stringify({
  diagnosticsDefault: "off",
  launcherDiagnosticsDefault: "false",
  launcherDiagnosticsExplicitEnable: "shell-escaped wrapper passthrough",
  fields: permitted,
  requestIdCorrelation: true,
  streamingForwarding: true,
  abortCoverage: true,
}, null, 2));
