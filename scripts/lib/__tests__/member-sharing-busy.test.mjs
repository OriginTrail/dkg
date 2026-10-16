import assert from 'node:assert/strict';
import test from 'node:test';
import { busyMember } from '../member-sharing/busy-member.mjs';

const pad = n => String(n).padStart(2, '0');
const logTime = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/**
 * Case 6 against a fake member 2, in real time. Its transfer of the large
 * graph started 1.5 s before the subscribe answers and runs `runsMs`; after
 * it the slot holds a pull of the public graph admitted as it ended (`afterwards:
 * 'pull'`) or nothing. Each write is found by its reads at `receivedAt`
 * (given the transfer). With `latePullLine`, the transfer starts 0.1 s into
 * a second, so that the pull shares its log second, and the pull's line
 * reaches the log only once the writes begin, after the confirmation.
 * Returns the lines case 6 reported.
 */
async function runCase6({ runsMs, afterwards, receivedAt, latePullLine = false }) {
  const owner = { number: 7, role: 'owner', label: 'node7 (owner)' };
  const member1 = { number: 8, role: 'member1', label: 'node8 (member1)' };
  const member2 = { number: 9, role: 'member2', label: 'node9 (member2)' };
  const pub = { key: 'public', id: '0xabc/issue-3251-public-1', registered: false, private: false };
  const big = { key: 'large', id: '0xabc/issue-3251-large-1', registered: false, private: false };
  let log = '';
  let transfer = null;
  const devnet = {
    logSize: () => Buffer.byteLength(log),
    logSince: (node, offset) => Buffer.from(log).subarray(offset).toString('utf8'),
    async api(node, method, path) {
      assert.equal(path, '/api/diagnostics/backpressure');
      const now = Date.now();
      const start = !transfer ? null : now < transfer.endsAt ? transfer.start : afterwards === 'pull' ? transfer.endsAt : null;
      const running = start !== null && now >= start;
      const age = running ? now - start : 0;
      const json = {
        schedulers: [{
          scheduler: 'sync-global', capacityModel: 'shared',
          totals: { inflight: running ? 1 : 0, inflightLimit: 1, queueLimit: 0, oldestActiveAgeMs: age },
          lanes: [{ lane: 'slow_background', activeOperations: running ? [{ operation: 'shared-memory:subscribe', count: 1, oldestAgeMs: age }] : [] }],
        }],
      };
      return { status: 200, json, text: JSON.stringify(json) };
    },
  };
  const graphs = {
    async subscribe(node, graph) {
      const start = latePullLine ? Math.floor((Date.now() - 1500) / 1000) * 1000 + 100 : Date.now() - 1500;
      transfer = { start, endsAt: start + runsMs };
      log += `${logTime(start)} sync 8a1576fb-b2e7-4de1-b383-944426cefe26 [DKGAgent] Sync backpressure running shared-memory:${graph.id}:Owner123 (global inflight=1/1, queued=0/0)\n`;
      return Date.now();
    },
  };
  const io = {
    async writeAndWatch(caseId, author, graph, sub, what, nodes) {
      if (latePullLine && !log.includes(pub.id)) {
        log += `${logTime(transfer.endsAt)} sync 0e0011f7-8081-4807-bfa5-7b06ddb0a6b3 [DKGAgent] Sync backpressure running shared-memory:${pub.id}:Owner123 (global inflight=1/1, queued=0/0)\n`;
      }
      const from = Date.now();
      const at = receivedAt(transfer);
      const pair = { caseId, record: { author, graph, sub, value: what }, node: nodes[0], from, progress: { view: at - from, partitions: at - from }, last: {} };
      return { pairs: [pair], done: new Promise(resolve => { setTimeout(resolve, Math.max(0, at - Date.now()) + 100); }) };
    },
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

test('case 6: writes received after the transfer ended between two readings are not exercised', async () => {
  // The transfer ends 2.5 s after the subscribe, half a second after a reading (one a second); each write
  // is found 0.1 s after it ended. The one-second grace of the previous judgement took these receipts.
  for (const [afterwards, reason] of [['pull', 'the slot was held by other work'], ['nothing', 'the sync slot was free']]) {
    const lines = await runCase6({ runsMs: 4_000, afterwards, receivedAt: transfer => transfer.endsAt + 100 });
    assert.deepEqual(lines.filter(line => line[0] === 'PAIR'), [], JSON.stringify(lines));
    const fails = lines.filter(line => line[0] === 'FAIL');
    assert.equal(fails.length, 3, JSON.stringify(lines));
    for (const [, id, text] of fails) {
      assert.equal(id, 6);
      assert.ok(text.endsWith(`later than the last reading that showed the large transfer in the slot (${reason}): not exercised`), text);
    }
    assert.match(lines.at(-1)[1], new RegExp(`^case 6: member2's transfer of the large graph held its only sync slot for \\d+ s of \\d+ s \\(then ${reason}\\)`));
  }
});

test('case 6: writes received while the transfer holds the slot are judged as usual', async () => {
  const lines = await runCase6({ runsMs: 60_000, afterwards: 'pull', receivedAt: () => Date.now() + 300 });
  assert.deepEqual(lines.filter(line => line[0] !== 'NOTE'), [
    ['PAIR', 6, 'owner while member2 is busy, root'],
    ['PAIR', 6, 'owner while member2 is busy, sub-graph'],
    ['PAIR', 6, 'member1 while member2 is busy, root'],
  ]);
  assert.match(lines.at(-1)[1], /held its only sync slot through every receipt check/);
});

test('case 6: work whose admission line reached the log late does not pass for the transfer', async () => {
  // The transfer ends 0.2 s after it started and a pull of the public graph takes the slot in the same log
  // second. When the confirming reading was judged, the log named only the transfer; by the end it names both.
  const lines = await runCase6({ runsMs: 200, afterwards: 'pull', receivedAt: () => Date.now() + 300, latePullLine: true });
  assert.deepEqual(lines.filter(line => line[0] === 'PAIR'), [], JSON.stringify(lines));
  const fails = lines.filter(line => line[0] === 'FAIL');
  assert.equal(fails.length, 3, JSON.stringify(lines));
  for (const [, , text] of fails) {
    assert.ok(text.endsWith('(the whole log no longer ties the work in the slot to the transfer (its log cannot tell the transfer from other work admitted at about the same time)): not exercised'), text);
  }
});
