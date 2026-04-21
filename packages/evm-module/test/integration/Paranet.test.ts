// import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers, EventLog } from 'ethers';
import hre from 'hardhat';

import {
  Paranet,
  ParanetsRegistry,
  ParanetServicesRegistry,
  ParanetKnowledgeMinersRegistry,
  ParanetKnowledgeCollectionsRegistry,
  ParanetIncentivesPoolFactory,
  KnowledgeCollection,
  KnowledgeCollectionStorage,
  Profile,
  Token,
  Hub,
  EpochStorage,
  ParanetIncentivesPoolStorage,
  ParanetIncentivesPoolFactoryHelper,
  ParanetStagingRegistry,
  IdentityStorage,
  HubLib,
  ParanetLib,
} from '../../typechain';
import { ACCESS_POLICIES } from '../helpers/constants';
import { createKnowledgeCollection } from '../helpers/kc-helpers';
import { setupParanet } from '../helpers/paranet-helpers';
import { createProfiles, createProfile } from '../helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKCCreator,
} from '../helpers/setup-helpers';

// Fixture containing all contracts and accounts needed to test Paranet
type ParanetFixture = {
  accounts: SignerWithAddress[];
  Paranet: Paranet;
  ParanetsRegistry: ParanetsRegistry;
  ParanetServicesRegistry: ParanetServicesRegistry;
  ParanetKnowledgeMinersRegistry: ParanetKnowledgeMinersRegistry;
  ParanetKnowledgeCollectionsRegistry: ParanetKnowledgeCollectionsRegistry;
  ParanetIncentivesPoolFactoryHelper: ParanetIncentivesPoolFactoryHelper;
  ParanetIncentivesPoolFactory: ParanetIncentivesPoolFactory;
  KnowledgeCollection: KnowledgeCollection;
  KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  Profile: Profile;
  Token: Token;
  EpochStorage: EpochStorage;
  ParanetStagingRegistry: ParanetStagingRegistry;
  IdentityStorage: IdentityStorage;
  HubLib: HubLib;
  ParanetLib: ParanetLib;
};

describe('@unit Paranet', () => {
  let accounts: SignerWithAddress[];
  let Paranet: Paranet;
  let ParanetsRegistry: ParanetsRegistry;
  let ParanetServicesRegistry: ParanetServicesRegistry;
  let ParanetKnowledgeMinersRegistry: ParanetKnowledgeMinersRegistry;
  let ParanetKnowledgeCollectionsRegistry: ParanetKnowledgeCollectionsRegistry;
  let ParanetIncentivesPoolFactoryHelper: ParanetIncentivesPoolFactoryHelper;
  let ParanetIncentivesPoolFactory: ParanetIncentivesPoolFactory;
  let KnowledgeCollection: KnowledgeCollection;
  let KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  let Profile: Profile;
  let Token: Token;
  let EpochStorage: EpochStorage;
  let ParanetStagingRegistry: ParanetStagingRegistry;
  let IdentityStorage: IdentityStorage;
  let HubLib: HubLib;
  let ParanetLib: ParanetLib;

  // Deploy all contracts, set the HubOwner and necessary accounts. Returns the ParanetFixture
  async function deployParanetFixture(): Promise<ParanetFixture> {
    await hre.deployments.fixture([
      'Paranet',
      'ParanetsRegistry',
      'ParanetServicesRegistry',
      'ParanetKnowledgeMinersRegistry',
      'ParanetKnowledgeCollectionsRegistry',
      'ParanetIncentivesPoolFactoryHelper',
      'ParanetIncentivesPoolFactory',
      'KnowledgeCollection',
      'Profile',
      'Token',
      'EpochStorage',
      'ParanetStagingRegistry',
      'IdentityStorage',
    ]);

    accounts = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', accounts[0].address);

    EpochStorage = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    Paranet = await hre.ethers.getContract<Paranet>('Paranet');
    ParanetsRegistry =
      await hre.ethers.getContract<ParanetsRegistry>('ParanetsRegistry');
    ParanetServicesRegistry =
      await hre.ethers.getContract<ParanetServicesRegistry>(
        'ParanetServicesRegistry',
      );
    ParanetKnowledgeMinersRegistry =
      await hre.ethers.getContract<ParanetKnowledgeMinersRegistry>(
        'ParanetKnowledgeMinersRegistry',
      );
    ParanetKnowledgeCollectionsRegistry =
      await hre.ethers.getContract<ParanetKnowledgeCollectionsRegistry>(
        'ParanetKnowledgeCollectionsRegistry',
      );
    ParanetIncentivesPoolFactoryHelper =
      await hre.ethers.getContract<ParanetIncentivesPoolFactoryHelper>(
        'ParanetIncentivesPoolFactoryHelper',
      );
    ParanetIncentivesPoolFactory =
      await hre.ethers.getContract<ParanetIncentivesPoolFactory>(
        'ParanetIncentivesPoolFactory',
      );
    KnowledgeCollection = await hre.ethers.getContract<KnowledgeCollection>(
      'KnowledgeCollection',
    );
    KnowledgeCollectionStorage =
      await hre.ethers.getContract<KnowledgeCollectionStorage>(
        'KnowledgeCollectionStorage',
      );
    Profile = await hre.ethers.getContract<Profile>('Profile');
    // await hre.deployments.deploy('Token', {
    //   from: accounts[0].address,
    //   args: ['Neuro', 'NEURO'],
    //   log: true,
    // });
    Token = await hre.ethers.getContract<Token>('Token');
    ParanetStagingRegistry =
      await hre.ethers.getContract<ParanetStagingRegistry>(
        'ParanetStagingRegistry',
      );
    IdentityStorage =
      await hre.ethers.getContract<IdentityStorage>('IdentityStorage');

    const hubLibDeployment = await hre.deployments.deploy('HubLib', {
      from: accounts[0].address,
      log: true,
    });
    HubLib = await hre.ethers.getContract<HubLib>(
      'HubLib',
      hubLibDeployment.address,
    );

    const paranetLibDeployment = await hre.deployments.deploy('ParanetLib', {
      from: accounts[0].address,
      log: true,
    });
    ParanetLib = await hre.ethers.getContract<ParanetLib>(
      'ParanetLib',
      paranetLibDeployment.address,
    );

    return {
      accounts,
      Paranet,
      ParanetsRegistry,
      ParanetServicesRegistry,
      ParanetKnowledgeMinersRegistry,
      ParanetKnowledgeCollectionsRegistry,
      ParanetIncentivesPoolFactoryHelper,
      ParanetIncentivesPoolFactory,
      KnowledgeCollection,
      KnowledgeCollectionStorage,
      Profile,
      Token,
      EpochStorage,
      ParanetStagingRegistry,
      IdentityStorage,
      HubLib,
      ParanetLib,
    };
  }

  // Before each test, deploy all contracts and necessary accounts. These variables can be used in the tests
  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Paranet,
      ParanetsRegistry,
      ParanetServicesRegistry,
      ParanetKnowledgeMinersRegistry,
      ParanetKnowledgeCollectionsRegistry,
      ParanetIncentivesPoolFactoryHelper,
      ParanetIncentivesPoolFactory,
      KnowledgeCollection,
      KnowledgeCollectionStorage,
      Profile,
      Token,
      ParanetStagingRegistry,
      HubLib,
      ParanetLib,
    } = await loadFixture(deployParanetFixture));
  });

  describe('Paranet Registration', () => {
    it('Should return the correct name and version of the paranet', async () => {
      const name = await Paranet.name();
      const version = await Paranet.version();
      expect(name).to.equal('Paranet');
      expect(version).to.equal('1.0.0');
    });

    it('Should register a paranet successfully', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetName,
        paranetDescription,
        nodesAccessPolicy,
        minersAccessPolicy,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await ParanetsRegistry.paranetExists(paranetId)).to.be.true;

      // Check paranet owner
      const startTokenId =
        (paranetKCTokenId - 1) *
          Number(
            await KnowledgeCollectionStorage.knowledgeCollectionMaxSize(),
          ) +
        paranetKATokenId;

      const ownedCountInRange = await KnowledgeCollectionStorage[
        'balanceOf(address,uint256,uint256)'
      ](paranetOwner.address, startTokenId, startTokenId + 1);

      expect(ownedCountInRange).to.equal(1);

      // Check paranet metadata
      const paranetMetadata =
        await ParanetsRegistry.getParanetMetadata(paranetId);
      expect(paranetMetadata.paranetKCStorageContract).to.equal(
        paranetKCStorageContract,
      );
      expect(paranetMetadata.paranetKCTokenId).to.equal(paranetKCTokenId);
      expect(paranetMetadata.paranetKATokenId).to.equal(paranetKATokenId);
      expect(paranetMetadata.name).to.equal(paranetName);
      expect(paranetMetadata.description).to.equal(paranetDescription);
      expect(paranetMetadata.nodesAccessPolicy).to.equal(nodesAccessPolicy);
      expect(paranetMetadata.minersAccessPolicy).to.equal(minersAccessPolicy);
    });

    it('Should revert when registering the same paranet twice', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const paranetName = 'Test Paranet';
      const paranetDescription = 'Test Paranet Description';
      const nodesAccessPolicy = ACCESS_POLICIES.OPEN;
      const minersAccessPolicy = ACCESS_POLICIES.OPEN;

      const { paranetKCStorageContract, paranetKCTokenId, paranetKATokenId } =
        await setupParanet(
          kcCreator,
          publishingNode,
          receivingNodes,
          {
            Paranet,
            Profile,
            Token,
            KnowledgeCollection,
            KnowledgeCollectionStorage,
          },
          paranetName,
          paranetDescription,
          nodesAccessPolicy,
          minersAccessPolicy,
        );

      await expect(
        Paranet.connect(kcCreator).registerParanet(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          paranetName,
          paranetDescription,
          nodesAccessPolicy,
          minersAccessPolicy,
          ACCESS_POLICIES.OPEN,
        ),
      ).to.be.revertedWith('Paranet does not exist');
    });

    it('Should revert when non-owner tries to register paranet', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const nonOwner = accounts[10];

      const paranetKCStorageContract =
        await KnowledgeCollectionStorage.getAddress();

      const contracts = {
        Profile,
        KnowledgeCollection,
        Token,
      };

      const { identityId: publishingNodeIdentityId } = await createProfile(
        contracts.Profile,
        publishingNode,
      );
      const receivingNodesIdentityIds = (
        await createProfiles(contracts.Profile, receivingNodes)
      ).map((p) => p.identityId);

      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        contracts,
      );

      // Try to register paranet with non-owner
      await expect(
        Paranet.connect(nonOwner).registerParanet(
          paranetKCStorageContract,
          collectionId,
          1, // knowledgeAssetId
          'paranetName',
          'paranetDescription',
          ACCESS_POLICIES.OPEN,
          ACCESS_POLICIES.OPEN,
          ACCESS_POLICIES.OPEN,
        ),
      ).to.be.revertedWith('Caller not the owner of the KA');
    });

    it('Should revert when registering paranet with invalid access policy values', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const paranetKCStorageContract =
        await KnowledgeCollectionStorage.getAddress();

      const contracts = {
        Profile,
        KnowledgeCollection,
        Token,
      };

      const { identityId: publishingNodeIdentityId } = await createProfile(
        contracts.Profile,
        publishingNode,
      );
      const receivingNodesIdentityIds = (
        await createProfiles(contracts.Profile, receivingNodes)
      ).map((p) => p.identityId);

      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        contracts,
      );

      // Try with invalid nodes access policy (2)
      await expect(
        Paranet.connect(kcCreator).registerParanet(
          paranetKCStorageContract,
          collectionId,
          1, // kaTokenId
          'Test Paranet',
          'Test Description',
          2, // invalid nodes access policy
          0, // valid miners access policy
          0, // valid submission policy
        ),
      ).to.be.revertedWith('Invalid policy');

      // Try with invalid miners access policy (3)
      await expect(
        Paranet.connect(kcCreator).registerParanet(
          paranetKCStorageContract,
          collectionId,
          1, // kaTokenId
          'Test Paranet',
          'Test Description',
          0, // valid nodes access policy
          3, // invalid miners access policy
          0, // valid submission policy
        ),
      ).to.be.revertedWith('Invalid policy');

      // Try with invalid submission policy (2)
      await expect(
        Paranet.connect(kcCreator).registerParanet(
          paranetKCStorageContract,
          collectionId,
          1, // kaTokenId
          'Test Paranet',
          'Test Description',
          0, // valid nodes access policy
          0, // valid miners access policy
          2, // invalid submission policy
        ),
      ).to.be.revertedWith('Invalid policy');

      // Try with all invalid policies
      await expect(
        Paranet.connect(kcCreator).registerParanet(
          paranetKCStorageContract,
          collectionId,
          1, // kaTokenId
          'Test Paranet',
          'Test Description',
          2, // invalid nodes access policy
          3, // invalid miners access policy
          2, // invalid submission policy
        ),
      ).to.be.revertedWith('Invalid policy');
    });
  });

  describe('Paranet Metadata', () => {
    it('Should update paranet metadata successfully', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      const newName = 'New Name';
      const newDescription = 'New Description';

      await Paranet.connect(paranetOwner).updateParanetMetadata(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        newName,
        newDescription,
      );

      const updatedName = await ParanetsRegistry.getName(paranetId);
      const updatedDescription =
        await ParanetsRegistry.getDescription(paranetId);
      expect(updatedName).to.equal(newName);
      expect(updatedDescription).to.equal(newDescription);
    });

    it('Should emit ParanetMetadataUpdated event with correct parameters', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      const newName = 'New Name';
      const newDescription = 'New Description';

      await expect(
        Paranet.connect(paranetOwner).updateParanetMetadata(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          newName,
          newDescription,
        ),
      )
        .to.emit(Paranet, 'ParanetMetadataUpdated')
        .withArgs(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          newName,
          newDescription,
        );
    });

    it('Should handle empty strings for name and description', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      await Paranet.connect(paranetOwner).updateParanetMetadata(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        '',
        '',
      );

      expect(await ParanetsRegistry.getName(paranetId)).to.equal('');
      expect(await ParanetsRegistry.getDescription(paranetId)).to.equal('');
    });

    it('Should handle very long name and description', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      const longName = 'a'.repeat(100);
      const longDescription = 'b'.repeat(1000);

      await Paranet.connect(paranetOwner).updateParanetMetadata(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        longName,
        longDescription,
      );

      expect(await ParanetsRegistry.getName(paranetId)).to.equal(longName);
      expect(await ParanetsRegistry.getDescription(paranetId)).to.equal(
        longDescription,
      );
    });

    it('Should allow multiple updates to the same paranet', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // First update
      await Paranet.connect(paranetOwner).updateParanetMetadata(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        'First Name',
        'First Description',
      );

      expect(await ParanetsRegistry.getName(paranetId)).to.equal('First Name');
      expect(await ParanetsRegistry.getDescription(paranetId)).to.equal(
        'First Description',
      );

      // Second update
      await Paranet.connect(paranetOwner).updateParanetMetadata(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        'Second Name',
        'Second Description',
      );

      expect(await ParanetsRegistry.getName(paranetId)).to.equal('Second Name');
      expect(await ParanetsRegistry.getDescription(paranetId)).to.equal(
        'Second Description',
      );
    });

    it('Should handle special characters in name and description', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      const specialName = '!@#$%^&*()_+-=[]{}|;:,.<>?`~';
      const specialDescription = '¡™£¢∞§¶•ªº–≠œ∑´®†¥¨ˆøπ"åß∂ƒ©˙∆˚¬…æ';

      await Paranet.connect(paranetOwner).updateParanetMetadata(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        specialName,
        specialDescription,
      );

      expect(await ParanetsRegistry.getName(paranetId)).to.equal(specialName);
      expect(await ParanetsRegistry.getDescription(paranetId)).to.equal(
        specialDescription,
      );
    });

    it('Should revert when non-owner tries to update paranet metadata', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const nonOwner = accounts[10];

      const { paranetKCStorageContract, paranetKCTokenId, paranetKATokenId } =
        await setupParanet(kcCreator, publishingNode, receivingNodes, {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        });

      const newName = 'New Name';
      const newDescription = 'New Description';

      await expect(
        Paranet.connect(nonOwner).updateParanetMetadata(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          newName,
          newDescription,
        ),
      ).to.be.revertedWith('Caller not the owner of the KA');
    });

    it('updateParanetMetadata should revert when paranet does not exist', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const contracts = {
        Profile,
        KnowledgeCollection,
        Token,
      };

      const { identityId: publishingNodeIdentityId } = await createProfile(
        contracts.Profile,
        publishingNode,
      );
      const receivingNodesIdentityIds = (
        await createProfiles(contracts.Profile, receivingNodes)
      ).map((p) => p.identityId);

      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        contracts,
      );

      // Try to update metadata for non-existent paranet
      await expect(
        Paranet.connect(kcCreator).updateParanetMetadata(
          await KnowledgeCollectionStorage.getAddress(),
          collectionId,
          1,
          'New Name',
          'New Description',
        ),
      ).to.be.revertedWith('Paranet does not exist');
    });

    it('Should revert when trying to update with extremely large token IDs', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const { paranetKCStorageContract, paranetOwner } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
      );

      const maxUint256 = ethers.MaxUint256;

      // `_checkKnowledgeAssetOwner` computes
      // `(knowledgeCollectionId - 1) * maxSize + knowledgeAssetId` before
      // doing the ownership balance check. With both ids = MaxUint256 the
      // multiplication overflows unchecked arithmetic and Solidity raises
      // Panic(0x11) (arithmetic overflow/underflow). Pinning the panic code
      // catches regressions where silent truncation is reintroduced or the
      // check is removed entirely.
      await expect(
        Paranet.connect(paranetOwner).updateParanetMetadata(
          paranetKCStorageContract,
          maxUint256,
          maxUint256,
          'New Name',
          'New Description',
        ),
      ).to.be.revertedWithPanic(0x11);
    });
  });

  describe('Paranet Incentives Pool', () => {
    it('Should return correct name and version of factory, incentives pool and storage', async () => {
      // Incentives pool factory
      const poolFactoryName = await ParanetIncentivesPoolFactory.name();
      const poolFactoryVersion = await ParanetIncentivesPoolFactory.version();
      expect(poolFactoryName).to.equal('ParanetIncentivesPoolFactory');
      expect(poolFactoryVersion).to.equal('1.0.0');

      // Incentives pool factory helper
      const poolFactoryHelperName =
        await ParanetIncentivesPoolFactoryHelper.name();
      const poolFactoryHelperVersion =
        await ParanetIncentivesPoolFactoryHelper.version();
      expect(poolFactoryHelperName).to.equal(
        'ParanetIncentivesPoolFactoryHelper',
      );
      expect(poolFactoryHelperVersion).to.equal('1.0.0');

      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      const tracToNeuroEmissionMultiplier = ethers.parseUnits('1', 12); // 1 NEURO per 1 TRAC
      const operatorRewardPercentage = 1000; // 10%
      const votersRewardPercentage = 2000; // 20%

      const tx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        tracToNeuroEmissionMultiplier,
        operatorRewardPercentage,
        votersRewardPercentage,
        'Neuroweb',
        await Token.getAddress(),
      );

      // get incentives pool name and version
      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;
      const incentivesPool = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        event?.args[4],
      );
      const incentivesPoolName = await incentivesPool.name();
      const incentivesPoolVersion = await incentivesPool.version();
      expect(incentivesPoolName).to.equal('ParanetIncentivesPool');
      expect(incentivesPoolVersion).to.equal('1.0.0');

      const incentivesPoolStorage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event?.args[3],
      );
      const incentivesPoolStorageName = await incentivesPoolStorage.name();
      const incentivesPoolStorageVersion =
        await incentivesPoolStorage.version();
      expect(incentivesPoolStorageName).to.equal(
        'ParanetIncentivesPoolStorage',
      );
      expect(incentivesPoolStorageVersion).to.equal('1.0.0');
    });

    it('Should deploy incentives pool successfully', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      const tracToNeuroEmissionMultiplier = ethers.parseUnits('1', 12); // 1 NEURO per 1 TRAC
      const operatorRewardPercentage = 1000; // 10%
      const votersRewardPercentage = 2000; // 20%

      const tx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        tracToNeuroEmissionMultiplier,
        operatorRewardPercentage,
        votersRewardPercentage,
        'Neuroweb',
        await Token.getAddress(),
      );

      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      expect(event?.args[0]).to.equal(paranetKCStorageContract);
      expect(event?.args[1]).to.equal(paranetKCTokenId);
      expect(event?.args[2]).to.equal(paranetKATokenId);
      expect(event?.args[5]).to.equal(await Token.getAddress());

      let incentivesPool = await ParanetsRegistry.getIncentivesPoolByPoolName(
        paranetId,
        'Neuroweb',
      );
      expect(incentivesPool.storageAddr).to.equal(event?.args[3]);
      expect(incentivesPool.rewardTokenAddress).to.equal(
        await Token.getAddress(),
      );

      incentivesPool = await ParanetsRegistry.getIncentivesPoolByStorageAddress(
        paranetId,
        event?.args[3],
      );
      expect(incentivesPool.name).to.equal('Neuroweb');
      expect(incentivesPool.rewardTokenAddress).to.equal(
        await Token.getAddress(),
      );

      // validate incentives pool address
      const incentivesPoolStorage = (await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event?.args[3],
      )) as ParanetIncentivesPoolStorage;
      expect(
        await incentivesPoolStorage.paranetIncentivesPoolAddress(),
      ).to.equal(event?.args[4]);
      expect(await incentivesPoolStorage.paranetId()).to.equal(paranetId);
    });

    it('Access control for incentives pool storage', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      const tx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('1', 12), // 1 NEURO per 1 TRAC
        1000, // 10% operator
        2000, // 20% voters
        'Pool',
        await Token.getAddress(),
      );

      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      const poolStorage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event?.args[3],
      );

      const notIncentivesPool = accounts[1];

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .addMinerClaimedReward(
            accounts[0].address,
            ethers.parseUnits('100', 12),
          ),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .addMinerClaimedRewardProfile(
            accounts[0].address,
            ethers.parseUnits('100', 12),
          ),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .addClaimedOperatorReward(
            accounts[0].address,
            ethers.parseUnits('100', 12),
          ),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .addOperatorClaimedRewardsProfile(
            accounts[0].address,
            ethers.parseUnits('100', 12),
          ),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .addVoterClaimedToken(
            accounts[0].address,
            ethers.parseUnits('100', 12),
          ),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .addTotalMinersclaimedToken(ethers.parseUnits('100', 12)),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .addTotalOperatorsclaimedToken(ethers.parseUnits('100', 12)),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .addTotalVotersclaimedToken(ethers.parseUnits('100', 12)),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .transferReward(accounts[0].address, ethers.parseUnits('100', 12)),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .setTotalMinersclaimedToken(ethers.parseUnits('100', 12)),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .setTotalVotersclaimedToken(ethers.parseUnits('100', 12)),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .setTotalOperatorsclaimedToken(ethers.parseUnits('100', 12)),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .decrementTotalMinersclaimedToken(ethers.parseUnits('100', 12)),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .decrementTotalVotersclaimedToken(ethers.parseUnits('100', 12)),
      ).to.be.revertedWith('Caller is not incentives pool contract');

      await expect(
        poolStorage
          .connect(notIncentivesPool)
          .decrementTotalOperatorsclaimedToken(ethers.parseUnits('100', 12)),
      ).to.be.revertedWith('Caller is not incentives pool contract');
    });

    it('Should handle multiple incentives pools for same paranet', async () => {
      // 1. Setup paranet first
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Deploy first incentives pool
      const tx1 = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('1', 12), // 1 NEURO per 1 TRAC
        1000, // 10% operator
        2000, // 20% voters
        'Pool1',
        await Token.getAddress(),
      );

      const receipt1 = await tx1.wait();
      const event1 = receipt1!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      // 3. Deploy second incentives pool with different parameters
      const tx2 = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('2', 12), // 2 NEURO per 1 TRAC
        1500, // 15% operator
        2500, // 25% voters
        'Pool2',
        await Token.getAddress(),
      );

      const receipt2 = await tx2.wait();
      const event2 = receipt2!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      // 4. Verify both pools exist and have correct parameters
      const pool1 = await ParanetsRegistry.getIncentivesPoolByPoolName(
        paranetId,
        'Pool1',
      );
      const pool2 = await ParanetsRegistry.getIncentivesPoolByPoolName(
        paranetId,
        'Pool2',
      );

      expect(pool1.storageAddr).to.equal(event1?.args[3]);
      expect(pool2.storageAddr).to.equal(event2?.args[3]);
      expect(pool1.storageAddr).to.not.equal(pool2.storageAddr);

      // 5. Verify pool parameters through storage contracts
      const pool1Storage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event1?.args[3],
      );
      const pool2Storage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event2?.args[3],
      );

      expect(await pool1Storage.paranetId()).to.equal(paranetId);
      expect(await pool2Storage.paranetId()).to.equal(paranetId);

      // TODO: Fund the pools and check rewards
    });

    it('Should fail to deploy incentives pool with invalid parameters', async () => {
      // 1. Setup paranet
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Try to deploy with operator + voters percentage > 100%
      await expect(
        ParanetIncentivesPoolFactory.connect(paranetOwner).deployIncentivesPool(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          ethers.parseUnits('1', 12),
          5000, // 50% operator
          6000, // 60% voters (total 110%)
          'InvalidPool',
          await Token.getAddress(),
        ),
      ).to.be.revertedWith('Invalid rewards ratio');

      // 3. Try to deploy with zero emission multiplier
      await expect(
        ParanetIncentivesPoolFactory.connect(paranetOwner).deployIncentivesPool(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          0, // zero multiplier
          1000,
          2000,
          'InvalidPool',
          await Token.getAddress(),
        ),
      ).to.be.revertedWith('Emission multiplier must be greater than 0');

      // 4. Try to deploy with empty pool name
      await expect(
        ParanetIncentivesPoolFactory.connect(paranetOwner).deployIncentivesPool(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          ethers.parseUnits('1', 12),
          1000,
          2000,
          '', // empty name
          await Token.getAddress(),
        ),
      ).to.be.revertedWith('Pool name cannot be empty');

      // 5. Try to deploy with invalid paranet
      await expect(
        ParanetIncentivesPoolFactory.connect(paranetOwner).deployIncentivesPool(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId + 1, // invalid paranet token id
          ethers.parseUnits('1', 12),
          1000,
          2000,
          'InvalidPool', // empty name
          await Token.getAddress(),
        ),
      ).to.be.revertedWith('Paranet does not exist');
    });

    it('Should handle voter management correctly', async () => {
      // 1. Setup paranet and pool
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // Deploy pool
      const tx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('1', 12),
        1000,
        2000,
        'TestPool',
        await Token.getAddress(),
      );

      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      const incentivesPoolStorage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event?.args[3],
      );

      const incentivesPool = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        event?.args[4],
      );

      // Test non-existent voter
      expect(
        await incentivesPool.voterclaimedToken(accounts[5].address),
      ).to.equal(0);

      // Get registrar
      const registrar = await incentivesPoolStorage.votersRegistrar();
      const registrarSigner = await hre.ethers.getSigner(registrar);

      // Add voters
      const voters = [
        { addr: accounts[5].address, weight: 5000 }, // 50%
        { addr: accounts[6].address, weight: 3000 }, // 30%
        { addr: accounts[7].address, weight: 2000 }, // 20%
      ];

      await incentivesPoolStorage.connect(registrarSigner).addVoters(voters);

      // Verify voters were added correctly
      expect(await incentivesPoolStorage.getVotersCount()).to.equal(3);
      expect(await incentivesPoolStorage.cumulativeVotersWeight()).to.equal(
        10000,
      );

      // Try to add voter for the second time
      await expect(
        incentivesPoolStorage.connect(registrarSigner).addVoters(voters),
      ).to.be.revertedWith('Voter already exists');

      // Now voter exists but hasn't claimed anything yet
      expect(
        await incentivesPool.voterclaimedToken(accounts[5].address),
      ).to.equal(0);
      expect(
        await incentivesPool.isProposalVoter(accounts[5].address),
      ).to.be.eq(true);

      // Update voter weight
      await incentivesPoolStorage
        .connect(registrarSigner)
        .updateVoterWeight(accounts[5].address, 4000);

      const updatedVoter = await incentivesPoolStorage.getVoter(
        accounts[5].address,
      );
      expect(updatedVoter.weight).to.equal(4000);
      expect(await incentivesPoolStorage.cumulativeVotersWeight()).to.equal(
        9000,
      );

      // Remove voter
      await incentivesPoolStorage
        .connect(registrarSigner)
        .removeVoter(accounts[6].address);

      expect(await incentivesPoolStorage.getVotersCount()).to.equal(2);
      expect(await incentivesPoolStorage.cumulativeVotersWeight()).to.equal(
        6000,
      );

      // Try to get a non existing voter
      await expect(
        incentivesPoolStorage.connect(registrarSigner).getVoterAtIndex(105),
      ).to.be.revertedWith('Index is out of bounds');

      // Try to add voter that would exceed max weight
      const overweightVoter = [{ addr: accounts[8].address, weight: 5000 }];
      await expect(
        incentivesPoolStorage
          .connect(registrarSigner)
          .addVoters(overweightVoter),
      ).to.be.revertedWith('Cumulative weight is too big');

      // Additional voter management checks
      // Try to update non-existent voter
      await expect(
        incentivesPoolStorage
          .connect(registrarSigner)
          .updateVoterWeight(accounts[9].address, 1000),
      ).to.be.revertedWith('Voter not found');

      // Try to remove non-existent voter
      await expect(
        incentivesPoolStorage
          .connect(registrarSigner)
          .removeVoter(accounts[9].address),
      ).to.be.revertedWith('Voter not found');

      // Check voter rewards calculation
      const voterReward =
        await incentivesPool.getTotalProposalVoterIncentiveEstimation();
      expect(voterReward).to.be.eq(0); // storage contract was not funded

      // Verify voter weight affects reward calculation
      const voter = await incentivesPoolStorage.getVoter(accounts[5].address);
      const voterShare = (voterReward * BigInt(voter.weight)) / BigInt(10000);
      const claimableVoterReward = await incentivesPool
        .connect(accounts[5])
        .getClaimableProposalVoterRewardAmount();
      expect(claimableVoterReward).to.equal(voterShare);

      // Verfiy batch is too large
      const votersBachTooLarge = Array.from({ length: 101 }, (_, index) => ({
        addr: accounts[index % accounts.length].address, // Wrap around if index exceeds accounts.length
        weight: 1000, // Fixed weight for all entries (or adjust as needed)
      }));

      await expect(
        incentivesPoolStorage
          .connect(registrarSigner)
          .addVoters(votersBachTooLarge),
      ).to.be.revertedWith('Batch too large');

      // Try to transfer registrar role as a non-hub owner or multisig owner
      await expect(
        incentivesPoolStorage
          .connect(accounts[6])
          .transferVotersRegistrarRole(accounts[7].address),
      ).to.be.revertedWithCustomError(HubLib, 'UnauthorizedAccess');

      // Transfer registrar role to new address as a hub owner
      await expect(
        incentivesPoolStorage
          .connect(accounts[0])
          .transferVotersRegistrarRole(accounts[6].address),
      )
        .to.emit(incentivesPoolStorage, 'VotersRegistrarTransferred')
        .withArgs(registrarSigner.address, accounts[6].address);

      // Verify new registrar
      expect(await incentivesPoolStorage.votersRegistrar()).to.equal(
        accounts[6].address,
      );

      // Test zero address revert
      await expect(
        incentivesPoolStorage
          .connect(accounts[0])
          .transferVotersRegistrarRole(ethers.ZeroAddress),
      ).to.be.revertedWith('New registrar cannot be zero address');
    });

    it('Should handle incentives pool redeployment', async () => {
      // 1. Setup paranet and initial pool
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
        paranetId,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      const originalEmissionMultiplier = ethers.parseUnits('1', 12);

      // Deploy initial pool
      const tx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        originalEmissionMultiplier,
        1000,
        2000,
        'TestPool',
        await Token.getAddress(),
      );

      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      const originalStorageAddress = event?.args[3];
      const originalPoolAddress = event?.args[4];

      // Fund the pool
      const fundingAmount = ethers.parseUnits('1000', 12);
      await Token.connect(accounts[0]).mint(
        originalStorageAddress,
        fundingAmount,
      );

      const initialPool = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        originalPoolAddress,
      );

      const minerRewardBeforeRedeploy = await initialPool
        .connect(kcCreator)
        .getTotalKnowledgeMinerIncentiveEstimation();

      // Redeploy pool
      const redeployTx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).redeployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        originalStorageAddress,
      );

      const redeployReceipt = await redeployTx.wait();
      const redeployEvent = redeployReceipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolRedeployed',
          ).topicHash,
      ) as EventLog;

      // Verify new pool address is different
      const newPoolAddress = redeployEvent?.args[4];
      expect(newPoolAddress).to.not.equal(originalPoolAddress);

      // Verify storage address remains the same
      expect(redeployEvent?.args[3]).to.equal(originalStorageAddress);

      // Verify storage contract points to the same paranet
      const incentivesPoolStorage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        originalStorageAddress,
      );
      expect(await incentivesPoolStorage.paranetId()).to.equal(paranetId);

      // Verify storage contract points to the new pool and not the old one
      expect(
        await incentivesPoolStorage.paranetIncentivesPoolAddress(),
      ).to.equal(newPoolAddress);
      expect(
        await incentivesPoolStorage.paranetIncentivesPoolAddress(),
      ).to.not.equal(originalPoolAddress);

      // Verify funds are preserved
      expect(await incentivesPoolStorage.getBalance()).to.equal(fundingAmount);

      // Verify new pool has the same emission multiplier
      const newPool = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        newPoolAddress,
      );
      expect(
        await newPool.getEffectiveTokenEmissionMultiplier(await time.latest()),
      ).to.equal(originalEmissionMultiplier);

      const minerRewardAfterRedeploy = await newPool
        .connect(kcCreator)
        .getTotalKnowledgeMinerIncentiveEstimation();

      expect(minerRewardAfterRedeploy).to.equal(minerRewardBeforeRedeploy);

      // Try to redeploy non-existent pool
      await expect(
        ParanetIncentivesPoolFactory.connect(
          paranetOwner,
        ).redeployIncentivesPool(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          '0x0000000000000000000000000000000000000000',
        ),
      ).to.be.revertedWith(
        'Cannot redeploy an incentives pool that does not exist',
      );

      // Verify storage contract permissions
      await expect(
        incentivesPoolStorage
          .connect(paranetOwner)
          .setParanetIncentivesPool(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(HubLib, 'UnauthorizedAccess');
    });

    it('Should handle token emission multiplier updates correctly', async () => {
      // 1. Setup paranet and pool
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      const initialEmissionMultiplier = ethers.parseUnits('1', 12);

      // Deploy pool
      const tx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        initialEmissionMultiplier,
        1000, // 10% operator
        2000, // 20% voters
        'TestPool',
        await Token.getAddress(),
      );

      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      const incentivesPool = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        event?.args[4],
      );
      const incentivesPoolStorage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event?.args[3],
      );

      // Get registrar (hub owner)
      const registrar = await incentivesPoolStorage.votersRegistrar();
      const registrarSigner = await hre.ethers.getSigner(registrar);

      // Initiate multiplier update
      const secondMultiplier = ethers.parseUnits('2', 12); // 2 NEURO per 1 TRAC
      const expectedDelay = 7 * 24 * 3600;
      const updateTx = await incentivesPool
        .connect(registrarSigner)
        .initiateTokenEmissionMultiplierUpdate(secondMultiplier);
      const updateReceipt = await updateTx.wait();
      const block = await hre.ethers.provider.getBlock(updateReceipt!.blockNumber);
      const expectedEffectiveDate = block!.timestamp + expectedDelay;
      await expect(updateTx)
        .to.emit(incentivesPool, 'TokenEmissionMultiplierUpdateInitiated')
        .withArgs(
          initialEmissionMultiplier,
          secondMultiplier,
          expectedEffectiveDate,
        );

      // Try to finalize too early - should fail
      await expect(
        incentivesPool
          .connect(registrarSigner)
          .finalizeTokenEmissionMultiplierUpdate(),
      ).to.be.revertedWith('Delay period not yet passed');

      // Move time forward 7 days
      await time.increase(7 * 24 * 3600);

      // Finalize update
      await expect(
        incentivesPool
          .connect(registrarSigner)
          .finalizeTokenEmissionMultiplierUpdate(),
      )
        .to.emit(incentivesPool, 'TokenEmissionMultiplierUpdateFinalized')
        .withArgs(initialEmissionMultiplier, secondMultiplier);

      // Verify new multiplier is active
      expect(
        await incentivesPool.getEffectiveTokenEmissionMultiplier(
          await time.latest(),
        ),
      ).to.equal(secondMultiplier);

      // Additional checks for emission multiplier updates
      // Check multiple updates in sequence
      const thirdMultiplier = ethers.parseUnits('3', 12);
      await incentivesPool
        .connect(registrarSigner)
        .initiateTokenEmissionMultiplierUpdate(thirdMultiplier);

      // Verify pending update state
      const multipliers = await incentivesPool.gettokenEmissionMultipliers();
      expect(multipliers[multipliers.length - 1].multiplier).to.equal(
        thirdMultiplier,
      );
      expect(multipliers[multipliers.length - 1].finalized).to.equal(false);

      // Try to initiate another update while one is pending - should update the pending one
      const fourthMultiplier = ethers.parseUnits('4', 12);
      await incentivesPool
        .connect(registrarSigner)
        .initiateTokenEmissionMultiplierUpdate(fourthMultiplier);
      const updatedMultipliers =
        await incentivesPool.gettokenEmissionMultipliers();
      expect(
        updatedMultipliers[updatedMultipliers.length - 1].multiplier,
      ).to.equal(fourthMultiplier);

      // Move time forward 7 days
      await time.increase(7 * 24 * 3600);

      // Finalize update
      await expect(
        incentivesPool
          .connect(registrarSigner)
          .finalizeTokenEmissionMultiplierUpdate(),
      )
        .to.emit(incentivesPool, 'TokenEmissionMultiplierUpdateFinalized')
        .withArgs(secondMultiplier, fourthMultiplier); // Didn't finalize the third multiplier

      // Verify new multiplier is active
      expect(
        await incentivesPool.getEffectiveTokenEmissionMultiplier(
          await time.latest(),
        ),
      ).to.equal(fourthMultiplier);

      // Should allow hub owner to update token emission multiplier delay
      const hubContract = await hre.ethers.getContractAt(
        'Hub',
        await incentivesPool.hub(),
      );
      const hubOwner = await hubContract.owner();
      const hubOwnerSigner = await hre.ethers.getSigner(hubOwner);

      // Update delay as hub owner
      const newDelay = 14 * 24 * 60 * 60; // 14 days
      await incentivesPool
        .connect(hubOwnerSigner)
        .updatetokenEmissionMultiplierUpdateDelay(newDelay);
      expect(
        await incentivesPool.tokenEmissionMultiplierUpdateDelay(),
      ).to.equal(newDelay);

      // Try to update delay as non-hub owner
      const nonOwner = accounts[9];
      await expect(
        incentivesPool
          .connect(nonOwner)
          .updatetokenEmissionMultiplierUpdateDelay(newDelay),
      ).to.be.revertedWith('Fn can only be used by hub owner');
    });
  });

  describe('Paranet Incentives Pool Rewards', () => {
    it('Should deploy pool, add KCs, fund pool and claim rewards correctly', async () => {
      // 1. Setup paranet first
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
        paranetId,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Deploy incentives pool
      const tracToNeuroEmissionMultiplier = ethers.parseUnits('5', 12); // 5 NEURO per 1 TRAC
      const operatorRewardPercentage = 1000; // 10%
      const votersRewardPercentage = 2000; // 20%

      const tx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        tracToNeuroEmissionMultiplier,
        operatorRewardPercentage,
        votersRewardPercentage,
        'TestPool',
        await Token.getAddress(),
      );

      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      const poolStorageAddress = event?.args[3];
      const poolAddress = event?.args[4];

      // 3. Create and submit knowledge collections to paranet
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );
      await Paranet.connect(kcCreator).submitKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 4. Fund the incentives pool with tokens
      const fundAmount = ethers.parseUnits('1000', 12); // 1000 tokens
      await Token.connect(accounts[0]).mint(poolStorageAddress, fundAmount);

      // 5. Get pool contracts
      const incentivesPool = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        poolAddress,
      );
      const incentivesPoolStorage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        poolStorageAddress,
      );

      // 6. Check initial balances
      expect(await incentivesPoolStorage.getBalance()).to.equal(fundAmount);
      expect(await incentivesPoolStorage.totalMinersclaimedToken()).to.equal(0);
      expect(await incentivesPoolStorage.totalOperatorsclaimedToken()).to.equal(
        0,
      );
      expect(await incentivesPoolStorage.totalVotersclaimedToken()).to.equal(0);

      // 6.1. Check claim subfunctions - Not necessary for the claim flow
      // Check all percentage getters
      const operatorPercentage =
        await incentivesPoolStorage.paranetOperatorRewardPercentage();
      const votersPercentage =
        await incentivesPoolStorage.paranetIncentivizationProposalVotersRewardPercentage();

      expect(operatorPercentage).to.equal(operatorRewardPercentage); // 10%
      expect(votersPercentage).to.equal(votersRewardPercentage); // 20%

      // Calculate miners percentage (should be 70%)
      const minersPercentage =
        BigInt(10 ** 4) - operatorPercentage - votersPercentage;
      expect(minersPercentage).to.equal(7000); // 70%

      expect(await incentivesPoolStorage.paranetId()).to.equal(paranetId);

      // Check effective token emission multiplier
      const effectiveMultiplier =
        await incentivesPool.getEffectiveTokenEmissionMultiplier(
          await hre.ethers.provider
            .getBlock('latest')
            .then((b) => b!.timestamp),
        );
      expect(effectiveMultiplier).to.equal(ethers.parseUnits('5', 12));

      // Check unrewarded TRAC spent
      const unrewardedTracSpent =
        await ParanetKnowledgeMinersRegistry.getUnrewardedTracSpent(
          kcCreator.address,
          await incentivesPoolStorage.paranetId(),
        );
      expect(unrewardedTracSpent).to.be.gt(10 ** 6);

      // Calculate expected reward manually
      const expectedReward =
        (((BigInt(unrewardedTracSpent) * effectiveMultiplier) /
          BigInt(10 ** 18)) *
          BigInt(minersPercentage)) /
        BigInt(10 ** 4);

      // Compare with contract calculation
      const actualReward = await incentivesPool
        .connect(kcCreator)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(actualReward).to.equal(expectedReward);
      expect(actualReward).to.be.gt(0);

      const claimableMinerRewardAmount = await incentivesPool
        .connect(kcCreator)
        .getClaimableKnowledgeMinerRewardAmount();

      const newUnrewardedTracSpent =
        claimableMinerRewardAmount == actualReward
          ? 0
          : (BigInt(actualReward - claimableMinerRewardAmount) *
              BigInt(10 ** 18)) /
            BigInt(await incentivesPoolStorage.getClaimedMinerRewardsLength());

      expect(newUnrewardedTracSpent).to.equal(0);

      expect(
        await incentivesPoolStorage.getClaimedMinerRewardsLength(),
      ).to.equal(0);

      // 7. Claim miner rewards
      const minerRewardEstimate = await incentivesPool
        .connect(kcCreator)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(minerRewardEstimate).to.be.gt(0);

      const claimableMinerReward = await incentivesPool
        .connect(kcCreator)
        .getClaimableKnowledgeMinerRewardAmount();

      await incentivesPool
        .connect(kcCreator)
        .claimKnowledgeMinerReward(claimableMinerReward);

      // 8. Verify miner rewards claimed correctly
      // Test getting all rewarded miners/operators
      const allMiners = await incentivesPoolStorage.getAllRewardedMiners();
      expect(allMiners.length).to.equal(1);

      // Test claimed token queries
      expect(
        await incentivesPoolStorage.minerclaimedToken(kcCreator.address),
      ).to.equal(claimableMinerReward);

      expect(
        await incentivesPoolStorage
          .connect(kcCreator)
          .totalMinersclaimedToken(),
      ).to.equal(claimableMinerReward);
      const minerProfile =
        await incentivesPoolStorage.getClaimedMinerRewardsAtIndex(
          await incentivesPoolStorage.claimedMinerRewardsIndexes(
            kcCreator.address,
          ),
        );
      expect(minerProfile.addr).to.equal(kcCreator.address);
      expect(minerProfile.claimedToken).to.equal(claimableMinerReward);

      // 9. Claim operator rewards
      const operatorRewardEstimate =
        await incentivesPool.getTotalParanetOperatorIncentiveEstimation();
      expect(operatorRewardEstimate).to.be.gt(0);

      const claimableOperatorReward =
        await incentivesPool.getClaimableParanetOperatorRewardAmount();
      await incentivesPool.connect(paranetOwner).claimParanetOperatorReward();

      // 10. Verify operator rewards claimed correctly
      const allOperators =
        await incentivesPoolStorage.getAllRewardedOperators();
      expect(allOperators.length).to.equal(1);

      expect(
        await incentivesPoolStorage.operatorclaimedToken(paranetOwner.address),
      ).to.equal(claimableOperatorReward);

      expect(await incentivesPoolStorage.totalOperatorsclaimedToken()).to.equal(
        claimableOperatorReward,
      );
      const operatorProfile =
        await incentivesPoolStorage.getClaimedOperatorRewardsAtIndex(
          await incentivesPoolStorage.claimedOperatorRewardsIndexes(
            paranetOwner.address,
          ),
        );
      expect(operatorProfile.addr).to.equal(paranetOwner.address);
      expect(operatorProfile.claimedToken).to.equal(claimableOperatorReward);

      // 11. Verify final pool balance
      const expectedRemainingBalance =
        fundAmount - claimableMinerReward - claimableOperatorReward;
      expect(await incentivesPoolStorage.getBalance()).to.equal(
        expectedRemainingBalance,
      );
    });

    it('Should fail to claim rewards when pool has no funds', async () => {
      // 1. Setup paranet first
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
        paranetId,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // Deploy pool without funding it
      const tx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('1', 12), // 1 NEURO per 1 TRAC
        1000, // 10% operatorRewardPercentage
        2000, // 20% votersRewardPercentage
        'TestPool',
        await Token.getAddress(),
      );

      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      const incentivesPool = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        event?.args[4],
      );

      // Create and submit knowledge collections to paranet
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(kcCreator).submitKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      expect(
        await ParanetsRegistry.isKnowledgeMinerRegistered(
          paranetId,
          kcCreator.address,
        ),
      ).to.be.equal(true);

      // Verify rewards are calculated for the miner
      const minerRewardEstimate = await incentivesPool
        .connect(kcCreator)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(minerRewardEstimate).to.be.gt(0);

      const claimableMinerReward = await incentivesPool
        .connect(kcCreator)
        .getClaimableKnowledgeMinerRewardAmount();
      expect(claimableMinerReward).to.equal(0);

      // Try to claim miner rewards
      await expect(
        incentivesPool.connect(kcCreator).claimKnowledgeMinerReward(0),
      ).to.be.revertedWithCustomError(incentivesPool, 'NoRewardAvailable');

      // Verify rewards are calculated for the operator
      const operatorRewardEstimate = await incentivesPool
        .connect(paranetOwner)
        .getTotalParanetOperatorIncentiveEstimation();
      expect(operatorRewardEstimate).to.be.gt(0);

      const claimableOperatorReward =
        await incentivesPool.getClaimableParanetOperatorRewardAmount();
      expect(claimableOperatorReward).to.equal(0);

      // Try to claim operator rewards
      await expect(
        incentivesPool.connect(paranetOwner).claimParanetOperatorReward(),
      ).to.be.revertedWithCustomError(incentivesPool, 'NoRewardAvailable');
    });

    it('Should handle incentives pool with zero rewards available', async () => {
      // 1. Setup paranet and create KC
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Deploy incentives pool (but don't fund it)
      const tx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('1', 12),
        1000,
        2000,
        'EmptyPool',
        await Token.getAddress(),
      );

      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      // 3. Create and submit KC to generate some rewards
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(kcCreator).submitKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 4. Try to claim rewards from empty pool
      const incentivesPool = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        event?.args[4],
      );

      // Verify rewards are calculated but not claimable
      const minerRewardEstimate = await incentivesPool
        .connect(kcCreator)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(minerRewardEstimate).to.be.gt(0);

      const claimableMinerReward = await incentivesPool
        .connect(kcCreator)
        .getClaimableKnowledgeMinerRewardAmount();
      expect(claimableMinerReward).to.equal(0);

      // Try to claim - should fail
      await expect(
        incentivesPool.connect(kcCreator).claimKnowledgeMinerReward(0),
      ).to.be.revertedWithCustomError(incentivesPool, 'NoRewardAvailable');
    });

    it('Should handle incentives pool with partial funding', async () => {
      // 1. Setup paranet and create KC
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Deploy incentives pool
      const tx = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('1', 12),
        1000,
        2000,
        'PartialPool',
        await Token.getAddress(),
      );

      const receipt = await tx.wait();
      const event = receipt!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      // 3. Create and submit KC to generate rewards
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(kcCreator).submitKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      const incentivesPool = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        event?.args[4],
      );

      // 4. Fund pool with partial miner reward amount
      const minerRewardEstimate = await incentivesPool
        .connect(kcCreator)
        .getTotalKnowledgeMinerIncentiveEstimation();
      const partialFunding = minerRewardEstimate / BigInt(2); // Fund 50% of estimated rewards

      await Token.connect(accounts[0]).mint(event?.args[3], partialFunding);

      // 5. Verify partial rewards are claimable
      const claimableMinerReward = await incentivesPool
        .connect(kcCreator)
        .getClaimableKnowledgeMinerRewardAmount();
      expect(claimableMinerReward).to.be.lessThanOrEqual(partialFunding);

      // 6. Claim partial rewards
      await incentivesPool
        .connect(kcCreator)
        .claimKnowledgeMinerReward(claimableMinerReward);

      // 7. Verify remaining rewards are still tracked but not claimable
      const remainingEstimate = await incentivesPool
        .connect(kcCreator)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(remainingEstimate).to.be.lessThanOrEqual(
        minerRewardEstimate - partialFunding,
      );

      const remainingClaimable = await incentivesPool
        .connect(kcCreator)
        .getClaimableKnowledgeMinerRewardAmount();
      expect(remainingClaimable).to.equal(0);
    });

    it('Should handle claiming rewards from multiple incentives pools', async () => {
      // 1. Setup paranet with initial configuration
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        // paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Deploy two incentive pools with different parameters
      const tx1 = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('1', 12), // 1 NEURO per 1 TRAC
        1000, // 10% operator
        2000, // 20% voters
        'Pool1',
        await Token.getAddress(),
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      const tx2 = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('2', 12), // 2 NEURO per 1 TRAC
        1500, // 15% operator
        2500, // 25% voters
        'Pool2',
        await Token.getAddress(),
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      // 3. Fund both pools
      const pool1Amount = ethers.parseUnits('100', 18); // 100 NEURO
      const pool2Amount = ethers.parseUnits('200', 18); // 200 NEURO
      await Token.connect(paranetOwner).approve(event1?.args[3], pool1Amount);
      await Token.connect(paranetOwner).approve(event2?.args[3], pool2Amount);

      const pool1Storage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event1?.args[3],
      );
      const pool1 = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        event1?.args[4],
      );

      const pool2Storage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event2?.args[3],
      );
      const pool2 = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        event2?.args[4],
      );

      await Token.connect(accounts[0]).mint(pool1Storage, pool1Amount);
      await Token.connect(accounts[0]).mint(pool2Storage, pool2Amount);

      expect(await pool1Storage.getBalance()).to.equal(pool1Amount);
      expect(await pool1Storage.totalMinersclaimedToken()).to.equal(0);
      expect(await pool1Storage.totalOperatorsclaimedToken()).to.equal(0);
      expect(await pool1Storage.totalVotersclaimedToken()).to.equal(0);

      expect(await pool2Storage.getBalance()).to.equal(pool2Amount);
      expect(await pool2Storage.totalMinersclaimedToken()).to.equal(0);
      expect(await pool2Storage.totalOperatorsclaimedToken()).to.equal(0);
      expect(await pool2Storage.totalVotersclaimedToken()).to.equal(0);

      const miner = accounts[100];
      const { collectionId } = await createKnowledgeCollection(
        miner,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(miner).submitKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 5. Claim rewards from first pool
      const initialMinerBalance = await Token.balanceOf(
        await miner.getAddress(),
      );
      const minerRewardEstimate1 = await pool1
        .connect(miner)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(minerRewardEstimate1).to.be.gt(0);

      await pool1
        .connect(miner)
        .claimKnowledgeMinerReward(minerRewardEstimate1);
      // 6. Verify first pool is empty and second pool still has funds
      expect(await Token.balanceOf(await miner.getAddress())).to.be.equal(
        initialMinerBalance + minerRewardEstimate1,
      );
      expect(await Token.balanceOf(event1?.args[3])).to.equal(
        pool1Amount - minerRewardEstimate1,
      );
      expect(await Token.balanceOf(event2?.args[3])).to.equal(pool2Amount);

      // 7. Claim rewards from second pool
      const minerRewardEstimate0 = await pool2
        .connect(miner)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(minerRewardEstimate0).to.be.equal(0);

      await expect(
        pool2.connect(miner).claimKnowledgeMinerReward(minerRewardEstimate0),
      ).to.be.revertedWithCustomError(pool2, 'NoRewardAvailable');

      expect(await Token.balanceOf(await miner.getAddress())).to.equal(
        initialMinerBalance + minerRewardEstimate1,
      );
      expect(await Token.balanceOf(pool2Storage)).to.equal(pool2Amount);

      const { collectionId: collectionId2 } = await createKnowledgeCollection(
        miner,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(miner).submitKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId2,
      );
      const initialMinerBalance2 = await Token.balanceOf(
        await miner.getAddress(),
      );
      const minerRewardEstimate2 = await pool1
        .connect(miner)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(minerRewardEstimate2).to.be.gt(0);

      await pool2
        .connect(miner)
        .claimKnowledgeMinerReward(minerRewardEstimate2);

      // 8. Verify balances is updated
      expect(await Token.balanceOf(pool1Storage)).to.equal(
        pool1Amount - minerRewardEstimate1,
      );
      expect(await Token.balanceOf(pool2Storage)).to.equal(
        pool2Amount - minerRewardEstimate2,
      );
      expect(await Token.balanceOf(await miner.getAddress())).to.equal(
        initialMinerBalance2 + minerRewardEstimate2,
      );
    });

    it('Should handle claiming rewards from multiple incentives pools with native token', async () => {
      // 1. Setup paranet with initial configuration
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Deploy two incentive pools with different parameters using address(0) for native token
      const tx1 = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('1', 12), // 1 ETH per 1 TRAC
        1000, // 10% operator
        2000, // 20% voters
        'Pool1',
        ethers.ZeroAddress, // Use address(0) for native token
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      const tx2 = await ParanetIncentivesPoolFactory.connect(
        paranetOwner,
      ).deployIncentivesPool(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        ethers.parseUnits('2', 12), // 2 ETH per 1 TRAC
        1500, // 15% operator
        2500, // 25% voters
        'Pool2',
        ethers.ZeroAddress, // Use address(0) for native token
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2!.logs.find(
        (log) =>
          log.topics[0] ===
          ParanetIncentivesPoolFactory.interface.getEvent(
            'ParanetIncentivesPoolDeployed',
          ).topicHash,
      ) as EventLog;

      // 3. Fund both pools with ETH
      const pool1Amount = ethers.parseEther('100'); // 100 ETH
      const pool2Amount = ethers.parseEther('200'); // 200 ETH

      const pool1Storage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event1?.args[3],
      );
      const pool1 = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        event1?.args[4],
      );

      const pool2Storage = await hre.ethers.getContractAt(
        'ParanetIncentivesPoolStorage',
        event2?.args[3],
      );
      const pool2 = await hre.ethers.getContractAt(
        'ParanetIncentivesPool',
        event2?.args[4],
      );

      // Send ETH to pools
      await paranetOwner.sendTransaction({
        to: pool1Storage.target,
        value: pool1Amount,
      });
      await paranetOwner.sendTransaction({
        to: pool2Storage.target,
        value: pool2Amount,
      });

      // Verify initial balances
      expect(
        await hre.ethers.provider.getBalance(pool1Storage.target),
      ).to.equal(pool1Amount);
      expect(await pool1Storage.totalMinersclaimedToken()).to.equal(0);
      expect(await pool1Storage.totalOperatorsclaimedToken()).to.equal(0);
      expect(await pool1Storage.totalVotersclaimedToken()).to.equal(0);

      expect(
        await hre.ethers.provider.getBalance(pool2Storage.target),
      ).to.equal(pool2Amount);
      expect(await pool2Storage.totalMinersclaimedToken()).to.equal(0);
      expect(await pool2Storage.totalOperatorsclaimedToken()).to.equal(0);
      expect(await pool2Storage.totalVotersclaimedToken()).to.equal(0);

      // 4. Create and submit knowledge collection
      const miner = accounts[100];
      const { collectionId } = await createKnowledgeCollection(
        miner,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(miner).submitKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 5. Claim rewards from first pool
      const initialMinerBalance = await hre.ethers.provider.getBalance(
        miner.address,
      );
      const minerRewardEstimate1 = await pool1
        .connect(miner)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(minerRewardEstimate1).to.be.gt(0);

      const claimTx1 = await pool1
        .connect(miner)
        .claimKnowledgeMinerReward(minerRewardEstimate1);
      const receipt3 = await claimTx1.wait();
      const gasCost1 = receipt3!.gasUsed * receipt3!.gasPrice;

      // 6. Verify first pool balance and miner received ETH
      const newMinerBalance = await hre.ethers.provider.getBalance(
        miner.address,
      );
      expect(newMinerBalance).to.be.equal(
        initialMinerBalance + minerRewardEstimate1 - gasCost1,
      );
      expect(
        await hre.ethers.provider.getBalance(pool1Storage.target),
      ).to.equal(pool1Amount - minerRewardEstimate1);
      expect(
        await hre.ethers.provider.getBalance(pool2Storage.target),
      ).to.equal(pool2Amount);

      // 7. Try claiming from second pool (should fail as no rewards available yet)
      const minerRewardEstimate0 = await pool2
        .connect(miner)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(minerRewardEstimate0).to.be.equal(0);

      await expect(
        pool2.connect(miner).claimKnowledgeMinerReward(minerRewardEstimate0),
      ).to.be.revertedWithCustomError(pool2, 'NoRewardAvailable');

      await expect(
        pool1.connect(miner).claimKnowledgeMinerReward(minerRewardEstimate0),
      ).to.be.revertedWithCustomError(pool1, 'NoRewardAvailable');

      // 8. Submit second knowledge collection
      const { collectionId: collectionId2 } = await createKnowledgeCollection(
        miner,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(miner).submitKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId2,
      );

      // 9. Claim rewards from second pool
      const initialMinerBalance2 = await hre.ethers.provider.getBalance(
        miner.address,
      );
      const minerRewardEstimate2 = await pool2
        .connect(miner)
        .getTotalKnowledgeMinerIncentiveEstimation();
      expect(minerRewardEstimate2).to.be.gt(0);

      const claimTx2 = await pool2
        .connect(miner)
        .claimKnowledgeMinerReward(minerRewardEstimate2);
      const receipt4 = await claimTx2.wait();
      const gasCost2 = receipt4!.gasUsed * receipt4!.gasPrice;

      // 10. Verify final balances
      expect(
        await hre.ethers.provider.getBalance(pool1Storage.target),
      ).to.equal(pool1Amount - minerRewardEstimate1);
      expect(
        await hre.ethers.provider.getBalance(pool2Storage.target),
      ).to.equal(pool2Amount - minerRewardEstimate2);
      expect(await hre.ethers.provider.getBalance(miner.address)).to.equal(
        initialMinerBalance2 + minerRewardEstimate2 - gasCost2,
      );
    });
  });

  describe('Submit Knowledge Collection to Paranet', () => {
    it('Should submit knowledge collection to paranet successfully', async () => {
      // 1. Setup paranet first
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        // paranetOwner,
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );
      // 3. Submit knowledge collection to paranet
      await Paranet.connect(kcCreator).submitKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 4. Verify submission
      // Check if KC is registered in paranet
      const isRegistered =
        await ParanetsRegistry.isKnowledgeCollectionRegistered(
          paranetId,
          ethers.keccak256(
            ethers.solidityPacked(
              ['address', 'uint256'],
              [await KnowledgeCollectionStorage.getAddress(), collectionId],
            ),
          ),
        );

      expect(isRegistered).to.be.equal(true);

      // Check if KC is in miner's submitted collections
      const submittedCollections =
        await ParanetKnowledgeMinersRegistry.getSubmittedKnowledgeCollections(
          kcCreator.address,
          paranetId,
        );
      expect(submittedCollections).to.include(
        ethers.keccak256(
          ethers.solidityPacked(
            ['address', 'uint256'],
            [await KnowledgeCollectionStorage.getAddress(), collectionId],
          ),
        ),
      );

      // Check miner's stats were updated
      const minerMetadata =
        await ParanetKnowledgeMinersRegistry.getKnowledgeMinerMetadata(
          kcCreator.address,
        );
      expect(minerMetadata.totalSubmittedKnowledgeCollectionsCount).to.equal(1);

      // Check if TRAC amounts were tracked correctly
      const remainingTokenAmount =
        await KnowledgeCollectionStorage.getTokenAmount(collectionId);

      // Check cumulative TRAC spent
      const cumulativeTracSpent =
        await ParanetKnowledgeMinersRegistry.getCumulativeTracSpent(
          kcCreator.address,
          paranetId,
        );
      expect(cumulativeTracSpent).to.equal(remainingTokenAmount);

      // Check unrewarded TRAC spent
      const unrewardedTracSpent =
        await ParanetKnowledgeMinersRegistry.getUnrewardedTracSpent(
          kcCreator.address,
          paranetId,
        );
      expect(unrewardedTracSpent).to.equal(remainingTokenAmount);

      // Check total TRAC spent
      const totalTracSpent =
        await ParanetKnowledgeMinersRegistry.getTotalTracSpent(
          kcCreator.address,
        );
      expect(totalTracSpent).to.equal(remainingTokenAmount);

      // Check paranet's cumulative knowledge value
      const paranetMetadata =
        await ParanetsRegistry.getParanetMetadata(paranetId);
      expect(paranetMetadata.cumulativeKnowledgeValue).to.equal(
        remainingTokenAmount,
      );

      const { collectionId: collectionId2 } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      // Verify event emission
      await expect(
        Paranet.connect(kcCreator).submitKnowledgeCollection(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          await KnowledgeCollectionStorage.getAddress(),
          collectionId2,
        ),
      )
        .to.emit(Paranet, 'KnowledgeCollectionSubmittedToParanet')
        .withArgs(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          await KnowledgeCollectionStorage.getAddress(),
          collectionId2,
        );
    });

    it('Should revert when non-owner tries to submit knowledge collection', async () => {
      // 1. Setup paranet
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const nonOwner = accounts[10];

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a knowledge collection
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      // 3. Try to submit KC with non-owner account
      await expect(
        Paranet.connect(nonOwner).submitKnowledgeCollection(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          await KnowledgeCollectionStorage.getAddress(),
          collectionId,
        ),
      ).to.be.revertedWith('Caller not the owner of KC');
    });

    it('Should revert when registering the same knowledge collection twice', async () => {
      // 1. Setup paranet
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a knowledge collection
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(kcCreator).submitKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 4. Try to submit the same knowledge collection again
      await expect(
        Paranet.connect(kcCreator).submitKnowledgeCollection(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          await KnowledgeCollectionStorage.getAddress(),
          collectionId,
        ),
      ).to.be.revertedWithCustomError(
        Paranet,
        'KnowledgeCollectionIsAPartOfOtherParanet',
      );
    });

    it('Should not allow submitting KC to second paranet after first', async () => {
      // 1. Setup first paranet
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const firstParanet = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'First Paranet',
        'First Paranet Description',
      );

      // 2. Setup second paranet
      const { collectionId: secondParanetCollectionId } =
        await createKnowledgeCollection(
          kcCreator,
          publishingNode,
          firstParanet.publishingNodeIdentityId,
          receivingNodes,
          firstParanet.receivingNodesIdentityIds,
          {
            KnowledgeCollection,
            Token,
          },
        );

      await Paranet.connect(kcCreator).registerParanet(
        await KnowledgeCollectionStorage.getAddress(),
        secondParanetCollectionId,
        1,
        'Second Paranet',
        'Second Paranet Description',
        0,
        0,
        0,
      );

      // 3. Create a knowledge collection
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        firstParanet.publishingNodeIdentityId,
        receivingNodes,
        firstParanet.receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      // 4. Submit KC to first paranet
      await Paranet.connect(kcCreator).submitKnowledgeCollection(
        firstParanet.paranetKCStorageContract,
        firstParanet.paranetKCTokenId,
        firstParanet.paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 5. Try to submit the same KC to second paranet
      await expect(
        Paranet.connect(kcCreator).submitKnowledgeCollection(
          await KnowledgeCollectionStorage.getAddress(),
          secondParanetCollectionId,
          1,
          await KnowledgeCollectionStorage.getAddress(),
          collectionId,
        ),
      ).to.be.revertedWithCustomError(
        Paranet,
        'KnowledgeCollectionIsAPartOfOtherParanet',
      );

      // 6. Verify KC is only registered in first paranet
      const knowledgeCollectionId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [await KnowledgeCollectionStorage.getAddress(), collectionId],
        ),
      );

      const isRegisteredInFirstParanet =
        await ParanetsRegistry.isKnowledgeCollectionRegistered(
          firstParanet.paranetId,
          knowledgeCollectionId,
        );
      expect(isRegisteredInFirstParanet).to.be.equal(true);

      const secondParanetId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256', 'uint256'],
          [
            await KnowledgeCollectionStorage.getAddress(),
            secondParanetCollectionId,
            1,
          ],
        ),
      );
      const isRegisteredInSecondParanet =
        await ParanetsRegistry.isKnowledgeCollectionRegistered(
          secondParanetId,
          knowledgeCollectionId,
        );
      expect(isRegisteredInSecondParanet).to.be.equal(false);
    });
  });

  describe('Paranet with Staged Knowledge Collections', () => {
    const KNOWLEDGE_COLLECTIONS_SUBMISSION_POLICY_STAGING = 1;

    it('Should create paranet with staging policy and add curator successfully', async () => {
      // 1. Setup initial accounts
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      // 2. Create paranet with staging policy
      const {
        paranetOwner,
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0,
        0,
        KNOWLEDGE_COLLECTIONS_SUBMISSION_POLICY_STAGING,
      );

      // 3. Add paranet owner as curator
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner.address,
      );

      // 4. Verify curator was added correctly
      const isCurator = await ParanetStagingRegistry.isCurator(
        paranetId,
        paranetOwner.address,
      );
      expect(isCurator).to.be.equal(true);

      // 5. Verify paranet metadata
      const paranetMetadata =
        await ParanetsRegistry.getParanetMetadata(paranetId);
      expect(paranetMetadata.knowledgeCollectionsSubmissionPolicy).to.equal(
        KNOWLEDGE_COLLECTIONS_SUBMISSION_POLICY_STAGING,
      );

      // 6. Get all curators and verify
      const curators =
        await ParanetStagingRegistry.getAllParanetCurators(paranetId);
      expect(curators).to.have.lengthOf(1);
      expect(curators[0]).to.equal(paranetOwner.address);
    });

    it('Should revert when non-owner tries to add curator', async () => {
      // 1. Setup initial accounts
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const nonOwner = accounts[10];

      // 2. Create paranet with staging policy
      const { paranetKCStorageContract, paranetKCTokenId, paranetKATokenId } =
        await setupParanet(
          kcCreator,
          publishingNode,
          receivingNodes,
          {
            Paranet,
            Profile,
            Token,
            KnowledgeCollection,
            KnowledgeCollectionStorage,
          },
          'Test Paranet',
          'Test Paranet Description',
          0,
          0,
          KNOWLEDGE_COLLECTIONS_SUBMISSION_POLICY_STAGING,
        );

      // 3. Try to add curator with non-owner account
      await expect(
        Paranet.connect(nonOwner).addCurator(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          nonOwner.address,
        ),
      ).to.be.revertedWith('Caller not the owner of the KA');
    });

    it('Should submit KC to staging and have curator approve it', async () => {
      // 1. Setup paranet with staging policy
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0,
        0,
        KNOWLEDGE_COLLECTIONS_SUBMISSION_POLICY_STAGING,
      );

      // 2. Add paranet owner as curator
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner.address,
      );

      // 4. Submit KC to paranet (goes to staging)
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );
      // 3. Submit knowledge collection to paranet
      await Paranet.connect(kcCreator).stageKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 5. Verify KC is in staging
      const knowledgeCollectionId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [await KnowledgeCollectionStorage.getAddress(), collectionId],
        ),
      );

      const stagedStatus =
        await ParanetStagingRegistry.getKnowledgeCollectionStatus(
          paranetId,
          knowledgeCollectionId,
        );
      expect(stagedStatus).to.equal(1); // PENDING

      const isStaged = await ParanetStagingRegistry.isKnowledgeCollectionStaged(
        paranetId,
        knowledgeCollectionId,
      );
      expect(isStaged).to.be.equal(true);

      // 6. Have curator approve the KC
      await Paranet.connect(paranetOwner).reviewKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetKCStorageContract,
        collectionId,
        true, // approve
      );

      // 7. Verify KC is now registered in paranet
      const isRegistered =
        await ParanetsRegistry.isKnowledgeCollectionRegistered(
          paranetId,
          knowledgeCollectionId,
        );
      expect(isRegistered).to.be.equal(true);

      const stagedStatusAfterApproval =
        await ParanetStagingRegistry.getKnowledgeCollectionStatus(
          paranetId,
          knowledgeCollectionId,
        );
      expect(stagedStatusAfterApproval).to.equal(2); // APPROVED

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [pendingCollections, total] =
        await ParanetStagingRegistry.getPendingCollections(paranetId, 0, 10);
      expect(total).to.be.equal(0);
    });

    it('Should submit KC to staging and have curator reject it', async () => {
      // 1. Setup paranet with staging policy
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0,
        0,
        KNOWLEDGE_COLLECTIONS_SUBMISSION_POLICY_STAGING,
      );

      // 2. Add paranet owner as curator
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner.address,
      );

      // 3. Create and submit KC to paranet staging
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(kcCreator).stageKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 4. Get knowledge collection ID
      const knowledgeCollectionId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [await KnowledgeCollectionStorage.getAddress(), collectionId],
        ),
      );

      // 5. Have curator reject the KC
      await Paranet.connect(paranetOwner).reviewKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
        false, // reject
      );

      // 6. Verify KC was rejected and not registered in paranet
      const isRegistered =
        await ParanetsRegistry.isKnowledgeCollectionRegistered(
          paranetId,
          knowledgeCollectionId,
        );
      expect(isRegistered).to.be.equal(false);

      const stagedStatusAfterRejection =
        await ParanetStagingRegistry.getKnowledgeCollectionStatus(
          paranetId,
          knowledgeCollectionId,
        );
      expect(stagedStatusAfterRejection).to.equal(3); // REJECTED

      // 7. Verify KC is still staged but marked as rejected
      const isStaged = await ParanetStagingRegistry.isKnowledgeCollectionStaged(
        paranetId,
        knowledgeCollectionId,
      );
      expect(isStaged).to.be.equal(false);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [pendingCollectionsAfterRejection, totalAfterRejection] =
        await ParanetStagingRegistry.getPendingCollections(paranetId, 0, 10);
      expect(totalAfterRejection).to.be.equal(0);
    });

    it('Should allow resubmission of previously rejected Knowledge Collection', async () => {
      // 1. Setup paranet with staging policy
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0,
        0,
        KNOWLEDGE_COLLECTIONS_SUBMISSION_POLICY_STAGING,
      );

      // 2. Add paranet owner as curator
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner.address,
      );

      // 3. Create and submit KC to paranet staging
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      // 4. First submission - Stage the Knowledge Collection
      await Paranet.connect(kcCreator).stageKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      const knowledgeCollectionId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [await KnowledgeCollectionStorage.getAddress(), collectionId],
        ),
      );

      // 5. Verify it's in pending state
      let [pendingCollections, total] =
        await ParanetStagingRegistry.getPendingCollections(paranetId, 0, 10);
      expect(total).to.equal(1);
      expect(pendingCollections[0].knowledgeCollectionId).to.equal(
        knowledgeCollectionId,
      );
      expect(pendingCollections[0].status).to.equal(1); // PENDING

      // 6. Have curator reject the KC
      await Paranet.connect(paranetOwner).reviewKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
        false, // reject
      );

      // 7. Verify rejection status (???)
      let status = await ParanetStagingRegistry.getKnowledgeCollectionStatus(
        paranetId,
        knowledgeCollectionId,
      );
      expect(status).to.equal(3); // REJECTED

      [pendingCollections, total] =
        await ParanetStagingRegistry.getPendingCollections(paranetId, 0, 10);
      expect(total).to.equal(0);
      expect(pendingCollections).to.have.lengthOf(0);

      // 8. Resubmit the Knowledge Collection
      await Paranet.connect(kcCreator).stageKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 9. Verify it's back in pending state
      [pendingCollections, total] =
        await ParanetStagingRegistry.getPendingCollections(paranetId, 0, 10);
      expect(total).to.equal(1);
      expect(pendingCollections[0].knowledgeCollectionId).to.equal(
        knowledgeCollectionId,
      );
      expect(pendingCollections[0].status).to.equal(1); // PENDING

      // 10. Have curator approve the KC this time
      await Paranet.connect(paranetOwner).reviewKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
        true, // approve
      );

      // 11. Verify final approval status
      status = await ParanetStagingRegistry.getKnowledgeCollectionStatus(
        paranetId,
        knowledgeCollectionId,
      );
      expect(status).to.equal(2); // APPROVED

      // 12. Verify KC is now registered in paranet
      const isRegistered =
        await ParanetsRegistry.isKnowledgeCollectionRegistered(
          paranetId,
          knowledgeCollectionId,
        );
      expect(isRegistered).to.be.equal(true);

      // 13. Verify no more pending collections
      [pendingCollections, total] =
        await ParanetStagingRegistry.getPendingCollections(paranetId, 0, 10);
      expect(total).to.equal(0);
      expect(pendingCollections).to.have.lengthOf(0);
    });

    it('Should not allow approving a rejected knowledge collection', async () => {
      // 1. Setup paranet with staging policy
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0,
        0,
        1, // STAGING policy
      );

      // 2. Add paranet owner as curator
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetOwner.address,
      );

      // 3. Create and submit KC to paranet staging
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      // 4. Stage the Knowledge Collection
      await Paranet.connect(kcCreator).stageKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      const knowledgeCollectionId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256'],
          [await KnowledgeCollectionStorage.getAddress(), collectionId],
        ),
      );

      // 5. Reject the KC
      await Paranet.connect(paranetOwner).reviewKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
        false, // reject
      );

      // 6. Verify rejection status
      let status = await ParanetStagingRegistry.getKnowledgeCollectionStatus(
        paranetId,
        knowledgeCollectionId,
      );
      expect(status).to.equal(3); // Still REJECTED

      // 7. Try to approve the rejected KC (should fail)
      await expect(
        Paranet.connect(paranetOwner).reviewKnowledgeCollection(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          await KnowledgeCollectionStorage.getAddress(),
          collectionId,
          true, // try to approve
        ),
      ).to.be.revertedWith('Knowledge collection not staged');

      // 8. Verify status remains rejected
      status = await ParanetStagingRegistry.getKnowledgeCollectionStatus(
        paranetId,
        knowledgeCollectionId,
      );
      expect(status).to.equal(3); // Still REJECTED
    });

    it('Should revert when non-curator tries to review collection', async () => {
      // 1. Setup paranet with staging policy
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const curator = accounts[10];
      const nonCurator = accounts[11];

      const {
        paranetOwner,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0,
        0,
        1, // STAGING policy
      );

      // 2. Add curator
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        curator.address,
      );

      // 3. Create and submit KC to paranet staging
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(kcCreator).stageKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 4. Try to review with non-curator account
      await expect(
        Paranet.connect(nonCurator).reviewKnowledgeCollection(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          await KnowledgeCollectionStorage.getAddress(),
          collectionId,
          true, // approve
        ),
      ).to.be.revertedWith('Not authorized curator');
    });

    it('Should revert when reviewing already reviewed collection', async () => {
      // 1. Setup paranet with staging policy
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const curator = accounts[10];

      const {
        paranetOwner,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0,
        0,
        1, // STAGING policy
      );

      // 2. Add curator
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        curator.address,
      );

      // 3. Create and submit KC to paranet staging
      const { collectionId } = await createKnowledgeCollection(
        kcCreator,
        publishingNode,
        publishingNodeIdentityId,
        receivingNodes,
        receivingNodesIdentityIds,
        {
          KnowledgeCollection,
          Token,
        },
      );

      await Paranet.connect(kcCreator).stageKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
      );

      // 4. First review (approve)
      await Paranet.connect(curator).reviewKnowledgeCollection(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        await KnowledgeCollectionStorage.getAddress(),
        collectionId,
        false, // rejected
      );

      // 5. Try to review again
      await expect(
        Paranet.connect(curator).reviewKnowledgeCollection(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          await KnowledgeCollectionStorage.getAddress(),
          collectionId,
          true, // approve
        ),
      ).to.be.revertedWith('Knowledge collection not staged');
    });
  });

  describe('Paranet Curator Management', () => {
    it('Should add and remove a single curator', async () => {
      // Setup paranet
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const curator = accounts[10];

      const {
        paranetOwner,
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0,
        0,
        1, // STAGING policy
      );

      // Add curator
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        curator.address,
      );

      // Verify curator was added
      expect(
        await ParanetStagingRegistry.isCurator(paranetId, curator.address),
      ).to.be.equal(true);
      let curators =
        await ParanetStagingRegistry.getAllParanetCurators(paranetId);
      expect(curators).to.have.lengthOf(1);
      expect(curators[0]).to.equal(curator.address);

      // Remove curator
      await Paranet.connect(paranetOwner).removeCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        curator.address,
      );

      // Verify curator was removed
      expect(
        await ParanetStagingRegistry.isCurator(paranetId, curator.address),
      ).to.be.equal(false);
      curators = await ParanetStagingRegistry.getAllParanetCurators(paranetId);
      expect(curators).to.have.lengthOf(0);
    });

    it('Should handle multiple curators and removal of middle curator', async () => {
      // Setup paranet
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const curator1 = accounts[10];
      const curator2 = accounts[11];
      const curator3 = accounts[12];

      const {
        paranetOwner,
        paranetId,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0,
        0,
        1, // STAGING policy
      );

      // Add three curators
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        curator1.address,
      );
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        curator2.address,
      );
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        curator3.address,
      );

      // Verify all curators were added
      let curators =
        await ParanetStagingRegistry.getAllParanetCurators(paranetId);
      expect(curators).to.have.lengthOf(3);
      expect(curators).to.include(curator1.address);
      expect(curators).to.include(curator2.address);
      expect(curators).to.include(curator3.address);

      // Remove middle curator
      await Paranet.connect(paranetOwner).removeCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        curator2.address,
      );

      // Verify correct curator was removed and others remain
      expect(
        await ParanetStagingRegistry.isCurator(paranetId, curator1.address),
      ).to.be.equal(true);
      expect(
        await ParanetStagingRegistry.isCurator(paranetId, curator2.address),
      ).to.be.equal(false);
      expect(
        await ParanetStagingRegistry.isCurator(paranetId, curator3.address),
      ).to.be.equal(true);

      curators = await ParanetStagingRegistry.getAllParanetCurators(paranetId);
      expect(curators).to.have.lengthOf(2);
      expect(curators).to.include(curator1.address);
      expect(curators).to.include(curator3.address);
      expect(curators).to.not.include(curator2.address);
    });

    it('Should revert when adding curator to non-staging paranet', async () => {
      // Setup paranet with OPEN submission policy (0)
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const curator = accounts[10];

      const {
        paranetOwner,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0, // nodesAccessPolicy
        0, // minersAccessPolicy
        0, // OPEN submission policy
      );

      // Attempt to add curator - should fail
      await expect(
        Paranet.connect(paranetOwner).addCurator(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          curator.address,
        ),
      ).to.be.revertedWith('Paranet does not allow adding curators');
    });

    it('Should revert when adding same curator twice', async () => {
      // Setup paranet with staging policy
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const curator = accounts[10];

      const {
        paranetOwner,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0, // nodesAccessPolicy
        0, // minersAccessPolicy
        1, // STAGING policy
      );

      // Add curator first time
      await Paranet.connect(paranetOwner).addCurator(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        curator.address,
      );

      // Try to add same curator again - should fail
      await expect(
        Paranet.connect(paranetOwner).addCurator(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          curator.address,
        ),
      ).to.be.revertedWith('Existing curator');
    });

    it('Should revert when removing non-existent curator', async () => {
      // Setup paranet with staging policy
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const nonExistentCurator = accounts[10];

      const {
        paranetOwner,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
      } = await setupParanet(
        kcCreator,
        publishingNode,
        receivingNodes,
        {
          Paranet,
          Profile,
          Token,
          KnowledgeCollection,
          KnowledgeCollectionStorage,
        },
        'Test Paranet',
        'Test Paranet Description',
        0, // nodesAccessPolicy
        0, // minersAccessPolicy
        1, // STAGING policy
      );

      // Try to remove curator that was never added - should fail
      await expect(
        Paranet.connect(paranetOwner).removeCurator(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          nonExistentCurator.address,
        ),
      ).to.be.revertedWith('Address not a curator');
    });
  });

  describe('Paranet Service Registration', () => {
    it('Should register a paranet service successfully', async () => {
      // 1. Setup initial paranet
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        paranetId,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a new knowledge collection for the service
      const { collectionId: serviceCollectionId } =
        await createKnowledgeCollection(
          kcCreator,
          publishingNode,
          publishingNodeIdentityId,
          receivingNodes,
          receivingNodesIdentityIds,
          {
            KnowledgeCollection,
            Token,
          },
        );

      // 3. Setup service parameters
      const serviceName = 'Test Service';
      const serviceDescription = 'Test Service Description';
      const serviceAddresses = [accounts[10].address, accounts[11].address];

      // 4. Register the service
      const tx = await Paranet.connect(paranetOwner).registerParanetService(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1, // serviceKATokenId
        serviceName,
        serviceDescription,
        serviceAddresses,
      );

      // 5. Verify service registration
      const serviceId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256', 'uint256'],
          [
            await KnowledgeCollectionStorage.getAddress(),
            serviceCollectionId,
            1,
          ],
        ),
      );

      // Check if service exists
      const serviceExists =
        await ParanetServicesRegistry.paranetServiceExists(serviceId);
      expect(serviceExists).to.be.equal(true);

      // Verify service metadata
      const serviceMetadata =
        await ParanetServicesRegistry.getParanetServiceMetadata(serviceId);
      expect(serviceMetadata.name).to.equal(serviceName);
      expect(serviceMetadata.description).to.equal(serviceDescription);
      expect(serviceMetadata.paranetServiceAddresses).to.deep.equal(
        serviceAddresses,
      );
      expect(serviceMetadata.paranetServiceKCStorageContract).to.equal(
        await KnowledgeCollectionStorage.getAddress(),
      );
      expect(serviceMetadata.paranetServiceKCTokenId).to.equal(
        serviceCollectionId,
      );
      expect(serviceMetadata.paranetServiceKATokenId).to.equal(1);

      // Verify service addresses
      const registeredAddresses =
        await ParanetServicesRegistry.getParanetServiceAddresses(serviceId);
      expect(registeredAddresses).to.deep.equal(serviceAddresses);

      // Verify individual service addresses are registered
      for (const addr of serviceAddresses) {
        const isRegistered =
          await ParanetServicesRegistry.isParanetServiceAddressRegistered(
            serviceId,
            addr,
          );
        expect(isRegistered).to.be.equal(true);
      }

      // 6. Verify event emission
      await expect(tx)
        .to.emit(Paranet, 'ParanetServiceRegistered')
        .withArgs(
          await KnowledgeCollectionStorage.getAddress(),
          serviceCollectionId,
          1,
          serviceName,
          serviceDescription,
          serviceAddresses,
        );

      // 7. Add paranet service to paranet
      const addServiceTx = await Paranet.connect(
        paranetOwner,
      ).addParanetServices(
        paranetKCStorageContract,
        paranetKCTokenId,
        paranetKATokenId,
        [
          {
            knowledgeCollectionStorageContract:
              await KnowledgeCollectionStorage.getAddress(),
            knowledgeCollectionTokenId: serviceCollectionId,
            knowledgeAssetTokenId: 1,
          },
        ],
      );

      // Verify service is implemented in paranet
      const isImplemented = await ParanetsRegistry.isServiceImplemented(
        paranetId,
        serviceId,
      );
      expect(isImplemented).to.be.equal(true);

      // Verify paranet services list
      const paranetServices = await ParanetsRegistry.getServices(paranetId);
      expect(paranetServices).to.include(serviceId);
      expect(paranetServices).to.have.lengthOf(1);

      // Verify ParanetServiceAdded event
      await expect(addServiceTx)
        .to.emit(Paranet, 'ParanetServiceAdded')
        .withArgs(
          paranetKCStorageContract,
          paranetKCTokenId,
          paranetKATokenId,
          await KnowledgeCollectionStorage.getAddress(),
          serviceCollectionId,
          1,
        );
    });

    it('Should revert when trying to register the same paranet service twice', async () => {
      // 1. Setup initial paranet
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a new knowledge collection for the service
      const { collectionId: serviceCollectionId } =
        await createKnowledgeCollection(
          kcCreator,
          publishingNode,
          publishingNodeIdentityId,
          receivingNodes,
          receivingNodesIdentityIds,
          {
            KnowledgeCollection,
            Token,
          },
        );

      // 3. Setup service parameters
      const serviceName = 'Test Service';
      const serviceDescription = 'Test Service Description';
      const serviceAddresses = [accounts[10].address, accounts[11].address];

      // 4. Register the service first time
      await Paranet.connect(paranetOwner).registerParanetService(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1, // serviceKATokenId
        serviceName,
        serviceDescription,
        serviceAddresses,
      );

      // 5. Attempt to register the same service again
      await expect(
        Paranet.connect(paranetOwner).registerParanetService(
          await KnowledgeCollectionStorage.getAddress(),
          serviceCollectionId,
          1, // serviceKATokenId
          serviceName,
          serviceDescription,
          serviceAddresses,
        ),
      ).to.be.revertedWithCustomError(
        Paranet,
        'ParanetServiceHasAlreadyBeenRegistered',
      );
    });
  });

  describe('Paranet Service Metadata', () => {
    it('Should update paranet service metadata successfully', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a new knowledge collection for the service
      const { collectionId: serviceCollectionId } =
        await createKnowledgeCollection(
          kcCreator,
          publishingNode,
          publishingNodeIdentityId,
          receivingNodes,
          receivingNodesIdentityIds,
          {
            KnowledgeCollection,
            Token,
          },
        );

      // 3. Setup service parameters
      const serviceName = 'Test Service';
      const serviceDescription = 'Test Service Description';
      const serviceAddresses = [accounts[10].address, accounts[11].address];

      // 4. Register the service
      await Paranet.connect(paranetOwner).registerParanetService(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1, // serviceKATokenId
        serviceName,
        serviceDescription,
        serviceAddresses,
      );

      const serviceId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256', 'uint256'],
          [
            await KnowledgeCollectionStorage.getAddress(),
            serviceCollectionId,
            1,
          ],
        ),
      );

      const newName = 'New Service Name';
      const newDescription = 'New Service Description';
      const newServiceAddresses = [accounts[1].address, accounts[2].address];

      await Paranet.connect(paranetOwner).updateParanetServiceMetadata(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1,
        newName,
        newDescription,
        newServiceAddresses,
      );

      expect(await ParanetServicesRegistry.getName(serviceId)).to.equal(
        newName,
      );
      expect(await ParanetServicesRegistry.getDescription(serviceId)).to.equal(
        newDescription,
      );
      expect(
        await ParanetServicesRegistry.getParanetServiceAddresses(serviceId),
      ).to.deep.equal(newServiceAddresses);
    });

    it('Should emit ParanetServiceMetadataUpdated event with correct parameters', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a new knowledge collection for the service
      const { collectionId: serviceCollectionId } =
        await createKnowledgeCollection(
          kcCreator,
          publishingNode,
          publishingNodeIdentityId,
          receivingNodes,
          receivingNodesIdentityIds,
          {
            KnowledgeCollection,
            Token,
          },
        );

      // 3. Setup service parameters
      const serviceName = 'Test Service';
      const serviceDescription = 'Test Service Description';
      const serviceAddresses = [accounts[10].address, accounts[11].address];

      // 4. Register the service
      await Paranet.connect(paranetOwner).registerParanetService(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1, // serviceKATokenId
        serviceName,
        serviceDescription,
        serviceAddresses,
      );

      const newName = 'New Service Name';
      const newDescription = 'New Service Description';
      const newServiceAddresses = [accounts[1].address, accounts[2].address];

      await expect(
        Paranet.connect(paranetOwner).updateParanetServiceMetadata(
          await KnowledgeCollectionStorage.getAddress(),
          serviceCollectionId,
          1,
          newName,
          newDescription,
          newServiceAddresses,
        ),
      )
        .to.emit(Paranet, 'ParanetServiceMetadataUpdated')
        .withArgs(
          await KnowledgeCollectionStorage.getAddress(),
          serviceCollectionId,
          1,
          newName,
          newDescription,
          newServiceAddresses,
        );
    });

    it('Should handle empty strings and empty address array', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a new knowledge collection for the service
      const { collectionId: serviceCollectionId } =
        await createKnowledgeCollection(
          kcCreator,
          publishingNode,
          publishingNodeIdentityId,
          receivingNodes,
          receivingNodesIdentityIds,
          {
            KnowledgeCollection,
            Token,
          },
        );

      // 3. Setup service parameters
      const serviceName = 'Test Service';
      const serviceDescription = 'Test Service Description';
      const serviceAddresses = [accounts[10].address, accounts[11].address];

      // 4. Register the service
      await Paranet.connect(paranetOwner).registerParanetService(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1, // serviceKATokenId
        serviceName,
        serviceDescription,
        serviceAddresses,
      );

      const serviceId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256', 'uint256'],
          [
            await KnowledgeCollectionStorage.getAddress(),
            serviceCollectionId,
            1,
          ],
        ),
      );

      await Paranet.connect(paranetOwner).updateParanetServiceMetadata(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1,
        '',
        '',
        [],
      );

      expect(await ParanetServicesRegistry.getName(serviceId)).to.equal('');
      expect(await ParanetServicesRegistry.getDescription(serviceId)).to.equal(
        '',
      );
      expect(
        await ParanetServicesRegistry.getParanetServiceAddresses(serviceId),
      ).to.deep.equal([]);
    });

    it('Should handle very long name, description and large address array', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a new knowledge collection for the service
      const { collectionId: serviceCollectionId } =
        await createKnowledgeCollection(
          kcCreator,
          publishingNode,
          publishingNodeIdentityId,
          receivingNodes,
          receivingNodesIdentityIds,
          {
            KnowledgeCollection,
            Token,
          },
        );

      // 3. Setup service parameters
      const serviceName = 'Test Service';
      const serviceDescription = 'Test Service Description';
      const serviceAddresses = [accounts[10].address, accounts[11].address];

      // 4. Register the service
      await Paranet.connect(paranetOwner).registerParanetService(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1, // serviceKATokenId
        serviceName,
        serviceDescription,
        serviceAddresses,
      );

      const serviceId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256', 'uint256'],
          [
            await KnowledgeCollectionStorage.getAddress(),
            serviceCollectionId,
            1,
          ],
        ),
      );

      const longName = 'a'.repeat(100);
      const longDescription = 'b'.repeat(1000);
      const manyAddresses = accounts
        .slice(0, 20)
        .map((account) => account.address); // 20 addresses

      await Paranet.connect(paranetOwner).updateParanetServiceMetadata(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1,
        longName,
        longDescription,
        manyAddresses,
      );

      expect(await ParanetServicesRegistry.getName(serviceId)).to.equal(
        longName,
      );
      expect(await ParanetServicesRegistry.getDescription(serviceId)).to.equal(
        longDescription,
      );
      expect(
        await ParanetServicesRegistry.getParanetServiceAddresses(serviceId),
      ).to.deep.equal(manyAddresses);
    });

    it('Should allow multiple updates to the same service', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a new knowledge collection for the service
      const { collectionId: serviceCollectionId } =
        await createKnowledgeCollection(
          kcCreator,
          publishingNode,
          publishingNodeIdentityId,
          receivingNodes,
          receivingNodesIdentityIds,
          {
            KnowledgeCollection,
            Token,
          },
        );

      // 3. Setup service parameters
      const serviceName = 'Test Service';
      const serviceDescription = 'Test Service Description';
      const serviceAddresses = [accounts[10].address, accounts[11].address];

      // 4. Register the service
      await Paranet.connect(paranetOwner).registerParanetService(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1, // serviceKATokenId
        serviceName,
        serviceDescription,
        serviceAddresses,
      );

      const serviceId = ethers.keccak256(
        ethers.solidityPacked(
          ['address', 'uint256', 'uint256'],
          [
            await KnowledgeCollectionStorage.getAddress(),
            serviceCollectionId,
            1,
          ],
        ),
      );

      // First update
      await Paranet.connect(paranetOwner).updateParanetServiceMetadata(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1,
        'First Name',
        'First Description',
        [accounts[1].address],
      );

      // Second update
      await Paranet.connect(paranetOwner).updateParanetServiceMetadata(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1,
        'Second Name',
        'Second Description',
        [accounts[2].address, accounts[3].address],
      );

      expect(await ParanetServicesRegistry.getName(serviceId)).to.equal(
        'Second Name',
      );
      expect(await ParanetServicesRegistry.getDescription(serviceId)).to.equal(
        'Second Description',
      );
      expect(
        await ParanetServicesRegistry.getParanetServiceAddresses(serviceId),
      ).to.deep.equal([accounts[2].address, accounts[3].address]);
    });

    // Error cases
    it('Should revert when non-owner tries to update service metadata', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const nonOwner = accounts[10];

      const {
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a new knowledge collection for the service
      const { collectionId: serviceCollectionId } =
        await createKnowledgeCollection(
          kcCreator,
          publishingNode,
          publishingNodeIdentityId,
          receivingNodes,
          receivingNodesIdentityIds,
          {
            KnowledgeCollection,
            Token,
          },
        );

      // 3. Setup service parameters
      const serviceName = 'Test Service';
      const serviceDescription = 'Test Service Description';
      const serviceAddresses = [accounts[10].address, accounts[11].address];

      // 4. Register the service
      await Paranet.connect(paranetOwner).registerParanetService(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1, // serviceKATokenId
        serviceName,
        serviceDescription,
        serviceAddresses,
      );

      await expect(
        Paranet.connect(nonOwner).updateParanetServiceMetadata(
          await KnowledgeCollectionStorage.getAddress(),
          serviceCollectionId,
          1,
          'New Name',
          'New Description',
          [accounts[1].address],
        ),
      ).to.be.revertedWith('Caller not the owner of the KA');
    });

    it('Should revert when service does not exist', async () => {
      const kcCreator = getDefaultKCCreator(accounts);
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);

      const {
        paranetOwner,
        publishingNodeIdentityId,
        receivingNodesIdentityIds,
      } = await setupParanet(kcCreator, publishingNode, receivingNodes, {
        Paranet,
        Profile,
        Token,
        KnowledgeCollection,
        KnowledgeCollectionStorage,
      });

      // 2. Create a new knowledge collection for the service
      const { collectionId: serviceCollectionId } =
        await createKnowledgeCollection(
          kcCreator,
          publishingNode,
          publishingNodeIdentityId,
          receivingNodes,
          receivingNodesIdentityIds,
          {
            KnowledgeCollection,
            Token,
          },
        );

      // 3. Setup service parameters
      const serviceName = 'Test Service';
      const serviceDescription = 'Test Service Description';
      const serviceAddresses = [accounts[10].address, accounts[11].address];

      // 4. Register the service
      await Paranet.connect(paranetOwner).registerParanetService(
        await KnowledgeCollectionStorage.getAddress(),
        serviceCollectionId,
        1, // serviceKATokenId
        serviceName,
        serviceDescription,
        serviceAddresses,
      );

      await expect(
        Paranet.connect(kcCreator).updateParanetServiceMetadata(
          await KnowledgeCollectionStorage.getAddress(),
          serviceCollectionId,
          2, // different KA token ID than the one registered
          'New Name',
          'New Description',
          [accounts[1].address],
        ),
      )
        .to.be.revertedWithCustomError(ParanetLib, 'ParanetServiceDoesntExist')
        .withArgs(
          await KnowledgeCollectionStorage.getAddress(),
          serviceCollectionId,
          2,
        );
    });
  });

  // describe('Paranet Permissioned Miners', () => {
  //   it('Should allow owner to add and remove curated miners', async () => {
  //     // Setup paranet with permissioned miners policy
  //     const kcCreator = getDefaultKCCreator(accounts);
  //     const publishingNode = getDefaultPublishingNode(accounts);
  //     const receivingNodes = getDefaultReceivingNodes(accounts);
  //     const miner1 = accounts[10];
  //     const miner2 = accounts[11];

  //     const {
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       paranetId, // Add this to destructuring
  //     } = await setupParanet(
  //       kcCreator,
  //       publishingNode,
  //       receivingNodes,
  //       {
  //         Paranet,
  //         Profile,
  //         Token,
  //         KnowledgeCollection,
  //         KnowledgeCollectionStorage,
  //       },
  //       'Test Paranet',
  //       'Test Paranet Description',
  //       ACCESS_POLICIES.OPEN, // nodes policy
  //       1, // miners policy
  //       ACCESS_POLICIES.OPEN, // submission policy
  //     );

  //     // Verify initial state
  //     expect(
  //       await ParanetsRegistry.getKnowledgeMinersCount(paranetId),
  //     ).to.equal(0);
  //     expect(
  //       await ParanetsRegistry.isKnowledgeMinerRegistered(
  //         paranetId,
  //         miner1.address,
  //       ),
  //     ).to.be.equal(false);
  //     expect(
  //       await ParanetsRegistry.isKnowledgeMinerRegistered(
  //         paranetId,
  //         miner2.address,
  //       ),
  //     ).to.be.equal(false);

  //     // Add miners
  //     await expect(
  //       Paranet.connect(kcCreator).addParanetCuratedMiners(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         [miner1.address, miner2.address],
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedMinerAdded')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         miner1.address,
  //       )
  //       .to.emit(Paranet, 'ParanetCuratedMinerAdded')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         miner2.address,
  //       );

  //     // Verify miners were added
  //     expect(
  //       await ParanetsRegistry.getKnowledgeMinersCount(paranetId),
  //     ).to.equal(2);
  //     expect(
  //       await ParanetsRegistry.isKnowledgeMinerRegistered(
  //         paranetId,
  //         miner1.address,
  //       ),
  //     ).to.be.equal(true);
  //     expect(
  //       await ParanetsRegistry.isKnowledgeMinerRegistered(
  //         paranetId,
  //         miner2.address,
  //       ),
  //     ).to.be.equal(true);

  //     const registeredMiners =
  //       await ParanetsRegistry.getKnowledgeMiners(paranetId);
  //     expect(registeredMiners[0]).to.be.equal(miner1.address);
  //     expect(registeredMiners[1]).to.be.equal(miner2.address);

  //     // Remove miners
  //     await expect(
  //       Paranet.connect(kcCreator).removeParanetCuratedMiners(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         [miner1.address],
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedMinerRemoved')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         miner1.address,
  //       );

  //     // Verify miner1 was removed but miner2 remains
  //     expect(
  //       await ParanetsRegistry.getKnowledgeMinersCount(paranetId),
  //     ).to.equal(1);
  //     expect(
  //       await ParanetsRegistry.isKnowledgeMinerRegistered(
  //         paranetId,
  //         miner1.address,
  //       ),
  //     ).to.be.equal(false);
  //     expect(
  //       await ParanetsRegistry.isKnowledgeMinerRegistered(
  //         paranetId,
  //         miner2.address,
  //       ),
  //     ).to.be.equal(true);

  //     const remainingMiners =
  //       await ParanetsRegistry.getKnowledgeMiners(paranetId);
  //     expect(remainingMiners).to.have.lengthOf(1);
  //     expect(remainingMiners[0]).to.equal(miner2.address);
  //   });

  //   it('Should handle miner access requests correctly', async () => {
  //     // Setup paranet with permissioned miners policy
  //     const kcCreator = getDefaultKCCreator(accounts);
  //     const publishingNode = getDefaultPublishingNode(accounts);
  //     const receivingNodes = getDefaultReceivingNodes(accounts);
  //     const miner = accounts[10];

  //     const {
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       paranetId,
  //     } = await setupParanet(
  //       kcCreator,
  //       publishingNode,
  //       receivingNodes,
  //       {
  //         Paranet,
  //         Profile,
  //         Token,
  //         KnowledgeCollection,
  //         KnowledgeCollectionStorage,
  //       },
  //       'Test Paranet',
  //       'Test Paranet Description',
  //       ACCESS_POLICIES.OPEN, // nodes policy
  //       1, // miners policy
  //       ACCESS_POLICIES.OPEN, // submission policy
  //     );

  //     // Request access
  //     await expect(
  //       Paranet.connect(miner).requestParanetCuratedMinerAccess(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedMinerAccessRequestCreated')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         miner.address,
  //       );

  //     // Verify request state
  //     const latestRequest =
  //       await ParanetsRegistry.getLatestKnowledgeMinerAccessRequest(
  //         paranetId,
  //         miner.address,
  //       );
  //     expect(latestRequest.miner).to.equal(miner.address);
  //     expect(latestRequest.status).to.equal(1); // PENDING status
  //     expect(latestRequest.createdAt).to.be.gt(0);
  //     expect(latestRequest.updatedAt).to.equal(latestRequest.createdAt);

  //     // Approve request
  //     await expect(
  //       Paranet.connect(kcCreator).approveCuratedMiner(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         miner.address,
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedMinerAccessRequestAccepted')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         miner.address,
  //       )
  //       .to.emit(Paranet, 'ParanetCuratedMinerAdded')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         miner.address,
  //       );

  //     // Verify request state after approval
  //     const updatedRequest =
  //       await ParanetsRegistry.getLatestKnowledgeMinerAccessRequest(
  //         paranetId,
  //         miner.address,
  //       );
  //     expect(updatedRequest.miner).to.equal(miner.address);
  //     expect(updatedRequest.status).to.equal(2); // ACCEPTED status
  //     expect(updatedRequest.createdAt).to.equal(latestRequest.createdAt);
  //     expect(updatedRequest.updatedAt).to.be.gt(latestRequest.updatedAt);

  //     // Verify miner is now registered
  //     expect(
  //       await ParanetsRegistry.isKnowledgeMinerRegistered(
  //         paranetId,
  //         miner.address,
  //       ),
  //     ).to.be.equal(true);
  //   });

  //   it('Should handle miner access request rejection', async () => {
  //     // Setup paranet with permissioned miners policy
  //     const kcCreator = getDefaultKCCreator(accounts);
  //     const publishingNode = getDefaultPublishingNode(accounts);
  //     const receivingNodes = getDefaultReceivingNodes(accounts);
  //     const miner = accounts[10];

  //     const {
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       paranetId,
  //     } = await setupParanet(
  //       kcCreator,
  //       publishingNode,
  //       receivingNodes,
  //       {
  //         Paranet,
  //         Profile,
  //         Token,
  //         KnowledgeCollection,
  //         KnowledgeCollectionStorage,
  //       },
  //       'Test Paranet',
  //       'Test Paranet Description',
  //       ACCESS_POLICIES.OPEN, // nodes policy
  //       1, // miners policy
  //       ACCESS_POLICIES.OPEN, // submission policy
  //     );

  //     // Request access
  //     await Paranet.connect(miner).requestParanetCuratedMinerAccess(
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //     );

  //     // Verify initial request state
  //     const latestRequest =
  //       await ParanetsRegistry.getLatestKnowledgeMinerAccessRequest(
  //         paranetId,
  //         miner.address,
  //       );
  //     expect(latestRequest.miner).to.equal(miner.address);
  //     expect(latestRequest.status).to.equal(1); // PENDING status
  //     expect(latestRequest.createdAt).to.be.gt(0);
  //     expect(latestRequest.updatedAt).to.equal(latestRequest.createdAt);

  //     // Reject request
  //     await expect(
  //       Paranet.connect(kcCreator).rejectCuratedMiner(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         miner.address,
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedMinerAccessRequestRejected')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         miner.address,
  //       );

  //     // Verify request state after rejection
  //     const updatedRequest =
  //       await ParanetsRegistry.getLatestKnowledgeMinerAccessRequest(
  //         paranetId,
  //         miner.address,
  //       );
  //     expect(updatedRequest.miner).to.equal(miner.address);
  //     expect(updatedRequest.status).to.equal(3); // REJECTED status
  //     expect(updatedRequest.createdAt).to.equal(latestRequest.createdAt);
  //     expect(updatedRequest.updatedAt).to.be.gt(latestRequest.updatedAt);

  //     // Verify miner is not registered
  //     expect(
  //       await ParanetsRegistry.isKnowledgeMinerRegistered(
  //         paranetId,
  //         miner.address,
  //       ),
  //     ).to.be.equal(false);
  //   });

  //   it('Should revert when non-owner tries to add/remove miners', async () => {
  //     const kcCreator = getDefaultKCCreator(accounts);
  //     const publishingNode = getDefaultPublishingNode(accounts);
  //     const receivingNodes = getDefaultReceivingNodes(accounts);
  //     const miner = accounts[10];
  //     const nonOwner = accounts[11];

  //     const { paranetKCStorageContract, paranetKCTokenId, paranetKATokenId } =
  //       await setupParanet(
  //         kcCreator,
  //         publishingNode,
  //         receivingNodes,
  //         {
  //           Paranet,
  //           Profile,
  //           Token,
  //           KnowledgeCollection,
  //           KnowledgeCollectionStorage,
  //         },
  //         'Test Paranet',
  //         'Test Paranet Description',
  //         ACCESS_POLICIES.OPEN,
  //         1,
  //         ACCESS_POLICIES.OPEN,
  //       );

  //     // Try to add miner as non-owner
  //     await expect(
  //       Paranet.connect(nonOwner).addParanetCuratedMiners(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         [miner.address],
  //       ),
  //     ).to.be.revertedWith("Caller isn't the owner of the KA");

  //     // Try to remove miner as non-owner
  //     await expect(
  //       Paranet.connect(nonOwner).removeParanetCuratedMiners(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         [miner.address],
  //       ),
  //     ).to.be.revertedWith("Caller isn't the owner of the KA");
  //   });

  //   it('Should revert when requesting access multiple times', async () => {
  //     const kcCreator = getDefaultKCCreator(accounts);
  //     const publishingNode = getDefaultPublishingNode(accounts);
  //     const receivingNodes = getDefaultReceivingNodes(accounts);
  //     const miner = accounts[10];

  //     const { paranetKCStorageContract, paranetKCTokenId, paranetKATokenId } =
  //       await setupParanet(
  //         kcCreator,
  //         publishingNode,
  //         receivingNodes,
  //         {
  //           Paranet,
  //           Profile,
  //           Token,
  //           KnowledgeCollection,
  //           KnowledgeCollectionStorage,
  //         },
  //         'Test Paranet',
  //         'Test Paranet Description',
  //         ACCESS_POLICIES.OPEN,
  //         1,
  //         ACCESS_POLICIES.OPEN,
  //       );

  //     // First request
  //     await Paranet.connect(miner).requestParanetCuratedMinerAccess(
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //     );

  //     // Try to request again while first request is pending
  //     await expect(
  //       Paranet.connect(miner).requestParanetCuratedMinerAccess(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //       ),
  //     ).to.be.revertedWithCustomError(
  //       Paranet,
  //       'ParanetCuratedMinerAccessRequestInvalidStatus',
  //     );
  //   });

  //   it('Should allow registered miner to submit KC but reject unregistered miner', async () => {
  //     // Setup paranet with permissioned miners policy
  //     const kcCreator = getDefaultKCCreator(accounts);
  //     const publishingNode = getDefaultPublishingNode(accounts);
  //     const receivingNodes = getDefaultReceivingNodes(accounts);
  //     const miner1 = accounts[10];
  //     const miner2 = accounts[11];

  //     const {
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       paranetId,
  //       publishingNodeIdentityId,
  //       receivingNodesIdentityIds,
  //     } = await setupParanet(
  //       kcCreator,
  //       publishingNode,
  //       receivingNodes,
  //       {
  //         Paranet,
  //         Profile,
  //         Token,
  //         KnowledgeCollection,
  //         KnowledgeCollectionStorage,
  //       },
  //       'Test Paranet',
  //       'Test Paranet Description',
  //       ACCESS_POLICIES.OPEN, // nodes policy
  //       1, // miners policy - PERMISSIONED
  //       ACCESS_POLICIES.OPEN, // submission policy
  //     );

  //     // Add miner1 as a curated miner
  //     await Paranet.connect(kcCreator).addParanetCuratedMiners(
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       [miner1.address],
  //     );

  //     // Create KC for miner1
  //     const signaturesData1 = await getKCSignaturesData(
  //       publishingNode,
  //       1,
  //       receivingNodes,
  //     );
  //     const { collectionId: miner1CollectionId } =
  //       await createKnowledgeCollection(
  //         miner1, // Using miner1 as KC creator
  //         publishingNodeIdentityId,
  //         receivingNodesIdentityIds,
  //         signaturesData1,
  //         {
  //           KnowledgeCollection: KnowledgeCollection,
  //           Token: Token,
  //         },
  //       );

  //     // Create KC for miner2
  //     const signaturesData2 = await getKCSignaturesData(
  //       publishingNode,
  //       1,
  //       receivingNodes,
  //     );
  //     const { collectionId: miner2CollectionId } =
  //       await createKnowledgeCollection(
  //         miner2, // Using miner2 as KC creator
  //         publishingNodeIdentityId,
  //         receivingNodesIdentityIds,
  //         signaturesData2,
  //         {
  //           KnowledgeCollection: KnowledgeCollection,
  //           Token: Token,
  //         },
  //       );

  //     // Miner1 (registered) submits KC - should succeed
  //     await expect(
  //       Paranet.connect(miner1).submitKnowledgeCollection(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         await KnowledgeCollectionStorage.getAddress(),
  //         miner1CollectionId,
  //       ),
  //     )
  //       .to.emit(Paranet, 'KnowledgeCollectionSubmittedToParanet')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         await KnowledgeCollectionStorage.getAddress(),
  //         miner1CollectionId,
  //       );

  //     // Verify miner1's KC was added
  //     const miner1CollectionBytes = ethers.keccak256(
  //       ethers.solidityPacked(
  //         ['address', 'uint256'],
  //         [await KnowledgeCollectionStorage.getAddress(), miner1CollectionId],
  //       ),
  //     );

  //     expect(
  //       await ParanetsRegistry.isKnowledgeCollectionRegistered(
  //         paranetId,
  //         miner1CollectionBytes,
  //       ),
  //     ).to.be.equal(true);

  //     // Miner2 (unregistered) attempts to submit KC - should fail
  //     await expect(
  //       Paranet.connect(miner2).submitKnowledgeCollection(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         await KnowledgeCollectionStorage.getAddress(),
  //         miner2CollectionId,
  //       ),
  //     ).to.be.revertedWith('Miner is not registered');

  //     // Verify miner2's KC was not added

  //     const miner2CollectionBytes = ethers.keccak256(
  //       ethers.solidityPacked(
  //         ['address', 'uint256'],
  //         [await KnowledgeCollectionStorage.getAddress(), miner2CollectionId],
  //       ),
  //     );
  //     expect(
  //       await ParanetsRegistry.isKnowledgeCollectionRegistered(
  //         paranetId,
  //         miner2CollectionBytes,
  //       ),
  //     ).to.be.equal(false);

  //     // Verify total KC count is 1 (only miner1's KC)
  //     expect(
  //       await ParanetsRegistry.getKnowledgeCollectionsCount(paranetId),
  //     ).to.equal(1);
  //   });
  // });

  // describe('Paranet Permissioned Nodes', () => {
  //   it('Should allow owner to add and remove curated nodes', async () => {
  //     // Setup paranet with permissioned nodes policy
  //     const kcCreator = getDefaultKCCreator(accounts);
  //     const publishingNode = getDefaultPublishingNode(accounts);
  //     const receivingNodes = getDefaultReceivingNodes(accounts);
  //     const node1 = accounts[10];
  //     const node2 = accounts[11];

  //     // Create profiles for test nodes
  //     await Profile.connect(node1).createProfile(
  //       accounts[0].address,
  //       [], // operational wallets
  //       'Node1',
  //       '0x' + randomBytes(32).toString('hex'),
  //       0,
  //     );
  //     await Profile.connect(node2).createProfile(
  //       accounts[0].address,
  //       [], // operational wallets
  //       'Node2',
  //       '0x' + randomBytes(32).toString('hex'),
  //       0,
  //     );
  //     const node1IdentityId = await IdentityStorage.getIdentityId(
  //       node1.address,
  //     );
  //     const node2IdentityId = await IdentityStorage.getIdentityId(
  //       node2.address,
  //     );

  //     const {
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       paranetId,
  //     } = await setupParanet(
  //       kcCreator,
  //       publishingNode,
  //       receivingNodes,
  //       {
  //         Paranet,
  //         Profile,
  //         Token,
  //         KnowledgeCollection,
  //         KnowledgeCollectionStorage,
  //       },
  //       'Test Paranet',
  //       'Test Paranet Description',
  //       1, // NODES_ACCESS_POLICY_PERMISSIONED
  //       ACCESS_POLICIES.OPEN,
  //       ACCESS_POLICIES.OPEN,
  //     );

  //     // Verify initial state
  //     expect(await ParanetsRegistry.getCuratedNodesCount(paranetId)).to.equal(
  //       0,
  //     );
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, node1IdentityId),
  //     ).to.be.equal(false);
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, node2IdentityId),
  //     ).to.be.equal(false);

  //     // Add nodes
  //     await expect(
  //       Paranet.connect(kcCreator).addParanetCuratedNodes(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         [node1IdentityId, node2IdentityId],
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedNodeAdded')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         node1IdentityId,
  //       )
  //       .to.emit(Paranet, 'ParanetCuratedNodeAdded')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         node2IdentityId,
  //       );

  //     // Verify nodes were added
  //     expect(await ParanetsRegistry.getCuratedNodesCount(paranetId)).to.equal(
  //       2,
  //     );
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, node1IdentityId),
  //     ).to.be.equal(true);
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, node2IdentityId),
  //     ).to.be.equal(true);

  //     const curatedNodes = await ParanetsRegistry.getCuratedNodes(paranetId);
  //     expect(curatedNodes[0].identityId).to.equal(node1IdentityId);
  //     expect(curatedNodes[1].identityId).to.equal(node2IdentityId);

  //     // Remove node1
  //     await expect(
  //       Paranet.connect(kcCreator).removeParanetCuratedNodes(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         [node1IdentityId],
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedNodeRemoved')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         node1IdentityId,
  //       );

  //     // Verify node1 was removed but node2 remains
  //     expect(await ParanetsRegistry.getCuratedNodesCount(paranetId)).to.equal(
  //       1,
  //     );
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, node1IdentityId),
  //     ).to.be.equal(false);
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, node2IdentityId),
  //     ).to.be.equal(true);

  //     const remainingNodes = await ParanetsRegistry.getCuratedNodes(paranetId);
  //     expect(remainingNodes).to.have.lengthOf(1);
  //     expect(remainingNodes[0].identityId).to.equal(node2IdentityId);
  //   });

  //   it('Should handle node join requests correctly', async () => {
  //     // Setup paranet with permissioned nodes policy
  //     const kcCreator = getDefaultKCCreator(accounts);
  //     const publishingNode = getDefaultPublishingNode(accounts);
  //     const receivingNodes = getDefaultReceivingNodes(accounts);
  //     const applicantNode = accounts[10];

  //     // Create profile for applicant node
  //     await Profile.connect(applicantNode).createProfile(
  //       accounts[0].address,
  //       [], // operational wallets
  //       'Applicant',
  //       '0x' + randomBytes(32).toString('hex'),
  //       0,
  //     );
  //     const applicantIdentityId = await IdentityStorage.getIdentityId(
  //       applicantNode.address,
  //     );

  //     const {
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       paranetId,
  //     } = await setupParanet(
  //       kcCreator,
  //       publishingNode,
  //       receivingNodes,
  //       {
  //         Paranet,
  //         Profile,
  //         Token,
  //         KnowledgeCollection,
  //         KnowledgeCollectionStorage,
  //       },
  //       'Test Paranet',
  //       'Test Paranet Description',
  //       1, // NODES_ACCESS_POLICY_PERMISSIONED
  //       ACCESS_POLICIES.OPEN,
  //       ACCESS_POLICIES.OPEN,
  //     );

  //     // Request to join
  //     await expect(
  //       Paranet.connect(applicantNode).requestParanetCuratedNodeAccess(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedNodeJoinRequestCreated')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         applicantIdentityId,
  //       );

  //     // Verify initial request state
  //     const latestRequest = await ParanetsRegistry.getLatestNodeJoinRequest(
  //       paranetId,
  //       applicantIdentityId,
  //     );
  //     expect(latestRequest.identityId).to.equal(applicantIdentityId);
  //     expect(latestRequest.status).to.equal(1); // PENDING status
  //     expect(latestRequest.createdAt).to.be.gt(0);
  //     expect(latestRequest.updatedAt).to.equal(latestRequest.createdAt);

  //     // Approve request
  //     await expect(
  //       Paranet.connect(kcCreator).approveCuratedNode(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         applicantIdentityId,
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedNodeJoinRequestAccepted')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         applicantIdentityId,
  //       )
  //       .to.emit(Paranet, 'ParanetCuratedNodeAdded')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         applicantIdentityId,
  //       );

  //     // Verify request state after approval
  //     const updatedRequest = await ParanetsRegistry.getLatestNodeJoinRequest(
  //       paranetId,
  //       applicantIdentityId,
  //     );
  //     expect(updatedRequest.identityId).to.equal(applicantIdentityId);
  //     expect(updatedRequest.status).to.equal(2); // ACCEPTED status
  //     expect(updatedRequest.createdAt).to.equal(latestRequest.createdAt);
  //     expect(updatedRequest.updatedAt).to.be.gt(latestRequest.updatedAt);

  //     // Verify node is now registered
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, applicantIdentityId),
  //     ).to.be.equal(true);
  //   });

  //   it('Should handle node join request rejection correctly', async () => {
  //     // Setup paranet with permissioned nodes policy
  //     const kcCreator = getDefaultKCCreator(accounts);
  //     const publishingNode = getDefaultPublishingNode(accounts);
  //     const receivingNodes = getDefaultReceivingNodes(accounts);
  //     const applicantNode = accounts[10];

  //     // Create profile for applicant node
  //     await Profile.connect(applicantNode).createProfile(
  //       accounts[0].address,
  //       [], // operational wallets
  //       'Applicant',
  //       '0x' + randomBytes(32).toString('hex'),
  //       0,
  //     );
  //     const applicantIdentityId = await IdentityStorage.getIdentityId(
  //       applicantNode.address,
  //     );

  //     const {
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       paranetId,
  //     } = await setupParanet(
  //       kcCreator,
  //       publishingNode,
  //       receivingNodes,
  //       {
  //         Paranet,
  //         Profile,
  //         Token,
  //         KnowledgeCollection,
  //         KnowledgeCollectionStorage,
  //       },
  //       'Test Paranet',
  //       'Test Paranet Description',
  //       1, // NODES_ACCESS_POLICY_PERMISSIONED
  //       ACCESS_POLICIES.OPEN,
  //       ACCESS_POLICIES.OPEN,
  //     );

  //     // Request to join
  //     await expect(
  //       Paranet.connect(applicantNode).requestParanetCuratedNodeAccess(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedNodeJoinRequestCreated')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         applicantIdentityId,
  //       );

  //     // Verify initial request state
  //     const latestRequest = await ParanetsRegistry.getLatestNodeJoinRequest(
  //       paranetId,
  //       applicantIdentityId,
  //     );
  //     expect(latestRequest.identityId).to.equal(applicantIdentityId);
  //     expect(latestRequest.status).to.equal(1); // PENDING status

  //     // Reject request
  //     await expect(
  //       Paranet.connect(kcCreator).rejectCuratedNode(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         applicantIdentityId,
  //       ),
  //     )
  //       .to.emit(Paranet, 'ParanetCuratedNodeJoinRequestRejected')
  //       .withArgs(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         applicantIdentityId,
  //       );

  //     // Verify request state after rejection
  //     const updatedRequest = await ParanetsRegistry.getLatestNodeJoinRequest(
  //       paranetId,
  //       applicantIdentityId,
  //     );
  //     expect(updatedRequest.identityId).to.equal(applicantIdentityId);
  //     expect(updatedRequest.status).to.equal(3); // REJECTED status
  //     expect(updatedRequest.createdAt).to.equal(latestRequest.createdAt);
  //     expect(updatedRequest.updatedAt).to.be.gt(latestRequest.updatedAt);

  //     // Verify node is not registered
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, applicantIdentityId),
  //     ).to.be.equal(false);
  //   });

  //   it('Should handle edge cases when adding and removing multiple nodes', async () => {
  //     const kcCreator = getDefaultKCCreator(accounts);
  //     const publishingNode = getDefaultPublishingNode(accounts);
  //     const receivingNodes = getDefaultReceivingNodes(accounts);
  //     const node1 = accounts[10];
  //     const node2 = accounts[11];
  //     const node3 = accounts[12];

  //     // Create profiles for test nodes
  //     await Profile.connect(node1).createProfile(
  //       accounts[0].address,
  //       [], // operational wallets
  //       'Node1',
  //       '0x' + randomBytes(32).toString('hex'),
  //       0,
  //     );
  //     await Profile.connect(node2).createProfile(
  //       accounts[0].address,
  //       [], // operational wallets
  //       'Node2',
  //       '0x' + randomBytes(32).toString('hex'),
  //       0,
  //     );
  //     await Profile.connect(node3).createProfile(
  //       accounts[0].address,
  //       [], // operational wallets
  //       'Node3',
  //       '0x' + randomBytes(32).toString('hex'),
  //       0,
  //     );
  //     const node1IdentityId = await IdentityStorage.getIdentityId(
  //       node1.address,
  //     );
  //     const node2IdentityId = await IdentityStorage.getIdentityId(
  //       node2.address,
  //     );
  //     const node3IdentityId = await IdentityStorage.getIdentityId(
  //       node3.address,
  //     );

  //     const {
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       paranetId,
  //     } = await setupParanet(
  //       kcCreator,
  //       publishingNode,
  //       receivingNodes,
  //       {
  //         Paranet,
  //         Profile,
  //         Token,
  //         KnowledgeCollection,
  //         KnowledgeCollectionStorage,
  //       },
  //       'Test Paranet',
  //       'Test Paranet Description',
  //       1, // NODES_ACCESS_POLICY_PERMISSIONED
  //       ACCESS_POLICIES.OPEN,
  //       ACCESS_POLICIES.OPEN,
  //     );

  //     // Add nodes in sequence
  //     await Paranet.connect(kcCreator).addParanetCuratedNodes(
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       [node1IdentityId],
  //     );

  //     await Paranet.connect(kcCreator).addParanetCuratedNodes(
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       [node2IdentityId, node3IdentityId],
  //     );

  //     // Verify all nodes were added
  //     expect(await ParanetsRegistry.getCuratedNodesCount(paranetId)).to.equal(
  //       3,
  //     );
  //     const allNodes = await ParanetsRegistry.getCuratedNodes(paranetId);
  //     expect(allNodes.map((node) => node.identityId)).to.have.members([
  //       node1IdentityId,
  //       node2IdentityId,
  //       node3IdentityId,
  //     ]);

  //     // Remove nodes from edges (first and last)
  //     await Paranet.connect(kcCreator).removeParanetCuratedNodes(
  //       paranetKCStorageContract,
  //       paranetKCTokenId,
  //       paranetKATokenId,
  //       [node1IdentityId, node3IdentityId],
  //     );

  //     // Verify middle node remains
  //     expect(await ParanetsRegistry.getCuratedNodesCount(paranetId)).to.equal(
  //       1,
  //     );
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, node1IdentityId),
  //     ).to.be.equal(false);
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, node2IdentityId),
  //     ).to.be.equal(true);
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, node3IdentityId),
  //     ).to.be.equal(false);

  //     // Try to remove non-existent node - should revert
  //     await expect(
  //       Paranet.connect(kcCreator).removeParanetCuratedNodes(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         [node1IdentityId], // Already removed
  //       ),
  //     ).to.be.revertedWithCustomError(Paranet, 'ParanetCuratedNodeDoesntExist');

  //     // Verify state remains unchanged
  //     expect(await ParanetsRegistry.getCuratedNodesCount(paranetId)).to.equal(
  //       1,
  //     );
  //     expect(
  //       await ParanetsRegistry.isCuratedNode(paranetId, node2IdentityId),
  //     ).to.be.equal(true);

  //     // Try to add duplicate node
  //     await expect(
  //       Paranet.connect(kcCreator).addParanetCuratedNodes(
  //         paranetKCStorageContract,
  //         paranetKCTokenId,
  //         paranetKATokenId,
  //         [node2IdentityId],
  //       ),
  //     ).to.be.revertedWithCustomError(
  //       Paranet,
  //       'ParanetCuratedNodeHasAlreadyBeenAdded',
  //     );

  //     expect(await ParanetsRegistry.getCuratedNodesCount(paranetId)).to.equal(
  //       1,
  //     );
  //     const finalNodes = await ParanetsRegistry.getCuratedNodes(paranetId);
  //     expect(finalNodes).to.have.lengthOf(1);
  //     expect(finalNodes[0].identityId).to.equal(node2IdentityId);
  //   });
  // });
});
