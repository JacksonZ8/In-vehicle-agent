function requirePage(page) {
  for (const method of ["addInitScript", "evaluate"]) {
    if (typeof page?.[method] !== "function") throw new TypeError(`page.${method} must be a function`);
  }
}

function requireRequestId(requestId) {
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new TypeError("requestId must be a non-empty string");
  }
  return requestId.trim();
}

function requireTimeoutMs(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }
  return timeoutMs;
}

function installBrowserVoicePlaybackProbe() {
  const MAX_PROVISIONAL_BOUNDARIES = 128;
  const MAX_PROVISIONAL_FACTS_PER_BOUNDARY = 128;
  const MAX_PROVISIONAL_FACTS = 512;
  const MAX_INVALID_PROVISIONAL_REQUESTS = 128;
  const state = window.__hmiVoicePlaybackProbe || {
    facts: [],
    provisionalFacts: [],
    submissions: {},
    retiredRequestIds: [],
    submissionEpoch: 0,
    attemptEpoch: 0,
    boundaryEpoch: 0,
    requestBoundaries: {},
    invalidProvisionalRequestIds: [],
  };
  if (!Array.isArray(state.facts)) state.facts = [];
  if (!Array.isArray(state.provisionalFacts)) state.provisionalFacts = [];
  if (!Array.isArray(state.retiredRequestIds)) state.retiredRequestIds = [];
  if (!Number.isFinite(state.submissionEpoch) || state.submissionEpoch < 0) {
    const knownGenerations = [
      ...state.facts.map((fact) => fact?.generation),
      ...Object.values(state.submissions).map((submission) => submission?.generation),
    ].filter(Number.isFinite);
    state.submissionEpoch = knownGenerations.length ? Math.max(...knownGenerations) : 0;
  }
  if (!Number.isFinite(state.attemptEpoch) || state.attemptEpoch < 0) state.attemptEpoch = 0;
  if (!Number.isFinite(state.boundaryEpoch) || state.boundaryEpoch < 0) state.boundaryEpoch = 0;
  if (!state.requestBoundaries
    || typeof state.requestBoundaries !== "object"
    || Array.isArray(state.requestBoundaries)) {
    state.requestBoundaries = {};
  }
  state.invalidProvisionalRequestIds = [
    ...new Set(Array.isArray(state.invalidProvisionalRequestIds)
      ? state.invalidProvisionalRequestIds.filter((requestId) => typeof requestId === "string")
      : []),
  ].slice(-MAX_INVALID_PROVISIONAL_REQUESTS);
  window.__hmiVoicePlaybackProbe = state;

  const currentRunId = () => {
    const debug = window.__runtimeDebug?.() || window.__vehicleDebug?.() || {};
    return debug.currentRun?.requestId
      || debug.currentTurn?.runId
      || debug.latestRun?.requestId
      || null;
  };
  const activeSubmission = (requestId) => {
    const submission = state.submissions[requestId];
    if (Number.isFinite(submission)) {
      return { submittedAtPerf: submission, generation: 0 };
    }
    return Number.isFinite(submission?.submittedAtPerf) && Number.isFinite(submission?.generation)
      ? submission
      : null;
  };
  const generationIsActive = (requestId, generation) => {
    const submission = activeSubmission(requestId);
    return Boolean(submission) && submission.generation === generation;
  };
  const currentBoundary = (requestId) => Number.isFinite(state.requestBoundaries[requestId])
    ? state.requestBoundaries[requestId]
    : null;
  const requestIsRetired = (requestId) => state.retiredRequestIds.includes(requestId);
  const requestIsInvalid = (requestId) => state.invalidProvisionalRequestIds.includes(requestId);
  const markProvisionalRequestInvalid = (requestId) => {
    const invalidRequestIds = state.invalidProvisionalRequestIds
      .filter((candidate) => candidate !== requestId);
    invalidRequestIds.push(requestId);
    state.invalidProvisionalRequestIds = invalidRequestIds.slice(-MAX_INVALID_PROVISIONAL_REQUESTS);
  };
  const invalidateProvisionalBoundary = (requestId, boundaryEpoch) => {
    if (currentBoundary(requestId) === boundaryEpoch) delete state.requestBoundaries[requestId];
    state.provisionalFacts = state.provisionalFacts.filter((fact) => fact.requestId !== requestId
      || fact.boundaryEpoch !== boundaryEpoch);
    markProvisionalRequestInvalid(requestId);
  };
  const ensureProvisionalBoundary = (requestId) => {
    if (typeof requestId !== "string" || !requestId) return null;
    if (requestIsRetired(requestId) || requestIsInvalid(requestId)) return null;
    const existing = currentBoundary(requestId);
    if (Number.isFinite(existing)) return existing;
    const provisionalBoundaryCount = Object.keys(state.requestBoundaries)
      .filter((candidate) => !activeSubmission(candidate)).length;
    if (provisionalBoundaryCount >= MAX_PROVISIONAL_BOUNDARIES) return null;
    state.boundaryEpoch += 1;
    state.requestBoundaries[requestId] = state.boundaryEpoch;
    return state.boundaryEpoch;
  };
  const nextAttemptEpoch = () => {
    state.attemptEpoch += 1;
    return state.attemptEpoch;
  };
  const attemptContextIsCurrent = (requestId, generation, boundaryEpoch) => {
    if (!Number.isFinite(boundaryEpoch) || currentBoundary(requestId) !== boundaryEpoch) return false;
    return Number.isFinite(generation)
      ? generationIsActive(requestId, generation)
      : !activeSubmission(requestId);
  };
  const factCanComplete = (fact) => Boolean(fact) && attemptContextIsCurrent(
    fact.requestId,
    fact.generation,
    fact.boundaryEpoch,
  );
  const recordFact = ({
    requestId,
    generation,
    attemptEpoch,
    boundaryEpoch,
    source,
    sourceKind,
    startedAtPerf,
    completedAtPerf = null,
  }) => {
    if (!attemptContextIsCurrent(requestId, generation, boundaryEpoch)) return null;
    const fact = {
      requestId,
      generation,
      attemptEpoch,
      boundaryEpoch,
      source,
      sourceKind,
      startedAtPerf,
      completedAtPerf,
    };
    if (Number.isFinite(generation)) {
      state.facts.push(fact);
    } else {
      const boundaryFactCount = state.provisionalFacts.filter((candidate) => (
        candidate.requestId === requestId && candidate.boundaryEpoch === boundaryEpoch
      )).length;
      if (boundaryFactCount >= MAX_PROVISIONAL_FACTS_PER_BOUNDARY
        || state.provisionalFacts.length >= MAX_PROVISIONAL_FACTS) {
        invalidateProvisionalBoundary(requestId, boundaryEpoch);
        return null;
      }
      state.provisionalFacts.push(fact);
    }
    return fact;
  };

  const NativeAudio = window.Audio;
  if (typeof NativeAudio === "function" && NativeAudio.__nioVoicePlaybackProbeWrapped !== true) {
    const ObservedAudio = new Proxy(NativeAudio, {
      construct(Target, args) {
        const audio = Reflect.construct(Target, args, Target);
        const nativePlay = audio?.play;
        if (typeof nativePlay === "function") {
          audio.play = function observedAudioPlay(...playArgs) {
            const source = String(args[0] ?? audio.currentSrc ?? audio.src ?? "");
            const requestId = currentRunId();
            const submission = activeSubmission(requestId);
            const attempt = {
              requestId,
              generation: submission?.generation ?? null,
              attemptEpoch: nextAttemptEpoch(),
              boundaryEpoch: Number.isFinite(submission?.boundaryEpoch)
                ? submission.boundaryEpoch
                : ensureProvisionalBoundary(requestId),
              sourceKind: source.startsWith("blob:") ? "provider-audio" : "local-audio",
              accepted: false,
              rejected: false,
              playAtPerf: null,
              playingAtPerf: null,
              endedAtPerf: null,
              fact: null,
            };
            const commitStart = () => {
              if (!attempt.accepted || attempt.rejected || attempt.fact) return;
              const startedAtPerf = Number.isFinite(attempt.playingAtPerf)
                ? attempt.playingAtPerf
                : attempt.playAtPerf;
              if (!Number.isFinite(startedAtPerf)) return;
              attempt.fact = recordFact({
                requestId: attempt.requestId,
                generation: attempt.generation,
                attemptEpoch: attempt.attemptEpoch,
                boundaryEpoch: attempt.boundaryEpoch,
                source: "audio-play",
                sourceKind: attempt.sourceKind,
                startedAtPerf,
                completedAtPerf: attempt.endedAtPerf,
              });
            };
            if (typeof audio.addEventListener === "function") {
              audio.addEventListener("play", () => {
                attempt.playAtPerf ??= performance.now();
                commitStart();
              }, { once: true });
              audio.addEventListener("playing", () => {
                attempt.playingAtPerf ??= performance.now();
                commitStart();
              }, { once: true });
              audio.addEventListener("ended", () => {
                if (attempt.fact
                  ? !factCanComplete(attempt.fact)
                  : !attemptContextIsCurrent(
                    attempt.requestId,
                    attempt.generation,
                    attempt.boundaryEpoch,
                  )) return;
                attempt.endedAtPerf ??= performance.now();
                if (attempt.fact && !Number.isFinite(attempt.fact.completedAtPerf)) {
                  attempt.fact.completedAtPerf = attempt.endedAtPerf;
                }
              }, { once: true });
            }
            let playback;
            try {
              playback = nativePlay.apply(audio, playArgs);
            } catch (error) {
              attempt.rejected = true;
              throw error;
            }
            if (playback && typeof playback.then === "function") {
              return Promise.resolve(playback).then(
                (value) => {
                  attempt.accepted = true;
                  commitStart();
                  return value;
                },
                (error) => {
                  attempt.rejected = true;
                  throw error;
                },
              );
            }
            attempt.accepted = true;
            commitStart();
            return playback;
          };
        }
        return audio;
      },
    });
    Object.defineProperty(ObservedAudio, "__nioVoicePlaybackProbeWrapped", { value: true });
    window.Audio = ObservedAudio;
  }

  for (const Context of new Set([window.AudioContext, window.webkitAudioContext].filter(Boolean))) {
    const nativeCreateBufferSource = Context?.prototype?.createBufferSource;
    if (typeof nativeCreateBufferSource !== "function"
      || nativeCreateBufferSource.__nioVoicePlaybackProbeWrapped === true) continue;
    function observedCreateBufferSource(...args) {
      const source = nativeCreateBufferSource.apply(this, args);
      const nativeStart = source?.start;
      if (typeof nativeStart === "function") {
        source.start = function observedWebAudioStart(...startArgs) {
          const requestId = currentRunId();
          const submission = activeSubmission(requestId);
          const generation = submission?.generation ?? null;
          const attemptEpoch = nextAttemptEpoch();
          const boundaryEpoch = Number.isFinite(submission?.boundaryEpoch)
            ? submission.boundaryEpoch
            : ensureProvisionalBoundary(requestId);
          const invokedAtPerf = performance.now();
          const contextTime = Number(this?.context?.currentTime ?? source?.context?.currentTime);
          const scheduledAt = Number(startArgs[0]);
          let endedAtPerf = null;
          let fact = null;
          if (typeof source.addEventListener === "function") {
            source.addEventListener("ended", () => {
              if (fact
                ? !factCanComplete(fact)
                : !attemptContextIsCurrent(requestId, generation, boundaryEpoch)) return;
              endedAtPerf ??= performance.now();
              if (fact && !Number.isFinite(fact.completedAtPerf)) fact.completedAtPerf = endedAtPerf;
            }, { once: true });
          }
          const result = nativeStart.apply(source, startArgs);
          const scheduledDelayMs = Number.isFinite(scheduledAt) && Number.isFinite(contextTime)
            ? Math.max(0, (scheduledAt - contextTime) * 1000)
            : 0;
          fact = recordFact({
            requestId,
            generation,
            attemptEpoch,
            boundaryEpoch,
            source: "web-audio-start",
            sourceKind: "provider-audio",
            startedAtPerf: invokedAtPerf + scheduledDelayMs,
            completedAtPerf: endedAtPerf,
          });
          return result;
        };
      }
      return source;
    }
    Object.defineProperty(observedCreateBufferSource, "__nioVoicePlaybackProbeWrapped", { value: true });
    Context.prototype.createBufferSource = observedCreateBufferSource;
  }
}

export async function installVoicePlaybackProbe({ page } = {}) {
  requirePage(page);
  await page.addInitScript(installBrowserVoicePlaybackProbe);
  await page.evaluate(installBrowserVoicePlaybackProbe);
}

export async function recordVoiceSubmission({ page, requestId, submittedAtPerf } = {}) {
  requirePage(page);
  const id = requireRequestId(requestId);
  if (!Number.isFinite(submittedAtPerf) || submittedAtPerf < 0) {
    throw new TypeError("submittedAtPerf must be a finite non-negative number");
  }
  await page.evaluate(({ selectedRequestId, submittedAt }) => {
    const state = window.__hmiVoicePlaybackProbe;
    if (!state) throw new Error("voice playback probe is not installed");
    const activeSubmission = state.submissions[selectedRequestId];
    const provisionalBoundary = Number.isFinite(state.requestBoundaries?.[selectedRequestId])
      ? state.requestBoundaries[selectedRequestId]
      : null;
    state.submissionEpoch = Number.isFinite(state.submissionEpoch) && state.submissionEpoch >= 0
      ? state.submissionEpoch + 1
      : 1;
    const generation = state.submissionEpoch;
    state.boundaryEpoch = Number.isFinite(state.boundaryEpoch) && state.boundaryEpoch >= 0
      ? state.boundaryEpoch + 1
      : 1;
    const boundaryEpoch = state.boundaryEpoch;
    state.retiredRequestIds = (Array.isArray(state.retiredRequestIds) ? state.retiredRequestIds : [])
      .filter((requestId) => requestId !== selectedRequestId);
    state.invalidProvisionalRequestIds = (
      Array.isArray(state.invalidProvisionalRequestIds) ? state.invalidProvisionalRequestIds : []
    ).filter((requestId) => requestId !== selectedRequestId);
    if (!Object.prototype.hasOwnProperty.call(state.requestBoundaries || {}, selectedRequestId)) {
      const victimRequestId = Object.keys(state.requestBoundaries || {})
        .find((requestId) => !state.submissions[requestId]);
      if (Object.keys(state.requestBoundaries || {}).length >= 128 && victimRequestId) {
        const victimBoundary = state.requestBoundaries[victimRequestId];
        delete state.requestBoundaries[victimRequestId];
        state.provisionalFacts = (Array.isArray(state.provisionalFacts) ? state.provisionalFacts : [])
          .filter((fact) => fact.requestId !== victimRequestId
            || fact.boundaryEpoch !== victimBoundary);
        const invalidRequestIds = state.invalidProvisionalRequestIds
          .filter((requestId) => requestId !== victimRequestId);
        invalidRequestIds.push(victimRequestId);
        state.invalidProvisionalRequestIds = invalidRequestIds.slice(-128);
      }
    }
    const reboundFacts = [];
    state.provisionalFacts = (Array.isArray(state.provisionalFacts) ? state.provisionalFacts : [])
      .filter((fact) => {
        if (fact.requestId !== selectedRequestId) return true;
        const eligible = !activeSubmission
          && Number.isFinite(provisionalBoundary)
          && fact.boundaryEpoch === provisionalBoundary
          && fact.generation === null
          && Number.isFinite(fact.startedAtPerf)
          && fact.startedAtPerf >= submittedAt;
        if (eligible) {
          fact.generation = generation;
          fact.boundaryEpoch = boundaryEpoch;
          reboundFacts.push(fact);
        }
        return false;
      });
    state.requestBoundaries ||= {};
    state.requestBoundaries[selectedRequestId] = boundaryEpoch;
    state.submissions[selectedRequestId] = {
      submittedAtPerf: submittedAt,
      generation,
      boundaryEpoch,
    };
    state.facts.push(...reboundFacts);
  }, { selectedRequestId: id, submittedAt: submittedAtPerf });
}

export async function observeVoicePlayback({ page, requestId, timeoutMs } = {}) {
  requirePage(page);
  const id = requireRequestId(requestId);
  const timeout = requireTimeoutMs(timeoutMs);
  const observation = await page.evaluate(async ({ selectedRequestId, boundedTimeoutMs }) => {
    const state = window.__hmiVoicePlaybackProbe;
    if (!state) throw new Error("voice playback probe is not installed");
    const readSubmission = () => {
      const submission = state.submissions[selectedRequestId];
      if (Number.isFinite(submission)) {
        return { submittedAtPerf: submission, generation: 0 };
      }
      return Number.isFinite(submission?.submittedAtPerf) && Number.isFinite(submission?.generation)
        ? submission
        : null;
    };
    const selectedSubmission = readSubmission();
    const submittedAtPerf = selectedSubmission?.submittedAtPerf;
    const selectedGeneration = selectedSubmission?.generation;
    const selectedBoundaryEpoch = selectedSubmission?.boundaryEpoch;
    const readTts = () => {
      const debug = window.__runtimeDebug?.() || window.__vehicleDebug?.() || {};
      const run = [debug.currentRun, debug.latestRun]
        .find((candidate) => candidate?.requestId === selectedRequestId) || null;
      return run?.ttsTelemetry || null;
    };
    const selectEvidence = (tts) => {
      const candidates = state.facts.filter((fact) => fact.startedAtPerf >= submittedAtPerf
        && fact.requestId === selectedRequestId
        && (Number.isFinite(fact.generation) ? fact.generation : 0) === selectedGeneration)
        .sort((left, right) => left.startedAtPerf - right.startedAtPerf);
      const providerFacts = candidates.filter((fact) => fact.sourceKind === "provider-audio");
      const localFacts = candidates.filter((fact) => fact.sourceKind === "local-audio");
      const firstProviderStartedAt = providerFacts[0]?.startedAtPerf;
      const localFallbackFacts = Number.isFinite(firstProviderStartedAt)
        ? localFacts.filter((fact) => fact.startedAtPerf > firstProviderStartedAt)
        : localFacts;
      const explicitFallback = tts?.status === "fallback"
        || tts?.bridge?.browserFallbackUsed === true;
      const useLocalFallback = localFallbackFacts.length > 0
        && (explicitFallback || providerFacts.length > 0 || candidates.length === localFacts.length);
      const selectedFacts = useLocalFallback
        ? localFallbackFacts
        : providerFacts.length
          ? providerFacts
          : localFacts;
      const browserFallbackUsed = explicitFallback
        || useLocalFallback
        || (providerFacts.length === 0 && localFacts.length > 0);
      return {
        selectedFacts,
        selectedFact: selectedFacts[0] || null,
        browserFallbackUsed,
      };
    };
    const collectionIsClosed = (tts, evidence) => {
      const terminal = ["completed", "failed", "fallback", "unavailable"].includes(tts?.status);
      const playbackCompleted = evidence.selectedFacts.length > 0
        && evidence.selectedFacts.every((fact) => Number.isFinite(fact.completedAtPerf));
      const latestPlaybackActivityAt = playbackCompleted
        ? Math.max(...evidence.selectedFacts.flatMap((fact) => [fact.startedAtPerf, fact.completedAtPerf]))
        : null;
      const telemetryCompletedAt = Number.isFinite(tts?.startedAtMs) && Number.isFinite(tts?.completedMs)
        ? tts.startedAtMs + tts.completedMs
        : null;
      return terminal
        && playbackCompleted
        && Number.isFinite(telemetryCompletedAt)
        && telemetryCompletedAt >= latestPlaybackActivityAt;
    };
    try {
      if (!Number.isFinite(submittedAtPerf) || !Number.isFinite(selectedGeneration)) {
        throw new Error("voice submission marker is unavailable");
      }
      const deadline = performance.now() + boundedTimeoutMs;
      let tts = null;
      let evidence = { selectedFacts: [], selectedFact: null, browserFallbackUsed: false };
      let collectionClosed = false;
      while (performance.now() <= deadline) {
        tts = readTts();
        evidence = selectEvidence(tts);
        // A terminal label alone does not close the source collection: a
        // sequential source may be created after the current source's ended
        // callback. Telemetry is only a collection-close watermark here; it
        // is never returned as browser playback completion evidence.
        collectionClosed = collectionIsClosed(tts, evidence);
        if (evidence.selectedFact && collectionClosed) break;
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      tts = readTts();
      evidence = selectEvidence(tts);
      collectionClosed = collectionIsClosed(tts, evidence);
      if (!evidence.selectedFact) throw new Error("voice observation requires an actual browser playback fact");
      const audioPlaybackCompletedAtPerf = collectionClosed
        && evidence.selectedFacts.length > 0
        && evidence.selectedFacts.every((fact) => Number.isFinite(fact.completedAtPerf))
        ? Math.max(...evidence.selectedFacts.map((fact) => fact.completedAtPerf))
        : null;
      const provider = evidence.browserFallbackUsed
        ? "browser-fallback"
        : typeof tts?.provider === "string" && tts.provider
          ? tts.provider
          : "unavailable";
      return {
        submittedAtPerf,
        firstAudioPlaybackAtPerf: evidence.selectedFact.startedAtPerf,
        audioPlaybackCompletedAtPerf,
        submissionToFirstAudioPlaybackMs: evidence.selectedFact.startedAtPerf - submittedAtPerf,
        chunkGapsMs: (Array.isArray(tts?.chunkGapsMs) ? tts.chunkGapsMs : []).filter(Number.isFinite),
        provider,
        browserFallbackUsed: evidence.browserFallbackUsed,
      };
    } finally {
      const activeSubmission = readSubmission();
      const selectedGenerationIsActive = activeSubmission?.generation === selectedGeneration;
      if (selectedGenerationIsActive) {
        delete state.submissions[selectedRequestId];
        if (state.requestBoundaries?.[selectedRequestId] === selectedBoundaryEpoch) {
          delete state.requestBoundaries[selectedRequestId];
        }
        state.provisionalFacts = (Array.isArray(state.provisionalFacts) ? state.provisionalFacts : [])
          .filter((fact) => fact.requestId !== selectedRequestId
            || fact.boundaryEpoch !== selectedBoundaryEpoch);
      }
      state.facts = state.facts.filter((fact) => fact.requestId !== selectedRequestId
        || (Number.isFinite(fact.generation) ? fact.generation : 0) !== selectedGeneration
        || (Number.isFinite(submittedAtPerf) && fact.startedAtPerf < submittedAtPerf));
      if (Number.isFinite(selectedGeneration)
        && (!activeSubmission || selectedGenerationIsActive)) {
        const retiredRequestIds = (Array.isArray(state.retiredRequestIds) ? state.retiredRequestIds : [])
          .filter((requestId) => requestId !== selectedRequestId);
        retiredRequestIds.push(selectedRequestId);
        state.retiredRequestIds = retiredRequestIds.slice(-128);
      }
    }
  }, { selectedRequestId: id, boundedTimeoutMs: timeout });
  return Object.freeze({
    submittedAtPerf: observation.submittedAtPerf,
    firstAudioPlaybackAtPerf: observation.firstAudioPlaybackAtPerf,
    audioPlaybackCompletedAtPerf: observation.audioPlaybackCompletedAtPerf,
    submissionToFirstAudioPlaybackMs: observation.submissionToFirstAudioPlaybackMs,
    chunkGapsMs: Object.freeze([...observation.chunkGapsMs]),
    provider: observation.provider,
    browserFallbackUsed: observation.browserFallbackUsed,
  });
}

export function isVoicePlaybackProviderObservation(observation) {
  return observation?.provider === "gpt-sovits"
    && observation?.browserFallbackUsed === false
    && Number.isFinite(observation?.firstAudioPlaybackAtPerf)
    && Number.isFinite(observation?.audioPlaybackCompletedAtPerf);
}
