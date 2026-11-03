// The cycle's epoch A + 2: the close of the pool epoch A + 1, the emergency
// switch inside a reverted snapshot, the sellers' delegators' claims against
// StakingKPI's preview, the withdrawn epoch paid by claimWithdrawnEpoch, the
// node-epoch accounting of A + 1, the operator fee withdrawn, the account's
// closed windows booked, and the TRAC the vault took in and paid out.

import { eventsIn } from '../contracts';
import { chainNow } from '../network';
import { poolShareOf } from '../reads';
import { fmt, sum } from '../report';
import { HUB, expectRevert, saveResults, send, succeeds } from './context';
import type { CycleRun } from './cycle';
import { approve, claimAll, walletRequest } from './operations';
import { impersonate } from './plumbing';
import { ExpectedReward, expectedReward, positions, stakerCredits } from './reads';
import { COMMITTED, LATE_COMMITTED, SELLERS, TRAC, WALLET_PERIOD_VALUE } from './scenario';

export async function closeAndPay(run: CycleRun): Promise<void> {
  const { ctx, c, out, A, E0, actors, feeNode, feeBalance0, vault, vault0, accountId, B, cost, publish, withdrawn } = run;
  const { report } = ctx;
  const check = report.check.bind(report);
  const { hubOwner: owner, walletBuyer, walletSession, keeper, nodeAdmin } = actors;
  const w = withdrawn.position;
  const h = ctx.stack.hub;
  const qsAddr = await c.qs.getAddress();
  const snftAddr = await c.snft.getAddress();
  const sswAddr = await c.ssw.getAddress();
  const sv10Addr = await c.sv10.getAddress();

  // ---- epoch A + 2: close, claims, withdrawal, window booking ----
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(A + 2n)) + 120n);
  const E3 = await c.chronos.getCurrentEpoch();
  report.say(`\nEpoch ${E3}: close and pay`);
  const [previewPool] = await c.qs.previewEpochClose(A + 1n);
  const kpiPreview: Record<string, bigint> = {};
  for (const p of await positions(c)) {
    for (let e = E0; e <= A + 1n; e++) kpiPreview[`${p.node}:${e}`] ??= await c.kpi.getNetNodeRewards(p.node, e);
  }
  const closed = await send(ctx, 'keeper: closeEpochs(10)', keeper, qsAddr, c.qs.interface.encodeFunctionData('closeEpochs', [10n]));
  const closes = eventsIn(closed.receipt, c.qs, c.qs.getEvent('EpochClosed')).map((e) => ({
    epoch: e.epoch,
    walletDue: e.walletDue,
    convictionDue: e.convictionDue,
    carryIn: e.carryIn,
    pool: e.pool,
    sumR: e.sumR,
    sumScore: e.sumScore,
    lambdaBps: e.lambdaBps,
  }));
  out.closes = closes;
  const pool = await c.qs.epochPool(A + 1n);
  check(`the close of ${A + 1n} pools the wallet value and the account cost (${fmt(pool)} TRAC)`, pool === WALLET_PERIOD_VALUE + cost);
  check('the previewed close equals the close', previewPool === pool);
  const gross: Record<string, bigint> = {};
  for (const n of SELLERS) gross[String(n)] = await c.qs.queryInferenceGross(A + 1n, n);
  const grossSum = sum(Object.values(gross));
  check(
    'the sellers\' query/inference gross adds up to the pool, less floor dust',
    grossSum <= pool && pool - grossSum <= 4n,
    `${Object.entries(gross).map(([n, g]) => `node ${n} ${fmt(g)}`).join(', ')}; dust ${pool - grossSum} wei`,
  );

  // The unused share of each closed epoch: its money less the receipt value
  // finalized in it. The whole money is the pool once any value is finalized.
  const unused = closes.map((x) => {
    const money = x.walletDue + x.convictionDue + x.carryIn;
    return { epoch: x.epoch, money, served: x.sumR, unused: money - x.sumR, pool: x.pool };
  });
  out.unused = unused;
  report.say('  unused share per closed epoch (money = walletDue + convictionDue + carryIn, served = sumR):');
  for (const u of unused) report.say(`    epoch ${u.epoch}: money ${fmt(u.money)}, served ${fmt(u.served)}, unused ${fmt(u.unused)}, pool ${fmt(u.pool)}`);
  check(
    `epoch ${A + 1n}: 2 TRAC of the 12 went unserved, and the pool is the whole money`,
    unused.some((u) => u.epoch === A + 1n && u.money === 12n * TRAC && u.served === 10n * TRAC && u.unused === 2n * TRAC && u.pool === 12n * TRAC),
  );

  const cyclePositions = (await positions(c)).filter((p) => SELLERS.includes(p.node));

  // The emergency switch, inside a reverted snapshot: with the settlement out
  // of the Hub, a claim and a withdrawal go through and pay the publishing pool
  // alone.
  await ctx.fork.inSnapshot(async () => {
    await send(ctx, 'Hub owner: removeContractByName("QueryInferenceSettlement") (in a snapshot)', owner, HUB, h.interface.encodeFunctionData('removeContractByName', ['QueryInferenceSettlement']));
    const n1 = SELLERS[1];
    const k1 = `${n1}:${A + 1n}`;
    const noPool: Record<string, bigint> = { ...kpiPreview };
    noPool[k1] = await c.kpi.getNetNodeRewards(n1, A + 1n);
    const publishingNet = (await poolShareOf(c, n1, A + 1n, 0n, 0n)).netWithoutPool;
    check(
      `with the settlement removed, StakingKPI's net of node ${n1} in epoch ${A + 1n} is the publishing share alone`,
      noPool[k1] === publishingNet && noPool[k1] < kpiPreview[k1],
      `${fmt(kpiPreview[k1])} → ${fmt(noPool[k1])}`,
    );
    const [claimer, withdrawer] = cyclePositions.filter((p) => p.node === n1).sort((a, b) => (a.raw < b.raw ? -1 : 1));
    if (!claimer || !withdrawer) throw new Error(`node ${n1} has fewer than two positions`);
    const xc = await expectedReward(c, claimer, claimer.lastClaimedEpoch + 1n, E3 - 1n, noPool);
    const [cl] = await claimAll(ctx, [claimer], 'switch off:');
    check(`switch off: token ${claimer.tokenId}'s claim pays the publishing pool alone`, cl.reward === xc.total, `${fmt(cl.reward)} TRAC`);
    const xw = await expectedReward(c, withdrawer, withdrawer.lastClaimedEpoch + 1n, E3 - 1n, noPool);
    const wo = await impersonate(ctx, withdrawer.owner);
    const before = await c.token.balanceOf(withdrawer.owner);
    const rawW = (await c.css.getPosition(withdrawer.tokenId)).raw;
    await send(ctx, `switch off: token ${withdrawer.tokenId} owner: withdraw`, wo, snftAddr, c.snft.interface.encodeFunctionData('withdraw', [withdrawer.tokenId]));
    const got = (await c.token.balanceOf(withdrawer.owner)) - before;
    check(
      `switch off: token ${withdrawer.tokenId}'s withdrawal goes through, its claim paying the publishing pool alone`,
      got === rawW + xw.total,
      `${fmt(got)} TRAC = raw ${fmt(rawW)} + rewards ${fmt(xw.total)}`,
    );
    // Funding stays open with the settlement out of the Hub; the pause closes it.
    await approve(ctx, 'wallet buyer: approve 1 TRAC (in the snapshot)', walletBuyer, sswAddr, TRAC);
    const lateReq = c.ssw.interface.encodeFunctionData('fundFromWallet', [walletRequest(E3, walletSession.address, TRAC, 'rehearsal plan, settlement removed')]);
    const fundingOpen = await succeeds(ctx, await walletBuyer.getAddress(), sswAddr, lateReq);
    check('switch off: a wallet period can still be funded, so the pause belongs with the removal', fundingOpen);
    await send(
      ctx,
      'Hub owner: forwardCall(QueryInferenceStorage, setPaused(true)) (in the snapshot)',
      owner,
      HUB,
      h.interface.encodeFunctionData('forwardCall', [await c.qis.getAddress(), c.qis.interface.encodeFunctionData('setPaused', [true])]),
    );
    const pausedWhy = await expectRevert(ctx, 'switch off and paused: fundFromWallet', await walletBuyer.getAddress(), sswAddr, lateReq);
    check('the pause refuses the funding', pausedWhy.startsWith('QueryInferencePaused'), pausedWhy);
    out.emergencySwitch = {
      claim: { tokenId: claimer.tokenId, reward: cl.reward, gasUsed: cl.gasUsed },
      withdraw: { tokenId: withdrawer.tokenId, amount: got },
      kpiNet: { withPool: kpiPreview[k1], without: noPool[k1] },
      fundingOpen,
      paused: pausedWhy,
    };
  });

  // The sellers' real delegators claim.
  const expected: Record<string, ExpectedReward> = {};
  for (const p of cyclePositions) expected[String(p.tokenId)] = await expectedReward(c, p, p.lastClaimedEpoch + 1n, E3 - 1n, kpiPreview);
  const vaultBeforeClaims = await c.token.balanceOf(vault);
  const claims = await claimAll(ctx, cyclePositions, 'cycle');
  for (const cl of claims) {
    const x = expected[String(cl.tokenId)];
    check(
      `token ${cl.tokenId} (node ${cl.node}) is paid what StakingKPI previewed`,
      cl.reward === x.total,
      `${fmt(cl.reward)} TRAC (preview ${fmt(x.total)}; epoch ${A + 1n}: ${fmt(x.per[String(A + 1n)] ?? 0n)})`,
    );
  }
  for (const n of SELLERS) {
    const stored = await c.css.getNetNodeEpochRewards(n, A + 1n);
    check(`node ${n}: the net of epoch ${A + 1n} the claims split equals StakingKPI's preview`, stored === kpiPreview[`${n}:${A + 1n}`], fmt(stored));
  }
  check('claims move no TRAC (rewards compound into the positions)', (await c.token.balanceOf(vault)) === vaultBeforeClaims);

  // The withdrawn position's share of A + 1, paid by anyone's claimWithdrawnEpoch.
  const nodeScoreW = await c.rss.getNodeEpochScore(A + 1n, w.node);
  const tailExpected = (withdrawn.recordedScore * kpiPreview[`${w.node}:${A + 1n}`]) / nodeScoreW;
  const stakerBefore = await c.token.balanceOf(w.owner);
  const keeperBefore = await c.token.balanceOf(keeper.address);
  const claimTail = c.sv10.interface.encodeFunctionData('claimWithdrawnEpoch', [w.tokenId]);
  const tail = await send(ctx, `keeper: claimWithdrawnEpoch(${w.tokenId})`, keeper, sv10Addr, claimTail);
  const tailPaid = (await c.token.balanceOf(w.owner)) - stakerBefore;
  check(
    `the withdrawn epoch pays the staker its score's share of the net of ${A + 1n}, as the end of the epoch pays a position`,
    tailPaid === tailExpected && tailPaid > 0n && (await c.token.balanceOf(keeper.address)) === keeperBefore,
    `${fmt(tailPaid)} TRAC = score × StakingKPI's net / node score (${fmt(tailExpected)})`,
  );
  const twice = await expectRevert(ctx, `claimWithdrawnEpoch(${w.tokenId}) again`, keeper.address, sv10Addr, claimTail);
  check('the withdrawn epoch is paid once', twice.startsWith('NoWithdrawnEpoch'), twice);
  out.withdrawnEpoch = { tokenId: w.tokenId, paid: tailPaid, expected: tailExpected, gasUsed: tail.gasUsed };

  // The node-epoch accounting of the pool epoch, per seller.
  const nodeEpoch: Record<string, { publishingShare: bigint; queryInferenceGross: bigint; gross: bigint; operatorFeeBps: bigint; operatorFee: bigint; net: bigint; paidToDelegators: bigint }> = {};
  for (const n of SELLERS) {
    const { publishingShare: pub, feeBps } = await poolShareOf(c, n, A + 1n, 0n, 0n);
    const g = pub + gross[String(n)];
    const net = await c.css.getNetNodeEpochRewards(n, A + 1n);
    const paid =
      sum(claims.filter((x) => x.node === n).map((x) => expected[String(x.tokenId)].per[String(A + 1n)] ?? 0n)) + (n === w.node ? tailPaid : 0n);
    nodeEpoch[String(n)] = { publishingShare: pub, queryInferenceGross: gross[String(n)], gross: g, operatorFeeBps: feeBps, operatorFee: g - net, net, paidToDelegators: paid };
    check(
      `node ${n}: the operator fee of ${A + 1n} is ${feeBps} bps of the gross, the publishing share and the query/inference gross together`,
      g - net === (g * feeBps) / 10_000n,
      `gross ${fmt(g)} = publishing ${fmt(pub)} + query/inference ${fmt(gross[String(n)])}; fee ${fmt(g - net)}`,
    );
    check(
      `node ${n}: the delegators are paid the net of ${A + 1n}, less rounding`,
      paid <= net && net - paid <= net / 10n ** 9n,
      `net ${fmt(net)}, paid ${fmt(paid)}, operator fee ${fmt(g - net)}`,
    );
  }
  out.nodeEpoch = nodeEpoch;

  // The operator fee the claims split off, withdrawn through StakingV10Ledger.
  const feeBalance = await c.css.getOperatorFeeBalance(feeNode);
  check(
    `node ${feeNode}'s operator-fee balance grew by exactly the fee of ${A + 1n}`,
    feeBalance - feeBalance0 === nodeEpoch[String(feeNode)].operatorFee,
    fmt(feeBalance - feeBalance0),
  );
  await send(
    ctx,
    `node ${feeNode} admin: requestOperatorFeeWithdrawal(${fmt(feeBalance)})`,
    nodeAdmin,
    sv10Addr,
    c.sv10.interface.encodeFunctionData('requestOperatorFeeWithdrawal', [feeNode, feeBalance]),
  );
  await ctx.fork.warpTo((await chainNow(ctx.hre)) + (await c.params.stakeWithdrawalDelay()) + 1n);
  const adminBefore = await c.token.balanceOf(nodeAdmin.address);
  const feeWd = await send(ctx, `node ${feeNode} admin: finalizeOperatorFeeWithdrawal`, nodeAdmin, sv10Addr, c.sv10.interface.encodeFunctionData('finalizeOperatorFeeWithdrawal', [feeNode]));
  const feePaid = (await c.token.balanceOf(nodeAdmin.address)) - adminBefore;
  check('the operator-fee withdrawal pays the whole balance out of ConvictionStakingStorage', feePaid === feeBalance, fmt(feePaid));
  out.operatorFeeWithdrawal = { node: feeNode, amount: feePaid, gasUsed: feeWd.gasUsed };

  // Window booking: the account's closed windows, booked by anyone's settle.
  const settled = await send(ctx, `keeper: settle(${accountId})`, keeper, await c.pc.getAddress(), c.pc.interface.encodeFunctionData('settle', [accountId]));
  const [sched] = eventsIn(settled.receipt, c.pc, c.pc.getEvent('EmissionScheduled'));
  if (!sched) throw new Error(`settle(${accountId}) emitted no EmissionScheduled`);
  const booking = stakerCredits(settled.receipt, c);
  const spent0 = await c.pcs.windowSpent(accountId, 0);
  const fromW = sched.fromWindow;
  const toW = sched.toWindow;
  let expectedBooked = 0n;
  for (let x = fromW; x < toW; x++) expectedBooked += B - (await c.pcs.windowSpent(accountId, x));
  check(
    `settle books windows ${fromW}..${toW - 1n}: each window's budget less what it drew`,
    sched.scheduled === expectedBooked && sum(booking.map((x) => x.amount)) === expectedBooked,
    `${fmt(expectedBooked)} TRAC; window 0 drew ${fmt(spent0)} (service ${fmt(cost)} + publish ${fmt(publish.discountedCost)})`,
  );
  check('no booking credits an epoch that has ended', booking.every((x) => x.start >= E3));
  check('window 0 drew exactly the service cost and the publish, once each', spent0 === cost + publish.discountedCost);
  out.windowBooking = { fromWindow: fromW, toWindow: toW, scheduled: sched.scheduled, credits: booking };

  // Conservation.
  const vault1 = await c.token.balanceOf(vault);
  check(
    'TRAC into ConvictionStakingStorage: the wallet value and both commitments in; the withdrawal, its epoch and the operator fee out',
    vault1 - vault0 === WALLET_PERIOD_VALUE + COMMITTED + LATE_COMMITTED - withdrawn.paidOut - tailPaid - feePaid,
    `Δ ${fmt(vault1 - vault0)} = ${fmt(WALLET_PERIOD_VALUE)} + ${fmt(COMMITTED)} + ${fmt(LATE_COMMITTED)} − ${fmt(withdrawn.paidOut)} − ${fmt(tailPaid)} − ${fmt(feePaid)}`,
  );
  const publishCredits = sum(publish.stakerCredits.map((x) => x.amount));
  const bookedCredits = sum(booking.map((x) => x.amount));
  check(
    'the account money is booked once: service cost (query/inference due) + publish credits + window booking = the booked windows\' budget',
    cost + publishCredits + bookedCredits === B * (toW - fromW),
    `${fmt(cost)} + ${fmt(publishCredits)} + ${fmt(bookedCredits)} = ${fmt(B * (toW - fromW))}`,
  );
  out.claims = claims;
  out.expected = expected;
  out.vault = { before: vault0, after: vault1 };
  out.walletFundGas = run.walletFundGas;
  saveResults(ctx, 'cycle', out);
}
