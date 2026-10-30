// Plan-period funding for the query/inference pool (OT-RFC-27), end to end:
// QueryInferenceStorage, ConvictionServiceStorage, ServiceSubscriptions and
// ServiceSubscriptionsWallet registered in the Hub, on the real account stack.
//
// Groups:
//   - wallet funding: the whole value into the vault with no fee, even with a
//     treasury wired; the record under account 0 and PeriodFunded;
//   - the period: one epoch, the current one (from now to the boundary) or the
//     next (from its start), no other; one per buyer key and epoch, shared by
//     wallet and Conviction Account periods;
//   - the money due: in the epoch after the period, for fundings and top-ups
//     alike, whatever the receipt grace, which stays below one epoch;
//   - wallet top-ups and upgrades: caps unchanged, new buckets appended, the
//     value into the vault and due after the period;
//   - Conviction Account top-ups and upgrades: the draw and labels at the
//     account's tier, the period limit counting the period's earlier cost, and
//     the usage without another period;
//   - a Conviction Account period funded ahead, or topped up before it
//     starts, is refused if its assignment expires before the period starts;
//   - refusals: a zero key, before activation or while it is unset, paused, an
//     unknown or ended period, a wrong source or buyer, a changed cap, and the
//     bucket rules; each without partial effect.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, ethers, Result } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  Hub,
  ParametersStorage,
  PublishingConviction,
  QueryInferenceStorage,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  Token,
} from '../typechain';
import {
  ACCOUNT_STACK_TAGS,
  CLASS_INFERENCE,
  CLASS_QUERY,
  DAY,
  SESSION_KEY,
  TRAC,
  Terms,
  WalletRequest,
  activateQueryInference,
  bucket,
  costOf,
  registerServiceContracts,
  requestOf,
  setExactScheduleFrom,
  signTerms,
  subscriptionIdOf,
  walletRequestOf,
} from './helpers/conviction-service';

const COMMITTED = 100_000n * TRAC + 11n; // the 30 % tier
const BPS = 3_000n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Params: ParametersStorage;
  Vault: ConvictionStakingStorage;
  NFT: DKGPublishingConvictionNFT;
  PC: PublishingConviction;
  QIS: QueryInferenceStorage;
  CSS: ConvictionServiceStorage;
  SS: ServiceSubscriptions;
  SSW: ServiceSubscriptionsWallet;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { QIS, CSS, SS, SSW } = await registerServiceContracts(Hub, { wallet: true });
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    QIS,
    CSS,
    SS,
    SSW: SSW!,
  };
}

describe('@integration Plan-period funding for the query/inference pool', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let Token: Token;
  let ChronosContract: Chronos;
  let Params: ParametersStorage;
  let Vault: ConvictionStakingStorage;
  let NFT: DKGPublishingConvictionNFT;
  let PC: PublishingConviction;
  let QIS: QueryInferenceStorage;
  let CSS: ConvictionServiceStorage;
  let SS: ServiceSubscriptions;
  let SSW: ServiceSubscriptionsWallet;

  let epLen: bigint;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let stranger: SignerWithAddress;
  let treasury: SignerWithAddress;

  const use = (f: Fixture) => {
    ({
      accounts,
      Hub: HubContract,
      Token,
      Chronos: ChronosContract,
      Params,
      Vault,
      NFT,
      PC,
      QIS,
      CSS,
      SS,
      SSW,
    } = f);
    owner = accounts[20];
    buyer = accounts[21];
    buyer2 = accounts[22];
    stranger = accounts[23];
    treasury = accounts[28];
  };

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    use(await loadFixture(deployFixture));
    epLen = await ChronosContract.epochLength();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const latest = async () => BigInt(await time.latest());
  const blockTime = async (receipt: ContractTransactionReceipt) =>
    BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);
  const epochNow = async () => ChronosContract.getCurrentEpoch();
  const epochStart = async (e: bigint) => ChronosContract.timestampForEpoch(e);
  const plain = (r: unknown) => (r as Result).toObject();
  const vaultBalance = async () => Token.balanceOf(await Vault.getAddress());
  const forward = async (contract: BaseContract, fn: string, args: unknown[] = []) =>
    HubContract.forwardCall(await contract.getAddress(), contract.interface.encodeFunctionData(fn, args));

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

  /**
   * Point the Hub at a fresh QueryInferenceStorage whose activation epoch is
   * unset, and re-initialize both funding contracts onto it: the state between
   * a deployment's Hub transaction and its activation.
   */
  const useInactiveStorage = async () => {
    const fresh = (await (
      await hre.ethers.getContractFactory('QueryInferenceStorage')
    ).deploy(await HubContract.getAddress())) as unknown as QueryInferenceStorage;
    await fresh.waitForDeployment();
    await HubContract.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
    await forward(fresh, 'initialize');
    await forward(SS, 'initialize');
    await forward(SSW, 'initialize');
    QIS = fresh;
  };

  const tuples = (bs: Array<{ bucketId: string; serviceClass: bigint; value: bigint; maxAskWeiPerUnit: bigint }>) =>
    bs.map((b) => [b.bucketId, b.serviceClass, b.value, b.maxAskWeiPerUnit]);

  /** Approve the wallet contract for `amount` from `who`, minting it first. */
  const allow = async (who: SignerWithAddress, amount: bigint) => {
    await Token.mint(who.address, amount);
    await Token.connect(who).approve(await SSW.getAddress(), amount);
  };

  const valueOf = (r: { buckets: Array<{ value: bigint }> }) => r.buckets.reduce((a, b) => a + b.value, 0n);

  /** Fund a wallet period, with the approval it needs. */
  const walletFund = async (r: WalletRequest, sender: SignerWithAddress = buyer) => {
    await allow(sender, valueOf(r));
    const receipt = (await (await SSW.connect(sender).fundFromWallet(r)).wait())!;
    return { subscriptionId: subscriptionIdOf(sender.address, r.epoch), receipt };
  };

  /** A wallet top-up, with the approval it needs. */
  const walletTopUp = async (
    subscriptionId: string,
    additions: ReturnType<typeof bucket>[],
    sender: SignerWithAddress = buyer,
    planDigest: string = ethers.id('plan-topped-up'),
  ) => {
    await allow(sender, additions.reduce((a, b) => a + b.value, 0n));
    return (await (await SSW.connect(sender).topUpFromWallet(subscriptionId, additions, planDigest)).wait())!;
  };

  /** An opted-in account of `owner` with `assignee` assigned, under a per-period limit. */
  const openAccount = async (opts: { limit?: bigint; assignee?: SignerWithAddress; committed?: bigint } = {}) => {
    const committed = opts.committed ?? COMMITTED;
    await Token.mint(owner.address, committed);
    await Token.connect(owner).approve(await NFT.getAddress(), committed);
    await (await NFT.connect(owner).createAccount(committed, 0)).wait();
    const accountId = await NFT.totalSupply();
    await SS.connect(owner).setServiceSpending(accountId, true);
    await assign(accountId, opts.assignee ?? buyer, opts.limit ?? 1_000n * TRAC);
    return accountId;
  };

  const assign = async (accountId: bigint, assignee: SignerWithAddress, limit: bigint) => {
    const terms: Terms = {
      accountId,
      assignee: assignee.address,
      maxCostPerPeriod: limit,
      expiresAt: (await latest()) + 400n * DAY,
      nonce: await CSS.assignmentNonce(accountId),
    };
    await SS.connect(owner).assign(terms, '0x', await signTerms(assignee, SS, terms));
    return terms;
  };

  const caFund = async (accountId: bigint, epoch: bigint, value: bigint, sender: SignerWithAddress = buyer) => {
    const r = requestOf(accountId, epoch, { buckets: [bucket(0, CLASS_INFERENCE, value)] });
    const receipt = (await (await SS.connect(sender).fundFromConviction(r)).wait())!;
    return { subscriptionId: subscriptionIdOf(sender.address, epoch), receipt, r };
  };

  // -------------------------------------------------------------------------
  // Wallet funding
  // -------------------------------------------------------------------------

  describe('wallet funding', () => {
    it('moves the whole value into the vault, books it due after the period, records it under account 0 and emits PeriodFunded', async () => {
      const epoch = await epochNow();
      const r = walletRequestOf(epoch, {
        buckets: [bucket(0, CLASS_INFERENCE, 7n * TRAC + 3n), bucket(1, CLASS_QUERY, 3n * TRAC + 1n)],
      });
      const value = 10n * TRAC + 4n;
      await allow(buyer, value);
      const [buyerBefore, vaultBefore] = [await Token.balanceOf(buyer.address), await vaultBalance()];

      const returned = await SSW.connect(buyer).fundFromWallet.staticCall(r);
      const receipt = (await (await SSW.connect(buyer).fundFromWallet(r)).wait())!;
      const subscriptionId = subscriptionIdOf(buyer.address, epoch);
      expect(returned).to.equal(subscriptionId);
      expect(await SS.subscriptionIdOf(buyer.address, epoch)).to.equal(subscriptionId);
      const ts = await blockTime(receipt);
      const periodEnd = await epochStart(epoch + 1n);

      expect(await Token.balanceOf(buyer.address)).to.equal(buyerBefore - value);
      expect(await vaultBalance()).to.equal(vaultBefore + value);
      expect(await QIS.walletDue(epoch + 1n)).to.equal(value);
      expect(await QIS.walletDue(epoch)).to.equal(0n);

      expect(plain(await CSS.getSubscription(subscriptionId))).to.deep.equal({
        accountId: 0n,
        assignee: buyer.address,
        sessionKey: SESSION_KEY,
        periodId: ethers.toBeHex(epoch, 32),
        planDigest: r.planDigest,
        periodStart: ts,
        periodEnd,
        fundedEpoch: epoch,
        fundedWindow: 0n,
        discountBps: 0n,
        bucketCount: 2n,
        value,
        cost: value,
        drawnFromWindow: 0n,
        drawnFromTopUp: 0n,
      });
      expect(tuples(await CSS.getBuckets(subscriptionId))).to.deep.equal(tuples(r.buckets));
      expect(await CSS.accountSubscriptionCount(0n)).to.equal(1n);
      expect(await CSS.accountSubscriptionAt(0n, 0n)).to.equal(subscriptionId);

      const [pf] = await eventsOf(receipt, SSW, 'PeriodFunded');
      expect([
        pf.subscriptionId,
        pf.accountId,
        pf.assignee,
        pf.epoch,
        pf.sessionKey,
        pf.planDigest,
        pf.periodStart,
        pf.periodEnd,
        pf.value,
        pf.cost,
        pf.discountBps,
      ]).to.deep.equal([subscriptionId, 0n, buyer.address, epoch, SESSION_KEY, r.planDigest, ts, periodEnd, value, value, 0n]);
      expect(tuples(pf.buckets)).to.deep.equal(tuples(r.buckets));

      // The one token move is buyer -> vault, for the whole value.
      const tokenAddress = (await Token.getAddress()).toLowerCase();
      const transfers = receipt.logs
        .filter((l) => l.address.toLowerCase() === tokenAddress)
        .map((l) => Token.interface.parseLog({ topics: [...l.topics], data: l.data }))
        .filter((l) => l?.name === 'Transfer');
      expect(transfers.map((t) => [t!.args.from, t!.args.to, t!.args.value])).to.deep.equal([
        [buyer.address, await Vault.getAddress(), value],
      ]);
    });

    it('takes no fee with a protocol treasury wired: the whole value still lands in the vault', async () => {
      await Params.setProtocolTreasury(treasury.address);
      const vaultBefore = await vaultBalance();
      const treasuryBefore = await Token.balanceOf(treasury.address);
      const r = walletRequestOf(await epochNow(), { buckets: [bucket(0, CLASS_INFERENCE, 50n * TRAC)] });
      await walletFund(r);
      expect(await vaultBalance()).to.equal(vaultBefore + 50n * TRAC);
      expect(await Token.balanceOf(treasury.address)).to.equal(treasuryBefore);
      expect(await QIS.walletDue(r.epoch + 1n)).to.equal(50n * TRAC);
    });

    it('a short allowance or balance reverts in the Token, with no partial effect', async () => {
      const r = walletRequestOf(await epochNow());
      await Token.connect(buyer).approve(await SSW.getAddress(), valueOf(r) - 1n);
      await expect(SSW.connect(buyer).fundFromWallet(r)).to.be.revertedWithCustomError(Token, 'ERC20InsufficientAllowance');
      expect(await CSS.subscriptionExists(subscriptionIdOf(buyer.address, r.epoch))).to.equal(false);
      expect(await QIS.walletDue(r.epoch + 1n)).to.equal(0n);
    });

    it('applies the bucket rules: none, too many, unsorted, duplicate, zero value, unknown class, zero ask, a sum beyond uint96', async () => {
      const epoch = await epochNow();
      const max = Number(await CSS.maxBucketsPerPeriod());
      const many = (n: number) => Array.from({ length: n }, (_, i) => bucket(i, CLASS_INFERENCE, TRAC));
      const cases: Array<[ReturnType<typeof bucket>[], string]> = [
        [[], 'bucketCount'],
        [many(max + 1), 'bucketCount'],
        [[bucket(2, CLASS_INFERENCE, TRAC), bucket(1, CLASS_INFERENCE, TRAC)], 'bucketOrder'],
        [[bucket(1, CLASS_INFERENCE, TRAC), bucket(1, CLASS_QUERY, TRAC)], 'bucketOrder'],
        [[bucket(1, CLASS_INFERENCE, 0n)], 'bucketValue'],
        [[bucket(1, 0n, TRAC)], 'serviceClass'],
        [[bucket(1, 3n, TRAC)], 'serviceClass'],
        [[bucket(1, CLASS_QUERY, TRAC, 0n)], 'maxAskWeiPerUnit'],
        [[bucket(1, CLASS_INFERENCE, (1n << 96n) - 1n), bucket(2, CLASS_QUERY, 1n)], 'value'],
      ];
      for (const [buckets, reason] of cases) {
        await expect(SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch, { buckets })), reason)
          .to.be.revertedWithCustomError(SSW, 'InvalidFundingRequest')
          .withArgs(reason);
      }
      await walletFund(walletRequestOf(epoch, { buckets: many(max) }));
    });
  });

  // -------------------------------------------------------------------------
  // The period
  // -------------------------------------------------------------------------

  describe('the period: one epoch, the current or the next', () => {
    it('a current-epoch period funded mid-epoch runs from now to the epoch boundary', async () => {
      await time.increase(epLen / 3n);
      const epoch = await epochNow();
      const { subscriptionId, receipt } = await walletFund(walletRequestOf(epoch));
      const s = await CSS.getSubscription(subscriptionId);
      const ts = await blockTime(receipt);
      expect(ts).to.be.greaterThan(await epochStart(epoch));
      expect([s.periodStart, s.periodEnd]).to.deep.equal([ts, await epochStart(epoch + 1n)]);
    });

    it('a period funded ahead for the next epoch starts at that epoch, and its money is due the epoch after', async () => {
      const next = (await epochNow()) + 1n;
      const r = walletRequestOf(next);
      const { subscriptionId } = await walletFund(r);
      const s = await CSS.getSubscription(subscriptionId);
      expect([s.periodStart, s.periodEnd, s.fundedEpoch]).to.deep.equal([
        await epochStart(next),
        await epochStart(next + 1n),
        next - 1n,
      ]);
      expect(await QIS.walletDue(next + 1n)).to.equal(valueOf(r));
      expect(await QIS.walletDue(next)).to.equal(0n);

      // The same for a Conviction Account period.
      await setExactScheduleFrom(HubContract, CSS);
      const accountId = await openAccount({ assignee: buyer2 });
      const ca = await caFund(accountId, next, 10n * TRAC, buyer2);
      const record = await CSS.getSubscription(ca.subscriptionId);
      expect([record.periodStart, record.periodEnd]).to.deep.equal([await epochStart(next), await epochStart(next + 1n)]);
    });

    it('any other epoch is refused, for a wallet period and an account period alike', async () => {
      await setExactScheduleFrom(HubContract, CSS);
      const accountId = await openAccount();
      await time.increase(2n * epLen);
      const now = await epochNow();
      for (const epoch of [0n, 1n, now - 1n, now + 2n, now + 1_000n]) {
        await expect(SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch)), `wallet, epoch ${epoch}`)
          .to.be.revertedWithCustomError(SSW, 'InvalidFundingRequest')
          .withArgs('epoch');
        await expect(
          SS.connect(buyer).fundFromConviction(requestOf(accountId, epoch)),
          `account, epoch ${epoch}`,
        )
          .to.be.revertedWithCustomError(SS, 'InvalidFundingRequest')
          .withArgs('epoch');
      }
    });

    it('one period per buyer key and epoch, shared by wallet and account periods; another buyer key funds its own', async () => {
      await setExactScheduleFrom(HubContract, CSS);
      const accountId = await openAccount();
      const now = await epochNow();

      const { subscriptionId } = await walletFund(walletRequestOf(now));
      await allow(buyer, 10n * TRAC);
      await expect(SSW.connect(buyer).fundFromWallet(walletRequestOf(now)))
        .to.be.revertedWithCustomError(SSW, 'PeriodAlreadyFunded')
        .withArgs(subscriptionId);
      await expect(SS.connect(buyer).fundFromConviction(requestOf(accountId, now)))
        .to.be.revertedWithCustomError(SS, 'PeriodAlreadyFunded')
        .withArgs(subscriptionId);

      // The next epoch from an account, and then not from a wallet.
      const next = await caFund(accountId, now + 1n, 10n * TRAC);
      await expect(SSW.connect(buyer).fundFromWallet(walletRequestOf(now + 1n)))
        .to.be.revertedWithCustomError(SSW, 'PeriodAlreadyFunded')
        .withArgs(next.subscriptionId);

      // Another buyer key has its own period for the same epoch.
      const other = await walletFund(walletRequestOf(now), buyer2);
      expect(other.subscriptionId).to.not.equal(subscriptionId);
      expect(await CSS.accountSubscriptionCount(0n)).to.equal(2n);
    });

    it('after the boundary, the next epoch is the current one and the epoch after it can be funded ahead', async () => {
      const now = await epochNow();
      await walletFund(walletRequestOf(now));
      await walletFund(walletRequestOf(now + 1n));
      await time.increaseTo(await epochStart(now + 1n));
      await expect(SSW.connect(buyer).fundFromWallet(walletRequestOf(now)))
        .to.be.revertedWithCustomError(SSW, 'InvalidFundingRequest')
        .withArgs('epoch');
      await walletFund(walletRequestOf(now + 2n));
      expect(await QIS.walletDue(now + 3n)).to.equal(10n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // The money due
  // -------------------------------------------------------------------------

  describe('the money due', () => {
    it('is booked to the epoch after the period, never the funding epoch, summing per epoch over buyers and top-ups', async () => {
      const now = await epochNow();
      const a = await walletFund(walletRequestOf(now, { buckets: [bucket(0, CLASS_INFERENCE, 4n * TRAC)] }));
      await walletFund(walletRequestOf(now, { buckets: [bucket(0, CLASS_QUERY, 6n * TRAC)] }), buyer2);
      await walletTopUp(a.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)]);
      expect(await QIS.walletDue(now)).to.equal(0n);
      expect(await QIS.walletDue(now + 1n)).to.equal(11n * TRAC);
      expect(await QIS.walletDue(now + 2n)).to.equal(0n);
    });

    it('the receipt grace stays below one epoch, so the batch deadline always falls in the due epoch; a change to it moves no booking', async () => {
      for (const bad of [0n, epLen]) {
        await expect(forward(QIS, 'setReceiptGraceSeconds', [bad]))
          .to.be.revertedWithCustomError(QIS, 'InvalidParameter')
          .withArgs('receiptGraceSeconds');
      }
      // A change applies to the next epoch's periods: fund one, under the longest grace.
      await forward(QIS, 'setReceiptGraceSeconds', [epLen - 1n]);
      const next = (await epochNow()) + 1n;
      const { subscriptionId } = await walletFund(walletRequestOf(next));
      const s = await CSS.getSubscription(subscriptionId);
      expect(await QIS.receiptGraceSecondsAt(next)).to.equal(epLen - 1n);
      const deadline = s.periodEnd + (await QIS.receiptGraceSecondsAt(next));
      expect(await ChronosContract.epochAtTimestamp(deadline)).to.equal(next + 1n);
      expect(await QIS.walletDue(next + 1n)).to.equal(10n * TRAC);

      // A later change to the grace leaves the booking, and later bookings, in the same epoch.
      await forward(QIS, 'setReceiptGraceSeconds', [60n]);
      await walletTopUp(subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)]);
      expect(await QIS.walletDue(next + 1n)).to.equal(11n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // Wallet top-ups and upgrades
  // -------------------------------------------------------------------------

  describe('wallet top-ups and upgrades', () => {
    let subscriptionId: string;
    let epoch: bigint;
    const first = () => bucket(1, CLASS_INFERENCE, 6n * TRAC, 2_000n);
    const second = () => bucket(4, CLASS_QUERY, 4n * TRAC, 50n);

    beforeEach(async () => {
      epoch = await epochNow();
      ({ subscriptionId } = await walletFund(walletRequestOf(epoch, { buckets: [first(), second()] })));
    });

    it('a top-up adds to stored buckets and an upgrade appends new ones, at the period end, with the value into the vault', async () => {
      const additions = [
        bucket(0, CLASS_QUERY, 2n * TRAC, 70n), // new, sorts first but is appended last
        { ...first(), value: TRAC }, // tops up index 0
        bucket(9, CLASS_INFERENCE, 3n * TRAC, 900n), // new
      ];
      const vaultBefore = await vaultBalance();
      const planDigest = ethers.id('plan-2');
      const receipt = await walletTopUp(subscriptionId, additions, buyer, planDigest);

      expect(await vaultBalance()).to.equal(vaultBefore + 6n * TRAC);
      expect(await QIS.walletDue(epoch + 1n)).to.equal(16n * TRAC);
      expect(tuples(await CSS.getBuckets(subscriptionId))).to.deep.equal(
        tuples([
          { ...first(), value: 7n * TRAC },
          second(),
          bucket(0, CLASS_QUERY, 2n * TRAC, 70n),
          bucket(9, CLASS_INFERENCE, 3n * TRAC, 900n),
        ]),
      );
      const s = await CSS.getSubscription(subscriptionId);
      expect([s.value, s.cost, s.bucketCount, s.planDigest, s.drawnFromWindow, s.drawnFromTopUp]).to.deep.equal([
        16n * TRAC,
        16n * TRAC,
        4n,
        planDigest,
        0n,
        0n,
      ]);

      const [ev] = await eventsOf(receipt, SSW, 'PeriodToppedUp');
      expect([ev.subscriptionId, ev.accountId, ev.assignee, ev.value, ev.cost, ev.planDigest]).to.deep.equal([
        subscriptionId,
        0n,
        buyer.address,
        6n * TRAC,
        6n * TRAC,
        planDigest,
      ]);
      expect(tuples(ev.additions)).to.deep.equal(tuples(additions));
    });

    it('a period funded ahead is topped up before it starts', async () => {
      const next = await walletFund(walletRequestOf(epoch + 1n));
      await walletTopUp(next.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)]);
      expect((await CSS.getSubscription(next.subscriptionId)).value).to.equal(11n * TRAC);
      expect(await QIS.walletDue(epoch + 2n)).to.equal(11n * TRAC);
    });

    it('caps never change within a period: a stored bucket must repeat its class and price cap', async () => {
      for (const changed of [
        { ...first(), maxAskWeiPerUnit: 2_001n },
        { ...first(), serviceClass: CLASS_QUERY },
        { ...second(), maxAskWeiPerUnit: 49n },
      ]) {
        await expect(SSW.connect(buyer).topUpFromWallet(subscriptionId, [changed], ethers.ZeroHash))
          .to.be.revertedWithCustomError(SSW, 'BucketTermsChanged')
          .withArgs(changed.bucketId);
      }
    });

    it('applies the bucket rules to the additions, and to the period as a whole', async () => {
      const max = Number(await CSS.maxBucketsPerPeriod());
      const fresh = (n: number) => Array.from({ length: n }, (_, i) => bucket(100 + i, CLASS_INFERENCE, TRAC));
      const cases: Array<[ReturnType<typeof bucket>[], string]> = [
        [[], 'bucketCount'],
        [fresh(max - 1), 'bucketCount'], // two stored plus max − 1 new
        [[bucket(5, CLASS_INFERENCE, TRAC), bucket(3, CLASS_INFERENCE, TRAC)], 'bucketOrder'],
        [[{ ...first(), value: TRAC }, { ...first(), value: TRAC }], 'bucketOrder'],
        [[{ ...first(), value: 0n }], 'bucketValue'],
        [[bucket(7, CLASS_INFERENCE, 0n)], 'bucketValue'],
        [[bucket(7, 3n, TRAC)], 'serviceClass'],
        [[bucket(7, CLASS_QUERY, TRAC, 0n)], 'maxAskWeiPerUnit'],
        [[{ ...first(), value: (1n << 96n) - 1n }], 'value'],
      ];
      for (const [additions, reason] of cases) {
        await expect(SSW.connect(buyer).topUpFromWallet(subscriptionId, additions, ethers.ZeroHash), reason)
          .to.be.revertedWithCustomError(SSW, 'InvalidFundingRequest')
          .withArgs(reason);
      }
      await walletTopUp(subscriptionId, fresh(max - 2));
      expect((await CSS.getSubscription(subscriptionId)).bucketCount).to.equal(BigInt(max));
    });

    it('refuses an unknown period, another buyer key, an account period, and a period that has ended, with no partial effect', async () => {
      const unknown = ethers.id('never-funded');
      await expect(SSW.connect(buyer).topUpFromWallet(unknown, [first()], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SSW, 'PeriodNotFound')
        .withArgs(unknown);
      await allow(stranger, TRAC);
      await expect(SSW.connect(stranger).topUpFromWallet(subscriptionId, [first()], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SSW, 'NotPeriodBuyer')
        .withArgs(subscriptionId, stranger.address);

      await setExactScheduleFrom(HubContract, CSS);
      const accountId = await openAccount();
      const ca = await caFund(accountId, epoch + 1n, 10n * TRAC);
      await expect(SSW.connect(buyer).topUpFromWallet(ca.subscriptionId, [ca.r.buckets[0]], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SSW, 'WrongFundingSource')
        .withArgs(ca.subscriptionId, accountId);
      await expect(SS.connect(buyer).topUpFromConviction(subscriptionId, [first()], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'WrongFundingSource')
        .withArgs(subscriptionId, 0n);

      const s = await CSS.getSubscription(subscriptionId);
      await time.increaseTo(s.periodEnd);
      await expect(SSW.connect(buyer).topUpFromWallet(subscriptionId, [{ ...first(), value: TRAC }], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SSW, 'PeriodEnded')
        .withArgs(subscriptionId, s.periodEnd);
      expect(plain(await CSS.getSubscription(subscriptionId))).to.deep.equal(plain(s));
      expect(await QIS.walletDue(epoch + 1n)).to.equal(10n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // Conviction Account top-ups and upgrades
  // -------------------------------------------------------------------------

  describe('Conviction Account top-ups and upgrades', () => {
    let accountId: bigint;
    let subscriptionId: string;
    let epoch: bigint;

    beforeEach(async () => {
      await setExactScheduleFrom(HubContract, CSS);
      accountId = await openAccount({ limit: 30n * TRAC });
      epoch = await epochNow();
      ({ subscriptionId } = await caFund(accountId, epoch, 20n * TRAC));
    });

    it('draws at the account tier, labels the cost, adds to the record and counts no new period', async () => {
      const additions = [bucket(0, CLASS_INFERENCE, 10n * TRAC), bucket(3, CLASS_QUERY, 5n * TRAC)];
      const cost = costOf(15n * TRAC, BPS);
      const vaultBefore = await vaultBalance();
      const returned = await SS.connect(buyer).topUpFromConviction.staticCall(subscriptionId, additions, ethers.id('p2'));
      expect(returned).to.equal(cost);
      const receipt = (await (await SS.connect(buyer).topUpFromConviction(subscriptionId, additions, ethers.id('p2'))).wait())!;

      const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
      expect([covered.subscriptionId, covered.value, covered.cost]).to.deep.equal([subscriptionId, 15n * TRAC, cost]);
      const labels = await eventsOf(receipt, SS, 'ServiceEmissionLabelled');
      expect(labels.map((l) => [l.subscriptionId, l.amount])).to.deep.equal([[subscriptionId, cost]]);

      const s = await CSS.getSubscription(subscriptionId);
      const fundedCost = costOf(20n * TRAC, BPS);
      expect([s.value, s.cost, s.drawnFromWindow + s.drawnFromTopUp, s.bucketCount]).to.deep.equal([
        35n * TRAC,
        fundedCost + cost,
        fundedCost + cost,
        2n,
      ]);
      expect(tuples(await CSS.getBuckets(subscriptionId))).to.deep.equal(
        tuples([bucket(0, CLASS_INFERENCE, 30n * TRAC), bucket(3, CLASS_QUERY, 5n * TRAC)]),
      );
      expect((await CSS.getUsage(accountId, buyer.address)).periods).to.equal(1n);
      expect(await CSS.accountServiceLabelTotal(accountId)).to.equal(fundedCost + cost);
      // No TRAC moves, and nothing is booked to the wallet ledger.
      expect(await vaultBalance()).to.equal(vaultBefore);
      expect(await QIS.walletDue(epoch + 1n)).to.equal(0n);

      const [ev] = await eventsOf(receipt, SS, 'PeriodToppedUp');
      expect([ev.subscriptionId, ev.accountId, ev.assignee, ev.value, ev.cost, ev.planDigest]).to.deep.equal([
        subscriptionId,
        accountId,
        buyer.address,
        15n * TRAC,
        cost,
        ethers.id('p2'),
      ]);
    });

    it("the period limit counts the period's earlier cost, under the limit stored at this block", async () => {
      // 20 TRAC cost 14 at the 30 % tier; the limit is 30.
      const room = valueFor(30n * TRAC - costOf(20n * TRAC, BPS));
      await expect(SS.connect(buyer).topUpFromConviction(subscriptionId, [bucket(0, CLASS_INFERENCE, room + 2n)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'CapExceeded')
        .withArgs('maxCostPerPeriod', 30n * TRAC, costOf(20n * TRAC, BPS) + costOf(room + 2n, BPS));
      await SS.connect(owner).updateAssignmentCaps(accountId, buyer.address, {
        maxCostPerPeriod: 40n * TRAC,
        expiresAt: (await CSS.getAssignment(accountId, buyer.address)).expiresAt,
      });
      await SS.connect(buyer).topUpFromConviction(subscriptionId, [bucket(0, CLASS_INFERENCE, room + 2n)], ethers.ZeroHash);
    });

    it('needs the opt-in and a live assignment, from the period buyer key, before the period ends', async () => {
      const add = [bucket(0, CLASS_INFERENCE, TRAC)];
      await expect(SS.connect(buyer2).topUpFromConviction(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'NotPeriodBuyer')
        .withArgs(subscriptionId, buyer2.address);
      await SS.connect(owner).setServiceSpending(accountId, false);
      await expect(SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);
      await SS.connect(owner).setServiceSpending(accountId, true);
      await SS.connect(owner).revoke(accountId, buyer.address);
      await expect(SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'AssignmentRevoked')
        .withArgs(accountId, buyer.address);
      await assign(accountId, buyer, 30n * TRAC);
      await SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash);

      const s = await CSS.getSubscription(subscriptionId);
      await time.increaseTo(s.periodEnd);
      await expect(SS.connect(buyer).topUpFromConviction(subscriptionId, add, ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'PeriodEnded')
        .withArgs(subscriptionId, s.periodEnd);
    });

    it('caps never change within a period, and an unknown period is refused', async () => {
      await expect(SS.connect(buyer).topUpFromConviction(subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC, 1n)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'BucketTermsChanged')
        .withArgs(bucket(0, CLASS_INFERENCE, TRAC).bucketId);
      const unknown = ethers.id('never-funded');
      await expect(SS.connect(buyer).topUpFromConviction(unknown, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'PeriodNotFound')
        .withArgs(unknown);
    });
  });

  // -------------------------------------------------------------------------
  // A Conviction Account period funded ahead
  // -------------------------------------------------------------------------

  describe('a Conviction Account period funded ahead', () => {
    let accountId: bigint;
    let now: bigint;
    let nextStart: bigint;

    beforeEach(async () => {
      await setExactScheduleFrom(HubContract, CSS);
      accountId = await openAccount({ limit: 100n * TRAC });
      now = await epochNow();
      nextStart = await epochStart(now + 1n);
    });

    const expireAt = async (expiresAt: bigint) =>
      SS.connect(owner).updateAssignmentCaps(accountId, buyer.address, { maxCostPerPeriod: 100n * TRAC, expiresAt });

    it('is refused if the assignment expires at or before the next epoch starts, and accepted a second later', async () => {
      for (const expiresAt of [nextStart - 1n, nextStart]) {
        await expireAt(expiresAt);
        await expect(SS.connect(buyer).fundFromConviction(requestOf(accountId, now + 1n)))
          .to.be.revertedWithCustomError(SS, 'AssignmentEndsBeforePeriod')
          .withArgs(accountId, buyer.address, expiresAt, nextStart);
        expect(await CSS.subscriptionExists(subscriptionIdOf(buyer.address, now + 1n))).to.equal(false);
        expect(await CSS.accountServiceLabelTotal(accountId)).to.equal(0n);
      }
      await expireAt(nextStart + 1n);
      await caFund(accountId, now + 1n, 10n * TRAC);
    });

    it("the same assignment still funds the current epoch's period, which it serves until it expires", async () => {
      await expireAt(nextStart - 1n);
      const { subscriptionId } = await caFund(accountId, now, 10n * TRAC);
      expect((await CSS.getSubscription(subscriptionId)).periodEnd).to.equal(nextStart);
    });

    it('a period funded ahead is not topped up once its assignment is set to expire before it starts', async () => {
      const ahead = await caFund(accountId, now + 1n, 10n * TRAC);
      await expireAt(nextStart);
      await expect(SS.connect(buyer).topUpFromConviction(ahead.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SS, 'AssignmentEndsBeforePeriod')
        .withArgs(accountId, buyer.address, nextStart, nextStart);
      // A running period of the current epoch, under an assignment that
      // expires before the next epoch, is topped up as before.
      await assign(accountId, buyer2, 100n * TRAC);
      await SS.connect(owner).updateAssignmentCaps(accountId, buyer2.address, {
        maxCostPerPeriod: 100n * TRAC,
        expiresAt: nextStart - 1n,
      });
      const running = await caFund(accountId, now, 10n * TRAC, buyer2);
      await SS.connect(buyer2).topUpFromConviction(running.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash);
      await expireAt(nextStart + 1n);
      await SS.connect(buyer).topUpFromConviction(ahead.subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash);
    });
  });

  // -------------------------------------------------------------------------
  // The session key, the pause and activation
  // -------------------------------------------------------------------------

  describe('the session key, the pause and activation', () => {
    it('a zero session key is refused from a wallet and from an account', async () => {
      await setExactScheduleFrom(HubContract, CSS);
      const accountId = await openAccount();
      const now = await epochNow();
      await expect(SSW.connect(buyer).fundFromWallet(walletRequestOf(now, { sessionKey: ethers.ZeroAddress })))
        .to.be.revertedWithCustomError(SSW, 'ZeroSessionKey');
      await expect(SS.connect(buyer).fundFromConviction(requestOf(accountId, now, { sessionKey: ethers.ZeroAddress })))
        .to.be.revertedWithCustomError(SS, 'ZeroSessionKey');
    });

    it('while paused, no funding or top-up runs, from a wallet or an account; unpaused, they go on', async () => {
      await setExactScheduleFrom(HubContract, CSS);
      const accountId = await openAccount();
      const now = await epochNow();
      const wallet = await walletFund(walletRequestOf(now));
      const ca = await caFund(accountId, now + 1n, 10n * TRAC);
      await forward(QIS, 'setPaused', [true]);
      const add = [bucket(0, CLASS_INFERENCE, TRAC)];
      for (const call of [
        SSW.connect(buyer).fundFromWallet(walletRequestOf(now + 1n)),
        SSW.connect(buyer).topUpFromWallet(wallet.subscriptionId, add, ethers.ZeroHash),
        SS.connect(buyer2).fundFromConviction(requestOf(accountId, now)),
        SS.connect(buyer).topUpFromConviction(ca.subscriptionId, add, ethers.ZeroHash),
      ]) {
        await expect(call).to.be.revertedWithCustomError(SSW, 'QueryInferencePaused');
      }
      await forward(QIS, 'setPaused', [false]);
      await walletTopUp(wallet.subscriptionId, add);
      await SS.connect(buyer).topUpFromConviction(ca.subscriptionId, add, ethers.ZeroHash);
    });

    it('wallet funding and top-ups are refused until the activation epoch: activation unset, then ahead, then reached', async () => {
      await useInactiveStorage();
      const now = await epochNow();
      expect(await QIS.activationEpoch()).to.equal(0n);
      await allow(buyer, 10n * TRAC);
      await expect(SSW.connect(buyer).fundFromWallet(walletRequestOf(now)))
        .to.be.revertedWithCustomError(SSW, 'QueryInferenceNotActive')
        .withArgs(0n, now);

      await activateQueryInference(HubContract, QIS, now + 1n);
      await expect(SSW.connect(buyer).fundFromWallet(walletRequestOf(now + 1n)))
        .to.be.revertedWithCustomError(SSW, 'QueryInferenceNotActive')
        .withArgs(now + 1n, now);
      await expect(SSW.connect(buyer).topUpFromWallet(ethers.id('x'), [bucket(0, CLASS_INFERENCE, TRAC)], ethers.ZeroHash))
        .to.be.revertedWithCustomError(SSW, 'QueryInferenceNotActive')
        .withArgs(now + 1n, now);

      await time.increaseTo(await epochStart(now + 1n));
      const { subscriptionId } = await walletFund(walletRequestOf(now + 1n));
      await walletTopUp(subscriptionId, [bucket(0, CLASS_INFERENCE, TRAC)]);
      expect(await QIS.walletDue(now + 2n)).to.equal(11n * TRAC);
    });

    it('a Conviction Account funding keeps its built behaviour while activation is unset: it is not refused', async () => {
      await useInactiveStorage();
      expect(await QIS.activationEpoch()).to.equal(0n);
      await setExactScheduleFrom(HubContract, CSS);
      const accountId = await openAccount();
      await caFund(accountId, await epochNow(), 10n * TRAC);
    });
  });

  /** The smallest value whose cost at the 30 % tier is exactly `cost`. */
  function valueFor(cost: bigint): bigint {
    return (cost * 10_000n + (10_000n - BPS) - 1n) / (10_000n - BPS);
  }
});
