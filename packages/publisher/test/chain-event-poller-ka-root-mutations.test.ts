/**
 * `ChainEventPoller` — the `kaRootMutations` lane (#2435).
 *
 * The lane was declared long ago as `collectionUpdates`, gated on a callback
 * nothing ever passed, subscribed to one of the four events that actually
 * mutate a KA's root set, and shaped as a batch-id/`Uint8Array` payload that no
 * consumer could order or de-duplicate. This file is the specification of what
 * it is now.
 *
 * Every row here is written so it can fail:
 *
 *  - The subscription is asserted against the CHAIN PACKAGE's constant, not a
 *    literal, so the lane and the adapter branch cannot drift apart.
 *  - The idle-cost row counts `listenForEvents` CALLS. A rewind applied per
 *    tick — the obvious way to get reorg tolerance — would make a caught-up
 *    lane pay an `eth_getLogs` every cadence forever, and nothing about the
 *    dispatched events would look different.
 *  - The no-swallow row asserts the cursor is HELD, not that a log line was
 *    written: wrapping the callback in `try/catch` (as every sibling handler
 *    does) still logs, still looks healthy, and loses the event permanently.
 *  - The `pollNow` rows measure BOTH polarities — a plain `poll()` inside the
 *    cadence window must scan nothing, or the seam proves nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { Logger, TypedEventBus } from '@origintrail-official/dkg-core';
import {
  KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES,
  type ChainAdapter,
  type ChainEvent,
  type EventFilter,
} from '@origintrail-official/dkg-chain';
import { decodeKnowledgeAssetRootMutationEvent } from '../src/ka-root-mutation-decode.js';
import {
  ChainEventPoller,
  type ChainEventLanePollResult,
  type ChainEventPollerLane,
  type KnowledgeAssetRootMutationEventV1,
  type LaneCursorPersistence,
} from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';

const MAX_RANGE = 9_000;
const CADENCE_MS = 12_000;

const TX_HASH = '0x' + 'aa'.repeat(32);
const BLOCK_HASH = '0x' + 'bb'.repeat(32);
const ROOT = '0x' + '44'.repeat(32);
const AUTHOR = '0x' + '11'.repeat(20);

function makeHandler(): PublishHandler {
  return new PublishHandler(new OxigraphStore(), new TypedEventBus());
}

interface Harness {
  adapter: ChainAdapter;
  filters: EventFilter[];
  setHead(next: number): void;
  failNextScan(err?: Error): void;
}

function makeChain(head: number, events: ChainEvent[] = []): Harness {
  const filters: EventFilter[] = [];
  let currentHead = head;
  let failWith: Error | null = null;
  const adapter = {
    chainId: 'mock:0',
    getBlockNumber: async () => currentHead,
    listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
      filters.push(f);
      if (failWith) {
        const err = failWith;
        failWith = null;
        throw err;
      }
      const fromBlock = f.fromBlock ?? 0;
      const toBlock = f.toBlock ?? Number.MAX_SAFE_INTEGER;
      for (const evt of events) {
        if (f.eventTypes.includes(evt.type) && evt.blockNumber >= fromBlock && evt.blockNumber <= toBlock) {
          yield evt;
        }
      }
    },
  } as unknown as ChainAdapter;
  return {
    adapter,
    filters,
    setHead: (next) => { currentHead = next; },
    failNextScan: (err = new Error('scan boom')) => { failWith = err; },
  };
}

function rootMutation(
  type: (typeof KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES)[number],
  blockNumber: number,
  overrides: Record<string, unknown> = {},
): ChainEvent {
  const base: Record<string, unknown> = {
    kaId: '42',
    txHash: TX_HASH,
    blockHash: BLOCK_HASH,
    txIndex: 2,
    logIndex: 5,
  };
  if (type !== 'KnowledgeAssetMerkleRootsUpdated') base['merkleRoot'] = ROOT;
  if (type === 'KnowledgeAssetUpdated') base['author'] = AUTHOR;
  return { type, blockNumber, data: { ...base, ...overrides } };
}

/** Drive `poll()` directly — the interval timer is never started here. */
function poll(poller: ChainEventPoller): Promise<void> {
  return (poller as unknown as { poll(): Promise<void> }).poll();
}

describe('ChainEventPoller — kaRootMutations subscription', () => {
  it('subscribes with exactly the chain package join constant', async () => {
    const chain = makeChain(1_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);

    expect(chain.filters).toHaveLength(1);
    expect(chain.filters[0].eventTypes).toEqual([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);
  });

  it('does not subscribe at all when no callback is wired', async () => {
    const chain = makeChain(1_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
    });

    await poll(poller);

    expect(chain.filters).toEqual([]);
  });

  it('seeds one full RPC page back from the head on first activation', async () => {
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);

    expect(chain.filters[0].fromBlock).toBe(50_000 - MAX_RANGE + 1);
    expect(chain.filters[0].toBlock).toBe(50_000);
  });
});

describe('decodeKnowledgeAssetRootMutationEvent — core-boundary canonicalization (review r5)', () => {
  // The decoder is the ONE boundary from the loose ChainEvent bag to the typed
  // union, and every judgement is core's — these rows pin the two drifts the
  // review caught in the ad-hoc predecessors.
  it('rejects a leading-zero kaId that the old digit-only regex used to accept', () => {
    const r = decodeKnowledgeAssetRootMutationEvent(
      rootMutation('KnowledgeAssetMerkleRootAdded', 50, { kaId: '00042' }),
    );
    expect(r).toEqual({ ok: false, reason: 'noncanonical-ka-id' });
  });

  it('accepts the full canonical u256 range', () => {
    const max = (2n ** 256n - 1n).toString();
    const r = decodeKnowledgeAssetRootMutationEvent(
      rootMutation('KnowledgeAssetMerkleRootAdded', 50, { kaId: max }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mutation.kaId).toBe(max);
  });

  it('rejects an unsafe-integer transaction index that Number.isInteger used to accept', () => {
    const r = decodeKnowledgeAssetRootMutationEvent(
      rootMutation('KnowledgeAssetMerkleRootAdded', 50, { txIndex: 2 ** 53 }),
    );
    expect(r).toEqual({ ok: false, reason: 'noncanonical-position' });
  });

  it('classifies an unserved event name without warning-noise', () => {
    const r = decodeKnowledgeAssetRootMutationEvent({ type: 'SomethingElse', blockNumber: 1, data: {} });
    expect(r).toEqual({ ok: false, reason: 'unknown-event-type' });
  });
});

describe('ChainEventPoller — kaRootMutations payload', () => {
  async function dispatchOne(event: ChainEvent): Promise<KnowledgeAssetRootMutationEventV1[]> {
    const chain = makeChain(100, [event]);
    const seen: KnowledgeAssetRootMutationEventV1[] = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e); },
    });
    await poll(poller);
    return seen;
  }

  it('maps every event type to its kind', async () => {
    const events = KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES.map((t, i) => rootMutation(t, 50 + i));
    const chain = makeChain(100, [...events]);
    const seen: KnowledgeAssetRootMutationEventV1[] = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e); },
    });

    await poll(poller);

    expect(seen.map((e) => e.kind)).toEqual([
      'lifecycle-update',
      'root-added',
      'roots-replaced',
      'root-removed',
    ]);
  });

  it('carries author on the lifecycle update only, and no root on roots-replaced', async () => {
    const [update] = await dispatchOne(rootMutation('KnowledgeAssetUpdated', 50));
    const [added] = await dispatchOne(rootMutation('KnowledgeAssetMerkleRootAdded', 50));
    const [replaced] = await dispatchOne(rootMutation('KnowledgeAssetMerkleRootsUpdated', 50));

    expect(update.author).toBe(AUTHOR);
    expect(update.merkleRoot).toBe(ROOT);
    expect('author' in added).toBe(false);
    expect(added.merkleRoot).toBe(ROOT);
    expect('author' in replaced).toBe(false);
    expect('merkleRoot' in replaced).toBe(false);
  });

  it('lowercases a checksummed author and nulls the zero address', async () => {
    const checksummed = '0xAbC0000000000000000000000000000000000001';
    const [mixed] = await dispatchOne(
      rootMutation('KnowledgeAssetUpdated', 50, { author: checksummed }),
    );
    const [zero] = await dispatchOne(
      rootMutation('KnowledgeAssetUpdated', 50, { author: '0x' + '00'.repeat(20) }),
    );

    expect(mixed.author).toBe(checksummed.toLowerCase());
    // The unattributed publish path. `null` — not the literal zero address —
    // so a consumer never records a real-looking author nobody attested.
    expect(zero.author).toBeNull();
  });

  it('records a noncanonical author as null rather than dropping the event', async () => {
    // `author` is advisory; the asset identity is not. Dropping the event over
    // a bad author field would lose a convergence for a cosmetic reason.
    const seen = await dispatchOne(
      rootMutation('KnowledgeAssetUpdated', 50, { author: 'not-an-address' }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].author).toBeNull();
    expect(seen[0].kaId).toBe('42');
  });

  it('drops an event whose chain position is incomplete', async () => {
    // The position is what a consumer orders and de-duplicates on. A missing
    // block hash makes "is this newer than what I stored" unanswerable, so the
    // event is unusable — but it must NOT throw, or one malformed log stalls
    // the lane behind it forever.
    for (const broken of [
      { blockHash: undefined },
      { txHash: 'not-a-hash' },
      { txIndex: -1 },
      { logIndex: 'x' },
      { kaId: '0xdead' },
    ]) {
      const seen = await dispatchOne(rootMutation('KnowledgeAssetUpdated', 50, broken));
      expect(seen, JSON.stringify(broken)).toEqual([]);
    }
  });

  it('advances the cursor even when every event in the window was dropped', async () => {
    const chain = makeChain(100, [rootMutation('KnowledgeAssetUpdated', 50, { blockHash: undefined })]);
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane, block) { saveCalls.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* never called */ },
    });

    await poll(poller);

    expect(saveCalls).toEqual([{ lane: 'kaRootMutations', block: 100 }]);
  });
});

describe('ChainEventPoller — kaRootMutations does not swallow', () => {
  it('a rejecting callback holds the cursor and applies the failure backoff', async () => {
    let now = 0;
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 45_000)]);
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane, block) { saveCalls.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { throw new Error('consumer could not record it'); },
    });

    await poll(poller);

    // Nothing persisted: the window was NOT taken responsibility for.
    expect(saveCalls).toEqual([]);

    // Backoff is 60 s, well past one cadence — a poll at +cadence finds the
    // lane not due and issues no second scan.
    now = CADENCE_MS;
    await poll(poller);
    expect(chain.filters).toHaveLength(1);

    // At +60 s the lane is due again and re-scans, rewound by 50 blocks from
    // where the failed scan left the cursor (the seed, 41 000).
    now = 60_000;
    await poll(poller);
    expect(chain.filters).toHaveLength(2);
    expect(chain.filters[1].fromBlock).toBe(41_000 - 50 + 1);
  });

  it('rewinds once per failure streak, not once per failure', async () => {
    // An unbounded backward walk during a long outage would re-dispatch that
    // whole stretch on recovery.
    let now = 0;
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    chain.failNextScan();
    await poll(poller);
    now = 60_000;
    chain.failNextScan();
    await poll(poller);
    now = 60_000 + 120_000;
    await poll(poller);

    expect(chain.filters).toHaveLength(3);
    const rewound = 41_000 - 50 + 1;
    expect(chain.filters[1].fromBlock).toBe(rewound);
    expect(chain.filters[2].fromBlock).toBe(rewound);
  });
});

describe('ChainEventPoller — kaRootMutations cursor restore', () => {
  it('rewinds a restored cursor by 50 blocks; lanes without the field are unchanged', async () => {
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      cursorPersistence: {
        async loadLane() { return 1_000; },
        async saveLane() { /* ignored */ },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
      // Same restored cursor, a lane that declares no rewind — the control.
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await poll(poller);

    const byLane = new Map(
      chain.filters.map((f) => [f.eventTypes[0], f] as const),
    );
    expect(byLane.get('KnowledgeAssetUpdated')!.fromBlock).toBe(951);
    expect(byLane.get('KnowledgeAssetRegisteredToContextGraph')!.fromBlock).toBe(1_001);
  });
});

describe('ChainEventPoller — kaRootMutations idle cost and periodic re-scan', () => {
  it('a caught-up idle tick issues zero listenForEvents calls, and every 25th re-scans wide', async () => {
    let now = 0;
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    // Tick 1 catches up to the head.
    await poll(poller);
    expect(chain.filters).toHaveLength(1);
    expect(chain.filters[0].toBlock).toBe(50_000);

    // Ticks 2..24 are caught up and idle. This is the steady state on a live
    // node: it must cost ZERO log reads.
    for (let tick = 2; tick <= 24; tick += 1) {
      now += CADENCE_MS;
      await poll(poller);
    }
    expect(chain.filters).toHaveLength(1);

    // Tick 25 re-scans the trailing page WITHOUT moving the cursor.
    now += CADENCE_MS;
    await poll(poller);
    expect(chain.filters).toHaveLength(2);
    // Inclusive window of EXACTLY one RPC page (review r3): `toBlock - MAX_RANGE`
    // spans MAX_RANGE + 1 blocks, which a strict range cap would reject.
    expect(chain.filters[1].fromBlock).toBe(50_000 - MAX_RANGE + 1);
    expect(chain.filters[1].toBlock).toBe(50_000);
    expect((chain.filters[1].toBlock as number) - (chain.filters[1].fromBlock as number) + 1).toBe(MAX_RANGE);

    // Cursor unchanged: the next forward scan still starts at head + 1, so the
    // re-scan cost nothing in forward progress.
    chain.setHead(50_010);
    now += CADENCE_MS;
    await poll(poller);
    expect(chain.filters).toHaveLength(3);
    expect(chain.filters[2].fromBlock).toBe(50_001);
    expect(chain.filters[2].toBlock).toBe(50_010);
  });

  it('a due re-scan and forward work on the SAME tick both run: replay first, then the cursor advances (review r2)', async () => {
    // On a chain that advances every cadence, tick 25 hits the forward branch,
    // not the caught-up one — a regression that skipped the re-scan whenever
    // forward work exists would be invisible to the idle-tick rows above.
    let now = 0;
    const chain = makeChain(50_000, [
      rootMutation('KnowledgeAssetUpdated', 45_000),
      rootMutation('KnowledgeAssetUpdated', 50_005),
    ]);
    const seen: number[] = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    for (let tick = 1; tick <= 24; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }
    const before = chain.filters.length;

    // Tick 25: head has advanced, so the tick carries BOTH a due re-scan and
    // fresh forward work.
    chain.setHead(50_010);
    await poll(poller);

    const tickFilters = chain.filters.slice(before);
    expect(tickFilters).toHaveLength(2);
    expect(tickFilters[0].fromBlock).toBe(50_000 - MAX_RANGE + 1); // replay window first…
    expect(tickFilters[0].toBlock).toBe(50_000);
    expect(tickFilters[1].fromBlock).toBe(50_001);             // …then the forward window
    expect(tickFilters[1].toBlock).toBe(50_010);
    expect(seen.slice(-2)).toEqual([45_000, 50_005]);          // old replayed, new delivered

    // The forward cursor advanced normally despite the replay.
    chain.setHead(50_020);
    now += CADENCE_MS;
    await poll(poller);
    expect(chain.filters[chain.filters.length - 1].fromBlock).toBe(50_011);
  });

  it('a failing re-scan is logged and skipped: no rewind, no backoff, and the forward scan still runs (review r2)', async () => {
    // Routing a REPLAY failure through the forward failure path would rewind
    // the forward cursor — the one movement the replay is documented never to
    // cause — and gate fresh events behind a provider that rejects wide
    // history ranges.
    let now = 0;
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 50_005)]);
    const seen: number[] = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    for (let tick = 1; tick <= 24; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }

    // Tick 25: the re-scan (first listenForEvents of the tick) throws.
    chain.setHead(50_010);
    chain.failNextScan(new Error('provider rejects wide history ranges'));
    await poll(poller);

    // The forward scan still ran and delivered the fresh event…
    expect(seen).toContain(50_005);
    // …the cursor advanced (no rewind: next forward window starts above head)…
    chain.setHead(50_020);
    now += CADENCE_MS;
    await poll(poller);
    expect(chain.filters[chain.filters.length - 1].fromBlock).toBe(50_011);
    // …and no failure backoff was applied: that last tick was due at the
    // ordinary cadence, one CADENCE_MS after the failing one, and it scanned.
  });

  it('re-dispatches an event the forward scan already passed', async () => {
    // The whole point: an event inside the trailing window reaches the callback
    // a second time, so a forward scan served by a lagging endpoint is
    // recoverable rather than a permanent loss.
    let now = 0;
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 45_000)]);
    const seen: number[] = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    for (let tick = 1; tick <= 25; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }

    expect(seen).toEqual([45_000, 45_000]);
  });

  it('leaves the idle cost and cadence of the other lanes untouched', async () => {
    let now = 0;
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKARegisteredToContextGraph: async () => { /* sink */ },
      onContextGraphCreated: async () => { /* sink */ },
    });

    for (let tick = 1; tick <= 30; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }

    // Two lanes, one catch-up scan each, then silence — no lane without
    // `periodicRescan` ever issues a second read.
    expect(chain.filters).toHaveLength(2);
  });
});

describe('ChainEventPoller — pollNow', () => {
  it('scans inside the cadence window that a plain poll() skips', async () => {
    let now = 0;
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);
    expect(chain.filters).toHaveLength(1);

    // New work appears, but we are still inside the lane's cadence window.
    chain.setHead(50_010);

    // NEGATIVE polarity — without this the positive row proves nothing.
    await poll(poller);
    expect(chain.filters).toHaveLength(1);

    await poller.pollNow();
    expect(chain.filters).toHaveLength(2);
    expect(chain.filters[1].fromBlock).toBe(50_001);
    expect(chain.filters[1].toBlock).toBe(50_010);
  });

  it('concurrent pollNow callers are serialized: scans never interleave and each caller settles (review r3)', async () => {
    // Two concurrent manual callers both passing the empty-state check would
    // run two listenForEvents scans over the same cursor, dispatching every
    // mutation twice and racing cursor/failure state.
    let now = 0;
    let active = 0;
    let maxActive = 0;
    let head = 50_000;
    const setHead = (next: number): void => { head = next; };
    const filters: EventFilter[] = [];
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => head,
      listenForEvents: async function* (f: EventFilter): AsyncIterable<ChainEvent> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        filters.push(f);
        await new Promise((r) => setTimeout(r, 20)); // hold the scan open
        active -= 1;
        // Zero events, but a real yield loop: the interleave counter above is
        // the subject here, and `require-yield` is right that a generator
        // without one is suspicious.
        for (const evt of [] as ChainEvent[]) yield evt;
      },
    } as unknown as ChainAdapter;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await Promise.all([poller.pollNow(), poller.pollNow(), poller.pollNow()]);

    // Never two scans in flight — the race the review named…
    expect(maxActive).toBe(1);
    // …and no duplicate dispatch either: the first serialized caller consumed
    // the window; the later two correctly found the lane caught up (noWork)
    // and issued ZERO further log scans over the same cursor.
    expect(filters.length).toBe(1);

    // Same property with fresh work: two concurrent callers over an advanced
    // head produce exactly ONE scan of the new window, not two.
    setHead(50_010);
    await Promise.all([poller.pollNow(), poller.pollNow()]);
    expect(maxActive).toBe(1);
    expect(filters.length).toBe(2);
    expect(filters[1].fromBlock).toBe(50_001);
    expect(filters[1].toBlock).toBe(50_010);
  });

  it("passing the removed 'onCollectionUpdated' key warns loudly and enables no lane (review r3)", async () => {
    // A JavaScript consumer of the old key would otherwise fail silently. The
    // observable behaviour is unchanged from before the rename — the old lane
    // scanned a name the adapter never yielded, so the callback never fired —
    // but silence about a removed key helps nobody, so construction says so.
    const warned: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(
      (_ctx: unknown, message: string) => { warned.push(message); },
    );
    try {
      const chain = makeChain(100);
      const poller = new ChainEventPoller({
        chain: chain.adapter,
        publishHandler: makeHandler(),
        intervalMs: CADENCE_MS,
        onCollectionUpdated: async () => { /* legacy consumer */ },
      } as never);

      expect(warned.some((m) => m.includes("'onCollectionUpdated' was removed"))).toBe(true);
      expect(warned.some((m) => m.includes('onKnowledgeAssetRootMutated'))).toBe(true);

      await poller.pollNow();
      expect(chain.filters).toHaveLength(0); // the legacy key enables no lane
    } finally {
      spy.mockRestore();
    }
  });

  it('does not persist a cursor for a scan that failed', async () => {
    // The runner catches per-lane scan errors, so `pollNow` settles normally.
    // What must not happen is a SILENT advance: a driven scan that failed must
    // leave the cursor exactly where a driven scan that never ran would.
    const chain = makeChain(50_000);
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane, block) { saveCalls.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    chain.failNextScan();
    await poller.pollNow();

    expect(chain.filters).toHaveLength(1);
    expect(saveCalls).toEqual([]);

    // Positive control: the very same drive persists when the scan succeeds,
    // so the empty `saveCalls` above is about the failure and not about
    // `pollNow` never persisting anything.
    //
    // 49 950, not the head: the failed scan rewound the cursor from the seed
    // (41 000) to 40 950, so the recovery scan starts at 40 951 and is capped
    // at one MAX_RANGE page. The rewind therefore costs one extra poll to
    // reach the head — which is the intended trade and worth pinning, since a
    // rewind large enough to push catch-up past a page every time would turn a
    // transient failure into a permanently lagging lane.
    await poller.pollNow();
    expect(saveCalls).toEqual([{ lane: 'kaRootMutations', block: 40_951 + MAX_RANGE - 1 }]);
  });
});

describe('ChainEventPoller — lane health instruments', () => {
  it('records lane scans and cursor lag with lane and result only', async () => {
    let now = 0;
    const polls: Array<{ lane: ChainEventPollerLane; result: ChainEventLanePollResult }> = [];
    const lags: Array<{ lane: ChainEventPollerLane; lagBlocks: number }> = [];
    // Captured from the PRODUCTION call sites, not from the objects this test
    // builds: an assertion over `Object.keys` of a literal written here would
    // only confirm what this test itself wrote.
    const rawArgCounts: number[] = [];
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      metrics: {
        laneScan: function (...args) {
          rawArgCounts.push(args.length);
          polls.push({ lane: args[0], result: args[1] });
        },
        laneCursorLag: function (...args) {
          rawArgCounts.push(args.length);
          lags.push({ lane: args[0], lagBlocks: args[1] });
        },
      },
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);                      // catch-up  -> success
    now += CADENCE_MS;
    await poll(poller);                      // caught up -> no-work
    now += CADENCE_MS;
    chain.failNextScan();
    chain.setHead(50_100);
    await poll(poller);                      // scan throws -> failure

    expect(polls).toEqual([
      { lane: 'kaRootMutations', result: 'success' },
      { lane: 'kaRootMutations', result: 'noWork' },
      { lane: 'kaRootMutations', result: 'failure' },
    ]);
    // Lag is measured before the scan: seeded 41 000 against head 50 000, then
    // caught up, then 100 blocks behind the advanced head.
    expect(lags).toEqual([
      { lane: 'kaRootMutations', lagBlocks: MAX_RANGE },
      { lane: 'kaRootMutations', lagBlocks: 0 },
      { lane: 'kaRootMutations', lagBlocks: 100 },
    ]);
    // Every production call site passed exactly two arguments — no third
    // channel through which a KA id, context-graph id or transaction hash
    // could reach a metric attribute.
    expect(rawArgCounts.length).toBeGreaterThan(0);
    expect(new Set(rawArgCounts)).toEqual(new Set([2]));
  });

  it('exposes the last scanned head and time per active lane', async () => {
    let now = 1_700_000_000_000;
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    expect(poller.getLaneHealth()).toEqual([
      { lane: 'kaRootMutations', lastBlock: 0, lastScanHead: undefined, lastScanAtMs: undefined },
    ]);

    await poll(poller);

    expect(poller.getLaneHealth()).toEqual([
      { lane: 'kaRootMutations', lastBlock: 50_000, lastScanHead: 50_000, lastScanAtMs: now },
    ]);
  });
});
