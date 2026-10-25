// Test-only legacy rule parser. Production semantics come only from the Vehicle-SLU envelope;
// verify-vehicle-slu-no-legacy-authority forbids importing this module from src/.
import {
  classifySpeechAct,
  createRequestId,
  getMissingRequiredSlots,
  isBareDegreeAdjustment,
  isVehicleIntent,
  normalizeParsedCommand,
  SEMANTIC_CONFIDENCE_POLICY,
} from "../../src/runtime/agent-schemas.js";

export const SEMANTIC_POLICY = Object.freeze({ id: "nio-semantic-policy", version: "1.0.0" });

const COMPOUND_DOMAIN_PATTERNS = Object.freeze([
  ["window", /车窗|窗户|开窗|关窗/],
  ["tailgate", /尾门|后备箱|行李箱/],
  ["seat", /座椅|靠背/],
  ["climate", /空调|座舱温度/],
  ["navigation", /导航|路线|前往/],
  ["energy", /换电|充电|补能/],
  ["weather", /天气|下雨|气温/],
]);
const COMPOUND_CONNECTOR_PATTERN = /(?:然后|同时|并且|再|还要|以及|接着)/;
const EXPLICIT_EXECUTION_OR_PLAN_PATTERN = /打开|开启|关闭|关上|设置|调节|调到|设为|查询|比较|规划|计划|安排/;
const INDEPENDENT_CLAUSE_BOUNDARY_PATTERN = /(?:然后|同时|并且|还要|以及|接着|再|，|,|；|;|。)/;
const BARE_AND_PREDICATE_SCOPE_PATTERN = /并(?=(?:把|将)|(?:打开|开启|关闭|关上|合上|收起|设置|调一下|调节|调整|调到|设为|查询|比较|规划|计划|安排|处理一下))/g;
const COMPOUND_INCOMPLETE_ATTEMPT_PATTERN = /调一下|调节|调整(?:一下)?|处理一下/;
const COMPOUND_EXECUTABLE_DOMAIN_INTENTS = Object.freeze([
  ["window", "body.window.setPosition"],
  ["tailgate", "body.tailgate.open"],
  ["seat", "seat.driver.setBackrestAngle"],
  ["climate", "cabin.climate.setPreset"],
  ["navigation", "navigation.planRoute"],
  ["energy", "energy.findSwapStation"],
]);

export function classifyCompoundOrConflictingInput(rawText = "") {
  const text = String(rawText || "");
  const domainIds = COMPOUND_DOMAIN_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([id]) => id);
  const hasConnector = COMPOUND_CONNECTOR_PATTERN.test(text);
  const isCompoundOrConflicting = domainIds.length > 1 || (hasConnector && domainIds.length > 0);
  const missingRequiredSlots = isCompoundOrConflicting
    ? getCompoundRequiredSlotAudits(text, domainIds)
        .flatMap((audit) => audit.missingRequiredSlots)
        .filter((slot, index, slots) => slots.indexOf(slot) === index)
    : [];
  return Object.freeze({
    domainIds: Object.freeze(domainIds),
    domainCount: domainIds.length,
    hasConnector,
    hasExplicitExecutionOrPlan: EXPLICIT_EXECUTION_OR_PLAN_PATTERN.test(text),
    missingRequiredSlots: Object.freeze(missingRequiredSlots),
    hasIndependentClarification: missingRequiredSlots.length > 0,
    isCompoundOrConflicting,
  });
}

const DESTINATION_PATTERNS = [
  /到([^，。,. ]{2,12})/,
  /去([^，。,. ]{2,12})/,
  /目的地(?:是|为)?([^，。,. ]{2,12})/,
];

function pickDestination(text) {
  for (const pattern of DESTINATION_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].replace(/的路线|路线|换电站|充电站/g, "").replace(/的$/, "");
  }
  return undefined;
}

export function parseWindowPercent(text) {
  const percentChinese = String(text || "").match(/百分之([零〇一二两三四五六七八九十百\d]+)/);
  if (percentChinese) {
    const value = /^\d+$/.test(percentChinese[1]) ? Number(percentChinese[1]) : parseChineseNumber(percentChinese[1]);
    if (Number.isFinite(value)) return value;
  }
  if (/一半|半开|半/.test(text)) return 50;
  if (/全开|完全打开|打开全部|拉到底/.test(text)) return 100;
  if (/关闭|关上|关死|关紧|关严实|关到底|升窗/.test(text)) return 0;
  const percentMatch = text.match(/(\d{1,3})\s*%/);
  if (percentMatch) return Number(percentMatch[1]);
  const chinesePercent = text.match(/([一二两三四五六七八九])成/);
  const map = { 一: 10, 二: 20, 两: 20, 三: 30, 四: 40, 五: 50, 六: 60, 七: 70, 八: 80, 九: 90 };
  if (chinesePercent) return map[chinesePercent[1]];
  return undefined;
}

function parseChineseNumber(value) {
  const digit = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[零〇一二两三四五六七八九]$/.test(value)) return digit[value];
  if (value === "十") return 10;
  if (/^[二三四五六七八九]十$/.test(value)) return digit[value[0]] * 10;
  if (/^十[一二三四五六七八九]$/.test(value)) return 10 + digit[value[1]];
  if (/^[一二两三四五六七八九]十[一二三四五六七八九]$/.test(value)) return digit[value[0]] * 10 + digit[value[2]];
  if (/^[一二三四五六七八九]百$/.test(value)) return digit[value[0]] * 100;
  return NaN;
}

export function parseWindowTargets(text) {
  const source = String(text || "");
  if (!/(?:车窗|窗户|窗)/u.test(source)) return { requested: false, grouped: false, targets: null };
  const allWindows = /(?:全部|所有|四扇)(?:的)?(?:车窗|窗户)|全部车窗/.test(source);
  if (allWindows) {
    const percent = parseWindowPercent(source);
    return percent == null ? { requested: true, grouped: true, targets: null } : {
      requested: true,
      grouped: true,
      targets: ["front_left", "front_right", "rear_left", "rear_right"].map((zone) => ({ zone, percent })),
    };
  }

  const frontPair = /主副驾|主驾.{0,5}副驾|副驾.{0,5}主驾/.test(source);
  if (frontPair) {
    if (/关上|关闭|关死|关紧/.test(source) && /打开|开启/.test(source)) {
      return { requested: true, grouped: true, targets: null };
    }
    const percent = parseWindowPercent(source);
    return percent == null ? { requested: true, grouped: true, targets: null } : {
      requested: true,
      grouped: true,
      targets: ["front_left", "front_right"].map((zone) => ({ zone, percent })),
    };
  }

  const explicitZoneCue = /主驾|副驾|左前|右前|前左|前右|左后|右后|后排左|后排右|左侧后排|右侧后排|前排.{0,3}(?:左|右)|(?:左|右).{0,3}前排/.test(source);
  if (explicitZoneCue) {
    const zone = parseWindowZone(source);
    const percent = parseWindowPercent(source);
    return zone && percent != null
      ? { requested: true, targets: [{ zone, percent }] }
      : { requested: true, targets: null };
  }

  const groups = [...source.matchAll(/前排|后排|前窗|后窗/g)];
  if (groups.length === 0) {
    const zone = parseWindowZone(source);
    const percent = parseWindowPercent(source);
    return zone && percent != null
      ? { requested: true, targets: [{ zone, percent }] }
      : { requested: /车窗|窗户|开窗|关窗|升窗|降窗/.test(source), targets: null };
  }
  const targets = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const end = groups[index + 1]?.index ?? source.length;
    const segment = source.slice(group.index, end);
    const localPercent = parseWindowPercent(segment);
    const percent = localPercent ?? (groups.length === 1 ? parseWindowPercent(source) : undefined);
    if (percent == null) return { requested: true, grouped: true, targets: null };
    const zones = /前/.test(group[0])
      ? ["front_left", "front_right"]
      : ["rear_left", "rear_right"];
    targets.push(...zones.map((zone) => ({ zone, percent })));
  }
  const unique = new Map(targets.map((target) => [target.zone, target]));
  return { requested: true, grouped: true, targets: [...unique.values()] };
}

function parseWindowZone(text) {
  if (/副驾|右前|前右|前排右|右边前/.test(text)) return "front_right";
  if (/左后|后排左/.test(text)) return "rear_left";
  if (/右后|后排右/.test(text)) return "rear_right";
  if (/后排/.test(text)) return undefined;
  if (/主驾|左前|前左|前排左|左边前/.test(text)) return "front_left";
  return undefined;
}

function parseSeatAngle(text) {
  const degreeMatch = text.match(/(\d{2,3})\s*(?:度|°)/);
  if (degreeMatch) return Number(degreeMatch[1]);
  if (/竖直|直立/.test(text) && /主驾|驾驶位|司机/.test(text)) return 90;
  return undefined;
}

function parseTemperature(text) {
  const match = text.match(/(\d{2})\s*(?:度|°|摄氏度)/);
  if (match) return Number(match[1]);
  return undefined;
}

export function parseClimateControls(text) {
  const source = String(text || "");
  const result = {};
  const temperatureDelta = parseTemperatureDelta(source);
  if (temperatureDelta != null) result.temperatureDelta = temperatureDelta;
  else if (isRelativeTemperatureRequest(source)) return result;
  let temperature = temperatureDelta == null ? parseRequestedTemperature(source) : undefined;
  if (temperature == null && /(?:最低|最冷)/.test(source) && /温度|空调/.test(source)) temperature = 15;
  if (temperature == null && /(?:最高|最热)/.test(source) && /温度|空调/.test(source)) temperature = 31;
  if (temperature != null) result.temperature = temperature;

  if (/关闭.{0,5}空调|关掉.{0,5}空调|关.{0,3}空调/.test(source)) {
    result.climatePower = false;
  } else if (/打开.{0,5}空调|开启.{0,5}空调|开.{0,3}空调/.test(source)) {
    result.climatePower = true;
  }

  if (/制冷/.test(source)) result.climateMode = "cooling";
  else if (/制热|暖风/.test(source)) result.climateMode = "heating";
  else if (/自然风|通风模式/.test(source)) result.climateMode = "ventilation";
  else if (/自动模式|自动空调/.test(source)) result.climateMode = "auto";
  if (result.climateMode && result.climatePower === undefined) result.climatePower = true;

  const explicitFan = source.match(/(?:风速|风量|风力(?:等级)?|风挡)(?:调到|调|设为|到|为)\s*([1-8一二两三四五六七八])\s*(?:挡|档)?|空调(?:调到|调|设为|到|为)?\s*([1-8一二两三四五六七八])\s*(?:挡|档)/u);
  const explicitFanValue = explicitFan?.[1] ?? explicitFan?.[2];
  let fanLevel = explicitFanValue
    ? (/^\d$/u.test(explicitFanValue) ? Number(explicitFanValue) : parseChineseOrArabicInteger(explicitFanValue))
    : undefined;
  if (fanLevel == null && /风速|风量|风力|风挡/.test(source)) {
    if (/最大|最高/.test(source)) fanLevel = 8;
    else if (/最低|最小/.test(source)) fanLevel = 1;
    else if (/一挡|一档/.test(source)) fanLevel = 1;
    else if (/二挡|二档/.test(source)) fanLevel = 2;
    else if (/三挡|三档/.test(source)) fanLevel = 3;
  }
  if (fanLevel != null) {
    result.fanLevel = fanLevel;
    if (result.climatePower === undefined) result.climatePower = fanLevel > 0;
  }
  return result;
}

function isRelativeTemperatureRequest(text) {
  return /(?:温度|空调).{0,16}(?:高点|高一点|再高|低点|低一点|再低|降一降|调高|调低|升高|降低)|(?:再)?(?:调高|升高|提高|调低|降低|低|高)\s*(?:[一二两三四五六七八九十\d]+\s*(?:摄氏度|度|°))/.test(text);
}

function parseTemperatureDelta(text) {
  const source = String(text || "");
  const match = source.match(/(?:再)?(?:调高|升高|提高|高|调低|降低|低)\s*([一二两三四五六七八九十\d]{1,3})\s*(?:摄氏度|度|°)/);
  if (!match) return undefined;
  const magnitude = parseChineseOrArabicInteger(match[1]);
  if (!Number.isInteger(magnitude) || magnitude <= 0 || magnitude > 16) return undefined;
  return /调低|降低|低/.test(match[0]) ? -magnitude : magnitude;
}

function parseChineseOrArabicInteger(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [tensText, onesText = ""] = value.split("十");
    const tens = tensText ? digits[tensText] : 1;
    const ones = onesText ? digits[onesText] : 0;
    return Number.isInteger(tens) && Number.isInteger(ones) ? tens * 10 + ones : NaN;
  }
  return value.length === 1 ? digits[value] : NaN;
}

function parseSeatComfort(text) {
  const source = String(text || "");
  const seatZone = /主驾|司机位|驾驶位/.test(source) ? "driver"
    : /副驾/.test(source) ? "passenger"
      : /三排.{0,5}(?:左|右)|(?:左|右).{0,5}三排/.test(source)
        ? (/(?:左|左侧).{0,6}三排|三排.{0,6}左/.test(source) ? "row3_left" : "row3_right")
        : /二排.{0,5}(?:左|右)|(?:左|右).{0,5}二排/.test(source)
          ? (/(?:左|左侧).{0,6}二排|二排.{0,6}左/.test(source) ? "row2_left" : "row2_right")
          : undefined;
  const seatMode = /加热/.test(source) ? "heat" : /通风/.test(source) ? "ventilation" : undefined;
  let level = /关闭|关掉/.test(source) ? 0 : undefined;
  if (level == null) {
    const numericLevel = source.match(/([0-3])\s*(?:挡|档)/);
    if (numericLevel) level = Number(numericLevel[1]);
    else if (/最大|最高|最强|三挡|三档/.test(source)) level = 3;
    else if (/二挡|二档|中挡|中档/.test(source)) level = 2;
    else if (/一挡|一档|最小|最低/.test(source)) level = 1;
  }
  return {
    ...(seatZone ? { seatZone } : {}),
    ...(seatMode ? { seatMode } : {}),
    ...(level != null ? { level } : {}),
  };
}

function parseRequestedTemperature(text) {
  const source = String(text || "");
  const contextValue = source.match(/温度\s*(?:调到|调至|调成|调为|设成|设为|设置)\s*([零〇一二两三四五六七八九十]{1,3})/u);
  if (contextValue) return parseChineseOrArabicInteger(contextValue[1]);
  const match = source.match(/(-?\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:度|°|摄氏度)/u);
  if (!match) return parseTemperature(text);
  return /^-?\d+$/u.test(match[1]) ? Number(match[1]) : parseChineseOrArabicInteger(match[1]);
}

function parseCentimeters(text) {
  const match = String(text || "").match(/(-?\d+(?:\.\d+)?)\s*(?:cm|厘米)/i);
  return match ? Number(match[1]) : undefined;
}

function parseDegrees(text) {
  const match = String(text || "").match(/(-?\d+(?:\.\d+)?)\s*(?:度|°)/);
  return match ? Number(match[1]) : undefined;
}

function binaryTarget(text, { inverted = false } = {}) {
  const off = /关闭|关上|合上|收起|停止|停下|复位|回位|展开/.test(text);
  const on = /打开|开启|弹出|启动|运行|转动|滚动|折叠/.test(text);
  if (!off && !on) return undefined;
  const value = off ? 0 : 1;
  return inverted ? 1 - value : value;
}

function es7ComponentText(text) {
  return /车门|左前门|右前门|左后门|右后门|门把手|前舱盖|前盖|引擎盖|充电口|后视镜|雨刷|雨刮|悬架|车身高度|车身.{0,4}(?:升高|降低)|前轮|车轮|轮胎|头枕|主驾.{0,8}(?:前移|后移|向前|向后|前后|升高|降低|高度)/.test(text);
}

function parseEs7ComponentAction(text) {
  const source = String(text || "");
  let actionId;
  let value;

  const handle = source.match(/(左前|右前|左后|右后|主驾|副驾)(?:车)?门把手/);
  if (handle) {
    const prefix = { 左前: "front_left", 主驾: "front_left", 右前: "front_right", 副驾: "front_right", 左后: "rear_left", 右后: "rear_right" }[handle[1]];
    actionId = `${prefix}_handle_deploy`;
    value = /收起|关闭|复位|回位/.test(source) ? 0 : /弹出|打开|开启|展开/.test(source) ? 1 : undefined;
  } else {
    const door = source.match(/(左前|右前|左后|右后|主驾|副驾)(?:侧)?(?:车)?门/);
    if (door) {
      const prefix = { 左前: "front_left", 主驾: "front_left", 右前: "front_right", 副驾: "front_right", 左后: "rear_left", 右后: "rear_right" }[door[1]];
      actionId = `${prefix}_door_open`;
      value = binaryTarget(source);
    }
  }

  if (!actionId && /前舱盖|前盖|引擎盖/.test(source)) {
    actionId = "hood_open";
    value = binaryTarget(source);
  }
  if (!actionId && /充电口/.test(source)) {
    actionId = "charge_port_open";
    value = binaryTarget(source);
  }
  if (!actionId && /后视镜/.test(source)) {
    actionId = /两个|双侧|左右/.test(source)
      ? "mirrors_fold_both"
      : /左/.test(source) ? "mirror_left_fold" : /右/.test(source) ? "mirror_right_fold" : undefined;
    value = /折叠|收起/.test(source) ? 1 : /展开|打开|开启|复位/.test(source) ? 0 : undefined;
  }
  if (!actionId && /雨刷|雨刮/.test(source)) {
    actionId = "wipers_sweep";
    value = binaryTarget(source);
  }
  if (!actionId && /悬架|车身高度|车身.{0,4}(?:升高|降低)/.test(source)) {
    actionId = "suspension_raise";
    value = /复位|降低到底/.test(source) ? 0 : parseCentimeters(source);
  }
  if (!actionId && /前轮/.test(source) && /转向|左转|右转|回正|复位/.test(source)) {
    actionId = "front_wheels_steer";
    const degrees = parseDegrees(source);
    value = /回正|复位/.test(source) ? 0 : degrees == null ? undefined : /左/.test(source) ? -Math.abs(degrees) : Math.abs(degrees);
  }
  if (!actionId && /车轮|轮胎/.test(source) && /转动|滚动|停止|复位/.test(source)) {
    actionId = "wheels_roll";
    value = binaryTarget(source);
  }
  if (!actionId && /头枕/.test(source)) {
    actionId = "driver_seat_headrest_height";
    value = /复位|降到底/.test(source) ? 0 : parseCentimeters(source);
  }
  if (!actionId && /主驾/.test(source) && /前移|后移|向前|向后|前后/.test(source)) {
    actionId = "driver_seat_fore_aft";
    const centimeters = parseCentimeters(source);
    value = /复位|回位/.test(source) ? 0 : centimeters == null ? undefined : /后移|向后/.test(source) ? -Math.abs(centimeters) : Math.abs(centimeters);
  }
  if (!actionId && /主驾/.test(source) && /座椅高度|主驾高度|升高|降低/.test(source)) {
    actionId = "driver_seat_height";
    value = /复位|降到底/.test(source) ? 0 : parseCentimeters(source);
  }

  return explicitSlotCandidate({
    ...(actionId ? { actionId } : {}),
    ...(value != null ? { value } : {}),
  });
}

function explicitSlotCandidate(slots) {
  return {
    slots,
    slotProvenance: Object.fromEntries(Object.keys(slots).map((key) => [key, "explicit"])),
  };
}

function getCompoundRequiredSlotAudits(text, domainIds) {
  if (isVehicleKnowledgeQuestion(text)) return [];
  return COMPOUND_EXECUTABLE_DOMAIN_INTENTS.flatMap(([domainId, intent]) => {
    if (!domainIds.includes(domainId)) return [];
    return compoundDomainClauseContexts(text, domainId).flatMap(({ localText, sharedPredicateText }) => {
      const localAction = classifySpeechAct(localText, intent);
      const sharedAction = sharedPredicateText === localText
        ? localAction
        : classifySpeechAct(sharedPredicateText, intent);
      const hasIntentAttempt = COMPOUND_INCOMPLETE_ATTEMPT_PATTERN.test(localText);
      if (localAction.actionability?.actionable !== true
        && sharedAction.actionability?.actionable !== true
        && !hasIntentAttempt) return [];
      const candidate = parseExecutableIntentSlots(intent, localText, sharedPredicateText);
      const missingRequiredSlots = getMissingRequiredSlots(intent, candidate.slots, candidate.slotProvenance);
      return missingRequiredSlots.length > 0 ? [{ intent, missingRequiredSlots }] : [];
    });
  });
}

function compoundPredicateScopes(clause) {
  const text = String(clause || "");
  const scopes = [];
  let start = 0;
  for (const match of text.matchAll(BARE_AND_PREDICATE_SCOPE_PATTERN)) {
    const value = text.slice(start, match.index).trim();
    if (value) scopes.push(value);
    start = match.index + match[0].length;
  }
  const tail = text.slice(start).trim();
  if (tail) scopes.push(tail);
  return scopes.length > 0 ? scopes : [text];
}

function compoundDomainClauseContexts(text, domainId) {
  const domainPattern = COMPOUND_DOMAIN_PATTERNS.find(([id]) => id === domainId)?.[1];
  if (!domainPattern) return [];
  return String(text || "")
    .split(INDEPENDENT_CLAUSE_BOUNDARY_PATTERN)
    .flatMap((clause) => compoundPredicateScopes(clause.trim()))
    .filter((scope) => scope && domainPattern.test(scope))
    .map((scope) => {
      const localText = compoundDomainLocalText(scope, domainId);
      return {
        localText,
        sharedPredicateText: hasParallelDomainStructure(scope, domainId) ? scope : localText,
      };
    });
}

function compoundDomainLocalText(clause, domainId) {
  const matches = COMPOUND_DOMAIN_PATTERNS
    .map(([id, pattern]) => {
      const match = clause.match(pattern);
      return match ? { id, start: match.index, end: match.index + match[0].length } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  const index = matches.findIndex((match) => match.id === domainId);
  if (index < 0 || matches.length === 1) return clause;
  const start = index === 0 ? 0 : matches[index - 1].end;
  const end = index === matches.length - 1 ? clause.length : matches[index + 1].start;
  return clause.slice(start, end).trim();
}

function hasParallelDomainStructure(clause, domainId) {
  const matches = COMPOUND_DOMAIN_PATTERNS
    .map(([id, pattern]) => {
      const match = clause.match(pattern);
      return match ? { id, start: match.index, end: match.index + match[0].length } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  return matches.some((match, index) => {
    const next = matches[index + 1];
    if (!next || (match.id !== domainId && next.id !== domainId)) return false;
    const between = clause.slice(match.end, next.start).trim();
    return /^(?:(?:一半|半开|半|\d{1,3}\s*%|[一二三四五六七八九]成)\s*)?(?:和|与|跟)$/.test(between)
      || /^(?:(?:一半|半开|半|\d{1,3}\s*%|[一二三四五六七八九]成)\s*)?并(?:打开|开启|关闭|关上)?$/.test(between);
  });
}

function parseExecutableIntentSlots(intent, slotText, actionText = slotText) {
  if (intent === "body.window.setPosition") {
    const zone = parseWindowZone(slotText);
    const localPercent = parseWindowPercent(slotText);
    const sharedPercent = localPercent == null ? parseWindowPercent(actionText) : undefined;
    const percent = localPercent ?? ([0, 100].includes(sharedPercent) ? sharedPercent : undefined);
    return explicitSlotCandidate({
      ...(zone ? { zone } : {}),
      ...(percent != null ? { percent } : {}),
    });
  }
  if (intent === "body.tailgate.open") {
    const actionPattern = /打开|开启|开一下|关闭|关上|合上|收起/;
    const actionSource = actionPattern.test(slotText) ? slotText : actionText;
    const hasOpenAction = actionPattern.test(actionSource);
    return explicitSlotCandidate({
      ...(hasOpenAction ? { open: !/关闭|关上|合上|收起/.test(actionSource) } : {}),
    });
  }
  if (intent === "seat.driver.setBackrestAngle") {
    const seat = /主驾|驾驶位|司机/.test(slotText) ? "driver" : undefined;
    const angle = parseSeatAngle(slotText);
    return explicitSlotCandidate({
      ...(seat ? { seat } : {}),
      ...(angle != null ? { angle } : {}),
    });
  }
  if (intent === "seat.comfort.setLevel") {
    return explicitSlotCandidate(parseSeatComfort(slotText));
  }
  if (intent === "cabin.comfort.applySettings") {
    const windows = parseWindowTargets(slotText);
    const climate = parseClimateControls(slotText);
    return explicitSlotCandidate({
      ...(windows.targets?.length ? { windowTargets: windows.targets } : {}),
      ...climate,
    });
  }
  if (intent === "vehicle.component.setState") return parseEs7ComponentAction(slotText);
  if (intent === "cabin.climate.setPreset") {
    const controls = parseClimateControls(slotText);
    const hasExplicitRearSoftAirflow = /后排|孩子|儿童|柔风/.test(slotText);
    const hasExplicitChildPassengerMode = /孩子|儿童/.test(slotText);
    return explicitSlotCandidate({
      ...controls,
      ...(hasExplicitRearSoftAirflow ? { airflow: "rear_soft" } : {}),
      ...(hasExplicitChildPassengerMode ? { passengerMode: "child_comfort" } : {}),
    });
  }
  if (intent === "navigation.planRoute") {
    const destination = pickDestination(slotText);
    return explicitSlotCandidate({
      ...(/上海出发|从上海/.test(slotText) ? { origin: "上海" } : {}),
      ...(destination ? { destination } : {}),
      ...(/换电优先|优先换电|换电/.test(slotText) ? { energyPolicy: "swap_first" } : {}),
    });
  }
  if (intent === "energy.findSwapStation") {
    const destination = pickDestination(slotText);
    return explicitSlotCandidate({
      ...(destination ? { destination } : {}),
      ...(/低|焦虑|够到/.test(slotText) ? { minArrivalSoc: 15 } : {}),
    });
  }
  return { slots: {}, slotProvenance: {} };
}

function compoundRequiredSlotClarification(missingRequiredSlots) {
  const labels = {
    zone: "要调节哪一扇车窗",
    percent: "车窗要调到多少开度",
    open: "要打开还是关闭尾门",
    seat: "要调节哪个座椅",
    angle: "靠背要调到多少度",
    seatZone: "要调节哪个座位",
    seatMode: "座椅要开启加热还是通风",
    level: "座椅舒适功能要调到几挡",
    temperature: "空调要调到多少度",
    windowTargets: "每扇车窗要调到多少开度",
    climatePower: "空调要开启还是关闭",
    climateMode: "空调要使用什么模式",
    fanLevel: "空调风量要调到几挡",
    origin: "从哪里出发",
    destination: "目的地是哪里",
  };
  return `请说明${missingRequiredSlots.map((slot) => labels[slot] || slot).join("、")}。`;
}

export function hasClimateContext(options = {}) {
  return options.lastVehicleIntent === "cabin.climate.setPreset" || options.lastIntent === "cabin.climate.setPreset";
}

export function isWeatherClimateAdviceQuestion(text) {
  return /天气|气温|室外|外面|今天|当前|现在|冷不冷|热不热/.test(text)
    && /空调|温度/.test(text)
    && /适合|建议|应该|开几度|多少度|几度|调几度|设多少|设置多少|开多少/.test(text)
    && !/打开|开启|关闭|关掉|调到|调至|设为|设置为|升到|降到|调成|开到/.test(text);
}

function isOpenConversation(text) {
  if (isWeatherQueryText(text)) return true;
  if (isWeatherClimateAdviceQuestion(text)) return true;
  const hasVehicleDomain = /车窗|窗户|开窗|关窗|升窗|降窗|主驾窗|副驾窗|后备箱|尾门|行李箱|后舱|座椅|靠背|后仰|前倾|腰托|坐姿|空调|温度|座舱|风量|电量|换电站|充电|续航|补能|路线|导航|安全提醒|碰撞提醒|车道提醒|疲劳提醒|蔚来|NIO|ES8|NOMI|中控屏|屏幕|HUD|后排控制屏|香氛|空气质量|儿童锁|防夹|儿童监测|CLTC|电池/.test(text);
  if (hasVehicleDomain && !isVehicleKnowledgeQuestion(text)) return false;
  return /天气|下雨|气温|温度|冷不冷|热不热|空气质量|吃|喝|餐厅|美食|麻辣烫|火锅|咖啡|推荐|聊|聊天|陪我|你好|您好|问一下|为什么|怎么|如何|介绍|建议|讲讲|附近有什么|想知道/.test(text);
}

function isCabinAirQualityQuestion(text) {
  return /空气质量/.test(text) && /车内|座舱|车里|车上|ES8|蔚来|NIO|空调|香氛/.test(text);
}

export function isVehicleKnowledgeQuestion(text) {
  if (/空气质量/.test(text) && !isCabinAirQualityQuestion(text)) return false;
  if (/开车|用车|坐车|堵车|打车/.test(text) && !/这辆车|蔚来|NIO|(?:ES|ET|EC|EL|EP)\s*[- ]?\d{1,2}|NOMI|座舱|中控屏|屏幕|HUD|后排控制屏|后备箱|尾门|座椅|靠背|车窗|空调|香氛|儿童|儿童锁|防夹|儿童监测|续航|CLTC|电池/.test(text)) return false;
  const hasVehicleContext = /车|这辆车|蔚来|NIO|(?:ES|ET|EC|EL|EP)\s*[- ]?\d{1,2}|NOMI|座舱|中控屏|屏幕|HUD|后排控制屏|后备箱|尾门|座椅|靠背|车窗|空调|香氛|空气质量|儿童|儿童锁|防夹|儿童监测|续航|CLTC|电池/.test(text);
  const hasSeatModeGuidanceCue = /座椅模式|一键成床|成床|全车大床|零重力/.test(text);
  const hasKnowledgeCue = hasSeatModeGuidanceCue
    || /怎么|如何|在哪|哪里|介绍|说明|教程|使用|操作|多大|多少|是什么|怎么样|有什么|确认什么条件|满足什么条件|能不能|是否可以|为什么不能/.test(text);
  return hasVehicleContext && hasKnowledgeCue;
}

function isWebSearchQuestion(text) {
  return /联网|上网|网页|网上|搜索|查一下|帮我查|查查|搜一下|新闻|最新|现在的|当前的|今年|政策|价格|报价|销量|排名|官网|发布|更新/.test(text);
}

export function classifyConversationTopic(text) {
  if (isVehicleKnowledgeQuestion(text)) return "vehicle_knowledge";
  if (isWeatherQueryText(text)) return "weather_query";
  if (/吃|喝|餐厅|美食|麻辣烫|火锅|咖啡|奶茶|推荐/.test(text)) return "food_recommendation";
  if (isWebSearchQuestion(text)) return "web_search";
  if (/你好|您好|嗨|聊|聊天|陪我|讲个|随便聊/.test(text)) return "smalltalk";
  return "general_qa";
}

export function isWeatherQueryText(text) {
  const value = String(text || "");
  if (/天气|下雨|气温|冷不冷|热不热|空气质量|雾霾|预警|体感温度/.test(value)) return true;
  return /今天|明天|后天|当前|现在/.test(value)
    && /带伞|雨具|穿衣|衣服|穿什么|怎么穿|体感.{0,4}(?:热|冷)|适合.{0,6}(?:出行|出门|运动|跑步|骑车|洗车|散步|旅游|游玩|露营)/.test(value);
}

export function buildConversationSlots(text) {
  const topic = classifyConversationTopic(text);
  const requiresExternalData = topic === "weather_query" || topic === "web_search" || (topic === "food_recommendation" && /附近|周边|离我|推荐|店|餐厅/.test(text));
  const externalDataType = topic === "weather_query" ? "weather" : topic === "web_search" ? "web-search" : requiresExternalData ? "poi" : undefined;
  return {
    topic,
    responseMode: "voice_text",
    requiresPoi: externalDataType === "poi",
    requiresExternalData,
    ...(externalDataType ? { externalDataType } : {}),
    disclaimer:
      externalDataType === "weather"
        ? "天气类问题会尝试通过天气 adapter 获取实时数据；未取到时必须说明能力边界。"
        : externalDataType === "poi"
          ? "未接入真实地图、POI、定位、评分或营业状态。"
          : externalDataType === "web-search"
            ? "未接入云端联网搜索、网页抓取或引用来源。"
          : topic === "vehicle_knowledge"
            ? "已接入 ES8 用户手册检索；未接入其他车型知识或真实车辆服务。"
            : "未接入地图、POI 或实时外部数据；车辆知识范围为 ES8 用户手册。",
  };
}

export function parseCommandWithSemanticPolicy(rawText, options = {}) {
  const text = String(rawText || "").trim();
  const requestId = options.requestId || createRequestId();
  const base = {
    requestId,
    rawText: text,
    confidence: SEMANTIC_CONFIDENCE_POLICY.values.ruleBase,
    source: "rule-parser",
  };

  let parsed;

  const compound = classifyCompoundOrConflictingInput(text);
  const groupedWindows = parseWindowTargets(text);
  const climateCue = /空调|温度|风量|风速|风力|风挡|制冷|制热|自然风|通风模式/.test(text);
  const isCabinSettingsCommand = groupedWindows.requested
    && (groupedWindows.grouped || groupedWindows.targets?.length > 1 || climateCue);
  const unsupportedSafetyControl = /车道辅助|车道保持|车道偏离|自适应巡航|碰撞预警|安全带提醒|稳定系统|泊车辅助|盲区监测|跟车距离/.test(text)
    && /打开|开启|关闭|关掉|禁用|设置|设为|设成|调到|调成|调为|切换|选择|仅警示|警示模式/.test(text)
    && !isVehicleKnowledgeQuestion(text);
  if (unsupportedSafetyControl) {
    parsed = {
      ...base,
      intent: "safety.reject",
      confidence: SEMANTIC_CONFIDENCE_POLICY.values.safetyReject,
      slots: {
        reason: "当前演示不执行驾驶辅助或安全提醒开关。",
        alternative: "我可以依据 ES8 用户手册说明功能，并引导你到车机设置页自行查看。",
      },
    };
  } else if (/锁好|锁上|锁止/.test(text) && /尾箱|尾门|后备箱|车门/.test(text)) {
    parsed = {
      ...base,
      intent: "safety.reject",
      confidence: SEMANTIC_CONFIDENCE_POLICY.values.safetyReject,
      slots: {
        reason: "当前演示未接入车门或尾门锁止控制。",
        alternative: "请使用车辆实体按键、钥匙或车机锁车功能完成锁止。",
      },
    };
  } else if (/设置页|设置页面|设置界面/.test(text) && climateCue) {
    parsed = {
      ...base,
      intent: "conversation.general",
      confidence: SEMANTIC_CONFIDENCE_POLICY.values.bareDegreeClarification,
      slots: {
        ...buildConversationSlots(text),
        needsClarification: true,
        requestedIntent: "cabin.climate.setPreset",
        missingRequiredSlots: ["control"],
        clarification: "你是想切换空调自然风，还是打开车机空调设置页面？当前演示还没有接入页面跳转。",
      },
    };
  } else if (/驻车舒享|驻车舒适/.test(text) && /空调|打开|开启|设置/.test(text)) {
    parsed = {
      ...base,
      intent: "conversation.general",
      confidence: SEMANTIC_CONFIDENCE_POLICY.values.bareDegreeClarification,
      slots: {
        ...buildConversationSlots(text),
        needsClarification: true,
        requestedIntent: "cabin.climate.setPreset",
        missingRequiredSlots: ["control"],
        clarification: "当前演示未接入驻车舒享控制。你是否仍要单独开启空调？",
      },
    };
  } else if (isCabinSettingsCommand) {
    const climateControls = climateCue ? parseClimateControls(text) : {};
    const relativeTemperature = isRelativeTemperatureRequest(text);
    const temperatureDelta = parseTemperatureDelta(text);
    const missing = [
      ...(groupedWindows.targets?.length ? [] : ["windowTargets"]),
      ...(relativeTemperature && temperatureDelta == null ? ["temperature"] : climateCue && Object.keys(climateControls).length === 0 ? ["control"] : []),
    ];
    if (missing.length) {
      parsed = {
        ...base,
        intent: "conversation.general",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.bareDegreeClarification,
        slots: {
          topic: "general_qa",
          responseMode: "voice_text",
          requiresPoi: false,
          requiresExternalData: false,
          needsClarification: true,
          requestedIntent: "cabin.comfort.applySettings",
          missingRequiredSlots: missing,
          clarification: missing.includes("windowTargets")
            ? relativeTemperature
              ? "请告诉我每扇车窗的目标开度，以及空调要设定到多少摄氏度；我会在确认完整目标后再执行。"
              : "请告诉我每扇车窗要调到多少开度；我会在确认完整目标后再执行。"
            : relativeTemperature && temperatureDelta == null
              ? "请告诉我空调要设定到多少摄氏度；我不会把“高一点”或“低一点”猜成固定温度。"
              : "请说明空调要设置的具体目标；我会在确认完整目标后再执行。",
        },
      };
    } else {
      parsed = {
        ...base,
        intent: "cabin.comfort.applySettings",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.climateCommand,
        slots: {
          ...(groupedWindows.targets?.length ? { windowTargets: groupedWindows.targets } : {}),
          ...climateControls,
        },
        slotProvenance: Object.fromEntries([
          ...(groupedWindows.targets?.length ? ["windowTargets"] : []),
          ...Object.keys(climateControls),
        ].map((key) => [key, "explicit"])),
      };
    }
  } else if (compound.hasIndependentClarification) {
    const requiredSlotAudits = getCompoundRequiredSlotAudits(text, compound.domainIds);
    parsed = {
      ...base,
      intent: "conversation.general",
      confidence: SEMANTIC_CONFIDENCE_POLICY.values.bareDegreeClarification,
      slots: {
        topic: "general_qa",
        responseMode: "voice_text",
        requiresPoi: false,
        requiresExternalData: false,
        needsClarification: true,
        clarification: compoundRequiredSlotClarification(compound.missingRequiredSlots),
        ...(requiredSlotAudits.length === 1 ? { requestedIntent: requiredSlotAudits[0].intent } : {}),
        missingRequiredSlots: [...compound.missingRequiredSlots],
      },
    };
  } else if (isBareDegreeAdjustment(text)) {
    if (hasClimateContext(options)) {
      parsed = {
        ...base,
        intent: "cabin.climate.setPreset",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.bareDegreeWithClimateContext,
        slots: {
          temperature: parseRequestedTemperature(text),
        },
        slotProvenance: { temperature: "explicit" },
      };
    } else {
      parsed = {
        ...base,
        intent: "conversation.general",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.bareDegreeClarification,
        slots: {
          topic: "general_qa",
          responseMode: "voice_text",
          requiresPoi: false,
          requiresExternalData: false,
          needsClarification: true,
          clarification: "请说明要调节空调温度还是座椅靠背。",
        },
      };
    }
  } else if (/关闭.*安全|安全提醒|碰撞提醒|车道提醒|疲劳提醒/.test(text) && /关闭|关掉|禁用|取消/.test(text)) {
    parsed = {
      ...base,
      intent: "safety.reject",
      confidence: SEMANTIC_CONFIDENCE_POLICY.values.safetyReject,
      slots: {
        reason: /行驶中/.test(text) ? "行驶中不能关闭全部安全提醒。" : "关键安全提醒不能被完全关闭。",
        alternative: "可将普通提示音量降至 40%，但保留碰撞、车道和疲劳提醒。",
      },
    };
  } else if (es7ComponentText(text)) {
    if (isVehicleKnowledgeQuestion(text)) {
      parsed = {
        ...base,
        intent: "conversation.general",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.vehicleKnowledgeQuestion,
        slots: buildConversationSlots(text),
      };
    } else {
      const candidate = parseExecutableIntentSlots("vehicle.component.setState", text);
      parsed = {
        ...base,
        intent: "vehicle.component.setState",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.ruleBase,
        slots: candidate.slots,
        slotProvenance: candidate.slotProvenance,
      };
    }
  } else if (/车窗|窗户|开窗|关窗|升窗|降窗|主驾窗|副驾窗|左前窗|右前窗|左后窗|右后窗/.test(text)) {
    if (isVehicleKnowledgeQuestion(text)) {
      parsed = {
        ...base,
        intent: "conversation.general",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.vehicleKnowledgeQuestion,
        slots: buildConversationSlots(text),
      };
    } else {
      const candidate = parseExecutableIntentSlots("body.window.setPosition", text);
      parsed = {
        ...base,
        intent: "body.window.setPosition",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.windowCommand,
        slots: candidate.slots,
        slotProvenance: candidate.slotProvenance,
      };
    }
  } else if (/后备箱|尾门|行李箱|后舱/.test(text)) {
    if (isVehicleKnowledgeQuestion(text)) {
      parsed = {
        ...base,
        intent: "conversation.general",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.vehicleKnowledgeQuestion,
        slots: buildConversationSlots(text),
      };
    } else {
      const candidate = parseExecutableIntentSlots("body.tailgate.open", text);
      parsed = {
        ...base,
        intent: "body.tailgate.open",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.tailgateCommand,
        slots: candidate.slots,
        slotProvenance: candidate.slotProvenance,
      };
    }
  } else if (/座椅|座位|靠背|后仰|前倾|腰托|坐姿/.test(text) && /加热|通风/.test(text)) {
    const candidate = parseExecutableIntentSlots("seat.comfort.setLevel", text);
    parsed = {
      ...base,
      intent: "seat.comfort.setLevel",
      confidence: SEMANTIC_CONFIDENCE_POLICY.values.seatCommand,
      slots: candidate.slots,
      slotProvenance: candidate.slotProvenance,
    };
  } else if (/座椅|靠背|后仰|前倾|腰托|坐姿/.test(text)) {
    if (isVehicleKnowledgeQuestion(text)) {
      parsed = {
        ...base,
        intent: "conversation.general",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.vehicleKnowledgeQuestion,
        slots: buildConversationSlots(text),
      };
    } else {
      const candidate = parseExecutableIntentSlots("seat.driver.setBackrestAngle", text);
      parsed = {
        ...base,
        intent: "seat.driver.setBackrestAngle",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.seatCommand,
        slots: candidate.slots,
        slotProvenance: candidate.slotProvenance,
      };
    }
  } else if (/空调|温度|座舱|舒适模式|风量|风速|风力|风挡|自然风|通风模式|制冷|制热|后排|孩子|儿童/.test(text)) {
    if (isRelativeTemperatureRequest(text)) {
      parsed = {
        ...base,
        intent: "conversation.general",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.bareDegreeClarification,
        slots: {
          ...buildConversationSlots(text),
          needsClarification: true,
          requestedIntent: "cabin.climate.setPreset",
          missingRequiredSlots: ["temperature"],
          clarification: "请告诉我希望空调设定到多少摄氏度；我不会把“高一点”或“低一点”猜成固定温度。",
        },
      };
    } else if (isWeatherClimateAdviceQuestion(text) || isVehicleKnowledgeQuestion(text)) {
      parsed = {
        ...base,
        intent: "conversation.general",
        confidence: isWeatherClimateAdviceQuestion(text)
          ? SEMANTIC_CONFIDENCE_POLICY.values.weatherClimateAdviceQuestion
          : SEMANTIC_CONFIDENCE_POLICY.values.vehicleKnowledgeQuestion,
        slots: buildConversationSlots(text),
      };
    } else {
      const candidate = parseExecutableIntentSlots("cabin.climate.setPreset", text);
      parsed = {
        ...base,
        intent: "cabin.climate.setPreset",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.climateCommand,
        slots: candidate.slots,
        slotProvenance: candidate.slotProvenance,
      };
    }
  } else if (/电量|够到|换电站|充电|续航|补能/.test(text)) {
    if (isVehicleKnowledgeQuestion(text)) {
      parsed = {
        ...base,
        intent: "conversation.general",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.vehicleKnowledgeQuestion,
        slots: buildConversationSlots(text),
      };
    } else {
      const candidate = parseExecutableIntentSlots("energy.findSwapStation", text);
      parsed = {
        ...base,
        intent: "energy.findSwapStation",
        confidence: SEMANTIC_CONFIDENCE_POLICY.values.energyCommand,
        slots: candidate.slots,
        slotProvenance: candidate.slotProvenance,
      };
    }
  } else if (isOpenConversation(text)) {
    parsed = {
      ...base,
      intent: "conversation.general",
      confidence: SEMANTIC_CONFIDENCE_POLICY.values.openConversation,
      slots: buildConversationSlots(text),
    };
  } else if (/路线|导航|规划|去|到|高速|明天/.test(text)) {
    const candidate = parseExecutableIntentSlots("navigation.planRoute", text);
    parsed = {
      ...base,
      intent: "navigation.planRoute",
      confidence: SEMANTIC_CONFIDENCE_POLICY.values.navigationCommand,
      slots: candidate.slots,
      slotProvenance: candidate.slotProvenance,
    };
  } else {
    parsed = {
      ...base,
      intent: "conversation.general",
      confidence: SEMANTIC_CONFIDENCE_POLICY.values.fallbackConversation,
      slots: buildConversationSlots(text),
    };
  }

  const command = normalizeParsedCommand(parsed, base);
  return attachSemanticPolicyAudit(command);
}

export function evaluateSemanticFastPath(parsed, rawText = parsed?.rawText, options = {}) {
  const text = String(rawText || "");
  const compound = classifyCompoundOrConflictingInput(text);
  if (compound.isCompoundOrConflicting) {
    return { decision: "model-required", fastPathEligible: false, reason: "compound-or-conflicting-input" };
  }
  if (parsed?.slots?.needsClarification === true) {
    return { decision: "clarification", fastPathEligible: true, reason: "explicit-required-slot-clarification" };
  }
  if (parsed?.intent === "conversation.general" && parsed?.slots?.requestedIntent
      && (parsed?.speechAct !== "command" || parsed?.actionability?.actionable !== true)) {
    return { decision: "non-actionable-guard", fastPathEligible: true, reason: "speech-act-actionability-guard" };
  }
  if (parsed?.intent === "body.window.setPosition") {
    const provenance = parsed.slotProvenance || {};
    const complete = Boolean(parsed.slots?.zone) && Number.isFinite(Number(parsed.slots?.percent))
      && provenance.zone !== "unknown" && provenance.percent !== "unknown";
    return complete
      ? { decision: "vehicle-command", fastPathEligible: true, reason: "explicit-complete-window-command" }
      : { decision: "model-required", fastPathEligible: false, reason: "window-command-not-explicit-complete" };
  }
  if (parsed?.intent === "vehicle.component.setState") {
    const provenance = parsed.slotProvenance || {};
    const complete = typeof parsed.slots?.actionId === "string" && Number.isFinite(Number(parsed.slots?.value))
      && provenance.actionId !== "unknown" && provenance.value !== "unknown";
    return complete
      ? { decision: "vehicle-command", fastPathEligible: true, reason: "explicit-complete-component-command" }
      : { decision: "model-required", fastPathEligible: false, reason: "component-command-not-explicit-complete" };
  }
  if (parsed?.intent === "conversation.general" && parsed?.slots?.requiresExternalData === true) {
    if (/(?:车窗|窗户|尾门|后备箱|座椅|靠背|空调|导航|路线|换电|充电).*(?:打开|开启|关闭|调到|设置|导航|去|找)|(?:打开|开启|关闭|调到|设置|导航|去|找).*(?:车窗|窗户|尾门|后备箱|座椅|靠背|空调|换电|充电)/.test(String(rawText || ""))) {
      return { decision: "model-required", fastPathEligible: false, reason: "external-query-conflicts-with-action-language" };
    }
    return { decision: "external-readonly", fastPathEligible: true, reason: `readonly-external-${parsed.externalDataType || parsed.slots.externalDataType || "data"}` };
  }
  return {
    decision: "model-required",
    fastPathEligible: false,
    reason: options.endpointAvailable === false ? "endpoint-unavailable" : "general-or-ambiguous-requires-model",
  };
}

export function normalizeSemanticCandidateWithPolicy(candidate, rawText, options = {}) {
  const fallback = options.ruleFallback || parseCommandWithSemanticPolicy(rawText, options);
  const eligibility = evaluateSemanticFastPath(fallback, rawText, options);
  const compoundExecutionBlocked = eligibility.reason === "compound-or-conflicting-input"
    && isVehicleIntent(candidate?.intent);
  const guardedCandidate = compoundExecutionBlocked
    ? {
        ...candidate,
        intent: "conversation.general",
        slots: {
          topic: "general_qa",
          responseMode: "voice_text",
          requiresExternalData: false,
          needsClarification: true,
          clarification: "当前一次只能确认一个动作，请拆分后分别说明。",
          requestedIntent: candidate.intent,
          requestedSlots: candidate.slots || {},
        },
        intentNormalization: {
          applied: true,
          source: "semantic-policy-compound-guard",
          from: candidate.intent,
          to: "conversation.general",
          reason: eligibility.reason,
        },
      }
    : candidate;
  const normalized = normalizeParsedCommand({
    ...guardedCandidate,
    requestId: options.requestId || candidate?.requestId || fallback.requestId,
    rawText: String(rawText || "").trim(),
    source: options.source || candidate?.source || "local-model",
  }, fallback);
  return attachSemanticPolicyAudit(normalized, {
    decision: compoundExecutionBlocked ? "compound-execution-blocked" : options.decision || "model-normalized",
    fastPathEligible: false,
    reason: compoundExecutionBlocked ? "compound-or-conflicting-model-execution-blocked" : options.reason || "model-result-normalized-by-semantic-policy",
  });
}

export function attachSemanticPolicyAudit(command, audit = {}) {
  const eligibility = evaluateSemanticFastPath(command, command?.rawText, audit.options || {});
  const decision = audit.decision || eligibility.decision;
  const fastPathEligible = audit.fastPathEligible ?? eligibility.fastPathEligible;
  const reason = audit.reason || eligibility.reason;
  const auditedCommand = {
    ...command,
    semanticPolicy: {
      ...command?.semanticPolicy,
      decision,
      fastPathEligible,
      reason,
    },
  };
  return {
    ...command,
    semanticPolicy: {
      ...SEMANTIC_POLICY,
      confidencePolicy: {
        version: SEMANTIC_CONFIDENCE_POLICY.version,
        calibration: SEMANTIC_CONFIDENCE_POLICY.calibration.status,
      },
      matchStrength: buildSemanticMatchStrength(auditedCommand),
      decision,
      fastPathEligible,
      reason,
    },
  };
}

function buildSemanticMatchStrength(command = {}) {
  const policy = SEMANTIC_CONFIDENCE_POLICY.matchStrengthPolicy;
  const semanticPolicy = command.semanticPolicy || {};
  const decision = semanticPolicy.decision || "unknown";
  const intent = command.intent || "conversation.general";
  const speechAct = command.speechAct || "unknown";
  const actionability = command.actionability || {};
  const provenanceItems = [
    `decision:${decision}`,
    command.source ? `source:${command.source}` : "",
    `intent:${intent}`,
    `speechAct:${speechAct}`,
    actionability.actionable === true ? "actionable" : actionability.actionable === false ? "non-actionable" : "",
    semanticPolicy.fastPathEligible === true ? "fast-path-eligible" : "model-or-nonfast-path",
  ];
  if (isVehicleIntent(intent) || intent === "safety.reject") provenanceItems.push("vehicle-intent");
  if (command.slots?.needsClarification === true) provenanceItems.push("clarification");
  if (command.slots?.requiresExternalData === true || command.requiresExternalData === true) {
    provenanceItems.push(`external-data:${command.externalDataType || command.slots.externalDataType || "unknown"}`);
  }
  if (command.conversationGoal?.domain) provenanceItems.push(`conversation-domain:${command.conversationGoal.domain}`);
  if (command.slots?.topic) provenanceItems.push(`topic:${command.slots.topic}`);
  if (["compound-execution-blocked", "non-actionable-guard"].includes(decision)) provenanceItems.push(`guard:${decision}`);

  return {
    policy: { ...policy },
    value: semanticMatchStrengthValue(command, decision),
    provenance: [...new Set(provenanceItems.filter(Boolean))],
    decision,
    reason: semanticPolicy.reason || "",
    numericConfidenceCompatibility: Number.isFinite(Number(command.confidence)) ? command.confidence : null,
  };
}

function semanticMatchStrengthValue(command = {}, decision = "") {
  if (command.slots?.needsClarification === true || decision === "clarification") return "possible";
  if (["compound-execution-blocked", "non-actionable-guard"].includes(decision)) return "strong";
  if (isVehicleIntent(command.intent) || command.intent === "safety.reject") return "strong";
  if (decision === "external-readonly") return "medium";
  if (decision === "model-normalized") return command.intent === "conversation.general" ? "medium" : "strong";
  if (decision === "degraded-rules") return "weak";
  if (command.intent === "conversation.general" && command.confidence === SEMANTIC_CONFIDENCE_POLICY.values.fallbackConversation) return "weak";
  if (command.intent === "conversation.general") return "medium";
  return "weak";
}
