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

describe.skip(`Full complex scenario (OBSOLETE: V8 rewards pipeline)`, function () {

    let accounts: TestAccounts;

    let contracts: TestContracts;

    let nodeIds: { node1Id: bigint; node2Id: bigint };

    let node1Id: bigint;

    let d1Key: string, d2Key: string, d3Key: string;

    let epoch1: bigint;

    let receivingNodes: {
      operational: SignerWithAddress;
      admin: SignerWithAddress;
    }[];

    let receivingNodesIdentityIds: number[];

    let TOKEN_DECIMALS = 18;

    let chunkSize: number;


    /******************************************************************************************
     *  Steps 8 → 14 (continues from the chain state left after Step 7)                       *
     ******************************************************************************************/

    it('Should execute steps 8-14 with detailed score calculations and verification', async function () {
      /* Epoch markers */
      const currentEpoch = await contracts.chronos.getCurrentEpoch(); // == 2
      const previousEpoch = currentEpoch - 1n; // == 1

      /**********************************************************************
       * STEP 8 – Delegator2 claims rewards for previousEpoch               *
       **********************************************************************/
      console.log(
        `\n💰 STEP 8: Delegator2 claims rewards for epoch ${previousEpoch}`,
      );

      const d2BaseBefore = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d2Key,
      );

      const nodeScorePrev =
        await contracts.randomSamplingStorage.getNodeEpochScore(
          previousEpoch,
          node1Id,
        );
      const netRewardsPrev = await contracts.stakingKPI.getNetNodeRewards(
        node1Id,
        previousEpoch,
      );

      await contracts.staking
        .connect(accounts.delegator2)
        .claimDelegatorRewards(
          node1Id,
          previousEpoch,
          accounts.delegator2.address,
        );

      const d2ScorePrev =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          previousEpoch,
          node1Id,
          d2Key,
        );
      const d2ExpectedReward = (d2ScorePrev * netRewardsPrev) / nodeScorePrev;

      const d2BaseAfter = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d2Key,
      );
      const d2ActualReward = d2BaseAfter - d2BaseBefore;

      console.log(
        `    ✅ D2 staked reward ${ethers.formatUnits(d2ActualReward, 18)} TRAC (expected ${ethers.formatUnits(
          d2ExpectedReward,
          18,
        )})`,
      );
      expect(d2ActualReward).to.equal(d2ExpectedReward);

      const expectedDelegatorRewards =
        await contracts.stakingKPI.getDelegatorReward(
          node1Id,
          previousEpoch,
          accounts.delegator2.address,
        );
      console.log(
        `    ✅ Expected delegator rewards from StakingKPI: ${ethers.formatUnits(expectedDelegatorRewards, 18)} TRAC`,
      );
      expect(d2ActualReward).to.equal(expectedDelegatorRewards);

      await epochRewardsPoolPrecisionLoss(
        contracts,
        previousEpoch,
        netRewardsPrev,
        (await contracts.stakingKPI.getDelegatorReward(
          node1Id,
          previousEpoch,
          accounts.delegator1.address,
        )) +
          d2ActualReward +
          (await contracts.stakingKPI.getDelegatorReward(
            node1Id,
            previousEpoch,
            accounts.delegator3.address,
          )),
      );

      /**********************************************************************
       * STEP 9 – Delegator3 attempts withdrawal before claim → revert       *
       **********************************************************************/
      console.log(
        '\n⛔  STEP 9: Delegator3 withdrawal should revert because they did not claim rewards for all previous epochs',
      );

      await expect(
        contracts.staking
          .connect(accounts.delegator3)
          .requestWithdrawal(node1Id, ethers.parseUnits('5000', 18)),
      ).to.be.revertedWith(
        'Must claim the previous epoch rewards before changing stake',
      );
      console.log('    ✅ revert received as expected');

      /**********************************************************************
       * STEP 10 – Node1 submits first proof in currentEpoch                *
       **********************************************************************/
      console.log(
        `\n🔬 STEP 10: Node1 submits first proof in epoch ${currentEpoch}`,
      );

      /* move to the next proof-period so the challenge is fresh */
      await advanceToNextProofingPeriod(contracts);

      /* --- BEFORE snapshot ------------------------------------------------ */
      const stakeBeforeProof =
        await contracts.stakingStorage.getNodeStake(node1Id);
      const scoreBeforeProof =
        await contracts.randomSamplingStorage.getNodeEpochScore(
          currentEpoch,
          node1Id,
        );
      const perStakeBefore =
        await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          node1Id,
        );

      console.log(
        `    ℹ️  before-proof: score=${scoreBeforeProof}, nodeScorePerStake=${perStakeBefore}, stake=${ethers.formatUnits(stakeBeforeProof, 18)} TRAC`,
      );

      /* --- Submit proof & verify internal math --------------------------- */
      await submitProofAndVerifyScore(
        node1Id,
        accounts.node1,
        contracts,
        currentEpoch,
        stakeBeforeProof,
      );

      /* --- AFTER snapshot ------------------------------------------------- */
      const scoreAfterProof =
        await contracts.randomSamplingStorage.getNodeEpochScore(
          currentEpoch,
          node1Id,
        );
      const perStakeAfter =
        await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          node1Id,
        );

      /* --- Assertions ----------------------------------------------------- */
      expect(scoreAfterProof).to.be.gt(
        scoreBeforeProof,
        'Node epoch score must increase after proof',
      );
      expect(perStakeAfter).to.be.gt(
        perStakeBefore,
        'Score-per-stake must increase after proof',
      );

      console.log(
        `    ✅ score increased: ${scoreBeforeProof} → ${scoreAfterProof}; ` +
          `nodeScorePerStake increased: ${perStakeBefore} → ${perStakeAfter}`,
      );

      /**********************************************************************
       * STEP 11 – Delegator 2 requests withdrawal of 10 000 TRAC            *
       **********************************************************************/
      console.log('\n📤 STEP 11: Delegator2 requests withdrawal of 10 000 TRAC');

      /* ---------- BEFORE snapshot -------------------------------------- */
      const d2StakeBaseBefore =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d2Key);
      const nodeStakeBefore11 =
        await contracts.stakingStorage.getNodeStake(node1Id);

      const scorePerStakeCur =
        await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          node1Id,
        );
      const d2LastSettledBefore =
        await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          node1Id,
          d2Key,
        );
      const d2ScoreBefore =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          node1Id,
          d2Key,
        );

      /* how much score should be settled by _prepareForStakeChange() */
      const expectedScoreIncrement = calculateExpectedDelegatorScore(
        d2StakeBaseBefore, // stake before withdrawal
        scorePerStakeCur,
        d2LastSettledBefore,
      );

      /* ---------- perform withdrawal request --------------------------- */
      await contracts.staking
        .connect(accounts.delegator2)
        .requestWithdrawal(node1Id, ethers.parseUnits('10000', 18));

      /* ---------- AFTER snapshot --------------------------------------- */
      const d2StakeBaseAfter =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d2Key);
      const nodeStakeAfter11 =
        await contracts.stakingStorage.getNodeStake(node1Id);

      const d2ScoreAfter =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          node1Id,
          d2Key,
        );
      const d2LastSettledAfter =
        await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch,
          node1Id,
          d2Key,
        );

      const [withdrawAmount] =
        await contracts.stakingStorage.getDelegatorWithdrawalRequest(
          node1Id,
          d2Key,
        );

      /* ---------- Assertions ------------------------------------------- */
      expect(withdrawAmount).to.equal(
        ethers.parseUnits('10000', 18),
        'withdrawal request amount',
      );
      expect(nodeStakeAfter11).to.equal(
        nodeStakeBefore11 - ethers.parseUnits('10000', 18),
        'node total stake should fall by 10 000 TRAC',
      );
      expect(d2StakeBaseAfter).to.equal(
        d2StakeBaseBefore - ethers.parseUnits('10000', 18),
        'delegator base stake should fall by 10 000 TRAC',
      );
      expect(d2ScoreAfter).to.equal(
        d2ScoreBefore + expectedScoreIncrement,
        'delegator score must be lazily settled before stake change',
      );
      expect(d2LastSettledAfter).to.equal(
        scorePerStakeCur,
        'lastSettled index must be bumped to current nodeScorePerStake',
      );

      console.log(
        `    ✅ withdrawal request stored (${ethers.formatUnits(withdrawAmount, 18)} TRAC)`,
      );
      console.log(
        `    ✅ node stake decreased: ${ethers.formatUnits(nodeStakeBefore11, 18)} → ${ethers.formatUnits(nodeStakeAfter11, 18)} TRAC`,
      );
      console.log(
        `    ✅ D2 stakeBase decreased: ${ethers.formatUnits(d2StakeBaseBefore, 18)} → ${ethers.formatUnits(d2StakeBaseAfter, 18)} TRAC`,
      );
      console.log(
        `    ✅ D2 epochScore increased: ${d2ScoreBefore} → ${d2ScoreAfter} (settled +${expectedScoreIncrement})`,
      );

      /**********************************************************************
       * STEP 12 – Node1 submits **second** proof in currentEpoch            *
       **********************************************************************/
      console.log(
        `\n🔬 STEP 12: Node1 submits second proof in epoch ${currentEpoch}`,
      );

      /* ---------------------------------------------------------------
       * 1️⃣  Shift to new proof-period so challenge is valid
       * ------------------------------------------------------------- */
      await advanceToNextProofingPeriod(contracts);

      /* ---------------------------------------------------------------
       * 2️⃣  BEFORE snapshot
       * ------------------------------------------------------------- */
      const nodeStakeBefore12 =
        await contracts.stakingStorage.getNodeStake(node1Id); // ≈ 62 100 TRAC
      const nodeScoreBefore12 =
        await contracts.randomSamplingStorage.getNodeEpochScore(
          currentEpoch,
          node1Id,
        );
      const perStakeBefore12 =
        await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          node1Id,
        );
      const allNodesScoreBefore12 =
        await contracts.randomSamplingStorage.getAllNodesEpochScore(currentEpoch);

      console.log(
        `    ℹ️  before-proof: nodeScore=${nodeScoreBefore12}, nodeScorePerStake=${perStakeBefore12}, ` +
          `allNodesScore=${allNodesScoreBefore12}, nodeStake=${ethers.formatUnits(nodeStakeBefore12, 18)} TRAC`,
      );

      /* ---------------------------------------------------------------
       * 3️⃣  Perform proof + builtin math-check
       * ------------------------------------------------------------- */
      await submitProofAndVerifyScore(
        node1Id,
        accounts.node1,
        contracts,
        currentEpoch,
        nodeStakeBefore12,
      );

      /* ---------------------------------------------------------------
       * 4️⃣  AFTER snapshot
       * ------------------------------------------------------------- */
      const nodeStakeAfter12 =
        await contracts.stakingStorage.getNodeStake(node1Id);
      const nodeScoreAfter12 =
        await contracts.randomSamplingStorage.getNodeEpochScore(
          currentEpoch,
          node1Id,
        );
      const perStakeAfter12 =
        await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch,
          node1Id,
        );
      const allNodesScoreAfter12 =
        await contracts.randomSamplingStorage.getAllNodesEpochScore(currentEpoch);

      /* ---------------------------------------------------------------
       * 5️⃣  Assertions – strict before/after checks
       * ------------------------------------------------------------- */
      expect(nodeStakeAfter12).to.equal(
        nodeStakeBefore12,
        'Node stake must not change when only submitting a proof',
      );

      expect(nodeScoreAfter12).to.be.gt(
        nodeScoreBefore12,
        'Node epoch score must increase after second proof',
      );

      expect(perStakeAfter12).to.be.gt(
        perStakeBefore12,
        'Score-per-stake must increase after second proof',
      );

      expect(allNodesScoreAfter12).to.be.gt(
        allNodesScoreBefore12,
        'Global all-nodes score must increase after proof',
      );

      console.log(
        `    ✅ nodeScore:     ${nodeScoreBefore12} → ${nodeScoreAfter12}\n` +
          `    ✅ scorePerStake: ${perStakeBefore12} → ${perStakeAfter12}\n`,
      );

      /**********************************************************************
       * STEP 13 – Delegator 1 claims rewards for epoch `claimEpoch`
       *          (diagram "Delegator1 claims reward for epoch 2")
       **********************************************************************/

      console.log('\n💰 STEP 13: Delegator1 claims rewards for previous epoch');

      /* ---------------------------------------------------------------
       * 1️⃣  Finalise currentEpoch so rewards become claimable
       *     – we need to be in epoch 3 and claim for epoch 2
       * ------------------------------------------------------------- */
      const timeUntilNextEpoch = await contracts.chronos.timeUntilNextEpoch();
      await time.increase(timeUntilNextEpoch + 1n);

      const epochAfterFinalize = await contracts.chronos.getCurrentEpoch(); // == currentEpoch + 1
      const claimEpoch = epochAfterFinalize - 1n; // epoch we are claiming for

      /* one more dummy KC → triggers epoch finalisation */
      await createKnowledgeCollection(
        accounts.kcCreator,
        accounts.node1,
        Number(node1Id),
        receivingNodes,
        receivingNodesIdentityIds,
        { KnowledgeCollection: contracts.kc, Token: contracts.token },
        merkleRoot,
        'finalise-epoch',
        10, // holders
        chunkSize * 15, // byteSize - use multiple of chunkSize for proper chunk generation
        10, // replicas
        toTRAC(50_000), // <-- epoch fee identical to the diagram
      );

      /* epoch really finalised? */
      expect(await contracts.epochStorage.lastFinalizedEpoch(1)).to.be.gte(
        claimEpoch,
        'Epoch must be finalised before claiming',
      );

      /* ---------------------------------------------------------------
       * 2️⃣  BEFORE snapshot – **manual** reward calculation
       * ------------------------------------------------------------- */
      const SCALE18 = ethers.parseUnits('1', 18);

      const d1BaseBefore = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d1Key,
      );
      const nodeScore = await contracts.randomSamplingStorage.getNodeEpochScore(
        claimEpoch,
        node1Id,
      );
      const perStake =
        await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
          claimEpoch,
          node1Id,
        );
      const d1LastSettled =
        await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          claimEpoch,
          node1Id,
          d1Key,
        );
      const d1StoredScore =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          claimEpoch,
          node1Id,
          d1Key,
        );

      /* "lazy-settle" delta that _will_ be written inside claim() */
      const d1SettleDiff = perStake - d1LastSettled;
      const earnedScore = (BigInt(d1BaseBefore) * d1SettleDiff) / SCALE18;

      /* total score that delegator should have after settle */
      const d1TotalScore = d1StoredScore + earnedScore;

      /* net pool for delegators that epoch */
      const netDelegatorRewards13 = await contracts.stakingKPI.getNetNodeRewards(
        node1Id,
        claimEpoch,
      );

      /* expected TRAC reward (18 decimals) */
      const expectedReward13 =
        nodeScore === 0n
          ? 0n
          : (d1TotalScore * netDelegatorRewards13) / nodeScore;

      console.log(
        `    ℹ️  claimEpoch=${claimEpoch}, nodeScore=${nodeScore}, d1Score(before)=${d1StoredScore}, earned score=${earnedScore}, pool=${ethers.formatUnits(netDelegatorRewards13, 18)} TRAC`,
      );
      console.log(
        `    🔢 nodeScore        = ${nodeScore}`,
        `\n    🔢 d1StoredScore   = ${d1StoredScore}`,
        `\n    🔢 d1EarnedScore   = ${earnedScore}`,
      );

      /* ---------------------------------------------------------------
       * 3️⃣  Perform claim
       * ------------------------------------------------------------- */
      await contracts.staking
        .connect(accounts.delegator1)
        .claimDelegatorRewards(node1Id, claimEpoch, accounts.delegator1.address);

      /* ---------------------------------------------------------------
       * 4️⃣  AFTER snapshot
       * ------------------------------------------------------------- */
      const d1BaseAfter = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d1Key,
      );
      const nodeStakeAfter13 =
        await contracts.stakingStorage.getNodeStake(node1Id);
      const d1LastClaimed13 = await contracts.delegatorsInfo.getLastClaimedEpoch(
        node1Id,
        accounts.delegator1.address,
      );

      /* ---------------------------------------------------------------
       * 5️⃣  Assertions
       * ------------------------------------------------------------- */
      const actualReward13 = d1BaseAfter - d1BaseBefore;
      const expectedDelegatorRewardKPI =
        await contracts.stakingKPI.getDelegatorReward(
          node1Id,
          claimEpoch,
          accounts.delegator1.address,
        );

      expect(actualReward13, 'restaked reward amount').to.equal(expectedReward13);
      expect(expectedDelegatorRewardKPI).to.equal(actualReward13);
      expect(d1LastClaimed13, 'lastClaimedEpoch update').to.equal(claimEpoch);
      expect(nodeStakeAfter13).to.equal(
        nodeStakeAfter12 + actualReward13,
        'node total stake must include newly auto-staked reward',
      );
      console.log(
        `    🧮 EXPECTED reward  = ${ethers.formatUnits(expectedReward13, 18)} TRAC`,
        `\n    ✅ ACTUAL reward    = ${ethers.formatUnits(actualReward13, 18)} TRAC`,
      );

      /* nice console output */
      console.log(
        `    ✅ D1 reward ${ethers.formatUnits(actualReward13, 18)} TRAC ` +
          `staked → new base ${ethers.formatUnits(d1BaseAfter, 18)} TRAC`,
      );
      console.log(`    ✅ lastClaimedEpoch set to ${d1LastClaimed13}\n`);

      /**********************************************************************
       * STEP 14 – Delegator 2 claims rewards for epoch `claimEpoch` (= 2)
       **********************************************************************/

      console.log(
        '\n💰 STEP 14: Delegator2 claims rewards for epoch',
        claimEpoch,
      );

      /* ---------------------------------------------------------------
       * 1️⃣  Pre-claim snapshot
       * ------------------------------------------------------------- */
      const d2BaseBefore14 = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d2Key,
      );
      const d2LastClaimed14 = await contracts.delegatorsInfo.getLastClaimedEpoch(
        node1Id,
        accounts.delegator2.address,
      );

      // Must be claiming the next unclaimed epoch (1 → 2)
      expect(d2LastClaimed14).to.equal(
        claimEpoch - 1n,
        'Delegator2 is not claiming the oldest pending epoch',
      );

      /* ---------------------------------------------------------------
       * 2️⃣  Manual reward calculation
       * ------------------------------------------------------------- */
      const nodeScoreClaim =
        await contracts.randomSamplingStorage.getNodeEpochScore(
          claimEpoch,
          node1Id,
        );
      const perStakeClaim =
        await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
          claimEpoch,
          node1Id,
        );
      const d2LastSettledClaim =
        await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          claimEpoch,
          node1Id,
          d2Key,
        );
      const d2StoredScore =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          claimEpoch,
          node1Id,
          d2Key,
        );

      /* "lazy-settle" part to be added inside claim() */
      const d2SettleDiff = perStakeClaim - d2LastSettledClaim;
      const d2EarnedScore = (d2BaseBefore14 * d2SettleDiff) / SCALE18;
      const d2TotalScore = d2StoredScore + d2EarnedScore;

      const netDelegatorRewards14 = await contracts.stakingKPI.getNetNodeRewards(
        node1Id,
        claimEpoch,
      );

      const expectedReward14 =
        nodeScoreClaim === 0n
          ? 0n
          : (d2TotalScore * netDelegatorRewards14) / nodeScoreClaim;

      console.log(
        `    🔢 nodeScore        = ${nodeScoreClaim}`,
        `\n    🔢 d2StoredScore   = ${d2StoredScore}`,
        `\n    🔢 d2EarnedScore   = ${d2EarnedScore}`,
        `pool=${ethers.formatUnits(netDelegatorRewards14, 18)} TRAC`,
      );

      /* ---------------------------------------------------------------
       * 3️⃣  Claim transaction
       * ------------------------------------------------------------- */
      await contracts.staking
        .connect(accounts.delegator2)
        .claimDelegatorRewards(node1Id, claimEpoch, accounts.delegator2.address);

      /* ---------------------------------------------------------------
       * 4️⃣  Post-claim snapshot
       * ------------------------------------------------------------- */
      const d2BaseAfter14 = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d2Key,
      );
      const d2LastClaimedAfter =
        await contracts.delegatorsInfo.getLastClaimedEpoch(
          node1Id,
          accounts.delegator2.address,
        );
      const actualReward14 = d2BaseAfter14 - d2BaseBefore14;
      const expectedDelegatorRewardKPI14 =
        await contracts.stakingKPI.getDelegatorReward(
          node1Id,
          claimEpoch,
          accounts.delegator2.address,
        );

      console.log(
        `    🧮 EXPECTED reward  = ${ethers.formatUnits(expectedReward14, 18)} TRAC`,
        `\n    ✅ ACTUAL reward    = ${ethers.formatUnits(actualReward14, 18)} TRAC`,
      );

      /* ---------------------------------------------------------------
       * 5️⃣  Assertions
       * ------------------------------------------------------------- */
      expect(actualReward14, 'staked reward mismatch').to.equal(expectedReward14);
      expect(expectedDelegatorRewardKPI14).to.equal(actualReward14);
      expect(d2LastClaimedAfter, 'lastClaimedEpoch not updated').to.equal(
        claimEpoch,
      );

      // Node stake should grow by the auto-staked reward
      const nodeStakeAfter14 =
        await contracts.stakingStorage.getNodeStake(node1Id);
      expect(nodeStakeAfter14).to.equal(
        nodeStakeAfter13 + actualReward14,
        'Node total stake did not include Delegator2 reward',
      );

      // Pending withdrawal request must stay untouched
      const [withdrawPending] =
        await contracts.stakingStorage.getDelegatorWithdrawalRequest(
          node1Id,
          d2Key,
        );
      expect(withdrawPending).to.equal(
        ethers.parseUnits('10000', 18),
        'Withdrawal request amount changed after claim',
      );

      console.log(
        `    ✅ D2 reward ${ethers.formatUnits(actualReward14, 18)} TRAC ` +
          `restaked → new base ${ethers.formatUnits(d2BaseAfter14, 18)} TRAC`,
      );
      console.log(`    ✅ lastClaimedEpoch set to ${d2LastClaimedAfter}\n`);
      console.log('\n✨ Steps 8-14 completed – ready for next tests ✨\n');

      await epochRewardsPoolPrecisionLoss(
        contracts,
        claimEpoch,
        netDelegatorRewards14,
        actualReward13 +
          actualReward14 +
          (await contracts.stakingKPI.getDelegatorReward(
            node1Id,
            claimEpoch,
            accounts.delegator3.address,
          )),
      );
    });
});
