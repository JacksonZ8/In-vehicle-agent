import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const LOCAL_VOICE_MODEL_PROFILE = Object.freeze({
  profileId: "nio-local-kws-sherpa-onnx-1.0.0",
  provider: "sherpa-onnx-kws",
  runtimePackage: "sherpa-onnx-node",
  runtimeVersion: "1.13.6",
  platformPackage: "sherpa-onnx-darwin-arm64",
  modelId: "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20-int8-chunk-8",
  sourceUrl: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2",
  archiveSha256: "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6",
  licenseBoundary: "local-demo-only-model-license-unresolved",
  modelDirectory: path.join(
    root,
    ".local-services/voice-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20",
  ),
  keywordsFile: path.join(root, "config/local-voice/keywords.txt"),
  confirmationKeywordsFile: path.join(root, "config/local-voice/confirmation-keywords.txt"),
  files: Object.freeze({
    encoder: "encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx",
    decoder: "decoder-epoch-13-avg-2-chunk-8-left-64.onnx",
    joiner: "joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx",
    tokens: "tokens.txt",
  }),
  inference: Object.freeze({
    sampleRate: 16_000,
    featureDim: 80,
    numThreads: 1,
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: 1,
    keywordsThreshold: 0.25,
  }),
});

function resolveInstalledPackageVersion(packageName) {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const value = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return typeof value.version === "string" ? value.version : null;
  } catch {
    return null;
  }
}

export function resolveLocalVoiceModelReadiness(profile = LOCAL_VOICE_MODEL_PROFILE) {
  const runtimeVersion = resolveInstalledPackageVersion(profile.runtimePackage);
  const platformVersion = resolveInstalledPackageVersion(profile.platformPackage);
  if (runtimeVersion !== profile.runtimeVersion || platformVersion !== profile.runtimeVersion) {
    return Object.freeze({
      status: "degraded",
      provider: profile.provider,
      model: profile.modelId,
      reasonCode: "local-voice-runtime-unavailable",
      simulated: false,
    });
  }
  const requiredPaths = [
    profile.keywordsFile,
    ...Object.values(profile.files).map((file) => path.join(profile.modelDirectory, file)),
  ];
  if (!requiredPaths.every((file) => fs.existsSync(file) && fs.statSync(file).isFile())) {
    return Object.freeze({
      status: "degraded",
      provider: profile.provider,
      model: profile.modelId,
      reasonCode: "local-voice-model-unavailable",
      simulated: false,
    });
  }
  return Object.freeze({
    status: "ready",
    provider: profile.provider,
    model: profile.modelId,
    reasonCode: null,
    simulated: false,
  });
}

export function createSherpaKeywordSpotterConfig(
  profile = LOCAL_VOICE_MODEL_PROFILE,
  { keywordsFile = profile.keywordsFile } = {},
) {
  const modelPath = (file) => path.join(profile.modelDirectory, file);
  return Object.freeze({
    featConfig: Object.freeze({
      sampleRate: profile.inference.sampleRate,
      featureDim: profile.inference.featureDim,
    }),
    modelConfig: Object.freeze({
      transducer: Object.freeze({
        encoder: modelPath(profile.files.encoder),
        decoder: modelPath(profile.files.decoder),
        joiner: modelPath(profile.files.joiner),
      }),
      tokens: modelPath(profile.files.tokens),
      numThreads: profile.inference.numThreads,
      provider: "cpu",
      debug: 0,
    }),
    maxActivePaths: profile.inference.maxActivePaths,
    numTrailingBlanks: profile.inference.numTrailingBlanks,
    keywordsScore: profile.inference.keywordsScore,
    keywordsThreshold: profile.inference.keywordsThreshold,
    keywordsFile,
  });
}
