import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  KnowledgeAssets,
  KnowledgeAssetsStorage,
  KnowledgeCollection,
  KnowledgeCollectionStorage,
  EpochStorage,
  AskStorage,
  Chronos,
  Token,
  ParametersStorage,
  IdentityStorage,
  Hub,
  Profile,
  Identity,
  Staking,
} from '../../typechain';
import { signMessage } from '../helpers/kc-helpers';
import { createProfile, createProfiles } from '../helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKCCreator,
} from '../helpers/setup-helpers';

type V9Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  KnowledgeAssets: KnowledgeAssets;
  KnowledgeAssetsStorage: KnowledgeAssetsStorage;
  KnowledgeCollection: KnowledgeCollection;
  KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  EpochStorage: EpochStorage;
  AskStorage: AskStorage;
  Chronos: Chronos;
  Token: Token;
  ParametersStorage: ParametersStorage;
  IdentityStorage: IdentityStorage;
  Identity: Identity;
  Profile: Profile;
  Staking: Staking;
};

describe('@integration KnowledgeAssets V9', () => {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let KnowledgeAssets: KnowledgeAssets;
  let KnowledgeAssetsStorage: KnowledgeAssetsStorage;
  let EpochStorage: EpochStorage;
  let AskStorage: AskStorage;
  let Chronos: Chronos;
  let Token: Token;
  let ParametersStorage: ParametersStorage;
  let IdentityStorage: IdentityStorage;
  let Identity: Identity;
  let Profile: Profile;
  let Staking: Staking;

  async function deployV9Fixture(): Promise<V9Fixture> {
    await hre.deployments.fixture([
      'Token',
      'AskStorage',
      'EpochStorage',
      'Chronos',
      'Profile',
      'Identity',
      'Staking',
      'KnowledgeCollection',
      'KnowledgeAssetsStorage',
      'KnowledgeAssets',
    ]);

    accounts = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');

    const KnowledgeAssets = await hre.ethers.getContract<KnowledgeAssets>('KnowledgeAssets');
    const KnowledgeAssetsStorage = await hre.ethers.getContract<KnowledgeAssetsStorage>('KnowledgeAssetsStorage');
    const KnowledgeCollection = await hre.ethers.getContract<KnowledgeCollection>('KnowledgeCollection');
    const KnowledgeCollectionStorage = await hre.ethers.getContract<KnowledgeCollectionStorage>('KnowledgeCollectionStorage');
    const EpochStorage = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    const AskStorage = await hre.ethers.getContract<AskStorage>('AskStorage');
    const Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    const Token = await hre.ethers.getContract<Token>('Token');
    const ParametersStorage = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const IdentityStorage = await hre.ethers.getContract<IdentityStorage>('IdentityStorage');
    const Identity = await hre.ethers.getContract<Identity>('Identity');
    const Profile = await hre.ethers.getContract<Profile>('Profile');
    const Staking = await hre.ethers.getContract<Staking>('Staking');

    await Hub.setContractAddress('HubOwner', accounts[0].address);

    return {
      accounts,
      Hub,
      KnowledgeAssets,
      KnowledgeAssetsStorage,
      KnowledgeCollection,
      KnowledgeCollectionStorage,
      EpochStorage,
      AskStorage,
      Chronos,
      Token,
      ParametersStorage,
      IdentityStorage,
      Identity,
      Profile,
      Staking,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub,
      KnowledgeAssets,
      KnowledgeAssetsStorage,
      EpochStorage,
      AskStorage,
      Chronos,
      Token,
      ParametersStorage,
      IdentityStorage,
      Identity,
      Profile,
      Staking,
    } = await loadFixture(deployV9Fixture));
  });

  // ========================================================================
  // Deployment & Registration
  // ========================================================================

  it('Should deploy V9 contracts and register them in Hub', async () => {
    const kaAddr = await Hub.getContractAddress('KnowledgeAssets');
    const kasAddr = await Hub.getAssetStorageAddress('KnowledgeAssetsStorage');

    expect(kaAddr).to.not.equal(ethers.ZeroAddress);
    expect(kasAddr).to.not.equal(ethers.ZeroAddress);

    expect(await KnowledgeAssets.name()).to.equal('KnowledgeAssets');
    expect(await KnowledgeAssetsStorage.name()).to.equal('KnowledgeAssetsStorage');
  });

  it('V8 KnowledgeCollection contracts still registered in Hub', async () => {
    const kcAddr = await Hub.getContractAddress('KnowledgeCollection');
    expect(kcAddr).to.not.equal(ethers.ZeroAddress);
  });

  // ========================================================================
  // UAL Range Reservation (address-based, permissionless)
  // ========================================================================

  it('Should reserve a UAL range for any wallet (no identity needed)', async () => {
    const kcCreator = getDefaultKCCreator(accounts);

    const tx = await KnowledgeAssets.connect(kcCreator).reserveUALRange(100);
    await tx.wait();

    const rangeCount = await KnowledgeAssetsStorage.getPublisherRangesCount(kcCreator.address);
    expect(rangeCount).to.equal(1);

    const [startId, endId] = await KnowledgeAssetsStorage.getPublisherRange(kcCreator.address, 0);
    expect(startId).to.equal(1);
    expect(endId).to.equal(100);

    const nextId = await KnowledgeAssetsStorage.publisherNextId(kcCreator.address);
    expect(nextId).to.equal(101);
  });

  it('Should reserve multiple ranges consecutively', async () => {
    const kcCreator = getDefaultKCCreator(accounts);

    await KnowledgeAssets.connect(kcCreator).reserveUALRange(50);
    await KnowledgeAssets.connect(kcCreator).reserveUALRange(30);

    const rangeCount = await KnowledgeAssetsStorage.getPublisherRangesCount(kcCreator.address);
    expect(rangeCount).to.equal(2);

    const [start1, end1] = await KnowledgeAssetsStorage.getPublisherRange(kcCreator.address, 0);
    expect(start1).to.equal(1);
    expect(end1).to.equal(50);

    const [start2, end2] = await KnowledgeAssetsStorage.getPublisherRange(kcCreator.address, 1);
    expect(start2).to.equal(51);
    expect(end2).to.equal(80);
  });

  // ========================================================================
  // Helper: build core node signatures for a batch mint (receivers sign merkleRoot + publicByteSize)
  // ========================================================================

  async function buildSignatures(
    publishingNode: { admin: SignerWithAddress; operational: SignerWithAddress },
    pubId: number,
    receivingNodes: { admin: SignerWithAddress; operational: SignerWithAddress }[],
    merkleRoot: string,
    publicByteSize: number,
  ) {
    const pubMsgHash = ethers.solidityPackedKeccak256(
      ['uint72', 'bytes32'],
      [pubId, merkleRoot],
    );
    const { r: pubR, vs: pubVS } = await signMessage(publishingNode.operational, pubMsgHash);

    const receiverMsgHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'uint64'],
      [merkleRoot, BigInt(publicByteSize)],
    );
    const receiverRs: string[] = [];
    const receiverVSs: string[] = [];
    for (const node of receivingNodes) {
      const { r, vs } = await signMessage(node.operational, receiverMsgHash);
      receiverRs.push(r);
      receiverVSs.push(vs);
    }

    return { pubR, pubVS, receiverRs, receiverVSs };
  }

  // ========================================================================
  // Helper: mint a test batch and return context for update/extend tests
  // ========================================================================

  async function mintTestBatch(opts?: { byteSize?: number; epochs?: number; withAsk?: boolean }) {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    const byteSize = opts?.byteSize ?? 2048;
    const epochs = opts?.epochs ?? 3;

    if (opts?.withAsk) {
      await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
      await AskStorage.setTotalActiveStake(1);
    }

    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(byteSize) * BigInt(epochs)) / 1024n;

    if (tokenAmount > 0n) {
      await Token.mint(kcCreator.address, tokenAmount * 10n);
      const kaAddr = await KnowledgeAssets.getAddress();
      await Token.connect(kcCreator).increaseAllowance(kaAddr, tokenAmount * 10n);
    }

    // kcCreator reserves directly — no identity required
    await KnowledgeAssets.connect(kcCreator).reserveUALRange(20);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('batch-' + Date.now()));
    const { pubR, pubVS, receiverRs, receiverVSs } = await buildSignatures(
      publishingNode, pubId, receivingNodes, merkleRoot, byteSize,
    );

    await KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
      pubId, merkleRoot, 1, 5, byteSize, epochs, tokenAmount,
      ethers.ZeroAddress, pubR, pubVS, receiverIds, receiverRs, receiverVSs,
    );

    const batchId = await KnowledgeAssetsStorage.getLatestBatchId();
    return {
      publishingNode, receivingNodes, kcCreator,
      pubId, receiverIds, batchId, merkleRoot,
      byteSize, epochs, tokenAmount,
    };
  }

  // ========================================================================
  // Batch Minting (with TRAC; contract requires tokenAmount > 0)
  // ========================================================================

  it('Should batch-mint KAs with TRAC payment (tokenAmount required)', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);

    const publicByteSize = 1000;
    const epochs = 2;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(publicByteSize) * BigInt(epochs)) / 1024n;
    await Token.mint(kcCreator.address, tokenAmount * 2n);
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(kcCreator).increaseAllowance(kaAddr, tokenAmount * 2n);

    await KnowledgeAssets.connect(kcCreator).reserveUALRange(10);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('test-v9-merkleroot'));
    const { pubR, pubVS, receiverRs, receiverVSs } = await buildSignatures(
      publishingNode, pubId, receivingNodes, merkleRoot, publicByteSize,
    );

    const tx = await KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
      pubId,
      merkleRoot,
      1,    // startKAId
      5,    // endKAId (5 KAs)
      publicByteSize,
      epochs,
      tokenAmount,
      ethers.ZeroAddress,
      pubR,
      pubVS,
      receiverIds,
      receiverRs,
      receiverVSs,
    );
    await tx.wait();

    const batchId = await KnowledgeAssetsStorage.getLatestBatchId();
    expect(batchId).to.equal(1);

    const batch = await KnowledgeAssetsStorage.getBatch(1);
    expect(batch.publisherAddress).to.equal(kcCreator.address);
    expect(batch.merkleRoot).to.equal(merkleRoot);
    expect(batch.publicByteSize).to.equal(publicByteSize);
    expect(batch.knowledgeAssetsCount).to.equal(5);
    expect(batch.startKAId).to.equal(1);
    expect(batch.endKAId).to.equal(5);

    for (let id = 1; id <= 5; id++) {
      expect(await KnowledgeAssetsStorage.isKAIdUsed(kcCreator.address, id)).to.be.true;
      expect(await KnowledgeAssetsStorage.getBatchForKAId(kcCreator.address, id)).to.equal(1);
    }
    expect(await KnowledgeAssetsStorage.isKAIdUsed(kcCreator.address, 6)).to.be.false;

    expect(await KnowledgeAssetsStorage.getTotalKnowledgeAssets()).to.equal(5);
  });

  it('Should revert when tokenAmount is 0 (ZeroTokenAmount)', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    await KnowledgeAssets.connect(kcCreator).reserveUALRange(10);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('zero-token-test'));
    const publicByteSize = 1000;
    const { pubR, pubVS, receiverRs, receiverVSs } = await buildSignatures(
      publishingNode, pubId, receivingNodes, merkleRoot, publicByteSize,
    );

    await expect(
      KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
        pubId, merkleRoot, 1, 3, publicByteSize, 2, 0, ethers.ZeroAddress,
        pubR, pubVS, receiverIds, receiverRs, receiverVSs,
      ),
    ).to.be.revertedWithCustomError(KnowledgeAssets, 'ZeroTokenAmount');
  });

  // ========================================================================
  // Batch Minting with TRAC Payment
  // ========================================================================

  it('Should batch-mint with TRAC payment when ask > 0', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);

    const byteSize = 2048;
    const epochs = 3;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(byteSize) * BigInt(epochs)) / 1024n;

    await Token.mint(kcCreator.address, tokenAmount * 2n);

    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(kcCreator).increaseAllowance(kaAddr, tokenAmount);

    await KnowledgeAssets.connect(kcCreator).reserveUALRange(10);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('test-trac-payment'));
    const { pubR, pubVS, receiverRs, receiverVSs } = await buildSignatures(
      publishingNode, pubId, receivingNodes, merkleRoot, byteSize,
    );

    const balanceBefore = await Token.balanceOf(kcCreator.address);

    await KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
      pubId,
      merkleRoot,
      1, 3,
      byteSize,
      epochs,
      tokenAmount,
      ethers.ZeroAddress,
      pubR, pubVS,
      receiverIds,
      receiverRs,
      receiverVSs,
    );

    const balanceAfter = await Token.balanceOf(kcCreator.address);
    expect(balanceBefore - balanceAfter).to.equal(tokenAmount);

    const batch = await KnowledgeAssetsStorage.getBatch(1);
    expect(batch.tokenAmount).to.equal(tokenAmount);
    expect(batch.publicByteSize).to.equal(byteSize);
  });

  // ========================================================================
  // Cannot reuse KA IDs
  // ========================================================================

  it('Should reject batch-mint with already-used KA IDs', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);
    const publicByteSize = 1000;
    const epochs = 2;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(publicByteSize) * BigInt(epochs)) / 1024n;
    await Token.mint(kcCreator.address, tokenAmount * 2n);
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(kcCreator).increaseAllowance(kaAddr, tokenAmount * 2n);

    await KnowledgeAssets.connect(kcCreator).reserveUALRange(10);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('first-batch'));
    const { pubR, pubVS, receiverRs, receiverVSs } = await buildSignatures(
      publishingNode, pubId, receivingNodes, merkleRoot, publicByteSize,
    );

    await KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
      pubId, merkleRoot, 1, 3, publicByteSize, epochs, tokenAmount, ethers.ZeroAddress,
      pubR, pubVS, receiverIds, receiverRs, receiverVSs,
    );

    // Second mint with overlapping IDs should fail
    const merkleRoot2 = ethers.keccak256(ethers.toUtf8Bytes('second-batch'));
    const sigs2 = await buildSignatures(publishingNode, pubId, receivingNodes, merkleRoot2, publicByteSize);
    const tokenAmount2 = (ask * BigInt(publicByteSize) * BigInt(epochs)) / 1024n;

    // Catches regression where KA ID reuse (1..3 already used, 1..5 overlaps) silently
    // passes without `KAIdAlreadyUsed` being raised by KnowledgeAssetsLib.
    await expect(
      KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
        pubId, merkleRoot2, 1, 5, publicByteSize, epochs, tokenAmount2, ethers.ZeroAddress,
        sigs2.pubR, sigs2.pubVS, receiverIds, sigs2.receiverRs, sigs2.receiverVSs,
      )
    ).to.be.revertedWithCustomError(KnowledgeAssets, 'KAIdAlreadyUsed');
  });

  // ========================================================================
  // V8 + V9 Coexistence
  // ========================================================================

  it('V8 KnowledgeCollection and V9 KnowledgeAssets both work side by side', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);
    const v9ByteSize = 1000;
    const v9Epochs = 2;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const v9TokenAmount = (ask * BigInt(v9ByteSize) * BigInt(v9Epochs)) / 1024n;
    await Token.mint(kcCreator.address, v9TokenAmount * 2n);
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(kcCreator).increaseAllowance(kaAddr, v9TokenAmount * 2n);

    // --- V9 publish ---
    await KnowledgeAssets.connect(kcCreator).reserveUALRange(10);

    const v9MerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('v9-data'));
    const v9Sigs = await buildSignatures(publishingNode, pubId, receivingNodes, v9MerkleRoot, v9ByteSize);

    await KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
      pubId, v9MerkleRoot, 1, 3, v9ByteSize, v9Epochs, v9TokenAmount, ethers.ZeroAddress,
      v9Sigs.pubR, v9Sigs.pubVS, receiverIds, v9Sigs.receiverRs, v9Sigs.receiverVSs,
    );

    // --- V8 publish (legacy flow) ---
    const v8MerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('v8-legacy'));
    const v8ByteSize = 1000;
    const v8Epochs = 2;
    const v8TokenAmount = (ask * BigInt(v8ByteSize) * BigInt(v8Epochs)) / 1024n;
    await Token.mint(kcCreator.address, v8TokenAmount * 2n);
    const kcAddr = (await hre.ethers.getContract<KnowledgeCollection>('KnowledgeCollection')).getAddress();
    await Token.connect(kcCreator).increaseAllowance(kcAddr, v8TokenAmount * 2n);

    const v8PubHash = ethers.solidityPackedKeccak256(['uint72', 'bytes32'], [pubId, v8MerkleRoot]);
    const { r: v8PubR, vs: v8PubVS } = await signMessage(publishingNode.operational, v8PubHash);
    const v8RecRs: string[] = [];
    const v8RecVSs: string[] = [];
    for (const node of receivingNodes) {
      const { r, vs } = await signMessage(node.operational, v8MerkleRoot);
      v8RecRs.push(r);
      v8RecVSs.push(vs);
    }

    const KnowledgeCollectionContract = await hre.ethers.getContract<KnowledgeCollection>('KnowledgeCollection');
    await KnowledgeCollectionContract.connect(kcCreator).createKnowledgeCollection(
      'v8-legacy-op',
      v8MerkleRoot,
      5,
      v8ByteSize,
      v8Epochs,
      v8TokenAmount,
      false,
      ethers.ZeroAddress,
      pubId,
      v8PubR,
      v8PubVS,
      receiverIds,
      v8RecRs,
      v8RecVSs,
    );

    // Both systems have data
    expect(await KnowledgeAssetsStorage.getLatestBatchId()).to.equal(1);

    const KnowledgeCollectionStorageContract = await hre.ethers.getContract<KnowledgeCollectionStorage>('KnowledgeCollectionStorage');
    expect(await KnowledgeCollectionStorageContract.getLatestKnowledgeCollectionId()).to.equal(1);

    const v9Batch = await KnowledgeAssetsStorage.getBatch(1);
    expect(v9Batch.merkleRoot).to.equal(v9MerkleRoot);

    const v8Root = await KnowledgeCollectionStorageContract.getLatestMerkleRoot(1);
    expect(v8Root).to.equal(v8MerkleRoot);
  });

  // ========================================================================
  // updateKnowledgeAssets
  // ========================================================================

  it('Should update a batch (same size, 10% fee)', async () => {
    const ctx = await mintTestBatch({ withAsk: true });

    const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('updated-root'));
    const newByteSize = ctx.byteSize;

    await KnowledgeAssets.connect(ctx.kcCreator).updateKnowledgeAssets(
      ctx.batchId, newMerkleRoot, newByteSize,
    );

    const batch = await KnowledgeAssetsStorage.getBatch(ctx.batchId);
    expect(batch.merkleRoot).to.equal(newMerkleRoot);
    expect(batch.publicByteSize).to.equal(newByteSize);
    expect(batch.tokenAmount).to.be.gt(ctx.tokenAmount);
  });

  it('Should update a batch (larger size, excess charged at full rate)', async () => {
    const ctx = await mintTestBatch({ withAsk: true, byteSize: 1024 });

    const newByteSize = 4096;
    const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('bigger-root'));

    const batchBefore = await KnowledgeAssetsStorage.getBatch(ctx.batchId);

    await KnowledgeAssets.connect(ctx.kcCreator).updateKnowledgeAssets(
      ctx.batchId, newMerkleRoot, newByteSize,
    );

    const batchAfter = await KnowledgeAssetsStorage.getBatch(ctx.batchId);
    expect(batchAfter.publicByteSize).to.equal(newByteSize);
    const updateCost = batchAfter.tokenAmount - batchBefore.tokenAmount;
    const baseFee = batchBefore.tokenAmount / 10n;
    expect(updateCost).to.be.gt(baseFee);
  });

  it('Should reject update from non-publisher', async () => {
    const ctx = await mintTestBatch({ withAsk: true });
    const stranger = accounts[15];

    // Catches regression where ACL check (`batch.publisherAddress != msg.sender`)
    // is weakened and non-publisher updates succeed or revert with a different error.
    await expect(
      KnowledgeAssets.connect(stranger).updateKnowledgeAssets(
        ctx.batchId,
        ethers.keccak256(ethers.toUtf8Bytes('evil-root')),
        1000,
      )
    )
      .to.be.revertedWithCustomError(KnowledgeAssets, 'NotBatchPublisher')
      .withArgs(ctx.batchId, stranger.address);
  });

  it('Should reject update on non-existent batch', async () => {
    const kcCreator = getDefaultKCCreator(accounts);

    // Catches regression where missing-batch sentinel check is lost and the
    // call either no-ops or reverts with a misleading error.
    await expect(
      KnowledgeAssets.connect(kcCreator).updateKnowledgeAssets(
        999,
        ethers.keccak256(ethers.toUtf8Bytes('ghost')),
        1000,
      )
    )
      .to.be.revertedWithCustomError(KnowledgeAssets, 'BatchNotFound')
      .withArgs(999);
  });

  // ========================================================================
  // extendStorage
  // ========================================================================

  it('Should extend storage duration', async () => {
    const ctx = await mintTestBatch({ withAsk: true });

    const batchBefore = await KnowledgeAssetsStorage.getBatch(ctx.batchId);
    const additionalEpochs = 5;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const extensionCost = (ask * BigInt(ctx.byteSize) * BigInt(additionalEpochs)) / 1024n;

    await KnowledgeAssets.connect(ctx.kcCreator).extendStorage(
      ctx.batchId, additionalEpochs, extensionCost, ethers.ZeroAddress,
    );

    const batchAfter = await KnowledgeAssetsStorage.getBatch(ctx.batchId);
    expect(batchAfter.endEpoch).to.equal(batchBefore.endEpoch + BigInt(additionalEpochs));
    expect(batchAfter.tokenAmount).to.equal(batchBefore.tokenAmount + extensionCost);
  });

  it('Should reject extendStorage with insufficient tokens', async () => {
    const ctx = await mintTestBatch({ withAsk: true });

    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const insufficientAmount = (ask * BigInt(ctx.byteSize) * 5n) / 1024n / 2n;

    // Catches regression where `_validateTokenAmount` pricing check is
    // softened and under-payment slips through instead of reverting.
    await expect(
      KnowledgeAssets.connect(ctx.kcCreator).extendStorage(
        ctx.batchId, 5, insufficientAmount, ethers.ZeroAddress,
      )
    ).to.be.revertedWithCustomError(KnowledgeAssets, 'InvalidTokenAmount');
  });

  it('Should reject extendStorage on non-existent batch', async () => {
    const kcCreator = getDefaultKCCreator(accounts);

    // Catches regression where extendStorage silently no-ops or reverts
    // elsewhere for unknown batch IDs.
    await expect(
      KnowledgeAssets.connect(kcCreator).extendStorage(
        999, 5, 0, ethers.ZeroAddress,
      )
    )
      .to.be.revertedWithCustomError(KnowledgeAssets, 'BatchNotFound')
      .withArgs(999);
  });

  // ========================================================================
  // Signature verification edge cases
  // ========================================================================

  it('Should reject batchMint with invalid publisher signature', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);
    const publicByteSize = 1000;
    const epochs = 2;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(publicByteSize) * BigInt(epochs)) / 1024n;
    await Token.mint(kcCreator.address, tokenAmount * 2n);
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(kcCreator).increaseAllowance(kaAddr, tokenAmount * 2n);

    await KnowledgeAssets.connect(kcCreator).reserveUALRange(10);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('bad-sig-test'));

    // Sign with wrong signer
    const wrongSigner = accounts[15];
    const pubMsgHash = ethers.solidityPackedKeccak256(['uint72', 'bytes32'], [pubId, merkleRoot]);
    const { r: badR, vs: badVS } = await signMessage(wrongSigner, pubMsgHash);

    const receiverMsgHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'uint64'],
      [merkleRoot, BigInt(publicByteSize)],
    );
    const receiverRs: string[] = [];
    const receiverVSs: string[] = [];
    for (const node of receivingNodes) {
      const { r, vs } = await signMessage(node.operational, receiverMsgHash);
      receiverRs.push(r);
      receiverVSs.push(vs);
    }

    // wrongSigner recovers successfully (non-zero) but is not attached as an
    // operational key on `pubId`, so the signer-not-operator branch must trip.
    // Catches regression where the operator-key check is removed.
    await expect(
      KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
        pubId, merkleRoot, 1, 3, publicByteSize, epochs, tokenAmount, ethers.ZeroAddress,
        badR, badVS, receiverIds, receiverRs, receiverVSs,
      )
    ).to.be.revertedWithCustomError(KnowledgeAssets, 'SignerIsNotNodeOperator');
  });

  it('Should reject batchMint with invalid receiver signature', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);
    const publicByteSize = 1000;
    const epochs = 2;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(publicByteSize) * BigInt(epochs)) / 1024n;
    await Token.mint(kcCreator.address, tokenAmount * 2n);
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(kcCreator).increaseAllowance(kaAddr, tokenAmount * 2n);

    await KnowledgeAssets.connect(kcCreator).reserveUALRange(10);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('bad-receiver-sig'));
    const pubMsgHash = ethers.solidityPackedKeccak256(['uint72', 'bytes32'], [pubId, merkleRoot]);
    const { r: pubR, vs: pubVS } = await signMessage(publishingNode.operational, pubMsgHash);

    const wrongSigner = accounts[18];
    const receiverMsgHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'uint64'],
      [merkleRoot, BigInt(publicByteSize)],
    );
    const receiverRs: string[] = [];
    const receiverVSs: string[] = [];
    for (const _ of receivingNodes) {
      const { r, vs } = await signMessage(wrongSigner, receiverMsgHash);
      receiverRs.push(r);
      receiverVSs.push(vs);
    }

    // Same rationale as the publisher-signature case: wrongSigner isn't
    // attached as operational key on any receiver identity.
    await expect(
      KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
        pubId, merkleRoot, 1, 3, publicByteSize, epochs, tokenAmount, ethers.ZeroAddress,
        pubR, pubVS, receiverIds, receiverRs, receiverVSs,
      )
    ).to.be.revertedWithCustomError(KnowledgeAssets, 'SignerIsNotNodeOperator');
  });

  it('Should reject batchMint with insufficient token amount', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);

    const byteSize = 2048;
    const epochs = 3;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const requiredAmount = (ask * BigInt(byteSize) * BigInt(epochs)) / 1024n;
    await Token.mint(kcCreator.address, requiredAmount);
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(kcCreator).increaseAllowance(kaAddr, requiredAmount);

    await KnowledgeAssets.connect(kcCreator).reserveUALRange(10);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('low-token'));
    const { pubR, pubVS, receiverRs, receiverVSs } = await buildSignatures(
      publishingNode, pubId, receivingNodes, merkleRoot, byteSize,
    );

    const lowTokenAmount = requiredAmount > 1n ? requiredAmount - 1n : 0n;

    // Catches regression where `_validateTokenAmount` cost floor is removed
    // and under-priced publishes slip through.
    await expect(
      KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
        pubId, merkleRoot, 1, 3, byteSize, epochs, lowTokenAmount, ethers.ZeroAddress,
        pubR, pubVS, receiverIds, receiverRs, receiverVSs,
      )
    ).to.be.revertedWithCustomError(KnowledgeAssets, 'InvalidTokenAmount');
  });

  // ========================================================================
  // Duplicate receiver identity checks
  // ========================================================================

  it('Should revert batchMint when all receiver identities are the same', async () => {
    const minSigs = Number(await ParametersStorage.minimumRequiredSignatures());
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts, minSigs);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);
    const publicByteSize = 1000;
    const epochs = 2;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(publicByteSize) * BigInt(epochs)) / 1024n;
    await Token.mint(kcCreator.address, tokenAmount * 2n);
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(kcCreator).increaseAllowance(kaAddr, tokenAmount * 2n);
    await KnowledgeAssets.connect(kcCreator).reserveUALRange(10);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('dup-receiver-test'));
    const { pubR, pubVS, receiverRs, receiverVSs } = await buildSignatures(
      publishingNode, pubId, receivingNodes, merkleRoot, publicByteSize,
    );

    // TAMPER: fill all minSigs positions with receiver 0's identity and signature
    const dupReceiverIds = Array(minSigs).fill(receiverProfiles[0].identityId);
    const dupReceiverRs = Array(minSigs).fill(receiverRs[0]);
    const dupReceiverVSs = Array(minSigs).fill(receiverVSs[0]);

    await expect(
      KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
        pubId, merkleRoot, 1, 5, publicByteSize, epochs, tokenAmount,
        ethers.ZeroAddress, pubR, pubVS,
        dupReceiverIds, dupReceiverRs, dupReceiverVSs,
      ),
    ).to.be.revertedWith('Insufficient unique receiver identities');
  });

  it('Should accept batchMint when duplicates exist but enough unique identities remain', async () => {
    const minSigs = Number(await ParametersStorage.minimumRequiredSignatures());
    const publishingNode = getDefaultPublishingNode(accounts);
    // Need minSigs unique receivers; create exactly minSigs nodes
    const receivingNodes = getDefaultReceivingNodes(accounts, minSigs);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);
    const publicByteSize = 1000;
    const epochs = 2;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(publicByteSize) * BigInt(epochs)) / 1024n;
    await Token.mint(kcCreator.address, tokenAmount * 2n);
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(kcCreator).increaseAllowance(kaAddr, tokenAmount * 2n);
    await KnowledgeAssets.connect(kcCreator).reserveUALRange(10);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('dup-but-enough-test'));
    const { pubR, pubVS, receiverRs, receiverVSs } = await buildSignatures(
      publishingNode, pubId, receivingNodes, merkleRoot, publicByteSize,
    );

    // minSigs+1 entries: receiver 0 duplicated once, all others unique → minSigs unique
    const mixedReceiverIds = [
      receiverProfiles[0].identityId,
      ...receiverProfiles.map((p) => p.identityId),
    ];
    const mixedReceiverRs = [receiverRs[0], ...receiverRs];
    const mixedReceiverVSs = [receiverVSs[0], ...receiverVSs];

    const tx = await KnowledgeAssets.connect(kcCreator).batchMintKnowledgeAssets(
      pubId, merkleRoot, 1, 5, publicByteSize, epochs, tokenAmount,
      ethers.ZeroAddress, pubR, pubVS,
      mixedReceiverIds, mixedReceiverRs, mixedReceiverVSs,
    );
    await tx.wait();

    const batchId = await KnowledgeAssetsStorage.getLatestBatchId();
    expect(batchId).to.equal(1);
  });

  // ========================================================================
  // Full lifecycle: reserve → mint → update → extend → second batch
  // ========================================================================

  it('Full lifecycle: reserve → mint → update → extend → second batch', async () => {
    const ctx = await mintTestBatch({ withAsk: true, byteSize: 2048, epochs: 5 });

    const batchAfterMint = await KnowledgeAssetsStorage.getBatch(ctx.batchId);
    expect(batchAfterMint.knowledgeAssetsCount).to.equal(5);

    // Update: new merkle root, same size
    const newRoot = ethers.keccak256(ethers.toUtf8Bytes('lifecycle-update'));
    await KnowledgeAssets.connect(ctx.kcCreator).updateKnowledgeAssets(
      ctx.batchId, newRoot, ctx.byteSize,
    );

    const batchAfterUpdate = await KnowledgeAssetsStorage.getBatch(ctx.batchId);
    expect(batchAfterUpdate.merkleRoot).to.equal(newRoot);
    expect(batchAfterUpdate.tokenAmount).to.be.gt(batchAfterMint.tokenAmount);

    // Extend: add 3 more epochs
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const extensionCost = (ask * BigInt(ctx.byteSize) * 3n) / 1024n;
    await KnowledgeAssets.connect(ctx.kcCreator).extendStorage(
      ctx.batchId, 3, extensionCost, ethers.ZeroAddress,
    );

    const batchAfterExtend = await KnowledgeAssetsStorage.getBatch(ctx.batchId);
    expect(batchAfterExtend.endEpoch).to.equal(batchAfterUpdate.endEpoch + 3n);
    expect(batchAfterExtend.tokenAmount).to.equal(batchAfterUpdate.tokenAmount + extensionCost);

    // KA IDs still correct (keyed by kcCreator.address)
    for (let id = 1; id <= 5; id++) {
      expect(await KnowledgeAssetsStorage.isKAIdUsed(ctx.kcCreator.address, id)).to.be.true;
    }

    // Mint second batch from the same reserved range
    const root2 = ethers.keccak256(ethers.toUtf8Bytes('batch-2'));
    const sigs2 = await buildSignatures(
      ctx.publishingNode, ctx.pubId, ctx.receivingNodes, root2, 2048,
    );

    const ask2 = await AskStorage.getStakeWeightedAverageAsk();
    const ta2 = (ask2 * 2048n * 2n) / 1024n;
    await KnowledgeAssets.connect(ctx.kcCreator).batchMintKnowledgeAssets(
      ctx.pubId, root2, 6, 10, 2048, 2, ta2, ethers.ZeroAddress,
      sigs2.pubR, sigs2.pubVS, ctx.receiverIds, sigs2.receiverRs, sigs2.receiverVSs,
    );

    expect(await KnowledgeAssetsStorage.getLatestBatchId()).to.equal(2);
    expect(await KnowledgeAssetsStorage.getTotalKnowledgeAssets()).to.equal(10);
  });

  // ========================================================================
  // publishKnowledgeAssets (single-tx auto-reserve + mint)
  // ========================================================================

  it('Should publish KAs in a single transaction (publishKnowledgeAssets)', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const kcCreator = getDefaultKCCreator(accounts);

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);

    const kaCount = 5;
    const publicByteSize = 1000;
    const epochs = 2;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(publicByteSize) * BigInt(epochs)) / 1024n;
    await Token.mint(kcCreator.address, tokenAmount * 2n);
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(kcCreator).increaseAllowance(kaAddr, tokenAmount * 2n);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('single-tx-publish'));
    const { pubR, pubVS, receiverRs, receiverVSs } = await buildSignatures(
      publishingNode, pubId, receivingNodes, merkleRoot, publicByteSize,
    );

    const tx = await KnowledgeAssets.connect(kcCreator).publishKnowledgeAssets(
      kaCount,
      pubId,
      merkleRoot,
      publicByteSize,
      epochs,
      tokenAmount,
      ethers.ZeroAddress,
      pubR,
      pubVS,
      receiverIds,
      receiverRs,
      receiverVSs,
    );
    const receipt = await tx.wait();

    // Verify the range was auto-reserved under kcCreator's address
    const rangeCount = await KnowledgeAssetsStorage.getPublisherRangesCount(kcCreator.address);
    expect(rangeCount).to.equal(1);

    const [startId, endId] = await KnowledgeAssetsStorage.getPublisherRange(kcCreator.address, 0);
    expect(startId).to.equal(1);
    expect(endId).to.equal(kaCount);

    // Verify the batch was created
    const batchId = await KnowledgeAssetsStorage.getLatestBatchId();
    expect(batchId).to.equal(1);

    const batch = await KnowledgeAssetsStorage.getBatch(batchId);
    expect(batch.publisherAddress).to.equal(kcCreator.address);
    expect(batch.merkleRoot).to.equal(merkleRoot);
    expect(batch.knowledgeAssetsCount).to.equal(kaCount);
    expect(batch.startKAId).to.equal(1);
    expect(batch.endKAId).to.equal(kaCount);

    // KA IDs are marked as used
    for (let id = 1; id <= kaCount; id++) {
      expect(await KnowledgeAssetsStorage.isKAIdUsed(kcCreator.address, id)).to.be.true;
    }

    expect(await KnowledgeAssetsStorage.getTotalKnowledgeAssets()).to.equal(kaCount);
  });

  // ========================================================================
  // transferNamespace
  // ========================================================================

  it('Should transfer namespace: new owner can update/extend, old owner cannot', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const accountA = getDefaultKCCreator(accounts); // accounts[9]
    const accountB = accounts[16];

    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    // Set up non-zero ask for token operations
    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);

    const byteSize = 2048;
    const epochs = 5;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(byteSize) * BigInt(epochs)) / 1024n;

    // Fund both accounts with TRAC
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.mint(accountA.address, tokenAmount * 20n);
    await Token.connect(accountA).increaseAllowance(kaAddr, tokenAmount * 20n);
    await Token.mint(accountB.address, tokenAmount * 20n);
    await Token.connect(accountB).increaseAllowance(kaAddr, tokenAmount * 20n);

    // Account A reserves + mints
    await KnowledgeAssets.connect(accountA).reserveUALRange(20);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('pre-transfer'));
    const sigs = await buildSignatures(publishingNode, pubId, receivingNodes, merkleRoot, byteSize);

    await KnowledgeAssets.connect(accountA).batchMintKnowledgeAssets(
      pubId, merkleRoot, 1, 5, byteSize, epochs, tokenAmount,
      ethers.ZeroAddress, sigs.pubR, sigs.pubVS, receiverIds, sigs.receiverRs, sigs.receiverVSs,
    );

    const batchId = await KnowledgeAssetsStorage.getLatestBatchId();

    // Transfer namespace from A → B
    await KnowledgeAssets.connect(accountA).transferNamespace(accountB.address);

    // Verify batch publisher is now B
    const publisher = await KnowledgeAssetsStorage.getBatchPublisher(batchId);
    expect(publisher).to.equal(accountB.address);

    // B can update
    const newRoot = ethers.keccak256(ethers.toUtf8Bytes('post-transfer-update'));
    await KnowledgeAssets.connect(accountB).updateKnowledgeAssets(
      batchId, newRoot, byteSize,
    );
    const batchAfterUpdate = await KnowledgeAssetsStorage.getBatch(batchId);
    expect(batchAfterUpdate.merkleRoot).to.equal(newRoot);

    // B can extend
    const extensionCost = (ask * BigInt(byteSize) * 3n) / 1024n;
    await KnowledgeAssets.connect(accountB).extendStorage(
      batchId, 3, extensionCost, ethers.ZeroAddress,
    );
    const batchAfterExtend = await KnowledgeAssetsStorage.getBatch(batchId);
    expect(batchAfterExtend.endEpoch).to.equal(batchAfterUpdate.endEpoch + 3n);

    // A cannot update anymore — after `transferNamespace`, the batch publisher
    // must be accountB, so accountA's call must hit `NotBatchPublisher`.
    // Catches regression where namespace transfer fails to rewrite publisher.
    await expect(
      KnowledgeAssets.connect(accountA).updateKnowledgeAssets(
        batchId,
        ethers.keccak256(ethers.toUtf8Bytes('old-owner-attempt')),
        byteSize,
      )
    )
      .to.be.revertedWithCustomError(KnowledgeAssets, 'NotBatchPublisher')
      .withArgs(batchId, accountA.address);
  });

  // ========================================================================
  // Any wallet can publish without identity
  // ========================================================================

  it('Should allow an account with no profile to reserve + mint', async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const noProfileWallet = accounts[17]; // fresh account, no identity or profile

    // Publishing node and receivers still need profiles for signature verification
    const { identityId: pubId } = await createProfile(Profile, publishingNode);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);

    await AskStorage.setWeightedActiveAskSum(ethers.parseEther('1'));
    await AskStorage.setTotalActiveStake(1);
    const publicByteSize = 1000;
    const epochs = 2;
    const ask = await AskStorage.getStakeWeightedAverageAsk();
    const tokenAmount = (ask * BigInt(publicByteSize) * BigInt(epochs)) / 1024n;
    await Token.mint(noProfileWallet.address, tokenAmount * 2n);
    const kaAddr = await KnowledgeAssets.getAddress();
    await Token.connect(noProfileWallet).increaseAllowance(kaAddr, tokenAmount * 2n);

    // noProfileWallet reserves UAL range — no identity required
    await KnowledgeAssets.connect(noProfileWallet).reserveUALRange(10);

    const rangeCount = await KnowledgeAssetsStorage.getPublisherRangesCount(noProfileWallet.address);
    expect(rangeCount).to.equal(1);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('no-profile-publish'));
    const { pubR, pubVS, receiverRs, receiverVSs } = await buildSignatures(
      publishingNode, pubId, receivingNodes, merkleRoot, publicByteSize,
    );

    await KnowledgeAssets.connect(noProfileWallet).batchMintKnowledgeAssets(
      pubId, merkleRoot, 1, 5, publicByteSize, epochs, tokenAmount, ethers.ZeroAddress,
      pubR, pubVS, receiverIds, receiverRs, receiverVSs,
    );

    const batchId = await KnowledgeAssetsStorage.getLatestBatchId();
    expect(batchId).to.equal(1);

    const batch = await KnowledgeAssetsStorage.getBatch(batchId);
    expect(batch.publisherAddress).to.equal(noProfileWallet.address);

    for (let id = 1; id <= 5; id++) {
      expect(await KnowledgeAssetsStorage.isKAIdUsed(noProfileWallet.address, id)).to.be.true;
    }
  });
});
