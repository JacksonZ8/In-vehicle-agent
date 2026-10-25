import assert from "node:assert/strict";
import fs from "node:fs";
import { launchChromium } from "../lib/playwright-loader.mjs";

const baseUrl = process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173";
const profileSource = fs.readFileSync(new URL("../../src/vehicle/vehicle-asset-profile.js", import.meta.url), "utf8");
const productionProfileSource = profileSource
  .replace('profileMode: "local-dev"', 'profileMode: "production"')
  .replace("productionApproved: false", "productionApproved: true");

if (productionProfileSource === profileSource || !productionProfileSource.includes('profileMode: "production"')) {
  throw new Error("Failed to prepare production VehicleAssetProfile fixture.");
}

const cases = [
  {
    name: "missing-manifest",
    screenshotPath: "/tmp/nio-hmi-production-manifest-missing.png",
    routeManifest: (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "missing manifest fixture" }),
    expectedReasonPattern: /HTTP 404/,
  },
  {
    name: "invalid-manifest",
    screenshotPath: "/tmp/nio-hmi-production-manifest-invalid.png",
    routeManifest: (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        components: {
          frontLeftWindow: {
            required: true,
            aliases: [],
            action: { type: "translate", axis: "y", distance: -0.28 },
          },
        },
      }),
    }),
    expectedReasonPattern: /invalid NIO ES7 runtime manifest/,
  },
];

const browser = await launchChromium();
const results = [];

try {
  for (const item of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();

    await context.route("**/vehicle-asset-profile.js", (route) => route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: productionProfileSource,
    }));
    await context.route("**/assets/models/nio-es7/nio-es7-component-manifest.json", item.routeManifest);

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__vehicleComponentManifest?.failClosed === true, null, { timeout: 10_000 });

    const debug = await page.evaluate(() => ({
      loadState: window.__vehicleLoadState,
      bootError: window.__vehicleBootError || null,
      manifest: window.__vehicleComponentManifest,
      hasVehicleRig: Boolean(window.vehicleRig),
      rigState: window.vehicleRig?.getState?.() || null,
      modelStatus: document.querySelector("#modelStatus")?.textContent || "",
      modelStatusState: document.querySelector("#modelStatus")?.dataset?.state || "",
    }));

    assert.equal(debug.loadState, "failed", `${item.name}: vehicle load state must fail closed.`);
    assert.equal(debug.manifest?.assetProfileId, "nio-es7-stage-c-components@1.0.0", `${item.name}: manifest audit must retain profile id.`);
    assert.equal(debug.manifest?.fallbackAllowed, false, `${item.name}: production profile must not allow inline fallback.`);
    assert.equal(debug.manifest?.failClosed, true, `${item.name}: production manifest failure must be marked failClosed.`);
    assert.equal(debug.rigState?.modelLoaded, false, `${item.name}: GLB model must not load after fail-closed manifest.`);
    assert.equal(debug.rigState?.activeVehicleModelSource || "", "", `${item.name}: fail-closed manifest must not proceed to any GLB source.`);
    assert.equal(debug.modelStatusState, "failed", `${item.name}: HMI status must be failed.`);
    assert.match(debug.manifest?.reason || "", item.expectedReasonPattern, `${item.name}: manifest reason should explain the failed contract.`);
    assert.match(debug.modelStatus, /VehicleAssetProfile 禁止 manifest fallback|manifest fallback/, `${item.name}: HMI should surface manifest fallback prohibition.`);

    await page.screenshot({ path: item.screenshotPath, fullPage: true });
    results.push({
      name: item.name,
      screenshotPath: item.screenshotPath,
      loadState: debug.loadState,
      manifestReason: debug.manifest.reason,
      fallbackAllowed: debug.manifest.fallbackAllowed,
      failClosed: debug.manifest.failClosed,
      hasVehicleRig: debug.hasVehicleRig,
      modelLoaded: debug.rigState?.modelLoaded,
      activeVehicleModelSource: debug.rigState?.activeVehicleModelSource || "",
    });

    await context.close();
  }

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    checks: {
      productionProfileInjected: true,
      missingManifestFailsClosed: true,
      invalidManifestFailsClosed: true,
      inlineFallbackDisabled: true,
      glbModelNotLoaded: true,
    },
    results,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    baseUrl,
    error: error.message,
    results,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
