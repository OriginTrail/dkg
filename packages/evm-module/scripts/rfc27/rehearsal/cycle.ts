// PHASE cycle: one full marketplace cycle on the upgraded contracts, from the
// activation epoch A. In A: an operator fee for the first seller, a
// wallet-funded period, a new Conviction Account opened for services and a
// period funded from it, a second account left untouched, a publish, and the
// sellers' receipt batches. In A + 1: the finalization, first while the sellers
// have not proved in A + 1 (every claim skipped NoScore), then once they have;
// and a withdrawal in the middle of the epoch. In A + 2 (cycle-pay.ts): the
// close, the claims, the withdrawn epoch, the operator fee, the window booking.

import { ethers } from 'ethers';
import type { Signer } from 'ethers';

import { costOf, subscriptionIdOf } from '../../../test/helpers/conviction-service';
import type { Profile } from '../../../typechain';
import { Contracts, eventsIn, typedAt } from '../contracts';
import type { NodeSigner } from '../fork';
import { chainNow } from '../network';
import { ClaimRef, claimPreview, delegatorKey, positionScore, skipReasonOf } from '../reads';
import { fmt, sum, toJson } from '../report';
import { Ctx, expectRevert, send, withPool } from './context';
import { closeAndPay } from './cycle-pay';
import { accountRequest, approve, createAccount, fundTrac, openServiceAccount, publishAs, requestDomain, signedGroup, submitBatch, walletRequest } from './operations';
import { impersonate } from './plumbing';
import { positions, smallestOn, stakerCredits } from './reads';
import type { Position, PublishResult } from './results';
import { loadHub, loadPre } from './results';
import { CA_PERIOD_VALUE, COMMITTED, LATE_COMMITTED, MAX_COST_PER_PERIOD, PUBLISH_BASE_COST, PUBLISH_KA_EPOCHS, SELLERS, TRAC, WALLET_PERIOD_VALUE } from './scenario';

/** What the cycle's epochs A and A + 1 leave for A + 2. */
export type CycleRun = {
  ctx: Ctx;
  c: Contracts;
  out: { [key: string]: unknown };
  A: bigint;
  E0: bigint;
  actors: { hubOwner: NodeSigner; walletBuyer: Signer; walletSession: Signer & { address: string }; keeper: Signer & { address: string }; nodeAdmin: Signer & { address: string } };
  feeNode: bigint;
  feeBalance0: bigint;
  vault: string;
  vault0: bigint;
  accountId: bigint;
  /** The account's per-window budget. */
  B: bigint;
  cost: bigint;
  publish: PublishResult;
  /** The withdrawn position, what its withdrawal paid, and its recorded score of A + 1. */
  withdrawn: { position: Position; paidOut: bigint; recordedScore: bigint };
  walletFundGas: bigint;
};

export async function phaseCycle(ctx: Ctx): Promise<void> {
  const { report } = ctx;
  const check = report.check.bind(report);
  const pre = loadPre();
  const hubResults = loadHub();
  const c = await withPool(ctx);
  const [, walletBuyer, caOwner, buyerKey, caSession, agent, keeper, walletSession, nodeAdmin, lateOwner] = await ctx.hre.ethers.getSigners();
  const A = hubResults.activation;
  const E0 = A - 1n;
  const out: { [key: string]: unknown } = { activation: A };
  const snftAddr = await c.snft.getAddress();
  const ssAddr = await c.ss.getAddress();
  const sswAddr = await c.ssw.getAddress();
  const qsAddr = await c.qs.getAddress();

  // Scores of the last full epoch before the fork, per active node, mirrored into the cycle's epochs.
  const operational = pre.operational;
  const activeNodes = Object.keys(operational).map((n) => BigInt(n));
  const mirror: Record<string, bigint> = {};
  for (const n of activeNodes) mirror[String(n)] = await c.rss.getNodeEpochScore(E0 - 1n, n);
  out.mirroredScores = mirror;
  const prove = (n: bigint, why: string) => ctx.fork.proof(c, n, mirror[String(n)], why);

  // ---- epoch A: an operator fee, funding, publishing, serving ----
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(A)) + 120n);
  report.say(`\nEpoch ${await c.chronos.getCurrentEpoch()} (activation ${A}): the first seller's operator fee`);
  // Every testnet node charges 0 %, so the first seller's admin sets 10 % for
  // A + 1, the pool epoch, through Profile.updateOperatorFee. FORK-ONLY: the
  // admin is an anvil account added as an admin key of the node through the
  // contract the Hub holds as Identity (impersonated); the node's own admin
  // keys are not known here.
  const feeNode = SELLERS[0];
  const OPERATOR_FEE = 1_000n; // 10 % of maxOperatorFee 10,000
  const identity = await impersonate(ctx, await ctx.stack.addr('Identity'));
  await send(
    ctx,
    `fork-only: an admin key for node ${feeNode}, added as Identity`,
    identity,
    await c.ids.getAddress(),
    c.ids.interface.encodeFunctionData('addKey', [feeNode, ethers.keccak256(ethers.solidityPacked(['address'], [nodeAdmin.address])), 1, 1]),
  );
  // updateOperatorFee needs the previous epoch's operator fee split, which any claim on the node does.
  const firstPos = (await positions(c)).find((p) => p.node === feeNode);
  if (!firstPos) throw new Error(`no position on node ${feeNode}`);
  const splitOwner = await impersonate(ctx, firstPos.owner);
  await send(ctx, `token ${firstPos.tokenId} owner: claim (splits epoch ${A - 1n} on node ${feeNode})`, splitOwner, snftAddr, c.snft.interface.encodeFunctionData('claim', [firstPos.tokenId]));
  const feeBalance0 = await c.css.getOperatorFeeBalance(feeNode);
  const profile = await typedAt<Profile>(ctx.hre, 'Profile', await ctx.stack.addr('Profile'));
  await send(ctx, `node ${feeNode} admin: Profile.updateOperatorFee(${OPERATOR_FEE})`, nodeAdmin, await profile.getAddress(), profile.interface.encodeFunctionData('updateOperatorFee', [feeNode, OPERATOR_FEE]));
  const feeAt = async (e: bigint) => c.ps.getOperatorFeePercentageByTimestampReverse(feeNode, (await c.chronos.timestampForEpoch(e + 1n)) - 1n);
  check(`node ${feeNode}'s 10 % fee applies to epoch ${A + 1n} and not to ${A}`, (await feeAt(A + 1n)) === OPERATOR_FEE && (await feeAt(A)) === 0n);

  report.say(`\nEpoch ${await c.chronos.getCurrentEpoch()}: funding`);
  const hubOwner = await impersonate(ctx, await ctx.stack.hub.owner());
  await fundTrac(ctx, hubOwner, walletBuyer.address, 100n * TRAC, 'fork-only: Hub owner sends TRAC to the wallet buyer');
  await fundTrac(ctx, hubOwner, caOwner.address, COMMITTED, 'fork-only: Hub owner sends TRAC to the account owner');
  await fundTrac(ctx, hubOwner, lateOwner.address, LATE_COMMITTED, 'fork-only: Hub owner sends TRAC to a second account owner');
  const vault = await c.css.getAddress();
  const vault0 = await c.token.balanceOf(vault);

  // A wallet-funded period.
  await approve(ctx, 'wallet buyer: approve ServiceSubscriptionsWallet', walletBuyer, sswAddr, WALLET_PERIOD_VALUE);
  const walletFund = await send(
    ctx,
    `wallet buyer: fundFromWallet(epoch ${A}, ${fmt(WALLET_PERIOD_VALUE)} TRAC)`,
    walletBuyer,
    sswAddr,
    c.ssw.interface.encodeFunctionData('fundFromWallet', [walletRequest(A, walletSession.address, WALLET_PERIOD_VALUE, 'rehearsal wallet plan')]),
  );
  const walletPeriod = subscriptionIdOf(walletBuyer.address, A);

  // A new 10.2.0 Conviction Account: create, opt in, assign a buyer key, fund a period from it.
  const opened = await openServiceAccount(ctx, c, {
    owner: caOwner,
    committed: COMMITTED,
    buyerKey,
    maxCostPerPeriod: MAX_COST_PER_PERIOD,
    assignLabel: 'account owner: assign the buyer key (the key consents by EIP-712 signature)',
  });
  const { accountId, account: acct } = opened;
  const B = COMMITTED / acct.lockDurationEpochs;
  out.account = { accountId, discountBps: acct.discountBps, lock: acct.lockDurationEpochs, B, createdAtTimestamp: acct.createdAtTimestamp };
  check('createAccount books nothing to the staker pool (10.2.0)', stakerCredits(opened.created.receipt, c).length === 0);
  const caFund = await send(
    ctx,
    `buyer key: fundFromConviction(account ${accountId}, epoch ${A}, ${fmt(CA_PERIOD_VALUE)} TRAC value)`,
    buyerKey,
    ssAddr,
    c.ss.interface.encodeFunctionData('fundFromConviction', [accountRequest(accountId, A, caSession.address, CA_PERIOD_VALUE, 'rehearsal account plan')]),
  );
  const caPeriod = subscriptionIdOf(buyerKey.address, A);
  const [periodFunded] = eventsIn(caFund.receipt, c.ss, c.ss.getEvent('PeriodFunded'));
  if (!periodFunded) throw new Error('fundFromConviction emitted no PeriodFunded');
  const cost = periodFunded.cost;
  check(
    'the account period books no staker credit and moves no TRAC',
    stakerCredits(caFund.receipt, c).length === 0 && eventsIn(caFund.receipt, c.token, c.token.getEvent('Transfer')).length === 0,
  );
  check(`the period's cost is the value at the account's discount (${fmt(cost)} TRAC)`, cost === costOf(CA_PERIOD_VALUE, acct.discountBps));

  // A second 10.2.0 account, which nothing touches until the late-booking phase.
  const late = await createAccount(ctx, c, 'second account owner', lateOwner, LATE_COMMITTED);
  out.lateAccount = { accountId: late.accountId, committed: LATE_COMMITTED, createdAtTimestamp: late.account.createdAtTimestamp, lock: late.account.lockDurationEpochs };

  // A publish from the account.
  await send(ctx, 'account owner: registerAgent', caOwner, await c.nft.getAddress(), c.nft.interface.encodeFunctionData('registerAgent', [accountId, agent.address]));
  const publish = await publishAs(ctx, c.pc, accountId, agent.address, PUBLISH_BASE_COST, PUBLISH_KA_EPOCHS, 'fork-only (KnowledgeAssetsLifecycle impersonated):');
  check(
    'a use-time publish books its whole draw to the staker pool over the Knowledge Asset epochs',
    sum(publish.stakerCredits.map((x) => x.amount)) === publish.discountedCost && publish.stakerCredits.every((x) => x.start >= A && x.end <= A + PUBLISH_KA_EPOCHS),
    `${fmt(publish.discountedCost)} TRAC over ${JSON.stringify(toJson(publish.stakerCredits))}`,
  );
  out.funding = { walletPeriod, caPeriod, walletValue: WALLET_PERIOD_VALUE, caValue: CA_PERIOD_VALUE, cost, publish };
  const due = await c.qis.dueIn(A + 1n);
  check(`due in epoch ${A + 1n}: wallet ${fmt(WALLET_PERIOD_VALUE)} and account cost ${fmt(cost)}`, due.wallet === WALLET_PERIOD_VALUE && due.conviction === cost);

  // Serving: requests signed by each period's session key, receipts submitted by real Core Nodes.
  const qiDomain = await requestDomain(c);
  const issuedAt = await chainNow(ctx.hre);
  const plan: Record<string, { ca: bigint[]; wallet: bigint[] }> = {
    // The account bucket is claimed above its cap (8 of 7), the wallet bucket
    // below it (3 of 5): the epoch's money is 12, its served value 10.
    [String(SELLERS[0])]: { ca: [2n * TRAC, 2n * TRAC], wallet: [2n * TRAC] },
    [String(SELLERS[1])]: { ca: [4n * TRAC], wallet: [1n * TRAC] },
  };
  const batches: { seller: bigint; items: bigint; value: bigint; stakeFactor18: bigint; gasUsed: bigint }[] = [];
  for (const seller of SELLERS) {
    const op = operational[String(seller)];
    if (!op) throw new Error(`no operational key seen for node ${seller}`);
    const groups = [
      await signedGroup({ domain: qiDomain, session: caSession, subscriptionId: caPeriod, seller, firstNonce: 0n, values: plan[String(seller)].ca, issuedAt }),
      await signedGroup({ domain: qiDomain, session: walletSession, subscriptionId: walletPeriod, seller, firstNonce: 0n, values: plan[String(seller)].wallet, issuedAt }),
    ];
    const opSigner = await impersonate(ctx, op);
    const b = await submitBatch(ctx, c.qs, opSigner, `node ${seller} operational key: submitReceiptBatch (2 groups)`, groups);
    const [acc] = eventsIn(b.receipt, c.qs, c.qs.getEvent('ReceiptBatchAccepted'));
    if (!acc) throw new Error(`node ${seller}'s batch emitted no ReceiptBatchAccepted`);
    batches.push({ seller, items: acc.itemCount, value: acc.value, stakeFactor18: acc.stakeFactor18, gasUsed: b.gasUsed });
  }
  out.batches = batches;
  const fundedCap = { ca: await c.qs.fundedCap(caPeriod, 0), wallet: await c.qs.fundedCap(walletPeriod, 0) };
  out.fundedCap = fundedCap;

  // FORK-ONLY: the active nodes keep scoring in epoch A, as they scored before the fork.
  for (const n of activeNodes) await prove(n, `node ${n} keeps scoring in epoch ${A} what it scored in ${E0 - 1n}`);

  // ---- epoch A + 1: finalization after the deadline ----
  const deadline = (await c.chronos.timestampForEpoch(A + 1n)) + (await c.qis.receiptGraceSecondsAt(A));
  await ctx.fork.warpTo(deadline + 1n);
  report.say(`\nEpoch ${await c.chronos.getCurrentEpoch()}: finalization (deadline ${deadline})`);
  const refs: ClaimRef[] = SELLERS.flatMap((seller) => [
    { subscriptionId: caPeriod, bucketIndex: 0n, seller },
    { subscriptionId: walletPeriod, bucketIndex: 0n, seller },
  ]);
  const finalizeData = c.qs.interface.encodeFunctionData('finalizeClaims', [refs]);
  const skipsIn = (r: Awaited<ReturnType<typeof send>>) =>
    eventsIn(r.receipt, c.qs, c.qs.getEvent('ClaimSkipped')).map((e) => ({ subscriptionId: e.subscriptionId, bucketIndex: e.bucketIndex, seller: e.seller, reason: skipReasonOf(e.reason) }));
  // A keeper that runs at the deadline, before the sellers' first proof in
  // A + 1: finalizeClaims skips a claim while its seller has no node score in
  // the current epoch, with ClaimSkipped(NoScore), and the transaction goes
  // through. The claims stay as they were, to be finalized by a retry once
  // the sellers have proved, before A + 1 ends.
  const early = await send(ctx, `keeper: finalizeClaims (4 claims), before the sellers prove in epoch ${A + 1n}`, keeper, qsAddr, finalizeData);
  const noScore = skipsIn(early);
  const finalizedEarly = eventsIn(early.receipt, c.qs, c.qs.getEvent('ClaimsFinalized')).length;
  const untouched = (await Promise.all(refs.map(async (r) => !(await c.qis.getSellerClaim(r.subscriptionId, r.bucketIndex, r.seller)).finalized))).every(Boolean);
  check(
    `before the sellers prove in epoch ${A + 1n}, finalizeClaims goes through and skips each claim NoScore, leaving it unfinalized`,
    early.receipt.status === 1 && finalizedEarly === 0 && noScore.length === refs.length && noScore.every((s) => s.reason === 'NoScore') && untouched,
    noScore.map((s) => `${s.subscriptionId === caPeriod ? 'account' : 'wallet'} claim of node ${s.seller}: ${s.reason}`).join(', '),
  );
  for (const n of activeNodes) await prove(n, `node ${n} scores in epoch ${A + 1n} what it scored in ${E0 - 1n}`);
  const fin = await send(ctx, 'keeper: finalizeClaims (4 claims)', keeper, qsAddr, finalizeData);
  const finalized = eventsIn(fin.receipt, c.qs, c.qs.getEvent('ClaimsFinalized')).map((e) => ({
    sub: e.subscriptionId === caPeriod ? 'account' : 'wallet',
    seller: e.seller,
    claimed: e.claimed,
    value: e.value,
    score: e.score,
  }));
  const skipped = skipsIn(fin);
  out.finalized = finalized;
  out.skipped = skipped;
  check('all four claims finalized', finalized.length === 4 && skipped.length === 0);
  check(
    'the retry after the sellers\' proofs finalizes every claim the first call skipped NoScore',
    noScore.every((s) => finalized.some((f) => f.seller === s.seller && (f.sub === 'account') === (s.subscriptionId === caPeriod))),
  );
  out.noScoreRetry = { skipped: noScore, gasUsed: early.gasUsed };
  const caFinal = sum(finalized.filter((f) => f.sub === 'account').map((f) => f.value));
  check(`the account bucket's claims shrank to its funded cap ${fmt(fundedCap.ca)}`, caFinal <= fundedCap.ca && caFinal >= fundedCap.ca - 2n);

  // A withdrawal in the middle of A + 1: the smallest position of the first
  // seller, a real delegator of a real node. It pays the stake and every
  // ended epoch since the position's last claim; its score in A + 1, the
  // epoch in progress, up to the withdrawal, is recorded and paid by
  // claimWithdrawnEpoch once A + 1 ends, as a position holding that score is
  // paid at the epoch's end. The node proves once more after the withdrawal,
  // and the withdrawn stake takes no share of that proof.
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(A + 1n)) + (await c.chronos.epochLength()) / 2n);
  const w = smallestOn(await positions(c), SELLERS[0]);
  if (!w) throw new Error(`no position on node ${SELLERS[0]}`);
  const wKey = delegatorKey(w.tokenId);
  const wPos = await c.css.getPosition(w.tokenId);
  const rawBefore = wPos.raw;
  // The score a position staying to the end of A + 1 holds in it, from views:
  // what `_claim` integrates for an epoch after the position's boost expired.
  const stayed = await positionScore(c, w.tokenId, w.node, A + 1n, rawBefore);
  // Real nodes keep proving after a withdrawal. The counterfactual, in a
  // reverted snapshot: the node's next proof with the position still staked.
  const stayedThroughLaterProof = await ctx.fork.inSnapshot(async () => {
    await prove(w.node, `node ${w.node}'s next proof in epoch ${A + 1n}, in a reverted snapshot, with token ${w.tokenId} still staked`);
    return positionScore(c, w.tokenId, w.node, A + 1n, rawBefore);
  });
  // What the withdrawal pays, from views before it: the stake, plus every
  // ended epoch since the position's last claim (from its migration epoch, if
  // later) at StakingKPI's nets and the position's scores in storage.
  const claimFrom = wPos.migrationEpoch > wPos.lastClaimedEpoch + 1n ? wPos.migrationEpoch : wPos.lastClaimedEpoch + 1n;
  const pending = await claimPreview(c, w.tokenId, w.node, claimFrom, A, rawBefore);
  const expectedPayout = rawBefore + pending.total;
  const wOwner = await impersonate(ctx, w.owner);
  const ownerBal = await c.token.balanceOf(w.owner);
  const wd = await send(ctx, `token ${w.tokenId} owner: withdraw in the middle of epoch ${A + 1n}`, wOwner, snftAddr, c.snft.interface.encodeFunctionData('withdraw', [w.tokenId]));
  const paidOut = (await c.token.balanceOf(w.owner)) - ownerBal;
  const [withdrawnEv] = eventsIn(wd.receipt, c.sv10, c.sv10.getEvent('Withdrawn'));
  const [recordedEv] = eventsIn(wd.receipt, c.sv10, c.sv10.getEvent('WithdrawnEpochRecorded'));
  const recordedScore = await c.rss.getEpochNodeDelegatorScore(A + 1n, w.node, wKey);
  check(
    `the withdrawal pays the position's whole raw stake, rewards compounded (${fmt(paidOut)} TRAC)`,
    paidOut === expectedPayout && !!withdrawnEv && withdrawnEv.amount === paidOut,
    `expected ${fmt(expectedPayout)} = raw ${fmt(rawBefore)} before it + ${fmt(pending.total)} for epochs ${claimFrom}..${A} at StakingKPI's nets`,
  );
  check(
    `the withdrawal records epoch ${A + 1n} for the staker, with the position's score up to the withdrawal`,
    !!recordedEv && recordedEv.epoch === A + 1n && recordedEv.staker === w.owner && recordedScore === stayed && stayed > 0n,
    `score ${recordedScore}`,
  );
  check(`node ${SELLERS[0]} stays in the sharding table`, await c.sts.nodeExists(SELLERS[0]));
  // FORK-ONLY: the node's next proof in A + 1, after the withdrawal. The
  // withdrawn position's recorded score must not take any of it.
  await prove(w.node, `node ${w.node}'s next proof in epoch ${A + 1n}, after the withdrawal`);
  check(
    `a proof after the withdrawal leaves the recorded score of epoch ${A + 1n} as it was`,
    (await c.rss.getEpochNodeDelegatorScore(A + 1n, w.node, wKey)) === recordedScore,
  );
  check(
    'a position that had stayed through that proof would hold more score, by its share of the proof',
    stayedThroughLaterProof > stayed,
    `${stayedThroughLaterProof} staying vs ${stayed} withdrawn`,
  );
  const early2 = await expectRevert(
    ctx,
    `claimWithdrawnEpoch(${w.tokenId}) before epoch ${A + 1n} ends`,
    keeper.address,
    await c.sv10.getAddress(),
    c.sv10.interface.encodeFunctionData('claimWithdrawnEpoch', [w.tokenId]),
  );
  check('the withdrawn epoch cannot be claimed before it ends', early2.startsWith('WithdrawnEpochInProgress'), early2);
  out.withdrawal = {
    tokenId: w.tokenId,
    node: w.node,
    amount: paidOut,
    gasUsed: wd.gasUsed,
    recordedScore,
    stayedThroughLaterProof,
    epoch: A + 1n,
    expected: { raw: rawBefore, rewards: pending.total, fromEpoch: claimFrom, toEpoch: A, total: expectedPayout },
  };

  await closeAndPay({
    ctx,
    c,
    out,
    A,
    E0,
    actors: { hubOwner, walletBuyer, walletSession, keeper, nodeAdmin },
    feeNode,
    feeBalance0,
    vault,
    vault0,
    accountId,
    B,
    cost,
    publish,
    withdrawn: { position: w, paidOut, recordedScore },
    walletFundGas: walletFund.gasUsed,
  });
}
