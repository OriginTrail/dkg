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


    /* ------------------------------------------------------------------
     *  STEP A  (Claim, Redelegate, Proof)
     * ------------------------------------------------------------------ */
    it('Redelegate steps – Step A (D1 claims, redelegates N1->N2, then N1 submits proof)', async function () {
      /* ------------------------------------------------------------------
       * 1. PRE-CONDITION: CLAIM PENDING REWARDS
       * ------------------------------------------------------------------ */
      console.log(
        '\n⏳ STEP A.1: Delegator1 claiming pending rewards for epoch 4...',
      );

      // From previous tests, we know epoch 4 is the last finalized one,
      // and D1's last claim was for epoch 2. So, epochs 3 and 4 are pending.

      await contracts.staking
        .connect(accounts.delegator1)
        .claimDelegatorRewards(node1Id, 4n, accounts.delegator1.address);

      const d1LastClaimed = await contracts.delegatorsInfo.getLastClaimedEpoch(
        node1Id,
        accounts.delegator1.address,
      );
      expect(d1LastClaimed).to.be.gte(
        4n,
        'Delegator1 should have claimed all pending rewards up to epoch 4',
      );
      console.log(
        `    ✅ Pending rewards claimed. D1 last claimed epoch is now ${d1LastClaimed}.`,
      );

      /* ------------------------------------------------------------------
       * 2. REDELEGATE N1 -> N2 (with checks and logs)
       * ------------------------------------------------------------------ */
      console.log(
        '\n✈️ STEP A.2: Delegator1 redelegating from Node1 to Node2...',
      );

      // Snapshot BEFORE
      const stakeToMove = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d1Key,
      );
      const n1StakeBefore = await contracts.stakingStorage.getNodeStake(node1Id);
      const n2StakeBefore = await contracts.stakingStorage.getNodeStake(
        nodeIds.node2Id,
      );
      console.log(
        `    [BEFORE] N1.total=${ethers.formatUnits(
          n1StakeBefore,
          18,
        )} | N2.total=${ethers.formatUnits(
          n2StakeBefore,
          18,
        )} | D1.stake=${ethers.formatUnits(stakeToMove, 18)}`,
      );

      // Perform Redelegate
      await contracts.staking
        .connect(accounts.delegator1)
        .redelegate(node1Id, nodeIds.node2Id, stakeToMove);

      // Snapshot AFTER
      const n1StakeAfter = await contracts.stakingStorage.getNodeStake(node1Id);
      const n2StakeAfter = await contracts.stakingStorage.getNodeStake(
        nodeIds.node2Id,
      );
      const d1BaseN1 = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d1Key,
      );
      const d1BaseN2 = await contracts.stakingStorage.getDelegatorStakeBase(
        nodeIds.node2Id,
        d1Key,
      );
      const d1StillOnN1 = await contracts.delegatorsInfo.isNodeDelegator(
        node1Id,
        accounts.delegator1.address,
      );
      const d1OnN2 = await contracts.delegatorsInfo.isNodeDelegator(
        nodeIds.node2Id,
        accounts.delegator1.address,
      );

      console.log(
        `    [AFTER]  N1.total=${ethers.formatUnits(
          n1StakeAfter,
          18,
        )} | N2.total=${ethers.formatUnits(
          n2StakeAfter,
          18,
        )} | D1.base(N1)=${d1BaseN1} | D1.base(N2)=${d1BaseN2}`,
      );

      // Assertions
      expect(d1BaseN1).to.equal(0n, 'D1 should have 0 stake on N1');
      expect(d1BaseN2).to.equal(stakeToMove, 'Stake should be moved to N2');
      expect(n1StakeAfter).to.equal(n1StakeBefore - stakeToMove);
      expect(n2StakeAfter).to.equal(n2StakeBefore + stakeToMove);
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(d1StillOnN1).to.be.false;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(d1OnN2).to.equal(true);

      // Log the crucial state for debugging Step B
      const lastStakeHeldEpochN1 =
        await contracts.delegatorsInfo.getLastStakeHeldEpoch(
          node1Id,
          accounts.delegator1.address,
        );
      console.log(
        `    [DEBUG] D1 on N1: isDelegator=${d1StillOnN1}, lastStakeHeldEpoch=${lastStakeHeldEpochN1}`,
      );

      console.log('    ✅ Redelegation successful.');

      /* ------------------------------------------------------------------
       * 3. NODE 1 SUBMITS PROOF
       * ------------------------------------------------------------------ */
      console.log('\n🔬 STEP A.3: Node1 submitting proof for current epoch...');
      const curEpoch = await contracts.chronos.getCurrentEpoch(); // Should be epoch 5
      expect(curEpoch).to.equal(5n);

      await advanceToNextProofingPeriod(contracts);

      await ensureNodeHasChunksThisEpoch(
        node1Id,
        accounts.node1,
        contracts,
        accounts,
        receivingNodes,
        receivingNodesIdentityIds,
        chunkSize,
      );

      const n1StakeNow = await contracts.stakingStorage.getNodeStake(node1Id);
      await submitProofAndVerifyScore(
        node1Id,
        accounts.node1,
        contracts,
        curEpoch,
        n1StakeNow,
      );
      console.log('    ✅ Node1 proof submitted.');

      console.log(
        `    [DEBUG2] D1 on N1: isDelegator=${d1StillOnN1}, lastStakeHeldEpoch=${lastStakeHeldEpochN1}`,
      );

      /* ------------------------------------------------------------------
       * 4. ADVANCE TO NEXT EPOCH
       * ------------------------------------------------------------------ */
      console.log('\n⏭️ STEP A.4: Advancing to the next epoch...');
      const ttn5 = await contracts.chronos.timeUntilNextEpoch();
      await time.increase(ttn5 + 1n); // → epoch-6
      const epoch6 = await contracts.chronos.getCurrentEpoch();

      await createKnowledgeCollection(
        accounts.kcCreator,
        accounts.node2,
        Number(nodeIds.node2Id),
        receivingNodes,
        receivingNodesIdentityIds,
        { KnowledgeCollection: contracts.kc, Token: contracts.token },
        merkleRoot,
        'test-op-id-node2-proof-stepA4',
        10,
        chunkSize * 8, // byteSize - use multiple of chunkSize for proper chunk generation
        10,
        toTRAC(1000),
      );

      /* Verify epoch-5 is now finalised so its rewards can be claimed */
      expect(
        await contracts.epochStorage.lastFinalizedEpoch(1),
        'epoch-5 should now be finalised',
      ).to.equal(5n);

      expect(epoch6).to.equal(6n);
      console.log(`    ✅ Advanced to epoch ${epoch6}.`);
    });


    /* ------------------------------------------------------------------
     *  STEP B  –  redelegate all stake N2 → N1
     * ------------------------------------------------------------------ */
    it('Redelegate steps – Step B (N2 → N1)', async function () {
      /* ──────────────── 1. PREPARATION & INITIAL STATE ───────────────── */
      const epoch = await contracts.chronos.getCurrentEpoch();
      console.log(`\n\n--- STEP B: Redelegate N2 -> N1 (Epoch ${epoch}) ---`);

      const d1isDelegatorN2_before =
        await contracts.delegatorsInfo.isNodeDelegator(
          nodeIds.node2Id,
          accounts.delegator1.address,
        );
      const d1LastStakeHeldN2_before =
        await contracts.delegatorsInfo.getLastStakeHeldEpoch(
          nodeIds.node2Id,
          accounts.delegator1.address,
        );
      console.log(
        `🔎 [B.1] Initial D1 on N2: isDelegator=${d1isDelegatorN2_before}, lastStakeHeldEpoch=${d1LastStakeHeldN2_before}`,
      );

      const d1BaseN2_before =
        await contracts.stakingStorage.getDelegatorStakeBase(
          nodeIds.node2Id,
          d1Key,
        );
      expect(
        d1BaseN2_before,
        'D1 must have stake on N2 to start Step B',
      ).to.be.gt(0n);

      /* ──────────────── 2. NODE-2 SUBMITS PROOF ───────── */
      console.log(`🔬 [B.2] Node2 submitting proof...`);

      await advanceToNextProofingPeriod(contracts);

      await ensureNodeHasChunksThisEpoch(
        nodeIds.node2Id,
        accounts.node2,
        contracts,
        accounts,
        receivingNodes,
        receivingNodesIdentityIds,
        chunkSize,
      );

      const n2Stake_beforeProof = await contracts.stakingStorage.getNodeStake(
        nodeIds.node2Id,
      );
      await submitProofAndVerifyScore(
        nodeIds.node2Id,
        accounts.node2,
        contracts,
        epoch,
        n2Stake_beforeProof,
      );
      console.log(`    ✅ Node2 proof submitted.`);

      /* ──────────────── 3. REDELEGATE N2 → N1 ─────────── */
      console.log(`✈️  [B.3] D1 redelegating all stake from N2 to N1...`);
      const n1Stake_beforeRedelegate =
        await contracts.stakingStorage.getNodeStake(node1Id);
      await contracts.staking
        .connect(accounts.delegator1)
        .redelegate(nodeIds.node2Id, node1Id, d1BaseN2_before);
      console.log('    ✅ Redelegation transaction sent.');

      /* ──────────────── 4. POST-SNAPSHOT & ASSERTIONS ──────────────── */
      console.log(`🔎 [B.4] Final State & Assertions...`);

      const [
        d1BaseN2_after,
        d1BaseN1_after,
        n2Stake_after,
        n1Stake_after,
        stillDelegatorOnN2,
        lastStakeHeldEpochN2,
      ] = await Promise.all([
        contracts.stakingStorage.getDelegatorStakeBase(nodeIds.node2Id, d1Key),
        contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key),
        contracts.stakingStorage.getNodeStake(nodeIds.node2Id),
        contracts.stakingStorage.getNodeStake(node1Id),
        contracts.delegatorsInfo.isNodeDelegator(
          nodeIds.node2Id,
          accounts.delegator1.address,
        ),
        contracts.delegatorsInfo.getLastStakeHeldEpoch(
          nodeIds.node2Id,
          accounts.delegator1.address,
        ),
      ]);

      console.log(
        `    - Final D1 on N2: isDelegator=${stillDelegatorOnN2}, lastStakeHeldEpoch=${lastStakeHeldEpochN2}`,
      );

      expect(d1BaseN2_after, 'D1 stake on N2 should now be zero').to.equal(0n);
      expect(d1BaseN1_after, 'Stake must fully move to N1').to.equal(
        d1BaseN2_before,
      );
      expect(n2Stake_after).to.equal(
        n2Stake_beforeProof - d1BaseN2_before,
        'N2 total stake should decrease by the redelegated amount',
      );
      expect(n1Stake_after).to.equal(
        n1Stake_beforeRedelegate + d1BaseN2_before,
        'N1 total stake should increase by the redelegated amount',
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(stillDelegatorOnN2, 'D1 must remain delegator on N2').to.equal(true);
      expect(
        lastStakeHeldEpochN2,
        'lastStakeHeldEpoch mismatch, should be set to current epoch',
      ).to.equal(epoch);
    });


    /**
     * STEP C – Move to the next epoch, explicitly call
     *          _validateDelegatorEpochClaims twice (N1 ✓, N2 ✗),
     *          then try the real redelegate which must revert.
     */
    it('STEP C – validate twice, cancelWithdrawal, then failed redelegate', async function () {
      /* ──────────────────────────────────────────────────────────────
       * 1️⃣  Advance exactly one epoch forward
       *     (make the test independent of the absolute epoch number)
       * ────────────────────────────────────────────────────────────── */
      const beforeEpoch = await contracts.chronos.getCurrentEpoch();
      const ttn = await contracts.chronos.timeUntilNextEpoch();
      await time.increase(ttn + 1n); // → +1 epoch
      const afterEpoch = await contracts.chronos.getCurrentEpoch();

      expect(afterEpoch).to.equal(
        beforeEpoch + 1n,
        'Epoch did not advance by exactly one',
      );
      console.log(`\n🚦  STEP C: now in epoch ${afterEpoch}`);

      /* ----------------------------------------------------------------
       * 1-b)  Finalise the *previous* epoch by creating a tiny KC
       *       (prevents "epoch not finalised" surprises in later claims)
       * ---------------------------------------------------------------- */
      await createKnowledgeCollection(
        accounts.kcCreator,
        accounts.node1, // any node is fine – we use N1
        Number(node1Id),
        receivingNodes,
        receivingNodesIdentityIds,
        { KnowledgeCollection: contracts.kc, Token: contracts.token },
        merkleRoot,
        'finalise-stepC',
        1, // holders
        chunkSize * 2, // byteSize - use multiple of chunkSize for proper chunk generation
        1, // replicas
        toTRAC(1), // 1 TRAC fee – enough to finalise
      );

      expect(
        await contracts.epochStorage.lastFinalizedEpoch(1),
        'Previous epoch should now be finalised',
      ).to.be.gte(afterEpoch - 1n);

      /* ----------------------------------------------------------------
       * Helper – current Delegator-1 stake on N1 (used later)
       * ---------------------------------------------------------------- */
      const stakeN1_start = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d1Key,
      );

      /* ──────────────────────────────────────────────────────────────
       * 2️⃣  Dry-run the internal validator through callStatic
       * ────────────────────────────────────────────────────────────── */
      console.log('\n🔍  Manual _validateDelegatorEpochClaims checks…');

      // 2-a) N1 – should **pass**
      await expect(
        contracts.staking
          .connect(accounts.delegator1)
          .requestWithdrawal.staticCall(node1Id, 1n), // 1 wei is enough
      ).to.not.be.reverted;
      console.log('    ✅ Validation on N1 passed');

      //   Make a real 1-wei withdrawal so we can cancel it immediately
      await contracts.staking
        .connect(accounts.delegator1)
        .requestWithdrawal(node1Id, 1n);
      await contracts.staking
        .connect(accounts.delegator1)
        .cancelWithdrawal(node1Id);
      console.log('    ↩️  requestWithdrawal + cancelWithdrawal on N1 succeeded');

      // 2-b) N2 – must **revert**
      await expect(
        contracts.staking
          .connect(accounts.delegator1)
          .requestWithdrawal.staticCall(nodeIds.node2Id, 1n),
      ).to.be.revertedWith(
        'Must claim rewards up to the lastStakeHeldEpoch before changing stake',
      );
      console.log('    ✅ Validation on N2 reverted as expected');

      /* ──────────────────────────────────────────────────────────────
       * 3️⃣  Attempt a real redelegate N1 ➜ N2 – must revert
       * ────────────────────────────────────────────────────────────── */
      const halfStake = stakeN1_start / 2n;
      console.log(
        `\n↪️  Attempting to redelegate ${ethers.formatUnits(halfStake, 18)} TRAC  N1 ➜ N2`,
      );

      await expect(
        contracts.staking
          .connect(accounts.delegator1)
          .redelegate(node1Id, nodeIds.node2Id, halfStake),
      ).to.be.revertedWith(
        'Must claim rewards up to the lastStakeHeldEpoch before changing stake',
      );
      console.log('    ✅ Redelegate reverted – pending N2 rewards not claimed');

      /* ──────────────────────────────────────────────────────────────
       * 4️⃣  Sanity-check – stake amounts must be unchanged
       * ────────────────────────────────────────────────────────────── */
      const stakeN1_end = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d1Key,
      );
      const stakeN2_end = await contracts.stakingStorage.getDelegatorStakeBase(
        nodeIds.node2Id,
        d1Key,
      );

      expect(stakeN1_end).to.equal(
        stakeN1_start,
        'Stake on N1 must remain unchanged',
      );
      expect(stakeN2_end).to.equal(0n, 'Stake on N2 must remain zero');

      console.log(
        `    ✅ State unchanged → N1: ${ethers.formatUnits(stakeN1_end, 18)} TRAC | ` +
          `N2: ${ethers.formatUnits(stakeN2_end, 18)} TRAC`,
      );
      console.log(`\n🚦  STEP C: now in epoch ${afterEpoch}`);
    });
});
