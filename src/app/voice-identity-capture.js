import { LOCAL_VOICE_PROTOCOL } from "../voice/local-voice-protocol.js";

const DEFAULT_MAX_CAPTURE_MS = 6_000;

export class VoiceIdentityPcmRecorder {
  #audioContext = null;
  #audioContextFactory;
  #frames = [];
  #maxCaptureMs;
  #mediaDevices;
  #mediaStream = null;
  #onAutoStop = null;
  #processorNode = null;
  #recording = false;
  #sourceNode = null;
  #stopPromise = null;
  #workletUrl;

  constructor({
    mediaDevices = globalThis.navigator?.mediaDevices,
    audioContextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
    workletUrl = "/src/voice/pcm-capture-worklet.js",
    maxCaptureMs = DEFAULT_MAX_CAPTURE_MS,
  } = {}) {
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
      throw new TypeError("mediaDevices.getUserMedia is required");
    }
    if (typeof audioContextFactory !== "function") throw new TypeError("audioContextFactory is required");
    if (!Number.isSafeInteger(maxCaptureMs) || maxCaptureMs < 2_500 || maxCaptureMs > 8_000) {
      throw new TypeError("maxCaptureMs must be between 2500 and 8000");
    }
    this.#mediaDevices = mediaDevices;
    this.#audioContextFactory = audioContextFactory;
    this.#workletUrl = workletUrl;
    this.#maxCaptureMs = maxCaptureMs;
  }

  async start({ onAutoStop } = {}) {
    if (this.#recording || this.#audioContext || this.#mediaStream) {
      throw new Error("voice identity recorder already active");
    }
    if (onAutoStop !== undefined && typeof onAutoStop !== "function") {
      throw new TypeError("onAutoStop must be a function");
    }
    this.#frames = [];
    this.#onAutoStop = onAutoStop || null;
    const stream = await this.#mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const context = this.#audioContextFactory();
    try {
      await context.audioWorklet.addModule(this.#workletUrl);
      const source = context.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(context, "nio-pcm-capture", {
        processorOptions: {
          outputSampleRate: LOCAL_VOICE_PROTOCOL.sampleRate,
          frameSamples: LOCAL_VOICE_PROTOCOL.frameSamples,
        },
      });
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      processor.port.onmessage = (event) => this.#handleFrame(event.data);
      source.connect(processor).connect(silentGain).connect(context.destination);
      this.#mediaStream = stream;
      this.#audioContext = context;
      this.#sourceNode = source;
      this.#processorNode = processor;
      this.#recording = true;
      if (context.state === "suspended") await context.resume();
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      await context.close?.();
      this.#processorNode = null;
      this.#sourceNode = null;
      this.#mediaStream = null;
      this.#audioContext = null;
      this.#recording = false;
      throw error;
    }
  }

  async stop() {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = (async () => {
      this.#recording = false;
      await this.#closeGraph();
      const byteLength = this.#frames.reduce((sum, frame) => sum + frame.byteLength, 0);
      const pcm = new Uint8Array(byteLength);
      let offset = 0;
      for (const frame of this.#frames) {
        pcm.set(frame, offset);
        offset += frame.byteLength;
      }
      this.#frames = [];
      this.#onAutoStop = null;
      return pcm.buffer;
    })();
    try {
      return await this.#stopPromise;
    } finally {
      this.#stopPromise = null;
    }
  }

  async cancel() {
    this.#recording = false;
    await this.#closeGraph();
    this.#frames = [];
    this.#onAutoStop = null;
  }

  getSnapshot() {
    return Object.freeze({
      recording: this.#recording,
      durationMs: this.#frames.length * LOCAL_VOICE_PROTOCOL.frameDurationMs,
    });
  }

  #handleFrame(value) {
    if (!this.#recording || !(value instanceof ArrayBuffer)
      || value.byteLength !== LOCAL_VOICE_PROTOCOL.frameBytes) return;
    this.#frames.push(new Uint8Array(value));
    if (this.#frames.length * LOCAL_VOICE_PROTOCOL.frameDurationMs < this.#maxCaptureMs) return;
    const onAutoStop = this.#onAutoStop;
    void this.stop().then((pcm) => onAutoStop?.(pcm));
  }

  async #closeGraph() {
    try {
      this.#processorNode?.disconnect?.();
      this.#sourceNode?.disconnect?.();
      for (const track of this.#mediaStream?.getTracks?.() || []) track.stop();
      await this.#audioContext?.close?.();
    } finally {
      this.#processorNode = null;
      this.#sourceNode = null;
      this.#mediaStream = null;
      this.#audioContext = null;
    }
  }
}
