# Voice Wake, Speaker Identity, and Spoken Confirmation Specification

Authority: browser microphone lifecycle, local wake-word detection, local speaker identity, spoken safety confirmation, confirmation modal presentation, and their integration with the existing interaction and Safety boundaries.

This specification extends, but does not weaken:

- [Runtime Architecture Specification](runtime-architecture.md);
- [Safety and Vehicle State Specification](safety-and-vehicle-state.md);
- [Vehicle Execution Specification](vehicle-execution.md);
- [Demo Readiness and Latency Specification](demo-readiness-and-latency.md).

## 1. Product decisions

- The actual wake phrases are `NOMI` and `嗨，NOMI`; “小爱同学” describes the desired interaction pattern only and is not a product wake phrase.
- The first release targets the current Mac and an open HMI page. The user accepts one initial click to enable the assistant and grant microphone permission. It is not a system-wide assistant when the page is closed.
- One enrolled primary-driver voice profile is supported. Any speaker may use ordinary chat and low-risk capabilities; only the enrolled primary driver may complete a spoken safety confirmation.
- Speaker identity is a local demo-grade signal. It is not production biometric authentication and does not claim replay resistance or automotive-grade liveness detection.
- Speaker identity never weakens Safety. Only an existing `require_confirmation` decision may be completed by voice. `reject` and `unavailable` remain non-overridable.
- Screen confirmation remains available as a modal dialog. It is not conditioned on speaker identity.
- The current vehicle HMI release keeps speaker enrollment, calibration, and spoken confirmation disabled by default. The local wake path remains available; speaker identity is an optional experimental extension behind `NIO_VOICE_IDENTITY_CONFIRMATION_ENABLED=true` and is excluded from the primary Demo Readiness path while disabled.
- The local wake, enrollment, identity, and confirmation path persists only the aggregate enrollment embedding and derived verification-policy metadata. It does not upload audio or retain recordings, individual embeddings, or calibration scores. Ordinary command transcription keeps the existing browser provider boundary and may use a browser-operated recognition service.
- The existing browser speech-recognition path remains the ordinary command transcription path in the first release.

## 2. Current baseline

The project already provides:

- `BrowserTranscriptWakeWordProvider`, which detects an anchored `NOMI` only after a microphone-button-initiated browser transcript and reports itself as simulated;
- `InteractionSessionController`, with dormant, listening, processing, speaking, five-second follow-up, cancellation, correction, and session-close behavior;
- push-to-talk browser `SpeechRecognition` and text input;
- a one-time `ConfirmationChallenge` bound to request, action digest, policy, assertions, response token, expiry, and consumption state;
- Runtime re-entry and Safety re-evaluation before Vehicle Adapter execution;
- an inline confirmation card that currently requires scrolling to the Run details area.

The new work must replace the simulated wake gate on the primary path, add local speaker verification, and surface confirmation immediately without changing the existing execution truth boundary.

## 3. Component ownership

### 3.1 VoiceCaptureController

The browser-owned controller:

- obtains microphone permission only after an explicit user action;
- uses `AudioWorklet` to produce mono 16 kHz PCM frames for local inference;
- owns the user-visible microphone state and the enable/disable control;
- switches exclusively between local PCM capture and browser `SpeechRecognition` so the two consumers do not contend for the microphone;
- suspends wake detection during assistant TTS;
- preserves the microphone button as a push-to-talk and manual barge-in fallback.

Its states are:

`disabled -> arming -> standby -> wake-detected -> command-listening -> processing -> speaking -> follow-up-listening -> standby`

The safety branch is:

`speaking -> confirmation-listening -> confirmed | cancelled | ambiguous | timed-out`

An unexpected error from any active state transitions to `degraded`; text, push-to-talk, and screen confirmation remain available.

### 3.2 LocalVoiceGatewayCoordinator

The Agent Server owns the local gateway coordinator. It:

- exposes a same-origin local WebSocket endpoint that validates the browser `Origin` and a server-issued, short-lived audio-session nonce;
- validates session state, mode changes, frame shape, sample rate, frame size, and bounded buffering;
- starts the inference worker lazily when the user enables the assistant;
- routes only typed wake, speaker, enrollment, and confirmation events back to the HMI;
- terminates the worker when the Agent Server exits;
- never exposes a separate public network listener.

The coordinator must not place PCM, embeddings, similarity scores, proof records, or full transcripts in logs, Run Detail, readiness payloads, or error responses.

### 3.3 LocalVoiceInferenceWorker

The worker is an isolated local process using a pinned `sherpa-onnx` runtime. It provides:

- open-vocabulary keyword spotting for `NOMI`, `嗨，NOMI`, the approved confirmation phrases, and the approved cancellation phrases;
- voice activity segmentation needed for enrollment and confirmation utterances;
- speaker-embedding extraction and comparison against one enrolled profile;
- deterministic event output with no Runtime, Safety, Vehicle Adapter, browser, file-upload, or cloud authority.

The first release does not use the worker for full conversational ASR.

### 3.4 VoiceIdentityStore

The server-owned store persists one profile under `.local-services`, outside Git. The record contains only:

- schema and profile version;
- anonymous local profile id;
- speaker model id and model digest;
- aggregate embedding;
- enrollment timestamp and sample count.

The file must be created with mode `600`. Writes must be atomic. Raw enrollment audio and individual sample embeddings are discarded after the aggregate has been written. Re-enrollment atomically replaces the previous profile; deletion removes the profile and invalidates outstanding voice proofs.

### 3.5 VoiceIdentityCalibrationCoordinator

The server-owned calibration coordinator manages one same-origin, short-lived calibration session at a time. It:

- requires an existing valid primary-driver profile and the exact pinned speaker model used by that profile;
- accepts exactly five explicit positive samples in this order: two near-field quiet samples, two normal seated samples, and one slightly distant or light-background-noise sample;
- cycles through three fixed prompts from a shared browser/server contract: `我是主驾，我确认执行`, `NOMI，请确认是我本人`, and `我已了解风险，确认继续执行`; the UI shows the required prompt and capture condition for every sample;
- reuses the enrollment duration, speech-ratio, silence, clipping, PCM size, and isolated-worker quality boundaries;
- compares each accepted sample only against the current aggregate profile;
- holds raw PCM, individual embeddings, and per-sample similarity scores only in bounded session memory;
- invalidates and clears the session on origin mismatch, timeout, cancellation, profile replacement, model change, or completion.

It never updates the aggregate enrollment profile. Calibration and re-enrollment remain separate user actions.

### 3.6 VoiceIdentityVerificationPolicyStore

The server persists a separate verification policy under ignored `.local-services` storage. The mode-`600`, atomically replaced record contains only:

- schema and threshold-policy version;
- bound profile id and profile version;
- speaker model id and digest;
- pass threshold and review threshold;
- accepted calibration sample count and calibration timestamp.

It does not persist raw audio, individual embeddings, or per-sample scores. Profile replacement, model digest change, malformed content, permission mismatch, or unsupported policy version makes the policy unavailable and requires recalibration. Thresholds cannot be supplied or lowered by the HMI.

### 3.7 VoiceIdentityProofStore

A voice confirmation cannot be authorized by a browser-provided boolean or similarity score. After a confirmation phrase and primary-driver match succeed on the same utterance, the server creates a private, one-time proof record bound to:

- opaque proof id;
- voice-profile id and version;
- interaction `sessionId`;
- ConfirmationChallenge id;
- challenge request id and `actionDigest`;
- policy id;
- detected confirmation intent;
- issue and expiry timestamps;
- single-use consumption state.

Only the opaque proof id may cross back to the HMI. Proof lifetime is at most eight seconds. Runtime validates and consumes the proof before accepting the voice channel, then independently validates the existing ConfirmationChallenge and re-enters Safety.

## 4. Audio and interaction flows

### 4.1 Initial enablement

The settings panel exposes `启用常驻唤醒`. On first activation:

1. the browser explains that wake, identity, and confirmation audio remain local, while ordinary command transcription retains the existing browser recognition boundary, then requests microphone permission;
2. the gateway checks local runtime and model availability;
3. the controller enters `standby` only after PCM flow and the keyword spotter are ready;
4. denial or setup failure leaves the assistant disabled and presents push-to-talk/text fallback.

Remembered browser permission may allow later page loads to re-arm automatically. If browser policy requires another gesture, the UI shows a single enable action rather than repeatedly prompting.

### 4.2 Wake and ordinary command

In `standby`, only local keyword spotting is active. Full transcription and cloud model calls are forbidden.

After `NOMI` or `嗨，NOMI` is detected:

1. the gateway emits an immutable wake event and an optional `primary-driver` / `unknown-speaker` label derived from the wake segment;
2. the interaction controller opens a real `local-kws` session;
3. the HMI gives immediate visual and audible feedback such as `我在`;
4. local PCM capture pauses and browser `SpeechRecognition` begins;
5. the final transcript enters the existing turn, Runtime, Safety, tool, response, and TTS pipeline;
6. after TTS completes, the existing five-second follow-up window starts;
7. silence or follow-up expiry returns to `standby`.

Ordinary chat and low-risk use do not require a speaker match. A wake event alone never executes a Runtime command.

### 4.3 TTS and barge-in

Wake detection is suspended while assistant TTS is playing so the assistant cannot trigger itself. The first release preserves manual microphone-button barge-in. Always-listening full-duplex barge-in and echo-reference cancellation are out of scope.

### 4.4 Spoken safety confirmation

Only a Runtime result containing a valid `require_confirmation` decision and ConfirmationChallenge opens the confirmation flow.

1. The HMI immediately opens the modal and renders the bound action, exact risk reason, required assertions, identity state, and controls.
2. The assistant reads the specific risk and asks whether to continue.
3. Confirmation listening begins only after the risk prompt finishes playing.
4. The eight-second window accepts `确认`, `确认执行`, or `继续` as confirmation and `取消`, `不要`, or `算了` as cancellation.
5. Confirmation requires the approved phrase and primary-driver match from the same segmented utterance. If a short phrase such as `确认` does not meet the speaker model's duration or quality gate, the assistant asks once for `我是主驾，我确认执行`; failure to complete that extended phrase leaves the modal on screen.
6. On success, the server issues a VoiceIdentityProof and the HMI submits the existing challenge response with `confirmationChannel=voice` and the opaque proof id.
7. Runtime validates the voice proof, validates the ConfirmationChallenge, re-enters Safety, and only then may invoke the Vehicle Adapter.
8. Cancellation closes the modal and performs zero Vehicle ToolCalls.
9. An ambiguous utterance triggers one spoken clarification. A second ambiguity, timeout, low-quality audio, or speaker mismatch leaves the modal available for screen action without executing the command.

Cancellation intent never requires a speaker match and can only close the challenge. Confirmation intent must be detected locally from the same PCM utterance used for speaker comparison; the confirmation path must not invoke browser `SpeechRecognition` or a cloud transcription provider.

### 4.5 Positive-only threshold calibration

The first current-Mac calibration milestone intentionally uses no non-enrolled-speaker samples. It measures primary-driver usability and freezes a conservative local policy; it does not validate or claim an impostor false-accept rate.

For five quality-accepted cosine-similarity scores sorted ascending as `s0 ... s4`, the lower-quintile reference uses the fixed R-7 quantile rule: `Q20 = 0.2 * s0 + 0.8 * s1`. The frozen thresholds are:

- `T_pass = clamp(Q20 - 0.02, 0.65, 0.80)`;
- `T_review = max(0.55, T_pass - 0.08)`.

At least four of the five scores must be greater than or equal to `0.65`. Otherwise calibration fails without replacing an existing valid policy, voice confirmation remains unavailable, and screen confirmation remains usable.

At runtime:

- a quality-accepted confirmation utterance with score `>= T_pass` may produce a proof;
- a score in `[T_review, T_pass)`, or a short confirmation word that cannot meet the speaker-quality gate, may trigger exactly one extended prompt: `我是主驾，我确认执行`;
- a score below `T_review`, the second ambiguous result, insufficient speech, timeout, model failure, or policy mismatch produces no proof and leaves the modal available for screen confirmation.

The HMI exposes only `not-calibrated`, `calibrated`, or `recalibration-required`. Similarity scores and threshold values are private server state.

## 5. Confirmation modal

The existing inline pending-confirmation card is replaced by a modal dialog that appears without scrolling.

Required content:

- requested action summary;
- Safety reason and non-dismissible warning;
- risk-specific assertions from the challenge;
- voice state: waiting, listening, primary driver matched, unknown speaker, ambiguous, timed out, or unavailable;
- visible countdown during the voice window;
- `确认执行` and `取消` buttons;
- a link to Run Detail for diagnostics, without making Run Detail necessary to act.

Accessibility and input rules:

- `role=dialog`, `aria-modal=true`, labelled title and description;
- focus moves into the modal, remains trapped, and returns to the prior control on close;
- Escape is cancellation;
- clicking the backdrop neither confirms nor closes the modal;
- repeated confirmation input is idempotent;
- voice and click races may produce at most one accepted challenge response;
- `reject` and `unavailable` may display an informational block dialog but never render `确认执行`.

Screen confirmation preserves the existing challenge-response path and does not require VoiceIdentityProof.

## 6. Safety invariants

- `allow` executes according to existing Safety and execution contracts.
- `require_confirmation` may proceed through a valid voice proof plus challenge, or through explicit modal click plus challenge.
- `reject` and `unavailable` cannot be converted to confirmation by speaker identity, wake state, transcript, UI state, or client-provided context.
- Speaker identity never asserts rear clearance, anti-pinch availability, speed, gear, occupancy, or any sensor fact.
- Voice proof and challenge replay, expiry, cross-request use, cross-action use, action mutation, policy mutation, profile replacement, and session mismatch all fail before Vehicle Adapter execution.
- Provider-confirmed state remains the only basis for successful vehicle animation.
- A failed or unavailable voice gateway cannot make a previously blocked path executable.

## 7. Privacy, secrets, and telemetry

- Idle wake detection, enrollment, speaker comparison, and spoken confirmation are local-only and must make zero cloud requests. Ordinary command transcription remains subject to the existing browser `SpeechRecognition` provider behavior and must be labelled separately.
- Raw PCM is kept only in bounded memory buffers and released after inference.
- No raw audio file is written by normal operation, debug mode, tests, or error handling.
- The profile file, model directory, caches, temporary sockets, and worker logs remain under ignored local-service storage.
- Public readiness may expose only service state, model identifiers, coarse duration, profile enrolled/not-enrolled, and non-sensitive reason codes.
- It must not expose embeddings, thresholds, similarity scores, audio quality vectors, proof ids, ConfirmationChallenge tokens, API keys, Authorization headers, or raw upstream errors.
- Similarity thresholds belong to a versioned server policy bound to the enrolled profile and pinned model; neither threshold nor model selection can be lowered through HMI settings.
- Settings must label the feature as local demo-grade identification without replay/liveness guarantees.

## 8. Model and public-repository boundary

The `sherpa-onnx` software runtime and every model artifact have separate licensing obligations. The public KWS model release currently lacks sufficiently explicit redistribution terms for this project's public-delivery standard. Therefore:

- model weights are not committed to Git until a model-specific redistribution license and attribution requirement are verified;
- the repository may contain a pinned model manifest, checksums, official download locations, and a user-invoked setup command;
- model installation is never performed silently during normal startup;
- downloaded models live under ignored local-service storage;
- the user-invoked `npm run setup:local-voice` command downloads the pinned archive, verifies
  its SHA-256 and archive paths, and refuses to overwrite a partial model directory;
- a missing model degrades the wake/speaker feature only and never blocks HMI, text, push-to-talk, screen confirmation, Safety, or vehicle execution;
- any future decision to bundle model weights requires a separate license review before Git staging.

Reference implementations and capabilities:

- [sherpa-onnx custom keyword spotting](https://k2-fsa.github.io/sherpa/onnx/kws/index.html);
- [sherpa-onnx speaker identification](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html);
- [open KWS model redistribution clarification](https://github.com/k2-fsa/sherpa-onnx/issues/3760).

## 9. Startup and readiness

- The voice worker is lazy and does not delay the Agent Server listener or HMI first interaction.
- Demo Readiness adds a non-critical `voice_wake_identity` stage with `ready`, `degraded`, or `disabled` state.
- Missing microphone permission, runtime, models, or enrollment cannot produce top-level `blocked` when text and push-to-talk paths remain usable.
- The collapsed settings/readiness UI shows whether wake detection, speaker identity, and spoken confirmation are available, without displaying biometric material.
- Existing 30-second `full` or `degraded` acceptance remains unchanged.
- Startup checks and readiness probes do not activate the microphone and do not generate cloud requests.

## 10. Implementation batches

### Batch 1: confirmation modal

- Extract pending-confirmation projection and modal state from the current Run-detail rendering.
- Preserve click confirmation behavior and challenge binding.
- Verify accessibility, cancellation, idempotency, and click/voice race ownership with a fake voice event.

### Batch 2: local wake path

- Add microphone opt-in, AudioWorklet capture, local stream protocol, gateway lifecycle, and fake worker contract.
- Integrate `local-kws` wake events with InteractionSessionController.
- Add model setup/readiness states and preserve push-to-talk fallback.
- Integrate the real pinned KWS runtime only after the contract is deterministic.

### Batch 3: primary-driver profile

- Add three-sample enrollment, quality rejection, aggregate embedding, mode-600 local storage, replacement, and deletion.
- Project only `primary-driver`, `unknown-speaker`, or `unavailable` to the HMI.
- Persist the profile and pinned-model metadata required for later verification-policy binding; enrollment does not hard-code or expose a comparison threshold.
- Integrate enrollment into the existing collapsed Demo Readiness panel rather than creating a separate page.
- Present three fixed Chinese phrases sequentially, record each sample only after an explicit user action, and retry only the sample that fails duration, speech-ratio, silence, or clipping checks.
- Keep enrollment controls disabled with a truthful reason until the pinned speaker and VAD models are installed, verified, and connected to the local worker.
- Pin the 3D-Speaker and Silero VAD files by exact byte size and SHA-256; keep both files under the ignored local-service model directory and load them lazily in an isolated child process.
- Accept at most eight seconds of 16 kHz mono PCM per same-origin request; the HMI auto-stops at six seconds and the server rejects samples shorter than 2.5 seconds, with more than 1% clipped samples, or with a calibrated Silero speech ratio below 0.35.
- Keep the three individual embeddings only in the origin-bound, five-minute enrollment session; after the third accepted sample, persist only their normalized aggregate and immediately release the individual vectors.

### Batch 4: spoken confirmation

- Add the five-sample positive-only calibration flow inside the existing primary-driver settings, with bounded memory, conservative threshold floor, separate mode-`600` policy storage, and profile/model invalidation.
- Add local confirmation/cancellation keyword mode, same-utterance speaker comparison, VoiceIdentityProofStore, Runtime proof validation, and modal voice states.
- Add fail-closed replay, expiry, mutation, wrong-profile, and cross-session verification.
- Complete current-Mac positive-speaker live acceptance with the real local models. Non-enrolled-speaker acceptance remains explicitly pending until a consented negative sample set is available.

## 11. Acceptance criteria

### Functional

- After one explicit permission/enable action, the open page accepts `NOMI + command` without pressing the microphone.
- Wake feedback begins within 800 ms after the wake phrase ends on the current Mac.
- Twenty wake attempts at 1–3 metres achieve at least 90% detection.
- Thirty minutes of representative background audio causes zero unintended Runtime command or Vehicle ToolCall. A false wake may open listening only.
- The existing five-second follow-up window works after a wake-originated turn.
- Push-to-talk and text remain operational with the local voice feature disabled or failed.

### Speaker identity and confirmation

- Three enrollment samples produce one aggregate local profile and no retained audio.
- Five positive calibration samples produce one profile-bound threshold policy, retain no audio, individual embeddings, or per-sample scores, and require at least four samples at or above the `0.65` safety floor.
- Primary-driver confirmation, including the extended-phrase fallback when the short utterance fails its quality gate, succeeds in at least 90% of the live acceptance attempts.
- Ten consecutive primary-driver spoken safety confirmations succeed at least nine times; every other attempt safely falls back to an extended phrase or screen confirmation and causes no duplicate Vehicle ToolCall.
- When a consented non-enrolled-speaker acceptance set is later available, its attempts must produce zero spoken safety confirmations. Until that milestone passes, the project must not claim a validated non-enrolled-speaker false-accept rate.
- A valid explicit confirmation returns to Runtime within 1.5 seconds after utterance endpoint detection.
- Speaker mismatch, ambiguity, timeout, and model failure leave the modal available and produce zero Vehicle ToolCalls.
- Screen confirmation remains usable without speaker identity.

### Safety and security

- `reject`, `unavailable`, expired challenge, consumed challenge, proof replay, wrong action, changed slots, wrong policy, wrong session, replaced profile, missing proof, and client-forged match state all produce zero Vehicle ToolCalls.
- A valid voice confirmation consumes exactly one proof and one challenge and executes the Adapter at most once.
- Confirmation never mutates or fabricates VehicleState.
- HMI animation still requires Provider-confirmed execution state.

### Privacy and resilience

- Idle, wake, enrollment, identity, and confirmation paths make zero cloud requests.
- No normal or failure path writes raw audio or logs biometric material.
- Public repository and history scans find no profile, embedding, model cache, proof token, API key, or ignored local-service artifact.
- Missing runtime/model/license-approved assets degrades the new feature without breaking the existing 30-second HMI acceptance.

## 12. Non-goals

- Full local conversational ASR;
- multiple enrolled occupants;
- replay-resistant liveness or production biometric authentication;
- claiming an impostor false-accept rate before a consented non-enrolled-speaker acceptance set is tested;
- system-wide wake while the HMI page is closed;
- full-duplex always-listening barge-in during TTS;
- changing Safety policies, VehicleState trust, Adapter execution, or Provider-confirmed animation;
- silently downloading dependencies or models during startup;
- bundling model weights without verified redistribution permission.

When the optional speaker-identity flag is disabled, the acceptance criteria for enrollment, calibration, and spoken confirmation are deferred. Screen confirmation, text input, push-to-talk, and local wake remain the supported vehicle HMI paths.
