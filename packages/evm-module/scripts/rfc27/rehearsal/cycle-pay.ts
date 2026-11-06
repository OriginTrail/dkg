// The cycle's epoch A + 2: the pool epoch A + 1 has ended, which makes its numbers
// final, and nothing runs before they are paid. What an ended epoch refuses, a
// change of λ that moves nothing, the emergency switch inside a reverted snapshot,
// the sellers' delegators' claims against StakingKPI's preview, the withdrawn epoch
// paid by claimWithdrawnEpoch, the node-epoch accounting of A + 1, the operator fee
// withdrawn, the account's closed windows booked, and the TRAC the vault took in
// and paid out.

import { ethers } from 'ethers';

import { PoolModel } from '../../../test/helpers/emission-model';
import { eventsIn } from '../contracts';
import { chainNow } from '../network';
import { inference } from '../plans';
import { epochNumbers, groupFault, grossOf, poolShareOf, poolsFromMoney } from '../reads';
import { fmt, sum } from '../report';
import { HUB, expectRevert, saveResults, send, succeeds } from './context';
import type { CycleRun } from './cycle';
import { approve, claimAll, requestDomain, signedGroup, walletRequest } from './operations';
import { impersonate } from './plumbing';
import { ExpectedReward, closedWindows, expectedReward, poolsHold, positions, stakerCredits, stakerPools } from './reads';
import { COMMITTED, LATE_COMMITTED, ROLLED_VALUE, SELLERS, TRAC, WALLET_SUBSCRIPTION_VALUE, WALLET_TOP_UP } from './scenario';

export async function payOut(run: CycleRun): Promise<void> {
  const { ctx, c, out, A, E0, actors, feeNode, feeBalance0, vault, vault0, accountId, B, cost, publish, walletSubscription, operational, withdrawn } = run;
  const { report } = ctx;
  const check = report.check.bind(report);
  const { hubOwner: owner, walletBuyer, walletSession, keeper, nodeAdmin } = actors;
  const w = withdrawn.position;
  const h = ctx.stack.hub;
  const qsAddr = await c.qs.getAddress();
  const qisAddr = await c.qis.getAddress();
  const snftAddr = await c.snft.getAddress();
  const sswAddr = await c.ssw.getAddress();
  const sv10Addr = await c.sv10.getAddress();

  // ---- epoch A + 2: the claims, with nothing run first; the window booking ----
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(A + 2n)) + 1n);
  const E3 = await c.chronos.getCurrentEpoch();
  report.say(`\nEpoch ${E3}: epoch ${A + 1n} has ended, its numbers are final, and nothing has to run before they are paid`);

  // What an ended epoch refuses: a batch, even from a seller that has proved in
  // the new epoch (in a reverted snapshot), a top-up, and any write to its money
  // or its totals, here from the Hub owner, whom the storage's gate admits.
  const lateSeller = SELLERS[1];
  const lateBatch = await ctx.fork.inSnapshot(async () => {
    await ctx.fork.proof(c, lateSeller, 1n, `node ${lateSeller}'s first proof of epoch ${E3}, in a reverted snapshot`);
    const late = await signedGroup({ domain: await requestDomain(c), session: walletSession, subscriptionId: walletSubscription, seller: lateSeller, firstNonce: 500n, values: [TRAC], issuedAt: await chainNow(ctx.hre) - 3_600n });
    return expectRevert(ctx, `node ${lateSeller}: a batch for the subscription of ${A + 1n}, in ${E3}`, operational[String(lateSeller)], qsAddr, c.qs.interface.encodeFunctionData('submitReceiptBatch', [[late]]));
  });
  check(`a receipt that misses the end of epoch ${A + 1n} never counts`, lateBatch === groupFault(0, 'OutsideEpoch'), lateBatch);
  const lateTopUp = await expectRevert(ctx, `wallet buyer: a top-up of the subscription of ${A + 1n}, in ${E3}`, walletBuyer.address, sswAddr, c.ssw.interface.encodeFunctionData('topUpFromWallet', [walletSubscription, inference(TRAC), ethers.id('rehearsal wallet plan')]));
  check('a subscription that has ended takes no top-up', lateTopUp.startsWith('SubscriptionEnded'), lateTopUp);
  const ownerAddr = await h.owner();
  const lateMoney = await expectRevert(ctx, `addWalletFunding(${A + 1n}, 1) from the Hub owner, in ${E3}`, ownerAddr, qisAddr, c.qis.interface.encodeFunctionData('addWalletFunding', [A + 1n, 1n]));
  const lateCount = await expectRevert(ctx, `countReceipts for epoch ${A + 1n} from the Hub owner, in ${E3}`, ownerAddr, qisAddr, c.qis.interface.encodeFunctionData('countReceipts', [walletSubscription, 0, SELLERS[0], A + 1n, 1n, 1n, 1n]));
  check(`the storage refuses any write to an ended epoch's money or totals`, lateMoney === `EpochEnded(${A + 1n}, ${E3})` && lateCount === `EpochEnded(${A + 1n}, ${E3})`, `${lateMoney}, ${lateCount}`);

  const kpiPreview: Record<string, bigint> = {};
  for (const p of await positions(c)) {
    for (let e = E0; e <= A + 1n; e++) kpiPreview[`${p.node}:${e}`] ??= await c.kpi.getNetNodeRewards(p.node, e);
  }

  // The pool, read straight from what storage holds, with nothing written since the epoch ended.
  const rolled = await epochNumbers(c, A);
  const poolEpoch = await epochNumbers(c, A + 1n);
  const pool = poolEpoch.pool;
  check(`no value counted in epoch ${A}, so its pool is 0 and its ${fmt(ROLLED_VALUE)} TRAC rolls forward`, rolled.totalServed === 0n && rolled.pool === 0n && rolled.money === ROLLED_VALUE);
  check(
    `the pool of epoch ${A + 1n} is its wallet value, its top-up, the account cost and the money rolled from ${A} (${fmt(pool)} TRAC)`,
    pool === ROLLED_VALUE + WALLET_SUBSCRIPTION_VALUE + WALLET_TOP_UP + cost && pool === poolsFromMoney([rolled, poolEpoch]).pools[1],
  );
  const gross: Record<string, bigint> = {};
  for (const n of SELLERS) gross[String(n)] = await c.qs.queryInferenceGross(A + 1n, n);
  const grossSum = sum(Object.values(gross));
  const nodeInputs = await Promise.all(SELLERS.map((n) => c.qis.getNodeEpoch(n, A + 1n)));
  check(
    'each seller\'s gross is the formula\'s, worked out without the contract',
    SELLERS.every((n, i) => gross[String(n)] === grossOf(pool, poolEpoch.lambdaBps, nodeInputs[i], poolEpoch)),
  );
  check(
    'the sellers\' query/inference gross adds up to the pool, less floor dust',
    grossSum <= pool && pool - grossSum <= 4n,
    `${Object.entries(gross).map(([n, g]) => `node ${n} ${fmt(g)}`).join(', ')}; dust ${pool - grossSum} wei`,
  );

  // The unused share of the pool: what no counted receipt value stands for. It
  // stays in the pool, as OT-RFC-27's shared margin.
  const unused = [{ epoch: A + 1n, money: poolEpoch.money, rolledIn: rolled.money, served: poolEpoch.totalServed, unused: pool - poolEpoch.totalServed, pool }];
  out.unused = unused;
  report.say('  unused share of the pool (pool = money + rolled in, served = totalServed):');
  for (const u of unused) report.say(`    epoch ${u.epoch}: money ${fmt(u.money)}, rolled in ${fmt(u.rolledIn)}, served ${fmt(u.served)}, unused ${fmt(u.unused)}, pool ${fmt(u.pool)}`);
  check(`epoch ${A + 1n}: 2 TRAC of the 16 went unserved, and all 16 are the pool`, pool === 16n * TRAC && poolEpoch.totalServed === 14n * TRAC);

  // λ: an epoch took it when its first value counted, so a change moves no epoch
  // with value, while the formula at the new λ would pay differently.
  const NEW_LAMBDA = 1_000n;
  const lambdaMoved = await ctx.fork.inSnapshot(async () => {
    await send(ctx, `Hub owner: forwardCall(QueryInferenceStorage, setLambdaBps(${NEW_LAMBDA})) (in a snapshot)`, owner, HUB, h.interface.encodeFunctionData('forwardCall', [qisAddr, c.qis.interface.encodeFunctionData('setLambdaBps', [NEW_LAMBDA])]));
    const after = await Promise.all(SELLERS.map((n) => c.qs.queryInferenceGross(A + 1n, n)));
    return { lambda: await c.qis.lambdaBps(), same: SELLERS.every((n, i) => after[i] === gross[String(n)]) };
  });
  const wouldPay = SELLERS.map((n, i) => grossOf(pool, NEW_LAMBDA, nodeInputs[i], poolEpoch));
  check(
    `a change of λ to ${NEW_LAMBDA} moves no epoch that has value`,
    lambdaMoved.lambda === NEW_LAMBDA && lambdaMoved.same,
    `at λ ${NEW_LAMBDA} the formula would pay ${wouldPay.map((g, i) => `node ${SELLERS[i]} ${fmt(g)}`).join(', ')}`,
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
    check('switch off: a wallet subscription can still be funded, so the pause belongs with the removal', fundingOpen);
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
      `token ${cl.tokenId} (node ${cl.node}) is paid what StakingKPI previewed, in its raw stake and in its rewards statistic`,
      cl.rawDelta === x.total && cl.reward === x.total,
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
  const account0 = await c.pcs.getAccount(accountId);
  const cursor0 = account0.lastSettledWindow;
  // No window booked now reaches past one lock from this epoch.
  const lastPool = E3 + account0.lockDurationEpochs + 1n;
  const poolsBefore = await stakerPools(c, E3, lastPool);
  const settled = await send(ctx, `keeper: settle(${accountId})`, keeper, await c.pc.getAddress(), c.pc.interface.encodeFunctionData('settle', [accountId]));
  const [sched] = eventsIn(settled.receipt, c.pc, c.pc.getEvent('EmissionScheduled'));
  if (!sched) throw new Error(`settle(${accountId}) emitted no EmissionScheduled`);
  const booking = stakerCredits(settled.receipt, c);
  const spent0 = await c.pcs.windowSpent(accountId, 0);
  const settledBlock = await ctx.hre.ethers.provider.getBlock(settled.receipt.blockNumber);
  if (!settledBlock) throw new Error(`no block ${settled.receipt.blockNumber}`);
  const account = await c.pcs.getAccount(accountId);
  const { fromWindow: fromW, toWindow: toW } = closedWindows({
    cursor: cursor0,
    createdAt: account.createdAtTimestamp,
    epLen: await c.chronos.epochLength(),
    lock: account.lockDurationEpochs,
    at: BigInt(settledBlock.timestamp),
  });
  check(
    `settle books every closed window, ${fromW}..${toW - 1n}, and moves the cursor past them`,
    sched.fromWindow === fromW && sched.toWindow === toW && account.lastSettledWindow === toW,
    `emitted ${sched.fromWindow}..${sched.toWindow - 1n}, cursor ${account.lastSettledWindow}`,
  );
  let expectedBooked = 0n;
  for (let x = fromW; x < toW; x++) expectedBooked += B - (await c.pcs.windowSpent(accountId, x));
  check(
    `settle books windows ${fromW}..${toW - 1n}: each window's allowance less what it spent`,
    sched.scheduled === expectedBooked && sum(booking.map((x) => x.amount)) === expectedBooked,
    `${fmt(expectedBooked)} TRAC; window 0 spent ${fmt(spent0)} (service ${fmt(cost)} + publish ${fmt(publish.discountedCost)})`,
  );
  check('no booking credits an epoch that has ended', booking.every((x) => x.start >= E3));
  const bookedPools = new PoolModel(poolsBefore.remainder);
  for (const credit of booking) bookedPools.add(credit);
  check('the staker pools in storage gained what the booking credits, epoch by epoch', poolsHold(poolsBefore, await stakerPools(c, E3, lastPool), bookedPools));
  check('window 0 spent exactly the service cost and the publish, once each', spent0 === cost + publish.discountedCost);
  out.windowBooking = { fromWindow: fromW, toWindow: toW, scheduled: sched.scheduled, credits: booking };

  // Conservation.
  const vault1 = await c.token.balanceOf(vault);
  check(
    'TRAC into ConvictionStakingStorage: the wallet subscriptions, the top-up and both commitments in; the withdrawal, its epoch and the operator fee out',
    vault1 - vault0 === ROLLED_VALUE + WALLET_SUBSCRIPTION_VALUE + WALLET_TOP_UP + COMMITTED + LATE_COMMITTED - withdrawn.paidOut - tailPaid - feePaid,
    `Δ ${fmt(vault1 - vault0)} = ${fmt(ROLLED_VALUE + WALLET_SUBSCRIPTION_VALUE + WALLET_TOP_UP)} + ${fmt(COMMITTED)} + ${fmt(LATE_COMMITTED)} − ${fmt(withdrawn.paidOut)} − ${fmt(tailPaid)} − ${fmt(feePaid)}`,
  );
  const publishCredits = sum(publish.stakerCredits.map((x) => x.amount));
  const bookedCredits = sum(booking.map((x) => x.amount));
  check(
    'the account money is booked once: service cost (query/inference funding) + publish credits + window booking = the booked windows\' allowance',
    cost + publishCredits + bookedCredits === B * (toW - fromW),
    `${fmt(cost)} + ${fmt(publishCredits)} + ${fmt(bookedCredits)} = ${fmt(B * (toW - fromW))}`,
  );
  out.claims = claims;
  out.expected = expected;
  out.vault = { before: vault0, after: vault1 };
  out.walletFundGas = run.walletFundGas;
  saveResults(ctx, 'cycle', out);
}
