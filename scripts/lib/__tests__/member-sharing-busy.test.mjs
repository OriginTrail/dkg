import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { busyMember } from '../member-sharing/busy-member.mjs';

/**
 * Case 6 against a fake member 2, in real time. Each attempt subscribes it to
 * a large graph; its transfer takes a slot (`slot`, the general one by
 * default), as its admission trace says, having started 1.2 s before so that
 * it counts as held at once, and gives it up `runsMs` later. Like
 * the agent, the fake lists the admissions that hold a slot in its trace
 * (every 200 ms here). With `lostRelease` the transfer's release line is never
 * written; with `afterwards: 'pull'` a pull of the public graph takes the
 * general slot once the transfer has ended, with `afterwards: 'readmit'` the
 * same pull takes it again at once and holds it `readmitRunsMs` longer, with
 * `afterwards: 'overlap'` a pull of the public graph holds the general slot
 * beside the transfer from its start, with `afterwards: 'gap'` such a pull
 * takes the slot for 100 ms once the transfer gave it up, and the transfer
 * takes it again 200 ms after its release. Each
 * write is found by its reads at `receivedAt` (given the transfer; null: never
 * found). `policy` is the general pool's policy its trace records. `transfers`
 * gives each attempt's transfer (the first one's by default the options
 * themselves); `attempts` is how many case 6 may make; `connect` stands for the
 * dials before each attempt. Returns the lines case 6 reported, the large
 * graphs it asked for and unsubscribed from, and how often it dialed.
 */
async function runCase6(t, {
  runsMs, afterwards = 'nothing', readmitRunsMs = 60_000, receivedAt, slot = 'general', lostRelease = false,
  policy = { limit: 1, queueLimit: 0, partitioned: false }, writesTrace = true, attempts, transfers, connect = async () => {},
}) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-case6-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owner = { number: 7, role: 'owner', label: 'node7 (owner)', member: false };
  const member1 = { number: 8, role: 'member1', label: 'node8 (member1)', member: true };
  const member2 = { number: 9, role: 'member2', label: 'node9 (member2)', member: true, trace: join(dir, 'sync-admissions.jsonl') };
  const pub = { key: 'public', id: '0xabc/issue-3251-public-1', registered: false, private: false };
  const largeGraphOf = (attempt, size) => ({ key: attempt === 1 ? 'large' : `large${attempt}`, id: `0xabc/issue-3251-large${attempt}-1`, registered: false, private: false, size });
  const first = largeGraphOf(1, { assets: 64, triples: 2000 });
  const plan = transfers ?? [{ runsMs, afterwards, readmitRunsMs, receivedAt, slot, lostRelease }];
  const append = record => { if (writesTrace) appendFileSync(member2.trace, `${JSON.stringify(record)}\n`); };
  const live = new Set();
  const start = (id, label, at = Date.now(), slotOf = 'general') => { live.add(id); append({ event: 'start', id, label, slot: slotOf, ...policy, at }); };
  const release = (id, label, slotOf = 'general', lost = false) => { live.delete(id); if (!lost) append({ event: 'release', id, label, slot: slotOf, ...policy, at: Date.now() }); };
  let transfer = null;
  let attempt = 0;
  const timers = [];
  const heartbeat = setInterval(() => { if (live.size) append({ event: 'holding', ids: [...live], at: Date.now() }); }, 200);
  t.after(() => { timers.forEach(clearTimeout); clearInterval(heartbeat); });
  // Case 6 reads no diagnostics: they report one pool, grown by the reserved slots (#3258, #3302).
  const devnet = {
    logSize: () => 0,
    logSince: () => '',
    async api(node, method, path) { throw new Error(`case 6 asked ${path}`); },
  };
  const asked = [];
  const unsubscribed = [];
  const graphs = {
    async subscribe(node, graph) {
      attempt += 1;
      const plan1 = plan[Math.min(attempt, plan.length) - 1];
      const { afterwards: after = 'nothing', readmitRunsMs: again = 60_000, slot: slotOf = 'general', lostRelease: lost = false } = plan1;
      transfer = { ...plan1, endsAt: Date.now() + plan1.runsMs };
      const id = `41-${attempt}`;
      const label = `shared-memory:${graph.id}:Owner123`;
      start(id, label, Date.now() - 1_200, slotOf);
      // A pull of the public graph in the one general slot while the transfer holds it: the trace contradicts the policy.
      if (after === 'overlap') start(`${id}-beside`, `shared-memory:${pub.id}:Owner123`, Date.now() - 1_000);
      timers.push(setTimeout(() => {
        release(id, label, slotOf, lost);
        if (after === 'pull') {
          start(`${id}-pull`, `shared-memory:${pub.id}:Owner123`);
          timers.push(setTimeout(() => release(`${id}-pull`, `shared-memory:${pub.id}:Owner123`), 500));
        }
        if (after === 'gap') {
          start(`${id}-pull`, `shared-memory:${pub.id}:Owner123`);
          timers.push(setTimeout(() => release(`${id}-pull`, `shared-memory:${pub.id}:Owner123`), 100));
          timers.push(setTimeout(() => {
            start(`${id}-again`, label);
            timers.push(setTimeout(() => release(`${id}-again`, label), again));
          }, 200));
        }
        if (after === 'readmit') {
          start(`${id}-again`, label);
          timers.push(setTimeout(() => release(`${id}-again`, label), again));
        }
      }, plan1.runsMs));
      return Date.now();
    },
    async unsubscribe(node, graph) { unsubscribed.push(graph.key); },
  };
  const io = {
    async writeAndWatch(caseId, author, graph, sub, what, nodes) {
      const from = Date.now();
      const at = transfer.receivedAt(transfer);
      const found = at === null ? null : at - from;
      const pair = { caseId, record: { author, graph, sub, value: what, doneAt: from }, node: nodes[0], from, progress: { view: found, partitions: found }, last: {} };
      const settleAt = at ?? Date.now() + 300;
      return { pairs: [pair], done: new Promise(resolve => { timers.push(setTimeout(resolve, Math.max(0, settleAt - Date.now()) + 100)); }) };
    },
    definitionSeen: () => undefined,
  };
  const lines = [];
  const report = {
    fail: (id, text) => { lines.push(['FAIL', id, text]); },
    note: text => { lines.push(['NOTE', text]); },
    reportPair: pair => { lines.push(['PAIR', pair.caseId, pair.record.value, pair.progress.view === null ? 'missing' : 'held']); },
  };
  const largeGraph = async (number, size) => { asked.push([number, size]); return largeGraphOf(number, size); };
  let dialed = 0;
  await busyMember({
    devnet, edges: { owner, member1, member2 }, graphs, io, report, precondition: async () => true, boundMs: 60_000, sub: 's', admitMs: 2_000,
    attempts, largeGraph, connect: async () => { dialed += 1; await connect(dialed); },
  }, pub, first);
  return Object.assign(lines, { asked, unsubscribed, dialed });
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
const held = [
  ['PAIR', 6, 'owner while member2 is busy, root', 'held'],
  ['PAIR', 6, 'owner while member2 is busy, sub-graph', 'held'],
  ['PAIR', 6, 'member1 while member2 is busy, root', 'held'],
];
// A transfer that gives up the slot 1 s after the subscribe, its writes each found 0.1 s later; and one that holds it.
const tooShort = { runsMs: 1_000, receivedAt: transfer => transfer.endsAt + 100 };
const holds = { runsMs: 60_000, receivedAt: () => Date.now() + 300 };

test('case 6: writes received after the transfer gave up the slot are not exercised', async t => {
  for (const afterwards of ['pull', 'nothing']) {
    const lines = await runCase6(t, { ...tooShort, afterwards });
    notExercised(lines, 'the transfer gave up the slot');
    assert.match(lines.at(-1)[1], /^case 6: member2's transfer of the large graph \(64 assets of 2000 triples\) held its general sync slot for \d+ s of \d+ s \(then the transfer gave up the slot\)/);
  }
});

test('case 6: a lost release does not stretch the transfer over receipts made after it ended (review example)', async t => {
  // The transfer ends 1 s after the subscribe, but its release line is never written; a pull of the public graph
  // takes the general slot and the writes arrive 0.1 s after the transfer ended.
  const lines = await runCase6(t, { ...tooShort, afterwards: 'pull', lostRelease: true });
  notExercised(lines, 'no trace line shows the transfer holding the slot after then');
  assert.match(lines.at(-1)[1], /member2's pulls of the public graph meanwhile: 1 in the general slot; refused for a busy slot: 0; shared-memory reads of it member2 refused as unauthorized or unconfirmed: 0$/);
});

test('case 6: writes received while the transfer holds the slot are judged as usual', async t => {
  const lines = await runCase6(t, holds);
  assert.deepEqual(lines.filter(entry => entry[0] !== 'NOTE'), held);
  assert.match(lines.at(-1)[1], /held its general sync slot through every receipt check \(\d+ s\); the writes were shared 0 s, 0 s, 0 s after they started;/);
});

test('case 6: a transfer in a reserved slot, a node without a trace, or spare general slots are not exercised', async t => {
  for (const [options, why] of [
    [{ slot: 'shared-memory' }, 'its transfer of the large graph holds a reserved shared-memory slot, not the general one'],
    [{ writesTrace: false }, 'the node writes no admission trace (DKG_SYNC_ADMISSION_TRACE)'],
    [{ policy: { limit: 8, queueLimit: 0, partitioned: false } }, 'the node runs 8 general sync slot(s), not one'],
  ]) {
    const lines = await runCase6(t, { ...holds, ...options });
    assert.deepEqual([...lines], [['FAIL', 6, `not exercised: member2's transfer of the large graph (64 assets of 2000 triples) did not hold its general sync slot within 2 s of the subscribe (${why})`]]);
  }
});

test('case 6: the transfer taking the slot again at once still holds it for the writes received meanwhile (gate run of 556ad8d48)', async t => {
  // The transfer gives up the slot 1 s after the subscribe and the same pull takes it again at once for 3 s more;
  // each write is found 0.5 s after that first release.
  const lines = await runCase6(t, { runsMs: 1_000, afterwards: 'readmit', readmitRunsMs: 3_000, receivedAt: transfer => transfer.endsAt + 500 });
  assert.deepEqual(lines.filter(entry => entry[0] !== 'NOTE'), held);
  assert.match(lines.at(-1)[1], /held its general sync slot through every receipt check \(\d+ s\), taking it again at once 1 time\(s\);/);
});

test('case 6: an attempt whose writes arrive after the transfer gave up the slot is made again with a larger graph (gate run of 1747d1a7d)', async t => {
  const lines = await runCase6(t, { attempts: 3, transfers: [{ ...tooShort, afterwards: 'pull' }, holds] });
  // Only the second attempt's writes are judged; the first is noted, with the size of the next graph.
  assert.deepEqual(lines.filter(entry => entry[0] !== 'NOTE'), held);
  const notes = lines.filter(entry => entry[0] === 'NOTE').map(entry => entry[1]);
  assert.equal(notes.length, 3, JSON.stringify(lines));
  assert.match(notes[0], /^case 6, attempt 1 of 3: member2's transfer of the large graph \(64 assets of 2000 triples\) held its general sync slot for \d+ s of \d+ s \(then the transfer gave up the slot\)/);
  assert.match(notes[1], /^case 6, attempt 1 of 3: 3 of its writes reached member2 only after the last trace line that shows the transfer holding the slot \(the transfer gave up the slot\), up to \d+ s after the transfer took it: not exercised; attempt 2 transfers a large graph of \d+ assets of \d+ triples, sized to hold the slot about \d+ s at the rate measured$/);
  assert.match(notes[2], /^case 6, attempt 2 of 3: member2's transfer of the large graph \(\d+ assets of \d+ triples\) held its general sync slot through every receipt check/);
  // Member 2 left the first large graph, and the second carries more triples than the first.
  assert.deepEqual(lines.unsubscribed, ['large']);
  assert.equal(lines.asked.length, 1);
  const [[number, size]] = lines.asked;
  assert.equal(number, 2);
  assert.ok(size.assets * size.triples > 64 * 2000, JSON.stringify(size));
});

test('case 6: writes that reach member 2 only once its slot is free fail as not exercised after the last attempt', async t => {
  // A build that delivers a write to member 2 only once the transfer has given up its general slot: every attempt
  // proves nothing, so the case fails on the last one, as one attempt did before.
  const lines = await runCase6(t, { attempts: 3, ...tooShort, afterwards: 'pull' });
  notExercised(lines, 'the transfer gave up the slot');
  assert.equal(lines.asked.length, 2);
  assert.deepEqual(lines.asked.map(([number]) => number), [2, 3]);
  // Each graph carries at least as many triples as the one before, and more than the first, up to the cap.
  const [[, second], [, third]] = lines.asked;
  assert.ok(second.assets * second.triples > 64 * 2000 && third.assets * third.triples >= second.assets * second.triples, JSON.stringify(lines.asked));
  assert.deepEqual(lines.unsubscribed, ['large', 'large2']);
  assert.match(lines.at(-1)[1], /^case 6, attempt 3 of 3: member2's transfer of the large graph/);
});

test('case 6: a write never received fails at once, whatever the slot did, without another attempt', async t => {
  let n = 0;
  const lines = await runCase6(t, { attempts: 3, runsMs: 1_000, receivedAt: transfer => (++n === 2 ? null : transfer.endsAt + 100) });
  assert.equal(lines.asked.length, 0);
  assert.deepEqual(lines.filter(entry => entry[0] === 'PAIR'), [['PAIR', 6, 'owner while member2 is busy, sub-graph', 'missing']]);
  assert.equal(lines.filter(entry => entry[0] === 'FAIL').length, 2);
});

test('case 6: a node that cannot show the case fails at once; a transfer that gave up the slot before the writes is made again', async t => {
  for (const options of [{ writesTrace: false }, { policy: { limit: 8, queueLimit: 0, partitioned: false } }]) {
    const lines = await runCase6(t, { ...holds, attempts: 3, ...options });
    assert.equal(lines.asked.length, 0);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0][2], /^not exercised: member2's transfer of the large graph \(64 assets of 2000 triples\) did not hold its general sync slot within 2 s of the subscribe/);
  }
  // The first transfer is over before the writes can start; the second holds the slot.
  const lines = await runCase6(t, { attempts: 2, transfers: [{ runsMs: 0, receivedAt: () => Date.now() + 300 }, holds] });
  assert.deepEqual(lines.filter(entry => entry[0] !== 'NOTE'), held);
  assert.match(lines.find(entry => entry[0] === 'NOTE')[1], /^case 6, attempt 1 of 2: member2's transfer of the large graph \(64 assets of 2000 triples\) did not hold its general sync slot within 2 s of the subscribe \(no transfer of it holds a slot now/);
  assert.deepEqual(lines.unsubscribed, ['large']);
  // No window was measured, so the next graph is twice as large.
  assert.deepEqual(lines.asked, [[2, { assets: 26, triples: 9847, expectedHoldMs: lines.asked[0][1].expectedHoldMs }]]);
});

test('case 6: a trace that shows another admission in the one general slot beside the transfer is judged at once, without another attempt', async t => {
  const lines = await runCase6(t, { attempts: 3, ...tooShort, afterwards: 'overlap' });
  assert.equal(lines.asked.length, 0);
  notExercised(lines, 'the trace shows shared-memory:0xabc/issue-3251-public-1:Owner123 in the one general slot while the transfer held it');
});

test('case 6: a pull that took the slot only between two of the transfer\'s admissions proves nothing, and another attempt follows', async t => {
  const lines = await runCase6(t, {
    attempts: 3,
    transfers: [{ runsMs: 1_000, afterwards: 'gap', readmitRunsMs: 3_000, receivedAt: transfer => transfer.endsAt + 500 }, holds],
  });
  assert.deepEqual(lines.filter(entry => entry[0] !== 'NOTE'), held);
  assert.match(lines.find(entry => entry[0] === 'NOTE')[1], /^case 6, attempt 1 of 3: member2's transfer .* \(then the trace shows shared-memory:0xabc\/issue-3251-public-1:Owner123 in the one general slot while the transfer held it\)/);
  assert.equal(lines.asked.length, 1);
});

test('case 6: the members dial again before each attempt; an attempt whose dial fails fails the case', async t => {
  const twice = await runCase6(t, { attempts: 3, transfers: [{ ...tooShort, afterwards: 'pull' }, holds] });
  assert.equal(twice.dialed, 2);
  const lines = await runCase6(t, {
    attempts: 3, transfers: [{ ...tooShort, afterwards: 'pull' }, holds],
    connect: async n => { if (n === 2) throw new Error('node9 (member2) could not dial the feeder through the relay: HTTP 0'); },
  });
  assert.deepEqual(lines.filter(entry => entry[0] !== 'NOTE'),
    [['FAIL', 6, 'node9 (member2) could not dial the feeder through the relay: HTTP 0, attempt 2 of 3']]);
  assert.equal(lines.asked.length, 1);
});

test('case 6: an attempt count below one makes one attempt', async t => {
  const lines = await runCase6(t, { attempts: 0, ...tooShort, afterwards: 'pull' });
  notExercised(lines, 'the transfer gave up the slot');
  assert.equal(lines.asked.length, 0);
});
