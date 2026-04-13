import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { ContextGraphStorage, Hub } from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  ContextGraphStorage: ContextGraphStorage;
};

/**
 * Direct unit tests for the ContextGraphStorage contract — Phase 7 Task 1.
 *
 * These tests bypass the ContextGraphs facade and call storage methods directly
 * by registering an EOA as a "Hub contract" so it can satisfy `onlyContracts`.
 * They cover the new APIs introduced in this task:
 *   - createContextGraph (split hosting nodes / participant agents + PCA accountId)
 *   - setHostingNodes / addParticipantAgent / removeParticipantAgent
 *   - registerKCToContextGraph + kcToContextGraph reverse lookup
 *   - updatePublishAuthority with PCA accountId
 *   - NFT auto-rotation clears PCA accountId on transfer
 */
describe('@unit ContextGraphStorage', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let StorageContract: ContextGraphStorage;
  // Sentinel signer registered as a Hub contract so it can call onlyContracts methods.
  let opSigner: SignerWithAddress;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture(['ContextGraphStorage']);
    const accounts = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    const ContextGraphStorage = await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage');
    // Register accounts[19] as a "TestStorageOperator" Hub contract so it can
    // call onlyContracts methods on the storage directly.
    await Hub.setContractAddress('TestStorageOperator', accounts[19].address);
    return { accounts, Hub, ContextGraphStorage };
  }

  beforeEach(async () => {
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    HubContract = f.Hub;
    StorageContract = f.ContextGraphStorage;
    opSigner = accounts[19];
  });

  // -------------------------------------------------------------------------
  // createContextGraph: new 8-arg signature with split lists + PCA accountId
  // -------------------------------------------------------------------------
  describe('createContextGraph (new signature)', () => {
    const baseHostingNodes = (): bigint[] => [10n, 20n, 30n];
    const baseAgents = (): string[] => [];

    it('mints an ERC-721 to owner_ and stores all fields', async () => {
      const owner = accounts[1].address;
      const authority = accounts[2].address;
      const tx = await StorageContract.connect(opSigner).createContextGraph(
        owner,
        baseHostingNodes(),
        baseAgents(),
        2,           // requiredSignatures
        42,          // metadataBatchId
        0,           // publishPolicy = curated
        authority,   // publishAuthority
        0,           // publishAuthorityAccountId = non-PCA
      );
      await tx.wait();

      const cgId = 1n;
      expect(await StorageContract.ownerOf(cgId)).to.equal(owner);
      expect(await StorageContract.getContextGraphOwner(cgId)).to.equal(owner);
      expect(await StorageContract.getContextGraphRequiredSignatures(cgId)).to.equal(2);
      expect(await StorageContract.isContextGraphActive(cgId)).to.be.true;

      const hostingNodes = await StorageContract.getHostingNodes(cgId);
      expect(hostingNodes).to.deep.equal(baseHostingNodes());

      const agents = await StorageContract.getParticipantAgents(cgId);
      expect(agents).to.deep.equal([]);

      const policy = await StorageContract.getPublishPolicy(cgId);
      expect(policy.publishPolicy).to.equal(0);
      expect(policy.publishAuthority).to.equal(authority);
      expect(await StorageContract.getPublishAuthorityAccountId(cgId)).to.equal(0);
    });

    it('emits ContextGraphCreated with split lists and accountId', async () => {
      const owner = accounts[1].address;
      const authority = accounts[2].address;
      const hosts = baseHostingNodes();
      const agents: string[] = [accounts[3].address, accounts[4].address];
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          owner, hosts, agents, 2, 7, 0, authority, 99,
        ),
      )
        .to.emit(StorageContract, 'ContextGraphCreated')
        .withArgs(1, owner, hosts, agents, 2, 7, 0, authority, 99);
    });

    it('stores publishAuthorityAccountId for PCA curator type', async () => {
      const owner = accounts[1].address;
      const authority = accounts[2].address;
      await StorageContract.connect(opSigner).createContextGraph(
        owner, baseHostingNodes(), baseAgents(), 1, 0, 0, authority, 555,
      );
      expect(await StorageContract.getPublishAuthorityAccountId(1)).to.equal(555);
    });

    it('reverts when caller is not a Hub contract', async () => {
      await expect(
        StorageContract.connect(accounts[5]).createContextGraph(
          accounts[1].address, baseHostingNodes(), baseAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(HubContract, 'UnauthorizedAccess');
    });

    it('reverts on zero address owner', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          ethers.ZeroAddress, baseHostingNodes(), baseAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on empty hosting nodes', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address, [], baseAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on unsorted hosting nodes', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address, [30n, 10n, 20n], baseAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on duplicate hosting nodes', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address, [10n, 10n, 20n], baseAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on zero hosting node identity ID', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address, [0n, 10n], baseAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on zero participant agent address', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address,
          baseHostingNodes(),
          [accounts[3].address, ethers.ZeroAddress],
          1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on duplicate participant agent', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address,
          baseHostingNodes(),
          [accounts[3].address, accounts[3].address],
          1, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'AgentParticipantAlreadyExists');
    });

    it('reverts when requiredSignatures > hosting nodes length', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address, [10n, 20n], baseAgents(), 3, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts when requiredSignatures == 0', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address, baseHostingNodes(), baseAgents(), 0, 0, 1, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on invalid publishPolicy (>1)', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address, baseHostingNodes(), baseAgents(), 1, 0, 2, accounts[2].address, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on curated policy with zero publishAuthority', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address, baseHostingNodes(), baseAgents(), 1, 0, 0, ethers.ZeroAddress, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on PCA accountId for open policy', async () => {
      // PCA only meaningful with curated policy
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address, baseHostingNodes(), baseAgents(), 1, 0, 1, ethers.ZeroAddress, 99,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('rejects open policy with non-zero publishAuthority (strict mode)', async () => {
      await expect(
        StorageContract.connect(opSigner).createContextGraph(
          accounts[1].address, baseHostingNodes(), baseAgents(), 1, 0, 1, accounts[2].address, 0,
        ),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('open policy with zero authority + zero accountId stores empty curator', async () => {
      await StorageContract.connect(opSigner).createContextGraph(
        accounts[1].address, baseHostingNodes(), baseAgents(), 1, 0, 1, ethers.ZeroAddress, 0,
      );
      const policy = await StorageContract.getPublishPolicy(1);
      expect(policy.publishPolicy).to.equal(1);
      expect(policy.publishAuthority).to.equal(ethers.ZeroAddress);
      expect(await StorageContract.getPublishAuthorityAccountId(1)).to.equal(0);
    });
  });

  // -------------------------------------------------------------------------
  // setHostingNodes: full replace
  // -------------------------------------------------------------------------
  describe('setHostingNodes', () => {
    beforeEach(async () => {
      await StorageContract.connect(opSigner).createContextGraph(
        accounts[0].address, [10n, 20n, 30n], [], 2, 0, 1, ethers.ZeroAddress, 0,
      );
    });

    it('replaces hosting nodes and emits HostingNodesSet', async () => {
      const newNodes = [5n, 15n, 25n, 35n];
      await expect(
        StorageContract.connect(opSigner).setHostingNodes(1, newNodes),
      ).to.emit(StorageContract, 'HostingNodesSet').withArgs(1, newNodes);
      expect(await StorageContract.getHostingNodes(1)).to.deep.equal(newNodes);
    });

    it('reverts when caller is not a Hub contract', async () => {
      await expect(
        StorageContract.connect(accounts[5]).setHostingNodes(1, [99n]),
      ).to.be.revertedWithCustomError(HubContract, 'UnauthorizedAccess');
    });

    it('reverts on empty list', async () => {
      await expect(
        StorageContract.connect(opSigner).setHostingNodes(1, []),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on unsorted list', async () => {
      await expect(
        StorageContract.connect(opSigner).setHostingNodes(1, [30n, 10n, 20n]),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on duplicate', async () => {
      await expect(
        StorageContract.connect(opSigner).setHostingNodes(1, [10n, 10n]),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on zero ID', async () => {
      await expect(
        StorageContract.connect(opSigner).setHostingNodes(1, [0n, 10n]),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts when new size would break quorum', async () => {
      // CG has requiredSignatures=2, replacing with 1 node breaks the quorum
      await expect(
        StorageContract.connect(opSigner).setHostingNodes(1, [42n]),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts for nonexistent CG', async () => {
      await expect(
        StorageContract.connect(opSigner).setHostingNodes(999, [1n]),
      ).to.be.reverted;
    });

    it('isHostingNode reflects updated set', async () => {
      await StorageContract.connect(opSigner).setHostingNodes(1, [5n, 15n]);
      expect(await StorageContract.isHostingNode(1, 5n)).to.be.true;
      expect(await StorageContract.isHostingNode(1, 15n)).to.be.true;
      expect(await StorageContract.isHostingNode(1, 10n)).to.be.false; // gone
    });
  });

  // -------------------------------------------------------------------------
  // addParticipantAgent / removeParticipantAgent
  // -------------------------------------------------------------------------
  describe('addParticipantAgent / removeParticipantAgent', () => {
    let agent1: string;
    let agent2: string;
    let agent3: string;

    beforeEach(async () => {
      await StorageContract.connect(opSigner).createContextGraph(
        accounts[0].address, [10n, 20n], [], 1, 0, 1, ethers.ZeroAddress, 0,
      );
      agent1 = accounts[3].address;
      agent2 = accounts[4].address;
      agent3 = accounts[5].address;
    });

    it('adds a participant agent and emits AgentParticipantAdded', async () => {
      await expect(
        StorageContract.connect(opSigner).addParticipantAgent(1, agent1),
      ).to.emit(StorageContract, 'AgentParticipantAdded').withArgs(1, agent1);
      expect(await StorageContract.getParticipantAgents(1)).to.deep.equal([agent1]);
      expect(await StorageContract.isParticipantAgent(1, agent1)).to.be.true;
    });

    it('preserves insertion order', async () => {
      await StorageContract.connect(opSigner).addParticipantAgent(1, agent2);
      await StorageContract.connect(opSigner).addParticipantAgent(1, agent1);
      await StorageContract.connect(opSigner).addParticipantAgent(1, agent3);
      expect(await StorageContract.getParticipantAgents(1)).to.deep.equal([agent2, agent1, agent3]);
    });

    it('reverts on duplicate agent (AgentParticipantAlreadyExists)', async () => {
      await StorageContract.connect(opSigner).addParticipantAgent(1, agent1);
      await expect(
        StorageContract.connect(opSigner).addParticipantAgent(1, agent1),
      ).to.be.revertedWithCustomError(StorageContract, 'AgentParticipantAlreadyExists');
    });

    it('reverts on zero address agent', async () => {
      await expect(
        StorageContract.connect(opSigner).addParticipantAgent(1, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts when caller is not a Hub contract', async () => {
      await expect(
        StorageContract.connect(accounts[6]).addParticipantAgent(1, agent1),
      ).to.be.revertedWithCustomError(HubContract, 'UnauthorizedAccess');
    });

    it('removeParticipantAgent removes preserving order (no swap-pop)', async () => {
      await StorageContract.connect(opSigner).addParticipantAgent(1, agent1);
      await StorageContract.connect(opSigner).addParticipantAgent(1, agent2);
      await StorageContract.connect(opSigner).addParticipantAgent(1, agent3);

      await expect(
        StorageContract.connect(opSigner).removeParticipantAgent(1, agent2),
      ).to.emit(StorageContract, 'AgentParticipantRemoved').withArgs(1, agent2);

      expect(await StorageContract.getParticipantAgents(1)).to.deep.equal([agent1, agent3]);
      expect(await StorageContract.isParticipantAgent(1, agent2)).to.be.false;
    });

    it('removeParticipantAgent reverts on missing agent (AgentParticipantNotFound)', async () => {
      await expect(
        StorageContract.connect(opSigner).removeParticipantAgent(1, agent1),
      ).to.be.revertedWithCustomError(StorageContract, 'AgentParticipantNotFound');
    });
  });

  // -------------------------------------------------------------------------
  // KC <-> ContextGraph registration
  // -------------------------------------------------------------------------
  describe('registerKCToContextGraph', () => {
    beforeEach(async () => {
      await StorageContract.connect(opSigner).createContextGraph(
        accounts[0].address, [10n], [], 1, 0, 1, ethers.ZeroAddress, 0,
      );
    });

    it('records reverse lookup, KC list, and emits event', async () => {
      await expect(
        StorageContract.connect(opSigner).registerKCToContextGraph(1, 100),
      ).to.emit(StorageContract, 'KCRegisteredToContextGraph').withArgs(1, 100);

      expect(await StorageContract.kcToContextGraph(100)).to.equal(1);
      expect(await StorageContract.getContextGraphKCList(1)).to.deep.equal([100n]);
      expect(await StorageContract.getContextGraphKCCount(1)).to.equal(1);
    });

    it('appends multiple KCs in registration order', async () => {
      await StorageContract.connect(opSigner).registerKCToContextGraph(1, 100);
      await StorageContract.connect(opSigner).registerKCToContextGraph(1, 200);
      await StorageContract.connect(opSigner).registerKCToContextGraph(1, 300);
      expect(await StorageContract.getContextGraphKCList(1)).to.deep.equal([100n, 200n, 300n]);
      expect(await StorageContract.getContextGraphKCCount(1)).to.equal(3);
    });

    it('reverts on double registration (KCAlreadyRegisteredToContextGraph)', async () => {
      await StorageContract.connect(opSigner).registerKCToContextGraph(1, 100);
      // Create a second CG and try to register the same KC there
      await StorageContract.connect(opSigner).createContextGraph(
        accounts[0].address, [10n], [], 1, 0, 1, ethers.ZeroAddress, 0,
      );
      await expect(
        StorageContract.connect(opSigner).registerKCToContextGraph(2, 100),
      ).to.be.revertedWithCustomError(StorageContract, 'KCAlreadyRegisteredToContextGraph');
    });

    it('reverts when target CG is inactive', async () => {
      await StorageContract.connect(opSigner).deactivateContextGraph(1);
      await expect(
        StorageContract.connect(opSigner).registerKCToContextGraph(1, 100),
      ).to.be.revertedWithCustomError(StorageContract, 'ContextGraphNotActive');
    });

    it('reverts on kcId == 0', async () => {
      await expect(
        StorageContract.connect(opSigner).registerKCToContextGraph(1, 0),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts when caller is not a Hub contract', async () => {
      await expect(
        StorageContract.connect(accounts[5]).registerKCToContextGraph(1, 100),
      ).to.be.revertedWithCustomError(HubContract, 'UnauthorizedAccess');
    });
  });

  // -------------------------------------------------------------------------
  // updatePublishAuthority — new accountId-aware update
  // -------------------------------------------------------------------------
  describe('updatePublishAuthority', () => {
    beforeEach(async () => {
      await StorageContract.connect(opSigner).createContextGraph(
        accounts[0].address, [10n], [], 1, 0, 0, accounts[1].address, 0,
      );
    });

    it('replaces authority and accountId for PCA', async () => {
      const newAuthority = accounts[2].address;
      await expect(
        StorageContract.connect(opSigner).updatePublishAuthority(1, newAuthority, 777),
      ).to.emit(StorageContract, 'PublishAuthorityUpdated').withArgs(1, newAuthority, 777);

      const policy = await StorageContract.getPublishPolicy(1);
      expect(policy.publishAuthority).to.equal(newAuthority);
      expect(await StorageContract.getPublishAuthorityAccountId(1)).to.equal(777);
    });

    it('replaces authority and clears accountId for non-PCA', async () => {
      // First become PCA
      await StorageContract.connect(opSigner).updatePublishAuthority(1, accounts[2].address, 777);
      // Then switch to plain EOA
      await StorageContract.connect(opSigner).updatePublishAuthority(1, accounts[3].address, 0);

      const policy = await StorageContract.getPublishPolicy(1);
      expect(policy.publishAuthority).to.equal(accounts[3].address);
      expect(await StorageContract.getPublishAuthorityAccountId(1)).to.equal(0);
    });

    it('reverts on zero authority for curated CG', async () => {
      await expect(
        StorageContract.connect(opSigner).updatePublishAuthority(1, ethers.ZeroAddress, 0),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts when caller is not a Hub contract', async () => {
      await expect(
        StorageContract.connect(accounts[5]).updatePublishAuthority(1, accounts[2].address, 0),
      ).to.be.revertedWithCustomError(HubContract, 'UnauthorizedAccess');
    });

    it('reverts when CG is open but accountId provided', async () => {
      // Switch to open policy first via updatePublishPolicy
      await StorageContract.connect(opSigner).updatePublishPolicy(1, 1, ethers.ZeroAddress, 0);
      await expect(
        StorageContract.connect(opSigner).updatePublishAuthority(1, ethers.ZeroAddress, 99),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });
  });

  // -------------------------------------------------------------------------
  // updatePublishPolicy: new signature with accountId
  // -------------------------------------------------------------------------
  describe('updatePublishPolicy (new signature with accountId)', () => {
    beforeEach(async () => {
      await StorageContract.connect(opSigner).createContextGraph(
        accounts[0].address, [10n], [], 1, 0, 1, ethers.ZeroAddress, 0,
      );
    });

    it('switches open -> curated with PCA accountId', async () => {
      await expect(
        StorageContract.connect(opSigner).updatePublishPolicy(1, 0, accounts[1].address, 777),
      ).to.emit(StorageContract, 'PublishPolicyUpdated');
      const policy = await StorageContract.getPublishPolicy(1);
      expect(policy.publishPolicy).to.equal(0);
      expect(policy.publishAuthority).to.equal(accounts[1].address);
      expect(await StorageContract.getPublishAuthorityAccountId(1)).to.equal(777);
    });

    it('switches curated -> open clears authority and accountId', async () => {
      await StorageContract.connect(opSigner).updatePublishPolicy(1, 0, accounts[1].address, 777);
      await StorageContract.connect(opSigner).updatePublishPolicy(1, 1, ethers.ZeroAddress, 0);
      const policy = await StorageContract.getPublishPolicy(1);
      expect(policy.publishPolicy).to.equal(1);
      expect(policy.publishAuthority).to.equal(ethers.ZeroAddress);
      expect(await StorageContract.getPublishAuthorityAccountId(1)).to.equal(0);
    });

    it('reverts on curated with zero authority', async () => {
      await expect(
        StorageContract.connect(opSigner).updatePublishPolicy(1, 0, ethers.ZeroAddress, 0),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on open with non-zero accountId', async () => {
      await expect(
        StorageContract.connect(opSigner).updatePublishPolicy(1, 1, ethers.ZeroAddress, 99),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });
  });

  // -------------------------------------------------------------------------
  // NFT auto-rotation: clear PCA accountId on transfer
  // -------------------------------------------------------------------------
  describe('NFT transfer auto-rotation', () => {
    it('rotates publishAuthority to new owner and clears PCA accountId', async () => {
      const oldOwner = accounts[0];
      const newOwner = accounts[6];
      await StorageContract.connect(opSigner).createContextGraph(
        oldOwner.address, [10n], [], 1, 0, 0, oldOwner.address, 555,
      );

      await StorageContract.connect(oldOwner).transferFrom(oldOwner.address, newOwner.address, 1);

      const policy = await StorageContract.getPublishPolicy(1);
      expect(policy.publishAuthority).to.equal(newOwner.address);
      expect(await StorageContract.getPublishAuthorityAccountId(1)).to.equal(0);
    });

    it('does not rotate when authority is not the previous owner', async () => {
      const oldOwner = accounts[0];
      const externalAuth = accounts[2];
      await StorageContract.connect(opSigner).createContextGraph(
        oldOwner.address, [10n], [], 1, 0, 0, externalAuth.address, 0,
      );
      await StorageContract.connect(oldOwner).transferFrom(oldOwner.address, accounts[6].address, 1);

      // Authority unchanged: external authority survives
      const policy = await StorageContract.getPublishPolicy(1);
      expect(policy.publishAuthority).to.equal(externalAuth.address);
    });
  });

  // -------------------------------------------------------------------------
  // updateQuorum: still hosting-node based
  // -------------------------------------------------------------------------
  describe('updateQuorum (now bound to hosting nodes)', () => {
    beforeEach(async () => {
      await StorageContract.connect(opSigner).createContextGraph(
        accounts[0].address, [10n, 20n, 30n], [], 1, 0, 1, ethers.ZeroAddress, 0,
      );
    });

    it('updates threshold within hosting node count', async () => {
      await StorageContract.connect(opSigner).updateQuorum(1, 3);
      expect(await StorageContract.getContextGraphRequiredSignatures(1)).to.equal(3);
    });

    it('reverts when threshold > hosting nodes length', async () => {
      await expect(
        StorageContract.connect(opSigner).updateQuorum(1, 4),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });

    it('reverts on zero threshold', async () => {
      await expect(
        StorageContract.connect(opSigner).updateQuorum(1, 0),
      ).to.be.revertedWithCustomError(StorageContract, 'InvalidContextGraphConfig');
    });
  });
});
