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

/** A histogram the test fills by hand; values are nanoseconds, as in Node. */
class FakeHistogram implements EventLoopDelayHistogram {
  samples: number[] = [];
  enabled = false;
  resets = 0;
  get count(): number { return this.samples.length; }
  get max(): number { return this.samples.length === 0 ? 0 : Math.max(...this.samples); }
  percentile(percentile: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1);
    return sorted[Math.max(0, index)]!;
  }
  reset(): void { this.samples = []; this.resets += 1; }
  enable(): boolean { const was = this.enabled; this.enabled = true; return !was; }
  disable(): boolean { const was = this.enabled; this.enabled = false; return was; }
  record(...delaysMs: number[]): void { this.samples.push(...delaysMs.map((value) => value * MS)); }
}

describe('event-loop delay monitor', () => {
  let monitor: EventLoopDelayMonitor | undefined;

  afterEach(() => {
    monitor?.stop();
    monitor = undefined;
    vi.useRealTimers();
  });

  function start(overrides: { warnIntervalMs?: number } = {}) {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const histogram = new FakeHistogram();
    const lines: string[] = [];
    let resolution: number | undefined;
    monitor = startEventLoopDelayMonitor({
      log: (line) => lines.push(line),
      now: () => clock,
      windowMs: 60_000,
      warnThresholdMs: 2_000,
      ...overrides,
      createHistogram: (resolutionMs) => {
        resolution = resolutionMs;
        return histogram;
      },
    });
    const advance = (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    };
    return { histogram, lines, advance, resolution: () => resolution };
  }

  it('samples at 20 ms and reports no data until a sample lands', () => {
    const { histogram, advance, resolution } = start();
    expect(resolution()).toBe(EVENT_LOOP_DELAY_DEFAULTS.resolutionMs);
    expect(EVENT_LOOP_DELAY_DEFAULTS.resolutionMs).toBe(20);
    expect(histogram.enabled).toBe(true);
    advance(5_000);
    expect(monitor!.snapshot()).toEqual({ p50Ms: null, p99Ms: null, maxMs: null, windowMs: 5_000 });
  });

  it('reports the in-progress window, then the last complete one, in ms', () => {
    const { histogram, advance } = start();
    histogram.record(20.4, 21, 22, 25, 180);
    advance(10_000);
    expect(monitor!.snapshot()).toEqual({ p50Ms: 22, p99Ms: 180, maxMs: 180, windowMs: 10_000 });

    advance(50_000); // window closes at 60 s
    expect(histogram.resets).toBe(1);
    histogram.record(8_000); // the NEXT window's stall is not reported until it closes
    advance(1_000);
    expect(monitor!.snapshot()).toEqual({ p50Ms: 22, p99Ms: 180, maxMs: 180, windowMs: 60_000 });

    advance(59_000);
    expect(monitor!.snapshot()).toEqual({ p50Ms: 8_000, p99Ms: 8_000, maxMs: 8_000, windowMs: 60_000 });
    // An idle window after a stall reads as "no data", not as the old stall.
    advance(60_000);
    expect(monitor!.snapshot()).toMatchObject({ maxMs: null, windowMs: 60_000 });
  });

  it('warns once per window over the threshold, rate limited, counting what it skipped', () => {
    const { histogram, lines, advance } = start({ warnIntervalMs: 10 * 60_000 });
    histogram.record(20, 1_999.9);
    advance(60_000);
    expect(lines).toEqual([]);

    histogram.record(20, 8_400);
    advance(60_000);
    expect(lines).toEqual([
      '[warn] Event loop blocked: max 8400 ms, p99 8400 ms in the last 60 s (threshold 2000 ms)',
    ]);

    for (let window = 0; window < 3; window += 1) {
      histogram.record(3_000);
      advance(60_000);
    }
    expect(lines).toHaveLength(1);

    advance(6 * 60_000); // quiet windows neither warn nor count
    histogram.record(2_000);
    advance(60_000);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '[warn] Event loop blocked: max 2000 ms, p99 2000 ms in the last 60 s (threshold 2000 ms)'
        + '; 3 more window(s) over the threshold since the last warning',
    );
  });

  it('stops rotating and sampling on stop, idempotently', () => {
    const { histogram, lines, advance } = start();
    monitor!.stop();
    monitor!.stop();
    expect(histogram.enabled).toBe(false);
    histogram.record(9_000);
    advance(5 * 60_000);
    expect(histogram.resets).toBe(0);
    expect(lines).toEqual([]);
  });

  it('measures a real main-thread stall with the Node histogram', async () => {
    monitor = startEventLoopDelayMonitor({ log: () => undefined, resolutionMs: 10, windowMs: 60_000 });
    // Let the sampling timer arm, then block the thread past it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const blockedUntil = Date.now() + 150;
    while (Date.now() < blockedUntil) { /* busy */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
    const block = monitor.snapshot();
    expect(block.maxMs).toBeGreaterThanOrEqual(100);
    expect(block.p50Ms).not.toBeNull();
    expect(block.windowMs).toBeGreaterThanOrEqual(150);
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
