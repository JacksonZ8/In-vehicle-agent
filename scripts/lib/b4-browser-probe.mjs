const PROBE_STAGES = Object.freeze([
  "runtime-warmup", "rig-ready", "first-run", "confirmation", "new-run", "second-run", "observation",
]);
const PROBE_STAGE_SET = new Set(PROBE_STAGES);
const BENCHMARK_EXTERNAL_MODEL_REQUEST_LIMIT_HEADER = "x-nio-benchmark-external-model-request-limit";

function requirePage(page) {
  for (const method of ["addInitScript", "evaluate", "waitForFunction", "locator"]) {
    if (typeof page?.[method] !== "function") throw new TypeError(`page.${method} must be a function`);
  }
}

function requireScenario(scenario) {
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
    throw new TypeError("scenario must be an object");
  }
  if (typeof scenario.goal !== "string" || !scenario.goal.trim()) {
    throw new TypeError("scenario.goal must be a non-empty string");
  }
  if (typeof scenario.demoScenarioId !== "string" || !scenario.demoScenarioId.trim()) {
    throw new TypeError("scenario.demoScenarioId must be a non-empty string");
  }
  const { maxCalls, allowedPhases } = scenario.modelBudget || {};
  if (Object.keys(scenario.modelBudget || {}).length !== 2
    || !Object.hasOwn(scenario.modelBudget || {}, "maxCalls")
    || !Object.hasOwn(scenario.modelBudget || {}, "allowedPhases")
    || !Number.isInteger(maxCalls) || maxCalls < 0
    || !Array.isArray(allowedPhases)
    || allowedPhases.some((phase) => typeof phase !== "string" || !phase.trim())
    || (maxCalls > 0 && allowedPhases.length === 0)) {
    throw new TypeError("scenario.modelBudget must define a non-negative call cap and allowed phases");
  }
}

function requireTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
}

function createScenarioDeadline(timeoutMs, now) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const deadlineAt = now() + timeoutMs;
  return Object.freeze({
    remainingMs() {
      const remaining = Math.floor(deadlineAt - now());
      if (remaining > 0) return remaining;
      const error = new Error("scenario deadline exhausted");
      error.name = "TimeoutError";
      throw error;
    },
  });
}

function isTimeoutFailure(error) {
  return error?.name === "TimeoutError" || /timed?\s*out|timeout/i.test(String(error?.message || ""));
}

function stageFailure(stage, error) {
  if (!PROBE_STAGE_SET.has(stage)) throw new TypeError(`unsupported probe stage: ${stage}`);
  if (error?.stage === stage
    && [ `${stage}-timeout`, `${stage}-failed` ].includes(error?.code)) return error;
  const wrapped = new Error(`${stage}: ${error?.message || String(error)}`);
  wrapped.name = error?.name || "Error";
  wrapped.stage = stage;
  wrapped.code = `${stage}-${isTimeoutFailure(error) ? "timeout" : "failed"}`;
  wrapped.cause = error;
  return wrapped;
}

async function runProbeStage(stage, deadline, operation) {
  try {
    return await operation(deadline.remainingMs());
  } catch (error) {
    throw stageFailure(stage, error);
  }
}

async function submitBrowserRun(page, {
  goal,
  demoScenario,
  requestId,
  maximumExternalModelRequests,
}) {
  return page.evaluate(({
    goal: input,
    demoScenario: scenarioId,
    requestId: requestedRequestId,
    maximumExternalModelRequests: externalRequestMaximum,
    benchmarkHeaderName,
  }) => {
    if (typeof window.__runtimeDebug !== "function"
      || typeof window.__vehicleDebug !== "function"
      || typeof window.runCommand !== "function") {
      throw new Error("public HMI benchmark debug functions are unavailable");
    }
    const feedback = document.querySelector("#runFeedback");
    const assistant = document.querySelector("#assistantText");
    if (!feedback || !assistant) throw new Error("benchmark observation targets are unavailable");

    window.__b4BenchmarkProbe?.observers?.forEach((observer) => observer.disconnect());
    const counters = window.__b2AcceptanceCalls || {};
    const counterBaseline = (field) => Number.isInteger(counters[field]) && counters[field] >= 0
      ? counters[field]
      : null;
    const state = {
      requestedRequestId,
      requestId: requestedRequestId,
      submittedAtPerf: performance.now(),
      firstFeedbackAtPerf: null,
      resultVisibleAtPerf: null,
      resultVisibleRunId: null,
      resultMutations: [],
      animationConfirmedAtPerf: null,
      animationCommandId: null,
      modelRequestCount: 0,
      externalModelRequestCount: 0,
      externalModelRequestReservations: 0,
      requestQueue: Promise.resolve(),
      externalModelRequestTelemetryComplete: true,
      maximumExternalModelRequests: externalRequestMaximum,
      counterBaseline: {
        safetyCallCount: counterBaseline("safetyCallCount"),
        toolCallCount: counterBaseline("toolCallCount"),
        adapterAcceptedCount: counterBaseline("adapterAcceptedCount"),
        providerCallCount: counterBaseline("providerCallCount"),
        providerAcceptedCount: counterBaseline("providerAcceptedCount"),
        providerStateChangeCount: counterBaseline("providerStateChangeCount"),
      },
      observers: [],
      cleaned: false,
    };
    window.__b4BenchmarkProbe = state;

    const feedbackObserver = new MutationObserver(() => {
      if (state.firstFeedbackAtPerf === null && feedback.textContent.trim()) {
        state.firstFeedbackAtPerf = performance.now();
      }
    });
    feedbackObserver.observe(feedback, { childList: true, characterData: true, subtree: true });
    const resultObserver = new MutationObserver(() => {
      const fullText = assistant.textContent.trim();
      const statusText = assistant
        .querySelector?.('[data-testid="manual-evidence-status"]')
        ?.textContent?.trim() || "";
      const text = statusText && fullText.endsWith(statusText)
        ? fullText.slice(0, -statusText.length).trim()
        : fullText;
      if (text && text !== "正在生成回复") {
        const renderOwner = assistant.dataset?.runId;
        const runId = typeof renderOwner === "string" && renderOwner.trim()
          ? renderOwner.trim()
          : null;
        state.resultMutations.push({
          at: performance.now(),
          runId,
          text,
        });
      }
    });
    resultObserver.observe(assistant, { childList: true, characterData: true, subtree: true });
    state.observers.push(feedbackObserver, resultObserver);

    const nativeFetch = window.fetch;
    const nativeFetchContext = window;
    const observedFetch = async (...args) => {
      const url = String(args[0]?.url || args[0] || "");
      const isObservedModelRequest = url.includes("/api/local-llm")
        || url.includes("/api/local-semantic");
      if (!isObservedModelRequest) return nativeFetch.apply(nativeFetchContext, args);
      const previousRequest = state.requestQueue;
      let releaseRequest;
      state.requestQueue = new Promise((resolve) => {
        releaseRequest = resolve;
      });
      await previousRequest;
      try {
        const reservedCalls = state.maximumExternalModelRequests
          - state.externalModelRequestCount
          - state.externalModelRequestReservations;
        if (!Number.isInteger(state.maximumExternalModelRequests)
          || state.maximumExternalModelRequests < 0
          || !Number.isSafeInteger(reservedCalls)
          || reservedCalls < 1) {
          throw new Error("external model request budget cannot reserve the next model request");
        }
        state.modelRequestCount += 1;
        state.externalModelRequestReservations += reservedCalls;
        const requestInit = args[1] && typeof args[1] === "object" ? args[1] : {};
        const headers = new Headers(
          typeof Request === "function" && args[0] instanceof Request
            ? args[0].headers
            : undefined,
        );
        new Headers(requestInit.headers).forEach((value, key) => headers.set(key, value));
        headers.set(benchmarkHeaderName, String(reservedCalls));
        const observedArgs = [args[0], { ...requestInit, headers }];
        let response;
        try {
          response = await nativeFetch.apply(nativeFetchContext, observedArgs);
        } catch (error) {
          state.externalModelRequestTelemetryComplete = false;
          throw error;
        }
        let telemetry;
        try {
          telemetry = (await response.clone().json())?.telemetry;
        } catch {
          state.externalModelRequestTelemetryComplete = false;
          return response;
        }
        const actualCalls = telemetry?.externalModelRequestCount;
        if (!Number.isSafeInteger(actualCalls) || actualCalls < 0 || actualCalls > reservedCalls) {
          state.externalModelRequestTelemetryComplete = false;
          return response;
        }
        const billableCalls = actualCalls === 0
          ? 0
          : telemetry?.provider === "dashscope"
            ? actualCalls
            : telemetry?.provider === "ollama"
              ? 0
              : null;
        if (billableCalls === null) {
          state.externalModelRequestTelemetryComplete = false;
          return response;
        }
        state.externalModelRequestReservations -= reservedCalls;
        state.externalModelRequestCount += billableCalls;
        if (state.externalModelRequestCount > state.maximumExternalModelRequests) {
          state.externalModelRequestTelemetryComplete = false;
        }
        return response;
      } finally {
        releaseRequest();
      }
    };
    state.originalFetch = nativeFetch;
    state.fetchWrapper = observedFetch;
    window.fetch = observedFetch;
    const vehicleRig = window.vehicleRig;
    const originalPlayScenarioAnimation = vehicleRig?.playScenarioAnimation;
    if (typeof originalPlayScenarioAnimation === "function") {
      const observedPlayScenarioAnimation = function observedPlayScenarioAnimation(...args) {
        const commandId = args[1]?.commandId;
        const accepted = originalPlayScenarioAnimation.apply(this, args);
        if (accepted === true
          && state.animationConfirmedAtPerf === null
          && typeof commandId === "string"
          && commandId.trim()) {
          state.animationConfirmedAtPerf = performance.now();
          state.animationCommandId = commandId;
        }
        return accepted;
      };
      vehicleRig.playScenarioAnimation = observedPlayScenarioAnimation;
      state.vehicleRig = vehicleRig;
      state.originalPlayScenarioAnimation = originalPlayScenarioAnimation;
      state.animationWrapper = observedPlayScenarioAnimation;
    }

    void window.runCommand(input, {
      requestId: requestedRequestId,
      demoScenario: scenarioId,
    });
    const publicRunId = window.__runtimeDebug()?.currentTurn?.runId;
    if (typeof publicRunId === "string" && publicRunId) state.requestId = publicRunId;
    return { requestId: state.requestId, submittedAtPerf: state.submittedAtPerf };
  }, {
    goal,
    demoScenario,
    requestId,
    maximumExternalModelRequests,
    benchmarkHeaderName: BENCHMARK_EXTERNAL_MODEL_REQUEST_LIMIT_HEADER,
  });
}

async function hasExistingConfirmation(page) {
  return page.evaluate(() => Boolean(window.__runtimeDebug?.()?.pendingConfirmation));
}

async function waitForManualRagWarmup(page, timeoutMs) {
  await page.waitForFunction(
    () => Boolean(window.__runtimeWarmupReady),
    null,
    { timeout: timeoutMs },
  );
  const result = await page.evaluate(async ({ maximumWaitMs }) => {
    let timer = null;
    try {
      return await Promise.race([
        window.__runtimeWarmupReady,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("runtime warmup timed out");
            error.name = "TimeoutError";
            reject(error);
          }, maximumWaitMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }, { maximumWaitMs: timeoutMs });
  if (result?.tasks?.manualRag?.status !== "ready") {
    throw new Error("manual RAG runtime warmup is not ready");
  }
  return result;
}

async function clickExistingConfirmation(page, timeoutMs) {
  await page.locator("[data-confirm-pending-action]").click({ timeout: timeoutMs });
}

async function waitForConfirmationRun(page, previousRequestId, timeoutMs) {
  await page.waitForFunction((previousRunId) => {
    const debug = window.__runtimeDebug?.();
    const runId = debug?.currentTurn?.runId || debug?.latestRun?.requestId;
    return typeof runId === "string" && runId.length > 0 && runId !== previousRunId;
  }, previousRequestId, { timeout: timeoutMs });
  return page.evaluate(() => {
    const debug = window.__runtimeDebug?.();
    const requestId = debug?.currentTurn?.runId || debug?.latestRun?.requestId;
    if (typeof requestId !== "string" || !requestId) {
      throw new Error("public confirmation control did not create a new Runtime run");
    }
    if (window.__b4BenchmarkProbe) window.__b4BenchmarkProbe.requestId = requestId;
    return { requestId };
  });
}

async function waitForCompletedRun(page, requestId, timeoutMs) {
  await page.waitForFunction((expectedRequestId) => {
    const debug = window.__runtimeDebug?.();
    return debug?.currentRun === null && debug?.latestRun?.requestId === expectedRequestId;
  }, requestId, { timeout: timeoutMs });
}

async function readObservation(page) {
  return page.evaluate(() => {
    const debug = window.__runtimeDebug?.();
    const state = window.__b4BenchmarkProbe;
    const runDebug = debug?.latestRun || null;
    const result = runDebug?.result || {};
    const expectedResultText = String(
      result.assistantResponse
        || result.conversationResult?.summary
        || result.cloudResult?.summary
        || result.toolResult?.hmiSummary
        || "",
    ).trim();
    const resultCandidates = expectedResultText
      ? (state?.resultMutations || []).filter((entry) => entry?.text === expectedResultText)
      : [];
    const visibleResult = resultCandidates
      .filter((entry) => entry?.runId === runDebug?.requestId)
      .at(-1) || null;
    if (state) {
      state.resultVisibleAtPerf = visibleResult?.at ?? null;
      state.resultVisibleRunId = visibleResult?.runId ?? null;
    }
    const counters = window.__b2AcceptanceCalls || {};
    const counterDelta = (field) => {
      const current = counters[field];
      const baseline = state?.counterBaseline?.[field];
      return Number.isInteger(current)
        && current >= 0
        && Number.isInteger(baseline)
        && baseline >= 0
        && current >= baseline
        ? current - baseline
        : null;
    };
    const browserObservation = {
      submittedAtPerf: state?.submittedAtPerf ?? null,
      firstFeedbackAtPerf: state?.firstFeedbackAtPerf ?? null,
      resultVisibleAtPerf: state?.resultVisibleAtPerf ?? null,
      resultVisibleRunId: state?.resultVisibleRunId ?? null,
      animationConfirmedAtPerf: state?.animationConfirmedAtPerf ?? null,
      animationCommandId: state?.animationCommandId ?? null,
      modelRequestCount: state?.modelRequestCount || 0,
      externalModelRequestCount: state?.externalModelRequestTelemetryComplete === true
        && state.externalModelRequestReservations === 0
        && Number.isSafeInteger(state.externalModelRequestCount)
        && state.externalModelRequestCount >= 0
        ? state.externalModelRequestCount
        : null,
      safetyCallCount: counterDelta("safetyCallCount"),
      toolCallCount: counterDelta("toolCallCount"),
      adapterAcceptedCount: counterDelta("adapterAcceptedCount"),
      providerCallCount: counterDelta("providerCallCount"),
      providerAcceptedCount: counterDelta("providerAcceptedCount"),
      providerStateChangeCount: counterDelta("providerStateChangeCount"),
    };
    return { runDebug, browserObservation };
  });
}

async function cleanupBrowserProbe(page) {
  await page.evaluate(() => {
    const state = window.__b4BenchmarkProbe;
    if (!state || state.cleaned) return;
    const errors = [];
    for (const observer of state.observers || []) {
      try {
        observer.disconnect();
      } catch (error) {
        errors.push(error);
      }
    }
    if (window.fetch === state.fetchWrapper) window.fetch = state.originalFetch;
    if (state.vehicleRig?.playScenarioAnimation === state.animationWrapper) {
      state.vehicleRig.playScenarioAnimation = state.originalPlayScenarioAnimation;
    }
    state.cleaned = true;
    if (errors.length > 0) throw errors[0];
  });
}

export async function createB4BrowserProbe({
  page,
  scenario,
  timeoutMs,
  now = () => globalThis.performance.now(),
} = {}) {
  requirePage(page);
  requireScenario(scenario);
  requireTimeout(timeoutMs);
  const deadline = createScenarioDeadline(timeoutMs, now);
  await page.addInitScript(() => {
    window.NIO_B2_ACCEPTANCE_INSTRUMENTATION = true;
  });

  return Object.freeze({
    async run({ requestId } = {}) {
      if (typeof requestId !== "string" || !requestId.trim()) {
        throw new TypeError("requestId must be a non-empty string");
      }
      let primaryError = null;
      try {
        if (scenario.id === "vehicle-knowledge") {
          await runProbeStage(
            "runtime-warmup",
            deadline,
            (remainingMs) => waitForManualRagWarmup(page, remainingMs),
          );
        }
        if (scenario.expected?.animation === true) {
          await runProbeStage(
            "rig-ready",
            deadline,
            (remainingMs) => page.waitForFunction(
              () => typeof window.vehicleRig?.playScenarioAnimation === "function"
                && window.__vehicleDebug?.()?.vehicleRig?.modelLoaded === true,
              null,
              { timeout: remainingMs },
            ),
          );
        }
        const submission = await runProbeStage("first-run", deadline, () => submitBrowserRun(page, {
          goal: scenario.goal,
          demoScenario: scenario.demoScenarioId,
          requestId,
          maximumExternalModelRequests: scenario.modelBudget.maxCalls,
        }));
        await runProbeStage(
          "first-run",
          deadline,
          (remainingMs) => waitForCompletedRun(page, submission.requestId, remainingMs),
        );

        if (scenario.id === "vehicle-control-safe") {
          const confirmationPresent = await runProbeStage(
            "confirmation",
            deadline,
            () => hasExistingConfirmation(page),
          );
          if (!confirmationPresent) {
            return await runProbeStage("observation", deadline, () => readObservation(page));
          }
          await runProbeStage(
            "confirmation",
            deadline,
            (remainingMs) => clickExistingConfirmation(page, remainingMs),
          );
          const confirmation = await runProbeStage(
            "new-run",
            deadline,
            (remainingMs) => waitForConfirmationRun(page, submission.requestId, remainingMs),
          );
          await runProbeStage(
            "second-run",
            deadline,
            (remainingMs) => waitForCompletedRun(page, confirmation.requestId, remainingMs),
          );
        }
        return await runProbeStage("observation", deadline, () => readObservation(page));
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        try {
          await cleanupBrowserProbe(page);
        } catch (cleanupError) {
          if (primaryError) {
            try {
              primaryError.cleanupError = cleanupError.message;
            } catch {
              // Preserve the original failure when its error object is immutable.
            }
          } else {
            throw cleanupError;
          }
        }
      }
    },
  });
}
