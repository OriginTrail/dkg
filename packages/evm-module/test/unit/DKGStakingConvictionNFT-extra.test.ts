/**
 * DKGStakingConvictionNFT-extra.test.ts — audit coverage for V10 staking NFT.
 *
 * V10 staking surface (post-Phase 5 rename):
 *   - Mint: `createConviction(identityId, amount, lockTier)` returns tokenId.
 *     Pulls TRAC via `StakingV10.stake` → `transferFrom(staker, stakingStorage, amount)`.
 *   - Withdraw: `withdraw(tokenId)` is FULL-only by design (Q1 in the contract
 *     comments). Auto-claims rewards inside `StakingV10.withdraw` then drains
 *     all staked TRAC and burns the NFT in a single tx. There is no `unstake`
 *     primitive and no partial-withdraw: a user wanting to keep some TRAC
 *     staked withdraws and re-stakes the remainder (tier 0, 1x, no lock is
 *     effectively liquid).
 *
 * Findings covered:
 *   - E-2  (CRITICAL, SPEC-GAP): full withdraw matrix — `LockStillActive`
 *     before expiry, success after expiry, `NotPositionOwner` for non-owner,
 *     non-existent tokenId reverts, second withdraw on the same id reverts
 *     (no double-spend).
 *   - E-16 (MEDIUM, TEST-DEBT): the live StakingStorage wire is exercised
 *     end-to-end — `createConviction` MUST move TRAC into StakingStorage and
 *     bump `getNodeStakeV10(identityId)` (Phase-4 placeholder behavior is
 *     gone in V10; this asserts the post-rename delegation).
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { randomBytes } from 'crypto';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  Hub,
  Profile,
  StakingStorage,
  StakingV10,
  Token,
} from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  StakingV10: StakingV10;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  Profile: Profile;
  Token: Token;
  Chronos: Chronos;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(['DKGStakingConvictionNFT', 'StakingV10', 'Profile']);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const NFT = await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT');
  const StakingV10 = await hre.ethers.getContract<StakingV10>('StakingV10');
  const StakingStorage = await hre.ethers.getContract<StakingStorage>('StakingStorage');
  const ConvictionStakingStorage = await hre.ethers.getContract<ConvictionStakingStorage>(
    'ConvictionStakingStorage',
  );
  const Profile = await hre.ethers.getContract<Profile>('Profile');
  const Token = await hre.ethers.getContract<Token>('Token');
  const Chronos = await hre.ethers.getContract<Chronos>('Chronos');

  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    NFT,
    StakingV10,
    StakingStorage,
    ConvictionStakingStorage,
    Profile,
    Token,
    Chronos,
  };
}

describe('@unit DKGStakingConvictionNFT — extra audit coverage (E-2, E-16)', () => {
  let accounts: SignerWithAddress[];
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;
  let StakingStorageContract: StakingStorage;
  let ConvictionStakingStorageContract: ConvictionStakingStorage;
  let ProfileContract: Profile;
  let TokenContract: Token;
  let ChronosContract: Chronos;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      NFT,
      StakingV10: StakingV10Contract,
      StakingStorage: StakingStorageContract,
      ConvictionStakingStorage: ConvictionStakingStorageContract,
      Profile: ProfileContract,
      Token: TokenContract,
      Chronos: ChronosContract,
    } = await loadFixture(deployFixture));
  });

  // Mint a fresh Profile node and return its identityId. Uses random node
  // material so back-to-back tests don't collide on the same nodeId.
  async function createProfile(
    admin: SignerWithAddress = accounts[0],
    operational: SignerWithAddress = accounts[1],
  ): Promise<number> {
    const nodeId = '0x' + randomBytes(32).toString('hex');
    const tx = await ProfileContract.connect(operational).createProfile(
      admin.address,
      [],
      `Node ${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    return Number(receipt!.logs[0].topics[1]);
  }

  // Mint TRAC to `staker` and approve StakingV10 — V10 NFT is wrapper-only,
  // TRAC flows staker → StakingV10 → StakingStorage; the NFT itself never
  // holds tokens. Mirrors the helper used by DKGStakingConvictionNFT.test.ts.
  async function mintAndApprove(staker: SignerWithAddress, amount: bigint): Promise<void> {
    await TokenContract.mint(staker.address, amount);
    await TokenContract.connect(staker).approve(await StakingV10Contract.getAddress(), amount);
  }

  // Advance block time past `n` full Chronos epochs so getCurrentEpoch()
  // crosses the lock-tier boundary inside StakingV10.withdraw.
  async function advanceEpochs(n: number): Promise<void> {
    const epochLength = await ChronosContract.epochLength();
    await time.increase(Number(epochLength) * n);
  }

  // ======================================================================
  // E-16 — live StakingStorage wire (no EOA stub, no Phase-4 placeholder).
  // ======================================================================
  describe('E-16: live StakingStorage wire (real contract, not an EOA stub)', () => {
    it('NFT.stakingStorage() resolves to the deployed StakingStorage contract', async () => {
      const ssAddr = await NFT.stakingStorage();
      expect(ssAddr).to.equal(await StakingStorageContract.getAddress());

      const code = await hre.ethers.provider.getCode(ssAddr);
      // EOA has code '0x'; a real contract has non-empty runtime.
      expect(code.length).to.be.gt(2);
    });

    it('createConviction delegates to StakingV10 and updates V10 stake aggregates (V10 path, not Phase-4 placeholder)', async () => {
      const identityId = await createProfile();
      const amount = hre.ethers.parseEther('50000');
      await mintAndApprove(accounts[0], amount);

      const totalV10Before = await ConvictionStakingStorageContract.totalStakeV10();
      const nodeStakeV10Before =
        await ConvictionStakingStorageContract.getNodeStakeV10(identityId);
      const stakerBalBefore = await TokenContract.balanceOf(accounts[0].address);

      await NFT.connect(accounts[0]).createConviction(identityId, amount, 6);

      // V10 contract: createConviction delegates through StakingV10.stake
      // which writes the V10 stake aggregates in ConvictionStakingStorage
      // (NOT a Phase-4 placeholder that would leave them at zero). This is
      // the structural assertion that the Phase 5 wiring is live.
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(
        totalV10Before + amount,
      );
      expect(
        await ConvictionStakingStorageContract.getNodeStakeV10(identityId),
      ).to.equal(nodeStakeV10Before + amount);

      // TRAC flowed out of the staker (StakingV10.stake's transferFrom).
      // NFT contract itself holds zero TRAC — D9, assets live in
      // StakingStorage, not the wrapper.
      expect(await TokenContract.balanceOf(accounts[0].address)).to.equal(
        stakerBalBefore - amount,
      );
      expect(await TokenContract.balanceOf(await NFT.getAddress())).to.equal(0n);
    });
  });

  // ======================================================================
  // E-2 — withdraw matrix. V10 withdraw is FULL-only by design.
  // ======================================================================
  describe('E-2: withdraw full matrix (V10 full-only design — no partial)', () => {
    // Helper: stake `amount` from `staker` against `identityId` at `lockTier`
    // and return the freshly minted tokenId. Uses the wrapper event so we
    // don't have to track nextTokenId manually.
    async function stakeAs(
      staker: SignerWithAddress,
      identityId: number,
      amount: bigint,
      lockTier: number,
    ): Promise<bigint> {
      await mintAndApprove(staker, amount);
      const tx = await NFT.connect(staker).createConviction(identityId, amount, lockTier);
      const receipt = await tx.wait();
      const topic = NFT.interface.getEvent('PositionCreated').topicHash;
      const log = receipt!.logs.find((l) => l.topics[0] === topic)!;
      return BigInt(log.topics[2]);
    }

    it('withdraw reverts LockStillActive before the lock expires', async () => {
      const identityId = await createProfile();
      const amount = hre.ethers.parseEther('50000');
      const tokenId = await stakeAs(accounts[0], identityId, amount, 6);

      // Lock tier 6 = 180-day lock (~6 epochs in V10 default mapping). Fresh
      // fixture is at epoch 1 immediately after deploy, so withdraw inside
      // the window must revert via StakingV10.withdraw's lock check.
      await expect(NFT.connect(accounts[0]).withdraw(tokenId)).to.be.revertedWithCustomError(
        StakingV10Contract,
        'LockStillActive',
      );
    });

    it('full withdraw burns the NFT, clears the V10 stake aggregates, returns TRAC to the owner', async () => {
      const identityId = await createProfile();
      const amount = hre.ethers.parseEther('100000');
      const tokenId = await stakeAs(accounts[0], identityId, amount, 1);

      await advanceEpochs(2);

      const ownerBalBefore = await TokenContract.balanceOf(accounts[0].address);
      const totalV10Before = await ConvictionStakingStorageContract.totalStakeV10();
      const nodeStakeV10Before =
        await ConvictionStakingStorageContract.getNodeStakeV10(identityId);

      await NFT.connect(accounts[0]).withdraw(tokenId);

      // ERC-721 ownerOf reverts for burned tokens.
      await expect(NFT.ownerOf(tokenId)).to.be.reverted;
      expect(await NFT.balanceOf(accounts[0].address)).to.equal(0n);

      // V10 stake aggregates drop by `amount` (full withdraw, no partial
      // semantics in V10).
      expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(
        totalV10Before - amount,
      );
      expect(
        await ConvictionStakingStorageContract.getNodeStakeV10(identityId),
      ).to.equal(nodeStakeV10Before - amount);

      // Full TRAC accounting: V10 withdraw is full-only and rewards are
      // auto-claimed inside StakingV10.withdraw, so the unstake leg moves
      // exactly the staked principal back to the owner.
      expect(await TokenContract.balanceOf(accounts[0].address)).to.equal(
        ownerBalBefore + amount,
      );
    });

    it('non-owner withdraw reverts NotPositionOwner', async () => {
      const identityId = await createProfile();
      const amount = hre.ethers.parseEther('50000');
      const tokenId = await stakeAs(accounts[0], identityId, amount, 1);
      await advanceEpochs(2);

      // Wrapper-layer ownership gate fires BEFORE we reach StakingV10, so
      // we expect the NFT's NotPositionOwner (not StakingV10's) error.
      await expect(NFT.connect(accounts[4]).withdraw(tokenId)).to.be.revertedWithCustomError(
        NFT,
        'NotPositionOwner',
      );
    });

    it('withdraw on a non-existent tokenId reverts (ERC-721 ownerOf gate)', async () => {
      // No stake -> tokenId 999 doesn't exist. The NFT's `ownerOf(tokenId)`
      // check fails first (ERC-721 ERC721NonexistentToken).
      await expect(NFT.connect(accounts[0]).withdraw(999)).to.be.reverted;
    });

    it('double-withdraw on the same tokenId reverts (no replay after burn)', async () => {
      const identityId = await createProfile();
      const amount = hre.ethers.parseEther('10000');
      const tokenId = await stakeAs(accounts[0], identityId, amount, 1);
      await advanceEpochs(2);

      // First withdraw burns the NFT; second call must fail because there's
      // no longer an owner to clear the wrapper-layer gate.
      await NFT.connect(accounts[0]).withdraw(tokenId);
      await expect(NFT.connect(accounts[0]).withdraw(tokenId)).to.be.reverted;
    });

    it('sanity: createConviction works for a non-deployer signer (fresh staker funded by accounts[0])', async () => {
      const identityId = await createProfile();
      const amount = hre.ethers.parseEther('25000');
      const tokenId = await stakeAs(accounts[3], identityId, amount, 1);
      expect(await NFT.ownerOf(tokenId)).to.equal(accounts[3].address);
    });
  });
});
