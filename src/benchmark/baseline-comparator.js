function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

function sameList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function compatible(baseline, candidate) {
  const baselineEnvironment = baseline?.environment;
  const candidateEnvironment = candidate?.environment;
  return baseline?.protocol?.id === candidate?.protocol?.id
    && baseline?.protocol?.version === candidate?.protocol?.version
    && baseline?.suite?.id === candidate?.suite?.id
    && baseline?.suite?.version === candidate?.suite?.version
    && baseline?.profile === candidate?.profile
    && baselineEnvironment?.platform === candidateEnvironment?.platform
    && baselineEnvironment?.arch === candidateEnvironment?.arch
    && ["modelIds", "providerIds", "regionIds"].every((field) => sameList(
      baselineEnvironment?.[field], candidateEnvironment?.[field],
    ));
}

function median(report) {
  const value = report?.metrics?.durationMs?.median;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function compareBenchmarkReports({ baseline, candidate, warningRatio = 0.20 } = {}) {
  if (!compatible(baseline, candidate)) return freeze({ status: "blocked-environment-mismatch" });
  const baselineMedian = median(baseline);
  const candidateMedian = median(candidate);
  if (baselineMedian === null || candidateMedian === null || !Number.isFinite(warningRatio) || warningRatio < 0) {
    return freeze({ status: "blocked-insufficient-metrics" });
  }
  const ratio = baselineMedian === 0
    ? (candidateMedian === 0 ? 0 : Infinity)
    : (candidateMedian - baselineMedian) / baselineMedian;
  return freeze({
    status: ratio >= warningRatio ? "regression-warning" : "passed",
    baselineMedian,
    candidateMedian,
    ratio,
    warningRatio,
  });
}
