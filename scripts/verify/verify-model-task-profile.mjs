import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  MODEL_TASK_IDS,
  resolveModelTaskProfiles,
} from "../../src/server/model-providers/model-task-profile.js";
import {
  VEHICLE_SLU_COMPACT_MODEL,
  VEHICLE_SLU_COMPACT_PROFILE,
} from "../../src/semantic/vehicle-slu-compact-v9.js";

const LEGACY_LLM_TASK_IDS = Object.freeze([
  "rag_rerank",
]);

assert.deepEqual(MODEL_TASK_IDS, [
  "vehicle_slu",
  "orchestrator_plan",
  "cabin_response",
  "knowledge_answer",
  "rag_rerank",
  "asr_realtime",
  "tts_realtime",
]);

const defaultProfiles = resolveModelTaskProfiles({
  NIO_LLM_PROVIDER: "ollama",
  NIO_LLM_MODEL: "qwen3:8b",
  NIO_CLOUD_LLM_PHASE_TIMEOUT_MS: "12000",
  NIO_CLOUD_LLM_TRANSPORT_TIMEOUT_MS: "15000",
});

assert.deepEqual(defaultProfiles.vehicle_slu, {
  contractVersion: "nio-model-task-profile@1.0.0",
  task: "vehicle_slu",
  provider: "ollama",
  model: VEHICLE_SLU_COMPACT_MODEL,
  mode: "non-thinking",
  schemaVersion: "nio-vehicle-slu-contract@2.0.0",
  watchdogMs: null,
}, "Vehicle-SLU must default to the local compact model with no fallback");

assert.deepEqual(defaultProfiles.cabin_response, {
  contractVersion: "nio-model-task-profile@1.0.0",
  task: "cabin_response",
  provider: "dashscope",
  model: "qwen-plus",
  mode: "non-thinking",
  fallbackProfile: "cabin_response_local",
  fallback: { provider: "ollama", model: "qwen3:8b" },
  watchdogMs: null,
}, "Cabin response must use the approved cloud primary and local fallback pair");

assert.deepEqual(defaultProfiles.orchestrator_plan, {
  contractVersion: "nio-model-task-profile@1.0.0",
  task: "orchestrator_plan",
  provider: "dashscope",
  model: "qwen-plus",
  mode: "non-thinking",
  fallbackProfile: "orchestrator_plan_local",
  fallback: { provider: "ollama", model: "qwen3:8b" },
  watchdogMs: null,
}, "Task planning must use the approved cloud model and local Qwen3 fallback");

assert.deepEqual(defaultProfiles.knowledge_answer, {
  contractVersion: "nio-model-task-profile@1.0.0",
  task: "knowledge_answer",
  provider: "dashscope",
  model: "qwen3.8-flash",
  mode: "non-thinking",
  schemaVersion: "nio-knowledge-answer-contract@1.0.0",
  fallbackProfile: "knowledge_answer_local",
  fallback: { provider: "ollama", model: "qwen3:8b" },
  watchdogMs: null,
}, "Vehicle knowledge synthesis must use the approved fast primary and local fallback pair");

for (const task of LEGACY_LLM_TASK_IDS) {
  const profile = defaultProfiles[task];
  assert.equal(profile.provider, "ollama", `${task} must preserve the legacy provider`);
  assert.equal(profile.model, "qwen3:8b", `${task} must use the installed local general model`);
  assert.equal(profile.mode, "non-thinking", `${task} must disable local reasoning tokens`);
  assert.equal(profile.watchdogMs, null, `${task} must not inherit a legacy timeout`);
  assert.equal(Object.hasOwn(profile, "phaseTimeoutMs"), false);
  assert.equal(Object.hasOwn(profile, "transportTimeoutMs"), false);
}
const dashscopeLegacyProfiles = resolveModelTaskProfiles({
  NIO_LLM_PROVIDER: "dashscope",
  NIO_DASHSCOPE_MODEL: "qwen-plus",
});
for (const task of LEGACY_LLM_TASK_IDS) {
  assert.equal(dashscopeLegacyProfiles[task].provider, "dashscope",
    `${task} must preserve the legacy DashScope provider`);
  assert.equal(dashscopeLegacyProfiles[task].model, "qwen-plus",
    `${task} must preserve the legacy DashScope model`);
}
assert.equal(dashscopeLegacyProfiles.orchestrator_plan.provider, "dashscope");
assert.equal(dashscopeLegacyProfiles.orchestrator_plan.model, "qwen-plus");
assert.deepEqual(dashscopeLegacyProfiles.vehicle_slu, defaultProfiles.vehicle_slu,
  "Vehicle-SLU must remain independent from the legacy global provider");
assert.deepEqual(dashscopeLegacyProfiles.cabin_response, defaultProfiles.cabin_response,
  "Cabin response must remain independent from the legacy global provider");
assert.deepEqual(dashscopeLegacyProfiles.knowledge_answer, defaultProfiles.knowledge_answer,
  "Knowledge answer must remain independent from the legacy global provider");

assert.deepEqual(defaultProfiles.asr_realtime, {
  contractVersion: "nio-model-task-profile@1.0.0",
  task: "asr_realtime",
  implementation: "browser-speech-recognition",
  provider: null,
  model: null,
  watchdogMs: null,
});
assert.deepEqual(defaultProfiles.tts_realtime, {
  contractVersion: "nio-model-task-profile@1.0.0",
  task: "tts_realtime",
  implementation: "gpt-sovits",
  provider: null,
  model: null,
  watchdogMs: null,
});

const profiles = resolveModelTaskProfiles({
  NIO_LLM_PROVIDER: "ollama",
  NIO_LLM_MODEL: "qwen3:8b",
  NIO_VEHICLE_SLU_PROFILE: "cloud-dashscope",
  NIO_VEHICLE_SLU_PROVIDER: "dashscope",
  NIO_VEHICLE_SLU_MODEL: "qwen3.5-flash",
  NIO_CABIN_RESPONSE_PROVIDER: "dashscope",
  NIO_CABIN_RESPONSE_MODEL: "qwen-plus",
  NIO_CABIN_RESPONSE_FALLBACK_PROVIDER: "ollama",
  NIO_CABIN_RESPONSE_FALLBACK_MODEL: "qwen3:8b",
  NIO_KNOWLEDGE_ANSWER_PROVIDER: "dashscope",
  NIO_KNOWLEDGE_ANSWER_MODEL: "qwen3.8-flash",
  NIO_KNOWLEDGE_ANSWER_FALLBACK_PROVIDER: "ollama",
  NIO_KNOWLEDGE_ANSWER_FALLBACK_MODEL: "qwen3:8b",
  DASHSCOPE_API_KEY: "test-secret",
});

assert.deepEqual(profiles.vehicle_slu, {
  contractVersion: "nio-model-task-profile@1.0.0",
  task: "vehicle_slu",
  provider: "dashscope",
  model: "qwen3.5-flash",
  mode: "non-thinking",
  schemaVersion: "nio-vehicle-slu-contract@2.0.0",
  watchdogMs: null,
}, "explicit cloud Vehicle-SLU stays a single request without fallback");
assert.deepEqual(resolveModelTaskProfiles({ NIO_VEHICLE_SLU_PROFILE: VEHICLE_SLU_COMPACT_PROFILE }).vehicle_slu,
  defaultProfiles.vehicle_slu, "the explicit local profile equals the default");

const explicitWatchdog = resolveModelTaskProfiles({
  NIO_VEHICLE_SLU_WATCHDOG_MS: "3210",
  NIO_ORCHESTRATOR_PLAN_WATCHDOG_MS: "not-a-number",
  NIO_CABIN_RESPONSE_WATCHDOG_MS: "0",
  NIO_KNOWLEDGE_ANSWER_WATCHDOG_MS: "4321",
  NIO_RAG_RERANK_WATCHDOG_MS: "3.5",
});
assert.equal(explicitWatchdog.vehicle_slu.watchdogMs, 3210);
assert.equal(explicitWatchdog.orchestrator_plan.watchdogMs, null);
assert.equal(explicitWatchdog.cabin_response.watchdogMs, null);
assert.equal(explicitWatchdog.knowledge_answer.watchdogMs, 4321);
assert.equal(explicitWatchdog.rag_rerank.watchdogMs, null);

assert.equal(Object.isFrozen(profiles), true);
assert.equal(Object.isFrozen(profiles.vehicle_slu), true);
assert.equal(Object.isFrozen(profiles.cabin_response), true);
assert.equal(Object.isFrozen(profiles.cabin_response.fallback), true);
assert.equal(Object.isFrozen(profiles.knowledge_answer), true);
assert.equal(Object.isFrozen(profiles.knowledge_answer.fallback), true);

const serverModule = await import("../../src/server/local-agent-server.mjs");
assert.ok(serverModule.defaultModelTaskProfiles,
  "the server must resolve task profiles at module startup");
assert.equal(Object.isFrozen(serverModule.defaultModelTaskProfiles), true,
  "the server must retain the startup-resolved frozen task profile set");

for (const env of [
  { NIO_LLM_PROVIDER: "dashscope", NIO_DASHSCOPE_MODEL: "qwen-turbo" },
  { NIO_LLM_PROVIDER: "dashscope", NIO_DASHSCOPE_MODEL: "qwen3.5-flash-2026-02-23" },
  { NIO_LLM_PROVIDER: "ollama", NIO_LLM_MODEL: "qwen3.5:9b" },
  { NIO_VEHICLE_SLU_PROVIDER: "untrusted-provider", NIO_VEHICLE_SLU_MODEL: "qwen3.5-flash-2026-02-23" },
  { NIO_VEHICLE_SLU_PROVIDER: "dashscope", NIO_VEHICLE_SLU_MODEL: "unapproved-model" },
  { NIO_VEHICLE_SLU_PROVIDER: "dashscope" },
  { NIO_VEHICLE_SLU_PROVIDER: "dashscope", NIO_VEHICLE_SLU_MODEL: "qwen3.5-flash" },
  { NIO_VEHICLE_SLU_PROFILE: "cloud-dashscope", NIO_VEHICLE_SLU_PROVIDER: "ollama" },
  { NIO_VEHICLE_SLU_PROFILE: "unknown-profile" },
  { NIO_VEHICLE_SLU_PROFILE: "cloud-dashscope", NIO_VEHICLE_SLU_FALLBACK_PROVIDER: "ollama", NIO_VEHICLE_SLU_FALLBACK_MODEL: "qwen3:8b" },
  { NIO_VEHICLE_SLU_MODEL: "qwen3.5-flash-2026-02-23" },
  { NIO_VEHICLE_SLU_PROVIDER: "dashscope", NIO_VEHICLE_SLU_MODEL: "qwen-plus-2025-12-01" },
  { NIO_VEHICLE_SLU_FALLBACK_PROVIDER: "untrusted-provider", NIO_VEHICLE_SLU_FALLBACK_MODEL: "qwen3:8b" },
  { NIO_VEHICLE_SLU_FALLBACK_PROVIDER: "ollama", NIO_VEHICLE_SLU_FALLBACK_MODEL: "unapproved-model" },
  { NIO_VEHICLE_SLU_FALLBACK_PROVIDER: "ollama" },
  { NIO_VEHICLE_SLU_FALLBACK_MODEL: "qwen3.5:9b" },
  { NIO_VEHICLE_SLU_FALLBACK_PROVIDER: "ollama", NIO_VEHICLE_SLU_FALLBACK_MODEL: "qwen2.5:7b" },
  { NIO_ORCHESTRATOR_PLAN_PROVIDER: "untrusted-provider" },
  { NIO_CABIN_RESPONSE_PROVIDER: "dashscope" },
  { NIO_CABIN_RESPONSE_MODEL: "qwen-plus-2025-12-01" },
  { NIO_CABIN_RESPONSE_PROVIDER: "ollama", NIO_CABIN_RESPONSE_MODEL: "qwen-plus-2025-12-01" },
  { NIO_CABIN_RESPONSE_MODEL: "unapproved-model" },
  { NIO_CABIN_RESPONSE_FALLBACK_PROVIDER: "ollama" },
  { NIO_CABIN_RESPONSE_FALLBACK_MODEL: "qwen2.5:7b" },
  { NIO_CABIN_RESPONSE_FALLBACK_PROVIDER: "dashscope", NIO_CABIN_RESPONSE_FALLBACK_MODEL: "qwen2.5:7b" },
  { NIO_CABIN_RESPONSE_FALLBACK_PROVIDER: "ollama", NIO_CABIN_RESPONSE_FALLBACK_MODEL: "qwen3.5:9b" },
  { NIO_KNOWLEDGE_ANSWER_PROVIDER: "dashscope" },
  { NIO_KNOWLEDGE_ANSWER_MODEL: "qwen3.5-flash-2026-02-23" },
  { NIO_KNOWLEDGE_ANSWER_PROVIDER: "ollama", NIO_KNOWLEDGE_ANSWER_MODEL: "qwen3.5-flash-2026-02-23" },
  { NIO_KNOWLEDGE_ANSWER_FALLBACK_PROVIDER: "dashscope", NIO_KNOWLEDGE_ANSWER_FALLBACK_MODEL: "qwen-plus" },
  { NIO_KNOWLEDGE_ANSWER_FALLBACK_MODEL: "qwen2.5:7b" },
  { NIO_KNOWLEDGE_ANSWER_FALLBACK_PROVIDER: "ollama", NIO_KNOWLEDGE_ANSWER_FALLBACK_MODEL: "qwen2.5:7b" },
]) {
  assert.throws(() => resolveModelTaskProfiles(env), /model task profile/i);
}

const invalidStartup = spawnSync(
  process.execPath,
  ["--input-type=module", "--eval", 'import "./src/server/local-agent-server.mjs";'],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NIO_VEHICLE_SLU_PROVIDER: "untrusted-provider",
      NIO_VEHICLE_SLU_MODEL: "qwen3.5-flash-2026-02-23",
    },
    encoding: "utf8",
  },
);
assert.notEqual(invalidStartup.status, 0,
  "invalid task configuration must fail while the server module is initializing");
assert.match(`${invalidStartup.stdout}${invalidStartup.stderr}`, /model task profile/i);

console.log("verify-model-task-profile: PASS");
