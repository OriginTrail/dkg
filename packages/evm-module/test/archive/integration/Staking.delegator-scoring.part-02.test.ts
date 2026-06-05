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

  describe('Suite 1: Basic Delegator Scoring', function () {


          it('1D - Single-epoch reward claim & auto-restake', async function () {
            console.log('\n💰 TEST 1D: Single-epoch reward claim & auto-restake');

            const startEpoch = await contracts.chronos.getCurrentEpoch();

            // Setup: stake and earn score in startEpoch
            const initialStake = toTRAC(100);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, initialStake);

            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            const setupStake = toTRAC(100); // from beforeEach setup
            await submitProofAndVerifyScore(
              node1Id,
              accounts.node1,
              contracts,
              startEpoch,
              setupStake + initialStake,
            );

            // Trigger score settlement by doing a minimal stake operation
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), toTRAC(1));
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, toTRAC(1));

            const delegatorScoreInStartEpoch =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                startEpoch,
                node1Id,
                d1Key,
              );
            console.log(
              `    📊 Delegator score in epoch ${startEpoch}: ${delegatorScoreInStartEpoch}`,
            );

            // Advance to epoch E+1
            const timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
            await time.increase(timeUntilNext + 1n);
            const nextEpoch = await contracts.chronos.getCurrentEpoch();
            expect(nextEpoch).to.equal(startEpoch + 1n);

            // Node proof in new epoch to finalize previous epoch
            await createKnowledgeCollection(
              accounts.kcCreator,
              accounts.node1,
              Number(node1Id),
              receivingNodes,
              receivingNodesIdentityIds,
              { KnowledgeCollection: contracts.kc, Token: contracts.token },
              merkleRoot,
              'finalize-epoch',
              1,
              1000,
              1,
              toTRAC(100),
            );

            // Verify epoch is finalized
            expect(await contracts.epochStorage.lastFinalizedEpoch(1)).to.be.gte(
              startEpoch,
            );

            // Get data before claim
            const stakeBaseBefore =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const nodeScore = await contracts.randomSamplingStorage.getNodeEpochScore(
              startEpoch,
              node1Id,
            );
            const netNodeRewards = await contracts.stakingKPI.getNetNodeRewards(
              node1Id,
              startEpoch,
            );

            // Calculate expected reward
            const expectedReward =
              nodeScore === 0n
                ? 0n
                : (delegatorScoreInStartEpoch * netNodeRewards) / nodeScore;
            console.log(
              `    🧮 Expected reward: (${delegatorScoreInStartEpoch} × ${ethers.formatUnits(netNodeRewards, 18)}) / ${nodeScore} = ${ethers.formatUnits(expectedReward, 18)} TRAC`,
            );

            // Claim rewards
            await contracts.staking
              .connect(accounts.delegator1)
              .claimDelegatorRewards(
                node1Id,
                startEpoch,
                accounts.delegator1.address,
              );

            // **DELEGATOR SCORING ASSERTIONS**
            const stakeBaseAfter =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const actualReward = stakeBaseAfter - stakeBaseBefore;

            expect(actualReward).to.equal(
              expectedReward,
              '**Reward should equal delegatorScore × netNodeRewards / nodeScore**',
            );

            // Check that epochNodeDelegatorScore is now consumed (this is implicit as it's used in reward calculation)
            const delegatorScoreAfterClaim =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                startEpoch,
                node1Id,
                d1Key,
              );
            // Score should still be there (it's not reset, just used for calculation)
            expect(delegatorScoreAfterClaim).to.equal(
              delegatorScoreInStartEpoch,
              '**epochNodeDelegatorScore should remain for future reference**',
            );

            // Rolling rewards should be reset (0) since gap is only 1 epoch (auto-restake)
            const rollingRewards =
              await contracts.delegatorsInfo.getDelegatorRollingRewards(
                node1Id,
                accounts.delegator1.address,
              );
            expect(rollingRewards).to.equal(
              0n,
              '**rollingRewards should be reset to 0 (auto-restake)**',
            );

            console.log(
              `    ✅ Actual reward: ${ethers.formatUnits(actualReward, 18)} TRAC`,
            );
            console.log(
              `    ✅ Stake base increased: ${ethers.formatUnits(stakeBaseBefore, 18)} → ${ethers.formatUnits(stakeBaseAfter, 18)} TRAC`,
            );
            console.log(`    ✅ Rolling rewards reset: ${rollingRewards}`);
          });


          it('1E - New delegator joins after index>0', async function () {
            console.log('\n👤 TEST 1E: New delegator joins after index>0');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Setup: existing delegator stakes and node submits proof
            const initialStake = toTRAC(100);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, initialStake);

            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            const setupStake = toTRAC(100); // from beforeEach setup
            await submitProofAndVerifyScore(
              node1Id,
              accounts.node1,
              contracts,
              currentEpoch,
              setupStake + initialStake,
            );

            // Trigger score settlement by doing a minimal stake operation for existing delegator
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), toTRAC(1));
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, toTRAC(1));

            // Verify index > 0 after proof
            const indexAfterProof =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
              );
            expect(indexAfterProof).to.be.gt(0n, 'Index should be > 0 after proof');
            console.log(`    📊 Index after proof: ${indexAfterProof}`);

            // New delegator (delegator2) joins
            const newDelegatorStake = toTRAC(60);
            await contracts.token
              .connect(accounts.delegator2)
              .approve(await contracts.staking.getAddress(), newDelegatorStake);
            await contracts.staking
              .connect(accounts.delegator2)
              .stake(node1Id, newDelegatorStake);

            // **DELEGATOR SCORING ASSERTIONS**
            const newDelegatorScore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d2Key,
              );
            expect(newDelegatorScore).to.equal(
              0n,
              '**epochNodeDelegatorScore should be 0 for new delegator**',
            );

            // Last-settled index should be bumped to current value
            const newDelegatorLastSettled =
              await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
                d2Key,
              );
            const currentIndex =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
              );
            expect(newDelegatorLastSettled).to.equal(
              currentIndex,
              '**Last-settled index should be bumped to current value**',
            );

            // Verify stake amounts
            const newDelegatorStakeBase =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d2Key);
            expect(newDelegatorStakeBase).to.equal(
              newDelegatorStake,
              'New delegator stake base should equal stake amount',
            );

            // Verify existing delegator is unaffected
            const existingDelegatorScore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            expect(existingDelegatorScore).to.be.gt(
              0n,
              'Existing delegator should still have score',
            );

            console.log(
              `    ✅ New delegator score: ${newDelegatorScore} (expected: 0)`,
            );
            console.log(
              `    ✅ New delegator last settled index: ${newDelegatorLastSettled}`,
            );
            console.log(`    ✅ Current index: ${currentIndex}`);
            console.log(
              `    ✅ New delegator stake base: ${ethers.formatUnits(newDelegatorStakeBase, 18)} TRAC`,
            );
            console.log(
              `    ✅ Existing delegator score unchanged: ${existingDelegatorScore}`,
            );
          });
    });
});
