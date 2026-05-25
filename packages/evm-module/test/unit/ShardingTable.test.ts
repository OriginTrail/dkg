import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BytesLike } from 'ethers';
import hre from 'hardhat';

import {
  Hub,
  Profile,
  ProfileStorage,
  ShardingTableStorage,
  ShardingTable,
} from '../../typechain';

type ShardingTableFixture = {
  accounts: SignerWithAddress[];
  Profile: Profile;
  ShardingTableStorage: ShardingTableStorage;
  ShardingTable: ShardingTable;
};

type Node = {
  account: SignerWithAddress;
  identityId: number;
  nodeId: BytesLike;
  sha256: BytesLike;
};

describe('@unit ShardingTable contract', function () {
  let accounts: SignerWithAddress[];
  let Profile: Profile;
  let ShardingTableStorage: ShardingTableStorage;
  let ShardingTable: ShardingTable;
  let ProfileStorage: ProfileStorage;
  let identityId: number;

  const nodeId1 = '0x01';
  const nodeId2 = '0x02';
  const nodeId3 = '0x03';
  const nodeId4 = '0x04';
  const nodeId5 = '0x05';

  // 3 1 2 4 5

  async function deployShardingTableFixture(): Promise<ShardingTableFixture> {
    await hre.deployments.fixture(
      ['ShardingTable', 'IdentityStorageV2', 'StakingV2', 'Profile'],
      {
        keepExistingDeployments: false,
      },
    );
    accounts = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    Profile = await hre.ethers.getContract<Profile>('Profile');
    ShardingTableStorage = await hre.ethers.getContract<ShardingTableStorage>(
      'ShardingTableStorage',
    );
    ShardingTable =
      await hre.ethers.getContract<ShardingTable>('ShardingTable');
    ProfileStorage =
      await hre.ethers.getContract<ProfileStorage>('ProfileStorage');
    await Hub.setContractAddress('HubOwner', accounts[0].address);

    return { accounts, Profile, ShardingTableStorage, ShardingTable };
  }

  async function createProfile(
    operational: SignerWithAddress,
    admin: SignerWithAddress,
  ): Promise<Node> {
    const OperationalProfile = Profile.connect(operational);

    const nodeId = '0x' + randomBytes(32).toString('hex');
    const sha256 = hre.ethers.solidityPackedSha256(['bytes'], [nodeId]);

    const receipt = await (
      await OperationalProfile.createProfile(
        admin.address,
        [],
        `Node ${Math.floor(Math.random() * 1000)}`,
        nodeId,
        0,
      )
    ).wait();
    const identityId = Number(receipt!.logs[0].topics[1]);
    const blockchainNodeId = await ProfileStorage.getNodeId(identityId);

    expect(blockchainNodeId).to.be.equal(nodeId);

    return {
      account: operational,
      identityId,
      nodeId,
      sha256,
    };
  }

  async function createMultipleRandomProfiles(count = 150): Promise<Node[]> {
    const nodes = [];

    for (let i = 0; i < count; i++) {
      const node = await createProfile(accounts[i], accounts[i + count]);
      nodes.push(node);
    }

    return nodes;
  }

  async function createMultipleProfiles() {
    const opWallet1 = Profile.connect(accounts[1]);
    const opWallet2 = Profile.connect(accounts[2]);
    const opWallet3 = Profile.connect(accounts[3]);
    const opWallet4 = Profile.connect(accounts[4]);
    const profile1 = await Profile.createProfile(
      accounts[6].address,
      [],
      'Node 1',
      nodeId1,
      0,
    );
    const profile2 = await opWallet1.createProfile(
      accounts[7].address,
      [],
      'Node 2',
      nodeId2,
      0,
    );
    const profile3 = await opWallet2.createProfile(
      accounts[8].address,
      [],
      'Node 3',
      nodeId3,
      0,
    );
    const profile4 = await opWallet3.createProfile(
      accounts[9].address,
      [],
      'Node 4',
      nodeId4,
      0,
    );
    const profile5 = await opWallet4.createProfile(
      accounts[10].address,
      [],
      'Node 5',
      nodeId5,
      0,
    );
    const idsArray = [];

    const profileArray = [profile1, profile2, profile3, profile4, profile5];
    for (const singleIdentityId of profileArray) {
      const receipt = await singleIdentityId.wait();

      identityId = Number(receipt!.logs[0].topics[1]);
      idsArray.push(identityId);
    }
    return idsArray;
  }

  async function validateShardingTableResult(identityIds: bigint[]) {
    const nodesCount = await ShardingTableStorage.nodesCount();

    expect(identityIds.length).to.equal(nodesCount, 'Invalid number of nodes');

    for (let i = 0; i < identityIds.length; i++) {
      const node = await ShardingTableStorage.getNode(identityIds[i]);
      const nodeByIndex = await ShardingTableStorage.getNodeByIndex(i);

      expect(node).to.be.eql(nodeByIndex);

      expect(node.identityId).to.equal(
        identityIds[i],
        'Invalid node on this position',
      );

      expect(node.index).to.equal(i, 'Invalid node index');
    }

    const shardingTable = (await ShardingTable['getShardingTable()']()).map(
      (node) => node.identityId,
    );

    expect(shardingTable).to.be.eql(identityIds);
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Profile, ShardingTableStorage, ShardingTable } =
      await loadFixture(deployShardingTableFixture));
  });

  it('Should initialize contract with correct values', async () => {
    const name = await ShardingTable.name();
    const version = await ShardingTable.version();

    expect(name).to.equal('ShardingTable');
    expect(version).to.equal('2.0.0');
  });

  // v2.0.0 — `migrationPeriodEnd` (V8→V9 carry-over) was removed along
  // with its constructor parameter. This regression locks in three
  // properties so a future reintroduction (e.g. accidental cherry-pick
  // of the V8 contract over this one) trips the suite immediately:
  //   1. The constructor takes exactly one argument (`hubAddress`) —
  //      caught at deploy time inside `deployShardingTableFixture`,
  //      which is what the broader test run already exercises.
  //   2. The deployed contract does NOT expose `migrationPeriodEnd()`
  //      (typechain types omit it; ethers `getFunction` rejects it
  //      with `no matching fragment`).
  //   3. The `_VERSION` semver tier reflects the ABI break: anything
  //      below 2.0.0 means the version bump regressed back into a
  //      patch / minor and downstream "wire-compatible" deploy tooling
  //      would silently misclassify the rollout. (Codex review on
  //      PR #651, comment r3298951085.)
  it('does not expose `migrationPeriodEnd()` on the V10 ABI [regression: v2.0.0]', async () => {
    const fns = ShardingTable.interface.fragments
      .filter((f) => f.type === 'function')
      .map((f) => ('name' in f ? f.name : ''));
    expect(
      fns,
      "removed V8→V9 carry-over getter must not reappear",
    ).to.not.include('migrationPeriodEnd');

    const ctor = ShardingTable.interface.fragments.find(
      (f) => f.type === 'constructor',
    );
    expect(ctor, 'constructor fragment present').to.not.be.undefined;
    expect(
      'inputs' in ctor! ? ctor.inputs.length : -1,
      'constructor takes only `hubAddress`',
    ).to.equal(1);

    const major = Number((await ShardingTable.version()).split('.')[0]);
    expect(major, 'semver major reflects ABI break').to.be.gte(2);
  });

  it('Insert 5 nodes, nodes are sorted expect to pass', async () => {
    const profiles = await createMultipleProfiles();

    // 2
    await ShardingTable['insertNode(uint72,uint72)'](0, profiles[1]);
    await validateShardingTableResult([2n]);

    // 3 2
    await ShardingTable['insertNode(uint72,uint72)'](0, profiles[2]);
    await validateShardingTableResult([3n, 2n]);

    // 3 2 5
    await ShardingTable['insertNode(uint72,uint72)'](2, profiles[4]);
    await validateShardingTableResult([3n, 2n, 5n]);

    // 3 2 4 5
    await ShardingTable['insertNode(uint72,uint72)'](2, profiles[3]);
    await validateShardingTableResult([3n, 2n, 4n, 5n]);

    // 3 1 2 4 5
    await ShardingTable['insertNode(uint72,uint72)'](1, profiles[0]);
    await validateShardingTableResult([3n, 1n, 2n, 4n, 5n]);
  });

  it('Insert 5 nodes, without sorting, expect to be pass and be sorted on insert', async () => {
    const profiles = await createMultipleProfiles();

    // 2
    await ShardingTable['insertNode(uint72)'](profiles[1]);
    await validateShardingTableResult([2n]);

    // 3 2
    await ShardingTable['insertNode(uint72)'](profiles[2]);
    await validateShardingTableResult([3n, 2n]);

    // 3 2 5
    await ShardingTable['insertNode(uint72)'](profiles[4]);
    await validateShardingTableResult([3n, 2n, 5n]);

    // 3 2 4 5
    await ShardingTable['insertNode(uint72)'](profiles[3]);
    await validateShardingTableResult([3n, 2n, 4n, 5n]);

    // 3 1 2 4 5
    await ShardingTable['insertNode(uint72)'](profiles[0]);
    await validateShardingTableResult([3n, 1n, 2n, 4n, 5n]);
  });

  it('Insert 100 nodes to the beginning of the Sharding Table, expect gas consumption to fit in 1_000_000 wei', async () => {
    const gasConsumptionThreshold = hre.ethers.parseEther('1000000');

    const nodes = await createMultipleRandomProfiles(100);

    const sortedNodes = nodes.sort((a, b) => {
      if (b.sha256 == a.sha256) {
        return 0;
      }
      return b.sha256 < a.sha256 ? -1 : 1;
    });

    for (const node of sortedNodes) {
      const tx = await ShardingTable['insertNode(uint72,uint72)'](
        0,
        node.identityId,
      );
      const receipt = await tx.wait();
      expect(receipt!.gasUsed).to.be.lessThanOrEqual(gasConsumptionThreshold);
    }
  });

  it('Insert node with invalid prevIdentityId expect to fail', async () => {
    const profiles = await createMultipleProfiles();

    await ShardingTable['insertNode(uint72,uint72)'](0, profiles[1]);

    await expect(
      ShardingTable['insertNode(uint72,uint72)'](1, profiles[0]),
    ).to.be.revertedWithCustomError(
      ShardingTable,
      'InvalidIndexWithRespectToPreviousNode',
    );
  });

  it('Insert node with invalid nextIdentityId expect to fail', async () => {
    const profiles = await createMultipleProfiles();

    await ShardingTable['insertNode(uint72,uint72)'](0, profiles[1]);

    await expect(
      ShardingTable['insertNode(uint72,uint72)'](0, profiles[3]),
    ).to.be.revertedWithCustomError(
      ShardingTable,
      'InvalidIndexWithRespectToNextNode',
    );
  });

  it('Remove node from sharding table, expect to pass', async () => {
    const profiles = await createMultipleProfiles();

    await ShardingTable['insertNode(uint72,uint72)'](0, profiles[2]);
    await ShardingTable['insertNode(uint72,uint72)'](1, profiles[0]);
    await ShardingTable['insertNode(uint72,uint72)'](2, profiles[1]);
    await ShardingTable['insertNode(uint72,uint72)'](3, profiles[3]);
    await ShardingTable['insertNode(uint72,uint72)'](4, profiles[4]);

    // remove from index 0
    await ShardingTable.removeNode(profiles[2]);
    await validateShardingTableResult([1n, 2n, 4n, 5n]);

    // remove from last index
    await ShardingTable.removeNode(profiles[4]);
    await validateShardingTableResult([1n, 2n, 4n]);

    // remove from middle
    await ShardingTable.removeNode(profiles[1]);
    await validateShardingTableResult([1n, 4n]);
  });
});
