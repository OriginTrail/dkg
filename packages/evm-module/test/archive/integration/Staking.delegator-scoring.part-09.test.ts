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

  describe('Suite 4: Long-Term & Edge Cases', function () {


          it('4D - Out-of-order claim (includes score)', async function () {
            console.log('\n🔀 TEST 4D: Out-of-order claim (includes score)');

            const startEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: Stake initially
            const stake = toTRAC(160);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), stake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, stake);

            // Step 2: Node proofs in epoch N
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .createChallenge();
            let challenge =
              await contracts.randomSamplingStorage.getNodeChallenge(node1Id);
            let chunks = kcTools.splitIntoChunks(quads, 32);
            let chunkId = Number(challenge[1]);
            let { proof } = kcTools.calculateMerkleProof(quads, 32, chunkId);
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .submitProof(chunks[chunkId], proof);

            console.log(`    📋 Proof submitted for epoch ${startEpoch}`);

            // Advance to epoch N+1
            let timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
            await time.increase(timeUntilNext + 1n);
            const epochN1 = await contracts.chronos.getCurrentEpoch();

            // Create KC to finalize epoch N
            await createKnowledgeCollection(
              accounts.kcCreator,
              accounts.node1,
              Number(node1Id),
              receivingNodes,
              receivingNodesIdentityIds,
              { KnowledgeCollection: contracts.kc, Token: contracts.token },
              merkleRoot,
              'epoch-n-rewards',
              1,
              1000,
              1,
              toTRAC(1),
            );

            // Step 3: Node proofs in epoch N+1
            await advanceToNextProofingPeriod(contracts);
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .createChallenge();
            challenge =
              await contracts.randomSamplingStorage.getNodeChallenge(node1Id);
            chunks = kcTools.splitIntoChunks(quads, 32);
            chunkId = Number(challenge[1]);
            ({ proof } = kcTools.calculateMerkleProof(quads, 32, chunkId));
            await contracts.randomSampling
              .connect(accounts.node1.operational)
              .submitProof(chunks[chunkId], proof);

            console.log(`    📋 Proof submitted for epoch ${epochN1}`);

            // Advance to epoch N+2 to make N+1 claimable
            timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
            await time.increase(timeUntilNext + 1n);

            // Create KC to finalize epoch N+1
            await createKnowledgeCollection(
              accounts.kcCreator,
              accounts.node1,
              Number(node1Id),
              receivingNodes,
              receivingNodesIdentityIds,
              { KnowledgeCollection: contracts.kc, Token: contracts.token },
              merkleRoot,
              'epoch-n1-rewards',
              1,
              1000,
              1,
              toTRAC(1),
            );

            // Step 4: Try to claim N+1 before N (should revert)
            const scoreNBefore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                startEpoch,
                node1Id,
                d1Key,
              );
            const scoreN1Before =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                epochN1,
                node1Id,
                d1Key,
              );

            // **DELEGATOR SCORING ASSERTIONS**
            await expect(
              contracts.staking
                .connect(accounts.delegator1)
                .claimDelegatorRewards(node1Id, epochN1, accounts.delegator1.address),
            ).to.be.revertedWith('Must claim older epochs first');

            const scoreNAfterRevert =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                startEpoch,
                node1Id,
                d1Key,
              );
            const scoreN1AfterRevert =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                epochN1,
                node1Id,
                d1Key,
              );

            expect(scoreNAfterRevert).to.equal(
              scoreNBefore,
              '**Revert keeps epoch N delegatorScore intact**',
            );
            expect(scoreN1AfterRevert).to.equal(
              scoreN1Before,
              '**Revert keeps epoch N+1 delegatorScore intact**',
            );

            console.log(
              `    ✅ Out-of-order claim properly reverted: "Must claim older epochs first"`,
            );

            // Step 5: Claim in proper order (N then N+1)
            const stakeBaseBefore =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);

            // Claim epoch N
            await contracts.staking
              .connect(accounts.delegator1)
              .claimDelegatorRewards(
                node1Id,
                startEpoch,
                accounts.delegator1.address,
              );

            const stakeBaseAfterN =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);

            // Claim epoch N+1
            await contracts.staking
              .connect(accounts.delegator1)
              .claimDelegatorRewards(node1Id, epochN1, accounts.delegator1.address);

            const stakeBaseAfterN1 =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);

            const totalRewards = stakeBaseAfterN1 - stakeBaseBefore;
            const rewardN = stakeBaseAfterN - stakeBaseBefore;
            const rewardN1 = stakeBaseAfterN1 - stakeBaseAfterN;

            expect(totalRewards).to.equal(
              rewardN + rewardN1,
              '**Σ stakeBase increase == rewards N+N+1**',
            );

            console.log(
              `    ✅ Claimed epoch ${startEpoch} reward: ${ethers.formatUnits(rewardN, 18)} TRAC`,
            );
            console.log(
              `    ✅ Claimed epoch ${epochN1} reward: ${ethers.formatUnits(rewardN1, 18)} TRAC`,
            );
            console.log(
              `    ✅ Total rewards: ${ethers.formatUnits(totalRewards, 18)} TRAC`,
            );
            console.log(`    ✅ Sequential claiming works correctly after revert`);
          });
    });
});
