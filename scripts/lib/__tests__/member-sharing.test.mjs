import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admissionStarts, busySlotCovered, caseVerdicts, foldRead, foldSubscription, freshSubscription, inScope, judgeHeld,
  linkProblem, literalText, pairHeld, refusedWriteVerdict, registeredGapVerdict, sharedMemoryScope, singleSlotProblem,
  subscriptionVerdicts,
} from '../qa/member-sharing.mjs';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const LABEL = 'urn:issue3251:label';
const written = { predicate: LABEL, value: 'owner live root (7)' };

test('a literal cell is read in each form the query API answers, and nothing else passes for a text', () => {
  assert.equal(literalText('"owner live root (7)"'), 'owner live root (7)');
  assert.equal(literalText(`"owner live root (7)"^^<${XSD}string>`), 'owner live root (7)');
  assert.equal(literalText('"owner live root (7)"@en'), 'owner live root (7)');
  assert.equal(literalText('"owner live root (7)"@en-GB'), 'owner live root (7)');
  assert.equal(literalText({ type: 'literal', value: 'owner live root (7)' }), 'owner live root (7)');
  assert.equal(literalText({ type: 'literal', value: 'x', datatype: `${XSD}string` }), 'x');
  assert.equal(literalText('""'), '');
  for (const cell of [
    'urn:issue3251:label', '<urn:issue3251:label>', '"unterminated', '"', `"7"^^<${XSD}integer>`, '"x"junk',
    { type: 'uri', value: 'urn:x' }, { type: 'bnode', value: 'b0' }, { type: 'literal', value: '7', datatype: `${XSD}integer` },
    { type: 'literal' }, null, undefined, 7,
  ]) assert.equal(literalText(cell), null, JSON.stringify(cell));
});

test('a write is held when its predicate is there and every value held for it is the written one', () => {
  assert.deepEqual(judgeHeld([], written), { held: false });
  assert.deepEqual(judgeHeld([{ p: 'urn:other', o: '"owner live root (7)"' }], written), { held: false });
  assert.deepEqual(judgeHeld([{ p: LABEL, o: '"owner live root (7)"' }], written), { held: true });
  assert.deepEqual(judgeHeld([{ p: `<${LABEL}>`, o: { type: 'literal', value: 'owner live root (7)' } }], written), { held: true });
  // The same value held twice (two graphs below the same shared memory) is still the one value.
  assert.deepEqual(judgeHeld([{ p: LABEL, o: '"owner live root (7)"' }, { p: LABEL, o: `"owner live root (7)"^^<${XSD}string>` }], written), { held: true });
});

test('a written value beside another value is not the write', () => {
  const both = judgeHeld([{ p: LABEL, o: '"owner live root (7)"' }, { p: LABEL, o: '"owner live root (8)"' }], written);
  assert.equal(both.held, false);
  assert.equal(both.different, '"owner live root (8)"');
  const typed = judgeHeld([{ p: LABEL, o: `"7"^^<${XSD}integer>` }], written);
  assert.deepEqual(typed, { held: false, different: 'a value that is not a text' });
});

test('the cross-partition read counts only the shared memory that was asked for', () => {
  const cg = '0xabc/issue-3251-public-20261015T080000Z-1';
  const root = sharedMemoryScope(cg, null);
  const sub = sharedMemoryScope(cg, 's');
  assert.equal(root, `did:dkg:context-graph:${cg}/_shared_memory`);
  assert.equal(sub, `did:dkg:context-graph:${cg}/s/_shared_memory`);
  assert.ok(inScope(root, root));
  assert.ok(inScope(`<${root}>`, root));
  assert.ok(inScope({ type: 'uri', value: `${root}/0xauthor/1` }, root), 'a graph below the shared memory, one per asset');
  assert.ok(inScope(`${sub}/0xauthor/1`, sub));
  assert.ok(!inScope(sub, root), 'a sub-graph is not the root');
  assert.ok(!inScope(`${sub}/0xauthor/1`, root));
  assert.ok(!inScope(root, sub));
  assert.ok(!inScope(`did:dkg:context-graph:${cg}/_shared_memory_meta`, root), 'not the bookkeeping graph beside it');
  assert.ok(!inScope(`did:dkg:context-graph:${cg}`, root), 'not the data graph');
  assert.ok(!inScope(`did:dkg:context-graph:${cg}-other/_shared_memory`, root), 'not another graph with a longer id');
});

test('the topology holds only on relayed links between a member and the owner and on no link between the members', () => {
  assert.equal(linkProblem({ readable: true, total: 1, relayed: 1 }, 'relayed', 'node8', 'node7'), null);
  assert.equal(linkProblem({ readable: true, total: 2, relayed: 2 }, 'relayed', 'node8', 'node7'), null);
  assert.equal(linkProblem({ readable: true, total: 0, relayed: 0 }, 'relayed', 'node8', 'node7'), 'node8 holds no connection to node7');
  assert.equal(linkProblem({ readable: true, total: 2, relayed: 1 }, 'relayed', 'node8', 'node7'), 'node8 holds 1 direct connection(s) to node7');
  assert.equal(linkProblem({ readable: true, total: 0, relayed: 0 }, 'none', 'node8', 'node9'), null);
  assert.equal(linkProblem({ readable: true, total: 1, relayed: 1 }, 'none', 'node8', 'node9'), 'node8 holds 1 connection(s) to node9');
  // A list that could not be read says nothing, whichever answer was expected.
  for (const expect of ['relayed', 'none']) {
    assert.equal(linkProblem({ readable: false }, expect, 'node8', 'node9'), 'the connections of node8 could not be read');
    assert.equal(linkProblem(undefined, expect, 'node8', 'node9'), 'the connections of node8 could not be read');
  }
});

test('a case passes only when something held and nothing failed; a case that never ran does not pass', () => {
  const cases = { 1: 'one', 2: 'two', 3: 'three', 4: 'four' };
  const { rows, failed } = caseVerdicts(cases, {
    1: { pass: 4, fail: [] },
    2: { pass: 3, fail: ['member1 -> member2 missing'] },
    3: { pass: 0, fail: [] },
  });
  assert.deepEqual(rows.map(row => [row.id, row.verdict, row.held, row.failed]),
    [['1', 'PASS', 4, 0], ['2', 'FAIL', 3, 1], ['3', 'NOT RUN', 0, 0], ['4', 'NOT RUN', 0, 0]]);
  assert.deepEqual(failed, ['2', '3', '4']);
  assert.deepEqual(caseVerdicts({ 1: 'one' }, { 1: { pass: 1, fail: [] } }).failed, []);
});

test('an expected failure of a known gap does not fail its case; any other failure still does', () => {
  const cases = { 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' };
  const { rows, failed } = caseVerdicts(cases, {
    7: { pass: 13, fail: [], xfail: ['member1 holds no definition of registered'] },
    8: { pass: 0, fail: [], xfail: ['member2 lists registered as synced=false'] },
    9: { pass: 2, fail: ['member1 sub-graph write never reached member2'], xfail: ['member2 holds no definition'] },
    10: { pass: 1, fail: [], xfail: [], xpass: ['member1 lists registered as synced'] },
  });
  assert.deepEqual(rows.map(row => [row.id, row.verdict, row.held, row.failed, row.expected, row.unexpected]),
    [['7', 'PASS', 13, 0, 1, 0], ['8', 'PASS', 0, 0, 1, 0], ['9', 'FAIL', 2, 1, 1, 0], ['10', 'PASS', 1, 0, 0, 1]]);
  assert.deepEqual(failed, ['9']);
  // Findings without the newer lists still read as before.
  assert.deepEqual(caseVerdicts({ 1: 'one' }, { 1: { pass: 0, fail: [] } }).rows[0].verdict, 'NOT RUN');
});

test('each read keeps its own completion time, so a slow later read cannot discard a timely one', () => {
  const bound = { from: 0, boundMs: 60_000 };
  let progress = { view: null, partitions: null };
  // The partitions read finds the write at 30 s; the view read is still empty.
  progress = foldRead(progress, 'partitions', { held: true, completedAt: 30_000 }, bound);
  progress = foldRead(progress, 'view', { held: false, completedAt: 30_500 }, bound);
  assert.deepEqual(progress, { view: null, partitions: 30_000 });
  // Next poll: the view finds it at 33 s. A partitions request that only ends at
  // 63 s (or fails) changes nothing: that read is satisfied already.
  progress = foldRead(progress, 'view', { held: true, completedAt: 33_000 }, bound);
  progress = foldRead(progress, 'partitions', { held: false, completedAt: 63_000 }, bound);
  assert.deepEqual(progress, { view: 33_000, partitions: 30_000 });
  assert.equal(pairHeld(progress), true);
  // A read that completes after the bound does not count, even when it finds the write.
  const late = foldRead({ view: null, partitions: 30_000 }, 'view', { held: true, completedAt: 61_000 }, bound);
  assert.equal(pairHeld(late), false);
  assert.equal(foldRead({ view: null, partitions: null }, 'view', { held: true, completedAt: 61_000 }, { from: 2_000, boundMs: 60_000 }).view, 59_000);
});

test('a missed check on a registered graph is the known gap only when the member is shown to lack the definition', () => {
  assert.equal(registeredGapVerdict({ registered: true, definitionHeld: false }), 'xfail');
  // A member that holds the definition and still never syncs, or cannot write, has another defect.
  assert.equal(registeredGapVerdict({ registered: true, definitionHeld: true }), 'fail');
  // No evidence either way (the listing could not be read) is no exemption.
  assert.equal(registeredGapVerdict({ registered: true, definitionHeld: undefined }), 'fail');
  // Not a registered graph: the gap does not apply.
  assert.equal(registeredGapVerdict({ registered: false, definitionHeld: false }), 'fail');
});

test('admission starts are read from the node log, for that label only', () => {
  const big = 'shared-memory:0xabc/issue-3251-large-1:YeJDmN71';
  const log = [
    '2026-10-15 09:49:10 sync 85005448 [DKGAgent] Sync backpressure running shared-memory:0xabc/issue-3251-public-1:YeJDmN71 (global inflight=1/1, queued=0/0)',
    `2026-10-15 09:49:12 sync 9a [DKGAgent] Sync backpressure running ${big} (global inflight=1/1, queued=0/0)`,
    `2026-10-15 09:49:13 sync 9b [DKGAgent] Sync backpressure rejected ${big} (global inflight=1/1, queued=0/0)`,
    `[2026-10-15T07:49:14.000Z] not the agent log format: Sync backpressure running ${big}`,
    `2026-10-15 09:50:02 sync 9c [DKGAgent] Sync backpressure running ${big} (global inflight=1/1, queued=0/0)`,
  ].join('\n');
  assert.deepEqual(admissionStarts(log, big), [new Date('2026-10-15T09:49:12').getTime(), new Date('2026-10-15T09:50:02').getTime()]);
  // Any operation on the graph: the label holds the graph id between colons.
  assert.deepEqual(admissionStarts(log, ':0xabc/issue-3251-large-1:'), admissionStarts(log, big));
  assert.deepEqual(admissionStarts(log, ':0xabc/issue-3251-large-2:'), []);
  // The needle must be in the admitted label, not elsewhere on the line.
  assert.deepEqual(admissionStarts('2026-10-15 09:49:12 sync 9a [DKGAgent] Sync backpressure running shared-memory:other:Y (note :0xabc/issue-3251-large-1:)', ':0xabc/issue-3251-large-1:'), []);
  assert.deepEqual(admissionStarts('', big), []);
  assert.deepEqual(admissionStarts(undefined, big), []);
});

// A reading of member 2's sync slots with its intended policy: one slot, no queue.
const POLICY = { capacityModel: 'shared', inflightLimit: 1, queueLimit: 0 };
const every = (a, b) => Array.from({ length: (b - a) / 1000 + 1 }, (_, i) => a + i * 1000);

test('a running catch-up job without an admitted transfer does not make member 2 busy', () => {
  const window = { from: 100_000, until: 140_000 };
  // The regression: the job is running, the slot sampler sees work in flight,
  // but no transfer of the large graph was ever admitted.
  const samples = every(100_000, 140_000).map(at => ({ at, ...POLICY, inflight: 1, oldestActiveAgeMs: at - 95_000 }));
  assert.deepEqual(busySlotCovered({ admissionStartMs: null, samples, ...window }),
    { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null });
  assert.equal(busySlotCovered({ admissionStartMs: undefined, samples, ...window }).held, false);
});

test('the slot is busy only while the admitted transfer is the work that holds it, through the whole window', () => {
  const start = 95_000;
  const window = { from: 100_000, until: 140_000 };
  const holding = at => ({ at, ...POLICY, inflight: 1, oldestActiveAgeMs: at - start });
  const held = busySlotCovered({ admissionStartMs: start, samples: every(99_000, 141_000).map(holding), ...window });
  assert.deepEqual(held, { held: true, provenUntil: 140_000 });
  // A second admission beside it (the reserved shared-memory slot of a fix) is younger: still the same holder.
  assert.equal(busySlotCovered({ admissionStartMs: start, samples: every(100_000, 140_000).map(at => ({ ...holding(at), inflight: 2 })), ...window }).held, true);
  // The transfer ends at 120 s: from then on the slot is free.
  const freed = every(100_000, 140_000).map(at => (at < 120_000 ? holding(at) : { at, ...POLICY, inflight: 0, oldestActiveAgeMs: 0 }));
  assert.deepEqual(busySlotCovered({ admissionStartMs: start, samples: freed, ...window }), { held: false, reason: 'the sync slot was free', provenUntil: 119_000 });
  // Other work holds the slot (its admission started at 118 s).
  const other = every(100_000, 140_000).map(at => (at < 120_000 ? holding(at) : { ...holding(at), oldestActiveAgeMs: at - 118_000 }));
  assert.deepEqual(busySlotCovered({ admissionStartMs: start, samples: other, ...window }), { held: false, reason: 'the slot was held by other work', provenUntil: 119_000 });
  // A log second is truncated: the sampled start may lie up to the tolerance from it.
  assert.equal(busySlotCovered({ admissionStartMs: start, samples: every(100_000, 140_000).map(at => ({ ...holding(at), oldestActiveAgeMs: at - start - 900 })), ...window }).held, true);
  // No reading for 12 s, an unreadable reading, no reading at the end, and no reading at all prove nothing.
  const gap = every(100_000, 140_000).filter(at => at < 110_000 || at > 120_000).map(holding);
  assert.equal(busySlotCovered({ admissionStartMs: start, samples: gap, ...window }).reason, 'no reading of the sync slot for 12 s');
  const unreadable = every(100_000, 140_000).map(at => (at === 125_000 ? { at, unreadable: 'HTTP 503' } : holding(at)));
  assert.equal(busySlotCovered({ admissionStartMs: start, samples: unreadable, ...window }).reason, 'the sync slot could not be read (HTTP 503)');
  const short = every(100_000, 130_000).map(holding);
  assert.deepEqual(busySlotCovered({ admissionStartMs: start, samples: short, ...window }), { held: false, reason: 'no reading of the sync slot for the last 10 s', provenUntil: 130_000 });
  assert.deepEqual(busySlotCovered({ admissionStartMs: start, samples: [], ...window }), { held: false, reason: 'no reading of the sync slot in the window', provenUntil: null });
});

test('a reading taken before the window is no evidence, not even a free slot before the admission', () => {
  // The finding: a free reading at 99 s, busy readings from 100 s to 110 s, writes and receipts in [101 s, 110 s].
  const start = 100_000;
  const busy = at => ({ at, ...POLICY, inflight: 1, oldestActiveAgeMs: at - start });
  const samples = [{ at: 99_000, ...POLICY, inflight: 0, oldestActiveAgeMs: 0 }, ...every(100_000, 110_000).map(busy)];
  assert.deepEqual(busySlotCovered({ admissionStartMs: start, samples, from: 101_000, until: 110_000 }), { held: true, provenUntil: 110_000 });
  // The second example: admission at 98.5 s, a free reading at 98 s, busy readings from 99 s to 110 s, window [100 s, 110 s].
  const later = [{ at: 98_000, ...POLICY, inflight: 0, oldestActiveAgeMs: 0 }, ...every(99_000, 110_000).map(at => ({ ...busy(at), oldestActiveAgeMs: at - 98_500 }))];
  assert.equal(busySlotCovered({ admissionStartMs: 98_500, samples: later, from: 100_000, until: 110_000 }).held, true);
  // Inside the window a free reading still fails it.
  const inside = every(100_000, 110_000).map(at => (at === 105_000 ? { at, ...POLICY, inflight: 0, oldestActiveAgeMs: 0 } : busy(at)));
  assert.equal(busySlotCovered({ admissionStartMs: start, samples: inside, from: 101_000, until: 110_000 }).reason, 'the sync slot was free');
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
  assert.deepEqual(busySlotCovered({ admissionStartMs: start, samples: spare, from: 100_000, until: 110_000 }),
    { held: false, reason: 'the node runs 8 sync slot(s), not one', provenUntil: null });
  const queued = every(100_000, 110_000).map(at => ({ at, ...POLICY, queueLimit: 20, inflight: 1, oldestActiveAgeMs: at - start }));
  assert.equal(busySlotCovered({ admissionStartMs: start, samples: queued, from: 100_000, until: 110_000 }).reason, 'the node has a sync queue of 20, not none');
});

test('a refused write is judged by its structured code, not by the wording of its message', () => {
  const gap = { registered: true, definitionHeld: false };
  assert.equal(refusedWriteVerdict({ errorCode: 'CONTEXT_GRAPH_NOT_FOUND', ...gap }), 'xfail');
  // Another code fails, whatever its message says.
  assert.equal(refusedWriteVerdict({ errorCode: 'WRITE_FORBIDDEN', ...gap }), 'fail');
  assert.equal(refusedWriteVerdict({ errorCode: undefined, ...gap }), 'fail');
  // The gap's code still needs the evidence and the registered graph.
  assert.equal(refusedWriteVerdict({ errorCode: 'CONTEXT_GRAPH_NOT_FOUND', registered: true, definitionHeld: true }), 'fail');
  assert.equal(refusedWriteVerdict({ errorCode: 'CONTEXT_GRAPH_NOT_FOUND', registered: false, definitionHeld: false }), 'fail');
});

test('one poller observes the definition and the synced flag against their own deadlines', () => {
  const deadlines = { definitionMs: 90_000, syncedMs: 60_000 };
  const listing = (defined, synced) => ({ readable: true, defined, entry: { id: 'g', subscribed: true, synced, ...(defined ? { accessPolicy: 'public' } : {}) } });
  const fold = (steps) => steps.reduce((o, [age, listed]) => foldSubscription(o, listed, age, deadlines), freshSubscription());
  // Synced at 20 s, the definition at 75 s: both in time although the synced deadline came first.
  const both = fold([[2_000, listing(false, false)], [20_000, listing(false, true)], [62_000, listing(false, true)], [75_000, listing(true, true)]]);
  assert.equal(both.done, true);
  assert.deepEqual([both.syncedAt, both.definedAt], [20_000, 75_000]);
  assert.deepEqual(subscriptionVerdicts(both, { registered: false, ...deadlines }), {
    definition: { verdict: 'none', text: '' }, synced: { verdict: 'pass', text: 'lists it as synced 20 s after it subscribed' },
  });
  // Not done before the later deadline is settled.
  assert.equal(fold([[20_000, listing(false, true)], [62_000, listing(false, true)]]).done, false);
  // The registered graph, no definition and never synced: both are #3264, with the deadlines' listings as evidence.
  const gap = fold([[30_000, listing(false, false)], [60_000, listing(false, false)], [90_000, listing(false, false)]]);
  const gapVerdicts = subscriptionVerdicts(gap, { registered: true, ...deadlines });
  assert.equal(gapVerdicts.definition.verdict, 'xfail');
  assert.match(gapVerdicts.definition.text, /^holds no definition 90 s after it subscribed: its listing has no access policy/);
  assert.deepEqual(gapVerdicts.synced, { verdict: 'xfail', text: 'lists it as subscribed=true synced=false 60 s after it subscribed; it holds no definition of the graph' });
  // The definition held but the graph never synced: a failure, not #3264, and the definition shows as XPASS.
  const held = fold([[5_000, listing(true, false)], [60_000, listing(true, false)], [90_000, listing(true, false)]]);
  assert.deepEqual(subscriptionVerdicts(held, { registered: true, ...deadlines }), {
    definition: { verdict: 'xpass', text: 'holds the definition 5 s after it subscribed' },
    synced: { verdict: 'fail', text: 'lists it as subscribed=true synced=false 60 s after it subscribed; it holds the definition, so this is not #3264' },
  });
  // A success seen only at the deadline is late.
  const late = fold([[61_000, listing(false, true)], [91_000, listing(true, true)]]);
  const lateVerdicts = subscriptionVerdicts(late, { registered: false, ...deadlines });
  assert.deepEqual([lateVerdicts.synced.verdict, lateVerdicts.definition.verdict], ['fail', 'fail']);
  assert.equal(lateVerdicts.synced.text, 'lists it as synced only 61 s after it subscribed');
  assert.equal(lateVerdicts.definition.text, 'holds the definition only 91 s after it subscribed');
  // An unreadable listing at a deadline is a failure, also on the registered graph: no evidence, no exemption.
  const unreadable = { readable: false, why: 'HTTP 503' };
  const blind = fold([[60_000, unreadable], [90_000, unreadable]]);
  assert.deepEqual(subscriptionVerdicts(blind, { registered: true, ...deadlines }), {
    definition: { verdict: 'fail', text: 'its listing could not be read 90 s after it subscribed (HTTP 503)' },
    synced: { verdict: 'fail', text: 'its listing could not be read 60 s after it subscribed (HTTP 503)' },
  });
});
