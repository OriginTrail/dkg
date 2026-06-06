import {
  time,
  expect,
  hre,
  toTRAC,
  quads,
  ensureNodeHasChunksThisEpoch,
  advanceToNextProofingPeriod,
  submitProofAndLogScore,
  createKnowledgeCollection,
  createProfile,
  buildInitialRewardsState,
  type SignerWithAddress,
  type Token,
  type Profile,
  type ProfileStorage,
  type Staking,
  type Chronos,
  type RandomSamplingStorage,
  type EpochStorage,
  type KnowledgeCollection,
  type Hub,
  type StakingStorage,
  type RandomSampling,
  type Ask,
  type AskStorage,
  type ParametersStorage,
  type DelegatorsInfo,
  type ShardingTable,
} from './StakingRewards.shared';



describe.skip('Withdrawal request tests after further epochs (OBSOLETE: V8 rewards pipeline)', () => {
  let env: Awaited<ReturnType<typeof buildInitialRewardsState>>;
  let Staking: Staking,
    Chronos: Chronos,
    EpochStorage: EpochStorage,
    RandomSampling: RandomSampling,
    KC: KnowledgeCollection,
    Token: Token,
    RandomSamplingStorage: RandomSamplingStorage,
    StakingStorage: StakingStorage,
    ParametersStorage: ParametersStorage;
  let accounts: any, nodes: any[], delegators: SignerWithAddress[];
  let node1Id: number, node2Id: number, node3Id: number, node4Id: number;
  let chunkSize: number;
  let merkleRoot: string;

  before(async () => {
    env = await buildInitialRewardsState();
    // Unpack env
    ({
      Staking,
      Chronos,
      EpochStorage,
      RandomSampling,
      KC,
      Token,
      RandomSamplingStorage,
      StakingStorage,
      ParametersStorage,
      accounts,
      nodes,
      delegators,
    } = env);
    node1Id = nodes[0].identityId;
    node2Id = nodes[1].identityId;
    node3Id = nodes[2].identityId;
    node4Id = nodes[3].identityId;
    chunkSize = Number(await RandomSamplingStorage.CHUNK_BYTE_SIZE());
    // @ts-expect-error – dynamic CJS import of assertion-tools
    const { kcTools } = await import('assertion-tools');
    merkleRoot = kcTools.calculateMerkleRoot(quads, 32);

    // Initial state: current epoch is 7, last finalized is 6.

    // -------------------------------------------------------------------
    // Stabilize the RandomSampling KC pool before any `createChallenge()`
    // -------------------------------------------------------------------
    // `buildInitialRewardsState` leaves the CG populated with a mix of
    // expired KCs (most have `numberOfEpochs` ∈ {1,3,5} created in epochs
    // 2–6, so their `endEpoch` is ≤ 6) and a thin set of still-valid ones
    // (`finalize-epoch-3` / `finalize-epoch-5` / `finalize-epoch-6`).
    //
    // The V10 picker in `RandomSampling._pickWeightedChallenge` draws a
    // KC uniformly within the chosen CG and retries up to
    // `MAX_KC_RETRIES = 10` times on expired hits. With ~3 valid out of
    // ~8 KCs, the per-call miss probability is ~(5/8)^10 ≈ 0.93%. The
    // `before all` below fires `createChallenge()` 8 times across
    // epochs 7–8, so cumulative miss probability is ~7% — i.e. the run
    // is legitimately flaky on any seed permutation. Whether the seed
    // (`block.timestamp` / `block.difficulty`-derived) lands in the
    // unlucky region depends on the hardhat config: the coverage lane
    // (`pnpm test:coverage`) and the fast lane (`pnpm test` via
    // `hardhat.node.config.ts`) produce different block-times and
    // therefore different seeds, so v10-rc's slow lane happens to avoid
    // the miss region while the fast PR lane does not.
    //
    // The contract's revert is intended behavior — it signals a
    // genuinely empty eligible pool. The fix belongs here, in the test
    // harness: top up the pool with several long-lived KCs so the
    // picker's hit rate is overwhelming regardless of seed. Creating 5
    // KCs with `numberOfEpochs = 20` during epoch 7 yields `endEpoch`
    // = 26, keeping them valid through every proofing period this
    // suite touches (up to epoch 10 in the later `D1 withdrawal flow`
    // tests).
    //
    // This does not alter the rewards math the D1 tests assert on — the
    // test body only checks withdrawal-sequencing semantics
    // (`must claim all previous epoch rewards`), not per-epoch reward
    // amounts, so extra KCs in the pool are observationally invisible
    // to the assertions.
    for (let i = 0; i < 5; i++) {
      await createKnowledgeCollection(
        accounts.kcCreator,
        accounts.node1,
        node1Id,
        [accounts.node2, accounts.node3, accounts.node4],
        [node2Id, node3Id, node4Id],
        { KnowledgeCollection: KC, Token },
        merkleRoot,
        `d1-picker-stabilize-${i}`,
        1,
        chunkSize,
        20,
        toTRAC(100),
      );
    }

    // --- Epoch 7 ---
    console.log('\n⏳ Advancing through epoch 7 with proofs...');
    await advanceToNextProofingPeriod({ randomSampling: RandomSampling });
    for (const [, node] of nodes.entries()) {
      await submitProofAndLogScore(
        node.identityId,
        { operational: node.operational, admin: node.admin },
        {
          randomSampling: RandomSampling,
          randomSamplingStorage: RandomSamplingStorage,
        },
        7n,
      );
    }
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n); // Move to epoch 8

    // --- Epoch 8 ---
    console.log('\n⏳ Advancing through epoch 8 with proofs...');
    await createKnowledgeCollection(
      accounts.kcCreator,
      accounts.node1,
      node1Id,
      [accounts.node2, accounts.node3, accounts.node4],
      [node2Id, node3Id, node4Id],
      { KnowledgeCollection: KC, Token },
      merkleRoot,
      'epoch-8-kc',
      10,
      chunkSize * 10,
      1,
      toTRAC(1000),
    );
    await advanceToNextProofingPeriod({ randomSampling: RandomSampling });
    for (const [, node] of nodes.entries()) {
      await submitProofAndLogScore(
        node.identityId,
        { operational: node.operational, admin: node.admin },
        {
          randomSampling: RandomSampling,
          randomSamplingStorage: RandomSamplingStorage,
        },
        8n,
      );
    }
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n); // Move to epoch 9

    // --- Epoch 9 (No proofs) ---
    console.log('\n⏳ Advancing through epoch 9 without proofs...');
    await createKnowledgeCollection(
      accounts.kcCreator,
      accounts.node2,
      node2Id,
      [accounts.node1, accounts.node3, accounts.node4],
      [node1Id, node3Id, node4Id],
      { KnowledgeCollection: KC, Token },
      merkleRoot,
      'epoch-9-kc',
      10,
      chunkSize * 10,
      1,
      toTRAC(1000),
    );
    console.log(
      `\n✅ Initial setup complete. Current epoch: ${await Chronos.getCurrentEpoch()}, Last finalized: ${await EpochStorage.lastFinalizedEpoch(1)}`,
    );
  });



  it('D1 withdrawal request flow: must claim all reward epochs (2-8)', async () => {
    const d1 = delegators[0];
    const d1Address = d1.address;
    const node1 = nodes[0];

    console.log(
      `\n🔒 TEST D1: Starting in Epoch ${await Chronos.getCurrentEpoch()}. Last Finalized: ${await EpochStorage.lastFinalizedEpoch(
        1,
      )}`,
    );

    console.log(
      '🔒 TEST D1: Claiming all epochs except 7 & 8, then attempting withdrawal...',
    );
    for (const epoch of [2n, 3n, 4n, 5n, 6n]) {
      await Staking.connect(d1).claimDelegatorRewards(
        node1.identityId,
        epoch,
        d1Address,
      );
    }
    console.log('  ✅ D1 claimed epochs 2-6.');
    await expect(
      Staking.connect(d1).requestWithdrawal(node1.identityId, toTRAC(10000)),
    ).to.be.revertedWith(
      'Must claim all previous epoch rewards before changing stake',
    );
    console.log('  ❌ D1 withdrawal failed as expected (epoch 7 not claimed).');

    console.log(
      '\n🔒 TEST D1: Claiming epoch 7, then attempting withdrawal...',
    );
    await Staking.connect(d1).claimDelegatorRewards(
      node1.identityId,
      7n,
      d1Address,
    );
    console.log('  ✅ D1 claimed epoch 7.');
    await expect(
      Staking.connect(d1).requestWithdrawal(node1.identityId, toTRAC(10000)),
    ).to.be.revertedWith(
      'Must claim the previous epoch rewards before changing stake',
    );
    console.log('  ❌ D1 withdrawal failed as expected (epoch 8 not claimed).');

    console.log(
      '\n🔒 TEST D1: Claiming epoch 8, then attempting withdrawal...',
    );
    await Staking.connect(d1).claimDelegatorRewards(
      node1.identityId,
      8n,
      d1Address,
    );
    console.log('  ✅ D1 claimed epoch 8.');

    const d1Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [d1.address]),
    );
    const d1StakeBaseBefore = await StakingStorage.getDelegatorStakeBase(
      node1.identityId,
      d1Key,
    );
    const d1WithdrawalAmount = toTRAC(10000);

    await expect(
      Staking.connect(d1).requestWithdrawal(
        node1.identityId,
        d1WithdrawalAmount,
      ),
    ).to.not.be.reverted;
    console.log('  ✅ D1 withdrawal succeeded as expected.');

    const d1StakeBaseAfter = await StakingStorage.getDelegatorStakeBase(
      node1.identityId,
      d1Key,
    );
    expect(d1StakeBaseBefore - d1StakeBaseAfter).to.equal(d1WithdrawalAmount);
    console.log(
      `  ✅ D1 stakeBase correctly reduced by ${hre.ethers.formatUnits(d1WithdrawalAmount, 18)} TRAC.`,
    );
  });

  it('D2 withdrawal request flow: must claim reward epochs (2-8), can skip no-reward epoch (9)', async () => {
    const d2 = delegators[1];
    const d2Address = d2.address;
    const node1 = nodes[0];

    console.log(
      `\n⏳ TEST D2: Starting in Epoch ${await Chronos.getCurrentEpoch()}. Advancing to Epoch 10 and finalizing epoch 9...`,
    );
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n); // Move to epoch 10
    // Create a KC in epoch 10 to trigger finalization of epoch 9
    await createKnowledgeCollection(
      accounts.kcCreator,
      accounts.node3, // any node
      node3Id,
      [accounts.node1, accounts.node2, accounts.node4],
      [node1Id, node2Id, node4Id],
      { KnowledgeCollection: KC, Token },
      merkleRoot,
      'finalize-epoch-9',
      1,
      chunkSize,
      1,
      toTRAC(1),
    );
    console.log(
      `✅ TEST D2: Now in Epoch ${await Chronos.getCurrentEpoch()}. Last Finalized: ${await EpochStorage.lastFinalizedEpoch(
        1,
      )}`,
    );

    console.log(
      '🔒 TEST D2: Claiming all epochs except 8 & 9, then attempting withdrawal...',
    );
    for (const epoch of [2n, 3n, 4n, 5n, 6n, 7n]) {
      await Staking.connect(d2).claimDelegatorRewards(
        node1.identityId,
        epoch,
        d2Address,
      );
    }
    console.log('  ✅ D2 claimed epochs 2-7.');
    await expect(
      Staking.connect(d2).requestWithdrawal(node1.identityId, toTRAC(20000)),
    ).to.be.revertedWith(
      'Must claim all previous epoch rewards before changing stake',
    );
    console.log('  ❌ D2 withdrawal failed as expected (epoch 8 not claimed).');

    console.log(
      '\n🔒 TEST D2: Claiming epoch 8, then attempting withdrawal...',
    );
    await Staking.connect(d2).claimDelegatorRewards(
      node1.identityId,
      8n,
      d2Address,
    );
    console.log('  ✅ D2 claimed epoch 8.');

    const d2Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [d2.address]),
    );
    const d2StakeBaseBefore = await StakingStorage.getDelegatorStakeBase(
      node1.identityId,
      d2Key,
    );
    const d2WithdrawalAmount = toTRAC(20000);

    await expect(
      Staking.connect(d2).requestWithdrawal(
        node1.identityId,
        d2WithdrawalAmount,
      ),
    ).to.not.be.reverted;
    console.log(
      '  ✅ D2 withdrawal succeeded as expected (epoch 9 had no rewards and could be skipped for withdrawal).',
    );

    const d2StakeBaseAfter = await StakingStorage.getDelegatorStakeBase(
      node1.identityId,
      d2Key,
    );
    expect(d2StakeBaseBefore - d2StakeBaseAfter).to.equal(d2WithdrawalAmount);
    console.log(
      `  ✅ D2 stakeBase correctly reduced by ${hre.ethers.formatUnits(d2WithdrawalAmount, 18)} TRAC.`,
    );

    console.log(
      '  ❌ Attempting to finalize D2 withdrawal immediately (should fail)...',
    );
    await expect(
      Staking.connect(d2).finalizeWithdrawal(node1.identityId),
    ).to.be.revertedWithCustomError(Staking, 'WithdrawalPeriodPending');
    console.log('  ✅ Reverted as expected (delay not passed).');
  });

});
