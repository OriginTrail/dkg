// PHASE close-claim, as soon as E+1 has ended: closeEpochs, then claimFor on
// our position against the epochs' nets, and from E+1's close its money
// (walletDue + convictionDue + carryIn), served value (sumR), unused share and
// pool. Where the upkeep cron closed or claimed first, what it did is checked
// from storage instead. Both of the run's claims must be finalized first, by the
// run or by the upkeep cron, at what they were due, the money due in E+1 must be
// exactly what the periods of E were funded with, and every close so far what the close
// rule gives: otherwise the cycle has failed, and goes no further.

import { eventsIn } from '../contracts';
import { requireParameter } from '../parameters';
import { fmt, iso, min, sum } from '../report';
import { EpochCloseNumbers, EpochReward, claimPreview, closeFromStorage, closeRule, kpiNets, poolShareOf } from '../reads';
import { PoolCtx, complete, doneEarlier, epochStart, opensAt, runState } from './context';
import { firstBlockAt, netsFromInputs, pagedLogs, rewardClaims } from './reward-claims';
import { checkFinalizations, finalizedValue, names, unfinalizedClaims } from './finalize';
import { need } from './roles';
import type { SetupState } from './state';

/**
 * What is due in the epoch after E, exactly against what every period of E, ours and others',
 * was funded and topped up with, by their events: others' money cannot make up for a booking
 * of ours that fell short, and the due holds nothing no funding shows. A period of E can be
 * funded from E-1, and from the activation epoch at the earliest.
 */
async function checkDue(ctx: PoolCtx, s: SetupState): Promise<boolean> {
  const { report, c } = ctx;
  const { provider } = ctx.hre.ethers;
  const { E } = s;
  const activation = await c.qis.activationEpoch();
  const staked = await ctx.tx.receipt(s.steps['setup.stake'].hash);
  const from = await firstBlockAt(provider, await epochStart(ctx, E - 1n > activation ? E - 1n : activation), staked.blockNumber);
  const logs = await pagedLogs(
    provider,
    { address: [await c.ss.getAddress(), await c.ssw.getAddress()], topics: [[c.ss.getEvent('PeriodFunded').fragment.topicHash, c.ss.getEvent('PeriodToppedUp').fragment.topicHash]] },
    from,
  );
  const funded = { wallet: 0n, conviction: 0n };
  let count = 0;
  for (const l of logs) {
    const parsed = c.ss.interface.parseLog({ topics: [...l.topics], data: l.data });
    if (!parsed) throw new Error(`transaction ${l.transactionHash}: a funding log that does not parse`);
    const { subscriptionId, accountId, cost } = parsed.args;
    if ((await c.cssvc.getSubscription(subscriptionId)).epoch !== E) continue;
    count++;
    if (BigInt(accountId) === 0n) funded.wallet += BigInt(cost);
    else funded.conviction += BigInt(cost);
  }
  const due = await c.qis.dueIn(E + 1n);
  report.set('funded', { ...funded, events: count });
  return report.check(
    `what is due in epoch ${E + 1n} is exactly what the periods of epoch ${E} were funded and topped up with`,
    due.wallet === funded.wallet && due.conviction === funded.conviction,
    `wallet ${fmt(due.wallet)} of ${fmt(funded.wallet)} TRAC, account ${fmt(due.conviction)} of ${fmt(funded.conviction)} TRAC, by ${count} events`,
  );
}

/**
 * Every close so far, and the carry they leave, against the close rule from activation, worked
 * out from what no close writes: the money due in each epoch and the value finalized in it.
 * All of it as of one block, as others can close meanwhile. A difference fails the phase, and
 * names the first epoch that differs.
 */
async function checkCloses(ctx: PoolCtx): Promise<boolean> {
  const { report, c } = ctx;
  const at = { blockTag: await ctx.hre.ethers.provider.getBlockNumber() };
  const activation = await c.qis.activationEpoch(at);
  const closedThrough = await c.qis.closedThrough(at);
  let carry = 0n;
  let differs: string | undefined;
  for (let x = activation; x <= closedThrough && !differs; x++) {
    const due = await c.qis.dueIn(x, at);
    const { sumR } = await c.qis.getEpochTotals(x, at);
    const { pool, carryOut } = closeRule(due.wallet + due.conviction + carry, sumR);
    const stored = await c.qis.getEpochClose(x, at);
    if (!stored.closed || stored.pool !== pool) differs = `epoch ${x}${stored.closed ? '' : ', not closed,'} pools ${fmt(stored.pool)} TRAC, and the rule gives ${fmt(pool)} TRAC`;
    carry = carryOut;
  }
  const carried = await c.qis.carry(at);
  if (!differs && carried !== carry) differs = `the carry after epoch ${closedThrough} is ${fmt(carried)} TRAC, and the rule gives ${fmt(carry)} TRAC`;
  const held = report.check(
    closedThrough < activation
      ? 'with no epoch closed yet, nothing is carried'
      : `every close from epoch ${activation} through ${closedThrough}, and the carry they leave, are what the close rule gives from the money due and the value finalized`,
    !differs,
    differs ?? `carry ${fmt(carried)} TRAC`,
  );
  if (differs) report.fail(`${differs}, so this cycle goes no further: start a new run`);
  return held;
}

export async function phaseCloseClaim(ctx: PoolCtx): Promise<void> {
  const { report, c, file } = ctx;
  const r = need(ctx.roles, ['owner', 'ownerAddr']);
  const s = await runState(ctx, 'serve');
  if (doneEarlier(ctx, '')) return;
  const failed = file.failedChecks('finalize');
  if (failed) throw new Error(`PHASE=finalize ended with ${failed} failed check${failed > 1 ? 's' : ''}: run it again first, which sends nothing it sent already`);
  const { E, tokenId } = s;
  const P = E + 1n; // the pool epoch: the periods of E are due in it
  if (!(await opensAt(ctx, (await epochStart(ctx, E + 2n)) + 60n, `the close of epoch ${P}, once it has ended`))) return;
  const current = await c.chronos.getCurrentEpoch();
  report.say(`\nClose and claim in epoch ${current}, ${ctx.env.send ? 'sending' : 'dry run'}:`);

  // E+1 has ended, so a claim not finalized by now never will be.
  const unfinalized = await unfinalizedClaims(ctx, s);
  if (!report.check('both of the run\'s claims are finalized, by the run or by another caller', unfinalized.length === 0, unfinalized.length ? `the ${names(unfinalized)} claim is not, and epoch ${P} has ended: it is void` : undefined)) {
    report.fail(`the ${names(unfinalized)} claim is void, so this run cannot go on: start a new run`);
    return;
  }
  if (!file.done('finalize')) report.note('PHASE=finalize has not completed here: another caller (the upkeep cron) finalized the claims');
  const finalizationsHold = await checkFinalizations(ctx, s);
  const dueHolds = await checkDue(ctx, s);
  if (!finalizationsHold || !dueHolds) {
    report.fail('what the chain holds of this cycle is not what its finalizations and fundings show, so it goes no further: run again if an endpoint may have served incomplete logs, or start a new run');
    return;
  }

  // The previews, before any close: the pool, the seller's gross, StakingKPI's nets.
  const windowStart = s.stakeEpoch;
  const [previewPool] = await c.qs.previewEpochClose(P);
  const previewGross = await c.qs.previewQueryInferenceGross(P, s.sellerId);
  const pre = await kpiNets(c, s.sellerId, windowStart, current - 1n);
  report.set('preview', { pool: previewPool, sellerGross: previewGross, nets: [...pre.nets.entries()], splitBefore: [...pre.split.entries()] });
  report.note(`preview of epoch ${P}'s close: pool ${fmt(previewPool)} TRAC, node ${s.sellerId}'s gross ${fmt(previewGross)} TRAC, StakingKPI net ${fmt(pre.nets.get(P) ?? 0n)} TRAC`);

  // 1. closeEpochs, unless another caller closed the epoch already. What is closed by now is held to the rule first.
  if (!(await checkCloses(ctx))) return;
  const closedThrough = await c.qis.closedThrough();
  let close: (EpochCloseNumbers & { from: string }) | undefined;
  if (closedThrough < P) {
    const steps = min(current - 1n - closedThrough, 64n);
    const qs = await c.qs.getAddress();
    const data = c.qs.interface.encodeFunctionData('closeEpochs', [steps]);
    const [through] = c.qs.interface.decodeFunctionResult('closeEpochs', await ctx.tx.call(r.ownerAddr, qs, data));
    report.check(`closeEpochs(${steps}) would close through epoch ${current - 1n}`, BigInt(through) === current - 1n, `closes through ${through}`);
    const res = await ctx.tx.step({ key: 'close-claim.close-epochs', label: `owner: closeEpochs(${steps})`, role: 'owner', signer: r.owner, to: qs, data });
    const ev = eventsIn(res.receipt, c.qs, c.qs.getEvent('EpochClosed')).find((x) => x.epoch === P);
    if (res.receipt) {
      report.check(`the close emitted EpochClosed for epoch ${P}`, !!ev);
      if (!(await checkCloses(ctx))) return;
    }
    // An event's Result exposes its fields by name, not as own properties: copied one by one.
    if (ev) {
      close = {
        epoch: ev.epoch,
        walletDue: ev.walletDue,
        convictionDue: ev.convictionDue,
        carryIn: ev.carryIn,
        pool: ev.pool,
        sumR: ev.sumR,
        sumScore: ev.sumScore,
        lambdaBps: ev.lambdaBps,
        closed: true,
        from: 'EpochClosed',
      };
    }
  } else {
    report.note(`=     epoch ${P} is closed already, by ${file.get('close-claim.close-epochs') ? 'this phase before it was interrupted' : 'another caller'} (closed through ${closedThrough}): its numbers come from storage`);
    close = { ...(await closeFromStorage(c, P)), from: 'storage' };
  }
  if (close) {
    // Read from storage, the close has nothing else to be compared with here: the rule above holds it, and the money below.
    const fromEvent = close.from === 'EpochClosed';
    if (fromEvent) {
      const stored = await closeFromStorage(c, P);
      report.check(
        `epoch ${P}'s close as storage keeps it matches its EpochClosed`,
        stored.closed && stored.pool === close.pool && stored.walletDue === close.walletDue && stored.convictionDue === close.convictionDue && stored.sumR === close.sumR && stored.carryIn === close.carryIn,
      );
    }
    const money = close.walletDue + close.convictionDue + close.carryIn;
    const unused = money - close.sumR;
    report.set('epochClosed', { ...close, money, served: close.sumR, unused });
    report.say(`\n  Epoch ${P} closed: money ${fmt(money)} TRAC (wallet due ${fmt(close.walletDue)} + account due ${fmt(close.convictionDue)} + carry in ${fmt(close.carryIn)}),`);
    report.say(`  served (ΣR) ${fmt(close.sumR)}, unused ${fmt(unused)}, pool ${fmt(close.pool)} TRAC; λ ${close.lambdaBps} bps, ΣQueryInferenceScore ${fmt(close.sumScore)}`);
    const ours = { wallet: s.amounts.walletValue, conviction: sum([s.costs.ca, s.costs.topUp, s.costs.edge]) };
    if (fromEvent) report.check('the close pools what the preview said', close.pool === previewPool, `${fmt(close.pool)} TRAC`);
    report.check(
      close.sumR > 0n ? 'value was served, so the pool is the whole money, the unused share included' : 'no value was served, so the money carries on',
      close.sumR > 0n ? close.pool === money : close.pool === 0n,
    );
    report.check(
      `the money includes ours: ${fmt(ours.wallet)} TRAC of wallet value and ${fmt(ours.conviction)} TRAC of account cost`,
      close.walletDue >= ours.wallet && close.convictionDue >= ours.conviction,
      close.walletDue === ours.wallet && close.convictionDue === ours.conviction ? 'ours alone, beside the carry' : 'others funded periods too',
    );
    const finalized = await finalizedValue(ctx, s);
    if (finalized > 0n) report.check(`served includes our finalized ${fmt(finalized)} TRAC`, close.sumR >= finalized);
    const lambda = requireParameter('QueryInferenceStorage', ['latestLambdaBps', 'lambdaBps']);
    report.check(`λ in force in epoch ${P} is ${lambda.value} bps`, close.lambdaBps === lambda.value);
    const gross = await c.qs.queryInferenceGross(P, s.sellerId);
    report.set('sellerGross', gross);
    report.check(
      `node ${s.sellerId}'s gross from the pool of epoch ${P} is ${fromEvent ? 'what the preview said, and ' : ''}within the pool`,
      (!fromEvent || gross === previewGross) && gross <= close.pool,
      `${fmt(gross)} TRAC`,
    );
  }

  // 2. claimFor on our position, against the epochs' nets as what no claim writes gives them:
  //    StakingKPI's are those of the first claim of each epoch, any position's. Claims made
  //    before it, by another caller (the upkeep cron) or by this phase before it was
  //    interrupted, are checked first, from the claims the chain recorded.
  const inputs = await netsFromInputs(c, s.sellerId, windowStart, current - 1n);
  const claimStep = {
    key: 'close-claim.claim',
    label: `owner: StakingV10.claimFor(${tokenId})`,
    role: 'owner',
    signer: r.owner,
    to: await c.sv10.getAddress(),
    data: c.sv10.interface.encodeFunctionData('claimFor', [tokenId]),
  };
  const ours = file.get(claimStep.key);
  if (ours) await ctx.tx.step(claimStep);
  const pos = await c.css.getPosition(tokenId);
  const per: EpochReward[] = [];
  let claimed = false;
  let claimedNow = false;
  if (pos.lastClaimedEpoch >= windowStart) {
    const staked = await ctx.tx.receipt(s.steps['setup.stake'].hash);
    const by = await rewardClaims(ctx.hre.ethers.provider, c, { tokenId, node: s.sellerId, stakeRaw: s.stakeRaw, firstEpoch: windowStart, fromBlock: staked.blockNumber });
    const windows = by.claims.map((x) => (x.from === x.to ? `${x.from}` : `${x.from}..${x.to}`)).join(', ');
    report.check(
      `the position was claimed for epochs ${windowStart}..${pos.lastClaimedEpoch} by ${by.claims.every((x) => x.tx === ours?.hash) ? 'this phase before it was interrupted' : 'another caller (the upkeep cron)'}: what each claim paid is the position's share of the epochs' nets`,
      by.through === pos.lastClaimedEpoch && by.total === pos.cumulativeRewardsClaimed && by.claims.every((x) => x.paid === x.previewed),
      `paid ${fmt(by.total)} TRAC of ${fmt(pos.cumulativeRewardsClaimed)} in ${by.claims.length} claim${by.claims.length > 1 ? 's' : ''}, of epochs ${windows}, through ${by.through}`,
    );
    report.check('what they paid compounded into the position\'s raw stake', pos.raw === s.stakeRaw + by.total, `raw ${fmt(pos.raw)} TRAC; staked ${fmt(s.stakeRaw)} + paid ${fmt(by.total)} TRAC`);
    per.push(...by.per);
    report.set('claimsByOthers', by);
    claimed = true;
  }
  if (pos.lastClaimedEpoch < current - 1n && !ours) {
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
    // Only a claim sent after the previews can differ from them.
    if (claimedNow) report.check('every epoch the claim split holds the net StakingKPI previewed', [...pre.nets.entries()].every(([e, net]) => !nets.split.get(e) || nets.nets.get(e) === net));
    const differing = [...inputs].filter(([e, net]) => nets.nets.get(e) !== net);
    report.check(
      'StakingKPI gives each epoch the net its publishing share, query/inference gross and operator fee give',
      differing.length === 0,
      differing.map(([e, net]) => `epoch ${e}: ${fmt(nets.nets.get(e) ?? 0n)} TRAC, those give ${fmt(net)} TRAC`).join('; ') || undefined,
    );
    const pe = per.find((x) => x.epoch === P && x.scored);
    if (pe) {
      const share = await poolShareOf(c, s.sellerId, P, pe.score, pe.net);
      // Previewed while the epoch is open, as in a dry run; the frozen gross once it has closed.
      const gross = await c.qs.previewQueryInferenceGross(P, s.sellerId);
      report.set('poolShare', share);
      report.say(
        `\n  Our position in epoch ${P}: ${fmt(share.rewardWithPool)} TRAC, of which ${fmt(share.poolShare)} TRAC is its share of the pool ` +
          `(node net ${fmt(share.netWithPool)} TRAC with the pool, ${fmt(share.netWithoutPool)} without; operator fee ${share.feeBps} bps)`,
      );
      report.check(`the position is paid a share of epoch ${P}'s pool, from node ${s.sellerId}'s gross of ${fmt(gross)} TRAC`, gross > 0n && share.poolShare > 0n, `${fmt(share.poolShare)} TRAC`);
    } else {
      report.check(`the position holds score in epoch ${P}`, false, 'no proof of the seller reached it after the stake');
    }
  }
  complete(ctx);
  if (ctx.env.send) report.say(`\nNext, optional: PHASE=withdraw SEND=1 in the middle of an epoch, then again once that epoch has ended (from ${iso(await epochStart(ctx, current + 1n))}).`);
}
