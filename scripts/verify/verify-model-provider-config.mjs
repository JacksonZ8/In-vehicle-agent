import assert from "node:assert/strict";
import {
  ModelProviderError,
  normalizeModelProviderResult,
} from "../../src/server/model-providers/model-provider-contract.js";
import { resolveModelProviderConnections } from "../../src/server/model-providers/model-provider-config.js";

const ollamaClient = Object.freeze({
  async generate() {
    return Object.freeze({ response: "ok" });
  },
});
const connections = resolveModelProviderConnections({
  DASHSCOPE_API_KEY: "fake-secret-for-test",
  NIO_CLOUD_LLM_PHASE_TIMEOUT_MS: "12345",
  NIO_CLOUD_LLM_TRANSPORT_TIMEOUT_MS: "15678",
}, { ollamaClient });

assert.deepEqual(Object.keys(connections).sort(), ["dashscope", "ollama"]);
assert.deepEqual(Object.keys(connections.ollama).sort(), ["client", "readiness"]);
assert.deepEqual(Object.keys(connections.dashscope).sort(), ["baseUrl", "readiness"]);
assert.equal(connections.ollama.client, ollamaClient);
assert.equal(connections.ollama.readiness.status, "ready");
assert.equal(connections.dashscope.readiness.status, "ready");
assert.equal(connections.dashscope.apiKey, "fake-secret-for-test");
assert.equal(JSON.stringify(connections).includes("fake-secret-for-test"), false);
assert.equal(Object.hasOwn(connections, "phaseTimeoutMs"), false,
  "connection config must not retain the deleted schema-v2 public timeout surface");
assert.equal(Object.hasOwn(connections, "structuredTransportTimeoutMs"), false,
  "legacy public transport timeout env must not enter provider connections");

const missingDependencies = resolveModelProviderConnections({});
assert.deepEqual(missingDependencies.ollama.readiness, {
  status: "blocked",
  reasonCode: "provider-config-invalid",
});
assert.deepEqual(missingDependencies.dashscope.readiness, {
  status: "blocked",
  reasonCode: "provider-config-invalid",
});

for (const baseUrl of [
  "http://dashscope.aliyuncs.com/compatible-mode/v1",
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
  "https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1",
  "https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1",
  "https://dashscope.aliyuncs.com/compatible-mode/v1?key=bad",
  "https://dashscope.aliyuncs.com/compatible-mode/v1#fragment",
]) {
  const invalid = resolveModelProviderConnections({
    DASHSCOPE_API_KEY: "fake-secret-for-test",
    NIO_DASHSCOPE_BASE_URL: baseUrl,
  });
  assert.equal(invalid.dashscope.readiness.status, "blocked", baseUrl);
  assert.equal(invalid.dashscope.readiness.reasonCode, "provider-config-invalid", baseUrl);
}

const workspaceConnection = resolveModelProviderConnections({
  DASHSCOPE_API_KEY: "fake-secret-for-test",
  NIO_DASHSCOPE_BASE_URL: "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
});
assert.equal(workspaceConnection.dashscope.readiness.status, "ready");

const normalized = normalizeModelProviderResult({
  text: "ok",
  provider: "dashscope",
  model: "qwen-plus-2025-12-01",
  durationMs: 12,
  finishReason: "stop",
  usage: null,
});
assert.equal(normalized.usage.unavailableReason, "provider-usage-unavailable");
assert.ok(
  new ModelProviderError("blocked", { code: "provider-config-invalid" }) instanceof Error,
);

console.log(JSON.stringify({
  connectionIds: Object.keys(connections),
  publicTimeoutSurfaceRemoved: true,
}));
console.log("verify-model-provider-config: PASS");
