import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { busyMember } from '../member-sharing/busy-member.mjs';

/**
 * Case 6 against a fake member 2, in real time. When it subscribes to the
 * large graph its transfer takes the only slot, as its admission trace says,
 * and gives it up `runsMs` later; with `afterwards: 'pull'` a pull of the
 * public graph takes the slot then. Each write is found by its reads at
 * `receivedAt` (given the transfer). `policy` is the general pool's policy
 * its trace records. Returns the lines case 6 reported.
 */
async function runCase6(t, { runsMs, afterwards = 'nothing', receivedAt, policy = { limit: 1, queueLimit: 0, partitioned: false }, writesTrace = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-case6-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = { number: 7, role: 'owner', label: 'node7 (owner)', member: false };
  const member1 = { number: 8, role: 'member1', label: 'node8 (member1)', member: true };
  const member2 = { number: 9, role: 'member2', label: 'node9 (member2)', member: true, trace: join(dir, 'sync-admissions.jsonl') };
  const pub = { key: 'public', id: '0xabc/issue-3251-public-1', registered: false, private: false };
  const big = { key: 'large', id: '0xabc/issue-3251-large-1', registered: false, private: false };
  const traced = (event, id, label, reserved = false) => {
    if (writesTrace) appendFileSync(member2.trace, `${JSON.stringify({ event, id, label, reserved, ...policy, at: Date.now() })}\n`);
  };
  let transfer = null;
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  // Case 6 reads no diagnostics: they report one pool, grown by the reserved slot (#3258).
  const devnet = {
    logSize: () => 0,
    logSince: () => '',
    async api(node, method, path) { throw new Error(`case 6 asked ${path}`); },
  };
  const graphs = {
    async subscribe(node, graph) {
      transfer = { endsAt: Date.now() + runsMs };
      traced('start', '41-1', `shared-memory:${graph.id}:Owner123`);
      timers.push(setTimeout(() => {
        traced('release', '41-1', `shared-memory:${graph.id}:Owner123`);
        if (afterwards === 'pull') traced('start', '41-2', `shared-memory:${pub.id}:Owner123`);
      }, runsMs));
      return Date.now();
    },
  };
  const io = {
    async writeAndWatch(caseId, author, graph, sub, what, nodes) {
      const from = Date.now();
      const at = receivedAt(transfer);
      const pair = { caseId, record: { author, graph, sub, value: what }, node: nodes[0], from, progress: { view: at - from, partitions: at - from }, last: {} };
      return { pairs: [pair], done: new Promise(resolve => { timers.push(setTimeout(resolve, Math.max(0, at - Date.now()) + 100)); }) };
    },
    definitionSeen: () => undefined,
  };
  const lines = [];
  const report = {
    fail: (id, text) => { lines.push(['FAIL', id, text]); },
    note: text => { lines.push(['NOTE', text]); },
    reportPair: pair => { lines.push(['PAIR', pair.caseId, pair.record.value]); },
  };
  await busyMember({ devnet, edges: { owner, member1, member2 }, graphs, io, report, precondition: async () => true, boundMs: 60_000, sub: 's' }, pub, big);
  return lines;
}

test('case 6: writes received after the transfer gave up the slot are not exercised', async t => {
  // The transfer gives up the slot 1 s after the subscribe; each write is found 0.1 s later.
  for (const afterwards of ['pull', 'nothing']) {
    const lines = await runCase6(t, { runsMs: 1_000, afterwards, receivedAt: transfer => transfer.endsAt + 100 });
    assert.deepEqual(lines.filter(entry => entry[0] === 'PAIR'), [], JSON.stringify(lines));
    const fails = lines.filter(entry => entry[0] === 'FAIL');
    assert.equal(fails.length, 3, JSON.stringify(lines));
    for (const [, id, text] of fails) {
      assert.equal(id, 6);
      assert.ok(text.endsWith('after the large transfer gave up the slot (the transfer gave up the slot): not exercised'), text);
    }
    assert.match(lines.at(-1)[1], /^case 6: member2's transfer of the large graph held its only sync slot for \d+ s of \d+ s \(then the transfer gave up the slot\)/);
  }
});

test('case 6: writes received while the transfer holds the slot are judged as usual', async t => {
  const lines = await runCase6(t, { runsMs: 60_000, receivedAt: () => Date.now() + 300 });
  assert.deepEqual(lines.filter(entry => entry[0] !== 'NOTE'), [
    ['PAIR', 6, 'owner while member2 is busy, root'],
    ['PAIR', 6, 'owner while member2 is busy, sub-graph'],
    ['PAIR', 6, 'member1 while member2 is busy, root'],
  ]);
  assert.match(lines.at(-1)[1], /held its only sync slot through every receipt check/);
});
