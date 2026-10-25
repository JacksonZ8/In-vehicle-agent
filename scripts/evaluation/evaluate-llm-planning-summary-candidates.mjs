import assert from "node:assert/strict";
import {
  buildTemplatePlanningSummary,
  hasRenderablePlanningToolResult,
} from "../../src/runtime/planning-renderer-contract.js";

const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");

const cases = [
  {
    text: "把主驾车窗打开一半",
    task: "planning",
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
    text: "把主驾座椅靠背调到112度",
    task: "planning",
    body: {
      task: "planning",
      rawText: "把主驾座椅靠背调到112度",
      prompt: "根据车控执行结果生成面向用户的简短安全摘要",
      parsedCommand: {
        intent: "seat.driver.setBackrestAngle",
        rawText: "把主驾座椅靠背调到112度",
        slots: {
          seat: "driver",
          angle: 112,
        },
      },
      toolResult: {
        ok: true,
        statePatch: {
          seats: {
            driver: {
              backrestAngle: 112,
            },
          },
        },
        hmiSummary: "主驾座椅靠背角度已调至 112°。",
      },
    },
  },
  {
    text: "行驶中打开尾门",
    task: "safety_explain",
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
];

function assertTelemetry(telemetry, label) {
  assert.ok(telemetry && typeof telemetry === "object", `${label}: telemetry should exist`);
  assert.ok(telemetry.provider, `${label}: telemetry.provider should exist`);
  assert.ok(Object.hasOwn(telemetry, "durationMs"), `${label}: telemetry.durationMs should exist`);
  assert.ok(telemetry.ollamaDurations && typeof telemetry.ollamaDurations === "object", `${label}: telemetry.ollamaDurations should exist`);
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function getIntent(item) {
  return item.body.parsedCommand?.intent || "";
}

function getToolResult(item) {
  return isObject(item.body.toolResult) ? item.body.toolResult : {};
}

function hasExternalDataNeed(item) {
  const parsed = item.body.parsedCommand || {};
  const slots = isObject(parsed.slots) ? parsed.slots : {};
  return parsed.requiresExternalData === true || slots.requiresExternalData === true || Boolean(parsed.externalDataType || slots.externalDataType);
}

function isNavigationOrRecharge(intent) {
  return /(?:navigation|navigate|route|poi|energy|charge|battery|swap|recharge)/i.test(intent);
}

function requiresConfirmation(item) {
  const decision = item.body.safetyDecision || {};
  const parsed = item.body.parsedCommand || {};
  return decision.action === "require_confirmation" || parsed.action === "require_confirmation";
}

function buildTemplateCandidateSummary(item) {
  const toolResult = getToolResult(item);
  const hmiSummary = typeof toolResult.hmiSummary === "string" ? toolResult.hmiSummary.trim() : "";
  if (!hmiSummary) return "";
  if (toolResult.ok !== true) return hmiSummary;
  return buildTemplatePlanningSummary(toolResult);
}

function candidateVerdict(item, templateCandidateSummary) {
  const intent = getIntent(item);
  if (item.task === "safety_explain" || intent === "safety.reject") return "not-eligible";
  if (requiresConfirmation(item)) return "not-eligible";
  if (hasExternalDataNeed(item)) return "not-eligible";
  if (isNavigationOrRecharge(intent)) return "not-eligible";
  if (!hasRenderablePlanningToolResult(getToolResult(item))) return "not-eligible";
  if (!templateCandidateSummary) return "not-eligible";
  return "template-eligible-review";
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(40_000),
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
      `Cannot reach ${baseUrl}/. Start the existing project service before running this evaluator; this script does not start or restart services. Cause: ${error.message}`,
    );
  }
}

async function main() {
  await assertServerReachable();

  const summary = [];

  for (const item of cases) {
    const responseBody = await fetchJson("/api/local-llm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: `evaluate-llm-planning-summary-${Date.now()}-${summary.length}`,
        ...item.body,
      }),
    });

    assert.equal(typeof responseBody.summary, "string", `${item.text}: summary should be a string`);
    assert.ok(responseBody.summary.length > 0, `${item.text}: summary should not be empty`);
    assertTelemetry(responseBody.telemetry, item.text);

    const telemetry = responseBody.telemetry;
    const templateCandidateSummary = buildTemplateCandidateSummary(item);

    summary.push({
      text: item.text,
      task: item.task,
      intent: getIntent(item),
      llmProvider: telemetry.provider,
      llmDurationMs: telemetry.durationMs,
      prompt_eval_count: telemetry.ollamaDurations?.prompt_eval_count,
      eval_count: telemetry.ollamaDurations?.eval_count,
      llmSummaryLength: responseBody.summary.length,
      llmSummary: responseBody.summary,
      templateSummaryLength: templateCandidateSummary.length,
      templateCandidateSummary,
      candidateVerdict: candidateVerdict(item, templateCandidateSummary),
    });
  }

  console.log(JSON.stringify({ baseUrl, checkedAt: new Date().toISOString(), cases: summary }, null, 2));
}

main().catch((error) => {
  console.error(`evaluate-llm-planning-summary-candidates failed: ${error.message}`);
  process.exitCode = 1;
});
