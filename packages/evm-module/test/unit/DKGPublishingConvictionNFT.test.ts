import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
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
  EpochStorage: EpochStorage;
  Chronos: Chronos;
};

const LOCK_DURATION = 12;
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

describe('@unit DKGPublishingConvictionNFT', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let NFT: DKGPublishingConvictionNFT;
  let TokenContract: Token;
  let StakingStorageContract: StakingStorage;
  let EpochStorageContract: EpochStorage;
  let ChronosContract: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'DKGPublishingConvictionNFT',
      'Token',
      'StakingStorage',
      'EpochStorage',
      'Chronos',
    ]);
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const NFT = await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT');
    const Token = await hre.ethers.getContract<Token>('Token');
    const StakingStorageC = await hre.ethers.getContract<StakingStorage>('StakingStorage');
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
    it('transfers TRAC directly from user to StakingStorage (NFT balance stays 0)', async () => {
      const amount = hre.ethers.parseEther('1000000');
      const nftAddr = await NFT.getAddress();
      const ssAddr = await StakingStorageContract.getAddress();

      const userBefore = await TokenContract.balanceOf(accounts[0].address);
      const nftBefore = await TokenContract.balanceOf(nftAddr);
      const ssBefore = await TokenContract.balanceOf(ssAddr);
      expect(nftBefore).to.equal(0n);

      await TokenContract.approve(nftAddr, amount);
      await NFT.createAccount(amount);

      expect(await TokenContract.balanceOf(nftAddr)).to.equal(0n);
      expect(await TokenContract.balanceOf(accounts[0].address)).to.equal(userBefore - amount);
      expect(await TokenContract.balanceOf(ssAddr)).to.equal(ssBefore + amount);
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
      expect(info.expiresAtEpoch).to.equal(currentEpoch + BigInt(LOCK_DURATION));
      expect(info.discountBps).to.equal(7500n);
      expect(info.baseEpochAllowance).to.equal(amount / 12n);
      expect(info.topUpBuffer).to.equal(0n);
      expect(info.agentCount).to.equal(0n);
    });

    it('emits AccountCreated with correct args', async () => {
      const amount = hre.ethers.parseEther('500000');
      await TokenContract.approve(await NFT.getAddress(), amount);
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      await expect(NFT.createAccount(amount))
        .to.emit(NFT, 'AccountCreated')
        .withArgs(
          1,
          accounts[0].address,
          amount,
          5000,
          currentEpoch,
          currentEpoch + BigInt(LOCK_DURATION),
        );
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
  // C. EpochStorage distribution (G2) and N23 gate
  // ======================================================================

  describe('createAccount: epoch pool distribution', () => {
    it('distributes committedTRAC across 12 epochs of the staker shard', async () => {
      const amount = hre.ethers.parseEther('1200000'); // divisible by 12 cleanly
      const current = await ChronosContract.getCurrentEpoch();

      const before: bigint[] = [];
      for (let i = 0; i < LOCK_DURATION; i++) {
        before.push(await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i)));
      }
      // Snapshot the epoch immediately AFTER the lock window too so we can
      // prove the 12-epoch distribution did not bleed into epoch N+12.
      const outsideBefore = await EpochStorageContract.getEpochPool(
        STAKER_SHARD_ID,
        current + BigInt(LOCK_DURATION),
      );

      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);

      const perEpoch = amount / BigInt(LOCK_DURATION);
      for (let i = 0; i < LOCK_DURATION; i++) {
        const after = await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i));
        expect(after - before[i]).to.equal(perEpoch);
      }
      // The epoch after the lock window (N + 12) must be completely unaffected.
      const outsideAfter = await EpochStorageContract.getEpochPool(
        STAKER_SHARD_ID,
        current + BigInt(LOCK_DURATION),
      );
      expect(outsideAfter - outsideBefore).to.equal(0n);
    });

    it('conserves TRAC when committedTRAC is NOT divisible by 12 (remainder goes to EpochStorage accumulator)', async () => {
      // 25_013 ether: lowest tier (>=25K) plus 13 wei tail that does not divide 12.
      const amount = hre.ethers.parseEther('25000') + 13n;
      const current = await ChronosContract.getCurrentEpoch();

      const epochBefore: bigint[] = [];
      for (let i = 0; i < LOCK_DURATION; i++) {
        epochBefore.push(
          await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i)),
        );
      }
      const remainderBefore = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);

      await TokenContract.approve(await NFT.getAddress(), amount);
      await NFT.createAccount(amount);

      let epochDeltaSum = 0n;
      for (let i = 0; i < LOCK_DURATION; i++) {
        const after = await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i));
        epochDeltaSum += after - epochBefore[i];
      }
      const remainderAfter = await EpochStorageContract.accumulatedRemainder(STAKER_SHARD_ID);
      const remainderDelta = remainderAfter - remainderBefore;

      // Conservation: every wei committed lands somewhere in EpochStorage
      // (epoch pools + the shard's accumulatedRemainder carry). The contract
      // MUST NOT silently lose TRAC when committedTRAC % 12 != 0.
      expect(epochDeltaSum + remainderDelta).to.equal(amount);
      expect(amount % BigInt(LOCK_DURATION)).to.not.equal(0n);
    });
  });

  // ======================================================================
  // C2. Multi-epoch full-flow integration test
  // ======================================================================

  describe('multi-epoch full flow', () => {
    it('createAccount -> drain epoch N -> advance -> cover -> topUp -> cover drains N+1 base then topUp', async () => {
      // Impersonate KAV10 by registering accounts[5] under that Hub name. The
      // NFT resolves the caller via Hub on every coverPublishingCost call.
      const Kav10Signer = accounts[5];
      await HubContract.setContractAddress('KnowledgeAssetsV10', Kav10Signer.address);

      // committedTRAC divisible by 12 → clean per-epoch allowance math.
      const committed = hre.ethers.parseEther('120000'); // 30% tier, 10K per epoch
      const baseAllowance = committed / 12n;
      const discountBps = 3000n;
      await TokenContract.approve(await NFT.getAddress(), committed);
      await NFT.createAccount(committed);

      // Register a publishing agent for account 1.
      const agent = accounts[6];
      await NFT.registerAgent(1, agent.address);

      const epochN = await ChronosContract.getCurrentEpoch();

      // --- Phase 1: drain epoch N base allowance exactly ---
      // Pick baseCost so discountedCost == baseAllowance (10000 ether). Round
      // UP on the division so the contract's floor-division inside
      // coverPublishingCost produces exactly `baseAllowance`.
      const numer = baseAllowance * BPS;
      const denom = BPS - discountBps;
      const baseCost1 = (numer + denom - 1n) / denom;
      const discounted1 = (baseCost1 * (BPS - discountBps)) / BPS;
      expect(discounted1).to.equal(baseAllowance);
      await NFT.connect(Kav10Signer).coverPublishingCost(agent.address, baseCost1);
      expect(await NFT.epochSpent(1, epochN)).to.equal(baseAllowance);

      // Any further cover in epoch N must revert (no topUp yet). Use a
      // baseCost large enough that discountedCost rounds to >= 1 wei.
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(agent.address, hre.ethers.parseEther('1')),
      ).to.be.revertedWithCustomError(NFT, 'InsufficientAllowance');

      // --- Phase 2: advance one epoch so base allowance resets for N+1 ---
      await time.increase((await ChronosContract.timeUntilNextEpoch()) + 1n);
      const epochN1 = await ChronosContract.getCurrentEpoch();
      expect(epochN1).to.equal(epochN + 1n);

      // Cover a small amount in the fresh epoch: pulls from N+1 base, NOT N.
      const smallBase = hre.ethers.parseEther('1000');
      const smallDiscounted = (smallBase * (BPS - discountBps)) / BPS; // 700
      await NFT.connect(Kav10Signer).coverPublishingCost(agent.address, smallBase);
      expect(await NFT.epochSpent(1, epochN1)).to.equal(smallDiscounted);
      // Epoch N remains fully drained but untouched.
      expect(await NFT.epochSpent(1, epochN)).to.equal(baseAllowance);

      // --- Phase 3: topUp while account still live ---
      const topAmount = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), topAmount);
      await NFT.topUp(1, topAmount);
      expect((await NFT.getAccountInfo(1)).topUpBuffer).to.equal(topAmount);

      // --- Phase 4: cover larger than N+1 remaining → drains remainder of N+1, then topUp ---
      // N+1 remaining base = baseAllowance - smallDiscounted
      const n1Remaining = baseAllowance - smallDiscounted;
      // Choose baseCost2 so discounted > n1Remaining (forces topUp draw).
      const baseCost2 = hre.ethers.parseEther('20000'); // discounted = 14000
      const discounted2 = (baseCost2 * (BPS - discountBps)) / BPS; // 14000
      const expectedTopUpDraw = discounted2 - n1Remaining;

      await NFT.connect(Kav10Signer).coverPublishingCost(agent.address, baseCost2);

      // N+1 base fully drained.
      expect(await NFT.epochSpent(1, epochN1)).to.equal(baseAllowance);
      // topUp buffer reduced by exactly the shortfall.
      const info = await NFT.getAccountInfo(1);
      expect(info.topUpBuffer).to.equal(topAmount - expectedTopUpDraw);
      // Epoch N still untouched — historical state is immutable.
      expect(await NFT.epochSpent(1, epochN)).to.equal(baseAllowance);
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
    it('initialize reverts when EpochStorageV8 is address(0)', async () => {
      const freshHub = await deployDisposableHub();
      // Register Token + StakingStorage + Chronos stubs (EOA signers are fine —
      // Hub._isContract skips setStatus for non-contract addresses). Omit
      // EpochStorageV8 so initialize must revert on that branch.
      const [, signer17, signer18, signer19] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('Token', signer17.address);
      await freshHub.setContractAddress('StakingStorage', signer18.address);
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

    it('initialize reverts when StakingStorage is address(0)', async () => {
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
        .withArgs('StakingStorage');
    });

    it('initialize reverts when Chronos is address(0)', async () => {
      const freshHub = await deployDisposableHub();
      const [, signer17, signer18, signer19] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('Token', signer17.address);
      await freshHub.setContractAddress('StakingStorage', signer18.address);
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
      // Register StakingStorage + EpochStorageV8 + Chronos; omit Token.
      const [, signer17, signer18, signer19] = await hre.ethers.getSigners();
      await freshHub.setContractAddress('StakingStorage', signer17.address);
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

    it('sends TRAC directly to StakingStorage (NFT balance stays 0) and increments topUpBalance', async () => {
      const initial = hre.ethers.parseEther('120000');
      const top = hre.ethers.parseEther('30000');
      await createAt(initial);

      const nftAddr = await NFT.getAddress();
      const ssAddr = await StakingStorageContract.getAddress();
      const ssBefore = await TokenContract.balanceOf(ssAddr);

      await TokenContract.approve(nftAddr, top);
      await NFT.topUp(1, top);

      expect(await TokenContract.balanceOf(nftAddr)).to.equal(0n);
      expect(await TokenContract.balanceOf(ssAddr)).to.equal(ssBefore + top);

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

    it('distributes topUp TRAC across the REMAINING account lifetime', async () => {
      // Account created at currentEpoch with lock = 12 → remaining 12 epochs.
      const initial = hre.ethers.parseEther('120000');
      const top = hre.ethers.parseEther('60000'); // 60000/12 = 5000 per epoch
      await createAt(initial);

      const current = await ChronosContract.getCurrentEpoch();
      const before: bigint[] = [];
      for (let i = 0; i < LOCK_DURATION; i++) {
        before.push(await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i)));
      }

      await TokenContract.approve(await NFT.getAddress(), top);
      await NFT.topUp(1, top);

      const perEpoch = top / BigInt(LOCK_DURATION);
      for (let i = 0; i < LOCK_DURATION; i++) {
        const after = await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, current + BigInt(i));
        expect(after - before[i]).to.equal(perEpoch);
      }
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

    it('returns the discounted cost and deducts from epoch allowance', async () => {
      const committed = hre.ethers.parseEther('1200000'); // 100K per epoch, 75% discount
      await createAtWithAgent(committed, agent.address);

      const baseCost = hre.ethers.parseEther('10000');
      const expectedDiscount = (baseCost * (BPS - 7500n)) / BPS; // 2500 TRAC

      // staticCall to read the return value, then actually execute.
      const returned = await NFT.connect(Kav10Signer).coverPublishingCost.staticCall(
        agent.address,
        baseCost,
      );
      expect(returned).to.equal(expectedDiscount);
      await NFT.connect(Kav10Signer).coverPublishingCost(agent.address, baseCost);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      expect(await NFT.epochSpent(1, currentEpoch)).to.equal(expectedDiscount);
      // Top-up buffer untouched
      expect((await NFT.getAccountInfo(1)).topUpBuffer).to.equal(0n);
    });

    it('spends epoch allowance first, then topUpBalance', async () => {
      const committed = hre.ethers.parseEther('120000'); // 10K per epoch, 30% discount
      await createAtWithAgent(committed, agent.address);
      const top = hre.ethers.parseEther('50000');
      await TokenContract.approve(await NFT.getAddress(), top);
      await NFT.topUp(1, top);

      // baseCost such that discounted > 10K epoch allowance, pulling from topUp
      const baseCost = hre.ethers.parseEther('20000'); // discounted at 30% = 14000 TRAC
      const discounted = (baseCost * (BPS - 3000n)) / BPS; // 14000
      const baseAllowance = committed / 12n; // 10000

      await NFT.connect(Kav10Signer).coverPublishingCost(agent.address, baseCost);

      const currentEpoch = await ChronosContract.getCurrentEpoch();
      expect(await NFT.epochSpent(1, currentEpoch)).to.equal(baseAllowance);
      const info = await NFT.getAccountInfo(1);
      expect(info.topUpBuffer).to.equal(top - (discounted - baseAllowance));
    });

    it('reverts InsufficientAllowance when both empty', async () => {
      const committed = hre.ethers.parseEther('60000'); // 5K per epoch, 20% discount
      await createAtWithAgent(committed, agent.address);
      // Drain the epoch allowance: first call consumes exactly the allowance.
      const baseCost1 = (committed / 12n) * BPS / (BPS - 2000n); // so discounted == allowance
      await NFT.connect(Kav10Signer).coverPublishingCost(agent.address, baseCost1);
      // Second call with any positive cost should revert
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(agent.address, hre.ethers.parseEther('100')),
      ).to.be.revertedWithCustomError(NFT, 'InsufficientAllowance');
    });

    it('reverts NoConvictionAccount for an unregistered agent', async () => {
      // No agent registered; call from KAV10 with a random EOA.
      await expect(
        NFT.connect(Kav10Signer).coverPublishingCost(accounts[9].address, 1n),
      )
        .to.be.revertedWithCustomError(NFT, 'NoConvictionAccount')
        .withArgs(accounts[9].address);
    });

    it('N28: cross-account isolation — agent A call cannot touch account B', async () => {
      // Account A owned by accounts[0], agent = accounts[6].
      const committedA = hre.ethers.parseEther('120000'); // 10K/epoch, 30% discount
      await createAtWithAgent(committedA, agent.address);

      // Account B owned by accounts[1], agent = accounts[8].
      const committedB = hre.ethers.parseEther('60000'); // 5K/epoch, 20% discount
      const agentB = accounts[8];
      await TokenContract.connect(accounts[1]).approve(await NFT.getAddress(), committedB);
      await NFT.connect(accounts[1]).createAccount(committedB);
      await NFT.connect(accounts[1]).registerAgent(2, agentB.address);

      const currentEpoch = await ChronosContract.getCurrentEpoch();

      // Snapshot starting state.
      const spentABefore = await NFT.epochSpent(1, currentEpoch);
      const spentBBefore = await NFT.epochSpent(2, currentEpoch);
      expect(spentABefore).to.equal(0n);
      expect(spentBBefore).to.equal(0n);

      // Call with agent A: must hit account A only.
      const baseCostA = hre.ethers.parseEther('1000');
      const discountedA = (baseCostA * (BPS - 3000n)) / BPS; // 700
      await NFT.connect(Kav10Signer).coverPublishingCost(agent.address, baseCostA);
      expect(await NFT.epochSpent(1, currentEpoch)).to.equal(discountedA);
      expect(await NFT.epochSpent(2, currentEpoch)).to.equal(0n);

      // Call with agent B: must hit account B only. Account A untouched.
      const baseCostB = hre.ethers.parseEther('500');
      const discountedB = (baseCostB * (BPS - 2000n)) / BPS; // 400
      await NFT.connect(Kav10Signer).coverPublishingCost(agentB.address, baseCostB);
      expect(await NFT.epochSpent(1, currentEpoch)).to.equal(discountedA);
      expect(await NFT.epochSpent(2, currentEpoch)).to.equal(discountedB);
    });

    it('N28: a non-KAV10 Hub-registered contract cannot call (OnlyKnowledgeAssetsV10)', async () => {
      const committed = hre.ethers.parseEther('60000');
      await createAtWithAgent(committed, agent.address);

      // Register a DIFFERENT Hub contract under a different name. This mimics
      // the attacker: a malicious but trusted Hub contract attempting to drain
      // the victim's account. It must be rejected — the gate is KAV10-only.
      const Attacker = accounts[7];
      await HubContract.setContractAddress('MaliciousCaller', Attacker.address);

      await expect(
        NFT.connect(Attacker).coverPublishingCost(agent.address, hre.ethers.parseEther('100')),
      )
        .to.be.revertedWithCustomError(NFT, 'OnlyKnowledgeAssetsV10')
        .withArgs(Attacker.address);
    });

    it('rejects EOA callers with OnlyKnowledgeAssetsV10', async () => {
      const committed = hre.ethers.parseEther('60000');
      await createAtWithAgent(committed, agent.address);
      const eoa = accounts[7];
      await expect(
        NFT.connect(eoa).coverPublishingCost(agent.address, hre.ethers.parseEther('100')),
      )
        .to.be.revertedWithCustomError(NFT, 'OnlyKnowledgeAssetsV10')
        .withArgs(eoa.address);
    });

    it('ABI has exactly 2 parameters: (publishingAgent, baseCost)', async () => {
      const fn = NFT.interface.getFunction('coverPublishingCost');
      expect(fn).to.not.equal(null);
      expect(fn!.inputs.length).to.equal(2);
      expect(fn!.inputs[0].name).to.equal('publishingAgent');
      expect(fn!.inputs[0].type).to.equal('address');
      expect(fn!.inputs[1].name).to.equal('baseCost');
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
