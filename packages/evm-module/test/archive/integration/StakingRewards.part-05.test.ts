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



  it('D1, D2, D3, D4 claim epoch 2 rewards - D2 and D4 should get double rewards (double stakes)', async () => {
    const {
      Staking,
      DelegatorsInfo,
      RandomSamplingStorage,
      delegators,
      nodes,
    } = env;

    console.log(
      '\n✅ PROPORTIONAL TEST 1: Epoch 2 rewards - Double stake = Double rewards',
    );

    // Verify stakes first
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

    const d1Stake = await env.StakingStorage.getDelegatorStakeBase(
      nodes[0].identityId,
      d1Key,
    );
    const d2Stake = await env.StakingStorage.getDelegatorStakeBase(
      nodes[0].identityId,
      d2Key,
    );
    const d3Stake = await env.StakingStorage.getDelegatorStakeBase(
      nodes[1].identityId,
      d3Key,
    );
    const d4Stake = await env.StakingStorage.getDelegatorStakeBase(
      nodes[1].identityId,
      d4Key,
    );

    console.log(
      `    💰 D1 stake: ${hre.ethers.formatUnits(d1Stake, 18)} TRAC (Node-1)`,
    );
    console.log(
      `    💰 D2 stake: ${hre.ethers.formatUnits(d2Stake, 18)} TRAC (Node-1)`,
    );
    console.log(
      `    💰 D3 stake: ${hre.ethers.formatUnits(d3Stake, 18)} TRAC (Node-2)`,
    );
    console.log(
      `    💰 D4 stake: ${hre.ethers.formatUnits(d4Stake, 18)} TRAC (Node-2)`,
    );

    // Verify stake ratios
    expect(d2Stake).to.equal(d1Stake * 2n, 'D2 should have double D1 stake');
    expect(d4Stake).to.equal(d3Stake * 2n, 'D4 should have double D3 stake');
    expect(d1Stake).to.equal(d3Stake, 'D1 and D3 should have equal stakes');
    expect(d2Stake).to.equal(d4Stake, 'D2 and D4 should have equal stakes');

    // Verify nodes have equal scores
    const node1Score = await RandomSamplingStorage.getNodeEpochScore(
      2n,
      nodes[0].identityId,
    );
    const node2Score = await RandomSamplingStorage.getNodeEpochScore(
      2n,
      nodes[1].identityId,
    );
    expect(node1Score).to.equal(node2Score, 'Nodes should have equal scores');
    console.log(`    📊 Both nodes have equal score: ${node1Score}`);

    // Get rolling rewards before claiming
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

    // All should start with 0 rolling rewards
    expect(d1RollingBefore).to.equal(
      0n,
      'D1 should start with 0 rolling rewards',
    );
    expect(d2RollingBefore).to.equal(
      0n,
      'D2 should start with 0 rolling rewards',
    );
    expect(d3RollingBefore).to.equal(
      0n,
      'D3 should start with 0 rolling rewards',
    );
    expect(d4RollingBefore).to.equal(
      0n,
      'D4 should start with 0 rolling rewards',
    );

    // Claim epoch 2 rewards for all delegators
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId,
      2n,
      delegators[0].address,
    );
    await Staking.connect(delegators[1]).claimDelegatorRewards(
      nodes[0].identityId,
      2n,
      delegators[1].address,
    );
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId,
      2n,
      delegators[2].address,
    );
    await Staking.connect(delegators[3]).claimDelegatorRewards(
      nodes[1].identityId,
      2n,
      delegators[3].address,
    );

    console.log('    ✅ All delegators successfully claimed epoch 2 rewards');

    // Get rolling rewards after claiming
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

    // Calculate epoch 2 rewards
    const d1Reward = d1RollingAfter - d1RollingBefore;
    const d2Reward = d2RollingAfter - d2RollingBefore;
    const d3Reward = d3RollingAfter - d3RollingBefore;
    const d4Reward = d4RollingAfter - d4RollingBefore;

    console.log(
      `    💰 D1 epoch 2 reward: ${hre.ethers.formatUnits(d1Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D2 epoch 2 reward: ${hre.ethers.formatUnits(d2Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D3 epoch 2 reward: ${hre.ethers.formatUnits(d3Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D4 epoch 2 reward: ${hre.ethers.formatUnits(d4Reward, 18)} TRAC`,
    );

    // Verify proportional rewards (allow small rounding differences)
    const d2ToD1Ratio = Number(d2Reward) / Number(d1Reward);
    const d4ToD3Ratio = Number(d4Reward) / Number(d3Reward);

    expect(d2ToD1Ratio).to.be.closeTo(
      2.0,
      0.001,
      'D2 should get approximately double D1 rewards',
    );
    expect(d4ToD3Ratio).to.be.closeTo(
      2.0,
      0.001,
      'D4 should get approximately double D3 rewards',
    );
    expect(d1Reward).to.equal(
      d3Reward,
      'D1 and D3 should get equal rewards (equal stakes)',
    );
    expect(d2Reward).to.equal(
      d4Reward,
      'D2 and D4 should get equal rewards (equal stakes)',
    );

    // All rewards should be positive
    expect(d1Reward).to.be.gt(0n, 'D1 should get positive rewards');
    expect(d2Reward).to.be.gt(0n, 'D2 should get positive rewards');
    expect(d3Reward).to.be.gt(0n, 'D3 should get positive rewards');
    expect(d4Reward).to.be.gt(0n, 'D4 should get positive rewards');

    console.log('    ✅ PROPORTIONAL REWARDS VERIFIED:');
    console.log(
      `    📈 D2 reward / D1 reward = ${Number(d2Reward) / Number(d1Reward)} (should be 2.0)`,
    );
    console.log(
      `    📈 D4 reward / D3 reward = ${Number(d4Reward) / Number(d3Reward)} (should be 2.0)`,
    );
    console.log(
      '    📝 Note: Double stake = Double rewards confirmed for epoch 2',
    );
  });

  it('D1, D2, D3, D4 claim epoch 3 rewards - D2 and D4 should get proportionally more rewards', async () => {
    const {
      Staking,
      DelegatorsInfo,
      RandomSamplingStorage,
      delegators,
      nodes,
    } = env;

    console.log(
      '\n✅ PROPORTIONAL TEST 2: Epoch 3 rewards - Proportional to stakes',
    );

    // Get rolling rewards before epoch 3 claims
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
      `    🔄 D1 rolling before epoch 3: ${hre.ethers.formatUnits(d1RollingBefore, 18)} TRAC`,
    );
    console.log(
      `    🔄 D2 rolling before epoch 3: ${hre.ethers.formatUnits(d2RollingBefore, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 rolling before epoch 3: ${hre.ethers.formatUnits(d3RollingBefore, 18)} TRAC`,
    );
    console.log(
      `    🔄 D4 rolling before epoch 3: ${hre.ethers.formatUnits(d4RollingBefore, 18)} TRAC`,
    );

    // Verify epoch 3 node scores
    const node1Score3 = await RandomSamplingStorage.getNodeEpochScore(
      3n,
      nodes[0].identityId,
    );
    const node2Score3 = await RandomSamplingStorage.getNodeEpochScore(
      3n,
      nodes[1].identityId,
    );
    console.log(`    📊 Node-1 epoch 3 score: ${node1Score3}`);
    console.log(`    📊 Node-2 epoch 3 score: ${node2Score3}`);

    // Claim epoch 3 rewards for all delegators
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId,
      3n,
      delegators[0].address,
    );
    await Staking.connect(delegators[1]).claimDelegatorRewards(
      nodes[0].identityId,
      3n,
      delegators[1].address,
    );
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId,
      3n,
      delegators[2].address,
    );
    await Staking.connect(delegators[3]).claimDelegatorRewards(
      nodes[1].identityId,
      3n,
      delegators[3].address,
    );

    console.log('    ✅ All delegators successfully claimed epoch 3 rewards');

    // Get rolling rewards after epoch 3 claims
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

    // Calculate epoch 3 rewards
    const d1Epoch3Reward = d1RollingAfter - d1RollingBefore;
    const d2Epoch3Reward = d2RollingAfter - d2RollingBefore;
    const d3Epoch3Reward = d3RollingAfter - d3RollingBefore;
    const d4Epoch3Reward = d4RollingAfter - d4RollingBefore;

    console.log(
      `    💰 D1 epoch 3 reward: ${hre.ethers.formatUnits(d1Epoch3Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D2 epoch 3 reward: ${hre.ethers.formatUnits(d2Epoch3Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D3 epoch 3 reward: ${hre.ethers.formatUnits(d3Epoch3Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D4 epoch 3 reward: ${hre.ethers.formatUnits(d4Epoch3Reward, 18)} TRAC`,
    );

    // Verify proportional rewards (allow small rounding differences)
    const d2ToD1Epoch3Ratio = Number(d2Epoch3Reward) / Number(d1Epoch3Reward);
    const d4ToD3Epoch3Ratio = Number(d4Epoch3Reward) / Number(d3Epoch3Reward);

    expect(d2ToD1Epoch3Ratio).to.be.closeTo(
      2.0,
      0.001,
      'D2 should get approximately double D1 epoch 3 rewards',
    );
    expect(d4ToD3Epoch3Ratio).to.be.closeTo(
      2.0,
      0.001,
      'D4 should get approximately double D3 epoch 3 rewards',
    );
    expect(d1Epoch3Reward).to.equal(
      d3Epoch3Reward,
      'D1 and D3 should get equal epoch 3 rewards',
    );
    expect(d2Epoch3Reward).to.equal(
      d4Epoch3Reward,
      'D2 and D4 should get equal epoch 3 rewards',
    );

    // All rewards should be positive
    expect(d1Epoch3Reward).to.be.gt(
      0n,
      'D1 should get positive epoch 3 rewards',
    );
    expect(d2Epoch3Reward).to.be.gt(
      0n,
      'D2 should get positive epoch 3 rewards',
    );
    expect(d3Epoch3Reward).to.be.gt(
      0n,
      'D3 should get positive epoch 3 rewards',
    );
    expect(d4Epoch3Reward).to.be.gt(
      0n,
      'D4 should get positive epoch 3 rewards',
    );

    // Verify total rolling rewards also maintain proportionality (allow small rounding differences)
    const d2ToD1TotalRatio = Number(d2RollingAfter) / Number(d1RollingAfter);
    const d4ToD3TotalRatio = Number(d4RollingAfter) / Number(d3RollingAfter);

    expect(d2ToD1TotalRatio).to.be.closeTo(
      2.0,
      0.001,
      'D2 total rolling should be approximately double D1 total rolling',
    );
    expect(d4ToD3TotalRatio).to.be.closeTo(
      2.0,
      0.001,
      'D4 total rolling should be approximately double D3 total rolling',
    );

    console.log('    ✅ PROPORTIONAL REWARDS VERIFIED FOR EPOCH 3:');
    console.log(
      `    📈 D2 epoch 3 reward / D1 epoch 3 reward = ${Number(d2Epoch3Reward) / Number(d1Epoch3Reward)} (should be 2.0)`,
    );
    console.log(
      `    📈 D4 epoch 3 reward / D3 epoch 3 reward = ${Number(d4Epoch3Reward) / Number(d3Epoch3Reward)} (should be 2.0)`,
    );
    console.log(
      `    🔄 D2 total rolling / D1 total rolling = ${Number(d2RollingAfter) / Number(d1RollingAfter)} (should be 2.0)`,
    );
    console.log(
      '    📝 Note: Proportional rewards maintained across multiple epochs',
    );
  });

});
