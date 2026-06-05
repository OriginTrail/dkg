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

          it('4A - 20-epoch gap, then claim & restake', async function () {
            console.log('\n⏰ TEST 4A: 20-epoch gap, then claim & restake');

            const startEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: Stake and submit proof at epoch N
            const initialStake = toTRAC(200);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, initialStake);

            // Submit proof to create rewards - use direct approach due to long gap scenario
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

            console.log(`    📊 Proof submitted at epoch ${startEpoch}`);

            // Step 2: Advance to next epoch to make rewards claimable
            const timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
            await time.increase(timeUntilNext + 1n);

            // Create KC to finalize the epoch with rewards
            await createKnowledgeCollection(
              accounts.kcCreator,
              accounts.node1,
              Number(node1Id),
              receivingNodes,
              receivingNodesIdentityIds,
              { KnowledgeCollection: contracts.kc, Token: contracts.token },
              merkleRoot,
              'rewards-epoch',
              1,
              1000,
              1,
              toTRAC(1),
            );

            // Record stake before claiming to verify rewards are added
            const stakeBeforeClaim =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);

            // Claim the rewards first (required before changing stake)
            await contracts.staking
              .connect(accounts.delegator1)
              .claimDelegatorRewards(
                node1Id,
                startEpoch,
                accounts.delegator1.address,
              );

            // Verify rewards were added to stake base
            const stakeAfterClaim =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const rewardsClaimed = stakeAfterClaim - stakeBeforeClaim;

            expect(rewardsClaimed).to.be.gt(
              0n,
              '**Claimed score from N should be added to stakeBase**',
            );
            console.log(
              `    ✅ Rewards claimed and restaked: ${ethers.formatUnits(rewardsClaimed, 18)} TRAC`,
            );

            // Now withdraw all stake (including rewards)
            const allStake = stakeAfterClaim;
            await contracts.staking
              .connect(accounts.delegator1)
              .requestWithdrawal(node1Id, allStake);

            console.log(
              `    📤 Withdrew all stake: ${ethers.formatUnits(allStake, 18)} TRAC`,
            );

            // Step 3: Advance 20 epochs
            for (let i = 0; i < 20; i++) {
              const timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
              await time.increase(timeUntilNext + 1n);
              // Create KC occasionally to advance epochs properly
              if (i % 5 === 0) {
                await createKnowledgeCollection(
                  accounts.kcCreator,
                  accounts.node1,
                  Number(node1Id),
                  receivingNodes,
                  receivingNodesIdentityIds,
                  { KnowledgeCollection: contracts.kc, Token: contracts.token },
                  merkleRoot,
                  `epoch-advance-${i}`,
                  1,
                  1000,
                  1,
                  toTRAC(1),
                );
              }
            }

            const currentEpoch = await contracts.chronos.getCurrentEpoch();
            console.log(
              `    ⏭️  Advanced to epoch ${currentEpoch} (gap of ${currentEpoch - startEpoch} epochs)`,
            );

            // Step 4: Verify delegation after 20-epoch gap
            // The delegator should have zero stake after withdrawal
            const currentStakeBase =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);

            // **DELEGATOR SCORING ASSERTIONS**
            expect(currentStakeBase).to.equal(
              0n,
              'Delegator should have zero stake after withdrawal',
            );
            console.log(
              `    ✅ After 20-epoch gap, delegator stake: ${currentStakeBase} TRAC (expected: 0)`,
            );

            // Step 5: Stake again
            const newStake = toTRAC(100);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), newStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, newStake);

            // Check that new stake starts with 0 score
            const newStakeScore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );

            expect(newStakeScore).to.equal(
              0n,
              '**New stake starts with delegatorScore == 0**',
            );

            console.log(`    ✅ New stake has score: ${newStakeScore} (expected: 0)`);
            console.log(
              `    ✅ Long-term claim and restake scenario works correctly`,
            );
          });


          it('4B - Node earns while delegator zero-stake', async function () {
            console.log('\n🚫 TEST 4B: Node earns while delegator zero-stake');

            const startEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: Stake initially
            const initialStake = toTRAC(150);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, initialStake);

            // Step 2: Withdraw all stake
            await contracts.staking
              .connect(accounts.delegator1)
              .requestWithdrawal(node1Id, initialStake);

            console.log(`    📤 Withdrew all stake at epoch ${startEpoch}`);

            // Step 3: Node proofs for 3 epochs while delegator has zero stake
            const proofEpochs: bigint[] = [];

            for (let i = 0; i < 3; i++) {
              // Advance to next epoch
              const timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
              await time.increase(timeUntilNext + 1n);

              const currentEpoch = await contracts.chronos.getCurrentEpoch();
              proofEpochs.push(currentEpoch);

              // Create KC to advance epoch - make sure it exists before challenge
              await createKnowledgeCollection(
                accounts.kcCreator,
                accounts.node1,
                Number(node1Id),
                receivingNodes,
                receivingNodesIdentityIds,
                { KnowledgeCollection: contracts.kc, Token: contracts.token },
                merkleRoot,
                `zero-stake-epoch-${i}`,
                1,
                1000,
                1,
                toTRAC(1),
              );

              // Submit proof - simplified direct approach
              // skip to the next proof period
              const durationInBlocks =
                await contracts.randomSampling.getActiveProofingPeriodDurationInBlocks();
              for (let j = 0; j < durationInBlocks; j++) {
                await hre.network.provider.send('evm_mine');
              }
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

              console.log(`    📋 Node proof submitted at epoch ${currentEpoch}`);
            }

            // Step 4: Delegator stakes again
            const newStake = toTRAC(200);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), newStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, newStake);

            // **DELEGATOR SCORING ASSERTIONS**
            // Check delegator score for zero-stake epochs
            for (const epoch of proofEpochs) {
              const delegatorScore =
                await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                  epoch,
                  node1Id,
                  d1Key,
                );
              expect(delegatorScore).to.equal(
                0n,
                `**delegatorScore == 0 for zero-stake epoch ${epoch}**`,
              );
              console.log(
                `    ✅ Epoch ${epoch}: delegator score = ${delegatorScore} (zero stake)`,
              );
            }

            // Check that last-settled index was advanced properly
            const finalEpoch = proofEpochs[proofEpochs.length - 1];
            const lastSettledIndex =
              await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
                finalEpoch,
                node1Id,
                d1Key,
              );

            expect(lastSettledIndex).to.be.gt(
              0n,
              '**Last-settled index should be advanced each epoch**',
            );

            console.log(
              `    ✅ Last settled index: ${lastSettledIndex} (properly advanced)`,
            );
            console.log(`    ✅ Zero-stake epochs handled correctly`);
          });


          it('4C - Restake before claiming → revert', async function () {
            console.log('\n⛔ TEST 4C: Restake before claiming → revert');

            const startEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: Stake and submit proof to create rewards
            const initialStake = toTRAC(180);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, initialStake);

            // Submit proof - create challenge and proof directly
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

            // Step 2: Withdraw all stake
            await contracts.staking
              .connect(accounts.delegator1)
              .requestWithdrawal(node1Id, initialStake);

            // Advance to next epoch to make rewards claimable
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
              'revert-test-epoch',
              1,
              1000,
              1,
              toTRAC(1),
            );

            console.log(
              `    📤 Withdrew all stake, rewards available for epoch ${startEpoch}`,
            );

            // Step 3: Try to stake again without claiming (should revert)
            const scoreBeforeRestake =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                startEpoch,
                node1Id,
                d1Key,
              );

            const newStake = toTRAC(100);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), newStake);

            // **DELEGATOR SCORING ASSERTIONS**
            await expect(
              contracts.staking.connect(accounts.delegator1).stake(node1Id, newStake),
            ).to.be.revertedWith(
              'Must claim rewards up to the lastStakeHeldEpoch before changing stake',
            );

            const scoreAfterRevert =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                startEpoch,
                node1Id,
                d1Key,
              );

            expect(scoreAfterRevert).to.equal(
              scoreBeforeRestake,
              '**delegatorScore unchanged after revert**',
            );

            console.log(`    ✅ Transaction properly reverted: "Must claim ..."`);
            console.log(
              `    ✅ Delegator score unchanged: ${scoreBeforeRestake} → ${scoreAfterRevert}`,
            );
            console.log(`    ✅ Claim-before-restake validation works correctly`);
          });
    });
});
