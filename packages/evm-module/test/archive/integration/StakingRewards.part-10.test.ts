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



describe.skip('Operator fee withdrawal tests (OBSOLETE: V8 rewards pipeline)', () => {
  let env: Awaited<ReturnType<typeof buildInitialRewardsState>>;
  let Staking: Staking,
    StakingStorage: StakingStorage,
    Token: Token,
    ParametersStorage: ParametersStorage;
  let delegators: SignerWithAddress[], nodes: any[];

  before(async () => {
    env = await buildInitialRewardsState();
    // Unpack env
    ({ Staking, StakingStorage, Token, ParametersStorage, delegators, nodes } =
      env);

    console.log('\n🎯 OPERATOR FEE WITHDRAWAL TESTS - Simple flow test');

    // D1 claims epochs 2,3 for Node-1
    console.log('  📍 D1 claiming epochs 2,3 for Node-1...');
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId,
      2n,
      delegators[0].address,
    );
    await Staking.connect(delegators[0]).claimDelegatorRewards(
      nodes[0].identityId,
      3n,
      delegators[0].address,
    );

    // D2 claims epochs 2,3,4 for Node-1
    console.log('  📍 D2 claiming epochs 2,3,4 for Node-1...');
    await Staking.connect(delegators[1]).claimDelegatorRewards(
      nodes[0].identityId,
      2n,
      delegators[1].address,
    );
    await Staking.connect(delegators[1]).claimDelegatorRewards(
      nodes[0].identityId,
      3n,
      delegators[1].address,
    );
    await Staking.connect(delegators[1]).claimDelegatorRewards(
      nodes[0].identityId,
      4n,
      delegators[1].address,
    );

    // D3 claims epochs 2,3 for Node-2
    console.log('  📍 D3 claiming epochs 2,3 for Node-2...');
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId,
      2n,
      delegators[2].address,
    );
    await Staking.connect(delegators[2]).claimDelegatorRewards(
      nodes[1].identityId,
      3n,
      delegators[2].address,
    );

    // D4 claims epochs 2,3,4 for Node-2
    console.log('  📍 D4 claiming epochs 2,3,4 for Node-2...');
    await Staking.connect(delegators[3]).claimDelegatorRewards(
      nodes[1].identityId,
      2n,
      delegators[3].address,
    );
    await Staking.connect(delegators[3]).claimDelegatorRewards(
      nodes[1].identityId,
      3n,
      delegators[3].address,
    );
    await Staking.connect(delegators[3]).claimDelegatorRewards(
      nodes[1].identityId,
      4n,
      delegators[3].address,
    );

    console.log('  ✅ Claims completed');
  });



  it('Both nodes request operator fee withdrawal - amounts should be equal', async () => {
    console.log(
      '\n💰 Checking operator fee balances and requesting withdrawals',
    );

    // Check operator fee balances
    const node1FeeBalance = await StakingStorage.getOperatorFeeBalance(
      nodes[0].identityId,
    );
    const node2FeeBalance = await StakingStorage.getOperatorFeeBalance(
      nodes[1].identityId,
    );

    console.log(
      `  💎 Node-1 operator fee balance: ${hre.ethers.formatUnits(node1FeeBalance, 18)} TRAC`,
    );
    console.log(
      `  💎 Node-2 operator fee balance: ${hre.ethers.formatUnits(node2FeeBalance, 18)} TRAC`,
    );

    // Both nodes should have positive and equal operator fees (since they're identical)
    expect(node1FeeBalance).to.be.gt(0n, 'Node-1 should have operator fees');
    expect(node2FeeBalance).to.be.gt(0n, 'Node-2 should have operator fees');
    expect(node1FeeBalance).to.equal(
      node2FeeBalance,
      'Node-1 and Node-2 should have equal operator fees',
    );

    // Request full withdrawal for both nodes
    console.log('  🔄 Requesting full withdrawal for both nodes...');

    await Staking.connect(nodes[0].admin).requestOperatorFeeWithdrawal(
      nodes[0].identityId,
      node1FeeBalance,
    );

    await Staking.connect(nodes[1].admin).requestOperatorFeeWithdrawal(
      nodes[1].identityId,
      node2FeeBalance,
    );

    // Verify withdrawal requests
    const [node1RequestAmount] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(nodes[0].identityId);
    const [node2RequestAmount] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(nodes[1].identityId);

    expect(node1RequestAmount).to.equal(
      node1FeeBalance,
      'Node-1 withdrawal request should match balance',
    );
    expect(node2RequestAmount).to.equal(
      node2FeeBalance,
      'Node-2 withdrawal request should match balance',
    );
    expect(node1RequestAmount).to.equal(
      node2RequestAmount,
      'Both withdrawal requests should be equal',
    );

    console.log('  ✅ Both nodes have equal withdrawal requests');
  });

  it('Node-1 finalizes withdrawal, Node-2 cancels - verify wallet and state changes', async () => {
    console.log('\n🔄 Node-1 finalize vs Node-2 cancel');

    // Advance time to pass withdrawal delay
    const delay = await ParametersStorage.stakeWithdrawalDelay();
    await time.increase(delay + 1n);
    console.log(`  ⏰ Advanced time by ${delay + 1n} seconds`);

    // Get wallet balances before
    const node1WalletBefore = await Token.balanceOf(nodes[0].admin.address);
    const node2WalletBefore = await Token.balanceOf(nodes[1].admin.address);

    console.log(
      `  💳 Node-1 admin wallet before: ${hre.ethers.formatUnits(node1WalletBefore, 18)} TRAC`,
    );
    console.log(
      `  💳 Node-2 admin wallet before: ${hre.ethers.formatUnits(node2WalletBefore, 18)} TRAC`,
    );

    // Get withdrawal amounts
    const [node1WithdrawalAmount] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(nodes[0].identityId);
    const [node2WithdrawalAmount] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(nodes[1].identityId);

    // Node-1 finalizes withdrawal
    console.log('  ✅ Node-1 finalizing withdrawal...');
    await Staking.connect(nodes[0].admin).finalizeOperatorFeeWithdrawal(
      nodes[0].identityId,
    );

    // Node-2 cancels withdrawal
    console.log('  ❌ Node-2 canceling withdrawal...');
    await Staking.connect(nodes[1].admin).cancelOperatorFeeWithdrawal(
      nodes[1].identityId,
    );

    // Check wallet balances after
    const node1WalletAfter = await Token.balanceOf(nodes[0].admin.address);
    const node2WalletAfter = await Token.balanceOf(nodes[1].admin.address);

    console.log(
      `  💳 Node-1 admin wallet after: ${hre.ethers.formatUnits(node1WalletAfter, 18)} TRAC`,
    );
    console.log(
      `  💳 Node-2 admin wallet after: ${hre.ethers.formatUnits(node2WalletAfter, 18)} TRAC`,
    );

    // Verify Node-1 received tokens
    expect(node1WalletAfter - node1WalletBefore).to.equal(
      node1WithdrawalAmount,
      'Node-1 admin should receive withdrawal amount',
    );

    // Verify Node-2 wallet didn't change
    expect(node2WalletAfter).to.equal(
      node2WalletBefore,
      'Node-2 admin wallet should not change',
    );

    // Check operator fee balances after
    const node1FeeBalanceAfter = await StakingStorage.getOperatorFeeBalance(
      nodes[0].identityId,
    );
    const node2FeeBalanceAfter = await StakingStorage.getOperatorFeeBalance(
      nodes[1].identityId,
    );

    console.log(
      `  💎 Node-1 operator fee balance after: ${hre.ethers.formatUnits(node1FeeBalanceAfter, 18)} TRAC`,
    );
    console.log(
      `  💎 Node-2 operator fee balance after: ${hre.ethers.formatUnits(node2FeeBalanceAfter, 18)} TRAC`,
    );

    // Node-1 should have 0 operator fees (finalized)
    expect(node1FeeBalanceAfter).to.equal(
      0n,
      'Node-1 should have 0 operator fees after finalization',
    );

    // Node-2 should have restored operator fees (cancelled)
    expect(node2FeeBalanceAfter).to.equal(
      node2WithdrawalAmount,
      'Node-2 should have restored operator fees after cancellation',
    );

    // Verify withdrawal requests are cleared
    const [node1FinalRequest] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(nodes[0].identityId);
    const [node2FinalRequest] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(nodes[1].identityId);

    expect(node1FinalRequest).to.equal(
      0n,
      'Node-1 withdrawal request should be cleared',
    );
    expect(node2FinalRequest).to.equal(
      0n,
      'Node-2 withdrawal request should be cleared',
    );

    console.log('  ✅ Finalize/cancel flows completed successfully');
    console.log('  📝 Node-1: Received tokens, fees cleared');
    console.log('  📝 Node-2: No tokens, fees restored');
  });

});
