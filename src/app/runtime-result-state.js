import { isVehicleControlIntent } from "../runtime/agent-schemas.js";
import {
  consumeCancelledVehicleTerminalEvent,
  reduceVehicleRuntimeResultTransaction,
} from "../vehicle/hmi-animation-adapter.js";

export function reduceAppRuntimeVehicleEvent(currentState, event, options) {
  const transaction = consumeCancelledVehicleTerminalEvent(currentState, event, options);
  if (!transaction.handled) return { transaction, nextState: currentState };
  return {
    transaction,
    nextState: {
      ...currentState,
      currentRun: transaction.currentRun,
      dispatchedVehicleCommandsByCommandId:
        transaction.dispatchedVehicleCommandsByCommandId,
      verifiedVehicleTerminalsByCommandId:
        transaction.verifiedVehicleTerminalsByCommandId,
      pendingVehicleExecutionsByComponent:
        transaction.pendingVehicleExecutionsByComponent,
      confirmedVehicleStateSnapshot:
        transaction.confirmedVehicleStateSnapshot,
    },
  };
}

export function applyAppRuntimeVehicleEventEffects(transaction, {
  applyPresentation,
  renderMetrics,
} = {}) {
  if (transaction?.presentationAccepted !== true) {
    return Object.freeze({ presentationApplied: false, metricsRendered: false });
  }
  const presentationApplied = Boolean(
    transaction.presentation && typeof applyPresentation === "function",
  );
  if (presentationApplied) applyPresentation(transaction.presentation);
  const metricsRendered = transaction.factsAccepted === true
    && typeof renderMetrics === "function";
  if (metricsRendered) renderMetrics();
  return Object.freeze({ presentationApplied, metricsRendered });
}

export function reduceAppRuntimeVehicleResult(currentState, result) {
  const vehicleTransaction = reduceVehicleRuntimeResultTransaction(currentState, result);
  const transaction = vehicleTransaction.handled ? vehicleTransaction : null;
  const declaredVehicleControl = isVehicleControlIntent(result?.parsedCommand?.intent);
  const effectiveVehicleControl = Boolean(transaction) || declaredVehicleControl;
  const safetyBlockedVehicleControl = declaredVehicleControl
    && !transaction
    && result?.safetyDecision?.allowed !== true;
  return {
    consumable: Boolean(transaction)
      || !declaredVehicleControl
      || safetyBlockedVehicleControl,
    effectiveVehicleControl,
    safetyBlockedVehicleControl,
    transaction,
  };
}

export function selectAppRuntimeVehicleMetricsSnapshot(currentState, result, route) {
  if (!route?.effectiveVehicleControl) return result?.vehicleStateSnapshot ?? null;
  if (route.transaction) {
    return route.transaction.confirmedVehicleStateSnapshot ?? null;
  }
  return currentState?.confirmedVehicleStateSnapshot ?? null;
}
