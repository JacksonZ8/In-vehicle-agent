import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildConversationBoundaryResponse,
  buildVehicleSluBoundaryResponse,
  resolveBoundaryRoute,
} from "../../src/runtime/boundary-response-builder.js";
import { CloudLLMAdapter } from "../../src/runtime/cloud-llm-adapter.js";

const forbiddenFoodInjection = /麻辣烫|火锅|咖啡|奶茶|汤底|辣度|荤素|重油|食材新鲜/;

const serverStyleFood = buildConversationBoundaryResponse("附近有什么适合吃晚饭的地方？", "food_recommendation", {
  externalDataType: "poi",
  requiresExternalData: true,
  reason: "test",
});
assert.match(serverStyleFood, /未接入真实地图、POI、定位、评分或营业状态/);
assert.doesNotMatch(serverStyleFood, forbiddenFoodInjection);

const noCategoryFood = buildConversationBoundaryResponse("晚饭吃什么比较合适？", "food_recommendation", {
  reason: "test",
});
assert.match(noCategoryFood, /不能编造具体店名或菜系/);
assert.doesNotMatch(noCategoryFood, forbiddenFoodInjection);

const goalOnlyWeatherRoute = resolveBoundaryRoute("今天杭州天气怎么样？", {
  topic: "general_qa",
  domain: "weather",
  interactionType: "question",
  externalDataType: "weather",
  requiresExternalData: true,
  isWeather: true,
});
const goalOnlyWeather = buildConversationBoundaryResponse("今天杭州天气怎么样？", goalOnlyWeatherRoute, {
  reason: "test",
});
assert.match(goalOnlyWeather, /未接入实时天气|不能编造今天的天气/);

const goalOnlyVehicleKnowledge = buildConversationBoundaryResponse("ES6 的儿童监测是什么？", {
  topic: "general_qa",
  domain: "vehicle_knowledge",
  interactionType: "question",
  isVehicleKnowledge: true,
}, {
  reason: "test",
  buildVehicleKnowledgeFallback: () => "vehicle knowledge fallback via route",
});
assert.equal(goalOnlyVehicleKnowledge, "vehicle knowledge fallback via route");

const adapter = new CloudLLMAdapter();
const cloudFood = await adapter.converse("附近有什么适合吃晚饭的地方？", {
  intent: "conversation.general",
  slots: {
    topic: "food_recommendation",
    requiresExternalData: true,
    externalDataType: "poi",
  },
});
assert.equal(cloudFood.deferred, true);
assert.match(cloudFood.summary, /未接入真实地图、POI、定位、评分或营业状态/);
assert.doesNotMatch(cloudFood.summary, forbiddenFoodInjection);

const cloudGenericFood = await adapter.converse("晚饭吃什么比较合适？", {
  intent: "conversation.general",
  slots: { topic: "food_recommendation" },
});
assert.doesNotMatch(cloudGenericFood.summary, forbiddenFoodInjection);

const localServer = fs.readFileSync(new URL("../../src/server/local-agent-server.mjs", import.meta.url), "utf8");
const cloudAdapter = fs.readFileSync(new URL("../../src/runtime/cloud-llm-adapter.js", import.meta.url), "utf8");
const boundaryBuilder = fs.readFileSync(new URL("../../src/runtime/boundary-response-builder.js", import.meta.url), "utf8");
const vehicleBoundaryStart = boundaryBuilder.indexOf("export function buildVehicleSluBoundaryResponse");
const conversationBoundaryStart = boundaryBuilder.indexOf("export function buildConversationBoundaryResponse");
assert.ok(vehicleBoundaryStart >= 0, "structured Vehicle-SLU boundary function must exist");
assert.ok(conversationBoundaryStart > vehicleBoundaryStart, "structured function range must end before legacy conversation boundary");
const vehicleBoundarySource = boundaryBuilder.slice(vehicleBoundaryStart, conversationBoundaryStart);
assert.doesNotMatch(vehicleBoundarySource, /rawText|resolveConversationRoute|inferBoundaryExternalDataType/,
  "structured Vehicle-SLU boundary must not inspect text or call legacy route inference");
assert.match(localServer, /buildConversationBoundaryResponse/);
assert.match(cloudAdapter, /buildConversationBoundaryResponse/);
assert.match(boundaryBuilder, /resolveBoundaryRoute/);
assert.match(boundaryBuilder, /resolveConversationRoute/);
assert.doesNotMatch(localServer, /buildConversationBoundaryReply\(rawText,\s*route\.topic/);
assert.doesNotMatch(cloudAdapter, /buildConversationBoundaryResponse\(text,\s*route\.topic/);
assert.doesNotMatch(cloudAdapter, /想吃麻辣烫|汤底清爽|辣度可调|荤素搭配/);

assert.match(buildVehicleSluBoundaryResponse({
  reasonCode: "missing-required-slots",
  capability: "control",
  missingSlots: ["zone", "percent"],
}), /哪一扇车窗.*多少开度/);
assert.match(buildVehicleSluBoundaryResponse({
  reasonCode: "missing-required-slots",
  capability: "control",
  missingSlots: ["seat", "angle"],
}), /哪个座椅.*靠背角度/);
assert.match(buildVehicleSluBoundaryResponse({
  reasonCode: "missing-required-slots",
  capability: "control",
  missingSlots: ["temperature"],
}), /目标温度/);

const unsupportedNavigation = buildVehicleSluBoundaryResponse({
  reasonCode: "unsupported-capability",
  capability: "navigation",
  missingSlots: [],
  rawText: "请补充导航参数",
});
assert.match(unsupportedNavigation, /导航.*还不能完成/);
assert.doesNotMatch(unsupportedNavigation, /补充.*参数/);

assert.equal(buildVehicleSluBoundaryResponse({ executionDisabled: true }),
  "抱歉，我暂时无法可靠理解这条请求，因此不会执行车辆或座舱操作。你可以继续和我聊天，或稍后再试。");
assert.equal(buildVehicleSluBoundaryResponse({ reasonCode: "protected-capability" }),
  "关键安全提醒不能关闭，我没有执行这项操作。");
assert.equal(buildVehicleSluBoundaryResponse({ reasonCode: "semantic-frame-inconsistent" }),
  "我暂时无法可靠确认这项车内请求，因此没有执行任何操作。请换一种说法再试。");
assert.equal(buildVehicleSluBoundaryResponse({ reasonCode: "extra-write-frames-deferred" }),
  "这次我只会处理一个车辆操作，其余操作已保留但没有执行。");
assert.throws(() => buildVehicleSluBoundaryResponse({ reasonCode: "unknown" }), {
  name: "TypeError",
  message: "unsupported Vehicle-SLU boundary reason",
});

console.log(JSON.stringify({
  sharedBoundaryBuilder: true,
  routeFirstBoundaryBuilder: true,
  serverFoodBoundaryNoInjection: true,
  cloudFoodBoundaryNoInjection: true,
  structuredVehicleSluBoundary: true,
}, null, 2));
