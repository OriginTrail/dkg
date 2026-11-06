// PHASE unused: the money, value, pool and unused share of every ended epoch,
// from storage, against the rollover rule worked out without the contract. Then,
// in a reverted snapshot, a sale after a long quiet spell: nothing has to catch up
// before a claim, and the pool of the epoch with the sale walks the whole run back.
//
// Per ended epoch from activation: money = walletFunding + accountFunding,
// served = ΣR counted in it, pool = what its nodes share. An epoch with no value
// has no pool, and its money waits for the next epoch with value, whose pool takes
// all of it. The unused share of a pool is what no counted value stands for.

import { subscriptionIdOf } from '../../../test/helpers/conviction-service';
import type { Contracts } from '../contracts';
import { chainNow } from '../network';
import { EpochNumbers, claimPreview, epochNumbers, kpiNets, poolShareOf, poolsFromMoney } from '../reads';
import { Report, fmt, sum } from '../report';
import { Ctx, saveResults, send, withPool } from './context';
import { approve, claimAll, fundTrac, requestDomain, signedGroup, submitBatch, walletRequest } from './operations';
import { impersonate } from './plumbing';
import { positions } from './reads';
import { loadPre } from './results';
import { SELLERS, TRAC } from './scenario';

/** How far the quiet spell runs, in epochs with no value. */
const QUIET_EPOCHS = 40n;

export async function phaseUnused(ctx: Ctx): Promise<void> {
  const { report } = ctx;
  const c = await withPool(ctx);
  const activation = await c.qis.activationEpoch();
  const last = (await c.chronos.getCurrentEpoch()) - 1n;
  const epochs: EpochNumbers[] = [];
  for (let e = activation; e <= last; e++) epochs.push(await epochNumbers(c, e));
  const { pools, waiting } = poolsFromMoney(epochs);
  const rows = epochs.map((x) => ({ ...x, unused: x.pool === 0n ? 0n : x.pool - x.totalServed }));
  report.say(`\nunused share, epochs ${activation}..${last} (money = walletFunding + accountFunding, served = totalServed):`);
  for (const r of rows) {
    if (r.money > 0n || r.totalServed > 0n) report.say(`  epoch ${r.epoch}: money ${fmt(r.money)}, served ${fmt(r.totalServed)}, pool ${fmt(r.pool)}, unused ${fmt(r.unused)}`);
  }
  const empty = rows.filter((r) => r.money === 0n && r.totalServed === 0n).map((r) => r.epoch);
  report.say(`  the other ${empty.length} epochs had no money and served nothing`);
  report.say(`  total: money ${fmt(sum(rows.map((r) => r.money)))}, served ${fmt(sum(rows.map((r) => r.totalServed)))}, in pools ${fmt(sum(rows.map((r) => r.pool)))}, unused ${fmt(sum(rows.map((r) => r.unused)))}, waiting ${fmt(waiting)}`);
  report.check(
    'every ended epoch reads the pool the rollover rule gives: none with no value, and otherwise its money and all that waited for it',
    rows.every((r, i) => r.pool === pools[i]),
    rows.filter((r, i) => r.pool !== pools[i]).map((r) => `epoch ${r.epoch}: ${fmt(r.pool)}`).join(', '),
  );
  report.check(
    'every coin funded is in a pool or still waiting',
    sum(rows.map((r) => r.money)) === sum(rows.map((r) => r.pool)) + waiting,
  );
  report.check('no epoch\'s value exceeds its pool', rows.every((r) => r.totalServed <= r.pool));

  const lastValue = rows.reduce((at, r) => (r.totalServed > 0n ? r.epoch : at), 0n);
  const quietSpell = await ctx.fork.inSnapshot(() => saleAfterQuietSpell(ctx, c, last, lastValue, waiting));
  saveResults(ctx, 'unused', { activation, last, rows, waiting, quietSpell }, { txs: false });
}

/** The claim after the quiet spell pays what the epochs' nets give, a share of the sale's pool in it. */
export function checkQuietClaim(report: Report, claimed: { reward: bigint; rawDelta: bigint; gasUsed: bigint }, expected: bigint, poolShare: bigint): void {
  report.check(
    "after the quiet spell the claim pays what the epochs' nets give, a share of the sale's pool in it, with nothing to catch up first",
    poolShare > 0n && claimed.reward === expected && claimed.rawDelta === expected,
    `${fmt(claimed.reward)} TRAC of ${fmt(expected)}, ${fmt(poolShare)} of it from the pool; gas used ${claimed.gasUsed}`,
  );
}

/**
 * Money funded for the epoch in progress, which no one serves, then a sale
 * `QUIET_EPOCHS` epochs later, and a claim on its seller the epoch after that.
 * `lastValue` is the last epoch with value, and `waiting` the money waiting since.
 */
async function saleAfterQuietSpell(ctx: Ctx, c: Contracts, lastEnded: bigint, lastValue: bigint, waiting: bigint): Promise<{ [key: string]: unknown }> {
  const { report } = ctx;
  const check = report.check.bind(report);
  const [, buyer, , , , , , session] = await ctx.hre.ethers.getSigners();
  const seller = SELLERS[0];
  const op = loadPre().operational[String(seller)];
  if (!op) throw new Error(`no operational key seen for node ${seller}`);
  const sswAddr = await c.ssw.getAddress();
  const fund = (epoch: bigint, label: string) => send(ctx, label, buyer, sswAddr, c.ssw.interface.encodeFunctionData('fundFromWallet', [walletRequest(epoch, session.address, TRAC, 'rehearsal plan around a quiet spell')]));

  const hubOwner = await impersonate(ctx, await ctx.stack.hub.owner());
  await fundTrac(ctx, hubOwner, buyer.address, 2n * TRAC, 'fork-only: Hub owner sends TRAC to the wallet buyer');
  await approve(ctx, 'wallet buyer: approve ServiceSubscriptionsWallet', buyer, sswAddr, 2n * TRAC);
  const quiet = lastEnded + 1n;
  await fund(quiet, `wallet buyer: fundFromWallet(epoch ${quiet}, ${fmt(TRAC)} TRAC), which no one serves`);

  const sale = quiet + QUIET_EPOCHS;
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(sale)) + 120n);
  report.say(`\nEpoch ${await c.chronos.getCurrentEpoch()}: in a snapshot, a sale ${sale - 1n - lastValue} epochs after the last value`);
  await fund(sale, `wallet buyer: fundFromWallet(epoch ${sale}, ${fmt(TRAC)} TRAC)`);
  const score = await c.rss.getNodeEpochScore(lastEnded, seller);
  await ctx.fork.proof(c, seller, score > 0n ? score : 10n ** 18n, `node ${seller}'s proof in epoch ${sale}`);
  const group = await signedGroup({ domain: await requestDomain(c), session, subscriptionId: subscriptionIdOf(buyer.address, sale), seller, firstNonce: 0n, values: [TRAC], issuedAt: await chainNow(ctx.hre) });
  await submitBatch(ctx, c.qs, await impersonate(ctx, op), `node ${seller} operational key: submitReceiptBatch`, [group]);
  const pool = await c.qs.epochPool(sale);
  check(
    `the sale's pool walks back over the quiet epochs and takes all that waited`,
    pool === 2n * TRAC + waiting,
    `${fmt(pool)} TRAC = ${fmt(TRAC)} of the sale + ${fmt(TRAC)} of epoch ${quiet} + ${fmt(waiting)} waiting before it`,
  );

  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(sale + 1n)) + 1n);
  const walk = await c.qs.queryInferenceGross.estimateGas(sale, seller);
  const noValue = await c.qs.queryInferenceGross.estimateGas(sale, SELLERS[1]);
  const run = sale - 1n - lastValue;
  const perEpoch = (walk - noValue) / run;
  report.say(`  queryInferenceGross: ${walk} gas with value, walking ${run} epochs; ${noValue} with none, walking nothing; about ${perEpoch} per epoch walked`);
  const p = (await positions(c)).find((x) => x.node === seller);
  if (!p) throw new Error(`no position on node ${seller}`);
  // What the claim must pay, worked out before it from what no claim writes.
  const from = p.lastClaimedEpoch + 1n;
  const { nets } = await kpiNets(c, seller, from, sale);
  const expected = await claimPreview(c, p.tokenId, seller, from, sale, p.raw, nets);
  const inSale = expected.per.find((x) => x.epoch === sale);
  if (!inSale) throw new Error(`token ${p.tokenId} has no reward in epoch ${sale}`);
  const { poolShare } = await poolShareOf(c, seller, sale, inSale.score, inSale.net);
  const [claimed] = await claimAll(ctx, [p], 'after the quiet spell:');
  checkQuietClaim(report, claimed, expected.total, poolShare);
  return { sale, pool, run, gross: { walk, noValue, perEpoch }, claimGas: claimed.gasUsed };
}
