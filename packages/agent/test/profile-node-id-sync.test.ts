/**
 * Profile nodeId <-> libp2p peer id sync (`dkg identity sync-node-id` and the
 * daemon's startup reconcile).
 *
 * Runs against MockChainAdapter, the production offline-mode adapter, which
 * implements the same Profile nodeId contract as the EVM adapter (the EVM
 * adapter itself is covered in packages/chain, including a real-Hardhat
 * test). A few race and diagnostic cases use a hand-rolled chain seam.
 */
import { describe, expect, it } from 'vitest';
import { decodeProfileNodeId, encodeProfileNodeIdHex } from '@origintrail-official/dkg-core';
import {
  MockChainAdapter,
  NoChainAdapter,
  ProfileNodeIdTakenError,
  ProfileNodeIdUpdateUnsupportedError,
  type ChainAdapter,
  type ProfileNodeIdUpdateSupport,
} from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  describeProfileNodeIdSync,
  profileNodeIdForNewProfile,
  readProfileNodeIdStatus,
  syncProfileNodeId,
  type ProfileNodeIdSyncResult,
} from '../src/profile-node-id-sync.js';

const PEER_ID = '12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy';
const OTHER_PEER_ID = '12D3KooWMasqzRrim48ZJM64UyTfHufDTmSG3n3jqwsS5phz8m91';
const PEER_NODE_ID = encodeProfileNodeIdHex(PEER_ID);
const OTHER_OPERATOR = '0x' + '2'.repeat(40);
const SUPPORTED: ProfileNodeIdUpdateSupport = {
  supported: true,
  profileAddress: '0x' + 'AF'.repeat(20),
  profileVersion: '10.1.0',
  requiredVersion: '10.1.0',
};

async function mockWithLegacyProfile(): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter();
  await chain.ensureProfile();
  return chain;
}

describe('readProfileNodeIdStatus', () => {
  it('reports no-profile for a node without an identity', async () => {
    const status = await readProfileNodeIdStatus({ chain: new MockChainAdapter(), peerId: PEER_ID });
    expect(status).toMatchObject({
      identityId: 0n,
      peerId: PEER_ID,
      expectedNodeId: PEER_NODE_ID,
      onChainNodeId: '0x',
      state: 'no-profile',
      expectedNodeIdTaken: null,
    });
  });

  it('reports a legacy random nodeId as legacy', async () => {
    const chain = await mockWithLegacyProfile();
    const status = await readProfileNodeIdStatus({ chain, peerId: PEER_ID });
    expect(status).toMatchObject({ state: 'legacy', onChainPeerId: null, expectedNodeIdTaken: false });
    expect(status!.support.supported).toBe(true);
  });

  it('reports a nodeId naming another peer as other-peer', async () => {
    const chain = new MockChainAdapter();
    await chain.ensureProfile({ nodeId: encodeProfileNodeIdHex(OTHER_PEER_ID) });
    const status = await readProfileNodeIdStatus({ chain, peerId: PEER_ID });
    expect(status).toMatchObject({ state: 'other-peer', onChainPeerId: OTHER_PEER_ID });
  });

  it('is null for a chain adapter without the Profile nodeId surface', async () => {
    await expect(readProfileNodeIdStatus({ chain: new NoChainAdapter(), peerId: PEER_ID })).resolves.toBeNull();
    await expect(syncProfileNodeId({ chain: new NoChainAdapter(), peerId: PEER_ID }, 'manual')).resolves.toBeNull();
  });
});

describe('syncProfileNodeId', () => {
  it("replaces a legacy nodeId with this node's peer id, then reports in-sync", async () => {
    const chain = await mockWithLegacyProfile();
    const first = await syncProfileNodeId({ chain, peerId: PEER_ID }, 'startup');
    expect(first!.outcome).toBe('updated');
    expect(first!.tx?.success).toBe(true);
    expect(first!.status).toMatchObject({ state: 'in-sync', onChainNodeId: PEER_NODE_ID, onChainPeerId: PEER_ID });
    expect(decodeProfileNodeId(await chain.getProfileNodeId())).toBe(PEER_ID);

    const second = await syncProfileNodeId({ chain, peerId: PEER_ID }, 'startup');
    expect(second!.outcome).toBe('in-sync');
  });

  it('startup mode leaves a different valid peer id alone; manual mode replaces it', async () => {
    const chain = new MockChainAdapter();
    await chain.ensureProfile({ nodeId: encodeProfileNodeIdHex(OTHER_PEER_ID) });

    const startup = await syncProfileNodeId({ chain, peerId: PEER_ID }, 'startup');
    expect(startup!.outcome).toBe('skipped-other-peer');
    expect(decodeProfileNodeId(await chain.getProfileNodeId())).toBe(OTHER_PEER_ID);

    const manual = await syncProfileNodeId({ chain, peerId: PEER_ID }, 'manual');
    expect(manual!.outcome).toBe('updated');
    expect(decodeProfileNodeId(await chain.getProfileNodeId())).toBe(PEER_ID);
  });

  it('does not send anything when the deployed Profile predates updateNodeId', async () => {
    const chain = await mockWithLegacyProfile();
    const before = await chain.getProfileNodeId();
    chain.profileNodeIdUpdateSupported = false;
    const result = await syncProfileNodeId({ chain, peerId: PEER_ID }, 'manual');
    expect(result!.outcome).toBe('unsupported');
    await expect(chain.getProfileNodeId()).resolves.toBe(before);
  });

  it("reports taken when another identity already holds this node's peer id", async () => {
    const chain = new MockChainAdapter();
    chain.seedIdentity(OTHER_OPERATOR, 5n);
    await chain.updateProfileNodeId(PEER_NODE_ID, { identityId: 5n });
    await chain.ensureProfile();

    const result = await syncProfileNodeId({ chain, peerId: PEER_ID }, 'manual');
    expect(result!.outcome).toBe('taken');
    expect(result!.status.expectedNodeIdTaken).toBe(true);
    await expect(chain.getProfileNodeId(5n)).resolves.toBe(PEER_NODE_ID);
  });

  it('is a no-op without an identity', async () => {
    const result = await syncProfileNodeId({ chain: new MockChainAdapter(), peerId: PEER_ID }, 'manual');
    expect(result!.outcome).toBe('no-profile');
  });
});

/** A chain seam whose read says "legacy" and whose update does what the test says. */
function racingChain(update: ChainAdapter['updateProfileNodeId'], holder?: bigint): ChainAdapter {
  const base = new NoChainAdapter();
  return Object.assign(base, {
    chainId: 'evm:31337',
    getIdentityId: async () => 7n,
    getProfileNodeId: async () => '0x' + '7c'.repeat(32),
    isProfileNodeIdTaken: async () => holder !== undefined,
    getProfileNodeIdUpdateSupport: async () => SUPPORTED,
    listDesignatableNodes: async () => (holder === undefined ? [] : [
      { nodeId: PEER_NODE_ID.toUpperCase().replace('0X', '0x'), identityId: holder, ask: 0n, stake: 0n },
    ]),
    updateProfileNodeId: update,
  }) as unknown as ChainAdapter;
}

describe('syncProfileNodeId races and diagnostics', () => {
  it('names the sharding-table member that holds the peer id', async () => {
    const neverCalled = async (): Promise<never> => { throw new Error('must not send when the peer id is taken'); };
    const result = await syncProfileNodeId({ chain: racingChain(neverCalled, 63n), peerId: PEER_ID }, 'manual');
    expect(result!.outcome).toBe('taken');
    expect(result!.status.expectedNodeIdHolder).toBe(63n);
    expect(describeProfileNodeIdSync(result!)).toContain('is already registered as the nodeId of identity 63');
  });

  it('treats a concurrent identical update as in-sync', async () => {
    const chain = racingChain(async (nodeId) => ({
      identityId: 7n, previousNodeId: String(nodeId), nodeId: String(nodeId), changed: false,
    }));
    const result = await syncProfileNodeId({ chain, peerId: PEER_ID }, 'startup');
    expect(result!.outcome).toBe('in-sync');
    expect(result!.tx).toBeUndefined();
  });

  it('maps a lost race for the peer id to taken and a Profile swap to unsupported', async () => {
    const taken = await syncProfileNodeId({
      chain: racingChain(async () => { throw new ProfileNodeIdTakenError(PEER_NODE_ID); }),
      peerId: PEER_ID,
    }, 'manual');
    expect(taken!.outcome).toBe('taken');

    const older = { ...SUPPORTED, supported: false, profileVersion: '10.0.2' };
    const unsupported = await syncProfileNodeId({
      chain: racingChain(async () => { throw new ProfileNodeIdUpdateUnsupportedError(older); }),
      peerId: PEER_ID,
    }, 'manual');
    expect(unsupported!.outcome).toBe('unsupported');
    expect(unsupported!.status.support).toEqual(older);
  });

  it('propagates other failures', async () => {
    const chain = racingChain(async () => { throw new Error('RPC endpoints exhausted'); });
    await expect(syncProfileNodeId({ chain, peerId: PEER_ID }, 'manual')).rejects.toThrow('RPC endpoints exhausted');
  });
});

describe('describeProfileNodeIdSync', () => {
  it('writes one operator line per outcome', async () => {
    const chain = await mockWithLegacyProfile();
    const status = (await readProfileNodeIdStatus({ chain, peerId: PEER_ID }))!;
    const line = (result: Omit<ProfileNodeIdSyncResult, 'status'>, overrides = {}) =>
      describeProfileNodeIdSync({ ...result, status: { ...status, ...overrides } });

    expect(line({ outcome: 'updated', tx: { hash: '0xabc', blockNumber: 1, success: true } }))
      .toBe(`Profile nodeId of identity 1 now names this node's peer id ${PEER_ID} (tx 0xabc)`);
    expect(line({ outcome: 'in-sync' })).toContain('already names this node');
    expect(line({ outcome: 'no-profile' })).toContain('no on-chain profile');
    expect(line({ outcome: 'unsupported' }, {
      support: { ...SUPPORTED, supported: false, profileVersion: '10.0.2' },
    })).toMatch(/Profile contract \(v10\.0\.2 at 0x.*\) cannot update nodeIds; it needs Profile >= 10\.1\.0/);
    expect(line({ outcome: 'unsupported' }, { support: { ...SUPPORTED, supported: false, profileVersion: null } }))
      .toContain('an unknown version');
    expect(line({ outcome: 'taken' })).toContain('nodeId of another identity');
    expect(line({ outcome: 'skipped-other-peer' }, { onChainPeerId: OTHER_PEER_ID }))
      .toContain(`names a different peer id (${OTHER_PEER_ID})`);
  });
});

describe('profileNodeIdForNewProfile', () => {
  it("encodes this node's peer id, and yields undefined for anything else", () => {
    expect(profileNodeIdForNewProfile(PEER_ID)).toEqual(new TextEncoder().encode(PEER_ID));
    expect(profileNodeIdForNewProfile('not a peer id')).toBeUndefined();
  });
});

describe('profile provisioning writes the peer id as nodeId', () => {
  /** MockChainAdapter recording what the agent asks ensureProfile for. */
  function recordingChain() {
    const chain = new MockChainAdapter();
    const requests: unknown[] = [];
    const ensureProfile = chain.ensureProfile.bind(chain);
    chain.ensureProfile = async (options) => {
      requests.push(options);
      return ensureProfile(options);
    };
    return { chain, requests };
  }

  function provisioningAgent(chain: ChainAdapter) {
    const noop = () => undefined;
    return {
      chain,
      config: { name: 'core-node', nodeRole: 'core' },
      node: { peerId: { toString: () => PEER_ID } },
      profileProvisioningInFlight: false,
      log: { info: noop, warn: noop, error: noop, debug: noop },
      publisher: { setIdentityId: noop },
    } as any;
  }

  it('boot provisioning (provisionProfileGuarded) creates the profile with the peer id', async () => {
    const { chain, requests } = recordingChain();
    const id = await (DKGAgent.prototype as any).provisionProfileGuarded.call(
      provisioningAgent(chain),
      { operationId: 'test' },
    );
    expect(id).toBe(1n);
    expect(requests).toEqual([{ nodeName: 'core-node', nodeId: new TextEncoder().encode(PEER_ID) }]);
    await expect(chain.getProfileNodeId()).resolves.toBe(PEER_NODE_ID);
  });

  it('ensureIdentity creates the profile with the peer id', async () => {
    const { chain, requests } = recordingChain();
    await expect((DKGAgent.prototype as any).ensureIdentity.call(provisioningAgent(chain))).resolves.toBe(1n);
    expect(requests).toEqual([{ nodeName: 'core-node', nodeId: new TextEncoder().encode(PEER_ID) }]);
    expect(decodeProfileNodeId(await chain.getProfileNodeId())).toBe(PEER_ID);
  });
});

describe('DKGAgent Profile nodeId methods', () => {
  function recorder() {
    const calls: unknown[][] = [];
    return Object.assign((...args: unknown[]) => { calls.push(args); }, { calls });
  }

  /** Just the fields the three methods read; the chain and log seams are real objects / recorders. */
  function agentLike(chain: ChainAdapter, nodeRole: 'core' | 'edge' = 'core') {
    const log = { info: recorder(), warn: recorder(), error: recorder(), debug: recorder() };
    return {
      chain,
      log,
      config: { nodeRole },
      node: { peerId: { toString: () => PEER_ID } },
      syncProfileNodeId: (DKGAgent.prototype as any).syncProfileNodeId,
    } as any;
  }

  async function reconcile(agent: any) {
    return (DKGAgent.prototype as any).reconcileProfileNodeIdOnStartup.call(agent);
  }

  it('reports the status and syncs through the agent', async () => {
    const chain = await mockWithLegacyProfile();
    const agent = agentLike(chain);
    const status = await (DKGAgent.prototype as any).getProfileNodeIdStatus.call(agent);
    expect(status.state).toBe('legacy');
    const result = await (DKGAgent.prototype as any).syncProfileNodeId.call(agent);
    expect(result.outcome).toBe('updated');
  });

  it('startup reconcile updates a core node and logs one info line', async () => {
    const chain = await mockWithLegacyProfile();
    const agent = agentLike(chain);
    const result = await reconcile(agent);
    expect(result.outcome).toBe('updated');
    expect(agent.log.info.calls).toHaveLength(1);
    expect(String(agent.log.info.calls[0][1])).toContain("now names this node's peer id");
    expect(agent.log.warn.calls).toHaveLength(0);
  });

  it('startup reconcile skips edge nodes and no-chain nodes without touching the chain', async () => {
    const chain = await mockWithLegacyProfile();
    const before = await chain.getProfileNodeId();
    await expect(reconcile(agentLike(chain, 'edge'))).resolves.toBeNull();
    await expect(reconcile(agentLike(new NoChainAdapter()))).resolves.toBeNull();
    await expect(chain.getProfileNodeId()).resolves.toBe(before);
  });

  it('startup reconcile logs an older Profile as info and a clash as a warning', async () => {
    const older = await mockWithLegacyProfile();
    older.profileNodeIdUpdateSupported = false;
    const olderAgent = agentLike(older);
    await expect(reconcile(olderAgent)).resolves.toMatchObject({ outcome: 'unsupported' });
    expect(olderAgent.log.info.calls).toHaveLength(1);
    expect(olderAgent.log.warn.calls).toHaveLength(0);

    const other = new MockChainAdapter();
    await other.ensureProfile({ nodeId: encodeProfileNodeIdHex(OTHER_PEER_ID) });
    const otherAgent = agentLike(other);
    await expect(reconcile(otherAgent)).resolves.toMatchObject({ outcome: 'skipped-other-peer' });
    expect(otherAgent.log.warn.calls).toHaveLength(1);
  });

  it('startup reconcile never throws', async () => {
    const failing = racingChain(async () => { throw new Error('nonce too low'); });
    const agent = agentLike(failing);
    await expect(reconcile(agent)).resolves.toBeNull();
    expect(String(agent.log.warn.calls[0][1])).toContain('Profile nodeId sync failed: nonce too low');

    const bare = agentLike(Object.assign(new NoChainAdapter(), { chainId: 'evm:31337' }) as unknown as ChainAdapter);
    await expect(reconcile(bare)).resolves.toBeNull();
    expect(String(bare.log.info.calls[0][1])).toContain('no Profile nodeId surface');
  });
});
