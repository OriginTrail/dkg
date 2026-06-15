// =============================================================================
// OT-RFC-50 — V8 → V10 "pool & allocate" migration
// =============================================================================
//
// startMigration drains ALL of a wallet's V8 stake across the given source
// nodes into an in-protocol migration credit on CSS (Option B ledger), tagging
// the registry-eligible portion into eligibleCredit. allocate then spends that
// credit into fresh V10 conviction positions (node + amount + tier), applying
// the configurable convictionCreditSeconds lock-shortening to tier-6/12
// allocations fully covered by eligible credit. adminMigrateToCredit is the
// owner-gated straggler sweep (drain → that delegator's credit, no allocation).
//
// Covered: drain→credit accounting + eligible tagging; the eligibleCredit
// "non-eligible-first" clamp; the credit gate (tier 6/12, fully-covered);
// the collateralization invariant (SS→CSS exact; allocate moves no TRAC);
// the freeze-gate at drain time; adminMigrateToCredit; setConvictionCreditSeconds
// (owner-settable until frozen, capped < tier-6 duration).

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
const DAY = 24n * 60n * 60n;
const TIER12_DURATION = 366n * DAY;
const CREDIT_SECONDS = 70n * DAY; // configurable, < tier-6 (180d) cap

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
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingStorage: await hre.ethers.getContract<StakingStorage>('StakingStorage'),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    ),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    V8MigrationEligibility: await hre.ethers.getContract<V8MigrationEligibility>(
      'V8MigrationEligibility',
    ),
  };
}

describe('@integration OT-RFC-50 pool & allocate migration', function () {
  let accounts: SignerWithAddress[];
  let NFT: DKGStakingConvictionNFT;
  let SS: StakingStorage;
  let CSS: ConvictionStakingStorage;
  let ProfileContract: Profile;
  let TokenContract: Token;
  let Registry: V8MigrationEligibility;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      NFT,
      StakingStorage: SS,
      ConvictionStakingStorage: CSS,
      Profile: ProfileContract,
      Token: TokenContract,
      V8MigrationEligibility: Registry,
    } = await loadFixture(deployFixture));
  });

  // --- helpers (cloned from v10-migration-conviction-credit.test.ts) ---

  const createProfile = async (opIdx: number) => {
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

  const keyOf = (addr: string) =>
    hre.ethers.keccak256(hre.ethers.solidityPacked(['address'], [addr]));

  const seedV8Stake = async (
    delegator: SignerWithAddress,
    identityId: number,
    stakeBase: bigint,
  ) => {
    const v8Key = keyOf(delegator.address);
    await TokenContract.mint(await SS.getAddress(), stakeBase);
    await SS.connect(accounts[0]).increaseDelegatorStakeBase(identityId, v8Key, stakeBase);
    await SS.connect(accounts[0]).increaseNodeStake(identityId, stakeBase);
    await SS.connect(accounts[0]).increaseTotalStake(stakeBase);
    return v8Key;
  };

  // Set the credit (owner, pre-freeze), upload eligibility, then freeze.
  const armCredit = async (eligible: Array<[number, string]>) => {
    await NFT.connect(accounts[0]).setConvictionCreditSeconds(CREDIT_SECONDS);
    if (eligible.length) {
      await Registry.connect(accounts[0]).setEligibleBatch(
        eligible.map(([id]) => id),
        eligible.map(([, a]) => a),
      );
    }
    await Registry.connect(accounts[0]).freeze();
  };

  // ===========================================================================
  // startMigration — drain → credit
  // ===========================================================================
  describe('startMigration', () => {
    it('drains V8 stake across nodes into credit and tags the eligible portion', async () => {
      const d = accounts[2];
      const idA = await createProfile(1);
      const idB = await createProfile(3);
      const stakeA = hre.ethers.parseEther('5000');
      const stakeB = hre.ethers.parseEther('3000');
      await seedV8Stake(d, idA, stakeA);
      await seedV8Stake(d, idB, stakeB);
      // Eligible on A only.
      await armCredit([[idA, d.address]]);

      await expect(NFT.connect(d).startMigration([idA, idB]))
        .to.emit(NFT, 'MigrationStarted')
        .withArgs(d.address, stakeA + stakeB, stakeA, false);

      expect(await NFT.migrationCredit(d.address)).to.equal(stakeA + stakeB);
      expect(await NFT.eligibleCredit(d.address)).to.equal(stakeA); // only A eligible
      // V8 slots drained.
      expect(await SS.getDelegatorStakeBase(idA, keyOf(d.address))).to.equal(0n);
      expect(await SS.getDelegatorStakeBase(idB, keyOf(d.address))).to.equal(0n);
    });

    it('reverts NothingToMigrate when the caller has no V8 stake', async () => {
      const idA = await createProfile(1);
      await armCredit([]);
      await expect(NFT.connect(accounts[2]).startMigration([idA])).to.be.revertedWithCustomError(
        NFT,
        'NothingToMigrate',
      );
    });

    it('reverts if the eligibility registry is not frozen', async () => {
      const d = accounts[2];
      const idA = await createProfile(1);
      await seedV8Stake(d, idA, hre.ethers.parseEther('1000'));
      // not frozen
      await expect(NFT.connect(d).startMigration([idA])).to.be.revertedWith(
        'V8 eligibility not frozen',
      );
    });

    it('is idempotent — a re-drained node contributes 0 (no double count)', async () => {
      const d = accounts[2];
      const idA = await createProfile(1);
      const stakeA = hre.ethers.parseEther('5000');
      await seedV8Stake(d, idA, stakeA);
      await armCredit([[idA, d.address]]);

      await NFT.connect(d).startMigration([idA]);
      expect(await NFT.migrationCredit(d.address)).to.equal(stakeA);
      // Second call: node already drained → reverts NothingToMigrate (sum == 0).
      await expect(NFT.connect(d).startMigration([idA])).to.be.revertedWithCustomError(
        NFT,
        'NothingToMigrate',
      );
      expect(await NFT.migrationCredit(d.address)).to.equal(stakeA);
    });
  });

  // ===========================================================================
  // allocate — credit → position
  // ===========================================================================
  describe('allocate', () => {
    it('tier 12 fully covered by eligible credit: applies the conviction credit', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('5000');
      await seedV8Stake(d, id, stake);
      await armCredit([[id, d.address]]);
      await NFT.connect(d).startMigration([id]);

      const tx = await NFT.connect(d).allocate(id, stake, 12);
      const rcpt = await tx.wait();
      const blockTs = BigInt((await hre.ethers.provider.getBlock(rcpt!.blockNumber))!.timestamp);

      await expect(tx).to.emit(NFT, 'Allocated').withArgs(d.address, 1n, id, stake, 12n, true);

      const pos = await CSS.getPosition(1);
      expect(pos.raw).to.equal(stake);
      expect(pos.lockTier).to.equal(12n);
      expect(pos.migrationEpoch).to.be.greaterThan(0n); // drives the "Migrated from V8" badge
      expect(pos.expiryTimestamp).to.equal(blockTs + TIER12_DURATION - CREDIT_SECONDS);

      // Credit fully spent; eligible consumed.
      expect(await NFT.migrationCredit(d.address)).to.equal(0n);
      expect(await NFT.eligibleCredit(d.address)).to.equal(0n);
      // Boost magnitude unchanged by the credit (6x on raw).
      expect(await CSS.getNodeRunningEffectiveStake(id)).to.equal((stake * SIX_X) / SCALE18);
    });

    it('partial allocations across nodes; leftover stays as credit', async () => {
      const d = accounts[2];
      const idA = await createProfile(1);
      const idB = await createProfile(3);
      const stake = hre.ethers.parseEther('10000');
      await seedV8Stake(d, idA, stake);
      await armCredit([[idA, d.address]]);
      await NFT.connect(d).startMigration([idA]);

      const part = hre.ethers.parseEther('4000');
      await NFT.connect(d).allocate(idA, part, 0); // tier 0, no credit
      expect(await NFT.migrationCredit(d.address)).to.equal(stake - part);
      // Non-eligible-first clamp: a tier-0 spend leaves eligible capped at remaining credit.
      expect(await NFT.eligibleCredit(d.address)).to.equal(stake - part);

      // Allocate the rest to node B at tier 12 — fully covered by remaining eligible.
      await NFT.connect(d).allocate(idB, stake - part, 12);
      expect(await NFT.migrationCredit(d.address)).to.equal(0n);
    });

    it('reverts on amount > credit, dead profile, and inactive tier', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('1000');
      await seedV8Stake(d, id, stake);
      await armCredit([[id, d.address]]);
      await NFT.connect(d).startMigration([id]);

      await expect(NFT.connect(d).allocate(id, stake + 1n, 0)).to.be.reverted; // exceeds credit
      await expect(NFT.connect(d).allocate(9_999_999, stake, 0)).to.be.reverted; // dead profile
      await expect(NFT.connect(d).allocate(id, stake, 4)).to.be.reverted; // tier 4 doesn't exist
    });
  });

  // ===========================================================================
  // Collateralization invariant
  // ===========================================================================
  describe('collateralization', () => {
    it('startMigration moves TRAC SS→CSS exactly; allocate moves no TRAC', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('5000');
      await seedV8Stake(d, id, stake);
      await armCredit([[id, d.address]]);

      const ssBefore = await TokenContract.balanceOf(await SS.getAddress());
      const cssBefore = await TokenContract.balanceOf(await CSS.getAddress());

      await NFT.connect(d).startMigration([id]);
      expect(await TokenContract.balanceOf(await SS.getAddress())).to.equal(ssBefore - stake);
      expect(await TokenContract.balanceOf(await CSS.getAddress())).to.equal(cssBefore + stake);

      const cssAfterDrain = await TokenContract.balanceOf(await CSS.getAddress());
      await NFT.connect(d).allocate(id, stake, 12);
      // allocate moves no TRAC — the credit was already in CSS.
      expect(await TokenContract.balanceOf(await CSS.getAddress())).to.equal(cssAfterDrain);
    });
  });

  // ===========================================================================
  // adminMigrateToCredit — straggler sweep (drain only)
  // ===========================================================================
  describe('adminMigrateToCredit', () => {
    it('owner drains a delegator to THEIR credit, mints no position, byAdmin=true', async () => {
      const straggler = accounts[5];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('2500');
      await seedV8Stake(straggler, id, stake);
      await armCredit([[id, straggler.address]]);

      await expect(NFT.connect(accounts[0]).adminMigrateToCredit(straggler.address, [id]))
        .to.emit(NFT, 'MigrationStarted')
        .withArgs(straggler.address, stake, stake, true);

      expect(await NFT.migrationCredit(straggler.address)).to.equal(stake);
      expect(await NFT.totalSupply()).to.equal(0n); // no NFT minted by the sweep
    });

    it('is gated to the owner/multisig', async () => {
      const id = await createProfile(1);
      await seedV8Stake(accounts[5], id, hre.ethers.parseEther('100'));
      await armCredit([[id, accounts[5].address]]);
      await expect(
        NFT.connect(accounts[5]).adminMigrateToCredit(accounts[5].address, [id]),
      ).to.be.reverted;
    });
  });

  // ===========================================================================
  // setConvictionCreditSeconds
  // ===========================================================================
  describe('setConvictionCreditSeconds', () => {
    it('owner-settable before freeze; readable via the wrapper view', async () => {
      await NFT.connect(accounts[0]).setConvictionCreditSeconds(CREDIT_SECONDS);
      expect(await NFT.convictionCreditSeconds()).to.equal(CREDIT_SECONDS);
    });

    it('reverts once the eligibility registry is frozen', async () => {
      await Registry.connect(accounts[0]).freeze();
      await expect(
        NFT.connect(accounts[0]).setConvictionCreditSeconds(CREDIT_SECONDS),
      ).to.be.revertedWith('eligibility already frozen');
    });

    it('caps the credit below the tier-6 lock duration', async () => {
      const tooBig = 180n * DAY; // == tier-6 duration; must be strictly less
      await expect(
        NFT.connect(accounts[0]).setConvictionCreditSeconds(tooBig),
      ).to.be.revertedWith('credit >= tier-6 lock');
    });

    it('is gated to the owner/multisig', async () => {
      await expect(
        NFT.connect(accounts[2]).setConvictionCreditSeconds(CREDIT_SECONDS),
      ).to.be.reverted;
    });
  });
});
