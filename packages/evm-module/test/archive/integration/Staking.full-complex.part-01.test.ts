import {
  time,
  kcTools,
  expect,
  hre,
  ethers,
  createKnowledgeCollection,
  createProfile,
  quads,
  merkleRoot,
  toTRAC,
  calculateExpectedDelegatorScore,
  epochRewardsPoolPrecisionLoss,
  submitProofAndVerifyScore,
  advanceToNextProofingPeriod,
  ensureNodeHasChunksThisEpoch,
  setupTestEnvironment,
  type TestAccounts,
  type TestContracts,
  type SignerWithAddress,
} from './Staking.shared';

describe.skip(`Full complex scenario (OBSOLETE: V8 rewards pipeline)`, function () {

    let accounts: TestAccounts;

    let contracts: TestContracts;

    let nodeIds: { node1Id: bigint; node2Id: bigint };

    let node1Id: bigint;

    let d1Key: string, d2Key: string, d3Key: string;

    let epoch1: bigint;

    let receivingNodes: {
      operational: SignerWithAddress;
      admin: SignerWithAddress;
    }[];

    let receivingNodesIdentityIds: number[];

    let TOKEN_DECIMALS = 18;

    let chunkSize: number;


    it('Should execute steps 1-7 with detailed score calculations and verification', async function () {
      // ================================================================================================================
      // SETUP: Initialize test environment
      // ================================================================================================================
      const setup = await setupTestEnvironment();
      accounts = setup.accounts;
      contracts = setup.contracts;
      nodeIds = setup.nodeIds;
      chunkSize = setup.chunkSize;
      node1Id = nodeIds.node1Id;

      TOKEN_DECIMALS = Number(await contracts.token.decimals());

      epoch1 = await contracts.chronos.getCurrentEpoch();
      const epochLength = await contracts.chronos.epochLength();
      const leftUntilNextEpoch = await contracts.chronos.timeUntilNextEpoch();
      console.log(`\n🏁 Starting test in epoch ${epoch1}`);
      console.log(`\n🏁 Epoch length ${epochLength}`);
      console.log(`\n🏁 Time until next epoch ${leftUntilNextEpoch}`);
      console.log(
        `\n🏁 Remaining percentage of time until next epoch ${leftUntilNextEpoch / epochLength}`,
      );
      // Create delegator keys for state verification
      d1Key = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator1.address]),
      );
      d2Key = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator2.address]),
      );
      d3Key = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator3.address]),
      );

      // ================================================================================================================
      // SETUP: Create Knowledge Collection for reward pool
      // ================================================================================================================
      console.log(`\n📚 Creating Knowledge Collection for reward pool...`);

      receivingNodes = [
        accounts.receiver1,
        accounts.receiver2,
        accounts.receiver3,
      ];
      receivingNodesIdentityIds = [];
      for (const recNode of receivingNodes) {
        const { identityId } = await createProfile(contracts.profile, recNode);
        receivingNodesIdentityIds.push(Number(identityId));
      }

      const kcTokenAmount = toTRAC(48_000);
      const numberOfEpochs = 10;
      console.log(
        `\n📚 Reward pool = ${ethers.formatUnits(kcTokenAmount, 18)} TRAC, for ${numberOfEpochs} epochs =  ${kcTokenAmount / BigInt(numberOfEpochs)} per epoch`,
      );
      await createKnowledgeCollection(
        accounts.kcCreator,
        accounts.node1,
        Number(node1Id),
        receivingNodes,
        receivingNodesIdentityIds,
        { KnowledgeCollection: contracts.kc, Token: contracts.token },
        merkleRoot,
        'test-op-id',
        10,
        chunkSize * 10, // byteSize - use multiple of chunkSize for proper chunk generation
        numberOfEpochs,
        kcTokenAmount,
      );

      // we're sure tokens are well distributed to epochs

      // ================================================================================================================
      // STEP 1: Delegator1 stakes 10,000 TRAC
      // ================================================================================================================
      console.log(`\n📊 STEP 1: Delegator1 stakes 10,000 TRAC`);

      const epochBeforeStake = await contracts.chronos.getCurrentEpoch();
      console.log(`    ℹ️  Current epoch before staking: ${epochBeforeStake}`);

      await contracts.token
        .connect(accounts.delegator1)
        .approve(await contracts.staking.getAddress(), toTRAC(10_000));
      await contracts.staking
        .connect(accounts.delegator1)
        .stake(node1Id, toTRAC(10_000));

      // Verify state
      const totalStakeAfterStep1 =
        await contracts.stakingStorage.getNodeStake(node1Id);
      console.log(
        `    ✅ Node1 total stake: ${ethers.formatUnits(totalStakeAfterStep1, 18)} TRAC`,
      );
      expect(totalStakeAfterStep1).to.equal(toTRAC(10_000));
      const totalDelegatorStakeAfterStep1 =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
      console.log(
        `    ✅ Delegator1 total stake: ${ethers.formatUnits(totalDelegatorStakeAfterStep1, 18)} TRAC`,
      );
      expect(totalDelegatorStakeAfterStep1).to.equal(toTRAC(10_000));

      // ================================================================================================================
      // STEP 2: Delegator2 stakes 20,000 TRAC
      // ================================================================================================================
      console.log(`\n📊 STEP 2: Delegator2 stakes 20,000 TRAC`);

      await contracts.token
        .connect(accounts.delegator2)
        .approve(await contracts.staking.getAddress(), toTRAC(20_000));
      await contracts.staking
        .connect(accounts.delegator2)
        .stake(node1Id, toTRAC(20_000));

      const totalStakeAfterStep2 =
        await contracts.stakingStorage.getNodeStake(node1Id);
      console.log(
        `    ✅ Node1 total stake: ${ethers.formatUnits(totalStakeAfterStep2, 18)} TRAC`,
      );
      expect(totalStakeAfterStep2).to.equal(toTRAC(30_000));
      const totalDelegatorStakeAfterStep2 =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d2Key);
      console.log(
        `    ✅ Delegator2 total stake: ${ethers.formatUnits(totalDelegatorStakeAfterStep2, 18)} TRAC`,
      );
      expect(totalDelegatorStakeAfterStep2).to.equal(toTRAC(20_000));

      // ================================================================================================================
      // STEP 3: Delegator3 stakes 30,000 TRAC
      // ================================================================================================================
      console.log(`\n📊 STEP 3: Delegator3 stakes 30,000 TRAC`);

      await contracts.token
        .connect(accounts.delegator3)
        .approve(await contracts.staking.getAddress(), toTRAC(30_000));
      await contracts.staking
        .connect(accounts.delegator3)
        .stake(node1Id, toTRAC(30_000));

      const totalStakeAfterStep3 =
        await contracts.stakingStorage.getNodeStake(node1Id);
      console.log(
        `    ✅ Node1 total stake: ${ethers.formatUnits(totalStakeAfterStep3, 18)} TRAC`,
      );
      expect(totalStakeAfterStep3).to.equal(toTRAC(60_000));
      const totalDelegatorStakeAfterStep3 =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d3Key);
      console.log(
        `    ✅ Delegator3 total stake: ${ethers.formatUnits(totalDelegatorStakeAfterStep3, 18)} TRAC`,
      );
      expect(totalDelegatorStakeAfterStep3).to.equal(toTRAC(30_000));

      // ================================================================================================================
      // STEP 4: Node1 submits first proof with score verification
      // ================================================================================================================
      console.log(`\n🔬 STEP 4: Node1 submits first proof`);

      await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
      const {
        nodeScore: scoreAfter1,
        nodeScorePerStake: nodeScorePerStakeAfter1,
      } = await submitProofAndVerifyScore(
        node1Id,
        accounts.node1,
        contracts,
        epoch1,
        totalStakeAfterStep3,
      );

      // ================================================================================================================
      // STEP 5: Delegator1 stakes additional 10,000 TRAC with score settlement verification
      // ================================================================================================================
      console.log(`\n📊 STEP 5: Delegator1 stakes additional 10,000 TRAC`);

      // Get delegator1's score before staking
      const d1ScoreBeforeStake =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          epoch1,
          node1Id,
          d1Key,
        );

      // Get delegator1's last settled node score per stake
      const d1LastSettledNodeScorePerStake =
        await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          epoch1,
          node1Id,
          d1Key,
        );

      // Stake additional 10,000 TRAC
      await contracts.token
        .connect(accounts.delegator1)
        .approve(await contracts.staking.getAddress(), toTRAC(10_000));
      await contracts.staking
        .connect(accounts.delegator1)
        .stake(node1Id, toTRAC(10_000));

      // Verify node1's total stake
      const totalStakeAfterStep5 =
        await contracts.stakingStorage.getNodeStake(node1Id);
      console.log(
        `    ✅ Node1 total stake: ${ethers.formatUnits(totalStakeAfterStep5, 18)} TRAC`,
      );
      expect(totalStakeAfterStep5).to.equal(toTRAC(70_000));
      const totalDelegator1StakeAfterStep5 =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
      console.log(
        `    ✅ Delegator1 total stake: ${ethers.formatUnits(totalDelegator1StakeAfterStep5, 18)} TRAC`,
      );
      expect(totalDelegator1StakeAfterStep5).to.equal(toTRAC(20_000));

      // Verify delegator1's score settlement from first proof period
      const d1ScoreAfterStake =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          epoch1,
          node1Id,
          d1Key,
        );
      const expectedD1ScoreIncrement = calculateExpectedDelegatorScore(
        toTRAC(10_000),
        nodeScorePerStakeAfter1,
        d1LastSettledNodeScorePerStake,
      );
      const expectedD1Score = d1ScoreBeforeStake + expectedD1ScoreIncrement;

      console.log(`    🧮 Delegator1 score settlement verification:`);
      console.log(
        `    ✅ Expected: ${expectedD1Score}, Actual: ${d1ScoreAfterStake}`,
      );
      expect(d1ScoreAfterStake).to.equal(
        expectedD1Score,
        'Delegator1 score settlement mismatch',
      );

      // ================================================================================================================
      // STEP 6: Node1 submits second proof
      // ================================================================================================================
      console.log(`\n🔬 STEP 6: Node1 submits second proof`);

      await advanceToNextProofingPeriod(contracts);
      const {
        nodeScore: scoreAfter2,
        nodeScorePerStake: nodeScorePerStakeAfter2,
      } = await submitProofAndVerifyScore(
        node1Id,
        accounts.node1,
        contracts,
        epoch1,
        totalStakeAfterStep5,
      );

      expect(scoreAfter2).to.be.gt(
        scoreAfter1,
        'Second proof should increase total score',
      );
      expect(nodeScorePerStakeAfter2).to.be.gt(
        nodeScorePerStakeAfter1,
        'Score per stake should increase',
      );

      // ================================================================================================================
      // ADVANCE TO NEXT EPOCH AND FINALIZE
      // ================================================================================================================
      console.log(`\n⏭️ Advancing to next epoch and finalizing...`);

      const timeUntilNextEpoch = await contracts.chronos.timeUntilNextEpoch();
      await time.increase(timeUntilNextEpoch + 1n);
      const epoch2 = await contracts.chronos.getCurrentEpoch();
      console.log(`    ✅ Advanced to epoch ${epoch2}`);

      // Create another KC to trigger epoch finalization
      await createKnowledgeCollection(
        accounts.kcCreator,
        accounts.node1,
        Number(node1Id),
        receivingNodes,
        receivingNodesIdentityIds,
        { KnowledgeCollection: contracts.kc, Token: contracts.token },
        merkleRoot,
        'dummy-op-id-2',
        1, // holders
        chunkSize * 5, // byteSize - use multiple of chunkSize
        1, // replicas
        toTRAC(10), // small fee for finalization
      );

      expect(await contracts.epochStorage.lastFinalizedEpoch(1)).to.be.gte(
        epoch1,
      );
      console.log(`    ✅ Epoch ${epoch1} finalized`);

      // ================================================================================================================
      // STEP 7: Delegator1 claims rewards with detailed verification
      // ================================================================================================================
      console.log(`\n💰 STEP 7: Delegator1 claims rewards for epoch ${epoch1}`);

      const d1StakeBaseBefore =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);

      // Get node score
      const nodeFinalScore =
        await contracts.randomSamplingStorage.getNodeEpochScore(epoch1, node1Id);
      const netNodeRewards = await contracts.stakingKPI.getNetNodeRewards(
        node1Id,
        epoch1,
      );

      const epocRewardsPool = await contracts.epochStorage.getEpochPool(
        1,
        epoch1,
      );
      expect(netNodeRewards).to.equal(epocRewardsPool);

      console.log(`    🧮 Reward calculation verification:`);
      console.log(`    📊 Node1 final score: ${nodeFinalScore}`);
      console.log(
        `    💎 Net delegator rewards: ${ethers.formatUnits(netNodeRewards, 18)} TRAC should be equal to epoch rewards pool: ${ethers.formatUnits(epocRewardsPool, 18)} TRAC`,
      );

      // Claim rewards
      await contracts.staking
        .connect(accounts.delegator1)
        .claimDelegatorRewards(node1Id, epoch1, accounts.delegator1.address);

      const d1FinalScore =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          epoch1,
          node1Id,
          d1Key,
        );

      // Calculate expected reward: (delegator_score / node_score) * available_rewards
      const expectedReward = (d1FinalScore * netNodeRewards) / nodeFinalScore;

      console.log(`    📊 Delegator1 final score: ${d1FinalScore}`);
      console.log(
        `    💰 Expected reward for Delegator1: ${ethers.formatUnits(expectedReward, 18)} TRAC`,
      );

      const d1StakeBaseAfter =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
      const d1LastClaimedEpoch =
        await contracts.delegatorsInfo.getLastClaimedEpoch(
          node1Id,
          accounts.delegator1.address,
        );

      // Verify reward was restaked (since gap is only 1 epoch)
      const actualReward = d1StakeBaseAfter - d1StakeBaseBefore;
      console.log(
        `    ✅ Actual reward for Delegator1: ${ethers.formatUnits(actualReward, 18)} TRAC`,
      );

      // TODO: Fix manual reward calculation - delegator accumulates score across multiple proof periods
      // The actual reward is higher because delegator1 earned score in both periods:
      // Period 1: 10k stake * score_per_stake_1
      // Period 2: 20k stake * (score_per_stake_2 - score_per_stake_1)
      console.log(
        `    📝 Note: Manual calculation needs to account for multi-period accumulation`,
      );
      expect(actualReward).to.equal(
        expectedReward,
        'Reward should equal expected calculation',
      );
      expect(d1LastClaimedEpoch).to.equal(
        epoch1,
        'Last claimed epoch not updated',
      );

      // Verify other delegators haven't claimed yet
      expect(
        await contracts.delegatorsInfo.getLastClaimedEpoch(
          node1Id,
          accounts.delegator2.address,
        ),
      ).to.equal(epoch1 - 1n);
      expect(
        await contracts.delegatorsInfo.getLastClaimedEpoch(
          node1Id,
          accounts.delegator3.address,
        ),
      ).to.equal(epoch1 - 1n);

      // ================================================================================================================
      // FINAL VERIFICATION: Test completed successfully
      // ================================================================================================================
      console.log(
        `\n✨ STEPS 1-7 COMPLETED SUCCESSFULLY WITH FULL VERIFICATION ✨`,
      );
      console.log(
        `📈 Final Node1 total stake: ${ethers.formatUnits(await contracts.stakingStorage.getNodeStake(node1Id), 18)} TRAC`,
      );
      console.log(
        `👤 Final Delegator1 stake: ${ethers.formatUnits(await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key), 18)} TRAC`,
      );
      console.log(
        `👤 Final Delegator2 stake: ${ethers.formatUnits(await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d2Key), 18)} TRAC`,
      );
      console.log(
        `👤 Final Delegator3 stake: ${ethers.formatUnits(await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d3Key), 18)} TRAC`,
      );

      // Key verifications completed:
      // ✅ 1. Delegators can stake on a node
      // ✅ 2. Node can submit proofs and accumulate score (with manual verification)
      // ✅ 3. Delegator scores are properly settled when additional stakes are made (with manual verification)
      // ✅ 4. Epochs can be finalized
      // ✅ 5. Delegators can claim rewards based on their proportional score (with manual verification)
      // ✅ 6. Rewards are auto-staked when epoch gap ≤ 1
      // ✅ 7. All score calculations match manual computations
    });
});
