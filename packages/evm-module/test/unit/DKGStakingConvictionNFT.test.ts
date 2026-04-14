import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  Hub,
  ParametersStorage,
  Profile,
  RandomSamplingStorage,
  Staking,
  StakingStorage,
  StakingV10,
  Token,
} from '../../typechain';

// ---------------------------------------------------------------------------
// Phase 5 discrete tier ladder — {0,1,3,6,12} months. Mirrors
// `ConvictionStakingStorage.expectedMultiplier18` and
// `DKGStakingConvictionNFT._convictionMultiplier`.
// ---------------------------------------------------------------------------
const SCALE18 = 10n ** 18n;
const ONE_X = SCALE18;
const ONE_AND_HALF_X = (15n * SCALE18) / 10n;
const TWO_X = 2n * SCALE18;
const THREE_AND_HALF_X = (35n * SCALE18) / 10n;
const SIX_X = 6n * SCALE18;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  StakingV10: StakingV10;
  Staking: Staking;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  ParametersStorage: ParametersStorage;
  Profile: Profile;
  Token: Token;
  Chronos: Chronos;
};

async function deployFixture(): Promise<Fixture> {
  // Full v10 deployment graph. The `DKGStakingConvictionNFT` tag already
  // depends on Hub / Staking / StakingV10 / ConvictionStakingStorage /
  // ParametersStorage / ProfileStorage / Profile / Token and every
  // intermediate storage, so a single fixture invocation yields a fully
  // Hub-wired graph ready for end-to-end `createConviction` tests.
  await hre.deployments.fixture(['DKGStakingConvictionNFT', 'StakingV10', 'Profile']);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const NFT = await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT');
  const StakingV10 = await hre.ethers.getContract<StakingV10>('StakingV10');
  const Staking = await hre.ethers.getContract<Staking>('Staking');
  const StakingStorage = await hre.ethers.getContract<StakingStorage>('StakingStorage');
  const ConvictionStakingStorage = await hre.ethers.getContract<ConvictionStakingStorage>(
    'ConvictionStakingStorage',
  );
  const ParametersStorage = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
  const Profile = await hre.ethers.getContract<Profile>('Profile');
  const Token = await hre.ethers.getContract<Token>('Token');
  const Chronos = await hre.ethers.getContract<Chronos>('Chronos');

  // HubOwner lets accounts[0] call privileged setters (e.g. setMaximumStake).
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    NFT,
    StakingV10,
    Staking,
    StakingStorage,
    ConvictionStakingStorage,
    ParametersStorage,
    Profile,
    Token,
    Chronos,
  };
}

describe('@unit DKGStakingConvictionNFT', () => {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;
  let Staking: Staking;
  let StakingStorage: StakingStorage;
  let ConvictionStakingStorageContract: ConvictionStakingStorage;
  let ParametersStorage: ParametersStorage;
  let Profile: Profile;
  let Token: Token;
  let ChronosContract: Chronos;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub,
      NFT,
      StakingV10: StakingV10Contract,
      Staking,
      StakingStorage,
      ConvictionStakingStorage: ConvictionStakingStorageContract,
      ParametersStorage,
      Profile,
      Token,
      Chronos: ChronosContract,
    } = await loadFixture(deployFixture));
  });

  // Helper — advance block time past `n` full Chronos epochs so the next
  // `chronos.getCurrentEpoch()` read reflects the new boundary. Mirrors the
  // pattern in `ConvictionStakingStorage.test.ts::advanceEpochs`.
  const advanceEpochs = async (n: number) => {
    const epochLength = await ChronosContract.epochLength();
    await time.increase(Number(epochLength) * n);
  };

  // Helper — mint a profile via `Profile.createProfile`, using fresh
  // node key material on every call. Mirrors `Staking.test.ts::createProfile`.
  const createProfile = async (
    admin?: SignerWithAddress,
    operational?: SignerWithAddress,
  ) => {
    const nodeId = '0x' + randomBytes(32).toString('hex');
    const tx = await Profile.connect(operational ?? accounts[1]).createProfile(
      (admin ?? accounts[0]).address,
      [],
      `Node ${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    const identityId = Number(receipt!.logs[0].topics[1]);
    return { nodeId, identityId };
  };

  // Helper — mint TRAC to `staker` and approve StakingV10 (the NFT wrapper
  // holds NO TRAC; `StakingV10.stake` pulls `transferFrom(staker, stakingStorage)`).
  const mintAndApprove = async (staker: SignerWithAddress, amount: bigint) => {
    await Token.mint(staker.address, amount);
    await Token.connect(staker).approve(await StakingV10Contract.getAddress(), amount);
  };

  // Helper — convert tokenId to the bytes32 delegator key StakingStorage uses
  // on the V10 NFT path (disjoint from V8 `keccak256(address)`).
  const tokenIdKey = (tokenId: bigint | number): string =>
    hre.ethers.zeroPadValue(hre.ethers.toBeHex(tokenId), 32);

  describe('createConviction (→ StakingV10.stake)', () => {
    // -----------------------------------------------------------------
    // Revert paths
    // -----------------------------------------------------------------

    it('reverts on amount == 0', async () => {
      const { identityId } = await createProfile();
      // Wrapper's fail-fast check catches amount=0 at the NFT layer.
      await expect(
        NFT.connect(accounts[0]).createConviction(identityId, 0, 12),
      ).to.be.revertedWithCustomError(NFT, 'ZeroAmount');
    });

    it('reverts on invalid lock tier (2)', async () => {
      const { identityId } = await createProfile();
      // Tier 2 WAS the legacy 1.5x tier but Phase 5 dropped it;
      // `_convictionMultiplier` now rejects it at the wrapper layer.
      await expect(
        NFT.connect(accounts[0]).createConviction(identityId, 1_000n, 2),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockEpochs');
    });

    it('reverts on invalid lock tier (13)', async () => {
      const { identityId } = await createProfile();
      await expect(
        NFT.connect(accounts[0]).createConviction(identityId, 1_000n, 13),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockEpochs');
    });

    it('reverts on invalid lock tier (0 — rest state, not a valid create target)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      // lock=0 is the post-expiry rest state in ConvictionStakingStorage;
      // new positions must never enter at the rest tier. The wrapper's
      // `_convictionMultiplier` accepts 0 (for reward-math callers) but
      // StakingV10.stake rejects it via `InvalidLockEpochs`.
      await expect(
        NFT.connect(accounts[0]).createConviction(identityId, amount, 0),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'InvalidLockEpochs');
    });

    it('reverts on non-existent profile', async () => {
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      // `StakingV10.stake` checks `profileStorage.profileExists` before
      // touching any storage. Ghost identityId → revert, no state leak.
      await expect(
        NFT.connect(accounts[0]).createConviction(9999, amount, 12),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'ProfileDoesNotExist');
    });

    it('reverts when nodeStake + amount > maxStake', async () => {
      const { identityId } = await createProfile();
      // Shrink maxStake to a tiny value so even a small stake trips the
      // check. setMaximumStake is onlyOwnerOrMultiSigOwner; HubOwner is
      // accounts[0] per the fixture.
      await ParametersStorage.connect(accounts[0]).setMaximumStake(1_000n);

      const amount = 1_001n;
      await mintAndApprove(accounts[0], amount);
      await expect(
        NFT.connect(accounts[0]).createConviction(identityId, amount, 12),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'MaxStakeExceeded');

      // No state leak past the revert.
      expect(await StakingStorage.getNodeStake(identityId)).to.equal(0n);
    });

    it('reverts when caller has not approved StakingV10 for TRAC', async () => {
      const { identityId } = await createProfile();
      await Token.mint(accounts[0].address, 1_000n);
      // Deliberately no approve(). The `transferFrom` inside StakingV10.stake
      // reverts on insufficient allowance. We don't pin to a specific error
      // here (it's an ERC20 OZ revert) so `.to.be.reverted` is the right
      // assertion shape.
      await expect(
        NFT.connect(accounts[0]).createConviction(identityId, 1_000n, 12),
      ).to.be.reverted;
    });

    // -----------------------------------------------------------------
    // Happy path — 12-month tier
    // -----------------------------------------------------------------

    it('happy path: 12-month tier mints tokenId=0 and writes Staking/Conviction storage', async () => {
      const { identityId } = await createProfile();
      const minStake = await ParametersStorage.minimumStake();
      const amount = minStake; // exercise the sharding-table insertion path too
      await mintAndApprove(accounts[0], amount);

      const stakingStorageAddr = await StakingStorage.getAddress();
      const nftAddr = await NFT.getAddress();
      const stakerBalBefore = await Token.balanceOf(accounts[0].address);
      const ssBalBefore = await Token.balanceOf(stakingStorageAddr);
      const totalStakeBefore = await StakingStorage.getTotalStake();

      // Next NFT mint is tokenId 0 (fresh ERC721Enumerable, no sentinel reservation).
      const tx = await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // Wrapper-layer event mirrors the mint; authoritative event from StakingV10.
      await expect(tx)
        .to.emit(NFT, 'PositionCreated')
        .withArgs(accounts[0].address, 0n, identityId, amount, 12);
      await expect(tx)
        .to.emit(StakingV10Contract, 'Staked')
        .withArgs(0n, accounts[0].address, identityId, amount, 12);

      // ERC721 ownership.
      expect(await NFT.ownerOf(0)).to.equal(accounts[0].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);

      // Token flow: staker → StakingStorage, nothing in NFT wrapper or StakingV10.
      expect(await Token.balanceOf(accounts[0].address)).to.equal(stakerBalBefore - amount);
      expect(await Token.balanceOf(stakingStorageAddr)).to.equal(ssBalBefore + amount);
      expect(await Token.balanceOf(nftAddr)).to.equal(0n);
      expect(await Token.balanceOf(await StakingV10Contract.getAddress())).to.equal(0n);

      // StakingStorage delegator/node/total bookkeeping.
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(0)),
      ).to.equal(amount);
      expect(await StakingStorage.getNodeStake(identityId)).to.equal(amount);
      expect(await StakingStorage.getTotalStake()).to.equal(totalStakeBefore + amount);

      // ConvictionStakingStorage position.
      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.identityId).to.equal(identityId);
      expect(pos.raw).to.equal(amount);
      expect(pos.rewards).to.equal(0n);
      expect(pos.lockEpochs).to.equal(12);
      expect(pos.multiplier18).to.equal(SIX_X);
    });

    // -----------------------------------------------------------------
    // Happy path — tier matrix
    // -----------------------------------------------------------------

    const happyTiers: Array<[number, bigint]> = [
      [1, ONE_AND_HALF_X],
      [3, TWO_X],
      [6, THREE_AND_HALF_X],
      [12, SIX_X],
    ];

    for (const [lockEpochs, expectedMult] of happyTiers) {
      it(`happy path: tier ${lockEpochs} writes multiplier18 = ${expectedMult.toString()}`, async () => {
        const { identityId } = await createProfile();
        const amount = hre.ethers.parseEther('1000');
        await mintAndApprove(accounts[0], amount);

        await NFT.connect(accounts[0]).createConviction(identityId, amount, lockEpochs);

        const pos = await ConvictionStakingStorageContract.getPosition(0);
        expect(pos.multiplier18).to.equal(expectedMult);
        expect(pos.lockEpochs).to.equal(lockEpochs);
        expect(pos.raw).to.equal(amount);
      });
    }

    // -----------------------------------------------------------------
    // tokenId accounting across multiple mints
    // -----------------------------------------------------------------

    it('multiple NFTs per user: tokenIds increment 0, 1, 2 and node totals accumulate', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      // Three separate mints → three fresh approvals (each approve is
      // consumed by one transferFrom). Simpler to mint once and approve once
      // for the aggregate.
      await mintAndApprove(accounts[0], amount * 3n);

      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 6);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      expect(await NFT.ownerOf(0)).to.equal(accounts[0].address);
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.ownerOf(2)).to.equal(accounts[0].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(3n);

      // Per-tokenId StakingStorage state is independent — each tokenId has
      // its own bytes32(tokenId) delegator key.
      for (let t = 0n; t < 3n; t++) {
        expect(
          await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(t)),
        ).to.equal(amount);
      }
      // Node total is the sum.
      expect(await StakingStorage.getNodeStake(identityId)).to.equal(amount * 3n);

      // ConvictionStakingStorage positions are independent and carry the
      // per-mint tier.
      expect((await ConvictionStakingStorageContract.getPosition(0)).multiplier18).to.equal(SIX_X);
      expect((await ConvictionStakingStorageContract.getPosition(1)).multiplier18).to.equal(
        THREE_AND_HALF_X,
      );
      expect((await ConvictionStakingStorageContract.getPosition(2)).multiplier18).to.equal(
        ONE_AND_HALF_X,
      );
    });

    it('two users get distinct tokenIds on the same node', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await mintAndApprove(accounts[4], amount);

      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      await NFT.connect(accounts[4]).createConviction(identityId, amount, 12);

      expect(await NFT.ownerOf(0)).to.equal(accounts[0].address);
      expect(await NFT.ownerOf(1)).to.equal(accounts[4].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);
      expect(await NFT.balanceOf(accounts[4].address)).to.equal(1n);

      // Both NFTs live on the same node but under disjoint delegator keys.
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(0)),
      ).to.equal(amount);
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(1)),
      ).to.equal(amount);
      expect(await StakingStorage.getNodeStake(identityId)).to.equal(amount * 2n);
    });

    // -----------------------------------------------------------------
    // Invariants
    // -----------------------------------------------------------------

    it('NFT wrapper TRAC balance is always zero across all paths', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);

      const nftAddr = await NFT.getAddress();
      expect(await Token.balanceOf(nftAddr)).to.equal(0n);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      // TRAC flows user → StakingStorage in one hop; NFT never holds funds.
      expect(await Token.balanceOf(nftAddr)).to.equal(0n);
    });

    it('direct StakingV10.stake call from non-NFT caller reverts via onlyConvictionNFT gate', async () => {
      const { identityId } = await createProfile();
      const amount = 1_000n;
      await mintAndApprove(accounts[0], amount);
      // The gate pins caller to the Hub-registered NFT contract. accounts[0]
      // is not the NFT, so stake() reverts with OnlyConvictionNFT.
      await expect(
        StakingV10Contract.connect(accounts[0]).stake(
          accounts[0].address,
          42,
          identityId,
          amount,
          12,
        ),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });

    it('sharding table: node staked with >= minStake is added', async () => {
      const { identityId } = await createProfile();
      const minStake = await ParametersStorage.minimumStake();
      await mintAndApprove(accounts[0], minStake);

      const ShardingTableStorage = await hre.ethers.getContract<import('../../typechain').ShardingTableStorage>(
        'ShardingTableStorage',
      );
      expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(false);

      await NFT.connect(accounts[0]).createConviction(identityId, minStake, 12);

      expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(true);
    });
  });

  // =====================================================================
  // relock → StakingV10.relock
  // =====================================================================
  //
  // Post-expiry re-commit of an existing position to a new lock tier. Raw
  // principal stays put (already unlocked); the multiplier + expiry fields
  // shift, and the rewards bucket is left untouched. The NFT wrapper
  // enforces ownership + tier fail-fast; StakingV10 enforces lock-expiry
  // + settles the indices + forwards to
  // `ConvictionStakingStorage.updateOnRelock`, which owns the
  // effective-stake diff propagation.

  describe('relock (→ StakingV10.relock)', () => {
    // -----------------------------------------------------------------
    // Revert paths
    // -----------------------------------------------------------------

    it('reverts if not owner (non-owner caller)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 3);
      // Advance past the 3-epoch lock.
      await advanceEpochs(4);

      // `accounts[4]` is not the owner of tokenId 0.
      await expect(
        NFT.connect(accounts[4]).relock(0, 6),
      ).to.be.revertedWithCustomError(NFT, 'NotPositionOwner');
    });

    it('reverts on invalid new lock tier (2) at the NFT wrapper layer', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      // Tier 2 was the old 1.5x tier; Phase 5 dropped it. Wrapper rejects
      // via `_convictionMultiplier` before forwarding to StakingV10.
      await expect(
        NFT.connect(accounts[0]).relock(0, 2),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockEpochs');
    });

    it('reverts on invalid new lock tier (13) at the NFT wrapper layer', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await expect(
        NFT.connect(accounts[0]).relock(0, 13),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockEpochs');
    });

    it('reverts if lock still active (pre-expiry)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      // No time advance — the 12-epoch lock is still active.
      await expect(
        NFT.connect(accounts[0]).relock(0, 6),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'LockStillActive');
    });

    it('reverts on non-existent position (tokenId never minted)', async () => {
      // Owner check is the first gate at the NFT wrapper: for a non-minted
      // tokenId, ERC721 `ownerOf(42)` reverts inside the wrapper before
      // StakingV10 is ever called. That is the intended behavior — there is
      // no standalone "PositionNotFound" surface on the happy path because
      // every tokenId that passed the NFT owner check is guaranteed to have
      // a matching position (positions are created atomically with the
      // mint).
      await expect(NFT.connect(accounts[0]).relock(42, 6)).to.be.reverted;
    });

    // -----------------------------------------------------------------
    // Happy paths
    // -----------------------------------------------------------------

    it('happy path: relocks from tier 1 → tier 12 after expiry (multiplier 6e18, raw + rewards untouched)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      // Advance past the 1-epoch lock.
      await advanceEpochs(2);

      const beforeEpoch = await ChronosContract.getCurrentEpoch();
      const tx = await NFT.connect(accounts[0]).relock(0, 12);

      // Wrapper-layer event and StakingV10 authoritative event both fire.
      await expect(tx).to.emit(NFT, 'PositionRelocked').withArgs(0n, 12);
      await expect(tx)
        .to.emit(StakingV10Contract, 'Relocked')
        .withArgs(0n, 12, beforeEpoch + 12n);

      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.identityId).to.equal(identityId);
      expect(pos.raw).to.equal(amount); // principal unchanged
      expect(pos.rewards).to.equal(0n); // rewards bucket untouched
      expect(pos.lockEpochs).to.equal(12);
      expect(pos.multiplier18).to.equal(SIX_X);
      expect(pos.expiryEpoch).to.equal(beforeEpoch + 12n);
    });

    it('happy path: relock to tier 0 (permanent rest state, 1x multiplier)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      await advanceEpochs(2);

      const beforeEpoch = await ChronosContract.getCurrentEpoch();
      // Tier 0 is the permanent rest state: a legitimate post-expiry relock
      // target per the roadmap ("no lockup / 1 / 3 / 6 / 12 months"). The
      // storage helper's tier table maps lock==0 → 1x, and the wrapper's
      // `_convictionMultiplier` helper accepts 0.
      await NFT.connect(accounts[0]).relock(0, 0);

      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.raw).to.equal(amount);
      expect(pos.lockEpochs).to.equal(0);
      expect(pos.multiplier18).to.equal(ONE_X);
      // `updateOnRelock` sets `pos.expiryEpoch = currentEpoch + 0`.
      expect(pos.expiryEpoch).to.equal(beforeEpoch);
    });

    it('happy path: relock updates expiryEpoch to currentEpoch + newLockEpochs', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);

      const beforeEpoch = await ChronosContract.getCurrentEpoch();
      await NFT.connect(accounts[0]).relock(0, 6);
      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.expiryEpoch).to.equal(beforeEpoch + 6n);
      expect(pos.multiplier18).to.equal(THREE_AND_HALF_X);
    });

    it('direct StakingV10.relock call from non-NFT caller reverts via onlyConvictionNFT gate', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);

      // The gate pins the caller to the Hub-registered NFT contract.
      await expect(
        StakingV10Contract.connect(accounts[0]).relock(accounts[0].address, 0, 6),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });
  });

  // =====================================================================
  // redelegate → StakingV10.redelegate
  // =====================================================================
  //
  // Moves a V10 NFT-backed position from its current node to a new node.
  // Per-node `nodeStake` moves (old -= raw+rewards, new += raw+rewards);
  // global `totalStake` is invariant. The ConvictionStakingStorage diff
  // layer owns the effective-stake move + `pos.identityId` mutation via
  // `updateOnRedelegate`. Tier/lock state, raw principal, rewards bucket,
  // and multiplier are all untouched by redelegate.

  describe('redelegate (→ StakingV10.redelegate)', () => {
    // -----------------------------------------------------------------
    // Revert paths
    // -----------------------------------------------------------------

    it('reverts if not owner (non-owner caller)', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 12);

      // `accounts[4]` is not the owner of tokenId 0 — wrapper-layer guard.
      await expect(
        NFT.connect(accounts[4]).redelegate(0, toId),
      ).to.be.revertedWithCustomError(NFT, 'NotPositionOwner');
    });

    it('reverts on same identityId (SameIdentity)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // Redelegating to the current node — StakingV10 rejects with
      // `SameIdentity` before any storage mutation or settle call.
      await expect(
        NFT.connect(accounts[0]).redelegate(0, identityId),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'SameIdentity');
    });

    it('reverts on non-existent destination profile', async () => {
      const { identityId: fromId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 12);

      // identityId 9999 is never registered as a profile. StakingV10 must
      // revert BEFORE touching any storage — otherwise the sharding-table
      // insert at the bottom of the flow would happily register a ghost
      // node at `sha256("")`.
      await expect(
        NFT.connect(accounts[0]).redelegate(0, 9999),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'ProfileDoesNotExist');
    });

    it('reverts when destination nodeStake + amount > maxStake', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);

      // Full-size stake on the source node — the destination starts empty,
      // but we crank maxStake down to one wei above the source so the move
      // strictly over-shoots the destination cap.
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 12);

      // Shrink maxStake below the move size. HubOwner is accounts[0].
      await ParametersStorage.connect(accounts[0]).setMaximumStake(amount - 1n);

      await expect(
        NFT.connect(accounts[0]).redelegate(0, toId),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'MaxStakeExceeded');

      // No state leak past the revert: source node still holds the raw,
      // destination is still empty, position still points at the source.
      expect(await StakingStorage.getNodeStake(fromId)).to.equal(amount);
      expect(await StakingStorage.getNodeStake(toId)).to.equal(0n);
      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.identityId).to.equal(fromId);
    });

    it('direct StakingV10.redelegate call from non-NFT caller reverts via onlyConvictionNFT gate', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 12);

      // The gate pins the caller to the Hub-registered NFT contract.
      await expect(
        StakingV10Contract.connect(accounts[0]).redelegate(accounts[0].address, 0, toId),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });

    // -----------------------------------------------------------------
    // Happy paths
    // -----------------------------------------------------------------

    it('happy path mid-lock: nodeStake moves, totalStake invariant, delegator base moves, position identityId updated, event emitted', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 12);

      const totalStakeBefore = await StakingStorage.getTotalStake();
      expect(await StakingStorage.getNodeStake(fromId)).to.equal(amount);
      expect(await StakingStorage.getNodeStake(toId)).to.equal(0n);

      // Still mid-lock — the 12-epoch lock is nowhere near done.
      const tx = await NFT.connect(accounts[0]).redelegate(0, toId);

      // Wrapper-layer event mirrors, authoritative event from StakingV10.
      await expect(tx)
        .to.emit(NFT, 'PositionRedelegated')
        .withArgs(0n, fromId, toId);
      await expect(tx)
        .to.emit(StakingV10Contract, 'Redelegated')
        .withArgs(0n, fromId, toId);

      // Per-node stake moved.
      expect(await StakingStorage.getNodeStake(fromId)).to.equal(0n);
      expect(await StakingStorage.getNodeStake(toId)).to.equal(amount);

      // Global totalStake is INVARIANT — redelegate is a per-node move only.
      expect(await StakingStorage.getTotalStake()).to.equal(totalStakeBefore);

      // Delegator stake base moved between (identityId, bytes32(tokenId)) buckets.
      expect(
        await StakingStorage.getDelegatorStakeBase(fromId, tokenIdKey(0)),
      ).to.equal(0n);
      expect(
        await StakingStorage.getDelegatorStakeBase(toId, tokenIdKey(0)),
      ).to.equal(amount);

      // ConvictionStakingStorage position now points at the new node.
      // Raw, rewards, lockEpochs, multiplier18, expiryEpoch all untouched.
      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.identityId).to.equal(toId);
      expect(pos.raw).to.equal(amount);
      expect(pos.rewards).to.equal(0n);
      expect(pos.lockEpochs).to.equal(12);
      expect(pos.multiplier18).to.equal(SIX_X);
    });

    it('happy path post-expiry: redelegate after lock expired moves nodeStake correctly', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 1);

      // Advance past the 1-epoch lock; the position is now in post-expiry
      // rest state on the source node. Redelegate should still work — the
      // raw principal follows the position to the new node unchanged.
      await advanceEpochs(2);

      await NFT.connect(accounts[0]).redelegate(0, toId);

      expect(await StakingStorage.getNodeStake(fromId)).to.equal(0n);
      expect(await StakingStorage.getNodeStake(toId)).to.equal(amount);
      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.identityId).to.equal(toId);
      expect(pos.raw).to.equal(amount);
      // Raw lock state on the position stays as it was pre-redelegate
      // (Phase 5 storage contract only mutates identityId + per-node diffs).
      expect(pos.lockEpochs).to.equal(1);
      expect(pos.multiplier18).to.equal(ONE_AND_HALF_X);
    });

    it('multi-NFT independence: redelegating NFT A does not affect NFT B on a third node', async () => {
      const { identityId: nodeA } = await createProfile();
      const { identityId: nodeB } = await createProfile(accounts[0], accounts[2]);
      const { identityId: nodeC } = await createProfile(accounts[0], accounts[3]);

      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount * 2n);

      // NFT 0 → nodeA; NFT 1 → nodeC (separate node, separate tokenId).
      await NFT.connect(accounts[0]).createConviction(nodeA, amount, 12);
      await NFT.connect(accounts[0]).createConviction(nodeC, amount, 12);

      const totalBefore = await StakingStorage.getTotalStake();

      // Redelegate ONLY NFT 0 from nodeA → nodeB.
      await NFT.connect(accounts[0]).redelegate(0, nodeB);

      // NFT 0 moved correctly.
      expect(await StakingStorage.getNodeStake(nodeA)).to.equal(0n);
      expect(await StakingStorage.getNodeStake(nodeB)).to.equal(amount);
      expect(
        await StakingStorage.getDelegatorStakeBase(nodeA, tokenIdKey(0)),
      ).to.equal(0n);
      expect(
        await StakingStorage.getDelegatorStakeBase(nodeB, tokenIdKey(0)),
      ).to.equal(amount);
      expect((await ConvictionStakingStorageContract.getPosition(0)).identityId).to.equal(nodeB);

      // NFT 1 on nodeC is completely untouched — different tokenId, different
      // node, different delegator key.
      expect(await StakingStorage.getNodeStake(nodeC)).to.equal(amount);
      expect(
        await StakingStorage.getDelegatorStakeBase(nodeC, tokenIdKey(1)),
      ).to.equal(amount);
      expect((await ConvictionStakingStorageContract.getPosition(1)).identityId).to.equal(nodeC);

      // Global totalStake invariant across the entire sequence (two mints,
      // one redelegate).
      expect(await StakingStorage.getTotalStake()).to.equal(totalBefore);
    });
  });

  // =====================================================================
  // createWithdrawal / cancelWithdrawal / finalizeWithdrawal
  // =====================================================================
  //
  // Phase 5 split-bucket withdrawal semantics:
  //   pre-expiry  : amount ≤ pos.rewards (only compounded rewards, raw locked)
  //   post-expiry : amount ≤ pos.raw + pos.rewards (full drain allowed)
  //
  // The 15-day delay timer is enforced regardless of lock state. Withdrawal
  // keys are stored under the V10-disjoint `bytes32(tokenId)` delegator key
  // in the same `StakingStorage.withdrawals` mapping the V8 path uses — no
  // collision because V8 uses `keccak256(address)`.
  //
  // Rewards injection for tests: SV10-claim isn't implemented yet, so we
  // simulate a claim by calling the hub-owner-privileged storage mutators
  // directly (`onlyContracts` permits the hub owner). We touch four
  // storage slots atomically so the test state remains internally
  // consistent with "what a future SV10-claim would leave":
  //
  //   1. ConvictionStakingStorage.increaseRewards(tokenId, amount)
  //        — updates pos.rewards + conviction-layer effective-stake diff.
  //   2. StakingStorage.increaseDelegatorStakeBase(id, bytes32(tokenId), amount)
  //        — the delegator base is the `raw + rewards` composite in
  //          StakingStorage post-claim; redelegate precedent in Phase 4
  //          writes `totalAmount = raw + rewards` to this slot.
  //   3. StakingStorage.increaseNodeStake(id, amount) +
  //      StakingStorage.increaseTotalStake(amount)
  //        — node- and global-level stake also track raw + rewards.
  //   4. Token.mint(StakingStorageAddress, amount)
  //        — top up the vault so finalizeWithdrawal's transferStake does
  //          not underflow on the rewards portion. A real claim would draw
  //          these tokens from the reward pool; the test shortcut is
  //          equivalent for the purposes of exercising the withdraw path.
  //
  // This helper is used only in the withdrawal describe blocks — other
  // blocks do not need rewards.

  const injectRewards = async (
    tokenId: bigint,
    identityId: number,
    amount: bigint,
  ) => {
    const stakingStorageAddr = await StakingStorage.getAddress();
    // Top up the vault so the later transferStake has enough TRAC.
    await Token.mint(stakingStorageAddr, amount);
    // Conviction-layer rewards bucket + diff.
    await ConvictionStakingStorageContract.connect(accounts[0]).increaseRewards(
      tokenId,
      amount,
    );
    // StakingStorage delegator base, node stake, total stake — mirrors the
    // state a hypothetical SV10-claim would leave behind.
    await StakingStorage.connect(accounts[0]).increaseDelegatorStakeBase(
      identityId,
      tokenIdKey(tokenId),
      amount,
    );
    await StakingStorage.connect(accounts[0]).increaseNodeStake(identityId, amount);
    await StakingStorage.connect(accounts[0]).increaseTotalStake(amount);
  };

  // WITHDRAWAL_DELAY is hardcoded at 15 days in StakingV10 (Phase 5 Q6).
  const WITHDRAWAL_DELAY_SECONDS = 15 * 24 * 60 * 60;

  // Pre-finalize helper — after a long `time.increase` crosses many Chronos
  // epochs, the next ConvictionStakingStorage mutator has to walk every
  // dirty-prefix epoch to catch `totalEffectiveStakeAtEpoch[e]` up to the
  // current cursor, and that linear loop blows past hardhat's per-tx
  // `gas: 15_000_000` cap for anything longer than ~40 epochs in the
  // dirty window. We break the walk into smaller chunks by calling the
  // external `finalizeEffectiveStakeUpTo` / `finalizeNodeEffectiveStakeUpTo`
  // entries as the hub owner (both `onlyContracts` permit the hub owner
  // via `HubDependent._checkHubContract`), so each call fits easily under
  // the cap. This is test-only scaffolding; the corresponding production
  // path during a real 15-day withdrawal would either amortize the work
  // across many mutator calls over the delay window or be kept cheap by
  // the unchanged `firstDirty`/`lastFinalizedEpoch` fast-paths in
  // `_finalizeEffectiveStakeUpTo`.
  const preFinalizeDormantEpochs = async (identityId: number) => {
    const currentEpoch = Number(await ChronosContract.getCurrentEpoch());
    const lastGlobal = Number(await ConvictionStakingStorageContract.getLastFinalizedEpoch());
    const lastNode = Number(
      await ConvictionStakingStorageContract.getNodeLastFinalizedEpoch(identityId),
    );
    const target = currentEpoch - 1;
    // Chunked walk — 50 epochs per call is well under the 15M cap.
    const chunkSize = 50;
    for (let e = lastGlobal + chunkSize; e <= target; e += chunkSize) {
      await ConvictionStakingStorageContract.connect(accounts[0]).finalizeEffectiveStakeUpTo(e);
    }
    if (lastGlobal < target) {
      await ConvictionStakingStorageContract.connect(accounts[0]).finalizeEffectiveStakeUpTo(
        target,
      );
    }
    for (let e = lastNode + chunkSize; e <= target; e += chunkSize) {
      await ConvictionStakingStorageContract.connect(accounts[0]).finalizeNodeEffectiveStakeUpTo(
        identityId,
        e,
      );
    }
    if (lastNode < target) {
      await ConvictionStakingStorageContract.connect(
        accounts[0],
      ).finalizeNodeEffectiveStakeUpTo(identityId, target);
    }
  };

  describe('createWithdrawal (→ StakingV10.createWithdrawal)', () => {
    it('reverts if not owner (non-owner caller)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2); // post-expiry so raw would otherwise be withdrawable
      // accounts[4] does not own tokenId 0 — wrapper-layer guard.
      await expect(
        NFT.connect(accounts[4]).createWithdrawal(0, 100n),
      ).to.be.revertedWithCustomError(NFT, 'NotPositionOwner');
    });

    it('reverts on amount == 0 at the NFT wrapper layer', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await expect(
        NFT.connect(accounts[0]).createWithdrawal(0, 0),
      ).to.be.revertedWithCustomError(NFT, 'ZeroAmount');
    });

    it('reverts pre-expiry when amount > rewards (rewards bucket empty)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      // Pre-expiry (12-epoch lock still active). Rewards bucket is empty
      // since SV10-claim has not run. Withdrawable = 0; any positive
      // amount trips InsufficientWithdrawable.
      await expect(
        NFT.connect(accounts[0]).createWithdrawal(0, 1n),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'InsufficientWithdrawable');
    });

    it('reverts post-expiry when amount > raw + rewards', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2); // post-expiry
      // raw=1000 TRAC, rewards=0 → withdrawable=1000. 1001 is one wei too many.
      await expect(
        NFT.connect(accounts[0]).createWithdrawal(0, amount + 1n),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'InsufficientWithdrawable');
    });

    it('reverts if withdrawal already requested', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await NFT.connect(accounts[0]).createWithdrawal(0, 100n);
      // Second request on the same tokenId fails — one pending at a time.
      await expect(
        NFT.connect(accounts[0]).createWithdrawal(0, 50n),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'WithdrawalAlreadyRequested');
    });

    it('happy path pre-expiry: withdraws from rewards bucket only (raw still locked)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // Inject 500 rewards — SV10-claim proxy. Raw is still locked
      // (12-epoch lock untouched) but the rewards bucket is now drainable.
      const rewards = hre.ethers.parseEther('500');
      await injectRewards(0n, identityId, rewards);

      const tx = await NFT.connect(accounts[0]).createWithdrawal(0, rewards);
      const blockNumber = (await tx.wait())!.blockNumber;
      const block = await hre.ethers.provider.getBlock(blockNumber);
      const expectedReleaseAt = BigInt(block!.timestamp) + BigInt(WITHDRAWAL_DELAY_SECONDS);

      await expect(tx)
        .to.emit(StakingV10Contract, 'WithdrawalCreated')
        .withArgs(0n, rewards, expectedReleaseAt);

      // Withdrawal is recorded under the V10 delegator key.
      const [reqAmount, indexedOut, releaseAt] =
        await StakingStorage.getDelegatorWithdrawalRequest(identityId, tokenIdKey(0));
      expect(reqAmount).to.equal(rewards);
      expect(indexedOut).to.equal(0n);
      expect(releaseAt).to.equal(expectedReleaseAt);
    });

    it('happy path post-expiry: withdraws from raw (rewards bucket empty)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2); // post-expiry → raw is withdrawable

      const tx = await NFT.connect(accounts[0]).createWithdrawal(0, amount);
      await expect(tx).to.emit(StakingV10Contract, 'WithdrawalCreated');

      const [reqAmount] = await StakingStorage.getDelegatorWithdrawalRequest(
        identityId,
        tokenIdKey(0),
      );
      expect(reqAmount).to.equal(amount);
    });

    it('happy path post-expiry: full drain amount = raw + rewards', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      // Inject 300 rewards before expiry — simulates a claim landing
      // during the lock period (the rewards earn 1x, raw earns multiplier).
      const rewards = hre.ethers.parseEther('300');
      await injectRewards(0n, identityId, rewards);

      await advanceEpochs(2); // post-expiry
      const total = amount + rewards;
      const tx = await NFT.connect(accounts[0]).createWithdrawal(0, total);
      await expect(tx).to.emit(StakingV10Contract, 'WithdrawalCreated');

      const [reqAmount] = await StakingStorage.getDelegatorWithdrawalRequest(
        identityId,
        tokenIdKey(0),
      );
      expect(reqAmount).to.equal(total);
    });

    it('direct StakingV10.createWithdrawal call from non-NFT caller reverts via gate', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await expect(
        StakingV10Contract.connect(accounts[0]).createWithdrawal(
          accounts[0].address,
          0,
          100n,
        ),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });
  });

  describe('cancelWithdrawal (→ StakingV10.cancelWithdrawal)', () => {
    it('reverts if not owner (non-owner caller)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await NFT.connect(accounts[0]).createWithdrawal(0, 100n);
      await expect(
        NFT.connect(accounts[4]).cancelWithdrawal(0),
      ).to.be.revertedWithCustomError(NFT, 'NotPositionOwner');
    });

    it('reverts if no withdrawal was requested', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await expect(
        NFT.connect(accounts[0]).cancelWithdrawal(0),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'WithdrawalNotRequested');
    });

    it('happy path: clears pending request and emits WithdrawalCancelled', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await NFT.connect(accounts[0]).createWithdrawal(0, 100n);

      const tx = await NFT.connect(accounts[0]).cancelWithdrawal(0);
      await expect(tx).to.emit(StakingV10Contract, 'WithdrawalCancelled').withArgs(0n);
      await expect(tx).to.emit(NFT, 'WithdrawalCancelled').withArgs(0n);

      const [reqAmount] = await StakingStorage.getDelegatorWithdrawalRequest(
        identityId,
        tokenIdKey(0),
      );
      expect(reqAmount).to.equal(0n);
    });

    it('happy path: cancel allows a new withdrawal to be requested', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);

      await NFT.connect(accounts[0]).createWithdrawal(0, 100n);
      await NFT.connect(accounts[0]).cancelWithdrawal(0);
      // A fresh request with a different amount succeeds now that the
      // WithdrawalAlreadyRequested guard is cleared.
      await NFT.connect(accounts[0]).createWithdrawal(0, 200n);
      const [reqAmount] = await StakingStorage.getDelegatorWithdrawalRequest(
        identityId,
        tokenIdKey(0),
      );
      expect(reqAmount).to.equal(200n);
    });

    it('direct StakingV10.cancelWithdrawal call from non-NFT caller reverts via gate', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await NFT.connect(accounts[0]).createWithdrawal(0, 100n);
      await expect(
        StakingV10Contract.connect(accounts[0]).cancelWithdrawal(accounts[0].address, 0),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });
  });

  describe('finalizeWithdrawal (→ StakingV10.finalizeWithdrawal)', () => {
    it('reverts if not owner (non-owner caller)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await NFT.connect(accounts[0]).createWithdrawal(0, 100n);
      await time.increase(WITHDRAWAL_DELAY_SECONDS + 1);
      await expect(
        NFT.connect(accounts[4]).finalizeWithdrawal(0),
      ).to.be.revertedWithCustomError(NFT, 'NotPositionOwner');
    });

    it('reverts if no withdrawal was requested', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await expect(
        NFT.connect(accounts[0]).finalizeWithdrawal(0),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'WithdrawalNotRequested');
    });

    it('reverts if delay not elapsed (14 days is not enough)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await NFT.connect(accounts[0]).createWithdrawal(0, 100n);
      // 14 days is one day short of the 15-day delay.
      await time.increase(14 * 24 * 60 * 60);
      await expect(
        NFT.connect(accounts[0]).finalizeWithdrawal(0),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'WithdrawalDelayPending');
    });

    it('happy path partial raw withdrawal post-expiry: TRAC refunded, stake decremented, NFT alive', async () => {
      const { identityId } = await createProfile();
      const minStake = await ParametersStorage.minimumStake();
      // Use minStake so the node enters the sharding table, then partially
      // withdraw so nodeStake stays above minStake → sharding stays put.
      const amount = minStake * 2n;
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2); // post-expiry

      const withdrawAmount = minStake / 2n;
      await NFT.connect(accounts[0]).createWithdrawal(0, withdrawAmount);
      await time.increase(WITHDRAWAL_DELAY_SECONDS + 1);
      // Crossing the 15-day delay advances Chronos by ~360 epochs; pre-
      // finalize the dormant window so `decreaseRaw`'s in-mutator
      // finalize is O(1) instead of gas-bombing past the tx cap.
      await preFinalizeDormantEpochs(identityId);

      const stakerBalBefore = await Token.balanceOf(accounts[0].address);
      const totalStakeBefore = await StakingStorage.getTotalStake();
      const nodeStakeBefore = await StakingStorage.getNodeStake(identityId);

      const tx = await NFT.connect(accounts[0]).finalizeWithdrawal(0);
      await expect(tx)
        .to.emit(StakingV10Contract, 'WithdrawalFinalized')
        .withArgs(0n, withdrawAmount, 0n);

      // TRAC returned to staker.
      expect(await Token.balanceOf(accounts[0].address)).to.equal(
        stakerBalBefore + withdrawAmount,
      );

      // Totals decremented.
      expect(await StakingStorage.getTotalStake()).to.equal(
        totalStakeBefore - withdrawAmount,
      );
      expect(await StakingStorage.getNodeStake(identityId)).to.equal(
        nodeStakeBefore - withdrawAmount,
      );

      // Delegator base: (raw+rewards) - withdrawn = amount - withdrawAmount.
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(0)),
      ).to.equal(amount - withdrawAmount);

      // Position mutated: raw drained by withdrawAmount (rewards bucket was empty).
      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.raw).to.equal(amount - withdrawAmount);
      expect(pos.rewards).to.equal(0n);
      // identityId preserved → position is still considered "existing".
      expect(pos.identityId).to.equal(identityId);

      // NFT still alive (partial drain).
      expect(await NFT.ownerOf(0)).to.equal(accounts[0].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);

      // Withdrawal request cleared.
      const [reqAmount] = await StakingStorage.getDelegatorWithdrawalRequest(
        identityId,
        tokenIdKey(0),
      );
      expect(reqAmount).to.equal(0n);
    });

    it('happy path full drain post-expiry: NFT is burned, sharding table node removed', async () => {
      const { identityId } = await createProfile();
      const minStake = await ParametersStorage.minimumStake();
      // Fund exactly minStake so a full drain drops nodeStake to 0 < minStake.
      await mintAndApprove(accounts[0], minStake);
      await NFT.connect(accounts[0]).createConviction(identityId, minStake, 1);

      const ShardingTableStorage = await hre.ethers.getContract<
        import('../../typechain').ShardingTableStorage
      >('ShardingTableStorage');
      // Node was inserted at stake time (raw = minStake).
      expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(true);

      await advanceEpochs(2); // post-expiry
      await NFT.connect(accounts[0]).createWithdrawal(0, minStake);
      await time.increase(WITHDRAWAL_DELAY_SECONDS + 1);
      await preFinalizeDormantEpochs(identityId);

      await NFT.connect(accounts[0]).finalizeWithdrawal(0);

      // NFT burned → ownerOf reverts with ERC721NonexistentToken.
      await expect(NFT.ownerOf(0)).to.be.revertedWithCustomError(
        NFT,
        'ERC721NonexistentToken',
      );
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(0n);

      // Node stake drained.
      expect(await StakingStorage.getNodeStake(identityId)).to.equal(0n);
      // Sharding table: node dropped below minStake → removed.
      expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(false);
    });

    it('happy path rewards-first draw pre-expiry: amount ≤ rewards drains rewards only, raw untouched', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const rewards = hre.ethers.parseEther('500');
      await injectRewards(0n, identityId, rewards);

      // Pre-expiry (12 epoch lock) — only rewards bucket is drainable.
      const withdrawAmount = hre.ethers.parseEther('200');
      await NFT.connect(accounts[0]).createWithdrawal(0, withdrawAmount);
      await time.increase(WITHDRAWAL_DELAY_SECONDS + 1);
      await preFinalizeDormantEpochs(identityId);

      const stakerBalBefore = await Token.balanceOf(accounts[0].address);
      const tx = await NFT.connect(accounts[0]).finalizeWithdrawal(0);
      // rewardsDraw = 200, rawDraw = 0
      await expect(tx)
        .to.emit(StakingV10Contract, 'WithdrawalFinalized')
        .withArgs(0n, 0n, withdrawAmount);

      expect(await Token.balanceOf(accounts[0].address)).to.equal(
        stakerBalBefore + withdrawAmount,
      );

      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.raw).to.equal(amount); // raw untouched, lock still active
      expect(pos.rewards).to.equal(rewards - withdrawAmount);

      // NFT still alive — position has raw > 0.
      expect(await NFT.ownerOf(0)).to.equal(accounts[0].address);
    });

    it('happy path split draw post-expiry: amount > rewards drains rewards fully + raw for remainder', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      // Inject rewards before expiry — they earn 1x, raw earns its multiplier.
      const rewards = hre.ethers.parseEther('300');
      await injectRewards(0n, identityId, rewards);

      await advanceEpochs(2); // post-expiry

      // Withdraw more than rewards: rewards drained fully (300) +
      // raw drained for the remainder (200). Total = 500.
      const withdrawAmount = hre.ethers.parseEther('500');
      await NFT.connect(accounts[0]).createWithdrawal(0, withdrawAmount);
      await time.increase(WITHDRAWAL_DELAY_SECONDS + 1);
      await preFinalizeDormantEpochs(identityId);

      const tx = await NFT.connect(accounts[0]).finalizeWithdrawal(0);

      // Split: rawDraw = 500 - 300 = 200, rewardsDraw = 300.
      await expect(tx)
        .to.emit(StakingV10Contract, 'WithdrawalFinalized')
        .withArgs(0n, hre.ethers.parseEther('200'), rewards);

      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.raw).to.equal(amount - hre.ethers.parseEther('200')); // 800 left
      expect(pos.rewards).to.equal(0n);

      expect(await NFT.ownerOf(0)).to.equal(accounts[0].address);
    });

    it('direct StakingV10.finalizeWithdrawal call from non-NFT caller reverts via gate', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await NFT.connect(accounts[0]).createWithdrawal(0, 100n);
      await time.increase(WITHDRAWAL_DELAY_SECONDS + 1);
      await expect(
        StakingV10Contract.connect(accounts[0]).finalizeWithdrawal(accounts[0].address, 0),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });
  });

  // =====================================================================
  // claim (→ StakingV10.claim) — Phase 5 auto-compound
  // =====================================================================
  //
  // StakingV10.claim walks `[pos.lastClaimedEpoch + 1 .. currentEpoch - 1]`,
  // computes per-epoch effective stake (multiplier pre-expiry, flat post-
  // expiry, plus rewardsSnapshot always at 1x), multiplies by the
  // per-epoch `nodeEpochScorePerStake` (stored by `RandomSamplingStorage`
  // at 1e36 scale), divides by 1e18 to match the V8 `_prepareForStakeChange`
  // dimensional output (`scoreEarned18 = stakeBase * scorePerStakeDiff36 /
  // SCALE18`), and banks the sum into `pos.rewards` via
  // `ConvictionStakingStorage.increaseRewards`.
  //
  // **Stub semantics:** Phase 5 treats the score-weighted stake product as
  // the reward TRAC amount. Phase 11 replaces the formula with the actual
  // Paymaster-sourced `epochPool * nodeScore18 / allNodesScore18` flow.
  // Tests inject `nodeEpochScorePerStake` via the hub-owner-privileged
  // setter (`onlyContracts` admits `hub.owner()`) and pre-fund the
  // StakingStorage vault with TRAC matching the expected reward so the
  // node-stake bookkeeping stays sound across a downstream withdrawal.
  //
  // No-op contract: a fresh position has `lastClaimedEpoch = currentEpoch
  // - 1`, so claim on the same epoch returns without emitting. A claim
  // that walks a window with zero injected scorePerStake still advances
  // `lastClaimedEpoch` (so future calls don't redo the walk) but does NOT
  // emit `RewardsClaimed`.

  describe('claim (→ StakingV10.claim)', () => {
    // Helper — inject `nodeEpochScorePerStake36` at a specific epoch via the
    // hub-owner-privileged setter. This simulates the `RandomSampling`
    // contract's per-proof accrual that would populate the slot on mainnet.
    const injectScorePerStake = async (
      epoch: number | bigint,
      identityId: number,
      scorePerStake36: bigint,
    ) => {
      const RandomSamplingStorageContract = await hre.ethers.getContract<RandomSamplingStorage>(
        'RandomSamplingStorage',
      );
      await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScorePerStake(
        epoch,
        identityId,
        scorePerStake36,
      );
    };

    // Helper — pre-fund the StakingStorage vault with `amount` TRAC so the
    // post-claim node-stake bookkeeping matches the on-chain vault balance.
    // On mainnet this TRAC flows in from Phase 11's reward distribution path.
    const fundVault = async (amount: bigint) => {
      const stakingStorageAddr = await StakingStorage.getAddress();
      await Token.mint(stakingStorageAddr, amount);
    };

    // Helper — compute expected reward for a single epoch using the
    // Phase 5 stub formula. Matches `StakingV10.claim`'s inner loop
    // exactly: `reward = effStake * scorePerStake36 / 1e18`.
    const computeReward = (effStake: bigint, scorePerStake36: bigint): bigint => {
      return (effStake * scorePerStake36) / SCALE18;
    };

    // -----------------------------------------------------------------
    // Revert / gate paths
    // -----------------------------------------------------------------

    it('reverts if not owner (non-owner caller)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      // `accounts[4]` does not own tokenId 0 — wrapper-layer guard.
      await expect(NFT.connect(accounts[4]).claim(0)).to.be.revertedWithCustomError(
        NFT,
        'NotPositionOwner',
      );
    });

    it('direct StakingV10.claim call from non-NFT caller reverts via gate', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      await expect(
        StakingV10Contract.connect(accounts[0]).claim(accounts[0].address, 0),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });

    // -----------------------------------------------------------------
    // No-op paths
    // -----------------------------------------------------------------

    it('no-op: fresh position claim in the same epoch as creation', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // `lastClaimedEpoch = currentEpoch - 1` at createPosition, so the
      // claim window `[last+1 .. current-1]` is empty. Claim must return
      // without emitting or mutating state.
      const posBefore = await ConvictionStakingStorageContract.getPosition(0);
      const nodeStakeBefore = await StakingStorage.getNodeStake(identityId);
      const totalStakeBefore = await StakingStorage.getTotalStake();
      const baseBefore = await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(0));

      const tx = await NFT.connect(accounts[0]).claim(0);
      await expect(tx).to.not.emit(StakingV10Contract, 'RewardsClaimed');

      const posAfter = await ConvictionStakingStorageContract.getPosition(0);
      expect(posAfter.rewards).to.equal(posBefore.rewards);
      expect(posAfter.raw).to.equal(posBefore.raw);
      expect(posAfter.lastClaimedEpoch).to.equal(posBefore.lastClaimedEpoch);
      expect(await StakingStorage.getNodeStake(identityId)).to.equal(nodeStakeBefore);
      expect(await StakingStorage.getTotalStake()).to.equal(totalStakeBefore);
      expect(await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(0))).to.equal(
        baseBefore,
      );
    });

    it('no-op: zero scorePerStake across the walked window advances lastClaimedEpoch but emits nothing', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      await advanceEpochs(1);

      const nodeStakeBefore = await StakingStorage.getNodeStake(identityId);
      const totalStakeBefore = await StakingStorage.getTotalStake();

      // No score injection → scorePerStake = 0 for the walked epoch → reward = 0.
      // Claim still advances lastClaimedEpoch but emits no RewardsClaimed.
      const tx = await NFT.connect(accounts[0]).claim(0);
      await expect(tx).to.not.emit(StakingV10Contract, 'RewardsClaimed');

      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.rewards).to.equal(0n);
      // lastClaimedEpoch was advanced to currentEpoch - 1 so re-claim is a no-op.
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      expect(pos.lastClaimedEpoch).to.equal(currentEpoch - 1n);
      // Totals unchanged.
      expect(await StakingStorage.getNodeStake(identityId)).to.equal(nodeStakeBefore);
      expect(await StakingStorage.getTotalStake()).to.equal(totalStakeBefore);
    });

    // -----------------------------------------------------------------
    // Happy paths — reward accumulation
    // -----------------------------------------------------------------

    it('single-epoch happy path: one epoch of score, claim compounds into rewards bucket', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // Remember the creation epoch: fresh position has lastClaimedEpoch =
      // creationEpoch - 1, so after advancing N epochs the claim window is
      // `[creationEpoch .. currentEpoch - 1]` (length N).
      const creationEpoch = await ChronosContract.getCurrentEpoch();
      await advanceEpochs(1);
      const walkEpoch = creationEpoch; // first epoch in the claim window

      // Pre-expiry, 12-epoch lock, multiplier = 6x.
      //   effStake = raw * 6 (rewardsSnapshot = 0)
      //   reward = effStake * scorePerStake36 / 1e18
      const scorePerStake36 = hre.ethers.parseEther('0.001'); // 1e15 (a modest score rate)
      await injectScorePerStake(walkEpoch, identityId, scorePerStake36);

      const effStake = (amount * SIX_X) / SCALE18;
      const expectedReward = computeReward(effStake, scorePerStake36);
      await fundVault(expectedReward);

      const nodeStakeBefore = await StakingStorage.getNodeStake(identityId);
      const totalStakeBefore = await StakingStorage.getTotalStake();
      const baseBefore = await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(0));

      const tx = await NFT.connect(accounts[0]).claim(0);
      await expect(tx)
        .to.emit(StakingV10Contract, 'RewardsClaimed')
        .withArgs(0n, expectedReward);

      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.rewards).to.equal(expectedReward);
      expect(pos.raw).to.equal(amount); // raw unchanged
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      expect(pos.lastClaimedEpoch).to.equal(currentEpoch - 1n);

      // StakingStorage bookkeeping: base = raw + rewards_new, node + total += reward.
      expect(await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(0))).to.equal(
        baseBefore + expectedReward,
      );
      expect(await StakingStorage.getNodeStake(identityId)).to.equal(
        nodeStakeBefore + expectedReward,
      );
      expect(await StakingStorage.getTotalStake()).to.equal(totalStakeBefore + expectedReward);
    });

    it('multi-epoch happy path: three epochs of distinct scores, claim sums cumulatively', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      // Advance 3 full epochs; walk window = [creationEpoch .. creationEpoch + 2] (3 epochs).
      await advanceEpochs(3);

      // Pre-expiry throughout (12-epoch lock), so effStake = raw*6 for all three.
      const s0 = hre.ethers.parseEther('0.001'); // 1e15
      const s1 = hre.ethers.parseEther('0.002'); // 2e15
      const s2 = hre.ethers.parseEther('0.003'); // 3e15
      await injectScorePerStake(creationEpoch, identityId, s0);
      await injectScorePerStake(creationEpoch + 1n, identityId, s1);
      await injectScorePerStake(creationEpoch + 2n, identityId, s2);

      const effStake = (amount * SIX_X) / SCALE18;
      const expectedReward = computeReward(effStake, s0 + s1 + s2);
      await fundVault(expectedReward);

      const tx = await NFT.connect(accounts[0]).claim(0);
      await expect(tx)
        .to.emit(StakingV10Contract, 'RewardsClaimed')
        .withArgs(0n, expectedReward);

      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.rewards).to.equal(expectedReward);
    });

    it('pre-expiry multiplier applied: 6x multiplier on a 12-epoch lock', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      await advanceEpochs(1);
      const scorePerStake36 = hre.ethers.parseEther('0.01'); // 1e16
      await injectScorePerStake(creationEpoch, identityId, scorePerStake36);

      // effStake = raw * 6x (still pre-expiry since expiryEpoch = creation+12)
      const effStake = (amount * SIX_X) / SCALE18;
      const expectedReward = computeReward(effStake, scorePerStake36);
      await fundVault(expectedReward);

      // Compare against a hypothetical 1x position: same scorePerStake should
      // produce 6x the reward of a rest-tier position. Rather than deploy two
      // positions, we verify the computeReward shape directly: expectedReward
      // should equal 6 * (raw * score / 1e18).
      const baselineReward = computeReward(amount, scorePerStake36); // 1x effective
      expect(expectedReward).to.equal(baselineReward * 6n);

      await NFT.connect(accounts[0]).claim(0);
      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.rewards).to.equal(expectedReward);
    });

    it('post-expiry 1x downgrade: claim across an epoch where lock has already expired', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      // 1-epoch lock → expiryEpoch = creationEpoch + 1. Advance 3 epochs so the
      // claim window covers creationEpoch (pre-expiry) AND creationEpoch+1,+2
      // (post-expiry). Inject distinct scores to verify per-epoch math.
      await advanceEpochs(3);

      // Only inject on one post-expiry epoch so the expected reward is
      // unambiguously the 1x rate.
      const postExpiryEpoch = creationEpoch + 2n; // strictly > expiryEpoch=creation+1
      const scorePerStake36 = hre.ethers.parseEther('0.01');
      await injectScorePerStake(postExpiryEpoch, identityId, scorePerStake36);

      // effStake_post = raw (no multiplier after expiry)
      const expectedReward = computeReward(amount, scorePerStake36);
      await fundVault(expectedReward);

      await NFT.connect(accounts[0]).claim(0);
      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.rewards).to.equal(expectedReward);
    });

    it('multiplier + post-expiry split: two epochs, first boosted, second flat', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      // 1-epoch lock → expiryEpoch = creationEpoch + 1. With advanceEpochs(3):
      //   - claim window = [creationEpoch .. creationEpoch + 2]
      //   - pre-expiry: epoch == creationEpoch (strict < expiryEpoch)
      //   - post-expiry: creationEpoch + 1, creationEpoch + 2 (>= expiryEpoch)
      await advanceEpochs(3);
      const scorePre = hre.ethers.parseEther('0.01');
      const scorePost = hre.ethers.parseEther('0.02');
      await injectScorePerStake(creationEpoch, identityId, scorePre); // pre-expiry
      await injectScorePerStake(creationEpoch + 2n, identityId, scorePost); // post-expiry

      // Pre-expiry epoch earns at 1.5x; post-expiry epoch at 1x.
      const effStakePre = (amount * ONE_AND_HALF_X) / SCALE18;
      const effStakePost = amount;
      const expectedReward =
        computeReward(effStakePre, scorePre) + computeReward(effStakePost, scorePost);
      await fundVault(expectedReward);

      const tx = await NFT.connect(accounts[0]).claim(0);
      await expect(tx)
        .to.emit(StakingV10Contract, 'RewardsClaimed')
        .withArgs(0n, expectedReward);

      const pos = await ConvictionStakingStorageContract.getPosition(0);
      expect(pos.rewards).to.equal(expectedReward);
    });

    // -----------------------------------------------------------------
    // Idempotence
    // -----------------------------------------------------------------

    it('multi-claim idempotence: second claim in the same epoch is a no-op', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      await advanceEpochs(1);
      const scorePerStake36 = hre.ethers.parseEther('0.001');
      await injectScorePerStake(creationEpoch, identityId, scorePerStake36);

      const effStake = (amount * SIX_X) / SCALE18;
      const expectedReward = computeReward(effStake, scorePerStake36);
      await fundVault(expectedReward);

      // First claim — pays out expected reward.
      await NFT.connect(accounts[0]).claim(0);
      const posAfterFirst = await ConvictionStakingStorageContract.getPosition(0);
      expect(posAfterFirst.rewards).to.equal(expectedReward);

      // Second claim — no-op (same epoch, lastClaimedEpoch already caught up).
      const tx = await NFT.connect(accounts[0]).claim(0);
      await expect(tx).to.not.emit(StakingV10Contract, 'RewardsClaimed');

      const posAfterSecond = await ConvictionStakingStorageContract.getPosition(0);
      expect(posAfterSecond.rewards).to.equal(posAfterFirst.rewards);
    });

    // -----------------------------------------------------------------
    // Integration — claim then withdraw the claimed rewards
    // -----------------------------------------------------------------

    it('claim + withdraw integration: claim into rewards, withdraw rewards, TRAC reaches user', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      await advanceEpochs(1);
      const scorePerStake36 = hre.ethers.parseEther('0.001');
      await injectScorePerStake(creationEpoch, identityId, scorePerStake36);

      const effStake = (amount * SIX_X) / SCALE18;
      const expectedReward = computeReward(effStake, scorePerStake36);
      await fundVault(expectedReward);

      // 1. Claim — banks reward into pos.rewards + delegator/node/total.
      await NFT.connect(accounts[0]).claim(0);
      const posAfterClaim = await ConvictionStakingStorageContract.getPosition(0);
      expect(posAfterClaim.rewards).to.equal(expectedReward);

      // 2. createWithdrawal — pre-expiry, can only drain rewards.
      await NFT.connect(accounts[0]).createWithdrawal(0, expectedReward);
      // 3. Wait out the 15-day delay + pre-finalize the dormant window.
      await time.increase(WITHDRAWAL_DELAY_SECONDS + 1);
      await preFinalizeDormantEpochs(identityId);

      const stakerBalBefore = await Token.balanceOf(accounts[0].address);

      // 4. finalizeWithdrawal — TRAC returned to staker.
      const tx = await NFT.connect(accounts[0]).finalizeWithdrawal(0);
      await expect(tx)
        .to.emit(StakingV10Contract, 'WithdrawalFinalized')
        .withArgs(0n, 0n, expectedReward); // rawDraw=0, rewardsDraw=expectedReward

      expect(await Token.balanceOf(accounts[0].address)).to.equal(
        stakerBalBefore + expectedReward,
      );

      // Position still alive (raw > 0), rewards drained to 0.
      const posFinal = await ConvictionStakingStorageContract.getPosition(0);
      expect(posFinal.raw).to.equal(amount);
      expect(posFinal.rewards).to.equal(0n);
      expect(await NFT.ownerOf(0)).to.equal(accounts[0].address);
    });
  });
});
