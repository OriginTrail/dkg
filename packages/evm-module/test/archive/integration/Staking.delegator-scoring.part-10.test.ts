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

describe.skip(`Delegator Scoring (OBSOLETE: V8 rewards pipeline)`, function () {

    let accounts: TestAccounts;

    let contracts: TestContracts;

    let nodeIds: { node1Id: bigint; node2Id: bigint };

    let node1Id: bigint;

    let d1Key: string, d2Key: string;

    let epoch1: bigint;
   // eslint-disable-line @typescript-eslint/no-unused-vars
    let receivingNodes: {
      operational: SignerWithAddress;
      admin: SignerWithAddress;
    }[];

    let receivingNodesIdentityIds: number[];


    beforeEach(async function () {
      // Setup test environment
      const setup = await setupTestEnvironment();
      accounts = setup.accounts;
      contracts = setup.contracts;
      nodeIds = setup.nodeIds;
      node1Id = nodeIds.node1Id;

      epoch1 = await contracts.chronos.getCurrentEpoch();

      // Create delegator keys for state verification
      d1Key = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator1.address]),
      );
      d2Key = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator2.address]),
      );

      // Setup receiving nodes for KC creation
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

      // Initialize ask system properly to prevent division by zero
      // Stake some tokens to node1 to make it eligible for ask setting
      await contracts.token
        .connect(accounts.node1.operational)
        .approve(await contracts.staking.getAddress(), toTRAC(100));
      await contracts.staking
        .connect(accounts.node1.operational)
        .stake(node1Id, toTRAC(100));

      // Set ask price to establish bounds
      const nodeAsk = ethers.parseUnits('0.1', 18);
      await contracts.profile
        .connect(accounts.node1.operational)
        .updateAsk(node1Id, nodeAsk);
      await contracts.ask.connect(accounts.owner).recalculateActiveSet();

      // Create knowledge collection for reward pool
      const kcTokenAmount = toTRAC(10_000);
      const numberOfEpochs = 5;
      await createKnowledgeCollection(
        accounts.kcCreator,
        accounts.node1,
        Number(node1Id),
        receivingNodes,
        receivingNodesIdentityIds,
        { KnowledgeCollection: contracts.kc, Token: contracts.token },
        merkleRoot,
        'delegator-scoring-test',
        10,
        1000,
        numberOfEpochs,
        kcTokenAmount,
      );
    });

  describe('Suite 5: Rolling Rewards & Fee Mechanics', function () {

          it('5A - Rolling rewards across 3 epochs', async function () {
            console.log('\n🔄 TEST 5A: Rolling rewards across 3 epochs');
            // Step 1: Stake initially
            const stake = toTRAC(150);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), stake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, stake);

            const epochs: bigint[] = [];

            // Step 2: Submit proofs for epochs 1-3
            for (let i = 0; i < 3; i++) {
              const currentEpoch = await contracts.chronos.getCurrentEpoch();
              epochs.push(currentEpoch);

              // Submit proof for current epoch - advance proofing period first
              await advanceToNextProofingPeriod(contracts);
              await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
              await contracts.randomSampling
                .connect(accounts.node1.operational)
                .createChallenge();
              const challenge =
                await contracts.randomSamplingStorage.getNodeChallenge(node1Id);
              const chunks = kcTools.splitIntoChunks(quads, 32);
              const chunkId = Number(challenge[1]);
              const { proof } = kcTools.calculateMerkleProof(quads, 32, chunkId);
              await contracts.randomSampling
                .connect(accounts.node1.operational)
                .submitProof(chunks[chunkId], proof);

              console.log(`    📋 Proof submitted for epoch ${currentEpoch}`);

              // Advance to next epoch (except for last iteration)
              if (i < 2) {
                const timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
                await time.increase(timeUntilNext + 1n);

                // Create KC to finalize the epoch
                await createKnowledgeCollection(
                  accounts.kcCreator,
                  accounts.node1,
                  Number(node1Id),
                  receivingNodes,
                  receivingNodesIdentityIds,
                  { KnowledgeCollection: contracts.kc, Token: contracts.token },
                  merkleRoot,
                  `rolling-epoch-${i}`,
                  1,
                  1000,
                  1,
                  toTRAC(1),
                );
              }
            }

            // Advance to make epoch 3 claimable
            const timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
            await time.increase(timeUntilNext + 1n);
            await createKnowledgeCollection(
              accounts.kcCreator,
              accounts.node1,
              Number(node1Id),
              receivingNodes,
              receivingNodesIdentityIds,
              { KnowledgeCollection: contracts.kc, Token: contracts.token },
              merkleRoot,
              'rolling-final',
              1,
              1000,
              1,
              toTRAC(1),
            );

            console.log(`    ✅ Proofs completed for epochs: ${epochs.join(', ')}`);

            // Step 3: Claim epoch 1 only
            const stakeBaseBefore =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);

            await contracts.staking
              .connect(accounts.delegator1)
              .claimDelegatorRewards(node1Id, epochs[0], accounts.delegator1.address);

            const stakeBaseAfterFirst =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const rollingAfterFirst =
              await contracts.delegatorsInfo.getDelegatorRollingRewards(
                node1Id,
                accounts.delegator1.address,
              );

            const expectedReward1 = await contracts.stakingKPI.getDelegatorReward(
              node1Id,
              epochs[0],
              accounts.delegator1.address,
            );

            // **DELEGATOR SCORING ASSERTIONS**
            expect(rollingAfterFirst).to.equal(
              expectedReward1,
              '**After first claim: rollingRewards == expectedReward₁**',
            );
            expect(stakeBaseAfterFirst).to.equal(
              stakeBaseBefore,
              'StakeBase should not increase yet (rolling rewards)',
            );

            console.log(
              `    ✅ Epoch ${epochs[0]} claimed: ${ethers.formatUnits(expectedReward1, 18)} TRAC (rolling)`,
            );
            console.log(
              `    ✅ Rolling rewards: ${ethers.formatUnits(rollingAfterFirst, 18)} TRAC`,
            );

            // Step 4: Claim epoch 3 (auto restake path - skipping epoch 2)
            await contracts.staking
              .connect(accounts.delegator1)
              .claimDelegatorRewards(node1Id, epochs[1], accounts.delegator1.address);

            // Now claim epoch 3 which should trigger auto-restake
            await contracts.staking
              .connect(accounts.delegator1)
              .claimDelegatorRewards(node1Id, epochs[2], accounts.delegator1.address);

            const stakeBaseFinal =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const rollingFinal =
              await contracts.delegatorsInfo.getDelegatorRollingRewards(
                node1Id,
                accounts.delegator1.address,
              );

            const totalRewards = stakeBaseFinal - stakeBaseBefore;

            // Calculate expected total rewards for all 3 epochs
            const expectedReward2 = await contracts.stakingKPI.getDelegatorReward(
              node1Id,
              epochs[1],
              accounts.delegator1.address,
            );
            const expectedReward3 = await contracts.stakingKPI.getDelegatorReward(
              node1Id,
              epochs[2],
              accounts.delegator1.address,
            );
            const expectedTotalRewards =
              expectedReward1 + expectedReward2 + expectedReward3;

            // **DELEGATOR SCORING ASSERTIONS**
            expect(rollingFinal).to.equal(
              0n,
              '**After final claim: rollingRewards == 0**',
            );
            expect(totalRewards).to.equal(
              expectedTotalRewards,
              '**stakeBase should increase by sum of all epoch rewards**',
            );

            console.log(
              `    ✅ Final stake base: ${ethers.formatUnits(stakeBaseFinal, 18)} TRAC`,
            );
            console.log(
              `    ✅ Total rewards claimed: ${ethers.formatUnits(totalRewards, 18)} TRAC`,
            );
            console.log(`    ✅ Rolling rewards reset: ${rollingFinal} TRAC`);
            console.log(`    ✅ Rolling rewards mechanism works correctly`);
          });


          it('5B - Operator-fee split, 2 delegators', async function () {
            console.log('\n💰 TEST 5B: Operator-fee split, 2 delegators');
            // Step 1: Set operator fee to 5%
            const operatorFeePercentage = 5;
            await contracts.profileStorage.addOperatorFee(
              node1Id,
              operatorFeePercentage * 100,
              (await contracts.chronos.getCurrentEpoch()) + 1n,
            );
            console.log(`    📊 Using operator fee: ${operatorFeePercentage}%`);

            // Skip to the next epoch for new operator fee to take effect
            await time.increase((await contracts.chronos.timeUntilNextEpoch()) + 1n);

            const startEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 2: Two delegators stake
            const stake1 = toTRAC(100);
            const stake2 = toTRAC(200);

            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), stake1);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, stake1);

            await contracts.token
              .connect(accounts.delegator2)
              .approve(await contracts.staking.getAddress(), stake2);
            await contracts.staking
              .connect(accounts.delegator2)
              .stake(node1Id, stake2);

            console.log(
              `    👥 Delegator1 staked: ${ethers.formatUnits(stake1, 18)} TRAC`,
            );
            console.log(
              `    👥 Delegator2 staked: ${ethers.formatUnits(stake2, 18)} TRAC`,
            );

            // Step 3: Submit proof to generate rewards
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .createChallenge();
            const challenge =
              await contracts.randomSamplingStorage.getNodeChallenge(node1Id);
            const chunks = kcTools.splitIntoChunks(quads, 32);
            const chunkId = Number(challenge[1]);
            const { proof } = kcTools.calculateMerkleProof(quads, 32, chunkId);
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .submitProof(chunks[chunkId], proof);

            console.log(`    📋 Proof submitted for epoch ${startEpoch}`);

            // Step 4: Advance to next epoch to make rewards claimable
            const timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
            await time.increase(timeUntilNext + 1n);
            await createKnowledgeCollection(
              accounts.kcCreator,
              accounts.node1,
              Number(node1Id),
              receivingNodes,
              receivingNodesIdentityIds,
              { KnowledgeCollection: contracts.kc, Token: contracts.token },
              merkleRoot,
              'fee-split-epoch',
              1,
              1000,
              1,
              toTRAC(1),
            );

            // Step 5: Record operator fee balance before claims
            const operatorFeeBalanceBefore =
              await contracts.stakingStorage.getOperatorFeeBalance(node1Id);

            // Step 6: Both delegators claim
            const d1StakeBefore =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const d2StakeBefore =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d2Key);

            await contracts.staking
              .connect(accounts.delegator1)
              .claimDelegatorRewards(
                node1Id,
                startEpoch,
                accounts.delegator1.address,
              );

            await contracts.staking
              .connect(accounts.delegator2)
              .claimDelegatorRewards(
                node1Id,
                startEpoch,
                accounts.delegator2.address,
              );

            const d1StakeAfter = await contracts.stakingStorage.getDelegatorStakeBase(
              node1Id,
              d1Key,
            );
            const d2StakeAfter = await contracts.stakingStorage.getDelegatorStakeBase(
              node1Id,
              d2Key,
            );

            const operatorFeeBalanceAfter =
              await contracts.stakingStorage.getOperatorFeeBalance(node1Id);

            const delegator1Rewards = d1StakeAfter - d1StakeBefore;
            const delegator2Rewards = d2StakeAfter - d2StakeBefore;
            const nodeOperatorRewards = await contracts.stakingKPI.getDelegatorReward(
              node1Id,
              startEpoch,
              accounts.node1.operational.address,
            );
            const operatorFeeEarned =
              operatorFeeBalanceAfter - operatorFeeBalanceBefore;

            // Calculate expected gross rewards (before operator fee)
            const totalDelegatorRewards =
              delegator1Rewards + delegator2Rewards + nodeOperatorRewards;
            const grossRewards = totalDelegatorRewards + operatorFeeEarned;

            const expectedNetNodeRewards =
              await contracts.stakingKPI.getNetNodeRewards(node1Id, startEpoch);

            // Allow small tolerance for rounding differences in reward calculations.
            // The multiplicative score formula S*(c + 0.86*P + 0.60*A*P) introduces an
            // additional division step, increasing cumulative rounding error.
            const rewardsDiff =
              expectedNetNodeRewards > totalDelegatorRewards
                ? expectedNetNodeRewards - totalDelegatorRewards
                : totalDelegatorRewards - expectedNetNodeRewards;
            const maxRewardToleranceWei = 1000000000000n; // 0.000001 TRAC - accounts for precision loss
            expect(rewardsDiff <= maxRewardToleranceWei).to.equal(true);

            // **DELEGATOR SCORING ASSERTIONS**
            // Allow small tolerance for rounding differences
            const grossDiff =
              expectedNetNodeRewards + operatorFeeEarned > grossRewards
                ? expectedNetNodeRewards + operatorFeeEarned - grossRewards
                : grossRewards - (expectedNetNodeRewards + operatorFeeEarned);
            expect(grossDiff <= maxRewardToleranceWei).to.equal(true);

            const expectedOperatorFee =
              (grossRewards * BigInt(operatorFeePercentage * 100)) / 10_000n;
            const operatorFeeDiff =
              operatorFeeEarned > expectedOperatorFee
                ? operatorFeeEarned - expectedOperatorFee
                : expectedOperatorFee - operatorFeeEarned;
            expect(operatorFeeDiff <= maxRewardToleranceWei).to.equal(true);

            // Calculate expected rewards based on stake proportions
            const expectedDelegator1Reward =
              await contracts.stakingKPI.getDelegatorReward(
                node1Id,
                startEpoch,
                accounts.delegator1.address,
              );
            const expectedDelegator2Reward =
              await contracts.stakingKPI.getDelegatorReward(
                node1Id,
                startEpoch,
                accounts.delegator2.address,
              );

            expect(delegator1Rewards).to.equal(
              expectedDelegator1Reward,
              'Delegator1 rewards should equal calculated value',
            );
            expect(delegator2Rewards).to.equal(
              expectedDelegator2Reward,
              'Delegator2 rewards should equal calculated value',
            );

            console.log(
              `    ✅ Delegator1 rewards: ${ethers.formatUnits(delegator1Rewards, 18)} TRAC`,
            );
            console.log(
              `    ✅ Delegator2 rewards: ${ethers.formatUnits(delegator2Rewards, 18)} TRAC`,
            );
            console.log(
              `    ✅ Operator fee earned: ${ethers.formatUnits(operatorFeeEarned, 18)} TRAC`,
            );
            console.log(
              `    ✅ Gross rewards: ${ethers.formatUnits(grossRewards, 18)} TRAC`,
            );
            const actualRatio = (delegator2Rewards * 100n) / delegator1Rewards;
            console.log(
              `    ✅ Reward ratio D2/D1: ${actualRatio}% (expected ~200%)`,
            );
            console.log(`    ✅ Operator fee distribution works correctly`);
          });
    });
});
