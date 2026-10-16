import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionClass, admissionRecords, candidateAdmissions, startInterval } from '../qa/admission-identity.mjs';
import { busySlotCovered, heldTransfer, receivedWhileHeld, singleSlotProblem } from '../qa/busy-slot.mjs';

// A reading of member 2's sync slots with its intended policy: one slot, no queue.
const POLICY = { capacityModel: 'shared', inflightLimit: 1, queueLimit: 0 };
const every = (a, b) => Array.from({ length: (b - a) / 1000 + 1 }, (_, i) => a + i * 1000);
// The identity of a transfer that started at `ms`, as a reading that answered at once names it.
const startedAt = ms => ({ from: ms - 1, to: ms, operations: ['shared-memory'] });

// The node log keeps local time in whole seconds; `T` places a time of a test on a local clock.
const BASE = new Date(2026, 9, 15, 9, 52, 0).getTime();
const T = ms => BASE + ms;
const pad = n => String(n).padStart(2, '0');
const logTime = ms => {
  const d = new Date(T(ms));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const OPERATION = '8a1576fb-b2e7-4de1-b383-944426cefe26';
const running = (ms, label) => `${logTime(ms)} sync ${OPERATION} [DKGAgent] Sync backpressure running ${label} (global inflight=1/1, queued=0/0)`;
const LARGE = '0xabc/issue-3251-large-1';
const PUBLIC = '0xabc/issue-3251-public-1';
const isLarge = record => record.label.includes(`:${LARGE}:`);

test('admission records are read from the node log, each with its label and class', () => {
  const big = 'shared-memory:0xabc/issue-3251-large-1:YeJDmN71';
  const log = [
    '2026-10-15 09:49:10 sync 85005448 [DKGAgent] Sync backpressure running shared-memory:0xabc/issue-3251-public-1:YeJDmN71 (global inflight=1/1, queued=0/0)',
    `2026-10-15 09:49:12 sync 9a [DKGAgent] Sync backpressure running ${big} (global inflight=1/1, queued=0/0)`,
    `2026-10-15 09:49:13 sync 9b [DKGAgent] Sync backpressure rejected ${big} (global inflight=1/1, queued=0/0)`,
    `[2026-10-15T07:49:14.000Z] not the agent log format: Sync backpressure running ${big}`,
    `2026-10-15 09:50:02 sync 9c [DKGAgent] Sync backpressure running ${big} (global inflight=1/1, queued=0/0)`,
  ].join('\n');
  const admissionStarts = (text, needle) => admissionRecords(text).filter(record => record.label.includes(needle)).map(record => record.startMs);
  assert.deepEqual(admissionStarts(log, big), [new Date('2026-10-15T09:49:12').getTime(), new Date('2026-10-15T09:50:02').getTime()]);
  // Any operation on the graph: the label holds the graph id between colons.
  assert.deepEqual(admissionStarts(log, ':0xabc/issue-3251-large-1:'), admissionStarts(log, big));
  assert.deepEqual(admissionStarts(log, ':0xabc/issue-3251-large-2:'), []);
  // The needle must be in the admitted label, not elsewhere on the line.
  assert.deepEqual(admissionStarts('2026-10-15 09:49:12 sync 9a [DKGAgent] Sync backpressure running shared-memory:other:Y (note :0xabc/issue-3251-large-1:)', ':0xabc/issue-3251-large-1:'), []);
  assert.deepEqual(admissionStarts('', big), []);
  assert.deepEqual(admissionStarts(undefined, big), []);
  // Every admission is a record, whatever its graph; the class is the one the node reports.
  assert.deepEqual(admissionRecords(log).map(record => [record.label, record.operation]),
    [['shared-memory:0xabc/issue-3251-public-1:YeJDmN71', 'shared-memory'], [big, 'shared-memory'], [big, 'shared-memory']]);
  assert.deepEqual(['durable:control-plane', 'changelog:x:y', 'swm-recovery:x:y', 'catalog:x', 'shared-memory'].map(admissionClass),
    ['durable', 'changelog', 'swm-recovery', 'sync', 'shared-memory']);
});

test('a reading names when its oldest running admission started, between its request and its answer', () => {
  assert.deepEqual(startInterval({ sentAt: 10_000, at: 10_040, inflight: 1, oldestActiveAgeMs: 3_000 }), { from: 6_999, to: 7_040 });
  // Without the moment of the request, the answer's moment stands for both.
  assert.deepEqual(startInterval({ at: 10_000, inflight: 1, oldestActiveAgeMs: 3_000 }), { from: 6_999, to: 7_000 });
  for (const reading of [{ at: 10_000, inflight: 0, oldestActiveAgeMs: 0 }, { at: 10_000, unreadable: 'HTTP 503' }, { at: 10_000, inflight: 1 }, undefined]) {
    assert.equal(startInterval(reading), null, JSON.stringify(reading));
  }
});

test('a running catch-up job without an admitted transfer does not make member 2 busy', () => {
  const window = { from: 100_000, until: 140_000 };
  // The regression: the job is running, the slot sampler sees work in flight,
  // but no transfer of the large graph was ever admitted.
  const samples = every(100_000, 140_000).map(at => ({ at, ...POLICY, inflight: 1, oldestActiveAgeMs: at - 95_000 }));
  assert.deepEqual(busySlotCovered({ transfer: null, samples, ...window }),
    { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null });
  assert.equal(busySlotCovered({ transfer: undefined, samples, ...window }).held, false);
});

test('the slot is busy only while the admitted transfer is the work that holds it, through the whole window', () => {
  const start = 95_000;
  const window = { from: 100_000, until: 140_000 };
  const holding = at => ({ at, ...POLICY, inflight: 1, oldestActiveAgeMs: at - start });
  const held = busySlotCovered({ transfer: startedAt(start), samples: every(99_000, 141_000).map(holding), ...window });
  assert.deepEqual(held, { held: true, provenUntil: 140_000 });
  // A second admission beside it (the reserved shared-memory slot of a fix) is younger: still the same holder.
  assert.equal(busySlotCovered({ transfer: startedAt(start), samples: every(100_000, 140_000).map(at => ({ ...holding(at), inflight: 2 })), ...window }).held, true);
  // The transfer ends at 120 s: from then on the slot is free.
  const freed = every(100_000, 140_000).map(at => (at < 120_000 ? holding(at) : { at, ...POLICY, inflight: 0, oldestActiveAgeMs: 0 }));
  assert.deepEqual(busySlotCovered({ transfer: startedAt(start), samples: freed, ...window }), { held: false, reason: 'the sync slot was free', provenUntil: 119_000 });
  // Other work holds the slot (its admission started at 118 s).
  const other = every(100_000, 140_000).map(at => (at < 120_000 ? holding(at) : { ...holding(at), oldestActiveAgeMs: at - 118_000 }));
  assert.deepEqual(busySlotCovered({ transfer: startedAt(start), samples: other, ...window }), { held: false, reason: 'the slot was held by other work', provenUntil: 119_000 });
  // A later reading may name the start a little apart from the confirming one (its latency, the clock's drift),
  // but not as far as work admitted after the transfer.
  assert.equal(busySlotCovered({ transfer: startedAt(start), samples: every(100_000, 140_000).map(at => ({ ...holding(at), oldestActiveAgeMs: at - start - 200 })), ...window }).held, true);
  assert.equal(busySlotCovered({ transfer: startedAt(start), samples: every(100_000, 140_000).map(at => ({ ...holding(at), oldestActiveAgeMs: at - start - 900 })), ...window }).reason,
    'the slot was held by other work');
  // No reading for 12 s, an unreadable reading, no reading at the end, and no reading at all prove nothing.
  const gap = every(100_000, 140_000).filter(at => at < 110_000 || at > 120_000).map(holding);
  assert.equal(busySlotCovered({ transfer: startedAt(start), samples: gap, ...window }).reason, 'no reading of the sync slot for 12 s');
  const unreadable = every(100_000, 140_000).map(at => (at === 125_000 ? { at, unreadable: 'HTTP 503' } : holding(at)));
  assert.equal(busySlotCovered({ transfer: startedAt(start), samples: unreadable, ...window }).reason, 'the sync slot could not be read (HTTP 503)');
  const short = every(100_000, 130_000).map(holding);
  assert.deepEqual(busySlotCovered({ transfer: startedAt(start), samples: short, ...window }), { held: false, reason: 'no reading of the sync slot for the last 10 s', provenUntil: 130_000 });
  assert.deepEqual(busySlotCovered({ transfer: startedAt(start), samples: [], ...window }), { held: false, reason: 'no reading of the sync slot in the window', provenUntil: null });
});

test('a reading taken before the window is no evidence, not even a free slot before the admission', () => {
  // The finding: a free reading at 99 s, busy readings from 100 s to 110 s, writes and receipts in [101 s, 110 s].
  const start = 100_000;
  const busy = at => ({ at, ...POLICY, inflight: 1, oldestActiveAgeMs: at - start });
  const samples = [{ at: 99_000, ...POLICY, inflight: 0, oldestActiveAgeMs: 0 }, ...every(100_000, 110_000).map(busy)];
  assert.deepEqual(busySlotCovered({ transfer: startedAt(start), samples, from: 101_000, until: 110_000 }), { held: true, provenUntil: 110_000 });
  // The second example: admission at 98.5 s, a free reading at 98 s, busy readings from 99 s to 110 s, window [100 s, 110 s].
  const later = [{ at: 98_000, ...POLICY, inflight: 0, oldestActiveAgeMs: 0 }, ...every(99_000, 110_000).map(at => ({ ...busy(at), oldestActiveAgeMs: at - 98_500 }))];
  assert.equal(busySlotCovered({ transfer: startedAt(98_500), samples: later, from: 100_000, until: 110_000 }).held, true);
  // Inside the window a free reading still fails it.
  const inside = every(100_000, 110_000).map(at => (at === 105_000 ? { at, ...POLICY, inflight: 0, oldestActiveAgeMs: 0 } : busy(at)));
  assert.equal(busySlotCovered({ transfer: startedAt(start), samples: inside, from: 101_000, until: 110_000 }).reason, 'the sync slot was free');
});

test('case 6 counts only on one sync slot and no queue, whatever the environment gave the node', () => {
  assert.equal(singleSlotProblem({ at: 1, ...POLICY, inflight: 1 }), null);
  // DKG_SYNC_GLOBAL_MAX_INFLIGHT=8 inherited by the node: spare slots, so a busy slot proves nothing.
  assert.equal(singleSlotProblem({ ...POLICY, inflightLimit: 8 }), 'the node runs 8 sync slot(s), not one');
  assert.equal(singleSlotProblem({ ...POLICY, queueLimit: 4 }), 'the node has a sync queue of 4, not none');
  assert.equal(singleSlotProblem({ ...POLICY, capacityModel: 'partitioned' }), 'the sync slots are not one shared pool (partitioned)');
  assert.equal(singleSlotProblem({ ...POLICY, inflightLimit: null }), 'the node runs an unknown number of sync slot(s), not one');
  assert.equal(singleSlotProblem({ at: 1, unreadable: 'HTTP 401' }), 'the sync slots could not be read (HTTP 401)');
  assert.equal(singleSlotProblem(undefined), 'the sync slots could not be read (no reading)');
  // In the window, every reading must show it.
  const start = 95_000;
  const spare = every(100_000, 110_000).map(at => ({ at, ...POLICY, inflightLimit: 8, inflight: 1, oldestActiveAgeMs: at - start }));
  assert.deepEqual(busySlotCovered({ transfer: startedAt(start), samples: spare, from: 100_000, until: 110_000 }),
    { held: false, reason: 'the node runs 8 sync slot(s), not one', provenUntil: null });
  const queued = every(100_000, 110_000).map(at => ({ at, ...POLICY, queueLimit: 20, inflight: 1, oldestActiveAgeMs: at - start }));
  assert.equal(busySlotCovered({ transfer: startedAt(start), samples: queued, from: 100_000, until: 110_000 }).reason, 'the node has a sync queue of 20, not none');
});

test('a pull admitted once the large transfer ended is not the transfer (the example of the review)', () => {
  // The large transfer runs from 100,000 to 100,500 ms. A pull of the public
  // graph is admitted at 101,000 ms; the readings from 102,000 to 106,000 ms
  // show that pull in the slot.
  const pull = at => ({ sentAt: T(at - 5), at: T(at), ...POLICY, inflight: 1, oldestActiveAgeMs: at - 101_000, oldestOperations: ['shared-memory'] });
  const samples = every(102_000, 106_000).map(pull);
  // Identified by its start (a reading at 100,200 ms named it), the transfer is not what those readings show.
  const transfer = heldTransferAt({ sentAt: T(100_195), at: T(100_200), oldestActiveAgeMs: 200 });
  assert.deepEqual(busySlotCovered({ transfer, samples, from: T(101_500), until: T(106_000) }),
    { held: false, reason: 'the slot was held by other work', provenUntil: null });
  // Nor can it be confirmed at all: by the time it had run for a second it was gone,
  const log = [running(100_000, `shared-memory:${LARGE}:Owner123`), running(101_000, `shared-memory:${PUBLIC}:Owner123`)].join('\n');
  assert.equal(heldTransfer({ sentAt: T(100_495), at: T(100_500), ...POLICY, inflight: 1, oldestActiveAgeMs: 500 }, admissionRecords(log), isLarge).why,
    'the running work had run for less than 1 s');
  // and no reading of the pull confirms a transfer: the log cannot tell which of the two started then.
  for (const reading of samples) {
    assert.equal(heldTransfer(reading, admissionRecords(log), isLarge).why, 'its log cannot tell the transfer from other work admitted at about the same time');
  }
  // The judgement this replaces (the log's start within 2.5 s of a reading's) took every one of them for the transfer.
  assert.ok(samples.every(sample => Math.abs(sample.at - sample.oldestActiveAgeMs - T(100_000)) <= 2500));
});

// The identity a reading of the transfer gives, without the checks that need a long transfer.
function heldTransferAt({ sentAt, at, oldestActiveAgeMs }) {
  return { ...startInterval({ sentAt, at, inflight: 1, oldestActiveAgeMs }), operations: ['shared-memory'] };
}

test('a reading confirms the transfer only when the log ties its start to the large graph and nothing else', () => {
  // Two pulls of the large graph from two peers, admitted in the same second (seen on a devnet), then the transfer runs.
  const log = [
    running(4_000, `shared-memory:${PUBLIC}:Owner123`),
    running(6_100, 'durable:control-plane'),
    running(6_200, `shared-memory:${LARGE}:CoreAbcd`),
    running(6_400, `shared-memory:${LARGE}:Owner123`),
  ].join('\n');
  const records = admissionRecords(log);
  const reading = (at, extra = {}) => ({ sentAt: T(at - 8), at: T(at), ...POLICY, inflight: 1, oldestActiveAgeMs: at - 6_400, oldestOperations: ['shared-memory'], ...extra });
  const held = heldTransfer(reading(9_400), records, isLarge);
  assert.deepEqual(held, { transfer: { from: T(6_391), to: T(6_400), operations: ['shared-memory'] } });
  // Either pull of the large graph can be the running one; the control-plane admission of that second is another class.
  assert.deepEqual(candidateAdmissions(reading(9_400), records).map(record => record.label), [`shared-memory:${LARGE}:CoreAbcd`, `shared-memory:${LARGE}:Owner123`]);
  // A node that names no class of its running work: the control-plane admission could be it, so nothing is confirmed.
  assert.equal(heldTransfer(reading(9_400, { oldestOperations: undefined }), records, isLarge).why,
    'its log cannot tell the transfer from other work admitted at about the same time');
  // What does not confirm it.
  assert.equal(heldTransfer(undefined, records, isLarge).why, 'no reading yet');
  assert.equal(heldTransfer(reading(9_400, { inflightLimit: 8 }), records, isLarge).why, 'the node runs 8 sync slot(s), not one');
  assert.equal(heldTransfer(reading(9_400, { inflight: 0 }), records, isLarge).why, 'its slot was free');
  assert.equal(heldTransfer(reading(9_400, { sentAt: T(9_000) }), records, isLarge).why, 'no reading came soon enough to tell when the running work started');
  assert.equal(heldTransfer(reading(7_300), records, isLarge).why, 'the running work had run for less than 1 s');
  // The pull of the public graph at 4 s still in the slot, and work the log does not name.
  assert.equal(heldTransfer(reading(9_400, { oldestActiveAgeMs: 5_400 }), records, isLarge).why, 'its slot was held by other work');
  assert.equal(heldTransfer(reading(9_400, { oldestActiveAgeMs: 7_400 }), records, isLarge).why, 'its log shows no admission that started when the running work did');
});

test('in the window, work of another class fails the transfer; a reading too slow to tell is no evidence', () => {
  const start = 95_000;
  const transfer = startedAt(start);
  const holding = at => ({ sentAt: at - 10, at, ...POLICY, inflight: 1, oldestActiveAgeMs: at - start, oldestOperations: ['shared-memory'] });
  // The evidence runs to the request of the last reading of the transfer: here one taken after the window.
  assert.deepEqual(busySlotCovered({ transfer, samples: every(100_000, 111_000).map(holding), from: 100_000, until: 110_000 }), { held: true, provenUntil: 110_990 });
  // The oldest running work is of another class: it is not the transfer, whatever its age says.
  const durable = every(100_000, 110_000).map(at => (at >= 105_000 ? { ...holding(at), oldestOperations: ['durable'] } : holding(at)));
  assert.deepEqual(busySlotCovered({ transfer, samples: durable, from: 100_000, until: 110_000 }), { held: false, reason: 'the slot was held by other work', provenUntil: 103_990 });
  // A reading that took 3 s cannot tell the transfer from work admitted just after it: no evidence either way,
  assert.deepEqual(busySlotCovered({ transfer, samples: every(100_000, 111_000).map(at => (at === 106_000 ? { ...holding(at), sentAt: at - 3_000 } : holding(at))), from: 100_000, until: 110_000 }),
    { held: true, provenUntil: 110_990 });
  // so a stretch of them is a gap.
  const slow = every(100_000, 115_000).map(at => (at > 105_000 ? { ...holding(at), sentAt: at - 3_000 } : holding(at)));
  assert.deepEqual(busySlotCovered({ transfer, samples: slow, from: 100_000, until: 115_000 }),
    { held: false, reason: 'no reading of the sync slot for 6 s (5 more came too slowly to tell which work held it)', provenUntil: 104_990 });
  assert.deepEqual(busySlotCovered({ transfer, samples: slow.filter(sample => sample.at > 105_000 && sample.at <= 108_000), from: 105_500, until: 108_000 }),
    { held: false, reason: 'no reading of the sync slot for 3 s (3 more came too slowly to tell which work held it)', provenUntil: null });
});

test('a receipt counts only when a reading taken at or after it still showed the transfer (the examples of the review)', () => {
  const start = 95_000;
  const transfer = startedAt(start);
  const holding = at => ({ at, ...POLICY, inflight: 1, oldestActiveAgeMs: at - start, oldestOperations: ['shared-memory'] });
  // The last reading of the transfer is at 100.0 s; the transfer ends at 100.1 s, a pull of the public graph
  // is admitted at 100.2 s and delivers the write at 100.9 s; the next reading shows the pull.
  const pull = { at: 101_000, ...POLICY, inflight: 1, oldestActiveAgeMs: 800, oldestOperations: ['shared-memory'] };
  const replaced = busySlotCovered({ transfer, samples: [...every(97_000, 100_000).map(holding), pull], from: 97_000, until: 102_000 });
  assert.deepEqual(replaced, { held: false, reason: 'the slot was held by other work', provenUntil: 100_000 });
  assert.equal(receivedWhileHeld(100_900, replaced), false);
  // The second example: the last reading of the transfer at 10.0 s, the transfer ends at 10.1 s, both reads
  // find the write at 10.5 s, and the next reading shows a free slot.
  const short = at => ({ at, ...POLICY, inflight: 1, oldestActiveAgeMs: at - 5_000, oldestOperations: ['shared-memory'] });
  const freed = busySlotCovered({ transfer: startedAt(5_000), samples: [...every(7_000, 10_000).map(short), { at: 11_000, ...POLICY, inflight: 0, oldestActiveAgeMs: 0 }], from: 7_000, until: 12_000 });
  assert.deepEqual(freed, { held: false, reason: 'the sync slot was free', provenUntil: 10_000 });
  assert.equal(receivedWhileHeld(10_500, freed), false);
  // The grace this replaces (one second past the last reading of the transfer) took both.
  assert.ok(100_900 <= replaced.provenUntil + 1000 && 10_500 <= freed.provenUntil + 1000);
  // Between two readings of the transfer the same admission held the slot throughout, also up to the last one.
  const through = busySlotCovered({ transfer, samples: every(100_000, 111_000).map(holding), from: 100_000, until: 110_500 });
  assert.deepEqual(through, { held: true, provenUntil: 111_000 });
  for (const receivedAt of [100_000, 105_500, 110_500]) assert.equal(receivedWhileHeld(receivedAt, through), true);
  assert.equal(receivedWhileHeld(105_500, { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null }), false);
  // A reading counts from the moment its request went out: one answered after the receipt but asked before it proves nothing about it.
  const asked = at => ({ ...holding(at), sentAt: at - 40 });
  const ended = busySlotCovered({ transfer, samples: every(100_000, 105_000).map(asked), from: 100_000, until: 106_000 });
  assert.deepEqual(ended, { held: false, reason: 'no reading of the sync slot was taken at or after the end of the window', provenUntil: 104_960 });
  assert.equal(receivedWhileHeld(104_960, ended), true);
  assert.equal(receivedWhileHeld(104_980, ended), false);
});
