import assert from 'node:assert/strict';
import test from 'node:test';
import { traceAdmissions } from '../qa/admission-trace.mjs';
import { admissionsBySlot, busySlotCovered, heldTransfer, receivedWhileHeld, singleSlotProblem } from '../qa/busy-slot.mjs';

// Member 2's intended general pool: one slot, no queue (as the trace records it).
const POLICY = { limit: 1, queueLimit: 0, partitioned: false };
const LARGE = 'shared-memory:0xabc/issue-3251-large-1:Owner123';
const PUBLIC = 'shared-memory:0xabc/issue-3251-public-1:Owner123';
const isLarge = admission => admission.label.includes(':0xabc/issue-3251-large-1:');
const isPublic = admission => admission.label.includes(':0xabc/issue-3251-public-1:');
// The lines the agent's trace writes (packages/agent/src/sync/admission-trace.ts).
const line = (event, id, label, at, slot = 'general', policy = POLICY) => JSON.stringify({ event, id, label, slot, ...policy, at });
const holding = (at, ...ids) => JSON.stringify({ event: 'holding', ids, at });
const trace = (...lines) => traceAdmissions(lines.join('\n'));
/** A `holding` line every second from `from` to `to` for each admission id. */
const heartbeats = (from, to, ...ids) => Array.from({ length: Math.floor((to - from) / 1000) + 1 }, (_, i) => holding(from + i * 1000, ...ids));

test('the trace pairs each admission\'s start with its release, by its id, and extends it by the holding lines that list it', () => {
  const admissions = trace(
    line('start', '41-1', LARGE, 100_000),
    'not a trace line',
    JSON.stringify({ event: 'start', id: 7, label: LARGE, at: 1 }),
    line('release', '41-9', PUBLIC, 100_200),
    line('start', '41-2', PUBLIC, 100_300, 'shared-memory'),
    holding(101_000, '41-1', '41-2', '41-404'),
    line('release', '41-1', LARGE, 101_500),
    holding(102_000, '41-1', '41-2'),
    line('start', '41-1', LARGE, 102_600),
    line('release', '41-1', LARGE, 102_700),
    JSON.stringify({ event: 'holding', ids: 'not a list', at: 103_000 }),
    '',
  );
  // A release without its start, an id no start names, a start that repeats an id, a second release and a holding
  // line after the release change nothing.
  assert.deepEqual(admissions, [
    { id: '41-1', label: LARGE, slot: 'general', policy: POLICY, startedAt: 100_000, releasedAt: 101_500, heldUntil: 101_500 },
    { id: '41-2', label: PUBLIC, slot: 'shared-memory', policy: POLICY, startedAt: 100_300, releasedAt: null, heldUntil: 102_000 },
  ]);
  // A trace written without the policy or the slot names none.
  assert.deepEqual(trace(JSON.stringify({ event: 'start', id: '41-6', label: LARGE, at: 1 }))[0],
    { id: '41-6', label: LARGE, slot: 'unknown', policy: { limit: null, queueLimit: null, partitioned: false }, startedAt: 1, releasedAt: null, heldUntil: 1 });
  assert.deepEqual(traceAdmissions(''), []);
  assert.deepEqual(traceAdmissions(undefined), []);
});

test('the transfer holds the slot only when the trace shows an admission of the large graph in the general slot, held for a while and still holding', () => {
  const now = 106_500;
  const held = trace(line('start', '41-1', PUBLIC, 90_000), line('release', '41-1', PUBLIC, 90_100), line('start', '41-2', LARGE, 100_000), ...heartbeats(101_000, 106_000, '41-2'));
  assert.deepEqual(heldTransfer(held, isLarge, { now }), { transfer: { id: '41-2', label: LARGE, slot: 'general', policy: POLICY, startedAt: 100_000, releasedAt: null, heldUntil: 106_000 } });
  // A pull that has held the slot for less than five seconds may end at once: not yet the transfer.
  const young = trace(line('start', '41-2', LARGE, 104_000), ...heartbeats(105_000, 106_000, '41-2'));
  assert.equal(heldTransfer(young, isLarge, { now }).why, 'its transfer of the large graph has held the general slot for less than 5 s');
  // No line of the last three seconds lists it: its release may have been lost, or the node died.
  const silent = trace(line('start', '41-2', LARGE, 95_000), ...heartbeats(96_000, 103_000, '41-2'));
  assert.equal(heldTransfer(silent, isLarge, { now }).why, 'no transfer of it holds a slot now: each gave it up, or no recent trace line shows it holding');
  // A running catch-up job without an admission of the large graph does not make member 2 busy.
  assert.equal(heldTransfer(trace(line('start', '41-1', PUBLIC, 90_000)), isLarge, { now }).why, 'no transfer of it was admitted to a sync slot');
  assert.equal(heldTransfer([], isLarge, { now }).why, 'no transfer of it was admitted to a sync slot');
  // A transfer that has already given up the slot holds nothing.
  const ended = trace(line('start', '41-2', LARGE, 100_000), line('release', '41-2', LARGE, 100_500), line('start', '41-3', PUBLIC, 101_000));
  assert.equal(heldTransfer(ended, isLarge, { now }).why, 'no transfer of it holds a slot now: each gave it up, or no recent trace line shows it holding');
  // A transfer in a reserved shared-memory slot leaves the general slot to others: it is not the case.
  const reserved = trace(line('start', '41-4', LARGE, 100_000, 'shared-memory'), ...heartbeats(101_000, 106_000, '41-4'));
  assert.equal(heldTransfer(reserved, isLarge, { now }).why, 'its transfer of the large graph holds a reserved shared-memory slot, not the general one');
  // A node that writes no trace.
  assert.equal(heldTransfer(null, isLarge, { now }).why, 'the node writes no admission trace (DKG_SYNC_ADMISSION_TRACE)');
  // Of two admissions of the large graph that qualify, the latest is the transfer.
  const two = trace(line('start', '41-2', LARGE, 99_000), line('start', '41-3', LARGE, 100_000), ...heartbeats(101_000, 106_000, '41-2', '41-3'));
  assert.equal(heldTransfer(two, isLarge, { now }).transfer.id, '41-3');
  // One in the general slot qualifies beside one in a reserved slot.
  const beside = trace(line('start', '41-2', LARGE, 100_000), line('start', '41-3', LARGE, 100_100, 'shared-memory'), ...heartbeats(101_000, 106_000, '41-2', '41-3'));
  assert.equal(heldTransfer(beside, isLarge, { now }).transfer.id, '41-2');
});

test('case 6 counts only on one general sync slot and no queue; the reserved slots beside it are the fixes', () => {
  assert.equal(singleSlotProblem(POLICY), null);
  // DKG_SYNC_GLOBAL_MAX_INFLIGHT=8 inherited by the node: spare general slots, so a busy slot proves nothing.
  assert.equal(singleSlotProblem({ ...POLICY, limit: 8 }), 'the node runs 8 general sync slot(s), not one');
  assert.equal(singleSlotProblem({ ...POLICY, queueLimit: 4 }), 'the node has a general sync queue of 4, not none');
  assert.equal(singleSlotProblem({ ...POLICY, partitioned: true }), 'its general sync slots are partitioned, not one pool');
  assert.equal(singleSlotProblem({ limit: null, queueLimit: null, partitioned: false }), 'its trace names no sync policy');
  assert.equal(singleSlotProblem(undefined), 'its trace names no sync policy');
  // The transfer's own record decides.
  const spare = trace(line('start', '41-2', LARGE, 100_000, 'general', { limit: 8, queueLimit: 0, partitioned: false }), ...heartbeats(101_000, 106_000, '41-2'));
  assert.equal(heldTransfer(spare, isLarge, { now: 106_500 }).why, 'the node runs 8 general sync slot(s), not one');
  // The diagnostics report one pool of 3 slots and a queue of 16 for this node (#3258, #3302); the trace shows the
  // general pool (1 slot, no queue) holding the transfer while a pull of the public graph runs in the reserved slot.
  const fixed = trace(
    line('start', '41-2', LARGE, 100_000), ...heartbeats(101_000, 106_000, '41-2'),
    line('start', '41-3', PUBLIC, 106_200, 'shared-memory'), line('start', '41-4', 'durable:control-plane', 106_300, 'control-plane'),
    holding(107_000, '41-2', '41-3', '41-4'), line('release', '41-3', PUBLIC, 107_400, 'shared-memory'), holding(108_000, '41-2', '41-4'),
  );
  assert.equal(heldTransfer(fixed, isLarge, { now: 106_500 }).transfer.id, '41-2');
  const busy = busySlotCovered({ transfer: heldTransfer(fixed, isLarge, { now: 106_500 }).transfer, admissions: fixed, until: 107_500 });
  assert.deepEqual(busy, { held: true, provenUntil: 108_000 });
  assert.equal(receivedWhileHeld(107_500, busy), true);
  assert.deepEqual(admissionsBySlot(fixed, isPublic, 106_000, 107_500), { 'shared-memory': 1 });
});

test('a receipt counts only up to the last trace line that shows the transfer holding the slot', () => {
  const transfer = { id: '41-2', label: LARGE, startedAt: 95_000 };
  // Still holding, as the holding lines after the window show: every receipt in it counts.
  const holdingTrace = trace(line('start', '41-2', LARGE, 95_000), ...heartbeats(96_000, 141_000, '41-2'));
  const held = busySlotCovered({ transfer, admissions: holdingTrace, until: 140_000 });
  assert.deepEqual(held, { held: true, provenUntil: 141_000 });
  for (const receivedAt of [100_000, 139_999, 140_000, 141_000]) assert.equal(receivedWhileHeld(receivedAt, held), true);
  assert.equal(receivedWhileHeld(141_001, held), false);
  // Released at 120 s: receipts until then count, later ones do not.
  const released = busySlotCovered({ transfer, admissions: trace(line('start', '41-2', LARGE, 95_000), ...heartbeats(96_000, 119_000, '41-2'), line('release', '41-2', LARGE, 120_000)), until: 140_000 });
  assert.deepEqual(released, { held: false, reason: 'the transfer gave up the slot', provenUntil: 120_000 });
  assert.equal(receivedWhileHeld(119_000, released), true);
  assert.equal(receivedWhileHeld(120_000, released), true);
  assert.equal(receivedWhileHeld(120_001, released), false);
  // Without a transfer, or with a trace that lost it, nothing counts.
  const none = busySlotCovered({ transfer: null, admissions: [], until: 140_000 });
  assert.deepEqual(none, { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null });
  assert.equal(receivedWhileHeld(100_000, none), false);
  assert.deepEqual(busySlotCovered({ transfer, admissions: null, until: 140_000 }),
    { held: false, reason: 'the trace no longer shows the transfer', provenUntil: null });
});

test('a lost release or a dead process ends the evidence at the last line that shows the transfer holding', () => {
  // The review's example: the large transfer runs from 100,000 to 100,500 ms, but its release cannot be written. A
  // pull of the public graph runs from 101,000 to 106,000 ms and delivers the writes; the trace is read at 107,000 ms.
  // The holding lines name what holds a slot, so none after the transfer ended lists it.
  const lost = trace(
    line('start', '41-2', LARGE, 100_000), holding(100_400, '41-2'),
    line('start', '41-3', PUBLIC, 101_000), ...heartbeats(101_400, 105_400, '41-3'), line('release', '41-3', PUBLIC, 106_000),
  );
  const confirmed = { id: '41-2', label: LARGE, startedAt: 100_000 };
  const busy = busySlotCovered({ transfer: confirmed, admissions: lost, until: 106_000 });
  assert.deepEqual(busy, { held: false, reason: 'no trace line shows the transfer holding the slot after then', provenUntil: 100_400 });
  for (const receivedAt of [102_000, 105_000, 106_000]) assert.equal(receivedWhileHeld(receivedAt, busy), false);
  // The node died at 103 s and came back as another process: nothing of the old one runs after its last line.
  const restarted = trace(
    line('start', '41-2', LARGE, 95_000), ...heartbeats(96_000, 103_000, '41-2'),
    line('start', '77-1', PUBLIC, 110_000), ...heartbeats(111_000, 120_000, '77-1'),
  );
  const afterRestart = busySlotCovered({ transfer: { id: '41-2', label: LARGE, startedAt: 95_000 }, admissions: restarted, until: 120_000 });
  assert.equal(afterRestart.provenUntil, 103_000);
  assert.equal(receivedWhileHeld(112_000, afterRestart), false);
});

test('another admission in the one general slot while the transfer held it contradicts the trace: nothing counts', () => {
  const contradicted = trace(
    line('start', '41-2', LARGE, 100_000), line('start', '41-3', PUBLIC, 103_000), ...heartbeats(101_000, 110_000, '41-2', '41-3'),
  );
  const busy = busySlotCovered({ transfer: { id: '41-2', label: LARGE, startedAt: 100_000 }, admissions: contradicted, until: 108_000 });
  assert.deepEqual(busy, { held: false, reason: `the trace shows ${PUBLIC} in the one general slot while the transfer held it`, provenUntil: null });
  assert.equal(receivedWhileHeld(104_000, busy), false);
  // A general admission that ended as the transfer started, or started once it ended, is no contradiction.
  const sequence = trace(
    line('start', '41-1', PUBLIC, 90_000), line('release', '41-1', PUBLIC, 100_000),
    line('start', '41-2', LARGE, 100_000), ...heartbeats(101_000, 109_000, '41-2'), line('release', '41-2', LARGE, 110_000),
    line('start', '41-3', PUBLIC, 110_000), line('release', '41-3', PUBLIC, 111_000),
  );
  assert.deepEqual(busySlotCovered({ transfer: { id: '41-2', label: LARGE, startedAt: 100_000 }, admissions: sequence, until: 108_000 }), { held: true, provenUntil: 110_000 });
  // Pulls in reserved slots beside the transfer are the fix, not a contradiction.
  assert.deepEqual(admissionsBySlot(sequence, isPublic, 100_500, 108_000), {});
  assert.deepEqual(admissionsBySlot(sequence, isPublic, 89_000, 112_000), { general: 2 });
});
