#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolveClarificationTransition } from "../../src/semantic/clarification-transition.js";
import { createVehicleSluEnvelope } from "../../src/semantic/vehicle-slu-contract.js";

const pending = Object.freeze({
  taskId: "task-1",
  intent: "body.window.setPosition",
  acceptedSlots: { zone: "front_left" },
  missingSlots: ["percent"],
  slotProvenance: { zone: "original-turn" },
  clarificationQuestion: "要打开多少？",
  originalUtterance: "打开左前窗",
});

const rows = [
  {
    name: "opens a pending candidate from the first clarification action frame",
    pending: null,
    envelope: envelope(frame({ frameId: "clarify-window", actionNeed: "clarify", slots: { zone: "front_left" }, missingSlots: ["percent"], clarificationQuestion: "要打开多少？" })),
    expected: {
      action: "open",
      nextPending: {
        frameId: "clarify-window",
        intent: "body.window.setPosition",
        acceptedSlots: { zone: "front_left" },
        missingSlots: ["percent"],
        clarificationQuestion: "要打开多少？",
      },
      resolvedFrame: null,
      reasonCode: "clarification-opened",
    },
  },
  {
    name: "does not open a pending candidate from an execute frame without pending state",
    pending: null,
    envelope: envelope(frame({ actionNeed: "execute", slots: { zone: "front_left", percent: 40 } })),
    expected: { action: "none", nextPending: null, resolvedFrame: null, reasonCode: "no-pending-clarification" },
  },
  {
    name: "preserves pending state for a non-vehicle envelope",
    pending,
    envelope: envelope(undefined, { domain: "non_vehicle" }),
    expected: { action: "preserve", nextPending: null, resolvedFrame: null, reasonCode: "non-vehicle-domain" },
  },
  {
    name: "preserves pending state and reports unknown domains for natural clarification",
    pending,
    envelope: envelope(undefined, { domain: "unknown" }),
    expected: { action: "preserve", nextPending: null, resolvedFrame: null, reasonCode: "unknown-domain" },
  },
  {
    name: "merges only declared missing slots for the same intent",
    pending,
    envelope: envelope(frame({ frameId: "clarify-follow-up", actionNeed: "execute", slots: { percent: 40 } })),
    expected: {
      action: "resolve",
      nextPending: null,
      resolvedFrame: frame({ frameId: "clarify-follow-up", actionNeed: "execute", slots: { zone: "front_left", percent: 40 } }),
      reasonCode: "clarification-resolved",
    },
  },
  {
    name: "merges when some declared missing slots remain",
    pending: { ...pending, acceptedSlots: {}, missingSlots: ["zone", "percent"], slotProvenance: {} },
    envelope: envelope(frame({ actionNeed: "clarify", slots: { zone: "front_left" }, missingSlots: ["percent"], clarificationQuestion: "还需要打开多少？" })),
    expected: {
      action: "merge",
      // The follow-up question is re-projected from the contract template for the remaining missing slots.
      nextPending: {
        ...pending,
        acceptedSlots: { zone: "front_left" },
        missingSlots: ["percent"],
        slotProvenance: {},
        clarificationQuestion: "请告诉我车窗要调到多少开度。",
      },
      resolvedFrame: null,
      reasonCode: "clarification-merged",
    },
  },
  {
    name: "replaces a conflicting execute intent and resolves its complete frame",
    pending,
    envelope: envelope(frame({ frameId: "tailgate", intent: "body.tailgate.open", actionNeed: "execute", slots: { open: true } })),
    expected: {
      action: "replace",
      nextPending: null,
      resolvedFrame: frame({ frameId: "tailgate", intent: "body.tailgate.open", actionNeed: "execute", slots: { open: true } }),
      reasonCode: "conflicting-intent-resolved",
    },
  },
  {
    name: "replaces a conflicting clarification intent with a new candidate",
    pending,
    envelope: envelope(frame({ frameId: "tailgate", intent: "body.tailgate.open", actionNeed: "clarify", slots: {}, missingSlots: ["open"], clarificationQuestion: "要打开后备厢吗？" })),
    expected: {
      action: "replace",
      nextPending: { frameId: "tailgate", intent: "body.tailgate.open", acceptedSlots: {}, missingSlots: ["open"], clarificationQuestion: "要打开后备厢吗？" },
      resolvedFrame: null,
      reasonCode: "conflicting-intent-replaced",
    },
  },
  {
    name: "allows the user to replace a previously accepted declared slot",
    pending,
    envelope: envelope(frame({ actionNeed: "execute", slots: { zone: "front_right", percent: 40 } })),
    expected: {
      action: "resolve",
      nextPending: null,
      resolvedFrame: frame({ actionNeed: "execute", slots: { zone: "front_right", percent: 40 } }),
      reasonCode: "clarification-resolved",
    },
  },
  {
    name: "resolves a generic control clarification when a concrete climate setting arrives",
    pending: {
      taskId: "climate-task",
      intent: "cabin.climate.setPreset",
      acceptedSlots: {},
      missingSlots: ["control"],
      clarificationQuestion: "请告诉我空调要设置什么。",
    },
    envelope: envelope(frame({
      intent: "cabin.climate.setPreset",
      actionNeed: "execute",
      slots: { temperature: 22 },
    })),
    expected: {
      action: "resolve",
      nextPending: null,
      resolvedFrame: frame({
        intent: "cabin.climate.setPreset",
        actionNeed: "execute",
        slots: { temperature: 22 },
      }),
      reasonCode: "clarification-resolved",
    },
  },
  {
    name: "rejects slots outside the intent schema",
    pending,
    envelope: {
      domain: "vehicle",
      vehicleFrames: [frame({ actionNeed: "execute", slots: { zone: "front_right", percent: 40, unknown: true } })],
    },
    expected: { action: "reject", nextPending: null, resolvedFrame: null, reasonCode: "undeclared-slot" },
  },
  {
    name: "ignores knowledge frames before the first action frame",
    pending: null,
    envelope: envelope([
      frame({ frameId: "knowledge", intent: "vehicle.knowledge.query", capability: "knowledge", actionNeed: "none", knowledgeNeed: "manual", standaloneQuery: "如何使用车窗", slots: { query: "如何使用车窗" } }),
      frame({ frameId: "action", actionNeed: "clarify", slots: { zone: "front_left" }, missingSlots: ["percent"], clarificationQuestion: "要打开多少？" }),
    ]),
    expected: {
      action: "open",
      nextPending: { frameId: "action", intent: "body.window.setPosition", acceptedSlots: { zone: "front_left" }, missingSlots: ["percent"], clarificationQuestion: "要打开多少？" },
      resolvedFrame: null,
      reasonCode: "clarification-opened",
    },
  },
];

for (const row of rows) {
  assert.deepEqual(resolveClarificationTransition({ pending: row.pending, envelope: row.envelope }), row.expected, row.name);
}

console.log(`verify-clarification-transition.mjs: passed ${rows.length} transition rows`);

function envelope(vehicleFrames, { domain = "vehicle" } = {}) {
  return createVehicleSluEnvelope({
    requestId: `transition-${domain}`,
    domain,
    conversationGoal: { summary: "", need: "none" },
    vehicleFrames: vehicleFrames === undefined ? [] : Array.isArray(vehicleFrames) ? vehicleFrames : [vehicleFrames],
    domainConfidence: 0.9,
  });
}

function frame({
  frameId = "window",
  capability = "control",
  intent = "body.window.setPosition",
  knowledgeNeed = "none",
  actionNeed = "execute",
  slots = {},
  missingSlots = [],
  clarificationQuestion = null,
  standaloneQuery = null,
} = {}) {
  return {
    frameId,
    capability,
    intent,
    speechAct: actionNeed === "execute" ? "command" : "question",
    knowledgeNeed,
    actionNeed,
    slots,
    missingSlots,
    clarificationQuestion,
    standaloneQuery,
    confidence: 0.9,
  };
}
