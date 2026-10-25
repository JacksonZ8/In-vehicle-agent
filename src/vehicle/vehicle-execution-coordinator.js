import { createVehicleToolResult } from "../runtime/agent-schemas.js";
import { throwIfAborted } from "../runtime/abort-utils.js";
import {
  createVehicleExecution,
  isTerminalExecutionState,
  transitionVehicleExecution,
} from "./execution-state-contract.js";
import {
  expectedVehicleRequestedState,
  sameVehicleStructuredFact,
} from "./vehicle-command-contract.js";
import { VEHICLE_COMPONENT_BY_TOOL as COMPONENT_BY_TOOL } from "./vehicle-write-capabilities.js";

const COORDINATOR_SOURCE = "vehicle-execution-coordinator";


function defaultTimeoutScheduler(callback, delayMs) {
  return setTimeout(callback, delayMs);
}

function requireMethod(value, method, name) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`${name}.${method} is required`);
  }
}

function timestamp(now) {
  return new Date(now()).toISOString();
}

function matchesToolCallIdentity(left, right) {
  return left?.requestId === right?.requestId
    && left?.commandId === right?.commandId
    && left?.tool === right?.tool;
}

function traceTransitionOptions(traceItem, error) {
  const {
    state: _state,
    source,
    at,
    ...traceData
  } = traceItem;
  return {
    source,
    at,
    ...(Object.keys(traceData).length ? { traceData } : {}),
    ...(error ? { error } : {}),
  };
}

function rebuildBeginExecution(beginResult, beginError) {
  const [submitted, ...transitions] = beginResult.executionTrace;
  let execution = createVehicleExecution({
    requestId: beginResult.requestId,
    commandId: beginResult.commandId,
    tool: beginResult.tool,
    requestedState: beginResult.requestedState,
    source: submitted.source,
    at: submitted.at,
  });

  for (const traceItem of transitions) {
    execution = transitionVehicleExecution(
      execution,
      traceItem.state,
      traceTransitionOptions(
        traceItem,
        ["failed", "timeout"].includes(traceItem.state) ? beginError : undefined,
      ),
    );
  }
  return execution;
}

function notifyDispatchObserver(observer, toolCall) {
  if (!observer) return;
  try {
    Promise.resolve(observer(toolCall)).catch(() => {});
  } catch {
    // Observability must never control physical dispatch.
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function valuesCoverRequestedState(values, requestedState) {
  return isRecord(values) && isRecord(requestedState)
    && Object.keys(requestedState).every((field) => Object.hasOwn(values, field));
}

function valuesMatchRequestedState(values, requestedState) {
  if (!valuesCoverRequestedState(values, requestedState)) return false;
  return Object.entries(requestedState).every(
    ([field, requestedValue]) => field === "componentActionStateById"
      ? coversStructuredFact(values[field], requestedValue)
      : deepEqual(values[field], requestedValue),
  );
}

function valuesExactlyMatchRequestedState(values, requestedState) {
  if (!valuesCoverRequestedState(values, requestedState)) return false;
  return Object.entries(requestedState).every(
    ([field, requestedValue]) => deepEqual(values[field], requestedValue),
  );
}

function coversStructuredFact(observed, requested) {
  if (Object.is(observed, requested)) return true;
  if (!isRecord(observed) || !isRecord(requested)) return false;
  return Object.entries(requested).every(
    ([key, requestedValue]) => Object.hasOwn(observed, key)
      && coversStructuredFact(observed[key], requestedValue),
  );
}

function validObservationTime(observation, executingAtMs, deadlineAtMs) {
  const capturedAtMs = typeof observation?.capturedAt === "string"
    ? Date.parse(observation.capturedAt)
    : NaN;
  return Number.isFinite(capturedAtMs)
    && capturedAtMs >= executingAtMs
    && capturedAtMs <= deadlineAtMs;
}

function inspectSnapshot(snapshot) {
  try {
    if (!isRecord(snapshot)) return { ok: false, reason: "snapshot must be a record" };
    const id = snapshot.id;
    const values = snapshot.values;
    if (typeof id !== "string" || !id.trim()) {
      return { ok: false, reason: "snapshot id must be a non-empty string" };
    }
    if (!isRecord(values)) return { ok: false, reason: "snapshot values must be a record" };
    return { ok: true, snapshot, id, values };
  } catch {
    return { ok: false, reason: "snapshot properties are unreadable" };
  }
}

function inspectIngestion(ingestion) {
  try {
    if (!isRecord(ingestion)) return { kind: "invalid", reason: "ingestion must be a record" };
    const ok = ingestion.ok;
    if (typeof ok !== "boolean") return { kind: "invalid", reason: "ingestion ok must be boolean" };
    if (!ok) {
      let reason = "Provider 未提供拒绝原因";
      try {
        if (typeof ingestion.reason === "string" && ingestion.reason.trim()) {
          reason = ingestion.reason.trim();
        }
      } catch {
        // Keep the safe fallback instead of reading a hostile reason again.
      }
      return { kind: "rejected", reason };
    }
    const inspectedSnapshot = inspectSnapshot(ingestion.snapshot);
    if (!inspectedSnapshot.ok) {
      return { kind: "invalid", reason: inspectedSnapshot.reason };
    }
    return { kind: "accepted", ...inspectedSnapshot };
  } catch {
    return { kind: "invalid", reason: "ingestion properties are unreadable" };
  }
}

function readCurrentSnapshot(vehicleStateProvider) {
  try {
    const snapshot = vehicleStateProvider.getSnapshot();
    const inspectedSnapshot = inspectSnapshot(snapshot);
    return inspectedSnapshot.ok
      ? inspectedSnapshot
      : { ok: false, snapshot, reason: inspectedSnapshot.reason };
  } catch {
    return { ok: false, snapshot: undefined, reason: "Provider current snapshot is unreadable" };
  }
}

function classifySensorResult(result, commandId, component) {
  if (!isRecord(result) || !Object.hasOwn(result, "type")) return { kind: "observation" };
  if (!["no-update", "timeout"].includes(result.type)) return { kind: "invalid-marker" };
  const keys = Object.keys(result).sort();
  const validKeys = ["commandId", "component", "type"];
  if (keys.length !== validKeys.length || keys.some((key, index) => key !== validKeys[index])
    || result.commandId !== commandId || result.component !== component) {
    return { kind: "invalid-marker" };
  }
  return { kind: "marker", type: result.type };
}

function cancelScheduledTimeout(handle) {
  if (typeof handle === "function") {
    handle();
  } else if (handle && typeof handle.cancel === "function") {
    handle.cancel();
  } else if (handle !== undefined) {
    clearTimeout(handle);
  }
}

async function raceSensorWithDeadline({
  submitSensor,
  timeoutScheduler,
  confirmationTimeoutMs,
  commandId,
  component,
}) {
  const sensorPromise = Promise.resolve()
    .then(submitSensor)
    .then(
      (value) => ({ kind: "sensor", value }),
      (cause) => ({ kind: "sensor-error", cause }),
    );
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = timeoutScheduler(
      () => resolve({ kind: "deadline" }),
      confirmationTimeoutMs,
    );
  });
  const winner = await Promise.race([sensorPromise, timeoutPromise]);
  const classification = winner.kind === "sensor"
    ? classifySensorResult(winner.value, commandId, component)
    : null;
  if (classification?.kind === "marker" && classification.type === "no-update") {
    await timeoutPromise;
    return { kind: "no-update-deadline", value: winner.value };
  }
  if (winner.kind !== "deadline") cancelScheduledTimeout(timeoutHandle);
  return winner;
}

function error(code, message, stage, retryable) {
  return { code, message, stage, retryable };
}

function beginExecutionError(beginResult) {
  if (beginResult.executionState === "duplicate-command") {
    return error(
      "duplicate-command",
      "车辆动作请求已处理，请勿重复提交。",
      "adapter-begin",
      false,
    );
  }
  if (beginResult.executionState === "failed") {
    return error(
      "adapter-begin-failed",
      "Adapter 未接受车辆动作。",
      "adapter-begin",
      beginResult.executionError?.retryable === true,
    );
  }
  return beginResult.executionError;
}

function adapterDispatchFailure(toolCall, cause, at, { invalidResult = false } = {}) {
  const executionError = error(
    invalidResult ? "adapter-dispatch-invalid-result" : "adapter-dispatch-rejected",
    invalidResult
      ? "Adapter 返回了无效的派发结果。"
      : "Adapter 无法派发车辆动作。",
    "adapter-dispatch",
    false,
  );
  const execution = transitionVehicleExecution(createVehicleExecution({
    requestId: toolCall.requestId,
    commandId: toolCall.commandId,
    tool: toolCall.tool,
    requestedState: expectedVehicleRequestedState(toolCall),
    source: COORDINATOR_SOURCE,
    at,
  }), "failed", {
    source: COORDINATOR_SOURCE,
    at,
    error: executionError,
  });
  return {
    beginResult: {
      hmiSummary: executionError.message,
      visualScenario: "none",
      source: COORDINATOR_SOURCE,
      simulated: false,
    },
    execution,
    executionError,
  };
}

export class VehicleExecutionCoordinator {
  constructor({
    vehicleTools,
    sensorSimulator,
    vehicleStateProvider,
    now = () => Date.now(),
    confirmationTimeoutMs = 1_000,
    timeoutScheduler = defaultTimeoutScheduler,
  } = {}) {
    requireMethod(vehicleTools, "execute", "vehicleTools");
    requireMethod(sensorSimulator, "submit", "sensorSimulator");
    requireMethod(vehicleStateProvider, "ingestObservation", "vehicleStateProvider");
    requireMethod(vehicleStateProvider, "getSnapshot", "vehicleStateProvider");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    if (typeof timeoutScheduler !== "function") throw new TypeError("timeoutScheduler must be a function");
    if (!Number.isFinite(confirmationTimeoutMs) || confirmationTimeoutMs <= 0) {
      throw new TypeError("confirmationTimeoutMs must be a positive finite number");
    }
    this.vehicleTools = vehicleTools;
    this.sensorSimulator = sensorSimulator;
    this.vehicleStateProvider = vehicleStateProvider;
    this.now = now;
    this.confirmationTimeoutMs = confirmationTimeoutMs;
    this.timeoutScheduler = timeoutScheduler;
  }

  async execute(toolCall, {
    signal,
    sensorMode = "success",
    latencyMs,
    onDispatchStarted,
  } = {}) {
    let commitmentState = "pre-dispatch";
    let cancellationRequested = signal?.aborted === true;
    const recordCancellation = () => {
      cancellationRequested = true;
    };
    signal?.addEventListener("abort", recordCancellation, { once: true });
    const buildResult = (
      beginResult,
      execution,
      executionError,
      confirmedSnapshotId,
      snapshotResolution,
    ) => this.result(
      beginResult,
      execution,
      executionError,
      confirmedSnapshotId,
      snapshotResolution,
      {
        commitmentState,
        cancellation: {
          requested: cancellationRequested,
          physicalUndoClaimed: false,
        },
      },
    );
    const buildProviderTerminalResult = (...args) => {
      commitmentState = "provider-terminal";
      return buildResult(...args);
    };

    try {
      throwIfAborted(signal);
      if (onDispatchStarted !== undefined && typeof onDispatchStarted !== "function") {
        throw new TypeError("onDispatchStarted must be a function");
      }
      commitmentState = "dispatching";
      let beginResult;
      let initialError;
      let execution;
      let adapterSettled = false;
      let adapterOutcome;
      let synchronousAdapterError;
      try {
        try {
          adapterOutcome = this.vehicleTools.execute(toolCall);
        } catch (cause) {
          synchronousAdapterError = cause;
        }
        notifyDispatchObserver(onDispatchStarted, toolCall);
        if (synchronousAdapterError) throw synchronousAdapterError;
        beginResult = await adapterOutcome;
        adapterSettled = true;
        if (!matchesToolCallIdentity(beginResult, toolCall)) {
          throw new TypeError("Adapter returned tool call identity mismatch");
        }
        const expectedRequestedState = expectedVehicleRequestedState(toolCall);
        if (expectedRequestedState
          && !sameVehicleStructuredFact(beginResult?.requestedState, expectedRequestedState)) {
          throw new TypeError("Adapter requestedState does not match canonical ToolCall target");
        }
        initialError = beginExecutionError(beginResult);
        execution = rebuildBeginExecution(beginResult, initialError);
      } catch (cause) {
        const rejected = adapterDispatchFailure(
          toolCall,
          cause,
          timestamp(this.now),
          { invalidResult: adapterSettled },
        );
        return buildResult(
          rejected.beginResult,
          rejected.execution,
          rejected.executionError,
          undefined,
          { ok: false, snapshot: null },
        );
      }

      if (isTerminalExecutionState(execution.executionState)) {
        return buildResult(beginResult, execution, initialError);
      }
      commitmentState = "adapter-accepted";

      const component = COMPONENT_BY_TOOL[execution.tool];
      const executingAt = timestamp(this.now);
      const executingAtMs = Date.parse(executingAt);
      const deadlineAtMs = executingAtMs + this.confirmationTimeoutMs;
      execution = transitionVehicleExecution(execution, "executing", {
        source: COORDINATOR_SOURCE,
        at: executingAt,
        traceData: { component },
      });

      let sensorResult;
      try {
        const winner = await raceSensorWithDeadline({
          submitSensor: () => this.sensorSimulator.submit({
            commandId: execution.commandId,
            component,
            requestedState: execution.requestedState,
            mode: sensorMode,
            latencyMs,
          }),
          timeoutScheduler: this.timeoutScheduler,
          confirmationTimeoutMs: this.confirmationTimeoutMs,
          commandId: execution.commandId,
          component,
        });
        if (winner.kind === "sensor-error") throw winner.cause;
        sensorResult = winner.kind === "deadline"
          ? { type: "timeout", commandId: execution.commandId, component }
          : winner.value;
      } catch (cause) {
        const executionError = error(
          "sensor-observation-invalid",
          "传感器观测不可用。",
          "sensor-observation",
          false,
        );
        execution = transitionVehicleExecution(execution, "failed", {
          source: COORDINATOR_SOURCE,
          at: timestamp(this.now),
          traceData: { component },
          error: executionError,
        });
        return buildProviderTerminalResult(beginResult, execution, executionError);
      }

      const classifiedResult = classifySensorResult(sensorResult, execution.commandId, component);
      if (classifiedResult.kind === "invalid-marker") {
        const executionError = error(
          "sensor-observation-invalid",
          `commandId ${execution.commandId} 的传感器 marker 无效`,
          "sensor-observation",
          false,
        );
        execution = transitionVehicleExecution(execution, "failed", {
          source: COORDINATOR_SOURCE,
          at: timestamp(this.now),
          traceData: { component },
          error: executionError,
        });
        return buildProviderTerminalResult(beginResult, execution, executionError);
      }

      if (classifiedResult.type === "no-update") {
        const executionError = error(
          "sensor-no-update",
          `commandId ${execution.commandId} 未产生传感器更新`,
          "sensor-confirmation",
          true,
        );
        execution = transitionVehicleExecution(execution, "timeout", {
          source: COORDINATOR_SOURCE,
          at: timestamp(this.now),
          traceData: { component },
          error: executionError,
        });
        return buildProviderTerminalResult(beginResult, execution, executionError);
      }

      if (classifiedResult.type === "timeout") {
        const executionError = error(
          "sensor-timeout",
          `commandId ${execution.commandId} 传感器确认超时`,
          "sensor-confirmation",
          true,
        );
        execution = transitionVehicleExecution(execution, "timeout", {
          source: COORDINATOR_SOURCE,
          at: timestamp(this.now),
          traceData: { component },
          error: executionError,
        });
        return buildProviderTerminalResult(beginResult, execution, executionError);
      }

      if (!validObservationTime(sensorResult, executingAtMs, deadlineAtMs)) {
        const executionError = error(
          "sensor-observation-invalid",
          `commandId ${execution.commandId} 的传感器观测时间不在确认窗口内`,
          "sensor-observation",
          false,
        );
        execution = transitionVehicleExecution(execution, "failed", {
          source: COORDINATOR_SOURCE,
          at: timestamp(this.now),
          traceData: { component },
          error: executionError,
        });
        return buildProviderTerminalResult(beginResult, execution, executionError);
      }

      if (!valuesCoverRequestedState(sensorResult?.values, execution.requestedState)) {
        const executionError = error(
          "sensor-observation-invalid",
          `commandId ${execution.commandId} 的传感器观测未覆盖全部请求字段`,
          "sensor-observation",
          false,
        );
        execution = transitionVehicleExecution(execution, "failed", {
          source: COORDINATOR_SOURCE,
          at: timestamp(this.now),
          traceData: { component },
          error: executionError,
        });
        return buildProviderTerminalResult(beginResult, execution, executionError);
      }

      let ingestion;
      try {
        ingestion = this.vehicleStateProvider.ingestObservation(sensorResult, { execution });
      } catch (cause) {
        const executionError = error(
          "sensor-observation-invalid",
          "Provider 无法摄入传感器观测。",
          "sensor-observation",
          false,
        );
        execution = transitionVehicleExecution(execution, "failed", {
          source: COORDINATOR_SOURCE,
          at: timestamp(this.now),
          traceData: { component },
          error: executionError,
        });
        return buildProviderTerminalResult(beginResult, execution, executionError);
      }
      const inspectedIngestion = inspectIngestion(ingestion);
      if (inspectedIngestion.kind !== "accepted") {
        const executionError = error(
          "sensor-observation-invalid",
          "Provider 拒绝或无法确认传感器观测。",
          "sensor-observation",
          false,
        );
        execution = transitionVehicleExecution(execution, "failed", {
          source: COORDINATOR_SOURCE,
          at: timestamp(this.now),
          traceData: { component },
          error: executionError,
        });
        return buildProviderTerminalResult(beginResult, execution, executionError);
      }

      const currentSnapshot = readCurrentSnapshot(this.vehicleStateProvider);
      if (!currentSnapshot.ok
        || currentSnapshot.id !== inspectedIngestion.id
        || !deepEqual(currentSnapshot.values, inspectedIngestion.values)) {
        const executionError = error(
          "sensor-observation-invalid",
          "Provider 当前车辆事实无效。",
          "sensor-observation",
          false,
        );
        execution = transitionVehicleExecution(execution, "failed", {
          source: COORDINATOR_SOURCE,
          at: timestamp(this.now),
          traceData: { component },
          error: executionError,
        });
        return buildProviderTerminalResult(
          beginResult,
          execution,
          executionError,
          undefined,
          currentSnapshot,
        );
      }

      if (!valuesExactlyMatchRequestedState(sensorResult.values, execution.requestedState)
        || !valuesMatchRequestedState(inspectedIngestion.values, execution.requestedState)
        || !valuesMatchRequestedState(currentSnapshot.values, execution.requestedState)) {
        const executionError = error(
          "sensor-observation-conflict",
          `commandId ${execution.commandId} 的传感器事实与请求目标不一致`,
          "sensor-confirmation",
          false,
        );
        execution = transitionVehicleExecution(execution, "failed", {
          source: COORDINATOR_SOURCE,
          at: timestamp(this.now),
          traceData: { component },
          error: executionError,
        });
        return buildProviderTerminalResult(
          beginResult,
          execution,
          executionError,
          undefined,
          currentSnapshot,
        );
      }

      execution = transitionVehicleExecution(execution, "observed-succeeded", {
        source: COORDINATOR_SOURCE,
        at: timestamp(this.now),
        traceData: { component, confirmedSnapshotId: inspectedIngestion.id },
      });
      return buildProviderTerminalResult(
        beginResult,
        execution,
        undefined,
        inspectedIngestion.id,
        currentSnapshot,
      );
    } finally {
      signal?.removeEventListener("abort", recordCancellation);
    }
  }

  result(
    beginResult,
    execution,
    executionError,
    confirmedSnapshotId,
    snapshotResolution = readCurrentSnapshot(this.vehicleStateProvider),
    commitmentFacts,
  ) {
    return {
      ...commitmentFacts,
      toolResult: createVehicleToolResult({
        requestId: execution.requestId,
        commandId: execution.commandId,
        tool: execution.tool,
        ok: execution.executionState === "observed-succeeded",
        executionState: execution.executionState,
        requestedState: execution.requestedState,
        ...(confirmedSnapshotId ? { confirmedSnapshotId } : {}),
        executionTrace: execution.executionTrace,
        ...(executionError ? { executionError } : {}),
        hmiSummary: executionError?.message || beginResult.hmiSummary,
        visualScenario: executionError ? "none" : beginResult.visualScenario,
        source: beginResult.source,
        simulated: beginResult.simulated,
        timestamp: timestamp(this.now),
      }),
      vehicleStateSnapshot: snapshotResolution.ok ? snapshotResolution.snapshot : null,
    };
  }
}
