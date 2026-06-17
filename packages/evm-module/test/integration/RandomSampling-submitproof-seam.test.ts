import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
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
} from '../../typechain';
import { createProfile } from '../helpers/profile-helpers';

// Single-leaf KA: with merkleLeafCount=1 the challenge chunkId is always 0 and
// a 1-leaf tree's root IS its only leaf, so `submitProof(root, [])` verifies
// trivially on-chain (`h = leaf`; empty proof; `h == root`). This deliberately
// avoids the kcTools merkle builder (which sorts pairs) vs the on-chain
// `_verifyV10MerkleProof` (which pairs positionally) — they don't match, which
// is orthogonal to what these tests cover (the store-routing of the read and,
// in Test C2, the proof-race pinning of the catalog root).
const merkleRoot = ethers.keccak256(
  ethers.toUtf8Bytes('r3-seam-single-leaf-root'),
);

// Decoy PUBLIC merkle root for the curated KA (Test C). The curated KA records
// this as its plaintext `merkleRoot`, but its PUBLIC `_catalog` commitment root
// is the real proof target (`merkleRoot` above). A challenge MISclassified as
// public would verify against THIS decoy and fail — that's the RED the pin
// prevents (OT-RFC-49: curated proofs target the catalog, not the plaintext
// merkle root).
const decoyMerkleRoot = ethers.keccak256(
  ethers.toUtf8Bytes('r3-seam-decoy-public-root'),
);

// OT-RFC-49 / WS-B Trap 1 (proof-race, Test C2): a NEW catalog root the curated
// KA rotates to AFTER its challenge is issued. An honest proof built against the
// PINNED issuance-time catalog root (`merkleRoot`) must still verify; a proof
// against this rotated live root must fail, because `submitProof` reads the
// pinned `challenge.challengeRoot`, never the live `getCatalogRoot`.
const rotatedCatalogRoot = ethers.keccak256(
  ethers.toUtf8Bytes('r3-seam-rotated-catalog-root'),
);

const OPEN_POLICY = 1; // public CG (accessPolicy=0 ⇒ getIsCurated()=false ⇒ merkle path)
const CURATED_ACCESS = 1; // accessPolicy=1 ⇒ getIsCurated()=true ⇒ catalog path
const TEST_KC_BYTE_SIZE = 128n;

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
        TEST_KC_BYTE_SIZE,
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
        TEST_KC_BYTE_SIZE,
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

    // The real curated proof target: catalog root == `merkleRoot`, count=1
    // (single-leaf ⇒ chunkId 0, root == leaf, empty proof verifies).
    await (
      await DKGKnowledgeAssets.connect(opSigner).setCatalogCommitment(
        kaId,
        merkleRoot,
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

  it('Test A — submits a valid proof against the single store (solved=true)', async () => {
    const { node, kaId, challenge } = await seedKaCgNodeAndChallenge();

    expect(challenge.knowledgeAssetId).to.equal(kaId);
    expect(challenge.knowledgeAssetStorageContract).to.equal(
      await DKGKnowledgeAssets.getAddress(),
    );
    expect(challenge.solved).to.equal(false);
    expect(challenge.isCurated).to.equal(false); // public CG ⇒ pinned public
    expect(challenge.chunkId).to.equal(0n); // merkleLeafCount=1 ⇒ chunkId always 0

    // 1-leaf tree: root == leaf, empty proof.
    await RandomSampling.connect(node.operational).submitProof(merkleRoot, []);

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

    // 1-leaf tree: root == leaf, empty proof. Succeeds only because the seam
    // reads store-A (recorded in the challenge); the bound store-B is empty.
    await RandomSampling.connect(node.operational).submitProof(merkleRoot, []);

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
    expect(challenge.challengeRoot).to.equal(merkleRoot);
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
    // root (== merkleRoot); the now-empty CG singleton is never consulted.
    await RandomSampling.connect(node.operational).submitProof(merkleRoot, []);

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
    expect(challenge.challengeRoot).to.equal(merkleRoot);
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

    // A proof built against the NEW live root must FAIL — submitProof verifies
    // the leaf against the PINNED `challenge.challengeRoot`, not the live
    // getter. (A reverted submitProof rolls back and leaves the challenge
    // unsolved, so we can attempt the honest proof immediately after.)
    await expect(
      RandomSampling.connect(node.operational).submitProof(
        rotatedCatalogRoot,
        [],
      ),
    ).to.be.revertedWithCustomError(RandomSampling, 'MerkleRootMismatchError');

    // The honest proof against the PINNED issuance-time root still verifies,
    // even though the live catalog root has since rotated. This is the
    // proof-race immunity: an update cannot retroactively invalidate an
    // in-flight challenge and slash an honest prover.
    await RandomSampling.connect(node.operational).submitProof(merkleRoot, []);

    const solved = await RandomSamplingStorage.getNodeChallenge(
      node.identityId,
    );
    expect(solved.solved).to.equal(true);
  });
});
