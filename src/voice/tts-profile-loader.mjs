import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "../..");
export const DEFAULT_TTS_PROFILES_PATH = path.join(root, ".ua", "tts-profiles.json");

export function optionalEnv(name, env = process.env) {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

export function parseTtsBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

// GPT-SoVITS accepts streaming_mode 0..3. Historical boolean configuration is
// supported only as a compatibility input: false maps to mode 0 and true maps
// to mode 1. Callers that need an explicit protocol experiment should use an
// integer mode rather than relying on the boolean aliases.
export function parseTtsStreamingMode(value, fallback = 0) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  if (typeof candidate === "boolean") return candidate ? 1 : 0;
  const normalized = typeof candidate === "string" ? candidate.trim() : candidate;
  if (!/^(?:0|1|2|3)$/.test(String(normalized))) {
    throw new Error(`Invalid GPT-SoVITS streaming mode: ${candidate}. Expected boolean or integer 0..3.`);
  }
  return Number(normalized);
}

export function parseTtsNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseTtsBoundedNumber(value, { name, min, max }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}. Expected a finite number in ${min}..${max}.`);
  }
  return parsed;
}

export function parseTtsBoundedInteger(value, { name, min, max }) {
  const parsed = parseTtsBoundedNumber(value, { name, min, max });
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: ${value}. Expected an integer in ${min}..${max}.`);
  }
  return parsed;
}

export function parseTtsStrictBoolean(value, { name }) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`Invalid ${name}: ${value}. Expected boolean true or false.`);
}

export function loadTtsProfilesConfig({ profilePath = DEFAULT_TTS_PROFILES_PATH } = {}) {
  try {
    return JSON.parse(fs.readFileSync(profilePath, "utf8"));
  } catch (error) {
    return {
      version: "unavailable",
      defaultProfile: "env-gptsovits",
      profiles: {},
      loadError: error.message,
    };
  }
}

export function resolveTtsSynthesisProfile({ env = process.env, profilePath = DEFAULT_TTS_PROFILES_PATH } = {}) {
  const config = loadTtsProfilesConfig({ profilePath });
  const selectedProfileId = optionalEnv("NIO_TTS_PROFILE", env) || config.defaultProfile || "sandrone-dev";
  const voiceProfile = config.profiles?.[selectedProfileId] || {};
  const synthesis = voiceProfile.synthesis || {};
  const rawRefAudioPath = optionalEnv("NIO_GPT_SOVITS_REF_AUDIO_PATH", env) || voiceProfile.refAudioPath || "";
  return {
    configVersion: config.version || "unknown",
    profileId: selectedProfileId,
    provider: voiceProfile.provider || "GPT-SoVITS",
    description: voiceProfile.description || "",
    licenseBoundary: voiceProfile.licenseBoundary || "unknown",
    licenseNote: voiceProfile.licenseNote || "",
    refAudioPath: resolveProjectPath(rawRefAudioPath, { profilePath }),
    refAudioPathRaw: rawRefAudioPath,
    promptText: optionalEnv("NIO_GPT_SOVITS_PROMPT_TEXT", env) ?? voiceProfile.promptText ?? "",
    promptLang: optionalEnv("NIO_GPT_SOVITS_PROMPT_LANG", env) || voiceProfile.promptLang || "zh",
    textLang: optionalEnv("NIO_GPT_SOVITS_TEXT_LANG", env) || voiceProfile.textLang || "zh",
    mediaType: optionalEnv("NIO_GPT_SOVITS_MEDIA_TYPE", env) || voiceProfile.mediaType || "wav",
    synthesis: {
      profileId: optionalEnv("NIO_TTS_SYNTHESIS_PROFILE_ID", env) || synthesis.profileId || `${selectedProfileId}-synthesis@unversioned`,
      textSplitMethod: optionalEnv("NIO_GPT_SOVITS_TEXT_SPLIT_METHOD", env) || synthesis.textSplitMethod || "cut5",
      batchSize: parseTtsNumber(optionalEnv("NIO_GPT_SOVITS_BATCH_SIZE", env), parseTtsNumber(synthesis.batchSize, 1)),
      streamingMode: parseTtsBoolean(optionalEnv("NIO_GPT_SOVITS_STREAMING_MODE", env), parseTtsBoolean(synthesis.streamingMode, false)),
      speedFactor: parseTtsNumber(optionalEnv("NIO_GPT_SOVITS_SPEED_FACTOR", env), parseTtsNumber(synthesis.speedFactor, 1)),
      topK: parseTtsNumber(optionalEnv("NIO_GPT_SOVITS_TOP_K", env), parseTtsNumber(synthesis.topK, 5)),
      topP: parseTtsNumber(optionalEnv("NIO_GPT_SOVITS_TOP_P", env), parseTtsNumber(synthesis.topP, 1)),
      temperature: parseTtsNumber(optionalEnv("NIO_GPT_SOVITS_TEMPERATURE", env), parseTtsNumber(synthesis.temperature, 1)),
    },
    loadError: config.loadError,
  };
}

export function resolveProjectPath(value = "", { profilePath = DEFAULT_TTS_PROFILES_PATH } = {}) {
  if (!value) return "";
  if (path.isAbsolute(value)) return value;
  return path.resolve(path.dirname(path.dirname(profilePath)), value);
}

export function buildGptSoVitsPayload(text, profile) {
  if (!profile?.refAudioPath) {
    throw new Error("NIO_GPT_SOVITS_REF_AUDIO_PATH is not configured");
  }
  const payload = {
    text,
    text_lang: profile.textLang,
    ref_audio_path: profile.refAudioPath,
    prompt_text: profile.promptText,
    prompt_lang: profile.promptLang,
    text_split_method: profile.synthesis.textSplitMethod,
    batch_size: profile.synthesis.batchSize,
    media_type: profile.mediaType,
    streaming_mode: profile.synthesis.streamingMode,
    speed_factor: profile.synthesis.speedFactor,
    top_k: profile.synthesis.topK,
    top_p: profile.synthesis.topP,
    temperature: profile.synthesis.temperature,
  };
  if (profile.synthesis.minChunkLength !== undefined) payload.min_chunk_length = profile.synthesis.minChunkLength;
  if (profile.synthesis.fragmentInterval !== undefined) payload.fragment_interval = profile.synthesis.fragmentInterval;
  if (profile.synthesis.parallelInfer !== undefined) payload.parallel_infer = profile.synthesis.parallelInfer;
  Object.defineProperty(payload, "_profile", { value: profile, enumerable: false });
  return payload;
}
