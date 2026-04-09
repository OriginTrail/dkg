import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  KnowledgeAssetsV10,
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
  PublishingConvictionAccount,
} from '../../typechain';
import { signMessage } from '../helpers/kc-helpers';
import { createProfile, createProfiles } from '../helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKCCreator,
  setNodeStake,
} from '../helpers/setup-helpers';

type V10Fixture = {
  accounts: SignerWithAddress[];
  KnowledgeAssetsV10: KnowledgeAssetsV10;
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
  PublishingConvictionAccount: PublishingConvictionAccount;
};

async function getV10SignaturesData(
  publishingNode: { operational: SignerWithAddress; admin: SignerWithAddress },
  publisherIdentityId: number,
  receivingNodes: { operational: SignerWithAddress; admin: SignerWithAddress }[],
  contextGraphId: bigint,
  knowledgeAssetsAmount: number = 10,
  byteSize: number = 1000,
  merkleRoot: string = ethers.keccak256(ethers.toUtf8Bytes('test-merkle-root')),
  epochs: number = 2,
  tokenAmount: bigint = ethers.parseEther('100'),
) {
  const publisherMessageHash = ethers.solidityPackedKeccak256(
    ['uint256', 'uint72', 'bytes32'],
    [contextGraphId, publisherIdentityId, merkleRoot],
  );

  const { r: publisherR, vs: publisherVS } = await signMessage(
    publishingNode.operational,
    publisherMessageHash,
  );

  const ackDigest = ethers.solidityPackedKeccak256(
    ['uint256', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256'],
    [contextGraphId, merkleRoot, knowledgeAssetsAmount, byteSize, epochs, tokenAmount],
  );

  const receiverRs = [];
  const receiverVSs = [];
  for (const node of receivingNodes) {
    const { r, vs } = await signMessage(node.operational, ackDigest);
    receiverRs.push(r);
    receiverVSs.push(vs);
  }

  return {
    merkleRoot,
    publisherR,
    publisherVS,
    receiverRs,
    receiverVSs,
  };
}

describe('@unit KnowledgeAssetsV10', () => {
  let accounts: SignerWithAddress[];
  let KnowledgeAssetsV10: KnowledgeAssetsV10;
  let KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  let EpochStorage: EpochStorage;
  let AskStorage: AskStorage;
  let Chronos: Chronos;
  let Token: Token;
  let ParametersStorage: ParametersStorage;
  let Profile: Profile;
  let StakingContract: Staking;

  // Use 0 to skip isAuthorizedPublisher (these tests focus on ACK digest verification)
  const CONTEXT_GRAPH_ID = 0n;
  const STAKE_AMOUNT = ethers.parseEther('50000');

  async function stakeForNode(
    node: { operational: SignerWithAddress; admin: SignerWithAddress },
    identityId: number,
  ) {
    await Token.mint(node.operational.address, STAKE_AMOUNT);
    await Token.connect(node.operational).approve(
      await StakingContract.getAddress(),
      STAKE_AMOUNT,
    );
    await StakingContract.connect(node.operational).stake(identityId, STAKE_AMOUNT);
  }

  async function deployV10Fixture(): Promise<V10Fixture> {
    await hre.deployments.fixture([
      'Token',
      'AskStorage',
      'EpochStorage',
      'KnowledgeAssetsV10',
      'PublishingConvictionAccount',
      'Chronos',
      'Profile',
      'Identity',
      'Staking',
      'ParanetKnowledgeCollectionsRegistry',
      'ParanetKnowledgeMinersRegistry',
      'ParanetsRegistry',
    ]);

    accounts = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');

    KnowledgeAssetsV10 = await hre.ethers.getContract<KnowledgeAssetsV10>('KnowledgeAssetsV10');
    KnowledgeCollectionStorage = await hre.ethers.getContract<KnowledgeCollectionStorage>('KnowledgeCollectionStorage');
    EpochStorage = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    AskStorage = await hre.ethers.getContract<AskStorage>('AskStorage');
    Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    Token = await hre.ethers.getContract<Token>('Token');
    ParametersStorage = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const IdentityStorage = await hre.ethers.getContract<IdentityStorage>('IdentityStorage');
    const Identity = await hre.ethers.getContract<Identity>('Identity');
    Profile = await hre.ethers.getContract<Profile>('Profile');
    const Staking = await hre.ethers.getContract<Staking>('Staking');
    const PublishingConvictionAccount = await hre.ethers.getContract<PublishingConvictionAccount>('PublishingConvictionAccount');

    await Hub.setContractAddress('HubOwner', accounts[0].address);

    return {
      accounts,
      KnowledgeAssetsV10,
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
      PublishingConvictionAccount,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const fixture = await loadFixture(deployV10Fixture);
    ({
      accounts,
      KnowledgeAssetsV10,
      KnowledgeCollectionStorage,
      EpochStorage,
      AskStorage,
      Chronos,
      Token,
      ParametersStorage,
      Profile,
    } = fixture);
    StakingContract = fixture.Staking;
  });

  it('Should create KA with V10 ACK digest (contextGraphId + merkleRoot)', async () => {
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);

    const { identityId: publisherIdentityId } = await createProfile(Profile, publishingNode);
    await stakeForNode(publishingNode, publisherIdentityId);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeForNode(receivingNodes[i], receiverProfiles[i].identityId);
    }

    const tokenAmount = ethers.parseEther('100');
    const sig = await getV10SignaturesData(publishingNode, publisherIdentityId, receivingNodes, CONTEXT_GRAPH_ID);

    await Token.connect(kcCreator).increaseAllowance(KnowledgeAssetsV10.getAddress(), tokenAmount);

    const tx = await KnowledgeAssetsV10.connect(kcCreator).createKnowledgeAssets(
      'v10-test-op',
      CONTEXT_GRAPH_ID,
      sig.merkleRoot,
      10,
      1000,
      2,
      tokenAmount,
      false,
      ethers.ZeroAddress,
      0,
      publisherIdentityId,
      sig.publisherR,
      sig.publisherVS,
      receiverIds,
      sig.receiverRs,
      sig.receiverVSs,
    );

    const receipt = await tx.wait();
    expect(receipt!.status).to.equal(1);

    const meta = await KnowledgeCollectionStorage.getKnowledgeCollectionMetadata(1);
    expect(meta[6]).to.equal(tokenAmount);
  });

  it('Should reject V8-style signatures (signing just merkleRoot, no contextGraphId)', async () => {
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);

    const { identityId: publisherIdentityId } = await createProfile(Profile, publishingNode);
    await stakeForNode(publishingNode, publisherIdentityId);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeForNode(receivingNodes[i], receiverProfiles[i].identityId);
    }

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('test-merkle-root'));
    const publisherMessageHash = ethers.solidityPackedKeccak256(
      ['uint72', 'bytes32'],
      [publisherIdentityId, merkleRoot],
    );
    const { r: publisherR, vs: publisherVS } = await signMessage(publishingNode.operational, publisherMessageHash);

    const receiverRs = [];
    const receiverVSs = [];
    for (const node of receivingNodes) {
      const { r, vs } = await signMessage(node.operational, merkleRoot);
      receiverRs.push(r);
      receiverVSs.push(vs);
    }

    await Token.connect(kcCreator).increaseAllowance(KnowledgeAssetsV10.getAddress(), ethers.parseEther('100'));

    await expect(
      KnowledgeAssetsV10.connect(kcCreator).createKnowledgeAssets(
        'v10-wrong-sig',
        CONTEXT_GRAPH_ID,
        merkleRoot,
        10,
        1000,
        2,
        ethers.parseEther('100'),
        false,
        ethers.ZeroAddress,
        0,
        publisherIdentityId,
        publisherR,
        publisherVS,
        receiverIds,
        receiverRs,
        receiverVSs,
      ),
    ).to.be.revertedWithCustomError(KnowledgeAssetsV10, 'SignerIsNotNodeOperator');
  });

  it('Should read minimumRequiredSignatures from ParametersStorage (not hardcoded)', async () => {
    const minSigs = await ParametersStorage.minimumRequiredSignatures();
    expect(minSigs).to.be.greaterThan(0);

    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);

    const { identityId: publisherIdentityId } = await createProfile(Profile, publishingNode);
    await stakeForNode(publishingNode, publisherIdentityId);

    const sig = await getV10SignaturesData(publishingNode, publisherIdentityId, [], CONTEXT_GRAPH_ID);

    await Token.connect(kcCreator).increaseAllowance(KnowledgeAssetsV10.getAddress(), ethers.parseEther('100'));

    await expect(
      KnowledgeAssetsV10.connect(kcCreator).createKnowledgeAssets(
        'v10-no-sigs',
        CONTEXT_GRAPH_ID,
        sig.merkleRoot,
        10,
        1000,
        2,
        ethers.parseEther('100'),
        false,
        ethers.ZeroAddress,
        0,
        publisherIdentityId,
        sig.publisherR,
        sig.publisherVS,
        [],
        [],
        [],
      ),
    ).to.be.revertedWithCustomError(KnowledgeAssetsV10, 'MinSignaturesRequirementNotMet');
  });

  it('Should store isImmutable correctly', async () => {
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);

    const { identityId: publisherIdentityId } = await createProfile(Profile, publishingNode);
    await stakeForNode(publishingNode, publisherIdentityId);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeForNode(receivingNodes[i], receiverProfiles[i].identityId);
    }

    const tokenAmount = ethers.parseEther('100');
    const sig = await getV10SignaturesData(publishingNode, publisherIdentityId, receivingNodes, CONTEXT_GRAPH_ID, 5, 500);

    await Token.connect(kcCreator).increaseAllowance(KnowledgeAssetsV10.getAddress(), tokenAmount);

    await KnowledgeAssetsV10.connect(kcCreator).createKnowledgeAssets(
      'v10-immutable',
      CONTEXT_GRAPH_ID,
      sig.merkleRoot,
      5,
      500,
      2,
      tokenAmount,
      true,
      ethers.ZeroAddress,
      0,
      publisherIdentityId,
      sig.publisherR,
      sig.publisherVS,
      receiverIds,
      sig.receiverRs,
      sig.receiverVSs,
    );

    const meta = await KnowledgeCollectionStorage.getKnowledgeCollectionMetadata(1);
    expect(meta[7]).to.equal(true);
  });

  it('Should emit publishOperationId in KnowledgeCollectionCreated event', async () => {
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);

    const { identityId: publisherIdentityId } = await createProfile(Profile, publishingNode);
    await stakeForNode(publishingNode, publisherIdentityId);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeForNode(receivingNodes[i], receiverProfiles[i].identityId);
    }

    const tokenAmount = ethers.parseEther('100');
    const sig = await getV10SignaturesData(publishingNode, publisherIdentityId, receivingNodes, CONTEXT_GRAPH_ID, 5, 500);

    await Token.connect(kcCreator).increaseAllowance(KnowledgeAssetsV10.getAddress(), tokenAmount);

    const tx = await KnowledgeAssetsV10.connect(kcCreator).createKnowledgeAssets(
      'my-custom-operation-id',
      CONTEXT_GRAPH_ID,
      sig.merkleRoot,
      5,
      500,
      2,
      tokenAmount,
      false,
      ethers.ZeroAddress,
      0,
      publisherIdentityId,
      sig.publisherR,
      sig.publisherVS,
      receiverIds,
      sig.receiverRs,
      sig.receiverVSs,
    );

    const receipt = await tx.wait();
    const kcs = KnowledgeCollectionStorage;
    let foundOpId = false;
    for (const log of receipt!.logs) {
      try {
        const parsed = kcs.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'KnowledgeCollectionCreated') {
          expect(parsed.args.publishOperationId).to.equal('my-custom-operation-id');
          foundOpId = true;
        }
      } catch { /* not this contract */ }
    }
    expect(foundOpId).to.be.true;
  });

  it('Should revert when convictionAccountId > 0 and conviction contract has no account', async () => {
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);

    const { identityId: publisherIdentityId } = await createProfile(Profile, publishingNode);
    await stakeForNode(publishingNode, publisherIdentityId);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    const receiverIds = receiverProfiles.map((p) => p.identityId);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeForNode(receivingNodes[i], receiverProfiles[i].identityId);
    }

    const tokenAmount = ethers.parseEther('100');
    const sig = await getV10SignaturesData(publishingNode, publisherIdentityId, receivingNodes, CONTEXT_GRAPH_ID, 5, 500);

    await Token.connect(kcCreator).increaseAllowance(KnowledgeAssetsV10.getAddress(), tokenAmount);

    await expect(
      KnowledgeAssetsV10.connect(kcCreator).createKnowledgeAssets(
        'v10-conviction-test',
        CONTEXT_GRAPH_ID,
        sig.merkleRoot,
        5,
        500,
        2,
        tokenAmount,
        false,
        ethers.ZeroAddress,
        999,
        publisherIdentityId,
        sig.publisherR,
        sig.publisherVS,
        receiverIds,
        sig.receiverRs,
        sig.receiverVSs,
      ),
    ).to.be.revertedWithCustomError(
      await hre.ethers.getContract('PublishingConvictionAccount'),
      'AccountNotFound',
    );
  });

  it('Should reject when all ACK identities are the same', async () => {
    const minSigs = Number(await ParametersStorage.minimumRequiredSignatures());
    const kcCreator = getDefaultKCCreator(accounts);
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts, minSigs);

    const { identityId: publisherIdentityId } = await createProfile(Profile, publishingNode);
    await stakeForNode(publishingNode, publisherIdentityId);
    const receiverProfiles = await createProfiles(Profile, receivingNodes);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeForNode(receivingNodes[i], receiverProfiles[i].identityId);
    }

    const sig = await getV10SignaturesData(publishingNode, publisherIdentityId, receivingNodes, CONTEXT_GRAPH_ID);

    await Token.connect(kcCreator).increaseAllowance(KnowledgeAssetsV10.getAddress(), ethers.parseEther('100'));

    const dupIds = Array(minSigs).fill(receiverProfiles[0].identityId);
    const dupRs = Array(minSigs).fill(sig.receiverRs[0]);
    const dupVSs = Array(minSigs).fill(sig.receiverVSs[0]);

    await expect(
      KnowledgeAssetsV10.connect(kcCreator).createKnowledgeAssets(
        'v10-dup-test',
        CONTEXT_GRAPH_ID,
        sig.merkleRoot,
        10,
        1000,
        2,
        ethers.parseEther('100'),
        false,
        ethers.ZeroAddress,
        0,
        publisherIdentityId,
        sig.publisherR,
        sig.publisherVS,
        dupIds,
        dupRs,
        dupVSs,
      ),
    ).to.be.revertedWith('Insufficient unique receiver identities');
  });
});
