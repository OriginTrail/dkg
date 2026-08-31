/**
 * `ChainEventPoller` — manual-poll and lifecycle serialization (#2435,
 * PR #2436 reviews r3/r6/r7/r10/r13): pollNow's cadence-bypassing scan, caller
 * serialization, the stop() drain and its cancel semantics, restartability,
 * and the post-wait shutdown re-check. Split from the root-mutation suite at
 * review r16.
 */
import { describe, it, expect } from 'vitest';
import type { ChainAdapter, ChainEvent, EventFilter } from '@origintrail-official/dkg-chain';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import { CADENCE_MS, makeChain, makeHandler, poll } from './chain-event-poller-harness.js';

describe('ChainEventPoller — pollNow and lifecycle', () => {
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

  it('stop() during a manual poll drains the queue: no scan starts after stop resolves (review r6)', async () => {
    let now = 0;
    let head = 50_000;
    let scansStarted = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => head,
      listenForEvents: async function* (): AsyncIterable<ChainEvent> {
        scansStarted += 1;
        if (scansStarted === 1) await firstGate; // hold the FIRST scan open across stop()
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

    const p1 = poller.pollNow();          // starts scanning, blocked on the gate
    await new Promise((r) => setTimeout(r, 10)); // p1 is INSIDE the gate with its
                                          // window already computed (..50_000)
    const p2 = poller.pollNow();          // queued behind p1
    head = 50_010;                        // FRESH work for p2: an uncancelled
                                          // entry must be adapter-visible, not
                                          // an invisible caught-up noWork
    const stopped = poller.stop();        // stop() begins while p1 is mid-scan
    releaseFirst();
    await stopped;

    const startedAtStop = scansStarted;
    await Promise.allSettled([p1, p2]);
    // p2 was queued but unstarted when stop() began: it must have been
    // CANCELLED, not started — and nothing may start after stop() resolved.
    expect(startedAtStop).toBe(1);
    expect(scansStarted).toBe(1);
    // A pollNow() issued after stop() is refused loudly rather than queued.
    await expect(poller.pollNow()).rejects.toThrow(/stopped/);
  });

  it('a manual poll waiting behind an INTERVAL scan is cancelled by a stop() that begins mid-wait (review r13)', async () => {
    // The pre-wait stopping check is stale across the suspension: a pollNow()
    // queued behind a held-open startup scan must not start fresh adapter
    // work once stop() has begun — the drain would otherwise wait on a scan
    // that began AFTER shutdown.
    let head = 50_000;
    let scansStarted = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => head,
      listenForEvents: async function* (): AsyncIterable<ChainEvent> {
        scansStarted += 1;
        if (scansStarted === 1) await gate; // hold the STARTUP scan open
        for (const evt of [] as ChainEvent[]) yield evt;
      },
    } as unknown as ChainAdapter;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      clock: () => 0,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poller.start();                 // startup scan begins, blocked on the gate
    await new Promise((r) => setTimeout(r, 10));
    const manual = poller.pollNow();      // waits behind the startup scan
    head = 50_010;                        // fresh work: an uncancelled manual
                                          // poll would be adapter-visible
    await new Promise((r) => setTimeout(r, 10));
    const stopped = poller.stop();        // shutdown begins while manual waits
    release();
    await Promise.allSettled([manual, stopped]);

    // Only the scan that was active at shutdown ever started.
    expect(scansStarted).toBe(1);
  });

  it('a whole-poll rejection reaches its own caller only; the queue recovers (review r7)', async () => {
    // Serialization promises each manual caller its OWN scan's outcome. The
    // stored chain pre-swallows every run (`run.catch(() => {})`) precisely so
    // a first caller's failure cannot poison the queue — this row exercises
    // the rejection branch that promise rests on: drop that internal catch and
    // the second caller below inherits the first caller's error.
    const { adapter } = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => 0,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });
    const priv = poller as unknown as { laneRunner: { poll(): Promise<void> } };
    const realPoll = priv.laneRunner.poll.bind(priv.laneRunner);
    let runnerCalls = 0;
    priv.laneRunner.poll = async () => {
      runnerCalls += 1;
      if (runnerCalls === 1) throw new Error('whole poll boom');
      return realPoll();
    };

    // A WHOLE-poll failure (the runner itself rejecting, not a per-lane scan
    // error the runner catches and backs off internally) surfaces to the
    // caller that asked for the scan.
    await expect(poller.pollNow()).rejects.toThrow('whole poll boom');
    // The next manual poll still runs and resolves: the queue recovered.
    await expect(poller.pollNow()).resolves.toBeUndefined();
    expect(runnerCalls).toBe(2);
  });

  it('start-stop-start re-arms pollNow: the stopping latch is not terminal (review r10)', async () => {
    // The public lifecycle explicitly supports restart; a latch that never
    // resets would leave the restarted poller with a permanently refusing
    // manual API -- contradictory state the review named.
    const { adapter, filters, setHead } = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      clock: () => 0,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });
    await poller.start();
    await poller.waitForCurrentPoll();
    await poller.stop();
    await expect(poller.pollNow()).rejects.toThrow(/stopped/);

    await poller.start();
    await poller.waitForCurrentPoll();
    setHead(50_010);
    await expect(poller.pollNow()).resolves.toBeUndefined();
    const last = filters[filters.length - 1];
    expect(last.fromBlock).toBe(50_001);
    expect(last.toBlock).toBe(50_010);
    await poller.stop();
  });

  it('a start() issued while stop() is still draining serializes behind it (review r10)', async () => {
    let active = 0;
    let maxActive = 0;
    let scans = 0;
    let head = 50_000;
    const setHead = (next: number): void => { head = next; };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => head,
      listenForEvents: async function* (): AsyncIterable<ChainEvent> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        scans += 1;
        if (scans === 1) await gate; // hold the pre-stop scan open
        active -= 1;
        for (const evt of [] as ChainEvent[]) yield evt;
      },
    } as unknown as ChainAdapter;
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: 60_000,
      clock: () => 0,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    const p1 = poller.pollNow();          // scanning, blocked on the gate
    await new Promise((r) => setTimeout(r, 10)); // p1 inside the gate; its window
                                          // (..50_000) is already computed
    const p2 = poller.pollNow();          // queued behind p1 BEFORE stop()
    setHead(50_010);                      // fresh work, so an uncancelled p2
                                          // shows up as a real adapter scan
    const stopped = poller.stop();        // drains p1, discards p2
    const restarted = poller.start();     // must WAIT for the drain, not re-arm over it
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.allSettled([p1, p2, stopped, restarted]);

    // stop()'s discard contract survives a concurrent restart: p2 was queued
    // before stop() and must have been CANCELLED, not revived by start()
    // resetting the latch while the drain was still walking the queue.
    expect(scans).toBe(1);
    await poller.waitForCurrentPoll();

    // Never two scans in flight -- a start() that jumped the drain would have
    // issued its immediate first poll while p1 was still gated.
    expect(maxActive).toBe(1);
    // And the restart is REAL: the manual API works again and scans the
    // window p2 never took.
    await expect(poller.pollNow()).resolves.toBeUndefined();
    expect(scans).toBe(2);
    await poller.stop();
  });
});
