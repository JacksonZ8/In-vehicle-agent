import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeResultDebugSnapshot } from "../app/run-event-presenter.js";
import { createRunEvent, validateRunEvent } from "./run-event-protocol.js";

test("route-decision events retain provider fallback diagnostics", () => {
  const modelTelemetry = {
    primaryFailureReasonCode: "provider-unavailable",
    providerFailureReasonCode: "invalid-parameter",
    fallbackActive: true,
    fallbackAttempted: true,
    externalModelRequestCount: 2,
    ollamaDurations: {
      total_duration_ms: 45_850,
      load_duration_ms: 11,
      prompt_eval_duration_ms: 8_500,
      eval_duration_ms: 37_339,
      prompt_eval_count: 1_024,
      eval_count: 256,
    },
  };
  const event = createRunEvent({
    eventId: "event-route-1",
    runId: "run-route-1",
    parentEventId: null,
    sequence: 1,
    timestamp: "2026-09-05T00:00:00.000Z",
    component: "vehicleSluModel",
    phase: "route-decision",
    status: "completed",
    summary: "Vehicle-SLU fallback completed",
    refs: [],
    model: "qwen3.5:9b",
    provider: "ollama",
    durationMs: 45_850,
    metadata: { degraded: true, modelTelemetry },
  });

  assert.deepEqual(event.metadata.modelTelemetry, modelTelemetry);
  assert.deepEqual(validateRunEvent(event), []);
});

test("runtime debug projection retains provider fallback diagnostics", () => {
  const semanticTelemetry = {
    provider: "ollama",
    model: "qwen3.5:9b",
    primaryFailureReasonCode: "provider-unavailable",
    providerFailureReasonCode: "invalid-parameter",
    fallbackActive: true,
    fallbackAttempted: true,
    externalModelRequestCount: 2,
    ollamaDurations: {
      total_duration_ms: 45_850,
      load_duration_ms: 11,
      prompt_eval_duration_ms: 8_500,
      eval_duration_ms: 37_339,
      prompt_eval_count: 1_024,
      eval_count: 256,
    },
  };

  const snapshot = buildRuntimeResultDebugSnapshot({
    requestId: "run-route-1",
    semanticTelemetry,
  });
  assert.deepEqual(snapshot.semanticTelemetry, semanticTelemetry);
});
