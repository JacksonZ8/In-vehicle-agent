class NioPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedRate = Number(options.processorOptions?.outputSampleRate);
    const requestedFrameSamples = Number(options.processorOptions?.frameSamples);
    this.outputSampleRate = requestedRate === 16_000 ? requestedRate : 16_000;
    this.frameSamples = requestedFrameSamples === 320 ? requestedFrameSamples : 320;
    this.ratio = sampleRate / this.outputSampleRate;
    this.sourceSamples = [];
    this.sourcePosition = 0;
    this.outputFrame = [];
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input?.length) return true;
    for (const sample of input) this.sourceSamples.push(sample);

    while (this.sourcePosition + 1 < this.sourceSamples.length) {
      const leftIndex = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - leftIndex;
      const left = this.sourceSamples[leftIndex];
      const right = this.sourceSamples[leftIndex + 1];
      this.outputFrame.push(left + ((right - left) * fraction));
      this.sourcePosition += this.ratio;
      if (this.outputFrame.length === this.frameSamples) this.flushFrame();
    }

    const consumed = Math.floor(this.sourcePosition);
    if (consumed > 0) {
      this.sourceSamples.splice(0, consumed);
      this.sourcePosition -= consumed;
    }
    return true;
  }

  flushFrame() {
    const pcm = new Int16Array(this.frameSamples);
    for (let index = 0; index < pcm.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, this.outputFrame[index]));
      pcm[index] = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767);
    }
    this.outputFrame.length = 0;
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }
}

registerProcessor("nio-pcm-capture", NioPcmCaptureProcessor);
