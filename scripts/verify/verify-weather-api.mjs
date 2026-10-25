import assert from "node:assert/strict";
import {
  buildWeatherAdviceFromPolicy,
  buildWeatherFactPack,
  buildWeatherQueryPlan,
  composeWeatherResponse,
  fetchOpenMeteoWeather,
  formatWeatherSummary,
  isOpenWeatherQuestion,
  resolveWeatherLocation,
  validateWeatherComposedAnswer,
  WEATHER_ADVICE_POLICY,
} from "../../src/server/local-agent-server.mjs";
import { resolveConversationRoute } from "../../src/runtime/agent-schemas.js";
import { parseCommandWithSemanticPolicy as semanticParse } from "../lib/semantic-policy.js";

const forecastPayload = {
  current: {
    time: "2026-07-11T14:00",
    temperature_2m: 31,
    apparent_temperature: 35,
    relative_humidity_2m: 68,
    precipitation: 0,
    weather_code: 2,
    wind_speed_10m: 9,
  },
  current_units: {
    temperature_2m: "°C",
    apparent_temperature: "°C",
    relative_humidity_2m: "%",
    precipitation: "mm",
    wind_speed_10m: "km/h",
  },
  hourly: {
    time: [
      "2026-07-11T17:00",
      "2026-07-11T18:00",
      "2026-07-11T20:00",
      "2026-07-11T23:00",
      "2026-07-12T18:00",
    ],
    temperature_2m: [30, 29, 28, 27, 25],
    apparent_temperature: [34, 33, 31, 30, 27],
    precipitation: [0, 0.2, 2, 1, 8],
    precipitation_probability: [10, 40, 70, 60, 80],
    weather_code: [2, 2, 61, 61, 61],
    wind_speed_10m: [9, 11, 13, 12, 20],
  },
  hourly_units: {
    temperature_2m: "°C",
    apparent_temperature: "°C",
    precipitation: "mm",
    precipitation_probability: "%",
    wind_speed_10m: "km/h",
  },
  daily: {
    time: ["2026-07-11", "2026-07-12", "2026-07-13"],
    weather_code: [2, 61, 3],
    temperature_2m_max: [34, 30, 32],
    temperature_2m_min: [26, 24, 25],
    apparent_temperature_max: [39, 34, 35],
    apparent_temperature_min: [29, 27, 28],
    precipitation_sum: [0, 8, 1],
    precipitation_probability_max: [20, 80, 35],
    wind_speed_10m_max: [15, 20, 12],
  },
  daily_units: {
    temperature_2m_max: "°C",
    apparent_temperature_max: "°C",
    precipitation_sum: "mm",
    precipitation_probability_max: "%",
    wind_speed_10m_max: "km/h",
  },
};

function assertWeatherConversationRoute(parsed, rawText, expectedInteractionType = "question") {
  assert.equal(parsed.intent, "conversation.general", rawText);
  assert.equal(parsed.conversationGoal?.domain, "weather", `${rawText}: conversationGoal.domain`);
  assert.equal(parsed.conversationGoal?.interactionType, expectedInteractionType, `${rawText}: conversationGoal.interactionType`);
  const route = resolveConversationRoute(rawText, parsed);
  assert.equal(route.isWeather, true, `${rawText}: ConversationRoute.isWeather`);
  assert.equal(route.externalDataType, "weather", `${rawText}: ConversationRoute.externalDataType`);
  assert.equal(route.requiresExternalData, true, `${rawText}: ConversationRoute.requiresExternalData`);
  assert.equal(parsed.slots.topic, "weather_query", `${rawText}: legacy slots.topic compatibility`);
  assert.equal(parsed.toolCall, undefined, rawText);
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function forecastFetch(url) {
  assert.equal(new URL(url).hostname, "api.open-meteo.com");
  assert.equal(new URL(url).searchParams.get("forecast_days"), "3");
  assert.match(new URL(url).searchParams.get("hourly"), /precipitation_probability/);
  assert.match(new URL(url).searchParams.get("daily"), /precipitation_probability_max/);
  return Promise.resolve(response(forecastPayload));
}

function dateStringLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDaysLocal(dateString, days) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateStringLocal(date);
}

function makeExtendedForecastPayload(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(date.getDate() + index);
    return dateStringLocal(date);
  });
  return {
    ...forecastPayload,
    daily: {
      time: dates,
      weather_code: dates.map((_, index) => index % 2 === 0 ? 2 : 61),
      temperature_2m_max: dates.map((_, index) => 30 + (index % 3)),
      temperature_2m_min: dates.map((_, index) => 22 + (index % 3)),
      apparent_temperature_max: dates.map((_, index) => 33 + (index % 3)),
      apparent_temperature_min: dates.map((_, index) => 25 + (index % 3)),
      precipitation_sum: dates.map((_, index) => index % 2 === 0 ? 0 : 4),
      precipitation_probability_max: dates.map((_, index) => index % 2 === 0 ? 20 : 70),
      wind_speed_10m_max: dates.map((_, index) => 12 + index),
    },
  };
}

function extendedForecastFetch(url) {
  assert.equal(new URL(url).hostname, "api.open-meteo.com");
  const forecastDays = Number(new URL(url).searchParams.get("forecast_days"));
  assert.ok(forecastDays >= 3, `temporal query should request at least 3 days, got ${forecastDays}`);
  return Promise.resolve(response(makeExtendedForecastPayload(forecastDays)));
}

const defaultWeather = await fetchOpenMeteoWeather("今天天气怎么样", {
  fetchImpl: forecastFetch,
  now: () => new Date("2026-07-11T06:00:00.000Z"),
});
assert.equal(defaultWeather.location.city, "杭州");
assert.equal(defaultWeather.location.defaulted, true);
assert.equal(defaultWeather.location.resolution, "default");
assert.match(defaultWeather.location.note, /非实时定位/);

const knownWeather = await fetchOpenMeteoWeather("上海明天天气怎么样", { location: "上海", fetchImpl: forecastFetch });
assert.equal(knownWeather.location.city, "上海");
assert.equal(knownWeather.location.defaulted, false);
assert.equal(knownWeather.location.resolution, "known-city");
assert.equal(knownWeather.forecast.length, 3);
assert.equal(knownWeather.hourly.length, 5);
assert.deepEqual(Object.keys(knownWeather.forecast[0]), [
  "date", "weatherCode", "weatherDescription", "temperatureMax", "temperatureMin",
  "apparentTemperatureMax", "apparentTemperatureMin", "precipitationSum",
  "precipitationProbabilityMax", "windSpeed10mMax",
]);
assert.equal(knownWeather.provider, "open-meteo");
assert.ok(knownWeather.source);
assert.ok(knownWeather.fetchedAt);
assert.equal(knownWeather.units.precipitationProbability, "%");
const hangzhouClothingWeather = await fetchOpenMeteoWeather("今天杭州的天气适合穿什么衣服", { location: "杭州", fetchImpl: forecastFetch });
assert.equal(hangzhouClothingWeather.location.city, "杭州");
assert.equal(hangzhouClothingWeather.location.defaulted, false);

// The location comes only from the Vehicle-SLU weather.location slot; a city in the raw text is ignored.
const rawTextCityWeather = await fetchOpenMeteoWeather("苏州明天天气怎么样", { fetchImpl: forecastFetch });
assert.equal(rawTextCityWeather.location.resolution, "default",
  "without a location slot the weather adapter must not extract a city from raw text");
const geocoded = await resolveWeatherLocation("苏州", async (url) => {
  assert.equal(new URL(url).hostname, "geocoding-api.open-meteo.com");
  assert.equal(new URL(url).searchParams.get("name"), "苏州");
  assert.equal(new URL(url).searchParams.get("count"), "10");
  return response({ results: [{ name: "苏州", latitude: 31.3, longitude: 120.6, timezone: "Asia/Shanghai", country: "中国" }] });
});
assert.equal(geocoded.resolution, "geocoding");
assert.equal(geocoded.defaulted, false);

await assert.rejects(
  resolveWeatherLocation("朝阳", async (url) => {
    assert.equal(new URL(url).searchParams.get("name"), "朝阳");
    assert.equal(new URL(url).searchParams.get("count"), "10");
    return response({
      results: [
        { name: "朝阳区", latitude: 39.9219, longitude: 116.4431, timezone: "Asia/Shanghai", admin1: "北京", country: "中国" },
        { name: "朝阳市", latitude: 41.5718, longitude: 120.4586, timezone: "Asia/Shanghai", admin1: "辽宁", country: "中国" },
      ],
    });
  }),
  (error) => (
    error.code === "weather_location_ambiguous"
    && error.status === 400
    && error.details?.candidates?.length === 2
    && error.details?.weatherLocationClarification?.policy === "nio-weather-location-clarification@1.0.0"
    && error.details?.weatherLocationClarification?.code === "weather_location_ambiguous"
    && error.details?.weatherLocationClarification?.candidates?.length === 2
    && /补充省份/.test(error.details.clarification)
  ),
);

const qualifiedGeocoded = await resolveWeatherLocation("辽宁朝阳", async (url) => {
  assert.equal(new URL(url).searchParams.get("name"), "辽宁朝阳");
  assert.equal(new URL(url).searchParams.get("count"), "10");
  return response({
    results: [
      { name: "朝阳区", latitude: 39.9219, longitude: 116.4431, timezone: "Asia/Shanghai", admin1: "北京", country: "中国" },
      { name: "朝阳市", latitude: 41.5718, longitude: 120.4586, timezone: "Asia/Shanghai", admin1: "辽宁", country: "中国" },
    ],
  });
});
assert.equal(qualifiedGeocoded.city, "朝阳市");
assert.equal(qualifiedGeocoded.admin1, "辽宁");
assert.equal(qualifiedGeocoded.resolution, "geocoding");
assert.equal(qualifiedGeocoded.defaulted, false);

const qualifiedDistrict = await resolveWeatherLocation("北京朝阳", async (url) => {
  assert.equal(new URL(url).searchParams.get("name"), "北京朝阳");
  assert.equal(new URL(url).searchParams.get("count"), "10");
  return response({
    results: [
      { name: "朝阳", latitude: 31.4064, longitude: 109.05122, timezone: "Asia/Shanghai", admin1: "重庆市", country: "中国" },
      { name: "朝阳区", latitude: 39.9219, longitude: 116.4431, timezone: "Asia/Shanghai", admin1: "北京市", country: "中国" },
    ],
  });
});
assert.equal(qualifiedDistrict.city, "朝阳区");
assert.equal(qualifiedDistrict.admin1, "北京市");
assert.equal(qualifiedDistrict.resolution, "geocoding");

const lateQualifiedDistrict = await resolveWeatherLocation("广东白云", async (url) => {
  assert.equal(new URL(url).searchParams.get("name"), "广东白云");
  assert.equal(new URL(url).searchParams.get("count"), "10");
  return response({
    results: [
      { name: "白云", latitude: 26.6, longitude: 106.6, timezone: "Asia/Shanghai", admin1: "贵州省", country: "中国" },
      { name: "白云区", latitude: 23.1579, longitude: 113.2732, timezone: "Asia/Shanghai", admin1: "广州市", country: "中国" },
      { name: "白云", latitude: 30.1, longitude: 120.1, timezone: "Asia/Shanghai", admin1: "浙江省", country: "中国" },
      { name: "白云街道", latitude: 29.9, longitude: 121.6, timezone: "Asia/Shanghai", admin1: "浙江省", country: "中国" },
      { name: "白云区", latitude: 23.1579, longitude: 113.2732, timezone: "Asia/Shanghai", admin1: "广东省", country: "中国" },
    ],
  });
});
assert.equal(lateQualifiedDistrict.city, "白云区");
assert.equal(lateQualifiedDistrict.admin1, "广东省");
assert.equal(lateQualifiedDistrict.resolution, "geocoding");

await assert.rejects(
  resolveWeatherLocation("火星城", async () => response({ results: [] })),
  (error) => error.code === "weather_location_not_found" && error.status === 404,
);

let unresolvedReferenceFetchCount = 0;
await assert.rejects(
  fetchOpenMeteoWeather("这里天气怎么样", {
    location: "这里",
    fetchImpl: async () => {
      unresolvedReferenceFetchCount += 1;
      throw new Error("unresolved reference must not call upstream");
    },
  }),
  (error) => (
    error.code === "weather_location_needs_clarification"
    && error.status === 400
    && error.details?.weatherLocationClarification?.policy === "nio-weather-location-clarification@1.0.0"
    && error.details?.weatherLocationClarification?.reference === "current"
    && /当前位置|城市/.test(error.details.weatherLocationClarification.clarification)
  ),
);
assert.equal(unresolvedReferenceFetchCount, 0, "unresolved current-location reference must not call Open-Meteo");

const currentContextWeather = await fetchOpenMeteoWeather("这里天气怎么样", {
  location: "这里",
  locationContext: { current: { city: "上海", latitude: 31.2304, longitude: 121.4737, timezone: "Asia/Shanghai" } },
  fetchImpl: (url) => {
    assert.equal(new URL(url).searchParams.get("latitude"), "31.2304");
    assert.equal(new URL(url).searchParams.get("longitude"), "121.4737");
    return forecastFetch(url);
  },
});
assert.equal(currentContextWeather.location.city, "上海");
assert.equal(currentContextWeather.location.resolution, "context-current");
assert.equal(currentContextWeather.location.defaulted, false);

let unresolvedDestinationFetchCount = 0;
await assert.rejects(
  fetchOpenMeteoWeather("目的地天气怎么样", {
    location: "目的地",
    fetchImpl: async () => {
      unresolvedDestinationFetchCount += 1;
      throw new Error("unresolved destination must not call upstream");
    },
  }),
  (error) => (
    error.code === "weather_location_needs_clarification"
    && error.status === 400
    && error.details?.weatherLocationClarification?.policy === "nio-weather-location-clarification@1.0.0"
    && error.details?.weatherLocationClarification?.reference === "destination"
    && /目的地/.test(error.details.weatherLocationClarification.clarification)
  ),
);
assert.equal(unresolvedDestinationFetchCount, 0, "unresolved destination reference must not call Open-Meteo");

const destinationContextWeather = await fetchOpenMeteoWeather("目的地天气怎么样", {
  location: "目的地",
  locationContext: { destination: { city: "杭州", latitude: 30.2741, longitude: 120.1551, timezone: "Asia/Shanghai" } },
  fetchImpl: (url) => {
    assert.equal(new URL(url).searchParams.get("latitude"), "30.2741");
    assert.equal(new URL(url).searchParams.get("longitude"), "120.1551");
    return forecastFetch(url);
  },
});
assert.equal(destinationContextWeather.location.city, "杭州");
assert.equal(destinationContextWeather.location.resolution, "context-destination");
assert.equal(destinationContextWeather.location.defaulted, false);

const tomorrow = formatWeatherSummary(knownWeather, "", "上海明天天气怎么样");
assert.match(tomorrow, /上海明天小雨/);
assert.match(tomorrow, /24°C到30°C/);
assert.doesNotMatch(tomorrow, /Open-Meteo|时间边界/);
const future = formatWeatherSummary(knownWeather, "", "上海未来三天天气");
assert.match(future, /今天/);
assert.match(future, /明天/);
assert.match(future, /后天/);

const tonight = formatWeatherSummary(knownWeather, "", "上海今晚天气怎么样");
assert.match(tonight, /上海今晚小雨/);
assert.match(tonight, /27°C到29°C/);
assert.match(tonight, /降水概率最高70%/);
assert.doesNotMatch(tonight, /26°C到34°C|当前/);

const weekendWeather = await fetchOpenMeteoWeather("上海周末天气怎么样", { location: "上海", fetchImpl: extendedForecastFetch });
const weekendPlan = buildWeatherQueryPlan("上海周末天气怎么样");
const weekendFactPack = buildWeatherFactPack(weekendWeather, "上海周末天气怎么样");
assert.equal(weekendFactPack.target.kind, "range");
assert.equal(weekendFactPack.target.label, "周末");
assert.deepEqual(weekendFactPack.target.dates, [
  weekendPlan.absoluteTimeRange.startDate,
  addDaysLocal(weekendPlan.absoluteTimeRange.startDate, 1),
]);
assert.equal(weekendFactPack.forecast.length, 2);
const weekendSummary = formatWeatherSummary(weekendWeather, "", "上海周末天气怎么样");
assert.match(weekendSummary, /上海周六/);
assert.match(weekendSummary, /周日/);
assert.doesNotMatch(weekendSummary, /预报暂不可用|今天局部多云/);

const weekendComparisonWeather = await fetchOpenMeteoWeather("上海周六和周日哪个更适合出行", { location: "上海", fetchImpl: extendedForecastFetch });
const weekendComparisonPlan = buildWeatherQueryPlan("上海周六和周日哪个更适合出行");
const weekendComparisonFactPack = buildWeatherFactPack(weekendComparisonWeather, "上海周六和周日哪个更适合出行");
assert.equal(weekendComparisonFactPack.target.kind, "comparison");
assert.equal(weekendComparisonFactPack.target.label, "周末比较");
assert.deepEqual(weekendComparisonFactPack.target.dates, [
  weekendComparisonPlan.absoluteTimeRange.startDate,
  addDaysLocal(weekendComparisonPlan.absoluteTimeRange.startDate, 1),
]);
assert.equal(weekendComparisonFactPack.forecast.length, 2);
assert.deepEqual(weekendComparisonFactPack.forecast.map((day) => day.label), ["周六", "周日"]);

const implicitWeekendComparisonWeather = await fetchOpenMeteoWeather("上海周末哪天更适合出行", { location: "上海", fetchImpl: extendedForecastFetch });
const implicitWeekendComparisonPlan = buildWeatherQueryPlan("上海周末哪天更适合出行");
const implicitWeekendComparisonFactPack = buildWeatherFactPack(implicitWeekendComparisonWeather, "上海周末哪天更适合出行");
assert.equal(implicitWeekendComparisonFactPack.target.kind, "comparison");
assert.equal(implicitWeekendComparisonFactPack.target.label, "周末比较");
assert.deepEqual(implicitWeekendComparisonFactPack.target.dates, [
  implicitWeekendComparisonPlan.absoluteTimeRange.startDate,
  addDaysLocal(implicitWeekendComparisonPlan.absoluteTimeRange.startDate, 1),
]);
assert.equal(implicitWeekendComparisonFactPack.forecast.length, 2);
assert.deepEqual(implicitWeekendComparisonFactPack.forecast.map((day) => day.label), ["周六", "周日"]);

const nextMondayWeather = await fetchOpenMeteoWeather("上海下周一天气怎么样", { location: "上海", fetchImpl: extendedForecastFetch });
const nextMondayPlan = buildWeatherQueryPlan("上海下周一天气怎么样");
const nextMondayFactPack = buildWeatherFactPack(nextMondayWeather, "上海下周一天气怎么样");
assert.equal(nextMondayFactPack.target.kind, "day");
assert.equal(nextMondayFactPack.target.label, "下周一");
assert.deepEqual(nextMondayFactPack.target.dates, [nextMondayPlan.absoluteTimeRange.startDate]);
assert.equal(nextMondayFactPack.forecast.length, 1);

const todayClothing = formatWeatherSummary(hangzhouClothingWeather, "", "今天杭州的天气适合穿什么衣服");
assert.match(todayClothing, /^穿透气短袖和轻薄下装。/);
assert.match(todayClothing, /杭州今天局部多云，26°C到34°C/);
assert.doesNotMatch(todayClothing, /Open-Meteo|时间边界/);
assert.doesNotMatch(todayClothing, /雨具|防风层|紫外线|空气质量|预警/);

const tomorrowClothing = formatWeatherSummary(knownWeather, "", "上海明天怎么穿");
assert.match(tomorrowClothing, /^穿透气短袖和轻薄下装；带雨具，鞋子尽量防滑，可加轻薄防风层。/);
assert.match(tomorrowClothing, /上海明天小雨，24°C到30°C/);
assert.doesNotMatch(tomorrowClothing, /Open-Meteo|时间边界/);
assert.doesNotMatch(tomorrowClothing, /26°C到34°C|紫外线|空气质量|预警/);

assert.equal(WEATHER_ADVICE_POLICY.id, "nio-weather-advice-heuristic@1.0.0");
assert.match(WEATHER_ADVICE_POLICY.provenance, /local-dev heuristic/);
assert.equal(WEATHER_ADVICE_POLICY.precipitation.probabilityPercentAtOrAbove, 50);
assert.equal(WEATHER_ADVICE_POLICY.precipitation.amountMmAtOrAbove, 2);
assert.equal(WEATHER_ADVICE_POLICY.wind.speedKmhAtOrAbove, 20);
const boundaryWeatherAdvice = buildWeatherAdviceFromPolicy({
  day: {
    apparentTemperatureMin: 22,
    apparentTemperatureMax: 28,
    precipitationProbabilityMax: 50,
    precipitationSum: 0,
    windSpeed10mMax: 20,
  },
});
assert.equal(boundaryWeatherAdvice.policyId, WEATHER_ADVICE_POLICY.id);
assert.equal(boundaryWeatherAdvice.advice, "穿透气短袖和轻薄下装；带雨具，鞋子尽量防滑，可加轻薄防风层。");

assert.doesNotMatch(tomorrow, /穿|衣|雨具|防风层|防滑/);

assert.equal(isOpenWeatherQuestion("上海明天天气怎么样"), false);
assert.equal(isOpenWeatherQuestion("今天杭州的天气适合穿什么衣服"), true);
assert.equal(isOpenWeatherQuestion("明天要不要带伞"), true);
assert.equal(isOpenWeatherQuestion("今天和明天哪个更适合出行"), true);
assert.equal(isOpenWeatherQuestion("为什么今天体感这么热"), true);

const todayFactPack = buildWeatherFactPack(hangzhouClothingWeather, "今天杭州适合穿什么衣服");
assert.equal(todayFactPack.location.city, "杭州");
assert.equal(todayFactPack.location.defaulted, false);
assert.equal(todayFactPack.target.label, "今天");
assert.deepEqual(todayFactPack.target.dates, ["2026-07-11"]);
assert.equal(todayFactPack.forecast[0].temperatureMax, 34);
assert.equal(todayFactPack.current.apparentTemperature, 35);
assert.equal(todayFactPack.source, "open-meteo");
assert.deepEqual(todayFactPack.missingFields, ["uvIndex", "airQuality", "officialWarning"]);

const specialCareAdviceFactPack = buildWeatherFactPack(hangzhouClothingWeather, "老人今天适合高强度跑步吗");
assert.equal(specialCareAdviceFactPack.adviceContext.policyId, WEATHER_ADVICE_POLICY.id);
assert.equal(specialCareAdviceFactPack.adviceContext.personalizationStatus, "not_provided");
assert.equal(specialCareAdviceFactPack.adviceContext.requiresPersonalizationBoundary, true);
assert.deepEqual(specialCareAdviceFactPack.adviceContext.specialCareProfiles, ["elderly"]);
assert.deepEqual(specialCareAdviceFactPack.adviceContext.activityProfiles, ["running"]);
assert.equal(specialCareAdviceFactPack.adviceContext.activityIntensity, "high");

const regularActivityAdviceFactPack = buildWeatherFactPack(hangzhouClothingWeather, "今天杭州适合骑车吗");
assert.equal(regularActivityAdviceFactPack.adviceContext.requiresPersonalizationBoundary, true);
assert.deepEqual(regularActivityAdviceFactPack.adviceContext.specialCareProfiles, []);
assert.deepEqual(regularActivityAdviceFactPack.adviceContext.activityProfiles, ["cycling"]);
assert.equal(regularActivityAdviceFactPack.adviceContext.activityIntensity, "activity_profile_required");

const comparisonFactPack = buildWeatherFactPack(knownWeather, "上海今天和明天哪个更适合出行");
assert.equal(comparisonFactPack.target.kind, "comparison");
assert.equal(comparisonFactPack.forecast.length, 2);

const tonightFactPack = buildWeatherFactPack(knownWeather, "上海今晚天气怎么样");
assert.equal(tonightFactPack.target.kind, "hourly");
assert.equal(tonightFactPack.target.label, "今晚");
assert.deepEqual(tonightFactPack.target.dates, ["2026-07-11"]);
assert.equal(tonightFactPack.hourly.length, 3);
assert.equal(tonightFactPack.hourly[0].time, "2026-07-11T18:00");
assert.equal(tonightFactPack.hourly.at(-1).time, "2026-07-11T23:00");

function createCabinRegistry(generate) {
  const provider = Object.freeze({ id: "ollama", model: "qwen2.5:7b" });
  const requireCabinProvider = (task) => {
    assert.equal(task, "cabin_response", `weather composer must not route model work through ${task}`);
    return provider;
  };
  return Object.freeze({
    providerFor: requireCabinProvider,
    profileFor(task) {
      requireCabinProvider(task);
      return Object.freeze({ task, provider: provider.id, model: provider.model, watchdogMs: null });
    },
    async generateForTask(task, request) {
      requireCabinProvider(task);
      assert.equal(request.generationProfile, "weather-composer");
      assert.equal(request.outputMode, "text");
      assert.equal(Object.hasOwn(request, "model"), false);
      assert.equal(Object.hasOwn(request, "timeoutMs"), false);
      return generate(request);
    },
  });
}

function weatherProviderResult(text, overrides = {}) {
  return {
    text,
    provider: "ollama",
    model: "qwen2.5:7b",
    durationMs: 7,
    finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32, cachedInputTokens: 0 },
    providerTelemetry: { ollamaDurations: { eval_count: 20 } },
    externalModelRequestCount: 1,
    ...overrides,
  };
}

const stubGenerate = (responseText) => createCabinRegistry(async ({ prompt }) => {
  assert.match(prompt, /WEATHER_FACT_PACK/);
  assert.match(prompt, /WEATHER_ADVICE_POLICY/);
  assert.match(prompt, /WEATHER_COMPARISON_GROUNDING_POLICY/);
  assert.match(prompt, /answerClaims/);
  return weatherProviderResult(responseText);
});
const stubGenerateStructured = (payload) => stubGenerate(JSON.stringify(payload));

const weatherComposerSource = String(composeWeatherResponse);
assert.doesNotMatch(weatherComposerSource, /\busesLegacyGenerate\b/);
assert.doesNotMatch(weatherComposerSource, /\bgenerate\s*[,=}]/,
  "Weather Composer must not retain an injected direct-generate parameter or branch");
assert.doesNotMatch(weatherComposerSource, /\bmodel\s*=/,
  "Weather Composer must not accept a caller-selected model");
assert.doesNotMatch(weatherComposerSource, /\btimeoutMs\s*=/,
  "Weather Composer must not accept a caller-selected timeout");
const composedClothing = await composeWeatherResponse(
  hangzhouClothingWeather,
  "今天杭州的天气适合穿什么衣服",
  { registry: stubGenerate("今天偏热，穿透气短袖会更舒服；如果长时间在户外，可以带上雨具备用。") },
);
assert.equal(composedClothing.model, "weather-response-composer");
assert.equal(composedClothing.telemetry.modelType, "weather-response-composer");
assert.equal(composedClothing.telemetry.provider, "ollama");
assert.equal(composedClothing.telemetry.model, composedClothing.telemetry.generationModel);
assert.ok(composedClothing.telemetry.generationModel);
assert.equal(composedClothing.telemetry.fallback, false);
assert.equal(composedClothing.telemetry.grounding.status, "grounded");
assert.equal(composedClothing.telemetry.weatherAdvicePolicyId, WEATHER_ADVICE_POLICY.id);
assert.equal(composedClothing.telemetry.externalDataProvider, "open-meteo");
assert.equal(composedClothing.telemetry.cacheEligible, false);
assert.match(composedClothing.summary, /穿透气短袖/);

for (const [query, answer] of [
  ["明天要不要带伞", "明天有小雨，建议带伞，出门时留意路面湿滑。"],
  ["今天和明天哪个更适合出行", "今天局部多云、降水较少，比明天更适合安排户外出行。"],
  ["今天适合骑车吗", "未接入个人健康、偏好或活动强度画像，只能按健康成人通用出行建议参考；今天风速和降水条件相对温和，骑车要保守安排。"],
]) {
  const result = await composeWeatherResponse(knownWeather, query, { registry: stubGenerate(answer) });
  assert.equal(result.telemetry.fallback, false, query);
  assert.equal(result.telemetry.grounding.status, "grounded", query);
}

const wrongComparisonPreference = validateWeatherComposedAnswer("明天更适合出行，可以优先安排户外活动。", comparisonFactPack);
assert.equal(wrongComparisonPreference.ok, false);
assert.ok(wrongComparisonPreference.unsupported.some((item) => item.startsWith("comparison_mismatch:")));
const rejectedWrongComparison = await composeWeatherResponse(
  knownWeather,
  "上海今天和明天哪个更适合出行",
  { registry: stubGenerate("明天更适合出行，可以优先安排户外活动。") },
);
assert.equal(rejectedWrongComparison.telemetry.fallback, true);
assert.equal(rejectedWrongComparison.telemetry.grounding.status, "rejected");
assert.equal(rejectedWrongComparison.telemetry.fallbackReason, "comparison-mismatch");
assert.equal(rejectedWrongComparison.telemetry.weatherComparisonGroundingPolicyId, "nio-weather-comparison-grounding");

const invalidAnswers = [
  ["紫外线很强，建议做好防晒。", /当前只能依据/],
  ["今天AQI很好，空气优，没有预警，也需要注意防晒。", /当前只能依据/],
  ["今天最高温度是99°C，不适合出门。", /当前只能依据/],
  ["明天降水概率是80°C，建议少出门。", /当前只能依据/],
  ["已经帮你打开车窗，可以放心出发。", /当前只能依据/],
];
for (const [answer, fallbackPattern] of invalidAnswers) {
  const validation = validateWeatherComposedAnswer(answer, todayFactPack);
  assert.equal(validation.ok, false, answer);
  const result = await composeWeatherResponse(knownWeather, "今天适合出行吗", { registry: stubGenerate(answer) });
  assert.equal(result.telemetry.fallback, true, answer);
  assert.equal(result.telemetry.grounding.status, "rejected", answer);
  assert.match(result.summary, fallbackPattern);
  assert.doesNotMatch(result.summary, /99°C|已经帮你打开车窗|紫外线很强|AQI很好|空气优|没有预警|防晒/);
}

const missingNonNumericFieldValidation = validateWeatherComposedAnswer(
  "今天AQI很好，空气优，没有预警，也需要注意防晒。",
  todayFactPack,
);
assert.equal(missingNonNumericFieldValidation.ok, false);
assert.ok(missingNonNumericFieldValidation.unsupported.includes("missing_field:airQuality"));
assert.ok(missingNonNumericFieldValidation.unsupported.includes("missing_field:officialWarning"));
assert.ok(missingNonNumericFieldValidation.unsupported.includes("missing_field:uvIndex"));

const dateFieldMismatchAnswers = [
  "明天降水概率20%，今天降水概率80%。",
  "今天最高温30°C，明天最高温34°C。",
  "今天最低温24°C，明天最低温26°C。",
];
for (const answer of dateFieldMismatchAnswers) {
  const validation = validateWeatherComposedAnswer(answer, comparisonFactPack);
  assert.equal(validation.ok, false, answer);
  assert.ok(validation.unsupported.some((item) => item.startsWith("date_field_mismatch:")), answer);
  const result = await composeWeatherResponse(knownWeather, "上海今天和明天哪个更适合出行", { registry: stubGenerate(answer) });
  assert.equal(result.telemetry.fallback, true, answer);
  assert.equal(result.telemetry.grounding.status, "rejected", answer);
}

const validDateFieldAnswer = "今天降水概率20%，明天降水概率80%；今天最高温34°C，明天最高温30°C。";
const validDateFieldValidation = validateWeatherComposedAnswer(validDateFieldAnswer, comparisonFactPack);
assert.equal(validDateFieldValidation.ok, true, validDateFieldValidation.unsupported.join(","));

const missingAdviceBoundaryValidation = validateWeatherComposedAnswer(
  "今天气温不低，老人也适合高强度跑步。",
  specialCareAdviceFactPack,
);
assert.equal(missingAdviceBoundaryValidation.ok, false);
assert.ok(missingAdviceBoundaryValidation.unsupported.includes("missing_advice_personalization_boundary"));
const validAdviceBoundaryValidation = validateWeatherComposedAnswer(
  "未接入个人健康、偏好或活动强度画像，只能按健康成人通用出行建议参考；今天偏热，运动要保守。",
  specialCareAdviceFactPack,
);
assert.equal(validAdviceBoundaryValidation.ok, true, validAdviceBoundaryValidation.unsupported.join(","));

const missingRegularActivityBoundaryValidation = validateWeatherComposedAnswer(
  "今天风速和降水条件相对温和，可以谨慎安排骑车。",
  regularActivityAdviceFactPack,
);
assert.equal(missingRegularActivityBoundaryValidation.ok, false);
assert.ok(missingRegularActivityBoundaryValidation.unsupported.includes("missing_advice_personalization_boundary"));

const rejectedSpecialCareAdvice = await composeWeatherResponse(
  hangzhouClothingWeather,
  "老人今天适合高强度跑步吗",
  { registry: stubGenerate("今天气温不低，老人也适合高强度跑步。") },
);
assert.equal(rejectedSpecialCareAdvice.telemetry.fallback, true);
assert.equal(rejectedSpecialCareAdvice.telemetry.grounding.status, "rejected");
assert.equal(rejectedSpecialCareAdvice.telemetry.fallbackReason, "personalization-boundary-missing");
assert.equal(rejectedSpecialCareAdvice.telemetry.weatherAdviceContext.requiresPersonalizationBoundary, true);
assert.match(rejectedSpecialCareAdvice.summary, /未接入个人健康、偏好或活动强度画像/);
assert.doesNotMatch(rejectedSpecialCareAdvice.summary, /适合高强度跑步/);

const rejectedRegularActivityAdvice = await composeWeatherResponse(
  hangzhouClothingWeather,
  "今天杭州适合骑车吗",
  { registry: stubGenerate("今天风速和降水条件相对温和，可以谨慎安排骑车。") },
);
assert.equal(rejectedRegularActivityAdvice.telemetry.fallback, true);
assert.equal(rejectedRegularActivityAdvice.telemetry.grounding.status, "rejected");
assert.equal(rejectedRegularActivityAdvice.telemetry.fallbackReason, "personalization-boundary-missing");
assert.equal(rejectedRegularActivityAdvice.telemetry.weatherAdviceContext.requiresPersonalizationBoundary, true);
assert.deepEqual(rejectedRegularActivityAdvice.telemetry.weatherAdviceContext.activityProfiles, ["cycling"]);
assert.match(rejectedRegularActivityAdvice.summary, /未接入个人健康、偏好或活动强度画像/);

const derivedTextClaimResult = await composeWeatherResponse(
  knownWeather,
  "上海明天要不要带伞",
  { registry: stubGenerate("明天降水概率80%，建议带伞。") },
);
assert.equal(derivedTextClaimResult.telemetry.fallback, false);
assert.equal(derivedTextClaimResult.telemetry.grounding.answerClaimsStatus, "validated");
assert.equal(derivedTextClaimResult.telemetry.grounding.answerClaimsSource, "derived-from-text");
assert.equal(derivedTextClaimResult.telemetry.composerOutputFormat, "text-derived-answer-claims");
assert.equal(Object.hasOwn(derivedTextClaimResult.telemetry, "answerClaims"), false);

const structuredClaimResult = await composeWeatherResponse(
  knownWeather,
  "上海明天要不要带伞",
  {
    registry: stubGenerateStructured({
      response: "明天降水概率80%，建议带伞。",
      answerClaims: [
        {
          fieldPath: "forecast.precipitationProbabilityMax",
          fieldValue: 80,
          unit: "%",
          dateTerm: "明天",
        },
      ],
    }),
  },
);
assert.equal(structuredClaimResult.telemetry.fallback, false);
assert.equal(structuredClaimResult.telemetry.grounding.answerClaimsStatus, "validated");
assert.equal(structuredClaimResult.telemetry.composerOutputFormat, "json-with-answer-claims");
assert.equal(Object.hasOwn(structuredClaimResult.telemetry, "answerClaims"), false);

const wrongStructuredClaimValidation = validateWeatherComposedAnswer(
  "降水概率20%，建议带伞。",
  comparisonFactPack,
  {
    answerClaims: [
      {
        fieldPath: "forecast.precipitationProbabilityMax",
        fieldValue: 20,
        unit: "%",
        dateTerm: "明天",
      },
    ],
  },
);
assert.equal(wrongStructuredClaimValidation.ok, false);
assert.ok(wrongStructuredClaimValidation.unsupported.some((item) => item.startsWith("answer_claim_unbound:")));
const rejectedStructuredClaim = await composeWeatherResponse(
  knownWeather,
  "上海明天要不要带伞",
  {
    registry: stubGenerateStructured({
      response: "降水概率20%，建议带伞。",
      answerClaims: [
        {
          fieldPath: "forecast.precipitationProbabilityMax",
          fieldValue: 20,
          unit: "%",
          dateTerm: "明天",
        },
      ],
    }),
  },
);
assert.equal(rejectedStructuredClaim.telemetry.fallback, true);
assert.equal(rejectedStructuredClaim.telemetry.grounding.answerClaimsStatus, "rejected");
assert.equal(rejectedStructuredClaim.telemetry.fallbackReason, "answer-claim-unbound");

const telemetrySecret = "SECRET_WEATHER_TELEMETRY";
const maliciousClaimTelemetry = await composeWeatherResponse(
  knownWeather,
  "上海明天要不要带伞",
  {
    registry: createCabinRegistry(async () => weatherProviderResult(JSON.stringify({
        response: "降水概率20%，建议带伞。",
        answerClaims: [{
          fieldPath: `forecast.${telemetrySecret}.${"x".repeat(2_000)}`,
          fieldValue: 20,
          unit: `${telemetrySecret}-unit`,
          dateTerm: `${telemetrySecret}-date`,
          rawOutput: telemetrySecret,
          prompt: telemetrySecret,
          extra: telemetrySecret,
        }],
        rawOutput: telemetrySecret,
        prompt: telemetrySecret,
        secret: telemetrySecret,
      }), {
      finishReason: `${telemetrySecret}-${"y".repeat(2_000)}`,
      usage: {
        inputTokens: 2,
        outputTokens: 2,
        totalTokens: 4,
        cachedInputTokens: 0,
        rawOutput: telemetrySecret,
        prompt: telemetrySecret,
        secret: telemetrySecret,
      },
      providerTelemetry: {
        ollamaDurations: {
          eval_count: 2,
          rawOutput: telemetrySecret,
          prompt: telemetrySecret,
          secret: telemetrySecret,
        },
      },
      rawOutput: telemetrySecret,
      prompt: telemetrySecret,
      secret: telemetrySecret,
    })),
  },
);
const serializedWeatherTelemetry = JSON.stringify(maliciousClaimTelemetry.telemetry);
assert.equal(maliciousClaimTelemetry.telemetry.fallback, true);
assert.equal(maliciousClaimTelemetry.telemetry.fallbackReason, "answer-claim-unbound");
assert.equal(Object.hasOwn(maliciousClaimTelemetry.telemetry, "answerClaims"), false);
assert.equal(serializedWeatherTelemetry.includes(telemetrySecret), false);
assert.equal(serializedWeatherTelemetry.includes("rawOutput"), false);
assert.equal(serializedWeatherTelemetry.includes("prompt"), false);
assert.ok(serializedWeatherTelemetry.length < 5_000, "weather telemetry must remain bounded");
assert.deepEqual(Object.keys(maliciousClaimTelemetry.telemetry.usage).sort(), [
  "cachedInputTokens", "inputTokens", "outputTokens", "totalTokens", "unavailableReason",
].sort());
assert.deepEqual(Object.keys(maliciousClaimTelemetry.telemetry.ollamaDurations), ["eval_count"]);

const failedComposer = await composeWeatherResponse(
  knownWeather,
  "明天适合出行吗",
  { registry: createCabinRegistry(async () => { throw new Error("stub timeout"); }) },
);
assert.equal(failedComposer.telemetry.fallback, true);
assert.equal(failedComposer.telemetry.grounding.status, "error");
assert.equal(failedComposer.telemetry.fallbackReason, "provider-unavailable");
assert.match(failedComposer.summary, /当前只能依据/);

const rejectedComparison = await composeWeatherResponse(
  knownWeather,
  "上海今天和明天哪个更适合出行",
  { registry: stubGenerate("今天最高99°C，所以今天一定更适合出行。") },
);
assert.equal(rejectedComparison.telemetry.fallback, true);
assert.equal(rejectedComparison.telemetry.grounding.status, "rejected");
assert.match(rejectedComparison.summary, /今天局部多云/);
assert.match(rejectedComparison.summary, /明天小雨/);
assert.doesNotMatch(rejectedComparison.summary, /更适合|最好|一定|推荐今天|推荐明天/);

const rejectedWeekendComparison = await composeWeatherResponse(
  implicitWeekendComparisonWeather,
  "上海周末哪天更适合出行",
  {
    registry: stubGenerate(
      implicitWeekendComparisonFactPack.forecast[0].precipitationProbabilityMax > implicitWeekendComparisonFactPack.forecast[1].precipitationProbabilityMax
        ? "周六更适合出行，可以优先安排户外活动。"
        : "周日更适合出行，可以优先安排户外活动。",
    ),
  },
);
assert.equal(rejectedWeekendComparison.telemetry.fallback, true);
assert.equal(rejectedWeekendComparison.telemetry.grounding.status, "rejected");
assert.equal(rejectedWeekendComparison.telemetry.fallbackReason, "comparison-mismatch");
assert.match(rejectedWeekendComparison.summary, /上海周六/);
assert.match(rejectedWeekendComparison.summary, /周日/);
assert.doesNotMatch(rejectedWeekendComparison.summary, /更适合|优先安排|推荐周六|推荐周日/);

const defaultFactPack = buildWeatherFactPack(defaultWeather, "今天适合散步吗");
assert.equal(defaultFactPack.location.city, "杭州");
assert.equal(defaultFactPack.location.resolution, "default");
assert.equal(defaultFactPack.location.defaulted, true);
assert.equal(defaultFactPack.location.requestedName, null);
assert.match(defaultFactPack.location.note, /非实时定位/);
const groundedDefaultLocation = await composeWeatherResponse(
  defaultWeather,
  "今天适合散步吗",
  { registry: stubGenerate("未接入个人健康、偏好或活动强度画像，只能按健康成人通用出行建议参考；今天局部多云、降水较少，可以谨慎安排散步。未提供地点，默认杭州（非实时定位）。") },
);
assert.equal(groundedDefaultLocation.telemetry.fallback, false);
assert.equal(groundedDefaultLocation.telemetry.grounding.status, "grounded");
assert.match(groundedDefaultLocation.summary, /默认杭州（非实时定位）/);
assert.match(groundedDefaultLocation.summary, /未接入个人健康、偏好或活动强度画像/);
const missingDefaultLocationBoundary = await composeWeatherResponse(
  defaultWeather,
  "今天适合散步吗",
  { registry: stubGenerate("今天局部多云、降水较少，可以谨慎安排散步。") },
);
assert.equal(missingDefaultLocationBoundary.telemetry.fallback, true);
assert.equal(missingDefaultLocationBoundary.telemetry.grounding.status, "rejected");
assert.ok([
  "personalization-boundary-missing",
  "default-location-boundary-missing",
].includes(missingDefaultLocationBoundary.telemetry.fallbackReason));
assert.ok(missingDefaultLocationBoundary.telemetry.grounding.reasonCodes.includes("default-location-boundary-missing"));
assert.match(missingDefaultLocationBoundary.summary, /按杭州查询（非实时定位）/);

const parsed = semanticParse("上海明天天气怎么样", "weather-test");
assertWeatherConversationRoute(parsed, "上海明天天气怎么样");
const parsedClothing = semanticParse("今天杭州的天气适合穿什么衣服", "weather-clothing-test");
assertWeatherConversationRoute(parsedClothing, "今天杭州的天气适合穿什么衣服");
for (const [query, interactionType] of [
  ["明天要不要带伞", "question"],
  ["今天和明天哪个更适合出行", "compare"],
  ["为什么今天体感这么热", "explain"],
]) {
  const weatherParsed = semanticParse(query, `weather-open-${query}`);
  assertWeatherConversationRoute(weatherParsed, query, interactionType);
}

if (process.argv.includes("--live")) {
  const endpoint = process.env.NIO_AGENT_URL || "http://127.0.0.1:4173";
  const postWeather = async (query, location) => {
    const result = await fetch(`${endpoint}/api/weather`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, location }),
    });
    return { status: result.status, body: await result.json() };
  };
  const postWeatherWithBody = async (body) => {
    const result = await fetch(`${endpoint}/api/weather`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: result.status, body: await result.json() };
  };
  const liveKnown = await postWeather("上海明天天气怎么样");
  assert.equal(liveKnown.status, 200);
  assert.equal(liveKnown.body.ok, true);
  assert.equal(liveKnown.body.weatherData.location.city, "上海");
  assert.equal(liveKnown.body.weatherData.forecast.length, 3);
  assert.equal(liveKnown.body.telemetry.cacheHit, false);

  const liveUnknown = await postWeather("火星城天气怎么样");
  assert.equal(liveUnknown.status, 404);
  assert.equal(liveUnknown.body.error.code, "weather_location_not_found");

  const liveCurrentUnresolved = await postWeather("这里天气怎么样");
  assert.equal(liveCurrentUnresolved.status, 400);
  assert.equal(liveCurrentUnresolved.body.error.code, "weather_location_needs_clarification");
  assert.equal(liveCurrentUnresolved.body.error.weatherLocationClarification?.policy, "nio-weather-location-clarification@1.0.0");
  assert.equal(liveCurrentUnresolved.body.error.weatherLocationClarification?.reference, "current");

  const liveDestinationContext = await postWeatherWithBody({
    query: "目的地天气怎么样",
    locationContext: { destination: { city: "上海", latitude: 31.2304, longitude: 121.4737, timezone: "Asia/Shanghai" } },
  });
  assert.equal(liveDestinationContext.status, 200);
  assert.equal(liveDestinationContext.body.weatherData.location.resolution, "context-destination");
  assert.equal(liveDestinationContext.body.weatherData.location.city, "上海");
}

console.log(JSON.stringify({
  ok: true,
  defaultLocation: defaultWeather.location,
  knownLocation: knownWeather.location,
  tomorrow,
  todayClothing,
  tomorrowClothing,
  future,
  composedClothing: composedClothing.summary,
  semanticIntent: parsed.intent,
}, null, 2));
