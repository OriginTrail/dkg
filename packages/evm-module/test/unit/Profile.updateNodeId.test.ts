import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Hub,
  IdentityStorage,
  ParametersStorage,
  Profile,
  ProfileStorage,
  ShardingTable,
  ShardingTableStorage,
} from '../../typechain';

// Profile 10.1.0 — `updateNodeId(identityId, nodeId)` re-points an identity's
// profile nodeId at the node's real libp2p peer id. A node in the sharding
// table is removed and re-inserted in the same transaction, because its ring
// position is sha256(nodeId).
//
// Access control is `onlyIdentityOwner` (admin OR operational key). That is a
// REVIEWER DECISION: if the contract switches to `onlyAdmin`, the
// operational-key case below becomes a revert.

// Canonical encoding written by the node: UTF-8 bytes of the base58btc peer id.
const PEER_A = '12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy';
const PEER_B = '12D3KooWMasqzRrim48ZJM64UyTfHufDTmSG3n3jqwsS5phz8m91';
const PEER_C = '16Uiu2HAmQG8bwj8dqFpX3LwTZkCAfkaS9fWoXMpdSUYkVYx2Gf3b';

const toNodeId = (text: string): string =>
  hre.ethers.hexlify(hre.ethers.toUtf8Bytes(text));
const ringPosition = (nodeId: string): bigint => BigInt(hre.ethers.sha256(nodeId));
const byBigInt = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** A deterministic nodeId whose ring position satisfies `predicate`. */
function grindNodeId(label: string, predicate: (position: bigint) => boolean): string {
  for (let i = 0; i < 1_000_000; i++) {
    const candidate = toNodeId(`${label}-${i}`);
    if (predicate(ringPosition(candidate))) return candidate;
  }
  throw new Error(`could not grind a nodeId for ${label}`);
}

describe('@unit Profile.updateNodeId', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let Profile: Profile;
  let ProfileStorage: ProfileStorage;
  let IdentityStorage: IdentityStorage;
  let ParametersStorage: ParametersStorage;
  let ShardingTable: ShardingTable;
  let ShardingTableStorage: ShardingTableStorage;

  async function deployFixture() {
    await hre.deployments.fixture(['Profile', 'ShardingTable', 'ParametersStorage'], {
      keepExistingDeployments: false,
    });
    const signers = await hre.ethers.getSigners();
    const hub = await hre.ethers.getContract<Hub>('Hub');
    // accounts[0] is the Hub owner (deployer); registering it as a Hub
    // contract also lets the tests drive `onlyContracts` storage/ring calls.
    await hub.setContractAddress('HubOwner', signers[0].address);
    return {
      accounts: signers,
      Hub: hub,
      Profile: await hre.ethers.getContract<Profile>('Profile'),
      ProfileStorage: await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
      IdentityStorage: await hre.ethers.getContract<IdentityStorage>('IdentityStorage'),
      ParametersStorage: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
      ShardingTable: await hre.ethers.getContract<ShardingTable>('ShardingTable'),
      ShardingTableStorage: await hre.ethers.getContract<ShardingTableStorage>('ShardingTableStorage'),
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub,
      Profile,
      ProfileStorage,
      IdentityStorage,
      ParametersStorage,
      ShardingTable,
      ShardingTableStorage,
    } = await loadFixture(deployFixture));
  });

  /** Create a profile signed by `operational` (its primary op key) with `admin` as admin. */
  async function createProfile(
    operational: SignerWithAddress,
    admin: SignerWithAddress,
    nodeId: string,
    name = `Node ${nodeId.slice(2, 14)}`,
  ): Promise<bigint> {
    await Profile.connect(operational).createProfile(admin.address, [], name, nodeId, 0);
    const identityId = await IdentityStorage.getIdentityId(operational.address);
    expect(identityId).to.be.gt(0n);
    return identityId;
  }

  async function insertIntoRing(identityId: bigint): Promise<void> {
    await ShardingTable['insertNode(uint72)'](identityId);
  }

  /**
   * The ring invariants updateNodeId must preserve: every cached Node matches
   * ProfileStorage (nodeId and sha256 position), indexes are dense and sorted
   * by position, the index -> identity pointers agree, and getShardingTable()
   * returns the same members in the same order.
   */
  async function expectRingConsistent(members: bigint[]): Promise<void> {
    const count = await ShardingTableStorage.nodesCount();
    expect(count).to.equal(BigInt(members.length));

    const expectedOrder = await Promise.all(
      members.map(async (id) => ({ id, position: ringPosition(await ProfileStorage.getNodeId(id)) })),
    );
    expectedOrder.sort((a, b) => byBigInt(a.position, b.position));

    const seen: bigint[] = [];
    let previousPosition = -1n;
    for (let index = 0n; index < count; index++) {
      const node = await ShardingTableStorage.getNodeByIndex(index);
      const profileNodeId = await ProfileStorage.getNodeId(node.identityId);
      expect(node.index).to.equal(index);
      expect(node.nodeId).to.equal(profileNodeId);
      expect(node.hashRingPosition).to.equal(ringPosition(profileNodeId));
      expect(node.hashRingPosition > previousPosition).to.equal(true);
      expect(await ShardingTableStorage.indexToIdentityId(index)).to.equal(node.identityId);
      expect(await ShardingTableStorage.nodeExists(node.identityId)).to.equal(true);
      previousPosition = node.hashRingPosition;
      seen.push(node.identityId);
    }
    expect(await ShardingTableStorage.indexToIdentityId(count)).to.equal(0n);
    expect(seen).to.eql(expectedOrder.map((entry) => entry.id));

    const table = await ShardingTable['getShardingTable()']();
    expect(table.map((node) => node.identityId)).to.eql(seen);
    for (const node of table) {
      expect(node.nodeId).to.equal(await ProfileStorage.getNodeId(node.identityId));
    }
  }

  it('is Profile 10.1.0 with a 64-byte nodeId bound and the Hub ShardingTable wired in', async () => {
    expect(await Profile.version()).to.equal('10.1.0');
    expect(await Profile.MAX_NODE_ID_LENGTH()).to.equal(64n);
    expect(await Profile.shardingTable()).to.equal(await ShardingTable.getAddress());
  });

  describe('access control (onlyIdentityOwner — reviewer decision)', () => {
    let identityId: bigint;
    const legacyNodeId = hre.ethers.hexlify(hre.ethers.randomBytes(32));

    beforeEach(async () => {
      // accounts[1] = primary operational key, accounts[2] = admin key.
      identityId = await createProfile(accounts[1], accounts[2], legacyNodeId);
    });

    it('the admin key can update the nodeId, and ProfileStorage emits NodeIdUpdated', async () => {
      await expect(Profile.connect(accounts[2]).updateNodeId(identityId, toNodeId(PEER_A)))
        .to.emit(ProfileStorage, 'NodeIdUpdated')
        .withArgs(identityId, legacyNodeId, toNodeId(PEER_A));
      expect(await ProfileStorage.getNodeId(identityId)).to.equal(toNodeId(PEER_A));
      expect(await ProfileStorage.nodeIdsList(toNodeId(PEER_A))).to.equal(true);
      expect(await ProfileStorage.nodeIdsList(legacyNodeId)).to.equal(false);
    });

    it('the primary operational key can update the nodeId', async () => {
      await expect(Profile.connect(accounts[1]).updateNodeId(identityId, toNodeId(PEER_A)))
        .to.emit(ProfileStorage, 'NodeIdUpdated')
        .withArgs(identityId, legacyNodeId, toNodeId(PEER_A));
      expect(await ProfileStorage.getNodeId(identityId)).to.equal(toNodeId(PEER_A));
    });

    it('an added operational key can update the nodeId', async () => {
      await Profile.connect(accounts[2]).addOperationalWallets(identityId, [accounts[3].address]);
      await Profile.connect(accounts[3]).updateNodeId(identityId, toNodeId(PEER_B));
      expect(await ProfileStorage.getNodeId(identityId)).to.equal(toNodeId(PEER_B));
    });

    it('a wallet with no key on the identity cannot update it', async () => {
      await expect(Profile.connect(accounts[9]).updateNodeId(identityId, toNodeId(PEER_A)))
        .to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminOrOperationalAddressesFunction')
        .withArgs(accounts[9].address);
      expect(await ProfileStorage.getNodeId(identityId)).to.equal(legacyNodeId);
    });

    it("another identity's admin and operational keys cannot update it", async () => {
      await createProfile(accounts[4], accounts[5], toNodeId('other-node'));
      for (const outsider of [accounts[4], accounts[5]]) {
        await expect(Profile.connect(outsider).updateNodeId(identityId, toNodeId(PEER_A)))
          .to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminOrOperationalAddressesFunction');
      }
      expect(await ProfileStorage.getNodeId(identityId)).to.equal(legacyNodeId);
    });

    it('the Hub owner gets no special access through updateNodeId', async () => {
      // accounts[0] owns the Hub; ownership is not an identity key.
      await expect(Profile.connect(accounts[0]).updateNodeId(identityId, toNodeId(PEER_A)))
        .to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminOrOperationalAddressesFunction');
    });
  });

  describe('input validation', () => {
    let identityId: bigint;
    const legacyNodeId = hre.ethers.hexlify(hre.ethers.randomBytes(32));

    beforeEach(async () => {
      identityId = await createProfile(accounts[1], accounts[2], legacyNodeId);
    });

    it('reverts EmptyNodeId for an empty value', async () => {
      await expect(Profile.connect(accounts[1]).updateNodeId(identityId, '0x'))
        .to.be.revertedWithCustomError(Profile, 'EmptyNodeId');
    });

    it('reverts NodeIdTooLong above 64 bytes and accepts exactly 64', async () => {
      const oversize = hre.ethers.hexlify(hre.ethers.randomBytes(65));
      await expect(Profile.connect(accounts[1]).updateNodeId(identityId, oversize))
        .to.be.revertedWithCustomError(Profile, 'NodeIdTooLong')
        .withArgs(65, 64);

      const maxLength = hre.ethers.hexlify(hre.ethers.randomBytes(64));
      await Profile.connect(accounts[1]).updateNodeId(identityId, maxLength);
      expect(await ProfileStorage.getNodeId(identityId)).to.equal(maxLength);
    });

    it("reverts NodeIdAlreadyExists for a value another identity holds", async () => {
      await createProfile(accounts[4], accounts[5], toNodeId(PEER_B));
      await expect(Profile.connect(accounts[1]).updateNodeId(identityId, toNodeId(PEER_B)))
        .to.be.revertedWithCustomError(Profile, 'NodeIdAlreadyExists')
        .withArgs(toNodeId(PEER_B));
      expect(await ProfileStorage.getNodeId(identityId)).to.equal(legacyNodeId);
    });

    it('treats an unchanged value as a no-op: no event, no ring churn', async () => {
      await insertIntoRing(identityId);
      const tx = Profile.connect(accounts[1]).updateNodeId(identityId, legacyNodeId);
      await expect(tx).to.not.emit(ProfileStorage, 'NodeIdUpdated');
      await expect(tx).to.not.emit(ShardingTableStorage, 'NodeObjectDeleted');
      await expect(tx).to.not.emit(ShardingTableStorage, 'NodeObjectCreated');
      expect(await ProfileStorage.getNodeId(identityId)).to.equal(legacyNodeId);
      expect(await ProfileStorage.nodeIdsList(legacyNodeId)).to.equal(true);
      await expectRingConsistent([identityId]);
    });

    it('reverts ProfileDoesntExist for an identity whose profile is gone', async () => {
      // The testnet ProfileStorage-redeploy state: the Identity survives, the
      // Profile does not. Writing a nodeId must not half-create a profile.
      await ProfileStorage.deleteProfile(identityId);
      await expect(Profile.connect(accounts[2]).updateNodeId(identityId, toNodeId(PEER_A)))
        .to.be.revertedWithCustomError(Profile, 'ProfileDoesntExist')
        .withArgs(identityId);
      expect(await ProfileStorage.profileExists(identityId)).to.equal(false);
    });

    it('releases the old value so another identity can claim it', async () => {
      await Profile.connect(accounts[1]).updateNodeId(identityId, toNodeId(PEER_A));
      const other = await createProfile(accounts[4], accounts[5], toNodeId('other-node'));
      await Profile.connect(accounts[4]).updateNodeId(other, legacyNodeId);
      expect(await ProfileStorage.getNodeId(other)).to.equal(legacyNodeId);
      // ...and a brand-new profile can no longer take the released value.
      await expect(
        Profile.connect(accounts[6]).createProfile(accounts[7].address, [], 'late', legacyNodeId, 0),
      ).to.be.revertedWithCustomError(Profile, 'NodeIdAlreadyExists');
    });
  });

  describe('sharding table', () => {
    it('an identity outside the ring only updates ProfileStorage', async () => {
      const inRing = await createProfile(accounts[1], accounts[2], toNodeId('ring-member'));
      await insertIntoRing(inRing);
      const outside = await createProfile(accounts[3], accounts[4], toNodeId('outside'));

      const tx = Profile.connect(accounts[3]).updateNodeId(outside, toNodeId(PEER_A));
      await expect(tx).to.emit(ProfileStorage, 'NodeIdUpdated');
      await expect(tx).to.not.emit(ShardingTableStorage, 'NodeObjectCreated');
      await expect(tx).to.not.emit(ShardingTableStorage, 'NodeObjectDeleted');

      expect(await ShardingTableStorage.nodeExists(outside)).to.equal(false);
      await expectRingConsistent([inRing]);
    });

    it('re-positions a ring member to the head, the tail and the middle', async () => {
      const members: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await createProfile(
          accounts[10 + i],
          accounts[20 + i],
          hre.ethers.hexlify(hre.ethers.randomBytes(32)),
        );
        await insertIntoRing(id);
        members.push(id);
      }
      await expectRingConsistent(members);

      const positionsExcept = async (id: bigint) =>
        Promise.all(
          members
            .filter((member) => member !== id)
            .map(async (member) => ringPosition(await ProfileStorage.getNodeId(member))),
        );

      // Move the current tail to the head.
      const tail = (await ShardingTableStorage.getNodeByIndex(4)).identityId;
      const othersForHead = await positionsExcept(tail);
      const headNodeId = grindNodeId('head', (p) => othersForHead.every((o) => p < o));
      const previousTailNodeId = await ProfileStorage.getNodeId(tail);
      await expect(Profile.connect(accounts[10 + members.indexOf(tail)]).updateNodeId(tail, headNodeId))
        .to.emit(ProfileStorage, 'NodeIdUpdated')
        .withArgs(tail, previousTailNodeId, headNodeId)
        .and.to.emit(ShardingTableStorage, 'NodeObjectDeleted')
        .withArgs(tail)
        .and.to.emit(ShardingTableStorage, 'NodeObjectCreated')
        .withArgs(tail, headNodeId, ringPosition(headNodeId), 0);
      expect((await ShardingTableStorage.getNodeByIndex(0)).identityId).to.equal(tail);
      await expectRingConsistent(members);

      // Move the current head to the tail.
      const head = (await ShardingTableStorage.getNodeByIndex(0)).identityId;
      const othersForTail = await positionsExcept(head);
      const tailNodeId = grindNodeId('tail', (p) => othersForTail.every((o) => p > o));
      await Profile.connect(accounts[20 + members.indexOf(head)]).updateNodeId(head, tailNodeId);
      expect((await ShardingTableStorage.getNodeByIndex(4)).identityId).to.equal(head);
      await expectRingConsistent(members);

      // Move the node at index 1 to exactly index 2 of the remaining order.
      const mover = (await ShardingTableStorage.getNodeByIndex(1)).identityId;
      const others = (await positionsExcept(mover)).sort(byBigInt);
      const middleNodeId = grindNodeId('middle', (p) => p > others[1] && p < others[2]);
      await Profile.connect(accounts[10 + members.indexOf(mover)]).updateNodeId(mover, middleNodeId);
      expect((await ShardingTableStorage.getNodeByIndex(2)).identityId).to.equal(mover);
      expect((await ShardingTableStorage.getNodeByIndex(2)).hashRingPosition).to.equal(
        ringPosition(middleNodeId),
      );
      await expectRingConsistent(members);
    });

    it('keeps the ring consistent through a sequence of updates by every member', async () => {
      const members: bigint[] = [];
      for (let i = 0; i < 6; i++) {
        const id = await createProfile(accounts[30 + i], accounts[40 + i], toNodeId(`legacy-${i}`));
        await insertIntoRing(id);
        members.push(id);
      }
      const peers = [PEER_A, PEER_B, PEER_C, 'QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N', 'peer-5', 'peer-6'];
      for (let i = 0; i < members.length; i++) {
        await Profile.connect(accounts[30 + i]).updateNodeId(members[i], toNodeId(peers[i]));
        await expectRingConsistent(members);
      }
      // A second round swaps values through a free placeholder.
      await Profile.connect(accounts[30]).updateNodeId(members[0], toNodeId('placeholder'));
      await Profile.connect(accounts[31]).updateNodeId(members[1], toNodeId(PEER_A));
      await Profile.connect(accounts[30]).updateNodeId(members[0], toNodeId(PEER_B));
      await expectRingConsistent(members);
    });

    it('keeps recreateProfile working: the ring caches the NEW nodeId', async () => {
      const legacyNodeId = toNodeId('legacy-random');
      const id = await createProfile(accounts[1], accounts[2], legacyNodeId, 'Node 1');
      await insertIntoRing(id);
      await Profile.connect(accounts[1]).updateNodeId(id, toNodeId(PEER_A));

      // Simulate the ProfileStorage-redeploy recovery case: the profile is
      // gone, the sharding-table entry survives.
      await ProfileStorage.deleteProfile(id);
      expect(await ShardingTableStorage.nodeExists(id)).to.equal(true);

      // The pre-update nodeId no longer matches the ring...
      await expect(
        Profile.connect(accounts[2]).recreateProfile(accounts[1].address, 'Node 1', legacyNodeId),
      )
        .to.be.revertedWithCustomError(Profile, 'NodeIdShardingMismatch')
        .withArgs(id, toNodeId(PEER_A), legacyNodeId);

      // ...the updated one does.
      await Profile.connect(accounts[2]).recreateProfile(accounts[1].address, 'Node 1', toNodeId(PEER_A));
      expect(await ProfileStorage.getNodeId(id)).to.equal(toNodeId(PEER_A));
      await expectRingConsistent([id]);
    });

    it('reverts atomically when the ring cannot re-insert the node', async () => {
      const members: bigint[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await createProfile(accounts[10 + i], accounts[20 + i], toNodeId(`member-${i}`));
        await insertIntoRing(id);
        members.push(id);
      }
      // Governance lowered the cap below the current ring size: re-insertion
      // after the remove hits ShardingTableIsFull, and the whole update rolls back.
      await ParametersStorage.setShardingTableSizeLimit(2);
      const before = await ProfileStorage.getNodeId(members[1]);

      await expect(Profile.connect(accounts[11]).updateNodeId(members[1], toNodeId(PEER_A)))
        .to.be.revertedWithCustomError(ShardingTable, 'ShardingTableIsFull')
        .withArgs(2, 2);

      expect(await ProfileStorage.getNodeId(members[1])).to.equal(before);
      expect(await ProfileStorage.nodeIdsList(toNodeId(PEER_A))).to.equal(false);
      expect(await ProfileStorage.nodeIdsList(before)).to.equal(true);
      await expectRingConsistent(members);
    });

    it('squatting remedy: the Hub owner can move a squatter off a peer id without a new entry point', async () => {
      // A victim core with a legacy nodeId, and a squatter that registered the
      // victim's peer id first (profile creation is not whitelisted on mainnet).
      const victim = await createProfile(accounts[1], accounts[2], toNodeId('victim-legacy'));
      const squatter = await createProfile(accounts[3], accounts[4], toNodeId(PEER_A));
      await insertIntoRing(victim);
      await insertIntoRing(squatter);

      await expect(Profile.connect(accounts[1]).updateNodeId(victim, toNodeId(PEER_A)))
        .to.be.revertedWithCustomError(Profile, 'NodeIdAlreadyExists');

      // Prove the Hub OWNER privilege alone suffices: hand Hub ownership to a
      // wallet that is NOT registered as a Hub contract (accounts[0] is, for
      // the other tests). ProfileStorage.setNodeId and ShardingTable.removeNode
      // / insertNode are `onlyContracts`, which also admits hub.owner(). On
      // mainnet the owner is a Safe, which can batch these three calls
      // atomically (MultiSend).
      const hubOwner = accounts[50];
      await Hub.transferOwnership(hubOwner.address);
      expect(await Hub.owner()).to.equal(hubOwner.address);
      expect(await Hub['isContract(address)'](hubOwner.address)).to.equal(false);

      const placeholder = toNodeId(`revoked-squatter-${squatter}`);
      await ShardingTable.connect(hubOwner).removeNode(squatter);
      await ProfileStorage.connect(hubOwner).setNodeId(squatter, placeholder);
      await ShardingTable.connect(hubOwner)['insertNode(uint72)'](squatter);
      await expectRingConsistent([victim, squatter]);

      await Profile.connect(accounts[1]).updateNodeId(victim, toNodeId(PEER_A));
      expect(await ProfileStorage.getNodeId(victim)).to.equal(toNodeId(PEER_A));
      await expectRingConsistent([victim, squatter]);
    });
  });

  describe('gas', () => {
    it('measures the re-index cost in a 100-node ring (worst case: head moved to head)', async function () {
      this.timeout(300_000);
      const count = 100;
      const members: bigint[] = [];
      for (let i = 0; i < count; i++) {
        // accounts[0..99] operational, accounts[100..199] admin.
        const id = await createProfile(accounts[i], accounts[i + count], toNodeId(`gas-${i}`), `gas-${i}`);
        await insertIntoRing(id);
        members.push(id);
      }
      const positionsExcept = async (id: bigint) =>
        Promise.all(
          members
            .filter((member) => member !== id)
            .map(async (member) => ringPosition(await ProfileStorage.getNodeId(member))),
        );

      // Best case: the tail moves and lands at the tail again (no index shifts).
      const tail = (await ShardingTableStorage.getNodeByIndex(count - 1)).identityId;
      const othersForTail = await positionsExcept(tail);
      const tailNodeId = grindNodeId('gas-tail', (p) => othersForTail.every((o) => p > o));
      const best = await (
        await Profile.connect(accounts[members.indexOf(tail)]).updateNodeId(tail, tailNodeId)
      ).wait();

      // Worst case: the head moves and lands at the head again, so both the
      // remove and the insert shift every other node (2 x 99 shifts).
      const head = (await ShardingTableStorage.getNodeByIndex(0)).identityId;
      const othersForHead = await positionsExcept(head);
      const headNodeId = grindNodeId('gas-head', (p) => othersForHead.every((o) => p < o));
      const worst = await (
        await Profile.connect(accounts[members.indexOf(head)]).updateNodeId(head, headNodeId)
      ).wait();

      const perShift = (worst!.gasUsed - best!.gasUsed) / BigInt(2 * (count - 1));
      const worstAt500 = best!.gasUsed + perShift * 2n * 499n;
      console.log(
        `      updateNodeId gas, ${count}-node ring: best ${best!.gasUsed}, worst ${worst!.gasUsed}, ` +
          `~${perShift} per shifted node; extrapolated worst case at the 500-node cap ~${worstAt500}`,
      );

      await expectRingConsistent(members);
      // Guard rail: the 100-node worst case stays well inside one block.
      expect(worst!.gasUsed).to.be.lessThan(10_000_000n);
    });
  });
});
