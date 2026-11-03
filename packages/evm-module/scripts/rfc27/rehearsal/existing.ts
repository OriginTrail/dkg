// PHASE existing: accounts and positions created before the upgrade, on the
// upgraded contracts, against what the pre phase saw the live ones do: a
// scheduled account's publish and settle, settleMany over the expired
// accounts, every position's first-claim gas and the longest history's
// withdrawal gas against 2^24, and every position's claim.

import { eventsIn } from '../contracts';
import { fmt, sum } from '../report';
import { TX_GAS_CAP } from '../tx';
import { Ctx, expectRevert, saveResults, send, withPool } from './context';
import { claimAll, publishAs } from './operations';
import { impersonate, measureTx } from './plumbing';
import { positions, sameRanges, stakerCredits, storedNets } from './reads';
import { GasMeasure, Position, loadPre } from './results';
import { SCHEDULED_ACCOUNT, TRAC } from './scenario';

type History = { tokenId: bigint; node: bigint; unclaimedEpochs: bigint; scoredEpochs: bigint };

const ownerOf = (pos: Position[], tokenId: bigint): string => {
  const p = pos.find((x) => x.tokenId === tokenId);
  if (!p) throw new Error(`no position ${tokenId}`);
  return p.owner;
};

export async function phaseExisting(ctx: Ctx): Promise<void> {
  const { report } = ctx;
  const check = report.check.bind(report);
  const pre = loadPre();
  const c = await withPool(ctx);
  const E = await c.chronos.getCurrentEpoch();
  if (E !== pre.epoch) report.say(`⚠ epoch moved from ${pre.epoch} to ${E}; comparisons assume the same epoch`);
  const [anyone] = await ctx.hre.ethers.getSigners();
  const pcAddr = await c.pc.getAddress();

  report.say(`\nScheduled account ${SCHEDULED_ACCOUNT} (10.0.8 schedule) on PublishingConviction 10.2.0:`);
  const [agent] = await c.pcs.getRegisteredAgents(SCHEDULED_ACCOUNT);
  const publish = await publishAs(ctx, c.pc, SCHEDULED_ACCOUNT, agent, 10n * TRAC, 2n, '10.2.0');
  const old = pre.old.publish;
  check(
    'a scheduled account publishes as before: same discounted cost, same window and top-up draws, same staker credits',
    publish.discountedCost === old.discountedCost &&
      publish.windowSpentDelta === old.windowSpentDelta &&
      publish.topUpDelta === old.topUpDelta &&
      sameRanges(publish.stakerCredits, old.stakerCredits),
    `cost ${fmt(publish.discountedCost)}, window +${fmt(publish.windowSpentDelta)}, top-up ${fmt(publish.topUpDelta)}, credits ${publish.stakerCredits.length}`,
  );
  const settled = await send(ctx, `10.2.0 settle(${SCHEDULED_ACCOUNT})`, anyone, pcAddr, c.pc.interface.encodeFunctionData('settle', [SCHEDULED_ACCOUNT]));
  check('settle books nothing for the scheduled account', stakerCredits(settled.receipt, c).length === 0);
  const accountOwner = await impersonate(ctx, await c.nft.ownerOf(SCHEDULED_ACCOUNT));
  const refused = await expectRevert(
    ctx,
    `setServiceSpending(${SCHEDULED_ACCOUNT}, true) by its owner`,
    accountOwner.address,
    await c.ss.getAddress(),
    c.ss.interface.encodeFunctionData('setServiceSpending', [SCHEDULED_ACCOUNT, true]),
  );
  check('service spending is refused for the scheduled account', refused.startsWith('EmissionAlreadyScheduled'), refused);

  report.say('\nsettleMany over the expired accounts:');
  const expired = pre.accounts.filter((a) => !a.live).map((a) => a.id);
  const many = await send(ctx, `settleMany(${expired.length} expired accounts)`, anyone, pcAddr, c.pc.interface.encodeFunctionData('settleMany', [expired]));
  const swept = eventsIn(many.receipt, c.pc, c.pc.getEvent('AccountFinalSwept')).map((e) => ({ id: e.accountId, topUp: e.topUpSwept }));
  const credits = stakerCredits(many.receipt, c);
  const oldCredits = pre.old.settles.flatMap((s) => s.stakerCredits.map((x) => x.amount));
  check(
    'settleMany books what 10.0.8 settle booked, account by account',
    sum(credits.map((x) => x.amount)) === sum(oldCredits) && credits.length === oldCredits.length,
    `${fmt(sum(credits.map((x) => x.amount)))} TRAC in ${credits.length} credits (10.0.8: ${fmt(sum(oldCredits))} in ${oldCredits.length})`,
  );
  const before1008 = pre.accounts.filter((a) => a.createdBefore1008).map((a) => String(a.id));
  report.say(`accounts created before 10.0.8: ${before1008.join(', ') || 'none'}`);

  report.say('\nStakingV10 10.0.4 positions, claimed on 10.1.0:');
  const pos = await positions(c);
  // The longest unclaimed history: the position with the most unclaimed
  // epochs in which its node scored. `_claim` walks every one of them in one
  // transaction, so its gas limit is what EIP-7825's cap is measured against.
  const history: History[] = [];
  for (const p of pos) {
    let scored = 0n;
    for (let e = p.lastClaimedEpoch + 1n; e <= E - 1n; e++) {
      if ((await c.rss.getEpochLastScorePerStake(p.node, e)) > 0n) scored++;
    }
    history.push({ tokenId: p.tokenId, node: p.node, unclaimedEpochs: E - 1n - p.lastClaimedEpoch, scoredEpochs: scored });
  }
  const longest = history.reduce((a, b) => (b.scoredEpochs > a.scoredEpochs ? b : a));
  const snftAddr = await c.snft.getAddress();
  // Every position's claim as the first on its node, which splits each epoch's
  // operator fee and so costs the most, and the longest history's withdrawal
  // (its claim, then the record of the epoch in progress): gas used and the
  // smallest gas limit, each in reverted snapshots.
  report.say(`\nfirst-claim gas of every position, and the withdrawal of token ${longest.tokenId}, against 2^24 = ${TX_GAS_CAP}:`);
  const firstClaims: (History & GasMeasure)[] = [];
  for (const hist of history) {
    const owner = ownerOf(pos, hist.tokenId);
    await impersonate(ctx, owner);
    const m = await measureTx(ctx, owner, snftAddr, c.snft.interface.encodeFunctionData('claim', [hist.tokenId]));
    firstClaims.push({ ...hist, ...m });
    report.say(
      `  token ${hist.tokenId} (node ${hist.node}): ${hist.scoredEpochs} scored epochs, gas used ${m.gasUsed}, ` +
        `smallest limit ${m.minGasLimit}, margin to 2^24 ${m.marginTo2pow24}`,
    );
  }
  const longestOwner = ownerOf(pos, longest.tokenId);
  await impersonate(ctx, longestOwner);
  const longestWithdraw = await measureTx(ctx, longestOwner, snftAddr, c.snft.interface.encodeFunctionData('withdraw', [longest.tokenId]));
  report.say(
    `  withdraw token ${longest.tokenId}: gas used ${longestWithdraw.gasUsed}, smallest limit ${longestWithdraw.minGasLimit}, ` +
      `margin to 2^24 ${longestWithdraw.marginTo2pow24}`,
  );
  const longestFirst = firstClaims.find((x) => x.tokenId === longest.tokenId);
  if (!longestFirst) throw new Error(`no first claim of token ${longest.tokenId}`);
  const longestLimit = longestFirst.minGasLimit;
  check(
    'every first claim and the longest withdrawal fit 2^24',
    firstClaims.every((x) => x.minGasLimit <= TX_GAS_CAP) && longestWithdraw.minGasLimit <= TX_GAS_CAP,
  );
  const claims = await claimAll(ctx, pos, '10.1.0');
  for (const cl of claims) {
    const o = pre.old.claims.find((x) => x.tokenId === cl.tokenId);
    check(
      `token ${cl.tokenId}: the 10.1.0 claim pays what the 10.0.4 claim paid`,
      !!o && cl.reward === o.reward && cl.lastClaimedEpoch === o.lastClaimedEpoch,
      `${fmt(cl.reward)} TRAC, through epoch ${cl.lastClaimedEpoch}; gas ${cl.gasUsed} (10.0.4: ${o?.gasUsed})`,
    );
  }
  const nets = await storedNets(c, Object.keys(pre.kpiBefore));
  let same = 0;
  const diff: string[] = [];
  for (const [k, v] of Object.entries(nets)) {
    const kb = pre.kpiBefore[k];
    if (v.storedNet === kb.kpiNet) same++;
    else diff.push(`${k}: kpi ${kb.kpiNet} stored ${v.storedNet}`);
  }
  check(
    'every node-epoch net the claims split equals the StakingKPI 10.0.2 preview from before the upgrade',
    diff.length === 0,
    `${same} node-epochs equal${diff.length ? `; differing: ${diff.slice(0, 5).join('; ')}` : ''}`,
  );

  const longestClaim = claims.find((x) => x.tokenId === longest.tokenId);
  if (!longestClaim) throw new Error(`no claim of token ${longest.tokenId}`);
  check(
    `the longest history's claim fits EIP-7825's 2^24 transaction gas cap`,
    longestLimit <= TX_GAS_CAP,
    `gas used ${longestClaim.gasUsed}, smallest gas limit ${longestLimit}, ${(Number(longestClaim.gasUsed) / Number(longest.scoredEpochs)).toFixed(0)} gas per scored epoch`,
  );
  saveResults(ctx, 'existing', {
    epoch: E,
    publish,
    refused,
    settleMany: { swept, credits, gasUsed: many.gasUsed },
    history,
    firstClaims,
    longest: { ...longest, gasUsed: longestClaim.gasUsed, minGasLimit: longestLimit, withdraw: longestWithdraw },
    claims,
    nets,
  });
}
