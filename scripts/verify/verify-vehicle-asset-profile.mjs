import assert from "node:assert/strict";
import fs from "node:fs";
import { VEHICLE_ASSET_PROFILE, canFallbackToInlineManifest } from "../../src/vehicle/vehicle-asset-profile.js";

const vehicleThree = fs.readFileSync(new URL("../../src/app/vehicle-three.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../src/app/app.js", import.meta.url), "utf8");
const index = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const productionManifestVerifier = fs.readFileSync(new URL("./verify-hmi-production-manifest-failclosed.mjs", import.meta.url), "utf8");
const mainRuntime = [vehicleThree, app, index].join("\n");

assert.equal(VEHICLE_ASSET_PROFILE.id, "nio-es7-stage-c-components@1.0.0");
assert.equal(VEHICLE_ASSET_PROFILE.profileMode, "local-dev");
assert.equal(VEHICLE_ASSET_PROFILE.productionApproved, false);
assert.equal(VEHICLE_ASSET_PROFILE.assetIdentity.nioOriginalGeometry, true);
assert.equal(VEHICLE_ASSET_PROFILE.assetIdentity.baseAsset, "assets/models/nio-es7/nio-es7-animated.glb");
assert.deepEqual(VEHICLE_ASSET_PROFILE.source.modelSources, ["./assets/models/nio-es7/nio-es7-animated.glb"]);
assert.equal(VEHICLE_ASSET_PROFILE.source.componentManifestPath, "./assets/models/nio-es7/nio-es7-component-manifest.json");
assert.equal(VEHICLE_ASSET_PROFILE.fidelity.geometry, "nio-es7-2023-cc-by-derivative");
assert.equal(VEHICLE_ASSET_PROFILE.fidelity.componentBinding, "stable-node-plus-25-animation-clips");
assert.equal(VEHICLE_ASSET_PROFILE.fidelity.realVehicleExecutionFeedback, false);
assert.equal(VEHICLE_ASSET_PROFILE.engineeringOverlay, undefined);
assert.equal(VEHICLE_ASSET_PROFILE.license.boundary, "cc-by-4.0-attribution-required");
assert.equal(VEHICLE_ASSET_PROFILE.license.publicReleaseApproved, false);
assert.equal(VEHICLE_ASSET_PROFILE.license.commercialUseApproved, false);
assert.equal(VEHICLE_ASSET_PROFILE.manifestPolicy.productionFailClosed, true);
assert.equal(VEHICLE_ASSET_PROFILE.defaultComponentManifest.frontLeftWindow.required, true);
assert.deepEqual(VEHICLE_ASSET_PROFILE.defaultComponentManifest.frontLeftWindow.aliases, ["front_left_window_slider"]);
assert.equal(canFallbackToInlineManifest(VEHICLE_ASSET_PROFILE), false);
assert.equal(canFallbackToInlineManifest({
  ...VEHICLE_ASSET_PROFILE,
  profileMode: "production",
  manifestPolicy: { ...VEHICLE_ASSET_PROFILE.manifestPolicy, fallbackAllowed: true },
}), false);

assert.match(vehicleThree, /import \{ VEHICLE_ASSET_PROFILE, canFallbackToInlineManifest \}/);
assert.match(vehicleThree, /const vehicleModelSources = \[\.\.\.VEHICLE_ASSET_PROFILE\.source\.modelSources\]/);
assert.match(vehicleThree, /VEHICLE_ASSET_PROFILE\.source\.componentManifestPath/);
assert.match(vehicleThree, /fallbackAllowed: false/);
assert.match(vehicleThree, /failClosed: true/);
assert.match(vehicleThree, /assetProfile: VEHICLE_ASSET_PROFILE/);
assert.match(vehicleThree, /new ES7AnimationRuntime/);
assert.match(vehicleThree, /ES7 required component bindings missing/);
assert.match(vehicleThree, /mechanicalAnimationSource: "nio-es7-glb-clips"/);
assert.match(vehicleThree, /validateComponentManifest\(componentManifest\)/);
assert.match(vehicleThree, /const DEFAULT_COMPONENT_MANIFEST = VEHICLE_ASSET_PROFILE\.defaultComponentManifest/);
assert.doesNotMatch(mainRuntime, /engineeringProxy|engineeringOverlay|proxyVisualization|proxyLayout|component_proxy|proxy_window|proxy_tailgate|proxy_driver_seat/);
assert.doesNotMatch(mainRuntime, /windowFeedback|tailgateFeedback|seatFeedback|applyManifestAction|validateComponentAction/);
assert.doesNotMatch(mainRuntime, /windowProxy|tailgateProxy|seatProxy/);
assert.doesNotMatch(index, /class="vehicle-controls"/);
assert.doesNotMatch(index, /id="explodeButton"/);
assert.doesNotMatch(index, /class="component-exploder"/);

assert.match(productionManifestVerifier, /profileMode: "production"/);
assert.match(productionManifestVerifier, /nio-es7-stage-c-components@1\.0\.0/);
assert.match(productionManifestVerifier, /nio-es7\/nio-es7-component-manifest\.json/);
assert.match(productionManifestVerifier, /missing-manifest/);
assert.match(productionManifestVerifier, /invalid-manifest/);
assert.match(productionManifestVerifier, /window\.__vehicleComponentManifest\?\.failClosed === true/);

console.log(JSON.stringify({
  assetProfileVersioned: true,
  es7OnlyMechanicalRuntime: true,
  legacyMechanicalProxyRemoved: true,
  runtimeManifestFallbackDisabled: true,
  productionManifestFailClosedContract: true,
  manualPresentationControlsAbsent: true,
}, null, 2));
