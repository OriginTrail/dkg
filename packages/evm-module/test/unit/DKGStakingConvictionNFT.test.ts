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
});
