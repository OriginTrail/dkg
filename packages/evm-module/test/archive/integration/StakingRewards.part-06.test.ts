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



  it('D1, D2, D3, D4 claim epoch 4 rewards - Proportional rewards continue', async () => {
    const { Staking, DelegatorsInfo, delegators, nodes } = env;

    console.log(
      '\n✅ PROPORTIONAL TEST 3: Epoch 4 rewards - Proportional rewards continue',
    );

    // Get rolling rewards before epoch 4 claims
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

    // Claim epoch 4 rewards for all delegators
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId,
      4n,
      delegators[0].address,
    );
    await Staking.connect(delegators[1]).claimDelegatorRewards(
      nodes[0].identityId,
      4n,
      delegators[1].address,
    );
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId,
      4n,
      delegators[2].address,
    );
    await Staking.connect(delegators[3]).claimDelegatorRewards(
      nodes[1].identityId,
      4n,
      delegators[3].address,
    );

    console.log('    ✅ All delegators successfully claimed epoch 4 rewards');

    // Get rolling rewards after epoch 4 claims
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

    // Calculate epoch 4 rewards
    const d1Epoch4Reward = d1RollingAfter - d1RollingBefore;
    const d2Epoch4Reward = d2RollingAfter - d2RollingBefore;
    const d3Epoch4Reward = d3RollingAfter - d3RollingBefore;
    const d4Epoch4Reward = d4RollingAfter - d4RollingBefore;

    console.log(
      `    💰 D1 epoch 4 reward: ${hre.ethers.formatUnits(d1Epoch4Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D2 epoch 4 reward: ${hre.ethers.formatUnits(d2Epoch4Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D3 epoch 4 reward: ${hre.ethers.formatUnits(d3Epoch4Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D4 epoch 4 reward: ${hre.ethers.formatUnits(d4Epoch4Reward, 18)} TRAC`,
    );

    // Verify proportional rewards continue (allow small rounding differences)
    const d2ToD1Epoch4Ratio = Number(d2Epoch4Reward) / Number(d1Epoch4Reward);
    const d4ToD3Epoch4Ratio = Number(d4Epoch4Reward) / Number(d3Epoch4Reward);

    expect(d2ToD1Epoch4Ratio).to.be.closeTo(
      2.0,
      0.001,
      'D2 should get approximately double D1 epoch 4 rewards',
    );
    expect(d4ToD3Epoch4Ratio).to.be.closeTo(
      2.0,
      0.001,
      'D4 should get approximately double D3 epoch 4 rewards',
    );
    expect(d1Epoch4Reward).to.equal(
      d3Epoch4Reward,
      'D1 and D3 should get equal epoch 4 rewards',
    );
    expect(d2Epoch4Reward).to.equal(
      d4Epoch4Reward,
      'D2 and D4 should get equal epoch 4 rewards',
    );

    // Verify total rolling rewards maintain proportionality (allow small rounding differences)
    const d2ToD1TotalRatio4 = Number(d2RollingAfter) / Number(d1RollingAfter);
    const d4ToD3TotalRatio4 = Number(d4RollingAfter) / Number(d3RollingAfter);

    expect(d2ToD1TotalRatio4).to.be.closeTo(
      2.0,
      0.001,
      'D2 total rolling should be approximately double D1 total rolling',
    );
    expect(d4ToD3TotalRatio4).to.be.closeTo(
      2.0,
      0.001,
      'D4 total rolling should be approximately double D3 total rolling',
    );

    console.log('    ✅ PROPORTIONAL REWARDS VERIFIED FOR EPOCH 4');
    console.log(
      '    📝 Note: Proportional rewards consistently maintained across epochs 2, 3, and 4',
    );
  });

  it('D1, D2, D3, D4 claim epoch 5 rewards - Should get 0 rewards (no proofs) but maintain proportionality', async () => {
    const { Staking, DelegatorsInfo, delegators, nodes } = env;

    console.log(
      '\n✅ PROPORTIONAL TEST 4: Epoch 5 rewards - 0 rewards but proportionality maintained',
    );

    // Get rolling rewards before epoch 5 claims
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

    // Verify proportional rolling rewards before epoch 5 (allow small rounding differences)
    const d2ToD1BeforeRatio = Number(d2RollingBefore) / Number(d1RollingBefore);
    const d4ToD3BeforeRatio = Number(d4RollingBefore) / Number(d3RollingBefore);

    expect(d2ToD1BeforeRatio).to.be.closeTo(
      2.0,
      0.001,
      'D2 should have approximately double D1 rolling rewards before epoch 5',
    );
    expect(d4ToD3BeforeRatio).to.be.closeTo(
      2.0,
      0.001,
      'D4 should have approximately double D3 rolling rewards before epoch 5',
    );

    // Claim epoch 5 rewards for all delegators (should be 0)
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId,
      5n,
      delegators[0].address,
    );
    await Staking.connect(delegators[1]).claimDelegatorRewards(
      nodes[0].identityId,
      5n,
      delegators[1].address,
    );
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId,
      5n,
      delegators[2].address,
    );
    await Staking.connect(delegators[3]).claimDelegatorRewards(
      nodes[1].identityId,
      5n,
      delegators[3].address,
    );

    console.log(
      '    ✅ All delegators successfully claimed epoch 5 rewards (0 TRAC each)',
    );

    // Get rolling rewards after epoch 5 claims
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

    // Verify no change in rolling rewards (no rewards from epoch 5)
    expect(d1RollingAfter).to.equal(
      d1RollingBefore,
      'D1 rolling rewards should not change',
    );
    expect(d2RollingAfter).to.equal(
      d2RollingBefore,
      'D2 rolling rewards should not change',
    );
    expect(d3RollingAfter).to.equal(
      d3RollingBefore,
      'D3 rolling rewards should not change',
    );
    expect(d4RollingAfter).to.equal(
      d4RollingBefore,
      'D4 rolling rewards should not change',
    );

    // Verify proportionality is still maintained (allow small rounding differences)
    const d2ToD1AfterRatio = Number(d2RollingAfter) / Number(d1RollingAfter);
    const d4ToD3AfterRatio = Number(d4RollingAfter) / Number(d3RollingAfter);

    expect(d2ToD1AfterRatio).to.be.closeTo(
      2.0,
      0.001,
      'D2 should still have approximately double D1 rolling rewards',
    );
    expect(d4ToD3AfterRatio).to.be.closeTo(
      2.0,
      0.001,
      'D4 should still have approximately double D3 rolling rewards',
    );

    console.log(
      `    💰 All delegators got 0 TRAC from epoch 5 (no proofs submitted)`,
    );
    console.log(
      `    🔄 D1 total rolling: ${hre.ethers.formatUnits(d1RollingAfter, 18)} TRAC`,
    );
    console.log(
      `    🔄 D2 total rolling: ${hre.ethers.formatUnits(d2RollingAfter, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 total rolling: ${hre.ethers.formatUnits(d3RollingAfter, 18)} TRAC`,
    );
    console.log(
      `    🔄 D4 total rolling: ${hre.ethers.formatUnits(d4RollingAfter, 18)} TRAC`,
    );
    console.log('    ✅ PROPORTIONALITY MAINTAINED: D2/D1 = D4/D3 = 2.0');
    console.log(
      "    📝 Note: Zero rewards don't break proportional relationships",
    );
  });

});
