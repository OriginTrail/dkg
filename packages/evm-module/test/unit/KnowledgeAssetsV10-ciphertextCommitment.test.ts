import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import type {
  AskStorage,
  Chronos,
  ContextGraphs,
  ContextGraphStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  Hub,
  KnowledgeAssetsV10,
  KnowledgeCollectionStorage,
  Profile,
  StakingV10,
  Token,
} from '../../typechain';
import {
  buildPublishParams,
  buildUpdateParams,
  DEFAULT_CHAIN_ID,
} from '../helpers/v10-kc-helpers';
import { createProfile, createProfiles } from '../helpers/profile-helpers';
import {
  getDefaultKCCreator,
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
} from '../helpers/setup-helpers';
import { NodeAccounts } from '../helpers/types';

/**
 * RFC-39 Phase A.5 — `KnowledgeAssetsV10` ciphertext-commitment surface.
 *
 * Locks the curated-vs-public branching introduced by the new
 * `(ciphertextChunksRoot, ciphertextChunkCount)` `PublishParams` fields:
 *
 *   - Public CG  + zero pair          → succeeds (defaults; KCS stays zero)
 *   - Public CG  + any non-zero field → reverts `PublicCGCannotHaveCiphertextCommitment`
 *   - Curated CG + zero pair          → succeeds, no commitment event, KCS getters zero
 *   - Curated CG + paired non-zero    → succeeds, `KnowledgeCollectionCiphertextCommitmentSet`
 *     event fires, KCS getters return the persisted values
 *   - Curated CG + exactly one zero   → reverts `IncompleteCiphertextCommitment`
 *
 * Dedicated test file (separate from `KnowledgeAssetsV10.test.ts`) so the
 * companion contract PR doesn't conflict with PR #595, which is also
 * modifying the legacy test file.
 *
 * Fixture mirrors the legacy `KnowledgeAssetsV10.test.ts` fixture exactly so
 * the test surface is identical (full V10 stack + V8 KC infra + min-stake
 * profile setup). Diverging would tempt drift between RFC-39 coverage and
 * the rest of the V10 publish suite.
 */
describe('@unit KnowledgeAssetsV10 — RFC-39 ciphertext commitment', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let KAV10: KnowledgeAssetsV10;
  let KCS: KnowledgeCollectionStorage;
  let AskStorageContract: AskStorage;
  let ChronosContract: Chronos;
  let TokenContract: Token;
  let ProfileContract: Profile;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let Facade: ContextGraphs;
  let CGStorageContract: ContextGraphStorage;
  let NFT: DKGPublishingConvictionNFT;

  let kav10Address: string;
  let chainId: bigint;

  const MIN_STAKE = ethers.parseEther('50000');

  async function deployFixture() {
    await hre.deployments.fixture([
      'Token',
      'Hub',
      'AskStorage',
      'EpochStorage',
      'Chronos',
      'Profile',
      'Identity',
      'ParametersStorage',
      'IdentityStorage',
      'KnowledgeCollectionStorage',
      'ContextGraphStorage',
      'ContextGraphs',
      'ContextGraphValueStorage',
      'DKGPublishingConvictionNFT',
      'StakingV10',
      'DKGStakingConvictionNFT',
      'KnowledgeAssetsV10',
    ]);

    const signers = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', signers[0].address);

    return {
      accounts: signers,
      HubContract: Hub,
      KAV10: await hre.ethers.getContract<KnowledgeAssetsV10>('KnowledgeAssetsV10'),
      KCS: await hre.ethers.getContract<KnowledgeCollectionStorage>(
        'KnowledgeCollectionStorage',
      ),
      AskStorageContract: await hre.ethers.getContract<AskStorage>('AskStorage'),
      ChronosContract: await hre.ethers.getContract<Chronos>('Chronos'),
      TokenContract: await hre.ethers.getContract<Token>('Token'),
      ProfileContract: await hre.ethers.getContract<Profile>('Profile'),
      StakingV10Contract: await hre.ethers.getContract<StakingV10>('StakingV10'),
      StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
        'DKGStakingConvictionNFT',
      ),
      Facade: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
      CGStorageContract: await hre.ethers.getContract<ContextGraphStorage>(
        'ContextGraphStorage',
      ),
      NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
        'DKGPublishingConvictionNFT',
      ),
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    HubContract = f.HubContract;
    KAV10 = f.KAV10;
    KCS = f.KCS;
    AskStorageContract = f.AskStorageContract;
    ChronosContract = f.ChronosContract;
    TokenContract = f.TokenContract;
    ProfileContract = f.ProfileContract;
    StakingV10Contract = f.StakingV10Contract;
    StakingNFT = f.StakingNFT;
    Facade = f.Facade;
    CGStorageContract = f.CGStorageContract;
    NFT = f.NFT;

    kav10Address = await KAV10.getAddress();
    chainId = DEFAULT_CHAIN_ID;
  });

  async function fundAndStakeNode(node: NodeAccounts, identityId: number) {
    await TokenContract.mint(node.operational.address, MIN_STAKE);
    await TokenContract.connect(node.operational).approve(
      await StakingV10Contract.getAddress(),
      MIN_STAKE,
    );
    await StakingNFT.connect(node.operational).createConviction(
      identityId,
      MIN_STAKE,
      1,
    );
  }

  async function setupNodes() {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const { identityId: publisherIdentityId } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    await fundAndStakeNode(publishingNode, publisherIdentityId);
    const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);
    for (let i = 0; i < receivingNodes.length; i++) {
      await fundAndStakeNode(receivingNodes[i], receiverProfiles[i].identityId);
    }
    return { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds };
  }

  async function createPublicCG(creator: SignerWithAddress): Promise<bigint> {
    // LU-1 dropped per-CG hosting committees and quorum overrides — the
    // facade now takes 6 args: participantAgents, metadataBatchId,
    // accessPolicy, publishPolicy, publishAuthority, publishAuthorityAccountId.
    await Facade.connect(creator).createContextGraph(
      [], // participantAgents
      0, // metadataBatchId
      0, // accessPolicy = public/discoverable
      1, // publishPolicy = open
      ethers.ZeroAddress,
      0, // publishAuthorityAccountId
      ethers.ZeroHash, // nameHash
    );
    return CGStorageContract.getLatestContextGraphId();
  }

  async function createCuratedCG(
    creator: SignerWithAddress,
    authority: string,
  ): Promise<bigint> {
    // Codex C2 fix — `getIsCurated` is anchored to `accessPolicy` (the
    // encryption axis), NOT `publishPolicy` (the authority axis). A
    // CG that carries ciphertext-committed payloads MUST have
    // `accessPolicy = 1`. We keep `publishPolicy = 0` (curated /
    // single-authority publish) so the existing `authority` plumbing
    // stays exercised, but the ciphertext-commitment branch on the
    // publish path is gated by `accessPolicy != 0`.
    await Facade.connect(creator).createContextGraph(
      [], // participantAgents
      0, // metadataBatchId
      1, // accessPolicy = curated (encrypted)
      0, // publishPolicy = curated (single-authority publish)
      authority,
      0, // publishAuthorityAccountId
      ethers.ZeroHash, // nameHash
    );
    return CGStorageContract.getLatestContextGraphId();
  }

  // The ciphertext-commitment fields live OUTSIDE the on-chain ACK digest
  // (RFC-38 §5.4.2): they are off-chain ACK material under LU-11. So
  // varying them does NOT require re-signing the receiver quorum — the
  // base `buildPublishParams` ACK digest stays valid when we spread + set
  // the two new fields at the call site.
  //
  // A non-trivial ciphertext root + count pair is used as the "full
  // commitment" payload in the positive curated-publish test.
  const SAMPLE_CT_ROOT = ethers.keccak256(ethers.toUtf8Bytes('ct-root-sample'));
  const SAMPLE_CT_COUNT = 7;

  describe('Public CG path', () => {
    it('accepts a publish with zero ciphertext commitment (default)', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createPublicCG(creator);
      const tokenAmount = ethers.parseEther('100');

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('public-zero-ct')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'public-zero-ct-op',
      });

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await expect(KAV10.connect(creator).publish(p)).to.not.be.reverted;

      const kcId = await KCS.getLatestKnowledgeCollectionId();
      expect(await KCS.getLatestCiphertextChunksRoot(kcId)).to.equal(ethers.ZeroHash);
      expect(await KCS.getCiphertextChunkCount(kcId)).to.equal(0);
    });

    it('reverts PublicCGCannotHaveCiphertextCommitment when only ciphertextChunksRoot is set', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createPublicCG(creator);
      const tokenAmount = ethers.parseEther('100');

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('public-root-only')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'public-root-only-op',
        ciphertextChunksRoot: SAMPLE_CT_ROOT,
      });

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await expect(KAV10.connect(creator).publish(p))
        .to.be.revertedWithCustomError(KAV10, 'PublicCGCannotHaveCiphertextCommitment')
        .withArgs(cgId);
    });

    it('reverts PublicCGCannotHaveCiphertextCommitment when only ciphertextChunkCount is set', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createPublicCG(creator);
      const tokenAmount = ethers.parseEther('100');

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('public-count-only')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'public-count-only-op',
        ciphertextChunkCount: SAMPLE_CT_COUNT,
      });

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await expect(KAV10.connect(creator).publish(p))
        .to.be.revertedWithCustomError(KAV10, 'PublicCGCannotHaveCiphertextCommitment')
        .withArgs(cgId);
    });

    it('reverts PublicCGCannotHaveCiphertextCommitment when BOTH fields are non-zero (no asymmetry escape)', async () => {
      // Defends against a regression where the predicate became
      // `(root != 0) ^ (count != 0)` (XOR — only-one-axis-set) instead
      // of the current `(root != 0) || (count != 0)` (OR — any-axis-set).
      // Without this case, a both-set publish on a public CG would
      // slip past the current asymmetric-pair guards above.
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createPublicCG(creator);
      const tokenAmount = ethers.parseEther('100');

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('public-both-set')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'public-both-set-op',
        ciphertextChunksRoot: SAMPLE_CT_ROOT,
        ciphertextChunkCount: SAMPLE_CT_COUNT,
      });

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await expect(KAV10.connect(creator).publish(p))
        .to.be.revertedWithCustomError(KAV10, 'PublicCGCannotHaveCiphertextCommitment')
        .withArgs(cgId);
    });

    it('storage is untouched after a PublicCGCannotHaveCiphertextCommitment revert (atomic)', async () => {
      // Defensive: the publish path mints the KC counter inside a
      // single transaction, but a partially-applied side effect (e.g.
      // a setCiphertextChunksCommitment that fired before the policy
      // gate) would corrupt curator/picker state. Confirm the latest
      // KC counter and ciphertext getters all reflect the pre-publish
      // state after the rejection.
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createPublicCG(creator);
      const tokenAmount = ethers.parseEther('100');
      const preLatestKcId = await KCS.getLatestKnowledgeCollectionId();

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('public-atomic-revert')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'public-atomic-revert-op',
        ciphertextChunksRoot: SAMPLE_CT_ROOT,
      });
      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await expect(KAV10.connect(creator).publish(p)).to.be.reverted;

      // No counter advance, no commitment slot written for the
      // never-minted next-id.
      expect(await KCS.getLatestKnowledgeCollectionId()).to.equal(preLatestKcId);
      expect(await KCS.getLatestCiphertextChunksRoot(preLatestKcId + 1n)).to.equal(
        ethers.ZeroHash,
      );
      expect(await KCS.getCiphertextChunkCount(preLatestKcId + 1n)).to.equal(0);
    });
  });

  describe('Curated CG path', () => {
    it('accepts a curated publish with zero ciphertext commitment (legacy / pre-LU-11 path)', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createCuratedCG(creator, creator.address);
      const tokenAmount = ethers.parseEther('100');

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-zero-ct')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'curated-zero-ct-op',
      });

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      const tx = await KAV10.connect(creator).publish(p);
      await expect(tx).to.not.emit(KCS, 'KnowledgeCollectionCiphertextCommitmentSet');

      const kcId = await KCS.getLatestKnowledgeCollectionId();
      expect(await KCS.getLatestCiphertextChunksRoot(kcId)).to.equal(ethers.ZeroHash);
      expect(await KCS.getCiphertextChunkCount(kcId)).to.equal(0);
    });

    it('persists the commitment and emits the event when both fields are non-zero', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createCuratedCG(creator, creator.address);
      const tokenAmount = ethers.parseEther('100');

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-full-ct')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'curated-full-ct-op',
        ciphertextChunksRoot: SAMPLE_CT_ROOT,
        ciphertextChunkCount: SAMPLE_CT_COUNT,
      });

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);

      // The contract reads `KnowledgeCollectionStorage.getLatestKnowledgeCollectionId() + 1`
      // for the next id (counter increments on create). Snapshot before to
      // pin the expected kcId for the event matcher.
      const nextKcId = (await KCS.getLatestKnowledgeCollectionId()) + 1n;

      await expect(KAV10.connect(creator).publish(p))
        .to.emit(KCS, 'KnowledgeCollectionCiphertextCommitmentSet')
        .withArgs(nextKcId, SAMPLE_CT_ROOT, SAMPLE_CT_COUNT);

      expect(await KCS.getLatestCiphertextChunksRoot(nextKcId)).to.equal(SAMPLE_CT_ROOT);
      expect(await KCS.getCiphertextChunkCount(nextKcId)).to.equal(SAMPLE_CT_COUNT);
    });

    it('reverts IncompleteCiphertextCommitment when curated publish carries root without count', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createCuratedCG(creator, creator.address);
      const tokenAmount = ethers.parseEther('100');

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-partial-root')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'curated-partial-root-op',
        ciphertextChunksRoot: SAMPLE_CT_ROOT,
        ciphertextChunkCount: 0,
      });

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await expect(
        KAV10.connect(creator).publish(p),
      ).to.be.revertedWithCustomError(KAV10, 'IncompleteCiphertextCommitment');
    });

    it('persists per-KC commitments independently when the same CG mints two curated KCs (no cross-contamination)', async () => {
      // Two consecutive publishes on the same curated CG with DIFFERENT
      // commitments must each write their own slot — a regression where
      // the second publish overwrites the first KC's slot would silently
      // alias every challenge in the picker. We probe with two distinct
      // (root, count) pairs and assert each KC retains its own.
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createCuratedCG(creator, creator.address);
      const tokenAmount = ethers.parseEther('100');

      const ROOT_1 = ethers.keccak256(ethers.toUtf8Bytes('per-kc-1'));
      const COUNT_1 = 3;
      const ROOT_2 = ethers.keccak256(ethers.toUtf8Bytes('per-kc-2'));
      const COUNT_2 = 17;

      const p1 = await buildPublishParams({
        chainId, kav10Address, receivingNodes, publisherIdentityId,
        receiverIdentityIds, author: creator, contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-multi-1')),
        knowledgeAssetsAmount: 10, byteSize: 1000, epochs: 2,
        tokenAmount, isImmutable: false,
        publishOperationId: 'curated-multi-1-op',
        ciphertextChunksRoot: ROOT_1, ciphertextChunkCount: COUNT_1,
      });
      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await KAV10.connect(creator).publish(p1);
      const kc1 = await KCS.getLatestKnowledgeCollectionId();

      const p2 = await buildPublishParams({
        chainId, kav10Address, receivingNodes, publisherIdentityId,
        receiverIdentityIds, author: creator, contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-multi-2')),
        knowledgeAssetsAmount: 10, byteSize: 1000, epochs: 2,
        tokenAmount, isImmutable: false,
        publishOperationId: 'curated-multi-2-op',
        ciphertextChunksRoot: ROOT_2, ciphertextChunkCount: COUNT_2,
      });
      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await KAV10.connect(creator).publish(p2);
      const kc2 = await KCS.getLatestKnowledgeCollectionId();
      expect(kc2).to.equal(kc1 + 1n);

      // Each KC keeps its own commitment.
      expect(await KCS.getLatestCiphertextChunksRoot(kc1)).to.equal(ROOT_1);
      expect(await KCS.getCiphertextChunkCount(kc1)).to.equal(COUNT_1);
      expect(await KCS.getLatestCiphertextChunksRoot(kc2)).to.equal(ROOT_2);
      expect(await KCS.getCiphertextChunkCount(kc2)).to.equal(COUNT_2);
    });

    it('reverts IncompleteCiphertextCommitment when curated publish carries count without root', async () => {
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createCuratedCG(creator, creator.address);
      const tokenAmount = ethers.parseEther('100');

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-partial-count')),
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs: 2,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'curated-partial-count-op',
        ciphertextChunksRoot: ethers.ZeroHash,
        ciphertextChunkCount: SAMPLE_CT_COUNT,
      });

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await expect(
        KAV10.connect(creator).publish(p),
      ).to.be.revertedWithCustomError(KAV10, 'IncompleteCiphertextCommitment');
    });
  });

  // ----------------------------------------------------------------------
  // Codex PR #630 R2 #1307 — update() commitment-refresh strict mode.
  //
  // The publish path treats a zero ciphertext pair on a curated CG as the
  // "legacy / pre-LU-11" path (no commitment). update() can't safely do
  // the same: it rotates `latestMerkleRoot` + `latestMerkleLeafCount` to
  // the NEW batch's leaves, so leaving the OLD ciphertext commitment in
  // place would make `RandomSampling`'s curated proof check verify the
  // new plaintext leaves against ciphertext that no longer corresponds
  // to them (stale-commitment bug).
  //
  // Contract therefore requires a fresh (root, count) pair on every
  // curated update; the public path is unchanged.
  // ----------------------------------------------------------------------
  describe('Update path — curated commitment refresh', () => {
    const NEW_CT_ROOT = ethers.keccak256(ethers.toUtf8Bytes('ct-root-rotated'));
    const NEW_CT_COUNT = 11;

    async function publishCuratedBaseline(): Promise<{
      creator: SignerWithAddress;
      cgId: bigint;
      kcId: bigint;
      publisherIdentityId: number;
      receivingNodes: NodeAccounts[];
      receiverIdentityIds: number[];
      tokenAmount: bigint;
      byteSize: bigint;
    }> {
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createCuratedCG(creator, creator.address);
      const tokenAmount = ethers.parseEther('500');
      const byteSize = 1000n;

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-baseline')),
        knowledgeAssetsAmount: 10,
        byteSize: Number(byteSize),
        epochs: 5,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'curated-baseline-op',
        ciphertextChunksRoot: SAMPLE_CT_ROOT,
        ciphertextChunkCount: SAMPLE_CT_COUNT,
      });

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await KAV10.connect(creator).publish(p);
      const kcId = await KCS.getLatestKnowledgeCollectionId();

      return {
        creator, cgId, kcId, publisherIdentityId,
        receivingNodes, receiverIdentityIds, tokenAmount, byteSize,
      };
    }

    async function publishPublicBaseline(): Promise<{
      creator: SignerWithAddress;
      cgId: bigint;
      kcId: bigint;
      publisherIdentityId: number;
      receivingNodes: NodeAccounts[];
      receiverIdentityIds: number[];
      tokenAmount: bigint;
      byteSize: bigint;
    }> {
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createPublicCG(creator);
      const tokenAmount = ethers.parseEther('500');
      const byteSize = 1000n;

      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('public-baseline')),
        knowledgeAssetsAmount: 10,
        byteSize: Number(byteSize),
        epochs: 5,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'public-baseline-op',
      });

      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await KAV10.connect(creator).publish(p);
      const kcId = await KCS.getLatestKnowledgeCollectionId();

      return {
        creator, cgId, kcId, publisherIdentityId,
        receivingNodes, receiverIdentityIds, tokenAmount, byteSize,
      };
    }

    it('accepts a zero-pair update on a legacy/pre-LU-11 curated KC (no prior commitment)', async () => {
      // Publish curated baseline WITHOUT a ciphertext commitment (the
      // legacy path that the publish branch still allows).
      const creator = getDefaultKCCreator(accounts);
      const { publisherIdentityId, receivingNodes, receiverIdentityIds } =
        await setupNodes();
      const cgId = await createCuratedCG(creator, creator.address);
      const tokenAmount = ethers.parseEther('500');
      const byteSize = 1000n;
      const p = await buildPublishParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        author: creator,
        contextGraphId: cgId,
        merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-legacy-baseline')),
        knowledgeAssetsAmount: 10,
        byteSize: Number(byteSize),
        epochs: 5,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'curated-legacy-baseline-op',
        // no ciphertext fields → defaults to zero pair
      });
      await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
      await KAV10.connect(creator).publish(p);
      const kcId = await KCS.getLatestKnowledgeCollectionId();
      expect(await KCS.getLatestCiphertextChunksRoot(kcId)).to.equal(ethers.ZeroHash);

      const up = await buildUpdateParams({
        chainId,
        kav10Address,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        contextGraphId: cgId,
        id: kcId,
        preUpdateMerkleRootCount: 1n,
        newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-legacy-update')),
        newByteSize: byteSize,
        newTokenAmount: tokenAmount,
        mintKnowledgeAssetsAmount: 1n,
        knowledgeAssetsToBurn: [],
        updateOperationId: 'curated-legacy-update-op',
      });

      await expect(KAV10.connect(creator).update(up)).to.not.be.reverted;
      // Still uncommitted afterwards — picker continues to skip in curated draw.
      expect(await KCS.getLatestCiphertextChunksRoot(kcId)).to.equal(ethers.ZeroHash);
      expect(await KCS.getCiphertextChunkCount(kcId)).to.equal(0);
    });

    it('reverts IncompleteCiphertextCommitment when a committed curated KC is updated with zero pair (stale-commitment guard)', async () => {
      const base = await publishCuratedBaseline();
      // Snapshot the pre-update commitment so we can assert it survived
      // the rejected call (defensive — `expect.to.be.revertedWith*` only
      // checks the revert, not that storage was untouched).
      const preRoot = await KCS.getLatestCiphertextChunksRoot(base.kcId);
      const preCount = await KCS.getCiphertextChunkCount(base.kcId);
      expect(preRoot).to.equal(SAMPLE_CT_ROOT);
      expect(preCount).to.equal(SAMPLE_CT_COUNT);

      const up = await buildUpdateParams({
        chainId,
        kav10Address,
        receivingNodes: base.receivingNodes,
        publisherIdentityId: base.publisherIdentityId,
        receiverIdentityIds: base.receiverIdentityIds,
        contextGraphId: base.cgId,
        id: base.kcId,
        preUpdateMerkleRootCount: 1n,
        newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-update-zero')),
        newByteSize: base.byteSize,
        newTokenAmount: base.tokenAmount, // delta == 0 so no approval/payment needed
        mintKnowledgeAssetsAmount: 1n,
        knowledgeAssetsToBurn: [],
        updateOperationId: 'curated-update-zero-op',
      });

      await expect(
        KAV10.connect(base.creator).update(up),
      ).to.be.revertedWithCustomError(KAV10, 'IncompleteCiphertextCommitment');

      // Storage untouched.
      expect(await KCS.getLatestCiphertextChunksRoot(base.kcId)).to.equal(preRoot);
      expect(await KCS.getCiphertextChunkCount(base.kcId)).to.equal(preCount);
    });

    it('reverts IncompleteCiphertextCommitment when a curated update carries an asymmetric pair (root without count)', async () => {
      const base = await publishCuratedBaseline();
      const up = await buildUpdateParams({
        chainId,
        kav10Address,
        receivingNodes: base.receivingNodes,
        publisherIdentityId: base.publisherIdentityId,
        receiverIdentityIds: base.receiverIdentityIds,
        contextGraphId: base.cgId,
        id: base.kcId,
        preUpdateMerkleRootCount: 1n,
        newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-update-asym')),
        newByteSize: base.byteSize,
        newTokenAmount: base.tokenAmount,
        mintKnowledgeAssetsAmount: 1n,
        knowledgeAssetsToBurn: [],
        updateOperationId: 'curated-update-asym-op',
      });
      const upPartial = {
        ...up,
        newCiphertextChunksRoot: NEW_CT_ROOT,
        newCiphertextChunkCount: 0, // asymmetric
      };
      await expect(
        KAV10.connect(base.creator).update(upPartial),
      ).to.be.revertedWithCustomError(KAV10, 'IncompleteCiphertextCommitment');
    });

    it('reverts IncompleteCiphertextCommitment when a curated update carries an asymmetric pair (count without root)', async () => {
      // Symmetric to the earlier root-without-count case — locks both
      // axes of the asymmetric-pair guard. A regression that only
      // checked one axis (e.g. `root != 0 && count == 0`) would leak
      // through here.
      const base = await publishCuratedBaseline();
      const up = await buildUpdateParams({
        chainId, kav10Address,
        receivingNodes: base.receivingNodes,
        publisherIdentityId: base.publisherIdentityId,
        receiverIdentityIds: base.receiverIdentityIds,
        contextGraphId: base.cgId, id: base.kcId,
        preUpdateMerkleRootCount: 1n,
        newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-update-asym-count')),
        newByteSize: base.byteSize,
        newTokenAmount: base.tokenAmount,
        mintKnowledgeAssetsAmount: 1n,
        knowledgeAssetsToBurn: [],
        updateOperationId: 'curated-update-asym-count-op',
      });
      const upPartial = {
        ...up,
        newCiphertextChunksRoot: ethers.ZeroHash,
        newCiphertextChunkCount: NEW_CT_COUNT,
      };
      await expect(
        KAV10.connect(base.creator).update(upPartial),
      ).to.be.revertedWithCustomError(KAV10, 'IncompleteCiphertextCommitment');
    });

    it('re-update with the same (root, count) re-emits the event (no suppression on identical commitment)', async () => {
      // The storage-level overwrite contract is "every successful write
      // emits", regardless of value identity. This locks the same
      // contract through the KAV10.update path. Off-chain indexers
      // counting commitment events would silently undercount otherwise.
      const base = await publishCuratedBaseline();

      const up = await buildUpdateParams({
        chainId, kav10Address,
        receivingNodes: base.receivingNodes,
        publisherIdentityId: base.publisherIdentityId,
        receiverIdentityIds: base.receiverIdentityIds,
        contextGraphId: base.cgId, id: base.kcId,
        preUpdateMerkleRootCount: 1n,
        newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-update-same')),
        newByteSize: base.byteSize,
        newTokenAmount: base.tokenAmount,
        mintKnowledgeAssetsAmount: 1n,
        knowledgeAssetsToBurn: [],
        updateOperationId: 'curated-update-same-op',
      });
      const upSame = {
        ...up,
        newCiphertextChunksRoot: SAMPLE_CT_ROOT,
        newCiphertextChunkCount: SAMPLE_CT_COUNT,
      };
      await expect(KAV10.connect(base.creator).update(upSame))
        .to.emit(KCS, 'KnowledgeCollectionCiphertextCommitmentSet')
        .withArgs(base.kcId, SAMPLE_CT_ROOT, SAMPLE_CT_COUNT);
    });

    it('persists the new commitment and emits the event when curated update carries a paired non-zero ciphertext', async () => {
      const base = await publishCuratedBaseline();

      const up = await buildUpdateParams({
        chainId,
        kav10Address,
        receivingNodes: base.receivingNodes,
        publisherIdentityId: base.publisherIdentityId,
        receiverIdentityIds: base.receiverIdentityIds,
        contextGraphId: base.cgId,
        id: base.kcId,
        preUpdateMerkleRootCount: 1n,
        newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('curated-update-full')),
        newByteSize: base.byteSize,
        newTokenAmount: base.tokenAmount, // delta == 0
        mintKnowledgeAssetsAmount: 1n,
        knowledgeAssetsToBurn: [],
        updateOperationId: 'curated-update-full-op',
      });
      // Ciphertext-commitment fields live outside the ACK digest (RFC-38
      // §5.4.2) so spreading them in here doesn't invalidate the
      // receiver-quorum signatures already baked into `up`.
      const upWithCt = {
        ...up,
        newCiphertextChunksRoot: NEW_CT_ROOT,
        newCiphertextChunkCount: NEW_CT_COUNT,
      };

      await expect(KAV10.connect(base.creator).update(upWithCt))
        .to.emit(KCS, 'KnowledgeCollectionCiphertextCommitmentSet')
        .withArgs(base.kcId, NEW_CT_ROOT, NEW_CT_COUNT);

      expect(await KCS.getLatestCiphertextChunksRoot(base.kcId)).to.equal(NEW_CT_ROOT);
      expect(await KCS.getCiphertextChunkCount(base.kcId)).to.equal(NEW_CT_COUNT);
    });

    it('accepts a public update with zero ciphertext (no-op) and reverts when a stray non-zero field is supplied', async () => {
      const base = await publishPublicBaseline();

      // Path 1: legitimate public-CG update — zero pair, no rotation.
      const up = await buildUpdateParams({
        chainId,
        kav10Address,
        receivingNodes: base.receivingNodes,
        publisherIdentityId: base.publisherIdentityId,
        receiverIdentityIds: base.receiverIdentityIds,
        contextGraphId: base.cgId,
        id: base.kcId,
        preUpdateMerkleRootCount: 1n,
        newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('public-update-zero')),
        newByteSize: base.byteSize,
        newTokenAmount: base.tokenAmount,
        mintKnowledgeAssetsAmount: 1n,
        knowledgeAssetsToBurn: [],
        updateOperationId: 'public-update-zero-op',
      });
      await expect(KAV10.connect(base.creator).update(up)).to.not.be.reverted;
      expect(await KCS.getLatestCiphertextChunksRoot(base.kcId)).to.equal(ethers.ZeroHash);
      expect(await KCS.getCiphertextChunkCount(base.kcId)).to.equal(0);

      // Path 2: same baseline, but caller tries to slip a non-zero
      // ciphertext field into a public-CG update. Must revert so a
      // misconfigured curated→public publish-policy migration can't
      // silently leak ciphertext commitments onto public KCs.
      const up2 = await buildUpdateParams({
        chainId,
        kav10Address,
        receivingNodes: base.receivingNodes,
        publisherIdentityId: base.publisherIdentityId,
        receiverIdentityIds: base.receiverIdentityIds,
        contextGraphId: base.cgId,
        id: base.kcId,
        preUpdateMerkleRootCount: 2n, // first update wrote root #2
        newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('public-update-stray')),
        newByteSize: base.byteSize,
        newTokenAmount: base.tokenAmount,
        mintKnowledgeAssetsAmount: 1n,
        knowledgeAssetsToBurn: [],
        updateOperationId: 'public-update-stray-op',
      });
      const up2WithCt = { ...up2, newCiphertextChunksRoot: NEW_CT_ROOT };
      await expect(
        KAV10.connect(base.creator).update(up2WithCt),
      ).to.be.revertedWithCustomError(KAV10, 'PublicCGCannotHaveCiphertextCommitment')
        .withArgs(base.cgId);
    });
  });
});
