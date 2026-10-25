import assert from 'node:assert/strict';
import { rescoreVehicleSluUxCases, projectVehicleSluUxMetrics } from '../benchmarks/evaluate-vehicle-slu-ux.mjs';
const frame = (intent, slots, actionNeed = 'execute', missingSlots = []) => ({
  capability: intent === 'media.play' ? 'media' : 'control', intent, slots, actionNeed, missingSlots,
});
const window = frame('body.window.setPosition', { zone: 'front_left', percent: 30 });
const media = frame('media.play', { query: '合成契约检查内容' });
const delta = frame('body.window.setPosition', { percent: 30 }, 'clarify', ['zone']);
const route = { disposition: 'execute', routeId: 'task' };
const clarify = { disposition: 'clarify', routeId: null };
let checks = 0;
function check(name, { raw = [window], effective = raw, expectedRaw = raw, expectedEffective = effective,
  pending = false, expectedRoute = route, actualRoute = expectedRoute, matched = true,
  unrequested = 0, mismatch = 0, serviceUnrequested = 0, serviceMismatch = 0 } = {}) {
  const original = [{ id: name, partialCompletionRequired: true, turns: [{ pendingBefore: pending,
    expected: { domain: 'vehicle', conversationNeed: 'none', frames: expectedRaw,
      effectiveFrames: expectedEffective, route: expectedRoute },
    result: { status: 'ok', domain: 'vehicle', rawDomain: 'vehicle', conversationNeed: 'none',
      rawConversationNeed: 'none', modelInvocations: 1, latencyMs: 1234, rawFrames: raw,
      effectiveFrames: effective, route: actualRoute } }], result: { allEffectiveOutcomesMatched: 'stale' } }];
  const before = JSON.stringify(original);
  const rescored = rescoreVehicleSluUxCases(original);
  assert.equal(JSON.stringify(original), before, `${name}: evidence mutated`);
  assert.strictEqual(rescored[0].turns, original[0].turns, `${name}: original observations retained`);
  assert.equal(rescored[0].result.allEffectiveOutcomesMatched, matched, `${name}: effective outcome`);
  const metrics = projectVehicleSluUxMetrics(rescored);
  assert.equal(metrics.unrequestedVehicleWriteCount, unrequested, `${name}: unrequested vehicle`);
  assert.equal(metrics.vehicleExecuteTargetMismatchCount, mismatch, `${name}: vehicle target`);
  assert.equal(metrics.unrequestedServiceExecutionCount, serviceUnrequested, `${name}: unrequested service`);
  assert.equal(metrics.serviceExecuteTargetMismatchCount, serviceMismatch, `${name}: service target`);
  assert.equal(metrics.mixedTaskPartialCompletion.numerator,
    Number(matched && unrequested === 0 && serviceUnrequested === 0), `${name}: mixed`);
  assert.equal(metrics.p50Ms, 1234, `${name}: saved latency retained`);
  checks += 9;
}
check('complete-first-turn-with-explicit-effective', { raw: [window, media] });
check('complete-first-turn-wrong-route', { raw: [window, media], actualRoute: clarify, matched: false });
const suppressed = frame(window.intent, window.slots, 'none');
check('terminal-clarify-preserves-original-request', { raw: [window, delta], effective: [suppressed, delta], expectedRoute: clarify });
check('terminal-clarify-cannot-score-execute', { raw: [window, delta], effective: [window, delta], expectedEffective: [suppressed, delta], expectedRoute: clarify, actualRoute: route, matched: false });
check('accepted-pending-full-frame', { raw: [window], expectedRaw: [delta], expectedEffective: [window], pending: true });
check('accepted-pending-raw-delta', { raw: [delta], effective: [window], expectedEffective: [window], pending: true });
check('missing-actual-pending-still-unrequested', { raw: [window], expectedRaw: [delta], expectedEffective: [window], unrequested: 1 });
for (const [name, slots] of [
  ['wrong-zone', { zone: 'front_right', percent: 30 }],
  ['wrong-value', { zone: 'front_left', percent: 45 }],
  ['extra-slot', { zone: 'front_left', percent: 30, invented: true }],
]) check(name, { raw: [frame(window.intent, slots)], expectedRaw: [delta], expectedEffective: [window], pending: true, matched: false, mismatch: 1 });
check('new-intent-not-authorized-by-pending', { raw: [frame('body.tailgate.open', { open: true })], expectedRaw: [delta], expectedEffective: [window], pending: true, matched: false, unrequested: 1 });
check('duplicate-execute-fails-exact-outcome', { raw: [window, window], expectedRaw: [delta], expectedEffective: [window], pending: true, matched: false, unrequested: 1 });
check('suppressed-service-request-not-unrequested', { raw: [media, delta], effective: [frame(media.intent, media.slots, 'none'), delta], expectedRoute: clarify });
check('service-target-still-exact', { raw: [frame(media.intent, { query: '错误合成目标' })], expectedRaw: [media], expectedEffective: [media], matched: false, serviceMismatch: 1 });
console.log(JSON.stringify({ passed: checks, syntheticCases: 14, realModelCalls: 0, fixtureReads: 0,
  limits: 'Execution safety consumes one shared budget per request; duplicate effective frames also fail exact outcome.' }));
