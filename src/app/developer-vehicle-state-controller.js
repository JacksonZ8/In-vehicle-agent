function clone(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export class DeveloperVehicleStateController {
  constructor({
    simulator,
    vehicleStateProvider,
    initialState,
    isLocked = () => false,
    onSnapshot = () => {},
    onAudit = () => {},
  } = {}) {
    if (typeof simulator?.readVehicleState !== "function") throw new TypeError("simulator is required");
    if (typeof vehicleStateProvider?.getSnapshot !== "function"
      || typeof vehicleStateProvider?.ingestDemoSensorState !== "function") {
      throw new TypeError("vehicleStateProvider is required");
    }
    if (!initialState || typeof initialState !== "object" || Array.isArray(initialState)) {
      throw new TypeError("initialState is required");
    }
    this.simulator = simulator;
    this.vehicleStateProvider = vehicleStateProvider;
    this.initialState = clone(initialState);
    this.isLocked = isLocked;
    this.onSnapshot = onSnapshot;
    this.onAudit = onAudit;
  }

  getSnapshot() {
    return this.vehicleStateProvider.getSnapshot();
  }

  applyPatch(patch, {
    mode = "success",
    capturedAt = null,
    audit = true,
    label = "开发者模拟状态已更新",
  } = {}) {
    const previousSnapshot = this.getSnapshot();
    if (this.isLocked()) {
      return deepFreeze({ ok: false, reason: "locked", snapshot: previousSnapshot });
    }

    try {
      const simulatorReading = this.simulator.readVehicleState(patch, { mode });
      const reading = capturedAt
        ? Object.freeze({ ...simulatorReading, capturedAt })
        : simulatorReading;
      const ingestion = this.vehicleStateProvider.ingestDemoSensorState(reading);
      if (ingestion?.ok !== true) {
        this.restoreSimulator(previousSnapshot);
        return deepFreeze({
          ok: false,
          reason: ingestion?.reason || "provider-rejected",
          snapshot: previousSnapshot,
        });
      }
      const result = deepFreeze({
        ok: true,
        snapshot: ingestion.snapshot,
        reading,
        changedFields: Object.freeze(Object.keys(patch)),
        mode,
      });
      this.onSnapshot(ingestion.snapshot, result);
      if (audit) this.audit({ label, changedFields: result.changedFields, snapshot: ingestion.snapshot, mode });
      return result;
    } catch (error) {
      this.restoreSimulator(previousSnapshot);
      return deepFreeze({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        snapshot: previousSnapshot,
      });
    }
  }

  reset(options = {}) {
    return this.applyPatch(clone(this.initialState), {
      label: "开发者模拟车辆状态已复位",
      ...options,
    });
  }

  audit({ label, changedFields, snapshot = this.getSnapshot(), mode = "success" } = {}) {
    this.onAudit(Object.freeze({
      label: typeof label === "string" && label.trim() ? label.trim() : "开发者模拟状态已更新",
      changedFields: Object.freeze([...(changedFields || [])]),
      snapshotId: snapshot?.id || null,
      source: snapshot?.source || null,
      capturedAt: snapshot?.capturedAt || null,
      mode,
    }));
  }

  restoreSimulator(snapshot) {
    try {
      if (snapshot?.values) this.simulator.readVehicleState(snapshot.values);
    } catch {
      // Provider remains authoritative; simulator restoration is best-effort.
    }
  }
}
