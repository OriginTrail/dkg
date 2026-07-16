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

  describe('Suite 3: Multi-Node & Advanced Claiming', function () {


          it('3C - One delegator leaves; others proof later', async function () {
            console.log('\n👋 TEST 3C: One delegator leaves; others proof later');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: Two delegators stake
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

            const totalStakeBefore =
              await contracts.stakingStorage.getNodeStake(node1Id);
            console.log(
              `    📊 Total stake before withdrawal: ${ethers.formatUnits(totalStakeBefore, 18)} TRAC`,
            );

            // Step 2: One withdraws all
            await contracts.staking
              .connect(accounts.delegator1)
              .requestWithdrawal(node1Id, stake1);

            const totalStakeAfter =
              await contracts.stakingStorage.getNodeStake(node1Id);
            console.log(
              `    📊 Total stake after withdrawal: ${ethers.formatUnits(totalStakeAfter, 18)} TRAC`,
            );

            // Step 3: Remaining delegator proofs
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

            const nodeScorePerStakeAfterWithdrawal =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
              );

            // Settle score for remaining delegator
            await contracts.token
              .connect(accounts.delegator2)
              .approve(await contracts.staking.getAddress(), toTRAC(1));
            await contracts.staking
              .connect(accounts.delegator2)
              .stake(node1Id, toTRAC(1));

            // **DELEGATOR SCORING ASSERTIONS**
            const delegator2Score =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d2Key,
              );

            // Calculate expected score for delegator 2 with higher nodeEpochScorePerStake
            const SCALE18 = ethers.parseUnits('1', 18);
            const expectedScore =
              (stake2 * nodeScorePerStakeAfterWithdrawal) / SCALE18;

            expect(delegator2Score).to.equal(
              expectedScore,
              '**New nodeEpochScorePerStake higher ⇒ remaining delegator gets bigger Δscore**',
            );

            console.log(
              `    ✅ Node score per stake after withdrawal: ${nodeScorePerStakeAfterWithdrawal}`,
            );
            console.log(
              `    ✅ Delegator 2 score: ${delegator2Score} (expected: ${expectedScore})`,
            );
            console.log(`    ✅ Higher score per stake due to reduced total stake`);
          });


          it('3D - batchClaimDelegatorRewards', async function () {
            console.log('\n📦 TEST 3D: batchClaimDelegatorRewards');

            const startEpoch = await contracts.chronos.getCurrentEpoch();

            // Setup: Stake from two delegators
            const stake1 = toTRAC(100);
            const stake2 = toTRAC(150);

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

            // Epoch 1: Submit proof and create rewards
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .createChallenge();
            const challenge1 =
              await contracts.randomSamplingStorage.getNodeChallenge(node1Id);
            const chunks1 = kcTools.splitIntoChunks(quads, 32);
            const chunkId1 = Number(challenge1[1]);
            const { proof: proof1 } = kcTools.calculateMerkleProof(
              quads,
              32,
              chunkId1,
            );
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .submitProof(chunks1[chunkId1], proof1);

            // Advance to epoch 2
            let timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
            await time.increase(timeUntilNext + 1n);
            const epoch2 = await contracts.chronos.getCurrentEpoch();

            // Create KC to finalize epoch 1
            await createKnowledgeCollection(
              accounts.kcCreator,
              accounts.node1,
              Number(node1Id),
              receivingNodes,
              receivingNodesIdentityIds,
              { KnowledgeCollection: contracts.kc, Token: contracts.token },
              merkleRoot,
              'epoch1-rewards',
              1,
              1000,
              1,
              toTRAC(100),
            );

            // Epoch 2: Submit proof again (advance proof period first)
            await advanceToNextProofingPeriod(contracts);
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .createChallenge();
            const challenge2 =
              await contracts.randomSamplingStorage.getNodeChallenge(node1Id);
            const chunks2 = kcTools.splitIntoChunks(quads, 32);
            const chunkId2 = Number(challenge2[1]);
            const { proof: proof2 } = kcTools.calculateMerkleProof(
              quads,
              32,
              chunkId2,
            );
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .submitProof(chunks2[chunkId2], proof2);

            // Advance to epoch 3
            timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
            await time.increase(timeUntilNext + 1n);

            // Create KC to finalize epoch 2
            await createKnowledgeCollection(
              accounts.kcCreator,
              accounts.node1,
              Number(node1Id),
              receivingNodes,
              receivingNodesIdentityIds,
              { KnowledgeCollection: contracts.kc, Token: contracts.token },
              merkleRoot,
              'epoch2-rewards',
              1,
              1000,
              1,
              toTRAC(100),
            );

            // Get stake bases before claiming
            const delegator1StakeBefore =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const delegator2StakeBefore =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d2Key);

            console.log(
              `    📊 Delegator 1 stake before: ${ethers.formatUnits(delegator1StakeBefore, 18)} TRAC`,
            );
            console.log(
              `    📊 Delegator 2 stake before: ${ethers.formatUnits(delegator2StakeBefore, 18)} TRAC`,
            );

            // **DELEGATOR SCORING ASSERTIONS**
            // Step 1: Call batchClaimDelegatorRewards for both epochs and both delegators
            await contracts.staking.batchClaimDelegatorRewards(
              node1Id,
              [startEpoch, epoch2],
              [accounts.delegator1.address, accounts.delegator2.address],
            );

            const delegator1StakeAfter =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const delegator2StakeAfter =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d2Key);

            // Calculate expected rewards for verification
            const expectedReward1Epoch1 =
              await contracts.stakingKPI.getDelegatorReward(
                node1Id,
                startEpoch,
                accounts.delegator1.address,
              );
            const expectedReward1Epoch2 =
              await contracts.stakingKPI.getDelegatorReward(
                node1Id,
                epoch2,
                accounts.delegator1.address,
              );
            const expectedReward2Epoch1 =
              await contracts.stakingKPI.getDelegatorReward(
                node1Id,
                startEpoch,
                accounts.delegator2.address,
              );
            const expectedReward2Epoch2 =
              await contracts.stakingKPI.getDelegatorReward(
                node1Id,
                epoch2,
                accounts.delegator2.address,
              );

            const expectedTotalReward1 =
              expectedReward1Epoch1 + expectedReward1Epoch2;
            const expectedTotalReward2 =
              expectedReward2Epoch1 + expectedReward2Epoch2;

            expect(delegator1StakeAfter).to.equal(
              delegator1StakeBefore + expectedTotalReward1,
              '**Delegator 1 stakeBase should increase by calculated rewards**',
            );
            expect(delegator2StakeAfter).to.equal(
              delegator2StakeBefore + expectedTotalReward2,
              '**Delegator 2 stakeBase should increase by calculated rewards**',
            );

            const reward1 = delegator1StakeAfter - delegator1StakeBefore;
            const reward2 = delegator2StakeAfter - delegator2StakeBefore;

            console.log(
              `    ✅ Delegator 1 total rewards: ${ethers.formatUnits(reward1, 18)} TRAC`,
            );
            console.log(
              `    ✅ Delegator 2 total rewards: ${ethers.formatUnits(reward2, 18)} TRAC`,
            );

            // Step 2: Attempt second batch call - should revert
            await expect(
              contracts.staking.batchClaimDelegatorRewards(
                node1Id,
                [startEpoch, epoch2],
                [accounts.delegator1.address, accounts.delegator2.address],
              ),
            ).to.be.revertedWith('Already claimed all finalised epochs');

            console.log(
              `    ✅ Second batch call properly reverted with "Already claimed..."`,
            );
            console.log(
              `    ✅ Batch claiming works correctly for multiple epochs and delegators`,
            );
          });
    });
});
