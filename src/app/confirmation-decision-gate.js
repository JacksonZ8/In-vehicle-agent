const CONFIRMATION_CHANNELS = new Set(["screen", "voice", "cancel"]);

export function createConfirmationDecisionGate() {
  let activeClaim = null;

  return Object.freeze({
    claim({ challengeId, channel }) {
      const normalizedChallengeId = String(challengeId || "").trim();
      if (!normalizedChallengeId || !CONFIRMATION_CHANNELS.has(channel) || activeClaim) return null;
      activeClaim = Object.freeze({
        challengeId: normalizedChallengeId,
        channel,
      });
      return activeClaim;
    },
    release(claim) {
      if (claim !== activeClaim) return false;
      activeClaim = null;
      return true;
    },
    isClaimed(challengeId) {
      return activeClaim?.challengeId === String(challengeId || "").trim();
    },
  });
}
