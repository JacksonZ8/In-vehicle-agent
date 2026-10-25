// Shared guard: a Manual corpus registry must be a deeply frozen plain-data graph of the expected shape.

export function assertDeepFrozenManualCorpusRegistry(corpusRegistry) {
  if (!corpusRegistry || typeof corpusRegistry !== "object") {
    throw new TypeError("corpusRegistry.corpora is required");
  }
  if (!isDeepFrozenDataGraph(corpusRegistry) || !hasSafeRegistryShape(corpusRegistry)) {
    const error = new TypeError("corpusRegistry must be deeply frozen");
    error.code = "manual-corpus-registry-not-deep-frozen";
    throw error;
  }
}

function isDeepFrozenDataGraph(value, ancestors = new WeakSet()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (typeof value !== "object") return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return false;
    } else if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    if (!Object.isFrozen(value) || ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, "value")
        && isDeepFrozenDataGraph(descriptor.value, ancestors);
    });
    ancestors.delete(value);
    return valid;
  } catch {
    return false;
  }
}

function hasSafeRegistryShape(corpusRegistry) {
  const corporaDescriptor = ownDataProperty(corpusRegistry, "corpora");
  if (!corporaDescriptor || !plainDataObject(corporaDescriptor.value)) return false;
  return Object.values(corporaDescriptor.value).every((corpus) => {
    const sourceId = ownDataProperty(corpus, "sourceId");
    const artifacts = ownDataProperty(corpus, "artifacts");
    if (!plainDataObject(corpus) || !sourceId || !artifacts || !plainDataObject(artifacts.value)) {
      return false;
    }
    const sourceFields = ["sourceVersion", "contentDigest", "pagesPath", "pdfPath"];
    if (!sourceFields.every((field) => safeOwnDataPropertyOrAbsent(corpus, field))) return false;
    const isOperationalCorpus = sourceFields.some((field) => ownDataProperty(corpus, field));
    if (isOperationalCorpus && !sourceFields.every((field) => ownDataProperty(corpus, field))) {
      return false;
    }
    return ownDataProperty(artifacts.value, "chunksPath")
      && ["embeddingsPath", "path", "sha256"].every(
        (field) => safeOwnDataPropertyOrAbsent(artifacts.value, field),
      );
  });
}

function ownDataProperty(value, field) {
  if (!value || typeof value !== "object") return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor : null;
}

function safeOwnDataPropertyOrAbsent(value, field) {
  return Boolean(ownDataProperty(value, field)) || !(field in value);
}

export function plainDataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
