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

          it('1A - First-time stake (no node score yet)', async function () {
            console.log('\n📊 TEST 1A: First-time stake (no node score yet)');

            // Fresh epoch, no proofs yet
            const currentEpoch = await contracts.chronos.getCurrentEpoch();
            console.log(`    ℹ️  Current epoch: ${currentEpoch}`);

            // Verify no node score exists yet
            const nodeScoreBefore =
              await contracts.randomSamplingStorage.getNodeEpochScore(
                currentEpoch,
                node1Id,
              );
            expect(nodeScoreBefore).to.equal(
              0n,
              'Node should have no score initially',
            );

            // Delegator1 stakes 100 TRAC
            const stakeAmount = toTRAC(100);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), stakeAmount);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, stakeAmount);

            // **DELEGATOR SCORING ASSERTIONS**
            const delegatorScore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            expect(delegatorScore).to.equal(
              0n,
              '**epochNodeDelegatorScore should be 0 (no proofs yet)**',
            );

            const lastSettledIndex =
              await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
                d1Key,
              );
            expect(lastSettledIndex).to.equal(
              0n,
              'Last settled index should be 0 initially',
            );

            // Verify stake amounts (account for setup stake from node1.operational + delegator stake)
            const delegatorStakeBase =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            const nodeStake = await contracts.stakingStorage.getNodeStake(node1Id);
            const totalStake = await contracts.stakingStorage.getTotalStake();
            const setupStake = toTRAC(100); // from beforeEach setup
            const expectedNodeStake = setupStake + stakeAmount;

            expect(delegatorStakeBase).to.equal(
              stakeAmount,
              'stakeBase should equal delegator stake amount',
            );
            expect(nodeStake).to.equal(
              expectedNodeStake,
              'node stake should equal setup stake + delegator stake',
            );
            expect(totalStake).to.equal(
              expectedNodeStake,
              'total stake should equal node stake',
            );

            console.log(`    ✅ Delegator score: ${delegatorScore} (expected: 0)`);
            console.log(
              `    ✅ Stake base: ${ethers.formatUnits(delegatorStakeBase, 18)} TRAC`,
            );
            console.log(
              `    ✅ Node stake: ${ethers.formatUnits(nodeStake, 18)} TRAC`,
            );
          });


          it('1B - Proof, then same delegator stakes more', async function () {
            console.log('\n🔬 TEST 1B: Proof, then same delegator stakes more');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Step 1: Initial stake
            const initialStake = toTRAC(100);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), initialStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, initialStake);

            // Step 2: Node submits proof - Record index₀
            await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
            const setupStake = toTRAC(100); // from beforeEach setup
            const totalStakeForScore = setupStake + initialStake;
            const { nodeScorePerStake: index0 } = await submitProofAndVerifyScore(
              node1Id,
              accounts.node1,
              contracts,
              currentEpoch,
              totalStakeForScore,
            );
            console.log(`    📋 Recorded index₀: ${index0}`);

            // Step 3: Delegator stakes more - Record index₁
            const additionalStake = toTRAC(50);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), additionalStake);

            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, additionalStake);

            const index1 =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
              );
            console.log(`    📋 Recorded nodeScorePerStake: ${index1}`);

            // **DELEGATOR SCORING ASSERTIONS**
            const SCALE18 = ethers.parseUnits('1', 18);
            const expectedDeltaScore =
              (initialStake * (index1 - BigInt(0))) / SCALE18; // index₀ was 0 when delegator first staked
            const actualDelegatorScore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );

            console.log(
              `    🧮 Expected Δscore: 100 TRAC × (${index1} - 0) / 1e18 = ${expectedDeltaScore}`,
            );
            console.log(`    🧮 Actual delegator score: ${actualDelegatorScore}`);

            expect(actualDelegatorScore).to.equal(
              expectedDeltaScore,
              '**Δscore should equal 100 · (index₁−index₀)/1e18**',
            );

            // Last-settled index should be updated to current index
            const lastSettledIndex =
              await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
                d1Key,
              );
            expect(lastSettledIndex).to.equal(
              index1,
              '**Last-settled index should equal index₁**',
            );

            // Stake base should be 150 TRAC
            const finalStakeBase =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            expect(finalStakeBase).to.equal(
              initialStake + additionalStake,
              '**stakeBase should be 150 TRAC**',
            );

            console.log(
              `    ✅ Delegator score correctly calculated: ${actualDelegatorScore}`,
            );
            console.log(`    ✅ Last settled index: ${lastSettledIndex}`);
            console.log(
              `    ✅ Final stake base: ${ethers.formatUnits(finalStakeBase, 18)} TRAC`,
            );
          });


          it('1C - Partial withdrawal mid-epoch', async function () {
            console.log('\n📤 TEST 1C: Partial withdrawal mid-epoch');

            const currentEpoch = await contracts.chronos.getCurrentEpoch();

            // Setup from 1B: stake 100, proof, stake +50
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

            const additionalStake = toTRAC(50);
            await contracts.token
              .connect(accounts.delegator1)
              .approve(await contracts.staking.getAddress(), additionalStake);
            await contracts.staking
              .connect(accounts.delegator1)
              .stake(node1Id, additionalStake);

            // Record state before withdrawal
            const delegatorScoreBefore =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            const lastSettledIndexBefore =
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

            console.log(`    📊 Score before withdrawal: ${delegatorScoreBefore}`);
            console.log(
              `    📊 Last settled index before: ${lastSettledIndexBefore}`,
            );
            console.log(`    📊 Current index: ${currentIndex}`);

            // Partial withdrawal of 25 TRAC
            const withdrawalAmount = toTRAC(25);
            await contracts.staking
              .connect(accounts.delegator1)
              .requestWithdrawal(node1Id, withdrawalAmount);

            // **DELEGATOR SCORING ASSERTIONS**
            const delegatorScoreAfter =
              await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
                currentEpoch,
                node1Id,
                d1Key,
              );
            const lastSettledIndexAfter =
              await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
                d1Key,
              );
            const currentIndexAfter =
              await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
                currentEpoch,
                node1Id,
              );

            // Score should be unchanged from before withdrawal
            expect(delegatorScoreAfter).to.equal(
              delegatorScoreBefore,
              '**Delegator score should be unchanged**',
            );

            // Last-settled index should be updated to current index
            expect(lastSettledIndexAfter).to.equal(
              currentIndexAfter,
              '**Last-settled index should equal current index**',
            );

            // Stake base should be 125 TRAC (150 - 25)
            const finalStakeBase =
              await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
            expect(finalStakeBase).to.equal(
              toTRAC(125),
              '**stakeBase should be 125 TRAC**',
            );

            console.log(`    ✅ Delegator score unchanged: ${delegatorScoreAfter}`);
            console.log(
              `    ✅ Last settled index updated: ${lastSettledIndexAfter}`,
            );
            console.log(
              `    ✅ Final stake base: ${ethers.formatUnits(finalStakeBase, 18)} TRAC`,
            );
          });
    });
});
