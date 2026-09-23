/**
 * MockChainAdapter — Profile nodeId surface. The mock is the production
 * offline-mode adapter (`chain: { type: 'mock' }`), so it must behave like the
 * EVM adapter: nodeIds are unique, an unchanged value is a no-op, and a Hub
 * whose Profile predates updateNodeId is reported, not reverted into.
 */
import { describe, expect, it } from 'vitest';
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
