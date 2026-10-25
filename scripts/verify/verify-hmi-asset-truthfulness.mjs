import assert from "node:assert/strict";
import fs from "node:fs";

const files = {
  "index.html": fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8"),
  "app.js": fs.readFileSync(new URL("../../src/app/app.js", import.meta.url), "utf8"),
  "vehicle-three.js": fs.readFileSync(new URL("../../src/app/vehicle-three.js", import.meta.url), "utf8"),
};

const combined = Object.values(files).join("\n");

assert.doesNotMatch(files["app.js"], /座舱域 \/ 能量域 \/ 导航域动作集/, "Vehicle API role must not claim navigation/energy action ownership");
assert.match(files["app.js"], /NIO ES7 组件动画 GLB/);
assert.match(files["index.html"], /NIO ES7 model/);
assert.match(files["index.html"], /CC BY 4\.0/);
assert.match(files["index.html"], /ItsDiyor/);
assert.doesNotMatch(combined, /Ferrari 开发底车|法拉利/);
assert.doesNotMatch(combined, /官方工程车模|已接入真实车辆硬件|提供真实车辆执行反馈/);
assert.doesNotMatch(combined, /engineeringProxy|engineeringOverlay|component_proxy|windowFeedback|tailgateFeedback|seatFeedback/);

console.log(JSON.stringify({
  vehicleApiRoleBounded: true,
  es7DerivativeAssetBoundaryVisible: true,
  ccByAttributionVisible: true,
  misleadingAssetClaimsRemoved: true,
  legacyMechanicalProxyRemoved: true,
}, null, 2));
