import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { busyMember } from '../member-sharing/busy-member.mjs';

/**
 * Case 6 against a fake member 2, in real time. When it subscribes to the
 * large graph its transfer takes a slot (`slot`, the general one by default),
 * as its admission trace says, having started six seconds before so that it
 * counts as held for a while, and gives it up `runsMs` later. Like the agent,
 * the fake lists the admissions that hold a slot in its trace (every 200 ms
 * here). With `lostRelease` the transfer's release line is never written; with
 * `afterwards: 'pull'` a pull of the public graph takes the general slot once
 * the transfer has ended. Each write is found by its reads at `receivedAt`
 * (given the transfer). `policy` is the general pool's policy its trace
 * records. Returns the lines case 6 reported.
 */
async function runCase6(t, {
  runsMs, afterwards = 'nothing', receivedAt, slot = 'general', lostRelease = false,
  policy = { limit: 1, queueLimit: 0, partitioned: false }, writesTrace = true,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-case6-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = { number: 7, role: 'owner', label: 'node7 (owner)', member: false };
  const member1 = { number: 8, role: 'member1', label: 'node8 (member1)', member: true };
  const member2 = { number: 9, role: 'member2', label: 'node9 (member2)', member: true, trace: join(dir, 'sync-admissions.jsonl') };
  const pub = { key: 'public', id: '0xabc/issue-3251-public-1', registered: false, private: false };
  const big = { key: 'large', id: '0xabc/issue-3251-large-1', registered: false, private: false };
  const append = record => { if (writesTrace) appendFileSync(member2.trace, `${JSON.stringify(record)}\n`); };
  const live = new Set();
  const start = (id, label, at = Date.now(), slotOf = 'general') => { live.add(id); append({ event: 'start', id, label, slot: slotOf, ...policy, at }); };
  const release = (id, label, slotOf = 'general') => { live.delete(id); if (!lostRelease || id !== '41-1') append({ event: 'release', id, label, slot: slotOf, ...policy, at: Date.now() }); };
  let transfer = null;
  const timers = [];
  const heartbeat = setInterval(() => { if (live.size) append({ event: 'holding', ids: [...live], at: Date.now() }); }, 200);
  t.after(() => { timers.forEach(clearTimeout); clearInterval(heartbeat); });
  // Case 6 reads no diagnostics: they report one pool, grown by the reserved slots (#3258, #3302).
  const devnet = {
    logSize: () => 0,
    logSince: () => '',
    async api(node, method, path) { throw new Error(`case 6 asked ${path}`); },
  };
  const graphs = {
    async subscribe(node, graph) {
      transfer = { endsAt: Date.now() + runsMs };
      const label = `shared-memory:${graph.id}:Owner123`;
      start('41-1', label, Date.now() - 6_000, slot);
      timers.push(setTimeout(() => {
        release('41-1', label, slot);
        if (afterwards === 'pull') start('41-2', `shared-memory:${pub.id}:Owner123`);
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
  await busyMember({ devnet, edges: { owner, member1, member2 }, graphs, io, report, precondition: async () => true, boundMs: 60_000, sub: 's', admitMs: 2_000 }, pub, big);
  return lines;
}

const notExercised = (lines, reason) => {
  assert.deepEqual(lines.filter(entry => entry[0] === 'PAIR'), [], JSON.stringify(lines));
  const fails = lines.filter(entry => entry[0] === 'FAIL');
  assert.equal(fails.length, 3, JSON.stringify(lines));
  for (const [, id, text] of fails) {
    assert.equal(id, 6);
    assert.ok(text.endsWith(`after the last trace line that shows the large transfer holding the slot (${reason}): not exercised`), text);
  }
};

test('case 6: writes received after the transfer gave up the slot are not exercised', async t => {
  // The transfer gives up the slot 1 s after the subscribe; each write is found 0.1 s later.
  for (const afterwards of ['pull', 'nothing']) {
    const lines = await runCase6(t, { runsMs: 1_000, afterwards, receivedAt: transfer => transfer.endsAt + 100 });
    notExercised(lines, 'the transfer gave up the slot');
    assert.match(lines.at(-1)[1], /^case 6: member2's transfer of the large graph held its general sync slot for \d+ s of \d+ s \(then the transfer gave up the slot\)/);
  }
});

test('case 6: a lost release does not stretch the transfer over receipts made after it ended (review example)', async t => {
  // The transfer ends 1 s after the subscribe, but its release line is never written; a pull of the public graph
  // takes the general slot and the writes arrive 0.1 s after the transfer ended.
  const lines = await runCase6(t, { runsMs: 1_000, afterwards: 'pull', lostRelease: true, receivedAt: transfer => transfer.endsAt + 100 });
  notExercised(lines, 'no trace line shows the transfer holding the slot after then');
  assert.match(lines.at(-1)[1], /member2's pulls of the public graph meanwhile: 1 in the general slot; refused for a busy slot: 0; shared-memory reads of it member2 refused as unauthorized or unconfirmed: 0$/);
});

test('case 6: writes received while the transfer holds the slot are judged as usual', async t => {
  const lines = await runCase6(t, { runsMs: 60_000, receivedAt: () => Date.now() + 300 });
  assert.deepEqual(lines.filter(entry => entry[0] !== 'NOTE'), [
    ['PAIR', 6, 'owner while member2 is busy, root'],
    ['PAIR', 6, 'owner while member2 is busy, sub-graph'],
    ['PAIR', 6, 'member1 while member2 is busy, root'],
  ]);
  assert.match(lines.at(-1)[1], /held its general sync slot through every receipt check/);
});

test('case 6: a transfer in a reserved slot, a node without a trace, or spare general slots are not exercised', async t => {
  for (const [options, why] of [
    [{ slot: 'shared-memory' }, 'its transfer of the large graph holds a reserved shared-memory slot, not the general one'],
    [{ writesTrace: false }, 'the node writes no admission trace (DKG_SYNC_ADMISSION_TRACE)'],
    [{ policy: { limit: 8, queueLimit: 0, partitioned: false } }, 'the node runs 8 general sync slot(s), not one'],
  ]) {
    const lines = await runCase6(t, { runsMs: 60_000, receivedAt: () => Date.now() + 300, ...options });
    assert.deepEqual(lines, [['FAIL', 6, `not exercised: member2's transfer of the large graph did not hold its general sync slot within 2 s of the subscribe (${why}); raise MEMBER_SHARING_BIG_ASSETS / MEMBER_SHARING_BIG_TRIPLES`]]);
  }
});
