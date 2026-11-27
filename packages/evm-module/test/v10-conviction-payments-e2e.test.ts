// End to end (OT-RFC-27): one epoch of the marketplace, with exact numbers, on
// the development deploy of the account, staking and subscription stacks, with
// RandomSampling scoring the nodes. PublishingConviction 10.2.0,
// ServiceSubscriptions 1.2.0, QueryInferenceSettlement and StakingV10 10.1.0.
//
// Epoch e is one chain epoch. Nodes A and B each have one staker, of the same
// stake, and an operator fee of 10%, and λ is 0. Buyer 1 funds 100 TRAC from a
// wallet. Buyer 2 funds 100 from a Conviction Account with no discount tier
// (12,000 committed over 12 windows, so 1,000 per window), at a cost of 100.
// The epoch's publishing pool is 300. A proves twice and B once, so their
// scores are 2/3 and 1/3, and receipts land for A 75 and B 25. In the first
// second of e + 1, with nothing run in between, both stakers claim:
//
//                          A       B
//   marketplace pool      150      50    200 × 75/100 and 200 × 25/100
//   publishing pool       200     100    300 × 2/3 and 300 × 1/3
//   gross                 350     150
//   operator fee           35      15
//   staker               +315    +135
//
// The account's money joins the pool beside the wallet's, and the staker pool
// gets only what its window did not spend.

import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt, ContractTransactionResponse } from 'ethers';
import hre from 'hardhat';

import { STAKER_SHARD_ID, eventsOf } from './helpers/account-stack';
import { CLASS_INFERENCE, TRAC, budget, requestOf, subscriptionIdOf } from './helpers/conviction-service';
import { hardhatWallet, openConvictionAccount, queryInferenceDomain } from './helpers/query-inference';
import { RewardsHelpers, UNIT_PRICE, deployRewardsStack, rewardsHelpers } from './helpers/query-inference-rewards';

// A quarter of the 5M cap: a stake factor of exactly 1/2, and a proof's score
// over this stake leaves no remainder, so a node's only position takes all of
// the node's score and the stakers' numbers are exact.
const STAKE = 1_250_000n * TRAC;
const FEE_BPS = 1_000n;
// Under the first discount tier, over 12 windows.
const COMMITTED = 12_000n * TRAC;
const FUNDED = 100n * TRAC;

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  return deployRewardsStack();
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

describe('@integration A Conviction Account subscription reaches the query/inference pool, end to end', function () {
  let f: Fixture;
  let h: RewardsHelpers;
  const key = hardhatWallet(61);

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    h = rewardsHelpers({ f, domain: await queryInferenceDomain(f.QIS), firstAccount: 30, key });
  });

  const stakerCredits = (receipt: ContractTransactionReceipt) =>
    eventsOf(receipt, f.EpochStorage, 'TokensAddedToEpochRange').filter((a) => a.shardId === STAKER_SHARD_ID);

  it('a wallet and an account fund an epoch, nodes prove and receipts land in it, and in the first second of the next both stakers are paid, with nothing run in between', async () => {
    const [owner, buyer1, buyer2, stakerA, stakerB] = [
      f.accounts[20],
      f.accounts[21],
      f.accounts[22],
      f.accounts[10],
      f.accounts[11],
    ];
    const A = await h.createSeller(STAKE, FEE_BPS, stakerA);
    const B = await h.createSeller(STAKE, FEE_BPS, stakerB);
    const e = await h.epochNow();
    const vault = await h.vault();

    // λ applies at once to an epoch with no value yet.
    await h.forward(f.QIS, 'setLambdaBps', [0n]);

    // 1. The account, opted in with Buyer 2 added: no discount, and 1,000 per
    //    window.
    const { accountId } = await openConvictionAccount({
      ...f,
      owner,
      buyer: buyer2,
      committed: COMMITTED,
      limit: 1_000n * TRAC,
    });
    const account = await f.PCS.getAccount(accountId);
    expect([account.discountBps, account.lockDurationEpochs]).to.deep.equal([0n, 12n]);

    // 2. Buyer 1 pays from a wallet: the TRAC moves into the vault, and is booked
    //    in e itself.
    const vaultBeforeWallet = await h.balanceOf(vault);
    const walletSubscription = await h.walletFund(buyer1, e, FUNDED);
    expect((await h.balanceOf(vault)) - vaultBeforeWallet).to.equal(FUNDED);

    // 3. Buyer 2 funds from the account: no TRAC moves, the staker pool gets
    //    nothing, and the cost, 100 at no discount, is booked in e beside it.
    const vaultBeforeAccount = await h.balanceOf(vault);
    const funded = (await (
      await f.SS.connect(buyer2).fundFromAccount(
        requestOf(accountId, e, { budgets: [budget(0, CLASS_INFERENCE, FUNDED, UNIT_PRICE)], sessionKey: key.address }),
      )
    ).wait())!;
    const accountSubscription = subscriptionIdOf(buyer2.address, e);
    expect(stakerCredits(funded)).to.have.length(0);
    expect(await h.balanceOf(vault)).to.equal(vaultBeforeAccount);
    expect(await f.PCS.windowSpent(accountId, 0n)).to.equal(FUNDED);
    expect(await f.QIS.fundingIn(e)).to.deep.equal([FUNDED, FUNDED]);

    // 4. The epoch's publishing pool.
    await h.publishingPool(e, 300n * TRAC);
    expect(await f.EpochStorage.getEpochPool(STAKER_SHARD_ID, e)).to.equal(300n * TRAC);

    // 5. A node has to prove before its receipts land: A twice and B once, over
    //    the same stake, is 2/3 and 1/3.
    await expect(h.claimReceipts(A, walletSubscription, 50n * TRAC))
      .to.be.revertedWithCustomError(f.QS, 'NoNodeScore')
      .withArgs(A.identityId, e);
    const prove = await h.realProofs();
    await prove(A);
    await prove(A);
    await prove(B);
    const scoreB = await f.RSS.getNodeEpochScore(e, B.identityId);
    expect(scoreB).to.be.greaterThan(0n);
    expect(await f.RSS.getNodeEpochScore(e, A.identityId)).to.equal(2n * scoreB);
    expect(await f.RSS.getAllNodesEpochScore(e)).to.equal(3n * scoreB);

    // 6. Receipts count as they land: A 50 on the wallet's subscription and 25 on the
    //    account's, B 25 on the account's. Half of what was funded counts, and
    //    the pool is all of the money all the same.
    await h.claimReceipts(A, walletSubscription, 50n * TRAC);
    await h.claimReceipts(A, accountSubscription, 25n * TRAC);
    await h.claimReceipts(B, accountSubscription, 25n * TRAC);
    expect((await f.QIS.getNodeEpoch(A.identityId, e)).servedValue).to.equal(75n * TRAC);
    expect((await f.QIS.getNodeEpoch(B.identityId, e)).servedValue).to.equal(25n * TRAC);
    const totals = await f.QIS.getEpochTotals(e);
    expect([totals.totalServed, totals.lambdaBps]).to.deep.equal([100n * TRAC, 0n]);
    expect(await f.QS.budgetLeft(walletSubscription, 0n)).to.equal(50n * TRAC);
    expect(await f.QS.budgetLeft(accountSubscription, 0n)).to.equal(50n * TRAC);
    expect(await f.QS.epochPool(e)).to.equal(200n * TRAC);

    // StakingKPI already reads what the claims will pay.
    expect(await f.KPI.getNetNodeRewards(A.identityId, e)).to.equal(315n * TRAC);
    expect(await f.KPI.getNetNodeRewards(B.identityId, e)).to.equal(135n * TRAC);

    // 7. The first second of e + 1, with nothing run since the receipts: both
    //    claims land in that one block.
    expect(await h.epochNow()).to.equal(e);
    const boundary = await f.Chronos.timestampForEpoch(e + 1n);
    const vaultBeforeClaims = await h.balanceOf(vault);
    const owedBeforeClaims = await h.owed([A, B]);
    let claims: ContractTransactionResponse[];
    await hre.network.provider.send('evm_setAutomine', [false]);
    try {
      claims = [
        await f.StakingNFT.connect(stakerA).claim(A.tokenId),
        await f.StakingNFT.connect(stakerB).claim(B.tokenId),
      ];
      await time.setNextBlockTimestamp(boundary);
      await hre.network.provider.send('evm_mine');
    } finally {
      await hre.network.provider.send('evm_setAutomine', [true]);
    }
    const [claimA, claimB] = [(await claims[0].wait())!, (await claims[1].wait())!];
    expect(claimA.blockNumber).to.equal(claimB.blockNumber);
    expect(BigInt(await time.latest())).to.equal(boundary);

    // 8. The epoch's table, read from the contracts.
    expect(await f.QS.queryInferenceGross(e, A.identityId)).to.equal(150n * TRAC);
    expect(await f.QS.queryInferenceGross(e, B.identityId)).to.equal(50n * TRAC);
    const [splitA, splitB] = [await h.split(A, e), await h.split(B, e)];
    expect([splitA.publishing, splitB.publishing]).to.deep.equal([200n * TRAC, 100n * TRAC]);
    expect([splitA.gross, splitB.gross]).to.deep.equal([350n * TRAC, 150n * TRAC]);
    expect(await f.Vault.getOperatorFeeBalance(A.identityId)).to.equal(35n * TRAC);
    expect(await f.Vault.getOperatorFeeBalance(B.identityId)).to.equal(15n * TRAC);
    expect(await f.Vault.getNetNodeEpochRewards(A.identityId, e)).to.equal(315n * TRAC);
    expect(await f.Vault.getNetNodeEpochRewards(B.identityId, e)).to.equal(135n * TRAC);
    expect(eventsOf(claimA, f.StakingV10, 'RewardsClaimed')[0].amount).to.equal(315n * TRAC);
    expect(eventsOf(claimB, f.StakingV10, 'RewardsClaimed')[0].amount).to.equal(135n * TRAC);
    expect((await f.Vault.getPosition(A.tokenId)).raw).to.equal(STAKE + 315n * TRAC);
    expect((await f.Vault.getPosition(B.tokenId)).raw).to.equal(STAKE + 135n * TRAC);

    // A claim moves no TRAC, and nothing is left over: the vault now owes both
    // pools, all 500, to the stakers and the operators.
    expect(await h.balanceOf(vault)).to.equal(vaultBeforeClaims);
    expect((await h.owed([A, B])) - owedBeforeClaims).to.equal(500n * TRAC);

    // 9. The account's first window, booked on its next touch, gives the staker
    //    pool only what the subscription did not spend: nothing twice.
    await time.increaseTo(await f.Chronos.timestampForEpoch(e + 2n));
    const settled = (await (await f.NFT.settle(accountId)).wait())!;
    expect((await f.PCS.getAccount(accountId)).lastSettledWindow).to.equal(1n);
    expect(stakerCredits(settled).reduce((s, a) => s + a.tokenAmount, 0n)).to.equal(900n * TRAC);
    const window0 = (await f.PC.queryFilter(f.PC.filters.EmissionScheduled(accountId))).find(
      (ev) => ev.args.fromWindow === 0n,
    );
    expect(window0?.args.scheduled).to.equal(900n * TRAC);
  });
});
