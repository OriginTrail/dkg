// =============================================================================
// V10 Phase 5 — high-level integration smoke test
// =============================================================================
//
// Purpose: exercise the NFT-backed staking surface end-to-end at the top
// layer (DKGStakingConvictionNFT → StakingV10 → storage) to catch deploy-
// wiring regressions and multi-contract integration breaks. The exhaustive
// unit-test surface lives in `test/unit/DKGStakingConvictionNFT.test.ts`
// (87 tests) and `test/unit/ConvictionStakingStorage.test.ts` (57 tests);
// this file is deliberately short.
//
// Legacy note: previous revisions tested `Staking.convictionMultiplier`
// (V8 pure math, now deleted in Phase 11) and `PublishingConvictionAccount`
// basic flows. The canonical tier table now lives in
// `DKGStakingConvictionNFT._convictionMultiplier` (exact-match semantics),
// tested in `test/unit/DKGStakingConvictionNFT.test.ts`.
// `PublishingConvictionAccount` flows are the `Flow 2` suite in the e2e file.
// This file is focused on the Phase 5 NFT + StakingV10 stack.

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
  StakingStorage,
  StakingV10,
  Token,
} from '../typechain';

const SCALE18 = 10n ** 18n;
const SIX_X = 6n * SCALE18;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  StakingV10: StakingV10;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  DelegatorsInfo: DelegatorsInfo;
  RandomSamplingStorage: RandomSamplingStorage;
  ParametersStorage: ParametersStorage;
  Profile: Profile;
  Token: Token;
  Chronos: Chronos;
};

async function deployFixture(): Promise<Fixture> {
  // Full V10 graph — the `DKGStakingConvictionNFT` tag's dependency list
  // pulls Hub, StakingV10, Staking, ConvictionStakingStorage, storages,
  // Profile, and Token in one shot.
  await hre.deployments.fixture([
    'DKGStakingConvictionNFT',
    'StakingV10',
    'Profile',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  // Grant HubOwner to accounts[0] so tests can poke privileged setters
  // (e.g. RandomSamplingStorage.setNodeEpochScorePerStake).
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
    DelegatorsInfo: await hre.ethers.getContract<DelegatorsInfo>(
      'DelegatorsInfo',
    ),
    RandomSamplingStorage: await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    ),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>(
      'ParametersStorage',
    ),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
  };
}

describe('@integration V10 Phase 5 — NFT-backed staking', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;
  let StakingStorageContract: StakingStorage;
  let ConvictionStakingStorageContract: ConvictionStakingStorage;
  let DelegatorsInfoContract: DelegatorsInfo;
  let RandomSamplingStorageContract: RandomSamplingStorage;
  let ProfileContract: Profile;
  let Token: Token;
  let ChronosContract: Chronos;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub,
      NFT,
      StakingV10: StakingV10Contract,
      StakingStorage: StakingStorageContract,
      ConvictionStakingStorage: ConvictionStakingStorageContract,
      DelegatorsInfo: DelegatorsInfoContract,
      RandomSamplingStorage: RandomSamplingStorageContract,
      Profile: ProfileContract,
      Token,
      Chronos: ChronosContract,
    } = await loadFixture(deployFixture));
  });

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  // Mint a fresh profile via `Profile.createProfile`. Mirrors the unit-test
  // helper in `test/unit/DKGStakingConvictionNFT.test.ts`.
  const createProfile = async () => {
    const nodeId = '0x' + randomBytes(32).toString('hex');
    const tx = await ProfileContract.connect(accounts[1]).createProfile(
      accounts[0].address,
      [],
      `Node ${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    const identityId = Number(receipt!.logs[0].topics[1]);
    return { nodeId, identityId };
  };

  // User approves StakingV10 directly — `StakingV10.stake` pulls TRAC via
  // `token.transferFrom(staker, stakingStorage, amount)` on the NFT path.
  const mintAndApprove = async (
    staker: SignerWithAddress,
    amount: bigint,
  ) => {
    await Token.mint(staker.address, amount);
    await Token.connect(staker).approve(
      await StakingV10Contract.getAddress(),
      amount,
    );
  };

  // bytes32 delegator key for the V10 NFT path — disjoint from V8's
  // `keccak256(abi.encodePacked(address))`.
  const tokenIdKey = (tokenId: bigint | number): string =>
    hre.ethers.zeroPadValue(hre.ethers.toBeHex(tokenId), 32);

  // --------------------------------------------------------------------------
  // Test 1 — deploy + Hub wiring
  // --------------------------------------------------------------------------
  //
  // Deploy-graph smoke check: every Hub-registered dependency the two
  // contracts read in `initialize()` must be resolvable, and the
  // `onlyConvictionNFT` gate on StakingV10 must actually point at the
  // deployed NFT. This catches deploy-script regressions where the
  // dependency list drifts from the contract's `initialize()`.
  it('deploys the full V10 staking graph and wires NFT ↔ StakingV10', async () => {
    // Hub returns the deployed addresses for both Phase 5 contracts.
    const nftAddr = await NFT.getAddress();
    const sv10Addr = await StakingV10Contract.getAddress();
    expect(await Hub.getContractAddress('DKGStakingConvictionNFT')).to.equal(
      nftAddr,
    );
    expect(await Hub.getContractAddress('StakingV10')).to.equal(sv10Addr);

    // `StakingV10.stake` is gated `onlyConvictionNFT` — a direct caller
    // (accounts[0], which is NOT the NFT contract) must revert.
    const { identityId } = await createProfile();
    await mintAndApprove(accounts[0], 1_000n);
    await expect(
      StakingV10Contract.connect(accounts[0]).stake(
        accounts[0].address,
        42,
        identityId,
        1_000n,
        12,
      ),
    ).to.be.revertedWithCustomError(StakingV10Contract, 'OnlyConvictionNFT');
  });

  // --------------------------------------------------------------------------
  // Test 2 — createConviction happy path
  // --------------------------------------------------------------------------
  //
  // End-to-end happy path: user approves StakingV10, calls
  // NFT.createConviction, and we verify the full state write surface:
  //   - ERC-721 token minted to user
  //   - TRAC moved user → StakingStorage (NFT wrapper holds nothing)
  //   - StakingStorage totals + delegator base updated
  //   - ConvictionStakingStorage position carries the right tier
  it('createConviction: 12-month tier mints NFT + writes storage through to SS + CSS', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('10000');
    await mintAndApprove(accounts[0], amount);

    const ssAddr = await StakingStorageContract.getAddress();
    const nftAddr = await NFT.getAddress();
    const stakerBalBefore = await Token.balanceOf(accounts[0].address);
    const ssBalBefore = await Token.balanceOf(ssAddr);

    await expect(
      NFT.connect(accounts[0]).createConviction(identityId, amount, 12),
    )
      .to.emit(NFT, 'PositionCreated')
      .withArgs(accounts[0].address, 1n, identityId, amount, 12)
      .and.to.emit(StakingV10Contract, 'Staked')
      .withArgs(1n, accounts[0].address, identityId, amount, 12);

    // NFT minted (tokenId 0).
    expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
    expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);

    // TRAC moved in one hop: staker → StakingStorage (shared vault). NFT
    // wrapper untouched. Note (D15): even though V10 accounting lives on
    // ConvictionStakingStorage, the TRAC custody vault is still the V8
    // StakingStorage contract — V10 does not run its own ERC-20 vault.
    expect(await Token.balanceOf(accounts[0].address)).to.equal(
      stakerBalBefore - amount,
    );
    expect(await Token.balanceOf(ssAddr)).to.equal(ssBalBefore + amount);
    expect(await Token.balanceOf(nftAddr)).to.equal(0n);

    // D15 — V10 stake lives in ConvictionStakingStorage. StakingStorage
    // keeps track of the TRAC custody only (no delegator-base rows for V10
    // tokenId keys). The V8 `getDelegatorStakeBase` / `getNodeStake`
    // getters stay zero for V10 positions.
    expect(
      await ConvictionStakingStorageContract.getNodeStakeV10(identityId),
    ).to.equal(amount);
    expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(
      amount,
    );

    // ConvictionStakingStorage position carries the 6x tier.
    const pos = await ConvictionStakingStorageContract.getPosition(1);
    expect(pos.identityId).to.equal(identityId);
    expect(pos.raw).to.equal(amount);
    expect(pos.lockTier).to.equal(12);
    expect(pos.multiplier18).to.equal(SIX_X);
  });

  // --------------------------------------------------------------------------
  // Test 3 — claim after time advance compounds rewards into raw (D19)
  // --------------------------------------------------------------------------
  //
  // Inject per-epoch `nodeEpochScorePerStake`, `nodeEpochScore`,
  // `allNodesEpochScore`, and `epochPool` via hub-owner-privileged setters,
  // advance one epoch, and call `NFT.claim`. The Phase 11 TRAC formula is:
  //     delegatorScore18 = effStake * scorePerStake36 / 1e18
  //     grossNodeRewards = epochPool * nodeScore18 / allNodesScore18
  //     reward = delegatorScore18 * grossNodeRewards / nodeScore18
  // (with operatorFee = 0 for a fresh profile). We verify the
  // `RewardsClaimed` event fires and the reward compounds directly into
  // `pos.raw` (D19 — the separate `rewards` bucket was removed; claims
  // increment raw principal and `cumulativeRewardsClaimed`).
  it('claim: reward accrues after one-epoch advance and compounds into pos.raw (D19)', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('1000');
    await mintAndApprove(accounts[0], amount);
    await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

    // Creation epoch baseline.
    const creationEpoch = await ChronosContract.getCurrentEpoch();
    const epochLength = await ChronosContract.epochLength();
    await time.increase(Number(epochLength));

    // Inject score for the single walkable epoch (creationEpoch).
    // Pre-expiry, 12-epoch lock -> multiplier 6x. Single node, opFee=0.
    const scorePerStake36 = hre.ethers.parseEther('0.001'); // 1e15
    const nodeScore18 = hre.ethers.parseEther('100');
    const allNodesScore18 = nodeScore18;
    const epochPool = hre.ethers.parseEther('1000');

    await RandomSamplingStorageContract.connect(
      accounts[0],
    ).setNodeEpochScorePerStake(creationEpoch, identityId, scorePerStake36);
    await RandomSamplingStorageContract.connect(
      accounts[0],
    ).setNodeEpochScore(creationEpoch, identityId, nodeScore18);
    await RandomSamplingStorageContract.connect(
      accounts[0],
    ).setAllNodesEpochScore(creationEpoch, allNodesScore18);
    const EpochStorageContract = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    await EpochStorageContract.connect(accounts[0]).addTokensToEpochRange(
      1,
      creationEpoch,
      creationEpoch,
      epochPool,
    );

    const effStake = (amount * SIX_X) / SCALE18;
    const delegatorScore18 = (effStake * scorePerStake36) / SCALE18;
    const grossNodeRewards = (epochPool * nodeScore18) / allNodesScore18;
    const expectedReward = (delegatorScore18 * grossNodeRewards) / nodeScore18;

    // Pre-fund the StakingStorage vault with the anticipated reward so the
    // post-claim node-stake bookkeeping stays tied to on-chain TRAC.
    await Token.mint(
      await StakingStorageContract.getAddress(),
      expectedReward,
    );

    await expect(NFT.connect(accounts[0]).claim(1))
      .to.emit(StakingV10Contract, 'RewardsClaimed')
      .withArgs(1n, expectedReward);

    // D19 — rewards compound directly into `raw`; no separate `rewards`
    // bucket exists anymore. `cumulativeRewardsClaimed` is the running
    // total of every reward ever banked into this position (stat only,
    // not used in any settlement math).
    const pos = await ConvictionStakingStorageContract.getPosition(1);
    expect(pos.raw).to.equal(amount + expectedReward);
    expect(pos.cumulativeRewardsClaimed).to.equal(expectedReward);
  });

  // --------------------------------------------------------------------------
  // Test 4 — atomic withdrawal (D14)
  // --------------------------------------------------------------------------
  //
  // End-to-end withdrawal: lock on a 1-epoch tier, advance past expiry,
  // call `withdraw` once — StakingV10 auto-claims any outstanding rewards,
  // drains the full post-claim `raw`, deletes the CSS position, burns the
  // NFT, and transfers TRAC back to the owner. Verifies the refund, the
  // node-stake drain, and the NFT burn.
  it('atomic withdrawal: post-expiry withdraw auto-claims, refunds TRAC and burns NFT (D14)', async () => {
    const { identityId } = await createProfile();
    const ParametersStorage =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const minStake = await ParametersStorage.minimumStake();
    // Stake exactly minStake so a full drain drops nodeStake to 0 (below
    // minStake, the sharding-table node is removed by StakingV10).
    await mintAndApprove(accounts[0], minStake);
    await NFT.connect(accounts[0]).createConviction(identityId, minStake, 1);

    // Advance past the 1-epoch lock. `_computeExpiryEpoch(1)` snaps to
    // `epochAtTimestamp(now + 30d + blockDriftBuffer) + 1`, which lands 2
    // epochs beyond the mint epoch on a 30-day schedule. Bump 3 epochs to
    // clear the expiry + buffer with margin.
    const epochLength = await ChronosContract.epochLength();
    await time.increase(Number(epochLength) * 3);

    // D26: finalization is now automatic via `CSS.settleNodeTo` which drains
    // the per-node expiry queue lazily. Dormant windows no longer walk every
    // epoch — the queue is event-density-bounded, not time-density-bounded.
    // Identity parameter kept for readability in the rest of the test.
    void identityId;

    // Snapshot raw BEFORE the atomic withdraw. The call auto-claims,
    // which may compound rewards into raw; the on-chain payout is the
    // post-claim value. Rather than trying to predict it here, read it
    // back via the token-balance delta and the CSS state.
    const stakerBalBefore = await Token.balanceOf(accounts[0].address);
    await NFT.connect(accounts[0]).withdraw(1);
    const stakerBalAfter = await Token.balanceOf(accounts[0].address);

    // TRAC refund is at least the original principal (rewards compound
    // on top, so the transferred amount can be strictly greater).
    expect(stakerBalAfter - stakerBalBefore).to.be.gte(minStake);

    // D15 — V10 node stake lives on ConvictionStakingStorage; drained to 0.
    expect(
      await ConvictionStakingStorageContract.getNodeStakeV10(identityId),
    ).to.equal(0n);
    // CSS position deleted.
    const posAfter = await ConvictionStakingStorageContract.getPosition(1);
    expect(posAfter.identityId).to.equal(0n);
    // NFT burned → ownerOf reverts.
    await expect(NFT.ownerOf(1)).to.be.revertedWithCustomError(
      NFT,
      'ERC721NonexistentToken',
    );
  });

  // --------------------------------------------------------------------------
  // Test 5 — selfMigrateV8: V8 → V10 migration (D7 + D8)
  // --------------------------------------------------------------------------
  //
  // End-to-end V8-to-V10 migration smoke: set up a V8 address-keyed
  // delegator position directly (faster + decoupled from V8 `stake()`
  // correctness — `test/unit/Staking.test.ts` owns that), then call
  // `NFT.selfMigrateV8(identityId, lockTier)` and verify:
  //   - V8 bucket drained
  //   - V10 position created with `raw = stakeBaseAbsorbed + pendingAbsorbed` (D8)
  //   - V10 aggregates (`totalStakeV10`, `nodeStakeV10`) grow by the migrated
  //     amount (D15 — V10 has its own aggregates; V8 ones are NOT decremented
  //     in this direct-seeding setup since we never went through V8 `stake()`)
  //   - NFT owned by the migrator
  it('selfMigrateV8: V8 stake migrates into V10 NFT position (D7+D8+D15)', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('1000');

    // V8 delegator key formula — `keccak256(abi.encodePacked(address))`
    // (see Staking.sol `_getDelegatorKey`).
    const v8Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );

    // Mint vault TRAC so any downstream withdrawal has funds and the V8
    // totals stay consistent with the on-chain balance.
    await Token.mint(await StakingStorageContract.getAddress(), amount);

    // Set up a V8 stake directly — the hub owner can call `onlyContracts`
    // setters (see `HubDependent._checkHubContract`). Mirrors a V8
    // `Staking.stake` end state with a fully-claimed delegator.
    await StakingStorageContract.connect(
      accounts[0],
    ).increaseDelegatorStakeBase(identityId, v8Key, amount);
    await StakingStorageContract.connect(accounts[0]).increaseNodeStake(
      identityId,
      amount,
    );
    await StakingStorageContract.connect(accounts[0]).increaseTotalStake(
      amount,
    );
    await DelegatorsInfoContract.connect(accounts[0]).addDelegator(
      identityId,
      accounts[0].address,
    );
    await DelegatorsInfoContract.connect(
      accounts[0],
    ).setHasEverDelegatedToNode(identityId, accounts[0].address, true);
    const currentEpoch = await ChronosContract.getCurrentEpoch();
    // Floor at 0 — currentEpoch on a fresh fixture is 1.
    const baseline = currentEpoch > 0n ? currentEpoch - 1n : 0n;
    await DelegatorsInfoContract.connect(accounts[0]).setLastClaimedEpoch(
      identityId,
      accounts[0].address,
      baseline,
    );

    const totalStakeV10Before =
      await ConvictionStakingStorageContract.totalStakeV10();
    const nodeStakeV10Before =
      await ConvictionStakingStorageContract.getNodeStakeV10(identityId);

    // D8 — both stakeBaseAbsorbed (V8 principal) and pendingAbsorbed (V8
    // pending withdrawal) collapse into a single V10 `raw` value. In this
    // direct-seeding setup we only wrote the principal, so pendingAbsorbed
    // is 0 and `raw = amount`. `isAdmin = false` since this is a
    // staker-initiated self-migration via the NFT wrapper.
    await expect(NFT.connect(accounts[0]).selfMigrateV8(identityId, 12))
      .to.emit(NFT, 'ConvertedFromV8')
      .withArgs(accounts[0].address, 1n, identityId, 12, false)
      .and.to.emit(StakingV10Contract, 'ConvertedFromV8')
      .withArgs(accounts[0].address, 1n, identityId, amount, 0n, 12, false);

    // V8 bucket drained.
    expect(
      await StakingStorageContract.getDelegatorStakeBase(identityId, v8Key),
    ).to.equal(0n);

    // D15 — V10 position lives in ConvictionStakingStorage. V10 does not
    // write a mirror row into StakingStorage under the tokenId key; V10
    // aggregates live on CSS.
    const pos = await ConvictionStakingStorageContract.getPosition(1);
    expect(pos.raw).to.equal(amount);
    expect(pos.lockTier).to.equal(12);
    expect(pos.multiplier18).to.equal(SIX_X);

    // V10 aggregates grow by the migrated amount (D15).
    expect(await ConvictionStakingStorageContract.totalStakeV10()).to.equal(
      totalStakeV10Before + amount,
    );
    expect(
      await ConvictionStakingStorageContract.getNodeStakeV10(identityId),
    ).to.equal(nodeStakeV10Before + amount);

    // NFT owned by migrator.
    expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
  });
});
