// End to end (OT-RFC-27): a Conviction Account buyer funds a plan period, a
// Core Node seller claims receipts on it, the claims are finalized in the epoch
// after the period, and the close of that epoch puts the account's money in the
// query/inference pool, beside a wallet period's, while the staker pool gets
// none of it. PublishingConviction 10.2.0, ServiceSubscriptions 1.2.0 and
// QueryInferenceSettlement on the real account and staking stacks.

import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, Result } from 'ethers';
import hre from 'hardhat';

import { EpochStorage, PublishingConviction, PublishingConvictionStorage } from '../typechain';
import { CLASS_INFERENCE, TRAC, bucket, costOf, requestOf, subscriptionIdOf, walletRequestOf } from './helpers/conviction-service';
import {
  SettlementStack,
  createNode,
  deploySettlementStack,
  hardhatWallet,
  openConvictionAccount,
  queryInferenceDomain,
  scoreNode,
  signedItems,
} from './helpers/query-inference';

const UNIT_ASK = 10n ** 15n;
const PRICE_CAP = 10n ** 16n;
const STAKER_SHARD_ID = 1n;
// The 30 % tier.
const COMMITTED = 100_000n * TRAC;
const BPS = 3_000n;

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture(): Promise<SettlementStack> {
  return deploySettlementStack();
}

describe('@integration A Conviction Account period reaches the query/inference pool, end to end', function () {
  let f: SettlementStack;
  let ES: EpochStorage;
  let PC: PublishingConviction;
  let PCS: PublishingConvictionStorage;
  const key = hardhatWallet(61);

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    ES = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    PC = await hre.ethers.getContract<PublishingConviction>('PublishingConviction');
    PCS = await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage');
  });

  const latest = async () => BigInt(await time.latest());
  const epochNow = async () => f.Chronos.getCurrentEpoch();
  const epochStart = async (e: bigint) => f.Chronos.timestampForEpoch(e);

  const eventsOf = (receipt: ContractTransactionReceipt, contract: BaseContract, name: string) => {
    const out: Result[] = [];
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === name) out.push(parsed.args);
      } catch {
        // another contract's log
      }
    }
    return out;
  };

  const stakerCredits = (receipt: ContractTransactionReceipt) =>
    eventsOf(receipt, ES, 'TokensAddedToEpochRange').filter((a) => a.shardId === STAKER_SHARD_ID);

  it('a buyer funds a period from its account, a seller claims, finalization runs, and the close pays the account money to the seller', async () => {
    const [owner, buyer, walletBuyer, operational, admin] = [
      f.accounts[20],
      f.accounts[21],
      f.accounts[22],
      f.accounts[40],
      f.accounts[41],
    ];
    const seller = await createNode({ ...f, operational, admin, stake: 1_250_000n * TRAC });
    const domain = await queryInferenceDomain(f.QIS);
    const e = await epochNow();
    const vault = await f.Vault.getAddress();

    // 1. The account, opted in with the buyer key assigned.
    const { accountId } = await openConvictionAccount({
      ...f,
      owner,
      assignee: buyer,
      committed: COMMITTED,
      limit: 1_000n * TRAC,
    });
    const B = COMMITTED / (await f.Params.publishingConvictionEpochs());

    // 2. The buyer funds the period of e from the account: no TRAC moves, the
    //    staker pool gets nothing, and the cost is due in e + 1.
    const vaultBefore = await f.Token.balanceOf(vault);
    const value = 10n * TRAC;
    const cost = costOf(value, BPS);
    const funded = (await (
      await f.SS.connect(buyer).fundFromConviction(
        requestOf(accountId, e, { buckets: [bucket(0, CLASS_INFERENCE, value, PRICE_CAP)], sessionKey: key.address }),
      )
    ).wait())!;
    const period = subscriptionIdOf(buyer.address, e);
    expect(stakerCredits(funded)).to.have.length(0);
    expect(await f.Token.balanceOf(vault)).to.equal(vaultBefore);
    expect(await f.QIS.convictionDue(e + 1n)).to.equal(cost);
    expect(await PCS.windowSpent(accountId, 0n)).to.equal(cost);

    // A wallet period of the same epoch, for the pool beside it.
    await f.Token.mint(walletBuyer.address, 5n * TRAC);
    await f.Token.connect(walletBuyer).approve(await f.SSW.getAddress(), 5n * TRAC);
    await f.SSW.connect(walletBuyer).fundFromWallet(
      walletRequestOf(e, { buckets: [bucket(0, CLASS_INFERENCE, 5n * TRAC, PRICE_CAP)], sessionKey: key.address }),
    );
    const walletPeriod = subscriptionIdOf(walletBuyer.address, e);

    // 3. The seller claims receipts on both periods: 6 TRAC on the account's,
    //    under its discounted cap of 7, and 5 on the wallet's.
    const claim = async (subscriptionId: string, amount: bigint) => {
      const { items } = signedItems({
        domain,
        wallet: key,
        subscriptionId,
        bucketId: (await f.CSS.getBucket(subscriptionId, 0n)).bucketId,
        seller,
        count: 1,
        units: amount / UNIT_ASK,
        ask: UNIT_ASK,
        issuedAt: await latest(),
      });
      await f.QS.connect(operational).submitReceiptBatch([{ subscriptionId, bucketIndex: 0n, items }]);
    };
    await claim(period, 6n * TRAC);
    await claim(walletPeriod, 5n * TRAC);
    expect(await f.QS.fundedCap(period, 0n)).to.equal(cost);

    // 4. In e + 1, after the batch deadline, the claims are finalized.
    const deadline = (await epochStart(e + 1n)) + (await f.QIS.receiptGraceSecondsAt(e));
    await time.increaseTo(deadline + 1n);
    await scoreNode(f.RSS, e + 1n, seller);
    const finalized = (await (
      await f.QS.finalizeClaims([
        { subscriptionId: period, bucketIndex: 0n, seller },
        { subscriptionId: walletPeriod, bucketIndex: 0n, seller },
      ])
    ).wait())!;
    expect(eventsOf(finalized, f.QS, 'ClaimsFinalized').map((ev) => ev.value)).to.deep.equal([6n * TRAC, 5n * TRAC]);

    // 5. Once e + 1 has ended, its close counts the account's cost beside the
    //    wallet's value, and the seller, the only node with value, takes it all.
    await time.increaseTo(await epochStart(e + 2n));
    const closed = (await (await f.QS.closeEpochs(10n)).wait())!;
    const [close] = eventsOf(closed, f.QS, 'EpochClosed').filter((ev) => ev.epoch === e + 1n);
    expect([close.walletDue, close.convictionDue, close.carryIn, close.pool]).to.deep.equal([
      5n * TRAC,
      cost,
      0n,
      5n * TRAC + cost,
    ]);
    expect(await f.QS.epochPool(e + 1n)).to.equal(5n * TRAC + cost);
    expect(await f.QS.queryInferenceGross(e + 1n, seller)).to.equal(5n * TRAC + cost);

    // 6. The account's first window, booked on its next touch, gives the
    //    staker pool only what the period did not draw: nothing twice.
    const settled = (await (await f.NFT.settle(accountId)).wait())!;
    const booked = stakerCredits(settled).reduce((s, a) => s + a.tokenAmount, 0n);
    expect(booked).to.be.greaterThan(0n);
    const window0 = (await PC.queryFilter(PC.filters.EmissionScheduled(accountId))).find(
      (ev) => ev.args.fromWindow === 0n,
    );
    expect(window0?.args.scheduled).to.equal(
      B - cost + ((await PCS.getAccount(accountId)).lastSettledWindow - 1n) * B,
    );
  });
});
