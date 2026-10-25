export function isCancellationError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

export function createAbortError(reason) {
  if (isCancellationError(reason)) return reason;
  const message = typeof reason === "string"
    ? reason
    : reason instanceof Error
      ? reason.message
      : "The operation was aborted";
  const error = new Error(message);
  error.name = "AbortError";
  error.reason = reason;
  if (reason !== undefined) error.cause = reason;
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal.reason);
}

export function composeAbortSignals(signals = []) {
  const controller = new AbortController();
  const listeners = [];
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.length = 0;
  };

  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      dispose();
      break;
    }
    const relayAbort = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
      dispose();
    };
    signal.addEventListener("abort", relayAbort, { once: true });
    listeners.push([signal, relayAbort]);
    if (signal.aborted) {
      relayAbort();
      break;
    }
  }

  return { signal: controller.signal, dispose };
}
