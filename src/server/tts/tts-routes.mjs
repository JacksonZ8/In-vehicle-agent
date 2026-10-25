// GPT-SoVITS TTS proxy routes (/api/tts and the streaming PoC) with their telemetry headers.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { buildGptSoVitsPayload, resolveTtsSynthesisProfile } from "../../voice/tts-profile-loader.mjs";
import { composeAbortSignals, createAbortError, isCancellationError, throwIfAborted } from "../../runtime/abort-utils.js";
import { canWriteResponse, isResponseOpen, readBody, waitForResponseDrain } from "../http/http-io.mjs";

export const gptSoVitsEndpoint = process.env.NIO_GPT_SOVITS_ENDPOINT || "http://127.0.0.1:9880/tts";

const ttsTimeoutMs = Number(process.env.NIO_TTS_TIMEOUT_MS || 12000);

// This is deliberately an opt-in, server-side diagnostic. It records only a
// fixed metadata/timing schema for the experimental streaming endpoint.
const ttsStreamingDiagnosticsEnabled = process.env.NIO_TTS_STREAMING_DIAGNOSTICS === "true";

const ttsExposeHeaders = [
  "x-nio-tts-proxy-total-ms",
  "x-nio-tts-upstream-first-response-ms",
  "x-nio-tts-upstream-complete-read-ms",
  "x-nio-tts-audio-bytes",
  "x-nio-tts-status",
  "x-nio-tts-error",
  "x-nio-tts-streaming-mode",
  "x-nio-tts-upstream-status",
  "x-nio-tts-profile-id",
  "x-nio-tts-profile-version",
  "x-nio-tts-synthesis-profile-id",
  "x-nio-tts-license-boundary",
  "x-nio-tts-diagnostic-request-id",
].join(", ");

export function buildTtsPayload(text) {
  const profile = resolveTtsSynthesisProfile();
  return buildGptSoVitsPayload(text, profile);
}

export async function handleTts(request, response, signal) {
  const startedAt = Date.now();
  let body;
  try {
    body = await readBody(request, { signal });
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    sendTtsJson(response, 400, { ok: false, provider: "gpt-sovits", fallback: "browser", error: error.message }, { startedAt, error: error.message });
    return;
  }
  const text = String(body.text || "").trim();
  if (!text) {
    sendTtsJson(response, 400, { ok: false, provider: "gpt-sovits", error: "missing text" }, { startedAt, error: "missing text" });
    return;
  }

  let payload;
  try {
    payload = buildTtsPayload(text);
  } catch (error) {
    sendTtsJson(response, 400, {
      ok: false,
      provider: "gpt-sovits",
      fallback: "browser",
      error: error.message,
    }, { startedAt, error: error.message });
    return;
  }

  const timeoutController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort(createAbortError("GPT-SoVITS timeout"));
  }, ttsTimeoutMs);
  const abortScope = composeAbortSignals([signal, timeoutController.signal]);
  let upstreamFirstResponseMs;
  let upstreamCompleteReadMs;

  try {
    const upstream = await fetch(gptSoVitsEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: abortScope.signal,
    });
    upstreamFirstResponseMs = Date.now() - startedAt;

    const contentType = upstream.headers.get("content-type") || `audio/${payload.media_type}`;
    if (!upstream.ok || contentType.includes("application/json")) {
      const detail = await upstream.text();
      upstreamCompleteReadMs = Date.now() - startedAt;
      const error = `GPT-SoVITS unavailable: HTTP ${upstream.status}`;
      sendTtsJson(response, upstream.ok ? 502 : upstream.status, {
        ok: false,
        provider: "gpt-sovits",
        profile: ttsProfileResponse(payload._profile),
        fallback: "browser",
        error,
        detail: detail.slice(0, 500),
      }, { startedAt, payload, upstreamFirstResponseMs, upstreamCompleteReadMs, upstreamStatus: upstream.status, error });
      return;
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    upstreamCompleteReadMs = Date.now() - startedAt;
    if (!audio.length) {
      const error = "GPT-SoVITS returned empty audio";
      sendTtsJson(response, 502, {
        ok: false,
        provider: "gpt-sovits",
        profile: ttsProfileResponse(payload._profile),
        fallback: "browser",
        error,
      }, { startedAt, payload, upstreamFirstResponseMs, upstreamCompleteReadMs, upstreamStatus: upstream.status, error });
      return;
    }

    throwIfAborted(signal);
    if (!canWriteResponse(response)) return;
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": audio.length,
      "access-control-allow-origin": "*",
      "access-control-expose-headers": ttsExposeHeaders,
      "cache-control": "no-store",
      ...buildTtsTelemetryHeaders({ startedAt, payload, upstreamFirstResponseMs, upstreamCompleteReadMs, upstreamStatus: upstream.status, audioBytes: audio.length, status: "success" }),
    });
    response.end(audio);
  } catch (error) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    const message = timedOut || isCancellationError(error) ? `GPT-SoVITS timeout after ${ttsTimeoutMs}ms` : error.message;
    sendTtsJson(response, 502, {
      ok: false,
      provider: "gpt-sovits",
      profile: ttsProfileResponse(payload?._profile),
      fallback: "browser",
      error: message,
    }, { startedAt, payload, upstreamFirstResponseMs, upstreamCompleteReadMs, error: message });
  } finally {
    clearTimeout(timeout);
    abortScope.dispose();
  }
}

// Experimental only: GPT-SoVITS mode 3 is forwarded byte-for-byte.  Do not
// reuse this endpoint for the default TTS path until browser first-audible
// measurements prove that the upstream WAV framing is playable incrementally.
export async function handleTtsStreamingPoc(request, response, signal) {
  const startedAt = Date.now();
  const diagnostics = createTtsStreamingDiagnostics(startedAt);
  diagnostics?.mark("received");
  let body;
  try {
    body = await readBody(request, { signal });
    diagnostics?.mark("bodyParsed");
    const text = String(body.text || "").trim();
    if (!text) throw new Error("missing text");
    const payload = buildTtsPayload(text);
    payload.streaming_mode = 3;
    diagnostics?.setPayload(payload, text.length);
    diagnostics?.mark("payloadBuilt");
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(createAbortError("GPT-SoVITS streaming timeout"));
    }, ttsTimeoutMs);
    const abortScope = composeAbortSignals([signal, timeoutController.signal]);
    try {
      diagnostics?.mark("upstreamFetchStart");
      const upstream = await fetch(gptSoVitsEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: abortScope.signal,
      });
      const upstreamFirstResponseMs = Date.now() - startedAt;
      diagnostics?.mark("upstreamHeaders");
      const contentType = upstream.headers.get("content-type") || "audio/wav";
      if (!upstream.ok || contentType.includes("application/json") || !upstream.body) {
        const detail = await upstream.text();
        sendTtsJson(response, upstream.ok ? 502 : upstream.status, {
          ok: false, provider: "gpt-sovits", fallback: "browser",
          error: `GPT-SoVITS streaming unavailable: HTTP ${upstream.status}`,
          detail: detail.slice(0, 500),
        }, { startedAt, payload, upstreamFirstResponseMs, upstreamStatus: upstream.status, diagnostics });
        diagnostics?.mark("completed");
        diagnostics?.emit();
        return;
      }
      throwIfAborted(signal);
      if (!canWriteResponse(response)) return;
      response.writeHead(200, {
        "content-type": contentType,
        "access-control-allow-origin": "*",
        "access-control-expose-headers": ttsExposeHeaders,
        "cache-control": "no-store",
        "x-nio-tts-proxy-mode": "streaming-poc",
        ...buildTtsStreamingDiagnosticsHeaders(diagnostics),
        ...buildTtsTelemetryHeaders({ startedAt, payload, upstreamFirstResponseMs, upstreamStatus: upstream.status, status: "streaming-poc" }),
      });
      const reader = upstream.body.getReader();
      let audioBytes = 0;
      let receivedFirstBody = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!receivedFirstBody) {
          receivedFirstBody = true;
          diagnostics?.mark("upstreamFirstBodyRead");
        }
        audioBytes += value.byteLength;
        diagnostics?.mark("proxyFirstWrite");
        throwIfAborted(signal);
        if (!isResponseOpen(response)) return;
        if (!response.write(Buffer.from(value))) await waitForResponseDrain(response, signal);
      }
      throwIfAborted(signal);
      if (!isResponseOpen(response)) return;
      response.end();
      diagnostics?.mark("completed");
      diagnostics?.emit();
      // Intentionally no arrayBuffer/blob accumulation: this endpoint is a
      // transport experiment, and final byte count is observable client-side.
      void audioBytes;
    } finally {
      clearTimeout(timeout);
      abortScope.dispose();
    }
  } catch (error) {
    if (signal?.aborted || isCancellationError(error)) diagnostics?.mark("aborted");
    diagnostics?.emit();
    if (signal?.aborted) throw createAbortError(signal.reason);
    const message = isCancellationError(error) ? `GPT-SoVITS streaming timeout after ${ttsTimeoutMs}ms` : error.message;
    if (!response.headersSent) sendTtsJson(response, 502, { ok: false, provider: "gpt-sovits", fallback: "browser", error: message }, { startedAt, error: message, diagnostics });
    else response.destroy();
  }
}

const TTS_STREAMING_DIAGNOSTIC_PAYLOAD_FIELDS = Object.freeze([
  "text_lang", "media_type", "streaming_mode", "split_method", "batch_size",
  "speed_factor", "top_k", "top_p", "temperature",
]);

function createTtsStreamingDiagnostics(startedAt) {
  if (!ttsStreamingDiagnosticsEnabled) return null;
  const requestId = randomUUID();
  const timeline = { requestId, phases: {}, metadata: {} };
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  return {
    requestId,
    mark(name) {
      // Preserve the first occurrence: retries/backpressure must not overwrite
      // the causally meaningful phase timestamp.
      if (timeline.phases[name] === undefined) timeline.phases[name] = elapsed();
    },
    setPayload(payload, textLength) {
      const profile = payload?._profile || {};
      const metadata = {
        textLength: Math.max(0, Number(textLength) || 0),
        profileId: String(profile.profileId || ""),
        synthesisProfileId: String(profile.synthesis?.profileId || ""),
      };
      for (const field of TTS_STREAMING_DIAGNOSTIC_PAYLOAD_FIELDS) metadata[field] = payload?.[field] ?? null;
      timeline.metadata = metadata;
    },
    emit() {
      // No text, prompt, reference-audio information/path, or audio bytes are
      // ever placed into this event. Keep it a safe JSON line for local logs.
      console.info("[tts-streaming-diagnostics]", JSON.stringify(timeline));
    },
  };
}

function buildTtsStreamingDiagnosticsHeaders(diagnostics) {
  return diagnostics ? { "x-nio-tts-diagnostic-request-id": diagnostics.requestId } : {};
}

function sendTtsJson(response, status, body, telemetry) {
  if (!canWriteResponse(response)) return false;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": ttsExposeHeaders,
    ...buildTtsStreamingDiagnosticsHeaders(telemetry?.diagnostics),
    ...buildTtsTelemetryHeaders({ ...telemetry, status: "error" }),
  });
  response.end(JSON.stringify(body));
  return true;
}

function buildTtsTelemetryHeaders(telemetry = {}) {
  const valueOrUnavailable = (value) => Number.isFinite(value) ? String(Math.max(0, Math.round(value))) : "unavailable";
  const profile = telemetry.payload?._profile || {};
  return {
    "x-nio-tts-proxy-total-ms": valueOrUnavailable(Date.now() - telemetry.startedAt),
    "x-nio-tts-upstream-first-response-ms": valueOrUnavailable(telemetry.upstreamFirstResponseMs),
    "x-nio-tts-upstream-complete-read-ms": valueOrUnavailable(telemetry.upstreamCompleteReadMs),
    "x-nio-tts-audio-bytes": String(Math.max(0, Number(telemetry.audioBytes) || 0)),
    "x-nio-tts-status": telemetry.status || "error",
    "x-nio-tts-error": sanitizeTtsTelemetryValue(telemetry.error || ""),
    // Preserve mode 0/1/2/3 for experimental telemetry; Boolean would hide
    // the distinction between the official GPT-SoVITS streaming modes.
    "x-nio-tts-streaming-mode": telemetry.payload ? String(telemetry.payload.streaming_mode) : "unavailable",
    "x-nio-tts-upstream-status": telemetry.upstreamStatus == null ? "unavailable" : String(telemetry.upstreamStatus),
    "x-nio-tts-profile-id": sanitizeTtsTelemetryValue(profile.profileId || ""),
    "x-nio-tts-profile-version": sanitizeTtsTelemetryValue(profile.configVersion || ""),
    "x-nio-tts-synthesis-profile-id": sanitizeTtsTelemetryValue(profile.synthesis?.profileId || ""),
    "x-nio-tts-license-boundary": sanitizeTtsTelemetryValue(profile.licenseBoundary || ""),
  };
}

function sanitizeTtsTelemetryValue(value) {
  return encodeURIComponent(String(value).replace(/[\r\n]/g, " ").slice(0, 200));
}

function ttsProfileResponse(profile = {}) {
  if (!profile || !profile.profileId) return undefined;
  return {
    profileId: profile.profileId,
    configVersion: profile.configVersion,
    provider: profile.provider,
    synthesisProfileId: profile.synthesis?.profileId,
    licenseBoundary: profile.licenseBoundary,
    licenseNote: profile.licenseNote,
  };
}
