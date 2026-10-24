import assert from 'node:assert/strict';
import test from 'node:test';
import { createObservation } from '../member-sharing/observation.mjs';
import { createReport } from '../member-sharing/report.mjs';

const LABEL = 'urn:issue3251:label';
const answer = rows => {
  const body = { result: { bindings: rows } };
  return { status: 200, json: body, text: JSON.stringify(body) };
};
const until = async (condition, ms = 2000) => {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await new Promise(resolve => { setTimeout(resolve, 10); });
  return condition();
};

test('the two reads of a pair are made at once, and each keeps the time it completed', async () => {
  // Every query waits until the test answers it.
  const asked = [];
  const devnet = { api: (node, method, path, body) => new Promise(resolve => { asked.push({ kind: body.view ? 'view' : 'partitions', at: Date.now(), resolve }); }) };
  const io = createObservation(devnet, { boundMs: 60_000, definitionMs: 90_000, syncedMs: 90_000, stamp: 'S', predicate: LABEL });
  const record = { graph: { id: 'g', resolved: 'g' }, sub: null, subject: 'urn:issue3251:S:1', value: 'owner live root (1)', doneAt: Date.now(), error: null };
  const handle = io.watch([{ caseId: 1, record, node: { number: 8, label: 'node8 (member1)' } }]);
  const [pair] = handle.pairs;
  // Both reads are asked before either answers.
  assert.ok(await until(() => asked.length === 2), `asked: ${asked.map(read => read.kind).join(', ')}`);
  assert.deepEqual(asked.map(read => read.kind).sort(), ['partitions', 'view']);
  // The cross-partition read answers first; the view is still outstanding and does not hold it back.
  asked.find(read => read.kind === 'partitions').resolve(answer([{ g: 'did:dkg:context-graph:g/_shared_memory/0xauthor/1', p: LABEL, o: '"owner live root (1)"' }]));
  assert.ok(await until(() => pair.progress.partitions !== null));
  assert.equal(pair.progress.view, null);
  await new Promise(resolve => { setTimeout(resolve, 30); });
  asked.find(read => read.kind === 'view').resolve(answer([{ p: LABEL, o: '"owner live root (1)"' }]));
  await handle.done;
  assert.ok(pair.progress.view > pair.progress.partitions, JSON.stringify(pair.progress));
  // A read that found the write is not made again.
  assert.equal(asked.length, 2);
});

test('a slow read of one kind does not hold back the retries of the other (the example of the review)', async () => {
  // A 4 s bound. The view answers empty at first and holds the write from 100 ms on; the cross-partition read
  // takes 2.5 s to answer.
  const start = Date.now();
  const asked = [];
  const devnet = {
    async api(node, method, path, body) {
      const kind = body.view ? 'view' : 'partitions';
      asked.push(kind);
      if (kind === 'view') return answer(Date.now() - start >= 100 ? [{ p: LABEL, o: '"owner live root (1)"' }] : []);
      await new Promise(resolve => { setTimeout(resolve, 2500); });
      return answer([{ g: 'did:dkg:context-graph:g/_shared_memory/0xauthor/1', p: LABEL, o: '"owner live root (1)"' }]);
    },
  };
  const io = createObservation(devnet, { boundMs: 4_000, definitionMs: 90_000, syncedMs: 90_000, stamp: 'S', predicate: LABEL });
  const record = { graph: { id: 'g', resolved: 'g' }, sub: null, subject: 'urn:issue3251:S:1', value: 'owner live root (1)', doneAt: start, error: null };
  const handle = io.watch([{ caseId: 1, record, node: { number: 8, label: 'node8 (member1)' } }]);
  await handle.done;
  const { progress } = handle.pairs[0];
  // The view was asked again 2 s later, while the cross-partition read was still out; both hold within the bound.
  // Node runs timers on its loop clock, and the observation stamps reads with Date.now(): the 2.5 s timer can end
  // a millisecond or so early on that clock (seen in CI as 2499), so the slow read's lower bound allows for that.
  const TIMER_SLACK_MS = 50;
  assert.ok(progress.view !== null && progress.view < 2500, JSON.stringify(progress));
  assert.ok(progress.partitions !== null && progress.partitions >= 2500 - TIMER_SLACK_MS && progress.partitions < 4000,
    JSON.stringify(progress));
  assert.ok(progress.partitions > progress.view, JSON.stringify(progress));
  assert.deepEqual(asked, ['view', 'partitions', 'view']);
});

/**
 * A node API for writes: the asset is accepted or refused (a write to an
 * unknown graph) as `accepts(node, sub)` says, the share job succeeds at
 * once, and the listing never shows the graph's definition.
 */
const writesApi = accepts => async (node, method, path, body) => {
  const reply = (status, json) => ({ status, json, text: JSON.stringify(json) });
  if (path === '/api/knowledge-assets') {
    return accepts(node, body.subGraphName ?? null) ? reply(201, { created: body.name }) : reply(404, { error: 'Unknown contextGraphId', code: 'CONTEXT_GRAPH_NOT_FOUND' });
  }
  if (path.endsWith('/swm/share-async')) return reply(200, { jobId: 'job-1' });
  if (path.startsWith('/api/knowledge-assets/swm/share-jobs/')) return reply(200, { state: 'succeeded' });
  if (path === '/api/context-graph/list') return reply(200, { contextGraphs: [{ id: 'g', subscribed: true, synced: false }] });
  throw new Error(`unexpected ${method} ${path}`);
};

test('the observation layer keeps each member\'s history with the definition; a definition obtained and lost is not #3264', async () => {
  // Neither member is seen holding the definition while its subscription is observed. Member 1 then obtains it:
  // the node accepts its root write. It loses it again before its sub-graph write, which is refused as a write to
  // an unknown graph. Member 2 never obtains it: both of its writes are refused. Member 3's subscription was never
  // observed, and its write is refused.
  const owner = { number: 7, role: 'owner', label: 'node7 (owner)', member: false };
  const member1 = { number: 8, role: 'member1', label: 'node8 (member1)', member: true };
  const member2 = { number: 9, role: 'member2', label: 'node9 (member2)', member: true };
  const member3 = { number: 10, role: 'member3', label: 'node10 (member3)', member: true };
  const graph = { key: 'registered', id: 'g', resolved: 'g', registered: true, private: false };
  const accepts = (node, sub) => node.number === 8 && sub === null;
  const io = createObservation({ api: writesApi(accepts) }, { boundMs: 60_000, definitionMs: 20, syncedMs: 20, stamp: 'S', predicate: LABEL });
  for (const member of [member1, member2]) {
    const observed = await io.observeSubscription(member, graph, Date.now()).done;
    assert.equal(observed.definedAt, null);
    assert.equal(io.definitionSeen(member, graph), false);
  }
  assert.equal(io.definitionSeen(member3, graph), undefined);
  const records = [];
  for (const [author, sub] of [[member1, null], [member1, 's'], [member2, null], [member2, 's'], [member3, null]]) {
    records.push(await io.write(author, graph, sub, `${author.role} live ${sub ? 'sub-graph' : 'root'}`));
  }
  assert.equal(io.definitionSeen(member1, graph), true);
  assert.equal(io.definitionSeen(member2, graph), false);
  // The report judges each write on a snapshot of its author's history taken when it judges it.
  const lines = [];
  const report = createReport({ 7: 'registered' }, { print: line => lines.push(line) });
  for (const record of records) {
    report.reportPair({ caseId: 7, record, node: owner, from: 0, progress: { view: 1_000, partitions: 1_000 }, last: {} },
      { boundMs: 60_000, definitionSeen: io.definitionSeen(record.author, record.graph) });
  }
  const verdict = text => lines.find(line => line.includes(text))?.match(/^ {2}\[(\w+)\]/)?.[1];
  assert.equal(verdict('"member1 live root (1)"'), 'PASS', lines.join('\n'));
  assert.equal(verdict('"member1 live sub-graph (2)"'), 'FAIL', lines.join('\n'));
  assert.ok(lines.find(line => line.includes('"member1 live sub-graph (2)"')).endsWith('the author held the definition before and lost it, so this is not #3264'));
  assert.equal(verdict('"member2 live root (3)"'), 'XFAIL', lines.join('\n'));
  assert.equal(verdict('"member2 live sub-graph (4)"'), 'XFAIL', lines.join('\n'));
  // No known history: no exemption.
  assert.equal(verdict('"member3 live root (5)"'), 'FAIL', lines.join('\n'));
});
