import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildTemplatePlanningSummary,
  isTemplatePlanningSummaryCandidate,
  PLANNING_TEMPLATE_RENDERER_CAPABILITY,
} from "../../src/runtime/planning-renderer-contract.js";

const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const source = await readFile(new URL("../../src/server/local-agent-server.mjs", import.meta.url), "utf8");

const contractSource = await readFile(new URL("../../src/runtime/planning-renderer-contract.js", import.meta.url), "utf8");

assert.match(contractSource, /PLANNING_TEMPLATE_RENDERER_CAPABILITY/, "planning template renderer must declare a capability contract");
assert.doesNotMatch(source, /templatePlanningSummaryIntents/, "planning template renderer must not use an intent whitelist");
assert.doesNotMatch(source, /new Set\(\["body\.window\.setPosition",\s*"seat\.driver\.setBackrestAngle"\]\)/, "window/seat planning whitelist must not return");
assert.doesNotMatch(contractSource, /new Set\(\["body\.window\.setPosition",\s*"seat\.driver\.setBackrestAngle"\]\)/, "contract must not use window/seat planning whitelist");
assert.match(contractSource, /hasRenderablePlanningToolResult\(toolResult/, "template eligibility must be based on ToolResult contract");
assert.match(source, /planningRendererCapability/, "template telemetry must expose renderer capability identity");
assert.match(source, /isTemplatePlanningSummaryCandidateByContract/, "server must call shared planning renderer contract");

const renderableClimateBody = {
  task: "planning",
  parsedCommand: { intent: "cabin.climate.setPreset", slots: { temperature: 24 } },
  safetyDecision: { allowed: true, action: "allow" },
  toolResult: {
    ok: true,
    tool: "cabin.climate.setPreset",
    source: "dev-adapter",
    visualScenario: "cabin",
    hmiSummary: "座舱已切换到 24°C / auto / comfort（模拟执行）。",
  },
};
const renderableTailgateBody = {
  task: "planning",
  parsedCommand: { intent: "body.tailgate.open", slots: { open: true } },
  safetyDecision: { allowed: true, action: "allow" },
  toolResult: {
    ok: true,
    tool: "body.tailgate.open",
    source: "dev-adapter",
    visualScenario: "trunkControl",
    hmiSummary: "后备箱开启请求已发送（模拟执行）。",
  },
};

assert.equal(
  isTemplatePlanningSummaryCandidate(renderableClimateBody, { planningSummaryMode: "template" }),
  true,
  "template mode must support renderable non-window/seat vehicle ToolResult",
);
assert.equal(
  isTemplatePlanningSummaryCandidate(renderableTailgateBody, { planningSummaryMode: "template" }),
  true,
  "template mode must support tailgate ToolResult through contract, not intent whitelist",
);
assert.equal(
  isTemplatePlanningSummaryCandidate(renderableClimateBody, { planningSummaryMode: "llm" }),
  false,
  "llm mode must not use template eligibility even for renderable ToolResult",
);
assert.equal(buildTemplatePlanningSummary(renderableClimateBody.toolResult), "座舱已切换到 24°C / auto / comfort（模拟执行）。已通过车端安全校验。");

const negativeCases = [
  ["tool-failed", { ...renderableClimateBody, toolResult: { ...renderableClimateBody.toolResult, ok: false } }],
  ["missing-summary", { ...renderableClimateBody, toolResult: { ...renderableClimateBody.toolResult, hmiSummary: "" } }],
  ["safety-reject", { ...renderableClimateBody, safetyDecision: { allowed: false, action: "reject" } }],
  ["confirmation", { ...renderableClimateBody, safetyDecision: { allowed: false, action: "require_confirmation" } }],
  ["external-data-need", { ...renderableClimateBody, requiresExternalData: true }],
  ["external-source", { ...renderableClimateBody, toolResult: { ...renderableClimateBody.toolResult, source: "external-data-dev-adapter" } }],
  ["blocked-scenario", { ...renderableClimateBody, toolResult: { ...renderableClimateBody.toolResult, visualScenario: "blocked" } }],
  ["none-scenario", { ...renderableClimateBody, toolResult: { ...renderableClimateBody.toolResult, visualScenario: "none" } }],
  ["safety-tool", { ...renderableClimateBody, toolResult: { ...renderableClimateBody.toolResult, tool: "safety.reject" } }],
  ["conversation-task", { ...renderableClimateBody, task: "conversation_general" }],
  ["safety-task", { ...renderableClimateBody, task: "safety_explain" }],
];
for (const [label, body] of negativeCases) {
  assert.equal(
    isTemplatePlanningSummaryCandidate(body, { planningSummaryMode: "template" }),
    false,
    `${label} must not be template eligible`,
  );
}

async function fetchJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(40_000),
    body: JSON.stringify({
      requestId: `verify-planning-renderer-${Date.now()}`,
      ...body,
    }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { rawBody: text };
  }
  assert.ok(response.ok, `${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return parsed;
}

async function assertServerReachable() {
  try {
    const response = await fetch(`${baseUrl}/`, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
    if (response.ok || response.status === 404 || response.status === 405) return;
    const fallback = await fetch(`${baseUrl}/`, { method: "GET", signal: AbortSignal.timeout(3_000) });
    assert.ok(fallback.ok, `/ returned HTTP ${fallback.status}`);
  } catch (error) {
    throw new Error(`Cannot reach ${baseUrl}/. Start the existing project service before running this verifier. Cause: ${error.message}`);
  }
}

await assertServerReachable();

const climate = await fetchJson("/api/local-llm", {
  task: "planning",
  rawText: "把空调调到24度",
  prompt: "根据车控执行结果生成面向用户的简短安全摘要",
  parsedCommand: {
    intent: "cabin.climate.setPreset",
    rawText: "把空调调到24度",
    slots: { temperature: 24, airflow: "auto", passengerMode: "comfort" },
  },
  safetyDecision: {
    allowed: true,
    action: "allow",
    safeIntent: "cabin.climate.setPreset",
  },
  toolResult: {
    ok: true,
    tool: "cabin.climate.setPreset",
    source: "dev-adapter",
    visualScenario: "cabin",
    hmiSummary: "座舱已切换到 24°C / auto / comfort（模拟执行）。",
    statePatch: { cabinTemperature: 24, airflow: "auto", passengerMode: "comfort" },
  },
});
assert.ok(["llm", "template"].includes(climate.telemetry?.planningSummaryMode), "planningSummaryMode must be explicit");
if (climate.telemetry?.planningSummaryMode === "template") {
  assert.equal(climate.telemetry?.provider, "local-template", "new vehicle tools with renderable ToolResult should use template fast-path without intent whitelist");
  assert.deepEqual(climate.telemetry?.planningRendererCapability, {
    id: PLANNING_TEMPLATE_RENDERER_CAPABILITY.id,
    version: PLANNING_TEMPLATE_RENDERER_CAPABILITY.version,
  });
  assert.match(climate.summary, /24°C|安全校验/, "template summary should be derived from ToolResult hmiSummary");
} else {
  assert.notEqual(climate.telemetry?.provider, "local-template", "llm mode must not report template provider");
}

const external = await fetchJson("/api/local-llm", {
  task: "planning",
  rawText: "导航去公司",
  prompt: "根据外部数据结果生成面向用户的简短摘要",
  requiresExternalData: true,
  externalDataType: "map",
  parsedCommand: {
    intent: "navigation.planRoute",
    rawText: "导航去公司",
    requiresExternalData: true,
    externalDataType: "map",
    slots: { origin: "当前位置", destination: "公司", requiresExternalData: true, externalDataType: "map" },
  },
  safetyDecision: {
    allowed: true,
    action: "allow",
    safeIntent: "navigation.planRoute",
  },
  toolResult: {
    ok: true,
    tool: "navigation.planRoute",
    source: "external-data-dev-adapter",
    visualScenario: "planning",
    hmiSummary: "已规划从 当前位置 到 公司 的路线（模拟结果——开发环境无真实导航数据）。",
    statePatch: { origin: "当前位置", destination: "公司", distanceKm: "simulated" },
  },
});
assert.notEqual(external.telemetry?.provider, "local-template", "external data ToolResult must not use vehicle planning template fast-path");

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  planningSummaryMode: climate.telemetry.planningSummaryMode,
  rendererCapability: climate.telemetry.planningRendererCapability || null,
  cases: [
    { label: "climate-tool-result", provider: climate.telemetry.provider, summary: climate.summary },
    { label: "external-data-negative", provider: external.telemetry?.provider, reason: external.telemetry?.reason || null },
  ],
}, null, 2));
