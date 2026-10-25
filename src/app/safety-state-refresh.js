export function createSafetyStateRefresh({ vehicleStateProvider, readVehicleState }) {
  let staged = null;

  return Object.freeze({
    markStaged(snapshot, { preserve = false } = {}) {
      staged = { snapshot, preserve };
    },
    refresh() {
      const currentSnapshot = vehicleStateProvider.getSnapshot();
      if (staged?.preserve === true && staged.snapshot === currentSnapshot) {
        staged = null;
        return { ok: true, snapshot: currentSnapshot };
      }
      staged = null;
      return vehicleStateProvider.ingestDemoSensorState(readVehicleState());
    },
  });
}
