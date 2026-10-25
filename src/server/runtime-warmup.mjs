const READY_STATUSES = new Set(["ready", "succeeded"]);

function durationFrom(result) {
  const value = Number(result?.durationMs ?? result?.elapsedMs);
  return Number.isFinite(value) && value >= 0
    ? Math.min(2_147_483_647, Math.round(value))
    : 0;
}

function publicIdentity(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{1,80}$/.test(normalized) ? normalized : null;
}

function projectTaskResult(taskId, result) {
  const ready = READY_STATUSES.has(result?.status);
  const identity = taskId === "manualRag"
    ? publicIdentity(result?.embeddingModel)
    : publicIdentity(result?.profileId);
  return Object.freeze({
    status: ready ? "ready" : "degraded",
    durationMs: durationFrom(result),
    ...(identity ? { [taskId === "manualRag" ? "model" : "profile"]: identity } : {}),
    ...(!ready ? { reasonCode: "warmup-unavailable" } : {}),
  });
}

async function settleTask(taskId, task) {
  try {
    return projectTaskResult(taskId, await task());
  } catch {
    return Object.freeze({
      status: "degraded",
      durationMs: 0,
      reasonCode: "warmup-unavailable",
    });
  }
}

export function createRuntimeWarmupCoordinator({
  warmManualRag,
  warmGptSoVits,
  now = () => Date.now(),
} = {}) {
  if (typeof warmManualRag !== "function") throw new TypeError("warmManualRag must be a function");
  if (typeof warmGptSoVits !== "function") throw new TypeError("warmGptSoVits must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const readyTasks = new Map();
  let readyResult = null;
  let latestResult = null;
  let inFlight = null;
  let inFlightStartedAt = null;

  const runTask = (taskId, task) => {
    if (readyTasks.has(taskId)) return Promise.resolve(readyTasks.get(taskId));
    return settleTask(taskId, task).then((result) => {
      if (result.status === "ready") readyTasks.set(taskId, result);
      return result;
    });
  };

  function warmup() {
    if (readyResult) return Promise.resolve(readyResult);
    if (inFlight) return inFlight;
    const startedAt = now();
    inFlightStartedAt = startedAt;
    inFlight = Promise.all([
      runTask("manualRag", warmManualRag),
      runTask("gptSoVits", warmGptSoVits),
    ]).then(([manualRag, gptSoVits]) => {
      const status = manualRag.status === "ready" && gptSoVits.status === "ready"
        ? "ready"
        : "degraded";
      const result = Object.freeze({
        status,
        durationMs: durationFrom({ durationMs: now() - startedAt }),
        tasks: Object.freeze({ manualRag, gptSoVits }),
      });
      latestResult = result;
      if (status === "ready") readyResult = result;
      return result;
    }).finally(() => {
      inFlight = null;
      inFlightStartedAt = null;
    });
    return inFlight;
  }

  function snapshot() {
    if (readyResult || latestResult) return readyResult || latestResult;
    const status = inFlight ? "warming" : "checking";
    const taskState = (taskId) => readyTasks.get(taskId) || Object.freeze({
      status,
      durationMs: 0,
    });
    return Object.freeze({
      status,
      durationMs: inFlightStartedAt === null ? 0 : durationFrom({ durationMs: now() - inFlightStartedAt }),
      tasks: Object.freeze({
        manualRag: taskState("manualRag"),
        gptSoVits: taskState("gptSoVits"),
      }),
    });
  }

  return Object.freeze({ warmup, snapshot });
}

export async function handleRuntimeWarmupBody(body, coordinator) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    return {
      statusCode: 400,
      body: { error: "runtime warmup accepts no request fields" },
    };
  }
  if (typeof coordinator?.warmup !== "function") {
    throw new TypeError("runtimeWarmupCoordinator must provide warmup()");
  }
  return { statusCode: 200, body: projectPublicWarmupResult(await coordinator.warmup()) };
}

function projectPublicWarmupResult(result) {
  const manualRag = projectPublicWarmupTask("manualRag", result?.tasks?.manualRag);
  const gptSoVits = projectPublicWarmupTask("gptSoVits", result?.tasks?.gptSoVits);
  return Object.freeze({
    status: manualRag.status === "ready" && gptSoVits.status === "ready"
      ? "ready"
      : "degraded",
    durationMs: durationFrom(result),
    tasks: Object.freeze({ manualRag, gptSoVits }),
  });
}

function projectPublicWarmupTask(taskId, result) {
  const ready = result?.status === "ready";
  const identity = taskId === "manualRag"
    ? publicIdentity(result?.model ?? result?.embeddingModel)
    : publicIdentity(result?.profile ?? result?.profileId);
  return Object.freeze({
    status: ready ? "ready" : "degraded",
    durationMs: durationFrom(result),
    ...(identity ? { [taskId === "manualRag" ? "model" : "profile"]: identity } : {}),
    ...(!ready ? { reasonCode: "warmup-unavailable" } : {}),
  });
}
