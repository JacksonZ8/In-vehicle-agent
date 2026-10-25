import assert from "node:assert/strict";
import { createServer } from "../../src/server/local-agent-server.mjs";
import { launchChromium } from "../lib/playwright-loader.mjs";

const server = createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/`;
const browser = await launchChromium();

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.vehicleRig?.getState?.().modelLoaded === true, null, {
    timeout: 30_000,
  });

  const initial = await page.evaluate(() => ({
    loadState: window.__vehicleLoadState,
    rigState: window.vehicleRig.getState(),
    capabilities: window.vehicleRig.getCapabilities(),
    manualControlsPresent: Boolean(document.querySelector(".vehicle-controls")),
    componentExploderPresent: Boolean(document.querySelector(".component-exploder")),
    publicManualFocusPresent: typeof window.vehicleRig.focusComponent === "function",
    publicExplodePresent: typeof window.vehicleRig.setExploded === "function",
  }));

  assert.equal(initial.loadState, "loaded");
  assert.equal(initial.rigState.modelLoaded, true);
  assert.equal(initial.rigState.loadedVehicleAnimationClips.length, 25);
  assert.equal(initial.rigState.es7AnimationRuntime?.ready, true);
  assert.equal(initial.rigState.es7AnimationRuntime?.clipCount, 25);
  assert.deepEqual(initial.rigState.displayStage, {
    present: true,
    variant: "dark-static-pedestal",
    y: initial.rigState.displayStage.y,
  });
  assert.ok(Number.isFinite(initial.rigState.displayStage.y));
  assert.equal(initial.rigState.seatAdjustmentFocus?.ready, true);
  assert.equal(initial.rigState.seatAdjustmentFocus?.active, false);
  assert.equal(initial.rigState.seatAdjustmentFocus?.clearSeatNodeCount, 4);
  assert.deepEqual(initial.rigState.seatAdjustmentFocus?.missingClearSeatNodes, []);
  assert.equal(initial.capabilities.seatAdjustmentFocus, "four-seat-material-fog");
  assert.deepEqual(initial.rigState.missingOriginalComponents, []);
  assert.equal(initial.capabilities.mechanicalAnimationSource, "nio-es7-glb-clips");
  assert.equal("engineeringProxyStatus" in initial.capabilities, false);
  assert.equal(initial.manualControlsPresent, false);
  assert.equal(initial.componentExploderPresent, false);
  assert.equal(initial.publicManualFocusPresent, false);
  assert.equal(initial.publicExplodePresent, false);

  const accepted = await page.evaluate(() => window.vehicleRig.syncConfirmedState({
    id: "browser-confirmed-es7-hood-open",
    values: { componentActionStateById: { hood_open: 1 } },
  }, { immediate: true }));
  assert.equal(accepted, true);

  const hoodProgress = await page.evaluate(
    () => window.vehicleRig.getState().es7AnimationRuntime.progressByActionId.hood_open,
  );
  assert.equal(hoodProgress, 1);

  assert.equal(await page.evaluate(() => window.vehicleRig.beginSeatAdjustmentFocus({
    reason: "browser-direct-seat-input",
  })), true);
  await page.waitForFunction(() => {
    const focus = window.vehicleRig.getState().seatAdjustmentFocus;
    return focus.active === true && focus.foggedMeshCount > 0 && focus.materialCacheSize > 0;
  });
  const firstFocus = await page.evaluate(() => window.vehicleRig.getState().seatAdjustmentFocus);
  assert.equal(await page.evaluate(() => window.vehicleRig.endSeatAdjustmentFocus({
    reason: "browser-direct-seat-complete",
  })), true);
  await page.waitForTimeout(850);
  assert.equal(await page.evaluate(() => window.vehicleRig.getState().seatAdjustmentFocus.active), true,
    "seat focus must remain during the 1.2s inspection hold");
  await page.waitForFunction(() => window.vehicleRig.getState().seatAdjustmentFocus.active === false, null, {
    timeout: 1500,
  });
  const firstRestore = await page.evaluate(() => window.vehicleRig.getState().seatAdjustmentFocus);
  assert.equal(firstRestore.materialCacheSize, firstFocus.materialCacheSize);
  assert.equal(firstRestore.foggedMeshCount, 0);

  await page.waitForTimeout(650);
  await page.evaluate(() => {
    window.vehicleRig.beginSeatAdjustmentFocus({ reason: "browser-visual-seat-focus" });
    window.__seatFocusTestKeepalive = window.setInterval(() => {
      window.vehicleRig.beginSeatAdjustmentFocus({ reason: "browser-visual-seat-focus" });
    }, 1000);
  });
  await page.waitForTimeout(650);
  const vehicleStageBox = await page.locator("#vehicle3dStage").boundingBox();
  assert.ok(vehicleStageBox);
  await page.screenshot({
    path: "/tmp/nio-es7-main-seat-focus.png",
    clip: vehicleStageBox,
  });
  await page.evaluate(() => {
    window.clearInterval(window.__seatFocusTestKeepalive);
    delete window.__seatFocusTestKeepalive;
    window.vehicleRig.endSeatAdjustmentFocus({
      delayMs: 0,
      reason: "browser-visual-seat-focus-complete",
    });
  });

  const automaticFocus = await page.evaluate(() => ({
    accepted: window.vehicleRig.playScenarioAnimation("seatControl", { component: "driverSeatBackrest" }),
    scenario: window.vehicleRig.getState().scenario,
    focus: window.vehicleRig.getState().seatAdjustmentFocus,
  }));
  assert.equal(automaticFocus.accepted, true);
  assert.equal(automaticFocus.scenario, "seatControl");
  assert.equal(automaticFocus.focus.active, true);
  assert.equal(automaticFocus.focus.exitScheduled, true);
  assert.equal(automaticFocus.focus.materialCacheSize, firstFocus.materialCacheSize,
    "re-entering seat focus must reuse the fog material cache");
  await page.evaluate(() => window.vehicleRig.playScenarioAnimation("idle", { component: "body" }));
  assert.equal(await page.evaluate(() => window.vehicleRig.getState().seatAdjustmentFocus.active), false,
    "a non-seat presentation must take over the camera and restore materials");

  const screenshotPath = "/tmp/nio-es7-main-browser-runtime.png";
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    screenshotPath,
    checks: {
      mainPageLoaded: true,
      stableBindingsPresent: true,
      all25ClipsReady: true,
      manualPresentationControlsAbsent: true,
      engineeringProxyAbsent: true,
      confirmedSnapshotDrivesEs7Clip: true,
      automaticCameraFocusRetained: true,
      darkDisplayStagePresent: true,
      seatAdjustmentFocusAndFog: true,
      seatFocusDelayedRestore: true,
      seatFocusMaterialCacheStable: true,
      nonSeatCameraTakeover: true,
    },
  }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
