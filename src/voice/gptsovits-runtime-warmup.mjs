import {
  buildGptSoVitsPayload,
  resolveTtsSynthesisProfile,
} from "./tts-profile-loader.mjs";

export const TTS_STARTUP_WARMUP_TEXT = "语音服务预热。";

function asPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildTtsStartupWarmupRequest({
  env = process.env,
  profile = resolveTtsSynthesisProfile({ env }),
  text = TTS_STARTUP_WARMUP_TEXT,
} = {}) {
  const payload = buildGptSoVitsPayload(text, profile);
  payload.streaming_mode = 3;
  return { profile, payload };
}

export async function runGptSoVitsStartupWarmup({
  env = process.env,
  fetchImpl = fetch,
  now = () => Date.now(),
  endpoint = env.NIO_GPT_SOVITS_ENDPOINT || "http://127.0.0.1:9880/tts",
  timeoutMs = asPositiveNumber(env.NIO_GPT_SOVITS_WARMUP_TIMEOUT_MS, 180000),
} = {}) {
  const startedAt = now();
  let profile;
  try {
    const request = buildTtsStartupWarmupRequest({ env });
    profile = request.profile;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/wav" },
      body: JSON.stringify(request.payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`GPT-SoVITS returned HTTP ${response.status}`);
    return {
      kind: "gptsovits-startup-warmup",
      status: "succeeded",
      endpoint,
      elapsedMs: Math.max(0, now() - startedAt),
      profileId: profile.profileId,
      synthesisProfileId: profile.synthesis.profileId,
      streamingMode: 3,
    };
  } catch (error) {
    return {
      kind: "gptsovits-startup-warmup",
      status: "failed",
      endpoint,
      elapsedMs: Math.max(0, now() - startedAt),
      profileId: profile?.profileId || "unavailable",
      synthesisProfileId: profile?.synthesis?.profileId || "unavailable",
      streamingMode: 3,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
