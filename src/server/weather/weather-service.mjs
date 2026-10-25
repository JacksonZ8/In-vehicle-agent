// Weather domain for the local agent server: query planning, location resolution,
// Open-Meteo retrieval, fact packs and grounded-answer validation. The provider-backed
// composer that drives a model over these facts stays in local-agent-server.mjs.

import { resolveConversationRoute } from "../../runtime/agent-schemas.js";
import { buildWeatherAdviceFromPolicy, WEATHER_ADVICE_POLICY } from "../../external-data/weather-advice-policy.js";
import { composeAbortSignals, createAbortError, isCancellationError, throwIfAborted } from "../../runtime/abort-utils.js";

export const weatherTimeoutMs = Number(process.env.NIO_WEATHER_TIMEOUT_MS || 8000);

const WEATHER_GEOCODING_POLICY = Object.freeze({
  id: "nio-weather-geocoding-resolution@1.1.0",
  candidateLimit: 10,
});

// HC-P1-07: fast-path cache for known cities. Geocoding is the primary resolution mechanism;
// this map avoids an HTTP round-trip for verified cities only.
const weatherCityMap = {
  杭州: { city: "杭州", latitude: 30.2741, longitude: 120.1551, timezone: "Asia/Shanghai" },
  上海: { city: "上海", latitude: 31.2304, longitude: 121.4737, timezone: "Asia/Shanghai" },
  北京: { city: "北京", latitude: 39.9042, longitude: 116.4074, timezone: "Asia/Shanghai" },
  广州: { city: "广州", latitude: 23.1291, longitude: 113.2644, timezone: "Asia/Shanghai" },
  深圳: { city: "深圳", latitude: 22.5431, longitude: 114.0579, timezone: "Asia/Shanghai" },
};

// HC-P1-07: default location is env-configurable. When unset, local dev keeps an explicit
// non-positioning Hangzhou default so no query is sent with undefined coordinates.
const defaultWeatherLocation = (() => {
  const raw = process.env.NIO_WEATHER_DEFAULT_LOCATION;
  if (!raw) return { ...weatherCityMap.杭州 };
  try {
    return JSON.parse(raw);
  } catch {
    // Plain city name → resolve from fast-path map
    if (weatherCityMap[raw]) return { ...weatherCityMap[raw] };
    return null;
  }
})();

export const WEATHER_COMPARISON_GROUNDING_POLICY = Object.freeze({
  id: "nio-weather-comparison-grounding",
  version: "1.0.0",
  method: "precipitation-first deterministic local-dev scorer",
  factors: Object.freeze({
    precipitationProbabilityWeight: 2,
    precipitationSumWeight: 8,
    windSpeedWeight: 0.5,
    comfortTemperatureMin: 16,
    comfortTemperatureMax: 30,
  }),
});

// HC-P1-07: temporal resolver — handles relative day references beyond the old 3-day closed set.
export function resolveTemporalRange(rawText = "") {
  const text = String(rawText || "").trim();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Comparison must be resolved before single-day markers; otherwise
  // "今天和明天哪个更适合出行" is incorrectly reduced to "今天".
  const comparisonMarkers = [/今天|今日/, /明天|明日/, /后天|后日/].filter((pattern) => pattern.test(text));
  if (comparisonMarkers.length >= 2 && /和|与|相比|比较|哪个|更适合|更好/.test(text)) {
    const end = new Date(today); end.setDate(end.getDate() + 3);
    return { kind: "comparison", label: "多日比较", startDate: toDateString(today), endDate: toDateString(end), days: comparisonMarkers.length };
  }
  const explicitWeekendComparison = /周末|周六|星期六|礼拜六/.test(text)
    && /周日|星期日|礼拜天/.test(text)
    && /和|与|相比|比较|哪个|哪天|哪一天|更适合|更好/.test(text);
  const implicitWeekendComparison = /周末/.test(text) && /哪(?:一)?天|哪(?:一)?日|哪日/.test(text);
  if (explicitWeekendComparison || implicitWeekendComparison) {
    const dayOfWeek = today.getDay();
    const daysUntilSaturday = dayOfWeek === 6 ? 0 : (6 - dayOfWeek + 7) % 7 || 7;
    const start = new Date(today); start.setDate(start.getDate() + (daysUntilSaturday || 0));
    const end = new Date(start); end.setDate(end.getDate() + 2);
    return { kind: "comparison", label: "周末比较", startDate: toDateString(start), endDate: toDateString(end), days: 2 };
  }

  // Absolute relative days
  if (/今天|今日|当前|现在/.test(text)) {
    const start = new Date(today);
    const end = new Date(today); end.setDate(end.getDate() + 1);
    return { kind: "relative-day", label: "今天", startDate: toDateString(start), endDate: toDateString(end), days: 1 };
  }
  if (/明天|明日/.test(text)) {
    const start = new Date(today); start.setDate(start.getDate() + 1);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { kind: "relative-day", label: "明天", startDate: toDateString(start), endDate: toDateString(end), days: 1 };
  }
  if (/后天|后日/.test(text)) {
    const start = new Date(today); start.setDate(start.getDate() + 2);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { kind: "relative-day", label: "后天", startDate: toDateString(start), endDate: toDateString(end), days: 1 };
  }

  // Weekend
  if (/周末|周六|周日|星期六|星期日|礼拜六|礼拜天/.test(text)) {
    const dayOfWeek = today.getDay();
    const daysUntilSaturday = dayOfWeek === 6 ? 0 : (6 - dayOfWeek + 7) % 7 || 7;
    const start = new Date(today); start.setDate(start.getDate() + (daysUntilSaturday || 0));
    const end = new Date(start); end.setDate(end.getDate() + 2);
    return { kind: "weekend", label: "周末", startDate: toDateString(start), endDate: toDateString(end), days: 2 };
  }

  // Next weekday (下周一/下周二/...)
  const nextWeekdayMatch = text.match(/下周([一二三四五六日天])/);
  if (nextWeekdayMatch) {
    const dayMap = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7 };
    const targetDay = dayMap[nextWeekdayMatch[1]];
    const currentDay = today.getDay() || 7;
    const daysUntil = targetDay - currentDay + 7;
    const start = new Date(today); start.setDate(start.getDate() + daysUntil);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { kind: "next-weekday", label: nextWeekdayMatch[0], startDate: toDateString(start), endDate: toDateString(end), days: 1 };
  }

  // Tonight
  if (/今晚|今天晚上|今晚间/.test(text)) {
    return { kind: "tonight", label: "今晚", startDate: null, endDate: null, days: 0, note: "current-day hourly needed for tonight resolution" };
  }

  // Default: 3-day forecast
  const end = new Date(today); end.setDate(end.getDate() + 3);
  return { kind: "default-3day", label: "未来三天", startDate: toDateString(today), endDate: toDateString(end), days: 3 };
}

function toDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// HC-P1-07: structured weather query plan — replaces the old regex-only extraction
// Answer planning only (goal and time window). The location is the Vehicle-SLU weather.location slot.
export function buildWeatherQueryPlan(rawText = "", location = null) {
  const text = String(rawText || "").trim();
  const temporal = resolveTemporalRange(text);
  const locationRef = normalizeWeatherSlotLocation(location);
  return {
    relevance: /天气|气温|温度|下雨|降水|刮风|风速|湿度|体感|穿衣|防晒|紫外线|台风|暴雪|冰雹/.test(text)
      ? "explicit" : "implicit",
    goal: /穿衣|衣服|穿什么|怎么穿/.test(text) ? "dressing_advice"
      : /会不会下雨|是否下雨|带伞|雨伞/.test(text) ? "rain_check"
      : /温度|气温|多少度/.test(text) ? "temperature"
      : /刮风|风速|风力/.test(text) ? "wind"
      : /防晒|紫外线/.test(text) ? "uv"
      : "general_forecast",
    absoluteTimeRange: temporal,
    locationRef: locationRef || null,
    constraints: {
      needsClarification: !locationRef && !defaultWeatherLocation,
      missingLocation: !locationRef,
      temporalUnresolved: temporal.kind === "tonight",
    },
  };
}

function normalizeWeatherSlotLocation(location) {
  return typeof location === "string" && location.trim() ? location.trim().slice(0, 60) : "";
}

class WeatherAdapterError extends Error {
  constructor(message, { code = "weather_upstream_error", status = 502, details = null } = {}) {
    super(message);
    this.name = "WeatherAdapterError";
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

function buildWeatherLocationClarification({
  code = "weather_location_needs_clarification",
  requestedName = null,
  reference = "",
  clarification = "",
  candidates = [],
  selectedCandidate = null,
} = {}) {
  return {
    policy: "nio-weather-location-clarification@1.0.0",
    code,
    requestedName,
    reference,
    clarification: clarification || "请明确要查询天气的城市或地区。",
    candidates: Array.isArray(candidates) ? candidates : [],
    ...(selectedCandidate ? { selectedCandidate } : {}),
  };
}

async function fetchWeatherJson(url, fetchImpl, stage, signal) {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort(createAbortError(`Open-Meteo ${stage} timeout`));
  }, weatherTimeoutMs);
  const abortScope = composeAbortSignals([signal, timeoutController.signal]);
  try {
    const result = await fetchImpl(url, { method: "GET", signal: abortScope.signal });
    if (!result.ok) {
      throw new WeatherAdapterError(`Open-Meteo ${stage} HTTP ${result.status}`);
    }
    return await result.json();
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    if (timedOut || isCancellationError(error)) {
      throw new WeatherAdapterError(`Open-Meteo ${stage} timeout after ${weatherTimeoutMs}ms`, {
        code: "weather_timeout",
        status: 504,
      });
    }
    if (error instanceof WeatherAdapterError) throw error;
    throw new WeatherAdapterError(`Open-Meteo ${stage} failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
    abortScope.dispose();
  }
}

export async function resolveWeatherLocation(location = "", fetchImpl = fetch, options = {}) {
  const requestedName = normalizeWeatherSlotLocation(location);
  const reference = detectWeatherLocationReference(requestedName);
  if (reference) {
    const contextLocation = normalizeWeatherContextLocation(options.locationContext?.[reference], reference);
    if (contextLocation) {
      return {
        ...contextLocation,
        resolution: reference === "current" ? "context-current" : "context-destination",
        defaulted: false,
        requestedName: reference,
        note: reference === "current" ? "地点来自可信 LocationContext.current。" : "地点来自可信 LocationContext.destination。",
      };
    }
    return {
      resolution: "unresolved",
      defaulted: false,
      requestedName: reference,
      note: reference === "current"
        ? "用户询问当前位置天气，但当前未接入可信 LocationContext.current。请明确城市名称。"
        : "用户询问目的地天气，但当前未接入可信 LocationContext.destination。请先明确目的地城市。",
      clarification: reference === "current"
        ? "当前未接入可信当前位置，请明确城市名称。"
        : "当前未接入可信导航目的地，请明确目的地城市。",
      needsClarification: true,
    };
  }
  if (!requestedName) {
    // HC-P1-07: no default location → clarification required (production-safe)
    if (!defaultWeatherLocation) {
      return {
        resolution: "unresolved",
        defaulted: true,
        requestedName: null,
        note: "未提供地点，且未配置 NIO_WEATHER_DEFAULT_LOCATION。请明确指定城市名称。",
        clarification: "请明确要查询天气的城市名称。",
        needsClarification: true,
      };
    }
    return {
      ...defaultWeatherLocation,
      resolution: "default",
      defaulted: true,
      requestedName: null,
      note: `未提供地点，默认${defaultWeatherLocation.city}（非实时定位）。设置 NIO_WEATHER_DEFAULT_LOCATION 可更改。`,
    };
  }

  if (weatherCityMap[requestedName]) {
    return {
      ...weatherCityMap[requestedName],
      resolution: "known-city",
      defaulted: false,
      requestedName,
    };
  }

  // HC-P1-07: use a policy-defined candidate window for disambiguation.
  // A too-small window can miss the qualified admin match when a common place name
  // has more than three plausible Open-Meteo results.
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", requestedName);
  url.searchParams.set("count", String(WEATHER_GEOCODING_POLICY.candidateLimit));
  url.searchParams.set("language", "zh");
  url.searchParams.set("format", "json");
  const data = await fetchWeatherJson(url, fetchImpl, "geocoding", options.signal);
  const candidates = (data.results || []).filter((result) => (
    result
    && Number.isFinite(result.latitude)
    && Number.isFinite(result.longitude)
  ));
  const resolved = selectQualifiedWeatherLocationResult(requestedName, candidates) || candidates[0];
  if (!resolved || !Number.isFinite(resolved.latitude) || !Number.isFinite(resolved.longitude)) {
    throw new WeatherAdapterError(`无法解析天气地点：${requestedName}`, {
      code: "weather_location_not_found",
      status: 404,
    });
  }

  const ambiguity = buildWeatherLocationAmbiguity(requestedName, candidates, resolved);
  if (ambiguity) {
    const weatherLocationClarification = buildWeatherLocationClarification({
      code: "weather_location_ambiguous",
      requestedName: ambiguity.requestedName,
      clarification: ambiguity.clarification,
      candidates: ambiguity.candidates,
      selectedCandidate: ambiguity.selectedCandidate,
    });
    throw new WeatherAdapterError(`地点“${requestedName}”可能指多个地区，请补充省份、国家或选择具体地点。`, {
      code: "weather_location_ambiguous",
      status: 400,
      details: { ...ambiguity, weatherLocationClarification },
    });
  }

  // HC-P1-07: keep alternatives for audit, but do not silently use the first result when
  // multiple plausible places share the same unqualified name.
  const alternatives = candidates.filter((r) => r !== resolved).slice(0, 2).map((r) => ({
    city: r.name || "",
    admin1: r.admin1 || "",
    country: r.country || "",
    latitude: r.latitude,
    longitude: r.longitude,
  }));
  return {
    city: resolved.name || requestedName,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
    timezone: resolved.timezone || "auto",
    country: resolved.country,
    admin1: resolved.admin1,
    resolution: "geocoding",
    defaulted: false,
    requestedName,
    ...(alternatives.length > 0 ? { alternatives, disambiguated: true } : {}),
  };
}

function normalizeWeatherPlaceToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·•.,，。'"]/g, "");
}

function stripWeatherPlaceSuffix(value = "") {
  return normalizeWeatherPlaceToken(value)
    .replace(/(省|市|区|县|州|郡|镇|乡|旗|盟|特别行政区|自治区|自治州|地区)$/u, "");
}

function formatWeatherLocationCandidate(result = {}) {
  return {
    city: result.name || "",
    admin1: result.admin1 || "",
    country: result.country || "",
    latitude: result.latitude,
    longitude: result.longitude,
  };
}

function selectQualifiedWeatherLocationResult(requestedName = "", candidates = []) {
  const text = normalizeWeatherPlaceToken(requestedName);
  const matches = candidates.filter((candidate) => {
    const name = normalizeWeatherPlaceToken(candidate.name || "");
    const nameRoot = stripWeatherPlaceSuffix(candidate.name || "");
    const admin1 = normalizeWeatherPlaceToken(candidate.admin1 || "");
    const admin1Root = stripWeatherPlaceSuffix(candidate.admin1 || "");
    const country = normalizeWeatherPlaceToken(candidate.country || "");
    if (!name) return false;
    const mentionsName = text.includes(name) || (nameRoot && text.includes(nameRoot));
    const mentionsAdmin1 = text.includes(admin1) || (admin1Root && text.includes(admin1Root));
    return (
      (admin1 && mentionsAdmin1 && mentionsName)
      || (country && text.includes(country) && mentionsName)
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

function buildWeatherLocationAmbiguity(requestedName = "", candidates = [], resolved = null) {
  const qualified = selectQualifiedWeatherLocationResult(requestedName, candidates);
  if (qualified) return null;
  const requestedRoot = stripWeatherPlaceSuffix(requestedName);
  if (!requestedRoot) return null;
  const plausible = candidates.filter((candidate) => {
    const nameRoot = stripWeatherPlaceSuffix(candidate.name || "");
    return nameRoot && (nameRoot === requestedRoot || nameRoot.includes(requestedRoot) || requestedRoot.includes(nameRoot));
  });
  if (plausible.length < 2) return null;
  return {
    requestedName,
    selectedCandidate: resolved ? formatWeatherLocationCandidate(resolved) : null,
    candidates: plausible.slice(0, 5).map(formatWeatherLocationCandidate),
    clarification: `请说明“${requestedName}”具体是哪个地区，例如补充省份、国家或城市全称。`,
  };
}

function detectWeatherLocationReference(rawText = "") {
  const text = String(rawText || "");
  if (/这里|这边|当前位置|当前地点|我这边|附近/.test(text)) return "current";
  if (/目的地|终点|到达地|导航目的地/.test(text) && !Object.keys(weatherCityMap).some((name) => text.includes(name))) return "destination";
  return "";
}

function normalizeWeatherContextLocation(location, reference = "") {
  if (!location || typeof location !== "object") return null;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const city = String(location.city || location.name || (reference === "current" ? "当前位置" : "目的地")).trim();
  return {
    city,
    latitude,
    longitude,
    timezone: location.timezone || "auto",
    ...(location.country ? { country: location.country } : {}),
    ...(location.admin1 ? { admin1: location.admin1 } : {}),
  };
}

function describeWeatherCode(code) {
  const weatherCode = Number(code);
  const descriptions = {
    0: "晴",
    1: "大部晴朗",
    2: "局部多云",
    3: "阴",
    45: "有雾",
    48: "有雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "小阵雨",
    81: "中等阵雨",
    82: "强阵雨",
    95: "雷雨",
    96: "雷雨伴小冰雹",
    99: "雷雨伴大冰雹",
  };
  return descriptions[weatherCode] || `天气代码 ${weatherCode}`;
}

export async function fetchOpenMeteoWeather(rawText = "", {
  fetchImpl = fetch,
  now = () => new Date(),
  location: requestedLocation = null,
  locationContext = null,
  signal,
} = {}) {
  throwIfAborted(signal);
  const location = await resolveWeatherLocation(requestedLocation, fetchImpl, { locationContext, signal });
  if (location.needsClarification) {
    const clarification = buildWeatherLocationClarification({
      code: "weather_location_needs_clarification",
      requestedName: location.requestedName ?? null,
      reference: location.requestedName || "",
      clarification: location.clarification || location.note,
    });
    throw new WeatherAdapterError(location.note || "天气地点需要澄清", {
      code: "weather_location_needs_clarification",
      status: 400,
      details: { weatherLocationClarification: clarification },
    });
  }
  const plan = buildWeatherQueryPlan(rawText, requestedLocation);
  const forecastDays = resolveForecastDaysForPlan(plan);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("timezone", location.timezone || "auto");
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("hourly", "temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max");
  url.searchParams.set("forecast_days", String(forecastDays));

  const data = await fetchWeatherJson(url, fetchImpl, "forecast", signal);
  const current = data.current || {};
  const currentUnits = data.current_units || {};
  const hourly = data.hourly || {};
  const hourlyUnits = data.hourly_units || {};
  const daily = data.daily || {};
  const dailyUnits = data.daily_units || {};
  const forecast = (daily.time || []).slice(0, forecastDays).map((date, index) => ({
    date,
    weatherCode: daily.weather_code?.[index],
    weatherDescription: describeWeatherCode(daily.weather_code?.[index]),
    temperatureMax: daily.temperature_2m_max?.[index],
    temperatureMin: daily.temperature_2m_min?.[index],
    apparentTemperatureMax: daily.apparent_temperature_max?.[index],
    apparentTemperatureMin: daily.apparent_temperature_min?.[index],
    precipitationSum: daily.precipitation_sum?.[index],
    precipitationProbabilityMax: daily.precipitation_probability_max?.[index],
    windSpeed10mMax: daily.wind_speed_10m_max?.[index],
  }));
  const hourlyForecast = (hourly.time || []).slice(0, forecastDays * 24).map((time, index) => ({
    time,
    weatherCode: hourly.weather_code?.[index],
    weatherDescription: describeWeatherCode(hourly.weather_code?.[index]),
    temperature2m: hourly.temperature_2m?.[index],
    apparentTemperature: hourly.apparent_temperature?.[index],
    precipitation: hourly.precipitation?.[index],
    precipitationProbability: hourly.precipitation_probability?.[index],
    windSpeed10m: hourly.wind_speed_10m?.[index],
  }));
  return {
    provider: "open-meteo",
    source: "https://api.open-meteo.com/v1/forecast",
    fetchedAt: now().toISOString(),
    location,
    queryPlan: {
      relevance: plan.relevance,
      goal: plan.goal,
      absoluteTimeRange: plan.absoluteTimeRange,
      constraints: plan.constraints,
      forecastDays,
    },
    current: {
      time: current.time,
      temperature2m: current.temperature_2m,
      apparentTemperature: current.apparent_temperature,
      relativeHumidity2m: current.relative_humidity_2m,
      precipitation: current.precipitation,
      weatherCode: current.weather_code,
      weatherDescription: describeWeatherCode(current.weather_code),
      windSpeed10m: current.wind_speed_10m,
    },
    forecast,
    hourly: hourlyForecast,
    units: {
      temperature2m: currentUnits.temperature_2m || hourlyUnits.temperature_2m || dailyUnits.temperature_2m_max || "°C",
      apparentTemperature: currentUnits.apparent_temperature || hourlyUnits.apparent_temperature || dailyUnits.apparent_temperature_max || "°C",
      relativeHumidity2m: currentUnits.relative_humidity_2m || "%",
      precipitation: currentUnits.precipitation || hourlyUnits.precipitation || dailyUnits.precipitation_sum || "mm",
      precipitationProbability: hourlyUnits.precipitation_probability || dailyUnits.precipitation_probability_max || "%",
      windSpeed10m: currentUnits.wind_speed_10m || hourlyUnits.wind_speed_10m || dailyUnits.wind_speed_10m_max || "km/h",
    },
  };
}

function resolveForecastDaysForPlan(plan = {}) {
  const temporal = plan.absoluteTimeRange || {};
  const startDate = temporal.startDate ? Date.parse(`${temporal.startDate}T00:00:00Z`) : NaN;
  const endDate = temporal.endDate ? Date.parse(`${temporal.endDate}T00:00:00Z`) : NaN;
  if (Number.isFinite(startDate) && Number.isFinite(endDate)) {
    const daysUntilEnd = Math.ceil((endDate - startOfTodayUtc()) / 86_400_000);
    return clampForecastDays(Math.max(3, daysUntilEnd));
  }
  return 3;
}

function startOfTodayUtc() {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function clampForecastDays(days) {
  return Math.max(1, Math.min(16, Number.isFinite(days) ? Math.ceil(days) : 3));
}

export function shouldFetchWeatherData(body) {
  const parsed = body.parsedCommand || {};
  const route = resolveConversationRoute("", parsed);
  const isConversation = body.task === "conversation_general" || parsed.intent === "conversation.general";
  return isConversation && route.isWeather;
}

export function normalizeWeatherAdapterReasonCode(code) {
  return [
    "weather_timeout",
    "weather_upstream_error",
    "weather_location_not_found",
    "weather_location_ambiguous",
    "weather_location_needs_clarification",
  ].includes(code) ? code : "weather_upstream_error";
}

function formatWeatherValue(value, unit, fallback = "未知") {
  return value === undefined || value === null || value === "" ? fallback : `${value}${unit || ""}`;
}

export function formatWeatherSummary(weatherData, reason = "", query = "") {
  const current = weatherData.current || {};
  const units = weatherData.units || {};
  const location = weatherData.location?.city || "杭州";
  const forecast = weatherData.forecast || [];
  const formatDay = (day, label) => `${label}${day.weatherDescription || "天气数据已获取"}，${formatWeatherValue(day.temperatureMin, units.temperature2m || "°C")}到${formatWeatherValue(day.temperatureMax, units.temperature2m || "°C")}，降水概率最高${formatWeatherValue(day.precipitationProbabilityMax, units.precipitationProbability || "%")}。`;
  const plan = buildWeatherQueryPlan(query);
  if (plan.goal === "dressing_advice") {
    const dayIndex = /后天/.test(query) ? 2 : /明天/.test(query) ? 1 : /今天/.test(query) ? 0 : -1;
    const day = dayIndex >= 0 ? forecast[dayIndex] : null;
    const label = dayIndex === 2 ? "后天" : dayIndex === 1 ? "明天" : dayIndex === 0 ? "今天" : "当前";
    const { advice } = buildWeatherAdviceFromPolicy({ day, current });
    const weatherDescription = day?.weatherDescription || current.weatherDescription || "天气数据已获取";
    const temperatureBasis = day
      ? `${formatWeatherValue(day.temperatureMin, units.temperature2m || "°C")}到${formatWeatherValue(day.temperatureMax, units.temperature2m || "°C")}`
      : `气温${formatWeatherValue(current.temperature2m, units.temperature2m || "°C")}、体感${formatWeatherValue(current.apparentTemperature, units.apparentTemperature || "°C")}`;
    const defaultNote = weatherData.location?.defaulted ? "未提供地点，按杭州查询（非实时定位）。" : "";
    const reasonText = reason ? `降级原因：${reason}。` : "";
    return `${advice}${location}${label}${weatherDescription}，${temperatureBasis}。${defaultNote}${reasonText}`;
  }
  let detail;
  if (/未来(?:三天|3天|几天)/.test(query)) {
    detail = forecast.map((day, index) => formatDay(day, index === 0 ? "今天" : index === 1 ? "明天" : "后天")).join("");
  } else if (/周末|周六|周日|星期六|星期日|礼拜六|礼拜天|下周[一二三四五六日天]/.test(query)) {
    const plan = buildWeatherQueryPlan(query);
    const indices = selectForecastIndicesForTemporal(forecast, plan.absoluteTimeRange);
    detail = indices.length
      ? indices.map((index, position) => formatDay(forecast[index], labelForTemporalForecast(forecast[index], plan.absoluteTimeRange, position))).join("")
      : `${plan.absoluteTimeRange?.label || "目标日期"}预报暂不可用。`;
  } else if (/今晚|今天晚上|今晚间/.test(query)) {
    const tonightHours = selectTonightHours(weatherData);
    detail = tonightHours.length
      ? formatHourlyWindow(tonightHours, "今晚", units)
      : "今晚逐小时预报暂不可用。";
  } else if (/后天/.test(query)) {
    detail = forecast[2] ? formatDay(forecast[2], "后天") : "后天预报暂不可用。";
  } else if (/明天/.test(query)) {
    detail = forecast[1] ? formatDay(forecast[1], "明天") : "明天预报暂不可用。";
  } else if (/今天/.test(query)) {
    detail = forecast[0] ? formatDay(forecast[0], "今天") : "今天预报暂不可用。";
  } else {
    detail = `当前${current.weatherDescription || "天气数据已获取"}，气温${formatWeatherValue(current.temperature2m, units.temperature2m || "°C")}，体感${formatWeatherValue(current.apparentTemperature, units.apparentTemperature || "°C")}。`;
  }
  const defaultNote = weatherData.location?.defaulted ? "未提供地点，按杭州查询（非实时定位）。" : "";
  const reasonText = reason ? `降级原因：${reason}。` : "";
  return `${location}${detail}${defaultNote}${reasonText}`;
}

export function isOpenWeatherQuestion(query = "") {
  return /建议|适合|要不要|能否|可以吗|应该|怎么(?:穿|准备|安排|办)|注意|比较|相比|哪个(?:更)?好|为什么|原因|穿衣|衣服|穿什么|出行|出门|运动|跑步|骑车|洗车|散步|旅游|游玩|露营|带伞/.test(String(query));
}

function buildWeatherAdviceContext(query = "") {
  const text = String(query || "");
  const specialCareProfiles = [
    [/老人|老年|长辈|父母/, "elderly"],
    [/孩子|儿童|小孩|婴儿|宝宝/, "child"],
    [/孕妇|怀孕|孕期/, "pregnancy"],
    [/哮喘|过敏|心脏|高血压|慢性病|病人/, "medical"],
  ].filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  const activityProfiles = [
    [/跑步|慢跑|长跑|马拉松/, "running"],
    [/骑车|骑行|自行车|电单车/, "cycling"],
    [/露营|营地|户外过夜/, "camping"],
    [/徒步|爬山|登山|越野/, "hiking"],
    [/散步|步行/, "walking"],
  ].filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  const activityIntensity = /高强度|剧烈|长跑|马拉松|训练|越野/.test(text)
    ? "high"
    : activityProfiles.length
      ? "activity_profile_required"
      : "unspecified";
  const requiresPersonalizationBoundary = specialCareProfiles.length > 0 || activityProfiles.length > 0 || activityIntensity === "high";
  return {
    policyId: WEATHER_ADVICE_POLICY.id,
    audienceAssumption: WEATHER_ADVICE_POLICY.appliesTo.audience,
    personalizationStatus: "not_provided",
    specialCareProfiles,
    activityProfiles,
    activityIntensity,
    requiresPersonalizationBoundary,
    boundaryText: requiresPersonalizationBoundary
      ? "未接入个人健康、偏好或活动强度画像，只能按健康成人通用出行建议参考。"
      : "",
  };
}

function selectTonightHours(weatherData = {}) {
  const forecastDate = weatherData.forecast?.[0]?.date || weatherData.current?.time?.slice(0, 10) || "";
  return (weatherData.hourly || []).filter((hour) => {
    const time = String(hour.time || "");
    const hourOfDay = Number(time.slice(11, 13));
    return time.startsWith(forecastDate) && Number.isFinite(hourOfDay) && hourOfDay >= 18 && hourOfDay <= 23;
  });
}

function formatHourlyWindow(hours = [], label = "该时段", units = {}) {
  const numbers = (key) => hours.map((hour) => Number(hour[key])).filter(Number.isFinite);
  const temperatures = numbers("temperature2m");
  const precipitationProbabilities = numbers("precipitationProbability");
  const windSpeeds = numbers("windSpeed10m");
  const weatherHour = [...hours]
    .sort((left, right) => Number(right.precipitationProbability || 0) - Number(left.precipitationProbability || 0))[0] || hours[0] || {};
  const minTemp = temperatures.length ? Math.min(...temperatures) : null;
  const maxTemp = temperatures.length ? Math.max(...temperatures) : null;
  const maxPrecipitationProbability = precipitationProbabilities.length ? Math.max(...precipitationProbabilities) : null;
  const maxWindSpeed = windSpeeds.length ? Math.max(...windSpeeds) : null;
  const temperatureText = minTemp != null && maxTemp != null
    ? `${formatWeatherValue(minTemp, units.temperature2m || "°C")}到${formatWeatherValue(maxTemp, units.temperature2m || "°C")}`
    : "温度暂不可用";
  const precipitationText = maxPrecipitationProbability != null
    ? `，降水概率最高${formatWeatherValue(maxPrecipitationProbability, units.precipitationProbability || "%")}`
    : "";
  const windText = maxWindSpeed != null
    ? `，最大风速${formatWeatherValue(maxWindSpeed, units.windSpeed10m || "km/h")}`
    : "";
  return `${label}${weatherHour.weatherDescription || "逐小时天气已获取"}，${temperatureText}${precipitationText}${windText}。`;
}

function selectForecastIndicesForTemporal(forecast = [], temporal = {}) {
  if (!temporal?.startDate || !temporal?.endDate) return [];
  return forecast
    .map((day, index) => ({ date: day?.date, index }))
    .filter(({ date }) => typeof date === "string" && date >= temporal.startDate && date < temporal.endDate)
    .map(({ index }) => index);
}

function labelForTemporalForecast(day, temporal = {}, index = 0, forecastIndex = index) {
  if (temporal.kind === "comparison") {
    if (temporal.label === "周末比较") return index === 0 ? "周六" : "周日";
    if (forecastIndex === 0) return "今天";
    if (forecastIndex === 1) return "明天";
    if (forecastIndex === 2) return "后天";
  }
  if (temporal.kind === "weekend") {
    if (/六|Saturday/i.test(day?.date || "") || index === 0) return "周六";
    if (/日|Sunday/i.test(day?.date || "") || index === 1) return "周日";
  }
  return temporal.label || day?.date || "目标日期";
}

export function buildWeatherFactPack(weatherData, query = "") {
  const text = String(query);
  const forecast = weatherData.forecast || [];
  const hourly = weatherData.hourly || [];
  const adviceContext = buildWeatherAdviceContext(text);

  // HC-P1-07: use structured WeatherQueryPlan for temporal resolution
  const plan = buildWeatherQueryPlan(text, weatherData.location?.requestedName ?? null);
  const temporal = plan.absoluteTimeRange;

  let indices = [];
  let targetLabel = temporal.label || "当前";
  let targetKind = temporal.kind === "default-3day" ? "range" : temporal.kind === "comparison" ? "comparison" : "current";

  if (temporal.kind === "default-3day" || temporal.kind === "range") {
    indices = [0, 1, 2]; targetKind = "range";
  } else if (temporal.kind === "comparison") {
    indices = selectForecastIndicesForTemporal(forecast, temporal);
    if (indices.length < 2) {
      indices = [0, 1, 2].filter((index) => {
        const marker = index === 0 ? /今天/ : index === 1 ? /明天/ : /后天/;
        return marker.test(text);
      });
    }
    if (indices.length < 2) indices = [0, 1];
    targetKind = "comparison";
  } else if (temporal.kind === "relative-day") {
    // Map temporal label to forecast index
    if (/后天/.test(temporal.label)) indices = [2];
    else if (/明天/.test(temporal.label)) indices = [1];
    else if (/今天/.test(temporal.label)) indices = [0];
    else indices = [0];
    targetKind = "day";
  } else if (temporal.kind === "weekend" || temporal.kind === "next-weekday") {
    indices = selectForecastIndicesForTemporal(forecast, temporal);
    targetKind = temporal.kind === "weekend" ? "range" : "day";
    targetLabel = temporal.label;
  } else if (temporal.kind === "tonight") {
    targetKind = "hourly";
    targetLabel = "今晚";
  } else if (/后天/.test(text)) {
    indices = [2]; targetLabel = "后天"; targetKind = "day";
  } else if (/明天/.test(text)) {
    indices = [1]; targetLabel = "明天"; targetKind = "day";
  } else if (/今天/.test(text)) {
    indices = [0]; targetLabel = "今天"; targetKind = "day";
  }

  const pick = (object, keys) => Object.fromEntries(keys
    .filter((key) => object?.[key] !== undefined && object?.[key] !== null)
    .map((key) => [key, object[key]]));

  const forecastSlice = indices.map((index, sliceIndex) => ({
    ...pick(forecast[index], [
      "date", "weatherDescription", "temperatureMax", "temperatureMin",
      "apparentTemperatureMax", "apparentTemperatureMin", "precipitationSum",
      "precipitationProbabilityMax", "windSpeed10mMax",
    ]),
    label: labelForTemporalForecast(forecast[index], temporal, sliceIndex, index),
  }));
  const hourlySlice = temporal.kind === "tonight"
    ? selectTonightHours(weatherData).map((hour) => pick(hour, [
      "time", "weatherDescription", "temperature2m", "apparentTemperature",
      "precipitation", "precipitationProbability", "windSpeed10m",
    ]))
    : [];

  // HC-P1-08: structured claims — each value is traceable to a fieldPath/date/unit
  const claims = [];
  forecastSlice.forEach((day, sliceIndex) => {
    const dateStr = day.date || "unknown-date";
    const forecastIndex = indices[sliceIndex];
    for (const [field, value] of Object.entries(day)) {
      if (typeof value === "number" && field !== "date") {
        claims.push({
          fieldPath: `forecast.${field}`,
          date: dateStr,
          dateTerms: dateTermsForForecastClaim(forecastIndex, day, temporal, sliceIndex),
          fieldValue: value,
          unit: unitForWeatherField(field, weatherData.units),
          associatedTerms: fieldTermsForClaim(field),
          fieldGroup: fieldGroupForWeatherField(field),
          mandatoryContext: ["temperature", "apparentTemperature"].some((t) => field.includes(t)),
        });
      }
    }
  });
  for (const hour of hourlySlice) {
    const dateStr = hour.time || "unknown-hour";
    for (const [field, value] of Object.entries(hour)) {
      if (typeof value === "number") {
        claims.push({
          fieldPath: `hourly.${field}`,
          date: dateStr,
          dateTerms: ["今晚", "今天晚上", String(hour.time || "").slice(0, 10)].filter(Boolean),
          fieldValue: value,
          unit: unitForWeatherField(field, weatherData.units),
          associatedTerms: fieldTermsForClaim(field),
          fieldGroup: fieldGroupForWeatherField(field),
          mandatoryContext: ["temperature", "apparentTemperature"].some((t) => field.includes(t)),
        });
      }
    }
  }
  // Current values
  const currentSlice = pick(weatherData.current || {}, [
    "time", "weatherDescription", "temperature2m", "apparentTemperature",
    "precipitation", "windSpeed10m",
  ]);
  for (const [field, value] of Object.entries(currentSlice)) {
    if (typeof value === "number") {
      claims.push({
        fieldPath: `current.${field}`,
        date: currentSlice.time || "current",
        dateTerms: ["当前", "现在", "实时", String(currentSlice.time || "").slice(0, 10)].filter(Boolean),
        fieldValue: value,
        unit: unitForWeatherField(field, weatherData.units),
        associatedTerms: fieldTermsForClaim(field),
        fieldGroup: fieldGroupForWeatherField(field),
        mandatoryContext: ["temperature", "apparentTemperature"].some((t) => field.includes(t)),
      });
    }
  }

  // HC-P1-08: missingFields must describe data absent from the current FactPack,
  // not only fields mentioned by the user. This prevents the composer from
  // claiming UV, air quality or official warning facts that Open-Meteo did not provide.
  const missingFields = ["uvIndex", "airQuality", "officialWarning"];

  return {
    location: {
      city: weatherData.location?.city || "未知城市",
      resolution: weatherData.location?.resolution,
      defaulted: weatherData.location?.defaulted === true,
      requestedName: weatherData.location?.requestedName ?? null,
      note: weatherData.location?.note,
      // HC-P1-07: needsClarification is based on RESOLVED location state,
      // not raw query plan — if the location was resolved (even as default), no clarification needed.
      needsClarification: weatherData.location?.needsClarification === true,
    },
    target: {
      kind: targetKind,
      label: targetLabel,
      dates: hourlySlice.length
        ? [...new Set(hourlySlice.map((hour) => String(hour.time || "").slice(0, 10)).filter(Boolean))]
        : indices.map((index) => forecast[index]?.date).filter(Boolean),
    },
    current: currentSlice,
    forecast: forecastSlice,
    hourly: hourlySlice,
    units: pick(weatherData.units, [
      "temperature2m", "apparentTemperature", "precipitation",
      "precipitationProbability", "windSpeed10m",
    ]),
    source: weatherData.provider || "open-meteo",
    sourceUrl: weatherData.source,
    fetchedAt: weatherData.fetchedAt,
    queryPlan: { relevance: plan.relevance, goal: plan.goal, constraints: plan.constraints },
    adviceContext,
    claims,  // HC-P1-08: structured claims for grounding validation
    missingFields,
  };
}

function dateTermsForForecastClaim(forecastIndex, day = {}, temporal = {}, sliceIndex = 0) {
  const terms = [day.date].filter(Boolean);
  if (day.label) terms.push(day.label);
  if (forecastIndex === 0) terms.push("今天", "今日");
  if (forecastIndex === 1) terms.push("明天", "明日");
  if (forecastIndex === 2) terms.push("后天", "后日");
  if (temporal.kind === "weekend" || temporal.label === "周末比较") {
    if (sliceIndex === 0) terms.push("周六", "星期六", "礼拜六");
    if (sliceIndex === 1) terms.push("周日", "星期日", "礼拜天", "礼拜日");
  }
  if (temporal.kind === "next-weekday" && temporal.label) terms.push(temporal.label);
  return [...new Set(terms.filter(Boolean))];
}

// HC-P1-08: map weather field names to Chinese terms for claim context validation
function fieldTermsForClaim(field) {
  const map = {
    temperature2m: ["温度", "气温", "度", "°C", "°"],
    temperatureMax: ["最高温", "高温", "最高气温", "度", "°C", "°", "到"],
    temperatureMin: ["最低温", "低温", "最低气温", "度", "°C", "°", "到"],
    apparentTemperature: ["体感", "体感温度", "感觉", "°C", "°"],
    apparentTemperatureMax: ["体感最高", "最高体感", "°C", "°"],
    apparentTemperatureMin: ["体感最低", "最低体感", "°C", "°"],
    precipitation: ["降水", "降雨", "毫米", "mm"],
    precipitationSum: ["降水量", "降雨量", "毫米", "mm"],
    precipitationProbabilityMax: ["降水概率", "降雨概率", "下雨", "%"],
    windSpeed10m: ["风速", "风力", "风"],
    windSpeed10mMax: ["最大风速", "最大风力"],
  };
  return map[field] || [];
}

function unitForWeatherField(field, units = {}) {
  if (/temperature/i.test(field)) return units.temperature2m || units.apparentTemperature || "°C";
  if (/precipitationProbability/i.test(field)) return units.precipitationProbability || "%";
  if (/precipitation/i.test(field)) return units.precipitation || "mm";
  if (/windSpeed/i.test(field)) return units.windSpeed10m || "km/h";
  if (/humidity/i.test(field)) return units.relativeHumidity2m || "%";
  return units[field] || "";
}

function fieldGroupForWeatherField(field = "") {
  if (/precipitationProbability/i.test(field)) return "precipitationProbability";
  if (/precipitation/i.test(field)) return "precipitation";
  if (/apparentTemperatureMax/i.test(field)) return "apparentTemperatureMax";
  if (/apparentTemperatureMin/i.test(field)) return "apparentTemperatureMin";
  if (/apparentTemperature/i.test(field)) return "apparentTemperature";
  if (/temperatureMax/i.test(field)) return "temperatureMax";
  if (/temperatureMin/i.test(field)) return "temperatureMin";
  if (/temperature/i.test(field)) return "temperature";
  if (/windSpeed/i.test(field)) return "windSpeed";
  if (/humidity/i.test(field)) return "humidity";
  return field;
}

function isWeatherFieldGroupCompatible(expected = "", actual = "") {
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  if (expected === "temperature") return /^temperature(?:Max|Min)?$/.test(actual);
  if (expected === "apparentTemperature") return /^apparentTemperature(?:Max|Min)?$/.test(actual);
  return false;
}

export function buildWeatherComposerPrompt(query, factPack) {
  const defaultCity = factPack.location?.city || "杭州";
  return [
    "你是车载天气回答组合器。请直接回答用户问题，使用自然中文，1-3句且适合语音播报。",
    "只能使用 WEATHER_FACT_PACK 中的事实；不得补充不存在的数字、紫外线、空气质量、官方预警或实时定位。",
    "如果输出数字事实，可返回 JSON：{\"response\":\"自然中文回答\",\"answerClaims\":[{\"fieldPath\":\"forecast.precipitationProbabilityMax\",\"fieldValue\":80,\"unit\":\"%\",\"dateTerm\":\"明天\"}]}；否则直接返回自然中文。",
    `如果 location.defaulted=true，回答必须明确说明：未提供地点，默认${defaultCity}（非实时定位）。`,
    "可以基于已有温度、体感、降水和风速，按 WEATHER_ADVICE_POLICY 给出谨慎建议；不要把启发式建议表述成额外实时事实。",
    "如果 WEATHER_FACT_PACK.adviceContext.requiresPersonalizationBoundary=true，回答必须说明未接入个人健康、偏好或活动强度画像，只能按健康成人通用出行建议参考。",
    "如果比较哪一天更适合出行，结论必须符合 WEATHER_COMPARISON_GROUNDING_POLICY；不要在依据不足时强行推荐。",
    "不得声称已经执行任何车辆动作。不要输出 Markdown、数据来源附录或思考过程。",
    `用户问题：${String(query).trim()}`,
    `WEATHER_ADVICE_POLICY：${JSON.stringify(WEATHER_ADVICE_POLICY)}`,
    `WEATHER_COMPARISON_GROUNDING_POLICY：${JSON.stringify(WEATHER_COMPARISON_GROUNDING_POLICY)}`,
    `WEATHER_FACT_PACK：${JSON.stringify(factPack)}`,
  ].join("\n");
}

// HC-P1-08: claim-level weather grounding validator.
// Each claim must be traceable to a specific field value in the fact pack.
// This replaces the old number-set-only check with fieldPath/date/value/unit resolution.
export function validateWeatherComposedAnswer(answer, factPack, { answerClaims = null } = {}) {
  const text = String(answer || "").trim();
  const unsupported = [];
  if (!text) unsupported.push("empty");
  if (text.length > 180) unsupported.push("too_long");

  const structuredClaimProblems = validateWeatherAnswerClaims(answerClaims, factPack);
  unsupported.push(...structuredClaimProblems);
  const comparisonProblems = validateWeatherComparisonClaim(text, factPack);
  unsupported.push(...comparisonProblems);

  const missingTerms = {
    // HC-P1-08: missing-field claims are often qualitative, not numeric
    // ("AQI 很好", "没有预警", "需要防晒"). Treat those as unsupported too.
    uvIndex: /紫外线|UV|防晒|晒伤/i,
    airQuality: /空气质量|空气污染|空气(?:优|良|差)|AQI|雾霾|PM2\.?5/i,
    officialWarning: /(?:官方|气象)?预警|警报|红色预警|橙色预警|黄色预警|蓝色预警/,
  };
  for (const field of (factPack.missingFields || [])) {
    if (missingTerms[field]?.test(text)) unsupported.push(`missing_field:${field}`);
  }

  if (factPack.adviceContext?.requiresPersonalizationBoundary === true) {
    const hasPersonalizationBoundary = /(?:未接入|没有|缺少|未提供).{0,18}(?:个人|健康|偏好|画像|人群|活动强度|训练)|(?:个人|健康|偏好|画像|人群|活动强度|训练).{0,18}(?:未接入|没有|缺少|未提供)/.test(text);
    if (!hasPersonalizationBoundary) unsupported.push("missing_advice_personalization_boundary");
  }

  // HC-P1-07: dynamic default-city boundary check (was hardcoded "默认杭州")
  const defaultCity = factPack.location?.city || "杭州";
  const boundaryPattern = new RegExp(`默认${defaultCity}.*非实时定位|非实时定位.*默认${defaultCity}`);
  if (factPack.location?.defaulted === true && !boundaryPattern.test(text)) {
    unsupported.push("missing_default_location_boundary");
  }
  if (/(?:已|已经|为你|帮你).{0,6}(?:打开|关闭|调节|设置|启动|执行).{0,8}(?:车窗|空调|尾门|天窗|车辆)|(?:车窗|空调|尾门|天窗).{0,6}(?:已|已经)(?:打开|关闭|调节|设置)/.test(text)) {
    unsupported.push("vehicle_action_claim");
  }

  // HC-P1-08: claim-level validation — each number must be traceable to a specific field
  const allowedNumbers = new Set((JSON.stringify(factPack).match(/-?\d+(?:\.\d+)?/g) || []).map(Number));
  const responseNumbers = extractWeatherNumericMentions(text);
  for (const mention of responseNumbers) {
    const { token, value, contextWindow, rightContext, localTokenStart } = mention;
    if (!allowedNumbers.has(value)) unsupported.push(`unsupported_number:${token}`);
    const unitHint = /^(?:\s*)(?:°C|℃|摄氏度|度)/.test(rightContext) ? "°C"
      : /^(?:\s*)(?:%|％)/.test(rightContext) ? "%"
        : /^(?:\s*)(?:mm|毫米)/i.test(rightContext) ? "mm"
          : /^(?:\s*)(?:km\/h|公里每小时)/i.test(rightContext) ? "km/h"
            : "";
    if (unitHint && factPack.claims) {
      const matchingUnitClaim = factPack.claims.some((claim) =>
        claim.fieldValue === value && normalizeWeatherUnit(claim.unit) === unitHint);
      if (!matchingUnitClaim) unsupported.push(`unit_mismatch:${token}${unitHint}`);
    }

    const dateTerm = detectWeatherDateTerm(contextWindow, factPack.claims, localTokenStart);
    const fieldGroup = detectWeatherFieldGroup(contextWindow);
    if (dateTerm && fieldGroup && factPack.claims) {
      const matchingClaim = factPack.claims.some((claim) => (
        claim.fieldValue === value
        && (!unitHint || normalizeWeatherUnit(claim.unit) === unitHint)
        && isWeatherFieldGroupCompatible(fieldGroup, claim.fieldGroup)
        && (claim.dateTerms || []).includes(dateTerm)
      ));
      if (!matchingClaim) {
        unsupported.push(`date_field_mismatch:${dateTerm}/${fieldGroup}/${token}${unitHint || ""}`);
      }
    }
    if (Array.isArray(answerClaims) && answerClaims.length > 0 && !isWeatherMentionCoveredByAnswerClaim(mention, answerClaims, factPack)) {
      unsupported.push(`unclaimed_number:${token}`);
    }
  }

  // HC-P1-08: claim-to-field validation for structured facts
  if (factPack.claims) {
    for (const claim of factPack.claims) {
      if (typeof claim.fieldValue === "number" && text.includes(String(claim.fieldValue))) {
        // Verify the context — is the number associated with the right field?
        if (claim.fieldPath && claim.associatedTerms) {
          // Check full-text for temperature/weather context first (handles "气温26到35°C" range patterns)
          const hasFullContext = claim.associatedTerms.some((term) => text.includes(term));
          if (!hasFullContext && claim.mandatoryContext === true) {
            // Narrow check: look at context window around the numeric value
            const idx = text.indexOf(String(claim.fieldValue));
            const contextWindow = text.slice(
              Math.max(0, idx - 20),
              Math.min(text.length, idx + String(claim.fieldValue).length + 20),
            );
            const hasNearContext = claim.associatedTerms.some((term) => contextWindow.includes(term));
            if (!hasNearContext) {
              unsupported.push(`misattributed_value:${claim.fieldValue} (expected context: ${claim.fieldPath})`);
            }
          }
        }
      }
    }
  }

  // HC-P1-07: when location was unresolved, the answer must request clarification (not invent a city)
  if (factPack.location?.needsClarification === true) {
    if (!/[？?]/.test(text) || !/(?:哪个|哪个城市|哪里|什么地方|什么地点|具体)/.test(text)) {
      unsupported.push("missing_location_clarification");
    }
  }

  return { ok: unsupported.length === 0, unsupported: [...new Set(unsupported)] };
}

function validateWeatherAnswerClaims(answerClaims, factPack) {
  if (answerClaims == null) return [];
  if (!Array.isArray(answerClaims)) return ["answer_claims_invalid"];
  const unsupported = [];
  answerClaims.slice(0, 16).forEach((claim, index) => {
    if (!claim || typeof claim !== "object") {
      unsupported.push(`answer_claim_invalid:${index}`);
      return;
    }
    const fieldPath = String(claim.fieldPath || "").trim();
    const rawValue = claim.fieldValue ?? claim.value;
    const fieldValue = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!fieldPath) unsupported.push(`answer_claim_missing_fieldPath:${index}`);
    if (!Number.isFinite(fieldValue)) unsupported.push(`answer_claim_missing_fieldValue:${index}`);
    if (!fieldPath || !Number.isFinite(fieldValue)) return;
    const unit = claim.unit ? normalizeWeatherUnit(claim.unit) : "";
    const dateTerms = normalizeAnswerClaimDateTerms(claim);
    const matched = (factPack.claims || []).some((factClaim) => (
      factClaim.fieldPath === fieldPath
      && factClaim.fieldValue === fieldValue
      && (!unit || normalizeWeatherUnit(factClaim.unit) === unit)
      && (!dateTerms.length || dateTerms.some((term) => weatherClaimHasDateTerm(factClaim, term)))
    ));
    if (!matched) unsupported.push(`answer_claim_unbound:${fieldPath}/${fieldValue}${unit || ""}`);
  });
  if (Array.isArray(answerClaims) && answerClaims.length > 16) unsupported.push("answer_claims_too_many");
  return unsupported;
}

function validateWeatherComparisonClaim(text = "", factPack = {}) {
  if (factPack.target?.kind !== "comparison" || (factPack.forecast || []).length < 2) return [];
  const normalized = String(text || "").replace(/\s+/g, "");
  const claim = extractWeatherComparisonPreference(normalized);
  if (!claim) return [];
  const recommendation = buildWeatherComparisonRecommendation(factPack);
  if (!recommendation) return ["comparison_unavailable"];
  if (claim.label !== recommendation.label) {
    return [`comparison_mismatch:${claim.label}->${recommendation.label}`];
  }
  return [];
}

function extractWeatherComparisonPreference(text = "") {
  const contrastPatterns = [
    { label: "今天", pattern: /今天.*比明天.*(?:更适合|更好|更推荐)/ },
    { label: "今天", pattern: /今天.*比后天.*(?:更适合|更好|更推荐)/ },
    { label: "明天", pattern: /明天.*比今天.*(?:更适合|更好|更推荐)/ },
    { label: "明天", pattern: /明天.*比后天.*(?:更适合|更好|更推荐)/ },
    { label: "后天", pattern: /后天.*比今天.*(?:更适合|更好|更推荐)/ },
    { label: "后天", pattern: /后天.*比明天.*(?:更适合|更好|更推荐)/ },
    { label: "周六", pattern: /周六.*比周日.*(?:更适合|更好|更推荐)/ },
    { label: "周日", pattern: /周日.*比周六.*(?:更适合|更好|更推荐)/ },
  ];
  const contrast = contrastPatterns.find((item) => item.pattern.test(text));
  if (contrast) return contrast;
  const patterns = [
    { label: "今天", pattern: /今天.{0,12}(?:更适合|更好|更推荐|推荐|适合).*?(?:出行|户外|骑车|散步|安排|活动)?/ },
    { label: "明天", pattern: /明天.{0,12}(?:更适合|更好|更推荐|推荐|适合).*?(?:出行|户外|骑车|散步|安排|活动)?/ },
    { label: "后天", pattern: /后天.{0,12}(?:更适合|更好|更推荐|推荐|适合).*?(?:出行|户外|骑车|散步|安排|活动)?/ },
    { label: "今天", pattern: /(?:更适合|更好|更推荐|推荐)今天/ },
    { label: "明天", pattern: /(?:更适合|更好|更推荐|推荐)明天/ },
    { label: "后天", pattern: /(?:更适合|更好|更推荐|推荐)后天/ },
    { label: "周六", pattern: /周六.{0,12}(?:更适合|更好|更推荐|推荐|适合).*?(?:出行|户外|骑车|散步|安排|活动)?/ },
    { label: "周日", pattern: /周日.{0,12}(?:更适合|更好|更推荐|推荐|适合).*?(?:出行|户外|骑车|散步|安排|活动)?/ },
    { label: "周六", pattern: /(?:更适合|更好|更推荐|推荐)周六/ },
    { label: "周日", pattern: /(?:更适合|更好|更推荐|推荐)周日/ },
  ];
  return patterns.find((item) => item.pattern.test(text)) || null;
}

function buildWeatherComparisonRecommendation(factPack = {}) {
  const days = (factPack.forecast || []).slice(0, 3);
  if (days.length < 2) return null;
  const scored = days.map((day, index) => ({
    label: comparisonLabelForDay(day, index),
    date: day.date,
    score: scoreWeatherComparisonDay(day),
  })).filter((item) => Number.isFinite(item.score));
  scored.sort((left, right) => left.score - right.score);
  if (!scored.length) return null;
  return {
    policy: WEATHER_COMPARISON_GROUNDING_POLICY,
    ...scored[0],
    candidates: scored,
  };
}

function comparisonLabelForDay(day = {}, index = 0) {
  if (day.label) return day.label;
  const terms = (day.date ? [] : ["目标日期"]);
  const claim = (day.date && typeof day.date === "string")
    ? null
    : null;
  if (index === 0) return "今天";
  if (index === 1) return "明天";
  if (index === 2) return "后天";
  return terms[0] || day.date || "目标日期";
}

function scoreWeatherComparisonDay(day = {}) {
  const factors = WEATHER_COMPARISON_GROUNDING_POLICY.factors;
  const maxTemp = Number(day.temperatureMax);
  const minTemp = Number(day.temperatureMin);
  const avgTemp = Number.isFinite(maxTemp) && Number.isFinite(minTemp)
    ? (maxTemp + minTemp) / 2
    : Number.NaN;
  const comfortPenalty = Number.isFinite(avgTemp)
    ? Math.max(0, factors.comfortTemperatureMin - avgTemp, avgTemp - factors.comfortTemperatureMax)
    : 0;
  return (Number(day.precipitationProbabilityMax || 0) * factors.precipitationProbabilityWeight)
    + (Number(day.precipitationSum || 0) * factors.precipitationSumWeight)
    + (Number(day.windSpeed10mMax || 0) * factors.windSpeedWeight)
    + (comfortPenalty * 5);
}

function normalizeAnswerClaimDateTerms(claim = {}) {
  const rawTerms = [
    claim.dateTerm,
    claim.date,
    ...(Array.isArray(claim.dateTerms) ? claim.dateTerms : []),
  ];
  return [...new Set(rawTerms
    .map((term) => normalizeWeatherDateTerm(String(term || "").trim()))
    .filter(Boolean))];
}

function weatherClaimHasDateTerm(factClaim = {}, term = "") {
  const normalized = normalizeWeatherDateTerm(term);
  return (factClaim.dateTerms || []).some((item) => normalizeWeatherDateTerm(item) === normalized)
    || normalizeWeatherDateTerm(factClaim.date) === normalized;
}

function isWeatherMentionCoveredByAnswerClaim(mention, answerClaims, factPack) {
  const unitHint = /^(?:\s*)(?:°C|℃|摄氏度|度)/.test(mention.rightContext) ? "°C"
    : /^(?:\s*)(?:%|％)/.test(mention.rightContext) ? "%"
      : /^(?:\s*)(?:mm|毫米)/i.test(mention.rightContext) ? "mm"
        : /^(?:\s*)(?:km\/h|公里每小时)/i.test(mention.rightContext) ? "km/h"
          : "";
  const dateTerm = detectWeatherDateTerm(mention.contextWindow, factPack.claims, mention.localTokenStart);
  const fieldGroup = detectWeatherFieldGroup(mention.contextWindow);
  return answerClaims.some((claim) => {
    const fieldValue = typeof claim?.fieldValue === "number" ? claim.fieldValue : Number(claim?.fieldValue ?? claim?.value);
    if (fieldValue !== mention.value) return false;
    if (unitHint && normalizeWeatherUnit(claim.unit) !== unitHint) return false;
    if (dateTerm && !normalizeAnswerClaimDateTerms(claim).some((term) => term === dateTerm)) return false;
    if (fieldGroup) {
      const factClaim = (factPack.claims || []).find((item) => item.fieldPath === claim.fieldPath && item.fieldValue === fieldValue);
      if (factClaim && !isWeatherFieldGroupCompatible(fieldGroup, factClaim.fieldGroup)) return false;
    }
    return true;
  });
}

function extractWeatherNumericMentions(text = "") {
  const mentions = [];
  const pattern = /-?\d+(?:\.\d+)?/g;
  let match;
  while ((match = pattern.exec(text))) {
    const token = match[0];
    const index = match.index;
    const windowStart = Math.max(0, index - 12);
    const windowEnd = Math.min(text.length, index + token.length + 12);
    mentions.push({
      token,
      value: Number(token),
      index,
      contextWindow: text.slice(windowStart, windowEnd),
      localTokenStart: index - windowStart,
      rightContext: text.slice(index + token.length, Math.min(text.length, index + token.length + 8)),
      sentenceWindow: text.slice(
        Math.max(0, index - 28),
        Math.min(text.length, index + token.length + 28),
      ),
    });
  }
  return mentions;
}

function detectWeatherDateTerm(context = "", claims = [], tokenOffset = -1) {
  const builtIn = ["今天", "今日", "明天", "明日", "后天", "后日", "今晚", "今天晚上", "周六", "星期六", "礼拜六", "周日", "星期日", "礼拜天", "礼拜日"];
  const claimTerms = [...new Set((claims || []).flatMap((claim) => claim.dateTerms || []))]
    .filter((term) => /^\d{4}-\d{2}-\d{2}$/.test(term) || /^下周[一二三四五六日天]$/.test(term));
  const terms = [...builtIn, ...claimTerms];
  const matches = [];
  for (const term of terms) {
    let index = context.indexOf(term);
    while (index >= 0) {
      matches.push({ term, index });
      index = context.indexOf(term, index + term.length);
    }
  }
  if (!matches.length) return "";
  if (!Number.isFinite(tokenOffset) || tokenOffset < 0) return normalizeWeatherDateTerm(matches[0].term);
  matches.sort((left, right) => {
    const leftBefore = left.index <= tokenOffset ? 0 : 1;
    const rightBefore = right.index <= tokenOffset ? 0 : 1;
    if (leftBefore !== rightBefore) return leftBefore - rightBefore;
    const leftDistance = Math.abs(left.index - tokenOffset);
    const rightDistance = Math.abs(right.index - tokenOffset);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return 0;
  });
  return normalizeWeatherDateTerm(matches[0].term);
}

function normalizeWeatherDateTerm(term = "") {
  const map = {
    今日: "今天",
    明日: "明天",
    后日: "后天",
    今天晚上: "今晚",
    星期六: "周六",
    礼拜六: "周六",
    星期日: "周日",
    礼拜天: "周日",
    礼拜日: "周日",
  };
  return map[term] || term;
}

function detectWeatherFieldGroup(context = "") {
  if (/降水概率|降雨概率|下雨概率|下雨|带伞|雨伞/.test(context)) return "precipitationProbability";
  if (/降水量|降雨量|雨量|毫米|mm/i.test(context)) return "precipitation";
  if (/体感最高|最高体感/.test(context)) return "apparentTemperatureMax";
  if (/体感最低|最低体感/.test(context)) return "apparentTemperatureMin";
  if (/体感/.test(context)) return "apparentTemperature";
  if (/最高温|最高气温|高温/.test(context)) return "temperatureMax";
  if (/最低温|最低气温|低温/.test(context)) return "temperatureMin";
  if (/温度|气温|最高温|最低温|高温|低温|°C|℃|摄氏度|度/.test(context)) return "temperature";
  if (/风速|风力|大风|风/.test(context)) return "windSpeed";
  if (/湿度/.test(context)) return "humidity";
  return "";
}

function normalizeWeatherUnit(unit) {
  const normalized = String(unit || "").trim();
  if (["°C", "℃", "摄氏度", "度"].includes(normalized)) return "°C";
  if (["%", "％"].includes(normalized)) return "%";
  if (["mm", "毫米"].includes(normalized)) return "mm";
  if (["km/h", "公里每小时"].includes(normalized)) return "km/h";
  return normalized;
}

export function weatherComposerFallback(weatherData, query, reason = "", factPack = buildWeatherFactPack(weatherData, query)) {
  const personalizationBoundary = factPack.adviceContext?.boundaryText || "";
  const appendPersonalizationBoundary = (text) => `${text}${personalizationBoundary}`;
  if (/穿衣|衣服|穿什么|怎么穿/.test(query)) {
    return appendPersonalizationBoundary(formatWeatherSummary(weatherData, reason, query));
  }
  if (["comparison", "range"].includes(factPack.target?.kind)) {
    const units = weatherData.units || {};
    const facts = (factPack.forecast || []).map((day) => {
      const label = day.label || day.date || "目标日期";
      return `${label}${day.weatherDescription || "天气数据已获取"}，${formatWeatherValue(day.temperatureMin, units.temperature2m || "°C")}到${formatWeatherValue(day.temperatureMax, units.temperature2m || "°C")}，降水概率最高${formatWeatherValue(day.precipitationProbabilityMax, units.precipitationProbability || "%")}。`;
    }).join("");
    const location = factPack.location?.city || weatherData.location?.city || "杭州";
    const defaultNote = factPack.location?.defaulted ? "未提供地点，按杭州查询（非实时定位）。" : "";
    return appendPersonalizationBoundary(`${location}${facts}${defaultNote}当前只能依据这些天气数据提供建议，无法确认未提供的环境或预警信息。`);
  }
  const summary = formatWeatherSummary(weatherData, "", query);
  return appendPersonalizationBoundary(`${summary}当前只能依据这些天气数据提供建议，无法确认未提供的环境或预警信息。`);
}

function normalizeWeatherGroundingReason(reason) {
  const value = String(reason || "");
  if (value.startsWith("comparison_mismatch")) return "comparison-mismatch";
  if (value.startsWith("missing_advice_personalization_boundary")) return "personalization-boundary-missing";
  if (value.startsWith("answer_claim_unbound")) return "answer-claim-unbound";
  if (value.startsWith("missing_default_location_boundary")) return "default-location-boundary-missing";
  if (value.startsWith("date_field_mismatch")) return "date-field-mismatch";
  if (value.startsWith("missing_field")) return "weather-field-missing";
  return "unsupported-weather-claim";
}

export function normalizeWeatherGroundingReasons(reasons = []) {
  return [...new Set(reasons.slice(0, 64).map(normalizeWeatherGroundingReason))];
}

export function deriveWeatherAnswerClaimsFromText(answer, factPack) {
  const claims = [];
  const seen = new Set();
  for (const mention of extractWeatherNumericMentions(answer)) {
    const unitHint = /^(?:\s*)(?:°C|℃|摄氏度|度)/.test(mention.rightContext) ? "°C"
      : /^(?:\s*)(?:%|％)/.test(mention.rightContext) ? "%"
        : /^(?:\s*)(?:mm|毫米)/i.test(mention.rightContext) ? "mm"
          : /^(?:\s*)(?:km\/h|公里每小时)/i.test(mention.rightContext) ? "km/h"
            : "";
    const dateTerm = detectWeatherDateTerm(mention.contextWindow, factPack.claims, mention.localTokenStart)
      || inferSingleTargetWeatherDateTerm(factPack);
    const fieldGroup = detectWeatherFieldGroup(mention.contextWindow);
    const candidates = (factPack.claims || []).filter((claim) => (
      claim.fieldValue === mention.value
      && (!unitHint || normalizeWeatherUnit(claim.unit) === unitHint)
      && (!dateTerm || weatherClaimHasDateTerm(claim, dateTerm))
      && (!fieldGroup || isWeatherFieldGroupCompatible(fieldGroup, claim.fieldGroup))
    ));
    if (candidates.length !== 1) continue;
    const matched = candidates[0];
    const key = `${matched.fieldPath}:${matched.fieldValue}:${matched.unit}:${dateTerm || matched.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({
      fieldPath: matched.fieldPath,
      fieldValue: matched.fieldValue,
      unit: matched.unit,
      dateTerm: dateTerm || (matched.dateTerms || [])[0] || matched.date,
      source: "derived-from-text",
    });
  }
  return claims.slice(0, 16);
}

function inferSingleTargetWeatherDateTerm(factPack = {}) {
  const dates = factPack.target?.dates || [];
  if (dates.length !== 1) return "";
  const targetLabel = factPack.target?.label || "";
  if (/今天|明天|后天|今晚|周|下周/.test(targetLabel)) return normalizeWeatherDateTerm(targetLabel);
  const matchingClaim = (factPack.claims || []).find((claim) =>
    (claim.dateTerms || []).includes(dates[0]));
  return matchingClaim?.dateTerms?.[0] || dates[0];
}

export function normalizeWeatherComposerOutput(generated = {}) {
  const directClaims = Array.isArray(generated.answerClaims) ? generated.answerClaims : null;
  const raw = generated.response;
  if (raw && typeof raw === "object") {
    return {
      response: String(raw.response || raw.summary || "").trim(),
      answerClaims: Array.isArray(raw.answerClaims) ? raw.answerClaims : directClaims,
      structured: true,
    };
  }
  const text = String(raw || "").trim();
  if (/^\s*\{/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.response === "string") {
        return {
          response: parsed.response.trim(),
          answerClaims: Array.isArray(parsed.answerClaims) ? parsed.answerClaims : directClaims,
          structured: true,
        };
      }
    } catch {
      // Fall back to raw text; the validator will still catch unsupported claims.
    }
  }
  return { response: text, answerClaims: directClaims, structured: false };
}
