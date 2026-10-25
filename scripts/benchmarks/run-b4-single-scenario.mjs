import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { getBenchmarkScenario } from "../../src/benchmark/run-benchmark-scenarios.js";
import { isPublicBenchmarkReasonCode } from "../../src/benchmark/run-benchmark-sample-contract.js";
import { createB4BrowserProbe } from "../lib/b4-browser-probe.mjs";
import { launchChromium } from "../lib/playwright-loader.mjs";
import {
  assertAgentServerReady,
  projectPublicHmiEvidence,
  sampleFromProbe,
} from "./run-b4-baseline.mjs";

const DEFAULT_BASE_URL = "http://127.0.0.1:4173";
const PUBLIC_FAILURE_STAGES = new Set([
  "preflight",
  "browser-launch",
  "page-load",
  "runtime-warmup",
  "rig-ready",
  "first-run",
  "confirmation",
  "new-run",
  "second-run",
  "observation",
  "acceptance",
]);

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (typeof value !== "string" || !value.trim() || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value.trim();
}

function positiveInteger(value, option) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new TypeError(`${option} must be a positive integer`);
  }
  return Number(value);
}

function preflightError(message, code) {
  const error = new TypeError(message);
  error.stage = "preflight";
  error.code = code;
  return error;
}

function safeToken(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(normalized) ? normalized : null;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonnegativeDuration(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function safeContractErrors(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 240)
    .map((entry) => entry.replace(/[\r\n]/g, " "));
}

function safeManualEvidenceLink(value) {
  if (typeof value !== "string" || !value.startsWith("/userguide?")) return null;
  try {
    const url = new URL(value, "http://127.0.0.1");
    const keys = [...url.searchParams.keys()].sort();
    if (url.origin !== "http://127.0.0.1"
      || url.pathname !== "/userguide"
      || keys.join(",") !== "chunk,run,source"
      || !url.searchParams.get("source")
      || !url.searchParams.get("chunk")
      || !url.searchParams.get("run")) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function projectModelCall(call) {
  const telemetry = call?.telemetry;
  const candidateReasonCode = telemetry?.reasonCode
    ?? telemetry?.fallbackReasonCode
    ?? telemetry?.structuredValidationReason;
  return Object.freeze({
    phase: safeToken(call?.phase),
    provider: safeToken(telemetry?.provider),
    model: safeToken(telemetry?.model),
    durationMs: nonnegativeDuration(telemetry?.durationMs),
    externalModelRequestCount: nonnegativeInteger(telemetry?.externalModelRequestCount),
    reasonCode: isPublicBenchmarkReasonCode(candidateReasonCode) ? candidateReasonCode : null,
  });
}

export function parseSingleScenarioArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  let scenarioId = null;
  let authorizedMaxExternalModelRequests = null;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!["--scenario", "--authorized-max-external-model-requests"].includes(option)) {
      throw new TypeError(`unknown argument: ${option}`);
    }
    if (seen.has(option)) throw new TypeError(`duplicate argument: ${option}`);
    seen.add(option);
    const value = requireValue(argv, index, option);
    index += 1;
    if (option === "--scenario") scenarioId = value;
    else authorizedMaxExternalModelRequests = positiveInteger(value, option);
  }
  const scenario = getBenchmarkScenario(scenarioId);
  if (!scenario) {
    throw preflightError(
      "--scenario must identify a canonical benchmark scenario",
      "scenario-invalid",
    );
  }
  if (authorizedMaxExternalModelRequests !== scenario.modelBudget.maxCalls) {
    throw preflightError(
      `external model request authorization must equal the canonical scenario budget ${scenario.modelBudget.maxCalls}`,
      "authorization-mismatch",
    );
  }
  return Object.freeze({ scenarioId, authorizedMaxExternalModelRequests });
}

export function projectSingleScenarioDiagnostic({
  sample,
  modelCalls = [],
  manualEvidenceLink = null,
  routeDecision = null,
} = {}) {
  const scenario = getBenchmarkScenario(sample?.scenarioId);
  if (!scenario) throw new TypeError("sample must identify a canonical scenario");
  const metrics = sample?.projectedMetrics || {};
  const publicEvidence = sample?.diagnostics?.publicHmiEvidence || {};
  const knowledgeEvidence = Array.isArray(publicEvidence.events)
    ? publicEvidence.events.find((event) => event?.phase === "knowledge-evidence")
    : null;
  const manualEvidenceRefCount = Array.isArray(knowledgeEvidence?.refs)
    ? knowledgeEvidence.refs.length
    : 0;
  const safePrimaryLink = safeManualEvidenceLink(manualEvidenceLink);
  const behavior = metrics.behavior || {};
  return Object.freeze({
    status: metrics.outcome === "passed" ? "PASS" : "FAIL",
    scenarioId: scenario.id,
    outcome: safeToken(metrics.outcome) || "contract-failed",
    contractErrors: Object.freeze(safeContractErrors(metrics.contractErrors)),
    budgetErrors: Object.freeze(safeContractErrors(metrics.budgetErrors)),
    route: Object.freeze({
      routeId: safeToken(routeDecision?.routeId),
      mode: safeToken(routeDecision?.mode),
    }),
    latencyMs: Object.freeze({
      firstFeedback: nonnegativeDuration(metrics.submissionToFirstFeedbackMs),
      finalVisible: nonnegativeDuration(metrics.submissionToResultVisibleMs),
      run: nonnegativeDuration(metrics.durationMs),
      manualRetrieval: nonnegativeDuration(knowledgeEvidence?.durationMs),
    }),
    modelRequests: Object.freeze({
      observedExternal: nonnegativeInteger(publicEvidence.observedExternalModelRequestCount),
      maximumAuthorized: scenario.modelBudget.maxCalls,
      calls: Object.freeze(Array.isArray(modelCalls) ? modelCalls.map(projectModelCall) : []),
    }),
    manualEvidence: Object.freeze({
      status: knowledgeEvidence?.status === "completed"
        && manualEvidenceRefCount > 0
        && safePrimaryLink
        ? "hit"
        : "unavailable",
      refCount: manualEvidenceRefCount,
      primaryLink: safePrimaryLink,
    }),
    hmi: Object.freeze({
      firstFeedbackObserved: publicEvidence.firstFeedbackObserved === true,
      resultVisible: publicEvidence.resultVisible === true,
      visibleCardKinds: Object.freeze((publicEvidence.visibleCardKinds || [])
        .map(safeToken)
        .filter(Boolean)),
    }),
    sideEffects: Object.freeze({
      toolCalls: nonnegativeInteger(behavior.vehicleToolCalls),
      adapterExecutions: nonnegativeInteger(behavior.adapterExecutions),
      vehicleWrites: nonnegativeInteger(behavior.vehicleWrites),
    }),
  });
}

export function projectSingleScenarioFailureDiagnostic({ scenarioId, error } = {}) {
  const canonicalScenarioId = getBenchmarkScenario(scenarioId)?.id || "unavailable";
  const stage = PUBLIC_FAILURE_STAGES.has(error?.stage) ? error.stage : "acceptance";
  return Object.freeze({
    status: "FAIL",
    scenarioId: canonicalScenarioId,
    failure: Object.freeze({
      stage,
      reasonCode: safeToken(error?.code) || `${stage}-failed`,
    }),
  });
}

async function readPublicDebug(page) {
  return page.evaluate(() => {
    const debug = window.__runtimeDebug?.() || {};
    const probeState = window.__b4BenchmarkProbe;
    const counters = window.__b2AcceptanceCalls;
    const present = (target, field) => target !== null
      && typeof target === "object"
      && Object.prototype.hasOwnProperty.call(target, field)
      && Number.isInteger(target[field])
      && target[field] >= 0;
    return {
      detailCards: debug.detailCards || [],
      currentTurn: debug.currentTurn || null,
      queuedTurn: debug.queuedTurn || null,
      interactionEvents: debug.interactionEvents || [],
      interactionSession: debug.interactionSession || null,
      relatedRunIds: debug.relatedRunIds || [],
      instrumentation: {
        modelRequestCount: present(probeState, "modelRequestCount"),
        externalModelRequestCount: present(probeState, "externalModelRequestCount"),
        safetyCallCount: present(counters, "safetyCallCount"),
        toolCallCount: present(counters, "toolCallCount"),
        adapterAcceptedCount: present(counters, "adapterAcceptedCount"),
        providerCallCount: present(counters, "providerCallCount"),
        providerAcceptedCount: present(counters, "providerAcceptedCount"),
        providerStateChangeCount: present(counters, "providerStateChangeCount"),
      },
    };
  });
}

async function readManualEvidenceLink(page) {
  return page.evaluate(() => document
    .querySelector('[data-testid="manual-primary-evidence-link"]')
    ?.getAttribute("href") || null);
}

export async function runSingleScenario({
  scenarioId,
  authorizedMaxExternalModelRequests,
  baseUrl = process.env.NIO_AGENT_BASE_URL || DEFAULT_BASE_URL,
} = {}) {
  const scenario = getBenchmarkScenario(scenarioId);
  if (!scenario || authorizedMaxExternalModelRequests !== scenario.modelBudget.maxCalls) {
    const error = new TypeError("single scenario authorization does not match its canonical budget");
    error.stage = "preflight";
    error.code = "authorization-mismatch";
    throw error;
  }
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
  await assertAgentServerReady(normalizedBaseUrl).catch((error) => {
    error.stage = "preflight";
    error.code = "agent-server-not-ready";
    throw error;
  });

  let browser;
  let page;
  try {
    browser = await launchChromium({ headless: true }).catch((error) => {
      error.stage = "browser-launch";
      error.code = "browser-launch-failed";
      throw error;
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const probe = await createB4BrowserProbe({ page, scenario, timeoutMs: scenario.timeoutMs });
    await page.goto(normalizedBaseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch((error) => {
      error.stage = "page-load";
      error.code = "page-load-failed";
      throw error;
    });
    await page.waitForFunction(() => typeof window.__runtimeDebug === "function"
      && typeof window.__vehicleDebug === "function"
      && typeof window.runCommand === "function", null, { timeout: 15_000 });

    const startedAt = new Date().toISOString();
    const probeResult = await probe.run({
      requestId: `live:${scenario.id}:${randomUUID()}`,
    });
    const [publicDebug, manualEvidenceLink] = await Promise.all([
      readPublicDebug(page),
      readManualEvidenceLink(page),
    ]);
    const publicHmiEvidence = projectPublicHmiEvidence({ probeResult, publicDebug });
    const sample = sampleFromProbe(
      { sampleKey: `single:${scenario.id}:1`, scenarioId: scenario.id, repeat: 1 },
      scenario,
      { ...probeResult, publicHmiEvidence },
      startedAt,
      new Date().toISOString(),
    );
    return projectSingleScenarioDiagnostic({
      sample,
      modelCalls: probeResult.runDebug?.result?.runtimeTelemetry?.modelCalls,
      manualEvidenceLink,
      routeDecision: probeResult.runDebug?.result?.routeDecision,
    });
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  let args;
  let diagnostic;
  try {
    args = parseSingleScenarioArgs(argv);
    diagnostic = await runSingleScenario(args);
  } catch (error) {
    const scenarioOptionIndex = argv.indexOf("--scenario");
    const scenarioId = args?.scenarioId
      || (scenarioOptionIndex >= 0 ? argv[scenarioOptionIndex + 1] : null);
    diagnostic = projectSingleScenarioFailureDiagnostic({ scenarioId, error });
  }
  console.log(JSON.stringify(diagnostic, null, 2));
  if (diagnostic.status !== "PASS") process.exitCode = 1;
  return diagnostic;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runCli();
}
