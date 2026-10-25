// Read-only owner user-guide routes: JSON page lookup and the bounded PDF stream.

import http from "node:http";
import { canWriteResponse, json } from "../http/http-io.mjs";

export async function handleManualUserGuide(
  request,
  response,
  { repository, evidenceRunLedger } = {},
) {
  const query = parseUserGuideQuery(request.url, new Set(["source", "chunk", "run"]));
  if (!query.valid) {
    sendUserGuideError(response, 400, "invalid-request", query.message);
    return;
  }

  const sourceId = query.params.get("source");
  const hasChunk = query.params.has("chunk");
  const hasRun = query.params.has("run");
  if (!sourceId || hasChunk !== hasRun) {
    sendUserGuideError(
      response,
      400,
      "invalid-request",
      "source is required; chunk and run must be provided together",
    );
    return;
  }

  if (!hasChunk) {
    let document;
    try {
      document = await repository.getBrowseDocument(sourceId);
    } catch (error) {
      sendUserGuideRepositoryError(response, error);
      return;
    }
    if (!document) {
      sendUserGuideError(response, 404, "userguide-source-not-found", "user guide source not found");
      return;
    }
    json(response, 200, {
      ...document,
      pdfUrl: createUserGuidePdfUrl(document.source.sourceId),
    }, { "cache-control": "no-store" });
    return;
  }

  const runId = query.params.get("run");
  const chunkId = query.params.get("chunk");
  if (!runId || !chunkId) {
    sendUserGuideError(response, 400, "invalid-request", "chunk and run must be non-empty");
    return;
  }
  if (!evidenceRunLedger?.get?.(runId)) {
    sendUserGuideError(
      response,
      404,
      "evidence-run-expired",
      "the evidence run is unknown or has expired; run manual retrieval again",
    );
    return;
  }

  let target;
  try {
    target = await repository.getEvidenceTarget({
      runId,
      sourceId,
      chunkId,
      evidenceLedger: evidenceRunLedger,
    });
  } catch (error) {
    sendUserGuideRepositoryError(response, error);
    return;
  }
  if (!target) {
    sendUserGuideError(
      response,
      404,
      "evidence-target-not-found",
      "the requested source and chunk are not evidence from this run",
    );
    return;
  }
  json(response, 200, {
    ...target,
    pdfUrl: createUserGuidePdfUrl(target.source.sourceId),
  }, { "cache-control": "no-store" });
}

export async function handleManualUserGuidePdf(
  request,
  response,
  { repository } = {},
) {
  const query = parseUserGuideQuery(request.url, new Set(["source"]));
  if (!query.valid) {
    sendUserGuideError(response, 400, "invalid-request", query.message);
    return;
  }
  const sourceId = query.params.get("source");
  if (!sourceId) {
    sendUserGuideError(response, 400, "invalid-request", "source is required");
    return;
  }

  const asset = await repository.getPdfAsset(sourceId);
  if (!asset) {
    sendUserGuideError(response, 404, "userguide-source-not-found", "user guide source not found");
    return;
  }

  let stream;
  let iterator;
  try {
    stream = await asset.openStream();
    iterator = stream[Symbol.asyncIterator]();
    let part = await waitForPdfOperation(() => iterator.next(), response);
    if (!canWriteResponse(response)) return;
    response.writeHead(200, {
      "content-type": asset.contentType,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    while (!part.done) {
      if (!response.write(part.value)) await waitForPdfDrain(response);
      part = await waitForPdfOperation(() => iterator.next(), response);
    }
    response.end();
  } catch (error) {
    if (error?.code === "userguide-client-closed") return;
    if (response.headersSent) {
      terminatePartialPdfResponse(response);
      return;
    }
    sendUserGuideError(response, 404, "userguide-pdf-unavailable", "user guide PDF is unavailable");
  } finally {
    stream?.destroy?.();
    try {
      await iterator?.return?.();
    } catch {
      // The response has already been terminated; iterator cleanup is best-effort.
    }
  }
}

function waitForPdfOperation(startOperation, response) {
  if (response.destroyed || response.closed) return Promise.reject(pdfClientClosedError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => response.removeListener?.("close", onClose);
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onClose = () => settle(reject, pdfClientClosedError());
    response.once?.("close", onClose);
    let operation;
    try {
      operation = startOperation();
    } catch (error) {
      settle(reject, error);
      return;
    }
    Promise.resolve(operation).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
  });
}

function waitForPdfDrain(response) {
  if (response.destroyed || response.closed) return Promise.reject(pdfClientClosedError());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener?.("drain", onDrain);
      response.removeListener?.("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(pdfClientClosedError());
    };
    response.once?.("drain", onDrain);
    response.once?.("close", onClose);
  });
}

function pdfClientClosedError() {
  const error = new Error("PDF client closed");
  error.code = "userguide-client-closed";
  return error;
}

function terminatePartialPdfResponse(response) {
  if (response.destroyed || response.closed || response.writableEnded) return;
  if (typeof response.destroy === "function") response.destroy();
  else response.end();
}

function parseUserGuideQuery(requestUrl, allowedKeys) {
  let url;
  try {
    url = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    return { valid: false, message: "malformed URL" };
  }
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) return { valid: false, message: `unsupported query parameter: ${key}` };
    if (url.searchParams.getAll(key).length !== 1) {
      return { valid: false, message: `duplicate query parameter: ${key}` };
    }
  }
  return { valid: true, params: url.searchParams };
}

function createUserGuidePdfUrl(sourceId) {
  return `/api/userguide/pdf?source=${encodeURIComponent(sourceId)}`;
}

function sendUserGuideError(response, status, code, message) {
  json(response, status, { error: { code, message } }, { "cache-control": "no-store" });
}

function sendUserGuideRepositoryError(response, error) {
  const code = ["userguide-artifact-unavailable", "userguide-artifact-invalid"].includes(error?.code)
    ? error.code
    : "userguide-artifact-unavailable";
  const message = code === "userguide-artifact-invalid"
    ? "user guide artifact is invalid"
    : "user guide artifact is unavailable";
  sendUserGuideError(response, 503, code, message);
}
