export const PARTICIPANT_TYPES = Object.freeze({
  AI_AGENT: "ai-agent",
  MODEL_SERVICE: "model-service",
  DETERMINISTIC_SERVICE: "deterministic-service",
  TOOL_INTERFACE: "tool-interface",
  PRESENTATION: "presentation",
});

export const AI_AGENT_COMPONENT_IDS = Object.freeze([
  "cabinAssistant",
  "orchestrator",
]);

const entries = [
  ["cabinAssistant", "Cabin Assistant", PARTICIPANT_TYPES.AI_AGENT],
  ["orchestrator", "Orchestrator", PARTICIPANT_TYPES.AI_AGENT],
  ["vehicleSluModel", "Vehicle SLU Model", PARTICIPANT_TYPES.MODEL_SERVICE],
  ["cabinModel", "Cabin Model", PARTICIPANT_TYPES.MODEL_SERVICE],
  ["orchestratorModel", "Orchestrator Model", PARTICIPANT_TYPES.MODEL_SERVICE],
  ["ragEmbeddingModel", "RAG Embedding Model", PARTICIPANT_TYPES.MODEL_SERVICE],
  ["ragRerankModel", "RAG Rerank Model", PARTICIPANT_TYPES.MODEL_SERVICE],
  ["runtimeKernel", "Runtime Kernel", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["manualQueryPlanner", "Manual Query Planner", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["manualRetriever", "Manual RAG Retriever", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["conversationMemory", "Conversation Memory", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["safety", "Safety Gateway", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["vehicleStateProvider", "Sensor / Vehicle State Provider", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["confirmation", "Confirmation Challenge", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["voiceBridgeEligibility", "Voice Bridge Policy", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["wakeWordProvider", "Browser Transcript Wake Gate", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["interactionSession", "Interaction Session", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["recoveryPolicy", "Recovery Policy", PARTICIPANT_TYPES.DETERMINISTIC_SERVICE],
  ["vehicleTool", "Vehicle Tool Interface", PARTICIPANT_TYPES.TOOL_INTERFACE],
  ["externalDataAdapter", "External Data Adapter", PARTICIPANT_TYPES.TOOL_INTERFACE],
  ["responsePresentation", "Response Presentation", PARTICIPANT_TYPES.PRESENTATION],
];

export const PARTICIPANT_REGISTRY = Object.freeze(Object.fromEntries(
  entries.map(([id, label, type]) => [id, Object.freeze({ id, label, type })]),
));

export function getParticipant(id) {
  return PARTICIPANT_REGISTRY[String(id || "")] || null;
}

export function requireParticipant(id) {
  const participant = getParticipant(id);
  if (!participant) throw new TypeError(`unregistered component: ${id}`);
  return participant;
}
