import { launchChromium } from "../lib/playwright-loader.mjs";
import { assertNoHmiBootFailure } from "../lib/hmi-test-helpers.mjs";

const baseUrl = process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173";
const screenshotPath = "/tmp/nio-hmi-weather-location-clarification.png";
const commandText = "这里天气怎么样";

const browser = await launchChromium();
const page = await browser.newPage();
try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await assertNoHmiBootFailure(page, "weather-clarification-load");
  await page.locator("#commandInput").fill(commandText);
  await page.locator("#runButton").click();
  const card = page.locator('[data-testid="run-detail-card"][data-card-kind="weather-location-clarification"]');
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => {
    const cardText = document.querySelector('[data-testid="run-detail-card"][data-card-kind="weather-location-clarification"]')?.innerText || "";
    return cardText.includes("nio-weather-location-clarification@1.0.0")
      && cardText.includes("weather_location_needs_clarification");
  }, undefined, { timeout: 30_000 });

  const cardText = await card.innerText();
  const runtimeDebug = await page.evaluate(() => window.__runtimeDebug?.());
  if (!runtimeDebug?.detailCards?.some((item) => item.cardKind === "weather-location-clarification")) {
    throw new Error("window.__runtimeDebug did not expose weather-location-clarification detail card.");
  }
  const runResult = runtimeDebug?.latestRun?.result || runtimeDebug?.lastRuntimeResult || {};
  // Weather is a direct read-only external query: one weather adapter call, no Safety Gateway,
  // no vehicle tool and no model prompt for the clarification itself.
  if (runResult.safetyDecision) {
    throw new Error(`weather location clarification reached Safety Gateway: ${JSON.stringify(runResult.safetyDecision)}`);
  }
  const toolCall = runResult.toolCall || {};
  const toolResult = runResult.toolResult || {};
  if (toolCall.tool !== "conversation.general" || toolResult.source !== "weather-api-adapter") {
    throw new Error(`Expected the read-only weather adapter path, got ${JSON.stringify({ toolCall, toolResult })}`);
  }
  if (toolResult.ok !== false || toolResult.executionError?.code !== "weather_location_needs_clarification") {
    throw new Error(`Expected weather_location_needs_clarification, got ${JSON.stringify(toolResult)}`);
  }
  if (runResult.cloudResult) {
    throw new Error(`Weather clarification must not call the cabin model: ${JSON.stringify(runResult.cloudResult)}`);
  }
  if (!cardText.includes("候选数\n0") || !cardText.includes("当前未接入可信当前位置")) {
    throw new Error(`Weather clarification card missing expected no-context boundary: ${cardText}`);
  }

  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    command: commandText,
    screenshotPath,
    checks: {
      stableCardKind: "weather-location-clarification",
      policyVisible: true,
      readOnlyWeatherAdapter: true,
      noSafetyDecision: true,
      noCabinModelCall: true,
      candidateCountZero: true,
    },
  }, null, 2));
} catch (error) {
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ ok: false, baseUrl, command: commandText, screenshotPath, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
