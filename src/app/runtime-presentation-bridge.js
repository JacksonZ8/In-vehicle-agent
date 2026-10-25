import {
  inspectObservedConflictProviderProof,
  inspectObservedSuccessProviderProof,
  inspectVehicleTerminalContract,
} from "../vehicle/execution-state-contract.js";
import { expectedVehicleRequestedState } from "../vehicle/vehicle-command-contract.js";

const MAX_PENDING_VEHICLE_COMMANDS = 128;
const MAX_TERMINAL_FACTS = 128;
const MAX_SEEN_EVENT_IDS = 512;

export function createRuntimePresentationBridge({
  state,
  interactionSessionController,
  render,
  applyVehiclePresentation,
  startVoiceBridge,
} = {}) {
  if (!state || typeof state !== "object") throw new TypeError("state is required");
  if (!interactionSessionController
    || typeof interactionSessionController.isCurrent !== "function"
    || typeof interactionSessionController.linkRun !== "function") {
    throw new TypeError("interactionSessionController must provide isCurrent() and linkRun()");
  }
  if (typeof render !== "function") throw new TypeError("render must be a function");
  if (typeof applyVehiclePresentation !== "function") {
    throw new TypeError("applyVehiclePresentation must be a function");
  }
  if (startVoiceBridge !== undefined && typeof startVoiceBridge !== "function") {
    throw new TypeError("startVoiceBridge must be a function");
  }

  const seenEventIds = new Set();
  const dispatchedCommands = new Map();
  const terminalFactsByCommandId = new Map();

  const handleEvent = (event) => {
    const identity = eventIdentity(event);
    if (seenEventIds.has(event?.eventId)) {
      return frozenOutcome(false, "stale", { authorized: false, reason: "event-replay" });
    }
    if (!isCurrentEvent(state, interactionSessionController, event, identity)) {
      return handleLateVehicleTerminal(event);
    }

    rememberBounded(seenEventIds, event.eventId, MAX_SEEN_EVENT_IDS);
    interactionSessionController.linkRun(identity.turnId, {
      runId: event.runId,
      parentRunId: state.currentRun?.confirmationParentRunId ?? null,
      eventIds: [event.eventId],
    });
    appendObservedEvent(state.currentRun, event);
    forwardVoiceBridgeAuthorization(event, startVoiceBridge);

    const vehicle = projectVehicleEvent(event, state.providerSnapshot, dispatchedCommands);
    retainTerminalFact(terminalFactsByCommandId, vehicle.terminalFact);
    if (vehicle.notify) applyVehiclePresentation(vehicle.notify);

    const mode = modeForEvent(event, vehicle);
    state.mode = mode;
    render(Object.freeze({ type: "event", event, mode, vehicle: vehicle.outcome }));
    return frozenOutcome(true, mode, vehicle.outcome);
  };

  const handleLateVehicleTerminal = (event) => {
    if (!isVehicleTerminalEvent(event)) {
      return frozenOutcome(false, "stale", { authorized: false, reason: "event-identity-mismatch" });
    }
    const commandId = event.metadata?.vehicle?.toolResult?.commandId;
    const dispatched = dispatchedCommands.get(commandId);
    if (!validTerminalIdentity(event.metadata?.vehicle?.toolResult, dispatched, event.runId)) {
      return frozenOutcome(false, "stale", {
        authorized: false,
        reason: "late-terminal-without-dispatch",
      });
    }
    const vehicle = projectVehicleEvent(event, state.providerSnapshot, dispatchedCommands);
    if (!vehicle.terminalFact) {
      return frozenOutcome(false, "stale", {
        authorized: false,
        reason: "late-terminal-invalid",
      });
    }
    rememberBounded(seenEventIds, event.eventId, MAX_SEEN_EVENT_IDS);
    retainTerminalFact(terminalFactsByCommandId, vehicle.terminalFact);
    if (vehicle.notify) applyVehiclePresentation(vehicle.notify);
    return frozenOutcome(true, "late-terminal", vehicle.outcome);
  };

  const applyResult = (result, turnContext) => {
    if (!isCurrentResult(state, interactionSessionController, result, turnContext)) {
      return frozenOutcome(false, "stale", { authorized: false, reason: "result-identity-mismatch" });
    }

    interactionSessionController.linkRun(turnContext.turnId, {
      runId: result.requestId,
      parentRunId: state.currentRun?.confirmationParentRunId ?? null,
      eventIds: Array.isArray(result.events) ? result.events.map((event) => event.eventId) : [],
    });

    const commandId = result.toolResult?.commandId;
    const terminalFact = commandId ? terminalFactsByCommandId.get(commandId) ?? null : null;
    if (terminalFact) terminalFactsByCommandId.delete(commandId);
    const presentationResult = terminalFact
      ? Object.freeze({
        ...result,
        commitmentState: terminalFact.commitmentState,
        cancellation: terminalFact.cancellation,
      })
      : result;
    const mode = modeForResult(presentationResult);
    state.mode = mode;
    const rendered = render(Object.freeze({
      type: "result",
      result: presentationResult,
      turnContext,
      mode,
      terminalFact,
    })) || {};
    return Object.freeze({
      accepted: true,
      mode,
      vehicle: Object.freeze({
        authorized: Boolean(terminalFact?.confirmed),
        reason: terminalFact?.reason ?? "result-has-no-confirmed-vehicle-fact",
      }),
      outputMode: rendered.outputMode || (presentationResult.assistantResponse ? "voice" : "text"),
      speechPromise: rendered.speechPromise || Promise.resolve(),
    });
  };

  return Object.freeze({ handleEvent, applyResult });
}

function forwardVoiceBridgeAuthorization(event, startVoiceBridge) {
  const authorization = event?.metadata?.voiceBridgeEligibility;
  if (event?.component !== "voiceBridgeEligibility"
    || !isCompleteVoiceBridgeAuthorization(authorization, event.runId)
    || typeof startVoiceBridge !== "function") return;
  try {
    startVoiceBridge(Object.freeze({
      ...authorization,
      interactionEventId: event.eventId,
      turnId: event.metadata?.interactionRef?.turnId,
    }));
  } catch {
    // Waiting audio is an optional presentation effect and must not abort the Run.
  }
}

function isCompleteVoiceBridgeAuthorization(authorization, runId) {
  return Boolean(authorization
    && typeof authorization === "object"
    && !Array.isArray(authorization)
    && typeof authorization.allowed === "boolean"
    && typeof authorization.noToolOrSafetyPath === "boolean"
    && nonEmptyText(authorization.requestId)
    && nonEmptyText(authorization.reason)
    && nonEmptyText(authorization.policyId)
    && nonEmptyText(authorization.policyVersion)
    && authorization.requestId === runId
    && (authorization.allowed !== true || authorization.noToolOrSafetyPath === true));
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function eventIdentity(event) {
  return {
    sessionId: event?.metadata?.interactionRef?.sessionId,
    turnId: event?.metadata?.interactionRef?.turnId,
    runId: event?.runId,
  };
}

function isCurrentEvent(state, controller, event, identity) {
  return Boolean(event?.eventId
    && event?.runId
    && state.currentRun?.requestId === event.runId
    && controller.isCurrent(identity));
}

function isCurrentResult(state, controller, result, turn) {
  return Boolean(result?.requestId
    && result.requestId === turn?.runId
    && result.interactionRef?.sessionId === turn?.sessionId
    && result.interactionRef?.turnId === turn?.turnId
    && state.currentRun?.requestId === result.requestId
    && !state.consumedRuntimeRequestIds?.has(result.requestId)
    && controller.isCurrent({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    }));
}

function appendObservedEvent(run, event) {
  if (!run || !Array.isArray(run.events)) return;
  run.events.push(event);
}

function projectVehicleEvent(event, providerSnapshot, dispatchedCommands) {
  if (event?.component !== "vehicleTool" || event.phase !== "vehicle-execution") {
    return noVehicleProjection("not-a-vehicle-event");
  }

  const vehicle = event.metadata?.vehicle;
  const toolCall = vehicle?.toolCall;
  if (event.status === "processing"
    && vehicle?.commitmentState === "dispatching"
    && validCommandIdentity(toolCall, event.runId)) {
    rememberBounded(
      dispatchedCommands,
      toolCall.commandId,
      toolCall,
      MAX_PENDING_VEHICLE_COMMANDS,
    );
    return {
      outcome: Object.freeze({ authorized: true, reason: "canonical-dispatch-event" }),
      notify: Object.freeze({
        authorization: "pending",
        authorized: true,
        event,
        toolCall,
      }),
      terminalFact: null,
    };
  }

  const toolResult = vehicle?.toolResult;
  const dispatched = toolResult?.commandId ? dispatchedCommands.get(toolResult.commandId) : null;
  const identityMatches = validTerminalIdentity(toolResult, dispatched, event.runId);
  const cancellation = vehicle?.cancellation ?? null;
  const terminalContract = inspectVehicleTerminalContract({
    toolResult,
    commitmentState: vehicle?.commitmentState,
    cancellation,
  });
  const expectedRequestedState = expectedVehicleRequestedState(dispatched);
  const providerProof = inspectObservedSuccessProviderProof({
    toolResult,
    vehicleStateSnapshot: providerSnapshot,
    expectedRequestedState,
  });
  const isObservedConflict = toolResult?.executionState === "failed"
    && toolResult?.executionError?.code === "sensor-observation-conflict";
  const conflictProof = inspectObservedConflictProviderProof({
    toolResult,
    vehicleStateSnapshot: providerSnapshot,
    expectedRequestedState,
  });
  const conflictSnapshotMatchesEvent = providerSnapshotMatchesEventProjection(
    providerSnapshot,
    vehicle?.snapshot,
  );
  const actualStateReconciled = isObservedConflict
    && conflictProof.ok
    && conflictSnapshotMatchesEvent;
  const providerProofRequired = toolResult?.executionState === "observed-succeeded"
    || isObservedConflict;
  const providerMatches = !providerProofRequired
    || providerProof.ok
    || actualStateReconciled;
  const terminalStatusMatches = expectedTerminalEventStatus(toolResult?.executionState) === event.status;
  const terminalAccepted = identityMatches
    && terminalContract.ok
    && providerMatches
    && terminalStatusMatches;
  if (terminalAccepted) dispatchedCommands.delete(toolResult.commandId);
  const confirmed = terminalAccepted
    && event.status === "completed"
    && vehicle?.commitmentState === "provider-terminal"
    && cancellation?.physicalUndoClaimed !== true;
  const reason = !identityMatches
    ? "vehicle-command-identity-mismatch"
    : !terminalContract.ok || !terminalStatusMatches
      ? "vehicle-terminal-contract-invalid"
      : !providerMatches
      ? "provider-snapshot-mismatch"
      : actualStateReconciled ? "provider-observed-conflict"
      : !confirmed ? "vehicle-terminal-not-confirmed" : "provider-confirmed-terminal";
  const terminalFact = terminalAccepted
    ? Object.freeze({
      event,
      toolResult,
      providerSnapshot: confirmed || actualStateReconciled ? providerSnapshot : null,
      commitmentState: vehicle?.commitmentState ?? null,
      cancellation,
      confirmed,
      reason,
    })
    : null;
  return {
    outcome: Object.freeze({ authorized: confirmed, reason }),
    notify: terminalFact
      ? Object.freeze({
        authorization: confirmed ? "confirmed" : actualStateReconciled ? "actual-state" : "terminal",
        authorized: confirmed,
        event,
        toolResult,
        providerSnapshot: terminalFact.providerSnapshot,
        commitmentState: terminalFact.commitmentState,
        cancellation,
      })
      : null,
    terminalFact,
  };
}

function providerSnapshotMatchesEventProjection(providerSnapshot, eventSnapshot) {
  return Boolean(providerSnapshot
    && eventSnapshot
    && providerSnapshot.id === eventSnapshot.id
    && providerSnapshot.source === eventSnapshot.source
    && providerSnapshot.simulated === eventSnapshot.simulated
    && providerSnapshot.capturedAt === eventSnapshot.capturedAt);
}

function expectedTerminalEventStatus(executionState) {
  if (executionState === "observed-succeeded") return "completed";
  if (executionState === "timeout") return "uncertain";
  if (["failed", "duplicate-command"].includes(executionState)) return "failed";
  return null;
}

function validCommandIdentity(command, runId) {
  if (!command
    || command.requestId !== runId
    || typeof command.commandId !== "string"
    || typeof command.tool !== "string"
    || command.tool.length === 0) return false;
  const prefix = `${runId}:`;
  const suffix = `:${command.tool}`;
  if (!command.commandId.startsWith(prefix) || !command.commandId.endsWith(suffix)) return false;
  return /^[1-9]\d*$/.test(command.commandId.slice(prefix.length, -suffix.length));
}

function isVehicleTerminalEvent(event) {
  return event?.component === "vehicleTool"
    && event.phase === "vehicle-execution"
    && ["completed", "cancelled", "failed", "uncertain"].includes(event.status)
    && event.metadata?.vehicle?.toolResult;
}

function validTerminalIdentity(result, command, runId) {
  return Boolean(result && command
    && result.requestId === runId
    && result.requestId === command.requestId
    && result.commandId === command.commandId
    && result.tool === command.tool);
}

function modeForEvent(event, vehicle) {
  if (["cancelled", "safety_rejected", "unavailable", "failed", "uncertain"].includes(event.status)) {
    return "blocked";
  }
  if (vehicle.outcome.reason === "canonical-dispatch-event") return "pending";
  if (event.component === "safety") return "safety";
  if (event.phase === "final-response" && event.status === "completed") return "completed";
  if (event.component === "cabinAssistant" && event.phase === "intake") return "listening";
  return "planning";
}

function modeForResult(result) {
  if (result.safetyDecision?.allowed === false
    || result.taskStatus === "failed"
    || result.taskStatus === "cancelled") return "blocked";
  return "completed";
}

function noVehicleProjection(reason) {
  return {
    outcome: Object.freeze({ authorized: false, reason }),
    notify: null,
    terminalFact: null,
  };
}

function retainTerminalFact(registry, fact) {
  if (!fact) return;
  rememberBounded(
    registry,
    fact.toolResult.commandId,
    fact,
    MAX_TERMINAL_FACTS,
  );
}

function rememberBounded(registry, key, valueOrLimit, maybeLimit) {
  const hasValue = maybeLimit !== undefined;
  const value = hasValue ? valueOrLimit : true;
  const limit = hasValue ? maybeLimit : valueOrLimit;
  if (registry.has(key)) registry.delete(key);
  if (registry instanceof Set) registry.add(key);
  else registry.set(key, value);
  while (registry.size > limit) registry.delete(registry.keys().next().value);
}

function frozenOutcome(accepted, mode, vehicle) {
  return Object.freeze({ accepted, mode, vehicle: Object.freeze(vehicle) });
}
