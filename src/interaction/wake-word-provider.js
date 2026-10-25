const NOMI_WAKE_PATTERN = /^nomi(?=$|[\p{White_Space}\p{Punctuation}])/iu;

export class BrowserTranscriptWakeWordProvider {
  #now;

  constructor({ now = Date.now } = {}) {
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.#now = now;
  }

  detect(transcript) {
    const normalized = typeof transcript === "string"
      ? transcript.normalize("NFKC").trimStart()
      : "";
    const matched = NOMI_WAKE_PATTERN.test(normalized);
    const observedAt = new Date(this.#now());
    if (Number.isNaN(observedAt.getTime())) throw new TypeError("now must return a valid time");
    return Object.freeze({
      provider: "browser-transcript-wake-gate",
      providerVersion: "1.0.0",
      matched,
      normalizedWakeWord: matched ? "NOMI" : null,
      observedAt: observedAt.toISOString(),
      source: "browser-transcript-gate",
      simulated: true,
      environment: "development",
    });
  }
}
