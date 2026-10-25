import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { PLANNING_TEMPLATE_RENDERER_CAPABILITY } from "../../src/runtime/planning-renderer-contract.js";

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function startIsolatedTemplateServer() {
  const port = await reservePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../src/server/local-agent-server.mjs", import.meta.url)), String(port)], {
    env: {
      ...process.env,
      NIO_AGENT_PORT: String(port),
      NIO_ALLOW_PORT_FALLBACK: "false",
      NIO_LLM_PLANNING_SUMMARY_MODE: "template",
      NIO_OLLAMA_WARMUP_ON_START: "false",
      NIO_MANUAL_RAG_WARMUP_ON_START: "false",
    },
    stdio: "ignore",
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopIsolatedServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const isolatedServer = await startIsolatedTemplateServer();
const baseUrl = isolatedServer.baseUrl;

async function assertServerReachable() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`, { method: "HEAD", signal: AbortSignal.timeout(1_000) });
      if (response.ok || response.status === 404 || response.status === 405) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Cannot reach isolated template server ${baseUrl}/. Cause: ${lastError?.message || "unknown"}`);
}

async function fetchLocalLlm(label, body) {
  const response = await fetch(`${baseUrl}/api/local-llm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(40_000),
    body: JSON.stringify({
      requestId: `verify-planning-template-${label}-${Date.now()}`,
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
  assert.ok(response.ok, `${label}: /api/local-llm returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  assert.equal(typeof parsed.summary, "string", `${label}: summary should be string`);
  assert.ok(parsed.telemetry && typeof parsed.telemetry === "object", `${label}: telemetry should exist`);
  return parsed;
}

function vehicleSuccessBody({ intent, rawText, tool, visualScenario, hmiSummary, statePatch = {}, slots = {} }) {
  return {
    task: "planning",
    rawText,
    prompt: "根据车控执行结果生成面向用户的简短安全摘要",
    parsedCommand: {
      intent,
      rawText,
      slots,
    },
    safetyDecision: {
      allowed: true,
      action: "allow",
      safeIntent: intent,
    },
    toolResult: {
      ok: true,
      tool,
      source: "dev-adapter",
      visualScenario,
      hmiSummary,
      statePatch,
    },
  };
}

function assertTemplate(result, label) {
  assert.equal(result.telemetry.planningSummaryMode, "template", `${label}: service must be in template mode`);
  assert.equal(result.telemetry.provider, "local-template", `${label}: provider`);
  assert.equal(result.telemetry.reason, "planning-template-fast-path", `${label}: reason`);
  assert.deepEqual(result.telemetry.planningRendererCapability, {
    id: PLANNING_TEMPLATE_RENDERER_CAPABILITY.id,
    version: PLANNING_TEMPLATE_RENDERER_CAPABILITY.version,
  }, `${label}: renderer capability`);
  assert.equal(result.telemetry.promptChars, 0, `${label}: template must not build LLM prompt`);
  assert.match(result.summary, /已通过车端安全校验。$/, `${label}: summary should be template suffix`);
}

function assertNotTemplate(result, label) {
  assert.equal(result.telemetry.planningSummaryMode, "template", `${label}: service must be in template mode`);
  assert.notEqual(result.telemetry.provider, "local-template", `${label}: must not use template provider`);
}

try {
await assertServerReachable();

const positiveCases = [
  [
    "climate-success",
    vehicleSuccessBody({
      intent: "cabin.climate.setPreset",
      rawText: "把空调调到24度",
      tool: "cabin.climate.setPreset",
      visualScenario: "cabin",
      hmiSummary: "座舱已切换到 24°C / auto / comfort（模拟执行）。",
      statePatch: { cabinTemperature: 24, airflow: "auto", passengerMode: "comfort" },
      slots: { temperature: 24, airflow: "auto", passengerMode: "comfort" },
    }),
  ],
  [
    "tailgate-success",
    vehicleSuccessBody({
      intent: "body.tailgate.open",
      rawText: "打开尾门",
      tool: "body.tailgate.open",
      visualScenario: "trunkControl",
      hmiSummary: "后备箱开启请求已发送（模拟执行）。",
      statePatch: { tailgate: "open_requested", tailgateOpen: true },
      slots: { open: true },
    }),
  ],
];

const negativeCases = [
  [
    "unknown-tool",
    vehicleSuccessBody({
      intent: "body.sunroof.open",
      rawText: "打开天窗",
      tool: "body.sunroof.open",
      visualScenario: "none",
      hmiSummary: "未知工具未执行。",
      statePatch: { rejected: true },
    }),
  ],
  [
    "tool-failed",
    {
      ...vehicleSuccessBody({
        intent: "cabin.climate.setPreset",
        rawText: "把空调调到24度",
        tool: "cabin.climate.setPreset",
        visualScenario: "cabin",
        hmiSummary: "开发适配器未执行车辆动作。",
      }),
      toolResult: {
        ok: false,
        tool: "cabin.climate.setPreset",
        source: "dev-adapter",
        visualScenario: "cabin",
        hmiSummary: "开发适配器未执行车辆动作。",
        statePatch: { rejected: true },
      },
    },
  ],
  [
    "confirmation-required",
    {
      ...vehicleSuccessBody({
        intent: "body.tailgate.open",
        rawText: "打开尾门",
        tool: "body.tailgate.open",
        visualScenario: "trunkControl",
        hmiSummary: "需要先确认尾门后方空间。",
      }),
      safetyDecision: {
        allowed: false,
        action: "require_confirmation",
        safeIntent: "body.tailgate.open",
      },
    },
  ],
  [
    "safety-reject",
    {
      task: "planning",
      rawText: "行驶中打开尾门",
      prompt: "根据安全网关拒绝结果生成摘要",
      parsedCommand: {
        intent: "safety.reject",
        rawText: "行驶中打开尾门",
        slots: { reason: "车辆行驶中禁止打开尾门。" },
      },
      safetyDecision: {
        allowed: false,
        action: "reject",
        safeIntent: "safety.reject",
        reason: "车辆行驶中禁止打开尾门。",
      },
      toolResult: {
        ok: false,
        tool: "safety.reject",
        source: "dev-adapter",
        visualScenario: "blocked",
        hmiSummary: "车辆行驶中不能打开尾门，请先安全停车并确认周围环境。",
        statePatch: { rejected: true },
      },
    },
  ],
  [
    "external-data",
    {
      task: "planning",
      rawText: "导航去公司",
      prompt: "根据外部数据结果生成摘要",
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
    },
  ],
];

const results = [];
for (const [label, body] of positiveCases) {
  const result = await fetchLocalLlm(label, body);
  assertTemplate(result, label);
  results.push({ label, provider: result.telemetry.provider, promptChars: result.telemetry.promptChars });
}

for (const [label, body] of negativeCases) {
  const result = await fetchLocalLlm(label, body);
  assertNotTemplate(result, label);
  results.push({ label, provider: result.telemetry.provider, reason: result.telemetry.reason || null });
}

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  rendererCapability: {
    id: PLANNING_TEMPLATE_RENDERER_CAPABILITY.id,
    version: PLANNING_TEMPLATE_RENDERER_CAPABILITY.version,
  },
  cases: results,
}, null, 2));
} finally {
  await stopIsolatedServer(isolatedServer.child);
}
