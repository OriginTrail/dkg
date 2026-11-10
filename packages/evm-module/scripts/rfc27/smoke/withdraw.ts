// PHASE withdraw, optional, after claim, in two runs: the position is
// withdrawn in the middle of an epoch, which records that epoch's share for
// the owner; once that epoch has ended, claimWithdrawnEpoch pays it, against
// the amount the views give (the position's recorded score × the epoch's net /
// the node's score), exactly nothing for an epoch that earned nothing. On testnet
// this adds a day to the run. A withdrawal burns the position, and records nothing
// to claim for one with no score in the epoch, so it waits for the seller's proof
// first. What it expects is journaled with it, since a resume cannot read that from
// a position that is gone.

import { ethers } from 'ethers';

import { eventsIn } from '../contracts';
import { fmt, iso } from '../report';
import { claimPreview, delegatorKey, positionScore } from '../reads';
import { MID_EPOCH_MARGIN } from './config';
import { PoolCtx, complete, doneEarlier, epochStart, now, opensAt, runState, standInProof } from './context';
import { netFromInputs, netsFromInputs, pagedLogs } from './reward-claims';
import { need } from './roles';
import { tracMoved } from './tx';

const WITHDRAW = 'withdraw.withdraw';
const CLAIM = 'withdraw.claim-withdrawn-epoch';

export async function phaseWithdraw(ctx: PoolCtx): Promise<{ part: string }> {
  const { report, c, file } = ctx;
  const r = need(ctx.roles, ['owner', 'ownerAddr']);
  const s = await runState(ctx, 'claim');
  if (doneEarlier(ctx, 'the withdrawn epoch is claimed: the run is complete')) return { part: 'claim' };
  const { tokenId } = s;
  const sv10 = await c.sv10.getAddress();
  const claimData = c.sv10.interface.encodeFunctionData('claimWithdrawnEpoch', [tokenId]);

  if (!s.withdrawal) {
    // 1. The withdrawal, in the middle of an epoch: not within 10 minutes of either end; on the fork, its middle.
    let expected = file.get(WITHDRAW)?.expected;
    if (!expected) {
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
      if (!(s.fork?.proofs ?? []).includes(current.toString())) await standInProof(ctx, 'before the withdrawal, so the position holds score in its epoch');
      const pos = await c.css.getPosition(tokenId);
      if (pos.identityId === 0n) throw new Error(`position ${tokenId} does not exist`);
      const score = await positionScore(c, tokenId, s.sellerId, current, pos.raw);
      if (score === 0n) {
        report.wait(
          `on the seller's proof: position ${tokenId} holds no score in epoch ${current} yet, and a withdrawal now would burn it and record nothing to claim. ` +
            `Run PHASE=withdraw again after node ${s.sellerId}'s next proof, in the middle of an epoch.`,
        );
        return { part: 'withdraw' };
      }
      const auto = await claimPreview(c, tokenId, s.sellerId, pos.lastClaimedEpoch + 1n, current - 1n, pos.raw, await netsFromInputs(c, s.sellerId, pos.lastClaimedEpoch + 1n, current - 1n));
      expected = { epoch: current, raw: pos.raw, auto: auto.total, score };
    }
    const w = await ctx.tx.step({
      key: WITHDRAW,
      label: `owner: DKGStakingConvictionNFT.withdraw(${tokenId})`,
      role: 'owner',
      signer: r.owner,
      to: await c.snft.getAddress(),
      data: c.snft.interface.encodeFunctionData('withdraw', [tokenId]),
      expected,
    });
    if (!w.receipt) return { part: 'withdraw' };
    const { epoch, raw, auto, score } = expected;
    const paid = eventsIn(w.receipt, c.sv10, c.sv10.getEvent('Withdrawn')).find((x) => x.tokenId === tokenId)?.amount ?? 0n;
    const rec = eventsIn(w.receipt, c.sv10, c.sv10.getEvent('WithdrawnEpochRecorded')).find((x) => x.tokenId === tokenId);
    const recorded = await c.rss.getEpochNodeDelegatorScore(epoch, s.sellerId, delegatorKey(tokenId));
    const received = tracMoved(w.receipt, c.token, r.ownerAddr);
    report.check(`the withdrawal pays the stake and every ended epoch: ${fmt(paid)} TRAC = raw ${fmt(raw)} + ${fmt(auto)}`, paid === raw + auto && received === paid, `the owner received ${fmt(received)} TRAC, by its own Transfer logs`);
    report.check(
      `it records epoch ${epoch} for the owner, with the score the position had earned by then`,
      !!rec && rec.epoch === epoch && rec.staker === r.ownerAddr && recorded > 0n && (ctx.net.local ? recorded === score : recorded >= score),
      `score ${recorded}${recorded !== score ? ` (a proof landed between the read and the withdrawal: ${score} before it)` : ''}`,
    );
    // Resumed once that epoch has ended, the moment this check is about has passed.
    if ((await c.chronos.getCurrentEpoch()) === epoch) {
      const early = await ctx.tx.refusal(r.ownerAddr, sv10, claimData);
      report.check('claimWithdrawnEpoch before that epoch ends is refused (WithdrawnEpochInProgress)', early.startsWith('WithdrawnEpochInProgress'), early);
    }
    // A failed check keeps the run on this part, whose next run sends nothing again.
    if (report.failed) return { part: 'withdraw' };
    s.withdrawal = { epoch, node: s.sellerId, recordedScore: recorded };
    file.save();
    report.say(`\nNext: PHASE=withdraw SEND=1 again from ${iso(await epochStart(ctx, epoch + 1n))}, once epoch ${epoch} has ended.`);
    return { part: 'withdraw' };
  }

  // 2. claimWithdrawnEpoch, once the withdrawal's epoch has ended.
  const { epoch, node, recordedScore } = s.withdrawal;
  if (!(await opensAt(ctx, (await epochStart(ctx, epoch + 1n)) + 60n, `claimWithdrawnEpoch, once epoch ${epoch} has ended`))) return { part: 'claim' };
  report.say(`\nClaim the withdrawn epoch ${epoch}, ${ctx.env.send ? 'sending' : 'dry run'}:`);
  const score = await c.rss.getEpochNodeDelegatorScore(epoch, node, delegatorKey(tokenId));
  const nodeScore = await c.rss.getNodeEpochScore(epoch, node);
  const net = await netFromInputs(c, node, epoch);
  const expected = nodeScore === 0n ? 0n : (score * net) / nodeScore;
  report.note(`expected: score ${score} × the epoch's net ${fmt(net)} TRAC / node score ${nodeScore} = ${fmt(expected)} TRAC`);
  // What makes an expected zero mean the epoch earned nothing, and not that the score was lost.
  report.check(`the position's score in epoch ${epoch} is the one its withdrawal recorded, and within the node's`, score === recordedScore && nodeScore >= score, `score ${score} of node score ${nodeScore}, recorded ${recordedScore}`);
  if (expected === 0n) report.note(`epoch ${epoch} earned the position nothing, so its claim is to pay exactly nothing: this run has not seen the claim pay`);
  // This run's attempt may have reverted, with another caller (the upkeep cron) claiming between its
  // estimate and its mining: it paid nothing then. With the record gone, the claim is that caller's.
  const attempt = file.get(CLAIM);
  const claimedByThisRun = !!attempt && (await ctx.tx.receipt(attempt.hash)).status === 1;
  const [record] = await c.cws.getWithdrawal(tokenId);
  let paid: bigint | undefined;
  if (claimedByThisRun || record.epoch !== 0n) {
    const res = await ctx.tx.step({ key: CLAIM, label: `owner: StakingV10.claimWithdrawnEpoch(${tokenId})`, role: 'owner', signer: r.owner, to: sv10, data: claimData, retriesReverted: true });
    if (!res.receipt) return { part: 'claim' };
    const ev = eventsIn(res.receipt, c.sv10, c.sv10.getEvent('WithdrawnEpochClaimed')).find((x) => x.tokenId === tokenId);
    paid = ev?.amount ?? 0n;
    const received = tracMoved(res.receipt, c.token, r.ownerAddr);
    report.check(
      `claimWithdrawnEpoch pays the owner the position's share of epoch ${epoch}: its score × the epoch's net / the node's score`,
      !!ev && paid === expected && ev.staker === r.ownerAddr && received === paid,
      `${fmt(paid)} TRAC, expected ${fmt(expected)}; the owner received ${fmt(received)} TRAC, by its own Transfer logs`,
    );
  } else {
    // Another caller's claim, read from its own transaction: other TRAC of the owner's has no part in it.
    const withdrawnAt = (await ctx.tx.receipt(file.s.steps[WITHDRAW].hash)).blockNumber;
    const claimedTopic = c.sv10.getEvent('WithdrawnEpochClaimed').fragment.topicHash;
    const [log] = await pagedLogs(ctx.hre.ethers.provider, { address: sv10, topics: [claimedTopic, ethers.toBeHex(tokenId, 32)] }, withdrawnAt);
    const receipt = log ? await ctx.tx.receipt(log.transactionHash) : undefined;
    const ev = eventsIn(receipt, c.sv10, c.sv10.getEvent('WithdrawnEpochClaimed')).find((x) => x.tokenId === tokenId);
    paid = ev?.amount ?? 0n;
    const received = receipt ? tracMoved(receipt, c.token, r.ownerAddr) : 0n;
    report.check(
      'the withdrawn epoch was claimed by another caller (the upkeep cron): the owner received the expected amount',
      !!ev && ev.staker === r.ownerAddr && paid === expected && received === paid,
      ev ? `${fmt(paid)} TRAC, expected ${fmt(expected)}; the owner received ${fmt(received)} TRAC, by that transaction's Transfer logs, tx ${log.transactionHash}` : 'no record, and no claim of it on chain',
    );
  }
  const twice = await ctx.tx.refusal(r.ownerAddr, sv10, claimData);
  report.check('the withdrawn epoch is paid once (NoWithdrawnEpoch)', twice.startsWith('NoWithdrawnEpoch'), twice);
  const stored = await c.css.getNetNodeEpochRewards(node, epoch);
  report.check(`epoch ${epoch}'s stored net is what its publishing share, query/inference gross and operator fee give`, stored === net, `${fmt(stored)} TRAC, those give ${fmt(net)} TRAC`);
  report.set('withdrawnEpoch', { epoch, score, nodeScore, net, expected, paid });
  if (ctx.env.send) {
    complete(ctx);
    if (!report.failed) report.say('\nThe run is complete.');
  }
  return { part: 'claim' };
}
