import { validateVehicleSluEnvelope } from "./vehicle-slu-contract.js";

export function projectVehicleSluEnvelope(envelope) {
  const validation = validateVehicleSluEnvelope(envelope);
  if (!validation.ok) throw new TypeError(`invalid Vehicle-SLU envelope: ${validation.errors.join("; ")}`);

  const conversationGoal = structuredClone(envelope.conversationGoal);
  const vehicleFrames = structuredClone(envelope.vehicleFrames);
  const manualFrames = vehicleFrames.filter((frame) => frame.knowledgeNeed === "manual");
  const executeFrames = vehicleFrames.filter((frame) => frame.actionNeed === "execute");
  const clarifyFrames = vehicleFrames.filter((frame) => frame.actionNeed === "clarify");

  return deepFreeze({
    requestId: envelope.requestId,
    domain: envelope.domain,
    domainConfidence: envelope.domainConfidence,
    conversationGoal,
    vehicleFrames,
    manualFrames,
    executeFrames,
    clarifyFrames,
    needs: Object.freeze({
      manual: manualFrames.length > 0,
      execute: executeFrames.length > 0,
      clarify: clarifyFrames.length > 0,
    }),
  });
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}
