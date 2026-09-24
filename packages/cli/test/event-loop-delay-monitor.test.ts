import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  resolveRfc64CatalogActivationsV1,
  resolveRfc64PublicCatalogActivationChainIdentityV1,
} from '@origintrail-official/dkg-agent/rfc64/public-catalog-activation-config-v1';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_LOOP_DELAY_DEFAULTS,
  startEventLoopDelayMonitor,
  type EventLoopDelayHistogram,
  type EventLoopDelayMonitor,
  type EventLoopDelayView,
} from '../src/daemon/event-loop-delay-monitor.js';
import { handleStatusRoutes } from '../src/daemon/routes/status.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const MS = 1e6;

/** A histogram the monitor fills; values are nanoseconds, as in Node. */
class FakeHistogram implements EventLoopDelayHistogram {
  samples: number[] = [];
  resets = 0;
  get count(): number { return this.samples.length; }
  get max(): number { return this.samples.length === 0 ? 0 : Math.max(...this.samples); }
  percentile(percentile: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)]!;
  }
  record(nanoseconds: number): void {
    if (!Number.isInteger(nanoseconds) || nanoseconds < 1) throw new RangeError('record takes integers >= 1');
    this.samples.push(nanoseconds);
  }
  reset(): void { this.samples = []; this.resets += 1; }
  /** Samples above the 1 ns "no delay" floor, in ms. */
  delaysMs(): number[] { return this.samples.filter((value) => value > 1).map((value) => value / MS); }
}

describe('event-loop delay monitor', () => {
  let monitor: EventLoopDelayMonitor | undefined;

  afterEach(() => {
    monitor?.stop();
    monitor = undefined;
    vi.useRealTimers();
  });

  /**
   * Fake timers drive both intervals; the two clocks the monitor reads follow
   * the fake clock plus `stall`, which moves time forward WITHOUT running any
   * timer, exactly what a synchronous stretch on the main thread does.
   */
  function start(overrides: { warnIntervalMs?: number; windowMs?: number } = {}) {
    vi.useFakeTimers({ now: 1_000_000 });
    let stalled = 0;
    const histogram = new FakeHistogram();
    const lines: string[] = [];
    monitor = startEventLoopDelayMonitor({
      log: (line) => lines.push(line),
      now: () => Date.now() + stalled,
      sampleClock: () => Date.now() + stalled,
      windowMs: 60_000,
      warnThresholdMs: 2_000,
      ...overrides,
      createHistogram: () => histogram,
    });
    const advance = (ms: number) => { vi.advanceTimersByTime(ms); };
    const stall = (ms: number) => { stalled += ms; };
    return { histogram, lines, advance, stall };
  }

  it('samples every 20 ms and reports no data until a sample lands', () => {
    const { histogram, advance } = start();
    expect(EVENT_LOOP_DELAY_DEFAULTS.resolutionMs).toBe(20);
    advance(19);
    expect(histogram.count).toBe(0);
    expect(monitor!.snapshot()).toEqual({ p50Ms: null, p99Ms: null, maxMs: null, windowMs: 19 });
    advance(1_981);
    expect(histogram.count).toBe(100);
  });

  it('reports delay net of the sampling interval, so an idle loop reads 0 ms', () => {
    const { advance, stall } = start();
    advance(10_000);
    // Every sample ran exactly 20 ms after the last: no delay at all, where the
    // raw time between samples (what monitorEventLoopDelay records) is 20 ms.
    expect(monitor!.snapshot()).toEqual({ p50Ms: 0, p99Ms: 0, maxMs: 0, windowMs: 10_000 });
    stall(180);
    advance(20);
    expect(monitor!.snapshot()).toMatchObject({ p50Ms: 0, maxMs: 180 });
  });

  it('reports the in-progress window, then the last complete one, in ms', () => {
    const { histogram, advance, stall } = start();
    advance(1_000);
    // 2% of the window's samples ran late (nine by 10 ms, one by 110 ms); the
    // rest ran on time.
    for (const delay of [10, 10, 10, 10, 10, 10, 10, 10, 10, 110]) {
      stall(delay);
      advance(20);
    }
    advance(8_800);
    expect(histogram.count).toBe(500);
    expect(monitor!.snapshot()).toEqual({ p50Ms: 0, p99Ms: 10, maxMs: 110, windowMs: 10_200 });

    advance(50_000); // window closes at 60 s of timers
    expect(histogram.resets).toBe(1);
    stall(8_000); // the NEXT window's stall is not reported until it closes
    advance(1_000);
    // The whole window: 3 000 samples, so ten late ones are below its p99.
    expect(monitor!.snapshot()).toEqual({ p50Ms: 0, p99Ms: 0, maxMs: 110, windowMs: 60_200 });

    advance(59_000);
    expect(monitor!.snapshot()).toMatchObject({ p99Ms: 0, maxMs: 8_000, windowMs: 68_000 });
    // An idle window after a stall reads as no delay, not as the old stall.
    advance(60_000);
    expect(monitor!.snapshot()).toEqual({ p50Ms: 0, p99Ms: 0, maxMs: 0, windowMs: 60_000 });
  });

  it('records a stall that straddles a rotation in exactly one window', () => {
    // The window closes at 60 010, between the samples due at 60 000 and
    // 60 020. A stall that begins after the 60 000 sample and ends past the
    // boundary makes the rotation run BEFORE the first sample after it. With
    // the native monitor's reset() that sample had no previous tick to measure
    // from, and the stall was in no window at all.
    const { histogram, advance, stall } = start({ windowMs: 60_010 });
    advance(60_005);
    stall(8_000);
    advance(5);
    expect(histogram.resets).toBe(1);
    expect(monitor!.snapshot().maxMs).toBe(0);
    advance(10);
    expect(histogram.delaysMs()).toEqual([8_000]);
    advance(60_000);
    expect(monitor!.snapshot()).toMatchObject({ maxMs: 8_000 });
    monitor!.stop();

    // When the sample runs first, the stall belongs to the window it ended in.
    const second = start({ windowMs: 60_010 });
    second.advance(59_990);
    second.stall(5_000);
    second.advance(10);
    expect(second.histogram.delaysMs()).toEqual([5_000]);
    second.advance(10);
    expect(second.histogram.resets).toBe(1);
    expect(monitor!.snapshot()).toMatchObject({ maxMs: 5_000 });
    second.advance(60_010);
    expect(monitor!.snapshot()).toMatchObject({ maxMs: 0 });
  });

  it('warns once per window over the threshold, rate limited, counting what it skipped', () => {
    const { lines, advance, stall } = start({ warnIntervalMs: 10 * 60_000 });
    const window = (stallMs: number) => {
      advance(1_000);
      stall(stallMs);
      advance(59_000);
    };
    window(1_999.9);
    expect(lines).toEqual([]);

    window(8_400);
    expect(lines).toEqual([
      '[warn] Event loop blocked: max 8400 ms, p99 0 ms in the last 68 s (threshold 2000 ms)',
    ]);

    for (let index = 0; index < 3; index += 1) window(3_000);
    expect(lines).toHaveLength(1);

    advance(6 * 60_000); // quiet windows neither warn nor count
    window(2_000);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '[warn] Event loop blocked: max 2000 ms, p99 0 ms in the last 62 s (threshold 2000 ms)'
        + '; 3 more window(s) over the threshold since the last warning',
    );
  });

  it('stops sampling and rotating on stop, idempotently', () => {
    const { histogram, lines, advance, stall } = start();
    monitor!.stop();
    monitor!.stop();
    stall(9_000);
    advance(5 * 60_000);
    expect(histogram.count).toBe(0);
    expect(histogram.resets).toBe(0);
    expect(lines).toEqual([]);
  });

  it('measures a real main-thread stall, and an idle loop well under the interval', async () => {
    monitor = startEventLoopDelayMonitor({ log: () => undefined, resolutionMs: 10, windowMs: 60_000 });
    // Idle: samples land about every 10 ms. The raw time between samples is
    // >= 10 ms by construction, so a p50 under 10 is the interval subtracted.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const idle = monitor.snapshot();
    expect(idle.p50Ms).not.toBeNull();
    expect(idle.p50Ms!).toBeLessThan(10);
    // Block the thread well past the interval.
    const blockedUntil = Date.now() + 150;
    while (Date.now() < blockedUntil) { /* busy */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
    const block = monitor.snapshot();
    expect(block.maxMs).toBeGreaterThanOrEqual(100);
    expect(block.windowMs).toBeGreaterThanOrEqual(350);
  });
});

describe('/api/status eventLoopDelay block', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  });

  async function status(eventLoopDelay: EventLoopDelayView | undefined): Promise<Record<string, unknown>> {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleStatusRoutes({
        req,
        res,
        publisherState: {
          runtime: null,
          availability: {
            available: false,
            reason: 'publisher_disabled',
            retryable: false,
            operatorActionRequired: true,
          },
        },
        path: url.pathname,
        url,
        network: null,
        config: {
          name: 'event-loop-delay-status-test',
          nodeRole: 'edge',
          chain: { type: 'mock' },
          store: { backend: 'oxigraph-worker' },
        },
        rfc64PublicCatalog: { enabled: false, selectedContextGraphs: [] },
        rfc64CatalogActivationState: resolveRfc64CatalogActivationsV1({
          persistenceAvailable: false,
        }, resolveRfc64PublicCatalogActivationChainIdentityV1(undefined)).activationState,
        startedAt: Date.now(),
        agent: {
          peerId: 'peer-event-loop-delay-status-test',
          multiaddrs: [],
          getSyncContextGraphIds: () => [],
          store: { query: async () => ({ type: 'bindings', bindings: [] }) },
          node: {
            libp2p: { getConnections: () => [] },
            getRelayStats: () => null,
          },
          publisher: { getIdentityId: () => 0n },
        },
        nodeVersion: '0.0.0-test',
        nodeCommit: '',
        admission: { inFlight: 0, max: 0, rejectedTotal: 0 },
        ...(eventLoopDelay === undefined ? {} : { eventLoopDelay }),
      } as unknown as RequestContext);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(response.status).toBe(200);
    return await response.json() as Record<string, unknown>;
  }

  it('reports the gauge reading as p50/p99/max/window in ms', async () => {
    const body = await status({
      snapshot: () => ({ p50Ms: 20.3, p99Ms: 41.5, maxMs: 8_412.7, windowMs: 60_000 }),
    });
    expect(body.eventLoopDelay).toEqual({ p50Ms: 20.3, p99Ms: 41.5, maxMs: 8_412.7, windowMs: 60_000 });
    expect(Object.keys(body.eventLoopDelay as object).sort())
      .toEqual(['maxMs', 'p50Ms', 'p99Ms', 'windowMs']);
  });

  it('reports null when no gauge is wired', async () => {
    const body = await status(undefined);
    expect(body).toHaveProperty('eventLoopDelay', null);
  });
});
