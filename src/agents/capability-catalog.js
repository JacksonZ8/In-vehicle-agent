const definitions = [
  ["manual.retrieve", "Manual RAG", "manualRetriever", "read", false, ["vehicle-control", "manual", "external-information", "vehicle-multi-read"], { query: "string" }],
  ["memory.read", "Conversation Memory", "conversationMemory", "read", false, ["vehicle-control", "manual", "external-information"], { scope: "string" }],
  ["external.query", "External Data Interface", "toolRag", "read", false, ["external-information", "vehicle-multi-read"], { query: "string" }],
  ["vehicle-state-provider.read", "Vehicle State Provider", "vehicleStateProvider", "read", false, ["vehicle-state", "vehicle-control", "vehicle-multi-read"], {
    stateFields: arraySchema("string"),
  }],
  ["safety.evaluate", "Safety Gateway", "safety", "read", false, ["vehicle-control", "external-information", "manual"], { action: "string" }],
  ["confirmation.issue", "Confirmation Challenge", "confirmation", "read", true, ["vehicle-control"], { action: "string" }],
  ["vehicle.window.set-position", "Window Position", "vehicleApi", "write", true, ["vehicle-control"], { zone: "string", percent: "number" }],
  ["vehicle.seat.set-backrest", "Seat Backrest", "vehicleApi", "write", true, ["vehicle-control"], { zone: "string", angle: "number" }],
  ["vehicle.seat.set-comfort", "Seat Comfort", "vehicleApi", "write", true, ["vehicle-control"], {
    seatZone: "string", seatMode: { type: "string", enum: ["heat", "ventilation"] }, level: { type: "number", minimum: 0, maximum: 3 },
  }],
  ["vehicle.climate.set", "Climate", "vehicleApi", "write", true, ["vehicle-control"], {
    temperature: { type: "number", minimum: 15, maximum: 31 },
    temperatureDelta: { type: "number", minimum: -16, maximum: 16 },
    climatePower: "boolean",
    climateMode: { type: "string", enum: ["auto", "cooling", "heating", "ventilation"] },
    fanLevel: { type: "number", minimum: 0, maximum: 8 },
    airflow: "string",
    passengerMode: "string",
  }, []],
  ["vehicle.cabin.apply-settings", "Cabin Settings", "vehicleApi", "write", true, ["vehicle-control"], {
    windowTargets: arraySchema(objectSchema({ zone: "string", percent: { type: "number", minimum: 0, maximum: 100 } })),
    temperature: { type: "number", minimum: 15, maximum: 31 },
    temperatureDelta: { type: "number", minimum: -16, maximum: 16 },
    climatePower: "boolean",
    climateMode: { type: "string", enum: ["auto", "cooling", "heating", "ventilation"] },
    fanLevel: { type: "number", minimum: 0, maximum: 8 },
  }, []],
  ["vehicle.tailgate.set", "Tailgate", "vehicleApi", "write", true, ["vehicle-control"], { state: "string" }],
  ["vehicle.component.set-state", "ES7 Component State", "vehicleApi", "write", true, ["vehicle-control"], { actionId: "string", value: "number" }],
  ["response.synthesize", "Response Synthesis", "cabinAssistant", "read", false, ["vehicle-control", "manual", "external-information"], {
    facts: objectSchema({ summary: "string", evidenceRefs: arraySchema("string") }),
  }],
];

export const B2_CAPABILITY_CATALOG = deepFreeze(definitions.map(([
  id, label, ownerParticipantId, accessMode, requiresSafety, allowedDomains, properties, required,
]) => ({
  id,
  label,
  ownerParticipantId,
  inputSchema: schema(properties, required),
  outputSchema: schema({ status: "string" }),
  accessMode,
  sideEffect: accessMode === "write" ? "vehicle-state-change" : "none",
  requiresSafety,
  timeoutMs: accessMode === "write" ? 5000 : 3000,
  allowedDomains,
  degradationPolicy: requiresSafety ? "fail-closed" : "respond-with-available-evidence",
})));

export function getCapability(id) {
  if (typeof id !== "string") return null;
  return B2_CAPABILITY_CATALOG.find((capability) => capability.id === id) ?? null;
}

export function getCapabilityCatalogProjection() {
  return deepFreeze(B2_CAPABILITY_CATALOG.map((capability) => ({
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

function schema(properties, required = Object.keys(properties)) {
  return {
    type: "object",
    required,
    properties: Object.fromEntries(Object.entries(properties).map(([key, definition]) => [key, normalizeSchema(definition)])),
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
