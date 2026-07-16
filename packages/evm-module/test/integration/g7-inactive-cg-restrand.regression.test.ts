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
 * REGRESSION for AUDIT FINDING G-7 — proof-of-storage liveness DoS via a
 * swept/deactivated context graph that is RE-STRANDED with sampling weight.
 * ============================================================================
 *
 * Root cause (now FIXED): the CG value-write paths
 * (`KnowledgeAssetsLifecycle.extendKnowledgeAssetLifetime` and the
 * `update`/`_executeUpdateCore` delta) had NO `isContextGraphActive(cgId)` gate.
 * `deactivateContextGraph` — wired in production via
 * `ContextGraphs.sweepContextGraphEscrow` — only flips `active = false` and does
 * NOT zero the Fenwick (BIT) weight leaf; `CGWeightTreeStorage.settle` then
 * re-strands the leaf to the raw ledger truth. So a NON-privileged actor could
 * write value to a swept CG, re-stranding a nonzero sampling-weight leaf. In
 * `RandomSampling._pickWeightedChallengeFull` a drawn inactive-but-weighted CG is
 * a retry-burning miss; >= `MAX_CG_RETRIES` (5) dominant such CGs exhaust the
 * budget and revert `createChallenge` (the liveness DoS), and the admin re-sweep
 * was bricked.
 *
 * The fix gates BOTH value-write paths (extend and the update delta) on
 * `isContextGraphActive`, reverting `CannotWriteValueToInactiveContextGraph`. The
 * third value-write caller, `_executePublishCore`, is already gated upstream —
 * `registerKnowledgeAssetToContextGraph` reverts `ContextGraphNotActive`.
 *
 * Tests in this file cover the `extendKnowledgeAssetLifetime` write path. The
 * `_executeUpdateCore` delta path carries the IDENTICAL one-line guard
 * (`if (!isContextGraphActive) revert CannotWriteValueToInactiveContextGraph`),
 * verified at compile time; exercising it end-to-end needs the full publish/update
 * attestation harness in `v10-pca-lifecycle.test.ts` and is out of scope here.
 *   CONTROL    — one live weighted CG ⇒ createChallenge succeeds (harness wired).
 *   CONTROL    — extend on an ACTIVE CG still succeeds and grows its weight
 *                (the gate only blocks inactive CGs).
 *   REGRESSION — sweep deactivates a CG, then a non-privileged
 *                `extendKnowledgeAssetLifetime` re-strand REVERTS and the CG stays
 *                weight-0.
 */
describe('@integration Regression G-7: deactivated-CG re-strand is gated at the value-write path', () => {
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
  // CONTROL — the gate only blocks INACTIVE CGs: extendKnowledgeAssetLifetime on
  // an ACTIVE CG still succeeds and re-strands (legitimately) its sampling weight.
  // Proves the G-7 fix does not regress the normal extend flow.
  // ────────────────────────────────────────────────────────────────────────
  it('CONTROL: extendKnowledgeAssetLifetime on an ACTIVE CG still succeeds and grows its weight', async () => {
    const extender = accounts[5];
    const epoch = await Chronos.getCurrentEpoch();

    // Same value-window timing as the regression below, but WITHOUT a sweep: at
    // currentEpoch == endEpoch the publish window has retracted (weight 0) yet the
    // CG is still ACTIVE, so the extend writes value over [currentEpoch, ...).
    const cg = await createPublicCG();
    const ka = await seedKaCustom(cg, epoch + 1n, epoch, 1n, 1000n);
    await time.increase(Number(await Chronos.epochLength()));
    expect(await Chronos.getCurrentEpoch()).to.equal(epoch + 1n);
    expect(await ContextGraphValueStorage.getCurrentCGValue(cg)).to.equal(0n);
    expect(await ContextGraphStorage.isContextGraphActive(cg)).to.equal(true);

    const amount = 1_000_000n;
    await (await Token.mint(extender.address, amount)).wait();
    await (await Token.connect(extender).approve(await KnowledgeAssetsLifecycle.getAddress(), amount)).wait();

    await (
      await KnowledgeAssetsLifecycle.connect(extender).extendKnowledgeAssetLifetime(ka, 5, amount)
    ).wait();

    // Active CG: the gate passes, value is written, weight grows.
    expect(await ContextGraphStorage.isContextGraphActive(cg)).to.equal(true);
    expect(await ContextGraphValueStorage.getCurrentCGValue(cg)).to.be.greaterThan(0n);
    expect(await CGWeightTreeStorage.cgWeight(cg)).to.be.greaterThan(0n);
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
  it('REGRESSION G-7: after sweep deactivates a CG, a non-privileged extendKnowledgeAssetLifetime re-strand is REJECTED (active gate)', async () => {
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

    // ── Step 2 (G-7 fix): the non-privileged re-strand via the value-write path is
    //    now REJECTED. extendKnowledgeAssetLifetime gates on isContextGraphActive and
    //    reverts on the deactivated CG, so its TRAC is never pulled. ──
    const extendAmount = 1_000_000n;
    await (await Token.mint(attacker.address, extendAmount)).wait();
    await (await Token.connect(attacker).approve(await KnowledgeAssetsLifecycle.getAddress(), extendAmount)).wait();

    await expect(
      KnowledgeAssetsLifecycle.connect(attacker).extendKnowledgeAssetLifetime(kaInX, 5, extendAmount),
    ).to.be.revertedWithCustomError(
      KnowledgeAssetsLifecycle,
      'CannotWriteValueToInactiveContextGraph',
    );

    // The CG stays retired: still inactive, weight leaf still 0, no live value
    // re-stranded — so the picker can never be starved by it.
    expect(await ContextGraphStorage.isContextGraphActive(cgX)).to.equal(false);
    expect(await CGWeightTreeStorage.cgWeight(cgX)).to.equal(0n);
    expect(await ContextGraphValueStorage.getCurrentCGValue(cgX)).to.equal(0n);
    // (the revert undoes the whole tx, so no TRAC is pulled from the attacker.)
  });
});
