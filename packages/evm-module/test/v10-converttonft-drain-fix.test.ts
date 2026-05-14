// =============================================================================
// Regression test: TC-B1 — _convertToNFT must transfer migrated TRAC from
// StakingStorage to ConvictionStakingStorage
// =============================================================================
//
// Bug: StakingV10._convertToNFT decremented V8 accounting in StakingStorage
// (SS) and incremented V10 accounting in ConvictionStakingStorage (CSS), but
// never physically moved the underlying TRAC tokens. CSS was therefore
// undercollateralized by Σ(migrated), and withdrawals consumed TRAC deposited
// by fresh V10 stakers — a token-drain vector.
//
// Fix: ss.transferStake(address(convictionStorage), total) after V8-side
// decrements. This test verifies the physical token movement and withdrawal
// integrity under both single-migrator and multi-migrator + fresh-staker
// scenarios.
//
// Refs:
//   - .scratch/evm-review/verify/TC-B1-converttonft-drain.md (static trace)
//   - .scratch/evm-review/pentest/PT-3-conviction.md (runtime PoC)

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DelegatorsInfo,
  DKGStakingConvictionNFT,
  Hub,
  ParametersStorage,
  Profile,
  StakingStorage,
  StakingV10,
  Token,
} from '../typechain';

const SCALE18 = 10n ** 18n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  StakingV10: StakingV10;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  DelegatorsInfo: DelegatorsInfo;
  ParametersStorage: ParametersStorage;
  Profile: Profile;
  Token: Token;
  Chronos: Chronos;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'DKGStakingConvictionNFT',
    'StakingV10',
    'Profile',
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
    DelegatorsInfo: await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo'),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
  };
}

describe('@integration TC-B1 regression: _convertToNFT TRAC transfer (drain fix)', function () {
  let accounts: SignerWithAddress[];
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;
  let StakingStorageContract: StakingStorage;
  let ConvictionStakingStorageContract: ConvictionStakingStorage;
  let DelegatorsInfoContract: DelegatorsInfo;
  let ParametersStorageContract: ParametersStorage;
  let ProfileContract: Profile;
  let Token: Token;
  let ChronosContract: Chronos;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      NFT,
      StakingV10: StakingV10Contract,
      StakingStorage: StakingStorageContract,
      ConvictionStakingStorage: ConvictionStakingStorageContract,
      DelegatorsInfo: DelegatorsInfoContract,
      ParametersStorage: ParametersStorageContract,
      Profile: ProfileContract,
      Token,
      Chronos: ChronosContract,
    } = await loadFixture(deployFixture));
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a fresh profile; returns identityId.
   * `msg.sender` (operational wallet) must differ from `adminWallet`.
   * Uses accounts[1] as the operational caller and accounts[0] as admin
   * — mirroring the pattern in v10-conviction.test.ts.
   */
  const createProfile = async () => {
    const nodeId = hre.ethers.hexlify(hre.ethers.randomBytes(32));
    const tx = await ProfileContract.connect(accounts[1]).createProfile(
      accounts[0].address, // adminWallet != msg.sender (accounts[1])
      [],
      `Node-${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    const identityId = Number(receipt!.logs[0].topics[1]);
    return identityId;
  };

  /**
   * Seed a V8 stake directly in StakingStorage (bypasses V8 Staking contract,
   * which is acceptable here — we are exercising the migration path, not V8
   * deposit correctness). Hub owner can call `onlyContracts` setters.
   */
  const seedV8Stake = async (
    delegator: SignerWithAddress,
    identityId: number,
    stakeBase: bigint,
  ) => {
    const v8Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [delegator.address]),
    );
    // Mint TRAC into SS vault to represent physical V8 balance.
    await Token.mint(await StakingStorageContract.getAddress(), stakeBase);
    // Write SS accounting.
    await StakingStorageContract.connect(accounts[0]).increaseDelegatorStakeBase(
      identityId,
      v8Key,
      stakeBase,
    );
    await StakingStorageContract.connect(accounts[0]).increaseNodeStake(
      identityId,
      stakeBase,
    );
    await StakingStorageContract.connect(accounts[0]).increaseTotalStake(stakeBase);
    // Mirror V8 DelegatorsInfo entries required by selfMigrateV8 checks.
    await DelegatorsInfoContract.connect(accounts[0]).addDelegator(
      identityId,
      delegator.address,
    );
    await DelegatorsInfoContract.connect(accounts[0]).setHasEverDelegatedToNode(
      identityId,
      delegator.address,
      true,
    );
    const currentEpoch = await ChronosContract.getCurrentEpoch();
    const baseline = currentEpoch > 0n ? currentEpoch - 1n : 0n;
    await DelegatorsInfoContract.connect(accounts[0]).setLastClaimedEpoch(
      identityId,
      delegator.address,
      baseline,
    );
    return v8Key;
  };

  /** Advance time past a lock-tier expiry (tier 1 = 1-epoch lock). */
  const advancePastLock = async () => {
    const epochLength = await ChronosContract.epochLength();
    // 3 epochs clears the 1-epoch tier + computation buffer (see Test 4 in
    // v10-conviction.test.ts for the same pattern).
    await time.increase(Number(epochLength) * 3);
  };

  // ---------------------------------------------------------------------------
  // Scenario 1: single migrator — TRAC physically moves SS → CSS on migration
  // ---------------------------------------------------------------------------
  //
  // Invariants tested:
  //   A. After selfMigrateV8: SS balance decreases by `total`, CSS balance
  //      increases by `total`.
  //   B. After withdraw (post lock expiry): delegator receives TRAC back,
  //      no ERC20InsufficientBalance revert.
  it('Scenario 1: single migrator — SS balance decreases and CSS balance increases by migrated amount', async () => {
    const identityId = await createProfile();
    const migrationAmount = hre.ethers.parseEther('5000');

    const ssAddr = await StakingStorageContract.getAddress();
    const cssAddr = await ConvictionStakingStorageContract.getAddress();

    await seedV8Stake(accounts[2], identityId, migrationAmount);

    // Record balances BEFORE migration.
    const ssBalBefore = await Token.balanceOf(ssAddr);
    const cssBalBefore = await Token.balanceOf(cssAddr);

    expect(ssBalBefore).to.equal(
      migrationAmount,
      'SS must hold migrationAmount before migration',
    );
    expect(cssBalBefore).to.equal(0n, 'CSS must hold 0 before migration');

    // Execute migration.
    await NFT.connect(accounts[2]).selfMigrateV8(identityId, 1 /* 1-epoch lock */);

    // Record balances AFTER migration.
    const ssBalAfter = await Token.balanceOf(ssAddr);
    const cssBalAfter = await Token.balanceOf(cssAddr);

    // KEY ASSERTIONS — the fix must cause these to hold.
    expect(ssBalAfter).to.equal(
      ssBalBefore - migrationAmount,
      'SS balance must decrease by migrated amount after _convertToNFT',
    );
    expect(cssBalAfter).to.equal(
      cssBalBefore + migrationAmount,
      'CSS balance must increase by migrated amount after _convertToNFT',
    );

    // NFT was minted to the migrator.
    expect(await NFT.ownerOf(1)).to.equal(accounts[2].address);

    // CSS position raw == migrated amount.
    const pos = await ConvictionStakingStorageContract.getPosition(1);
    expect(pos.raw).to.equal(migrationAmount);

    // Advance past lock, then withdraw — must succeed without revert.
    await advancePastLock();

    const stakerBalBefore = await Token.balanceOf(accounts[2].address);
    await expect(NFT.connect(accounts[2]).withdraw(1)).to.not.be.reverted;
    const stakerBalAfter = await Token.balanceOf(accounts[2].address);

    // Delegator must receive at least the migrated principal back.
    expect(stakerBalAfter - stakerBalBefore).to.be.gte(
      migrationAmount,
      'Migrator must receive migrated TRAC back on withdrawal',
    );

    // CSS is now drained for this position.
    const posAfter = await ConvictionStakingStorageContract.getPosition(1);
    expect(posAfter.identityId).to.equal(0n, 'CSS position must be deleted after withdraw');

    // NFT burned.
    await expect(NFT.ownerOf(1)).to.be.revertedWithCustomError(NFT, 'ERC721NonexistentToken');
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: multi-migrator + fresh-staker pool integrity
  // ---------------------------------------------------------------------------
  //
  // Attack PoC (pre-fix): migrators A and B each convert V8 stake. Fresh V10
  // staker C deposits into CSS. A withdraws → drains C's TRAC. C's withdrawal
  // reverts. With the fix, every withdrawal must succeed.
  //
  // Invariants tested:
  //   A. After both migrations: CSS balance == migrationA + migrationB.
  //   B. After fresh staker C deposits: CSS balance ==
  //      migrationA + migrationB + freshStake.
  //   C. All three withdrawals succeed.
  //   D. Final CSS balance == 0 (all TRAC returned to owners).
  it('Scenario 2: two migrators + fresh V10 staker — no shared-pool drain, all withdrawals succeed', async () => {
    const identityId = await createProfile();
    const migrationA = hre.ethers.parseEther('3000');
    const migrationB = hre.ethers.parseEther('2000');
    const freshStake = hre.ethers.parseEther('5000');

    const ssAddr = await StakingStorageContract.getAddress();
    const cssAddr = await ConvictionStakingStorageContract.getAddress();
    const nftAddr = await NFT.getAddress();

    // Seed V8 positions for migrators A (accounts[2]) and B (accounts[3]).
    await seedV8Stake(accounts[2], identityId, migrationA);
    await seedV8Stake(accounts[3], identityId, migrationB);

    // Migrate A.
    await NFT.connect(accounts[2]).selfMigrateV8(identityId, 1);
    // Migrate B. tokenId for B is 2.
    await NFT.connect(accounts[3]).selfMigrateV8(identityId, 1);

    // CSS balance after both migrations == migrationA + migrationB.
    const cssAfterMigrations = await Token.balanceOf(cssAddr);
    expect(cssAfterMigrations).to.equal(
      migrationA + migrationB,
      'CSS must hold both migrated amounts after migrations',
    );
    expect(await Token.balanceOf(ssAddr)).to.equal(
      0n,
      'SS must hold 0 after all migrations complete',
    );

    // Fresh V10 staker C deposits via NFT. StakingV10 pulls TRAC directly
    // into CSS via token.transferFrom(staker, CSS, amount), so the approval
    // must be for StakingV10 (not the NFT wrapper). tokenId for C is 3.
    const sv10Addr = await StakingV10Contract.getAddress();
    await Token.mint(accounts[4].address, freshStake);
    await Token.connect(accounts[4]).approve(sv10Addr, freshStake);
    await NFT.connect(accounts[4]).createConviction(identityId, freshStake, 1);

    const cssAfterFreshStake = await Token.balanceOf(cssAddr);
    expect(cssAfterFreshStake).to.equal(
      migrationA + migrationB + freshStake,
      'CSS must hold both migrated + fresh stake amounts',
    );

    // Advance past lock so all positions can withdraw.
    await advancePastLock();

    // All withdrawals must succeed (would revert pre-fix with ERC20InsufficientBalance).
    await expect(NFT.connect(accounts[2]).withdraw(1)).to.not.be.reverted;
    await expect(NFT.connect(accounts[3]).withdraw(2)).to.not.be.reverted;
    await expect(NFT.connect(accounts[4]).withdraw(3)).to.not.be.reverted;

    // Each owner received their TRAC back.
    const aFinal = await Token.balanceOf(accounts[2].address);
    const bFinal = await Token.balanceOf(accounts[3].address);
    const cFinal = await Token.balanceOf(accounts[4].address);
    expect(aFinal).to.be.gte(migrationA, 'Migrator A must be refunded');
    expect(bFinal).to.be.gte(migrationB, 'Migrator B must be refunded');
    expect(cFinal).to.be.gte(freshStake, 'Fresh staker C must be refunded');

    // CSS drained to 0 (no TRAC stranded anywhere).
    expect(await Token.balanceOf(cssAddr)).to.equal(
      0n,
      'CSS must be fully drained after all withdrawals',
    );
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: migration with pending V8 withdrawal (D8) also transfers TRAC
  // ---------------------------------------------------------------------------
  //
  // D8: _convertToNFT absorbs BOTH stakeBase AND pendingWithdrawal into `total`.
  // The TRAC transfer must cover the full `total`, not just `stakeBase`.
  it('Scenario 3: D8 migration (stakeBase + pending) — full total transferred from SS to CSS', async () => {
    const identityId = await createProfile();
    const stakeBase = hre.ethers.parseEther('2000');
    const pending = hre.ethers.parseEther('500');
    const total = stakeBase + pending;

    const ssAddr = await StakingStorageContract.getAddress();
    const cssAddr = await ConvictionStakingStorageContract.getAddress();

    // Seed stakeBase.
    await seedV8Stake(accounts[2], identityId, stakeBase);

    // Also seed a pending withdrawal request for the same delegator.
    const v8Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[2].address]),
    );
    // Mint additional TRAC for the pending amount (not minted by seedV8Stake).
    await Token.mint(ssAddr, pending);
    await StakingStorageContract.connect(accounts[0]).createDelegatorWithdrawalRequest(
      identityId,
      v8Key,
      pending,
      0, // indexedOutAmount (not relevant for migration)
      1, // timestamp (past value, not inspected by _convertToNFT)
    );

    const ssBalBefore = await Token.balanceOf(ssAddr);
    const cssBalBefore = await Token.balanceOf(cssAddr);

    expect(ssBalBefore).to.equal(total, 'SS must hold stakeBase + pending before migration');

    await NFT.connect(accounts[2]).selfMigrateV8(identityId, 1);

    const ssBalAfter = await Token.balanceOf(ssAddr);
    const cssBalAfter = await Token.balanceOf(cssAddr);

    // Full `total` (stakeBase + pending) must move.
    expect(ssBalAfter).to.equal(0n, 'SS must hold 0 after D8 migration');
    expect(cssBalAfter).to.equal(
      total,
      'CSS must hold stakeBase + pending after D8 migration',
    );

    // CSS position raw == stakeBase + pending (D8 invariant).
    const pos = await ConvictionStakingStorageContract.getPosition(1);
    expect(pos.raw).to.equal(total, 'CSS position raw must equal stakeBase + pending (D8)');

    // Withdraw succeeds.
    await advancePastLock();
    await expect(NFT.connect(accounts[2]).withdraw(1)).to.not.be.reverted;
  });
});
