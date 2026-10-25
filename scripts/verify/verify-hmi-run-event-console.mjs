import assert from "node:assert/strict";
import fs from "node:fs";
import { launchChromium } from "../lib/playwright-loader.mjs";
import { assertNoHmiBootFailure } from "../lib/hmi-test-helpers.mjs";
import { ES7_ACTION_CATALOG } from "../../src/vehicle/es7-action-catalog.js";

const baseUrl = process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173";
const screenshotPath = "/tmp/nio-hmi-run-event-console.png";
const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const appSource = fs.readFileSync(new URL("../../src/app/app.js", import.meta.url), "utf8");
const controllerSource = fs.readFileSync(
  new URL("../../src/app/developer-vehicle-state-controller.js", import.meta.url),
  "utf8",
);
const staticOnly = process.argv.includes("--static-only");

function functionSource(name, nextName) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `must locate ${name} source`);
  return appSource.slice(start, end);
}

const requiredIds = [
  "developerStateSource",
  "developerStateSnapshot",
  "developerStateCapturedAt",
  "developerStateLock",
  "developerStatePreset",
  "developerStateApplyPreset",
  "developerSeatControls",
  "developerContinuousControls",
  "developerBinaryControls",
  "developerStateReset",
  "developerStateStatus",
  "eventLog",
  "replayControls",
  "replayBackButton",
  "replayForwardButton",
  "replayLiveButton",
  "replayPosition",
];
for (const id of requiredIds) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing stable DOM id: ${id}`);
}

assert.equal((html.match(/id=["']eventLog["']/g) || []).length, 1, "collaboration log must have one state owner");
assert.ok(
  html.indexOf('id="eventLog"') > html.indexOf('id="runDetailSection"'),
  "collaboration log must move into the Run Detail section",
);
assert.match(
  html,
  /class=["'][^"']*developer-vehicle-state-panel[^"']*["'][^>]*data-development-only=["']true["']/,
  "vehicle state panel must remain development-only",
);
for (const removedId of [
  "scenarioConsole",
  "scenarioPreset",
  "scenarioApplyButton",
  "scenarioCapturedAt",
  "scenarioProviderSummary",
]) {
  assert.doesNotMatch(html, new RegExp(`id=["']${removedId}["']`), `${removedId} must be removed`);
  assert.doesNotMatch(appSource, new RegExp(`\b${removedId}\b`), `${removedId} logic must be removed`);
}
for (const preset of ["safe", "unsafe", "unknown", "confirmation", "stale", "sensor-fault"]) {
  assert.match(html, new RegExp(`<option value=["']${preset}["']>`), `missing ${preset} direct-state preset`);
}
assert.equal(Object.keys(ES7_ACTION_CATALOG).length, 25, "developer panel must use the canonical 25-clip catalog");

const controlBuilderSource = functionSource(
  "buildDeveloperVehicleStateControls",
  "setDeveloperStateNotice",
);
assert.match(controlBuilderSource, /seatDefinitions\.length\s*!==\s*4/);
assert.match(controlBuilderSource, /continuousDefinitions\.length\s*!==\s*6/);
assert.match(controlBuilderSource, /binaryDefinitions\.length\s*!==\s*15/);
assert.match(controlBuilderSource, /ES7_ACTION_CATALOG/, "controls must derive from the canonical catalog");

const projectionSource = functionSource(
  "projectDeveloperVehicleStateSnapshot",
  "renderDeveloperVehicleStatePanel",
);
assert.match(projectionSource, /state\.providerSnapshot\s*=\s*snapshot/);
assert.match(projectionSource, /syncConfirmedState\?\.\(snapshot,\s*\{\s*immediate:\s*false\s*\}\)/);
assert.doesNotMatch(projectionSource, /applyHmiPresentation|playScenarioAnimation/, "direct state must project only from Provider snapshot");

const lockSource = functionSource("isDeveloperVehicleStateLocked", "defaultStaleCapturedAt");
assert.match(lockSource, /state\.running/);
assert.match(lockSource, /pendingVehicleExecutionsByComponent\.size/);
assert.match(lockSource, /state\.pendingConfirmation/);

assert.match(controllerSource, /simulator\.readVehicleState\(patch,\s*\{\s*mode\s*\}\)/);
assert.match(controllerSource, /vehicleStateProvider\.ingestDemoSensorState\(reading\)/);
assert.doesNotMatch(
  controllerSource,
  /SafetyGateway|VehicleTools|RuntimeKernel|CloudLLM|Orchestrator|ToolCall|commandId/,
  "developer controller must not fabricate or traverse Agent/Safety/Tool execution",
);

const providerSummarySource = functionSource("buildScenarioProviderSummary", "buildPendingVehicleExecutionFingerprint");
assert.match(providerSummarySource, /buildProviderSnapshotSummary\(/);

for (const [name, nextName] of [
  ["renderReplayProjection", "stepReplayBack"],
  ["stepReplayBack", "stepReplayForward"],
  ["stepReplayForward", "returnToLiveProjection"],
  ["returnToLiveProjection", "renderRunEventProjection"],
]) {
  assert.doesNotMatch(
    functionSource(name, nextName),
    /pendingVehicleExecutionsByComponent/,
    `${name} must not mutate pending vehicle execution state`,
  );
}

if (staticOnly) {
  console.log("HMI developer vehicle state panel static verification passed");
  process.exit(0);
}

const browser = await launchChromium({ headless: true });
const page = await browser.newPage();

try {
  await page.addInitScript(() => {
    window.NIO_TTS_PROVIDER = "browser";
    window.NIO_TTS_BRIDGE_ENABLED = false;
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await assertNoHmiBootFailure(page, "developer vehicle state panel boot");
  await page.waitForFunction(() => typeof window.__runtimeDebug === "function");

  assert.equal(await page.locator("[data-developer-action-input]").count(), 10, "4 seat + 6 continuous controls");
  assert.equal(await page.locator("[data-developer-action-button]").count(), 15, "15 binary controls");

  await page.locator("#developerStatePreset").selectOption("safe");
  await page.locator("#developerStateApplyPreset").click();
  await page.waitForFunction(() => {
    const values = window.__runtimeDebug?.()?.providerScenarioSnapshot?.values;
    return values?.speedKph === 0 && values?.gear === "P" && values?.rearClearance === true;
  });

  await page.locator("#developerSpeedKph").fill("12");
  await page.locator("#developerSpeedKph").dispatchEvent("change");
  await page.waitForFunction(() => window.__runtimeDebug?.()?.providerScenarioSnapshot?.values?.speedKph === 12);

  const seat = page.locator('[data-developer-action-input="driver_seat_fore_aft"]');
  await seat.evaluate((element) => {
    element.value = "4";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // The debug provider summary only carries safety fields; the developer panel re-renders
  // each control from the Provider snapshot, so a known control value proves ingestion.
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-developer-action-input="driver_seat_fore_aft"]');
    return input?.value === "4"
      && !input.closest(".developer-range-control")?.hasAttribute("data-unknown")
      && /已同步到 Provider/.test(document.querySelector("#developerStateStatus")?.textContent || "");
  });

  await page.locator('[data-developer-action-button="front_left_door_open"]').click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-developer-action-button="front_left_door_open"]');
    return button?.getAttribute("aria-pressed") === "true" && button.dataset.state === "known";
  });
  assert.match(await page.locator("#eventLog").innerText(), /developer|开发者/);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    screenshotPath,
    checks: {
      directProviderStatePanel: true,
      canonical25ClipControls: true,
      collaborationLogRelocated: true,
      safetyPreset: true,
      sensorField: true,
      continuousSeatState: true,
      binaryMechanicalState: true,
      localDeveloperAudit: true,
    },
  }, null, 2));
} catch (error) {
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ ok: false, baseUrl, screenshotPath, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
