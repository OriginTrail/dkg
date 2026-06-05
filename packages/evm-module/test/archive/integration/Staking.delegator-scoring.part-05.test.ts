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

  describe('Suite 2: Advanced Delegator Scoring', function () {


          it('2I - Stress: 10 delegators random stakes', async function () {
            console.log('\n🎯 TEST 2I: Stress test with 10 delegators');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();
            const signers = await hre.ethers.getSigners();
            const delegators = [
              accounts.delegator1,
              accounts.delegator2,
              accounts.delegator3,
              signers[51],
              signers[52],
              signers[53],
              signers[54],
              signers[55],
              signers[56],
            ];

            const stakes = [
              toTRAC(100),
              toTRAC(150),
              toTRAC(200),
              toTRAC(50),
              toTRAC(75),
              toTRAC(120),
              toTRAC(80),
              toTRAC(300),
              toTRAC(25),
            ];
            const totalDelegatorStake = stakes.reduce(
              (sum, stake) => sum + stake,
              0n,
            );
            console.log(
              `    📊 Total delegator stakes: ${ethers.formatUnits(totalDelegatorStake, 18)} TRAC`,
            );

            // Mint tokens and stake for all delegators
            for (let i = 0; i < delegators.length; i++) {
              await contracts.token.mint(delegators[i].address, stakes[i]);
              await contracts.token
                .connect(delegators[i])
                .approve(await contracts.staking.getAddress(), stakes[i]);
              await contracts.staking
                .connect(delegators[i])
                .stake(node1Id, stakes[i]);
            }

            // Add node1.operational as a delegator - from beforeEach setup
            delegators.push(accounts.node1.operational);
            stakes.push(toTRAC(100));

            // Node proof
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();

            // Submit proof manually for stress test (bypassing expected score checks)
            console.log(`    📋 Submitting proof for node ${node1Id}...`);
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .createChallenge();

            // Get the challenge details to construct proper proof
            const challenge =
              await contracts.randomSamplingStorage.getNodeChallenge(node1Id);
            const chunks = kcTools.splitIntoChunks(quads, 32);
            const chunkId = Number(challenge[1]);
            const { proof } = kcTools.calculateMerkleProof(quads, 32, chunkId);
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .submitProof(chunks[chunkId], proof);

            // await contracts.randomSampling
            //   .connect(accounts.node1.operational)
            //   .submitProof(chunk, []);

            // Settle scores for all delegators with minimal stakes
            for (const delegator of delegators) {
              await contracts.token.mint(delegator.address, toTRAC(1));
              await contracts.token
                .connect(delegator)
                .approve(await contracts.staking.getAddress(), toTRAC(1));
              await contracts.staking.connect(delegator).stake(node1Id, toTRAC(1));
            }

            // **DELEGATOR SCORING ASSERTIONS**
            const nodeScorePerStake =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
              );
            let totalDelegatorScore = 0n;
            for (let i = 0; i < delegators.length; i++) {
              const delegatorKey = ethers.keccak256(
                ethers.solidityPacked(['address'], [delegators[i].address]),
              );
              const delegatorScore =
                await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                  currentEpoch,
                  node1Id,
                  delegatorKey,
                );
              totalDelegatorScore += delegatorScore;

              const expectedRatio = (stakes[i] * 10000n) / totalDelegatorStake; // basis points
              const actualRatio = (delegatorScore * 10000n) / totalDelegatorScore;

              // Calculate expected delegator score based on their stake and the node's score per stake
              const expectedDelegatorScore = calculateExpectedDelegatorScore(
                stakes[i],
                nodeScorePerStake,
                0n, // all delegators start from 0
              );
              expect(delegatorScore).to.equal(
                expectedDelegatorScore,
                `Delegator ${i + 1} score should equal calculated value`,
              );

              console.log(
                `    • Delegator ${i + 1}: ${ethers.formatUnits(delegatorScore, 18)} score, ratio ${actualRatio}bp (expected ~${expectedRatio}bp)`,
              );
            }

            const nodeScore = await contracts.randomSamplingStorage.getNodeEpochScore(
              currentEpoch,
              node1Id,
            );
            const scoreDiff =
              nodeScore > totalDelegatorScore
                ? nodeScore - totalDelegatorScore
                : totalDelegatorScore - nodeScore;

            // Allow small tolerance for rounding differences in score calculations (RFC-26 formula precision)
            const maxToleranceWei = 10000n; // 0.00001 TRAC - accounts for precision loss in sqrt and multi-epoch calculations
            expect(scoreDiff <= maxToleranceWei).to.equal(true);

            console.log(`    ✅ Total delegator score: ${totalDelegatorScore}`);
            console.log(`    ✅ Node score: ${nodeScore}`);
            console.log(
              `    ✅ Difference: ${scoreDiff} wei (≤${maxToleranceWei} wei tolerance)`,
            );
          });


          it('2J - cancelWithdrawal() split restake', async function () {
            console.log('\n🔄 TEST 2J: cancelWithdrawal split restake');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Setup: stake and withdraw
            const initialStake = toTRAC(100);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, initialStake);

            const withdrawAmount = toTRAC(70);
            await contracts.staking
              .connect(accounts.delegator1)
              .requestWithdrawal(node1Id, withdrawAmount);

            // Set maximum stake lower to trigger split scenario
            await contracts.parametersStorage.setMaximumStake(toTRAC(150));

            const scoreBefore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );

            const stakeBaseBefore =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const nodeStakeBefore =
              await contracts.stakingStorage.getNodeStake(node1Id);

            // Cancel withdrawal (should partially restake due to max stake limit)
            await contracts.staking
              .connect(accounts.delegator1)
              .cancelWithdrawal(node1Id);

            // **DELEGATOR SCORING ASSERTIONS**
            const scoreAfter =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );

            const stakeBaseAfter =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const nodeStakeAfter =
              await contracts.stakingStorage.getNodeStake(node1Id);

            // Check withdrawal request for remaining pending amount
            const [pendingAmount, ,] =
              await contracts.stakingStorage.getDelegatorWithdrawalRequest(
                node1Id,
                d1Key,
              );

            expect(scoreAfter).to.equal(
              scoreBefore,
              '**Single new Δscore (no double count)**',
            );
            expect(stakeBaseAfter).to.be.equal(
              stakeBaseBefore + toTRAC(20),
              'Some amount should be restaked',
            );
            expect(nodeStakeAfter).to.be.equal(
              nodeStakeBefore + toTRAC(20),
              'Some amount should be restaked',
            );
            expect(pendingAmount).to.be.equal(
              withdrawAmount - toTRAC(20),
              'Some amount should remain pending',
            );

            console.log(`    ✅ Score unchanged: ${scoreBefore} → ${scoreAfter}`);
            console.log(
              `    ✅ Stake base: ${ethers.formatUnits(stakeBaseBefore, 18)} → ${ethers.formatUnits(stakeBaseAfter, 18)} TRAC`,
            );
            console.log(
              `    ✅ Pending withdrawal: ${ethers.formatUnits(pendingAmount, 18)} TRAC`,
            );
          });


          it('2K - Two proofs same epoch with stake change', async function () {
            console.log('\n🔬 TEST 2K: Two proofs same epoch with stake change');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: Stake 100
            const initialStake = toTRAC(100);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, initialStake);

            // Step 2: proof₁
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            const setupStake = toTRAC(100); // from beforeEach setup
            await submitProofAndVerifyScore(
              node1Id,
              accounts.node1,
              contracts,
              currentEpoch,
              setupStake + initialStake,
            );

            const index1 =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
              );

            // Step 3: Stake +50
            const additionalStake = toTRAC(50);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), additionalStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, additionalStake);

            // Step 4: proof₂
            await advanceToNextProofingPeriod(contracts);
            await submitProofAndVerifyScore(
              node1Id,
              accounts.node1,
              contracts,
              currentEpoch,
              setupStake + initialStake + additionalStake,
            );

            const index2 =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
              );

            // Trigger final settlement
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), toTRAC(1));
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, toTRAC(1));

            // **DELEGATOR SCORING ASSERTIONS**
            const finalScore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );

            const SCALE18 = ethers.parseUnits('1', 18);
            const delta1 = index1 - 0n; // from 0 to index1
            const delta2 = index2 - index1; // from index1 to index2
            const expectedScore =
              (initialStake * delta1) / SCALE18 +
              ((initialStake + additionalStake) * delta2) / SCALE18;

            console.log(`    🧮 Expected calculation:`);
            console.log(
              `    • 100 TRAC × ${delta1} / 1e18 = ${(initialStake * delta1) / SCALE18}`,
            );
            console.log(
              `    • 150 TRAC × ${delta2} / 1e18 = ${((initialStake + additionalStake) * delta2) / SCALE18}`,
            );
            console.log(`    • Total expected: ${expectedScore}`);
            console.log(`    • Actual score: ${finalScore}`);

            expect(finalScore).to.equal(
              expectedScore,
              '**Total score should equal 100·Δ₁ + 150·Δ₂**',
            );

            console.log(`    ✅ Two-proof calculation correct: ${finalScore}`);
          });
    });
});
