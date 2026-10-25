import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digestCache = new Map();

export const LOCAL_SPEAKER_IDENTITY_MODEL_PROFILE = Object.freeze({
  profileId: "nio-primary-driver-speaker-identity-1.0.0",
  provider: "sherpa-onnx-speaker-identification",
  speakerModelId: "3dspeaker-speech-eres2net-base-sv-zh-cn-16k",
  speakerModelUrl: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
  speakerModelPath: path.join(
    root,
    ".local-services/voice-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
  ),
  speakerModelBytes: 39_593_761,
  speakerModelSha256: "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b",
  vadModelId: "silero-vad",
  vadModelUrl: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  vadModelPath: path.join(root, ".local-services/voice-models/silero_vad.onnx"),
  vadModelBytes: 643_854,
  vadModelSha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
  licenseBoundary: "local-demo-only-model-license-unresolved",
});

function sha256File(filePath) {
  const stat = fs.statSync(filePath);
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = digestCache.get(filePath);
  if (cached?.key === cacheKey) return cached.digest;
  const digest = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  digestCache.set(filePath, { key: cacheKey, digest });
  return digest;
}

export function resolveLocalSpeakerIdentityReadiness(
  profile = LOCAL_SPEAKER_IDENTITY_MODEL_PROFILE,
) {
  try {
    const required = [profile.speakerModelPath, profile.vadModelPath];
    if (!required.every((file) => fs.existsSync(file) && fs.statSync(file).isFile())) {
      return Object.freeze({
        status: "degraded",
        provider: profile.provider,
        model: profile.speakerModelId,
        reasonCode: "local-speaker-model-unavailable",
      });
    }
    if (![profile.speakerModelSha256, profile.vadModelSha256]
      .every((digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))) {
      return Object.freeze({
        status: "degraded",
        provider: profile.provider,
        model: profile.speakerModelId,
        reasonCode: "local-speaker-model-unverified",
      });
    }
    if (fs.statSync(profile.speakerModelPath).size !== profile.speakerModelBytes
      || fs.statSync(profile.vadModelPath).size !== profile.vadModelBytes) {
      return Object.freeze({
        status: "degraded",
        provider: profile.provider,
        model: profile.speakerModelId,
        reasonCode: "local-speaker-model-digest-mismatch",
      });
    }
    if (sha256File(profile.speakerModelPath) !== profile.speakerModelSha256
      || sha256File(profile.vadModelPath) !== profile.vadModelSha256) {
      return Object.freeze({
        status: "degraded",
        provider: profile.provider,
        model: profile.speakerModelId,
        reasonCode: "local-speaker-model-digest-mismatch",
      });
    }
    return Object.freeze({
      status: "ready",
      provider: profile.provider,
      model: profile.speakerModelId,
      reasonCode: null,
    });
  } catch {
    return Object.freeze({
      status: "degraded",
      provider: profile.provider,
      model: profile.speakerModelId,
      reasonCode: "local-speaker-model-unavailable",
    });
  }
}
