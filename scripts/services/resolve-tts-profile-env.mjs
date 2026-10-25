#!/usr/bin/env node
import {
  DEFAULT_TTS_PROFILES_PATH,
  loadTtsProfilesConfig,
  resolveTtsSynthesisProfile,
} from "../../src/voice/tts-profile-loader.mjs";

const args = new Set(process.argv.slice(2));
const strictProfile = args.has("--strict-profile");
const includeEndpoint = args.has("--include-endpoint");
const logPrefix = valueForArg("--log-prefix") || "tts-profile";
const profilePath = valueForArg("--profile-path") || DEFAULT_TTS_PROFILES_PATH;

function valueForArg(name) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

function shellQuote(value = "") {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function exportLine(name, value) {
  return `export ${name}=${shellQuote(value ?? "")}`;
}

function fail(message, code = 1) {
  console.error(`[${logPrefix}] ERROR: ${message}`);
  process.exit(code);
}

const config = loadTtsProfilesConfig({ profilePath });
if (strictProfile && config.loadError) {
  fail(`TTS profile config could not be loaded: ${config.loadError}`);
}

const profile = resolveTtsSynthesisProfile({ profilePath });
const availableProfiles = config.profiles ? Object.keys(config.profiles) : [];
const configuredProfile = config.profiles?.[profile.profileId];
if (strictProfile && !configuredProfile) {
  fail(`TTS profile "${profile.profileId}" not found. Available: ${availableProfiles.join(", ") || "none"}`);
}

const endpoint =
  configuredProfile?.provider === "BrowserSpeechSynthesis"
    ? ""
    : process.env.NIO_GPT_SOVITS_ENDPOINT || "http://127.0.0.1:9880/tts";

const lines = [
  exportLine("NIO_TTS_PROFILE", profile.profileId),
  exportLine("NIO_GPT_SOVITS_REF_AUDIO_PATH", profile.refAudioPath),
  exportLine("NIO_GPT_SOVITS_PROMPT_TEXT", profile.promptText),
  exportLine("NIO_GPT_SOVITS_PROMPT_LANG", profile.promptLang),
  exportLine("NIO_GPT_SOVITS_TEXT_LANG", profile.textLang),
  exportLine("NIO_GPT_SOVITS_MEDIA_TYPE", profile.mediaType),
  exportLine("NIO_TTS_SYNTHESIS_PROFILE_ID", profile.synthesis.profileId),
  exportLine("NIO_GPT_SOVITS_TEXT_SPLIT_METHOD", profile.synthesis.textSplitMethod),
  exportLine("NIO_GPT_SOVITS_BATCH_SIZE", profile.synthesis.batchSize),
  exportLine("NIO_GPT_SOVITS_STREAMING_MODE", String(profile.synthesis.streamingMode)),
  exportLine("NIO_GPT_SOVITS_SPEED_FACTOR", profile.synthesis.speedFactor),
  exportLine("NIO_GPT_SOVITS_TOP_K", profile.synthesis.topK),
  exportLine("NIO_GPT_SOVITS_TOP_P", profile.synthesis.topP),
  exportLine("NIO_GPT_SOVITS_TEMPERATURE", profile.synthesis.temperature),
];

if (includeEndpoint) {
  lines.push(exportLine("NIO_GPT_SOVITS_ENDPOINT", endpoint));
}

console.log(lines.join("\n"));
console.error(
  `[${logPrefix}] TTS profile: ${profile.profileId} (provider: ${profile.provider}, synthesis: ${profile.synthesis.profileId}, license: ${profile.licenseBoundary})`,
);
