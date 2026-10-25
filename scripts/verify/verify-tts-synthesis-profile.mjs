import assert from "node:assert/strict";
import {
  buildGptSoVitsPayload,
  loadTtsProfilesConfig,
} from "../../src/voice/tts-profile-loader.mjs";
import fs from "node:fs";
import path from "node:path";

const profileConfig = loadTtsProfilesConfig();
assert.equal(profileConfig.defaultProfile, "sandrone-dev");
assert.equal(profileConfig.profiles["sandrone-dev"].synthesis.profileId, "sandrone-dev-gptsovits-cpu-balanced@1.0.0");
assert.equal(profileConfig.profiles["sandrone-dev"].refAudioPath, "assets/tts/reference/sandrone-dev-reference.wav");
assert.equal(path.isAbsolute(profileConfig.profiles["sandrone-dev"].refAudioPath), false);

const {
  resolveTtsSynthesisProfile,
} = await import(`../../src/server/local-agent-server.mjs?tts-profile=${Date.now()}`);

const profile = resolveTtsSynthesisProfile();
assert.equal(profile.profileId, "sandrone-dev");
assert.equal(profile.configVersion, "1.0.0");
assert.equal(profile.provider, "GPT-SoVITS");
assert.equal(profile.licenseBoundary, "local-non-commercial-testing-only");
assert.equal(profile.refAudioPathRaw, "assets/tts/reference/sandrone-dev-reference.wav");
assert.equal(path.isAbsolute(profile.refAudioPath), true);
assert.ok(fs.existsSync(profile.refAudioPath), `resolved ref audio must exist: ${profile.refAudioPath}`);
assert.equal(profile.synthesis.profileId, "sandrone-dev-gptsovits-cpu-balanced@1.0.0");
assert.equal(profile.synthesis.textSplitMethod, "cut5");
assert.equal(profile.synthesis.batchSize, 1);
assert.equal(profile.synthesis.streamingMode, false);
assert.equal(profile.synthesis.speedFactor, 1);
assert.equal(profile.synthesis.topK, 5);
assert.equal(profile.synthesis.topP, 1);
assert.equal(profile.synthesis.temperature, 1);

const payload = buildGptSoVitsPayload("测试文本", profile);
assert.equal(payload.text, "测试文本");
assert.equal(payload.text_lang, "zh");
assert.equal(payload.prompt_lang, "zh");
assert.equal(payload.text_split_method, profile.synthesis.textSplitMethod);
assert.equal(payload.batch_size, profile.synthesis.batchSize);
assert.equal(payload.media_type, "wav");
assert.equal(payload.streaming_mode, profile.synthesis.streamingMode);
assert.equal(payload.speed_factor, profile.synthesis.speedFactor);
assert.equal(payload.top_k, profile.synthesis.topK);
assert.equal(payload.top_p, profile.synthesis.topP);
assert.equal(payload.temperature, profile.synthesis.temperature);
assert.equal(payload._profile.profileId, "sandrone-dev");
assert.equal(payload._profile.synthesis.profileId, "sandrone-dev-gptsovits-cpu-balanced@1.0.0");
assert.equal(payload._profile.licenseBoundary, "local-non-commercial-testing-only");

console.log(JSON.stringify({
  defaultProfile: true,
  synthesisProfile: profile.synthesis.profileId,
  profileTelemetry: true,
}, null, 2));
