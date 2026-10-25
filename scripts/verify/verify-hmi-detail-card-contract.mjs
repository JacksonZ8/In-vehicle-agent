import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../../src/app/app.js", import.meta.url), "utf8");
const index = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../../src/app/styles.css", import.meta.url), "utf8");
const hmiHelpers = fs.readFileSync(new URL("../lib/hmi-test-helpers.mjs", import.meta.url), "utf8");
const conversationVerifier = fs.readFileSync(new URL("./verify-hmi-manual-conversation-evidence.mjs", import.meta.url), "utf8");
const safetyVerifier = fs.readFileSync(new URL("./verify-hmi-manual-safety-card.mjs", import.meta.url), "utf8");
const eligibilityVerifier = fs.readFileSync(new URL("./verify-hmi-manual-eligibility.mjs", import.meta.url), "utf8");
const tailgateConfirmationVerifier = fs.readFileSync(new URL("./verify-hmi-tailgate-confirmation.mjs", import.meta.url), "utf8");
const weatherClarificationVerifier = fs.readFileSync(new URL("./verify-hmi-weather-location-clarification.mjs", import.meta.url), "utf8");

assert.match(app, /function detailCardAttrs\(cardKind, classNames = "detail-card"\)/, "app.js must expose a single helper for run detail card attributes");
assert.match(app, /data-testid="run-detail-card"/, "detail cards must expose a stable data-testid");
assert.match(app, /data-card-kind="\$\{escapeHtml\(cardKind\)\}"/, "detail cards must expose data-card-kind");
assert.match(app, /function getRuntimeDebugSnapshot\(\)/, "app.js must expose a structured runtime debug snapshot builder");
assert.match(app, /window\.__runtimeDebug = getRuntimeDebugSnapshot;/, "HMI must expose window.__runtimeDebug");
assert.match(index, /<textarea id="commandInput"[\s\S]*placeholder="请输入希望完成的目标，例如：/, "command input must remain available and ask for a goal");
assert.match(index, /<button id="runButton"[\s\S]*>启动智能协作<\/button>/, "run button must present the goal-driven collaboration action");
assert.match(app, /data-component="\$\{escapeHtml\(component\.id\)\}"/, "component cards must expose their canonical component identity");
assert.match(app, /data-component-type="\$\{escapeHtml\(component\.type\)\}"/, "component cards must expose their canonical component type");
for (const [componentType, componentTypeLabel] of [
  ["ai-agent", "AI Agent"],
  ["model-service", "Model Service"],
  ["deterministic-service", "Deterministic Service"],
  ["tool-interface", "Tool / Interface"],
]) {
  assert.match(app, new RegExp(componentTypeLabel), `Missing component type label: ${componentTypeLabel}`);
  assert.match(styles, new RegExp(`\\.agent-card\\[data-component-type="${componentType}"\\]`),
    `Missing visual treatment for component type: ${componentType}`);
}
for (const status of [
  "queued", "processing", "awaiting_clarification", "completed", "cancelled",
  "safety_rejected", "unavailable", "failed", "uncertain",
]) {
  assert.match(styles, new RegExp(`\\.agent-card\\.${status}(?:\\W|$)`),
    `Missing canonical component status treatment: ${status}`);
}
for (const stableStageId of ["vehicleScene", "vehicle3dStage", "modelStatus"]) {
  assert.match(index, new RegExp(`id="${stableStageId}"`), `Vehicle stage ID must remain stable: ${stableStageId}`);
}
for (const stableLayoutClass of ["dashboard-grid", "vehicle-stage", "lower-deck"]) {
  assert.match(index, new RegExp(`class="${stableLayoutClass}"`), `Vehicle layout container must remain stable: ${stableLayoutClass}`);
}
assert.match(styles, /\.agent-card\[data-component-type="tool-interface"\] \.participant-type-badge::before/, "tool/interface badge must retain its connector marker");
assert.match(app, /detailCards: getRunDetailCardDebug\(\)/, "runtime debug snapshot must include detailCards");
assert.match(app, /pendingConfirmation: buildPendingConfirmationDebugSnapshot\(state\.pendingConfirmation\)/, "runtime debug snapshot must include a safe pendingConfirmation projection");
assert.match(hmiHelpers, /export async function assertNoHmiBootFailure/, "HMI test helper must centralize boot failure checks");
assert.match(hmiHelpers, /export function assertNoRuntimeExecutionPath/, "HMI test helper must centralize runtime no-execution checks");

for (const cardKind of [
  "agent-timeline",
  "b2-goal",
  "b2-plan",
  "user-input",
  "semantic-output",
  "vehicle-state-snapshot",
  "agent-communication",
  "llm-input",
  "llm-output",
  "stage-timing",
  "model-telemetry",
  "tts-speed",
  "weather-location-clarification",
  "manual-conversation-evidence",
  "manual-safety-evidence",
  "vehicle-component-audit",
  "tool-result",
]) {
  assert.match(app, new RegExp(cardKind), `Missing run detail card kind: ${cardKind}`);
}

assert.match(index, /id="safetyConfirmationModal"[\s\S]*?data-testid="safety-confirmation-modal"/, "pending confirmation must render in the stable safety confirmation modal");
assert.match(index, /id="safetyConfirmationConfirm"/, "safety confirmation modal must expose a stable confirm control");
assert.match(conversationVerifier, /\[data-testid="run-detail-card"\]\[data-card-kind="manual-conversation-evidence"\]/, "conversation HMI verifier must use structured card selector");
assert.match(conversationVerifier, /assertNoRuntimeExecutionPath/, "conversation HMI verifier must assert no execution via runtime debug");
assert.doesNotMatch(conversationVerifier, /locator\("\.detail-card", \{ hasText:/, "conversation HMI verifier must not locate the evidence card by title text");
assert.doesNotMatch(conversationVerifier, /locator\("body"\)\.innerText/, "conversation HMI verifier must not assert runtime outcome via whole-page body text");
assert.match(safetyVerifier, /\[data-testid="run-detail-card"\]\[data-card-kind="manual-safety-evidence"\]/, "manual safety HMI verifier must use structured card selector");
assert.match(safetyVerifier, /window\.__runtimeDebug\?\.\(\)/, "manual safety HMI verifier must assert runtime debug detail cards");
assert.doesNotMatch(safetyVerifier, /document\.body\?\.innerText/, "manual safety HMI verifier must not wait on whole-page body text");
assert.match(safetyVerifier, /assertNoHmiBootFailure/, "manual safety HMI verifier must use shared boot failure helper");
assert.match(eligibilityVerifier, /\[data-testid="run-detail-card"\]\[data-card-kind="manual-conversation-evidence"\]/, "manual eligibility HMI verifier must use structured card selector");
assert.match(eligibilityVerifier, /window\.__runtimeDebug\?\.\(\)/, "manual eligibility HMI verifier must assert runtime debug detail cards");
assert.doesNotMatch(eligibilityVerifier, /document\.body\?\.innerText/, "manual eligibility HMI verifier must not wait on whole-page body text");
assert.doesNotMatch(eligibilityVerifier, /locator\("body"\)\.innerText/, "manual eligibility HMI verifier must not assert on whole-page body text");
assert.match(tailgateConfirmationVerifier, /\[data-testid="safety-confirmation-modal"\]/, "tailgate confirmation HMI verifier must use the structured safety confirmation modal selector");
assert.match(tailgateConfirmationVerifier, /window\.__runtimeDebug\?\.\(\)/, "tailgate confirmation HMI verifier must use runtime debug");
assert.match(tailgateConfirmationVerifier, /pendingConfirmation\?\.challenge/, "tailgate confirmation HMI verifier must assert challenge via runtime debug");
assert.match(tailgateConfirmationVerifier, /must not expose the confirmation response token/, "tailgate confirmation HMI verifier must assert that responseToken stays internal");
assert.doesNotMatch(tailgateConfirmationVerifier, /document\.body\?\.innerText/, "tailgate confirmation HMI verifier must not wait on whole-page body text");
assert.doesNotMatch(tailgateConfirmationVerifier, /waitForBodyText/, "tailgate confirmation HMI verifier must not use whole-page text wait helper");
assert.match(tailgateConfirmationVerifier, /assertNoHmiBootFailure/, "tailgate confirmation HMI verifier must use shared boot failure helper");
assert.match(weatherClarificationVerifier, /\[data-testid="run-detail-card"\]\[data-card-kind="weather-location-clarification"\]/, "weather clarification HMI verifier must use structured card selector");
assert.match(weatherClarificationVerifier, /window\.__runtimeDebug\?\.\(\)/, "weather clarification HMI verifier must use runtime debug");
assert.doesNotMatch(weatherClarificationVerifier, /document\.body\?\.innerText/, "weather clarification HMI verifier must not wait on whole-page body text");
assert.match(weatherClarificationVerifier, /assertNoHmiBootFailure/, "weather clarification HMI verifier must use shared boot failure helper");

console.log(JSON.stringify({
  hmiDetailCardContract: true,
  runtimeDebug: true,
  cardKindCount: 18,
  structuredVerifiers: [
    "verify-hmi-manual-conversation-evidence.mjs",
    "verify-hmi-manual-safety-card.mjs",
    "verify-hmi-manual-eligibility.mjs",
    "verify-hmi-tailgate-confirmation.mjs",
    "verify-hmi-weather-location-clarification.mjs",
  ],
}, null, 2));
