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



  it('D1, D3 claim epoch 5 rewards - should succeed with 0 rewards (no proofs submitted)', async () => {
    const {
      Staking,
      DelegatorsInfo,
      RandomSamplingStorage,
      delegators,
      nodes,
    } = env;

    console.log(
      '\n✅ TEST 11: D1, D3 claiming epoch 5 rewards - should get 0 rewards (no proofs)',
    );

    // Get rolling rewards before epoch 5 claims (should have epoch 2+3+4 rewards)
    const d1RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[0].address,
    );
    const d3RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[2].address,
    );

    console.log(
      `    🔄 D1 rolling before epoch 5: ${hre.ethers.formatUnits(d1RollingBefore, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 rolling before epoch 5: ${hre.ethers.formatUnits(d3RollingBefore, 18)} TRAC`,
    );

    // Check epoch 5 node scores (should be 0 since no proofs were submitted)
    const node1Score5 = await RandomSamplingStorage.getNodeEpochScore(
      5n,
      nodes[0].identityId,
    );
    const node2Score5 = await RandomSamplingStorage.getNodeEpochScore(
      5n,
      nodes[1].identityId,
    );

    console.log(`    📊 Node-1 epoch 5 score: ${node1Score5} (should be 0)`);
    console.log(`    📊 Node-2 epoch 5 score: ${node2Score5} (should be 0)`);

    // Verify scores are 0 (no proofs submitted)
    expect(node1Score5).to.equal(0n, 'Node-1 should have 0 score in epoch 5');
    expect(node2Score5).to.equal(0n, 'Node-2 should have 0 score in epoch 5');

    // D1 claims epoch 5 rewards (should succeed but get 0 rewards)
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId, // Node-1
      5n, // epoch 5
      delegators[0].address,
    );

    console.log('    ✅ D1 successfully claimed epoch 5 rewards (0 TRAC)');

    // D3 claims epoch 5 rewards (should succeed but get 0 rewards)
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId, // Node-2
      5n, // epoch 5
      delegators[2].address,
    );

    console.log('    ✅ D3 successfully claimed epoch 5 rewards (0 TRAC)');

    // Get rolling rewards after epoch 5 claims
    const d1RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[0].address,
    );
    const d3RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[2].address,
    );

    // Calculate epoch 5 rewards (should be 0)
    const d1Epoch5Reward = d1RollingAfter - d1RollingBefore;
    const d3Epoch5Reward = d3RollingAfter - d3RollingBefore;

    console.log(
      `    💰 D1 epoch 5 reward: ${hre.ethers.formatUnits(d1Epoch5Reward, 18)} TRAC`,
    );
    console.log(
      `    💰 D3 epoch 5 reward: ${hre.ethers.formatUnits(d3Epoch5Reward, 18)} TRAC`,
    );
    console.log(
      `    🔄 D1 total rolling after epoch 5: ${hre.ethers.formatUnits(d1RollingAfter, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 total rolling after epoch 5: ${hre.ethers.formatUnits(d3RollingAfter, 18)} TRAC`,
    );

    // Verify rolling rewards didn't change (no rewards from epoch 5)
    expect(d1RollingAfter).to.equal(
      d1RollingBefore,
      'D1 rolling rewards should not change (no epoch 5 rewards)',
    );
    expect(d3RollingAfter).to.equal(
      d3RollingBefore,
      'D3 rolling rewards should not change (no epoch 5 rewards)',
    );

    // Verify epoch 5 rewards are 0
    expect(d1Epoch5Reward).to.equal(
      0n,
      'D1 should receive 0 rewards from epoch 5',
    );
    expect(d3Epoch5Reward).to.equal(
      0n,
      'D3 should receive 0 rewards from epoch 5',
    );

    // Verify both have same rolling rewards (should be equal after epochs 2+3+4)
    expect(d1RollingAfter).to.equal(
      d3RollingAfter,
      'D1 and D3 should have equal rolling rewards (equal stakes in all claimed epochs)',
    );

    console.log(
      '    ✅ Both delegators successfully claimed epoch 5 with 0 rewards',
    );
    console.log('    ✅ Rolling rewards remained unchanged (no new rewards)');
    console.log('    ✅ Both delegators have equal rolling rewards');
    console.log('    📝 Note: No proofs in epoch 5 = no rewards to distribute');
  });

  it('D1, D3 attempt to claim epoch 5 rewards again - should revert (already claimed)', async () => {
    const { Staking, delegators, nodes } = env;

    console.log(
      '\n⛔ TEST 12: D1, D3 attempting to claim epoch 5 again - should revert (already claimed)',
    );

    // D1 attempts to claim epoch 5 again (but already claimed it)
    await expect(
      Staking.connect(delegators[0]).claimDelegatorRewards(
        nodes[0].identityId, // Node-1
        5n, // epoch 5
        delegators[0].address,
      ),
    ).to.be.revertedWith('Epoch already claimed');

    console.log(
      '    ✅ D1 claim for epoch 5 reverted as expected (already claimed)',
    );

    // D3 attempts to claim epoch 5 again (but already claimed it)
    await expect(
      Staking.connect(delegators[2]).claimDelegatorRewards(
        nodes[1].identityId, // Node-2
        5n, // epoch 5
        delegators[2].address,
      ),
    ).to.be.revertedWith('Epoch already claimed');

    console.log(
      '    ✅ D3 claim for epoch 5 reverted as expected (already claimed)',
    );
    console.log(
      '    📝 Note: Cannot claim the same epoch twice - double claiming prevented',
    );
  });

  it('D1, D3 attempt to claim epoch 7 rewards - should revert (epoch not finalized)', async () => {
    const { Staking, delegators, nodes } = env;

    console.log(
      '\n⛔ TEST 13: D1, D3 attempting to claim epoch 7 - should revert (epoch not finalized)',
    );

    // D1 attempts to claim epoch 7 (but epoch 7 is not finalized yet)
    await expect(
      Staking.connect(delegators[0]).claimDelegatorRewards(
        nodes[0].identityId, // Node-1
        7n, // epoch 7
        delegators[0].address,
      ),
    ).to.be.revertedWith('Epoch not finalised');

    console.log(
      '    ✅ D1 claim for epoch 7 reverted as expected (epoch not finalized)',
    );

    // D3 attempts to claim epoch 7 (but epoch 7 is not finalized yet)
    await expect(
      Staking.connect(delegators[2]).claimDelegatorRewards(
        nodes[1].identityId, // Node-2
        7n, // epoch 7
        delegators[2].address,
      ),
    ).to.be.revertedWith('Epoch not finalised');

    console.log(
      '    ✅ D3 claim for epoch 7 reverted as expected (epoch not finalized)',
    );
    console.log('    📝 Note: Cannot claim rewards for non-finalized epochs');
  });

  it('D1, D3 claim epoch 6 rewards - should succeed with 0 rewards (no proofs submitted)', async () => {
    const {
      Staking,
      DelegatorsInfo,
      RandomSamplingStorage,
      delegators,
      nodes,
    } = env;

    console.log(
      '\n✅ TEST 14: D1, D3 claiming epoch 6 rewards - should get 0 rewards (no proofs)',
    );

    // Get rolling rewards before epoch 6 claims (should have epoch 2+3+4+5 rewards)
    const d1RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[0].address,
    );
    const d3RollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[2].address,
    );

    console.log(
      `    🔄 D1 rolling before epoch 6: ${hre.ethers.formatUnits(d1RollingBefore, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 rolling before epoch 6: ${hre.ethers.formatUnits(d3RollingBefore, 18)} TRAC`,
    );

    // Check epoch 6 node scores (should be 0 since no proofs were submitted)
    const node1Score6 = await RandomSamplingStorage.getNodeEpochScore(
      6n,
      nodes[0].identityId,
    );
    const node2Score6 = await RandomSamplingStorage.getNodeEpochScore(
      6n,
      nodes[1].identityId,
    );

    console.log(`    📊 Node-1 epoch 6 score: ${node1Score6} (should be 0)`);
    console.log(`    📊 Node-2 epoch 6 score: ${node2Score6} (should be 0)`);

    // Verify scores are 0 (no proofs submitted)
    expect(node1Score6).to.equal(0n, 'Node-1 should have 0 score in epoch 6');
    expect(node2Score6).to.equal(0n, 'Node-2 should have 0 score in epoch 6');

    // D1 claims epoch 6 rewards (should succeed but get 0 rewards)
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId, // Node-1
      6n, // epoch 6
      delegators[0].address,
    );

    console.log('    ✅ D1 successfully claimed epoch 6 rewards (0 TRAC)');

    // D3 claims epoch 6 rewards (should succeed but get 0 rewards)
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId, // Node-2
      6n, // epoch 6
      delegators[2].address,
    );

    console.log('    ✅ D3 successfully claimed epoch 6 rewards (0 TRAC)');

    // Get rolling rewards after epoch 6 claims
    const d1RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[0].identityId,
      delegators[0].address,
    );
    const d3RollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      nodes[1].identityId,
      delegators[2].address,
    );

    // Read actual values from contracts after claiming
    const d1RollingTransferred = d1RollingBefore - d1RollingAfter; // How much was transferred
    const d3RollingTransferred = d3RollingBefore - d3RollingAfter; // How much was transferred

    console.log(`    💰 D1 epoch 6 reward: 0.0 TRAC (no proofs submitted)`);
    console.log(`    💰 D3 epoch 6 reward: 0.0 TRAC (no proofs submitted)`);
    console.log(
      `    🔄 D1 rolling transferred: ${hre.ethers.formatUnits(d1RollingTransferred, 18)} TRAC → stakeBase`,
    );
    console.log(
      `    🔄 D3 rolling transferred: ${hre.ethers.formatUnits(d3RollingTransferred, 18)} TRAC → stakeBase`,
    );
    console.log(
      `    🔄 D1 total rolling after epoch 6: ${hre.ethers.formatUnits(d1RollingAfter, 18)} TRAC`,
    );
    console.log(
      `    🔄 D3 total rolling after epoch 6: ${hre.ethers.formatUnits(d3RollingAfter, 18)} TRAC`,
    );

    // Get stakeBase after epoch 6 claims to check if rolling rewards were transferred
    const d1StakeBaseAfter = await env.StakingStorage.getDelegatorStakeBase(
      nodes[0].identityId,
      hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [delegators[0].address]),
      ),
    );
    const d3StakeBaseAfter = await env.StakingStorage.getDelegatorStakeBase(
      nodes[1].identityId,
      hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [delegators[2].address]),
      ),
    );

    console.log(
      `    💎 D1 stakeBase after epoch 6: ${hre.ethers.formatUnits(d1StakeBaseAfter, 18)} TRAC`,
    );
    console.log(
      `    💎 D3 stakeBase after epoch 6: ${hre.ethers.formatUnits(d3StakeBaseAfter, 18)} TRAC`,
    );

    // Verify epoch 6 behavior - no new rewards, but rolling rewards transferred
    // Since no proofs were submitted in epoch 6, no new rewards should be generated
    // But rolling rewards should be transferred to stakeBase since this is the last claimable epoch

    // Since epoch 6 is the last claimable epoch (epoch 7 is current and not finalized),
    // rolling rewards should have been transferred to stakeBase
    expect(d1RollingAfter).to.equal(
      0n,
      'D1 rolling rewards should be 0 (transferred to stakeBase as last epoch)',
    );
    expect(d3RollingAfter).to.equal(
      0n,
      'D3 rolling rewards should be 0 (transferred to stakeBase as last epoch)',
    );

    // Verify that rolling rewards were properly transferred to stakeBase
    // Both delegators should have equal stakeBase (since they had equal stakes and equal rewards)
    expect(d1StakeBaseAfter).to.equal(
      d3StakeBaseAfter,
      'D1 and D3 should have equal stakeBase after claiming all epochs',
    );

    // Verify that stakeBase increased by the amount of rolling rewards that were transferred
    expect(d1StakeBaseAfter).to.be.gt(
      toTRAC(10_000),
      'D1 stakeBase should be greater than original 10k stake (includes transferred rewards)',
    );
    expect(d3StakeBaseAfter).to.be.gt(
      toTRAC(10_000),
      'D3 stakeBase should be greater than original 10k stake (includes transferred rewards)',
    );

    console.log(
      '    ✅ Both delegators successfully claimed epoch 6 with 0 rewards',
    );
    console.log(
      '    ✅ Rolling rewards transferred to stakeBase (last claimable epoch)',
    );
    console.log('    ✅ Both delegators have equal final stakeBase');
    console.log(
      '    📝 Note: Last epoch claim transfers rolling rewards to stakeBase',
    );
  });

  it('D1, D3 attempt to claim epoch 7 rewards again - should revert (epoch not finalized)', async () => {
    const { Staking, delegators, nodes, Chronos, EpochStorage } = env;

    console.log(
      '\n⛔ TEST 15: D1, D3 attempting to claim epoch 7 - should revert (epoch not finalized)',
    );

    // Verify current state
    const currentEpoch = await Chronos.getCurrentEpoch();
    const lastFinalizedEpoch = await EpochStorage.lastFinalizedEpoch(1);

    console.log(`    ℹ️  Current epoch: ${currentEpoch}`);
    console.log(`    ℹ️  Last finalized epoch: ${lastFinalizedEpoch}`);

    // Verify epoch 7 is current and not finalized
    expect(currentEpoch).to.equal(7n, 'Current epoch should be 7');
    expect(lastFinalizedEpoch).to.be.lt(
      7n,
      'Epoch 7 should not be finalized yet',
    );

    // D1 attempts to claim epoch 7 (but epoch 7 is current and not finalized)
    await expect(
      Staking.connect(delegators[0]).claimDelegatorRewards(
        nodes[0].identityId, // Node-1
        7n, // epoch 7
        delegators[0].address,
      ),
    ).to.be.revertedWith('Epoch not finalised');

    console.log(
      '    ✅ D1 claim for epoch 7 reverted as expected (epoch not finalized)',
    );

    // D3 attempts to claim epoch 7 (but epoch 7 is current and not finalized)
    await expect(
      Staking.connect(delegators[2]).claimDelegatorRewards(
        nodes[1].identityId, // Node-2
        7n, // epoch 7
        delegators[2].address,
      ),
    ).to.be.revertedWith('Epoch not finalised');

    console.log(
      '    ✅ D3 claim for epoch 7 reverted as expected (epoch not finalized)',
    );
    console.log(
      '    📝 Note: Cannot claim rewards for current/non-finalized epochs',
    );
    console.log(
      '    📝 Note: Epoch must be finalized before rewards can be claimed',
    );
  });

});
