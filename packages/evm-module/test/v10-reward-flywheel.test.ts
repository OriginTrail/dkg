// =============================================================================
// V10 Phase 11 — @integration full reward flywheel test
// =============================================================================
//
// Proves the complete V10 reward cycle works end-to-end:
//
//   1. One node with a V10 staker (1000 TRAC, 12-epoch lock = 6x) and
//      a V8 staker (1000 TRAC, 1x).
//   2. Epoch pool funded + scores injected (simulating publish + proof).
//   3. One epoch advance.
//   4. V10 staker claims via DKGStakingConvictionNFT.claim(tokenId).
//   5. V8 staker claims via Staking.claimDelegatorRewards(identityId, epoch, delegator).
//   6. Assert 6/7 + 1/7 conservation with rounding-dust tolerance.
//   7. Assert vault balance invariant: Token.balanceOf(StakingStorage) >= totalStake.
//
// Scores are injected directly into RandomSamplingStorage + EpochStorage
// rather than going through the publish + proof pipeline. This isolates
// the reward-claim logic from the publish pipeline, which has its own
// integration tests in StakingRewards.test.ts.

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
  ProfileStorage,
  RandomSamplingStorage,
  Staking,
  StakingStorage,
  StakingV10,
  Token,
} from '../typechain';
import { createProfile } from './helpers/profile-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCALE18 = 10n ** 18n;
const toTRAC = (n: number) => hre.ethers.parseEther(n.toString());

// V10 tier 12 = 6x multiplier
const SIX_X = 6n * SCALE18;
const LOCK_EPOCHS = 12;

// Staking amounts
const V10_RAW = toTRAC(1_000);
const V8_RAW = toTRAC(1_000);

// Effective stakes:  V10 = 1000 * 6 = 6000,  V8 = 1000
// Total effective = 7000
const V10_EFFECTIVE = (V10_RAW * SIX_X) / SCALE18; // 6000e18
const V8_EFFECTIVE = V8_RAW;                         // 1000e18
const TOTAL_EFFECTIVE = V10_EFFECTIVE + V8_EFFECTIVE; // 7000e18

// EpochStorage shard index used by both Staking.sol and StakingV10.sol
const EPOCH_POOL_INDEX = 1n;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type FlywheelFixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  ProfileStorage: ProfileStorage;
  Staking: Staking;
  StakingV10: StakingV10;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  DelegatorsInfo: DelegatorsInfo;
  RandomSamplingStorage: RandomSamplingStorage;
  EpochStorage: EpochStorage;
  ParametersStorage: ParametersStorage;
  NFT: DKGStakingConvictionNFT;
};

async function deployFlywheelFixture(): Promise<FlywheelFixture> {
  // Pull the full V10 deploy graph — DKGStakingConvictionNFT transitively
  // brings Hub, StakingV10, Staking, ConvictionStakingStorage, storages,
  // Profile, Token, EpochStorage, RandomSamplingStorage, etc.
  await hre.deployments.fixture([
    'DKGStakingConvictionNFT',
    'StakingV10',
    'Profile',
    'Staking',
    'EpochStorage',
    'RandomSamplingStorage',
    'DelegatorsInfo',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');

  // Grant HubOwner to accounts[0] so we can poke privileged setters.
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    ProfileStorage: await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
    Staking: await hre.ethers.getContract<Staking>('Staking'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingStorage: await hre.ethers.getContract<StakingStorage>('StakingStorage'),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    ),
    DelegatorsInfo: await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo'),
    RandomSamplingStorage: await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    ),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('@integration V10 Phase 11 — full reward flywheel', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let ProfileStorageContract: ProfileStorage;
  let StakingContract: Staking;
  let StakingV10Contract: StakingV10;
  let StakingStorageContract: StakingStorage;
  let ConvictionStorageContract: ConvictionStakingStorage;
  let RandomSamplingStorageContract: RandomSamplingStorage;
  let EpochStorageContract: EpochStorage;
  let ParametersStorageContract: ParametersStorage;
  let NFT: DKGStakingConvictionNFT;

  beforeEach(async function () {
    hre.helpers.resetDeploymentsJson();
    const fx = await loadFixture(deployFlywheelFixture);
    ({
      accounts,
      Token,
      Chronos,
      ParametersStorage: ParametersStorageContract,
      RandomSamplingStorage: RandomSamplingStorageContract,
      EpochStorage: EpochStorageContract,
      NFT,
    } = fx);
    ProfileContract = fx.Profile;
    ProfileStorageContract = fx.ProfileStorage;
    StakingContract = fx.Staking;
    StakingV10Contract = fx.StakingV10;
    StakingStorageContract = fx.StakingStorage;
    ConvictionStorageContract = fx.ConvictionStakingStorage;
  });

  // -----------------------------------------------------------------------
  // The single main test
  // -----------------------------------------------------------------------

  it('V10 (6x) + V8 (1x) stakers share rewards in 6:1 ratio with conservation', async function () {
    // ------------------------------------------------------------------
    // Actors
    // ------------------------------------------------------------------
    const nodeOp = accounts[1];   // node operational wallet
    const nodeAdmin = accounts[2]; // node admin wallet
    const v10Staker = accounts[3];
    const v8Staker = accounts[4];

    // ------------------------------------------------------------------
    // Step 0: Set operator fee update delay to 0 so we can set it immediately
    // ------------------------------------------------------------------
    await ParametersStorageContract.connect(accounts[0]).setOperatorFeeUpdateDelay(0);

    // ------------------------------------------------------------------
    // Step 1: Create a node profile
    // ------------------------------------------------------------------
    const { identityId } = await createProfile(ProfileContract, {
      operational: nodeOp,
      admin: nodeAdmin,
    });

    // Set operator fee to 10% (1000 / 10000)
    await ProfileContract.connect(nodeAdmin).updateOperatorFee(identityId, 1000);

    // ------------------------------------------------------------------
    // Step 2: V10 staker — create conviction (12-epoch lock = 6x)
    // ------------------------------------------------------------------
    await Token.mint(v10Staker.address, V10_RAW);
    await Token.connect(v10Staker).approve(await StakingV10Contract.getAddress(), V10_RAW);
    await NFT.connect(v10Staker).createConviction(identityId, V10_RAW, LOCK_EPOCHS);
    const tokenId = 0n; // first NFT minted

    // Sanity: position exists with correct tier
    const pos = await ConvictionStorageContract.getPosition(tokenId);
    expect(pos.identityId).to.equal(identityId);
    expect(pos.raw).to.equal(V10_RAW);
    expect(pos.multiplier18).to.equal(SIX_X);

    // ------------------------------------------------------------------
    // Step 3: V8 staker — classic stake (1x)
    // ------------------------------------------------------------------
    await Token.mint(v8Staker.address, V8_RAW);
    await Token.connect(v8Staker).approve(await StakingContract.getAddress(), V8_RAW);
    await StakingContract.connect(v8Staker).stake(identityId, V8_RAW);

    // Sanity: combined raw node stake = V10_RAW + V8_RAW = 2000 TRAC
    const nodeStake = await StakingStorageContract.getNodeStake(identityId);
    expect(nodeStake).to.equal(V10_RAW + V8_RAW);

    // Record the staking epoch for later
    const stakingEpoch = await Chronos.getCurrentEpoch();

    // ------------------------------------------------------------------
    // Step 4: Simulate publish — fund epoch pool + mint backing TRAC
    // ------------------------------------------------------------------
    // We will fund `stakingEpoch` with EPOCH_POOL_AMOUNT, which is
    // the total TRAC that all nodes (just ours) share in this epoch.
    const EPOCH_POOL_AMOUNT = toTRAC(700); // 700 TRAC in the pool

    // Fund epoch pool: addTokensToEpochRange is `onlyContracts`-gated.
    // accounts[0] is HubOwner, which is trusted by the Hub access control.
    await EpochStorageContract.connect(accounts[0]).addTokensToEpochRange(
      EPOCH_POOL_INDEX,
      stakingEpoch,
      stakingEpoch,
      EPOCH_POOL_AMOUNT,
    );

    // Mint matching TRAC to StakingStorage so the vault backs the rewards.
    const ssAddr = await StakingStorageContract.getAddress();
    await Token.mint(ssAddr, EPOCH_POOL_AMOUNT);

    // ------------------------------------------------------------------
    // Step 5: Simulate proof — inject scores into RandomSamplingStorage
    // ------------------------------------------------------------------
    // nodeScore = some arbitrary value — the ratio matters, not magnitude.
    // We pick nodeScore = 1000e18 for clarity.
    const nodeScore = toTRAC(1000);

    // allNodesScore = nodeScore (single node in the network)
    await RandomSamplingStorageContract.connect(accounts[0]).setAllNodesEpochScore(
      stakingEpoch,
      nodeScore,
    );
    await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScore(
      stakingEpoch,
      identityId,
      nodeScore,
    );

    // scorePerStake36 = nodeScore * 1e18 / effectiveNodeStake
    // effectiveNodeStake = 6000 + 1000 = 7000 TRAC
    // scorePerStake36 = 1000e18 * 1e18 / 7000e18 = 1e18 / 7
    const scorePerStake36 = (nodeScore * SCALE18) / TOTAL_EFFECTIVE;
    await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScorePerStake(
      stakingEpoch,
      identityId,
      scorePerStake36,
    );

    // ------------------------------------------------------------------
    // Step 6: Advance one epoch so stakingEpoch is finalised
    // ------------------------------------------------------------------
    const timeUntilNext = await Chronos.timeUntilNextEpoch();
    await time.increase(timeUntilNext + 1n);

    const currentEpoch = await Chronos.getCurrentEpoch();
    expect(currentEpoch).to.be.gt(stakingEpoch);

    // ------------------------------------------------------------------
    // Step 7: V10 staker claims via NFT.claim(tokenId)
    // ------------------------------------------------------------------
    const v10BalBefore = await Token.balanceOf(v10Staker.address);
    await NFT.connect(v10Staker).claim(tokenId);

    // V10 claim auto-compounds into the position — rewards go into
    // pos.rewards, and the StakingStorage delegator base increases.
    // The staker's wallet balance should NOT change (rewards are staked).
    const v10BalAfter = await Token.balanceOf(v10Staker.address);
    expect(v10BalAfter).to.equal(v10BalBefore); // auto-compound, no transfer out

    const posAfterClaim = await ConvictionStorageContract.getPosition(tokenId);
    const v10Reward = posAfterClaim.rewards;

    // ------------------------------------------------------------------
    // Step 8: V8 staker claims via Staking.claimDelegatorRewards
    // ------------------------------------------------------------------
    // Track cumulative earned rewards before claim
    const v8DelegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [v8Staker.address]),
    );
    const v8CumBefore = await StakingStorageContract.getDelegatorCumulativeEarnedRewards(
      identityId,
      v8DelegatorKey,
    );

    await StakingContract.connect(v8Staker).claimDelegatorRewards(
      identityId,
      stakingEpoch,
      v8Staker.address,
    );

    const v8CumAfter = await StakingStorageContract.getDelegatorCumulativeEarnedRewards(
      identityId,
      v8DelegatorKey,
    );
    const v8Reward = v8CumAfter - v8CumBefore;

    // ------------------------------------------------------------------
    // Step 9: Compute expected values
    // ------------------------------------------------------------------
    // grossNodeRewards = epochPool * nodeScore / allNodesScore
    //                  = 700 * 1 = 700 TRAC (single node)
    const grossNodeRewards = (EPOCH_POOL_AMOUNT * nodeScore) / nodeScore;
    expect(grossNodeRewards).to.equal(EPOCH_POOL_AMOUNT);

    // operatorFee = grossNodeRewards * 1000 / 10000 = 10%
    const maxOperatorFee = await ParametersStorageContract.maxOperatorFee();
    const operatorFeePercentage = await ProfileStorageContract.getLatestOperatorFeePercentage(
      identityId,
    );
    const operatorFeeAmount = (grossNodeRewards * BigInt(operatorFeePercentage)) / BigInt(maxOperatorFee);
    const netNodeRewards = grossNodeRewards - operatorFeeAmount;

    // V10 expected: effStake * scorePerStake36 / 1e18 gives delegator's
    // score; then (delegatorScore * netNodeRewards) / nodeScore.
    //
    // V10 delegator score = V10_EFFECTIVE * scorePerStake36 / 1e18
    //                     = 6000 * (1e18/7) / 1e18 = 6000/7
    //
    // V10 reward = (6000/7) * netNodeRewards / 1000 = 6/7 * netNodeRewards
    //
    // But due to integer division, we check with tolerance.
    const expectedV10Reward = (netNodeRewards * V10_EFFECTIVE) / TOTAL_EFFECTIVE;
    const expectedV8Reward = (netNodeRewards * V8_EFFECTIVE) / TOTAL_EFFECTIVE;

    // ------------------------------------------------------------------
    // Assertion A: 6/7 + 1/7 conservation (rounding dust only)
    // ------------------------------------------------------------------
    // The total claimed rewards must not exceed netNodeRewards.
    const totalClaimed = v10Reward + v8Reward;
    expect(totalClaimed).to.be.lte(netNodeRewards);

    // Rounding dust tolerance: scorePerStake36 = nodeScore * 1e18 / 7000e18
    // truncates, then each claim path does
    //   (effStake * scorePerStake36) / 1e18          — truncation 1
    //   (delegatorScore * netNodeRewards) / nodeScore — truncation 2
    // Two cascading integer divisions per staker. The total dust across
    // both stakers is bounded by ~5000 wei for these magnitudes (observed
    // 630 wei at 700 TRAC pool, but scales with divisor precision).
    const dust = netNodeRewards - totalClaimed;
    expect(dust).to.be.lte(10_000n);

    // Each individual reward should be close to the expected value.
    expect(v10Reward).to.be.closeTo(expectedV10Reward, 10_000);
    expect(v8Reward).to.be.closeTo(expectedV8Reward, 10_000);

    // Sanity: V10 reward should be ~6x V8 reward
    // (6000/7000) / (1000/7000) = 6
    // Allow a wider tolerance (1 TRAC) for the ratio check due to rounding
    if (v8Reward > 0n) {
      // v10Reward / v8Reward should be approximately 6
      // Instead of division, check: v10Reward * 1 ~= v8Reward * 6
      expect(v10Reward).to.be.closeTo(v8Reward * 6n, toTRAC(1));
    }

    // ------------------------------------------------------------------
    // Assertion B: vault balance invariant
    // ------------------------------------------------------------------
    // Token.balanceOf(StakingStorage) >= totalStake after all claims.
    // totalStake grew by the auto-compounded rewards (both V10 and V8
    // restake via delegator base increase).
    const totalStake = await StakingStorageContract.getTotalStake();
    const vaultBalance = await Token.balanceOf(ssAddr);
    expect(vaultBalance).to.be.gte(totalStake);

    // ------------------------------------------------------------------
    // Assertion C: operator fee was banked
    // ------------------------------------------------------------------
    const operatorFeeBalance = await StakingStorageContract.getOperatorFeeBalance(identityId);
    expect(operatorFeeBalance).to.equal(operatorFeeAmount);

    // ------------------------------------------------------------------
    // Log summary (informational)
    // ------------------------------------------------------------------
    console.log('\n  Reward Flywheel Summary:');
    console.log(`    Epoch pool:          ${hre.ethers.formatEther(EPOCH_POOL_AMOUNT)} TRAC`);
    console.log(`    Operator fee (10%):  ${hre.ethers.formatEther(operatorFeeAmount)} TRAC`);
    console.log(`    Net node rewards:    ${hre.ethers.formatEther(netNodeRewards)} TRAC`);
    console.log(`    V10 reward (6/7):    ${hre.ethers.formatEther(v10Reward)} TRAC`);
    console.log(`    V8 reward (1/7):     ${hre.ethers.formatEther(v8Reward)} TRAC`);
    console.log(`    Total claimed:       ${hre.ethers.formatEther(totalClaimed)} TRAC`);
    console.log(`    Rounding dust:       ${dust.toString()} wei`);
    console.log(`    Vault balance:       ${hre.ethers.formatEther(vaultBalance)} TRAC`);
    console.log(`    Total stake:         ${hre.ethers.formatEther(totalStake)} TRAC`);
  });

  // -----------------------------------------------------------------------
  // Edge case: zero operator fee
  // -----------------------------------------------------------------------

  it('V10 + V8 conservation holds with 0% operator fee', async function () {
    const nodeOp = accounts[1];
    const nodeAdmin = accounts[2];
    const v10Staker = accounts[3];
    const v8Staker = accounts[4];

    // No operator fee set — default is 0%
    const { identityId } = await createProfile(ProfileContract, {
      operational: nodeOp,
      admin: nodeAdmin,
    });

    // V10 stake
    await Token.mint(v10Staker.address, V10_RAW);
    await Token.connect(v10Staker).approve(await StakingV10Contract.getAddress(), V10_RAW);
    await NFT.connect(v10Staker).createConviction(identityId, V10_RAW, LOCK_EPOCHS);
    const tokenId = 0n;

    // V8 stake
    await Token.mint(v8Staker.address, V8_RAW);
    await Token.connect(v8Staker).approve(await StakingContract.getAddress(), V8_RAW);
    await StakingContract.connect(v8Staker).stake(identityId, V8_RAW);

    const stakingEpoch = await Chronos.getCurrentEpoch();

    // Fund epoch pool + backing TRAC
    const POOL = toTRAC(350);
    await EpochStorageContract.connect(accounts[0]).addTokensToEpochRange(
      EPOCH_POOL_INDEX,
      stakingEpoch,
      stakingEpoch,
      POOL,
    );
    const ssAddr = await StakingStorageContract.getAddress();
    await Token.mint(ssAddr, POOL);

    // Inject scores
    const nodeScore = toTRAC(500);
    await RandomSamplingStorageContract.connect(accounts[0]).setAllNodesEpochScore(
      stakingEpoch,
      nodeScore,
    );
    await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScore(
      stakingEpoch,
      identityId,
      nodeScore,
    );
    const scorePerStake36 = (nodeScore * SCALE18) / TOTAL_EFFECTIVE;
    await RandomSamplingStorageContract.connect(accounts[0]).setNodeEpochScorePerStake(
      stakingEpoch,
      identityId,
      scorePerStake36,
    );

    // Advance epoch
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Claims
    await NFT.connect(v10Staker).claim(tokenId);
    const posAfter = await ConvictionStorageContract.getPosition(tokenId);
    const v10Reward = posAfter.rewards;

    const v8Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [v8Staker.address]),
    );
    const v8CumBefore = await StakingStorageContract.getDelegatorCumulativeEarnedRewards(
      identityId,
      v8Key,
    );
    await StakingContract.connect(v8Staker).claimDelegatorRewards(
      identityId,
      stakingEpoch,
      v8Staker.address,
    );
    const v8CumAfter = await StakingStorageContract.getDelegatorCumulativeEarnedRewards(
      identityId,
      v8Key,
    );
    const v8Reward = v8CumAfter - v8CumBefore;

    // 0% operator fee → netNodeRewards = grossNodeRewards = POOL
    const totalClaimed = v10Reward + v8Reward;
    expect(totalClaimed).to.be.lte(POOL);
    expect(POOL - totalClaimed).to.be.lte(10_000n); // rounding dust from scorePerStake36 truncation

    // Vault invariant
    const totalStake = await StakingStorageContract.getTotalStake();
    const vaultBalance = await Token.balanceOf(ssAddr);
    expect(vaultBalance).to.be.gte(totalStake);

    // Operator fee balance should be 0
    const opFee = await StakingStorageContract.getOperatorFeeBalance(identityId);
    expect(opFee).to.equal(0n);
  });
});
