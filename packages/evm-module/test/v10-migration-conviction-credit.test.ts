// =============================================================================
// V8→V10 migration conviction credit
// =============================================================================
//
// Background
// ----------
// V10 launches after a multi-month V8 migration window. Delegators who
// maintained continuous V8 stake on a node for the 60 days preceding launch
// and elect a high-conviction V10 tier (6m or 12m) get their V10 lock
// shortened by 60 days as a "thank-you" for the V8 conviction we cannot
// otherwise prove on-chain at migration time.
//
// On-chain pieces
// ---------------
//   * `V8MigrationEligibility` — frozen registry of `(identityId, delegator)`
//     pairs that the off-chain snapshot script certified as continuous-V8.
//     Must be `frozen()` before any migration can apply the credit.
//   * `ConvictionStakingStorage.createPosition` — gained an
//     `expiryShortenedBy` parameter (v4.1.0); gated on `migrationEpoch != 0`
//     so the V8→V10 bonus cannot leak into fresh V10 stakes.
//   * `StakingV10._convertToNFT` — reads the (frozen) registry and, for
//     eligible 6m/12m migrants, passes a fixed `60 days` as
//     `expiryShortenedBy` (v3.1.0). The literal matches the off-chain
//     eligibility window and is independent of network-tuned
//     `chronos.epochLength`.
//
// What this file tests
// --------------------
//   1. Eligible 6m/12m migrants get a 60-day-earlier expiry; ineligible
//      migrants and lower-tier migrants get the default expiry.
//   2. Boost amount is unchanged — only the WINDOW is shortened. Magnitude
//      of `runningNodeEffectiveStake` and `nodeExpiryDrop` match the
//      no-credit baseline.
//   3. The registry's `frozen` flag locks out further uploads.

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
  StakingStorage,
  StakingV10,
  Token,
  V8MigrationEligibility,
} from '../typechain';

const SCALE18 = 10n ** 18n;
const SIX_X = 6n * SCALE18;
const THREE_AND_HALF_X = (35n * SCALE18) / 10n;
// 60-day credit, in seconds. Hard-coded literal (StakingV10 3.1.0 review
// follow-up): the off-chain V8MigrationEligibility window is a fixed
// 60-day wall-clock window before V10 launch; the on-chain credit must
// match independent of network-tuned epochLength (devnet: 1h; testnet: 1d).
const SIXTY_DAYS_SECONDS = 60n * 24n * 60n * 60n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  StakingV10: StakingV10;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  ParametersStorage: ParametersStorage;
  Profile: Profile;
  Token: Token;
  Chronos: Chronos;
  V8MigrationEligibility: V8MigrationEligibility;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'DKGStakingConvictionNFT',
    'StakingV10',
    'Profile',
    'V8MigrationEligibility',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingStorage: await hre.ethers.getContract<StakingStorage>(
      'StakingStorage',
    ),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    ),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>(
      'ParametersStorage',
    ),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    V8MigrationEligibility: await hre.ethers.getContract<V8MigrationEligibility>(
      'V8MigrationEligibility',
    ),
  };
}

describe('@integration V8→V10 migration conviction credit', function () {
  let accounts: SignerWithAddress[];
  let NFT: DKGStakingConvictionNFT;
  let SS: StakingStorage;
  let CSS: ConvictionStakingStorage;
  let ProfileContract: Profile;
  let TokenContract: Token;
  let ChronosContract: Chronos;
  let RegistryContract: V8MigrationEligibility;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      NFT,
      StakingStorage: SS,
      ConvictionStakingStorage: CSS,
      Profile: ProfileContract,
      Token: TokenContract,
      Chronos: ChronosContract,
      V8MigrationEligibility: RegistryContract,
    } = await loadFixture(deployFixture));
  });

  // -------------------------------------------------------------------------
  // Helpers (cloned from v10-converttonft-drain-fix.test.ts so the two files
  // remain self-contained and can be removed independently)
  // -------------------------------------------------------------------------

  // Each profile is created from a fresh operational wallet (`accounts[opIdx]`)
  // because Profile.createProfile keys identities by `msg.sender` and rejects
  // a second profile from the same operational caller.
  const createProfile = async (opIdx = 1) => {
    const nodeId = hre.ethers.hexlify(hre.ethers.randomBytes(32));
    const tx = await ProfileContract.connect(accounts[opIdx]).createProfile(
      accounts[0].address,
      [],
      `Node-${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    return Number(receipt!.logs[0].topics[1]);
  };

  const seedV8Stake = async (
    delegator: SignerWithAddress,
    identityId: number,
    stakeBase: bigint,
  ) => {
    const v8Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [delegator.address]),
    );
    await TokenContract.mint(await SS.getAddress(), stakeBase);
    await SS.connect(accounts[0]).increaseDelegatorStakeBase(
      identityId,
      v8Key,
      stakeBase,
    );
    await SS.connect(accounts[0]).increaseNodeStake(identityId, stakeBase);
    await SS.connect(accounts[0]).increaseTotalStake(stakeBase);
    return v8Key;
  };

  // -------------------------------------------------------------------------
  // Registry lifecycle
  // -------------------------------------------------------------------------

  describe('V8MigrationEligibility lifecycle', () => {
    it('Has the expected name and version', async () => {
      expect(await RegistryContract.name()).to.equal('V8MigrationEligibility');
      expect(await RegistryContract.version()).to.equal('10.0.2');
    });

    it('setEligibleBatch records pairs and bumps the counter, idempotently', async () => {
      const ids = [1n, 2n, 3n];
      const addrs = [
        accounts[2].address,
        accounts[3].address,
        accounts[4].address,
      ];

      await expect(RegistryContract.connect(accounts[0]).setEligibleBatch(ids, addrs))
        .to.emit(RegistryContract, 'EligibilitySet')
        .withArgs(ids[0], addrs[0])
        .and.to.emit(RegistryContract, 'EligibilitySet')
        .withArgs(ids[1], addrs[1])
        .and.to.emit(RegistryContract, 'EligibilitySet')
        .withArgs(ids[2], addrs[2]);

      expect(await RegistryContract.eligibleCount()).to.equal(3n);
      for (let i = 0; i < ids.length; i++) {
        expect(await RegistryContract.isEligible(ids[i], addrs[i])).to.equal(true);
      }

      // Re-uploading the same set is idempotent — counter unchanged, no
      // additional events emitted.
      const tx = await RegistryContract.connect(accounts[0]).setEligibleBatch(
        ids,
        addrs,
      );
      const r = await tx.wait();
      const log = r!.logs.filter(
        (l) => 'fragment' in l && (l as { fragment: { name: string } }).fragment.name === 'EligibilitySet',
      );
      expect(log.length).to.equal(0);
      expect(await RegistryContract.eligibleCount()).to.equal(3n);
    });

    it('setEligibleBatch rejects mismatched array lengths and zero entries', async () => {
      await expect(
        RegistryContract.setEligibleBatch([1n], [accounts[1].address, accounts[2].address]),
      ).to.be.revertedWith('Length mismatch');
      await expect(
        RegistryContract.setEligibleBatch([0n], [accounts[1].address]),
      ).to.be.revertedWith('Zero identityId');
      await expect(
        RegistryContract.setEligibleBatch([1n], [hre.ethers.ZeroAddress]),
      ).to.be.revertedWith('Zero delegator');
    });

    it('freeze locks out further uploads; second freeze reverts', async () => {
      await RegistryContract.setEligibleBatch([1n], [accounts[2].address]);
      await expect(RegistryContract.freeze())
        .to.emit(RegistryContract, 'Frozen');
      expect(await RegistryContract.frozen()).to.equal(true);

      await expect(
        RegistryContract.setEligibleBatch([2n], [accounts[3].address]),
      ).to.be.revertedWith('Registry frozen');
      await expect(RegistryContract.freeze()).to.be.revertedWith('Already frozen');
    });

    it('Only HubOwner can mutate', async () => {
      await expect(
        RegistryContract.connect(accounts[2]).setEligibleBatch(
          [1n],
          [accounts[2].address],
        ),
      ).to.be.reverted; // HubLib.UnauthorizedAccess
      await expect(
        RegistryContract.connect(accounts[2]).freeze(),
      ).to.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // Migration credit application
  // -------------------------------------------------------------------------

  describe('StakingV10._convertToNFT credit application', () => {
    const migrationAmount = hre.ethers.parseEther('5000');

    it('Eligible delegator + tier 12: V10 expiry is 60d before tier default; boost magnitude unchanged', async () => {
      const identityId = await createProfile();
      await seedV8Stake(accounts[2], identityId, migrationAmount);
      await RegistryContract.setEligibleBatch([identityId], [accounts[2].address]);
      await RegistryContract.freeze();

      const tier12Duration = 366n * 24n * 60n * 60n;

      // selfMigrateV8 with tier 12.
      const tx = await NFT.connect(accounts[2]).selfMigrateV8(identityId, 12);
      const receipt = await tx.wait();
      const blockTs = BigInt(
        (await hre.ethers.provider.getBlock(receipt!.blockNumber))!.timestamp,
      );

      const pos = await CSS.getPosition(1);
      const tierDefault = blockTs + tier12Duration;
      const expectedExpiry = tierDefault - SIXTY_DAYS_SECONDS;
      expect(pos.expiryTimestamp).to.equal(
        expectedExpiry,
        'eligible 12m migrant expiry must be 60d before tier default',
      );
      expect(pos.lockTier).to.equal(12n);
      expect(pos.raw).to.equal(migrationAmount);

      // Boost magnitude unchanged: the running effective stake equals
      // raw * mult / 1e18 for tier 12 (6x), independent of the credit.
      expect(await CSS.getNodeRunningEffectiveStake(identityId)).to.equal(
        (migrationAmount * SIX_X) / SCALE18,
      );
      // Drop is scheduled at the SHORTENED expiry, not the default.
      expect(await CSS.getNodeExpiryDrop(identityId, expectedExpiry)).to.equal(
        (migrationAmount * (SIX_X - SCALE18)) / SCALE18,
      );
      // No drop at the default-tier slot (sanity: the credit ACTUALLY moved
      // the schedule, it didn't double-schedule).
      expect(await CSS.getNodeExpiryDrop(identityId, tierDefault)).to.equal(0n);
    });

    it('Eligible delegator + tier 6: V10 expiry is 60d before tier default', async () => {
      const identityId = await createProfile();
      await seedV8Stake(accounts[2], identityId, migrationAmount);
      await RegistryContract.setEligibleBatch([identityId], [accounts[2].address]);
      await RegistryContract.freeze();

      const tier6Duration = 180n * 24n * 60n * 60n;

      const tx = await NFT.connect(accounts[2]).selfMigrateV8(identityId, 6);
      const receipt = await tx.wait();
      const blockTs = BigInt(
        (await hre.ethers.provider.getBlock(receipt!.blockNumber))!.timestamp,
      );

      const pos = await CSS.getPosition(1);
      expect(pos.lockTier).to.equal(6n);
      expect(pos.expiryTimestamp).to.equal(blockTs + tier6Duration - SIXTY_DAYS_SECONDS);
      expect(pos.multiplier18).to.equal(THREE_AND_HALF_X);
    });

    it('Ineligible delegator + tier 12: V10 expiry equals the tier default', async () => {
      const identityId = await createProfile();
      await seedV8Stake(accounts[2], identityId, migrationAmount);
      // NOT calling setEligibleBatch — delegator is absent from the registry.
      await RegistryContract.freeze();

      const tx = await NFT.connect(accounts[2]).selfMigrateV8(identityId, 12);
      const receipt = await tx.wait();
      const blockTs = BigInt(
        (await hre.ethers.provider.getBlock(receipt!.blockNumber))!.timestamp,
      );

      const pos = await CSS.getPosition(1);
      const tier12Duration = 366n * 24n * 60n * 60n;
      expect(pos.expiryTimestamp).to.equal(blockTs + tier12Duration);
    });

    it('Eligible delegator + tier 3 (lower conviction): no credit applied', async () => {
      const identityId = await createProfile();
      await seedV8Stake(accounts[2], identityId, migrationAmount);
      await RegistryContract.setEligibleBatch([identityId], [accounts[2].address]);
      await RegistryContract.freeze();

      const tx = await NFT.connect(accounts[2]).selfMigrateV8(identityId, 3);
      const receipt = await tx.wait();
      const blockTs = BigInt(
        (await hre.ethers.provider.getBlock(receipt!.blockNumber))!.timestamp,
      );

      const pos = await CSS.getPosition(1);
      const tier3Duration = 90n * 24n * 60n * 60n;
      expect(pos.lockTier).to.equal(3n);
      expect(pos.expiryTimestamp).to.equal(
        blockTs + tier3Duration,
        'tier 3 must NOT receive the credit even when delegator is eligible',
      );
    });

    it('Eligible delegator + tier 1 (lower conviction): no credit applied', async () => {
      const identityId = await createProfile();
      await seedV8Stake(accounts[2], identityId, migrationAmount);
      await RegistryContract.setEligibleBatch([identityId], [accounts[2].address]);
      await RegistryContract.freeze();

      const tx = await NFT.connect(accounts[2]).selfMigrateV8(identityId, 1);
      const receipt = await tx.wait();
      const blockTs = BigInt(
        (await hre.ethers.provider.getBlock(receipt!.blockNumber))!.timestamp,
      );

      const pos = await CSS.getPosition(1);
      const tier1Duration = 30n * 24n * 60n * 60n;
      expect(pos.lockTier).to.equal(1n);
      expect(pos.expiryTimestamp).to.equal(blockTs + tier1Duration);
    });

    it('Migration of a tier 6/12 reverts before the registry is frozen', async () => {
      // freeze() invariant: every credit-bearing migration must read against
      // a finalised eligibility set. Without this guard, HubOwner could
      // still grow the set after migrations opened — different lock
      // expiries for otherwise-identical migrants depending on tx ordering.
      // Lower tiers are exempt (they never read the registry).
      const identityId = await createProfile();
      await seedV8Stake(accounts[2], identityId, migrationAmount);
      await RegistryContract.setEligibleBatch([identityId], [accounts[2].address]);
      // Deliberately NOT calling freeze() here.

      await expect(
        NFT.connect(accounts[2]).selfMigrateV8(identityId, 12),
      ).to.be.revertedWith('V8 eligibility not frozen');
      await expect(
        NFT.connect(accounts[2]).selfMigrateV8(identityId, 6),
      ).to.be.revertedWith('V8 eligibility not frozen');
    });

    it('Migration of a tier 0/1/3 (no credit) does NOT require the registry to be frozen', async () => {
      // Lower tiers never read the registry, so an operator who hasn't
      // finished setting up eligibility can still let opt-out / lower-
      // tier migrants drain. Pinning so the freeze gate stays narrow.
      const identityId = await createProfile();
      await seedV8Stake(accounts[2], identityId, migrationAmount);
      // No setEligibleBatch, no freeze — registry is empty + open.

      const tx = await NFT.connect(accounts[2]).selfMigrateV8(identityId, 3);
      const receipt = await tx.wait();
      const blockTs = BigInt(
        (await hre.ethers.provider.getBlock(receipt!.blockNumber))!.timestamp,
      );
      const pos = await CSS.getPosition(1);
      const tier3Duration = 90n * 24n * 60n * 60n;
      expect(pos.expiryTimestamp).to.equal(blockTs + tier3Duration);
    });

    it('Eligibility is per-(identityId, delegator): same delegator on a different node gets no credit', async () => {
      const idA = await createProfile(1);
      // Distinct operational wallet for node B; createProfile is keyed by
      // msg.sender so a second profile must come from a fresh signer.
      const idB = await createProfile(5);

      await seedV8Stake(accounts[2], idA, migrationAmount);
      await seedV8Stake(accounts[2], idB, migrationAmount);
      // Only mark eligible on node A.
      await RegistryContract.setEligibleBatch([idA], [accounts[2].address]);
      await RegistryContract.freeze();

      // Migrate on node A (eligible) — credit applies.
      const txA = await NFT.connect(accounts[2]).selfMigrateV8(idA, 12);
      const recA = await txA.wait();
      const tsA = BigInt(
        (await hre.ethers.provider.getBlock(recA!.blockNumber))!.timestamp,
      );
      const tier12Duration = 366n * 24n * 60n * 60n;
      const posA = await CSS.getPosition(1);
      expect(posA.expiryTimestamp).to.equal(
        tsA + tier12Duration - SIXTY_DAYS_SECONDS,
      );

      // Migrate on node B (NOT eligible) — no credit.
      const txB = await NFT.connect(accounts[2]).selfMigrateV8(idB, 12);
      const recB = await txB.wait();
      const tsB = BigInt(
        (await hre.ethers.provider.getBlock(recB!.blockNumber))!.timestamp,
      );
      const posB = await CSS.getPosition(2);
      expect(posB.expiryTimestamp).to.equal(tsB + tier12Duration);
    });

    it('adminConvertToNFT path also honours the registry', async () => {
      const identityId = await createProfile();
      await seedV8Stake(accounts[2], identityId, migrationAmount);
      await RegistryContract.setEligibleBatch([identityId], [accounts[2].address]);
      await RegistryContract.freeze();

      // Admin path (caller is HubOwner = accounts[0]; delegator is accounts[2]).
      const tx = await NFT.connect(accounts[0]).adminMigrateV8(
        accounts[2].address,
        identityId,
        12,
      );
      const receipt = await tx.wait();
      const blockTs = BigInt(
        (await hre.ethers.provider.getBlock(receipt!.blockNumber))!.timestamp,
      );

      const pos = await CSS.getPosition(1);
      const tier12Duration = 366n * 24n * 60n * 60n;
      expect(pos.expiryTimestamp).to.equal(
        blockTs + tier12Duration - SIXTY_DAYS_SECONDS,
      );
    });
  });
});
