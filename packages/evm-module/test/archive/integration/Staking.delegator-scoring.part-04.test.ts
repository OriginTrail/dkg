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


          it('2E - Redelegate half A→B mid-epoch', async function () {
            console.log('\n🔄 TEST 2E: Redelegate half A→B mid-epoch');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();
            const nodeAId = node1Id;
            const nodeBId = nodeIds.node2Id;

            // Setup: delegator stakes to node A
            const initialStake = toTRAC(100);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(nodeAId, initialStake);

            // Proof on node A
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            const setupStake = toTRAC(100); // from beforeEach setup
            await submitProofAndVerifyScore(
              nodeAId,
              accounts.node1,
              contracts,
              currentEpoch,
              setupStake + initialStake,
            );

            // Trigger score settlement on A by minimal stake
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

            // Redelegate half to node B
            const redelegateAmount = toTRAC(50.5); // half of 101
            await contracts.staking
              .connect(accounts.delegator1)
              .redelegate(nodeAId, nodeBId, redelegateAmount);

            // **DELEGATOR SCORING ASSERTIONS**
            const scoreOnAAfterRedelegate =
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

            expect(scoreOnAAfterRedelegate).to.equal(
              scoreOnABeforeRedelegate,
              '**Score should remain on A side**',
            );
            expect(scoreOnB).to.equal(
              0n,
              '**epochNodeDelegatorScore(B) should be 0**',
            );

            // B's last-settled index should equal A's at moment of move
            const lastSettledIndexOnB =
              await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
                currentEpoch,
                nodeBId,
                d1Key,
              );
            const currentIndexOnB =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                nodeBId,
              );

            expect(lastSettledIndexOnB).to.equal(
              currentIndexOnB,
              "**B's last-settled index should be current**",
            );

            console.log(`    ✅ Score on A: ${scoreOnAAfterRedelegate} (unchanged)`);
            console.log(`    ✅ Score on B: ${scoreOnB} (expected: 0)`);
            console.log(`    ✅ B's settled index: ${lastSettledIndexOnB}`);
          });


          it('2F - restakeOperatorFee', async function () {
            console.log('\n💰 TEST 2F: restakeOperatorFee');
            // Setup: Manually set some operator fee for testing (avoiding complex reward claiming setup)
            const restakeAmount = toTRAC(20);
            await contracts.stakingStorage
              .connect(accounts.owner)
              .setOperatorFeeBalance(node1Id, restakeAmount);

            const operatorFeeBalanceBefore =
              await contracts.stakingStorage.getOperatorFeeBalance(node1Id);
            console.log(
              `    💰 Operator fee balance set: ${ethers.formatUnits(operatorFeeBalanceBefore, 18)} TRAC`,
            );

            // Admin restakes operator fee
            await contracts.staking
              .connect(accounts.node1.admin)
              .restakeOperatorFee(node1Id, restakeAmount);

            // **DELEGATOR SCORING ASSERTIONS**
            const operatorFeeBalanceAfter =
              await contracts.stakingStorage.getOperatorFeeBalance(node1Id);
            const adminStakeBase =
              await contracts.stakingStorage.getDelegatorStakeBase(
                node1Id,
                ethers.keccak256(
                  ethers.solidityPacked(['address'], [accounts.node1.admin.address]),
                ),
              );

            expect(operatorFeeBalanceAfter).to.equal(
              0n,
              '**Fee balance should be depleted**',
            );
            expect(adminStakeBase).to.equal(
              restakeAmount,
              '**Admin stake base should equal restaked amount**',
            );

            console.log(
              `    ✅ Fee balance: ${ethers.formatUnits(operatorFeeBalanceBefore, 18)} → ${ethers.formatUnits(operatorFeeBalanceAfter, 18)} TRAC`,
            );
            console.log(
              `    ✅ Admin stake base: ${ethers.formatUnits(adminStakeBase, 18)} TRAC`,
            );
          });


          it('2G - Early-exit path (Δindex = 0)', async function () {
            console.log('\n⚡ TEST 2G: Early-exit path (Δindex = 0)');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Setup: stake and establish some score
            const stakeAmount = toTRAC(100);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), stakeAmount);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, stakeAmount);

            // Submit proof to establish non-zero index
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            const setupStake = toTRAC(100); // from beforeEach setup
            await submitProofAndVerifyScore(
              node1Id,
              accounts.node1,
              contracts,
              currentEpoch,
              setupStake + stakeAmount,
            );

            // Trigger settlement once
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), toTRAC(1));
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, toTRAC(1));

            const scoreBefore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );

            // Call stake change path again with no new proofs (Δindex = 0)
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), toTRAC(1));
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, toTRAC(1));

            // **DELEGATOR SCORING ASSERTIONS**
            const scoreAfter =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );

            expect(scoreAfter).to.equal(
              scoreBefore,
              '**Delegator score should be identical pre-/post-call**',
            );

            console.log(`    ✅ Score before: ${scoreBefore}`);
            console.log(`    ✅ Score after: ${scoreAfter} (identical)`);
            console.log(
              `    ✅ Early-exit path correctly prevents unnecessary computation`,
            );
          });


          it('2H - Proof after stake→withdrawAll', async function () {
            console.log('\n🔬 TEST 2H: Proof after stake→withdrawAll');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: stake(40)
            const stakeAmount = toTRAC(40);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), stakeAmount);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, stakeAmount);

            // Step 2: withdrawAll
            await contracts.staking
              .connect(accounts.delegator1)
              .requestWithdrawal(node1Id, stakeAmount);

            const scoreBeforeProof =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            const lastSettledBefore =
              await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
                d1Key,
              );

            // Step 3: Node proof (delegator has zero stake)
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            const setupStake = toTRAC(100); // from beforeEach setup
            await submitProofAndVerifyScore(
              node1Id,
              accounts.node1,
              contracts,
              currentEpoch,
              setupStake, // only setup stake, delegator withdrew
            );

            // Trigger settlement for delegator by small stake operation
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), toTRAC(1));
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, toTRAC(1));

            const scoreAfterProof =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            const lastSettledAfter =
              await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
                d1Key,
              );
            const currentIndex =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
              );

            // **DELEGATOR SCORING ASSERTIONS**
            expect(scoreAfterProof).to.equal(
              scoreBeforeProof,
              '**No score added (zero stake)**',
            );
            expect(lastSettledAfter).to.equal(
              currentIndex,
              '**Last-settled index should be bumped**',
            );

            console.log(
              `    ✅ Score unchanged: ${scoreBeforeProof} → ${scoreAfterProof}`,
            );
            console.log(
              `    ✅ Last settled index: ${lastSettledBefore} → ${lastSettledAfter}`,
            );
            console.log(`    ✅ Index bumped despite zero stake`);
          });
    });
});
