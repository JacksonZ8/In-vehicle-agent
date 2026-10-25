import assert from 'node:assert/strict';
import { projectVehicleSluUxMetrics, rescoreVehicleSluUxCases } from '../benchmarks/evaluate-vehicle-slu-ux.mjs';
// Pure measurement negatives: these are synthetic frame records, not model
// questions, fixtures, labels, or training data. No generation is performed.
const frame = (intent, slots, actionNeed = 'execute', missingSlots = []) => ({
  capability: intent === 'media.play' ? 'media' : 'control', intent, slots, actionNeed, missingSlots,
});
const tailgate = frame('body.tailgate.open', { open: true });
const window = frame('body.window.setPosition', { zone: 'front_left', percent: 30 });
const delta = frame(window.intent, { percent: 30 }, 'clarify', ['zone']);
const media = frame('media.play', { query: '独立合成请求预算检查' });
let tests = 0;
function check(name, rawExpected, actual, { pending = false, effective = rawExpected,
  vehicleUnrequested = 0, vehicleMismatch = 0, serviceUnrequested = 0, serviceMismatch = 0 } = {}) {
  const cases = [{ id: name, turns: [{ pendingBefore: pending,
    expected: { domain: 'vehicle', conversationNeed: 'none', frames: rawExpected, effectiveFrames: effective,
      route: { disposition: 'execute', routeId: 'task' } },
    result: { status: 'ok', rawDomain: 'vehicle', domain: 'vehicle', rawConversationNeed: 'none',
      conversationNeed: 'none', modelInvocations: 1, rawFrames: actual, effectiveFrames: actual,
      route: { disposition: 'execute', routeId: 'task' } } }] }];
  const metrics = projectVehicleSluUxMetrics(rescoreVehicleSluUxCases(cases));
  assert.deepEqual([metrics.unrequestedVehicleWriteCount, metrics.vehicleExecuteTargetMismatchCount,
    metrics.unrequestedServiceExecutionCount, metrics.serviceExecuteTargetMismatchCount],
  [vehicleUnrequested, vehicleMismatch, serviceUnrequested, serviceMismatch], name);
  tests++;
}
check('duplicate-write-exceeds-one-request', [tailgate], [tailgate, tailgate], { vehicleUnrequested: 1 });
check('two-explicit-identical-requests-have-two-budgets', [tailgate, tailgate], [tailgate, tailgate]);
check('pending-raw-effective-are-one-request', [window], [window, window], { pending: true, effective: [window], vehicleUnrequested: 1 });
check('pending-delta-allows-one-full-write', [delta], [window], { pending: true, effective: [window] });
check('pending-delta-does-not-add-a-second-budget', [delta], [window, window], { pending: true, effective: [window], vehicleUnrequested: 1 });
check('absent-pending-does-not-authorize-merged-write', [delta], [window], { effective: [window], vehicleUnrequested: 1 });
check('extra-service-is-unrequested', [media], [media, media], { serviceUnrequested: 1 });
const wrong = frame(window.intent, { zone: 'front_right', percent: 30 });
check('one-wrong-target-is-mismatch', [window], [wrong], { vehicleMismatch: 1 });
check('correct-match-takes-budget-before-wrong-extra', [window], [wrong, window], { vehicleUnrequested: 1 });
check('permutation-does-not-change-execution-counts', [window], [window, wrong], { vehicleUnrequested: 1 });
check('two-request-targets-not-a-flat-alternative-union', [delta, wrong], [wrong, wrong], {
  pending: true, effective: [window, wrong], vehicleMismatch: 1 });
check('no-request-means-no-budget', [], [tailgate], { vehicleUnrequested: 1 });
check('nonexecution-cannot-acquire-a-budget-from-effective-label', [frame(window.intent, { percent: 30 }, 'none')],
  [window], { pending: true, effective: [window], vehicleUnrequested: 1 });

const A = tailgate.intent;
const B = window.intent;
const s = { value: 1 };
const t = { value: 2 };
const request = (intent, slots, actionNeed = 'execute', aliases) => ({
  ...frame(intent, slots, actionNeed), ...(aliases ? { acceptedIntentSet: aliases } : {}),
});
const ra = (slots = s, action = 'execute', aliases) => request(A, slots, action, aliases);
const rb = (slots = s, action = 'execute', aliases) => request(B, slots, action, aliases);
const broad = ra(s, 'execute', [A, B]);
check('actual-order-preserves-near-intent-budget-1', [broad, ra(), rb()], [ra(), rb(), ra(t)], { vehicleMismatch: 1 });
check('actual-order-preserves-near-intent-budget-2', [broad, ra(), rb()], [rb(), ra(), ra(t)], { vehicleMismatch: 1 });
check('request-order-preserves-near-intent-budget-1', [broad, ra()], [ra(), rb(t)], { vehicleMismatch: 1 });
check('request-order-preserves-near-intent-budget-2', [ra(), broad], [ra(), rb(t)], { vehicleMismatch: 1 });
check('merged-aliases-cannot-expand-raw-authority', [ra(s, 'clarify')], [rb()], {
  pending: true, effective: [ra(s, 'execute', [A, B])], vehicleUnrequested: 1 });
const partial = ra({ percent: 30 }, 'clarify');
const completeLeft = ra({ percent: 30, zone: 'front_left' });
const completeRight = ra({ percent: 30, zone: 'front_right' });
const directPartial = ra({ percent: 30 });
check('pending-bindings-order-1', [directPartial, partial], [directPartial, completeLeft], {
  pending: true, effective: [completeLeft, completeRight] });
check('pending-bindings-order-2', [directPartial, partial], [directPartial, completeLeft], {
  pending: true, effective: [completeRight, completeLeft] });
check('complete-raw-anchor-alias-order-1', [broad, ra(s, 'clarify')], [ra(), rb()], {
  pending: true, effective: [ra(), rb()] });
check('complete-raw-anchor-alias-order-2', [broad, ra(s, 'clarify')], [ra(), rb()], {
  pending: true, effective: [rb(), ra()] });
const cross = { ...tailgate, acceptedIntentSet: [A, media.intent] };
check('vehicle-service-share-one-request-budget', [cross], [tailgate, media], { serviceUnrequested: 1 });
check('vehicle-service-shared-budget-actual-order', [cross], [media, tailgate], { serviceUnrequested: 1 });
const sameTargetMedia = { ...media, slots: tailgate.slots };
check('vehicle-service-exact-alternatives-share-budget', [cross], [tailgate, sameTargetMedia], { serviceUnrequested: 1 });
check('two-cross-alternative-requests-allow-two-executions', [cross, media], [tailgate, media]);

console.log(JSON.stringify({ passed: tests, actualModelCalls: 0, trainDevEvaluationReads: 0 }));
