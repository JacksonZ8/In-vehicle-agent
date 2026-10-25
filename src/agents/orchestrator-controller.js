import { createGoalEnvelope, createTaskPlan } from "./agent-contracts.js";
import { B2_CAPABILITY_CATALOG } from "./capability-catalog.js";
import { validatePlanAgainstCatalog } from "./plan-validator.js";
import { projectVehicleWriteBinding } from "../vehicle/vehicle-write-capabilities.js";
import {
  createKnowledgeDelegation,
  createKnowledgeClarificationRequest,
  createKnowledgeSubplan,
  isKnowledgeClarificationAllowed,
} from "../application/contracts/vehicle-knowledge.js";
import { getKnowledgeCapabilityCatalogProjection } from "./knowledge-capability-catalog.js";
import { validateKnowledgeSubplan } from "./knowledge-plan-validator.js";
import {
  createAbortError,
  throwIfAborted,
} from "../runtime/abort-utils.js";
import {
  createVehicleSluGoalEnvelope,
  createVehicleSluPlanAuthority,
  createVehicleSluWeatherQuery,
  VEHICLE_SLU_RESPONSE_PLAN_INPUT,
} from "../semantic/vehicle-slu-orchestration.js";
import {
  createCapabilityFailure,
  RECOVERY_ACTIONS,
} from "../interaction/recovery-policy.js";

const CATALOG_PROJECTION_FIELDS = Object.freeze([
  "id",
  "label",
  "inputSchema",
  "outputSchema",
  "accessMode",
  "requiresSafety",
  "allowedDomains",
  "degradationPolicy",
]);
const TELEMETRY_FIELDS = Object.freeze([
  "model",
  "provider",
  "durationMs",
  "degraded",
  "reason",
  "structuredRetryCount",
  "validationSubreason",
]);

export class OrchestratorController {
  constructor({ modelAdapter, catalog = B2_CAPABILITY_CATALOG, now } = {}) {
    if (!modelAdapter || typeof modelAdapter.createTaskPlan !== "function") {
      throw new TypeError("modelAdapter must provide createTaskPlan()");
    }
    if (now !== undefined && typeof now !== "function") throw new TypeError("now must be a function");
    this.modelAdapter = modelAdapter;
    this.catalogProjection = projectCatalog(catalog);
    this.knowledgeCatalogProjection = getKnowledgeCapabilityCatalogProjection();
    this.now = now ?? Date.now;
  }

  async plan({ runId, goalEnvelope, semanticEnvelope = null, semanticAuthority = null, signal, deadlineAt } = {}) {
    throwIfAborted(signal);
    const goal = createGoalEnvelope(goalEnvelope);
    if (typeof runId !== "string" || runId !== goal.runId) {
      throw new TypeError("runId must match GoalEnvelope runId");
    }

    const catalogProjection = semanticAuthority
      ? projectAuthorizedCatalog(this.catalogProjection, semanticAuthority, semanticEnvelope, goal, runId)
      : this.catalogProjection;
    const modelResult = await this.modelAdapter.createTaskPlan({
      runId,
      goalEnvelope: goal,
      catalogProjection,
      ...(semanticEnvelope ? { semanticEnvelope } : {}),
      ...(semanticAuthority ? { semanticAuthority } : {}),
      ...optionalTurnContext(signal, deadlineAt),
    });
    throwIfAborted(signal);
    const telemetry = projectTelemetry(modelResult?.telemetry);

    let taskPlan;
    try {
      taskPlan = createTaskPlan(modelResult?.output);
    } catch (error) {
      return freezeResult({
        taskPlan: null,
        validation: freezeValidation(false, [contractError(error)], null),
        telemetry,
      });
    }

    const allowedCapabilityIds = new Set(catalogProjection.map((capability) => capability.id));
    const projectionErrors = taskPlan.steps
      .filter((step) => !allowedCapabilityIds.has(step.capabilityId))
      .map((step) => `unknown capability in controller catalog: ${step.capabilityId}`);
    const catalogValidation = validatePlanAgainstCatalog(taskPlan, goal);
    const semanticErrors = semanticAuthority
      ? validateVehicleSluPlanBinding(taskPlan, semanticEnvelope, semanticAuthority)
      : [];
    const validationErrors = [...projectionErrors, ...catalogValidation.errors, ...semanticErrors];
    if (validationErrors.length) {
      return freezeResult({
        taskPlan: null,
        validation: freezeValidation(false, validationErrors, null),
        telemetry,
      });
    }
    return freezeResult({
      taskPlan,
      validation: freezeValidation(true, [], taskPlan),
      telemetry,
    });
  }

  async planKnowledgeTask(input = {}) {
    throwIfAborted(input.signal);
    if (typeof this.modelAdapter.createVehicleKnowledgeSubplan !== "function") {
      throw new TypeError("modelAdapter must provide createVehicleKnowledgeSubplan()");
    }
    const delegation = createKnowledgeDelegation(input.delegation);
    if (delegation.vehicleScope !== "nio-es8-user-manual-2026") {
      return invalidKnowledgePlanResult(["delegation vehicleScope must be nio-es8-user-manual-2026"]);
    }
    if (input.complexity !== "multi-target") {
      return invalidKnowledgePlanResult(["Orchestrator accepts complex knowledge delegations only"]);
    }
    const startedAt = this.now();
    let modelResult;
    try {
      modelResult = await this.modelAdapter.createVehicleKnowledgeSubplan({
        delegation,
        catalogProjection: this.knowledgeCatalogProjection,
        ...optionalTurnContext(input.signal, input.deadlineAt),
      });
      throwIfAborted(input.signal);
    } catch (error) {
      rethrowCancellation(error, input.signal);
      const reason = isTimeout(error) ? "model-timeout" : "model-unavailable";
      return invalidKnowledgePlanResult([reason], {
        durationMs: Math.max(0, this.now() - startedAt),
        degraded: true,
        reason,
      });
    }

    const telemetry = projectTelemetry(modelResult?.telemetry);
    if (modelResult?.output?.outcomeStatus === "clarification") {
      if (!isKnowledgeClarificationAllowed(delegation)) {
        return invalidKnowledgePlanResult(["clarification-not-allowed"], telemetry);
      }
      try {
        const clarificationRequest = createKnowledgeClarificationRequest(modelResult.output);
        if (clarificationRequest.delegationId !== delegation.delegationId
          || clarificationRequest.runId !== delegation.runId) {
          return invalidKnowledgePlanResult(["association-invalid"], telemetry);
        }
        return deepFreeze({
          subplan: null,
          clarificationRequest,
          validation: { ok: true, status: "knowledge-clarification", errors: [], plan: null },
          telemetry,
        });
      } catch (error) {
        return invalidKnowledgePlanResult([contractError(error)], telemetry);
      }
    }
    let subplan;
    try {
      subplan = createKnowledgeSubplan(modelResult?.output);
    } catch (error) {
      return invalidKnowledgePlanResult([contractError(error)], telemetry);
    }
    const validation = validateKnowledgeSubplan(subplan, delegation);
    return validation.ok
      ? deepFreeze({ subplan, validation, telemetry })
      : invalidKnowledgePlanResult(validation.errors, telemetry);
  }

  async proposeRecovery({ failure, availableActions, signal } = {}) {
    throwIfAborted(signal);
    if (typeof this.modelAdapter.proposeRecovery !== "function") {
      throw new TypeError("modelAdapter must provide proposeRecovery()");
    }
    const normalizedFailure = createCapabilityFailure(failure);
    const boundedActions = normalizeRecoveryActions(availableActions);
    const modelResult = await this.modelAdapter.proposeRecovery({
      failure: normalizedFailure,
      availableActions: boundedActions,
      ...(signal !== undefined ? { signal } : {}),
    });
    throwIfAborted(signal);
    const telemetry = projectTelemetry(modelResult?.telemetry);
    const proposal = normalizeRecoveryProposal(modelResult?.output, boundedActions);
    if (!proposal) {
      return freezeResult({
        proposal: null,
        validation: freezeValidation(false, ["recovery proposal is outside caller actions"], null),
        telemetry,
      });
    }
    return freezeResult({
      proposal,
      validation: freezeValidation(true, [], proposal),
      telemetry,
    });
  }
}

function projectAuthorizedCatalog(catalog, authority, envelope, goal, runId) {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)
    || authority.requestId !== runId || envelope?.requestId !== runId
    || !Array.isArray(authority.allowedCapabilityIds)) {
    throw new TypeError("invalid Vehicle-SLU plan authority");
  }
  const expectedAuthority = createVehicleSluPlanAuthority(envelope);
  const expectedGoal = createVehicleSluGoalEnvelope(envelope);
  if (!plainDataEqual(authority, expectedAuthority) || !plainDataEqual(goal, expectedGoal)) {
    throw new TypeError("Vehicle-SLU goal and plan authority must match the semantic envelope");
  }
  const allowed = projectExecutableVehicleSluCapabilityIds(envelope, authority);
  return deepFreeze(catalog.filter((capability) => allowed.has(capability.id)));
}

function validateVehicleSluPlanBinding(plan, envelope, authority) {
  const errors = [];
  const admittedFrame = envelope?.vehicleFrames?.find(
    (frame) => frame.frameId === authority.admittedWriteFrameId,
  ) ?? null;
  const admittedBinding = admittedFrame ? projectVehicleWriteBinding(admittedFrame) : null;
  const safetySteps = plan.steps.filter((step) => step.capabilityId === "safety.evaluate");
  const confirmationSteps = plan.steps.filter((step) => step.capabilityId === "confirmation.issue");
  const writeSteps = plan.steps.filter((step) => step.accessMode === "write");
  const responseSteps = plan.steps.filter((step) => step.capabilityId === "response.synthesize");
  const usedReadonlyFrameIds = new Set();
  for (const step of plan.steps) {
    if (!authority.allowedCapabilityIds.includes(step.capabilityId)) {
      errors.push(`capability is outside Vehicle-SLU authority: ${step.capabilityId}`);
    }
    if (step.capabilityId === "safety.evaluate") {
      if (!admittedBinding || safetySteps.length !== 1
        || !plainDataEqual(step.input, { action: admittedFrame.intent })
        || step.dependsOn.length !== 0) {
        errors.push(`safety step is not bound to admitted Vehicle-SLU frame: ${step.stepId}`);
      }
      continue;
    }
    if (step.capabilityId === "confirmation.issue") {
      if (admittedFrame?.intent !== "body.tailgate.open" || confirmationSteps.length !== 1
        || !plainDataEqual(step.input, { action: admittedFrame.intent })
        || !sameStringList(step.dependsOn, safetySteps.length === 1 ? [safetySteps[0].stepId] : [])) {
        errors.push(`confirmation step is not bound to admitted tailgate frame: ${step.stepId}`);
      }
      continue;
    }
    if (step.accessMode === "write") {
      const expectedDependency = admittedFrame?.intent === "body.tailgate.open"
        ? confirmationSteps
        : safetySteps;
      if (!admittedBinding || writeSteps.length !== 1
        || step.capabilityId !== admittedBinding.capabilityId
        || !plainDataEqual(step.input, admittedBinding.input)
        || !sameStringList(step.dependsOn, expectedDependency.length === 1 ? [expectedDependency[0].stepId] : [])) {
        errors.push(`write step is not bound to admitted Vehicle-SLU frame: ${step.stepId}`);
      }
      continue;
    }
    if (step.capabilityId === "response.synthesize") {
      if (!plainDataEqual(step.input, VEHICLE_SLU_RESPONSE_PLAN_INPUT)) {
        errors.push(`response step must use canonical Vehicle-SLU input: ${step.stepId}`);
      }
      if (!admittedBinding || responseSteps.length !== 1 || writeSteps.length !== 1
        || !sameStringList(step.dependsOn, [writeSteps[0].stepId])) {
        errors.push(`response step is not bound to admitted Vehicle-SLU write: ${step.stepId}`);
      }
      continue;
    }
    if (step.capabilityId === "manual.retrieve") {
      const frame = findMatchingReadonlyFrame(envelope, authority, usedReadonlyFrameIds, step, "vehicle.knowledge.query");
      if (!frame) errors.push(`knowledge step is not bound to Vehicle-SLU frame input: ${step.stepId}`);
      else usedReadonlyFrameIds.add(frame.frameId);
      continue;
    }
    if (step.capabilityId === "vehicle-state-provider.read") {
      const frame = findMatchingReadonlyFrame(envelope, authority, usedReadonlyFrameIds, step, "vehicle.state.query");
      if (!frame) errors.push(`state step is not bound to Vehicle-SLU frame input: ${step.stepId}`);
      else usedReadonlyFrameIds.add(frame.frameId);
      continue;
    }
    if (step.capabilityId === "external.query") {
      const frame = findMatchingReadonlyFrame(envelope, authority, usedReadonlyFrameIds, step, "weather.query");
      if (!frame) errors.push(`weather step is not bound to Vehicle-SLU frame input: ${step.stepId}`);
      else usedReadonlyFrameIds.add(frame.frameId);
    }
  }
  const requiredReadonlyFrames = projectRequiredReadonlyFrames(envelope, authority);
  if (new Set(requiredReadonlyFrames.map(projectReadonlyCapabilityId)).size >= 2) {
    for (const frame of requiredReadonlyFrames) {
      if (!usedReadonlyFrameIds.has(frame.frameId)) {
        errors.push(`plan must bind every supported readonly frame exactly once: missing frame ${frame.frameId}`);
      }
    }
  }
  return errors;
}

function projectRequiredReadonlyFrames(envelope, authority) {
  const deferred = new Set(authority.deferredFrameIds);
  return envelope.vehicleFrames.filter((frame) => (
    authority.allowedFrameIds.includes(frame.frameId)
    && !deferred.has(frame.frameId)
    && projectReadonlyCapabilityId(frame)
  ));
}

function projectReadonlyCapabilityId(frame) {
  if (frame.intent === "vehicle.knowledge.query") return "manual.retrieve";
  if (frame.intent === "vehicle.state.query") return "vehicle-state-provider.read";
  if (frame.intent === "weather.query") return "external.query";
  return "";
}

function projectExecutableVehicleSluCapabilityIds(envelope, authority) {
  const ids = new Set();
  const admittedFrame = envelope.vehicleFrames.find((frame) => frame.frameId === authority.admittedWriteFrameId) ?? null;
  const admittedBinding = admittedFrame ? projectVehicleWriteBinding(admittedFrame) : null;
  if (admittedBinding) {
    ids.add("safety.evaluate");
    if (admittedFrame.intent === "body.tailgate.open") ids.add("confirmation.issue");
    ids.add(admittedBinding.capabilityId);
    ids.add("response.synthesize");
  }
  const deferred = new Set(authority.deferredFrameIds);
  for (const frame of envelope.vehicleFrames) {
    if (deferred.has(frame.frameId)) continue;
    if (frame.intent === "vehicle.knowledge.query") ids.add("manual.retrieve");
    if (frame.intent === "vehicle.state.query") ids.add("vehicle-state-provider.read");
    if (frame.intent === "weather.query") ids.add("external.query");
  }
  return ids;
}

function findMatchingReadonlyFrame(envelope, authority, usedFrameIds, step, intent) {
  if (step.dependsOn.length !== 0) return null;
  const deferred = new Set(authority.deferredFrameIds);
  return envelope.vehicleFrames.find((frame) => (
    frame.intent === intent
    && authority.allowedFrameIds.includes(frame.frameId)
    && !deferred.has(frame.frameId)
    && !usedFrameIds.has(frame.frameId)
    && plainDataEqual(step.input, projectReadonlyBindingInput(frame))
  )) ?? null;
}

function projectReadonlyBindingInput(frame) {
  if (frame.intent === "vehicle.knowledge.query") {
    return { query: frame.slots.query };
  }
  if (frame.intent === "weather.query") {
    return { query: createVehicleSluWeatherQuery(frame) };
  }
  if (frame.intent === "vehicle.state.query") {
    return { stateFields: [...frame.slots.stateFields] };
  }
  return null;
}

function optionalTurnContext(signal, deadlineAt) {
  return {
    ...(signal !== undefined ? { signal } : {}),
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  };
}

function normalizeRecoveryActions(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("availableActions must be a non-empty array");
  }
  const actions = [];
  for (const action of value) {
    if (!RECOVERY_ACTIONS.includes(action)) {
      throw new TypeError("availableActions must contain only RecoveryPolicy actions");
    }
    if (!actions.includes(action)) actions.push(action);
  }
  return Object.freeze(actions);
}

function normalizeRecoveryProposal(value, availableActions) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 2
    || typeof value.reasonCode !== "string"
    || !value.reasonCode.trim()
    || Array.from(value.reasonCode).length > 80
    || !availableActions.includes(value.action)) {
    return null;
  }
  return Object.freeze({
    action: value.action,
    reasonCode: value.reasonCode.trim(),
  });
}

function projectCatalog(catalog) {
  if (!Array.isArray(catalog)) throw new TypeError("catalog must be an array");
  const canonicalById = new Map(
    B2_CAPABILITY_CATALOG.map((capability) => [capability.id, capability]),
  );
  const seenIds = new Set();
  const projection = catalog.map((capability) => {
    if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
      throw new TypeError("catalog capabilities must be objects");
    }
    const projected = projectCapability(capability);
    const canonical = canonicalById.get(projected.id);
    if (!canonical) throw new TypeError(`catalog capability must be canonical: ${String(projected.id)}`);
    if (seenIds.has(projected.id)) throw new TypeError(`duplicate catalog capability: ${projected.id}`);
    seenIds.add(projected.id);
    for (const field of Object.keys(canonical)) {
      if (!Object.hasOwn(capability, field) || !plainDataEqual(capability[field], canonical[field])) {
        throw new TypeError(`canonical capability ${field} differs: ${projected.id}`);
      }
    }
    return projected;
  });
  return deepFreeze(projection);
}

function projectCapability(capability) {
  const projected = {};
  for (const field of CATALOG_PROJECTION_FIELDS) {
    if (Object.hasOwn(capability, field)) projected[field] = structuredClone(capability[field]);
  }
  return projected;
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

function sameStringList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function projectTelemetry(telemetry) {
  const projected = {};
  if (telemetry && typeof telemetry === "object" && !Array.isArray(telemetry)) {
    for (const field of TELEMETRY_FIELDS) {
      if (Object.hasOwn(telemetry, field)) projected[field] = telemetry[field];
    }
  }
  return Object.freeze(projected);
}

function freezeValidation(ok, errors, plan) {
  return Object.freeze({
    ok,
    status: ok ? "plan-valid" : "plan-invalid",
    errors: Object.freeze([...errors]),
    plan,
  });
}

function contractError(error) {
  return error instanceof Error ? error.message : "invalid task plan";
}

function invalidKnowledgePlanResult(errors, telemetry = {}) {
  return deepFreeze({
    subplan: null,
    validation: { ok: false, status: "knowledge-plan-invalid", errors: [...errors], plan: null },
    telemetry: projectTelemetry(telemetry),
  });
}

function isTimeout(error) {
  return /timeout|timed out/i.test(`${error?.name ?? ""} ${error?.message ?? ""}`);
}

function rethrowCancellation(error, signal) {
  if (signal?.aborted) throw createAbortError(signal.reason ?? error);
}

function freezeResult(result) {
  return Object.freeze(result);
}

function deepFreeze(value) {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
