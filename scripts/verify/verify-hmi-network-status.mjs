import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../src/app/app.js", import.meta.url), "utf8");

assert.doesNotMatch(index, /5G 在线/, "HMI must not claim fixed 5G connectivity without a real provider");
assert.match(index, /id="networkMetric">开发环境 · 网络未知<\/strong>/);
assert.match(index, /id="modelRouteMetric">待运行<\/strong>/);
assert.match(app, /function renderNetworkStatus\(\)/);
assert.match(app, /source: "dev-fixture"/);
assert.match(app, /function renderModelRouteStatus\(result = null, \{ effectiveVehicleControl = false \} = \{\}\)/);
assert.doesNotMatch(app, /els\.networkMetric\.textContent = result\.mode/);
assert.match(app, /els\.modelRouteMetric\.textContent = label/);

console.log(JSON.stringify({
  fixedNetworkClaimRemoved: true,
  networkStatusSeparated: true,
  modelRouteStatusSeparated: true,
}, null, 2));
