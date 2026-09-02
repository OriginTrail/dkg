/**
 * The `kaRootMutations` lane's REPLAY protocol and FINALITY bound through
 * `ChainEventLaneRunner` + `LaneReplayCoordinator` (#2435, PR #2436): idle
 * cost, the periodic re-scan, retained/durable retry windows, write-ahead
 * persistence, and the finalized-head clamp on forward and replay scans.
 * Split at review r9 along the production boundaries.
 */
import {
  describe,
  it,
  expect,
} from 'vitest';
import {
  ChainEventPoller,
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
} from './chain-event-poller-harness.js';


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

  it('a tip mutation is WITHHELD until the configured confirmation depth (review r6-bot)', async () => {
    // FinalizedEventPositionV1 promises finality: a mutation mined at the
    // current head must not be durably dispatched while a reorg can still
    // orphan it — no later scan of the canonical chain would retract the
    // persisted callback result.
    let now = 0;
    const seen: number[] = [];
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 49_998)]);
    (chain.adapter as { finalizedEventScanBound?: (head: number) => number })
      .finalizedEventScanBound = (head) => head - 4;
    const saves: number[] = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return 49_000; },
        async saveLane(_lane: ChainEventPollerLane, block: number) { saves.push(block); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    await poll(poller);
    expect(seen, 'head 50,000 with depth 5 finalizes 49,996 — the event at 49,998 is not eligible').toEqual([]);
    expect(
      Math.max(0, ...saves),
      'the durable cursor must not pass the finalized head',
    ).toBeLessThanOrEqual(49_996);

    // Five more blocks: 49,998 reaches depth 5 and dispatches.
    chain.setHead(50_002);
    now += CADENCE_MS;
    await poll(poller);
    expect(seen, 'the SAME event dispatches once its depth is reached').toEqual([49_998]);
  });
  it('replay never passes the finalized head, even when a restored cursor sits above it (review r7-bot)', async () => {
    // Restore 50,000 with a 50-block rewind -> lastBlock 49,950; depth 60
    // finalizes 49,941. The forward scan is bounded — but replay windows
    // derive from the CURSOR, which here is 9 blocks above the finalized
    // head, and the periodic rescan at tick 25 would otherwise deliver the
    // unfinalized event at 49,945.
    let now = 0;
    const seen: number[] = [];
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 49_945)]);
    (chain.adapter as { finalizedEventScanBound?: (head: number) => number })
      .finalizedEventScanBound = (head) => head - 59;
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return 50_000; },
        async saveLane() { /* not under test */ },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    // Through the rescan tick: neither the forward scan nor the replay may
    // deliver a block past the finalized head.
    for (let tick = 1; tick <= 26; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }
    expect(seen, 'the unfinalized event stays withheld through the rescan').toEqual([]);

    // Once the head advances enough to finalize 49,945, a rescan delivers
    // it — the row cannot pass vacuously.
    chain.setHead(50_010);
    for (let tick = 1; tick <= 25; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }
    // Replay redelivers idempotently by contract, so the tail and a later
    // rescan may both carry it — what matters is that NOTHING else does.
    expect([...new Set(seen)], 'finalization releases the SAME event, and only it').toEqual([49_945]);
  });
  it('a clamped replay durably retains ONLY the unfinalized tail, and a restarted poller delivers it (review r7/r8-bot)', async () => {
    // A durable window persisted before a confirmation-depth increase
    // reaches past the finalized head. The clamp must dispatch the
    // finalized part, persist the TAIL (not clear, not the full window),
    // and a fresh process over the same store must deliver that tail once
    // the head finalizes it — then clear it.
    let persisted: { fromBlock: number; toBlock: number } | undefined = { fromBlock: 49_930, toBlock: 49_950 };
    const saves: Array<{ fromBlock: number; toBlock: number } | undefined> = [];
    const store = {
      async loadLane() { return 50_000; },
      async saveLane() { /* not under test */ },
      replayRetry: {
        async load() { return persisted; },
        async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
          saves.push(w ? { ...w } : undefined);
          persisted = w ? { ...w } : undefined;
        },
      },
    } satisfies LaneCursorPersistence;
    const withDepth = (head: number) => {
      const chain = makeChain(head, [rootMutation('KnowledgeAssetUpdated', 49_945)]);
      (chain.adapter as { finalizedEventScanBound?: (head: number) => number })
      .finalizedEventScanBound = (head) => head - 59;
      return chain;
    };

    let now = 0;
    const seen1: number[] = [];
    const poller1 = new ChainEventPoller({
      chain: withDepth(50_000).adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: store,
      onKnowledgeAssetRootMutated: async (e) => { seen1.push(e.position.blockNumber); },
    });
    await poll(poller1);
    expect(seen1, 'nothing past the finalized head (49,941) is delivered').toEqual([]);
    expect(
      persisted,
      'only the UNFINALIZED tail survives durably after the clamped dispatch',
    ).toEqual({ fromBlock: 49_942, toBlock: 49_950 });

    // Restart over the same store with the head advanced: the tail restores
    // and delivers, then clears.
    const seen2: number[] = [];
    const poller2 = new ChainEventPoller({
      chain: withDepth(50_010).adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: store,
      onKnowledgeAssetRootMutated: async (e) => { seen2.push(e.position.blockNumber); },
    });
    await poll(poller2);
    expect([...new Set(seen2)], 'the restored tail delivers its event once finalized').toEqual([49_945]);
    expect(persisted, 'and the tail is released durably').toBeUndefined();
  });
  it('a finalized lane HOLDS when the head read fails: no scan, no callback, no cursor save (review r12-bot)', async () => {
    // Depth 5, cursor 49,996, actual head 50,000, a mutation at 49,998 and
    // a retained replay tail. With the head unreadable there is no bound to
    // honor: an unbounded forward scan would dispatch 49,998 as finalized
    // and record a cursor beyond any observed tip; a replay could release
    // the unfinalized tail.
    let now = 0;
    let headReadable = false;
    const seen: number[] = [];
    const cursorSaves: number[] = [];
    let persisted: { fromBlock: number; toBlock: number } | undefined = { fromBlock: 49_997, toBlock: 49_999 };
    const replaySaves: Array<{ fromBlock: number; toBlock: number } | undefined> = [];
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 49_998)]);
    const realGetBlockNumber = chain.adapter.getBlockNumber!.bind(chain.adapter);
    chain.adapter.getBlockNumber = async () => {
      if (!headReadable) throw new Error('rpc head read failed');
      return realGetBlockNumber();
    };
    (chain.adapter as { finalizedEventScanBound?: (head: number) => number })
      .finalizedEventScanBound = (head) => head - 4;
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return 49_996; },
        async saveLane(_lane: ChainEventPollerLane, block: number) { cursorSaves.push(block); },
        replayRetry: {
          async load() { return persisted; },
          async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
            replaySaves.push(w ? { ...w } : undefined);
            persisted = w ? { ...w } : undefined;
          },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    for (let tick = 1; tick <= 3; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }
    expect(chain.filters, 'no scan may be issued without a readable head').toHaveLength(0);
    expect(seen, 'no callback').toEqual([]);
    expect(cursorSaves, 'no cursor save').toEqual([]);
    expect(replaySaves, 'no replay persistence mutation').toEqual([]);

    // The head becomes readable: bound 49,996 — 49,998 is STILL unfinalized,
    // so the lane scans but withholds; at head 50,010 (bound 50,006) it delivers.
    headReadable = true;
    await poll(poller);
    expect(seen, 'readable but unfinalized: withheld').toEqual([]);
    chain.setHead(50_010);
    now += CADENCE_MS;
    await poll(poller);
    expect([...new Set(seen)], 'finalized: delivered').toEqual([49_998]);
  });

  it('a durable replay window WHOLLY above the finalized head is held untouched, then released (review r12-bot)', async () => {
    let now = 0;
    let persisted: { fromBlock: number; toBlock: number } | undefined = { fromBlock: 49_945, toBlock: 49_950 };
    const replaySaves: Array<{ fromBlock: number; toBlock: number } | undefined> = [];
    const seen: number[] = [];
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 49_947)]);
    (chain.adapter as { finalizedEventScanBound?: (head: number) => number })
      .finalizedEventScanBound = (head) => head - 59;
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return 50_000; },
        async saveLane() { /* not under test */ },
        replayRetry: {
          async load() { return persisted; },
          async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
            replaySaves.push(w ? { ...w } : undefined);
            persisted = w ? { ...w } : undefined;
          },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    await poll(poller);
    now += CADENCE_MS;
    await poll(poller);
    expect(seen, 'nothing dispatches while the whole window is unfinalized').toEqual([]);
    expect(replaySaves, 'the durable obligation is neither cleared nor rewritten').toEqual([]);
    expect(persisted).toEqual({ fromBlock: 49_945, toBlock: 49_950 });

    chain.setHead(50_009); // bound 49,950: the window is now wholly finalized
    now += CADENCE_MS;
    await poll(poller);
    expect([...new Set(seen)], 'released once finalized').toEqual([49_947]);
    expect(persisted, 'and cleared durably').toBeUndefined();
  });
  it('a due rescan is MERGED into a pending retry, never discarded — both obligations replay (review r13-bot)', async () => {
    // A replay window stays pending across many ticks because the callback
    // keeps rejecting. Meanwhile the forward cursor advances past a block
    // whose mutation a lagging RPC omitted. The next periodic tick must not
    // drop its newly due window behind the old retry: once the callback
    // recovers, BOTH the old and the newly omitted event must be delivered.
    let now = 0;
    let outage = true;
    const seen: number[] = [];
    const saves: Array<{ fromBlock: number; toBlock: number } | undefined> = [];
    const events = [rootMutation('KnowledgeAssetUpdated', 45_000)];
    const chain = makeChain(50_000, events);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return 50_000; },
        async saveLane() { /* not under test */ },
        replayRetry: {
          async load() { return undefined; },
          async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
            saves.push(w ? { ...w } : undefined);
          },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => {
        if (outage) throw new Error('consumer down');
        seen.push(e.position.blockNumber);
      },
    });

    // Tick 25: the first rescan (41,001–50,000) is rejected and retained.
    for (let tick = 1; tick <= 25; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }
    expect(saves[0]).toEqual({ fromBlock: 41_001, toBlock: 50_000 });

    // The head moves; the forward scan passes 52,000 while the RPC omits
    // that mutation, which only becomes visible afterwards.
    chain.setHead(53_000);
    await poll(poller);
    now += CADENCE_MS;
    events.push(rootMutation('KnowledgeAssetUpdated', 52_000));

    // Tick 50: the second rescan (44,001–53,000) comes due behind the
    // still-pending retry — it must merge, not vanish.
    for (let tick = 27; tick <= 50; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }
    expect(saves[saves.length - 1], 'the merged obligation is durable').toEqual({ fromBlock: 41_001, toBlock: 53_000 });

    outage = false;
    await poll(poller);
    expect([...new Set(seen)].sort(), 'both the old and the newly omitted event replay').toEqual([45_000, 52_000]);
    expect(saves[saves.length - 1], 'and the obligation clears').toBeUndefined();
  });
  it('a merged obligation replays in MAX_RANGE chunks against a provider that rejects wide ranges (review r14-bot)', async () => {
    // The r13 merge can widen a retained window past what providers accept.
    // Every request must stay within MAX_RANGE, with the undispatched tail
    // retained durably after each clean chunk, so both obligations recover.
    let now = 0;
    let outage = true;
    const seen: number[] = [];
    const requested: Array<[number, number]> = [];
    const saves: Array<{ fromBlock: number; toBlock: number } | undefined> = [];
    const events = [rootMutation('KnowledgeAssetUpdated', 45_000)];
    const chain = makeChain(50_000, events);
    const realListen = chain.adapter.listenForEvents.bind(chain.adapter);
    chain.adapter.listenForEvents = (filter) => {
      const from = filter.fromBlock ?? 0;
      const to = typeof filter.toBlock === 'number' ? filter.toBlock : from;
      requested.push([from, to]);
      if (to - from + 1 > MAX_RANGE) throw new Error(`provider rejects ranges over ${MAX_RANGE} blocks`);
      return realListen(filter);
    };
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return 50_000; },
        async saveLane() { /* not under test */ },
        replayRetry: {
          async load() { return undefined; },
          async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
            saves.push(w ? { ...w } : undefined);
          },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => {
        if (outage) throw new Error('consumer down');
        seen.push(e.position.blockNumber);
      },
    });

    for (let tick = 1; tick <= 25; tick += 1) { await poll(poller); now += CADENCE_MS; }
    chain.setHead(53_000);
    await poll(poller); now += CADENCE_MS;
    events.push(rootMutation('KnowledgeAssetUpdated', 52_000));
    for (let tick = 27; tick <= 50; tick += 1) { await poll(poller); now += CADENCE_MS; }
    expect(saves[saves.length - 1], 'merged to 12,000 blocks').toEqual({ fromBlock: 41_001, toBlock: 53_000 });

    outage = false;
    await poll(poller);
    expect(
      requested.every(([from, to]) => to - from + 1 <= MAX_RANGE),
      'no request may exceed MAX_RANGE',
    ).toBe(true);
    expect([...new Set(seen)].sort(), 'both obligations recover through bounded chunks').toEqual([45_000, 52_000]);
    expect(saves[saves.length - 1], 'the obligation clears after the last chunk').toBeUndefined();
  });

  it('a failing chunk retains exactly the undispatched remainder (review r14-bot)', async () => {
    // The first chunk of a merged obligation succeeds, the second rejects:
    // what stays durable is the remainder from the failed chunk onward —
    // not the whole window, not nothing.
    let now = 0;
    let rejectAbove = Number.POSITIVE_INFINITY;
    const saves: Array<{ fromBlock: number; toBlock: number } | undefined> = [];
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 45_000), rootMutation('KnowledgeAssetUpdated', 52_000)]);
    const realListen = chain.adapter.listenForEvents.bind(chain.adapter);
    chain.adapter.listenForEvents = (filter) => {
      const from = filter.fromBlock ?? 0;
      if (from > rejectAbove) throw new Error('provider outage on the second chunk');
      return realListen(filter);
    };
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return 53_000; },
        async saveLane() { /* not under test */ },
        replayRetry: {
          async load() { return { fromBlock: 41_001, toBlock: 53_000 }; },
          async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
            saves.push(w ? { ...w } : undefined);
          },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => undefined,
    });
    chain.setHead(53_000);
    rejectAbove = 45_000; // chunk 1 = 41,001–50,000 passes; chunk 2 from 50,001 rejects

    await poll(poller);

    expect(saves[saves.length - 1], 'the remainder from the failed chunk is what stays owed').toEqual({ fromBlock: 50_001, toBlock: 53_000 });
  });
  it('a rescan that comes due during a persistence-load outage is retained and recovered after restore (review r15-bot)', async () => {
    // Load fails through tick 25 — the tick that computes [41,001, 50,000] —
    // and returns no stored window on tick 26; the head then advances a full
    // lookback, so no later periodic window covers 45,000. The window due
    // during the outage must be held (in memory, never persisted over
    // unknown state) and dispatched once the store is readable.
    let now = 0;
    let loads = 0;
    const seen: number[] = [];
    const saves: Array<{ fromBlock: number; toBlock: number } | undefined> = [];
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
            loads += 1;
            if (loads <= 26) throw new Error('SQLITE_BUSY');
            return undefined;
          },
          async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
            saves.push(w ? { ...w } : undefined);
          },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    for (let tick = 1; tick <= 25; tick += 1) { await poll(poller); now += CADENCE_MS; }
    expect(saves, 'nothing persists over unread state').toHaveLength(0);
    expect(seen, 'nothing replays over unread state').toEqual([]);

    chain.setHead(61_000); // a full lookback past the skipped window
    await poll(poller);    // tick 26: the store recovers with no stored window
    expect([...new Set(seen)], 'the window due during the outage is recovered').toEqual([45_000]);
  });
  it('a SCHEDULED replay window wholly above the finalized head is retained, not discarded (review r19-bot)', async () => {
    // Depth 20,000 finalizes 30,001 at head 50,000; the cursor restores to
    // 49,950, so tick 25 schedules [40,951, 49,950] — entirely unfinalized.
    // It must become a retained obligation, and deliver once finalized.
    let now = 0;
    const seen: number[] = [];
    let persisted: { fromBlock: number; toBlock: number } | undefined;
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 45_000)]);
    (chain.adapter as { finalizedEventScanBound?: (head: number) => number })
      .finalizedEventScanBound = (head) => head - 19_999;
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return 50_000; },
        async saveLane() { /* not under test */ },
        replayRetry: {
          async load() { return persisted; },
          async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
            persisted = w ? { ...w } : undefined;
          },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    for (let tick = 1; tick <= 25; tick += 1) { await poll(poller); now += CADENCE_MS; }
    expect(seen, 'nothing unfinalized dispatches').toEqual([]);
    expect(persisted, 'the wholly unfinalized scheduled window is RETAINED').toEqual({ fromBlock: 40_951, toBlock: 49_950 });

    chain.setHead(69_949); // bound 49,950: the window finalizes
    await poll(poller);
    expect([...new Set(seen)], 'and delivers once finalized').toEqual([45_000]);
    expect(persisted, 'then clears').toBeUndefined();
  });
  it('a failed replay-persistence write neither aborts dispatch nor discards the in-memory retry (review r5-bot)', async () => {
    // Best-effort contract: losing the save costs restart-safety for this
    // window, not the retry itself. A regression that lets the save
    // rejection abort the dispatch, or drop the retained window, passes
    // every other row.
    let now = 0;
    let saveAttempts = 0;
    let deliveries = 0;
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
          async load() { return undefined; },
          async save() {
            saveAttempts += 1;
            throw new Error('disk full');
          },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => {
        deliveries += 1;
        seen.push(e.position.blockNumber);
        if (deliveries === 1) throw new Error('transient consumer failure');
      },
    });

    // Through the rescan tick: the write-ahead save THROWS; the dispatch
    // must still run, and its rejection retains the in-memory window.
    for (let tick = 1; tick <= 25; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }
    expect(saveAttempts, 'the write-ahead mark was attempted').toBeGreaterThanOrEqual(1);
    expect(seen, 'the save failure must not abort the dispatch').toEqual([45_000]);

    // The next due tick re-dispatches the RETAINED window and succeeds.
    await poll(poller);
    expect(seen, 'the in-memory retry survives the failed save').toEqual([45_000, 45_000]);

    // Released after the clean dispatch: no third delivery.
    now += CADENCE_MS;
    await poll(poller);
    expect(seen).toEqual([45_000, 45_000]);
  });
  it('an UNREAD durable replay window survives a load outage that spans the rescan tick (review r27-bot)', async () => {
    // The dangerous collision: the store holds an OLDER window (30,001–40,000
    // — outside anything a new rescan would compute) whose event at 35,000
    // this process has never seen, and the load keeps failing PAST the 25th
    // due tick where a fresh periodic rescan becomes due. The new rescan must
    // neither overwrite nor clear the unread window; after the store
    // recovers, the OLD window must dispatch its event.
    let loadAttempts = 0;
    let storeHealthy = false;
    let now = 0;
    const saves: Array<{ fromBlock: number; toBlock: number } | undefined> = [];
    const seen: number[] = [];
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 35_000)]);
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
            if (!storeHealthy) throw new Error('SQLITE_BUSY');
            return { fromBlock: 30_001, toBlock: 40_000 };
          },
          async save(_lane: ChainEventPollerLane, w: { fromBlock: number; toBlock: number } | undefined) {
            saves.push(w ? { ...w } : undefined);
          },
        },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    // Through the 26th due tick: restore keeps failing, the periodic rescan
    // becomes due at the 25th — and must not touch durable replay state.
    for (let tick = 1; tick <= 26; tick += 1) {
      await poll(poller);
      now += CADENCE_MS;
    }
    expect(saves, 'nothing may be written over an UNREAD window').toHaveLength(0);
    expect(seen, 'the unread window cannot have dispatched yet').not.toContain(35_000);
    expect(loadAttempts).toBeGreaterThanOrEqual(26);

    storeHealthy = true;
    await poll(poller);

    expect(seen, 'the OLDER window survives the outage and dispatches').toContain(35_000);
    expect(saves[saves.length - 1], 'and is cleared only after its dispatch').toBeUndefined();
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
  });
});
