import { clampNumber, getMemorySourcedRequiredSlots, getMissingRequiredSlots, isTrustedSlotProvenance, normalizeSlotProvenance, SAFETY_BASELINE, VEHICLE_INTENTS } from "../runtime/agent-schemas.js";
import { evaluateManualSafetyPolicy } from "../manual/manual-safety-policy.js";
import { publishManualConstraints } from "../manual/manual-constraint-registry.js";
import {
  filterManualEvidence,
  isManualEvidenceRef,
  MANUAL_EVIDENCE_REF_CONTRACT,
} from "../manual/manual-evidence-eligibility.js";
import { isTrustedConfirmationAssertions, TAILGATE_CLEARANCE_ASSERTION } from "./confirmation-challenge.js";
import { requestedEs7ComponentActionState } from "../vehicle/es7-action-catalog.js";

const WINDOW_ZONES = new Set(["front_left", "front_right", "rear_left", "rear_right"]);

export const VEHICLE_STATE_FRESHNESS_POLICY = Object.freeze({
  version: "nio-vehicle-state-freshness@1.0.0",
  maxAgeMs: 5_000,
  futureToleranceMs: 1_000,
  timeSensitiveFields: Object.freeze([
    "speedKph",
    "gear",
    "rearClearance",
    "windowAntiPinchAvailable",
    "rainDetected",
    "driverBackrestAngle",
    "cabinTemperature",
  ]),
});

const SAFETY_STATE_FIELDS_BY_INTENT = Object.freeze({
  "body.tailgate.open": Object.freeze(["speedKph", "gear", "rearClearance"]),
  "body.window.setPosition": Object.freeze(["windowAntiPinchAvailable", "rainDetected"]),
  "cabin.comfort.applySettings": Object.freeze([]),
  "seat.driver.setBackrestAngle": Object.freeze(["speedKph"]),
  "vehicle.component.setState": Object.freeze(["speedKph", "gear"]),
});

export const SAFETY_ENFORCEMENT_PROFILES = Object.freeze({
  "body.window.setPosition": Object.freeze({ profileId: "window-anti-pinch-and-weather@1.0.0", version: "1.0.0", enforcement: "specialized-handler" }),
  "body.tailgate.open": Object.freeze({ profileId: "tailgate-static-park-clearance@1.0.0", version: "1.0.0", enforcement: "specialized-handler" }),
  "seat.driver.setBackrestAngle": Object.freeze({ profileId: "seat-backrest-driving-posture@1.0.0", version: "1.0.0", enforcement: "specialized-handler" }),
  "seat.comfort.setLevel": Object.freeze({ profileId: "seat-comfort-manual-levels@1.0.0", version: "1.0.0", enforcement: "bounded-seat-comfort-control" }),
  "vehicle.component.setState": Object.freeze({ profileId: "es7-component-parked-demo@1.0.0", version: "1.0.0", enforcement: "parked-component-handler" }),
  "cabin.climate.setPreset": Object.freeze({ profileId: "climate-temperature-range@1.0.0", version: "1.0.0", enforcement: "bounded-cabin-control" }),
  "cabin.comfort.applySettings": Object.freeze({ profileId: "cabin-comfort-explicit-targets@1.0.0", version: "1.0.0", enforcement: "bounded-cabin-control" }),
  "navigation.planRoute": Object.freeze({ profileId: "external-data-readonly-navigation@1.0.0", version: "1.0.0", enforcement: "external-data-readonly" }),
  "energy.findSwapStation": Object.freeze({ profileId: "external-data-readonly-energy@1.0.0", version: "1.0.0", enforcement: "external-data-readonly" }),
  "safety.reject": Object.freeze({ profileId: "safety-reject-only@1.0.0", version: "1.0.0", enforcement: "reject-only" }),
});

const VEHICLE_WRITE_INTENTS = new Set([
  "body.window.setPosition",
  "body.tailgate.open",
  "seat.driver.setBackrestAngle",
  "seat.comfort.setLevel",
  "cabin.comfort.applySettings",
  "vehicle.component.setState",
  "cabin.climate.setPreset",
]);

export function getSafetyEnforcementCoverage() {
  return VEHICLE_INTENTS.map((intent) => ({
    intent,
    profile: SAFETY_ENFORCEMENT_PROFILES[intent] || null,
    covered: Boolean(SAFETY_ENFORCEMENT_PROFILES[intent]),
  }));
}

export class SafetyGateway {
  constructor(_legacyVehicleContext = {}, config = {}) {
    this.now = typeof config.now === "function" ? config.now : () => Date.now();
  }

  evaluate(parsedCommand, evaluationContext = {}) {
    const vehicleStateSnapshot = evaluationContext.vehicleStateSnapshot || null;
    const vehicleStateFreshness = resolveVehicleStateFreshness(
      vehicleStateSnapshot,
      this.now(),
      requiredStateFieldsForCommand(parsedCommand),
    );
    const trustedValues = vehicleStateSnapshot
      ? sanitizeVehicleStateValues(vehicleStateSnapshot.values, vehicleStateFreshness)
      : {};
    const context = { ...trustedValues };
    const manualEvidence = normalizeManualEvidence(evaluationContext.manualEvidence);
    const trustedConfirmationAssertions = isTrustedConfirmationAssertions(evaluationContext.trustedConfirmationAssertions)
      ? evaluationContext.trustedConfirmationAssertions
      : {};
    const trustedContextProvenance = isTrustedSlotProvenance(parsedCommand.slotProvenance);
    const effectiveSlotProvenance = Object.fromEntries(
      Object.entries(normalizeSlotProvenance(parsedCommand.slotProvenance, parsedCommand.slots || {}))
        .map(([key, value]) => [key, value === "context" && !trustedContextProvenance ? "unknown" : value]),
    );
    const auditedCommand = { ...parsedCommand, slotProvenance: effectiveSlotProvenance };
    const finalize = (decision) => attachVehicleStateAudit(decision, vehicleStateSnapshot, auditedCommand, vehicleStateFreshness);

    if (parsedCommand.speechAct !== "command" || parsedCommand.actionability?.actionable !== true) {
      return finalize(reject(
        parsedCommand,
        "输入不是可执行的明确车辆命令，Safety Gateway 已拒绝旁路执行。",
        "请使用明确的动作指令，并说明所需参数。",
        manualEvidence,
      ));
    }

    const safetyProfile = SAFETY_ENFORCEMENT_PROFILES[parsedCommand.intent] || null;
    if (!safetyProfile) {
      return finalize(unavailable(
        parsedCommand,
        `车辆意图 ${parsedCommand.intent || "unknown"} 没有注册 Safety enforcement profile，当前无法完成安全裁决。`,
        "请先在 CapabilityRegistry / Safety policy 中注册并验证该能力后再执行。",
        manualEvidence,
      ));
    }

    const untrustedRequiredSlots = getMissingRequiredSlots(parsedCommand.intent, parsedCommand.slots, effectiveSlotProvenance);
    const memorySourcedRequiredSlots = getMemorySourcedRequiredSlots(parsedCommand.intent, parsedCommand.slots, effectiveSlotProvenance);
    if (memorySourcedRequiredSlots.length) {
      return finalize(reject(
        parsedCommand,
        `必需工具参数不能来自会话记忆：${memorySourcedRequiredSlots.join("、")}。`,
        "请在本轮明确说明需要执行的对象或参数。",
        manualEvidence,
      ));
    }
    if (untrustedRequiredSlots.length) {
      return finalize(reject(
        parsedCommand,
        `必需工具参数缺少可信来源：${untrustedRequiredSlots.join("、")}。`,
        "请明确缺失参数后重试。",
        manualEvidence,
      ));
    }

    if (parsedCommand.intent === "safety.reject") {
      return finalize(reject(parsedCommand, parsedCommand.slots.reason, parsedCommand.slots.alternative, manualEvidence));
    }

    if (VEHICLE_WRITE_INTENTS.has(parsedCommand.intent) && !vehicleStateSnapshot) {
      return finalize(unavailable(
        parsedCommand,
        "当前缺少可用的车辆传感器快照，无法执行安全裁决。",
        "请等待车辆状态刷新后重试。",
        manualEvidence,
      ));
    }

    const requiredFreshFields = requiredStateFieldsForCommand(parsedCommand);
    const staleRequiredFields = requiredFreshFields.filter((field) => vehicleStateFreshness.byField?.[field]?.status !== "fresh");
    if (requiredFreshFields.length > 0 && (!vehicleStateSnapshot || staleRequiredFields.length)) {
      return finalize(unavailable(
        parsedCommand,
        vehicleStateSnapshot
          ? `车辆状态字段 ${staleRequiredFields.join("、")} ${vehicleStateFreshness.reason}，无法作为本次安全裁决依据。`
          : "当前缺少可用的车辆传感器快照，无法执行安全裁决。",
        "请等待车辆状态刷新后重试。",
        manualEvidence,
      ));
    }

    if (parsedCommand.intent === "body.tailgate.open") {
      const openingTailgate = parsedCommand.slots.open !== false;
      if (context.speedKph == null || context.gear == null) {
        return finalize(unavailable(
          parsedCommand,
          "车辆速度或挡位状态不可用，无法确认尾门动作安全。",
          "请等待车辆状态恢复后重试。",
          manualEvidence,
        ));
      }
      if (context.speedKph > 0 || context.gear !== "P") {
        return finalize(reject(
          parsedCommand,
          openingTailgate ? "后备箱开启需要车辆静止且处于 P 挡。" : "后备箱关闭需要车辆静止且处于 P 挡。",
          openingTailgate ? "请停车并挂入 P 挡后再开启尾门。" : "请停车并挂入 P 挡后再关闭尾门。",
          manualEvidence,
        ));
      }
      if (openingTailgate && context.rearClearance === false) {
        return finalize(reject(parsedCommand, "后方空间未确认安全，尾门开启被拦截。", "请确认后方无人和无障碍物后重试。", manualEvidence));
      }
      if (openingTailgate && context.rearClearance == null && trustedConfirmationAssertions[TAILGATE_CLEARANCE_ASSERTION] !== true) {
        const manualSafetyConstraints = publishManualConstraints(manualEvidence).published;
        const manualSafetyPolicy = evaluateManualSafetyPolicy({
          parsedCommand,
          trustedVehicleState: context,
          manualSafetyConstraints,
          baselineEffect: "require_confirmation",
        });
        return finalize(dispatchConstrainedSafetyEffect({
          baselineEffect: "require_confirmation",
          parsedCommand,
          reason: "后方空间尚未确认，尾门开启需要二次确认。",
          alternative: "请确认后方无人和无障碍物后再开启尾门。",
          manualEvidence,
          manualSafetyPolicy,
        }));
      }
      return finalize(allow(
        parsedCommand,
        parsedCommand.slots,
        openingTailgate ? "车辆静止且处于 P 挡，尾门开启满足当前安全 profile。" : "车辆静止且处于 P 挡，尾门关闭满足当前安全 profile。",
        manualEvidence,
      ));
    }

    if (parsedCommand.intent === "vehicle.component.setState") {
      if (context.speedKph == null || context.gear == null) {
        return finalize(unavailable(
          parsedCommand,
          "车辆速度或挡位状态不可用，无法执行 ES7 组件动作。",
          "请等待车辆状态恢复后重试。",
          manualEvidence,
        ));
      }
      if (context.speedKph !== 0 || context.gear !== "P") {
        return finalize(reject(
          parsedCommand,
          "ES7 组件演示动作需要车辆静止且处于 P 挡。",
          "请停车并挂入 P 挡后重试。",
          manualEvidence,
        ));
      }
      if (!requestedEs7ComponentActionState(parsedCommand.slots.actionId, parsedCommand.slots.value)) {
        return finalize(reject(
          parsedCommand,
          "组件动作或目标值不在已注册 ES7 动作目录范围内。",
          "请明确受支持的部件和范围内目标值。",
          manualEvidence,
        ));
      }
      return finalize(allow(
        parsedCommand,
        parsedCommand.slots,
        "车辆静止且处于 P 挡，ES7 组件动作满足当前安全 profile。",
        manualEvidence,
      ));
    }

    if (parsedCommand.intent === "body.window.setPosition"
      || (parsedCommand.intent === "cabin.comfort.applySettings" && parsedCommand.slots.windowTargets?.length)) {
      // A combined cabin setting must pass its climate checks before the window path can allow it.
      const climateRejection = parsedCommand.intent === "cabin.comfort.applySettings"
        ? rejectInvalidCabinClimate(parsedCommand, manualEvidence)
        : null;
      if (climateRejection) return finalize(climateRejection);
      if (context.windowAntiPinchAvailable === false) {
        const manualSafetyConstraints = publishManualConstraints(manualEvidence).published;
        const manualSafetyPolicy = evaluateManualSafetyPolicy({
          parsedCommand,
          trustedVehicleState: context,
          manualSafetyConstraints,
          baselineEffect: "reject",
        });
        return finalize(dispatchConstrainedSafetyEffect({
          baselineEffect: "reject",
          parsedCommand,
          reason: "防夹保护不可用，车窗动作被拦截。",
          alternative: "请检查车窗防夹传感器后再执行。",
          manualEvidence,
          manualSafetyPolicy,
        }));
      }
      if (context.windowAntiPinchAvailable !== true) {
        return finalize(unavailable(
          parsedCommand,
          "车窗防夹保护状态未知，无法安全执行车窗动作。",
          "请等待车窗防夹传感器状态刷新后重试。",
          manualEvidence,
        ));
      }
      if (context.rainDetected == null) {
        return finalize(unavailable(
          parsedCommand,
          "雨量状态不可用，无法安全决定车窗开度。",
          "请等待雨量传感器状态刷新后重试。",
          manualEvidence,
        ));
      }
      const requestedTargets = parsedCommand.intent === "body.window.setPosition"
        ? [{ zone: parsedCommand.slots.zone, percent: parsedCommand.slots.percent }]
        : parsedCommand.slots.windowTargets;
      if (!Array.isArray(requestedTargets) || requestedTargets.length === 0
        || requestedTargets.some((target) => !WINDOW_ZONES.has(target?.zone)
          || !Number.isFinite(target?.percent) || target.percent < 0 || target.percent > 100)
        || new Set(requestedTargets.map((target) => target.zone)).size !== requestedTargets.length) {
        return finalize(reject(parsedCommand, "车窗目标无效或有重复位置。", "请重新说明每扇车窗的开度。", manualEvidence));
      }
      const targets = requestedTargets.map((target) => ({
        ...target,
        percent: context.rainDetected
          ? Math.min(target.percent, SAFETY_BASELINE.window.rainCloseMaxPercent)
          : target.percent,
      }));
      const wasClamped = targets.some((target, index) => target.percent !== requestedTargets[index].percent);
      if (wasClamped) {
        // HC-P2-03: rain-close max percent from SAFETY_BASELINE (single source)
        const safeSlots = parsedCommand.intent === "body.window.setPosition"
          ? { ...parsedCommand.slots, percent: targets[0].percent, antiPinch: true }
          : { ...parsedCommand.slots, windowTargets: targets, antiPinch: true };
        return finalize(clamp(parsedCommand, safeSlots, `检测到雨量，车窗开度已限制到 ${SAFETY_BASELINE.window.rainCloseMaxPercent}%。`, manualEvidence));
      }
      const safeSlots = parsedCommand.intent === "body.window.setPosition"
        ? { ...parsedCommand.slots, percent: targets[0].percent, antiPinch: true }
        : { ...parsedCommand.slots, windowTargets: targets, antiPinch: true };
      return finalize(allow(parsedCommand, safeSlots, "车窗防夹保护在线，允许执行。", manualEvidence));
    }

    if (parsedCommand.intent === "seat.driver.setBackrestAngle") {
      if (context.speedKph == null) {
        return finalize(unavailable(parsedCommand, "车辆速度状态不可用，无法安全调节座椅靠背。", "请等待车辆状态恢复后重试。", manualEvidence));
      }
      // HC-P2-03: SAFETY_BASELINE is the single source for all physical boundaries
      const maxAngle = context.speedKph > 0 ? SAFETY_BASELINE.seat.maxAngleDriving : SAFETY_BASELINE.seat.maxAngleStationary;
      if (parsedCommand.slots.angleOutOfRange) {
        const angle = clampNumber(
          parsedCommand.slots.requestedAngle,
          SAFETY_BASELINE.seat.minAngle,
          maxAngle,
          SAFETY_BASELINE.seat.defaultAngle,
        );
        return finalize(clamp(
          parsedCommand,
          { ...parsedCommand.slots, angle },
          `请求的靠背角度 ${parsedCommand.slots.requestedAngle}° 超出安全范围，已限制到 ${angle}°。`,
          manualEvidence,
        ));
      }
      const angle = clampNumber(parsedCommand.slots.angle, SAFETY_BASELINE.seat.minAngle, maxAngle, SAFETY_BASELINE.seat.defaultAngle);
      if (angle !== parsedCommand.slots.angle) {
        return finalize(clamp(parsedCommand, { ...parsedCommand.slots, angle }, `为保持安全驾驶姿态，靠背角度已限制到 ${angle}°。`, manualEvidence));
      }
      return finalize(allow(parsedCommand, { ...parsedCommand.slots, angle }, "靠背角度在安全范围内，允许执行。", manualEvidence));
    }

    if (parsedCommand.intent === "cabin.climate.setPreset") {
      if (Number.isInteger(parsedCommand.slots.temperatureDelta)) {
        const currentTemperature = context.cabinTemperature;
        if (!Number.isFinite(currentTemperature)) {
          return finalize(unavailable(parsedCommand,
            "当前车辆快照没有有效的空调设定温度，无法计算相对调温目标。",
            "请等待空调设定温度刷新后重试。",
            manualEvidence));
        }
        const targetTemperature = currentTemperature + parsedCommand.slots.temperatureDelta;
        if (targetTemperature < SAFETY_BASELINE.climate.minTemperature
          || targetTemperature > SAFETY_BASELINE.climate.maxTemperature) {
          return finalize(reject(parsedCommand,
            `按当前设定 ${currentTemperature}°C 调整 ${parsedCommand.slots.temperatureDelta > 0 ? "+" : ""}${parsedCommand.slots.temperatureDelta}°C 后会超出空调范围。`,
            `ES8 空调支持 ${SAFETY_BASELINE.climate.minTemperature}-${SAFETY_BASELINE.climate.maxTemperature}°C；当前设定保持不变。`,
            manualEvidence));
        }
        const { temperatureDelta: _temperatureDelta, ...otherSlots } = parsedCommand.slots;
        return finalize(allow(parsedCommand, {
          ...otherSlots,
          temperature: targetTemperature,
        }, `已根据本轮 Provider 快照 ${currentTemperature}°C 计算出目标 ${targetTemperature}°C。`, manualEvidence));
      }
      if (parsedCommand.slots.temperatureOutOfRange) {
        return finalize(reject(
          parsedCommand,
          `空调目标温度 ${parsedCommand.slots.requestedTemperature}°C 超出可调范围。`,
          `当前座舱空调支持 ${SAFETY_BASELINE.climate.minTemperature}-${SAFETY_BASELINE.climate.maxTemperature}°C，请重新选择一个舒适温度。`,
          manualEvidence,
        ));
      }
      if (parsedCommand.slots.fanLevelOutOfRange) {
        return finalize(reject(
          parsedCommand,
          `空调风量 ${parsedCommand.slots.requestedFanLevel} 挡超出可调范围。`,
          `ES8 空调支持 0-${SAFETY_BASELINE.climate.maxFanLevel} 挡；0 挡表示关闭。`,
          manualEvidence,
        ));
      }
      if (!isClimateSettingConsistent(parsedCommand.slots)) {
        return finalize(reject(parsedCommand, "空调开关、模式与风量目标相互冲突。", "请明确空调开关和风量目标后重试。", manualEvidence));
      }
      return finalize(allow(parsedCommand, parsedCommand.slots, "空调目标温度在已注册安全 profile 范围内，允许继续。", manualEvidence));
    }

    if (parsedCommand.intent === "cabin.comfort.applySettings") {
      const climateRejection = rejectInvalidCabinClimate(parsedCommand, manualEvidence);
      if (climateRejection) return finalize(climateRejection);
      return finalize(allow(parsedCommand, parsedCommand.slots, "座舱目标符合 ES8 控制范围，允许模拟执行。", manualEvidence));
    }

    if (parsedCommand.intent === "seat.comfort.setLevel") {
      if (parsedCommand.slots.levelOutOfRange) {
        return finalize(reject(parsedCommand, `座椅舒适挡位 ${parsedCommand.slots.requestedLevel} 超出范围。`, "ES8 座椅加热和通风支持 1-3 挡，0 表示关闭。", manualEvidence));
      }
      if (String(parsedCommand.slots.seatZone).startsWith("row3_") && parsedCommand.slots.seatMode === "ventilation") {
        return finalize(reject(parsedCommand, "ES8 三排座椅不支持座椅通风。", "三排座椅可使用加热；前排和二排支持加热与通风。", manualEvidence));
      }
      return finalize(allow(parsedCommand, parsedCommand.slots, "座椅舒适功能范围符合 ES8 用户手册，允许模拟执行。", manualEvidence));
    }

    if (safetyProfile.enforcement === "external-data-readonly") {
      return finalize(allow(
        parsedCommand,
        parsedCommand.slots,
        `意图 ${parsedCommand.intent} 仅允许进入只读外部数据 adapter，已由 ${safetyProfile.profileId} 显式覆盖。`,
        manualEvidence,
      ));
    }

    return finalize(reject(
      parsedCommand,
      `车辆意图 ${parsedCommand.intent} 虽有 Safety profile，但没有命中可执行 enforcement handler，已 fail-close 拒绝。`,
      "请补齐 Safety Gateway handler 与契约测试后再执行该能力。",
      manualEvidence,
    ));
  }
}

function resolveVehicleStateFreshness(snapshot, nowMs = Date.now(), additionalFields = []) {
  if (!snapshot) {
    return {
      policy: VEHICLE_STATE_FRESHNESS_POLICY.version,
      status: "unavailable",
      ageMs: null,
      maxAgeMs: VEHICLE_STATE_FRESHNESS_POLICY.maxAgeMs,
      futureToleranceMs: VEHICLE_STATE_FRESHNESS_POLICY.futureToleranceMs,
      invalidatedFields: [],
      byField: {},
      reason: "缺少 VehicleStateSnapshot",
    };
  }

  const capturedMs = typeof snapshot.capturedAt === "string" && snapshot.capturedAt.trim()
    ? Date.parse(snapshot.capturedAt)
    : NaN;
  const hasFreshnessMs = snapshot.freshnessMs !== null
    && snapshot.freshnessMs !== undefined
    && snapshot.freshnessMs !== ""
    && Number.isFinite(Number(snapshot.freshnessMs));
  const capturedAgeMs = Number.isFinite(capturedMs) ? nowMs - capturedMs : null;
  const ageMs = hasFreshnessMs && Number.isFinite(capturedAgeMs)
    ? Number(snapshot.freshnessMs) + Math.max(0, capturedAgeMs)
    : capturedAgeMs;
  const trackedFields = [...new Set([
    ...VEHICLE_STATE_FRESHNESS_POLICY.timeSensitiveFields,
    ...additionalFields,
  ])];
  const byField = Object.fromEntries(trackedFields.map((field) => [
    field,
    resolveFieldFreshness(snapshot.capturedAtByField?.[field], nowMs),
  ]));
  const invalidatedFields = Object.entries(byField)
    .filter(([, freshness]) => freshness.status !== "fresh")
    .map(([field]) => field);
  const statuses = Object.values(byField).map((freshness) => freshness.status);
  const status = invalidatedFields.length === 0
    ? "fresh"
    : new Set(statuses).size === 1
      ? statuses[0]
      : "partial-stale";
  const reason = invalidatedFields.length === 0
    ? "满足 Safety Gateway 时效策略"
    : new Set(statuses).size === 1
      ? Object.values(byField)[0].reason
      : "包含缺少、未来或已过期字段";

  return {
    policy: VEHICLE_STATE_FRESHNESS_POLICY.version,
    status,
    ageMs: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs)) : null,
    maxAgeMs: VEHICLE_STATE_FRESHNESS_POLICY.maxAgeMs,
    futureToleranceMs: VEHICLE_STATE_FRESHNESS_POLICY.futureToleranceMs,
    invalidatedFields,
    byField,
    reason,
  };
}

function resolveFieldFreshness(capturedAt, nowMs) {
  const capturedMs = typeof capturedAt === "string" && capturedAt.trim() ? Date.parse(capturedAt) : NaN;
  if (!Number.isFinite(capturedMs)) return { status: "missing-timestamp", ageMs: null, reason: "缺少有效 capturedAt" };
  if (capturedMs - nowMs > VEHICLE_STATE_FRESHNESS_POLICY.futureToleranceMs) {
    return { status: "future-timestamp", ageMs: null, reason: "时间戳来自未来" };
  }
  const ageMs = Math.max(0, nowMs - capturedMs);
  if (ageMs > VEHICLE_STATE_FRESHNESS_POLICY.maxAgeMs) return { status: "stale", ageMs: Math.round(ageMs), reason: "已过期" };
  return { status: "fresh", ageMs: Math.round(ageMs), reason: "满足 Safety Gateway 时效策略" };
}

function sanitizeVehicleStateValues(values = {}, freshness) {
  const sanitized = { ...(values || {}) };
  for (const field of freshness?.invalidatedFields || []) {
    if (Object.hasOwn(sanitized, field)) sanitized[field] = null;
  }
  return sanitized;
}

function attachVehicleStateAudit(decision, snapshot, parsedCommand, vehicleStateFreshness) {
  const slotProvenance = { ...(parsedCommand.slotProvenance || {}) };
  for (const key of Object.keys(decision.safeSlots || {})) {
    if (!slotProvenance[key]) slotProvenance[key] = "context";
  }
  const profile = SAFETY_ENFORCEMENT_PROFILES[parsedCommand.intent] || null;
  const requiredFields = requiredStateFieldsForCommand(parsedCommand);
  const factRefs = snapshot
    ? requiredFields.map((field) => ({
      id: `${snapshot.id}#${field}`,
      snapshotId: snapshot.id,
      field,
      capturedAt: snapshot.capturedAtByField?.[field] || null,
      freshnessStatus: vehicleStateFreshness.byField?.[field]?.status || "missing-timestamp",
      valueStatus: snapshot.values?.[field] == null ? "unknown" : "known",
    }))
    : [];
  const ruleIds = [
    profile?.profileId,
    decision.manualSafetyPolicy?.constraintId,
  ].filter((value, index, values) => typeof value === "string" && value && values.indexOf(value) === index);
  return {
    ...decision,
    slotProvenance,
    reasonCode: resolveSafetyReasonCode(decision, snapshot, vehicleStateFreshness, requiredFields, profile),
    policyId: profile?.profileId || null,
    policyVersion: profile?.version || null,
    ruleIds,
    vehicleStateSnapshotId: snapshot?.id || null,
    vehicleStateAudit: {
      snapshotId: snapshot?.id || null,
      source: snapshot?.source || null,
      simulated: snapshot?.simulated === true,
      capturedAt: snapshot?.capturedAt || null,
      freshnessMs: snapshot?.freshnessMs ?? null,
      freshness: vehicleStateFreshness,
      requiredFields,
      factRefs,
      ignoredParsedVehicleStateSlots: Object.hasOwn(parsedCommand.slots || {}, "vehicleSpeedKph") ? ["vehicleSpeedKph"] : [],
    },
  };
}

function requiredStateFieldsForCommand(parsedCommand = {}) {
  if (parsedCommand.intent === "cabin.climate.setPreset" && Number.isInteger(parsedCommand.slots?.temperatureDelta)) {
    return ["cabinTemperature"];
  }
  if (parsedCommand.intent === "body.tailgate.open" && parsedCommand.slots?.open === false) {
    return ["speedKph", "gear"];
  }
  if (parsedCommand.intent === "cabin.comfort.applySettings" && parsedCommand.slots?.windowTargets?.length) {
    return ["windowAntiPinchAvailable", "rainDetected"];
  }
  return [...(SAFETY_STATE_FIELDS_BY_INTENT[parsedCommand.intent] || [])];
}

function rejectInvalidCabinClimate(parsedCommand, manualEvidence) {
  const { slots } = parsedCommand;
  if (slots.temperatureOutOfRange || slots.fanLevelOutOfRange) {
    return reject(parsedCommand,
      slots.temperatureOutOfRange
        ? `空调目标温度 ${slots.requestedTemperature}°C 超出可调范围。`
        : `空调风量 ${slots.requestedFanLevel} 挡超出可调范围。`,
      `ES8 空调支持 ${SAFETY_BASELINE.climate.minTemperature}-${SAFETY_BASELINE.climate.maxTemperature}°C 和 0-${SAFETY_BASELINE.climate.maxFanLevel} 挡。`,
      manualEvidence);
  }
  if (!isClimateSettingConsistent(slots)) {
    return reject(parsedCommand, "空调开关、模式与风量目标相互冲突。", "请明确空调开关和风量目标后重试。", manualEvidence);
  }
  return null;
}

function isClimateSettingConsistent(slots = {}) {
  const power = slots.climatePower;
  const fanLevel = slots.fanLevel;
  if (power === false && Number.isFinite(fanLevel) && fanLevel > 0) return false;
  if (power === true && fanLevel === 0) return false;
  return true;
}

function resolveSafetyReasonCode(decision, snapshot, freshness, requiredFields, profile) {
  if (!profile) return "safety-policy-unavailable";
  if (decision.action === "allow") return "safety-allowed";
  if (decision.action === "clamp") return "safety-clamped";
  if (decision.action === "require_confirmation") return "safety-confirmation-required";
  if (decision.action === "reject") return "safety-known-unsafe";
  if (decision.action !== "unavailable") return "safety-contract-invalid";
  if (!snapshot) return "safety-state-provider-unavailable";
  const statuses = requiredFields.map((field) => freshness.byField?.[field]?.status);
  if (statuses.includes("future-timestamp")) return "safety-state-field-future";
  if (statuses.includes("missing-timestamp")) return "safety-state-field-timestamp-missing";
  if (statuses.includes("stale")) return "safety-state-field-stale";
  if (requiredFields.some((field) => snapshot.values?.[field] == null)) {
    return "safety-state-field-unknown";
  }
  return "safety-state-provider-unavailable";
}

function allow(parsedCommand, safeSlots, reason, manualEvidence, manualSafetyPolicy = null) {
  const manualAudit = buildManualAudit(parsedCommand, "allow", reason, manualEvidence, manualSafetyPolicy);
  return {
    requestId: parsedCommand.requestId,
    allowed: true,
    action: "allow",
    safeIntent: parsedCommand.intent,
    safeSlots,
    reason,
    alternative: "",
    manualEvidenceStatus: manualEvidence.status,
    manualEvidence: manualEvidence.evidence,
    manualEvidenceQuery: manualEvidence.query,
    manualEvidenceTelemetry: manualEvidence.telemetry,
    ...manualAudit,
  };
}

function clamp(parsedCommand, safeSlots, reason, manualEvidence, manualSafetyPolicy = null) {
  const manualAudit = buildManualAudit(parsedCommand, "clamp", reason, manualEvidence, manualSafetyPolicy);
  return {
    requestId: parsedCommand.requestId,
    allowed: true,
    action: "clamp",
    safeIntent: parsedCommand.intent,
    safeSlots,
    reason,
    alternative: "",
    manualEvidenceStatus: manualEvidence.status,
    manualEvidence: manualEvidence.evidence,
    manualEvidenceQuery: manualEvidence.query,
    manualEvidenceTelemetry: manualEvidence.telemetry,
    ...manualAudit,
  };
}

function reject(parsedCommand, reason, alternative, manualEvidence, manualSafetyPolicy = null) {
  const manualAudit = buildManualAudit(parsedCommand, "reject", reason, manualEvidence, manualSafetyPolicy);
  return {
    requestId: parsedCommand.requestId,
    allowed: false,
    action: "reject",
    safeIntent: "safety.reject",
    safeSlots: {
      reason,
      alternative,
      originalIntent: parsedCommand.intent,
    },
    reason,
    alternative,
    manualEvidenceStatus: manualEvidence.status,
    manualEvidence: manualEvidence.evidence,
    manualEvidenceQuery: manualEvidence.query,
    manualEvidenceTelemetry: manualEvidence.telemetry,
    ...manualAudit,
  };
}

function unavailable(parsedCommand, reason, alternative, manualEvidence) {
  const manualAudit = buildManualAudit(parsedCommand, "unavailable", reason, manualEvidence);
  return {
    requestId: parsedCommand.requestId,
    allowed: false,
    action: "unavailable",
    safeIntent: "safety.unavailable",
    safeSlots: {
      reason,
      alternative,
      originalIntent: parsedCommand.intent,
    },
    reason,
    alternative,
    manualEvidenceStatus: manualEvidence.status,
    manualEvidence: manualEvidence.evidence,
    manualEvidenceQuery: manualEvidence.query,
    manualEvidenceTelemetry: manualEvidence.telemetry,
    ...manualAudit,
  };
}

function requireConfirmation(parsedCommand, reason, alternative, manualEvidence, manualSafetyPolicy = null) {
  const manualAudit = buildManualAudit(parsedCommand, "require_confirmation", reason, manualEvidence, manualSafetyPolicy);
  return {
    requestId: parsedCommand.requestId,
    allowed: false,
    action: "require_confirmation",
    safeIntent: "safety.reject",
    safeSlots: {
      reason,
      alternative,
      originalIntent: parsedCommand.intent,
      confirmationRequired: true,
    },
    reason,
    alternative,
    manualEvidenceStatus: manualEvidence.status,
    manualEvidence: manualEvidence.evidence,
    manualEvidenceQuery: manualEvidence.query,
    manualEvidenceTelemetry: manualEvidence.telemetry,
    ...manualAudit,
  };
}

export function dispatchConstrainedSafetyEffect({
  baselineEffect,
  parsedCommand,
  reason,
  alternative,
  manualEvidence,
  manualSafetyPolicy,
  effectSafeSlots,
}) {
  const effect = manualSafetyPolicy?.integrity?.valid === false
    ? "reject"
    : manualSafetyPolicy?.applied ? manualSafetyPolicy.effect : baselineEffect;
  if (effect === "reject") return reject(parsedCommand, reason, alternative, manualEvidence, manualSafetyPolicy);
  if (effect === "require_confirmation") {
    return requireConfirmation(parsedCommand, reason, alternative, manualEvidence, manualSafetyPolicy);
  }
  if (effect === "clamp" && effectSafeSlots && typeof effectSafeSlots === "object" && !Array.isArray(effectSafeSlots)) {
    return clamp(parsedCommand, effectSafeSlots, reason, manualEvidence, manualSafetyPolicy);
  }
  return reject(
    parsedCommand,
    effect === "clamp" ? "安全策略要求限幅，但缺少经校验的安全参数，已拒绝执行。" : "安全策略 effect 无效或不允许覆盖固定基线，已拒绝执行。",
    alternative,
    manualEvidence,
    manualSafetyPolicy,
  );
}

function normalizeManualEvidence(manualEvidence = {}) {
  const requestedStatus = ["hit", "miss", "unavailable", "error"].includes(manualEvidence.status)
    ? manualEvidence.status
    : "miss";
  const query = String(manualEvidence.query || "");
  const evidence = Array.isArray(manualEvidence.evidence) ? manualEvidence.evidence : [];
  const telemetry = manualEvidence.telemetry && typeof manualEvidence.telemetry === "object"
    ? manualEvidence.telemetry
    : {};
  if (telemetry.evidenceContract === MANUAL_EVIDENCE_REF_CONTRACT) {
    const strictHit = requestedStatus === "hit"
      && evidence.length > 0
      && evidence.every(isManualEvidenceRef);
    const status = requestedStatus === "hit" && !strictHit ? "unavailable" : requestedStatus;
    return {
      status,
      query,
      evidence: strictHit ? evidence : [],
      telemetry: {
        ...telemetry,
        ...(status === "unavailable" && requestedStatus === "hit"
          ? { reason: "invalid-evidence-ref-contract" }
          : {}),
      },
    };
  }
  const eligibilityQuery = String(manualEvidence.telemetry?.eligibilityQuery || query);
  const eligibility = filterManualEvidence(eligibilityQuery, evidence, {
    retrievalMode: manualEvidence.telemetry?.retrievalMode,
    vehicleModel: manualEvidence.vehicleModel,
  });
  const status = requestedStatus === "error" ? "error" : eligibility.evidence.length ? "hit" : "miss";
  return {
    status,
    query,
    evidence: eligibility.evidence,
    telemetry: { ...(manualEvidence.telemetry || {}), ...eligibility.telemetry, eligibilityQuery },
  };
}

function buildManualAudit(parsedCommand, action, reason, manualEvidence, manualSafetyPolicy = null) {
  const constraintPublication = publishManualConstraints(manualEvidence);
  const manualSafetyConstraints = constraintPublication.published;
  return {
    manualEvidenceSummary: buildManualEvidenceSummary(manualEvidence),
    manualSafetyNotes: buildManualSafetyNotes(parsedCommand, action, reason, manualEvidence, manualSafetyConstraints, manualSafetyPolicy),
    manualSafetyConstraints,
    manualConstraintCandidates: constraintPublication.candidates,
    registryTelemetry: constraintPublication.telemetry,
    ...(manualSafetyPolicy ? { manualSafetyPolicy } : {}),
  };
}

function buildManualEvidenceSummary(manualEvidence) {
  const telemetry = manualEvidence.telemetry || {};
  const evidence = manualEvidence.evidence || [];
  const primary = evidence[0] || null;
  const base = {
    status: manualEvidence.status,
    query: manualEvidence.query,
    retrievalMode: telemetry.retrievalMode || primary?.retrievalMode || "unavailable",
    embeddingStatus: telemetry.embeddingStatus || primary?.embeddingStatus || "unknown",
    primaryCitation: primary?.citation || "",
    evidenceCount: evidence.length,
    relevanceNotes: [],
  };

  if (manualEvidence.status === "hit" && evidence.length) {
    base.relevanceNotes = evidence.slice(0, 3).map((item) => {
      const citation = item.citation || formatEvidenceLocation(item);
      const section = item.sectionTitle ? `「${item.sectionTitle}」` : "未标注章节";
      const category = item.category ? `（${item.category}）` : "";
      const score = Number.isFinite(item.score) ? `，score=${item.score}` : "";
      return `${citation || "手册证据"} ${section}${category}${score}`;
    });
    return base;
  }

  if (manualEvidence.status === "error") {
    base.relevanceNotes = ["手册检索异常，当前安全裁决仍由车端 Safety Gateway 规则执行。"];
    return base;
  }

  if (manualEvidence.status === "unavailable") {
    base.relevanceNotes = ["手册检索依赖不可用，当前安全裁决仍由车端 Safety Gateway 固定规则执行。"];
    return base;
  }

  base.relevanceNotes = [
    manualEvidence.query
      ? "本次手册检索未命中可引用证据，当前安全裁决仍由车端 Safety Gateway 规则执行。"
      : "本次未触发可用手册证据，当前安全裁决仍由车端 Safety Gateway 规则执行。",
  ];
  return base;
}

function buildManualSafetyNotes(parsedCommand, action, reason, manualEvidence, manualSafetyConstraints = [], manualSafetyPolicy = null) {
  const evidence = manualEvidence.evidence || [];
  const notes = [];
  if (manualEvidence.status === "hit" && evidence.length) {
    const primary = evidence[0];
    const citation = primary.citation || formatEvidenceLocation(primary);
    const section = primary.sectionTitle ? `${primary.sectionTitle}` : "未标注章节";
    const category = primary.category ? `${primary.category}` : "未标注分类";
    notes.push(`引用${citation || section}作为 ${parsedCommand.intent} 的手册审计证据，分类为${category}。`);
    notes.push(
      manualSafetyPolicy?.applied
        ? `版本化手册策略 ${manualSafetyPolicy.policyId}@${manualSafetyPolicy.version} 已实际参与本次 ${action} 裁决。`
        : `当前 ${action} 裁决仍由车端 Safety Gateway 规则执行，手册证据仅参与解释和审计。`,
    );
    if (manualSafetyConstraints.length) {
      notes.push(
        manualSafetyPolicy?.applied
          ? `本地开发 ConstraintRegistry 已发布 ${manualSafetyConstraints.length} 条 Codex 来源核验约束；命中约束已由策略执行，其余仅用于审计。`
          : `本地开发 ConstraintRegistry 已发布 ${manualSafetyConstraints.length} 条 Codex 来源核验约束，仅用于审计，不改变本次裁决。`,
      );
    }
    if (evidence.length > 1) {
      notes.push(`另有 ${evidence.length - 1} 条相关手册片段可供复核，不作为新增放行或拒绝规则。`);
    }
    return notes.slice(0, 3);
  }

  if (manualEvidence.status === "error") {
    return [
      `手册检索异常，未把检索结果用于改变 ${parsedCommand.intent} 的安全裁决。`,
      `当前 ${action} 裁决仍由车端 Safety Gateway 规则执行：${reason}`,
    ];
  }

  if (manualEvidence.status === "unavailable") {
    return [
      `手册检索依赖不可用，未把检索结果用于改变 ${parsedCommand.intent} 的安全裁决。`,
      `当前 ${action} 裁决仍由车端 Safety Gateway 规则执行：${reason}`,
    ];
  }

  return [
    manualSafetyPolicy?.fallback
      ? `未命中可引用手册证据，${manualSafetyPolicy.policyId} 使用固定规则兜底，不放宽 ${parsedCommand.intent} 的安全裁决。`
      : `未命中可引用手册证据，未把手册检索结果用于改变 ${parsedCommand.intent} 的安全裁决。`,
    `当前 ${action} 裁决仍由车端 Safety Gateway 规则执行：${reason}`,
  ];
}

function formatEvidenceLocation(item = {}) {
  if (!item.pageStart) return "";
  const pageEnd = item.pageEnd || item.pageStart;
  const pages = item.pageStart === pageEnd ? `p.${item.pageStart}` : `pp.${item.pageStart}-${pageEnd}`;
  return `ES8 用户手册 ${pages}`;
}
