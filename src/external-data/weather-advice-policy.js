export const WEATHER_ADVICE_POLICY = Object.freeze({
  id: "nio-weather-advice-heuristic@1.0.0",
  provenance: "local-dev heuristic for concise in-car weather advice; not medical, occupational, child/elder-care, sports-training, or official warning guidance",
  appliesTo: Object.freeze({
    region: "general urban travel in China unless a product-specific policy overrides it",
    audience: "healthy adult default; no personal preference, activity intensity, or special-care profile is assumed",
    supportedInputs: Object.freeze(["temperature", "apparentTemperature", "precipitationProbability", "precipitationSum", "windSpeed"]),
  }),
  clothingBands: Object.freeze([
    Object.freeze({
      minEffectiveMaxC: 28,
      coolMinBelowC: 22,
      base: "穿透气短袖和轻薄下装",
      coolMinBase: "短袖为主，早晚带一件薄外套",
    }),
    Object.freeze({
      minEffectiveMaxC: 22,
      coolMinBelowC: 18,
      base: "穿短袖或薄长袖",
      coolMinBase: "穿薄长袖或短袖加薄外套",
    }),
    Object.freeze({ minEffectiveMaxC: 15, base: "穿长袖并带一件轻薄外套" }),
    Object.freeze({ minEffectiveMaxC: 8, base: "穿外套并加一层保暖内搭" }),
    Object.freeze({ minEffectiveMaxC: -Infinity, base: "穿厚外套并做好分层保暖" }),
  ]),
  precipitation: Object.freeze({
    probabilityPercentAtOrAbove: 50,
    amountMmAtOrAbove: 2,
    advice: "带雨具，鞋子尽量防滑",
  }),
  wind: Object.freeze({
    speedKmhAtOrAbove: 20,
    advice: "可加轻薄防风层",
  }),
});

function finiteNumber(value, fallback = NaN) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function buildWeatherAdviceFromPolicy({
  day = null,
  current = {},
  policy = WEATHER_ADVICE_POLICY,
} = {}) {
  const temperatureMin = finiteNumber(day?.temperatureMin, finiteNumber(current.temperature2m));
  const temperatureMax = finiteNumber(day?.temperatureMax, finiteNumber(current.temperature2m));
  const apparentMin = finiteNumber(day?.apparentTemperatureMin, finiteNumber(current.apparentTemperature, temperatureMin));
  const apparentMax = finiteNumber(day?.apparentTemperatureMax, finiteNumber(current.apparentTemperature, temperatureMax));
  const effectiveMin = Number.isFinite(apparentMin) ? apparentMin : temperatureMin;
  const effectiveMax = Number.isFinite(apparentMax) ? apparentMax : temperatureMax;

  const band = policy.clothingBands.find((item) => effectiveMax >= item.minEffectiveMaxC)
    || policy.clothingBands.at(-1);
  const clothing = band.coolMinBase && Number.isFinite(effectiveMin) && effectiveMin < band.coolMinBelowC
    ? band.coolMinBase
    : band.base;

  const precipitationProbability = finiteNumber(day?.precipitationProbabilityMax);
  const precipitationSum = finiteNumber(day?.precipitationSum, finiteNumber(current.precipitation));
  const windSpeed = finiteNumber(day?.windSpeed10mMax, finiteNumber(current.windSpeed10m));
  const additions = [];

  if ((Number.isFinite(precipitationProbability) && precipitationProbability >= policy.precipitation.probabilityPercentAtOrAbove)
    || (Number.isFinite(precipitationSum) && precipitationSum >= policy.precipitation.amountMmAtOrAbove)) {
    additions.push(policy.precipitation.advice);
  }
  if (Number.isFinite(windSpeed) && windSpeed >= policy.wind.speedKmhAtOrAbove) additions.push(policy.wind.advice);

  return {
    advice: `${clothing}${additions.length ? `；${additions.join("，")}` : ""}。`,
    clothing,
    additions,
    policyId: policy.id,
    basis: {
      effectiveMin,
      effectiveMax,
      precipitationProbability,
      precipitationSum,
      windSpeed,
    },
  };
}
