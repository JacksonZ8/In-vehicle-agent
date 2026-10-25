export const VOICE_IDENTITY_ENROLLMENT_CONTRACT = Object.freeze({
  schemaVersion: "nio-voice-identity-enrollment@1.0.0",
  sampleCount: 3,
  phrases: Object.freeze([
    Object.freeze({
      id: "primary-driver-phrase-1",
      text: "NOMI，请记住我的声音，我是这辆车的主驾。",
    }),
    Object.freeze({
      id: "primary-driver-phrase-2",
      text: "今天路况不错，请帮我规划一条安全舒适的路线。",
    }),
    Object.freeze({
      id: "primary-driver-phrase-3",
      text: "需要执行车辆操作时，请先确认是我本人。",
    }),
  ]),
  quality: Object.freeze({
    minimumDurationMs: 2_500,
    maximumDurationMs: 8_000,
    minimumSpeechRatio: 0.35,
    maximumClippedSampleRatio: 0.01,
  }),
  publicOutcomes: Object.freeze([
    "accepted",
    "too-short",
    "too-long",
    "insufficient-speech",
    "clipped",
    "unavailable",
  ]),
});
