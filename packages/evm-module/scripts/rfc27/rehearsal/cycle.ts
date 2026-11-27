// PHASE cycle: one full marketplace cycle on the upgraded contracts, from the
// activation epoch A. In A: an operator fee for the first seller, a wallet subscription
// of A that no one serves, a wallet subscription of A + 1 funded ahead, a new Conviction
// Account opened for services and a subscription of A + 1 funded from it, a second
// account left untouched, and a publish. In A + 1, the pool epoch: batches refused
// until their sellers have proved; then the sellers' batches over one budget's
// funding, where the first to land counts whole and a later one counts what is
// left, and over another, where a minimum refuses less and a top-up lifts it; and a
// withdrawal in the middle of the epoch. In A + 2 (cycle-pay.ts): the claims, with
// nothing run first, the withdrawn epoch, the operator fee, the window booking.

import { ethers } from 'ethers';
import type { Signer } from 'ethers';

import { costOf, subscriptionIdOf } from '../../../test/helpers/conviction-service';
import type { ReceiptGroup } from '../../../test/helpers/query-inference';
import { Contracts, eventsIn } from '../contracts';
import type { NodeSigner } from '../fork';
import { chainNow } from '../network';
import { inference } from '../plans';
import { capturedFactorHolds, claimPreview, delegatorKey, expectedStakeFactor, groupFault, positionScore, receiptFault } from '../reads';
import { fmt, sum, toJson } from '../report';
import { Ctx, expectRevert, send, withPool } from './context';
import { payOut } from './cycle-pay';
import { accountRequest, approve, createAccount, fundTrac, openServiceAccount, publishAs, requestDomain, signedGroup, submitBatch, walletRequest } from './operations';
import { impersonate } from './plumbing';
import { positions, smallestOn, stakerCredits } from './reads';
import type { Position, PublishResult } from './results';
import { loadHub, loadPre } from './results';
import { CA_SUBSCRIPTION_VALUE, COMMITTED, LATE_COMMITTED, MAX_COST_PER_EPOCH, PUBLISH_BASE_COST, PUBLISH_KA_EPOCHS, ROLLED_VALUE, SELLERS, TRAC, WALLET_SUBSCRIPTION_VALUE, WALLET_TOP_UP } from './scenario';

const SCALE18 = 10n ** 18n;
const BPS = 10_000n;

/** What the cycle's epochs A and A + 1 leave for A + 2. */
export type CycleRun = {
  ctx: Ctx;
  c: Contracts;
  out: { [key: string]: unknown };
  A: bigint;
  E0: bigint;
  actors: { hubOwner: NodeSigner; walletBuyer: Signer & { address: string }; walletSession: Signer & { address: string }; keeper: Signer & { address: string }; nodeAdmin: Signer & { address: string } };
  feeNode: bigint;
  feeBalance0: bigint;
  vault: string;
  vault0: bigint;
  accountId: bigint;
  /** The account's per-window allowance. */
  B: bigint;
  cost: bigint;
  publish: PublishResult;
  /** The wallet subscription of the pool epoch, which a batch can no longer reach once its epoch has ended. */
  walletSubscription: string;
  /** The operational keys of the sellers, by node id. */
  operational: Record<string, string>;
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
  const [, walletBuyer, caOwner, buyer, caSession, agent, keeper, walletSession, nodeAdmin, lateOwner] = await ctx.hre.ethers.getSigners();
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

  // ---- epoch A: an operator fee, funding, publishing ----
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
  const profile = await ctx.stack.held('Profile');
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

  // A wallet subscription of A that no one serves, so no value counts in A and its
  // money rolls forward; and a wallet subscription of A + 1, funded ahead.
  await approve(ctx, 'wallet buyer: approve ServiceSubscriptionsWallet', walletBuyer, sswAddr, ROLLED_VALUE + WALLET_SUBSCRIPTION_VALUE + WALLET_TOP_UP);
  await send(
    ctx,
    `wallet buyer: fundFromWallet(epoch ${A}, ${fmt(ROLLED_VALUE)} TRAC), which no one serves`,
    walletBuyer,
    sswAddr,
    c.ssw.interface.encodeFunctionData('fundFromWallet', [walletRequest(A, walletSession.address, ROLLED_VALUE, 'rehearsal plan no one serves')]),
  );
  const walletFund = await send(
    ctx,
    `wallet buyer: fundFromWallet(epoch ${A + 1n}, ${fmt(WALLET_SUBSCRIPTION_VALUE)} TRAC), funded ahead`,
    walletBuyer,
    sswAddr,
    c.ssw.interface.encodeFunctionData('fundFromWallet', [walletRequest(A + 1n, walletSession.address, WALLET_SUBSCRIPTION_VALUE, 'rehearsal wallet plan')]),
  );
  const walletSubscription = subscriptionIdOf(walletBuyer.address, A + 1n);

  // A new 10.2.0 Conviction Account: create, opt in, add a buyer, fund a subscription of A + 1 from it.
  const opened = await openServiceAccount(ctx, c, {
    owner: caOwner,
    committed: COMMITTED,
    buyer,
    maxCostPerEpoch: MAX_COST_PER_EPOCH,
    addBuyerLabel: 'account owner: add the buyer (the buyer consents by EIP-712 signature)',
  });
  const { accountId, account: acct } = opened;
  const B = COMMITTED / acct.lockDurationEpochs;
  out.account = { accountId, discountBps: acct.discountBps, lock: acct.lockDurationEpochs, B, createdAtTimestamp: acct.createdAtTimestamp };
  check('createAccount books nothing to the staker pool (10.2.0)', stakerCredits(opened.created.receipt, c).length === 0);
  const caFund = await send(
    ctx,
    `buyer: fundFromAccount(account ${accountId}, epoch ${A + 1n}, ${fmt(CA_SUBSCRIPTION_VALUE)} TRAC value), funded ahead`,
    buyer,
    ssAddr,
    c.ss.interface.encodeFunctionData('fundFromAccount', [accountRequest(accountId, A + 1n, caSession.address, CA_SUBSCRIPTION_VALUE, 'rehearsal account plan')]),
  );
  const caSubscription = subscriptionIdOf(buyer.address, A + 1n);
  const [subscriptionFunded] = eventsIn(caFund.receipt, c.ss, c.ss.getEvent('SubscriptionFunded'));
  if (!subscriptionFunded) throw new Error('fundFromAccount emitted no SubscriptionFunded');
  const cost = subscriptionFunded.cost;
  check(
    'the account subscription books no staker credit and moves no TRAC',
    stakerCredits(caFund.receipt, c).length === 0 && eventsIn(caFund.receipt, c.token, c.token.getEvent('Transfer')).length === 0,
  );
  check(`the subscription's cost is the value at the account's discount (${fmt(cost)} TRAC)`, cost === costOf(CA_SUBSCRIPTION_VALUE, acct.discountBps));

  // A second 10.2.0 account, which nothing touches until the late-booking phase.
  const late = await createAccount(ctx, c, 'second account owner', lateOwner, LATE_COMMITTED);
  out.lateAccount = { accountId: late.accountId, committed: LATE_COMMITTED, createdAtTimestamp: late.account.createdAtTimestamp, lock: late.account.lockDurationEpochs };

  // A publish from the account.
  await send(ctx, 'account owner: registerAgent', caOwner, await c.nft.getAddress(), c.nft.interface.encodeFunctionData('registerAgent', [accountId, agent.address]));
  const publish = await publishAs(ctx, c.pc, accountId, agent.address, PUBLISH_BASE_COST, PUBLISH_KA_EPOCHS, 'fork-only (KnowledgeAssetsLifecycle impersonated):');
  check(
    'a use-time publish books its whole spend to the staker pool over the Knowledge Asset epochs',
    sum(publish.stakerCredits.map((x) => x.amount)) === publish.discountedCost && publish.stakerCredits.every((x) => x.start >= A && x.end <= A + PUBLISH_KA_EPOCHS),
    `${fmt(publish.discountedCost)} TRAC over ${JSON.stringify(toJson(publish.stakerCredits))}`,
  );
  const bookedInA = await c.qis.fundingIn(A);
  const bookedAhead = await c.qis.fundingIn(A + 1n);
  check(
    `each subscription's money is booked under its own epoch: wallet ${fmt(ROLLED_VALUE)} in ${A}; wallet ${fmt(WALLET_SUBSCRIPTION_VALUE)} and account cost ${fmt(cost)} in ${A + 1n}`,
    bookedInA.wallet === ROLLED_VALUE && bookedInA.account === 0n && bookedAhead.wallet === WALLET_SUBSCRIPTION_VALUE && bookedAhead.account === cost,
  );

  // FORK-ONLY: the active nodes keep scoring in epoch A, as they scored before the fork.
  for (const n of activeNodes) await prove(n, `node ${n} keeps scoring in epoch ${A} what it scored in ${E0 - 1n}`);

  const [first, second] = SELLERS;
  const opOf = (seller: bigint): string => {
    const op = operational[String(seller)];
    if (!op) throw new Error(`no operational key seen for node ${seller}`);
    return op;
  };
  const batchData = (groups: ReceiptGroup[]) => c.qs.interface.encodeFunctionData('submitReceiptBatch', [groups]);
  const qiDomain = await requestDomain(c);
  const ahead = await signedGroup({ domain: qiDomain, session: walletSession, subscriptionId: walletSubscription, seller: first, firstNonce: 900n, values: [TRAC], issuedAt: await chainNow(ctx.hre) });
  const aheadWhy = await expectRevert(ctx, `node ${first}: a batch for the subscription of ${A + 1n}, in ${A}`, opOf(first), qsAddr, batchData([ahead]));
  check(`a subscription funded ahead takes no batch before its epoch, even from a seller with a score`, aheadWhy === groupFault(0, 'OutsideEpoch'), aheadWhy);

  // ---- epoch A + 1, the pool epoch: serving, as batches count when they land ----
  await ctx.fork.warpTo((await c.chronos.timestampForEpoch(A + 1n)) + 120n);
  report.say(`\nEpoch ${await c.chronos.getCurrentEpoch()}: the sellers serve, and each batch counts as it lands`);
  const issuedAt = await chainNow(ctx.hre);
  const group = (session: Signer, subscriptionId: string, seller: bigint, firstNonce: bigint, values: bigint[], minCounted?: bigint) =>
    signedGroup({ domain: qiDomain, session, subscriptionId, seller, firstNonce, values, issuedAt, minCounted });

  // The first seller's work: 8 of the account budget's 10 at face value, 4 of the wallet budget's 5.
  const firstGroups = [
    await group(caSession, caSubscription, first, 0n, [2n * TRAC, 2n * TRAC, 4n * TRAC]),
    await group(walletSession, walletSubscription, first, 0n, [2n * TRAC, 2n * TRAC]),
  ];
  // The second seller's: 4 on the account budget, where only 2 will be left; 3 on
  // the wallet budget, which it takes in full or not at all.
  const secondGroups = [
    await group(caSession, caSubscription, second, 0n, [4n * TRAC]),
    await group(walletSession, walletSubscription, second, 0n, [3n * TRAC], 3n * TRAC),
  ];

  const noScore = await expectRevert(ctx, `node ${first}: a batch before its first proof of epoch ${A + 1n}`, opOf(first), qsAddr, batchData(firstGroups));
  check(`before its seller proves in epoch ${A + 1n}, a batch is refused`, noScore === `NoNodeScore(${first}, ${A + 1n})`, noScore);
  for (const n of activeNodes) await prove(n, `node ${n} scores in epoch ${A + 1n} what it scored in ${E0 - 1n}`);

  const batches: { seller: bigint; items: bigint; value: bigint; counted: bigint; stakeFactor18: bigint; gasUsed: bigint }[] = [];
  const land = async (seller: bigint, groups: ReceiptGroup[], label: string) => {
    const expectedFactor = await expectedStakeFactor(c, seller);
    const b = await submitBatch(ctx, c.qs, await impersonate(ctx, opOf(seller)), label, groups);
    const [acc] = eventsIn(b.receipt, c.qs, c.qs.getEvent('ReceiptBatchAccepted'));
    if (!acc) throw new Error(`node ${seller}'s batch emitted no ReceiptBatchAccepted`);
    batches.push({ seller, items: acc.itemCount, value: acc.value, counted: acc.counted, stakeFactor18: acc.stakeFactor18, gasUsed: b.gasUsed });
    return { accepted: acc, expectedFactor, groups: eventsIn(b.receipt, c.qs, c.qs.getEvent('ReceiptsLanded')) };
  };

  const firstLanded = await land(first, firstGroups, `node ${first} operational key: submitReceiptBatch (2 groups)`);
  check(`node ${first}, landing first, counts all it claimed`, firstLanded.accepted.value === 12n * TRAC && firstLanded.accepted.counted === 12n * TRAC, `${fmt(firstLanded.accepted.counted)} of ${fmt(firstLanded.accepted.value)} TRAC`);

  // minCounted: the wallet budget has 1 left, the group asks for at least 3, and the whole batch is refused.
  const walletLeft = await c.qs.budgetLeft(walletSubscription, 0);
  const refused = await expectRevert(ctx, `node ${second}: a batch whose wallet group wants 3 TRAC with ${fmt(walletLeft)} left`, opOf(second), qsAddr, batchData(secondGroups));
  check(`a group whose minimum is above what the budget has left refuses the whole batch`, walletLeft === 1n * TRAC && refused === groupFault(1, 'BelowMinCounted'), refused);

  // A top-up lifts it: the same receipts land, their nonces unspent by the refusal.
  const topUp = await send(
    ctx,
    `wallet buyer: topUpFromWallet(${fmt(WALLET_TOP_UP)} TRAC)`,
    walletBuyer,
    sswAddr,
    c.ssw.interface.encodeFunctionData('topUpFromWallet', [walletSubscription, inference(WALLET_TOP_UP), ethers.id('rehearsal wallet plan')]),
  );
  check(`the top-up joins the wallet budget and the money of epoch ${A + 1n}`, (await c.qs.budgetLeft(walletSubscription, 0)) === 1n * TRAC + WALLET_TOP_UP && (await c.qis.fundingIn(A + 1n)).wallet === WALLET_SUBSCRIPTION_VALUE + WALLET_TOP_UP);
  const secondLanded = await land(second, secondGroups, `node ${second} operational key: submitReceiptBatch (2 groups), after the top-up`);
  const [secondCa, secondWallet] = secondLanded.groups;
  check(
    `first landed, first counted: node ${first}'s 8 count whole, and node ${second}'s 4, landing later, count the 2 left`,
    !!secondCa && secondCa.subscriptionId === caSubscription && secondCa.value === 4n * TRAC && secondCa.counted === 2n * TRAC,
    `account budget: ${fmt(secondCa?.counted ?? 0n)} of ${fmt(secondCa?.value ?? 0n)} TRAC`,
  );
  check(
    `the top-up lets the same receipts land: node ${second}'s minimum of 3 is met, with the nonces the refusal left unspent`,
    !!secondWallet && secondWallet.subscriptionId === walletSubscription && secondWallet.counted === 3n * TRAC,
    `wallet budget: ${fmt(secondWallet?.counted ?? 0n)} of ${fmt(secondWallet?.value ?? 0n)} TRAC`,
  );
  const caLeft = await c.qs.budgetLeft(caSubscription, 0);
  const walletLeftAfter = await c.qs.budgetLeft(walletSubscription, 0);
  check(
    'the budgets read full at face value: the account budget has nothing left, and the wallet budget 1',
    caLeft === 0n && walletLeftAfter === 1n * TRAC && (await c.qis.budgetUsed(caSubscription, 0)) === CA_SUBSCRIPTION_VALUE && (await c.qis.budgetUsed(walletSubscription, 0)) === 7n * TRAC,
  );
  const again = await expectRevert(ctx, `node ${second}: the same account receipts again`, opOf(second), qsAddr, batchData(secondGroups.slice(0, 1)));
  check('what did not count stays spent: the same receipts cannot land again', again === receiptFault(0, 0, 'DuplicateNonce'), again);
  const onFull = await group(caSession, caSubscription, second, 100n, [TRAC], TRAC);
  const fullWhy = await expectRevert(ctx, `node ${second}: a fresh receipt on the full account budget, with a minimum`, opOf(second), qsAddr, batchData([onFull]));
  check('on a full budget, a group with a minimum is refused, and spends no nonce', fullWhy === groupFault(0, 'BelowMinCounted'), fullWhy);
  // With no minimum, the same receipt lands for nothing, and is spent. In a reverted snapshot, so the epoch's numbers below hold what the rest did.
  const noMinimum = await group(caSession, caSubscription, second, 101n, [TRAC]);
  const totalServedBefore = (await c.qis.getEpochTotals(A + 1n)).totalServed;
  const forNothing = await ctx.fork.inSnapshot(async () => {
    const sent = await submitBatch(ctx, c.qs, await impersonate(ctx, opOf(second)), `node ${second}: a fresh receipt on the full account budget, with no minimum (in a snapshot)`, [noMinimum]);
    const [ev] = eventsIn(sent.receipt, c.qs, c.qs.getEvent('ReceiptsLanded'));
    const spent = await expectRevert(ctx, `node ${second}: the same receipt again (in the snapshot)`, opOf(second), qsAddr, batchData([noMinimum]));
    return { value: ev?.value, counted: ev?.counted, spent, totalServed: (await c.qis.getEpochTotals(A + 1n)).totalServed };
  });
  check(
    'on a full budget, a group with no minimum lands for nothing, adds to no total, and its nonce stays spent',
    forNothing.value === TRAC && forNothing.counted === 0n && forNothing.totalServed === totalServedBefore && forNothing.spent === receiptFault(0, 0, 'DuplicateNonce'),
    `${fmt(forNothing.counted ?? 0n)} of ${fmt(forNothing.value ?? 0n)} TRAC; again: ${forNothing.spent}`,
  );
  out.batches = batches;

  // What counted, worked out without the contract: at the account's discount,
  // and each seller's at the stake factor its stake gives, read before its batch.
  const discounted = (x: bigint) => (x * (BPS - acct.discountBps)) / BPS;
  const scoreAt = (r: bigint, factor: bigint) => (r * factor) / SCALE18;
  const f1 = firstLanded.expectedFactor;
  const f2 = secondLanded.expectedFactor;
  check(
    'each batch captured the stake factor its node\'s stake gives, worked out without the batch, and above 0',
    capturedFactorHolds(firstLanded.accepted.stakeFactor18, f1) && capturedFactorHolds(secondLanded.accepted.stakeFactor18, f2),
    `expected ${f1}, ${f2}; captured ${firstLanded.accepted.stakeFactor18}, ${secondLanded.accepted.stakeFactor18}`,
  );
  const r1 = { ca: discounted(8n * TRAC), wallet: 4n * TRAC };
  const r2 = { ca: discounted(2n * TRAC), wallet: 3n * TRAC };
  const n1 = await c.qis.getNodeEpoch(first, A + 1n);
  const n2 = await c.qis.getNodeEpoch(second, A + 1n);
  const totals = await c.qis.getEpochTotals(A + 1n);
  check(
    `node ${first}'s R is the account's 8 at the discount and the wallet's 4; node ${second}'s the account's 2 at the discount and the wallet's 3`,
    n1.servedValue === r1.ca + r1.wallet && n2.servedValue === r2.ca + r2.wallet,
    `${fmt(n1.servedValue)} and ${fmt(n2.servedValue)} TRAC`,
  );
  check(
    'each node\'s score is its R at the stake factor its stake gives',
    n1.weightedValue === scoreAt(r1.ca, f1) + scoreAt(r1.wallet, f1) && n2.weightedValue === scoreAt(r2.ca, f2) + scoreAt(r2.wallet, f2),
    `factors ${f1}, ${f2}`,
  );
  check(`the full account budget's R is what was paid for it, its cost, ${fmt(cost)}`, r1.ca + r2.ca === cost);
  check(
    `the epoch's totals are the nodes', and it took λ ${await c.qis.lambdaBps()} when its first value counted`,
    totals.totalServed === n1.servedValue + n2.servedValue && totals.totalWeighted === n1.weightedValue + n2.weightedValue && totals.lambdaBps === (await c.qis.lambdaBps()),
    `ΣR ${fmt(totals.totalServed)}`,
  );
  out.funding = { walletSubscription, caSubscription, rolled: ROLLED_VALUE, walletValue: WALLET_SUBSCRIPTION_VALUE, topUp: WALLET_TOP_UP, topUpGas: topUp.gasUsed, caValue: CA_SUBSCRIPTION_VALUE, cost, publish };

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

  await payOut({
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
    walletSubscription,
    operational,
    withdrawn: { position: w, paidOut, recordedScore },
    walletFundGas: walletFund.gasUsed,
  });
}
