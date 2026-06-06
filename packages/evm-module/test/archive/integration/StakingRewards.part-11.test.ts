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



describe.skip('Migration tests (OBSOLETE: V8 rewards pipeline)', () => {
  let env: Awaited<ReturnType<typeof buildInitialRewardsState>>;
  let Staking: Staking,
    DelegatorsInfo: DelegatorsInfo,
    Chronos: Chronos,
    Token: Token,
    EpochStorage: EpochStorage,
    RandomSampling: RandomSampling,
    RandomSamplingStorage: RandomSamplingStorage,
    KC: KnowledgeCollection,
    ParametersStorage: ParametersStorage;
  let accounts: any, nodes: any[];
  let node1Id: number;
  let migratedDelegator: SignerWithAddress;

  before(async () => {
    env = await buildInitialRewardsState();
    // Unpack env
    ({
      Staking,
      DelegatorsInfo,
      Chronos,
      Token,
      EpochStorage,
      RandomSampling,
      RandomSamplingStorage,
      KC,
      ParametersStorage,
      accounts,
      nodes,
    } = env);
    node1Id = nodes[0].identityId;

    await ParametersStorage.connect(accounts.owner).setV81ReleaseEpoch(6);

    // 1. Get a new delegator from the list of signers
    const signers = await hre.ethers.getSigners();
    migratedDelegator = signers[24]; // Use a signer not active in the fixture

    // 2. Mint tokens for the new delegator
    await Token.mint(migratedDelegator.address, toTRAC(20_000));
  });



  it('should handle claims for a migrated delegator with lastClaimedEpoch = 0', async () => {
    // Current state from fixture: Epoch 7 has started.

    // 3. Simulate migration: Manually add delegator to storage without calling stake().
    // This will result in lastClaimedEpoch being the default value of 0.
    console.log(
      '\n🔩 Simulating migration: Manually adding delegator to storage...',
    );
    const stakeAmount = toTRAC(10_000);
    // Manually transfer tokens to the Staking contract, simulating a stake deposit
    await Token.connect(migratedDelegator).transfer(
      await Staking.getAddress(),
      stakeAmount,
    );

    const stakingContractAddress = await Staking.getAddress();
    await hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [stakingContractAddress],
    });
    const stakingSigner = await hre.ethers.getSigner(stakingContractAddress);
    // Fund the impersonated account so it can pay for gas
    await hre.network.provider.send('hardhat_setBalance', [
      stakingContractAddress,
      '0xDE0B6B3A7640000', // 1 ETH in hex
    ]);

    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [migratedDelegator.address]),
    );

    // Manually add delegator and set their stake by impersonating the Staking contract
    await DelegatorsInfo.connect(stakingSigner).addDelegator(
      node1Id,
      migratedDelegator.address,
    );
    await env.StakingStorage.connect(stakingSigner).increaseDelegatorStakeBase(
      node1Id,
      delegatorKey,
      stakeAmount,
    );

    await hre.network.provider.request({
      method: 'hardhat_stopImpersonatingAccount',
      params: [stakingContractAddress],
    });

    // 4. Verify the initial state is as expected for a migrated user
    const lastClaimed = await DelegatorsInfo.getLastClaimedEpoch(
      node1Id,
      migratedDelegator.address,
    );
    expect(lastClaimed).to.equal(
      0n,
      "Migrated delegator's lastClaimedEpoch should be 0",
    );
    const delegatorStake = await env.StakingStorage.getDelegatorStakeBase(
      node1Id,
      delegatorKey,
    );
    expect(delegatorStake).to.equal(stakeAmount);
    console.log(
      `  ✅ Delegator manually added. Stake: ${hre.ethers.formatUnits(
        delegatorStake,
        18,
      )}, LastClaimedEpoch: ${lastClaimed}.`,
    );

    // 5. Generate rewards for Epoch 7 by creating a KC and submitting a proof
    console.log('\n🎁 Generating rewards for Epoch 7...');
    const chunkSize = Number(await RandomSamplingStorage.CHUNK_BYTE_SIZE());
    // @ts-expect-error – dynamic CJS import of assertion-tools
    const { kcTools } = await import('assertion-tools');
    const merkleRoot = kcTools.calculateMerkleRoot(quads, 32);

    await createKnowledgeCollection(
      accounts.kcCreator,
      nodes[0], // publisher-node
      node1Id,
      [nodes[1], nodes[2], nodes[3]],
      [nodes[1].identityId, nodes[2].identityId, nodes[3].identityId],
      { KnowledgeCollection: KC, Token },
      merkleRoot,
      'epoch-7-migration-test-kc',
      1,
      chunkSize,
      1,
      toTRAC(10_000),
    );

    await advanceToNextProofingPeriod({ randomSampling: RandomSampling });
    await submitProofAndLogScore(
      node1Id,
      nodes[0],
      {
        randomSampling: RandomSampling,
        randomSamplingStorage: RandomSamplingStorage,
      },
      7n,
    );
    console.log('  ✅ Node-1 submitted proof for Epoch 7.');

    // 6. Advance to Epoch 8 to finalize Epoch 7
    console.log('  ⏳ Advancing to Epoch 8 to finalize Epoch 7...');
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Create a KC in the new epoch to trigger finalization of the previous one
    await createKnowledgeCollection(
      accounts.kcCreator,
      nodes[1],
      nodes[1].identityId,
      [nodes[0], nodes[2], nodes[3]],
      [node1Id, nodes[2].identityId, nodes[3].identityId],
      { KnowledgeCollection: KC, Token },
      merkleRoot,
      'finalize-epoch-7-kc',
      1,
      chunkSize,
      1,
      toTRAC(1),
    );
    const lastFinalized = await EpochStorage.lastFinalizedEpoch(1);
    expect(lastFinalized).to.equal(7n, 'Epoch 7 should be finalized.');
    console.log(
      `  ✅ Now in Epoch ${await Chronos.getCurrentEpoch()}, Last Finalized: ${lastFinalized}.`,
    );

    // 7. Migrated delegator claims rewards for Epoch 6 (no rewards expected, just updating lastClaimed)
    console.log('\n▶️  Migrated delegator attempting to claim for Epoch 6...');
    await expect(
      Staking.connect(migratedDelegator).claimDelegatorRewards(
        node1Id,
        6n,
        migratedDelegator.address,
      ),
    ).to.not.be.reverted;
    console.log('  ✅ Claim for epoch 6 was successful (0 rewards).');
    let newLastClaimed = await DelegatorsInfo.getLastClaimedEpoch(
      node1Id,
      migratedDelegator.address,
    );
    expect(newLastClaimed).to.equal(6n);

    // 8. Migrated delegator claims rewards for Epoch 7
    console.log('\n▶️  Migrated delegator attempting to claim for Epoch 7...');
    const stakeBaseBefore = await env.StakingStorage.getDelegatorStakeBase(
      node1Id,
      delegatorKey,
    );
    console.log(
      `  💎 StakeBase before claim: ${hre.ethers.formatUnits(
        stakeBaseBefore,
        18,
      )} TRAC`,
    );
    const rollingBefore = await DelegatorsInfo.getDelegatorRollingRewards(
      node1Id,
      migratedDelegator.address,
    );
    expect(rollingBefore).to.equal(0n);

    await expect(
      Staking.connect(migratedDelegator).claimDelegatorRewards(
        node1Id,
        7n,
        migratedDelegator.address,
      ),
    ).to.not.be.reverted;

    console.log('  ✅ Claim was successful!');

    // 9. Verify the outcome: rewards go to stakeBase, not rolling, as it's the last claimable epoch.
    const stakeBaseAfter = await env.StakingStorage.getDelegatorStakeBase(
      node1Id,
      delegatorKey,
    );
    console.log(
      `  💎 StakeBase after claim: ${hre.ethers.formatUnits(
        stakeBaseAfter,
        18,
      )} TRAC`,
    );
    const rollingAfter = await DelegatorsInfo.getDelegatorRollingRewards(
      node1Id,
      migratedDelegator.address,
    );
    const reward = stakeBaseAfter - stakeBaseBefore;

    console.log(
      `  💰 Reward added to stakeBase: ${hre.ethers.formatUnits(
        reward,
        18,
      )} TRAC`,
    );
    console.log(
      `  🔄 Rolling rewards after claim: ${hre.ethers.formatUnits(
        rollingAfter,
        18,
      )} TRAC (should be 0)`,
    );

    expect(reward).to.be.gt(
      0n,
      'Delegator should have received positive rewards added to stakeBase',
    );
    expect(rollingAfter).to.equal(
      0n,
      'Rolling rewards should be 0 as this was the last finalized epoch to claim',
    );

    newLastClaimed = await DelegatorsInfo.getLastClaimedEpoch(
      node1Id,
      migratedDelegator.address,
    );
    console.log(`  📅 New last claimed epoch is: ${newLastClaimed}`);
    expect(newLastClaimed).to.equal(7n, 'Last claimed epoch should now be 7');
  });

});
