const PROMPTS = Object.freeze([
  "我是主驾，我确认执行",
  "NOMI，请确认是我本人",
  "我已了解风险，确认继续执行",
]);

const CONDITIONS = Object.freeze([
  Object.freeze({ id: "near-quiet", label: "靠近麦克风，保持安静" }),
  Object.freeze({ id: "normal-seated", label: "保持正常坐姿和说话音量" }),
  Object.freeze({ id: "distant-light-noise", label: "稍微离远，允许轻微背景声" }),
]);

const CONDITION_SEQUENCE = Object.freeze([
  CONDITIONS[0], CONDITIONS[0],
  CONDITIONS[1], CONDITIONS[1],
  CONDITIONS[2],
]);

const steps = Object.freeze(CONDITION_SEQUENCE.map((condition, index) => Object.freeze({
  id: `primary-driver-calibration-${index + 1}`,
  prompt: PROMPTS[index % PROMPTS.length],
  conditionId: condition.id,
  conditionLabel: condition.label,
})));

export const VOICE_IDENTITY_CALIBRATION_CONTRACT = Object.freeze({
  schemaVersion: "nio-voice-identity-calibration@1.1.0",
  sampleCount: 5,
  prompts: PROMPTS,
  conditions: CONDITIONS,
  steps,
  publicOutcomes: Object.freeze([
    "accepted",
    "too-short",
    "too-long",
    "insufficient-speech",
    "clipped",
    "calibration-insufficient",
  ]),
});
