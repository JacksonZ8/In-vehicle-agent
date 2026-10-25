import { createGoalEnvelope } from "../agents/agent-contracts.js";
import { createVehicleSluEnvelope } from "./vehicle-slu-contract.js";
import { projectVehicleSluEnvelope } from "./vehicle-slu-projector.js";
import { VEHICLE_WRITE_CAPABILITIES } from "../vehicle/vehicle-write-capabilities.js";

const CAPABILITY_BY_INTENT = Object.freeze({
  ...Object.fromEntries(Object.values(VEHICLE_WRITE_CAPABILITIES)
    .map(({ intent, capabilityId }) => [intent, capabilityId])),
  "vehicle.knowledge.query": "manual.retrieve",
  "vehicle.state.query": "vehicle-state-provider.read",
  "weather.query": "external.query",
});
export const VEHICLE_SLU_MULTI_READ_DOMAIN = "vehicle-multi-read";

export const VEHICLE_SLU_RESPONSE_PLAN_INPUT = deepFreeze({
  facts: {
    summary: "Use only completed execution facts.",
    evidenceRefs: [],
  },
});

export function createVehicleSluGoalEnvelope(envelope) {
  const projected = projectVehicleSluEnvelope(envelope);
  const admittedWriteFrame = findAdmittedWriteFrame(projected.executeFrames);
  const readonlyFrames = findRoutableReadonlyFrames(projected.vehicleFrames);
  const multiRead = !admittedWriteFrame && hasDifferentReadonlyCapabilities(readonlyFrames);
  const authorityFrame = admittedWriteFrame
    ?? projected.manualFrames[0]
    ?? readonlyFrames.find((frame) => frame.intent === "weather.query")
    ?? readonlyFrames[0];
  if (!authorityFrame) throw new TypeError("Vehicle-SLU orchestration requires one registered frame");

  const write = authorityFrame === admittedWriteFrame;
  const knowledge = authorityFrame.intent === "vehicle.knowledge.query";
  const state = authorityFrame.intent === "vehicle.state.query";
  const weather = authorityFrame.intent === "weather.query";
  const objective = multiRead ? createVehicleSluMultiReadQuery(readonlyFrames)
    : knowledge ? authorityFrame.standaloneQuery
      : state ? createVehicleSluStateQuery(authorityFrame)
        : weather ? createVehicleSluWeatherQuery(authorityFrame)
          : envelope.conversationGoal.summary || authorityFrame.intent;
  const contextRefs = multiRead ? readonlyFrames.map(createFrameAuthorityContext)
    : knowledge ? [{
      type: "trusted-conversation-goal",
      source: "vehicle-slu-knowledge-frame",
      interactionType: "question",
      semanticDomain: "vehicle_knowledge",
      goalDomain: "manual",
      eligibilityAction: authorityFrame.slots.eligibilityAction === "body.tailgate.open"
        ? "body.tailgate.open"
        : null,
    }]
      : [createFrameAuthorityContext(authorityFrame)];
  return createGoalEnvelope({
    goalId: `goal:${envelope.requestId}`,
    runId: envelope.requestId,
    objective,
    interactionType: write ? "command" : "question",
    domain: multiRead ? VEHICLE_SLU_MULTI_READ_DOMAIN
      : write ? "vehicle-control"
        : state ? "vehicle-state"
          : weather ? "external-information" : "manual",
    constraints: [],
    contextRefs,
    requiredClarifications: [],
    readyForPlanning: true,
    model: "vehicle-slu",
    provider: "runtime-kernel",
    confidenceStrength: authorityFrame.confidence >= 0.8 ? "strong" : "weak",
  });
}

export function createVehicleSluMultiReadQuery(frames) {
  if (!Array.isArray(frames) || !hasDifferentReadonlyCapabilities(frames)) {
    throw new TypeError("vehicle multi-read requires different supported readonly frame types");
  }
  return JSON.stringify({
    intent: "vehicle.multi-read",
    frames: frames.map((frame) => ({
      frameId: frame.frameId,
      intent: frame.intent,
      slots: structuredClone(frame.slots),
    })),
  });
}

export function createVehicleSluWeatherQuery(frame) {
  if (!frame || frame.intent !== "weather.query" || !frame.slots
    || typeof frame.slots !== "object" || Array.isArray(frame.slots)) {
    throw new TypeError("weather.query frame requires slots");
  }
  const query = { intent: "weather.query" };
  for (const slot of ["location", "timeRange"]) {
    if (!Object.hasOwn(frame.slots, slot)) continue;
    const value = frame.slots[slot];
    if (typeof value === "string" && value.trim()) query[slot] = value.trim();
  }
  return JSON.stringify(query);
}

export function createVehicleSluStateQuery(frame) {
  if (!frame || frame.intent !== "vehicle.state.query" || !Array.isArray(frame.slots?.stateFields)) {
    throw new TypeError("vehicle.state.query frame requires stateFields");
  }
  return JSON.stringify({
    intent: "vehicle.state.query",
    stateFields: [...frame.slots.stateFields],
  });
}

export function projectVehicleSluReadonlyStepInput(frame) {
  if (frame?.intent === "vehicle.knowledge.query") {
    return { query: frame.slots.query };
  }
  if (frame?.intent === "weather.query") {
    return { query: createVehicleSluWeatherQuery(frame) };
  }
  if (frame?.intent === "vehicle.state.query") {
    return { stateFields: [...frame.slots.stateFields] };
  }
  return null;
}

export function createVehicleSluReadonlyStepScope({
  semanticEnvelope,
  semanticAuthority,
  step,
} = {}) {
  const envelope = createVehicleSluEnvelope(semanticEnvelope);
  const expectedAuthority = createVehicleSluPlanAuthority(envelope);
  if (!plainDataEqual(semanticAuthority, expectedAuthority)
    || !step || typeof step !== "object" || Array.isArray(step)
    || !Array.isArray(step.dependsOn) || step.dependsOn.length !== 0) {
    throw new TypeError("readonly step must exactly match one non-deferred Vehicle-SLU frame");
  }
  const deferred = new Set(expectedAuthority.deferredFrameIds);
  const matches = envelope.vehicleFrames.filter((frame) => (
    frame.actionNeed === "none"
    && frame.capability !== "control"
    && !deferred.has(frame.frameId)
    && expectedAuthority.allowedFrameIds.includes(frame.frameId)
    && CAPABILITY_BY_INTENT[frame.intent] === step.capabilityId
    && plainDataEqual(projectVehicleSluReadonlyStepInput(frame), step.input)
  ));
  if (matches.length !== 1) {
    throw new TypeError("readonly step must exactly match one non-deferred Vehicle-SLU frame");
  }
  const scopedEnvelope = createVehicleSluEnvelope({
    ...envelope,
    vehicleFrames: [matches[0]],
  });
  return deepFreeze({
    frame: scopedEnvelope.vehicleFrames[0],
    semanticEnvelope: scopedEnvelope,
  });
}

export function createVehicleSluWeatherStepAuthority(input = {}) {
  const scoped = createVehicleSluReadonlyStepScope(input);
  if (scoped.frame.intent !== "weather.query") {
    throw new TypeError("weather step must exactly match one weather.query frame");
  }
  const args = {
    topic: "weather_query",
    externalDataType: "weather",
    query: createVehicleSluWeatherQuery(scoped.frame),
  };
  for (const field of ["location", "timeRange"]) {
    if (typeof scoped.frame.slots[field] === "string" && scoped.frame.slots[field].trim()) {
      args[field] = scoped.frame.slots[field].trim();
    }
  }
  return deepFreeze({
    frame: scoped.frame,
    tool: "conversation.general",
    args,
  });
}

export function createVehicleSluPlanAuthority(envelope) {
  const projected = projectVehicleSluEnvelope(envelope);
  const admittedWriteFrame = findAdmittedWriteFrame(projected.executeFrames);
  const executableFrames = [
    admittedWriteFrame,
    ...findRoutableReadonlyFrames(projected.vehicleFrames),
  ].filter(Boolean);
  const executableFrameIds = new Set(executableFrames.map(({ frameId }) => frameId));
  const deferredFrames = envelope.vehicleFrames.filter(({ frameId }) => !executableFrameIds.has(frameId));
  return deepFreeze({
    contractVersion: envelope.contractVersion,
    requestId: envelope.requestId,
    allowedFrameIds: envelope.vehicleFrames.map(({ frameId }) => frameId),
    allowedCapabilityIds: unique(executableFrames.flatMap(projectFrameCapabilityIds)),
    admittedWriteFrameId: admittedWriteFrame?.frameId ?? null,
    deferredFrameIds: deferredFrames.map(({ frameId }) => frameId),
  });
}

function findAdmittedWriteFrame(executeFrames) {
  return executeFrames.find(isRegisteredControlWrite) ?? null;
}

function isRegisteredControlWrite(frame) {
  return frame.capability === "control"
    && frame.actionNeed === "execute"
    && Object.hasOwn(CAPABILITY_BY_INTENT, frame.intent);
}

function findRoutableReadonlyFrames(frames) {
  return frames.filter((frame) => frame.actionNeed === "none"
    && frame.capability !== "control"
    && Object.hasOwn(CAPABILITY_BY_INTENT, frame.intent));
}

function hasDifferentReadonlyCapabilities(frames) {
  return new Set(frames.map((frame) => CAPABILITY_BY_INTENT[frame.intent]).filter(Boolean)).size >= 2;
}

function createFrameAuthorityContext(frame) {
  return {
    type: "vehicle-slu-frame-authority",
    frameId: frame.frameId,
    capability: frame.capability,
    intent: frame.intent,
    speechAct: frame.speechAct,
    knowledgeNeed: frame.knowledgeNeed,
    actionNeed: frame.actionNeed,
    slots: structuredClone(frame.slots),
  };
}

function projectFrameCapabilityIds(frame) {
  const capabilityId = CAPABILITY_BY_INTENT[frame.intent];
  if (!capabilityId) return [];
  if (frame.capability !== "control") return [capabilityId];
  return [
    "safety.evaluate",
    ...(frame.intent === "body.tailgate.open" ? ["confirmation.issue"] : []),
    capabilityId,
    "response.synthesize",
  ];
}

function unique(values) {
  return [...new Set(values)];
}

function plainDataEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => plainDataEqual(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && plainDataEqual(left[key], right[key]));
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
