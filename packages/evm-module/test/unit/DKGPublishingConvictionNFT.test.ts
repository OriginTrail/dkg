import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  EpochStorage,
  Hub,
  StakingStorage,
  Token,
} from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGPublishingConvictionNFT;
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
  let TokenContract: Token;
  let StakingStorageContract: StakingStorage;
  let ConvictionStakingStorageContract: ConvictionStakingStorage;
  let EpochStorageContract: EpochStorage;
  let ChronosContract: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
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
      await NFT.createAccount(amount);

      expect(await TokenContract.balanceOf(nftAddr)).to.equal(0n);
      expect(await TokenContract.balanceOf(accounts[0].address)).to.equal(userBefore - amount);
      expect(await TokenContract.balanceOf(cssAddr)).to.equal(cssBefore + amount);
      // V8 StakingStorage TRAC balance is untouched on V10 deposits.
      expect(await TokenContract.balanceOf(ssAddr)).to.equal(ssBefore);
    });

    it('mints NFT and records account struct with fixed tier and 12-epoch expiry', async () => {
      const amount = hre.ethers.parseEther('1000000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);

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
      await expect(NFT.createAccount(amount)).to.emit(NFT, 'AccountCreated');
      const info = await NFT.getAccountInfo(1);
      expect(info.createdAtEpoch).to.equal(currentEpoch);
      expect(info.expiresAtEpoch - info.createdAtEpoch).to.be.gte(BigInt(LOCK_DURATION));
    });

    it('reverts with InvalidAmount on zero', async () => {
      await expect(NFT.createAccount(0)).to.be.revertedWithCustomError(NFT, 'InvalidAmount');
    });

    it('assigns incrementing IDs', async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount * 2n);
      await NFT.createAccount(amount);
      await NFT.createAccount(amount);
      expect(await NFT.totalSupply()).to.equal(2n);
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.ownerOf(2)).to.equal(accounts[0].address);
    });
  });

  // ======================================================================
  // C. createAccount escrow-only model (lazy-settlement)
  // ======================================================================

  describe('createAccount: lazy-settlement escrow-only model', () => {
    it('writes ZERO EpochStorage pool deltas upfront — only the CSS escrow balance moves', async () => {
      // V10 lazy-settlement model: committed TRAC stays in escrow at
      // createAccount time. The staker pool is funded lazily — via
      // `coverPublishingCost` (active sink) and `settle()` (passive sink).
      const amount = hre.ethers.parseEther('1200000');
      const current = await ChronosContract.getCurrentEpoch();

      const before: bigint[] = [];
      for (let i = 0; i < MAX_CHAIN_EPOCHS_TOUCHED + 2; i++) {
        before.push(await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i)));
      }
      const remainderBefore = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);
      const cssAddr = await ConvictionStakingStorageContract.getAddress();
      const cssBefore = await TokenContract.balanceOf(cssAddr);

      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);

      // Pool deltas: ZERO across the entire account lifetime + a couple
      // safety epochs past it.
      for (let i = 0; i < MAX_CHAIN_EPOCHS_TOUCHED + 2; i++) {
        const after = await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i));
        expect(after - before[i]).to.equal(0n);
      }
      // Accumulated remainder: also untouched. createAccount must never
      // call addTokensToEpochRange.
      const remainderAfter = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);
      expect(remainderAfter - remainderBefore).to.equal(0n);

      // Escrow balance: full committedTRAC moved into CSS vault.
      expect(await TokenContract.balanceOf(cssAddr)).to.equal(cssBefore + amount);

      // Account is created with the lazy-settlement cursor zeroed.
      const info = await NFT.getAccountInfo(1);
      expect(info.lastSettledWindow).to.equal(0n);
      expect(info.fullySwept).to.equal(false);
    });

    it('also writes ZERO pool deltas when committedTRAC % 12 != 0 (dust is held in escrow until final settle)', async () => {
      // 25_013 ether: lowest tier (>=25K) plus 13 wei tail. Pre-lazy this
      // tail would have ended up in EpochStorage's accumulatedRemainder
      // shard; in the lazy model, it stays in CSS escrow until
      // `settle()` is called post-expiry.
      const amount = hre.ethers.parseEther('25000') + 13n;
      const current = await ChronosContract.getCurrentEpoch();

      const remainderBefore = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);
      const epochBefore: bigint[] = [];
      for (let i = 0; i < MAX_CHAIN_EPOCHS_TOUCHED; i++) {
        epochBefore.push(
          await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i)),
        );
      }

      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);

      // No epoch pool deltas anywhere.
      for (let i = 0; i < MAX_CHAIN_EPOCHS_TOUCHED; i++) {
        const after = await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i));
        expect(after - epochBefore[i]).to.equal(0n);
      }
      // No accumulator drift either — the contract NEVER calls
      // addTokensToEpochRange at createAccount time, so the per-shard
      // floor-division residual cannot change.
      const remainderAfter = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);
      expect(remainderAfter - remainderBefore).to.equal(0n);
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
      await HubContract.setContractAddress('KnowledgeAssetsV10', Kav10Signer.address);

      // committedTRAC divisible by 12 → clean per-epoch allowance math.
      const committed = hre.ethers.parseEther('120000');
      const baseAllowance = committed / 12n;
      const discountBps = 3000n;
      await TokenContract.approve(await NFT.getAddress(), committed);
      await NFT.createAccount(committed);

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
      ).to.be.revertedWithCustomError(NFT, 'InsufficientAllowance');

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

  describe('N23 regression: createAccount reverts if EpochStorage address not set at init', () => {
    // Each of these negative-init tests needs a clean Hub with only a SUBSET
    // of the NFT contract's dependencies registered, so that `initialize()`
    // hits a specific `ZeroAddressDependency(...)` branch. The original
    // implementation used `hre.deployments.fixture([...])` per-test, which
    // invokes `hardhat_reset` under the hood and invalidates the
    // hardhat-network-helpers snapshot manager that every other suite relies
    // on — the tests passed in isolation but broke the rest of the suite
    // when run together.
    //
    // Fix: never reset the network. Instead, deploy a DISPOSABLE `Hub` via
    // the contract factory for each test and register only the dependencies
    // under test. The shared fixture snapshots stay valid because we never
    // touch `hre.deployments.fixture` or mutate the shared Hub.
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
      // Register the NFT in the fresh Hub so `onlyHub` accepts the initialize call.
      await freshHub.setContractAddress('DKGPublishingConvictionNFT', await nft.getAddress());
      return nft;
    }

    // NOTE: Hub.setContractAddress rejects address(0), and
    // hub.getContractAddress reverts with `ContractDoesNotExist(name)` when a
    // name is unregistered. That means `initialize` never actually sees a
    // zero address via Hub — the lookup reverts first. These tests originally
    // asserted a bare revert; we now pin `ContractDoesNotExist(name)` which
    // is the TRUE runtime revert bubbling through Hub.forwardCall. If the
    // Hub ever starts returning address(0) (regression), `ZeroAddressDependency`
    // would fire instead; tests would still fail, surfacing the behavior change.
    // v4.0.0 — DKGPublishingConvictionNFT.initialize() now resolves
    // Token → ConvictionStakingStorage → EpochStorageV8 → Chronos in that
    // order. The four "missing dependency" tests below pin the bubbled-up
    // ContractDoesNotExist(name) for each missing branch in resolution order.
    it('initialize reverts when ConvictionStakingStorage is address(0)', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17, signer18, signer19] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('Token', signer17.address);
      await freshHub.setContractAddress('EpochStorageV8', signer18.address);
      await freshHub.setContractAddress('Chronos', signer19.address);

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

    it('initialize reverts when EpochStorageV8 is address(0)', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17, signer18, signer19] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('Token', signer17.address);
      await freshHub.setContractAddress('ConvictionStakingStorage', signer18.address);
      await freshHub.setContractAddress('Chronos', signer19.address);

      const nft = await deployUnregisteredNFT(freshHub);
      await expect(
        freshHub.forwardCall(
          await nft.getAddress(),
          nft.interface.encodeFunctionData('initialize'),
        ),
      )
        .to.be.revertedWithCustomError(freshHub, 'ContractDoesNotExist')
        .withArgs('EpochStorageV8');
    });

    it('initialize reverts when Chronos is address(0)', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17, signer18, signer19] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('Token', signer17.address);
      await freshHub.setContractAddress('ConvictionStakingStorage', signer18.address);
      await freshHub.setContractAddress('EpochStorageV8', signer19.address);

      const nft = await deployUnregisteredNFT(freshHub);
      await expect(
        freshHub.forwardCall(
          await nft.getAddress(),
          nft.interface.encodeFunctionData('initialize'),
        ),
      )
        .to.be.revertedWithCustomError(freshHub, 'ContractDoesNotExist')
        .withArgs('Chronos');
    });

    it('initialize reverts when Token is address(0)', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17, signer18, signer19] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('ConvictionStakingStorage', signer17.address);
      await freshHub.setContractAddress('EpochStorageV8', signer18.address);
      await freshHub.setContractAddress('Chronos', signer19.address);

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
  });

  // ======================================================================
  // D. topUp (G3)
  // ======================================================================

  describe('topUp', () => {
    async function createAt(amount: bigint) {
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);
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
      await expect(NFT.topUp(1, top1)).to.emit(NFT, 'ToppedUp').withArgs(1, top1, top1);
      await expect(NFT.topUp(1, top2)).to.emit(NFT, 'ToppedUp').withArgs(1, top2, top1 + top2);
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
      await HubContract.setContractAddress('KnowledgeAssetsV10', Kav10Signer.address);
    });

    async function createAt(amount: bigint) {
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);
    }

    async function createAtWithAgent(amount: bigint, agentAddr: string) {
      await createAt(amount);
      // Account id is totalSupply (just minted). Register agent on it.
      const newId = await NFT.totalSupply();
      await NFT.registerAgent(newId, agentAddr);
      return newId;
    }

    it('returns the discounted cost, deducts from epoch allowance, and funds the KC epoch range (active sink)', async () => {
      const committed = hre.ethers.parseEther('1200000');
      await createAtWithAgent(committed, agent.address);

      const baseCost = hre.ethers.parseEther('10000');
      const expectedDiscount = (baseCost * (BPS - 7500n)) / BPS; // 2500 TRAC
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      const kcEpochs = 3n;

      const returned = await NFT.connect(Kav10Signer).coverPublishingCost.staticCall(
        agent.address,
        baseCost,
        currentEpoch,
        kcEpochs,
      );
      expect(returned).to.equal(expectedDiscount);

      // Pin the active-sink distribution via the sum of
      // `TokensAddedToEpochRange` events emitted by `EpochStorage`. The
      // distribution now mirrors `KnowledgeAssetsV10._distributeTokens`:
      // the discountedCost is prorated across `kcEpochs + 1` chain epochs
      // (partial current + (kcEpochs - 1) full middle + partial final),
      // so we get up to 3 separate events. The TOTAL summed across all
      // emissions must equal `expectedDiscount`, and every event must
      // sit within `[currentEpoch, currentEpoch + kcEpochs]` for shard
      // STAKER_SHARD_ID. Event-based assertion (rather than per-epoch
      // pool deltas) because V8 staker-shard `cumulative[...]` storage
      // is shared with pre-existing unfinalized diffs from the deploy
      // fixture, polluting per-epoch delta math.
      const tx = await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost,
        currentEpoch,
        kcEpochs,
      );
      const receipt = await tx.wait();
      const epsAddr = (await EpochStorageContract.getAddress()).toLowerCase();
      const iface = EpochStorageContract.interface;
      let totalDistributed = 0n;
      let eventCount = 0;
      for (const log of receipt!.logs) {
        if (log.address.toLowerCase() !== epsAddr) continue;
        let parsed;
        try { parsed = iface.parseLog({ topics: log.topics as string[], data: log.data }); }
        catch { continue; }
        if (parsed?.name !== 'TokensAddedToEpochRange') continue;
        eventCount++;
        expect(parsed.args.shardId).to.equal(STAKER_SHARD_ID);
        expect(parsed.args.startEpoch).to.be.gte(currentEpoch);
        expect(parsed.args.endEpoch).to.be.lte(currentEpoch + kcEpochs);
        totalDistributed += BigInt(parsed.args.tokenAmount);
      }
      expect(eventCount).to.be.greaterThan(0);
      expect(totalDistributed).to.equal(expectedDiscount);

      const info = await NFT.getAccountInfo(1);
      const epochLength = await ChronosContract.epochLength();
      const currentWindow = await currentBillingWindow(info.createdAtTimestamp, epochLength);
      expect(await NFT.windowSpent(1, currentWindow)).to.equal(expectedDiscount);
      expect((await NFT.getAccountInfo(1)).topUpBuffer).to.equal(0n);
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
      const kcStart = await ChronosContract.getCurrentEpoch();

      await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost,
        kcStart,
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
      const kcStart = await ChronosContract.getCurrentEpoch();
      await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCost1,
        kcStart,
        LOCK_DURATION,
      );
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('100'),
          kcStart,
          LOCK_DURATION,
        ),
      ).to.be.revertedWithCustomError(NFT, 'InsufficientAllowance');
    });

    it('reverts NoConvictionAccount for an unregistered agent', async () => {
      const kcStart = await ChronosContract.getCurrentEpoch();
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(accounts[9].address, 1n, kcStart, 1n),
      )
        .to.be.revertedWithCustomError(NFT, 'NoConvictionAccount')
        .withArgs(accounts[9].address);
    });

    it('reverts InvalidConvictionKcEpochs when kcEpochs is 0 or exceeds lockDurationEpochs', async () => {
      const committed = hre.ethers.parseEther('60000');
      await createAtWithAgent(committed, agent.address);
      const kcStart = await ChronosContract.getCurrentEpoch();

      // kcEpochs == 0 → reject.
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('1'),
          kcStart,
          0n,
        ),
      )
        .to.be.revertedWithCustomError(NFT, 'InvalidConvictionKcEpochs')
        .withArgs(LOCK_DURATION, 0n);

      // kcEpochs == LOCK_DURATION + 1 → reject (above ceiling).
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('1'),
          kcStart,
          LOCK_DURATION + 1,
        ),
      )
        .to.be.revertedWithCustomError(NFT, 'InvalidConvictionKcEpochs')
        .withArgs(LOCK_DURATION, LOCK_DURATION + 1);

      // kcEpochs == LOCK_DURATION → accepted (boundary).
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('1'),
          kcStart,
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
      await NFT.connect(accounts[1]).createAccount(committedB);
      await NFT.connect(accounts[1]).registerAgent(2, agentB.address);

      const infoA = await NFT.getAccountInfo(1);
      const infoB = await NFT.getAccountInfo(2);
      const epochLength = await ChronosContract.epochLength();
      const windowA = await currentBillingWindow(infoA.createdAtTimestamp, epochLength);
      const windowB = await currentBillingWindow(infoB.createdAtTimestamp, epochLength);

      expect(await NFT.windowSpent(1, windowA)).to.equal(0n);
      expect(await NFT.windowSpent(2, windowB)).to.equal(0n);

      const kcStart = await ChronosContract.getCurrentEpoch();
      const baseCostA = hre.ethers.parseEther('1000');
      const discountedA = (baseCostA * (BPS - 3000n)) / BPS; // 700
      await NFT.connect(Kav10Signer).coverPublishingCost(
        agent.address,
        baseCostA,
        kcStart,
        LOCK_DURATION,
      );
      expect(await NFT.windowSpent(1, windowA)).to.equal(discountedA);
      expect(await NFT.windowSpent(2, windowB)).to.equal(0n);

      const baseCostB = hre.ethers.parseEther('500');
      const discountedB = (baseCostB * (BPS - 2000n)) / BPS; // 400
      await NFT.connect(Kav10Signer).coverPublishingCost(
        agentB.address,
        baseCostB,
        kcStart,
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

      const kcStart = await ChronosContract.getCurrentEpoch();
      await expect(
        NFT.connect(Attacker).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('100'),
          kcStart,
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
      const kcStart = await ChronosContract.getCurrentEpoch();
      await expect(
        NFT.connect(eoa).coverPublishingCost(
          agent.address,
          hre.ethers.parseEther('100'),
          kcStart,
          LOCK_DURATION,
        ),
      )
        .to.be.revertedWithCustomError(NFT, 'OnlyKnowledgeAssetsV10')
        .withArgs(eoa.address);
    });

    it('ABI has exactly 4 parameters: (publishingAgent, baseCost, kcStartEpoch, kcEpochs)', async () => {
      const fn = NFT.interface.getFunction('coverPublishingCost');
      expect(fn).to.not.equal(null);
      expect(fn!.inputs.length).to.equal(4);
      expect(fn!.inputs[0].name).to.equal('publishingAgent');
      expect(fn!.inputs[0].type).to.equal('address');
      expect(fn!.inputs[1].name).to.equal('baseCost');
      expect(fn!.inputs[2].name).to.equal('kcStartEpoch');
      expect(fn!.inputs[3].name).to.equal('kcEpochs');
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
      await NFT.createAccount(amount);
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
        .to.emit(NFT, 'AgentRegistered')
        .withArgs(1, agent);
      await expect(NFT.deregisterAgent(1, agent))
        .to.emit(NFT, 'AgentDeregistered')
        .withArgs(1, agent);
    });

    it('enforces one-account-per-agent', async () => {
      const agent = accounts[3].address;
      await NFT.registerAgent(1, agent);
      const amount2 = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount2);
      await NFT.createAccount(amount2);
      await expect(NFT.registerAgent(2, agent)).to.be.revertedWithCustomError(
        NFT,
        'AgentAlreadyRegistered',
      );
    });

    it('enforces agent cap', async () => {
      await NFT.setMaxAgentsPerAccount(2);
      await NFT.registerAgent(1, accounts[3].address);
      await NFT.registerAgent(1, accounts[4].address);
      await expect(
        NFT.registerAgent(1, accounts[5].address),
      ).to.be.revertedWithCustomError(NFT, 'AgentCapReached');
    });

    it('only owner can register agents', async () => {
      await expect(
        NFT.connect(accounts[5]).registerAgent(1, accounts[3].address),
      ).to.be.revertedWithCustomError(NFT, 'NotAccountOwner');
    });
  });

  // ======================================================================
  // H. ERC-721 behavior (agent clearing on transfer)
  // ======================================================================

  describe('ERC-721 transferability', () => {
    it('clears agent registrations on transfer', async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);
      const agent = accounts[3].address;
      await NFT.registerAgent(1, agent);

      await NFT.transferFrom(accounts[0].address, accounts[7].address, 1);

      expect(await NFT.getRegisteredAgents(1)).to.deep.equal([]);
      expect(await NFT.agentToAccountId(agent)).to.equal(0n);
    });

    it('new owner can register fresh agents after transfer', async () => {
      const amount = hre.ethers.parseEther('60000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);
      await NFT.registerAgent(1, accounts[3].address);
      await NFT.transferFrom(accounts[0].address, accounts[7].address, 1);
      await NFT.connect(accounts[7]).registerAgent(1, accounts[8].address);
      expect(await NFT.getRegisteredAgents(1)).to.deep.equal([accounts[8].address]);
    });
  });

  // ======================================================================
  // I. Governance
  // ======================================================================

  // ======================================================================
  // J. Lazy settlement (passive sink, settle(), post-expiry tail)
  // ======================================================================

  describe('lazy settlement', () => {
    let Kav10Signer: SignerWithAddress;
    let agent: SignerWithAddress;

    beforeEach(async () => {
      Kav10Signer = accounts[5];
      agent = accounts[6];
      await HubContract.setContractAddress('KnowledgeAssetsV10', Kav10Signer.address);
    });

    /**
     * @notice Sum the TRAC accounted to the staker pool by a single tx.
     *
     * We parse the NFT contract's emitted accounting events instead of
     * relying on `EpochStorage.getEpochPool` deltas: the underlying
     * cumulative storage is shared with V8 stake-related diffs from the
     * deployment fixtures, and the public `getEpochPool` getter walks
     * unfinalized diffs from `lastFinalizedEpoch + 1`, which mixes
     * unrelated noise into per-test deltas. The NFT's own events are the
     * exact, unambiguous trail of what THIS account flushed into the
     * staker pool.
     *
     * Returns: passive-sink (`WindowSettled.remainderSwept`) + active-sink
     * (`CostCovered.drawnFromEpoch + drawnFromTopUp`) + post-expiry tail
     * (`AccountFinalSwept.topUpSwept + dustSwept`).
     */
    async function sumStakerPoolDistributionFromEvents(
      tx: Awaited<ReturnType<typeof NFT.settle>>,
    ): Promise<{
      passive: bigint;
      active: bigint;
      tail: bigint;
      total: bigint;
    }> {
      const receipt = await tx.wait();
      let passive = 0n;
      let active = 0n;
      let tail = 0n;
      const nftAddr = (await NFT.getAddress()).toLowerCase();
      for (const log of receipt!.logs) {
        if (log.address.toLowerCase() !== nftAddr) continue;
        let parsed: ReturnType<DKGPublishingConvictionNFT['interface']['parseLog']> = null;
        try {
          parsed = NFT.interface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          continue;
        }
        if (parsed === null) continue;
        if (parsed.name === 'WindowSettled') {
          passive += BigInt(parsed.args.remainderSwept);
        } else if (parsed.name === 'CostCovered') {
          active += BigInt(parsed.args.drawnFromEpoch) + BigInt(parsed.args.drawnFromTopUp);
        } else if (parsed.name === 'AccountFinalSwept') {
          tail += BigInt(parsed.args.topUpSwept) + BigInt(parsed.args.dustSwept);
        }
      }
      return { passive, active, tail, total: passive + active + tail };
    }

    it('settle() with no elapsed windows is a no-op (does not advance cursor)', async () => {
      const amount = hre.ethers.parseEther('120000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);

      const tx = await NFT.settle(1);
      const sums = await sumStakerPoolDistributionFromEvents(tx);
      expect(sums.total).to.equal(0n);

      const info = await NFT.getAccountInfo(1);
      expect(info.lastSettledWindow).to.equal(0n);
      expect(info.fullySwept).to.equal(false);
    });

    it('settle() after N elapsed windows (no publishes) sweeps N * B to the staker pool', async () => {
      const committed = hre.ethers.parseEther('120000');
      const baseAllowance = committed / 12n;
      await TokenContract.approve(await NFT.getAddress(), committed);
      await NFT.createAccount(committed);

      const epochLength = await ChronosContract.epochLength();
      const N = 3n;
      await time.increase(epochLength * N + 1n);
      const tx = await NFT.settle(1);
      const sums = await sumStakerPoolDistributionFromEvents(tx);

      expect(sums.passive).to.equal(N * baseAllowance);
      expect(sums.active).to.equal(0n);
      expect(sums.tail).to.equal(0n);

      const after = await NFT.getAccountInfo(1);
      expect(after.lastSettledWindow).to.be.gte(N);
      expect(after.fullySwept).to.equal(false);
    });

    it('mixed publish + settle: per-window remainder is swept exactly once', async () => {
      const committed = hre.ethers.parseEther('120000');
      const baseAllowance = committed / 12n;
      const discountBps = 3000n;
      await TokenContract.approve(await NFT.getAddress(), committed);
      await NFT.createAccount(committed);
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
      // Active sink: discounted cost. Passive sink: nothing (window 0 still active).
      expect(publishSums.active).to.equal(actualDisc);
      expect(publishSums.passive).to.equal(0n);

      // Advance one full window; settle.
      await time.increase(epochLength + 1n);
      const txSettle = await NFT.settle(1);
      const settleSums = await sumStakerPoolDistributionFromEvents(txSettle);
      // Passive sink: window 0 remainder = baseAllowance - actualDisc.
      expect(settleSums.passive).to.equal(baseAllowance - actualDisc);
      expect(settleSums.active).to.equal(0n);

      // Idempotency: calling settle again in the same window is a no-op.
      const txSettle2 = await NFT.settle(1);
      const sums2 = await sumStakerPoolDistributionFromEvents(txSettle2);
      expect(sums2.total).to.equal(0n);
    });

    it('post-expiry settle() sweeps remaining base windows, topUp buffer, and dust; sets fullySwept', async () => {
      // Pick committed amount NOT divisible by 12 to exercise the dust path.
      const committed = hre.ethers.parseEther('120000') + 5n;
      const baseAllowance = committed / 12n;
      const dust = committed - baseAllowance * 12n;
      const top = hre.ethers.parseEther('30000');

      await TokenContract.approve(await NFT.getAddress(), committed + top);
      await NFT.createAccount(committed);
      await NFT.topUp(1, top);

      const epochLength = await ChronosContract.epochLength();
      await time.increase(epochLength * BigInt(LOCK_DURATION + 1));

      const tx = await NFT.settle(1);
      const sums = await sumStakerPoolDistributionFromEvents(tx);

      // Passive sink covers the base allowance across all 12 windows
      // (no publishes happened, so each window's remainder == baseAllowance).
      expect(sums.passive).to.equal(baseAllowance * 12n);
      expect(sums.active).to.equal(0n);
      // Post-expiry tail = topUp + dust.
      expect(sums.tail).to.equal(top + dust);
      // Conservation: total === committedTRAC + topUp (dust is part of
      // committedTRAC because committed = baseAllowance*12 + dust).
      expect(sums.total).to.equal(committed + top);

      const after = await NFT.getAccountInfo(1);
      expect(after.fullySwept).to.equal(true);
      expect(after.lastSettledWindow).to.equal(LOCK_DURATION);
      expect(after.topUpBuffer).to.equal(0n);
      expect(dust).to.be.gt(0n);
    });

    it('post-expiry settle() is idempotent — second call is a no-op (fullySwept guard)', async () => {
      const committed = hre.ethers.parseEther('120000');
      await TokenContract.approve(await NFT.getAddress(), committed);
      await NFT.createAccount(committed);
      const epochLength = await ChronosContract.epochLength();
      await time.increase(epochLength * BigInt(LOCK_DURATION + 1));
      await NFT.settle(1);

      const tx2 = await NFT.settle(1);
      const sums2 = await sumStakerPoolDistributionFromEvents(tx2);
      expect(sums2.total).to.equal(0n);
    });

    it('NFT transfer auto-settles elapsed windows before clearing agents (pre-expiry)', async () => {
      const committed = hre.ethers.parseEther('120000');
      const baseAllowance = committed / 12n;
      await TokenContract.approve(await NFT.getAddress(), committed);
      await NFT.createAccount(committed);

      const epochLength = await ChronosContract.epochLength();
      const N = 2n;
      await time.increase(epochLength * N + 1n);
      const tx = await NFT.transferFrom(accounts[0].address, accounts[7].address, 1);
      const sums = await sumStakerPoolDistributionFromEvents(tx);

      expect(sums.passive).to.equal(N * baseAllowance);
      expect(sums.tail).to.equal(0n);

      const after = await NFT.getAccountInfo(1);
      expect(after.lastSettledWindow).to.be.gte(N);
      expect(after.fullySwept).to.equal(false);
    });

    it('NFT transfer post-expiry triggers FULL sweep (fullySwept=true) on the outgoing owner', async () => {
      const committed = hre.ethers.parseEther('120000');
      const top = hre.ethers.parseEther('10000');
      await TokenContract.approve(await NFT.getAddress(), committed + top);
      await NFT.createAccount(committed);
      await NFT.topUp(1, top);

      const epochLength = await ChronosContract.epochLength();
      await time.increase(epochLength * BigInt(LOCK_DURATION + 1));
      const tx = await NFT.transferFrom(accounts[0].address, accounts[7].address, 1);
      const sums = await sumStakerPoolDistributionFromEvents(tx);

      // committedTRAC divides 12 cleanly here → no dust path, just topUp tail.
      expect(sums.total).to.equal(committed + top);

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
});
