/**
 * `ChainEventPoller` — lifecycle serialization (#2435, PR #2436 reviews
 * r6/r10/r17): stop() draining the in-flight scan, restartability, and a
 * start() racing an unfinished stop(). The public manual-poll API was DELETED
 * at review r17 (no production caller; its queue machinery generated four
 * review rounds of coordination bugs) — tests force scans through the
 * harness's `forceScan` seam instead.
 */
import { describe, it, expect } from 'vitest';
import type { ChainAdapter, ChainEvent } from '@origintrail-official/dkg-chain';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import { CADENCE_MS, forceScan, makeChain, makeHandler, poll } from './chain-event-poller-harness.js';

describe('ChainEventPoller — lifecycle', () => {
  it('forceScan scans inside the cadence window that a plain poll() skips', async () => {
    // The seam's reason to exist, measured in BOTH polarities: after a
    // catch-up the lane re-arms `nextRunAtMs`, so a plain poll() inside the
    // window scans nothing — indistinguishable from "no event on chain".
    const { adapter, filters, setHead } = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => 0,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });
    await poll(poller);                    // catch-up to head
    setHead(50_010);
    await poll(poller);                    // inside the cadence window: skipped
    expect(filters).toHaveLength(1);
    await forceScan(poller);               // the seam scans regardless
    expect(filters).toHaveLength(2);
    expect(filters[1].fromBlock).toBe(50_001);
    expect(filters[1].toBlock).toBe(50_010);
  });

  it('stop() resolves only after the in-flight scan settles, and starts nothing new (review r6)', async () => {
    let scansStarted = 0;
    let scanSettled = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => 50_000,
      listenForEvents: async function* (): AsyncIterable<ChainEvent> {
        scansStarted += 1;
        await gate; // hold the startup scan open across stop()
        scanSettled = true;
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

    await poller.start();                  // startup scan begins, gated
    await new Promise((r) => setTimeout(r, 10));
    const stopped = poller.stop();
    let stopResolved = false;
    void stopped.then(() => { stopResolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    // stop() must WAIT for the gated scan, not abandon it mid-RPC.
    expect(stopResolved).toBe(false);
    release();
    await stopped;
    expect(scanSettled).toBe(true);
    expect(scansStarted).toBe(1);
  });

  it('start-stop-start restarts a working poller (review r10)', async () => {
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
    const scansAfterStop = filters.length;

    await poller.start();
    await poller.waitForCurrentPoll();
    setHead(50_010);
    await forceScan(poller);
    const last = filters[filters.length - 1];
    expect(filters.length).toBeGreaterThan(scansAfterStop);
    expect(last.fromBlock).toBe(50_001);
    expect(last.toBlock).toBe(50_010);
    await poller.stop();
  });

  it('a start() issued while stop() is still draining serializes behind it (review r10)', async () => {
    let active = 0;
    let maxActive = 0;
    let scans = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const adapter = {
      chainId: 'mock:0',
      getBlockNumber: async () => 50_000,
      listenForEvents: async function* (): AsyncIterable<ChainEvent> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        scans += 1;
        if (scans === 1) await gate; // hold the first startup scan open
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

    await poller.start();                  // startup scan gated
    await new Promise((r) => setTimeout(r, 10));
    const stopped = poller.stop();         // begins draining the gated scan
    const restarted = poller.start();      // must WAIT for the drain
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.allSettled([stopped, restarted]);
    await poller.waitForCurrentPoll();

    // Never two scans in flight: a start() that jumped the drain would have
    // launched its own startup poll while the first was still gated.
    expect(maxActive).toBe(1);
    await expect(forceScan(poller)).resolves.toBeUndefined();
    await poller.stop();
  });
});
