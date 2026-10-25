import { resolveConversationRoute } from "../runtime/agent-schemas.js";

const vehicleKnowledge = {
  id: "nio-es6-official-seed",
  vehicle: {
    brand: "NIO",
    model: "ES6",
    marketName: "NIO ES6",
  },
  source: {
    name: "NIO ES6 official model page",
    url: "https://www.nio.com/es6",
    type: "official-model-page",
  },
  usageBoundary: {
    label: "official-model-page-seed",
    summary:
      "This runtime seed mirrors data/vehicle-knowledge/nio-es6-official.json. It is public official model-page material, not a complete official user manual, owner manual, service manual, maintenance guide, diagnostic guide, or real vehicle service.",
    safetyNoticeZh:
      "当前未接入完整官方用户手册/真实车辆服务，仅基于公开官方车型资料提供一般说明。涉及具体操作、安全限制、故障处理、维修保养、法规或真实车辆执行时，请以车机提示、完整官方用户手册和官方服务为准。",
  },
  updatedAt: "2026-07-02",
  sections: [
    {
      id: "positioning",
      title: "车型定位",
      summary:
        "NIO ES6 是蔚来的智能电动 SUV 车型，官方车型页重点展示其智能座舱、舒适空间、性能与安全、电池与续航等产品特性。",
    },
    {
      id: "nomi-cockpit",
      title: "NOMI Mate 3.0 与智能座舱",
      summary:
        "官方车型资料提到 NOMI Mate 3.0 和智能座舱体验，可作为语音交互、车内信息显示和座舱体验的一般介绍来源。",
    },
    {
      id: "displays",
      title: "座舱显示",
      summary:
        "官方车型资料包含 15.6 英寸 AMOLED 中控屏、19.4 英寸 W-HUD 和 6.6 英寸后排控制屏等显示配置，可用于回答屏幕和显示系统的高层介绍。",
    },
    {
      id: "seats-storage",
      title: "座椅与后备箱",
      summary:
        "官方车型资料介绍了座椅舒适性、乘坐空间与后备箱/储物相关能力。具体调节步骤、载物限制和真实开启状态仍需完整用户手册或车辆服务确认。",
    },
    {
      id: "climate-comfort",
      title: "空调、香氛与空气质量",
      summary:
        "官方车型资料包含 3 区空调、香氛和空气质量相关体验，可用于一般性说明座舱舒适与空气管理能力。具体设置路径、滤芯维护或空气质量实时值不在本种子源范围内。",
    },
    {
      id: "child-safety",
      title: "儿童相关提醒",
      summary:
        "官方车型资料提到儿童监测、儿童锁、防夹提醒和儿童座椅温度提醒等儿童相关安全与舒适功能。涉及儿童安全、真实提醒触发条件或操作限制时必须提示当前不是完整用户手册。",
    },
    {
      id: "performance-safety",
      title: "Performance and Safety",
      summary:
        "官方车型资料包含性能与安全相关卖点，可用于高层介绍。驾驶辅助、安全边界、制动、碰撞、维修或故障处理必须以完整官方资料和真实车辆状态为准。",
    },
    {
      id: "battery-range",
      title: "CLTC 续航与电池边界",
      summary:
        "官方车型资料涉及 CLTC 续航以及 75 kWh、100 kWh、150 kWh 电池包边界。续航为工况信息，真实续航会受温度、路况、车速、载重、驾驶方式和电池状态影响。",
    },
  ],
  qaSeeds: [
    {
      questionPatterns: ["ES6 是什么车", "介绍一下 ES6", "这辆车有什么特点"],
      answer:
        "NIO ES6 是蔚来的智能电动 SUV。当前本地资料来自 NIO ES6 官方车型页，能介绍智能座舱、屏幕、座椅空间、后备箱、舒适配置、儿童相关提醒、性能安全和电池续航边界，但不是完整官方用户手册。",
    },
    {
      questionPatterns: ["中控屏多大", "屏幕配置", "HUD", "后排控制屏"],
      answer:
        "官方车型资料提到 ES6 配备 15.6 英寸 AMOLED 中控屏、19.4 英寸 W-HUD 和 6.6 英寸后排控制屏。具体显示设置路径和驾驶时显示限制需要以完整官方用户手册和车机实际版本为准。",
    },
    {
      questionPatterns: ["NOMI", "NOMI Mate", "智能座舱"],
      answer:
        "官方车型资料提到 NOMI Mate 3.0 与智能座舱体验，可用于介绍车内语音交互和座舱信息体验。当前未接入真实车辆服务，不能代表实际账号、车机版本或车辆状态。",
    },
    {
      questionPatterns: ["空调", "香氛", "空气质量", "三区空调"],
      answer:
        "官方车型资料包含 3 区空调、香氛和空气质量相关体验，可作为座舱舒适功能的一般说明。具体设置步骤、维护项目和实时空气质量数据不在当前种子源范围内。",
    },
    {
      questionPatterns: ["儿童", "儿童锁", "防夹", "儿童座椅", "儿童监测"],
      answer:
        "官方车型资料提到儿童监测、儿童锁、防夹提醒和儿童座椅温度提醒等功能。涉及儿童安全、真实提醒触发条件、开关步骤或紧急处理时，当前未接入完整官方用户手册/真实车辆服务，仅能提供一般说明。",
    },
    {
      questionPatterns: ["续航", "CLTC", "75 kWh", "100 kWh", "150 kWh", "电池"],
      answer:
        "官方车型资料涉及 CLTC 续航与 75 kWh、100 kWh、150 kWh 电池包边界。CLTC 是工况续航信息，真实续航会受温度、路况、车速、载重、驾驶方式和电池状态影响。",
    },
    {
      questionPatterns: ["后备箱", "尾门", "座椅", "储物"],
      answer:
        "官方车型资料可支持对座椅舒适性、乘坐空间和后备箱/储物能力的一般介绍。具体开启步骤、载物限制、防夹条件或真实执行结果需要完整官方用户手册和真实车辆服务确认。",
    },
  ],
};

export const VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY = Object.freeze({
  id: "nio-vehicle-knowledge-seed-retrieval",
  version: "1.0.0",
  profileMode: "local-dev",
  defaultLimit: 3,
  exactPatternWeight: 4,
  tokenMatchWeight: 1,
  explicitModelPolicy: Object.freeze({
    supportedModels: Object.freeze(["ES6"]),
    unsupportedModelDisposition: "not-applicable",
  }),
  topicAnchors: Object.freeze([
    "ES6", "蔚来", "NIO", "NOMI", "座舱", "中控屏", "HUD", "后排控制屏",
    "后备箱", "尾门", "座椅", "空调", "香氛", "空气质量", "儿童锁", "防夹",
    "儿童监测", "续航", "CLTC", "电池",
  ]),
});

const SAFETY_BOUNDARY = vehicleKnowledge.usageBoundary.safetyNoticeZh;

export function getVehicleKnowledgeSeed() {
  return vehicleKnowledge;
}

export function isVehicleKnowledgeTopic(parsedCommand = {}, rawText = "") {
  const text = String(rawText || parsedCommand.rawText || "").trim();
  const route = resolveConversationRoute(text, parsedCommand);
  return route.isVehicleKnowledge
    || VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.topicAnchors.some((anchor) => text.includes(anchor));
}

export function getVehicleKnowledgeApplicability(rawText = "") {
  const text = String(rawText || "").trim();
  const modelMatches = [...text.matchAll(/\b(?:NIO\s*)?(ES|ET|EC|EL|EP)\s*-?\s*(\d{1,2})\b|蔚来\s*(ES|ET|EC|EL|EP)\s*-?\s*(\d{1,2})|Model\s*Y|特斯拉|Tesla/gi)]
    .map((match) => match[0].replace(/\s+/g, "").toUpperCase());
  const explicitModels = [...new Set(modelMatches)];
  if (!explicitModels.length) {
    return {
      status: "assumed-local-dev",
      seedId: vehicleKnowledge.id,
      model: vehicleKnowledge.vehicle.model,
      reason: "no-explicit-model; local-dev seed may answer only as ES6 official model-page material",
    };
  }
  const supported = explicitModels.some((model) => /ES6/.test(model));
  if (supported) {
    return {
      status: "applicable",
      seedId: vehicleKnowledge.id,
      model: vehicleKnowledge.vehicle.model,
      explicitModels,
      reason: "explicit model matches ES6 seed",
    };
  }
  return {
    status: "not-applicable",
    seedId: vehicleKnowledge.id,
    model: vehicleKnowledge.vehicle.model,
    explicitModels,
    reason: "explicit model does not match ES6 seed",
  };
}

export function findVehicleKnowledgeSeeds(rawText = "", limit = VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.defaultLimit) {
  const applicability = getVehicleKnowledgeApplicability(rawText);
  if (applicability.status === "not-applicable") return [];
  const text = String(rawText || "").trim().toLowerCase();
  if (!text) return [];

  return vehicleKnowledge.qaSeeds
    .map((seed) => {
      const score = seed.questionPatterns.reduce((total, pattern) => {
        const normalizedPattern = String(pattern).toLowerCase();
        return text.includes(normalizedPattern)
          ? total + VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.exactPatternWeight
          : total + keywordScore(text, normalizedPattern);
      }, 0);
      return { seed, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.seed);
}

export function buildVehicleKnowledgeContext(rawText = "") {
  const applicability = getVehicleKnowledgeApplicability(rawText);
  if (applicability.status === "not-applicable") {
    return [
      `车辆知识种子源：${vehicleKnowledge.vehicle.marketName} 官方车型资料`,
      `来源：${vehicleKnowledge.source.name} (${vehicleKnowledge.source.url})`,
      `适用性：not-applicable（用户显式车型：${applicability.explicitModels.join("、")}；当前 seed 仅适用于 ${vehicleKnowledge.vehicle.model}）`,
      `边界：${vehicleKnowledge.usageBoundary.summary}`,
    ].join("\n");
  }
  const matchedSeeds = findVehicleKnowledgeSeeds(rawText);
  const sectionSummary = vehicleKnowledge.sections.map((section) => `${section.title}: ${section.summary}`).join("\n");
  const qaSummary = matchedSeeds.map((seed) => `问法匹配：${seed.questionPatterns.join(" / ")}\n可用回答依据：${seed.answer}`).join("\n");

  return [
    `车辆知识种子源：${vehicleKnowledge.vehicle.marketName} 官方车型资料`,
    `来源：${vehicleKnowledge.source.name} (${vehicleKnowledge.source.url})`,
    `检索策略：${VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.id}@${VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.version}，适用性：${applicability.status}`,
    `边界：${vehicleKnowledge.usageBoundary.summary}`,
    `安全提示：${SAFETY_BOUNDARY}`,
    "可用章节摘要：",
    sectionSummary,
    qaSummary ? "匹配问答种子：\n" + qaSummary : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildVehicleKnowledgeFallback(rawText = "", reason = "") {
  const applicability = getVehicleKnowledgeApplicability(rawText);
  if (applicability.status === "not-applicable") {
    const models = applicability.explicitModels.join("、") || "该车型";
    const reasonText = reason ? `降级原因：${reason}` : "";
    return `当前本地车辆知识种子源仅适用于 ${vehicleKnowledge.vehicle.marketName} 官方车型资料，不能把它套用到 ${models}。我不能编造该车型配置、功能或操作步骤；请接入对应车型资料、用户手册或真实车辆服务后再回答。${reasonText}`;
  }
  const matched = findVehicleKnowledgeSeeds(rawText, 1)[0];
  const answer = matched
    ? matched.answer
    : "我目前接入的是 NIO ES6 官方车型资料种子源，可以做车型定位、智能座舱、屏幕、座椅与后备箱、空调香氛空气质量、儿童相关提醒、性能安全和 CLTC/电池边界的一般介绍。";
  const reasonText = reason ? `降级原因：${reason}` : "";
  return `${answer}${answer.endsWith("。") ? "" : "。"}${SAFETY_BOUNDARY}${reasonText}`;
}

export function vehicleKnowledgeRecommendations() {
  return [
    "基于 NIO ES6 官方车型资料种子源回答",
    "不是完整官方用户手册，具体操作/安全/维修/法规以完整资料和真实车辆服务为准",
  ];
}

function keywordScore(text, pattern) {
  return pattern
    .split(/\s+|\/|,|，/)
    .filter(Boolean)
    .reduce((total, token) => total + (text.includes(token) ? VEHICLE_KNOWLEDGE_RETRIEVAL_POLICY.tokenMatchWeight : 0), 0);
}
