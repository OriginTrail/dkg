// The indexer's reads of the events. A read changes the state only once it has
// finished; a rescan reads a stretch again and keeps what is older; state written
// before that is repaired once; a rescan is due once an epoch and waits its pause;
// and the explorer's request limit stops a read at once.
//
//   node build.mjs --test

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BlockscoutSource, IFACES, RateLimited } from '../lib/chain.mjs';
import { OVERLAP_BLOCKS, readEvents, repairState, RESCAN_MARGIN_SECONDS, rescanPlan } from '../lib/events.mjs';

const SETTLEMENT = `0x${'11'.repeat(20)}`;
const STAKING = `0x${'22'.repeat(20)}`;
const T0 = 1_794_000_000;

const hashOf = (block, n) => `0x${block.toString(16).padStart(56, '0')}${n.toString(16).padStart(8, '0')}`;
const noRevert = async () => null;
const fresh = () => ({ v: 2, addresses: { QueryInferenceSettlement: [SETTLEMENT], StakingV10: [STAKING] }, cursors: {}, logs: [], txs: {} });

/** A batch accepted by the settlement at `block`, as an explorer gives the log. */
function landing(block) {
  const iface = IFACES.QueryInferenceSettlement;
  const { topics, data } = iface.encodeEventLog(iface.getEvent('ReceiptBatchAccepted'), [4n, `0x${'ab'.repeat(32)}`, 1n, 5n, 5n, 10n ** 17n]);
  return { address: SETTLEMENT, topics, data, block, idx: 0, tx: hashOf(block, 0), at: T0 + block };
}

/** A claim at `block`. */
function claim(block) {
  const iface = IFACES.StakingV10;
  const { topics, data } = iface.encodeEventLog(iface.getEvent('RewardsClaimed'), [1n, 10n ** 18n]);
  return { address: STAKING, topics, data, block, idx: 0, tx: hashOf(block, 1), at: T0 + block };
}

/** A batch sent to the settlement at `block`. */
const batch = (block, ok = true) => ({ hash: hashOf(block, 0), ok, from: `0x${'33'.repeat(20)}`, to: SETTLEMENT, input: '0x', at: T0 + block, block, position: 0, revert: null });

/** A source over fixed logs and transactions, newest first as an explorer gives them. `fail` makes its transaction lists fail. */
function source({ logs = [], txs = [], fail = false } = {}) {
  return {
    asked: [],
    async logs(address, { sinceBlock = 0, topic = null } = {}) {
      this.asked.push(['logs', address, sinceBlock]);
      return logs.filter((l) => l.address === address && l.block >= sinceBlock && (!topic || l.topics[0] === topic)).sort((a, b) => b.block - a.block);
    },
    async txs(address, { sinceBlock = 0 } = {}) {
      this.asked.push(['txs', address, sinceBlock]);
      if (fail) throw new Error(`explorer /addresses/${address}/transactions: HTTP 429`);
      return txs.filter((t) => t.to === address && t.block >= sinceBlock).sort((a, b) => b.block - a.block);
    },
  };
}

test('a finished read keeps the new events and moves the cursors', async () => {
  const st = fresh();
  const added = await readEvents(source({ logs: [landing(100), landing(200), claim(150)], txs: [batch(100), batch(200)] }), st, { revertOf: noRevert });
  assert.equal(added, 3);
  assert.deepEqual(
    st.logs.map((l) => [l.k, l.block]),
    [
      ['ReceiptBatchAccepted', 100],
      ['RewardsClaimed', 150],
      ['ReceiptBatchAccepted', 200],
    ],
  );
  assert.equal(st.cursors[`${SETTLEMENT}:logs`], 200);
  assert.equal(st.cursors[`${SETTLEMENT}:txs`], 200);
  assert.equal(st.cursors[`${STAKING}:logs`], 150);
  assert.deepEqual(Object.keys(st.txs).sort(), [hashOf(100, 0), hashOf(200, 0)]);
});

test('a read that fails part-way leaves the cursors, the events and the transactions as they were', async () => {
  const st = fresh();
  await readEvents(source({ logs: [landing(100)], txs: [batch(100)] }), st, { revertOf: noRevert });
  const before = structuredClone(st);
  const later = { logs: [landing(100), landing(20_000), landing(50_000)], txs: [batch(100), batch(20_000), batch(50_000)] };

  // The settlement's events are read, then its transactions fail on the limit.
  await assert.rejects(readEvents(source({ ...later, fail: true }), st, { revertOf: noRevert }), /HTTP 429/);
  assert.deepEqual(st, before);

  // So the next read starts where the last good one ended, not at the failed
  // read's newest block, and misses nothing between.
  const next = source(later);
  assert.equal(await readEvents(next, st, { revertOf: noRevert }), 2);
  assert.deepEqual(next.asked[0], ['logs', SETTLEMENT, Math.max(0, 100 - OVERLAP_BLOCKS)]);
  assert.deepEqual(
    st.logs.map((l) => l.block),
    [100, 20_000, 50_000],
  );
  assert.equal(st.cursors[`${SETTLEMENT}:logs`], 50_000);
});

test('a rescan reads again from its block on, and keeps what is older', async () => {
  const st = fresh();
  await readEvents(source({ logs: [landing(100), landing(200), landing(300)] }), st, { revertOf: noRevert });

  // The block at 200 was taken back; one at 250 was indexed late.
  const again = source({ logs: [landing(100), landing(250), landing(300)] });
  assert.equal(await readEvents(again, st, { fromBlock: 150, revertOf: noRevert }), 1);
  assert.deepEqual(
    st.logs.map((l) => l.block),
    [100, 250, 300],
  );
  assert.ok(again.asked.every(([, , since]) => since === 150));
});

test('a reverted batch held with its reason is not asked about again', async () => {
  const st = fresh();
  let asked = 0;
  const revertOf = async () => {
    asked++;
    return { name: 'GroupFault', group: 0, fault: 'OutsideEpoch' };
  };
  const failed = batch(500, false);
  await readEvents(source({ txs: [failed] }), st, { revertOf });
  await readEvents(source({ txs: [failed] }), st, { revertOf });
  await readEvents(source({ txs: [failed] }), st, { fromBlock: 0, revertOf });
  assert.equal(asked, 1);
  assert.equal(st.txs[failed.hash].revert.fault, 'OutsideEpoch');
});

test('state written before reads were all or nothing is repaired once', () => {
  const st = {
    v: 1,
    cursors: { [`${SETTLEMENT}:logs`]: 60_000, [`${SETTLEMENT}:txs`]: 45_000, [`${STAKING}:logs`]: 150 },
    logs: [{ block: 100 }, { block: 40_000 }],
    txs: {},
    fullScanEpoch: 672,
    needFullScan: false,
  };
  assert.equal(repairState(st), true);
  assert.deepEqual(st.cursors, { [`${SETTLEMENT}:logs`]: 40_000, [`${SETTLEMENT}:txs`]: 40_000, [`${STAKING}:logs`]: 150 });
  assert.equal(st.v, 2);
  assert.equal(st.rescanEpoch, 672);
  assert.equal('fullScanEpoch' in st || 'needFullScan' in st, false);
  assert.equal(repairState(st), false);
});

test('a rescan is due once an epoch, from before the epoch before, and not again within its pause', () => {
  const clock = { startTime: T0, epochLength: 86_400, currentEpoch: 10 };
  const start9 = T0 + 8 * 86_400;
  const logs = [
    { block: 1, at: start9 - 2 * RESCAN_MARGIN_SECONDS },
    { block: 2, at: start9 - RESCAN_MARGIN_SECONDS },
    { block: 3, at: start9 - 60 },
    { block: 4, at: start9 + 60 },
  ];
  const st = { clock, logs, rescanEpoch: 9, rescanFrom: null, rescanNotBefore: null };
  const now = start9 + 86_400 + 300;

  assert.deepEqual(rescanPlan(st, now), { fromEpoch: 9, fromBlock: 2 });
  assert.equal(rescanPlan({ ...st, rescanNotBefore: now + 1 }, now), null);
  assert.equal(rescanPlan({ ...st, rescanEpoch: 10 }, now), null);
  // An older epoch that disagreed: from before it, where no event held is that old.
  assert.deepEqual(rescanPlan({ ...st, rescanEpoch: 10, rescanFrom: 7 }, now), { fromEpoch: 7, fromBlock: 0 });
});

test("the explorer's request limit stops a read at once, and what is left is kept", async (t) => {
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{}', { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '74000' } });
  };
  const stats = {};
  const explorer = new BlockscoutSource('https://explorer.invalid', { stats });
  await assert.rejects(explorer.get('/addresses/0x00/transactions'), (e) => e instanceof RateLimited && /HTTP 429/.test(e.message) && /74 s/.test(e.message));
  assert.equal(calls, 1);
  assert.equal(stats.explorerCalls, 1);
  assert.equal(explorer.quota(), 0);

  globalThis.fetch = async () => new Response('{"items":[]}', { status: 200, headers: { 'x-ratelimit-remaining': '142' } });
  assert.deepEqual(await explorer.get('/addresses/0x00/logs'), { items: [] });
  assert.equal(explorer.quota(), 142);
});
