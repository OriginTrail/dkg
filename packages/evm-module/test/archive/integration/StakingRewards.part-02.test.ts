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



describe.skip('Claim order enforcement tests (OBSOLETE: V8 rewards pipeline)', () => {
  /* fixture state visible to all tests in this describe-block */
  let env: Awaited<ReturnType<typeof buildInitialRewardsState>>;

  before(async () => {
    env = await buildInitialRewardsState();
  });



  it('D1, D3 attempt to claim epoch 3 rewards - should revert (must claim epoch 2 first)', async () => {
    const { Staking, delegators, nodes } = env;

    console.log(
      '\n⛔ TEST 1: D1, D3 attempting to claim epoch 3 - should revert',
    );

    // D1 attempts to claim epoch 3
    await expect(
      Staking.connect(delegators[0]).claimDelegatorRewards(
        nodes[0].identityId, // Node-1
        3n, // epoch 3
        delegators[0].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');

    console.log('    ✅ D1 claim for epoch 3 reverted as expected');

    // D3 attempts to claim epoch 3
    await expect(
      Staking.connect(delegators[2]).claimDelegatorRewards(
        nodes[1].identityId, // Node-2
        3n, // epoch 3
        delegators[2].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');

    console.log('    ✅ D3 claim for epoch 3 reverted as expected');
  });

  it('D1, D3 attempt to claim epoch 4 rewards - should revert (must claim epoch 2 first)', async () => {
    const { Staking, delegators, nodes } = env;

    console.log(
      '\n⛔ TEST 2: D1, D3 attempting to claim epoch 4 - should revert',
    );

    // D1 attempts to claim epoch 4
    await expect(
      Staking.connect(delegators[0]).claimDelegatorRewards(
        nodes[0].identityId, // Node-1
        4n, // epoch 4
        delegators[0].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');

    console.log('    ✅ D1 claim for epoch 4 reverted as expected');

    // D3 attempts to claim epoch 4
    await expect(
      Staking.connect(delegators[2]).claimDelegatorRewards(
        nodes[1].identityId, // Node-2
        4n, // epoch 4
        delegators[2].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');

    console.log('    ✅ D3 claim for epoch 4 reverted as expected');
  });

  it('D1, D3 attempt to claim epoch 5 rewards - should revert (must claim epoch 2 first)', async () => {
    const { Staking, delegators, nodes } = env;

    console.log(
      '\n⛔ TEST 3: D1, D3 attempting to claim epoch 5 - should revert',
    );

    // D1 attempts to claim epoch 5
    await expect(
      Staking.connect(delegators[0]).claimDelegatorRewards(
        nodes[0].identityId, // Node-1
        5n, // epoch 5
        delegators[0].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');

    console.log('    ✅ D1 claim for epoch 5 reverted as expected');

    // D3 attempts to claim epoch 5
    await expect(
      Staking.connect(delegators[2]).claimDelegatorRewards(
        nodes[1].identityId, // Node-2
        5n, // epoch 5
        delegators[2].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');

    console.log('    ✅ D3 claim for epoch 5 reverted as expected');
  });

  it('D5, D8, D10 attempt to claim epoch 2 rewards - should revert (were not delegators in that epoch)', async () => {
    const { Staking, delegators, nodes } = env;

    console.log(
      '\n⛔ TEST 4: D5, D8, D10 attempting to claim epoch 2 - should revert (not delegators then)',
    );

    // D5 attempts to claim epoch 2 (but was not delegator in epoch 2)
    await expect(
      Staking.connect(delegators[4]).claimDelegatorRewards(
        nodes[0].identityId, // Node-1
        2n, // epoch 2
        delegators[4].address,
      ),
    ).to.be.revertedWith('Epoch already claimed');

    console.log(
      '    ✅ D5 claim for epoch 2 reverted as expected (was not delegator)',
    );

    // D8 attempts to claim epoch 2 (but was not delegator in epoch 2)
    await expect(
      Staking.connect(delegators[7]).claimDelegatorRewards(
        nodes[1].identityId, // Node-2
        2n, // epoch 2
        delegators[7].address,
      ),
    ).to.be.revertedWith('Epoch already claimed');

    console.log(
      '    ✅ D8 claim for epoch 2 reverted as expected (was not delegator)',
    );

    // D10 attempts to claim epoch 2 (but was not delegator in epoch 2)
    await expect(
      Staking.connect(delegators[9]).claimDelegatorRewards(
        nodes[1].identityId, // Node-2
        2n, // epoch 2
        delegators[9].address,
      ),
    ).to.be.revertedWith('Epoch already claimed');

    console.log(
      '    ✅ D10 claim for epoch 2 reverted as expected (was not delegator)',
    );
  });

  it('D1, D3 successfully claim epoch 2 rewards - should succeed with equal rewards', async () => {
    const {
      Staking,
      StakingStorage,
      DelegatorsInfo,
      RandomSamplingStorage,
      delegators,
      nodes,
    } = env;

    console.log('\n✅ TEST 5: D1, D3 successfully claiming epoch 2 rewards');

    // Get initial state
    const d1Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [delegators[0].address]),
    );
    const d3Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [delegators[2].address]),
    );

    const d1StakeBaseBefore = await StakingStorage.getDelegatorStakeBase(
      nodes[0].identityId,
      d1Key,
    );
    const d3StakeBaseBefore = await StakingStorage.getDelegatorStakeBase(
      nodes[1].identityId,
      d3Key,
    );

    const d1RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[0].address,
    );
    const d3RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[2].address,
    );

    // Verify nodes have equal scores (due to identical KC setup)
    const node1Score2 = await RandomSamplingStorage.getNodeEpochScore(
      2n,
      nodes[0].identityId,
    );
    const node2Score2 = await RandomSamplingStorage.getNodeEpochScore(
      2n,
      nodes[1].identityId,
    );

    expect(node1Score2).to.equal(
      node2Score2,
      'Node-1 and Node-2 should have equal scores',
    );
    console.log(`    📊 Both nodes have equal score: ${node1Score2}`);

    // D1 claims epoch 2 rewards
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId, // Node-1
      2n, // epoch 2
      delegators[0].address,
    );

    console.log('    ✅ D1 successfully claimed epoch 2 rewards');

    // D3 claims epoch 2 rewards
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId, // Node-2
      2n, // epoch 2
      delegators[2].address,
    );

    console.log('    ✅ D3 successfully claimed epoch 2 rewards');

    // Get final state
    const d1StakeBaseAfter = await StakingStorage.getDelegatorStakeBase(
      nodes[0].identityId,
      d1Key,
    );
    const d3StakeBaseAfter = await StakingStorage.getDelegatorStakeBase(
      nodes[1].identityId,
      d3Key,
    );

    const d1RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[0].address,
    );
    const d3RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[2].address,
    );

    // Calculate rewards and stake changes
    const d1Reward = d1RollingAfter - d1RollingBefore;
    const d3Reward = d3RollingAfter - d3RollingBefore;
    const d1StakeChange = d1StakeBaseAfter - d1StakeBaseBefore;
    const d3StakeChange = d3StakeBaseAfter - d3StakeBaseBefore;

    console.log(
      `    💰 D1 rolling reward: ${hre.ethers.formatUnits(d1Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D3 rolling reward: ${hre.ethers.formatUnits(d3Reward, 18)} TRAC`,
    );

    // Verify equal rewards (since equal stakes and equal node scores)
    expect(d1Reward).to.equal(
      d3Reward,
      'D1 and D3 should receive equal rewards',
    );

    // StakeBase should not change (future epochs remain to claim)
    expect(d1StakeChange).to.equal(
      0n,
      'D1 stakeBase should not change (rolling rewards)',
    );
    expect(d3StakeChange).to.equal(
      0n,
      'D3 stakeBase should not change (rolling rewards)',
    );

    // Both should receive positive rewards
    expect(d1Reward).to.be.gt(0n, 'D1 rolling rewards should be positive');
    expect(d3Reward).to.be.gt(0n, 'D3 rolling rewards should be positive');

    console.log('    ✅ Both delegators received equal rolling rewards');
    console.log(
      '    ✅ StakeBase remained unchanged - rewards went to rolling rewards',
    );
    console.log(
      '    📝 Note: Equal stakes + equal node performance = equal rewards',
    );
  });

  it('Node scores verification - Node-1 and Node-2 should have identical scores in epoch 2', async () => {
    const { RandomSamplingStorage, nodes } = env;

    console.log('\n✅ TEST 6: Verifying equal node scores in epoch 2');

    // Get node scores for epoch 2
    const node1Score = await RandomSamplingStorage.getNodeEpochScore(
      2n,
      nodes[0].identityId,
    );
    const node2Score = await RandomSamplingStorage.getNodeEpochScore(
      2n,
      nodes[1].identityId,
    );
    const node3Score = await RandomSamplingStorage.getNodeEpochScore(
      2n,
      nodes[2].identityId,
    );
    const node4Score = await RandomSamplingStorage.getNodeEpochScore(
      2n,
      nodes[3].identityId,
    );

    // Get score per stake
    const node1ScorePerStake =
      await RandomSamplingStorage.getNodeEpochScorePerStake(
        2n,
        nodes[0].identityId,
      );
    const node2ScorePerStake =
      await RandomSamplingStorage.getNodeEpochScorePerStake(
        2n,
        nodes[1].identityId,
      );

    console.log(`    📊 Node-1 score: ${node1Score}`);
    console.log(`    📊 Node-2 score: ${node2Score}`);
    console.log(
      `    📊 Node-3 score: ${node3Score} (no stake, score = 0 under multiplicative formula)`,
    );
    console.log(
      `    📊 Node-4 score: ${node4Score} (no stake, score = 0 under multiplicative formula)`,
    );
    console.log(`    📈 Node-1 score per stake: ${node1ScorePerStake}`);
    console.log(`    📈 Node-2 score per stake: ${node2ScorePerStake}`);

    // Verify equal scores for nodes with stakes
    expect(node1Score).to.equal(
      node2Score,
      'Node-1 and Node-2 should have equal total scores',
    );
    expect(node1ScorePerStake).to.equal(
      node2ScorePerStake,
      'Node-1 and Node-2 should have equal score per stake',
    );

    // Anti-sybil multiplicative formula: nodeScore = S(t) * (c + 0.86*P(t) + 0.60*A(t)*P(t))
    // With S(t) = 0 (no stake), the entire score is 0 since stake is a multiplier.
    // Verify nodes without stake have lower (zero) scores than staked nodes.
    expect(node3Score < node1Score).to.equal(true);
    expect(node4Score < node1Score).to.equal(true);

    // Both nodes should have positive scores
    expect(node1Score).to.be.gt(0n, 'Node-1 should have positive score');
    expect(node2Score).to.be.gt(0n, 'Node-2 should have positive score');

    console.log(
      '    ✅ Node-1 and Node-2 have identical scores and score per stake',
    );
    console.log(
      '    ✅ Node-3 and Node-4 have zero scores (no stake under multiplicative formula)',
    );
    console.log(
      '    📝 Note: Equal KC setup resulted in equal node performance',
    );
  });

});
