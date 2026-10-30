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

test('the observation layer keeps each member\'s history with the definition; a refused write fails whatever that history', async () => {
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
  for (const write of ['"member1 live sub-graph (2)"', '"member2 live root (3)"', '"member2 live sub-graph (4)"', '"member3 live root (5)"']) {
    assert.equal(verdict(write), 'FAIL', lines.join('\n'));
  }
});

/**
 * A node's share route, as a test scripts it: `posts` answers each share in
 * turn and `reads` each read of a job (the last of either repeats). Returns the
 * observation with the notes it made, and the requests it sent.
 */
function shareNode({ posts, reads = [], boundMs = 1_000, shareRetryMs = 20 }) {
  const reply = (status, json) => ({ status, json, text: JSON.stringify(json) });
  const sent = [];
  const notes = [];
  let posted = 0;
  let read = 0;
  const devnet = {
    async api(node, method, path, body) {
      sent.push({ method, path, body });
      if (path === '/api/knowledge-assets') return reply(201, { created: body.name });
      if (path.endsWith('/swm/share-async')) {
        if (posted >= 50) throw new Error('the share was sent again without a bound');
        return reply(...posts[Math.min(posted++, posts.length - 1)]);
      }
      return reply(...reads[Math.min(read++, reads.length - 1)]);
    },
  };
  const io = createObservation(devnet, { boundMs, definitionMs: 90_000, syncedMs: 90_000, stamp: 'S', predicate: LABEL, shareRetryMs, note: text => notes.push(text) });
  return { io, sent, notes, shares: () => sent.filter(request => request.path.endsWith('/swm/share-async')) };
}
const AUTHOR = { number: 9, label: 'node9 (member2)' };
const GRAPH = { id: 'g', key: 'public', resolved: 'g' };
const unsure = [503, { code: 'PROMOTE_ADMISSION_UNAVAILABLE', retryable: true, phase: 'persist', admissionOutcome: 'indeterminate', jobId: 'j-1' }];
const notAdmitted = [503, { code: 'PROMOTE_ADMISSION_UNAVAILABLE', retryable: true, phase: 'lock', admissionOutcome: 'not_admitted' }];
const accepted = [200, { jobId: 'j-1' }];
const absent = [404, { error: 'Promote job not found: j-1' }];
const queued = [200, { state: 'queued' }];
const succeeded = [200, { state: 'succeeded' }];
const share = io => io.createAndShare(AUTHOR, { contextGraphId: 'g', name: 'asset', quads: [] }, { createTimeoutMs: 1_000, jobTimeoutMs: 1_000, pollMs: 10, label: 'case 5: a write' });

test('a share whose admission is indeterminate is not sent again: its job is read, and the write goes on when it is there', async () => {
  // As on a healthy node with a busy store: the job is not there yet, then runs and succeeds.
  const node = shareNode({ posts: [unsure], reads: [absent, absent, queued, succeeded] });
  const outcome = await share(node.io);
  assert.equal(outcome.error, undefined);
  assert.equal(typeof outcome.doneAt, 'number');
  assert.equal(node.shares().length, 1);
  assert.ok(node.sent.filter(request => request.method === 'GET').every(request => request.path === '/api/knowledge-assets/swm/share-jobs/j-1'));
  assert.equal(node.notes.length, 2, JSON.stringify(node.notes));
  assert.equal(node.notes[0], 'case 5: a write: its share was answered 503 indeterminate (phase persist): reading job j-1, not sending it again');
  assert.match(node.notes[1], /^case 5: a write: job j-1 was there \d+ s later$/);
});

test('a share whose job never shows within the bound fails the write, and is still never sent again', async () => {
  const node = shareNode({ posts: [unsure], reads: [absent], boundMs: 100 });
  const started = Date.now();
  const outcome = await share(node.io);
  assert.match(outcome.error, /^the share's admission stayed indeterminate: job j-1 was not seen within 0 s \(HTTP 404 /);
  assert.ok(Date.now() - started >= 80, 'it had its bound');
  assert.equal(node.shares().length, 1);
  assert.equal(node.notes.length, 1);
});

test('a job found after an indeterminate answer is judged as any other: one that failed fails the write', async () => {
  const node = shareNode({ posts: [unsure], reads: [[200, { state: 'failed', lastError: { message: 'no quorum' } }]] });
  const outcome = await share(node.io);
  assert.match(outcome.error, /^the share job ended failed: .*no quorum/);
  assert.equal(node.shares().length, 1);
});

test('a share that was not admitted is sent again unchanged, within the bound, and each such answer is noted', async () => {
  const node = shareNode({ posts: [notAdmitted, notAdmitted, accepted], reads: [succeeded] });
  const outcome = await node.io.createAndShare(AUTHOR, { contextGraphId: 'g', name: 'asset', subGraphName: 's', quads: [] }, { createTimeoutMs: 1_000, jobTimeoutMs: 1_000, pollMs: 10, label: 'case 5: a write' });
  assert.equal(outcome.error, undefined);
  assert.deepEqual(node.shares().map(request => request.body), Array(3).fill({ contextGraphId: 'g', entities: 'all', subGraphName: 's' }));
  assert.deepEqual(node.notes, Array(2).fill('case 5: a write: its share was answered 503 not_admitted (phase lock): sending it again'));
});

test('a share still not admitted when the bound runs out fails the write, with the node\'s answer', async () => {
  const node = shareNode({ posts: [notAdmitted], boundMs: 100 });
  const outcome = await share(node.io);
  assert.match(outcome.error, /^the share was not accepted: HTTP 503 .*"admissionOutcome":"not_admitted"/);
  assert.ok(node.shares().length >= 2 && node.shares().length <= 6, `sent ${node.shares().length} time(s)`);
});

test('a resend that meets the first share, or an unsure answer, follows the job it is told of', async () => {
  const running = shareNode({ posts: [notAdmitted, [409, { existingJobId: 'j-2' }]], reads: [succeeded] });
  assert.equal((await share(running.io)).error, undefined);
  assert.equal(running.sent.at(-1).path, '/api/knowledge-assets/swm/share-jobs/j-2');
  const then = shareNode({ posts: [notAdmitted, unsure], reads: [absent, succeeded] });
  assert.equal((await share(then.io)).error, undefined);
  assert.equal(then.shares().length, 2);
});

test('any other answer to a share fails the write at once, with no note', async () => {
  for (const answer of [[500, { error: 'boom' }], [503, { code: 'STORE_SCHEDULER_BUSY', retryable: true }], [400, { code: 'KA_ATOMIC_SHARE_REQUIRED' }]]) {
    const node = shareNode({ posts: [answer] });
    const outcome = await share(node.io);
    assert.match(outcome.error, /^the share was not accepted: HTTP /);
    assert.equal(node.shares().length, 1);
    assert.deepEqual(node.notes, []);
  }
});

test('a write names its case and itself in the note of its share, and counts as written once the job ran', async () => {
  const node = shareNode({ posts: [unsure], reads: [absent, succeeded] });
  const handle = await node.io.writeAndWatch(5, AUTHOR, GRAPH, 's', 'member2 later, sub-graph', []);
  await handle.done;
  assert.match(node.notes[0], /^case 5: "member2 later, sub-graph \(1\)" by node9 \(member2\) in public\/s: its share was answered 503 indeterminate/);
  // The bound of the pairs of this write starts when its job ended.
  const record = await node.io.write(AUTHOR, GRAPH, null, 'no case');
  assert.equal(record.error, null);
  assert.equal(typeof record.doneAt, 'number');
  assert.match(node.notes.at(-1), /^"no case \(2\)" by node9 \(member2\) in public root: job j-1 was there \d+ s later$/);
  // One that never shows is a write that failed, with its reason, and its pairs are not read.
  const lost = shareNode({ posts: [unsure], reads: [absent], boundMs: 50 });
  const failed = await lost.io.write(AUTHOR, GRAPH, null, 'lost');
  assert.match(failed.error, /stayed indeterminate/);
  assert.equal(failed.doneAt, null);
});
