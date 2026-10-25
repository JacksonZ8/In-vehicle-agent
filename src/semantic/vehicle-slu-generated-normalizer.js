export function normalizeVehicleSluGeneratedEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray(value.vehicleFrames)) return value;

  return {
    ...value,
    vehicleFrames: value.vehicleFrames.map((frame) => {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return frame;
      let normalized = frame;
      if (frame.actionNeed !== "clarify" && frame.clarificationQuestion !== null) {
        normalized = { ...normalized, clarificationQuestion: null };
      }
      if (frame.actionNeed === "none"
        && Array.isArray(frame.missingSlots)
        && frame.missingSlots.length > 0) {
        normalized = { ...normalized, missingSlots: [] };
      }
      if (frame.knowledgeNeed !== "manual" && frame.standaloneQuery !== null) {
        normalized = { ...normalized, standaloneQuery: null };
      }
      return normalized;
    }),
  };
}
