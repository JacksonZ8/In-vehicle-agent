import { LOCAL_VOICE_PROTOCOL } from "./local-voice-protocol.js";

export class VoiceCaptureController {
  #allowSimulated;
  #audioContext = null;
  #audioContextFactory;
  #closePromise = null;
  #disablePromise = null;
  #gateway;
  #listeners = new Set();
  #lifecycleGeneration = 0;
  #mediaDevices;
  #mediaStream = null;
  #processorNode = null;
  #resumePromise = null;
  #sourceNode = null;
  #state = "disabled";
  #statusReason = null;
  #workletUrl;

  constructor({
    gateway,
    mediaDevices = globalThis.navigator?.mediaDevices,
    audioContextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
    workletUrl = "/src/voice/pcm-capture-worklet.js",
    allowSimulated = false,
  } = {}) {
    if (!gateway || typeof gateway.start !== "function" || typeof gateway.sendFrame !== "function") {
      throw new TypeError("local voice gateway is required");
    }
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
      throw new TypeError("mediaDevices.getUserMedia is required");
    }
    if (typeof audioContextFactory !== "function") throw new TypeError("audioContextFactory is required");
    this.#gateway = gateway;
    this.#mediaDevices = mediaDevices;
    this.#audioContextFactory = audioContextFactory;
    this.#workletUrl = workletUrl;
    this.#allowSimulated = allowSimulated;
    gateway.subscribe?.((event) => this.#handleGatewayEvent(event));
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async enable() {
    if (this.#state !== "disabled" && this.#state !== "degraded") return this.getSnapshot();
    const generation = ++this.#lifecycleGeneration;
    this.#transition("arming", null);
    try {
      const gatewaySession = await this.#gateway.start({ mode: "wake" });
      if (!this.#isCurrent(generation)) return this.getSnapshot();
      if (gatewaySession.event.simulated && !this.#allowSimulated) {
        this.#gateway.stop();
        this.#transition("degraded", "local-voice-model-unavailable");
        return this.getSnapshot();
      }
      const opened = await this.#openCaptureGraph(generation);
      if (!opened || !this.#isCurrent(generation)) return this.getSnapshot();
      this.#transition("standby", null);
    } catch (error) {
      if (!this.#isCurrent(generation)) return this.getSnapshot();
      this.#gateway.stop();
      await this.#closeCaptureGraph();
      if (!this.#isCurrent(generation)) return this.getSnapshot();
      this.#transition(
        error?.name === "NotAllowedError" ? "disabled" : "degraded",
        error?.name === "NotAllowedError" ? "microphone-permission-denied" : "local-voice-setup-failed",
      );
    }
    return this.getSnapshot();
  }

  async suspendForBrowserRecognition() {
    if (!this.#gateway.getSnapshot?.().ready || this.#state === "disabling") return this.getSnapshot();
    const generation = this.#lifecycleGeneration;
    await this.#closeCaptureGraph();
    if (!this.#isCurrent(generation) || this.#state === "disabling") return this.getSnapshot();
    this.#transition("command-listening", null);
    return this.getSnapshot();
  }

  async resumeStandby() {
    if (!this.#gateway.getSnapshot?.().ready || ["disabled", "degraded", "disabling"].includes(this.#state)) {
      return this.getSnapshot();
    }
    if (this.#state === "standby" && this.#audioContext && this.#mediaStream) {
      return this.getSnapshot();
    }
    if (this.#resumePromise) return this.#resumePromise;

    const generation = this.#lifecycleGeneration;
    const resumePromise = (async () => {
      try {
        this.#gateway.setMode?.("wake");
        const opened = await this.#openCaptureGraph(generation);
        if (!opened || !this.#isCurrent(generation)) return this.getSnapshot();
        this.#transition("standby", null);
      } catch (error) {
        if (!this.#isCurrent(generation)) return this.getSnapshot();
        this.#gateway.stop();
        this.#transition("degraded", "microphone-resume-failed");
      }
      return this.getSnapshot();
    })();
    this.#resumePromise = resumePromise;

    try {
      return await resumePromise;
    } finally {
      if (this.#resumePromise === resumePromise) this.#resumePromise = null;
    }
  }

  async disable() {
    if (this.#disablePromise) return this.#disablePromise;
    const generation = ++this.#lifecycleGeneration;
    this.#resumePromise = null;
    this.#transition("disabling", null);
    this.#gateway.stop();
    const disablePromise = (async () => {
      try {
        await this.#closeCaptureGraph();
      } finally {
        if (this.#isCurrent(generation)) this.#transition("disabled", null);
      }
      return this.getSnapshot();
    })();
    this.#disablePromise = disablePromise;
    try {
      return await disablePromise;
    } finally {
      if (this.#disablePromise === disablePromise) this.#disablePromise = null;
    }
  }

  getSnapshot() {
    return Object.freeze({
      state: this.#state,
      reasonCode: this.#statusReason,
      enabled: !["disabled", "degraded"].includes(this.#state),
      gateway: this.#gateway.getSnapshot?.() ?? null,
    });
  }

  async #openCaptureGraph(generation) {
    if (this.#closePromise) await this.#closePromise;
    if (!this.#isCurrent(generation)) return false;
    if (this.#audioContext || this.#mediaStream) return true;
    const stream = await this.#mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    let context = null;
    let source = null;
    let processor = null;
    let discarded = false;
    const discard = async () => {
      if (discarded) return;
      discarded = true;
      processor?.disconnect?.();
      source?.disconnect?.();
      for (const track of stream.getTracks()) track.stop();
      try {
        await context?.close?.();
      } catch {}
    };
    try {
      if (!this.#isCurrent(generation)) {
        await discard();
        return false;
      }
      context = this.#audioContextFactory();
      await context.audioWorklet.addModule(this.#workletUrl);
      if (!this.#isCurrent(generation)) {
        await discard();
        return false;
      }
      source = context.createMediaStreamSource(stream);
      processor = new AudioWorkletNode(context, "nio-pcm-capture", {
        processorOptions: {
          outputSampleRate: LOCAL_VOICE_PROTOCOL.sampleRate,
          frameSamples: LOCAL_VOICE_PROTOCOL.frameSamples,
        },
      });
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      processor.port.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) this.#gateway.sendFrame(event.data);
      };
      source.connect(processor).connect(silentGain).connect(context.destination);
      if (context.state === "suspended") await context.resume();
      if (!this.#isCurrent(generation)) {
        await discard();
        return false;
      }
      this.#mediaStream = stream;
      this.#audioContext = context;
      this.#sourceNode = source;
      this.#processorNode = processor;
      return true;
    } catch (error) {
      await discard();
      throw error;
    }
  }

  #closeCaptureGraph() {
    if (this.#closePromise) return this.#closePromise;
    this.#processorNode?.disconnect?.();
    this.#sourceNode?.disconnect?.();
    for (const track of this.#mediaStream?.getTracks?.() || []) track.stop();
    const context = this.#audioContext;
    this.#processorNode = null;
    this.#sourceNode = null;
    this.#mediaStream = null;
    this.#audioContext = null;
    const closePromise = Promise.resolve()
      .then(() => context?.close?.())
      .finally(() => {
        if (this.#closePromise === closePromise) this.#closePromise = null;
      });
    this.#closePromise = closePromise;
    return closePromise;
  }

  #handleGatewayEvent(event) {
    if (event?.type === "wake.detected" && this.#state === "standby") {
      this.#transition("wake-detected", null, event);
      return;
    }
    if (["gateway.closed", "voice.error"].includes(event?.type)
      && !["disabled", "disabling", "degraded"].includes(this.#state)) {
      const generation = this.#lifecycleGeneration;
      void this.#closeCaptureGraph().catch(() => {}).finally(() => {
        if (!this.#isCurrent(generation)) return;
        this.#gateway.stop();
        this.#transition("degraded", event.reasonCode || "local-voice-setup-failed");
      });
    }
  }

  #transition(state, reasonCode, event = null) {
    this.#state = state;
    this.#statusReason = reasonCode;
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) listener(snapshot, event);
  }

  #isCurrent(generation) {
    return generation === this.#lifecycleGeneration;
  }
}
