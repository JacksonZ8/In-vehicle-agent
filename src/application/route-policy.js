import { buildVehicleSluBoundaryResponse } from "../runtime/boundary-response-builder.js";
import {
  createVehicleSluEnvelope,
  getMissingVehicleSluRequiredSlots,
  validateVehicleSluEnvelope,
  VEHICLE_SLU_ONTOLOGY,
} from "../semantic/vehicle-slu-contract.js";
import { resolveClarificationTransition } from "../semantic/clarification-transition.js";
import { projectVehicleSluEnvelope } from "../semantic/vehicle-slu-projector.js";

const EXECUTABLE_ROUTES = new Set(["chat", "vehicle-knowledge", "vehicle-control", "task"]);
const ROUTE_DISPOSITIONS = new Set(["execute", "clarify", "respond", "cancel"]);
const ROUTE_MODES = new Map([
  ["chat", new Set(["direct"])],
  ["vehicle-knowledge", new Set(["direct"])],
  ["vehicle-control", new Set(["direct"])],
  ["task", new Set(["direct-capability", "orchestrated"])],
]);
const CONTROL_WRITE_INTENTS = new Set(VEHICLE_SLU_ONTOLOGY.control.executable);
const SEMANTIC_FAILURE_REASONS = new Set([
  "semantic-contract-invalid",
  "semantic-endpoint-unavailable",
  "semantic-model-unavailable",
  "semantic-timeout",
]);

export function createRouteDecision(input = {}) {
  if (!ROUTE_DISPOSITIONS.has(input.disposition)) {
    throw new TypeError("RouteDecision requires a supported disposition");
  }
  const terminal = input.disposition !== "execute";
  if (input.disposition === "execute" && !EXECUTABLE_ROUTES.has(input.routeId)) {
    throw new TypeError("execute RouteDecision requires one supported routeId");
  }
  if (input.disposition === "execute" && !ROUTE_MODES.get(input.routeId).has(input.mode)) {
    throw new TypeError("execute RouteDecision requires a supported routeId/mode combination");
  }
  if (terminal && (input.routeId !== null || input.mode !== null)) {
    throw new TypeError("terminal RouteDecision cannot select a use case");
  }
  return deepFreeze({
    disposition: input.disposition,
    routeId: input.routeId,
    mode: input.mode,
    confidence: input.confidence,
    reasonCode: String(input.reasonCode || ""),
    semanticSource: input.semanticSource,
    normalizedIntentRef: input.normalizedIntentRef ?? null,
    runId: input.runId,
  });
}

export class RoutePolicy {
  constructor({ localModel } = {}) {
    this.localModel = localModel;
  }

  async resolve(rawText, options = {}) {
    if (typeof this.localModel?.parse !== "function") {
      throw new TypeError("RoutePolicy requires localModel.parse(rawText, options)");
    }
    const modelResult = await this.localModel.parse(rawText, {
      requestId: options.requestId,
      lastVehicleIntent: options.lastVehicleIntent,
      ...(options.conversationContext ? { conversationContext: options.conversationContext } : {}),
      ...(options.pending ? { pending: options.pending } : {}),
      signal: options.signal,
      deadlineAt: options.deadlineAt,
    });
    options = { ...options, semanticSource: "model" };
    const semanticTelemetry = modelResult?.telemetry;

    if (modelResult?.executionDisabled === true || !modelResult?.semanticEnvelope) {
      const reasonCode = stableFailureReason(modelResult?.reasonCode);
      const parsedCommand = failClosedParsedCommand(options.requestId, reasonCode);
      return terminalResult({
        disposition: "respond",
        reasonCode,
        parsedCommand,
        semanticEnvelope: null,
        semanticTelemetry,
        executionDisabled: true,
        assistantResponse: buildVehicleSluBoundaryResponse({ executionDisabled: true, reasonCode }),
        validation: emptyValidation(["semantic envelope unavailable"]),
        options,
      });
    }

    const semanticEnvelopeInput = modelResult.semanticEnvelope;
    const contractValidation = validateVehicleSluEnvelope(semanticEnvelopeInput);
    if (!contractValidation.ok) {
      const reasonCode = "semantic-contract-invalid";
      const parsedCommand = failClosedParsedCommand(options.requestId, reasonCode);
      return terminalResult({
        disposition: "respond",
        reasonCode,
        parsedCommand,
        semanticEnvelope: null,
        semanticTelemetry,
        executionDisabled: true,
        assistantResponse: buildVehicleSluBoundaryResponse({ executionDisabled: true, reasonCode }),
        validation: emptyValidation(contractValidation.errors),
        options,
      });
    }

    const rawSemanticEnvelope = createVehicleSluEnvelope(semanticEnvelopeInput);
    const transitionSlotFrames = rawSemanticEnvelope.vehicleFrames.flatMap(validateSlotFrame);
    const transitionMissingFrames = transitionSlotFrames
      .filter((entry) => entry.missingRequiredSlots.length > 0);
    const transitionEnvelope = transitionMissingFrames.length > 0
      ? normalizeClarificationEnvelope(rawSemanticEnvelope, transitionMissingFrames, options.pending)
      : rawSemanticEnvelope;
    const clarificationTransition = resolveClarificationTransition({
      pending: options.pending ?? null,
      envelope: transitionEnvelope,
    });
    const semanticEnvelope = projectEffectiveClarificationEnvelope({
      pending: options.pending ?? null,
      envelope: transitionEnvelope,
      transition: clarificationTransition,
    });
    options = { ...options, clarificationTransition };
    const projected = projectVehicleSluEnvelope(semanticEnvelope);
    const parsedCommand = projectRuntimeCommand(semanticEnvelope, projected, {
      slotProvenance: projectClarificationSlotProvenance({
        pending: options.pending ?? null,
        transition: clarificationTransition,
      }),
    });
    const capabilityFrames = semanticEnvelope.vehicleFrames.map(validateCapabilityFrame);
    const slotFrames = semanticEnvelope.vehicleFrames.flatMap(validateSlotFrame);
    const capabilityDeferredFrames = capabilityFrames.filter((entry) => entry.status === "deferred");
    const registeredFrames = capabilityFrames.filter((entry) => entry.status === "registered");
    const missingSlotFrames = slotFrames.filter((entry) => entry.missingRequiredSlots.length > 0);
    const admittedWriteFrame = projected.executeFrames.find(isControlWriteFrame) ?? null;
    const deferredWriteFrames = projected.executeFrames.filter(isControlWriteFrame).slice(1);
    const baseValidation = {
      contractValidation: { ok: true, errors: [] },
      capabilityFrames,
      slotFrames,
      admittedWriteFrameId: null,
      deferredWriteFrameIds: deferredWriteFrames.map(({ frameId }) => frameId),
    };

    if (semanticEnvelope.conversationGoal.dialogueAction === "cancel_pending") {
      return terminalResult({
        disposition: "cancel",
        reasonCode: "model-cancelled-pending",
        parsedCommand,
        semanticEnvelope,
        semanticTelemetry,
        executionDisabled: false,
        assistantResponse: "已取消这次待补充的请求。",
        validation: createValidation(baseValidation),
        options,
      });
    }

    if (semanticEnvelope.domain === "non_vehicle") {
      return executeResult({
        routeId: "chat",
        mode: "direct",
        reasonCode: "ordinary-conversation",
        parsedCommand,
        semanticEnvelope,
        semanticTelemetry,
        validation: createValidation(baseValidation),
        options,
      });
    }

    if (semanticEnvelope.domain === "unknown") {
      return terminalResult({
        disposition: "clarify",
        reasonCode: "unknown-domain",
        parsedCommand,
        semanticEnvelope,
        semanticTelemetry,
        executionDisabled: false,
        assistantResponse: "我还不确定这是车载操作还是普通交流，请再说明一下你的需求。",
        validation: createValidation(baseValidation),
        options,
      });
    }

    if (missingSlotFrames.length > 0) {
      const missingSlots = unique(missingSlotFrames.flatMap((entry) => entry.missingRequiredSlots));
      const clarificationEnvelope = normalizeClarificationEnvelope(
        semanticEnvelope,
        missingSlotFrames,
        options.pending,
      );
      const clarificationProjected = projectVehicleSluEnvelope(clarificationEnvelope);
      const clarificationCommand = projectRuntimeCommand(
        clarificationEnvelope,
        clarificationProjected,
        { forceNonActionable: true },
      );
      const clarificationCapabilityFrames = clarificationEnvelope.vehicleFrames
        .map(validateCapabilityFrame);
      const clarificationSlotFrames = clarificationEnvelope.vehicleFrames
        .flatMap(validateSlotFrame);
      const clarificationWriteFrames = clarificationProjected.executeFrames
        .filter(isControlWriteFrame);
      const clarification = unique(clarificationProjected.clarifyFrames
        .map((frame) => frame.clarificationQuestion)
        .filter(Boolean))
        .join(" ");
      return terminalResult({
        disposition: "clarify",
        reasonCode: "missing-required-slots",
        parsedCommand: clarificationCommand,
        semanticEnvelope: clarificationEnvelope,
        semanticTelemetry,
        executionDisabled: false,
        assistantResponse: clarification || buildVehicleSluBoundaryResponse({
          reasonCode: "missing-required-slots", missingSlots,
        }),
        validation: createValidation({
          contractValidation: { ok: true, errors: [] },
          capabilityFrames: clarificationCapabilityFrames,
          slotFrames: clarificationSlotFrames,
          admittedWriteFrameId: clarificationWriteFrames[0]?.frameId ?? null,
          deferredWriteFrameIds: clarificationWriteFrames.slice(1).map(({ frameId }) => frameId),
        }),
        options,
      });
    }

    if (capabilityDeferredFrames.length > 0 && registeredFrames.length === 0) {
      const unsupported = capabilityDeferredFrames[0];
      return terminalResult({
        disposition: "respond",
        reasonCode: "unsupported-capability",
        parsedCommand,
        semanticEnvelope,
        semanticTelemetry,
        executionDisabled: false,
        assistantResponse: buildVehicleSluBoundaryResponse({
          reasonCode: "unsupported-capability",
          capability: unsupported.capability,
        }),
        validation: createValidation(baseValidation),
        options,
      });
    }

    const singleFrame = semanticEnvelope.vehicleFrames.length === 1
      ? semanticEnvelope.vehicleFrames[0]
      : null;
    const hasProtectedFrame = semanticEnvelope.vehicleFrames.some((frame) => frame.intent === "safety.reject");
    if (hasProtectedFrame) {
      return terminalResult({
        disposition: "respond",
        reasonCode: "protected-capability",
        parsedCommand,
        semanticEnvelope,
        semanticTelemetry,
        executionDisabled: false,
        assistantResponse: buildVehicleSluBoundaryResponse({ reasonCode: "protected-capability" }),
        validation: createValidation(baseValidation),
        options,
      });
    }

    if (singleFrame?.capability === "control" && singleFrame.actionNeed === "none") {
      return executeResult({
        routeId: "chat",
        mode: "direct",
        reasonCode: "vehicle-slu-control-answer",
        parsedCommand,
        semanticEnvelope,
        semanticTelemetry,
        validation: createValidation(baseValidation),
        options,
      });
    }

    if (singleFrame && singleFrame.capability === "knowledge" && singleFrame.actionNeed === "none") {
      const reasonCode = singleFrame.intent === "vehicle.state.query"
        ? "vehicle-state-query"
        : "vehicle-knowledge-answer";
      return executeResult({
        routeId: "vehicle-knowledge",
        mode: "direct",
        reasonCode,
        parsedCommand,
        semanticEnvelope,
        semanticTelemetry,
        validation: createValidation(baseValidation),
        options,
      });
    }

    if (singleFrame && singleFrame.capability === "weather" && singleFrame.actionNeed === "none") {
      return executeResult({
        routeId: "task",
        mode: "direct-capability",
        reasonCode: "supported-external-readonly",
        parsedCommand,
        semanticEnvelope,
        semanticTelemetry,
        validation: createValidation(baseValidation),
        options,
      });
    }

    if (singleFrame
      && semanticEnvelope.conversationGoal.need === "none"
      && isControlWriteFrame(singleFrame)) {
      return executeResult({
        routeId: "vehicle-control",
        mode: "direct",
        reasonCode: "complete-vehicle-control",
        parsedCommand,
        semanticEnvelope,
        semanticTelemetry,
        validation: createValidation({
          ...baseValidation,
          admittedWriteFrameId: admittedWriteFrame?.frameId ?? null,
        }),
        options,
      });
    }

    if (semanticEnvelope.vehicleFrames.length === 0) {
      if (options.pending
        && clarificationTransition.action === "preserve"
        && clarificationTransition.reasonCode === "no-action-frame"
        && semanticEnvelope.domain === "vehicle"
        && semanticEnvelope.conversationGoal.need === "none") {
        return terminalResult({
          disposition: "clarify",
          reasonCode: "pending-clarification-continues",
          parsedCommand,
          semanticEnvelope,
          semanticTelemetry,
          executionDisabled: false,
          assistantResponse: options.pending.clarificationQuestion,
          validation: createValidation(baseValidation),
          options,
        });
      }
      if (semanticEnvelope.conversationGoal.need !== "none") {
        return executeResult({
          routeId: "chat",
          mode: "direct",
          reasonCode: "vehicle-conversation",
          parsedCommand,
          semanticEnvelope,
          semanticTelemetry,
          validation: createValidation(baseValidation),
          options,
        });
      }
      return terminalResult({
        disposition: "clarify",
        reasonCode: "empty-semantic-needs",
        parsedCommand,
        semanticEnvelope,
        semanticTelemetry,
        executionDisabled: false,
        assistantResponse: "请告诉我你希望了解或操作什么。",
        validation: createValidation(baseValidation),
        options,
      });
    }

    const assistantResponse = mixedBoundaryResponse(capabilityDeferredFrames, deferredWriteFrames);
    return executeResult({
      routeId: "task",
      mode: "orchestrated",
      reasonCode: "vehicle-multi-frame",
      parsedCommand,
      semanticEnvelope,
      semanticTelemetry,
      assistantResponse,
      validation: createValidation({
        ...baseValidation,
        admittedWriteFrameId: admittedWriteFrame?.frameId ?? null,
      }),
      options,
    });
  }
}

function normalizeClarificationEnvelope(envelope, missingSlotFrames, pending = null) {
  const missingByFrameId = new Map(
    missingSlotFrames.map((entry) => [entry.frameId, entry.missingRequiredSlots]),
  );
  return createVehicleSluEnvelope({
    ...envelope,
    vehicleFrames: envelope.vehicleFrames.map((frame) => {
      const missingSlots = missingByFrameId.get(frame.frameId);
      if (!missingSlots?.length) {
        return frame.actionNeed === "execute"
          ? { ...frame, actionNeed: "none" }
          : frame;
      }
      if (frame.intent === "seat.driver.setBackrestAngle") {
        return {
          ...frame,
          actionNeed: "clarify",
          missingSlots: [...missingSlots],
          clarificationQuestion: missingSlots.includes("seat")
            ? buildVehicleSluBoundaryResponse({ reasonCode: "missing-required-slots", missingSlots })
            : "主驾座椅靠背要调到多少度？",
        };
      }
      const existingQuestion = typeof frame.clarificationQuestion === "string"
        ? frame.clarificationQuestion.trim()
        : "";
      return {
        ...frame,
        actionNeed: "clarify",
        missingSlots: [...missingSlots],
        clarificationQuestion: existingQuestion || buildVehicleSluBoundaryResponse({
          reasonCode: "missing-required-slots",
          missingSlots,
        }),
      };
    }),
  });
}

function projectEffectiveClarificationEnvelope({ pending, envelope, transition }) {
  if (transition.action === "resolve"
    || (transition.action === "replace" && transition.resolvedFrame)) {
    return replaceActionFrame(envelope, transition.resolvedFrame);
  }
  if (transition.action === "merge") {
    return replaceActionFrame(envelope, buildPendingClarificationFrame({
      envelope,
      pending: transition.nextPending,
      fallbackPending: pending,
    }));
  }
  if (transition.action === "reject") {
    return replaceActionFrame(envelope, buildPendingClarificationFrame({
      envelope,
      pending,
      fallbackPending: pending,
    }));
  }
  return envelope;
}

function projectClarificationSlotProvenance({ pending, transition }) {
  if (transition.action === "resolve") {
    return Object.fromEntries(
      Object.keys(transition.resolvedFrame.slots).map((key) => [
        key,
        Object.hasOwn(pending?.acceptedSlots || {}, key)
          ? pending.slotProvenance?.[key] || "original-turn"
          : "clarification-turn",
      ]),
    );
  }
  if (transition.action === "replace" && transition.resolvedFrame) {
    return Object.fromEntries(
      Object.keys(transition.resolvedFrame.slots).map((key) => [key, "explicit"]),
    );
  }
  return null;
}

function replaceActionFrame(envelope, replacement) {
  if (!replacement) return envelope;
  const actionIndex = envelope.vehicleFrames.findIndex(
    (frame) => frame.actionNeed === "clarify" || frame.actionNeed === "execute",
  );
  if (actionIndex < 0) return envelope;
  return createVehicleSluEnvelope({
    ...envelope,
    vehicleFrames: envelope.vehicleFrames.map((frame, index) => (
      index === actionIndex ? replacement : frame
    )),
  });
}

function buildPendingClarificationFrame({ envelope, pending, fallbackPending }) {
  const actionFrame = envelope.vehicleFrames.find(
    (frame) => frame.actionNeed === "clarify" || frame.actionNeed === "execute",
  );
  if (!actionFrame || !pending) return actionFrame;
  return {
    ...actionFrame,
    intent: pending.intent,
    actionNeed: "clarify",
    slots: { ...pending.acceptedSlots },
    missingSlots: [...pending.missingSlots],
    clarificationQuestion: pending.clarificationQuestion
      || fallbackPending?.clarificationQuestion
      || actionFrame.clarificationQuestion,
  };
}

function validateCapabilityFrame(frame) {
  const authority = capabilityAuthority(frame);
  return {
    frameId: frame.frameId,
    capability: frame.capability,
    intent: frame.intent,
    status: authority ? "registered" : "deferred",
    authority: authority || "unsupported-capability",
  };
}

function capabilityAuthority(frame) {
  if (frame.capability === "control" && frame.intent === "safety.reject") {
    return "protected-boundary";
  }
  if (frame.capability === "control" && CONTROL_WRITE_INTENTS.has(frame.intent)) {
    if (frame.actionNeed === "execute") return "vehicle-control-write";
    if (frame.actionNeed === "clarify") return "vehicle-control-clarification";
    return "cabin-response";
  }
  if (frame.capability === "knowledge" && frame.intent === "vehicle.knowledge.query") {
    return "manual-rag-read";
  }
  if (frame.capability === "knowledge" && frame.intent === "vehicle.state.query") {
    return "vehicle-state-provider-read";
  }
  if (frame.capability === "weather" && frame.intent === "weather.query") {
    return "weather-adapter-read";
  }
  return "";
}

function validateSlotFrame(frame) {
  if (frame.capability !== "control"
    || !CONTROL_WRITE_INTENTS.has(frame.intent)
    || !["execute", "clarify"].includes(frame.actionNeed)) {
    return [];
  }
  return [{
    frameId: frame.frameId,
    intent: frame.intent,
    missingRequiredSlots: unique([
      ...getMissingVehicleSluRequiredSlots(frame.intent, frame.slots),
      ...frame.missingSlots,
    ]),
  }];
}

function createValidation(input) {
  const registeredFrameIds = input.capabilityFrames
    .filter((entry) => entry.status === "registered")
    .map(({ frameId }) => frameId);
  const deferredFrameIds = input.capabilityFrames
    .filter((entry) => entry.status === "deferred")
    .map(({ frameId }) => frameId);
  return deepFreeze({
    contractValidation: {
      ok: input.contractValidation.ok,
      errors: [...input.contractValidation.errors],
    },
    capabilityValidation: {
      ok: deferredFrameIds.length === 0,
      registeredFrameIds,
      deferredFrameIds,
      frames: input.capabilityFrames.map((entry) => ({ ...entry })),
    },
    slotValidation: {
      ok: input.slotFrames.every((entry) => entry.missingRequiredSlots.length === 0),
      auditedFrameIds: input.slotFrames.map(({ frameId }) => frameId),
      frames: input.slotFrames.map((entry) => ({
        ...entry,
        missingRequiredSlots: [...entry.missingRequiredSlots],
      })),
    },
    admittedWriteFrameId: input.admittedWriteFrameId,
    deferredWriteFrameIds: [...input.deferredWriteFrameIds],
  });
}

function emptyValidation(errors) {
  return createValidation({
    contractValidation: { ok: false, errors },
    capabilityFrames: [],
    slotFrames: [],
    admittedWriteFrameId: null,
    deferredWriteFrameIds: [],
  });
}

function mixedBoundaryResponse(capabilityDeferredFrames, deferredWriteFrames) {
  const responses = [];
  if (capabilityDeferredFrames.length > 0) {
    responses.push(buildVehicleSluBoundaryResponse({
      reasonCode: "unsupported-capability",
      capability: capabilityDeferredFrames[0].capability,
    }));
  }
  if (deferredWriteFrames.length > 0) {
    responses.push(buildVehicleSluBoundaryResponse({ reasonCode: "extra-write-frames-deferred" }));
  }
  return responses.join(" ");
}

function executeResult(input) {
  return routeResult({ ...input, disposition: "execute", executionDisabled: false });
}

function terminalResult(input) {
  return routeResult({ ...input, routeId: null, mode: null });
}

function routeResult(input) {
  const decision = createRouteDecision({
    disposition: input.disposition,
    routeId: input.routeId,
    mode: input.mode,
    confidence: input.parsedCommand.confidence,
    reasonCode: input.reasonCode,
    semanticSource: input.options.semanticSource || "model",
    normalizedIntentRef: intentRef(input.parsedCommand),
    runId: input.options.runId || input.options.requestId || input.parsedCommand.requestId,
  });
  const result = {
    decision,
    parsedCommand: input.parsedCommand,
    semanticEnvelope: input.semanticEnvelope,
    semanticTelemetry: input.semanticTelemetry,
    executionDisabled: input.executionDisabled,
    assistantResponse: String(input.assistantResponse || ""),
    validation: input.validation,
  };
  Object.defineProperty(result, "clarificationTransition", {
    value: input.options.clarificationTransition ?? null,
    enumerable: false,
  });
  return result;
}

function failClosedParsedCommand(requestId, reasonCode) {
  const normalizedRequestId = String(requestId || "");
  return deepFreeze({
    requestId: normalizedRequestId,
    rawText: "",
    source: "vehicle-slu-fail-closed",
    confidence: 0,
    intent: "conversation.general",
    speechAct: "statement",
    actionability: {
      actionable: false,
      reason: reasonCode,
      source: "vehicle-slu-fail-closed",
      intendedIntent: "conversation.general",
    },
    slots: {},
    slotProvenance: {},
    conversationGoal: {
      summary: "语义解析暂不可用",
      requiresReply: true,
      interactionType: "general_qa",
      domain: "general",
      goal: "语义解析暂不可用",
      source: "vehicle-slu-fail-closed",
    },
  });
}

function stableFailureReason(reasonCode) {
  const normalized = String(reasonCode || "");
  return SEMANTIC_FAILURE_REASONS.has(normalized) ? normalized : "semantic-contract-invalid";
}

function isControlWriteFrame(frame) {
  return frame.capability === "control"
    && frame.actionNeed === "execute"
    && CONTROL_WRITE_INTENTS.has(frame.intent);
}

function projectRuntimeCommand(envelope, projected, options = {}) {
  const writeFrame = options.forceNonActionable === true
    ? null
    : projected.executeFrames.find(isControlWriteFrame) ?? null;
  const primaryFrame = writeFrame
    ?? (options.forceNonActionable === true ? projected.clarifyFrames[0] : null)
    ?? projected.manualFrames[0]
    ?? envelope.vehicleFrames.find((frame) => frame.intent === "vehicle.state.query")
    ?? envelope.vehicleFrames.find((frame) => frame.intent === "weather.query")
    ?? envelope.vehicleFrames[0]
    ?? null;
  const actionable = Boolean(writeFrame);
  const slots = actionable ? structuredClone(writeFrame.slots) : projectReadonlySlots(primaryFrame);
  const interactionType = actionable ? "command"
    : primaryFrame?.knowledgeNeed === "manual" ? "explain"
      : primaryFrame?.speechAct === "question" ? "question" : "general_qa";
  const domain = primaryFrame?.knowledgeNeed === "manual" ? "vehicle_knowledge"
    : primaryFrame?.intent === "vehicle.state.query" ? "vehicle_knowledge"
      : primaryFrame?.intent === "weather.query" ? "weather"
        : actionable ? "vehicle_control" : "general";
  return deepFreeze({
    requestId: envelope.requestId,
    rawText: "",
    source: "vehicle-slu",
    confidence: primaryFrame?.confidence ?? envelope.domainConfidence,
    intent: actionable ? writeFrame.intent : "conversation.general",
    speechAct: primaryFrame?.speechAct ?? "social",
    actionability: {
      actionable,
      reason: actionable ? "vehicle-slu-execute" : routeProjectionReason(primaryFrame),
      source: "vehicle-slu",
      intendedIntent: actionable ? writeFrame.intent : "conversation.general",
    },
    slots,
    slotProvenance: actionable
      ? options.slotProvenance
        || Object.fromEntries(Object.keys(writeFrame.slots).map((key) => [key, "explicit"]))
      : {},
    ...(primaryFrame?.intent === "weather.query" ? {
      requiresExternalData: true,
      externalDataType: "weather",
    } : {}),
    conversationGoal: {
      summary: envelope.conversationGoal.summary,
      requiresReply: envelope.conversationGoal.need !== "none",
      interactionType,
      domain,
      goal: envelope.conversationGoal.summary,
      source: "vehicle-slu",
    },
  });
}

function projectReadonlySlots(frame) {
  if (!frame) return {};
  if (frame.knowledgeNeed === "manual") {
    return {
      topic: "vehicle_knowledge",
      query: frame.standaloneQuery,
      ...(frame.slots.vehicleModel ? { vehicleModel: frame.slots.vehicleModel } : {}),
    };
  }
  if (frame.intent === "vehicle.state.query") {
    return { topic: "vehicle_state", ...structuredClone(frame.slots) };
  }
  if (frame.intent === "weather.query") {
    return {
      topic: "weather_query",
      externalDataType: "weather",
      requiresExternalData: true,
      ...structuredClone(frame.slots),
    };
  }
  return {};
}

function routeProjectionReason(frame) {
  if (!frame) return "conversation-only";
  if (frame.knowledgeNeed === "manual") return "vehicle-knowledge-answer";
  if (frame.intent === "vehicle.state.query") return "vehicle-state-query";
  if (frame.intent === "weather.query") return "supported-external-readonly";
  if (frame.capability === "control") return frame.intent === "safety.reject"
    ? "protected-capability"
    : "vehicle-slu-control-answer";
  return "conversation-only";
}

function intentRef(command) {
  return { requestId: command.requestId, intent: command.intent };
}

function unique(items) {
  return [...new Set(items)];
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}
