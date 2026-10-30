// Conviction Account service spending (OT-RFC-27) end to end: ServiceSubscriptions
// and ConvictionServiceStorage registered in the Hub, drawing through the real
// PublishingConviction 10.1.0 on the real account stack.
//
// Groups:
//   - opt-in: owner only, the cut-over, an expired account, a wired treasury, a
//     repeated switch, and the schedule an older account gets at opt-in;
//   - assign: consent by sending or by signature (EOA and ERC-1271), the nonce,
//     replay, the domain, every invalid term, a transferred NFT, high-s and
//     compact signatures, and the separation from publishing agents;
//   - revoke, and advancing the nonce;
//   - caps update: owner only, live assignments only, a valid and changed limit
//     and expiry, usage and nonces kept, applied from the next funding in both
//     directions, a paused account, and terms signed before an update;
//   - fund, happy path: every discount tier, the 1-wei floor, the top-up branch;
//   - fund, refusals: the period limit, the period's epoch, the buckets, the
//     assignment, the allowance, an expired account, a wired treasury, the gate
//     on coverServiceCost, a mismatched draw and a full label basis, each
//     without partial effect;
//   - period records: the record is always visible, and a buyer key funds one
//     period per epoch;
//   - shared allowance with publishing through KnowledgeAssetsLifecycle;
//   - no TRAC moves: no Token log, an unchanged vault, an unchanged pool for a
//     base-only funding and exactly the overflow's ranges for a top-up funding;
//   - views: previewCost, currentWindowAllowance against getRemainingAllowance,
//     scheduledEmission, emissionSpan and baseLabelCapacity.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, ContractTransactionResponse, ethers, Result } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ContextGraphs,
  ContextGraphStorage,
  ConvictionServiceStorage,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  KnowledgeAssetsLifecycle,
  MockERC1271Wallet,
  MockSkewedServiceDraw,
  ParametersStorage,
  Profile,
  PublishingConviction,
  PublishingConvictionStorage,
  ServiceSubscriptions,
  StakingV10,
  Token,
} from '../typechain';
import {
  ACCOUNT_STACK_TAGS,
  CLASS_INFERENCE,
  CLASS_QUERY,
  Caps,
  DAY,
  Request,
  SESSION_KEY,
  TRAC,
  Terms,
  basisAmounts,
  bucket,
  capsOf,
  compact,
  costOf,
  domainOf,
  emissionOfWindows,
  highS,
  registerServiceContracts,
  requestOf,
  setExactScheduleFrom,
  signTerms,
  valueFor,
  writeLegacyAccount,
} from './helpers/conviction-service';
import { PoolModel, prorateActiveSink, scheduleModel } from './helpers/emission-model';
import { createProfile, createProfiles } from './helpers/profile-helpers';
import { getDefaultKACreator, getDefaultPublishingNode, getDefaultReceivingNodes } from './helpers/setup-helpers';
import { DEFAULT_CHAIN_ID, buildPublishParams, packReservedKaId } from './helpers/v10-ka-helpers';

const STAKER_SHARD_ID = 1n;
const MIN_STAKE = ethers.parseEther('50000');
const MAX_UINT96 = (1n << 96n) - 1n;
// The 30 % tier, with `committed mod lock` dust.
const COMMITTED = 100_000n * TRAC + 11n;
// No discount, so a cost equals its value; the window allowance is 1,000 TRAC.
const SMALL = 12_000n * TRAC + 5n;
// The committed amounts that open each discount tier, and the tier.
const TIERS: Array<[bigint, bigint]> = [
  [1_000n * TRAC, 0n],
  [25_000n * TRAC, 1_000n],
  [50_000n * TRAC, 2_000n],
  [100_000n * TRAC, 3_000n],
  [250_000n * TRAC, 4_000n],
  [500_000n * TRAC, 5_000n],
  [1_000_000n * TRAC, 7_500n],
];
// A limit that no test of the draw itself reaches.
const WIDE: Partial<Terms> = { maxCostPerPeriod: 50_000n * TRAC };

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  ES: EpochStorage;
  Params: ParametersStorage;
  Vault: ConvictionStakingStorage;
  NFT: DKGPublishingConvictionNFT;
  PC: PublishingConviction;
  PCS: PublishingConvictionStorage;
  CSS: ConvictionServiceStorage;
  SS: ServiceSubscriptions;
  KAL: KnowledgeAssetsLifecycle;
  Profile: Profile;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const { CSS, SS } = await registerServiceContracts(Hub);
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    ES: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    Vault: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
    CSS,
    SS,
    KAL: await hre.ethers.getContract<KnowledgeAssetsLifecycle>('KnowledgeAssetsLifecycle'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
  };
}

describe('@integration Conviction Account service spending (ServiceSubscriptions)', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let Token: Token;
  let ChronosContract: Chronos;
  let ES: EpochStorage;
  let Params: ParametersStorage;
  let Vault: ConvictionStakingStorage;
  let NFT: DKGPublishingConvictionNFT;
  let PC: PublishingConviction;
  let PCS: PublishingConvictionStorage;
  let CSS: ConvictionServiceStorage;
  let SS: ServiceSubscriptions;
  let KAL: KnowledgeAssetsLifecycle;
  let ProfileContract: Profile;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let CGFacade: ContextGraphs;
  let CGS: ContextGraphStorage;

  let epLen: bigint;
  let lock: bigint;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let stranger: SignerWithAddress;
  let relayer: SignerWithAddress;
  let newOwner: SignerWithAddress;
  let buyer2: SignerWithAddress;
  let treasury: SignerWithAddress;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      Token,
      Chronos: ChronosContract,
      ES,
      Params,
      Vault,
      NFT,
      PC,
      PCS,
      CSS,
      SS,
      KAL,
      Profile: ProfileContract,
      StakingV10: StakingV10Contract,
      StakingNFT,
      ContextGraphs: CGFacade,
      ContextGraphStorage: CGS,
    } = await loadFixture(deployFixture));
    epLen = await ChronosContract.epochLength();
    lock = await Params.publishingConvictionEpochs();
    owner = accounts[20];
    buyer = accounts[21];
    stranger = accounts[22];
    relayer = accounts[23];
    newOwner = accounts[24];
    buyer2 = accounts[25];
    treasury = accounts[28];
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const cutOver = async (ts?: bigint) => setExactScheduleFrom(HubContract, CSS, ts);
  const latest = async () => BigInt(await time.latest());
  const blockTime = async (receipt: ContractTransactionReceipt): Promise<bigint> =>
    BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);

  const createAccountFor = async (holder: SignerWithAddress = owner, committed: bigint = COMMITTED) => {
    await Token.mint(holder.address, committed);
    await Token.connect(holder).approve(await NFT.getAddress(), committed);
    const receipt = (await (await NFT.connect(holder).createAccount(committed, 0)).wait())!;
    return { accountId: await NFT.totalSupply(), createdAt: await blockTime(receipt) };
  };

  const topUp = async (accountId: bigint, amount: bigint, holder: SignerWithAddress = owner) => {
    await Token.mint(holder.address, amount);
    await Token.connect(holder).approve(await NFT.getAddress(), amount);
    await NFT.connect(holder).topUp(accountId, amount);
  };

  const termsFor = async (accountId: bigint, assignee: string, overrides: Partial<Terms> = {}): Promise<Terms> => ({
    accountId,
    assignee,
    maxCostPerPeriod: 1_000n * TRAC,
    expiresAt: (await latest()) + 400n * DAY,
    nonce: await CSS.assignmentNonce(accountId),
    ...overrides,
  });

  /** An opted-in account of `holder` with `assignee` assigned by the holder, which sends. */
  const openAccount = async (
    opts: { committed?: bigint; caps?: Partial<Terms>; holder?: SignerWithAddress; assignee?: SignerWithAddress } = {},
  ) => {
    const holder = opts.holder ?? owner;
    const assignee = opts.assignee ?? buyer;
    const { accountId, createdAt } = await createAccountFor(holder, opts.committed ?? COMMITTED);
    await SS.connect(holder).setServiceSpending(accountId, true);
    const terms = await termsFor(accountId, assignee.address, opts.caps);
    await SS.connect(holder).assign(terms, '0x', await signTerms(assignee, SS, terms));
    return { accountId, createdAt, terms };
  };

  const assignAs = async (terms: Terms, assignee: SignerWithAddress, sender: SignerWithAddress = owner) =>
    SS.connect(sender).assign(terms, '0x', await signTerms(assignee, SS, terms));

  const fund = async (r: Request, sender: SignerWithAddress = buyer) => {
    const [subscriptionId, cost] = await SS.connect(sender).fundFromConviction.staticCall(r);
    const receipt = (await (await SS.connect(sender).fundFromConviction(r)).wait())!;
    return { subscriptionId, cost, receipt };
  };

  /** The current epoch, and the next one: the two a period may be funded for. */
  const epochNow = async () => ChronosContract.getCurrentEpoch();
  const epochNext = async () => (await epochNow()) + 1n;

  /** A one-bucket inference request, for the current epoch unless `overrides.epoch` names another. */
  const inference = async (accountId: bigint, value: bigint, overrides: Partial<Request> = {}) =>
    requestOf(accountId, overrides.epoch ?? (await epochNow()), {
      buckets: [bucket(0, CLASS_INFERENCE, value)],
      ...overrides,
    });

  const impersonate = async (address: string) => {
    await hre.network.provider.send('hardhat_setBalance', [address, '0x1000000000000000000']);
    return hre.ethers.getImpersonatedSigner(address);
  };

  /** A struct read back from a contract, as a plain object. */
  const plain = (r: unknown) => (r as Result).toObject();

  /** The parsed events `name` that `contract` emitted in a receipt. */
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
  const creditedRanges = async (receipt: ContractTransactionReceipt): Promise<bigint[][]> =>
    (await eventsOf(receipt, ES, 'TokensAddedToEpochRange'))
      .filter((a) => a.shardId === STAKER_SHARD_ID)
      .map((a) => [a.startEpoch, a.endEpoch, a.tokenAmount]);

  /** S(e) of an account scheduled at creation, from the shared emission model. */
  const scheduleOf = async (committed: bigint, createdAt: bigint, spent?: Map<bigint, bigint>) => {
    const model = new PoolModel(0n);
    await scheduleModel({ chronos: ChronosContract, model, committed, createdAtTimestamp: createdAt, lock, epLen, spent });
    return model.perEpoch;
  };

  const spanOf = async (createdAt: bigint) => {
    const first = await ChronosContract.epochAtTimestamp(createdAt + epLen);
    return { first, last: first + 2n * lock - 1n };
  };

  const poolSnapshot = async (from: bigint, to: bigint) => {
    const out = new Map<bigint, bigint>();
    for (let e = from; e <= to; e++) out.set(e, await ES.getEpochPool(STAKER_SHARD_ID, e));
    return out;
  };

  const sumBaseLabels = async (accountId: bigint, from: bigint, to: bigint) => {
    let sum = 0n;
    for (let e = from; e <= to; e++) sum += await CSS.baseLabel(accountId, e);
    return sum;
  };

  /** Time left in the current epoch at a block time, as Chronos computes it. */
  const timeLeftAt = async (ts: bigint) => {
    const start = await ChronosContract.startTime();
    return epLen - ((ts - start) % epLen);
  };

  /** Everything a refused funding must leave as it was. */
  const fundingState = async (accountId: bigint, assignee: string, window: bigint) => {
    const u = await CSS.getUsage(accountId, assignee);
    return {
      windowSpent: await PCS.windowSpent(accountId, window),
      topUpBalance: await PCS.topUpBalance(accountId),
      serviceSpent: await CSS.serviceSpent(accountId, window),
      labelTotal: await CSS.accountServiceLabelTotal(accountId),
      cursor: await CSS.labelCursor(accountId),
      usage: [u.periods],
      periods: await CSS.accountSubscriptionCount(accountId),
    };
  };

  // -------------------------------------------------------------------------
  // Opt-in
  // -------------------------------------------------------------------------

  describe('opt-in', () => {
    it('reverts ExactScheduleFromUnset while the cut-over is unset, and the label views are undefined until then', async () => {
      const { accountId } = await createAccountFor();
      await expect(SS.connect(owner).setServiceSpending(accountId, true)).to.be.revertedWithCustomError(
        SS,
        'ExactScheduleFromUnset',
      );
      await expect(SS.scheduledEmission(accountId, 1n)).to.be.revertedWithCustomError(SS, 'ExactScheduleFromUnset');
      await expect(SS.baseLabelCapacity(accountId)).to.be.revertedWithCustomError(SS, 'ExactScheduleFromUnset');
      const [first, last] = await SS.emissionSpan(accountId);
      expect(last - first + 1n).to.equal(2n * lock);

      await cutOver();
      await expect(SS.connect(owner).setServiceSpending(accountId, true))
        .to.emit(SS, 'ServiceSpendingSet')
        .withArgs(accountId, true);
    });

    describe('with the cut-over set', () => {
      beforeEach(async () => {
        await cutOver();
      });

      it('is owner only, in both directions', async () => {
        const { accountId } = await createAccountFor();
        for (const caller of [stranger, buyer, accounts[0]]) {
          await expect(SS.connect(caller).setServiceSpending(accountId, true))
            .to.be.revertedWithCustomError(SS, 'NotAccountOwner')
            .withArgs(accountId, caller.address);
        }
        await SS.connect(owner).setServiceSpending(accountId, true);
        await expect(SS.connect(stranger).setServiceSpending(accountId, false))
          .to.be.revertedWithCustomError(SS, 'NotAccountOwner')
          .withArgs(accountId, stranger.address);
        // An id the NFT never minted has no owner.
        await expect(SS.connect(owner).setServiceSpending(424242n, true))
          .to.be.revertedWithCustomError(NFT, 'ERC721NonexistentToken')
          .withArgs(424242n);
      });

      it('switching on records the block time; switching off records 0, keeps the assignments and pauses funding', async () => {
        const { accountId } = await createAccountFor();
        const on = await SS.connect(owner).setServiceSpending(accountId, true);
        await expect(on).to.emit(SS, 'ServiceSpendingSet').withArgs(accountId, true);
        expect(await CSS.serviceSpendingEnabledAt(accountId)).to.equal(await blockTime((await on.wait())!));
        const terms = await termsFor(accountId, buyer.address);
        await assignAs(terms, buyer);

        await expect(SS.connect(owner).setServiceSpending(accountId, false))
          .to.emit(SS, 'ServiceSpendingSet')
          .withArgs(accountId, false);
        expect(await CSS.serviceSpendingEnabledAt(accountId)).to.equal(0n);
        expect(await CSS.isAssignmentActive(accountId, buyer.address)).to.equal(true);
        await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, TRAC)))
          .to.be.revertedWithCustomError(SS, 'ServiceSpendingDisabled')
          .withArgs(accountId);

        const again = await SS.connect(owner).setServiceSpending(accountId, true);
        expect(await CSS.serviceSpendingEnabledAt(accountId)).to.equal(await blockTime((await again.wait())!));
        await fund(await inference(accountId, TRAC));
      });

      it('an expired account reverts AccountExpired; switching off still works after expiry', async () => {
        const first = await createAccountFor();
        const second = await createAccountFor();
        await SS.connect(owner).setServiceSpending(second.accountId, true);
        const acct = await PCS.getAccount(first.accountId);
        await time.increaseTo(acct.expiresAtTimestamp);
        await expect(SS.connect(owner).setServiceSpending(first.accountId, true))
          .to.be.revertedWithCustomError(SS, 'AccountExpired')
          .withArgs(first.accountId, acct.expiresAtEpoch);
        await expect(SS.connect(owner).setServiceSpending(second.accountId, false))
          .to.emit(SS, 'ServiceSpendingSet')
          .withArgs(second.accountId, false);
      });

      it('a wired treasury reverts ServiceFundingPausedTreasuryWired; switching off still works', async () => {
        const first = await createAccountFor();
        const second = await createAccountFor();
        await SS.connect(owner).setServiceSpending(second.accountId, true);
        await Params.setProtocolTreasury(treasury.address);
        await expect(SS.connect(owner).setServiceSpending(first.accountId, true))
          .to.be.revertedWithCustomError(SS, 'ServiceFundingPausedTreasuryWired')
          .withArgs(treasury.address);
        await expect(SS.connect(owner).setServiceSpending(second.accountId, false))
          .to.emit(SS, 'ServiceSpendingSet')
          .withArgs(second.accountId, false);
        await Params.setProtocolTreasury(ethers.ZeroAddress);
        await SS.connect(owner).setServiceSpending(first.accountId, true);
      });

      it('a repeated switch reverts ServiceSpendingUnchanged', async () => {
        const { accountId } = await createAccountFor();
        await expect(SS.connect(owner).setServiceSpending(accountId, false))
          .to.be.revertedWithCustomError(SS, 'ServiceSpendingUnchanged')
          .withArgs(accountId, false);
        await SS.connect(owner).setServiceSpending(accountId, true);
        await expect(SS.connect(owner).setServiceSpending(accountId, true))
          .to.be.revertedWithCustomError(SS, 'ServiceSpendingUnchanged')
          .withArgs(accountId, true);
      });

      it('on an account scheduled at creation, the opt-in writes no schedule and leaves the staker pool unchanged', async () => {
        const { accountId, createdAt } = await createAccountFor();
        const { first, last } = await spanOf(createdAt);
        const before = await poolSnapshot(first - 1n, last + 1n);
        const receipt = (await (await SS.connect(owner).setServiceSpending(accountId, true)).wait())!;
        expect(await eventsOf(receipt, PC, 'EmissionScheduled')).to.have.length(0);
        expect(await creditedRanges(receipt)).to.have.length(0);
        expect(await poolSnapshot(first - 1n, last + 1n)).to.deep.equal(before);
      });
    });

    it('an account from before the cut-over gets its schedule written by the opt-in, exactly as settle writes it', async () => {
      // Created by an older build: no up-front schedule, a third of an epoch
      // ago, with 111 TRAC of window 0 already spent (and emitted) under the
      // older rules. The cut-over follows its creation.
      const synthId = 909n;
      const committed = 12_000n * TRAC + 5n;
      const createdAt = (await latest()) - epLen / 3n;
      const spent0 = 111n * TRAC;
      const spent = new Map<bigint, bigint>([[0n, spent0]]);
      await writeLegacyAccount({
        pcs: PCS,
        nft: NFT,
        chronosEpochAt: (ts) => ChronosContract.epochAtTimestamp(ts),
        accountId: synthId,
        owner: owner.address,
        committed,
        createdAt,
        lock,
        epLen,
        spent,
      });
      await cutOver();
      expect(await NFT.ownerOf(synthId)).to.equal(owner.address);
      expect((await PCS.getAccount(synthId)).lastSettledWindow).to.equal(0n);

      const { first, last } = await spanOf(createdAt);
      const before = await poolSnapshot(first - 1n, last + 1n);
      const remBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);

      const tx = await SS.connect(owner).setServiceSpending(synthId, true);
      await expect(tx).to.emit(PC, 'EmissionScheduled').withArgs(synthId, 0n, lock, committed - spent0, 0n);
      await expect(tx).to.emit(SS, 'ServiceSpendingSet').withArgs(synthId, true);
      expect((await PCS.getAccount(synthId)).lastSettledWindow).to.equal(lock);

      // The pool received exactly the remaining schedule: B − spent per window, plus the dust.
      const model = new PoolModel(remBefore);
      await scheduleModel({ chronos: ChronosContract, model, committed, createdAtTimestamp: createdAt, lock, epLen, spent });
      const after = await poolSnapshot(first - 1n, last + 1n);
      for (const [e, v] of after) {
        expect(v - before.get(e)!, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
      }

      // The label basis of an older account is the lower bound: the budget less
      // what publishing drew, per window, rounded down to a multiple of the
      // lock. It is never above the schedule the opt-in wrote, epoch by epoch.
      const scheduled = await scheduleOf(committed, createdAt, spent);
      const basis = await emissionOfWindows({
        chronos: ChronosContract,
        amounts: basisAmounts({
          committed,
          lock,
          epLen,
          createdAt,
          cutOver: await CSS.exactScheduleFrom(),
          published: (w) => spent.get(w) ?? 0n,
        }),
        createdAt,
        lock,
        epLen,
      });
      for (let e = first - 1n; e <= last + 1n; e++) {
        const s = await SS.scheduledEmission(synthId, e);
        expect(s, `epoch ${e}`).to.equal(basis.get(e) ?? 0n);
        expect(s, `epoch ${e}`).to.be.at.most(scheduled.get(e) ?? 0n);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Assign
  // -------------------------------------------------------------------------

  describe('assign', () => {
    let accountId: bigint;

    beforeEach(async () => {
      await cutOver();
      ({ accountId } = await createAccountFor());
      await SS.connect(owner).setServiceSpending(accountId, true);
    });

    const expectAssigned = async (tx: ContractTransactionResponse, t: Terms, nonce: bigint) => {
      const digest = await SS.hashAssignment(t);
      await expect(tx)
        .to.emit(SS, 'ServiceAssigned')
        .withArgs(t.accountId, t.assignee, digest, t.maxCostPerPeriod, t.expiresAt, nonce);
      await expect(tx).to.emit(SS, 'AssignmentNonceAdvanced').withArgs(t.accountId, nonce + 1n);
      const a = await CSS.getAssignment(t.accountId, t.assignee);
      expect([a.maxCostPerPeriod, a.expiresAt]).to.deep.equal(Object.values(capsOf(t)));
      expect(a.assignedAt).to.equal(await blockTime((await tx.wait())!));
      expect(a.revokedAt).to.equal(0n);
      expect(a.nonce).to.equal(nonce);
      expect(await CSS.assignmentNonce(t.accountId)).to.equal(nonce + 1n);
      expect(await CSS.isAssignmentActive(t.accountId, t.assignee)).to.equal(true);
    };

    it("the owner sends, with the assignee's EOA signature", async () => {
      const t = await termsFor(accountId, buyer.address);
      await expectAssigned(await SS.connect(owner).assign(t, '0x', await signTerms(buyer, SS, t)), t, 0n);
      expect(await CSS.assigneeCount(accountId)).to.equal(1n);
      expect(await CSS.assigneeAt(accountId, 0n)).to.equal(buyer.address);
      expect((await CSS.getUsage(accountId, buyer.address)).periods).to.equal(0n);
    });

    it("the assignee sends, with the owner's signature", async () => {
      const t = await termsFor(accountId, buyer.address);
      await expectAssigned(await SS.connect(buyer).assign(t, await signTerms(owner, SS, t), '0x'), t, 0n);
    });

    it('a third party submits both signatures', async () => {
      const t = await termsFor(accountId, buyer.address);
      await expectAssigned(
        await SS.connect(relayer).assign(t, await signTerms(owner, SS, t), await signTerms(buyer, SS, t)),
        t,
        0n,
      );
    });

    it('both parties may be ERC-1271 wallets, and a wallet assignee funds as itself', async () => {
      const ownerKey = accounts[26];
      const buyerKey = accounts[27];
      const Wallet = await hre.ethers.getContractFactory('MockERC1271Wallet');
      const ownerWallet = (await Wallet.deploy(ownerKey.address)) as unknown as MockERC1271Wallet;
      const buyerWallet = (await Wallet.deploy(buyerKey.address)) as unknown as MockERC1271Wallet;
      const ownerWalletAddress = await ownerWallet.getAddress();
      const buyerWalletAddress = await buyerWallet.getAddress();
      await NFT.connect(owner).transferFrom(owner.address, ownerWalletAddress, accountId);

      const t = await termsFor(accountId, buyerWalletAddress);
      const ownerSig = await signTerms(ownerKey, SS, t);
      const buyerSig = await signTerms(buyerKey, SS, t);

      // The wallet's answer decides: a refusal, or another key's signature, is a bad signature.
      await ownerWallet.setForceFailure(true);
      await expect(SS.connect(relayer).assign(t, ownerSig, buyerSig))
        .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
        .withArgs(ownerWalletAddress);
      await ownerWallet.setForceFailure(false);
      await expect(SS.connect(relayer).assign(t, ownerSig, await signTerms(stranger, SS, t)))
        .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
        .withArgs(buyerWalletAddress);

      await expectAssigned(await SS.connect(relayer).assign(t, ownerSig, buyerSig), t, 0n);

      const wallet = await impersonate(buyerWalletAddress);
      const { cost } = await fund(await inference(accountId, 10n * TRAC), wallet);
      expect(cost).to.equal(costOf(10n * TRAC, 3_000n));
    });

    it('an address with code that does not answer ERC-1271 cannot consent by signature', async () => {
      const contractParty = await PCS.getAddress();
      const t = await termsFor(accountId, contractParty);
      await expect(SS.connect(owner).assign(t, '0x', await signTerms(buyer, SS, t)))
        .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
        .withArgs(contractParty);
    });

    it('self-assignment: an owner that sends consents in both roles, and funds as its own buyer key', async () => {
      const t = await termsFor(accountId, owner.address);
      const sig = await signTerms(owner, SS, t);
      await expect(SS.connect(owner).assign(t, sig, '0x'))
        .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
        .withArgs(owner.address);
      await expect(SS.connect(owner).assign(t, '0x', sig))
        .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
        .withArgs(owner.address);
      await expectAssigned(await SS.connect(owner).assign(t, '0x', '0x'), t, 0n);
      await fund(await inference(accountId, TRAC), owner);
    });

    it('a wrong nonce reverts InvalidAssignmentNonce', async () => {
      const t = await termsFor(accountId, buyer.address, { nonce: 1n });
      await expect(SS.connect(owner).assign(t, '0x', await signTerms(buyer, SS, t)))
        .to.be.revertedWithCustomError(SS, 'InvalidAssignmentNonce')
        .withArgs(accountId, 0n, 1n);
    });

    it('a used signature cannot be replayed: the nonce has moved on', async () => {
      const t = await termsFor(accountId, buyer.address);
      const ownerSig = await signTerms(owner, SS, t);
      const buyerSig = await signTerms(buyer, SS, t);
      await SS.connect(relayer).assign(t, ownerSig, buyerSig);
      for (const sender of [relayer, owner]) {
        await expect(SS.connect(sender).assign(t, sender === owner ? '0x' : ownerSig, buyerSig))
          .to.be.revertedWithCustomError(SS, 'InvalidAssignmentNonce')
          .withArgs(accountId, 1n, 0n);
      }
    });

    it('a signature for another chain id or another verifying contract does not verify', async () => {
      const t = await termsFor(accountId, buyer.address);
      const domain = await domainOf(SS);
      for (const other of [
        { ...domain, chainId: DEFAULT_CHAIN_ID + 1n },
        { ...domain, verifyingContract: await PCS.getAddress() },
        { ...domain, name: 'KnowledgeAssetsLifecycle' },
        { ...domain, version: '2' },
      ]) {
        await expect(SS.connect(owner).assign(t, '0x', await signTerms(buyer, SS, t, other)))
          .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
          .withArgs(buyer.address);
        await expect(SS.connect(buyer).assign(t, await signTerms(owner, SS, t, other), '0x'))
          .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
          .withArgs(owner.address);
      }
    });

    it('refuses expired terms and every invalid term, and admits the bounds', async () => {
      const now = await latest();
      const cases: Array<[Partial<Terms>, string]> = [
        [{ assignee: ethers.ZeroAddress }, 'assignee'],
        [{ maxCostPerPeriod: 0n }, 'maxCostPerPeriod'],
        [{ expiresAt: now }, 'expiresAt'],
        [{ expiresAt: 0n }, 'expiresAt'],
      ];
      for (const [overrides, reason] of cases) {
        const t = await termsFor(accountId, buyer.address, overrides);
        await expect(SS.connect(owner).assign(t, '0x', await signTerms(buyer, SS, t)), reason)
          .to.be.revertedWithCustomError(SS, 'InvalidAssignmentTerms')
          .withArgs(reason);
      }
      // A limit of 1 wei, and an expiry just after the block time.
      const t = await termsFor(accountId, buyer.address, { maxCostPerPeriod: 1n, expiresAt: (await latest()) + 100n });
      await expectAssigned(await SS.connect(owner).assign(t, '0x', await signTerms(buyer, SS, t)), t, 0n);
    });

    it('an account that has not opted in, or has switched off, reverts ServiceSpendingDisabled', async () => {
      const other = await createAccountFor();
      const t = await termsFor(other.accountId, buyer.address);
      await expect(SS.connect(owner).assign(t, '0x', await signTerms(buyer, SS, t)))
        .to.be.revertedWithCustomError(SS, 'ServiceSpendingDisabled')
        .withArgs(other.accountId);
      await SS.connect(owner).setServiceSpending(accountId, false);
      const u = await termsFor(accountId, buyer.address);
      await expect(SS.connect(owner).assign(u, '0x', await signTerms(buyer, SS, u)))
        .to.be.revertedWithCustomError(SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);
    });

    it("after an NFT transfer the previous owner's signature fails, and the stored assignment survives", async () => {
      await assignAs(await termsFor(accountId, buyer.address), buyer);
      await NFT.connect(owner).transferFrom(owner.address, newOwner.address, accountId);

      const t = await termsFor(accountId, buyer2.address);
      await expect(SS.connect(buyer2).assign(t, await signTerms(owner, SS, t), '0x'))
        .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
        .withArgs(newOwner.address);

      expect(await CSS.isAssignmentActive(accountId, buyer.address)).to.equal(true);
      await fund(await inference(accountId, TRAC));

      for (const call of [
        SS.connect(owner).revoke(accountId, buyer.address),
        SS.connect(owner).setServiceSpending(accountId, false),
        SS.connect(owner).advanceAssignmentNonce(accountId),
      ]) {
        await expect(call).to.be.revertedWithCustomError(SS, 'NotAccountOwner').withArgs(accountId, owner.address);
      }
      await expectAssigned(await SS.connect(buyer2).assign(t, await signTerms(newOwner, SS, t), '0x'), t, 1n);
      await SS.connect(newOwner).revoke(accountId, buyer.address);
    });

    it('rejects a high-s signature and malformed ones, and accepts the low-s twin in its 64-byte compact form', async () => {
      const t = await termsFor(accountId, buyer.address);
      const sig = await signTerms(buyer, SS, t);
      const digest = await SS.hashAssignment(t);
      const malleated = highS(sig);
      // The malleated twin recovers to the same key with solady, which checks
      // no s (shown through a wallet that recovers with it), so only the s
      // check refuses it. ethers itself refuses to parse it.
      const Wallet = await hre.ethers.getContractFactory('MockERC1271Wallet');
      const probe = (await Wallet.deploy(buyer.address)) as unknown as MockERC1271Wallet;
      expect(await probe.isValidSignature(digest, malleated)).to.equal('0x1626ba7e');
      for (const bad of [
        malleated,
        ethers.concat([sig, '0x00']),
        ethers.dataSlice(sig, 0, 63),
        ethers.concat([ethers.dataSlice(sig, 0, 64), '0x1d']),
      ]) {
        await expect(SS.connect(owner).assign(t, '0x', bad))
          .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
          .withArgs(buyer.address);
      }
      await expectAssigned(await SS.connect(owner).assign(t, '0x', compact(sig)), t, 0n);
    });

    it('a party that sends the transaction must not also sign', async () => {
      const t = await termsFor(accountId, buyer.address);
      const ownerSig = await signTerms(owner, SS, t);
      const buyerSig = await signTerms(buyer, SS, t);
      await expect(SS.connect(owner).assign(t, ownerSig, buyerSig))
        .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
        .withArgs(owner.address);
      await expect(SS.connect(buyer).assign(t, ownerSig, buyerSig))
        .to.be.revertedWithCustomError(SS, 'InvalidConsentSignature')
        .withArgs(buyer.address);
    });

    it('an empty signature from a party that does not send reverts ConsentMissing', async () => {
      const t = await termsFor(accountId, buyer.address);
      const ownerSig = await signTerms(owner, SS, t);
      const buyerSig = await signTerms(buyer, SS, t);
      await expect(SS.connect(relayer).assign(t, '0x', buyerSig))
        .to.be.revertedWithCustomError(SS, 'ConsentMissing')
        .withArgs(owner.address);
      await expect(SS.connect(relayer).assign(t, ownerSig, '0x'))
        .to.be.revertedWithCustomError(SS, 'ConsentMissing')
        .withArgs(buyer.address);
      await expect(SS.connect(owner).assign(t, '0x', '0x'))
        .to.be.revertedWithCustomError(SS, 'ConsentMissing')
        .withArgs(buyer.address);
    });

    it('a publishing agent registration grants no service spending, and an assignment grants no publishing', async () => {
      await NFT.connect(owner).registerAgent(accountId, buyer2.address);
      await expect(SS.connect(buyer2).fundFromConviction(await inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(SS, 'NotAssigned')
        .withArgs(accountId, buyer2.address);
      await assignAs(await termsFor(accountId, buyer.address), buyer);
      expect(await PCS.agentToAccountId(buyer.address)).to.equal(0n);
      expect(await NFT.isAgent(accountId, buyer.address)).to.equal(false);
    });

    it('a new assignment of the same assignee replaces its terms and counts its usage from zero', async () => {
      await assignAs(await termsFor(accountId, buyer.address), buyer);
      await fund(await inference(accountId, 10n * TRAC));
      await fund(await inference(accountId, 10n * TRAC, { epoch: await epochNext() }));
      expect((await CSS.getUsage(accountId, buyer.address)).periods).to.equal(2n);

      const t = await termsFor(accountId, buyer.address, { maxCostPerPeriod: 5n * TRAC });
      await expectAssigned(await assignAs(t, buyer), t, 1n);
      expect((await CSS.getUsage(accountId, buyer.address)).periods).to.equal(0n);
      expect(await CSS.assigneeCount(accountId)).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  describe('revoke', () => {
    let accountId: bigint;

    beforeEach(async () => {
      await cutOver();
      ({ accountId } = await openAccount());
    });

    it('is owner only', async () => {
      for (const caller of [buyer, stranger]) {
        await expect(SS.connect(caller).revoke(accountId, buyer.address))
          .to.be.revertedWithCustomError(SS, 'NotAccountOwner')
          .withArgs(accountId, caller.address);
      }
    });

    it('is immediate for new periods, records the time and advances the nonce', async () => {
      await fund(await inference(accountId, TRAC));
      const tx = await SS.connect(owner).revoke(accountId, buyer.address);
      await expect(tx).to.emit(SS, 'ServiceRevoked').withArgs(accountId, buyer.address);
      await expect(tx).to.emit(SS, 'AssignmentNonceAdvanced').withArgs(accountId, 2n);
      expect((await CSS.getAssignment(accountId, buyer.address)).revokedAt).to.equal(
        await blockTime((await tx.wait())!),
      );
      expect(await CSS.isAssignmentActive(accountId, buyer.address)).to.equal(false);
      await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, TRAC, { epoch: await epochNext() })))
        .to.be.revertedWithCustomError(SS, 'AssignmentRevoked')
        .withArgs(accountId, buyer.address);
      await expect(SS.connect(owner).revoke(accountId, buyer.address))
        .to.be.revertedWithCustomError(SS, 'AssignmentRevoked')
        .withArgs(accountId, buyer.address);
      await expect(SS.connect(owner).revoke(accountId, stranger.address))
        .to.be.revertedWithCustomError(SS, 'NotAssigned')
        .withArgs(accountId, stranger.address);
    });

    it('terms signed but not yet submitted no longer assign', async () => {
      const t = await termsFor(accountId, buyer2.address);
      const sig = await signTerms(buyer2, SS, t);
      await SS.connect(owner).revoke(accountId, buyer.address);
      await expect(SS.connect(owner).assign(t, '0x', sig))
        .to.be.revertedWithCustomError(SS, 'InvalidAssignmentNonce')
        .withArgs(accountId, 2n, 1n);
    });

    it('a funded period keeps its record and its buckets', async () => {
      const { subscriptionId } = await fund(await inference(accountId, 10n * TRAC));
      const record = plain(await CSS.getSubscription(subscriptionId));
      const buckets = (await CSS.getBuckets(subscriptionId)).map(plain);
      await SS.connect(owner).revoke(accountId, buyer.address);
      expect(plain(await CSS.getSubscription(subscriptionId))).to.deep.equal(record);
      expect((await CSS.getBuckets(subscriptionId)).map(plain)).to.deep.equal(buckets);
      expect(await CSS.subscriptionExists(subscriptionId)).to.equal(true);
    });

    it('works while service spending is off, and only a new assign renews the assignee', async () => {
      await SS.connect(owner).setServiceSpending(accountId, false);
      await SS.connect(owner).revoke(accountId, buyer.address);
      await SS.connect(owner).setServiceSpending(accountId, true);
      const t = await termsFor(accountId, buyer.address);
      await assignAs(t, buyer);
      const a = await CSS.getAssignment(accountId, buyer.address);
      expect(a.revokedAt).to.equal(0n);
      expect(a.nonce).to.equal(2n);
      await fund(await inference(accountId, TRAC));
    });

    it('advanceAssignmentNonce is owner only, keeps the assignments, and terms signed at the old nonce then fail', async () => {
      const t = await termsFor(accountId, buyer2.address);
      const sig = await signTerms(buyer2, SS, t);
      for (const caller of [buyer, stranger]) {
        await expect(SS.connect(caller).advanceAssignmentNonce(accountId))
          .to.be.revertedWithCustomError(SS, 'NotAccountOwner')
          .withArgs(accountId, caller.address);
      }
      await expect(SS.connect(owner).advanceAssignmentNonce(accountId))
        .to.emit(SS, 'AssignmentNonceAdvanced')
        .withArgs(accountId, 2n);
      await expect(SS.connect(owner).assign(t, '0x', sig))
        .to.be.revertedWithCustomError(SS, 'InvalidAssignmentNonce')
        .withArgs(accountId, 2n, 1n);
      expect(await CSS.isAssignmentActive(accountId, buyer.address)).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // Caps update
  // -------------------------------------------------------------------------

  describe('caps update', () => {
    let accountId: bigint;
    let terms: Terms;
    const CAPS: Partial<Terms> = { maxCostPerPeriod: 50n * TRAC };

    beforeEach(async () => {
      await cutOver();
      ({ accountId, terms } = await openAccount({ committed: SMALL, caps: CAPS }));
    });

    const capsWith = (overrides: Partial<Caps> = {}): Caps => ({ ...capsOf(terms), ...overrides });
    const update = (caps: Caps, sender: SignerWithAddress = owner, assignee: string = buyer.address) =>
      SS.connect(sender).updateAssignmentCaps(accountId, assignee, caps);
    const capsTuple = async () => {
      const a = await CSS.getAssignment(accountId, buyer.address);
      return [a.maxCostPerPeriod, a.expiresAt];
    };

    it('is owner only: the assignee and anyone else revert NotAccountOwner', async () => {
      for (const caller of [buyer, stranger, relayer]) {
        await expect(update(capsWith({ maxCostPerPeriod: 45n * TRAC }), caller))
          .to.be.revertedWithCustomError(SS, 'NotAccountOwner')
          .withArgs(accountId, caller.address);
      }
    });

    it('needs a live assignment: NotAssigned and AssignmentRevoked', async () => {
      await expect(update(capsWith(), owner, stranger.address))
        .to.be.revertedWithCustomError(SS, 'NotAssigned')
        .withArgs(accountId, stranger.address);
      await SS.connect(owner).revoke(accountId, buyer.address);
      await expect(update(capsWith({ maxCostPerPeriod: 45n * TRAC })))
        .to.be.revertedWithCustomError(SS, 'AssignmentRevoked')
        .withArgs(accountId, buyer.address);
    });

    it('an expired assignment reverts AssignmentExpired, so a later expiry never revives it', async () => {
      await time.increaseTo(terms.expiresAt);
      await expect(update(capsWith({ expiresAt: terms.expiresAt + 30n * DAY })))
        .to.be.revertedWithCustomError(SS, 'AssignmentExpired')
        .withArgs(accountId, buyer.address);
    });

    it('validates the caps by the rules of assign, and reverts CapsUnchanged for the caps it holds', async () => {
      const now = await latest();
      const cases: Array<[Partial<Caps>, string]> = [
        [{ maxCostPerPeriod: 0n }, 'maxCostPerPeriod'],
        [{ expiresAt: now }, 'expiresAt'],
      ];
      for (const [overrides, reason] of cases) {
        await expect(update(capsWith(overrides)), reason)
          .to.be.revertedWithCustomError(SS, 'InvalidAssignmentTerms')
          .withArgs(reason);
      }
      await expect(update(capsWith()))
        .to.be.revertedWithCustomError(SS, 'CapsUnchanged')
        .withArgs(accountId, buyer.address);
      // Either limit is a change, the expiry included.
      await update(capsWith({ expiresAt: terms.expiresAt + 1n }));
      await update(capsWith({ maxCostPerPeriod: 49n * TRAC, expiresAt: terms.expiresAt + 1n }));
    });

    it('keeps the usage, assignedAt, the assignment nonce and the account nonce', async () => {
      await fund(await inference(accountId, 30n * TRAC));
      await fund(await inference(accountId, 20n * TRAC, { epoch: await epochNext() }));
      await time.increase(epLen);
      await fund(await inference(accountId, 10n * TRAC, { epoch: await epochNext() }));
      const before = await CSS.getAssignment(accountId, buyer.address);
      const usage = plain(await CSS.getUsage(accountId, buyer.address));
      expect(usage).to.deep.equal({ periods: 3n });
      const nonce = await CSS.assignmentNonce(accountId);

      const caps = capsWith({ maxCostPerPeriod: 40n * TRAC });
      await update(caps);

      expect(plain(await CSS.getUsage(accountId, buyer.address))).to.deep.equal(usage);
      const after = await CSS.getAssignment(accountId, buyer.address);
      expect([after.assignedAt, after.revokedAt, after.nonce]).to.deep.equal([before.assignedAt, 0n, before.nonce]);
      expect(await CSS.assignmentNonce(accountId)).to.equal(nonce);
      expect(await capsTuple()).to.deep.equal(Object.values(caps));
      expect(await CSS.assigneeCount(accountId)).to.equal(1n);
    });

    it('applies from the next funding: a raised cap admits what the old cap refused, a lowered cap refuses what it admitted', async () => {
      await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, 60n * TRAC)))
        .to.be.revertedWithCustomError(SS, 'CapExceeded')
        .withArgs('maxCostPerPeriod', 50n * TRAC, 60n * TRAC);
      await update(capsWith({ maxCostPerPeriod: 80n * TRAC }));
      await fund(await inference(accountId, 60n * TRAC));

      await update(capsWith({ maxCostPerPeriod: 40n * TRAC }));
      const next = await epochNext();
      await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, 45n * TRAC, { epoch: next })))
        .to.be.revertedWithCustomError(SS, 'CapExceeded')
        .withArgs('maxCostPerPeriod', 40n * TRAC, 45n * TRAC);
      await fund(await inference(accountId, 40n * TRAC, { epoch: next }));
    });

    it('works while service spending is off, and the new caps hold once it is back on', async () => {
      await SS.connect(owner).setServiceSpending(accountId, false);
      await update(capsWith({ maxCostPerPeriod: 20n * TRAC }));
      await SS.connect(owner).setServiceSpending(accountId, true);
      await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, 25n * TRAC)))
        .to.be.revertedWithCustomError(SS, 'CapExceeded')
        .withArgs('maxCostPerPeriod', 20n * TRAC, 25n * TRAC);
      await fund(await inference(accountId, 20n * TRAC));
    });

    it('a funded period keeps its record', async () => {
      const { subscriptionId } = await fund(await inference(accountId, 40n * TRAC));
      const record = plain(await CSS.getSubscription(subscriptionId));
      await update(capsWith({ maxCostPerPeriod: 10n * TRAC }));
      expect(plain(await CSS.getSubscription(subscriptionId))).to.deep.equal(record);
    });

    it('CapsUpdated carries the new caps', async () => {
      const caps = capsWith({ maxCostPerPeriod: 30n * TRAC, expiresAt: terms.expiresAt - DAY });
      await expect(update(caps))
        .to.emit(SS, 'CapsUpdated')
        .withArgs(accountId, buyer.address, ...Object.values(caps));
    });

    it('terms signed before an update still assign and reset the usage; after advanceAssignmentNonce they fail', async () => {
      const t = await termsFor(accountId, buyer.address, { maxCostPerPeriod: 70n * TRAC });
      const sig = await signTerms(buyer, SS, t);
      await fund(await inference(accountId, 30n * TRAC));
      await update(capsWith({ maxCostPerPeriod: 45n * TRAC }));
      expect(await CSS.assignmentNonce(accountId)).to.equal(t.nonce);
      await SS.connect(owner).assign(t, '0x', sig);
      expect((await CSS.getAssignment(accountId, buyer.address)).maxCostPerPeriod).to.equal(70n * TRAC);
      expect((await CSS.getUsage(accountId, buyer.address)).periods).to.equal(0n);

      const next = await termsFor(accountId, buyer.address, { maxCostPerPeriod: 80n * TRAC });
      const nextSig = await signTerms(buyer, SS, next);
      await update(capsWith({ maxCostPerPeriod: 35n * TRAC, expiresAt: next.expiresAt }));
      await SS.connect(owner).advanceAssignmentNonce(accountId);
      await expect(SS.connect(owner).assign(next, '0x', nextSig))
        .to.be.revertedWithCustomError(SS, 'InvalidAssignmentNonce')
        .withArgs(accountId, next.nonce + 1n, next.nonce);
    });
  });

  // -------------------------------------------------------------------------
  // Fund, happy path
  // -------------------------------------------------------------------------

  describe('fund, happy path', () => {
    beforeEach(async () => {
      await cutOver();
    });

    for (const [committed, bps] of TIERS) {
      it(`at the ${Number(bps) / 100} % tier: the cost, the events, the record, the buckets and the usage`, async () => {
        const { accountId, createdAt } = await openAccount({ committed: committed + 11n, caps: WIDE });
        const r = requestOf(accountId, await epochNow(), {
          buckets: [bucket(0, CLASS_INFERENCE, 7n * TRAC + 3n), bucket(1, CLASS_QUERY, 3n * TRAC + 1n)],
        });
        const value = 10n * TRAC + 4n;
        const cost = costOf(value, bps);
        expect(await SS.previewCost(accountId, value)).to.deep.equal([cost, bps]);

        const { subscriptionId, cost: returned, receipt } = await fund(r);
        expect(returned).to.equal(cost);
        expect(subscriptionId).to.equal(await SS.subscriptionIdOf(buyer.address, r.epoch));
        const ts = await blockTime(receipt);
        const epoch = await ChronosContract.epochAtTimestamp(ts);
        expect(epoch).to.equal(r.epoch);
        const periodEnd = await ChronosContract.timestampForEpoch(epoch + 1n);
        const window = (ts - createdAt) / epLen;

        const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
        expect([...covered]).to.deep.equal([accountId, buyer.address, subscriptionId, value, cost, epoch, window, cost, 0n]);

        const funded = await eventsOf(receipt, SS, 'PeriodFunded');
        expect(funded).to.have.length(1);
        const pf = funded[0];
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
        ]).to.deep.equal([
          subscriptionId,
          accountId,
          buyer.address,
          r.epoch,
          SESSION_KEY,
          r.planDigest,
          ts,
          periodEnd,
          value,
          cost,
          bps,
        ]);
        const asTuples = (bs: Array<{ bucketId: string; serviceClass: bigint; value: bigint; maxAskWeiPerUnit: bigint }>) =>
          bs.map((b) => [b.bucketId, b.serviceClass, b.value, b.maxAskWeiPerUnit]);
        expect(asTuples(pf.buckets)).to.deep.equal(asTuples(r.buckets));

        const [label] = await eventsOf(receipt, SS, 'ServiceEmissionLabelled');
        expect([label.accountId, label.amount, label.subscriptionId, label.fromTopUp]).to.deep.equal([
          accountId,
          cost,
          subscriptionId,
          false,
        ]);

        const s = await CSS.getSubscription(subscriptionId);
        expect(plain(s)).to.deep.equal({
          accountId,
          assignee: buyer.address,
          sessionKey: SESSION_KEY,
          periodId: ethers.toBeHex(r.epoch, 32),
          planDigest: r.planDigest,
          periodStart: ts,
          periodEnd,
          fundedEpoch: epoch,
          fundedWindow: window,
          discountBps: bps,
          bucketCount: 2n,
          value,
          cost,
          drawnFromWindow: cost,
          drawnFromTopUp: 0n,
        });
        expect(asTuples(await CSS.getBuckets(subscriptionId))).to.deep.equal(asTuples(r.buckets));
        expect(await CSS.accountSubscriptionCount(accountId)).to.equal(1n);
        expect(await CSS.accountSubscriptionAt(accountId, 0n)).to.equal(subscriptionId);

        expect(plain(await CSS.getUsage(accountId, buyer.address))).to.deep.equal({ periods: 1n });
        expect(await PCS.windowSpent(accountId, window)).to.equal(cost);
        expect(await CSS.serviceSpent(accountId, window)).to.equal(cost);

        // The cost is labelled against the account's own schedule, from the nearest epoch on.
        const { first, last } = await spanOf(createdAt);
        expect(label.fromEpoch).to.be.at.least(epoch > first ? epoch : first);
        expect(await sumBaseLabels(accountId, first, last)).to.equal(cost);
        expect(await CSS.accountServiceLabelTotal(accountId)).to.equal(cost);
        for (let e = label.fromEpoch; e <= label.toEpoch; e++) {
          expect(await CSS.baseLabel(accountId, e)).to.be.at.most(await SS.scheduledEmission(accountId, e));
        }
      });
    }

    it('the 1-wei floor: a value the discount rounds to 0 costs 1 wei', async () => {
      const { accountId } = await openAccount({ committed: 1_000_000n * TRAC, caps: WIDE });
      const { cost, receipt } = await fund(await inference(accountId, 3n));
      expect(cost).to.equal(1n);
      const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
      expect([covered.value, covered.cost, covered.drawnFromWindow]).to.deep.equal([3n, 1n, 1n]);
      expect(await CSS.accountServiceLabelTotal(accountId)).to.equal(1n);
      expect((await CSS.getSubscription(await SS.subscriptionIdOf(buyer.address, await epochNow()))).cost).to.equal(1n);
    });

    it('once the window is spent, the cost comes from the top-up buffer and is labelled as exactly the emission it makes', async () => {
      const { accountId } = await openAccount({ caps: WIDE });
      const B = COMMITTED / lock;
      const spend = await fund(await inference(accountId, valueFor(B, 3_000n)));
      expect(spend.cost).to.equal(B);
      await topUp(accountId, 2_000n * TRAC);

      const r = await inference(accountId, 1_000n * TRAC, { epoch: await epochNext() });
      const { subscriptionId, cost, receipt } = await fund(r);
      expect(cost).to.equal(700n * TRAC);
      const ts = await blockTime(receipt);
      const epoch = await ChronosContract.epochAtTimestamp(ts);

      const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
      expect([covered.drawnFromWindow, covered.drawnFromTopUp]).to.deep.equal([0n, cost]);

      // The emission of the overflow: prorateActiveSink over the lock from the
      // current epoch, which is what publishing's overflow credits.
      const model = prorateActiveSink(cost, epoch, lock, epLen, await timeLeftAt(ts)).map((x) => [x.start, x.end, x.amount]);
      expect(await creditedRanges(receipt)).to.deep.equal(model);

      const labels = await eventsOf(receipt, SS, 'ServiceEmissionLabelled');
      expect(labels).to.have.length(1);
      expect([labels[0].fromEpoch, labels[0].toEpoch, labels[0].amount, labels[0].subscriptionId, labels[0].fromTopUp])
        .to.deep.equal([model[0][0], model[model.length - 1][1], cost, subscriptionId, true]);
      let sum = 0n;
      for (const [start, end, amount] of model) {
        for (let e = start; e <= end; e++) {
          const top = await CSS.topUpLabel(accountId, e);
          expect(top, `epoch ${e}`).to.equal(amount / (end - start + 1n));
          sum += top;
        }
      }
      expect(sum).to.equal(cost);
      expect(await PCS.topUpBalance(accountId)).to.equal(2_000n * TRAC - cost);
      const s = await CSS.getSubscription(subscriptionId);
      expect([s.drawnFromWindow, s.drawnFromTopUp]).to.deep.equal([0n, cost]);
    });

    it('a draw split between the window and the top-up buffer labels each part its own way', async () => {
      const { accountId, createdAt } = await openAccount({ caps: WIDE });
      const B = COMMITTED / lock;
      await fund(await inference(accountId, valueFor(B - 100n * TRAC, 3_000n)));
      await topUp(accountId, 1_000n * TRAC);
      const { cost, receipt } = await fund(
        await inference(accountId, valueFor(300n * TRAC, 3_000n), { epoch: await epochNext() }),
      );
      expect(cost).to.equal(300n * TRAC);
      const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
      expect([covered.drawnFromWindow, covered.drawnFromTopUp]).to.deep.equal([100n * TRAC, 200n * TRAC]);
      const labels = await eventsOf(receipt, SS, 'ServiceEmissionLabelled');
      expect(labels.map((l) => [l.amount, l.fromTopUp])).to.deep.equal([
        [100n * TRAC, false],
        [200n * TRAC, true],
      ]);
      const { first, last } = await spanOf(createdAt);
      expect(await sumBaseLabels(accountId, first, last)).to.equal(B);
      expect(await CSS.accountServiceLabelTotal(accountId)).to.equal(B + 200n * TRAC);
    });
  });

  // -------------------------------------------------------------------------
  // Fund, refusals
  // -------------------------------------------------------------------------

  describe('fund, refusals', () => {
    beforeEach(async () => {
      await cutOver();
    });

    describe('the limit', () => {
      let accountId: bigint;

      // No discount, so a cost equals its value.
      beforeEach(async () => {
        ({ accountId } = await openAccount({ committed: SMALL, caps: { maxCostPerPeriod: 40n * TRAC } }));
      });

      const both = async (inferenceValue: bigint, queryValue: bigint, epoch?: bigint) =>
        requestOf(accountId, epoch ?? (await epochNow()), {
          buckets: [bucket(0, CLASS_INFERENCE, inferenceValue), bucket(1, CLASS_QUERY, queryValue)],
        });

      it('the period limit, over both classes', async () => {
        await expect(SS.connect(buyer).fundFromConviction(await both(25n * TRAC, 16n * TRAC)))
          .to.be.revertedWithCustomError(SS, 'CapExceeded')
          .withArgs('maxCostPerPeriod', 40n * TRAC, 41n * TRAC);
        await fund(await both(25n * TRAC, 15n * TRAC));
      });

      it('both service classes are always allowed, alone or together, up to the limit', async () => {
        const query = requestOf(accountId, await epochNow(), { buckets: [bucket(0, CLASS_QUERY, 40n * TRAC)] });
        await fund(query);
        await fund(await inference(accountId, 40n * TRAC, { epoch: await epochNext() }));
        await assignAs(await termsFor(accountId, buyer2.address, { maxCostPerPeriod: 40n * TRAC }), buyer2);
        await fund(await both(1n, 40n * TRAC - 1n), buyer2);
      });

      it('the limit is per period: every period of the same buyer key may reach it', async () => {
        await fund(await inference(accountId, 40n * TRAC));
        await fund(await inference(accountId, 40n * TRAC, { epoch: await epochNext() }));
        await time.increase(epLen);
        await fund(await inference(accountId, 40n * TRAC, { epoch: await epochNext() }));
        expect((await CSS.getUsage(accountId, buyer.address)).periods).to.equal(3n);
      });
    });

    it("the period's epoch: only the current epoch or the next one, once per buyer key", async () => {
      const { accountId } = await openAccount({ committed: SMALL });
      await time.increase(2n * epLen);
      const now = await epochNow();
      for (const epoch of [0n, now - 1n, now + 2n, now + 100n]) {
        await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, TRAC, { epoch })), `epoch ${epoch}`)
          .to.be.revertedWithCustomError(SS, 'InvalidFundingRequest')
          .withArgs('epoch');
      }
      await fund(await inference(accountId, TRAC, { epoch: now }));
      await fund(await inference(accountId, TRAC, { epoch: now + 1n }));
      for (const epoch of [now, now + 1n]) {
        await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, TRAC, { epoch })))
          .to.be.revertedWithCustomError(SS, 'PeriodAlreadyFunded')
          .withArgs(await SS.subscriptionIdOf(buyer.address, epoch));
      }
    });

    it('a zero session key is refused', async () => {
      const { accountId } = await openAccount({ committed: SMALL });
      await expect(
        SS.connect(buyer).fundFromConviction(await inference(accountId, TRAC, { sessionKey: ethers.ZeroAddress })),
      ).to.be.revertedWithCustomError(SS, 'ZeroSessionKey');
      await fund(await inference(accountId, TRAC));
    });

    it('the buckets: none, too many, unsorted, duplicate, zero value, unknown class, zero ask, and a sum beyond uint96', async () => {
      const { accountId } = await openAccount({ committed: SMALL, caps: WIDE });
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
        [[bucket(1, CLASS_INFERENCE, MAX_UINT96), bucket(2, CLASS_QUERY, 1n)], 'value'],
      ];
      for (const [buckets, reason] of cases) {
        await expect(SS.connect(buyer).fundFromConviction(requestOf(accountId, await epochNow(), { buckets })), reason)
          .to.be.revertedWithCustomError(SS, 'InvalidFundingRequest')
          .withArgs(reason);
      }
      const { subscriptionId } = await fund(requestOf(accountId, await epochNow(), { buckets: many(max) }));
      expect((await CSS.getSubscription(subscriptionId)).bucketCount).to.equal(BigInt(max));
      expect(await CSS.getBuckets(subscriptionId)).to.have.length(max);
    });

    it('NotAssigned, AssignmentRevoked, AssignmentExpired and ServiceSpendingDisabled', async () => {
      const { accountId } = await openAccount({ committed: SMALL });
      await expect(SS.connect(stranger).fundFromConviction(await inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(SS, 'NotAssigned')
        .withArgs(accountId, stranger.address);
      await expect(SS.connect(buyer).fundFromConviction(await inference(424242n, TRAC)))
        .to.be.revertedWithCustomError(SS, 'ServiceSpendingDisabled')
        .withArgs(424242n);
      await SS.connect(owner).setServiceSpending(accountId, false);
      await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(SS, 'ServiceSpendingDisabled')
        .withArgs(accountId);
      await SS.connect(owner).setServiceSpending(accountId, true);
      await SS.connect(owner).revoke(accountId, buyer.address);
      await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(SS, 'AssignmentRevoked')
        .withArgs(accountId, buyer.address);

      const short = await termsFor(accountId, buyer2.address, { expiresAt: (await latest()) + 5n * DAY });
      await assignAs(short, buyer2);
      await fund(await inference(accountId, TRAC), buyer2);
      await time.increaseTo(short.expiresAt);
      await expect(SS.connect(buyer2).fundFromConviction(await inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(SS, 'AssignmentExpired')
        .withArgs(accountId, buyer2.address);
    });

    it('InsufficientAllowance, with no partial effect', async () => {
      const { accountId } = await openAccount({ committed: SMALL, caps: WIDE });
      await topUp(accountId, 100n * TRAC);
      await fund(await inference(accountId, 600n * TRAC));
      const before = await fundingState(accountId, buyer.address, 0n);
      const next = await epochNext();
      const r = await inference(accountId, 501n * TRAC, { epoch: next });
      const epoch = await ChronosContract.getCurrentEpoch();
      await expect(SS.connect(buyer).fundFromConviction(r))
        .to.be.revertedWithCustomError(SS, 'InsufficientAllowance')
        .withArgs(accountId, epoch, 501n * TRAC, 500n * TRAC);
      expect(await fundingState(accountId, buyer.address, 0n)).to.deep.equal(before);
      expect(await CSS.subscriptionExists(await SS.subscriptionIdOf(buyer.address, r.epoch))).to.equal(false);

      // Exactly what is left: the window, then the buffer.
      const { receipt } = await fund(await inference(accountId, 500n * TRAC, { epoch: next }));
      const [covered] = await eventsOf(receipt, PC, 'ServiceCostCovered');
      expect([covered.drawnFromWindow, covered.drawnFromTopUp]).to.deep.equal([400n * TRAC, 100n * TRAC]);
    });

    it('AccountExpired, for an assignment that outlives the account', async () => {
      const { accountId } = await openAccount({ committed: SMALL });
      const acct = await PCS.getAccount(accountId);
      expect((await CSS.getAssignment(accountId, buyer.address)).expiresAt).to.be.greaterThan(acct.expiresAtTimestamp);
      await time.increaseTo(acct.expiresAtTimestamp);
      await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(SS, 'AccountExpired')
        .withArgs(accountId, acct.expiresAtEpoch);
    });

    it('a wired treasury pauses funding with ServiceFundingPausedTreasuryWired', async () => {
      const { accountId } = await openAccount({ committed: SMALL });
      await Params.setProtocolTreasury(treasury.address);
      await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(SS, 'ServiceFundingPausedTreasuryWired')
        .withArgs(treasury.address);
      await Params.setProtocolTreasury(ethers.ZeroAddress);
      await fund(await inference(accountId, TRAC));
    });

    it('coverServiceCost called from any address but ServiceSubscriptions reverts OnlyServiceSubscriptions', async () => {
      const { accountId } = await openAccount({ committed: SMALL });
      const nft = await impersonate(await NFT.getAddress());
      for (const caller of [owner, buyer, stranger, accounts[0], nft]) {
        await expect(PC.connect(caller).coverServiceCost(accountId, buyer.address, ethers.id('x'), TRAC))
          .to.be.revertedWithCustomError(PC, 'OnlyServiceSubscriptions')
          .withArgs(caller.address);
      }
    });

    it('a draw that does not match the cost or the window computed here reverts DrawMismatch', async () => {
      const discounted = await openAccount({ caps: WIDE });
      const plain = await openAccount({ committed: SMALL, caps: WIDE });
      const Skew = await hre.ethers.getContractFactory('MockSkewedServiceDraw');
      const skew = (await Skew.deploy()) as unknown as MockSkewedServiceDraw;
      await HubContract.setContractAddress('PublishingConviction', await skew.getAddress());

      // The stand-in charges the undiscounted value.
      await expect(SS.connect(buyer).fundFromConviction(await inference(discounted.accountId, 10n * TRAC)))
        .to.be.revertedWithCustomError(SS, 'DrawMismatch')
        .withArgs(7n * TRAC, 10n * TRAC, 0n, 0n);
      // With no discount the cost matches, and a wrong window is refused.
      await skew.setWindow(5n);
      await expect(SS.connect(buyer).fundFromConviction(await inference(plain.accountId, 10n * TRAC)))
        .to.be.revertedWithCustomError(SS, 'DrawMismatch')
        .withArgs(10n * TRAC, 10n * TRAC, 0n, 5n);
    });

    it('a cost the base schedule cannot label reverts LabelCapacityExceeded, with no partial effect', async () => {
      const { accountId, createdAt } = await openAccount({ committed: SMALL, caps: WIDE });
      const S = await scheduleOf(SMALL, createdAt);
      const { first, last } = await spanOf(createdAt);
      const current = await ChronosContract.getCurrentEpoch();
      // Leave 5 TRAC of capacity, in the epoch with the most emission, and fill
      // every other epoch the funding could reach. A Hub owner write: the
      // storage trusts Hub contracts and governance, as the account storage does.
      let widest = first;
      for (let e = first; e <= last; e++) if (S.get(e)! > S.get(widest)!) widest = e;
      for (let e = current > first ? current : first; e <= last; e++) {
        const fill = S.get(e)! - (e === widest ? 5n * TRAC : 0n);
        if (fill > 0n) await CSS.addBaseLabel(accountId, e, fill);
      }
      expect(await SS.baseLabelCapacity(accountId)).to.equal(5n * TRAC);

      const before = await fundingState(accountId, buyer.address, 0n);
      await expect(SS.connect(buyer).fundFromConviction(await inference(accountId, 8n * TRAC)))
        .to.be.revertedWithCustomError(SS, 'LabelCapacityExceeded')
        .withArgs(accountId, 3n * TRAC);
      expect(await fundingState(accountId, buyer.address, 0n)).to.deep.equal(before);

      await fund(await inference(accountId, 5n * TRAC));
      expect(await SS.baseLabelCapacity(accountId)).to.equal(0n);
      expect(await CSS.baseLabel(accountId, widest)).to.equal(S.get(widest)!);
    });
  });

  // -------------------------------------------------------------------------
  // Period records
  // -------------------------------------------------------------------------

  describe('period records', () => {
    beforeEach(async () => {
      await cutOver();
    });

    it('every period starts at the block time during its epoch, or at its epoch start ahead of it, so its record reads as existing', async () => {
      const { accountId } = await openAccount({ committed: SMALL });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        // The current epoch first, then the next one, then, an epoch later, the next one again.
        if (i === 2) await time.increase(epLen);
        const epoch = i === 0 ? await epochNow() : await epochNext();
        const { subscriptionId, receipt } = await fund(await inference(accountId, TRAC, { epoch }));
        const s = await CSS.getSubscription(subscriptionId);
        const ts = await blockTime(receipt);
        const epochStart = await ChronosContract.timestampForEpoch(epoch);
        expect(s.periodStart).to.equal(ts > epochStart ? ts : epochStart);
        expect(s.periodEnd).to.equal(await ChronosContract.timestampForEpoch(epoch + 1n));
        expect(s.periodStart).to.be.greaterThan(0n);
        expect(await CSS.subscriptionExists(subscriptionId)).to.equal(true);
        ids.push(subscriptionId);
      }
      expect(await CSS.accountSubscriptionCount(accountId)).to.equal(3n);
      for (let i = 0; i < ids.length; i++) {
        expect(await CSS.accountSubscriptionAt(accountId, BigInt(i))).to.equal(ids[i]);
      }
    });

    it('a second funding for an epoch reverts PeriodAlreadyFunded and changes nothing; another buyer key may fund that epoch', async () => {
      const { accountId } = await openAccount({ committed: SMALL });
      const r = requestOf(accountId, await epochNow(), {
        buckets: [bucket(0, CLASS_INFERENCE, 2n * TRAC), bucket(1, CLASS_QUERY, TRAC)],
      });
      const { subscriptionId } = await fund(r);
      const before = await fundingState(accountId, buyer.address, 0n);
      const record = plain(await CSS.getSubscription(subscriptionId));
      await expect(SS.connect(buyer).fundFromConviction(r))
        .to.be.revertedWithCustomError(SS, 'PeriodAlreadyFunded')
        .withArgs(subscriptionId);
      // A different plan for the same epoch is the same period.
      await expect(SS.connect(buyer).fundFromConviction({ ...r, buckets: [bucket(0, CLASS_INFERENCE, TRAC)] }))
        .to.be.revertedWithCustomError(SS, 'PeriodAlreadyFunded')
        .withArgs(subscriptionId);
      expect(await fundingState(accountId, buyer.address, 0n)).to.deep.equal(before);
      expect(plain(await CSS.getSubscription(subscriptionId))).to.deep.equal(record);
      expect(await CSS.getBuckets(subscriptionId)).to.have.length(2);

      await assignAs(await termsFor(accountId, buyer2.address), buyer2);
      const other = await fund(r, buyer2);
      expect(other.subscriptionId).to.not.equal(subscriptionId);
      expect(await CSS.accountSubscriptionCount(accountId)).to.equal(2n);
    });

    it('the storage itself refuses a record whose periodStart is 0, which would read as absent, from any Hub writer', async () => {
      // A Hub owner write, which the storage admits as it admits any Hub contract.
      const id = ethers.id('ghost');
      const record = {
        accountId: 1n,
        assignee: buyer.address,
        sessionKey: SESSION_KEY,
        periodId: ethers.id('ghost-period'),
        planDigest: ethers.ZeroHash,
        periodStart: 0n,
        periodEnd: 0n,
        fundedEpoch: 1n,
        fundedWindow: 0n,
        discountBps: 0n,
        bucketCount: 1n,
        value: TRAC,
        cost: TRAC,
        drawnFromWindow: TRAC,
        drawnFromTopUp: 0n,
      };
      const buckets = [bucket(0, CLASS_INFERENCE, TRAC)];
      await expect(CSS.createSubscription(id, record, buckets))
        .to.be.revertedWithCustomError(CSS, 'ZeroPeriodStart')
        .withArgs(id);
      expect(await CSS.subscriptionExists(id)).to.equal(false);
      expect(await CSS.getBuckets(id)).to.have.length(0);
      expect(await CSS.accountSubscriptionCount(1n)).to.equal(0n);

      // With a start, the same write records the period once; a second write
      // under the id is refused, so its buckets are never appended twice.
      const started = { ...record, periodStart: 1_700_000_000n, periodEnd: 1_700_000_000n + DAY };
      await CSS.createSubscription(id, started, buckets);
      expect(await CSS.subscriptionExists(id)).to.equal(true);
      await expect(CSS.createSubscription(id, started, buckets))
        .to.be.revertedWithCustomError(CSS, 'SubscriptionExists')
        .withArgs(id);
      expect(await CSS.getBuckets(id)).to.have.length(1);
      expect(await CSS.accountSubscriptionCount(1n)).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // Shared allowance
  // -------------------------------------------------------------------------

  describe('shared allowance', () => {
    const stakeV10 = async (staker: SignerWithAddress, identityId: number, amount: bigint) => {
      await Token.mint(staker.address, amount);
      await Token.connect(staker).approve(await StakingV10Contract.getAddress(), amount);
      await StakingNFT.connect(staker).createConviction(identityId, amount, 1);
    };

    const standUpNodes = async () => {
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const { identityId: publisherIdentityId } = await createProfile(ProfileContract, publishingNode);
      const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
      const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);
      await stakeV10(publishingNode.operational, publisherIdentityId, MIN_STAKE);
      for (let i = 0; i < receivingNodes.length; i++) {
        await stakeV10(receivingNodes[i].operational, receiverProfiles[i].identityId, MIN_STAKE);
      }
      return { receivingNodes, publisherIdentityId, receiverIdentityIds };
    };

    it('publishing and services draw one window allowance, first come first served; a publish that finds it spent pays directly', async () => {
      await cutOver();
      const nodes = await standUpNodes();
      const agent = getDefaultKACreator(accounts);
      const { accountId } = await openAccount({ committed: SMALL, caps: WIDE });
      await NFT.connect(owner).registerAgent(accountId, agent.address);
      await CGFacade.connect(agent).createContextGraph([], 0, 0, 1, ethers.ZeroAddress, 0, ethers.ZeroHash);
      const cgId = await CGS.getLatestContextGraphId();
      const B = SMALL / lock;
      let kaNumber = 0;

      const publish = async (tokenAmount: bigint) => {
        kaNumber += 1;
        await Token.mint(agent.address, tokenAmount);
        await Token.connect(agent).approve(await KAL.getAddress(), tokenAmount);
        const p = await buildPublishParams({
          chainId: DEFAULT_CHAIN_ID,
          kav10Address: await KAL.getAddress(),
          receivingNodes: nodes.receivingNodes,
          publisherIdentityId: nodes.publisherIdentityId,
          receiverIdentityIds: nodes.receiverIdentityIds,
          author: agent,
          contextGraphId: cgId,
          merkleRoot: ethers.id(`shared-${kaNumber}`),
          knowledgeAssetsAmount: 1,
          byteSize: 1000,
          epochs: Number(lock),
          tokenAmount,
          isImmutable: false,
          publishOperationId: `shared-op-${kaNumber}`,
          reservedKaId: packReservedKaId(agent.address, kaNumber),
        });
        return (await (await KAL.connect(agent).publish(p)).wait())!;
      };

      const p1 = await publish(100n * TRAC);
      expect(await eventsOf(p1, PC, 'CostCovered')).to.have.length(1);
      expect(await PCS.windowSpent(accountId, 0n)).to.equal(100n * TRAC);

      await fund(await inference(accountId, 300n * TRAC));
      expect(await PCS.windowSpent(accountId, 0n)).to.equal(400n * TRAC);
      expect(await CSS.serviceSpent(accountId, 0n)).to.equal(300n * TRAC);

      await publish(200n * TRAC);
      expect(await PCS.windowSpent(accountId, 0n)).to.equal(600n * TRAC);

      await fund(await inference(accountId, B - 600n * TRAC, { epoch: await epochNext() }));
      expect(await PCS.windowSpent(accountId, 0n)).to.equal(B);
      expect(await CSS.serviceSpent(accountId, 0n)).to.equal(B - 300n * TRAC);

      // The window is spent and there is no top-up buffer: the publish falls
      // through to direct spend from the agent's wallet, and a funding is refused.
      const balance = await Token.balanceOf(agent.address);
      const p3 = await publish(50n * TRAC);
      expect(await eventsOf(p3, PC, 'CostCovered')).to.have.length(0);
      expect(balance + 50n * TRAC - (await Token.balanceOf(agent.address))).to.equal(50n * TRAC);
      expect(await PCS.windowSpent(accountId, 0n)).to.equal(B);
      await assignAs(await termsFor(accountId, buyer2.address, WIDE), buyer2);
      await expect(SS.connect(buyer2).fundFromConviction(await inference(accountId, TRAC)))
        .to.be.revertedWithCustomError(SS, 'InsufficientAllowance')
        .withArgs(accountId, await ChronosContract.getCurrentEpoch(), TRAC, 0n);
    });
  });

  // -------------------------------------------------------------------------
  // No TRAC moves
  // -------------------------------------------------------------------------

  describe('no TRAC moves', () => {
    beforeEach(async () => {
      await cutOver();
    });

    const tokenLogs = async (receipt: ContractTransactionReceipt) => {
      const address = (await Token.getAddress()).toLowerCase();
      return receipt.logs.filter((l) => l.address.toLowerCase() === address);
    };

    it('a base-only funding moves no token, leaves the vault, and leaves the staker pool unchanged over the span', async () => {
      const { accountId, createdAt } = await openAccount({ caps: WIDE });
      const { first, last } = await spanOf(createdAt);
      const pool = await poolSnapshot(first - 1n, last + 1n);
      const remainder = await ES.accumulatedRemainder(STAKER_SHARD_ID);
      const vault = await Token.balanceOf(await Vault.getAddress());

      const { receipt } = await fund(await inference(accountId, 1_000n * TRAC));
      expect(await tokenLogs(receipt)).to.have.length(0);
      expect(await creditedRanges(receipt)).to.have.length(0);
      expect(await Token.balanceOf(await Vault.getAddress())).to.equal(vault);
      expect(await poolSnapshot(first - 1n, last + 1n)).to.deep.equal(pool);
      expect(await ES.accumulatedRemainder(STAKER_SHARD_ID)).to.equal(remainder);

      // Every labelled epoch stays within the pool it labels.
      for (let e = first; e <= last; e++) {
        expect(await CSS.serviceLabel(e)).to.be.at.most(await ES.getEpochPool(STAKER_SHARD_ID, e));
      }
    });

    it("a top-up funding moves no token and adds to the pool exactly the overflow's ranges", async () => {
      const { accountId, createdAt } = await openAccount({ caps: WIDE });
      await fund(await inference(accountId, valueFor(COMMITTED / lock, 3_000n)));
      await topUp(accountId, 1_000n * TRAC);
      // The shard's division remainder carry is 0, so each epoch gets its range's exact share.
      expect(await ES.accumulatedRemainder(STAKER_SHARD_ID)).to.equal(0n);
      const { first, last } = await spanOf(createdAt);
      const pool = await poolSnapshot(first - 1n, last + 1n);
      const vault = await Token.balanceOf(await Vault.getAddress());

      const { cost, receipt } = await fund(await inference(accountId, 1_000n * TRAC, { epoch: await epochNext() }));
      expect(await tokenLogs(receipt)).to.have.length(0);
      expect(await Token.balanceOf(await Vault.getAddress())).to.equal(vault);

      const ts = await blockTime(receipt);
      const model = new PoolModel(0n);
      for (const r of prorateActiveSink(cost, await ChronosContract.epochAtTimestamp(ts), lock, epLen, await timeLeftAt(ts))) {
        model.add(r);
      }
      const after = await poolSnapshot(first - 1n, last + 1n);
      for (const [e, v] of after) {
        expect(v - pool.get(e)!, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
      }
      for (let e = first; e <= last; e++) {
        expect(await CSS.serviceLabel(e)).to.be.at.most(await ES.getEpochPool(STAKER_SHARD_ID, e));
      }
    });
  });

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  describe('views', () => {
    beforeEach(async () => {
      await cutOver();
    });

    it('previewCost: every tier, the floor, a zero value, and an unknown account', async () => {
      for (const [committed, bps] of TIERS) {
        const { accountId } = await createAccountFor(owner, committed);
        for (const value of [0n, 1n, 3n, 10n * TRAC + 7n]) {
          expect(await SS.previewCost(accountId, value)).to.deep.equal([costOf(value, bps), bps]);
        }
      }
      await expect(SS.previewCost(424242n, TRAC)).to.be.revertedWithCustomError(PCS, 'UnknownAccount').withArgs(424242n);
    });

    it('currentWindowAllowance follows the block time where getRemainingAllowance maps an epoch start to the previous window', async () => {
      // Create the account a third into an epoch, so its windows straddle epoch starts.
      const start = await ChronosContract.startTime();
      const epochNow = await ChronosContract.getCurrentEpoch();
      await time.increaseTo(start + epochNow * epLen + epLen / 3n);
      const { accountId, createdAt } = await openAccount({ committed: SMALL, caps: WIDE });
      const B = SMALL / lock;
      await topUp(accountId, 70n * TRAC);
      await fund(await inference(accountId, 400n * TRAC));
      const createdEpoch = await ChronosContract.epochAtTimestamp(createdAt);
      const createdOffset = createdAt - (await ChronosContract.timestampForEpoch(createdEpoch));

      // In the next epoch, before the creation's time of day, both views read window 0.
      await time.increaseTo((await ChronosContract.timestampForEpoch(createdEpoch + 1n)) + createdOffset / 2n);
      expect(await SS.currentWindowAllowance(accountId)).to.deep.equal([0n, B - 400n * TRAC, 70n * TRAC, false]);
      expect(await PC.getRemainingAllowance(accountId, createdEpoch + 1n)).to.equal(B - 400n * TRAC + 70n * TRAC);

      // At or after it, the block time is in window 1, which getRemainingAllowance does not see.
      await time.increaseTo((await ChronosContract.timestampForEpoch(createdEpoch + 1n)) + createdOffset + 10n);
      expect(await SS.currentWindowAllowance(accountId)).to.deep.equal([1n, B, 70n * TRAC, false]);
      expect(await PC.getRemainingAllowance(accountId, createdEpoch + 1n)).to.equal(B - 400n * TRAC + 70n * TRAC);
      // A funding draws on window 1, as currentWindowAllowance said.
      const { receipt } = await fund(await inference(accountId, 10n * TRAC));
      expect((await eventsOf(receipt, PC, 'ServiceCostCovered'))[0].window).to.equal(1n);

      // After expiry the window is capped at the lock, and nothing is left of the base allowance.
      await time.increaseTo((await PCS.getAccount(accountId)).expiresAtTimestamp + 1n);
      expect(await SS.currentWindowAllowance(accountId)).to.deep.equal([lock, 0n, 70n * TRAC, true]);
    });

    it('scheduledEmission is the account schedule, emissionSpan its epochs, and baseLabelCapacity what is left to label', async () => {
      const { accountId, createdAt } = await openAccount({ caps: WIDE });
      const S = await scheduleOf(COMMITTED, createdAt);
      const { first, last } = await spanOf(createdAt);
      expect(await SS.emissionSpan(accountId)).to.deep.equal([first, last]);
      let total = 0n;
      for (let e = first - 2n; e <= last + 2n; e++) {
        expect(await SS.scheduledEmission(accountId, e), `epoch ${e}`).to.equal(S.get(e) ?? 0n);
        total += S.get(e) ?? 0n;
      }
      expect(total).to.equal(COMMITTED);

      // Nothing is labelled yet, and the span starts after the current epoch.
      expect(await ChronosContract.getCurrentEpoch()).to.be.lessThan(first);
      expect(await SS.baseLabelCapacity(accountId)).to.equal(COMMITTED);
      const { cost } = await fund(await inference(accountId, 2_000n * TRAC));
      expect(await SS.baseLabelCapacity(accountId)).to.equal(COMMITTED - cost);

      // Later, the epochs before the current one no longer count.
      await time.increase(3n * epLen);
      const current = await ChronosContract.getCurrentEpoch();
      let left = 0n;
      for (let e = current; e <= last; e++) {
        const free = (S.get(e) ?? 0n) - (await CSS.baseLabel(accountId, e));
        if (free > 0n) left += free;
      }
      expect(await SS.baseLabelCapacity(accountId)).to.equal(left);
    });
  });
});
