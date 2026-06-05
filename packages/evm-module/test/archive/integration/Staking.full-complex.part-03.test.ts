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
     *  Steps 15 – 21 (continue from the chain-state left after Step 14)                       *
     ******************************************************************************************/
    it('Should execute steps 15-23 with detailed score calculations and verification', async function () {
      /* helpers already in scope from previous tests */
      const toTRAC18 = (x: number | string) =>
        ethers.parseUnits(x.toString(), 18);

      const TEN_K = ethers.parseUnits('10000', TOKEN_DECIMALS);

      /**********************************************************************
       * STEP 15 – Delegator 2 finalises withdrawal of 10 000 TRAC
       **********************************************************************/
      console.log('\n📤 STEP 15: Delegator2 finalises withdrawal of 10 000 TRAC');

      /* 1️⃣  Make sure the request exists and the delay has passed */
      const [pending, , releaseTs] =
        await contracts.stakingStorage.getDelegatorWithdrawalRequest(
          node1Id,
          d2Key,
        );

      expect(pending, 'pending amount mismatch').to.equal(TEN_K);

      const now = BigInt(await time.latest());
      if (now < releaseTs) await time.increase(releaseTs - now + 1n);

      /* 2️⃣  Snapshot BEFORE */
      const balBefore = await contracts.token.balanceOf(accounts.delegator2);
      const nodeStakeBefore15 =
        await contracts.stakingStorage.getNodeStake(node1Id);

      console.log(
        `    🪙 Wallet BEFORE: ${ethers.formatUnits(balBefore, TOKEN_DECIMALS)} TRAC`,
      );

      /* 3️⃣  Finalise */
      await contracts.staking
        .connect(accounts.delegator2)
        .finalizeWithdrawal(node1Id);

      /* 4️⃣  Snapshot AFTER */
      const balAfter = await contracts.token.balanceOf(accounts.delegator2);
      const nodeStakeAfter15 =
        await contracts.stakingStorage.getNodeStake(node1Id);
      const [reqAfter] =
        await contracts.stakingStorage.getDelegatorWithdrawalRequest(
          node1Id,
          d2Key,
        );

      /* 5️⃣  Assertions */
      expect(balAfter - balBefore, 'wallet diff').to.equal(TEN_K); // ← BigInt diff
      expect(nodeStakeAfter15, 'node stake already reduced in step 11').to.equal(
        nodeStakeBefore15,
      );
      expect(reqAfter, 'withdrawal request should be cleared').to.equal(0n);

      console.log(
        `    🪙 Wallet AFTER : ${ethers.formatUnits(balAfter, TOKEN_DECIMALS)} TRAC`,
        `\n    ✅ 10 000 TRAC transferred successfully`,
      );

      /**********************************************************************
       * STEP 16 – Delegator 3 tries to stake extra 5 000 TRAC (must revert) *
       **********************************************************************/
      console.log(
        '\n⛔  STEP 16: Delegator3 attempts to stake 5 000 TRAC – should revert',
      );

      await contracts.token
        .connect(accounts.delegator3)
        .approve(await contracts.staking.getAddress(), toTRAC18(5_000));

      await expect(
        contracts.staking
          .connect(accounts.delegator3)
          .stake(node1Id, toTRAC18(5_000)),
      ).to.be.revertedWith(
        'Must claim all previous epoch rewards before changing stake',
      );

      console.log(
        '    ✅ Revert received as expected – Delegator3 must claim epochs 2 & 3 first',
      );

      /**********************************************************************
       * STEP 17 – Delegator 3 claims rewards for epoch 1
       **********************************************************************/
      console.log('\n💰 STEP 17: Delegator3 claims rewards for epoch 2');

      const claimEpoch17 = 2n;

      const SCALE18 = ethers.parseUnits('1', 18);

      /* ── 1. Preconditions ────────────────────────────────────────────── */
      const lastClaimedBefore =
        await contracts.delegatorsInfo.getLastClaimedEpoch(
          node1Id,
          accounts.delegator3.address,
        );

      /**
       * 0  – sentinel "never claimed"  (default)
       * n–1 – standard "oldest un-claimed epoch"
       */
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        lastClaimedBefore === 0n || lastClaimedBefore === claimEpoch17 - 1n,
        'Delegator-3 must claim the oldest pending epoch first',
      ).to.equal(true);

      /* ── 2. Manual reward calculation (for assertions) ───────────────── */
      const stakeBaseBefore =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d3Key);

      const nodeScore17 = await contracts.randomSamplingStorage.getNodeEpochScore(
        claimEpoch17,
        node1Id,
      );
      const perStake17 =
        await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
          claimEpoch17,
          node1Id,
        );

      const lastSettled17 =
        await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          claimEpoch17,
          node1Id,
          d3Key,
        );
      const storedScore17 =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          claimEpoch17,
          node1Id,
          d3Key,
        );

      const earnedScore17 =
        (stakeBaseBefore * (perStake17 - lastSettled17)) / SCALE18;
      const totalScore17 = storedScore17 + earnedScore17;

      const rewardsPool17 = await contracts.stakingKPI.getNetNodeRewards(
        node1Id,
        claimEpoch17,
      );

      const expectedReward17 =
        nodeScore17 === 0n ? 0n : (totalScore17 * rewardsPool17) / nodeScore17;

      /* ── 3. Claim transaction ────────────────────────────────────────── */
      await contracts.staking
        .connect(accounts.delegator3)
        .claimDelegatorRewards(
          node1Id,
          claimEpoch17,
          accounts.delegator3.address,
        );

      /* ── 4. Post-claim checks ────────────────────────────────────────── */
      const stakeBaseAfter = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d3Key,
      ); // must stay 30 000
      const rollingRewards =
        await contracts.delegatorsInfo.getDelegatorRollingRewards(
          node1Id,
          accounts.delegator3.address,
        );
      const lastClaimedAfter = await contracts.delegatorsInfo.getLastClaimedEpoch(
        node1Id,
        accounts.delegator3.address,
      );

      expect(
        stakeBaseAfter,
        'stakeBase unchanged while older epochs remain',
      ).to.equal(stakeBaseBefore);
      expect(rollingRewards, 'rollingRewards incorrect').to.equal(
        expectedReward17,
      );
      expect(lastClaimedAfter, 'lastClaimedEpoch not updated').to.equal(
        claimEpoch17,
      );

      console.log(
        `    ✅ rollingRewards = ${ethers.formatUnits(rollingRewards, 18)} TRAC`,
        `\n    ✅ lastClaimedEpoch = ${lastClaimedAfter}\n`,
      );

      /**********************************************************************
       * STEP 18 – Delegator 3 claims rewards for epoch 2
       * --------------------------------------------------------------------
       **********************************************************************/
      console.log('\n💰 STEP 18: Delegator3 claims rewards for epoch 3');

      const claimEpoch18 = 3n;

      /* ── 1. PRE-CONDITIONS ──────────────────────────────────────────────── */
      const d3LastClaimedBefore18 =
        await contracts.delegatorsInfo.getLastClaimedEpoch(
          node1Id,
          accounts.delegator3.address,
        );

      // Must be claiming the oldest pending epoch (1 → 2)
      expect(d3LastClaimedBefore18).to.equal(
        claimEpoch18 - 1n,
        'Delegator-3 is skipping an older unclaimed epoch',
      );

      /* ── 2. MANUAL REWARD CALCULATION ───────────────────────────────────── */
      const d3BaseBefore18 = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d3Key,
      );
      const d3RollingBefore18 =
        await contracts.delegatorsInfo.getDelegatorRollingRewards(
          node1Id,
          accounts.delegator3.address,
        );

      const nodeScoreEp2 =
        await contracts.randomSamplingStorage.getNodeEpochScore(
          claimEpoch18,
          node1Id,
        );
      const perStakeEp2 =
        await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
          claimEpoch18,
          node1Id,
        );

      const d3LastSettledEp2 =
        await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          claimEpoch18,
          node1Id,
          d3Key,
        );
      const d3StoredScoreEp2 =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          claimEpoch18,
          node1Id,
          d3Key,
        );

      /* "lazy-settle" part that will be written inside claim() */
      const d3EarnedScore =
        (d3BaseBefore18 * (perStakeEp2 - d3LastSettledEp2)) / SCALE18;
      const d3TotalScore = d3StoredScoreEp2 + d3EarnedScore;

      const netDelegatorRewardsEp2 = await contracts.stakingKPI.getNetNodeRewards(
        node1Id,
        claimEpoch18,
      );

      // New reward for epoch 2
      const rewardEp2 =
        nodeScoreEp2 === 0n
          ? 0n
          : (d3TotalScore * netDelegatorRewardsEp2) / nodeScoreEp2;

      // ► what will actually be auto-staked:
      const expectedStakeIncrease18 = d3RollingBefore18 + rewardEp2;

      /* ── 3. CLAIM TRANSACTION ───────────────────────────────────────────── */
      await contracts.staking
        .connect(accounts.delegator3)
        .claimDelegatorRewards(
          node1Id,
          claimEpoch18,
          accounts.delegator3.address,
        );

      /* ── 4. POST-CLAIM SNAPSHOT ─────────────────────────────────────────── */
      const d3BaseAfter18 = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d3Key,
      );
      const d3RollingAfter18 =
        await contracts.delegatorsInfo.getDelegatorRollingRewards(
          node1Id,
          accounts.delegator3.address,
        );
      const d3LastClaimedAfter18 =
        await contracts.delegatorsInfo.getLastClaimedEpoch(
          node1Id,
          accounts.delegator3.address,
        );
      const nodeStakeAfter18 =
        await contracts.stakingStorage.getNodeStake(node1Id);

      /* ── 5. ASSERTIONS ──────────────────────────────────────────────────── */
      expect(
        d3BaseAfter18 - d3BaseBefore18,
        'auto-staked amount mismatch',
      ).to.equal(expectedStakeIncrease18);

      expect(d3RollingAfter18, 'rollingRewards should now be 0').to.equal(0n);

      expect(d3LastClaimedAfter18, 'lastClaimedEpoch not updated').to.equal(
        claimEpoch18,
      );

      // nodeStakeAfter14 must be in scope from previous step
      expect(nodeStakeAfter18).to.equal(
        nodeStakeAfter15 + expectedStakeIncrease18,
        'Node total stake should include D3 reward',
      );

      console.log(
        `    🧮 reward(epoch3)   = ${ethers.formatUnits(rewardEp2, 18)} TRAC`,
        `\n    🧮 rolling(before) = ${ethers.formatUnits(d3RollingBefore18, 18)} TRAC`,
        `\n    ✅ total reward  = ${ethers.formatUnits(expectedStakeIncrease18, 18)} TRAC`,
      );
      console.log(
        `    ✅ new D3 stakeBase = ${ethers.formatUnits(d3BaseAfter18, 18)} TRAC`,
        `\n    ✅ rolling(after)  = ${ethers.formatUnits(d3RollingAfter18, 18)} TRAC`,
        `\n    ✅ lastClaimedEpoch = ${d3LastClaimedAfter18}\n`,
      );

      /**********************************************************************
       * STEP 19 – Delegator 3 requests withdrawal of 10 000 TRAC            *
       **********************************************************************/
      console.log('\n📤 STEP 19: Delegator3 requests withdrawal of 10 000 TRAC');

      /* ---------- BEFORE snapshot -------------------------------------- */
      const d3StakeBaseBefore19 =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d3Key);
      const nodeStakeBefore19 =
        await contracts.stakingStorage.getNodeStake(node1Id);

      // latest epoch (== 4)
      const currentEpoch19 = await contracts.chronos.getCurrentEpoch();
      console.log(`    ℹ️  current epoch = ${currentEpoch19}`);

      const scorePerStakeCur19 =
        await contracts.randomSamplingStorage.getNodeEpochScorePerStake(
          currentEpoch19,
          node1Id,
        );
      const d3LastSettledBefore19 =
        await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch19,
          node1Id,
          d3Key,
        );
      const d3ScoreBefore19 =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch19,
          node1Id,
          d3Key,
        );

      /* how much score will be lazily settled by _prepareForStakeChange() */
      const expectedScoreInc19 = calculateExpectedDelegatorScore(
        d3StakeBaseBefore19,
        scorePerStakeCur19,
        d3LastSettledBefore19,
      );

      /* ---------- perform withdrawal request --------------------------- */
      await contracts.staking
        .connect(accounts.delegator3)
        .requestWithdrawal(node1Id, TEN_K); // TEN_K = 10 000 TRAC

      /* ---------- AFTER snapshot --------------------------------------- */
      const d3StakeBaseAfter19 =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d3Key);
      const nodeStakeAfter19 =
        await contracts.stakingStorage.getNodeStake(node1Id);

      const d3ScoreAfter19 =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch19,
          node1Id,
          d3Key,
        );
      const d3LastSettledAfter19 =
        await contracts.randomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
          currentEpoch19,
          node1Id,
          d3Key,
        );

      const [withdrawAmount19] =
        await contracts.stakingStorage.getDelegatorWithdrawalRequest(
          node1Id,
          d3Key,
        );

      /* ---------- Assertions ------------------------------------------- */
      expect(withdrawAmount19).to.equal(
        TEN_K,
        'withdrawal request amount mismatch',
      );

      expect(nodeStakeAfter19).to.equal(
        nodeStakeBefore19 - TEN_K,
        'node total stake should fall by 10 000 TRAC',
      );
      expect(d3StakeBaseAfter19).to.equal(
        d3StakeBaseBefore19 - TEN_K,
        'delegator base stake should fall by 10 000 TRAC',
      );

      expect(d3ScoreAfter19).to.equal(
        d3ScoreBefore19 + expectedScoreInc19,
        'delegator score must be lazily settled before stake change',
      );
      expect(d3LastSettledAfter19).to.equal(
        scorePerStakeCur19,
        'lastSettled index must be bumped to current nodeScorePerStake',
      );

      /* ---------- Console summary -------------------------------------- */
      console.log(
        `    ✅ withdrawal request stored (${ethers.formatUnits(withdrawAmount19, 18)} TRAC)`,
      );
      console.log(
        `    ✅ node stake ${ethers.formatUnits(nodeStakeBefore19, 18)} → ${ethers.formatUnits(nodeStakeAfter19, 18)} TRAC`,
      );
      console.log(
        `    ✅ D3 stakeBase ${ethers.formatUnits(d3StakeBaseBefore19, 18)} → ${ethers.formatUnits(d3StakeBaseAfter19, 18)} TRAC`,
      );
      console.log(
        `    ✅ D3 epoch-score ${d3ScoreBefore19} → ${d3ScoreAfter19} (settled +${expectedScoreInc19})`,
      );

      /**********************************************************************
       * STEP 20 – Jump to epoch-5  ➜ finalise withdrawal of 10 000 TRAC
       **********************************************************************/
      console.log(
        '\n⏭️  STEP 20: Node 1 Submit Proof for epoch-4, Jump to epoch-5 so epoch-4 is finalised and D3 finalises withdrawal',
      );

      await advanceToNextProofingPeriod(contracts);

      // 2. take a stake snapshot (needed by the helper that double-checks maths)
      const stakeSnapshot = await contracts.stakingStorage.getNodeStake(node1Id);

      // 3. have node-1 submit one more proof for *epoch-4*
      await submitProofAndVerifyScore(
        node1Id,
        accounts.node1,
        contracts,
        currentEpoch19, // <- epoch-4
        stakeSnapshot,
      );

      /* 1️⃣  → epoch-5 */
      const ttn = await contracts.chronos.timeUntilNextEpoch();
      await time.increase(ttn + 1n); // epoch 5

      await createKnowledgeCollection(
        accounts.kcCreator,
        accounts.node1,
        Number(node1Id),
        receivingNodes,
        receivingNodesIdentityIds,
        { KnowledgeCollection: contracts.kc, Token: contracts.token },
        merkleRoot,
        'finalise-epoch4',
        1, // holders
        chunkSize * 2, // byteSize - use multiple of chunkSize for proper chunk generation
        1, // replicas
        toTRAC(1), //
      );

      expect(await contracts.epochStorage.lastFinalizedEpoch(1)).to.equal(
        4n,
        'Epoch-4 should now be finalised',
      );

      const epoch5 = await contracts.chronos.getCurrentEpoch(); // == 5
      console.log(`    ✅ Now in epoch ${epoch5} (epoch-4 finalised)`);
      expect(epoch5).to.equal(5n);

      const epoc4 = 4n;

      const netNodeRewards = await contracts.stakingKPI.getNetNodeRewards(
        node1Id,
        epoc4,
      );
      const allDelegatorsRewards =
        (await contracts.stakingKPI.getDelegatorReward(
          node1Id,
          epoc4,
          accounts.delegator1.address,
        )) +
        (await contracts.stakingKPI.getDelegatorReward(
          node1Id,
          epoc4,
          accounts.delegator2.address,
        )) +
        (await contracts.stakingKPI.getDelegatorReward(
          node1Id,
          epoc4,
          accounts.delegator3.address,
        ));

      await epochRewardsPoolPrecisionLoss(
        contracts,
        epoc4,
        netNodeRewards,
        allDelegatorsRewards,
      );

      /* 3️⃣  Make sure the withdrawal delay elapsed */
      const [pending20, , releaseTs20] =
        await contracts.stakingStorage.getDelegatorWithdrawalRequest(
          node1Id,
          d3Key,
        );

      expect(pending20).to.equal(TEN_K, 'pending amount mismatch');

      const now20 = BigInt(await time.latest());
      if (now20 < releaseTs20) await time.increase(releaseTs20 - now20 + 1n);

      /* 4️⃣  BEFORE snapshot */
      const balBefore20 = await contracts.token.balanceOf(accounts.delegator3);
      const nodeStakeBefore20 =
        await contracts.stakingStorage.getNodeStake(node1Id);

      /* 5️⃣  Finalise withdrawal */
      await contracts.staking
        .connect(accounts.delegator3)
        .finalizeWithdrawal(node1Id);

      /* 6️⃣  AFTER snapshot & asserts */
      const balAfter20 = await contracts.token.balanceOf(accounts.delegator3);
      const nodeStakeAfter20 =
        await contracts.stakingStorage.getNodeStake(node1Id);
      const [reqAfter20] =
        await contracts.stakingStorage.getDelegatorWithdrawalRequest(
          node1Id,
          d3Key,
        );

      expect(balAfter20 - balBefore20).to.equal(TEN_K, 'wallet diff');
      expect(nodeStakeAfter20).to.equal(
        nodeStakeBefore20,
        'node stake invariant',
      );
      expect(reqAfter20).to.equal(0n, 'request must be cleared');

      console.log(
        `    🪙 +${ethers.formatUnits(TEN_K, 18)} TRAC to Delegator3 – withdrawal finalised`,
      );

      /**********************************************************************
       * STEP 21 – Delegator 1 tries to stake extra 5 000 TRAC (★ must revert)
       **********************************************************************/
      console.log(
        '\n⛔  STEP 21: Delegator1 attempts to stake 5 000 TRAC – should revert',
      );

      /* ---------- context info ---------------------------------------- */
      const currentEpoch21 = await contracts.chronos.getCurrentEpoch(); // == epoch5
      const d1LastClaimed21 = await contracts.delegatorsInfo.getLastClaimedEpoch(
        node1Id,
        accounts.delegator1.address,
      );
      console.log(
        `    ℹ️  currentEpoch = ${currentEpoch21}, D1.lastClaimedEpoch = ${d1LastClaimed21}`,
      );

      // D1 has NOT yet claimed epoch 3 (and 4) → stake change must fail

      /* ---------- BEFORE snapshot ------------------------------------- */
      const d1StakeBaseBefore21 =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
      const nodeStakeBefore21 =
        await contracts.stakingStorage.getNodeStake(node1Id);

      /* ---------- token approval -------------------------------------- */
      await contracts.token
        .connect(accounts.delegator1)
        .approve(await contracts.staking.getAddress(), toTRAC18(5_000));

      /* ---------- stake tx (expect revert) ---------------------------- */
      await expect(
        contracts.staking
          .connect(accounts.delegator1)
          .stake(node1Id, toTRAC18(5_000)),
      ).to.be.revertedWith(
        'Must claim the previous epoch rewards before changing stake',
      );

      console.log(
        '    ✅ Revert received – Delegator1 must first claim epoch 4 rewards',
      );

      /* ---------- AFTER snapshot -------------------------------------- */
      const d1StakeBaseAfter21 =
        await contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key);
      const nodeStakeAfter21 =
        await contracts.stakingStorage.getNodeStake(node1Id);

      /* ---------- invariants ----------------------------------------- */
      expect(d1StakeBaseAfter21, 'D1.stakeBase should stay unchanged').to.equal(
        d1StakeBaseBefore21,
      );
      expect(nodeStakeAfter21, 'Node total stake should stay unchanged').to.equal(
        nodeStakeBefore21,
      );

      /* ---------- console summary ------------------------------------ */
      console.log(
        `    ❌ Stake blocked – D1 must claim rewards first`,
        `\n    ✅ D1.stakeBase remains ${ethers.formatUnits(d1StakeBaseAfter21, 18)} TRAC`,
        `\n    ✅ Node1.totalStake remains ${ethers.formatUnits(nodeStakeAfter21, 18)} TRAC\n`,
      );
    });
});
