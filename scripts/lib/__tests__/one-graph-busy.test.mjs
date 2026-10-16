// Tests of the one-graph promotion suite's busy-slot case (case 6,
// scripts/lib/one-graph/busy-transfer.mjs and its judgements): the admissions in a
// node's log, what a reading of its sync slots shows, the transfer's life, and
// when a receipt or a delivery counts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  admissionPolicyProblem, arrivalWindow, busyReceiptOutcome, contentionSince, countLogLines, deliveryEvidence, durableStart, durableSyncAttempts,
  pairOutcome, parseAdmissions, slotHolder, transferContended, transferHeldThrough, transferLifetime, transferOccupancy,
} from '../qa/one-graph-promotion.mjs';
import { sharedMemoryScope } from '../qa/member-sharing.mjs';
import { createReport } from '../member-sharing/report.mjs';
import { busyEdge } from '../one-graph/busy-transfer.mjs';
import { createReports } from '../one-graph/reports.mjs';
import { author, BODY, LABEL, node, RDF_TYPE } from './one-graph-fixtures.mjs';

const LOG = [
  '2026-10-16 01:16:26 sync e511bfb0-f48c [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)',
  '2026-10-16 01:16:26 sync e511bfb0-f48c [DKGAgent] Syncing context graph "0xabc/one-graph-large-1" from 12D3KooW',
  '2026-10-16 01:16:27 sync 996f2627-208d [DKGAgent] Sync backpressure running shared-memory:0xabc/one-graph-main-1:cazF6csu in a reserved shared-memory slot (global inflight=1/1, queued=2/0, reserved shared-memory inflight=1/1, queued=2/16)',
  '2026-10-16 01:16:28 sync 97d57fec-bf5b [DKGAgent] Sync backpressure rejected durable:control-plane (global inflight=1/1, queued=0/0)',
  'not a log line Sync backpressure running x (global inflight=1/1, queued=0/0)',
  '2026-10-16 01:16:40 sync 11111111-2222 [DKGAgent] Sync backpressure running durable:control-plane (global inflight=1/3, queued=0/6)',
].join('\n');

test('a node log names each admission with its operation, whether it holds a reserved slot, and the general policy', () => {
  const admissions = parseAdmissions(LOG);
  assert.deepEqual(admissions.map(({ label, ctx, reserved, limit, queueLimit }) => ({ label, ctx, reserved, limit, queueLimit })), [
    { label: 'durable:0xabc/one-graph-large-1:QP4sWZbL', ctx: 'e511bfb0-f48c', reserved: false, limit: 1, queueLimit: 0 },
    { label: 'shared-memory:0xabc/one-graph-main-1:cazF6csu', ctx: '996f2627-208d', reserved: true, limit: 1, queueLimit: 0 },
    { label: 'durable:control-plane', ctx: '11111111-2222', reserved: false, limit: 3, queueLimit: 6 },
  ]);
  assert.equal(admissions[0].at, new Date('2026-10-16T01:16:26').getTime());
  assert.deepEqual(parseAdmissions(''), []);
  assert.equal(admissionPolicyProblem(admissions[0]), null);
  assert.equal(admissionPolicyProblem(admissions[2]), 'it runs 3 general sync slot(s), not one');
  assert.equal(admissionPolicyProblem({ limit: 1, queueLimit: 4 }), 'it queues up to 4 sync job(s), not none');
  assert.equal(admissionPolicyProblem({ limit: null }), 'its log names no sync policy');
  assert.equal(admissionPolicyProblem(undefined), 'its log names no sync policy');
});

test('log lines are counted within a window, each with its whole second', () => {
  const at = text => new Date(text).getTime();
  assert.equal(countLogLines(LOG, 'Sync backpressure rejected ', { from: at('2026-10-16T01:16:28.500'), until: at('2026-10-16T01:16:30') }), 1);
  assert.equal(countLogLines(LOG, 'Sync backpressure rejected ', { from: at('2026-10-16T01:16:29'), until: at('2026-10-16T01:16:30') }), 0);
  assert.equal(countLogLines(LOG, 'Sync backpressure running ', { from: 0, until: at('2026-10-16T01:16:27') }), 2);
});

// A transfer admission in the log second 01:16:26, its work dated by readings.
const T0 = new Date('2026-10-16T01:16:26.300').getTime();

const reading = (sentAt, latency, operations) => ({ sentAt, at: sentAt + latency, operations });

const durable = age => ({ lane: 'durable', operation: 'durable:catchup-foreground', oldestAgeMs: age });

const isTransfer = admission => admission.label.startsWith('durable:0xabc/one-graph-large-1:');

// A receipt dated to one moment: the window of its arrival opens and closes there.
const moment = at => ({ after: at, by: at });

test('a reading dates the running durable work; shared-memory work beside it is not the transfer', () => {
  assert.equal(durableStart(reading(T0 + 2500, 20, [{ operation: 'shared-memory:sync-on-connect', oldestAgeMs: 900 }])), null);
  assert.equal(durableStart({ at: T0, unreadable: 'HTTP 503' }), null);
  assert.deepEqual(durableStart(reading(T0 + 2500, 20, [durable(2500), { operation: 'shared-memory:x', oldestAgeMs: 100 }])), { from: T0 - 1, to: T0 + 20, age: 2500 });
});

test('a reading shows the transfer in the slot only when the log ties its durable work to the transfer and nothing else', () => {
  const admissions = parseAdmissions(LOG);
  const shown = slotHolder(reading(T0 + 2500, 20, [durable(2500)]), admissions, isTransfer);
  assert.equal(shown.state, 'transfer');
  assert.equal(shown.admission.label, 'durable:0xabc/one-graph-large-1:QP4sWZbL');
  assert.equal(slotHolder(undefined, admissions, isTransfer).state, 'unreadable');
  assert.equal(slotHolder({ at: T0, unreadable: 'HTTP 0' }, admissions, isTransfer).state, 'unreadable');
  assert.equal(slotHolder(reading(T0 + 2500, 20, []), admissions, isTransfer).state, 'other');
  assert.equal(slotHolder(reading(T0 + 2500, 400, [durable(2500)]), admissions, isTransfer).state, 'unclear');
  // Durable work the log names no admission for (its line not written yet).
  assert.equal(slotHolder(reading(T0 + 9000, 20, [durable(1500)]), admissions, isTransfer).state, 'unclear');
  // Other durable work admitted in the same second: nothing is told.
  const rival = [...admissions, { ...admissions[0], label: 'durable:control-plane', ctx: 'x' }];
  assert.equal(slotHolder(reading(T0 + 2500, 20, [durable(2500)]), rival, isTransfer).state, 'unclear');
  const other = [{ ...admissions[0], label: 'durable:0xabc/one-graph-main-1:QP4sWZbL' }];
  assert.equal(slotHolder(reading(T0 + 2500, 20, [durable(2500)]), other, isTransfer).state, 'other');
  // A reserved shared-memory admission never holds the general slot.
  assert.equal(slotHolder(reading(T0 + 2500, 20, [durable(2500)]), [{ ...admissions[0], reserved: true }], isTransfer).state, 'unclear');
});

const TRANSFER_LOG = [
  '2026-10-16 01:16:26 sync aaaa [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)',
  '2026-10-16 01:16:29 sync aaaa [DKGAgent] Sync complete: 3011 verified triples from 12D3KooW',
  '2026-10-16 01:16:31 sync bbbb [DKGAgent] Sync backpressure running durable:control-plane (global inflight=1/1, queued=0/0)',
  '2026-10-16 01:16:33 sync cccc [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:EJfXkbMM (global inflight=1/1, queued=0/0)',
  '[2026-10-16T01:16:40.000Z] sync cccc [DKGAgent] Sync page timing (a debug line in another form) [DEBUG]',
  '2026-10-16 01:16:37 sync cccc [DKGAgent]   data: 3000 triples fetched',
  '2026-10-16 01:16:50 sync dddd [DKGAgent] unrelated work',
].join('\n');

test('the transfer lives from its first admission to the last line of its admissions\' work', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  assert.deepEqual(transferLifetime(TRANSFER_LOG, admissions, isTransfer), {
    from: new Date('2026-10-16T01:16:26').getTime(), to: new Date('2026-10-16T01:16:37').getTime() + 999, admissions: 2,
  });
  assert.equal(transferLifetime(TRANSFER_LOG, admissions, () => false), null);
  assert.equal(transferLifetime('', [], isTransfer), null);
});

test('a receipt counts as made while the transfer held the slot only with a reading right after it that shows an older admission of it', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const second33 = new Date('2026-10-16T01:16:33.400').getTime();
  const holding = [reading(second33 + 4000, 20, [durable(4000)])];
  assert.deepEqual(transferHeldThrough(moment(second33 + 3500), holding, admissions, isTransfer), { held: true, why: null });
  // No reading soon enough after the receipt.
  assert.match(transferHeldThrough(moment(second33 + 1500), holding, admissions, isTransfer).why, /no reading of the slot right after it/);
  // The reading dates the running admission at 33.3 s, after the receipt at 33.2 s: not proven.
  assert.match(transferHeldThrough(moment(second33 - 200), [reading(second33 + 100, 20, [durable(200)])], admissions, isTransfer).why, /may have started after the report arrived/);
  // Dated at 32.8 s, before it (its log line came within the log lag): proven.
  assert.deepEqual(transferHeldThrough(moment(second33 - 200), [reading(second33 + 100, 20, [durable(700)])], admissions, isTransfer), { held: true, why: null });
  // Control-plane work in the slot, or none.
  const second31 = new Date('2026-10-16T01:16:31.500').getTime();
  assert.match(transferHeldThrough(moment(second31 + 1000), [reading(second31 + 1200, 20, [durable(1200)])], admissions, isTransfer).why, /other work or none/);
  assert.match(transferHeldThrough(moment(second31 + 1000), [reading(second31 + 1200, 20, [])], admissions, isTransfer).why, /other work or none/);
  assert.match(transferHeldThrough(moment(second31), [{ at: second31 + 500, unreadable: 'HTTP 503' }], admissions, isTransfer).why, /could not be read/);
  assert.match(transferHeldThrough(moment(second33 + 3500), [reading(second33 + 4000, 600, [durable(4000)])], admissions, isTransfer).why, /could not tell/);
});

test('the window\'s readings are counted by whether they show the transfer in the general slot', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const second26 = new Date('2026-10-16T01:16:26.400').getTime();
  const readings = [
    reading(second26 + 1000, 20, [durable(1000)]),
    reading(second26 + 2000, 20, [durable(2000)]),
    reading(second26 + 5500, 20, []),
    reading(second26 + 9000, 20, [durable(2000)]),
  ];
  assert.deepEqual(transferOccupancy({ readings, admissions, isTransfer, from: second26, until: second26 + 9100 }), { transfer: 3, total: 4 });
  assert.deepEqual(transferOccupancy({ readings, admissions, isTransfer, from: second26 + 3000, until: second26 + 6000 }), { transfer: 0, total: 1 });
});

test('a busy Edge\'s receipt passes only while an admission of the transfer held its slot', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const life = transferLifetime(TRANSFER_LOG, admissions, isTransfer);
  const held = { outcome: 'pass', text: '"r (1)" by node8 (edgeA) in main/reports at node9 (edgeB): in shared memory 1 s after the share' };
  // Inside the second admission (01:16:33), with a reading right after that shows it.
  const inside = new Date('2026-10-16T01:16:35.200').getTime();
  const during = transferHeldThrough(moment(inside), [reading(inside + 300, 20, [durable(2100)])], admissions, isTransfer);
  assert.deepEqual(busyReceiptOutcome(held, { received: inside, life, held: during }),
    { outcome: 'pass', text: `${held.text}, while an admission of the transfer held the general slot` });
  // Every receipt between the two admissions (01:16:30 to 01:16:32), the slot free or holding other work:
  // the case cannot pass as exercised.
  for (const at of ['2026-10-16T01:16:30.100', '2026-10-16T01:16:31.600', '2026-10-16T01:16:32.900']) {
    const between = new Date(at).getTime();
    const evidence = transferHeldThrough(moment(between), [reading(between + 300, 20, [])], admissions, isTransfer);
    const verdict = busyReceiptOutcome(held, { received: between, life, held: evidence });
    assert.equal(verdict.outcome, 'fail', at);
    assert.match(verdict.text, /; not exercised: no reading shows the transfer holding the general slot throughout the moments the report can have arrived \(the slot held other work or none\)$/);
  }
  // Slot evidence that cannot be read, or none at all, cannot pass either.
  const unread = transferHeldThrough(moment(inside), [{ at: inside + 300, unreadable: 'HTTP 503' }], admissions, isTransfer);
  assert.match(busyReceiptOutcome(held, { received: inside, life, held: unread }).text, /not exercised: .*could not be read/);
  assert.match(busyReceiptOutcome(held, { received: inside, life, held: undefined }).text, /not exercised: .*\(no reading\)$/);
  // After the transfer ended, or with no transfer at all.
  assert.match(busyReceiptOutcome(held, { received: life.to + 1, life, held: during }).text, /not exercised: the transfer of the large graph had ended by then$/);
  assert.match(busyReceiptOutcome(held, { received: inside, life: null, held: during }).text, /had ended by then$/);
  // A failed check, or a pair never received, stays as it is.
  const missed = { outcome: 'fail', text: 'NOT in shared memory' };
  assert.equal(busyReceiptOutcome(missed, { received: inside, life, held: during }), missed);
  assert.equal(busyReceiptOutcome(held, { received: null, life, held: during }), held);
});

test('a promotion\'s delivery to the busy Edge counts once the transfer held the slot between the promotion and the receipt', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const life = transferLifetime(TRANSFER_LOG, admissions, isTransfer);
  const promotedAt = new Date('2026-10-16T01:16:30.000').getTime();
  const receivedAt = new Date('2026-10-16T01:16:36.800').getTime();
  // The slot held by the second admission at 35.5, between the promotion and the receipt; the receipt itself
  // right after edgeB's own sync work (other durable work, or none).
  const readings = [
    reading(promotedAt + 500, 20, []),
    reading(new Date('2026-10-16T01:16:35.500').getTime(), 20, [durable(2100)]),
    reading(receivedAt + 300, 20, []),
  ];
  const contended = transferContended(promotedAt, receivedAt, readings, admissions, isTransfer);
  assert.deepEqual(contended, { held: true, why: null });
  const result = { outcome: 'pass', text: '"c (2)" by node7 (curator) in main/reports at node9 (edgeB): in Verified Memory 7 s after the promotion' };
  assert.deepEqual(busyReceiptOutcome(result, { received: receivedAt, life, held: contended, delivery: true }),
    { outcome: 'pass', text: `${result.text}, after contending with the transfer for the general slot` });
  // At the receipt itself the slot was not the transfer's: the strict rule would not have counted it.
  assert.equal(transferHeldThrough(moment(receivedAt), readings, admissions, isTransfer).held, false);
  // No reading in the window shows the transfer: not exercised.
  const idle = transferContended(promotedAt, promotedAt + 2000, readings, admissions, isTransfer);
  assert.deepEqual(idle, { held: false, why: 'none of the 1 reading(s) between them shows the transfer in the slot' });
  assert.match(busyReceiptOutcome(result, { received: promotedAt + 2000, life, held: idle, delivery: true }).text,
    /; not exercised: the transfer never held the general slot between the promotion and the delivery \(none of the 1 reading\(s\) between them shows the transfer in the slot\)$/);
  assert.deepEqual(transferContended(promotedAt, promotedAt + 100, readings, admissions, isTransfer), { held: false, why: 'no reading was taken between them' });
  // After the transfer's life, even with contention before.
  assert.match(busyReceiptOutcome(result, { received: life.to + 5, life, held: contended, delivery: true }).text, /had ended by then$/);
});

test('successive transfer admissions around a receipt: the reading must date the running one before the receipt', () => {
  // Two admissions of the transfer in the log seconds 0 and 1 (relative), a receipt at 1.1 s.
  const base = new Date('2026-10-16T01:20:00').getTime();
  const log = [
    '2026-10-16 01:20:00 sync aaaa [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)',
    '2026-10-16 01:20:01 sync bbbb [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:EJfXkbMM (global inflight=1/1, queued=0/0)',
  ].join('\n');
  const admissions = parseAdmissions(log);
  const receivedAt = base + 1100;
  // Sent at 2.0 s, answered at 2.2 s, age 1000 ms: the running admission started between 1.0 and 1.2 s,
  // which both log lines match, and the later one may have started after the receipt.
  const straddling = reading(base + 2000, 200, [durable(1000)]);
  assert.equal(slotHolder(straddling, admissions, isTransfer).candidates.length, 2);
  assert.deepEqual(transferHeldThrough(moment(receivedAt), [straddling], admissions, isTransfer), { held: false, why: 'the transfer\'s admission in the slot may have started after the report arrived (its arrival is dated to the 0 ms before a read found it)' });
  // A reading that dates the running admission wholly before the receipt proves it.
  const before = reading(base + 2000, 20, [durable(1600)]);
  assert.deepEqual(transferHeldThrough(moment(receivedAt), [before], admissions, isTransfer), { held: true, why: null });
});

test('a quiet admission the readings show at work keeps the transfer alive; a transfer that ended does not', () => {
  // One admission at 01:16:26, no later line of its work; readings show it in the slot until 01:16:40.
  const log = '2026-10-16 01:16:26 sync aaaa [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)';
  const admissions = parseAdmissions(log);
  const start = new Date('2026-10-16T01:16:26.300').getTime();
  const quiet = [10_000, 14_000].map(age => reading(start + age, 20, [durable(age)]));
  const byLog = transferLifetime(log, admissions, isTransfer);
  assert.equal(byLog.to, new Date('2026-10-16T01:16:26').getTime() + 999);
  const alive = transferLifetime(log, admissions, isTransfer, quiet);
  assert.equal(alive.to, start + 14_000);
  // Received a second before the last reading, as the suite reads the slot every second.
  const receivedAt = start + 13_000;
  const held = transferHeldThrough(moment(receivedAt), quiet, admissions, isTransfer);
  const result = { outcome: 'pass', text: 'r at node9 (edgeB): in shared memory 1 s after the share' };
  assert.equal(busyReceiptOutcome(result, { received: receivedAt, life: alive, held }).outcome, 'pass');
  // Judged by its log alone, the same receipt would have been called after the transfer.
  assert.match(busyReceiptOutcome(result, { received: receivedAt, life: byLog, held }).text, /had ended by then$/);
  // After the last reading of it the transfer is over: a later receipt is not exercised.
  assert.match(busyReceiptOutcome(result, { received: start + 20_000, life: alive, held }).text, /had ended by then$/);
});

test('a report\'s arrival is dated between the last read that missed it and the first that found it', () => {
  assert.equal(arrivalWindow(null), null);
  assert.equal(arrivalWindow({ view: { lastMissSentAt: 100, hit: null }, partitions: { lastMissSentAt: 100, hit: null } }), null);
  const view = { lastMissSentAt: 1000, hit: { sentAt: 1250, completedAt: 1300 } };
  assert.deepEqual(arrivalWindow({ view, partitions: { lastMissSentAt: 1100, hit: { sentAt: 1350, completedAt: 1400 } } }), { after: 1000, by: 1300 });
  // A read that lags still missed it after the other found it: the window keeps the earlier miss.
  assert.deepEqual(arrivalWindow({ view, partitions: { lastMissSentAt: 1350, hit: { sentAt: 1600, completedAt: 1650 } } }), { after: 1000, by: 1300 });
  // Found at a read's first try, with no miss before: the window has no opening.
  assert.deepEqual(arrivalWindow({ view, partitions: { lastMissSentAt: null, hit: { sentAt: 1250, completedAt: 1290 } } }), { after: null, by: 1290 });
  assert.match(transferHeldThrough({ after: null, by: 1290 }, [], [], isTransfer).why, /could not be dated/);
  assert.match(transferHeldThrough(null, [], [], isTransfer).why, /never dated/);
});

// The local log stamp of a moment, as the daemon writes it (`YYYY-MM-DD HH:MM:SS`).
const pad = n => String(n).padStart(2, '0');

const logStamp = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

test('a report read only once an admission had started is not evidence of the busy slot: its arrival is dated by the reads around it', async () => {
  // The report is in edgeB's shared memory from 300 ms on. Each query is answered as of 20 ms after it was
  // sent and comes back 180 ms after it was sent, so the first read that finds it completes well after 300 ms.
  const cg = '0xabc/one-graph-main-1';
  let t0 = 0;
  const arrival = () => t0 + 300;
  const devnet = {
    api: async (_node, _method, _path, body) => {
      const seenAt = Date.now() + 20;
      await new Promise(resolve => setTimeout(resolve, 180));
      const present = seenAt >= arrival();
      const rows = present ? [
        { p: RDF_TYPE, o: 'urn:one-graph:Report' }, { p: LABEL, o: '"r (1)"' }, { p: BODY, o: '"report 1 of run S: payload"' },
      ].map(row => ({ ...(body.includeContextGraphPartitions ? { g: `${sharedMemoryScope(cg, 'reports')}/0xaa/1` } : {}), ...row })) : [];
      return { status: 200, json: null, text: JSON.stringify({ result: { type: 'bindings', bindings: rows } }) };
    },
  };
  const io = createReports(devnet, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs: 2000, definitionMs: 1000, syncedMs: 1000, pollMs: 30 });
  const report = {
    author, graph: { key: 'main', id: cg, resolved: cg }, sub: 'reports', subject: 'urn:one-graph:S:1', value: 'r (1)', doneAt: null, error: null,
    triples: [
      { name: 'class', predicate: RDF_TYPE, iri: 'urn:one-graph:Report' }, { name: 'value', predicate: LABEL, text: 'r (1)' },
      { name: 'body', predicate: BODY, text: 'report 1 of run S: payload' },
    ],
  };
  // The share ended at once; the watch of edgeB reads every 50 ms, its first miss at that moment.
  t0 = Date.now();
  report.doneAt = t0;
  const handle = io.watch(io.pairs(6, report, [node], 'swm', { everyMs: 50, notBefore: t0, bound: 3000 }));
  await handle.done;
  assert.equal(pairOutcome(handle.pairs[0], { boundMs: 3000 }).outcome, 'pass');
  const window = arrivalWindow(handle.pairs[0].dating);
  assert.ok(window.after < arrival() && arrival() <= window.by, JSON.stringify({ window, arrival: arrival() }));
  assert.ok(window.by >= arrival() + 160, 'the read that found it completed long after the arrival');
  // The transfer's admission started at 350 ms, after the report arrived and before the read completed;
  // a reading right after the read shows it running.
  const startedAt = t0 + 350;
  const admissions = parseAdmissions(`${logStamp(startedAt)} sync aaaa [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)`);
  const after = reading(window.by + 100, 20, [durable(window.by + 100 - startedAt)]);
  assert.equal(slotHolder(after, admissions, isTransfer).state, 'transfer');
  // Dated by the read's completion alone, the receipt would have counted; dated by the reads around it, it does not.
  assert.deepEqual(transferHeldThrough(moment(window.by), [after], admissions, isTransfer), { held: true, why: null });
  const evidence = transferHeldThrough(window, [after], admissions, isTransfer);
  assert.equal(evidence.held, false);
  assert.match(evidence.why, /may have started after the report arrived/);
  // An admission that was running before the reads could have missed the report holds the slot throughout.
  const earlier = t0 - 500;
  const longAdmission = parseAdmissions(`${logStamp(earlier)} sync bbbb [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:EJfXkbMM (global inflight=1/1, queued=0/0)`);
  assert.deepEqual(transferHeldThrough(window, [reading(window.by + 100, 20, [durable(window.by + 100 - earlier)])], longAdmission, isTransfer), { held: true, why: null });
});

test('a promotion\'s delivery contended with the transfer only on readings answered before the last read that missed it', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const promotedAt = new Date('2026-10-16T01:16:30.000').getTime();
  const busy = reading(new Date('2026-10-16T01:16:35.500').getTime(), 20, [durable(2100)]);
  // The last read that missed the delivery was sent at 35.0 s: the reading at 35.5 s may show the slot after it.
  assert.deepEqual(transferContended(promotedAt, new Date('2026-10-16T01:16:35.000').getTime(), [busy], admissions, isTransfer), { held: false, why: 'no reading was taken between them' });
  assert.deepEqual(transferContended(promotedAt, new Date('2026-10-16T01:16:36.000').getTime(), [busy], admissions, isTransfer), { held: true, why: null });
  // A reading sent before the promotion does not count either; a delivery never dated has no evidence.
  assert.deepEqual(transferContended(busy.sentAt + 1, busy.at + 1000, [busy], admissions, isTransfer), { held: false, why: 'no reading was taken between them' });
  assert.match(transferContended(promotedAt, null, [busy], admissions, isTransfer).why, /could not be dated/);
});

test('a promotion the busy Edge finalized locally while a transfer admission held its slot passes, though it never waited for the slot', () => {
  const admissions = parseAdmissions(TRANSFER_LOG);
  const life = transferLifetime(TRANSFER_LOG, admissions, isTransfer);
  // The second admission (01:16:33) holds the slot; the report reached Verified Memory on edgeB between 34.0 and 34.4,
  // before the curator's answer came at 34.9, so no reading lies between the answer and the last miss.
  const window = { after: new Date('2026-10-16T01:16:34.000').getTime(), by: new Date('2026-10-16T01:16:34.400').getTime() };
  const answeredAt = new Date('2026-10-16T01:16:34.900').getTime();
  const readings = [reading(window.by + 300, 20, [durable(1600)])];
  const contended = transferContended(answeredAt, window.after, readings, admissions, isTransfer);
  assert.equal(contended.held, false);
  const through = transferHeldThrough(window, readings, admissions, isTransfer);
  assert.deepEqual(through, { held: true, why: null });
  const evidence = deliveryEvidence(contended, through);
  assert.deepEqual(evidence, { held: true, why: null, how: 'through' });
  const result = { outcome: 'pass', text: '"c (2)" by node7 (curator) in main/reports at node9 (edgeB): in Verified Memory 0 s after the promotion' };
  assert.deepEqual(busyReceiptOutcome(result, { received: window.by, life, held: evidence, delivery: true }),
    { outcome: 'pass', text: `${result.text}, while an admission of the transfer held the general slot` });
  // Contention alone, as before.
  assert.equal(deliveryEvidence({ held: true, why: null }, { held: false, why: 'x' }).how, 'contended');
  // Neither: not exercised, with both reasons.
  const neither = deliveryEvidence(contended, { held: false, why: 'the slot held other work or none' });
  assert.match(busyReceiptOutcome(result, { received: window.by, life, held: neither, delivery: true }).text,
    /; not exercised: the transfer never held the general slot between the promotion and the delivery \(no reading was taken between them; nor throughout its arrival: the slot held other work or none\)$/);
});

// A devnet for the busy case, from one script of when things happen: edgeB's sync slots (the transfer's
// admissions, each from `from` to `until`, the slot free between them) and its log, the client routes of a report, and
// each node's reads of the reports. A report edgeA creates reaches edgeB `reportDelayMs` after its
// create and the curator at once; an earlier report is in every node's shared memory until it is
// promoted, and in Verified Memory from then on.
function busyDevnet({ dir, cg, large, edgeB, transfer, reportDelayMs }) {
  const created = new Map();
  const earlier = new Map();
  const promotedAt = new Map();
  const ok = json => ({ status: 200, json, text: JSON.stringify(json) });
  const api = async (node, method, path, body) => {
    const now = Date.now();
    if (path === '/api/diagnostics/backpressure') {
      const running = transfer.find(admission => now >= admission.from && now < admission.until);
      const activeOperations = running ? [{ operation: 'durable:catchup-foreground', oldestAgeMs: now - running.from }] : [];
      return ok({ schedulers: [{ scheduler: 'sync-global', lanes: [{ lane: 'durable', activeOperations }] }] });
    }
    if (method === 'POST' && path === '/api/knowledge-assets') {
      created.set(body.quads[0].subject, { quads: body.quads, at: now });
      return ok({});
    }
    if (path.endsWith('/swm/share-async')) return ok({ jobId: 'j' });
    if (path.startsWith('/api/knowledge-assets/swm/share-jobs/')) return ok({ state: 'succeeded' });
    if (path !== '/api/query') return { status: 404, json: null, text: 'not used' };
    const subject = /<([^>]+)>/.exec(body.sparql)[1];
    let swm = false;
    let vm = false;
    let quads;
    if (created.has(subject)) {
      ({ quads } = created.get(subject));
      swm = node === edgeB ? now >= created.get(subject).at + reportDelayMs : true;
    } else if (earlier.has(subject)) {
      quads = earlier.get(subject);
      const at = promotedAt.get(subject);
      vm = at !== undefined && now >= at;
      swm = !vm;
    } else quads = [];
    const rows = (inLayer, graph) => (inLayer ? quads.map(quad => ({ ...(graph ? { g: graph } : {}), p: quad.predicate, o: quad.object })) : []);
    const bindings = body.view === 'shared-working-memory' ? rows(swm)
      : body.view === 'verifiable-memory' ? rows(vm)
        : [...rows(swm, `${sharedMemoryScope(cg, 'reports')}/0xaa/1`), ...rows(vm, `did:dkg:context-graph:${cg}/reports/_verifiable_memory/1`)];
    return ok({ result: { type: 'bindings', bindings } });
  };
  // The log holds the line of each admission that has started by the time it is read.
  const admissions = () => transfer.filter(admission => admission.from <= Date.now())
    .map((admission, i) => `${logStamp(admission.from)} sync op${i} [DKGAgent] Sync backpressure running durable:${large.id}:Peer${i} (global inflight=1/1, queued=0/0)`).join('\n');
  return {
    devnet: { dir, api, logSize: () => 0, logSince: node => (node === edgeB ? admissions() : '') },
    // An earlier report of edgeA's, in every node's shared memory.
    earlier: (n, author) => {
      const subject = `urn:one-graph:E:${n}`;
      const triples = [
        { name: 'class', predicate: RDF_TYPE, iri: 'urn:one-graph:Report' }, { name: 'value', predicate: LABEL, text: `earlier (${n})` },
        { name: 'body', predicate: BODY, text: `earlier body ${n}` },
      ];
      earlier.set(subject, triples.map(triple => ({ subject, predicate: triple.predicate, object: 'iri' in triple ? triple.iri : `"${triple.text}"` })));
      return { author, graph: null, sub: 'reports', name: `og-e-${n}`, subject, value: `earlier (${n})`, sequence: n, doneAt: Date.now() - 60_000, error: null, triples };
    },
    // The curator's publish of an earlier report reaches Verified Memory on every node at `at`.
    promoteAt: (record, at) => promotedAt.set(record.subject, at),
  };
}

function busyCase({ transfer, reportDelayMs, promotions = [], boundMs = 1500, transferGapMs = 10_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'one-graph-busy-'));
  const cg = '0xabc/one-graph-main-1';
  const main = { key: 'main', id: cg, resolved: cg, sub: 'reports' };
  const large = { key: 'large', id: '0xabc/one-graph-large-1' };
  const curator = { number: 7, role: 'curator', label: 'node7 (curator)' };
  const edgeA = { number: 8, role: 'edgeA', label: 'node8 (edgeA)', agentAddress: author.agentAddress };
  const edgeB = { number: 9, role: 'edgeB', label: 'node9 (edgeB)' };
  const scripted = busyDevnet({ dir, cg, large, edgeB, transfer, reportDelayMs });
  const lines = [];
  const report = createReport({ 6: 'a large Verified Memory transfer holds an Edge\'s only sync slot' }, { print: line => lines.push(line) });
  const io = createReports(scripted.devnet, { stamp: 'S', sub: 'reports', predicate: LABEL, type: 'urn:one-graph:Report', boundMs, definitionMs: 1000, syncedMs: 1000, pollMs: 100 });
  const records = promotions.map(({ n }) => ({ ...scripted.earlier(n, edgeA), graph: main }));
  const promoted = [];
  const ctx = {
    devnet: scripted.devnet, edges: { curator, edgeA, edgeB }, graphs: { subscribe: async () => Date.now() }, io, report, caseId: 6, boundMs, transferGapMs, stamp: 'S',
    ensureDefinition: async () => { throw new Error('the transfer was seen: no definition remedy expected'); },
    // The curator's promotion: refused, or edgeB finalizes it locally `deliveredAfterMs` after the request, before the answer comes.
    promote: async (_caseId, record) => {
      const plan = promotions[records.indexOf(record)];
      promoted.push(record.value);
      if (plan.refused) return null;
      scripted.promoteAt(record, Date.now() + plan.deliveredAfterMs);
      await new Promise(resolve => setTimeout(resolve, plan.answerAfterMs));
      return Date.now();
    },
  };
  return { run: () => busyEdge(ctx, main, large, records), lines, report, records, promoted, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the busy case passes a report and a promotion that reached edgeB while the transfer held its slot, and leaves a refused promotion out', { timeout: 20_000 }, async () => {
  const now = Date.now();
  const scenario = busyCase({
    transfer: [{ from: now - 300, until: now + 30_000 }], reportDelayMs: 300,
    promotions: [{ n: 1, deliveredAfterMs: 150, answerAfterMs: 400 }, { n: 2, refused: true }],
  });
  try {
    const { shared, promoted } = await scenario.run();
    assert.deepEqual(promoted.map(record => record.value), ['earlier (1)']);
    assert.deepEqual(shared.map(record => record.value), ['edgeA while edgeB is busy 1 (1)']);
    const passed = scenario.lines.filter(line => line.startsWith('  [PASS] case 6: '));
    // edgeB's receipt of the report, dated by its reads, under the transfer's admission.
    assert.ok(passed.some(line => /"edgeA while edgeB is busy 1 \(1\)" by node8 \(edgeA\) in main\/reports at node9 \(edgeB\): in shared memory \d+ s after the share, while an admission of the transfer held the general slot$/.test(line)), scenario.lines.join('\n'));
    // The promotion edgeB finalized before the curator's answer: dated by the watch armed at that answer.
    assert.ok(passed.some(line => line.endsWith('"earlier (1)" by node8 (edgeA) in main/reports at node9 (edgeB): in Verified Memory 0 s after the promotion, while an admission of the transfer held the general slot')), scenario.lines.join('\n'));
    assert.ok(passed.some(line => /"earlier \(1\)" .* at node9 \(edgeB\): left shared memory 0 s after the promotion, and out of it to the end of the 2 s, while an admission of the transfer held the general slot$/.test(line)), scenario.lines.join('\n'));
    // The other Edges' pairs are ordinary delivery checks.
    assert.ok(passed.some(line => /"earlier \(1\)" .* at node7 \(curator\): in Verified Memory 0 s after the promotion$/.test(line)), scenario.lines.join('\n'));
    // The refused promotion's watch was cancelled: no pair of it is reported.
    assert.deepEqual(scenario.promoted, ['earlier (1)', 'earlier (2)']);
    assert.ok(!scenario.lines.some(line => line.includes('earlier (2)')), scenario.lines.join('\n'));
    assert.ok(!scenario.lines.some(line => line.startsWith('  [FAIL]')), scenario.lines.join('\n'));
    assert.deepEqual(scenario.report.summary('Results'), []);
  } finally {
    scenario.cleanup();
  }
});

test('the busy case fails as not exercised when the report reached edgeB only after the transfer had ended', { timeout: 20_000 }, async () => {
  const now = Date.now();
  // Delivered within its bound of 4 s, 2.5 s after the share; the transfer ended at 1.2 s, and no
  // admission of it comes within the 2 s allowed for a gap.
  const scenario = busyCase({ transfer: [{ from: now - 300, until: now + 1200 }], reportDelayMs: 2500, boundMs: 4000, transferGapMs: 2000 });
  try {
    await scenario.run();
    const failed = scenario.lines.filter(line => line.startsWith('  [FAIL] case 6: '));
    assert.equal(failed.length, 1, scenario.lines.join('\n'));
    assert.match(failed[0], /"edgeA while edgeB is busy 1 \(1\)" .* at node9 \(edgeB\): in shared memory \d+ s after the share; not exercised: the transfer of the large graph had ended by then$/);
    assert.deepEqual(scenario.report.summary('Results'), ['6']);
  } finally {
    scenario.cleanup();
  }
});

test('a receipt in a gap between the transfer\'s admissions does not end the attempts: a later one inside the next admission passes', { timeout: 30_000 }, async () => {
  const now = Date.now();
  // The first admission ends at 0.9 s, the next starts at 3.5 s; each report reaches edgeB 1.5 s after its create.
  const scenario = busyCase({ transfer: [{ from: now - 300, until: now + 900 }, { from: now + 3500, until: now + 60_000 }], reportDelayMs: 1500, boundMs: 3000 });
  try {
    const { shared } = await scenario.run();
    assert.deepEqual(shared.map(record => record.value), ['edgeA while edgeB is busy 1 (1)', 'edgeA while edgeB is busy 2 (2)']);
    // The first receipt, in the gap, is only noted; the second counts.
    assert.ok(scenario.lines.some(line => /\[NOTE\] case 6: an earlier share: "edgeA while edgeB is busy 1 \(1\)" .* at node9 \(edgeB\): in shared memory \d+ s after the share; not exercised: /.test(line)), scenario.lines.join('\n'));
    assert.ok(scenario.lines.some(line => /\[PASS\] case 6: "edgeA while edgeB is busy 2 \(2\)" .* at node9 \(edgeB\): in shared memory \d+ s after the share, while an admission of the transfer held the general slot$/.test(line)), scenario.lines.join('\n'));
    assert.deepEqual(scenario.report.summary('Results'), []);
  } finally {
    scenario.cleanup();
  }
});

test('a promotion\'s delivery that waited for the slot and landed before the curator\'s answer counts as contended', () => {
  const base = new Date('2026-10-16T01:30:00').getTime();
  const log = [
    '2026-10-16 01:29:58 sync tttt [DKGAgent] Sync backpressure running durable:0xabc/one-graph-large-1:QP4sWZbL (global inflight=1/1, queued=0/0)',
    '2026-10-16 01:29:50 sync old0 [DKGAgent] Sync backpressure running durable:0xabc/one-graph-main-1:U5shPKAE (global inflight=1/1, queued=0/0)',
    '2026-10-16 01:30:00 sync rej1 [DKGAgent] Sync backpressure rejected durable:0xabc/one-graph-main-1:U5shPKAE (global inflight=1/1, queued=0/0)',
    '2026-10-16 01:30:02 sync run1 [DKGAgent] Sync backpressure running durable:0xabc/one-graph-main-1:U5shPKAE (global inflight=1/1, queued=0/0)',
  ].join('\n');
  const attempts = durableSyncAttempts(log, '0xabc/one-graph-main-1');
  assert.deepEqual(attempts.map(attempt => [attempt.at - base, attempt.outcome]), [[-10_000, 'running'], [0, 'rejected'], [2000, 'running']]);
  // Requested at -0.2 s: the window starts at edgeB's first try after it (the end of its log second), before the answer at 3 s.
  const requestedAt = base - 200;
  const answeredAt = base + 3000;
  assert.equal(contentionSince({ answeredAt, requestedAt, attempts }), base + 999);
  // No try after the request (only an older sync), or none at all: the answer, as before.
  assert.equal(contentionSince({ answeredAt, requestedAt, attempts: attempts.slice(0, 1) }), answeredAt);
  assert.equal(contentionSince({ answeredAt, requestedAt, attempts: [] }), answeredAt);
  assert.equal(contentionSince({ answeredAt, requestedAt: undefined, attempts }), answeredAt);
  // A first try after the answer leaves the answer as the start.
  assert.equal(contentionSince({ answeredAt: base - 100, requestedAt, attempts }), base - 100);
  // The transfer held the slot at 1 s; it had released it when the promotion landed at 2.3-2.5 s, before the answer at 3 s.
  const admissions = parseAdmissions(log);
  const busy = reading(base + 1000, 20, [durable(3000)]);
  const after = reading(base + 2600, 20, []);
  const window = { after: base + 2300, by: base + 2500 };
  const through = transferHeldThrough(window, [busy, after], admissions, isTransfer);
  assert.equal(through.held, false);
  // Judged from the answer, nothing lies between it and the last miss; from edgeB's first try, the reading at 1 s does.
  assert.equal(transferContended(answeredAt, window.after, [busy, after], admissions, isTransfer).held, false);
  const contended = transferContended(contentionSince({ answeredAt, requestedAt, attempts }), window.after, [busy, after], admissions, isTransfer);
  assert.deepEqual(contended, { held: true, why: null });
  const life = { from: base - 2000, to: base + 60_000 };
  const result = { outcome: 'pass', text: '"c (2)" by node7 (curator) in main/reports at node9 (edgeB): in Verified Memory 0 s after the promotion' };
  assert.deepEqual(busyReceiptOutcome(result, { received: window.by, life, held: deliveryEvidence(contended, through), delivery: true }),
    { outcome: 'pass', text: `${result.text}, after contending with the transfer for the general slot` });
});
