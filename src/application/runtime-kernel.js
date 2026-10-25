import { createAbortError, isCancellationError, throwIfAborted } from "../runtime/abort-utils.js";
import { createInteractionRef, createRunEvent } from "../runtime/run-event-protocol.js";
import { classifyRuntimeResult } from "./result-semantics.js";
import { projectVehicleSluSummary } from "../semantic/vehicle-slu-contract.js";
import { projectVehicleSluConversationContext } from "../semantic/vehicle-slu-conversation-context.js";
import { createVehicleSluPlanAuthority } from "../semantic/vehicle-slu-orchestration.js";
import { resolveVoiceBridgeEligibility } from "./voice-bridge-policy.js";
import { projectUseCaseFragment } from "./runtime-task-projection.js";
import { createRouteDecision } from "./route-policy.js";

const VEHICLE_KNOWLEDGE_CONTEXT_TTL_MS = 30 * 60 * 1000;
const VEHICLE_WINDOW_CONTEXT_TTL_MS = 2 * 60 * 1000;
const VEHICLE_CONVERSATION_CONTEXT_TTL_MS = 2 * 60 * 1000;
const MAX_VEHICLE_KNOWLEDGE_CONTEXTS = 128;

export class RuntimeKernel {
  constructor({
    routePolicy,
    useCases,
    runEventLedger,
    sessionMemory,
    pendingClarifications,
    now,
    createRequestId,
    prepareManualRetrievalCandidate,
  } = {}) {
    if (!routePolicy || typeof routePolicy.resolve !== "function") {
      throw new TypeError("routePolicy must provide resolve()");
    }
    if (!useCases || typeof useCases !== "object") {
      throw new TypeError("useCases must be an object");
    }
    if (!runEventLedger || ["append", "getCurrentRun", "completeRun", "terminateRun"]
      .some((method) => typeof runEventLedger[method] !== "function")) {
      throw new TypeError(
        "runEventLedger must provide append(), getCurrentRun(), completeRun(), and terminateRun()",
      );
    }
    if (!sessionMemory
      || typeof sessionMemory.buildConversationHint !== "function"
      || typeof sessionMemory.write !== "function") {
      throw new TypeError("sessionMemory must provide buildConversationHint() and write()");
    }
    if (pendingClarifications && ["get", "set", "mergeSlots", "clear"]
      .some((method) => typeof pendingClarifications[method] !== "function")) {
      throw new TypeError("pendingClarifications must provide get(), set(), mergeSlots(), and clear()");
    }
    if (now !== undefined && typeof now !== "function") {
      throw new TypeError("now must be a function");
    }
    if (createRequestId !== undefined && typeof createRequestId !== "function") {
      throw new TypeError("createRequestId must be a function");
    }
    if (prepareManualRetrievalCandidate !== undefined
      && typeof prepareManualRetrievalCandidate !== "function") {
      throw new TypeError("prepareManualRetrievalCandidate must be a function");
    }
    this.routePolicy = routePolicy;
    this.useCases = useCases;
    this.runEventLedger = runEventLedger;
    this.sessionMemory = sessionMemory;
    this.pendingClarifications = pendingClarifications || null;
    this.pendingRunEpochs = new Map();
    this.vehicleKnowledgeContexts = new Map();
    this.vehicleWindowContexts = new Map();
    this.vehicleConversationContexts = new Map();
    this.nextPendingRunToken = 0;
    this.now = now || Date.now;
    this.createRequestId = createRequestId || defaultCreateRequestId;
    this.prepareManualRetrievalCandidate = prepareManualRetrievalCandidate || null;
    this.listeners = new Set();
  }

  onEvent(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancelPendingClarification(sessionId, reasonCode = "user-cancelled") {
    if (!this.pendingClarifications) return { status: "disabled", reasonCode };
    const id = normalizeClarificationSessionId(sessionId);
    this.pendingRunEpochs.delete(id);
    return this.pendingClarifications.clear(id, reasonCode);
  }

  async run(rawText, options = {}) {
    const requestId = String(options.requestId || this.createRequestId()).trim();
    if (!requestId) throw new TypeError("requestId must be a non-empty string");
    const text = String(rawText || "").trim();
    const interactionRef = options.interactionRef ? createInteractionRef(options.interactionRef) : null;
    const sessionId = interactionRef?.sessionId || options.sessionId;
    const clarificationSessionId = normalizeClarificationSessionId(
      options.clarificationSessionId ?? sessionId,
    );
    const pendingRunToken = this.beginPendingRun(clarificationSessionId);
    const events = [];
    let sequence = 0;
    let previousEventId = null;
    let terminalStatus = "failed";
    let memoryRecord = null;
    let primaryError = null;
    let manualRetrievalCandidate = null;
    const handledRealtimeModelPhases = new Set();

    const emit = (input = {}) => {
      sequence += 1;
      const event = createRunEvent({
        eventId: `event:${requestId}:${sequence}`,
        runId: requestId,
        parentEventId: Object.hasOwn(input, "parentEventId") ? input.parentEventId : previousEventId,
        sequence,
        timestamp: toIsoTimestamp(this.now()),
        component: input.component,
        phase: input.phase,
        status: input.status,
        summary: input.summary,
        refs: input.refs ?? [],
        model: input.model,
        provider: input.provider,
        durationMs: input.durationMs,
        metadata: correlateInteraction(input.metadata, interactionRef),
      });
      this.runEventLedger.append(event);
      events.push(event);
      previousEventId = event.eventId;
      for (const listener of this.listeners) listener(event);
      return event;
    };

    try {
      if (options.developerScenarioObservation) {
        emit({
          component: "vehicleStateProvider",
          phase: "developer-scenario",
          status: "completed",
          summary: "Developer Scenario Provider observation 已由本次 Run 消费。",
          metadata: {
            simulated: true,
            developerScenario: projectDeveloperScenario(options.developerScenarioObservation),
          },
        });
      }
      emit({
        component: "cabinAssistant",
        phase: "intake",
        status: "processing",
        summary: "已接收用户输入。",
        metadata: {},
      });
      throwIfAborted(options.signal);
      const pending = this.pendingClarifications?.get(clarificationSessionId) ?? null;
      const vehicleKnowledgeContext = this.readVehicleKnowledgeContext(clarificationSessionId);
      const vehicleWindowContext = this.readVehicleWindowContext(clarificationSessionId);
      const vehicleConversationContext = this.readVehicleConversationContext(clarificationSessionId);
      let routeResolutionPromise;
      try {
        const vehicleControlUseCase = this.useCases["vehicle-control"];
        const continuation = options.confirmationResponse
          && typeof vehicleControlUseCase?.resolveConfirmationContinuation === "function"
          ? vehicleControlUseCase.resolveConfirmationContinuation({
            confirmationResponse: options.confirmationResponse,
            rawText: text,
            runId: requestId,
            signal: options.signal,
          })
          : null;
        routeResolutionPromise = continuation?.status === "resolved"
          ? Promise.resolve(createConfirmationContinuationRouteResolution({
            continuation,
            runId: requestId,
          }))
          : continuation?.status === "invalid"
            ? Promise.resolve(createInvalidConfirmationRouteResolution({
              continuation,
              rawText: text,
              runId: requestId,
            }))
            : Promise.resolve(this.routePolicy.resolve(text, {
              requestId,
              runId: requestId,
              lastVehicleIntent: options.lastVehicleIntent
                || vehicleKnowledgeContext?.intent
                || vehicleWindowContext?.intent
                || vehicleConversationContext?.frames.at(-1)?.intent,
              lastVehicleQuery: options.lastVehicleQuery
                || vehicleKnowledgeContext?.query
                || (vehicleConversationContext?.frames.at(-1)?.intent === "vehicle.knowledge.query"
                  ? vehicleConversationContext.frames.at(-1).slots.query
                  : undefined),
              conversationContext: vehicleConversationContext,
              pending,
              signal: options.signal,
              deadlineAt: options.deadlineAt,
            }));
      } catch (error) {
        routeResolutionPromise = Promise.reject(error);
      }
      manualRetrievalCandidate = options.confirmationResponse
        ? null
        : preparePrivateManualCandidate(
          this.prepareManualRetrievalCandidate,
          {
            runId: requestId,
            query: text,
            vehicleModel: "ES8",
            signal: options.signal,
          },
        );
      const routeResolution = await routeResolutionPromise;
      throwIfAborted(options.signal);
      this.assertPendingRunCurrent(clarificationSessionId, pendingRunToken);
      this.updateVehicleKnowledgeContext(clarificationSessionId, routeResolution);
      this.updateVehicleWindowContext(clarificationSessionId, routeResolution);
      this.updateVehicleConversationContext(clarificationSessionId, routeResolution);
      const routeDecision = routeResolution?.decision;
      const parsedCommand = routeResolution?.parsedCommand;
      const semanticTelemetry = routeResolution?.semanticTelemetry;
      if (!routeDecision || !parsedCommand) {
        throw new TypeError("routePolicy.resolve() must return decision and parsedCommand");
      }
      this.applyClarificationTransition({
        sessionId: clarificationSessionId,
        requestId,
        rawText: text,
        pending,
        transition: routeResolution.clarificationTransition,
        runToken: pendingRunToken,
      });
      const vehicleSluResolution = Object.hasOwn(routeResolution, "semanticEnvelope");
      const semanticEnvelope = routeResolution.semanticEnvelope ?? null;
      const semanticAuthority = semanticEnvelope
        ? createVehicleSluPlanAuthority(semanticEnvelope)
        : null;
      const executionDisabled = routeResolution.executionDisabled === true;
      const selectedDirectKnowledge = routeDecision.disposition === "execute"
        && routeDecision.routeId === "vehicle-knowledge"
        && routeDecision.mode === "direct";
      if (!selectedDirectKnowledge && manualRetrievalCandidate) {
        discardManualCandidate(manualRetrievalCandidate, "route-not-direct-knowledge");
        manualRetrievalCandidate = null;
      }

      const semanticModelRouted = routeDecision.semanticSource === "model";
      const routeModelCalls = semanticModelRouted
        ? Object.freeze([Object.freeze({
          phase: "route-decision",
          telemetry: semanticTelemetry ?? Object.freeze({}),
        })])
        : Object.freeze([]);
      emit({
        component: semanticModelRouted ? "vehicleSluModel" : "runtimeKernel",
        phase: "route-decision",
        status: "completed",
        summary: routeDecision.reasonCode || routeDecision.disposition,
        model: semanticModelRouted ? semanticTelemetry?.model : undefined,
        provider: semanticModelRouted ? semanticTelemetry?.provider : undefined,
        durationMs: semanticModelRouted
          ? normalizeRunEventDuration(semanticTelemetry?.durationMs)
          : undefined,
        metadata: {
          ...(routeDecision.reasonCode ? { reasonCode: routeDecision.reasonCode } : {}),
          degraded: semanticTelemetry?.degraded === true,
          routing: projectRouteEventMetadata({
            routeDecision,
            semanticEnvelope: vehicleSluResolution ? semanticEnvelope : null,
            validation: routeResolution.validation,
          }),
          ...(semanticModelRouted
            ? { modelTelemetry: projectModelTelemetry(semanticTelemetry) }
            : {}),
        },
      });
      const voiceBridgeEligibility = resolveRuntimeVoiceBridgeEligibility({
        requestId,
        routeDecision,
        parsedCommand,
      });
      emit({
        component: "voiceBridgeEligibility",
        phase: "voice-bridge-eligibility",
        status: "completed",
        summary: voiceBridgeEligibility.allowed
          ? "Runtime 已授权普通对话的中性等待提示。"
          : "Runtime 未授权等待提示。",
        metadata: {
          reasonCode: voiceBridgeEligibility.reason,
          policyVersion: voiceBridgeEligibility.policyVersion,
          voiceBridgeEligibility: projectVoiceBridgeEligibility(voiceBridgeEligibility),
        },
      });

      if (["respond", "clarify", "cancel"].includes(routeDecision.disposition)) {
        const cancelled = routeDecision.disposition === "cancel";
        if (cancelled) {
          this.invalidatePendingRun(clarificationSessionId, pendingRunToken, "route-cancelled");
        }
        const assistantResponse = cancelled ? "已取消。" : requireRouteAssistantResponse(routeResolution);
        const resultSemantics = classifyRuntimeResult({
          disposition: routeDecision.disposition,
          fallbackActive: routeModelCalls.some((call) => call.telemetry?.fallback === true),
        });
        emit({
          component: "cabinAssistant",
          phase: "final-response",
          status: cancelled
            ? "cancelled"
            : routeDecision.disposition === "clarify" ? "awaiting_clarification" : "completed",
          summary: assistantResponse,
          metadata: {
            reasonCode: routeDecision.reasonCode,
            presentation: {
              outcomeStatus: routeDecision.disposition === "clarify" ? "clarification" : "answered",
              resultStatus: resultSemantics.status,
            },
          },
        });
        terminalStatus = cancelled ? "cancelled" : "completed";
        return createPublicResult({
          requestId,
          text,
          interactionRef,
          routeResolution,
          fragment: { assistantResponse, modelCalls: [] },
          modelCalls: routeModelCalls,
          voiceBridgeEligibility,
          events,
        });
      }

      if (routeDecision.disposition !== "execute") {
        throw new TypeError(`unsupported route disposition: ${routeDecision.disposition}`);
      }
      const useCase = this.useCases[routeDecision.routeId];
      if (!useCase || typeof useCase.execute !== "function") {
        throw new TypeError(`missing use case for route: ${routeDecision.routeId}`);
      }
      const memoryRead = routeDecision.routeId === "chat"
        ? this.sessionMemory.buildConversationHint(sessionId)
        : null;
      const context = Object.freeze({
        runId: requestId,
        rawText: text,
        routeDecision,
        parsedCommand,
        semanticTelemetry,
        semanticEnvelope,
        semanticAuthority,
        executionDisabled,
        routeValidation: routeResolution.validation,
        interactionRef,
        signal: options.signal,
        deadlineAt: options.deadlineAt,
        confirmationResponse: options.confirmationResponse,
        vehicleSensorMode: options.vehicleSensorMode,
        vehicleSensorLatencyMs: options.vehicleSensorLatencyMs,
        memoryHint: memoryRead?.hint ?? null,
        manualRetrievalCandidate: selectedDirectKnowledge
          ? manualRetrievalCandidate
          : null,
        emit,
        markModelEventHandled(phase) {
          if (!["goal-formation", "task-planning", "final-synthesis"].includes(phase)) {
            throw new TypeError(`unsupported realtime model event phase: ${phase}`);
          }
          handledRealtimeModelPhases.add(phase);
        },
        throwIfAborted: () => throwIfAborted(options.signal),
      });
      const rawFragment = await useCase.execute(context);
      const fragment = projectUseCaseFragment(routeDecision, rawFragment, requestId);
      const preserveCommittedCancellation = fragment?.taskStatus === "cancelled"
        && fragment.committedEffects.length > 0;
      if (!preserveCommittedCancellation) throwIfAborted(options.signal);
      const useCaseModelCalls = Array.isArray(fragment?.modelCalls) ? fragment.modelCalls : [];
      for (const modelCall of useCaseModelCalls) {
        if (["knowledge-subplanning", "knowledge-answer"].includes(modelCall.phase)) continue;
        if (handledRealtimeModelPhases.has(modelCall.phase)) continue;
        const modelPhase = projectModelEventPhase(modelCall.phase);
        emit({
          component: projectModelComponent(modelPhase),
          phase: modelPhase,
          status: "completed",
          summary: modelPhase.startsWith("knowledge-") ? "知识任务模型调用已完成。" : "模型调用已完成。",
          model: modelCall.telemetry?.model,
          provider: modelCall.telemetry?.provider,
          durationMs: normalizeRunEventDuration(modelCall.telemetry?.durationMs),
          metadata: {
            degraded: fragment.degraded === true || modelCall.telemetry?.degraded === true,
            modelTelemetry: projectModelTelemetry(modelCall.telemetry),
            ...(modelPhase.startsWith("knowledge-") && fragment?.executionFacts?.delegationId
              ? { knowledge: { delegationId: fragment.executionFacts.delegationId } }
              : {}),
          },
        });
      }
      const fragmentTerminalStatus = fragment?.taskStatus === "failed"
        ? "failed"
        : fragment?.taskStatus === "cancelled" ? "cancelled" : "completed";
      const finalEventStatus = resolveFinalEventStatus(fragment, fragmentTerminalStatus);
      const resultSemantics = classifyRuntimeResult({
        taskStatus: fragmentTerminalStatus,
        outcomeStatus: fragment?.outcomeStatus,
        safetyAction: fragment?.safetyDecision?.action,
        executionState: fragment?.toolResult?.executionState,
        retrievalStatus: fragment?.manualEvidence?.status ?? fragment?.retrievalStatus,
        fallbackActive: useCaseModelCalls.some((call) => call.telemetry?.fallback === true),
        providerUnavailable: finalEventStatus === "unavailable",
      });
      emit({
        component: "cabinAssistant",
        phase: "final-response",
        status: finalEventStatus,
        summary: fragment?.assistantResponse || finalSummary(finalEventStatus),
        metadata: {
          ...(fragment?.taskStatus && fragment.taskStatus !== "completed"
            ? { reasonCode: `task-${fragment.taskStatus}` }
            : {}),
          degraded: fragment?.degraded === true || fragmentTerminalStatus !== "completed",
          presentation: {
            ...(fragment?.taskStatus ? { taskStatus: fragment.taskStatus } : {}),
            ...(fragment?.outcomeStatus ? { outcomeStatus: fragment.outcomeStatus } : {}),
            resultStatus: resultSemantics.status,
          },
        },
      });
      terminalStatus = fragmentTerminalStatus;
      if (routeDecision.routeId === "chat" && fragment?.assistantResponse) {
        memoryRecord = createMemoryRecord({
          requestId,
          text,
          parsedCommand,
          assistantResponse: fragment.assistantResponse,
          interactionRef,
          sessionId,
        });
      }
      const modelCalls = Object.freeze([...routeModelCalls, ...useCaseModelCalls]);
      return createPublicResult({
        requestId, text, interactionRef, routeResolution, fragment, modelCalls, events,
        voiceBridgeEligibility,
      });
    } catch (error) {
      const cancelled = options.signal?.aborted || isCancellationError(error);
      if (cancelled) {
        this.invalidatePendingRun(
          clarificationSessionId,
          pendingRunToken,
          "run-cancelled",
        );
      }
      terminalStatus = cancelled ? "cancelled" : "failed";
      try {
        emit({
          component: "cabinAssistant",
          phase: "final-response",
          status: terminalStatus,
          summary: cancelled ? "运行已取消。" : "运行失败。",
          metadata: {
            reasonCode: cancelled ? "run-cancelled" : "run-error",
            degraded: true,
            presentation: { outcomeStatus: cancelled ? "cancelled" : "failed" },
          },
        });
      } catch {
        // Preserve the original failure while finally closes the ledger.
      }
      primaryError = cancelled ? createAbortError(options.signal?.reason ?? error) : error;
      throw primaryError;
    } finally {
      if (manualRetrievalCandidate) {
        discardManualCandidate(manualRetrievalCandidate, "runtime-finalized");
        manualRetrievalCandidate = null;
      }
      this.releasePendingRun(clarificationSessionId, pendingRunToken);
      const finalization = finalizeRunEventLedger(this.runEventLedger, requestId, terminalStatus);
      if (finalization.fatalError) {
        if (primaryError) attachFinalizationError(primaryError, finalization.fatalError);
        else throw finalization.fatalError;
      }
      if (terminalStatus === "completed" && finalization.closed && memoryRecord?.assistantText) {
        try {
          this.sessionMemory.write(memoryRecord.sessionId, memoryRecord.record);
        } catch {
          // Session memory is a best-effort cache after the completed Run fact is durable.
        }
      }
    }
  }

  beginPendingRun(sessionId) {
    if (!this.pendingClarifications) return null;
    const token = ++this.nextPendingRunToken;
    this.pendingRunEpochs.set(sessionId, token);
    return token;
  }

  releasePendingRun(sessionId, token) {
    if (token !== null && this.pendingRunEpochs.get(sessionId) === token) {
      this.pendingRunEpochs.delete(sessionId);
    }
  }

  assertPendingRunCurrent(sessionId, token) {
    if (token === null) return;
    if (this.pendingRunEpochs.get(sessionId) !== token) {
      throw createAbortError("stale-runtime-run");
    }
  }

  readVehicleKnowledgeContext(sessionId) {
    const context = this.vehicleKnowledgeContexts.get(sessionId);
    if (!context) return null;
    if (this.now() >= context.expiresAt) {
      this.vehicleKnowledgeContexts.delete(sessionId);
      return null;
    }
    return { intent: context.intent, query: context.query };
  }

  updateVehicleKnowledgeContext(sessionId, routeResolution) {
    const envelope = routeResolution?.semanticEnvelope;
    if (!envelope) return;
    const queryFrame = envelope.vehicleFrames?.find((frame) => (
      frame.intent === "vehicle.knowledge.query"
      && frame.actionNeed === "none"
      && typeof frame.slots?.query === "string"
      && frame.slots.query.trim()
    ));
    if (routeResolution.decision?.routeId === "vehicle-knowledge" && queryFrame) {
      this.vehicleKnowledgeContexts.delete(sessionId);
      this.vehicleKnowledgeContexts.set(sessionId, {
        intent: queryFrame.intent,
        query: queryFrame.slots.query.trim().slice(0, 240),
        expiresAt: this.now() + VEHICLE_KNOWLEDGE_CONTEXT_TTL_MS,
      });
      while (this.vehicleKnowledgeContexts.size > MAX_VEHICLE_KNOWLEDGE_CONTEXTS) {
        this.vehicleKnowledgeContexts.delete(this.vehicleKnowledgeContexts.keys().next().value);
      }
      return;
    }
    this.vehicleKnowledgeContexts.delete(sessionId);
  }

  readVehicleWindowContext(sessionId) {
    const context = this.vehicleWindowContexts.get(sessionId);
    if (!context) return null;
    if (this.now() >= context.expiresAt) {
      this.vehicleWindowContexts.delete(sessionId);
      return null;
    }
    return { intent: context.intent };
  }

  updateVehicleWindowContext(sessionId, routeResolution) {
    const frames = routeResolution?.semanticEnvelope?.vehicleFrames;
    const frame = Array.isArray(frames) && frames.length === 1 ? frames[0] : null;
    if (routeResolution?.decision?.routeId === "vehicle-control"
      && frame?.intent === "body.window.setPosition"
      && frame.actionNeed === "execute"
      && typeof frame.slots?.zone === "string"
      && Number.isInteger(frame.slots?.percent)
      && frame.slots.percent >= 0
      && frame.slots.percent <= 100) {
      this.vehicleWindowContexts.delete(sessionId);
      this.vehicleWindowContexts.set(sessionId, {
        intent: frame.intent,
        expiresAt: this.now() + VEHICLE_WINDOW_CONTEXT_TTL_MS,
      });
      while (this.vehicleWindowContexts.size > MAX_VEHICLE_KNOWLEDGE_CONTEXTS) {
        this.vehicleWindowContexts.delete(this.vehicleWindowContexts.keys().next().value);
      }
      return;
    }
    this.vehicleWindowContexts.delete(sessionId);
  }

  readVehicleConversationContext(sessionId) {
    const context = this.vehicleConversationContexts.get(sessionId);
    if (!context) return null;
    if (this.now() >= context.expiresAt) {
      this.vehicleConversationContexts.delete(sessionId);
      return null;
    }
    return projectVehicleSluConversationContext(context);
  }

  updateVehicleConversationContext(sessionId, routeResolution) {
    const envelope = routeResolution?.semanticEnvelope;
    if (routeResolution?.decision?.disposition !== "execute"
      || envelope?.domain !== "vehicle"
      || !Array.isArray(envelope.vehicleFrames)) {
      this.vehicleConversationContexts.delete(sessionId);
      return;
    }
    const context = projectVehicleSluConversationContext({
      frames: envelope.vehicleFrames
        .filter((frame) => frame.actionNeed === "execute"
          || (frame.actionNeed === "none" && [
            "vehicle.knowledge.query",
            "vehicle.state.query",
            "weather.query",
          ].includes(frame.intent)))
        .map(({ intent, slots }) => ({ intent, slots })),
    });
    if (!context) {
      this.vehicleConversationContexts.delete(sessionId);
      return;
    }
    this.vehicleConversationContexts.delete(sessionId);
    this.vehicleConversationContexts.set(sessionId, {
      ...context,
      expiresAt: this.now() + VEHICLE_CONVERSATION_CONTEXT_TTL_MS,
    });
    while (this.vehicleConversationContexts.size > MAX_VEHICLE_KNOWLEDGE_CONTEXTS) {
      this.vehicleConversationContexts.delete(this.vehicleConversationContexts.keys().next().value);
    }
  }

  applyClarificationTransition({ sessionId, requestId, rawText, pending, transition, runToken }) {
    if (!this.pendingClarifications || !transition) return;
    this.assertPendingRunCurrent(sessionId, runToken);
    if (["none", "preserve", "reject"].includes(transition.action)) return;

    if (transition.action === "open"
      || (transition.action === "replace" && transition.nextPending)) {
      const candidate = transition.nextPending;
      this.pendingClarifications.set(sessionId, {
        taskId: `clarification:${requestId}:${candidate.frameId}`,
        intent: candidate.intent,
        acceptedSlots: { ...candidate.acceptedSlots },
        missingSlots: [...candidate.missingSlots],
        slotProvenance: Object.fromEntries(
          Object.keys(candidate.acceptedSlots).map((key) => [key, "original-turn"]),
        ),
        clarificationQuestion: candidate.clarificationQuestion,
        originalUtterance: rawText,
      });
      return;
    }

    if (transition.action === "cancel") {
      this.pendingClarifications.clear(sessionId, "model-cancelled-pending");
      return;
    }

    if (transition.action === "merge") {
      const delta = clarificationSlotDelta(pending, transition.nextPending?.acceptedSlots);
      this.pendingClarifications.mergeSlots(sessionId, {
        slots: delta,
        slotProvenance: clarificationSlotProvenance(delta),
      });
      return;
    }

    if (transition.action === "resolve") {
      const delta = clarificationSlotDelta(pending, transition.resolvedFrame?.slots);
      if (Object.keys(delta).length > 0) {
        this.pendingClarifications.mergeSlots(sessionId, {
          slots: delta,
          slotProvenance: clarificationSlotProvenance(delta),
        });
      }
      this.pendingClarifications.clear(sessionId, "clarification-resolved");
      return;
    }

    if (transition.action === "replace") {
      this.pendingClarifications.clear(sessionId, "conflicting-intent-resolved");
    }
  }

  invalidatePendingRun(sessionId, token, reasonCode) {
    if (!this.pendingClarifications || token === null) return;
    if (this.pendingRunEpochs.get(sessionId) !== token) return;
    this.pendingRunEpochs.delete(sessionId);
    this.pendingClarifications.clear(sessionId, reasonCode);
  }
}

function preparePrivateManualCandidate(prepare, input) {
  if (typeof prepare !== "function") return null;
  try {
    const candidate = prepare(input);
    if (candidate && typeof candidate.then === "function") {
      Promise.resolve(candidate).catch(() => {});
      return null;
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || typeof candidate.consume !== "function"
      || typeof candidate.discard !== "function") return null;
    return candidate;
  } catch {
    return null;
  }
}

function discardManualCandidate(candidate, reasonCode) {
  try {
    candidate.discard(reasonCode);
  } catch {
    // Candidate cleanup is private and must not replace the authoritative Run result.
  }
}

function createPublicResult({
  requestId,
  text,
  interactionRef,
  routeResolution,
  fragment = {},
  modelCalls = fragment.modelCalls,
  voiceBridgeEligibility,
  events,
}) {
  return Object.freeze({
    requestId,
    rawText: text,
    interactionRef,
    routeDecision: routeResolution.decision,
    parsedCommand: routeResolution.parsedCommand,
    semanticEnvelope: routeResolution.semanticEnvelope ?? null,
    semanticAuthority: routeResolution.semanticEnvelope
      ? createVehicleSluPlanAuthority(routeResolution.semanticEnvelope)
      : null,
    executionDisabled: routeResolution.executionDisabled === true,
    assistantResponse: fragment.assistantResponse || "",
    safetyDecision: fragment.safetyDecision ?? null,
    toolCall: fragment.toolCall ?? null,
    toolResult: fragment.toolResult ?? null,
    vehicleStateSnapshot: fragment.vehicleStateSnapshot ?? null,
    manualQueryPlan: fragment.manualQueryPlan ?? null,
    manualEvidence: fragment.manualEvidence ?? null,
    voiceBridgeEligibility: voiceBridgeEligibility ?? null,
    ...(fragment.taskStatus ? {
      status: fragment.taskStatus,
      taskStatus: fragment.taskStatus,
      executionFacts: fragment.executionFacts,
      committedEffects: fragment.committedEffects,
      taskSnapshot: fragment.taskSnapshot,
    } : {}),
    runtimeTelemetry: projectRuntimeTelemetry(modelCalls, events),
    events: Object.freeze([...events]),
  });
}

function requireRouteAssistantResponse(routeResolution) {
  const value = typeof routeResolution?.assistantResponse === "string"
    ? routeResolution.assistantResponse.trim()
    : "";
  if (!value) throw new TypeError("terminal respond/clarify requires routeResolution.assistantResponse");
  return value;
}

function resolveRuntimeVoiceBridgeEligibility({ requestId, routeDecision, parsedCommand }) {
  const disposition = routeDecision?.disposition;
  const routeId = routeDecision?.routeId;
  const terminalCancel = disposition === "cancel";
  const command = terminalCancel
    ? { ...parsedCommand, intent: "runtime.cancel" }
    : parsedCommand;
  return resolveVoiceBridgeEligibility({
    requestId,
    command,
    manualQueryPlan: routeId === "vehicle-knowledge"
      ? { knowledgeNeed: "manual", actionNeed: "explain" }
      : { knowledgeNeed: "none", actionNeed: "none" },
    conversationRoute: routeId === "task"
      ? { requiresExternalData: true }
      : {},
    manualQuestion: routeId === "vehicle-knowledge",
  });
}

function projectRuntimeTelemetry(modelCalls = [], events = []) {
  const calls = Object.freeze([...modelCalls]);
  return Object.freeze({
    modelCallCount: calls.length,
    modelCalls: calls,
    eventCount: events.length,
    degraded: events.some((event) => event.metadata?.degraded === true),
  });
}

function projectModelEventPhase(phase) {
  if (phase === "knowledge-subplanning") return "knowledge-plan-model";
  if (phase === "knowledge-answer") return "knowledge-answer-model";
  return phase;
}

function projectModelComponent(phase) {
  if (["task-planning", "knowledge-plan-model"].includes(phase)) return "orchestratorModel";
  return "cabinModel";
}

function createMemoryRecord({ requestId, text, parsedCommand, assistantResponse, interactionRef, sessionId }) {
  return {
    sessionId,
    assistantText: String(assistantResponse).trim(),
    record: {
      turnId: interactionRef?.turnId || requestId,
      intent: parsedCommand.intent,
      needsClarification: parsedCommand.slots?.needsClarification === true,
      hasManualEvidence: false,
      requiresExternalData: parsedCommand.slots?.requiresExternalData === true,
      userText: text,
      assistantText: assistantResponse,
    },
  };
}

function normalizeClarificationSessionId(value) {
  const id = String(value || "").trim();
  return id || "default-browser-session";
}

function clarificationSlotDelta(pending, acceptedSlots = {}) {
  if (!pending || !acceptedSlots || typeof acceptedSlots !== "object") return {};
  return Object.fromEntries(Object.entries(acceptedSlots).filter(([key, value]) => (
    pending.missingSlots.includes(key)
      && (!Object.hasOwn(pending.acceptedSlots, key) || pending.acceptedSlots[key] !== value)
  )));
}

function clarificationSlotProvenance(slots) {
  return Object.fromEntries(Object.keys(slots).map((key) => [key, "clarification-turn"]));
}

function createConfirmationContinuationRouteResolution({ continuation, runId }) {
  const binding = continuation.binding;
  const parsedCommand = freezeContinuationValue({
    ...binding.parsedCommand,
    requestId: runId,
  });
  return Object.freeze({
    decision: createRouteDecision({
      disposition: "execute",
      routeId: "vehicle-control",
      mode: "direct",
      confidence: binding.routeDecision.confidence,
      reasonCode: binding.routeDecision.reasonCode || "vehicle-control-write",
      semanticSource: "confirmation-continuation",
      normalizedIntentRef: binding.routeDecision.normalizedIntentRef,
      runId,
    }),
    parsedCommand,
    semanticTelemetry: null,
    executionDisabled: false,
    assistantResponse: "",
    validation: binding.routeValidation,
  });
}

function createInvalidConfirmationRouteResolution({ continuation, rawText, runId }) {
  const reasonCode = continuation.reasonCode || "confirmation-continuation-unavailable";
  return Object.freeze({
    decision: createRouteDecision({
      disposition: "respond",
      routeId: null,
      mode: null,
      confidence: 0,
      reasonCode,
      semanticSource: "confirmation-continuation",
      normalizedIntentRef: null,
      runId,
    }),
    parsedCommand: freezeContinuationValue({
      requestId: runId,
      rawText: String(rawText || ""),
      source: "confirmation-continuation",
      confidence: 0,
      intent: "conversation.general",
      speechAct: "statement",
      actionability: {
        actionable: false,
        reason: reasonCode,
        source: "confirmation-continuation",
        intendedIntent: "conversation.general",
      },
      slots: {},
      slotProvenance: {},
      conversationGoal: {
        summary: "车辆安全确认已失效",
        requiresReply: true,
        interactionType: "command",
        domain: "vehicle_control",
        goal: "重新发起车辆动作",
        source: "confirmation-continuation",
      },
    }),
    semanticTelemetry: null,
    executionDisabled: true,
    assistantResponse: "安全确认已失效，请重新发起车辆动作。",
    validation: Object.freeze({
      contractValidation: Object.freeze({ ok: false, errors: Object.freeze([reasonCode]) }),
      capabilityValidation: Object.freeze({ ok: false }),
      slotValidation: Object.freeze({ ok: false }),
    }),
  });
}

function freezeContinuationValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freezeContinuationValue(item, seen);
  return Object.freeze(value);
}

function projectRouteEventMetadata({ routeDecision, semanticEnvelope, validation }) {
  const semanticSummary = semanticEnvelope
    ? projectSafeVehicleSluSummary(projectVehicleSluSummary(semanticEnvelope))
    : null;
  return Object.freeze({
    routeId: String(routeDecision?.routeId || ""),
    mode: String(routeDecision?.mode || ""),
    disposition: String(routeDecision?.disposition || ""),
    semanticSource: String(routeDecision?.semanticSource || ""),
    ...(semanticSummary ? { semanticSummary } : {}),
    validation: Object.freeze({
      contract: projectVehicleSluValidationStatus(validation?.contractValidation),
      capability: projectVehicleSluValidationStatus(validation?.capabilityValidation),
      slot: projectVehicleSluValidationStatus(validation?.slotValidation),
    }),
  });
}

function projectSafeVehicleSluSummary(summary) {
  return Object.freeze({
    contractVersion: summary.contractVersion,
    requestId: summary.requestId,
    domain: summary.domain,
    conversationGoal: Object.freeze({
      summary: summary.conversationGoal.summary,
      need: summary.conversationGoal.need,
    }),
    domainConfidence: summary.domainConfidence,
    vehicleFrames: Object.freeze(summary.vehicleFrames.map((frame) => Object.freeze({
      frameId: frame.frameId,
      capability: frame.capability,
      intent: frame.intent,
      speechAct: frame.speechAct,
      knowledgeNeed: frame.knowledgeNeed,
      actionNeed: frame.actionNeed,
      missingSlots: Object.freeze([...frame.missingSlots]),
      clarificationQuestion: frame.clarificationQuestion,
      confidence: frame.confidence,
      slotNames: Object.freeze([...frame.slotNames]),
    }))),
  });
}

function projectVehicleSluValidationStatus(value) {
  return Object.freeze({ ok: value?.ok === true });
}

function normalizeRunEventDuration(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function correlateInteraction(metadata, interactionRef) {
  return interactionRef ? { ...(metadata || {}), interactionRef } : metadata || {};
}

function projectModelTelemetry(source = {}) {
  const telemetry = {};
  for (const field of [
    "revision", "fallbackReasonCode", "validationSubreason",
    "primaryFailureReasonCode", "providerFailureReasonCode",
  ]) {
    if (typeof source?.[field] === "string" && source[field].trim()) telemetry[field] = source[field].trim();
  }
  if (typeof source?.promptVersion === "string" && source.promptVersion.trim()) {
    telemetry.revision = source.promptVersion.trim();
  }
  if (typeof source?.fallback === "boolean") telemetry.fallback = source.fallback;
  for (const field of ["fallbackActive", "fallbackAttempted"]) {
    if (typeof source?.[field] === "boolean") telemetry[field] = source[field];
  }
  for (const field of [
    "structuredRetryCount", "queueMs", "transportMs", "firstTokenMs", "generationMs",
    "parseMs", "inputTokenCount", "outputTokenCount", "externalModelRequestCount",
  ]) {
    if (Number.isFinite(source?.[field]) && source[field] >= 0) telemetry[field] = Math.round(source[field]);
  }
  if (source?.ollamaDurations && typeof source.ollamaDurations === "object"
    && !Array.isArray(source.ollamaDurations)) {
    const ollamaDurations = {};
    for (const field of [
      "total_duration_ms", "load_duration_ms", "prompt_eval_duration_ms",
      "eval_duration_ms", "prompt_eval_count", "eval_count",
    ]) {
      if (Number.isFinite(source.ollamaDurations[field]) && source.ollamaDurations[field] >= 0) {
        ollamaDurations[field] = Math.round(source.ollamaDurations[field]);
      }
    }
    telemetry.ollamaDurations = Object.freeze(ollamaDurations);
  }
  return Object.freeze(telemetry);
}

function projectVoiceBridgeEligibility(value = {}) {
  return Object.freeze({
    allowed: value.allowed === true,
    noToolOrSafetyPath: value.noToolOrSafetyPath === true,
    requestId: String(value.requestId || ""),
    reason: String(value.reason || ""),
    policyId: String(value.policyId || ""),
    policyVersion: String(value.policyVersion || ""),
  });
}

function projectDeveloperScenario(value = {}) {
  const projected = {};
  for (const field of ["scenarioId", "source", "simulatorMode", "capturedAtMode", "stagedAt", "capturedAt"]) {
    if (typeof value?.[field] === "string" && value[field].trim()) projected[field] = value[field].trim();
  }
  return Object.freeze(projected);
}

function resolveFinalEventStatus(fragment, terminalStatus) {
  if (terminalStatus !== "completed") return terminalStatus;
  if (fragment?.safetyDecision?.allowed === false && fragment.safetyDecision.action === "reject") {
    return "safety_rejected";
  }
  if (fragment?.toolResult?.executionState === "timeout") return "uncertain";
  if (fragment?.outcomeStatus === "clarification") return "awaiting_clarification";
  if (["unavailable", "not-applicable"].includes(fragment?.outcomeStatus)) return "unavailable";
  return "completed";
}

function finalSummary(status) {
  if (status === "cancelled") return "运行已取消。";
  if (status === "awaiting_clarification") return "需要用户补充信息。";
  if (status === "safety_rejected") return "Safety 已拒绝本次车辆动作。";
  if (status === "unavailable") return "所需能力当前不可用。";
  if (status === "uncertain") return "车辆物理终态尚未确认。";
  if (status === "failed") return "运行失败。";
  return "运行已完成。";
}

function toIsoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("now() must return a valid timestamp");
  return date.toISOString();
}

function finalizeRunEventLedger(ledger, runId, terminalStatus) {
  const initial = inspectRunActive(ledger, runId);
  if (!initial.known) {
    return recoverActiveRun(ledger, runId, terminalStatus, initial.error);
  }
  if (!initial.active) return { closed: true, fatalError: null };

  let finishError = null;
  try {
    if (terminalStatus === "completed") ledger.completeRun(runId);
    else ledger.terminateRun(runId, terminalStatus);
  } catch (error) {
    finishError = error;
  }

  const afterFinish = inspectRunActive(ledger, runId);
  if (afterFinish.known && !afterFinish.active) {
    return { closed: true, fatalError: null };
  }
  const failure = finishError || afterFinish.error || new Error(
    `RunEventLedger left run active after ${terminalStatus} finalization`,
  );
  return recoverActiveRun(ledger, runId, terminalStatus, failure);
}

function recoverActiveRun(ledger, runId, terminalStatus, failure) {
  let cleanupError = null;
  try {
    ledger.terminateRun(runId, terminalStatus === "completed" ? "failed" : terminalStatus);
  } catch (error) {
    cleanupError = error;
  }
  const afterCleanup = inspectRunActive(ledger, runId);
  const closed = afterCleanup.known && !afterCleanup.active;
  if (closed && terminalStatus !== "completed") return { closed: true, fatalError: null };
  return {
    closed,
    fatalError: createFinalizationError(failure, cleanupError, afterCleanup.error),
  };
}

function inspectRunActive(ledger, runId) {
  try {
    return { known: true, active: ledger.getCurrentRun()?.runId === runId, error: null };
  } catch (error) {
    return { known: false, active: true, error };
  }
}

function createFinalizationError(...candidates) {
  const errors = candidates.filter(Boolean);
  const first = errors[0] || new Error("unknown RunEventLedger finalization failure");
  if (errors.length === 1) return first;
  return new AggregateError(
    errors,
    `RunEventLedger finalization failed: ${first.message}`,
    { cause: first },
  );
}

function attachFinalizationError(primaryError, finalizationError) {
  try {
    Object.defineProperty(primaryError, "finalizationError", {
      value: finalizationError,
      configurable: true,
    });
  } catch {
    // Error objects are normally extensible; preserve the primary failure if this one is not.
  }
}

let defaultRequestSequence = 0;
function defaultCreateRequestId() {
  defaultRequestSequence += 1;
  return `run:${Date.now()}:${defaultRequestSequence}`;
}
