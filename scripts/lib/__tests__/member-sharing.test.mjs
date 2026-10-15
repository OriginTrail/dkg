import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from '../qa/known-gaps.mjs';
import {
  caseVerdicts, connectionsObservation, describe, foldRead, foldSubscription, freshSubscription, inScope, judgeHeld,
  linkProblem, literalText, pairHeld, pairResult, sharedMemoryScope, subscriptionResults, topologyProblems,
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

// The verdicts of an observed subscription as the report prints them: each
// result through the known gaps, a quiet pass printing nothing. The graph is
// public unless the options say otherwise.
function subscriptionVerdicts(observation, options) {
  const results = subscriptionResults(observation, { private: false, ...options });
  const printed = result => {
    const { verdict, text } = classify(result);
    return verdict === 'quiet' ? { verdict: 'none', text: '' } : { verdict, text };
  };
  return { definition: printed(results.definition), synced: printed(results.synced) };
}

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

test('the topology is judged from one reading of each node, with the diagnostics of each link and stranger', () => {
  const owner = { number: 7, label: 'node7 (owner)', peerId: 'peer-owner' };
  const member1 = { number: 8, label: 'node8 (member1)', peerId: 'peer-member1' };
  const member2 = { number: 9, label: 'node9 (member2)', peerId: 'peer-member2' };
  const links = [[member1, owner, 'relayed'], [owner, member1, 'relayed'], [member2, owner, 'relayed'], [owner, member2, 'relayed'], [member1, member2, 'none'], [member2, member1, 'none']];
  const known = new Set(['peer-owner', 'peer-member1', 'peer-member2', 'peer-core1', 'peer-core2']);
  const relayed = peerId => ({ peerId, transport: 'relayed' });
  const direct = peerId => ({ peerId, transport: 'direct' });
  const answers = {
    7: [relayed('peer-member1'), relayed('peer-member2'), direct('peer-core1')],
    8: [relayed('peer-owner'), direct('peer-core1')],
    9: [relayed('peer-owner'), direct('peer-core2')],
  };
  const observe = overrides => new Map(Object.entries({ ...answers, ...overrides }).map(([number, connections]) => [Number(number),
    connections === null ? connectionsObservation(503, { error: 'busy' }) : connectionsObservation(200, { connections })]));
  const judge = overrides => topologyProblems({ observations: observe(overrides), links, members: [member1, member2], known });
  assert.deepEqual(judge({}), []);
  // A direct link to the owner, a link between the members, a stranger.
  assert.deepEqual(judge({ 8: [relayed('peer-owner'), direct('peer-owner'), relayed('peer-member2'), direct('peer-elsewhere1')] }), [
    'node8 (member1) holds 1 direct connection(s) to node7 (owner)',
    'node8 (member1) holds 1 connection(s) to node9 (member2)',
    'node8 (member1) is connected to 1 peer(s) that are no node of this devnet (sewhere1): they could carry the graph',
  ]);
  // A node whose connections could not be read fails each link from it, and says nothing about strangers.
  assert.deepEqual(judge({ 9: null }), [
    'the connections of node9 (member2) could not be read',
    'the connections of node9 (member2) could not be read',
  ]);
  assert.deepEqual(connectionsObservation(200, { connections: 'none' }), { readable: false });
  assert.deepEqual(connectionsObservation(200, null), { readable: false });
});

test('a pair is held, missing (with what each read last saw) or not written, as an ordinary result', () => {
  const graph = { key: 'registered', registered: true, private: false };
  const record = { author: { label: 'node8 (member1)' }, graph, sub: 's', value: 'member1 live sub-graph (9)' };
  const node = { label: 'node9 (member2)' };
  assert.equal(describe(record), '"member1 live sub-graph (9)" by node8 (member1) in registered/s');
  const held = pairResult({ record, node, progress: { view: 3_000, partitions: 4_400 }, last: {} }, { boundMs: 60_000 });
  assert.deepEqual(held, { check: 'held', outcome: 'pass', text: '"member1 live sub-graph (9)" by node8 (member1) in registered/s at node9 (member2): held 4 s after the share' });
  const missing = pairResult({
    record: { ...record, sub: null }, node, fromWhat: 'member subscribed',
    progress: { view: 2_000, partitions: null }, last: { view: { held: true }, partitions: { held: false, different: '"other"' } },
  }, { boundMs: 60_000 });
  assert.deepEqual(missing, {
    check: 'held', outcome: 'fail',
    text: '"member1 live sub-graph (9)" by node8 (member1) in registered root at node9 (member2): NOT in the cross-partition read (holds another value: "other") 60 s after the member subscribed (found in view after 2 s)',
  });
  const refused = pairResult({ record: { ...record, error: 'the author refused the asset: HTTP 404', errorCode: 'CONTEXT_GRAPH_NOT_FOUND', definitionHeld: false }, node }, { boundMs: 60_000 });
  assert.deepEqual(refused, {
    check: 'write-refused', outcome: 'fail',
    text: '"member1 live sub-graph (9)" by node8 (member1) in registered/s at node9 (member2): not written, the author refused the asset: HTTP 404',
    evidence: { registered: true, private: false, definitionHeld: false, errorCode: 'CONTEXT_GRAPH_NOT_FOUND' },
  });
});
