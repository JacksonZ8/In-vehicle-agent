import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const ollamaUrl = (process.env.NIO_OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const models = normalizeModels(process.env.NIO_LLM_COMPARE_MODELS);
const numPredict = 160;

const scalar = Symbol("safe-report-scalar");
const durationSchema = {
  total_duration_ms: scalar,
  load_duration_ms: scalar,
  prompt_eval_duration_ms: scalar,
  eval_duration_ms: scalar,
  prompt_eval_count: scalar,
  eval_count: scalar,
};
const candidateSchema = {
  model: scalar,
  wallMs: scalar,
  responseLength: scalar,
  done: scalar,
  ollamaDurations: durationSchema,
  prompt_eval_count: scalar,
  eval_count: scalar,
  error: scalar,
  status: scalar,
};
const baselineSchema = {
  provider: scalar,
  model: scalar,
  wallMs: scalar,
  durationMs: scalar,
  degraded: scalar,
  reason: scalar,
  promptStyle: scalar,
  planningSummaryMode: scalar,
  promptChars: scalar,
  summaryLength: scalar,
  ollamaDurations: durationSchema,
  cacheHit: scalar,
  cacheEligible: scalar,
};
const compareReportSchema = {
  ok: scalar,
  reason: scalar,
  checkedAt: scalar,
  baseUrl: scalar,
  ollamaUrl: scalar,
  models: [scalar],
  ollamaOptions: { temperature: scalar, num_predict: scalar, stream: scalar },
  purpose: scalar,
  cases: [{
    id: scalar,
    task: scalar,
    riskLevel: scalar,
    routingCandidate: scalar,
    notes: scalar,
    baseline: baselineSchema,
    promptChars: scalar,
    baselineSummaryLength: scalar,
    candidateRuns: [candidateSchema],
    baselineError: scalar,
  }],
};

function projectShape(value, schema) {
  if (schema === scalar) {
    return value === null || ["string", "number", "boolean"].includes(typeof value) ? value : undefined;
  }
  if (Array.isArray(schema)) {
    return Array.isArray(value) ? value.map((item) => projectShape(item, schema[0])) : [];
  }
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(schema).map(([key, nestedSchema]) => [key, projectShape(source[key], nestedSchema)]));
}

export function projectCompareLocalLlmReport(input) {
  const output = projectShape(input, compareReportSchema);
  output.cases = output.cases.map((item) => ({
    ...item,
    baselineError: item.baselineError ? "baseline-request-failed" : item.baselineError,
    candidateRuns: item.candidateRuns.map((candidate) => ({
      ...candidate,
      error: candidate.error ? "candidate-request-failed" : candidate.error,
    })),
  }));
  return output;
}

const cases = [
  {
    id: "conversation_smalltalk",
    riskLevel: "low",
    routingCandidate: "low-risk-candidate-review",
    notes: "低风险闲聊 / 能力介绍，可作为未来是否分层到更小对话模型的人工审查候选。",
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
          source: "benchmark-fixture",
        },
        slots: {
          topic: "smalltalk",
        },
      },
    },
  },
  {
    id: "conversation_vehicle_knowledge",
    riskLevel: "medium",
    routingCandidate: "quality-review-required",
    notes: "车辆知识边界属于质量风险较高的静态对照；低延迟收益不能替代事实边界与人工质量审查。",
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
          source: "benchmark-fixture",
        },
        slots: {
          topic: "vehicle_knowledge",
        },
      },
    },
  },
  {
    id: "planning_window_success",
    riskLevel: "vehicle-control-summary",
    routingCandidate: "not-routing-change",
    notes: "车控成功摘要只做耗时 / 文案对照；不代表改变 /api/local-llm 路由或 Safety Gateway 边界。",
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
    riskLevel: "safety-reject-control",
    routingCandidate: "not-routing-change",
    notes: "安全拒绝类仅作为对照，不建议直接小模型替代；Safety Gateway 裁决不得被候选模型覆盖。",
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

function normalizeModels(value) {
  const configured = String(value || "qwen2.5:7b,qwen2.5:3b")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(configured)];
}

function nsToMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value / 1_000_000) : undefined;
}

function buildOllamaDurations(data) {
  return {
    total_duration_ms: nsToMs(data.total_duration),
    load_duration_ms: nsToMs(data.load_duration),
    prompt_eval_duration_ms: nsToMs(data.prompt_eval_duration),
    eval_duration_ms: nsToMs(data.eval_duration),
    prompt_eval_count: data.prompt_eval_count,
    eval_count: data.eval_count,
  };
}

function summarizeBaseline(body, wallMs) {
  const telemetry = body.telemetry || {};
  return {
    provider: telemetry.provider,
    model: body.model,
    wallMs,
    durationMs: telemetry.durationMs,
    degraded: telemetry.degraded,
    reason: telemetry.reason,
    promptStyle: telemetry.promptStyle,
    planningSummaryMode: telemetry.planningSummaryMode,
    promptChars: telemetry.promptChars ?? (typeof body.prompt === "string" ? body.prompt.length : undefined),
    summaryLength: typeof body.summary === "string" ? body.summary.length : undefined,
    ollamaDurations: telemetry.ollamaDurations || {},
    cacheHit: telemetry.cacheHit,
    cacheEligible: telemetry.cacheEligible,
  };
}

async function postJson(url, payload, timeoutMs) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const wallMs = Math.round(performance.now() - startedAt);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), {
      wallMs,
      status: response.status,
    });
  }
  return { body, wallMs };
}

async function fetchBaseline(item) {
  const { body, wallMs } = await postJson(
    `${baseUrl}/api/local-llm`,
    {
      requestId: `compare-local-llm-${item.id}-${Date.now()}`,
      ...item.body,
    },
    60_000,
  );
  return {
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    summary: body.summary,
    baseline: summarizeBaseline(body, wallMs),
  };
}

async function runCandidate(model, prompt) {
  if (!prompt) {
    return {
      model,
      error: "No prompt returned by /api/local-llm; candidate was not run.",
    };
  }

  try {
    const { body, wallMs } = await postJson(
      `${ollamaUrl}/api/generate`,
      {
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0,
          num_predict: numPredict,
        },
      },
      120_000,
    );
    return {
      model,
      wallMs,
      responseLength: typeof body.response === "string" ? body.response.length : undefined,
      done: body.done,
      ollamaDurations: buildOllamaDurations(body),
      prompt_eval_count: body.prompt_eval_count,
      eval_count: body.eval_count,
    };
  } catch (error) {
    return {
      model,
      wallMs: error.wallMs,
      error: error.message,
      status: error.status,
    };
  }
}

async function compareCase(item) {
  try {
    const baselineResult = await fetchBaseline(item);
    const candidateRuns = [];
    for (const model of models) {
      candidateRuns.push(await runCandidate(model, baselineResult.prompt));
    }
    return {
      id: item.id,
      task: item.body.task,
      riskLevel: item.riskLevel,
      routingCandidate: item.routingCandidate,
      notes: item.notes,
      baseline: baselineResult.baseline,
      promptChars: baselineResult.prompt.length,
      baselineSummaryLength: typeof baselineResult.summary === "string" ? baselineResult.summary.length : undefined,
      candidateRuns,
    };
  } catch (error) {
    return {
      id: item.id,
      task: item.body.task,
      riskLevel: item.riskLevel,
      routingCandidate: item.routingCandidate,
      notes: item.notes,
      baselineError: error.message,
      candidateRuns: models.map((model) => ({
        model,
        error: "Skipped because baseline /api/local-llm request failed.",
      })),
    };
  }
}

async function main() {
  const comparedCases = [];
  for (const item of cases) {
    comparedCases.push(await compareCase(item));
  }

  const output = projectCompareLocalLlmReport({
        ok: true,
        reason: "completed",
        checkedAt: new Date().toISOString(),
        baseUrl,
        ollamaUrl,
        models,
        ollamaOptions: {
          temperature: 0,
          num_predict: numPredict,
          stream: false,
        },
        purpose:
          "Read-only evidence collection for local LLM model selection. This does not change /api/local-llm routing, production policy, or Safety Gateway behavior.",
        cases: comparedCases,
      });
  console.log(JSON.stringify(output, null, 2));
}

const isCliEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCliEntry) {
  main().catch(() => {
    const output = projectCompareLocalLlmReport({
      ok: false,
      reason: "benchmark-failed",
      checkedAt: new Date().toISOString(),
      baseUrl,
      ollamaUrl,
      models,
      ollamaOptions: { temperature: 0, num_predict: numPredict, stream: false },
      purpose: "Read-only evidence collection for local LLM model selection.",
      cases: [],
    });
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  });
}
