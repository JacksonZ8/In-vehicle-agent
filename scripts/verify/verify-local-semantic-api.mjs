import assert from "node:assert/strict";
import {
  createVehicleSluEnvelope,
  VEHICLE_SLU_CONTRACT,
  VEHICLE_SLU_PROMPT_VERSION,
} from "../../src/semantic/vehicle-slu-contract.js";
import {
  isVehicleSluCompactModel,
  VEHICLE_SLU_COMPACT_PROMPT_VERSION,
} from "../../src/semantic/vehicle-slu-compact-v9.js";

const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");

function onlyFrame(envelope, text) {
  assert.equal(envelope.vehicleFrames.length, 1, `${text}: exactly one vehicle frame expected`);
  return envelope.vehicleFrames[0];
}

const cases = [
  {
    text: "把主驾车窗打开一半",
    verify(envelope) {
      assert.equal(envelope.domain, "vehicle");
      const frame = onlyFrame(envelope, this.text);
      assert.equal(frame.capability, "control");
      assert.equal(frame.intent, "body.window.setPosition");
      assert.equal(frame.actionNeed, "execute");
      assert.deepEqual(frame.slots, { zone: "front_left", percent: 50 });
    },
  },
  {
    text: "帮我调到0度",
    verify(envelope) {
      assert.equal(envelope.domain, "vehicle");
      assert.ok(envelope.vehicleFrames.length > 0);
      assert.equal(envelope.vehicleFrames.some((frame) => frame.actionNeed === "execute"), false,
        "ambiguous bare-degree input must not authorize execution");
      assert.ok(envelope.vehicleFrames.some((frame) => frame.actionNeed === "clarify"));
    },
  },
  {
    text: "今天杭州天气怎么样？",
    verify(envelope) {
      assert.equal(envelope.domain, "vehicle");
      const frame = onlyFrame(envelope, this.text);
      assert.equal(frame.capability, "weather");
      assert.equal(frame.intent, "weather.query");
      assert.equal(frame.actionNeed, "none");
      assert.equal(frame.slots.location, "杭州");
    },
  },
  {
    text: "把座椅靠背调到112度",
    verify(envelope) {
      assert.equal(envelope.domain, "vehicle");
      const frame = onlyFrame(envelope, this.text);
      assert.equal(frame.capability, "control");
      assert.equal(frame.intent, "seat.driver.setBackrestAngle");
      assert.equal(frame.actionNeed, "clarify");
      assert.equal(frame.slots.angle, 112);
      assert.equal(Object.hasOwn(frame.slots, "seat"), false);
    },
  },
  {
    text: "把主驾座椅靠背调到112度",
    verify(envelope) {
      assert.equal(envelope.domain, "vehicle");
      const frame = onlyFrame(envelope, this.text);
      assert.equal(frame.capability, "control");
      assert.equal(frame.intent, "seat.driver.setBackrestAngle");
      assert.equal(frame.actionNeed, "execute");
      assert.deepEqual(frame.slots, { seat: "driver", angle: 112 });
    },
  },
  // Prompt 1.35: a report with no affirmative action and no real query has no frame; a
  // consequence question is manual knowledge; a negated command keeps its frame but never executes.
  {
    text: "尾门已经打开了",
    verify(envelope) {
      assert.equal(envelope.domain, "vehicle");
      assert.deepEqual(envelope.vehicleFrames, [], `${this.text}: a report must not produce a frame`);
      assert.equal(envelope.conversationGoal.need, "explain");
    },
  },
  {
    text: "如果打开尾门会怎样",
    verify(envelope) {
      assert.equal(envelope.domain, "vehicle");
      const frame = onlyFrame(envelope, this.text);
      assert.equal(frame.intent, "vehicle.knowledge.query");
      assert.equal(frame.knowledgeNeed, "manual");
      assert.equal(frame.actionNeed, "none", `${this.text}: a hypothetical must be non-executing`);
    },
  },
  {
    text: "不要打开尾门",
    verify(envelope) {
      assert.equal(envelope.domain, "vehicle");
      const frame = onlyFrame(envelope, this.text);
      assert.equal(frame.capability, "control");
      assert.equal(frame.intent, "body.tailgate.open");
      assert.equal(frame.actionNeed, "none", `${this.text}: a negation must be non-executing`);
    },
  },
  {
    text: "你好，给我讲个笑话",
    verify(envelope) {
      assert.equal(envelope.domain, "non_vehicle");
      assert.deepEqual(envelope.vehicleFrames, []);
      assert.equal(envelope.conversationGoal.need, "social");
    },
  },
  {
    text: "打开车窗然后导航去公司",
    verify(envelope) {
      assert.equal(envelope.domain, "vehicle");
      assert.ok(envelope.vehicleFrames.length >= 2, "compound input must retain multiple frames");
      assert.ok(envelope.vehicleFrames.some((frame) => frame.capability === "control"));
      assert.ok(envelope.vehicleFrames.some((frame) => frame.capability === "navigation"));
    },
  },
];

function assertTelemetry(telemetry, text, model) {
  assert.ok(telemetry && typeof telemetry === "object", `${text}: telemetry should exist`);
  assert.equal(telemetry.provider, "ollama", `${text}: semantic authority must come from Ollama`);
  assert.equal(telemetry.model, model, `${text}: telemetry model must match response model`);
  assert.equal(telemetry.modelType, "vehicle-slu", `${text}: model type`);
  assert.equal(telemetry.contractVersion, VEHICLE_SLU_CONTRACT.ref, `${text}: contract version`);
  // The server serves the compact v10 prompt for the default local compact model.
  const expectedPromptVersion = isVehicleSluCompactModel({ provider: telemetry.provider, model })
    ? VEHICLE_SLU_COMPACT_PROMPT_VERSION
    : VEHICLE_SLU_PROMPT_VERSION;
  assert.equal(telemetry.promptVersion, expectedPromptVersion, `${text}: prompt version`);
  assert.equal(telemetry.semanticDecisionMs, telemetry.durationMs, `${text}: full semantic decision duration`);
  assert.equal(telemetry.firstModelTokenMs, null, `${text}: non-streaming first token is unobservable`);
  assert.equal(
    telemetry.firstModelTokenStatus,
    "unobservable-non-streaming",
    `${text}: first-token observation status`,
  );
  assert.equal(
    telemetry.slowStage,
    telemetry.durationMs > 3_000 ? "semantic-decision" : null,
    `${text}: slow completion remains observation-only`,
  );
  assert.equal(
    telemetry.watchdogMs === null
      || (typeof telemetry.watchdogMs === "number" && telemetry.watchdogMs > 0),
    true,
    `${text}: semantic watchdog must be null or explicitly positive`,
  );
  assert.equal(Object.hasOwn(telemetry, "timeoutMs"), false, `${text}: legacy hard timeout is forbidden`);
  assert.equal(telemetry.degraded, false, `${text}: successful response must not be degraded`);
  assert.ok(Number.isInteger(telemetry.promptChars) && telemetry.promptChars > 0, `${text}: promptChars`);
  assert.equal(typeof telemetry.durationMs, "number", `${text}: durationMs`);
  assert.ok(telemetry.ollamaDurations && typeof telemetry.ollamaDurations === "object", `${text}: ollamaDurations`);
  assert.equal(typeof telemetry.ollamaDurations.prompt_eval_count, "number", `${text}: prompt_eval_count`);
  assert.equal(Object.hasOwn(telemetry, "semanticPolicy"), false, `${text}: legacy semanticPolicy is forbidden`);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(10_000),
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawBody: text };
  }

  assert.ok(response.ok, `${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return body;
}

async function assertServerReachable() {
  try {
    const response = await fetch(`${baseUrl}/`, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
    if (response.ok || response.status === 404 || response.status === 405) return;

    const fallback = await fetch(`${baseUrl}/`, { method: "GET", signal: AbortSignal.timeout(3_000) });
    assert.ok(fallback.ok, `/ returned HTTP ${fallback.status}`);
  } catch (error) {
    throw new Error(
      `Cannot reach ${baseUrl}/. Please start the project service first, for example with the existing local server script, then rerun this verification. Cause: ${error.message}`,
    );
  }
}

async function main() {
  await assertServerReachable();

  const summary = [];
  for (const [index, item] of cases.entries()) {
    const requestId = `verify-local-semantic-${index}-${Date.now()}`;
    const body = await fetchJson("/api/local-semantic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: item.text, requestId }),
    });

    assert.deepEqual(Object.keys(body).sort(), ["model", "semanticEnvelope", "telemetry"]);
    assert.equal(typeof body.model, "string", `${item.text}: model should exist`);
    assert.equal(Object.hasOwn(body, "parsedCommand"), false, `${item.text}: legacy parsedCommand is forbidden`);
    assert.equal(Object.hasOwn(body, "semanticPolicy"), false, `${item.text}: legacy semanticPolicy is forbidden`);
    const envelope = createVehicleSluEnvelope(body.semanticEnvelope);
    assert.equal(envelope.requestId, requestId, `${item.text}: requestId must round-trip`);
    assertTelemetry(body.telemetry, item.text, body.model);
    item.verify(envelope);

    summary.push({
      text: item.text,
      domain: envelope.domain,
      frameCount: envelope.vehicleFrames.length,
      capabilities: envelope.vehicleFrames.map((frame) => frame.capability),
      model: body.model,
      provider: body.telemetry.provider,
      durationMs: body.telemetry.durationMs,
      prompt_eval_count: body.telemetry.ollamaDurations.prompt_eval_count,
    });
  }

  console.log(JSON.stringify({ baseUrl, checkedAt: new Date().toISOString(), cases: summary }, null, 2));
}

main().catch((error) => {
  console.error(`verify-local-semantic-api failed: ${error.message}`);
  process.exitCode = 1;
});
