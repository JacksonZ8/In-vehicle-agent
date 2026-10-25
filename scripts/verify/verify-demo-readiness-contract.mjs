import assert from "node:assert/strict";
import { buildDemoReadiness } from "../../src/server/demo-readiness.mjs";

const TASK_IDS = Object.freeze([
  "vehicle_slu",
  "orchestrator_plan",
  "cabin_response",
  "knowledge_answer",
]);

function buildSnapshot({
  dashscopeReady = true,
  ollamaReady = true,
  allModelsUnavailable = false,
  manualRagStatus = "ready",
  ttsStatus = "ready",
  vehicleAssetReady = true,
  hmiReady = true,
} = {}) {
  const publicProfiles = {};
  const taskProfiles = {};

  for (const taskId of TASK_IDS) {
    const provider = taskId === "vehicle_slu" ? "ollama" : "dashscope";
    const primaryReady = !allModelsUnavailable
      && (provider === "ollama" ? ollamaReady : dashscopeReady);
    const fallback = taskId === "vehicle_slu"
      ? null
      : { provider: "ollama", model: "qwen3:8b" };
    const fallbackReady = !allModelsUnavailable && fallback !== null && ollamaReady;
    const taskReady = primaryReady || fallbackReady;

    publicProfiles[taskId] = {
      readiness: { status: taskReady ? "ready" : "blocked" },
      primaryReadiness: { status: primaryReady ? "ready" : "blocked" },
      provider,
      model: taskId === "vehicle_slu" ? "cockpit-slu-v11-round4:latest" : "qwen-plus",
    };
    taskProfiles[taskId] = {
      provider,
      model: publicProfiles[taskId].model,
      ...(fallback ? { fallback } : {}),
    };
  }

  return buildDemoReadiness({
    now: 130_000,
    startedAt: 100_000,
    publicProfiles: { tasks: publicProfiles },
    taskProfiles,
    warmupSnapshot: {
      tasks: {
        manualRag: { status: manualRagStatus, durationMs: 1 },
        gptSoVits: { status: ttsStatus, durationMs: 1 },
      },
    },
    ollamaHealth: { ready: !allModelsUnavailable && ollamaReady, durationMs: 1 },
    hmiReady,
    vehicleAssetReady,
    deterministicRuntimeReady: true,
    localVoiceReadiness: {
      status: "ready",
      provider: "sherpa-onnx-kws",
      model: "local-kws-test",
    },
  });
}

function verifyScenario(name, options, expectedStatus, expectedStageStates = {}) {
  const snapshot = buildSnapshot(options);
  assert.equal(snapshot.status, expectedStatus, `${name}: overall status`);
  assert.equal(snapshot.elapsedMs, snapshot.deadlineMs, `${name}: elapsed time is capped at deadline`);
  assert.equal(snapshot.stages.length, 11, `${name}: readiness includes all public stages`);
  for (const [stageId, expectedState] of Object.entries(expectedStageStates)) {
    const stage = snapshot.stages.find((candidate) => candidate.id === stageId);
    assert.ok(stage, `${name}: stage ${stageId} exists`);
    assert.equal(stage.status, expectedState, `${name}: ${stageId} status`);
  }
  console.log(`${name}: ${snapshot.status}`);
  return snapshot;
}

verifyScenario("all-required-paths-ready", {}, "full");
verifyScenario("gpt-sovits-unavailable", { ttsStatus: "failed" }, "degraded", {
  tts: "degraded",
  usable_response_path: "ready",
});
verifyScenario("manual-rag-unavailable", { manualRagStatus: "failed" }, "degraded", {
  manual_rag: "degraded",
  usable_response_path: "ready",
});
verifyScenario("dashscope-unavailable-local-fallback-ready", { dashscopeReady: false }, "degraded", {
  orchestrator_plan: "degraded",
  cabin_response: "degraded",
  knowledge_answer: "degraded",
  usable_response_path: "ready",
});
verifyScenario("ollama-unavailable-semantic-route-blocked", { ollamaReady: false }, "blocked", {
  vehicle_slu: "blocked",
  usable_response_path: "blocked",
});
verifyScenario("all-model-paths-unavailable", { allModelsUnavailable: true }, "blocked", {
  vehicle_slu: "blocked",
  orchestrator_plan: "blocked",
  cabin_response: "blocked",
  knowledge_answer: "blocked",
  safety_runtime: "ready",
  usable_response_path: "blocked",
});
verifyScenario("es7-asset-unavailable", { vehicleAssetReady: false }, "degraded", {
  vehicle_asset: "blocked",
  usable_response_path: "ready",
});
verifyScenario("agent-server-unavailable", { hmiReady: false }, "blocked", {
  hmi_shell: "blocked",
  usable_response_path: "blocked",
});

console.log("verify-demo-readiness-contract: passed");
