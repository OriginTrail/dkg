/**
 * MockChainAdapter — Profile nodeId surface. The mock is the production
 * offline-mode adapter (`chain: { type: 'mock' }`), so it must behave like the
 * EVM adapter: nodeIds are unique, an unchanged value is a no-op, and a Hub
 * whose Profile predates updateNodeId is reported, not reverted into.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { encodeProfileNodeIdHex } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { ProfileNodeIdTakenError, ProfileNodeIdUpdateUnsupportedError } from '../src/profile-node-id.js';

const PEER_NODE_ID = encodeProfileNodeIdHex('12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy');
const OTHER_PEER_NODE_ID = encodeProfileNodeIdHex('12D3KooWMasqzRrim48ZJM64UyTfHufDTmSG3n3jqwsS5phz8m91');
const OTHER_OPERATOR = '0x' + '2'.repeat(40);

async function events(mock: MockChainAdapter, type: string) {
  const seen: Array<Record<string, unknown>> = [];
  for await (const event of mock.listenForEvents({ eventTypes: [type], fromBlock: 0 })) seen.push(event.data);
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MockChainAdapter Profile nodeId', () => {
  it('creates the profile with the requested nodeId', async () => {
    const mock = new MockChainAdapter();
    const id = await mock.ensureProfile({ nodeId: PEER_NODE_ID });
    await expect(mock.getProfileNodeId()).resolves.toBe(PEER_NODE_ID);
    await expect(mock.getProfileNodeId(id)).resolves.toBe(PEER_NODE_ID);
    await expect(mock.isProfileNodeIdTaken(PEER_NODE_ID)).resolves.toBe(true);
  });

  it('falls back to a random nodeId when another identity holds the requested one', async () => {
    const mock = new MockChainAdapter();
    mock.seedIdentity(OTHER_OPERATOR, 5n);
    await mock.updateProfileNodeId(PEER_NODE_ID, { identityId: 5n });
    await mock.ensureProfile({ nodeId: PEER_NODE_ID });
    const own = await mock.getProfileNodeId();
    expect(own).not.toBe(PEER_NODE_ID);
    expect(ethers.dataLength(own)).toBe(32);
  });

  it('reports a legacy 32-byte nodeId for identities without one, and 0x for unknown ids', async () => {
    const mock = new MockChainAdapter();
    mock.seedIdentity(OTHER_OPERATOR, 5n);
    expect(ethers.dataLength(await mock.getProfileNodeId(5n))).toBe(32);
    await expect(mock.getProfileNodeId(99n)).resolves.toBe('0x');
    await expect(mock.getProfileNodeId()).resolves.toBe('0x');
  });

  it('updates the nodeId once, emits NodeIdUpdated, and is a no-op when unchanged', async () => {
    const mock = new MockChainAdapter();
    const id = await mock.ensureProfile();
    const legacy = await mock.getProfileNodeId();

    const updated = await mock.updateProfileNodeId(PEER_NODE_ID);
    expect(updated).toMatchObject({ identityId: id, previousNodeId: legacy, nodeId: PEER_NODE_ID, changed: true });
    expect(updated.tx?.success).toBe(true);
    await expect(mock.getProfileNodeId()).resolves.toBe(PEER_NODE_ID);
    // The old value is released.
    await expect(mock.isProfileNodeIdTaken(legacy)).resolves.toBe(false);

    await expect(mock.updateProfileNodeId(PEER_NODE_ID)).resolves.toEqual({
      identityId: id,
      previousNodeId: PEER_NODE_ID,
      nodeId: PEER_NODE_ID,
      changed: false,
    });
    expect(await events(mock, 'NodeIdUpdated')).toEqual([
      { identityId: id.toString(), oldNodeId: legacy, newNodeId: PEER_NODE_ID },
    ]);
  });

  it("rejects another identity's nodeId and models an older Profile", async () => {
    const mock = new MockChainAdapter();
    mock.seedIdentity(OTHER_OPERATOR, 5n);
    await mock.updateProfileNodeId(OTHER_PEER_NODE_ID, { identityId: 5n });
    await mock.ensureProfile();

    await expect(mock.updateProfileNodeId(OTHER_PEER_NODE_ID)).rejects.toBeInstanceOf(ProfileNodeIdTakenError);

    mock.profileNodeIdUpdateSupported = false;
    await expect(mock.getProfileNodeIdUpdateSupport()).resolves.toMatchObject({
      supported: false,
      profileVersion: '10.0.2',
      requiredVersion: '10.1.0',
    });
    await expect(mock.updateProfileNodeId(PEER_NODE_ID)).rejects.toBeInstanceOf(ProfileNodeIdUpdateUnsupportedError);
  });

  it('refuses a signer without an identity', async () => {
    const mock = new MockChainAdapter();
    await expect(mock.updateProfileNodeId(PEER_NODE_ID)).rejects.toThrow(/no on-chain profile/);
  });
});

// The same order and errors as the EVM adapter (evm-adapter-profile-node-id.unit.test.ts).
describe('MockChainAdapter updateProfileNodeId check order', () => {
  /** Records the chain-facing lookups updateProfileNodeId makes, in order. */
  function recordLookups(mock: MockChainAdapter): string[] {
    const calls: string[] = [];
    for (const name of ['getIdentityId', 'getProfileNodeIdUpdateSupport', 'getProfileNodeId'] as const) {
      const original = mock[name].bind(mock) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(mock, name).mockImplementation(((...args: unknown[]) => {
        calls.push(name);
        return original(...args);
      }) as never);
    }
    return calls;
  }

  it('rejects malformed input before any lookup, even without an identity', async () => {
    const mock = new MockChainAdapter();
    const calls = recordLookups(mock);
    await expect(mock.updateProfileNodeId('0x')).rejects.toThrow('updateProfileNodeId: nodeId is empty');
    expect(calls).toEqual([]);
  });

  it('refuses a node without an identity before probing the Profile', async () => {
    const mock = new MockChainAdapter();
    mock.profileNodeIdUpdateSupported = false;
    const calls = recordLookups(mock);
    await expect(mock.updateProfileNodeId(PEER_NODE_ID))
      .rejects.toThrow('updateProfileNodeId: node has no on-chain profile (create a profile first).');
    expect(calls).toEqual(['getIdentityId']);
  });

  it('reports an older Profile before reading the nodeId, even for an unchanged value', async () => {
    const mock = new MockChainAdapter();
    await mock.ensureProfile({ nodeId: PEER_NODE_ID });
    mock.profileNodeIdUpdateSupported = false;
    const calls = recordLookups(mock);
    await expect(mock.updateProfileNodeId(PEER_NODE_ID)).rejects.toBeInstanceOf(ProfileNodeIdUpdateUnsupportedError);
    expect(calls).toEqual(['getIdentityId', 'getProfileNodeIdUpdateSupport']);
  });

  it('refuses an identity whose profile is gone before the taken check, writing nothing', async () => {
    const mock = new MockChainAdapter();
    mock.seedIdentity(OTHER_OPERATOR, 5n);
    await mock.updateProfileNodeId(PEER_NODE_ID, { identityId: 5n });
    const calls = recordLookups(mock);

    // Identity 99 has no profile, and another identity holds the value.
    await expect(mock.updateProfileNodeId(PEER_NODE_ID, { identityId: 99n }))
      .rejects.toThrow('updateProfileNodeId: identity 99 has no on-chain profile.');
    expect(calls).toEqual(['getProfileNodeIdUpdateSupport', 'getProfileNodeId']);
    await expect(mock.getProfileNodeId(99n)).resolves.toBe('0x');
    expect(await events(mock, 'NodeIdUpdated')).toHaveLength(1);
  });

  it("treats the identity's own nodeId as unchanged, not as taken", async () => {
    const mock = new MockChainAdapter();
    const id = await mock.ensureProfile({ nodeId: PEER_NODE_ID });
    await expect(mock.isProfileNodeIdTaken(PEER_NODE_ID)).resolves.toBe(true);
    await expect(mock.updateProfileNodeId(PEER_NODE_ID)).resolves.toEqual({
      identityId: id,
      previousNodeId: PEER_NODE_ID,
      nodeId: PEER_NODE_ID,
      changed: false,
    });
  });

  it('refuses a taken nodeId, writing nothing', async () => {
    const mock = new MockChainAdapter();
    mock.seedIdentity(OTHER_OPERATOR, 5n);
    await mock.updateProfileNodeId(PEER_NODE_ID, { identityId: 5n });
    await mock.ensureProfile();
    const own = await mock.getProfileNodeId();

    await expect(mock.updateProfileNodeId(PEER_NODE_ID)).rejects.toBeInstanceOf(ProfileNodeIdTakenError);
    await expect(mock.getProfileNodeId()).resolves.toBe(own);
    expect(await events(mock, 'NodeIdUpdated')).toHaveLength(1);
  });
});
