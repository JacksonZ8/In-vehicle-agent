export const PLANNING_TEMPLATE_RENDERER_CAPABILITY = Object.freeze({
  id: "nio-planning-template-renderer",
  version: "1.0.0",
  requires: Object.freeze({
    task: "planning",
    toolResultOk: true,
    hmiSummary: true,
    safetyAllowed: true,
    noExternalDataNeed: true,
    noConfirmation: true,
  }),
  blockedVisualScenarios: Object.freeze(["blocked", "none"]),
  externalSources: Object.freeze(["external-data-dev-adapter"]),
});

export function hasExternalDataNeedForPlanningSummary(body = {}) {
  const parsed = body.parsedCommand || {};
  const slots = parsed.slots || {};
  return (
    body.requiresExternalData === true
    || parsed.requiresExternalData === true
    || slots.requiresExternalData === true
    || Boolean(body.externalDataType || parsed.externalDataType || slots.externalDataType)
  );
}

export function isPlanningSummaryTask(body = {}) {
  const task = body.task || "";
  if (task === "planning") return true;
  if (task === "conversation_general" || task === "safety_explain") return false;
  return false;
}

export function isConfirmationOutcome(body = {}) {
  const parsed = body.parsedCommand || {};
  const safetyDecision = body.safetyDecision || {};
  return (
    parsed.action === "require_confirmation"
    || parsed.slots?.needsConfirmation === true
    || safetyDecision.action === "require_confirmation"
  );
}

export function isExternalToolResult(toolResult = {}) {
  return PLANNING_TEMPLATE_RENDERER_CAPABILITY.externalSources.includes(toolResult.source);
}

export function hasRenderablePlanningToolResult(toolResult = {}) {
  const hmiSummary = typeof toolResult.hmiSummary === "string" ? toolResult.hmiSummary.trim() : "";
  if (toolResult.ok !== true || hmiSummary.length === 0) return false;
  if (toolResult.tool === "safety.reject") return false;
  if (isExternalToolResult(toolResult)) return false;
  if (PLANNING_TEMPLATE_RENDERER_CAPABILITY.blockedVisualScenarios.includes(toolResult.visualScenario)) return false;
  return true;
}

export function isTemplatePlanningSummaryCandidate(body = {}, { planningSummaryMode = "llm" } = {}) {
  const safetyDecision = body.safetyDecision || {};
  const toolResult = body.toolResult || {};
  return (
    planningSummaryMode === "template"
    && isPlanningSummaryTask(body)
    && hasRenderablePlanningToolResult(toolResult)
    && !hasExternalDataNeedForPlanningSummary(body)
    && safetyDecision.allowed !== false
    && safetyDecision.action !== "reject"
    && !isConfirmationOutcome(body)
  );
}

export function buildTemplatePlanningSummary(toolResult = {}) {
  const hmiSummary = String(toolResult.hmiSummary || "").trim();
  const normalized = /[。！？!?]$/.test(hmiSummary) ? hmiSummary : `${hmiSummary}。`;
  return `${normalized}已通过车端安全校验。`;
}
