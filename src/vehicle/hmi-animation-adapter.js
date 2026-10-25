import {
  inspectObservedConflictProviderProof,
  inspectObservedSuccessProviderProof,
  inspectVehicleTerminalContract,
  mergeConfirmedVehicleSnapshot,
} from "./execution-state-contract.js";
import {
  expectedVehicleRequestedState,
  sameVehicleStructuredFact,
} from "./vehicle-command-contract.js";

// ---- HC-P1-11: ToolPresentationRegistry — replaces scattered hardcoded tool→visual mappings ----
export const TOOL_PRESENTATION_REGISTRY = Object.freeze({
  "body.window.setPosition": {
    visualScenario: "windowControl",
    defaultComponent: "frontLeftWindow",
    appMode: "cabin",
    modes: ["completed"],
  },
  "body.tailgate.open": {
    visualScenario: "trunkControl",
    defaultComponent: "tailgate",
    appMode: "tailgate",
    modes: ["completed"],
  },
  "seat.driver.setBackrestAngle": {
    visualScenario: "seatControl",
    defaultComponent: "driverSeatBackrest",
    appMode: "cabin",
    modes: ["completed"],
  },
  "seat.comfort.setLevel": {
    visualScenario: "cabin",
    defaultComponent: "cabin",
    appMode: "cabin",
    modes: ["completed"],
  },
  "vehicle.component.setState": {
    visualScenario: "componentControl",
    defaultComponent: "vehicleComponent",
    appMode: "cabin",
    modes: ["completed"],
  },
  "cabin.climate.setPreset": {
    visualScenario: "cabin",
    defaultComponent: "cabin",
    appMode: "cabin",
    modes: ["completed"],
  },
  "cabin.comfort.applySettings": {
    visualScenario: "cabin",
    defaultComponent: "cabin",
    appMode: "cabin",
    modes: ["completed"],
  },
  "energy.findSwapStation": {
    visualScenario: "energy",
    defaultComponent: "battery",
    appMode: "energy",
    modes: ["completed", "energy"],
  },
  "navigation.planRoute": {
    visualScenario: "planning",
    defaultComponent: "body",
    appMode: "planning",
    modes: ["completed"],
  },
  "safety.reject": {
    visualScenario: "blocked",
    defaultComponent: "body",
    appMode: "blocked",
    modes: ["blocked"],
  },
});

const TOOL_PRESENTATION_BY_SCENARIO = Object.freeze(
  Object.values(TOOL_PRESENTATION_REGISTRY).reduce((acc, entry) => {
    acc[entry.visualScenario] ||= {
      visualScenario: entry.visualScenario,
      defaultComponent: entry.defaultComponent,
      appMode: entry.appMode || null,
      modes: [...entry.modes],
    };
    return acc;
  }, {}),
);

const WINDOW_COMPONENT_BY_ZONE = Object.freeze({
  front_left: "frontLeftWindow",
  front_right: "frontRightWindow",
  rear_left: "rearLeftWindow",
  rear_right: "rearRightWindow",
});

export function resolvePresentationByScenario(scenario) {
  return TOOL_PRESENTATION_BY_SCENARIO[scenario] || null;
}

export function resolveModeByScenario(scenario, fallback = null) {
  if (scenario === "none") return "no-animation";
  const presentation = resolvePresentationByScenario(scenario);
  if (!presentation) return fallback;
  if (presentation.appMode) return presentation.appMode;
  return fallback || "completed";
}

const VEHICLE_EXECUTION_TO_PRESENTATION = Object.freeze({
  "body.window.setPosition": {
    component: (requestedState) => {
      const zone = Object.keys(requestedState?.windowPositionPercentByZone || {})[0];
      return WINDOW_COMPONENT_BY_ZONE[zone] || "frontLeftWindow";
    },
    animationState: (snapshot, requestedState) => {
      const zone = Object.keys(requestedState?.windowPositionPercentByZone || {})[0];
      const percent = snapshot?.values?.windowPositionPercentByZone?.[zone];
      return zone && Number.isFinite(percent)
        ? { windowPositionPercent: percent, windowPositionPercentByZone: { [zone]: percent } }
        : null;
    },
  },
  "body.tailgate.open": {
    component: () => "tailgate",
    animationState: (snapshot) => typeof snapshot?.values?.tailgateOpen === "boolean"
      ? { tailgateOpen: snapshot.values.tailgateOpen }
      : null,
  },
  "seat.driver.setBackrestAngle": {
    component: () => "driverSeatBackrest",
    animationState: (snapshot) => Number.isFinite(snapshot?.values?.driverBackrestAngle)
      ? { driverBackrestAngle: snapshot.values.driverBackrestAngle }
      : null,
  },
  "seat.comfort.setLevel": {
    component: () => "cabin",
    animationState: (snapshot, requestedState) => vehicleStateMatchesRequested(snapshot, requestedState)
      ? { seatComfortByZone: requestedState.seatComfortByZone }
      : null,
  },
  "vehicle.component.setState": {
    component: (requestedState) => Object.keys(requestedState?.componentActionStateById || {})[0] || "vehicleComponent",
    animationState: (snapshot, requestedState) => {
      const observed = snapshot?.values?.componentActionStateById;
      const requested = requestedState?.componentActionStateById;
      if (!observed || !requested || Object.entries(requested).some(([id, value]) => observed[id] !== value)) {
        return null;
      }
      return { componentActionStateById: { ...requested } };
    },
  },
  "cabin.climate.setPreset": {
    component: () => "cabin",
    animationState: (snapshot, requestedState) => vehicleStateMatchesRequested(snapshot, requestedState)
      ? Object.fromEntries(Object.keys(requestedState).map((key) => [key, snapshot.values[key]]))
      : null,
  },
  "cabin.comfort.applySettings": {
    component: () => "cabin",
    animationState: (snapshot, requestedState) => vehicleStateMatchesRequested(snapshot, requestedState)
      ? Object.fromEntries(Object.keys(requestedState).map((key) => [key, snapshot.values[key]]))
      : null,
  },
});

function vehicleStateMatchesRequested(snapshot, requestedState) {
  return Boolean(snapshot?.values && requestedState)
    && Object.entries(requestedState).every(([key, value]) => sameVehicleStructuredFact(snapshot.values[key], value));
}

const PENDING_EXECUTION_STATES = new Set(["submitted", "accepted", "executing"]);
const CANCELLED_EXECUTION_STATES = new Set(["failed", "timeout", "duplicate-command"]);
const EXTERNAL_DATA_TOOLS = new Set(["energy.findSwapStation", "navigation.planRoute"]);
const SEAT_ADJUSTMENT_PRESENTATION_COMPONENTS = new Set([
  "driverSeatBackrest",
  "driver_seat_fore_aft",
  "driver_seat_height",
  "driver_seat_backrest_recline",
  "driver_seat_headrest_height",
]);

export function isSeatAdjustmentHmiPresentation(presentation) {
  return presentation?.visualScenario === "seatControl"
    || SEAT_ADJUSTMENT_PRESENTATION_COMPONENTS.has(presentation?.component);
}

function unsupportedPresentation(toolResult, reason) {
  return {
    phase: "unsupported",
    commandId: toolResult?.commandId || null,
    component: null,
    visualScenario: "none",
    mode: "no-animation",
    animationState: null,
    noAnimation: true,
    reason,
  };
}

function validCancellationFacts(cancellation) {
  return Boolean(cancellation)
    && typeof cancellation === "object"
    && !Array.isArray(cancellation)
    && typeof cancellation.requested === "boolean"
    && cancellation.physicalUndoClaimed === false;
}

function validCommandIdentity({ requestId, commandId, tool } = {}) {
  if (typeof requestId !== "string"
    || !requestId
    || typeof commandId !== "string"
    || typeof tool !== "string"
    || !tool) {
    return false;
  }
  const prefix = `${requestId}:`;
  const suffix = `:${tool}`;
  if (!commandId.startsWith(prefix) || !commandId.endsWith(suffix)) return false;
  const sequence = commandId.slice(prefix.length, -suffix.length);
  return /^[1-9]\d*$/.test(sequence);
}

function sameDispatchedCommand(left, right) {
  return left?.requestId === right?.requestId
    && left?.commandId === right?.commandId
    && left?.tool === right?.tool;
}

function terminalStatusMatchesExecution(event) {
  const executionState = event?.toolResult?.executionState;
  if (executionState === "observed-succeeded") {
    return event.status === "completed" && event.toolResult.ok === true;
  }
  if (CANCELLED_EXECUTION_STATES.has(executionState)) {
    return ["cancelled", "failed", "uncertain"].includes(event.status)
      && event.toolResult.ok === false;
  }
  return false;
}

function validVehicleEventCorrelation(event) {
  const toolResult = event?.toolResult;
  if (event?.component !== "vehicleTool"
    || event.phase !== "vehicle-execution"
    || !toolResult
    || toolResult.requestId !== event.runId
    || !validCommandIdentity(toolResult)
    || !terminalStatusMatchesExecution(event)
    || !inspectVehicleTerminalContract({
      toolResult,
      commitmentState: event.commitmentState,
      cancellation: event.cancellation,
    }).ok) {
    return false;
  }
  return true;
}

export function registerDispatchedVehicleCommand(
  currentRegistry,
  event,
  { currentRequestId } = {},
) {
  const current = currentRegistry instanceof Map ? currentRegistry : new Map();
  const command = event?.toolCall;
  if (event?.component !== "vehicleTool"
    || event.phase !== "vehicle-execution"
    || event.status !== "processing"
    || event.runId !== currentRequestId
    || event.runId !== command?.requestId
    || !validCommandIdentity(command)) {
    return {
      accepted: false,
      dispatchedVehicleCommandsByCommandId: current,
    };
  }
  const existing = current.get(command.commandId);
  if (existing && !sameDispatchedCommand(existing, command)) {
    return {
      accepted: false,
      dispatchedVehicleCommandsByCommandId: current,
    };
  }
  const expectedRequestedState = expectedVehicleRequestedState(command);
  if (!expectedRequestedState) {
    return {
      accepted: false,
      dispatchedVehicleCommandsByCommandId: current,
    };
  }
  const dispatchedVehicleCommandsByCommandId = new Map(current);
  dispatchedVehicleCommandsByCommandId.set(command.commandId, {
    requestId: command.requestId,
    commandId: command.commandId,
    tool: command.tool,
    args: command.args,
    expectedRequestedState,
  });
  return {
    accepted: true,
    dispatchedVehicleCommandsByCommandId,
  };
}

export function completeDispatchedVehicleCommand(currentRegistry, result) {
  const current = currentRegistry instanceof Map ? currentRegistry : new Map();
  const command = result?.toolCall;
  const registered = current.get(command?.commandId);
  if (result?.requestId !== command?.requestId
    || !validCommandIdentity(command)
    || !sameDispatchedCommand(registered, command)) {
    return {
      accepted: false,
      dispatchedVehicleCommandsByCommandId: current,
    };
  }
  const dispatchedVehicleCommandsByCommandId = new Map(current);
  dispatchedVehicleCommandsByCommandId.delete(command.commandId);
  return {
    accepted: true,
    dispatchedVehicleCommandsByCommandId,
  };
}

function removePendingVehicleCommand(currentPending, commandId) {
  const nextPending = new Map(currentPending || []);
  for (const [component, pending] of nextPending) {
    if (pending?.commandId === commandId) nextPending.delete(component);
  }
  return nextPending;
}

export function reduceVehicleRuntimeResultTransaction(currentState, result) {
  const currentRunCommand = commandFromCurrentRun(currentState, result?.requestId);
  const registeredCommand = commandFromRegistry(currentState, result);
  const tombstoneCommand = commandFromTombstone(currentState, result);
  const trustedCommand = currentRunCommand || registeredCommand || tombstoneCommand;
  if (!result?.toolResult || !trustedCommand) {
    return failCloseVehicleRuntimeResult(currentState, trustedCommand);
  }
  return reduceVehicleTerminalTransaction(currentState, {
    source: "runtime-result",
    requestId: result.requestId,
    command: trustedCommand,
    toolResult: result.toolResult,
    vehicleStateSnapshot: result.vehicleStateSnapshot,
    commitmentState: result.commitmentState,
    cancellation: result.cancellation,
  }, {
    currentRequestId: currentState?.currentRun?.requestId,
    failCloseMalformed: true,
    failCloseCommand: trustedCommand,
  });
}

const MAX_VERIFIED_TERMINALS = 128;

function commandFromCurrentRun(currentState, requestId) {
  const run = currentState?.currentRun;
  if (!run || run.requestId !== requestId || !run.pendingVehicleCommandId
    || !run.pendingVehicleTool) return null;
  return {
    requestId,
    commandId: run.pendingVehicleCommandId,
    tool: run.pendingVehicleTool,
  };
}

function resultCommandIds(result) {
  return [...new Set([
    result?.toolResult?.commandId,
    result?.toolCall?.commandId,
  ].filter((commandId) => typeof commandId === "string" && commandId))];
}

function commandFromRegistry(currentState, result) {
  const registry = currentState?.dispatchedVehicleCommandsByCommandId;
  if (!(registry instanceof Map)) return null;
  for (const commandId of resultCommandIds(result)) {
    const command = registry.get(commandId);
    if (command?.requestId === result?.requestId) return command;
  }
  return null;
}

function commandFromTombstone(currentState, result) {
  const tombstones = currentState?.verifiedVehicleTerminalsByCommandId;
  if (!(tombstones instanceof Map)) return null;
  for (const commandId of resultCommandIds(result)) {
    const command = tombstones.get(commandId)?.facts?.command;
    if (command?.requestId === result?.requestId) return command;
  }
  return null;
}

function terminalFacts(terminal) {
  const toolResult = terminal.toolResult;
  const normalizedToolResult = projectTerminalToolResultFacts(toolResult);
  return {
    requestId: terminal.requestId,
    command: {
      requestId: terminal.command.requestId,
      commandId: terminal.command.commandId,
      tool: terminal.command.tool,
    },
    toolResult: normalizedToolResult,
    vehicleStateSnapshot: terminal.vehicleStateSnapshot ?? null,
    commitmentState: terminal.commitmentState,
    cancellation: terminal.cancellation,
  };
}

function boundedTombstones(current, commandId, entry) {
  const next = new Map(current || []);
  next.set(commandId, entry);
  while (next.size > MAX_VERIFIED_TERMINALS) {
    next.delete(next.keys().next().value);
  }
  return next;
}

function projectTerminalToolResultFacts(toolResult) {
  if (!toolResult || typeof toolResult !== "object" || Array.isArray(toolResult)) return toolResult;
  const projected = {
    requestId: toolResult.requestId,
    commandId: toolResult.commandId,
    tool: toolResult.tool,
    ok: toolResult.ok,
    executionState: toolResult.executionState,
    requestedState: toolResult.requestedState,
    executionTrace: Array.isArray(toolResult.executionTrace)
      ? toolResult.executionTrace.map((entry) => ({
          state: entry.state,
          source: entry.source,
          at: entry.at,
        }))
      : toolResult.executionTrace,
    simulated: toolResult.simulated,
  };
  for (const field of ["visualScenario", "source", "timestamp", "confirmedSnapshotId", "executionError"]) {
    if (Object.hasOwn(toolResult, field)) projected[field] = toolResult[field];
  }
  return projected;
}

function baseTerminalState(currentState) {
  return {
    handled: false,
    contractValid: false,
    presentation: null,
    presentationAccepted: false,
    factsAccepted: false,
    currentRun: currentState?.currentRun || null,
    dispatchedVehicleCommandsByCommandId:
      currentState?.dispatchedVehicleCommandsByCommandId || new Map(),
    verifiedVehicleTerminalsByCommandId:
      currentState?.verifiedVehicleTerminalsByCommandId || new Map(),
    pendingVehicleExecutionsByComponent:
      currentState?.pendingVehicleExecutionsByComponent || new Map(),
    confirmedVehicleStateSnapshot:
      currentState?.confirmedVehicleStateSnapshot || null,
  };
}

function failCloseVehicleRuntimeResult(currentState, command) {
  const base = baseTerminalState(currentState);
  const currentRunMatchesCommand = base.currentRun?.requestId === command?.requestId
    && (!base.currentRun.pendingVehicleCommandId
      || base.currentRun.pendingVehicleCommandId === command?.commandId)
    && (!base.currentRun.pendingVehicleTool
      || base.currentRun.pendingVehicleTool === command?.tool);
  return {
    ...base,
    handled: Boolean(command),
    currentRun: currentRunMatchesCommand ? null : base.currentRun,
    pendingVehicleExecutionsByComponent: command
      ? removePendingVehicleCommand(base.pendingVehicleExecutionsByComponent, command.commandId)
      : base.pendingVehicleExecutionsByComponent,
  };
}

function reduceVehicleTerminalTransaction(
  currentState,
  terminal,
  { currentRequestId, failCloseMalformed = false, failCloseCommand } = {},
) {
  const base = baseTerminalState(currentState);
  const command = terminal?.command;
  const registered = base.dispatchedVehicleCommandsByCommandId.get(command?.commandId);
  const tombstone = base.verifiedVehicleTerminalsByCommandId.get(command?.commandId);
  const expectedRequestedState = registered?.expectedRequestedState
    || tombstone?.expectedRequestedState;
  const identityValid = terminal?.requestId === command?.requestId
    && terminal?.toolResult?.requestId === command?.requestId
    && terminal?.toolResult?.commandId === command?.commandId
    && terminal?.toolResult?.tool === command?.tool
    && validCommandIdentity(command)
    && (sameDispatchedCommand(registered, command)
      || sameDispatchedCommand(tombstone?.facts?.command, command));
  const snapshotValid = terminal?.vehicleStateSnapshot == null
    || mergeConfirmedVehicleSnapshot(null, terminal.vehicleStateSnapshot).accepted;
  const contractValid = identityValid
    && expectedRequestedState
    && sameVehicleStructuredFact(
      terminal.toolResult.requestedState,
      expectedRequestedState,
    )
    && inspectVehicleTerminalContract({
      toolResult: terminal.toolResult,
      commitmentState: terminal.commitmentState,
      cancellation: terminal.cancellation,
    }).ok
    && snapshotValid;

  if (!contractValid) {
    return failCloseMalformed
      ? failCloseVehicleRuntimeResult(currentState, failCloseCommand || command)
      : base;
  }

  const facts = terminalFacts(terminal);
  if (tombstone) {
    const sameFact = sameVehicleStructuredFact(tombstone.facts, facts);
    if (!sameFact && typeof window !== 'undefined') {
      window.__lastFactDiff = {
        tombstone: JSON.stringify(tombstone.facts?.toolResult || null),
        facts: JSON.stringify(facts?.toolResult || null),
      };
    }
    if (!sameFact) {
      const failed = failCloseVehicleRuntimeResult(currentState, command);
      return { ...failed, handled: true, contractValid: false };
    }
    if (tombstone.sources.includes(terminal.source)) {
      const replayed = failCloseVehicleRuntimeResult(currentState, command);
      return {
        ...replayed,
        handled: true,
        contractValid: true,
      };
    }
    const replayed = failCloseVehicleRuntimeResult(currentState, command);
    return {
      ...replayed,
      handled: true,
      contractValid: true,
      verifiedVehicleTerminalsByCommandId: boundedTombstones(
        base.verifiedVehicleTerminalsByCommandId,
        command.commandId,
        { ...tombstone, sources: [...tombstone.sources, terminal.source] },
      ),
    };
  }
  if (!registered) return base;

  const presentation = mapVehicleExecutionToHmi({
    toolResult: terminal.toolResult,
    vehicleStateSnapshot: terminal.vehicleStateSnapshot,
    previousConfirmedState: base.confirmedVehicleStateSnapshot,
    commitmentState: terminal.commitmentState,
    cancellation: terminal.cancellation,
    expectedRequestedState,
  });
  if (presentation.phase === "unsupported") {
    return failCloseMalformed
      ? failCloseVehicleRuntimeResult(currentState, failCloseCommand || command)
      : base;
  }

  const dispatchedVehicleCommandsByCommandId = new Map(
    base.dispatchedVehicleCommandsByCommandId,
  );
  dispatchedVehicleCommandsByCommandId.delete(command.commandId);
  const pendingVehicleExecutionsByComponent = removePendingVehicleCommand(
    base.pendingVehicleExecutionsByComponent,
    command.commandId,
  );
  const commandWasPending = pendingVehicleExecutionsByComponent.size
    !== base.pendingVehicleExecutionsByComponent.size;
  const merged = terminal.vehicleStateSnapshot == null
    ? {
      snapshot: base.confirmedVehicleStateSnapshot,
      accepted: false,
    }
    : mergeConfirmedVehicleSnapshot(
      base.confirmedVehicleStateSnapshot,
      terminal.vehicleStateSnapshot,
    );
  const ownsPresentation = terminal.requestId === currentRequestId
    && commandWasPending
    && (presentation.phase !== "confirmed" || merged.accepted);
  return {
    ...base,
    handled: true,
    contractValid: true,
    presentation: ownsPresentation ? presentation : null,
    presentationAccepted: ownsPresentation,
    factsAccepted: merged.accepted,
    currentRun: terminal.source === "runtime-result"
      ? failCloseVehicleRuntimeResult(currentState, command).currentRun
      : base.currentRun,
    dispatchedVehicleCommandsByCommandId,
    verifiedVehicleTerminalsByCommandId: boundedTombstones(
      base.verifiedVehicleTerminalsByCommandId,
      command.commandId,
      {
        expectedRequestedState,
        facts,
        sources: [terminal.source],
      },
    ),
    pendingVehicleExecutionsByComponent,
    confirmedVehicleStateSnapshot: merged.snapshot,
  };
}

export function mapVehicleExecutionToHmi({
  toolResult,
  vehicleStateSnapshot,
  previousConfirmedState,
  commitmentState,
  cancellation,
  expectedRequestedState = toolResult?.requestedState,
} = {}) {
  const executionPresentation = VEHICLE_EXECUTION_TO_PRESENTATION[toolResult?.tool];
  const registryPresentation = TOOL_PRESENTATION_REGISTRY[toolResult?.tool];
  if (!executionPresentation || !registryPresentation) {
    return unsupportedPresentation(
      toolResult,
      `工具 "${toolResult?.tool}" 没有注册的车辆 HMI 展示映射（ToolPresentationRegistry miss）`,
    );
  }

  const component = executionPresentation.component(toolResult.requestedState);
  if (!component || !toolResult.commandId) {
    return unsupportedPresentation(toolResult, "车辆 HMI 展示缺少有效 commandId 或 component");
  }

  const base = {
    commandId: toolResult.commandId,
    component,
    visualScenario: registryPresentation.visualScenario,
    animationState: null,
    noAnimation: true,
    reason: null,
  };

  if (PENDING_EXECUTION_STATES.has(toolResult.executionState)) {
    return { ...base, phase: "pending", mode: "pending" };
  }

  const terminalContract = inspectVehicleTerminalContract({
    toolResult,
    commitmentState,
    cancellation,
  });
  if (!terminalContract.ok) {
    return unsupportedPresentation(toolResult, "车辆终态执行事实不完整或相互矛盾");
  }

  if (CANCELLED_EXECUTION_STATES.has(toolResult.executionState)) {
    if (toolResult.executionState === "failed"
      && toolResult.executionError?.code === "sensor-observation-conflict"
      && commitmentState === "provider-terminal"
      && validCancellationFacts(cancellation)
      && inspectObservedConflictProviderProof({
        toolResult,
        vehicleStateSnapshot,
        expectedRequestedState,
      }).ok) {
      const animationState = executionPresentation.animationState(
        vehicleStateSnapshot,
        toolResult.requestedState,
      );
      if (!animationState) {
        if (toolResult.tool === "vehicle.component.setState") {
          return {
            ...base,
            phase: "observed-conflict",
            mode: "blocked",
            animationState: null,
            noAnimation: true,
            reason: toolResult.executionError?.message || "传感器实际状态与请求目标不一致。",
          };
        }
        return unsupportedPresentation(toolResult, "Provider 冲突快照缺少组件实际状态");
      }
      return {
        ...base,
        phase: "observed-conflict",
        mode: "blocked",
        animationState,
        noAnimation: false,
        reason: toolResult.executionError?.message || "传感器实际状态与请求目标不一致。",
      };
    }
    return {
      ...base,
      phase: "cancelled",
      mode: "no-animation",
      reason: toolResult.executionError?.message || toolResult.executionState,
    };
  }

  if (toolResult.executionState !== "observed-succeeded") {
    return unsupportedPresentation(toolResult, `不支持的车辆执行状态 ${toolResult.executionState}`);
  }
  if (commitmentState !== "provider-terminal") {
    return unsupportedPresentation(toolResult, `车辆执行承诺尚未到达 Provider 终态：${commitmentState}`);
  }
  if (!validCancellationFacts(cancellation)) {
    return unsupportedPresentation(toolResult, "车辆执行缺少有效的取消事实");
  }
  if (!inspectObservedSuccessProviderProof({
    toolResult,
    vehicleStateSnapshot,
    expectedRequestedState,
  }).ok) {
    return unsupportedPresentation(toolResult, "VehicleStateSnapshot 缺少有效的 Provider 成功证明");
  }

  const animationState = executionPresentation.animationState(
    vehicleStateSnapshot,
    toolResult.requestedState,
  );
  if (!animationState) {
    return unsupportedPresentation(toolResult, "VehicleStateSnapshot 缺少组件确认状态");
  }
  return {
    ...base,
    phase: "confirmed",
    mode: registryPresentation.appMode || "completed",
    animationState,
    noAnimation: false,
  };
}

export function mapVehicleRuntimeResultToHmi(result, { previousConfirmedState } = {}) {
  const expectedRequestedState = expectedVehicleRequestedState(result?.toolCall);
  return mapVehicleExecutionToHmi({
    toolResult: result?.toolResult,
    vehicleStateSnapshot: result?.vehicleStateSnapshot,
    previousConfirmedState,
    commitmentState: result?.commitmentState,
    cancellation: result?.cancellation,
    expectedRequestedState,
  });
}

export function mapCancelledVehicleEventToHmi(
  event,
  { previousConfirmedState } = {},
) {
  if (!validVehicleEventCorrelation(event)) return null;
  const presentation = mapVehicleExecutionToHmi({
    toolResult: event.toolResult,
    vehicleStateSnapshot: event.providerSnapshot,
    previousConfirmedState,
    commitmentState: event.commitmentState,
    cancellation: event.cancellation,
  });
  if (presentation.phase === "unsupported") return null;
  if (presentation.phase === "confirmed"
    && event.commitmentState !== "provider-terminal") {
    return null;
  }
  return presentation;
}

export function consumeCancelledVehicleTerminalEvent(
  currentState,
  event,
  { currentRequestId } = {},
) {
  if (!validVehicleEventCorrelation(event)) return baseTerminalState(currentState);
  return reduceVehicleTerminalTransaction(currentState, {
    source: "terminal-event",
    requestId: event.runId,
    command: event.toolResult,
    toolResult: event.toolResult,
    vehicleStateSnapshot: event.providerSnapshot,
    commitmentState: event.commitmentState,
    cancellation: event.cancellation,
  }, { currentRequestId });
}

export function reduceVehicleHmiState(currentState, presentation, { vehicleStateSnapshot } = {}) {
  const pendingVehicleExecutionsByComponent = new Map(
    currentState?.pendingVehicleExecutionsByComponent || [],
  );
  let confirmedVehicleStateSnapshot = currentState?.confirmedVehicleStateSnapshot || null;
  let accepted = false;
  let factsAccepted = false;
  let presentationAccepted = false;

  if (presentation?.phase === "pending") {
    pendingVehicleExecutionsByComponent.set(presentation.component, presentation);
    accepted = true;
    presentationAccepted = true;
  } else if (["confirmed", "observed-conflict"].includes(presentation?.phase)) {
    const pending = pendingVehicleExecutionsByComponent.get(presentation.component);
    if (pending?.commandId === presentation.commandId) {
      pendingVehicleExecutionsByComponent.delete(presentation.component);
      accepted = true;
      const merged = mergeConfirmedVehicleSnapshot(
        confirmedVehicleStateSnapshot,
        vehicleStateSnapshot,
      );
      confirmedVehicleStateSnapshot = merged.snapshot;
      factsAccepted = merged.accepted;
      presentationAccepted = merged.accepted;
    }
  } else if (presentation?.phase === "cancelled") {
    const pending = pendingVehicleExecutionsByComponent.get(presentation.component);
    if (pending?.commandId === presentation.commandId) {
      pendingVehicleExecutionsByComponent.delete(presentation.component);
      accepted = true;
      presentationAccepted = true;
    }
  }

  return {
    pendingVehicleExecutionsByComponent,
    confirmedVehicleStateSnapshot,
    accepted,
    factsAccepted,
    presentationAccepted,
  };
}

export function applyHmiPresentation(presentation, vehicleRig = globalThis.window?.vehicleRig) {
  const seatAdjustment = isSeatAdjustmentHmiPresentation(presentation);
  if (presentation?.phase === "pending") {
    if (seatAdjustment) {
      vehicleRig?.beginSeatAdjustmentFocus?.({ reason: "pending-seat-execution" });
    } else {
      vehicleRig?.endSeatAdjustmentFocus?.({ delayMs: 0, reason: "non-seat-presentation" });
    }
    return presentation;
  }
  if (seatAdjustment && ["cancelled", "observed-conflict", "unsupported"].includes(presentation?.phase)) {
    vehicleRig?.endSeatAdjustmentFocus?.({
      delayMs: 0,
      reason: `seat-${presentation.phase}`,
    });
  }
  if (!presentation || presentation.noAnimation
    || !["confirmed", "observed-conflict"].includes(presentation.phase)) {
    return presentation || null;
  }
  vehicleRig?.playScenarioAnimation?.(presentation.visualScenario, {
    ...presentation,
    statePatch: { ...presentation.animationState },
  });
  return presentation;
}

// ExternalDataAdapter compatibility is intentionally separate from vehicle observations.
function resolveExternalPresentation(toolResult = {}) {
  const { tool } = toolResult;
  if (!EXTERNAL_DATA_TOOLS.has(tool)) {
    return {
      visualScenario: "unsupported",
      component: "body",
      mode: "blocked",
      unsupported: true,
      reason: `工具 "${tool}" 不是 ExternalDataAdapter 展示工具`,
    };
  }
  const entry = TOOL_PRESENTATION_REGISTRY[tool];
  if (!entry) {
    return {
      visualScenario: "unsupported",
      component: "body",
      mode: "blocked",
      unsupported: true,
      reason: `工具 "${tool}" 没有注册的 HMI 展示映射（ToolPresentationRegistry miss）`,
    };
  }
  return entry;
}

export function mapExternalDataToolResultToHmiAnimation(toolResult = {}) {
  const ok = toolResult.ok === true;
  const presentation = resolveExternalPresentation(toolResult);
  if (presentation.unsupported) {
    return {
      visualScenario: "none",
      mode: "no-animation",
      component: null,
      statePatch: { ...(toolResult.statePatch || {}) },
      ok: false,
      tool: toolResult.tool,
      source: toolResult.source || "dev-adapter",
      noAnimation: true,
      unsupported: true,
      reason: presentation.reason,
    };
  }

  const blocked = !ok || toolResult.visualScenario === "blocked" || toolResult.statePatch?.rejected === true;

  if (blocked) {
    return {
      visualScenario: presentation.visualScenario,
      mode: presentation.modes.includes("blocked") ? "blocked" : "no-animation",
      component: presentation.defaultComponent,
      statePatch: { ...(toolResult.statePatch || {}) },
      ok,
      tool: toolResult.tool,
      source: toolResult.source || "dev-adapter",
      noAnimation: !presentation.modes.includes("blocked"),
    };
  }

  // HC-P1-11: registry-driven resolution
  return {
    visualScenario: presentation.visualScenario,
    mode: presentation.modes.includes("energy") && !blocked ? "energy" : "completed",
    component: presentation.defaultComponent,
    statePatch: { ...(toolResult.statePatch || {}) },
    ok,
    tool: toolResult.tool,
    source: toolResult.source || "dev-adapter",
  };
}

export function applyExternalDataHmiAnimation(toolResult, vehicleRig = globalThis.window?.vehicleRig) {
  if (!toolResult) return null;

  const animation = mapExternalDataToolResultToHmiAnimation(toolResult);
  if (animation.noAnimation) return animation;
  vehicleRig?.playScenarioAnimation?.(animation.visualScenario, animation);
  return animation;
}
