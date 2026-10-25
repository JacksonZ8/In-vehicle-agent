import assert from "node:assert/strict";
import { LOCAL_VOICE_PROTOCOL } from "../../src/voice/local-voice-protocol.js";
import { VoiceCaptureController } from "../../src/voice/voice-capture-controller.js";
import { LocalVoiceGatewayClient } from "../../src/voice/local-voice-gateway-client.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

let mediaRequestCount = 0;
let pendingMediaRequest = null;
let gatewayReady = false;
let gatewayStarts = 0;
let gatewayStops = 0;
const originalAudioWorkletNode = globalThis.AudioWorkletNode;

globalThis.AudioWorkletNode = class FakeAudioWorkletNode {
  constructor() {
    this.port = { onmessage: null };
  }

  connect() {
    return this;
  }

  disconnect() {}
};

function createStream() {
  return { getTracks: () => [{ stop() {} }] };
}

const controller = new VoiceCaptureController({
  gateway: {
    async start() {
      gatewayStarts += 1;
      gatewayReady = true;
      return { event: { simulated: false } };
    },
    sendFrame() {},
    setMode() {},
    stop() {
      gatewayStops += 1;
      gatewayReady = false;
    },
    getSnapshot() {
      return { ready: gatewayReady };
    },
  },
  mediaDevices: {
    getUserMedia() {
      mediaRequestCount += 1;
      if (pendingMediaRequest) {
        const request = pendingMediaRequest;
        pendingMediaRequest = null;
        return request.promise;
      }
      return Promise.resolve(createStream());
    },
  },
  audioContextFactory: () => ({
    state: "running",
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => ({ connect() { return this; }, disconnect() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() { return this; } }),
    destination: {},
    close: async () => {},
  }),
});

try {
  assert.equal((await controller.enable()).state, "standby");
  assert.equal((await controller.suspendForBrowserRecognition()).state, "command-listening");

  const failedResumeMedia = deferred();
  pendingMediaRequest = failedResumeMedia;
  const staleResume = controller.resumeStandby();
  assert.equal(pendingMediaRequest, null, "resume must request a fresh stream");

  assert.equal((await controller.disable()).state, "disabled");
  assert.equal((await controller.enable()).state, "standby");

  failedResumeMedia.reject(new Error("old microphone resume failed"));
  await staleResume;

  assert.equal(controller.getSnapshot().state, "standby");
  assert.equal(controller.getSnapshot().gateway.ready, true);
  assert.equal(gatewayStarts, 2);
  assert.equal(gatewayStops, 1);

  assert.equal((await controller.disable()).state, "disabled");
  assert.equal((await controller.enable()).state, "standby");
  assert.equal(gatewayStarts, 3);

  await controller.suspendForBrowserRecognition();
  const lateResumeMedia = deferred();
  pendingMediaRequest = lateResumeMedia;
  const lateResume = controller.resumeStandby();
  await controller.disable();
  assert.equal((await controller.enable()).state, "standby");
  const staleTrack = { stopped: false, stop() { this.stopped = true; } };
  lateResumeMedia.resolve({ getTracks: () => [staleTrack] });
  await lateResume;
  assert.equal(staleTrack.stopped, true, "a stream granted to an obsolete resume must be released");
  assert.equal(controller.getSnapshot().state, "standby");
  assert.equal(controller.getSnapshot().gateway.ready, true);

  const sockets = [];
  let offerCount = 0;
  const gatewayClient = new LocalVoiceGatewayClient({
    fetchImpl: async () => {
      offerCount += 1;
      return {
        ok: true,
        json: async () => ({
          schemaVersion: LOCAL_VOICE_PROTOCOL.schemaVersion,
          sessionId: `session-${offerCount}`,
          nonce: `nonce-${offerCount}`,
          websocketPath: `/api/local-voice/stream?sessionId=session-${offerCount}`,
        }),
      };
    },
    createWebSocket: () => {
      const socket = {
        readyState: 0,
        bufferedAmount: 0,
        sent: [],
        send(value) { this.sent.push(value); },
        close() { this.readyState = 3; },
      };
      sockets.push(socket);
      return socket;
    },
    location: { origin: "http://127.0.0.1:4173" },
  });
  const makeReadyEvent = (sessionId) => ({
    schemaVersion: LOCAL_VOICE_PROTOCOL.schemaVersion,
    type: "session.ready",
    sessionId,
    sequence: 1,
    observedAt: new Date().toISOString(),
    mode: "wake",
    provider: "fixture",
    simulated: false,
  });
  const waitForSocket = async (count) => {
    while (sockets.length < count) await new Promise((resolve) => setImmediate(resolve));
  };

  const firstStart = gatewayClient.start();
  await waitForSocket(1);
  const firstSocket = sockets[0];
  firstSocket.readyState = 1;
  firstSocket.onopen();
  firstSocket.onmessage({ data: JSON.stringify(makeReadyEvent("session-1")) });
  await firstStart;

  gatewayClient.stop();
  const secondStart = gatewayClient.start();
  await waitForSocket(2);
  const secondSocket = sockets[1];
  secondSocket.readyState = 1;
  secondSocket.onopen();
  firstSocket.onmessage({ data: JSON.stringify(makeReadyEvent("session-1")) });
  assert.equal(gatewayClient.getSnapshot().ready, false, "a stopped socket must not ready a later session");
  secondSocket.onmessage({ data: JSON.stringify(makeReadyEvent("session-2")) });
  assert.equal((await secondStart).event.sessionId, "session-2");
  gatewayClient.stop();
  console.log("local voice capture lifecycle verification passed");
} finally {
  await controller.disable();
  if (originalAudioWorkletNode === undefined) delete globalThis.AudioWorkletNode;
  else globalThis.AudioWorkletNode = originalAudioWorkletNode;
}
