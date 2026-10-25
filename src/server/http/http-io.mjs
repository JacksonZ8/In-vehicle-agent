// Shared HTTP request/response helpers for the local agent server routes.

import { createAbortError } from "../../runtime/abort-utils.js";

export function isResponseOpen(response) {
  return Boolean(
    response
    && response.destroyed !== true
    && response.closed !== true
    && response.writableEnded !== true
  );
}

export function canWriteResponse(response) {
  return isResponseOpen(response) && response.headersSent !== true;
}

export function json(response, status, body, extraHeaders = {}) {
  if (!canWriteResponse(response)) return false;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
  return true;
}

export function createRequestAbortScope(request, response) {
  const controller = new AbortController();
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    request?.removeListener?.("aborted", onRequestAborted);
    response?.removeListener?.("close", onResponseClose);
  };
  const abort = (message) => {
    if (!controller.signal.aborted) controller.abort(createAbortError(message));
    dispose();
  };
  const onRequestAborted = () => abort("client request aborted");
  const onResponseClose = () => {
    if (response?.writableEnded !== true) abort("client response closed");
  };

  request?.once?.("aborted", onRequestAborted);
  response?.once?.("close", onResponseClose);
  if (request?.aborted === true) onRequestAborted();
  else if (response?.destroyed === true && response?.writableEnded !== true) onResponseClose();

  return { signal: controller.signal, dispose };
}

export function readBody(request, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        finish(reject, new Error("request body too large"));
        request.destroy();
      }
    };
    const onEnd = () => {
      try {
        finish(resolve, body ? JSON.parse(body) : {});
      } catch {
        finish(reject, new Error("invalid JSON body"));
      }
    };
    const onError = (error) => finish(reject, error);
    const onAbort = () => finish(reject, createAbortError(signal.reason));

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function readBinaryBody(request, { signal, maxBytes = 256_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        finish(reject, Object.assign(new Error("request body too large"), { code: "pcm-too-large" }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks, byteLength));
    const onError = (error) => finish(reject, error);
    const onAbort = () => finish(reject, createAbortError(signal.reason));

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function waitForResponseDrain(response, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onDrain = () => finish(resolve);
    const onClose = () => finish(reject, createAbortError("client response closed"));
    const onAbort = () => finish(reject, createAbortError(signal.reason));

    response.once("drain", onDrain);
    response.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (!isResponseOpen(response)) onClose();
  });
}
