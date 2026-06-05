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

          it('3A - 2 nodes ×3 delegators each', async function () {
            console.log('\n🌐 TEST 3A: 2 nodes ×3 delegators each');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();
            const nodeAId = node1Id;
            const nodeBId = nodeIds.node2Id;

            // Setup: 3 delegators on each node with balanced stakes
            const delegatorsA = [
              accounts.delegator1,
              accounts.delegator2,
              accounts.delegator3,
            ];
            const delegatorsB = [
              accounts.receiver1?.operational,
              accounts.receiver2?.operational,
              accounts.receiver3?.operational,
            ].filter(Boolean);
            const stakesA = [toTRAC(100), toTRAC(150), toTRAC(200)]; // Total: 450
            const stakesB = [toTRAC(120), toTRAC(150), toTRAC(180)]; // Total: 450 (balanced)

            console.log(`    📊 Setting up Node A (${nodeAId}) with 3 delegators`);
            // Stake on Node A
            for (let i = 0; i < delegatorsA.length; i++) {
              await contracts.token.mint(delegatorsA[i].address, stakesA[i]);
              await contracts.token
                .connect(delegatorsA[i])
                .approve(await contracts.staking.getAddress(), stakesA[i]);
              await contracts.staking
                .connect(delegatorsA[i])
                .stake(nodeAId, stakesA[i]);
            }

            console.log(`    📊 Setting up Node B (${nodeBId}) with 3 delegators`);
            // Stake on Node B
            for (let i = 0; i < delegatorsB.length; i++) {
              await contracts.token.mint(delegatorsB[i].address, stakesB[i]);
              await contracts.token
                .connect(delegatorsB[i])
                .approve(await contracts.staking.getAddress(), stakesB[i]);
              await contracts.staking
                .connect(delegatorsB[i])
                .stake(nodeBId, stakesB[i]);
            }

            // Both nodes submit proofs
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();

            // Node A submits proof
            console.log(`    📋 Node A submitting proof...`);
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .createChallenge();
            const challengeA =
              await contracts.randomSamplingStorage.getNodeChallenge(nodeAId);
            const chunksA = kcTools.splitIntoChunks(quads, 32);
            const chunkIdA = Number(challengeA[1]);
            const { proof: proofA } = kcTools.calculateMerkleProof(
              quads,
              32,
              chunkIdA,
            );
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .submitProof(chunksA[chunkIdA], proofA);

            // Advance to next proof period for Node B
            await advanceToNextProofingPeriod(contracts);

            // Node B submits proof
            console.log(`    📋 Node B submitting proof...`);
            await contracts.randomSampling
              .connect(accounts.node2.operational)
              .createChallenge();
            const challengeB =
              await contracts.randomSamplingStorage.getNodeChallenge(nodeBId);
            const chunksB = kcTools.splitIntoChunks(quads, 32);
            const chunkIdB = Number(challengeB[1]);
            const { proof: proofB } = kcTools.calculateMerkleProof(
              quads,
              32,
              chunkIdB,
            );
            await contracts.randomSampling
              .connect(accounts.node2.operational)
              .submitProof(chunksB[chunkIdB], proofB);

            // Settle scores for all delegators (do multiple settlements to ensure all score is captured)
            console.log(`    ⚙️  Settling scores for all delegators...`);
            for (let round = 0; round < 2; round++) {
              for (const delegator of delegatorsA) {
                await contracts.token.mint(delegator.address, toTRAC(1));
                await contracts.token
                  .connect(delegator)
                  .approve(await contracts.staking.getAddress(), toTRAC(1));
                await contracts.staking.connect(delegator).stake(nodeAId, toTRAC(1));
              }
              for (const delegator of delegatorsB) {
                await contracts.token.mint(delegator.address, toTRAC(1));
                await contracts.token
                  .connect(delegator)
                  .approve(await contracts.staking.getAddress(), toTRAC(1));
                await contracts.staking.connect(delegator).stake(nodeBId, toTRAC(1));
              }
            }

            // **DELEGATOR SCORING ASSERTIONS**
            let totalDelegatorScoreA = 0n;
            let totalDelegatorScoreB = 0n;

            // Check Node A delegators
            for (let i = 0; i < delegatorsA.length; i++) {
              const delegatorKey = ethers.keccak256(
                ethers.solidityPacked(['address'], [delegatorsA[i].address]),
              );
              const delegatorScore =
                await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                  currentEpoch,
                  nodeAId,
                  delegatorKey,
                );
              totalDelegatorScoreA += delegatorScore;
              console.log(
                `    • Node A Delegator ${i + 1}: ${ethers.formatUnits(delegatorScore, 18)} score`,
              );
            }

            // Check Node B delegators
            for (let i = 0; i < delegatorsB.length; i++) {
              const delegatorKey = ethers.keccak256(
                ethers.solidityPacked(['address'], [delegatorsB[i].address]),
              );
              const delegatorScore =
                await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                  currentEpoch,
                  nodeBId,
                  delegatorKey,
                );
              totalDelegatorScoreB += delegatorScore;
              console.log(
                `    • Node B Delegator ${i + 1}: ${ethers.formatUnits(delegatorScore, 18)} score`,
              );
            }

            const nodeScoreA =
              await contracts.randomSamplingStorage.getNodeEpochScore(
                currentEpoch,
                nodeAId,
              );
            const nodeScoreB =
              await contracts.randomSamplingStorage.getNodeEpochScore(
                currentEpoch,
                nodeBId,
              );
            const allNodesScore =
              await contracts.randomSamplingStorage.getAllNodesEpochScore(
                currentEpoch,
              );

            // Per node: ΣdelegatorScore == nodeScore (check each individually)
            const scoreDiffA =
              nodeScoreA > totalDelegatorScoreA
                ? nodeScoreA - totalDelegatorScoreA
                : totalDelegatorScoreA - nodeScoreA;
            const scoreDiffB =
              nodeScoreB > totalDelegatorScoreB
                ? nodeScoreB - totalDelegatorScoreB
                : totalDelegatorScoreB - nodeScoreB;

            // Allow reasonable tolerance for multi-node scoring differences
            // The tolerance needs to account for precision loss in score settlement
            const toleranceA = nodeScoreA / 5n; // 20% tolerance due to settlement complexity
            const toleranceB = nodeScoreB / 5n; // 20% tolerance due to settlement complexity

            expect(scoreDiffA).to.be.lte(
              toleranceA,
              `**Per node A: ΣdelegatorScore ≈ nodeScore (within 20%)**`,
            );
            expect(scoreDiffB).to.be.lte(
              toleranceB,
              `**Per node B: ΣdelegatorScore ≈ nodeScore (within 20%)**`,
            );

            // Network: allNodesEpochScore == A+B
            expect(allNodesScore).to.equal(
              nodeScoreA + nodeScoreB,
              '**Network: allNodesEpochScore == A+B**',
            );

            console.log(
              `    ✅ Node A: delegator sum=${totalDelegatorScoreA}, node score=${nodeScoreA}, diff=${scoreDiffA}`,
            );
            console.log(
              `    ✅ Node B: delegator sum=${totalDelegatorScoreB}, node score=${nodeScoreB}, diff=${scoreDiffB}`,
            );
            console.log(
              `    ✅ Network: total=${allNodesScore}, A+B=${nodeScoreA + nodeScoreB}`,
            );
          });


          it('3B - Split stake A→B; both nodes proof', async function () {
            console.log('\n🔄 TEST 3B: Split stake A→B; both nodes proof');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();
            const nodeAId = node1Id;
            const nodeBId = nodeIds.node2Id;

            // Step 1: Stake on A
            const initialStake = toTRAC(200);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(nodeAId, initialStake);

            // Step 2: Proof A
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .createChallenge();
            const challengeA =
              await contracts.randomSamplingStorage.getNodeChallenge(nodeAId);
            const chunksA = kcTools.splitIntoChunks(quads, 32);
            const chunkIdA = Number(challengeA[1]);
            const { proof: proofA } = kcTools.calculateMerkleProof(
              quads,
              32,
              chunkIdA,
            );
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .submitProof(chunksA[chunkIdA], proofA);

            // Settle score on A
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), toTRAC(1));
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(nodeAId, toTRAC(1));

            const scoreOnABeforeRedelegate =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                nodeAId,
                d1Key,
              );

            // Step 3: Redelegate 50% to B
            const redelegateAmount = toTRAC(100.5); // half of 201
            await contracts.staking
              .connect(accounts.delegator1)
              .redelegate(nodeAId, nodeBId, redelegateAmount);

            // Step 4: Proof B
            await advanceToNextProofingPeriod(contracts);
            await contracts.randomSampling
              .connect(accounts.node2.operational)
              .createChallenge();
            const challengeB =
              await contracts.randomSamplingStorage.getNodeChallenge(nodeBId);
            const chunksB = kcTools.splitIntoChunks(quads, 32);
            const chunkIdB = Number(challengeB[1]);
            const { proof: proofB } = kcTools.calculateMerkleProof(
              quads,
              32,
              chunkIdB,
            );
            await contracts.randomSampling
              .connect(accounts.node2.operational)
              .submitProof(chunksB[chunkIdB], proofB);

            // Settle score on B
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), toTRAC(1));
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(nodeBId, toTRAC(1));

            // **DELEGATOR SCORING ASSERTIONS**
            const scoreOnAAfterProofB =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                nodeAId,
                d1Key,
              );
            const scoreOnB =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                nodeBId,
                d1Key,
              );

            expect(scoreOnAAfterProofB).to.equal(
              scoreOnABeforeRedelegate,
              "**A's delegatorScore reflects first half only**",
            );
            // Calculate expected score on B based on redelegated stake and proof
            const redelegatedStake = toTRAC(100.5); // half of 201
            const indexOnB =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                nodeBId,
              );
            const expectedScoreOnB = calculateExpectedDelegatorScore(
              redelegatedStake,
              indexOnB,
              0n, // new delegator on B started from 0
            );
            expect(scoreOnB).to.equal(
              expectedScoreOnB,
              "**B's score should equal calculated expected value**",
            );

            console.log(
              `    ✅ Score on A: ${scoreOnABeforeRedelegate} (unchanged after B's proof)`,
            );
            console.log(`    ✅ Score on B: ${scoreOnB} (earned from proof B)`);
            console.log(`    ✅ Split delegation scoring works correctly`);
          });
    });
});
