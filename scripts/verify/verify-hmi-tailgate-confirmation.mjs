import { launchChromium } from "../lib/playwright-loader.mjs";
import { assertNoHmiBootFailure } from "../lib/hmi-test-helpers.mjs";
const baseUrl = process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173";
const screenshotPath = "/tmp/nio-hmi-tailgate-confirmation.png";
const commandText = "帮我打开后备箱";
const assertionPromptPattern = /我已确认尾门后方无人且无障碍物/;
const staleHardCodedButtonPattern = /确认后方安全，重新执行/;
const phaseTimeoutMs = 95_000;
const totalTimeoutMs = phaseTimeoutMs * 2 + 20_000;

function assertTextDoesNotMatch(text, pattern, message) {
  if (pattern.test(text)) {
    throw new Error(message);
  }
}

const browser = await launchChromium();
const page = await browser.newPage();
const totalTimeout = setTimeout(() => page.close(), totalTimeoutMs);

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#commandInput").fill(commandText);
  await page.locator("#runButton").click();

  await assertNoHmiBootFailure(page, "tailgate confirmation initial verification");

  const pendingModal = page.locator('[data-testid="safety-confirmation-modal"]');
  await pendingModal.waitFor({ state: "visible", timeout: phaseTimeoutMs });
  const pendingCardText = await pendingModal.innerText();
  if (!assertionPromptPattern.test(pendingCardText)) {
    throw new Error(`Safety confirmation modal did not show assertion prompt. Modal text: ${pendingCardText}`);
  }
  const pendingDebug = await page.evaluate(() => window.__runtimeDebug?.());
  const initialRequestId = pendingDebug?.latestRun?.requestId;
  const challenge = pendingDebug?.pendingConfirmation?.challenge;
  if (!challenge?.id || !challenge?.actionDigest || !Array.isArray(challenge.assertions)) {
    throw new Error(`HMI runtime debug does not expose complete confirmation challenge audit fields: ${JSON.stringify(challenge || {})}`);
  }
  if (Object.hasOwn(challenge, "responseToken")) {
    throw new Error("HMI runtime debug must not expose the confirmation response token.");
  }
  assertTextDoesNotMatch(pendingCardText, staleHardCodedButtonPattern, "HMI confirmation button must use generic challenge wording, not tailgate-specific hardcoded text.");
  // The modal is actionable as soon as it opens, even while the risk prompt is still spoken;
  // confirming stops the playback before re-entering Runtime and Safety.
  await page.waitForFunction(
    () => document.querySelector("#safetyConfirmationConfirm")?.disabled === false,
    null,
    { timeout: 5_000 },
  );
  const confirmedDuringPlayback = await page.evaluate(() => window.__runtimeDebug?.()?.running === true);
  await page.locator("#safetyConfirmationConfirm").click({ timeout: 5_000 });

  await page.waitForFunction(() => {
    const result = window.__runtimeDebug?.()?.latestRun?.result || {};
    return result.toolResult?.tool === "body.tailgate.open" && result.safetyDecision?.allowed === true;
  }, null, { timeout: phaseTimeoutMs });

  const finalDebug = await page.evaluate(() => window.__runtimeDebug?.());
  const finalResult = finalDebug?.latestRun?.result || {};
  if (!initialRequestId || finalDebug?.latestRun?.requestId === initialRequestId) {
    throw new Error("HMI confirmation must execute through a second Run with a new requestId.");
  }
  await assertNoHmiBootFailure(page, "tailgate confirmation final verification");
  if (finalResult.safetyDecision?.action === "require_confirmation") {
    throw new Error(`Final runtime result still requires confirmation: ${JSON.stringify(finalResult.safetyDecision)}`);
  }
  if (finalResult.vehicleStateSnapshot?.values?.rearClearance !== null) {
    throw new Error(`Confirmed replay must preserve unknown rearClearance instead of fabricating a sensor value: ${JSON.stringify(finalResult.vehicleStateSnapshot?.values || {})}`);
  }
  if (finalDebug?.pendingConfirmation) {
    throw new Error(`Pending confirmation was not cleared after replay: ${JSON.stringify(finalDebug.pendingConfirmation)}`);
  }

  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    command: commandText,
    screenshotPath,
    checks: {
      noBootFailureText: true,
      hasConfirmationPrompt: true,
      hasAssertionPrompt: true,
      hasConfirmationButton: true,
      noTailgateSpecificButtonHardcode: true,
      hasBoundChallengeAudit: true,
      safetyConfirmationModal: true,
      confirmedDuringPlayback,
      hasTailgateSuccessAfterReplay: true,
      finalStateNotRequireConfirmation: true,
      rearClearanceRemainsUnknown: true,
    },
  }, null, 2));
} catch (error) {
  const runtimeDebug = await page.evaluate(() => window.__runtimeDebug?.()).catch(() => null);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  console.error(JSON.stringify({
    ok: false,
    baseUrl,
    command: commandText,
    screenshotPath,
    error: error.message,
    diagnostic: {
      mode: runtimeDebug?.mode,
      running: runtimeDebug?.running,
      pendingConfirmation: runtimeDebug?.pendingConfirmation || null,
      latestResult: runtimeDebug?.latestRun?.result || runtimeDebug?.lastRuntimeResult || null,
      latestError: runtimeDebug?.latestRun?.error || "",
      requestId: runtimeDebug?.requestId || runtimeDebug?.latestRun?.requestId || null,
    },
  }, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(totalTimeout);
  await browser.close();
}
