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
} from '../../typechain';
import { createProfile } from '../helpers/profile-helpers';

// CONTENT-BINDING (proof-of-storage empty-proof fix): submitProof takes
// `(bytes content, bytes32[] proof)` and derives `leaf = keccak256(content)`
// on-chain — a caller can no longer echo a stored 32-byte root as a self-asserted
// leaf with an empty proof. Every KA below is single-leaf (merkleLeafCount /
// catalogLeafCount = 1 ⇒ challenge chunkId always 0), keeping the subtree shapes
// trivial and avoiding the kcTools-sorts-pairs vs on-chain-pairs-positionally
// mismatch (orthogonal to what these tests cover: store-routing and, in C2,
// catalog-root pinning).

// ── PUBLIC structured single-leaf KA (Test A, B) ──
// 1-leaf public tree ⇒ publicRoot == its only leaf == keccak256(publicContent).
// The committed KA root is the STRUCTURED root hashPair(publicRoot, privateDataHash);
// with no private data the sibling is SENTINEL_NO_PRIVATE. The on-chain fold for
// chunkId 0 is keccak256(leaf ++ sib), so the honest proof carries exactly the
// single private sibling [SENTINEL_NO_PRIVATE] and merkleRoot == keccak256(publicRoot ++ SENTINEL).
const SENTINEL_NO_PRIVATE = ethers.keccak256(
  ethers.toUtf8Bytes('DKG_NO_PRIVATE_DATA_V10'),
);
const publicContent = ethers.toUtf8Bytes('r3-seam-public-leaf-content');
const publicRoot = ethers.keccak256(publicContent); // 1-leaf tree: root == leaf
const merkleRoot = ethers.keccak256(
  ethers.concat([publicRoot, SENTINEL_NO_PRIVATE]),
); // structured KA root = hashPair(publicRoot, privateDataHash)
const publicProof = [SENTINEL_NO_PRIVATE];

// Decoy PUBLIC merkle root for the curated KA (Test C). The curated KA records
// this as its plaintext `merkleRoot`, but its PUBLIC `_catalog` commitment root
// (`catalogRoot` below) is the real proof target. A challenge MISclassified as
// public would verify against THIS decoy and fail — that's the RED the pin
// prevents (OT-RFC-49: curated proofs target the catalog, not the plaintext
// merkle root).
const decoyMerkleRoot = ethers.keccak256(
  ethers.toUtf8Bytes('r3-seam-decoy-public-root'),
);

// ── CURATED catalog single-leaf KA (Test C, C2) ──
// The curated `_catalog` is a PLAIN public tree (NO private sibling). 1-leaf ⇒
// catalogRoot == keccak256(catalogContent) and an EMPTY proof verifies (h == root).
const catalogContent = ethers.toUtf8Bytes('r3-seam-catalog-content');
const catalogRoot = ethers.keccak256(catalogContent);

// OT-RFC-49 / WS-B Trap 1 (proof-race, Test C2): a NEW catalog the curated KA
// rotates to AFTER its challenge is issued. An honest proof built against the
// PINNED issuance-time catalog (`catalogContent`) must still verify; a proof
// against this rotated live catalog must fail, because `submitProof` reads the
// pinned `challenge.challengeRoot`, never the live `getCatalogRoot`.
const rotatedCatalogContent = ethers.toUtf8Bytes('r3-seam-rotated-catalog-content');
const rotatedCatalogRoot = ethers.keccak256(rotatedCatalogContent);

const OPEN_POLICY = 1; // public CG (accessPolicy=0 ⇒ getIsCurated()=false ⇒ merkle path)
const CURATED_ACCESS = 1; // accessPolicy=1 ⇒ getIsCurated()=true ⇒ catalog path
const TEST_KA_BYTE_SIZE = 128n;

/**
 * V10 `RandomSampling.submitProof` happy path — NOT exercised by any running
 * test today (the integration suite's Proof-Submission block is behind
 * `describe.skip(... OBSOLETE: V8 stake pipeline)`). Uses the V10-clean
 * direct-storage setup from RandomSampling-curated.test.ts (an `onlyContracts`
 * operator seeds the KA + CG state), plus createProfile + ShardingTable
 * insertNode for the challenging node. No stake: proof verification is
 * stake-independent (stake only gates the post-proof score checkpoint).
 *
 * Test B pins the OT-RFC-43 / R3 multi-store (generation) seam: submitProof
 * verifies against the KA store RECORDED in the challenge
 * (`challenge.knowledgeAssetStorageContract`), not the currently-bound
 * singleton. Re-pointing the Hub's `DKGKnowledgeAssets` to an empty second
 * store and re-initializing RandomSampling MUST NOT break verification of a
 * challenge issued against the first store. RED on the pre-seam code (which
 * read the bound singleton → empty store-B → revert), GREEN with the seam.
 */
describe('@integration RandomSampling submitProof + multi-store seam (R3)', () => {
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
  let kaNumber = 0n;

  async function deployFixture() {
    await hre.deployments.fixture([
      'Token',
      'Hub',
      'ParametersStorage',
      'WhitelistStorage',
      'IdentityStorage',
      'ShardingTableStorage',
      'ShardingTable',
      'StakingStorage',
      'ProfileStorage',
      'Chronos',
      'EpochStorage',
      'DKGKnowledgeAssets',
      'AskStorage',
      'DelegatorsInfo',
      'RandomSamplingStorage',
      'ContextGraphValueStorage',
      'ContextGraphStorage',
      'RandomSampling',
      'Profile',
    ]);
    accounts = await hre.ethers.getSigners();
    Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    // Grants accounts[19] the right to call `onlyContracts` setters on the
    // storage contracts directly (createContextGraph / createKnowledgeAsset /
    // registerKnowledgeAssetToContextGraph / addCGValueForEpochRange).
    await Hub.setContractAddress('TestStorageOperator', accounts[19].address);

    RandomSampling =
      await hre.ethers.getContract<RandomSampling>('RandomSampling');
    RandomSamplingStorage = await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    );
    Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    DKGKnowledgeAssets =
      await hre.ethers.getContract<DKGKnowledgeAssets>('DKGKnowledgeAssets');
    Profile = await hre.ethers.getContract<Profile>('Profile');
    ShardingTable =
      await hre.ethers.getContract<ShardingTable>('ShardingTable');
    ContextGraphStorage = await hre.ethers.getContract<ContextGraphStorage>(
      'ContextGraphStorage',
    );
    ContextGraphValueStorage =
      await hre.ethers.getContract<ContextGraphValueStorage>(
        'ContextGraphValueStorage',
      );
    CGWeightTreeStorage =
      await hre.ethers.getContract<CGWeightTreeStorage>('CGWeightTreeStorage');
    // Phase 10.x — unlock the BIT index (fresh chain) so createChallenge can draw;
    // accounts[19] is a registered Hub contract so it passes onlyContracts.
    await CGWeightTreeStorage.connect(accounts[19]).finishBackfill();
    opSigner = accounts[19];
    kaNumber = 0n;
  }

  // OT-RFC-43 (1a): author-namespaced packed id in opSigner's namespace.
  function nextKaId(): bigint {
    kaNumber += 1n;
    return (BigInt(opSigner.address) << 96n) | kaNumber;
  }

  async function createPublicCG(): Promise<bigint> {
    await (
      await ContextGraphStorage.connect(opSigner).createContextGraph(
        accounts[1].address, // owner
        [], // participantAgents
        0, // metadataBatchId
        0, // accessPolicy = 0 ⇒ public (not curated)
        OPEN_POLICY, // publishPolicy
        ethers.ZeroAddress, // publishAuthority
        0, // publishAuthorityAccountId
        ethers.ZeroHash, // nameHash
      )
    ).wait();
    return ContextGraphStorage.getLatestContextGraphId();
  }

  // Seed a KA directly on DKGKnowledgeAssets (merkleLeafCount=1 ⇒ challenge
  // chunkId is always 0) with OUR merkleRoot, register it to `cgId`, and give
  // the CG non-zero per-epoch value so the picker selects it.
  async function seedKa(cgId: bigint): Promise<bigint> {
    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + 5n;
    const receipt = await (
      await DKGKnowledgeAssets.connect(opSigner).createKnowledgeAsset(
        opSigner.address, // author (kaId>>96 must equal this)
        opSigner.address, // publisher
        nextKaId(),
        'seam-test-op',
        merkleRoot,
        1, // knowledgeAssetsAmount
        TEST_KA_BYTE_SIZE,
        currentEpoch,
        endEpoch,
        0, // tokenAmount
        false, // isImmutable
        1, // merkleLeafCount
      )
    ).wait();
    const iface = DKGKnowledgeAssets.interface;
    const topic = iface.getEvent('KnowledgeAssetCreated')!.topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === topic)!;
    const kaId = iface.parseLog(
      log as unknown as { topics: string[]; data: string },
    )!.args[0] as bigint;

    await (
      await ContextGraphStorage.connect(
        opSigner,
      ).registerKnowledgeAssetToContextGraph(cgId, kaId)
    ).wait();
    await (
      await ContextGraphValueStorage.connect(opSigner).addCGValueForEpochRange(
        cgId,
        currentEpoch,
        5n, // lifetime epochs
        1_000n, // per-epoch value
      )
    ).wait();
    // settle-on-spend: reconcile the BIT leaf so createChallenge can draw this CG.
    await (await CGWeightTreeStorage.connect(opSigner).settle(cgId)).wait();
    return kaId;
  }

  // Like seedKa but with explicit KA expiry / value lifetime / per-epoch weight — used by the
  // settle-on-miss test to build a dominant CG that goes stale (KA expires + value decays) while
  // its BIT leaf keeps the old (over-stated) weight until something settles it.
  async function seedKaCustom(
    cgId: bigint,
    kaEndEpoch: bigint,
    lifetime: bigint,
    value: bigint,
  ): Promise<bigint> {
    const currentEpoch = await Chronos.getCurrentEpoch();
    const receipt = await (
      await DKGKnowledgeAssets.connect(opSigner).createKnowledgeAsset(
        opSigner.address,
        opSigner.address,
        nextKaId(),
        'seam-settle-miss',
        merkleRoot,
        1,
        TEST_KA_BYTE_SIZE,
        currentEpoch,
        kaEndEpoch,
        0,
        false,
        1,
      )
    ).wait();
    const iface = DKGKnowledgeAssets.interface;
    const topic = iface.getEvent('KnowledgeAssetCreated')!.topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === topic)!;
    const kaId = iface.parseLog(
      log as unknown as { topics: string[]; data: string },
    )!.args[0] as bigint;
    await (
      await ContextGraphStorage.connect(opSigner).registerKnowledgeAssetToContextGraph(cgId, kaId)
    ).wait();
    await (
      await ContextGraphValueStorage.connect(opSigner).addCGValueForEpochRange(
        cgId,
        currentEpoch,
        lifetime,
        value,
      )
    ).wait();
    await (await CGWeightTreeStorage.connect(opSigner).settle(cgId)).wait();
    return kaId;
  }

  // Curated variant of createPublicCG: accessPolicy=1 ⇒ getIsCurated()=true.
  // publishPolicy stays OPEN so no publishAuthority is required.
  async function createCuratedCG(): Promise<bigint> {
    await (
      await ContextGraphStorage.connect(opSigner).createContextGraph(
        accounts[1].address, // owner
        [], // participantAgents
        0, // metadataBatchId
        CURATED_ACCESS, // accessPolicy = 1 ⇒ curated
        OPEN_POLICY, // publishPolicy = open ⇒ zero authority
        ethers.ZeroAddress, // publishAuthority
        0, // publishAuthorityAccountId
        ethers.ZeroHash, // nameHash
      )
    ).wait();
    return ContextGraphStorage.getLatestContextGraphId();
  }

  // Seed a CURATED KA: its plaintext `merkleRoot` is a DECOY, but its PUBLIC
  // `_catalog` commitment (the curated proof substrate, OT-RFC-49) carries the
  // real `merkleRoot` with count=1. The curated picker needs
  // `getCatalogLeafCount != 0`; the challenge pins `getCatalogRoot` at issuance
  // and submitProof verifies against that pinned `challenge.challengeRoot`.
  async function seedCuratedKa(cgId: bigint): Promise<bigint> {
    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + 5n;
    const receipt = await (
      await DKGKnowledgeAssets.connect(opSigner).createKnowledgeAsset(
        opSigner.address,
        opSigner.address,
        nextKaId(),
        'seam-test-curated',
        decoyMerkleRoot, // plaintext root = decoy (public branch would use this)
        1,
        TEST_KA_BYTE_SIZE,
        currentEpoch,
        endEpoch,
        0,
        false,
        1, // merkleLeafCount
      )
    ).wait();
    const iface = DKGKnowledgeAssets.interface;
    const topic = iface.getEvent('KnowledgeAssetCreated')!.topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === topic)!;
    const kaId = iface.parseLog(
      log as unknown as { topics: string[]; data: string },
    )!.args[0] as bigint;

    // The real curated proof target: catalog root == `catalogRoot` (plain tree,
    // no private sibling), count=1 (single-leaf ⇒ chunkId 0; an honest proof is
    // `submitProof(catalogContent, [])` since keccak256(catalogContent) == catalogRoot).
    await (
      await DKGKnowledgeAssets.connect(opSigner).setCatalogCommitment(
        kaId,
        catalogRoot,
        1,
      )
    ).wait();

    await (
      await ContextGraphStorage.connect(
        opSigner,
      ).registerKnowledgeAssetToContextGraph(cgId, kaId)
    ).wait();
    await (
      await ContextGraphValueStorage.connect(opSigner).addCGValueForEpochRange(
        cgId,
        currentEpoch,
        5n,
        1_000n,
      )
    ).wait();
    // settle-on-spend: reconcile the BIT leaf so createChallenge can draw this CG.
    await (await CGWeightTreeStorage.connect(opSigner).settle(cgId)).wait();
    return kaId;
  }

  async function setupChallengingNode() {
    const node = { operational: accounts[2], admin: accounts[1] };
    const { identityId } = await createProfile(Profile, node);
    // @ts-expect-error – direct insertNode for test setup (owner bypasses onlyContracts)
    await ShardingTable.connect(accounts[0]).insertNode(identityId);
    return { ...node, identityId };
  }

  async function seedKaCgNodeAndChallenge() {
    const cgId = await createPublicCG();
    const kaId = await seedKa(cgId);
    const node = await setupChallengingNode();

    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    await RandomSampling.connect(node.operational).createChallenge();
    const challenge = await RandomSamplingStorage.getNodeChallenge(
      node.identityId,
    );
    return { node, kaId, challenge };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    await loadFixture(deployFixture);
  });

  it('Test E — createChallenge reverts ChallengeDrawPaused while the BIT index is backfill-locked', async () => {
    const node = await setupChallengingNode();
    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();

    // Swap in a fresh, still-LOCKED CGWeightTreeStorage and re-point RandomSampling at it
    // (the migration window). accounts[0] is the Hub owner: setContractAddress is
    // onlyHubOwner and initialize() is onlyHub (owner allowed).
    const Factory = await hre.ethers.getContractFactory('CGWeightTreeStorage');
    const lockedTree = await Factory.connect(accounts[0]).deploy(
      await Hub.getAddress(),
      2n ** 21n,
    );
    await lockedTree.waitForDeployment();
    await Hub.connect(accounts[0]).setContractAddress(
      'CGWeightTreeStorage',
      await lockedTree.getAddress(),
    );
    await RandomSampling.connect(accounts[0]).initialize(); // re-resolve to the locked tree
    expect(await lockedTree.backfillLocked()).to.equal(true);

    // The gate fires before the draw, so no seeded CG is needed.
    await expect(
      RandomSampling.connect(node.operational).createChallenge(),
    ).to.be.revertedWithCustomError(RandomSampling, 'ChallengeDrawPaused');
  });

  it('Test F — createChallenge settle-on-miss: a dominant STALE CG is reconciled (and the reconcile PERSISTS) before the draw lands on a live CG', async () => {
    const node = await setupChallengingNode();
    const epoch = await Chronos.getCurrentEpoch();

    // Stale-dominant CG A: huge per-epoch weight (1e24/2 = 5e23), short lifetime, KA expires soon.
    const cgA = await createPublicCG();
    await seedKaCustom(cgA, epoch + 2n, 2n, 10n ** 24n);
    // Live CG B: tiny weight (1), long lifetime, KA lives long.
    const cgB = await createPublicCG();
    const kaB = await seedKaCustom(cgB, epoch + 1000n, 1000n, 1000n);

    const leafA0 = await CGWeightTreeStorage.cgWeight(cgA);
    const leafB0 = await CGWeightTreeStorage.cgWeight(cgB);
    // A's stale leaf dominates the weighted draw, so createChallenge deterministically lands on A first.
    expect(leafA0).to.be.greaterThan(leafB0 * 10n ** 6n);

    // Advance past A's lifetime + KA expiry, but well within B's. No re-settle, so A's BIT leaf
    // stays at the old (over-stated) weight while its ledger value has decayed to 0.
    const epochSeconds = Number(await Chronos.epochLength());
    await time.increase(epochSeconds * 3);
    const now = await Chronos.getCurrentEpoch();
    expect(await ContextGraphValueStorage.getCGValueAtEpoch(cgA, now)).to.equal(0n); // A decayed
    expect(await ContextGraphValueStorage.getCGValueAtEpoch(cgB, now)).to.be.greaterThan(0n); // B live
    expect(await CGWeightTreeStorage.cgWeight(cgA)).to.equal(leafA0); // leaf still stale (over-stated)

    // Production path: A dominates → drawn first → KA expired → settle-on-miss reconciles A's
    // leaf to its true (0) value → A excluded → re-draw lands on the live CG B → SUCCESS (commits).
    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    await RandomSampling.connect(node.operational).createChallenge();
    const ch = await RandomSamplingStorage.getNodeChallenge(node.identityId);

    // The challenge is for the live CG B...
    expect(ch.knowledgeAssetId).to.equal(kaB);
    // ...and settle-on-miss reconciled A's stale leaf to 0 AND it PERSISTED (the tx committed).
    expect(await CGWeightTreeStorage.cgWeight(cgA)).to.equal(0n);
    // B was the winning draw (not a miss), so its leaf is untouched.
    expect(await CGWeightTreeStorage.cgWeight(cgB)).to.equal(leafB0);
  });

  it('Test A — submits a valid proof against the single store (solved=true)', async () => {
    const { node, kaId, challenge } = await seedKaCgNodeAndChallenge();

    expect(challenge.knowledgeAssetId).to.equal(kaId);
    expect(challenge.knowledgeAssetStorageContract).to.equal(
      await DKGKnowledgeAssets.getAddress(),
    );
    expect(challenge.solved).to.equal(false);
    expect(challenge.isCurated).to.equal(false); // public CG ⇒ pinned public
    expect(challenge.chunkId).to.equal(0n); // merkleLeafCount=1 ⇒ chunkId always 0

    // Structured single-leaf public KA: leaf = keccak256(publicContent) = publicRoot;
    // the proof folds the single private sibling to hashPair(publicRoot, SENTINEL) = merkleRoot.
    await RandomSampling.connect(node.operational).submitProof(
      publicContent,
      publicProof,
    );

    const solved = await RandomSamplingStorage.getNodeChallenge(
      node.identityId,
    );
    expect(solved.solved).to.equal(true);
  });

  it('Test B — verifies against the RECORDED store after the bound store is re-pointed (R3 seam)', async () => {
    const { node, challenge } = await seedKaCgNodeAndChallenge();
    const storeA = await DKGKnowledgeAssets.getAddress();
    expect(challenge.knowledgeAssetStorageContract).to.equal(storeA);

    // Deploy an EMPTY second DKGKnowledgeAssets (store-B), re-point the Hub,
    // and re-initialize RandomSampling so its bound singleton becomes store-B.
    const StoreB = await (
      await hre.ethers.getContractFactory('DKGKnowledgeAssets')
    ).deploy(
      await Hub.getAddress(),
      await DKGKnowledgeAssets.KNOWLEDGE_ASSET_BATCH_MAX_SIZE(),
      'ipfs://store-b',
    );
    await StoreB.waitForDeployment();
    const storeB = await StoreB.getAddress();
    expect(storeB).to.not.equal(storeA);

    await Hub.connect(accounts[0]).setAssetStorageAddress(
      'DKGKnowledgeAssets',
      storeB,
    );
    await RandomSampling.connect(accounts[0]).initialize();

    // Bound singleton is now the empty store-B. The OLD code read the bound
    // singleton → no merkle root / zero leaves → revert. With the seam,
    // verification uses the store recorded in the challenge (store-A).
    expect(await RandomSampling.knowledgeAssetStorage()).to.equal(storeB);

    // Structured single-leaf public KA (same proof as Test A). Succeeds only
    // because the seam reads store-A (recorded in the challenge); store-B is empty.
    await RandomSampling.connect(node.operational).submitProof(
      publicContent,
      publicProof,
    );

    const solved = await RandomSamplingStorage.getNodeChallenge(
      node.identityId,
    );
    expect(solved.solved).to.equal(true);
  });

  it('Test C — pins curation at issuance; survives a ContextGraphStorage cutover (curated stays curated)', async () => {
    const cgId = await createCuratedCG();
    const kaId = await seedCuratedKa(cgId);
    const node = await setupChallengingNode();

    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    await RandomSampling.connect(node.operational).createChallenge();
    const challenge = await RandomSamplingStorage.getNodeChallenge(
      node.identityId,
    );

    expect(challenge.knowledgeAssetId).to.equal(kaId);
    // The classification is PINNED on the challenge at issuance.
    expect(challenge.isCurated).to.equal(true);
    expect(challenge.chunkId).to.equal(0n); // catalogLeafCount=1 ⇒ chunkId 0
    // The pinned catalog root is the curated proof target (decoy plaintext root
    // is NOT) — the private-sub-root-as-decoy distinction OT-RFC-49 preserves.
    expect(challenge.challengeRoot).to.equal(catalogRoot);
    expect(challenge.challengeRoot).to.not.equal(decoyMerkleRoot);

    // Simulate a ContextGraphStorage generation cutover: re-point the Hub to an
    // EMPTY second ContextGraphStorage and re-initialize RandomSampling so its
    // bound singleton becomes that empty store. The OLD code re-derived isCurated
    // from this live singleton in submitProof — `kaToContextGraph(kaId)` on the
    // empty store returns 0 ⇒ isCurated=false ⇒ it would read the DECOY plaintext
    // merkle root and revert MerkleRootMismatchError. The pinned flag makes
    // verification immune to the cutover.
    const cgStorA = await ContextGraphStorage.getAddress();
    const CgStoreB = await (
      await hre.ethers.getContractFactory('ContextGraphStorage')
    ).deploy(await Hub.getAddress());
    await CgStoreB.waitForDeployment();
    const cgStorB = await CgStoreB.getAddress();
    expect(cgStorB).to.not.equal(cgStorA);

    await Hub.connect(accounts[0]).setAssetStorageAddress(
      'ContextGraphStorage',
      cgStorB,
    );
    await RandomSampling.connect(accounts[0]).initialize();
    expect(await RandomSampling.contextGraphStorage()).to.equal(cgStorB);

    // The KA store was NOT re-pointed, so the recorded store still holds the
    // catalog commitment. Curated branch verifies against the pinned catalog
    // root (== catalogRoot); the now-empty CG singleton is never consulted.
    // Plain catalog tree, single leaf ⇒ empty proof (leaf == catalogRoot).
    await RandomSampling.connect(node.operational).submitProof(
      catalogContent,
      [],
    );

    const solved = await RandomSamplingStorage.getNodeChallenge(
      node.identityId,
    );
    expect(solved.solved).to.equal(true);
  });

  it('Test C2 — proof-race immunity: an honest proof against the PINNED issuance-time catalog root survives a post-challenge catalog rotation; a proof against the new live root fails (OT-RFC-49 / WS-B Trap 1)', async () => {
    const cgId = await createCuratedCG();
    const kaId = await seedCuratedKa(cgId);
    const node = await setupChallengingNode();

    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    await RandomSampling.connect(node.operational).createChallenge();
    const challenge = await RandomSamplingStorage.getNodeChallenge(
      node.identityId,
    );

    // The challenge PINS (challengeLeafCount, challengeRoot) at issuance. For
    // this curated KA the pinned root is the catalog root seeded above
    // (== merkleRoot), and the pinned leaf count is 1.
    expect(challenge.knowledgeAssetId).to.equal(kaId);
    expect(challenge.isCurated).to.equal(true);
    expect(challenge.challengeRoot).to.equal(catalogRoot);
    expect(challenge.challengeLeafCount).to.equal(1n);
    expect(challenge.chunkId).to.equal(0n); // catalogLeafCount=1 ⇒ chunkId 0

    // A KA update lands BETWEEN createChallenge and submitProof: the curated KA
    // rotates its PUBLIC `_catalog` commitment to a brand-new root. The live
    // getter now returns the rotated root — but the challenge still carries the
    // pinned issuance-time root.
    await (
      await DKGKnowledgeAssets.connect(opSigner).setCatalogCommitment(
        kaId,
        rotatedCatalogRoot,
        1,
      )
    ).wait();
    // Prove the live state actually moved out from under the challenge.
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to.equal(
      rotatedCatalogRoot,
    );
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to.not.equal(
      challenge.challengeRoot,
    );

    // A proof built against the NEW live catalog must FAIL — submitProof derives
    // leaf = keccak256(rotatedCatalogContent) = rotatedCatalogRoot and folds it
    // against the PINNED `challenge.challengeRoot` (the issuance-time catalogRoot),
    // not the live getter. (A reverted submitProof rolls back and leaves the
    // challenge unsolved, so we can attempt the honest proof immediately after.)
    await expect(
      RandomSampling.connect(node.operational).submitProof(
        rotatedCatalogContent,
        [],
      ),
    ).to.be.revertedWithCustomError(RandomSampling, 'MerkleRootMismatchError');

    // The honest proof against the PINNED issuance-time catalog still verifies,
    // even though the live catalog root has since rotated. This is the
    // proof-race immunity: an update cannot retroactively invalidate an
    // in-flight challenge and slash an honest prover.
    await RandomSampling.connect(node.operational).submitProof(
      catalogContent,
      [],
    );

    const solved = await RandomSamplingStorage.getNodeChallenge(
      node.identityId,
    );
    expect(solved.solved).to.equal(true);
  });
});
