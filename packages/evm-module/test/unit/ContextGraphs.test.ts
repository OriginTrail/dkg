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

  describe('createContextGraph', () => {
    it('creates a context graph and assigns an incrementing ID', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      const tx = await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId],
        1,
        0,
      );
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      const cg = await ContextGraphStorageContract.getContextGraph(1);
      expect(cg.manager).to.equal(accounts[0].address);
      expect(cg.participantIdentityIds).to.deep.equal([BigInt(identityId)]);
      expect(cg.requiredSignatures).to.equal(1);
      expect(cg.active).to.be.true;
    });

    it('emits ContextGraphCreated event', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await expect(
        ContextGraphsContract.connect(accounts[0]).createContextGraph([identityId], 1, 0),
      ).to.emit(ContextGraphStorageContract, 'ContextGraphCreated');
    });

    it('reverts with empty participants', async () => {
      await expect(
        ContextGraphsContract.connect(accounts[0]).createContextGraph([], 1, 0),
      ).to.be.revertedWithCustomError(
        ContextGraphStorageContract,
        'InvalidContextGraphConfig',
      );
    });

    it('reverts with invalid M/N threshold (M > N)', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await expect(
        ContextGraphsContract.connect(accounts[0]).createContextGraph([identityId], 2, 0),
      ).to.be.revertedWithCustomError(
        ContextGraphStorageContract,
        'InvalidContextGraphConfig',
      );
    });

    it('reverts with M = 0', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await expect(
        ContextGraphsContract.connect(accounts[0]).createContextGraph([identityId], 0, 0),
      ).to.be.revertedWithCustomError(
        ContextGraphStorageContract,
        'InvalidContextGraphConfig',
      );
    });

    it('assigns incrementing IDs to multiple context graphs', async () => {
      const node = { operational: accounts[1], admin: accounts[2] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph([identityId], 1, 0);
      await ContextGraphsContract.connect(accounts[0]).createContextGraph([identityId], 1, 0);

      const latest = await ContextGraphStorageContract.getLatestContextGraphId();
      expect(latest).to.equal(2);
    });
  });

  describe('addBatchToContextGraph', () => {
    it('adds a batch with valid M/N signatures over (contextGraphId, merkleRoot)', async () => {
      const signer = accounts[3];
      const admin = accounts[4];
      const node = { operational: signer, admin };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId],
        1,
        0,
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
          contextGraphId,
          batchId,
          merkleRoot,
          [identityId],
          [sig.r],
          [sig.yParityAndS],
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
        [p1.identityId, p2.identityId],
        2,
        0,
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
          contextGraphId,
          42n,
          merkleRoot,
          [p1.identityId],
          [sig.r],
          [sig.yParityAndS],
        ),
      ).to.be.revertedWith('Not enough signatures');
    });

    it('reverts with array length mismatch', async () => {
      const node1 = { operational: accounts[3], admin: accounts[4] };
      const node2 = { operational: accounts[5], admin: accounts[6] };
      const p1 = await createProfile(ProfileContract, node1);
      const p2 = await createProfile(ProfileContract, node2);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [p1.identityId, p2.identityId],
        2,
        0,
      );

      const contextGraphId = 1n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('test-root'));
      const digest = ethers.solidityPackedKeccak256(
        ['uint256', 'bytes32'],
        [contextGraphId, merkleRoot],
      );

      const rawSig1 = await (await hre.ethers.getSigner(accounts[3].address)).signMessage(ethers.getBytes(digest));
      const sig1 = ethers.Signature.from(rawSig1);
      const rawSig2 = await (await hre.ethers.getSigner(accounts[5].address)).signMessage(ethers.getBytes(digest));
      const sig2 = ethers.Signature.from(rawSig2);

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId,
          42n,
          merkleRoot,
          [p1.identityId, p2.identityId],
          [sig1.r, sig2.r],
          [sig1.yParityAndS],
        ),
      ).to.be.revertedWith('Array length mismatch');
    });

    it('reverts when signer is not a participant', async () => {
      const node1 = { operational: accounts[3], admin: accounts[4] };
      const node2 = { operational: accounts[5], admin: accounts[6] };
      const p1 = await createProfile(ProfileContract, node1);
      await createProfile(ProfileContract, node2);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [p1.identityId],
        1,
        0,
      );

      const contextGraphId = 1n;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('test-root'));
      const digest = ethers.solidityPackedKeccak256(
        ['uint256', 'bytes32'],
        [contextGraphId, merkleRoot],
      );

      // Sign with node2 but claim to be node1's identity
      const rawSig = await (await hre.ethers.getSigner(accounts[5].address)).signMessage(ethers.getBytes(digest));
      const sig = ethers.Signature.from(rawSig);

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId,
          42n,
          merkleRoot,
          [p1.identityId],
          [sig.r],
          [sig.yParityAndS],
        ),
      ).to.be.revertedWith('Invalid signature');
    });
  });

  describe('deactivation', () => {
    it('rejects addBatch to deactivated context graph', async () => {
      const signer = accounts[3];
      const node = { operational: signer, admin: accounts[4] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId],
        1,
        0,
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
          contextGraphId,
          batchId,
          merkleRoot,
          [identityId],
          [sig.r],
          [sig.yParityAndS],
        ),
      ).to.be.revertedWithCustomError(ContextGraphStorageContract, 'ContextGraphNotActive');
    });
  });

  describe('regression: review feedback fixes', () => {
    it('rejects zero participant ID in createContextGraph', async () => {
      const node = { operational: accounts[3], admin: accounts[4] };
      const { identityId } = await createProfile(ProfileContract, node);

      await expect(
        ContextGraphsContract.connect(accounts[0]).createContextGraph(
          [identityId, 0],
          1,
          0,
        ),
      ).to.be.revertedWith('Zero participant ID');
    });

    it('rejects phantom batchId (non-existent batch returns zero merkle root)', async () => {
      const signer = accounts[3];
      const node = { operational: signer, admin: accounts[4] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId],
        1,
        0,
      );
      const contextGraphId = await ContextGraphStorageContract.getLatestContextGraphId();

      const nonExistentBatchId = 99999n;
      const merkleRoot = ethers.ZeroHash;
      const digest = ethers.solidityPackedKeccak256(
        ['uint256', 'bytes32'],
        [contextGraphId, merkleRoot],
      );
      const sig = ethers.Signature.from(
        await signer.signMessage(ethers.getBytes(digest)),
      );

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId,
          nonExistentBatchId,
          merkleRoot,
          [identityId],
          [sig.r],
          [sig.yParityAndS],
        ),
      ).to.be.revertedWith('Batch does not exist');
    });

    it('rejects duplicate batch registration (replay protection)', async () => {
      const signer = accounts[3];
      const node = { operational: signer, admin: accounts[4] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId],
        1,
        0,
      );
      const contextGraphId = await ContextGraphStorageContract.getLatestContextGraphId();

      const merkleRoot = hre.ethers.keccak256(hre.ethers.toUtf8Bytes('replay-root'));
      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);

      const digest = ethers.solidityPackedKeccak256(
        ['uint256', 'bytes32'],
        [contextGraphId, merkleRoot],
      );
      const sig = ethers.Signature.from(
        await signer.signMessage(ethers.getBytes(digest)),
      );

      await ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
        contextGraphId,
        batchId,
        merkleRoot,
        [identityId],
        [sig.r],
        [sig.yParityAndS],
      );

      await expect(
        ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
          contextGraphId,
          batchId,
          merkleRoot,
          [identityId],
          [sig.r],
          [sig.yParityAndS],
        ),
      ).to.be.revertedWith('Batch already registered');
    });

    it('persists attested merkle root on registration', async () => {
      const signer = accounts[3];
      const node = { operational: signer, admin: accounts[4] };
      const { identityId } = await createProfile(ProfileContract, node);

      await ContextGraphsContract.connect(accounts[0]).createContextGraph(
        [identityId],
        1,
        0,
      );
      const contextGraphId = await ContextGraphStorageContract.getLatestContextGraphId();
      const merkleRoot = hre.ethers.keccak256(hre.ethers.toUtf8Bytes('attested-root'));
      const batchId = await createBatchWithRoot(merkleRoot, accounts[0].address);

      const digest = ethers.solidityPackedKeccak256(
        ['uint256', 'bytes32'],
        [contextGraphId, merkleRoot],
      );
      const sig = ethers.Signature.from(
        await signer.signMessage(ethers.getBytes(digest)),
      );

      await ContextGraphsContract.connect(accounts[0]).addBatchToContextGraph(
        contextGraphId,
        batchId,
        merkleRoot,
        [identityId],
        [sig.r],
        [sig.yParityAndS],
      );

      const attested = await ContextGraphsContract.getAttestedMerkleRoot(contextGraphId, batchId);
      expect(attested).to.equal(merkleRoot);
    });

    it('rejects duplicate participant IDs in createContextGraph', async () => {
      const node = { operational: accounts[3], admin: accounts[4] };
      const { identityId } = await createProfile(ProfileContract, node);

      await expect(
        ContextGraphsContract.connect(accounts[0]).createContextGraph(
          [identityId, identityId],
          2,
          0,
        ),
      ).to.be.revertedWith('Duplicate or unsorted participant');
    });
  });
});
