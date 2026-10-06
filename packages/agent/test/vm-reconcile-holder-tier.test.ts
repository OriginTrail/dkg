import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  VM_HOLDER_TIER_CARRY_TTL_MS,
  VM_HOLDER_TIER_FAILURE_RETRY_MS,
  VM_HOLDER_TIER_IDENTITY_TTL_MS,
  VM_HOLDER_TIER_LOOKUP_CONCURRENCY,
  VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS,
  VM_HOLDER_TIER_MAX_PEERS,
  VM_HOLDER_TIER_MAX_PROFILE_PAGES,
  VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS,
  VM_HOLDER_TIER_PEERS_PER_IDENTITY,
  VM_HOLDER_TIER_PROFILE_PAGE_SIZE,
  VM_HOLDER_TIER_RESOLUTION_TTL_MS,
  VM_HOLDER_TIER_STALE_MAX_MS,
  VmHolderHintResolver,
  appendVmHolderTier,
  nextVmHolderTierEntry,
  normalizeHolderProfileWallet,
  resolveHolderPeerHints,
  sameVmHolderPeerIds,
  type HolderProfileHint,
  type HolderProfilePageRequest,
  type VmHolderHintDeps,
  type VmHolderHintResolution,
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
  /** Phonebook pages read so far. */
  pageReads: number;
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
    pageReads: 0,
    clock: { now: 1_000_000 },
  };
  state.deps = {
    listShardingTableIdentityIds: async () => state.table,
    getIdentityIdForAddress: async (address) => {
      lookups.push(address.toLowerCase());
      return identities.has(address.toLowerCase()) ? identities.get(address.toLowerCase()) : 0n;
    },
    // Pages `rows` in the order given (tests that walk several windows give them
    // in the phonebook's own (wallet, peer id) order); the cursor is the last row's
    // own key, as the real phonebook's is. The pre-pagination call shape,
    // (limit, signal) answered with an array, is accepted too, so the same tests
    // can be run against the code before it.
    listCoreProfileHints: (async (request: HolderProfilePageRequest | number) => {
      state.pageReads += 1;
      if (typeof request === 'number') return state.rows.slice(0, request);
      const { after } = request;
      const offset = after === undefined
        ? 0
        : state.rows.findIndex((row) => (row.agentAddress ?? '') === after.agentAddress && row.peerId === after.peerId) + 1;
      const hints = state.rows.slice(offset, offset + request.limit);
      const end = offset + hints.length;
      const last = hints[hints.length - 1];
      return {
        hints,
        next: end < state.rows.length && last !== undefined
          ? { agentAddress: last.agentAddress ?? '', peerId: last.peerId }
          : null,
      };
    }) as VmHolderHintDeps['listCoreProfileHints'],
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
      stats: { profiles: 2, unbound: 0, unmatched: 0, identities: 2, pages: 1, lookups: 2, stopped: 'exhausted', rowsLeft: false },
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

  describe('unsigned rows an attacker chooses do not decide which rows are read', () => {
    const FRESH = '2026-09-30T11:59:00.000Z';
    const OLD = '2020-01-01T00:00:00.000Z';
    const junkRow = (i: number): HolderProfileHint => ({
      peerId: `peer-junk-${i}`,
      agentAddress: wallet(0x1000 + i), // well-formed, distinct, registered to nobody
      lastSeen: FRESH,
    });
    const holderRow: HolderProfileHint = { peerId: 'peer-holder', agentAddress: WALLET_A, lastSeen: OLD };
    const holderFixture = (rows: HolderProfileHint[]) => fixture({
      table: [7n],
      identities: { [WALLET_A]: 7n },
      rows,
    });

    it('walks past more fresh junk rows than one page holds and still returns the genuine holder', async () => {
      // 300 junk rows: 200 that share ten wallets, 100 that bind no wallet at all,
      // all fresher than the holder and all ahead of it.
      const rows: HolderProfileHint[] = [
        ...Array.from({ length: 200 }, (_, i) => ({
          peerId: `peer-crowd-${i}`,
          agentAddress: wallet(0x2000 + (i % 10)),
          lastSeen: FRESH,
        })),
        ...Array.from({ length: 100 }, (_, i) => ({ peerId: `peer-unbound-${i}`, agentAddress: `0xnothex${i}`, lastSeen: FRESH })),
        holderRow,
      ];
      expect(rows.length).toBeGreaterThan(VM_HOLDER_TIER_PROFILE_PAGE_SIZE);
      const f = holderFixture(rows);
      const resolution = await resolveHolderPeerHints(f.deps, cache());
      expect(resolution).toMatchObject({ kind: 'resolved', peerIds: ['peer-holder'] });
      // Ten junk wallets and the holder's: one lookup per distinct wallet, however many rows claim it.
      expect(f.lookups).toHaveLength(11);
      expect(new Set(f.lookups).size).toBe(11);
      expect(f.lookups.length).toBeLessThanOrEqual(VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS);
      expect(f.pageReads).toBe(2);
    });

    it('bounds chain work when every junk row uses its own wallet, and continues past it on the next resolutions', async () => {
      const rows = [...Array.from({ length: 600 }, (_, i) => junkRow(i)), holderRow];
      const f = holderFixture(rows);
      const shared = cache();
      const perRound: number[] = [];
      let found = false;
      for (let round = 1; round <= 5 && !found; round += 1) {
        const before = f.lookups.length;
        const resolution = await resolveHolderPeerHints(f.deps, shared);
        expect(resolution.kind).toBe('resolved');
        if (resolution.kind !== 'resolved') return;
        perRound.push(f.lookups.length - before);
        // Bounded however much junk there is: pages and chain lookups per resolution.
        expect(resolution.stats.pages).toBeLessThanOrEqual(VM_HOLDER_TIER_MAX_PROFILE_PAGES);
        expect(resolution.stats.lookups).toBeLessThanOrEqual(VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS);
        found = resolution.peerIds.includes('peer-holder');
        if (!found) {
          // Cut short by the lookup bound, so it is retried on the failure spacing.
          expect(resolution.stats.stopped).toBe('lookup-bound');
          f.clock.now += VM_HOLDER_TIER_FAILURE_RETRY_MS;
        }
      }
      expect(found).toBe(true);
      expect(perRound.every((count) => count <= VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS)).toBe(true);
      // Every wallet was resolved on chain exactly once across the rounds: a junk
      // wallet rejected earlier is remembered, so it never costs its RPC again.
      expect(new Set(f.lookups).size).toBe(f.lookups.length);
      expect(f.lookups).toHaveLength(601);
    });

    it('reads at most one window of rows per resolution however much junk the phonebook holds', async () => {
      const junk = VM_HOLDER_TIER_PROFILE_PAGE_SIZE * VM_HOLDER_TIER_MAX_PROFILE_PAGES + 100;
      const f = holderFixture([...Array.from({ length: junk }, (_, i) => junkRow(i)), holderRow]);
      const resolution = await resolveHolderPeerHints(f.deps, cache());
      expect(resolution).toMatchObject({ kind: 'resolved', peerIds: [] });
      if (resolution.kind !== 'resolved') return;
      expect(resolution.stats.pages).toBe(VM_HOLDER_TIER_MAX_PROFILE_PAGES);
      expect(resolution.stats.profiles).toBe(VM_HOLDER_TIER_PROFILE_PAGE_SIZE * VM_HOLDER_TIER_MAX_PROFILE_PAGES);
      expect(f.pageReads).toBe(VM_HOLDER_TIER_MAX_PROFILE_PAGES);
      expect(f.lookups.length).toBeLessThanOrEqual(VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS);
    });

    it('keeps a holder verified earlier reachable behind more junk than the lookup bound', async () => {
      const shared = cache();
      // The holder is verified once, while it is alone.
      const alone = holderFixture([holderRow]);
      await resolveHolderPeerHints(alone.deps, shared);
      expect(alone.lookups).toEqual([WALLET_A]);

      // Junk then arrives ahead of it, more than the lookup bound. The holder's
      // answer is remembered, so reading past the junk needs no lookup for it.
      const f = holderFixture([...Array.from({ length: 600 }, (_, i) => junkRow(i)), holderRow]);
      f.clock.now = alone.clock.now;
      const resolution = await resolveHolderPeerHints(f.deps, shared);
      expect(resolution).toMatchObject({ kind: 'resolved', peerIds: ['peer-holder'] });
      expect(f.lookups).toHaveLength(VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS);
      expect(f.lookups).not.toContain(WALLET_A);
      if (resolution.kind === 'resolved') expect(resolution.stats.stopped).toBe('lookup-bound');
    });

    it('spends no chain lookup on a row that cannot bind a wallet', async () => {
      const f = holderFixture([
        { peerId: 'peer-empty', agentAddress: '' },
        { peerId: 'peer-short', agentAddress: '0x1234' },
        { peerId: 'peer-zero', agentAddress: `0x${'0'.repeat(40)}` },
        { peerId: '', agentAddress: WALLET_B },
        { peerId: 'peer with spaces', agentAddress: WALLET_B },
        { peerId: 'x'.repeat(200), agentAddress: WALLET_B },
        { peerId: 'peer-\u0000-nul', agentAddress: WALLET_B },
        holderRow,
      ]);
      const resolution = await resolveHolderPeerHints(f.deps, cache());
      expect(resolution).toMatchObject({ kind: 'resolved', peerIds: ['peer-holder'] });
      expect(f.lookups).toEqual([WALLET_A]);
    });

    it('stops reading once the verified peers fill the cap or every identity has its allowance', async () => {
      const count = VM_HOLDER_TIER_PROFILE_PAGE_SIZE + 44;
      const identities: Record<string, bigint> = {};
      for (let id = 1; id <= count; id += 1) identities[wallet(id)] = BigInt(id);
      const capped = fixture({
        table: Array.from({ length: count }, (_, i) => BigInt(i + 1)),
        identities,
        rows: Array.from({ length: count }, (_, i) => ({ peerId: `peer-${i + 1}`, agentAddress: wallet(i + 1) })),
      });
      const resolution = await resolveHolderPeerHints(capped.deps, cache());
      expect(resolution).toMatchObject({ kind: 'resolved', stats: { pages: 1, stopped: 'satisfied' } });
      expect(capped.pageReads).toBe(1);

      const full = holderFixture([
        holderRow,
        { peerId: 'peer-holder-2', agentAddress: WALLET_A, lastSeen: OLD },
        ...Array.from({ length: 400 }, (_, i) => junkRow(i)),
      ]);
      const done = await resolveHolderPeerHints(full.deps, cache());
      expect(done).toMatchObject({ kind: 'resolved', peerIds: ['peer-holder', 'peer-holder-2'], stats: { stopped: 'satisfied' } });
      expect(full.pageReads).toBe(1);
      expect(full.lookups[0]).toBe(WALLET_A);
    });

    it('reads no phonebook page and no wallet when the ShardingTable is empty', async () => {
      const f = fixture({ table: [], identities: { [WALLET_A]: 7n }, rows: [holderRow] });
      expect(await resolveHolderPeerHints(f.deps, cache())).toMatchObject({
        kind: 'resolved',
        peerIds: [],
        stats: { profiles: 0, pages: 0, lookups: 0 },
      });
      expect(f.pageReads).toBe(0);
      expect(f.lookups).toEqual([]);
    });

    it('treats a provider that ignores its page bound as an unavailable phonebook', async () => {
      const f = holderFixture([holderRow]);
      f.deps = {
        ...f.deps,
        listCoreProfileHints: async (request: HolderProfilePageRequest) => ({
          hints: Array.from({ length: request.limit + 1 }, (_, i) => junkRow(i)),
          next: null,
        }),
      };
      expect(await resolveHolderPeerHints(f.deps, cache())).toEqual({
        kind: 'unavailable',
        reason: 'phonebook-read-failed',
      });
    });

    it('lets a defect surface instead of reporting it as an unavailable identity read', async () => {
      const defect = new TypeError('now is not a function');
      const f = holderFixture([holderRow]);
      f.deps = { ...f.deps, now: () => { throw defect; } };
      await expect(resolveHolderPeerHints(f.deps, cache())).rejects.toBe(defect);
    });

    it('remembers a rejected wallet for at least a resolution period, and re-reads it after', async () => {
      const f = holderFixture([junkRow(1), holderRow]);
      const shared = cache();
      await resolveHolderPeerHints(f.deps, shared);
      expect(f.lookups).toEqual([wallet(0x1001), WALLET_A]);
      f.lookups.length = 0;
      f.clock.now += VM_HOLDER_TIER_RESOLUTION_TTL_MS - 1;
      await resolveHolderPeerHints(f.deps, shared);
      expect(f.lookups).toEqual([]);
      f.clock.now += 1;
      await resolveHolderPeerHints(f.deps, shared);
      expect(f.lookups).toEqual([wallet(0x1001)]);
    });

    it('caps concurrent lookups per page', async () => {
      const f = holderFixture(Array.from({ length: 64 }, (_, i) => junkRow(i)));
      let inFlight = 0;
      let peak = 0;
      f.deps = {
        ...f.deps,
        getIdentityIdForAddress: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return 0n;
        },
      };
      await resolveHolderPeerHints(f.deps, cache());
      expect(peak).toBeLessThanOrEqual(VM_HOLDER_TIER_LOOKUP_CONCURRENCY);
    });
  });

  describe('a junk flood larger than the page bound: the walk reads on through it, window by window', () => {
    const FRESH = '2026-09-30T11:59:00.000Z';
    const WINDOW_ROWS = VM_HOLDER_TIER_PROFILE_PAGE_SIZE * VM_HOLDER_TIER_MAX_PROFILE_PAGES;
    /** Junk that shares a few wallets, so only the page bound (not the lookup bound) limits a resolution. */
    const crowd = (count: number): HolderProfileHint[] => Array.from({ length: count }, (_, i) => ({
      peerId: `peer-flood-${String(i).padStart(5, '0')}`,
      // 40 wallets, rows in the phonebook's (wallet, peer id) order.
      agentAddress: wallet(0x1000 + Math.floor(i / Math.ceil(count / 40))),
      lastSeen: FRESH,
    }));
    /** Junk with a wallet per row, so the lookup bound limits a resolution as well. */
    const distinct = (count: number): HolderProfileHint[] => Array.from({ length: count }, (_, i) => ({
      peerId: `peer-distinct-${i}`,
      agentAddress: wallet(0x4000 + i),
      lastSeen: FRESH,
    }));
    // The holder's own claim is old, and (for the tests that read it last) its wallet sorts after all the junk.
    const LATE_WALLET = wallet(0xf0000000);
    const holderRow: HolderProfileHint = { peerId: 'peer-holder', agentAddress: WALLET_A, lastSeen: '2020-01-01T00:00:00.000Z' };
    const lateHolderRow: HolderProfileHint = { peerId: 'peer-holder', agentAddress: LATE_WALLET, lastSeen: '2020-01-01T00:00:00.000Z' };
    const flooded = (rows: HolderProfileHint[]) => fixture({
      table: [7n],
      identities: { [WALLET_A]: 7n, [LATE_WALLET]: 7n },
      rows,
    });

    /** Resolve once per failure spacing; returns each round's peers and the stats bounds it stayed within. */
    async function rounds(f: Fixture, resolver: VmHolderHintResolver, count: number) {
      const peers: string[][] = [];
      for (let round = 0; round < count; round += 1) {
        const before = f.lookups.length;
        const resolution = await resolver.resolve();
        expect(resolution.kind).toBe('resolved');
        if (resolution.kind !== 'resolved') throw new Error('unreachable');
        // Bounded however large the flood: pages and chain lookups per resolution.
        expect(resolution.stats.pages).toBeLessThanOrEqual(VM_HOLDER_TIER_MAX_PROFILE_PAGES);
        expect(resolution.stats.lookups).toBeLessThanOrEqual(VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS);
        expect(f.lookups.length - before).toBeLessThanOrEqual(VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS);
        peers.push([...resolution.peerIds]);
        f.clock.now += VM_HOLDER_TIER_FAILURE_RETRY_MS;
      }
      return peers;
    }

    it('reads the next window of rows on each resolution and finds a holder that sorts after more than the page bound of junk', async () => {
      const rows = [...crowd(WINDOW_ROWS + 76), lateHolderRow];
      const f = flooded(rows);
      const resolver = new VmHolderHintResolver(f.deps);
      const peers = await rounds(f, resolver, 5);

      const foundAt = peers.findIndex((round) => round.includes('peer-holder')) + 1;
      // The first window is all junk; the holder is in the second.
      expect(foundAt).toBeGreaterThan(0);
      expect(foundAt).toBeLessThanOrEqual(Math.ceil(rows.length / WINDOW_ROWS) + 1);
      // Once found it stays: the windows read afterwards do not un-verify it.
      for (const round of peers.slice(foundAt - 1)) expect(round).toContain('peer-holder');
    });

    it('needs no more resolutions than the lookup bound requires when every junk row has its own wallet', async () => {
      const rows = [...distinct(WINDOW_ROWS + 76), lateHolderRow];
      const f = flooded(rows);
      const resolver = new VmHolderHintResolver(f.deps);
      const peers = await rounds(f, resolver, 9);
      const foundAt = peers.findIndex((round) => round.includes('peer-holder')) + 1;
      expect(foundAt).toBeGreaterThan(0);
      // Window one costs ceil(1024 / 256) resolutions, window two one more.
      expect(foundAt).toBeLessThanOrEqual(Math.ceil(WINDOW_ROWS / VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS) + 2);
      for (const round of peers.slice(foundAt - 1)) expect(round).toContain('peer-holder');
      // Every wallet was resolved on chain once.
      expect(new Set(f.lookups).size).toBe(f.lookups.length);
    });

    it('drops a carried holder when its rows are read again without it, and not before', async () => {
      const rows = [holderRow, ...crowd(WINDOW_ROWS + 76)];
      const f = flooded(rows);
      const resolver = new VmHolderHintResolver(f.deps);

      // Window one holds the holder, and the resolution reaches the end of the phonebook only in window two.
      const [first] = await rounds(f, resolver, 1);
      expect(first).toEqual(['peer-holder']);
      // Its row disappears. Window two does not cover that key range: it is still carried.
      f.rows.splice(0, 1);
      const [second] = await rounds(f, resolver, 1);
      expect(second).toEqual(['peer-holder']);
      // Window two reached the end of the phonebook, so its answer is reused for a full period;
      // then the walk wraps around: window one is read again without the row, and the holder goes.
      f.clock.now += VM_HOLDER_TIER_RESOLUTION_TTL_MS;
      const [third] = await rounds(f, resolver, 1);
      expect(third).toEqual([]);
    });

    it('lets a carried holder expire when its window is not read again in time', async () => {
      const rows = [holderRow, ...crowd(WINDOW_ROWS + 76)];
      const f = flooded(rows);
      const resolver = new VmHolderHintResolver(f.deps);
      expect((await rounds(f, resolver, 1))[0]).toEqual(['peer-holder']);
      f.clock.now += VM_HOLDER_TIER_CARRY_TTL_MS;
      // Window two, read after the carry lifetime, does not include it.
      expect((await rounds(f, resolver, 1))[0]).toEqual([]);
    });

    it('carries only bindings whose identity is still in the ShardingTable', async () => {
      const rows = [holderRow, ...crowd(WINDOW_ROWS + 76)];
      const f = flooded(rows);
      const resolver = new VmHolderHintResolver(f.deps);
      expect((await rounds(f, resolver, 1))[0]).toEqual(['peer-holder']);
      f.table = [9n];
      expect((await rounds(f, resolver, 1))[0]).toEqual([]);
    });

    it('starts over from the first row after reset, and keeps its place through an invalidation', async () => {
      const rows = [...crowd(WINDOW_ROWS + 76), lateHolderRow];
      const f = flooded(rows);
      const requests: Array<{ after?: string }> = [];
      const pageOf = f.deps.listCoreProfileHints;
      f.deps = {
        ...f.deps,
        listCoreProfileHints: async (request: HolderProfilePageRequest) => {
          requests.push({ after: request.after?.peerId });
          return pageOf(request);
        },
      };
      const resolver = new VmHolderHintResolver(f.deps);
      await rounds(f, resolver, 1);
      const firstWindow = requests.length;
      expect(requests[0]!.after).toBeUndefined();
      // A phonebook arrival forgets the cached answer but the walk continues where it stopped.
      resolver.invalidate();
      await rounds(f, resolver, 1);
      expect(requests[firstWindow]!.after).toBeDefined();
      // Reset forgets the walk as well: the next resolution reads from the first row.
      resolver.reset();
      const beforeReset = requests.length;
      await rounds(f, resolver, 1);
      expect(requests[beforeReset]!.after).toBeUndefined();
    });

    it('commits the walk only from a read that finished within its deadline', async () => {
      const rows = [...crowd(WINDOW_ROWS + 76), lateHolderRow];
      const f = flooded(rows);
      const requests: Array<{ after?: string }> = [];
      const pageOf = f.deps.listCoreProfileHints;
      let hang = true;
      f.deps = {
        ...f.deps,
        listCoreProfileHints: async (request: HolderProfilePageRequest) => {
          requests.push({ after: request.after?.peerId });
          if (hang) await new Promise(() => undefined);
          return pageOf(request);
        },
      };
      const resolver = new VmHolderHintResolver(f.deps, { resolutionTimeoutMs: 20 });
      expect(await resolver.resolve()).toEqual({ kind: 'unavailable', reason: 'timeout' });
      hang = false;
      f.clock.now += VM_HOLDER_TIER_FAILURE_RETRY_MS;
      await resolver.resolve();
      // Nothing was committed by the abandoned read: the second one starts from the first row too.
      expect(requests.slice(0, 2).map((request) => request.after)).toEqual([undefined, undefined]);
      expect(requests[2]!.after).toBeDefined();
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

  it('reuses a resolution cut short by the lookup bound only for the failure spacing', async () => {
    const junk = Array.from({ length: 600 }, (_, i): HolderProfileHint => ({
      peerId: `peer-junk-${i}`,
      agentAddress: wallet(0x1000 + i),
    }));
    const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows: [...junk, { peerId: 'peer-a', agentAddress: WALLET_A }] });
    const { resolver, listTable } = resolverFor(f);
    expect(await resolver.resolve()).toMatchObject({ kind: 'resolved', peerIds: [], stats: { stopped: 'lookup-bound' } });
    f.clock.now += VM_HOLDER_TIER_FAILURE_RETRY_MS - 1;
    await resolver.resolve();
    expect(listTable).toHaveBeenCalledTimes(1);
    f.clock.now += 1;
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

  describe('wall-clock bound over reads that ignore the abort signal', () => {
    afterEach(() => { vi.useRealTimers(); });

    /** A chain read that never settles and never looks at the signal, like an RPC call. */
    function hung(): { promise: Promise<bigint | undefined>; resolveLate(value: bigint): void; rejectLate(error: Error): void } {
      let resolveLate!: (value: bigint) => void;
      let rejectLate!: (error: Error) => void;
      const promise = new Promise<bigint | undefined>((resolve, reject) => { resolveLate = resolve; rejectLate = reject; });
      return { promise, resolveLate, rejectLate };
    }

    it('settles at the deadline, frees the shared read and lets later callers read afresh', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
      const read = hung();
      const lookup = vi.fn(() => read.promise);
      f.deps = { ...f.deps, getIdentityIdForAddress: lookup };
      const resolver = new VmHolderHintResolver(f.deps, { resolutionTimeoutMs: 1_000 });

      let settled: VmHolderHintResolution | undefined;
      const pending = resolver.resolve().then((resolution) => { settled = resolution; });
      // A second caller joins the same read.
      const joined = resolver.resolve();
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ kind: 'unavailable', reason: 'timeout' });
      await pending;
      await expect(joined).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
      expect(lookup).toHaveBeenCalledTimes(1);

      // Not stuck behind the hung read: after the failure spacing the next caller reads afresh.
      f.clock.now += VM_HOLDER_TIER_FAILURE_RETRY_MS;
      lookup.mockImplementation(async () => 7n);
      await expect(resolver.resolve()).resolves.toMatchObject({ kind: 'resolved', peerIds: ['peer-a'] });
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('cannot be clobbered or leak when the abandoned read settles late', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      try {
        const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
        const stuck = hung();
        const lookup = vi.fn(() => stuck.promise);
        f.deps = { ...f.deps, getIdentityIdForAddress: lookup };
        const resolver = new VmHolderHintResolver(f.deps, { resolutionTimeoutMs: 1_000 });
        let first: VmHolderHintResolution | undefined;
        void resolver.resolve().then((resolution) => { first = resolution; });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(first).toEqual({ kind: 'unavailable', reason: 'timeout' });

        // A newer read succeeds...
        f.clock.now += VM_HOLDER_TIER_FAILURE_RETRY_MS;
        lookup.mockImplementation(async () => 7n);
        const fresh = await resolver.resolve();
        expect(fresh).toMatchObject({ kind: 'resolved', peerIds: ['peer-a'] });

        // ...and the abandoned read then settles late, with a WRONG answer for the wallet.
        stuck.resolveLate(0n);
        await vi.advanceTimersByTimeAsync(0);
        expect(await resolver.resolve()).toBe(fresh);
        expect(lookup).toHaveBeenCalledTimes(2);
        // It did not reach the identity cache either: forgetting the resolution
        // still reads the chain's answer from the newer read, not the late one.
        resolver.invalidate();
        expect(await resolver.resolve()).toMatchObject({ kind: 'resolved', peerIds: ['peer-a'] });

        // A read abandoned at its deadline that later REJECTS is never unhandled.
        const late = hung();
        f.clock.now += VM_HOLDER_TIER_IDENTITY_TTL_MS;
        lookup.mockImplementation(() => late.promise);
        let abandoned: VmHolderHintResolution | undefined;
        void resolver.resolve().then((resolution) => { abandoned = resolution; });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(abandoned).toEqual({ kind: 'unavailable', reason: 'timeout' });
        late.rejectLate(new Error('rpc torn down late'));
        vi.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('does not let an answer that arrives after its deadline reach the identity cache', async () => {
      const f = fixture({ table: [7n], identities: {}, rows });
      const late = hung();
      f.deps = { ...f.deps, getIdentityIdForAddress: () => late.promise };
      const shared = cache();
      const controller = new AbortController();
      const running = resolveHolderPeerHints(f.deps, shared, controller.signal);
      const outcome = running.then(() => 'resolved', (error) => error?.message ?? 'rejected');
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort(new Error('deadline'));
      late.resolveLate(0n);
      expect(await outcome).toBe('deadline');
      expect(shared.size).toBe(0);
    });

    it('reports only its own deadline as a timeout and lets a defect surface', async () => {
      const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
      const defect = new TypeError('selfPeerId is not a function');
      f.deps = { ...f.deps, selfPeerId: () => { throw defect; } };
      const resolver = new VmHolderHintResolver(f.deps);
      await expect(resolver.resolve()).rejects.toBe(defect);
      // The failed read is not remembered as an answer, nor left as the shared read.
      f.deps = { ...f.deps, selfPeerId: () => SELF };
      const healed = new VmHolderHintResolver(f.deps);
      await expect(healed.resolve()).resolves.toMatchObject({ kind: 'resolved' });
      await expect(resolver.resolve()).rejects.toBe(defect);
    });
  });

  describe('invalidation racing an in-flight read', () => {
    it('never lets a caller after invalidate() join an older read, and keeps the older result out of the cache', async () => {
      const f = fixture({ table: [7n, 8n], identities: { [WALLET_A]: 7n, [WALLET_B]: 8n }, rows: [] });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let reads = 0;
      const pageOf = f.deps.listCoreProfileHints;
      f.deps = {
        ...f.deps,
        listCoreProfileHints: async (request: HolderProfilePageRequest) => {
          reads += 1;
          const snapshot = await pageOf(request);
          // Only the first read is held up, after it has read the (empty) phonebook.
          if (reads === 1) await gate;
          return snapshot;
        },
      };
      const resolver = new VmHolderHintResolver(f.deps);

      const stale = resolver.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      // A holder profile arrives, which invalidates the resolver and asks for a recovery.
      f.rows.push({ peerId: 'peer-b', agentAddress: WALLET_B });
      resolver.invalidate();
      const recovery = resolver.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      release();

      // The first caller asked before the invalidation and gets what it read...
      await expect(stale).resolves.toMatchObject({ kind: 'resolved', peerIds: [] });
      // ...the recovery, which asked after it, sees the new holder.
      await expect(recovery).resolves.toMatchObject({ kind: 'resolved', peerIds: ['peer-b'] });
      expect(reads).toBe(2);

      // The cache holds the fresh answer; the older completion neither replaced nor cleared it.
      const cached = await resolver.resolve();
      expect(cached).toMatchObject({ kind: 'resolved', peerIds: ['peer-b'] });
      expect(reads).toBe(2);
    });

    it('reports the generation callers can compare to notice an invalidation that landed mid-read', async () => {
      const f = fixture({ table: [7n], identities: { [WALLET_A]: 7n }, rows });
      const resolver = new VmHolderHintResolver(f.deps);
      const before = resolver.generation;
      await resolver.resolve();
      expect(resolver.generation).toBe(before);
      resolver.invalidate();
      expect(resolver.generation).toBe(before + 1);
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
    stats: {
      profiles: peerIds.length,
      unbound: 0,
      unmatched: 0,
      identities: peerIds.length,
      pages: 1,
      lookups: peerIds.length,
      stopped: 'exhausted' as const,
      rowsLeft: false,
    },
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

  it('re-reads a set cut short by a page or lookup bound on the failure spacing, not a full period', () => {
    const cutShort = {
      ...resolved(['a']),
      stats: { ...resolved(['a']).stats, stopped: 'lookup-bound' as const, rowsLeft: true },
    };
    expect(nextVmHolderTierEntry(undefined, cutShort, 100)).toEqual({
      peerIds: ['a'],
      resolvedAt: 100,
      nextCheckAt: 100 + VM_HOLDER_TIER_FAILURE_RETRY_MS,
    });
    // A page-bound stop leaves the next window of the phonebook to read: it is due as soon.
    const pageBound = { ...cutShort, stats: { ...cutShort.stats, stopped: 'page-bound' as const } };
    expect(nextVmHolderTierEntry(undefined, pageBound, 100).nextCheckAt).toBe(100 + VM_HOLDER_TIER_FAILURE_RETRY_MS);
    // A walk that reached the end keeps the normal cadence, and so does a satisfied one with nothing left to walk.
    for (const stopped of ['exhausted', 'satisfied'] as const) {
      const done = { ...cutShort, stats: { ...cutShort.stats, stopped, rowsLeft: false } };
      expect(nextVmHolderTierEntry(undefined, done, 100).nextCheckAt).toBe(100 + VM_HOLDER_TIER_RESOLUTION_TTL_MS);
    }
    // A satisfied tier with rows left keeps walking (its bindings behind the flood must be verified again before
    // they expire), so the next window is due as soon as after a cut-short resolution.
    const walking = { ...cutShort, stats: { ...cutShort.stats, stopped: 'satisfied' as const, rowsLeft: true } };
    expect(nextVmHolderTierEntry(undefined, walking, 100).nextCheckAt).toBe(100 + VM_HOLDER_TIER_FAILURE_RETRY_MS);
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
