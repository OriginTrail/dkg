// PHASE claim, as soon as E has ended. An epoch's numbers are final when it ends,
// so nothing has to run first: what the phase does is hold them to what the chain
// shows, then claim. Every group counted in E against its ReceiptsLanded event,
// the money of E against its fundings, every ended epoch's pool against the rollover
// rule; then claimFor on our position against the epochs' nets, and from E its money
// (walletFunding + accountFunding), the money rolled into it, its served value
// (totalServed), unused share and pool. Where the upkeep cron claimed first, what it did is
// checked from what the chain recorded instead. If the chain holds anything else
// than those show, the cycle has failed, and goes no further.

import { eventsIn } from '../contracts';
import { requireParameter } from '../parameters';
import { fmt, iso, sum } from '../report';
import { EpochNumbers, EpochReward, claimPreview, epochNumbers, grossOf, kpiNets, poolShareOf, poolsFromMoney } from '../reads';
import { planValue, requestPlan } from './config';
import { PoolCtx, complete, doneEarlier, epochStart, opensAt, runState } from './context';
import { firstBlockAt, netsFromInputs, pagedLogs, rewardClaims } from './reward-claims';
import { need } from './roles';
import type { ServedState, SetupState } from './state';

const SCALE18 = 10n ** 18n;
const BPS = 10_000n;

/** A group counted, as its ReceiptsLanded event says, and what it added to R and to the score. */
type Count = { subscriptionId: string; budgetIndex: bigint; seller: bigint; value: bigint; counted: bigint; servedValue: bigint; weightedValue: bigint; tx: string; block: number };

/** Every group counted in a subscription of E, of any seller on any subscription, from the first block of E on. */
async function countsIn(ctx: PoolCtx, s: SetupState): Promise<Count[]> {
  const { qs, sss } = ctx.c;
  const { provider } = ctx.hre.ethers;
  const staked = await ctx.tx.receipt(s.steps['setup.stake'].hash);
  const from = await firstBlockAt(provider, await epochStart(ctx, s.E), staked.blockNumber);
  const logs = await pagedLogs(provider, { address: await qs.getAddress(), topics: [qs.getEvent('ReceiptsLanded').fragment.topicHash] }, from);
  const discounts = new Map<string, bigint | undefined>();
  const out: Count[] = [];
  for (const l of logs) {
    const { args } = qs.interface.parseLog({ topics: [...l.topics], data: l.data }) ?? {};
    if (!args) throw new Error(`transaction ${l.transactionHash}: a ReceiptsLanded log that does not parse`);
    const id = String(args.subscriptionId);
    if (!discounts.has(id)) {
      const subscription = await sss.getSubscription(id);
      discounts.set(id, subscription.epoch === s.E ? subscription.discountBps : undefined);
    }
    const discount = discounts.get(id);
    if (discount === undefined) continue;
    const servedValue = (BigInt(args.counted) * (BPS - discount)) / BPS;
    out.push({
      subscriptionId: id,
      budgetIndex: BigInt(args.budgetIndex),
      seller: BigInt(args.seller),
      value: BigInt(args.value),
      counted: BigInt(args.counted),
      servedValue,
      weightedValue: (servedValue * BigInt(args.stakeFactor18)) / SCALE18,
      tx: l.transactionHash,
      block: l.blockNumber,
    });
  }
  return out;
}

/**
 * The run's own groups, whole, by their events; each of its budgets' fill; and the node's
 * and the epoch's sums, which others' value also goes into, exactly against all that was
 * counted in E: other value cannot make up for a group of ours counted at too little, nor a
 * sum hold what no batch shows. False if any of them fails.
 */
async function checkCounts(ctx: PoolCtx, s: ServedState): Promise<boolean> {
  const { report, c } = ctx;
  const { E } = s;
  const counts = await countsIn(ctx, s);
  const plan = requestPlan(s.amounts);
  const on = (id: string): Count[] => counts.filter((x) => x.subscriptionId.toLowerCase() === id.toLowerCase() && x.seller === s.sellerId && x.budgetIndex === 0n);
  const counted = (xs: Count[]): bigint => sum(xs.map((x) => x.counted));
  const valueOf = (xs: Count[]): bigint => sum(xs.map((x) => x.value));
  let ok = true;
  for (const [what, id, want] of [
    ['account', s.subscriptions.ca, planValue(plan.caFirst) + planValue(plan.caAfterTopUp)],
    ['wallet', s.subscriptions.wallet, planValue(plan.wallet)],
  ] as const) {
    const ours = on(id);
    const filled = await c.qis.budgetUsed(id, 0);
    const held = report.check(
      `the ${what} budget counted all the seller claimed on it, by its ReceiptsLanded events, and reads filled by as much`,
      valueOf(ours) === want && counted(ours) === want && filled === want,
      `${fmt(counted(ours))} of ${fmt(valueOf(ours))} TRAC claimed, in ${ours.length} group${ours.length === 1 ? '' : 's'}, ${fmt(want)} planned; filled ${fmt(filled)} TRAC`,
    );
    ok = held && ok;
  }
  const ofSeller = counts.filter((x) => x.seller === s.sellerId);
  const served = (xs: Count[]): bigint => sum(xs.map((x) => x.servedValue));
  const weighted = (xs: Count[]): bigint => sum(xs.map((x) => x.weightedValue));
  const node = await c.qis.getNodeEpoch(s.sellerId, E);
  const totals = await c.qis.getEpochTotals(E);
  const nodeHolds = report.check(
    `node ${s.sellerId}'s R and score in epoch ${E} are what its counted groups add up to`,
    node.servedValue === served(ofSeller) && node.weightedValue === weighted(ofSeller),
    `R ${fmt(node.servedValue)} TRAC, ${ofSeller.length} group${ofSeller.length === 1 ? '' : 's'} of ${fmt(served(ofSeller))} TRAC; score ${node.weightedValue} of ${weighted(ofSeller)}`,
  );
  const totalsHold = report.check(
    `epoch ${E}'s ΣR and ΣQueryInferenceScore are what all its counted groups add up to`,
    totals.totalServed === served(counts) && totals.totalWeighted === weighted(counts),
    `ΣR ${fmt(totals.totalServed)} TRAC, ${counts.length} group${counts.length === 1 ? '' : 's'} of ${fmt(served(counts))} TRAC; ΣQueryInferenceScore ${totals.totalWeighted} of ${weighted(counts)}`,
  );
  report.set('counts', counts);
  return ok && nodeHolds && totalsHold;
}

/**
 * What is booked in E, exactly against what every subscription of E, ours and others', was funded and
 * topped up with, by their events: others' money cannot make up for a booking of ours that fell
 * short, and the booking holds nothing no funding shows. A subscription of E can be funded from E-1,
 * and from the activation epoch at the earliest.
 */
async function checkFunding(ctx: PoolCtx, s: SetupState): Promise<boolean> {
  const { report, c } = ctx;
  const { provider } = ctx.hre.ethers;
  const { E } = s;
  const activation = await c.qis.activationEpoch();
  const staked = await ctx.tx.receipt(s.steps['setup.stake'].hash);
  const from = await firstBlockAt(provider, await epochStart(ctx, E - 1n > activation ? E - 1n : activation), staked.blockNumber);
  const logs = await pagedLogs(
    provider,
    { address: [await c.ss.getAddress(), await c.ssw.getAddress()], topics: [[c.ss.getEvent('SubscriptionFunded').fragment.topicHash, c.ss.getEvent('SubscriptionToppedUp').fragment.topicHash]] },
    from,
  );
  const funded = { wallet: 0n, account: 0n };
  let count = 0;
  for (const l of logs) {
    const parsed = c.ss.interface.parseLog({ topics: [...l.topics], data: l.data });
    if (!parsed) throw new Error(`transaction ${l.transactionHash}: a funding log that does not parse`);
    const { subscriptionId, accountId, cost } = parsed.args;
    if ((await c.sss.getSubscription(subscriptionId)).epoch !== E) continue;
    count++;
    if (BigInt(accountId) === 0n) funded.wallet += BigInt(cost);
    else funded.account += BigInt(cost);
  }
  const booked = await c.qis.fundingIn(E);
  report.set('funded', { ...funded, events: count });
  return report.check(
    `what is booked in epoch ${E} is exactly what the subscriptions of epoch ${E} were funded and topped up with`,
    booked.wallet === funded.wallet && booked.account === funded.account,
    `wallet ${fmt(booked.wallet)} of ${fmt(funded.wallet)} TRAC, account ${fmt(booked.account)} of ${fmt(funded.account)} TRAC, by ${count} events`,
  );
}

/**
 * Every ended epoch's pool, from activation, against the rollover rule, worked out from what
 * the pool is read from: the money funded for each epoch and the value counted in it. Nothing
 * writes any of them once an epoch has ended. A difference fails the phase, and names the first
 * epoch that differs.
 */
async function checkPools(ctx: PoolCtx): Promise<EpochNumbers[] | undefined> {
  const { report, c } = ctx;
  const activation = await c.qis.activationEpoch();
  const last = (await c.chronos.getCurrentEpoch()) - 1n;
  const epochs: EpochNumbers[] = [];
  for (let x = activation; x <= last; x++) epochs.push(await epochNumbers(c, x));
  const { pools, waiting } = poolsFromMoney(epochs);
  const at = epochs.findIndex((x, i) => x.pool !== pools[i]);
  const differs = at < 0 ? undefined : `epoch ${epochs[at].epoch} pools ${fmt(epochs[at].pool)} TRAC, and the rule gives ${fmt(pools[at])} TRAC`;
  report.check(
    `every ended epoch from ${activation} through ${last} pools what the rollover rule gives from the money funded and the value counted`,
    !differs,
    differs ?? `${fmt(waiting)} TRAC waiting for the next epoch with value`,
  );
  if (differs) {
    report.fail(`${differs}, so this cycle goes no further: start a new run`);
    return undefined;
  }
  return epochs;
}

export async function phaseClaim(ctx: PoolCtx): Promise<void> {
  const { report, c, file } = ctx;
  const r = need(ctx.roles, ['owner', 'ownerAddr']);
  const s = await runState(ctx, 'serve');
  if (doneEarlier(ctx, '')) return;
  const { E, tokenId } = s;
  if (!(await opensAt(ctx, (await epochStart(ctx, E + 1n)) + 60n, `the claim of epoch ${E}, once it has ended`))) return;
  const current = await c.chronos.getCurrentEpoch();
  report.say(`\nClaim in epoch ${current}, ${ctx.env.send ? 'sending' : 'dry run'}:`);

  const countsHold = await checkCounts(ctx, s);
  const fundingHolds = await checkFunding(ctx, s);
  if (!countsHold || !fundingHolds) {
    report.fail('what the chain holds of this cycle is not what its batches and fundings show, so it goes no further: run again if an endpoint may have served incomplete logs, or start a new run');
    return;
  }

  // StakingKPI's nets before the claim, which the claim's split is held to.
  const windowStart = s.stakeEpoch;
  const pre = await kpiNets(c, s.sellerId, windowStart, current - 1n);
  report.set('preview', { nets: [...pre.nets.entries()], splitBefore: [...pre.split.entries()] });
  report.note(`StakingKPI's net of node ${s.sellerId} in epoch ${E}, before any claim of ours: ${fmt(pre.nets.get(E) ?? 0n)} TRAC`);

  // 1. The pools of every ended epoch, and the numbers of E: read as they are, with nothing run first.
  const epochs = await checkPools(ctx);
  if (!epochs) return;
  const row = epochs.find((x) => x.epoch === E);
  if (!row) throw new Error(`epoch ${E} is not among the epochs from activation`);
  const rolledIn = row.totalServed > 0n ? row.pool - row.money : 0n;
  const unused = row.pool > row.totalServed ? row.pool - row.totalServed : 0n;
  report.set('epoch', { ...row, rolledIn, served: row.totalServed, unused });
  report.say(`\n  Epoch ${E} has ended: money ${fmt(row.money)} TRAC (wallet ${fmt(row.walletFunding)} + account ${fmt(row.accountFunding)}) + rolled in ${fmt(rolledIn)},`);
  report.say(`  served (ΣR) ${fmt(row.totalServed)}, unused ${fmt(unused)}, pool ${fmt(row.pool)} TRAC; λ ${row.lambdaBps} bps, ΣQueryInferenceScore ${fmt(row.totalWeighted)}`);
  const ours = { wallet: s.amounts.walletValue, account: sum([s.costs.ca, s.costs.topUp, s.costs.edge]) };
  report.check(
    `the money includes ours: ${fmt(ours.wallet)} TRAC of wallet value and ${fmt(ours.account)} TRAC of account cost`,
    row.walletFunding >= ours.wallet && row.accountFunding >= ours.account,
    row.walletFunding === ours.wallet && row.accountFunding === ours.account ? 'ours alone' : 'others funded subscriptions too',
  );
  report.check('value counted, so the pool is the whole money, the unused share included', row.totalServed > 0n && row.pool === row.money + rolledIn);
  const lambda = requireParameter('QueryInferenceStorage', ['lambdaBps']);
  report.check(`epoch ${E} took λ ${lambda.value} bps when its first value counted`, row.lambdaBps === lambda.value);
  const gross = await c.qs.queryInferenceGross(E, s.sellerId);
  report.set('sellerGross', gross);
  const expectGross = grossOf(row.pool, row.lambdaBps, await c.qis.getNodeEpoch(s.sellerId, E), row);
  report.check(`node ${s.sellerId}'s gross from the pool of epoch ${E} is the formula's, and within the pool`, gross === expectGross && gross <= row.pool, `${fmt(gross)} TRAC`);

  // 2. claimFor on our position, against the epochs' nets as what no claim writes gives them:
  //    StakingKPI's are those of the first claim of each epoch, any position's. Claims made
  //    before it, by another caller (the upkeep cron) or by this phase before it was
  //    interrupted, are checked first, from the claims the chain recorded.
  const inputs = await netsFromInputs(c, s.sellerId, windowStart, current - 1n);
  const claimStep = {
    key: 'claim.claim',
    label: `owner: StakingV10.claimFor(${tokenId})`,
    role: 'owner',
    signer: r.owner,
    to: await c.sv10.getAddress(),
    data: c.sv10.interface.encodeFunctionData('claimFor', [tokenId]),
  };
  const journaled = file.get(claimStep.key);
  if (journaled) await ctx.tx.step(claimStep);
  const pos = await c.css.getPosition(tokenId);
  const per: EpochReward[] = [];
  let claimed = false;
  let claimedNow = false;
  if (pos.lastClaimedEpoch >= windowStart) {
    const staked = await ctx.tx.receipt(s.steps['setup.stake'].hash);
    const by = await rewardClaims(ctx.hre.ethers.provider, c, { tokenId, node: s.sellerId, stakeRaw: s.stakeRaw, firstEpoch: windowStart, fromBlock: staked.blockNumber });
    const windows = by.claims.map((x) => (x.from === x.to ? `${x.from}` : `${x.from}..${x.to}`)).join(', ');
    report.check(
      `the position was claimed for epochs ${windowStart}..${pos.lastClaimedEpoch} by ${by.claims.every((x) => x.tx === journaled?.hash) ? 'this phase before it was interrupted' : 'another caller (the upkeep cron)'}: what each claim paid is the position's share of the epochs' nets`,
      by.through === pos.lastClaimedEpoch && by.total === pos.cumulativeRewardsClaimed && by.claims.every((x) => x.paid === x.previewed),
      `paid ${fmt(by.total)} TRAC of ${fmt(pos.cumulativeRewardsClaimed)} in ${by.claims.length} claim${by.claims.length > 1 ? 's' : ''}, of epochs ${windows}, through ${by.through}`,
    );
    report.check('what they paid compounded into the position\'s raw stake', pos.raw === s.stakeRaw + by.total, `raw ${fmt(pos.raw)} TRAC; staked ${fmt(s.stakeRaw)} + paid ${fmt(by.total)} TRAC`);
    per.push(...by.per);
    report.set('claimsByOthers', by);
    claimed = true;
  }
  if (pos.lastClaimedEpoch < current - 1n && !journaled) {
    const expect = await claimPreview(c, tokenId, s.sellerId, pos.lastClaimedEpoch + 1n, current - 1n, pos.raw, inputs);
    // The epochs the claim pays, as the preview gives them: what a dry run shows, and what the send checks.
    per.push(...expect.per);
    claimed = true;
    const res = await ctx.tx.step(claimStep);
    if (res.receipt) {
      claimedNow = true;
      const paid = eventsIn(res.receipt, c.sv10, c.sv10.getEvent('RewardsClaimed')).find((x) => x.tokenId === tokenId)?.amount ?? 0n;
      const after = await c.css.getPosition(tokenId);
      report.set('claim', { ...expect, paid, from: pos.lastClaimedEpoch + 1n, to: current - 1n });
      report.check(
        `claimFor pays what the epochs' nets give for epochs ${pos.lastClaimedEpoch + 1n}..${current - 1n}`,
        paid === expect.total && after.raw - pos.raw === paid && after.lastClaimedEpoch === current - 1n,
        `paid ${fmt(paid)} TRAC, the nets give ${fmt(expect.total)} TRAC`,
      );
    }
  }
  if (claimed) {
    for (const p of per.filter((x) => x.scored)) {
      report.note(`epoch ${p.epoch}: position score ${p.score} of node score ${p.nodeScore}, net ${fmt(p.net)} TRAC, reward ${fmt(p.reward)} TRAC`);
    }
    const nets = await kpiNets(c, s.sellerId, windowStart, current - 1n);
    // Only a claim sent after the first read can differ from it.
    if (claimedNow) report.check('every epoch the claim split holds the net StakingKPI gave before it', [...pre.nets.entries()].every(([e, net]) => !nets.split.get(e) || nets.nets.get(e) === net));
    const differing = [...inputs].filter(([e, net]) => nets.nets.get(e) !== net);
    report.check(
      'StakingKPI gives each epoch the net its publishing share, query/inference gross and operator fee give',
      differing.length === 0,
      differing.map(([e, net]) => `epoch ${e}: ${fmt(nets.nets.get(e) ?? 0n)} TRAC, those give ${fmt(net)} TRAC`).join('; ') || undefined,
    );
    const pe = per.find((x) => x.epoch === E && x.scored);
    if (pe) {
      const share = await poolShareOf(c, s.sellerId, E, pe.score, pe.net);
      report.set('poolShare', share);
      report.say(
        `\n  Our position in epoch ${E}: ${fmt(share.rewardWithPool)} TRAC, of which ${fmt(share.poolShare)} TRAC is its share of the pool ` +
          `(node net ${fmt(share.netWithPool)} TRAC with the pool, ${fmt(share.netWithoutPool)} without; operator fee ${share.feeBps} bps)`,
      );
      report.check(`the position is paid a share of epoch ${E}'s pool, from node ${s.sellerId}'s gross of ${fmt(gross)} TRAC`, gross > 0n && share.poolShare > 0n, `${fmt(share.poolShare)} TRAC`);
    } else {
      report.check(`the position holds score in epoch ${E}`, false, 'no proof of the seller reached it after the stake');
    }
  }
  complete(ctx);
  if (ctx.env.send) report.say(`\nNext, optional: PHASE=withdraw SEND=1 in the middle of an epoch, then again once that epoch has ended (from ${iso(await epochStart(ctx, current + 1n))}).`);
}
