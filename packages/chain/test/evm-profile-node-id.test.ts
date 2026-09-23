/**
 * EVMChainAdapter — Profile nodeId against a real Hardhat chain with the
 * repo's deploy scripts (Profile 10.1.0), so contract <-> ABI <-> adapter
 * drift fails here rather than on a live network.
 *
 * The fixture's four staked profiles (core + three receivers) were created
 * with random 32-byte nodeIds and sit in the sharding table, which is the
 * mainnet situation this change fixes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  decodeProfileNodeId,
  encodeProfileNodeId,
  encodeProfileNodeIdHex,
} from '@origintrail-official/dkg-core';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { ProfileNodeIdTakenError } from '../src/profile-node-id.js';
import { makeAdapterConfig } from './hardhat-harness.js';
import {
  HARDHAT_KEYS,
  createEVMAdapter,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from './evm-test-context.js';

// Base mainnet relay peer ids (network/mainnet-base.json), used as plain values.
const PEER_ID = '12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy';
const OTHER_PEER_ID = '12D3KooWMasqzRrim48ZJM64UyTfHufDTmSG3n3jqwsS5phz8m91';
const PEER_NODE_ID = encodeProfileNodeIdHex(PEER_ID);

let fileSnapshotId: string;
let testSnapshotId: string;

/** An adapter for a brand-new operational wallet (funded for gas) and admin wallet. */
async function freshNodeAdapter(): Promise<EVMChainAdapter> {
  const { rpcUrl, hubAddress } = getSharedContext();
  const deployer = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER, createProvider());
  const operational = ethers.Wallet.createRandom();
  const admin = ethers.Wallet.createRandom();
  await (await deployer.sendTransaction({ to: operational.address, value: ethers.parseEther('1') })).wait();
  return new EVMChainAdapter(makeAdapterConfig(rpcUrl, hubAddress, operational.privateKey, [], admin.privateKey));
}

async function hubContract(name: string, abi: string[]) {
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const hub = new ethers.Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
  return new ethers.Contract(await hub.getContractAddress(name), abi, provider);
}

describe('EVMChainAdapter — Profile nodeId (real Hardhat)', () => {
  beforeAll(async () => {
    fileSnapshotId = await takeSnapshot();
  });

  afterAll(async () => {
    await revertSnapshot(fileSnapshotId);
  });

  beforeEach(async () => {
    testSnapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await revertSnapshot(testSnapshotId);
  });

  it('detects updateNodeId on the deployed Profile', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const profile = await hubContract('Profile', ['function version() view returns (string)']);
    await expect(adapter.getProfileNodeIdUpdateSupport!()).resolves.toEqual({
      supported: true,
      profileAddress: ethers.getAddress(await profile.getAddress()),
      profileVersion: '10.1.0',
      requiredVersion: '10.1.0',
    });
  });

  it("re-points the staked core's legacy nodeId at its peer id and re-positions it in the ring", async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { coreProfileId } = getSharedContext();
    const identityId = BigInt(coreProfileId);

    const legacy = await adapter.getProfileNodeId!();
    expect(ethers.dataLength(legacy)).toBe(32);
    expect(decodeProfileNodeId(legacy)).toBeNull();
    const ringBefore = await adapter.listDesignatableNodes({ fresh: true });
    expect(ringBefore.map((node) => node.identityId)).toContain(identityId);

    const result = await adapter.updateProfileNodeId!(encodeProfileNodeId(PEER_ID));
    expect(result).toMatchObject({
      identityId,
      previousNodeId: legacy,
      nodeId: PEER_NODE_ID,
      changed: true,
      signer: new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address,
    });
    expect(result.tx?.success).toBe(true);

    // ProfileStorage and the ring both carry the peer id now.
    await expect(adapter.getProfileNodeId!()).resolves.toBe(PEER_NODE_ID);
    expect(decodeProfileNodeId(await adapter.getProfileNodeId!(identityId))).toBe(PEER_ID);
    const ring = await adapter.listDesignatableNodes({ fresh: true });
    expect(ring.map((node) => node.identityId).sort()).toEqual(ringBefore.map((node) => node.identityId).sort());
    expect(ring.find((node) => node.identityId === identityId)?.nodeId.toLowerCase()).toBe(PEER_NODE_ID);
    const positions = ring.map((node) => BigInt(ethers.sha256(node.nodeId)));
    expect(positions).toEqual([...positions].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    const sts = await hubContract('ShardingTableStorage', [
      'function getNode(uint72) view returns (tuple(uint256 hashRingPosition, bytes nodeId, uint72 index, uint72 identityId))',
    ]);
    const cached = await sts.getNode(identityId);
    expect(String(cached.nodeId).toLowerCase()).toBe(PEER_NODE_ID);
    expect(BigInt(cached.hashRingPosition)).toBe(BigInt(ethers.sha256(PEER_NODE_ID)));

    const profileStorage = await hubContract('ProfileStorage', [
      'event NodeIdUpdated(uint72 indexed identityId, bytes oldNodeId, bytes newNodeId)',
    ]);
    const logs = await profileStorage.queryFilter(profileStorage.filters.NodeIdUpdated(identityId), result.tx!.blockNumber);
    expect(logs).toHaveLength(1);
    const parsed = profileStorage.interface.parseLog(logs[0])!;
    expect([String(parsed.args.oldNodeId).toLowerCase(), String(parsed.args.newNodeId).toLowerCase()])
      .toEqual([legacy, PEER_NODE_ID]);

    // Running it again is a no-op without a transaction.
    const again = await adapter.updateProfileNodeId!(PEER_NODE_ID);
    expect(again).toEqual({ identityId, previousNodeId: PEER_NODE_ID, nodeId: PEER_NODE_ID, changed: false });
  });

  it('refuses a peer id another identity holds', async () => {
    const core = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const receiver = createEVMAdapter(HARDHAT_KEYS.REC1_OP);
    await core.updateProfileNodeId!(PEER_NODE_ID);

    await expect(receiver.isProfileNodeIdTaken!(PEER_NODE_ID)).resolves.toBe(true);
    await expect(receiver.updateProfileNodeId!(PEER_NODE_ID)).rejects.toBeInstanceOf(ProfileNodeIdTakenError);
  });

  it('creates new profiles with the peer id, and with a random nodeId when it is taken', async () => {
    const fresh = await freshNodeAdapter();
    const identityId = await fresh.ensureProfile({
      nodeName: 'peer-id-profile',
      nodeId: encodeProfileNodeId(OTHER_PEER_ID),
      stakeAmount: 0n,
    });
    expect(identityId).toBeGreaterThan(0n);
    expect(decodeProfileNodeId(await fresh.getProfileNodeId!())).toBe(OTHER_PEER_ID);

    // A second node whose peer id is already registered still gets a profile.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clash = await freshNodeAdapter();
    const clashId = await clash.ensureProfile({
      nodeName: 'clashing-profile',
      nodeId: encodeProfileNodeId(OTHER_PEER_ID),
      stakeAmount: 0n,
    });
    expect(clashId).toBeGreaterThan(identityId);
    const clashNodeId = await clash.getProfileNodeId!();
    expect(ethers.dataLength(clashNodeId)).toBe(32);
    expect(decodeProfileNodeId(clashNodeId)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already registered to another identity'));
  });
});
