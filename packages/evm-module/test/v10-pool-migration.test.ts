// =============================================================================
// OT-RFC-50 — V8 → V10 "pool & allocate" migration
// =============================================================================
//
// Admin-push (OT-RFC-50, rev 5): the protocol drains every wallet's V8 stake
// across the given source nodes into ONE in-protocol migration credit on CSS
// (Option B ledger) — via adminMigrateToCredit (single delegator) /
// adminDrainBatch (bulk, flattened (delegator,node) pairs, skip-zero). There is
// NO self-service startMigration and NO eligibility registry. allocate then lets
// the USER spend that pre-populated credit into fresh V10 conviction positions
// (node + amount + tier); ANY tier-6/12 allocation applies the configurable
// convictionCreditSeconds lock-shortening (universal). A tier-0 allocation is
// immediately withdrawable, so admin-drained funds are always recoverable.
//
// Covered: admin drain→credit accounting; the credit gate (universal tier-6/12
// lock-credit); the collateralization invariant (SS→CSS exact, incl. D8 pending;
// allocate moves no TRAC); adminMigrateToCredit + adminDrainBatch (skip-zero,
// idempotent re-run); the tier-0 recover-to-wallet round-trip (incl. after the
// owner deactivates tier 0); setConvictionCreditSeconds (capped < tier-6).

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
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(['DKGStakingConvictionNFT', 'StakingV10', 'Profile']);

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
  };
}

describe('@integration OT-RFC-50 pool & allocate migration', function () {
  // The first loadFixture deploy spins up the full stack and can exceed mocha's
  // 40s default in this worktree; raise the ceiling so the cold deploy fits.
  this.timeout(300_000);

  let accounts: SignerWithAddress[];
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;
  let HubContract: Hub;
  let SS: StakingStorage;
  let CSS: ConvictionStakingStorage;
  let ProfileContract: Profile;
  let TokenContract: Token;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      NFT,
      StakingV10: StakingV10Contract,
      StakingStorage: SS,
      ConvictionStakingStorage: CSS,
      Profile: ProfileContract,
      Token: TokenContract,
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

  // Set the conviction credit (owner). rev 5: no eligibility registry / freeze —
  // the lock-credit is universal on 6/12. The optional arg is ignored (call
  // sites retained to keep the diff small).
  const armCredit = async (_eligible?: Array<[number, string]>) => {
    await NFT.connect(accounts[0]).setConvictionCreditSeconds(CREDIT_SECONDS);
  };

  // ===========================================================================
  // admin drain → credit (adminMigrateToCredit) — accounting & invariants
  // ===========================================================================
  describe('admin drain (adminMigrateToCredit)', () => {
    it('drains V8 stake across nodes into credit', async () => {
      const d = accounts[2];
      const idA = await createProfile(1);
      const idB = await createProfile(3);
      const stakeA = hre.ethers.parseEther('5000');
      const stakeB = hre.ethers.parseEther('3000');
      await seedV8Stake(d, idA, stakeA);
      await seedV8Stake(d, idB, stakeB);
      await armCredit();

      await expect(NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [idA, idB]))
        .to.emit(NFT, 'MigrationStarted')
        .withArgs(d.address, stakeA + stakeB);

      expect(await NFT.migrationCredit(d.address)).to.equal(stakeA + stakeB);
      // V8 slots drained.
      expect(await SS.getDelegatorStakeBase(idA, keyOf(d.address))).to.equal(0n);
      expect(await SS.getDelegatorStakeBase(idB, keyOf(d.address))).to.equal(0n);
    });

    it('reverts NothingToMigrate when the delegator has no V8 stake', async () => {
      const idA = await createProfile(1);
      await armCredit();
      await expect(
        NFT.connect(accounts[0]).adminMigrateToCredit(accounts[2].address, [idA]),
      ).to.be.revertedWithCustomError(NFT, 'NothingToMigrate');
    });

    it('is idempotent — a re-drained node contributes 0 (no double count)', async () => {
      const d = accounts[2];
      const idA = await createProfile(1);
      const stakeA = hre.ethers.parseEther('5000');
      await seedV8Stake(d, idA, stakeA);
      await armCredit([[idA, d.address]]);

      await NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [idA]);
      expect(await NFT.migrationCredit(d.address)).to.equal(stakeA);
      // Second call: node already drained → reverts NothingToMigrate (sum == 0).
      await expect(NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [idA])).to.be.revertedWithCustomError(
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
    it('tier 12 allocation gets the universal conviction credit', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('5000');
      await seedV8Stake(d, id, stake);
      await armCredit();
      await NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [id]);

      const tx = await NFT.connect(d).allocate(id, stake, 12);
      const rcpt = await tx.wait();
      const blockTs = BigInt((await hre.ethers.provider.getBlock(rcpt!.blockNumber))!.timestamp);

      // creditApplied = true for any tier-12 migration allocation (rev 5: universal).
      await expect(tx).to.emit(NFT, 'Allocated').withArgs(d.address, 1n, id, stake, 12n, true);

      const pos = await CSS.getPosition(1);
      expect(pos.raw).to.equal(stake);
      expect(pos.lockTier).to.equal(12n);
      expect(pos.migrationEpoch).to.be.greaterThan(0n); // drives the "Migrated from V8" badge
      expect(pos.expiryTimestamp).to.equal(blockTs + TIER12_DURATION - CREDIT_SECONDS);

      // Credit fully spent.
      expect(await NFT.migrationCredit(d.address)).to.equal(0n);
      // Boost magnitude unchanged by the credit (6x on raw).
      expect(await CSS.getNodeRunningEffectiveStake(id)).to.equal((stake * SIX_X) / SCALE18);
    });

    it('partial allocations across nodes; leftover stays as credit', async () => {
      const d = accounts[2];
      const idA = await createProfile(1);
      const idB = await createProfile(3);
      const stake = hre.ethers.parseEther('10000');
      await seedV8Stake(d, idA, stake);
      await armCredit();
      await NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [idA]);

      const part = hre.ethers.parseEther('4000');
      await NFT.connect(d).allocate(idA, part, 0); // tier 0, no lock-credit
      expect(await NFT.migrationCredit(d.address)).to.equal(stake - part);

      // Allocate the rest to node B at tier 12.
      await NFT.connect(d).allocate(idB, stake - part, 12);
      expect(await NFT.migrationCredit(d.address)).to.equal(0n);
    });

    it('reverts on amount > credit, dead profile, and inactive tier', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('1000');
      await seedV8Stake(d, id, stake);
      await armCredit([[id, d.address]]);
      await NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [id]);

      await expect(NFT.connect(d).allocate(id, stake + 1n, 0)).to.be.reverted; // exceeds credit
      await expect(NFT.connect(d).allocate(9_999_999, stake, 0)).to.be.reverted; // dead profile
      await expect(NFT.connect(d).allocate(id, stake, 4)).to.be.reverted; // tier 4 doesn't exist
    });

    it('creditApplied is false (no silent lock-credit) when convictionCreditSeconds is unset', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('1000');
      await seedV8Stake(d, id, stake);
      // deliberately do NOT arm credit — convictionCreditSeconds stays 0
      await NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [id]);

      const tx = await NFT.connect(d).allocate(id, stake, 12);
      const blockTs = BigInt((await hre.ethers.provider.getBlock((await tx.wait())!.blockNumber))!.timestamp);
      // tier-12 allocation, but creditApplied=false because no credit was configured
      await expect(tx).to.emit(NFT, 'Allocated').withArgs(d.address, 1n, id, stake, 12n, false);
      // and the expiry is NOT shortened (full tier-12 duration)
      expect((await CSS.getPosition(1)).expiryTimestamp).to.equal(blockTs + TIER12_DURATION);
    });
  });

  // ===========================================================================
  // Collateralization invariant
  // ===========================================================================
  describe('collateralization', () => {
    it('admin drain moves TRAC SS→CSS exactly; allocate moves no TRAC', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('5000');
      await seedV8Stake(d, id, stake);
      await armCredit([[id, d.address]]);

      const ssBefore = await TokenContract.balanceOf(await SS.getAddress());
      const cssBefore = await TokenContract.balanceOf(await CSS.getAddress());

      await NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [id]);
      expect(await TokenContract.balanceOf(await SS.getAddress())).to.equal(ssBefore - stake);
      expect(await TokenContract.balanceOf(await CSS.getAddress())).to.equal(cssBefore + stake);

      const cssAfterDrain = await TokenContract.balanceOf(await CSS.getAddress());
      await NFT.connect(d).allocate(id, stake, 12);
      // allocate moves no TRAC — the credit was already in CSS.
      expect(await TokenContract.balanceOf(await CSS.getAddress())).to.equal(cssAfterDrain);
    });

    it('drains a pending V8 withdrawal (D8): credit + SS→CSS transfer include pending', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const base = hre.ethers.parseEther('5000');
      const pending = hre.ethers.parseEther('1500');
      await seedV8Stake(d, id, base); // active base: vault += base, stakeBase=base, node/total += base
      // V8 pending withdrawal: the earmarked TRAC stays in the vault but is
      // excluded from active node/total stake. Seed the vault top-up + the request.
      const key = keyOf(d.address);
      await TokenContract.mint(await SS.getAddress(), pending);
      const block = await hre.ethers.provider.getBlock('latest');
      await SS.connect(accounts[0]).createDelegatorWithdrawalRequest(
        id,
        key,
        pending,
        0,
        BigInt(block!.timestamp) + 1n,
      );
      await armCredit([[id, d.address]]);

      const ssBefore = await TokenContract.balanceOf(await SS.getAddress());
      const cssBefore = await TokenContract.balanceOf(await CSS.getAddress());

      // credited must include the pending amount.
      await expect(NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [id]))
        .to.emit(NFT, 'MigrationStarted')
        .withArgs(d.address, base + pending);

      expect(await NFT.migrationCredit(d.address)).to.equal(base + pending);
      // SS→CSS vault moved base + pending (the collateralization invariant the
      // deleted regression covered — guards against silent under-crediting).
      expect(await TokenContract.balanceOf(await SS.getAddress())).to.equal(ssBefore - (base + pending));
      expect(await TokenContract.balanceOf(await CSS.getAddress())).to.equal(cssBefore + base + pending);
      // Both V8 slots cleared.
      expect(await SS.getDelegatorStakeBase(id, key)).to.equal(0n);
      expect(await SS.getDelegatorWithdrawalRequestAmount(id, key)).to.equal(0n);
    });
  });

  // ===========================================================================
  // adminMigrateToCredit — single-delegator drain (gating & no-mint)
  // ===========================================================================
  describe('adminMigrateToCredit (single delegator)', () => {
    it('owner drains a delegator to THEIR credit, mints no position', async () => {
      const straggler = accounts[5];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('2500');
      await seedV8Stake(straggler, id, stake);
      await armCredit();

      await expect(NFT.connect(accounts[0]).adminMigrateToCredit(straggler.address, [id]))
        .to.emit(NFT, 'MigrationStarted')
        .withArgs(straggler.address, stake);

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
  // adminDrainBatch — bulk admin-push over flattened (delegator,node) pairs
  // ===========================================================================
  describe('adminDrainBatch', () => {
    it('drains many (delegator,node) pairs in one call, crediting each delegator', async () => {
      const d1 = accounts[2];
      const d2 = accounts[3];
      const idA = await createProfile(1);
      const idB = await createProfile(4);
      const s1 = hre.ethers.parseEther('5000');
      const s2 = hre.ethers.parseEther('3000');
      await seedV8Stake(d1, idA, s1);
      await seedV8Stake(d2, idB, s2);
      await armCredit([
        [idA, d1.address],
        [idB, d2.address],
      ]);

      await NFT.connect(accounts[0]).adminDrainBatch([d1.address, d2.address], [idA, idB]);

      expect(await NFT.migrationCredit(d1.address)).to.equal(s1);
      expect(await NFT.migrationCredit(d2.address)).to.equal(s2);
      expect(await NFT.totalSupply()).to.equal(0n); // pure drain, no mint
    });

    it('skips pairs with nothing to drain instead of reverting the batch', async () => {
      const d = accounts[2];
      const idA = await createProfile(1);
      const idEmpty = await createProfile(4); // d holds no stake on idEmpty
      const s = hre.ethers.parseEther('1000');
      await seedV8Stake(d, idA, s);
      await armCredit([[idA, d.address]]);

      // The (d, idEmpty) pair drains 0 — must be skipped, not reverted.
      await NFT.connect(accounts[0]).adminDrainBatch(
        [d.address, d.address],
        [idA, idEmpty],
      );
      expect(await NFT.migrationCredit(d.address)).to.equal(s);
    });

    it('is idempotent — re-running a chunk does not double-credit', async () => {
      const d = accounts[2];
      const idA = await createProfile(1);
      const s = hre.ethers.parseEther('5000');
      await seedV8Stake(d, idA, s);
      await armCredit([[idA, d.address]]);

      await NFT.connect(accounts[0]).adminDrainBatch([d.address], [idA]);
      expect(await NFT.migrationCredit(d.address)).to.equal(s);
      // Re-run the same chunk: V8 slot already zeroed → no-op, no double count.
      await NFT.connect(accounts[0]).adminDrainBatch([d.address], [idA]);
      expect(await NFT.migrationCredit(d.address)).to.equal(s);
    });

    it('reverts on delegators/identityIds length mismatch', async () => {
      const idA = await createProfile(1);
      await armCredit([]);
      await expect(
        NFT.connect(accounts[0]).adminDrainBatch([accounts[2].address], [idA, idA]),
      ).to.be.revertedWith('length mismatch');
    });

    it('is gated to the owner/multisig', async () => {
      const idA = await createProfile(1);
      await seedV8Stake(accounts[2], idA, hre.ethers.parseEther('100'));
      await armCredit([[idA, accounts[2].address]]);
      await expect(
        NFT.connect(accounts[2]).adminDrainBatch([accounts[2].address], [idA]),
      ).to.be.reverted;
    });
  });

  // ===========================================================================
  // adminDrainOperatorFeesBatch — node-side operator-fee drain. OT-RFC-50 §0
  // Option B ("one credit"): the V8 operator fee (resting balance + any open
  // fee-withdrawal request) folds into the operator's SAME migrationCredit
  // bucket as delegator stake, recovered via allocate (tier 0 → liquid, or
  // 6/12 → conviction) exactly like a delegator. The operator address is
  // supplied off-chain and validated on-chain against ADMIN_KEY.
  // ===========================================================================
  describe('adminDrainOperatorFeesBatch', () => {
    // The createProfile() helper sets accounts[0] as the node's adminWallet, so
    // accounts[0] is the ADMIN_KEY holder (= the valid operator) for those nodes.
    const seedOperatorFee = async (identityId: number, amount: bigint) => {
      await TokenContract.mint(await SS.getAddress(), amount);
      await SS.connect(accounts[0]).increaseOperatorFeeBalance(identityId, amount);
    };
    const seedOperatorFeeRequest = async (identityId: number, amount: bigint) => {
      // Mirror an operator mid-withdrawal: TRAC stays in the SS vault (no token
      // moved at request time), tracked only by the request slot.
      await TokenContract.mint(await SS.getAddress(), amount);
      const ts = BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp) + 1n;
      await SS.connect(accounts[0]).createOperatorFeeWithdrawalRequest(identityId, amount, 0, ts);
    };
    const createProfileWithAdmin = async (opIdx: number, adminAddr: string) => {
      const nodeId = hre.ethers.hexlify(hre.ethers.randomBytes(32));
      const tx = await ProfileContract.connect(accounts[opIdx]).createProfile(
        adminAddr,
        [],
        `Node-${Math.floor(Math.random() * 1_000_000)}`,
        nodeId,
        0,
      );
      const receipt = await tx.wait();
      return Number(receipt!.logs[0].topics[1]);
    };

    it("drains a node operator fee into the operator's migration credit (same bucket)", async () => {
      const op = accounts[0];
      const id = await createProfile(1); // admin = accounts[0]
      const fee = hre.ethers.parseEther('250');
      await seedOperatorFee(id, fee);

      await expect(NFT.connect(accounts[0]).adminDrainOperatorFeesBatch([id], [op.address]))
        .to.emit(NFT, 'OperatorFeeMigrated')
        .withArgs(id, op.address, fee);

      expect(await NFT.migrationCredit(op.address)).to.equal(fee);
      expect(await SS.getOperatorFeeBalance(id)).to.equal(0n);
    });

    it('folds an open operator-fee withdrawal request into the credit + moves it SS→CSS', async () => {
      const op = accounts[0];
      const id = await createProfile(1);
      const resting = hre.ethers.parseEther('100');
      const inFlight = hre.ethers.parseEther('60'); // operator mid-withdrawal
      await seedOperatorFee(id, resting);
      await seedOperatorFeeRequest(id, inFlight);

      const ssBefore = await TokenContract.balanceOf(await SS.getAddress());
      const cssBefore = await TokenContract.balanceOf(await CSS.getAddress());

      await NFT.connect(accounts[0]).adminDrainOperatorFeesBatch([id], [op.address]);

      // both the resting balance and the in-flight request are credited
      expect(await NFT.migrationCredit(op.address)).to.equal(resting + inFlight);
      expect(await SS.getOperatorFeeBalance(id)).to.equal(0n);
      expect(await SS.getOperatorFeeWithdrawalRequestAmount(id)).to.equal(0n);
      // collateral moved SS→CSS exactly (no fee left resting in the V8 vault)
      expect(await TokenContract.balanceOf(await SS.getAddress())).to.equal(ssBefore - (resting + inFlight));
      expect(await TokenContract.balanceOf(await CSS.getAddress())).to.equal(cssBefore + resting + inFlight);
    });

    it("drains many nodes in one call, crediting each node's operator", async () => {
      const opA = accounts[0];
      const opB = accounts[3];
      const idA = await createProfile(1); // admin = accounts[0]
      const idB = await createProfileWithAdmin(4, opB.address); // admin = accounts[3]
      const feeA = hre.ethers.parseEther('300');
      const feeB = hre.ethers.parseEther('700');
      await seedOperatorFee(idA, feeA);
      await seedOperatorFee(idB, feeB);

      await NFT.connect(accounts[0]).adminDrainOperatorFeesBatch(
        [idA, idB],
        [opA.address, opB.address],
      );

      expect(await NFT.migrationCredit(opA.address)).to.equal(feeA);
      expect(await NFT.migrationCredit(opB.address)).to.equal(feeB);
      expect(await NFT.totalSupply()).to.equal(0n); // pure drain, no mint
    });

    it('skips nodes with no fee instead of reverting the batch', async () => {
      const op = accounts[0];
      const id = await createProfile(1);
      const idEmpty = await createProfile(4); // no operator fee
      const fee = hre.ethers.parseEther('120');
      await seedOperatorFee(id, fee);

      await NFT.connect(accounts[0]).adminDrainOperatorFeesBatch(
        [id, idEmpty],
        [op.address, op.address],
      );
      expect(await NFT.migrationCredit(op.address)).to.equal(fee);
    });

    it('is idempotent — re-running a drained node does not double-credit', async () => {
      const op = accounts[0];
      const id = await createProfile(1);
      const fee = hre.ethers.parseEther('500');
      await seedOperatorFee(id, fee);

      await NFT.connect(accounts[0]).adminDrainOperatorFeesBatch([id], [op.address]);
      expect(await NFT.migrationCredit(op.address)).to.equal(fee);
      // re-run: V8 fee slot already zeroed → no-op, no double count
      await NFT.connect(accounts[0]).adminDrainOperatorFeesBatch([id], [op.address]);
      expect(await NFT.migrationCredit(op.address)).to.equal(fee);
    });

    it('reverts when the supplied operator is not a current node admin (mis-resolution guard)', async () => {
      const id = await createProfile(1); // admin = accounts[0], NOT accounts[2]
      await seedOperatorFee(id, hre.ethers.parseEther('80'));
      // A wrong/stale address must revert — never silently credited.
      await expect(
        NFT.connect(accounts[0]).adminDrainOperatorFeesBatch([id], [accounts[2].address]),
      ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyProfileAdminFunction');
      // fee untouched, nothing credited
      expect(await SS.getOperatorFeeBalance(id)).to.equal(hre.ethers.parseEther('80'));
      expect(await NFT.migrationCredit(accounts[2].address)).to.equal(0n);
    });

    it('reverts on identityIds/operators length mismatch', async () => {
      const id = await createProfile(1);
      await expect(
        NFT.connect(accounts[0]).adminDrainOperatorFeesBatch([id, id], [accounts[0].address]),
      ).to.be.revertedWith('length mismatch');
    });

    it('is gated to the owner/multisig', async () => {
      const id = await createProfile(1);
      await seedOperatorFee(id, hre.ethers.parseEther('50'));
      await expect(
        NFT.connect(accounts[2]).adminDrainOperatorFeesBatch([id], [accounts[0].address]),
      ).to.be.reverted;
    });
  });

  // ===========================================================================
  // selfMigrate — self-service straggler backstop + the freeze-first gate
  // ===========================================================================
  describe('selfMigrate (straggler backstop) + freeze gate', () => {
    // register/unregister a dummy "Staking" name to simulate V8 Staking live/frozen
    const setStakingLive = (live: boolean) =>
      live
        ? HubContract.connect(accounts[0]).setContractAddress('Staking', accounts[15].address)
        : HubContract.connect(accounts[0]).removeContractByName('Staking');

    it('a missed delegator self-migrates their OWN V8 stake into credit', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('4200');
      await seedV8Stake(d, id, stake);
      // no "Staking" registered in the fixture = frozen state → drains allowed
      await expect(NFT.connect(d).selfMigrate([id]))
        .to.emit(NFT, 'MigrationStarted')
        .withArgs(d.address, stake);
      expect(await NFT.migrationCredit(d.address)).to.equal(stake);
      expect(await SS.getDelegatorStakeBase(id, keyOf(d.address))).to.equal(0n);
    });

    it('reverts NothingToMigrate when the caller has no V8 stake', async () => {
      const id = await createProfile(1);
      await expect(NFT.connect(accounts[2]).selfMigrate([id])).to.be.revertedWithCustomError(NFT, 'NothingToMigrate');
    });

    it('can only drain the caller’s OWN key (keccak256(msg.sender)) — not someone else’s', async () => {
      const victim = accounts[2];
      const attacker = accounts[3];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('1000');
      await seedV8Stake(victim, id, stake);
      // attacker self-migrates → drains keccak256(attacker), which holds nothing
      await expect(NFT.connect(attacker).selfMigrate([id])).to.be.revertedWithCustomError(NFT, 'NothingToMigrate');
      expect(await SS.getDelegatorStakeBase(id, keyOf(victim.address))).to.equal(stake); // victim untouched
    });

    it('freeze gate: drains revert while V8 Staking is live, succeed once frozen (admin + self)', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('1000');
      await seedV8Stake(d, id, stake);

      await setStakingLive(true); // simulate V8 Staking still Hub-registered
      await expect(NFT.connect(d).selfMigrate([id])).to.be.revertedWithCustomError(
        StakingV10Contract,
        'V8StakingStillLive',
      );
      // the same chokepoint gates the admin path too
      await expect(NFT.connect(accounts[0]).adminDrainBatch([d.address], [id])).to.be.revertedWithCustomError(
        StakingV10Contract,
        'V8StakingStillLive',
      );

      await setStakingLive(false); // freeze
      await NFT.connect(d).selfMigrate([id]);
      expect(await NFT.migrationCredit(d.address)).to.equal(stake);
    });

    it('selfMigrateOperatorFee: node admin self-migrates the node fee; non-admin reverts', async () => {
      const id = await createProfile(1); // admin = accounts[0]
      const fee = hre.ethers.parseEther('300');
      await TokenContract.mint(await SS.getAddress(), fee);
      await SS.connect(accounts[0]).increaseOperatorFeeBalance(id, fee);

      await expect(NFT.connect(accounts[2]).selfMigrateOperatorFee(id)).to.be.reverted; // not an admin
      await expect(NFT.connect(accounts[0]).selfMigrateOperatorFee(id))
        .to.emit(NFT, 'OperatorFeeMigrated')
        .withArgs(id, accounts[0].address, fee);
      expect(await NFT.migrationCredit(accounts[0].address)).to.equal(fee);
    });
  });

  // ===========================================================================
  // tier-0 recovery — admin-drained funds are always withdrawable
  // ===========================================================================
  describe('tier-0 recovery', () => {
    it('admin drain → allocate tier 0 → withdraw returns the full principal to the wallet', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('5000');
      await seedV8Stake(d, id, stake);
      await armCredit([[id, d.address]]);

      // Protocol pushes the drain; the user never opted in.
      await NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [id]);
      expect(await NFT.migrationCredit(d.address)).to.equal(stake);

      const walletBefore = await TokenContract.balanceOf(d.address);
      // Recovery: tier-0 allocation carries no lock, so withdraw succeeds at once.
      await NFT.connect(d).allocate(id, stake, 0);
      await NFT.connect(d).withdraw(1n);

      expect(await TokenContract.balanceOf(d.address)).to.equal(walletBefore + stake);
      expect(await NFT.migrationCredit(d.address)).to.equal(0n);
    });

    it('recovery still works after the owner deactivates tier 0 (safety net is owner-independent)', async () => {
      const d = accounts[2];
      const id = await createProfile(1);
      const stake = hre.ethers.parseEther('1000');
      await seedV8Stake(d, id, stake);
      await armCredit([[id, d.address]]);
      await NFT.connect(accounts[0]).adminMigrateToCredit(d.address, [id]);

      // Owner retires the no-lock product — must NOT trap forcibly-drained credit.
      await CSS.connect(accounts[0]).deactivateTier(0);

      const walletBefore = await TokenContract.balanceOf(d.address);
      await NFT.connect(d).allocate(id, stake, 0); // tier-0 exempt from the active-tier gate
      await NFT.connect(d).withdraw(1n);
      expect(await TokenContract.balanceOf(d.address)).to.equal(walletBefore + stake);
    });
  });

  // ===========================================================================
  // setConvictionCreditSeconds
  // ===========================================================================
  describe('setConvictionCreditSeconds', () => {
    it('owner-settable; readable via the wrapper view', async () => {
      await NFT.connect(accounts[0]).setConvictionCreditSeconds(CREDIT_SECONDS);
      expect(await NFT.convictionCreditSeconds()).to.equal(CREDIT_SECONDS);
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
