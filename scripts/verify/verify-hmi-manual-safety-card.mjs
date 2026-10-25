import { launchChromium } from "../lib/playwright-loader.mjs";
import { assertNoHmiBootFailure } from "../lib/hmi-test-helpers.mjs";

const baseUrl = process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173";
const screenshotPath = "/tmp/nio-hmi-manual-safety-card.png";
const commandText = "关闭主驾车窗";
const manualSafetyCardSelector = '[data-testid="run-detail-card"][data-card-kind="manual-safety-evidence"]';

const browser = await launchChromium();
const page = await browser.newPage();

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  if (await page.locator(manualSafetyCardSelector).count()) {
    throw new Error("An empty Safety decision must not render a manual Safety card.");
  }

  await page.locator("#commandInput").fill(commandText);
  await page.locator("#runButton").click();
  await assertNoHmiBootFailure(page, "manual safety no-card initial verification");
  await page.waitForFunction(() => {
    const debug = window.__runtimeDebug?.();
    return debug?.running === false && Boolean(debug?.latestRun?.result?.safetyDecision);
  }, null, { timeout: 90_000 });

  const runtimeDebug = await page.evaluate(() => window.__runtimeDebug?.());
  const runResult = runtimeDebug?.latestRun?.result || {};
  const safetyDecision = runResult.safetyDecision;
  if (!safetyDecision
    || typeof safetyDecision.allowed !== "boolean"
    || typeof safetyDecision.action !== "string"
    || !safetyDecision.action
    || typeof safetyDecision.reason !== "string"
    || !safetyDecision.reason) {
    throw new Error("The window command did not preserve its real Safety decision path.");
  }
  if (runResult.parsedCommand?.intent !== "body.window.setPosition"
    || runResult.toolCall?.tool !== "body.window.setPosition"
    || runResult.toolResult?.tool !== "body.window.setPosition") {
    throw new Error("The window command did not preserve its real vehicle execution path.");
  }
  if (safetyDecision.manualEvidenceStatus !== "miss"
    || (Array.isArray(safetyDecision.manualEvidence) && safetyDecision.manualEvidence.length > 0)
    || !Array.isArray(safetyDecision.manualSafetyConstraints)
    || safetyDecision.manualSafetyConstraints.length > 0) {
    throw new Error("The vehicle Safety decision was polluted by Manual RAG evidence.");
  }
  if (await page.locator(manualSafetyCardSelector).count()
    || runtimeDebug?.detailCards?.some((item) => item.cardKind === "manual-safety-evidence")) {
    throw new Error("A miss/empty Safety decision incorrectly rendered a manual Safety card.");
  }
  if (runtimeDebug?.manualSafetyCloneBoundary?.visible
    || runtimeDebug?.manualSafetyCloneBoundary?.evidenceCount !== 0
    || runtimeDebug?.manualSafetyCloneBoundary?.constraintCount !== 0) {
    throw new Error("The structuredClone Safety boundary accepted an unbound Manual evidence shell.");
  }
  if (runtimeDebug?.manualEvidenceBoundary?.status !== "not_requested") {
    throw new Error("The vehicle command was incorrectly presented as a Manual RAG request.");
  }
  await assertNoHmiBootFailure(page, "manual safety no-card final verification");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    command: commandText,
    screenshotPath,
    checks: {
      safetyDecisionPresent: true,
      vehicleExecutionPathPresent: true,
      manualEvidenceStatus: "miss",
      manualSafetyConstraintsEmpty: true,
      manualSafetyCardAbsent: true,
      runtimeSafetyCloneInvisible: true,
      manualRagNotRequested: true,
    },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    baseUrl,
    command: commandText,
    screenshotPath,
    error: error.message,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
