import assert from 'node:assert/strict';
import { expandVehicleSluCompact } from '../../src/semantic/vehicle-slu-compact.js';
import { getMissingVehicleSluRequiredSlots } from '../../src/semantic/vehicle-slu-contract.js';
import { RoutePolicy } from '../../src/application/route-policy.js';

// Structural runtime checks authored from contract-boundary-source-v1 train-only
// drafts. These are not model-evaluation questions and read no dataset or model.
const cases = [
  { id: 'cb-v1-038', intent: 'body.window.setPosition', initial: {},
    first: { zone: 'rear_right' }, last: { percent: 40 } },
  { id: 'cb-v1-041', intent: 'body.window.setPosition', initial: {},
    first: { percent: 25 }, last: { zone: 'front_left' } },
  { id: 'cb-v1-044', intent: 'seat.driver.setBackrestAngle', initial: {},
    first: { seat: 'driver' }, last: { angle: 107 } },
  { id: 'cb-v1-047', intent: 'seat.driver.setBackrestAngle', initial: {},
    first: { angle: 98 }, last: { seat: 'driver' } },
  { id: 'cb-v1-050', intent: 'seat.comfort.setLevel', initial: { level: 2 },
    first: { seatZone: 'passenger' }, last: { seatMode: 'ventilation' } },
  { id: 'cb-v1-053', intent: 'seat.comfort.setLevel', initial: { level: 1 },
    first: { seatMode: 'heat' }, last: { seatZone: 'row2_left' } },
];
const asks = {
  zone: /哪一扇/, percent: /多少开度/,
  seat: /哪个(?:座椅|座位)/, angle: /多少度|目标靠背角度/,
  seatZone: /哪个座位/, seatMode: /加热还是通风/,
};
const failures = [];
const failedQuestions = { immediate: 0, pending: 0, preserve: 0 };
let runtimeCalls = 0;

function checkQuestion(question, acceptedSlots, missingSlots, label, stage) {
  const repeated = Object.keys(acceptedSlots).filter(slot => asks[slot]?.test(question));
  const omitted = missingSlots.filter(slot => asks[slot] && !asks[slot].test(question));
  if (repeated.length || omitted.length) {
    failedQuestions[stage] += 1;
    failures.push(`${label}: repeated=${repeated.join(',')} omitted=${omitted.join(',')} question=${question}`);
  }
}

function rawTarget(id, intent, slots) {
  return expandVehicleSluCompact({ d: 'vehicle', n: 'none', f: [
    { i: intent, s: 'command', a: 'clarify', p: slots },
  ] }, { requestId: id, text: '' });
}

async function run(envelope, pending) {
  runtimeCalls += 1;
  const snapshot = structuredClone(envelope);
  const policy = new RoutePolicy({ localModel: { parse: async () => ({ semanticEnvelope: envelope }) } });
  const result = await policy.resolve('', { requestId: envelope.requestId, pending });
  assert.deepEqual(envelope, snapshot, 'raw semantic target must not be mutated');
  return result;
}

for (const spec of cases) {
  const opening = await run(rawTarget(`${spec.id}-open`, spec.intent, spec.initial));
  assert.equal(opening.clarificationTransition.action, 'open');
  assert.equal(opening.parsedCommand.actionability.actionable, false);
  const partial = await run(rawTarget(spec.id, spec.intent, spec.first), opening.clarificationTransition.nextPending);
  const pending = partial.clarificationTransition.nextPending;
  const acceptedSlots = { ...spec.initial, ...spec.first };
  const missingSlots = getMissingVehicleSluRequiredSlots(spec.intent, acceptedSlots);
  assert.equal(partial.clarificationTransition.action, 'merge');
  assert.deepEqual(pending.acceptedSlots, acceptedSlots);
  assert.deepEqual(pending.missingSlots, missingSlots);
  assert.equal(partial.parsedCommand.actionability.actionable, false);
  assert.equal(partial.decision.disposition, 'clarify');
  assert.equal(partial.decision.reasonCode, 'missing-required-slots');
  checkQuestion(partial.assistantResponse, acceptedSlots, missingSlots, spec.id, 'immediate');
  checkQuestion(pending.clarificationQuestion, acceptedSlots, missingSlots, `${spec.id}-pending`, 'pending');

  // The independent source cb-v1-029 supplies this no-action structural target.
  const noAction = expandVehicleSluCompact({ d: 'vehicle', n: 'none', f: [] }, {
    requestId: `${spec.id}-preserve-cb-v1-029`, text: '',
  });
  const preserved = await run(noAction, pending);
  assert.equal(preserved.clarificationTransition.action, 'preserve');
  assert.equal(preserved.clarificationTransition.reasonCode, 'no-action-frame');
  assert.equal(preserved.parsedCommand.actionability.actionable, false);
  assert.equal(preserved.decision.reasonCode, 'pending-clarification-continues');
  checkQuestion(preserved.assistantResponse, acceptedSlots, missingSlots, `${spec.id}-preserve`, 'preserve');

  const final = await run(rawTarget(`${spec.id}-resolve`, spec.intent, spec.last), pending);
  assert.equal(final.clarificationTransition.action, 'resolve');
  assert.equal(final.clarificationTransition.nextPending, null);
  assert.deepEqual(final.semanticEnvelope.vehicleFrames[0].slots, { ...acceptedSlots, ...spec.last });
  assert.equal(final.semanticEnvelope.vehicleFrames[0].actionNeed, 'execute');
  assert.equal(final.parsedCommand.actionability.actionable, true);
  assert.equal(final.validation.admittedWriteFrameId, 'f1');
  assert.equal(final.decision.routeId, 'vehicle-control');
}
console.log(JSON.stringify({ cases: cases.length, runtimeCalls, failedQuestions }));
assert.deepEqual(failures, [], failures.join('\n'));
console.log('PASS: merged and preserved questions ask only remaining slots; semantic targets and write authorization unchanged.');
