// PHASE close-claim, as soon as E+1 has ended: closeEpochs, then claimFor on
// our position against StakingKPI's preview, and from E+1's close its money
// (walletDue + convictionDue + carryIn), served value (sumR), unused share and
// pool. Where the upkeep cron closed or claimed first, what it did is checked
// from storage instead.

import { eventsIn } from '../contracts';
import { requireParameter } from '../parameters';
import { fmt, iso, min, sum } from '../report';
import { EpochCloseNumbers, EpochReward, claimPreview, closeFromStorage, kpiNets, poolShareOf } from '../reads';
import { PoolCtx, complete, doneEarlier, epochStart, opensAt, runState } from './context';
import { rewardClaims } from './reward-claims';
import { need } from './roles';

export async function phaseCloseClaim(ctx: PoolCtx): Promise<void> {
  const { report, c } = ctx;
  const r = need(ctx.roles, ['owner', 'ownerAddr']);
  const s = await runState(ctx, 'serve');
  if (!ctx.file.done('finalize')) report.note('finalize has not completed: the epoch closes with whatever was finalized');
  if (doneEarlier(ctx, '')) return;
  const E = s.E ?? 0n;
  const P = E + 1n; // the pool epoch: the periods of E are due in it
  if (s.tokenId === undefined || s.stakeRaw === undefined) throw new Error('the state holds no position');
  const tokenId = s.tokenId;
  if (!(await opensAt(ctx, (await epochStart(ctx, E + 2n)) + 60n, `the close of epoch ${P}, once it has ended`))) return;
  const current = await c.chronos.getCurrentEpoch();
  report.say(`\nClose and claim in epoch ${current}, ${ctx.env.send ? 'sending' : 'dry run'}:`);

  // The previews, before any close: the pool, the seller's gross, StakingKPI's nets.
  const windowStart = s.stakeEpoch ?? E;
  const [previewPool] = await c.qs.previewEpochClose(P);
  const previewGross = await c.qs.previewQueryInferenceGross(P, s.sellerId);
  const pre = await kpiNets(c, s.sellerId, windowStart, current - 1n);
  report.set('preview', { pool: previewPool, sellerGross: previewGross, nets: [...pre.nets.entries()], splitBefore: [...pre.split.entries()] });
  report.note(`preview of epoch ${P}'s close: pool ${fmt(previewPool)} TRAC, node ${s.sellerId}'s gross ${fmt(previewGross)} TRAC, StakingKPI net ${fmt(pre.nets.get(P) ?? 0n)} TRAC`);

  // 1. closeEpochs, unless another caller closed the epoch already.
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
    if (res.receipt) report.check(`the close emitted EpochClosed for epoch ${P}`, !!ev);
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
    report.note(`=     epoch ${P} is closed already, by another caller (closed through ${closedThrough}): its numbers come from storage`);
    close = { ...(await closeFromStorage(c, P)), from: 'storage' };
  }
  if (close) {
    const stored = await closeFromStorage(c, P);
    report.check(
      `epoch ${P}'s close as storage keeps it matches ${close.from === 'EpochClosed' ? 'its EpochClosed' : 'the chain of closes from activation'}`,
      stored.closed && stored.pool === close.pool && stored.walletDue === close.walletDue && stored.convictionDue === close.convictionDue && stored.sumR === close.sumR && stored.carryIn === close.carryIn,
    );
    const money = close.walletDue + close.convictionDue + close.carryIn;
    const unused = money - close.sumR;
    report.set('epochClosed', { ...close, money, served: close.sumR, unused });
    report.say(`\n  Epoch ${P} closed: money ${fmt(money)} TRAC (wallet due ${fmt(close.walletDue)} + account due ${fmt(close.convictionDue)} + carry in ${fmt(close.carryIn)}),`);
    report.say(`  served (ΣR) ${fmt(close.sumR)}, unused ${fmt(unused)}, pool ${fmt(close.pool)} TRAC; λ ${close.lambdaBps} bps, ΣQueryInferenceScore ${fmt(close.sumScore)}`);
    const ours = { wallet: s.amounts.walletValue, conviction: sum([s.costs.ca ?? 0n, s.costs.topUp ?? 0n, s.costs.edge ?? 0n]) };
    report.check('the close pools what the preview said', close.pool === previewPool, `${fmt(close.pool)} TRAC`);
    report.check(
      close.sumR > 0n ? 'value was served, so the pool is the whole money, the unused share included' : 'no value was served, so the money carries on',
      close.sumR > 0n ? close.pool === money : close.pool === 0n,
    );
    report.check(
      `the money includes ours: ${fmt(ours.wallet)} TRAC of wallet value and ${fmt(ours.conviction)} TRAC of account cost`,
      close.walletDue >= ours.wallet && close.convictionDue >= ours.conviction,
      close.walletDue === ours.wallet && close.convictionDue === ours.conviction ? 'ours alone, beside the carry' : 'others funded periods too',
    );
    if (s.finalizedValue !== undefined) report.check(`served includes our finalized ${fmt(s.finalizedValue)} TRAC`, close.sumR >= s.finalizedValue);
    const lambda = requireParameter('QueryInferenceStorage', ['latestLambdaBps', 'lambdaBps']);
    report.check(`λ in force in epoch ${P} is ${lambda.value} bps`, close.lambdaBps === lambda.value);
    const gross = await c.qs.queryInferenceGross(P, s.sellerId);
    report.set('sellerGross', gross);
    report.check(`node ${s.sellerId}'s gross from the pool of epoch ${P} is what the preview said`, gross === previewGross && gross <= close.pool, `${fmt(gross)} TRAC`);
  }

  // 2. claimFor on our position, against StakingKPI's preview. Claims another caller (the
  //    upkeep cron) made before it are checked first, from the claims the chain recorded.
  const pos = await c.css.getPosition(tokenId);
  const per: EpochReward[] = [];
  let claimed = false;
  if (pos.lastClaimedEpoch >= windowStart) {
    const staked = await ctx.tx.receipt(s.steps['setup.stake'].hash);
    const by = await rewardClaims(ctx.hre.ethers.provider, c, { tokenId, node: s.sellerId, stakeRaw: s.stakeRaw, firstEpoch: windowStart, fromBlock: staked.blockNumber });
    const windows = by.claims.map((x) => (x.from === x.to ? `${x.from}` : `${x.from}..${x.to}`)).join(', ');
    report.check(
      `the position was claimed for epochs ${windowStart}..${pos.lastClaimedEpoch} by another caller (the upkeep cron): what each claim paid is StakingKPI's preview`,
      by.through === pos.lastClaimedEpoch && by.total === pos.cumulativeRewardsClaimed && by.claims.every((x) => x.paid === x.previewed),
      `paid ${fmt(by.total)} TRAC of ${fmt(pos.cumulativeRewardsClaimed)} in ${by.claims.length} claim${by.claims.length > 1 ? 's' : ''}, of epochs ${windows}, through ${by.through}`,
    );
    per.push(...by.per);
    report.set('claimsByOthers', by);
    claimed = true;
  }
  if (pos.lastClaimedEpoch < current - 1n) {
    const expect = await claimPreview(c, tokenId, s.sellerId, pos.lastClaimedEpoch + 1n, current - 1n, pos.raw, pre.nets);
    // The epochs the claim pays, as the preview gives them: what a dry run shows, and what the send checks.
    per.push(...expect.per);
    claimed = true;
    const res = await ctx.tx.step({
      key: 'close-claim.claim',
      label: `owner: StakingV10.claimFor(${tokenId})`,
      role: 'owner',
      signer: r.owner,
      to: await c.sv10.getAddress(),
      data: c.sv10.interface.encodeFunctionData('claimFor', [tokenId]),
    });
    if (res.receipt) {
      const paid = eventsIn(res.receipt, c.sv10, c.sv10.getEvent('RewardsClaimed')).find((x) => x.tokenId === tokenId)?.amount ?? 0n;
      const after = await c.css.getPosition(tokenId);
      report.set('claim', { ...expect, paid, from: pos.lastClaimedEpoch + 1n, to: current - 1n });
      report.check(
        `claimFor pays what StakingKPI previewed for epochs ${pos.lastClaimedEpoch + 1n}..${current - 1n}`,
        paid === expect.total && after.raw - pos.raw === paid && after.lastClaimedEpoch === current - 1n,
        `paid ${fmt(paid)} TRAC, preview ${fmt(expect.total)} TRAC`,
      );
    }
  }
  if (claimed) {
    for (const p of per.filter((x) => x.scored)) {
      report.note(`epoch ${p.epoch}: position score ${p.score} of node score ${p.nodeScore}, net ${fmt(p.net)} TRAC, reward ${fmt(p.reward)} TRAC`);
    }
    const nets = await kpiNets(c, s.sellerId, windowStart, current - 1n);
    report.check('every epoch the claim split holds the net StakingKPI previewed', [...pre.nets.entries()].every(([e, net]) => !nets.split.get(e) || nets.nets.get(e) === net));
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
