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
    await Facade.connect(creator).createContextGraph(
      [],
      0,
      0, // accessPolicy = public/discoverable
      1, // publishPolicy = open
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
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
      [],
      0,
      1, // accessPolicy = curated (encrypted)
      0, // publishPolicy = curated (single-authority publish)
      authority,
      0,
      ethers.ZeroHash,
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
});
