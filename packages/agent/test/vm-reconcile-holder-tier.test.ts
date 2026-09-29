import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  VM_HOLDER_TIER_FAILURE_RETRY_MS,
  VM_HOLDER_TIER_IDENTITY_TTL_MS,
  VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS,
  VM_HOLDER_TIER_MAX_PEERS,
  VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS,
  VM_HOLDER_TIER_PEERS_PER_IDENTITY,
  VM_HOLDER_TIER_RESOLUTION_TTL_MS,
  VM_HOLDER_TIER_STALE_MAX_MS,
  VmHolderHintResolver,
  appendVmHolderTier,
  nextVmHolderTierEntry,
  normalizeHolderProfileWallet,
  resolveHolderPeerHints,
  sameVmHolderPeerIds,
  type HolderProfileHint,
  type VmHolderHintDeps,
  type VmHolderIdentityCache,
} from '../src/vm-reconcile-holder-tier.js';

const WALLET_A = '0x00000000000000000000000000000000000000a1';
const WALLET_B = '0x00000000000000000000000000000000000000b2';
const WALLET_C = '0x00000000000000000000000000000000000000c3';
const SELF = '12D3KooWSelf';

function wallet(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

interface Fixture {
  deps: VmHolderHintDeps;
  identities: Map<string, bigint | undefined>;
  lookups: string[];
  table: bigint[] | undefined;
  rows: HolderProfileHint[];
  clock: { now: number };
}

/** A chain that knows `identities` and a ShardingTable of `table`, plus phonebook `rows`. */
function fixture(options: {
  table?: bigint[] | undefined;
  identities?: Record<string, bigint>;
  rows?: HolderProfileHint[];
}): Fixture {
  const lookups: string[] = [];
  const identities = new Map<string, bigint | undefined>(
    Object.entries(options.identities ?? {}).map(([address, id]) => [address.toLowerCase(), id]),
  );
  const state: Fixture = {
    deps: undefined as unknown as VmHolderHintDeps,
    identities,
    lookups,
    table: 'table' in options ? options.table : [],
    rows: options.rows ?? [],
    clock: { now: 1_000_000 },
  };
  state.deps = {
    listShardingTableIdentityIds: async () => state.table,
    getIdentityIdForAddress: async (address) => {
      lookups.push(address.toLowerCase());
      return identities.has(address.toLowerCase()) ? identities.get(address.toLowerCase()) : 0n;
    },
    listCoreProfileHints: async (limit) => state.rows.slice(0, limit),
    selfPeerId: () => SELF,
    now: () => state.clock.now,
    wallClockNow: () => Date.parse('2026-09-30T12:00:00.000Z'),
  };
  return state;
}

const cache = (): VmHolderIdentityCache => new Map();

describe('normalizeHolderProfileWallet', () => {
  it.each([
    WALLET_A,
    WALLET_A.toUpperCase().replace('0X', '0x'),
    `  ${WALLET_B}  `,
  ])('checksums the well-formed address %j', (input) => {
    expect(normalizeHolderProfileWallet(input)).toBe(ethers.getAddress(input.trim().toLowerCase()));
  });

  it('accepts an address whose mixed-case checksum is wrong, keyed by its bytes', () => {
    const good = ethers.getAddress(WALLET_C);
    const flipped = good.replace(/[a-f]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    expect(flipped).not.toBe(good);
    expect(normalizeHolderProfileWallet(flipped)).toBe(good);
  });

  it.each([
    undefined,
    '',
    '   ',
    '0x',
    '0x1234',
    'not-an-address',
    '0xZZ00000000000000000000000000000000000000',
    `${WALLET_A}00`,
    '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo',
  ])('has nothing to verify for %j', (input) => {
    expect(normalizeHolderProfileWallet(input as string | undefined)).toBeUndefined();
  });
});

describe('resolveHolderPeerHints', () => {
  it('maps a ShardingTable identity to the peer of a profile bound to its wallet', async () => {
    const f = fixture({
      table: [7n, 8n],
      identities: { [WALLET_A]: 7n, [WALLET_B]: 8n },
      rows: [
        { peerId: 'peer-b', agentAddress: WALLET_B },
        { peerId: 'peer-a', agentAddress: WALLET_A },
      ],
    });
    const resolution = await resolveHolderPeerHints(f.deps, cache());
    expect(resolution).toEqual({
      kind: 'resolved',
      peerIds: ['peer-a', 'peer-b'],
      stats: { profiles: 2, unbound: 0, unmatched: 0, identities: 2 },
    });
  });

  it('rejects a profile without a bound operational wallet without asking the chain about it', async () => {
    const f = fixture({
      table: [7n],
      identities: { [WALLET_A]: 7n },
      rows: [
        { peerId: 'peer-no-address' },
        { peerId: 'peer-empty-address', agentAddress: '' },
        { peerId: 'peer-blank-address', agentAddress: '   ' },
        { peerId: 'peer-junk-address', agentAddress: 'did:dkg:agent:nope' },
        { peerId: 'peer-good', agentAddress: WALLET_A },
      ],
    });
    const resolution = await resolveHolderPeerHints(f.deps, cache());
    expect(resolution).toMatchObject({
      kind: 'resolved',
      peerIds: ['peer-good'],
      stats: { profiles: 5, unbound: 4, unmatched: 0, identities: 1 },
    });
    // The only wallet ever sent to the chain is the well-formed one.
    expect(f.lookups).toEqual([WALLET_A]);
  });

  it('rejects a wallet whose identity is not in the ShardingTable, or that has none', async () => {
    const f = fixture({
      table: [7n],
      identities: { [WALLET_A]: 7n, [WALLET_B]: 99n },
      rows: [
        { peerId: 'peer-a', agentAddress: WALLET_A },
        { peerId: 'peer-staked-elsewhere', agentAddress: WALLET_B },
        { peerId: 'peer-unregistered', agentAddress: WALLET_C },
      ],
    });
    const resolution = await resolveHolderPeerHints(f.deps, cache());
    expect(resolution).toMatchObject({
      kind: 'resolved',
      peerIds: ['peer-a'],
      stats: { unbound: 0, unmatched: 2, identities: 1 },
    });
  });

  it('ignores an identity-zero table entry and never treats identity 0 as a member', async () => {
    const f = fixture({
      table: [0n],
      identities: { [WALLET_A]: 0n },
      rows: [{ peerId: 'peer-a', agentAddress: WALLET_A }],
    });
    expect(await resolveHolderPeerHints(f.deps, cache())).toMatchObject({
      kind: 'resolved',
      peerIds: [],
    });
    // No member, so no wallet is worth an RPC.
    expect(f.lookups).toEqual([]);
  });

  it('never returns this node, even when its own profile is bound', async () => {
    const f = fixture({
      table: [7n],
      identities: { [WALLET_A]: 7n },
      rows: [
        { peerId: SELF, agentAddress: WALLET_A },
        { peerId: 'peer-a', agentAddress: WALLET_A },
      ],
    });
    expect(await resolveHolderPeerHints(f.deps, cache())).toMatchObject({
      peerIds: ['peer-a'],
    });
  });

  it('caps peers per identity, freshest first, and ignores a lastSeen claimed from the future', async () => {
    const f = fixture({
      table: [7n],
      identities: { [WALLET_A]: 7n },
      rows: [
        { peerId: 'peer-old', agentAddress: WALLET_A, lastSeen: '2026-01-01T00:00:00.000Z' },
        { peerId: 'peer-fresh', agentAddress: WALLET_A, lastSeen: '2026-09-30T11:59:00.000Z' },
        { peerId: 'peer-mid', agentAddress: WALLET_A, lastSeen: '2026-09-01T00:00:00.000Z' },
        // A forged far-future stamp must not outrank the honest peers forever.
        { peerId: 'peer-forged', agentAddress: WALLET_A, lastSeen: '2099-01-01T00:00:00.000Z' },
        { peerId: 'peer-garbage', agentAddress: WALLET_A, lastSeen: 'yesterday' },
      ],
    });
    const resolution = await resolveHolderPeerHints(f.deps, cache());
    expect(resolution).toMatchObject({ kind: 'resolved' });
    expect(VM_HOLDER_TIER_PEERS_PER_IDENTITY).toBe(2);
    if (resolution.kind === 'resolved') {
      expect(resolution.peerIds).toEqual(['peer-fresh', 'peer-mid']);
    }
  });

  it('spreads the overall cap across identities instead of spending it on the lowest ids', async () => {
    const identityCount = VM_HOLDER_TIER_MAX_PEERS + 8;
    const identities: Record<string, bigint> = {};
    const rows: HolderProfileHint[] = [];
    for (let id = 1; id <= identityCount; id += 1) {
      identities[wallet(id)] = BigInt(id);
      // Two peers per identity, so a naive id-order fill would keep 16 identities.
      rows.push({ peerId: `peer-${String(id).padStart(3, '0')}-a`, agentAddress: wallet(id) });
      rows.push({ peerId: `peer-${String(id).padStart(3, '0')}-b`, agentAddress: wallet(id) });
    }
    const f = fixture({
      table: Array.from({ length: identityCount }, (_, i) => BigInt(i + 1)),
      identities,
      rows: rows.slice(0, 256),
    });
    const resolution = await resolveHolderPeerHints(f.deps, cache());
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    expect(resolution.peerIds).toHaveLength(VM_HOLDER_TIER_MAX_PEERS);
    // Every kept identity contributes its first peer before any contributes a second.
    const firsts = resolution.peerIds.filter((peerId) => peerId.endsWith('-a'));
    expect(firsts).toHaveLength(VM_HOLDER_TIER_MAX_PEERS);
    expect([...resolution.peerIds]).toEqual([...resolution.peerIds].sort());
  });

  it('bounds the wallet reads of one resolution', async () => {
    const identities: Record<string, bigint> = {};
    const rows: HolderProfileHint[] = [];
    for (let id = 1; id <= VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS + 20; id += 1) {
      identities[wallet(id)] = BigInt(id);
      rows.push({ peerId: `peer-${id}`, agentAddress: wallet(id) });
    }
    const f = fixture({
      table: Array.from({ length: VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS + 20 }, (_, i) => BigInt(i + 1)),
      identities,
      rows,
    });
    await resolveHolderPeerHints(f.deps, cache());
    expect(new Set(f.lookups).size).toBe(VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS);
  });

  describe('closed for routing when a fact cannot be established', () => {
    const rows: HolderProfileHint[] = [{ peerId: 'peer-a', agentAddress: WALLET_A }];

    it('reports the chain as unable to answer when the ShardingTable read is unsupported', async () => {
      const f = fixture({ table: undefined, identities: { [WALLET_A]: 7n }, rows });
      expect(await resolveHolderPeerHints(f.deps, cache())).toEqual({
        kind: 'unavailable',
        reason: 'chain-cannot-answer',
      });
      expect(f.lookups).toEqual([]);
    });

    it('reports a failed ShardingTable read', async () => {
      const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
      f.deps = { ...f.deps, listShardingTableIdentityIds: async () => { throw new Error('rpc down'); } };
      expect(await resolveHolderPeerHints(f.deps, cache())).toEqual({
        kind: 'unavailable',
        reason: 'sharding-table-read-failed',
      });
    });

    it('reports a failed phonebook read', async () => {
      const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
      f.deps = { ...f.deps, listCoreProfileHints: async () => { throw new Error('store down'); } };
      expect(await resolveHolderPeerHints(f.deps, cache())).toEqual({
        kind: 'unavailable',
        reason: 'phonebook-read-failed',
      });
    });

    it('reports a chain that cannot resolve a wallet to an identity', async () => {
      const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
      f.deps = { ...f.deps, getIdentityIdForAddress: async () => undefined };
      expect(await resolveHolderPeerHints(f.deps, cache())).toEqual({
        kind: 'unavailable',
        reason: 'chain-cannot-answer',
      });
    });

    it('voids the whole answer on one failed wallet read and stops issuing the rest', async () => {
      const wallets = Array.from({ length: 40 }, (_, i) => wallet(i + 1));
      const f = fixture({
        table: [1n],
        identities: {},
        rows: wallets.map((address, i) => ({ peerId: `peer-${i}`, agentAddress: address })),
      });
      let calls = 0;
      f.deps = {
        ...f.deps,
        getIdentityIdForAddress: async () => {
          calls += 1;
          throw new Error('rpc down');
        },
      };
      expect(await resolveHolderPeerHints(f.deps, cache())).toEqual({
        kind: 'unavailable',
        reason: 'identity-read-failed',
      });
      // Only the reads already in flight when the first one failed.
      expect(calls).toBeLessThanOrEqual(8);
    });

    it('propagates the caller abort instead of hiding it as an unavailable read', async () => {
      const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
      const controller = new AbortController();
      f.deps = {
        ...f.deps,
        listShardingTableIdentityIds: async () => {
          controller.abort(new Error('caller gone'));
          throw new Error('aborted mid-read');
        },
      };
      await expect(resolveHolderPeerHints(f.deps, cache(), controller.signal))
        .rejects.toThrow('caller gone');
    });
  });

  describe('identity cache', () => {
    const rows: HolderProfileHint[] = [
      { peerId: 'peer-a', agentAddress: WALLET_A },
      { peerId: 'peer-unregistered', agentAddress: WALLET_C },
    ];

    it('reuses a positive answer until its TTL and a negative one for a shorter time', async () => {
      const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
      const shared = cache();
      await resolveHolderPeerHints(f.deps, shared);
      expect(f.lookups).toEqual([WALLET_A, WALLET_C]);

      f.lookups.length = 0;
      f.clock.now += VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS - 1;
      await resolveHolderPeerHints(f.deps, shared);
      expect(f.lookups).toEqual([]);

      // The unregistered wallet registers meanwhile; only its short negative entry expired.
      f.identities.set(WALLET_C, 7n);
      f.clock.now += 2;
      const resolution = await resolveHolderPeerHints(f.deps, shared);
      expect(f.lookups).toEqual([WALLET_C]);
      expect(resolution).toMatchObject({ peerIds: ['peer-a', 'peer-unregistered'] });

      f.lookups.length = 0;
      f.clock.now += VM_HOLDER_TIER_IDENTITY_TTL_MS;
      await resolveHolderPeerHints(f.deps, shared);
      expect(f.lookups).toEqual([WALLET_A, WALLET_C]);
    });
  });
});

describe('VmHolderHintResolver', () => {
  const rows: HolderProfileHint[] = [{ peerId: 'peer-a', agentAddress: WALLET_A }];

  function resolverFor(f: Fixture) {
    const listTable = vi.fn(f.deps.listShardingTableIdentityIds);
    f.deps = { ...f.deps, listShardingTableIdentityIds: listTable };
    return { resolver: new VmHolderHintResolver(f.deps), listTable };
  }

  it('reads once per TTL and serves the cached answer to every caller', async () => {
    const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
    const { resolver, listTable } = resolverFor(f);
    const first = await resolver.resolve();
    expect(first).toMatchObject({ kind: 'resolved', peerIds: ['peer-a'] });
    expect(await resolver.resolve()).toBe(first);
    expect(listTable).toHaveBeenCalledTimes(1);

    f.clock.now += VM_HOLDER_TIER_RESOLUTION_TTL_MS;
    await resolver.resolve();
    expect(listTable).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent callers into one read', async () => {
    const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
    const { resolver, listTable } = resolverFor(f);
    const [a, b, c] = await Promise.all([resolver.resolve(), resolver.resolve(), resolver.resolve()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(listTable).toHaveBeenCalledTimes(1);
  });

  it('remembers an unavailable answer only for the short failure spacing', async () => {
    const f = fixture({ table: undefined, identities: {}, rows });
    const { resolver, listTable } = resolverFor(f);
    expect(await resolver.resolve()).toEqual({ kind: 'unavailable', reason: 'chain-cannot-answer' });
    await resolver.resolve();
    expect(listTable).toHaveBeenCalledTimes(1);

    f.clock.now += VM_HOLDER_TIER_FAILURE_RETRY_MS;
    f.table = [7n];
    f.identities.set(WALLET_A, 7n);
    expect(await resolver.resolve()).toMatchObject({ kind: 'resolved', peerIds: ['peer-a'] });
    expect(listTable).toHaveBeenCalledTimes(2);
  });

  it('forgets the cached answer on invalidate, including one still being read', async () => {
    const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
    const { resolver, listTable } = resolverFor(f);
    await resolver.resolve();
    resolver.invalidate();
    await resolver.resolve();
    expect(listTable).toHaveBeenCalledTimes(2);

    // An invalidate that lands mid-read must not let that read repopulate the cache.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
    const slowList = vi.fn(async () => { await gate; return [7n] as bigint[]; });
    slow.deps = { ...slow.deps, listShardingTableIdentityIds: slowList };
    const slowResolver = new VmHolderHintResolver(slow.deps);
    const pending = slowResolver.resolve();
    await Promise.resolve();
    slowResolver.invalidate();
    release();
    await pending;
    await slowResolver.resolve();
    expect(slowList).toHaveBeenCalledTimes(2);
  });

  it('lets one caller abort its wait without cancelling the shared read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
    const list = vi.fn(async () => { await gate; return [7n] as bigint[]; });
    f.deps = { ...f.deps, listShardingTableIdentityIds: list };
    const resolver = new VmHolderHintResolver(f.deps);
    const controller = new AbortController();
    const impatient = resolver.resolve(controller.signal);
    const patient = resolver.resolve();
    controller.abort(new Error('caller gone'));
    await expect(impatient).rejects.toThrow('caller gone');
    release();
    expect(await patient).toMatchObject({ kind: 'resolved', peerIds: ['peer-a'] });
    expect(list).toHaveBeenCalledTimes(1);
    await expect(resolver.resolve(AbortSignal.abort(new Error('already gone')))).resolves.toMatchObject({
      kind: 'resolved',
    });
  });

  it('reports a read that outlives its wall-clock bound as unavailable', async () => {
    const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
    f.deps = {
      ...f.deps,
      listShardingTableIdentityIds: (signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    };
    const resolver = new VmHolderHintResolver(f.deps, { resolutionTimeoutMs: 20 });
    expect(await resolver.resolve()).toEqual({ kind: 'unavailable', reason: 'timeout' });
  });
});

describe('nextVmHolderTierEntry', () => {
  const resolved = (peerIds: string[]) => ({
    kind: 'resolved' as const,
    peerIds,
    stats: { profiles: peerIds.length, unbound: 0, unmatched: 0, identities: peerIds.length },
  });
  const unavailable = { kind: 'unavailable' as const, reason: 'sharding-table-read-failed' as const };

  it('replaces the entry with a resolved answer, empty included', () => {
    const previous = { peerIds: ['old'], resolvedAt: 0, nextCheckAt: 0 };
    expect(nextVmHolderTierEntry(previous, resolved(['a']), 100)).toEqual({
      peerIds: ['a'],
      resolvedAt: 100,
      nextCheckAt: 100 + VM_HOLDER_TIER_RESOLUTION_TTL_MS,
    });
    expect(nextVmHolderTierEntry(previous, resolved([]), 100).peerIds).toEqual([]);
  });

  it('gives a private or unknown-policy graph an empty tier at the normal cadence', () => {
    expect(nextVmHolderTierEntry(
      { peerIds: ['old'], resolvedAt: 0, nextCheckAt: 0 },
      { kind: 'not-public' },
      50,
    )).toEqual({ peerIds: [], resolvedAt: 50, nextCheckAt: 50 + VM_HOLDER_TIER_RESOLUTION_TTL_MS });
  });

  it('keeps a previous set through a short outage without extending its age', () => {
    const previous = { peerIds: ['a', 'b'], resolvedAt: 1_000, nextCheckAt: 2_000 };
    const now = 1_000 + VM_HOLDER_TIER_STALE_MAX_MS - 1;
    expect(nextVmHolderTierEntry(previous, unavailable, now)).toEqual({
      peerIds: ['a', 'b'],
      resolvedAt: 1_000,
      nextCheckAt: now + VM_HOLDER_TIER_FAILURE_RETRY_MS,
    });
  });

  it('drops a set the chain has not confirmed within the staleness bound', () => {
    const previous = { peerIds: ['a'], resolvedAt: 1_000, nextCheckAt: 2_000 };
    const now = 1_000 + VM_HOLDER_TIER_STALE_MAX_MS;
    expect(nextVmHolderTierEntry(previous, unavailable, now)).toEqual({
      peerIds: [],
      resolvedAt: now,
      nextCheckAt: now + VM_HOLDER_TIER_FAILURE_RETRY_MS,
    });
  });

  it('starts empty when the first read is unavailable', () => {
    expect(nextVmHolderTierEntry(undefined, unavailable, 10)).toEqual({
      peerIds: [],
      resolvedAt: 10,
      nextCheckAt: 10 + VM_HOLDER_TIER_FAILURE_RETRY_MS,
    });
  });
});

describe('appendVmHolderTier', () => {
  it('appends hinted peers behind the existing roster and leaves it untouched', () => {
    const roster = ['curator', 'connected-1', 'connected-2'];
    expect(appendVmHolderTier(roster, ['holder-1', 'holder-2'], SELF, 16))
      .toEqual([...roster, 'holder-1', 'holder-2']);
    expect(roster).toEqual(['curator', 'connected-1', 'connected-2']);
  });

  it('returns an identical copy when there is nothing to add', () => {
    const roster = ['a', 'b'];
    const same = appendVmHolderTier(roster, [], SELF, 16);
    expect(same).toEqual(roster);
    expect(same).not.toBe(roster);
  });

  it('deduplicates against the roster and against itself, and never adds this node', () => {
    expect(appendVmHolderTier(
      ['curator', 'connected'],
      ['connected', 'holder', 'holder', SELF, 'curator'],
      SELF,
      16,
    )).toEqual(['curator', 'connected', 'holder']);
  });

  it('only fills capacity the existing tiers left free', () => {
    expect(appendVmHolderTier(['a', 'b', 'c'], ['h1', 'h2', 'h3'], SELF, 5))
      .toEqual(['a', 'b', 'c', 'h1', 'h2']);
    // A full roster keeps every member and gains nothing: no tier is displaced.
    expect(appendVmHolderTier(['a', 'b', 'c'], ['h1'], SELF, 3)).toEqual(['a', 'b', 'c']);
    expect(appendVmHolderTier(['a', 'b', 'c', 'd'], ['h1'], SELF, 3)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('sameVmHolderPeerIds', () => {
  it('compares members and ignores order', () => {
    expect(sameVmHolderPeerIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameVmHolderPeerIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameVmHolderPeerIds(['a', 'b'], ['a', 'c'])).toBe(false);
    expect(sameVmHolderPeerIds([], [])).toBe(true);
  });
});
