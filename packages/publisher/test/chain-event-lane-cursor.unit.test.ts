/**
 * The `kaRootMutations` lane's cursor, recovery and observability behavior
 * through `ChainEventLaneRunner` (#2435, PR #2436 reviews r2/r11/r14): restore
 * rewind and the zero floor, failure-streak rewind, idle cost, the periodic
 * re-scan, failed-scan cursor holds, metrics fault isolation and lane health.
 * Split from the root-mutation suite at review r16; the existing
 * `chain-event-lane-runner.unit.test.ts` already sits at the size threshold,
 * so these lane-runner rows live here rather than growing it past 1,000.
 */
import { describe, it, expect } from 'vitest';
import {
  ChainEventPoller,
  type ChainEventLanePollResult,
  type ChainEventPollerLane,
  type LaneCursorPersistence,
} from '../src/chain-event-poller.js';
import {
  CADENCE_MS,
  MAX_RANGE,
  makeChain,
  makeHandler,
  poll,
  rootMutation,
  forceScan,
} from './chain-event-poller-harness.js';

describe('kaRootMutations — cursor restore and failure recovery', () => {
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

  it('adopts the retired collectionUpdates cursor instead of live-seeding past it (review r22)', async () => {
    // A lane rename must not orphan an embedder durable cursor: with
    // collectionUpdates=1,000 persisted and a 20,000-block head, a fresh
    // kaRootMutations lane would otherwise live-seed to 11,000 and
    // permanently skip blocks 1,001..11,000.
    const saves: Array<{ lane: string; block: number }> = [];
    const { adapter, filters } = makeChain(20_000);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => 0,
      cursorPersistence: {
        async loadLane(lane) { return (lane as string) === 'collectionUpdates' ? 1_000 : undefined; },
        async saveLane(lane, block) { saves.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);

    // Adopted (1,000), rewound by 50; the first scan starts where the OLD
    // cursor stood — not at head-9,000 — and the first forward-scan save
    // re-homes the ADVANCED cursor under the new key (review r25: no
    // restore-time save, so a crash cannot freeze an uncapped adoption).
    expect(filters[0].fromBlock).toBe(951);
    const rehomed = saves.find((s2) => s2.lane === 'kaRootMutations');
    expect(rehomed?.block).toBe(9_950);
  });
  it('an adopted cursor NEAR HEAD is capped at the activation lookback (review r25)', async () => {
    // The retired cursor proves coverage for ONE event type. Treating it as
    // all-four coverage would skip a recent root-added forever: with
    // collectionUpdates=20,000 at head 20,000, a KnowledgeAssetMerkleRootAdded
    // at 19,500 must still be delivered — the capped start (11,001) is what
    // a cold activation would have scanned anyway.
    const seen: number[] = [];
    const chain = makeChain(20_000, [rootMutation('KnowledgeAssetMerkleRootAdded', 19_500)]);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => 0,
      cursorPersistence: {
        async loadLane(lane) { return (lane as string) === 'collectionUpdates' ? 20_000 : undefined; },
        async saveLane() { /* not under test */ },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    await poll(poller);

    expect(chain.filters[0].fromBlock).toBe(11_001);
    expect(seen).toContain(19_500);
  });
  it('an existing kaRootMutations cursor WINS over the retired key (review r23)', async () => {
    // Precedence matters: always-adopting would move the lane to the
    // retired cursor (18,000) and skip root-added/replaced/removed events
    // in 12,001..17,950 — blocks the retired lane never subscribed to.
    const saves: Array<{ lane: string; block: number }> = [];
    const { adapter, filters } = makeChain(20_000);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => 0,
      cursorPersistence: {
        async loadLane(lane) {
          if ((lane as string) === 'kaRootMutations') return 12_000;
          if ((lane as string) === 'collectionUpdates') return 18_000;
          return undefined;
        },
        async saveLane(lane, block) { saves.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);

    // The current cursor is retained (rewound), no migration save occurs.
    expect(filters[0].fromBlock).toBe(11_951);
    expect(saves.some((s2) => s2.block === 18_000)).toBe(false);
  });
  it('a cursor rewound to the ZERO floor scans from block 1, never live-seeds (review r14)', async () => {
    // Zero is also the uninitialized sentinel: without restored-state
    // tracking, a persisted cursor of 25 rewound by 50 reads as "no cursor"
    // and the lane live-seeds to head - 9_000 — skipping every mutation in
    // blocks 1..11_000 DESPITE having restored a cursor. The boundary case
    // (saved === rewind) floors identically.
    for (const saved of [25, 50]) {
      const { adapter, filters } = makeChain(20_000);
      const poller = new ChainEventPoller({
        chain: adapter,
        publishHandler: makeHandler(),
        intervalMs: CADENCE_MS,
        clock: () => 0,
        cursorPersistence: {
          async loadLane(lane) { return lane === 'kaRootMutations' ? saved : undefined; },
          async saveLane() { /* not under test */ },
        } satisfies LaneCursorPersistence,
        onKnowledgeAssetRootMutated: async () => { /* sink */ },
      });
      await poll(poller);
      expect(filters.length, `saved=${saved}`).toBeGreaterThan(0);
      expect(filters[0].fromBlock, `saved=${saved}`).toBe(1);
    }
  });
  it('does not persist a cursor for a scan that failed', async () => {
    // The runner catches per-lane scan errors, so the forced scan settles normally.
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
    await forceScan(poller);

    expect(chain.filters).toHaveLength(1);
    expect(saveCalls).toEqual([]);

    // Positive control: the very same drive persists when the scan succeeds,
    // so the empty `saveCalls` above is about the failure and not about
    // the forced scan never persisting anything.
    //
    // 49 950, not the head: the failed scan rewound the cursor from the seed
    // (41 000) to 40 950, so the recovery scan starts at 40 951 and is capped
    // at one MAX_RANGE page. The rewind therefore costs one extra poll to
    // reach the head — which is the intended trade and worth pinning, since a
    // rewind large enough to push catch-up past a page every time would turn a
    // transient failure into a permanently lagging lane.
    await forceScan(poller);
    expect(saveCalls).toEqual([{ lane: 'kaRootMutations', block: 40_951 + MAX_RANGE - 1 }]);
  });
});

describe('kaRootMutations — idle cost and periodic re-scan', () => {
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

  it('a REJECTED replay window is retained and retried until dispatch succeeds (review r19)', async () => {
    // The replay is the only mechanism recovering events a lagging RPC hid,
    // and its window trails the head: if the durable handler rejects during
    // a replay and the failure is merely logged, the next scheduled tick
    // derives a NEWER window and the mutation exits the trailing range
    // forever — despite the callback documented redelivery contract.
    let now = 0;
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 45_000)]);
    const seen: number[] = [];
    let rejectReplays = 0;
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async (e) => {
        seen.push(e.position.blockNumber);
        // the FORWARD delivery succeeds; replay deliveries reject while armed
        if (seen.length > 1 && rejectReplays > 0) {
          rejectReplays -= 1;
          throw new Error('consumer could not record the replayed event');
        }
      },
    });

    rejectReplays = 2; // the replay dispatch must survive MULTIPLE rejections
    for (let tick = 1; tick <= 25; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }
    // Tick 25 replayed the window and the handler rejected: one forward
    // delivery, one rejected replay delivery so far.
    expect(seen).toEqual([45_000, 45_000]);

    // The head advances far beyond the trailing window: a NEWLY derived
    // window could never contain the mutation again.
    chain.setHead(70_000);
    await poll(poller);          // retry #1: still rejected
    now += CADENCE_MS;
    await poll(poller);          // retry #2: accepted
    now += CADENCE_MS;

    // The SAME retained window was retried on consecutive polls (not just
    // every 25th) until the consumer took responsibility.
    expect(seen).toEqual([45_000, 45_000, 45_000, 45_000]);
    // …and a further poll does not re-dispatch: the retained window cleared.
    await poll(poller);
    now += CADENCE_MS;
    expect(seen).toEqual([45_000, 45_000, 45_000, 45_000]);
  });

  it('the replay window is persisted BEFORE its dispatch runs (review r24)', async () => {
    // Write-ahead: a crash while the callback is in flight must leave a
    // durable pending record — persisting only after rejection loses the
    // window entirely while the forward cursor durably stays ahead of it.
    const sequence: string[] = [];
    let now = 0;
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 45_000)]);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane() { /* cursor writes not under test */ },
        replayRetry: {
          async load() { return undefined; },
          async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
            sequence.push(w ? `save:${w.fromBlock}-${w.toBlock}` : 'save:clear');
          },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => {
        if (sequence.length > 0 || now >= CADENCE_MS * 24) sequence.push(`deliver:${e.position.blockNumber}`);
      },
    });
    for (let tick = 1; tick <= 25; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }
    // At the rescan tick the WAL save precedes the replay delivery.
    expect(sequence[0]).toBe('save:41001-50000');
    expect(sequence[1]).toBe('deliver:45000');
    expect(sequence[2]).toBe('save:clear');
  });

  it('a transient CURSOR read failure is not a successful restore (review r27)', async () => {
    // The maintainer’s repro: head 20,000, durable cursor 1,000, one-shot
    // SQLITE_BUSY on the load. Marking the lane restored anyway would seed
    // at 11,001 and the next persist would seal the skip of blocks
    // 1,001–11,000 forever. The lane must not scan AT ALL until a load
    // completes; the next poll retries and starts from the durable cursor.
    let loadAttempts = 0;
    let now = 0;
    const saves: number[] = [];
    const seen: number[] = [];
    const chain = makeChain(20_000, [rootMutation('KnowledgeAssetUpdated', 5_000)]);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() {
          loadAttempts += 1;
          if (loadAttempts === 1) throw new Error('SQLITE_BUSY');
          return 1_000;
        },
        async saveLane(_lane, blockNumber) { saves.push(blockNumber); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    await poll(poller);
    expect(chain.filters, 'an unrestored lane must not scan').toHaveLength(0);
    expect(saves, 'and must persist NOTHING head-derived').toHaveLength(0);

    now += CADENCE_MS;
    await poll(poller);

    expect(loadAttempts).toBeGreaterThanOrEqual(2);
    expect(chain.filters[0]!.fromBlock, 'the durable cursor won, rewound by 50').toBe(951);
    expect(seen, 'the below-lookback range was scanned, not skipped').toContain(5_000);
  });
  it('a transient replay-window load failure is retried on a LATER poll (reviews r24/r26)', async () => {
    // A locked store at restore time must not read as nothing-retained for
    // the lifetime of the runner — and the eligibility must survive a POLL
    // BOUNDARY (review r26): every attempt of the first poll fails here, so
    // an implementation that only retried once, immediately, and dropped the
    // flag would deliver nothing. The store recovers only for the next due
    // poll, which must retry, restore the exact window, and dispatch.
    let loadAttempts = 0;
    let now = 0;
    const seen: number[] = [];
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 45_000)]);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return 50_000; },
        async saveLane() { /* not under test */ },
        replayRetry: {
          async load() {
            loadAttempts += 1;
            if (loadAttempts <= 2) throw new Error('SQLITE_BUSY');
            return { fromBlock: 41_001, toBlock: 50_000 };
          },
          async save() { /* not under test */ },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    await poll(poller);   // restore throws; the in-scan retry throws too
    expect(seen, 'the first poll had no window to dispatch').toHaveLength(0);
    expect(loadAttempts).toBe(2);

    now += CADENCE_MS;
    await poll(poller);   // a LATER poll retries, restores, dispatches

    expect(loadAttempts).toBe(3);
    expect(seen).toContain(45_000);
  });

  it('a failed re-home write does not forfeit the adopted cursor (review r24/r25)', async () => {
    // The adopted cursor must remain usable in memory when
    // saveLane('kaRootMutations', …) rejects — live-seeding instead would
    // skip the very interval the migration preserves. Since r25 the re-home
    // write happens at the first forward-scan persist (post-cap), so the
    // rejection now hits there; the scan itself must still run from the
    // adopted position.
    const { adapter, filters } = makeChain(20_000);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => 0,
      cursorPersistence: {
        async loadLane(lane) { return (lane as string) === 'collectionUpdates' ? 1_000 : undefined; },
        async saveLane(lane) {
          if ((lane as string) === 'kaRootMutations') throw new Error('disk full');
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);

    expect(filters[0].fromBlock).toBe(951);
  });
  it('a rejected replay window SURVIVES a process restart via the optional store methods (review r20)', async () => {
    // The forward cursor is durable; an in-memory-only retained window
    // would let a replay-discovered mutation be lost across a restart while
    // the cursor stays ahead of it. The window is persisted on rejection,
    // reloaded on restore, retried, and cleared on success.
    const saves: Array<{ fromBlock: number; toBlock: number } | undefined> = [];
    let persisted: { fromBlock: number; toBlock: number } | undefined;
    let cursor: number | undefined;
    const store = {
      async loadLane() { return cursor; },
      async saveLane(_lane: ChainEventPollerLane, block: number) { cursor = block; },
      replayRetry: {
        async load() { return persisted; },
        async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
          saves.push(w ? { ...w } : undefined);
          persisted = w ? { ...w } : undefined;
        },
      },
    } satisfies LaneCursorPersistence;

    let now = 0;
    const chain1 = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 45_000)]);
    const seen1: number[] = [];
    let rejectReplay = true;
    const poller1 = new ChainEventPoller({
      chain: chain1.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: store,
      onKnowledgeAssetRootMutated: async (e) => {
        seen1.push(e.position.blockNumber);
        if (seen1.length > 1 && rejectReplay) {
          throw new Error('consumer down during replay');
        }
      },
    });
    for (let tick = 1; tick <= 25; tick += 1) {
      await poll(poller1);
      now += CADENCE_MS;
    }
    // Tick 25 replayed, the handler rejected, the window was PERSISTED.
    expect(saves).toHaveLength(1);
    expect(saves[0]).toEqual({ fromBlock: 41_001, toBlock: 50_000 });

    // "Restart": a NEW poller over the same durable store. The mutation is
    // still on chain but far behind the cursor — only the restored window
    // can reach it.
    const chain2 = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 45_000)]);
    const seen2: number[] = [];
    rejectReplay = false;
    const poller2 = new ChainEventPoller({
      chain: chain2.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: store,
      onKnowledgeAssetRootMutated: async (e) => { seen2.push(e.position.blockNumber); },
    });
    await poll(poller2);

    // The restored window was retried on the FIRST poll and cleared on success.
    expect(seen2).toContain(45_000);
    expect(saves[saves.length - 1]).toBeUndefined();
    expect(persisted).toBeUndefined();
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
  });});

describe('kaRootMutations — observability', () => {
  it('a throwing metrics sink never affects delivery, cursor persistence, or later scans (review r11)', async () => {
    // Metrics are observers, not participants: run the SAME drive twice, once
    // with sinks that always throw and once with none, and require identical
    // deliveries and identical persisted cursors. The lag hook fires before
    // the scan and the result hook after it, so an unisolated throw in either
    // would abort delivery or skip persistence after state advanced.
    async function drive(withThrowingSinks: boolean): Promise<{ seen: string[]; saved: number[] }> {
      const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 49_990)]);
      const seen: string[] = [];
      const saved: number[] = [];
      const poller = new ChainEventPoller({
        chain: chain.adapter,
        publishHandler: makeHandler(),
        intervalMs: CADENCE_MS,
        clock: () => 0,
        cursorPersistence: {
          async loadLane() { return undefined; },
          async saveLane(_lane, block) { saved.push(block); },
        } satisfies LaneCursorPersistence,
        ...(withThrowingSinks ? {
          metrics: {
            laneScan: () => { throw new Error('exporter down'); },
            laneCursorLag: () => { throw new Error('exporter down'); },
          },
        } : {}),
        onKnowledgeAssetRootMutated: async (e) => { seen.push(e.kaId); },
      });
      await forceScan(poller);
      // A second manual drive proves failure bookkeeping and schedules were
      // not corrupted by the throwing result hook of the first.
      chain.setHead(50_010);
      await forceScan(poller);
      return { seen, saved };
    }

    const throwing = await drive(true);
    const clean = await drive(false);
    expect(throwing.seen).toEqual(clean.seen);
    expect(throwing.seen.length).toBeGreaterThan(0);
    expect(throwing.saved).toEqual(clean.saved);
    expect(throwing.saved.length).toBeGreaterThan(0);
  });

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
  });});
