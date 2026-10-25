#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { InteractionSessionController } from "../../src/interaction/interaction-session-controller.js";
import { createCompatibilityHarness } from "../lib/lean-runtime-test-harness.mjs";

assert.equal(
  process.argv.includes("--static-only"),
  true,
  "Task 9A verifier must run with --static-only",
);

const appUrl = new URL("../../src/app/app.js", import.meta.url);
const bridgeUrl = new URL("../../src/app/runtime-presentation-bridge.js", import.meta.url);
const runtimeResultStateUrl = new URL("../../src/app/runtime-result-state.js", import.meta.url);
const hmiAdapterUrl = new URL("../../src/vehicle/hmi-animation-adapter.js", import.meta.url);
const presenterUrl = new URL("../../src/app/run-event-presenter.js", import.meta.url);
const manifestUrl = new URL("../lib/regression-groups.json", import.meta.url);
const appSource = fs.readFileSync(appUrl, "utf8");
const bridgeSource = fs.existsSync(bridgeUrl) ? fs.readFileSync(bridgeUrl, "utf8") : "";
const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8"));

assert.equal(
  /new RuntimeKernel\s*\(/.test(appSource),
  true,
  "app.js must construct RuntimeKernel",
);
assert.match(appSource, /createRuntimePresentationBridge/);
assert.match(appSource, /const localModel\s*=\s*new LocalModelAdapter/);
assert.match(appSource, /const routePolicy\s*=\s*new RoutePolicy/);
assert.match(appSource, /const safetyGateway\s*=\s*new SafetyGateway/);
assert.match(appSource, /const externalDataAdapter\s*=\s*new ExternalDataAdapter/);
assert.match(appSource, /const runEventLedger\s*=\s*new RunEventLedger/);
assert.match(appSource, /const sessionMemory\s*=\s*new SessionMemory/);
assert.match(appSource, /const chatUseCase\s*=\s*createChatUseCase/);
assert.match(appSource, /const vehicleKnowledgeUseCase\s*=\s*createVehicleKnowledgeUseCase/);
assert.match(appSource, /const vehicleControlUseCase\s*=\s*createVehicleControlUseCase/);
assert.match(appSource, /const complexTaskUseCase\s*=\s*createComplexTaskUseCase/);
assert.match(
  appSource,
  /useCases:\s*Object\.freeze\(\{\s*chat:\s*chatUseCase,\s*"vehicle-knowledge":\s*vehicleKnowledgeUseCase,\s*"vehicle-control":\s*vehicleControlUseCase,\s*task:\s*complexTaskUseCase,?\s*\}\)/s,
);
assert.match(appSource, /vehicleControl:\s*vehicleControlUseCase/);
assert.match(appSource, /vehicleExecutionCoordinator,\s*now,/s);
assert.match(appSource, /vehicleStateProvider,\s*safetyGateway,/s);
assert.match(appSource, /url !== "\/api\/manual-rag"/);
assert.match(appSource, /prepareManualRetrievalCandidate:\s*prepareBrowserManualRetrievalCandidate/);
assert.match(appSource, /const privateTransitions = \[\]/);
assert.match(appSource, /x-nio-private-manual-candidate/);
assert.match(appSource, /benchmarkRunEvidenceState\.manualRagReceipt = privateBenchmarkReceipt/);
assert.match(appSource, /onConsume\(\)\s*\{\s*privateTransitions\.forEach\(transitionManualEvidenceRun\)/s);
const speculativeManualFunction = appSource.match(
  /function prepareBrowserManualRetrievalCandidate[\s\S]*?\n}\n\nfunction projectManualChunkEvidenceRef/,
)?.[0] || "";
assert.ok(speculativeManualFunction);
assert.doesNotMatch(
  speculativeManualFunction,
  /onTransition:\s*transitionManualEvidenceRun/,
  "speculative retrieval must buffer HMI transitions until exact knowledge consumption",
);
assert.doesNotMatch(appSource, /runtime\.emit\s*\(/);
assert.doesNotMatch(appSource, /runtime\.safetyGateway|runtime\.externalDataAdapter/);
assert.match(appSource, /window\.runCommand\s*=\s*runCommand/);
assert.match(appSource, /fetch\("\/api\/runtime-warmup"/);
assert.match(appSource, /method:\s*"POST"/);
assert.match(appSource, /NIO_B2_ACCEPTANCE_INSTRUMENTATION/);
assert.match(appSource, /__runtimeWarmupReady/);
assert.doesNotMatch(appSource, /await\s+startRuntimeWarmup\s*\(/,
  "page startup must not block on optional runtime warmup");
assert.ok(
  appSource.indexOf("void startRuntimeWarmup();") < appSource.indexOf("await loadModelProviderProfile"),
  "runtime warmup must overlap the existing page-open model-profile initialization",
);
assert.match(appSource, /window\.__runtimeDebug\s*=\s*getRuntimeDebugSnapshot/);
assert.match(appSource, /window\.__vehicleDebug\s*=/);
assert.match(appSource, /Object\.defineProperty\(window,\s*"__b2AcceptanceCalls"/);
assert.match(appSource, /interactionSessionController\.linkRun|presentationBridge\.handleEvent/);
for (const field of [
  "routeDecision",
  "runtimeTelemetry",
  "components",
  "relatedRunIds",
  "providerSnapshotSummary",
  "runtimeAcceptanceCounters",
  "runEventProtocol",
]) {
  assert.equal(appSource.includes(field), true, `runtime debug must expose ${field}`);
}

assert.match(bridgeSource, /export function createRuntimePresentationBridge/);
assert.doesNotMatch(
  bridgeSource,
  /safetyGateway\s*\.\s*evaluate|vehicleExecutionCoordinator\s*\.\s*execute|createToolCall|parseCommand|isVehicleControlIntent/,
);
assert.doesNotMatch(bridgeSource, /parsedCommand\?*\.?intent|rawText.*(?:vehicle|animation)/i);

const hmiScripts = (manifest.groups?.hmi?.scripts || [])
  .map((entry) => typeof entry === "string" ? entry : entry.script);
const verifierIndex = hmiScripts.indexOf("verify-hmi-lean-runtime-composition.mjs");
assert.equal(verifierIndex >= 0, true);

const { createRuntimePresentationBridge } = await import(bridgeUrl);
await verifyBridgeMatrix(createRuntimePresentationBridge);
await verifyRuntimeVoiceBridgeIntegration(createRuntimePresentationBridge);
const runtimeResultState = await import(runtimeResultStateUrl);
const hmiAdapter = await import(hmiAdapterUrl);
verifyReducerBackedLateTerminalEffects(
  createRuntimePresentationBridge,
  runtimeResultState,
  hmiAdapter,
);
const {
  buildInteractionSessionDebugSnapshot,
  buildRuntimeResultDebugSnapshot,
} = await import(presenterUrl);
verifyLeanDebugProjection(buildRuntimeResultDebugSnapshot, buildInteractionSessionDebugSnapshot);

console.log("HMI Lean Runtime composition static verification passed");

async function verifyBridgeMatrix(createBridge) {
  const chat = fixture(createBridge, "run:chat");
  chat.bridge.handleEvent(runEvent("run:chat", 1, {
    component: "cabinAssistant",
    phase: "intake",
    status: "processing",
  }));
  chat.bridge.handleEvent(runEvent("run:chat", 2, {
    component: "cabinModel",
    phase: "chat-response",
    status: "completed",
  }));
  assert.deepEqual(chat.state.currentRun.events.map(({ component }) => component), [
    "cabinAssistant", "cabinModel",
  ]);
  assert.equal(chat.vehicleCalls.length, 0);

  const knowledge = fixture(createBridge, "run:knowledge");
  knowledge.bridge.handleEvent(runEvent("run:knowledge", 1, {
    component: "cabinAssistant",
    phase: "intake",
    status: "processing",
  }));
  knowledge.bridge.handleEvent(runEvent("run:knowledge", 2, {
    component: "manualRetriever",
    phase: "knowledge-evidence",
    status: "completed",
    refs: ["manual:1"],
  }));
  assert.deepEqual(knowledge.state.currentRun.events.map(({ component }) => component), [
    "cabinAssistant", "manualRetriever",
  ]);

  const unsafe = fixture(createBridge, "run:unsafe");
  const unsafePresentation = unsafe.bridge.applyResult(runtimeResult("run:unsafe", {
    assistantResponse: "该动作不安全，未执行。",
    safetyDecision: { allowed: false, action: "reject" },
  }), unsafe.turn);
  assert.equal(unsafePresentation.accepted, true);
  assert.equal(unsafePresentation.mode, "blocked");
  assert.equal(unsafe.vehicleCalls.length, 0);

  const pending = fixture(createBridge, "run:pending");
  const command = vehicleCommand("run:pending");
  const pendingOutcome = pending.bridge.handleEvent(vehiclePendingEvent(command, 1));
  assert.equal(pendingOutcome.accepted, true);
  assert.equal(pendingOutcome.vehicle.authorized, true);
  assert.equal(pending.vehicleCalls.filter((call) => call.authorization === "pending").length, 1);
  assert.equal(pending.vehicleCalls.some((call) => call.authorization === "confirmed"), false);

  const confirmed = fixture(createBridge, "run:confirmed");
  const confirmedCommand = vehicleCommand("run:confirmed");
  confirmed.state.providerSnapshot = providerSnapshot("snapshot:confirmed", 50);
  confirmed.bridge.handleEvent(vehiclePendingEvent(confirmedCommand, 1));
  const confirmedOutcome = confirmed.bridge.handleEvent(vehicleTerminalEvent(
    confirmedCommand,
    2,
    { confirmedSnapshotId: "snapshot:confirmed" },
  ));
  assert.equal(confirmedOutcome.vehicle.authorized, true);
  assert.equal(confirmed.vehicleCalls.filter((call) => call.authorization === "confirmed").length, 1);

  const mismatch = fixture(createBridge, "run:mismatch");
  const mismatchCommand = vehicleCommand("run:mismatch");
  mismatch.state.providerSnapshot = providerSnapshot("snapshot:actual", 50);
  mismatch.bridge.handleEvent(vehiclePendingEvent(mismatchCommand, 1));
  const mismatchOutcome = mismatch.bridge.handleEvent(vehicleTerminalEvent(
    mismatchCommand,
    2,
    { confirmedSnapshotId: "snapshot:forged" },
  ));
  assert.equal(mismatchOutcome.vehicle.authorized, false);
  assert.equal(mismatch.vehicleCalls.some((call) => call.authorization === "confirmed"), false);
  mismatch.state.providerSnapshot = providerSnapshot("snapshot:truthful", 50);
  const recoveredOutcome = mismatch.bridge.handleEvent(vehicleTerminalEvent(
    mismatchCommand,
    3,
    { confirmedSnapshotId: "snapshot:truthful" },
  ));
  assert.equal(recoveredOutcome.vehicle.authorized, true,
    "a current-run Provider mismatch must not consume the dispatch before a truthful terminal");

  const cancelled = fixture(createBridge, "run:cancelled");
  const cancelledCommand = vehicleCommand("run:cancelled");
  cancelled.bridge.handleEvent(vehiclePendingEvent(cancelledCommand, 1));
  const cancelledOutcome = cancelled.bridge.handleEvent(vehicleTerminalEvent(
    cancelledCommand,
    2,
    { executionState: "failed", ok: false, confirmedSnapshotId: null, cancellationRequested: true },
  ));
  assert.equal(cancelledOutcome.vehicle.authorized, false);
  assert.equal(cancelled.vehicleCalls.some((call) => call.authorization === "confirmed"), false);

  const stale = fixture(createBridge, "run:current");
  const staleOutcome = stale.bridge.handleEvent(runEvent("run:stale", 1, {
    component: "cabinAssistant",
    phase: "intake",
    status: "processing",
  }));
  assert.equal(staleOutcome.accepted, false);
  assert.equal(stale.links.length, 0);
  assert.equal(stale.renders.length, 0);

  verifyVoiceBridgeAuthorizationForwarding(createBridge);
  verifyLateVehicleTerminalIsolation(createBridge);
}

function verifyVoiceBridgeAuthorizationForwarding(createBridge) {
  const current = fixture(createBridge, "run:voice-current");
  const allowedEvent = runEvent("run:voice-current", 1, {
    component: "voiceBridgeEligibility",
    phase: "voice-bridge-eligibility",
    status: "completed",
    metadata: {
      voiceBridgeEligibility: Object.freeze({
        allowed: true,
        requestId: "run:voice-current",
        reason: "ordinary-general-conversation",
        policyId: "runtime-policy",
        policyVersion: "1",
        noToolOrSafetyPath: true,
      }),
    },
  });
  current.bridge.handleEvent(allowedEvent);
  assert.deepEqual(current.voiceBridgeAuthorizations, [{
    allowed: true,
    requestId: "run:voice-current",
    reason: "ordinary-general-conversation",
    policyId: "runtime-policy",
    policyVersion: "1",
    noToolOrSafetyPath: true,
    interactionEventId: "event:run:voice-current:1",
    turnId: "turn:run:voice-current",
  }], "a current Runtime authorization must reach the voice bridge exactly once");

  const denied = fixture(createBridge, "run:voice-denied");
  denied.bridge.handleEvent(runEvent("run:voice-denied", 1, {
    component: "voiceBridgeEligibility",
    phase: "voice-bridge-eligibility",
    status: "completed",
    metadata: {
      voiceBridgeEligibility: Object.freeze({
        allowed: false,
        requestId: "run:voice-denied",
        reason: "manual-knowledge-or-action",
        policyId: "runtime-policy",
        policyVersion: "1",
        noToolOrSafetyPath: false,
      }),
    },
  }));
  assert.deepEqual(denied.voiceBridgeAuthorizations, [{
    allowed: false,
    requestId: "run:voice-denied",
    reason: "manual-knowledge-or-action",
    policyId: "runtime-policy",
    policyVersion: "1",
    noToolOrSafetyPath: false,
    interactionEventId: "event:run:voice-denied:1",
    turnId: "turn:run:voice-denied",
  }], "a denied Runtime authorization must be forwarded without HMI recomputation");

  const mismatchedAuthorization = fixture(createBridge, "run:voice-mismatch");
  assert.equal(mismatchedAuthorization.bridge.handleEvent(runEvent("run:voice-mismatch", 1, {
    component: "voiceBridgeEligibility",
    phase: "voice-bridge-eligibility",
    status: "completed",
    metadata: {
      voiceBridgeEligibility: Object.freeze({
        allowed: true,
        requestId: "run:voice-other",
        reason: "ordinary-general-conversation",
        policyId: "runtime-policy",
        policyVersion: "1",
        noToolOrSafetyPath: true,
      }),
    },
  })).accepted, true);
  assert.deepEqual(mismatchedAuthorization.voiceBridgeAuthorizations, [],
    "a Runtime authorization whose requestId does not match its accepted Run must not reach voice");

  const malformed = fixture(createBridge, "run:voice-malformed");
  for (const [label, authorization] of [
    ["missing-policy-envelope", { allowed: true, requestId: "run:voice-malformed" }],
    ["allowed-not-boolean", { allowed: "true", requestId: "run:voice-malformed", reason: "ordinary-general-conversation", policyId: "runtime-policy", policyVersion: "1", noToolOrSafetyPath: true }],
    ["no-tool-not-boolean", { allowed: true, requestId: "run:voice-malformed", reason: "ordinary-general-conversation", policyId: "runtime-policy", policyVersion: "1", noToolOrSafetyPath: "true" }],
    ["allowed-with-tool-path", { allowed: true, requestId: "run:voice-malformed", reason: "ordinary-general-conversation", policyId: "runtime-policy", policyVersion: "1", noToolOrSafetyPath: false }],
    ["empty-reason", { allowed: false, requestId: "run:voice-malformed", reason: " ", policyId: "runtime-policy", policyVersion: "1", noToolOrSafetyPath: false }],
    ["empty-policy-id", { allowed: false, requestId: "run:voice-malformed", reason: "manual-knowledge-or-action", policyId: "", policyVersion: "1", noToolOrSafetyPath: false }],
    ["empty-policy-version", { allowed: false, requestId: "run:voice-malformed", reason: "manual-knowledge-or-action", policyId: "runtime-policy", policyVersion: "", noToolOrSafetyPath: false }],
  ]) {
    assert.equal(malformed.bridge.handleEvent(runEvent("run:voice-malformed", malformed.state.currentRun.events.length + 1, {
      component: "voiceBridgeEligibility",
      phase: "voice-bridge-eligibility",
      status: "completed",
      metadata: { voiceBridgeEligibility: Object.freeze(authorization) },
    })).accepted, true, `${label} remains an accepted presentation event`);
  }
  assert.deepEqual(malformed.voiceBridgeAuthorizations, [],
    "an incomplete or contradictory Runtime authorization must fail closed before voice");

  const throwing = fixture(createBridge, "run:voice-throw", {
    onVoiceBridge() {
      throw new Error("voice-bridge-side-effect-failure");
    },
  });
  let throwingOutcome;
  assert.doesNotThrow(() => {
    throwingOutcome = throwing.bridge.handleEvent(runEvent("run:voice-throw", 1, {
      component: "voiceBridgeEligibility",
      phase: "voice-bridge-eligibility",
      status: "completed",
      metadata: {
        voiceBridgeEligibility: Object.freeze({
          allowed: true,
          requestId: "run:voice-throw",
          reason: "ordinary-general-conversation",
          policyId: "runtime-policy",
          policyVersion: "1",
          noToolOrSafetyPath: true,
        }),
      },
    }));
  }, "a best-effort voice side effect must not reject the Runtime event listener");
  assert.equal(throwingOutcome.accepted, true);
  assert.equal(throwing.renders.length, 1, "voice callback failure must not suppress normal rendering");

  const guarded = fixture(createBridge, "run:voice-guarded");
  const staleEvent = runEvent("run:voice-stale", 1, {
    component: "voiceBridgeEligibility",
    phase: "voice-bridge-eligibility",
    status: "completed",
    metadata: {
      voiceBridgeEligibility: Object.freeze({ allowed: true, requestId: "run:voice-stale" }),
    },
  });
  assert.equal(guarded.bridge.handleEvent(staleEvent).accepted, false);

  const replayEvent = runEvent("run:voice-guarded", 1, {
    component: "voiceBridgeEligibility",
    phase: "voice-bridge-eligibility",
    status: "completed",
    metadata: {
      voiceBridgeEligibility: Object.freeze({
        allowed: true,
        requestId: "run:voice-guarded",
        reason: "ordinary-general-conversation",
        policyId: "runtime-policy",
        policyVersion: "1",
        noToolOrSafetyPath: true,
      }),
    },
  });
  assert.equal(guarded.bridge.handleEvent(replayEvent).accepted, true);
  assert.equal(guarded.bridge.handleEvent(replayEvent).accepted, false);
  assert.equal(guarded.voiceBridgeAuthorizations.length, 1,
    "stale and replayed Runtime authorizations must not reach the voice bridge");
}

async function verifyRuntimeVoiceBridgeIntegration(createBridge) {
  const allowed = runtimeBridgeFixture(createBridge, "你好，陪我聊聊");
  const allowedResult = await allowed.run();
  const allowedEvent = allowed.events.find((event) => event.component === "voiceBridgeEligibility");
  assert.equal(allowedResult.voiceBridgeEligibility.allowed, true);
  assert.equal(allowed.voiceCalls.length, 1, "a real ordinary-chat Runtime Run forwards one early authorization");
  assert.deepEqual(allowed.voiceCalls[0].authorization, {
    ...allowedEvent.metadata.voiceBridgeEligibility,
    interactionEventId: allowedEvent.eventId,
    turnId: allowed.turn.turnId,
  });
  assert.equal(allowed.voiceCalls[0].finalResponseObserved, false,
    "the real Runtime authorization reaches voice before its final response event");
  assert.equal(allowed.voiceCalls[0].runResolved, false,
    "the real Runtime authorization reaches voice before runtime.run resolves");
  assert.equal(allowed.voiceCalls[0].resultPresentationSeen, false,
    "the real Runtime authorization reaches voice before final result presentation");
  assert.equal(allowed.bridge.applyResult(allowedResult, allowed.turn).accepted, true);
  assert.equal(allowed.resultPresentationSeen, true);
}

function runtimeBridgeFixture(createBridge, rawText) {
  let idSequence = 0;
  let now = Date.parse("2026-08-05T12:00:00.000Z");
  const controller = new InteractionSessionController({
    now: () => ++now,
    setTimer: () => "runtime-voice-bridge-test-timer",
    clearTimer: () => {},
    createId(kind) {
      idSequence += 1;
      return `${kind}:runtime-voice-bridge:${idSequence}`;
    },
  });
  controller.wake({ provider: "runtime-voice-bridge-test", simulated: true });
  const turn = controller.submitTurn({ rawText, trigger: "text", relation: "new-goal" });
  const state = {
    mode: "idle",
    currentRun: { requestId: turn.runId, interactionTurn: turn, events: [] },
    consumedRuntimeRequestIds: new Set(),
    providerSnapshot: null,
  };
  const events = [];
  const voiceCalls = [];
  let finalResponseObserved = false;
  let runResolved = false;
  let resultPresentationSeen = false;
  const bridge = createBridge({
    state,
    interactionSessionController: controller,
    render(update) {
      if (update.type === "result") resultPresentationSeen = true;
      return { speechPromise: Promise.resolve() };
    },
    applyVehiclePresentation() {
      return { accepted: false };
    },
    startVoiceBridge(authorization) {
      voiceCalls.push({
        authorization: structuredClone(authorization),
        finalResponseObserved,
        resultPresentationSeen,
        runResolved,
      });
    },
  });
  const { runtime } = createCompatibilityHarness();
  runtime.onEvent((event) => {
    if (event.phase === "final-response") finalResponseObserved = true;
    events.push(event);
    bridge.handleEvent(event);
  });

  return {
    bridge,
    events,
    get resultPresentationSeen() { return resultPresentationSeen; },
    run: async () => {
      const result = await runtime.run(rawText, {
        requestId: turn.runId,
        sessionId: turn.sessionId,
        interactionRef: { sessionId: turn.sessionId, turnId: turn.turnId },
      });
      runResolved = true;
      return result;
    },
    turn,
    voiceCalls,
  };
}

function verifyLateVehicleTerminalIsolation(createBridge) {
  const late = fixture(createBridge, "run:late-old");
  const oldCommand = vehicleCommand("run:late-old");
  late.bridge.handleEvent(vehiclePendingEvent(oldCommand, 1));
  const replacementTurn = late.replaceCurrentRun("run:replacement");
  const replacementOutcome = late.bridge.handleEvent(runEvent("run:replacement", 1, {
    component: "cabinAssistant",
    phase: "intake",
    status: "processing",
  }));
  assert.equal(replacementOutcome.accepted, true, "replacement run must remain usable");
  late.state.providerSnapshot = providerSnapshot("snapshot:late-confirmed", 50);
  const linksBeforeTerminal = structuredClone(late.links);
  const renderCountBeforeTerminal = late.renders.length;
  const replacementEventsBeforeTerminal = structuredClone(late.state.currentRun.events);
  const replacementModeBeforeTerminal = late.state.mode;
  const lateTerminal = vehicleTerminalEvent(oldCommand, 2, {
    confirmedSnapshotId: "snapshot:late-confirmed",
  });
  const lateOutcome = late.bridge.handleEvent(lateTerminal);
  assert.equal(lateOutcome.accepted, true);
  assert.equal(lateOutcome.mode, "late-terminal");
  assert.equal(lateOutcome.vehicle.authorized, true);
  assert.equal(late.vehicleCalls.filter((call) => call.authorization === "confirmed").length, 1);
  assert.deepEqual(late.links, linksBeforeTerminal, "late terminal must not link replacement turn");
  assert.equal(late.renders.length, renderCountBeforeTerminal, "late terminal must not render or voice");
  assert.deepEqual(late.state.currentRun.events, replacementEventsBeforeTerminal);
  assert.equal(late.state.mode, replacementModeBeforeTerminal);
  assert.equal(late.controller.isCurrent(replacementTurn), true);

  const replayOutcome = late.bridge.handleEvent(lateTerminal);
  assert.equal(replayOutcome.accepted, false, "late terminal replay must be rejected");
  assert.equal(late.vehicleCalls.filter((call) => call.authorization === "confirmed").length, 1);
  const staleNonVehicle = late.bridge.handleEvent(runEvent("run:late-old", 3, {
    component: "cabinAssistant",
    phase: "final-response",
    status: "completed",
  }));
  assert.equal(staleNonVehicle.accepted, false);

  const forged = fixture(createBridge, "run:forged-current");
  forged.replaceCurrentRun("run:forged-replacement");
  forged.state.providerSnapshot = providerSnapshot("snapshot:forged-late", 50);
  const forgedCommand = vehicleCommand("run:no-dispatch");
  const forgedOutcome = forged.bridge.handleEvent(vehicleTerminalEvent(forgedCommand, 1, {
    confirmedSnapshotId: "snapshot:forged-late",
  }));
  assert.equal(forgedOutcome.accepted, false, "late terminal without dispatch must be rejected");
  assert.equal(forged.vehicleCalls.length, 0);

  const identityMismatch = fixture(createBridge, "run:identity-old");
  const identityCommand = vehicleCommand("run:identity-old");
  identityMismatch.bridge.handleEvent(vehiclePendingEvent(identityCommand, 1));
  identityMismatch.replaceCurrentRun("run:identity-replacement");
  identityMismatch.state.providerSnapshot = providerSnapshot("snapshot:identity", 50);
  const mismatchedCommand = Object.freeze({
    ...identityCommand,
    commandId: "run:identity-old:2:body.window.setPosition",
  });
  const identityOutcome = identityMismatch.bridge.handleEvent(vehicleTerminalEvent(
    mismatchedCommand,
    2,
    { confirmedSnapshotId: "snapshot:identity" },
  ));
  assert.equal(identityOutcome.accepted, false);
  assert.equal(identityMismatch.vehicleCalls.some((call) => call.authorization === "confirmed"), false);

  const providerMismatch = fixture(createBridge, "run:provider-old");
  const providerCommand = vehicleCommand("run:provider-old");
  providerMismatch.bridge.handleEvent(vehiclePendingEvent(providerCommand, 1));
  providerMismatch.replaceCurrentRun("run:provider-replacement");
  providerMismatch.state.providerSnapshot = providerSnapshot("snapshot:actual-provider", 50);
  const providerOutcome = providerMismatch.bridge.handleEvent(vehicleTerminalEvent(
    providerCommand,
    2,
    { confirmedSnapshotId: "snapshot:mismatched-provider" },
  ));
  assert.equal(providerOutcome.accepted, false);
  assert.equal(providerOutcome.vehicle.authorized, false);
  assert.equal(providerMismatch.vehicleCalls.filter((call) => call.authorization === "terminal").length, 0);
  providerMismatch.state.providerSnapshot = providerSnapshot("snapshot:late-truthful", 50);
  const recoveredProviderOutcome = providerMismatch.bridge.handleEvent(vehicleTerminalEvent(
    providerCommand,
    3,
    { confirmedSnapshotId: "snapshot:late-truthful" },
  ));
  assert.equal(recoveredProviderOutcome.accepted, true,
    "a late Provider mismatch must retain the dispatch for a truthful terminal");
  assert.equal(recoveredProviderOutcome.vehicle.authorized, true);

  const failed = fixture(createBridge, "run:failed-old");
  const failedCommand = vehicleCommand("run:failed-old");
  failed.bridge.handleEvent(vehiclePendingEvent(failedCommand, 1));
  failed.replaceCurrentRun("run:failed-replacement");
  const failedOutcome = failed.bridge.handleEvent(vehicleTerminalEvent(failedCommand, 2, {
    executionState: "failed",
    ok: false,
    confirmedSnapshotId: null,
    cancellationRequested: true,
  }));
  assert.equal(failedOutcome.accepted, true);
  assert.equal(failedOutcome.vehicle.authorized, false);
  assert.equal(failed.vehicleCalls.at(-1).authorization, "terminal");
}

function verifyLeanDebugProjection(buildRuntimeDebug, buildInteractionDebug) {
  const resultDebug = buildRuntimeDebug(runtimeResult("run:debug", {
    routeDecision: Object.freeze({
      disposition: "execute",
      routeId: "chat",
      mode: "direct",
      semanticSource: "deterministic",
    }),
    runtimeTelemetry: Object.freeze({
      modelCallCount: 1,
      modelCalls: Object.freeze([
        Object.freeze({ phase: "chat-response", telemetry: Object.freeze({ provider: "test" }) }),
      ]),
      eventCount: 3,
      degraded: false,
    }),
  }));
  assert.equal(resultDebug.routeDecision.routeId, "chat");
  assert.equal(resultDebug.runtimeTelemetry.modelCallCount, 1);

  const interactionDebug = buildInteractionDebug({
    state: "processing",
    sessionId: "session:debug",
    activeTurn: {
      sessionId: "session:debug",
      turnId: "turn:debug",
      runId: "run:confirmed",
      relatedRunIds: ["run:challenge", "run:confirmed"],
      relatedRunEventIds: ["event:run:confirmed:1"],
    },
    currentSession: {
      events: [{
        interactionEventId: "interaction:debug:1",
        sessionId: "session:debug",
        turnId: "turn:debug",
        runId: "run:confirmed",
        sequence: 1,
        timestamp: "2026-08-05T12:00:00.000Z",
        participantId: "interactionSession",
        phase: "turn-completed",
        status: "done",
        relatedRunIds: ["run:challenge", "run:confirmed"],
        relatedRunEventIds: ["event:run:confirmed:1"],
      }],
    },
  });
  assert.deepEqual(interactionDebug.relatedRunIds, ["run:challenge", "run:confirmed"]);
  assert.deepEqual(interactionDebug.interactionEvents[0].relatedRunIds, [
    "run:challenge",
    "run:confirmed",
  ]);
}

function verifyReducerBackedLateTerminalEffects(createBridge, runtimeState, hmiAdapter) {
  assert.equal(
    typeof runtimeState.applyAppRuntimeVehicleEventEffects,
    "function",
    "app runtime vehicle state boundary must own presentation side-effect gating",
  );

  const late = reducerBackedFixture(createBridge, runtimeState, hmiAdapter, "run:effect-old");
  const oldCommand = vehicleCommand("run:effect-old");
  late.bridge.handleEvent(vehiclePendingEvent(oldCommand, 1));
  late.replaceCurrentRun("run:effect-replacement");
  late.state.providerSnapshot = providerSnapshot("snapshot:effect-late", 50);
  const replacementRunBeforeTerminal = late.state.currentRun;
  const outcome = late.bridge.handleEvent(vehicleTerminalEvent(oldCommand, 2, {
    confirmedSnapshotId: "snapshot:effect-late",
  }));
  assert.equal(outcome.accepted, true);
  assert.equal(late.transactions.at(-1).factsAccepted, true);
  assert.equal(late.transactions.at(-1).presentationAccepted, false);
  assert.equal(late.state.confirmedVehicleStateSnapshot.id, "snapshot:effect-late");
  assert.equal(late.state.currentRun, replacementRunBeforeTerminal);
  assert.equal(late.presentationCalls.length, 0, "late terminal must not animate the replacement run");
  assert.equal(late.metricsCalls.length, 0, "late terminal must not refresh replacement-run metrics");

  const current = reducerBackedFixture(
    createBridge,
    runtimeState,
    hmiAdapter,
    "run:effect-current",
  );
  const currentCommand = vehicleCommand("run:effect-current");
  current.bridge.handleEvent(vehiclePendingEvent(currentCommand, 1));
  current.state.providerSnapshot = providerSnapshot("snapshot:effect-current", 50);
  current.bridge.handleEvent(vehicleTerminalEvent(currentCommand, 2, {
    confirmedSnapshotId: "snapshot:effect-current",
  }));
  assert.equal(current.transactions.at(-1).presentationAccepted, true);
  assert.equal(current.presentationCalls.length, 1, "owned terminal must still animate once");
  assert.equal(current.metricsCalls.length, 1, "owned terminal must still refresh metrics once");
}

function reducerBackedFixture(createBridge, runtimeState, hmiAdapter, runId) {
  const turn = Object.freeze({
    sessionId: `session:${runId}`,
    turnId: `turn:${runId}`,
    runId,
  });
  const state = {
    mode: "idle",
    currentRun: { requestId: runId, interactionTurn: turn, events: [] },
    lastRunDetail: null,
    consumedRuntimeRequestIds: new Set(),
    pendingConfirmation: null,
    providerSnapshot: null,
    confirmedVehicleStateSnapshot: null,
    dispatchedVehicleCommandsByCommandId: new Map(),
    verifiedVehicleTerminalsByCommandId: new Map(),
    pendingVehicleExecutionsByComponent: new Map(),
  };
  const presentationCalls = [];
  const metricsCalls = [];
  const transactions = [];
  let currentTurn = turn;
  const controller = {
    isCurrent(identity) {
      return identity?.sessionId === currentTurn.sessionId
        && identity?.turnId === currentTurn.turnId
        && identity?.runId === currentTurn.runId;
    },
    linkRun() {
      return null;
    },
  };
  const applyVehiclePresentation = (input) => {
    if (input.authorization === "pending") {
      const event = {
        runId: input.event.runId,
        component: "vehicleTool",
        phase: "vehicle-execution",
        status: "processing",
        toolCall: input.toolCall,
      };
      const registration = hmiAdapter.registerDispatchedVehicleCommand(
        state.dispatchedVehicleCommandsByCommandId,
        event,
        { currentRequestId: state.currentRun?.requestId },
      );
      assert.equal(registration.accepted, true);
      state.dispatchedVehicleCommandsByCommandId = registration.dispatchedVehicleCommandsByCommandId;
      const pendingPresentation = hmiAdapter.mapVehicleExecutionToHmi({
        toolResult: {
          requestId: input.toolCall.requestId,
          commandId: input.toolCall.commandId,
          tool: input.toolCall.tool,
          executionState: "submitted",
          ok: false,
        },
        vehicleStateSnapshot: null,
        previousConfirmedState: state.confirmedVehicleStateSnapshot,
      });
      const nextHmiState = hmiAdapter.reduceVehicleHmiState(state, pendingPresentation);
      state.pendingVehicleExecutionsByComponent = nextHmiState.pendingVehicleExecutionsByComponent;
      state.currentRun.pendingVehicleCommandId = pendingPresentation.commandId;
      state.currentRun.pendingVehicleComponent = pendingPresentation.component;
      state.currentRun.pendingVehicleTool = input.toolCall.tool;
      return { accepted: true, presentation: pendingPresentation };
    }

    const terminalEvent = {
      runId: input.event.runId,
      component: "vehicleTool",
      phase: "vehicle-execution",
      status: input.event.status,
      toolResult: input.toolResult,
      providerSnapshot: input.providerSnapshot,
      commitmentState: input.commitmentState,
      cancellation: input.cancellation,
    };
    const { transaction, nextState } = runtimeState.reduceAppRuntimeVehicleEvent(
      state,
      terminalEvent,
      { currentRequestId: state.currentRun?.requestId },
    );
    transactions.push(transaction);
    state.currentRun = nextState.currentRun;
    state.pendingVehicleExecutionsByComponent = nextState.pendingVehicleExecutionsByComponent;
    state.dispatchedVehicleCommandsByCommandId = nextState.dispatchedVehicleCommandsByCommandId;
    state.verifiedVehicleTerminalsByCommandId = nextState.verifiedVehicleTerminalsByCommandId;
    state.confirmedVehicleStateSnapshot = nextState.confirmedVehicleStateSnapshot;
    runtimeState.applyAppRuntimeVehicleEventEffects(transaction, {
      applyPresentation(presentation) {
        presentationCalls.push(presentation);
      },
      renderMetrics() {
        metricsCalls.push(state.confirmedVehicleStateSnapshot);
      },
    });
    return { accepted: transaction.presentationAccepted === true, transaction };
  };
  const bridge = createBridge({
    state,
    interactionSessionController: controller,
    render() {
      return { speechPromise: Promise.resolve() };
    },
    applyVehiclePresentation,
  });
  const replaceCurrentRun = (nextRunId) => {
    currentTurn = Object.freeze({
      sessionId: `session:${nextRunId}`,
      turnId: `turn:${nextRunId}`,
      runId: nextRunId,
    });
    state.currentRun = { requestId: nextRunId, interactionTurn: currentTurn, events: [] };
  };
  return {
    bridge,
    metricsCalls,
    presentationCalls,
    replaceCurrentRun,
    state,
    transactions,
  };
}

function fixture(createBridge, runId, { onVoiceBridge } = {}) {
  const turn = Object.freeze({
    sessionId: `session:${runId}`,
    turnId: `turn:${runId}`,
    runId,
  });
  const links = [];
  const renders = [];
  const vehicleCalls = [];
  const voiceBridgeAuthorizations = [];
  const state = {
    mode: "idle",
    currentRun: { requestId: runId, interactionTurn: turn, events: [] },
    lastRunDetail: null,
    consumedRuntimeRequestIds: new Set(),
    pendingConfirmation: null,
    providerSnapshot: null,
  };
  let currentTurn = turn;
  const controller = {
    isCurrent(identity) {
      return identity?.sessionId === currentTurn.sessionId
        && identity?.turnId === currentTurn.turnId
        && identity?.runId === currentTurn.runId;
    },
    linkRun(turnId, input) {
      assert.equal(turnId, currentTurn.turnId);
      links.push(structuredClone(input));
      return { turnId, runId };
    },
  };
  const bridge = createBridge({
    state,
    interactionSessionController: controller,
    render(update) {
      renders.push(update);
      return { speechPromise: Promise.resolve() };
    },
    startVoiceBridge(authorization) {
      if (typeof onVoiceBridge === "function") return onVoiceBridge(authorization);
      voiceBridgeAuthorizations.push(structuredClone(authorization));
    },
    applyVehiclePresentation(input) {
      vehicleCalls.push(input);
      return { accepted: input.authorized === true };
    },
  });
  const replaceCurrentRun = (nextRunId) => {
    currentTurn = Object.freeze({
      sessionId: `session:${nextRunId}`,
      turnId: `turn:${nextRunId}`,
      runId: nextRunId,
    });
    state.currentRun = { requestId: nextRunId, interactionTurn: currentTurn, events: [] };
    return currentTurn;
  };
  return {
    bridge,
    controller,
    links,
    renders,
    replaceCurrentRun,
    state,
    turn,
    vehicleCalls,
    voiceBridgeAuthorizations,
  };
}

function runEvent(runId, sequence, overrides = {}) {
  const component = overrides.component;
  const modelComponents = new Set(["vehicleSluModel", "cabinModel", "orchestratorModel"]);
  const toolComponents = new Set(["vehicleTool", "externalDataAdapter"]);
  const componentType = ["cabinAssistant", "orchestrator"].includes(component)
    ? "ai-agent"
    : modelComponents.has(component) ? "model-service"
      : toolComponents.has(component) ? "tool-interface" : "deterministic-service";
  const metadata = Object.freeze({
    ...(overrides.metadata || {}),
    interactionRef: Object.freeze({
      sessionId: `session:${runId}`,
      turnId: `turn:${runId}`,
    }),
  });
  return Object.freeze({
    protocol: Object.freeze({ id: "nio-run-event", version: "2.0.0" }),
    eventId: `event:${runId}:${sequence}`,
    runId,
    parentEventId: sequence === 1 ? null : `event:${runId}:${sequence - 1}`,
    sequence,
    timestamp: `2026-08-05T12:00:00.${String(sequence).padStart(3, "0")}Z`,
    component,
    componentType,
    phase: overrides.phase,
    status: overrides.status,
    summary: overrides.summary || overrides.phase,
    refs: Object.freeze([...(overrides.refs || [])]),
    model: null,
    provider: null,
    durationMs: null,
    metadata,
  });
}

function vehicleCommand(runId) {
  return Object.freeze({
    requestId: runId,
    commandId: `${runId}:1:body.window.setPosition`,
    tool: "body.window.setPosition",
    args: Object.freeze({ zone: "front_left", percent: 50 }),
  });
}

function vehiclePendingEvent(command, sequence) {
  return runEvent(command.requestId, sequence, {
    component: "vehicleTool",
    phase: "vehicle-execution",
    status: "processing",
    metadata: { vehicle: { toolCall: command, commitmentState: "dispatching" } },
  });
}

function vehicleTerminalEvent(command, sequence, {
  executionState = "observed-succeeded",
  ok = true,
  confirmedSnapshotId = "snapshot:confirmed",
  cancellationRequested = false,
} = {}) {
  const requestedState = Object.freeze({
    windowPositionPercentByZone: Object.freeze({ front_left: 50 }),
  });
  const toolResult = {
    requestId: command.requestId,
    commandId: command.commandId,
    tool: command.tool,
    ok,
    executionState,
    requestedState,
    executionTrace: Object.freeze((ok ? [
      { state: "submitted", at: "2026-08-05T12:00:00.000Z" },
      { state: "accepted", at: "2026-08-05T12:00:00.001Z" },
      { state: "executing", at: "2026-08-05T12:00:00.002Z" },
      { state: executionState, at: "2026-08-05T12:00:00.003Z" },
    ] : [
      { state: "submitted", at: "2026-08-05T12:00:00.000Z" },
      { state: executionState, at: "2026-08-05T12:00:00.003Z" },
    ]).map((entry) => Object.freeze({ ...entry, source: "demo-vehicle-adapter" }))),
  };
  if (confirmedSnapshotId) toolResult.confirmedSnapshotId = confirmedSnapshotId;
  return runEvent(command.requestId, sequence, {
    component: "vehicleTool",
    phase: "vehicle-execution",
    status: ok ? "completed" : executionState === "timeout" ? "uncertain"
      : executionState === "cancelled" ? "cancelled" : "failed",
    metadata: {
      vehicle: {
        toolResult: Object.freeze(toolResult),
        commitmentState: ok ? "provider-terminal" : "dispatching",
        cancellation: Object.freeze({
          requested: cancellationRequested,
          physicalUndoClaimed: false,
        }),
      },
    },
  });
}

function providerSnapshot(id, percent) {
  return Object.freeze({
    id,
    source: "demo-sensor-simulator",
    simulated: true,
    capturedAt: "2026-08-05T12:00:00.005Z",
    capturedAtByField: Object.freeze({
      windowPositionPercentByZone: "2026-08-05T12:00:00.005Z",
    }),
    values: Object.freeze({
      windowPositionPercentByZone: Object.freeze({ front_left: percent }),
    }),
  });
}

function runtimeResult(runId, overrides = {}) {
  return Object.freeze({
    requestId: runId,
    rawText: "test",
    interactionRef: Object.freeze({
      sessionId: `session:${runId}`,
      turnId: `turn:${runId}`,
    }),
    routeDecision: Object.freeze({ routeId: "vehicle-control", mode: "direct" }),
    parsedCommand: Object.freeze({ intent: "body.window.setPosition", slots: Object.freeze({}) }),
    assistantResponse: "",
    safetyDecision: null,
    toolCall: null,
    toolResult: null,
    vehicleStateSnapshot: null,
    runtimeTelemetry: Object.freeze({ modelCallCount: 0, modelCalls: Object.freeze([]), eventCount: 0 }),
    events: Object.freeze([]),
    ...overrides,
  });
}
