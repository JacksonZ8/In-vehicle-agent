import { execFileSync } from "node:child_process";
import os from "node:os";

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unavailable";
  }
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function stringIds(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim()) : [];
}

function timeoutConfig(value) {
  return {
    phaseTimeoutMs: value?.phaseTimeoutMs,
    transportTimeoutMs: value?.transportTimeoutMs,
    scenarioTimeoutMs: value?.scenarioTimeoutMs,
  };
}

function serviceConfig(value) {
  return {
    requiredServiceIds: stringIds(value?.requiredServiceIds),
    readinessTimeoutMs: value?.readinessTimeoutMs,
  };
}

function serviceReadiness(value) {
  return Array.isArray(value) ? value.map((entry) => ({
    serviceId: entry?.serviceId,
    status: entry?.status,
    checkedAt: entry?.checkedAt,
  })) : [];
}

function coldStartProof(profile, serviceProfile) {
  const telemetry = serviceProfile?.coldStartTelemetry;
  if (profile !== "cold-diagnostic") return { status: "not-applicable", verifiedAt: null, serviceIds: [] };
  const serviceIds = stringIds(telemetry?.serviceIds);
  if (telemetry?.observed === true && isIsoTimestamp(telemetry.verifiedAt) && serviceIds.length > 0) {
    return { status: "observed", verifiedAt: telemetry.verifiedAt, serviceIds };
  }
  return { status: "unverified", verifiedAt: null, serviceIds };
}

export function readBenchmarkEnvironment({ cwd, profile, serviceProfile } = {}) {
  const cpuModel = os.cpus()[0]?.model || "unavailable";
  return freeze({
    commitSha: git(cwd, ["rev-parse", "HEAD"]),
    dirtyWorktree: git(cwd, ["status", "--porcelain"]) !== "",
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuModel,
    profile,
    modelIds: stringIds(serviceProfile?.modelIds),
    providerIds: stringIds(serviceProfile?.providerIds),
    regionIds: stringIds(serviceProfile?.regionIds),
    timeoutConfig: timeoutConfig(serviceProfile?.timeoutConfig),
    serviceConfig: serviceConfig(serviceProfile?.serviceConfig),
    serviceReadiness: serviceReadiness(serviceProfile?.serviceReadiness),
    coldStartProof: coldStartProof(profile, serviceProfile),
  });
}
