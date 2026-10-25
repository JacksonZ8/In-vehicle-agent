import assert from "node:assert/strict";
import { buildManualSpeechText, MANUAL_SPEECH_POLICY } from "../../src/manual/manual-speech-policy.js";

assert.equal(`${MANUAL_SPEECH_POLICY.id}@${MANUAL_SPEECH_POLICY.version}`, "nio-manual-speech-text@1.1.0");
assert.equal(MANUAL_SPEECH_POLICY.provenance, "manual-runtime-speech-text");

assert.equal(
  buildManualSpeechText("开启尾门前请确认后方空间。\n\n手册依据：第 88 页，尾门开启。"),
  "开启尾门前请确认后方空间。",
);

assert.equal(
  buildManualSpeechText("我没有在当前证据里找到答案。", { status: "no-evidence" }),
  MANUAL_SPEECH_POLICY.noEvidenceText,
);

const longSentence = "开启尾门前请确认后方空间、周围人员和障碍物，操作过程中请持续观察车辆周边环境，避免夹伤或碰撞，同时不要让儿童靠近尾门区域。";
const complete = buildManualSpeechText(`${longSentence}\n\n手册依据：第 88 页，尾门开启。`);
assert.equal(complete, longSentence);
assert.doesNotMatch(complete, /手册依据|第 \d+ 页/);

assert.equal(
  buildManualSpeechText("请先停车并挂入 P 挡"),
  "请先停车并挂入 P 挡。",
);

console.log(JSON.stringify({ ok: true, policy: MANUAL_SPEECH_POLICY }, null, 2));
