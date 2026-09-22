import { describe, expect, it, vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import {
  createOnChainCorePeerResolver,
  type OnChainCorePeerResolverDeps,
} from '../src/authority-index-core-discovery.js';

const RELAY_A = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const RELAY_B = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const CORE = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const SELF = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const relayAddress = (peer: string, host = '127.0.0.1') => `/ip4/${host}/tcp/9200/p2p/${peer}`;
const NOW = Date.parse('2026-09-22T12:00:00Z');
const HOUR_MS = 60 * 60 * 1_000;
const fresh = new Date(NOW - HOUR_MS).toISOString();
const stale = new Date(NOW - 48 * HOUR_MS).toISOString();
const core = (peerId: string, agentAddress: string | undefined = `0x${peerId.slice(-8).padStart(40, '0')}`, lastSeen = fresh) => ({
  peerId, nodeRole: 'core', agentAddress, lastSeen,
});
const signal = () => new AbortController().signal;

function resolver(overrides: Partial<OnChainCorePeerResolverDeps> = {}) {
  const deps = {
    selfPeerId: SELF,
    findAgents: vi.fn(async () => [core(CORE)]),
    networkRelays: [] as string[],
    isConnected: vi.fn(() => true),
    getIdentityIdForAddress: vi.fn(async () => 7n),
    isShardingTableMember: vi.fn(async () => true),
    staleThresholdMs: 24 * HOUR_MS,
    now: () => NOW,
    ...overrides,
  };
  return { deps, resolve: createOnChainCorePeerResolver(deps) };
}

describe('on-chain core peer discovery', () => {
  it('lists relays first in file order, connected ones ahead, then verified cores over their live connection', async () => {
    const connected = new Set([RELAY_B, CORE]);
    const { resolve, deps } = resolver({
      networkRelays: [relayAddress(RELAY_A), relayAddress(RELAY_B, '10.0.0.2')],
      isConnected: vi.fn((peerId: string) => connected.has(peerId)),
    });
    await expect(resolve.resolve(signal())).resolves.toEqual([
      { peerId: RELAY_B, multiaddr: relayAddress(RELAY_B, '10.0.0.2') },
      { peerId: RELAY_A, multiaddr: relayAddress(RELAY_A) },
      { peerId: CORE },
    ]);
    expect(deps.getIdentityIdForAddress).toHaveBeenCalledExactlyOnceWith(core(CORE).agentAddress);
    expect(deps.isShardingTableMember).toHaveBeenCalledExactlyOnceWith(7n);
  });

  it('keeps a relay that the phonebook also lists once, with its configured address', async () => {
    const { resolve, deps } = resolver({
      networkRelays: [relayAddress(RELAY_A)],
      findAgents: vi.fn(async () => [core(RELAY_A), core(CORE)]),
    });
    await expect(resolve.resolve(signal())).resolves.toEqual([
      { peerId: RELAY_A, multiaddr: relayAddress(RELAY_A) },
      { peerId: CORE },
    ]);
    expect(deps.getIdentityIdForAddress).toHaveBeenCalledOnce();
  });

  it('canonicalizes relay identities and skips relay entries without a final /p2p component', async () => {
    const cid = peerIdFromString(RELAY_A).toCID().toString();
    const { resolve } = resolver({
      networkRelays: ['/ip4/127.0.0.1/tcp/9200', 'not a multiaddr', relayAddress(cid)],
      findAgents: vi.fn(async () => []),
    });
    await expect(resolve.resolve(signal())).resolves.toEqual([
      { peerId: RELAY_A, multiaddr: relayAddress(cid) },
    ]);
  });

  it.each([
    ['not a ShardingTable member', { isShardingTableMember: vi.fn(async () => false) }],
    ['without an on-chain identity', { getIdentityIdForAddress: vi.fn(async () => 0n) }],
    ['when the identity lookup is unavailable', { getIdentityIdForAddress: undefined }],
    ['when the membership lookup is unavailable', { isShardingTableMember: undefined }],
    ['when the membership lookup throws', { isShardingTableMember: vi.fn(async () => { throw new Error('rpc down'); }) }],
  ])('fails closed for a phonebook core %s', async (_label, overrides) => {
    const { resolve } = resolver({ networkRelays: [relayAddress(RELAY_A)], ...overrides });
    await expect(resolve.resolve(signal())).resolves.toEqual([
      { peerId: RELAY_A, multiaddr: relayAddress(RELAY_A) },
    ]);
  });

  it('fails closed for a core profile without an operational address', async () => {
    const { resolve, deps } = resolver({
      findAgents: vi.fn(async () => [
        { peerId: CORE, nodeRole: 'core', lastSeen: fresh },
        { peerId: RELAY_B, nodeRole: 'core', agentAddress: '', lastSeen: fresh },
      ]),
    });
    await expect(resolve.resolve(signal())).resolves.toEqual([]);
    expect(deps.getIdentityIdForAddress).not.toHaveBeenCalled();
  });

  it('reuses a membership verdict per address until it expires', async () => {
    let now = NOW;
    const { resolve, deps } = resolver({
      now: () => now,
      verdictTtlMs: 1_000,
      findAgents: vi.fn(async () => [core(CORE, '0xABCDEF0000000000000000000000000000000001')]),
    });
    await resolve.resolve(signal());
    deps.findAgents.mockResolvedValue([core(CORE, '0xabcdef0000000000000000000000000000000001')]);
    now += 999;
    await expect(resolve.resolve(signal())).resolves.toEqual([{ peerId: CORE }]);
    expect(deps.getIdentityIdForAddress).toHaveBeenCalledOnce();
    now += 1;
    await expect(resolve.resolve(signal())).resolves.toEqual([{ peerId: CORE }]);
    expect(deps.getIdentityIdForAddress).toHaveBeenCalledTimes(2);
  });

  it('caches a denial but never a failed lookup', async () => {
    const { resolve, deps } = resolver({
      isShardingTableMember: vi.fn(async () => { throw new Error('rpc down'); }),
    });
    await expect(resolve.resolve(signal())).resolves.toEqual([]);
    deps.isShardingTableMember.mockResolvedValue(false);
    await expect(resolve.resolve(signal())).resolves.toEqual([]);
    await expect(resolve.resolve(signal())).resolves.toEqual([]);
    expect(deps.isShardingTableMember).toHaveBeenCalledTimes(2);
  });

  it('ignores itself, edges and stale cores, and asks the freshest core first', async () => {
    const { resolve, deps } = resolver({
      findAgents: vi.fn(async () => [
        core('older-core', '0x2', new Date(NOW - 2 * HOUR_MS).toISOString()),
        { ...core('edge-peer'), nodeRole: 'edge' },
        core(SELF),
        core('stale-core', '0x1', stale),
        core('fresh-core'),
        { ...core('freshness-unknown'), lastSeen: undefined },
      ]),
    });
    await expect(resolve.resolve(signal())).resolves.toEqual([
      { peerId: 'fresh-core' },
      { peerId: 'older-core' },
      { peerId: 'freshness-unknown' },
    ]);
    expect(deps.getIdentityIdForAddress).not.toHaveBeenCalledWith('0x1');
  });

  it('drops a verified core without a live connection instead of inventing a dial address', async () => {
    const { resolve, deps } = resolver({
      findAgents: vi.fn(async () => [core('offline-core'), core(CORE)]),
      isConnected: vi.fn((peerId: string) => peerId === CORE),
    });
    await expect(resolve.resolve(signal())).resolves.toEqual([{ peerId: CORE }]);
    expect(deps.getIdentityIdForAddress).toHaveBeenCalledOnce();
  });

  it('caps the trust set at eight identities counting relays, without verifying beyond it', async () => {
    const { resolve, deps } = resolver({
      networkRelays: [relayAddress(RELAY_A), relayAddress(RELAY_B)],
      findAgents: vi.fn(async () => Array.from({ length: 10 }, (_, index) => core(`core-${index}`))),
    });
    const peers = await resolve.resolve(signal());
    expect(peers.map((peer) => peer.peerId)).toEqual([
      RELAY_A, RELAY_B, 'core-0', 'core-1', 'core-2', 'core-3', 'core-4', 'core-5',
    ]);
    expect(deps.getIdentityIdForAddress).toHaveBeenCalledTimes(6);
  });

  it('honours cancellation before and between lookups', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error('node stopped'));
    const { resolve, deps } = resolver();
    await expect(resolve.resolve(aborted.signal)).rejects.toThrow('node stopped');
    expect(deps.findAgents).not.toHaveBeenCalled();

    const controller = new AbortController();
    deps.findAgents.mockImplementation(async () => {
      controller.abort(new Error('stopped while listing'));
      return [core(CORE)];
    });
    await expect(resolve.resolve(controller.signal)).rejects.toThrow('stopped while listing');
    expect(deps.getIdentityIdForAddress).not.toHaveBeenCalled();
  });
});
