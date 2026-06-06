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



  it('D1, D3 claim epoch 3 rewards - rolling rewards should accumulate', async () => {
    const {
      Staking,
      DelegatorsInfo,
      RandomSamplingStorage,
      delegators,
      nodes,
    } = env;

    console.log(
      '\n✅ TEST 7: D1, D3 claiming epoch 3 rewards - rolling accumulation',
    );

    // Get rolling rewards after epoch 2 claims (from previous test)
    const d1RollingAfterEpoch2 =
      await DelegatorsInfo.getDelegatorRollingRewards(
        nodes[0].identityId,
        delegators[0].address,
      );
    const d3RollingAfterEpoch2 =
      await DelegatorsInfo.getDelegatorRollingRewards(
        nodes[1].identityId,
        delegators[2].address,
      );

    console.log(
      `    🔄 D1 rolling after epoch 2: ${hre.ethers.formatUnits(d1RollingAfterEpoch2, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 rolling after epoch 2: ${hre.ethers.formatUnits(d3RollingAfterEpoch2, 18)} TRAC`,
    );

    // Verify both have some rolling rewards from epoch 2
    expect(d1RollingAfterEpoch2).to.be.gt(
      0n,
      'D1 should have rolling rewards from epoch 2',
    );
    expect(d3RollingAfterEpoch2).to.be.gt(
      0n,
      'D3 should have rolling rewards from epoch 2',
    );

    // Check epoch 3 node scores (these will be different due to different stakes)
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

    // D1 claims epoch 3 rewards
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId, // Node-1
      3n, // epoch 3
      delegators[0].address,
    );

    console.log('    ✅ D1 successfully claimed epoch 3 rewards');

    // D3 claims epoch 3 rewards
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId, // Node-2
      3n, // epoch 3
      delegators[2].address,
    );

    console.log('    ✅ D3 successfully claimed epoch 3 rewards');

    // Get rolling rewards after epoch 3 claims
    const d1RollingAfterEpoch3 =
      await DelegatorsInfo.getDelegatorRollingRewards(
        nodes[0].identityId,
        delegators[0].address,
      );
    const d3RollingAfterEpoch3 =
      await DelegatorsInfo.getDelegatorRollingRewards(
        nodes[1].identityId,
        delegators[2].address,
      );

    // Calculate epoch 3 rewards
    const d1Epoch3Reward = d1RollingAfterEpoch3 - d1RollingAfterEpoch2;
    const d3Epoch3Reward = d3RollingAfterEpoch3 - d3RollingAfterEpoch2;

    console.log(
      `    💰 D1 epoch 3 reward: ${hre.ethers.formatUnits(d1Epoch3Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D3 epoch 3 reward: ${hre.ethers.formatUnits(d3Epoch3Reward, 18)} TRAC`,
    );
    console.log(
      `    🔄 D1 total rolling after epoch 3: ${hre.ethers.formatUnits(d1RollingAfterEpoch3, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 total rolling after epoch 3: ${hre.ethers.formatUnits(d3RollingAfterEpoch3, 18)} TRAC`,
    );

    // Verify rolling rewards increased (accumulated)
    expect(d1RollingAfterEpoch3).to.be.gt(
      d1RollingAfterEpoch2,
      'D1 rolling rewards should increase after epoch 3 claim',
    );
    expect(d3RollingAfterEpoch3).to.be.gt(
      d3RollingAfterEpoch2,
      'D3 rolling rewards should increase after epoch 3 claim',
    );

    // Both should receive positive epoch 3 rewards
    expect(d1Epoch3Reward).to.be.gt(
      0n,
      'D1 should receive positive epoch 3 rewards',
    );
    expect(d3Epoch3Reward).to.be.gt(
      0n,
      'D3 should receive positive epoch 3 rewards',
    );

    // Verify accumulation: total = epoch2 + epoch3
    expect(d1RollingAfterEpoch3).to.equal(
      d1RollingAfterEpoch2 + d1Epoch3Reward,
      'D1 total rolling should equal epoch 2 + epoch 3 rewards',
    );
    expect(d3RollingAfterEpoch3).to.equal(
      d3RollingAfterEpoch2 + d3Epoch3Reward,
      'D3 total rolling should equal epoch 2 + epoch 3 rewards',
    );

    console.log(
      '    ✅ Rolling rewards successfully accumulated from both epochs',
    );
    console.log('    ✅ Both delegators received positive epoch 3 rewards');
    console.log(
      '    📝 Note: Rolling rewards = Epoch 2 rewards + Epoch 3 rewards',
    );
  });

  it('D1, D3 attempt to claim epoch 5 rewards - should revert (must claim epoch 4 first)', async () => {
    const { Staking, delegators, nodes } = env;

    console.log(
      '\n⛔ TEST 8: D1, D3 attempting to claim epoch 5 - should revert (must claim epoch 4 first)',
    );

    // D1 attempts to claim epoch 5 (but hasn't claimed epoch 4 yet)
    await expect(
      Staking.connect(delegators[0]).claimDelegatorRewards(
        nodes[0].identityId, // Node-1
        5n, // epoch 5
        delegators[0].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');

    console.log(
      '    ✅ D1 claim for epoch 5 reverted as expected (must claim epoch 4 first)',
    );

    // D3 attempts to claim epoch 5 (but hasn't claimed epoch 4 yet)
    await expect(
      Staking.connect(delegators[2]).claimDelegatorRewards(
        nodes[1].identityId, // Node-2
        5n, // epoch 5
        delegators[2].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');

    console.log(
      '    ✅ D3 claim for epoch 5 reverted as expected (must claim epoch 4 first)',
    );
    console.log(
      '    📝 Note: Sequential claiming enforced - cannot skip epoch 4',
    );
  });

  it('D1, D3 claim epoch 4 rewards - should succeed with equal rewards (equal stakes + all nodes submitted proofs)', async () => {
    const {
      Staking,
      DelegatorsInfo,
      RandomSamplingStorage,
      delegators,
      nodes,
    } = env;

    console.log(
      '\n✅ TEST 9: D1, D3 claiming epoch 4 rewards - should get equal rewards',
    );

    // Get rolling rewards before epoch 4 claims (should have epoch 2 + epoch 3 rewards)
    const d1RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[0].address,
    );
    const d3RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[2].address,
    );

    console.log(
      `    🔄 D1 rolling before epoch 4: ${hre.ethers.formatUnits(d1RollingBefore, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 rolling before epoch 4: ${hre.ethers.formatUnits(d3RollingBefore, 18)} TRAC`,
    );

    // Check epoch 4 node scores (should be positive since all nodes submitted proofs)
    const node1Score4 = await RandomSamplingStorage.getNodeEpochScore(
      4n,
      nodes[0].identityId,
    );
    const node2Score4 = await RandomSamplingStorage.getNodeEpochScore(
      4n,
      nodes[1].identityId,
    );

    console.log(`    📊 Node-1 epoch 4 score: ${node1Score4}`);
    console.log(`    📊 Node-2 epoch 4 score: ${node2Score4}`);

    // Both nodes should have positive scores (all submitted proofs)
    expect(node1Score4).to.be.gt(
      0n,
      'Node-1 should have positive score in epoch 4',
    );
    expect(node2Score4).to.be.gt(
      0n,
      'Node-2 should have positive score in epoch 4',
    );

    // D1 claims epoch 4 rewards
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId, // Node-1
      4n, // epoch 4
      delegators[0].address,
    );

    console.log('    ✅ D1 successfully claimed epoch 4 rewards');

    // D3 claims epoch 4 rewards
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId, // Node-2
      4n, // epoch 4
      delegators[2].address,
    );

    console.log('    ✅ D3 successfully claimed epoch 4 rewards');

    // Get rolling rewards after epoch 4 claims
    const d1RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[0].address,
    );
    const d3RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[2].address,
    );

    // Calculate epoch 4 rewards
    const d1Epoch4Reward = d1RollingAfter - d1RollingBefore;
    const d3Epoch4Reward = d3RollingAfter - d3RollingBefore;

    console.log(
      `    💰 D1 epoch 4 reward: ${hre.ethers.formatUnits(d1Epoch4Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D3 epoch 4 reward: ${hre.ethers.formatUnits(d3Epoch4Reward, 18)} TRAC`,
    );
    console.log(
      `    🔄 D1 total rolling after epoch 4: ${hre.ethers.formatUnits(d1RollingAfter, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 total rolling after epoch 4: ${hre.ethers.formatUnits(d3RollingAfter, 18)} TRAC`,
    );

    // Verify rolling rewards increased (accumulated)
    expect(d1RollingAfter).to.be.gt(
      d1RollingBefore,
      'D1 rolling rewards should increase after epoch 4 claim',
    );
    expect(d3RollingAfter).to.be.gt(
      d3RollingBefore,
      'D3 rolling rewards should increase after epoch 4 claim',
    );

    // Both should receive positive epoch 4 rewards
    expect(d1Epoch4Reward).to.be.gt(
      0n,
      'D1 should receive positive epoch 4 rewards',
    );
    expect(d3Epoch4Reward).to.be.gt(
      0n,
      'D3 should receive positive epoch 4 rewards',
    );

    // Verify equal rewards (equal stakes in epoch 4, all nodes submitted proofs)
    expect(d1Epoch4Reward).to.equal(
      d3Epoch4Reward,
      'D1 and D3 should receive equal epoch 4 rewards (equal stakes)',
    );

    console.log(
      '    ✅ Rolling rewards successfully accumulated (epochs 2+3+4)',
    );
    console.log('    ✅ Both delegators received equal epoch 4 rewards');
    console.log(
      '    📝 Note: Equal stakes + all nodes submitted proofs = equal rewards',
    );
  });

  it('D1, D3 attempt to claim epoch 6 rewards - should revert (must claim epoch 5 first)', async () => {
    const { Staking, delegators, nodes } = env;

    console.log(
      '\n⛔ TEST 10: D1, D3 attempting to claim epoch 6 - should revert (must claim epoch 5 first)',
    );

    // D1 attempts to claim epoch 6 (but hasn't claimed epoch 5 yet)
    await expect(
      Staking.connect(delegators[0]).claimDelegatorRewards(
        nodes[0].identityId, // Node-1
        6n, // epoch 6
        delegators[0].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');

    console.log(
      '    ✅ D1 claim for epoch 6 reverted as expected (must claim epoch 5 first)',
    );

    // D3 attempts to claim epoch 6 (but hasn't claimed epoch 5 yet)
    await expect(
      Staking.connect(delegators[2]).claimDelegatorRewards(
        nodes[1].identityId, // Node-2
        6n, // epoch 6
        delegators[2].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');

    console.log(
      '    ✅ D3 claim for epoch 6 reverted as expected (must claim epoch 5 first)',
    );
    console.log(
      '    📝 Note: Sequential claiming enforced - cannot skip epoch 5',
    );
  });

});
