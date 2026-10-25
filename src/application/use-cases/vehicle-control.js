import {
  createToolCall,
  createVehicleToolResult,
} from "../../runtime/agent-schemas.js";
import {
  createActionDigest,
  createResponseToken,
  createTrustedConfirmationAssertions,
  resolveConfirmationAssertions,
} from "../../safety/confirmation-challenge.js";
import {
  expectedVehicleRequestedState,
  sameVehicleStructuredFact,
} from "../../vehicle/vehicle-command-contract.js";

const CONFIRMATION_TTL_MS = 120_000;
const BOUNDARY_SOURCE = "lean-vehicle-control-boundary";

export function createVehicleControlUseCase(dependencies = {}) {
  const {
    refreshVehicleStateForSafety,
    vehicleStateProvider,
    safetyGateway,
    vehicleExecutionCoordinator,
    now = Date.now,
    voiceIdentityProofVerifier,
  } = dependencies;
  requireMethod(refreshVehicleStateForSafety, null, "refreshVehicleStateForSafety");
  requireMethod(vehicleStateProvider, "getSnapshot", "vehicleStateProvider");
  requireMethod(safetyGateway, "evaluate", "safetyGateway");
  requireMethod(vehicleExecutionCoordinator, "execute", "vehicleExecutionCoordinator");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  if (voiceIdentityProofVerifier !== undefined
    && typeof voiceIdentityProofVerifier !== "function") {
    throw new TypeError("voiceIdentityProofVerifier must be a function");
  }

  const confirmationChallenges = new Map();
  const issuedSafetyDecisions = new WeakSet();
  const evaluateSafety = async (parsedCommand, input) => {
    const decision = await safetyGateway.evaluate(parsedCommand, input);
    if (!decision || typeof decision !== "object") {
      throw new TypeError("safetyGateway.evaluate() must return a decision object");
    }
    issuedSafetyDecisions.add(decision);
    return decision;
  };

  const executeAuthorizedVehicleCommand = async (context = {}) => {
    context.throwIfAborted();
    assertAuthorizedToolCall(context, issuedSafetyDecisions);
    let executionEnvelope;
    let dispatchStarted = false;
    try {
      executionEnvelope = await vehicleExecutionCoordinator.execute(context.toolCall, {
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        sensorMode: context.vehicleSensorMode,
        latencyMs: context.vehicleSensorLatencyMs,
        onDispatchStarted: () => {
          const event = context.emit({
            component: "vehicleTool",
            phase: "vehicle-execution",
            status: "processing",
            summary: "车辆动作已派发，等待 Provider 传感器确认。",
            refs: [context.toolCall.commandId],
            metadata: {
              vehicle: {
              toolCall: projectVehicleToolCall(context.toolCall),
              commitmentState: "dispatching",
              },
            },
          });
          dispatchStarted = true;
          return event;
        },
      });
    } catch {
      if (!dispatchStarted) context.throwIfAborted();
      executionEnvelope = null;
    }
    if (!dispatchStarted) context.throwIfAborted();

    const inspected = inspectCoordinatorEnvelope({
      envelope: executionEnvelope,
      toolCall: context.toolCall,
      vehicleStateProvider,
      now,
      dispatchStarted,
      cancellationRequested: context.signal?.aborted === true,
    });
    const { toolResult, vehicleStateSnapshot } = inspected;
    const providerObservedConflict = toolResult.executionState === "failed"
      && toolResult.executionError?.code === "sensor-observation-conflict";
    context.emit({
      component: "vehicleTool",
      phase: "vehicle-execution",
      status: vehicleToolTerminalStatus(toolResult),
      summary: responseForToolResult(toolResult),
      refs: [
        toolResult.commandId,
        ...(toolResult.confirmedSnapshotId ? [toolResult.confirmedSnapshotId] : []),
        ...(providerObservedConflict ? [vehicleStateSnapshot.id] : []),
      ],
      metadata: {
        ...(toolResult.executionError?.code ? { reasonCode: toolResult.executionError.code } : {}),
        simulated: toolResult.simulated === true,
        vehicle: {
        toolResult: projectVehicleToolResult(toolResult),
        commitmentState: inspected.commitmentState,
        cancellation: inspected.cancellation,
        ...(providerObservedConflict ? { snapshot: projectVehicleSnapshot(vehicleStateSnapshot) } : {}),
        },
      },
    });
    if (toolResult.executionState === "observed-succeeded" || providerObservedConflict) {
      context.emit({
        component: "vehicleStateProvider",
        phase: "vehicle-execution",
        status: "completed",
        summary: providerObservedConflict
          ? "Provider 已记录与请求目标不一致的车辆实际状态。"
          : "Provider 已确认车辆动作的最终传感器状态。",
        refs: [vehicleStateSnapshot.id, toolResult.commandId],
        metadata: {
          ...(providerObservedConflict ? { reasonCode: "sensor-observation-conflict" } : {}),
          simulated: vehicleStateSnapshot.simulated === true,
          vehicle: {
          snapshot: projectVehicleSnapshot(vehicleStateSnapshot),
          ...(toolResult.confirmedSnapshotId
            ? { confirmedSnapshotId: toolResult.confirmedSnapshotId }
            : {}),
          },
        },
      });
    }
    return terminalFragment({
      assistantResponse: responseForToolResult(toolResult),
      safetyDecision: context.safetyDecision,
      toolCall: context.toolCall,
      toolResult,
      vehicleStateSnapshot,
      degraded: toolResult.executionState !== "observed-succeeded",
    });
  };

  const execute = async (context = {}) => {
    context.throwIfAborted();
    const refreshResult = await refreshVehicleStateForSafety({
      runId: context.runId,
      requestId: context.runId,
      parsedCommand: context.parsedCommand,
      signal: context.signal,
      deadlineAt: context.deadlineAt,
    });
    context.throwIfAborted();
    const vehicleStateSnapshot = vehicleStateProvider.getSnapshot();
    assertSameProviderSnapshot(refreshResult, vehicleStateSnapshot);
    context.emit({
      component: "vehicleStateProvider",
      phase: "vehicle-safety",
      status: "completed",
      summary: "Provider 已刷新并提供本轮 Safety 车辆状态。",
      refs: [vehicleStateSnapshot.id],
      metadata: {
        simulated: vehicleStateSnapshot.simulated === true,
        vehicle: { snapshot: projectVehicleSnapshot(vehicleStateSnapshot) },
      },
    });

    let safetyDecision = await evaluateSafety(context.parsedCommand, {
      vehicleStateSnapshot,
    });
    context.throwIfAborted();
    emitSafetyDecision(context, safetyDecision);

    if (context.confirmationResponse) {
      const validation = await validateConfirmationResponse({
        response: context.confirmationResponse,
        parsedCommand: context.parsedCommand,
        currentDecision: safetyDecision,
        confirmationChallenges,
        now,
        sessionId: context.interactionRef?.sessionId,
        voiceIdentityProofVerifier,
      });
      context.throwIfAborted();
      context.emit({
        component: "confirmation",
        phase: "vehicle-confirmation",
        status: validation.ok ? "completed" : "failed",
        summary: validation.ok ? "安全确认响应已校验。" : validation.reason,
        refs: [String(context.confirmationResponse.challengeId || "")],
        metadata: {
          ...(!validation.ok ? { reasonCode: "confirmation-invalid" } : {}),
          vehicle: { confirmation: {
          challengeId: String(context.confirmationResponse.challengeId || ""),
          valid: validation.ok,
          },
          },
        },
      });
      if (!validation.ok) {
        if (!["reject", "unavailable"].includes(safetyDecision.action)) {
          safetyDecision = confirmationRejection(
            safetyDecision,
            context.parsedCommand,
            validation.reason,
          );
        }
        return blockedFragment(safetyDecision, vehicleStateSnapshot);
      }
      safetyDecision = await evaluateSafety(context.parsedCommand, {
        vehicleStateSnapshot,
        trustedConfirmationAssertions: createTrustedConfirmationAssertions(validation.assertions),
      });
      context.throwIfAborted();
      emitSafetyDecision(context, safetyDecision);
      if (!safetyDecision.allowed) {
        return blockedFragment(safetyDecision, vehicleStateSnapshot);
      }
    } else if (safetyDecision.action === "require_confirmation") {
      const confirmationChallenge = await issueConfirmationChallenge({
        parsedCommand: context.parsedCommand,
        safetyDecision,
        continuationBinding: createConfirmationContinuationBinding(context),
        confirmationChallenges,
        now,
      });
      context.throwIfAborted();
      safetyDecision = deepFreeze({ ...safetyDecision, confirmationChallenge });
      context.emit({
        component: "confirmation",
        phase: "vehicle-confirmation",
        status: "awaiting_clarification",
        summary: "已发出 120 秒安全确认挑战，本轮未执行车辆动作。",
        refs: [confirmationChallenge.id, confirmationChallenge.policyId],
        metadata: {
          policyVersion: confirmationChallenge.policyVersion,
          vehicle: { confirmation: projectConfirmationChallenge(confirmationChallenge) },
        },
      });
      return terminalFragment({
        assistantResponse: "需要先完成安全确认才能执行，本次未调用车辆工具。",
        safetyDecision,
        toolCall: null,
        toolResult: null,
        vehicleStateSnapshot,
      });
    }

    if (!safetyDecision.allowed) return blockedFragment(safetyDecision, vehicleStateSnapshot);
    if (context.parsedCommand?.intent === "body.tailgate.open"
      && context.parsedCommand.slots?.open !== false
      && vehicleStateSnapshot?.values?.tailgateOpen === true) {
      return terminalFragment({
        assistantResponse: "尾门已经开着，无需重复派发，也不会创建自动关闭任务。",
        safetyDecision,
        vehicleStateSnapshot,
      });
    }
    context.throwIfAborted();
    const toolCall = createToolCall(
      context.runId,
      safetyDecision.safeIntent,
      safetyDecision.safeSlots,
      true,
      safetyDecision.slotProvenance,
      { sequence: 1 },
    );
    return executeAuthorizedVehicleCommand({ ...context, toolCall, safetyDecision });
  };

  const resolveConfirmationContinuation = (input = {}) => {
    pruneConfirmationChallenges(confirmationChallenges, now());
    const challengeId = String(input.confirmationResponse?.challengeId || "");
    const record = confirmationChallenges.get(challengeId);
    if (!record) {
      return continuationFailure();
    }
    if (!record.continuationBinding) {
      return continuationFailure("not-applicable");
    }
    if (input.confirmationResponse?.requestId !== record.challenge.requestId) {
      return continuationFailure();
    }
    if (String(input.rawText || "").trim() !== record.continuationBinding.rawText) {
      return continuationFailure();
    }
    return deepFreeze({
      status: "resolved",
      reasonCode: "confirmation-continuation-resolved",
      binding: record.continuationBinding,
    });
  };

  return Object.freeze({
    execute,
    executeAuthorizedVehicleCommand,
    resolveConfirmationContinuation,
  });
}

function requireMethod(value, method, name) {
  if (method === null ? typeof value !== "function" : typeof value?.[method] !== "function") {
    throw new TypeError(method === null ? `${name} must be a function` : `${name}.${method} is required`);
  }
}

function assertSameProviderSnapshot(refreshResult, providerSnapshot) {
  if (!refreshResult?.ok
    || refreshResult.snapshot !== providerSnapshot
    || refreshResult.snapshot?.id !== providerSnapshot?.id) {
    throw new TypeError("Safety refresh must return the shared Provider snapshot");
  }
}

function emitSafetyDecision(context, decision) {
  context.emit({
    component: "safety",
    phase: "vehicle-safety",
    status: safetyEventStatus(decision),
    summary: String(decision?.reason || "Safety Gateway 未给出可执行结论。"),
    refs: safetyRefs(decision),
    metadata: {
      ...(decision?.reasonCode ? { reasonCode: decision.reasonCode } : {}),
      ...(decision?.policyVersion
        ? { policyVersion: decision.policyVersion }
        : {}),
      vehicle: { safetyDecision: projectSafetyDecision(decision) },
    },
  });
}

function vehicleToolTerminalStatus(toolResult) {
  if (toolResult.executionState === "observed-succeeded") return "completed";
  if (toolResult.executionState === "timeout") return "uncertain";
  if (toolResult.executionState === "cancelled") return "cancelled";
  return "failed";
}

function safetyEventStatus(decision) {
  if (decision?.allowed === true || decision?.action === "require_confirmation") return "completed";
  if (decision?.action === "reject") return "safety_rejected";
  if (decision?.action === "unavailable") return "unavailable";
  return "failed";
}

function projectVehicleToolCall(toolCall) {
  return deepFreeze({
    requestId: toolCall.requestId,
    commandId: toolCall.commandId,
    tool: toolCall.tool,
    args: { ...(toolCall.args || {}) },
    argProvenance: { ...(toolCall.argProvenance || {}) },
    requiresSafety: toolCall.requiresSafety === true,
  });
}

function projectVehicleToolResult(toolResult) {
  const projected = {
    requestId: toolResult.requestId,
    commandId: toolResult.commandId,
    tool: toolResult.tool,
    ok: toolResult.ok === true,
    executionState: toolResult.executionState,
    requestedState: { ...(toolResult.requestedState || {}) },
    executionTrace: Array.isArray(toolResult.executionTrace)
      ? toolResult.executionTrace.map((entry) => ({
        state: entry.state,
        source: entry.source,
        at: entry.at,
      }))
      : [],
    simulated: toolResult.simulated === true,
  };
  if (typeof toolResult.visualScenario === "string") projected.visualScenario = toolResult.visualScenario;
  if (typeof toolResult.source === "string") projected.source = toolResult.source;
  if (typeof toolResult.timestamp === "string") projected.timestamp = toolResult.timestamp;
  if (toolResult.confirmedSnapshotId) projected.confirmedSnapshotId = toolResult.confirmedSnapshotId;
  if (toolResult.executionError) {
    projected.executionError = {
      code: toolResult.executionError.code,
      stage: toolResult.executionError.stage,
      retryable: toolResult.executionError.retryable === true,
    };
  }
  return deepFreeze(projected);
}

function projectVehicleSnapshot(snapshot) {
  const projected = {
    id: snapshot.id,
    simulated: snapshot.simulated === true,
  };
  if (typeof snapshot.source === "string") projected.source = snapshot.source;
  if (typeof snapshot.capturedAt === "string") projected.capturedAt = snapshot.capturedAt;
  return deepFreeze(projected);
}

function projectSafetyDecision(decision = {}) {
  return deepFreeze({
    requestId: String(decision.requestId || ""),
    allowed: decision.allowed === true,
    action: String(decision.action || "unavailable"),
    reasonCode: String(decision.reasonCode || "safety-contract-invalid"),
    safeIntent: String(decision.safeIntent || ""),
    snapshotId: String(decision.snapshotId || decision.vehicleStateSnapshotId || ""),
    policyId: String(decision.policyId || ""),
    version: String(decision.policyVersion || ""),
  });
}

function safetyRefs(decision = {}) {
  const refs = [
    decision.snapshotId,
    decision.vehicleStateSnapshotId,
    decision.policyId,
    decision.vehicleStateAudit?.freshness?.policy,
    ...(Array.isArray(decision.ruleIds) ? decision.ruleIds : []),
    decision.manualSafetyPolicy?.policyId,
    ...(Array.isArray(decision.vehicleStateAudit?.factRefs)
      ? decision.vehicleStateAudit.factRefs.map((ref) => ref?.id)
      : []),
  ].filter((value) => typeof value === "string" && value.trim());
  return [...new Set(refs)];
}

function projectConfirmationChallenge(challenge) {
  return deepFreeze({
    challengeId: challenge.id,
    actionDigest: challenge.actionDigest,
    policyId: challenge.policyId,
    policyVersion: challenge.policyVersion,
    assertions: challenge.assertions.map((assertion) => ({ id: assertion.id })),
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    valid: true,
  });
}

async function issueConfirmationChallenge({
  parsedCommand,
  safetyDecision,
  continuationBinding,
  confirmationChallenges,
  now,
}) {
  pruneConfirmationChallenges(confirmationChallenges, now());
  const policy = safetyDecision.manualSafetyPolicy || {};
  const issuedAtMs = now();
  const challenge = deepFreeze({
    id: `confirm-${createResponseToken().slice(0, 24)}`,
    requestId: parsedCommand.requestId,
    actionDigest: await createActionDigest(parsedCommand, policy),
    policyId: String(policy.policyId || ""),
    policyVersion: String(policy.version || ""),
    assertions: resolveConfirmationAssertions(policy, parsedCommand),
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + CONFIRMATION_TTL_MS).toISOString(),
    responseToken: createResponseToken(),
  });
  confirmationChallenges.set(challenge.id, {
    challenge,
    continuationBinding,
    consumed: false,
    validating: false,
  });
  return challenge;
}

function createConfirmationContinuationBinding(context) {
  const decision = context.routeDecision;
  const validation = context.routeValidation;
  if (decision?.disposition !== "execute"
    || decision.routeId !== "vehicle-control"
    || decision.mode !== "direct"
    || context.parsedCommand?.actionability?.actionable !== true
    || validation?.contractValidation?.ok !== true
    || validation?.capabilityValidation?.ok !== true
    || validation?.slotValidation?.ok !== true) {
    return null;
  }
  const rawText = String(context.rawText || "").trim();
  if (!rawText || context.parsedCommand?.requestId !== context.runId) {
    throw new TypeError("vehicle confirmation continuation requires the current direct route binding");
  }
  return deepFreeze({
    rawText,
    routeDecision: structuredClone(decision),
    parsedCommand: structuredClone(context.parsedCommand),
    routeValidation: structuredClone(validation),
  });
}

function continuationFailure(status = "invalid") {
  return deepFreeze({
    status,
    reasonCode: status === "not-applicable"
      ? "confirmation-continuation-not-applicable"
      : "confirmation-continuation-invalid",
    binding: null,
  });
}

async function validateConfirmationResponse({
  response,
  parsedCommand,
  currentDecision,
  confirmationChallenges,
  now,
  sessionId,
  voiceIdentityProofVerifier,
}) {
  const nowMs = now();
  const challengeId = String(response?.challengeId || "");
  const record = confirmationChallenges.get(challengeId);
  if (!record) return { ok: false, reason: "确认凭证不存在或已过期。" };
  const { challenge } = record;
  if (record.consumed) return { ok: false, reason: "确认凭证已使用，不能重复执行。" };
  if (record.validating) return { ok: false, reason: "确认凭证正在验证中，不能并发重复执行。" };
  if (nowMs >= Date.parse(challenge.expiresAt)) {
    confirmationChallenges.delete(challengeId);
    return { ok: false, reason: "确认凭证已过期。" };
  }
  if (response?.requestId !== challenge.requestId) {
    return { ok: false, reason: "确认凭证与发起请求不匹配。" };
  }
  if (response?.responseToken !== challenge.responseToken) {
    return { ok: false, reason: "确认响应 token 不匹配。" };
  }
  if (currentDecision?.action !== "require_confirmation") {
    return { ok: false, reason: "当前动作不需要此确认，拒绝跨动作使用。" };
  }
  const policy = currentDecision.manualSafetyPolicy || {};
  if (response?.policyId !== challenge.policyId
    || String(policy.policyId || "") !== challenge.policyId
    || String(policy.version || "") !== challenge.policyVersion) {
    return { ok: false, reason: "确认凭证与当前安全策略不匹配。" };
  }
  if (response?.actionDigest !== challenge.actionDigest) {
    return { ok: false, reason: "确认凭证与当前动作参数不匹配。" };
  }
  const acceptedAssertions = Array.isArray(response?.acceptedAssertions)
    ? response.acceptedAssertions
    : [];
  const requiredAssertions = challenge.assertions.map((assertion) => assertion.id);
  if (acceptedAssertions.length !== requiredAssertions.length
    || !requiredAssertions.every((id) => acceptedAssertions.includes(id))) {
    return { ok: false, reason: "确认断言不完整或无效。" };
  }
  const confirmationChannel = response?.confirmationChannel || "screen";
  if (!["screen", "voice"].includes(confirmationChannel)) {
    return { ok: false, reason: "确认通道无效。" };
  }
  if (confirmationChannel === "voice") {
    if (typeof voiceIdentityProofVerifier !== "function") {
      return { ok: false, reason: "语音确认不可用，请使用屏幕按钮。" };
    }
    const proof = await voiceIdentityProofVerifier({
      proofId: response?.voiceProofId,
      sessionId,
      challengeId,
      requestId: challenge.requestId,
      actionDigest: challenge.actionDigest,
      policyId: challenge.policyId,
    });
    if (proof?.ok !== true) return { ok: false, reason: "语音确认凭证无效或已过期。" };
  }
  record.validating = true;
  let actionDigest;
  try {
    actionDigest = await createActionDigest(
      { ...parsedCommand, requestId: challenge.requestId },
      policy,
    );
  } catch (error) {
    record.validating = false;
    throw error;
  }
  if (actionDigest !== challenge.actionDigest) {
    record.validating = false;
    return { ok: false, reason: "确认凭证与当前动作参数不匹配。" };
  }
  record.consumed = true;
  record.validating = false;
  return {
    ok: true,
    assertions: Object.fromEntries(requiredAssertions.map((id) => [id, true])),
  };
}

function pruneConfirmationChallenges(challenges, nowMs) {
  for (const [id, record] of challenges) {
    if (nowMs >= Date.parse(record.challenge.expiresAt)) challenges.delete(id);
  }
}

function confirmationRejection(baseDecision, parsedCommand, reason) {
  return deepFreeze({
    ...baseDecision,
    allowed: false,
    action: "reject",
    safeIntent: "safety.reject",
    safeSlots: {
      reason,
      alternative: "请重新发起车辆动作并完成新的安全确认。",
      originalIntent: parsedCommand.intent,
    },
    reason,
    alternative: "请重新发起车辆动作并完成新的安全确认。",
    confirmationChallenge: null,
  });
}

function blockedFragment(safetyDecision, vehicleStateSnapshot) {
  return terminalFragment({
    assistantResponse: `未执行车辆操作：${safetyDecision.reason || "Safety Gateway 已拦截。"} ${safetyDecision.alternative || ""}`.trim(),
    safetyDecision,
    toolCall: null,
    toolResult: null,
    vehicleStateSnapshot,
  });
}

function assertAuthorizedToolCall(context, issuedSafetyDecisions) {
  const { toolCall, safetyDecision } = context;
  if (!toolCall || !issuedSafetyDecisions.has(safetyDecision) || !safetyDecision?.allowed
    || !["allow", "clamp"].includes(safetyDecision.action)
    || safetyDecision.requestId !== context.runId
    || toolCall.requestId !== context.runId
    || !hasCanonicalCommandId(toolCall, context.runId)
    || toolCall.tool !== safetyDecision.safeIntent
    || toolCall.requiresSafety !== true
    || !sameVehicleStructuredFact(toolCall.args, safetyDecision.safeSlots)
    || !sameVehicleStructuredFact(
      toolCall.argProvenance,
      Object.fromEntries(Object.keys(safetyDecision.safeSlots || {}).map(
        (key) => [key, safetyDecision.slotProvenance?.[key] || "unknown"],
      )),
    )
    || !expectedVehicleRequestedState(toolCall)) {
    throw new TypeError("Vehicle ToolCall must match one Safety-allowed canonical command");
  }
}

function hasCanonicalCommandId(toolCall, runId) {
  const prefix = `${runId}:`;
  const suffix = `:${toolCall.tool}`;
  if (typeof toolCall.commandId !== "string"
    || !toolCall.commandId.startsWith(prefix)
    || !toolCall.commandId.endsWith(suffix)) return false;
  const sequenceText = toolCall.commandId.slice(prefix.length, -suffix.length);
  const sequence = Number(sequenceText);
  return String(sequence) === sequenceText && Number.isSafeInteger(sequence) && sequence > 0;
}

function inspectCoordinatorEnvelope({
  envelope,
  toolCall,
  vehicleStateProvider,
  now,
  dispatchStarted,
  cancellationRequested,
}) {
  let toolResult;
  let finalSnapshot;
  try {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new TypeError("Coordinator response must be an envelope");
    }
    toolResult = createVehicleToolResult(envelope.toolResult);
    const expectedRequestedState = expectedVehicleRequestedState(toolCall);
    finalSnapshot = vehicleStateProvider.getSnapshot();
    if (toolResult.requestId !== toolCall.requestId
      || toolResult.commandId !== toolCall.commandId
      || toolResult.tool !== toolCall.tool
      || !sameVehicleStructuredFact(toolResult.requestedState, expectedRequestedState)
      || envelope.vehicleStateSnapshot !== finalSnapshot
      || envelope.vehicleStateSnapshot?.id !== finalSnapshot?.id) {
      throw new TypeError("Coordinator envelope does not match the canonical ToolCall or shared Provider");
    }
    if (toolResult.executionState === "observed-succeeded"
      && (toolResult.ok !== true
        || toolResult.confirmedSnapshotId !== finalSnapshot.id
        || !snapshotConfirms(finalSnapshot, expectedRequestedState))) {
      throw new TypeError("Observed success is not confirmed by the shared Provider snapshot");
    }
    if (toolResult.executionState !== "observed-succeeded" && toolResult.ok === true) {
      throw new TypeError("Only Provider-observed success may complete a vehicle command");
    }
    return {
      toolResult,
      vehicleStateSnapshot: finalSnapshot,
      commitmentState: envelope.commitmentState,
      cancellation: cancellationFact(envelope, cancellationRequested),
    };
  } catch (cause) {
    finalSnapshot = readProviderSnapshot(vehicleStateProvider);
    return {
      toolResult: boundaryFailureToolResult(toolCall, now, cause),
      vehicleStateSnapshot: finalSnapshot,
      commitmentState: envelope?.commitmentState || (dispatchStarted ? "dispatching" : "pre-dispatch"),
      cancellation: cancellationFact(envelope, cancellationRequested),
    };
  }
}

function cancellationFact(envelope, cancellationRequested) {
  let coordinatorRequested = false;
  try {
    coordinatorRequested = envelope?.cancellation?.requested === true;
  } catch {
    // The local AbortSignal remains authoritative if a malformed envelope is unreadable.
  }
  return Object.freeze({
    requested: cancellationRequested === true || coordinatorRequested,
    physicalUndoClaimed: false,
  });
}

function boundaryFailureToolResult(toolCall, now, cause) {
  const timestamp = new Date(now()).toISOString();
  return createVehicleToolResult({
    requestId: toolCall.requestId,
    commandId: toolCall.commandId,
    tool: toolCall.tool,
    ok: false,
    executionState: "failed",
    requestedState: expectedVehicleRequestedState(toolCall),
    executionTrace: [
      { state: "submitted", source: BOUNDARY_SOURCE, at: timestamp },
      { state: "failed", source: BOUNDARY_SOURCE, at: timestamp },
    ],
    executionError: {
      code: "coordinator-boundary-invalid",
      message: "车辆执行协调结果无法验证。",
      stage: "coordinator-boundary",
      retryable: false,
    },
    hmiSummary: "车辆执行协调结果无法验证。",
    visualScenario: "blocked",
    source: BOUNDARY_SOURCE,
    simulated: false,
    timestamp,
  });
}

function readProviderSnapshot(vehicleStateProvider) {
  try {
    return vehicleStateProvider.getSnapshot();
  } catch {
    return null;
  }
}

function snapshotConfirms(snapshot, requestedState) {
  if (!snapshot?.values || !requestedState) return false;
  return Object.entries(requestedState).every(
    ([key, value]) => Object.hasOwn(snapshot.values, key)
      && (key === "componentActionStateById"
        ? coversStructuredFact(snapshot.values[key], value)
        : sameVehicleStructuredFact(snapshot.values[key], value)),
  );
}

function coversStructuredFact(observed, requested) {
  if (Object.is(observed, requested)) return true;
  if (!observed || !requested || typeof observed !== "object" || typeof requested !== "object"
    || Array.isArray(observed) || Array.isArray(requested)) return false;
  return Object.entries(requested).every(
    ([key, requestedValue]) => Object.hasOwn(observed, key)
      && coversStructuredFact(observed[key], requestedValue),
  );
}

function responseForToolResult(toolResult) {
  if (toolResult.executionState === "observed-succeeded") {
    return "传感器已确认车辆状态，操作已完成。";
  }
  if (toolResult.executionState === "timeout") {
    return "车辆状态确认超时，暂未确认操作完成。";
  }
  return "车辆执行未成功，请保持当前状态并稍后重试。";
}

function terminalFragment(input = {}) {
  return deepFreeze({
    assistantResponse: String(input.assistantResponse || ""),
    safetyDecision: input.safetyDecision ?? null,
    toolCall: input.toolCall ?? null,
    toolResult: input.toolResult ?? null,
    vehicleStateSnapshot: input.vehicleStateSnapshot ?? null,
    manualQueryPlan: null,
    manualEvidence: null,
    modelCalls: [],
    degraded: input.degraded === true,
  });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}
