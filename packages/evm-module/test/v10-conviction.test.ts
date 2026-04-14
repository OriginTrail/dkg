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
// (V8 pure math) and `PublishingConvictionAccount` basic flows. Both are
// covered elsewhere:
//   - V8 `convictionMultiplier` snap-down math is checked in
//     `test/v10-e2e-conviction.test.ts::Flow 1::verifies all conviction
//     multiplier tiers`.
//   - `PublishingConvictionAccount` flows are the `Flow 2` suite in the
//     same e2e file.
// The previous scope is removed here to avoid duplication and keep this
// file focused on the Phase 5 NFT + StakingV10 stack.

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
const WITHDRAWAL_DELAY_SECONDS = 15 * 24 * 60 * 60;

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
      .withArgs(accounts[0].address, 0n, identityId, amount, 12)
      .and.to.emit(StakingV10Contract, 'Staked')
      .withArgs(0n, accounts[0].address, identityId, amount, 12);

    // NFT minted (tokenId 0).
    expect(await NFT.ownerOf(0)).to.equal(accounts[0].address);
    expect(await NFT.balanceOf(accounts[0].address)).to.equal(1n);

    // TRAC moved in one hop: staker → StakingStorage. NFT wrapper untouched.
    expect(await Token.balanceOf(accounts[0].address)).to.equal(
      stakerBalBefore - amount,
    );
    expect(await Token.balanceOf(ssAddr)).to.equal(ssBalBefore + amount);
    expect(await Token.balanceOf(nftAddr)).to.equal(0n);

    // StakingStorage bookkeeping.
    expect(
      await StakingStorageContract.getDelegatorStakeBase(
        identityId,
        tokenIdKey(0),
      ),
    ).to.equal(amount);
    expect(await StakingStorageContract.getNodeStake(identityId)).to.equal(
      amount,
    );

    // ConvictionStakingStorage position carries the 6x tier.
    const pos = await ConvictionStakingStorageContract.getPosition(0);
    expect(pos.identityId).to.equal(identityId);
    expect(pos.raw).to.equal(amount);
    expect(pos.lockEpochs).to.equal(12);
    expect(pos.multiplier18).to.equal(SIX_X);
  });

  // --------------------------------------------------------------------------
  // Test 3 — claim after time advance banks rewards
  // --------------------------------------------------------------------------
  //
  // Inject a per-epoch `nodeEpochScorePerStake` via the hub-owner-privileged
  // `RandomSamplingStorage.setNodeEpochScorePerStake`, advance one epoch,
  // and call `NFT.claim`. The Phase 5 stub formula is:
  //     reward = effStake * scorePerStake36 / 1e18
  // where `effStake = raw * multiplier18 / 1e18` pre-expiry. We verify the
  // `RewardsClaimed` event fires and the position's `rewards` bucket
  // matches.
  it('claim: reward accrues after one-epoch advance and banks into position.rewards', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('1000');
    await mintAndApprove(accounts[0], amount);
    await NFT.connect(accounts[0]).createConviction(identityId, amount, 12);

    // Creation epoch baseline.
    const creationEpoch = await ChronosContract.getCurrentEpoch();
    const epochLength = await ChronosContract.epochLength();
    await time.increase(Number(epochLength));

    // Inject score for the single walkable epoch (creationEpoch).
    // Pre-expiry, 12-epoch lock → multiplier 6x.
    const scorePerStake36 = hre.ethers.parseEther('0.001'); // 1e15
    await RandomSamplingStorageContract.connect(
      accounts[0],
    ).setNodeEpochScorePerStake(creationEpoch, identityId, scorePerStake36);

    const effStake = (amount * SIX_X) / SCALE18;
    const expectedReward = (effStake * scorePerStake36) / SCALE18;

    // Pre-fund the StakingStorage vault with the anticipated reward so the
    // post-claim node-stake bookkeeping stays tied to on-chain TRAC.
    await Token.mint(
      await StakingStorageContract.getAddress(),
      expectedReward,
    );

    await expect(NFT.connect(accounts[0]).claim(0))
      .to.emit(StakingV10Contract, 'RewardsClaimed')
      .withArgs(0n, expectedReward);

    const pos = await ConvictionStakingStorageContract.getPosition(0);
    expect(pos.rewards).to.equal(expectedReward);
    expect(pos.raw).to.equal(amount); // raw untouched by claim
  });

  // --------------------------------------------------------------------------
  // Test 4 — withdrawal lifecycle: createWithdrawal → finalizeWithdrawal
  // --------------------------------------------------------------------------
  //
  // End-to-end withdrawal: lock on a 1-epoch tier, advance past expiry,
  // call `createWithdrawal` for the full amount, wait past the 15-day
  // delay, then `finalizeWithdrawal`. Verifies TRAC is refunded to the
  // staker and the NFT is burned (full drain).
  it('withdrawal lifecycle: create → wait delay → finalize refunds TRAC and burns NFT on full drain', async () => {
    const { identityId } = await createProfile();
    const ParametersStorage =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const minStake = await ParametersStorage.minimumStake();
    // Stake exactly minStake so a full drain drops nodeStake to 0 (below
    // minStake, the sharding-table node is removed by StakingV10).
    await mintAndApprove(accounts[0], minStake);
    await NFT.connect(accounts[0]).createConviction(identityId, minStake, 1);

    // Advance past the 1-epoch lock.
    const epochLength = await ChronosContract.epochLength();
    await time.increase(Number(epochLength) * 2);

    // Start the 15-day withdrawal timer for the full stake.
    await NFT.connect(accounts[0]).createWithdrawal(0, minStake);

    // Pre-delay finalize must revert.
    await expect(
      NFT.connect(accounts[0]).finalizeWithdrawal(0),
    ).to.be.revertedWithCustomError(
      StakingV10Contract,
      'WithdrawalDelayPending',
    );

    // Wait out the delay. Crossing 15 days advances Chronos by ~360 epochs,
    // so the next CSS mutator would walk that entire dormant window — we
    // amortize the walk via the hub-owner-privileged
    // `finalizeEffectiveStakeUpTo` entry point so finalize stays under
    // the per-tx gas cap.
    await time.increase(WITHDRAWAL_DELAY_SECONDS + 1);

    const currentEpochBeforeFin = Number(
      await ChronosContract.getCurrentEpoch(),
    );
    const lastGlobal = Number(
      await ConvictionStakingStorageContract.getLastFinalizedEpoch(),
    );
    const lastNode = Number(
      await ConvictionStakingStorageContract.getNodeLastFinalizedEpoch(
        identityId,
      ),
    );
    const target = currentEpochBeforeFin - 1;
    const chunk = 50;
    for (let e = lastGlobal + chunk; e <= target; e += chunk) {
      await ConvictionStakingStorageContract.connect(
        accounts[0],
      ).finalizeEffectiveStakeUpTo(e);
    }
    if (lastGlobal < target) {
      await ConvictionStakingStorageContract.connect(
        accounts[0],
      ).finalizeEffectiveStakeUpTo(target);
    }
    for (let e = lastNode + chunk; e <= target; e += chunk) {
      await ConvictionStakingStorageContract.connect(
        accounts[0],
      ).finalizeNodeEffectiveStakeUpTo(identityId, e);
    }
    if (lastNode < target) {
      await ConvictionStakingStorageContract.connect(
        accounts[0],
      ).finalizeNodeEffectiveStakeUpTo(identityId, target);
    }

    const stakerBalBefore = await Token.balanceOf(accounts[0].address);
    await NFT.connect(accounts[0]).finalizeWithdrawal(0);

    // TRAC refunded.
    expect(await Token.balanceOf(accounts[0].address)).to.equal(
      stakerBalBefore + minStake,
    );
    // Node stake drained.
    expect(await StakingStorageContract.getNodeStake(identityId)).to.equal(0n);
    // NFT burned → ownerOf reverts.
    await expect(NFT.ownerOf(0)).to.be.revertedWithCustomError(
      NFT,
      'ERC721NonexistentToken',
    );
  });

  // --------------------------------------------------------------------------
  // Test 5 — convertToNFT V8 → V10 migration
  // --------------------------------------------------------------------------
  //
  // End-to-end V8-to-V10 migration smoke: set up a V8 address-keyed
  // delegator position directly (faster + decoupled from V8 `stake()`
  // correctness — `test/unit/Staking.test.ts` owns that), then call
  // `NFT.convertToNFT(identityId, 12)` and verify:
  //   - V8 bucket drained and removed from DelegatorsInfo set
  //   - V10 position created under bytes32(tokenId) key
  //   - Total/node stake invariant (V8 out = V10 in)
  //   - NFT owned by the migrator
  it('convertToNFT: V8 stake migrates into V10 NFT position, totals invariant', async () => {
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

    const totalStakeBefore = await StakingStorageContract.getTotalStake();
    const nodeStakeBefore =
      await StakingStorageContract.getNodeStake(identityId);

    await expect(NFT.connect(accounts[0]).convertToNFT(identityId, 12))
      .to.emit(NFT, 'ConvertedFromV8')
      .withArgs(accounts[0].address, 0n, identityId, 12)
      .and.to.emit(StakingV10Contract, 'ConvertedFromV8')
      .withArgs(accounts[0].address, 0n, identityId, amount, 12);

    // V8 bucket drained.
    expect(
      await StakingStorageContract.getDelegatorStakeBase(identityId, v8Key),
    ).to.equal(0n);
    expect(
      await DelegatorsInfoContract.isNodeDelegator(
        identityId,
        accounts[0].address,
      ),
    ).to.equal(false);

    // V10 position created under bytes32(tokenId=0).
    expect(
      await StakingStorageContract.getDelegatorStakeBase(
        identityId,
        tokenIdKey(0),
      ),
    ).to.equal(amount);
    const pos = await ConvictionStakingStorageContract.getPosition(0);
    expect(pos.raw).to.equal(amount);
    expect(pos.lockEpochs).to.equal(12);
    expect(pos.multiplier18).to.equal(SIX_X);

    // Total + node invariants.
    expect(await StakingStorageContract.getTotalStake()).to.equal(
      totalStakeBefore,
    );
    expect(await StakingStorageContract.getNodeStake(identityId)).to.equal(
      nodeStakeBefore,
    );

    // NFT owned by migrator.
    expect(await NFT.ownerOf(0)).to.equal(accounts[0].address);
  });
});
