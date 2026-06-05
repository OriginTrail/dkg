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

          it('2A - Join in epoch E when score only in E-1', async function () {
            console.log('\n🕐 TEST 2A: Join in epoch E when score only in E-1');

            const startEpoch = await contracts.chronos.getCurrentEpoch();
            console.log(`    ℹ️  Starting epoch: ${startEpoch}`);

            // Step 1: Node proof in E-1 (current epoch)
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            const setupStake = toTRAC(100); // from beforeEach setup
            await submitProofAndVerifyScore(
              node1Id,
              accounts.node1,
              contracts,
              startEpoch,
              setupStake,
            );

            // Step 2: Advance to epoch E (next epoch)
            const timeUntilNext = await contracts.chronos.timeUntilNextEpoch();
            await time.increase(timeUntilNext + 1n);
            const nextEpoch = await contracts.chronos.getCurrentEpoch();
            expect(nextEpoch).to.equal(startEpoch + 1n);
            console.log(`    ⏭️  Advanced to epoch: ${nextEpoch}`);

            // Step 3: Delegator stakes in new epoch E
            const stakeAmount = toTRAC(80);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), stakeAmount);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, stakeAmount);

            // **DELEGATOR SCORING ASSERTIONS**
            const delegatorScoreInPrevEpoch =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                startEpoch, // E-1
                node1Id,
                d1Key,
              );
            expect(delegatorScoreInPrevEpoch).to.equal(
              0n,
              '**epochNodeDelegatorScore(E-1) should be 0**',
            );

            const delegatorScoreInCurrentEpoch =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                nextEpoch, // E
                node1Id,
                d1Key,
              );
            expect(delegatorScoreInCurrentEpoch).to.equal(
              0n,
              'epochNodeDelegatorScore(E) should also be 0 initially',
            );

            console.log(
              `    ✅ Delegator score in epoch ${startEpoch}: ${delegatorScoreInPrevEpoch} (expected: 0)`,
            );
            console.log(
              `    ✅ Delegator score in epoch ${nextEpoch}: ${delegatorScoreInCurrentEpoch} (expected: 0)`,
            );
          });


          it('2B - Stake→proof→withdraw→stake (three settlements)', async function () {
            console.log(
              '\n🔄 TEST 2B: Stake→proof→withdraw→stake (three settlements)',
            );

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: stake(40)
            const initialStake = toTRAC(40);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, initialStake);

            const scoreAfterStake1 =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );

            // Step 2: proof
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            const setupStake = toTRAC(100); // from beforeEach setup
            await submitProofAndVerifyScore(
              node1Id,
              accounts.node1,
              contracts,
              currentEpoch,
              setupStake + initialStake,
            );

            // Step 3: withdraw(10) - triggers first settlement
            const withdrawAmount = toTRAC(10);
            await contracts.staking
              .connect(accounts.delegator1)
              .requestWithdrawal(node1Id, withdrawAmount);

            const scoreAfterWithdraw =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            const indexAfterWithdraw =
              await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
                d1Key,
              );

            // Step 4: stake(30) - triggers second settlement
            const additionalStake = toTRAC(30);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), additionalStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, additionalStake);

            const scoreAfterStake2 =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            const indexAfterStake2 =
              await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
                d1Key,
              );

            // **DELEGATOR SCORING ASSERTIONS**
            const currentIndex =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
              );

            // Manual calculation: first settlement should give score, subsequent settlements with same index give 0 additional score
            const SCALE18 = ethers.parseUnits('1', 18);
            const expectedScoreIncrement = (initialStake * currentIndex) / SCALE18;

            console.log(`    📊 Score progression:`);
            console.log(`    • After stake(40): ${scoreAfterStake1}`);
            console.log(
              `    • After withdraw(10): ${scoreAfterWithdraw} (should have score from proof period)`,
            );
            console.log(
              `    • After stake(30): ${scoreAfterStake2} (same as withdraw, no new score)`,
            );
            console.log(`    🧮 Expected score increment: ${expectedScoreIncrement}`);

            expect(scoreAfterWithdraw).to.equal(
              expectedScoreIncrement,
              '**Sum of settlements should equal manual formula**',
            );
            expect(scoreAfterStake2).to.equal(
              scoreAfterWithdraw,
              'No additional score when index unchanged',
            );

            // Check that index was updated properly
            expect(indexAfterWithdraw).to.equal(
              currentIndex,
              'Index should be updated after withdrawal',
            );
            expect(indexAfterStake2).to.equal(
              currentIndex,
              'Index should remain current after additional stake',
            );

            console.log(
              `    ✅ Three settlements completed with correct score accumulation`,
            );
          });


          it('2C - Withdraw *all* after earning score', async function () {
            console.log('\n📤 TEST 2C: Withdraw all after earning score');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Setup: stake and earn score
            const stakeAmount = toTRAC(80);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), stakeAmount);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, stakeAmount);

            // Node proof to enable score earning
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            const setupStake = toTRAC(100); // from beforeEach setup
            await submitProofAndVerifyScore(
              node1Id,
              accounts.node1,
              contracts,
              currentEpoch,
              setupStake + stakeAmount,
            );

            // Trigger score settlement with minimal stake
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), toTRAC(1));
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, toTRAC(1));

            const scoreAfterEarning =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            console.log(`    📊 Score after earning: ${scoreAfterEarning}`);

            // Withdraw all stake
            const totalStake = await contracts.stakingStorage.getDelegatorStakeBase(
              node1Id,
              d1Key,
            );
            await contracts.staking
              .connect(accounts.delegator1)
              .requestWithdrawal(node1Id, totalStake);

            // **DELEGATOR SCORING ASSERTIONS**
            const scoreAfterWithdrawal =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            expect(scoreAfterWithdrawal).to.equal(
              scoreAfterEarning,
              '**No further score accrual after withdrawal**',
            );

            // Check lastStakeHeldEpoch
            const lastStakeHeldEpoch =
              await contracts.delegatorsInfo.getLastStakeHeldEpoch(
                node1Id,
                accounts.delegator1.address,
              );
            expect(lastStakeHeldEpoch).to.equal(
              currentEpoch,
              '**lastStakeHeldEpoch should equal current epoch**',
            );

            // Delegator should still be in the list (not removed immediately due to earned score)
            const isDelegator = await contracts.delegatorsInfo.isNodeDelegator(
              node1Id,
              accounts.delegator1.address,
            );
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            expect(isDelegator).to.equal(true);

            console.log(
              `    ✅ Score unchanged after withdrawal: ${scoreAfterWithdrawal}`,
            );
            console.log(`    ✅ Last stake held epoch: ${lastStakeHeldEpoch}`);
            console.log(`    ✅ Delegator kept in list (scored in current epoch)`);
          });


          it('2D - Withdraw *all* before any score', async function () {
            console.log('\n📤 TEST 2D: Withdraw all before any score');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: stake(50)
            const stakeAmount = toTRAC(50);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), stakeAmount);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, stakeAmount);

            // Step 2: requestWithdrawal(all) - NO proof yet
            await contracts.staking
              .connect(accounts.delegator1)
              .requestWithdrawal(node1Id, stakeAmount);

            // **DELEGATOR SCORING ASSERTIONS**
            const delegatorScore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            expect(delegatorScore).to.equal(
              0n,
              '**epochNodeDelegatorScore should be 0**',
            );

            // Delegator should be removed from node list since no score was earned
            const isDelegator = await contracts.delegatorsInfo.isNodeDelegator(
              node1Id,
              accounts.delegator1.address,
            );
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            expect(isDelegator).to.be.false;

            const stakeBase = await contracts.stakingStorage.getDelegatorStakeBase(
              node1Id,
              d1Key,
            );
            expect(stakeBase).to.equal(0n, 'Stake base should be 0');

            console.log(`    ✅ Delegator score: ${delegatorScore} (expected: 0)`);
            console.log(`    ✅ Delegator removed from node list: ${!isDelegator}`);
            console.log(
              `    ✅ Stake base: ${ethers.formatUnits(stakeBase, 18)} TRAC`,
            );
          });
    });
});
