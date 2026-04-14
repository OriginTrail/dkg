import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
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
    } = await loadFixture(deployFixture));
  });

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
});
