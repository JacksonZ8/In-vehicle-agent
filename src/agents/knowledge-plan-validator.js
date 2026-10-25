import { getKnowledgeCapability } from "./knowledge-capability-catalog.js";

export const KNOWLEDGE_ELIGIBILITY_TOPOLOGY = Object.freeze([
  Object.freeze({
    capabilityId: "knowledge.manual.retrieve",
    stepId: "manual",
    dependsOn: Object.freeze([]),
    input: Object.freeze({ query: "ES8 尾门 开启 安全" }),
  }),
  Object.freeze({
    capabilityId: "knowledge.vehicle-state.read",
    stepId: "vehicle-state",
    dependsOn: Object.freeze(["manual"]),
    input: Object.freeze({ scope: "tailgate" }),
  }),
  Object.freeze({
    capabilityId: "knowledge.safety.evaluate",
    stepId: "safety",
    dependsOn: Object.freeze(["vehicle-state"]),
    input: Object.freeze({ action: "body.tailgate.open" }),
  }),
  Object.freeze({ capabilityId: "knowledge.answer.synthesize", stepId: "answer", dependsOn: Object.freeze(["manual", "safety"]) }),
]);

export function validateKnowledgeDelegationAgainstParent(delegation, parentPlan) {
  const errors = [];
  if (!isRecord(delegation)) errors.push("delegation must be an object");
  if (!isRecord(parentPlan)) errors.push("parent plan must be an object");
  if (errors.length) return delegationResult(errors, null);

  if (delegation.runId !== parentPlan.runId) {
    errors.push("delegation runId must match parent plan runId");
  }
  if (delegation.parentPlanId !== parentPlan.planId) {
    errors.push("delegation parent plan association must match parent planId");
  }
  if (delegation.vehicleScope !== "nio-es8-user-manual-2026") {
    errors.push("delegation vehicleScope must be nio-es8-user-manual-2026");
  }

  const parentSteps = new Map();
  for (const step of parentPlan.steps ?? []) {
    if (!isRecord(step) || typeof step.stepId !== "string" || !step.stepId.trim()) continue;
    if (parentSteps.has(step.stepId)) errors.push(`duplicate parent step identifier: ${step.stepId}`);
    else parentSteps.set(step.stepId, step);
  }
  const parentStep = parentSteps.get(delegation.parentStepId);
  if (!parentStep) {
    errors.push("delegation parent step association is unknown");
    return delegationResult(errors, null);
  }
  if (parentStep.capabilityId !== "manual.retrieve") {
    errors.push("delegation parent step must use manual.retrieve");
  }
  if (parentStep.accessMode !== "read") errors.push("delegation parent step must be read-only");
  if (!sameStrings(delegation.dependsOn, parentStep.dependsOn)) {
    errors.push("delegation parent dependency association must match parent step");
  }
  if (!isRecord(parentStep.input) || parentStep.input.query !== delegation.knowledgeGoal) {
    errors.push("delegation parent input query must match knowledgeGoal");
  }
  return delegationResult(errors, errors.length === 0 ? delegation : null);
}

export function validateKnowledgeSubplan(subplan, delegation) {
  const errors = [];
  if (!isRecord(subplan)) errors.push("knowledge subplan must be an object");
  if (!isRecord(delegation)) errors.push("knowledge delegation must be an object");
  if (errors.length) return result(errors, null);

  for (const field of ["delegationId", "runId", "parentPlanId", "parentStepId"]) {
    if (subplan[field] !== delegation[field]) {
      errors.push(`knowledge subplan ${field} must match delegation association`);
    }
  }
  if (!Array.isArray(subplan.steps)) {
    errors.push("knowledge subplan steps must be an array");
    return result(errors, null);
  }

  const stepById = new Map();
  const stepIndexes = new Map();
  for (const [index, step] of subplan.steps.entries()) {
    if (!isRecord(step) || typeof step.stepId !== "string" || !step.stepId.trim()) {
      errors.push(`knowledge subplan step ${index} must identify a stepId`);
      continue;
    }
    if (stepById.has(step.stepId)) errors.push(`duplicate step identifier: ${step.stepId}`);
    else {
      stepById.set(step.stepId, step);
      stepIndexes.set(step.stepId, index);
    }
  }

  const capabilityByStepId = new Map();
  const capabilityIds = new Set();
  for (const step of subplan.steps) {
    if (!isRecord(step)) continue;
    const capability = getKnowledgeCapability(step.capabilityId);
    if (!capability) {
      errors.push(`unknown capability: ${String(step.capabilityId)}`);
      continue;
    }
    if (capabilityIds.has(capability.id)) errors.push(`duplicate capability identifier: ${capability.id}`);
    else capabilityIds.add(capability.id);
    capabilityByStepId.set(step.stepId, capability);
    if (step.accessMode !== "read" || capability.accessMode !== "read") {
      errors.push(`knowledge subplan must be read-only: ${capability.id}`);
    }
    if (step.accessMode !== capability.accessMode) {
      errors.push(`access mode must match capability: ${capability.id}`);
    }
    if (!Array.isArray(delegation.allowedCapabilities)
      || !delegation.allowedCapabilities.includes(capability.id)) {
      errors.push(`capability is not authorized by delegation: ${capability.id}`);
    }
    if (capability.id === "knowledge.vehicle-state.read" && !delegation.allowVehicleStateRead) {
      errors.push("knowledge.vehicle-state.read requires allowVehicleStateRead");
    }
    validateSchema(step.input, capability.inputSchema, "input", capability.id, errors);
  }

  const selected = Array.isArray(subplan.selectedCapabilities) ? subplan.selectedCapabilities : [];
  const actual = subplan.steps.map((step) => step?.capabilityId);
  if (selected.length !== actual.length || selected.some((id, index) => id !== actual[index])) {
    errors.push("selectedCapabilities must match knowledge subplan steps");
  }

  for (const [stepId, step] of stepById) {
    if (!Array.isArray(step.dependsOn)) {
      errors.push(`knowledge subplan ${stepId} dependsOn must be an array`);
      continue;
    }
    for (const dependencyId of step.dependsOn) {
      if (!stepById.has(dependencyId)) {
        errors.push(`unknown dependency: ${stepId} -> ${String(dependencyId)}`);
      } else if (stepIndexes.get(dependencyId) >= stepIndexes.get(stepId)) {
        errors.push(`dependency must reference an earlier step: ${stepId} -> ${dependencyId}`);
      }
    }
  }
  if (hasCycle(stepById)) errors.push("cyclic dependency");

  const hasCapability = (capabilityId) => capabilityIds.has(capabilityId);
  const completeEligibilityPlan = delegation.allowVehicleStateRead
    && delegation.requireSafetyEligibilityExplanation;
  if (completeEligibilityPlan) {
    if (subplan.steps.length !== KNOWLEDGE_ELIGIBILITY_TOPOLOGY.length) {
      errors.push("eligibility delegation requires exactly four canonical steps");
    }
    for (const [index, topology] of KNOWLEDGE_ELIGIBILITY_TOPOLOGY.entries()) {
      const step = subplan.steps[index];
      if (step?.capabilityId !== topology.capabilityId) {
        errors.push(`eligibility step ${index} requires ${topology.capabilityId}`);
      }
      if (step?.stepId !== topology.stepId) {
        errors.push(`eligibility step ${index} requires stepId ${topology.stepId}`);
      }
      if (!sameStrings(step?.dependsOn, topology.dependsOn)) {
        errors.push(`eligibility step ${topology.stepId} requires canonical direct dependencies`);
      }
      if (topology.input && !plainDataEqual(step?.input, topology.input)) {
        errors.push(`eligibility step ${topology.stepId} requires canonical input`);
      }
    }
  }
  if (delegation.requireSafetyEligibilityExplanation && !hasCapability("knowledge.safety.evaluate")) {
    errors.push("delegation requires knowledge.safety.evaluate");
  }
  if (!hasCapability("knowledge.answer.synthesize")) {
    errors.push("knowledge subplan requires knowledge.answer.synthesize");
  }
  for (const [stepId, capability] of capabilityByStepId) {
    if (capability.id === "knowledge.vehicle-state.read"
      && completeEligibilityPlan
      && !hasEarlierAncestorCapability(
        stepId,
        ["knowledge.manual.retrieve"],
        stepById,
        capabilityByStepId,
        stepIndexes,
      )) {
      errors.push("knowledge.vehicle-state.read requires knowledge.manual.retrieve");
    }
    if (capability.id === "knowledge.safety.evaluate"
      && !hasEarlierAncestorCapability(
        stepId,
        ["knowledge.vehicle-state.read"],
        stepById,
        capabilityByStepId,
        stepIndexes,
      )) {
      errors.push("knowledge.safety.evaluate requires knowledge.vehicle-state.read");
    }
    if (capability.id === "knowledge.answer.synthesize"
      && !hasEarlierAncestorCapability(
        stepId,
        ["knowledge.manual.retrieve", "knowledge.vehicle-state.read"],
        stepById,
        capabilityByStepId,
        stepIndexes,
      )) {
      errors.push("knowledge.answer.synthesize requires an evidence ancestor");
    }
    if (capability.id === "knowledge.answer.synthesize"
      && delegation.requireSafetyEligibilityExplanation
      && !hasEarlierAncestorCapability(
        stepId,
        ["knowledge.safety.evaluate"],
        stepById,
        capabilityByStepId,
        stepIndexes,
      )) {
      errors.push("knowledge.answer.synthesize requires knowledge.safety.evaluate");
    }
  }
  return result(errors, errors.length === 0 ? subplan : null);
}

function delegationResult(errors, delegation) {
  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    delegation,
  });
}

function result(errors, plan) {
  return Object.freeze({
    ok: errors.length === 0,
    status: errors.length ? "knowledge-plan-invalid" : "knowledge-plan-valid",
    errors: Object.freeze(errors),
    plan,
  });
}

function hasEarlierAncestorCapability(stepId, requiredCapabilityIds, stepById, capabilityByStepId, stepIndexes) {
  const visit = (currentStepId, seen = new Set()) => {
    if (seen.has(currentStepId)) return false;
    seen.add(currentStepId);
    const step = stepById.get(currentStepId);
    if (!step) return false;
    for (const dependencyId of step.dependsOn ?? []) {
      const dependency = capabilityByStepId.get(dependencyId);
      if (requiredCapabilityIds.includes(dependency?.id)
        && stepIndexes.get(dependencyId) < stepIndexes.get(stepId)) return true;
      if (visit(dependencyId, seen)) return true;
    }
    return false;
  };
  return visit(stepId);
}

function hasCycle(stepById) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (stepId) => {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    const step = stepById.get(stepId);
    for (const dependencyId of step?.dependsOn ?? []) {
      if (stepById.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  return [...stepById.keys()].some(visit);
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
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`capability input field ${path} must equal ${String(schema.const)}: ${capabilityId}`);
  }
}

function matchesPrimitive(value, type) {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function sameStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function plainDataEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => plainDataEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && plainDataEqual(left[key], right[key]));
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
