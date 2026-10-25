import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launchChromium } from "../lib/playwright-loader.mjs";
import {
  createHmiVehicleSluFixtureResponse,
  createHmiVehicleSluFrame,
  loadHmiVehicleSluFixtureProfile,
} from "../lib/hmi-test-helpers.mjs";
import { buildInteractionSessionDebugSnapshot } from "../../src/app/run-event-presenter.js";
import { VOICE_BRIDGE_POLICY } from "../../src/voice/voice-output-adapter.js";

const staticOnly = process.argv.includes("--static-only");
const baseUrl = (process.env.NIO_AGENT_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");

const [html, app, presenter, voice] = await Promise.all([
  readFile(new URL("../../index.html", import.meta.url), "utf8"),
  readFile(new URL("../../src/app/app.js", import.meta.url), "utf8"),
  readFile(new URL("../../src/app/run-event-presenter.js", import.meta.url), "utf8"),
  readFile(new URL("../../src/voice/voice-output-adapter.js", import.meta.url), "utf8"),
]);

assert.match(html, /data-testid="interaction-session-status"/);
assert.match(html, /data-testid="stop-current-task"/);
assert.match(app, /InteractionSessionController/);
assert.doesNotMatch(app, /state\.running\)\s*\{\s*setRunFeedback\("正在处理本次指令"\);\s*return;/);
assert.match(app, /BrowserTranscriptWakeWordProvider/);
assert.match(app, /requestCancellation\("user-cancelled"\)/);
assert.match(app, /closeSession\(\{\s*reasonCode:\s*"user-cancelled"\s*\}\)/,
  "an explicit cancel without an active turn must close the listening session");
assert.match(app, /const requestId = turn\.runId;/,
  "the controller runId must be the canonical Runtime requestId");
assert.match(app, /interactionRef:\s*\{\s*sessionId:\s*turn\.sessionId,\s*turnId:\s*turn\.turnId\s*\}/,
  "Runtime runs must carry the exact interaction reference");
assert.match(app, /clarificationSessionId:\s*sessionId/,
  "Runtime runs must scope pending clarification to the stable browser conversation identity");
assert.match(app, /runtime\.cancelPendingClarification\(sessionId,\s*"user-cancelled"\)/,
  "explicit cancel and stop-current-task must clear the stable pending clarification");
assert.match(app, /runtime\.cancelPendingClarification\(sessionId,\s*"explicit-close"\)/,
  "explicit close must clear the stable pending clarification");
assert.doesNotMatch(app, /cancelPendingClarification\(snapshot\.sessionId\s*\|\|\s*sessionId/,
  "five-second interaction identities must never be used for clarification cleanup");
const stopCurrentTaskHandler = app.match(
  /stopCurrentTaskButton\?\.addEventListener\("click",\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/,
)?.[1] || "";
assert.ok(stopCurrentTaskHandler,
  "the stop-current-task handler must remain statically inspectable");
assert.ok(
  stopCurrentTaskHandler.indexOf('runtime.cancelPendingClarification(sessionId, "user-cancelled")')
    < stopCurrentTaskHandler.indexOf('requestCancellation("user-cancelled")'),
  "stop-current-task must clear pending before aborting an active Runtime/TTS turn",
);
assert.match(app, /function isCurrentRuntimeInteraction\(requestId, interactionRef\)/,
  "Runtime events and ledger projections must share one current-interaction guard");
assert.match(app, /waitForVoicePlaybackCompletion\(voiceOutputAdapter/,
  "the HMI must await real playback completion before completing a Turn");
assert.match(app, /result\.requestId !== runId/,
  "result application must reject a non-canonical request before writes");
assert.match(app, /result\.interactionRef\?\.sessionId !== sessionId/);
assert.match(app, /result\.interactionRef\?\.turnId !== turnId/);
assert.match(app, /previousSession\?\.sessionId\s*\|\|\s*sessionId/,
  "clear-memory must retain the just-closed interaction session identity");
assert.match(app, /voiceOutputAdapter\.stop\(\{\s*reason:\s*"barge-in-replaced"\s*\}\)/);
assert.match(app, /interactionSession:/);
assert.match(app, /currentTurn:/);
assert.match(app, /queuedTurn:/);
assert.match(app, /interactionEvents:/);
assert.doesNotMatch(app, /__interactionDebug/);
assert.match(presenter, /buildInteractionSessionDebugSnapshot/);
assert.match(voice, /thresholdMs:\s*500/);
assert.equal(VOICE_BRIDGE_POLICY.thresholdMs, 500);
assert.equal(VOICE_BRIDGE_POLICY.maxPrebakedAssetsPerTurn, 1);
const safeInteraction = buildInteractionSessionDebugSnapshot({
  state: "processing",
  sessionId: "session:1",
  activeTurn: {
    sessionId: "session:1",
    turnId: "turn:1",
    runId: "run:1",
    trigger: "wake-word",
    relation: "new-goal",
    signal: { rawSecret: "SIGNAL_SECRET" },
  },
  pendingReplacementTurn: null,
  currentSession: {
    events: [{
      interactionEventId: "interaction-event:1",
      sessionId: "session:1",
      turnId: "turn:1",
      runId: "run:1",
      sequence: 1,
      timestamp: "2026-07-30T00:00:00.000Z",
      participantId: "interactionSession",
      phase: "turn-submitted",
      status: "thinking",
      data: { rawText: "RAW_TRANSCRIPT_SECRET" },
    }],
  },
});
assert.doesNotMatch(JSON.stringify(safeInteraction), /SIGNAL_SECRET|RAW_TRANSCRIPT_SECRET/);
assert.match(await readFile(new URL(import.meta.url), "utf8"), /BROWSER_TOTAL_TIMEOUT_MS/);
assert.match(await readFile(new URL(import.meta.url), "utf8"), /runBoundedStep/);
assert.match(app, /adapterAcceptedCount/);
const verifierSource = await readFile(new URL(import.meta.url), "utf8");
assert.match(verifierSource, /__acceptanceSpeechHold/);
assert.match(verifierSource, /__acceptanceFinishSpeech/);
assert.equal(verifierSource.includes("page." + "waitForTimeout(25)"), false);

if (staticOnly) {
  console.log(JSON.stringify({ static: "PASS", browser: "SKIPPED (--static-only)" }, null, 2));
  process.exit(0);
}

const BROWSER_WAIT_TIMEOUT_MS = 20_000;
const BROWSER_TOTAL_TIMEOUT_MS = 120_000;

async function runBoundedStep(label, operation, timeoutMs = BROWSER_WAIT_TIMEOUT_MS) {
  let timeoutId;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

try {
  const response = await runBoundedStep(
    "service preflight",
    () => fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(3_000) }),
    4_000,
  );
  assert.ok(response.ok, `GET / returned HTTP ${response.status}`);
} catch (error) {
  throw new Error(
    `Cannot reach the already-running ${baseUrl} service. This verifier never starts or stops services. Cause: ${error.message}`,
  );
}
const vehicleSluProfile = await loadHmiVehicleSluFixtureProfile(baseUrl);

let browser;
try {
  await runBoundedStep("browser acceptance total", async () => {
    browser = await runBoundedStep("launch Chromium", () => launchChromium({ headless: true }));
    const page = await runBoundedStep("create page", () => browser.newPage());
    const browserDiagnostics = [];
    page.on("console", (message) => browserDiagnostics.push({ type: `console:${message.type()}`, text: message.text() }));
    page.on("pageerror", (error) => browserDiagnostics.push({ type: "pageerror", text: error.message }));
    await runBoundedStep("install API route", () => page.route("**/api/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.pathname === "/api/model-provider-profile") {
        await route.continue();
        return;
      }
      if (requestUrl.pathname === "/api/local-semantic") {
        const request = route.request().postDataJSON();
        const text = String(request.text || "").trim();
        let domain = "non_vehicle";
        let conversationGoal = { summary: text, need: "social" };
        let vehicleFrames = [];
        if (text.includes("车辆是否处于驻车状态")) {
          domain = "vehicle";
          conversationGoal = { summary: "查询当前驻车状态", need: "explain" };
          vehicleFrames = [createHmiVehicleSluFrame({
            frameId: `state-${request.requestId}`,
            capability: "knowledge",
            intent: "vehicle.state.query",
            speechAct: "question",
            slots: { stateFields: ["gear"] },
          })];
        } else if (text.includes("主驾车窗")) {
          domain = "vehicle";
          conversationGoal = { summary: "将主驾车窗打开到一半", need: "none" };
          vehicleFrames = [createHmiVehicleSluFrame({
            frameId: `window-${request.requestId}`,
            capability: "control",
            intent: "body.window.setPosition",
            speechAct: "command",
            actionNeed: "execute",
            slots: { zone: "front_left", percent: 50 },
          })];
        }
        const response = createHmiVehicleSluFixtureResponse({
          profile: vehicleSluProfile,
          requestId: request.requestId,
          domain,
          conversationGoal,
          vehicleFrames,
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(response),
        });
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "acceptance-offline" }),
      });
    }));
    await runBoundedStep("install browser doubles", () => page.addInitScript(() => {
      class AcceptanceSpeechRecognition {
        constructor() { window.__acceptanceRecognition = this; }
        start() { this.onstart?.(); }
        stop() { this.onend?.(); }
        emit(text) {
          this.onresult?.({ resultIndex: 0, results: [[{ transcript: text }]] });
          this.onend?.();
        }
      }
      window.SpeechRecognition = AcceptanceSpeechRecognition;
      window.SpeechSynthesisUtterance = class {
        constructor(text) { this.text = text; }
      };
      window.__acceptanceSpeechHold = false;
      window.__acceptancePendingSpeech = [];
      window.__acceptanceFinishSpeech = () => {
        window.__acceptanceSpeechHold = false;
        const pending = window.__acceptancePendingSpeech.splice(0);
        pending.forEach((utterance) => utterance.onend?.());
      };
      const acceptanceSpeechSynthesis = {
        __acceptanceDouble: true,
        cancel() { window.__acceptancePendingSpeech.splice(0); }, pause() {}, resume() {},
        speak(utterance) {
          utterance.onstart?.();
          if (window.__acceptanceSpeechHold) window.__acceptancePendingSpeech.push(utterance);
          else setTimeout(() => utterance.onend?.(), 0);
        },
      };
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: acceptanceSpeechSynthesis,
      });
      window.__acceptanceSpeechSynthesisInstalled = window.speechSynthesis === acceptanceSpeechSynthesis;
      window.NIO_B2_ACCEPTANCE_INSTRUMENTATION = true;
      window.NIO_LOCAL_MODEL_WATCHDOG_MS = 2_000;
      window.NIO_LOCAL_LLM_TIMEOUT_MS = 100;
      window.NIO_B2_STRUCTURED_TIMEOUT_MS = 150;
    }));
    await runBoundedStep("open HMI", () => page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" }));
    await runBoundedStep("wait for public debug", () => page.waitForFunction(
      () => typeof window.__runtimeDebug === "function" && typeof window.runCommand === "function",
      null,
      { timeout: BROWSER_WAIT_TIMEOUT_MS },
    ));
    assert.equal(
      await runBoundedStep("verify speech double installation", () => page.evaluate(
        () => window.__acceptanceSpeechSynthesisInstalled === true
          && window.speechSynthesis?.__acceptanceDouble === true,
      )),
      true,
      "the controlled SpeechSynthesis double must replace Chromium's read-only accessor",
    );

    const waitForState = (label, state, timeout = BROWSER_WAIT_TIMEOUT_MS) => runBoundedStep(
      label,
      () => page.waitForFunction(
        (expected) => window.__runtimeDebug().interactionSession.state === expected,
        state,
        { timeout },
      ),
      timeout + 1_000,
    );
    const emitVoice = async (label, text) => {
      await runBoundedStep(`${label}: start recognition`, () => page.getByRole("button", { name: "开始语音输入" }).click());
      await runBoundedStep(`${label}: emit transcript`, () => page.evaluate(
        (transcript) => window.__acceptanceRecognition.emit(transcript),
        text,
      ));
    };
    const awaitWindowPromise = (label, name) => runBoundedStep(
      label,
      () => page.evaluate((property) => window[property], name),
    );

    const scenarios = {};

    // 11.5.1 NOMI 后提出只读问题：只能读，不得调用 Vehicle execution。
    const readOnlyBaseline = await runBoundedStep("read-only baseline", () => page.evaluate(() => ({
      toolCalls: window.__b2AcceptanceCalls.toolCallCount,
    })));
    await emitVoice("NOMI read-only", "NOMI，你是谁？");
    await waitForState("read-only response completed", "follow-up-window");
    scenarios.nomiPassiveReadOnly = await runBoundedStep("assert NOMI read-only", () => page.evaluate((baseline) => {
      const debug = window.__runtimeDebug();
      return debug.interactionSession.sessionId !== null
        && debug.lastRuntimeResult?.toolCall == null
        && window.__b2AcceptanceCalls.toolCallCount === baseline.toolCalls
        && debug.interactionEvents.some((event) => event.phase === "session-awakened")
        && debug.interactionEvents.some((event) => event.phase === "turn-completed");
    }, readOnlyBaseline));

    // 11.5.2 播报中打断并追问：旧 Turn 取消，新 Turn 完成。
    await runBoundedStep("hold browser speech", () => page.evaluate(() => {
      window.__acceptanceSpeechHold = true;
    }));
    await runBoundedStep("start speaking turn", () => page.evaluate(() => {
      window.__speakingRun = window.runCommand("请简短介绍一下 NOMI");
    }));
    try {
      await runBoundedStep("wait for controlled playback onstart", () => page.waitForFunction(() => {
        const debug = window.__runtimeDebug();
        return debug.latestRun?.ttsTelemetry?.status === "playing"
          && debug.interactionSession.state === "speaking"
          && debug.interactionSession.followUpDeadlineAt === null;
      }, null, { timeout: BROWSER_WAIT_TIMEOUT_MS }));
    } catch (error) {
      const snapshot = await page.evaluate(() => ({
        debug: window.__runtimeDebug(),
        pendingSpeech: window.__acceptancePendingSpeech?.map((utterance) => utterance.text) || [],
        speechHold: window.__acceptanceSpeechHold,
        speechSynthesisInstalled: window.__acceptanceSpeechSynthesisInstalled,
        speechSynthesisMarker: window.speechSynthesis?.__acceptanceDouble === true,
        acceptanceCalls: window.__b2AcceptanceCalls,
      })).catch((diagnosticError) => ({ diagnosticError: diagnosticError.message }));
      console.error(JSON.stringify({ browserDiagnostics: browserDiagnostics.slice(-12), snapshot }, null, 2));
      throw error;
    }
    const speakingTurnId = await runBoundedStep("capture speaking turn", () => page.evaluate(
      () => window.__runtimeDebug().currentTurn.turnId,
    ));
    await emitVoice("speaking barge-in", "再简短一点");
    await runBoundedStep("release replacement speech", () => page.evaluate(() => {
      window.__acceptanceFinishSpeech();
    }));
    await waitForState("barge-in response completed", "follow-up-window");
    const speakingBargeInEvidence = await runBoundedStep("assert speaking barge-in", () => page.evaluate((oldTurnId) => {
      const debug = window.__runtimeDebug();
      const completed = debug.interactionEvents.findLast((event) => event.phase === "turn-completed");
      const cancelled = debug.interactionEvents.find((event) => event.turnId === oldTurnId
        && event.phase === "turn-cancelled");
      return {
        cancelled,
        completed,
        currentState: debug.interactionSession.state,
      };
    }, speakingTurnId));
    scenarios.speakingBargeIn = speakingBargeInEvidence.cancelled?.reasonCode === "barge-in-replaced"
      && Boolean(speakingBargeInEvidence.completed?.turnId)
      && speakingBargeInEvidence.completed.turnId !== speakingTurnId;
    await awaitWindowPromise("settle speaking turn promise", "__speakingRun");

    // 11.5.3 模型处理中明确取消：取消文本本身不创建第二个 Runtime。
    const processingCancel = await runBoundedStep("explicit processing cancel", () => page.evaluate(() => {
      const before = window.__runtimeDebug().interactionEvents.filter((event) => event.phase === "turn-submitted").length;
      window.__processingCancelRun = window.runCommand("请详细说明你的能力边界");
      const turnId = window.__runtimeDebug().currentTurn.turnId;
      window.__processingCancelCommand = window.runCommand("取消", { inputSource: "voice" });
      return { before, turnId };
    }));
    await awaitWindowPromise("settle explicitly cancelled run", "__processingCancelRun");
    scenarios.processingExplicitCancel = await runBoundedStep("assert explicit processing cancel", () => page.evaluate(({ before, turnId }) => {
      const events = window.__runtimeDebug().interactionEvents;
      return events.filter((event) => event.phase === "turn-submitted").length === before + 1
        && events.some((event) => event.turnId === turnId
          && event.phase === "turn-cancelled" && event.reasonCode === "user-cancelled");
    }, processingCancel));

    // 11.5.4 运行中提交完整新目标：最后提交的目标拥有唯一完成结果。
    const replacement = await runBoundedStep("submit complete replacement goal", () => page.evaluate(() => {
      window.__replacedRun = window.runCommand("请完整介绍座舱助手");
      const oldTurnId = window.__runtimeDebug().currentTurn.turnId;
      window.__replacementRun = window.runCommand("告诉我当前车辆是否处于驻车状态");
      const latest = window.__runtimeDebug().currentTurn;
      return { oldTurnId, latestTurnId: latest.turnId, latestRunId: latest.runId };
    }));
    await awaitWindowPromise("settle complete replacement goal", "__replacementRun");
    await waitForState("replacement goal completed", "follow-up-window");
    scenarios.runningCompleteNewGoal = await runBoundedStep("assert complete replacement goal", () => page.evaluate((ids) => {
      const debug = window.__runtimeDebug();
      return debug.lastRuntimeResult?.requestId === ids.latestRunId
        && debug.interactionEvents.some((event) => event.turnId === ids.oldTurnId
          && event.phase === "turn-cancelled" && event.reasonCode === "barge-in-replaced")
        && debug.interactionEvents.some((event) => event.turnId === ids.latestTurnId
          && event.phase === "turn-completed");
    }, replacement));
    await awaitWindowPromise("settle replaced goal", "__replacedRun");

    // 11.5.5 车辆命令 dispatch 前取消：无 pending execution，也没有 ToolCall。
    const preDispatch = await runBoundedStep("cancel vehicle before dispatch", () => page.evaluate(() => {
      const before = window.__b2AcceptanceCalls.toolCallCount;
      window.__preDispatchRun = window.runCommand("帮我打开主驾车窗到一半");
      const turnId = window.__runtimeDebug().currentTurn.turnId;
      document.querySelector('[data-testid="stop-current-task"]').click();
      return { before, turnId };
    }));
    await awaitWindowPromise("settle pre-dispatch cancellation", "__preDispatchRun");
    scenarios.vehiclePreDispatchCancel = await runBoundedStep("assert pre-dispatch cancellation", () => page.evaluate(({ before, turnId }) => {
      const debug = window.__runtimeDebug();
      return debug.pendingVehicleExecutionCount === 0
        && window.__b2AcceptanceCalls.toolCallCount === before
        && debug.interactionEvents.some((event) => event.turnId === turnId
          && event.phase === "turn-cancelled" && event.reasonCode === "user-cancelled");
    }, preDispatch));

    // 11.5.6 Adapter 接受后取消：pending 先出现，取消后仍消费 Provider terminal observation。
    const adapterAccepted = await runBoundedStep("start adapter-accepted vehicle run", () => page.evaluate(() => {
      const debug = window.__runtimeDebug();
      window.__adapterAcceptedRun = window.runCommand("把主驾车窗打开到一半");
      return {
        providerCalls: window.__b2AcceptanceCalls.providerCallCount,
        providerSnapshotId: debug.providerScenarioSnapshot?.id || null,
        adapterAcceptedCount: window.__b2AcceptanceCalls.adapterAcceptedCount,
      };
    }));
    try {
      await runBoundedStep("wait for pending vehicle execution", () => page.waitForFunction(
        () => window.__runtimeDebug().pendingVehicleExecutionCount === 1,
        null,
        { timeout: BROWSER_WAIT_TIMEOUT_MS },
      ));
    } catch (error) {
      const snapshot = await page.evaluate(() => {
        const debug = window.__runtimeDebug();
        return {
          interactionSession: debug.interactionSession,
          currentTurn: debug.currentTurn,
          pendingVehicleExecutionCount: debug.pendingVehicleExecutionCount,
          pendingVehicleExecutionFingerprint: debug.pendingVehicleExecutionFingerprint,
          providerScenarioSnapshot: debug.providerScenarioSnapshot,
          lastRuntimeResult: debug.lastRuntimeResult,
          latestRun: debug.latestRun,
          interactionEvents: debug.interactionEvents,
          acceptanceCalls: window.__b2AcceptanceCalls,
        };
      }).catch((diagnosticError) => ({ diagnosticError: diagnosticError.message }));
      console.error(JSON.stringify({
        scenario: "adapter-accepted",
        browserDiagnostics: browserDiagnostics.slice(-12),
        snapshot,
      }, null, 2));
      throw error;
    }
    await runBoundedStep("wait for Adapter accepted", () => page.waitForFunction(
      (baseline) => window.__b2AcceptanceCalls.adapterAcceptedCount > baseline,
      adapterAccepted.adapterAcceptedCount,
      { timeout: BROWSER_WAIT_TIMEOUT_MS },
    ));
    const adapterTurnId = await runBoundedStep("cancel adapter-accepted turn", () => page.evaluate(() => {
      const turnId = window.__runtimeDebug().currentTurn.turnId;
      document.querySelector('[data-testid="stop-current-task"]').click();
      return turnId;
    }));
    try {
      await runBoundedStep("wait for Provider terminal after cancel", () => page.waitForFunction(
        (baseline) => {
          const debug = window.__runtimeDebug();
          return debug.pendingVehicleExecutionCount === 0
            && window.__b2AcceptanceCalls.providerCallCount > baseline.providerCalls
            && debug.providerScenarioSnapshot?.id !== baseline.providerSnapshotId
            && window.__b2AcceptanceCalls.lastVehicleTerminalTransaction?.handled === true
            && window.__b2AcceptanceCalls.lastVehicleTerminalTransaction?.contractValid === true;
        },
        adapterAccepted,
        { timeout: BROWSER_WAIT_TIMEOUT_MS },
      ));
    } catch (error) {
      const snapshot = await page.evaluate(({ baseline, turnId }) => {
        const debug = window.__runtimeDebug();
        return {
          baseline,
          turnId,
          pendingVehicleExecutionCount: debug.pendingVehicleExecutionCount,
          pendingVehicleExecutionFingerprint: debug.pendingVehicleExecutionFingerprint,
          providerScenarioSnapshotId: debug.providerScenarioSnapshot?.id || null,
          acceptanceCalls: {
            safetyCallCount: window.__b2AcceptanceCalls.safetyCallCount,
            toolCallCount: window.__b2AcceptanceCalls.toolCallCount,
            providerCallCount: window.__b2AcceptanceCalls.providerCallCount,
            adapterAcceptedCount: window.__b2AcceptanceCalls.adapterAcceptedCount,
            lastVehicleTerminalTransaction:
              window.__b2AcceptanceCalls.lastVehicleTerminalTransaction,
          },
        };
      }, { baseline: adapterAccepted, turnId: adapterTurnId })
        .catch((diagnosticError) => ({ diagnosticError: diagnosticError.message }));
      console.error(JSON.stringify({
        scenario: "provider-terminal-after-cancel",
        browserDiagnostics: browserDiagnostics.slice(-12),
        snapshot,
      }, null, 2));
      throw error;
    }
    await awaitWindowPromise("settle adapter-accepted cancellation", "__adapterAcceptedRun");
    scenarios.adapterAcceptedCancelProviderObserved = await runBoundedStep(
      "assert adapter-accepted Provider observation",
      () => page.evaluate(({ baseline, turnId }) => {
        const debug = window.__runtimeDebug();
        return debug.pendingVehicleExecutionCount === 0
          && window.__b2AcceptanceCalls.providerCallCount > baseline.providerCalls
          && debug.providerScenarioSnapshot?.id !== baseline.providerSnapshotId
          && window.__b2AcceptanceCalls.lastVehicleTerminalTransaction?.handled === true
          && window.__b2AcceptanceCalls.lastVehicleTerminalTransaction?.contractValid === true
          && debug.interactionEvents.some((event) => event.turnId === turnId
            && event.phase === "turn-cancelled" && event.reasonCode === "user-cancelled");
      }, { baseline: adapterAccepted, turnId: adapterTurnId }),
    );

    // 11.5.7 回复结束后 5 秒内续聊：同一 Session、follow-up relation。
    await runBoundedStep("start follow-up baseline response", () => page.evaluate(() => {
      window.__followUpBaselineRun = window.runCommand("请说一句欢迎语");
    }));
    await awaitWindowPromise("settle follow-up baseline", "__followUpBaselineRun");
    await waitForState("follow-up baseline completed", "follow-up-window");
    const followUpSessionId = await runBoundedStep("capture follow-up session", () => page.evaluate(
      () => window.__runtimeDebug().interactionSession.sessionId,
    ));
    await emitVoice("within-five-second follow-up", "再说一句");
    const followUpTurn = await runBoundedStep("capture follow-up turn", () => page.evaluate(
      () => window.__runtimeDebug().currentTurn,
    ));
    await waitForState("within-five-second follow-up completed", "follow-up-window");
    scenarios.withinFiveSecondFollowUp = followUpTurn?.relation === "follow-up"
      && followUpTurn.sessionId === followUpSessionId;

    // 11.5.8 窗口过期后普通谈话不触发；再次 NOMI 才建立新 Session。
    // Ambient (non push-to-talk) speech is simulated here: an explicit microphone press
    // is an intentional HMI action and opens a session by design, so it must not be used.
    try {
      await waitForState("follow-up window expires", "dormant", 8_000);
    } catch (error) {
      const snapshot = await page.evaluate(() => {
        const debug = window.__runtimeDebug();
        return {
          now: new Date().toISOString(),
          interactionSession: debug.interactionSession,
          currentTurn: debug.currentTurn,
          queuedTurn: debug.queuedTurn,
          recentInteractionEvents: debug.interactionEvents.slice(-12),
          pendingSpeech: window.__acceptancePendingSpeech?.map((utterance) => utterance.text) || [],
          speechHold: window.__acceptanceSpeechHold,
        };
      }).catch((diagnosticError) => ({ diagnosticError: diagnosticError.message }));
      console.error(JSON.stringify({
        scenario: "follow-up-expiry",
        browserDiagnostics: browserDiagnostics.slice(-12),
        snapshot,
      }, null, 2));
      throw error;
    }
    const expired = await runBoundedStep("capture expired session", () => page.evaluate(() => ({
      previousSessionId: window.__runtimeDebug().interactionEvents[0]?.sessionId || null,
      eventCount: window.__runtimeDebug().interactionEvents.length,
    })));
    const emitAmbientVoice = (label, text) => runBoundedStep(label, () => page.evaluate(
      (transcript) => window.runCommand(transcript, { inputSource: "voice" }),
      text,
    ));
    await emitAmbientVoice("ordinary speech after expiry", "你好，还在吗？");
    await runBoundedStep("settle ignored ordinary speech", () => page.waitForTimeout(50), 1_000);
    const ignoredAfterExpiry = await runBoundedStep("assert ordinary speech ignored", () => page.evaluate((eventCount) => {
      const debug = window.__runtimeDebug();
      return debug.interactionSession.state === "dormant"
        && debug.currentTurn === null
        && debug.interactionEvents.length === eventCount;
    }, expired.eventCount));
    await emitAmbientVoice("NOMI restart after expiry", "NOMI，你还在吗？");
    const restarted = await runBoundedStep("observe NOMI restart", () => page.evaluate(() => {
      const debug = window.__runtimeDebug();
      return {
        sessionId: debug.interactionSession.sessionId,
        awakened: debug.interactionEvents.some((event) => event.phase === "session-awakened"),
      };
    }));
    scenarios.afterExpiryIgnoredThenNomiRestarts = ignoredAfterExpiry
      && restarted.awakened
      && restarted.sessionId !== null
      && restarted.sessionId !== expired.previousSessionId;

    assert.equal(await runBoundedStep("assert no secondary debug API", () => page.evaluate(
      () => typeof window.__interactionDebug,
    )), "undefined");
    assert.deepEqual(
      browserDiagnostics.filter((item) => item.type === "pageerror"),
      [],
      "browser acceptance must not leave uncaught page errors",
    );
    if (Object.values(scenarios).some((passed) => passed !== true)) {
      console.error(JSON.stringify({
        scenario: "final-assertion",
        scenarios,
        speakingTurnId,
        speakingBargeInEvidence,
        followUpSessionId,
        followUpTurn,
      }, null, 2));
    }
    assert.deepEqual(
      Object.values(scenarios),
      Array(8).fill(true),
      `browser design 11.5 scenarios failed: ${JSON.stringify(scenarios)}`,
    );
    console.log(JSON.stringify({ static: "PASS", browser: "PASS", scenarios }, null, 2));
  }, BROWSER_TOTAL_TIMEOUT_MS);
} finally {
  await runBoundedStep("close Chromium", () => browser?.close(), 5_000).catch(() => {});
}
