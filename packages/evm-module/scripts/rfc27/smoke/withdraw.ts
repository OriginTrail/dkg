// PHASE withdraw, optional, after close-claim, in two runs: the position is
// withdrawn in the middle of an epoch, which records that epoch's share for
// the owner; once that epoch has ended, claimWithdrawnEpoch pays it, against
// the amount the views give (the position's recorded score × StakingKPI's net
// / the node's score). On testnet this adds a day to the run.

import { eventsIn } from '../contracts';
import { fmt, iso } from '../report';
import { claimPreview, delegatorKey, positionScore } from '../reads';
import { MID_EPOCH_MARGIN } from './config';
import { PoolCtx, complete, epochStart, now, opensAt, runState, standInProof } from './context';
import { need } from './roles';

export async function phaseWithdraw(ctx: PoolCtx): Promise<{ part: string }> {
  const { report, c, file } = ctx;
  const r = need(ctx.roles, ['owner', 'ownerAddr']);
  const s = await runState(ctx, 'close-claim');
  if (s.tokenId === undefined) throw new Error('the state holds no position');
  const tokenId = s.tokenId;
  const sv10 = await c.sv10.getAddress();
  const claimData = c.sv10.interface.encodeFunctionData('claimWithdrawnEpoch', [tokenId]);

  if (!s.withdrawal) {
    // 1. The withdrawal, in the middle of an epoch: not within 10 minutes of either end; on the fork, its middle.
    let current = await c.chronos.getCurrentEpoch();
    const start = await epochStart(ctx, current);
    const length = await c.chronos.epochLength();
    const t = await now(ctx);
    if (t < start + MID_EPOCH_MARGIN || t > start + length - MID_EPOCH_MARGIN) {
      const from = t < start + MID_EPOCH_MARGIN ? start : start + length;
      const target = ctx.net.local && ctx.env.warp ? from + length / 2n : from + MID_EPOCH_MARGIN;
      if (!(await opensAt(ctx, target, 'the withdrawal, in the middle of an epoch'))) return { part: 'withdraw' };
      current = await c.chronos.getCurrentEpoch();
    }
    report.say(`\nWithdraw in the middle of epoch ${current}, ${ctx.env.send ? 'sending' : 'dry run'}:`);
    if (ctx.env.send && !(s.fork?.proofs ?? []).includes(current.toString())) await standInProof(ctx, 'before the withdrawal, so the position holds score in its epoch');
    const pos = await c.css.getPosition(tokenId);
    if (pos.identityId === 0n) throw new Error(`position ${tokenId} does not exist`);
    const auto = await claimPreview(c, tokenId, s.sellerId, pos.lastClaimedEpoch + 1n, current - 1n, pos.raw);
    const score = await positionScore(c, tokenId, s.sellerId, current, pos.raw);
    const bal0 = await c.token.balanceOf(r.ownerAddr);
    const w = await ctx.tx.step({
      key: 'withdraw.withdraw',
      label: `owner: DKGStakingConvictionNFT.withdraw(${tokenId})`,
      role: 'owner',
      signer: r.owner,
      to: await c.snft.getAddress(),
      data: c.snft.interface.encodeFunctionData('withdraw', [tokenId]),
    });
    if (!w.receipt) return { part: 'withdraw' };
    const paid = eventsIn(w.receipt, c.sv10, c.sv10.getEvent('Withdrawn')).find((x) => x.tokenId === tokenId)?.amount ?? 0n;
    const rec = eventsIn(w.receipt, c.sv10, c.sv10.getEvent('WithdrawnEpochRecorded')).find((x) => x.tokenId === tokenId);
    const recorded = await c.rss.getEpochNodeDelegatorScore(current, s.sellerId, delegatorKey(tokenId));
    const bal1 = await c.token.balanceOf(r.ownerAddr);
    report.check(`the withdrawal pays the stake and every ended epoch: ${fmt(paid)} TRAC = raw ${fmt(pos.raw)} + ${fmt(auto.total)}`, paid === pos.raw + auto.total && bal1 - bal0 === paid);
    report.check(
      `it records epoch ${current} for the owner, with the score the position had earned by then`,
      !!rec && rec.epoch === current && rec.staker === r.ownerAddr && recorded > 0n && (ctx.net.local ? recorded === score : recorded >= score),
      `score ${recorded}${recorded !== score ? ` (a proof landed between the read and the withdrawal: ${score} before it)` : ''}`,
    );
    const early = await ctx.tx.refusal(r.ownerAddr, sv10, claimData);
    report.check('claimWithdrawnEpoch before that epoch ends is refused (WithdrawnEpochInProgress)', early.startsWith('WithdrawnEpochInProgress'), early);
    s.withdrawal = { epoch: current, node: s.sellerId, recordedScore: recorded, ownerTracAfter: bal1, block: w.receipt.blockNumber, claimed: false };
    file.save();
    report.say(`\nNext: PHASE=withdraw SEND=1 again from ${iso(await epochStart(ctx, current + 1n))}, once epoch ${current} has ended.`);
    return { part: 'withdraw' };
  }

  // 2. claimWithdrawnEpoch, once the withdrawal's epoch has ended.
  if (s.withdrawal.claimed) {
    report.note('the withdrawn epoch is claimed: the run is complete');
    report.status = 'done earlier';
    return { part: 'claim' };
  }
  const { epoch, node } = s.withdrawal;
  if (!(await opensAt(ctx, (await epochStart(ctx, epoch + 1n)) + 60n, `claimWithdrawnEpoch, once epoch ${epoch} has ended`))) return { part: 'claim' };
  report.say(`\nClaim the withdrawn epoch ${epoch}, ${ctx.env.send ? 'sending' : 'dry run'}:`);
  const score = await c.rss.getEpochNodeDelegatorScore(epoch, node, delegatorKey(tokenId));
  const nodeScore = await c.rss.getNodeEpochScore(epoch, node);
  const net = await c.kpi.getNetNodeRewards(node, epoch);
  const expected = nodeScore === 0n ? 0n : (score * net) / nodeScore;
  report.note(`expected: score ${score} × StakingKPI net ${fmt(net)} TRAC / node score ${nodeScore} = ${fmt(expected)} TRAC`);
  const [record] = await c.cws.getWithdrawal(tokenId);
  let paid: bigint | undefined;
  if (record.epoch !== 0n) {
    const bal0 = await c.token.balanceOf(r.ownerAddr);
    const res = await ctx.tx.step({ key: 'withdraw.claim-withdrawn-epoch', label: `owner: StakingV10.claimWithdrawnEpoch(${tokenId})`, role: 'owner', signer: r.owner, to: sv10, data: claimData });
    if (!res.receipt) return { part: 'claim' };
    const ev = eventsIn(res.receipt, c.sv10, c.sv10.getEvent('WithdrawnEpochClaimed')).find((x) => x.tokenId === tokenId);
    paid = ev?.amount ?? 0n;
    report.check(
      `claimWithdrawnEpoch pays the owner the position's share of epoch ${epoch}: its score × StakingKPI's net / the node's score`,
      !!ev && paid === expected && paid > 0n && ev.staker === r.ownerAddr && (await c.token.balanceOf(r.ownerAddr)) - bal0 === paid,
      `${fmt(paid)} TRAC, expected ${fmt(expected)}`,
    );
  } else {
    paid = (await c.token.balanceOf(r.ownerAddr)) - s.withdrawal.ownerTracAfter;
    report.check(
      'the withdrawn epoch was claimed by another caller (the upkeep cron): the owner received the expected amount',
      paid === expected && expected > 0n,
      `the owner's TRAC since the withdrawal +${fmt(paid)}, expected ${fmt(expected)}${paid !== expected ? ' (other TRAC movements of the owner make this inconclusive)' : ''}`,
    );
  }
  const twice = await ctx.tx.refusal(r.ownerAddr, sv10, claimData);
  report.check('the withdrawn epoch is paid once (NoWithdrawnEpoch)', twice.startsWith('NoWithdrawnEpoch'), twice);
  report.check(`epoch ${epoch}'s stored net is StakingKPI's`, (await c.css.getNetNodeEpochRewards(node, epoch)) === net);
  report.set('withdrawnEpoch', { epoch, score, nodeScore, net, expected, paid });
  if (ctx.env.send) {
    s.withdrawal.claimed = true;
    file.save();
    complete(ctx);
    report.say('\nThe run is complete.');
  }
  return { part: 'claim' };
}
