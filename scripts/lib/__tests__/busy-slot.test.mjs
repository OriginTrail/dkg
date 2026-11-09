import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { traceAdmissions } from '../qa/admission-trace.mjs';
import {
  admissionsBySlot, attemptVerdict, besideTransfer, busySlotCovered, heldTransfer, LARGE_ASSET_MAX_TRIPLES, LARGE_GRAPH_MAX_TRIPLES, nextLargeSize,
  receivedWhileHeld, singleSlotProblem, transferChain, transferSettled, TRANSFER_READMIT_MS,
} from '../qa/busy-slot.mjs';

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
  // A pull no holding line has shown in the slot a second after its start may end at once: not yet the transfer.
  const young = trace(line('start', '41-2', LARGE, 105_800), holding(106_400, '41-2'));
  assert.deepEqual(heldTransfer(young, isLarge, { now }), { kind: 'young', why: 'its transfer of the large graph has held the general slot for less than 1 s' });
  // One holding line a second after its start confirms it: the writes start then.
  assert.equal(heldTransfer(trace(line('start', '41-2', LARGE, 105_400), holding(106_400, '41-2')), isLarge, { now }).transfer.id, '41-2');
  // No line of the last three seconds lists it: its release may have been lost, or the node died.
  const silent = trace(line('start', '41-2', LARGE, 95_000), ...heartbeats(96_000, 103_000, '41-2'));
  assert.deepEqual(heldTransfer(silent, isLarge, { now }), { kind: 'ended', why: 'no transfer of it holds a slot now: each gave it up, or no recent trace line shows it holding' });
  // A running catch-up job without an admission of the large graph does not make member 2 busy.
  assert.deepEqual(heldTransfer(trace(line('start', '41-1', PUBLIC, 90_000)), isLarge, { now }), { kind: 'not-admitted', why: 'no transfer of it was admitted to a sync slot' });
  assert.equal(heldTransfer([], isLarge, { now }).why, 'no transfer of it was admitted to a sync slot');
  // A transfer that has already given up the slot holds nothing.
  const ended = trace(line('start', '41-2', LARGE, 100_000), line('release', '41-2', LARGE, 100_500), line('start', '41-3', PUBLIC, 101_000));
  assert.deepEqual(heldTransfer(ended, isLarge, { now }), { kind: 'ended', why: 'no transfer of it holds a slot now: each gave it up, or no recent trace line shows it holding' });
  // A transfer in a reserved shared-memory slot leaves the general slot to others: it is not the case.
  const reserved = trace(line('start', '41-4', LARGE, 100_000, 'shared-memory'), ...heartbeats(101_000, 106_000, '41-4'));
  assert.deepEqual(heldTransfer(reserved, isLarge, { now }), { kind: 'reserved', why: 'its transfer of the large graph holds a reserved shared-memory slot, not the general one' });
  // A node that writes no trace.
  assert.deepEqual(heldTransfer(null, isLarge, { now }), { kind: 'no-trace', why: 'the node writes no admission trace (DKG_SYNC_ADMISSION_TRACE)' });
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
  assert.deepEqual(heldTransfer(spare, isLarge, { now: 106_500 }), { kind: 'policy', why: 'the node runs 8 general sync slot(s), not one' });
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

test('the same pull taking the general slot again at once continues the transfer (gate run of 556ad8d48)', () => {
  // Member 2's trace in that run, in ms from the transfer's start: the owner's pull of the large graph released the slot
  // after 18,074 ms (its round ended incomplete) and took it again 1 ms later until 25,528 ms; then the Cores' pulls of
  // the large graph. The writes were shared from about 6 s on and arrived at about 19 s and 22 s.
  const CORE_LARGE = 'shared-memory:0xabc/issue-3251-large-1:Core456';
  const gate = trace(
    line('start', '95-81', LARGE, 0), ...heartbeats(1_000, 18_000, '95-81'), line('release', '95-81', LARGE, 18_074),
    line('start', '95-83', LARGE, 18_075), ...heartbeats(19_000, 25_000, '95-83'), line('release', '95-83', LARGE, 25_528),
    line('start', '95-87', CORE_LARGE, 25_530), line('release', '95-87', CORE_LARGE, 25_565),
  );
  // Case 6 confirmed the transfer 6 s in, from the lines written by then.
  const transfer = heldTransfer(trace(line('start', '95-81', LARGE, 0), ...heartbeats(1_000, 6_000, '95-81')), isLarge, { now: 6_000 }).transfer;
  assert.equal(transfer.id, '95-81');
  assert.deepEqual(transferChain(transfer, gate).map(admission => admission.id), ['95-81', '95-83']);
  const busy = busySlotCovered({ transfer, admissions: gate, until: 23_000 });
  assert.deepEqual(busy, { held: true, provenUntil: 25_528 });
  for (const receivedAt of [19_000, 22_000]) assert.equal(receivedWhileHeld(receivedAt, busy), true);
  // With case 6's predicate the Cores' pulls of the large graph that follow at once continue it too.
  assert.deepEqual(transferChain(transfer, gate, { isTransfer: isLarge }).map(admission => admission.id), ['95-81', '95-83', '95-87']);
  assert.deepEqual(busySlotCovered({ transfer, admissions: gate, until: 25_550, isTransfer: isLarge }), { held: true, provenUntil: 25_565 });
  // Past the last release the evidence ends, as for one admission.
  const later = busySlotCovered({ transfer, admissions: gate, until: 30_000, isTransfer: isLarge });
  assert.deepEqual(later, { held: false, provenUntil: 25_565, reason: 'the transfer gave up the slot' });
  assert.equal(receivedWhileHeld(26_000, later), false);
});

test('only an immediate re-admission of the same pull in the general slot, with nothing else in the slot, continues the transfer', () => {
  const start = line('start', '41-2', LARGE, 100_000);
  const held = [...heartbeats(101_000, 109_000, '41-2'), line('release', '41-2', LARGE, 110_000)];
  const transfer = { id: '41-2', label: LARGE, startedAt: 100_000 };
  const gaveUp = { held: false, provenUntil: 110_000, reason: 'the transfer gave up the slot' };
  // Too late: the slot stood free for longer than a pull takes to come back.
  const late = trace(start, ...held, line('start', '41-3', LARGE, 110_000 + TRANSFER_READMIT_MS + 1), ...heartbeats(111_000, 125_000, '41-3'));
  assert.deepEqual(busySlotCovered({ transfer, admissions: late, until: 120_000 }), gaveUp);
  // Without case 6's predicate only the same pull continues it, not another peer's pull of the large graph.
  const otherPeer = trace(start, ...held, line('start', '41-3', 'shared-memory:0xabc/issue-3251-large-1:Core456', 110_001), ...heartbeats(111_000, 125_000, '41-3'));
  assert.deepEqual(transferChain(transfer, otherPeer).map(admission => admission.id), ['41-2']);
  assert.deepEqual(transferChain(transfer, otherPeer, { isTransfer: isLarge }).map(admission => admission.id), ['41-2', '41-3']);
  // A pull of another graph, or the same pull in a reserved slot, never continues it.
  const otherGraph = trace(start, ...held, line('start', '41-3', PUBLIC, 110_001), ...heartbeats(111_000, 125_000, '41-3'));
  assert.deepEqual(transferChain(transfer, otherGraph, { isTransfer: isLarge }).map(admission => admission.id), ['41-2']);
  const reserved = trace(start, ...held, line('start', '41-3', LARGE, 110_001, 'shared-memory'), ...heartbeats(111_000, 125_000, '41-3'));
  assert.deepEqual(busySlotCovered({ transfer, admissions: reserved, until: 120_000, isTransfer: isLarge }), gaveUp);
  // Another admission in the general slot between the two contradicts the trace: nothing counts.
  const between = trace(start, ...held, line('start', '41-9', PUBLIC, 110_050), line('release', '41-9', PUBLIC, 110_100),
    line('start', '41-3', LARGE, 110_200), ...heartbeats(111_000, 125_000, '41-3'));
  assert.deepEqual(busySlotCovered({ transfer, admissions: between, until: 120_000 }),
    { held: false, reason: `the trace shows ${PUBLIC} in the one general slot while the transfer held it`, provenUntil: null });
  // A re-admission whose own release was lost ends the evidence at its last holding line.
  const lost = trace(start, ...held, line('start', '41-3', LARGE, 110_001), ...heartbeats(111_000, 115_000, '41-3'));
  assert.deepEqual(busySlotCovered({ transfer, admissions: lost, until: 120_000 }),
    { held: false, provenUntil: 115_000, reason: 'no trace line shows the transfer holding the slot after then' });
  // The first admission's release was lost: nothing can continue it.
  const unreleased = trace(start, ...heartbeats(101_000, 109_000, '41-2'), line('start', '41-3', LARGE, 110_001), ...heartbeats(111_000, 125_000, '41-3'));
  assert.deepEqual(transferChain(transfer, unreleased).map(admission => admission.id), ['41-2']);
});

test('the trace is read for judgement once the transfer as far as it continues reached past the window', () => {
  const transfer = { id: '41-2', label: LARGE, startedAt: 100_000 };
  const until = 120_000;
  // Still holding with a line after the window, or released after it: ready.
  assert.equal(transferSettled(transfer, trace(line('start', '41-2', LARGE, 100_000), ...heartbeats(101_000, 121_000, '41-2')), { until, now: 121_100 }), true);
  assert.equal(transferSettled(transfer, trace(line('start', '41-2', LARGE, 100_000), line('release', '41-2', LARGE, 120_500)), { until, now: 120_600 }), true);
  // Holding, but no line after the window yet: wait for one.
  assert.equal(transferSettled(transfer, trace(line('start', '41-2', LARGE, 100_000), ...heartbeats(101_000, 119_000, '41-2')), { until, now: 119_500 }), false);
  // Released before the window ended: wait until the pull had its chance to take the slot again, then judge.
  const released = trace(line('start', '41-2', LARGE, 100_000), line('release', '41-2', LARGE, 115_000));
  assert.equal(transferSettled(transfer, released, { until, now: 115_000 + TRANSFER_READMIT_MS }), false);
  assert.equal(transferSettled(transfer, released, { until, now: 115_000 + TRANSFER_READMIT_MS + 1 }), true);
  // Taken again: the re-admission decides.
  const again = trace(line('start', '41-2', LARGE, 100_000), line('release', '41-2', LARGE, 115_000), line('start', '41-3', LARGE, 115_001), ...heartbeats(116_000, 119_000, '41-3'));
  assert.equal(transferSettled(transfer, again, { until, now: 120_000 }), false);
  // A trace that no longer shows the transfer has nothing to wait for.
  assert.equal(transferSettled(transfer, [], { until, now: 120_000 }), true);
  assert.equal(transferSettled(transfer, null, { until, now: 120_000 }), true);
});

test('a continuation that starts and ends in the same millisecond is taken once, and the chain ends', () => {
  // transferChain runs synchronously: a chain that never ended would hang this process, so it runs in a child with a
  // deadline. The transfer releases at 110,000 ms; the same pull takes the slot again at 110,001 ms and releases it
  // in that millisecond; a Core's pull of the large graph follows at once.
  const code = `
    const { traceAdmissions } = await import(${JSON.stringify(new URL('../qa/admission-trace.mjs', import.meta.url).href)});
    const { transferChain } = await import(${JSON.stringify(new URL('../qa/busy-slot.mjs', import.meta.url).href)});
    const lines = ${JSON.stringify([
      line('start', '41-2', LARGE, 100_000), line('release', '41-2', LARGE, 110_000),
      line('start', '41-3', LARGE, 110_001), line('release', '41-3', LARGE, 110_001),
      line('start', '41-4', 'shared-memory:0xabc/issue-3251-large-1:Core456', 110_001),
      line('release', '41-4', 'shared-memory:0xabc/issue-3251-large-1:Core456', 110_050),
    ])};
    const isLarge = admission => admission.label.includes(':0xabc/issue-3251-large-1:');
    const transfer = { id: '41-2', label: ${JSON.stringify(LARGE)} };
    console.log(JSON.stringify([
      transferChain(transfer, traceAdmissions(lines.join('\\n'))).map(admission => admission.id),
      transferChain(transfer, traceAdmissions(lines.join('\\n')), { isTransfer: isLarge }).map(admission => admission.id),
    ]));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [['41-2', '41-3'], ['41-2', '41-3', '41-4']]);
});

test('an attempt counts only when no write arrived after the transfer gave up the slot; a write never received fails it whatever the slot did', () => {
  const busy = { held: false, provenUntil: 120_000, reason: 'the transfer gave up the slot' };
  assert.deepEqual(attemptVerdict([100_000, 119_000, 120_000], busy), { late: [], missing: [], exercised: true });
  assert.deepEqual(attemptVerdict([100_000, 120_001, 130_000], busy), { late: [1, 2], missing: [], exercised: false });
  assert.deepEqual(attemptVerdict([null, 130_000, 100_000], busy), { late: [1], missing: [0], exercised: false });
  // A trace that never showed the transfer proves no receipt.
  assert.deepEqual(attemptVerdict([100_000], { held: false, provenUntil: null, reason: 'no transfer of it was admitted to a sync slot' }), { late: [0], missing: [], exercised: false });
  assert.deepEqual(attemptVerdict([], busy), { late: [], missing: [], exercised: true });
});

test('the next attempt\'s large graph is sized from the rate the last transfer held the slot at, spread over as few assets as allowed', () => {
  const options = { margin: 1.5, minGrowth: 1, maxTriplesPerAsset: 10_000, maxTriples: 400_000 };
  // The gate run of 1747d1a7d: 64 x 2000 triples held the slot 11.9 s; the writes needed it 21 s from the admission.
  // At 10,756 triples/s, 1.5 x 21 s takes 338,824 triples: 34 assets of 9966.
  const gate = nextLargeSize({ assets: 64, triples: 2000 }, { heldMs: 11_900, neededMs: 21_000 }, options);
  assert.deepEqual(gate, { assets: 34, triples: 9966, expectedHoldMs: 31_502 });
  // Never smaller than the last graph: a transfer that held the slot long enough for less still gets as many.
  assert.deepEqual(nextLargeSize({ assets: 16, triples: 8000 }, { heldMs: 20_000, neededMs: 5_000 }, options),
    { assets: 13, triples: 9847, expectedHoldMs: 20_002 });
  // At most maxTriples, unless the last graph carried more.
  assert.deepEqual(nextLargeSize({ assets: 16, triples: 8000 }, { heldMs: 10_000, neededMs: 60_000 }, options),
    { assets: 40, triples: 10_000, expectedHoldMs: 31_250 });
  assert.deepEqual(nextLargeSize({ assets: 50, triples: 10_000 }, { heldMs: 10_000, neededMs: 60_000 }, options),
    { assets: 50, triples: 10_000, expectedHoldMs: 10_000 });
  // Without a rate (nothing held the slot, or no write was made), it grows by minGrowth.
  assert.deepEqual(nextLargeSize({ assets: 16, triples: 8000 }, {}, { ...options, minGrowth: 1.5 }), { assets: 20, triples: 9600, expectedHoldMs: null });
  assert.deepEqual(nextLargeSize({ assets: 16, triples: 8000 }, { heldMs: 10_000, neededMs: null }, { ...options, minGrowth: 1.5 }),
    { assets: 20, triples: 9600, expectedHoldMs: 15_000 });
  // The defaults keep an asset under the 4 MB gossip limit and a later graph at most twice the first one. On the gate
  // run's numbers they give 26 assets of 9847 triples, held about 24 s, for the 21 s the writes needed.
  const defaults = nextLargeSize({ assets: 64, triples: 2000 }, { heldMs: 5_000, neededMs: 60_000 });
  assert.ok(defaults.triples <= LARGE_ASSET_MAX_TRIPLES && defaults.assets * defaults.triples <= LARGE_GRAPH_MAX_TRIPLES + defaults.assets, JSON.stringify(defaults));
  assert.deepEqual(nextLargeSize({ assets: 64, triples: 2000 }, { heldMs: 11_900, neededMs: 21_000 }), { assets: 26, triples: 9847, expectedHoldMs: 23_802 });
});

test('another admission at the same time as one of the transfer\'s own contradicts the one-slot policy; one between them does not', () => {
  const transfer = { id: '41-2', label: LARGE, startedAt: 100_000 };
  // A pull of the public graph in the general slot while the transfer holds it.
  const overlapping = trace(line('start', '41-2', LARGE, 100_000), line('start', '41-3', PUBLIC, 103_000), ...heartbeats(101_000, 110_000, '41-2', '41-3'));
  assert.equal(besideTransfer(transferChain(transfer, overlapping), overlapping)?.id, '41-3');
  // The review's example: the pull runs in the gap between two of the transfer's admissions. busySlotCovered proves
  // nothing for it, but the slot was free then: no admission held it beside the transfer.
  const gap = trace(
    line('start', '41-2', LARGE, 100_000), ...heartbeats(101_000, 104_000, '41-2'), line('release', '41-2', LARGE, 105_000),
    line('start', '41-9', PUBLIC, 105_020), line('release', '41-9', PUBLIC, 105_150),
    line('start', '41-4', LARGE, 105_200), ...heartbeats(106_000, 119_000, '41-4'), line('release', '41-4', LARGE, 120_000),
  );
  const chain = transferChain(transfer, gap);
  assert.deepEqual(chain.map(admission => admission.id), ['41-2', '41-4']);
  assert.equal(busySlotCovered({ transfer, admissions: gap, until: 110_000 }).provenUntil, null);
  assert.equal(besideTransfer(chain, gap), null);
  // Admissions in a reserved slot, or that end as the transfer starts, are not beside it.
  const reserved = trace(line('start', '41-2', LARGE, 100_000), line('start', '41-3', PUBLIC, 101_000, 'shared-memory'), line('release', '41-2', LARGE, 102_000));
  assert.equal(besideTransfer(transferChain(transfer, reserved), reserved), null);
  const before = trace(line('start', '41-1', PUBLIC, 90_000), line('release', '41-1', PUBLIC, 100_000), line('start', '41-2', LARGE, 100_000));
  assert.equal(besideTransfer(transferChain(transfer, before), before), null);
  assert.equal(besideTransfer([], null), null);
});
