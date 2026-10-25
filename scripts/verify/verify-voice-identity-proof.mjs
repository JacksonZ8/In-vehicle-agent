#!/usr/bin/env node
import assert from "node:assert/strict";
import { VoiceIdentityProofCoordinator } from "../../src/server/voice-identity-proof-coordinator.mjs";
import { VoiceIdentityProofStore } from "../../src/server/voice-identity-proof-store.mjs";

const embedding = [1, ...Array(15).fill(0)];
const profile = {
  profileId: "profile-1",
  profileVersion: 3,
  modelId: "model-1",
  modelDigest: "a".repeat(64),
  aggregateEmbedding: embedding,
};
const policy = {
  policyId: "policy-1",
  profileId: profile.profileId,
  profileVersion: profile.profileVersion,
  modelId: profile.modelId,
  modelDigest: profile.modelDigest,
  passThreshold: 0.65,
  reviewThreshold: 0.55,
};
const proofStore = new VoiceIdentityProofStore({
  createId: () => "voice-proof-test-1",
  now: () => 1_000,
});
let intent = "confirm";
let speakerOutcome = "accepted";
const coordinator = new VoiceIdentityProofCoordinator({
  profile: { ...profile, confirmationKeywordsFile: "/tmp/confirmation-keywords.txt" },
  readinessResolver: () => ({ status: "ready" }),
  voiceReadinessResolver: () => ({ status: "ready" }),
  store: { readProfile: async () => profile },
  policyStore: { readPolicy: async () => policy },
  proofStore,
  speakerWorker: {
    analyzePcm16: async () => ({ outcome: speakerOutcome, embedding }),
  },
  confirmationWorker: {
    analyzePcm16: async () => ({ intent }),
  },
  now: () => 1_000,
});

const binding = {
  sessionId: "browser-session-1",
  challengeId: "confirm-1",
  requestId: "request-1",
  actionDigest: `sha256:${"a".repeat(64)}`,
  policyId: policy.policyId,
  pcm: Buffer.from([0, 0]),
};
const issued = await coordinator.issue(binding);
assert.equal(issued.status, "matched");
assert.equal(typeof issued.proofId, "string");
assert.deepEqual(
  await coordinator.consume({ ...binding, proofId: issued.proofId, pcm: undefined }),
  { ok: true, detectedIntent: "confirm" },
);
assert.equal(
  (await coordinator.consume({ ...binding, proofId: issued.proofId, pcm: undefined })).ok,
  false,
);

intent = "cancel";
assert.equal((await coordinator.issue({ ...binding, challengeId: "confirm-2" })).status, "cancelled");
intent = "confirm";
speakerOutcome = "too-short";
assert.equal((await coordinator.issue({ ...binding, challengeId: "confirm-3" })).status, "rejected");

coordinator.close();
console.log("voice identity proof verification passed");
