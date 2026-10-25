import { resolveConversationRoute } from "./agent-schemas.js";

const VEHICLE_SLU_CAPABILITY_LABELS = Object.freeze({
  control: "车辆控制",
  knowledge: "车辆知识查询",
  navigation: "导航",
  weather: "天气查询",
  media: "媒体播放",
  phone: "电话",
});

const VEHICLE_SLU_SLOT_LABELS = Object.freeze({
  zone: "哪一扇车窗",
  percent: "多少开度",
  open: "是否打开尾门",
  seat: "哪个座椅",
  angle: "目标靠背角度",
  temperature: "目标温度",
  origin: "出发地",
  destination: "目的地",
  query: "查询内容",
  contact: "联系人",
  location: "地点",
  timeRange: "时间范围",
});

export function buildVehicleSluBoundaryResponse(input = {}) {
  if (input.executionDisabled === true) {
    return "抱歉，我暂时无法可靠理解这条请求，因此不会执行车辆或座舱操作。你可以继续和我聊天，或稍后再试。";
  }
  if (input.reasonCode === "unsupported-capability") {
    return `${capabilityLabel(input.capability)}目前还不能完成，我没有执行任何操作。`;
  }
  if (input.reasonCode === "protected-capability") {
    return "关键安全提醒不能关闭，我没有执行这项操作。";
  }
  if (input.reasonCode === "missing-required-slots") {
    return clarificationFromSlotKeys(input.missingSlots);
  }
  if (input.reasonCode === "semantic-frame-inconsistent") {
    return "我暂时无法可靠确认这项车内请求，因此没有执行任何操作。请换一种说法再试。";
  }
  if (input.reasonCode === "extra-write-frames-deferred") {
    return "这次我只会处理一个车辆操作，其余操作已保留但没有执行。";
  }
  throw new TypeError("unsupported Vehicle-SLU boundary reason");
}

export function buildConversationBoundaryResponse(rawText, routeOrTopic, options = {}) {
  const reasonText = options.reason ? `降级原因：${options.reason}` : "";
  if (options.needsClarification === true && options.clarification) {
    return `${String(options.clarification).trim()}我先不执行车辆动作。`;
  }

  const route = resolveBoundaryRoute(rawText, routeOrTopic, options);
  const topic = route.topic || "";
  const externalDataType = options.externalDataType || route.externalDataType || inferBoundaryExternalDataType(rawText, topic);
  const requiresExternalData = options.requiresExternalData
    || route.requiresExternalData === true
    || externalDataType === "weather"
    || externalDataType === "poi"
    || externalDataType === "web-search";

  if (route.isWeather || topic === "weather_query" || externalDataType === "weather") {
    if (options.weatherData && typeof options.formatWeatherSummary === "function") {
      return options.formatWeatherSummary(options.weatherData, options.reason);
    }
    return `当前未接入实时天气、定位或目的地天气数据，所以我不能编造今天的天气、气温或预警。接入天气 adapter 后，我可以按当前位置或目的地播报实时天气；现在也可以先帮你整理出行前的通用检查项。${reasonText}`;
  }

  if (route.isWebSearch || topic === "web_search" || externalDataType === "web-search") {
    return `这个问题需要联网搜索或网页来源核验；当前云端搜索 adapter 还没有接入，所以我不能编造最新信息、网页来源、价格、政策或新闻结论。你可以把资料贴给我，我可以基于你提供的内容总结；也可以先问非实时的通用原理。${reasonText}`;
  }

  if (route.isPoi || topic === "food_recommendation") {
    if (requiresExternalData || externalDataType === "poi") {
      return `当前未接入真实地图、POI、定位、评分或营业状态，所以我不能编造附近店名、距离和排队情况。接入地图或告诉我商圈/偏好后，我再给真实店铺建议。${reasonText}`;
    }
    return `饮食推荐需要真实地图、POI 和定位数据才能给出可信建议；当前这些能力尚未接入，我不能编造具体店名或菜系。你可以告诉我商圈和偏好，接入地图后我再帮你筛选。${reasonText}`;
  }

  if ((route.isVehicleKnowledge || topic === "vehicle_knowledge") && typeof options.buildVehicleKnowledgeFallback === "function") {
    return options.buildVehicleKnowledgeFallback(rawText, options.reason);
  }

  if (topic === "smalltalk") {
    return `我在，先陪你聊两句。当前本地大模型不可用，我会用更简短的降级回复，不会假装已经接入完整模型；你可以继续问车内操作、出行准备或日常问题。${reasonText}`;
  }

  if (typeof options.buildGeneralQaFallback === "function") {
    return options.buildGeneralQaFallback(rawText, options.reason);
  }
  return `这个问题当前缺少可靠数据源或模型能力，我不能编造结论。你可以换成通用原理或非实时建议来问，我可以先给思路。${reasonText}`;
}

export function resolveBoundaryRoute(rawText = "", routeOrTopic = "", options = {}) {
  if (routeOrTopic && typeof routeOrTopic === "object" && !Array.isArray(routeOrTopic)) {
    return {
      topic: routeOrTopic.topic || "",
      domain: routeOrTopic.domain || "",
      interactionType: routeOrTopic.interactionType || "",
      goal: routeOrTopic.goal || String(rawText || "").slice(0, 200),
      rawValue: routeOrTopic.rawValue || null,
      externalDataType: routeOrTopic.externalDataType || "",
      requiresExternalData: routeOrTopic.requiresExternalData === true,
      isWeather: routeOrTopic.isWeather === true,
      isVehicleKnowledge: routeOrTopic.isVehicleKnowledge === true,
      isManualKnowledge: routeOrTopic.isManualKnowledge === true,
      isPoi: routeOrTopic.isPoi === true,
      isWebSearch: routeOrTopic.isWebSearch === true,
      source: routeOrTopic.source || "boundary-route",
    };
  }
  const topic = typeof routeOrTopic === "string" ? routeOrTopic : "";
  return resolveConversationRoute(rawText, {
    intent: "conversation.general",
    requiresExternalData: options.requiresExternalData === true,
    externalDataType: options.externalDataType || "",
    slots: {
      topic,
      requiresExternalData: options.requiresExternalData === true,
      externalDataType: options.externalDataType || "",
      requiresPoi: options.externalDataType === "poi",
    },
    conversationGoal: options.conversationGoal,
  }, {
    fallbackTopic: topic,
  });
}

export function inferBoundaryExternalDataType(rawText = "", topic = "") {
  if (topic === "weather_query") return "weather";
  if (topic === "web_search") return "web-search";
  if (topic === "food_recommendation" && /附近|周边|离我|推荐|店|餐厅/.test(String(rawText || ""))) return "poi";
  return "";
}

function capabilityLabel(capability) {
  return VEHICLE_SLU_CAPABILITY_LABELS[capability] || "这项座舱能力";
}

function clarificationFromSlotKeys(missingSlots) {
  const keys = [...new Set(Array.isArray(missingSlots) ? missingSlots : [])];
  if (keys.includes("zone") && keys.includes("percent")) {
    return "请告诉我是哪一扇车窗，以及需要调到多少开度。";
  }
  if (keys.includes("seat") && keys.includes("angle")) {
    return "请告诉我要调节哪个座椅，以及目标靠背角度。";
  }
  if (keys.length === 0) return "请告诉我这项操作还缺少哪些信息。";
  return `请告诉我${keys.map((key) => VEHICLE_SLU_SLOT_LABELS[key] || String(key)).join("、")}。`;
}
