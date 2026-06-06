import {
  time,
  expect,
  hre,
  toTRAC,
  quads,
  ensureNodeHasChunksThisEpoch,
  advanceToNextProofingPeriod,
  submitProofAndLogScore,
  createKnowledgeCollection,
  createProfile,
  buildInitialRewardsState,
  type SignerWithAddress,
  type Token,
  type Profile,
  type ProfileStorage,
  type Staking,
  type Chronos,
  type RandomSamplingStorage,
  type EpochStorage,
  type KnowledgeCollection,
  type Hub,
  type StakingStorage,
  type RandomSampling,
  type Ask,
  type AskStorage,
  type ParametersStorage,
  type DelegatorsInfo,
  type ShardingTable,
} from './StakingRewards.shared';

describe.skip('Proportional rewards tests - Double stake = Double rewards (OBSOLETE: V8 rewards pipeline)', () => {
  /* fixture state visible to all tests in this describe-block */
  let env: Awaited<ReturnType<typeof buildInitialRewardsState>>;

  before(async () => {
    env = await buildInitialRewardsState();
  });



  it('D1, D2, D3, D4 claim epoch 6 rewards - Final claim transfers rolling rewards to stakeBase proportionally', async () => {
    const { Staking, StakingStorage, DelegatorsInfo, delegators, nodes } = env;

    console.log(
      '\n✅ PROPORTIONAL TEST 5: Epoch 6 final claim - Proportional transfer to stakeBase',
    );

    // Get states before epoch 6 claims
    const d1Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [delegators[0].address]),
    );
    const d2Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [delegators[1].address]),
    );
    const d3Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [delegators[2].address]),
    );
    const d4Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [delegators[3].address]),
    );

    const d1StakeBaseBefore = await StakingStorage.getDelegatorStakeBase(
      nodes[0].identityId,
      d1Key,
    );
    const d2StakeBaseBefore = await StakingStorage.getDelegatorStakeBase(
      nodes[0].identityId,
      d2Key,
    );
    const d3StakeBaseBefore = await StakingStorage.getDelegatorStakeBase(
      nodes[1].identityId,
      d3Key,
    );
    const d4StakeBaseBefore = await StakingStorage.getDelegatorStakeBase(
      nodes[1].identityId,
      d4Key,
    );

    const d1RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[0].address,
    );
    const d2RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[1].address,
    );
    const d3RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[2].address,
    );
    const d4RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[3].address,
    );

    console.log(
      `    💎 D1 stakeBase before: ${hre.ethers.formatUnits(d1StakeBaseBefore, 18)} TRAC`,
    );
    console.log(
      `    💎 D2 stakeBase before: ${hre.ethers.formatUnits(d2StakeBaseBefore, 18)} TRAC`,
    );
    console.log(
      `    💎 D3 stakeBase before: ${hre.ethers.formatUnits(d3StakeBaseBefore, 18)} TRAC`,
    );
    console.log(
      `    💎 D4 stakeBase before: ${hre.ethers.formatUnits(d4StakeBaseBefore, 18)} TRAC`,
    );
    console.log(
      `    🔄 D1 rolling before: ${hre.ethers.formatUnits(d1RollingBefore, 18)} TRAC`,
    );
    console.log(
      `    🔄 D2 rolling before: ${hre.ethers.formatUnits(d2RollingBefore, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 rolling before: ${hre.ethers.formatUnits(d3RollingBefore, 18)} TRAC`,
    );
    console.log(
      `    🔄 D4 rolling before: ${hre.ethers.formatUnits(d4RollingBefore, 18)} TRAC`,
    );

    // Verify proportional rolling rewards before final claim (allow small rounding differences)
    const d2ToD1BeforeFinalRatio =
      Number(d2RollingBefore) / Number(d1RollingBefore);
    const d4ToD3BeforeFinalRatio =
      Number(d4RollingBefore) / Number(d3RollingBefore);

    expect(d2ToD1BeforeFinalRatio).to.be.closeTo(
      2.0,
      0.001,
      'D2 should have approximately double D1 rolling rewards',
    );
    expect(d4ToD3BeforeFinalRatio).to.be.closeTo(
      2.0,
      0.001,
      'D4 should have approximately double D3 rolling rewards',
    );

    // Claim epoch 6 rewards for all delegators (final claim - should transfer to stakeBase)
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId,
      6n,
      delegators[0].address,
    );
    await Staking.connect(delegators[1]).claimDelegatorRewards(
      nodes[0].identityId,
      6n,
      delegators[1].address,
    );
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId,
      6n,
      delegators[2].address,
    );
    await Staking.connect(delegators[3]).claimDelegatorRewards(
      nodes[1].identityId,
      6n,
      delegators[3].address,
    );

    console.log(
      '    ✅ All delegators successfully claimed epoch 6 rewards (final claim)',
    );

    // Get states after epoch 6 claims
    const d1StakeBaseAfter = await StakingStorage.getDelegatorStakeBase(
      nodes[0].identityId,
      d1Key,
    );
    const d2StakeBaseAfter = await StakingStorage.getDelegatorStakeBase(
      nodes[0].identityId,
      d2Key,
    );
    const d3StakeBaseAfter = await StakingStorage.getDelegatorStakeBase(
      nodes[1].identityId,
      d3Key,
    );
    const d4StakeBaseAfter = await StakingStorage.getDelegatorStakeBase(
      nodes[1].identityId,
      d4Key,
    );

    const d1RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[0].address,
    );
    const d2RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[1].address,
    );
    const d3RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[2].address,
    );
    const d4RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[3].address,
    );

    console.log(
      `    💎 D1 stakeBase after: ${hre.ethers.formatUnits(d1StakeBaseAfter, 18)} TRAC`,
    );
    console.log(
      `    💎 D2 stakeBase after: ${hre.ethers.formatUnits(d2StakeBaseAfter, 18)} TRAC`,
    );
    console.log(
      `    💎 D3 stakeBase after: ${hre.ethers.formatUnits(d3StakeBaseAfter, 18)} TRAC`,
    );
    console.log(
      `    💎 D4 stakeBase after: ${hre.ethers.formatUnits(d4StakeBaseAfter, 18)} TRAC`,
    );

    // Verify rolling rewards were transferred to stakeBase
    expect(d1RollingAfter).to.equal(
      0n,
      'D1 rolling rewards should be 0 after final claim',
    );
    expect(d2RollingAfter).to.equal(
      0n,
      'D2 rolling rewards should be 0 after final claim',
    );
    expect(d3RollingAfter).to.equal(
      0n,
      'D3 rolling rewards should be 0 after final claim',
    );
    expect(d4RollingAfter).to.equal(
      0n,
      'D4 rolling rewards should be 0 after final claim',
    );

    // Calculate total rewards transferred
    const d1TotalRewards = d1StakeBaseAfter - d1StakeBaseBefore;
    const d2TotalRewards = d2StakeBaseAfter - d2StakeBaseBefore;
    const d3TotalRewards = d3StakeBaseAfter - d3StakeBaseBefore;
    const d4TotalRewards = d4StakeBaseAfter - d4StakeBaseBefore;

    console.log(
      `    🎁 D1 total rewards transferred: ${hre.ethers.formatUnits(d1TotalRewards, 18)} TRAC`,
    );
    console.log(
      `    🎁 D2 total rewards transferred: ${hre.ethers.formatUnits(d2TotalRewards, 18)} TRAC`,
    );
    console.log(
      `    🎁 D3 total rewards transferred: ${hre.ethers.formatUnits(d3TotalRewards, 18)} TRAC`,
    );
    console.log(
      `    🎁 D4 total rewards transferred: ${hre.ethers.formatUnits(d4TotalRewards, 18)} TRAC`,
    );

    // Verify proportional final rewards (allow small rounding differences)
    const d2ToD1FinalRewardsRatio =
      Number(d2TotalRewards) / Number(d1TotalRewards);
    const d4ToD3FinalRewardsRatio =
      Number(d4TotalRewards) / Number(d3TotalRewards);

    expect(d2ToD1FinalRewardsRatio).to.be.closeTo(
      2.0,
      0.001,
      'D2 should get approximately double D1 total rewards',
    );
    expect(d4ToD3FinalRewardsRatio).to.be.closeTo(
      2.0,
      0.001,
      'D4 should get approximately double D3 total rewards',
    );
    expect(d1TotalRewards).to.equal(
      d3TotalRewards,
      'D1 and D3 should get equal total rewards',
    );
    expect(d2TotalRewards).to.equal(
      d4TotalRewards,
      'D2 and D4 should get equal total rewards',
    );

    // Verify final stakeBase proportions
    const d1FinalStake = d1StakeBaseAfter;
    const d2FinalStake = d2StakeBaseAfter;
    const d3FinalStake = d3StakeBaseAfter;
    const d4FinalStake = d4StakeBaseAfter;

    // Since D2 started with 2x D1 stake and got 2x rewards, final ratio should be maintained
    // But exact 2x ratio might not hold due to rounding, so we check approximate ratios
    const d2ToD1Ratio = Number(d2FinalStake) / Number(d1FinalStake);
    const d4ToD3Ratio = Number(d4FinalStake) / Number(d3FinalStake);

    console.log(
      `    📊 Final D2/D1 stakeBase ratio: ${d2ToD1Ratio.toFixed(6)}`,
    );
    console.log(
      `    📊 Final D4/D3 stakeBase ratio: ${d4ToD3Ratio.toFixed(6)}`,
    );

    // Ratios should be close to 2.0 but might have small deviations due to rounding
    expect(d2ToD1Ratio).to.be.closeTo(
      2.0,
      0.01,
      'D2/D1 final stakeBase ratio should be close to 2.0',
    );
    expect(d4ToD3Ratio).to.be.closeTo(
      2.0,
      0.01,
      'D4/D3 final stakeBase ratio should be close to 2.0',
    );

    console.log('    ✅ PROPORTIONAL REWARDS SYSTEM VERIFIED:');
    console.log(
      '    📈 Double stake consistently resulted in double rewards across all epochs',
    );
    console.log('    💰 Final stakeBase maintains proportional relationships');
    console.log('    🎯 Reward system is fair and predictable');
    console.log(
      '    📝 Note: Proportional rewards successfully transferred to permanent stakeBase',
    );
  });

});
