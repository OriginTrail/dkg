import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  ContextGraphs,
  ContextGraphStorage,
  IdentityStorage,
  KnowledgeAssetsStorage,
  Profile,
  Hub,
} from '../../typechain';
import { createProfile } from '../helpers/profile-helpers';

type ContextGraphFixture = {
  accounts: SignerWithAddress[];
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
  IdentityStorage: IdentityStorage;
  KnowledgeAssetsStorage: KnowledgeAssetsStorage;
  Profile: Profile;
  Hub: Hub;
};

describe('@unit ContextGraphs', () => {
  let accounts: SignerWithAddress[];
  let ContextGraphsContract: ContextGraphs;
  let ContextGraphStorageContract: ContextGraphStorage;
  let KnowledgeAssetsStorageContract: KnowledgeAssetsStorage;
  let ProfileContract: Profile;
  let HubContract: Hub;

  async function deployContextGraphFixture(): Promise<ContextGraphFixture> {
    await hre.deployments.fixture([
      'ContextGraphs',
      'ContextGraphStorage',
      'KnowledgeAssetsStorage',
      'Profile',
      'Identity',
    ]);

    const signers = await hre.ethers.getSigners();
    const ContextGraphs = await hre.ethers.getContract<ContextGraphs>('ContextGraphs');
    const ContextGraphStorage = await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage');
    const IdentityStorage = await hre.ethers.getContract<IdentityStorage>('IdentityStorage');
    const KnowledgeAssetsStorage = await hre.ethers.getContract<KnowledgeAssetsStorage>('KnowledgeAssetsStorage');
    const Profile = await hre.ethers.getContract<Profile>('Profile');
    const Hub = await hre.ethers.getContract<Hub>('Hub');

    await Hub.setContractAddress('TestBatchHelper', signers[19].address);

    return { accounts: signers, ContextGraphs, ContextGraphStorage, IdentityStorage, KnowledgeAssetsStorage, Profile, Hub };
  }

  async function createBatchWithRoot(merkleRoot: string, publisher: string): Promise<bigint> {
    await KnowledgeAssetsStorageContract.connect(accounts[19]).createKnowledgeBatch(
      publisher, merkleRoot, 1000, 10, 1, 10, 1, 100, 0, false,
    );
    return KnowledgeAssetsStorageContract.getLatestBatchId();
  }

  beforeEach(async () => {
    const f = await loadFixture(deployContextGraphFixture);
    accounts = f.accounts;
    ContextGraphsContract = f.ContextGraphs;
    ContextGraphStorageContract = f.ContextGraphStorage;
    KnowledgeAssetsStorageContract = f.KnowledgeAssetsStorage;
    ProfileContract = f.Profile;
    HubContract = f.Hub;
  });

  describe('createContextGraph (ERC-721)', () => {
    it('mints an ERC-721 token to msg.sender', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      expect(await ContextGraphStorageContract.ownerOf(1)).to.equal(accounts[0].address);
      expect(await ContextGraphStorageContract.balanceOf(accounts[0].address)).to.equal(1);
    });

    it('creates a context graph with correct data', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      const cg = await ContextGraphStorageContract.getContextGraph(1);
      expect(cg.owner_).to.equal(accounts[0].address);
      expect(cg.participantIdentityIds).to.deep.equal([BigInt(identityId)]);
      expect(cg.requiredSignatures).to.equal(1);
      expect(cg.active).to.be.true;
      expect(cg.publishPolicy).to.equal(1);
    });

    it('creates a curated CG with publishAuthority', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);
      const curator = accounts[5].address;

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 0, curator,
      );

      const cg = await ContextGraphStorageContract.getContextGraph(1);
      expect(cg.publishPolicy).to.equal(0);
      expect(cg.publishAuthority).to.equal(curator);
    });

    it('defaults publishAuthority to msg.sender when zero address', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 0, ethers.ZeroAddress,
      );

      const cg = await ContextGraphStorageContract.getContextGraph(1);
      expect(cg.publishAuthority).to.equal(accounts[0].address);
    });

    it('emits ContextGraphCreated event', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await expect(
        ContextGraphsContract.connect(accounts[0]).createContextGraph(
          [identityId], 1, 0, 1, ethers.ZeroAddress,
        ),
      ).to.emit(ContextGraphStorageContract, 'ContextGraphCreated');
    });

    it('reverts with empty participants', async () => {
      await expect(
        ContextGraphsContract.connect(accounts[0]).createContextGraph(
          [], 1, 0, 1, ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(
        ContextGraphStorageContract, 'InvalidContextGraphConfig',
      );
    });

    it('reverts with invalid M/N threshold (M > N)', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await expect(
        ContextGraphsContract.connect(accounts[0]).createContextGraph(
          [identityId], 2, 0, 1, ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(
        ContextGraphStorageContract, 'InvalidContextGraphConfig',
      );
    });

    it('reverts with invalid publishPolicy', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await expect(
        ContextGraphsContract.connect(accounts[0]).createContextGraph(
          [identityId], 1, 0, 2, ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(
        ContextGraphStorageContract, 'InvalidContextGraphConfig',
      );
    });

    it('assigns incrementing IDs', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );
      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      expect(await ContextGraphStorageContract.getLatestContextGraphId()).to.equal(2);
      expect(await ContextGraphStorageContract.ownerOf(1)).to.equal(accounts[0].address);
      expect(await ContextGraphStorageContract.ownerOf(2)).to.equal(accounts[0].address);
    });
  });

  describe('ERC-721 governance transfer', () => {
    it('transferring the token transfers management authority', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      expect(await ContextGraphStorageContract.getContextGraphOwner(1)).to.equal(accounts[0].address);

      await ContextGraphStorageContract.connect(accounts[0]).transferFrom(
        accounts[0].address, accounts[7].address, 1,
      );

      expect(await ContextGraphStorageContract.getContextGraphOwner(1)).to.equal(accounts[7].address);

      // Old owner can no longer update publish policy
      await expect(
        ContextGraphsContract.connect(accounts[0]).updatePublishPolicy(1, 0, accounts[0].address),
      ).to.be.revertedWithCustomError(
        ContextGraphsContract, 'NotContextGraphOwner',
      );

      // New owner can update publish policy
      await ContextGraphsContract.connect(accounts[7]).updatePublishPolicy(1, 0, accounts[7].address);
      const policy = await ContextGraphStorageContract.getPublishPolicy(1);
      expect(policy.publishPolicy).to.equal(0);
      expect(policy.publishAuthority).to.equal(accounts[7].address);
    });
  });

  describe('governance: addParticipant / removeParticipant / updateQuorum', () => {
    let identityId1: bigint;
    let identityId2: bigint;

    beforeEach(async () => {
      const node1 = { operational: accounts[1], admin: accounts[2] };
      const node2 = { operational: accounts[3], admin: accounts[4] };
      const p1 = await createProfile(ProfileContract, node1);
      const p2 = await createProfile(ProfileContract, node2);
      identityId1 = BigInt(p1.identityId);
      identityId2 = BigInt(p2.identityId);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [p1.identityId], 1, 0, 1, ethers.ZeroAddress,
      );
    });

    it('addParticipant adds a new participant', async () => {
      await ContextGraphsContract.connect(accounts[0]).addParticipant(1, identityId2);
      const participants = await ContextGraphStorageContract.getContextGraphParticipants(1);
      expect(participants).to.deep.equal([identityId1, identityId2]);
    });

    it('addParticipant emits ParticipantAdded', async () => {
      await expect(
        ContextGraphsContract.connect(accounts[0]).addParticipant(1, identityId2),
      ).to.emit(ContextGraphStorageContract, 'ParticipantAdded').withArgs(1, identityId2);
    });

    it('addParticipant reverts for duplicate', async () => {
      await expect(
        ContextGraphsContract.connect(accounts[0]).addParticipant(1, identityId1),
      ).to.be.revertedWithCustomError(
        ContextGraphStorageContract, 'ParticipantAlreadyExists',
      );
    });

    it('addParticipant reverts for non-owner', async () => {
      await expect(
        ContextGraphsContract.connect(accounts[5]).addParticipant(1, identityId2),
      ).to.be.revertedWithCustomError(
        ContextGraphsContract, 'NotContextGraphOwner',
      );
    });

    it('removeParticipant removes an existing participant', async () => {
      await ContextGraphsContract.connect(accounts[0]).addParticipant(1, identityId2);
      await ContextGraphsContract.connect(accounts[0]).updateQuorum(1, 1);
      await ContextGraphsContract.connect(accounts[0]).removeParticipant(1, identityId1);

      const participants = await ContextGraphStorageContract.getContextGraphParticipants(1);
      expect(participants).to.deep.equal([identityId2]);
    });

    it('removeParticipant emits ParticipantRemoved', async () => {
      await ContextGraphsContract.connect(accounts[0]).addParticipant(1, identityId2);
      await expect(
        ContextGraphsContract.connect(accounts[0]).removeParticipant(1, identityId1),
      ).to.emit(ContextGraphStorageContract, 'ParticipantRemoved').withArgs(1, identityId1);
    });

    it('removeParticipant reverts if it would break quorum', async () => {
      await expect(
        ContextGraphsContract.connect(accounts[0]).removeParticipant(1, identityId1),
      ).to.be.revertedWithCustomError(
        ContextGraphStorageContract, 'InvalidContextGraphConfig',
      );
    });

    it('removeParticipant reverts for unknown participant', async () => {
      await ContextGraphsContract.connect(accounts[0]).addParticipant(1, identityId2);
      const fakeId = 9999n;
      await expect(
        ContextGraphsContract.connect(accounts[0]).removeParticipant(1, fakeId),
      ).to.be.revertedWithCustomError(
        ContextGraphStorageContract, 'ParticipantNotFound',
      );
    });

    it('updateQuorum changes the threshold', async () => {
      await ContextGraphsContract.connect(accounts[0]).addParticipant(1, identityId2);
      await ContextGraphsContract.connect(accounts[0]).updateQuorum(1, 2);

      expect(await ContextGraphStorageContract.getContextGraphRequiredSignatures(1)).to.equal(2);
    });

    it('updateQuorum emits QuorumUpdated', async () => {
      await ContextGraphsContract.connect(accounts[0]).addParticipant(1, identityId2);
      await expect(
        ContextGraphsContract.connect(accounts[0]).updateQuorum(1, 2),
      ).to.emit(ContextGraphStorageContract, 'QuorumUpdated').withArgs(1, 2);
    });

    it('updateQuorum reverts if M > N', async () => {
      await expect(
        ContextGraphsContract.connect(accounts[0]).updateQuorum(1, 5),
      ).to.be.revertedWithCustomError(
        ContextGraphStorageContract, 'InvalidContextGraphConfig',
      );
    });

    it('updateQuorum reverts for non-owner', async () => {
      await expect(
        ContextGraphsContract.connect(accounts[5]).updateQuorum(1, 1),
      ).to.be.revertedWithCustomError(
        ContextGraphsContract, 'NotContextGraphOwner',
      );
    });
  });

  describe('isAuthorizedPublisher', () => {
    it('returns true for any publisher on open CG', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      expect(await ContextGraphsContract.isAuthorizedPublisher(1, accounts[9].address)).to.be.true;
    });

    it('returns true for publishAuthority on curated CG', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 0, accounts[5].address,
      );

      expect(await ContextGraphsContract.isAuthorizedPublisher(1, accounts[5].address)).to.be.true;
    });

    it('returns false for non-authority on curated CG', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 0, accounts[5].address,
      );

      expect(await ContextGraphsContract.isAuthorizedPublisher(1, accounts[9].address)).to.be.false;
    });
  });

  describe('updatePublishPolicy', () => {
    it('owner can update publish policy', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      await ContextGraphsContract.connect(accounts[0]).updatePublishPolicy(1, 0, accounts[0].address);
      const policy = await ContextGraphStorageContract.getPublishPolicy(1);
      expect(policy.publishPolicy).to.equal(0);
      expect(policy.publishAuthority).to.equal(accounts[0].address);
    });

    it('emits PublishPolicyUpdated', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      await expect(
        ContextGraphsContract.connect(accounts[0]).updatePublishPolicy(1, 0, accounts[0].address),
      ).to.emit(ContextGraphStorageContract, 'PublishPolicyUpdated');
    });

    it('non-owner cannot update publish policy', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      await expect(
        ContextGraphsContract.connect(accounts[5]).updatePublishPolicy(1, 0, accounts[5].address),
      ).to.be.revertedWithCustomError(
        ContextGraphsContract, 'NotContextGraphOwner',
      );
    });
  });

  describe('addBatchToContextGraph', () => {
    it('adds a batch with valid M/N signatures', async () => {
      const signer = accounts[3];
      const admin = accounts[4];
      const node = { operational: signer, admin };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );
      const contextGraphId = 1n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('test-root'));
      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);

      const digest = ethers.solidityPackedKeccak256(
        ['uint256', 'bytes32'],
        [contextGraphId, merkleRoot],
      );

      const signerSigner = await hre.ethers.getSigner(signer.address);
      const rawSig = await signerSigner.signMessage(ethers.getBytes(digest));
      const sig = ethers.Signature.from(rawSig);

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId, batchId, merkleRoot,
          [identityId], [sig.r], [sig.yParityAndS],
        ),
      ).to.emit(ContextGraphStorageContract, 'ContextGraphExpanded')
        .withArgs(contextGraphId, batchId);

      const batches = await ContextGraphStorageContract.getContextGraphBatches(contextGraphId);
      expect(batches).to.deep.equal([batchId]);
    });

    it('reverts with not enough signatures', async () => {
      const node1 = { operational: accounts[3], admin: accounts[4] };
      const node2 = { operational: accounts[5], admin: accounts[6] };
      const p1 = await createProfile(ProfileContract, node1);
      const p2 = await createProfile(ProfileContract, node2);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [p1.identityId, p2.identityId], 2, 0, 1, ethers.ZeroAddress,
      );

      const contextGraphId = 1n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('test-root'));
      const digest = ethers.solidityPackedKeccak256(
        ['uint256', 'bytes32'],
        [contextGraphId, merkleRoot],
      );

      const rawSig = await (await hre.ethers.getSigner(accounts[3].address)).signMessage(ethers.getBytes(digest));
      const sig = ethers.Signature.from(rawSig);

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId, 42n, merkleRoot,
          [p1.identityId], [sig.r], [sig.yParityAndS],
        ),
      ).to.be.revertedWith('Not enough signatures');
    });

    it('rejects duplicate batch registration', async () => {
      const signer = accounts[3];
      const node = { operational: signer, admin: accounts[4] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );
      const contextGraphId = await ContextGraphStorageContract.getLatestContextGraphId();
      const merkleRoot = hre.ethers.keccak256(hre.ethers.toUtf8Bytes('replay-root'));
      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);

      const digest = ethers.solidityPackedKeccak256(
        ['uint256', 'bytes32'],
        [contextGraphId, merkleRoot],
      );
      const sig = ethers.Signature.from(await signer.signMessage(ethers.getBytes(digest)));

      await ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
        contextGraphId, batchId, merkleRoot,
        [identityId], [sig.r], [sig.yParityAndS],
      );

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId, batchId, merkleRoot,
          [identityId], [sig.r], [sig.yParityAndS],
        ),
      ).to.be.revertedWith('Batch already registered');
    });
  });

  describe('deactivation', () => {
    it('rejects addBatch to deactivated context graph', async () => {
      const signer = accounts[3];
      const node = { operational: signer, admin: accounts[4] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );
      const contextGraphId = 1n;

      expect(await ContextGraphStorageContract.isContextGraphActive(contextGraphId)).to.be.true;

      await ContextGraphStorageContract.connect(accounts[19]).deactivateContextGraph(contextGraphId);
      expect(await ContextGraphStorageContract.isContextGraphActive(contextGraphId)).to.be.false;

      const merkleRoot = hre.ethers.keccak256(hre.ethers.toUtf8Bytes('deact-root'));
      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);
      const digest = hre.ethers.solidityPackedKeccak256(
        ['uint256', 'bytes32'],
        [contextGraphId, merkleRoot],
      );
      const sig = ethers.Signature.from(await signer.signMessage(ethers.getBytes(digest)));

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId, batchId, merkleRoot,
          [identityId], [sig.r], [sig.yParityAndS],
        ),
      ).to.be.revertedWithCustomError(ContextGraphsContract, 'ContextGraphNotActive');
    });
  });

  describe('regression: isAuthorizedPublisher rejects deactivated CGs', () => {
    it('returns false for a deactivated CG (even if policy is open)', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );
      expect(await ContextGraphsContract.isAuthorizedPublisher(1, accounts[9].address)).to.be.true;

      await ContextGraphStorageContract.connect(accounts[19]).deactivateContextGraph(1);
      expect(await ContextGraphsContract.isAuthorizedPublisher(1, accounts[9].address)).to.be.false;
    });
  });

  describe('regression: addBatchToContextGraph enforces publishPolicy', () => {
    it('rejects batch from non-authority on curated CG', async () => {
      const signer = accounts[3];
      const node = { operational: signer, admin: accounts[4] };
      const { identityId } = await createProfile(ProfileContract, node);
      const curator = accounts[5].address;

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 0, curator,
      );
      const cgId = 1n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('curated-root'));
      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);
      const digest = ethers.solidityPackedKeccak256(['uint256', 'bytes32'], [cgId, merkleRoot]);
      const sig = ethers.Signature.from(await signer.signMessage(ethers.getBytes(digest)));

      // Non-curator caller should be rejected
      await expect(
        ContextGraphsContract.connect(accounts[9]).addBatchToContextGraph(
          cgId, batchId, merkleRoot, [identityId], [sig.r], [sig.yParityAndS],
        ),
      ).to.be.revertedWith('Unauthorized: curated CG');
    });

    it('allows batch from authority on curated CG', async () => {
      const signer = accounts[3];
      const node = { operational: signer, admin: accounts[4] };
      const { identityId } = await createProfile(ProfileContract, node);
      const curator = accounts[5];

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 0, curator.address,
      );
      const cgId = 1n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('curated-ok'));
      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);
      const digest = ethers.solidityPackedKeccak256(['uint256', 'bytes32'], [cgId, merkleRoot]);
      const sig = ethers.Signature.from(await signer.signMessage(ethers.getBytes(digest)));

      await expect(
        ContextGraphsContract.connect(curator).addBatchToContextGraph(
          cgId, batchId, merkleRoot, [identityId], [sig.r], [sig.yParityAndS],
        ),
      ).to.emit(ContextGraphStorageContract, 'ContextGraphExpanded');
    });
  });

  describe('regression: addParticipant maintains sorted order', () => {
    it('inserts participants in ascending order', async () => {
      const node1 = { operational: accounts[1], admin: accounts[2] };
      const node2 = { operational: accounts[3], admin: accounts[4] };
      const node3 = { operational: accounts[5], admin: accounts[6] };
      const p1 = await createProfile(ProfileContract, node1);
      const p2 = await createProfile(ProfileContract, node2);
      const p3 = await createProfile(ProfileContract, node3);

      // Create CG with just node2 (middle identity)
      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [p2.identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      // Add node3 (higher), then node1 (lower)
      await ContextGraphsContract.connect(accounts[0]).addParticipant(1, BigInt(p3.identityId));
      await ContextGraphsContract.connect(accounts[0]).addParticipant(1, BigInt(p1.identityId));

      const participants = await ContextGraphStorageContract.getContextGraphParticipants(1);
      const ids = participants.map(Number);
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).to.be.greaterThan(ids[i - 1]);
      }
    });

    it('removeParticipant preserves sorted order (no swap-pop)', async () => {
      const nodes = [
        { operational: accounts[1], admin: accounts[2] },
        { operational: accounts[3], admin: accounts[4] },
        { operational: accounts[5], admin: accounts[6] },
      ];
      const profiles = [];
      for (const n of nodes) {
        profiles.push(await createProfile(ProfileContract, n));
      }
      const ids = profiles.map(p => p.identityId);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        ids, 1, 0, 1, ethers.ZeroAddress,
      );

      // Remove the first participant (lowest ID)
      await ContextGraphsContract.connect(accounts[0]).removeParticipant(1, BigInt(ids[0]));

      const remaining = await ContextGraphStorageContract.getContextGraphParticipants(1);
      const remainingIds = remaining.map(Number);
      for (let i = 1; i < remainingIds.length; i++) {
        expect(remainingIds[i]).to.be.greaterThan(remainingIds[i - 1]);
      }
    });
  });

  describe('regression: addParticipant rejects identityId 0', () => {
    it('reverts when adding identity ID 0', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      await expect(
        ContextGraphsContract.connect(accounts[0]).addParticipant(1, 0n),
      ).to.be.revertedWith('Identity ID cannot be zero');
    });
  });

  describe('ERC-721 enumeration', () => {
    it('totalSupply and tokenByIndex work', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );
      await ContextGraphsContract.connect(accounts[8]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      expect(await ContextGraphStorageContract.totalSupply()).to.equal(2);
      expect(await ContextGraphStorageContract.tokenByIndex(0)).to.equal(1);
      expect(await ContextGraphStorageContract.tokenByIndex(1)).to.equal(2);
    });

    it('tokenOfOwnerByIndex works', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );
      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId], 1, 0, 1, ethers.ZeroAddress,
      );

      expect(await ContextGraphStorageContract.tokenOfOwnerByIndex(accounts[0].address, 0)).to.equal(1);
      expect(await ContextGraphStorageContract.tokenOfOwnerByIndex(accounts[0].address, 1)).to.equal(2);
    });
  });
});
