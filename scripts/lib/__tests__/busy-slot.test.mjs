import assert from 'node:assert/strict';
import test from 'node:test';
import { traceAdmissions } from '../qa/admission-trace.mjs';
import { busySlotCovered, heldTransfer, receivedWhileHeld, singleSlotProblem } from '../qa/busy-slot.mjs';

// Member 2's intended general pool: one slot, no queue (as the trace records it).
const POLICY = { limit: 1, queueLimit: 0, partitioned: false };
const LARGE = 'shared-memory:0xabc/issue-3251-large-1:Owner123';
const PUBLIC = 'shared-memory:0xabc/issue-3251-public-1:Owner123';
const isLarge = admission => admission.label.includes(':0xabc/issue-3251-large-1:');
// The lines the agent's trace writes (packages/agent/src/sync/admission-trace.ts).
const line = (event, id, label, at, reserved = false, policy = POLICY) => JSON.stringify({ event, id, label, reserved, ...policy, at });
const trace = (...lines) => traceAdmissions(lines.join('\n'));

test('the trace pairs each admission\'s start with its release, by its id', () => {
  const admissions = trace(
    line('start', '41-1', LARGE, 100_000),
    'not a trace line',
    JSON.stringify({ event: 'start', id: 7, label: LARGE, at: 1 }),
    line('release', '41-9', PUBLIC, 100_200),
    line('start', '41-2', PUBLIC, 100_300),
    line('release', '41-1', LARGE, 100_500),
    line('start', '41-1', LARGE, 100_600),
    line('release', '41-1', LARGE, 100_700),
    '',
  );
  // A release without its start, a start that repeats an id, and a second release change nothing.
  assert.deepEqual(admissions, [
    { id: '41-1', label: LARGE, reserved: false, policy: POLICY, startedAt: 100_000, releasedAt: 100_500 },
    { id: '41-2', label: PUBLIC, reserved: false, policy: POLICY, startedAt: 100_300, releasedAt: null },
  ]);
  assert.equal(trace(line('start', '41-5', PUBLIC, 1, true))[0].reserved, true);
  // A trace written without the policy names none.
  assert.deepEqual(trace(JSON.stringify({ event: 'start', id: '41-6', label: LARGE, at: 1 }))[0].policy, { limit: null, queueLimit: null, partitioned: false });
  assert.deepEqual(traceAdmissions(''), []);
  assert.deepEqual(traceAdmissions(undefined), []);
});

test('the transfer holds the slot only when the trace shows an admission of the large graph that has not given it up', () => {
  const holding = trace(line('start', '41-1', PUBLIC, 90_000), line('release', '41-1', PUBLIC, 90_100), line('start', '41-2', LARGE, 100_000));
  assert.deepEqual(heldTransfer(holding, isLarge), { transfer: { id: '41-2', label: LARGE, reserved: false, policy: POLICY, startedAt: 100_000, releasedAt: null } });
  // A running catch-up job without an admission of the large graph does not make member 2 busy.
  assert.equal(heldTransfer(trace(line('start', '41-1', PUBLIC, 90_000)), isLarge).why, 'no transfer of it was admitted to a sync slot');
  assert.equal(heldTransfer([], isLarge).why, 'no transfer of it was admitted to a sync slot');
  // A transfer that has already given up the slot holds nothing.
  const ended = trace(line('start', '41-2', LARGE, 100_000), line('release', '41-2', LARGE, 100_500), line('start', '41-3', PUBLIC, 101_000));
  assert.equal(heldTransfer(ended, isLarge).why, 'its transfer of the large graph had already given up the slot');
  // A transfer in a reserved shared-memory slot leaves the general slot to others: it is not the case.
  assert.equal(heldTransfer(trace(line('start', '41-4', LARGE, 100_000, true)), isLarge).why,
    'its transfer of the large graph holds a reserved shared-memory slot, not the general one');
  // A node that writes no trace.
  assert.equal(heldTransfer(null, isLarge).why, 'the node writes no admission trace (DKG_SYNC_ADMISSION_TRACE)');
  // Of two admissions of the large graph that hold slots, the latest is the transfer.
  const two = trace(line('start', '41-2', LARGE, 100_000), line('start', '41-3', LARGE, 100_100));
  assert.equal(heldTransfer(two, isLarge).transfer.id, '41-3');
});

test('case 6 counts only on one general sync slot and no queue; the reserved shared-memory slot beside it is the fix', () => {
  assert.equal(singleSlotProblem(POLICY), null);
  // DKG_SYNC_GLOBAL_MAX_INFLIGHT=8 inherited by the node: spare general slots, so a busy slot proves nothing.
  assert.equal(singleSlotProblem({ ...POLICY, limit: 8 }), 'the node runs 8 general sync slot(s), not one');
  assert.equal(singleSlotProblem({ ...POLICY, queueLimit: 4 }), 'the node has a general sync queue of 4, not none');
  assert.equal(singleSlotProblem({ ...POLICY, partitioned: true }), 'its general sync slots are partitioned, not one pool');
  assert.equal(singleSlotProblem({ limit: null, queueLimit: null, partitioned: false }), 'its trace names no sync policy');
  assert.equal(singleSlotProblem(undefined), 'its trace names no sync policy');
  // The transfer's own record decides.
  const spare = trace(line('start', '41-2', LARGE, 100_000, false, { limit: 8, queueLimit: 0, partitioned: false }));
  assert.equal(heldTransfer(spare, isLarge).why, 'the node runs 8 general sync slot(s), not one');
  // With #3258 the diagnostics report one pool of 2 slots and a queue of 16 for this node; the trace shows the
  // general pool (1 slot, no queue) holding the transfer while a pull of the public graph runs in the reserved slot.
  const fixed = trace(line('start', '41-2', LARGE, 100_000), line('start', '41-3', PUBLIC, 101_000, true), line('release', '41-3', PUBLIC, 101_400, true));
  assert.equal(heldTransfer(fixed, isLarge).transfer.id, '41-2');
  const busy = busySlotCovered({ transfer: heldTransfer(fixed, isLarge).transfer, admissions: fixed, readAt: 108_000, until: 107_000 });
  assert.deepEqual(busy, { held: true, provenUntil: 108_000 });
  assert.equal(receivedWhileHeld(101_500, busy), true);
});

test('a receipt counts only when the transfer had not given up the slot by then', () => {
  const transfer = { id: '41-2', label: LARGE, startedAt: 95_000, releasedAt: null };
  // Still holding when the trace was read after the window: every receipt in it counts.
  const holding = busySlotCovered({ transfer, admissions: trace(line('start', '41-2', LARGE, 95_000)), readAt: 141_000, until: 140_000 });
  assert.deepEqual(holding, { held: true, provenUntil: 141_000 });
  for (const receivedAt of [100_000, 139_999, 140_000]) assert.equal(receivedWhileHeld(receivedAt, holding), true);
  // Released at 120 s: receipts until then count, later ones do not.
  const released = busySlotCovered({ transfer, admissions: trace(line('start', '41-2', LARGE, 95_000), line('release', '41-2', LARGE, 120_000)), readAt: 141_000, until: 140_000 });
  assert.deepEqual(released, { held: false, reason: 'the transfer gave up the slot', provenUntil: 120_000 });
  assert.equal(receivedWhileHeld(119_000, released), true);
  assert.equal(receivedWhileHeld(120_000, released), true);
  assert.equal(receivedWhileHeld(120_001, released), false);
  // Without a transfer, or with a trace that lost it, nothing counts.
  const none = busySlotCovered({ transfer: null, admissions: [], readAt: 141_000, until: 140_000 });
  assert.deepEqual(none, { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null });
  assert.equal(receivedWhileHeld(100_000, none), false);
  assert.deepEqual(busySlotCovered({ transfer, admissions: null, readAt: 141_000, until: 140_000 }),
    { held: false, reason: 'the trace no longer shows the transfer', provenUntil: null });
});

test('the examples of the reviews: a pull that replaced the transfer, and a receipt just after the release', () => {
  // The large transfer runs from 100,000 to 100,500 ms; a pull of the public graph is admitted at 101,000 ms.
  const log = [line('start', '41-2', LARGE, 100_000), line('release', '41-2', LARGE, 100_500), line('start', '41-3', PUBLIC, 101_000)];
  // Once the pull holds the slot, nothing confirms a transfer.
  assert.equal(heldTransfer(trace(...log), isLarge).why, 'its transfer of the large graph had already given up the slot');
  // Confirmed while it ran, the transfer does not cover receipts from 102,000 to 106,000 ms.
  const confirmed = heldTransfer(trace(log[0]), isLarge).transfer;
  const busy = busySlotCovered({ transfer: confirmed, admissions: trace(...log), readAt: 107_000, until: 106_000 });
  assert.deepEqual(busy, { held: false, reason: 'the transfer gave up the slot', provenUntil: 100_500 });
  for (const receivedAt of [102_000, 104_000, 106_000]) assert.equal(receivedWhileHeld(receivedAt, busy), false);
  // The transfer ends at 100.1 s; a pull admitted at 100.2 s delivers the write at 100.9 s.
  const soon = busySlotCovered({ transfer: confirmed, admissions: trace(log[0], line('release', '41-2', LARGE, 100_100), line('start', '41-3', PUBLIC, 100_200)), readAt: 102_000, until: 101_500 });
  assert.equal(receivedWhileHeld(100_900, soon), false);
});
