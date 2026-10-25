import { B2_MAX_PLAN_STEPS, validateGoalEnvelope, validateTaskPlanShape } from "./agent-contracts.js";
import { getCapability } from "./capability-catalog.js";
import {
  isTrustedKnowledgeGoal,
} from "./goal-authority.js";

export function validatePlanAgainstCatalog(plan, goal) {
  const errors = [
    ...validateGoalEnvelope(goal),
    ...validateTaskPlanShape(plan),
  ];
  if (!isRecord(plan) || !isRecord(goal)) return result(errors, null);

  if (plan.goalId !== goal.goalId) errors.push("plan goalId must match goal goalId");
  if (plan.runId !== goal.runId) errors.push("plan runId must match goal runId");
  if (!Array.isArray(plan.steps)) return result(errors, null);
  if (plan.steps.length > B2_MAX_PLAN_STEPS) errors.push(`plan must contain at most ${B2_MAX_PLAN_STEPS} steps`);

  const stepsById = new Map();
  for (const step of plan.steps) {
    if (!isRecord(step) || typeof step.stepId !== "string" || !step.stepId.trim()) continue;
    if (stepsById.has(step.stepId)) errors.push(`duplicate step identifier: ${step.stepId}`);
    else stepsById.set(step.stepId, step);
  }

  const capabilityByStepId = new Map();
  const capabilityIds = new Set();
  let writes = 0;
  for (const step of plan.steps) {
    if (!isRecord(step)) continue;
    const capability = getCapability(step.capabilityId);
    if (!capability) {
      errors.push(`unknown capability: ${String(step.capabilityId)}`);
      continue;
    }
    if (capabilityIds.has(capability.id)) errors.push(`duplicate capability identifier: ${capability.id}`);
    else capabilityIds.add(capability.id);
    capabilityByStepId.set(step.stepId, capability);
    if (step.accessMode !== capability.accessMode) errors.push(`access mode must match capability: ${capability.id}`);
    if (!capability.allowedDomains.includes(goal.domain)) errors.push(`capability is not allowed for domain: ${capability.id}`);
    validateInput(step.input, capability.inputSchema, capability.id, errors);
    if (capability.id === "manual.retrieve" && isTrustedKnowledgeGoal(goal)
      && step.input?.query !== goal.objective) {
      errors.push("manual.retrieve query must match trusted knowledge GoalEnvelope objective");
    }
    if (capability.accessMode === "write") writes += 1;
  }
  if (isTrustedKnowledgeGoal(goal)) {
    const soleStep = plan.steps.length === 1 ? plan.steps[0] : null;
    if (soleStep?.capabilityId !== "manual.retrieve"
      || soleStep?.accessMode !== "read"
      || writes !== 0) {
      errors.push("trusted knowledge goal requires exactly one manual.retrieve read step and zero writes");
    }
  }
  if (isReadOnlyGoal(goal) && goal.domain === "external-information") {
    const soleStep = plan.steps.length === 1 ? plan.steps[0] : null;
    if (soleStep?.capabilityId !== "external.query" || soleStep?.accessMode !== "read") {
      errors.push("read-only external-information goal requires exactly one external.query step");
    }
  }
  if (goal.interactionType === "command" && goal.domain === "vehicle-control" && writes !== 1) {
    errors.push("vehicle-control command requires exactly one write capability");
  }
  if (writes > 1) errors.push("plan must contain at most one write");
  if (isReadOnlyGoal(goal) && writes > 0) errors.push("read-only goal cannot contain write");
  if (plan.writeActionCount !== writes) errors.push("writeActionCount must match catalog write steps");

  const stepIndexes = new Map(plan.steps.map((step, index) => [step?.stepId, index]));
  for (const [stepId, step] of stepsById) {
    if (!Array.isArray(step.dependsOn)) continue;
    for (const dependencyId of step.dependsOn) {
      if (!stepsById.has(dependencyId)) errors.push(`unknown dependency: ${stepId} -> ${dependencyId}`);
      else if (stepIndexes.get(dependencyId) >= stepIndexes.get(stepId)) {
        errors.push(`dependency must reference an earlier step: ${stepId} -> ${dependencyId}`);
      }
    }
  }
  if (hasCycle(stepsById)) errors.push("cyclic dependency");

  for (const [stepId, capability] of capabilityByStepId) {
    const externalCommandRequiresSafety = capability.id === "external.query"
      && goal.interactionType === "command";
    if ((capability.requiresSafety || externalCommandRequiresSafety)
      && !hasEarlierSafetyDependency(stepId, stepsById, capabilityByStepId, plan.steps)) {
      errors.push(externalCommandRequiresSafety
        ? "external.query requires safety.evaluate for command goal"
        : `capability ${capability.id} requires safety.evaluate`);
    }
    if (capability.id === "vehicle.tailgate.set"
      && !hasEarlierCapabilityDependency(
        stepId,
        "confirmation.issue",
        stepsById,
        capabilityByStepId,
        plan.steps,
      )) {
      errors.push("vehicle.tailgate.set requires confirmation.issue");
    }
  }

  const selected = Array.isArray(plan.selectedCapabilities) ? plan.selectedCapabilities : [];
  const actual = plan.steps.map((step) => step?.capabilityId);
  if (selected.length !== actual.length || selected.some((id, index) => id !== actual[index])) {
    errors.push("selectedCapabilities must match plan steps");
  }
  return result(errors, errors.length === 0 ? plan : null);
}

function result(errors, plan) {
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), plan });
}

function hasEarlierSafetyDependency(stepId, stepsById, capabilityByStepId, steps) {
  return hasEarlierCapabilityDependency(
    stepId,
    "safety.evaluate",
    stepsById,
    capabilityByStepId,
    steps,
  );
}

function hasEarlierCapabilityDependency(
  stepId,
  requiredCapabilityId,
  stepsById,
  capabilityByStepId,
  steps,
) {
  const stepIndexes = new Map(steps.map((step, index) => [step?.stepId, index]));
  const visit = (id, seen = new Set()) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const step = stepsById.get(id);
    if (!step) return false;
    for (const dependencyId of step.dependsOn ?? []) {
      const dependency = capabilityByStepId.get(dependencyId);
      if (dependency?.id === requiredCapabilityId
        && stepIndexes.get(dependencyId) < stepIndexes.get(stepId)) return true;
      if (visit(dependencyId, seen)) return true;
    }
    return false;
  };
  return visit(stepId);
}

function hasCycle(stepsById) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = stepsById.get(id);
    for (const dependencyId of step?.dependsOn ?? []) {
      if (stepsById.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...stepsById.keys()].some(visit);
}

function validateInput(input, schema, capabilityId, errors) {
  validateSchema(input, schema, "input", capabilityId, errors);
}

function validateSchema(value, schema, path, capabilityId, errors) {
  if (schema.type === "object") {
    if (!isRecord(value)) {
      errors.push(`capability input field ${path} must be object: ${capabilityId}`);
      return;
    }
    for (const field of schema.required ?? []) {
      if (!Object.hasOwn(value, field)) errors.push(`capability input requires ${path}.${field}: ${capabilityId}`);
    }
    for (const [field, nestedValue] of Object.entries(value)) {
      const nestedSchema = schema.properties?.[field];
      if (!nestedSchema && schema.additionalProperties === false) {
        errors.push(`capability input has unknown field ${path}.${field}: ${capabilityId}`);
      } else if (nestedSchema) {
        validateSchema(nestedValue, nestedSchema, `${path}.${field}`, capabilityId, errors);
      }
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`capability input field ${path} must be array: ${capabilityId}`);
      return;
    }
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, capabilityId, errors));
    return;
  }
  if (!matchesPrimitive(value, schema.type)) {
    errors.push(`capability input field ${path} must be ${schema.type}: ${capabilityId}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`capability input field ${path} must be one of ${schema.enum.join("|")}: ${capabilityId}`);
  }
  if ((schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum)) {
    errors.push(`capability input field ${path} is out of range: ${capabilityId}`);
  }
}

function matchesPrimitive(value, type) {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function isReadOnlyGoal(goal) {
  return goal.interactionType !== "command";
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
