const definitions = [
  [
    "knowledge.manual.retrieve",
    "ES8 Manual Evidence",
    "manualRetriever",
    { query: "string" },
    "respond-with-available-evidence",
  ],
  [
    "knowledge.vehicle-state.read",
    "VehicleState Provider Read",
    "vehicleStateProvider",
    { scope: "string" },
    "fail-closed",
  ],
  [
    "knowledge.safety.evaluate",
    "Safety Read-only Evaluation",
    "safety",
    { action: { type: "string", const: "body.tailgate.open" } },
    "fail-closed",
  ],
  [
    "knowledge.answer.synthesize",
    "Knowledge Answer Synthesis",
    "cabinAssistant",
    { facts: objectSchema({ summary: "string", evidenceRefs: arraySchema("string") }) },
    "respond-with-available-evidence",
  ],
];

export const KNOWLEDGE_CAPABILITY_CATALOG = deepFreeze(definitions.map(([
  id,
  label,
  ownerParticipantId,
  properties,
  degradationPolicy,
]) => ({
  id,
  label,
  ownerParticipantId,
  inputSchema: schema(properties),
  outputSchema: schema({ status: "string" }),
  accessMode: "read",
  sideEffect: "none",
  requiresSafety: false,
  allowedDomains: ["vehicle-control", "manual"],
  timeoutMs: 3_000,
  degradationPolicy,
})));

export function getKnowledgeCapability(id) {
  if (typeof id !== "string") return null;
  return KNOWLEDGE_CAPABILITY_CATALOG.find((capability) => capability.id === id) ?? null;
}

export function getKnowledgeCapabilityCatalogProjection() {
  return deepFreeze(KNOWLEDGE_CAPABILITY_CATALOG.map((capability) => ({
    id: capability.id,
    label: capability.label,
    inputSchema: clone(capability.inputSchema),
    outputSchema: clone(capability.outputSchema),
    accessMode: capability.accessMode,
    requiresSafety: capability.requiresSafety,
    allowedDomains: [...capability.allowedDomains],
    degradationPolicy: capability.degradationPolicy,
  })));
}

function schema(properties) {
  return {
    type: "object",
    required: Object.keys(properties),
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, definition]) => [key, normalizeSchema(definition)]),
    ),
    additionalProperties: false,
  };
}

function objectSchema(properties) {
  return schema(properties);
}

function arraySchema(itemType) {
  return { type: "array", items: normalizeSchema(itemType) };
}

function normalizeSchema(definition) {
  return typeof definition === "string" ? { type: definition } : definition;
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
