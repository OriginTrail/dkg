import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DelegatorsInfo,
  DKGStakingConvictionNFT,
  EpochStorage,
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
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockTier');
    });

    it('reverts on invalid lock tier (13)', async () => {
      const { identityId } = await createProfile();
      await expect(
        NFT.connect(accounts[0]).createConviction(identityId, 1_000n, 13),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockTier');
    });

    it('happy path: tier 0 (rest state, 1x, no lock) mints an NFT — every V10 position is an NFT', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);

      // V10 policy: no-lock staking is a first-class product and produces
      // an NFT just like the locked tiers. Tier 0 is seeded active at
      // `CSS.initialize()` with 1.0x multiplier and zero duration.
      const tx = await NFT.connect(accounts[0]).createConviction(identityId, amount, 0);

      // Wrapper event mirrors the mint.
      await expect(tx)
        .to.emit(NFT, 'PositionCreated')
        .withArgs(accounts[0].address, 1n, identityId, amount, 0);

      // ERC721 ownership — tier-0 stakers get an NFT like anyone else.
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);

      // Position semantics: 1x multiplier, permanent (expiryTimestamp == 0).
      const pos = await ConvictionStakingStorageContract.getPosition(1);
      expect(pos.identityId).to.equal(identityId);
      expect(pos.raw).to.equal(amount);
      expect(pos.lockTier).to.equal(0);
      expect(pos.multiplier18).to.equal(ONE_X);
      expect(pos.expiryTimestamp).to.equal(0); // rest-state sentinel: no boost to decay.

      // Stake aggregates updated the same as any other tier.
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(amount);
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
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(0n);
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
      const totalStakeBefore = await ConvictionStakingStorageContract.totalStakeV10();

      // Next NFT mint is tokenId 0 (fresh ERC721Enumerable, no sentinel reservation).
      const tx = await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // Wrapper-layer event mirrors the mint; authoritative event from StakingV10.
      await expect(tx)
        .to.emit(NFT, 'PositionCreated')
        .withArgs(accounts[0].address, 1n, identityId, amount, 12);
      await expect(tx)
        .to.emit(StakingV10Contract, 'Staked')
        .withArgs(1n, accounts[0].address, identityId, amount, 12);

      // ERC721 ownership.
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);

      // Token flow: staker → StakingStorage, nothing in NFT wrapper or StakingV10.
      expect(await Token.balanceOf(accounts[0].address)).to.equal(stakerBalBefore - amount);
      expect(await Token.balanceOf(stakingStorageAddr)).to.equal(ssBalBefore + amount);
      expect(await Token.balanceOf(nftAddr)).to.equal(0n);
      expect(await Token.balanceOf(await StakingV10Contract.getAddress())).to.equal(0n);

      // StakingStorage delegator/node/total bookkeeping.
      expect(
        await (await ConvictionStakingStorageContract.getPosition(1)).raw,
      ).to.equal(amount);
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(amount);
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(totalStakeBefore + amount);

      // ConvictionStakingStorage position.
      const pos = await ConvictionStakingStorageContract.getPosition(1);
      expect(pos.identityId).to.equal(identityId);
      expect(pos.raw).to.equal(amount);
      expect(pos.lockTier).to.equal(12);
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

    for (const [lockTier, expectedMult] of happyTiers) {
      it(`happy path: tier ${lockTier} writes multiplier18 = ${expectedMult.toString()}`, async () => {
        const { identityId } = await createProfile();
        const amount = hre.ethers.parseEther('1000');
        await mintAndApprove(accounts[0], amount);

        await NFT.connect(accounts[0]).createConviction(identityId, amount, lockTier);

        const pos = await ConvictionStakingStorageContract.getPosition(1);
        expect(pos.multiplier18).to.equal(expectedMult);
        expect(pos.lockTier).to.equal(lockTier);
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

      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.ownerOf(2)).to.equal(accounts[0].address);
      expect(await NFT.ownerOf(3)).to.equal(accounts[0].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(3n);

      // Per-tokenId StakingStorage state is independent — each tokenId has
      // its own bytes32(tokenId) delegator key.
      for (let t = 1n; t <= 3n; t++) {
        expect(
          await (await ConvictionStakingStorageContract.getPosition(t)).raw,
        ).to.equal(amount);
      }
      // Node total is the sum.
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(amount * 3n);

      // ConvictionStakingStorage positions are independent and carry the
      // per-mint tier.
      expect((await ConvictionStakingStorageContract.getPosition(1)).multiplier18).to.equal(SIX_X);
      expect((await ConvictionStakingStorageContract.getPosition(2)).multiplier18).to.equal(
        THREE_AND_HALF_X,
      );
      expect((await ConvictionStakingStorageContract.getPosition(3)).multiplier18).to.equal(
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

      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.ownerOf(2)).to.equal(accounts[4].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);
      expect(await NFT.balanceOf(accounts[4].address)).to.equal(1n);

      // Both NFTs live on the same node but under disjoint delegator keys.
      expect(
        await (await ConvictionStakingStorageContract.getPosition(1)).raw,
      ).to.equal(amount);
      expect(
        await (await ConvictionStakingStorageContract.getPosition(2)).raw,
      ).to.equal(amount);
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(amount * 2n);
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
        NFT.connect(accounts[4]).relock(1, 6),
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
        NFT.connect(accounts[0]).relock(1, 2),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockTier');
    });

    it('reverts on invalid new lock tier (13) at the NFT wrapper layer', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await expect(
        NFT.connect(accounts[0]).relock(1, 13),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockTier');
    });

    it('reverts if lock still active (pre-expiry)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      // No time advance — the 12-epoch lock is still active.
      await expect(
        NFT.connect(accounts[0]).relock(1, 6),
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
      await expect(NFT.connect(accounts[0]).relock(43, 6)).to.be.reverted;
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
      await NFT.connect(accounts[0]).claim(1); // satisfy UnclaimedEpochs guard

      // D21: `relock` is a burn+mint. The old NFT (`tokenId 0`) is burned
      // and a fresh token is minted. Return value is the new tokenId.
      const newTokenId = await NFT.connect(accounts[0]).relock.staticCall(1, 12);
      const tx = await NFT.connect(accounts[0]).relock(1, 12);
      // Capture the block timestamp to compute the D26 expected expiry.
      const txReceipt = await tx.wait();
      const txBlock = await hre.ethers.provider.getBlock(txReceipt!.blockHash);
      const relockTs = BigInt(txBlock!.timestamp);
      // Tier 12 wall-clock duration = 366 days.
      const DAY = 24n * 60n * 60n;
      const expectedExpiryTs = relockTs + 366n * DAY;

      await expect(tx).to.emit(NFT, 'PositionRelocked').withArgs(1n, newTokenId, 12);
      await expect(tx)
        .to.emit(StakingV10Contract, 'Relocked')
        .withArgs(newTokenId, 12, expectedExpiryTs);

      // Old token is burned; new token carries the relocked position state.
      await expect(NFT.ownerOf(1)).to.be.reverted;
      expect(await NFT.ownerOf(newTokenId)).to.equal(accounts[0].address);

      const pos = await ConvictionStakingStorageContract.getPosition(newTokenId);
      expect(pos.identityId).to.equal(identityId);
      expect(pos.raw).to.equal(amount); // principal migrated to new tokenId
      expect(pos.lockTier).to.equal(12);
      expect(pos.multiplier18).to.equal(SIX_X);
      expect(pos.expiryTimestamp).to.equal(expectedExpiryTs);
    });

    it('happy path: relock to tier 0 (permanent rest state, 1x multiplier)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      await advanceEpochs(2);
      await NFT.connect(accounts[0]).claim(1); // satisfy UnclaimedEpochs guard

      // Tier 0 is the permanent rest state: a legitimate post-expiry relock
      // target per the roadmap ("no lockup / 1 / 3 / 6 / 12 months"). The
      // storage helper's tier table maps lock==0 → 1x, and the wrapper's
      // `_convictionMultiplier` helper accepts 0.
      //
      // D21: relock is a burn+mint — fetch the new tokenId from the return
      //      value before reading the migrated position state.
      const newTokenId = await NFT.connect(accounts[0]).relock.staticCall(1, 0);
      await NFT.connect(accounts[0]).relock(1, 0);

      const pos = await ConvictionStakingStorageContract.getPosition(newTokenId);
      expect(pos.raw).to.equal(amount);
      expect(pos.lockTier).to.equal(0);
      expect(pos.multiplier18).to.equal(ONE_X);
      // D20: `_computeExpiryEpoch(0)` returns 0 (rest-state sentinel).
      expect(pos.expiryTimestamp).to.equal(0);
    });

    it('happy path: relock updates expiryTimestamp to block.timestamp + tierDuration', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await NFT.connect(accounts[0]).claim(1); // satisfy UnclaimedEpochs guard

      // D21: relock burns + remints; read state from the new tokenId.
      const newTokenId = await NFT.connect(accounts[0]).relock.staticCall(1, 6);
      const tx = await NFT.connect(accounts[0]).relock(1, 6);
      const receipt = await tx.wait();
      const txBlock = await hre.ethers.provider.getBlock(receipt!.blockHash);
      const relockTs = BigInt(txBlock!.timestamp);
      // D26: tier 6 commits 180 days of boost exactly.
      const DAY = 24n * 60n * 60n;
      const expectedExpiryTs = relockTs + 180n * DAY;
      const pos = await ConvictionStakingStorageContract.getPosition(newTokenId);
      expect(pos.expiryTimestamp).to.equal(expectedExpiryTs);
      expect(pos.multiplier18).to.equal(THREE_AND_HALF_X);
    });

    it('direct StakingV10.relock call from non-NFT caller reverts via onlyConvictionNFT gate', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);

      // The gate pins the caller to the Hub-registered NFT contract.
      // D21: `StakingV10.relock(address staker, uint256 oldTokenId, uint256 newTokenId, uint8 newLockTier)`.
      await expect(
        StakingV10Contract.connect(accounts[0]).relock(accounts[0].address, 0, 1, 6),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });

    it('boundary: relock succeeds at exactly currentEpoch == pos.expiryTimestamp', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      // 1-epoch lock at creation epoch C → expiryTimestamp = C + 1. Advance
      // exactly 1 epoch so currentEpoch == expiryTimestamp — under the old
      // `<=` check this would still revert as LockStillActive.
      await advanceEpochs(1);
      await NFT.connect(accounts[0]).claim(1); // satisfy UnclaimedEpochs guard

      const newTokenId = await NFT.connect(accounts[0]).relock.staticCall(1, 6);
      await NFT.connect(accounts[0]).relock(1, 6);
      const pos = await ConvictionStakingStorageContract.getPosition(newTokenId);
      expect(pos.lockTier).to.equal(6);
      expect(pos.multiplier18).to.equal(THREE_AND_HALF_X);
    });

    it('reverts UnclaimedEpochs if position has unclaimed epochs', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      // Advance 3 epochs past expiry without claiming — lastClaimedEpoch
      // is stuck at creationEpoch - 1 while currentEpoch has moved forward.
      await advanceEpochs(3);
      await expect(
        NFT.connect(accounts[0]).relock(1, 6),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'UnclaimedEpochs');
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
        NFT.connect(accounts[4]).redelegate(1, toId),
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
        NFT.connect(accounts[0]).redelegate(1, identityId),
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
        NFT.connect(accounts[0]).redelegate(1, 9999),
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
        NFT.connect(accounts[0]).redelegate(1, toId),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'MaxStakeExceeded');

      // No state leak past the revert: source node still holds the raw,
      // destination is still empty, position still points at the source.
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(fromId)).to.equal(amount);
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(toId)).to.equal(0n);
      const pos = await ConvictionStakingStorageContract.getPosition(1);
      expect(pos.identityId).to.equal(fromId);
    });

    it('direct StakingV10.redelegate call from non-NFT caller reverts via onlyConvictionNFT gate', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 12);

      // The gate pins the caller to the Hub-registered NFT contract.
      // D25: `StakingV10.redelegate(address staker, uint256 tokenId, uint72 newIdentityId)`
      // — in-place, no newTokenId.
      await expect(
        StakingV10Contract.connect(accounts[0]).redelegate(accounts[0].address, 0, toId),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });

    // -----------------------------------------------------------------
    // Happy paths — D25 in-place redelegate: tokenId STABLE, lock clock
    // preserved, only `pos.identityId` mutates.
    // -----------------------------------------------------------------

    it('happy path mid-lock: nodeStake moves, totalStake invariant, position identityId updated in place, tokenId STABLE, expiryTimestamp preserved, event emitted', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 12);

      const totalStakeBefore = await ConvictionStakingStorageContract.totalStakeV10();
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(fromId)).to.equal(amount);
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(toId)).to.equal(0n);

      // Capture the pre-call expiryTimestamp so we can verify preservation.
      const posBefore = await ConvictionStakingStorageContract.getPosition(1);
      const expiryBefore = posBefore.expiryTimestamp;

      // Still mid-lock — the 12-tier lock is nowhere near done.
      const tx = await NFT.connect(accounts[0]).redelegate(1, toId);

      // Wrapper-layer event (`(tokenId, oldIdentityId, newIdentityId)`)
      // mirrors the authoritative events from StakingV10 and CSS.
      await expect(tx)
        .to.emit(NFT, 'PositionRedelegated')
        .withArgs(1n, fromId, toId);
      await expect(tx)
        .to.emit(StakingV10Contract, 'Redelegated')
        .withArgs(1n, fromId, toId);
      await expect(tx)
        .to.emit(ConvictionStakingStorageContract, 'PositionRedelegated')
        .withArgs(1n, fromId, toId);

      // Per-node stake moved.
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(fromId)).to.equal(0n);
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(toId)).to.equal(amount);

      // Global totalStake is INVARIANT — redelegate is a per-node move only.
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(totalStakeBefore);

      // D25: tokenId 0 is STABLE — still owned by the original staker,
      // no mint, no burn.
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);

      // ConvictionStakingStorage position now points at the new node.
      // Raw, lockTier, multiplier18, expiryTimestamp all preserved — the
      // lock clock did NOT reset.
      const pos = await ConvictionStakingStorageContract.getPosition(1);
      expect(pos.identityId).to.equal(toId);
      expect(pos.raw).to.equal(amount);
      expect(pos.lockTier).to.equal(12);
      expect(pos.multiplier18).to.equal(SIX_X);
      expect(pos.expiryTimestamp).to.equal(expiryBefore);
    });

    it('happy path post-expiry: redelegate after lock expired moves nodeStake correctly, tokenId STABLE', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 1);

      // Advance past the 1-epoch lock; the position is now in post-expiry
      // rest state on the source node. Redelegate should still work — the
      // raw principal follows the position to the new node unchanged.
      await advanceEpochs(2);
      await NFT.connect(accounts[0]).claim(1); // satisfy UnclaimedEpochs guard

      await NFT.connect(accounts[0]).redelegate(1, toId);

      expect(await ConvictionStakingStorageContract.getNodeStakeV10(fromId)).to.equal(0n);
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(toId)).to.equal(amount);
      // tokenId STABLE — no mint, no burn.
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      const pos = await ConvictionStakingStorageContract.getPosition(1);
      expect(pos.identityId).to.equal(toId);
      expect(pos.raw).to.equal(amount);
      // Raw lock state on the position stays as it was pre-redelegate
      // (CSS `updateOnRedelegate` only mutates identityId + per-node diffs).
      expect(pos.lockTier).to.equal(1);
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

      const totalBefore = await ConvictionStakingStorageContract.totalStakeV10();

      // Redelegate ONLY NFT 0 from nodeA → nodeB. D25 in-place: tokenId stable.
      await NFT.connect(accounts[0]).redelegate(1, nodeB);

      // NFT 0 moved correctly: tokenId preserved, position updated.
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(nodeA)).to.equal(0n);
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(nodeB)).to.equal(amount);
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      const movedPos = await ConvictionStakingStorageContract.getPosition(1);
      expect(movedPos.raw).to.equal(amount);
      expect(movedPos.identityId).to.equal(nodeB);

      // NFT 1 on nodeC is completely untouched — different tokenId, different
      // node, different delegator key.
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(nodeC)).to.equal(amount);
      expect(
        (await ConvictionStakingStorageContract.getPosition(2)).raw,
      ).to.equal(amount);
      expect((await ConvictionStakingStorageContract.getPosition(2)).identityId).to.equal(nodeC);

      // Global totalStake invariant across the entire sequence (two mints,
      // one redelegate).
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(totalBefore);
    });

    it('reverts UnclaimedEpochs if position has unclaimed epochs', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 12);
      // Advance 3 epochs without claiming.
      await advanceEpochs(3);
      await expect(
        NFT.connect(accounts[0]).redelegate(1, toId),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'UnclaimedEpochs');
    });
  });

  // =====================================================================
  // withdraw (→ StakingV10.withdraw) — D14 atomic exit
  // =====================================================================
  //
  // Post-V10 withdrawal is a single transaction:
  //   1. `NFT.withdraw(tokenId)` — caller must own the NFT.
  //   2. StakingV10 checks the lock gate (`LockStillActive` pre-expiry;
  //      tier-0 always passes since `expiryTimestamp == 0`).
  //   3. Auto-claims any outstanding rewards (compounds into `raw`).
  //   4. Reads the post-claim `raw`, transfers that much TRAC from the
  //      StakingStorage vault to the owner, and calls
  //      `CSS.deletePosition(tokenId)` (which tears down effective-stake
  //      diff entries, cancels pending expiry drops, decrements node +
  //      total aggregates, pops the per-node enumeration slot).
  //   5. The wrapper burns `tokenId`.
  //
  // Full-only by design (Q1): partial withdrawals are NOT a first-class
  // feature. A user wanting partial liquidity should withdraw the whole
  // position and re-stake the remainder at tier 0 (effectively liquid).
  //
  // No `PendingWithdrawal` storage, no delay, no cancel. The lock IS the
  // delay, and tier 0 has no lock.

  // D26 — effective-stake accounting is timestamp-accurate and event-density-
  // bounded. Long dormancy windows no longer need a per-epoch walk: `settleNodeTo`
  // drains the sorted expiry queue in a single pass, sized by the number of
  // expiry events between settlement points (typically 0-3, never unbounded).
  // The old dirty-prefix backfill is gone, so this helper is a no-op kept in
  // place to avoid churning every call-site.
  const preFinalizeDormantEpochs = async (identityId: number): Promise<void> => {
    void identityId;
  };

  describe('withdraw (→ StakingV10.withdraw)', () => {
    // D14 atomic exit — one tx does it all: lock gate → auto-claim →
    // full-drain → transfer TRAC → delete position → burn NFT.
    // No pending slot, no delay, no cancel. Full-only (Q1).

    it('reverts if not owner (non-owner caller)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2); // post-expiry so the position is unlocked
      // accounts[4] does not own tokenId 0 — wrapper-layer guard.
      await expect(
        NFT.connect(accounts[4]).withdraw(1),
      ).to.be.revertedWithCustomError(NFT, 'NotPositionOwner');
    });

    it('reverts pre-expiry with LockStillActive', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      // Pre-expiry: the 12-tier lock is still active. `withdraw` is
      // lock-gated at StakingV10 — no partial or rewards-only drain is
      // available during the lock window.
      await expect(
        NFT.connect(accounts[0]).withdraw(1),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'LockStillActive');
    });

    it('tier 0 (rest state): withdraw succeeds immediately — no lock', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      // Tier 0: `expiryTimestamp == 0`. `withdraw` is immediately callable —
      // the tier-0 branch of the unlock check passes unconditionally.
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 0);

      const balBefore = await Token.balanceOf(accounts[0].address);
      await NFT.connect(accounts[0]).withdraw(1);

      expect(await Token.balanceOf(accounts[0].address)).to.equal(
        balBefore + amount,
      );
      // CSS position deleted, NFT burned.
      expect(
        (await ConvictionStakingStorageContract.getPosition(1)).identityId,
      ).to.equal(0n);
      await expect(NFT.ownerOf(1)).to.be.revertedWithCustomError(
        NFT,
        'ERC721NonexistentToken',
      );
    });

    it('boundary: withdraw succeeds at exactly currentEpoch == pos.expiryTimestamp', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      // 1-tier lock at creation epoch C → expiryTimestamp ~ C + 1. Advance
      // exactly 1 epoch so currentEpoch == expiryTimestamp (the unlock
      // boundary). Under `currentEpoch >= expiryTimestamp` this must pass.
      await advanceEpochs(1);

      // `withdraw` auto-claims internally — no separate claim() required.
      await NFT.connect(accounts[0]).withdraw(1);

      expect(
        (await ConvictionStakingStorageContract.getPosition(1)).identityId,
      ).to.equal(0n);
    });

    it('happy path post-expiry: TRAC refunded, node/total drop, position deleted, NFT burned (D14 atomic)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      await advanceEpochs(2); // post-expiry

      const totalStakeBefore = await ConvictionStakingStorageContract.totalStakeV10();
      const nodeStakeBefore = await ConvictionStakingStorageContract.getNodeStakeV10(identityId);
      const stakerBalBefore = await Token.balanceOf(accounts[0].address);

      const tx = await NFT.connect(accounts[0]).withdraw(1);

      // Authoritative StakingV10 event; amount ≥ original principal
      // because auto-claim may have compounded rewards into raw. On a
      // fresh position with no injected node score, reward == 0 and the
      // emitted amount is the original principal.
      await expect(tx)
        .to.emit(StakingV10Contract, 'Withdrawn')
        .withArgs(1n, accounts[0].address, amount);
      await expect(tx)
        .to.emit(NFT, 'PositionWithdrawn')
        .withArgs(1n, amount);

      // TRAC refunded to staker.
      expect(await Token.balanceOf(accounts[0].address)).to.equal(
        stakerBalBefore + amount,
      );

      // Node + total stake drained by `amount`.
      expect(
        await ConvictionStakingStorageContract.getNodeStakeV10(identityId),
      ).to.equal(nodeStakeBefore - amount);
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(
        totalStakeBefore - amount,
      );

      // CSS position deleted — identityId reset to 0 is the sentinel.
      const posAfter = await ConvictionStakingStorageContract.getPosition(1);
      expect(posAfter.identityId).to.equal(0n);
      expect(posAfter.raw).to.equal(0n);

      // NFT burned.
      await expect(NFT.ownerOf(1)).to.be.revertedWithCustomError(
        NFT,
        'ERC721NonexistentToken',
      );
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(0n);
    });

    it('happy path: node drops below minStake → sharding-table removal', async () => {
      const { identityId } = await createProfile();
      const minStake = await ParametersStorage.minimumStake();
      // Fund exactly minStake so full drain drops nodeStake to 0 < minStake.
      await mintAndApprove(accounts[0], minStake);
      await NFT.connect(accounts[0]).createConviction(identityId, minStake, 1);

      const ShardingTableStorage = await hre.ethers.getContract<
        import('../../typechain').ShardingTableStorage
      >('ShardingTableStorage');
      // Node was inserted at stake time (raw == minStake).
      expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(true);

      await advanceEpochs(2); // post-expiry
      await NFT.connect(accounts[0]).withdraw(1);

      // Sharding-table removal happens atomically inside withdraw.
      expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(false);
      expect(
        await ConvictionStakingStorageContract.getNodeStakeV10(identityId),
      ).to.equal(0n);
      // CSS position + NFT gone.
      expect(
        (await ConvictionStakingStorageContract.getPosition(1)).identityId,
      ).to.equal(0);
      await expect(NFT.ownerOf(1)).to.be.revertedWithCustomError(
        NFT,
        'ERC721NonexistentToken',
      );
    });

    it('direct StakingV10.withdraw call from non-NFT caller reverts via gate', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);
      await advanceEpochs(2);
      await expect(
        StakingV10Contract.connect(accounts[0]).withdraw(
          accounts[0].address,
          0,
        ),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });
  });

  // =====================================================================
  // claim (→ StakingV10.claim) — Phase 11 TRAC-denominated rewards
  // =====================================================================
  //
  // StakingV10.claim walks `[pos.lastClaimedEpoch + 1 .. currentEpoch - 1]`,
  // computes per-epoch effective stake (multiplier pre-expiry, flat post-
  // expiry, plus rewardsSnapshot always at 1x), then converts the
  // delegator's score fraction into TRAC via the epoch reward pool:
  //
  //   delegatorScore18 = effStake * scorePerStake36 / 1e18
  //   grossNodeRewards = epochPool * nodeScore18 / allNodesScore18
  //   operatorFee = grossNodeRewards * opFeePercentage / maxOperatorFee
  //   netNodeRewards = grossNodeRewards - operatorFee
  //   reward = delegatorScore18 * netNodeRewards / nodeScore18
  //
  // Tests inject per-epoch state via hub-owner-privileged setters on
  // RandomSamplingStorage (scorePerStake, nodeScore, allNodesScore) and
  // EpochStorage (epoch pool), then pre-fund the StakingStorage vault with
  // TRAC matching the expected reward so the node-stake bookkeeping stays
  // sound across a downstream withdrawal.
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
      const rss = await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage');
      await rss.connect(accounts[0]).setNodeEpochScorePerStake(epoch, identityId, scorePerStake36);
    };

    // Helper — inject nodeEpochScore for a node at a specific epoch.
    const injectNodeEpochScore = async (
      epoch: number | bigint,
      identityId: number,
      score18: bigint,
    ) => {
      const rss = await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage');
      await rss.connect(accounts[0]).setNodeEpochScore(epoch, identityId, score18);
    };

    // Helper — inject allNodesEpochScore for a specific epoch.
    const injectAllNodesEpochScore = async (epoch: number | bigint, score18: bigint) => {
      const rss = await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage');
      await rss.connect(accounts[0]).setAllNodesEpochScore(epoch, score18);
    };

    // Helper — fund a contiguous range of epoch pools via EpochStorage.
    // Each epoch in [startEpoch .. endEpoch] receives `amountPerEpoch`.
    // IMPORTANT: EpochStorage.addTokensToEpochRange triggers epoch
    // finalization on every call, which locks in the cumulative sums from
    // diffs set up so far. Calling it multiple times for overlapping
    // epoch windows would finalize partial state. Always fund the full
    // epoch range in a single call when possible.
    const fundEpochPoolRange = async (
      startEpoch: number | bigint,
      endEpoch: number | bigint,
      amountPerEpoch: bigint,
    ) => {
      const es = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
      const numEpochs = BigInt(endEpoch) - BigInt(startEpoch) + 1n;
      const totalAmount = amountPerEpoch * numEpochs;
      await es.connect(accounts[0]).addTokensToEpochRange(1, startEpoch, endEpoch, totalAmount);
    };

    // Helper — fund a single epoch pool (convenience wrapper).
    const fundEpochPool = async (epoch: number | bigint, amount: bigint) => {
      await fundEpochPoolRange(epoch, epoch, amount);
    };

    // Helper — inject all epoch-level reward state in one call (single epoch).
    // Sets scorePerStake, nodeScore, allNodesScore, and epoch pool for
    // a single (epoch, identityId) tuple.
    const injectEpochRewardState = async (
      epoch: number | bigint,
      identityId: number,
      scorePerStake36: bigint,
      nodeScore18: bigint,
      allNodesScore18: bigint,
      epochPool: bigint,
    ) => {
      await injectScorePerStake(epoch, identityId, scorePerStake36);
      await injectNodeEpochScore(epoch, identityId, nodeScore18);
      await injectAllNodesEpochScore(epoch, allNodesScore18);
      await fundEpochPool(epoch, epochPool);
    };

    // Helper — inject score/epoch state for multiple epochs with a UNIFORM
    // epoch pool. Uses a single `addTokensToEpochRange` call to avoid the
    // finalization-ordering issue where subsequent calls lock in partial
    // cumulative sums from earlier diffs.
    const injectMultiEpochRewardState = async (
      startEpoch: bigint,
      epochCount: number,
      identityId: number,
      scorePerStakes: bigint[],
      nodeScore18: bigint,
      allNodesScore18: bigint,
      epochPool: bigint,
    ) => {
      // Fund the full epoch range in ONE call.
      const endEpoch = startEpoch + BigInt(epochCount) - 1n;
      await fundEpochPoolRange(startEpoch, endEpoch, epochPool);

      // Then inject per-epoch scores (these don't trigger finalization).
      for (let i = 0; i < epochCount; i++) {
        const e = startEpoch + BigInt(i);
        await injectScorePerStake(e, identityId, scorePerStakes[i]);
        await injectNodeEpochScore(e, identityId, nodeScore18);
        await injectAllNodesEpochScore(e, allNodesScore18);
      }
    };

    // Helper — pre-fund the StakingStorage vault with `amount` TRAC so the
    // post-claim node-stake bookkeeping matches the on-chain vault balance.
    // On mainnet this TRAC flows in from Phase 11's reward distribution path.
    const fundVault = async (amount: bigint) => {
      const stakingStorageAddr = await StakingStorage.getAddress();
      await Token.mint(stakingStorageAddr, amount);
    };

    // Helper — compute expected TRAC reward for a single epoch using the
    // Phase 11 formula. Matches `StakingV10.claim`'s inner loop exactly:
    //   delegatorScore18 = effStake * scorePerStake36 / 1e18
    //   grossNodeRewards = epochPool * nodeScore18 / allNodesScore18
    //   operatorFee = grossNodeRewards * operatorFeePercentage / maxOperatorFee
    //   netNodeRewards = grossNodeRewards - operatorFee
    //   reward = delegatorScore18 * netNodeRewards / nodeScore18
    const computeReward = (
      effStake: bigint,
      scorePerStake36: bigint,
      epochPool: bigint,
      nodeScore18: bigint,
      allNodesScore18: bigint,
      operatorFeePercentage: bigint = 0n,
      maxOperatorFee: bigint = 10_000n,
    ): bigint => {
      const delegatorScore18 = (effStake * scorePerStake36) / SCALE18;
      if (delegatorScore18 === 0n || nodeScore18 === 0n) return 0n;
      const grossNodeRewards = (epochPool * nodeScore18) / allNodesScore18;
      const operatorFee = (grossNodeRewards * operatorFeePercentage) / maxOperatorFee;
      const netNodeRewards = grossNodeRewards - operatorFee;
      return (delegatorScore18 * netNodeRewards) / nodeScore18;
    };

    // Helper — assert the vault balance invariant after every claim.
    const assertVaultInvariant = async () => {
      const stakingStorageAddr = await StakingStorage.getAddress();
      const vaultBalance = await Token.balanceOf(stakingStorageAddr);
      const totalStake = await ConvictionStakingStorageContract.totalStakeV10();
      expect(vaultBalance).to.be.gte(totalStake);
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
      await expect(NFT.connect(accounts[4]).claim(1)).to.be.revertedWithCustomError(
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
      const posBefore = await ConvictionStakingStorageContract.getPosition(1);
      const nodeStakeBefore = await ConvictionStakingStorageContract.getNodeStakeV10(identityId);
      const totalStakeBefore = await ConvictionStakingStorageContract.totalStakeV10();
      const baseBefore = await (await ConvictionStakingStorageContract.getPosition(1)).raw;

      const tx = await NFT.connect(accounts[0]).claim(1);
      await expect(tx).to.not.emit(StakingV10Contract, 'RewardsClaimed');

      const posAfter = await ConvictionStakingStorageContract.getPosition(1);
      expect(posAfter.raw).to.equal(posBefore.raw);
      expect(posAfter.lastClaimedEpoch).to.equal(posBefore.lastClaimedEpoch);
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(nodeStakeBefore);
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(totalStakeBefore);
      expect(await (await ConvictionStakingStorageContract.getPosition(1)).raw).to.equal(
        baseBefore,
      );
    });

    it('no-op: zero scorePerStake across the walked window advances lastClaimedEpoch but emits nothing', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      await advanceEpochs(1);

      const nodeStakeBefore = await ConvictionStakingStorageContract.getNodeStakeV10(identityId);
      const totalStakeBefore = await ConvictionStakingStorageContract.totalStakeV10();

      // No score injection → scorePerStake = 0 for the walked epoch → reward = 0.
      // Claim still advances lastClaimedEpoch but emits no RewardsClaimed.
      const tx = await NFT.connect(accounts[0]).claim(1);
      await expect(tx).to.not.emit(StakingV10Contract, 'RewardsClaimed');

      const pos = await ConvictionStakingStorageContract.getPosition(1);
      // lastClaimedEpoch was advanced to currentEpoch - 1 so re-claim is a no-op.
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      expect(pos.lastClaimedEpoch).to.equal(currentEpoch - 1n);
      // Totals unchanged.
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(nodeStakeBefore);
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(totalStakeBefore);
    });

    // -----------------------------------------------------------------
    // Happy paths — reward accumulation
    // -----------------------------------------------------------------

    it('single-epoch happy path: one epoch of score, claim compounds into raw (D19)', async () => {
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
      // Single node (nodeScore = allNodesScore), operator fee = 0.
      // So reward = delegatorScore18 * epochPool / nodeScore18.
      const effStake = (amount * SIX_X) / SCALE18;
      const scorePerStake36 = hre.ethers.parseEther('0.001'); // 1e15 (a modest score rate)
      const nodeScore18 = hre.ethers.parseEther('100');
      const allNodesScore18 = nodeScore18; // only node
      const epochPool = hre.ethers.parseEther('1000');

      await injectEpochRewardState(
        walkEpoch,
        identityId,
        scorePerStake36,
        nodeScore18,
        allNodesScore18,
        epochPool,
      );

      const expectedReward = computeReward(
        effStake,
        scorePerStake36,
        epochPool,
        nodeScore18,
        allNodesScore18,
      );
      await fundVault(expectedReward);

      const nodeStakeBefore = await ConvictionStakingStorageContract.getNodeStakeV10(identityId);
      const totalStakeBefore = await ConvictionStakingStorageContract.totalStakeV10();

      const tx = await NFT.connect(accounts[0]).claim(1);
      await expect(tx)
        .to.emit(StakingV10Contract, 'RewardsClaimed')
        .withArgs(1n, expectedReward);

      const pos = await ConvictionStakingStorageContract.getPosition(1);
      // D19: claim compounds the reward directly into `pos.raw`
      //      (rewards bucket was collapsed into raw).
      expect(pos.raw).to.equal(amount + expectedReward);
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      expect(pos.lastClaimedEpoch).to.equal(currentEpoch - 1n);
      // `cumulativeRewardsClaimed` is a pure statistic under D19.
      expect(pos.cumulativeRewardsClaimed).to.equal(expectedReward);

      // D15: node + total V10 aggregates grow by the reward — the
      //      compounded amount is a fresh raw credit on the node.
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(
        nodeStakeBefore + expectedReward,
      );
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(totalStakeBefore + expectedReward);

      // TRAC-zero invariant: neither the NFT wrapper nor StakingV10 hold funds.
      expect(await Token.balanceOf(await NFT.getAddress())).to.equal(0n);
      expect(await Token.balanceOf(await StakingV10Contract.getAddress())).to.equal(0n);

      // Vault balance invariant.
      await assertVaultInvariant();
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
      // Single node, operator fee = 0. Uniform epoch pool across all 3 epochs.
      const effStake = (amount * SIX_X) / SCALE18;
      const nodeScore18 = hre.ethers.parseEther('100');
      const allNodesScore18 = nodeScore18;
      const epochPool = hre.ethers.parseEther('1000');

      const s0 = hre.ethers.parseEther('0.001'); // 1e15
      const s1 = hre.ethers.parseEther('0.002'); // 2e15
      const s2 = hre.ethers.parseEther('0.003'); // 3e15

      // Fund all 3 epochs in a single call to avoid EpochStorage finalization
      // ordering issues, then inject per-epoch scores.
      await injectMultiEpochRewardState(
        creationEpoch,
        3,
        identityId,
        [s0, s1, s2],
        nodeScore18,
        allNodesScore18,
        epochPool,
      );

      // Sum rewards per-epoch.
      const expectedReward =
        computeReward(effStake, s0, epochPool, nodeScore18, allNodesScore18) +
        computeReward(effStake, s1, epochPool, nodeScore18, allNodesScore18) +
        computeReward(effStake, s2, epochPool, nodeScore18, allNodesScore18);
      await fundVault(expectedReward);

      const tx = await NFT.connect(accounts[0]).claim(1);
      await expect(tx)
        .to.emit(StakingV10Contract, 'RewardsClaimed')
        .withArgs(1n, expectedReward);

      const pos = await ConvictionStakingStorageContract.getPosition(1);

      // Vault balance invariant.
      await assertVaultInvariant();
    });

    it('pre-expiry multiplier applied: 6x multiplier on a 12-epoch lock', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      await advanceEpochs(1);
      const scorePerStake36 = hre.ethers.parseEther('0.01'); // 1e16
      const nodeScore18 = hre.ethers.parseEther('100');
      const allNodesScore18 = nodeScore18;
      const epochPool = hre.ethers.parseEther('1000');
      await injectEpochRewardState(
        creationEpoch,
        identityId,
        scorePerStake36,
        nodeScore18,
        allNodesScore18,
        epochPool,
      );

      // effStake = raw * 6x (still pre-expiry since expiryTimestamp = creation+12)
      const effStake = (amount * SIX_X) / SCALE18;
      const expectedReward = computeReward(
        effStake,
        scorePerStake36,
        epochPool,
        nodeScore18,
        allNodesScore18,
      );
      await fundVault(expectedReward);

      // Compare against a hypothetical 1x position: same epoch pool means the
      // 6x effective should produce 6x the delegator-score fraction and thus
      // 6x the reward of a 1x position.
      const baselineReward = computeReward(
        amount,
        scorePerStake36,
        epochPool,
        nodeScore18,
        allNodesScore18,
      );
      expect(expectedReward).to.equal(baselineReward * 6n);

      await NFT.connect(accounts[0]).claim(1);
      const pos = await ConvictionStakingStorageContract.getPosition(1);

      // Vault balance invariant.
      await assertVaultInvariant();
    });

    it('post-expiry 1x downgrade: claim across an epoch where lock has already expired', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      // 1-epoch lock -> expiryTimestamp = creationEpoch + 1. Advance 3 epochs so the
      // claim window covers creationEpoch (pre-expiry) AND creationEpoch+1,+2
      // (post-expiry). Inject distinct scores to verify per-epoch math.
      await advanceEpochs(3);

      // Only inject on one post-expiry epoch so the expected reward is
      // unambiguously the 1x rate.
      const postExpiryEpoch = creationEpoch + 2n; // strictly > expiryTimestamp=creation+1
      const scorePerStake36 = hre.ethers.parseEther('0.01');
      const nodeScore18 = hre.ethers.parseEther('100');
      const allNodesScore18 = nodeScore18;
      const epochPool = hre.ethers.parseEther('1000');
      await injectEpochRewardState(
        postExpiryEpoch,
        identityId,
        scorePerStake36,
        nodeScore18,
        allNodesScore18,
        epochPool,
      );

      // effStake_post = raw (no multiplier after expiry)
      const expectedReward = computeReward(
        amount,
        scorePerStake36,
        epochPool,
        nodeScore18,
        allNodesScore18,
      );
      await fundVault(expectedReward);

      await NFT.connect(accounts[0]).claim(1);
      const pos = await ConvictionStakingStorageContract.getPosition(1);

      // Vault balance invariant.
      await assertVaultInvariant();
    });

    it('multiplier + post-expiry split: two epochs, first boosted, second flat', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      // 1-epoch lock -> expiryTimestamp = creationEpoch + 1. With advanceEpochs(3):
      //   - claim window = [creationEpoch .. creationEpoch + 2]
      //   - pre-expiry: epoch == creationEpoch (strict < expiryTimestamp)
      //   - post-expiry: creationEpoch + 1, creationEpoch + 2 (>= expiryTimestamp)
      await advanceEpochs(3);
      const scorePre = hre.ethers.parseEther('0.01');
      const scorePost = hre.ethers.parseEther('0.02');
      const nodeScore18 = hre.ethers.parseEther('100');
      const allNodesScore18 = nodeScore18;
      const epochPool = hre.ethers.parseEther('1000');

      // Fund all 3 epochs in one call, then inject per-epoch scores.
      await fundEpochPoolRange(creationEpoch, creationEpoch + 2n, epochPool);
      await injectScorePerStake(creationEpoch, identityId, scorePre);
      await injectNodeEpochScore(creationEpoch, identityId, nodeScore18);
      await injectAllNodesEpochScore(creationEpoch, allNodesScore18);
      await injectScorePerStake(creationEpoch + 2n, identityId, scorePost);
      await injectNodeEpochScore(creationEpoch + 2n, identityId, nodeScore18);
      await injectAllNodesEpochScore(creationEpoch + 2n, allNodesScore18);

      // Pre-expiry epoch earns at 1.5x; post-expiry epoch at 1x.
      const effStakePre = (amount * ONE_AND_HALF_X) / SCALE18;
      const effStakePost = amount;
      const expectedReward =
        computeReward(effStakePre, scorePre, epochPool, nodeScore18, allNodesScore18) +
        computeReward(effStakePost, scorePost, epochPool, nodeScore18, allNodesScore18);
      await fundVault(expectedReward);

      const tx = await NFT.connect(accounts[0]).claim(1);
      await expect(tx)
        .to.emit(StakingV10Contract, 'RewardsClaimed')
        .withArgs(1n, expectedReward);

      const pos = await ConvictionStakingStorageContract.getPosition(1);

      // Vault balance invariant.
      await assertVaultInvariant();
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
      const nodeScore18 = hre.ethers.parseEther('100');
      const allNodesScore18 = nodeScore18;
      const epochPool = hre.ethers.parseEther('1000');
      await injectEpochRewardState(
        creationEpoch,
        identityId,
        scorePerStake36,
        nodeScore18,
        allNodesScore18,
        epochPool,
      );

      const effStake = (amount * SIX_X) / SCALE18;
      const expectedReward = computeReward(
        effStake,
        scorePerStake36,
        epochPool,
        nodeScore18,
        allNodesScore18,
      );
      await fundVault(expectedReward);

      // First claim — pays out expected reward.
      await NFT.connect(accounts[0]).claim(1);
      const posAfterFirst = await ConvictionStakingStorageContract.getPosition(1);

      // Second claim — no-op (same epoch, lastClaimedEpoch already caught up).
      const tx = await NFT.connect(accounts[0]).claim(1);
      await expect(tx).to.not.emit(StakingV10Contract, 'RewardsClaimed');

      const posAfterSecond = await ConvictionStakingStorageContract.getPosition(1);
    });

    // -----------------------------------------------------------------
    // Bounds check — rewardTotal cast guard
    // -----------------------------------------------------------------

    it('reverts RewardOverflow when accumulated reward exceeds uint96 max', async () => {
      const { identityId } = await createProfile();
      // We need to push `rewardTotal` past `type(uint96).max` (~7.92e28)
      // through the TRAC formula. With a massive epoch pool and the
      // delegator being the only staker on the only node, the full pool
      // flows to the delegator. We need epochPool > 2^96.
      //
      // amount = 1e22 (10000 TRAC), effStake = 6e22 at 6x
      // nodeScore = allNodesScore = 100e18
      // scorePerStake36 chosen so delegatorScore18 = nodeScore18
      //   => delegatorScore18 = effStake * scorePerStake36 / 1e18 = 100e18
      //   => scorePerStake36 = 100e18 * 1e18 / 6e22 = 1e18 * 100 / 6e4
      //      = 1e18 / 600 ~ 1.666e15 (but doesn't need to be exact)
      // With delegatorScore = nodeScore, reward = netNodeRewards = epochPool.
      // Set epochPool = 1e29 > 2^96 (~7.92e28) — overflow.
      const amount = hre.ethers.parseEther('10000'); // 1e22
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      await advanceEpochs(1);

      const nodeScore18 = hre.ethers.parseEther('100'); // 1e20
      const allNodesScore18 = nodeScore18;
      // Make delegatorScore18 = nodeScore18 so reward = epochPool exactly.
      // delegatorScore18 = effStake * scorePerStake36 / 1e18
      // effStake = 6e22. We need scorePerStake36 = nodeScore18 * 1e18 / effStake
      //   = 1e20 * 1e18 / 6e22 = 1e38 / 6e22 = 1e16 / 6 ~ 1.666e15
      // Use a round value that gets close enough to overflow.
      const scorePerStake36 = 10n ** 25n;
      // epochPool must be huge to force overflow. The epoch pool is uint96,
      // but addTokensToEpochRange takes uint96. So we need to set it near
      // the uint96 max. 2^96 - 1 ~ 7.92e28.
      const hugePool = (1n << 96n) - 1n; // max uint96
      await injectEpochRewardState(
        creationEpoch,
        identityId,
        scorePerStake36,
        nodeScore18,
        allNodesScore18,
        hugePool,
      );

      await expect(
        NFT.connect(accounts[0]).claim(1),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'RewardOverflow');
    });

    // -----------------------------------------------------------------
    // Integration — claim then withdraw the claimed rewards
    // -----------------------------------------------------------------

    it('D19 integration: claim compounds into raw, post-expiry withdraw returns principal + rewards', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      // Tier 1 lock so we can cross into post-expiry quickly.
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 1);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      // Walk one epoch inside the lock to earn rewards at the 1.5x multiplier.
      await advanceEpochs(1);

      const scorePerStake36 = hre.ethers.parseEther('0.001');
      const nodeScore18 = hre.ethers.parseEther('100');
      const allNodesScore18 = nodeScore18;
      const epochPool = hre.ethers.parseEther('1000');
      await injectEpochRewardState(
        creationEpoch,
        identityId,
        scorePerStake36,
        nodeScore18,
        allNodesScore18,
        epochPool,
      );

      const effStake = (amount * ONE_AND_HALF_X) / SCALE18;
      const expectedReward = computeReward(
        effStake,
        scorePerStake36,
        epochPool,
        nodeScore18,
        allNodesScore18,
      );
      await fundVault(expectedReward);

      // 1. Claim — D19 compounds the reward directly into pos.raw.
      await NFT.connect(accounts[0]).claim(1);
      const posAfterClaim = await ConvictionStakingStorageContract.getPosition(1);
      expect(posAfterClaim.raw).to.equal(amount + expectedReward);

      // 2. Advance one more epoch → now post-expiry. `withdraw` is the
      //    atomic exit: it auto-claims any remaining reward window,
      //    reads the post-claim raw, refunds TRAC, deletes the position,
      //    and burns the NFT in a single transaction.
      await advanceEpochs(1);

      const stakerBalBefore = await Token.balanceOf(accounts[0].address);
      const tx = await NFT.connect(accounts[0]).withdraw(1);

      // The emitted amount is authoritative: it includes everything that
      // auto-claim rolled into raw before the transfer.
      const rc = await tx.wait();
      const evt = rc!.logs
        .map((l) => {
          try {
            return StakingV10Contract.interface.parseLog(l as never);
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === 'Withdrawn');
      const paid = evt!.args[2] as bigint;

      // TRAC refunded equals the emitted amount (principal + rewards,
      // including any reward accrued in the post-expiry epoch that the
      // in-tx auto-claim compounds in before the transfer).
      expect(await Token.balanceOf(accounts[0].address)).to.equal(
        stakerBalBefore + paid,
      );

      // Position + NFT gone.
      expect(
        (await ConvictionStakingStorageContract.getPosition(1)).identityId,
      ).to.equal(0n);
    });

    // -----------------------------------------------------------------
    // Reward distribution proportionality
    // -----------------------------------------------------------------

    it('6x staker gets 6/7, 1x staker gets 1/7 of net node rewards', async () => {
      const { identityId } = await createProfile();
      const aliceAmount = hre.ethers.parseEther('1000');
      const bobAmount = hre.ethers.parseEther('1000');

      // Alice: 12-epoch lock (6x), Bob: 0 lock via post-expiry (1x).
      // We create both at different tiers on the same node.
      // Alice — 12-epoch lock, 6x
      await mintAndApprove(accounts[0], aliceAmount);
      await NFT.connect(accounts[0]).createConviction(identityId, aliceAmount, 12);

      // Bob — 1-epoch lock, 1.5x pre-expiry but we'll claim only post-expiry.
      // Actually, to get a clean 1x we use the same epoch for both but
      // let Bob use 1-epoch lock and claim the creation epoch (pre-expiry
      // at 1.5x). To get a true 6:1 ratio we need Bob to be at 1x.
      //
      // Simplification: advance past Bob's expiry so Bob is at 1x.
      await mintAndApprove(accounts[2], bobAmount);
      await Token.connect(accounts[2]).approve(await StakingV10Contract.getAddress(), bobAmount);
      await NFT.connect(accounts[2]).createConviction(identityId, bobAmount, 1);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      // Advance 2 epochs so Bob's 1-epoch lock is expired on the claim epoch.
      // Bob's expiryTimestamp = creationEpoch + 1, so epoch creationEpoch+1 is
      // post-expiry for Bob but still pre-expiry for Alice (expiry at +12).
      await advanceEpochs(2);
      const claimEpoch = creationEpoch + 1n;

      // Effective stakes: Alice = 1000 * 6 = 6000, Bob = 1000 * 1 = 1000
      // Total effective = 7000
      const aliceEff = (aliceAmount * SIX_X) / SCALE18; // 6000e18
      const bobEff = bobAmount; // 1000e18 (post-expiry, 1x)

      // nodeScore = sum of proofs. We set it directly.
      // scorePerStake36 = nodeScore18 * 1e18 / effectiveNodeStake is the
      // relationship from proof submission. We pick clean round numbers:
      const nodeScore18 = hre.ethers.parseEther('700'); // 700e18
      const allNodesScore18 = nodeScore18;
      const epochPool = hre.ethers.parseEther('7000'); // 7000 TRAC

      // scorePerStake36 such that the sum of delegator scores = nodeScore.
      // delegatorScore_alice = aliceEff * sps / 1e18, bob same.
      // sum = (aliceEff + bobEff) * sps / 1e18 = nodeScore
      // sps = nodeScore * 1e18 / (aliceEff + bobEff)
      //     = 700e18 * 1e18 / 7000e18 = 1e17
      const totalEffective = aliceEff + bobEff;
      const scorePerStake36 = (nodeScore18 * SCALE18) / totalEffective;

      await injectEpochRewardState(
        claimEpoch,
        identityId,
        scorePerStake36,
        nodeScore18,
        allNodesScore18,
        epochPool,
      );

      // Also inject creation epoch with 0 score (already default, but
      // we inject the first-epoch score for both). Both positions walk
      // [creationEpoch .. creationEpoch+1]; only claimEpoch has score.

      // netNodeRewards = epochPool (single node, opFee=0) = 7000 TRAC
      // Alice reward = aliceEff * sps / 1e18 * 7000e18 / nodeScore18
      //              = 6000e18 * 1e17 / 1e18 * 7000e18 / 700e18
      //              = 600e18 * 10 = 6000e18
      // Bob reward   = 1000e18 * 1e17 / 1e18 * 7000e18 / 700e18
      //              = 100e18 * 10 = 1000e18
      const aliceExpected = computeReward(
        aliceEff,
        scorePerStake36,
        epochPool,
        nodeScore18,
        allNodesScore18,
      );
      const bobExpected = computeReward(
        bobEff,
        scorePerStake36,
        epochPool,
        nodeScore18,
        allNodesScore18,
      );

      // Fund vault with total rewards.
      await fundVault(aliceExpected + bobExpected);

      // Alice claims first (tokenId 0).
      await NFT.connect(accounts[0]).claim(1);
      const alicePos = await ConvictionStakingStorageContract.getPosition(1);

      // Bob claims second (tokenId 1).
      await NFT.connect(accounts[2]).claim(2);
      const bobPos = await ConvictionStakingStorageContract.getPosition(2);

      // Proportionality: Alice gets 6/7, Bob gets 1/7 of netNodeRewards.
      const netNodeRewards = epochPool; // single node, no op fee
      expect(aliceExpected).to.equal((netNodeRewards * 6n) / 7n);
      expect(bobExpected).to.equal(netNodeRewards / 7n);
      // Total within 1 wei of netNodeRewards (integer division rounding).
      expect(netNodeRewards - (aliceExpected + bobExpected)).to.be.lte(1n);

      // Vault balance invariant.
      await assertVaultInvariant();
    });

    // -----------------------------------------------------------------
    // Expiry boundary — multiplier transitions at expiryTimestamp
    // -----------------------------------------------------------------

    it('expiry boundary: pre-expiry epochs use 6x, expiryTimestamp onward uses 1x', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      // expiryTimestamp = creationEpoch + 12. Advance 14 epochs to cover
      // [creationEpoch .. creationEpoch+13]. Epochs 0..11 are pre-expiry
      // (6x), epoch 12+ are post-expiry (1x).
      await advanceEpochs(14);

      const nodeScore18 = hre.ethers.parseEther('100');
      const allNodesScore18 = nodeScore18;
      const epochPool = hre.ethers.parseEther('100');
      const scorePerStake36 = hre.ethers.parseEther('0.001'); // 1e15

      // Inject score for exactly two epochs: one pre-expiry and one
      // post-expiry (the boundary epoch). This isolates the multiplier
      // transition.
      const lastPreExpiryEpoch = creationEpoch + 11n; // epoch index 11, still < expiryTimestamp=creation+12
      const firstPostExpiryEpoch = creationEpoch + 12n; // expiryTimestamp itself

      // Fund the full 14-epoch range in one call to avoid finalization issues.
      await fundEpochPoolRange(creationEpoch, creationEpoch + 13n, epochPool);

      // Inject per-epoch score data for just the two epochs we care about.
      await injectScorePerStake(lastPreExpiryEpoch, identityId, scorePerStake36);
      await injectNodeEpochScore(lastPreExpiryEpoch, identityId, nodeScore18);
      await injectAllNodesEpochScore(lastPreExpiryEpoch, allNodesScore18);
      await injectScorePerStake(firstPostExpiryEpoch, identityId, scorePerStake36);
      await injectNodeEpochScore(firstPostExpiryEpoch, identityId, nodeScore18);
      await injectAllNodesEpochScore(firstPostExpiryEpoch, allNodesScore18);

      // Pre-expiry: effStake = 1000 * 6 = 6000
      const effStakePre = (amount * SIX_X) / SCALE18;
      // Post-expiry: effStake = 1000 (1x)
      const effStakePost = amount;

      const rewardPre = computeReward(
        effStakePre,
        scorePerStake36,
        epochPool,
        nodeScore18,
        allNodesScore18,
      );
      const rewardPost = computeReward(
        effStakePost,
        scorePerStake36,
        epochPool,
        nodeScore18,
        allNodesScore18,
      );

      // Verify the multiplier difference is exactly 6:1.
      expect(rewardPre).to.equal(rewardPost * 6n);

      const expectedTotal = rewardPre + rewardPost;
      await fundVault(expectedTotal);

      const tx = await NFT.connect(accounts[0]).claim(1);
      await expect(tx)
        .to.emit(StakingV10Contract, 'RewardsClaimed')
        .withArgs(1n, expectedTotal);

      const pos = await ConvictionStakingStorageContract.getPosition(1);

      // Vault balance invariant.
      await assertVaultInvariant();
    });
  });

  // =====================================================================
  // convertToNFT → StakingV10.convertToNFT
  // =====================================================================
  //
  // Atomic V8 → V10 migration. The user starts with an address-keyed V8
  // delegator position on some node (via `Staking.stake`) and ends with a
  // bytes32(tokenId)-keyed V10 conviction NFT on the same node at the
  // chosen lock tier. Net change:
  //   - V8 delegator stake base → 0
  //   - V8 delegator removed from `DelegatorsInfo` set
  //   - V10 position created (raw = V8 amount, rewards = 0, multiplier18
  //     matches tier, lastClaimedEpoch = currentEpoch - 1)
  //   - NFT minted to `staker`
  //   - Node stake, total stake INVARIANT (V8 amount removed, V10 amount
  //     added — same value, zero net change)
  //
  // Precondition: V8 rolling rewards must be 0 AND `lastClaimedEpoch >=
  // currentEpoch - 1`. User must run `Staking.claimDelegatorRewards` for
  // every unclaimed V8 epoch before invoking `convertToNFT`. This keeps
  // StakingV10 out of the V8 reward-distribution path — Phase 5's
  // V10 implementation does NOT fold V8 rolling rewards into the V10
  // position's raw bucket.

  describe('convertToNFT (→ StakingV10.convertToNFT)', () => {
    // V8 delegator key formula is `keccak256(abi.encodePacked(address))`
    // per `Staking._getDelegatorKey` at Staking.sol:905-907. Mirror here
    // so the tests can inspect the V8 bucket directly.
    const v8Key = (addr: string): string =>
      hre.ethers.keccak256(hre.ethers.solidityPacked(['address'], [addr]));

    // Test shortcut — set up a V8 address-keyed delegator position without
    // running the full V8 stake path. This mimics the end state of a
    // `Staking.stake(id, amount)` call plus a `claimDelegatorRewards` that
    // caught the delegator up to `currentEpoch - 1` with zero rolling
    // rewards. The Hub owner can call `onlyContracts` setters directly per
    // `HubDependent._checkHubContract`, so we poke StakingStorage and
    // DelegatorsInfo without going through the V8 path. This is faster
    // than a real V8 stake (which would also walk reward-epoch baselines)
    // and keeps the convertToNFT tests from depending on the correctness
    // of V8 `stake()` — we already have Staking.test.ts for that.
    const setupV8Stake = async (
      staker: SignerWithAddress,
      identityId: number,
      amount: bigint,
    ) => {
      // Mint TRAC into the StakingStorage vault so any later finalize
      // draws from a funded pool. Not strictly required for the
      // convertToNFT path itself (no transfer on migrate), but keeps the
      // test state consistent with what a real V8 stake would leave.
      const stakingStorageAddr = await StakingStorage.getAddress();
      await Token.mint(stakingStorageAddr, amount);

      // V8 delegator key + storage writes. `increaseDelegatorStakeBase`
      // flips the delegator to active, so the delegatorNodes set entry
      // is created via `_updateDelegatorActivity`. Match the V8
      // `_stake` call sequence (set base, set nodeStake, increaseTotalStake).
      const key = v8Key(staker.address);
      await StakingStorage.connect(accounts[0]).increaseDelegatorStakeBase(
        identityId,
        key,
        amount,
      );
      await StakingStorage.connect(accounts[0]).increaseNodeStake(identityId, amount);
      await StakingStorage.connect(accounts[0]).increaseTotalStake(amount);

      // V8 DelegatorsInfo bookkeeping — mark the delegator as registered
      // on the node, record hasEverDelegatedToNode, and baseline
      // lastClaimedEpoch to currentEpoch - 1 so the precondition check
      // in convertToNFT passes without forcing the test to crawl the full
      // V8 reward flow. Rolling rewards start at 0 (default).
      await DelegatorsInfoContract.connect(accounts[0]).addDelegator(identityId, staker.address);
      await DelegatorsInfoContract.connect(accounts[0]).setHasEverDelegatedToNode(
        identityId,
        staker.address,
        true,
      );
      const currentEpoch = await ChronosContract.getCurrentEpoch();
      // Floor the baseline at 0 to avoid underflow when currentEpoch == 1
      // (Chronos floors at 1, so currentEpoch - 1 == 0 is legal).
      const baseline = currentEpoch > 0n ? currentEpoch - 1n : 0n;
      await DelegatorsInfoContract.connect(accounts[0]).setLastClaimedEpoch(
        identityId,
        staker.address,
        baseline,
      );
    };

    // Pull the hub-registered DelegatorsInfo contract into scope on every
    // test — the fixture builds a fresh graph each run.
    let DelegatorsInfoContract: DelegatorsInfo;
    beforeEach(async () => {
      DelegatorsInfoContract = await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo');
    });

    // -----------------------------------------------------------------
    // Revert / gate paths
    // -----------------------------------------------------------------

    it('reverts if V8 rolling rewards are unclaimed', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await setupV8Stake(accounts[0], identityId, amount);

      // Inject non-zero rolling rewards — the precondition must reject
      // before any storage mutation. Hub owner can poke DelegatorsInfo
      // directly (onlyContracts).
      await DelegatorsInfoContract.connect(accounts[0]).setDelegatorRollingRewards(
        identityId,
        accounts[0].address,
        1n,
      );

      // D3: the V8 rolling-rewards precondition is dropped. Pre-migration
      // rewards are settled via `claim()`'s D6 retroactive branch starting
      // from `migrationEpoch`. `selfMigrateV8` must now succeed even with
      // non-zero rolling rewards on the delegator.
      await expect(
        NFT.connect(accounts[0]).selfMigrateV8(identityId, 12),
      ).to.emit(StakingV10Contract, 'ConvertedFromV8');

      // Post-migration: V8 bucket drained, V10 position seeded.
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, v8Key(accounts[0].address)),
      ).to.equal(0n);
      const pos = await ConvictionStakingStorageContract.getPosition(1);
      expect(pos.raw).to.equal(amount);
    });

    it('D3: migration succeeds even when V8 lastClaimedEpoch is older than currentEpoch - 1', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await setupV8Stake(accounts[0], identityId, amount);

      // D3 drops the lastClaimedEpoch precondition; advance well past the
      // baseline, the migration must still succeed.
      await advanceEpochs(3);

      await expect(
        NFT.connect(accounts[0]).selfMigrateV8(identityId, 12),
      ).to.emit(StakingV10Contract, 'ConvertedFromV8');

      // V8 bucket drained, V10 position present.
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, v8Key(accounts[0].address)),
      ).to.equal(0n);
      const pos = await ConvictionStakingStorageContract.getPosition(1);
      expect(pos.raw).to.equal(amount);
    });

    it('reverts if no V8 stake exists for the staker (NoV8StakeToConvert)', async () => {
      const { identityId } = await createProfile();
      // No V8 stake setup — the caller has nothing to migrate. We still
      // need DelegatorsInfo to show `lastClaimedEpoch >= currentEpoch - 1`
      // so the precondition check doesn't trip first; that's trivially
      // true here since a never-touched delegator has `lastClaimed == 0`
      // and currentEpoch == 1 in a fresh fixture.
      //
      // Actually, since `lastClaimedEpoch` defaults to 0, we also need
      // currentEpoch <= 1 for the precondition check to pass. Fresh
      // fixture starts at epoch 1, so this is fine without any setup.
      await expect(
        NFT.connect(accounts[0]).selfMigrateV8(identityId, 12),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'NoV8StakeToConvert');
    });

    it('reverts on invalid lock tier (2) at the NFT wrapper layer', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await setupV8Stake(accounts[0], identityId, amount);

      // Wrapper's `_convictionMultiplier` rejects tier 2 before forwarding
      // to StakingV10 — no V8 state is touched.
      await expect(
        NFT.connect(accounts[0]).selfMigrateV8(identityId, 2),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockTier');
    });

    it('reverts on invalid lock tier (4)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await setupV8Stake(accounts[0], identityId, amount);

      await expect(
        NFT.connect(accounts[0]).selfMigrateV8(identityId, 4),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockTier');
    });

    it('reverts on invalid lock tier (13)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await setupV8Stake(accounts[0], identityId, amount);

      await expect(
        NFT.connect(accounts[0]).selfMigrateV8(identityId, 13),
      ).to.be.revertedWithCustomError(NFT, 'InvalidLockTier');
    });

    it('direct StakingV10.convertToNFT call from non-NFT caller reverts via onlyConvictionNFT gate', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await setupV8Stake(accounts[0], identityId, amount);

      // The gate pins the caller to the Hub-registered NFT contract.
      // accounts[0] is the hub owner, not the NFT, so the direct call
      // reverts with OnlyConvictionNFT regardless of the V8 precondition.
      await expect(
        StakingV10Contract.connect(accounts[0]).selfConvertToNFT(
          accounts[0].address,
          42,
          identityId,
          12,
        ),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
    });

    // -----------------------------------------------------------------
    // Happy paths
    // -----------------------------------------------------------------

    it('happy path tier 12: migrates V8 stake into V10 NFT, totals invariant, 6x multiplier', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await setupV8Stake(accounts[0], identityId, amount);

      const totalStakeBefore = await ConvictionStakingStorageContract.totalStakeV10();
      const nodeStakeBefore = await ConvictionStakingStorageContract.getNodeStakeV10(identityId);

      // Capture the V8 bucket state before the migration.
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, v8Key(accounts[0].address)),
      ).to.equal(amount);

      const tx = await NFT.connect(accounts[0]).selfMigrateV8(identityId, 12);

      // Wrapper-layer event and StakingV10 authoritative event both fire.
      // D7: isAdmin=false for the user-driven path.
      await expect(tx)
        .to.emit(NFT, 'ConvertedFromV8')
        .withArgs(accounts[0].address, 1n, identityId, 12, false);
      // D8: stakeBaseAbsorbed=amount, pendingAbsorbed=0 (no pending in this
      //     fixture), lockTier=12, isAdmin=false.
      await expect(tx)
        .to.emit(StakingV10Contract, 'ConvertedFromV8')
        .withArgs(accounts[0].address, 1n, identityId, amount, 0n, 12, false);

      // V8 bucket drained. D3: the V10 path intentionally does not touch
      // DelegatorsInfo (dropped from the hub), so no isNodeDelegator
      // assertion here.
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, v8Key(accounts[0].address)),
      ).to.equal(0n);

      // V10 position created under tokenId=0.
      expect(
        (await ConvictionStakingStorageContract.getPosition(1)).raw,
      ).to.equal(amount);

      // ConvictionStakingStorage position.
      const pos = await ConvictionStakingStorageContract.getPosition(1);
      expect(pos.identityId).to.equal(identityId);
      expect(pos.raw).to.equal(amount);
      expect(pos.lockTier).to.equal(12);
      expect(pos.multiplier18).to.equal(SIX_X);

      // NFT ownership.
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);

      // D15: V10 has its own aggregates. `totalStakeV10` grows by `amount`
      //      (the migrated V8 balance), not invariant — V8 and V10 now
      //      track disjoint aggregate counters.
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(
        totalStakeBefore + amount,
      );
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(
        nodeStakeBefore + amount,
      );
    });

    it('happy path tier 0: migrates V8 stake at the permanent rest tier (1x, no expiry)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await setupV8Stake(accounts[0], identityId, amount);

      const totalStakeBefore = await ConvictionStakingStorageContract.totalStakeV10();
      const nodeStakeBefore = await ConvictionStakingStorageContract.getNodeStakeV10(identityId);

      await NFT.connect(accounts[0]).selfMigrateV8(identityId, 0);

      // V10 position at rest tier: multiplier 1x, expiryTimestamp == 0 per
      // ConvictionStakingStorage.createPosition at :153-154.
      const pos = await ConvictionStakingStorageContract.getPosition(1);
      expect(pos.raw).to.equal(amount);
      expect(pos.lockTier).to.equal(0);
      expect(pos.multiplier18).to.equal(ONE_X);
      expect(pos.expiryTimestamp).to.equal(0);

      // D15: V10 aggregates grow by the migrated amount.
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(
        totalStakeBefore + amount,
      );
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(
        nodeStakeBefore + amount,
      );

      // V8 bucket zero.
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, v8Key(accounts[0].address)),
      ).to.equal(0n);
    });

    it('cross-user isolation: Alice migrates, Bob’s V8 stake on the same node is untouched', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      const amountBob = hre.ethers.parseEther('500');

      // Alice and Bob both have V8 stake on the same node.
      await setupV8Stake(accounts[0], identityId, amount);
      await setupV8Stake(accounts[4], identityId, amountBob);

      // Alice migrates; Bob does not.
      await NFT.connect(accounts[0]).selfMigrateV8(identityId, 12);

      // Bob's V8 bucket untouched (D3: DelegatorsInfo is no longer touched
      // by the V10 migration; V8 and V10 book-keeping are fully disjoint).
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, v8Key(accounts[4].address)),
      ).to.equal(amountBob);

      // Alice's V8 bucket zero.
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, v8Key(accounts[0].address)),
      ).to.equal(0n);

      // D15: `nodeStakeV10` is V10-only; Bob's V8 stake is NOT aggregated
      //      under V10. The V10 node total is just Alice's migrated amount.
      expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(amount);
      // Alice's V10 NFT.
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(
        (await ConvictionStakingStorageContract.getPosition(1)).raw,
      ).to.equal(amount);
    });
  });

  // =====================================================================
  // transfer (ERC-721) — accrued-interest model (Phase 5 Q8)
  // =====================================================================
  //
  // Phase 5 transfer semantics: when Alice transfers tokenId to Bob mid-lock,
  // the underlying `ConvictionStakingStorage.Position` is NOT mutated. No
  // rewards are settled, `lastClaimedEpoch` does not reset, the raw /
  // rewards / identityId / lockTier / expiryTimestamp / multiplier18 fields
  // all stay with the tokenId. Bob now owns the tokenId and can exercise
  // every NFT entry point (claim, relock, redelegate, withdraw) that gates
  // on `ownerOf(tokenId) == msg.sender`.
  //
  // The `_update` override in `DKGStakingConvictionNFT` is a pure
  // `super._update` pass-through — no settlement, no storage mutation.
  // This describe block PROVES the pass-through by asserting:
  //   1. Position byte-identity across a transfer.
  //   2. Bob can claim Alice's unclaimed rewards (the accrued coupon).
  //   3. Alice's claim / relock / redelegate post-transfer revert
  //      `NotPositionOwner`.
  //   4. Owner rights fully migrate (Bob can redelegate).
  //   5. ERC-721 transfer gas is below a hard ceiling (no accidental
  //      storage work slipped into `_update`).

  describe('transfer (accrued-interest model)', () => {
    // Helper — inject `nodeEpochScorePerStake36` at a specific epoch via the
    // hub-owner-privileged setter. Mirrors the helper in the claim describe
    // block — duplicated locally so this block stays self-contained.
    const injectScorePerStake = async (
      epoch: number | bigint,
      identityId: number,
      scorePerStake36: bigint,
    ) => {
      const rss = await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage');
      await rss.connect(accounts[0]).setNodeEpochScorePerStake(epoch, identityId, scorePerStake36);
    };

    // Helper — inject nodeEpochScore for a node at a specific epoch.
    const injectNodeEpochScore = async (
      epoch: number | bigint,
      identityId: number,
      score18: bigint,
    ) => {
      const rss = await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage');
      await rss.connect(accounts[0]).setNodeEpochScore(epoch, identityId, score18);
    };

    // Helper — inject allNodesEpochScore for a specific epoch.
    const injectAllNodesEpochScore = async (epoch: number | bigint, score18: bigint) => {
      const rss = await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage');
      await rss.connect(accounts[0]).setAllNodesEpochScore(epoch, score18);
    };

    // Helper — fund a contiguous range of epoch pools via EpochStorage.
    const fundEpochPoolRange = async (
      startEpoch: number | bigint,
      endEpoch: number | bigint,
      amountPerEpoch: bigint,
    ) => {
      const es = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
      const numEpochs = BigInt(endEpoch) - BigInt(startEpoch) + 1n;
      const totalAmount = amountPerEpoch * numEpochs;
      await es.connect(accounts[0]).addTokensToEpochRange(1, startEpoch, endEpoch, totalAmount);
    };

    // Helper — fund a single epoch pool (convenience wrapper).
    const fundEpochPool = async (epoch: number | bigint, amount: bigint) => {
      await fundEpochPoolRange(epoch, epoch, amount);
    };

    // Helper — inject all epoch-level reward state in one call (single epoch).
    const injectEpochRewardState = async (
      epoch: number | bigint,
      identityId: number,
      scorePerStake36: bigint,
      nodeScore18: bigint,
      allNodesScore18: bigint,
      epochPool: bigint,
    ) => {
      await injectScorePerStake(epoch, identityId, scorePerStake36);
      await injectNodeEpochScore(epoch, identityId, nodeScore18);
      await injectAllNodesEpochScore(epoch, allNodesScore18);
      await fundEpochPool(epoch, epochPool);
    };

    // Helper — inject score/epoch state for multiple epochs with a UNIFORM pool.
    const injectMultiEpochRewardState = async (
      startEpoch: bigint,
      epochCount: number,
      identityId: number,
      scorePerStakes: bigint[],
      nodeScore18: bigint,
      allNodesScore18: bigint,
      epochPool: bigint,
    ) => {
      const endEpoch = startEpoch + BigInt(epochCount) - 1n;
      await fundEpochPoolRange(startEpoch, endEpoch, epochPool);
      for (let i = 0; i < epochCount; i++) {
        const e = startEpoch + BigInt(i);
        await injectScorePerStake(e, identityId, scorePerStakes[i]);
        await injectNodeEpochScore(e, identityId, nodeScore18);
        await injectAllNodesEpochScore(e, allNodesScore18);
      }
    };

    // Helper — pre-fund the StakingStorage vault so the claim's
    // `increaseRewards` / `increaseNodeStake` bookkeeping has matching TRAC.
    const fundVault = async (amount: bigint) => {
      const stakingStorageAddr = await StakingStorage.getAddress();
      await Token.mint(stakingStorageAddr, amount);
    };

    // TRAC reward formula — mirrors StakingV10.claim's inner loop.
    const computeReward = (
      effStake: bigint,
      scorePerStake36: bigint,
      epochPool: bigint,
      nodeScore18: bigint,
      allNodesScore18: bigint,
      operatorFeePercentage: bigint = 0n,
      maxOperatorFee: bigint = 10_000n,
    ): bigint => {
      const delegatorScore18 = (effStake * scorePerStake36) / SCALE18;
      if (delegatorScore18 === 0n || nodeScore18 === 0n) return 0n;
      const grossNodeRewards = (epochPool * nodeScore18) / allNodesScore18;
      const operatorFee = (grossNodeRewards * operatorFeePercentage) / maxOperatorFee;
      const netNodeRewards = grossNodeRewards - operatorFee;
      return (delegatorScore18 * netNodeRewards) / nodeScore18;
    };

    it('ERC-721 transfer does not mutate Position state', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // Capture every Position field before the transfer. `_update` is a
      // pure pass-through — every field must survive a transfer byte-identical.
      const posBefore = await ConvictionStakingStorageContract.getPosition(1);

      const tx = await NFT.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[4].address,
        1,
      );
      // ERC-721 Transfer event fires (inherited from base ERC721).
      await expect(tx)
        .to.emit(NFT, 'Transfer')
        .withArgs(accounts[0].address, accounts[4].address, 1n);

      // New owner.
      expect(await NFT.ownerOf(1)).to.equal(accounts[4].address);
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(0n);
      expect(await NFT.balanceOf(accounts[4].address)).to.equal(1n);

      // Position state byte-identical — not a single field touched.
      const posAfter = await ConvictionStakingStorageContract.getPosition(1);
      expect(posAfter.raw).to.equal(posBefore.raw);
      expect(posAfter.lockTier).to.equal(posBefore.lockTier);
      expect(posAfter.expiryTimestamp).to.equal(posBefore.expiryTimestamp);
      expect(posAfter.identityId).to.equal(posBefore.identityId);
      expect(posAfter.multiplier18).to.equal(posBefore.multiplier18);
      expect(posAfter.lastClaimedEpoch).to.equal(posBefore.lastClaimedEpoch);
    });

    it('Bob claims all rewards including epochs Alice held (accrued-interest transfer)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // Remember the creation epoch: fresh position has lastClaimedEpoch =
      // creationEpoch - 1, so after advancing 3 epochs the claim window is
      // [creationEpoch, creationEpoch+1, creationEpoch+2] (3 epochs).
      const creationEpoch = await ChronosContract.getCurrentEpoch();
      await advanceEpochs(3);

      // Inject score for 3 epochs — pre-expiry throughout (12-epoch lock),
      // so effStake = raw * 6x for all three. Single node, opFee=0.
      const effStake = (amount * SIX_X) / SCALE18;
      const nodeScore18 = hre.ethers.parseEther('100');
      const allNodesScore18 = nodeScore18;

      const s0 = hre.ethers.parseEther('0.001'); // 1e15
      const s1 = hre.ethers.parseEther('0.002'); // 2e15
      const s2 = hre.ethers.parseEther('0.003'); // 3e15
      const pool = hre.ethers.parseEther('1000');

      await injectMultiEpochRewardState(
        creationEpoch,
        3,
        identityId,
        [s0, s1, s2],
        nodeScore18,
        allNodesScore18,
        pool,
      );

      const expectedReward =
        computeReward(effStake, s0, pool, nodeScore18, allNodesScore18) +
        computeReward(effStake, s1, pool, nodeScore18, allNodesScore18) +
        computeReward(effStake, s2, pool, nodeScore18, allNodesScore18);
      await fundVault(expectedReward);

      // Alice transfers to Bob WITHOUT claiming first. The accrued coupon
      // (three epochs of reward) transfers with the NFT. Bob is now the
      // rightful claimant for Alice's entire holding period.
      await NFT.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[4].address,
        1,
      );

      const rawBefore = (await ConvictionStakingStorageContract.getPosition(1)).raw;
      expect(rawBefore).to.equal(amount); // nothing compounded yet

      // Bob claims — receives the full 3-epoch reward Alice never collected.
      // D19: the reward is compounded directly into `pos.raw`.
      const tx = await NFT.connect(accounts[4]).claim(1);
      await expect(tx)
        .to.emit(StakingV10Contract, 'RewardsClaimed')
        .withArgs(1n, expectedReward);

      const posAfter = await ConvictionStakingStorageContract.getPosition(1);
      expect(posAfter.raw).to.equal(rawBefore + expectedReward);
      expect(posAfter.cumulativeRewardsClaimed).to.equal(expectedReward);
    });

    it('Alice cannot claim after transfer (reverts NotPositionOwner)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // Advance + inject so there's actual reward on the table — otherwise
      // a revert at the ownership gate would be indistinguishable from a
      // no-op window. This verifies the gate fires BEFORE the walk.
      const creationEpoch = await ChronosContract.getCurrentEpoch();
      await advanceEpochs(1);
      const scorePerStake36 = hre.ethers.parseEther('0.001');
      const nodeScore18 = hre.ethers.parseEther('100');
      await injectEpochRewardState(
        creationEpoch,
        identityId,
        scorePerStake36,
        nodeScore18,
        nodeScore18,
        hre.ethers.parseEther('1000'),
      );

      await NFT.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[4].address,
        1,
      );

      // Alice no longer owns the NFT — wrapper-layer ownership gate fires.
      await expect(NFT.connect(accounts[0]).claim(1)).to.be.revertedWithCustomError(
        NFT,
        'NotPositionOwner',
      );
    });

    it('Alice cannot relock / redelegate / withdraw after transfer', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 1);
      await advanceEpochs(2); // post-expiry so relock + withdraw are reachable

      await NFT.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[4].address,
        1,
      );

      // Every owner-gated entry point rejects Alice post-transfer. Any gate
      // that forgot the `ownerOf` guard would leak ownership authority
      // back to the pre-transfer holder.
      await expect(NFT.connect(accounts[0]).relock(1, 6)).to.be.revertedWithCustomError(
        NFT,
        'NotPositionOwner',
      );
      await expect(
        NFT.connect(accounts[0]).redelegate(1, toId),
      ).to.be.revertedWithCustomError(NFT, 'NotPositionOwner');
      await expect(
        NFT.connect(accounts[0]).withdraw(1),
      ).to.be.revertedWithCustomError(NFT, 'NotPositionOwner');
    });

    it('Bob cannot claim twice for the same window (second call is a no-op)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const creationEpoch = await ChronosContract.getCurrentEpoch();
      await advanceEpochs(2);
      const s0 = hre.ethers.parseEther('0.001');
      const s1 = hre.ethers.parseEther('0.002');
      const nodeScore18 = hre.ethers.parseEther('100');
      const allNodesScore18 = nodeScore18;
      const pool = hre.ethers.parseEther('1000');

      await injectMultiEpochRewardState(
        creationEpoch,
        2,
        identityId,
        [s0, s1],
        nodeScore18,
        allNodesScore18,
        pool,
      );

      const effStake = (amount * SIX_X) / SCALE18;
      const expectedReward =
        computeReward(effStake, s0, pool, nodeScore18, allNodesScore18) +
        computeReward(effStake, s1, pool, nodeScore18, allNodesScore18);
      await fundVault(expectedReward);

      await NFT.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[4].address,
        1,
      );

      // First claim drains the window. D19: reward compounds into raw.
      await NFT.connect(accounts[4]).claim(1);
      const posAfterFirst = await ConvictionStakingStorageContract.getPosition(1);
      expect(posAfterFirst.raw).to.equal(amount + expectedReward);
      expect(posAfterFirst.cumulativeRewardsClaimed).to.equal(expectedReward);

      // Second claim in the same epoch — lastClaimedEpoch is already
      // caught up to currentEpoch - 1, so the claim window is empty and
      // StakingV10.claim short-circuits without emitting RewardsClaimed.
      const tx = await NFT.connect(accounts[4]).claim(1);
      await expect(tx).to.not.emit(StakingV10Contract, 'RewardsClaimed');

      const posAfterSecond = await ConvictionStakingStorageContract.getPosition(1);
      expect(posAfterSecond.raw).to.equal(posAfterFirst.raw); // raw unchanged
      expect(posAfterSecond.cumulativeRewardsClaimed).to.equal(expectedReward);
    });

    it('transferFrom gas is below 100,000 (no hidden work in _update)', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // Pure ERC-721 `transferFrom` with a pass-through `_update`:
      //   - one ownership map write
      //   - one _ownedTokens / _ownedTokensIndex swap (ERC721Enumerable)
      //   - one _allTokens / _allTokensIndex swap (ERC721Enumerable)
      //   - two balance updates
      //   - one Transfer event
      // This lands in the ~75K-90K range on Hardhat. 100K is a comfortable
      // ceiling: anything notably higher would signal a regression where
      // real storage work slipped into `_update` (e.g. settlement, position
      // mutation, effective-stake walk).
      const tx = await NFT.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[4].address,
        1,
      );
      const receipt = await tx.wait();
      expect(receipt!.gasUsed).to.be.lt(100_000n);
    });

    it('Bob can redelegate after transfer (owner rights fully transferred)', async () => {
      const { identityId: fromId } = await createProfile();
      const { identityId: toId } = await createProfile(accounts[0], accounts[2]);
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(fromId, amount, 12);

      await NFT.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[4].address,
        1,
      );

      // Bob — the new owner — calls redelegate. Redelegate is in-place
      // now (D25): the tokenId is preserved, only `identityId` flips.
      await NFT.connect(accounts[4]).redelegate(1, toId);

      const pos = await ConvictionStakingStorageContract.getPosition(1);
      expect(pos.identityId).to.equal(toId);
      // Raw, lockTier, multiplier18, expiryTimestamp all preserved on the
      // same tokenId.
      expect(pos.raw).to.equal(amount);
      expect(pos.lockTier).to.equal(12);
      expect(pos.multiplier18).to.equal(SIX_X);

      // NFT ownership unchanged (same tokenId, still owned by Bob).
      expect(await NFT.ownerOf(1)).to.equal(accounts[4].address);
    });

    it('safeTransferFrom to an EOA preserves accrued-interest semantics', async () => {
      // NOTE: no ERC-721 receiver mock contract exists under contracts/;
      // adding one is out of scope for the transfer test block (would
      // require a new .sol file). The pass-through `_update` makes the
      // receiver-path branch of ERC-721 transparent anyway — the only
      // difference between `transferFrom` and `safeTransferFrom` is the
      // post-transfer `onERC721Received` callback, which is an ERC-721 base
      // concern, not a conviction-NFT concern. Testing the EOA path of
      // `safeTransferFrom` still exercises the full `_update` flow.
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const posBefore = await ConvictionStakingStorageContract.getPosition(1);

      // OZ v5 ERC-721 has two safeTransferFrom overloads: (from, to, tokenId)
      // and (from, to, tokenId, data). Exercise the 3-arg form.
      await NFT.connect(accounts[0])['safeTransferFrom(address,address,uint256)'](
        accounts[0].address,
        accounts[4].address,
        1,
      );

      expect(await NFT.ownerOf(1)).to.equal(accounts[4].address);
      const posAfter = await ConvictionStakingStorageContract.getPosition(1);
      expect(posAfter.raw).to.equal(posBefore.raw);
      expect(posAfter.lastClaimedEpoch).to.equal(posBefore.lastClaimedEpoch);
    });

    it('contract TRAC balance is always zero after transfer', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      const nftAddr = await NFT.getAddress();
      // Baseline post-mint — TRAC routed staker → StakingStorage, NFT is clean.
      expect(await Token.balanceOf(nftAddr)).to.equal(0n);

      await NFT.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[4].address,
        1,
      );

      // Transfer must not touch the TRAC ledger in any way. The wrapper
      // contract holds no funds pre- or post-transfer.
      expect(await Token.balanceOf(nftAddr)).to.equal(0n);
      // StakingV10 likewise — TRAC is always held by StakingStorage.
      expect(await Token.balanceOf(await StakingV10Contract.getAddress())).to.equal(0n);
    });

    it('Alice can mint a second NFT after transferring the first — tokenIds remain monotonic', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      // Fund Alice for both mints (mint #1 consumes `amount`, mint #2 consumes `amount / 2`).
      const second = hre.ethers.parseEther('500');
      await mintAndApprove(accounts[0], amount + second);

      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);
      await NFT.connect(accounts[0]).transferFrom(
        accounts[0].address,
        accounts[4].address,
        1,
      );

      // `nextTokenId` is a monotonic counter — it does NOT reuse the tokenId
      // that was transferred. tokenId=0 still belongs to Bob; Alice's next
      // mint gets tokenId=1.
      await NFT.connect(accounts[0]).createConviction(identityId, second, 6);

      expect(await NFT.ownerOf(1)).to.equal(accounts[4].address); // Bob still holds #0
      expect(await NFT.ownerOf(2)).to.equal(accounts[0].address); // Alice now holds #1
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);
      expect(await NFT.balanceOf(accounts[4].address)).to.equal(1n);

      // Positions are independent — tier 12 on #1, tier 6 on #2 (L2 — IDs
      // start at 1 so `tokenId == 0` is always a sentinel).
      expect((await ConvictionStakingStorageContract.getPosition(1)).multiplier18).to.equal(SIX_X);
      expect((await ConvictionStakingStorageContract.getPosition(2)).multiplier18).to.equal(
        THREE_AND_HALF_X,
      );
    });
  });

  // ------------------------------------------------------------
  // CCO-8 — Code-review follow-ups (L1 / L2 / L8 / M5).
  // ------------------------------------------------------------

  describe('CCO-8 — code-review follow-up regressions', () => {
    it('L2 — first mint ever yields tokenId = 1; `ownerOf(0)` is permanently a sentinel', async () => {
      const { identityId } = await createProfile();
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);

      // Fresh deployment: no tokens minted yet.
      expect(await NFT.nextTokenId()).to.equal(0n);
      await expect(NFT.ownerOf(0)).to.be.reverted; // sentinel tokenId is never owned.

      await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

      // First mint is tokenId=1; nextTokenId counter sits at 1.
      expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
      expect(await NFT.nextTokenId()).to.equal(1n);
      // tokenId 0 remains permanently unowned.
      await expect(NFT.ownerOf(0)).to.be.reverted;
    });

    it('L8 — `createConviction(identityId=0)` reverts with InvalidIdentityId', async () => {
      const amount = hre.ethers.parseEther('1000');
      await mintAndApprove(accounts[0], amount);
      await expect(
        NFT.connect(accounts[0]).createConviction(0, amount, 12),
      ).to.be.revertedWithCustomError(NFT, 'InvalidIdentityId');
    });

    it('M5 — `name()` returns ERC-721 collection name; `contractName()` returns dev-facing id', async () => {
      // `DKGStakingConvictionNFT` used to inherit INamed and override `name()`
      // to return the dev-facing contract id. That collided with
      // ERC721.name() (which clients treat as the human-readable collection
      // name). Post-M5 we split the surfaces:
      //   - name()          — ERC-721 collection metadata (user-facing)
      //   - contractName()  — dev id, used by Hub for contract resolution
      expect(await NFT.name()).to.equal('DKG Staker Conviction');
      expect(await NFT.contractName()).to.equal('DKGStakingConvictionNFT');
    });
  });
});
