#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolveConversationRoute } from "../../src/runtime/agent-schemas.js";
import { isVehicleKnowledgeTopic } from "../../src/external-data/vehicle-knowledge.js";

const weatherByGoal = resolveConversationRoute("今天杭州天气怎么样？", {
  intent: "conversation.general",
  slots: { topic: "general_qa" },
  conversationGoal: {
    interactionType: "question",
    domain: "weather",
    goal: "今天杭州天气怎么样？",
    source: "test",
  },
});
assert.equal(weatherByGoal.topic, "general_qa");
assert.equal(weatherByGoal.domain, "weather");
assert.equal(weatherByGoal.externalDataType, "weather");
assert.equal(weatherByGoal.isWeather, true);

const weatherByLegacyTopic = resolveConversationRoute("今天杭州天气怎么样？", {
  intent: "conversation.general",
  slots: { topic: "weather_query" },
});
assert.equal(weatherByLegacyTopic.domain, "weather");
assert.equal(weatherByLegacyTopic.externalDataType, "weather");
assert.equal(weatherByLegacyTopic.isWeather, true);

const vehicleKnowledgeByGoal = resolveConversationRoute("ES6 的儿童监测功能是什么？", {
  intent: "conversation.general",
  slots: { topic: "general_qa" },
  conversationGoal: {
    interactionType: "question",
    domain: "vehicle_knowledge",
    goal: "ES6 的儿童监测功能是什么？",
    source: "test",
  },
});
assert.equal(vehicleKnowledgeByGoal.topic, "general_qa");
assert.equal(vehicleKnowledgeByGoal.domain, "vehicle_knowledge");
assert.equal(vehicleKnowledgeByGoal.isVehicleKnowledge, true);
assert.equal(isVehicleKnowledgeTopic({
  intent: "conversation.general",
  slots: { topic: "general_qa" },
  conversationGoal: {
    interactionType: "question",
    domain: "vehicle_knowledge",
    goal: "ES6 的儿童监测功能是什么？",
    source: "test",
  },
}, "ES6 的儿童监测功能是什么？"), true);

const manualByGoal = resolveConversationRoute("尾门打不开查用户手册怎么处理？", {
  intent: "conversation.general",
  slots: { topic: "general_qa" },
  conversationGoal: {
    interactionType: "explain",
    domain: "manual_knowledge",
    goal: "尾门打不开查用户手册怎么处理？",
    source: "test",
  },
});
assert.equal(manualByGoal.isManualKnowledge, true);
assert.equal(manualByGoal.isVehicleKnowledge, false);

const poiByLegacyTopic = resolveConversationRoute("附近有什么餐厅？", {
  intent: "conversation.general",
  slots: { topic: "food_recommendation", requiresExternalData: true },
});
assert.equal(poiByLegacyTopic.isPoi, true);
assert.equal(poiByLegacyTopic.externalDataType, "poi");

console.log(JSON.stringify({
  ok: true,
  policy: "conversation-route-contract",
  cases: {
    weatherByGoal,
    weatherByLegacyTopic,
    vehicleKnowledgeByGoal,
    manualByGoal,
    poiByLegacyTopic,
  },
}, null, 2));
