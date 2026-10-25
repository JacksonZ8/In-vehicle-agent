import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const repeat = normalizeRepeat(process.env.NIO_LLM_PROFILE_REPEAT);

const cases = [
  {
    id: "conversation_vehicle_knowledge",
    text: "解释一下蔚来 ES8 的空气质量相关能力边界",
    body: {
      task: "conversation_general",
      rawText: "解释一下蔚来 ES8 的空气质量相关能力边界",
      prompt: "解释一下蔚来 ES8 的空气质量相关能力边界",
      parsedCommand: {
        intent: "conversation.general",
        rawText: "解释一下蔚来 ES8 的空气质量相关能力边界",
        conversationGoal: {
          interactionType: "explain",
          domain: "vehicle_knowledge",
          goal: "解释一下蔚来 ES8 的空气质量相关能力边界",
          source: "profile-fixture",
        },
        slots: {
          topic: "vehicle_knowledge",
        },
      },
    },
  },
  {
    id: "conversation_smalltalk",
    text: "你好，简单介绍一下你能帮我做什么",
    body: {
      task: "conversation_general",
      rawText: "你好，简单介绍一下你能帮我做什么",
      prompt: "你好，简单介绍一下你能帮我做什么",
      parsedCommand: {
        intent: "conversation.general",
        rawText: "你好，简单介绍一下你能帮我做什么",
        conversationGoal: {
          interactionType: "question",
          domain: "general",
          goal: "你好，简单介绍一下你能帮我做什么",
          source: "profile-fixture",
        },
        slots: {
          topic: "smalltalk",
        },
      },
    },
  },
  {
    id: "conversation_weather_boundary",
    text: "今天杭州天气怎么样，适合开窗通风吗？",
    body: {
      task: "conversation_general",
      rawText: "今天杭州天气怎么样，适合开窗通风吗？",
      prompt: "今天杭州天气怎么样，适合开窗通风吗？",
      parsedCommand: {
        intent: "conversation.general",
        rawText: "今天杭州天气怎么样，适合开窗通风吗？",
        requiresExternalData: true,
        externalDataType: "weather",
        conversationGoal: {
          interactionType: "question",
          domain: "weather",
          goal: "今天杭州天气怎么样，适合开窗通风吗？",
          source: "profile-fixture",
        },
        slots: {
          topic: "weather_query",
          city: "杭州",
          requiresExternalData: true,
          externalDataType: "weather",
        },
      },
    },
  },
  {
    id: "planning_window_success",
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
  {
    id: "safety_tailgate_reject",
    text: "行驶中打开尾门",
    body: {
      task: "safety_explain",
      rawText: "行驶中打开尾门",
      prompt: "根据安全网关拒绝结果生成面向用户的简短安全解释",
      parsedCommand: {
        intent: "safety.reject",
        rawText: "行驶中打开尾门",
        slots: {
          originalIntent: "body.tailgate.open",
          reason: "车辆行驶中禁止打开尾门。",
        },
      },
      safetyDecision: {
        allowed: false,
        action: "reject",
        safeIntent: "safety.reject",
        reason: "车辆行驶中禁止打开尾门。",
      },
      toolResult: {
        ok: false,
        reason: "车辆行驶中禁止打开尾门。",
        hmiSummary: "车辆行驶中不能打开尾门，请先安全停车并确认周围环境。",
      },
    },
  },
  {
    id: "planning_tailgate_confirm_required",
    text: "帮我打开尾门",
    body: {
      task: "planning",
      rawText: "帮我打开尾门",
      prompt: "根据安全网关二次确认结果生成面向用户的简短安全解释",
      parsedCommand: {
        intent: "body.tailgate.open",
        rawText: "帮我打开尾门",
        slots: {
          open: true,
          confirmRearClearance: false,
        },
      },
      safetyDecision: {
        allowed: false,
        action: "require_confirmation",
        safeIntent: "body.tailgate.open",
        reason: "打开尾门前需要确认车辆已静止且后方空间安全。",
      },
      toolResult: {
        ok: false,
        reason: "等待用户确认尾门后方空间安全。",
        hmiSummary: "打开尾门前，请确认车辆已停稳且尾门后方没有行人或障碍物。",
      },
    },
  },
];

function normalizeRepeat(value) {
  const parsed = Number(value || 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(3, Math.floor(parsed)));
}

function assertTelemetry(telemetry, label) {
  assert.ok(telemetry && typeof telemetry === "object", `${label}: telemetry should exist`);
  assert.ok(telemetry.provider, `${label}: telemetry.provider should exist`);
  assert.ok(
    ["ollama", "local-cache", "local-template", "mock"].includes(telemetry.provider),
    `${label}: telemetry.provider should be an expected local provider`,
  );

  if (telemetry.provider === "ollama") {
    assert.ok(telemetry.ollamaDurations && typeof telemetry.ollamaDurations === "object", `${label}: ollamaDurations should exist`);
    assert.ok(
      Object.hasOwn(telemetry.ollamaDurations, "prompt_eval_count"),
      `${label}: ollamaDurations.prompt_eval_count should exist for ollama provider`,
    );
    assert.ok(
      Object.hasOwn(telemetry.ollamaDurations, "eval_count"),
      `${label}: ollamaDurations.eval_count should exist for ollama provider`,
    );
  }
}

function stats(values) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return { min: null, median: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1],
  };
}

async function fetchJson(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(60_000),
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  });
  const wallMs = Math.round(performance.now() - startedAt);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  assert.ok(response.ok, `${path} returned HTTP ${response.status}`);
  return { body, wallMs };
}

async function assertServerReachable() {
  try {
    const response = await fetch(`${baseUrl}/`, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
    if (response.ok || response.status === 404 || response.status === 405) return;

    const fallback = await fetch(`${baseUrl}/`, { method: "GET", signal: AbortSignal.timeout(3_000) });
    assert.ok(fallback.ok, `/ returned HTTP ${fallback.status}`);
  } catch (error) {
    throw new Error(
      `Cannot reach ${baseUrl}/. Start the existing project service before running this profiler; this script does not start or restart services. Cause: ${error.message}`,
    );
  }
}

export function buildProfileRunSummary(item, runIndex, wallMs, responseBody) {
  assert.equal(typeof responseBody.summary, "string", `${item.id}: summary should be a string`);
  assert.ok(responseBody.summary.length > 0, `${item.id}: summary should not be empty`);
  assertTelemetry(responseBody.telemetry, item.id);

  const telemetry = responseBody.telemetry;
  return {
    run: runIndex + 1,
    task: item.body.task,
    intent: item.body.parsedCommand?.intent,
    wallMs,
    summaryLength: responseBody.summary.length,
    provider: telemetry.provider,
    degraded: telemetry.degraded,
    reason: telemetry.reason,
    promptStyle: telemetry.promptStyle,
    planningSummaryMode: telemetry.planningSummaryMode,
    externalDataProvider: telemetry.externalDataProvider,
    cacheHit: telemetry.cacheHit,
    cacheEligible: telemetry.cacheEligible,
    cacheType: telemetry.cacheType,
    cachedProvider: telemetry.cachedProvider,
    promptChars: telemetry.promptChars,
    durationMs: telemetry.durationMs,
    prompt_eval_count: telemetry.ollamaDurations?.prompt_eval_count,
    eval_count: telemetry.ollamaDurations?.eval_count,
    model: responseBody.model,
  };
}

async function main() {
  await assertServerReachable();

  const groupedCases = [];

  for (const item of cases) {
    const runs = [];

    for (let runIndex = 0; runIndex < repeat; runIndex += 1) {
      const { body, wallMs } = await fetchJson("/api/local-llm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: `profile-local-llm-${item.id}-${Date.now()}-${runIndex + 1}`,
          ...item.body,
        }),
      });

      runs.push(buildProfileRunSummary(item, runIndex, wallMs, body));
    }

    groupedCases.push({
      id: item.id,
      runs,
      stats: {
        wallMs: stats(runs.map((run) => run.wallMs)),
        durationMs: stats(runs.map((run) => run.durationMs)),
      },
    });
  }

  console.log(JSON.stringify({ baseUrl, repeat, checkedAt: new Date().toISOString(), cases: groupedCases }, null, 2));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(`profile-local-llm-latency failed: ${error.message}`);
    process.exitCode = 1;
  });
}
