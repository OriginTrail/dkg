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
     *  STEP D – two un-claimed epochs, claim one, redelegate half, check rolling
    /* ------------------------------------------------------------------
   *  STEP D – epoch-8: claim epoch-6 on N2 (→ goes to rollingRewards),
   *           redelegate half of live stake N1 → N2, verify state
   * ------------------------------------------------------------------ */
    it('STEP D – claim one on N2, redelegate half, check rolling', async function () {
      const delegator = accounts.delegator1;
      const fmt = (x: bigint) => ethers.formatUnits(x, 18);

      /* ── 0. Move to epoch-8 and finalise epoch-7 ────────────────────── */
      await time.increase((await contracts.chronos.timeUntilNextEpoch()) + 1n); // → 8
      const epoch8 = await contracts.chronos.getCurrentEpoch();

      await createKnowledgeCollection(
        accounts.kcCreator,
        accounts.node1,
        Number(node1Id),
        receivingNodes,
        receivingNodesIdentityIds,
        { KnowledgeCollection: contracts.kc, Token: contracts.token },
        merkleRoot,
        'finalise-ep7',
        1,
        chunkSize * 2, // byteSize - use multiple of chunkSize for proper chunk generation
        1,
        toTRAC(1),
      );
      expect(await contracts.epochStorage.lastFinalizedEpoch(1)).to.be.gte(7n);

      console.log(
        '\n────────────── STEP D – STATE BEFORE ACTIONS ──────────────',
      );
      console.log(`[D-0] Current epoch: ${epoch8}`);

      /* ── 1. Quick sanity check for claimable epochs ────────────────── */
      const lastClaimedN1 = await contracts.delegatorsInfo.getLastClaimedEpoch(
        node1Id,
        delegator.address,
      ); // 6
      const lastClaimedN2 = await contracts.delegatorsInfo.getLastClaimedEpoch(
        nodeIds.node2Id,
        delegator.address,
      ); // 5
      const lastStakeHeldN2 =
        await contracts.delegatorsInfo.getLastStakeHeldEpoch(
          nodeIds.node2Id,
          delegator.address,
        ); // 6

      console.log(`[D-1] N1.lastClaimed = ${lastClaimedN1}`);
      console.log(`[D-1] N2.lastClaimed = ${lastClaimedN2}`);
      console.log(`[D-1] N2.lastStakeHeldEpoch = ${lastStakeHeldN2}`);

      // exactly one claimable epoch on N2 → epoch-6
      expect(lastClaimedN2 + 1n).to.equal(lastStakeHeldN2);
      expect(epoch8 - lastClaimedN2).to.equal(3n); // epochs 6-8

      /* ── 2. Claim epoch-6 on N2 (gap = 2 ⇒ reward → rollingRewards) ── */
      const [baseN2_before, rollingN2_before, nodeScore6, delegScore6, pool6] =
        await Promise.all([
          contracts.stakingStorage.getDelegatorStakeBase(nodeIds.node2Id, d1Key),
          contracts.delegatorsInfo.getDelegatorRollingRewards(
            nodeIds.node2Id,
            delegator.address,
          ),
          contracts.randomSamplingStorage.getNodeEpochScore(6n, nodeIds.node2Id),
          contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
            6n,
            nodeIds.node2Id,
            d1Key,
          ),
          contracts.stakingKPI.getNetNodeRewards(nodeIds.node2Id, 6n),
        ]);
      const expectedReward6 =
        nodeScore6 === 0n ? 0n : (delegScore6 * pool6) / nodeScore6;

      console.log('\n[D-2] BEFORE claim epoch-6 on N2');
      console.log(`   baseN2        : ${fmt(baseN2_before)} TRAC`);
      console.log(`   rollingN2     : ${fmt(rollingN2_before)} TRAC`);
      console.log(`   expectedReward: ${fmt(expectedReward6)} TRAC`);

      await contracts.staking
        .connect(delegator)
        .claimDelegatorRewards(nodeIds.node2Id, 6n, delegator.address);

      const [baseN2_after, rollingN2_after, lastClaimedN2_after] =
        await Promise.all([
          contracts.stakingStorage.getDelegatorStakeBase(nodeIds.node2Id, d1Key),
          contracts.delegatorsInfo.getDelegatorRollingRewards(
            nodeIds.node2Id,
            delegator.address,
          ),
          contracts.delegatorsInfo.getLastClaimedEpoch(
            nodeIds.node2Id,
            delegator.address,
          ),
        ]);

      console.log('\n[D-2] AFTER  claim epoch-6 on N2');
      console.log(`   baseN2        : ${fmt(baseN2_after)} TRAC`);
      console.log(`   rollingN2     : ${fmt(rollingN2_after)} TRAC`);
      console.log(`   lastClaimedN2 : ${lastClaimedN2_after}`);

      // reward should sit in rollingRewards, stake stays unchanged
      expect(baseN2_after).to.equal(baseN2_before, 'base stake unchanged');
      expect(rollingN2_after - rollingN2_before).to.equal(
        expectedReward6,
        'rolling diff',
      );
      expect(lastClaimedN2_after).to.equal(6n);

      /* ── 3. Redelegate half of live stake  N1 → N2 ─────────────────── */
      const baseN1_before = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        d1Key,
      );
      const halfStake = baseN1_before / 2n;

      const [n1Total_before, n2Total_before] = await Promise.all([
        contracts.stakingStorage.getNodeStake(node1Id),
        contracts.stakingStorage.getNodeStake(nodeIds.node2Id),
      ]);

      console.log('\n[D-3] BEFORE redelegate');
      console.log(`   baseN1        : ${fmt(baseN1_before)} TRAC`);
      console.log(`   baseN2        : ${fmt(baseN2_after)} TRAC`);
      console.log(`   halfStake     : ${fmt(halfStake)} TRAC`);

      await contracts.staking
        .connect(delegator)
        .redelegate(node1Id, nodeIds.node2Id, halfStake);

      /* ── 4. Post-redelegate assertions & logs ──────────────────────── */
      const [
        baseN1_after,
        baseN2_final,
        n1Total_after,
        n2Total_after,
        rollingN1_final,
        rollingN2_final,
      ] = await Promise.all([
        contracts.stakingStorage.getDelegatorStakeBase(node1Id, d1Key),
        contracts.stakingStorage.getDelegatorStakeBase(nodeIds.node2Id, d1Key),
        contracts.stakingStorage.getNodeStake(node1Id),
        contracts.stakingStorage.getNodeStake(nodeIds.node2Id),
        contracts.delegatorsInfo.getDelegatorRollingRewards(
          node1Id,
          delegator.address,
        ),
        contracts.delegatorsInfo.getDelegatorRollingRewards(
          nodeIds.node2Id,
          delegator.address,
        ),
      ]);

      console.log('\n[D-4] AFTER redelegate');
      console.log(`   baseN1        : ${fmt(baseN1_after)} TRAC`);
      console.log(`   baseN2        : ${fmt(baseN2_final)} TRAC`);
      console.log(
        `   N1 total stake: ${fmt(n1Total_before)} ➜ ${fmt(n1Total_after)} TRAC`,
      );
      console.log(
        `   N2 total stake: ${fmt(n2Total_before)} ➜ ${fmt(n2Total_after)} TRAC`,
      );
      console.log(`   rollingN1     : ${fmt(rollingN1_final)} TRAC`);
      console.log(`   rollingN2     : ${fmt(rollingN2_final)} TRAC\n`);

      // stake balances
      expect(baseN1_after).to.equal(baseN1_before - halfStake);
      expect(baseN2_final).to.equal(baseN2_after + halfStake);
      expect(n1Total_after).to.equal(n1Total_before - halfStake);
      expect(n2Total_after).to.equal(n2Total_before + halfStake);

      // rollingRewards must stay the same after redelegate
      expect(rollingN2_final).to.equal(
        rollingN2_after,
        'rolling on N2 unchanged',
      );
      expect(rollingN1_final).to.equal(0n, 'rolling on N1 remains zero');

      console.log(
        `    ✔ Redelegate OK – N1:${fmt(baseN1_after)} | N2:${fmt(baseN2_final)} TRAC`,
      );
    });
});
