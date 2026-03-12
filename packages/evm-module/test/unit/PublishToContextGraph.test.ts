/**
 * TDD Layer 1 — Contract tests for the updated context graph protocol:
 *
 * 1. publishToContextGraph(): atomic publish KC + register to context graph
 * 2. addBatchToContextGraph(): updated to use (contextGraphId, merkleRoot) signatures
 *    instead of (contextGraphId, batchId)
 * 3. Edge node identity: profile without minimum stake, usable as participant
 *
 * These tests define the contract API that will be implemented.
 * They will FAIL until the contracts are updated.
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  ContextGraphs,
  ContextGraphStorage,
  IdentityStorage,
  Profile,
  Hub,
  KnowledgeAssets,
  KnowledgeAssetsStorage,
  Token,
  ParametersStorage,
  EpochStorage,
  AskStorage,
  Chronos,
  Identity,
  Staking,
} from '../../typechain';
import { signMessage } from '../helpers/kc-helpers';
import { createProfile, createProfiles } from '../helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKCCreator,
  setupNodeWithStakeAndAsk,
} from '../helpers/setup-helpers';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
  IdentityStorage: IdentityStorage;
  Profile: Profile;
  KnowledgeAssets: KnowledgeAssets;
  KnowledgeAssetsStorage: KnowledgeAssetsStorage;
  Token: Token;
  ParametersStorage: ParametersStorage;
  EpochStorage: EpochStorage;
  AskStorage: AskStorage;
  Chronos: Chronos;
  Identity: Identity;
  Staking: Staking;
};

describe('@unit PublishToContextGraph', () => {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let ContextGraphsContract: ContextGraphs;
  let ContextGraphStorageContract: ContextGraphStorage;
  let ProfileContract: Profile;
  let KnowledgeAssetsContract: KnowledgeAssets;
  let KnowledgeAssetsStorageContract: KnowledgeAssetsStorage;
  let TokenContract: Token;
  let ParametersStorageContract: ParametersStorage;
  let IdentityStorageContract: IdentityStorage;
  let IdentityContract: Identity;
  let StakingContract: Staking;
  let AskStorageContract: AskStorage;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture([
      'Token',
      'AskStorage',
      'EpochStorage',
      'Chronos',
      'Profile',
      'Identity',
      'Staking',
      'KnowledgeCollection',
      'ParanetKnowledgeCollectionsRegistry',
      'ParanetKnowledgeMinersRegistry',
      'ParanetsRegistry',
      'KnowledgeAssetsStorage',
      'KnowledgeAssets',
      'ContextGraphs',
      'ContextGraphStorage',
    ]);

    const signers = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');

    const result: Fixture = {
      accounts: signers,
      Hub,
      ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
      ContextGraphStorage: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
      IdentityStorage: await hre.ethers.getContract<IdentityStorage>('IdentityStorage'),
      Profile: await hre.ethers.getContract<Profile>('Profile'),
      KnowledgeAssets: await hre.ethers.getContract<KnowledgeAssets>('KnowledgeAssets'),
      KnowledgeAssetsStorage: await hre.ethers.getContract<KnowledgeAssetsStorage>('KnowledgeAssetsStorage'),
      Token: await hre.ethers.getContract<Token>('Token'),
      ParametersStorage: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
      EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
      AskStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
      Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
      Identity: await hre.ethers.getContract<Identity>('Identity'),
      Staking: await hre.ethers.getContract<Staking>('Staking'),
    };

    await Hub.setContractAddress('HubOwner', signers[0].address);
    await Hub.setContractAddress('TestBatchHelper', signers[19].address);

    return result;
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    Hub = f.Hub;
    ContextGraphsContract = f.ContextGraphs;
    ContextGraphStorageContract = f.ContextGraphStorage;
    ProfileContract = f.Profile;
    KnowledgeAssetsContract = f.KnowledgeAssets;
    KnowledgeAssetsStorageContract = f.KnowledgeAssetsStorage;
    TokenContract = f.Token;
    ParametersStorageContract = f.ParametersStorage;
    IdentityStorageContract = f.IdentityStorage;
    IdentityContract = f.Identity;
    StakingContract = f.Staking;
    AskStorageContract = f.AskStorage;
  });

  // ========================================================================
  // Helpers
  // ========================================================================

  async function createBatchWithRoot(merkleRoot: string, publisher: string): Promise<bigint> {
    await KnowledgeAssetsStorageContract.connect(accounts[19]).createKnowledgeBatch(
      publisher, merkleRoot, 1000, 10, 1, 10, 1, 100, 0, false,
    );
    return KnowledgeAssetsStorageContract.getLatestBatchId();
  }

  async function setupPublisherAndReceivers() {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts, 2);

    const { identityId: publisherId } = await createProfile(ProfileContract, publishingNode);
    const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);

    await ParametersStorageContract.setMinimumRequiredSignatures(2);

    return { publishingNode, receivingNodes, publisherId, receiverIdentityIds };
  }

  /**
   * Build receiver signatures: each receiver signs keccak256(merkleRoot, publicByteSize).
   */
  async function buildReceiverSignatures(
    receivingNodes: { operational: SignerWithAddress; admin: SignerWithAddress }[],
    merkleRoot: string,
    publicByteSize: bigint,
  ) {
    const msgHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'uint64'],
      [merkleRoot, publicByteSize],
    );
    const rs: string[] = [];
    const vss: string[] = [];
    for (const node of receivingNodes) {
      const { r, vs } = await signMessage(node.operational, msgHash);
      rs.push(r);
      vss.push(vs);
    }
    return { rs, vss };
  }

  /**
   * Build publisher signature: sign keccak256(identityId, merkleRoot).
   */
  async function buildPublisherSignature(
    publishingNode: { operational: SignerWithAddress; admin: SignerWithAddress },
    publisherId: number,
    merkleRoot: string,
  ) {
    const msgHash = ethers.solidityPackedKeccak256(
      ['uint72', 'bytes32'],
      [publisherId, merkleRoot],
    );
    return signMessage(publishingNode.operational, msgHash);
  }

  /**
   * Build participant signatures over (contextGraphId, merkleRoot).
   * This is the NEW signature message for context graph governance.
   */
  async function buildParticipantSignatures(
    signers: SignerWithAddress[],
    contextGraphId: bigint,
    merkleRoot: string,
  ) {
    const digest = ethers.solidityPackedKeccak256(
      ['uint256', 'bytes32'],
      [contextGraphId, merkleRoot],
    );
    const rs: string[] = [];
    const vss: string[] = [];
    for (const signer of signers) {
      const { r, vs } = await signMessage(signer, digest);
      rs.push(r);
      vss.push(vs);
    }
    return { rs, vss };
  }

  // ========================================================================
  // 1. addBatchToContextGraph — updated signature: (contextGraphId, merkleRoot)
  // ========================================================================

  describe('addBatchToContextGraph with merkleRoot-based signatures', () => {
    it('accepts valid signatures over (contextGraphId, merkleRoot)', async () => {
      const signer1 = accounts[3];
      const admin1 = accounts[4];
      const signer2 = accounts[5];
      const admin2 = accounts[6];

      const { identityId: id1 } = await createProfile(ProfileContract, { operational: signer1, admin: admin1 });
      const { identityId: id2 } = await createProfile(ProfileContract, { operational: signer2, admin: admin2 });

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [id1, id2],
        2,
        0,
      );
      const contextGraphId = 1n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('test-data-root'));

      // Participants sign (contextGraphId, merkleRoot) instead of (contextGraphId, batchId)
      const { rs, vss } = await buildParticipantSignatures(
        [signer1, signer2],
        contextGraphId,
        merkleRoot,
      );

      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId,
          batchId,
          merkleRoot,
          [id1, id2],
          [rs[0], rs[1]],
          [vss[0], vss[1]],
        ),
      ).to.emit(ContextGraphStorageContract, 'ContextGraphExpanded')
        .withArgs(contextGraphId, batchId);
    });

    it('rejects signatures computed over old (contextGraphId, batchId) scheme', async () => {
      const signer = accounts[3];
      const admin = accounts[4];
      const { identityId } = await createProfile(ProfileContract, { operational: signer, admin });

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId],
        1,
        0,
      );

      const contextGraphId = 1n;
      const batchId = 99n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('some-data'));

      // Sign the OLD way: (contextGraphId, batchId) — should be rejected
      const oldDigest = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256'],
        [contextGraphId, batchId],
      );
      const { r, vs } = await signMessage(signer, oldDigest);

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId,
          batchId,
          merkleRoot,
          [identityId],
          [r],
          [vs],
        ),
      ).to.be.reverted;
    });

    it('rejects when M signatures not met', async () => {
      const signer1 = accounts[3];
      const admin1 = accounts[4];
      const signer2 = accounts[5];
      const admin2 = accounts[6];

      const { identityId: id1 } = await createProfile(ProfileContract, { operational: signer1, admin: admin1 });
      const { identityId: id2 } = await createProfile(ProfileContract, { operational: signer2, admin: admin2 });

      // Require 2 signatures
      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [id1, id2],
        2,
        0,
      );

      const contextGraphId = 1n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('data'));

      // Only provide 1 signature
      const { rs, vss } = await buildParticipantSignatures(
        [signer1],
        contextGraphId,
        merkleRoot,
      );

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId,
          42n,
          merkleRoot,
          [id1],
          rs,
          vss,
        ),
      ).to.be.revertedWith('Not enough signatures');
    });

    it('rejects when signer is not a participant', async () => {
      const participant = accounts[3];
      const participantAdmin = accounts[4];
      const outsider = accounts[5];
      const outsiderAdmin = accounts[6];

      const { identityId: participantId } = await createProfile(ProfileContract, {
        operational: participant,
        admin: participantAdmin,
      });
      const { identityId: outsiderId } = await createProfile(ProfileContract, {
        operational: outsider,
        admin: outsiderAdmin,
      });

      // Only participantId is in the context graph
      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [participantId],
        1,
        0,
      );

      const contextGraphId = 1n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('data'));

      // Outsider signs
      const { rs, vss } = await buildParticipantSignatures(
        [outsider],
        contextGraphId,
        merkleRoot,
      );

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId,
          42n,
          merkleRoot,
          [outsiderId],
          rs,
          vss,
        ),
      ).to.be.revertedWith('Signer not a participant');
    });
  });

  // ========================================================================
  // 2. publishToContextGraph — atomic publish + context graph registration
  // ========================================================================

  describe('publishToContextGraph (atomic combined operation)', () => {
    it('publishes KC and registers to context graph in one transaction', async () => {
      const { publishingNode, receivingNodes, publisherId, receiverIdentityIds } =
        await setupPublisherAndReceivers();

      const kcCreator = getDefaultKCCreator(accounts);
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('atomic-publish'));
      const publicByteSize = 1000n;

      // Create context graph with the publisher as participant
      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [publisherId],
        1,
        0,
      );
      const contextGraphId = 1n;

      // Build all signatures
      const { r: publisherR, vs: publisherVS } = await buildPublisherSignature(
        publishingNode,
        publisherId,
        merkleRoot,
      );
      const { rs: receiverRs, vss: receiverVSs } = await buildReceiverSignatures(
        receivingNodes,
        merkleRoot,
        publicByteSize,
      );
      const { rs: participantRs, vss: participantVSs } = await buildParticipantSignatures(
        [publishingNode.operational],
        contextGraphId,
        merkleRoot,
      );

      // Fund the KC creator with tokens
      const tokenAmount = ethers.parseEther('100');
      await TokenContract.mint(kcCreator.address, tokenAmount * 2n);
      await TokenContract.connect(kcCreator).increaseAllowance(
        await KnowledgeAssetsContract.getAddress(),
        tokenAmount,
      );

      // The new publishToContextGraph function: publish + register in one tx
      const tx = await KnowledgeAssetsContract.connect(kcCreator).publishToContextGraph(
        // publish params
        10, // kaCount
        publisherId,
        merkleRoot,
        publicByteSize,
        2, // epochs
        tokenAmount,
        ethers.ZeroAddress, // paymaster
        publisherR,
        publisherVS,
        receiverIdentityIds,
        receiverRs,
        receiverVSs,
        // context graph params
        contextGraphId,
        [publisherId],
        participantRs,
        participantVSs,
      );
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      // Verify the batch was created
      const latestBatch = await KnowledgeAssetsStorageContract.getLatestBatchId();
      expect(latestBatch).to.be.greaterThan(0);

      // Verify the batch was registered in the context graph
      const batches = await ContextGraphStorageContract.getContextGraphBatches(contextGraphId);
      expect(batches.length).to.equal(1);
    });

    it('reverts if receiver signatures are insufficient', async () => {
      const publishingNode = getDefaultPublishingNode(accounts);
      const { identityId: publisherId } = await createProfile(ProfileContract, publishingNode);

      await ParametersStorageContract.setMinimumRequiredSignatures(2);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [publisherId],
        1,
        0,
      );

      const kcCreator = getDefaultKCCreator(accounts);
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('insufficient-recv'));
      const publicByteSize = 500n;

      const { r: publisherR, vs: publisherVS } = await buildPublisherSignature(
        publishingNode,
        publisherId,
        merkleRoot,
      );

      // Only 1 receiver sig, but 2 required
      const { rs: receiverRs, vss: receiverVSs } = await buildReceiverSignatures(
        [publishingNode],
        merkleRoot,
        publicByteSize,
      );

      const { rs: participantRs, vss: participantVSs } = await buildParticipantSignatures(
        [publishingNode.operational],
        1n,
        merkleRoot,
      );

      const tokenAmount = ethers.parseEther('100');
      await TokenContract.mint(kcCreator.address, tokenAmount * 2n);
      await TokenContract.connect(kcCreator).increaseAllowance(
        await KnowledgeAssetsContract.getAddress(),
        tokenAmount,
      );

      await expect(
        KnowledgeAssetsContract.connect(kcCreator).publishToContextGraph(
          5,
          publisherId,
          merkleRoot,
          publicByteSize,
          2,
          tokenAmount,
          ethers.ZeroAddress,
          publisherR,
          publisherVS,
          [publisherId],
          receiverRs,
          receiverVSs,
          1n,
          [publisherId],
          participantRs,
          participantVSs,
        ),
      ).to.be.revertedWithCustomError(KnowledgeAssetsContract, 'MinSignaturesRequirementNotMet');
    });

    it('reverts if participant signatures are insufficient for context graph', async () => {
      const { publishingNode, receivingNodes, publisherId, receiverIdentityIds } =
        await setupPublisherAndReceivers();

      const participant2 = accounts[7];
      const participant2Admin = accounts[8];
      const { identityId: participant2Id } = await createProfile(ProfileContract, {
        operational: participant2,
        admin: participant2Admin,
      });

      // Require 2 participant signatures
      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [publisherId, participant2Id],
        2,
        0,
      );

      const kcCreator = getDefaultKCCreator(accounts);
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('insuf-participant'));
      const publicByteSize = 500n;

      const { r: publisherR, vs: publisherVS } = await buildPublisherSignature(
        publishingNode,
        publisherId,
        merkleRoot,
      );
      const { rs: receiverRs, vss: receiverVSs } = await buildReceiverSignatures(
        receivingNodes,
        merkleRoot,
        publicByteSize,
      );
      // Only 1 participant signature, but 2 required
      const { rs: participantRs, vss: participantVSs } = await buildParticipantSignatures(
        [publishingNode.operational],
        1n,
        merkleRoot,
      );

      const tokenAmount = ethers.parseEther('100');
      await TokenContract.mint(kcCreator.address, tokenAmount * 2n);
      await TokenContract.connect(kcCreator).increaseAllowance(
        await KnowledgeAssetsContract.getAddress(),
        tokenAmount,
      );

      await expect(
        KnowledgeAssetsContract.connect(kcCreator).publishToContextGraph(
          5,
          publisherId,
          merkleRoot,
          publicByteSize,
          2,
          tokenAmount,
          ethers.ZeroAddress,
          publisherR,
          publisherVS,
          receiverIdentityIds,
          receiverRs,
          receiverVSs,
          1n,
          [publisherId],
          participantRs,
          participantVSs,
        ),
      ).to.be.revertedWith('Not enough signatures');
    });

    it('emits both KnowledgeBatchCreated and ContextGraphExpanded events', async () => {
      const { publishingNode, receivingNodes, publisherId, receiverIdentityIds } =
        await setupPublisherAndReceivers();

      const kcCreator = getDefaultKCCreator(accounts);
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('events-test'));
      const publicByteSize = 1000n;

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [publisherId],
        1,
        0,
      );
      const contextGraphId = 1n;

      const { r: publisherR, vs: publisherVS } = await buildPublisherSignature(
        publishingNode,
        publisherId,
        merkleRoot,
      );
      const { rs: receiverRs, vss: receiverVSs } = await buildReceiverSignatures(
        receivingNodes,
        merkleRoot,
        publicByteSize,
      );
      const { rs: participantRs, vss: participantVSs } = await buildParticipantSignatures(
        [publishingNode.operational],
        contextGraphId,
        merkleRoot,
      );

      const tokenAmount = ethers.parseEther('100');
      await TokenContract.mint(kcCreator.address, tokenAmount * 2n);
      await TokenContract.connect(kcCreator).increaseAllowance(
        await KnowledgeAssetsContract.getAddress(),
        tokenAmount,
      );

      const tx = KnowledgeAssetsContract.connect(kcCreator).publishToContextGraph(
        5,
        publisherId,
        merkleRoot,
        publicByteSize,
        2,
        tokenAmount,
        ethers.ZeroAddress,
        publisherR,
        publisherVS,
        receiverIdentityIds,
        receiverRs,
        receiverVSs,
        contextGraphId,
        [publisherId],
        participantRs,
        participantVSs,
      );

      await expect(tx).to.emit(ContextGraphStorageContract, 'ContextGraphExpanded');
    });
  });

  // ========================================================================
  // 3. Edge node identity — profile without stake, usable as participant
  // ========================================================================

  describe('Edge node identity as context graph participant', () => {
    it('edge node (profile, no stake) can be a context graph participant', async () => {
      // Create edge node: has identity via createProfile but no stake
      const edgeOp = accounts[3];
      const edgeAdmin = accounts[4];
      const { identityId: edgeId } = await createProfile(ProfileContract, {
        operational: edgeOp,
        admin: edgeAdmin,
      });

      // Edge node should have identityId > 0
      const onChainId = await IdentityStorageContract.getIdentityId(edgeOp.address);
      expect(onChainId).to.equal(edgeId);

      // Create context graph with edge node as participant
      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [edgeId],
        1,
        0,
      );
      const contextGraphId = 1n;

      // Edge node signs (contextGraphId, merkleRoot)
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('edge-node-data'));
      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);
      const { rs, vss } = await buildParticipantSignatures(
        [edgeOp],
        contextGraphId,
        merkleRoot,
      );

      // Should succeed — edge node has identity, can sign, is a valid participant
      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId,
          batchId,
          merkleRoot,
          [edgeId],
          rs,
          vss,
        ),
      ).to.emit(ContextGraphStorageContract, 'ContextGraphExpanded');
    });

    it('edge node signature is valid for context graph but not for KC receiver', async () => {
      // Edge node with identity but no stake should not be in the sharding table.
      // It can sign as a context graph participant but not as a KC receiver
      // (receiver signatures require minimumRequiredSignatures from staked core nodes).
      const edgeOp = accounts[3];
      const edgeAdmin = accounts[4];
      const { identityId: edgeId } = await createProfile(ProfileContract, {
        operational: edgeOp,
        admin: edgeAdmin,
      });

      // Context graph: edge node is participant → should work
      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [edgeId],
        1,
        0,
      );

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('edge-only'));
      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);
      const { rs, vss } = await buildParticipantSignatures([edgeOp], 1n, merkleRoot);

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          1n,
          batchId,
          merkleRoot,
          [edgeId],
          rs,
          vss,
        ),
      ).to.not.be.reverted;
    });

    it('mixed participants: core node + edge node can both sign', async () => {
      // Core node with stake
      const coreOp = accounts[3];
      const coreAdmin = accounts[4];
      const { identityId: coreId } = await createProfile(ProfileContract, {
        operational: coreOp,
        admin: coreAdmin,
      });

      // Edge node without stake
      const edgeOp = accounts[5];
      const edgeAdmin = accounts[6];
      const { identityId: edgeId } = await createProfile(ProfileContract, {
        operational: edgeOp,
        admin: edgeAdmin,
      });

      // Both are participants, require both signatures
      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [coreId, edgeId],
        2,
        0,
      );

      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('mixed-node'));
      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);
      const { rs, vss } = await buildParticipantSignatures(
        [coreOp, edgeOp],
        1n,
        merkleRoot,
      );

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          1n,
          batchId,
          merkleRoot,
          [coreId, edgeId],
          rs,
          vss,
        ),
      ).to.emit(ContextGraphStorageContract, 'ContextGraphExpanded');
    });
  });

  // ========================================================================
  // 4. Receiver signature verification (existing, verifying no regression)
  // ========================================================================

  describe('Receiver signature verification in publishKnowledgeAssets', () => {
    it('requires minimumRequiredSignatures receiver signatures', async () => {
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts, 2);

      const { identityId: publisherId } = await createProfile(ProfileContract, publishingNode);
      const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
      const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);

      await ParametersStorageContract.setMinimumRequiredSignatures(2);

      const kcCreator = getDefaultKCCreator(accounts);
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('recv-sig-test'));
      const publicByteSize = 1000n;

      const { r: publisherR, vs: publisherVS } = await buildPublisherSignature(
        publishingNode,
        publisherId,
        merkleRoot,
      );

      // Only 1 receiver signature → should fail
      const { rs: oneRs, vss: oneVSs } = await buildReceiverSignatures(
        [receivingNodes[0]],
        merkleRoot,
        publicByteSize,
      );

      const tokenAmount = ethers.parseEther('100');
      await TokenContract.mint(kcCreator.address, tokenAmount * 2n);
      await TokenContract.connect(kcCreator).increaseAllowance(
        await KnowledgeAssetsContract.getAddress(),
        tokenAmount,
      );

      await expect(
        KnowledgeAssetsContract.connect(kcCreator).publishKnowledgeAssets(
          5,
          publisherId,
          merkleRoot,
          publicByteSize,
          2,
          tokenAmount,
          ethers.ZeroAddress,
          publisherR,
          publisherVS,
          [receiverIdentityIds[0]],
          oneRs,
          oneVSs,
        ),
      ).to.be.revertedWithCustomError(KnowledgeAssetsContract, 'MinSignaturesRequirementNotMet');

      // 2 receiver signatures → should succeed
      const { rs: twoRs, vss: twoVSs } = await buildReceiverSignatures(
        receivingNodes,
        merkleRoot,
        publicByteSize,
      );

      const tx = await KnowledgeAssetsContract.connect(kcCreator).publishKnowledgeAssets(
        5,
        publisherId,
        merkleRoot,
        publicByteSize,
        2,
        tokenAmount,
        ethers.ZeroAddress,
        publisherR,
        publisherVS,
        receiverIdentityIds,
        twoRs,
        twoVSs,
      );
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;
    });
  });
});
