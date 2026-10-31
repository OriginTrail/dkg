// Conviction Accounts pay at use time (OT-RFC-27, PublishingConviction 10.2.0,
// ServiceSubscriptions 1.2.0): a payment is booked when it is made, into its
// category's pool, in the epochs where the work it pays for is counted.
//
// Covered, on the real account stack with ServiceSubscriptions registered and
// a Hub-registered stand-in for KnowledgeAssetsLifecycle:
//   - a publish books its whole discounted draw over the Knowledge Asset's
//     epochs, with the spread of a wallet publish, and nothing else;
//   - a plan period's cost is due in QueryInferenceStorage in the epoch after
//     the period, funded now or ahead, with nothing in the staker pool;
//   - an account that 10.0.8 or 10.1.0 scheduled publishes exactly as before
//     (a budget gate, its top-up overflow forward over the lock) and is
//     refused services;
//   - a publish and a service spend in one window share its budget, and the
//     window books only what neither drew;
//   - top-up overflow on both paths, and the 1-wei floor on both paths;
//   - a use-time account never reaches the scheduled-account marker while its
//     lock is live, window by window to its last second.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, Result } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  DKGPublishingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  PublishingConviction,
  PublishingConvictionScheduleHarness,
  PublishingConvictionStorage,
  QueryInferenceStorage,
  ConvictionServiceStorage,
  ServiceSubscriptions,
  Token,
} from '../typechain';
import {
  ACCOUNT_STACK_TAGS,
  CLASS_INFERENCE,
  DAY,
  TRAC,
  Terms,
  bucket,
  costOf,
  registerServiceContracts,
  requestOf,
  signTerms,
  subscriptionIdOf,
  valueFor,
} from './helpers/conviction-service';
import { PoolModel, prorateActiveSink } from './helpers/emission-model';
import { deployScheduleHarness } from './helpers/scheduled-accounts';

const STAKER_SHARD_ID = 1n;
// The 20 % tier, with `committed mod lock` dust.
const COMMITTED = 50_000n * TRAC + 7n;
const BPS = 2_000n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  ES: EpochStorage;
  Params: ParametersStorage;
  NFT: DKGPublishingConvictionNFT;
  PC: PublishingConviction;
  PCS: PublishingConvictionStorage;
  QIS: QueryInferenceStorage;
  CSS: ConvictionServiceStorage;
  SS: ServiceSubscriptions;
  Harness: PublishingConvictionScheduleHarness;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { QIS, CSS, SS } = await registerServiceContracts(Hub);
  const Harness = await deployScheduleHarness(Hub);
  // A Hub-registered stand-in for KnowledgeAssetsLifecycle, the only caller the
  // NFT's coverPublishingCost admits.
  await Hub.setContractAddress('KnowledgeAssetsLifecycle', accounts[5].address);
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    ES: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
    QIS,
    CSS,
    SS,
    Harness,
  };
}

describe('@integration Conviction Accounts pay at use time (PublishingConviction 10.2.0)', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let ChronosContract: Chronos;
  let ES: EpochStorage;
  let Params: ParametersStorage;
  let NFT: DKGPublishingConvictionNFT;
  let PC: PublishingConviction;
  let PCS: PublishingConvictionStorage;
  let QIS: QueryInferenceStorage;
  let CSS: ConvictionServiceStorage;
  let SS: ServiceSubscriptions;
  let Harness: PublishingConvictionScheduleHarness;

  let epLen: bigint;
  let lock: bigint;
  let kal: SignerWithAddress;
  let owner: SignerWithAddress;
  let agent: SignerWithAddress;
  let buyer: SignerWithAddress;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Token, Chronos: ChronosContract, ES, Params, NFT, PC, PCS, QIS, CSS, SS, Harness } =
      await loadFixture(deployFixture));
    epLen = await ChronosContract.epochLength();
    lock = await Params.publishingConvictionEpochs();
    kal = accounts[5];
    owner = accounts[20];
    agent = accounts[21];
    buyer = accounts[22];
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const blockTime = async (receipt: ContractTransactionReceipt) =>
    BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);
  const epochNow = async () => ChronosContract.getCurrentEpoch();
  /** Time left in the current epoch at a block time, as Chronos computes it. */
  const timeLeftAt = async (ts: bigint) => {
    const start = await ChronosContract.startTime();
    return epLen - ((ts - start) % epLen);
  };

  /** A PCA of `owner`, with `agent` registered on it. */
  const createAccount = async (committed: bigint = COMMITTED) => {
    await Token.mint(owner.address, committed);
    await Token.connect(owner).approve(await NFT.getAddress(), committed);
    const receipt = (await (await NFT.connect(owner).createAccount(committed, 0)).wait())!;
    const accountId = await NFT.totalSupply();
    if ((await PCS.agentToAccountId(agent.address)) === 0n) {
      await NFT.connect(owner).registerAgent(accountId, agent.address);
    }
    return { accountId, createdAt: await blockTime(receipt) };
  };

  const topUp = async (accountId: bigint, amount: bigint) => {
    await Token.mint(owner.address, amount);
    await Token.connect(owner).approve(await NFT.getAddress(), amount);
    await NFT.connect(owner).topUp(accountId, amount);
  };

  /** Publish through the NFT as KnowledgeAssetsLifecycle does, for `agent`'s account. */
  const publish = async (baseCost: bigint, kaEpochs: bigint, kaStartEpoch?: bigint) =>
    (await (
      await NFT.connect(kal).coverPublishingCost(agent.address, baseCost, kaStartEpoch ?? (await epochNow()), kaEpochs)
    ).wait())!;

  /** Opt the account in and assign `buyer` under a limit no test reaches. */
  const openForServices = async (accountId: bigint) => {
    await SS.connect(owner).setServiceSpending(accountId, true);
    const terms: Terms = {
      accountId,
      assignee: buyer.address,
      maxCostPerPeriod: 1_000_000n * TRAC,
      expiresAt: BigInt(await time.latest()) + 800n * DAY,
      nonce: await CSS.assignmentNonce(accountId),
    };
    await SS.connect(owner).assign(terms, '0x', await signTerms(buyer, SS, terms));
  };

  const fund = async (accountId: bigint, value: bigint, epoch?: bigint) =>
    (await (
      await SS.connect(buyer).fundFromConviction(
        requestOf(accountId, epoch ?? (await epochNow()), { buckets: [bucket(0, CLASS_INFERENCE, value)] }),
      )
    ).wait())!;

  const eventsOf = async (receipt: ContractTransactionReceipt, contract: BaseContract, name: string) => {
    const address = (await contract.getAddress()).toLowerCase();
    const out: Result[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== address) continue;
      const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === name) out.push(parsed.args);
    }
    return out;
  };

  /** The staker-shard ranges a receipt credited, as [start, end, amount]. */
  const credits = async (receipt: ContractTransactionReceipt): Promise<bigint[][]> =>
    (await eventsOf(receipt, ES, 'TokensAddedToEpochRange'))
      .filter((a) => a.shardId === STAKER_SHARD_ID)
      .map((a) => [a.startEpoch, a.endEpoch, a.tokenAmount]);

  const sumOf = (ranges: bigint[][]) => ranges.reduce((s, r) => s + r[2], 0n);

  const poolSnapshot = async (from: bigint, to: bigint) => {
    const out = new Map<bigint, bigint>();
    for (let e = from; e <= to; e++) out.set(e, await ES.getEpochPool(STAKER_SHARD_ID, e));
    return out;
  };

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  it('a publish books its whole discounted draw over the Knowledge Asset epochs, as a wallet publish spreads its payment', async () => {
    const { accountId } = await createAccount();
    const e0 = await epochNow();
    const before = await poolSnapshot(e0, e0 + lock + 1n);
    const carry = await ES.accumulatedRemainder(STAKER_SHARD_ID);

    // A KA of 4 epochs, with a kaStartEpoch far from the current one: the
    // booking anchors at the current epoch, as the wallet path does.
    const kaEpochs = 4n;
    const baseCost = 1_000n * TRAC + 3n;
    const cost = costOf(baseCost, BPS);
    const receipt = await publish(baseCost, kaEpochs, e0 + 5n);
    const [covered] = await eventsOf(receipt, PC, 'CostCovered');
    expect([covered.discountedCost, covered.drawnFromEpoch, covered.drawnFromTopUp]).to.deep.equal([cost, cost, 0n]);

    // prorateActiveSink over the KA's epochs from the current epoch, with the
    // time left in it: KnowledgeAssetsLifecycle._distributeTokens' spread.
    const ts = await blockTime(receipt);
    const spread = prorateActiveSink(cost, e0, kaEpochs, epLen, await timeLeftAt(ts));
    expect(await credits(receipt)).to.deep.equal(spread.map((r) => [r.start, r.end, r.amount]));
    const model = new PoolModel(carry);
    for (const r of spread) model.add(r);
    const after = await poolSnapshot(e0, e0 + lock + 1n);
    for (const [e, v] of after) expect(v - before.get(e)!, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);

    // Nothing else is booked, and the draw is on the window.
    expect(await eventsOf(receipt, PC, 'EmissionScheduled')).to.have.length(0);
    expect(await PCS.windowSpent(accountId, 0n)).to.equal(cost);
    expect((await PCS.getAccount(accountId)).lastSettledWindow).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // Services
  // -------------------------------------------------------------------------

  it("a plan period's cost is due in the epoch after the period, funded now or ahead, and nothing reaches the staker pool", async () => {
    const { accountId } = await createAccount();
    await openForServices(accountId);
    const e0 = await epochNow();
    const before = await poolSnapshot(e0, e0 + 2n * lock + 2n);

    const now = await fund(accountId, 100n * TRAC + 1n);
    const ahead = await fund(accountId, 50n * TRAC, e0 + 1n);
    const nowCost = costOf(100n * TRAC + 1n, BPS);
    const aheadCost = costOf(50n * TRAC, BPS);

    for (const receipt of [now, ahead]) expect(await credits(receipt)).to.have.length(0);
    expect(await poolSnapshot(e0, e0 + 2n * lock + 2n)).to.deep.equal(before);
    expect(await QIS.convictionDue(e0)).to.equal(0n);
    expect(await QIS.convictionDue(e0 + 1n)).to.equal(nowCost);
    expect(await QIS.convictionDue(e0 + 2n)).to.equal(aheadCost);
    expect(await QIS.dueIn(e0 + 1n)).to.deep.equal([0n, nowCost]);
    expect(await PCS.windowSpent(accountId, 0n)).to.equal(nowCost + aheadCost);

    // A top-up of the current period is due with it.
    await SS.connect(buyer).topUpFromConviction(
      subscriptionIdOf(buyer.address, e0),
      [bucket(0, CLASS_INFERENCE, 10n * TRAC)],
      hre.ethers.id('plan-2'),
    );
    expect(await QIS.convictionDue(e0 + 1n)).to.equal(nowCost + costOf(10n * TRAC, BPS));
  });

  // -------------------------------------------------------------------------
  // Scheduled accounts
  // -------------------------------------------------------------------------

  it('an account that 10.0.8 or 10.1.0 scheduled publishes exactly as before, and is refused services', async () => {
    const { accountId } = await createAccount();
    await Harness.scheduleInFull(accountId);
    expect((await PCS.getAccount(accountId)).lastSettledWindow).to.equal(lock);
    const B = COMMITTED / lock;

    // Within the window budget: a budget gate only, nothing booked.
    const base = await publish(1_000n * TRAC, 4n);
    expect(await credits(base)).to.have.length(0);
    expect(await PCS.windowSpent(accountId, 0n)).to.equal(800n * TRAC);

    // Beyond it: only the top-up overflow, forward over the LOCK (not the
    // KA's 4 epochs) from the current epoch.
    await topUp(accountId, 1_000n * TRAC);
    const value = valueFor(B - 800n * TRAC + 300n * TRAC, BPS);
    const cost = costOf(value, BPS);
    const overflow = cost - (B - 800n * TRAC);
    const e0 = await epochNow();
    const receipt = await publish(value, 4n);
    const ts = await blockTime(receipt);
    expect(await credits(receipt)).to.deep.equal(
      prorateActiveSink(overflow, e0, lock, epLen, await timeLeftAt(ts)).map((r) => [r.start, r.end, r.amount]),
    );
    expect(await PCS.topUpBalance(accountId)).to.equal(1_000n * TRAC - overflow);

    // Services: the opt-in is refused, and so is a draw.
    await expect(SS.connect(owner).setServiceSpending(accountId, true))
      .to.be.revertedWithCustomError(SS, 'EmissionAlreadyScheduled')
      .withArgs(accountId);

    // Windows later, settle books nothing; at expiry only the top-up tail.
    await time.increase(3n * epLen);
    await expect(PC['settle(uint256)'](accountId)).to.not.emit(PC, 'EmissionScheduled');
    await time.increaseTo((await PCS.getAccount(accountId)).expiresAtTimestamp);
    const final = (await (await PC['settle(uint256)'](accountId)).wait())!;
    expect(await eventsOf(final, PC, 'EmissionScheduled')).to.have.length(0);
    const [swept] = await eventsOf(final, PC, 'AccountFinalSwept');
    expect(swept.topUpSwept).to.equal(1_000n * TRAC - overflow);
  });

  it('an account scheduled in full after it opted in has its draws refused through ServiceSubscriptions, with nothing drawn', async () => {
    const { accountId } = await createAccount();
    await openForServices(accountId);
    await Harness.scheduleInFull(accountId);
    await expect(SS.connect(buyer).fundFromConviction(requestOf(accountId, await epochNow())))
      .to.be.revertedWithCustomError(PC, 'EmissionAlreadyScheduled')
      .withArgs(accountId);
    expect(await PCS.windowSpent(accountId, 0n)).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // Mixed spending and edge cases
  // -------------------------------------------------------------------------

  it('a publish and a service spend in one window share its budget; once it closes, the window books only what neither drew', async () => {
    const { accountId, createdAt } = await createAccount();
    await openForServices(accountId);
    const B = COMMITTED / lock;
    const e0 = await epochNow();

    const published = await publish(1_000n * TRAC, lock); // 800 TRAC booked at once
    const funded = await fund(accountId, 500n * TRAC); // 400 TRAC due after the period
    expect(sumOf(await credits(published))).to.equal(800n * TRAC);
    expect(await credits(funded)).to.have.length(0);
    expect(await PCS.windowSpent(accountId, 0n)).to.equal(1_200n * TRAC);
    expect(await QIS.convictionDue(e0 + 1n)).to.equal(400n * TRAC);

    // Window 0 closes; the next touch books what is left of it.
    await time.increaseTo(createdAt + epLen);
    const settled = (await (await PC['settle(uint256)'](accountId)).wait())!;
    const [booked] = await eventsOf(settled, PC, 'EmissionScheduled');
    expect([booked.fromWindow, booked.toWindow, booked.scheduled, booked.treasuryFee]).to.deep.equal([
      0n,
      1n,
      B - 1_200n * TRAC,
      0n,
    ]);
    expect(sumOf(await credits(settled))).to.equal(B - 1_200n * TRAC);
    // Window 0 is fully paid for: the staker pool took the publish and the
    // rest, the query/inference pool the service, and nothing twice.
    expect(800n * TRAC + (B - 1_200n * TRAC) + 400n * TRAC).to.equal(B);
  });

  it('top-up overflow: a publish books the window part and the overflow together over the KA epochs; a service draw has both due', async () => {
    const B = COMMITTED / lock;
    // The publishing path.
    const { accountId: publishingId } = await createAccount();
    await topUp(publishingId, 2_000n * TRAC);
    const value = valueFor(B + 300n * TRAC, BPS);
    const cost = costOf(value, BPS);
    const e0 = await epochNow();
    const receipt = await publish(value, 6n);
    const [covered] = await eventsOf(receipt, PC, 'CostCovered');
    expect([covered.drawnFromEpoch, covered.drawnFromTopUp]).to.deep.equal([B, cost - B]);
    const ts = await blockTime(receipt);
    expect(await credits(receipt)).to.deep.equal(
      prorateActiveSink(cost, e0, 6n, epLen, await timeLeftAt(ts)).map((r) => [r.start, r.end, r.amount]),
    );
    expect(await PCS.topUpBalance(publishingId)).to.equal(2_000n * TRAC - (cost - B));

    // The service path, on a second account, which has no publishing agent.
    const { accountId: serviceId } = await createAccount();
    await openForServices(serviceId);
    await topUp(serviceId, 2_000n * TRAC);
    const funded = await fund(serviceId, value);
    const [drawn] = await eventsOf(funded, PC, 'ServiceCostCovered');
    expect([drawn.cost, drawn.drawnFromWindow, drawn.drawnFromTopUp]).to.deep.equal([cost, B, cost - B]);
    expect(await credits(funded)).to.have.length(0);
    expect(await QIS.convictionDue((await epochNow()) + 1n)).to.equal(cost);
    expect(await PCS.topUpBalance(serviceId)).to.equal(2_000n * TRAC - (cost - B));
  });

  it('the 1-wei floor holds on both paths: a 1-wei publish books 1 wei in the KA last epoch, and a value the discount rounds to 0 is due as 1 wei', async () => {
    // The 75 % tier: 3 wei is 0.75 wei after the discount.
    const { accountId } = await createAccount(1_000_000n * TRAC);
    await openForServices(accountId);
    const e0 = await epochNow();

    const receipt = await publish(1n, 2n);
    expect((await eventsOf(receipt, PC, 'CostCovered'))[0].discountedCost).to.equal(1n);
    expect(await credits(receipt)).to.deep.equal([[e0 + 2n, e0 + 2n, 1n]]);

    const funded = await fund(accountId, 3n);
    expect((await eventsOf(funded, PC, 'ServiceCostCovered'))[0].cost).to.equal(1n);
    expect(await credits(funded)).to.have.length(0);
    expect(await QIS.convictionDue(e0 + 1n)).to.equal(1n);
    expect(await PCS.windowSpent(accountId, 0n)).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // The marker
  // -------------------------------------------------------------------------

  it('a use-time account never reaches the scheduled-account marker while its lock is live, up to its last second', async () => {
    const { accountId, createdAt } = await createAccount();
    await openForServices(accountId);
    const expiresAt = (await PCS.getAccount(accountId)).expiresAtTimestamp;
    expect(expiresAt).to.equal(createdAt + lock * epLen);

    // At every window close while the lock is live, a touch moves the cursor
    // to the current window, below the lock.
    for (let w = 1n; w < lock; w++) {
      await time.increaseTo(createdAt + w * epLen);
      await PC['settle(uint256)'](accountId);
      const cursor = (await PCS.getAccount(accountId)).lastSettledWindow;
      expect(cursor, `window ${w}`).to.equal(w);
      expect(cursor < lock).to.equal(true);
    }

    // The last seconds of the lock: still a use-time account, which funds
    // and publishes at use time.
    await time.setNextBlockTimestamp(expiresAt - 3n);
    await PC['settle(uint256)'](accountId);
    expect((await PCS.getAccount(accountId)).lastSettledWindow).to.equal(lock - 1n);
    await time.setNextBlockTimestamp(expiresAt - 2n);
    const funded = await fund(accountId, 10n * TRAC);
    expect((await eventsOf(funded, PC, 'ServiceCostCovered'))[0].window).to.equal(lock - 1n);
    await time.setNextBlockTimestamp(expiresAt - 1n);
    const published = await publish(10n * TRAC, 1n);
    expect(sumOf(await credits(published))).to.equal(costOf(10n * TRAC, BPS));
    expect((await PCS.getAccount(accountId)).lastSettledWindow).to.equal(lock - 1n);

    // At expiry the last window closes, and the final sweep books it.
    await time.setNextBlockTimestamp(expiresAt);
    const final = (await (await PC['settle(uint256)'](accountId)).wait())!;
    const [booked] = await eventsOf(final, PC, 'EmissionScheduled');
    expect([booked.fromWindow, booked.toWindow]).to.deep.equal([lock - 1n, lock]);
    const acct = await PCS.getAccount(accountId);
    expect([acct.lastSettledWindow, acct.fullySwept]).to.deep.equal([lock, true]);
  });
});
