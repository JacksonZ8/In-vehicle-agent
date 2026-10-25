import assert from "node:assert/strict";
import { InteractionSessionController } from "../../src/interaction/interaction-session-controller.js";
import { InteractionSessionLedger } from "../../src/interaction/interaction-session-ledger.js";

function createManualTimers(startAt = Date.parse("2026-07-30T00:00:00.000Z")) {
  let current = startAt;
  let nextTimerId = 1;
  const scheduled = new Map();

  return {
    now: () => current,
    setTimer(callback, delayMs) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      scheduled.set(timerId, { callback, dueAt: current + delayMs });
      return timerId;
    },
    clearTimer(timerId) {
      scheduled.delete(timerId);
    },
    advance(delayMs) {
      const target = current + delayMs;
      while (true) {
        const next = [...scheduled.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
        if (!next) break;
        const [timerId, timer] = next;
        scheduled.delete(timerId);
        current = timer.dueAt;
        timer.callback();
      }
      current = target;
    },
    get pendingCount() {
      return scheduled.size;
    },
  };
}

function createSequentialIds() {
  let sequence = 0;
  return (kind) => `${kind}:${++sequence}`;
}

function createHarness() {
  const timers = createManualTimers();
  const ledger = new InteractionSessionLedger();
  const controller = new InteractionSessionController({
    ledger,
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    createId: createSequentialIds(),
  });
  return { controller, ledger, timers };
}

{
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let scheduledCallback = null;
  let clearedTimerId = null;
  globalThis.setTimeout = function browserLikeSetTimeout(callback, delayMs) {
    assert.strictEqual(this, globalThis, "browser timer must retain its Window receiver");
    assert.equal(delayMs, 5_000);
    scheduledCallback = callback;
    return 91;
  };
  globalThis.clearTimeout = function browserLikeClearTimeout(timerId) {
    assert.strictEqual(this, globalThis, "browser timer clear must retain its Window receiver");
    clearedTimerId = timerId;
  };
  try {
    const controller = new InteractionSessionController({
      ledger: new InteractionSessionLedger(),
      createId: createSequentialIds(),
    });
    controller.wake({ provider: "browser-timer-test", simulated: true });
    const turn = controller.submitTurn({
      rawText: "验证浏览器计时器",
      trigger: "wake-word",
      relation: "new-goal",
    });
    controller.completeTurn(turn.turnId, { outputMode: "text" });
    assert.equal(typeof scheduledCallback, "function");
    controller.startListening();
    assert.equal(clearedTimerId, 91);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

{
  const { controller, timers } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  assert.equal(controller.getSnapshot().state, "listening");

  const turn = controller.submitTurn({
    rawText: "你好",
    trigger: "wake-word",
    relation: "new-goal",
  });
  assert.equal(controller.getSnapshot().state, "processing");
  assert.equal(turn.signal.aborted, false);
  assert.deepEqual(Object.keys(turn).sort(), [
    "deadlineAt", "relation", "runId", "sessionId", "signal", "trigger", "turnId",
  ]);

  controller.completeTurn(turn.turnId, { outputMode: "text" });
  assert.equal(controller.getSnapshot().state, "follow-up-window");
  timers.advance(4_999);
  assert.equal(controller.getSnapshot().state, "follow-up-window");
  timers.advance(1);
  assert.equal(controller.getSnapshot().state, "dormant");
  assert.equal(controller.getSnapshot().currentSession, null);
  assert.equal(controller.getSnapshot().previousSession.status, "closed");
}

{
  const { controller } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  controller.closeSession();

  const closedEvent = controller.getSnapshot().previousSession.events.at(-1);
  assert.equal(closedEvent.phase, "session-closed");
  assert.equal(closedEvent.turnId, null);
  assert.equal(closedEvent.runId, null);
}

{
  const { controller, timers } = createHarness();
  controller.wake({ provider: "test-wake", simulated: false });
  const turn = controller.submitTurn({
    rawText: "打开空调",
    trigger: "wake-word",
    relation: "new-goal",
  });
  controller.completeTurn(turn.turnId, { outputMode: "voice" });
  assert.equal(timers.pendingCount, 1);

  controller.startListening();
  assert.equal(controller.getSnapshot().state, "listening");
  assert.equal(timers.pendingCount, 0);
  timers.advance(5_000);
  assert.equal(controller.getSnapshot().state, "listening");
}

{
  const { controller, timers } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  const turn = controller.submitTurn({
    rawText: "完成后继续听",
    trigger: "wake-word",
    relation: "new-goal",
  });
  controller.subscribe((_snapshot, event) => {
    if (event.phase === "follow-up-window-opened") controller.startListening();
  });

  controller.completeTurn(turn.turnId, { outputMode: "text" });
  assert.equal(controller.getSnapshot().state, "listening");
  assert.equal(controller.getSnapshot().followUpDeadlineAt, null);
  assert.equal(timers.pendingCount, 0);
  timers.advance(5_000);
  assert.equal(controller.getSnapshot().state, "listening");
}

{
  const timers = createManualTimers();
  const backingLedger = new InteractionSessionLedger();
  const appendFailingLedger = {
    append(event) {
      if (event.phase === "follow-up-window-opened") {
        throw new Error("follow-up append failed");
      }
      return backingLedger.append(event);
    },
    getCurrentSession: () => backingLedger.getCurrentSession(),
    getPreviousSession: () => backingLedger.getPreviousSession(),
    closeSession: (...args) => backingLedger.closeSession(...args),
  };
  const controller = new InteractionSessionController({
    ledger: appendFailingLedger,
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    createId: createSequentialIds(),
  });
  controller.wake({ provider: "test-wake", simulated: true });
  const turn = controller.submitTurn({
    rawText: "触发 ledger 失败",
    trigger: "wake-word",
    relation: "new-goal",
  });

  assert.throws(
    () => controller.completeTurn(turn.turnId, { outputMode: "text" }),
    /follow-up append failed/,
  );
  assert.equal(timers.pendingCount, 0);
}

{
  const { controller, ledger } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  const turn = controller.submitTurn({
    rawText: "先失败再完成",
    trigger: "wake-word",
    relation: "new-goal",
  });

  assert.throws(
    () => controller.completeTurn(turn.turnId, {
      outputMode: "text",
      relatedRunEventIds: [null],
    }),
    /relatedRunEventIds must contain non-empty strings/,
  );
  controller.completeTurn(turn.turnId, { outputMode: "text" });
  assert.equal(controller.getSnapshot().state, "follow-up-window");

  const sequences = ledger.getCurrentSession().events.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_unused, index) => index + 1),
  );
}

{
  const { controller, ledger, timers } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  const active = controller.submitTurn({
    rawText: "导航去公司",
    trigger: "wake-word",
    relation: "new-goal",
  });
  const earlierReplacement = controller.submitTurn({
    rawText: "先找充电站",
    trigger: "barge-in",
    relation: "correction",
  });
  const retainedReplacement = controller.submitTurn({
    rawText: "改去机场",
    trigger: "barge-in",
    relation: "correction",
  });

  const queuedSnapshot = controller.getSnapshot();
  assert.equal(queuedSnapshot.activeTurn.turnId, active.turnId);
  assert.equal(queuedSnapshot.pendingReplacementTurn.turnId, retainedReplacement.turnId);
  assert.equal(earlierReplacement.signal.aborted, true);
  assert.equal(retainedReplacement.signal.aborted, false);
  assert.equal(
    ledger.getCurrentSession().events.filter((event) => (
      event.turnId === earlierReplacement.turnId
      && event.phase === "turn-cancelled"
      && event.reasonCode === "superseded-before-start"
    )).length,
    1,
  );

  controller.completeTurn(active.turnId, { outputMode: "text" });
  assert.equal(controller.getSnapshot().state, "processing");
  assert.equal(controller.getSnapshot().activeTurn.turnId, retainedReplacement.turnId);
  assert.equal(controller.getSnapshot().pendingReplacementTurn, null);
  assert.equal(timers.pendingCount, 0);
}

{
  const { controller, ledger } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  const activeTurn = controller.submitTurn({
    rawText: "导航去公司",
    trigger: "wake-word",
    relation: "new-goal",
  });
  const queuedReplacement = controller.submitTurn({
    rawText: "改去机场",
    trigger: "barge-in",
    relation: "correction",
  });

  assert.equal(controller.isCurrent(activeTurn), true);
  assert.equal(controller.isCurrent({ ...activeTurn, runId: "stale-run" }), false);
  assert.equal(controller.isCurrent(queuedReplacement), false);
  for (const malformed of [
    null,
    undefined,
    {},
    { ...activeTurn, turnId: "" },
    Object.assign([], activeTurn),
    { ...activeTurn, sessionId: new String(activeTurn.sessionId) },
  ]) {
    const before = controller.getSnapshot();
    const eventCount = ledger.getCurrentSession().events.length;
    assert.equal(controller.isCurrent(malformed), false);
    assert.deepEqual(controller.getSnapshot(), before, "identity checks must not mutate controller state");
    assert.equal(ledger.getCurrentSession().events.length, eventCount, "identity checks must not append events");
  }

  controller.requestCancellation("barge-in-replaced");
  assert.equal(controller.isCurrent(activeTurn), false);
  assert.equal(controller.isCurrent(queuedReplacement), true);
  controller.completeTurn(queuedReplacement.turnId, { outputMode: "text" });
  assert.equal(controller.isCurrent(queuedReplacement), false);
}

{
  const { controller, ledger } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  const turn = controller.submitTurn({
    rawText: "停止",
    trigger: "wake-word",
    relation: "new-goal",
  });
  let abortCount = 0;
  turn.signal.addEventListener("abort", () => {
    abortCount += 1;
  });

  controller.requestCancellation("turn-deadline-exceeded");
  assert.equal(turn.signal.aborted, true);
  assert.equal(abortCount, 1);
  assert.throws(() => controller.requestCancellation(), /cannot request cancellation/);
  assert.equal(abortCount, 1);
  const cancellationEvents = ledger.getCurrentSession().events
    .filter((event) => (
      event.turnId === turn.turnId
      && ["turn-cancel-requested", "turn-cancelling", "turn-cancelled"].includes(event.phase)
    ));
  assert.deepEqual(
    cancellationEvents.map((event) => event.phase),
    ["turn-cancel-requested", "turn-cancelling", "turn-cancelled"],
  );
  assert.deepEqual(
    cancellationEvents.map((event) => event.reasonCode),
    ["turn-deadline-exceeded", "turn-deadline-exceeded", "turn-deadline-exceeded"],
  );
}

{
  const { controller } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  controller.submitTurn({
    rawText: "取消当前任务",
    trigger: "wake-word",
    relation: "new-goal",
  });
  const cancellationStates = [];
  controller.subscribe((snapshot, event) => {
    if (["turn-cancelling", "turn-cancelled"].includes(event.phase)) {
      cancellationStates.push(snapshot.state);
    }
  });

  controller.requestCancellation("user-cancelled");
  assert.deepEqual(cancellationStates, ["processing", "processing"]);
}

{
  const { controller, ledger } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  const turn = controller.submitTurn({
    rawText: "取消期间再次取消",
    trigger: "wake-word",
    relation: "new-goal",
  });
  let abortCount = 0;
  let reentered = false;
  let reentrantSnapshot = null;
  turn.signal.addEventListener("abort", () => {
    abortCount += 1;
  });
  controller.subscribe((_snapshot, event) => {
    if (event.phase === "turn-cancelling" && !reentered) {
      reentered = true;
      reentrantSnapshot = controller.requestCancellation("user-cancelled");
    }
  });

  controller.requestCancellation("user-cancelled");
  const events = ledger.getCurrentSession().events;
  for (const phase of [
    "turn-cancel-requested",
    "turn-cancelling",
    "turn-cancelled",
    "follow-up-window-opened",
  ]) {
    assert.equal(
      events.filter((event) => event.phase === phase).length,
      1,
      `${phase} must be emitted exactly once during cancellation re-entry`,
    );
  }
  assert.equal(abortCount, 1);
  assert.ok(reentrantSnapshot);
  assert.equal(controller.getSnapshot().state, "follow-up-window");
  assert.throws(
    () => controller.requestCancellation("user-cancelled"),
    /cannot request cancellation/,
  );
}

{
  const { controller } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  const firstTurn = controller.submitTurn({
    rawText: "第一轮",
    trigger: "wake-word",
    relation: "new-goal",
  });
  controller.completeTurn(firstTurn.turnId, { outputMode: "text" });
  const firstSessionId = firstTurn.sessionId;
  controller.closeSession();
  controller.wake({ provider: "test-wake", simulated: true });

  const snapshot = controller.getSnapshot();
  assert.notEqual(snapshot.currentSession.sessionId, firstSessionId);
  assert.equal(snapshot.currentSession.status, "active");
  assert.equal(snapshot.previousSession.sessionId, firstSessionId);
  assert.equal(snapshot.previousSession.status, "closed");
}

{
  const { controller, ledger } = createHarness();
  const before = controller.getSnapshot();
  assert.throws(
    () => controller.submitTurn({
      rawText: "不应被接收",
      trigger: "wake-word",
      relation: "new-goal",
    }),
    /cannot submit turn/,
  );
  assert.deepEqual(controller.getSnapshot(), before);

  controller.wake({ provider: "test-wake", simulated: true });
  const eventCount = ledger.getCurrentSession().events.length;
  assert.throws(() => controller.beginSpeaking("missing-turn"), /cannot begin speaking/);
  assert.equal(controller.getSnapshot().state, "listening");
  assert.equal(ledger.getCurrentSession().events.length, eventCount);
}

{
  const { controller, ledger } = createHarness();
  let appendPrecededNotification = false;
  controller.subscribe((_snapshot, event) => {
    appendPrecededNotification = ledger.getCurrentSession().events.at(-1) === event;
  });
  controller.wake({ provider: "test-wake", simulated: true });
  assert.equal(appendPrecededNotification, true);
}

{
  const { controller } = createHarness();
  controller.wake({ provider: "test-wake", simulated: true });
  const challenge = controller.submitTurn({
    rawText: "打开尾门",
    trigger: "explicit-hmi",
    relation: "new-goal",
  });
  controller.linkRun(challenge.turnId, {
    runId: "run:challenge",
    eventIds: ["event:challenge"],
  });
  controller.completeTurn(challenge.turnId, {
    outputMode: "text",
    relatedRunEventIds: ["event:challenge-terminal"],
  });
  controller.startListening();
  const confirmed = controller.submitTurn({
    rawText: "确认",
    trigger: "follow-up",
    relation: "follow-up",
  });
  assert.throws(
    () => controller.linkRun(confirmed.turnId, {
      runId: "run:not-appended",
      eventIds: ["event:valid", " "],
    }),
    /eventIds.*non-empty|non-empty.*eventIds/,
  );
  controller.linkRun(confirmed.turnId, {
    runId: "run:confirmed",
    parentRunId: "run:challenge",
    eventIds: ["event:confirmed"],
  });
  controller.completeTurn(confirmed.turnId, { outputMode: "text" });

  const session = controller.getSnapshot().currentSession;
  assert.deepEqual(session.relatedRunIds, ["run:challenge", "run:confirmed"]);
  const terminal = session.events.find((event) => (
    event.turnId === confirmed.turnId && event.phase === "turn-completed"
  ));
  assert.deepEqual(terminal.relatedRunIds, ["run:confirmed", "run:challenge"]);
  assert.deepEqual(terminal.relatedRunEventIds, ["event:confirmed"]);
  assert.equal(JSON.stringify(session).includes("run:not-appended"), false);
  assert.equal(Object.isFrozen(session.relatedRunIds), true);
}

console.log("interaction session controller verification passed");
