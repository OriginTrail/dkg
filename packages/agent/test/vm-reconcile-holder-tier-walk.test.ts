import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY,
  VM_HOLDER_TIER_FAILURE_RETRY_MS,
  VM_HOLDER_TIER_FRESH_SCAN,
  VM_HOLDER_TIER_LOOKUP_CONCURRENCY,
  VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS,
  VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS,
  VM_HOLDER_TIER_PEERS_PER_IDENTITY,
  VM_HOLDER_TIER_PROFILE_PAGE_SIZE,
  VM_HOLDER_TIER_READ_BUDGET_SHARE,
  VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS,
  VM_HOLDER_TIER_RESOLUTION_TTL_MS,
  VmHolderHintResolver,
  VmHolderTierController,
  resolveHolderScanWindow,
  type HolderProfileCursor,
  type HolderProfilePageRequest,
  type VmHolderHintDeps,
  type VmHolderHintResolution,
  type VmHolderIdentityCache,
  type VmHolderScanState,
} from '../src/vm-reconcile-holder-tier.js';

/**
 * How the walk over a phonebook larger than one resolution's window behaves
 * against the cadence it is driven at, the sweep that drives it, the chain's
 * speed and the races between reads. Every test pages a REAL keyset (rows sorted
 * by wallet then peer id, resumed strictly after a cursor KEY, like the real
 * phonebook query), so rows may come and go before the cursor.
 */

const SELF = '12D3KooWSelf';
const LOOKUP_BOUND = VM_HOLDER_TIER_MAX_IDENTITY_LOOKUPS;
const FRESH = '2026-09-30T11:59:00.000Z';

interface Row { peerId: string; agentAddress: string; lastSeen?: string }

const wallet = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const codeUnits = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const compareKeys = (left: HolderProfileCursor, right: HolderProfileCursor): number => (
  codeUnits(left.agentAddress, right.agentAddress) || codeUnits(left.peerId, right.peerId)
);

/** Junk wallets sort in index order, a thousand apart, so anything can be slipped in between. */
const JUNK_BASE = 0x100000;
const junkWallet = (index: number): string => wallet(JUNK_BASE + 1_000 * index);
const junkRow = (index: number): Row => ({ peerId: `peer-junk-${index}`, agentAddress: junkWallet(index), lastSeen: FRESH });
/** A holder with `position` junk wallets ahead of it in walk order. */
const holderWallet = (position: number): string => wallet(JUNK_BASE + 1_000 * position - 500);
const holderPeer = (name: string): string => `peer-holder-${name}`;
const OLD = '2020-01-01T00:00:00.000Z';

interface HolderSpec { name: string; position: number; identity: bigint }

interface WorldOptions {
  junk?: number;
  /** Rows that share few wallets (28 rows each), so only the page bound, not the lookup bound, limits a window. */
  crowd?: number;
  holders?: readonly HolderSpec[];
  /** Read the clock from here instead of the world's own (fake timers: `Date.now`). */
  clock?: () => number;
  /** Latency of every chain lookup, on whatever timers are installed. */
  lookupLatencyMs?: number;
  /** Latency of every phonebook page read, on whatever timers are installed. */
  pageLatencyMs?: number;
}

/** A chain and a keyset phonebook that count what they are asked. */
function createWorld(options: WorldOptions = {}) {
  const holders = options.holders ?? [];
  const own = { now: 1_000_000 };
  const identities = new Map<string, bigint>();
  const rows: Row[] = [];
  for (let index = 0; index < (options.junk ?? 0); index += 1) rows.push(junkRow(index));
  for (let index = 0; index < (options.crowd ?? 0); index += 1) {
    rows.push({ peerId: `peer-crowd-${String(index).padStart(5, '0')}`, agentAddress: junkWallet(Math.floor(index / 28)), lastSeen: FRESH });
  }
  for (const holder of holders) {
    rows.push({ peerId: holderPeer(holder.name), agentAddress: holderWallet(holder.position), lastSeen: OLD });
    identities.set(holderWallet(holder.position).toLowerCase(), holder.identity);
  }
  // Sorting thousands of rows per page read dominates the long simulations: only add()/remove() change the rows.
  let sortedRows: Row[] | undefined;
  const state = {
    clock: own,
    rows,
    table: holders.map((holder) => holder.identity) as bigint[],
    tableReads: 0,
    requests: [] as Array<{ read: number; after: HolderProfileCursor | undefined }>,
    rpc: { total: 0, perWallet: new Map<string, number>(), inFlight: 0, peak: 0 },
    /** Awaited, after the page snapshot was taken, by every page read: the read it belongs to and its index in it. */
    pageHook: undefined as undefined | ((read: number, index: number) => Promise<void> | void),
    pageIndex: new Map<number, number>(),
    /** Awaited by every chain lookup before it answers: its ordinal. */
    lookupHook: undefined as undefined | ((call: number) => Promise<void> | void),
    pageCalls: 0,
    deps: undefined as unknown as VmHolderHintDeps,
    add(row: Row, identity?: bigint): void {
      sortedRows = undefined;
      rows.push(row);
      if (identity !== undefined) {
        identities.set(row.agentAddress.toLowerCase(), identity);
        if (!state.table.includes(identity)) state.table.push(identity);
      }
    },
    remove(predicate: (row: Row) => boolean): number {
      sortedRows = undefined;
      let removed = 0;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (predicate(rows[index]!)) { rows.splice(index, 1); removed += 1; }
      }
      return removed;
    },
    /** The chain now answers `identity` for `address`; the identity joins the ShardingTable. */
    rebind(address: string, identity: bigint): void {
      identities.set(address.toLowerCase(), identity);
      if (!state.table.includes(identity)) state.table.push(identity);
    },
    /** The wallets looked up more than once. */
    repeated(): string[] {
      return [...state.rpc.perWallet].filter(([, count]) => count > 1).map(([address]) => address);
    },
  };
  state.deps = {
    listShardingTableIdentityIds: async () => { state.tableReads += 1; return [...state.table]; },
    getIdentityIdForAddress: async (address) => {
      state.rpc.total += 1;
      const key = address.toLowerCase();
      state.rpc.perWallet.set(key, (state.rpc.perWallet.get(key) ?? 0) + 1);
      state.rpc.inFlight += 1;
      state.rpc.peak = Math.max(state.rpc.peak, state.rpc.inFlight);
      try {
        if (state.lookupHook !== undefined) await state.lookupHook(state.rpc.total);
        if (options.lookupLatencyMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.lookupLatencyMs));
        }
        return identities.get(key) ?? 0n;
      } finally {
        state.rpc.inFlight -= 1;
      }
    },
    listCoreProfileHints: async (request: HolderProfilePageRequest) => {
      state.pageCalls += 1;
      const read = state.tableReads;
      const index = state.pageIndex.get(read) ?? 0;
      state.pageIndex.set(read, index + 1);
      state.requests.push({ read, after: request.after });
      // A real keyset: sorted by (wallet, peer id), strictly after the cursor KEY.
      sortedRows ??= [...state.rows].sort(compareKeys);
      const sorted = sortedRows;
      const later = request.after === undefined ? sorted : sorted.filter((row) => compareKeys(row, request.after!) > 0);
      const hints = later.slice(0, request.limit);
      const last = hints[hints.length - 1];
      const page = {
        hints,
        next: later.length > hints.length && last !== undefined
          ? { agentAddress: last.agentAddress, peerId: last.peerId }
          : null,
      };
      if (state.pageHook !== undefined) await state.pageHook(read, index);
      if (options.pageLatencyMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.pageLatencyMs));
      }
      return page;
    },
    selfPeerId: () => SELF,
    now: options.clock ?? (() => own.now),
    wallClockNow: () => Date.parse('2026-09-30T12:00:00.000Z'),
  };
  return state;
}

type World = ReturnType<typeof createWorld>;

interface Round {
  /** Which shared read produced it: rounds that reuse an answer share the number. */
  read: number;
  peers: string[];
  stopped: string;
  lookups: number;
}

/** One resolution per `spacingMs`, the way an unhurried caller drives the resolver. */
async function resolveEvery(world: World, resolver: VmHolderHintResolver, spacingMs: number, rounds: number): Promise<Round[]> {
  const result: Round[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const resolution = await resolver.resolve();
    result.push(resolution.kind === 'resolved'
      ? { read: world.tableReads, peers: [...resolution.peerIds], stopped: resolution.stats.stopped, lookups: resolution.stats.lookups }
      : { read: world.tableReads, peers: [], stopped: resolution.reason, lookups: 0 });
    world.clock.now += spacingMs;
  }
  return result;
}

/** Resolve at `spacingMs` until `peer` is in the answer or `maxRounds` have run. */
async function resolveUntilFound(world: World, resolver: VmHolderHintResolver, spacingMs: number, peer: string, maxRounds: number) {
  const rounds: Round[] = [];
  while (rounds.length < maxRounds && !rounds.some((round) => round.peers.includes(peer))) {
    rounds.push(...await resolveEvery(world, resolver, spacingMs, 1));
  }
  return { rounds, found: rounds.some((round) => round.peers.includes(peer)) ? rounds.length : 0 };
}

const firstRoundWith = (rounds: readonly Round[], peer: string): number => rounds.findIndex((round) => round.peers.includes(peer)) + 1;
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function deferred(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

afterEach(() => { vi.useRealTimers(); });

describe('a holder behind a junk flood is found within about junk/256 + 1 resolutions at any cadence', () => {
  const SPACINGS_S = [60, 75, 90, 120, 300, 900, 3600] as const;

  describe.each([768, 2000, 5000])('%i distinct junk wallets sort ahead of the holder', (junk) => {
    const bound = Math.ceil(junk / LOOKUP_BOUND) + 1;

    it.each(SPACINGS_S)('finds it within the bound at a resolution spacing of %i s, each wallet asked about once', async (spacingS) => {
      const world = createWorld({ junk, holders: [{ name: 'a', position: junk, identity: 7n }] });
      const resolver = new VmHolderHintResolver(world.deps);
      const { rounds, found } = await resolveUntilFound(world, resolver, spacingS * 1_000, holderPeer('a'), bound);

      expect(found).toBeGreaterThan(0);
      expect(found).toBeLessThanOrEqual(bound);
      // Each round was a resolution of its own, and every one stayed within the lookup bound.
      expect(world.tableReads).toBe(rounds.length);
      expect(rounds.every((round) => round.lookups <= LOOKUP_BOUND)).toBe(true);
      // No wallet is asked about twice because a walk rewound: junk plus the holder, once each.
      expect(world.repeated()).toEqual([]);
      expect(world.rpc.total).toBeLessThanOrEqual(junk + 1);
    });

    it.each(SPACINGS_S)('never reads rows it examined again within a pass, at a resolution spacing of %i s', async (spacingS) => {
      const world = createWorld({ junk, holders: [{ name: 'a', position: junk, identity: 7n }] });
      const resolver = new VmHolderHintResolver(world.deps);
      await resolveUntilFound(world, resolver, spacingS * 1_000, holderPeer('a'), bound);
      // The first cursor of each read is strictly after the one before it: progress does not wait
      // for a remembered answer to age, so it does not depend on the spacing.
      const starts = world.requests
        .filter((request, index) => index === 0 || request.read !== world.requests[index - 1]!.read)
        .map((request) => request.after);
      expect(starts[0]).toBeUndefined();
      expect(starts.length).toBeGreaterThan(1);
      for (let index = 2; index < starts.length; index += 1) {
        expect(compareKeys(starts[index - 1]!, starts[index]!)).toBeLessThan(0);
      }
      expect(starts[1]).toBeDefined();
    });

    it('keeps the holder in the answer while the next pass walks the flood again', async () => {
      const world = createWorld({ junk, holders: [{ name: 'a', position: junk, identity: 7n }] });
      const resolver = new VmHolderHintResolver(world.deps);
      const spacingMs = 120_000;
      const first = await resolveUntilFound(world, resolver, spacingMs, holderPeer('a'), bound);
      expect(first.found).toBeGreaterThan(0);
      // The next pass begins after the answer's own period and walks the flood from its first row:
      // the binding carried from this pass answers for the holder until its row is read again.
      world.clock.now += VM_HOLDER_TIER_RESOLUTION_TTL_MS;
      const second = await resolveEvery(world, resolver, spacingMs, bound);
      expect(second.every((round) => round.peers.includes(holderPeer('a')))).toBe(true);
    });
  });

  it('drops a holder between passes once a pass outlasts the hour a binding is kept (the documented limit)', async () => {
    // At two minutes a resolution, 9,000 junk wallets are 36 resolutions: a pass takes 72 minutes, more than
    // VM_HOLDER_TIER_CARRY_TTL_MS, so the binding a pass verifies expires before the next pass reads its row again.
    const junk = 9_000;
    const world = createWorld({ junk, holders: [{ name: 'a', position: junk, identity: 7n }] });
    const resolver = new VmHolderHintResolver(world.deps);
    const spacingMs = 120_000;
    const first = await resolveUntilFound(world, resolver, spacingMs, holderPeer('a'), Math.ceil(junk / LOOKUP_BOUND) + 1);
    expect(first.found).toBeGreaterThan(0);
    world.clock.now += VM_HOLDER_TIER_RESOLUTION_TTL_MS;
    const second = await resolveEvery(world, resolver, spacingMs, Math.ceil(junk / LOOKUP_BOUND) + 1);
    const present = second.map((round) => round.peers.includes(holderPeer('a')));
    // Present while the binding lives, then gone, then found again when the walk reaches its row.
    expect(present[0]).toBe(true);
    expect(present.includes(false)).toBe(true);
    expect(present[present.length - 1]).toBe(true);
  });

  it('finds holders behind several junk pages and past a second window, each within the bound', async () => {
    const holders: HolderSpec[] = [
      { name: 'early', position: 300, identity: 7n },
      { name: 'second-window', position: 1500, identity: 8n },
      { name: 'late', position: 3200, identity: 9n },
    ];
    const junk = 4000;
    for (const spacingS of [60, 120, 300, 900]) {
      const world = createWorld({ junk, holders });
      const resolver = new VmHolderHintResolver(world.deps);
      // One pass: after it the walk wraps and asks about the first wallets again.
      const rounds = await resolveEvery(world, resolver, spacingS * 1_000, Math.ceil((junk + holders.length) / LOOKUP_BOUND));
      for (const holder of holders) {
        const found = firstRoundWith(rounds, holderPeer(holder.name));
        expect(found, `${holder.name} at ${spacingS} s`).toBeGreaterThan(0);
        // Everything ahead of it (junk and earlier holders) costs one lookup, 256 of them per resolution.
        const ahead = holder.position + holders.filter((other) => other.position < holder.position).length;
        expect(found, `${holder.name} at ${spacingS} s`).toBeLessThanOrEqual(Math.ceil(ahead / LOOKUP_BOUND) + 1);
      }
      expect(world.repeated()).toEqual([]);
      expect(world.rpc.total).toBeLessThanOrEqual(junk + holders.length);
    }
  });

  it('walks the same whether or not the remembered negative answers have expired between resolutions', async () => {
    const junk = 1500;
    const walks: Round[][] = [];
    for (const spacingMs of [60_000, VM_HOLDER_TIER_NEGATIVE_IDENTITY_TTL_MS + 60_000]) {
      const world = createWorld({ junk, holders: [{ name: 'a', position: junk, identity: 7n }] });
      const resolver = new VmHolderHintResolver(world.deps);
      const { rounds, found } = await resolveUntilFound(world, resolver, spacingMs, holderPeer('a'), Math.ceil(junk / LOOKUP_BOUND) + 1);
      expect(found).toBeGreaterThan(0);
      walks.push(rounds);
    }
    expect(walks[1]).toEqual(walks[0]);
  });
});

describe('invariants of the walk', () => {
  it.each([60, 400])('wraps at the end of the phonebook and starts every pass at the first row, at a %i s spacing', async (spacingS) => {
    const junk = 600; // no holder in the phonebook: a pass is 256 + 256 + 88 lookups, then it wraps
    const world = createWorld({ junk });
    world.table = [7n];
    const resolver = new VmHolderHintResolver(world.deps);
    const rounds: Round[] = [];
    while (world.tableReads < 6 && rounds.length < 40) rounds.push(...await resolveEvery(world, resolver, spacingS * 1_000, 1));
    const reads = rounds.filter((round, index) => index === 0 || round.read !== rounds[index - 1]!.read);
    expect(reads.map((round) => round.stopped)).toEqual([
      'lookup-bound', 'lookup-bound', 'exhausted', 'lookup-bound', 'lookup-bound', 'exhausted',
    ]);
    // Both passes examined the same wallets: 256, 256, then the last 88.
    expect(reads.map((round) => round.lookups)).toEqual([256, 256, 88, 256, 256, 88]);
    const starts = world.requests
      .filter((request, index) => index === 0 || request.read !== world.requests[index - 1]!.read)
      .map((request) => request.after);
    expect(starts[0]).toBeUndefined();
    expect(starts[3]).toBeUndefined();
    expect(compareKeys(starts[1]!, starts[2]!)).toBeLessThan(0);
    expect(starts[4]).toEqual(starts[1]);
    expect(starts[5]).toEqual(starts[2]);
  });

  it('is neither stalled nor loses the holder when junk arrives or leaves before the cursor', async () => {
    const junk = 2000;
    const world = createWorld({ junk, holders: [{ name: 'a', position: junk, identity: 7n }] });
    const resolver = new VmHolderHintResolver(world.deps);
    const spacingMs = 120_000;
    const rounds = await resolveEvery(world, resolver, spacingMs, 3);
    const examined = 3 * LOOKUP_BOUND;
    // Junk leaves the part already walked (including the very row the cursor stands on)...
    const left = world.remove((row) => {
      const index = Number(row.peerId.slice('peer-junk-'.length));
      return row.peerId.startsWith('peer-junk-') && index < examined && (index % 2 === 0 || index === examined - 1);
    });
    expect(left).toBeGreaterThan(100);
    // ...and new junk arrives ahead of everything the walk has read.
    for (let index = 0; index < 300; index += 1) {
      world.add({ peerId: `peer-early-${index}`, agentAddress: wallet(0x1000 + index), lastSeen: FRESH });
    }
    const before = world.rpc.total;
    rounds.push(...await resolveEvery(world, resolver, spacingMs, Math.ceil(junk / LOOKUP_BOUND) + 1 - 3));
    const found = firstRoundWith(rounds, holderPeer('a'));
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThanOrEqual(Math.ceil(junk / LOOKUP_BOUND) + 1);
    // Rows behind the cursor are not read again by this pass: what came and went there costs nothing.
    expect(world.rpc.total - before).toBeLessThanOrEqual(junk - examined + 1);
    expect(world.repeated()).toEqual([]);
  });

  it('is delayed by no more than the extra windows when junk arrives ahead of the walk', async () => {
    const junk = 1200;
    const world = createWorld({ junk, holders: [{ name: 'a', position: junk, identity: 7n }] });
    const resolver = new VmHolderHintResolver(world.deps);
    const first = await resolveEvery(world, resolver, 120_000, 2);
    expect(firstRoundWith(first, holderPeer('a'))).toBe(0);
    // 700 more wallets sort between the cursor and the holder.
    for (let index = 0; index < 700; index += 1) {
      world.add({ peerId: `peer-late-junk-${index}`, agentAddress: wallet(JUNK_BASE + 1_000 * 1_000 + 1 + index), lastSeen: FRESH });
    }
    const rest = await resolveEvery(world, resolver, 120_000, Math.ceil((junk + 700) / LOOKUP_BOUND));
    const found = firstRoundWith([...first, ...rest], holderPeer('a'));
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThanOrEqual(Math.ceil((junk + 700) / LOOKUP_BOUND) + 1);
    expect(world.repeated()).toEqual([]);
  });

  it('keeps a carried binding while its rows are unexamined, and drops it once the walk has read past them without it', async () => {
    const junk = 1200;
    const world = createWorld({
      junk,
      holders: [
        { name: 'front', position: 10, identity: 7n },
        { name: 'back', position: junk, identity: 8n },
      ],
    });
    const resolver = new VmHolderHintResolver(world.deps);
    const spacingMs = 120_000;
    const first = await resolveEvery(world, resolver, spacingMs, 1);
    expect(first[0]!.peers).toContain(holderPeer('front'));
    // The front holder's row disappears. The next resolution reads on from the cursor, so the
    // rows it would have been in are not read yet: the binding stays.
    world.remove((row) => row.peerId === holderPeer('front'));
    const second = await resolveEvery(world, resolver, spacingMs, 1);
    expect(second[0]!.peers).toContain(holderPeer('front'));
    // The walk reaches the back holder and the end, wraps, and reads the first rows again without it.
    const rest = await resolveEvery(world, resolver, spacingMs, Math.ceil(junk / LOOKUP_BOUND) + 3);
    expect(firstRoundWith(rest, holderPeer('back'))).toBeGreaterThan(0);
    const last = rest[rest.length - 1]!;
    expect(last.peers).not.toContain(holderPeer('front'));
    expect(last.peers).toContain(holderPeer('back'));
  });
});

describe('the walk under the real sweep cadence', () => {
  /**
   * Drives a real `VmHolderTierController` the way the VM reconcile sweep does: a
   * start-anchored 60 s interval that asks for a refresh of the graph, every read
   * on the fake clock, each lookup taking `latencyMs` of it. A resolution ends
   * after its own duration and is next due a failure spacing later, so the
   * interval skips a tick: the effective spacing is two sweeps.
   */
  async function sweepUntilFound(options: { junk: number; latencyMs: number; maxSweeps: number }) {
    vi.useFakeTimers();
    const world = createWorld({
      junk: options.junk,
      holders: [{ name: 'a', position: options.junk, identity: 7n }],
      clock: () => Date.now(),
      lookupLatencyMs: options.latencyMs,
    });
    const controller = new VmHolderTierController({
      enabled: () => true,
      readPolicy: async () => 'public',
      hints: world.deps,
      log: () => undefined,
    });
    const failures: unknown[] = [];
    const sweepTimer = setInterval(() => {
      controller.refresh('cg-a', { isCurrent: () => true }).catch((error) => failures.push(error));
    }, 60_000);
    let foundAtSweep = 0;
    try {
      for (let sweep = 1; sweep <= options.maxSweeps && foundAtSweep === 0; sweep += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        if (controller.peerIdsFor('cg-a').includes(holderPeer('a'))) foundAtSweep = sweep;
      }
    } finally {
      clearInterval(sweepTimer);
    }
    expect(failures).toEqual([]);
    return { world, foundAtSweep };
  }

  it.each([1, 50, 500])('finds a holder behind 768 junk wallets within a bounded number of sweeps when a lookup takes %i ms', async (latencyMs) => {
    const junk = 768;
    // The scan starts a lookup only when the slowest so far leaves it time to end inside a share of the
    // resolution deadline, so a slow chain shortens a resolution (fewer wallets per resolution) instead of
    // timing it out. A batch is 8 lookups wide, and the first always runs.
    const budgetMs = VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS * VM_HOLDER_TIER_READ_BUDGET_SHARE;
    const perResolution = Math.min(LOOKUP_BOUND, VM_HOLDER_TIER_LOOKUP_CONCURRENCY * Math.max(1, Math.ceil(budgetMs / latencyMs) - 1));
    const resolutions = Math.ceil(junk / perResolution) + 1;
    const { world, foundAtSweep } = await sweepUntilFound({ junk, latencyMs, maxSweeps: 2 * resolutions + 2 });
    expect(foundAtSweep).toBeGreaterThan(0);
    // Two sweeps per resolution (one is due a failure spacing after the last one ENDED, past the next tick),
    // and the answer is seen a step after the tick that started it.
    expect(foundAtSweep).toBeLessThanOrEqual(2 * resolutions);
    expect(world.tableReads).toBeLessThanOrEqual(resolutions);
    expect(world.repeated()).toEqual([]);
    expect(world.rpc.total).toBeLessThanOrEqual(junk + 1);
    expect(world.rpc.peak).toBeLessThanOrEqual(VM_HOLDER_TIER_LOOKUP_CONCURRENCY);
  });

  it('finds a holder behind 5,000 junk wallets within the bound at the default cadence', async () => {
    const junk = 5000;
    const resolutions = Math.ceil(junk / LOOKUP_BOUND) + 1;
    const { world, foundAtSweep } = await sweepUntilFound({ junk, latencyMs: 1, maxSweeps: 2 * resolutions + 2 });
    expect(foundAtSweep).toBeGreaterThan(0);
    expect(foundAtSweep).toBeLessThanOrEqual(2 * resolutions);
    expect(world.repeated()).toEqual([]);
  });
});

describe('the time a resolution may spend on reads', () => {
  const BUDGET_MS = VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS * VM_HOLDER_TIER_READ_BUDGET_SHARE;

  /** One scan on fake timers, run to its end: what it did and how long (fake) time it took. */
  async function scan(world: World, prior: VmHolderScanState, cache: VmHolderIdentityCache, readBudgetMs?: number) {
    const startedAt = Date.now();
    const pending = resolveHolderScanWindow(world.deps, cache, prior, undefined, readBudgetMs === undefined ? {} : { readBudgetMs })
      .then((outcome) => ({ outcome, tookMs: Date.now() - startedAt }));
    await vi.advanceTimersByTimeAsync(120_000);
    return pending;
  }
  const junkWorld = (options: WorldOptions) => {
    vi.useFakeTimers();
    const world = createWorld({ junk: 400, clock: () => Date.now(), ...options });
    world.table = [7n];
    return world;
  };

  it.each([
    { latencyMs: 500, lookups: 120, tookMs: 7_500 },
    { latencyMs: 3_500, lookups: 16, tookMs: 7_000 },
    { latencyMs: 5_000, lookups: 8, tookMs: 5_000 },
  ])('starts a lookup only when it can end inside the budget: $latencyMs ms a lookup is $lookups lookups in $tookMs ms', async ({ latencyMs, lookups, tookMs }) => {
    const world = junkWorld({ lookupLatencyMs: latencyMs });
    const shared: VmHolderIdentityCache = new Map();
    const first = await scan(world, VM_HOLDER_TIER_FRESH_SCAN, shared, BUDGET_MS);
    expect(first.outcome.resolution).toMatchObject({ kind: 'resolved', stats: { stopped: 'lookup-bound', lookups } });
    // It ended inside the budget, so well inside the deadline, even for a chain slower than a third of the budget.
    expect(first.tookMs).toBe(tookMs);
    expect(first.tookMs).toBeLessThan(BUDGET_MS);
    // The examined prefix is kept: the next scan resumes at the first wallet not asked about.
    expect(first.outcome.next.cursor).toEqual({ agentAddress: junkWallet(lookups - 1), peerId: `peer-junk-${lookups - 1}` });
    const second = await scan(world, first.outcome.next, shared, BUDGET_MS);
    expect(second.outcome.resolution).toMatchObject({ stats: { lookups } });
    expect(world.repeated()).toEqual([]);
  });

  it('always lets one batch of lookups through, so a resolution makes some progress however little time is left', async () => {
    const world = junkWorld({ lookupLatencyMs: 100 });
    const { outcome } = await scan(world, VM_HOLDER_TIER_FRESH_SCAN, new Map(), 0);
    expect(outcome.resolution).toMatchObject({ stats: { lookups: VM_HOLDER_TIER_LOOKUP_CONCURRENCY, stopped: 'lookup-bound' } });
    expect(outcome.next.cursor).toEqual({ agentAddress: junkWallet(7), peerId: 'peer-junk-7' });
  });

  it('answers a whole resolution on a fast chain, budget or not', async () => {
    const world = junkWorld({ lookupLatencyMs: 1 });
    const { outcome } = await scan(world, VM_HOLDER_TIER_FRESH_SCAN, new Map(), BUDGET_MS);
    expect(outcome.resolution).toMatchObject({ stats: { lookups: LOOKUP_BOUND, stopped: 'lookup-bound' } });
    const unbudgeted = await scan(junkWorld({ lookupLatencyMs: 1 }), VM_HOLDER_TIER_FRESH_SCAN, new Map());
    expect(unbudgeted.outcome.resolution).toMatchObject({ stats: { lookups: LOOKUP_BOUND } });
  });

  it('reads a further page only when the slowest so far can end inside the budget, and moves the walk to where it stopped', async () => {
    // 1,100 rows on 40 wallets, a store that takes 2.6 s a page (about oxigraph-server at 40,000 rows):
    // three pages end at 7.8 s, a fourth would end at 10.4 s, past the deadline.
    vi.useFakeTimers();
    const world = createWorld({ crowd: 1_100, clock: () => Date.now(), pageLatencyMs: 2_600 });
    world.table = [7n];
    const { outcome, tookMs } = await scan(world, VM_HOLDER_TIER_FRESH_SCAN, new Map(), BUDGET_MS);
    expect(outcome.resolution).toMatchObject({ kind: 'resolved', stats: { pages: 3, stopped: 'page-bound' } });
    expect(tookMs).toBe(7_800);
    expect(outcome.next.cursor).toBeDefined();
    expect(world.requests.length).toBe(3);
  });

  it('is what keeps a resolution over a slow store inside its deadline, so the walk still moves', async () => {
    vi.useFakeTimers();
    const world = createWorld({ crowd: 1_100, clock: () => Date.now(), pageLatencyMs: 2_600 });
    world.table = [7n];
    const resolver = new VmHolderHintResolver(world.deps);
    const first = resolver.resolve();
    await vi.advanceTimersByTimeAsync(VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS);
    // Read to the end of a fourth page it would have timed out; it stops at three and commits them.
    expect(await first).toMatchObject({ kind: 'resolved', stats: { pages: 3, stopped: 'page-bound' } });
    await vi.advanceTimersByTimeAsync(VM_HOLDER_TIER_FAILURE_RETRY_MS);
    const second = resolver.resolve();
    await vi.advanceTimersByTimeAsync(VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS);
    await second;
    const starts = world.requests.filter((request, index) => index === 0 || request.read !== world.requests[index - 1]!.read).map((request) => request.after);
    expect(starts[0]).toBeUndefined();
    expect(starts[1]).toBeDefined();
  });

  it('is measured for the resolver as a share of its deadline on the clock it was given', async () => {
    // 500 ms a lookup, 8 wide: 15 batches (120 lookups) end at 7.5 s, inside 80% of the 10 s deadline.
    const world = junkWorld({ lookupLatencyMs: 500 });
    const resolver = new VmHolderHintResolver(world.deps);
    const pending = resolver.resolve();
    await vi.advanceTimersByTimeAsync(VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS);
    expect(await pending).toMatchObject({ kind: 'resolved', stats: { stopped: 'lookup-bound', lookups: VM_HOLDER_TIER_LOOKUP_CONCURRENCY * 15 } });
  });

  it('cannot help a chain that needs longer than the whole deadline for one batch: the read is abandoned and commits nothing', async () => {
    // The documented residual: only a first batch (or first page) that outlasts the deadline itself makes no progress.
    const world = junkWorld({ lookupLatencyMs: 11_000 });
    const resolver = new VmHolderHintResolver(world.deps);
    const first = resolver.resolve();
    await vi.advanceTimersByTimeAsync(VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS);
    expect(await first).toEqual({ kind: 'unavailable', reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(VM_HOLDER_TIER_FAILURE_RETRY_MS);
    const second = resolver.resolve();
    await vi.advanceTimersByTimeAsync(VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS);
    expect(await second).toEqual({ kind: 'unavailable', reason: 'timeout' });
    // Nothing moved: both reads started from the first row.
    const starts = world.requests.filter((request, index) => index === 0 || request.read !== world.requests[index - 1]!.read).map((request) => request.after);
    expect(starts).toEqual([undefined, undefined]);
  });
});

describe('the walk state is committed only by a read that nothing overtook', () => {
  it('does not let a read that an invalidation overtook advance the walk past a profile that arrived meanwhile', async () => {
    // 1,100 rows on 40 wallets: a window (four pages) ends mid-way through them, whatever the chain costs.
    const world = createWorld({ crowd: 1_100 });
    world.table = [7n];
    const older = deferred();
    const newer = deferred();
    world.pageHook = async (read, index) => {
      if (index === 0 && read === 1) await older.promise;
      if (index === 0 && read === 2) await newer.promise;
    };
    const resolver = new VmHolderHintResolver(world.deps);

    const first = resolver.resolve(); // reads the phonebook as it is, then waits
    await tick();
    // A holder's profile arrives among the first rows, after that read saw them, and invalidates.
    world.add({ peerId: holderPeer('new'), agentAddress: holderWallet(5), lastSeen: OLD }, 7n);
    resolver.invalidate();
    const second = resolver.resolve();
    await tick();
    older.release(); // the older read finishes FIRST
    expect(await first).toMatchObject({ kind: 'resolved', peerIds: [] });
    await tick();
    newer.release();
    // The caller after the arrival finds the holder...
    expect(await second).toMatchObject({ kind: 'resolved', peerIds: [holderPeer('new')] });
    // ...and keeps it: the older read finishing first must not have moved the walk past the rows
    // the arrival landed in, nor replaced what the newer read carried.
    world.clock.now += VM_HOLDER_TIER_FAILURE_RETRY_MS;
    expect(await resolver.resolve()).toMatchObject({ kind: 'resolved', peerIds: [holderPeer('new')] });
  });

  it('does not let a read that was in flight across reset() restore the walk it had before', async () => {
    const world = createWorld({ crowd: 1_100 });
    world.table = [7n];
    const gate = deferred();
    world.pageHook = async (read, index) => { if (read === 1 && index === 0) await gate.promise; };
    const resolver = new VmHolderHintResolver(world.deps);

    const first = resolver.resolve();
    await tick();
    resolver.reset(); // the controller's shutdown: every graph and the walk start over
    gate.release();
    await first;
    // The read finished after the reset: the next resolution starts from the first row again.
    await resolver.resolve();
    const nextRead = world.requests.filter((request) => request.read === 2).map((request) => request.after);
    expect(nextRead[0]).toBeUndefined();
  });

  it('lets only the read that owns the shared slot free it', async () => {
    const world = createWorld({ junk: 0, holders: [{ name: 'a', position: 0, identity: 7n }] });
    const older = deferred();
    const newer = deferred();
    world.pageHook = async (read) => {
      if (read === 1) await older.promise;
      if (read === 2) await newer.promise;
    };
    const resolver = new VmHolderHintResolver(world.deps);

    const first = resolver.resolve();
    await tick();
    resolver.invalidate();
    const second = resolver.resolve(); // a read of the newer generation
    await tick();
    older.release(); // the older read finishes while the newer one holds the shared slot
    await first;
    await tick();
    const third = resolver.resolve(); // must join the newer read, not start a third
    await tick();
    newer.release();
    const [joined, again] = await Promise.all([second, third]);
    expect(again).toBe(joined);
    expect(world.pageCalls).toBe(2);
  });
});

describe('a burst of phonebook arrivals during a slow read', () => {
  const BURST = 6;

  it('runs one read at a time, gives the callers after the burst one read to share, and asks about no wallet twice', async () => {
    const world = createWorld({ junk: 300, holders: [{ name: 'a', position: 300, identity: 7n }] });
    const gate = deferred();
    world.lookupHook = async () => { await gate.promise; };
    const resolver = new VmHolderHintResolver(world.deps);

    const first = resolver.resolve();
    await tick();
    const burst: Array<Promise<VmHolderHintResolution>> = [];
    for (let arrival = 0; arrival < BURST; arrival += 1) {
      resolver.invalidate(); // a profile arrived: the older read is obsolete
      burst.push(resolver.resolve());
    }
    await tick(20);
    // While the first read waits on the chain nobody else has touched it.
    expect(world.tableReads).toBe(1);
    expect(world.rpc.total).toBe(VM_HOLDER_TIER_LOOKUP_CONCURRENCY);
    expect(world.rpc.peak).toBe(VM_HOLDER_TIER_LOOKUP_CONCURRENCY);

    gate.release();
    const resolutions = await Promise.all(burst);
    await first;
    // One read for the older generation and ONE for everybody after it, however long the burst.
    expect(world.tableReads).toBe(2);
    expect(new Set(resolutions).size).toBe(1);
    expect(resolutions[0]).toMatchObject({ kind: 'resolved', peerIds: [holderPeer('a')] });
    expect(world.rpc.peak).toBeLessThanOrEqual(VM_HOLDER_TIER_LOOKUP_CONCURRENCY);
    // What the older read learned is remembered: nothing was asked about twice.
    expect(world.repeated()).toEqual([]);
  });

  it('never hands a caller after the invalidation the older read, and a read that hangs holds them only to its deadline', async () => {
    const world = createWorld({ junk: 100, holders: [{ name: 'a', position: 100, identity: 7n }] });
    // The chain's first eight answers never come, and ignore every signal, like a stalled RPC.
    world.lookupHook = (call) => (call <= VM_HOLDER_TIER_LOOKUP_CONCURRENCY ? new Promise<void>(() => undefined) : undefined);
    const resolver = new VmHolderHintResolver(world.deps, { resolutionTimeoutMs: 100 });

    const startedAt = Date.now();
    const first = resolver.resolve();
    await tick();
    resolver.invalidate();
    const second = resolver.resolve();
    // The older read reports its deadline; the caller after the invalidation reads afresh behind it.
    expect(await first).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(await second).toMatchObject({ kind: 'resolved', peerIds: [holderPeer('a')] });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    // The hung wallets are asked about again by the fresh read (their answers never arrived), and by
    // nothing else: at most one repeat per hung lookup, and at most two reads' worth in flight.
    expect(world.rpc.total).toBeLessThanOrEqual(101 + VM_HOLDER_TIER_LOOKUP_CONCURRENCY);
    expect(world.rpc.peak).toBeLessThanOrEqual(2 * VM_HOLDER_TIER_LOOKUP_CONCURRENCY);
  });
});

/**
 * A real `VmHolderTierController` driven the way the VM reconcile sweep drives it: a
 * start-anchored 60 s interval that asks for a refresh of one graph, on the fake
 * clock (the caller installs fake timers before building the world). Returns the
 * graph's hinted peers after each sweep, so what is asserted is what a recovery
 * pass would have read.
 */
async function sweepSamples(world: World, sweeps: number): Promise<string[][]> {
  const controller = new VmHolderTierController({
    enabled: () => true,
    readPolicy: async () => 'public',
    hints: world.deps,
    log: () => undefined,
  });
  const failures: unknown[] = [];
  const samples: string[][] = [];
  const sweepTimer = setInterval(() => {
    controller.refresh('cg-a', { isCurrent: () => true }).catch((error) => failures.push(error));
  }, 60_000);
  try {
    for (let sweep = 1; sweep <= sweeps; sweep += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      samples.push([...controller.peerIdsFor('cg-a')]);
    }
  } finally {
    clearInterval(sweepTimer);
  }
  expect(failures).toEqual([]);
  return samples;
}

/** What a scan carried, per identity. */
function carriedPerIdentity(carried: VmHolderScanState['carried']): Map<bigint, number> {
  const counts = new Map<bigint, number>();
  for (const binding of carried.values()) counts.set(binding.identityId, (counts.get(binding.identityId) ?? 0) + 1);
  return counts;
}

describe('rows that all claim one real Core wallet cannot displace another identity (the carry is per identity)', () => {
  const SWEEPS = 240; // four hours at the default 60 s sweep
  const HONEST: HolderSpec[] = [
    { name: 'h2', position: 10, identity: 2n },
    { name: 'h3', position: 20, identity: 3n },
    { name: 'h4', position: 30, identity: 4n },
    { name: 'h5', position: 40, identity: 5n },
  ];
  const HONEST_PEERS = HONEST.map((holder) => holderPeer(holder.name));
  const PLACEMENTS = [['before', 5], ['among', 25], ['after', 50]] as const;
  const forgedPeer = (index: number, prefix = 'peer-forged'): string => `${prefix}-${String(index).padStart(5, '0')}`;

  /** Identity 1 is a real Core whose wallet `forged` fresh peer ids claim; four other Cores are honest. */
  function floodedWorld(forged: number, position: number, options: WorldOptions = {}) {
    const world = createWorld({ holders: [...HONEST, { name: 'real1', position, identity: 1n }], ...options });
    for (let index = 0; index < forged; index += 1) {
      world.add({ peerId: forgedPeer(index), agentAddress: holderWallet(position), lastSeen: FRESH });
    }
    return world;
  }

  describe.each([1_100, 3_000])('%i forged peer ids under one real wallet', (forged) => {
    it.each(PLACEMENTS)('keep the four honest holders hinted on every sweep for four hours when the wallet sorts %s them', async (_where, position) => {
      vi.useFakeTimers();
      const world = floodedWorld(forged, position, { clock: () => Date.now(), lookupLatencyMs: 1 });
      const samples = await sweepSamples(world, SWEEPS);

      // Found within the walk's own bound (windows of 1,024 rows, a resolution every second sweep)...
      const established = samples.findIndex((peers) => HONEST_PEERS.every((peer) => peers.includes(peer)));
      const windows = Math.ceil((forged + HONEST.length + 1) / 1_024);
      expect(established).toBeGreaterThanOrEqual(0);
      expect(established).toBeLessThan(2 * windows + 2);
      // ...and never lost afterwards, while the flood is walked again and again.
      for (const [offset, peers] of samples.slice(established).entries()) {
        expect(peers, `sweep ${established + offset + 1}`).toEqual(expect.arrayContaining(HONEST_PEERS));
        // What the flood does take is the claimed identity's own slots, and no more.
        expect(peers.filter((peer) => !HONEST_PEERS.includes(peer)).length).toBeLessThanOrEqual(VM_HOLDER_TIER_PEERS_PER_IDENTITY);
      }
    }, 120_000);

    it.each(PLACEMENTS)('never make a scan carry more than the per-identity limit, whatever the flood, when the wallet sorts %s the holders', async (_where, position) => {
      const world = floodedWorld(forged, position);
      const cache: VmHolderIdentityCache = new Map();
      let state: VmHolderScanState = VM_HOLDER_TIER_FRESH_SCAN;
      let mostCarried = 0;
      let mostForOneIdentity = 0;
      for (let round = 0; round < SWEEPS; round += 1) {
        const { resolution, next } = await resolveHolderScanWindow(world.deps, cache, state, undefined, {
          readBudgetMs: VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS * VM_HOLDER_TIER_READ_BUDGET_SHARE,
        });
        expect(resolution.kind).toBe('resolved');
        state = next;
        mostCarried = Math.max(mostCarried, next.carried.size);
        mostForOneIdentity = Math.max(mostForOneIdentity, ...carriedPerIdentity(next.carried).values());
        world.clock.now += 120_000;
      }
      expect(mostForOneIdentity).toBeLessThanOrEqual(VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY);
      expect(mostCarried).toBeLessThanOrEqual(world.table.length * VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY);
      // The limit is reached by the flooded identity and by no other: the honest four carry what they have.
      expect(state.carried.size).toBe(HONEST.length + VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY);
    }, 120_000);
  });

  it('holds the same bound for every identity at once: 50 identities, each claimed by 30 peer ids', async () => {
    const identities = 50;
    const holders: HolderSpec[] = Array.from({ length: identities }, (_, index) => ({ name: `i${index + 1}`, position: index + 1, identity: BigInt(index + 1) }));
    const world = createWorld({ holders });
    for (let identity = 1; identity <= identities; identity += 1) {
      for (let index = 0; index < 30; index += 1) {
        world.add({ peerId: forgedPeer(index, `peer-claim-${identity}`), agentAddress: holderWallet(identity), lastSeen: FRESH });
      }
    }
    const cache: VmHolderIdentityCache = new Map();
    let state: VmHolderScanState = VM_HOLDER_TIER_FRESH_SCAN;
    let lastPeers: readonly string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const { resolution, next } = await resolveHolderScanWindow(world.deps, cache, state);
      if (resolution.kind === 'resolved') lastPeers = resolution.peerIds;
      state = next;
      expect(next.carried.size).toBeLessThanOrEqual(identities * VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY);
      expect(Math.max(...carriedPerIdentity(next.carried).values())).toBeLessThanOrEqual(VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY);
      world.clock.now += 120_000;
    }
    // Every identity the walk has reached has its allowance, so the tier is full at the peer cap.
    expect(lastPeers.length).toBe(32);
  });

  it.each([1_100, 3_000])('costs the honest wallets no more chain lookups behind %i junk wallets than without them (the identity cache is bounded; a flood that pushes honest answers out costs no extra lookups)', async (junk) => {
    // Four hours at the two-minute resolution spacing of the default sweep, honest holders sorting after the junk.
    const lookupsOfHonestWallets = async (flood: number): Promise<number> => {
      const holders = HONEST.map((holder) => ({ ...holder, position: flood + holder.position }));
      const world = createWorld({ junk: flood, holders });
      const resolver = new VmHolderHintResolver(world.deps);
      for (let poll = 0; poll < 120; poll += 1) {
        await resolver.resolve();
        world.clock.now += 120_000;
      }
      return holders.reduce((sum, holder) => sum + (world.rpc.perWallet.get(holderWallet(holder.position).toLowerCase()) ?? 0), 0);
    };
    const alone = await lookupsOfHonestWallets(0);
    expect(alone).toBeGreaterThan(0);
    // The flood pushes honest answers out of the cache sooner, but each honest wallet is asked about at most once per
    // pass, and a pass is longer than the ten minutes a positive answer lives anyway: no extra cost, nothing hidden.
    expect(await lookupsOfHonestWallets(junk)).toBeLessThanOrEqual(alone);
  }, 120_000);

  describe('inside the claimed identity the carry keeps what the selection would pick', () => {
    // Two honest peers of identity 1 (lastSeen 2020, ids "peer-holder-real1*") among a flood that ranks below them:
    // staler claims, claims dated in the future (they count as unknown) and equal claims with larger peer ids.
    const honest = ['peer-holder-real1', 'peer-holder-real1b'];
    const worldWith = (extra: Array<{ count: number; prefix: string; lastSeen: string }>) => {
      const world = createWorld({ holders: [{ name: 'real1', position: 5, identity: 1n }, { name: 'real1b', position: 5, identity: 1n }] });
      for (const { count, prefix, lastSeen } of extra) {
        for (let index = 0; index < count; index += 1) {
          world.add({ peerId: forgedPeer(index, prefix), agentAddress: holderWallet(5), lastSeen });
        }
      }
      return world;
    };

    it.each([
      ['staler claims', [{ count: 100, prefix: 'peer-a-stale', lastSeen: '2010-01-01T00:00:00.000Z' }]],
      ['claims dated in the future', [{ count: 100, prefix: 'peer-a-future', lastSeen: '2100-01-01T00:00:00.000Z' }]],
      ['equal claims with larger peer ids', [{ count: 100, prefix: 'peer-zz-equal', lastSeen: OLD }]],
      ['all three at once', [
        { count: 100, prefix: 'peer-a-stale', lastSeen: '2010-01-01T00:00:00.000Z' },
        { count: 100, prefix: 'peer-a-future', lastSeen: '2100-01-01T00:00:00.000Z' },
        { count: 100, prefix: 'peer-zz-equal', lastSeen: OLD },
      ]],
    ] as const)('%s never displace the identity\'s two better peers', async (_name, extra) => {
      const { resolution, next } = await resolveHolderScanWindow(worldWith([...extra]).deps, new Map(), VM_HOLDER_TIER_FRESH_SCAN);
      expect(resolution).toMatchObject({ kind: 'resolved', peerIds: honest });
      const carried = [...next.carried.values()];
      expect(carried.length).toBeLessThanOrEqual(VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY);
      expect(carried.map((binding) => binding.peerId)).toEqual(expect.arrayContaining(honest));
    });

    it('lets the identity\'s own better-ranked claims take its slots: the residual, bounded to that identity', async () => {
      // Fresher claims with smaller peer ids outrank the honest peers, exactly as the selection ranks them.
      const world = worldWith([{ count: 100, prefix: 'peer-a-fresh', lastSeen: FRESH }]);
      const { resolution, next } = await resolveHolderScanWindow(world.deps, new Map(), VM_HOLDER_TIER_FRESH_SCAN);
      expect(resolution).toMatchObject({ kind: 'resolved', peerIds: [forgedPeer(0, 'peer-a-fresh'), forgedPeer(1, 'peer-a-fresh')] });
      expect(next.carried.size).toBe(VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY);
    });
  });
});

/**
 * Wallets with letters in them have casing variants: distinct phonebook rows (the keyset orders raw strings by code
 * point, '0xAB' < '0xAb' < '0xaB' < '0xab', so the variants sort far apart) that normalize to ONE wallet, which the
 * chain answers with one identity. Filler wallets are digits after a four-character prefix that sorts between two
 * variants; every filler is its own wallet once lower-cased, so a window of 256 lookups cannot reach past a gap.
 */
const CASED_TAIL = '0'.repeat(36);
const CASED = {
  first: `0xABcd${CASED_TAIL}`,
  second: `0xAbcd${CASED_TAIL}`,
  third: `0xaBcd${CASED_TAIL}`,
  lower: `0xabcd${CASED_TAIL}`,
} as const;
let fillerCounter = 0;
const fillerWallet = (prefix: '0xAC' | '0xAf' | '0xaC'): string => {
  fillerCounter += 1;
  return `${prefix}${String(fillerCounter).padStart(38, '0')}`;
};
/** `count` distinct filler wallets that sort between two variants (first/second: 0xAC, second/third: 0xAf, third/lower: 0xaC). */
function addFiller(world: World, prefix: '0xAC' | '0xAf' | '0xaC', count: number): void {
  for (let index = 0; index < count; index += 1) {
    world.add({ peerId: `peer-filler-${fillerCounter + 1}`, agentAddress: fillerWallet(prefix), lastSeen: FRESH });
  }
}

/** Every resolution of a walk over `world`, with the resolutions that read each of `watched` rows. */
async function walkAndWatch(world: World, watched: readonly string[], rounds: number) {
  const cache: VmHolderIdentityCache = new Map();
  const readIn = new Map<string, number[]>(watched.map((address) => [address, []]));
  let round = 0;
  const deps: VmHolderHintDeps = {
    ...world.deps,
    listCoreProfileHints: async (request) => {
      const page = await world.deps.listCoreProfileHints(request);
      for (const row of page.hints) readIn.get(row.agentAddress)?.push(round);
      return page;
    },
  };
  let state: VmHolderScanState = VM_HOLDER_TIER_FRESH_SCAN;
  const states: VmHolderScanState[] = [];
  const resolutions: VmHolderHintResolution[] = [];
  for (round = 0; round < rounds; round += 1) {
    const scanned = await resolveHolderScanWindow(deps, cache, state);
    resolutions.push(scanned.resolution);
    state = scanned.next;
    states.push(state);
    world.clock.now += 120_000;
  }
  return { states, resolutions, readIn };
}

/** What a scan carries for one identity: peer ids, each once. */
const carriedPeers = (carried: VmHolderScanState['carried'], identity: bigint): string[] => (
  [...carried.values()].filter((binding) => binding.identityId === identity).map((binding) => binding.peerId).sort(codeUnits)
);

describe('one peer claimed under several casings of one wallet takes one carry slot', () => {
  // More rows than a window reads (four pages of 256) between two casings, so each is first read by a later resolution.
  const GAP = 1_100;
  const FORGED = 'peer-forged';
  const HONEST_A = holderPeer('a');
  const HONEST_B = holderPeer('b');

  it('keeps the identity\'s second honest peer carried when three casings of one forged peer are read in three different resolutions', async () => {
    // Identity 1 is a real Core (its wallet has letters). ONE fresh peer id claims it under three casings of the
    // wallet, each a window or more apart; the two honest peers sort last, under the all-lowercase casing.
    const world = createWorld();
    world.add({ peerId: FORGED, agentAddress: CASED.first, lastSeen: FRESH }, 1n);
    addFiller(world, '0xAC', GAP);
    world.add({ peerId: FORGED, agentAddress: CASED.second, lastSeen: FRESH }, 1n);
    addFiller(world, '0xAf', GAP);
    world.add({ peerId: FORGED, agentAddress: CASED.third, lastSeen: FRESH }, 1n);
    addFiller(world, '0xaC', GAP);
    world.add({ peerId: HONEST_A, agentAddress: CASED.lower, lastSeen: OLD }, 1n);
    world.add({ peerId: HONEST_B, agentAddress: CASED.lower, lastSeen: OLD }, 1n);

    const watched = [CASED.first, CASED.second, CASED.third];
    const { states, resolutions, readIn } = await walkAndWatch(world, watched, 18);

    // Not vacuous: the three casings were first read by three different resolutions (one window dedups them).
    const firstRead = watched.map((address) => Math.min(...readIn.get(address)!));
    expect(new Set(firstRead).size).toBe(3);

    // One binding per (identity, peer id) at every step, however many rows claim the peer...
    for (const state of states) {
      const peers = carriedPeers(state.carried, 1n);
      expect(new Set(peers).size, peers.join(',')).toBe(peers.length);
    }
    // ...so once the walk has reached the honest rows the forged peer holds one slot, and both honest peers hold theirs.
    const reached = states.findIndex((state) => carriedPeers(state.carried, 1n).includes(HONEST_B));
    expect(reached).toBeGreaterThanOrEqual(0);
    for (const state of states.slice(reached)) {
      expect(carriedPeers(state.carried, 1n)).toEqual([FORGED, HONEST_A, HONEST_B]);
      // Equal claims: the row that sorts first is the one carried, whichever casing a window reads first.
      expect([...state.carried.values()].filter((binding) => binding.peerId === FORGED).map((binding) => binding.agentAddress)).toEqual([CASED.first]);
    }
    // The selection is unchanged by it: the fresh claim and the honest peer that ranks first.
    expect(resolutions[resolutions.length - 1]).toMatchObject({ kind: 'resolved', peerIds: [FORGED, HONEST_A] });
  }, 60_000);

  it('falls back to the second honest peer at once when the first leaves, which the forged casings no longer prevent', async () => {
    // As above, but the honest peers sit under two wallets of identity 1 at opposite ends of the phonebook.
    const world = createWorld();
    world.add({ peerId: HONEST_A, agentAddress: `0x0${'1'.repeat(39)}`, lastSeen: OLD }, 1n);
    world.add({ peerId: FORGED, agentAddress: CASED.first, lastSeen: FRESH }, 1n);
    addFiller(world, '0xAC', GAP);
    world.add({ peerId: FORGED, agentAddress: CASED.second, lastSeen: FRESH }, 1n);
    addFiller(world, '0xAf', GAP);
    world.add({ peerId: FORGED, agentAddress: CASED.third, lastSeen: FRESH }, 1n);
    addFiller(world, '0xaC', GAP);
    world.add({ peerId: HONEST_B, agentAddress: CASED.lower, lastSeen: OLD }, 1n);
    const { states } = await walkAndWatch(world, [], 18);
    const last = states[states.length - 1]!;
    expect(carriedPeers(last.carried, 1n)).toEqual([FORGED, HONEST_A, HONEST_B]);

    // The first honest peer leaves. A walk that starts over examines the first window (its row is there, the second
    // honest peer's is not): the second stays carried, so the identity has its honest peer straight away.
    world.remove((row) => row.peerId === HONEST_A);
    const again = await resolveHolderScanWindow(world.deps, new Map(), { cursor: undefined, carried: last.carried });
    expect(again.resolution).toMatchObject({ kind: 'resolved', peerIds: [FORGED, HONEST_B] });
  }, 60_000);

  it.each([
    ['in one window, the better row sorting first', 0, true],
    ['in one window, the better row sorting last', 0, false],
    ['in different windows, the better row sorting first', GAP, true],
    ['in different windows, the better row sorting last', GAP, false],
  ])('carries the row that ranks best whichever order the casings are read in: %s', async (_name, gap, betterFirst) => {
    // One casing claims the peer with a stale lastSeen, the other with a fresh one. The selection ranks a peer by its
    // best claim, so the carry keeps the fresh row (and with it the peer's rank within the identity), wherever it sorts.
    const world = createWorld();
    const STALE = '2023-01-01T00:00:00.000Z';
    const MIDDLE = '2025-06-01T00:00:00.000Z';
    const [better, worse] = betterFirst ? [CASED.first, CASED.second] : [CASED.second, CASED.first];
    world.add({ peerId: 'peer-mover', agentAddress: CASED.first, lastSeen: betterFirst ? FRESH : STALE }, 1n);
    addFiller(world, '0xAC', gap);
    world.add({ peerId: 'peer-mover', agentAddress: CASED.second, lastSeen: betterFirst ? STALE : FRESH }, 1n);
    for (const name of ['p', 'q']) world.add({ peerId: `peer-other-${name}`, agentAddress: CASED.lower, lastSeen: MIDDLE }, 1n);

    const { states, resolutions, readIn } = await walkAndWatch(world, [better, worse], gap === 0 ? 1 : 8);
    // Not vacuous: read by one resolution, or by two.
    expect(new Set([better, worse].map((address) => Math.min(...readIn.get(address)!))).size).toBe(gap === 0 ? 1 : 2);
    const last = states[states.length - 1]!;
    expect([...last.carried.values()].filter((binding) => binding.peerId === 'peer-mover')).toMatchObject([
      { agentAddress: better, lastSeen: Date.parse(FRESH) },
    ]);
    // Ranked by the fresh claim, the peer is one of the identity's two selected; ranked by the stale one it is not.
    expect(resolutions[resolutions.length - 1]).toMatchObject({ kind: 'resolved', peerIds: ['peer-mover', 'peer-other-p'] });
  });

  it('keeps a peer whose better-ranked row is gone, under the best of its other rows that the same window verified', async () => {
    const world = createWorld();
    world.add({ peerId: 'peer-mover', agentAddress: CASED.first, lastSeen: FRESH }, 1n); // ranks above the other two rows
    world.add({ peerId: 'peer-mover', agentAddress: CASED.second, lastSeen: OLD }, 1n);
    world.add({ peerId: 'peer-mover', agentAddress: CASED.third, lastSeen: '2025-06-01T00:00:00.000Z' }, 1n);
    world.add({ peerId: 'peer-other', agentAddress: CASED.lower, lastSeen: OLD }, 1n);
    const cache: VmHolderIdentityCache = new Map();
    const first = await resolveHolderScanWindow(world.deps, cache, VM_HOLDER_TIER_FRESH_SCAN);
    expect(first.resolution).toMatchObject({ kind: 'resolved', peerIds: ['peer-mover', 'peer-other'] });
    expect(carriedPeers(first.next.carried, 1n)).toEqual(['peer-mover', 'peer-other']);
    expect([...first.next.carried.values()].filter((binding) => binding.peerId === 'peer-mover')).toMatchObject([{ agentAddress: CASED.first }]);

    // The best row goes. The window that examines its range also reads the other two, so the peer is still claimed:
    // it is carried under the better of those.
    world.remove((row) => row.agentAddress === CASED.first);
    const again = await resolveHolderScanWindow(world.deps, cache, { cursor: undefined, carried: first.next.carried });
    expect(again.resolution).toMatchObject({ kind: 'resolved', peerIds: ['peer-mover', 'peer-other'] });
    expect([...again.next.carried.values()].filter((binding) => binding.peerId === 'peer-mover')).toMatchObject([
      { agentAddress: CASED.third, lastSeen: Date.parse('2025-06-01T00:00:00.000Z') },
    ]);
  });
});

describe('a carried wallet whose identity changes moves its binding to the new identity', () => {
  // Identity 1 holds a, b and c, and the wallet of `mover`; then the wallet is registered to identity 2 (a new
  // answer, here from a fresh identity cache) while a fourth peer, d, arrives for identity 1.
  it.each([
    ['ranks below the identity\'s other peers', 'z-mover'],
    ['ranks above the identity\'s other peers', '0-mover'],
  ])('leaves each identity its own count when the moved binding %s', async (_name, mover) => {
    const holders: HolderSpec[] = [
      { name: 'a', position: 1, identity: 1n },
      { name: 'b', position: 2, identity: 1n },
      { name: 'c', position: 3, identity: 1n },
      { name: mover, position: 4, identity: 1n },
    ];
    const world = createWorld({ holders });
    const first = await resolveHolderScanWindow(world.deps, new Map(), VM_HOLDER_TIER_FRESH_SCAN);
    expect(carriedPerIdentity(first.next.carried)).toEqual(new Map([[1n, 4]]));

    world.rebind(holderWallet(4), 2n);
    world.add({ peerId: holderPeer('d'), agentAddress: holderWallet(5), lastSeen: OLD }, 1n);
    const second = await resolveHolderScanWindow(world.deps, new Map(), { cursor: undefined, carried: first.next.carried });

    // Identity 1 has room for its four (a, b, c, d); the moved binding is identity 2's alone, and nothing else left.
    expect(carriedPeers(second.next.carried, 1n)).toEqual([holderPeer('a'), holderPeer('b'), holderPeer('c'), holderPeer('d')]);
    expect(carriedPeers(second.next.carried, 2n)).toEqual([holderPeer(mover)]);
    expect(second.resolution).toMatchObject({
      kind: 'resolved',
      peerIds: [holderPeer('a'), holderPeer('b'), holderPeer(mover)].sort(codeUnits),
      stats: { identities: 2 },
    });
  });
});

describe('a satisfied tier keeps walking, so bindings behind junk are verified again before they expire', () => {
  /** Three identities with two peers each (their wallets sort at `position`, `position + 1` and `position + 2`). */
  const satisfiedHolders = (position: number): HolderSpec[] => [
    { name: 'a1', position, identity: 7n },
    { name: 'a2', position, identity: 7n },
    { name: 'b1', position: position + 1, identity: 8n },
    { name: 'b2', position: position + 1, identity: 8n },
    { name: 'c1', position: position + 2, identity: 9n },
    { name: 'c2', position: position + 2, identity: 9n },
  ];
  const SIX = satisfiedHolders(0).map((holder) => holderPeer(holder.name)).sort(codeUnits);
  const FOUR_HOURS_OF_SWEEPS = 240;

  describe.each([1_000, 3_000])('%i junk wallets sort ahead of the holders', (junk) => {
    it('never empties the set in four hours of one resolve a minute (real resolver)', async () => {
      const world = createWorld({ junk, holders: satisfiedHolders(junk) });
      const resolver = new VmHolderHintResolver(world.deps);
      const sizes: number[] = [];
      for (let poll = 0; poll < FOUR_HOURS_OF_SWEEPS; poll += 1) {
        const resolution = await resolver.resolve();
        sizes.push(resolution.kind === 'resolved' ? resolution.peerIds.length : -1);
        world.clock.now += 60_000;
      }
      const established = sizes.indexOf(SIX.length);
      expect(established).toBeGreaterThanOrEqual(0);
      expect(established + 1).toBeLessThanOrEqual(Math.ceil(junk / LOOKUP_BOUND) + 1);
      // Bindings live an hour; they are verified again each time the walk comes round, not only once.
      expect(Math.min(...sizes.slice(established))).toBe(SIX.length);
      // Each resolution stays within its lookup allowance, however long it keeps walking.
      expect(world.rpc.total).toBeLessThanOrEqual(world.tableReads * LOOKUP_BOUND);
    });

    it('never empties the set in four hours at the default sweep (real controller, a lookup takes 1 ms)', async () => {
      vi.useFakeTimers();
      const world = createWorld({ junk, holders: satisfiedHolders(junk), clock: () => Date.now(), lookupLatencyMs: 1 });
      const samples = await sweepSamples(world, FOUR_HOURS_OF_SWEEPS);
      const sizes = samples.map((peers) => peers.length);
      const established = sizes.indexOf(SIX.length);
      expect(established).toBeGreaterThanOrEqual(0);
      // A resolution every second sweep, 256 wallets each.
      expect(established + 1).toBeLessThanOrEqual(2 * (Math.ceil(junk / LOOKUP_BOUND) + 1));
      expect(Math.min(...sizes.slice(established))).toBe(SIX.length);
      expect(samples[samples.length - 1]).toEqual(SIX);
      expect(world.rpc.total).toBeLessThanOrEqual(world.tableReads * LOOKUP_BOUND);
    }, 120_000);
  });

  describe('one satisfied resolution', () => {
    // 300 junk wallets with the six holders among the first rows: 306 rows, so a second page of 50.
    const phonebook = () => createWorld({ junk: 300, holders: satisfiedHolders(10) });
    const pageEnd = (world: World): HolderProfileCursor => {
      const row = [...world.rows].sort(compareKeys)[VM_HOLDER_TIER_PROFILE_PAGE_SIZE - 1]!;
      return { agentAddress: row.agentAddress, peerId: row.peerId };
    };

    it('continues after the page that satisfied it instead of starting over, and wraps once it reaches the end', async () => {
      const world = phonebook();
      const cache: VmHolderIdentityCache = new Map();
      const first = await resolveHolderScanWindow(world.deps, cache, VM_HOLDER_TIER_FRESH_SCAN);
      expect(first.resolution).toMatchObject({ kind: 'resolved', peerIds: SIX, stats: { pages: 1, stopped: 'satisfied', rowsLeft: true } });
      expect(first.next.cursor).toEqual(pageEnd(world));

      const second = await resolveHolderScanWindow(world.deps, cache, first.next);
      // It read the rows after the first page, and the holders in the first page stay carried.
      expect(world.requests[1]!.after).toEqual(pageEnd(world));
      expect(second.resolution).toMatchObject({ kind: 'resolved', peerIds: SIX, stats: { pages: 1, stopped: 'satisfied', rowsLeft: false } });
      expect(second.next.cursor).toBeUndefined();
    });

    it('keeps a carried binding whose wallet it left unasked: only the rows it examined count as read', async () => {
      const world = phonebook();
      const first = await resolveHolderScanWindow(world.deps, new Map(), VM_HOLDER_TIER_FRESH_SCAN);
      expect(first.resolution).toMatchObject({ kind: 'resolved', peerIds: SIX });
      // Start again from the first row with no remembered answer and no time: one batch of eight lookups runs and
      // the rest of the page, the holders' wallets among it, is left unasked. The tier is satisfied all the same.
      const held: VmHolderScanState = { cursor: undefined, carried: first.next.carried };
      const second = await resolveHolderScanWindow(world.deps, new Map(), held, undefined, { readBudgetMs: 0 });
      expect(second.resolution).toMatchObject({
        kind: 'resolved',
        peerIds: SIX,
        stats: { stopped: 'satisfied', lookups: VM_HOLDER_TIER_LOOKUP_CONCURRENCY, rowsLeft: true },
      });
      // A wallet left unasked proves nothing about its rows: nothing is dropped, and the walk resumes just before it.
      expect(second.next.carried.size).toBe(SIX.length);
      expect(second.next.cursor).toEqual({ agentAddress: junkWallet(VM_HOLDER_TIER_LOOKUP_CONCURRENCY - 1), peerId: `peer-junk-${VM_HOLDER_TIER_LOOKUP_CONCURRENCY - 1}` });
    });

    it('reports rows left on the phonebook\'s last page when only part of it was asked about', async () => {
      // 26 rows on one page, so the page has no successor: whether rows are left depends on the wallets it asked about.
      const world = createWorld({ junk: 20, holders: satisfiedHolders(5) });
      const first = await resolveHolderScanWindow(world.deps, new Map(), VM_HOLDER_TIER_FRESH_SCAN);
      expect(first.resolution).toMatchObject({ kind: 'resolved', peerIds: SIX, stats: { pages: 1, rowsLeft: false } });
      expect(first.next.cursor).toBeUndefined();
      // No remembered answer and no time: one batch of lookups runs and the rest of the page is left unasked.
      const second = await resolveHolderScanWindow(world.deps, new Map(), { cursor: undefined, carried: first.next.carried }, undefined, { readBudgetMs: 0 });
      expect(second.resolution).toMatchObject({
        kind: 'resolved',
        peerIds: SIX,
        stats: { stopped: 'satisfied', lookups: VM_HOLDER_TIER_LOOKUP_CONCURRENCY, rowsLeft: true },
      });
    });

    it('drops a carried binding whose row is gone once the range holding it has been examined', async () => {
      const world = phonebook();
      const cache: VmHolderIdentityCache = new Map();
      const first = await resolveHolderScanWindow(world.deps, cache, VM_HOLDER_TIER_FRESH_SCAN);
      expect(first.resolution).toMatchObject({ kind: 'resolved', peerIds: SIX });
      world.remove((row) => row.peerId === holderPeer('c1') || row.peerId === holderPeer('c2'));
      // Starting over at the first row examines the range the holders are in: the two that left are dropped.
      const again = await resolveHolderScanWindow(world.deps, cache, { cursor: undefined, carried: first.next.carried });
      expect(again.resolution).toMatchObject({ kind: 'resolved', peerIds: SIX.filter((peer) => !peer.endsWith('c1') && !peer.endsWith('c2')) });
    });

    it('reads on past a flood that satisfies the flooded identity, and ranks the honest peers above it once it gets there', async () => {
      // 300 staler (or future-dated) claims sort ahead of identity 1's two honest peers: the first page satisfies the
      // identity with flood alone, so only a walk that goes on after a satisfied stop ever reads the honest rows.
      for (const [prefix, lastSeen] of [['peer-a-stale', '2010-01-01T00:00:00.000Z'], ['peer-a-future', '2100-01-01T00:00:00.000Z']] as const) {
        const world = createWorld({ holders: [{ name: 'real1', position: 5, identity: 1n }, { name: 'real1b', position: 5, identity: 1n }] });
        for (let index = 0; index < 300; index += 1) world.add({ peerId: `${prefix}-${String(index).padStart(5, '0')}`, agentAddress: holderWallet(5), lastSeen });
        const cache: VmHolderIdentityCache = new Map();
        let state: VmHolderScanState = VM_HOLDER_TIER_FRESH_SCAN;
        const seen: string[][] = [];
        for (let round = 0; round < 4; round += 1) {
          const scanned = await resolveHolderScanWindow(world.deps, cache, state);
          if (scanned.resolution.kind === 'resolved') seen.push([...scanned.resolution.peerIds]);
          state = scanned.next;
        }
        expect(seen[0]).toEqual([`${prefix}-00000`, `${prefix}-00001`]);
        expect(seen[seen.length - 1]).toEqual(['peer-holder-real1', 'peer-holder-real1b']);
        expect(carriedPerIdentity(state.carried).get(1n)).toBeLessThanOrEqual(VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY);
      }
    });

    it('walks through every identity of a large table, one window at a time, and carries the limit for each', async () => {
      const identities = 50;
      const holders: HolderSpec[] = Array.from({ length: identities }, (_, index) => ({ name: `i${index + 1}`, position: index + 1, identity: BigInt(index + 1) }));
      const world = createWorld({ holders });
      for (let identity = 1; identity <= identities; identity += 1) {
        for (let index = 0; index < 30; index += 1) {
          world.add({ peerId: `peer-claim-${identity}-${String(index).padStart(5, '0')}`, agentAddress: holderWallet(identity), lastSeen: FRESH });
        }
      }
      const cache: VmHolderIdentityCache = new Map();
      let state: VmHolderScanState = VM_HOLDER_TIER_FRESH_SCAN;
      for (let round = 0; round < 6; round += 1) {
        state = (await resolveHolderScanWindow(world.deps, cache, state)).next;
      }
      expect(state.carried.size).toBe(identities * VM_HOLDER_TIER_CARRY_PEERS_PER_IDENTITY);
    });

    it('falls back to the identity\'s next-best carried peers when its best one leaves, without waiting for the walk to reach them', async () => {
      // Identity 1 has three wallets far apart: rows 10, 1,200 and 2,500 of 3,000 junk wallets. The best peer's row
      // is in the first window of every pass, the other two are read much later in it.
      const holders: HolderSpec[] = [
        { name: 'k1', position: 10, identity: 1n },
        { name: 'k2', position: 1_200, identity: 1n },
        { name: 'k3', position: 2_500, identity: 1n },
      ];
      const world = createWorld({ junk: 3_000, holders });
      const cache: VmHolderIdentityCache = new Map();
      let state: VmHolderScanState = VM_HOLDER_TIER_FRESH_SCAN;
      for (let round = 0; round < 40 && carriedPerIdentity(state.carried).get(1n) !== 3; round += 1) {
        state = (await resolveHolderScanWindow(world.deps, cache, state)).next;
        world.clock.now += 120_000;
      }
      expect(carriedPerIdentity(state.carried).get(1n)).toBe(3);
      // The best peer leaves. The walk starts over at the first window, which holds its row but not the others':
      // the two that remain are carried, so the identity still has its two peers straight away.
      world.remove((row) => row.peerId === holderPeer('k1'));
      const again = await resolveHolderScanWindow(world.deps, cache, { cursor: undefined, carried: state.carried });
      expect(again.resolution).toMatchObject({ kind: 'resolved', peerIds: [holderPeer('k2'), holderPeer('k3')] });
    });

    it.each([
      [7_000, 6],
      [10_000, 0],
    ])('bounds a satisfied walk by rows, not wallets: %i rows sharing 28 wallets each leave the smallest set at %i (the documented limit)', async (crowd, smallest) => {
      vi.useFakeTimers();
      const wallets = Math.ceil(crowd / 28);
      const world = createWorld({ crowd, holders: satisfiedHolders(wallets + 5), clock: () => Date.now(), lookupLatencyMs: 1 });
      const sizes = (await sweepSamples(world, FOUR_HOURS_OF_SWEEPS)).map((peers) => peers.length);
      const established = sizes.indexOf(SIX.length);
      expect(established).toBeGreaterThanOrEqual(0);
      // A satisfied resolution reads one page, 256 rows, however few wallets they share: a pass of about 30
      // resolutions (an hour at two minutes each) is the limit, which 10,000 rows exceed while 7,000 do not.
      expect(Math.min(...sizes.slice(established))).toBe(smallest);
    }, 120_000);

    it('is due again on the failure spacing while rows are left, and after a full period once the walk has wrapped', async () => {
      const world = phonebook();
      const resolver = new VmHolderHintResolver(world.deps);
      await resolver.resolve(); // satisfied with rows left: cut short
      world.clock.now += VM_HOLDER_TIER_FAILURE_RETRY_MS - 1;
      await resolver.resolve();
      expect(world.tableReads).toBe(1);
      world.clock.now += 1;
      await resolver.resolve(); // reaches the end of the phonebook, still satisfied: nothing left
      expect(world.tableReads).toBe(2);
      world.clock.now += VM_HOLDER_TIER_RESOLUTION_TTL_MS - 1;
      await resolver.resolve();
      expect(world.tableReads).toBe(2);
      world.clock.now += 1;
      await resolver.resolve();
      expect(world.tableReads).toBe(3);
    });
  });
});

describe('a read queued behind a running one after close() or reset()', () => {
  /** A read that waits on its page read until released, and a second caller queued behind it by an invalidation. */
  async function queuedBehindRunning() {
    const world = createWorld({ junk: 0, holders: [{ name: 'a', position: 0, identity: 7n }] });
    const gate = deferred();
    world.pageHook = async (read) => { if (read === 1) await gate.promise; };
    const resolver = new VmHolderHintResolver(world.deps);
    const running = resolver.resolve();
    await tick();
    resolver.invalidate(); // a phonebook arrival: the next caller must not join the running read
    const queued = resolver.resolve();
    await tick();
    return { world, gate, resolver, running, queued };
  }

  it('never starts: the running read ends, and the queued one reads nothing and reports that it was reset', async () => {
    const { world, gate, resolver, running, queued } = await queuedBehindRunning();
    resolver.reset(); // the shutdown
    gate.release();
    expect(await running).toMatchObject({ kind: 'resolved' });
    expect(await queued).toEqual({ kind: 'unavailable', reason: 'reset' });
    await tick(20);
    // Nothing but the running read touched the chain or the phonebook, and nothing was remembered by the queued one.
    expect(world.tableReads).toBe(1);
    expect(world.pageCalls).toBe(1);
    expect(world.rpc.total).toBe(1);
    // The resolver itself stays usable: the next caller reads afresh.
    expect(await resolver.resolve()).toMatchObject({ kind: 'resolved', peerIds: [holderPeer('a')] });
    expect(world.tableReads).toBe(2);
  });

  it('is not joined by a caller that arrives after the reset: that caller gets one read of its own, behind the running one', async () => {
    const { world, gate, resolver, running, queued } = await queuedBehindRunning();
    resolver.reset();
    const after = resolver.resolve();
    const alsoAfter = resolver.resolve();
    await tick();
    gate.release();
    expect(await queued).toEqual({ kind: 'unavailable', reason: 'reset' });
    const [read, sameRead] = await Promise.all([after, alsoAfter]);
    expect(read).toMatchObject({ kind: 'resolved', peerIds: [holderPeer('a')] });
    expect(sameRead).toBe(read);
    await running;
    // The running read and the one read after the reset: never two at once, never a third.
    expect(world.tableReads).toBe(2);
    expect(world.rpc.peak).toBeLessThanOrEqual(VM_HOLDER_TIER_LOOKUP_CONCURRENCY);
  });

  it('still starts when it was queued only by an invalidation: that caller is owed a read', async () => {
    const { world, gate, queued } = await queuedBehindRunning();
    gate.release();
    expect(await queued).toMatchObject({ kind: 'resolved', peerIds: [holderPeer('a')] });
    expect(world.tableReads).toBe(2);
  });

  it('controller.close() leaves a graph whose refresh was queued without an entry and without a read', async () => {
    const world = createWorld({ junk: 0, holders: [{ name: 'a', position: 0, identity: 7n }] });
    const gate = deferred();
    world.pageHook = async (read) => { if (read === 1) await gate.promise; };
    const controller = new VmHolderTierController({ enabled: () => true, readPolicy: async () => 'public', hints: world.deps, log: () => undefined });
    const running = controller.refresh('cg-a', { isCurrent: () => true });
    await tick();
    controller.invalidateHints(['cg-b']);
    const queued = controller.refresh('cg-b', { isCurrent: () => true });
    await tick();
    controller.close();
    gate.release();
    await Promise.all([running, queued]);
    await tick(20);
    expect(world.tableReads).toBe(1);
    expect(controller.entryFor('cg-a')).toBeUndefined();
    expect(controller.entryFor('cg-b')).toBeUndefined();
  });
});

describe('a peer the window verified, which the per-identity bound turned away, takes its slot once the peers that crowded it out are swept', () => {
  // Identity 1 has four fresher claims on its wallet (F1 to F4) and one honest peer that ranks below them. The honest
  // peer is verified in every window that reads its row, yet the four better peers keep it out of the carry.
  const FORGED = (index: number): string => `peer-forged-${index}`;
  const HONEST = holderPeer('h');
  const worldWithClaims = (): World => {
    const world = createWorld();
    for (const index of [1, 2, 3, 4]) world.add({ peerId: FORGED(index), agentAddress: holderWallet(1), lastSeen: FRESH }, 1n);
    world.add({ peerId: HONEST, agentAddress: holderWallet(1), lastSeen: OLD }, 1n);
    return world;
  };

  it('turns the peer away while the four better ranked claims are still there', async () => {
    const world = worldWithClaims();
    const cache: VmHolderIdentityCache = new Map();
    const first = await resolveHolderScanWindow(world.deps, cache, VM_HOLDER_TIER_FRESH_SCAN);
    expect(carriedPeers(first.next.carried, 1n)).toEqual([1, 2, 3, 4].map(FORGED));
    const again = await resolveHolderScanWindow(world.deps, cache, { cursor: undefined, carried: first.next.carried });
    expect(carriedPeers(again.next.carried, 1n)).toEqual([1, 2, 3, 4].map(FORGED));
    expect(again.resolution).toMatchObject({ kind: 'resolved', peerIds: [FORGED(1), FORGED(2)] });
  });

  it.each([
    ['all four claims are gone', [1, 2, 3, 4], [HONEST], [HONEST]],
    ['two of the four claims are gone', [1, 2], [FORGED(3), FORGED(4), HONEST], [FORGED(3), FORGED(4)]],
  ])('carries it in the window that finds %s, instead of one pass later', async (_name, gone, carriedAfter, selectedAfter) => {
    const world = worldWithClaims();
    const cache: VmHolderIdentityCache = new Map();
    const first = await resolveHolderScanWindow(world.deps, cache, VM_HOLDER_TIER_FRESH_SCAN);
    expect(carriedPeers(first.next.carried, 1n)).toEqual([1, 2, 3, 4].map(FORGED));

    // The window that reads the honest row also examines the rows the gone claims were carried from.
    world.remove((row) => gone.map(FORGED).includes(row.peerId));
    const again = await resolveHolderScanWindow(world.deps, cache, { cursor: undefined, carried: first.next.carried });
    expect(carriedPeers(again.next.carried, 1n)).toEqual([...carriedAfter].sort(codeUnits));
    expect(again.resolution).toMatchObject({ kind: 'resolved', peerIds: selectedAfter });
  });
});
