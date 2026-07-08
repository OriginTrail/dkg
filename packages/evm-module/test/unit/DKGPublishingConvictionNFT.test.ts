import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  EpochStorage,
  Hub,
  PublishingConviction,
  PublishingConvictionStorage,
  StakingStorage,
  Token,
} from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGPublishingConvictionNFT;
  Logic: PublishingConviction;
  Storage: PublishingConvictionStorage;
  Token: Token;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  EpochStorage: EpochStorage;
  Chronos: Chronos;
};

const LOCK_DURATION = 12;
// A single billing window of length `epochLength` overlaps either 1 or 2
// chain epochs depending on alignment with `createdAtTimestamp`, so the
// account lifetime can touch up to `LOCK_DURATION + 1` chain epochs.
const MAX_CHAIN_EPOCHS_TOUCHED = LOCK_DURATION + 1;
const STAKER_SHARD_ID = 1n;
const BPS = 10_000n;

// Helper that matches the contract's highest-tier-first ladder.
function expectedBps(trac: bigint): bigint {
  const ether = (n: bigint) => n * 10n ** 18n;
  if (trac >= ether(1_000_000n)) return 7500n;
  if (trac >= ether(500_000n)) return 5000n;
  if (trac >= ether(250_000n)) return 4000n;
  if (trac >= ether(100_000n)) return 3000n;
  if (trac >= ether(50_000n)) return 2000n;
  if (trac >= ether(25_000n)) return 1000n;
  return 0n;
}

async function currentBillingWindow(createdAtTimestamp: bigint, epochLength: bigint): Promise<bigint> {
  const block = await hre.ethers.provider.getBlock('latest');
  if (!block) {
    throw new Error('Latest block not found');
  }
  return (BigInt(block.timestamp) - createdAtTimestamp) / epochLength;
}

describe('@unit DKGPublishingConvictionNFT', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let NFT: DKGPublishingConvictionNFT;
  let LogicContract: PublishingConviction;
  let StorageContract: PublishingConvictionStorage;
  let TokenContract: Token;
  let StakingStorageContract: StakingStorage;
  let ConvictionStakingStorageContract: ConvictionStakingStorage;
  let EpochStorageContract: EpochStorage;
  let ChronosContract: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      // V10 split: storage + logic + slim ERC-721 wrapper
      'PublishingConvictionStorage',
      'PublishingConviction',
      'DKGPublishingConvictionNFT',
      'Token',
      'StakingStorage',
      // v4.0.0 — V10 vault is CSS post-consolidation; needed for createAccount/topUp asserts.
      'ConvictionStakingStorage',
      'EpochStorage',
      'Chronos',
    ]);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const NFT = await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT');
    const Logic = await hre.ethers.getContract<PublishingConviction>('PublishingConviction');
    const Storage = await hre.ethers.getContract<PublishingConvictionStorage>(
      'PublishingConvictionStorage',
    );
    const Token = await hre.ethers.getContract<Token>('Token');
    const StakingStorageC = await hre.ethers.getContract<StakingStorage>('StakingStorage');
    const CSS = await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage');
    const EpochStorageC = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    const ChronosC = await hre.ethers.getContract<Chronos>('Chronos');
    const accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    // Mint plenty of TRAC to the main test actor
    await Token.mint(accounts[0].address, hre.ethers.parseEther('10000000'));
    await Token.mint(accounts[1].address, hre.ethers.parseEther('10000000'));
    return {
      accounts,
      Hub,
      NFT,
      Logic,
      Storage,
      Token,
      StakingStorage: StakingStorageC,
      ConvictionStakingStorage: CSS,
      EpochStorage: EpochStorageC,
      Chronos: ChronosC,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      NFT,
      Logic: LogicContract,
      Storage: StorageContract,
      Token: TokenContract,
      StakingStorage: StakingStorageContract,
      ConvictionStakingStorage: ConvictionStakingStorageContract,
      EpochStorage: EpochStorageContract,
      Chronos: ChronosContract,
    } = await loadFixture(deployFixture));
  });

  afterEach(async () => {
    // Flow-through invariant: the NFT contract must NEVER hold TRAC.
    expect(await TokenContract.balanceOf(await NFT.getAddress())).to.equal(0n);
  });

  // ======================================================================
  // A. Tier table (G1)
  // ======================================================================

  describe('discount tier ladder (6 tiers, highest-first)', () => {
    const cases: Array<[string, bigint, bigint]> = [
      ['24_999 TRAC → 0%', hre.ethers.parseEther('24999'), 0n],
      ['exactly 25K → 10%', hre.ethers.parseEther('25000'), 1000n],
      ['exactly 50K → 20%', hre.ethers.parseEther('50000'), 2000n],
      ['exactly 100K → 30%', hre.ethers.parseEther('100000'), 3000n],
      ['exactly 250K → 40%', hre.ethers.parseEther('250000'), 4000n],
      ['exactly 500K → 50%', hre.ethers.parseEther('500000'), 5000n],
      ['exactly 1M → 75%', hre.ethers.parseEther('1000000'), 7500n],
      ['1M + 1 wei → 75% (highest tier sticks)', hre.ethers.parseEther('1000000') + 1n, 7500n],
    ];
    for (const [label, amount, bps] of cases) {
      it(label, async () => {
        expect(await NFT.getDiscountBps(amount)).to.equal(bps);
        expect(expectedBps(amount)).to.equal(bps);
      });
    }

    it('logic contract and NFT wrapper share the ladder around every threshold', async () => {
      const sources = [
        readFileSync(join(__dirname, '../../contracts/PublishingConviction.sol'), 'utf8'),
        readFileSync(join(__dirname, '../../contracts/DKGPublishingConvictionNFT.sol'), 'utf8'),
      ];
      for (const source of sources) {
        expect(source).to.include('PublishingMathLib.discountBps(committedTRAC)');
      }

      const thresholds = [
        hre.ethers.parseEther('25000'),
        hre.ethers.parseEther('50000'),
        hre.ethers.parseEther('100000'),
        hre.ethers.parseEther('250000'),
        hre.ethers.parseEther('500000'),
        hre.ethers.parseEther('1000000'),
      ];
      const amounts = [
        0n,
        ...thresholds.flatMap((threshold) => [threshold - 1n, threshold, threshold + 1n]),
        (1n << 96n) - 1n,
      ];

      for (const amount of amounts) {
        const expected = expectedBps(amount);
        expect(await NFT.getDiscountBps(amount)).to.equal(expected);
        expect(await LogicContract.getDiscountBps(amount)).to.equal(expected);
      }
    });
  });

  // ======================================================================
  // B. createAccount flow-through (G2)
  // ======================================================================

  describe('createAccount: flow-through to StakingStorage', () => {
    it('transfers TRAC directly from user to ConvictionStakingStorage (NFT balance stays 0)', async () => {
      // v4.0.0 — TRAC vault moved from StakingStorage to ConvictionStakingStorage
      // in the V10 staking consolidation. The publishing-conviction NFT now
      // routes committed TRAC straight into CSS, the canonical V10 vault.
      const amount = hre.ethers.parseEther('1000000');
      const nftAddr = await NFT.getAddress();
      const cssAddr = await ConvictionStakingStorageContract.getAddress();
      const ssAddr = await StakingStorageContract.getAddress();

      const userBefore = await TokenContract.balanceOf(accounts[0].address);
      const nftBefore = await TokenContract.balanceOf(nftAddr);
      const cssBefore = await TokenContract.balanceOf(cssAddr);
      const ssBefore = await TokenContract.balanceOf(ssAddr);
      expect(nftBefore).to.equal(0n);

      await TokenContract.approve(nftAddr, amount);
      await NFT.createAccount(amount, 0);

      expect(await TokenContract.balanceOf(nftAddr)).to.equal(0n);
      expect(await TokenContract.balanceOf(accounts[0].address)).to.equal(userBefore - amount);
      expect(await TokenContract.balanceOf(cssAddr)).to.equal(cssBefore + amount);
      // V8 StakingStorage TRAC balance is untouched on V10 deposits.
      expect(await TokenContract.balanceOf(ssAddr)).to.equal(ssBefore);
    });

    it('mints NFT and records account struct with fixed tier and 12-epoch expiry', async () => {
      const amount = hre.ethers.parseEther('1000000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);

      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      const info = await NFT.getAccountInfo(1);
      expect(info.committedTRAC).to.equal(amount);
      expect(info.createdAtEpoch).to.equal(currentEpoch);
      const epochLength = await ChronosContract.epochLength();
      expect(info.expiresAtTimestamp - info.createdAtTimestamp).to.equal(
        BigInt(LOCK_DURATION) * epochLength,
      );
      expect(info.expiresAtEpoch - info.createdAtEpoch).to.be.gte(BigInt(LOCK_DURATION));
      expect(info.discountBps).to.equal(7500n);
      expect(info.baseEpochAllowance).to.equal(amount / 12n);
      expect(info.topUpBuffer).to.equal(0n);
      expect(info.agentCount).to.equal(0n);
    });

    it('emits AccountCreated with correct args', async () => {
      const amount = hre.ethers.parseEther('500000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      await expect(NFT.createAccount(amount, 0)).to.emit(LogicContract, 'AccountCreated');
      const info = await NFT.getAccountInfo(1);
      expect(info.createdAtEpoch).to.equal(currentEpoch);
      expect(info.expiresAtEpoch - info.createdAtEpoch).to.be.gte(BigInt(LOCK_DURATION));
    });

    it('reverts with InvalidAmount on zero', async () => {
      // RFC-51: createAccount(committedTRAC, primaryNode). committedTRAC=0
      // still trips InvalidAmount; primaryNode=0 is a legitimate inert node.
      await expect(NFT.createAccount(0, 0)).to.be.revertedWithCustomError(NFT, 'InvalidAmount');
    });

    it('assigns incrementing IDs', async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount * 2n);
      await NFT.createAccount(amount, 0);
      await NFT.createAccount(amount, 0);
      expect(await NFT.totalSupply()).to.equal(2n);
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.ownerOf(2)).to.equal(accounts[0].address);
    });
  });

  // ======================================================================
  // C. createAccount escrow-only model (lazy-settlement)
  // ======================================================================

  describe('createAccount: deterministic emission schedule (10.0.8)', () => {
    it('writes the FULL staker-pool schedule upfront — pool deltas sum to committedTRAC and the escrow moves to CSS', async () => {
      // 10.0.8 model: the staker-pool distribution of the entire committed
      // amount is written at createAccount (each window's budget forward-
      // spread over the lock). The TRAC itself still escrows in the CSS
      // vault — addTokensToEpochRange is bookkeeping, not a transfer.
      const amount = hre.ethers.parseEther('1200000');
      const current = await ChronosContract.getCurrentEpoch();
      // Schedule can span up to 2*lock + 2 chain epochs (mid-epoch anchor).
      const span = 2 * LOCK_DURATION + 3;

      const before: bigint[] = [];
      for (let i = 0; i < span; i++) {
        before.push(await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i)));
      }
      const remainderBefore = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);
      const cssAddr = await ConvictionStakingStorageContract.getAddress();
      const cssBefore = await TokenContract.balanceOf(cssAddr);

      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);

      // Pool deltas: the whole commitment is scheduled up front —
      // non-negative everywhere, summing to EXACTLY committedTRAC
      // (modulo the shard-global division remainder carry).
      let sum = 0n;
      for (let i = 0; i < span; i++) {
        const after = await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i));
        expect(after - before[i]).to.be.gte(0n);
        sum += after - before[i];
      }
      const remainderAfter = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);
      expect(sum + (remainderAfter - remainderBefore)).to.equal(amount);

      // Escrow balance: full committedTRAC still moved into the CSS vault
      // (the schedule is bookkeeping; the TRAC physically escrows).
      expect(await TokenContract.balanceOf(cssAddr)).to.equal(cssBefore + amount);

      // The "schedule written" marker: lastSettledWindow == lock.
      const info = await NFT.getAccountInfo(1);
      expect(info.lastSettledWindow).to.equal(BigInt(LOCK_DURATION));
      expect(info.fullySwept).to.equal(false);
    });

    it('conserves to the wei when committedTRAC % 12 != 0 (dust is scheduled with the last window)', async () => {
      // 25_013 ether + 13 wei: lowest tier (>=25K) plus a wei tail. The
      // `committedTRAC % lock` dust rides the LAST window's forward spread
      // — scheduled up front, not held back for a final sweep.
      const amount = hre.ethers.parseEther('25000') + 13n;
      const current = await ChronosContract.getCurrentEpoch();
      const span = 2 * LOCK_DURATION + 3;

      const remainderBefore = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);
      const epochBefore: bigint[] = [];
      for (let i = 0; i < span; i++) {
        epochBefore.push(
          await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i)),
        );
      }

      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);

      // Conservation to the wei, dust included.
      let sum = 0n;
      for (let i = 0; i < span; i++) {
        const after = await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i));
        sum += after - epochBefore[i];
      }
      const remainderAfter = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);
      expect(sum + (remainderAfter - remainderBefore)).to.equal(amount);
      expect(amount % BigInt(LOCK_DURATION)).to.not.equal(0n);
    });
  });

  // ======================================================================
  // C2. Multi-epoch full-flow integration test
  // ======================================================================

  describe('multi-epoch full flow', () => {
    it('createAccount -> drain window N -> advance -> cover (settles N) -> topUp -> cover drains N+1 base then topUp', async () => {
      // Impersonate KAV10 by registering accounts[5] under that Hub name. The
      // NFT resolves the caller via Hub on every coverPublishingCost call.
      const Kav10Signer = accounts[5];
      await HubContract.setContractAddress('KnowledgeAssetsLifecycle', Kav10Signer.address);

      // committedTRAC divisible by 12 → clean per-epoch allowance math.
      const committed = hre.ethers.parseEther('120000');
      const baseAllowance = committed / 12n;
      const discountBps = 3000n;
      await TokenContract.approve(await NFT.getAddress(), committed);
      await NFT.createAccount(committed, 0);

      // Register a publishing agent for account 1.
      const agent = accounts[6];
      await NFT.registerAgent(1, agent.address);

      const infoBefore = await NFT.getAccountInfo(1);
      const epochLength = await ChronosContract.epochLength();
      const windowN = await currentBillingWindow(infoBefore.createdAtTimestamp, epochLength);

      // --- Phase 1: drain window N base allowance exactly ---
      const numer = baseAllowance * BPS;
      const denom = BPS - discountBps;
      const baseCost1 = (numer + denom - 1n) / denom;
      const discounted1 = (baseCost1 * (BPS - discountBps)) / BPS;
      expect(discounted1).to.equal(baseAllowance);
      const kcStart1 = await ChronosContract.getCurrentEpoch();
      await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost1,
        kcStart1,
        LOCK_DURATION,
      );
      expect(await NFT.windowSpent(1, windowN)).to.equal(baseAllowance);

      // Any further cover in window N must revert (no topUp yet).
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('1'),
          kcStart1,
          LOCK_DURATION,
        ),
      ).to.be.revertedWithCustomError(LogicContract, 'InsufficientAllowance');

      // --- Phase 2: advance one billing window so allowance resets ---
      await time.increase(epochLength + 1n);
      const windowN1 = await currentBillingWindow(infoBefore.createdAtTimestamp, epochLength);
      expect(windowN1).to.equal(windowN + 1n);

      // Cover a small amount in the fresh window: pulls from N+1 base.
      // Window N was fully drained so the passive sink remainder for that
      // window is 0 (still, the lazy settlement marker should advance).
      const smallBase = hre.ethers.parseEther('1000');
      const smallDiscounted = (smallBase * (BPS - discountBps)) / BPS; // 700
      const kcStart2 = await ChronosContract.getCurrentEpoch();
      await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        smallBase,
        kcStart2,
        LOCK_DURATION,
      );
      expect(await NFT.windowSpent(1, windowN1)).to.equal(smallDiscounted);
      // Lazy-settlement cursor must have advanced past N now that N is closed.
      const infoAfterAdvance = await NFT.getAccountInfo(1);
      expect(infoAfterAdvance.lastSettledWindow).to.be.gte(windowN + 1n);
      // Previous billing window remains fully drained but untouched.
      expect(await NFT.windowSpent(1, windowN)).to.equal(baseAllowance);

      // --- Phase 3: topUp while account still live ---
      // topUp also lazily settles, but window N is already settled so it's
      // a no-op on the cursor.
      const topAmount = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), topAmount);
      await NFT.topUp(1, topAmount);
      expect((await NFT.getAccountInfo(1)).topUpBuffer).to.equal(topAmount);

      // --- Phase 4: cover larger than window N+1 remaining -> drains remainder then topUp ---
      const n1Remaining = baseAllowance - smallDiscounted;
      const baseCost2 = hre.ethers.parseEther('20000');
      const discounted2 = (baseCost2 * (BPS - discountBps)) / BPS; // 14000
      const expectedTopUpDraw = discounted2 - n1Remaining;

      const kcStart3 = await ChronosContract.getCurrentEpoch();
      await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost2,
        kcStart3,
        LOCK_DURATION,
      );

      // Current billing window base fully drained.
      expect(await NFT.windowSpent(1, windowN1)).to.equal(baseAllowance);
      // topUp buffer reduced by exactly the shortfall.
      const info = await NFT.getAccountInfo(1);
      expect(info.topUpBuffer).to.equal(topAmount - expectedTopUpDraw);
      // Window N still untouched — historical state is immutable.
      expect(await NFT.windowSpent(1, windowN)).to.equal(baseAllowance);
    });
  });

  describe('initialize-time dependency resolution (post-split)', () => {
    // Post-split, `DKGPublishingConvictionNFT.initialize()` resolves
    //   PublishingConvictionStorage
    //   Token
    //   ConvictionStakingStorage
    // in that order. `PublishingConviction` is resolved lazily by the
    // wrapper forwarders/getter, so logic-only Hub re-registration does
    // not require wrapper reinitialization. EpochStorageV8 / Chronos /
    // ParametersStorage are resolved by `PublishingConviction.initialize()`
    // (the logic contract). The negative-init tests below pin the
    // bubbled-up `ContractDoesNotExist(name)` for each missing branch.
    //
    // Like before, we use a disposable Hub per test (factory-deployed)
    // so the shared `loadFixture` snapshot stays valid — we never call
    // `hre.deployments.fixture` here.
    async function deployDisposableHub(): Promise<Hub> {
      const HubFactory = await hre.ethers.getContractFactory('Hub');
      const freshHub = (await HubFactory.deploy()) as unknown as Hub;
      await freshHub.waitForDeployment();
      return freshHub;
    }

    async function deployUnregisteredNFT(freshHub: Hub): Promise<DKGPublishingConvictionNFT> {
      const Factory = await hre.ethers.getContractFactory('DKGPublishingConvictionNFT');
      const nft = (await Factory.deploy(await freshHub.getAddress())) as unknown as DKGPublishingConvictionNFT;
      await nft.waitForDeployment();
      await freshHub.setContractAddress('DKGPublishingConvictionNFT', await nft.getAddress());
      return nft;
    }

    async function deployUnregisteredLogic(freshHub: Hub): Promise<PublishingConviction> {
      const Factory = await hre.ethers.getContractFactory('PublishingConviction');
      const logic = (await Factory.deploy(await freshHub.getAddress())) as unknown as PublishingConviction;
      await logic.waitForDeployment();
      await freshHub.setContractAddress('PublishingConviction', await logic.getAddress());
      return logic;
    }

    // ----- NFT.initialize() resolution order -----

    it('NFT.initialize does not require PublishingConviction to be registered', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17, signer18, signer19] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('PublishingConvictionStorage', signer17.address);
      await freshHub.setContractAddress('Token', signer18.address);
      await freshHub.setContractAddress('ConvictionStakingStorage', signer19.address);
      const nft = await deployUnregisteredNFT(freshHub);
      await expect(
        freshHub.forwardCall(
          await nft.getAddress(),
          nft.interface.encodeFunctionData('initialize'),
        ),
      ).to.not.be.reverted;

      await expect(nft.publishingConviction())
        .to.be.revertedWithCustomError(freshHub, 'ContractDoesNotExist')
        .withArgs('PublishingConviction');
    });

    it('NFT.initialize reverts when PublishingConvictionStorage is unregistered', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('PublishingConviction', signer17.address);
      const nft = await deployUnregisteredNFT(freshHub);
      await expect(
        freshHub.forwardCall(
          await nft.getAddress(),
          nft.interface.encodeFunctionData('initialize'),
        ),
      )
        .to.be.revertedWithCustomError(freshHub, 'ContractDoesNotExist')
        .withArgs('PublishingConvictionStorage');
    });

    it('NFT.initialize reverts when Token is unregistered', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17, signer18] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('PublishingConviction', signer17.address);
      await freshHub.setContractAddress('PublishingConvictionStorage', signer18.address);
      const nft = await deployUnregisteredNFT(freshHub);
      await expect(
        freshHub.forwardCall(
          await nft.getAddress(),
          nft.interface.encodeFunctionData('initialize'),
        ),
      )
        .to.be.revertedWithCustomError(freshHub, 'ContractDoesNotExist')
        .withArgs('Token');
    });

    it('NFT.initialize reverts when ConvictionStakingStorage is unregistered', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17, signer18, signer19] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('PublishingConviction', signer17.address);
      await freshHub.setContractAddress('PublishingConvictionStorage', signer18.address);
      await freshHub.setContractAddress('Token', signer19.address);
      const nft = await deployUnregisteredNFT(freshHub);
      await expect(
        freshHub.forwardCall(
          await nft.getAddress(),
          nft.interface.encodeFunctionData('initialize'),
        ),
      )
        .to.be.revertedWithCustomError(freshHub, 'ContractDoesNotExist')
        .withArgs('ConvictionStakingStorage');
    });

    // ----- Logic.initialize() resolution order -----
    // PublishingConviction.initialize() resolves
    //   PublishingConvictionStorage → EpochStorageV8 → Chronos → ParametersStorage
    // in that order; pin the same bubbled-up ContractDoesNotExist surface.

    it('Logic.initialize reverts when PublishingConvictionStorage is unregistered', async () => {
      const freshHub = await deployDisposableHub();
      const logic = await deployUnregisteredLogic(freshHub);
      await expect(
        freshHub.forwardCall(
          await logic.getAddress(),
          logic.interface.encodeFunctionData('initialize'),
        ),
      )
        .to.be.revertedWithCustomError(freshHub, 'ContractDoesNotExist')
        .withArgs('PublishingConvictionStorage');
    });

    it('Logic.initialize reverts when EpochStorageV8 is unregistered', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('PublishingConvictionStorage', signer17.address);
      const logic = await deployUnregisteredLogic(freshHub);
      await expect(
        freshHub.forwardCall(
          await logic.getAddress(),
          logic.interface.encodeFunctionData('initialize'),
        ),
      )
        .to.be.revertedWithCustomError(freshHub, 'ContractDoesNotExist')
        .withArgs('EpochStorageV8');
    });

    it('Logic.initialize reverts when Chronos is unregistered', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17, signer18] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('PublishingConvictionStorage', signer17.address);
      await freshHub.setContractAddress('EpochStorageV8', signer18.address);
      const logic = await deployUnregisteredLogic(freshHub);
      await expect(
        freshHub.forwardCall(
          await logic.getAddress(),
          logic.interface.encodeFunctionData('initialize'),
        ),
      )
        .to.be.revertedWithCustomError(freshHub, 'ContractDoesNotExist')
        .withArgs('Chronos');
    });

    it('Logic.initialize reverts when ParametersStorage is unregistered', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17, signer18, signer19] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('PublishingConvictionStorage', signer17.address);
      await freshHub.setContractAddress('EpochStorageV8', signer18.address);
      await freshHub.setContractAddress('Chronos', signer19.address);
      const logic = await deployUnregisteredLogic(freshHub);
      await expect(
        freshHub.forwardCall(
          await logic.getAddress(),
          logic.interface.encodeFunctionData('initialize'),
        ),
      )
        .to.be.revertedWithCustomError(freshHub, 'ContractDoesNotExist')
        .withArgs('ParametersStorage');
    });
  });

  // ======================================================================
  // D. topUp (G3)
  // ======================================================================

  describe('topUp', () => {
    async function createAt(amount: bigint) {
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);
    }

    it('sends TRAC directly to ConvictionStakingStorage (NFT balance stays 0) and increments topUpBalance', async () => {
      // v4.0.0 — vault role moved from StakingStorage to CSS post-consolidation.
      const initial = hre.ethers.parseEther('120000');
      const top = hre.ethers.parseEther('30000');
      await createAt(initial);

      const nftAddr = await NFT.getAddress();
      const cssAddr = await ConvictionStakingStorageContract.getAddress();
      const cssBefore = await TokenContract.balanceOf(cssAddr);

      await TokenContract.approve(nftAddr, top);
      await NFT.topUp(1, top);

      expect(await TokenContract.balanceOf(nftAddr)).to.equal(0n);
      expect(await TokenContract.balanceOf(cssAddr)).to.equal(cssBefore + top);

      const info = await NFT.getAccountInfo(1);
      expect(info.topUpBuffer).to.equal(top);
      // Tier & commit unchanged
      expect(info.committedTRAC).to.equal(initial);
      expect(info.discountBps).to.equal(3000n); // 100K tier
    });

    it('does NOT change committedTRAC, discountBps, or expiresAtEpoch', async () => {
      const initial = hre.ethers.parseEther('250000');
      const top = hre.ethers.parseEther('100000');
      await createAt(initial);
      const before = await NFT.getAccountInfo(1);

      await TokenContract.approve(await NFT.getAddress(), top);
      await NFT.topUp(1, top);

      const after = await NFT.getAccountInfo(1);
      expect(after.committedTRAC).to.equal(before.committedTRAC);
      expect(after.discountBps).to.equal(before.discountBps);
      expect(after.expiresAtEpoch).to.equal(before.expiresAtEpoch);
      expect(after.createdAtEpoch).to.equal(before.createdAtEpoch);
    });

    it('does NOT distribute topUp TRAC to the staker pool upfront — held in escrow until publish or post-expiry sweep', async () => {
      // V10 lazy-settlement: topUp is a prepaid usage buffer. It only
      // flows out via (a) the active sink when a publish exceeds the
      // base allowance, or (b) the post-expiry final sweep via settle().
      const initial = hre.ethers.parseEther('120000');
      const top = hre.ethers.parseEther('60000');
      await createAt(initial);

      const current = await ChronosContract.getCurrentEpoch();
      const before: bigint[] = [];
      for (let i = 0; i < MAX_CHAIN_EPOCHS_TOUCHED + 2; i++) {
        before.push(await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i)));
      }
      const remainderBefore = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);

      await TokenContract.approve(await NFT.getAddress(), top);
      await NFT.topUp(1, top);

      // Zero pool deltas across the account lifetime + safety margin.
      for (let i = 0; i < MAX_CHAIN_EPOCHS_TOUCHED + 2; i++) {
        const after = await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i));
        expect(after - before[i]).to.equal(0n);
      }
      const remainderAfter = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);
      expect(remainderAfter - remainderBefore).to.equal(0n);
      // topUpBuffer reflects the in-escrow amount.
      expect((await NFT.getAccountInfo(1)).topUpBuffer).to.equal(top);
    });

    it('reverts with InvalidAmount on zero', async () => {
      await createAt(hre.ethers.parseEther('60000'));
      await expect(NFT.topUp(1, 0)).to.be.revertedWithCustomError(NFT, 'InvalidAmount');
    });

    it('reverts NotAccountOwner for non-owner', async () => {
      await createAt(hre.ethers.parseEther('60000'));
      const top = hre.ethers.parseEther('10000');
      await TokenContract.connect(accounts[1]).approve(await NFT.getAddress(), top);
      await expect(NFT.connect(accounts[1]).topUp(1, top)).to.be.revertedWithCustomError(
        NFT,
        'NotAccountOwner',
      );
    });

    it('emits ToppedUp event with new cumulative buffer', async () => {
      await createAt(hre.ethers.parseEther('60000'));
      const top1 = hre.ethers.parseEther('1000');
      const top2 = hre.ethers.parseEther('2000');
      await TokenContract.approve(await NFT.getAddress(), top1 + top2);
      await expect(NFT.topUp(1, top1)).to.emit(LogicContract, 'ToppedUp').withArgs(1, top1, top1);
      await expect(NFT.topUp(1, top2)).to.emit(LogicContract, 'ToppedUp').withArgs(1, top2, top1 + top2);
    });
  });

  // ======================================================================
  // E. coverPublishingCost (G4)
  // ======================================================================

  describe('coverPublishingCost', () => {
    // N28 fix: coverPublishingCost is callable ONLY by KnowledgeAssetsV10.
    // We impersonate KAV10 by registering a test signer under that Hub name
    // and routing calls from that signer. The NFT resolves the account by
    // looking up the `publishingAgent` argument in `agentToAccountId`, so
    // every test must register at least one agent before calling.
    let Kav10Signer: SignerWithAddress;
    let agent: SignerWithAddress;

    beforeEach(async () => {
      Kav10Signer = accounts[5];
      agent = accounts[6];
      await HubContract.setContractAddress('KnowledgeAssetsLifecycle', Kav10Signer.address);
    });

    async function createAt(amount: bigint) {
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);
    }

    async function createAtWithAgent(amount: bigint, agentAddr: string) {
      await createAt(amount);
      // Account id is totalSupply (just minted). Register agent on it.
      const newId = await NFT.totalSupply();
      await NFT.registerAgent(newId, agentAddr);
      return newId;
    }

    it('returns the discounted cost and deducts from the epoch allowance — with ZERO pool emission (10.0.8 budget gate)', async () => {
      const committed = hre.ethers.parseEther('1200000');
      await createAtWithAgent(committed, agent.address);

      const baseCost = hre.ethers.parseEther('10000');
      const expectedDiscount = (baseCost * (BPS - 7500n)) / BPS; // 2500 TRAC
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      const kaEpochs = 3n;

      const returned = await NFT.connect(Kav10Signer).coverPublishingCost.staticCall(
        agent.address,
        baseCost,
        currentEpoch,
        kaEpochs,
      );
      expect(returned).to.equal(expectedDiscount);

      // 10.0.8: a base-budget spend emits NO `TokensAddedToEpochRange`
      // events — the base commitment's staker-pool distribution was fully
      // scheduled at createAccount, so `coverPublishingCost` only draws
      // the budget (`windowSpent`). Any event on this tx would be a
      // double-emission regression (only a topUp-overflow draw may emit,
      // and this spend stays within the base allowance).
      const tx = await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost,
        currentEpoch,
        kaEpochs,
      );
      const receipt = await tx.wait();
      const epsAddr = (await EpochStorageContract.getAddress()).toLowerCase();
      const iface = EpochStorageContract.interface;
      let eventCount = 0;
      for (const log of receipt!.logs) {
        if (log.address.toLowerCase() !== epsAddr) continue;
        let parsed;
        try { parsed = iface.parseLog({ topics: log.topics as string[], data: log.data }); }
        catch { continue; }
        if (parsed?.name !== 'TokensAddedToEpochRange') continue;
        eventCount++;
      }
      expect(eventCount).to.equal(0);

      const info = await NFT.getAccountInfo(1);
      const epochLength = await ChronosContract.epochLength();
      const currentWindow = await currentBillingWindow(info.createdAtTimestamp, epochLength);
      expect(await NFT.windowSpent(1, currentWindow)).to.equal(expectedDiscount);
      expect((await NFT.getAccountInfo(1)).topUpBuffer).to.equal(0n);
    });

    describe('PublishingMathLib integration', () => {
      it('PCA topUp-overflow emission ranges match the shared active-sink calculator (10.0.8: the only spend-time emission)', async () => {
        const source = readFileSync(
          join(__dirname, '../../contracts/PublishingConviction.sol'),
          'utf8',
        );
        expect(source).to.include('PublishingMathLib.prorateActiveSink(');

        // 10.0.8: a within-budget spend emits nothing (base is scheduled at
        // createAccount). The surviving spend-time emission is the topUp
        // OVERFLOW, which spreads forward over the LOCK length from the
        // current epoch — assert its event ranges byte-match the shared
        // calculator.
        const committed = hre.ethers.parseEther('1200000');
        await createAtWithAgent(committed, agent.address);
        const top = hre.ethers.parseEther('50000');
        await TokenContract.approve(await NFT.getAddress(), top);
        await NFT.topUp(1, top);

        const baseAllowance = committed / BigInt(LOCK_DURATION); // 100k
        const overflow = hre.ethers.parseEther('5000');
        // discounted = baseAllowance + overflow → baseCost = that / 0.25
        const baseCost = ((baseAllowance + overflow) * BPS) / (BPS - 7500n);
        const discounted = (baseCost * (BPS - 7500n)) / BPS;
        const expectedOverflow = discounted - baseAllowance;

        const Harness = await hre.ethers.getContractFactory('PublishingMathLibHarness');
        const harness = await Harness.deploy();
        const epochLength = await ChronosContract.epochLength();
        const targetTimestamp = BigInt(await time.latest()) + (epochLength / 2n);
        const targetEpoch = await ChronosContract.epochAtTimestamp(targetTimestamp);
        const timeRemaining =
          (await ChronosContract.timestampForEpoch(targetEpoch + 1n)) - targetTimestamp;
        const [starts, ends, amounts] = await harness.prorateActiveSink(
          expectedOverflow,
          targetEpoch,
          BigInt(LOCK_DURATION),
          epochLength,
          timeRemaining,
        );

        await time.setNextBlockTimestamp(Number(targetTimestamp));
        // Pass a kaStartEpoch deliberately away from the execution epoch
        // (`targetEpoch`): 10.0.8 anchors the overflow emission at the current
        // epoch and ignores the ABI-retained kaStartEpoch. The harness model
        // above is anchored at `targetEpoch`, so this call fails if the
        // implementation ever regresses to kaStartEpoch-anchored emission.
        const tx = await NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          baseCost,
          targetEpoch + 5n,
          LOCK_DURATION,
        );
        const receipt = await tx.wait();
        const epsAddr = (await EpochStorageContract.getAddress()).toLowerCase();
        const iface = EpochStorageContract.interface;
        const actual: Array<[bigint, bigint, bigint]> = [];
        for (const log of receipt!.logs) {
          if (log.address.toLowerCase() !== epsAddr) continue;
          let parsed;
          try { parsed = iface.parseLog({ topics: log.topics as string[], data: log.data }); }
          catch { continue; }
          if (parsed?.name !== 'TokensAddedToEpochRange') continue;
          expect(parsed.args.shardId).to.equal(STAKER_SHARD_ID);
          actual.push([
            BigInt(parsed.args.startEpoch),
            BigInt(parsed.args.endEpoch),
            BigInt(parsed.args.tokenAmount),
          ]);
        }

        const expected = starts
          .map((start, i) => [BigInt(start), BigInt(ends[i]), BigInt(amounts[i])] as [bigint, bigint, bigint])
          .filter((range) => range[2] > 0n);
        expect(actual).to.deep.equal(expected);
      });
    });

    it('spends epoch allowance first, then topUpBalance', async () => {
      const committed = hre.ethers.parseEther('120000');
      await createAtWithAgent(committed, agent.address);
      const top = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), top);
      await NFT.topUp(1, top);

      const baseCost = hre.ethers.parseEther('20000');
      const discounted = (baseCost * (BPS - 3000n)) / BPS; // 14000
      const baseAllowance = committed / 12n; // 10000
      const kaStart = await ChronosContract.getCurrentEpoch();

      await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost,
        kaStart,
        LOCK_DURATION,
      );

      const info = await NFT.getAccountInfo(1);
      const epochLength = await ChronosContract.epochLength();
      const currentWindow = await currentBillingWindow(info.createdAtTimestamp, epochLength);
      expect(await NFT.windowSpent(1, currentWindow)).to.equal(baseAllowance);
      expect(info.topUpBuffer).to.equal(top - (discounted - baseAllowance));
    });

    it('reverts InsufficientAllowance when both empty', async () => {
      const committed = hre.ethers.parseEther('60000');
      await createAtWithAgent(committed, agent.address);
      const baseCost1 = ((committed / 12n) * BPS) / (BPS - 2000n);
      const kaStart = await ChronosContract.getCurrentEpoch();
      await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost1,
        kaStart,
        LOCK_DURATION,
      );
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('100'),
          kaStart,
          LOCK_DURATION,
        ),
      ).to.be.revertedWithCustomError(LogicContract, 'InsufficientAllowance');
    });

    it('reverts NoConvictionAccount for an unregistered agent', async () => {
      const kaStart = await ChronosContract.getCurrentEpoch();
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(accounts[9].address, 1n, kaStart, 1n),
      )
        .to.be.revertedWithCustomError(LogicContract, 'NoConvictionAccount')
        .withArgs(accounts[9].address);
    });

    it('reverts InvalidConvictionKaEpochs when kaEpochs is 0 or exceeds lockDurationEpochs', async () => {
      const committed = hre.ethers.parseEther('60000');
      await createAtWithAgent(committed, agent.address);
      const kaStart = await ChronosContract.getCurrentEpoch();

      // kaEpochs == 0 → reject.
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('1'),
          kaStart,
          0n,
        ),
      )
        .to.be.revertedWithCustomError(LogicContract, 'InvalidConvictionKaEpochs')
        .withArgs(LOCK_DURATION, 0n);

      // kaEpochs == LOCK_DURATION + 1 → reject (above ceiling).
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('1'),
          kaStart,
          LOCK_DURATION + 1,
        ),
      )
        .to.be.revertedWithCustomError(LogicContract, 'InvalidConvictionKaEpochs')
        .withArgs(LOCK_DURATION, LOCK_DURATION + 1);

      // kaEpochs == LOCK_DURATION → accepted (boundary).
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('1'),
          kaStart,
          LOCK_DURATION,
        ),
      ).not.to.be.reverted;
    });

    it('N28: cross-account isolation — agent A call cannot touch account B', async () => {
      const committedA = hre.ethers.parseEther('120000');
      await createAtWithAgent(committedA, agent.address);

      const committedB = hre.ethers.parseEther('60000');
      const agentB = accounts[8];
      await TokenContract.connect(accounts[1]).approve(await NFT.getAddress(), committedB);
      await NFT.connect(accounts[1]).createAccount(committedB, 0);
      await NFT.connect(accounts[1]).registerAgent(2, agentB.address);

      const infoA = await NFT.getAccountInfo(1);
      const infoB = await NFT.getAccountInfo(2);
      const epochLength = await ChronosContract.epochLength();
      const windowA = await currentBillingWindow(infoA.createdAtTimestamp, epochLength);
      const windowB = await currentBillingWindow(infoB.createdAtTimestamp, epochLength);

      expect(await NFT.windowSpent(1, windowA)).to.equal(0n);
      expect(await NFT.windowSpent(2, windowB)).to.equal(0n);

      const kaStart = await ChronosContract.getCurrentEpoch();
      const baseCostA = hre.ethers.parseEther('1000');
      const discountedA = (baseCostA * (BPS - 3000n)) / BPS; // 700
      await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCostA,
        kaStart,
        LOCK_DURATION,
      );
      expect(await NFT.windowSpent(1, windowA)).to.equal(discountedA);
      expect(await NFT.windowSpent(2, windowB)).to.equal(0n);

      const baseCostB = hre.ethers.parseEther('500');
      const discountedB = (baseCostB * (BPS - 2000n)) / BPS; // 400
      await NFT.connect(Kav10Signer).coverPublishingCost(
        agentB.address,
        baseCostB,
        kaStart,
        LOCK_DURATION,
      );
      expect(await NFT.windowSpent(1, windowA)).to.equal(discountedA);
      expect(await NFT.windowSpent(2, windowB)).to.equal(discountedB);
    });

    it('N28: a non-KAV10 Hub-registered contract cannot call (OnlyKnowledgeAssetsV10)', async () => {
      const committed = hre.ethers.parseEther('60000');
      await createAtWithAgent(committed, agent.address);

      const Attacker = accounts[7];
      await HubContract.setContractAddress('MaliciousCaller', Attacker.address);

      const kaStart = await ChronosContract.getCurrentEpoch();
      await expect(
        NFT.connect(Attacker).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('100'),
          kaStart,
          LOCK_DURATION,
        ),
      )
        .to.be.revertedWithCustomError(NFT, 'OnlyKnowledgeAssetsV10')
        .withArgs(Attacker.address);
    });

    it('rejects EOA callers with OnlyKnowledgeAssetsV10', async () => {
      const committed = hre.ethers.parseEther('60000');
      await createAtWithAgent(committed, agent.address);
      const eoa = accounts[7];
      const kaStart = await ChronosContract.getCurrentEpoch();
      await expect(
        NFT.connect(eoa).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('100'),
          kaStart,
          LOCK_DURATION,
        ),
      )
        .to.be.revertedWithCustomError(NFT, 'OnlyKnowledgeAssetsV10')
        .withArgs(eoa.address);
    });

    it('ABI has exactly 4 parameters: (publishingAgent, baseCost, kaStartEpoch, kaEpochs)', async () => {
      const fn = NFT.interface.getFunction('coverPublishingCost');
      expect(fn).to.not.equal(null);
      expect(fn!.inputs.length).to.equal(4);
      expect(fn!.inputs[0].name).to.equal('publishingAgent');
      expect(fn!.inputs[0].type).to.equal('address');
      expect(fn!.inputs[1].name).to.equal('baseCost');
      expect(fn!.inputs[2].name).to.equal('kaStartEpoch');
      expect(fn!.inputs[3].name).to.equal('kaEpochs');
    });

    // PublishingConviction 1.0.1 — post-discount floor pin.
    //
    // Integer truncation in `(baseCost * (BPS - discountBps)) / BPS`
    // collapses `baseCost == 1` against any non-zero `discountBps` to
    // `discountedCost == 0`, which would skip `windowSpent` accounting
    // AND the active-sink reward distribution — i.e. a free
    // conviction-discounted publish on the PCA branch. The on-chain
    // `tokenAmount > 0` floor in KAV10 10.1.1 only protects the
    // direct-spend branch; this is its conviction-branch twin. The
    // floor inflates `discountedCost` to 1 wei TRAC when `baseCost > 0`
    // so both branches charge a non-zero economic cost.
    it('floors discountedCost at 1 wei when baseCost > 0 and integer truncation rounds the discount to 0', async () => {
      // Lowest tier still triggers a non-zero discountBps (1000bps).
      // Any committed amount that hits the 1000bps tier suffices.
      const committed = hre.ethers.parseEther('30000');
      await createAtWithAgent(committed, agent.address);
      const info = await NFT.getAccountInfo(1);
      expect(info.discountBps).to.be.gt(0n);

      const baseCost = 1n;
      const expectedFloor = 1n;
      const kaStart = await ChronosContract.getCurrentEpoch();
      const kaEpochs = 2n;

      // staticCall verifies the floor reaches the return value.
      const returned = await NFT.connect(Kav10Signer).coverPublishingCost.staticCall(
        agent.address,
        baseCost,
        kaStart,
        kaEpochs,
      );
      expect(returned).to.equal(expectedFloor);

      // Execute the real call: 10.0.8 — the floor must propagate to the
      // `windowSpent` BUDGET accounting (a free conviction-discounted
      // publish would otherwise skip it), while the pool sees NO events
      // (the base commitment was scheduled at createAccount; a
      // within-budget spend never emits).
      const epochLength = await ChronosContract.epochLength();
      const currentWindow = await currentBillingWindow(
        info.createdAtTimestamp,
        epochLength,
      );
      const windowSpentBefore = await NFT.windowSpent(1, currentWindow);

      const tx = await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost,
        kaStart,
        kaEpochs,
      );
      const receipt = await tx.wait();

      // Zero pool events on a within-budget spend (the floor is budget
      // accounting only since 10.0.8).
      const epsAddr = (await EpochStorageContract.getAddress()).toLowerCase();
      const iface = EpochStorageContract.interface;
      let eventCount = 0;
      for (const log of receipt!.logs) {
        if (log.address.toLowerCase() !== epsAddr) continue;
        let parsed;
        try {
          parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        } catch {
          continue;
        }
        if (parsed?.name !== 'TokensAddedToEpochRange') continue;
        eventCount++;
      }
      expect(eventCount).to.equal(0);

      // windowSpent accounting must increment by 1 (drawnFromEpoch is the
      // floored amount when the base allowance covers it) — this is the
      // guard against the free-publish truncation bug.
      const windowSpentAfter = await NFT.windowSpent(1, currentWindow);
      expect(windowSpentAfter - windowSpentBefore).to.equal(expectedFloor);
    });

    it('coverPublishingCost(baseCost = 0) stays a no-op (post-discount floor is gated on baseCost > 0)', async () => {
      const committed = hre.ethers.parseEther('30000');
      await createAtWithAgent(committed, agent.address);

      const kaStart = await ChronosContract.getCurrentEpoch();
      const kaEpochs = 2n;

      const returned = await NFT.connect(Kav10Signer).coverPublishingCost.staticCall(
        agent.address,
        0n,
        kaStart,
        kaEpochs,
      );
      expect(returned).to.equal(0n);

      const info = await NFT.getAccountInfo(1);
      const epochLength = await ChronosContract.epochLength();
      const currentWindow = await currentBillingWindow(
        info.createdAtTimestamp,
        epochLength,
      );
      const windowSpentBefore = await NFT.windowSpent(1, currentWindow);

      await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        0n,
        kaStart,
        kaEpochs,
      );

      const windowSpentAfter = await NFT.windowSpent(1, currentWindow);
      expect(windowSpentAfter - windowSpentBefore).to.equal(0n);
    });
  });

  // ======================================================================
  // F. No releaseUnspentTRAC (G7)
  // ======================================================================

  describe('releaseUnspentTRAC removal (G7)', () => {
    it('function does not exist on the ABI', async () => {
      expect(NFT.interface.getFunction('releaseUnspentTRAC')).to.equal(null);
    });
  });

  // ======================================================================
  // G. Agent management
  // ======================================================================

  describe('agent management', () => {
    beforeEach(async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);
    });

    it('registers and deregisters agents', async () => {
      const agent = accounts[3].address;
      await NFT.registerAgent(1, agent);
      expect(await NFT.getRegisteredAgents(1)).to.deep.equal([agent]);
      expect(await NFT.agentToAccountId(agent)).to.equal(1n);
      expect(await NFT.isAgent(1, agent)).to.equal(true);

      await NFT.deregisterAgent(1, agent);
      expect(await NFT.getRegisteredAgents(1)).to.deep.equal([]);
      expect(await NFT.agentToAccountId(agent)).to.equal(0n);
      expect(await NFT.isAgent(1, agent)).to.equal(false);
    });

    it('emits AgentRegistered / AgentDeregistered', async () => {
      const agent = accounts[3].address;
      await expect(NFT.registerAgent(1, agent))
        .to.emit(LogicContract, 'AgentRegistered')
        .withArgs(1, agent);
      await expect(NFT.deregisterAgent(1, agent))
        .to.emit(LogicContract, 'AgentDeregistered')
        .withArgs(1, agent);
    });

    it('enforces one-account-per-agent', async () => {
      const agent = accounts[3].address;
      await NFT.registerAgent(1, agent);
      const amount2 = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount2);
      await NFT.createAccount(amount2, 0);
      await expect(NFT.registerAgent(2, agent)).to.be.revertedWithCustomError(
        StorageContract,
        'AgentAlreadyRegistered',
      );
    });

    it('enforces agent cap', async () => {
      await NFT.setMaxAgentsPerAccount(2);
      await NFT.registerAgent(1, accounts[3].address);
      await NFT.registerAgent(1, accounts[4].address);
      await expect(
        NFT.registerAgent(1, accounts[5].address),
      ).to.be.revertedWithCustomError(LogicContract, 'AgentCapReached');
    });

    it('only owner can register agents', async () => {
      await expect(
        NFT.connect(accounts[5]).registerAgent(1, accounts[3].address),
      ).to.be.revertedWithCustomError(NFT, 'NotAccountOwner');
    });
  });

  // ======================================================================
  // H. ERC-721 behavior — agent allow-list PRESERVED across transfer
  // ======================================================================

  describe('ERC-721 transferability — agents preserved across transfer', () => {
    it('PRESERVES agent registrations on transferFrom (the allow-list travels with the PCA)', async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);
      const agent = accounts[3].address;
      await NFT.registerAgent(1, agent);

      await NFT.transferFrom(accounts[0].address, accounts[7].address, 1);

      expect(await NFT.ownerOf(1)).to.equal(accounts[7].address);
      expect(await NFT.getRegisteredAgents(1)).to.deep.equal([agent]); // preserved, not cleared
      expect(await NFT.agentToAccountId(agent)).to.equal(1n); // still bound to the account
    });

    it('PRESERVES agents on safeTransferFrom to an EOA (the standard-wallet path)', async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);
      const agent = accounts[3].address;
      await NFT.registerAgent(1, agent);

      await NFT['safeTransferFrom(address,address,uint256)'](
        accounts[0].address,
        accounts[7].address,
        1,
      );

      expect(await NFT.getRegisteredAgents(1)).to.deep.equal([agent]);
    });

    it('a new owner can ADD agents on top of the preserved list', async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);
      await NFT.registerAgent(1, accounts[3].address);
      await NFT.transferFrom(accounts[0].address, accounts[7].address, 1);
      await NFT.connect(accounts[7]).registerAgent(1, accounts[8].address);
      expect(await NFT.getRegisteredAgents(1)).to.deep.equal([
        accounts[3].address,
        accounts[8].address,
      ]);
    });
  });

  // ======================================================================
  // H2. clearAgents — explicit owner-gated bulk reset (on the logic contract)
  // ======================================================================

  describe('clearAgents (explicit owner-gated reset)', () => {
    // Create a PCA (id = totalSupply after mint) and register the given agents.
    const createAccountWithAgents = async (...agents: string[]): Promise<bigint> => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);
      const id = await NFT.totalSupply();
      for (const a of agents) await NFT.registerAgent(id, a);
      return id;
    };

    it('owner clears the whole allow-list and emits AgentsCleared(count)', async () => {
      const id = await createAccountWithAgents(accounts[3].address, accounts[4].address);

      await expect(LogicContract.clearAgents(id))
        .to.emit(LogicContract, 'AgentsCleared')
        .withArgs(id, accounts[0].address, 2);

      expect(await NFT.getRegisteredAgents(id)).to.deep.equal([]);
      expect(await NFT.agentToAccountId(accounts[3].address)).to.equal(0n);
      expect(await NFT.agentToAccountId(accounts[4].address)).to.equal(0n);
    });

    it('a NEW owner can clear the inherited allow-list after transfer', async () => {
      const id = await createAccountWithAgents(accounts[3].address);
      await NFT.transferFrom(accounts[0].address, accounts[7].address, id);
      expect(await NFT.getRegisteredAgents(id)).to.deep.equal([accounts[3].address]); // preserved

      await LogicContract.connect(accounts[7]).clearAgents(id); // new owner drops it
      expect(await NFT.getRegisteredAgents(id)).to.deep.equal([]);
      expect(await NFT.agentToAccountId(accounts[3].address)).to.equal(0n);
    });

    it('reverts NotAccountOwner for a non-owner caller', async () => {
      const id = await createAccountWithAgents(accounts[3].address);

      await expect(
        LogicContract.connect(accounts[5]).clearAgents(id),
      ).to.be.revertedWithCustomError(LogicContract, 'NotAccountOwner');
      // unchanged
      expect(await NFT.getRegisteredAgents(id)).to.deep.equal([accounts[3].address]);
    });

    it('reverts for a nonexistent account (ownerOf reverts)', async () => {
      await expect(LogicContract.clearAgents(999)).to.be.reverted;
    });
  });

  describe('registerAgents (owner-gated bulk add)', () => {
    const createAccount = async (): Promise<bigint> => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);
      return NFT.totalSupply();
    };

    it('owner bulk-registers multiple agents and emits AgentRegistered per agent', async () => {
      const id = await createAccount();
      const agents = [accounts[3].address, accounts[4].address, accounts[5].address];

      const tx = await LogicContract.registerAgents(id, agents);
      for (const a of agents) {
        await expect(tx).to.emit(LogicContract, 'AgentRegistered').withArgs(id, a);
      }
      expect(await NFT.getRegisteredAgents(id)).to.deep.equal(agents);
      for (const a of agents) expect(await NFT.agentToAccountId(a)).to.equal(id);
    });

    it('reverts NotAccountOwner for a non-owner caller (nothing registered)', async () => {
      const id = await createAccount();
      await expect(
        LogicContract.connect(accounts[5]).registerAgents(id, [accounts[3].address]),
      ).to.be.revertedWithCustomError(LogicContract, 'NotAccountOwner');
      expect(await NFT.getRegisteredAgents(id)).to.deep.equal([]);
    });

    it('reverts ZeroAgentAddress on any zero-address entry — all-or-nothing', async () => {
      const id = await createAccount();
      await expect(
        LogicContract.registerAgents(id, [accounts[3].address, hre.ethers.ZeroAddress]),
      ).to.be.revertedWithCustomError(LogicContract, 'ZeroAgentAddress');
      expect(await NFT.getRegisteredAgents(id)).to.deep.equal([]); // first entry rolled back too
    });

    it('reverts AgentCapReached when the batch exceeds the per-account cap — all-or-nothing', async () => {
      await NFT.setMaxAgentsPerAccount(2);
      const id = await createAccount();
      await expect(
        LogicContract.registerAgents(id, [
          accounts[3].address,
          accounts[4].address,
          accounts[5].address,
        ]),
      ).to.be.revertedWithCustomError(LogicContract, 'AgentCapReached');
      expect(await NFT.getRegisteredAgents(id)).to.deep.equal([]);
    });

    it('reverts AgentAlreadyRegistered on an in-array duplicate — all-or-nothing', async () => {
      const id = await createAccount();
      await expect(
        LogicContract.registerAgents(id, [accounts[3].address, accounts[3].address]),
      ).to.be.revertedWithCustomError(StorageContract, 'AgentAlreadyRegistered');
      expect(await NFT.getRegisteredAgents(id)).to.deep.equal([]);
    });

    it('reverts for a nonexistent account (ownerOf reverts)', async () => {
      await expect(
        LogicContract.registerAgents(999, [accounts[3].address]),
      ).to.be.reverted;
    });
  });

  // ======================================================================
  // I. Governance
  // ======================================================================

  // ======================================================================
  // J. Lazy settlement (passive sink, settle(), post-expiry tail)
  // ======================================================================

  describe('settlement (10.0.8 deterministic schedule)', () => {
    let Kav10Signer: SignerWithAddress;
    let agent: SignerWithAddress;

    beforeEach(async () => {
      Kav10Signer = accounts[5];
      agent = accounts[6];
      await HubContract.setContractAddress('KnowledgeAssetsLifecycle', Kav10Signer.address);
    });

    /**
     * @notice Sum the TRAC accounted by a single tx, from the V10
     *         conviction events (exact per-account trail; getEpochPool
     *         deltas would mix in unrelated fixture diffs).
     *
     * 10.0.8 semantics:
     *   - `EmissionScheduled.scheduled` — base-budget TRAC written to the
     *     pool schedule (fires once per account: at create, or at
     *     migration/first-touch for pre-10.0.8 accounts).
     *   - `CostCovered.drawnFromEpoch` — a BUDGET draw (already-scheduled
     *     money; NOT a pool emission). Reported as `budgetDraw`.
     *   - `CostCovered.drawnFromTopUp` — the only spend-time pool
     *     emission. Reported as `topUpDraw`.
     *   - `AccountFinalSwept.topUpSwept + dustSwept` — post-expiry tail
     *     (`dustSwept` is 0 since 10.0.8; dust is scheduled up front).
     *   - `WindowSettled` never fires (declaration kept for indexers).
     */
    async function sumStakerPoolDistributionFromEvents(
      tx: Awaited<ReturnType<typeof NFT.settle>>,
    ): Promise<{
      scheduled: bigint;
      budgetDraw: bigint;
      topUpDraw: bigint;
      tail: bigint;
      windowSettledCount: number;
    }> {
      const receipt = await tx.wait();
      let scheduled = 0n;
      let budgetDraw = 0n;
      let topUpDraw = 0n;
      let tail = 0n;
      let windowSettledCount = 0;
      const logicAddr = (await LogicContract.getAddress()).toLowerCase();
      for (const log of receipt!.logs) {
        if (log.address.toLowerCase() !== logicAddr) continue;
        let parsed: ReturnType<PublishingConviction['interface']['parseLog']> = null;
        try {
          parsed = LogicContract.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
        } catch {
          continue;
        }
        if (parsed === null) continue;
        if (parsed.name === 'EmissionScheduled') {
          scheduled += BigInt(parsed.args.scheduled);
        } else if (parsed.name === 'WindowSettled') {
          windowSettledCount += 1;
        } else if (parsed.name === 'CostCovered') {
          budgetDraw += BigInt(parsed.args.drawnFromEpoch);
          topUpDraw += BigInt(parsed.args.drawnFromTopUp);
        } else if (parsed.name === 'AccountFinalSwept') {
          tail += BigInt(parsed.args.topUpSwept) + BigInt(parsed.args.dustSwept);
        }
      }
      return { scheduled, budgetDraw, topUpDraw, tail, windowSettledCount };
    }

    it('createAccount schedules the full commitment; settle() is a pure no-op (marker already at lock)', async () => {
      const amount = hre.ethers.parseEther('120000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      const txCreate = await NFT.createAccount(amount, 0);
      const createSums = await sumStakerPoolDistributionFromEvents(txCreate);
      expect(createSums.scheduled).to.equal(amount);
      expect(createSums.windowSettledCount).to.equal(0);

      const tx = await NFT.settle(1);
      const sums = await sumStakerPoolDistributionFromEvents(tx);
      expect(sums.scheduled).to.equal(0n);
      expect(sums.tail).to.equal(0n);
      expect(sums.windowSettledCount).to.equal(0);

      const info = await NFT.getAccountInfo(1);
      expect(info.lastSettledWindow).to.equal(BigInt(LOCK_DURATION));
      expect(info.fullySwept).to.equal(false);
    });

    it('settle() after N elapsed windows stays a no-op — the windows were scheduled at creation, nothing sweeps', async () => {
      const committed = hre.ethers.parseEther('120000');
      await TokenContract.approve(await NFT.getAddress(), committed);
      const txCreate = await NFT.createAccount(committed, 0);
      expect((await sumStakerPoolDistributionFromEvents(txCreate)).scheduled).to.equal(committed);

      const epochLength = await ChronosContract.epochLength();
      const N = 3n;
      await time.increase(epochLength * N + 1n);
      const tx = await NFT.settle(1);
      const sums = await sumStakerPoolDistributionFromEvents(tx);

      // Nothing left to schedule or sweep — elapsed time changes nothing.
      expect(sums.scheduled).to.equal(0n);
      expect(sums.tail).to.equal(0n);
      expect(sums.windowSettledCount).to.equal(0);

      const after = await NFT.getAccountInfo(1);
      expect(after.lastSettledWindow).to.equal(BigInt(LOCK_DURATION));
      expect(after.fullySwept).to.equal(false);
    });

    it('mixed publish + settle: the publish draws budget only, and no window is ever swept', async () => {
      const committed = hre.ethers.parseEther('120000');
      const baseAllowance = committed / 12n;
      const discountBps = 3000n;
      await TokenContract.approve(await NFT.getAddress(), committed);
      const txCreate = await NFT.createAccount(committed, 0);
      expect((await sumStakerPoolDistributionFromEvents(txCreate)).scheduled).to.equal(committed);
      await NFT.registerAgent(1, agent.address);

      const epochLength = await ChronosContract.epochLength();
      const startChainEpoch = await ChronosContract.getCurrentEpoch();

      // Publish in window 0: half-spend the base allowance.
      const halfDisc = baseAllowance / 2n;
      const baseCost = (halfDisc * BPS) / (BPS - discountBps);
      const actualDisc = (baseCost * (BPS - discountBps)) / BPS;

      const txPublish = await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost,
        startChainEpoch,
        LOCK_DURATION,
      );
      const publishSums = await sumStakerPoolDistributionFromEvents(txPublish);
      // Budget draw of the discounted cost; NO pool emission of any kind
      // (the base commitment is already fully scheduled).
      expect(publishSums.budgetDraw).to.equal(actualDisc);
      expect(publishSums.topUpDraw).to.equal(0n);
      expect(publishSums.scheduled).to.equal(0n);
      expect(publishSums.windowSettledCount).to.equal(0);

      // Advance one full window; settle stays a no-op — the "remainder"
      // concept is gone (it was scheduled at creation).
      await time.increase(epochLength + 1n);
      const txSettle = await NFT.settle(1);
      const settleSums = await sumStakerPoolDistributionFromEvents(txSettle);
      expect(settleSums.scheduled).to.equal(0n);
      expect(settleSums.windowSettledCount).to.equal(0);

      // Idempotency: again a no-op.
      const txSettle2 = await NFT.settle(1);
      const sums2 = await sumStakerPoolDistributionFromEvents(txSettle2);
      expect(sums2.scheduled + sums2.tail).to.equal(0n);
    });

    it('post-expiry settle() sweeps ONLY the topUp buffer (base + dust were scheduled at creation); sets fullySwept', async () => {
      // Committed amount NOT divisible by 12: the dust is part of the
      // creation-time schedule (last window), NOT the final sweep.
      const committed = hre.ethers.parseEther('120000') + 5n;
      const baseAllowance = committed / 12n;
      const dust = committed - baseAllowance * 12n;
      const top = hre.ethers.parseEther('30000');

      await TokenContract.approve(await NFT.getAddress(), committed + top);
      const txCreate = await NFT.createAccount(committed, 0);
      // Full commitment INCLUDING dust scheduled up front.
      expect((await sumStakerPoolDistributionFromEvents(txCreate)).scheduled).to.equal(committed);
      await NFT.topUp(1, top);

      const epochLength = await ChronosContract.epochLength();
      await time.increase(epochLength * BigInt(LOCK_DURATION + 1));

      const tx = await NFT.settle(1);
      const sums = await sumStakerPoolDistributionFromEvents(tx);

      // Post-expiry tail = topUp ONLY (dustSwept is 0 since 10.0.8).
      expect(sums.tail).to.equal(top);
      expect(sums.scheduled).to.equal(0n);
      expect(sums.windowSettledCount).to.equal(0);
      // Conservation across the lifetime: scheduled-at-create (committed,
      // dust included) + tail (topUp) == committed + top.

      const after = await NFT.getAccountInfo(1);
      expect(after.fullySwept).to.equal(true);
      expect(after.lastSettledWindow).to.equal(LOCK_DURATION);
      expect(after.topUpBuffer).to.equal(0n);
      expect(dust).to.be.gt(0n);
    });

    it('post-expiry settle() is idempotent — second call is a no-op (fullySwept guard)', async () => {
      const committed = hre.ethers.parseEther('120000');
      await TokenContract.approve(await NFT.getAddress(), committed);
      await NFT.createAccount(committed, 0);
      const epochLength = await ChronosContract.epochLength();
      await time.increase(epochLength * BigInt(LOCK_DURATION + 1));
      await NFT.settle(1);

      const tx2 = await NFT.settle(1);
      const sums2 = await sumStakerPoolDistributionFromEvents(tx2);
      expect(sums2.scheduled + sums2.tail).to.equal(0n);
    });

    it('NFT transfer pre-expiry is an accounting no-op (schedule already written; agents preserved)', async () => {
      const committed = hre.ethers.parseEther('120000');
      await TokenContract.approve(await NFT.getAddress(), committed);
      const txCreate = await NFT.createAccount(committed, 0);
      expect((await sumStakerPoolDistributionFromEvents(txCreate)).scheduled).to.equal(committed);

      const epochLength = await ChronosContract.epochLength();
      const N = 2n;
      await time.increase(epochLength * N + 1n);
      const tx = await NFT.transferFrom(accounts[0].address, accounts[7].address, 1);
      const sums = await sumStakerPoolDistributionFromEvents(tx);

      // Nothing to settle at transfer time — the schedule was written at
      // creation and the account is pre-expiry.
      expect(sums.scheduled).to.equal(0n);
      expect(sums.tail).to.equal(0n);
      expect(sums.windowSettledCount).to.equal(0);

      const after = await NFT.getAccountInfo(1);
      expect(after.lastSettledWindow).to.equal(BigInt(LOCK_DURATION));
      expect(after.fullySwept).to.equal(false);
    });

    it('NFT transfer post-expiry triggers the final sweep (topUp tail only; fullySwept=true) on the outgoing owner', async () => {
      const committed = hre.ethers.parseEther('120000');
      const top = hre.ethers.parseEther('10000');
      await TokenContract.approve(await NFT.getAddress(), committed + top);
      const txCreate = await NFT.createAccount(committed, 0);
      expect((await sumStakerPoolDistributionFromEvents(txCreate)).scheduled).to.equal(committed);
      await NFT.topUp(1, top);

      const epochLength = await ChronosContract.epochLength();
      await time.increase(epochLength * BigInt(LOCK_DURATION + 1));
      const tx = await NFT.transferFrom(accounts[0].address, accounts[7].address, 1);
      const sums = await sumStakerPoolDistributionFromEvents(tx);

      // Base was scheduled at creation; the transfer-time final sweep
      // accounts only the topUp tail.
      expect(sums.tail).to.equal(top);
      expect(sums.scheduled).to.equal(0n);

      const after = await NFT.getAccountInfo(1);
      expect(after.fullySwept).to.equal(true);
      expect(after.topUpBuffer).to.equal(0n);
    });
  });

  describe('governance', () => {
    it('hub owner can set maxAgentsPerAccount', async () => {
      await NFT.setMaxAgentsPerAccount(200);
      expect(await NFT.maxAgentsPerAccount()).to.equal(200n);
    });

    it('non-hub-owner cannot set maxAgentsPerAccount', async () => {
      // `onlyHubOwner` modifier → `HubLib.UnauthorizedAccess("Only Hub Owner")`.
      // Pin both error + arg so regressions that open this governance
      // setter to any caller (or swap to a different ACL primitive) fail.
      await expect(NFT.connect(accounts[5]).setMaxAgentsPerAccount(200))
        .to.be.revertedWithCustomError(NFT, 'UnauthorizedAccess')
        .withArgs('Only Hub Owner');
    });

    it('defaults to 100', async () => {
      expect(await NFT.maxAgentsPerAccount()).to.equal(100n);
    });
  });

  // PR #650 / Codex round-3 review: regressions that pin the post-split
  // public surface invariants of the V10 publisher-conviction wrapper.
  // Both items here were behavior-compat issues raised in the review of
  // the storage / logic / wrapper split — keep them explicit so any
  // future refactor that re-introduces them fails loudly.
  describe('PR #650 regressions: post-split wrapper invariants', () => {
    it("accounts(unknownId) returns the legacy zero tuple — does NOT revert (v2.x ABI compat)", async () => {
      // The legacy v2.x `accounts` public mapping returned the all-zero
      // Account record for an unknown id. After the split, the wrapper's
      // `accounts(uint256)` is an explicit forwarder; an early Codex
      // review caught it routing through `getAccount(...)` instead, which
      // reverts `UnknownAccount`. That is an observable behavior break
      // for indexers and existence probes that read the legacy mapping.
      //
      // The wrapper now forwards to the storage contract's auto-generated
      // `accounts(uint256)` mapping getter so the unknown-id branch keeps
      // its zero-tuple semantic. This test pins that contract.
      const unknownId = 99999n;
      const tup = await NFT.accounts(unknownId);
      // `Account` struct field order, projected through the auto-getter:
      //   committedTRAC, createdAtEpoch, expiresAtEpoch,
      //   createdAtTimestamp, expiresAtTimestamp, lockDurationEpochs,
      //   discountBps, lastSettledWindow, fullySwept
      expect(tup[0]).to.equal(0n); // committedTRAC
      expect(tup[1]).to.equal(0n); // createdAtEpoch
      expect(tup[2]).to.equal(0n); // expiresAtEpoch
      expect(tup[3]).to.equal(0n); // createdAtTimestamp
      expect(tup[4]).to.equal(0n); // expiresAtTimestamp
      expect(tup[5]).to.equal(0n); // lockDurationEpochs
      expect(tup[6]).to.equal(0n); // discountBps
      expect(tup[7]).to.equal(0n); // lastSettledWindow
      expect(tup[8]).to.equal(false); // fullySwept
    });

    it("getAccount(unknownId) DOES revert UnknownAccount — fail-closed variant is still available", async () => {
      // Symmetric pin: callers that intentionally want fail-closed
      // semantics (e.g. internal helpers that should not silently
      // operate on a zero account) still have `getAccount` to call.
      const unknownId = 99999n;
      await expect(StorageContract.getAccount(unknownId))
        .to.be.revertedWithCustomError(StorageContract, 'UnknownAccount')
        .withArgs(unknownId);
    });

    it("accounts(knownId) returns the same tuple as getAccount(knownId) for an existing account", async () => {
      // Sanity check that the auto-getter forwarder is wire-compatible
      // with `getAccount` for the ordinary in-range case — only the
      // unknown-id branch differs.
      const amount = hre.ethers.parseEther('100000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount, 0);

      const tup = await NFT.accounts(1);
      const struct = await StorageContract.getAccount(1);

      expect(tup[0]).to.equal(struct.committedTRAC);
      expect(tup[1]).to.equal(struct.createdAtEpoch);
      expect(tup[2]).to.equal(struct.expiresAtEpoch);
      expect(tup[3]).to.equal(struct.createdAtTimestamp);
      expect(tup[4]).to.equal(struct.expiresAtTimestamp);
      expect(tup[5]).to.equal(struct.lockDurationEpochs);
      expect(tup[6]).to.equal(struct.discountBps);
      expect(tup[7]).to.equal(struct.lastSettledWindow);
      expect(tup[8]).to.equal(struct.fullySwept);
    });

    it('PCA state-change events fire from PublishingConviction (logic), NOT from the NFT wrapper', async () => {
      // Deliberate v2.x → v3.0.0 break for PR #650. The combined v2.x
      // `DKGPublishingConvictionNFT` emitted PCA business events
      // (AccountCreated, ToppedUp, CostCovered, AccountFinalSwept,
      // AgentRegistered/Deregistered, WindowSettled) from the wrapper
      // address. Post-split, those events live on the logic contract
      // — the wrapper's ABI does not declare them. Off-chain consumers
      // MUST listen on `PublishingConviction` (resolved via Hub).
      //
      // This test pins the architectural invariant: every PCA event
      // log raised during a `createAccount` + `topUp` flow is emitted
      // by the logic contract, never by the wrapper. ERC-721 events
      // (Transfer/Approval) are still emitted by the wrapper — those
      // are not part of the PCA state-change set and are not moved.
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount * 2n);

      const logicAddr = (LogicContract.target as string).toLowerCase();
      const wrapperAddr = (NFT.target as string).toLowerCase();
      const logicAbi = LogicContract.interface;
      const pcaEventNames = [
        'AccountCreated',
        'ToppedUp',
        'CostCovered',
        'WindowSettled',
        'AccountFinalSwept',
        'AgentRegistered',
        'AgentDeregistered',
      ];

      // Helper that walks a tx receipt and asserts every parseable PCA
      // event log was emitted by the logic contract — and never by the
      // wrapper. ERC-721 events from the wrapper and ERC-20 Transfer
      // events from the token won't parse against the logic ABI and
      // are correctly skipped.
      const assertPcaEventsFromLogic = (
        receipt: { logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }> },
        expectedEventNames: ReadonlyArray<string>,
      ) => {
        const seen = new Set<string>();
        for (const log of receipt.logs) {
          try {
            const parsed = logicAbi.parseLog({
              topics: [...log.topics],
              data: log.data,
            });
            if (parsed && pcaEventNames.includes(parsed.name)) {
              expect(
                log.address.toLowerCase(),
                `${parsed.name} must be emitted by the logic contract, not the wrapper`,
              ).to.equal(logicAddr);
              expect(
                log.address.toLowerCase(),
                `${parsed.name} must NOT be emitted by the NFT wrapper`,
              ).to.not.equal(wrapperAddr);
              seen.add(parsed.name);
            }
          } catch {
            // Not a logic-contract event — skip.
          }
        }
        for (const expected of expectedEventNames) {
          expect(
            seen.has(expected),
            `expected ${expected} to fire from the logic contract`,
          ).to.equal(true);
        }
      };

      // 1) createAccount → AccountCreated must come from logic.
      const createTx = await NFT.createAccount(amount, 0);
      const createReceipt = await createTx.wait();
      assertPcaEventsFromLogic(createReceipt!, ['AccountCreated']);

      // 2) topUp → ToppedUp must come from logic.
      const topUpTx = await NFT.topUp(1, amount);
      const topUpReceipt = await topUpTx.wait();
      assertPcaEventsFromLogic(topUpReceipt!, ['ToppedUp']);

      // 3) Architectural negative pin: the wrapper's ABI MUST NOT
      //    declare PCA events. If anyone re-introduces a re-emission
      //    shim on the wrapper to "preserve compatibility", this
      //    assertion fails at the type-system level.
      const wrapperEventNames = NFT.interface.fragments
        .filter((f) => f.type === 'event')
        .map((f) => (f as { name: string }).name);
      for (const name of pcaEventNames) {
        expect(
          wrapperEventNames,
          `wrapper ABI must not declare PCA event ${name} (architectural invariant)`,
        ).to.not.include(name);
      }
    });
  });
});
