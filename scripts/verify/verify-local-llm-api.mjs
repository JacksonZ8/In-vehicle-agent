import assert from "node:assert/strict";
import { resolveConversationRoute } from "../../src/runtime/agent-schemas.js";

const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");

const cases = [
  {
    task: "conversation_general",
    text: "解释一下蔚来 ES8 的空气质量相关能力边界",
    body: {
      task: "conversation_general",
      rawText: "解释一下蔚来 ES8 的空气质量相关能力边界",
      prompt: "解释一下蔚来 ES8 的空气质量相关能力边界",
      parsedCommand: {
        intent: "conversation.general",
        rawText: "解释一下蔚来 ES8 的空气质量相关能力边界",
        slots: {
          topic: "vehicle_knowledge",
        },
        conversationGoal: {
          domain: "vehicle_knowledge",
          interactionType: "question",
          goal: "解释一下蔚来 ES8 的空气质量相关能力边界",
          source: "verify-local-llm-api",
        },
      },
    },
  },
  {
    task: "planning",
    text: "把主驾车窗打开一半",
    body: {
      task: "planning",
      rawText: "把主驾车窗打开一半",
      prompt: "根据车控执行结果生成面向用户的简短安全摘要",
      parsedCommand: {
        intent: "body.window.setPosition",
        rawText: "把主驾车窗打开一半",
        slots: {
          zone: "front_left",
          percent: 50,
          antiPinch: true,
        },
      },
      toolResult: {
        ok: true,
        statePatch: {
          windows: {
            frontLeft: 50,
          },
        },
        hmiSummary: "主驾车窗已调至 50%，防夹保护保持开启。",
      },
    },
  },
];

function assertConversationFixtureRoute(item) {
  if (item.body.parsedCommand?.intent !== "conversation.general") return;
  const route = resolveConversationRoute(item.body.rawText, item.body.parsedCommand);
  assert.equal(route.domain, item.body.parsedCommand.conversationGoal?.domain, `${item.text}: route.domain`);
  assert.equal(route.interactionType, item.body.parsedCommand.conversationGoal?.interactionType, `${item.text}: route.interactionType`);
  assert.equal(route.isVehicleKnowledge, true, `${item.text}: route.isVehicleKnowledge`);
  assert.equal(route.requiresExternalData, false, `${item.text}: route.requiresExternalData`);
}

function assertTelemetry(telemetry, label) {
  assert.ok(telemetry && typeof telemetry === "object", `${label}: telemetry should exist`);
  assert.ok(telemetry.provider, `${label}: telemetry.provider should exist`);
  assert.equal(typeof telemetry.durationMs, "number", `${label}: telemetry.durationMs should be a number`);
  assert.ok(["verbose", "compact"].includes(telemetry.promptStyle), `${label}: telemetry.promptStyle should be verbose or compact`);
  assert.ok(["llm", "template"].includes(telemetry.planningSummaryMode), `${label}: telemetry.planningSummaryMode should be llm or template`);
  assert.equal(typeof telemetry.promptChars, "number", `${label}: telemetry.promptChars should be a number`);
  // Model-backed tasks report the task-profile watchdog, which is null unless explicitly configured.
  assert.ok(
    telemetry.timeoutMs === null || (typeof telemetry.timeoutMs === "number" && telemetry.timeoutMs > 0),
    `${label}: telemetry.timeoutMs should be null or a positive number`,
  );
  assert.ok(telemetry.ollamaDurations && typeof telemetry.ollamaDurations === "object", `${label}: telemetry.ollamaDurations should exist`);
  assert.ok(telemetry.keepAlive, `${label}: telemetry.keepAlive should exist`);

  if (telemetry.cacheHit === true) {
    assert.notEqual(telemetry.provider, "local-cache", `${label}: cache hit must retain the original Provider identity`);
    assert.equal(telemetry.cacheType, "llm-response", `${label}: cache hit should use llm-response cacheType`);
    assert.equal(telemetry.cachedProvider, telemetry.provider, `${label}: cached Provider identity`);
    assert.equal(telemetry.cachedModel, telemetry.model, `${label}: cached model identity`);
    return;
  }

  if (["ollama", "dashscope"].includes(telemetry.provider)) {
    assert.equal(telemetry.degraded, false, `${label}: active Provider success should not be marked degraded`);
    assert.ok(telemetry.model, `${label}: active Provider telemetry.model should exist`);
    assert.ok(telemetry.usage && typeof telemetry.usage === "object", `${label}: active Provider usage should exist`);
    if (telemetry.provider === "ollama") {
      assert.ok(
        Object.hasOwn(telemetry.ollamaDurations, "prompt_eval_count"),
        `${label}: ollamaDurations.prompt_eval_count should exist for ollama provider`,
      );
      assert.ok(
        Object.hasOwn(telemetry.ollamaDurations, "eval_count"),
        `${label}: ollamaDurations.eval_count should exist for ollama provider`,
      );
    }
    return;
  }

  if (telemetry.provider === "local-template") {
    assert.equal(telemetry.degraded, false, `${label}: local-template provider should not be marked degraded`);
    assert.equal(telemetry.reason, "planning-template-fast-path", `${label}: local-template provider should include fast-path reason`);
    return;
  }

  if (telemetry.provider === "local-boundary") {
    assert.equal(telemetry.degraded, false, `${label}: local-boundary provider should not be marked degraded`);
    assert.ok(telemetry.reason, `${label}: local-boundary provider should include telemetry.reason`);
    assert.equal(telemetry.promptChars, 0, `${label}: local-boundary provider should not build an Ollama prompt`);
    return;
  }

  assert.equal(telemetry.degraded, true, `${label}: non-ollama provider should be marked degraded`);
  assert.ok(telemetry.reason, `${label}: non-ollama provider should include telemetry.reason`);
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
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
      `Cannot reach ${baseUrl}/. Please start the project service first; this verification does not start or restart it. Cause: ${error.message}`,
    );
  }
}

async function main() {
  await assertServerReachable();

  const summary = [];

  for (const item of cases) {
    assertConversationFixtureRoute(item);
    const body = await fetchJson("/api/local-llm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: `verify-local-llm-${Date.now()}`,
        ...item.body,
      }),
    });

    assert.equal(typeof body.summary, "string", `${item.text}: summary should be a string`);
    assert.ok(body.summary.length > 0, `${item.text}: summary should not be empty`);
    assertTelemetry(body.telemetry, item.text);

    summary.push({
      text: item.text,
      task: item.task,
      provider: body.telemetry.provider,
      degraded: body.telemetry.degraded,
      reason: body.telemetry.reason,
      promptStyle: body.telemetry.promptStyle,
      planningSummaryMode: body.telemetry.planningSummaryMode,
      cacheHit: body.telemetry.cacheHit,
      cacheEligible: body.telemetry.cacheEligible,
      cacheType: body.telemetry.cacheType,
      cachedProvider: body.telemetry.cachedProvider,
      promptChars: body.telemetry.promptChars,
      timeoutMs: body.telemetry.timeoutMs,
      durationMs: body.telemetry.durationMs,
      prompt_eval_count: body.telemetry.ollamaDurations?.prompt_eval_count,
      eval_count: body.telemetry.ollamaDurations?.eval_count,
      summaryLength: body.summary.length,
      model: body.model,
    });
  }

  console.log(JSON.stringify({ baseUrl, checkedAt: new Date().toISOString(), cases: summary }, null, 2));
}

main().catch((error) => {
  console.error(`verify-local-llm-api failed: ${error.message}`);
  process.exitCode = 1;
});
