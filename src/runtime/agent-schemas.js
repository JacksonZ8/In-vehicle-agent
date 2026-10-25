import {
  VEHICLE_EXECUTION_STATES,
  VEHICLE_EXECUTION_TRANSITIONS,
} from "../vehicle/execution-state-contract.js";

export const VEHICLE_CONTROL_INTENTS = Object.freeze([
  "body.window.setPosition",
  "body.tailgate.open",
  "seat.driver.setBackrestAngle",
  "seat.comfort.setLevel",
  "cabin.comfort.applySettings",
  "vehicle.component.setState",
  "cabin.climate.setPreset",
]);

const VEHICLE_CONTROL_INTENT_SET = new Set(VEHICLE_CONTROL_INTENTS);

export function isVehicleControlIntent(intent) {
  return VEHICLE_CONTROL_INTENT_SET.has(intent);
}

export const VEHICLE_INTENTS = Object.freeze([
  ...VEHICLE_CONTROL_INTENTS,
  "navigation.planRoute",
  "energy.findSwapStation",
  "safety.reject",
]);

export const CONVERSATION_INTENTS = Object.freeze([
  "conversation.general",
]);

// HC-P1-09: extensible interaction type + domain + goal contract.
// CLOSED sets are for validation only; unknown values are preserved in rawValue, never swallowed into general_qa.
export const INTERACTION_TYPES = Object.freeze([
  "command",      // 执行车辆控制动作
  "question",     // 询问知识或状态
  "compare",      // 对比多个选项
  "plan",         // 需要多步骤规划
  "explain",      // 解释原因或原理
  "followup",     // 对上一轮回答的追问
  "general_qa",   // 通用问答（兜底）
]);

export const CONVERSATION_DOMAINS = Object.freeze([
  "vehicle_control",
  "vehicle_knowledge",
  "manual_knowledge",
  "weather",
  "navigation",
  "energy",
  "safety",
  "general",
]);

export const SPEECH_ACTS = Object.freeze([
  "command",
  "question",
  "report",
  "complaint",
  "hypothetical",
]);

export const SUPPORTED_INTENTS = Object.freeze([
  ...VEHICLE_INTENTS,
  ...CONVERSATION_INTENTS,
]);

export const VISUAL_SCENARIOS = Object.freeze([
  "windowControl",
  "trunkControl",
  "seatControl",
  "componentControl",
  "energy",
  "planning",
  "cabin",
  "blocked",
]);

export const AGENT_EVENT_STATUS = Object.freeze([
  "idle",
  "thinking",
  "working",
  "done",
  "blocked",
  "error",
]);

// HC-P2-03: SafetyBaselineBundle — single source for all repeated safety boundary values.
// Previously these were duplicated across safety-gateway.js, agent-schemas.js, semantic-parser.js, vehicle-three.js.
// All safety enforcers MUST read from this registry; any divergence is a bug.
export const SAFETY_BASELINE = Object.freeze({
  version: "nio-safety-baseline@1.0.0",
  seat: {
    minAngle: 90,                // minimum backrest angle in degrees
    maxAngleStationary: 118,     // max when vehicle is stationary (speed === 0)
    maxAngleDriving: 112,        // max when vehicle is in motion (speed > 0)
    defaultAngle: 106,           // fallback when angle is unspecified
  },
  climate: {
    minTemperature: 15,          // ES8 manual range, in °C
    maxTemperature: 31,
    minFanLevel: 0,
    maxFanLevel: 8,
  },
  window: {
    rainCloseMaxPercent: 30,     // max window open % when rain is detected
  },
  confidence: {
    ruleParserDefault: 0.7,      // default confidence for rule-based parser output
    ruleParserMax: 0.96,         // max confidence for rule-based parser (never 1.0)
    unknown: null,               // HC-P2-03: unknown confidence is null, not a fake number
  },
});

export const SEMANTIC_CONFIDENCE_POLICY = Object.freeze({
  version: "nio-semantic-confidence@1.1.0",
  preferredOutput: "matchStrength",
  compatibilityField: "confidence",
  matchStrengthPolicy: Object.freeze({
    id: "nio-semantic-match-strength",
    version: "1.0.0",
    levels: Object.freeze(["none", "possible", "weak", "medium", "strong"]),
    calibration: "local-dev-rule-derived-not-statistical",
  }),
  values: Object.freeze({
    ruleBase: 0.72,
    bareDegreeWithClimateContext: 0.82,
    bareDegreeClarification: 0.62,
    safetyReject: 0.96,
    windowCommand: 0.92,
    vehicleKnowledgeQuestion: 0.86,
    tailgateCommand: 0.9,
    seatCommand: 0.89,
    weatherClimateAdviceQuestion: 0.88,
    climateCommand: 0.84,
    energyCommand: 0.86,
    openConversation: 0.88,
    navigationCommand: 0.82,
    fallbackConversation: 0.45,
  }),
  calibration: Object.freeze({
    status: "local-dev-unvalidated",
    method: "legacy numeric compatibility only; prefer matchStrength/provenance for interpretation",
  }),
});

export const EXTERNAL_DATA_TYPES = Object.freeze([
  "weather",
  "poi",
  "map",
  "charging",
  "user-memory",
  "web-search",
]);

export function createRequestId(prefix = "req") {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${randomPart}`;
}

// HC-P1-09: structured conversation goal — extensible beyond the old "conversation.general" catch-all.
// Unknown interactionType/domain preserved in rawValue; never silently collapsed into general_qa.
export function createConversationGoal(rawText, parsed = {}) {
  const sourceGoal = parsed.conversationGoal && typeof parsed.conversationGoal === "object" && !Array.isArray(parsed.conversationGoal)
    ? parsed.conversationGoal
    : {};
  const sourceSlots = parsed.slots && typeof parsed.slots === "object" && !Array.isArray(parsed.slots)
    ? parsed.slots
    : {};
  const rawInteractionType = parsed.interactionType || sourceGoal.interactionType || sourceSlots.interactionType || "";
  const rawDomain = parsed.domain || sourceGoal.domain || sourceSlots.domain || "";
  const rawGoal = parsed.goal || sourceGoal.goal || sourceSlots.goal || "";
  const rawTopic = parsed.topic || sourceGoal.topic || sourceSlots.topic || "";
  const inferredInteractionType = inferConversationInteractionType(rawText, parsed);
  const inferredDomain = inferConversationDomain(rawText, {
    ...parsed,
    topic: rawTopic || sourceSlots.topic,
    externalDataType: parsed.externalDataType || sourceSlots.externalDataType,
  });
  const interactionType = INTERACTION_TYPES.includes(rawInteractionType)
    ? rawInteractionType
    : inferredInteractionType;
  const domain = CONVERSATION_DOMAINS.includes(rawDomain)
    ? rawDomain
    : inferredDomain;
  return {
    interactionType,
    domain,
    goal: rawGoal || String(rawText || "").slice(0, 200),
    action: parsed.action || sourceGoal.action || null,
    rawValue: parsed.rawValue || {
      rawText: String(rawText || ""),
      ...(rawInteractionType && !INTERACTION_TYPES.includes(rawInteractionType) ? { interactionType: rawInteractionType } : {}),
      ...(rawDomain && !CONVERSATION_DOMAINS.includes(rawDomain) ? { domain: rawDomain } : {}),
      ...(rawTopic && normalizeConversationTopic(rawTopic) === "general_qa" && rawTopic !== "general_qa" ? { topic: rawTopic } : {}),
    },
    confidence: typeof parsed.confidence === "number"
      ? Math.min(1, Math.max(0, parsed.confidence))
      : (rawInteractionType || rawDomain || rawGoal ? 0.8 : 0.5),
    source: parsed.source || "rule-parser",
  };
}

function inferConversationInteractionType(rawText, parsed = {}) {
  const text = String(rawText || "").trim();
  const speechAct = parsed.speechAct || "";
  if (/对比|比较|相比|哪个更|哪一个更|差别|区别/.test(text)) return "compare";
  if (/计划|规划|安排|路线|行程|怎么安排|怎么准备/.test(text)) return "plan";
  if (/为什么|为何|原因|原理|解释|说明一下/.test(text)) return "explain";
  if (/继续|刚才|上面|你说的|追问|再说/.test(text)) return "followup";
  if (speechAct === "command") return "command";
  if (speechAct === "question" || /[?？]|怎么|如何|是否|能否|可以.*吗|请问/.test(text)) return "question";
  return "general_qa";
}

function inferConversationDomain(rawText, parsed = {}) {
  const text = String(rawText || "").trim();
  const topic = normalizeConversationTopic(parsed.topic || parsed.slots?.topic || "");
  const externalDataType = normalizeExternalDataType(parsed.externalDataType || parsed.slots?.externalDataType || "");
  if (topic === "weather_query" || externalDataType === "weather") return "weather";
  if (externalDataType === "map") return "navigation";
  if (externalDataType === "charging") return "energy";
  if (topic === "vehicle_knowledge") return /用户手册|说明书|随车手册|手册|故障|保养|安全|警告|防夹|应急/.test(text)
    ? "manual_knowledge"
    : "vehicle_knowledge";
  if (/用户手册|说明书|随车手册|手册|故障|保养|安全|警告|防夹|应急/.test(text)) return "manual_knowledge";
  if (/导航|路线|目的地|出发|到.+(?:路|站|区|市|店|机场|公司|学校)/.test(text)) return "navigation";
  if (/换电|充电|补能|电池|续航/.test(text)) return "energy";
  if (/车窗|窗户|尾门|后备箱|座椅|靠背|空调|座舱|车辆|驾驶|车内/.test(text)) return "vehicle_knowledge";
  return "general";
}

export function isVehicleIntent(intent) {
  return VEHICLE_INTENTS.includes(intent);
}

export function isConversationIntent(intent) {
  return CONVERSATION_INTENTS.includes(intent);
}

export function isSupportedIntent(intent) {
  return SUPPORTED_INTENTS.includes(intent);
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

const EXECUTABLE_INTENTS = new Set(VEHICLE_INTENTS);

const VEHICLE_DOMAIN_PATTERN = /车窗|窗户|开窗|关窗|升窗|降窗|尾门|后备箱|行李箱|后舱|车门|门把手|前舱盖|引擎盖|充电口|后视镜|雨刷|雨刮|悬架|车身高度|车身升高|车身降低|前轮|车轮|轮胎|座椅|靠背|头枕|空调|座舱|安全提醒|碰撞提醒|车道提醒|疲劳提醒|导航|路线|换电站|充电站|补能/;

export function classifySpeechAct(rawText, intendedIntent = "conversation.general") {
  const text = String(rawText || "").trim();
  let speechAct;
  let reason;
  const hasLaterAffirmativeCommand = /(?:[，,。！!；;]\s*|快|请|把|将|给我|帮我|改为|而是).{0,24}(?:打开|开启|关闭|关上|关掉|调节|调到|设置|升窗|拉下|拉到底|开到|关严实|降(?:窗|.{0,8}(?:一半|一点|到底|百分|%)|\d))/.test(text);

  if (/如果|假如|假设|要是|会怎样|会怎么样|明天再说|以后再说|下次再说/.test(text)) {
    speechAct = "hypothetical";
    reason = "原文包含假设、后果咨询或延期表达";
  } else if (/^先不(?:用|要|急|关|开|调|设置|操作|执行)/.test(text) && !hasLaterAffirmativeCommand) {
    speechAct = "hypothetical";
    reason = "原文明确暂缓当前动作";
  } else if (/(?:不播放|不拨打|不想.{0,6}(?:播放|听|拨打|呼叫)|(?:不要|别|禁止|不准|不许|不用|无需).{0,12}(?:打开|开启|关闭|关上|关掉|调节|调到|设置|导航|去|找|播放|听|拨打|呼叫|打电话))/.test(text)) {
    speechAct = "report";
    reason = "原文是禁止或撤销表达，不是执行请求";
  } else if (/(?:不用动|无需操作|不需要(?:操作|调整)|别动|保持现状|不用改|我刚.{0,12}(?:摇下|打开|关上|关闭|降下).{0,12}(?:不用|无需|别动|保持))/.test(text)) {
    speechAct = "report";
    reason = "原文要求保持当前状态，不执行新的车辆动作";
  } else if (/(?:我)?(?:没有|没)让你|(?:我)?(?:没有|没)说|(?:不是|并非)(?:让你|要你|要)/.test(text)) {
    speechAct = "report";
    reason = "原文是否认或纠正先前动作";
  } else if (/(?:需要|要)(?:什么|哪些).{0,6}(?:条件|要求)|(?:有|需要)(?:什么|哪些).{0,6}(?:条件|要求)|会发生什么|有什么后果|有何后果|意味着什么/.test(text)) {
    speechAct = "question";
    reason = "原文询问执行条件或动作后果";
  } else if (/(?:已经|刚刚|刚才|早就|现在).{0,16}(?:打开|开启|关闭|关上|开着|关着)|(?:打开|开启|关闭|关上).{0,12}(?:了|着)$/.test(text)) {
    speechAct = "report";
    reason = "原文陈述已完成或持续的车辆状态";
  } else if (/[?？]/.test(text) || /怎么|如何|为什么|为何|是否|能否|可不可以|可以.{0,12}吗|我想知道|想了解|请问/.test(text)) {
    speechAct = "question";
    reason = "原文包含疑问或知识咨询表达";
  } else if (/异响|不舒服|太冷|太热|不好用|有味|漏风|卡顿|怎么不制冷/.test(text)) {
    speechAct = "complaint";
    reason = "原文描述体验问题或抱怨";
  } else if (/坏了|故障|异常|无法|不能|没反应|不制冷|打不开|关不上|失灵/.test(text)) {
    speechAct = "report";
    reason = "原文报告故障或异常状态";
  } else if (hasExplicitActionPredicate(text, intendedIntent)) {
    speechAct = "command";
    reason = "原文包含与目标域匹配的明确动作谓词";
  } else {
    speechAct = VEHICLE_DOMAIN_PATTERN.test(text) ? "report" : "question";
    reason = VEHICLE_DOMAIN_PATTERN.test(text)
      ? "原文只提及车辆对象，没有明确动作谓词"
      : "原文没有可执行车辆动作";
  }

  const predicate = speechAct === "command" ? matchExplicitActionPredicate(text, intendedIntent) : "";
  const actionable = speechAct === "command" && Boolean(predicate) && EXECUTABLE_INTENTS.has(intendedIntent);
  return {
    speechAct,
    actionability: {
      actionable,
      reason: actionable ? `明确动作谓词：${predicate}` : reason,
      source: "raw-text-guard",
      ...(predicate ? { predicate } : {}),
      intendedIntent,
    },
  };
}

function hasExplicitActionPredicate(text, intent) {
  return Boolean(matchExplicitActionPredicate(text, intent));
}

function matchExplicitActionPredicate(text, intent) {
  const patterns = {
    "body.window.setPosition": /打开|开启|开点|开到|开至|关闭|关上|升窗|降窗|升起|降下|调到|调至|设为|设置为/,
    "body.tailgate.open": /打开|开启|开一下|关闭|关上|合上|收起/,
    "seat.driver.setBackrestAngle": /调一下|调节|调到|调至|调整到|设置为|设为|后仰到|前倾到|竖直|直立/,
    "seat.comfort.setLevel": /加热|通风|开到|调到|调至|设置为|设为|关闭|关掉|最大|最高|最强|一挡|二挡|三挡|一档|二档|三档/,
    "cabin.comfort.applySettings": /打开|开启|关闭|关掉|关一下|关上|调一下|调节|调到|调至|设为|设置为|升到|降到|开到|再高|再低|调高|调低|升高|降低|风速|风量|自然风|通风模式|制冷|制热|最低|最高|最大风/,
    "vehicle.component.setState": /打开|开启|关闭|关上|合上|弹出|收起|折叠|展开|启动|停止|升高|升到|降低|降到|前移|后移|向前|向后|移动|左转|右转|回正|转向|转动|滚动|复位/,
    "cabin.climate.setPreset": /打开|开启|关闭|关掉|关一下|关上|调一下|调节|调到|调至|设为|设置为|升到|降到|开到|再高|再低|调高|调低|升高|降低|风速|风量|自然风|通风模式|制冷|制热|最低|最高|最大风/,
    "navigation.planRoute": /导航(?:一下|到|去)|带我去|规划.{0,12}路线|前往/,
    "energy.findSwapStation": /找(?:一?下)?.{0,16}(?:换电站|充电站)|导航.{0,12}(?:换电站|充电站)|去.{1,16}(?:的|附近).{0,8}(?:换电站|充电站)/,
    "safety.reject": /关闭|关掉|禁用|取消/,
  };
  return String(text || "").match(patterns[intent])?.[0] || "";
}

export function normalizeParsedCommand(command, fallback = {}) {
  const proposedIntent = isSupportedIntent(command?.intent)
    ? command.intent
    : isSupportedIntent(fallback.intent)
      ? fallback.intent
      : "conversation.general";
  const rawText = String(command?.rawText || fallback.rawText || "").trim();
  const speechAudit = classifySpeechAct(rawText, proposedIntent);
  const executionBlocked = EXECUTABLE_INTENTS.has(proposedIntent)
    && (speechAudit.speechAct !== "command" || speechAudit.actionability.actionable !== true);
  const intent = executionBlocked ? "conversation.general" : proposedIntent;
  const suppliedSlots = executionBlocked
    ? {
        topic: VEHICLE_DOMAIN_PATTERN.test(rawText) ? "vehicle_knowledge" : "general_qa",
        responseMode: "voice_text",
        requiresExternalData: false,
        requestedIntent: proposedIntent,
        ...(/(?:空调|座舱|温度).*(?:舒服一点|舒适一点|凉快一点|暖和一点)/.test(rawText)
          ? {
              needsClarification: true,
              clarification: "请说明空调要调到多少度。",
              missingRequiredSlots: ["temperature"],
            }
          : {}),
      }
    : command?.slots || fallback.slots || {};
  const slots = normalizeSlots(intent, suppliedSlots);
  const slotProvenance = normalizeSlotProvenance(
    command?.slotProvenance || fallback.slotProvenance,
    slots,
  );
  const missingRequiredSlots = getMissingRequiredSlots(intent, slots, slotProvenance);
  const normalizationAudit = {
    ...(command?.intentNormalization ? { intentNormalization: command.intentNormalization } : {}),
    ...(command?.slotNormalization ? { slotNormalization: command.slotNormalization } : {}),
    ...(executionBlocked ? {
      actionabilityNormalization: {
        applied: true,
        source: "raw-text-guard",
        from: proposedIntent,
        to: "conversation.general",
        reason: speechAudit.actionability.reason,
      },
    } : {}),
  };
  if (missingRequiredSlots.length) {
    const trustedRequestedSlots = Object.fromEntries(
      Object.entries(slots).filter(([key]) => slotProvenance[key] !== "unknown"),
    );
    return {
      requestId: command?.requestId || fallback.requestId || createRequestId(),
      rawText,
      intent: "conversation.general",
      confidence: clampNumber(command?.confidence, 0, 1, fallback.confidence ?? 0.5),
      slots: normalizeSlots("conversation.general", {
        topic: "general_qa",
        responseMode: "voice_text",
        requiresExternalData: false,
        needsClarification: true,
        clarification: clarificationFor(intent, missingRequiredSlots),
        requestedIntent: intent,
        requestedSlots: trustedRequestedSlots,
        missingRequiredSlots,
      }),
      slotProvenance,
      ...speechAudit,
      ...normalizationAudit,
      conversationGoal: createConversationGoal(rawText, {
        ...command,
        ...speechAudit,
        topic: command?.topic || command?.slots?.topic || fallback.topic || fallback.slots?.topic,
        slots: {
          topic: "general_qa",
          responseMode: "voice_text",
          requiresExternalData: false,
          needsClarification: true,
          clarification: clarificationFor(intent, missingRequiredSlots),
          requestedIntent: intent,
          requestedSlots: trustedRequestedSlots,
          missingRequiredSlots,
        },
      }),
      source: ["rule-parser", "local-model", "local-ollama", "cloud-model"].includes(command?.source)
        ? command.source
        : fallback.source || "rule-parser",
    };
  }
  const externalDataType = normalizeExternalDataType(command?.externalDataType || fallback.externalDataType || slots.externalDataType);
  const requiresExternalData = command?.requiresExternalData === true || fallback.requiresExternalData === true || slots.requiresExternalData === true;

  return {
    requestId: command?.requestId || fallback.requestId || createRequestId(),
    rawText,
    intent,
    confidence: clampNumber(command?.confidence, 0, 1, fallback.confidence ?? 0.5),
    slots,
    slotProvenance,
    ...speechAudit,
    ...normalizationAudit,
    ...(intent === "conversation.general"
      ? { conversationGoal: createConversationGoal(rawText, {
          ...command,
          ...speechAudit,
          topic: command?.topic || command?.slots?.topic || fallback.topic || fallback.slots?.topic,
          slots,
        }) }
      : {}),
    source: ["rule-parser", "local-model", "local-ollama", "cloud-model"].includes(command?.source)
      ? command.source
      : fallback.source || "rule-parser",
    ...(requiresExternalData ? { requiresExternalData: true } : {}),
    ...(externalDataType ? { externalDataType } : {}),
  };
}

const REQUIRED_TOOL_SLOTS = Object.freeze({
  "body.window.setPosition": [],
  "body.tailgate.open": ["open"],
  "seat.driver.setBackrestAngle": ["seat", "angle"],
  "vehicle.component.setState": ["actionId", "value"],
  "cabin.climate.setPreset": [],
  "seat.comfort.setLevel": ["seatZone", "seatMode", "level"],
  "cabin.comfort.applySettings": [],
  "navigation.planRoute": ["origin", "destination"],
  "energy.findSwapStation": ["destination"],
});

const SLOT_PROVENANCE_VALUES = new Set([
  "explicit",
  "context",
  "original-turn",
  "clarification-turn",
  "preference",
  "memory-reference",
  "context-memory",
  "unknown",
]);
const TRUSTED_REQUIRED_SLOT_PROVENANCE_VALUES = new Set([
  "explicit",
  "context",
  "original-turn",
  "clarification-turn",
]);
const TRUSTED_SLOT_PROVENANCE = new WeakSet();
const UNTRUSTED_VEHICLE_STATE_SLOT_KEYS = Object.freeze([
  "vehicleSpeedKph",
  "speedKph",
  "gear",
  "rearClearance",
  "confirmRearClearance",
  "antiPinch",
  "windowAntiPinchAvailable",
  "rainDetected",
  "driverBackrestAngle",
  "vehicleLocked",
]);

export function normalizeSlotProvenance(provenance, slots = {}) {
  const supplied = provenance && typeof provenance === "object" && !Array.isArray(provenance) ? provenance : {};
  return Object.fromEntries(Object.keys(slots).map((key) => {
    const value = supplied[key]
      || (key === "requestedTemperature" ? supplied.temperature : "")
      || (key === "temperatureOutOfRange" && ["explicit", "context", "preference"].includes(supplied.temperature) ? "context" : "")
      || (key === "requestedAngle" ? supplied.angle : "")
      || (key === "angleOutOfRange" && ["explicit", "context", "preference"].includes(supplied.angle) ? "context" : "");
    return [key, SLOT_PROVENANCE_VALUES.has(value) ? value : "unknown"];
  }));
}

export function createTrustedSlotProvenance(provenance) {
  const trusted = Object.freeze({ ...(provenance || {}) });
  TRUSTED_SLOT_PROVENANCE.add(trusted);
  return trusted;
}

export function isTrustedSlotProvenance(provenance) {
  return Boolean(provenance && typeof provenance === "object" && TRUSTED_SLOT_PROVENANCE.has(provenance));
}

export function isTrustedRequiredSlotProvenance(value, { contextTrusted = true } = {}) {
  return TRUSTED_REQUIRED_SLOT_PROVENANCE_VALUES.has(value)
    && (value !== "context" || contextTrusted === true);
}

export function getMissingRequiredSlots(intent, slots = {}, provenance = {}) {
  let required = REQUIRED_TOOL_SLOTS[intent] || [];
  if (intent === "body.window.setPosition") {
    required = Array.isArray(slots.targets) && slots.targets.length > 0
      ? ["targets"]
      : ["zone", "percent"];
  }
  if (intent === "cabin.climate.setPreset" || intent === "cabin.comfort.applySettings") {
    const controlSlots = intent === "cabin.climate.setPreset"
      ? ["temperature", "temperatureDelta", "climatePower", "climateMode", "fanLevel", "airflow", "passengerMode"]
      : ["windowTargets", "temperature", "temperatureDelta", "climatePower", "climateMode", "fanLevel"];
    const supplied = controlSlots.filter((key) => slots[key] !== undefined && slots[key] !== null && slots[key] !== "");
    required = supplied.length ? supplied : ["control"];
  }
  return required.filter((key) => {
    const value = slots[key];
    return value === undefined || value === null || value === ""
      || !isTrustedRequiredSlotProvenance(provenance[key]);
  });
}

export function getMemorySourcedRequiredSlots(intent, slots = {}, provenance = {}) {
  let required = REQUIRED_TOOL_SLOTS[intent] || [];
  if (intent === "cabin.climate.setPreset" || intent === "cabin.comfort.applySettings") {
    const controlSlots = intent === "cabin.climate.setPreset"
      ? ["temperature", "temperatureDelta", "climatePower", "climateMode", "fanLevel", "airflow", "passengerMode"]
      : ["windowTargets", "temperature", "temperatureDelta", "climatePower", "climateMode", "fanLevel"];
    required = controlSlots.filter((key) => slots[key] !== undefined && slots[key] !== null && slots[key] !== "");
  }
  return required.filter((key) => (
    slots[key] !== undefined && slots[key] !== null && slots[key] !== ""
      && ["memory-reference", "context-memory"].includes(provenance[key])
  ));
}

function clarificationFor(intent, missing) {
  const labels = {
    zone: "要调节哪一扇车窗",
    percent: "要调到多少开度",
    seat: "要调节哪个座椅",
    seatZone: "要调节哪个座位",
    seatMode: "座椅要开启加热还是通风",
    angle: "靠背要调到多少度",
    actionId: "要调节哪个车辆组件",
    value: "组件要调到什么状态或数值",
    temperature: "空调要调到多少度",
    control: "空调要设置温度、开关、模式还是风量",
    windowTargets: "请说明每扇车窗的目标开度",
    climatePower: "空调要开启还是关闭",
    climateMode: "空调要使用制冷、制热、通风还是自动模式",
    fanLevel: "空调风量要调到几挡",
    level: "座椅舒适功能要调到几挡",
    targets: "请说明每扇车窗的目标开度",
    origin: "从哪里出发",
    destination: "目的地是哪里",
    open: "要打开还是关闭尾门",
  };
  return `请说明${missing.map((key) => labels[key] || key).join("、")}。`;
}

export function normalizeExternalDataType(type) {
  const normalized = String(type || "").trim().toLowerCase().replace(/_/g, "-");
  const aliases = {
    search: "web-search",
    web: "web-search",
    websearch: "web-search",
    "web-search": "web-search",
    weather: "weather",
    poi: "poi",
    restaurant: "poi",
    restaurants: "poi",
    map: "map",
    maps: "map",
    route: "map",
    navigation: "map",
    charging: "charging",
    charge: "charging",
    energy: "charging",
    memory: "user-memory",
    "user-memory": "user-memory",
  };
  const canonical = aliases[normalized] || normalized;
  return EXTERNAL_DATA_TYPES.includes(canonical) ? canonical : "";
}

export function normalizeConversationTopic(topic) {
  const normalized = String(topic || "").trim().toLowerCase().replace(/-/g, "_");
  const aliases = {
    weather: "weather_query",
    weather_query: "weather_query",
    food: "food_recommendation",
    restaurant: "food_recommendation",
    restaurants: "food_recommendation",
    food_recommendation: "food_recommendation",
    vehicle: "vehicle_knowledge",
    vehicle_knowledge: "vehicle_knowledge",
    search: "web_search",
    web: "web_search",
    web_search: "web_search",
    small_talk: "smalltalk",
    smalltalk: "smalltalk",
    general: "general_qa",
    general_qa: "general_qa",
  };
  return aliases[normalized] || "general_qa";
}

export function resolveConversationRoute(rawText = "", parsedCommand = {}, options = {}) {
  const slots = parsedCommand.slots && typeof parsedCommand.slots === "object" && !Array.isArray(parsedCommand.slots)
    ? parsedCommand.slots
    : {};
  const rawTopic = slots.topic || parsedCommand.topic || options.fallbackTopic || "";
  const topic = normalizeConversationTopic(rawTopic);
  const conversationGoal = parsedCommand.conversationGoal && typeof parsedCommand.conversationGoal === "object" && !Array.isArray(parsedCommand.conversationGoal)
    ? parsedCommand.conversationGoal
    : createConversationGoal(rawText, { ...parsedCommand, topic: rawTopic });
  const domain = CONVERSATION_DOMAINS.includes(conversationGoal.domain)
    ? conversationGoal.domain
    : "general";
  const interactionType = INTERACTION_TYPES.includes(conversationGoal.interactionType)
    ? conversationGoal.interactionType
    : "general_qa";
  const requiresExternalData = parsedCommand.requiresExternalData === true || slots.requiresExternalData === true || options.requiresExternalData === true;
  let externalDataType = normalizeExternalDataType(
    options.externalDataType
    || parsedCommand.externalDataType
    || slots.externalDataType
    || "",
  );
  if (!externalDataType && (domain === "weather" || topic === "weather_query")) externalDataType = "weather";
  if (!externalDataType && topic === "web_search") externalDataType = "web-search";
  if (!externalDataType && (slots.requiresPoi === true || (topic === "food_recommendation" && requiresExternalData))) externalDataType = "poi";

  return {
    topic,
    domain,
    interactionType,
    goal: conversationGoal.goal || String(rawText || "").slice(0, 200),
    rawValue: conversationGoal.rawValue || null,
    externalDataType,
    requiresExternalData: requiresExternalData || Boolean(externalDataType),
    isWeather: domain === "weather" || topic === "weather_query" || externalDataType === "weather",
    isVehicleKnowledge: domain === "vehicle_knowledge" || topic === "vehicle_knowledge",
    isManualKnowledge: domain === "manual_knowledge" || topic === "manual_knowledge",
    isPoi: topic === "food_recommendation" || externalDataType === "poi",
    isWebSearch: topic === "web_search" || externalDataType === "web-search",
    source: conversationGoal.source || parsedCommand.source || "conversation-route",
  };
}

export function isBareDegreeAdjustment(text) {
  const normalized = String(text || "").trim();
  return /(?:帮我)?(?:调|调整|设|设置|开)(?:到|至|成)?\s*-?\d{1,2}\s*(?:度|°|摄氏度)/.test(normalized)
    && !/座椅|靠背|后仰|前倾|腰托|坐姿|空调|温度|座舱|风量|车窗|窗户|后备箱|尾门|导航|路线|去|到.+(?:路|站|区|市|店|机场|公司|学校)/.test(normalized);
}

export function normalizeSlots(intent, slots = {}) {
  const normalized = { ...slots };
  for (const key of UNTRUSTED_VEHICLE_STATE_SLOT_KEYS) delete normalized[key];

  if (intent === "body.window.setPosition") {
    if (normalized.percent != null && normalized.percent !== "") normalized.percent = clampNumber(normalized.percent, 0, 100, NaN);
  }

  if (intent === "body.tailgate.open") {
    if (Object.hasOwn(normalized, "open")) normalized.open = normalized.open !== false;
  }

  if (intent === "seat.driver.setBackrestAngle") {
    const requestedAngle = Number(normalized.angle);
    if (Number.isFinite(requestedAngle)) {
      normalized.requestedAngle = requestedAngle;
      normalized.angleOutOfRange = requestedAngle < SAFETY_BASELINE.seat.minAngle
        || requestedAngle > SAFETY_BASELINE.seat.maxAngleStationary;
    }
    if (normalized.angle != null && normalized.angle !== "") normalized.angle = clampNumber(normalized.angle, SAFETY_BASELINE.seat.minAngle, SAFETY_BASELINE.seat.maxAngleStationary, NaN);
    if (normalized.delta != null && normalized.delta !== "") normalized.delta = clampNumber(normalized.delta, -12, 12, NaN);
  }

  if (intent === "vehicle.component.setState") {
    normalized.actionId = typeof normalized.actionId === "string" ? normalized.actionId.trim() : normalized.actionId;
    if (normalized.value !== null && normalized.value !== "") {
      const value = Number(normalized.value);
      normalized.value = Number.isFinite(value) ? value : normalized.value;
    }
  }

  if (intent === "cabin.climate.setPreset") {
    const requestedTemperature = Number(normalized.temperature);
    if (Number.isFinite(requestedTemperature)) {
      normalized.requestedTemperature = requestedTemperature;
      normalized.temperatureOutOfRange = requestedTemperature < SAFETY_BASELINE.climate.minTemperature
        || requestedTemperature > SAFETY_BASELINE.climate.maxTemperature;
    }
    if (normalized.temperature != null && normalized.temperature !== "") {
      normalized.temperature = clampNumber(
        normalized.temperature,
        SAFETY_BASELINE.climate.minTemperature,
        SAFETY_BASELINE.climate.maxTemperature,
        NaN,
      );
    }
    const requestedFanLevel = Number(normalized.fanLevel);
    if (Number.isFinite(requestedFanLevel)) {
      normalized.requestedFanLevel = requestedFanLevel;
      normalized.fanLevelOutOfRange = requestedFanLevel < SAFETY_BASELINE.climate.minFanLevel
        || requestedFanLevel > SAFETY_BASELINE.climate.maxFanLevel;
    }
  }

  if (intent === "cabin.comfort.applySettings") {
    const requestedTemperature = Number(normalized.temperature);
    if (Number.isFinite(requestedTemperature)) {
      normalized.requestedTemperature = requestedTemperature;
      normalized.temperatureOutOfRange = requestedTemperature < SAFETY_BASELINE.climate.minTemperature
        || requestedTemperature > SAFETY_BASELINE.climate.maxTemperature;
    }
    const requestedFanLevel = Number(normalized.fanLevel);
    if (Number.isFinite(requestedFanLevel)) {
      normalized.requestedFanLevel = requestedFanLevel;
      normalized.fanLevelOutOfRange = requestedFanLevel < SAFETY_BASELINE.climate.minFanLevel
        || requestedFanLevel > SAFETY_BASELINE.climate.maxFanLevel;
    }
  }

  if (intent === "seat.comfort.setLevel") {
    const requestedLevel = Number(normalized.level);
    if (Number.isFinite(requestedLevel)) {
      normalized.requestedLevel = requestedLevel;
      normalized.levelOutOfRange = requestedLevel < 0 || requestedLevel > 3;
    }
  }

  if (intent === "energy.findSwapStation") {
    if (normalized.minArrivalSoc != null && normalized.minArrivalSoc !== "") normalized.minArrivalSoc = clampNumber(normalized.minArrivalSoc, 5, 35, NaN);
  }

  if (intent === "navigation.planRoute") {
  }

  if (intent === "safety.reject") {
    normalized.reason = normalized.reason || "高风险车辆安全指令";
    normalized.alternative = normalized.alternative || "可降低提示音量，但保留碰撞、车道和疲劳提醒。";
  }

  if (intent === "conversation.general") {
    normalized.topic = normalizeConversationTopic(normalized.topic);
    normalized.responseMode = normalized.responseMode || "voice_text";
    normalized.requiresPoi = normalized.requiresPoi === true;
    normalized.requiresExternalData = normalized.requiresExternalData === true;
    const inferredExternalDataType =
      normalized.topic === "weather_query"
        ? "weather"
        : normalized.topic === "web_search"
          ? "web-search"
          : normalized.requiresPoi || (normalized.topic === "food_recommendation" && normalized.requiresExternalData)
            ? "poi"
            : "";
    const externalDataType = normalizeExternalDataType(normalized.externalDataType || inferredExternalDataType);
    if (externalDataType) normalized.externalDataType = externalDataType;
    if (externalDataType) normalized.requiresExternalData = true;
    normalized.disclaimer = normalized.disclaimer || (
      externalDataType === "weather"
        ? "天气类问题会尝试通过天气 adapter 获取实时数据；未取到时必须说明能力边界。"
        : "未接入真实地图、POI 或定位数据。"
    );
  }

  return normalized;
}

export function sanitizeParsedCommandSlots(command = {}) {
  const slots = normalizeSlots(command.intent, command.slots || {});
  const allowedSlotKeys = new Set(Object.keys(slots));
  const slotProvenance = command.slotProvenance && typeof command.slotProvenance === "object" && !Array.isArray(command.slotProvenance)
    ? Object.fromEntries(Object.entries(command.slotProvenance).filter(([key]) => allowedSlotKeys.has(key)))
    : command.slotProvenance;
  return {
    ...command,
    slots,
    ...(slotProvenance ? { slotProvenance } : {}),
  };
}

export function createAgentEvent(requestId, agentId, status, message, data, { now = Date.now } = {}) {
  return {
    requestId,
    agentId,
    status: AGENT_EVENT_STATUS.includes(status) ? status : "working",
    message,
    data,
    timestamp: now(),
  };
}

export function createToolCall(requestId, tool, args, requiresSafety = true, argProvenance = {}, { sequence = 1 } = {}) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("sequence must be a positive safe integer");
  }
  return {
    requestId,
    commandId: `${requestId}:${sequence}:${tool}`,
    tool,
    args: { ...args },
    argProvenance: Object.fromEntries(Object.keys(args || {}).map((key) => [key, argProvenance[key] || "unknown"])),
    requiresSafety,
  };
}

export function createToolResult(requestId, tool, ok, statePatch, hmiSummary, visualScenario, source = "dev-adapter", opts = {}) {
  if (typeof requestId === "object" && requestId !== null) {
    const result = requestId;
    return createToolResult(
      result.requestId,
      result.tool,
      result.ok,
      result.statePatch,
      result.hmiSummary,
      result.visualScenario,
      result.source,
      {
        executionState: result.executionState,
        commandId: result.commandId,
        simulated: result.simulated,
        observedState: result.observedState,
        requestedState: result.requestedState,
        statePatchSource: result.statePatchSource,
        executionTrace: result.executionTrace,
        executionError: result.executionError,
        timestamp: result.timestamp,
      },
    );
  }

  const simulated = opts.simulated !== undefined ? opts.simulated : (source === "dev-adapter");
  const timestamp = opts.timestamp || new Date().toISOString();
  const commandId = opts.commandId || `${requestId || "cmd"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    requestId,
    tool,
    ok: Boolean(ok),
    executionState: opts.executionState || (Boolean(ok) ? "succeeded" : "failed"),
    commandId,
    simulated,
    statePatch: { ...(statePatch || {}) },
    observedState: opts.observedState !== undefined ? { ...opts.observedState } : { ...(statePatch || {}) },
    requestedState: opts.requestedState !== undefined ? { ...opts.requestedState } : undefined,
    statePatchSource: opts.statePatchSource || undefined,
    executionTrace: Array.isArray(opts.executionTrace) ? opts.executionTrace.map((item) => ({ ...item })) : undefined,
    executionError: opts.executionError ? { ...opts.executionError } : undefined,
    hmiSummary,
    visualScenario: VISUAL_SCENARIOS.includes(visualScenario) ? visualScenario : undefined,
    source: source || "dev-adapter",
    timestamp,
  };
}

function freezeCopiedValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopiedValue));
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, freezeCopiedValue(item)]),
  ));
}

function freezeVehicleExecutionError(executionError) {
  if (!executionError || typeof executionError !== "object" || Array.isArray(executionError)
    || !executionError.code || !executionError.message || !executionError.stage
    || typeof executionError.retryable !== "boolean") {
    throw new TypeError("invalid execution error");
  }
  return freezeCopiedValue({
    code: executionError.code,
    message: executionError.message,
    stage: executionError.stage,
    retryable: executionError.retryable,
  });
}

function validateVehicleExecutionTrace(executionTrace, executionState) {
  if (!Array.isArray(executionTrace) || executionTrace.length === 0) {
    throw new TypeError("invalid vehicle tool result");
  }
  let previousState;
  let previousAtMs = -Infinity;
  for (const [index, traceItem] of executionTrace.entries()) {
    const atMs = Date.parse(traceItem?.at || "");
    if (!traceItem || typeof traceItem !== "object" || Array.isArray(traceItem)
      || !VEHICLE_EXECUTION_STATES.includes(traceItem.state)
      || typeof traceItem.source !== "string" || !traceItem.source.trim()
      || typeof traceItem.at !== "string" || !traceItem.at.trim()
      || !Number.isFinite(atMs)
      || atMs < previousAtMs) {
      throw new TypeError("invalid vehicle tool result");
    }
    if (index === 0 && traceItem.state !== "submitted") {
      throw new TypeError("invalid vehicle tool result");
    }
    if (previousState && !VEHICLE_EXECUTION_TRANSITIONS[previousState]?.includes(traceItem.state)) {
      throw new TypeError("invalid vehicle tool result");
    }
    previousState = traceItem.state;
    previousAtMs = atMs;
  }
  if (previousState !== executionState) {
    throw new TypeError("invalid vehicle tool result");
  }
}

export function createVehicleToolResult({
  requestId,
  commandId,
  tool,
  ok,
  executionState,
  requestedState,
  confirmedSnapshotId,
  executionTrace,
  executionError,
  hmiSummary,
  visualScenario,
  source,
  simulated,
  timestamp,
} = {}) {
  if (!commandId || typeof commandId !== "string") {
    throw new TypeError("commandId is required");
  }
  if (typeof ok !== "boolean" || !VEHICLE_EXECUTION_STATES.includes(executionState)) {
    throw new TypeError("invalid vehicle tool result");
  }
  const validStates = ok
    ? ["accepted", "executing", "observed-succeeded"]
    : ["duplicate-command", "failed", "timeout"];
  if (!validStates.includes(executionState)) {
    throw new TypeError("invalid vehicle tool result");
  }
  validateVehicleExecutionTrace(executionTrace, executionState);
  if (confirmedSnapshotId !== undefined
    && (typeof confirmedSnapshotId !== "string" || !confirmedSnapshotId.trim() || executionState !== "observed-succeeded")) {
    throw new TypeError("invalid vehicle tool result");
  }
  const requiresExecutionError = ok === false;
  if (requiresExecutionError && !executionError) {
    throw new TypeError("invalid execution error");
  }
  if (!requiresExecutionError && executionError !== undefined) {
    throw new TypeError("invalid vehicle tool result");
  }
  return Object.freeze({
    requestId,
    commandId,
    tool,
    ok,
    executionState,
    ...(requestedState !== undefined ? { requestedState: freezeCopiedValue(requestedState) } : {}),
    ...(confirmedSnapshotId !== undefined ? { confirmedSnapshotId } : {}),
    ...(executionTrace !== undefined ? { executionTrace: freezeCopiedValue(executionTrace) } : {}),
    ...(executionError !== undefined ? { executionError: freezeVehicleExecutionError(executionError) } : {}),
    hmiSummary,
    visualScenario,
    source,
    simulated: Boolean(simulated),
    timestamp,
  });
}
